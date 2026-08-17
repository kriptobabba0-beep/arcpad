/**
 * METADATA TEXT, COUNTED THE WAY THE CHAIN COUNTS IT.
 *
 * `LaunchToken`'s constructor rejects on `bytes(name_).length > 32`. Solidity's
 * `bytes(string).length` is a UTF-8 BYTE count; JavaScript's `String.length` is
 * a UTF-16 CODE UNIT count. They agree on ASCII and on nothing else, so a form
 * that validates with `.length` accepts a nine-rocket name (`.length === 18`),
 * sends it, and the user pays gas for a `NameTooLong()`.
 */

/** Byte ceilings, from `contracts/src/LaunchToken.sol` (32 / 13 / 200). */
export const METADATA_LIMITS = { name: 32, symbol: 13, uri: 200 } as const

export type MetadataField = keyof typeof METADATA_LIMITS

const ENCODER = new TextEncoder()

/** UTF-8 BYTE count. `TextEncoder`, not `String.length`. */
export function utf8ByteLength(s: string): number {
  return ENCODER.encode(s).length
}

/**
 * The string that goes to the chain and the string that gets counted MUST be
 * the same string, so NFC normalisation happens BEFORE the count and the
 * normalised form is what is sent.
 *
 * Measured: `"e" + U+0301` (NFD) is 3 bytes, its NFC form `"é"` is 2. Same
 * glyph on screen, two different lengths -- and if the form counts one form
 * while the wallet sends the other, the limit check is checking a different
 * string than the one that will revert.
 *
 * Surrounding whitespace is dropped for the same reason it is dropped from a
 * username: it is invisible, it costs bytes, and `" arcpad"` and `"arcpad"`
 * are two names that look identical in every list.
 */
export function normaliseMetadataText(s: string): string {
  return s.normalize('NFC').trim()
}

/**
 * Cuts to a byte ceiling at a CODE POINT boundary -- never mid-emoji.
 *
 * Slicing by byte index produces a lone surrogate, which is not valid UTF-8;
 * `TextEncoder` silently substitutes U+FFFD and the result is both mangled and
 * a different length than the caller believes.
 *
 * Grapheme clusters are NOT preserved: a ZWJ family emoji can lose members at
 * the cut. That is a deliberate limit -- the chain counts bytes, and honouring
 * clusters would mean a truncation that can refuse to make progress.
 */
export function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes < 0)
    throw new RangeError(`truncateToBytes: maxBytes cannot be negative: ${maxBytes}`)
  if (utf8ByteLength(s) <= maxBytes) return s
  let used = 0
  let out = ''
  for (const codePoint of s) {
    const size = utf8ByteLength(codePoint)
    if (used + size > maxBytes) break
    out += codePoint
    used += size
  }
  return out
}

export type MetadataCheck =
  | { ok: true; value: string; bytes: number }
  | { ok: false; value: string; bytes: number; limit: number; reason: 'empty' | 'tooLong' }

/**
 * The one call a form makes: normalise, count bytes, compare against the
 * chain's ceiling. Returns the NORMALISED string so the caller sends exactly
 * what was measured.
 */
export function checkMetadataText(field: MetadataField, raw: string): MetadataCheck {
  const value = normaliseMetadataText(raw)
  const bytes = utf8ByteLength(value)
  const limit = METADATA_LIMITS[field]
  if (bytes === 0) return { ok: false, value, bytes, limit, reason: 'empty' }
  if (bytes > limit) return { ok: false, value, bytes, limit, reason: 'tooLong' }
  return { ok: true, value, bytes }
}

/**
 * Characters that are invisible on screen but present in the string, plus the
 * bidi controls that let one string RENDER as another.
 *
 * C0 (U+0000-U+001F) and C1 (U+007F-U+009F); the bidi embeddings and overrides
 * (U+202A-U+202E) and isolates (U+2066-U+2069); the directional marks and
 * zero-width family (U+200B-U+200F, U+2060-U+2064, U+FEFF).
 */
// Written as ESCAPES, not as a literal character class: a literal class here
// would put invisible characters into the source file, where no reviewer can
// see them and no diff can show them.
const INVISIBLE = new RegExp(
  '[' +
    '\u0000-\u001F' + // C0 controls, including NUL
    '\u007F-\u009F' + // DEL and the C1 controls
    '\u200B-\u200F' + // zero-width space/non-joiner/joiner, LRM, RLM
    '\u202A-\u202E' + // bidi embeddings and OVERRIDES
    '\u2060-\u2064' + // word joiner and the invisible operators
    '\u2066-\u2069' + // bidi isolates
    '\uFEFF' + // BOM / zero-width no-break space
    ']',
  'gu',
)

/**
 * Display hygiene for names and symbols that came off the chain.
 *
 * There is NO character restriction on-chain -- only a byte length. Faz 1c's
 * review launched with NUL bytes and invalid UTF-8 in the metadata and
 * canonicity held, so a launch name can be prepared to render on screen as
 * another token's name. React's escaping stops HTML injection; it does not
 * stop VISUAL IMITATION, which is the attack that matters on a launchpad.
 *
 * THE RULE THIS SUPPORTS: a name or symbol is NEVER a key, a route segment or
 * a URL. That job belongs to the address. Sanitising is what makes the string
 * safe to LOOK at, not safe to identify by.
 */
export function sanitiseForDisplay(s: string): string {
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
}
