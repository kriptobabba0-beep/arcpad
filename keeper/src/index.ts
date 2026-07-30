import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, assertArcChain, createArcClient } from '@arcpad/shared'
import type { Address } from 'viem'
import { alert, consoleSink, createLiveness, heartbeat } from './alert'
import { viemChainReader } from './chainReader'
import { loadKeeperConfig, loadWatcherConfig } from './config'
import { fileCursorStore, runWatcher } from './watch/graduationWindow'

async function main(): Promise<void> {
  const config = loadKeeperConfig(process.env)
  const watcher = loadWatcherConfig(process.env)
  const client = createArcClient(config.rpcUrl)
  await assertArcChain(client)

  const reader = viemChainReader(client)
  const store = fileCursorStore(watcher.cursorPath)
  const liveness = createLiveness({ pollIntervalMs: config.pollIntervalMs }, Date.now())

  console.log(
    `keeper ready chainId=${ARC_TESTNET_CHAIN_ID} pollIntervalMs=${config.pollIntervalMs} dryRun=${config.dryRun}`,
  )
  console.log(
    `watching graduation window factory=${watcher.factory} startBlock=${watcher.startBlock} chainKey=${watcher.chainKey} allowedTargets=${watcher.allowlist.graduationTargets.length} cursor=${watcher.cursorPath}`,
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
        alert(level, message, consoleSink)
      },
      heartbeat: () => {
        heartbeat(consoleSink)
      },
      liveness,
      store,
      chunk: watcher.logScanChunk,
    })
    if (!stopped) setTimeout(() => void poll(), config.pollIntervalMs)
  }

  // KANARYA POLL DONGUSUNDEN AYRI BIR ZAMANLAYICIDA. Poll icinde kosaydi,
  // poll'un takilmasi kanaryayi da yanina alirdi -- yani tam olarak yakalamasi
  // istenen ariza onu susturur, ve mekanizma BOSALIRDI.
  const canary = setInterval(() => {
    for (const finding of liveness.check(Date.now())) {
      alert('page', `${finding.code}: ${finding.message}`, consoleSink)
    }
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
