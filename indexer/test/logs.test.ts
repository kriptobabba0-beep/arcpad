import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { toSeq } from '@arcpad/db'
import { TOPIC0 } from '../src/arc'
import type { DecodedEvent, RawLog, WatchSet } from '../src/logs'
import {
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
  FakeNode,
  fixtureNames,
  LIVE,
  loadAllFixtures,
  loadSmoke,
  rawLogs,
  smokeLogs,
} from './fixtures'

// Yerel fixture'larin adresleri (Foundry deterministik adresleri).
const FIX = {
  factory: '0x2e234dae75c793f67a35089c9d99245e1c58470b' as Address,
  escrow: '0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f' as Address,
  curve: '0xdc3fb2dd7a51fa3282758917ee98d9e006aabf87' as Address,
  token: '0x79f1b7ac99b0dacf3a009e4fbf07ee1e16f97887' as Address,
}

const EMPTY_WATCH: WatchSet = {
  factory: FIX.factory,
  escrow: FIX.escrow,
  curves: new Set(),
  tokens: new Set(),
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
      'claimed',
      'completed',
      'deposited',
      'launched',
      'trade',
      'transfer',
    ])
  })

  // (b) (a) BUNU KAPSAMAZ: bir handler yazilip hic cagrilmadan da (a) yesil
  //     kalir.
  it('her handler en az bir fixture tarafindan egzersiz edilir', async () => {
    const seen = new Set((await loadAllFixtures()).flatMap((f) => f.events.map((e) => e.kind)))
    expect([...seen].sort()).toEqual(Object.keys(DECODERS).sort())
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
      { factory: LIVE.factory, escrow: LIVE.escrow, curves: new Set(), tokens: new Set() },
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
      expect(stripped.length).toBe(2)
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
// Cozme -- CANLI degerlere karsi
// ---------------------------------------------------------------------------

describe('cozme (canli Arc degerleri)', () => {
  const logs = smokeLogs()
  const first = BigInt(logs[0]!.blockNumber)
  const last = BigInt(logs[logs.length - 1]!.blockNumber)

  async function liveEvents(): Promise<DecodedEvent[]> {
    return fetchRange(
      new FakeNode(logs),
      { factory: LIVE.factory, escrow: LIVE.escrow, curves: new Set(), tokens: new Set() },
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
    const [, launched] = rawLogs('launch', { block: LAUNCH_BLOCK })
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
    const pacer = createPacer({ minIntervalMs: 20 })
    const started: number[] = []
    for (let i = 0; i < 3; i += 1) {
      await pacer.run(() => {
        started.push(Date.now())
        return Promise.resolve()
      })
    }
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(18)
    expect(started[2]! - started[1]!).toBeGreaterThanOrEqual(18)
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
