/**
 * ============================================================================
 *  A CONSTANT A BROWSER NEEDS MUST NOT LIVE BESIDE `node:fs`
 * ============================================================================
 *
 * This is one number, and it is here rather than in `lib/metadata.ts` because
 * of a build failure worth remembering:
 *
 *   the chunking context (unknown) does not support external modules
 *   (request: node:fs/promises)
 *   Import traces: ./web/components/create/LaunchForm.tsx
 *
 * `components/create/fields.ts` -- reachable from a `'use client'` component
 * -- imported `DESCRIPTION_LIMIT` from `lib/metadata.ts`. The day
 * `lib/metadata.ts` gained a disk cache, that single number dragged
 * `node:fs/promises` into the BROWSER bundle and the production build stopped.
 * The tests did not: vitest runs in Node, where `node:fs` resolves fine.
 *
 * The rule this file exists to hold: a value the client needs lives in a
 * module the client can safely have ALL of. `lib/ipfsCache.ts` carries
 * `import 'server-only'` for the other half of the same rule -- so the next
 * time somebody reaches across this line, the error names the cause instead
 * of describing a chunk.
 */

/**
 * How much of a token's description we keep, in characters.
 *
 * NOT one of `METADATA_LIMITS`: those are the on-chain BYTE caps that
 * `LaunchFactory.launch` enforces on name, symbol and uri. A description
 * never goes on chain -- it lives in the metadata JSON -- so this is a
 * display decision, and conflating the two would put an off-chain preference
 * where a consensus rule belongs.
 */
export const DESCRIPTION_LIMIT = 256
