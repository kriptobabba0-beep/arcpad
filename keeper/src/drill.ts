import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { argv, env, exit } from 'node:process'
import { fileURLToPath } from 'node:url'
import { createArcClient } from '@arcpad/shared'
import { type Address, BaseError, ContractFunctionRevertedError, getAddress } from 'viem'
import { loadWatcherConfig } from './config'
import { FACTORY_WATCH_ABI } from './watch/graduationWindow'

/**
 * TATBIKAT. Haftalik, canli, Arc testnet'e karsi.
 *
 * "ANGARYAYA HIC ATESLENMEMIS BIR MONITOR, BOZUK OLDUGUNU KIMSENIN BILMEDIGI
 * BIR MONITORDUR." Bu depoda ciddi olan her kusur BIR SEY CALISTIRARAK
 * bulundu, okuyarak degil -- ve bir izleyici icin "calistirmak" tam olarak
 * budur: gercek bir oneri yap, alarm lavabosunun sayfayi GERCEKTEN tasidigini
 * gor, sonra onerinin GERCEKTEN suresi doldugunu gor.
 *
 * IKI FAZ, IKI AYRI ZAMANLANMIS IS:
 *   observe  -- oneri yapildiktan hemen sonra. Sayfa geldi mi.
 *   expiry   -- kaydedilen `eta`dan uc gun sonra.
 *               `applyGraduationTarget()` gercekten reddediyor mu.
 *
 * `expiry` fazi, f10f4a1'de eklenen ust sinirin ZINCIR USTUNDEKI TEK
 * calistirilabilir kanitidir. Birim testi aritmetigi ispatlar; tatbikat
 * zincirin ayni fikirde oldugunu ispatlar.
 *
 * ONERI ADIMI (adim 1) BU BETIKTE DEGILDIR ve olmamalidir: governor bir
 * Safe'tir, imzalari insanlar toplar, ve bir tatbikat betigine governor
 * yetkisi vermek tatbikatin onlemeye calistigi seyi yaratirdi.
 */

export type DrillOutcome = { ok: boolean; detail: string }

/**
 * ALARM LAVABOSUNU OKUR, SIMULE ETMEZ.
 *
 * Tatbikatin izleyiciyi kendi surecinde cagirip "sayfa cikardi" demesi, alarm
 * BORUSUNUN calistigi hakkinda hicbir sey soylemezdi -- ve on bir kez isiran
 * sekil tam olarak "mekanizma var ama ciktisi hicbir yere varmiyor"dur.
 */
export type SinkLine = { kind: 'page' | 'ok' | 'heartbeat'; atMs: number; text: string }

export interface AlertSinkQuery {
  /** `sinceMs`ten SONRA damgalanmis satirlar. Damgasi okunamayan satir DUSER. */
  readSince(sinceMs: number): Promise<SinkLine[]>
}

const LINE = /^(PAGE|OK|HEARTBEAT) keeper\.graduationWindow at=(\S+)/

/**
 * `consoleSink`/`fileSink`in yazdigi satirlari okuyan lavabo sorgusu. Bicim
 * `PAGE keeper.graduationWindow at=<ISO> ...` ile baslar ve JSON DEGILDIR: bir
 * alarm yolunun ayristirma hatasiyla sessizlesmesi, korunmaya calisilan seydir.
 *
 * ZAMAN PENCERESI ZORUNLUDUR VE SONRADAN EKLENDI. Onceki hal dosyanin
 * TAMAMINI okuyup "hedefi anan bir sayfa var mi" diye bakiyordu. `fileSink`
 * ekler ve hicbir sey donmez, dolayisiyla DORT HAFTA ONCEKI bir sayfa --
 * baskasi olmasa bile -- `ok=true` veriyordu. Yani ilk basarili tatbikattan
 * SONRA is, izleyici o hafta atesledi mi etmedi mi diye bakmaksizin geciyordu,
 * VE IZLEYICI OLDUKTEN SONRA DA GECMEYE DEVAM EDIYORDU. Izledigi seyin
 * olumunden sag cikan bir canlilik kapisi, hic kapi olmamasindan KOTUDUR,
 * cunku aktif olarak icini rahatlatir.
 *
 * Damgasi ayristirilamayan satir SAYILMAZ. Yon bilincli: yanlis KIRMIZI,
 * yanlis YESILE tercih edilir.
 */
export function fileAlertSink(path: string): AlertSinkQuery {
  return {
    readSince(sinceMs: number): Promise<SinkLine[]> {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return Promise.resolve([])
      }
      const out: SinkLine[] = []
      for (const text of raw.split(/\r?\n/)) {
        const m = LINE.exec(text)
        if (m === null) continue
        const atMs = Date.parse(m[2] as string)
        if (Number.isNaN(atMs) || atMs < sinceMs) continue
        const kind = m[1] === 'PAGE' ? 'page' : m[1] === 'OK' ? 'ok' : 'heartbeat'
        out.push({ kind, atMs, text })
      }
      return Promise.resolve(out)
    },
  }
}

/**
 * ADIM 2: izleyici BU KOSUDA sayfa cikardi mi.
 *
 * IKI SART, VE IKINCISI TATBIKATIN ASIL DEGERI:
 *
 *   (1) `sinceMs`ten sonra, hedefi anan bir `PAGE`.
 *   (2) `sinceMs`ten sonra EN AZ BIR `HEARTBEAT`.
 *
 * (2) olmadan kapi, izledigi seyin olumunden SAG CIKAR: eski bir sayfa
 * dosyada durdugu surece is yesil kalir, izleyici haftalardir olu olsa bile.
 * Kalp atisi "izleyici bu pencerede CALISIYORDU"nun kanitidir ve sayfadan
 * bagimsiz olarak uretilir; ikisini birlikte istemek, gecmenin tek yolunu
 * "izleyici yasiyordu VE atesledi" yapar.
 *
 * Sirasi da onemli: kalp atisi YOKSA hata mesaji "sayfa gelmedi" DEMEZ,
 * "izleyici kosmuyordu" der. Ikisi farkli arizalar ve farkli runbook
 * dallaridir; birini digerinin adiyla raporlamak rota'yi yanlis yere gonderir.
 *
 * @param attempts Kac kez bakilacagi. CI birazcik pay birakir cunku is
 *                 basladiginda keeper'in poll'unun neresinde oldugu bilinemez.
 */
export async function drillObserve(deps: {
  sink: AlertSinkQuery
  target: Address
  /** Bu kosunun basladigi an. Bundan ONCEKI hicbir kanit sayilmaz. */
  sinceMs: number
  attempts?: number
  waitMs: number
  sleep: (ms: number) => Promise<void>
}): Promise<DrillOutcome> {
  const attempts = deps.attempts ?? 3
  const needle = deps.target.toLowerCase()
  let beats = 0
  let pages = 0

  for (let i = 0; i < attempts; i += 1) {
    const lines = await deps.sink.readSince(deps.sinceMs)
    beats = lines.filter((l) => l.kind === 'heartbeat').length
    const fresh = lines.filter((l) => l.kind === 'page')
    pages = fresh.length
    const hit = fresh.find((l) => l.text.toLowerCase().includes(needle))
    if (hit !== undefined && beats > 0) {
      return {
        ok: true,
        detail: `paged on attempt ${i + 1}/${attempts}, and the watcher was alive for it (${beats} heartbeat(s) inside the window): ${hit.text}`,
      }
    }
    if (i + 1 < attempts) await deps.sleep(deps.waitMs)
  }

  const window = new Date(deps.sinceMs).toISOString()
  if (beats === 0) {
    return {
      ok: false,
      detail: `NO HEARTBEAT in the sink since ${window}. The watcher was not running during this drill, so nothing here is evidence either way -- do not read this as "the alarm failed", read it as "there was no watcher". Runbook section 6.`,
    }
  }
  return {
    ok: false,
    detail: `The watcher was alive (${beats} heartbeat(s) since ${window}) but produced NO PAGE naming ${deps.target} in that window. ${pages} unrelated page(s) were in it. The alarm path did not carry the proposal.`,
  }
}

/**
 * ADIM 4: suresi gecmis bir oneri GERCEKTEN inemiyor mu.
 *
 * Yalnizca `GraduationTargetProposalExpired` kabul edilir. "Herhangi bir
 * revert" kabul etmek, tatbikati bir kapi olmaktan cikarirdi: `NotGovernor`,
 * `NoPendingGraduationTarget` ya da gaz yetersizligi de reddederdi ve hicbiri
 * ust sinir hakkinda bir sey soylemez.
 */
export async function drillExpiry(deps: {
  simulateApply: () => Promise<{ reverted: boolean; errorName?: string }>
}): Promise<DrillOutcome> {
  const result = await deps.simulateApply()
  if (!result.reverted) {
    return {
      ok: false,
      detail:
        'applyGraduationTarget() did NOT revert. The expiry bound is not in force on this chain and a lapsed proposal is still armed.',
    }
  }
  if (result.errorName !== 'GraduationTargetProposalExpired') {
    return {
      ok: false,
      detail: `applyGraduationTarget() reverted with ${result.errorName ?? 'an unnamed error'}, not GraduationTargetProposalExpired. That is a different failure and proves nothing about the window bound.`,
    }
  }
  return { ok: true, detail: 'applyGraduationTarget() reverted GraduationTargetProposalExpired()' }
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export async function main(): Promise<number> {
  const phase = argv[2]
  const rpcUrl = env['ARC_RPC_URL']
  if (!rpcUrl) throw new Error('ARC_RPC_URL is not set')
  const watcher = loadWatcherConfig(env)

  if (phase === 'observe') {
    const rawTarget = env['KEEPER_DRILL_TARGET']
    if (!rawTarget)
      throw new Error('KEEPER_DRILL_TARGET is not set (the address the Safe proposed)')
    const logPath = env['KEEPER_ALERT_LOG']
    if (!logPath)
      throw new Error('KEEPER_ALERT_LOG is not set (the file the keeper writes its sink to)')
    // PENCERENIN BASI DISARIDAN GELIR ve gelmesi zorunludur: is baslarken
    // "simdi"yi almak, Safe onerisi ile is arasindaki gecikmeyi pencerenin
    // disinda birakirdi. `KEEPER_DRILL_SINCE` Safe islemini gonderen kisinin
    // (ya da is akisinin) kaydettigi andir.
    const rawSince = env['KEEPER_DRILL_SINCE']
    if (!rawSince) {
      throw new Error(
        'KEEPER_DRILL_SINCE is not set (ISO-8601 instant the drill window opens -- normally just before the Safe proposes). Without it the drill would accept a page from any point in history.',
      )
    }
    const sinceMs = Date.parse(rawSince)
    if (Number.isNaN(sinceMs)) throw new Error(`KEEPER_DRILL_SINCE is "${rawSince}", not ISO-8601`)

    // PENCERE SINIRSIZ GENISLETILEMEZ. Tatbikat haftaliktir; iki gunden eski
    // bir baslangic ya bir yazim hatasidir ya da kapiyi susturma girisimi --
    // ve `1970-01-01` gecirmek, dorduncu tura kadar var olan bosluga geri
    // donmek olurdu. Kabuk tarafinda bir varsayilan yeterli DEGILDI: kod
    // tarafinda reddedilmeli ki hangi yoldan gelirse gelsin gecerli olmasin.
    const MAX_WINDOW_MS = 2 * 24 * 60 * 60 * 1000
    const age = Date.now() - sinceMs
    if (age > MAX_WINDOW_MS) {
      throw new Error(
        `KEEPER_DRILL_SINCE is "${rawSince}", ${Math.round(age / 3_600_000)}h ago, wider than the ${MAX_WINDOW_MS / 3_600_000}h maximum. A window that wide accepts a page from an earlier drill and turns this gate back into the vacuous pass it was.`,
      )
    }

    const outcome = await drillObserve({
      sink: fileAlertSink(logPath),
      target: getAddress(rawTarget),
      sinceMs,
      waitMs: Number(env['KEEPER_POLL_INTERVAL_MS'] ?? 5_000),
      sleep,
    })
    console.log(`${outcome.ok ? 'DRILL PASS' : 'DRILL FAIL'} observe: ${outcome.detail}`)
    return outcome.ok ? 0 : 1
  }

  if (phase === 'expiry') {
    const client = createArcClient(rpcUrl)
    const outcome = await drillExpiry({
      simulateApply: async () => {
        try {
          await client.simulateContract({
            address: watcher.factory,
            abi: FACTORY_WATCH_ABI,
            functionName: 'applyGraduationTarget',
            account: getAddress(env['KEEPER_DRILL_CALLER'] ?? watcher.factory),
          })
          return { reverted: false }
        } catch (error) {
          if (error instanceof BaseError) {
            const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
            if (revert instanceof ContractFunctionRevertedError) {
              const name = revert.data?.errorName
              return name === undefined ? { reverted: true } : { reverted: true, errorName: name }
            }
          }
          throw error
        }
      },
    })
    console.log(`${outcome.ok ? 'DRILL PASS' : 'DRILL FAIL'} expiry: ${outcome.detail}`)
    return outcome.ok ? 0 : 1
  }

  throw new Error(`unknown drill phase "${phase ?? ''}"; expected "observe" or "expiry"`)
}

const entry = argv[1]
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  main()
    .then((code) => {
      exit(code)
    })
    .catch((error: unknown) => {
      console.error(error)
      exit(1)
    })
}
