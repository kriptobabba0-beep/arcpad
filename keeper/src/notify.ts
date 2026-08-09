import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { argv, env as processEnv, exit } from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRepoEnv } from './env'
import { loadNotifyConfig } from './notify/config'
import { createForwarder, type ForwarderDeps } from './notify/forwarder'

/**
 * ============ ALARM LAVABOSU -> PAGER, VE OLU-ADAM ANAHTARI ============
 *
 * `pnpm --filter @arcpad/keeper notify`
 *
 * Keeper (izleyici VE yurutucu) her olayi tek bir dosyaya yazar. Bir VPS'te o
 * dosyayi KIMSE OKUMAZ. Bu surec okur: `PAGE ` satirlarini bir webhook'a
 * gonderir ve her `HEARTBEAT ` icin harici bir olu-adam anahtarina check-in
 * atar.
 *
 * SAGLAYICIDAN BAGIMSIZDIR VE OYLE KALMALIDIR. Iki HTTP ucu bilir, baska
 * hicbir sey; hangi saglayicinin kullanildigi `TODO(owner)`dir ve bu dosyanin
 * degismesini GEREKTIRMEZ.
 *
 * BILESEN BASINA BIR ORNEK CALISTIRIN. Iki keeper sureci iki AYRI dosya yazar
 * (`keeper.graduationWindow` ve `keeper.graduate`), ve tek bir olu-adam
 * anahtarina ikisini birden pinglemek, biri olurken digerinin onu SAKLAMASI
 * demektir -- tam olarak `alert.ts`in bilesen adini ayirma gerekcesi, bir
 * katman yukarida. `deploy/arcpad-keeper-notify@.service` sablon unit'i bu
 * yuzden sablondur.
 */

async function main(): Promise<number> {
  loadRepoEnv()
  const config = loadNotifyConfig(processEnv)
  const once = argv.includes('--once')

  const deps: ForwarderDeps = {
    readSlice(offset: number) {
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(config.logPath)
      } catch {
        return undefined
      }
      const size = stat.size
      if (size <= offset) return { text: '', size }
      const fd = openSync(config.logPath, 'r')
      try {
        const length = size - offset
        const buf = Buffer.allocUnsafe(length)
        const read = readSync(fd, buf, 0, length, offset)
        return { text: buf.subarray(0, read).toString('utf8'), size: offset + read }
      } finally {
        closeSync(fd)
      }
    },
    async post(url, body) {
      // `fetch` VE ZAMAN ASIMI. Zaman asimsiz bir POST, sonsuza kadar asili
      // kalir ve o sirada NE sayfa gider NE ping -- yani sessizlesme, tam da
      // burada engellenmeye calisilan sey.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} from ${redact(url)}`)
      }
    },
    now: () => Date.now(),
    log: (line) => {
      console.error(`notify: ${line}`)
    },
  }

  const forwarder = createForwarder(config, deps)
  console.log(
    `notify ready label=${config.label} log=${config.logPath} page=${redact(config.pageUrl)} heartbeat=${redact(config.heartbeatUrl)} poll=${config.pollIntervalMs}ms minPing=${config.heartbeatMinIntervalMs}ms maxAge=${config.maxAgeMs}ms mode=${once ? 'once' : 'loop'}`,
  )

  if (once) {
    const result = await forwarder.tick()
    console.log(
      `NOTIFY TICK records=${result.recordsSeen} pagesSent=${result.pagesSent} queued=${result.pagesQueued} pinged=${result.heartbeatsPinged} reset=${result.reset}`,
    )
    return result.pagesQueued > 0 ? 1 : 0
  }

  let stopped = false
  const stop = (): void => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  // KENDINI YENIDEN ZAMANLAYAN DONGU, `setInterval` DEGIL: yavas bir POST
  // ust uste binen tick'ler uretirdi ve ayni sayfa iki kez gonderilirdi.
  const loop = async (): Promise<void> => {
    if (stopped) return
    try {
      await forwarder.tick()
    } catch (error) {
      // BIR TICK'IN COKMESI SURECI OLDUREMEZ. Olen bir ilettici, ping'i de
      // durdurur -- ki bu dogru sonuctur -- ama kendi kendine toparlanabilecek
      // gecici bir hatada bunu yapmasi gereksiz bir cagridir.
      console.error(`notify: tick failed and will be retried: ${String(error)}`)
    }
    if (!stopped) setTimeout(() => void loop(), config.pollIntervalMs)
  }
  await loop()
  return 0
}

/** URL'ler sirri TASIYABILIR (healthchecks tarzi uclarda yol bir tokendir). Sadece kaynak yazilir. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}/…`
  } catch {
    return '(unparseable url)'
  }
}

const entry = argv[1]
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  main()
    .then((code) => {
      process.exitCode = code
      setTimeout(() => {
        exit(code)
      }, 10_000).unref()
    })
    .catch((error: unknown) => {
      console.error(error)
      exit(1)
    })
}
