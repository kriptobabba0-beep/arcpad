import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `test/setup.ts` her dosyadan once `DROP SCHEMA public CASCADE` calistirir.
    // Dosyalar PARALEL kosarsa bir dosyanin drop'u digerinin tablolarini altindan
    // ceker ve arizanin sekli her kosuda degisir. Bu satir yoksa suite bazen
    // yesil olur -- yani "yazilmamis bir gerekce yuzunden gecen test"in tam
    // tanimi. Tek veritabani, tek dosya, sirayla.
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],

    /**
     * ZAMAN ASIMI OLCUMDEN GELIR. Gerekcenin tamami
     * `indexer/vitest.config.ts`te; burasi AYNI arizanin daha ilerlemis hali.
     *
     * OLCULDU, bos makinede: bu suite'in en yavas testi
     * (`ordering.test.ts` > "AYNI timestamp li iki ticaret...") **6.888ms**
     * raporluyor -- yani 5.000ms'lik VARSAYILANIN USTUNDE, ve suite yine de
     * yesil. Sebep, raporlanan surenin GOVDE + HOOK olmasi: `testTimeout`
     * yalnizca govdeyi, `hookTimeout` (varsayilan 10sn) `beforeEach`i
     * kelepceler, ve buradaki `beforeEach` tam bir `resetSchema` +
     * `replayRange`. Yani bu suite bugun IKI ayri varsayilanin arasindan
     * kil payi geciyor ve hangisinin ne kadar payi oldugu YAZILI DEGILDI.
     *
     * Ikisi de 30 saniyeye cekildi. Kaybedilen sey yok: hicbir test burada
     * GECIKME iddia etmiyor, ve gercek bir asilma sinirsiz oldugu icin hala
     * yakalaniyor.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
