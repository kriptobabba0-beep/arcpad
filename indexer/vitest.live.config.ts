import { defineConfig } from 'vitest/config'

/**
 * CANLI ENTEGRASYON TESTI, AYRI BIR PROJE.
 *
 * Varsayilan suite'ten AYRIDIR cunku gercek RPC ister ve saniyeler surer;
 * `vitest.config.ts` `test/integration/**`i DISLAR. Ayri olmasi onu istege
 * bagli YAPMAZ: dosya `ARC_RPC_URL` yoksa ATLAMAZ, COKER.
 *
 * `testTimeout` genis: Arc hem es zamanli hem ardisik istekleri sinirlar ve
 * bu kosu istekleri 400ms araliklarla, hiz siniri gorurse ustel geri
 * cekilmeyle yapar.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})
