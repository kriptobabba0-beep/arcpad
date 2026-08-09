import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..')

/**
 * THE CURVE PANEL'S BUTTON ORDER, READ OUT OF ITS SOURCE.
 *
 * The pool panel has its own ladder, and the two must not diverge: a user who
 * learned "connect, then amount, then approve, then buy" on the curve must meet
 * the same sequence on the pool. Asserting that against a hand-copied list
 * would only prove the copy matches itself, so the curve's order is EXTRACTED
 * from `tradeModel.ts` -- reordering `buttonFor`'s branches turns the pool's
 * test red, which is the whole point.
 *
 * Duplicates are collapsed to their FIRST appearance because `busy` is returned
 * from two rungs (phase, and an unknown allowance) and a raw list would make
 * the sequence unreadable.
 */
function curveButtonOrder(): readonly string[] {
  const source = readFileSync(join(WEB, 'components', 'token', 'tradeModel.ts'), 'utf8')
  const start = source.indexOf('export function buttonFor')
  if (start === -1) throw new Error('buttonFor not found in tradeModel.ts -- the gate cannot run')
  const body = source.slice(start)
  const seen: string[] = []
  for (const match of body.matchAll(/intent:\s*'([a-zA-Z]+)'/g)) {
    const intent = match[1] as string
    if (!seen.includes(intent)) seen.push(intent)
  }
  if (seen.length < 8) {
    throw new Error(`buttonFor yielded only ${seen.length} intents -- the extraction is broken`)
  }
  return seen
}

export const CURVE_BUTTON_ORDER = curveButtonOrder()

/**
 * `blocked` IS THE ONE RUNG THAT MOVES, AND THE MOVE IS EXPLAINED.
 *
 * On the curve, `blocked` means "the simulation reverted", and it sits between
 * `approve` and `ready`. The pool has no separate simulation step: the QUOTE is
 * the simulation, it runs before a plan can exist, and its failure surfaces as
 * `planError`. So `blocked` is free, and the pool reuses it for the one state
 * the curve never has -- no router configured -- which outranks everything,
 * because connecting a wallet cannot conjure an entrypoint.
 */
export const BUTTON_ORDER_SOURCE = CURVE_BUTTON_ORDER.filter((intent) => intent !== 'blocked')
