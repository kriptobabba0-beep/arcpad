import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `browser.ts` exists so that a `'use client'` file can import from this
 * package without dragging `node:fs` into the browser chunk. That is a claim
 * about a whole import CLOSURE, not about one file, so it is walked.
 *
 * Turbopack's diagnostic for the failure this prevents is
 * "the chunking context (unknown) does not support external modules
 * (request: node:fs)" -- a build-time error with no local reproduction short
 * of a full `next build`, which takes minutes. This takes milliseconds.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'url',
  'util',
  'worker_threads',
  'zlib',
])

function isNodeSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return NODE_BUILTINS.has(specifier)
}

/** Static `import`/`export ... from '<specifier>'` specifiers, in source order. */
function specifiersOf(source: string): string[] {
  const found: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match !== null) {
    found.push(match[1] as string)
    match = pattern.exec(source)
  }
  // Bare side-effect imports: `import 'x'`.
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  let bareMatch = bare.exec(source)
  while (bareMatch !== null) {
    found.push(bareMatch[1] as string)
    bareMatch = bare.exec(source)
  }
  return found
}

/** Walks the relative-import closure and returns every specifier seen. */
function closureOf(entry: string): { modules: string[]; external: string[] } {
  const seen = new Set<string>()
  const external = new Set<string>()
  const queue = [resolve(SRC, entry)]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), `${specifier}.ts`))
      } else {
        external.add(specifier)
      }
    }
  }
  return { modules: [...seen], external: [...external] }
}

describe('the browser entry point', () => {
  it('reaches no Node builtin, anywhere in its import closure', () => {
    const { modules, external } = closureOf('browser.ts')
    // Anti-vacuity: if the walker silently found nothing, the assertion below
    // would be trivially true.
    expect(modules.length).toBeGreaterThanOrEqual(4)
    const nodeImports = external.filter(isNodeSpecifier)
    expect(nodeImports, `browser.ts closure: ${modules.join(', ')}`).toEqual([])
  })

  // The control: the MAIN barrel does reach node:fs. Without this, the test
  // above would pass just as happily against a walker that cannot see imports
  // at all.
  it('CONTROL: the main barrel does reach node:fs, and the walker sees it', () => {
    const { external } = closureOf('index.ts')
    expect(external.filter(isNodeSpecifier).sort()).toContain('node:fs')
  })

  it('the browser entry depends on viem and nothing else external', () => {
    const { external } = closureOf('browser.ts')
    expect(external.sort()).toEqual(['viem'])
  })
})
