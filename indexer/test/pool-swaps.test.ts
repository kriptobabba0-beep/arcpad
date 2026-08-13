import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { decodeEventLog } from 'viem'
import { getTokenOverview, listTrades, toSeq } from '@arcpad/db'
import { applyEvents, UnknownPool } from '../src/apply'
import { DegeneratePoolSwap } from '../src/apply/pool'
import { TOPIC0 } from '../src/arc'
import type { DecodedEvent, PoolRef, PoolSwapEvent, WatchSet } from '../src/logs'
import {
  createPacer,
  decodeAll,
  fetchRange,
  PoolKeyMismatch,
  PoolNotInitialized,
  UnpairedPoolFee,
} from '../src/logs'
import { baseIsCurrency0, poolIdFor, POOL_QUOTE_CURRENCY, QUOTE_SCALE } from '../src/pool'
import {
  ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT,
  POOL_MANAGER_INITIALIZE_EVENT,
  POOL_MANAGER_SWAP_EVENT,
} from '../src/pool-events.generated'
import {
  constructedGraduatedLog,
  constructedPoolInitializeLog,
  constructedSwapFeeCollectedLog,
  constructedSwapLog,
  FakeNode,
  LIVE,
  liveDecodedEvents,
} from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/**
 * ============ MEZUNIYETTEN SONRAKI ISLEMLER ============
 *
 * SU AN ZINCIRDE HICBIR HAVUZ YOK ve bu dosya bunu SAKLAMAZ: uretim
 * factory'sinin `graduationTarget`i BILEREK `0x0`, ilk gercek mezuniyet
 * 2026-08-11T23:01:51Z'de acilan pencerede olur. Dolayisiyla `Swap`,
 * `Initialize` ve `SwapFeeCollected` loglari BU DOSYADA KURULMUSTUR,
 * URETILMEMISTIR -- ve gerekcesi `test/fixtures.ts`teki `AWAITING_FIXTURE`ta,
 * kendi silinmesini zorlayan bir kapiyla birlikte yazili.
 *
 * KURULAN SEY YALNIZCA YUK. Yuku KODLAYAN sey derlenmis ABI
 * (`src/pool-events.generated.ts`, `contracts/out/**`tan uretilmis ve
 * commit'lenmis); onu COZEN, SIRALAYAN, FILTRELEYEN, ESLEYEN ve YAZAN her sey
 * gercek uretim kodudur. Onunde duran launch/ticaret/`Completed`/ucret
 * olaylari ise CANLI Arc makbuzlarindan gelir.
 *
 * NE OLCULMUYOR, ADIYLA: gercek bir yurutmenin uretecegi miktarlar ve
 * `SwapFeeCollected`in `Swap`e gore SIRASI. Hook'un iki dali (before/after)
 * kaynak okunarak modelleniyor; ikisi de test ediliyor ama HANGISININ hangi
 * swap seklinde calistigi olculmedi.
 */

const HOOK = '0xd95198cd806b736c8ececffc23976b59f565e0cc' as Address
const POOL_MANAGER = '0x617321a877e024c870516cd599a581dcdca6c09b' as Address
const LOCKER = '0x0e7771091a3471dc12cbfe38836badc7bf5a98e8' as Address
const ROUTER = '0x1111111111111111111111111111111111111111' as Address

const SWAP_BLOCK = 56_100_000n
const GRAD_BLOCK = 56_099_000n

/** Canli smoke curve'unun tokeni: `0x1bd9…` -- USDC'nin ALTINDA. */
const TOKEN = LIVE.token
const POOL_ID = poolIdFor(TOKEN, HOOK)

const REF: PoolRef = {
  poolId: POOL_ID,
  token: TOKEN,
  curve: LIVE.curve,
  target: LOCKER,
  hook: HOOK,
  poolManager: POOL_MANAGER,
  tokenIsCurrency0: baseIsCurrency0(TOKEN),
}

/** Mezuniyet sonrasi makul bir havuz durumu (dikis noktasindan). */
const SQRT_P = 19_209_072_819_323_074_680n
const LIQUIDITY = 50_160_046_734_639_668n

const watchWithPool = (pools: ReadonlyMap<Hex, PoolRef> = new Map([[POOL_ID, REF]])): WatchSet => ({
  factory: LIVE.factory,
  escrow: LIVE.escrow,
  curves: new Set([LIVE.curve]),
  tokens: new Set([TOKEN]),
  curveToToken: new Map(),
  pools,
})

/**
 * TOKEN `currency0`DIR (`0x1bd9… < 0x3600…`), yani:
 *   amount0 = token deltasi, amount1 = quote deltasi (6 decimal birim).
 * ALIS: kullanici quote ODER (amount1 < 0) ve token ALIR (amount0 > 0).
 */
function swapLog(over: Partial<Parameters<typeof constructedSwapLog>[0]> = {}) {
  return constructedSwapLog({
    poolManager: POOL_MANAGER,
    poolId: POOL_ID,
    sender: ROUTER,
    amount0: 2_000_000_000_000_000_000n,
    amount1: -1_000_000n,
    sqrtPriceX96: SQRT_P,
    liquidity: LIQUIDITY,
    block: SWAP_BLOCK,
    logIndex: 1,
    txHash: '0x'.padEnd(66, 'a') as Hex,
    ...over,
  })
}

async function decode(
  logs: readonly ReturnType<typeof swapLog>[],
  from = SWAP_BLOCK,
  to = SWAP_BLOCK,
) {
  return decodeAll(new FakeNode([]), logs, from, to, createPacer())
}

function onlySwap(events: readonly DecodedEvent[]): PoolSwapEvent {
  const swap = events.find((e) => e.kind === 'poolSwap')
  if (swap?.kind !== 'poolSwap') throw new Error('poolSwap cozulmedi')
  return swap
}

// ---------------------------------------------------------------------------
// COZUCU
// ---------------------------------------------------------------------------

describe('havuz loglarinin cozucusu', () => {
  /**
   * DIFERANSIYEL: BIZIM COZUCUMUZ vs viem'IN ABI COZUCUSU.
   *
   * `constructedGraduatedLog`in yaninda duran ayni kapi. Kendi kodumuzun
   * kendi kurdugumuz yuku okuyabilmesi hicbir sey ispatlamaz; ONEMLI OLAN,
   * BAGIMSIZ bir cozucunun ayni baytlardan ayni alanlari cikarmasi.
   */
  it('uc olay da viem in cozucusuyle ALAN ALAN ortusur', async () => {
    const logs = [
      swapLog(),
      constructedPoolInitializeLog({
        poolManager: POOL_MANAGER,
        poolId: POOL_ID,
        currency0: TOKEN,
        currency1: POOL_QUOTE_CURRENCY,
        hooks: HOOK,
        sqrtPriceX96: SQRT_P,
        tick: -12_345,
        block: SWAP_BLOCK,
        logIndex: 0,
      }),
      constructedSwapFeeCollectedLog({
        hook: HOOK,
        poolId: POOL_ID,
        protocolFeeUnits: 9_500n,
        creatorFeeUnits: 3_000n,
        block: SWAP_BLOCK,
        logIndex: 2,
      }),
    ]
    const events = await decode(logs)
    expect(events.map((e) => e.kind)).toEqual(['poolInitialize', 'poolSwap', 'poolFee'])

    const [init, swap, fee] = events
    if (init?.kind !== 'poolInitialize' || swap?.kind !== 'poolSwap' || fee?.kind !== 'poolFee') {
      throw new Error('beklenmeyen cozum')
    }

    const viemSwap = decodeEventLog({
      abi: [POOL_MANAGER_SWAP_EVENT],
      topics: logs[0]!.topics as [Hex, ...Hex[]],
      data: logs[0]!.data,
    }).args as Record<string, unknown>
    expect(swap.poolId).toBe(viemSwap['id'])
    expect(swap.sender.toLowerCase()).toBe((viemSwap['sender'] as string).toLowerCase())
    expect(swap.amount0).toBe(viemSwap['amount0'])
    expect(swap.amount1).toBe(viemSwap['amount1'])
    expect(swap.sqrtPriceX96).toBe(viemSwap['sqrtPriceX96'])
    expect(swap.liquidity).toBe(viemSwap['liquidity'])
    expect(swap.tick).toBe(viemSwap['tick'])
    expect(swap.poolFeeBps).toBe(viemSwap['fee'])

    const viemInit = decodeEventLog({
      abi: [POOL_MANAGER_INITIALIZE_EVENT],
      topics: logs[1]!.topics as [Hex, ...Hex[]],
      data: logs[1]!.data,
    }).args as Record<string, unknown>
    expect(init.currency0.toLowerCase()).toBe((viemInit['currency0'] as string).toLowerCase())
    expect(init.currency1.toLowerCase()).toBe((viemInit['currency1'] as string).toLowerCase())
    expect(init.hooks.toLowerCase()).toBe((viemInit['hooks'] as string).toLowerCase())
    expect(init.fee).toBe(viemInit['fee'])
    expect(init.tickSpacing).toBe(viemInit['tickSpacing'])
    // ISARETLI, ve negatif: `int24` iki tumleyen okunmazsa 16.7 milyona ziplar.
    expect(init.tick).toBe(-12_345)
    expect(init.tick).toBe(viemInit['tick'])

    const viemFee = decodeEventLog({
      abi: [ARCPAD_HOOK_SWAP_FEE_COLLECTED_EVENT],
      topics: logs[2]!.topics as [Hex, ...Hex[]],
      data: logs[2]!.data,
    }).args as Record<string, unknown>
    expect(fee.protocolFeeUnits).toBe(viemFee['protocolFee'])
    expect(fee.creatorFeeUnits).toBe(viemFee['creatorFee'])
  })

  /**
   * ISARET KAYBI SESSIZDIR VE YONU TERSINE CEVIRIR.
   *
   * `int128`i `uint`gibi okumak, negatif bir miktari 3.4e38 civarinda DEV bir
   * pozitife cevirir. Hicbir CHECK bunu goremez -- sayi gecerlidir -- ve
   * sonucu her satisin ALIS olarak kaydedilmesidir.
   */
  it('negatif int128 ISARETLI okunur', async () => {
    const swap = onlySwap(await decode([swapLog({ amount0: -5n, amount1: 7n })]))
    expect(swap.amount0).toBe(-5n)
    expect(swap.amount1).toBe(7n)
    // Kontrol: isaretsiz okuma bu sayiyi verirdi.
    expect(swap.amount0).not.toBe((1n << 256n) - 5n)
  })

  it('sekli bozuk bir log KISA OKUNMAZ, MalformedLog atar', async () => {
    const broken = { ...swapLog(), data: '0x1234' as Hex }
    await expect(decode([broken])).rejects.toThrow(/MalformedLog\(poolSwap\)/)
  })
})

// ---------------------------------------------------------------------------
// YON, BIRIM VE UCRET -- iki siralamada birden
// ---------------------------------------------------------------------------

describe('yon ve birimler', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
  })

  async function applySwap(logs: readonly ReturnType<typeof swapLog>[], ref: PoolRef = REF) {
    const events = await fetchRange(
      new FakeNode(logs),
      watchWithPool(new Map([[ref.poolId, ref]])),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    return { events, counts: await applyEvents(pool, LIVE_DEPLOYMENT, events) }
  }

  it('ALIS: quote ODENIR, token ALINIR -- ve quote 10^12 ile wei ye cikar', async () => {
    const { events, counts } = await applySwap([swapLog()])
    expect(counts.poolSwaps).toBe(1)
    expect(counts.trades).toBe(0)

    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    const top = rows[0]
    expect(top?.isBuy).toBe(true)
    expect(top?.tokenAmountTok).toBe(2_000_000_000_000_000_000n)
    // 1_000_000 BIRIM = 1 USDC = 1e18 wei. 6 decimal yazilsaydi 1e12 kat kucuk olurdu.
    expect(top?.quoteAmountWei).toBe(1_000_000n * QUOTE_SCALE)
    expect(top?.trader).toBe(ROUTER.toLowerCase())
    expect(onlySwap(events).pool?.token).toBe(TOKEN)
  })

  it('SATIS: token ODENIR, quote ALINIR', async () => {
    await applySwap([swapLog({ amount0: -3n * 10n ** 18n, amount1: 1_500_000n })])
    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    expect(rows[0]?.isBuy).toBe(false)
    expect(rows[0]?.tokenAmountTok).toBe(3n * 10n ** 18n)
    expect(rows[0]?.quoteAmountWei).toBe(1_500_000n * QUOTE_SCALE)
  })

  /**
   * SIRALAMANIN OTEKI YANI. `0x637a…` USDC'nin USTUNDEDIR, yani token
   * `currency1`dir ve `amount0`/`amount1`in ANLAMLARI YER DEGISTIRIR.
   * `amount0`in isaretine bakan bir kod burada HER ALISI SATIS kaydeder.
   */
  it('token currency1 iken yon TERSINDEN okunur', async () => {
    const above = '0x637af6afd61bb182c5843895d1e8e6fb5f56199a' as Address
    expect(baseIsCurrency0(above)).toBe(false)
    const ref: PoolRef = {
      ...REF,
      token: TOKEN, // yazim `curve_state`e bagli; siralama bayragi test edilen sey
      tokenIsCurrency0: false,
      poolId: poolIdFor(above, HOOK),
    }
    // amount0 = quote (odenir, negatif), amount1 = token (alinir, pozitif).
    await applySwap(
      [swapLog({ poolId: ref.poolId, amount0: -1_000_000n, amount1: 4n * 10n ** 18n })],
      ref,
    )
    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    expect(rows[0]?.isBuy).toBe(true)
    expect(rows[0]?.tokenAmountTok).toBe(4n * 10n ** 18n)
    expect(rows[0]?.quoteAmountWei).toBe(1_000_000n * QUOTE_SCALE)
  })

  /**
   * TEK BACAGI SIFIR OLAN SWAP MESRUDUR VE YAZILIR.
   *
   * 1 wei token (18 decimal) satmak 0 quote BIRIMI (6 decimal) getirir --
   * 10^12'lik decimal farkinin dogrudan sonucu. 003'un `> 0` kisiti bunu
   * REDDEDERDI ve indexer KALICI olarak dururdu; 012 tam bunun icin gevsetti.
   */
  it('quote bacagi sifir olan bir swap YAZILIR (kalici duraklama YOK)', async () => {
    const { counts } = await applySwap([swapLog({ amount0: -1n, amount1: 0n })])
    expect(counts.poolSwaps).toBe(1)
    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    expect(rows[0]?.quoteAmountWei).toBe(0n)
    expect(rows[0]?.tokenAmountTok).toBe(1n)
    // Yon token bacagindan okundu: odedi -> satis.
    expect(rows[0]?.isBuy).toBe(false)
  })

  it('IKI bacagi da sifir olan bir swap DURDURUR', async () => {
    await expect(applySwap([swapLog({ amount0: 0n, amount1: 0n })])).rejects.toThrow(
      DegeneratePoolSwap,
    )
  })

  it('izleme kumesinde olmayan bir havuz DURDURUR', async () => {
    const events = await decode([swapLog()])
    await expect(applyEvents(pool, LIVE_DEPLOYMENT, events)).rejects.toThrow(UnknownPool)
  })
})

// ---------------------------------------------------------------------------
// UCRET: HOOK'TAN GELIR, HAVUZDAN DEGIL
// ---------------------------------------------------------------------------

describe('havuz isleminin ucreti', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
  })

  const feeLog = (logIndex: number) =>
    constructedSwapFeeCollectedLog({
      hook: HOOK,
      poolId: POOL_ID,
      protocolFeeUnits: 9_500n,
      creatorFeeUnits: 3_000n,
      block: SWAP_BLOCK,
      logIndex,
      txHash: '0x'.padEnd(66, 'a') as Hex,
    })

  async function run(logs: readonly ReturnType<typeof swapLog>[]) {
    const events = await fetchRange(new FakeNode(logs), watchWithPool(), SWAP_BLOCK, SWAP_BLOCK)
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    return (await listTrades(pool, TOKEN, { limit: 5 }))[0]
  }

  /**
   * HOOK'UN IKI DALI: ucret logu swap'ten ONCE de SONRA da gelebilir.
   * `_beforeSwap` quote SPECIFIED tarafta iken tahsil eder (log once),
   * `_afterSwap` UNSPECIFIED tarafta iken (log sonra). "Her zaman once" diye
   * yazilmis bir esleme, dort swap seklinin IKISINDE ucreti kaybederdi.
   */
  it('ucret logu swap ten ONCE geldiginde eslenir', async () => {
    const row = await run([feeLog(0), swapLog({ logIndex: 1 })])
    expect(row?.protocolFeeWei).toBe(9_500n * QUOTE_SCALE)
    expect(row?.creatorFeeWei).toBe(3_000n * QUOTE_SCALE)
  })

  it('ucret logu swap ten SONRA geldiginde de eslenir', async () => {
    const row = await run([swapLog({ logIndex: 0 }), feeLog(1)])
    expect(row?.protocolFeeWei).toBe(9_500n * QUOTE_SCALE)
    expect(row?.creatorFeeWei).toBe(3_000n * QUOTE_SCALE)
  })

  /**
   * ================ MUTASYONUN ORTAYA CIKARDIGI BOSLUK ================
   *
   * Yukaridaki iki test (ONCE/SONRA) TEK BIR ADAY ile kosuyor, ve tek adayla
   * HER esleme kurali dogru cevabi verir -- `best === undefined` dali onu
   * kosulsuz secer. Olculdu: "yalnizca ONCEKI loga bak" mutanti IKISINI DE
   * gecti. Yani ikisi de geciyordu ama OLCTUKLERI sey "bir ucret bulunuyor
   * mu"ydu, "DOGRU ucret bulunuyor mu" degil -- kimsenin yazmadigi bir
   * sebeple gecen test.
   *
   * KAPATAN SEY IKI SWAP + IKI UCRET: `_beforeSwap` dalinda ucret swap'ten
   * ONCE, `_afterSwap` dalinda SONRA gelir, ve ayni islemde ayni havuza iki
   * kez dokunmak (bir router icin siradan) tam olarak bu ic ice gecmis diziyi
   * uretir. Yalnizca "en yakin" kurali dogru cifti verir; "hep onceki"
   * ikinci swap'i ucretsiz birakir, "hep sonraki" birincisini yanlis ucretle
   * yazar.
   */
  it('IC ICE GECMIS iki swap ve iki ucret DOGRU eslesir', async () => {
    const tx = '0x'.padEnd(66, 'a') as Hex
    const fee = (logIndex: number, units: bigint) =>
      constructedSwapFeeCollectedLog({
        hook: HOOK,
        poolId: POOL_ID,
        protocolFeeUnits: units,
        creatorFeeUnits: 0n,
        block: SWAP_BLOCK,
        logIndex,
        txHash: tx,
      })
    const events = await fetchRange(
      new FakeNode([
        fee(0, 100n), // `_beforeSwap` dali: swap #1'in ucreti ONCE
        swapLog({ logIndex: 1 }),
        swapLog({ logIndex: 2, amount0: -1n * 10n ** 18n, amount1: 500_000n }),
        fee(3, 200n), // `_afterSwap` dali: swap #2'nin ucreti SONRA
      ]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    // `listTrades` YENIDEN eskiye siralar: [swap #2, swap #1].
    expect(rows[0]?.protocolFeeWei).toBe(200n * QUOTE_SCALE)
    expect(rows[1]?.protocolFeeWei).toBe(100n * QUOTE_SCALE)
  })

  /**
   * UCRET SIFIRSA HOOK HIC LOG YAYMAZ (`ArcpadHook._collect`: `if (fee == 0)
   * return 0`). Eslenmemis bir swap MESRUDUR ve ucretleri sifir yazilir.
   */
  it('ucret logu YOKSA satir sifir ucretle yazilir', async () => {
    const row = await run([swapLog({ logIndex: 0 })])
    expect(row?.protocolFeeWei).toBe(0n)
    expect(row?.creatorFeeWei).toBe(0n)
  })

  /**
   * QUOTE BACAGI SIFIR OLAN BIR SWAP UCRET CALAMAZ.
   *
   * `ArcpadHook._collect`: `feeOn(0, bps) == 0`, iki parca da sifir, `fee == 0`
   * dalinda HIC log yayilmaz. Yani bir toz swap'inin (18/6 decimal farkindan
   * dogan, 0 quote birimi getiren swap) ucreti OLAMAZ. Bu kural olmasa,
   * kendinden SONRAKI swap'in ucretini alir ve IKI satir birden yanlis olurdu:
   * biri ucretsiz olmasi gerekirken ucretli, oteki ucretli olmasi gerekirken
   * ucretsiz.
   */
  it('quote bacagi SIFIR olan swap, sonraki swap in ucretini CALMAZ', async () => {
    const events = await fetchRange(
      new FakeNode([
        // Toz: 1 wei token satildi, 0 quote birimi geldi. Ucreti YOK.
        swapLog({ logIndex: 0, amount0: -1n, amount1: 0n }),
        feeLog(1),
        swapLog({ logIndex: 2 }),
      ]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    // YENIDEN eskiye: [logIndex 2, logIndex 0]
    expect(rows[0]?.protocolFeeWei).toBe(9_500n * QUOTE_SCALE)
    expect(rows[1]?.quoteAmountWei).toBe(0n)
    expect(rows[1]?.protocolFeeWei).toBe(0n)
  })

  /**
   * UCRET ISLEM SINIRINI GECEMEZ. Ayni blokta, ayni havuza dokunan IKI AYRI
   * islem: A'nin swap'i ucretsiz (quote bacagi sifir degil ama ucret logu
   * yok -- bu senaryoda B'nin ucreti A'ya sizmamali).
   */
  it('bir islemin ucreti BASKA bir islemin swap ine baglanmaz', async () => {
    const txA = '0x'.padEnd(66, 'b') as Hex
    const txB = '0x'.padEnd(66, 'c') as Hex
    const events = await fetchRange(
      new FakeNode([
        swapLog({ logIndex: 0, txHash: txA }),
        constructedSwapFeeCollectedLog({
          hook: HOOK,
          poolId: POOL_ID,
          protocolFeeUnits: 777n,
          creatorFeeUnits: 0n,
          block: SWAP_BLOCK,
          logIndex: 1,
          txHash: txB,
        }),
        swapLog({ logIndex: 2, txHash: txB }),
      ]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const rows = await listTrades(pool, TOKEN, { limit: 5 })
    expect(rows[0]?.protocolFeeWei).toBe(777n * QUOTE_SCALE) // txB'nin swap i
    expect(rows[1]?.protocolFeeWei).toBe(0n) // txA'nin swap i ucretsiz
  })

  /**
   * UCRET HAVUZ SINIRINI DA GECEMEZ. Cok adimli bir islem (bir router'in
   * A -> USDC -> B rotasi) IKI arcpad havuzuna dokunur ve ikisi de ayni
   * `tx`tedir; ucretleri ayirt eden tek sey `PoolId`dir.
   *
   * IDDIA COZULMUS OLAYLAR UZERINDE, veritabani uzerinde DEGIL: ikinci
   * token'in `launches` satiri yok ve olmasi da gerekmiyor -- olculen sey
   * cekme katmaninin eslemesi.
   */
  it('bir havuzun ucreti BASKA bir havuzun swap ine baglanmaz', async () => {
    const otherToken = '0x637af6afd61bb182c5843895d1e8e6fb5f56199a' as Address
    const otherId = poolIdFor(otherToken, HOOK)
    const otherRef: PoolRef = {
      ...REF,
      poolId: otherId,
      token: otherToken,
      tokenIsCurrency0: baseIsCurrency0(otherToken),
    }
    const events = await fetchRange(
      new FakeNode([
        constructedSwapFeeCollectedLog({
          hook: HOOK,
          poolId: otherId,
          protocolFeeUnits: 200n,
          creatorFeeUnits: 0n,
          block: SWAP_BLOCK,
          logIndex: 0,
          txHash: '0x'.padEnd(66, 'a') as Hex,
        }),
        swapLog({ logIndex: 1 }),
        swapLog({ logIndex: 2, poolId: otherId, amount0: -1_000_000n, amount1: 3n * 10n ** 18n }),
      ]),
      watchWithPool(
        new Map([
          [POOL_ID, REF],
          [otherId, otherRef],
        ]),
      ),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    const swaps = events.filter((e) => e.kind === 'poolSwap') as PoolSwapEvent[]
    expect(swaps).toHaveLength(2)
    const mine = swaps.find((s) => s.poolId === POOL_ID)
    const other = swaps.find((s) => s.poolId === otherId)
    expect(mine?.feePaired).toBe(false)
    expect(mine?.protocolFeeUnits).toBe(0n)
    expect(other?.feePaired).toBe(true)
    expect(other?.protocolFeeUnits).toBe(200n)
  })

  /**
   * TERSI MESRU DEGILDIR: hook ucreti YALNIZCA bir swap'in icinde yayar.
   * Sessizce atmak, o ucreti `trades` satirindan dusurup satiri "ucretsiz
   * islem" gibi gosterirdi.
   */
  it('swap i olmayan bir ucret logu DURDURUR', async () => {
    await expect(
      fetchRange(new FakeNode([feeLog(0)]), watchWithPool(), SWAP_BLOCK, SWAP_BLOCK),
    ).rejects.toThrow(UnpairedPoolFee)
  })

  /**
   * `Swap.fee` HAVUZUN LP UCRETIDIR VE SIFIRDIR. Onu islemin ucreti sanan bir
   * okuma HER havuz islemini ucretsiz kaydeder; gercek ucret hook'un olayindan
   * gelir. Sifir olmayan bir `Swap.fee` (governor Safe'in `setProtocolFee`i)
   * DURDURMAZ -- mesru bir yonetisim eylemidir -- ama UYARIR.
   */
  it('sifir olmayan Swap.fee UYARIR ama durdurmaz', async () => {
    const seen: number[] = []
    const events = await fetchRange(
      new FakeNode([swapLog({ logIndex: 0, fee: 3000 })]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    const swap = onlySwap(events)
    expect(swap.poolFeeBps).toBe(3000)
    const { applyPoolSwapEvent } = await import('../src/apply/pool')
    await applyPoolSwapEvent(pool, LIVE_DEPLOYMENT, swap, {
      onNonZeroPoolFee: (_id, bps) => seen.push(bps),
    })
    expect(seen).toEqual([3000])
  })
})

// ---------------------------------------------------------------------------
// CEKME KATMANI: FAZ 3, KAPILAR VE MALIYET
// ---------------------------------------------------------------------------

describe('havuz katmaninin cekilmesi', () => {
  it('HIC MEZUN TOKEN YOKSA TEK BIR HAVUZ SORGUSU BILE YAPILMAZ', async () => {
    // BUGUNKU URETIM DURUMU. `graduationTarget = 0x0`, yani hicbir havuz yok
    // ve bu katmanin maliyeti SIFIR olmali -- Arc'in hiz siniri JSON-RPC
    // NESNESI sayar (20 red, 15 gecer), yani bosuna atilan her sorgu gercek
    // bir butce kalemi.
    const node = new FakeNode([])
    await fetchRange(node, watchWithPool(new Map()), SWAP_BLOCK, SWAP_BLOCK)
    for (const filter of node.logFilters) {
      const topics = filter['topics'] as (Hex | Hex[])[] | undefined
      const first = topics?.[0]
      const list = Array.isArray(first) ? first : first === undefined ? [] : [first]
      expect(list).not.toContain(TOPIC0.poolSwap)
    }
  })

  it('UC OLAY TEK SORGUDA gelir: adres {PoolManager, hook}, topic1 = PoolId', async () => {
    const node = new FakeNode([])
    await fetchRange(node, watchWithPool(), SWAP_BLOCK, SWAP_BLOCK)
    const poolFilters = node.logFilters.filter((f) => {
      const t0 = (f['topics'] as (Hex | Hex[])[])[0]
      return Array.isArray(t0) && t0.includes(TOPIC0.poolSwap)
    })
    // TEK sorgu -- ucu ayri ayri sormak aralik basina UC istek olurdu.
    expect(poolFilters).toHaveLength(1)
    const filter = poolFilters[0]!
    const topics = filter['topics'] as (Hex | Hex[])[]
    expect(topics[0]).toEqual([TOPIC0.poolSwap, TOPIC0.poolInitialize, TOPIC0.poolFee])
    expect(topics[1]).toEqual([POOL_ID])
    // ADRES FILTRESI ZORUNLU: `PoolManager` zincirdeki HER havuzun `Swap`ini
    // yayar. Filtresiz bir sorgu, `Transfer`in EIP-7708 tuzaginin aynisi.
    expect(filter['address']).toEqual([POOL_MANAGER, HOOK])
  })

  /**
   * FAZ 1.5'IN HAVUZ IKIZI. Bir token AYNI ARALIKTA mezun olup islem
   * gorduğunde, izleme kumesi aralik BASINDA kurulmus oldugu icin o `Swap`ler
   * HIC CEKILMEZDI -- ve imlec ilerledigi icin bir daha da cekilmezdi.
   */
  it('AYNI ARALIKTA mezun olan bir token in swap i de cekilir', async () => {
    const gradLog = constructedGraduatedLog({
      curve: LIVE.curve,
      token: TOKEN,
      to: LOCKER,
      baseAmountTok: 1n,
      quoteAmountWei: 1n,
      block: GRAD_BLOCK,
      logIndex: 0,
    })
    const initLog = constructedPoolInitializeLog({
      poolManager: POOL_MANAGER,
      poolId: POOL_ID,
      currency0: TOKEN,
      currency1: POOL_QUOTE_CURRENCY,
      hooks: HOOK,
      sqrtPriceX96: SQRT_P,
      block: GRAD_BLOCK,
      logIndex: 1,
    })
    const swap = swapLog({ block: GRAD_BLOCK, logIndex: 2 })

    const events = await fetchRange(
      new FakeNode([gradLog, initLog, swap]),
      // HAVUZ KUMESI BOS BASLAR -- mezuniyet BU ARALIKTA oluyor.
      watchWithPool(new Map()),
      GRAD_BLOCK,
      GRAD_BLOCK,
      { resolveHook: async () => ({ hook: HOOK, poolManager: POOL_MANAGER }) },
    )
    expect(events.map((e) => e.kind)).toEqual(['graduated', 'poolInitialize', 'poolSwap'])
    expect(onlySwap(events).pool?.poolId).toBe(POOL_ID)
  })

  /**
   * `graduate()` ATOMIKTIR: mezuniyet ile havuz acilisi AYNI ISLEMDEDIR. Bir
   * `Graduated` gorup `Initialize` gormemek, turetmenin ya da hedef
   * cozumlemesinin bozuldugunu gosterir -- ve o bozulmanin tek belirtisi
   * SONSUZA KADAR BOS bir havuz sorgusu olurdu.
   */
  it('mezuniyet var ama Initialize yoksa DURULUR', async () => {
    const gradLog = constructedGraduatedLog({
      curve: LIVE.curve,
      token: TOKEN,
      to: LOCKER,
      baseAmountTok: 1n,
      quoteAmountWei: 1n,
      block: GRAD_BLOCK,
      logIndex: 0,
    })
    await expect(
      fetchRange(new FakeNode([gradLog]), watchWithPool(new Map()), GRAD_BLOCK, GRAD_BLOCK, {
        resolveHook: async () => ({ hook: HOOK, poolManager: POOL_MANAGER }),
      }),
    ).rejects.toThrow(PoolNotInitialized)
  })

  /**
   * HEDEF BIR LOCKER DEGILSE HAVUZ DA YOKTUR, ve bu MESRU bir zincir
   * durumudur (prova factory'sinin hedefi `0x…dEaD`). Durmak, o factory'yi
   * indexlemeyi imkansiz kilardi. Sessiz kalmak da olmaz: bir arayuz o token
   * icin "havuzda islem goruyor" diyemez.
   */
  it('hedef locker degilse UYARIR ve devam eder', async () => {
    const seen: Address[] = []
    const gradLog = constructedGraduatedLog({
      curve: LIVE.curve,
      token: TOKEN,
      to: '0x000000000000000000000000000000000000dead' as Address,
      baseAmountTok: 1n,
      quoteAmountWei: 1n,
      block: GRAD_BLOCK,
      logIndex: 0,
    })
    const events = await fetchRange(
      new FakeNode([gradLog]),
      watchWithPool(new Map()),
      GRAD_BLOCK,
      GRAD_BLOCK,
      { resolveHook: async () => null, onTargetWithoutPool: (_t, target) => seen.push(target) },
    )
    expect(events.map((e) => e.kind)).toEqual(['graduated'])
    expect(seen).toEqual(['0x000000000000000000000000000000000000dead'])
  })

  /**
   * `Initialize`IN BES ALANI TURETMEYE KARSI TUTULUR.
   *
   * Yalnizca `PoolId` esitligine bakmak VAKUM olurdu: log zaten o kimlikle
   * suzulerek geldi. Olculen sey ANAHTARIN KENDISIDIR.
   */
  it('Initialize turetilen PoolKey ile ayrisirsa DURULUR', async () => {
    const wrongHook = '0xdd2bb76fa6cf00d9d413559de6337db1875fe0cc' as Address
    const initLog = constructedPoolInitializeLog({
      poolManager: POOL_MANAGER,
      poolId: POOL_ID,
      currency0: TOKEN,
      currency1: POOL_QUOTE_CURRENCY,
      hooks: wrongHook, // turetme HOOK diyor
      sqrtPriceX96: SQRT_P,
      block: SWAP_BLOCK,
      logIndex: 0,
    })
    await expect(
      fetchRange(new FakeNode([initLog]), watchWithPool(), SWAP_BLOCK, SWAP_BLOCK),
    ).rejects.toThrow(PoolKeyMismatch)
  })
})

// ---------------------------------------------------------------------------
// ASIL IDDIA: FIYAT GECMISI KOPMAZ
// ---------------------------------------------------------------------------

describe('mezuniyette fiyat gecmisi KOPMAZ', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
  })

  it('egri ve havuz islemleri TEK bir listede, event_seq sirasinda', async () => {
    // 1. Canli smoke: launch + dort GERCEK egri islemi + Completed.
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const curveOnly = await listTrades(pool, TOKEN, { limit: 50 })
    expect(curveOnly).toHaveLength(4)

    // 2. Mezuniyet.
    const gradEvents = await decodeAll(
      new FakeNode([]),
      [
        constructedGraduatedLog({
          curve: LIVE.curve,
          token: TOKEN,
          to: LOCKER,
          baseAmountTok: 206_886_011_183_597_390_493_942_218n,
          quoteAmountWei: 12_161_433_369_060_378_714n,
          block: GRAD_BLOCK,
          logIndex: 0,
        }),
      ],
      GRAD_BLOCK,
      GRAD_BLOCK,
      createPacer(),
    )
    await applyEvents(pool, LIVE_DEPLOYMENT, gradEvents)

    // 3. Havuz islemleri.
    const poolEvents = await fetchRange(
      new FakeNode([
        swapLog({ logIndex: 0 }),
        swapLog({ logIndex: 3, amount0: -1n * 10n ** 18n, amount1: 500_000n }),
      ]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    const counts = await applyEvents(pool, LIVE_DEPLOYMENT, poolEvents)
    expect(counts.poolSwaps).toBe(2)

    // ALTI SATIR, TEK LISTE, KESINTISIZ. `listTrades` `event_seq DESC`
    // siralar; iki venue de AYNI anahtar uzayindadir.
    const all = await listTrades(pool, TOKEN, { limit: 50 })
    expect(all).toHaveLength(6)
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1]!.eventSeq > all[i]!.eventSeq).toBe(true)
    }
    // En yeni IKI satir havuzdan; `event_seq` mezuniyetin USTUNDE.
    expect(all[0]!.eventSeq).toBe(toSeq(SWAP_BLOCK, 3))
    expect(all[1]!.eventSeq).toBe(toSeq(SWAP_BLOCK, 0))

    // VE HER SATIRIN FIYATI AYNI FORMULLE HESAPLANABILIR: dort rezerv sutunu
    // ALTI satirin da hepsinde DOLU. Bir havuz satirinin bos birakmasi,
    // grafigin mezuniyette KESILMESI demekti.
    for (const row of all) {
      expect(row.virtualTokenReservesTok > 0n).toBe(true)
      expect(row.virtualQuoteReservesWei > 0n).toBe(true)
    }
  })

  it('havuz islemleri hacme ve sayaclara girer, curve_state e GIRMEZ', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const before = await getTokenOverview(pool, TOKEN)
    const beforeVolume = before.rows?.volumeTotalWei ?? 0n
    const beforeVt = before.rows?.virtualTokenReservesTok
    const beforeCount = before.rows?.tradeCount ?? 0

    const events = await fetchRange(
      new FakeNode([swapLog()]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    await applyEvents(pool, LIVE_DEPLOYMENT, events)

    const after = await getTokenOverview(pool, TOKEN)
    // HACIM VE SAYAC TOKEN'IN OLGUSUDUR -- venue'nun degil.
    expect(after.rows?.volumeTotalWei).toBe(beforeVolume + 1_000_000n * QUOTE_SCALE)
    expect(after.rows?.tradeCount).toBe(beforeCount + 1)
    // EGRININ REZERVLERI MEZUNIYETTE DONDU. Bir havuz islemi onlari
    // DEGISTIRMEZ; `applyTrade`in `cs` CTE'sini kopyalamak tam olarak bunu
    // bozardi.
    expect(after.rows?.virtualTokenReservesTok).toBe(beforeVt)
  })

  it('ayni araligi iki kez uygulamak IKINCI seferde hicbir sey yazmaz', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
    const events = await fetchRange(
      new FakeNode([swapLog()]),
      watchWithPool(),
      SWAP_BLOCK,
      SWAP_BLOCK,
    )
    const first = await applyEvents(pool, LIVE_DEPLOYMENT, events)
    expect(first.poolSwaps).toBe(1)
    const before = await getTokenOverview(pool, TOKEN)
    const second = await applyEvents(pool, LIVE_DEPLOYMENT, events)
    expect(second.poolSwaps).toBe(0)
    expect(second.total).toBe(0)
    // VE HACIM IKI KEZ EKLENMEDI -- sayac degil DOKUM olculur.
    expect((await getTokenOverview(pool, TOKEN)).rows?.volumeTotalWei).toBe(
      before.rows?.volumeTotalWei,
    )
  })
})
