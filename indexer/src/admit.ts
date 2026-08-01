import type { Address, Hex } from 'viem'
import { concatHex, keccak256 } from 'viem'
import type { Deployment, Queryable } from '@arcpad/db'
import { applyLaunch } from '@arcpad/db'
import { writeMarketCap } from './apply/trade'
import { LAUNCH_TOKEN_CREATION_CODE } from './launch-token.generated'
import type { LaunchedEvent } from './logs'

/**
 * LAUNCH KABULU.
 *
 * `isCanonical(token)` provenance kontrolunun TAMAMIDIR
 * (`LaunchFactory.sol:473-507`): herkes gercek bir launch'in creator'ini,
 * curve'unu ve URI'sini iddia eden bir `LaunchToken` deploy edebilir. Indexer
 * dogrulamadigi bir token'i ASLA listelemez.
 *
 * UC BAGIMSIZ KAPI VARDIR VE HICBIRI DIGERINI KAPSAMAZ:
 *
 *   1. ADRES FILTRESI (Task 5, cekme ani). Yabanci bir yayincinin uydurdugu
 *      `Launched` HIC CEKILMEZ. Yakalamadigi: yapilandirilmis factory
 *      adresinin kendisi bir taklitse. Maliyet: sifir, filtre RPC tarafinda.
 *   2. YEREL CREATE2 YENIDEN TURETMESI (bu dosya, kabul ani). Yakaladigi:
 *      `LaunchToken` bytecode'u bizim derledigimizden farkli bir "factory", ve
 *      yapilandirilmis factory adresinin yanlis olmasi. Maliyet: SIFIR RPC,
 *      launch basina bir keccak256 (~4,1 KB).
 *   3. `eth_call isCanonical(token)` (YALNIZCA Task 12'nin entegrasyon
 *      testi). Sicak yolda gereksizdir ve gaz sinirsiz bir griefing yuzeyidir.
 *
 * `Launched` bu is icin `salt`i TASIR (`LaunchFactory.sol:188-190`): olay alti
 * constructor argumaninin HEPSINI artir salt'i artir beklenen token adresini
 * tasir, yani yerel turetme icin gereken her sey olayin icindedir ve EK CAGRI
 * GEREKMEZ.
 */

/**
 * TURETME GIRDISI HAM BAYTTIR, COZULMUS DIZGE DEGIL.
 *
 * BRIEF DUZELTMESI: plan bu fonksiyonu `deriveTokenAddress(factory, salt,
 * name: string, symbol: string, uri: string, ...)` diye yaziyor ve o imza,
 * planin KENDI gerekcesini yerine getiremez. `viem`in `decodeEventLog`'u (ve
 * bizim `hexToString`'imiz) gecersiz UTF-8 dizilerini sessizce U+FFFD yapar;
 * o dizgeyi `encodeAbiParameters([{type:'string'}], ...)` ile geri kodlamak
 * BASKA baytlar uretir, keccak baska cikar, adres baska cikar. Yani dizge
 * alan bir turetme, tam olarak korunmak istenen durumda -- DUSMAN METINLI bir
 * launch'ta -- yanlis cevap verir ve gecerli bir launch'i "kanonik degil" diye
 * reddeder (ya da tersi). Girdi bu yuzden `*_hex`tir ve `LaunchedEvent` o
 * alanlari cozucude, `data` dilimlenerek uretir.
 */
export interface DerivationInput {
  factory: Address
  salt: Hex
  nameHex: Hex
  symbolHex: Hex
  uriHex: Hex
  creator: Address
  curve: Address
  /**
   * YALNIZCA TEST ICIN gecilir; uretim yolunda hicbir cagiran vermez.
   *
   * Var olma sebebi olculebilirlik: "bayat bir creationCode BUTUN launch'lari
   * reddeder" iddiasi, testin kendi CREATE2 formulunu yazmasiyla degil, GERCEK
   * fonksiyona bozuk bir kod verilerek olculmeli. Testin formulu yeniden
   * yazmasi, bu deponun bes ariza kipinden besincisi olurdu: test edilen kodu
   * ATLAYAN bir yol uzerinden iddia etmek.
   */
  creationCode?: Hex
}

const ZERO_WORD = '0'.repeat(64)

/** `abi.encode`'un dinamik `bytes`/`string` kuyrugu: uzunluk + 32'ye yastikli veri. */
function dynamicTail(bytes: Hex): { length: Hex; body: Hex } {
  const raw = bytes.slice(2)
  const byteLength = raw.length / 2
  const padded = raw.length % 64 === 0 ? raw : raw + '0'.repeat(64 - (raw.length % 64))
  return {
    length: `0x${byteLength.toString(16).padStart(64, '0')}`,
    body: `0x${padded}`,
  }
}

function word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, '0')}`
}

function addressWord(address: Address): Hex {
  return `0x${ZERO_WORD.slice(0, 24)}${address.slice(2).toLowerCase()}`
}

/**
 * `LaunchFactory._tokenAddress` ile BIREBIR ayni.
 *
 * Alanlarin SIRASI `LaunchToken`'in constructor'iyla ayni olmak ZORUNDA
 * (`LaunchFactory.sol:542-544` -- "herhangi biri dusurulurse sahteci o alani
 * serbestce degistirip kanonik kalabilir"). Alti alanin ALTISI da tasiyicidir
 * ve `admit.test.ts` bunu alan alan olcer.
 */
export function deriveTokenAddress(input: DerivationInput): Address {
  const name = dynamicTail(input.nameHex)
  const symbol = dynamicTail(input.symbolHex)
  const uri = dynamicTail(input.uriHex)

  // Bas: uc offset + creator + curve + salt = 6 kelime.
  const headWords = 6n
  const nameOffset = headWords * 32n
  const symbolOffset = nameOffset + 32n + BigInt((name.body.length - 2) / 2)
  const uriOffset = symbolOffset + 32n + BigInt((symbol.body.length - 2) / 2)

  const args = concatHex([
    word(nameOffset),
    word(symbolOffset),
    word(uriOffset),
    addressWord(input.creator),
    addressWord(input.curve),
    input.salt,
    name.length,
    name.body,
    symbol.length,
    symbol.body,
    uri.length,
    uri.body,
  ])

  const initCodeHash = keccak256(
    concatHex([input.creationCode ?? LAUNCH_TOKEN_CREATION_CODE, args]),
  )
  const create2 = keccak256(concatHex(['0xff', input.factory, input.salt, initCodeHash]))
  return `0x${create2.slice(-40)}`.toLowerCase() as Address
}

/**
 * Kanonik olmayan launch. HALT, "logla ve devam et" DEGIL.
 *
 * GEREKCE: Kapi 1 (adres filtresi) sayesinde bu olay YALNIZCA gercek
 * factory'den gelebilir, ve gercek factory yalnizca `new LaunchToken` ile
 * urettigi tokenlari duyurur (`LaunchFactory.sol:437`). Yani bir uyusmazlik
 * ADVERSARIAL OLAMAZ; yalnizca iki sey olabilir:
 *   (a) dagitilmis factory'nin `LaunchToken` bytecode'u bizim `forge build`
 *       ciktimizdan FARKLI (surum/derleyici kaymasi), ya da yapilandirilmis
 *       factory adresi yanlis;
 *   (b) `LAUNCH_TOKEN_CREATION_CODE` bayat.
 * Ikisi de operasyonel acil durumdur. Sessizce atlamak, o launch'in TUM
 * ticaret gecmisini kalici olarak dusurur ve kimse farketmez.
 */
export class NonCanonicalLaunch extends Error {
  constructor(
    readonly token: Address,
    readonly expected: Address,
    readonly reason: RejectionReason,
  ) {
    super(
      `NonCanonicalLaunch(${reason}): olay ${token} diyor, yerel CREATE2 turetmesi ` +
        `${expected} veriyor. Bu bir veri hatasi degil OPERASYONEL bir acil durumdur: ` +
        `ya dagitilmis LaunchToken bytecode'u bizimkinden farkli, ya factory adresi ` +
        `yanlis, ya da LAUNCH_TOKEN_CREATION_CODE bayat.`,
    )
    this.name = 'NonCanonicalLaunch'
  }
}

/**
 * `rejected_launches.reason` SABIT BIR ETIKETTIR, serbest metin degil
 * (`CHECK (reason ~ '^[a-z_]{1,64}$')`). Semanin gerekcesi aynen soyluyor:
 * `reason` tam olarak bir yazarin cozulmus ismi ('name mismatch: ' || name)
 * icine yerlestirecegi yerdir ve o metin U+0000 tasirsa ingest islemi geri
 * alinir. Etiket kumesi burada TIP olarak duruyor ki o yol yazilamasin.
 */
export type RejectionReason = 'non_canonical' | 'foreign_factory'

export interface RejectionRecord {
  createdSeq: bigint
  token: Address
  curve: Address
  reason: RejectionReason
  expected: Address
  rawAddr: Address
  rawTopicsHex: string
  rawDataHex: Hex
}

export function rejectionOf(
  event: LaunchedEvent,
  expected: Address,
  reason: RejectionReason,
): RejectionRecord {
  return {
    createdSeq: event.seq,
    token: event.token,
    curve: event.curve,
    reason,
    expected,
    rawAddr: event.factory,
    // Bir EVM logunda EN COK DORT topic olur; sema deseni de oyle diyor.
    rawTopicsHex: event.rawTopics.join(','),
    rawDataHex: event.rawData,
  }
}

/**
 * Reddi YAZAR. Ayri bir fonksiyondur cunku Task 11 bunu AYRI BIR BAGLANTIDA
 * cagirmak zorundadir: `admit` bir ingest transaction'inin icinde kosar ve o
 * transaction `NonCanonicalLaunch` ile geri alinir -- ayni transaction'a
 * yazilan red kaydi da geri alinirdi.
 */
export async function recordRejection(db: Queryable, record: RejectionRecord): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO rejected_launches
       (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (created_seq) DO NOTHING`,
    [
      record.createdSeq.toString(),
      record.token.toLowerCase(),
      record.curve.toLowerCase(),
      record.reason,
      record.expected.toLowerCase(),
      record.rawAddr.toLowerCase(),
      record.rawTopicsHex.toLowerCase(),
      record.rawDataHex.toLowerCase(),
    ],
  )
  return rowCount ?? 0
}

/**
 * Bir `Launched`i KABUL EDER ya da `NonCanonicalLaunch` firlatir.
 *
 * `curve_state` ACILIS DEGERLERIYLE kurulur ve degerler `deployment`'tan
 * gelir -- spec'ten veya `.env`'den DEGIL. Testnet ile uretim yalnizca `V`'de
 * ayrisir (tam 1000x), yani yanlis profil market cap'i 1000 kat kaydirir ve
 * baska hicbir kontrol bunu gormez. Acilista `realTokenReserves = saleSupply`
 * ve `realQuoteReserves = 0`'dir (`BondingCurve.sol:386-391`).
 */
export async function admit(
  db: Queryable,
  deployment: Deployment,
  event: LaunchedEvent,
): Promise<number> {
  // KAPI 1'IN ILMEGI. Cekme katmani zaten factory adresine gore suzuyor, ama
  // `admit` cagiranina GUVENMEZ: bir sonraki katman (Task 11) watch set'i
  // yanlis kurarsa, o hata burada bir yabanci launch'i kabul ettirebilirdi.
  if (event.factory.toLowerCase() !== deployment.factory.toLowerCase()) {
    const expected = deriveTokenAddress({
      factory: deployment.factory,
      salt: event.salt,
      nameHex: event.nameHex,
      symbolHex: event.symbolHex,
      uriHex: event.uriHex,
      creator: event.creator,
      curve: event.curve,
    })
    await recordRejection(db, rejectionOf(event, expected, 'foreign_factory'))
    throw new NonCanonicalLaunch(event.token, expected, 'foreign_factory')
  }

  const expected = deriveTokenAddress({
    factory: deployment.factory,
    salt: event.salt,
    nameHex: event.nameHex,
    symbolHex: event.symbolHex,
    uriHex: event.uriHex,
    creator: event.creator,
    curve: event.curve,
  })

  if (expected.toLowerCase() !== event.token.toLowerCase()) {
    await recordRejection(db, rejectionOf(event, expected, 'non_canonical'))
    throw new NonCanonicalLaunch(event.token, expected, 'non_canonical')
  }

  // DONUS DEGERI: `launches`'a GERCEKTEN eklenen satir sayisi (0 ya da 1).
  //
  // PLAN SAPMASI: brief `admit(...) -> 'admitted'` diyor. Sabit bir dizge
  // dondurmek, "ikinci gecis HICBIR SEY yazmadi" iddiasini olculemez yapardi:
  // cagiran (Task 11'in dongusu ve idempotency testi) yazimin GERCEKLESIP
  // gerceklesmedigini ancak sayidan bilebilir. Reddedilen launch yine
  // `throw`dur, yani "kabul edildi mi" sorusunun cevabi kaybolmuyor.
  const inserted = await applyLaunch(db, {
    kind: 'launch',
    eventSeq: event.seq,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    txHash: event.txHash,
    blockTime: event.blockTime,
    token: event.token,
    curve: event.curve,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    uri: event.uri,
    // HAM baytlar. `toHexBytes(name)`e dusmek, cozulmus (ve belki coktan
    // kayipli) dizgeyi HAM baytmis gibi saklamak olurdu.
    nameHex: event.nameHex,
    symbolHex: event.symbolHex,
    uriHex: event.uriHex,
    salt: event.salt,
    virtualTokenReservesTok: deployment.virtualTokenReservesTok,
    virtualQuoteReservesWei: deployment.virtualQuoteReservesWei,
    realTokenReservesTok: deployment.saleSupplyTok,
    realQuoteReservesWei: 0n,
  })

  // ACILIS MARKET CAP'I. `applyLaunch` `token_stats`i sifir market cap'le
  // kurar ve o sifir bir SIRALAMA ANAHTARIDIR: Explore'un "market cap'e gore
  // sirala" beslemesinde hic ticaret gormemis bir token en dibe duserdi, oysa
  // acilis degeri (testnet profilinde tam 4 USDC) sifir DEGILDIR. Deger,
  // Task 10'un `token_overview` view'iyle AYNI ifadeden gelir, yani saklanan
  // anahtar ile gosterilen sayi ayrisamaz.
  if (inserted > 0) {
    await writeMarketCap(
      db,
      event.token,
      deployment.virtualQuoteReservesWei,
      deployment.virtualTokenReservesTok,
      deployment.totalSupplyTok,
      event.seq,
    )
  }
  return inserted
}
