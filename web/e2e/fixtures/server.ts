import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * A BUILT NEXT SERVER, NOT `next dev`.
 *
 * `next dev` compiles per request, serves an un-minified bundle, and skips
 * the production-only work the user actually receives: route-group resolution,
 * the app-build manifest the budget gate reads, and the streaming behaviour
 * that hid a 404-answering-200 in this very phase. Testing the dev server
 * would test something no visitor ever loads.
 *
 * PROCESS OWNERSHIP IS EXPLICIT AND THE KILL IS A TREE KILL. `next start`
 * spawns a child of its own; `child.kill()` on Windows reaps the parent and
 * ORPHANS the listener, which is how a previous round of this project left two
 * chains and six database processes running for hours. Every start here has
 * exactly one owner and that owner kills the whole tree.
 */

/**
 * Next's own CLI entry point, run under THIS Node, not through `npx`.
 *
 * `spawn('npx.cmd', ...)` fails with `EINVAL` on Node 24 for Windows: batch
 * files need `shell: true`, and `shell: true` on Windows concatenates
 * arguments instead of escaping them (node DEP0190). Resolving the JS entry
 * point and running `process.execPath` sidesteps both, and it also guarantees
 * the build and the tests run on the same runtime.
 */
function nextBin(cwd: string): string {
  const require = createRequire(pathToFileURL(join(cwd, 'noop.cjs')).href)
  return require.resolve('next/dist/bin/next')
}

export type WebServer = {
  readonly url: string
  readonly port: number
  readonly pid: number | undefined
  stop(): Promise<void>
}

/** An ephemeral port, asked of the OS rather than guessed. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('the OS did not report a port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      resolve()
      return
    }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.once('exit', () => resolve())
    killer.once('error', () => resolve())
  })
}

async function waitForHttp(url: string, timeoutMs: number, log: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      // ANY status is a listening server. Asserting 200 here would make a
      // legitimately-404 landing page look like a boot failure.
      if (response.status > 0) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${url} never answered within ${timeoutMs}ms (${lastError}).\n${log()}`)
}

export type ServerOptions = {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly port?: number
}

export async function runNextBuild(options: ServerOptions): Promise<void> {
  const output: string[] = []
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin(options.cwd), 'build'], {
      cwd: options.cwd,
      // `next build` inlines NEXT_PUBLIC_* TEXTUALLY at build time. The
      // addresses below belong to an anvil that did not exist a minute ago,
      // so they cannot come from a committed file.
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (c: Buffer) => output.push(c.toString()))
    child.stderr?.on('data', (c: Buffer) => output.push(c.toString()))
    child.once('error', reject)
    child.once('exit', (exitCode) => resolve(exitCode ?? 1))
  })
  if (code !== 0) throw new Error(`next build failed (${code}):\n${output.join('')}`)
}

export async function startWebServer(options: ServerOptions): Promise<WebServer> {
  const port = options.port ?? (await freePort())
  const url = `http://127.0.0.1:${port}`
  const output: string[] = []
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin(options.cwd), 'start', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? {} : { detached: true }),
    },
  )
  child.stdout?.on('data', (c: Buffer) => output.push(c.toString()))
  child.stderr?.on('data', (c: Buffer) => output.push(c.toString()))

  const stop = async (): Promise<void> => {
    if (child.pid !== undefined) await killTree(child.pid)
  }

  try {
    await waitForHttp(url, 90_000, () => output.join(''))
  } catch (error) {
    await stop()
    throw error
  }
  return { url, port, pid: child.pid, stop }
}
