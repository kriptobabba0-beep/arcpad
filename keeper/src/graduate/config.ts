import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARC_TESTNET_CHAIN_ID, loadAddressBook } from '@arcpad/shared'
import { type Address, getAddress, isAddress } from 'viem'
import { blankToUndefined, REPO_ROOT } from '../config'
import { DEFAULT_CURVE_BATCH_SUBCALLS } from '../watch/graduationWindow'
import { DEFAULT_COMPLETED_WATCH_MS } from './completedWatch'

/**
 * ============ YURUTUCUNUN YAPILANDIRMASI ============
 *
 * AYRI BIR YUKLEYICI, `loadWatcherConfig`e alan eklemek yerine, ve gerekce
 * `loadWatcherConfig`in kendi gerekcesinin AYNADAKI HALI: izleyici SALT
 * OKURDUR ve `KEEPER_DRY_RUN` onu kapatmaz; yurutucu ZINCIRE YAZAR ve
 * `KEEPER_DRY_RUN` onun ANA anahtaridir. Ikisini tek bir yapiya koymak, biri
 * digerinin kapisini tasiyan iki farkli guven seviyesini ayni yerde tutmak
 * olurdu.
 */

export type GraduatorConfig = {
  rpcUrl: string
  chainId: number
  factory: Address
  locker: Address
  startBlock: bigint
  dryRun: boolean
  /** `undefined` = imzalayan yok. Kuru kosu ZORUNLU olur. */
  privateKey: `0x${string}` | undefined
  cursorPath: string
  statePath: string
  lockDir: string
  alertLogPath: string | undefined
  pollIntervalMs: number
  maxPerPass: number
  logScanChunk: bigint
  maxChunksPerPass: number
  /** `aggregate3` alt cagri sayisi, parca basina. Bkz. `KEEPER_CURVE_BATCH_SIZE`. */
  curveBatchSize: number
  /** `Completed` yoklama araligi. `0` = kapali; bkz. `completedWatch.ts`. */
  completedWatchMs: number
  /** Defter yerine acik env ile kuruldu mu. Sayfada ve acilis satirinda gorunur. */
  overridden: boolean
}

export const GRADUATE_ALERT_COMPONENT = 'keeper.graduate'

/**
 * DEFTERIN YERINE GECEBILEN UC DEGISKEN. `--book-only` bu listeyi reddeder.
 *
 * `KEEPER_GRADUATE_START_BLOCK` de LISTEDEDIR ve bu bir ayrinti degil: tek
 * basina bir baslangic blogu, defterin fabrikasini tararken taramayi ILK
 * launch'in ilerisinden baslatabilir ve o curve'ler HIC gorulmez. Olculmus
 * kardesi `.env.example`te yazilidir -- elle yazilmis bir startBlock, her poll
 * sayfa cikaran ve hic kalp atisi vermeyen bir keeper uretmisti.
 */
export const ADDRESS_OVERRIDE_VARS = [
  'KEEPER_GRADUATE_FACTORY',
  'KEEPER_GRADUATE_LOCKER',
  'KEEPER_GRADUATE_START_BLOCK',
] as const

export const DEFAULT_GRADUATE_CURSOR_PATH = fileURLToPath(
  new URL('../../.cursor-graduate', import.meta.url),
)
export const DEFAULT_GRADUATE_STATE_PATH = fileURLToPath(
  new URL('../../.graduate-state.json', import.meta.url),
)
export const DEFAULT_GRADUATE_LOCK_DIR = fileURLToPath(
  new URL('../../.graduate-locks', import.meta.url),
)

const DEFAULT_POLL_INTERVAL_MS = 15_000
const DEFAULT_MAX_PER_PASS = 4
const DEFAULT_LOG_SCAN_CHUNK = 10_000n

/**
 * DONGU MODUNDA gecis basina parca butcesi. `graduationWindow.ts`in C6
 * karariyla ayni: zinciri yurume isi indexer'indir, keeper kendini rasyonlar.
 * Bir soguk imlec birkac dakikada yetisir ve o sure boyunca durum
 * `catching-up` diye YAZILIR.
 */
const DEFAULT_MAX_CHUNKS_PER_PASS = 1

/**
 * `--once` MODUNDA GECIS BASINA butce, VE SAYI OLCULEREK SECILDI.
 *
 * `--once` bir SONRAKI POLL'a guvenemez, ama tek bir GECISE de sigdiramaz:
 * ilk hali 50 idi ve CANLI ARC ONU REDDETTI (2026-08-09, uretim defteri,
 * `startBlock` 55870261 -> head 56033742):
 *
 *   LogScanError over [56020261, 56030260]: Request exceeds defined limit
 *   ... Details: rate limit exceeded
 *
 * On altinci parcada dustu -- ve `withRateLimitRetry`in 14 denemesi de
 * tukendikten SONRA. Yani "ard arda 50 `eth_getLogs`" Arc'ta bir plan degil.
 * AGENT-CONTEXT'in kurali burada dogrudan gecerli: fan-out eden her sey
 * PACELENIR.
 *
 * Cozum ikili: gecis basina butce KUCUK kalir, ve `--once` gecisleri
 * ARALARINDA BEKLEYEREK tekrarlar (bkz. `graduate.ts`). Imlec parca basina
 * yazildigi icin her tur bir oncekinin kaldigi yerden devam eder.
 */
export const ONCE_MAX_CHUNKS_PER_PASS = 8

/** `--once` en fazla kac gecis dener. Butce x tur = 800.000 blokluk kapsama. */
export const ONCE_MAX_ROUNDS = 100

/**
 * ============ IMLEC AYRI DOSYADIR, VE BU ZORUNLUDUR ============
 *
 * Pencere izleyicisi ve yurutucu AYRI SUREÇLERDIR (`pnpm start` ve
 * `pnpm graduate`). `fileCursorStore` `writeFileSync` + `renameSync` ile
 * yazar; iki surec AYNI dosyaya yazarsa biri digerinin ilerlemesini geri
 * alir ve tarama araligi ikiye bolunur -- `index.ts`in `setInterval` yerine
 * kendini yeniden zamanlamasinin sebebiyle AYNI ariza, iki surec olcegine
 * tasinmis hali. Varsayilan yollar bu yuzden farklidir.
 */
export function loadGraduatorConfig(
  env: NodeJS.ProcessEnv,
  opts?: { bookDir?: string; once?: boolean; bookOnly?: boolean },
): GraduatorConfig {
  const bookDir = opts?.bookDir
  const rpcUrl = blankToUndefined(env['ARC_RPC_URL'])
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set (see .env.example)')

  // ============ `--book-only`: ADRESLER ENV'DEN GELEMEZ ============
  //
  // Ve KAPI BILEREK ARGV'DEDIR, ENV'DE DEGIL. Servisin okudugu TEK kaynak
  // `EnvironmentFile`dir; bir env degiskeni olsaydi ayni dosya hem kapiyi
  // hem de kapinin engelledigi adresleri tasiyabilirdi -- yani kendi kendini
  // acan bir kilit. Bayrak `ExecStart` satirindadir: onu degistirmek unit
  // dosyasini duzenlemek demektir, ve o AYRI, ayricalikli, gozden gecirilir
  // bir istir.
  //
  // Neden bu gerekiyor: indexer `ARC_FACTORY_ADDRESS`i env'den alir ve
  // `scripts/integration/env-from-book.ts` onu deftere baglamak icin VAR.
  // Keeper defteri DOGRUDAN okur, yani o zayiflik onda YOK -- ama bir
  // deployment `KEEPER_GRADUATE_FACTORY` yazarak onu geri getirebilirdi.
  // Bu satirlar, "elle yazilmis adres" yolunun uzun sureli calisan servise
  // sizmasini imkansiz kilar; tek seferlik pencere yordami (bkz.
  // keeper-graduation-report §6) bayragi HIC gecmedigi icin etkilenmez.
  if (opts?.bookOnly === true) {
    const handSet = ADDRESS_OVERRIDE_VARS.filter(
      (name) => blankToUndefined(env[name]) !== undefined,
    )
    if (handSet.length > 0) {
      throw new Error(
        `--book-only refuses to start: ${handSet.join(', ')} ${handSet.length === 1 ? 'is' : 'are'} set in this process's environment. A long-running service takes its addresses from contracts/deploy/addresses.<chainId>.json and from nowhere else -- a hand-set address is how a deployment silently ends up watching a different stack than the one it reports. Remove ${handSet.length === 1 ? 'it' : 'them'} from the unit's EnvironmentFile, or drop --book-only deliberately for a one-off run against a stack the book cannot carry.`,
      )
    }
  }

  const rawChainId = blankToUndefined(env['ARC_CHAIN_ID'])
  const chainId = rawChainId === undefined ? ARC_TESTNET_CHAIN_ID : Number(rawChainId)
  if (!Number.isSafeInteger(chainId)) {
    throw new Error(`ARC_CHAIN_ID must be an integer, got "${env['ARC_CHAIN_ID'] ?? ''}"`)
  }

  // ============ IKI KAYNAK, VE IKINCISI ACIKCA SECILIR ============
  //
  // Uretim yolunda her sey DEFTERDEN gelir. Ama DISPOSABLE yigin deftere
  // GIREMEZ: `parseAddressBook` `launchFactory`nin `CREATE2(0x4e59..56C,
  // FACTORY_SALT, factoryInitcodeHash)`ten turedigini dogrular ve disposable
  // fabrika BASKA bir tuzla madenlendi -- olculdu, ayni kapi tatbikat
  // fabrikasini da reddetti. Yani "defteri yeniden yonlendir" yolu bu yigin
  // icin CALISMAZ ve calismamasi DOGRUDUR.
  //
  // Bu yuzden ikinci bir yol var ve o yol GURULTULUDUR: IKISI BIRDEN
  // verilmek zorundadir. `resolveSmokePair`in "yarim cift kabul etme" dersi
  // burada da gecerlidir -- tek basina bir fabrika, bir onceki yiginin
  // locker'iyla eslesip SESSIZCE yanlis seye yazardi. Guvence ZINCIRDEN
  // gelir: `assertLockerMatchesFactory` locker'in `factory()`sini okur.
  const factoryOverride = blankToUndefined(env['KEEPER_GRADUATE_FACTORY'])
  const lockerOverride = blankToUndefined(env['KEEPER_GRADUATE_LOCKER'])
  if ((factoryOverride === undefined) !== (lockerOverride === undefined)) {
    throw new Error(
      'KEEPER_GRADUATE_FACTORY and KEEPER_GRADUATE_LOCKER must be set together or not at all. A factory without its locker would silently pair with the address book\'s locker -- which belongs to a DIFFERENT deployment -- and the executor would send graduate() through the wrong contract.',
    )
  }

  let factory: Address
  let locker: Address
  let startBlock: bigint
  const overridden = factoryOverride !== undefined && lockerOverride !== undefined

  if (overridden) {
    factory = coerce(factoryOverride, 'KEEPER_GRADUATE_FACTORY')
    locker = coerce(lockerOverride, 'KEEPER_GRADUATE_LOCKER')
    const rawStart = blankToUndefined(env['KEEPER_GRADUATE_START_BLOCK'])
    if (rawStart === undefined || !/^\d+$/.test(rawStart)) {
      throw new Error(
        'KEEPER_GRADUATE_START_BLOCK must be set to the block the overridden factory was deployed in. Without it the Launched scan would start from the address book\'s startBlock, which for the production book is 1.2M blocks of a DIFFERENT factory\'s history -- every one of them scanned and none of them relevant.',
      )
    }
    startBlock = BigInt(rawStart)
  } else {
    const book = bookDir === undefined ? loadAddressBook(chainId) : loadAddressBook(chainId, bookDir)
    factory = book.launchFactory
    locker = book.arcpadLocker
    startBlock = book.launchFactoryBlock
  }

  const rawInterval = blankToUndefined(env['KEEPER_GRADUATE_POLL_INTERVAL_MS'])
  const pollIntervalMs = rawInterval === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(rawInterval)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `KEEPER_GRADUATE_POLL_INTERVAL_MS must be a positive integer, got "${rawInterval ?? ''}"`,
    )
  }

  const rawMax = blankToUndefined(env['KEEPER_GRADUATE_MAX_PER_PASS'])
  const maxPerPass = rawMax === undefined ? DEFAULT_MAX_PER_PASS : Number(rawMax)
  if (!Number.isInteger(maxPerPass) || maxPerPass <= 0) {
    throw new Error(`KEEPER_GRADUATE_MAX_PER_PASS must be a positive integer, got "${rawMax ?? ''}"`)
  }

  const rawChunk = blankToUndefined(env['KEEPER_LOG_SCAN_CHUNK'])
  if (rawChunk !== undefined && (!/^\d+$/.test(rawChunk) || BigInt(rawChunk) === 0n)) {
    throw new Error(`KEEPER_LOG_SCAN_CHUNK must be a positive integer, got "${rawChunk}"`)
  }
  const logScanChunk = rawChunk === undefined ? DEFAULT_LOG_SCAN_CHUNK : BigInt(rawChunk)

  // ============ PARCA BOYU: OLCULEN VARSAYILAN, INDIRILEBILIR TAVAN ========
  //
  // Varsayilanin nereden geldigi `DEFAULT_CURVE_BATCH_SUBCALLS`in NatSpec'inde
  // olcum tablosuyla birlikte duruyor. Degisken VAR cunku olculen duvar
  // (`intrinsic gas too low`, 6400 kabul / 12800 red) ARC'IN BUGUNKU PUBLIC
  // UCUNUN gaz tavanidir -- baska bir saglayicida baska yerdedir. Bir operator
  // reddedilen bir parcayla karsilasirsa cevabi kod degisikligi olmamalidir.
  const rawBatch = blankToUndefined(env['KEEPER_CURVE_BATCH_SIZE'])
  const curveBatchSize = rawBatch === undefined ? DEFAULT_CURVE_BATCH_SUBCALLS : Number(rawBatch)
  if (!Number.isInteger(curveBatchSize) || curveBatchSize <= 0) {
    throw new Error(
      `KEEPER_CURVE_BATCH_SIZE must be a positive integer, got "${rawBatch ?? ''}". It is the number of aggregate3 SUB-CALLS per eth_call; measured on live Arc, 6400 was accepted and 12800 was refused with "intrinsic gas too low", and the shipped default is ${DEFAULT_CURVE_BATCH_SUBCALLS}.`,
    )
  }

  // ============ OLAY TETIKLEYICISI: 0 = KAPALI ============
  //
  // Gerekcesi ve olculen bedeli `completedWatch.ts`in dosya basi NatSpec'inde.
  // Kapatmak MESRU bir secimdir (bir operator Arc'in paylasilan butcesini
  // indexer'a birakmak isteyebilir) ve o zaman gecikme bugunku 15 saniyeye
  // geri doner -- yani KAPALI HALI de calisan bir yapilandirmadir, bozuk
  // degil.
  const rawWatch = blankToUndefined(env['KEEPER_GRADUATE_COMPLETED_WATCH_MS'])
  const completedWatchMs = rawWatch === undefined ? DEFAULT_COMPLETED_WATCH_MS : Number(rawWatch)
  if (!Number.isInteger(completedWatchMs) || completedWatchMs < 0) {
    throw new Error(
      `KEEPER_GRADUATE_COMPLETED_WATCH_MS must be a non-negative integer (0 disables the low-latency Completed watch), got "${rawWatch ?? ''}"`,
    )
  }
  if (completedWatchMs > 0 && completedWatchMs >= pollIntervalMs) {
    throw new Error(
      `KEEPER_GRADUATE_COMPLETED_WATCH_MS is ${completedWatchMs}ms but the poll interval is ${pollIntervalMs}ms. A Completed watch at or above the poll interval costs extra eth_getLogs requests and buys NO latency -- the poll would fire first anyway. Set it below the poll interval, or to 0 to disable it.`,
    )
  }

  const rawBudget = blankToUndefined(env['KEEPER_GRADUATE_CHUNKS_PER_PASS'])
  const budgetDefault =
    opts?.once === true ? ONCE_MAX_CHUNKS_PER_PASS : DEFAULT_MAX_CHUNKS_PER_PASS
  const maxChunksPerPass = rawBudget === undefined ? budgetDefault : Number(rawBudget)
  if (!Number.isInteger(maxChunksPerPass) || maxChunksPerPass <= 0) {
    throw new Error(
      `KEEPER_GRADUATE_CHUNKS_PER_PASS must be a positive integer, got "${rawBudget ?? ''}"`,
    )
  }

  // ============ ANAHTAR ARGV'DE DEGIL, DOSYADA DEGIL, ENV'DE ============
  //
  // `.env.example`in kendi kurali: "Ozel anahtar ASLA buraya veya argv'ye
  // yazilmaz." `.env.deployer` BU SUREC TARAFINDAN HIC OKUNMAZ; degisken
  // surece disaridan enjekte edilir. Kuru kosu VARSAYILANDIR, yani anahtarin
  // YOKLUGU bir hata degil sadece "yayin yapamam"dir.
  //
  // ...VE IKINCI BIR YOL: `KEEPER_GRADUATE_PRIVATE_KEY_FILE`.
  //
  // NEDEN VAR. systemd'nin `LoadCredentialEncrypted=`i anahtari DISKTE SIFRELI
  // tutar ve yalnizca unit'in kendi kimlik bilgisi dizinine cozer; o dizin
  // baska hicbir servise, baska hicbir kullaniciya gorunmez. Ama oraya bir
  // DOSYA koyar, bir env degiskeni degil. Dosya yolunu kabul etmek, anahtarin
  // hicbir surecin ortaminda -- ve dolayisiyla hicbir `EnvironmentFile`da,
  // hicbir `systemctl show` ciktisinda, hicbir shell gecmisinde -- gorunmemesi
  // demektir.
  //
  // IKISI BIRDEN VERILIRSE REDDEDILIR. "Hangisi kazandi" sorusunun cevabi bir
  // IMZALAYAN KIMLIGIDIR; sessizce birini secmek, yanlis adresten yayin yapan
  // ve sebebi gorunmeyen bir yurutucu uretirdi.
  const keyFile = blankToUndefined(env['KEEPER_GRADUATE_PRIVATE_KEY_FILE'])
  const keyInline = blankToUndefined(env['KEEPER_GRADUATE_PRIVATE_KEY'])
  if (keyFile !== undefined && keyInline !== undefined) {
    throw new Error(
      'KEEPER_GRADUATE_PRIVATE_KEY and KEEPER_GRADUATE_PRIVATE_KEY_FILE are both set. Picking one silently would decide WHICH ADDRESS signs, and the answer would not appear anywhere in the logs. Set exactly one.',
    )
  }

  let privateKeyRaw = keyInline
  if (keyFile !== undefined) {
    let contents: string
    try {
      contents = readFileSync(keyFile, 'utf8')
    } catch (cause) {
      throw new Error(
        `KEEPER_GRADUATE_PRIVATE_KEY_FILE points at ${keyFile}, which cannot be read: ${cause instanceof Error ? cause.message : String(cause)}. Refusing to start; a broadcasting executor with no signer is the shape this config already refuses elsewhere.`,
      )
    }
    // BOSLUK KIRPILIR. Bir anahtar dosyasi neredeyse her zaman satir sonuyla
    // biter (`echo`, editor, `systemd-creds`), ve kirpmamak "32-byte hex degil"
    // hatasini dosyanin GORUNMEZ son baytindan uretirdi.
    privateKeyRaw = blankToUndefined(contents.trim())
    if (privateKeyRaw === undefined) {
      throw new Error(
        `KEEPER_GRADUATE_PRIVATE_KEY_FILE points at ${keyFile}, which is empty. Refusing to start.`,
      )
    }
  }

  if (privateKeyRaw !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(privateKeyRaw)) {
    throw new Error(
      // ICERIK ASLA YAZILMAZ, YALNIZCA KAYNAGI. Bir hata satirina basilan
      // anahtar, journald'a ve oradan her log toplayicisina gider.
      `${keyFile === undefined ? 'KEEPER_GRADUATE_PRIVATE_KEY' : `the contents of ${keyFile} (KEEPER_GRADUATE_PRIVATE_KEY_FILE)`} is not a 0x-prefixed 32-byte hex string. Refusing to start rather than deriving a wrong signer.`,
    )
  }

  const dryRun = env['KEEPER_DRY_RUN'] !== 'false'
  if (!dryRun && privateKeyRaw === undefined) {
    throw new Error(
      'KEEPER_DRY_RUN=false but neither KEEPER_GRADUATE_PRIVATE_KEY nor KEEPER_GRADUATE_PRIVATE_KEY_FILE is set. An executor told to broadcast with no signer would run forever, simulate green forever, and graduate nothing -- the exact "mechanism exists but its output goes nowhere" shape this project keeps paying for. Refusing to start.',
    )
  }

  return {
    rpcUrl,
    chainId,
    factory,
    locker,
    startBlock,
    dryRun,
    privateKey: privateKeyRaw as `0x${string}` | undefined,
    cursorPath:
      fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_CURSOR_FILE'])) ??
      DEFAULT_GRADUATE_CURSOR_PATH,
    statePath:
      fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_STATE_FILE'])) ??
      DEFAULT_GRADUATE_STATE_PATH,
    lockDir:
      fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_LOCK_DIR'])) ?? DEFAULT_GRADUATE_LOCK_DIR,
    alertLogPath: fromRepoRoot(blankToUndefined(env['KEEPER_GRADUATE_ALERT_LOG'])),
    pollIntervalMs,
    maxPerPass,
    logScanChunk,
    maxChunksPerPass,
    curveBatchSize,
    completedWatchMs,
    overridden,
  }
}

function coerce(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${field} is "${value}", not an address`)
  }
  return getAddress(value)
}

/** `resolveFromRepoRoot` ile ayni kural; bkz. onun olculmus gerekcesi. */
function fromRepoRoot(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path)
}
