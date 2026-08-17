import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadKeeperConfig, loadWatcherConfig, REPO_ROOT, resolveFromRepoRoot } from '../src/config'
import { drillSinkPath } from '../src/drill'

const BOOK_DIR = fileURLToPath(new URL('../../contracts/deploy/testdata', import.meta.url))
const GOVERNANCE = fileURLToPath(
  new URL('../../contracts/deploy/expected-governance.json', import.meta.url),
)
const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true })
})

describe('loadKeeperConfig', () => {
  it('gecerli ortamdan yapilandirma uretir', () => {
    const config = loadKeeperConfig({
      ARC_RPC_URL: 'https://rpc.testnet.arc.io',
      KEEPER_POLL_INTERVAL_MS: '2000',
      KEEPER_DRY_RUN: 'false',
    })
    expect(config).toEqual({
      rpcUrl: 'https://rpc.testnet.arc.io',
      // Yapilandirilmamis bir dagitimda BOS -- yani tek uc, bugunku davranis.
      rpcFallbackUrls: '',
      pollIntervalMs: 2000,
      dryRun: false,
    })
  })

  it('ARC_RPC_URL yoksa hata firlatir', () => {
    expect(() => loadKeeperConfig({})).toThrow(/ARC_RPC_URL/)
  })

  it('poll araligi belirtilmezse 5000 ms varsayar', () => {
    const config = loadKeeperConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.io' })
    expect(config.pollIntervalMs).toBe(5000)
  })

  it('guvenli tarafta durur: dryRun varsayilan olarak aciktir', () => {
    const config = loadKeeperConfig({ ARC_RPC_URL: 'https://rpc.testnet.arc.io' })
    expect(config.dryRun).toBe(true)
  })

  it('poll araligi sayi degilse hata firlatir', () => {
    expect(() =>
      loadKeeperConfig({
        ARC_RPC_URL: 'https://rpc.testnet.arc.io',
        KEEPER_POLL_INTERVAL_MS: 'soon',
      }),
    ).toThrow(/KEEPER_POLL_INTERVAL_MS/)
  })
})

/**
 * DEFTER KAYNAKTIR. Bu suite `contracts/deploy/testdata/addresses.31337.json`
 * fixture'ini kullanir; `chainKey` orada "local-rehearsal"dir ve
 * `expected-governance.json` icinde o kaydin governor/treasury'si DOLUDUR.
 * Yani iki dosya UCTAN UCA birlestirilmis olur.
 */
describe('loadWatcherConfig', () => {
  const BOOK_DIR = fileURLToPath(new URL('../../contracts/deploy/testdata', import.meta.url))
  const GOVERNANCE = fileURLToPath(
    new URL('../../contracts/deploy/expected-governance.json', import.meta.url),
  )
  const base = { ARC_CHAIN_ID: '31337', KEEPER_GOVERNANCE_FILE: GOVERNANCE }

  it('factory, startBlock ve chainKey"i DEFTERDEN alir, env"den degil', () => {
    const config = loadWatcherConfig(base, BOOK_DIR)
    expect(config.factory).toBe('0xeeaE42fa79dA76cF5186CE47e5c66BF496DF66f3')
    expect(config.startBlock).toBe(1n)
    expect(config.chainKey).toBe('local-rehearsal')
    expect(config.allowlist.treasuries).toEqual(['0x0000000000000000000000000000000000007EA5'])
    // Faz 1d: hicbir hedef atanmamis. BOS LISTE "kontrol yok" degil,
    // "hicbir sey mesru degil" demektir.
    expect(config.allowlist.graduationTargets).toEqual([])
  })

  // OLCULEN ARIZA: ilk launch'in ilerisine ayarlanmis bir startBlock her poll
  // sayfa cikarir ve hic kalp atisi vermez. Artik env deftere UYMAK ZORUNDA.
  it('env defterle CELISIYORSA ALANI ADIYLA durur', () => {
    expect(() => loadWatcherConfig({ ...base, ARC_START_BLOCK: '999999' }, BOOK_DIR)).toThrow(
      /ARC_START_BLOCK is "999999" but the address book says "1"/,
    )
    expect(() =>
      loadWatcherConfig(
        { ...base, ARC_FACTORY_ADDRESS: '0x0000000000000000000000000000000000000001' },
        BOOK_DIR,
      ),
    ).toThrow(/ARC_FACTORY_ADDRESS/)
    expect(() => loadWatcherConfig({ ...base, KEEPER_CHAIN_KEY: 'arc-testnet' }, BOOK_DIR)).toThrow(
      /KEEPER_CHAIN_KEY/,
    )
  })

  it('env AYNIYSA (ya da hic yoksa) gecer', () => {
    expect(() =>
      loadWatcherConfig(
        {
          ...base,
          ARC_START_BLOCK: '1',
          ARC_FACTORY_ADDRESS: '0xeeae42fa79da76cf5186ce47e5c66bf496df66f3',
          KEEPER_CHAIN_KEY: 'local-rehearsal',
        },
        BOOK_DIR,
      ),
    ).not.toThrow()
  })

  it('defter yoksa BASLAMAZ -- sessiz bir env yedegi yoktur', () => {
    expect(() => loadWatcherConfig({ ...base, ARC_CHAIN_ID: '424242' }, BOOK_DIR)).toThrow(/file/)
  })

  it('alarm lavabosu ve tekrar araligi env"den okunur', () => {
    const config = loadWatcherConfig(
      { ...base, KEEPER_ALERT_LOG: 'keeper/alerts.log', KEEPER_ALERT_REPEAT_MS: '900000' },
      BOOK_DIR,
    )
    // GORELI YOL DEPO KOKUNE GORE COZULUR. Onceki hal ham dizeyi tutuyordu ve
    // bu, runbook'un kendi komutunun OLCULEN arizasiydi:
    // `pnpm --filter` calisma dizinini `keeper/` yapar, `keeper/alerts.log`
    // `<root>/keeper/keeper/alerts.log`a cozulur, o dizin yoktur, ve keeper
    // TEK bir kalp atisindan sonra ENOENT ile OLUR.
    expect(config.alertLogPath).toBe(resolve(REPO_ROOT, 'keeper/alerts.log'))
    expect(config.alertLogPath).toBe(
      fileURLToPath(new URL('../../keeper/alerts.log', import.meta.url)),
    )
    expect(config.alertRepeatMs).toBe(900_000)
  })

  it('MUTLAK alarm yolu oldugu gibi birakilir -- CI $RUNNER_TEMP/alerts.log gonderir', () => {
    const absolute = join(tmpdir(), 'arcpad-drill-alerts.log')
    const config = loadWatcherConfig({ ...base, KEEPER_ALERT_LOG: absolute }, BOOK_DIR)
    expect(config.alertLogPath).toBe(absolute)
  })

  it('goreli yol CALISMA DIZININDEN BAGIMSIZDIR -- runbook komutunun arizasi buydu', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(REPO_ROOT, 'keeper'))
    try {
      const config = loadWatcherConfig({ ...base, KEEPER_ALERT_LOG: 'keeper/alerts.log' }, BOOK_DIR)
      // `pnpm --filter` calisma dizinini `keeper/` yapar. Cozum cwd'ye
      // baglansaydi `<root>/keeper/keeper/alerts.log` cikardi -- OLCULEN
      // ENOENT tam olarak o yoldu.
      expect(config.alertLogPath).toBe(resolve(REPO_ROOT, 'keeper/alerts.log'))
      expect(config.alertLogPath).not.toContain(join('keeper', 'keeper'))
    } finally {
      cwd.mockRestore()
    }
  })

  // Uretimde varsayilan (contracts/deploy) dogru olandir. Bu knob staging
  // defterlerine karsi kosmak ve izleyiciyi GERCEK bir surec olarak sahte bir
  // zincire karsi kirabilmek icin var -- loop-level tatbikat onu kullanir.
  const FACTORY = '0xeeaE42fa79dA76cF5186CE47e5c66BF496DF66f3'

  // Defter yeniden yonlendirildiginde governance dosyasi VARSAYILAN olmak
  // ZORUNDA (asagida), o yuzden bu blok `KEEPER_GOVERNANCE_FILE` TASIMAZ.
  const redirectBase = { ARC_CHAIN_ID: '31337' }

  it('defter dizini env uzerinden verilebilir, ve arguman env i EZER', () => {
    const redirected = {
      ...redirectBase,
      KEEPER_ADDRESS_BOOK_DIR: BOOK_DIR,
      ARC_FACTORY_ADDRESS: FACTORY,
    }
    expect(loadWatcherConfig(redirected).startBlock).toBe(1n)
    expect(() =>
      loadWatcherConfig({
        ...redirectBase,
        KEEPER_ADDRESS_BOOK_DIR: 'nope',
        ARC_FACTORY_ADDRESS: FACTORY,
      }),
    ).toThrow(/file/)
    // Arguman verildiginde env yok sayilir.
    expect(loadWatcherConfig({ ...base, KEEPER_ADDRESS_BOOK_DIR: 'nope' }, BOOK_DIR).chainKey).toBe(
      'local-rehearsal',
    )
  })

  // ZINCIR PININ UCUNCU KAYNAGI ENV'E ACIK OLAMAZ.
  //
  // Round 3'un raporu pini "uc bagimsiz kaynak" diye anlatti; degildi --
  // `allowlist.governor` `KEEPER_GOVERNANCE_FILE`dan geliyordu, yani IKISI DE
  // env-seciliydi. Ikisini birden ezmek, capraz kontrolu denemek isteyen
  // herkesin dogal olarak yapacagi seydir.
  it('KEEPER_ADDRESS_BOOK_DIR ile KEEPER_GOVERNANCE_FILE birlikte EZILEMEZ', () => {
    expect(() =>
      loadWatcherConfig({
        ...redirectBase,
        KEEPER_ADDRESS_BOOK_DIR: BOOK_DIR,
        ARC_FACTORY_ADDRESS: FACTORY,
        KEEPER_GOVERNANCE_FILE: GOVERNANCE,
      }),
    ).toThrow(/cannot both be overridden/)
  })

  // AYNI SINIF, BIR SATIR ASAGIDA. Round 3 bos-dize hatasini yalnizca defter
  // dizininde duzeltmisti; round 4'un pin sondasi bunu CALISTIRARAK buldu:
  // `KEEPER_GOVERNANCE_FILE=''` ile keeper "cannot read the governance
  // allowlist at " (yol BOS) diyerek oluyordu.
  it('BOS yol degiskenleri varsayilana duser, ciplak bos yola degil', () => {
    for (const key of ['KEEPER_GOVERNANCE_FILE', 'KEEPER_CURSOR_FILE'] as const) {
      const config = loadWatcherConfig({ ARC_CHAIN_ID: '31337', [key]: '' }, BOOK_DIR)
      const path = key === 'KEEPER_GOVERNANCE_FILE' ? config.governancePath : config.cursorPath
      expect(path, key).not.toBe('')
      expect(path.replace(/\\/g, '/'), key).toContain('/')
    }
  })

  it('YALNIZCA governance dosyasini ezmek serbesttir -- defter hala commit"li', () => {
    expect(() =>
      loadWatcherConfig({ ...base, KEEPER_GOVERNANCE_FILE: GOVERNANCE }, BOOK_DIR),
    ).not.toThrow()
  })

  // BOS DIZE = AYARLANMAMIS. `.env.example` bu degiskeni BOS gonderir ve
  // dotenv onu bos DIZE olarak verir; `??` bunu gormez ve deger
  // `loadAddressBook(chainId, '')`e ciplak goreli yol olarak giderdi. Yani
  // deponun kendi belgelenmis kurulum yolu, baslamayi reddeden bir keeper
  // uretiyordu.
  // ARGUMANSIZ CAGRILIR, ve bu sart: `bookDir` argumani env'i tamamen ezer,
  // dolayisiyla onu gecen bir test bos-dize islemesini HIC yurutmez. Ilk hali
  // oyleydi ve M30 mutanti (bos dizeyi ciplak goreli yol olarak gecir) SAG
  // KALDI. Ayirt edici kanit HATA MESAJINDAKI YOL: dogru halde varsayilan
  // dizin (`contracts/deploy/...`) gorunur, bozuk halde CIPLAK dosya adi.
  it('BOS bir KEEPER_ADDRESS_BOOK_DIR "ayarlanmamis" sayilir', () => {
    for (const blank of ['', '   ']) {
      let message = ''
      try {
        loadWatcherConfig({ ...base, KEEPER_ADDRESS_BOOK_DIR: blank })
      } catch (error) {
        message = String(error)
      }
      expect(message, `blank=${JSON.stringify(blank)}`).toContain('addresses.31337.json')
      // VARSAYILAN DIZINE dustu, ciplak goreli yola degil.
      expect(message.replace(/\\/g, '/'), `blank=${JSON.stringify(blank)}`).toContain(
        'contracts/deploy/addresses.31337.json',
      )
      // Ve bos dize yonlendirme kapisini TETIKLEMEZ: hata defter yolu
      // hakkindadir, ARC_FACTORY_ADDRESS hakkinda degil.
      expect(message).not.toContain('ARC_FACTORY_ADDRESS must also be set')
    }
  })

  it('ayarsiz ile bos dize AYNI davranir', () => {
    const unset = (): string => {
      try {
        loadWatcherConfig({ ARC_CHAIN_ID: '31337', KEEPER_GOVERNANCE_FILE: GOVERNANCE })
        return 'no throw'
      } catch (error) {
        return String(error)
      }
    }
    const blank = (): string => {
      try {
        loadWatcherConfig({ ...base, KEEPER_ADDRESS_BOOK_DIR: '' })
        return 'no throw'
      } catch (error) {
        return String(error)
      }
    }
    expect(blank()).toBe(unset())
  })

  // Defteri yeniden yonlendirmek SESSIZ olamaz: bayat bir tatbikat dizini
  // izleyiciyi baska, sessiz, gercek bir factory'ye baglar ve her dedektor
  // susar.
  it('dizin ezilirse ARC_FACTORY_ADDRESS ZORUNLUDUR', () => {
    expect(() => loadWatcherConfig({ ...redirectBase, KEEPER_ADDRESS_BOOK_DIR: BOOK_DIR })).toThrow(
      /ARC_FACTORY_ADDRESS must also be set/,
    )
    expect(() =>
      loadWatcherConfig({
        ...redirectBase,
        KEEPER_ADDRESS_BOOK_DIR: BOOK_DIR,
        ARC_FACTORY_ADDRESS: '0x0000000000000000000000000000000000000001',
      }),
    ).toThrow(/ARC_FACTORY_ADDRESS/)
  })

  it('bozuk tekrar araligi reddedilir', () => {
    expect(() => loadWatcherConfig({ ...base, KEEPER_ALERT_REPEAT_MS: 'soon' }, BOOK_DIR)).toThrow(
      /KEEPER_ALERT_REPEAT_MS/,
    )
  })
})

/**
 * ============================================================================
 * CROSS-PACKAGE CONTRACT TEST -- DO NOT DELETE WITHOUT READING THIS
 * ============================================================================
 *
 * NEYI SAVUNUYOR: keeper'in acilis pini
 * (`assertFactoryMatchesGovernance`) factory'nin ZINCIRDEKI `governor()`
 * degerini `expected-governance.json`daki governor ile karsilastirir. O
 * karsilastirmanin bir anlami olmasi icin, DEFTERIN ISARET ETTIGI factory ile
 * governance dosyasinin ZATEN baglanmis olmasi gerekir -- aksi halde yeniden
 * yonlendirilmis bir defter hem factory'yi hem de "beklenen" governor'u
 * secebilir ve pin iki secili degeri birbiriyle karsilastirip hicbir sey
 * ispatlamaz.
 *
 * O baglamayi keeper YAPMAZ. `packages/shared`in `parseAddressBook`i yapar:
 * her defteri, SABIT yollu `expected-governance.json` ile karsilastirir.
 *
 * NEDEN BU TEST VAR: bu, BASKA BIR PAKETTEKI, BASKA BIR AJANIN sahibi oldugu
 * bir garantiye YAZILMAMIS bir bagimliliktir. Round 4'un incelemesi bunu
 * "kimsenin kaydetmedigi bir sebeple dogru olan ozellik" olarak isaretledi:
 * `packages/shared` o kontrolu kaldirirsa, bir env degiskeninin arkasina
 * alirsa ya da kosullu yaparsa, keeper'in pini SESSIZCE bosalir ve BENIM
 * hicbir testim kirmizi olmaz. Bu test tam olarak o sessizligi bir
 * BASARISIZLIGA cevirir.
 *
 * SILMEDEN ONCE: pinin hala bir sey ispatladigini gosteren baska bir
 * mekanizma yazin. Bu testi kirmizi buldugunuzda dogru refleks onu silmek
 * DEGIL, `packages/shared`in neden garantiyi biraktigini sormaktir.
 *
 * `packages/shared`in ICINE BAKMAZ: dosyalarini okumaz, ic fonksiyonlarini
 * cagirmaz. Yalnizca keeper'in GERCEKTEN kullandigi arayuzden --
 * `loadWatcherConfig` -- gozlenebilir davranisi iddia eder.
 */
describe('CONTRACT: the address book is bound to expected-governance.json', () => {
  const REAL_GOVERNANCE = JSON.parse(readFileSync(GOVERNANCE, 'utf8')) as Record<
    string,
    { governor: string; treasury: string }
  >

  /** testdata defterini alir, istenen alanlari degistirip gecici bir dizine yazar. */
  const bookDirWith = (overrides: Record<string, unknown>): string => {
    const book = JSON.parse(readFileSync(join(BOOK_DIR, 'addresses.31337.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-contract-'))
    scratch.push(dir)
    writeFileSync(
      join(dir, 'addresses.31337.json'),
      JSON.stringify({ ...book, ...overrides }, null, 2),
      'utf8',
    )
    return dir
  }

  it('bir defter, governance dosyasiyla CELISEN bir governor bildiremez', () => {
    const chainKey = (
      JSON.parse(readFileSync(join(BOOK_DIR, 'addresses.31337.json'), 'utf8')) as {
        chainKey: string
      }
    ).chainKey
    const declared = REAL_GOVERNANCE[chainKey]
    expect(declared, `expected-governance.json has no ${chainKey} entry`).toBeDefined()

    // Gercek governor'dan FARKLI, ama gecerli ve diger rollerle takma ad olmayan bir adres.
    const impostor = '0x00000000000000000000000000000000000B0b01'
    expect(impostor.toLowerCase()).not.toBe(
      (declared as { governor: string }).governor.toLowerCase(),
    )

    let message = ''
    try {
      loadWatcherConfig({ ARC_CHAIN_ID: '31337' }, bookDirWith({ governor: impostor }))
      message = 'LOADED -- the book was NOT checked against expected-governance.json'
    } catch (error) {
      message = String(error)
    }
    expect(
      message,
      'packages/shared must reject a book whose governor disagrees with expected-governance.json; if this fails, the keeper startup pin no longer proves anything -- read the comment above this describe block',
    ).toMatch(/expected-governance.json/)
    expect(message).not.toContain('LOADED')
  })

  it('o karsilastirmanin yolu ENV ILE DEGISTIRILEMEZ', () => {
    // Sahte bir governance dosyasi yaz: sahtekar governor'u MESRU ilan eder.
    const dir = mkdtempSync(join(tmpdir(), 'arcpad-contract-gov-'))
    scratch.push(dir)
    const impostor = '0x00000000000000000000000000000000000B0b01'
    const chainKey = (
      JSON.parse(readFileSync(join(BOOK_DIR, 'addresses.31337.json'), 'utf8')) as {
        chainKey: string
        protocolTreasury: string
      }
    ).chainKey
    const fakePath = join(dir, 'governance.json')
    writeFileSync(
      fakePath,
      JSON.stringify({
        [chainKey]: {
          governor: impostor,
          treasury: (REAL_GOVERNANCE[chainKey] as { treasury: string }).treasury,
          owners: [],
          allowedGraduationTargets: [],
        },
      }),
      'utf8',
    )

    // `process.env` UZERINDEN, ARGUMAN NESNESI UZERINDEN DEGIL.
    //
    // Bu testin ilk hali `KEEPER_GOVERNANCE_FILE`i `loadWatcherConfig`in ENV
    // NESNESI argumaninda geciriyordu -- ve `packages/shared` o nesneyi HIC
    // ALMAZ; imzasinda env parametresi yoktur. Yani "yol env ile
    // degistirilemez" iddiasi, ayristirmanin OKUYABILECEGI tek kanali
    // (`process.env`) hic denemiyordu. Olculdu: karsilastirma
    // `process.env['KEEPER_GOVERNANCE_FILE'] || GOVERNANCE_PATH` yapilacak
    // sekilde mutasyona ugratildiginda 136 testin TAMAMI geciyordu.
    //
    // Simdi gercek `process.env` kirletilir; arguman nesnesi ise TEMIZ birakilir
    // ki keeper'in KENDI kapisi once atesleyip testi maskelemesin. Boylece
    // kirmizi olmanin tek yolu, ayristirmanin gercekten process.env'i okumasidir.
    const saved = process.env['KEEPER_GOVERNANCE_FILE']
    let message = ''
    try {
      process.env['KEEPER_GOVERNANCE_FILE'] = fakePath
      loadWatcherConfig({ ARC_CHAIN_ID: '31337' }, bookDirWith({ governor: impostor }))
      message = 'LOADED -- the comparison followed process.env KEEPER_GOVERNANCE_FILE'
    } catch (error) {
      message = String(error)
    } finally {
      if (saved === undefined) delete process.env['KEEPER_GOVERNANCE_FILE']
      else process.env['KEEPER_GOVERNANCE_FILE'] = saved
    }
    expect(
      message,
      'the book<->governance comparison must use a fixed path, not process.env KEEPER_GOVERNANCE_FILE; if env can redirect it, a redirected book can bless its own governor and the startup pin is vacuous',
    ).toMatch(/expected-governance.json/)
    expect(message).not.toContain('LOADED')
  })

  // NOT: bu bloktaki iddia BILEREK `expected-governance.json`i arar,
  // `/governor/i` gibi genis bir kalibi DEGIL. Ilk hali genisti ve test
  // GECIYORDU -- ama sebebi governance karsilastirmasi degil, EIP-55 checksum
  // hatasiydi: sahtekar adres yanlis checksum'luydu. Yani `assertGovernanceAgrees`
  // silinseydi test YINE gecerdi. Kalibi daraltmak bunu aninda ortaya cikardi.
  it('DOGRU governor ile ayni defter YUKLENIR -- kontrol "her zaman reddet" degil', () => {
    expect(() => loadWatcherConfig({ ARC_CHAIN_ID: '31337' }, bookDirWith({}))).not.toThrow()
  })
})

/**
 * BOS/BOSLUK ENV AILESI -- DORDUNCU TUR, ve bu kez TABLO ILE.
 *
 * Ayni sekil dort turda dort kez cikti: `KEEPER_ADDRESS_BOOK_DIR`, sonra
 * `KEEPER_GOVERNANCE_FILE`/`KEEPER_CURSOR_FILE`, sonra `ARC_CHAIN_ID` ve
 * `drill.ts`in iki okumasi, sonra `KEEPER_ALERT_REPEAT_MS`. Her seferinde
 * duzeltme o an bakilan siteye uygulandi ve KARDESLERI atlandi -- yani hata
 * "bir giris noktasinda kapatilan ozellik tumunde kapali sayilir"in ta
 * kendisiydi.
 *
 * Bu blok her degiskeni TEK TEK ve HEM `''` HEM `'   '` ile yurur, boylece
 * bir sonraki ekleme kardeslerini atlayamaz.
 *
 * `KEEPER_ALERT_REPEAT_MS` ozellikle onemliydi: ailenin geri kalani GURULTULU
 * duserken bu SESSIZ basarisiz oluyordu. `Number('   ') === 0`,
 * `Number.isInteger(0)` dogru, `0 < 0` yanlis -> `alertRepeatMs = 0` ->
 * `createThrottle(0)` HICBIR SEYI bastirmaz -> throttle'in var olma sebebi olan
 * gunde ~35.000 sayfa geri gelir, hicbir hata mesaji olmadan.
 */
describe('bos ve BOSLUK env degerleri: her degisken, iki bicim', () => {
  const BLANKS = ['', '   ', '\t'] as const

  it('KEEPER_ALERT_REPEAT_MS bos ya da bosluksa varsayilana duser, 0"a DEGIL', () => {
    for (const blank of BLANKS) {
      const config = loadWatcherConfig(
        { ARC_CHAIN_ID: '31337', KEEPER_ALERT_REPEAT_MS: blank },
        BOOK_DIR,
      )
      expect(config.alertRepeatMs, JSON.stringify(blank)).toBeUndefined()
    }
    // Ve gercek bir deger hala okunur.
    expect(
      loadWatcherConfig({ ARC_CHAIN_ID: '31337', KEEPER_ALERT_REPEAT_MS: '900000' }, BOOK_DIR)
        .alertRepeatMs,
    ).toBe(900_000)
  })

  it('KEEPER_LOG_SCAN_CHUNK bos ya da bosluksa varsayilana duser', () => {
    for (const blank of BLANKS) {
      const config = loadWatcherConfig(
        { ARC_CHAIN_ID: '31337', KEEPER_LOG_SCAN_CHUNK: blank },
        BOOK_DIR,
      )
      expect(config.logScanChunk, JSON.stringify(blank)).toBe(10_000n)
    }
  })

  it('KEEPER_ALERT_LOG bosluksa "ayarlanmamis" sayilir', () => {
    for (const blank of BLANKS) {
      const config = loadWatcherConfig({ ARC_CHAIN_ID: '31337', KEEPER_ALERT_LOG: blank }, BOOK_DIR)
      expect(config.alertLogPath, JSON.stringify(blank)).toBeUndefined()
    }
  })

  // AYNI DEGISKEN, IKI GIRIS NOKTASI. `drill.ts` bunu `blankToUndefined` ile
  // okuyordu, `loadKeeperConfig` ham okuyordu -- ve `index.ts` ikincisini
  // cagirir, yani `.env.example`in "bos birak" ogretisini izleyen bir operator
  // icin izleyici HIC BASLAMIYORDU.
  it('KEEPER_POLL_INTERVAL_MS her IKI giris noktasinda da bosluga dayanikli', () => {
    for (const blank of BLANKS) {
      const config = loadKeeperConfig({
        ARC_RPC_URL: 'https://rpc.testnet.arc.io',
        KEEPER_POLL_INTERVAL_MS: blank,
      })
      expect(config.pollIntervalMs, JSON.stringify(blank)).toBe(5_000)
    }
    // Gecersiz ama BOS OLMAYAN deger hala ALANI ADIYLA duser.
    expect(() =>
      loadKeeperConfig({
        ARC_RPC_URL: 'https://rpc.testnet.arc.io',
        KEEPER_POLL_INTERVAL_MS: 'soon',
      }),
    ).toThrow(/KEEPER_POLL_INTERVAL_MS/)
  })

  it('ARC_RPC_URL bosluksa ADIYLA reddedilir, sessizce gecmez', () => {
    for (const blank of BLANKS) {
      expect(() => loadKeeperConfig({ ARC_RPC_URL: blank }), JSON.stringify(blank)).toThrow(
        /ARC_RPC_URL/,
      )
    }
  })

  it('ARC_CHAIN_ID bosluksa varsayilan zincire duser, 0"a DEGIL', () => {
    for (const blank of BLANKS) {
      let message = ''
      try {
        loadWatcherConfig({ ARC_CHAIN_ID: blank }, BOOK_DIR)
      } catch (error) {
        message = String(error)
      }
      // Varsayilan Arc testnet zinciri aranir; `addresses.0.json` ASLA.
      expect(message, JSON.stringify(blank)).not.toContain('addresses.0.json')
    }
  })
})

describe('resolveFromRepoRoot', () => {
  it('ayarlanmamis yol undefined kalir', () => {
    expect(resolveFromRepoRoot(undefined)).toBeUndefined()
  })

  it('mutlak yola DOKUNMAZ', () => {
    const absolute = join(tmpdir(), 'alerts.log')
    expect(resolveFromRepoRoot(absolute)).toBe(absolute)
  })

  it('goreli yolu DEPO KOKUNE gore cozer, cwd"ye DEGIL', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(REPO_ROOT, 'keeper'))
    try {
      expect(resolveFromRepoRoot('keeper/alerts.log')).toBe(resolve(REPO_ROOT, 'keeper/alerts.log'))
    } finally {
      cwd.mockRestore()
    }
  })

  it('REPO_ROOT gercekten depo kokudur', () => {
    // `<root>/keeper/package.json` oradan gorulmeli.
    expect(readFileSync(join(REPO_ROOT, 'keeper', 'package.json'), 'utf8')).toContain(
      '@arcpad/keeper',
    )
  })
})

/**
 * IKI GIRIS NOKTASI, TEK DOSYA.
 *
 * Keeper `$KEEPER_ALERT_LOG`a YAZAR (`loadWatcherConfig().alertLogPath`),
 * tatbikat AYNI degiskenden OKUR (`drillSinkPath`). Ayristiklarinda ariza
 * SESSIZ DEGIL, TERSINE olur: tatbikat "there was no watcher" der -- yani
 * CALISAN bir izleyiciyi olu ilan eder ve rota'yi yanlis runbook daline
 * gonderir. OLCULDU: yazan taraf duzeltilip okuyan taraf birakildiginda,
 * icinde alti kalp atisi olan bir lavaboya karsi tatbikat tam olarak bunu
 * soyledi.
 */
describe('alarm lavabosu yolu: keeper ve tatbikat AYNI dosyayi secer', () => {
  const base = { ARC_CHAIN_ID: '31337', KEEPER_GOVERNANCE_FILE: GOVERNANCE }

  it.each([
    'keeper/alerts.log',
    'alerts.log',
    './keeper/alerts.log',
    join(tmpdir(), 'arcpad-abs-alerts.log'),
  ])('%s -> iki taraf da ayni yolu verir', (value) => {
    const env = { ...base, KEEPER_ALERT_LOG: value }
    expect(drillSinkPath(env)).toBe(loadWatcherConfig(env, BOOK_DIR).alertLogPath)
  })

  it('ayarlanmamis ve bosluk: iki taraf da undefined', () => {
    for (const blank of ['', ' ', '\t']) {
      const env = { ...base, KEEPER_ALERT_LOG: blank }
      expect(drillSinkPath(env), JSON.stringify(blank)).toBeUndefined()
      expect(loadWatcherConfig(env, BOOK_DIR).alertLogPath).toBeUndefined()
    }
    expect(drillSinkPath({ ...base })).toBeUndefined()
  })
})
