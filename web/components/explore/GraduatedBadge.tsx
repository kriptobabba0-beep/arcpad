/**
 * TEK KELIME, GORSELIN UST KOSESINDE.
 *
 * "Graduated" bu urunde bir rutbe degil bir DURUM DEGISIKLIGIDIR: curve
 * kapanmis, havuz acilmis, islem baska bir mekana tasinmistir. Kartta bunu
 * soylemek, kullanicinin tikladiginda BASKA bir panel gorecegini onceden
 * bilmesini saglar.
 *
 * `complete` ILE KARISTIRILMAMALI ve bu ayrim tasiyicidir:
 *   `complete`  -> satis arzi bitti, curve kapandi, HAVUZ HENUZ YOK.
 *   `graduated` -> odeme yapildi, havuz acildi, islem orada.
 * Bugun uretim fabrikasindaki curve'un hali `complete && !graduated`, yani bu
 * rozet ile "Curve complete" hapi AYNI ANDA cizilmez ve ayni sey demezler.
 *
 * KENDI DOSYASINDA, cunku iki kart da kullaniyor: izgara karti ve top-tokens
 * seridi. Birinin otekinden import etmesi, iki eşdüzey bileşen arasında yön
 * uydurmak olurdu.
 */
export function GraduatedBadge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute right-1.5 top-1.5 rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black"
    >
      Graduated
    </span>
  )
}
