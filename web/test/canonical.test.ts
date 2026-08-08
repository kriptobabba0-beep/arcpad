import { launchFactoryAbi } from '@arcpad/shared/browser'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters, hexToBytes, keccak256, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { mayRenderAsLaunch, VERIFY_GAS_CAP } from '../lib/canonical'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * CANONICITY COMES FROM THE HEX, NEVER FROM THE DISPLAY TEXT.
 *
 * The indexer measured this and it is the reason `launches.name_hex` exists.
 * These cases re-derive the mechanism from first principles so that nobody
 * later adds a `deriveTokenAddress(name: string)` helper to `web/lib/`.
 */
describe('a decoded string cannot stand in for the launch bytes', () => {
  const NAME_HEX = '0x41ff42'

  it('MEASURED: 0x41ff42 does not survive a decode/re-encode round trip', () => {
    const bytes = hexToBytes(NAME_HEX)
    expect(bytes.length).toBe(3)

    // `0xff` is not valid UTF-8. Decoding substitutes U+FFFD, and re-encoding
    // that replacement character costs THREE bytes -- so 3 bytes become 5.
    const decoded = new TextDecoder('utf-8').decode(bytes)
    const reencoded = stringToHex(decoded)
    expect(reencoded).toBe('0x41efbfbd42')
    expect(reencoded).not.toBe(NAME_HEX)
    expect(hexToBytes(reencoded).length).toBe(5)
  })

  it('...so the SALT differs, and therefore so does the address', () => {
    // The salt is `keccak256(abi.encode(sender, name, symbol, uri, count))`
    // over the raw bytes. Two different byte strings hash to two different
    // salts, and CREATE2 is `address = f(deployer, salt, initcodeHash)` -- so
    // a different salt is a different address, necessarily.
    const fromBytes = keccak256(encodeAbiParameters([{ type: 'bytes' }], [NAME_HEX]))
    const fromString = keccak256(encodeAbiParameters([{ type: 'bytes' }], ['0x41efbfbd42']))
    expect(fromBytes).toBe('0x9bb72f6648e2a6e69467e2272604b24fd7301f38430ba47ce3e8ce9535ae1461')
    expect(fromString).toBe('0x538a2d9368bacd86f13e5e76838670cbe897797c81f21575bcfbb96e87b8c871')
    expect(fromBytes).not.toBe(fromString)
  })

  it('the trap is REACHABLE: the chain accepts this name', () => {
    // `LaunchToken` checks byte LENGTH only, and Solidity never validates
    // UTF-8. Three bytes is comfortably inside the 32-byte name limit, so this
    // launch is perfectly legal on chain -- which is what makes the mismatch a
    // reachable `NonCanonicalLaunch` halt rather than a hypothetical.
    expect(hexToBytes(NAME_HEX).length).toBeLessThanOrEqual(32)
  })

  it('web/lib exposes NO derivation helper that takes display text', () => {
    // The structural half. A helper taking `name: string` cannot be correct,
    // so the rule is that one does not exist here at all.
    const source = readFileSync(join(REPO_ROOT, 'web/lib/canonical.ts'), 'utf8')
    expect(source).not.toMatch(/function\s+deriveTokenAddress/)
    expect(source).toMatch(/nameHex/) // ...and it says why, by name
  })
})

describe('verifyCanonical is fail-closed', () => {
  it('only `canonical` may be rendered as a launch', () => {
    expect(mayRenderAsLaunch('canonical')).toBe(true)
    // Both of the others go to the same screen. A failure to verify and a
    // proven forgery are equally unsafe to draw.
    expect(mayRenderAsLaunch('forged')).toBe(false)
    expect(mayRenderAsLaunch('unverifiable')).toBe(false)
  })

  /**
   * THE GAS CEILING IS NOT DECORATION.
   *
   * The token being verified is hostile and returns its own fields, so a
   * megabyte-long `name()` makes the call arbitrarily expensive. Faz 1c
   * measured 2,958,151 of a 3,000,000 budget consumed on a direct call and
   * 7,757,318 of 8,000,000 inside a `try/catch` caller: the wrapper hands back
   * CONTROL, never GAS.
   */
  it('BOTH the try/catch and an explicit gas cap are present', () => {
    const source = readFileSync(join(REPO_ROOT, 'web/lib/canonical.ts'), 'utf8')
    expect(VERIFY_GAS_CAP).toBe(2_000_000n)
    expect(source).toMatch(/gas: VERIFY_GAS_CAP/)
    expect(source).toMatch(/} catch \{/)
    // `readContract` CANNOT carry a gas ceiling -- its parameter type has no
    // `gas` field -- so the call must go through `client.call`. If this ever
    // reverts to `readContract`, the ceiling silently disappears.
    expect(source).toMatch(/client\.call\(/)
    expect(source).not.toMatch(/client\.readContract\(/)
  })

  it('the factory address is read from the address book, never inlined', () => {
    // Phase 2 redeploys `LaunchFactory` (its constructor gains `feeSchedule`),
    // so today's address is superseded. A literal here would keep asking a
    // factory that no longer launches anything, and it would answer `forged`
    // for every real launch.
    const source = readFileSync(join(REPO_ROOT, 'web/lib/canonical.ts'), 'utf8')
    expect(source).toMatch(/config\.addresses\.launchFactory/)
    // No 20-byte hex literal anywhere in the module.
    expect(source).not.toMatch(/0x[0-9a-fA-F]{40}/)
  })

  /**
   * ============ THE SAME DISCIPLINE, ACROSS THE WHOLE APP ============
   *
   * The test above covers ONE FILE. That is this repository's standing failure
   * mode stated exactly -- "a property covered on one entrypoint reads as
   * covered on all of them" -- and Task 7 is the moment it would cost
   * something: the new `LaunchFactory` supersedes
   * `0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439`, and any second copy of that
   * address outlives the address book.
   *
   * Measured when this was written: zero 20-byte literals in `web/lib`,
   * `web/app` and `web/components` other than the two allowed below. So this
   * gate is not closing a hole -- it is keeping a hole shut that is currently
   * closed by nothing but habit.
   *
   * THE TWO ALLOWANCES ARE NAMED, NOT PATTERN-MATCHED. A blanket "ignore
   * addresses that look like constants" would let the next factory literal
   * through if it happened to be written in a comment.
   */
  it('NO deployment address is inlined anywhere in the app, not just in one file', () => {
    // The zero address is a SENTINEL, not a deployment: it names "nobody",
    // and it cannot be superseded by a redeploy.
    const ZERO = '0x0000000000000000000000000000000000000000'
    // Arc's USDC predeploy is a CHAIN CONSTANT, fixed by the L1 itself, and it
    // appears here only inside prose explaining the two-view balance. The
    // value that code reads lives in `packages/shared` (`USDC_ERC20_ADDRESS`).
    const USDC_PREDEPLOY = '0x3600000000000000000000000000000000000000'
    const ALLOWED = new Set([ZERO.toLowerCase(), USDC_PREDEPLOY.toLowerCase()])

    const roots = ['web/lib', 'web/app', 'web/components']
    const offenders: string[] = []
    let scanned = 0
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          walk(rel)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        scanned += 1
        const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
        for (const m of text.matchAll(/0x[0-9a-fA-F]{40}/g)) {
          if (!ALLOWED.has(m[0].toLowerCase())) offenders.push(`${rel}: ${m[0]}`)
        }
      }
    }
    for (const root of roots) walk(root)

    // The gate's INPUT must not be empty -- a walker that silently found no
    // files would pass forever. This repository has shipped exactly that
    // (a restore check that examined zero files, three times).
    expect(scanned).toBeGreaterThan(50)
    expect(offenders).toEqual([])
  })

  it('isCanonical is in the distributed ABI with the shape this depends on', () => {
    const entry = launchFactoryAbi.find((e) => e.type === 'function' && e.name === 'isCanonical')
    expect(entry).toMatchObject({
      stateMutability: 'view',
      inputs: [{ type: 'address' }],
      outputs: [{ type: 'bool' }],
    })
  })
})
