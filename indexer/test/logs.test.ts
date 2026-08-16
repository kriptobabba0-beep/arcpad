import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { decodeEventLog } from 'viem'
import { bondingCurveAbi } from '@arcpad/shared/browser'
import { toSeq } from '@arcpad/db'
import { TOPIC0 } from '../src/arc'
import type { DecodedEvent, PacerClock, RawLog, WatchSet } from '../src/logs'
import {
  createAddressWidthMemo,
  createPacer,
  DECODERS,
  decodeAll,
  fetchRange,
  ForbiddenEmitter,
  getLogsChunked,
  LogOutOfRange,
  MalformedLog,
  MissingTimestamp,
  RemovedLog,
  SingleBlockTooLarge,
  UnorderedLogs,
} from '../src/logs'
import {
  AWAITING_FIXTURE,
  constructedGraduatedLog,
  FakeNode,
  fixtureNames,
  LIVE,
  loadAllFixtures,
  loadFixtureFile,
  loadSmoke,
  rawLogs,
  smokeLogs,
} from './fixtures'

/**
 * Yerel fixture'larin adresleri, FIXTURE'IN KENDISINDEN TURETILIR.
 *
 * ELLE YAZILMISLARDI VE KIRILDILAR: `contracts/` tarafindaki bir degisiklik
 * fixture'lari yeniden uretti, Foundry'nin deterministik adresleri kaydi ve
 * bu dosyadaki dort sabit birden bayatladi (`fetchRange` bos dondu, cunku
 * adres filtresi artik hicbir seyle eslesmiyordu). Adresler artik loglardan
 * OKUNUYOR: `Launched`in yayincisi factory, topic'leri token ve curve,
 * `Deposited`in yayincisi escrow. Bir sonraki yeniden uretim bu testleri
 * kirmaz -- kirmasi da gerekmez, cunku olculen sey adresler degil DAVRANIS.
 */
/**
 * YURUTULEBILIR SANAL SAAT -- pacer'in zamanlama testleri bunun altinda kosar.
 *
 * UC YAKLASIM DENENDI, IKISI OLCULEREK ELENDI:
 *
 *   (1) GERCEK SAAT (ilk hal). Gecikme gercektir ama OLCULEMEZ: testin
 *       gordugu bosluk makine yukune baglidir. `pnpm -r --no-bail test` bes
 *       paketin test surecini ayni CPU'da kosturunca
 *       `minIntervalMs es zamanli slotlar arasinda da bosluk koyar` KIRMIZI
 *       oldu; TEK BASINA yesildi. Pacer kusursuz calisiyordu. 3ms'lik pay
 *       normal jitter'i yutuyor, yuk altindakini yutmuyordu -- ve payi
 *       buyutmek yanlis cevap: yeterince buyuk bir pay, araligin TAMAMEN
 *       kaybolmasini da kabul eder.
 *
 *   (2) SAHTE ZAMANLAYICI (`vi.useFakeTimers`). Deterministik, ama VAKUMLU:
 *       `setTimeout` TAM zamaninda atesledigi icin "gec atesleme" hic olusmaz
 *       ve `begin()` icindeki ikinci `nextEarliest` ilerletmesi -- yalnizca o
 *       durum icin var olan satir -- gozlemlenemez hale gelir. MUTASYONLA
 *       OLCULDU: o satiri silmek, sahte saat altindaki 70 testin HEPSINI
 *       yesil biraktı. Kusuru insaen gorunmez kilan bir test, kirmizi olmayan
 *       bir testten kotudur.
 *
 *   (3) BU. Zaman pacer'a ENJEKTE edilir, yani gecikme testin KURDUGU bir sey
 *       olur: `lateness` her `schedule` cagrisina kac ms gecikme eklenecegini
 *       soyler. Gecikme GERCEKTEN olusur (sahte zamanlayicinin kaciridigi sey)
 *       ve DETERMINISTIKTIR (gercek saatin veremedigi sey). Ayni mutant bu
 *       saatin altinda OLUR -- `test_gecAtesleyenZamanlayici...` onu yurur.
 *
 * Pay KALKTI ve iddialar `> interval - 3`ten `>= interval`e SIKILASTI: artik
 * olculen sey makinenin degil pacer'in davranisidir, dolayisiyla tam esitlik
 * iddia edilebilir.
 */
function virtualClock(opts?: { lateness?: (nth: number) => number }): {
  clock: PacerClock
  drain: () => Promise<void>
  sleep: (ms: number) => Promise<void>
} {
  let now = 0
  let nth = 0
  const pending: { at: number; fn: () => void }[] = []

  const clock: PacerClock = {
    now: () => now,
    schedule(fn, ms) {
      // GECIKME BURADA EKLENIR, `ms`e DEGIL VARIS ANINA: gercek bir olay
      // dongusu de boyle davranir -- planlanan sure dogrudur, ates GEC olur.
      const late = opts?.lateness?.(nth++) ?? 0
      pending.push({ at: now + ms + late, fn })
    },
  }

  // `setImmediate` GERCEKTIR ve olmasi gerekir: sanal saat ZAMANI yonetir,
  // microtask kuyrugunu degil. Bir `resolve()`den sonra govdenin calismasi
  // icin olay dongusunun bir tur donmesi gerekir ve `await Promise.resolve()`
  // zincirlenmis await'ler icin YETMEZ.
  const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

  return {
    clock,
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        clock.schedule(r, ms)
      }),
    async drain(): Promise<void> {
      for (let guard = 0; guard < 10_000; guard += 1) {
        await flush()
        if (pending.length === 0) return
        pending.sort((a, b) => a.at - b.at)
        const next = pending.shift()
        if (!next) return
        now = Math.max(now, next.at)
        next.fn()
      }
      throw new Error('virtualClock.drain: 10.000 turda bosalmadi -- sonsuz dongu')
    },
  }
}

function fixtureAddresses(): { factory: Address; escrow: Address; curve: Address; token: Address } {
  const launch = loadFixtureFile('launch')
  const launched = launch.logs.find((l) => l.topics[0] === TOPIC0.launched)
  if (launched === undefined) throw new Error('launch.json icinde Launched yok')
  const buy = loadFixtureFile('buy_exact_tokens_out')
  const deposited = buy.logs.find((l) => l.topics[0] === TOPIC0.deposited)
  if (deposited === undefined) throw new Error('buy fixture icinde Deposited yok')
  return {
    factory: launched.address.toLowerCase() as Address,
    token: `0x${launched.topics[1]!.slice(26)}`.toLowerCase() as Address,
    curve: `0x${launched.topics[2]!.slice(26)}`.toLowerCase() as Address,
    escrow: deposited.address.toLowerCase() as Address,
  }
}

const FIX = fixtureAddresses()

const EMPTY_WATCH: WatchSet = {
  factory: FIX.factory,
  escrow: FIX.escrow,
  curves: new Set(),
  tokens: new Set(),
  curveToToken: new Map(),
  pools: new Map(),
}

const LAUNCH_BLOCK = 54_661_437n
const BUY_BLOCK = LAUNCH_BLOCK + 1n

function launchAndBuy(): RawLog[] {
  return [
    ...rawLogs('launch', { block: LAUNCH_BLOCK }),
    ...rawLogs('buy_exact_tokens_out', { block: BUY_BLOCK }),
  ]
}

function kinds(events: readonly DecodedEvent[]): string[] {
  return events.map((e) => e.kind)
}

// ---------------------------------------------------------------------------
// Kapsam -- "bir olayi kapsamak hepsini kapsamis gibi okunmaz"
// ---------------------------------------------------------------------------

describe('kapsam', () => {
  // (a) Handler kumesi.
  it('handler kumesi ile dinlenen olay kumesi iki yonlu ayni', () => {
    expect(Object.keys(DECODERS).sort()).toEqual([
      // Buyback nesli: bes olay, iki kontrat. Ucu hazineden (tahakkuk,
      // supurme, geri katlama), ikisi kasadan (kilit, dagitim).
      'buybackAccrued',
      'buybackExecuted',
      'buybackLocked',
      'buybackSkipped',
      'claimed',
      'completed',
      'deposited',
      'graduated',
      'launched',
      'poolFee',
      'poolInitialize',
      'poolSwap',
      'trade',
      'transfer',
      'vestingReleased',
    ])
  })

  // (b) (a) BUNU KAPSAMAZ: bir handler yazilip hic cagrilmadan da (a) yesil
  //     kalir.
  //
  //     `AWAITING_FIXTURE` GERCEK BIR EKSIKLIKTIR ve boyle okunmalidir: o
  //     olaylarin cozucusu bir FIXTURE tarafindan degil, ABI'den KURULMUS bir
  //     logla ve viem'in ABI cozucusune karsi diferansiyel olarak egzersiz
  //     edilir (asagida, "kurulmus Graduated"). Muafiyetin olu kalmasi
  //     `topics.test.ts`teki es testle imkansizdir.
  it('her handler en az bir fixture tarafindan egzersiz edilir', async () => {
    const seen = new Set((await loadAllFixtures()).flatMap((f) => f.events.map((e) => e.kind)))
    const expected = Object.keys(DECODERS)
      .filter((k) => AWAITING_FIXTURE[k] === undefined)
      .sort()
    expect([...seen].sort()).toEqual(expected)
    // Muafiyetin BOS OLMADIGI da olculur: liste bosalirsa yukaridaki filtre
    // hicbir sey yapmaz ve bu satir onu soyler. LISTE TAM YAZILIR, uzunluk
    // degil: bir olayin muaf oldugunu FARK ETMEDEN eklemek, tam olarak bu
    // satirin engelledigi sey.
    expect(Object.keys(AWAITING_FIXTURE).sort()).toEqual([
      'graduated',
      'poolFee',
      'poolInitialize',
      'poolSwap',
    ])
  })

  // (c) (a) ve (b) BUNU KAPSAMAZ: tek bir `Trade` fixture'i ikisini de yesil
  //     yapar ama `Trade` UC giris noktasindan ve DORT yoldan yayilir. Bu
  //     iddia yeni bir giris noktasi eklenip fixture yazilmadiginda kirilir --
  //     yani boslugu KAPSAMDA degil SECIMDE aramak calistirilabilir olur.
  it('fixture senaryo kumesi tam', () => {
    expect(fixtureNames()).toEqual([
      'buy_exact_quote_in',
      'buy_exact_quote_in_clamped',
      'buy_exact_tokens_out',
      // Buyback nesli: supurme (harcama) ve geri katlama, IKI AYRI senaryo.
      // Tek islemde ikisi birden uretilemez -- supurme ya harcar ya katlar.
      // SIRA ASCII'YE GORE: '_' (0x5F) 'b'den (0x62) kucuktur, yani
      // `buy_exact_*` `buyback`ten ONCE gelir.
      'buyback',
      'buyback-skipped',
      'claim',
      'forged',
      'launch',
      'sell',
      'zero_creator',
    ])
  })
})

// ---------------------------------------------------------------------------
// Iki fazli cekis
// ---------------------------------------------------------------------------

describe('iki fazli cekis', () => {
  it('AYNI aralikta acilan bir launch in mint Transfer i ve Trade i dusmez', async () => {
    const node = new FakeNode(launchAndBuy())
    const events = await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)

    expect(kinds(events)).toEqual([
      'transfer', // mint -- `Launched`'DAN ONCE yayilir
      'launched',
      'trade',
      'transfer',
      'deposited',
      'deposited',
    ])
    const mint = events[0]
    if (mint?.kind !== 'transfer') throw new Error('ilk olay transfer degil')
    expect(mint.token).toBe(FIX.token)
    expect(mint.amountTok).toBe(10n ** 27n)
  })

  // NEGATIF KONTROL. Ustteki test, sahte dugumun comert olmasiyla degil
  // FAZ 1.5 ile yesil oluyor: `Launched` cekilemedigi anda token adresi
  // ogrenilemez ve mint `Transfer`'i de gelmez.
  it('Launched cekilemezse mint Transfer i de gelmez (tek fazli tasarimin arizasi)', async () => {
    const withoutLaunched = launchAndBuy().filter((l) => l.topics[0] !== TOPIC0.launched)
    const node = new FakeNode(withoutLaunched)
    const events = await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)
    expect(kinds(events)).toEqual(['deposited', 'deposited'])
  })

  it('once bilinen bir token icin Transfer ler ilk fazi beklemeden gelir', async () => {
    const node = new FakeNode(launchAndBuy())
    const watch: WatchSet = {
      ...EMPTY_WATCH,
      curves: new Set([FIX.curve]),
      tokens: new Set([FIX.token]),
      curveToToken: new Map(),
      pools: new Map(),
    }
    const events = await fetchRange(node, watch, BUY_BLOCK, BUY_BLOCK)
    expect(kinds(events)).toEqual(['trade', 'transfer', 'deposited', 'deposited'])
  })

  it('Launched YALNIZCA factory adresinden sorulur', async () => {
    const node = new FakeNode(launchAndBuy())
    await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)
    const launchedQuery = node.logFilters.find(
      (f) => JSON.stringify(f['topics']) === JSON.stringify([TOPIC0.launched]),
    )
    expect(launchedQuery?.['address']).toBe(FIX.factory)
  })

  // `forged.json`: GERCEK `topic0`, sahte yayinci. Adres filtresi RPC
  // tarafinda oldugu icin log HIC CEKILMEZ.
  it('sahte bir factory nin Launched i hic cekilmez', async () => {
    const node = new FakeNode(rawLogs('forged', { block: LAUNCH_BLOCK }))
    const events = await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, LAUNCH_BLOCK)
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EIP-7708 duvari
// ---------------------------------------------------------------------------

describe('EIP-7708 duvari', () => {
  const smoke = loadSmoke()
  const logs = smokeLogs()
  const first = BigInt(logs[0]!.blockNumber)
  const last = BigInt(logs[logs.length - 1]!.blockNumber)
  const liveWatch: WatchSet = {
    factory: LIVE.factory,
    escrow: LIVE.escrow,
    curves: new Set(),
    tokens: new Set(),
    curveToToken: new Map(),
    pools: new Map(),
  }

  it('adres filtresi uygulanan CANLI aralikta hicbir 7708 logu gelmez', async () => {
    const node = new FakeNode(logs)
    const events = await fetchRange(node, liveWatch, first, last)
    // 31 canli logun 12'si 7708'dir; geriye 19 sozlesme logu kalir.
    expect(logs).toHaveLength(31)
    expect(events).toHaveLength(19)
    expect(kinds(events).filter((k) => k === 'transfer')).toHaveLength(5)
  })

  // DELIVERABLE'IN OLCUMU: `Transfer` sorgusundan `address` dustugunde.
  it('adres filtresi DUSERSE ForbiddenEmitter firlar', async () => {
    const node = new FakeNode(logs, { ignoreAddressFilter: true })
    await expect(fetchRange(node, liveWatch, first, last)).rejects.toThrow(ForbiddenEmitter)
  })

  it('firlatilan hata yayinciyi ISIMLE soyler', async () => {
    const node = new FakeNode(logs, { ignoreAddressFilter: true })
    const error = await fetchRange(node, liveWatch, first, last).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForbiddenEmitter)
    expect((error as ForbiddenEmitter).emitter).toBe(smoke.nativeTransferEmitter)
  })

  // `0x3600...0000` AYNI hareketin 6 decimal gorunumudur ve canli smoke'ta
  // gorunmuyor (ERC-20 giris noktasi kullanilmadi). Duvar yine de onu
  // tanimali: yuk OLCULMUS bir 7708 logundan alinip yayinci degistiriliyor.
  it('USDC nin 6 decimal ERC-20 gorunumu de reddedilir', async () => {
    const native = logs.find((l) => l.address === smoke.nativeTransferEmitter)
    if (native === undefined) throw new Error('canli makbuzda 7708 logu yok')
    const sixDecimalView: RawLog = {
      ...native,
      address: '0x3600000000000000000000000000000000000000',
    }
    await expect(
      decodeAll(new FakeNode([]), [sixDecimalView], 0n, 10n ** 12n, createPacer()),
    ).rejects.toThrow(ForbiddenEmitter)
  })

  it('her Transfer sorgusu bir adres filtresi tasir', async () => {
    const node = new FakeNode(logs)
    await fetchRange(node, liveWatch, first, last)
    const transferQueries = node.logFilters.filter(
      (f) => JSON.stringify(f['topics']) === JSON.stringify([TOPIC0.transfer]),
    )
    expect(transferQueries.length).toBeGreaterThan(0)
    for (const q of transferQueries) expect(q['address']).toBeDefined()
  })

  // BOS ADRES LISTESI SORULMAZ. `address: []` bazi dugumlerde "filtre yok"
  // demektir ve o an butun 7708 loglarini getirirdi.
  it('bos adres listesi icin HIC sorgu yapilmaz', async () => {
    const node = new FakeNode(logs)
    const out = await getLogsChunked(node, [], [TOPIC0.transfer], first, last, createPacer())
    expect(out).toEqual([])
    expect(node.requests).toEqual([])
  })

  it('adres listesi ADDRESS_FILTER_CHUNK parcalarina bolunur', async () => {
    const node = new FakeNode([])
    const many = Array.from(
      { length: 1201 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address,
    )
    await getLogsChunked(node, many, [TOPIC0.transfer], 1n, 2n, createPacer())
    expect(node.logFilters).toHaveLength(3)
    expect((node.logFilters[0]!['address'] as string[]).length).toBe(500)
    expect((node.logFilters[2]!['address'] as string[]).length).toBe(201)
  })

  // -------------------------------------------------------------------------
  // IKINCI EKSEN: TEK BIR BLOK TASINCA ADRES FILTRESI KUCULUR
  // -------------------------------------------------------------------------

  const addressAt = (i: number): Address => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address

  /** Tek blokta, adres basina tek `Transfer` logu. */
  function oneBlockLogs(count: number, block = 5n, perAddress = 1): RawLog[] {
    const out: RawLog[] = []
    for (let a = 0; a < count; a += 1) {
      for (let k = 0; k < perAddress; k += 1) {
        out.push({
          address: addressAt(a),
          topics: [TOPIC0.transfer],
          data: '0x',
          blockNumber: `0x${block.toString(16)}`,
          logIndex: `0x${out.length.toString(16)}`,
          transactionHash: `0x${'11'.repeat(32)}`,
        })
      }
    }
    return out
  }

  /**
   * `SingleBlockTooLarge`'in KENDI yorumu kurtarmayi yaziyordu ("adres
   * filtresini bolmek gerekir") ve hicbir yerde UYGULANMAMISTI: adi KALICI
   * kumede, yani tek bir sicak blok ingest'i kalici olarak durduruyordu.
   * Bugunku hacimde ulasilamaz; BIR LAUNCH GUNU ulasilir.
   */
  it('tek blok tasarsa ADRES FILTRESI yarilanir ve tarama TAMAMLANIR', async () => {
    // 8 adres, blok 5'te 8 log; dugum 2'den fazlasini reddediyor.
    const node = new FakeNode(oneBlockLogs(8), { maxResults: 2 })
    const out = await getLogsChunked(
      node,
      Array.from({ length: 8 }, (_, i) => addressAt(i)),
      [TOPIC0.transfer],
      5n,
      5n,
      createPacer(),
      8,
    )
    // HICBIR LOG KAYBOLMADI -- kurtarma "daralt ve devam et", "atla" degil.
    expect(out).toHaveLength(8)
    const widths = node.logFilters.map((f) => (f['address'] as string[]).length)
    // 8 (ret) -> 4 (ret) -> 2 ... ve YAPISKAN: kalan parcalar da 2'lik.
    expect(widths).toEqual([8, 4, 2, 2, 2, 2])
  })

  /**
   * ============ ROUND 7: DARALMA CAGRILAR ARASINDA DA TASINIR ============
   *
   * Yukaridaki iki test daralmayi TEK BIR CAGRI icinde olcuyor ve geciyordu.
   * CANLI kompozisyonda (proxy + gercek zincir + 41 adreslik izleme kumesi)
   * olculen sey baskaydi:
   *
   *   blok N   : 41 RED, 20 RED, 10 RED, 5 kabul, 5 x8 ...
   *   blok N+1 : 41 RED, 20 RED, 10 RED, 5 kabul, ...    <-- BASTAN
   *
   * Genislik bir YEREL degiskendi, yani her aralik duvari yeniden kesfediyor
   * ve parcali sorgu basina UC bosa istek harciyordu. Olculen endpoint uc
   * bosluksuz `eth_getLogs`ta hiz sinirini tetikliyor: canli kosumda indexer
   * bu yuzden 5/8. denemede bekliyordu. Keeper'in "yakinsamayan tarama"
   * wedge'iyle ayni sekil.
   */
  it('OGRENILEN genislik SONRAKI cagriya tasinir -- duvar bir kez kesfedilir', async () => {
    const memo = createAddressWidthMemo()
    const addresses = Array.from({ length: 8 }, (_, i) => addressAt(i))
    const first = new FakeNode(oneBlockLogs(8), { maxResults: 2 })
    await getLogsChunked(first, addresses, [TOPIC0.transfer], 5n, 5n, createPacer(), 8, memo)
    expect(first.logFilters.map((f) => (f['address'] as string[]).length)).toEqual([
      8, 4, 2, 2, 2, 2,
    ])
    expect(memo.width).toBe(2)

    // IKINCI ARALIK: ayni cagri, ayni memo. Duvar YENIDEN kesfedilmez.
    const second = new FakeNode(oneBlockLogs(8, 6n), { maxResults: 2 })
    await getLogsChunked(second, addresses, [TOPIC0.transfer], 6n, 6n, createPacer(), 8, memo)
    const widths = second.logFilters.map((f) => (f['address'] as string[]).length)
    expect(widths).toEqual([2, 2, 2, 2])
    // Ve BOSA GIDEN ISTEK YOK: her sorgu kabul edildi.
    expect(widths.some((w) => w > 2)).toBe(false)
  })

  it('memo MONOTONDUR: genis bir cagri onu geri buyutemez', async () => {
    const memo = createAddressWidthMemo()
    memo.width = 2
    const node = new FakeNode(oneBlockLogs(8), { maxResults: 100 })
    await getLogsChunked(
      node,
      Array.from({ length: 8 }, (_, i) => addressAt(i)),
      [TOPIC0.transfer],
      5n,
      5n,
      createPacer(),
      8,
      memo,
    )
    // Cagiran 8 istedi, memo 2 diyor -> 2 kazanir, ve hicbir ret olmadigi
    // halde memo BUYUMEZ.
    expect(node.logFilters.map((f) => (f['address'] as string[]).length)).toEqual([2, 2, 2, 2])
    expect(memo.width).toBe(2)
  })

  it('memo VERILMEZSE davranis eskisi gibi kalir -- cagri basina unutulur', async () => {
    const addresses = Array.from({ length: 8 }, (_, i) => addressAt(i))
    const a = new FakeNode(oneBlockLogs(8), { maxResults: 2 })
    await getLogsChunked(a, addresses, [TOPIC0.transfer], 5n, 5n, createPacer(), 8)
    const b = new FakeNode(oneBlockLogs(8, 6n), { maxResults: 2 })
    await getLogsChunked(b, addresses, [TOPIC0.transfer], 6n, 6n, createPacer(), 8)
    // Ikinci cagri 8'den BASLAR: bu, canlida olculen kusurun ta kendisi ve
    // burada bilerek pinlenmis -- memo'yu gecirmeyi unutan bir cagri yeri
    // sessizce eski maliyeti geri getirir.
    expect((b.logFilters[0]!['address'] as string[]).length).toBe(8)
  })

  it('daralma MONOTON: bir kez kuculen filtre cagri boyunca geri buyumez', async () => {
    const node = new FakeNode(oneBlockLogs(4), { maxResults: 1 })
    await getLogsChunked(
      node,
      Array.from({ length: 4 }, (_, i) => addressAt(i)),
      [TOPIC0.transfer],
      5n,
      5n,
      createPacer(),
      4,
    )
    const widths = node.logFilters.map((f) => (f['address'] as string[]).length)
    expect(widths).toEqual([4, 2, 1, 1, 1, 1])
  })

  /**
   * VE EKSEN TUKENEBILIR. Tek adres tek blokta bile tasiyorsa yapacak bir sey
   * kalmaz -- ama hata artik BUNU soyler, cunku caresi baskadir (topic ekseni
   * ya da baska bir saglayici) ve eski mesaj hala "adres filtresini bolmek
   * gerekir" diyerek YAPILMIS olan seyi oneriyordu.
   */
  it('tek adres tek blokta bile tasarsa FIRLATIR ve eksenin tukendigini soyler', async () => {
    const node = new FakeNode(oneBlockLogs(1, 5n, 3), { maxResults: 2 })
    await expect(
      getLogsChunked(node, [addressAt(0)], [TOPIC0.transfer], 5n, 5n, createPacer(), 1),
    ).rejects.toThrow(/adres bolme \(1 adrese kadar\) tukendi/)
  })

  /**
   * DARALMA BU SINIFA OZELDIR. Genel bir yeniden deneme, aralik disi her
   * hatayi da sessizce maskelerdi (keeper'in M42 mutanti tam olarak budur).
   */
  it('aralik DISI bir hata daraltilmaz: tek deneme, sonra firlatir', async () => {
    const node = new FakeNode(oneBlockLogs(4), { maxResults: 1, errorCode: -32601 })
    await expect(
      getLogsChunked(
        node,
        Array.from({ length: 4 }, (_, i) => addressAt(i)),
        [TOPIC0.transfer],
        5n,
        5n,
        createPacer(),
        4,
      ),
    ).rejects.toThrow(/limited to a 10,000 range|method/)
    expect(node.logFilters).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// RPC hata taksonomisi
// ---------------------------------------------------------------------------

describe('RPC hata taksonomisi', () => {
  const logs = smokeLogs()
  const first = BigInt(logs[0]!.blockNumber)
  const last = BigInt(logs[logs.length - 1]!.blockNumber)
  const liveWatch: WatchSet = {
    factory: LIVE.factory,
    escrow: LIVE.escrow,
    curves: new Set(),
    tokens: new Set(),
    curveToToken: new Map(),
    pools: new Map(),
  }

  // Ucu de ayri ayri: tek bir kodu yakalayan bir retry, obur ikisinde imleci
  // ilerletmeden SONSUZ doner.
  for (const code of [-32602, -32012, -32614]) {
    it(`${code} bolunerek asilir ve hicbir log kaybolmaz`, async () => {
      const node = new FakeNode(logs, { maxResults: 2, errorCode: code })
      const events = await fetchRange(node, liveWatch, first, last)
      expect(events).toHaveLength(19)
      expect(node.logFilters.length).toBeGreaterThan(4)
    })
  }

  it('-32602 nin ONERDIGI araliktan bolunur', async () => {
    const node = new FakeNode(logs, { maxResults: 2, errorCode: -32602 })
    await fetchRange(node, liveWatch, first, last)
    // Sunucu "retry with the range from-(from+to)/2" oneriyor; ilk bolme
    // TAM ORADAN olmali -- yani ikinci sorgunun `toBlock`'u onerinin ust
    // sinirini tasimali.
    const suggested = first + (last - first) / 2n
    const tos = node.logFilters.map((f) => BigInt(f['toBlock'] as Hex))
    expect(tos).toContain(suggested)
  })

  // BRIEF'IN KOSULSUZ HALININ SONSUZ DONGUSU. Sunucu araligi KUCULTMEYEN bir
  // oneri verdiginde (B >= to) oneriye uymak ayni sorguyu tekrarlardi.
  it('araligi kucultmeyen bir oneri ikiye bolmeye duser', async () => {
    class SillySuggestion extends FakeNode {
      override async request(args: { method: string; params?: unknown }): Promise<unknown> {
        if (args.method === 'eth_getLogs') {
          const [filter] = args.params as [Record<string, unknown>]
          const from = BigInt(filter['fromBlock'] as Hex)
          const to = BigInt(filter['toBlock'] as Hex)
          this.requests.push({ method: args.method, params: args.params })
          if (to > from) {
            throw Object.assign(
              new Error(`query exceeds max results 20000, retry with the range ${from}-${to}`),
              { code: -32602 },
            )
          }
          return []
        }
        return super.request(args)
      }
    }
    const node = new SillySuggestion([])
    const events = await fetchRange(
      node,
      { ...liveWatch, tokens: new Set([LIVE.token]) },
      first,
      first + 7n,
    )
    expect(events).toEqual([])
    // Sonsuz donmedi: her sorgu araligi gercekten yariladi.
    expect(node.requests.length).toBeLessThan(200)
  })

  it('TEK BIR BLOK sinirini asarsa SingleBlockTooLarge', async () => {
    const node = new FakeNode(logs, { maxResults: 0, errorCode: -32602 })
    await expect(fetchRange(node, liveWatch, first, first)).rejects.toThrow(SingleBlockTooLarge)
  })

  it('taninmayan bir RPC hatasi OLDUGU GIBI yukari cikar', async () => {
    const node = new FakeNode(logs)
    const boom = Object.assign(new Error('nonce too low'), { code: -32000 })
    const failing = {
      request: () => Promise.reject(boom),
    }
    await expect(fetchRange(failing, liveWatch, first, last)).rejects.toThrow('nonce too low')
    expect(node.requests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Yanit uzerindeki dort sert iddia
// ---------------------------------------------------------------------------

describe('yanit uzerindeki sert iddialar', () => {
  it('removed=true DURDURUR (Arc ta reorg yoktur)', async () => {
    const node = new FakeNode(launchAndBuy(), { removed: true })
    await expect(fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)).rejects.toThrow(RemovedLog)
  })

  it('aralik disindaki bir log DURDURUR', async () => {
    const logs = rawLogs('launch', { block: LAUNCH_BLOCK })
    await expect(
      decodeAll(new FakeNode([]), logs, LAUNCH_BLOCK + 1n, LAUNCH_BLOCK + 2n, createPacer()),
    ).rejects.toThrow(LogOutOfRange)
  })

  it('sirasi bozulmus bir yanit UnorderedLogs firlatir', async () => {
    const node = new FakeNode(launchAndBuy(), { reverse: true })
    await expect(fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)).rejects.toThrow(
      UnorderedLogs,
    )
  })

  it('ayni log iki kez gelirse DURDURUR', async () => {
    const logs = rawLogs('launch', { block: LAUNCH_BLOCK })
    const doubled = [logs[0]!, logs[0]!]
    await expect(
      decodeAll(new FakeNode([]), doubled, LAUNCH_BLOCK, LAUNCH_BLOCK, createPacer()),
    ).rejects.toThrow(UnorderedLogs)
  })

  it('cikti event_seq e gore SIRALIDIR (dort sorgunun birlesimi sirali gelmez)', async () => {
    const node = new FakeNode(smokeLogs())
    const logs = smokeLogs()
    const events = await fetchRange(
      node,
      {
        factory: LIVE.factory,
        escrow: LIVE.escrow,
        curves: new Set(),
        tokens: new Set(),
        curveToToken: new Map(),
        pools: new Map(),
      },
      BigInt(logs[0]!.blockNumber),
      BigInt(logs[logs.length - 1]!.blockNumber),
    )
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1)))
    // Ve gercekten karisik geliyorlar: tek bir sorgunun ciktisi olsalardi
    // siralama bedava olurdu.
    expect(new Set(events.map((e) => e.kind)).size).toBeGreaterThan(3)
  })

  describe('blockTimestamp yedegi', () => {
    const stripped = rawLogs('launch', { block: LAUNCH_BLOCK, stripTimestamp: true })
    // Fixture'daki log SAYISI `contracts/` tarafindan degisebilir (degisti de:
    // `FeeScheduleAssigned` eklendi). Iddia sayidan degil ORANDAN kuruluyor:
    // kac log olursa olsun, TEK bir blok icin TEK bir ek cagri.

    it('yedek yol GERCEKTEN kosar ve SESSIZ DEGILDIR', async () => {
      const node = new FakeNode([], {
        blockTimestamps: new Map([[LAUNCH_BLOCK, 1_800_000_000n]]),
      })
      const warned: bigint[][] = []
      const events = await decodeAll(node, stripped, LAUNCH_BLOCK, LAUNCH_BLOCK, createPacer(), {
        onTimestampFallback: (blocks) => warned.push([...blocks]),
      })
      // Yolun kostugu, sahtenin CAGRI SAYISIYLA iddia ediliyor.
      expect(node.requests.filter((r) => r.method === 'eth_getBlockByNumber')).toHaveLength(1)
      expect(warned).toEqual([[LAUNCH_BLOCK]])
      expect(events[0]?.blockTime).toEqual(new Date(1_800_000_000_000))
    })

    it('BLOK BASINA bir cagri -- log basina degil', async () => {
      const node = new FakeNode([], {
        blockTimestamps: new Map([[LAUNCH_BLOCK, 1_800_000_000n]]),
      })
      await decodeAll(node, stripped, LAUNCH_BLOCK, LAUNCH_BLOCK, createPacer(), {
        onTimestampFallback: () => undefined,
      })
      expect(stripped.length).toBeGreaterThan(1)
      expect(node.requests).toHaveLength(1)
    })

    it('timestamp logda VARKEN hic ek cagri yapilmaz', async () => {
      const node = new FakeNode([])
      await decodeAll(
        node,
        rawLogs('launch', { block: LAUNCH_BLOCK }),
        LAUNCH_BLOCK,
        LAUNCH_BLOCK,
        createPacer(),
      )
      expect(node.requests).toEqual([])
    })

    it('blok da timestamp vermezse MissingTimestamp', async () => {
      const node = new FakeNode([], { blockTimestamps: new Map() })
      await expect(
        decodeAll(node, stripped, LAUNCH_BLOCK, LAUNCH_BLOCK, createPacer(), {
          onTimestampFallback: () => undefined,
        }),
      ).rejects.toThrow(MissingTimestamp)
    })
  })
})

// ---------------------------------------------------------------------------
// Graduated -- KURULMUS bir log, ve BAGIMSIZ bir cozucu ile karsilastirma
//
// FIXTURE'DAN GELMIYOR VE BU ACIKCA YAZILI. Yuk `vm.recordLogs()` ciktisi
// DEGILDIR; sekli derlenmis ABI'den, degerleri buradan gelir. Kaybedilen sey
// "bu tam olarak zincirin yaydigi baytlar" garantisidir. Yerine konan sey iki
// bagimsiz kapidir:
//
//   1. SEKIL derleyiciden gelir -- `topics.test.ts` imzayi ve indeksli alan
//      bayraklarini `packages/shared/src/abi/*`ten dogrular ve `abi-parity` CI
//      is'i o kopyayi gercek bir `forge build` ciktisiyla IKI YONLU tutar.
//   2. COZUCU DIFERANSIYELDIR -- bizim elle yazilmis kelime dilimleyicimizin
//      ciktisi viem'in `decodeEventLog`una karsi tutulur. Ikisinin AYNI hatayi
//      yapmasi icin sebep yok: biri ofsetleri elle sayar, oteki ABI'yi okur.
//
// Kalan bosluk isimlendirilmistir: gercek bir `graduate()` yurutmesinin
// miktarlari (`poolSeedSupply`, `realQuoteReserves`) burada IDDIA EDILMEZ.
// Onu kapatan sey `make fixtures`tir ve kimin kapatacagi `AWAITING_FIXTURE`ta
// yazilidir.
// ---------------------------------------------------------------------------

describe('kurulmus Graduated', () => {
  const BLOCK = 54_661_500n
  // Canli smoke'un OLCULMUS degerleri: mezuniyet tam olarak bunlari oder.
  const BASE = 206_886_011_183_597_390_493_942_218n // poolSeedSupply
  const QUOTE = 12_161_433_369_060_378_714n // realQuoteReserves
  const TARGET = '0x000000000000000000000000000000000000dead' as Address

  const log = (): RawLog =>
    constructedGraduatedLog({
      curve: LIVE.curve,
      token: LIVE.token,
      to: TARGET,
      baseAmountTok: BASE,
      quoteAmountWei: QUOTE,
      block: BLOCK,
      logIndex: 3,
    })

  it('topic0 kodlanan logda GERCEKTEN TOPIC0.graduated tir', () => {
    // Kurulmus yukun kendisi de dogrulanir: viem'in kodlayicisi ile bizim
    // `toEventSelector` hesabimiz ayni degeri vermeseydi, asagidaki her sey
    // baska bir olayi test ediyor olurdu.
    expect(log().topics[0]).toBe(TOPIC0.graduated)
    expect(log().topics).toHaveLength(3)
  })

  it('cozucu viem in ABI cozucusuyle ALAN ALAN ortusur', async () => {
    const raw = log()
    const [event] = await decodeAll(new FakeNode([]), [raw], BLOCK, BLOCK, createPacer())
    if (event?.kind !== 'graduated') throw new Error('graduated cozulmedi')

    const oracle = decodeEventLog({
      abi: bondingCurveAbi,
      data: raw.data,
      topics: raw.topics as [Hex, ...Hex[]],
    }) as { eventName: string; args: Record<string, unknown> }

    expect(oracle.eventName).toBe('Graduated')
    expect(event.token).toBe((oracle.args['token'] as string).toLowerCase())
    expect(event.to).toBe((oracle.args['to'] as string).toLowerCase())
    expect(event.baseAmountTok).toBe(oracle.args['baseAmount'])
    expect(event.quoteAmountWei).toBe(oracle.args['quoteAmount'])
    // `curve` bir ABI alani DEGILDIR -- yayincidir. Oracle onu goremez, yani
    // bu satir diferansiyelin DISINDA ve ayrica iddia edilmeli.
    expect(event.curve).toBe(LIVE.curve)
    expect(event.seq).toBe(toSeq(BLOCK, 3))
  })

  it('eksik bir data kelimesi SESSIZCE sifir okunmaz', async () => {
    const raw = log()
    const short: RawLog = { ...raw, data: `0x${raw.data.slice(2, 66)}` }
    await expect(decodeAll(new FakeNode([]), [short], BLOCK, BLOCK, createPacer())).rejects.toThrow(
      MalformedLog,
    )
  })

  it('iki topic li (indekssiz to) bir Graduated reddedilir', async () => {
    const raw = log()
    const twoTopics: RawLog = { ...raw, topics: [raw.topics[0]!, raw.topics[1]!] }
    await expect(
      decodeAll(new FakeNode([]), [twoTopics], BLOCK, BLOCK, createPacer()),
    ).rejects.toThrow(MalformedLog)
  })

  it('curve sorgusu Graduated topic ini GERCEKTEN ister', async () => {
    // Cozucu yazilip topic sorgudan atlanmis olsaydi butun testler yesil
    // kalir ve URETIMDE hicbir sey gelmezdi -- "cekilmiyor" ve "cozulemiyor"
    // ayni sessizlige duser. Filtre burada OLCULUYOR.
    const node = new FakeNode([log()])
    const watch: WatchSet = {
      factory: LIVE.factory,
      escrow: LIVE.escrow,
      curves: new Set([LIVE.curve]),
      tokens: new Set([LIVE.token]),
      curveToToken: new Map(),
      pools: new Map(),
    }
    const events = await fetchRange(node, watch, BLOCK, BLOCK)
    expect(events.map((e) => e.kind)).toEqual(['graduated'])

    /*
     * SORGU ARTIK ADRESINDEN DEGIL TOPIC'INDEN BULUNUR. Curve sorgusu adres
     * filtresi tasimiyor -- kaldirilmasi bilincli bir KAPASITE kararidir
     * (bkz. `logs.ts`, "MALIYET AKTIVITEYLE OLCEKLENIR"), ve yayinci kontrolu
     * cekme katmanina tasindi. Bu testin OLCTUGU sey degismedi: uc topic de
     * gercekten soruluyor mu.
     */
    const curveFilter = node.logFilters.find((f) => {
      const topics = f['topics'] as unknown[] | undefined
      const first = Array.isArray(topics?.[0]) ? (topics[0] as string[]) : []
      return first.includes(TOPIC0.graduated)
    })
    expect((curveFilter?.['topics'] as Hex[][] | undefined)?.[0]).toEqual([
      TOPIC0.trade,
      TOPIC0.completed,
      TOPIC0.graduated,
    ])
  })

  it('ESCROW sorgusu Graduated i ISTEMEZ (yayinci curve dur)', async () => {
    const node = new FakeNode([log()])
    await fetchRange(
      node,
      {
        factory: LIVE.factory,
        escrow: LIVE.escrow,
        curves: new Set([LIVE.curve]),
        tokens: new Set([LIVE.token]),
        curveToToken: new Map(),
        pools: new Map(),
      },
      BLOCK,
      BLOCK,
    )
    const escrowFilter = node.logFilters.find((f) => f['address'] === LIVE.escrow)
    expect((escrowFilter?.['topics'] as Hex[][] | undefined)?.[0]).toEqual([
      TOPIC0.deposited,
      TOPIC0.claimed,
    ])
  })

  it('BASKA bir adresten gelen ayni topic hic cekilmez (sahte mezuniyet)', async () => {
    // `forged.json`in `Launched` icin olctugu seyin aynisi: topic0 gercek,
    // yayinci sahte. Adres filtresi tek savunmadir.
    const rogue = constructedGraduatedLog({
      curve: '0x00000000000000000000000000000000deadbe01' as Address,
      token: LIVE.token,
      to: TARGET,
      baseAmountTok: BASE,
      quoteAmountWei: QUOTE,
      block: BLOCK,
      logIndex: 4,
    })
    const node = new FakeNode([rogue])
    const events = await fetchRange(
      node,
      {
        factory: LIVE.factory,
        escrow: LIVE.escrow,
        curves: new Set([LIVE.curve]),
        tokens: new Set([LIVE.token]),
        curveToToken: new Map(),
        pools: new Map(),
      },
      BLOCK,
      BLOCK,
    )
    expect(events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cozme -- CANLI degerlere karsi
// ---------------------------------------------------------------------------

describe('cozme (canli Arc degerleri)', () => {
  const logs = smokeLogs()
  const first = BigInt(logs[0]!.blockNumber)
  const last = BigInt(logs[logs.length - 1]!.blockNumber)

  async function liveEvents(): Promise<DecodedEvent[]> {
    return fetchRange(
      new FakeNode(logs),
      {
        factory: LIVE.factory,
        escrow: LIVE.escrow,
        curves: new Set(),
        tokens: new Set(),
        curveToToken: new Map(),
        pools: new Map(),
      },
      first,
      last,
    )
  }

  it('Launched canli launch in adreslerini verir', async () => {
    const launched = (await liveEvents()).find((e) => e.kind === 'launched')
    expect(launched).toMatchObject({
      factory: LIVE.factory,
      token: LIVE.token,
      curve: LIVE.curve,
      symbol: 'SMOKE',
    })
  })

  it('ham bayt alanlari cozulmus dizgeden TURETILMEZ ama burada ortusur', async () => {
    const launched = (await liveEvents()).find((e) => e.kind === 'launched')
    if (launched?.kind !== 'launched') throw new Error('launched yok')
    expect(launched.nameHex).toBe(`0x${Buffer.from(launched.name, 'utf8').toString('hex')}`)
    expect(launched.salt).toMatch(/^0x[0-9a-f]{64}$/)
  })

  // `Trade` TEK bir olaydir ve yon bayragi INDEKSLI DEGILDIR.
  it('yon bayragi cozulur -- topic ten suzulemez', async () => {
    const trades = (await liveEvents()).filter((e) => e.kind === 'trade')
    expect(trades.map((t) => t.isBuy)).toEqual([true, true, false, true])
    for (const t of trades) expect(t.curve).toBe(LIVE.curve)
  })

  // Iki rezerv ozdesligi, canli loglardan (depodan degil).
  it('vT-rT = 279900000e18 ve vQ-rQ = 4292e15, dort ticarette de', async () => {
    const trades = (await liveEvents()).filter((e) => e.kind === 'trade')
    expect(trades).toHaveLength(4)
    for (const t of trades) {
      expect(t.virtualTokenReservesTok - t.realTokenReservesTok).toBe(279_900_000n * 10n ** 18n)
      expect(t.virtualQuoteReservesWei - t.realQuoteReservesWei).toBe(4292n * 10n ** 15n)
    }
  })

  // UCRET PARCALARDAN TOPLANIR, 125'ten BOLUNMEZ. Canli smoke'ta fark
  // ticaret #1'de gorunur: bir wei.
  it('ucret parcalarin toplamidir; ticaret 1 de bolunmus deger BIR WEI eksik', async () => {
    const trades = (await liveEvents()).filter((e) => e.kind === 'trade')
    const feeOn = (q: bigint, bps: bigint): bigint => (q * bps + 9_999n) / 10_000n
    const first = trades[0]!
    expect(first.quoteAmountWei).toBe(49_382_716_049_382_715n)
    expect(first.protocolFeeWei + first.creatorFeeWei).toBe(617_283_950_617_285n)
    expect(feeOn(first.quoteAmountWei, 95n) + feeOn(first.quoteAmountWei, 30n)).toBe(
      first.protocolFeeWei + first.creatorFeeWei,
    )
    expect(feeOn(first.quoteAmountWei, 125n)).toBe(617_283_950_617_284n)
    for (const t of trades) {
      expect(t.protocolFeeWei + t.creatorFeeWei).toBe(
        feeOn(t.quoteAmountWei, 95n) + feeOn(t.quoteAmountWei, 30n),
      )
    }
  })

  // Escrow'un canli `totalOwed`i: yatirilan parcalarin TOPLAMI.
  it('Deposited toplami canli escrow totalOwed una esittir', async () => {
    const deposits = (await liveEvents()).filter((e) => e.kind === 'deposited')
    expect(deposits).toHaveLength(8)
    const total = deposits.reduce((acc, d) => acc + d.amountWei, 0n)
    expect(total).toBe(152_069_146_725_900_635n)
    for (const d of deposits) expect(d.from).toBe(LIVE.curve)
  })

  it('Completed canli fill in degerlerini tasir', async () => {
    const completed = (await liveEvents()).filter((e) => e.kind === 'completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      token: LIVE.token,
      curve: LIVE.curve,
      realQuoteReservesWei: 12_161_433_369_060_378_714n,
      poolSeedSupplyTok: 206_886_011_183_597_390_493_942_218n,
    })
  })

  it('mint Transfer i sifir adresten gelir ve TUM arzi tasir', async () => {
    const transfers = (await liveEvents()).filter((e) => e.kind === 'transfer')
    const mint = transfers[0]!
    expect(mint.from).toBe('0x0000000000000000000000000000000000000000')
    expect(mint.to).toBe(LIVE.curve)
    expect(mint.amountTok).toBe(10n ** 27n)
  })

  it('event_seq blok ve logIndex ten kurulur', async () => {
    const events = await liveEvents()
    for (const e of events) expect(e.seq).toBe(toSeq(e.blockNumber, e.logIndex))
  })

  it('claim fixture i Claimed i cozer', async () => {
    const node = new FakeNode(rawLogs('claim', { block: LAUNCH_BLOCK }))
    const events = await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, LAUNCH_BLOCK)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'claimed', escrow: FIX.escrow })
  })

  // `zero_creator.json`: TEK `Deposited`. "Her islem iki Deposited uretir"
  // varsayan bir yol burada kirilir.
  it('sifir-creator lu bir curve TEK Deposited yayar', async () => {
    const logs = rawLogs('zero_creator', { block: LAUNCH_BLOCK })
    const events = await decodeAll(
      new FakeNode([]),
      logs,
      LAUNCH_BLOCK,
      LAUNCH_BLOCK,
      createPacer(),
    )
    expect(kinds(events)).toEqual(['trade', 'transfer', 'deposited'])
    const trade = events[0]
    if (trade?.kind !== 'trade') throw new Error('trade yok')
    expect(trade.creatorFeeWei).toBe(0n)
  })

  it('sekli bozuk bir log SESSIZCE kisa okunmaz', async () => {
    const [log] = rawLogs('claim', { block: LAUNCH_BLOCK })
    const truncated: RawLog = { ...log!, data: '0x' }
    await expect(
      decodeAll(new FakeNode([]), [truncated], LAUNCH_BLOCK, LAUNCH_BLOCK, createPacer()),
    ).rejects.toThrow(MalformedLog)
  })

  it('dizge offset i data disini gosteren bir Launched reddedilir', async () => {
    // KONUMLA DEGIL TOPIC ILE bulunur: fixture'a yeni bir log eklendiginde
    // (eklendi) konum kayar ve test baska bir logu sinamaya baslardi.
    const launched = rawLogs('launch', { block: LAUNCH_BLOCK }).find(
      (l) => l.topics[0] === TOPIC0.launched,
    )
    // Ilk offset'i (name) devasa yap.
    const evil: RawLog = {
      ...launched!,
      data: `0x${'f'.repeat(64)}${launched!.data.slice(66)}`,
    }
    await expect(
      decodeAll(new FakeNode([]), [evil], LAUNCH_BLOCK, LAUNCH_BLOCK, createPacer()),
    ).rejects.toThrow(MalformedLog)
  })
})

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

describe('pacing', () => {
  it('varsayilan olarak istekler CAKISMAZ', async () => {
    let active = 0
    let peak = 0
    const pacer = createPacer()
    await Promise.all(
      Array.from({ length: 8 }, () =>
        pacer.run(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 5))
          active -= 1
        }),
      ),
    )
    expect(peak).toBe(1)
  })

  it('minIntervalMs ARDISIK istekler arasina bosluk koyar', async () => {
    const vc = virtualClock()
    const pacer = createPacer({ minIntervalMs: 20, clock: vc.clock })
    const started: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const done = pacer.run(() => {
        started.push(vc.clock.now())
        return Promise.resolve()
      })
      await vc.drain()
      await done
    }
    // PAY YOK -- bkz. `virtualClock`.
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(20)
    expect(started[2]! - started[1]!).toBeGreaterThanOrEqual(20)
  })

  /**
   * TAKILMADAN SONRA PATLAMA YOK.
   *
   * Onceki hal slotu `Date.now() + wait` ile ILERIYE rezerve ediyordu; olay
   * dongusu takildiginda o rezervasyon gecmiste kalir ve bekleyen istekler
   * arka arkaya `wait = 0` hesaplayip PATLAMA halinde cikardi. Arc hem es
   * zamanli hem ARDISIK istekleri sinirladigi icin patlama tam da hiz sinirina
   * tosladigimiz an olurdu.
   *
   * Burada ilk istek 60ms surer (bir RPC takilmasi gibi) ve ardindan uc istek
   * kuyrukta bekler; ARALARINDAKI her bosluk hala >= minInterval olmali.
   */
  it('bir takilmadan sonra istekler patlamaz', async () => {
    const vc = virtualClock()
    const pacer = createPacer({ minIntervalMs: 25, clock: vc.clock })
    const starts: number[] = []
    const task = (ms: number) =>
      pacer.run(async () => {
        starts.push(vc.clock.now())
        await vc.sleep(ms)
      })
    const all = Promise.all([task(60), task(0), task(0), task(0)])
    await vc.drain()
    await all
    expect(starts).toHaveLength(4)
    for (let i = 1; i < starts.length; i += 1) {
      // 60ms'lik ilk istekten sonraki bosluk da dahil, hicbiri sinirin
      // altina dusmez. PAY YOK -- bkz. `virtualClock`.
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(25)
    }
  })

  /**
   * ES ZAMANLILIK ACIKKEN DE BOSLUK VAR -- VE ONCEDEN YOKTU.
   *
   * `minIntervalMs`in tek dokumante ozelligi "ARDISIK hiz siniri icin gereken
   * sey budur ve es zamanlilik siniri onu VERMEZ" idi. Olculdu: `concurrency`
   * 1'den buyuk oldugu anda ozellik yok oluyordu. Iki slot bostayken iki
   * `start()` ardisik kosar, AYNI `lastStart`i okur, ayni `wait`i hesaplar ve
   * AYNI MILISANIYEDE baslardi.
   *
   *   concurrency 4, minInterval 25, dort is  -> bosluklar 27, 0, 0
   *   concurrency 2, minInterval 50, alti is  -> bosluklar 51, 0, 50, 0, 50
   *
   * Uretim `concurrency: 1` kullandigi icin bu canli bir ariza DEGILDI; ama
   * `concurrency` disa acik bir secenek ve onu acmanin bedeli, Arc'in
   * `-32011`i uretmis oldugu tam yapilandirmaya SESSIZCE gecmekti.
   *
   * Yukaridaki "takilmadan sonra patlamaz" testi DURUYOR ve ikisi birlikte
   * olculuyor: duzeltmenin kendisi eski kusurun taze bir ornegini tasiyamaz.
   */
  it('minIntervalMs es zamanli slotlar arasinda da bosluk koyar', async () => {
    for (const [concurrency, interval, count] of [
      [4, 25, 4],
      [2, 50, 6],
    ] as const) {
      const vc = virtualClock()
      const pacer = createPacer({ concurrency, minIntervalMs: interval, clock: vc.clock })
      const starts: number[] = []
      const all = Promise.all(
        Array.from({ length: count }, () =>
          pacer.run(() => {
            starts.push(vc.clock.now())
            return Promise.resolve()
          }),
        ),
      )
      await vc.drain()
      await all
      starts.sort((a, b) => a - b)
      expect(starts, `concurrency=${concurrency}`).toHaveLength(count)
      for (let i = 1; i < starts.length; i += 1) {
        // PAY YOK, VE BU BIR SIKILASTIRMADIR. Onceki hal `> interval - 3`
        // idi; sahte saat altinda aralik TAM olarak tutulur.
        expect(
          starts[i]! - starts[i - 1]!,
          `concurrency=${concurrency}, i=${i}`,
        ).toBeGreaterThanOrEqual(interval)
      }
    }
  })

  /**
   * GEC ATESLEYEN BIR ZAMANLAYICI ARALIGI KISALTAMAZ.
   *
   * BU TESTIN OLCTUGU SATIR TEKTIR: `begin()` icindeki
   * `nextEarliest = max(nextEarliest, clock.now() + minIntervalMs)`.
   *
   * NEDEN AYRI BIR TEST OLMAK ZORUNDA. O satir yalnizca `schedule` GEC
   * atesledigende bir sey yapar, ve ustteki uc test bunu goremez cunku
   * hicbiri gecikme URETMEZ. Olculdu: satir silindiginde bu dosyadaki 70
   * testin HEPSI yesil kaldi. Bir kusuru gormeyen 70 test, o kusur icin sifir
   * testtir.
   *
   * KURULUM: her `schedule` planlanan andan 40ms GEC atesler. Rezervasyon
   * (`nextEarliest = at + minIntervalMs`) plana gore yapilir; istek ise
   * plandan 40ms sonra baslar. Ikinci ilerletme olmasaydi bir sonraki istek
   * kendi planina gore -- yani ilkinin GERCEK baslangicindan 40ms ONCEsine
   * dayanan bir plana gore -- baslar ve olculen bosluk `minIntervalMs`in
   * ALTINA duserdi. Ilerletme ile bosluk gercek baslangictan sayilir.
   */
  it('gec atesleyen bir zamanlayici araligi KISALTAMAZ', async () => {
    const LATE = 40
    const INTERVAL = 25
    const vc = virtualClock({ lateness: () => LATE })
    const pacer = createPacer({ concurrency: 1, minIntervalMs: INTERVAL, clock: vc.clock })
    const starts: number[] = []
    const all = Promise.all(
      Array.from({ length: 4 }, () =>
        pacer.run(() => {
          starts.push(vc.clock.now())
          return Promise.resolve()
        }),
      ),
    )
    await vc.drain()
    await all

    expect(starts).toHaveLength(4)
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!, `bosluk ${i}`).toBeGreaterThanOrEqual(INTERVAL)
    }
    // ANTI-VAKUM: gecikme GERCEKTEN olustu. Aksi halde yukaridaki dongu
    // gecikmesiz bir dunyayi olcer ve mutant yine hayatta kalirdi.
    expect(starts[starts.length - 1]! - starts[0]!).toBeGreaterThanOrEqual(3 * LATE)
  })

  it('cekme katmani gecirilen pacer i GERCEKTEN kullanir', async () => {
    let calls = 0
    const counting = {
      run<T>(fn: () => Promise<T>): Promise<T> {
        calls += 1
        return fn()
      },
    }
    const node = new FakeNode(launchAndBuy())
    await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK, { pacer: counting })
    expect(calls).toBe(node.requests.length)
    expect(calls).toBeGreaterThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// KAPASITE -- MALIYET AKTIVITEYLE OLCEKLENIR, KAYIT SAYISIYLA DEGIL
// ---------------------------------------------------------------------------
//
// BULUNAN SORUN (denetim, ucuncu gecis): curve sorgusu `launches`'in TAMAMINI
// adres filtresine koyuyordu, yani her 500 launch her donguye bir
// `eth_getLogs` cagrisi daha ekliyordu -- KALICI olarak. Yanlis olcekleme
// buydu: launch ucretsizdir (olculdu: 0,039 USDC) ve POPULERLIK dogrudan
// kayit uretir. Yuzlerce kisinin ayni anda launch etmesi bir saldiri degil,
// urunun BASARI halidir; sistem onu tasimak zorunda.
//
// Uc `topic0` arcpad'e ozgudur, dolayisiyla adres filtresi kaldirilip yerine
// CEKME katmaninda yayinci kontrolu konuldu. Guvenlik ayni, maliyet artik
// aktiviteyle orantili.
describe('kapasite: curve sorgusu izleme kumesiyle buyumez', () => {
  /** `n` uydurma curve tasiyan bir izleme kumesi. */
  function watchWith(n: number): WatchSet {
    const curves = new Set<Address>([FIX.curve])
    for (let i = 0; i < n; i++) {
      curves.add(`0x${(i + 1).toString(16).padStart(40, '0')}` as Address)
    }
    return { ...EMPTY_WATCH, curves, tokens: new Set([FIX.token]) }
  }

  /** Curve olaylarini soran cagrilarin sayisi. */
  function curveQueryCount(node: FakeNode): number {
    return node.logFilters.filter((f) => {
      const topics = f['topics'] as unknown[] | undefined
      const first = Array.isArray(topics?.[0]) ? (topics[0] as string[]) : []
      return first.includes(TOPIC0.trade)
    }).length
  }

  it('10, 5.000 ve 50.000 curve ayni sayida cagri uretir', async () => {
    const counts: number[] = []
    for (const n of [10, 5_000, 50_000]) {
      const node = new FakeNode(launchAndBuy())
      await fetchRange(node, watchWith(n), LAUNCH_BLOCK, BUY_BLOCK)
      counts.push(curveQueryCount(node))
    }
    // ONCEKI HALDE bunlar 1, 10 ve 100 olurdu (500'luk dilimler).
    expect(counts).toEqual([1, 1, 1])
  })

  it('curve sorgusu ADRES FILTRESI TASIMAZ -- tasisaydi kume ile buyurdu', async () => {
    const node = new FakeNode(launchAndBuy())
    await fetchRange(node, watchWith(1_000), LAUNCH_BLOCK, BUY_BLOCK)
    const curveFilters = node.logFilters.filter((f) => {
      const topics = f['topics'] as unknown[] | undefined
      const first = Array.isArray(topics?.[0]) ? (topics[0] as string[]) : []
      return first.includes(TOPIC0.trade)
    })
    expect(curveFilters).toHaveLength(1)
    expect(curveFilters[0]?.['address']).toBeUndefined()
  })

  /*
   * VE GUVENLIK AYNI KALIR. Adres filtresi kaldirildi ama ISLEVI kaldirilmadi:
   * yayinci kontrolu cekme katmaninda duruyor. Bu test onu olcer -- sahte bir
   * `Trade`, GERCEK topic0 ile ama bilinmeyen bir adresten gelir ve ELENIR.
   *
   * Elenmesi SART: ingest'teki `UnknownCurve` bir HALT'tir, yani sizan tek bir
   * sahte olay indexer'i durdururdu -- launch spam'inden bile ucuz bir
   * saldiri.
   */
  it('SAHTE bir Trade -- gercek topic0, bilinmeyen yayinci -- ELENIR', async () => {
    const real = rawLogs('buy_exact_tokens_out', { block: BUY_BLOCK })
    const genuineTrade = real.find((l) => l.topics[0] === TOPIC0.trade)
    expect(genuineTrade, 'fixture icinde Trade yok').toBeDefined()

    const forged: RawLog = {
      ...(genuineTrade as RawLog),
      address: '0x00000000000000000000000000000000deadbeef',
      logIndex: '0x63',
    }

    const node = new FakeNode([...launchAndBuy(), forged], { ignoreAddressFilter: true })
    const events = await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)

    const traders = events.filter((e) => e.kind === 'trade')
    expect(traders.length, 'sahte Trade ice sizdi').toBe(1)
    for (const e of traders) {
      expect((e as { curve: string }).curve.toLowerCase()).toBe(FIX.curve)
    }
  })

  /*
   * AYNI ARALIKTA LAUNCH + ALIM hala calisir. Yayinci filtresi FAZ 1.5'ta
   * buyutulmus kumeye karsidir, yani ayni aralikta dogan bir curve'un ilk
   * islemi ELENMEZ. Bu, iki fazli tasarimin zaten koruduğu ozelliktir ve
   * degisiklik onu bozmamalidir.
   */
  it('ayni aralikta dogan bir curve in ILK islemi elenmez', async () => {
    const node = new FakeNode(launchAndBuy(), { ignoreAddressFilter: true })
    const events = await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)
    expect(kinds(events)).toContain('launched')
    expect(kinds(events)).toContain('trade')
  })
})

// ---------------------------------------------------------------------------
// KAPASITE 2 -- TRANSFER KUMESI DE LAUNCH SAYISIYLA BUYUMEZ
// ---------------------------------------------------------------------------
//
// `Transfer` topic0'i EVRENSELDIR, yani bu tek sorgu adres filtresini
// birakamaz. Bunun yerine kume kuculur: arzinin tamami hala curve'de duran
// bir token `Transfer` YAYAMAZ -- kimsede yoktur ki gondersin.
//
// Kume UC kaynaktan birlesir ve ucu de gerekli. Asagidaki testler ucunu de
// ayri ayri yuruyor; biri dusesse eksik bir `Transfer` demektir ve o,
// `holders.balance_tok >= 0` CHECK'inde indexer'i durdururdu.
describe('kapasite: transfer kumesi', () => {
  function transferFilters(node: FakeNode): Record<string, unknown>[] {
    return node.logFilters.filter((f) => {
      const topics = f['topics'] as unknown[] | undefined
      return topics?.[0] === TOPIC0.transfer
    })
  }

  function addressesIn(filters: Record<string, unknown>[]): Set<string> {
    const out = new Set<string>()
    for (const f of filters) {
      const a = f['address']
      for (const one of Array.isArray(a) ? (a as string[]) : a === undefined ? [] : [a as string]) {
        out.add(one.toLowerCase())
      }
    }
    return out
  }

  /** (1) BU ARALIKTA LAUNCH: mint `Transfer`i icin kumede olmali. */
  it('bu aralikta launch edilen token transfer kumesine girer', async () => {
    const node = new FakeNode(launchAndBuy())
    await fetchRange(node, EMPTY_WATCH, LAUNCH_BLOCK, BUY_BLOCK)
    expect(addressesIn(transferFilters(node))).toContain(FIX.token)
  })

  /*
   * (2) BU ARALIKTA ILK ALIM: token daha once hic islem gormemis, yani
   * `watch.tokens`te DEGIL -- ama ayni islemde hem `Trade` hem `Transfer`
   * var. FAZ 1.6 onu curve olayindan bulup ekler.
   */
  it('ILK ALIMDA token, curve olayindan bulunup kumeye eklenir', async () => {
    const node = new FakeNode(rawLogs('buy_exact_tokens_out', { block: BUY_BLOCK }))
    const watch: WatchSet = {
      ...EMPTY_WATCH,
      curves: new Set([FIX.curve]),
      // Token BILEREK bos: "hic islem gormemis" hali.
      tokens: new Set(),
      curveToToken: new Map([[FIX.curve, FIX.token]]),
    }
    await fetchRange(node, watch, BUY_BLOCK, BUY_BLOCK)
    expect(addressesIn(transferFilters(node))).toContain(FIX.token)
  })

  /*
   * (3) HIC ISLEM GORMEMIS VE BU ARALIKTA SESSIZ olan tokenlar SORULMAZ.
   * Olcekleme iddiasi tam olarak budur: 50.000 sessiz launch, transfer
   * sorgusuna TEK BIR adres eklemez.
   */
  it('sessiz ve hic islem gormemis tokenlar sorulmaz', async () => {
    const node = new FakeNode(rawLogs('buy_exact_tokens_out', { block: BUY_BLOCK }))
    const silent = new Map<Address, Address>()
    for (let i = 1; i <= 5_000; i++) {
      const c = `0x${i.toString(16).padStart(40, '0')}` as Address
      const t = `0x${(i + 900_000).toString(16).padStart(40, '0')}` as Address
      silent.set(c, t)
    }
    const watch: WatchSet = {
      ...EMPTY_WATCH,
      curves: new Set([FIX.curve, ...silent.keys()]),
      tokens: new Set(),
      curveToToken: new Map([[FIX.curve, FIX.token], ...silent]),
    }
    await fetchRange(node, watch, BUY_BLOCK, BUY_BLOCK)

    const asked = addressesIn(transferFilters(node))
    expect(asked).toContain(FIX.token)
    // 5.000 sessiz token'in HICBIRI sorulmadi.
    for (const t of silent.values()) expect(asked.has(t)).toBe(false)
    expect(asked.size).toBe(1)
  })
})
