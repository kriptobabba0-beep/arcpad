import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ============ BIR SURUM TARIHI, EKRANDA, ESKIYEN BIR IDDIADIR ============
 *
 * BULUNUS. 2026-08-09'da Arc'a yapilandirilmis bir build gercek bir tarayicida
 * surulup canli tamamlanmis curve (`0xDdB9e739…f27b`) acildi. Kart soyle
 * diyordu:
 *
 *     "Sale supply sold out. Trading on the curve is closed;
 *      pool creation lands with Phase 2."
 *
 * Faz 2 2026-08-06'DAN BERI ZINCIRDE: `PoolManager 0x617321A8…`,
 * `ArcpadHook 0xd95198Cd…`, `ArcpadLocker 0x0e777109…`, ucu de
 * `contracts/deploy/addresses.5042002.json` icinde. Cumle okuyucuyu var olmayan
 * bir beklemeye yonlendiriyordu; gercek sebep fabrikanin `graduationTarget`inin
 * `0x0` olmasiydi ve ekranda ondan TEK KELIME yoktu.
 *
 * VE AYNI CUMLE IKI YERDEYDI. `components/token/LifecycleNotice.tsx` ile
 * `components/explore/CompleteSection.tsx`. Bir tanesi bulunmustu; oteki
 * bulunmadan duzeltilseydi bu deponun en sik kusuru ("bir giris noktasinda
 * kapatilan sey hepsinde kapatilmis gorunur") bir kez daha islemis olurdu. Bu
 * yuzden kapi TEK BIR BILESENE DEGIL, KULLANICIYA METIN CIZEN BUTUN AGACA
 * bakar: ikinci nusha, ilkini duzelten testin GORMEDIGI seydi.
 *
 * NEDEN KAYNAK TARAMASI VE NEDEN BIR RENDER DEGIL. Cumleyi ucuncu bir bilesene
 * yazan biri, o bilesen icin bir render testi yazmaz -- yazsaydi zaten fark
 * ederdi. Kapinin yakalamasi gereken sey tam olarak "kimsenin bakmadigi yerde
 * dogan uculuncu nusha", dolayisiyla kapi dosya sisteminde dolasir.
 *
 * YORUMLAR SOYULUR, DIZELER VE JSX METNI KALIR. Bu dosyanin ve duzeltilen iki
 * bilesenin YORUMLARI "Faz 2" / "Phase 2" demek ZORUNDA -- neyin neden
 * degistigi orada yaziyor. Yasak olan sey KULLANICIYA CIZILEN metindir, yani
 * tarama yorumsuz metin uzerinde yapilir.
 */

const COMPONENTS = fileURLToPath(new URL('../../components/', import.meta.url))

/** `.ts`/`.tsx` yorumlarini BOSLUKLA doldurur; dizeler ve JSX metni KALIR. */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const d = source[i + 1]
    if (c === '/' && d === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (c === '/' && d === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

function walk(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = `${dir}${entry}`
    if (statSync(full).isDirectory()) {
      found.push(...walk(`${full}/`))
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(full)
  }
  return found
}

/**
 * YASAKLI KALIPLAR, ve her biri BIR SINIF -- bir dize degil.
 *
 * `phase 2`      -- bir surum adi. Bugun yanlis; yarin baska bir faz icin yine
 *                   yanlis olacak. Ekranin anlatmasi gereken sey MEKANIZMA.
 * `lands with`   -- "birazdan gelecek" vaadi. Graduation icin OZELLIKLE
 *                   yanlistir: otomatik bir yol YAZILAMAZ (`graduate()`
 *                   `msg.sender == graduationTarget` ister ve `BondingCurve`un
 *                   creation code'u donmus), yani beklenecek bir surum yok.
 * `coming soon`  -- ayni vaadin adi konmamis hali.
 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /phase\s*2/i, why: 'a release name on screen; Phase 2 shipped on 2026-08-06' },
  { pattern: /lands\s+with/i, why: 'promises a future release; graduation has no automatic path' },
  { pattern: /coming\s+soon/i, why: 'the same promise without a name' },
]

describe('the interface does not make claims about releases', () => {
  it('no component renders a release name or a "wait for it" promise', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const file of walk(COMPONENTS)) {
      const body = stripComments(readFileSync(file, 'utf8'))
      scanned += 1
      for (const { pattern, why } of FORBIDDEN) {
        const hit = pattern.exec(body)
        if (hit !== null) {
          offenders.push(`${file.slice(COMPONENTS.length)}: "${hit[0]}" -- ${why}`)
        }
      }
    }
    // ANTI-VACUITY: bos bir liste uzerinde her iddia gecer. Sayilar degisebilir,
    // ama SIFIR olamaz -- bir yol hatasi tam olarak boyle sessiz gecerdi.
    expect(scanned, 'the walker found no components to scan').toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })

  it('the gate CATCHES the exact sentence that was live, and does not fire on a comment', () => {
    // Mutant: kaldirilan cumlenin kendisi. Kapinin bu metni yakalamasi
    // gerekiyordu ve YAKALAMIYORDU -- cunku hicbir kapi yoktu.
    const live = 'Trading on the curve is closed; pool creation lands with Phase 2.'
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(live))).toBe(true)

    // KONTROL: ayni kelimeler bir YORUM icinde serbesttir, yoksa neyin neden
    // degistigini yazmak imkansiz olurdu ve kapi kendi gerekcesini yasaklardi.
    const commented = `// pool creation lands with Phase 2\nconst a = 1\n`
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(commented)))).toBe(false)
    const blockComment = `/* Faz 2 zincirde */\nexport const b = 'Curve complete'\n`
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(blockComment)))).toBe(false)
  })
})
