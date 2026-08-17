import { describe, expect, it } from 'vitest'

import { BACKUP_TABLES, backupFileName, backupTakenAt, expiredBackups } from '../src/backup'

const NAME = (iso: string): string => backupFileName(new Date(iso))

describe('backupFileName', () => {
  it('UTC, sortable as text', () => {
    expect(NAME('2026-08-10T17:44:30Z')).toBe('arcpad-chat-20260810T174430Z.sql.gz')
  })

  it('pads every field -- an unpadded month breaks text sorting in September', () => {
    expect(NAME('2026-01-02T03:04:05Z')).toBe('arcpad-chat-20260102T030405Z.sql.gz')
  })

  it('IGNORES the local zone, so the autumn repeated hour cannot collide', () => {
    // Two instants an hour apart. Under a local-time name in a zone that falls
    // back, both would render the same and the second would overwrite the
    // first -- silently, and only once a year.
    const a = NAME('2026-10-25T00:30:00Z')
    const b = NAME('2026-10-25T01:30:00Z')
    expect(a).not.toBe(b)
  })

  it('round-trips through backupTakenAt', () => {
    const at = new Date('2026-08-10T17:44:30Z')
    expect(backupTakenAt(backupFileName(at))?.toISOString()).toBe(at.toISOString())
  })
})

describe('backupTakenAt refuses anything that is not ours', () => {
  it.each([
    ['a foreign dump', 'pg_dumpall.sql.gz'],
    ['our prefix, wrong shape', 'arcpad-chat-2026-08-10.sql.gz'],
    ['uncompressed', 'arcpad-chat-20260810T174430Z.sql'],
    ['a directory-ish name', 'arcpad-chat-20260810T174430Z.sql.gz.part'],
    ['a day that does not exist', 'arcpad-chat-20260231T000000Z.sql.gz'],
    ['a leap day in a common year', 'arcpad-chat-20260229T000000Z.sql.gz'],
    ['month 13', 'arcpad-chat-20261301T000000Z.sql.gz'],
    ['an hour that does not exist', 'arcpad-chat-20260810T994430Z.sql.gz'],
    ['a minute that does not exist', 'arcpad-chat-20260810T179930Z.sql.gz'],
  ])('%s -> null', (_label, name) => {
    expect(backupTakenAt(name)).toBeNull()
  })

  /*
   * The rolled-over dates above are the reason `backupTakenAt` re-renders
   * instead of testing `Number.isNaN`. JavaScript accepts 31 February and
   * hands back 3 March, so a `NaN` guard alone would give that file a
   * plausible age -- three days newer than it claims -- and let it take part
   * in retention. This asserts the underlying behaviour directly, so the test
   * still means something if someone "simplifies" the implementation.
   */
  it('JS itself rolls 31 February forward -- the reason the round trip exists', () => {
    const rolled = new Date('2026-02-31T00:00:00Z')
    expect(Number.isNaN(rolled.getTime())).toBe(false)
    expect(rolled.toISOString()).toBe('2026-03-03T00:00:00.000Z')
  })

  it('a real leap day IS ours', () => {
    expect(backupTakenAt('arcpad-chat-20280229T000000Z.sql.gz')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    )
  })
})

describe('expiredBackups', () => {
  const now = new Date('2026-08-10T12:00:00Z')
  const day = (n: number): string => NAME(new Date(now.getTime() - n * 86_400_000).toISOString())

  it('deletes what is past the window', () => {
    const files = [day(0), day(3), day(20), day(40)]
    expect(expiredBackups(files, now, 14)).toEqual([day(20), day(40)])
  })

  it('keeps everything inside the window', () => {
    const files = [day(0), day(3), day(13)]
    expect(expiredBackups(files, now, 14)).toEqual([])
  })

  /*
   * THE RULE THAT EXISTS BECAUSE THE OBVIOUS ONE IS DANGEROUS.
   *
   * A stalled backup job is invisible -- nothing pages, the files just stop
   * arriving. Retention written as "delete everything past the window" then
   * spends the next fortnight deleting the evidence, and empties the directory
   * at exactly the moment those files became the only copy of the one table no
   * chain can rebuild. Stale must degrade to stale, never to nothing.
   */
  it('NEVER deletes the last one, however old it is', () => {
    expect(expiredBackups([day(400)], now, 14)).toEqual([])
  })

  it('with every file expired, keeps the newest and drops the rest', () => {
    const files = [day(100), day(200), day(300)]
    expect(expiredBackups(files, now, 14)).toEqual([day(200), day(300)])
  })

  it('the survivor is the NEWEST, not the first in the list', () => {
    // Input deliberately unsorted: a implementation that kept `files[0]`
    // would keep the oldest and pass every test above.
    expect(expiredBackups([day(300), day(100), day(200)], now, 14)).toEqual([day(200), day(300)])
  })

  it('leaves foreign files alone, even ancient ones', () => {
    const files = [day(0), day(90), 'pg_dumpall.sql.gz', 'notes.txt']
    expect(expiredBackups(files, now, 14)).toEqual([day(90)])
  })

  it('an empty directory is not an error', () => {
    expect(expiredBackups([], now, 14)).toEqual([])
    expect(expiredBackups(['notes.txt'], now, 14)).toEqual([])
  })

  it('keepDays=0 still keeps the newest', () => {
    const files = [day(0), day(1)]
    expect(expiredBackups(files, now, 0)).toEqual([day(1)])
  })

  it('a negative window is a programming error, not a policy', () => {
    expect(() => expiredBackups([day(0)], now, -1)).toThrow(RangeError)
  })
})

describe('BACKUP_TABLES', () => {
  it('is exactly the tables no chain can rebuild', () => {
    expect(BACKUP_TABLES).toEqual(['chat_messages'])
  })

  it('is frozen -- the policy is not a mutable global', () => {
    expect(Object.isFrozen(BACKUP_TABLES)).toBe(true)
  })
})
