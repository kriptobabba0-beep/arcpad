import 'dotenv/config'
import { ARC_TESTNET_CHAIN_ID, assertArcChain, createArcClient } from '@arcpad/shared'
import { createPool } from '@arcpad/db'
import { loadConfig } from './config'
import { createPacer, type RpcClient } from './logs'
import { ensureDeployment, isRateLimit, readFactoryProfile, runWithRetry } from './run'

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
  const client = createArcClient(config.rpcUrl, { retryCount: 0 })
  await assertArcChain(client)

  const pool = createPool(config.databaseUrl)
  const pacer = createPacer({ minIntervalMs: config.minRequestIntervalMs })
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
  console.log(
    `[indexer] chain=${ARC_TESTNET_CHAIN_ID} factory=${deployment.factory} ` +
      `escrow=${deployment.escrow} V=${deployment.virtualQuoteReservesWei} ` +
      `startBlock=${deployment.startBlock}`,
  )

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

  for (;;) {
    const result = await runWithRetry(pool, rpc, deployment, config, { pacer })
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
        `transfers=${result.counts.transfers} fees=${result.counts.fees}`,
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
  if (isRateLimit(error)) {
    console.error(
      `[indexer] EXITING because Arc's rate limit did not clear across ${loadConfig().rateLimitMaxAttempts} attempts. ` +
        `This is a BUDGET decision, not a classification bug: the code is retried, and it was retried. ` +
        `Raise INDEXER_RATE_LIMIT_MAX_ATTEMPTS, raise INDEXER_MIN_REQUEST_INTERVAL_MS, or use a less contended endpoint. ` +
        `The cursor was NOT advanced, so a restart resumes exactly where this run stopped.`,
    )
  }
  process.exitCode = 1
})
