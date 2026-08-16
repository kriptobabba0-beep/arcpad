/**
 * KARTTA BIR TAAHHUT ISARETI.
 *
 * "Buyback" bu urunde bir rutbe degil bir CREATOR KARARIDIR: creator kendi
 * ucret payinin YARISINI, tokeni piyasadan geri almaya ayirmayi kabul etmis
 * ve alinan her sey bes yil kilitlenmistir. Kartta soylemek, kullanicinin
 * tiklamadan once bu farki gormesini saglar -- ve ozelligin isini yapmasi tam
 * olarak GORULMESINE baglidir.
 *
 * `GraduatedBadge` ILE AYNI KOSEDE DEGIL, ve bu bilincli: mezuniyet rozeti sag
 * ustte durur. Ikisi ayni anda cizilebilir (mezun bir tokenin buyback'i devam
 * eder -- havuz mercii tam da bunun icin var), yani ust uste binen bir yerlesim
 * bir gun gercekten cakisirdi.
 *
 * ROZET YALNIZCA `enabled` ICIN CIZILIR. Kapatilmis bir buyback'in gecmisi
 * durur (kilit hala zincirde) ama bir KART bir gecmis anlatamaz; "acik" ile
 * "bir zamanlar aciti" arasindaki farki tasiyacak yer token sayfasidir.
 */
export function BuybackBadge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-pill bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#4ade80] backdrop-blur-sm"
    >
      Buyback
    </span>
  )
}
