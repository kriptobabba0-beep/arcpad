import { randomInt } from 'node:crypto'
import { argv, env as processEnv, exit } from 'node:process'
import { assertArcChain, arcRpcUrls, createArcClient } from '@arcpad/shared'
import { type Address, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type AlertSink,
  alert,
  assertAlertLogWritable,
  consoleSinkFor,
  createThrottle,
  fileSink,
  heartbeat,
  multiSink,
} from './alert'
import { withRateLimitRetry } from './chainReader'
import { loadRepoEnv } from './env'
import { runPollLoop } from './graduate/loop'
import { FACTORY_ABI, TREASURY_ABI } from './sweep/abi'
import { viemSweepChain } from './sweep/chain'
import { SWEEP_ALERT_COMPONENT, type SweeperConfig, loadSweeperConfig } from './sweep/config'
import { type SweepEvent, type SweepPassResult, candidates, runSweepPass } from './sweep/pass'
import { fileSweepStore } from './sweep/store'

/**
 * ============================================================================
 *  BUYBACK SUPURUCUSU -- GIRIS NOKTASI
 * ============================================================================
 *
 *   pnpm --filter @arcpad/keeper sweep -- --once
 *
 * NICIN VAR OLMASI GEREKIYORDU. `src/sweep/decide.ts` KARARI 19 testle
 * veriyordu ve **hicbir sey onu cagirmiyordu** -- olculdu: `planSweep`in tek
 * referansi kendi test dosyasiydi. Yani buyback ozelliginin anahtarcisi bir
 * MODULDU, bir SUREC degil.
 *
 * BEDELI SESSIZDI VE YEDI GUN SONRA BASLIYORDU. Hicbir test kirmizi olmaz,
 * hicbir alarm calmaz; para hazinede birikir ve `SWEEP_GRACE` (7 gun)
 * dolduktan sonra `sweep` IZINSIZ hale gelir. O andan itibaren cagiran taraf
 * `minTokensOut`u da SECER -- sifir gecebilir, yani slipaj korumasi kapanir ve
 * supurme sandviclenebilir bir alim haline gelir. Anahtarcinin var olma sebebi
 * tam olarak o yedi gundur.
 *
 * ============ UCUNCU SUREC, VE UCUNCU IMLEC ============
 *
 * `pnpm start` (izleyici, SALT OKUR), `pnpm graduate` (mezuniyet, YAZAR),
 * `pnpm sweep` (bu, YAZAR). Ucu de ayri surectir ve gerekce `graduate.ts`te
 * yazili: imlec dosyalari paylasilirsa biri digerinin ilerlemesini geri alir,
 * ve alarm bilesenleri paylasilirsa tatbikatin canlilik kapisi ICI BOS gecer.
 */

const HELP = `
buyback sweeper

  pnpm --filter @arcpad/keeper sweep            # dongu
  pnpm --filter @arcpad/keeper sweep -- --once  # tek gecis, sonra cik

  KEEPER_SWEEP_DRY_RUN=false  ile birlikte KEEPER_SWEEP_PRIVATE_KEY gerekir.
  Varsayilan KURU KOSUDUR: yayin yapabilen bir surecin varsayilani "yayin
  yapma" olmalidir.
`

/**
 * ZINCIR PINI -- yigin defter yerine env ile kurulabildigi icin TEK gercek
 * guvence. Hazinenin `factory()` immutable'i iki adresi zincir uzerinde
 * birbirine baglar; uymuyorsa supurucu BASLAMAZ.
 *
 * Yakaladigi ariza gercektir ve sessizdir: yanlis bir hazine her gecisde
 * `spendable` = 0 okur, her token `nothing-pending` diye atlanir, kalp atisi
 * saglikli akar ve HICBIR SEY supurulmez.
 */
export async function assertTreasuryMatchesFactory(
  read: <T>(args: Parameters<ReturnType<typeof createArcClient>['readContract']>[0]) => Promise<T>,
  treasury: Address,
  factory: Address,
): Promise<void> {
  const reported = await read<Address>({
    address: treasury,
    abi: TREASURY_ABI,
    functionName: 'factory',
  })
  if (getAddress(reported) !== getAddress(factory)) {
    throw new Error(
      `the treasury at ${treasury} reports factory ${reported}, but this sweeper was configured ` +
        `against ${factory}. A mismatched pair reads spendable = 0 for every token and sweeps ` +
        'NOTHING while looking perfectly healthy. Refusing to start.',
    )
  }
}

function renderPass(result: SweepPassResult, config: SweeperConfig, treasury: Address): string {
  const s = result.summary
  return [
    `block=${result.head}`,
    `src=${config.overridden ? 'env-override' : 'book'}`,
    `treasury=${treasury}`,
    `considered=${s.considered}`,
    `swept=${s.swept}`,
    `sent=${result.sent.length}`,
    `refused=${result.refused}`,
    `unreadable=${result.unreadable}`,
    `skip.threshold=${s.skipped['below-threshold']}`,
    `skip.pending=${s.skipped['nothing-pending']}`,
    `skip.quote=${s.skipped['no-quote']}`,
    `skip.auth=${s.skipped['not-authorised']}`,
    `dryRun=${config.dryRun}`,
  ].join(' ')
}

function describeEvent(event: SweepEvent): { level: 'page' | 'ok'; line: string } | null {
  switch (event.kind) {
    case 'sent':
      return {
        // BASARISIZ BIR MAKBUZ BIR SAYFADIR. Simulasyon gecmis ama islem
        // dusmusse aradaki blokta bir sey degismistir ve bunu bir insan
        // gormeli.
        level: event.outcome.status === 'success' ? 'ok' : 'page',
        line: `swept token=${event.token} minOut=${event.minTokensOut} tx=${event.outcome.transactionHash} status=${event.outcome.status} gas=${event.outcome.gasUsed}`,
      }
    case 'simulation-refused':
      // SAYFA DEGIL. Bir simulasyon reddi, gonderilmemis bir islemdir --
      // yani mekanizma TAM OLARAK ISINI YAPMISTIR. Ust uste tekrarlanmasi
      // anlamlidir ve `refused` sayaci gecis satirinda gorunur.
      return {
        level: 'ok',
        line: `simulation-refused token=${event.token} minOut=${event.minTokensOut} detail=${event.detail}`,
      }
    case 'read-failed':
      return { level: 'ok', line: `read-failed token=${event.token} detail=${event.detail}` }
    default:
      return null
  }
}

async function main(): Promise<void> {
  loadRepoEnv()

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  const once = argv.includes('--once')

  const config = loadSweeperConfig(processEnv)
  const client = createArcClient(arcRpcUrls(config.rpcUrl, config.rpcFallbackUrls))
  await assertArcChain(client)

  const read = <T>(args: Parameters<typeof client.readContract>[0]): Promise<T> =>
    withRateLimitRetry(() => client.readContract(args)) as Promise<T>

  /*
   * HAZINE FABRIKADAN OKUNUR, DEFTERDEN DEGIL.
   *
   * `setBuybackTreasury` BIR KEZ yazilir (`LaunchFactory.sol:876`), yani
   * fabrikanin gorunumu bu adresin DEGISTIRILEMEZ kaynagidir. Adres defterine
   * ikinci bir kopya koymak, zincirden sapabilecek bir kopya koymak olurdu --
   * ve bu depo o sinifi zaten iki kez odedi (bayat hook tuzu, V1 hook'una
   * bagli router).
   */
  const treasury =
    config.treasuryOverride ??
    (await read<Address>({
      address: config.factory,
      abi: FACTORY_ABI,
      functionName: 'buybackTreasury',
    }))
  if (getAddress(treasury) === getAddress('0x0000000000000000000000000000000000000000')) {
    throw new Error(
      `the factory at ${config.factory} has no buybackTreasury yet (setBuybackTreasury has not ` +
        'been called). There is nothing for this sweeper to do. Refusing to start.',
    )
  }
  await assertTreasuryMatchesFactory(read, getAddress(treasury), config.factory)

  const account =
    config.privateKey === undefined ? undefined : privateKeyToAccount(config.privateKey)
  const caller = account?.address ?? '0x0000000000000000000000000000000000000000'

  if (config.alertLogPath !== undefined) assertAlertLogWritable(config.alertLogPath)
  const sink: AlertSink =
    config.alertLogPath === undefined
      ? consoleSinkFor(SWEEP_ALERT_COMPONENT)
      : multiSink(consoleSinkFor(SWEEP_ALERT_COMPONENT), fileSink(config.alertLogPath))
  const throttle = createThrottle({})

  const store = fileSweepStore(
    config.cursorPath,
    { chainId: config.chainId, treasury: getAddress(treasury), startBlock: config.startBlock },
    (reason) => {
      alert('ok', `sweep-state-reset: ${reason}`, sink)
    },
  )

  const chain = viemSweepChain({
    client,
    rpcUrl: config.rpcUrl,
    treasury: getAddress(treasury),
    factory: config.factory,
    account,
    caller: getAddress(caller),
  })

  process.stdout.write(
    `sweeper ready chainId=${config.chainId} treasury=${getAddress(treasury)} factory=${config.factory} ` +
      `signer=${account?.address ?? 'none'} dryRun=${config.dryRun} mode=${once ? 'once' : `loop@${config.pollIntervalMs}ms`} ` +
      `slippageBps=${config.policy.maxSlippageBps} jitterMs=${config.policy.jitterWindowMs} ` +
      `state=${config.cursorPath} src=${config.overridden ? 'env-override' : 'book'}\n`,
  )

  let stopped = false
  const stop = (): void => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const pass = async (): Promise<void> => {
    const state = store.read()
    const head = await chain.head()

    /*
     * KESIF, RASYONLANMIS. Zinciri yurume isi indexer'indir; bu surec kendi
     * geri taramasini parca butcesiyle sinirlar. `graduationWindow.ts`nin
     * C6 karariyla ayni gerekce: Arc'in hiz siniri PAYLASILIR ve ard arda
     * elli `eth_getLogs` bir plan degildir (olculdu, canli: on altinci
     * parcada "Request exceeds defined limit").
     */
    /*
     * KESIF DUSERSE GECIS DUSMEZ -- VE BU, CANLI ARC'TA OLCULEREK EKLENDI.
     *
     * Ilk hal `await`i ciplak birakiyordu ve tek bir hiz-siniri hatasi
     * (`eth_getLogs: Request exceeds defined limit`, `withRateLimitRetry`in
     * 14 denemesi TUKENDIKTEN sonra) GECISIN TAMAMINI dusuruyordu -- yani
     * ZATEN BILINEN, butcesi esigi gecmis bir token, ALAKASIZ bir kesif
     * arizasi yuzunden supurulmeden kaliyordu.
     *
     * Ikisi ayri istir: kesif YENI tokenlari bulur, supurme BILINENLERI
     * isler. Kesfin arizasi ikincisini rehin alamaz. Imlec de ilerlemez,
     * yani kacirilan araliK bir sonraki gecisde yeniden denenir.
     */
    let scannedTo = state.scannedTo
    let fresh: Address[] = []
    try {
      for (let i = 0; i < config.maxChunksPerPass && scannedTo < head; i++) {
        const from = scannedTo + 1n
        const to = from + config.logScanChunk - 1n > head ? head : from + config.logScanChunk - 1n
        fresh = [...fresh, ...(await chain.accruedTokens(from, to))]
        scannedTo = to
      }
    } catch (error) {
      alert(
        'ok',
        `discovery-failed at=${scannedTo + 1n} detail=${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        sink,
      )
    }

    const tokens = candidates(state.tokens, fresh)
    // IMLEC VE KUME BIRLIKTE YAZILIR -- bkz. `store.ts`. Gecisin SONUCUNDAN
    // BAGIMSIZ yazilir: kesif ilerledi, supurme baska bir sey.
    store.write({ scannedTo, tokens })

    const result = await runSweepPass({
      chain,
      tokens,
      nowSeconds: Math.floor(Date.now() / 1000),
      jitterSeed: () => randomInt(0, 2 ** 31 - 1),
      policy: config.policy,
      dryRun: config.dryRun,
      maxPerPass: config.maxPerPass,
      onEvent: (event) => {
        const described = describeEvent(event)
        if (described === null) return
        if (throttle.shouldEmit(`${event.kind}:${'token' in event ? event.token : ''}`, Date.now()))
          alert(described.level, described.line, sink)
      },
    })

    // `current`, `live` DEGIL: `WatcherState` iki degerlidir ve tatbikatin
    // canlilik kapisi tam olarak o iki dizeyi sayar. Ucuncu bir dize,
    // kapiyi sessizce bosaltirdi.
    heartbeat(
      sink,
      scannedTo >= head ? 'current' : 'catching-up',
      `${renderPass(result, config, getAddress(treasury))} scannedTo=${scannedTo} head=${head}`,
    )

    for (const s of result.sent) {
      process.stdout.write(
        `swept ${s.token} tx=${s.hash} status=${s.outcome.status} gas=${s.outcome.gasUsed}\n`,
      )
    }
  }

  if (once) {
    await pass()
    return
  }
  await runPollLoop({
    pass,
    stopped: () => stopped,
    pollIntervalMs: config.pollIntervalMs,
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
})
