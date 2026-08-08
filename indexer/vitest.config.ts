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

    /**
     * ZAMAN ASIMI OLCUMDEN GELIR, VARSAYILANDAN DEGIL.
     *
     * OLCULEN ARIZA: bir kosuda `apply-fees.test.ts`in IKI testi
     * `Test timed out in 5000ms` ile dustu (2 failed / 217 passed) ve AYNI
     * komut hemen ardindan 217/217 gecti. Ayni iki testin BOS makinedeki
     * suresi 261ms ve 251ms -- yani kapiya ~20 KAT uzaktalar. Farki yaratan
     * sey yuktu: o sirada arka planda keeper mutasyon kampanyasi 22 kez
     * `typecheck` + `vitest` doguruyordu.
     *
     * SUCLU `fileParallelism` DEGIL, ve bu bir DUZELTMEDIR: bir onceki tur bu
     * arizayi "indexer parallelism'i pinlemiyor" diye kaydetmisti. YANLIS --
     * yukaridaki satir zaten orada ve `packages/db` ile ayni gerekceyi
     * tasiyor. Dosyalar SIRAYLA kosuyor, bir dosyanin testleri de sirayla
     * (`describe.concurrent` yok, olculdu), yani suite ICINDE gizlenen bir
     * cekisme YOK.
     *
     * SUCLU, 5.000ms'lik VARSAYILANIN kendisi: bu suite'te hicbir test
     * GECIKME hakkinda bir iddiada bulunmuyor -- iddialar muhasebe
     * degismezleri. Duvar saatine bagli bir kapi, olcmedigi bir olgu icin
     * suite'i KIRMIZI yapiyor; bu depo ayni sekli `chain-time-frozen`de bir
     * kez yasadi. Ve varsayilan zaten dar: BOS makinede en yavas indexer
     * testi 2.813ms, yani kapinin %56'si.
     *
     * 30 saniye GERCEK BIR ASILMAYI HALA YAKALAR ve bu ayrimin tamami:
     * gercek ariza (satir kilidi kilitlenmesi, havuz tukenmesi) SINIRSIZDIR,
     * yani 30sn'lik kapi onu 25 saniye GEC yakalar ama YAKALAR. Kaybedilen
     * tek sey bir PERFORMANS kapisidir -- ve onu bir varsayilanin yan etkisi
     * olarak degil, acik bir iddia olarak yazmak gerekir.
     *
     * `web/vitest.config.ts` ayni karari ayni gerekceyle zaten vermis
     * ("iddialari yanlis oldugu icin degil") ve yalnizca ihtiyaci olan
     * projeye vermis.
     *
     * DURUSTLUK NOTU -- BU DEGISIKLIK BIR YENIDEN URETIME DAYANMIYOR.
     * Ariza bir kez gorulduu; sonra KASITLI olarak tekrar denendi ve
     * URETILEMEDI: gercek bir kampanya (6 mutant, 22'lik kosunun ayni sekli)
     * arka planda kosarken TAM SUITE eski 5.000ms kapisiyla UC KEZ kosuldu ve
     * ucu de 222/222 gecti; ayri bir sentetik CPU yuku altinda
     * `apply-fees.test.ts` de 12/12 gecti. Yani bu satirlarin gerekcesi
     * "flake'i yakaladim" DEGIL, olculmus PAYDIR: en yavas test kapinin
     * %56'sinda. Bir kapinin 1,78 katlik payi, bir sinir degil bir yazi
     * turasidir.
     *
     * `hookTimeout` de yukseliyor: her dosyanin `beforeAll`i tam bir
     * `DROP SCHEMA` + migration kosusudur ve `migrate.test.ts` bos makinede
     * 3.244ms olculdu -- 10 saniyelik varsayilan, ayni yuk altinda ayni
     * sekilde duserdi.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
