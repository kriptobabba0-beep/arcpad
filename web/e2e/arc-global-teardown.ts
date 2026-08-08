import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { FullConfig } from '@playwright/test'
import { type ArcE2EState, arcStatePath } from './arc-global-setup'
import { killTree } from './fixtures/server'
import { webRoot } from './state'

/**
 * KILLS THE ARC SERVER BY PID FROM ITS OWN STATE FILE.
 *
 * A SEPARATE FILE FROM `e2e/.state.json`, deliberately. The devchain harness
 * writes that one, and a teardown that read a state file written by a DIFFERENT
 * run would either kill a process it does not own or -- far likelier on a
 * machine where both have run -- read a stale pid that now belongs to something
 * else entirely.
 *
 * THE PID IS ON DISK BEFORE THE SERVER IS USED, because the failure that matters
 * is not "teardown missed one", it is "setup threw half way and teardown was
 * never called at all". This user's machine has overheated twice on this project
 * from exactly that. `killTree` is a tree kill: `next start` spawns a child, and
 * `child.kill()` on Windows reaps the parent and orphans the listener.
 */
export default async function arcGlobalTeardown(config: FullConfig): Promise<void> {
  const path = arcStatePath(webRoot(config))
  if (!existsSync(path)) return
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as Partial<ArcE2EState>
    // An externally supplied app is somebody else's process. Killing it would be
    // the harness reaching outside everything it owns.
    if (state.external !== true && typeof state.serverPid === 'number') {
      await killTree(state.serverPid)
    }
  } catch (error) {
    console.error('reading the Arc e2e state file failed', error)
  }
  try {
    rmSync(path)
  } catch {
    /* nothing to clean */
  }
}
