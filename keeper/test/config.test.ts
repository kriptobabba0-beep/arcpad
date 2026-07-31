import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadKeeperConfig, loadWatcherConfig } from '../src/config'

describe('loadKeeperConfig', () => {
  it('gecerli ortamdan yapilandirma uretir', () => {
    const config = loadKeeperConfig({
      ARC_RPC_URL: 'https://rpc.testnet.arc.io',
      KEEPER_POLL_INTERVAL_MS: '2000',
      KEEPER_DRY_RUN: 'false',
    })
    expect(config).toEqual({
      rpcUrl: 'https://rpc.testnet.arc.io',
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
    expect(config.alertLogPath).toBe('keeper/alerts.log')
    expect(config.alertRepeatMs).toBe(900_000)
  })

  // Uretimde varsayilan (contracts/deploy) dogru olandir. Bu knob staging
  // defterlerine karsi kosmak ve izleyiciyi GERCEK bir surec olarak sahte bir
  // zincire karsi kirabilmek icin var -- loop-level tatbikat onu kullanir.
  const FACTORY = '0xeeaE42fa79dA76cF5186CE47e5c66BF496DF66f3'

  it('defter dizini env uzerinden verilebilir, ve arguman env i EZER', () => {
    const redirected = { ...base, KEEPER_ADDRESS_BOOK_DIR: BOOK_DIR, ARC_FACTORY_ADDRESS: FACTORY }
    expect(loadWatcherConfig(redirected).startBlock).toBe(1n)
    expect(() =>
      loadWatcherConfig({ ...base, KEEPER_ADDRESS_BOOK_DIR: 'nope', ARC_FACTORY_ADDRESS: FACTORY }),
    ).toThrow(/file/)
    // Arguman verildiginde env yok sayilir.
    expect(loadWatcherConfig({ ...base, KEEPER_ADDRESS_BOOK_DIR: 'nope' }, BOOK_DIR).chainKey).toBe(
      'local-rehearsal',
    )
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
    expect(() => loadWatcherConfig({ ...base, KEEPER_ADDRESS_BOOK_DIR: BOOK_DIR })).toThrow(
      /ARC_FACTORY_ADDRESS must also be set/,
    )
    expect(() =>
      loadWatcherConfig({
        ...base,
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
