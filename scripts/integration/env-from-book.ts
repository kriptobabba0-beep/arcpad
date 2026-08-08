/**
 * Integration harness: produce the indexer's env FROM THE ADDRESS BOOK, and
 * from nothing else.
 *
 * WHY THIS FILE EXISTS. `indexer/src/config.ts` reads `ARC_FACTORY_ADDRESS`
 * and `ARC_START_BLOCK` out of the environment and never opens the book. The
 * keeper and web both take the book as SOURCE (`loadWatcherConfig`,
 * `web/lib/preflight.ts`); the indexer is the layer where the book has to be
 * carried in by whoever starts the process. So "does the indexer follow the
 * address book" is only answerable if the env it is given is DERIVED from the
 * book rather than typed -- which is what this prints.
 *
 * Both directions are exercised on purpose: `webEnvBlock` GENERATES and
 * `assertEnvMatchesBook` AUDITS, and the two are supposed to derive from one
 * table (`WEB_ENV_BINDINGS`). Generating a block that the auditor then
 * rejects would be a real finding, so the generated block is fed straight
 * back into the auditor here.
 *
 * usage: npx tsx scripts/integration/env-from-book.ts [chainId]
 */
// RELATIVE IMPORT, for the same reason `migrate.ts` uses one: the root
// workspace package does not declare `@arcpad/shared`, and module resolution
// happens from THIS file's directory, not from the cwd the harness is run in.
import {
  ARC_TESTNET_CHAIN_ID,
  assertEnvMatchesBook,
  loadAddressBook,
  webEnvBlock,
} from '../../packages/shared/src/index'

// The default comes from the REGISTRY, never a literal: `chain-registry.test.ts`
// asserts that no tracked source outside `chain.ts` carries the chain id, and a
// hardcoded 5042002 here turned that suite red while this harness's own scoped
// run stayed green.
const chainId = Number(process.argv[2] ?? ARC_TESTNET_CHAIN_ID)
const book = loadAddressBook(chainId)
const block = webEnvBlock(book)

// Round-trip: parse what we just generated and hand it to the auditor.
const parsed: Record<string, string> = {}
for (const line of block.split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1)
}
assertEnvMatchesBook(parsed, book)

console.log(block.trimEnd())
console.error(
  `[env-from-book] chain=${book.chainId} factory=${book.launchFactory} ` +
    `escrow=${book.feeEscrow} startBlock=${book.startBlock} ` +
    `(generator and auditor agree on ${Object.keys(parsed).length} variables)`,
)
