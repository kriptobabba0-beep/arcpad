import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { FullConfig } from '@playwright/test'
import { killTree } from './fixtures/server'
import { type E2EState, statePath, webRoot } from './state'

/**
 * KILLS BY PID FROM THE STATE FILE, NOT BY CLOSURE.
 *
 * Playwright runs setup and teardown in the same process, so the closure path
 * usually works -- and "usually" is the whole problem. A setup that threw
 * between starting the server and returning leaves a closure nobody holds; the
 * pid on disk is still there. Both paths run, and neither is allowed to throw:
 * a teardown that fails half way leaves the other half alive.
 */
export default async function globalTeardown(config: FullConfig): Promise<void> {
  const STATE_PATH = statePath(webRoot(config))
  try {
    await globalThis.__arcpadStopChain?.()
  } catch (error) {
    console.error('stopping the devchain failed; the pid sweep below still runs', error)
  }

  if (existsSync(STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<E2EState>
      // EACH PID IS KILLED INDEPENDENTLY. A single `await` chain would stop at
      // the first failure and leave the second server running -- the exact
      // shape that left processes alive for hours on a previous round.
      for (const pid of [state.serverPid, state.dbServerPid]) {
        if (typeof pid !== 'number') continue
        try {
          await killTree(pid)
        } catch (error) {
          console.error(`killing pid ${pid} failed; the remaining pids still get their turn`, error)
        }
      }
    } catch (error) {
      console.error('reading the e2e state file failed', error)
    }
    try {
      rmSync(STATE_PATH)
    } catch {
      /* nothing to clean */
    }
  }
}
