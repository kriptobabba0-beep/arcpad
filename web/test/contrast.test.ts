import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * KONTRAST BIR YORUMDA DEGIL BIR KAPIDA DURUR.
 *
 * Bu test `globals.css`'i OKUR -- degerleri buraya kopyalamaz. Kopyalasaydi
 * iki dogruluk kaynagi olurdu ve bir token degistiginde test yesil kalirdi ki
 * bu, hicbir testi olmamaktan kotudur: yanlis bir guvence uretir.
 *
 * Olculen sey WCAG 2.2'nin goreli parlakligidir (sRGB, 2,4 gama). Esikler:
 *   normal  >= 4,5   (normal boyutlu metin)
 *   large   >= 3     (>=18,66px kalin ya da >=24px)
 *   nonText >= 3     (odak halkasi, ikon, durum gostergesi)
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'globals.css'),
  'utf8',
)

// ---------------------------------------------------------------------------
// CSS'ten token cikarma
// ---------------------------------------------------------------------------

/** `@theme { … }`'i dengeli parantez sayarak alir; regex bir CSS ayristiricisi degildir. */
function themeBlock(css: string): string {
  const start = css.indexOf('@theme')
  if (start === -1) throw new Error('globals.css icinde @theme blogu yok')
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error('@theme blogu kapanmamis')
}

function readTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const line of themeBlock(css).split('\n')) {
    const match = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line)
    if (match?.[1] && match[2]) tokens.set(match[1], match[2].trim())
  }
  return tokens
}

const TOKENS = readTokens(CSS)

/** `var(--x)` zincirini cozer. Bir token baska bir tokenin TAKMA ADI olabilir. */
function resolve(name: string, depth = 0): string {
  if (depth > 8) throw new Error(`token dongusu: ${name}`)
  const raw = TOKENS.get(name)
  if (raw === undefined) throw new Error(`globals.css'te tanimsiz token: ${name}`)
  const alias = /^var\((--[\w-]+)\)$/.exec(raw.trim())
  return alias?.[1] ? resolve(alias[1], depth + 1) : raw.trim()
}

// ---------------------------------------------------------------------------
// Renk ve kontrast
// ---------------------------------------------------------------------------

type Rgba = { r: number; g: number; b: number; a: number }

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (hex?.[1]) {
    return {
      r: Number.parseInt(hex[1].slice(0, 2), 16),
      g: Number.parseInt(hex[1].slice(2, 4), 16),
      b: Number.parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    }
  }
  // `rgb(255 255 255 / 8%)` -- Tailwind 4'un `@theme`'inde yazildigi bicim.
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/i.exec(
    value.trim(),
  )
  if (rgb?.[1] && rgb[2] && rgb[3]) {
    const rawAlpha = rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4])
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[5] === '%' ? rawAlpha / 100 : rawAlpha,
    }
  }
  throw new Error(`cozulemeyen renk: ${value}`)
}

function channel(component: number): number {
  const s = component / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * Yari saydam bir on plani zemininin uzerine BASAR.
 *
 * Bu adim atlanamaz: alfasi olan bir rengin tek basina bir parlakligi yoktur,
 * yalnizca uzerinde durdugu seyle birlikte bir parlakligi olur. `--color-border`
 * tam olarak boyle bir token.
 */
function composite(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  }
}

function contrast(fgValue: string, bgValue: string): number {
  const bg = parseColor(bgValue)
  if (bg.a !== 1) throw new Error(`zemin saydam olamaz: ${bgValue}`)
  const fg = composite(parseColor(fgValue), bg)
  const [high, low] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

/** Iki ondalikta sabitlenmis olcum. */
function measure(fg: string, bg: string): number {
  return Math.round(contrast(fg, bg) * 100) / 100
}

/**
 * ============ BILESIK BIR ZEMIN URETIR -- VE BU KAPININ KOR NOKTASIYDI ============
 *
 * `composite()` yukarida ON PLANI zemine basar; `contrast()` ise saydam bir
 * ZEMINI acikca REDDEDER (`zemin saydam olamaz`). Ikisi birlikte tek bir seyi
 * ifade edemiyordu: **arayuzdeki cip deseni**, yani `bg-white/6` /
 * `bg-white/8`in altindaki yuzeyin uzerine basilmis hali.
 *
 * Sonucu olculdu, ve kapi degil AXE yakaladi (2026-08-17, `e2e:audit`):
 * `--color-muted` her TOKEN zemininde geciyordu, ama bir cipin BILESIK
 * zemininde 4,33:1'e (kartta) ve 3,93:1'e (surface-2'de) dusuyordu. Kapi
 * yesildi cunku o zemin tabloda YOKTU -- olculmeyen bir sey, gecmis sayilir.
 *
 * `over` bu yuzden bir kolaylik degil bir KAPSAM genislemesidir: cip zeminleri
 * artik token ciftleri kadar birinci sinif.
 */
function over(overlay: string, surface: string): string {
  const solid = composite(parseColor(overlay), parseColor(surface))
  const hex = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  return `#${hex(solid.r)}${hex(solid.g)}${hex(solid.b)}`
}

/** Arayuzun kullandigi iki cip yogunlugu. Tailwind sinifiyla BIREBIR. */
const WHITE_6 = 'rgb(255 255 255 / 6%)'
const WHITE_8 = 'rgb(255 255 255 / 8%)'

// ---------------------------------------------------------------------------
// Cift tablosu
// ---------------------------------------------------------------------------

const NORMAL = 4.5
const NON_TEXT = 3

type Pair = {
  what: string
  fg: string
  bg: string
  /** Iki ondalikta beklenen oran. Bir token karardiginda BU kirilir. */
  ratio: number
  verdict: 'passes-normal' | 'fails-normal' | 'fails-non-text'
}

/**
 * `#ffffff` bilerek bir TOKEN DEGIL, bir literal: paletin bir uyesi degil,
 * REDDEDILEN secenegin ta kendisi. Tokenlastirmak, kullanilabilir bir sey
 * gibi gorunmesini saglardi.
 */
const PAIRS: readonly Pair[] = [
  {
    what: 'govde metni',
    fg: resolve('--color-text'),
    bg: resolve('--color-bg'),
    ratio: 18.86,
    verdict: 'passes-normal',
  },
  {
    what: 'ikincil metin, sayfa zemininde',
    fg: resolve('--color-muted'),
    bg: resolve('--color-bg'),
    ratio: 5.7,
    verdict: 'passes-normal',
  },
  {
    what: 'ikincil metin, kart icinde',
    fg: resolve('--color-muted'),
    bg: resolve('--color-surface'),
    ratio: 5.34,
    verdict: 'passes-normal',
  },
  {
    what: 'girdi ici yardimci metin (SINIRDA)',
    fg: resolve('--color-muted'),
    bg: resolve('--color-surface-2'),
    ratio: 4.94,
    verdict: 'passes-normal',
  },
  {
    what: 'vurgu metni ve odak halkasi',
    fg: resolve('--color-accent'),
    bg: resolve('--color-bg'),
    ratio: 15.2,
    verdict: 'passes-normal',
  },
  {
    what: 'REDDEDILEN: birincil butonda beyaz metin (S10)',
    fg: '#ffffff',
    bg: resolve('--color-primary'),
    ratio: 3.59,
    verdict: 'fails-normal',
  },
  {
    what: 'birincil buton, arcpad deviasyonu',
    fg: resolve('--color-primary-fg'),
    bg: resolve('--color-primary'),
    ratio: 5.49,
    verdict: 'passes-normal',
  },
  {
    what: 'birincil buton, hover zemini',
    fg: resolve('--color-primary-fg'),
    bg: resolve('--color-primary-hover'),
    ratio: 15.2,
    verdict: 'passes-normal',
  },
  {
    what: 'satis / negatif',
    fg: resolve('--color-negative'),
    bg: resolve('--color-bg'),
    ratio: 6.43,
    verdict: 'passes-normal',
  },
  {
    /*
     * UYARI, VE NICIN `negative`TEN AYRI OLCULUYOR: ikisi ayni anda ekranda
     * bulunur (yuksek slipaj kehribar, cok yuksek slipaj kirmizi) ve
     * kullanicinin ayirt etmesi gereken sey tam olarak budur. Ayni tabloda
     * durmalari, birinin otekine yaklastirilmasini KIRMIZI bir test yapar.
     */
    what: 'uyari / kehribar',
    fg: resolve('--color-caution'),
    bg: resolve('--color-bg'),
    ratio: 11.16,
    verdict: 'passes-normal',
  },
  {
    what: 'kenarlik: YALNIZCA ince cizgi, odak halkasi OLAMAZ',
    fg: resolve('--color-border'),
    bg: resolve('--color-bg'),
    ratio: 1.19,
    verdict: 'fails-non-text',
  },

  // -------------------------------------------------------------------------
  // CIP ZEMINLERI -- bileşik, ve bu kapiya 2026-08-17'de EKLENDI.
  //
  // Ilk uc satir REDDEDILEN halleri kaydeder ve silinmemeleri kasitli:
  // `--color-muted`in bir cipte kullanilmasi bir kez YAPILDI ve axe onu canli
  // sayfada buldu. Reddedilen bir kombinasyonu tabloda TUTMAK, onu yeniden
  // yazan birinin karsisina olculmus bir sayi koyar -- `#ffffff` on `primary`
  // satirinin ayni gerekcesi.
  // -------------------------------------------------------------------------
  {
    what: 'REDDEDILEN: ikincil metin, kart uzerindeki cipte (axe: serious)',
    fg: resolve('--color-muted'),
    bg: over(WHITE_8, resolve('--color-surface')),
    ratio: 4.33,
    verdict: 'fails-normal',
  },
  {
    what: 'REDDEDILEN: ayni cip, kart HOVER zemininde (daha kotu)',
    fg: resolve('--color-muted'),
    bg: over(WHITE_8, resolve('--color-surface-2')),
    ratio: 3.93,
    verdict: 'fails-normal',
  },
  {
    what: 'REDDEDILEN: ince cip (white/6), hover zemininde',
    fg: resolve('--color-muted'),
    bg: over(WHITE_6, resolve('--color-surface-2')),
    ratio: 4.16,
    verdict: 'fails-normal',
  },
  {
    what: 'cip metni, EN KOTU zemin (white/8 + surface-2)',
    fg: resolve('--color-muted-raised'),
    bg: over(WHITE_8, resolve('--color-surface-2')),
    ratio: 4.83,
    verdict: 'passes-normal',
  },
  {
    what: 'cip metni, kart zemininde (white/8)',
    fg: resolve('--color-muted-raised'),
    bg: over(WHITE_8, resolve('--color-surface')),
    ratio: 5.31,
    verdict: 'passes-normal',
  },
  {
    what: 'cip metni, ince cip (white/6) hover zemininde',
    fg: resolve('--color-muted-raised'),
    bg: over(WHITE_6, resolve('--color-surface-2')),
    ratio: 5.1,
    verdict: 'passes-normal',
  },
]

describe('kontrast kapisi', () => {
  it.each(PAIRS)('$what -> $ratio:1', (pair) => {
    const measured = measure(pair.fg, pair.bg)
    expect(measured).toBe(pair.ratio)

    if (pair.verdict === 'passes-normal') expect(measured).toBeGreaterThanOrEqual(NORMAL)
    if (pair.verdict === 'fails-normal') expect(measured).toBeLessThan(NORMAL)
    // Bir odak gostergesi 3:1 ister. Bu cift onu SAGLAMAZ ve testin isi bunu
    // hatirlatmak: "kenarligi odak halkasi yapalim" onerildiginde cevap bir
    // yorum degil kirmizi bir test olur.
    if (pair.verdict === 'fails-non-text') expect(measured).toBeLessThan(NON_TEXT)
  })

  it('birincil butonun metni ZEMININ kendisidir, ayri bir renk degil', () => {
    // Deviasyonun tamami budur: palet §7.3'un paleti, degisen tek sey metnin
    // hangi uyesi oldugu. Yeni bir hex girerse bu iddia kirilir.
    expect(resolve('--color-primary-fg')).toBe(resolve('--color-bg'))
    expect(resolve('--color-primary-hover')).toBe(resolve('--color-accent'))
  })

  /**
   * TABLONUN BOYU BIR IDDIADIR: bir cifti SILMEK, onu degistirmek kadar
   * gorunur olmali. Sayi 11'den 17'ye 2026-08-17'de cikti -- alti bileşik
   * cip zemini eklendi (bkz. `over`).
   */
  it('on yedi cift, hover durumu ve cip zeminleri dahil, olculuyor', () => {
    expect(PAIRS).toHaveLength(17)
  })

  /**
   * CIP DESENI TABLODA TEMSIL EDILIYOR -- ve bu, sayidan AYRI bir iddia:
   * biri alti cifti silip yerine alti token cifti koysa `toHaveLength(17)`
   * yine gecerdi. Bileşik zeminlerin VARLIGI ayrica olculur.
   */
  it('bileşik cip zeminleri tabloda VAR', () => {
    const chipBackgrounds = new Set([
      over(WHITE_6, resolve('--color-surface')),
      over(WHITE_6, resolve('--color-surface-2')),
      over(WHITE_8, resolve('--color-surface')),
      over(WHITE_8, resolve('--color-surface-2')),
    ])
    const measured = PAIRS.filter((pair) => chipBackgrounds.has(pair.bg))
    expect(measured.length).toBeGreaterThanOrEqual(6)

    // Ve `--color-muted-raised` yalnizca cipte kullanilir: token zeminlerinde
    // `--color-muted` zaten geciyor ve ikisini karistirmak hiyerarsiyi silerdi.
    const raised = PAIRS.filter((pair) => pair.fg === resolve('--color-muted-raised'))
    expect(raised.length).toBeGreaterThan(0)
    for (const pair of raised) {
      expect(chipBackgrounds.has(pair.bg), `${pair.what} bir cip zemini degil`).toBe(true)
      expect(pair.verdict).toBe('passes-normal')
    }
  })
})

describe('globals.css sozlesmesi', () => {
  it('§7.3’un yedi rengi ve iki yaricapi BIREBIR duruyor', () => {
    // Task 6 tokenlari TAMAMLADI, DEGISTIRMEDI. Bir sonraki gorevin onlari
    // "biraz" oynatmasi bu iddiayla durur.
    expect(resolve('--color-bg')).toBe('#0b0b0b')
    expect(resolve('--color-surface')).toBe('#141414')
    expect(resolve('--color-border')).toBe('rgb(255 255 255 / 8%)')
    expect(resolve('--color-text')).toBe('#fafafa')
    expect(resolve('--color-muted')).toBe('#8a8a8a')
    expect(resolve('--color-accent')).toBe('#c6f24e')
    expect(resolve('--color-primary')).toBe('#7e8f2e')
    expect(resolve('--radius-card')).toBe('20px')
    expect(resolve('--radius-input')).toBe('14px')
  })

  it('Task 6’nin eklemeleri duruyor', () => {
    expect(resolve('--color-surface-2')).toBe('#1c1c1c')
    expect(resolve('--color-negative')).toBe('#ff5a5a')
    expect(resolve('--color-positive')).toBe(resolve('--color-accent'))
    expect(resolve('--radius-pill')).toBe('999px')
    expect(resolve('--ring')).toBe('2px')
    expect(resolve('--ring-offset')).toBe('2px')
  })

  it('color-scheme: dark bildiriliyor', () => {
    // Silinirse tarayicinin kendi form kontrolleri ve kaydirma cubuklari acik
    // temada cizilir. Koyu bir sayfada beyaz bir <select> tam olarak
    // "sablondan cikmis" izlenimidir.
    expect(CSS).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/)
  })

  it('odak halkasi VURGU rengidir, kenarlik rengi degil', () => {
    const focus = /:focus-visible\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(focus).toContain('var(--color-accent)')
    expect(focus).not.toContain('var(--color-border)')
    expect(focus).toContain('var(--ring)')
  })

  it('prefers-reduced-motion altinda butun gecisler ve animasyonlar duruyor', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1]
    expect(block, '@media (prefers-reduced-motion: reduce) blogu yok').toBeDefined()
    expect(block).toMatch(/transition-duration:\s*0s\s*!important/)
    expect(block).toMatch(/animation-duration:\s*0s\s*!important/)
    // Evrensel secici: bir bilesenin kendi gecisini bu kuraldan kacirmasi
    // mumkun olmamali.
    expect(block).toMatch(/\*\s*,/)
  })

  it('atlama baglantisi bir stile sahip -- yani gercekten gorunur hale geliyor', () => {
    expect(CSS).toMatch(/\.skip-link\s*\{/)
    expect(CSS).toMatch(/\.skip-link:focus-visible\s*\{/)
  })

  /**
   * Bu iddia `contrast.test.ts`'te, cunku olctugu sey ayni sey: tarayicinin
   * bizim adimiza cizdigi seyler. `color-scheme` form kontrollerini ve
   * kaydirma cubugunu belirler; `icon.svg` sekme ikonunu. Ikisi de eksik
   * oldugunda tarayici bir VARSAYILAN cizer ve varsayilan tam olarak
   * "sablondan cikmis" izlenimidir -- 404 veren bir favicon o izlenimin en
   * ucuz bicimi.
   */
  it('sekme ikonu var ve paletin icinden geliyor', () => {
    const icon = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icon.svg'),
      'utf8',
    )
    expect(icon).toContain('<svg')
    expect(icon).toContain('#0B0B0B')
    expect(icon).toContain('#C6F24E')
  })

  it('iki yuz de kendi sunucumuzdan tanimlaniyor, harici bir font hostu yok', () => {
    expect(CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|@import\s+url\(/)
    expect(CSS).toContain("url('/fonts/space-grotesk-latin-ext.woff2')")
    expect(CSS).toContain("url('/fonts/instrument-serif-latin-ext.woff2')")
  })
})
