import { ARC_TESTNET_CHAIN_ID, assertArcChain, createArcClient } from '@arcpad/shared'
import type { Address } from 'viem'
import {
  alert,
  assertAlertLogWritable,
  consoleSink,
  createLiveness,
  createThrottle,
  DEFAULT_REPEAT_AFTER_MS,
  fileSink,
  heartbeat,
  multiSink,
} from './alert'
import { viemChainReader } from './chainReader'
import { loadKeeperConfig, loadWatcherConfig } from './config'
import { loadRepoEnv } from './env'
import {
  assertFactoryMatchesGovernance,
  fileCursorStore,
  runWatcher,
} from './watch/graduationWindow'

async function main(): Promise<void> {
  // DEPO KOKUNDEKI `.env`, CALISMA DIZINDEKI DEGIL. Bkz. `loadRepoEnv`:
  // `pnpm --filter @arcpad/keeper start` -- runbook'un yazdigi komut --
  // calisma dizinini `keeper/` yapar ve `import 'dotenv/config'` orada
  // `.env` bulamazdi, yani belgelenmis baslatma komutu HIC BASLAMIYORDU.
  loadRepoEnv()

  const config = loadKeeperConfig(process.env)
  const watcher = loadWatcherConfig(process.env)
  const client = createArcClient(config.rpcUrl)
  await assertArcChain(client)

  const reader = viemChainReader(client)

  // ZINCIR PINI, HER SEYDEN ONCE. Defterin dizini env'e acik oldugu icin
  // factory'yi commit'li bir dosyaya baglayan tek sey budur; bkz.
  // `assertFactoryMatchesGovernance`. Bir poll bile atilmadan once duser.
  await assertFactoryMatchesGovernance(reader, watcher.factory, watcher.allowlist)

  const liveness = createLiveness({ pollIntervalMs: config.pollIntervalMs }, Date.now())
  const throttle = createThrottle({ repeatAfterMs: watcher.alertRepeatMs })

  // LAVABOYU KEEPER'IN KENDISI YAZAR. `KEEPER_ALERT_LOG` ayarliysa her olay --
  // `PAGE`, `OK` ve `HEARTBEAT` -- TEK bir dosyaya, tek bir akisa gider.
  // Onceki halde tatbikat bu dosyayi OKUYORDU ama hicbir sey YAZMIYORDU, ve
  // operatorun akla gelen ilk komutu (`> alerts.log`) tam olarak `PAGE`
  // satirlarini dusururdu -- cunku `consoleSink` onlari stderr'e ayirir.
  //
  // YAZILABILIRLIGI ACILISTA, BIR KEZ DENENIR. Onceki hal yolu ilk KALP
  // ATISINDA deniyordu, ve bir ENOENT orada surecin TAMAMINI oldururdu --
  // olculdu, runbook'un kendi komutuyla, tek bir kalp atisindan sonra.
  if (watcher.alertLogPath !== undefined) assertAlertLogWritable(watcher.alertLogPath)
  const sink =
    watcher.alertLogPath === undefined
      ? consoleSink
      : multiSink(consoleSink, fileSink(watcher.alertLogPath))

  // IMLEC LAVABODAN SONRA KURULUR, cunku BASKA BIR FACTORY'YE ait bir imleci
  // yok saymak SESSIZ OLMAMALIDIR. Sayfa degil -- Faz 2 redeploy'unda bu
  // beklenen ve kendini iyilestiren bir olaydir -- ama "maruziyet neden bir
  // anda sifirdan yeniden kuruluyor" sorusunun cevabi bu satirdir.
  const store = fileCursorStore(
    watcher.cursorPath,
    { chainId: watcher.chainId, factory: watcher.factory, startBlock: watcher.startBlock },
    (reason) => {
      alert('ok', `cursor-reset: ${reason}`, sink)
    },
  )

  console.log(
    `keeper ready chainId=${ARC_TESTNET_CHAIN_ID} pollIntervalMs=${config.pollIntervalMs} dryRun=${config.dryRun}`,
  )
  console.log(
    `watching graduation window factory=${watcher.factory} startBlock=${watcher.startBlock} chainKey=${watcher.chainKey} allowedTargets=${watcher.allowlist.graduationTargets.length} cursor=${watcher.cursorPath} alertLog=${watcher.alertLogPath ?? 'stdout+stderr only'} repeatAfterMs=${watcher.alertRepeatMs ?? DEFAULT_REPEAT_AFTER_MS}`,
  )

  let stopped = false
  const factory: Address = watcher.factory

  // KENDINI YENIDEN ZAMANLAYAN DONGU, `setInterval` DEGIL. Yavas bir RPC ile
  // `setInterval` poll'lari ust uste bindirir; bindiginde imlec dosyasina iki
  // yazici birden girer ve tarama araligi ikiye bolunur.
  const poll = async (): Promise<void> => {
    if (stopped) return
    await runWatcher({
      client: reader,
      factory,
      startBlock: watcher.startBlock,
      allowlist: watcher.allowlist,
      alert: (level, message) => {
        alert(level, message, sink)
      },
      heartbeat: () => {
        // KALP ATISI ASLA BASTIRILMAZ. Harici olu-adam anahtari onu SAYAR;
        // seyrelttigimiz an, o anahtarin esigi anlamsizlasir.
        heartbeat(sink)
      },
      liveness,
      store,
      chunk: watcher.logScanChunk,
      throttle,
    })
    if (!stopped) setTimeout(() => void poll(), config.pollIntervalMs)
  }

  // KANARYA POLL DONGUSUNDEN AYRI BIR ZAMANLAYICIDA. Poll icinde kosaydi,
  // poll'un takilmasi kanaryayi da yanina alirdi -- yani tam olarak yakalamasi
  // istenen ariza onu susturur, ve mekanizma BOSALIRDI.
  //
  // Kanarya AYNI throttle'i kullanir: kalici bir ariza saatte bir tekrarlanir,
  // her poll'da degil. Ilk sayfa yine ANINDA cikar.
  const canaryThrottle = createThrottle({ repeatAfterMs: watcher.alertRepeatMs })
  const canary = setInterval(() => {
    const now = Date.now()
    const findings = liveness.check(now)
    for (const finding of findings) {
      if (canaryThrottle.shouldEmit(finding.code, now)) {
        alert('page', `${finding.code}: ${finding.message}`, sink)
      }
    }
    canaryThrottle.sweep(findings.map((finding) => finding.code))
  }, config.pollIntervalMs)

  const stop = (): void => {
    stopped = true
    clearInterval(canary)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  await poll()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
