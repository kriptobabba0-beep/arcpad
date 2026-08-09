/**
 * ============ SURESIZ DONGU, VE NEDEN KENDI MODULU ============
 *
 * OLCULDU, 2026-08-09, uretim defterine karsi: `pnpm --filter @arcpad/keeper
 * graduate` (dongu modu, kuru kosu) **13 SANIYEDE, TEK BIR GECISTEN SONRA,
 * CIKIS KODU 0 ILE OLDU.**
 *
 *   [2s]  graduator ready ... mode=loop@15000ms
 *   [3s]  HEARTBEAT keeper.graduate ... state=catching-up ...
 *   EXITED after 13s
 *
 * Sebep, iki dogru parcanin BIRLESIMIYDI: `main` ilk gecisten sonra COZULUYOR
 * (dongu kendini `setTimeout` ile yeniden zamanliyor, `main`i beklemiyor), ve
 * `settle` cozulme aninda 10 saniyelik bir `exit(code)` zamanlayicisi kuruyor.
 * `unref()` o zamanlayicinin sureci AYAKTA TUTMASINI engeller ama ATESLEMESINI
 * engellemez. Yani surec, dongusu tam da bir sonraki gecisi beklerken, kendi
 * "temiz cikis" yolundan oluyordu.
 *
 * ARIZANIN SEKLI, BU DEPONUN IMZASI: her sey saglikli gorunuyordu -- bir kalp
 * atisi, sifir sayfa, cikis kodu 0. Ve bir servis yoneticisi altinda
 * `Restart=always` bunu TAMAMEN SAKLARDI: surec her 13 saniyede yeniden dogar,
 * imlec ilerledigi icin is de yavas yavas ilerler, ve "keeper calisiyor" satiri
 * her seferinde yeniden yazilir. Yani bu hatanin bulunmasi ancak dagitimdan
 * ONCE, elle, sure olculerek mumkundu.
 *
 * Cozum donguyu ACIK BIR SOZE baglar: `runPollLoop` ancak DURDURULDUKTAN
 * SONRA cozulur. Boylece `settle`in sozlesmesi ("cozuldu = isi bitti") her iki
 * modda da DOGRU olur, ve iki parca bir daha birbirini yalanlamaz.
 */

export type PollLoopDeps = {
  /** Bir gecis. Reddederse dongu de REDDEDER -- ariza yutulmaz. */
  pass: () => Promise<unknown>
  /** `true` donduren an dongu, ELDEKI gecisi bitirip cozulur. */
  stopped: () => boolean
  pollIntervalMs: number
  /**
   * Zamanlayici ENJEKTE EDILIR, cunku bu modulun tek iddiasi ZAMANLAMA
   * hakkindadir ve gercek bir `setTimeout` ile o iddia ancak gercek saniyeler
   * bekleyerek olculebilirdi.
   */
  schedule?: (fn: () => void, ms: number) => void
  /**
   * ============ OLAY TETIKLEYICISININ TEK BAGLANTI NOKTASI ============
   *
   * Verilirse `schedule` YERINE gecer: dongu bunu bekler ve cozuldugu an
   * siradaki gecisi kosar. `'doorbell'` doner ise gecis ERKEN kosmustur.
   *
   * TETIKLEYICI BURAYA -- UYKUNUN YERINE -- BAGLANIR, `pass`in yanina DEGIL,
   * VE BU KARARIN TAMAMI BUDUR. Olaya ayri bir yurutme yolu asmak, kapilarin
   * (silahlanma, karantina, kilit, simulasyon, geri okuma) IKINCI bir kez
   * yazilmasi ya da atlanmasi demekti -- AGENT-CONTEXT'in 1 numarali ariza
   * sekli. Uykuyu kisaltmak ise HICBIR kapiyi degistirmez: tek yol, tek
   * predikat, yalnizca daha erken.
   *
   * REDDEDERSE DONGU DUSMEZ: bekleme `pollIntervalMs`e geri duser. Emniyet
   * agi, onu hizlandiran seyin arizasina bagli olamaz.
   */
  waitBeforeNextPass?: (ms: number) => Promise<'interval' | 'doorbell'>
  /** Erken uyanis KAYDA GECER; sessiz bir hizlanma olculemez. */
  onWake?: (reason: 'interval' | 'doorbell') => void
}

export function runPollLoop(deps: PollLoopDeps): Promise<void> {
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms)
    })

  return new Promise<void>((resolve, reject) => {
    const step = (): void => {
      if (deps.stopped()) {
        resolve()
        return
      }
      deps.pass().then(() => {
        // DURDURMA GECISTEN SONRA KONTROL EDILIR: SIGTERM alan bir yurutucu
        // ELDEKI gecisi bitirir. Ortasinda birakmak, yayinlanmis ama makbuzu
        // okunmamis bir islem birakmak olurdu.
        if (deps.stopped()) {
          resolve()
          return
        }
        const wait = deps.waitBeforeNextPass
        if (wait === undefined) {
          schedule(step, deps.pollIntervalMs)
          return
        }
        wait(deps.pollIntervalMs).then(
          (reason) => {
            deps.onWake?.(reason)
            step()
          },
          () => {
            // BEKLEYICI DUSTU. Dongu DUSMEZ; olagan araliga geri duser.
            deps.onWake?.('interval')
            schedule(step, deps.pollIntervalMs)
          },
        )
      }, reject)
    }
    step()
  })
}
