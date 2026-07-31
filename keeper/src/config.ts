import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARC_TESTNET_CHAIN_ID, loadAddressBook } from '@arcpad/shared'
import { type Address, getAddress, isAddress } from 'viem'
import { type Allowlist, ZERO_ADDRESS } from './watch/graduationWindow'

export interface KeeperConfig {
  rpcUrl: string
  pollIntervalMs: number
  dryRun: boolean
}

const DEFAULT_POLL_INTERVAL_MS = 5_000

/**
 * Keeper zincire islem gonderir, bu yuzden varsayilan davranisi GUVENLI
 * olmalidir: `KEEPER_DRY_RUN` acikca "false" yapilmadikca hicbir islem
 * yayinlanmaz. Yanlis yapilandirilmis bir keeper'in sessizce imzalamaya
 * baslamasi, hic calismamasindan cok daha pahalidir.
 */
export function loadKeeperConfig(env: NodeJS.ProcessEnv): KeeperConfig {
  const rpcUrl = blankToUndefined(env['ARC_RPC_URL'])
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  // BOSLUK DA BOSTUR, ve bu satirin `blankToUndefined`siz hali `.env.example`in
  // sekiz degisken icin ogrettigi "bos birak = varsayilan" kuralini TAM BURADA
  // bozuyordu: `KEEPER_POLL_INTERVAL_MS=` ile keeper HIC BASLAMIYORDU.
  const rawInterval = blankToUndefined(env['KEEPER_POLL_INTERVAL_MS'])
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  if (rawInterval !== undefined) {
    pollIntervalMs = Number(rawInterval)
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error(`KEEPER_POLL_INTERVAL_MS must be a positive integer, got "${rawInterval}"`)
    }
  }

  return {
    rpcUrl,
    pollIntervalMs,
    dryRun: env['KEEPER_DRY_RUN'] !== 'false',
  }
}

// ---------------------------------------------------------------
// Graduation penceresi izleyicisi
// ---------------------------------------------------------------

/**
 * AYRI BIR YUKLEYICI, `KeeperConfig`e alan eklemek yerine. Izleyici SALT
 * OKURDUR -- hicbir islem yayinlamaz -- dolayisiyla `KEEPER_DRY_RUN` onu
 * KAPATMAZ ve kapatmamalidir: Safe'ler kurulmadan, hedef atanmadan, keeper
 * imzalamaya baslamadan once bile calisir. Gorev tanimindaki "bu, deploy'dan
 * ONCE iner ki factory hicbir an izlenmeden canli olmasin" cumlesinin kodda
 * karsiligi budur.
 */
export interface WatcherConfig {
  factory: Address
  startBlock: bigint
  chainKey: string
  governancePath: string
  cursorPath: string
  logScanChunk: bigint
  allowlist: Allowlist
  /** Ayarliysa keeper her olayi buraya da yazar; tatbikatin `observe` fazi bunu okur. */
  alertLogPath: string | undefined
  /** Ayni bulgunun tekrar yayilma araligi. Bkz. `createThrottle`. */
  alertRepeatMs: number | undefined
}

const DEFAULT_LOG_SCAN_CHUNK = 10_000n

/** `keeper/.cursor` ve `contracts/deploy/expected-governance.json`, bu dosyaya gore. */
export const DEFAULT_CURSOR_PATH = fileURLToPath(new URL('../.cursor', import.meta.url))
export const DEFAULT_GOVERNANCE_PATH = fileURLToPath(
  new URL('../../contracts/deploy/expected-governance.json', import.meta.url),
)

/**
 * DEFTER KAYNAKTIR, ENV YALNIZCA CAPRAZ KONTROLDUR.
 *
 * Onceki hal `ARC_START_BLOCK`i ham env'den okuyordu. Olculen sonucu: ilk
 * launch'in ILERISINE ayarlanmis bir startBlock her poll'da
 * `log-scan-under-reporting` sayfasi cikarir ve HIC kalp atisi vermez, yani
 * kanarya da uzerine biner -- bes saniyelik varsayilan aralikta gunde ~35.000
 * sayfa, ve pencere siniflandirmasinin kendisi kusursuz calisirken.
 *
 * Iki ayri duzeltme gerekiyordu ve ikisi de yapildi: burada DEGERIN kaynagi
 * insan eliyle yazilan env olmaktan cikip URETILEN deftere baglandi
 * (`contracts/deploy/addresses.<chainId>.json`), alarm tarafinda ise tekrar
 * bastirma eklendi (`createThrottle`).
 *
 * `chainKey` DE DEFTERDEN GELIR. Elle ayarlanabilir olmasi, izin listesinin
 * defterin isaret ettiginden BASKA bir governance kaydindan okunabilmesi
 * demekti -- yani izleyici yanlis Safe'i mesru sayabilirdi.
 *
 * NEDEN `assertEnvMatchesBook` DOGRUDAN CAGRILMIYOR: o fonksiyon
 * `NEXT_PUBLIC_ARC_CHAIN_ID`, `NEXT_PUBLIC_ARCPAD_FACTORY`,
 * `NEXT_PUBLIC_ARCPAD_ESCROW` ve `ARC_ESCROW_ADDRESS`i de ZORUNLU tutar. Bunlar
 * web'in build-time degiskenleridir; keeper hicbirini kullanmaz. Cagirmak,
 * izleyicinin web env'i olmadan BASLAMAMASI demek olurdu -- ve bu gorevin
 * tamami "factory hicbir an izlenmeden canli olmasin" uzerine kurulu, yani
 * izleyiciyi web'in yapilandirmasina bagimli kilmak yanlis yonde bir kilitleme
 * olurdu. Bunun yerine defter KAYNAK yapildi (env'i dogrulamaktan daha
 * gucludur: yanlis bir deger artik yalnizca reddedilmiyor, hic kullanilmiyor)
 * ve keeper'in GERCEKTEN kullandigi iki degisken icin ayni iddia burada,
 * ALANI ADIYLA yapiliyor.
 */
export function loadWatcherConfig(env: NodeJS.ProcessEnv, bookDir?: string): WatcherConfig {
  // `ARC_CHAIN_ID=''` -> `Number('')` SIFIRDIR ve `Number.isSafeInteger(0)`
  // DOGRUDUR, yani bos dize sessizce `addresses.0.json` arayan bir keeper
  // uretirdi. Ayni sinif, ucuncu yer.
  const rawChainId = blankToUndefined(env['ARC_CHAIN_ID'])
  const chainId = rawChainId === undefined ? ARC_TESTNET_CHAIN_ID : Number(rawChainId)
  if (!Number.isSafeInteger(chainId)) {
    throw new Error(`ARC_CHAIN_ID must be an integer, got "${env['ARC_CHAIN_ID'] ?? ''}"`)
  }

  // Defterin dizini env'den de verilebilir. Uretimde varsayilan
  // (`contracts/deploy`) dogru olandir; bu knob staging defterlerine karsi
  // kosmak ve izleyiciyi GERCEK bir surec olarak sahte bir zincire karsi
  // kirabilmek icindir -- bkz. docs/runbooks/graduation-window.md, tatbikat.
  // Argumanla verilen dizin env'i EZER, cunku onu yalnizca testler gecer.
  //
  // BOS DIZE `undefined` DEMEKTIR. `??` yalnizca null/undefined'a bakar, yani
  // onceki hal `.env.example`in gonderdigi `KEEPER_ADDRESS_BOOK_DIR=` degerini
  // -- dotenv onu bos DIZE olarak verir -- `loadAddressBook(chainId, '')`e
  // gecirip ciplak bir goreli yola ceviriyordu. Olculdu: ayarsiz ->
  // `contracts/deploy/addresses.31337.json`; `""` -> `cannot read
  // addresses.31337.json`. Yani DEPONUN KENDI BELGELENMIS KURULUM YOLU,
  // BASLAMAYI REDDEDEN BIR KEEPER URETIYORDU. Bu dosyadaki diger her
  // degisken `''`i acikca ele aliyordu; yalnizca 7ffd985'te eklenen bu biri
  // almiyordu.
  const dirOverride = blankToUndefined(env['KEEPER_ADDRESS_BOOK_DIR'])
  const dir = bookDir ?? dirOverride
  const book = dir === undefined ? loadAddressBook(chainId) : loadAddressBook(chainId, dir)
  const factory = book.launchFactory
  const startBlock = book.startBlock
  const chainKey = book.chainKey

  // DEFTERI YENIDEN YONLENDIRMEK, FACTORY'YI ACIKCA SOYLEMEYI ZORUNLU KILAR.
  //
  // Round 1 defteri KAYNAK yapti ve `assertEnvAgrees`i capraz kontrol olarak
  // birakti. Defterin DIZINI env'e acilinca o capraz kontrolun GUVENLIK
  // ICERIGI bosaldi: iki taraf da ayni env-secili dosyadan geliyor, yani
  // hicbir sey atesleyemez. Gercekci zarar saldiri degil YANLIS
  // YAPILANDIRMADIR -- bir tatbikattan kalma bayat bir dizin izleyiciyi
  // BASKA, SESSIZ, GERCEK bir factory'ye baglar: okumalar basarili olur, kalp
  // atislari akar, her dedektor susar, ve onemli olan factory izlenmez. Bu
  // gorevin tamami tam olarak o sessizligi onlemek uzerine kurulu.
  //
  // Cozum, yonlendirmeyi SESSIZ olmaktan cikarmaktir: dizin ezildiginde
  // `ARC_FACTORY_ADDRESS` ZORUNLU olur ve tutmak zorundadir. Operator niyetini
  // IKI KEZ, IKI AYRI degiskende bildirmis olur. Ikinci ve daha guclu kapi
  // zincirin kendisidir; bkz. `assertFactoryMatchesGovernance`.
  // Yalnizca ETKIN olan yonlendirme sayilir: `bookDir` argumani verildiginde
  // env zaten yok sayilir, dolayisiyla ortada kapatilacak bir risk yoktur.
  // Arguman yolunu testler kullanir; operasyonel risk env yolundadir.
  const envRedirectIsEffective = bookDir === undefined && dirOverride !== undefined
  if (envRedirectIsEffective && blankToUndefined(env['ARC_FACTORY_ADDRESS']) === undefined) {
    throw new Error(
      'KEEPER_ADDRESS_BOOK_DIR redirects the address book, so ARC_FACTORY_ADDRESS must also be set and must match it. A redirected book is otherwise unchecked: a stale drill directory would point the watcher at a different, quiet, real factory while every detector stayed silent.',
    )
  }

  // IKISI BIRDEN EZILEMEZ, ve bu duzeltme bir incelemenin ACIK ISABETIDIR.
  //
  // Round 3'un raporu zincir pinini "UC BAGIMSIZ KAYNAK" diye anlatti. DEGILDI:
  // `allowlist.governor` `KEEPER_GOVERNANCE_FILE`dan gelir, yani pin
  // ENV-SECILI bir defteri ENV-SECILI bir governance dosyasiyla
  // karsilastiriyordu -- iki env kaynagi ve bir zincir okumasi. Ikisini birden
  // ayarlayan biri (ki capraz kontrolu denemek isteyen herkes dogal olarak
  // oyle yapar) uc kapiyi da gecebilirdi.
  //
  // OLCULDU: bugun bu SOMURULEBILIR DEGIL, ama sebebi bu dosya degil --
  // `packages/shared`'in `assertGovernanceAgrees`i her defterin `governor`
  // alanini SABIT YOLLU commit'li governance dosyasina bagliyor (GOVERNANCE_PATH
  // bir sabittir, env'den gelmez). Yani beni kurtaran sey BENIM savunmam degil,
  // baska bir ajanin dosyasi. O dosya degisirse pinim sessizce bosalir.
  //
  // Bu yuzden burada KENDI yarimi kapatiyorum: defter yeniden yonlendirildiyse
  // governance dosyasi VARSAYILAN, commit'li olan OLMAK ZORUNDADIR. Boylece
  // pinin ucuncu kaynagi, tam da onemli oldugu durumda, env'e acik degildir.
  // YALNIZCA VARSAYILAN GOVERNANCE DOSYASI KABUL EDILIR.
  //
  // Onceki hal bunu SADECE defter dizini de ezildiginde yasakliyordu. Ama
  // governance dosyasi pinin sabit tarafidir ve `packages/shared` defteri de
  // ayni dosyaya bagladigi icin, onu tek basina baska bir yere cevirmek ya
  // hicbir ise yaramaz ya da (o baglama bir gun `process.env`den okursa)
  // pinin iki tarafini birden secilebilir yapar. Degiskeni ACIKLIK icin
  // koruyoruz -- operator varsayilani yazabilir -- ama BASKA bir yola
  // isaret edemez.
  const governanceOverride = blankToUndefined(env['KEEPER_GOVERNANCE_FILE'])
  if (governanceOverride !== undefined && resolve(governanceOverride) !== DEFAULT_GOVERNANCE_PATH) {
    throw new Error(
      `KEEPER_GOVERNANCE_FILE may only name the committed default (${DEFAULT_GOVERNANCE_PATH}); it is the fixed side of the startup pin that compares the factory's on-chain governor() against expected-governance.json, and a pin whose every side is env-chosen proves nothing. Got "${governanceOverride}".`,
    )
  }
  if (envRedirectIsEffective && blankToUndefined(env['KEEPER_GOVERNANCE_FILE']) !== undefined) {
    throw new Error(
      "KEEPER_ADDRESS_BOOK_DIR and KEEPER_GOVERNANCE_FILE cannot both be overridden. The startup pin compares the factory's on-chain governor() against expected-governance.json; if BOTH the book and that file come from env, the pin compares two attacker- or accident-chosen files and proves nothing. Redirect at most one, so the pin always has one fixed, committed side.",
    )
  }

  // Env AYARLIYSA defterle AYNI olmak zorundadir. Ayarli degilse sorun yok:
  // deger zaten defterden geldi.
  assertEnvAgrees(env, 'ARC_FACTORY_ADDRESS', factory)
  assertEnvAgrees(env, 'ARC_START_BLOCK', startBlock.toString())
  assertEnvAgrees(env, 'KEEPER_CHAIN_KEY', chainKey)

  // HER YOL DEGISKENINDE BOS DIZE = AYARLANMAMIS.
  //
  // Round 3 bu hatayi YALNIZCA `KEEPER_ADDRESS_BOOK_DIR` icin duzeltti ve
  // hemen yanindaki iki satiri oldugu gibi birakti. Round 4'un pin sondasi
  // bunu calistirarak buldu: `KEEPER_GOVERNANCE_FILE=''` ile keeper
  // "cannot read the governance allowlist at " (yol BOS) diyerek oluyordu --
  // ayni sinif, bir satir asagida. Tek bir yardimci, uc yol.
  const governancePath = blankToUndefined(env['KEEPER_GOVERNANCE_FILE']) ?? DEFAULT_GOVERNANCE_PATH
  const cursorPath = blankToUndefined(env['KEEPER_CURSOR_FILE']) ?? DEFAULT_CURSOR_PATH

  const rawChunk = blankToUndefined(env['KEEPER_LOG_SCAN_CHUNK'])
  let logScanChunk = DEFAULT_LOG_SCAN_CHUNK
  if (rawChunk !== undefined) {
    if (!/^\d+$/.test(rawChunk) || BigInt(rawChunk) === 0n) {
      throw new Error(`KEEPER_LOG_SCAN_CHUNK must be a positive integer, got "${rawChunk}"`)
    }
    logScanChunk = BigInt(rawChunk)
  }

  let raw: string
  try {
    raw = readFileSync(governancePath, 'utf8')
  } catch {
    throw new Error(`cannot read the governance allowlist at ${governancePath}`)
  }

  // EN KOTUSU BUYDU CUNKU SESSIZ BASARISIZ OLUYORDU. '' korunuyordu ama
  // BOSLUK korunmuyordu: Number('   ') === 0, Number.isInteger(0) dogru,
  // 0 < 0 yanlis -> alertRepeatMs = 0 -> createThrottle(0) HICBIR SEYI
  // BASTIRMAZ, yani throttle'in var olma sebebi olan gunde ~35.000 sayfa geri
  // gelir. Ailenin geri kalani GURULTULU duser; bu tek basina sessizdi.
  const rawRepeat = blankToUndefined(env['KEEPER_ALERT_REPEAT_MS'])
  let alertRepeatMs: number | undefined
  if (rawRepeat !== undefined) {
    alertRepeatMs = Number(rawRepeat)
    if (!Number.isInteger(alertRepeatMs) || alertRepeatMs < 0) {
      throw new Error(`KEEPER_ALERT_REPEAT_MS must be a non-negative integer, got "${rawRepeat}"`)
    }
  }

  return {
    factory,
    startBlock,
    chainKey,
    governancePath,
    cursorPath,
    logScanChunk,
    allowlist: parseGovernanceAllowlist(JSON.parse(raw) as unknown, chainKey),
    // `=== ''` bosluktan ibaret bir degeri KACIRIRDI; tek yardimci her ikisini de alir.
    alertLogPath: blankToUndefined(env['KEEPER_ALERT_LOG']),
    alertRepeatMs,
  }
}

/**
 * DOLDURULMAMIS BIR DOSYAYLA BASLAMAYI REDDEDER, ve bu bir uslup tercihi
 * degil bir alarm-yorgunlugu karari:
 *
 *   `treasury` sifirken izin listesi bos olurdu, yani GERCEK hazine her
 *   poll'da (bes saniyede bir) sayfa cikarirdi. Bir gun icinde rota o sayfayi
 *   susturmayi ogrenir ve kontrol -- HALA "calisiyor" gorunurken -- sifira
 *   duser. Yapilandirma hatasi ACILISTA, bir kez, yuksek sesle patlar.
 *
 * `allowedGraduationTargets` BOS OLABILIR ve Faz 1d'de boyle OLMALIDIR:
 * hicbir hedef atanmamistir, dolayisiyla SIFIR OLMAYAN HER hedef sayfadir.
 * Bos liste "kontrol yok" degil, TAM OLARAK "hicbir sey mesru degil"
 * demektir.
 */
export function parseGovernanceAllowlist(input: unknown, chainKey: string): Allowlist {
  if (typeof input !== 'object' || input === null) {
    throw new Error('expected-governance.json: not an object')
  }
  const entry = (input as Record<string, unknown>)[chainKey]
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(
      `expected-governance.json: no entry for chainKey "${chainKey}" (known keys: ${Object.keys(input as object).join(', ')})`,
    )
  }
  const o = entry as Record<string, unknown>

  const treasury = coerceAddress(o['treasury'], `${chainKey}.treasury`)
  if (treasury === ZERO_ADDRESS) {
    throw new Error(
      `expected-governance.json: ${chainKey}.treasury is the zero address. The watcher refuses to start against an unfilled governance file -- it would page on every poll and the rota would learn to ignore it.`,
    )
  }
  const governor = coerceAddress(o['governor'], `${chainKey}.governor`)
  if (governor === ZERO_ADDRESS) {
    throw new Error(`expected-governance.json: ${chainKey}.governor is the zero address.`)
  }

  const rawTargets = o['allowedGraduationTargets']
  if (!Array.isArray(rawTargets)) {
    throw new Error(
      `expected-governance.json: ${chainKey}.allowedGraduationTargets is not an array`,
    )
  }
  const graduationTargets = rawTargets.map((value, i) => {
    const address = coerceAddress(value, `${chainKey}.allowedGraduationTargets[${i}]`)
    if (address === ZERO_ADDRESS) {
      throw new Error(
        `expected-governance.json: ${chainKey}.allowedGraduationTargets[${i}] is the zero address; proposeGraduationTarget rejects it (ZeroGraduationTarget), so allowlisting it can only hide a bug`,
      )
    }
    return address
  })

  return { graduationTargets, treasuries: [treasury], governor }
}

function coerceAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`${field}: expected an address, got ${JSON.stringify(value)}`)
  }
  return getAddress(value)
}

/**
 * Bos dize env'de "ayarlanmamis" demektir; `??` bunu GORMEZ.
 *
 * `keeper/` icindeki HER dize env okumasi bundan gecer. Bu kural uc turda uc
 * kez ihlal edildi -- once `KEEPER_ADDRESS_BOOK_DIR`, sonra
 * `KEEPER_GOVERNANCE_FILE`/`KEEPER_CURSOR_FILE`, sonra `ARC_CHAIN_ID` ile
 * `drill.ts`in iki okumasi -- ve her seferinde duzeltme YALNIZCA o an bakilan
 * satira uygulandi. Yeni bir env degiskeni eklerken: `??` degil, BU.
 */
export function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

/** Ayarlanmamis env sorun degil; YANLIS ayarlanmis env, ALANI ADIYLA, durdurur. */
function assertEnvAgrees(env: NodeJS.ProcessEnv, name: string, expected: string): void {
  const actual = env[name]
  if (actual === undefined || actual === '') return
  const same = isAddress(expected, { strict: false })
    ? isAddress(actual, { strict: false }) && getAddress(actual) === getAddress(expected)
    : actual === expected
  if (!same) {
    throw new Error(
      `${name} is "${actual}" but the address book says "${expected}". The book is the source; fix the env or regenerate the book.`,
    )
  }
}
