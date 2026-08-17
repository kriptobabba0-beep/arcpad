import localFont from 'next/font/local'

/**
 * IKI YUZ, KENDI SUNUCUMUZDAN.
 *
 * §7.3'un tarifi "serif wordmark + geometrik sans govde"ydi ama iskelet hicbir
 * font yuklemiyordu (S14): `layout.tsx` sistem yiginina dusuyordu ve render
 * edilen sey platformdan platforma degisiyordu. Bir urun bu hâlde duyurulamaz
 * -- "sablondan cikmis" izlenimi tam olarak buradan gelir.
 *
 * NEDEN `next/font/local`, `next/font/google` DEGIL: Google'in varyanti build
 * sirasinda fontu indirir ve kendi origin'imizden servis eder, ama URL'i ve
 * altkumeyi bir uzak servisin cevabina baglar. Yerel dosya ucuncu taraf
 * istegi birakmaz (CSP `font-src 'self'` ile kapanabilir), build'i agdan
 * bagimsiz kilar, ve dosyalar depoda oldugu icin bir surum yukseltmesi sessiz
 * bir tipografi degisikligi olamaz.
 *
 * Ikisi de OFL 1.1: Space Grotesk (Florian Karsten), Instrument Serif
 * (Rodrigo Fuenzalida / Instrument). Lisans dosyalari `public/fonts/OFL.txt`.
 *
 * `adjustFontFallback` metrik uyumlu bir yedek yuz uretir, yani `display:
 * 'swap'` sirasinda yedekten gercek yuze gecis satir kirilimlarini
 * kaydirmaz -- CLS'in bu sayfadaki en olasi kaynagi budur.
 */

export const spaceGrotesk = localFont({
  // Degisken agirlik, tek dosya: 300-700 arasi her agirlik ayni 22 KB'den gelir.
  src: '../public/fonts/space-grotesk-latin.woff2',
  weight: '300 700',
  style: 'normal',
  display: 'swap',
  variable: '--font-space-grotesk',
  adjustFontFallback: 'Arial',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
  preload: true,
})

export const instrumentSerif = localFont({
  src: '../public/fonts/instrument-serif-latin.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
  variable: '--font-instrument-serif',
  adjustFontFallback: 'Times New Roman',
  fallback: ['ui-serif', 'Georgia', 'Times New Roman', 'serif'],
  // Wordmark her sayfanin ilk satirindadir; preload edilmezse ilk boyada
  // sistem serif'iyle cizilir ve marka bir an baska bir marka gibi gorunur.
  preload: true,
})
