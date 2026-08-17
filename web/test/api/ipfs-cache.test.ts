import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheDir, inFlightSize, once, readCached, writeCached } from '../../lib/ipfsCache'

/**
 * =========================================================================
 *  THE CACHE EXISTS BECAUSE THE GATEWAY MEASURED BADLY.
 * =========================================================================
 *
 * Six sequential requests for one small PNG through the public gateway, on
 * the live server: three answered in 3.5-5.6 s, three failed after 12-24 s.
 * The explore page draws 48 cards. Without a cache that is 48 requests per
 * visitor against a gateway that already refuses half of six — and the
 * failure mode is artwork that flickers in and out for everybody.
 *
 * The tests below are about the two properties that make that go away, plus
 * the one rule the whole module is written around: NOTHING HERE MAY THROW.
 * A cache that takes a page down when the disk is full is worse than none.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])
const CID = 'QmWcPGQPKBe9iHBh8HqjZX729JBc4CSBKJSbJ7fpWWf5WB'

describe('the disk cache', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arcpad-ipfs-'))
    vi.stubEnv('ARCPAD_IPFS_CACHE_DIR', dir)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  })

  it('a CID written once is read back with its type', async () => {
    await writeCached(CID, { bytes: PNG, type: 'image/png' })
    const found = await readCached(CID)
    expect(found?.type).toBe('image/png')
    expect(found?.bytes).toEqual(PNG)
  })

  it('a miss is null, not an error', async () => {
    await expect(readCached('QmNeverSeenBefore')).resolves.toBeNull()
  })

  it('never writes a partial file: the temporary name is gone after a write', async () => {
    // A crash mid-write would otherwise leave a truncated image behind a
    // valid-looking cache entry — a permanently broken picture.
    await writeCached(CID, { bytes: PNG, type: 'image/png' })
    const entries = await readdir(dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toContain('.tmp')
  })

  it('stores a flat, hashed name — a path with slashes never becomes directories', async () => {
    await writeCached(`${CID}/deep/logo.png`, { bytes: PNG, type: 'image/png' })
    const entries = await readdir(dir, { withFileTypes: true })
    expect(entries.every((entry) => entry.isFile())).toBe(true)
    expect(entries[0]?.name).toMatch(/^[0-9a-f]{64}\.png$/)
  })

  it('two different paths do not collide', async () => {
    await writeCached(`${CID}/a.png`, { bytes: PNG, type: 'image/png' })
    await writeCached(`${CID}/b.png`, { bytes: new Uint8Array([...PNG, 7]), type: 'image/png' })
    expect(await readdir(dir)).toHaveLength(2)
    expect((await readCached(`${CID}/a.png`))?.bytes).toEqual(PNG)
  })

  it('refuses to store a type we would never serve', async () => {
    // The type is the file extension, so an unknown type has nowhere to go.
    // This is the last place a `text/html` could sneak into the cache.
    await writeCached(CID, { bytes: PNG, type: 'text/html' })
    expect(await readdir(dir)).toHaveLength(0)
    expect(await readCached(CID)).toBeNull()
  })

  it('an unwritable directory costs speed, not correctness', async () => {
    // A file where the directory should be: `mkdir` fails for every write.
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'not a directory')
    vi.stubEnv('ARCPAD_IPFS_CACHE_DIR', join(blocked, 'ipfs'))

    await expect(writeCached(CID, { bytes: PNG, type: 'image/png' })).resolves.toBeUndefined()
    await expect(readCached(CID)).resolves.toBeNull()
  })

  it('with no directory configured the cache is simply off', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('ARCPAD_IPFS_CACHE_DIR', '')
    vi.stubEnv('CACHE_DIRECTORY', '')
    expect(cacheDir()).toBeNull()
    await expect(writeCached(CID, { bytes: PNG, type: 'image/png' })).resolves.toBeUndefined()
    await expect(readCached(CID)).resolves.toBeNull()
  })

  it('systemd CacheDirectory is used when nothing else is set', () => {
    vi.unstubAllEnvs()
    vi.stubEnv('CACHE_DIRECTORY', '/var/cache/arcpad')
    expect(cacheDir()).toBe(join('/var/cache/arcpad', 'ipfs'))
  })
})

describe('single flight', () => {
  it('48 cards asking at once make ONE upstream attempt', async () => {
    // This is the stampede that fills the cache, and it is also the burst
    // that gets a public gateway to start refusing us.
    let calls = 0
    const work = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { bytes: PNG, type: 'image/png' }
    }

    const all = await Promise.all(Array.from({ length: 48 }, () => once(CID, work)))

    expect(calls).toBe(1)
    expect(all.every((image) => image?.bytes === PNG)).toBe(true)
  })

  it('different CIDs do not share an attempt', async () => {
    let calls = 0
    const work = async () => {
      calls += 1
      return { bytes: PNG, type: 'image/png' }
    }
    await Promise.all([once('QmA', work), once('QmB', work)])
    expect(calls).toBe(2)
  })

  it('releases the key when the work settles — including when it fails', async () => {
    // A de-duplicator, NOT a second cache. Holding resolved promises would
    // keep every image ever served in memory and cache failures forever.
    await once(CID, async () => ({ bytes: PNG, type: 'image/png' }))
    expect(inFlightSize()).toBe(0)

    await expect(
      once(CID, async () => {
        throw new Error('gateway exploded')
      }),
    ).rejects.toThrow('gateway exploded')
    expect(inFlightSize()).toBe(0)

    // And the next caller gets a fresh attempt rather than the old failure.
    await expect(once(CID, async () => ({ bytes: PNG, type: 'image/png' }))).resolves.toEqual({
      bytes: PNG,
      type: 'image/png',
    })
  })
})
