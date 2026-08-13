import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ============================================================================
 *  NOTHING A BROWSER LOADS MAY REACH `node:fs`
 * ============================================================================
 *
 * THE BUILD THAT CAUGHT THIS, and it caught it only in production:
 *
 *   the chunking context (unknown) does not support external modules
 *   (request: node:fs/promises)
 *   Import traces: ./web/components/create/LaunchForm.tsx
 *
 * `components/create/fields.ts` imported ONE NUMBER -- `DESCRIPTION_LIMIT` --
 * from `lib/metadata.ts`. The day `lib/metadata.ts` gained a disk cache, that
 * number dragged `node:fs/promises` into the browser bundle and `next build`
 * stopped. Every test stayed green: vitest runs in Node, where `node:fs`
 * resolves perfectly well. The only signal was a failed release.
 *
 * `import 'server-only'` is the documented guard and it does NOT work here:
 * the package throws unless the bundler sets the `react-server` condition,
 * which vitest does not, so it turns three green suites red for the wrong
 * reason. This test is the same guarantee expressed in a way this repo's
 * toolchain can actually run -- and it fails with the IMPORT CHAIN, which is
 * the one thing the Turbopack error did not print in a usable form.
 *
 * It walks from every `'use client'` module the way a bundler does, and it
 * reports the path it took to reach the forbidden import.
 */

const WEB = dirname(fileURLToPath(new URL('.', import.meta.url)))

const FORBIDDEN = /^node:(fs|crypto|child_process|net|dns|tls|worker_threads)(\/|$)/

/** Source roots a client component can legitimately import from. */
const ROOTS = ['app', 'components', 'hooks', 'lib']

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full)
    }
  }
  for (const root of ROOTS) walk(join(WEB, root))
  return out
}

/** `@/x`, `./x`, `../x` -> an absolute file path, or null for a package. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = join(WEB, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
  else return null // a package: its own business, and bundlers treat it so

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // keep trying
    }
  }
  return null
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g

function importsOf(file: string): { specifiers: string[]; source: string } {
  const source = readFileSync(file, 'utf8')
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT)) specifiers.push(match[1] as string)
  // `import 'x'` with no bindings, which is how side-effect modules arrive.
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    specifiers.push(match[1] as string)
  }
  return { specifiers, source }
}

/** The chain from `entry` to a forbidden import, or null. */
function pathToForbidden(entry: string): string[] | null {
  const seen = new Set<string>()
  const stack: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }]

  while (stack.length > 0) {
    const { file, chain } = stack.pop() as { file: string; chain: string[] }
    if (seen.has(file)) continue
    seen.add(file)

    const { specifiers } = importsOf(file)
    for (const specifier of specifiers) {
      if (FORBIDDEN.test(specifier)) return [...chain, specifier]
      const next = resolveImport(file, specifier)
      if (next !== null) stack.push({ file: next, chain: [...chain, next] })
    }
  }
  return null
}

describe('the client bundle', () => {
  const clientEntries = sourceFiles().filter((file) => {
    const head = readFileSync(file, 'utf8').slice(0, 200)
    return /^\s*(['"])use client\1/m.test(head)
  })

  it('has entries to check at all (anti-vacuum)', () => {
    // Without this, a broken detector would pass by finding nothing to test.
    expect(
      clientEntries.length,
      "no 'use client' modules found -- the scan is wrong",
    ).toBeGreaterThan(3)
  })

  it('no client module reaches a node builtin, however indirectly', () => {
    const offenders = clientEntries
      .map((entry) => ({ entry, chain: pathToForbidden(entry) }))
      .filter((r) => r.chain !== null)
      .map((r) =>
        (r.chain as string[])
          .map((p) => p.replace(WEB, '').split('\\').join('/'))
          .join('\n    -> '),
      )

    // The message IS the value: Turbopack says "chunking context ... does not
    // support external modules" and names one file. This names the road.
    expect(
      offenders,
      `a browser bundle cannot contain these:\n\n  ${offenders.join('\n\n  ')}\n`,
    ).toEqual([])
  })
})
