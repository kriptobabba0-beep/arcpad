import { describe, expect, it } from 'vitest'
import {
  checkMetadataText,
  METADATA_LIMITS,
  normaliseMetadataText,
  sanitiseForDisplay,
  truncateToBytes,
  utf8ByteLength,
} from '../src/text'

/**
 * Test text is built from CODE POINTS, not pasted glyphs. `́` and a
 * precomposed `e-acute` are indistinguishable in a diff, and the entire point
 * of this file is that they are different strings.
 */
const cp = (...points: number[]) => String.fromCodePoint(...points)

const E_ACUTE_NFC = cp(0x00e9) // precomposed
const E_ACUTE_NFD = cp(0x0065, 0x0301) // 'e' + combining acute
const ROCKET = cp(0x1f680)
const GORUSURUZ = cp(0x47, 0xf6, 0x72, 0xfc, 0x15f, 0xfc, 0x72, 0xfc, 0x7a) // Gorusuruz, Turkish
const KOREAN = cp(0xc548, 0xb155, 0xd558, 0xc138, 0xc694, 0x20, 0xd1a0, 0xd070) // "hello token"

describe('utf8ByteLength counts BYTES, not UTF-16 code units', () => {
  /**
   * THE MEASURED TABLE. The `.length` column is what a naive form validates
   * with; the byte column is what `bytes(name_).length` compares on chain.
   * They disagree on every row but the first.
   */
  it.each([
    // input          .length  code points  utf-8 bytes
    ['arcpad', 6, 6, 6],
    [E_ACUTE_NFC, 1, 1, 2],
    [E_ACUTE_NFD, 2, 2, 3],
    [ROCKET, 2, 1, 4],
    [ROCKET.repeat(8), 16, 8, 32],
    [ROCKET.repeat(9), 18, 9, 36],
    [GORUSURUZ, 9, 9, 14],
    [KOREAN, 8, 8, 22],
  ])('%s: length %i, %i code points, %i bytes', (input, length, points, bytes) => {
    expect(input.length).toBe(length)
    expect([...input].length).toBe(points)
    expect(utf8ByteLength(input)).toBe(bytes)
  })

  /**
   * THE REASON THIS TASK EXISTS. Nine rockets is 36 bytes. A form that
   * validates `.length <= 32` accepts it (18), the user pays gas, and
   * `LaunchToken`'s constructor answers `NameTooLong()`.
   */
  it('nine rockets are refused as a name; .length says 18 and would accept', () => {
    const nine = ROCKET.repeat(9)
    expect(nine.length).toBeLessThan(32) // what the trap looks like
    const verdict = checkMetadataText('name', nine)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.reason).toBe('tooLong')
    expect(verdict.bytes).toBe(36)
    expect(verdict.limit).toBe(32)
  })

  it('eight rockets sit exactly on the name limit and are accepted', () => {
    const eight = ROCKET.repeat(8)
    expect(checkMetadataText('name', eight)).toEqual({ ok: true, value: eight, bytes: 32 })
  })

  it('the limits are the ones the contract compares against', () => {
    // Hand-copied from contracts/src/LaunchToken.sol lines 31-33, NOT read
    // from a shared constant -- a test that reads what it pins proves nothing.
    expect(METADATA_LIMITS).toEqual({ name: 32, symbol: 13, uri: 200 })
  })
})

describe('normaliseMetadataText', () => {
  /**
   * The string that is counted and the string that is sent must be the SAME
   * string. NFD e-acute is 3 bytes, its NFC form is 2 -- one glyph, two
   * lengths, and a form that counts one while the wallet sends the other is
   * checking a limit against a string that will not be the one to revert.
   */
  it('folds NFD to NFC before anything counts bytes', () => {
    expect(utf8ByteLength(E_ACUTE_NFD)).toBe(3)
    expect(utf8ByteLength(normaliseMetadataText(E_ACUTE_NFD))).toBe(2)
    expect(normaliseMetadataText(E_ACUTE_NFD)).toBe(E_ACUTE_NFC)
  })

  it('is what checkMetadataText measures, so a boundary name is not off by one', () => {
    // 32 NFD e-acutes are 96 raw bytes but 64 normalised -- still too long.
    // 16 of them are 48 raw bytes and 32 normalised: EXACTLY on the limit,
    // and rejected by anything that counts before normalising.
    const sixteen = E_ACUTE_NFD.repeat(16)
    expect(utf8ByteLength(sixteen)).toBe(48)
    const verdict = checkMetadataText('name', sixteen)
    expect(verdict.ok).toBe(true)
    expect(verdict.bytes).toBe(32)
  })

  it('drops surrounding whitespace, which is invisible and costs bytes', () => {
    expect(normaliseMetadataText('  arcpad  ')).toBe('arcpad')
    expect(checkMetadataText('name', '   ')).toEqual({
      ok: false,
      value: '',
      bytes: 0,
      limit: 32,
      reason: 'empty',
    })
  })
})

describe('truncateToBytes cuts at a code point, never inside one', () => {
  it('never splits an emoji', () => {
    const eight = ROCKET.repeat(8)
    // 30 bytes leaves room for seven rockets (28) and not the eighth.
    const cut = truncateToBytes(eight, 30)
    expect(cut).toBe(ROCKET.repeat(7))
    expect(utf8ByteLength(cut)).toBe(28)
    // A byte-index slice would have produced a lone surrogate here. Prove the
    // output is still well formed: encode/decode is lossless, no U+FFFD.
    expect([...cut].length).toBe(7)
    expect(cut).not.toContain(cp(0xfffd))
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(cut))).toBe(
      cut,
    )
  })

  it('returns the input untouched when it already fits', () => {
    expect(truncateToBytes('arcpad', 32)).toBe('arcpad')
    expect(truncateToBytes(ROCKET.repeat(8), 32)).toBe(ROCKET.repeat(8))
  })

  it('can return the empty string when even one code point does not fit', () => {
    expect(truncateToBytes(ROCKET, 3)).toBe('')
  })

  it('refuses a negative ceiling', () => {
    expect(() => truncateToBytes('arcpad', -1)).toThrow(RangeError)
  })
})

describe('sanitiseForDisplay', () => {
  it('drops C0 and C1 controls, including the NUL that launched fine on chain', () => {
    expect(sanitiseForDisplay(`arc${cp(0x00)}pad`)).toBe('arcpad')
    expect(sanitiseForDisplay(`arc${cp(0x1b)}[31mpad`)).toBe('arc[31mpad')
    expect(sanitiseForDisplay(`arc${cp(0x9b)}pad`)).toBe('arcpad')
  })

  /**
   * The imitation vector. A right-to-left override lets one string RENDER as
   * another; React's escaping does not touch it because it is not markup.
   */
  it('drops bidi overrides and isolates', () => {
    expect(sanitiseForDisplay(`arc${cp(0x202e)}pad`)).toBe('arcpad')
    expect(sanitiseForDisplay(`${cp(0x2066)}arcpad${cp(0x2069)}`)).toBe('arcpad')
  })

  it('drops zero-width characters, which let two different names look identical', () => {
    const withZwsp = `arc${cp(0x200b)}pad`
    const plain = 'arcpad'
    expect(withZwsp).not.toBe(plain) // two different keys...
    expect(sanitiseForDisplay(withZwsp)).toBe(plain) // ...one rendering
    expect(sanitiseForDisplay(`arc${cp(0x200d)}pad`)).toBe('arcpad')
    expect(sanitiseForDisplay(`${cp(0xfeff)}arcpad`)).toBe('arcpad')
  })

  it('collapses runs of whitespace and trims', () => {
    expect(sanitiseForDisplay('  arc   pad \n\t x ')).toBe('arc pad x')
  })

  it('leaves ordinary non-ASCII text alone', () => {
    expect(sanitiseForDisplay(GORUSURUZ)).toBe(GORUSURUZ)
    expect(sanitiseForDisplay(KOREAN)).toBe(KOREAN)
    expect(sanitiseForDisplay(ROCKET)).toBe(ROCKET)
  })
})
