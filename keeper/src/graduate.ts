import { argv, env as processEnv, exit } from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertArcChain, createArcClient, formatUsdc } from '@arcpad/shared'
import { type Address, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  type AlertLevel,
  type AlertSink,
  alert,
  assertAlertLogWritable,
  consoleSinkFor,
  createThrottle,
  fileSink,
  heartbeat,
  multiSink,
} from './alert'
import { viemChainReader } from './chainReader'
import { loadRepoEnv } from './env'
import { LOCKER_ABI } from './graduate/abi'
import { viemGraduationWriter } from './graduate/chain'
import { createCompletedWatch } from './graduate/completedWatch'
import {
  GRADUATE_ALERT_COMPONENT,
  type GraduatorConfig,
  loadGraduatorConfig,
  ONCE_MAX_ROUNDS,
} from './graduate/config'
import {
  type GraduationWriter,
  type PassSummary,
  runGraduationPass,
} from './graduate/executor'
import { fileCurveLocks } from './graduate/lock'
import { runPollLoop } from './graduate/loop'
import { assertSelectorsAgree } from './graduate/outcome'
import { fileQuarantineStore } from './graduate/state'
import { type ChainReader, fileCursorStore } from './watch/graduationWindow'

/**
 * ============ GRADUATION YURUTUCUSU -- GIRIS NOKTASI ============
 *
 * `pnpm --filter @arcpad/keeper graduate -- --once`
 *
 * Ayri bir surectir, `pnpm start`in izleyicisi DEGIL. Uc sebep, ve ucu de
 * mevcut kodun kendi kararlarindan gelir:
 *
 *   1. Izleyici SALT OKURDUR ve `config.ts` bunu ADIYLA yazar: "izleyici
 *      Safe'ler kurulmadan, hedef atanmadan, keeper imzalamaya baslamadan
 *      once bile calisir". Ayni surece bir imzalayan koymak o cumleyi
 *      yalanlardi.
 *   2. Imlec dosyalari ayri olmak zorunda (bkz. `config.ts`); ayni surecte
 *      olsalardi tek imlec paylasilirdi ve o daha kirilgan olurdu.
 *   3. Alarm bileseni ayri olmak zorunda: tatbikatin canlilik kapisi
 *      `keeper.graduationWindow` satirlarini sayar, ve yurutucunun kalp
 *      atislari o kapiyi ICI BOS gecirirdi.
 */

/**
 * KURU KOSUDA `eth_call`IN `from`U. `ArcpadLocker.graduate` `msg.sender`a
 * BAKMAZ (izinsizdir), dolayisiyla simulasyonun cevabi bu adresten bagimsizdir
 * -- ve imzalayan varsa ZATEN onun adresi kullanilir. Sifir adres bilincli:
 * gercek bir kullaniciyi taklit etmez.
 *
 * OLCULDU, VARSAYILMADI (2026-08-09, canli Arc, uretim locker'i + tamamlanmis
 * smoke curve): `--from 0x0000...0000` ve `--from <deployer>` AYNI cevabi
 * verdi (`0xfe30fa5b`). Bu kontrol gerekliydi cunku Arc'in `eth_call`i DEGER
 * TASIYAN cagrilarda bakiyeyi zorlar (bu depoda `InsufficientFunds` olarak
 * olculdu); burada `value` sifirdir, dolayisiyla fonsuz bir `from` sorun
 * degildir.
 */
const DRY_RUN_CALLER = '0x0000000000000000000000000000000000000000' as const

/**
 * ZINCIR PINI. Defter yerine env ile kurulan yiginin TEK gercek guvencesi.
 *
 * `loadGraduatorConfig` iki adresi BIRLIKTE ister, ama ikisini birlikte YANLIS
 * yazmak hala mumkundur. Locker'in `factory()` immutable'i o iki adresi zincir
 * uzerinde birbirine baglar: uymuyorsa yurutucu BASLAMAZ. `LOCKER_ABI`de
 * `factory()`nin var olma sebebi budur.
 */
export async function assertLockerMatchesFactory(
  client: ChainReader,
  locker: Address,
  factory: Address,
): Promise<void> {
  const head = await client.getBlock()
  const raw = await client.readContract({
    address: locker,
    abi: LOCKER_ABI,
    functionName: 'factory',
    blockNumber: head.number,
  })
  if (typeof raw !== 'string' || getAddress(raw) !== getAddress(factory)) {
    throw new Error(
      `the locker at ${locker} reports factory ${String(raw)}, but this executor was configured against ${factory}. A locker only accepts curves whose token its own factory knows (CurveNotFromFactory), so a mismatched pair graduates NOTHING while looking perfectly healthy. Refusing to start.`,
    )
  }
}

function levelOf(summary: PassSummary): AlertLevel {
  return summary.outcomes.some((outcome) => outcome.level === 'page') ? 'page' : 'ok'
}

/**
 * `src=` HER SATIRDA, VE SEBEBI SAYFAYI OKUYAN INSANDIR.
 *
 * Defterden kurulmus bir yurutucu ile env ile baska bir yigina yonlendirilmis
 * bir yurutucu, bu alan olmadan ayni saglikli kalp atisini yazardi:
 * `target=0x0 armed=false pending=1` her ikisi icin de dogru olabilir. Yani
 * "yanlis yigini izliyoruz" durumu, pager'in gordugu akista GORUNMEZDI --
 * bu deponun tekrar tekrar odedigi "mekanizma var ama neyi izledigi yazmiyor"
 * sekli. Alan `at=`den SONRA gelir, dolayisiyla onek eslestiren hicbir okuyucu
 * bozulmaz.
 */
export function renderSummary(
  summary: PassSummary,
  opts?: { source?: 'book' | 'env-override' },
): string {
  const parts = [
    `block=${summary.head}`,
    `src=${opts?.source ?? 'book'}`,
    `target=${summary.target}`,
    `armed=${summary.armed}`,
    `known=${summary.knownCurves}`,
    `caughtUp=${summary.caughtUp}`,
    `pending=${summary.pending.length}`,
    `pendingRaise=${formatUsdc(summary.pendingQuoteWei)}USDC`,
    `broadcast=${summary.broadcast}`,
  ]
  for (const outcome of summary.outcomes) {
    parts.push(`${outcome.curve}:${outcome.code}`)
  }
  return parts.join(' ')
}

async function main(): Promise<number> {
  loadRepoEnv()
  // ABI'DEN TURETILEN SELECTOR'LAR CANLI OLCUMLE AYNI MI. Acilista, bir kez.
  // Yanlis bir selector `GraduationTargetUnset`i `unknown-revert` yapardi --
  // yani UYANDIRMAMASI gereken tek sey uyandirirdi.
  assertSelectorsAgree()

  const once = argv.includes('--once')
  // `--book-only` UZUN SURELI SERVISIN BAYRAGIDIR (bkz. `config.ts`). Elle
  // calistirilan tek seferlik yordamlar onu gecmez ve gecmemeli.
  const bookOnly = argv.includes('--book-only')
  const config = loadGraduatorConfig(processEnv, { once, bookOnly })
  const source = config.overridden ? 'env-override' : 'book'

  const sinks: AlertSink[] = [consoleSinkFor(GRADUATE_ALERT_COMPONENT)]
  if (config.alertLogPath !== undefined) {
    assertAlertLogWritable(config.alertLogPath)
    sinks.push(fileSink(config.alertLogPath, { component: GRADUATE_ALERT_COMPONENT }))
  }
  const sink = multiSink(...sinks)

  // `retryCount: 0` -- VE BU OLCULEN BIR DUZELTMEDIR. viem'in varsayilan uc
  // ic denemesi `withRateLimitRetry`in ICINDE, ondan gorunmeden gider; yani
  // "geri cekil" sozlesmesi tam da var olma sebebi olan durumda bozulur.
  // `packages/shared/src/client.ts` bunu canli olarak olctu: UC bosluksuz
  // `eth_getLogs` Arc'ta limiti tetiklemeye YETIYOR, ve varsayilan tek bir
  // mantiksal istegi DORT bosluksuz istege ceviriyor.
  const client = createArcClient(config.rpcUrl, { retryCount: 0 })
  await assertArcChain(client)
  const reader = viemChainReader(client)
  await assertLockerMatchesFactory(reader, config.locker, config.factory)

  const account =
    config.privateKey === undefined ? undefined : privateKeyToAccount(config.privateKey)
  const writer: GraduationWriter = viemGraduationWriter({
    client,
    rpcUrl: config.rpcUrl,
    locker: config.locker,
    account,
    caller: account?.address ?? DRY_RUN_CALLER,
  })

  // ============ IMZALAYAN GAZ ODEYEBILIYOR MU ============
  //
  // Arc'ta gaz varligi USDC'DIR, yani bakiyesi sifir bir imzalayan hicbir
  // graduation'i indiremez. Bunu ACILISTA, BIR KEZ, YUKSEK SESLE reddetmek
  // `parseGovernanceAllowlist`in doldurulmamis governance dosyasini
  // reddetmesiyle ayni karardir: yapilandirma hatasi calisma anina sizmamali.
  //
  // KOSU SIRASINDA tukenmeyi bu satir YAKALAMAZ; onun mercii `send`in
  // basarisizligidir ve o yol ust uste iki gecisten sonra SAYFA cikarir.
  if (account !== undefined && !config.dryRun) {
    const balance = await client.getBalance({ address: account.address })
    if (balance === 0n) {
      throw new Error(
        `the signer ${account.address} holds 0 wei on Arc, where the gas asset IS USDC. It cannot land a single graduation. Fund it (the faucet gives 10 USDC per request) and start again; refusing to run an executor that can only ever fail.`,
      )
    }
    console.log(`signer balance ${balance} wei (${formatUsdc(balance)} USDC)`)
  }

  const store = fileCursorStore(
    config.cursorPath,
    { chainId: config.chainId, factory: config.factory, startBlock: config.startBlock },
    (reason) => {
      alert('ok', `cursor-reset: ${reason}`, sink)
    },
  )
  const quarantine = fileQuarantineStore(
    config.statePath,
    { chainId: config.chainId, factory: config.factory, locker: config.locker },
    {
      onReset: (reason) => {
        alert('ok', `quarantine-reset: ${reason}`, sink)
      },
    },
  )
  const locks = fileCurveLocks(config.lockDir, `pid:${process.pid}@${hostLabel()}`)
  const throttle = createThrottle({})
  const chainErrors = makeCounter()

  console.log(
    `graduator ready chainId=${config.chainId} factory=${config.factory} locker=${config.locker} startBlock=${config.startBlock} dryRun=${config.dryRun} signer=${account?.address ?? '(none -- dry run only)'} source=${config.overridden ? 'ENV OVERRIDE' : 'address book'} cursor=${config.cursorPath} state=${config.statePath} locks=${config.lockDir} alertLog=${config.alertLogPath ?? 'stdout+stderr only'} mode=${once ? 'once' : `loop@${config.pollIntervalMs}ms`} curveBatch=${config.curveBatchSize} completedWatch=${config.completedWatchMs === 0 || once ? 'off' : `${config.completedWatchMs}ms`}`,
  )

  let paged = false
  // ZILIN SORDUGU KUME. Her gecisten sonra tazelenir; bkz.
  // `CompletedWatchDeps.knownCurves` -- bir kez yakalanan kume ilk gecisin
  // kumesinde donup kalirdi.
  let knownCurves: readonly Address[] = []
  const pass = async (): Promise<PassSummary> => {
    const summary = await runGraduationPass({
      client: reader,
      writer,
      factory: config.factory,
      locker: config.locker,
      startBlock: config.startBlock,
      store,
      quarantine,
      locks,
      dryRun: config.dryRun,
      maxPerPass: config.maxPerPass,
      curveBatchSize: config.curveBatchSize,
      chunk: config.logScanChunk,
      maxChunksPerPoll: config.maxChunksPerPass,
      throttle,
      chainErrors,
      alert: (level, _key, message) => {
        if (level === 'page') paged = true
        alert(level, message, sink)
      },
    })
    knownCurves = summary.pending.map((state) => state.curve).concat(store.read()?.curves ?? [])
    // KALP ATISI, IZLEYICININKIYLE AYNI SOZLESME: "bir gecis BASTAN SONA
    // tamamlandi". Yetismemis bir tarama `catching-up`tir ve o AYRI bir
    // iddiadir -- ikisini tek satirda karistirmak, izleyicide olculmus bir
    // hataydi.
    heartbeat(sink, summary.caughtUp ? 'current' : 'catching-up', renderSummary(summary, { source }))
    return summary
  }

  if (once) {
    // ============ `--once` YINE DE BIRDEN COK GECISTIR ============
    //
    // Ve bu bir celiski degil, OLCULMUS bir zorunluluk. Soguk bir imlec
    // uretim defterinde 160.000+ blok geride baslar; hepsini TEK bir gecise
    // sigdirma denemesi canli Arc tarafindan reddedildi (bkz.
    // `ONCE_MAX_CHUNKS_PER_PASS`in NatSpec'i: 16. parcada `rate limit
    // exceeded`, hem de 14 yeniden denemenin ARDINDAN). Imlec parca basina
    // kalicidir, dolayisiyla turlar birbirinin uzerine biner ve aralarindaki
    // bekleme, Arc'in PAYLASILAN butcesine nefes aldirir.
    //
    // "Bir kez kos" sozu KORUNUR: bu dongu ancak tarama BASA VARINCA is
    // yapar ve sonra DURUR -- surekli bir izleyiciye donusmez.
    let summary = await pass()
    for (let round = 1; round < ONCE_MAX_ROUNDS && !summary.caughtUp; round += 1) {
      await sleep(Math.min(config.pollIntervalMs, 3_000))
      summary = await pass()
    }
    const attention = paged || levelOf(summary) === 'page' || !summary.caughtUp
    console.log(
      `GRADUATE PASS ${attention ? 'ATTENTION' : 'OK'}: ${renderSummary(summary, { source })}`,
    )
    return attention ? 1 : 0
  }

  let stopped = false
  const stop = (): void => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  // KENDINI YENIDEN ZAMANLAYAN DONGU, `setInterval` DEGIL -- `index.ts` ile
  // ayni gerekce, ve burada DAHA agirdir: ust uste binen iki gecis AYNI
  // curve'e iki islem gonderebilirdi.
  //
  // VE `main` ARTIK DONGU BITENE KADAR COZULMEZ. Onceki hali ilk gecisten
  // sonra cozuluyordu ve `settle`in 10 saniyelik cikis zamanlayicisi sureci
  // OLDURUYORDU -- olculdu: 13 saniye, tek gecis, cikis kodu 0. Gerekce
  // `graduate/loop.ts`in basinda, olcumle birlikte duruyor.
  // ============ OLAY TETIKLEYICISI, UYKUNUN YERINE ============
  //
  // Bkz. `completedWatch.ts`in dosya basi: `Completed` bir KAPI ZILIDIR,
  // kayit degil. Karar hala slottan verilir; degisen tek sey, siradaki
  // OLAGAN gecisin ne zaman kostugudur. Kapali (0) hali de calisan bir
  // yapilandirmadir ve gecikmeyi bugunku poll araligina birakir.
  const loopDeps: Parameters<typeof runPollLoop>[0] = {
    pass,
    stopped: () => stopped,
    pollIntervalMs: config.pollIntervalMs,
  }
  if (config.completedWatchMs > 0) {
    const watch = createCompletedWatch(
      {
        client: reader,
        knownCurves: () => knownCurves,
        onRing: (detail) => {
          alert('ok', `graduation-doorbell: ${detail}`, sink)
        },
        onError: (detail) => {
          alert('ok', detail, sink)
        },
      },
      { intervalMs: config.completedWatchMs },
    )
    loopDeps.waitBeforeNextPass = (ms) => watch.waitOrRing(ms)
  }
  await runPollLoop(loopDeps)
  return 0
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function hostLabel(): string {
  return processEnv['COMPUTERNAME'] ?? processEnv['HOSTNAME'] ?? 'host'
}

function makeCounter(): { fail(): number; succeed(): void } {
  let consecutive = 0
  return {
    fail: () => (consecutive += 1),
    succeed: () => {
      consecutive = 0
    },
  }
}

/** `drill.ts` ile ayni olculmus gerekce; bkz. oradaki `settle` NatSpec'i. */
function settle(code: number): void {
  process.exitCode = code
  setTimeout(() => {
    exit(code)
  }, 10_000).unref()
}

const entry = argv[1]
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  main()
    .then(settle)
    .catch((error: unknown) => {
      console.error(error)
      settle(1)
    })
}

export type { GraduatorConfig }
