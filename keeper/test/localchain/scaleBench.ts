import { spawn, type ChildProcess } from 'node:child_process'
import { argv, env as processEnv, exit } from 'node:process'
import { MULTICALL3_ADDRESS } from '@arcpad/shared'
import {
  type Address,
  createPublicClient,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  http,
  parseAbi,
} from 'viem'
import { viemChainReader } from '../../src/chainReader'
import { COMPLETED_EVENT } from '../../src/graduate/completedWatch'
import {
  CURVE_WATCH_ABI,
  type ChainReader,
  scanCurveStates,
} from '../../src/watch/graduationWindow'

/**
 * ============ OLCEK OLCUMU: "YUZLERCE CURVE AYNI ANDA HAZIRSA?" ============
 *
 * `pnpm --filter @arcpad/keeper scale-bench -- --arc`     (CANLI ARC, SALT OKUR)
 * `pnpm --filter @arcpad/keeper scale-bench -- --local`   (KENDI ANVIL'INI ACAR)
 *
 * SORU: keeper yalnizca IKI curve'e karsi kosmustur. N buyudugunde bir gecis
 * ne kadar surer, ve poll araligini (15 s) asar mi?
 *
 * ============ HANGI PARCA GERCEK, HANGISI MODEL ============
 *
 * Bu ayrimi yazmak zorunlu, cunku savunulamayan bir sayi "olculmedi"den
 * KOTUDUR.
 *
 *   --arc   TAMAMEN GERCEK. Canli Arc testnet RPC'sine karsi SALT OKUR
 *           `eth_call`lar. Iki sey olcer:
 *             (L1) tek bir `eth_call`in gidis-donusu -- MODELIN BIRIM MALIYETI
 *             (L2) `aggregate3`in Arc'ta kac ALT CAGRI tasidigi -- PARCA BOYU
 *           Hicbir islem yayinlanmaz; yalnizca `eth_call`.
 *
 *   --local GERCEK: anvil (Arc fork'u), gercek JSON-RPC, gercek viem yigini,
 *           gercek `scanCurveStates`, ve fork'un tasidigi GERCEK Multicall3
 *           (0xcA11...CA11, kanonik, Arc'ta canli).
 *           MODEL: N curve'un KENDISI. Arc'ta yalnizca iki curve var, ve bu
 *           gorev `forge` calistiramaz. N-2 tanesi elle yazilmis 167 baytlik
 *           bir runtime ile `anvil_setCode` uzerinden yerlestirilir; uc slotu
 *           (`complete`/`graduated`/`realQuoteReserves`) SABIT dondurur.
 *           NEDEN SADIK: `scanCurveStates` bu uc `view` cagrisindan baska bir
 *           sey yapmaz -- dondurulen degerin NEREDEN geldigi (SLOAD mi PUSH32
 *           mu) cagri SAYISINI, ABI kodlamasini, gidis-donus sayisini ya da
 *           istemci tarafi isi DEGISTIRMEZ.
 *           MODEL DEGIL AMA SADIK DA DEGIL: anvil'in gecikmesi ve hiz siniri.
 *           Loopback anvil ~0 ms ag gecikmesi verir ve HIC hiz sinirlamaz.
 *           Bu yuzden --local sayilari CAGRI SAYISI ve ISTEMCI ISI icin
 *           gecerlidir; ARC'taki sureyi vermezler. Arc'taki sure L1 x cagri
 *           sayisi ile HESAPLANIR ve o hesap raporda AYRI durur.
 *
 * ============ NE OLCULMEZ ============
 *
 * Graduation'in KENDISI. Bu betik hicbir sey yayinlamaz. `maxPerPass`
 * verimliligi `keeper/test/localchain/graduationProof.ts`in isidir.
 */

const ARC_RPC = processEnv['ARC_RPC_URL'] ?? 'https://rpc.testnet.arc.network'
const REQUESTED_PORT = Number(processEnv['KEEPER_BENCH_PORT'] ?? 58_561)
/** Yerel zincir Arc'in kimligini TASIR ama Arc DEGILDIR; bkz. `measureLocal`. */
const LOCAL_CHAIN_ID = 5_042_002

/** Uretim yigini -- defterden. Bu betik HICBIRINE yazmaz. */
const PROD_CURVE_COMPLETE = '0xDdB9e739a948c968eB4C7E1449B94C598B1cf27B' as Address
const PROD_CURVE_OPEN = '0x53Bba88F1b9897A8B61c860E9E7413ca1a1644c9' as Address

const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

// ---------------------------------------------------------------
// ELLE YAZILMIS CURVE STAND-IN'I -- 167 bayt, `forge` YOK
// ---------------------------------------------------------------

/**
 * Uc selector'u sabit bir 32 baytlik kelimeye eslestiren minimal bir
 * dagitici. Duzen (uretilen bayt sirasiyla):
 *
 *   0x00  6000 35 60e0 1c        PUSH1 0 CALLDATALOAD PUSH1 0xe0 SHR -> sel
 *   her giris (10 bayt):
 *         80 63<sel> 14 60<dest> 57     DUP1 PUSH4 EQ PUSH1 JUMPI
 *   dusus (5 bayt):
 *         6000 6000 fd            REVERT (bos veri) -- BILINMEYEN SELECTOR
 *   her isleyici (42 bayt):
 *         5b 7f<32 bayt> 6000 52 6020 6000 f3
 *         JUMPDEST PUSH32 MSTORE RETURN
 *
 * Bilinmeyen selector'de REVERT etmesi kasitlidir: `0x00` (STOP) dondurseydi
 * her cagri BOS VERIYLE BASARILI olurdu, ki bu tam olarak asagida AYRI bir
 * stand-in ile olculen tehlikeli sekildir.
 */
function curveStandIn(slots: { complete: boolean; graduated: boolean; realQuoteWei: bigint }): Hex {
  const entries: Array<{ selector: string; word: bigint }> = [
    { selector: '522e1177', word: slots.complete ? 1n : 0n }, // complete()
    { selector: 'e7c2b772', word: slots.graduated ? 1n : 0n }, // graduated()
    { selector: 'c196c7c5', word: slots.realQuoteWei }, // realQuoteReserves()
  ]
  const headerLength = 6
  const entryLength = 10
  const fallthroughLength = 5
  const handlerLength = 42
  const firstHandler = headerLength + entryLength * entries.length + fallthroughLength

  let code = '600035' + '60e0' + '1c'
  entries.forEach((_, index) => {
    const dest = firstHandler + handlerLength * index
    if (dest > 0xff) throw new Error('stand-in handler offset exceeds PUSH1')
    code += `80${'63'}${entries[index]!.selector}14${'60'}${dest.toString(16).padStart(2, '0')}57`
  })
  code += '60006000fd'
  for (const entry of entries) {
    code += `5b7f${entry.word.toString(16).padStart(64, '0')}600052602060` + '00f3'
  }
  return `0x${code}` as Hex
}

/** Her cagriyi BOS VERIYLE reddeder. `success:false, returnData:0x`. */
const REVERT_EMPTY_RUNTIME = '0x60006000fd' as Hex

/**
 * Her cagriyi BOS VERIYLE KABUL eder -- `STOP`.
 *
 * BU, `allowFailure` TEHLIKESININ EN KOTU HALIDIR VE BIR REVERT DEGILDIR:
 * `aggregate3` bunu `success:TRUE, returnData:0x` olarak bildirir. Ham bir
 * cozucu icin "bos veri" cok kolayca `false`a / `0`a doner. Kod olmayan bir
 * adres de AYNI seyi uretir (CALL bos donus ile basarir) -- ve runbook'un
 * `OVER-reporting` dali tam olarak o durumu (reorg olmus bir `Launched`,
 * baska bir zincirin imleci) GERCEK bir hal olarak sayar.
 */
const EMPTY_RETURN_RUNTIME = '0x00' as Hex

// ---------------------------------------------------------------
// Kucuk iddia catisi -- vitest YOK (betik kendi anvil'ini acar)
// ---------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
    return
  }
  failures.push(label)
  console.error(`  FAIL  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error !== undefined) throw new Error(body.error.message ?? JSON.stringify(body.error))
  return body.result
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

// ---------------------------------------------------------------
// L1/L2 -- CANLI ARC, SALT OKUR
// ---------------------------------------------------------------

async function measureArc(): Promise<void> {
  console.log(`\n=== L1: single eth_call round trip, live Arc (${ARC_RPC}) ===`)
  const completeData = encodeFunctionData({ abi: CURVE_WATCH_ABI, functionName: 'complete' })
  const samples: number[] = []
  let limited = 0
  const SAMPLES = 20
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now()
    try {
      await rpc(ARC_RPC, 'eth_call', [
        { to: PROD_CURVE_COMPLETE, data: completeData },
        'latest',
      ])
      samples.push(performance.now() - started)
    } catch (error) {
      limited += 1
      console.log(`  sample ${i}: REFUSED ${error instanceof Error ? error.message : String(error)}`)
    }
    // ARC'IN HIZ SINIRI PAYLASILIR. Bu betik onu tuketmek icin degil OLCMEK
    // icin var; 600 ms ara AGENT-CONTEXT'in olctugu 100 ms tabanindan bol
    // bol yukaridir.
    await sleep(600)
  }
  console.log(
    `  n=${samples.length}/${SAMPLES} ok (${limited} refused)  min=${Math.min(...samples).toFixed(1)}ms  median=${median(samples).toFixed(1)}ms  max=${Math.max(...samples).toFixed(1)}ms`,
  )
  check('L1 produced a usable sample', samples.length >= SAMPLES / 2, `${samples.length} samples`)

  console.log('\n=== L2: aggregate3 sub-call ceiling on live Arc ===')
  console.log(`  Multicall3 ${MULTICALL3_ADDRESS}, sub-call = ${PROD_CURVE_COMPLETE}.complete()`)
  let lastGood = 0
  let firstBad = 0
  // LADDER YUKARI GIDER TA KI DUVARA CARPANA KADAR. Parca boyu OLCUMDEN
  // gelmelidir; "3200 calisiyor" tek basina duvarin NEREDE oldugunu soylemez
  // ve headroom'suz secilen bir sabit, gunun birinde sessizce yarim tarama
  // uretir.
  for (const width of [10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12_800, 25_600]) {
    const calls = Array.from({ length: width }, () => ({
      target: PROD_CURVE_COMPLETE,
      allowFailure: true,
      callData: completeData,
    }))
    const data = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [calls],
    })
    const started = performance.now()
    try {
      const result = (await rpc(ARC_RPC, 'eth_call', [
        { to: MULTICALL3_ADDRESS, data },
        'latest',
      ])) as string
      const elapsed = performance.now() - started
      lastGood = width
      console.log(
        `  width=${String(width).padStart(5)}  OK   ${elapsed.toFixed(0).padStart(6)}ms  request=${data.length / 2}B  response=${result.length / 2}B`,
      )
    } catch (error) {
      firstBad = width
      console.log(
        `  width=${String(width).padStart(5)}  FAIL ${(performance.now() - started).toFixed(0).padStart(6)}ms  ${error instanceof Error ? error.message : String(error)}`,
      )
      break
    }
    await sleep(2_000)
  }
  check(
    'L2 found the aggregate3 wall',
    lastGood > 0 && firstBad > 0,
    `largest accepted=${lastGood}, first refused=${firstBad === 0 ? 'NONE FOUND -- the ladder topped out' : firstBad}`,
  )

  // TEKRARLANABILIRLIK. Tek bir olcum bir sayi degildir; asagidaki genislikler
  // uc kez kosulur, cunku secilecek sabit BUNLARDAN biri olacak.
  console.log('\n=== L3: repeatability at the candidate chunk widths ===')
  for (const width of [100, 250, 500]) {
    const calls = Array.from({ length: width }, () => ({
      target: PROD_CURVE_COMPLETE,
      allowFailure: true,
      callData: completeData,
    }))
    const data = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [calls],
    })
    const runs: number[] = []
    let refused = 0
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now()
      try {
        await rpc(ARC_RPC, 'eth_call', [{ to: MULTICALL3_ADDRESS, data }, 'latest'])
        runs.push(performance.now() - started)
      } catch (error) {
        refused += 1
        console.log(`    width=${width} run ${i}: ${error instanceof Error ? error.message : ''}`)
      }
      await sleep(1_500)
    }
    console.log(
      `  width=${String(width).padStart(4)}  runs=[${runs.map((r) => r.toFixed(0)).join(', ')}]ms  refused=${refused}`,
    )
  }

  // ============ L4: BIR CURVE'UN ARC'TAKI GERCEK BEDELI ============
  //
  // Bu, ardisik taramanin CURVE BASINA odedigi seydir ve modelin degil
  // OLCUMUN vermesi gereken sayidir: `scanCurveStates` curve basina UC
  // `eth_call`i `Promise.all` ile ES ZAMANLI yayar. AGENT-CONTEXT alti es
  // zamanli cagrida 2/6 olctu, yani uc es zamanli cagri ZATEN cekismeli
  // bolgededir -- "77 ms x 3'u paralel say" bir VARSAYIM olurdu.
  console.log('\n=== L4: ONE curve, exactly as scanCurveStates reads it (3 concurrent eth_call) ===')
  const slotData = (['complete', 'graduated', 'realQuoteReserves'] as const).map((functionName) =>
    encodeFunctionData({ abi: CURVE_WATCH_ABI, functionName }),
  )
  const rounds: number[] = []
  let roundRefusals = 0
  for (let i = 0; i < 10; i += 1) {
    const started = performance.now()
    const settled = await Promise.allSettled(
      slotData.map((data) =>
        rpc(ARC_RPC, 'eth_call', [{ to: PROD_CURVE_COMPLETE, data }, 'latest']),
      ),
    )
    rounds.push(performance.now() - started)
    roundRefusals += settled.filter((entry) => entry.status === 'rejected').length
    await sleep(1_000)
  }
  console.log(
    `  n=10 rounds  min=${Math.min(...rounds).toFixed(1)}ms  median=${median(rounds).toFixed(1)}ms  max=${Math.max(...rounds).toFixed(1)}ms  refused=${roundRefusals}/30 sub-calls`,
  )
  check('L4 measured the per-curve cost', rounds.length === 10, `median ${median(rounds).toFixed(1)}ms`)

  // ============ L5: BATCH'IN GERCEK SEKLI ============
  //
  // L2/L3 yalnizca `complete()` yayiyordu. Gercek parca UC slotu KARISIK
  // tasir; secilecek sabit o sekle karsi olculmelidir.
  console.log('\n=== L5: a realistic 500-sub-call chunk (the three slots, interleaved) ===')
  const mixed = Array.from({ length: 500 }, (_, i) => ({
    target: PROD_CURVE_COMPLETE,
    allowFailure: true,
    callData: slotData[i % 3]!,
  }))
  const mixedData = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [mixed],
  })
  const mixedRuns: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now()
    await rpc(ARC_RPC, 'eth_call', [{ to: MULTICALL3_ADDRESS, data: mixedData }, 'latest'])
    mixedRuns.push(performance.now() - started)
    await sleep(1_500)
  }
  console.log(
    `  500 sub-calls (=167 curves)  runs=[${mixedRuns.map((r) => r.toFixed(0)).join(', ')}]ms  median=${median(mixedRuns).toFixed(1)}ms  request=${mixedData.length / 2}B`,
  )
  check('L5 measured the real chunk shape', mixedRuns.length === 3, `median ${median(mixedRuns).toFixed(1)}ms`)

  // ============ L6: TOPLU YOL, GERCEK ZINCIRDE, GERCEK CURVE'LERE KARSI ====
  //
  // Yerel olcum SENTETIK curve'ler kullanir. Bu adim onun yapamadigi tek seyi
  // yapar: toplu cozumun GERCEK `BondingCurve` slotlarindan, GERCEK Multicall3
  // uzerinden, ardisik yolla AYNI cevabi verdigini olcer. Yalnizca `eth_call`.
  console.log('\n=== L6: batched == sequential, live Arc, the two REAL production curves ===')
  const arcClient = createPublicClient({ transport: http(ARC_RPC, { retryCount: 0 }) })
  const arcReader = viemChainReader(arcClient as never)
  const realCurves = [PROD_CURVE_COMPLETE, PROD_CURVE_OPEN]
  const arcHead = BigInt((await rpc(ARC_RPC, 'eth_blockNumber', [])) as string)
  const arcSequential = await scanCurveStates(sequentialOnly(arcReader), realCurves, arcHead)
  await sleep(1_000)
  const arcBatched = await scanCurveStates(arcReader, realCurves, arcHead)
  const render = (states: readonly unknown[]): string =>
    JSON.stringify(states, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  check(
    'batched and sequential agree on the live production curves',
    render(arcSequential) === render(arcBatched),
    render(arcBatched),
  )
  check(
    'the live smoke curve still reads complete, and the e2e curve still open',
    arcBatched[0]?.complete === true && arcBatched[1]?.complete === false,
    `smoke.complete=${arcBatched[0]?.complete} e2e.complete=${arcBatched[1]?.complete}`,
  )

  // ============ L7: KAPI ZILININ SURDURULEBILIR ARALIGI ============
  //
  // Zil, olagan gecisler ARASINDA `Completed` icin bir `eth_getLogs` atar.
  // Gorev tanimi ~350 ms (blok basina bir sorgu) istiyor; asagisi o talebin
  // ve secilen 2000 ms varsayilanin OLCUMUDUR, secim degil.
  console.log('\n=== L7: sustained Completed watch -- what cadence does Arc actually take? ===')
  const completedTopic = encodeEventTopics({ abi: [COMPLETED_EVENT], eventName: 'Completed' })[0]
  for (const cadenceMs of [2_000, 350]) {
    const windowMs = 20_000
    const started = performance.now()
    let sent = 0
    let refused = 0
    const latencies: number[] = []
    while (performance.now() - started < windowMs) {
      const head = BigInt((await rpc(ARC_RPC, 'eth_blockNumber', [])) as string)
      const at = performance.now()
      try {
        await rpc(ARC_RPC, 'eth_getLogs', [
          { fromBlock: `0x${(head - 2n).toString(16)}`, toBlock: `0x${head.toString(16)}`, topics: [completedTopic] },
        ])
        latencies.push(performance.now() - at)
      } catch (error) {
        refused += 1
        if (refused <= 2) {
          console.log(`    refused: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      sent += 1
      const spent = performance.now() - at
      if (spent < cadenceMs) await sleep(cadenceMs - spent)
    }
    const perSecond = (sent * 2) / (windowMs / 1000)
    console.log(
      `  cadence=${String(cadenceMs).padStart(4)}ms  ${sent} rounds in ${(windowMs / 1000).toFixed(0)}s  refused=${refused}  medianLatency=${latencies.length === 0 ? 'n/a' : `${median(latencies).toFixed(0)}ms`}  ~${perSecond.toFixed(2)} req/s (eth_blockNumber + eth_getLogs)`,
    )
    await sleep(3_000)
  }

  // ============ ARC'TAKI GECIS SURESI, OLCULEN BIRIMLERDEN ============
  //
  // ARITMETIK BURADA DURUR, DUZ YAZIDA DEGIL: her carpan yukarida OLCULMUS
  // bir medyandir.
  //
  // BUNLAR ALT SINIRDIR ve oyle etiketlenmelidir. Ardisik taraf her curve'un
  // uc cagrisinin ES ZAMANLI gittigini ve HICBIRININ hiz sinirina takilmadigini
  // varsayar; Arc es zamanli cagrilari sinirlar (olculdu: 6 es zamanli -> 2/6),
  // ve her geri cekilme 200..2000 ms ekler. Yani gercek sure BUNDAN BUYUKTUR.
  // Sonucun yonu bu yuzden saglamdir: iyimser tarafta bile ardisik yol duser.
  const perCurveMs = median(rounds)
  const perChunkMs = median(mixedRuns)
  console.log('\n=== Arc-projected pass duration (FLOOR: assumes zero rate-limit backoff) ===')
  console.log(`    unit costs measured above: L4 per curve = ${perCurveMs.toFixed(1)}ms, L5 per 500-sub-call chunk = ${perChunkMs.toFixed(1)}ms`)
  for (const n of BENCH_SIZES) {
    const chunks = Math.ceil((3 * n) / 500)
    const sequential = n * perCurveMs
    const batched = chunks * perChunkMs
    console.log(
      `  N=${String(n).padStart(4)}  sequential >= ${(sequential / 1000).toFixed(2).padStart(7)}s (${n} rounds)   batched >= ${(batched / 1000).toFixed(2).padStart(6)}s (${chunks} chunk${chunks === 1 ? '' : 's'})   poll interval 15.00s`,
    )
  }
}

// ---------------------------------------------------------------
// S1 -- YEREL ANVIL, N CURVE
// ---------------------------------------------------------------

const BENCH_SIZES = (processEnv['KEEPER_BENCH_SIZES'] ?? '2,25,100,500')
  .split(',')
  .map((entry) => Number(entry.trim()))

function syntheticCurve(index: number): Address {
  return `0x${(0xc0de0000n + BigInt(index)).toString(16).padStart(40, '0')}` as Address
}

async function measureLocal(): Promise<void> {
  const port = REQUESTED_PORT
  let anvil: ChildProcess | undefined

  // ============ NEDEN FORK DEGIL, VE BU OLCULEREK OGRENILDI ============
  //
  // ILK HALI `anvil --fork-url <Arc>` idi ve CANLI ARC'A CARPTI: fork'ta
  // `anvil_setCode` once hesabi YUKARI AKISTAN ceker, yani 500 sentetik curve
  // 500 upstream istegi demektir ve 130. civarinda duser --
  //   `failed to get account for 0x...c0De0129: HTTP 429 {"code":-32005}`
  // Yani olcum aracinin kendisi, olcmeye calistigi hiz sinirini tetikliyordu.
  //
  // Duzeltme: fork YOK. Bos bir anvil, ve Multicall3'un GERCEK runtime
  // bytecode'u canli Arc'tan TEK bir `eth_getCode` ile alinip kanonik adrese
  // yerlestirilir. Calisan sey hala Arc'in tasidigi Multicall3'un ta kendisi;
  // yalnizca onu getirme bedeli 500'den 1'e iner.
  //
  // KAYBEDILEN: fork'un tasidigi IKI GERCEK CURVE. O bosluk `--arc`in L6'si
  // ile kapatilir -- toplu ve ardisik yol CANLI zincirde, gercek curve'lere
  // karsi karsilastirilir; bir fork'un yapabileceginden daha guclu.
  const multicallCode = (await rpc(ARC_RPC, 'eth_getCode', [
    MULTICALL3_ADDRESS,
    'latest',
  ])) as string
  check(
    'the REAL Multicall3 runtime was fetched from live Arc',
    (multicallCode.length - 2) / 2 === 3808,
    `${MULTICALL3_ADDRESS} carries ${(multicallCode.length - 2) / 2} bytes on Arc`,
  )

  try {
    anvil = await startAnvil(port)
    const url = `http://127.0.0.1:${port}`

    // PORT DOGRULAMASI. AGENT-CONTEXT'in Postgres dersi: istedigin portun
    // aldigin port oldugunu YAZMADAN ONCE dogrula.
    const chainIdHex = (await rpc(url, 'eth_chainId', [])) as string
    check(
      'the port answered is the port asked for, and it is OUR chain',
      Number(BigInt(chainIdHex)) === LOCAL_CHAIN_ID,
      `port=${port} chainId=${BigInt(chainIdHex)}`,
    )

    await rpc(url, 'anvil_setCode', [MULTICALL3_ADDRESS, multicallCode])
    const localCode = (await rpc(url, 'eth_getCode', [MULTICALL3_ADDRESS, 'latest'])) as string
    check(
      'the local chain carries byte-identical Multicall3',
      localCode.toLowerCase() === multicallCode.toLowerCase(),
      `${(localCode.length - 2) / 2} bytes`,
    )

    const largest = Math.max(...BENCH_SIZES)
    const standIn = curveStandIn({ complete: false, graduated: false, realQuoteWei: 0n })
    const completedStandIn = curveStandIn({
      complete: true,
      graduated: false,
      realQuoteWei: 12_161_433_369_060_378_713n,
    })
    for (let i = 0; i < largest; i += 1) {
      // HER ONUNCUSU TAMAMLANMIS. Duz bir "hicbiri hazir degil" kumesi,
      // `realQuoteReserves` cozumunu HIC calistirmaz ve olcum bekleyen
      // curve'leri olmayan bir taramanin bedelini olcerdi.
      await rpc(url, 'anvil_setCode', [syntheticCurve(i), i % 10 === 0 ? completedStandIn : standIn])
    }
    const head = BigInt((await rpc(url, 'eth_blockNumber', [])) as string)
    console.log(`\n  etched ${largest} synthetic curves (${(standIn.length - 2) / 2} bytes each), head=${head}`)

    const client = createPublicClient({ transport: http(url, { retryCount: 0 }) })
    const reader = viemChainReader(client as never)

    // STAND-IN'IN GERCEKTEN DOGRU CEVAP VERDIGI. Olculmeden kullanilan bir
    // fake, bu deponun 5 numarali ariza sekli.
    const openState = await scanCurveStates(reader, [syntheticCurve(1)], head)
    const doneState = await scanCurveStates(reader, [syntheticCurve(0)], head)
    check(
      'the stand-in answers all three slots, and the two shapes differ',
      openState[0]?.complete === false &&
        openState[0]?.realQuoteWei === null &&
        doneState[0]?.complete === true &&
        doneState[0]?.graduated === false &&
        doneState[0]?.realQuoteWei === 12_161_433_369_060_378_713n,
      `open=${JSON.stringify(openState[0], bigintText)} completed=${JSON.stringify(doneState[0], bigintText)}`,
    )

    console.log('\n=== S1: scanCurveStates pass duration, local chain ===')
    console.log('    real JSON-RPC + real viem + real Multicall3 bytecode; synthetic curves.')
    console.log('    LOOPBACK: ~0 ms network latency and NO rate limit, so these are the CALL')
    console.log('    COUNT and CLIENT-SIDE cost only. Arc-side duration is L1/L4/L5 x that count.')
    const results: Array<{ n: number; sequentialMs: number; batchedMs: number }> = []
    for (const n of BENCH_SIZES) {
      const curves = curveSet(n)

      const seqStart = performance.now()
      const seq = await scanCurveStates(sequentialOnly(reader), curves, head)
      const sequentialMs = performance.now() - seqStart

      const batStart = performance.now()
      const bat = await scanCurveStates(reader, curves, head)
      const batchedMs = performance.now() - batStart

      check(
        `N=${n}: batched and sequential agree on every slot`,
        JSON.stringify(seq, bigintText) === JSON.stringify(bat, bigintText),
        `${seq.length} curves, ${seq.filter((state) => state.complete && !state.graduated).length} pending`,
      )
      results.push({ n, sequentialMs, batchedMs })
      console.log(
        `  N=${String(n).padStart(4)}  sequential ${sequentialMs.toFixed(0).padStart(7)}ms (${3 * n} eth_call)   batched ${batchedMs.toFixed(0).padStart(7)}ms`,
      )
    }
    console.log(`\n  ${JSON.stringify(results)}`)

    // ============ ALLOWFAILURE TEHLIKESI, GERCEK ZINCIRDE ============
    console.log('\n=== S2: a broken curve must THROW, not decode ===')
    const reverting = syntheticCurve(900_001)
    await rpc(url, 'anvil_setCode', [reverting, REVERT_EMPTY_RUNTIME])
    await assertThrows(
      'a REVERTING curve throws through the batched path (was: a revert throws sequentially)',
      () => scanCurveStates(reader, [syntheticCurve(0), reverting], head),
      reverting,
    )

    const stopping = syntheticCurve(900_002)
    await rpc(url, 'anvil_setCode', [stopping, EMPTY_RETURN_RUNTIME])
    await assertThrows(
      'a curve returning EMPTY DATA ON SUCCESS throws (aggregate3 reports success:true)',
      () => scanCurveStates(reader, [syntheticCurve(0), stopping], head),
      stopping,
    )

    const codeless = syntheticCurve(900_003)
    await assertThrows(
      'a CODELESS curve throws (a reorged-out Launched is a real state, per the runbook)',
      () => scanCurveStates(reader, [syntheticCurve(0), codeless], head),
      codeless,
    )
  } finally {
    if (anvil !== undefined) await stopAnvil(anvil)
  }
}

function curveSet(n: number): Address[] {
  return Array.from({ length: n }, (_, i) => syntheticCurve(i))
}

function bigintText(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** `readContractBatch`i gizleyerek ESKI (ardisik) yolu zorlar. */
function sequentialOnly(reader: ChainReader): ChainReader {
  return {
    getBlock: reader.getBlock.bind(reader),
    readContract: reader.readContract.bind(reader),
    getLogs: reader.getLogs.bind(reader),
  }
}

async function assertThrows(
  label: string,
  operation: () => Promise<unknown>,
  mustName: Address,
): Promise<void> {
  try {
    const value = await operation()
    check(label, false, `it RETURNED ${JSON.stringify(value)} instead of throwing`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(
      label,
      message.toLowerCase().includes(mustName.toLowerCase()),
      `threw, and the message names the curve: ${message.slice(0, 160)}`,
    )
  }
}

// ---------------------------------------------------------------
// anvil -- graduationProof.ts ile AYNI disiplin, ayni olculmus sebeplerle
// ---------------------------------------------------------------

async function assertPortIsFree(port: number): Promise<void> {
  try {
    await rpc(`http://127.0.0.1:${port}`, 'eth_chainId', [])
  } catch {
    return
  }
  throw new Error(
    `something is ALREADY listening on 127.0.0.1:${port} and answering JSON-RPC. This script refuses to reuse it: a leftover node carries another run's state. Stop it (Windows: taskkill /F /IM anvil.exe) or set KEEPER_BENCH_PORT.`,
  )
}

function anvilBinary(): string {
  return process.platform === 'win32' ? 'anvil.exe' : 'anvil'
}

async function startAnvil(port: number): Promise<ChildProcess> {
  await assertPortIsFree(port)
  // `shell: false` -- Windows'ta `shell: true` bir `cmd.exe` acar ve
  // `child.kill()` yalnizca kabugu oldurur; anvil YETIM KALIR.
  const child = spawn(
    anvilBinary(),
    [
      '--chain-id',
      String(LOCAL_CHAIN_ID),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let fatal: string | undefined
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text === '') return
    console.error(`  [anvil] ${text}`)
    if (/os error 10048|address( already)? in use/i.test(text)) fatal = text
  })

  const deadline = Date.now() + 120_000
  for (;;) {
    if (fatal !== undefined) throw new Error(`anvil could not bind port ${port}: ${fatal}`)
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`)
    try {
      await rpc(`http://127.0.0.1:${port}`, 'eth_chainId', [])
      return child
    } catch {
      if (Date.now() > deadline) throw new Error(`anvil did not come up on port ${port}`)
      await sleep(400)
    }
  }
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }
}

async function main(): Promise<number> {
  const wantsArc = argv.includes('--arc') || !argv.includes('--local')
  const wantsLocal = argv.includes('--local') || !argv.includes('--arc')
  if (wantsArc) await measureArc()
  if (wantsLocal) await measureLocal()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.error(`  FAILED: ${failure}`)
  return failures.length === 0 ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
    setTimeout(() => exit(code), 5_000).unref()
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
    setTimeout(() => exit(1), 5_000).unref()
  })
