import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// CONTRIBUTING.md: "Sayi bicimlendirmede locale her zaman en-US olarak
// verilir." Locale'siz cagrilan toLocaleString/Intl.NumberFormat/
// Intl.DateTimeFormat, calistigi makinenin locale'ine sessizce duser -- ayni
// para miktari bir kullanicida "1,234.50", digerinde "1.234,50" okunur.
const LOCALE_MESSAGE =
  'Bu depo sayi/tarih bicimlendirmesinde locale sabitler: en-US. Locale argumanini acikca gecin (bkz. CONTRIBUTING.md).'

// ONE BALANCE, ONE SEAM. `web/lib/balance.ts` is the only module that may
// reach wagmi's `useBalance`; everything else derives from what it returns.
const WAGMI_RESTRICTED = [
  {
    name: 'wagmi',
    importNames: ['useBalance'],
    message:
      "On Arc the native asset IS USDC: the native and the ERC-20 reading are two views of ONE fund, so a second balance read is the same money counted twice. Use `useUsdcBalance()` (web/hooks), which derives the six-decimal view from web/lib/balance.ts's single read.",
  },
  {
    name: 'wagmi',
    importNames: ['useAccount'],
    message:
      '`useAccount` is a deprecated alias of `useConnection` in wagmi 3.x. Import `useConnection`, or use `useArcNetwork()` which already wraps it with the wrong-network verdict.',
  },
  {
    name: 'wagmi',
    importNames: ['useAccountEffect'],
    message:
      '`useAccountEffect` is a deprecated alias of `useConnectionEffect` in wagmi 3.x. Import `useConnectionEffect`.',
  },
]

// THE DEVCHAIN HARNESS IS NOT APPLICATION CODE. `@arcpad/shared/devchain`
// spawns an `anvil` subprocess and reads compiled artifacts off disk. It lives
// in `src/` rather than `test/` because Task 15 needs the same two helpers and
// a relative import into another package test directory is a brittle bond --
// the subpath makes it an explicit contract. The price is that a page could
// import it, and this is what closes that.
const DEVCHAIN_RESTRICTED = {
  name: '@arcpad/shared/devchain',
  message:
    'The devchain harness spawns anvil and reads contracts/out/ from disk. It belongs to tests (packages/shared/test/chain, and Task 15), never to a page or a component.',
}
export default tseslint.config(
  {
    ignores: [
      'contracts/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/out/**',
      '**/*.tsbuildinfo',
      'web/next-env.d.ts',
      // .superpowers/ is git-ignored scratch: task briefs, review packages, and the
      // mutation/live-break harnesses preserved out of the ephemeral scratchpad so
      // they survive a session. They are throwaway instruments, not shipped source
      // -- and they are deliberately written to be broken (a mutation harness edits
      // a copy of real code), so linting them is meaningless. Without this line
      // `make lint` reports ~90 errors that no one can act on, which trains people
      // to ignore the lint gate. Deliberately narrow: it does NOT mask errors in
      // packages/, indexer/, keeper/ or web/, which live at different paths.
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /*
     * DUZ `.mjs` PROBE'LARI: NODE GLOBALLERI ACIKCA TANITILIR.
     *
     * Asagidaki blok `no-undef`i `.ts`/`.tsx` icin KAPATIR ve gerekcesi
     * "TypeScript zaten kontrol ediyor"dur. O gerekce bir `.mjs` icin
     * GECERLI DEGIL -- orada tip denetleyicisi yok, yani kural ACIK KALMALI
     * ve yanlis pozitifler global listesiyle cozulmeli.
     *
     * Liste `globals` paketinden degil ELLE: bu depoda o paket yok ve
     * `scripts/probe/*.mjs`in kullandigi global sayisi altiyi gecmiyor. Bir
     * yazim hatasi (`conosle.log`) boylece hala YAKALANIR; komple kapatmak
     * onu sessizce gecirirdi.
     */
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // TypeScript (+ @types/node, @types/react) zaten butun global/ambient
      // tanimlari kontrol eder; no-undef bunlari bilmez ve yanlis pozitif
      // uretir. typescript-eslint'in kendi onerisi TS dosyalarinda bu
      // kurali kapatmaktir.
      'no-undef': 'off',

      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='toLocaleString'][arguments.length=0]",
          message: `toLocaleString() locale argumani olmadan cagrildi. ${LOCALE_MESSAGE}`,
        },
        {
          selector:
            "NewExpression[callee.object.name='Intl'][callee.property.name=/^(NumberFormat|DateTimeFormat)$/][arguments.length=0]",
          message: `new Intl.NumberFormat()/DateTimeFormat() locale argumani olmadan cagrildi. ${LOCALE_MESSAGE}`,
        },
        {
          selector:
            "CallExpression[callee.object.name='Intl'][callee.property.name=/^(NumberFormat|DateTimeFormat)$/][arguments.length=0]",
          message: `Intl.NumberFormat()/DateTimeFormat() locale argumani olmadan cagrildi. ${LOCALE_MESSAGE}`,
        },
      ],
    },
  },
  // ------------------------------------------------------------------
  // no-restricted-imports, COMPOSED.
  //
  // MEASURED WHILE WRITING THIS: flat config does NOT merge two `rules`
  // entries for the same rule -- the last matching block REPLACES the earlier
  // one wholesale. A first draft gave the devchain restriction its own block
  // BEFORE the wagmi block, and the wagmi block silently erased it for every
  // file under `web/app/**` and `web/components/**`. The rule reported nothing
  // and looked configured.
  //
  // So the narrower block REPEATS the broader one, and
  // `web/test/balance.test.ts` runs the linter on both file sets to prove
  // neither restriction went missing.
  // ------------------------------------------------------------------
  {
    files: ['web/**/*.ts', 'web/**/*.tsx'],
    ignores: ['web/lib/balance.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: WAGMI_RESTRICTED }] },
  },
  {
    files: [
      'web/app/**/*.ts',
      'web/app/**/*.tsx',
      'web/components/**/*.ts',
      'web/components/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: [...WAGMI_RESTRICTED, DEVCHAIN_RESTRICTED] }],
    },
  },
)
