import type { Address } from 'viem'
import type { ChainReader, ObservedLog } from '../watch/graduationWindow'

/**
 * ============ `Completed` KAPI ZILIDIR, KAYIT DEGIL ============
 *
 * ============ RUNBOOK YANLIS DEGILDI; EKSIK BIR EKSENI YANITLIYORDU ========
 *
 * `docs/runbooks/graduation-window.md` §1 `Completed`in BILEREK
 * sorgulanmadigini yazar, ve gerekcesi aynen dogrudur:
 *
 *   "the watcher already reads complete() from the slot, on every known curve,
 *    every poll. For that one fact the slot is strictly better than the log --
 *    complete latches true and never goes back, so the log carries nothing
 *    newer."
 *
 * Bu bir DOGRULUK iddiasidir ve AYAKTA KALIR. Bu dosya onu CIGNEMEZ: asagida
 * hicbir log ICERIGI okunmaz. `realQuoteReserves` log'dan alinmaz, `token`
 * argumani kullanilmaz, "hangi curve tamamlandi" sorusu log'a SORULMAZ. Karar
 * yine ve yalnizca slottan verilir -- `runGraduationPass` degismemistir.
 *
 * Log'un cevapladigi sey BASKA BIR SORUDUR: **NE ZAMAN.** Slot "su anda
 * tamamlanmis" der; ne zaman tamamlandigini SOYLEYEMEZ, cunku bir slotun
 * tarihi yoktur. Onu yalnizca log tasir. Runbook o ekseni yanitlamiyordu --
 * yanlis degil, EKSIKTI.
 *
 * Bu yuzden buradaki sozlesme dardir ve tek cumleyle yazilabilir:
 *
 *     BIR `Completed` GORULDUGUNDE, SIRADAKI OLAGAN GECIS ERKEN KOSAR.
 *
 * Baska hicbir sey. Tek bir yurutme yolu vardir, tek bir predikat
 * (`pendingGraduations`), ve butun kapilar (silahlanma, karantina, kilit,
 * simulasyon, geri okuma) DEGISMEDEN gecerlidir. Ikinci bir kesif yolu
 * yazmak, AGENT-CONTEXT'in 1 numarali ariza sekli olurdu: "bir ozellik bir
 * giris noktasinda kapatilir ve digerinde de kapali sanilir".
 *
 * ============ NEDEN ~350 ms DEGIL -- VE BU BIR OLCUM SORUNU ============
 *
 * Gorev tanimi "kabaca bir blok (~350 ms)" diyor. O sayiya ULASMAK, blok
 * basina bir `eth_getLogs` demektir: ~2.86 istek/saniye, SUREKLI. Bu depoda
 * olculmus iki sey onu bugunku Arc'ta reddettiriyor:
 *
 *   - AGENT-CONTEXT: alti ES ZAMANLI `eth_call` -> 2/6 basarili; ve "butce
 *     ISTEMCININ TEMPOSUNDAN degil ucun genel yukundan gelir", yani guvenli
 *     bir hiz sabiti YOKTUR.
 *   - runbook §6: keeper ve indexer BIRLIKTE yururken indexer IKI TAM OMUR
 *     boyunca SIFIR aralik tamamladi; keeper durdurulunca 25 tamamladi. Log
 *     tarama butcesi poll basina 1 parcaya tam da bunun icin indirildi.
 *
 * Blok basina bir `eth_getLogs`, o butcenin ~40 KATIDIR. Yani ~350 ms bir
 * tercih meselesi degil, olculmus bir paylasima yapilan bir talep.
 *
 * VARSAYILAN `DEFAULT_COMPLETED_WATCH_MS` (2000 ms) SECILDI, ve gerekcesi
 * KARSILASTIRMADIR, mutlak bir rakam degil: bu, izleyicinin (`index.ts`, 5 s
 * poll, gecis basina ~8 cagri = ~1.6 cagri/s) BUGUN ZATEN harcadigindan
 * DUSUKTUR -- 0.5 cagri/s. Yani "keeper'in halihazirda odedigi seyin altinda
 * kalan en dusuk gecikme" kuralindan turer. Olculen bedeli
 * `test/localchain/scaleBench.ts`in L7'sindedir.
 *
 * ============ YANLIS ZIL ZARARSIZDIR; KACIRILMIS ZIL GECIKMEDIR ============
 *
 * Sorgu topic0 ILEDIR, adres filtresi YOKTUR (bkz. `LogQuery.address`). Yani
 * bize ait olmayan bir kontrat da ayni imzayi yayarsa zil calar. BU BILINCLI:
 *
 *   - Yanlis bir zil, kapilari degismemis, idempotent, ucuz bir gecisin ERKEN
 *     kosmasidir. Hicbir sey yayinlanmaz (curve zaten `pending` degildir).
 *   - Kacirilmis bir zil, satin aldigimiz gecikmenin ta kendisidir.
 *   - VE UST SINIR VARDIR: zil `watchIntervalMs`ten daha sik CALAMAZ, cunku
 *     kontrol o araliktadir. Patolojik bir yabanci kontrat bile maliyeti
 *     OPERATORUN AYARLADIGI sayinin uzerine cikaramaz. Sinirsiz bir buyume
 *     yolu yoktur.
 *
 * Yayan adres yine de RAPOR EDILIR (`knownRing` / `strangerRing`), boylece
 * boyle bir kontrat ortaya cikarsa GORUNUR olur, gizemli degil.
 *
 * ============ ZIL BOZULURSA ============
 *
 * `check` FIRLATMAZ. Bir `eth_getLogs` arizasi gecisi ERTELEMEZ ve DUSURMEZ:
 * zil bir optimizasyondur, poll ise EMNIYET AGIDIR, ve emniyet aginin bir
 * optimizasyonun arizasina bagli olmasi tasarimin tersine cevrilmesi olurdu.
 * Ariza `onError` ile RAPOR EDILIR -- sessiz degildir -- ve gecikme sessizce
 * 15 saniyeye geri doner ki bu zaten bugunku davranistir.
 */

export const COMPLETED_EVENT = {
  type: 'event',
  name: 'Completed',
  inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'realQuoteReserves', type: 'uint256', indexed: false },
    { name: 'poolSeedSupply', type: 'uint256', indexed: false },
  ],
} as const

/** Bkz. yukaridaki NatSpec. Izleyicinin bugunku ~1.6 cagri/s'sinin altinda. */
export const DEFAULT_COMPLETED_WATCH_MS = 2_000

/**
 * KAC BLOK GERIYE BAKILIR. Zil KAYIT TUTMAZ, dolayisiyla bir aralik
 * dusurulmesi yalnizca gecikme maliyetidir; yine de son gorulen bloktan
 * ilerlemek, ayni olayin ard arda zil calmasini engeller.
 */
export const COMPLETED_WATCH_MAX_LOOKBACK = 200n

export type Ring =
  { rang: false } | { rang: true; curves: Address[]; strangers: Address[]; throughBlock: bigint }

export type CompletedWatchDeps = {
  client: ChainReader
  /**
   * BILINEN CURVE KUMESI, HER KONTROLDE YENIDEN SORULUR. Bir `() => Set` degil
   * de bir getter olmasinin sebebi, kumenin her gecisten sonra BUYUMESIDIR;
   * bir kez yakalanan kume, ilk gecisin kumesinde donup kalirdi.
   */
  knownCurves: () => readonly Address[]
  onError?: (detail: string) => void
  onRing?: (detail: string) => void
}

export type CompletedWatch = {
  /**
   * `(lastSeen, head]` araligini bir kez yoklar. ASLA FIRLATMAZ.
   */
  check(): Promise<Ring>
  /**
   * `ms` boyunca uyur, AMA bir zil calarsa ERKEN doner. Donus degeri hangisi
   * oldugunu soyler, cunku cagiran taraf onu kayda gecirir.
   */
  waitOrRing(ms: number): Promise<'interval' | 'doorbell'>
  /** Ic imlec. Testler ve tanilar icin. */
  lastSeenBlock(): bigint | null
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export function createCompletedWatch(
  deps: CompletedWatchDeps,
  opts?: { intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): CompletedWatch {
  const intervalMs = opts?.intervalMs ?? DEFAULT_COMPLETED_WATCH_MS
  const nap = opts?.sleep ?? sleep
  const now = opts?.now ?? Date.now
  let lastSeen: bigint | null = null

  const check = async (): Promise<Ring> => {
    try {
      const head = await deps.client.getBlock()
      // ILK KONTROL ZIL CALMAZ. Baslangicta `lastSeen` yoktur ve
      // `startBlock`tan bugune kadarki HER `Completed`i cekmek, hem devasa bir
      // sorgu hem de anlamsizdir: acilistaki ilk olagan gecis zaten butun
      // slotlari okur. Zil yalnizca "ben bakarken OLDU" der.
      if (lastSeen === null) {
        lastSeen = head.number
        return { rang: false }
      }
      if (head.number <= lastSeen) return { rang: false }

      const from =
        head.number - lastSeen > COMPLETED_WATCH_MAX_LOOKBACK
          ? head.number - COMPLETED_WATCH_MAX_LOOKBACK
          : lastSeen + 1n
      const logs = await deps.client.getLogs({
        events: [COMPLETED_EVENT],
        fromBlock: from,
        toBlock: head.number,
      })
      lastSeen = head.number
      if (logs.length === 0) return { rang: false }

      const known = new Set(deps.knownCurves().map((curve) => curve.toLowerCase()))
      const curves: Address[] = []
      const strangers: Address[] = []
      for (const log of logs) {
        const emitter = emitterOf(log)
        if (known.has(emitter.toLowerCase())) curves.push(emitter)
        else strangers.push(emitter)
      }
      const detail = `Completed seen over [${from}, ${head.number}]: ${curves.length} known curve(s)${curves.length === 0 ? '' : ` (${curves.join(', ')})`}${strangers.length === 0 ? '' : `, ${strangers.length} from address(es) this executor does not know yet (${strangers.join(', ')}) -- either a curve launched since the last pass, or an unrelated contract sharing the signature`}. Running the next pass now instead of waiting out the poll interval; the DECISION is still taken from the complete()/graduated() slots, never from this log.`
      deps.onRing?.(detail)
      return { rang: true, curves, strangers, throughBlock: head.number }
    } catch (error) {
      // FIRLATMAZ. Bkz. dosya basi: emniyet agi optimizasyonun arizasina
      // bagli olamaz.
      deps.onError?.(
        `completed-watch-failed: the low-latency Completed watch could not read logs, so graduation latency falls back to the poll interval for now. NOTHING ELSE IS AFFECTED -- the poll is the backstop and it is untouched: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      )
      return { rang: false }
    }
  }

  return {
    check,
    lastSeenBlock: () => lastSeen,
    async waitOrRing(ms: number): Promise<'interval' | 'doorbell'> {
      const deadline = now() + ms
      for (;;) {
        const remaining = deadline - now()
        if (remaining <= 0) return 'interval'
        await nap(Math.min(intervalMs, remaining))
        if (now() >= deadline) {
          // SON YOKLAMA YINE DE YAPILIR: aralik dolmus olsa bile bu turda bir
          // zil varsa onu YUTMAK, bir sonraki turda tekrar gormemek demekti
          // (`lastSeen` ilerlemis olurdu).
          const late = await check()
          return late.rang ? 'doorbell' : 'interval'
        }
        const ring = await check()
        if (ring.rang) return 'doorbell'
      }
    },
  }
}

function emitterOf(log: ObservedLog): Address {
  const emitter = log.address
  // SESSIZ ATLAMA YOK. `address`i olmayan bir log, bilinen kume ile
  // KESISTIRILEMEZ; onu atlamak zilin HIC CALMAMASI ve sebebinin hicbir yerde
  // yazmamasi demekti -- yani bu deponun defalarca odedigi sessiz ariza.
  if (typeof emitter !== 'string') {
    throw new Error(
      `a Completed log arrived without an emitting address, so it cannot be matched against the known curve set. The Completed event is emitted by the CURVE and its indexed argument is the TOKEN, so log.address is the only field that identifies the curve. Log: ${JSON.stringify(log)}`,
    )
  }
  return emitter
}
