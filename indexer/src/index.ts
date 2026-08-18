import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, arcRpcUrls, assertArcChain, createArcClient } from '@arcpad/shared'
import { createPool } from '@arcpad/db'
import { loadConfig } from './config'
import { createAddressWidthMemo, createPacer, getLogs, type RpcClient } from './logs'
import { createEmptyRangeGuard, witnessUrlFrom } from './empty-range-guard'
import {
  assertStartBlockCoversEscrow,
  createBuybackResolver,
  createHookResolver,
  ensureDeployment,
  isRateLimit,
  readFactoryProfile,
  runWithRetry,
} from './run'

/**
 * INDEXER'IN GIRIS NOKTASI.
 *
 * ACILIS SIRASI TESADUFI DEGIL:
 *   1. konfigurasyon -- eksik bir alan BURADA patlar, ilk turda degil;
 *   2. zincir kimligi (`assertArcChain`);
 *   3. PROFIL ZINCIRDEN okunur, `.env`den DEGIL;
 *   4. kayitli dagitimla karsilastirilir, uyusmazlikta HALT;
 *   5. dongu.
 *
 * Dorduncu adim olmadan iki dagitimin verisi ayni veritabaninda karisir ve
 * bunun geri donusu YOKTUR: hangi satirin hangi dagitimdan geldigi hicbir
 * yerde yazili degildir.
 *
 * Onceki hali bir GOSTERI yoluydu (head'i okur, bir aralik hesaplar, yazdirir)
 * ve hicbir sey yazmazdi; imleci ilerleten tek yol artik `runWithRetry`dir.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  // `retryCount: 0` -- YENIDEN DENEMENIN TAMAMI BU SURECIN.
  //
  // viem'in varsayilani (3) TEK bir paced istegi DORT bosluksuz HTTP istegine
  // cevirir ve bunu pacer'in GORMEDIGI yerde yapar. Olculdu: Arc'in limiti
  // UC bosluksuz `eth_getLogs`ta tetikleniyor (5/5), yani varsayilan tek
  // basina limiti asmaya yetiyor -- ve tam da limit yaniti geldiginde
  // devreye giriyor. Bu satirdan once indexer canliya karsi bes aralik sonra
  // `-32005` ile `exit 1` etti; stack'te `withRetry.delay.count.count`
  // (viem/utils/buildRequest.ts) goruluyordu.
  const client = createArcClient(arcRpcUrls(config.rpcUrl, config.rpcFallbackUrls), {
    retryCount: 0,
  })
  await assertArcChain(client)

  const pool = createPool(config.databaseUrl)
  const pacer = createPacer({ minIntervalMs: config.minRequestIntervalMs })
  // PACER ILE AYNI OMUR, AYNI SEBEP. Round 7'de canli olculdu: dongu basina
  // yeni bir memo, saglayicinin adres limitini HER ARALIKTA bastan
  // kesfetmek demekti (41 -> 20 -> 10 -> 5, sonraki blokta yine 41'den),
  // yani aralik basina alti bosa istek ve surekli mesgul bir hiz siniri
  // merdiveni. Tek nesne, butun dongu.
  const widthMemo = createAddressWidthMemo()
  // viem'in `PublicClient`'i `request`i tasir; indexer yalnizca o yuzeyi ister.
  const rpc = client as unknown as RpcClient

  const onChain = await readFactoryProfile(
    rpc,
    config.factory,
    BigInt(ARC_TESTNET_CHAIN_ID),
    config.startBlock,
    pacer,
  )
  const deployment = await ensureDeployment(pool, onChain)

  // KAPI, `ensureDeployment`TEN SONRA VE DONGUDEN ONCE.
  //
  // SIRA TASIYICI: taramanin gercekten kullandigi `startBlock`,
  // `config.startBlock` DEGIL `deployment.startBlock`tir -- `sameDeployment`
  // bu alani kimlige KATMAZ, yani kayitli bir satir varsa env'deki deger
  // sessizce yok sayilir (`runOnce`: `deployment.startBlock - 1n`). Kapiyi
  // `onChain` uzerinde kosturmak, tam da tehlikeli olan halde -- bayat bir
  // satir -- yanlis sayiyi dogrulamak olurdu.
  //
  // Escrow adresi zincirden geldi (`factory.escrow()`), env'den degil.
  await assertStartBlockCoversEscrow(rpc, deployment.escrow, deployment.startBlock, pacer)

  console.log(
    `[indexer] chain=${ARC_TESTNET_CHAIN_ID} factory=${deployment.factory} ` +
      `escrow=${deployment.escrow} V=${deployment.virtualQuoteReservesWei} ` +
      `startBlock=${deployment.startBlock} ` +
      `(escrow'un yaratilisi taramanin ICINDE -- dogrulandi)`,
  )

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

  // MEZUNIYET HEDEFI -> HAVUZ KABLOLAMASI, TEK ONBELLEK, BUTUN DONGU.
  // `pacer`/`widthMemo` ile ayni omur ve ayni gerekce: dongu basina yeni bir
  // cozucu, her aralikta ayni iki `eth_call`i tekrar yapardi. Bugun hicbir
  // token mezun olmadigi icin bir kez bile cagrilmaz.
  const resolveHook = createHookResolver(rpc, pacer)
  // BUYBACK KABLOLAMASI -> HAZINE + KASA, AYNI OMUR. Farki: hazine kurulana
  // kadar her aralikta BIR `eth_call` yapilir (sifir cevabi onbelleklenmez --
  // gerekce `createBuybackResolver`da), kurulduktan sonra hic yapilmaz.
  const resolveBuyback = createBuybackResolver(rpc, pacer)

  /*
   * ============ BOS ARALIK MUHAFIZI: BAGIMSIZ BIR IKINCI GOZ ============
   *
   * `client` bir YEDEKLI tasiyicidir ve yedege yalnizca birincil uc REDDEDERSE
   * gecer. Uretimde olculen ariza tam da bu bosluktaydi: birincil uc reddetmedi,
   * BOS DIZI dondu; viem bir hata gormedi, indexer "olay yok" kabul etti ve
   * imleci ilerletti. 36 escrow olayi kayboldu (`empty-range-guard.ts`).
   *
   * Tanik bu yuzden `client` OLAMAZ -- yalan soyleyen uca kendi yalanini sormak
   * dogrulama degil tekrardir. `witnessUrlFrom` deduplike edilmis listenin
   * IKINCI ucunu alir ve ona TEK BASINA bagli bir istemci kurar.
   *
   * YEDEK YAPILANDIRILMAMISSA MUHAFIZ KAPALIDIR VE BUNU SOYLER. Sessizce
   * hicbir sey yapan bir muhafiz, olmayan bir muhafizdan kotudur: varligi guven
   * verir. Uyari bir kez, baslangicta basilir.
   */
  const witnessUrl = witnessUrlFrom(arcRpcUrls(config.rpcUrl, config.rpcFallbackUrls))
  const witnessRpc =
    witnessUrl === null
      ? null
      : (createArcClient([witnessUrl], { retryCount: 0 }) as unknown as RpcClient)
  const witnessPacer = createPacer({ minIntervalMs: config.minRequestIntervalMs })
  /*
   * TANIK IZLEME KUMESI ISTEMEZ, VE BU BILINCLI BIR SADELESTIRME.
   *
   * Muhafizin yakaladigi sey tek bir kayip log DEGIL, ucun BOZUK DURUMUDUR --
   * olculen ariza da bir durumdu (aynı dakikada 0/10'a karsi 10/10), secmeli
   * bir kayip degil. Boyle bir uc araligin TAMAMINA bos der; dolayisiyla
   * statik iki adres (factory + escrow) uzerinde sonda atmak yeter ve
   * veritabanina, izleme kumesine, havuz cozucusune HIC dokunmaz.
   *
   * Daha genis bir sonda (curve/token adresleri) daha fazla log gorurdu ama
   * tespiti guclendirmezdi: yalan araliga aittir, adrese degil.
   */
  const emptyRangeGuard = createEmptyRangeGuard({
    witness:
      witnessRpc === null
        ? null
        : async (from, to) =>
            (
              await getLogs(
                witnessRpc,
                { from, to, address: [deployment.factory, deployment.escrow] },
                witnessPacer,
              )
            ).length,
  })
  if (!emptyRangeGuard.enabled) {
    console.warn(
      '[indexer] BOS ARALIK DOGRULAMASI KAPALI: `ARC_RPC_FALLBACK_URLS` bos, yani bagimsiz ' +
        'bir tanik yok. Bos bir `eth_getLogs` cevabi SORGUSUZ kabul edilir -- uretimde bu, ' +
        '36 olayin sessizce kaybolmasi demekti.',
    )
  }

  for (;;) {
    const result = await runWithRetry(pool, rpc, deployment, config, {
      pacer,
      widthMemo,
      resolveHook,
      resolveBuyback,
      onEmptyRange: emptyRangeGuard.onEmptyRange,
    })
    if (result === null) {
      // Head'e yetistik. `nextRange` `null` dondugunde HICBIR SEY yapilmaz --
      // ozellikle imlec ILERLETILMEZ.
      await sleep(config.pollMs)
      continue
    }
    console.log(
      `[indexer] ${result.from}-${result.to} events=${result.events} ` +
        `launches=${result.counts.launches} trades=${result.counts.trades} ` +
        // `completed` ve `graduated` AYRI BASILIR. Bir curve'un terminal
        // olusu, arayuzun gosterdigi her sayinin anlamini degistiren tek
        // olaydir; onu `events=` toplaminin icinde birakmak, ilk mezuniyeti
        // operatorun logunda GORUNMEZ yapardi.
        `completed=${result.counts.completed} graduated=${result.counts.graduated} ` +
        // HAVUZ ISLEMLERI AYRI BASILIR. Bugun beklenen deger SIFIRDIR; `trades`
        // ile birlestirilmis bir sayac, ilk havuz isleminin geldigi ani da hic
        // gelmedigi gercegini de operatorun logundan silerdi.
        `poolSwaps=${result.counts.poolSwaps} ` +
        `transfers=${result.counts.transfers} fees=${result.counts.fees} ` +
        // BUYBACK DA AYRI BASILIR, ayni gerekceyle: ozellik varsayilan olarak
        // KAPALIDIR ve yalnizca creator acabilir, yani sifir MESRU bir
        // sonuctur -- ve tam da bu yuzden "hic gelmedi" ile "geldi ama
        // sayilmadi" ayirt edilebilir olmak zorundadir.
        `buyback=${result.counts.buyback}`,
    )
  }
}

main().catch((error: unknown) => {
  // HALT SINIFI HATALAR BURADA BITER ve surec SIFIRDAN FARKLI bir kodla oler.
  // Yeniden baslatan bir supervisor'in ayni hatayi tekrar gormesi DOGRUDUR:
  // `DeploymentMismatch`, `NonCanonicalLaunch` ve `ReorgDetected` operatorun
  // mudahalesini isteyen olgulardir, kendiliginden gecmezler.
  console.error(error)
  // HIZ SINIRI YUZUNDEN OLMEK BASKA BIR OLGUDUR ve yigin izinden ANLASILMAZ.
  //
  // Bir yigin izi "-32005" der ve operator onu bir kusur sanir; oysa bu, butce
  // tukendigi icin -- yani ucun ISRARLA reddettigi icin -- verilmis bir karardir
  // ve caresi de baskadir (butceyi buyut, ya da ucu duzelt). OLCULDU: kasitli
  // doygunluk altinda (5.376 istegin 5.374'u reddedildi) indexer YEDI kez geri
  // cekildi, toplam 74,5 saniye bekledi, sonra bu satirdan cikti. Eski tavan
  // 3,75 saniyeydi.
  /*
   * BURAYA HIZ SINIRIYLA GELINMEZ, VE GELINMEMELI.
   *
   * Eski hal: hiz siniri sekiz denemede gecmezse `runWithRetries` firlatirdi
   * ve bu dal `exit 1` verirdi. Uretimde olculdu -- 141 yeniden baslatma,
   * imlec 60 saniyede sifir blok. Cikmak durumu DUZELTMIYOR, kotulestiriyor:
   * her yeniden baslatma, zaten dolu olan kovaya taze bir istek yolluyor.
   *
   * `run.ts` artik hiz sinirinda ust sinir tanimiyor (30 sn tavanli sonsuz
   * geri cekilme) ve aralik kendini yariliyor, yani bu surec hiz siniri
   * yuzunden ASLA cikmaz. Bu dal, siniflandirmanin bir gun degismesi
   * ihtimaline karsi duruyor ve artik "cikiyorum" DEMIYOR -- cunku buraya
   * duserse gercekten beklenmedik bir sey olmus demektir.
   */
  if (isRateLimit(error)) {
    console.error(
      `[indexer] UNEXPECTED: a rate-limit error escaped the retry loop, which no longer gives up ` +
        `on rate limiting. The cursor was NOT advanced, so a restart resumes exactly where this ` +
        `run stopped -- but this path should be unreachable and is worth investigating.`,
    )
  }
  process.exitCode = 1
})
