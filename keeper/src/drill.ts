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
export interface AlertSinkQuery {
  recentPages(): Promise<string[]>
}

/**
 * `consoleSink`in yazdigi satirlari okuyan lavabo sorgusu. Bicim
 * `PAGE keeper.graduationWindow ...` ile baslar ve JSON DEGILDIR: bir alarm
 * yolunun ayristirma hatasiyla sessizlesmesi, korunmaya calisilan seydir.
 */
export function fileAlertSink(path: string): AlertSinkQuery {
  return {
    recentPages(): Promise<string[]> {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return Promise.resolve([])
      }
      return Promise.resolve(raw.split(/\r?\n/).filter((line) => line.startsWith('PAGE ')))
    },
  }
}

/**
 * ADIM 2: izleyici bir poll araligi icinde sayfa cikardi mi.
 *
 * @param attempts Kac kez bakilacagi. `1` "tam olarak bir poll araligi"
 *                 demektir; CI birazcik pay birakir cunku is basladiginda
 *                 keeper'in poll'unun neresinde oldugu bilinemez.
 */
export async function drillObserve(deps: {
  sink: AlertSinkQuery
  target: Address
  attempts?: number
  waitMs: number
  sleep: (ms: number) => Promise<void>
}): Promise<DrillOutcome> {
  const attempts = deps.attempts ?? 3
  const needle = deps.target.toLowerCase()
  const seen: string[] = []

  for (let i = 0; i < attempts; i += 1) {
    const pages = await deps.sink.recentPages()
    seen.length = 0
    seen.push(...pages)
    const hit = pages.find((page) => page.toLowerCase().includes(needle))
    if (hit !== undefined) {
      return { ok: true, detail: `paged on attempt ${i + 1}/${attempts}: ${hit}` }
    }
    if (i + 1 < attempts) await deps.sleep(deps.waitMs)
  }

  return {
    ok: false,
    detail: `NO PAGE mentioning ${deps.target} after ${attempts} attempt(s). The watcher did not fire in anger. ${seen.length} unrelated page(s) were in the sink.`,
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
    const outcome = await drillObserve({
      sink: fileAlertSink(logPath),
      target: getAddress(rawTarget),
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
