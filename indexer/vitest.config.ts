import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // CANLI test AYRI bir projedir (`vitest.live.config.ts`): gercek RPC
    // ister, saniyeler surer ve her kosuda zincire yuk bindirir. Burada
    // DISLANMASI onu istege bagli yapmaz -- o dosya `ARC_RPC_URL` yoksa
    // ATLAMAZ, COKER.
    exclude: ['test/integration/**'],
    // Veritabanina dokunan dosyalar (`admit`, `apply/*`) TEK bir Postgres
    // uzerinde `DROP SCHEMA public CASCADE` ile baslar. Paralel kosarlarsa bir
    // dosyanin drop'u digerinin tablolarini altindan ceker ve ariza her kosuda
    // baska sekle girer -- yani suite bazen yesil olur, ki bu "yazilmamis bir
    // gerekce yuzunden gecen test"in tanimidir. `packages/db` ayni karari ayni
    // sebeple veriyor.
    fileParallelism: false,
  },
})
