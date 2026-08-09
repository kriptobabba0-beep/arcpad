/**
 * THE ADDRESS BOOK'S SMOKE PAIR, PRINTED AS JSON FOR THE ARC HARNESS.
 *
 * RUN AS A CHILD PROCESS UNDER `tsx`, NEVER IMPORTED BY PLAYWRIGHT. That is not
 * a style choice, it is forced. Playwright transpiles the files it loads to
 * CommonJS (this package has no `"type": "module"` -- see `e2e/state.ts`), and
 * `@arcpad/shared`'s address-book loader reaches
 * `packages/shared/src/profiles.ts`, whose `REPO_ROOT` is
 * `dirname(fileURLToPath(import.meta.url))`. `import.meta` is a SYNTAX ERROR in
 * CommonJS, so a direct import of the loader from the harness cannot work at
 * all. The same wall is recorded in `packages/shared/src/devchain.ts`, which had
 * to stop using `import.meta` for exactly this reason.
 *
 * WHY NOT READ THE JSON FILE DIRECTLY. `addresses.<chainId>.json` is generated,
 * and `loadAddressBook` is the thing that re-derives every address from its
 * initcode hash and refuses a book that does not agree with itself. Reading the
 * file with `JSON.parse` would take the addresses while skipping the only check
 * that says they are the right ones -- the failure mode this repository keeps
 * finding (a value transcribed from the wrong place, self-consistently).
 *
 * WHY NOT `pnpm addressbook --env-only`. That is exactly where the harness gets
 * `NEXT_PUBLIC_*` from, and it is the right source for them. But its env block
 * does not carry `smokeToken` / `smokeCurve` -- the launched pair the Arc leg
 * needs a token page for -- and `scripts/` belongs to another track, so it
 * cannot grow a flag for this. This reads the same book through the same loader.
 */
import { loadAddressBook } from '@arcpad/shared'

const chainId = Number(process.argv[2] ?? '5042002')
if (!Number.isInteger(chainId)) {
  throw new Error(`arc-book: "${process.argv[2]}" is not a chain id`)
}

const book = loadAddressBook(chainId)
process.stdout.write(
  `${JSON.stringify({
    chainId: book.chainId,
    launchFactory: book.launchFactory,
    feeEscrow: book.feeEscrow,
    smokeToken: book.smokeToken ?? null,
    smokeCurve: book.smokeCurve ?? null,
    /*
     * THE LOCKER AND THE BOOK'S GRADUATION TARGET, for the graduation leg.
     *
     * The Arc spec asserts that a completed curve offers NO graduate control,
     * and "no control" is a weak claim on its own -- a page that failed to
     * render anything would satisfy it. The strong version calls
     * `locker.graduate(curve)` read-only and shows the call really would have
     * reverted `GraduationTargetUnset()`, which needs the locker's address.
     *
     * `graduationTarget` is carried too, and it is NOT what the app uses: the
     * app reads it live off the factory precisely because it is governable. It
     * is here so the leg can say whether the BOOK and the CHAIN agree, which is
     * a different question and worth failing on.
     */
    arcpadLocker: book.arcpadLocker,
    bookGraduationTarget: book.graduationTarget,
  })}\n`,
)
