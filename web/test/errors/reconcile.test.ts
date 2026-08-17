import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ARCPAD_ERROR_NAMES } from '@arcpad/shared/browser'
import { describe, expect, it } from 'vitest'
import {
  CALL_PATH,
  ERROR_SURFACE,
  REACHABLE_BY_ACTION,
  SHADOWED_BY_GUARD,
  SOURCE_UNITS,
  surfaceKeys,
  TABLE_FIX_ADD,
  TABLE_FIX_REMOVE,
  TABLE_FIX_UNREACHABLE,
} from '@/components/errors/reachableErrors'
import {
  ARCPAD_ACTIONS,
  type ArcpadAction,
  errorNameOf,
  FAILURE_TABLE,
  type FailureKey,
  UNREACHABLE_BY_CONSTRUCTION,
} from '@/lib/failureTable'

/**
 * TABLO ILE ULASILABILIR KUME BIRBIRINDEN AYRILAMAZ -- IKI YONDE DE.
 *
 * Task 3 tek yonlu bir kapi birakti: "ABI icindeki her hata ya tabloda ya
 * ulasilamaz listesinde". O kapi TERS yonu hic gormez. Tabloda duran ama o
 * giris noktasinin kodunda hic bulunmayan bir satiri kiran hicbir sey yoktu,
 * ve olculdu ki 18 hucre boyleydi. Olu satirli bir hata yuzeyi tam GORUNUR;
 * eksik satirli olan ise kullaniciya "bilinmeyen hata" yazdirir. Ikisi bir
 * arada kisa bir tablodan daha kotudur.
 *
 * KAPININ TAUTOLOJI OLMAMASI ICIN otorite BURADA KAYNAKTAN YENIDEN URETILIR:
 * `.sol` dosyalari taranir, her eylemin cagri yolundaki fonksiyonlarin
 * `revert` adlari toplanir, ve `ERROR_SURFACE` ile karsilastirilir. Elle
 * yazilmis iki listenin birbirini onaylamasi degil; kontratin kendisinin
 * listeyi onaylamasi.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Yorumlari ve dize sabitlerini BOSLUKLA doldurur.
 *
 * Zorunlu, susleme degil: bu kontratlarin yorumlari uzun ve kod ORNEGI
 * iceriyor -- `BondingCurve.sol` icinde bir yorum satiri
 * `deposit{value: creatorFee}(address(0))` yaziyor. Ham metin uzerinde suslu
 * parantez saymak o satirda govde sinirini kaydirirdi.
 */
function stripCommentsAndStrings(source: string): string {
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
    if (c === '"' || c === "'") {
      const quote = c
      out += ' '
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += ' '
      i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

const SIGNATURE = /\b(?:function\s+([A-Za-z_]\w*)|(constructor))\s*\(/g

/** Bir kaynak dosyanin `fonksiyon adi -> govde` haritasi. Ayni adli asiri yuklemeler BIRLESTIRILIR. */
function bodiesOf(file: string): ReadonlyMap<string, string> {
  const source = stripCommentsAndStrings(readFileSync(REPO_ROOT + file, 'utf8'))
  const bodies = new Map<string, string>()
  for (const match of source.matchAll(SIGNATURE)) {
    const name = match[1] ?? 'constructor'
    let cursor = (match.index ?? 0) + match[0].length
    let open = -1
    while (cursor < source.length) {
      if (source[cursor] === '{') {
        open = cursor
        break
      }
      // Arayuz bildirimi (`function f(...) external;`) -- govdesi yok.
      if (source[cursor] === ';') break
      cursor += 1
    }
    if (open === -1) continue
    let depth = 0
    let end = open
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const body = source.slice(open, end + 1)
    const prior = bodies.get(name)
    bodies.set(name, prior === undefined ? body : `${prior}\n${body}`)
  }
  return bodies
}

const fileCache = new Map<string, ReadonlyMap<string, string>>()

function bodyOf(qualified: string): string {
  const [unit, fn] = qualified.split('.')
  const file = SOURCE_UNITS[unit ?? '']
  if (file === undefined) throw new Error(`${qualified}: no source file registered for ${unit}`)
  let bodies = fileCache.get(file)
  if (bodies === undefined) {
    bodies = bodiesOf(file)
    fileCache.set(file, bodies)
  }
  const body = bodies.get(fn ?? '')
  if (body === undefined) throw new Error(`${qualified}: no such function in ${file}`)
  return body
}

function revertsIn(qualified: string): readonly string[] {
  return [...bodyOf(qualified).matchAll(/\brevert\s+([A-Za-z_]\w*)\s*\(/g)].map(
    (m) => m[1] as string,
  )
}

/** `deposit{value: x}(...)` da bir cagridir; suslu parantezli cagri sozdizimi opsiyoneldir. */
function calls(body: string, callee: string): boolean {
  return new RegExp(`\\b${callee}\\s*(\\{[^}]*\\})?\\s*\\(`).test(body)
}

const ABI_NAMES = new Set(ARCPAD_ERROR_NAMES)
const GLOBALLY_UNREACHABLE = new Set(UNREACHABLE_BY_CONSTRUCTION)

/** Bir eylemin cagri yolunun urettigi TUM `revert` adlari -- otoritenin ust kumesi. */
function derivedFor(action: ArcpadAction): ReadonlySet<string> {
  return new Set(CALL_PATH[action].flatMap(revertsIn))
}

/** Turetilenden istisnalari dusurunce kalan: OTORITENIN kendisi. */
function authorityFor(action: ArcpadAction): ReadonlySet<string> {
  const shadowed = SHADOWED_BY_GUARD[action]
  return new Set(
    [...derivedFor(action)].filter(
      (name) => !(name in shadowed) && !GLOBALLY_UNREACHABLE.has(name) && ABI_NAMES.has(name),
    ),
  )
}

const tableKeys = (): readonly FailureKey[] => Object.keys(FAILURE_TABLE) as FailureKey[]

// `Set<string>`, `Set<FailureKey>` DEGIL: bu kumeler DOKTORLANMIS anahtar
// listeleriyle de sorgulanir (mutasyon testleri) ve orada anahtar sablonu
// tutmayabilir. Dar tip, uydurma bir anahtari derleme zamaninda reddedip
// mutantin hic kosmamasina yol acardi.
const LEDGER_REMOVE = new Set<string>(TABLE_FIX_REMOVE.map((fix) => fix.key))
const LEDGER_ADD = new Set<string>(TABLE_FIX_ADD.map((fix) => fix.key))

/**
 * Tablo ile otorite arasindaki fark, DEFTERDE YAZILI OLANLAR DUSULMUS.
 *
 * Defter uygulanmadan once de uygulandiktan sonra da BOS doner: olmayan bir
 * anahtari silmek etkisizdir, var olan bir anahtari eklemek de. Yazilmamis bir
 * fark cikar cikmaz dolar.
 */
function unlistedDivergence(keys: readonly string[]): { dead: string[]; missing: string[] } {
  const table = new Set(keys)
  const authority = new Set(surfaceKeys() as readonly string[])
  return {
    dead: keys.filter((key) => !authority.has(key) && !LEDGER_REMOVE.has(key)).sort(),
    missing: [...authority].filter((key) => !table.has(key) && !LEDGER_ADD.has(key)).sort(),
  }
}

describe('the surface is derived from the contracts, not asserted', () => {
  it('every call path names real functions and every hop is really called', () => {
    let hops = 0
    for (const action of ARCPAD_ACTIONS) {
      const path = CALL_PATH[action]
      expect(path.length, `${action} has an empty call path`).toBeGreaterThan(0)
      const bodies = path.map(bodyOf)
      for (const qualified of path.slice(1)) {
        const [unit, fn] = qualified.split('.')
        // `constructor` bir ad ile degil `new <Birim>` ile cagrilir.
        const callee = fn === 'constructor' ? `new ${unit}` : (fn as string)
        const called =
          fn === 'constructor'
            ? bodies.some((body) => body.includes(callee))
            : bodies.some((body) => calls(body, callee))
        expect(
          called,
          `${action}: ${qualified} is on the path but nothing on the path calls it`,
        ).toBe(true)
        hops += 1
      }
    }
    // 31 -> 32: buyback nesli `launch`i `_launch`e boldu, yani `launch`
    // eylemi bir hop daha tasiyor. Sayi elle guncellenir ve bu KASITLIDIR --
    // yoldan bir dugum DUSMESI de burayi kirmizi yapar, ki dusen bir dugum
    // sessizce daralan bir hata yuzeyi demektir.
    expect(hops).toBe(32) // anti-vacuity: her hop gercekten yuruldu
  })

  it('every `at` citation really reverts that name, in a function on the path', () => {
    let citations = 0
    for (const action of ARCPAD_ACTIONS) {
      const path = new Set(CALL_PATH[action])
      for (const [name, spec] of Object.entries(ERROR_SURFACE[action])) {
        expect(spec.at.length, `${action}:${name} cites no revert site`).toBeGreaterThan(0)
        expect(spec.why.length, `${action}:${name} has no justification`).toBeGreaterThan(0)
        for (const site of spec.at) {
          expect(path, `${action}:${name} cites ${site}, which is not on the call path`).toContain(
            site,
          )
          expect(
            revertsIn(site),
            `${action}:${name} cites ${site}, which does not revert ${name}`,
          ).toContain(name)
          citations += 1
        }
      }
    }
    // 53 -> 54: `launch:BuybackUnavailable` gercek bir hucre oldu.
    expect(citations).toBe(54) // anti-vacuity
  })

  it('every shadowed name is really on the path -- a stale exception is a lie', () => {
    let shadows = 0
    for (const action of ARCPAD_ACTIONS) {
      const derived = derivedFor(action)
      for (const [name, why] of Object.entries(SHADOWED_BY_GUARD[action])) {
        expect(
          derived,
          `${action}: ${name} is listed as shadowed but the path no longer reverts it`,
        ).toContain(name)
        expect(why.length, `${action}: ${name} is shadowed without a reason`).toBeGreaterThan(0)
        shadows += 1
      }
    }
    // 12 -> 11: `BuybackUnavailable` ARTIK GOLGELI DEGIL. Create formu
    // `launchWithBuyback` cagirabildigi icin koruma gercekten ulasilabilir;
    // golge listesinden cikip `FAILURE_TABLE`a gecti.
    expect(shadows).toBe(11)
  })

  it('the declared surface EQUALS what the sources derive, in both directions', () => {
    for (const action of ARCPAD_ACTIONS) {
      const derived = authorityFor(action)
      const declared = new Set(Object.keys(ERROR_SURFACE[action]))
      const missing = [...derived].filter((name) => !declared.has(name)).sort()
      const invented = [...declared].filter((name) => !derived.has(name)).sort()
      expect(
        missing,
        `${action}: the contracts can revert with these and the surface omits them`,
      ).toEqual([])
      expect(
        invented,
        `${action}: the surface claims these and the contracts cannot revert them`,
      ).toEqual([])
    }
  })

  it('every name a call path reverts with exists in ARCPAD_ERROR_ABI', () => {
    // Bir `.sol` dosyasinin ABI kopyasindan ONDE olmasi, kullanicinin
    // cozulemeyen bir selector gormesi demektir. Sessiz gecmemeli.
    for (const action of ARCPAD_ACTIONS) {
      for (const name of derivedFor(action)) {
        expect(
          ABI_NAMES,
          `${action}: ${name} is in the source but not in the committed ABI`,
        ).toContain(name)
      }
    }
  })
})

describe('THE GATE: the table and the reachable set may not diverge', () => {
  it('there is no unlisted divergence in either direction', () => {
    const { dead, missing } = unlistedDivergence(tableKeys())
    expect(dead, 'FAILURE_TABLE carries cells the contracts cannot produce').toEqual([])
    expect(missing, 'the contracts can produce cells FAILURE_TABLE has no text for').toEqual([])
  })

  it('the gate CATCHES a removed live cell', () => {
    // Mutant: `NetTooSmall` tablodan cikarilir. Kutuphane katmanindaki tek
    // ulasilabilir hata; kaybi kucuk alimlari "bilinmeyen hata" yapar.
    const doctored = tableKeys().filter((key) => key !== 'buyExactQuoteIn:NetTooSmall')
    expect(unlistedDivergence(doctored).missing).toEqual(['buyExactQuoteIn:NetTooSmall'])
  })

  it('the gate CATCHES an invented dead cell', () => {
    const doctored = [...tableKeys(), 'claim:CurveComplete']
    expect(unlistedDivergence(doctored).dead).toEqual(['claim:CurveComplete'])
  })

  it('the ledger cannot be used to hide a live cell', () => {
    // Her `remove` girdisi otoritede OLMAMALI, her `add` girdisi OLMALI.
    const authority = new Set(surfaceKeys() as readonly string[])
    for (const fix of TABLE_FIX_REMOVE) {
      expect(authority, `${fix.key} is listed for removal but IS reachable`).not.toContain(fix.key)
      expect(fix.why.length).toBeGreaterThan(0)
    }
    for (const fix of TABLE_FIX_ADD) {
      expect(authority, `${fix.key} is listed as missing but is NOT reachable`).toContain(fix.key)
      expect(fix.why.length).toBeGreaterThan(0)
    }
  })

  it('the ledger describes exactly the divergence that exists today', () => {
    // Bugunku olcum, rapordaki sayilarla birebir. Defter uygulaninca bu test
    // duser -- ve dusmesi DOGRUDUR: o gun defter bosalmalidir.
    const table = new Set(tableKeys())
    const authority = new Set(surfaceKeys() as readonly string[])
    const pendingRemove = TABLE_FIX_REMOVE.filter((fix) => table.has(fix.key))
    const pendingAdd = TABLE_FIX_ADD.filter((fix) => !table.has(fix.key))
    const applied = pendingRemove.length === 0 && pendingAdd.length === 0
    if (applied) {
      expect([...table].sort()).toEqual([...authority].sort())
      return
    }
    expect(pendingRemove).toHaveLength(18)
    expect(pendingAdd).toHaveLength(3)
    expect(pendingAdd.map((fix) => fix.key).sort()).toEqual([
      'buyExactQuoteIn:ZeroRecipient',
      'buyExactTokensOut:ZeroRecipient',
      'sellExactTokensIn:ZeroRecipient',
    ])
  })

  it('applying the ledger keeps every ABI error classified', () => {
    // Duzeltmenin UYGULANABILIR oldugunun ispati: silinen hucrelerden sonra
    // hicbir hata siniflandirilmamis kalmamali, yoksa Task 3 kapisi kirilir.
    const after = new Set(
      [...new Set([...tableKeys(), ...LEDGER_ADD])].filter((key) => !LEDGER_REMOVE.has(key)),
    )
    const classified = new Set([
      ...[...after].map(errorNameOf),
      ...UNREACHABLE_BY_CONSTRUCTION,
      ...TABLE_FIX_UNREACHABLE,
    ])
    for (const name of ARCPAD_ERROR_NAMES) {
      expect(classified, `${name} would be unclassified after the fix`).toContain(name)
    }
  })

  it('the names moved to UNREACHABLE really lose their last cell', () => {
    const after = new Set(
      [...new Set([...tableKeys(), ...LEDGER_ADD])].filter((key) => !LEDGER_REMOVE.has(key)),
    )
    const surviving = new Set([...after].map(errorNameOf))
    for (const name of TABLE_FIX_UNREACHABLE) {
      expect(surviving, `${name} still has a cell; it must NOT move to UNREACHABLE`).not.toContain(
        name,
      )
    }
    // ...ve tersi: silinen ama BASKA hucresi kalan adlar tasinmamalidir.
    for (const key of LEDGER_REMOVE) {
      const name = errorNameOf(key)
      if (surviving.has(name)) {
        expect(
          TABLE_FIX_UNREACHABLE,
          `${name} still has a cell and must not be moved`,
        ).not.toContain(name)
      }
    }
  })
})

describe('REACHABLE_BY_ACTION is the user-facing half, and it is not empty', () => {
  it('is a subset of the surface and excludes the operator class', () => {
    let total = 0
    for (const action of ARCPAD_ACTIONS) {
      for (const name of REACHABLE_BY_ACTION[action]) {
        const spec = ERROR_SURFACE[action][name]
        expect(spec, `${action}:${name} is reachable but not on the surface`).toBeDefined()
        expect(spec?.reach, `${action}:${name}`).not.toBe('operator')
        total += 1
      }
    }
    // 24 -> 25: `launch:BuybackUnavailable` kullaniciya gorunen bir
    // hucre oldu (reach `user`), yani ulasilabilir kumeye girdi.
    expect(total).toBe(25) // anti-vacuity
  })

  it('names the entrypoint-specific errors on the RIGHT entrypoint only', () => {
    // FAILURE MODE 1, dogrudan: bir yolda kapatilan ozellik hepsinde
    // kapatilmis GORUNMEMELI.
    expect(REACHABLE_BY_ACTION.buyExactTokensOut).toContain('NotEnoughTokensToBuy')
    expect(REACHABLE_BY_ACTION.buyExactQuoteIn).not.toContain('NotEnoughTokensToBuy')
    expect(REACHABLE_BY_ACTION.buyExactQuoteIn).toContain('NetTooSmall')
    expect(REACHABLE_BY_ACTION.buyExactTokensOut).not.toContain('NetTooSmall')
    expect(REACHABLE_BY_ACTION.sellExactTokensIn).toContain('ProceedsTooSmall')
    expect(REACHABLE_BY_ACTION.sellExactTokensIn).toContain('ERC20InsufficientAllowance')
  })

  it('CurveComplete and SlippageExceeded are reachable on ALL THREE entrypoints', () => {
    for (const action of ['buyExactQuoteIn', 'buyExactTokensOut', 'sellExactTokensIn'] as const) {
      expect(REACHABLE_BY_ACTION[action]).toContain('CurveComplete')
      expect(REACHABLE_BY_ACTION[action]).toContain('SlippageExceeded')
    }
  })

  it('the library layer is resolved: NetTooSmall is NOT declared in BondingCurve.sol', () => {
    // Brief K: `NetTooSmall` `CurveMath` icinde tanimlidir ve curve giris
    // noktasindan cikar. Cozucunun kutuphane katmanini da tanimasi gerektigi
    // buradan gelir -- tanimazsa kullanici bilinmeyen bir selector gorur.
    const curveSource = readFileSync(`${REPO_ROOT}contracts/src/BondingCurve.sol`, 'utf8')
    expect(curveSource).not.toMatch(/^\s*error NetTooSmall\(\);/m)
    expect(revertsIn('CurveMath.quoteBuyTokensOut')).toContain('NetTooSmall')
    expect(ERROR_SURFACE.buyExactQuoteIn.NetTooSmall?.at).toEqual([
      'CurveMath.correctedNetQuoteIn',
      'CurveMath.quoteBuyTokensOut',
    ])
  })
})
