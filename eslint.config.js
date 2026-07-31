import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// CONTRIBUTING.md: "Sayi bicimlendirmede locale her zaman en-US olarak
// verilir." Locale'siz cagrilan toLocaleString/Intl.NumberFormat/
// Intl.DateTimeFormat, calistigi makinenin locale'ine sessizce duser -- ayni
// para miktari bir kullanicida "1,234.50", digerinde "1.234,50" okunur.
const LOCALE_MESSAGE =
  'Bu depo sayi/tarih bicimlendirmesinde locale sabitler: en-US. Locale argumanini acikca gecin (bkz. CONTRIBUTING.md).'

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
)
