/**
 * "Ne kadar once" -- ekranda `51m`, `3h`, `2d`.
 *
 * BU DOSYA `TradesTable.tsx`TEN CIKARILDI, VE SEBEBI TASINABILIRLIK DEGIL.
 * Fonksiyon orada `'use client'` bir modulun icindeydi; explore kartlari ise
 * SUNUCUDA cizilir. Sunucu bileşeninden oraya `import` etmek, tablo
 * modulunun tamamini (ve `wagmi`'ye kadar uzanan agacini) sunucu grafigine
 * sokardi. Ayni bicimin ikinci bir kopyasini yazmak ise daha kotusu: iki yer
 * ayni sayiyi farkli yuvarlar ve hangisinin dogru oldugu ekrandan anlasilmaz.
 */

/**
 * YAS YALNIZCA GOSTERIM ICINDIR.
 *
 * Siralama HICBIR ZAMAN buradan gecmez: olculdu
 * (`003_trades_and_curve_state.sql`), 553 ardisik blok ciftinin %49'u AYNI
 * timestamp'i tasiyor. Zaman bu zincirde bir siralama anahtari degildir;
 * `event_seq` odur.
 *
 * GELECEK BIR TARIH NEGATIF YAS URETMEZ. Sunucunun saati ile kullanicinin
 * saati arasinda birkac saniye fark olabilir ve `-3s` yazan bir satir bir
 * ariza gibi gorunur. Alt sinir sifirdir.
 */
export function relativeAge(at: Date, now: number): string {
  const ms = at.getTime()
  if (Number.isNaN(ms)) return '—'
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Ekran okuyucu icin ACIK hali: `3h` bir kisaltmadir ve seslendirildiginde
 * "uc hache" olur. Gorsel rozet kisa kalir, erisilebilir ad bu dizeyi tasir.
 */
export function relativeAgeLabel(at: Date, now: number): string {
  const short = relativeAge(at, now)
  if (short === '—') return 'age unknown'
  const value = Number.parseInt(short, 10)
  const unit = short.slice(String(value).length)
  const word = { s: 'second', m: 'minute', h: 'hour', d: 'day' }[unit] ?? unit
  return `${value} ${word}${value === 1 ? '' : 's'} old`
}
