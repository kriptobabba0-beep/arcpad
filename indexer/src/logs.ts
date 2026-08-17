import { AsyncLocalStorage } from 'node:async_hooks'
import type { Address, Hex } from 'viem'
import { hexToString } from 'viem'
import { toSeq } from '@arcpad/db'
import {
  ADDRESS_FILTER_CHUNK,
  isForbiddenEmitter,
  KIND_BY_TOPIC0,
  TOPIC0,
  type EventKind,
} from './arc'
import { baseIsCurrency0, poolIdFor, poolKeyFor } from './pool'

/**
 * CEKME KATMANI.
 *
 * Bu dosyanin tek isi sudur: bir blok araligindan, arcpad'e AIT olan loglari,
 * SIRALI ve COZULMUS olarak getirmek. "arcpad'e ait" olmanin birinci yarisi
 * burada, RPC tarafinda, `address` filtresiyle kurulur; ikinci yarisi Task
 * 6'nin CREATE2 turetmesidir.
 *
 * VERITABANINA GUVENMIYORUZ. Sema, `token_transfers.token` ve `holders.token`
 * uzerindeki yabanci anahtarla EIP-7708 loglarini reddeder ve
 * `0x3600...0000`'i bir CHECK ile disari atar. Bu yapisal savunma DURUYOR ama
 * BU KATMANIN GEREKCESI DEGIL: hic cekilmemesi gereken bir seyi veritabaninin
 * yakalamasina birakmak, duvari veri yolunun EN SONUNA koymak olurdu.
 */

// ---------------------------------------------------------------------------
// Tipler
// ---------------------------------------------------------------------------

/**
 * `eth_getLogs`'un HAM yaniti. viem'in `Log` tipi DEGILDIR ve bilerek oyle:
 *
 * - Alanlar onaltiliktir (`0x...`), cunku RPC oyle dondurur.
 * - `blockTimestamp` viem'in `Log` tipinde YOKTUR ama Arc'ta HER logda vardir
 *   (olculdu: "blockTimestamp":"0x6a6a7f0a"). Calisma zamaninda var olan bir
 *   alani tip sistemi bilmiyorsa, o alan sessizce kullanilmaz hale gelir ve
 *   blok basina bir ek istege duseriz.
 */
export interface RawLog {
  address: string
  topics: readonly Hex[]
  data: Hex
  blockNumber: Hex
  logIndex: Hex
  transactionHash: Hex
  blockTimestamp?: Hex
  removed?: boolean
}

/** Bir logun kimligi ve zamani. Butun cozulmus olaylar bunu tasir. */
export interface LogRef {
  /** `block_number << 20 | log_index`. Tek anahtar, tek sira. */
  seq: bigint
  blockNumber: bigint
  logIndex: number
  txHash: Hex
  blockTime: Date
}

export interface LaunchedEvent extends LogRef {
  kind: 'launched'
  /** Logu yayan factory. Provenance'in birinci yarisi budur. */
  factory: Address
  token: Address
  curve: Address
  creator: Address
  name: string
  symbol: string
  uri: string
  /**
   * ZINCIRDEKI HAM BAYTLAR. `name`'den TURETILMEZ ve turetilemez:
   * `hexToString` gecersiz UTF-8 dizilerini U+FFFD yapar, geri kodlamak baska
   * baytlar verir, ve token kimligi CREATE2 ile HAM baytlardan turer.
   */
  nameHex: Hex
  symbolHex: Hex
  uriHex: Hex
  salt: Hex
  /**
   * LOGUN KENDISI, cozulmemis.
   *
   * `rejected_launches` reddedilen bir launch'i YALNIZCA onaltilik olarak
   * saklar (`raw_addr`, `raw_topics_hex`, `raw_data_hex`) ve bunlar cozulmus
   * alanlardan YENIDEN KURULAMAZ -- kurulabilseydi tablonun varlik sebebi
   * ortadan kalkardi. Bu yuzden ham log, reddi yazan katmana kadar tasinir.
   */
  rawTopics: readonly Hex[]
  rawData: Hex
}

export interface TradeEvent extends LogRef {
  kind: 'trade'
  /**
   * `Trade` TOKEN ADRESINI TASIMAZ. Kimlik `log.address` = curve adresidir;
   * curve->token eslemesi YALNIZCA `Launched`'dan gelir. Iki fazli cekisin iki
   * sebebinden biri budur.
   */
  curve: Address
  trader: Address
  /**
   * YON. `Trade` TEK bir olaydir ve bu bayrak INDEKSLI DEGILDIR -- yani yonu
   * bir topic'ten SUZEMEYIZ. Alim ve satimi ayri topic'lerle ayirmaya calisan
   * bir cekme yolu ikisini de kacirir.
   */
  isBuy: boolean
  tokenAmountTok: bigint
  quoteAmountWei: bigint
  protocolFeeWei: bigint
  creatorFeeWei: bigint
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  realTokenReservesTok: bigint
  realQuoteReservesWei: bigint
}

export interface CompletedEvent extends LogRef {
  kind: 'completed'
  curve: Address
  token: Address
  realQuoteReservesWei: bigint
  poolSeedSupplyTok: bigint
}

/**
 * TERMINAL DURUM -- BIR TICARET DURUMU DEGIL.
 *
 * `Completed`den AYRI bir olaydir ve ayri olmasi TASIYICIDIR: `complete` bir
 * curve hala okunabilir bir fiyat tasir (son ticaretin biraktigi rezervler) ve
 * havuz HENUZ acilmamistir; `graduated` bir curve ise `R` ile `D`yi
 * odemistir ve o rezervler artik hicbir seyi fiyatlamaz. Ikisini ayirmayan bir
 * okuma modeli, mezun olmus bir token'in sayfasinda son curve fiyatini CANLI
 * gibi gosterirdi -- bu deponun `Fresh<T>`/`stale` sozlesmesinin var olma
 * sebebi olan yalan sinifinin ta kendisi.
 */
export interface GraduatedEvent extends LogRef {
  kind: 'graduated'
  /** Logu yayan curve. `Trade` gibi, kimlik `log.address`tir. */
  curve: Address
  /** `topic1`. `Graduated` token'i TASIR (`Trade`in aksine). */
  token: Address
  /**
   * `topic2` -- graduation hedefi. INDEKSLIDIR cunku hedef yeniden
   * isaretlenebilir (factory'nin 3 gunluk gecikmeli setter'i) ve "bu havuzu
   * hangi hedef tohumladi" indexer'in cevaplamasi gereken bir sorudur.
   */
  to: Address
  /** Hedefe odenen token (`poolSeedSupply`). */
  baseAmountTok: bigint
  /** Hedefe odenen quote (`realQuoteReserves`). */
  quoteAmountWei: bigint
}

export interface DepositedEvent extends LogRef {
  kind: 'deposited'
  escrow: Address
  recipient: Address
  /** Yatiran curve. Ucretin hangi launch'tan geldigi YALNIZCA buradan bilinir. */
  from: Address
  amountWei: bigint
}

export interface ClaimedEvent extends LogRef {
  kind: 'claimed'
  escrow: Address
  recipient: Address
  amountWei: bigint
}

export interface TransferEvent extends LogRef {
  kind: 'transfer'
  token: Address
  from: Address
  to: Address
  amountTok: bigint
}

/**
 * BIR MEZUN TOKEN'IN HAVUZU. `PoolId` -> kime ait oldugu.
 *
 * `Swap` logu TOKEN ADRESINI TASIMAZ -- kimlik `topic1`deki `PoolId`, yani bir
 * HASH'tir. `Trade`in `curve`u ile ayni sinif bir sorun, bir farkla: bir
 * curve adresi `curve_state`ten OKUNABILIR, bir `PoolId` ise ancak
 * TURETILEBILIR (`poolIdFor(token, hook)`). Turetmenin girdisi olan hook
 * adresi de zincirden gelir (`locker.hook()`), env'den DEGIL -- `escrow`un
 * `factory.escrow()`ten okunmasiyla ayni gerekce: env'e yalan soylenebilir.
 */
export interface PoolRef {
  poolId: Hex
  token: Address
  curve: Address
  /** Odemeyi alan graduation hedefi (`Graduated.to`) -- locker. */
  target: Address
  hook: Address
  poolManager: Address
  /** `token < 0x3600...`. Fiyatin YONUNU belirler; tasinmazsa fiyat terse doner. */
  tokenIsCurrency0: boolean
}

export interface PoolSwapEvent extends LogRef {
  kind: 'poolSwap'
  /** Logu yayan `PoolManager`. */
  poolManager: Address
  /** `topic1`. */
  poolId: Hex
  /**
   * `topic2`. `PoolManager.swap`in CAGIRANI, yani `unlock` cercevesini acan
   * adres -- TIPIK OLARAK BIR ROUTER, son kullanici DEGIL.
   *
   * Egri tarafinda `Trade.trader` `msg.sender`dir ve orada da bir router
   * OLABILIR; fark, havuz tarafinda bunun KURAL olmasidir (V4'te `swap`
   * yalnizca bir `unlockCallback` icinden cagrilabilir, yani her swap'in
   * onunde en az bir kontrat vardir). `trades.trader` bu adresi tasir ve
   * baska bir sey tasiyamaz: son kullanici logda YOKTUR.
   */
  sender: Address
  /** `int128`, ISARETLI. Negatif = cagiran havuza ODER. */
  amount0: bigint
  amount1: bigint
  /** Swap SONRASI havuz fiyati. */
  sqrtPriceX96: bigint
  /** Swap SONRASI aralik ici likidite. */
  liquidity: bigint
  tick: number
  /**
   * `Swap.fee` -- HAVUZUN LP UCRETI, ve HER ZAMAN SIFIRDIR (spec §412).
   * Bunu "islemin ucreti" sanan bir okuma her havuz islemini ucretsiz
   * kaydeder; gercek ucret `PoolFeeEvent`ten gelir.
   */
  poolFeeBps: number
  /**
   * IZLEME KUMESINDEN GELIR, LOGDAN DEGIL. `fetchRange` doldurur.
   *
   * Cozucu bunu BILEMEZ ve bilmemesi dogru: bir cozucunun isi logu cozmektir,
   * kime ait oldugunu KARAR VERMEK degil. `null` gelmesi, sunucunun `topic1`
   * filtresini uygulamadigi anlamina gelir -- `ForbiddenEmitter` ile ayni
   * sinifta bir ariza -- ve uygulama katmani onu `UnknownPool` ile durdurur.
   */
  pool: PoolRef | null
  /**
   * `SwapFeeCollected`ten ESLENEN ucret, quote'un 6 DECIMAL biriminde.
   * `feePaired` false iken ikisi de sifirdir ve bu MESRUDUR: hook `fee == 0`
   * oldugunda hic log yaymaz (`ArcpadHook._collect`).
   */
  protocolFeeUnits: bigint
  creatorFeeUnits: bigint
  feePaired: boolean
}

/**
 * `PoolManager.Initialize` -- HAVUZUN DOGUM ANI.
 *
 * Bir defter satiri YOKTUR; tek isi TURETMEYI DOGRULAMAKTIR. `PoolId` bir
 * hash oldugu icin yanlis turetilmis bir kimlik hicbir zaman revert etmez,
 * yalnizca sonsuza kadar BOS doner -- ve bu depo o sessiz arizayi
 * (`Graduated`i escrow filtresine koymak) zaten bir kez adlandirdi. Bu olay
 * `currency0`/`currency1`i INDEKSLI, `fee`/`tickSpacing`/`hooks`u data'da
 * tasir, yani turettigimiz `PoolKey`in BES ALANI DA zincirin kendi
 * ifadesiyle karsilastirilabilir.
 */
export interface PoolInitializeEvent extends LogRef {
  kind: 'poolInitialize'
  poolManager: Address
  poolId: Hex
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
  sqrtPriceX96: bigint
  tick: number
}

/**
 * `ArcpadHook.SwapFeeCollected`. Miktarlar quote'un 6 DECIMAL biriminde.
 *
 * DEFTERI `fee_events`TIR AMA BU OLAY UZERINDEN DEGIL: hook ucreti
 * `FeeEscrow.deposit{value: quoteWei(fee)}` ile yatirir ve o cagri zaten
 * `Deposited` yayar -- indexer'in coktan izledigi olay. Bu logu ayrica
 * deftere yazmak AYNI PARAYI IKI KEZ saymak olurdu. Buradaki tek isi, ucreti
 * DOGRU `trades` SATIRINA baglamaktir; `Deposited` bunu yapamaz cunku
 * `from` alani hook'tur, hangi swap oldugunu SOYLEMEZ.
 */
export interface PoolFeeEvent extends LogRef {
  kind: 'poolFee'
  hook: Address
  poolId: Hex
  protocolFeeUnits: bigint
  creatorFeeUnits: bigint
}

/*
 * ---------------------------------------------------------------------------
 * BUYBACK NESLI -- ALTI OLAY
 * ---------------------------------------------------------------------------
 *
 * UCU HAZINEDEN, IKISI KASADAN, BIRI FABRIKADAN. Ayri kontratlar oldugu icin
 * `emitter` alani hangisinden geldigini soyler; indexer bunu ADRESE gore
 * filtreler, tipe gore degil.
 *
 * TUM QUOTE MIKTARLARI NATIVE WEI'DIR (18 decimal), havuz olaylarinin 6
 * decimal biriminde DEGIL. Ayrim tasiyicidir: hazine `pendingQuote`u wei
 * tutar, havuz ise ERC-20 birimiyle konusur, ve ikisini karistirmak 10^12
 * kat hata verir -- bu depoda `_marketCap` icin bir kez olculdu.
 */

/**
 * `LaunchFactory.BuybackEnabledUpdated`. Buyback ACILDI ya da KAPANDI.
 *
 * Bes para olayindan AYRI bir sinif: bir tutar tasimaz, bir KARAR tasir. Ve
 * defterde onlarla ayni tabloda durur, cunku "para nerede" sorusunun cevabi
 * politikanin ne zaman degistigini de icerir -- bir tokende tahakkukun DURMASI
 * bir ariza degil, creator'in ozelligi kapatmis olmasi olabilir.
 */
export interface BuybackEnabledUpdatedEvent extends LogRef {
  kind: 'buybackEnabledUpdated'
  factory: Address
  token: Address
  /** Degisikligi yapan: creator ya da governor (governor YALNIZCA kapatabilir). */
  by: Address
  enabled: boolean
}

/** `BuybackTreasury.BuybackAccrued`. Butce BUYUDU. */
export interface BuybackAccruedEvent extends LogRef {
  kind: 'buybackAccrued'
  treasury: Address
  token: Address
  /** Tahakkuku yapan merci: tokenin EGRISI ya da mezuniyet HOOK'u. */
  venue: Address
  /** Bu islemde ayrilan quote, native wei. */
  quoteAmount: bigint
  /** Ayirma SONRASI toplam bekleyen -- kumulatif, wei. */
  pending: bigint
}

/** `BuybackTreasury.BuybackExecuted`. Butce HARCANDI, token alindi. */
export interface BuybackExecutedEvent extends LogRef {
  kind: 'buybackExecuted'
  treasury: Address
  token: Address
  /** Gercekten harcanan quote, native wei. */
  quoteSpent: bigint
  /** Piyasadan alinan token, 18 decimal. */
  tokensBought: bigint
}

/**
 * `BuybackTreasury.BuybackSkipped`. Butce CREATOR'A GERI KATLANDI.
 *
 * @remarks BU OLAY OLMADAN DEFTER KAPANMAZ. `accrued` ile `executed`
 *          arasindaki fark, ancak bu olayla aciklanir; onsuz arayuz "para
 *          nerede" sorusuna cevap veremez ve fark bir KAYIP gibi okunur.
 *          `reason` operatorun ayirt etmesi gereken durumlari tasir
 *          (`pool-not-initialized`, `pool-cannot-absorb`,
 *          `below-threshold-or-unsafe`, `below-one-quote-unit`).
 */
export interface BuybackSkippedEvent extends LogRef {
  kind: 'buybackSkipped'
  treasury: Address
  token: Address
  quoteReturnedToCreator: bigint
  reason: string
}

/** `BuybackVestingVault.BuybackLocked`. Alinan token kilitlendi. */
export interface BuybackLockedEvent extends LogRef {
  kind: 'buybackLocked'
  vault: Address
  token: Address
  tokenAmount: bigint
  /** AGIRLIKLI vesting baslangici -- her yeni kilit onu ILERI iter. */
  vestingStart: bigint
  vestingEnd: bigint
  /** Kilitteki kumulatif toplam. */
  totalLocked: bigint
}

/** `BuybackVestingVault.VestingReleased`. Hak edilen dagitildi. */
export interface VestingReleasedEvent extends LogRef {
  kind: 'vestingReleased'
  vault: Address
  token: Address
  /** `release()`i cagiran -- creator ya da protokol hazinesi. */
  caller: Address
  creatorAmount: bigint
  protocolAmount: bigint
}

export type DecodedEvent =
  | LaunchedEvent
  | TradeEvent
  | CompletedEvent
  | GraduatedEvent
  | DepositedEvent
  | ClaimedEvent
  | TransferEvent
  | PoolSwapEvent
  | PoolInitializeEvent
  | PoolFeeEvent
  | BuybackEnabledUpdatedEvent
  | BuybackAccruedEvent
  | BuybackExecutedEvent
  | BuybackSkippedEvent
  | BuybackLockedEvent
  | VestingReleasedEvent

/**
 * Izlenen adresler. `curves` ve `tokens` KUME'dir cunku her aralikta buyurler
 * (Faz 1.5) ve uyelik sorgusu sicak yoldadir.
 */
export interface WatchSet {
  factory: Address
  escrow: Address
  curves: ReadonlySet<Address>
  /**
   * `Transfer` SORULACAK TOKEN'LAR -- LAUNCH EDILMIS HEPSI DEGIL.
   *
   * `Transfer` topic0'i EVRENSELDIR, dolayisiyla bu tek sorgu adres filtresini
   * BIRAKAMAZ (filtresiz olculen hacim 11.692 log / 1.000 blok). O yuzden
   * kume KUCULTULUR: arzinin tamami hala curve'de duran bir token `Transfer`
   * YAYAMAZ -- kimsede yoktur ki gondersin.
   *
   * Yuklem MONOTONDUR ("hic islem gordu mu"), yani bir kez girdikten sonra
   * cikmaz; geri donebilen bir yuklem (ornegin "su an holder'i var mi") ayni
   * kumeyi verirdi ama akil yurutmesi cok daha kirilgan olurdu.
   *
   * UC KAYNAK BIRLESIR ve ucu de gerekli: (1) daha once islem gormus olanlar
   * -- burada; (2) BU ARALIKTA launch edilenler -- mint `Transfer`i icin,
   * `fetchRange` FAZ 1.5; (3) BU ARALIKTA curve'u olay yayanlar -- ilk alim
   * ayni islemde hem `Trade` hem `Transfer` uretir, `fetchRange` FAZ 1.6.
   */
  tokens: ReadonlySet<Address>
  /**
   * curve -> token. `Trade` ve `Completed` TOKEN ADRESINI TASIMAZ (kimlik
   * `log.address` = curve'dur), dolayisiyla "bu aralikta islem goren token"
   * ancak bu eslemeyle bulunur.
   */
  curveToToken: ReadonlyMap<Address, Address>
  /**
   * MEZUN TOKEN'LARIN HAVUZLARI, `PoolId`e gore. BOS OLMASI NORMALDIR ve
   * bugun oyledir: uretim factory'sinin `graduationTarget`i `0x0`, yani hicbir
   * token mezun olmadi ve havuz sorgusu HIC YAPILMAZ (bkz. `fetchRange` FAZ 3).
   */
  pools: ReadonlyMap<Hex, PoolRef>
  /**
   * BUYBACK KATMANININ IKI ADRESI: hazine ve kasa.
   *
   * ============ BU ALAN OLMADAN BES OLAY HIC CEKILMIYORDU ============
   *
   * Cozme katmani (imzalar, tipler, `DECODERS`) tamamlanmisti ve fixture'lara
   * karsi olculuyordu, ama `fetchRange` bu adresleri HIC SORMUYORDU -- yani
   * uretimde tek bir buyback logu bile gelmezdi ve hicbir sey kirmizi olmazdi.
   * Fixture'lar loglari DOSYADAN okur; cozucunun dogru olmasi, logun
   * cekildigini SOYLEMEZ. Bu, bu depoda adi konmus "giris noktasi kapsami"
   * arizasinin ta kendisidir.
   *
   * `null` MESRUDUR ve bugun de mumkundur: `buybackTreasury` governor
   * tarafindan BIR KEZ yazilir ve yazilana kadar fabrika buyback'siz calisir
   * (`LaunchFactory.setBuybackTreasury` NatSpec'i bunu "gecerli ve guvenli bir
   * ara durum" diye adlandiriyor). O halde sorgu HIC YAPILMAZ -- `pools` bos
   * oldugunda havuz sorgusunun yapilmamasiyla ayni.
   */
  buyback: BuybackRef | null
}

/**
 * Hazine ve kasa adresleri. IKISI BIRLIKTE ya vardir ya yoktur: kasa
 * hazinenin constructor argumanidir, yani bir hazine varsa kasasi da vardir.
 */
export interface BuybackRef {
  treasury: Address
  vault: Address
}

/**
 * Bir graduation hedefinin (locker) havuz kablolamasi. `fetchRange` bunu
 * YALNIZCA bu aralikta YENI bir `Graduated` gordugunde cagirir, yani maliyeti
 * "mezuniyet basina iki `eth_call`"dir -- aralik basina degil.
 *
 * `null` donmesi MESRUDUR ve bir hata degildir: hedef bir `ArcpadLocker`
 * olmayabilir (prova factory'sinin hedefi `0x…dEaD`), o zaman havuz da yoktur
 * ve izlenecek bir sey yoktur.
 */
export type HookResolver = (
  target: Address,
) => Promise<{ hook: Address; poolManager: Address } | null>

/**
 * Fabrikanin buyback kablolamasi. `HookResolver` ile ayni sekil, ama SORUSU
 * aralik basinadir: hazine indexer calisirken kurulabilir.
 *
 * `null` = hazine HENUZ yazilmadi. Bkz. `createBuybackResolver`.
 */
export type BuybackResolver = (factory: Address) => Promise<BuybackRef | null>

/** Minimal RPC yuzeyi. viem'in `PublicClient`'i bunu KARSILAR. */
export interface RpcClient {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Hatalar
// ---------------------------------------------------------------------------

/**
 * EIP-7708 DUVARININ KENDISI.
 *
 * BU HATAYA DUSMEK, adres filtresinin dustugu anlamina gelir. Sessizce
 * atlamak tuzagi geri getirirdi: `0xfff...ffe` 18 decimal NATIVE USDC
 * hareketini, `0x3600...0000` ise AYNI hareketin 6 decimal gorunumunu yayar
 * (olculdu, ayni tx'te logIndex 0 ve 1). Ikisi de LaunchToken bakiyesi
 * DEGILDIR ve ikisi de bir holder deltasi olarak uygulanirsa bakiye
 * bozulur.
 */
export class ForbiddenEmitter extends Error {
  constructor(readonly emitter: string) {
    super(
      `ForbiddenEmitter: ${emitter} bir sistem emitter'i; adres filtresi dusmus. ` +
        `Bu log bir LaunchToken hareketi DEGILDIR (EIP-7708).`,
    )
    this.name = 'ForbiddenEmitter'
  }
}

/** Yanit (blockNumber, logIndex) sirasinda GELMEDI. */
export class UnorderedLogs extends Error {
  constructor(
    readonly previous: bigint,
    readonly current: bigint,
  ) {
    super(`UnorderedLogs: event_seq ${current} <= onceki ${previous}`)
    this.name = 'UnorderedLogs'
  }
}

/** Istenen araligin DISINDA bir log geldi. */
export class LogOutOfRange extends Error {
  constructor(
    readonly blockNumber: bigint,
    readonly from: bigint,
    readonly to: bigint,
  ) {
    super(`LogOutOfRange: blok ${blockNumber}, istenen aralik ${from}-${to}`)
    this.name = 'LogOutOfRange'
  }
}

/**
 * `removed: true`. Arc'ta reorg YOKTUR (deterministik finality, ~350ms);
 * boyle bir log gormek RPC'nin Arc olmadiginin kanitidir -- yok saymak degil,
 * DURMAK gerekir.
 */
export class RemovedLog extends Error {
  constructor(readonly blockNumber: bigint) {
    super(`RemovedLog: blok ${blockNumber} icin removed=true geldi; Arc'ta reorg yoktur`)
    this.name = 'RemovedLog'
  }
}

/** Ne logda ne de blokta `timestamp` var. Zamansiz bir olay yazilamaz. */
export class MissingTimestamp extends Error {
  constructor(readonly blockNumber: bigint) {
    super(`MissingTimestamp: blok ${blockNumber} icin ne logda ne blokta timestamp var`)
    this.name = 'MissingTimestamp'
  }
}

/**
 * TEK BIR BLOK sonuc sinirini asiyor. BLOK BOLME BURADA TUKENIR.
 *
 * IKINCI EKSEN ARTIK VAR: `getLogsChunked` bu hatayi yakalar ve ADRES
 * FILTRESINI yariya bolerek AYNI parcayi tekrar sorar (bkz. orada). Yani bu
 * sinif cagirana ancak ADRES EKSENI DE TUKENDIGINDE ulasir. `addressCount`
 * dolu geldiginde mesaj bunu soyler, cunku o halin caresi baskadir: kalan tek
 * eksen topic'tir ya da saglayicidir.
 */
export class SingleBlockTooLarge extends Error {
  constructor(
    readonly blockNumber: bigint,
    readonly addressCount?: number,
  ) {
    super(
      `SingleBlockTooLarge: blok ${blockNumber} tek basina sonuc sinirini asiyor; ` +
        (addressCount === undefined
          ? `blok bolme tukendi, adres filtresini bolmek gerekir`
          : `blok bolme VE adres bolme (${addressCount} adrese kadar) tukendi -- ` +
            `geriye topic ekseni ya da baska bir saglayici kaliyor`),
    )
    this.name = 'SingleBlockTooLarge'
  }
}

/** Bolme derinligi tukendi: RPC her seferinde reddediyor ve aralik kuculmuyor. */
export class SplitDepthExceeded extends Error {
  constructor(
    readonly from: bigint,
    readonly to: bigint,
  ) {
    super(`SplitDepthExceeded: ${from}-${to} araligi bolunmeye devam ediyor`)
    this.name = 'SplitDepthExceeded'
  }
}

/**
 * Logun sekli imzasiyla ortusmuyor (topic sayisi, `data` uzunlugu, ya da bir
 * dizge offset'i `data`nin disini gosteriyor).
 *
 * BRIEF'TE YOKTUR, EKLENDI. Gerekce: `forged.json` bir sahtecinin GERCEK
 * `topic0` ile log yayabildigini gosteriyor. Sekli kontrol etmeyen bir cozucu
 * kisa bir `data`dan sifir okur ve YANLIS BIR SAYIYI sessizce ureticiye verir
 * -- yani kullaniciya yanlis bir rakam gosterir. Kisa okumanin kendisi bir
 * hata olmali.
 */
export class MalformedLog extends Error {
  constructor(
    readonly kind: EventKind,
    reason: string,
  ) {
    super(`MalformedLog(${kind}): ${reason}`)
    this.name = 'MalformedLog'
  }
}

/**
 * Turettigimiz `PoolKey` ile zincirin `Initialize` logu AYRISTI. HALT.
 *
 * Bu, `poolIdFor`in bir carpisma uretmesi degildir (keccak256'nin carpismasini
 * beklemiyoruz): `PoolId` filtresi zaten SUNUCU tarafinda uygulandigi icin
 * gelen log BIZIM turettigimiz kimliktir. Ayrisma ancak `Initialize`in
 * KENDISININ baska bir anahtardan uretilmis olmasiyla mumkundur -- yani
 * `abi.encode` sirasi/tipleri hakkindaki varsayimimizin yanlis oldugu bir
 * dunya. Devam etmek, o yanlis varsayimi butun fiyat gecmisine yaymak olurdu.
 */
export class PoolKeyMismatch extends Error {
  constructor(
    readonly poolId: string,
    readonly field: string,
    readonly derived: string,
    readonly onChain: string,
  ) {
    super(
      `PoolKeyMismatch: havuz ${poolId} icin \`${field}\` turetmede ${derived}, ` +
        `zincirin Initialize logunda ${onChain}. PoolKey turetmesi (abi.encode sirasi, ` +
        `currency siralamasi, fee/tickSpacing sabitleri ya da hook adresi) YANLIS.`,
    )
    this.name = 'PoolKeyMismatch'
  }
}

/**
 * Bir curve mezun oldu, hedefi BILDIGIMIZ bir locker'di, ama AYNI ARALIKTA
 * havuzun `Initialize` logu YOK. HALT.
 *
 * `ArcpadLocker.graduate()` ATOMIKTIR: odemeyi ceker, `poolManager.initialize`
 * cagirir, likidite ekler ve `PoolManager`in KENDI durumundan geri okur --
 * herhangi biri basarisiz olursa islemin TAMAMI geri alinir. Yani "mezun oldu
 * ama havuz yok" zincirde TEMSIL EDILEMEZ bir durumdur. Gormek, ya turetmenin
 * ya da hedef cozumlemesinin bozuldugunu gosterir; ikisi de sessizce bos bir
 * fiyat gecmisi uretirdi.
 */
export class PoolNotInitialized extends Error {
  constructor(
    readonly token: string,
    readonly poolId: string,
    readonly target: string,
  ) {
    super(
      `PoolNotInitialized: ${token} bu aralikta ${target} hedefine mezun oldu ama ` +
        `turetilen havuz ${poolId} icin Initialize logu gelmedi. graduate() atomiktir; ` +
        `mezuniyet ile havuz acilisi AYNI islemdedir.`,
    )
    this.name = 'PoolNotInitialized'
  }
}

/**
 * `SwapFeeCollected` geldi ama hicbir `Swap`e eslenemedi. HALT.
 *
 * Hook ucreti YALNIZCA `_collect` icinde yayar ve `_collect` yalnizca
 * `_beforeSwap`/`_afterSwap`tan cagrilir -- yani ucretsiz bir ucret logu
 * yoktur. Sessizce atmak, o ucreti `trades` satirindan DUSURURDU ve satir
 * "ucretsiz islem" gibi okunurdu.
 */
export class UnpairedPoolFee extends Error {
  constructor(
    readonly poolId: string,
    readonly txHash: string,
    readonly count: number,
  ) {
    super(
      `UnpairedPoolFee: ${txHash} isleminde havuz ${poolId} icin ${count} adet ` +
        `SwapFeeCollected hicbir Swap'e eslenemedi.`,
    )
    this.name = 'UnpairedPoolFee'
  }
}

// ---------------------------------------------------------------------------
// Pacing -- "es zamanli VE ardisik" ikisi de sinirli
// ---------------------------------------------------------------------------

export interface Pacer {
  run<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * Pacer'in ZAMAN KAYNAGI. Uretimde `Date.now` + `setTimeout`; testte
 * yurutulebilir bir sanal saat.
 *
 * NICIN ENJEKTE EDILIYOR, VE BU BIR KOLAYLIK DEGIL BIR OLCULEBILIRLIK
 * SORUNUNUN CEVABI. `begin()` icindeki ikinci `nextEarliest` ilerletmesi
 * YALNIZCA `setTimeout` GEC ATESLEDIGINDE bir sey yapar. Bu, iki test
 * yaklasimini da tek basina yetersiz birakir:
 *
 *   GERCEK SAAT ile: gecikme vardir ama OLCULEMEZ. Testin gordugu bosluk
 *   makine yukune baglidir; `pnpm -r test` bes test surecini ayni CPU'da
 *   kosturunca olcum araligin altina duser ve test pacer kusursuzken KIRMIZI
 *   olur. Olculdu.
 *
 *   SAHTE SAAT (`vi.useFakeTimers`) ile: `setTimeout` TAM zamaninda atesler,
 *   yani gecikme HIC OLUSMAZ ve ikinci ilerletme gozlemlenemez hale gelir.
 *   OLCULDU VE MUTASYONLA KANITLANDI: o satiri silmek, sahte saat altindaki
 *   70 testin HEPSINI yesil birakti. Sahte saat, kusuru insaen gorunmez kilar.
 *
 * Enjekte edilen saat ucuncu secenektir ve ikisinin de kusurunu tasimaz:
 * gecikme GERCEKTEN olusur (test onu kendisi kurar) ve DETERMINISTIKTIR.
 * `test/logs.test.ts::virtualClock` gec atesleyen bir zamanlayici kurar; o
 * testin altinda ayni mutant OLUR.
 */
export interface PacerClock {
  now(): number
  schedule(fn: () => void, ms: number): void
}

const REAL_CLOCK: PacerClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    setTimeout(fn, ms)
  },
}

/**
 * Arc hem ES ZAMANLI hem ARDISIK istekleri hizlandirinca reddediyor (olculdu:
 * `eth_call`larda). Bu yuzden cekme katmani `Promise.all` YAZAR ama gercekten
 * paralel KOSMAZ: dort sorgu da bu kuyruktan gecer.
 *
 * Varsayilan `concurrency: 1`: bir aralikta dort sorgu var ve hepsi ayni
 * dugume gidiyor; paralellik kazanci ~0, red riski gercek.
 * `minIntervalMs` istekler ARASINA en az bir bosluk koyar -- ardisik hiz
 * siniri icin gereken sey budur ve es zamanlilik siniri onu VERMEZ.
 */
export function createPacer(opts?: {
  concurrency?: number
  minIntervalMs?: number
  clock?: PacerClock
}): Pacer {
  const concurrency = Math.max(1, opts?.concurrency ?? 1)
  const minIntervalMs = Math.max(0, opts?.minIntervalMs ?? 0)
  const clock = opts?.clock ?? REAL_CLOCK
  let active = 0
  /**
   * EN ERKEN BASLAMA ANI. `lastStart` DEGIL, ve fark olculdu.
   *
   * "Son BASLAYANIN zamani + aralik" yalnizca `concurrency === 1` iken bir
   * bosluk uretir. Iki slot bostayken iki `start()` ARDISIK olarak ayni
   * `lastStart`i okur, ayni `wait`i hesaplar ve AYNI MILISANIYEDE baslar.
   * Olculdu (`createPacer({concurrency: 4, minIntervalMs: 25})`, dort is):
   * bosluklar `27, 0, 0`; `concurrency: 2` ile `51, 0, 50, 0, 50`. Yani
   * `minIntervalMs` es zamanlilik acildigi anda SESSIZCE hicbir sey yapmiyordu
   * -- ustelik bu fonksiyonun dokumante ettigi tek ozellik oydu ("ardisik hiz
   * siniri icin gereken sey budur ve es zamanlilik siniri onu VERMEZ").
   *
   * `nextEarliest` IKI KEZ ilerletilir ve IKISI DE gerekli -- birincisini tek
   * basina yazmak, duzeltmenin ICINE eski kusurun taze bir ornegini koydu ve
   * test onu ANINDA yakaladi (bir bosluk 25 yerine 20 olctu):
   *
   *   1. SLOT VERILIRKEN, `at = max(now, nextEarliest)` ile. Es zamanli
   *      slotlarin birbirini itmesini saglayan sey budur; `max(now, ...)`
   *      kelepcesi ise GECMISTE kalmis bir rezervasyonu "simdi"ye cokertir,
   *      yani bir takilmadan sonra biriken rezervasyonlar PATLAMA uretmez
   *      (eski kusur, `lastStart = Date.now() + wait`, tam olarak o kelepcenin
   *      yoklugundandi).
   *   2. ISTEK GERCEKTEN BASLARKEN, `max(nextEarliest, now + minIntervalMs)`
   *      ile. Rezervasyon bir PLANDIR: `setTimeout` gec atesler ve istek
   *      planlanandan SONRA baslar; bir sonraki slotu yalnizca plana gore
   *      hesaplamak, o gecikme kadar KISA bir bosluk uretir. Ilerletme
   *      monotondur (`max`), yani hicbir yol araligi kisaltamaz.
   *
   * `concurrency === 1` davranisi degismedi ve olculdu: 60ms'lik bir
   * takilmadan sonra bosluklar yine `60, 25, 25`.
   */
  let nextEarliest = 0
  const queue: (() => void)[] = []

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }

  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const start = (): void => {
        active += 1
        const now = clock.now()
        const at = Math.max(now, nextEarliest)
        nextEarliest = at + minIntervalMs
        const begin = (): void => {
          nextEarliest = Math.max(nextEarliest, clock.now() + minIntervalMs)
          resolve()
        }
        if (at === now) begin()
        else clock.schedule(begin, at - now)
      }
      if (active < concurrency) start()
      else queue.push(start)
    })

  /**
   * IC ICE `run` KILITLENIR VE SESSIZ ASILIR -- BU YUZDEN YASAK.
   *
   * OLCULDU: canli entegrasyon testinin ilk hali istemciyi `pacer.run(...)`
   * ile sarmalayip AYNI pacer'i indexer'a da veriyordu. `concurrency: 1` iken
   * dis `run` tek slotu tutar, ic `run` ayni slotu bekler ve hicbiri
   * ilerlemez. Hicbir hata cikmaz: surec ASILIR. `beforeAll` iki kez 300
   * saniyede timeout oldu ve sebep ancak vitest'in disinda gorundu.
   *
   * Bir bayrak yetiyor cunku bu havuz TEK bir olay dongusunde, tek yonlu bir
   * cagri zincirinde kullaniliyor: `run` icinden yapilan her cagri, o `run`
   * bitmeden calisir. Kilitlenmeyi bir HATAYA cevirmek, onu bes dakikalik bir
   * sessizlikten bir satirlik teshise indirir.
   */
  // `AsyncLocalStorage` SART: duz bir bayrak ES ZAMANLI cagrilari da ic ice
  // sanardi. `fetchRange` uc sorguyu `Promise.all` ile baslatir; ilki slotu
  // alip beklerken ikincisi `run`a girer ve bir bayrak onu -- yanlislikla --
  // ic ice sayardi. Olculdu: bayrakli hal suite'te 20 testi kirdi. Depolama,
  // yalnizca AYNI async zincirindeki cagrilari isaretler.
  const nesting = new AsyncLocalStorage<true>()

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (nesting.getStore() === true) {
        throw new Error(
          'Pacer.run ic ice cagrildi: bu KILITLENIR (concurrency=1, dis cagri slotu tutar). ' +
            'Ya istemciyi sarmalayin YA DA pacer i gecirin -- ikisini birden degil.',
        )
      }
      await acquire()
      try {
        return await nesting.run(true, fn)
      } finally {
        release()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// RPC hata taksonomisi
// ---------------------------------------------------------------------------

/**
 * Arc'in `eth_getLogs`'unun UC ayri ret sekli vardir ve ucu de OLCULDU:
 *   -32012 "requested range too large"                    (span 50.000)
 *   -32614 "eth_getLogs is limited to a 10,000 range"     (span 100.000)
 *   -32602 "query exceeds max results 20000, retry with the range A-B"
 *
 * Tek bir kodu yakalayan bir retry, obur ikisinde imleci ilerletmeden sonsuz
 * doner. -32602 DOGRU ARALIGI KENDISI SOYLER, bu yuzden once o ayristirilir.
 */
const RANGE_ERROR_CODES = new Set([-32602, -32012, -32614])
const SUGGESTED = /retry with the range (\d+)-(\d+)/

/** Bolme derinligi tavani. 1.000 bloktan tek bloga 10 seviye yeter; 32 boldur. */
const MAX_SPLIT_DEPTH = 32

export interface RpcErrorShape {
  code?: number
  /** HTTP durum kodu -- transport bildiriyorsa. viem `HttpRequestError.status`. */
  status?: number
  /**
   * YALNIZCA SUNUCUNUN URETTIGI METIN. Siniflandirma BUNUN uzerinde yapilir.
   *
   * `message` (asagida) viem'in BICIMLENDIRDIGI bloktur ve icinde
   * `URL: <rpcUrl>` ile `Request body: {...}` GECER -- yani BIZIM gonderdigimiz
   * seyler. Onun uzerinde desen aramak, kendi konfigurasyonumuzu siniflandirma
   * girdisine cevirir. OLCULDU (2026-08-04, canli): Arc'in RPC'si
   * `https://rpc.testnet.arc.network` adresinde ve `isTransient`'in
   * `/network/i` deseni ADRESIN KENDISINE tutuyordu, boylece BUTUN hatalar --
   * `-32601 method not supported`, `-32602 invalid params`, `3 execution
   * reverted` dahil -- GECICI sayiliyordu. Dosyanin yazili varsayilani
   * ("bilinmeyen hata KALICIDIR") uretimde TERSINE donmustu.
   *
   * Duz bir transport (`{code, message}`) `details`/`shortMessage` tasimaz;
   * o durumda `message`'a duseriz, cunku orada `message` ZATEN sunucunun
   * metnidir.
   */
  details: string
  /** Bicimlendirilmis tam metin -- YALNIZCA GUNLUKLEME icin. */
  message: string
}

/**
 * viem hatayi sarar (`RpcRequestError` -> `.cause`), duz bir transport ise
 * `{code, message}` firlatir. Ikisini de okumak zorundayiz: yalnizca birini
 * okuyan bir ayristirici, obur tarafta HER retry'i kacirir ve o zaman hata
 * yukari kacar.
 */
export function asRpcError(error: unknown): RpcErrorShape {
  let code: number | undefined
  let status: number | undefined
  const messages: string[] = []
  const details: string[] = []
  let node: unknown = error
  for (let depth = 0; node !== null && node !== undefined && depth < 10; depth += 1) {
    const obj = node as Record<string, unknown>
    if (code === undefined && typeof obj['code'] === 'number') code = obj['code']
    if (status === undefined && typeof obj['status'] === 'number') status = obj['status']
    for (const key of ['details', 'shortMessage']) {
      const v = obj[key]
      if (typeof v === 'string') details.push(v)
    }
    const message = obj['message']
    if (typeof message === 'string') messages.push(message)
    node = obj['cause']
  }
  const shape: RpcErrorShape = {
    message: [...messages, ...details].join(' | '),
    // viem'de `details` VAR; duz transport'ta yok ve orada `message` sunucunun
    // kendi metnidir.
    details: (details.length > 0 ? details : messages).join(' | '),
  }
  if (code !== undefined) shape.code = code
  if (status !== undefined) shape.status = status
  return shape
}

export interface GetLogsParams {
  from: bigint
  to: bigint
  address?: readonly Address[] | Address
  topics?: readonly (Hex | Hex[])[]
}

function toFilter(p: GetLogsParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    fromBlock: `0x${p.from.toString(16)}`,
    toBlock: `0x${p.to.toString(16)}`,
  }
  // `address` YOKSA ALAN DA YOKTUR ve bu bilerek boyle: `undefined` bir alan
  // bazi transport'larda `null` olarak serilesir ve `null` "filtre yok"
  // demektir. Cagiranin filtre GECIRDIGINI saniyorken filtresiz sorulmasi tam
  // olarak EIP-7708 tuzagidir.
  if (p.address !== undefined) filter['address'] = p.address
  if (p.topics !== undefined) filter['topics'] = p.topics
  return filter
}

/**
 * `eth_getLogs` + bolme. Donen dizi (blockNumber, logIndex) sirasindadir ve
 * bu KONTROL EDILIR: yanitin sirali geldigi OLCULDU, ama holder deltalari
 * siraya bagimlidir ve sirayi varsaymak "kimsenin yazmadigi bir sebeple gecen
 * test"in ta kendisidir.
 */
export async function getLogs(
  client: RpcClient,
  params: GetLogsParams,
  pacer: Pacer,
  depth = 0,
): Promise<RawLog[]> {
  if (params.to < params.from) return []
  let raw: RawLog[]
  try {
    raw = (await pacer.run(() =>
      client.request({ method: 'eth_getLogs', params: [toFilter(params)] }),
    )) as RawLog[]
  } catch (error) {
    const { code, details } = asRpcError(error)
    if (code !== undefined && RANGE_ERROR_CODES.has(code)) {
      if (depth >= MAX_SPLIT_DEPTH) throw new SplitDepthExceeded(params.from, params.to)
      if (code === -32602) {
        // ONERI, SUNUCUNUN METNINDE aranir -- bicimlendirilmis blokta DEGIL.
        // O blok `Request body`'yi de tasir, yani BIZIM gonderdigimiz araligi;
        // orada arama yapmak sunucunun onerisiyle kendi sorgumuzu ayirt
        // edememek demektir.
        const m = SUGGESTED.exec(details)
        if (m?.[2] !== undefined) {
          const suggested = BigInt(m[2])
          // ONERIYI YALNIZCA ARALIGI GERCEKTEN KUCULTUYORSA kullaniriz.
          // Brief bunu kosulsuz yaziyor ve o hali bir sonsuz dongudur: `B >=
          // to` oneren bir sunucuda `splitAt` ayni araligi tekrar sorar,
          // tekrar reddedilir, ve imlec HIC ilerlemez. Kosul olculmus bir
          // arizadan degil, olcunun kendi bicimindendir -- "A-B" bir tavsiye,
          // bir garanti degil.
          if (suggested >= params.from && suggested < params.to) {
            return splitAt(client, params, suggested, pacer, depth + 1)
          }
        }
      }
      if (params.to === params.from) throw new SingleBlockTooLarge(params.from)
      return splitAt(client, params, params.from + (params.to - params.from) / 2n, pacer, depth + 1)
    }
    throw error
  }
  assertResponseOrdered(raw)
  return raw
}

async function splitAt(
  client: RpcClient,
  params: GetLogsParams,
  mid: bigint,
  pacer: Pacer,
  depth: number,
): Promise<RawLog[]> {
  const left = await getLogs(client, { ...params, to: mid }, pacer, depth)
  const right = await getLogs(client, { ...params, from: mid + 1n }, pacer, depth)
  return [...left, ...right]
}

/**
 * YANIT ICI SIRA. Bu, RPC'nin iddiasini olcen tek yerdir: dort sorgunun
 * BIRLESIMI zaten sirali degildir ve `fetchRange` onu kendisi siralar, yani
 * birlesim uzerindeki kontrol RPC hakkinda hicbir sey soylemezdi.
 */
function assertResponseOrdered(raw: readonly RawLog[]): void {
  let prev: bigint | undefined
  for (const log of raw) {
    const seq = toSeq(BigInt(log.blockNumber), Number(BigInt(log.logIndex)))
    if (prev !== undefined && seq <= prev) throw new UnorderedLogs(prev, seq)
    prev = seq
  }
}

/**
 * Adres listesini `ADDRESS_FILTER_CHUNK`'luk parcalara boler. BOS LISTE HIC
 * SORULMAZ: `address: []` bazi dugumlerde "filtre yok" demektir ve o an
 * EIP-7708'in butun loglarini geri getirir. Ilk aralikta `tokens` bos oldugu
 * icin bu yol GERCEKTEN kosulur.
 */
export async function getLogsChunked(
  client: RpcClient,
  addresses: readonly Address[],
  topics: readonly (Hex | Hex[])[],
  from: bigint,
  to: bigint,
  pacer: Pacer,
  chunkSize: number = ADDRESS_FILTER_CHUNK,
  memo?: AddressWidthMemo,
): Promise<RawLog[]> {
  if (addresses.length === 0) return []
  const out: RawLog[] = []
  // IKINCI EKSEN: ADRES FILTRESI DE KUCULUR.
  //
  // `SingleBlockTooLarge`, blok bolmenin tukendigi yerdir (`to === from`) ve
  // ADI KALICI KUMEDE oldugu icin ingest'i DURDURUYORDU -- kurtarma yolu
  // sinifin KENDI yorumunda yaziliydi ("adres filtresini bolmek gerekir") ama
  // hicbir yerde uygulanmamisti. Bugunku hacimde ulasilamaz; BIR LAUNCH GUNU
  // ulasilir, ve orada tek bir sicak blok ingest'i kalici olarak durdururdu.
  //
  // Daralma KEEPER'IN OLCULMUS SEKLIYLE AYNI: monoton (asla geri buyumez),
  // kendiliginden sinirli (her adimda yarilanir, 1'de durur -- 500 icin en
  // fazla 9 fazladan istek) ve AYRI BIR SAYAC YOKTUR. Bir sayac, saglayicinin
  // gercek sinirinin altina inmeyi engelleyip tam da onlemek istedigi
  // yakinsamamayi geri getirirdi.
  //
  // YAPISKAN, cunku ilk parcayi reddeden bir blok sonrakileri de reddeder;
  // her parcada duvara yeniden tosladigi bir hal, ayni islem icin O(n log n)
  // fazladan istek demekti.
  // BASLANGIC GENISLIGI, ONCEKI ARALIKLARIN OGRENDIGIYLE KELEPCELI. Bkz.
  // `AddressWidthMemo`: bu satir olmadan her aralik duvari BASTAN kesfeder ve
  // bosa giden istekler hiz siniri merdivenini surekli mesgul tutar.
  let size = Math.max(1, Math.min(chunkSize, addresses.length, memo?.width ?? chunkSize))
  let i = 0
  while (i < addresses.length) {
    const slice = addresses.slice(i, i + size)
    try {
      out.push(...(await getLogs(client, { from, to, address: slice, topics }, pacer)))
    } catch (error) {
      // YALNIZCA BU SINIF. Genel bir yeniden deneme maskesi, aralik disi her
      // hatayi da sessizce yutardi -- keeper'da M42 tam olarak bu mutanttir.
      if (error instanceof SingleBlockTooLarge && size > 1) {
        size = Math.max(1, Math.floor(size / 2))
        // MONOTON, ve `Math.min` bunu saglayan sey: iki es zamanli sorgu
        // (curve'ler ve token'lar `Promise.all` icinde) ayni memo'yu paylasir
        // ve biri otekinin ogrendigini GENISLETEMEZ.
        if (memo !== undefined) memo.width = Math.min(memo.width, size)
        continue // AYNI parcadan, DAR filtreyle. `i` ILERLEMEZ.
      }
      // Tek adres tek blokta bile tasiyorsa adres ekseni de tukendi; hata bunu
      // ADIYLA soyler, cunku caresi baskadir.
      if (error instanceof SingleBlockTooLarge) {
        throw new SingleBlockTooLarge(error.blockNumber, slice.length)
      }
      throw error
    }
    i += size
  }
  return out
}

// ---------------------------------------------------------------------------
// Cozucu
// ---------------------------------------------------------------------------

const WORD = 64

function word(data: Hex, index: number): Hex {
  return `0x${data.slice(2 + index * WORD, 2 + (index + 1) * WORD)}`
}

function wordCount(data: Hex): number {
  return Math.floor((data.length - 2) / WORD)
}

function uint(data: Hex, index: number): bigint {
  return BigInt(word(data, index))
}

function addressFrom(topic: Hex): Address {
  return `0x${topic.slice(-40)}`.toLowerCase() as Address
}

function addressOf(log: RawLog): Address {
  return log.address.toLowerCase() as Address
}

/**
 * `data` icindeki bir `string`in HAM baytlari.
 *
 * `hexToString`'e verilip geri kodlanamaz: gecersiz UTF-8 sessizce U+FFFD
 * olur ve CREATE2 turetmesi baska bir adres uretir. Dilim BURADA, cozulmeden
 * once alinir.
 */
function dynamicBytes(kind: EventKind, data: Hex, headIndex: number): Hex {
  const words = wordCount(data)
  const offset = uint(data, headIndex)
  if (offset % 32n !== 0n || offset / 32n >= BigInt(words)) {
    throw new MalformedLog(kind, `dizge offset'i data disinda: ${offset}`)
  }
  const lengthWord = Number(offset / 32n)
  const length = uint(data, lengthWord)
  const startHex = 2 + (lengthWord + 1) * WORD
  const endHex = startHex + Number(length) * 2
  if (length > BigInt(data.length) || endHex > data.length) {
    throw new MalformedLog(kind, `dizge uzunlugu data disinda: ${length}`)
  }
  return `0x${data.slice(startHex, endHex)}`
}

function expect(kind: EventKind, log: RawLog, topics: number, words: number): void {
  if (log.topics.length !== topics) {
    throw new MalformedLog(kind, `${topics} topic bekleniyordu, ${log.topics.length} geldi`)
  }
  if (wordCount(log.data) < words) {
    throw new MalformedLog(kind, `data ${words} kelime olmali, ${wordCount(log.data)} kelime geldi`)
  }
}

function decodeLaunched(log: RawLog, ref: LogRef): LaunchedEvent {
  expect('launched', log, 4, 4)
  const nameHex = dynamicBytes('launched', log.data, 0)
  const symbolHex = dynamicBytes('launched', log.data, 1)
  const uriHex = dynamicBytes('launched', log.data, 2)
  return {
    kind: 'launched',
    ...ref,
    factory: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    curve: addressFrom(log.topics[2] as Hex),
    creator: addressFrom(log.topics[3] as Hex),
    name: hexToString(nameHex),
    symbol: hexToString(symbolHex),
    uri: hexToString(uriHex),
    nameHex,
    symbolHex,
    uriHex,
    salt: word(log.data, 3),
    rawTopics: log.topics,
    rawData: log.data,
  }
}

function decodeTrade(log: RawLog, ref: LogRef): TradeEvent {
  expect('trade', log, 2, 9)
  return {
    kind: 'trade',
    ...ref,
    curve: addressOf(log),
    trader: addressFrom(log.topics[1] as Hex),
    // `bool` bir kelimedir ve SIFIR DEGILSE dogrudur. `=== 1n` yazmak,
    // ABI'nin garanti etmedigi bir seye guvenmek olurdu.
    isBuy: uint(log.data, 0) !== 0n,
    tokenAmountTok: uint(log.data, 1),
    quoteAmountWei: uint(log.data, 2),
    protocolFeeWei: uint(log.data, 3),
    creatorFeeWei: uint(log.data, 4),
    virtualTokenReservesTok: uint(log.data, 5),
    virtualQuoteReservesWei: uint(log.data, 6),
    realTokenReservesTok: uint(log.data, 7),
    realQuoteReservesWei: uint(log.data, 8),
  }
}

function decodeCompleted(log: RawLog, ref: LogRef): CompletedEvent {
  expect('completed', log, 2, 2)
  return {
    kind: 'completed',
    ...ref,
    curve: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    realQuoteReservesWei: uint(log.data, 0),
    poolSeedSupplyTok: uint(log.data, 1),
  }
}

function decodeGraduated(log: RawLog, ref: LogRef): GraduatedEvent {
  // UC topic (topic0 + iki indeksli) ve IKI kelime data. `expect` sekli
  // dogrular; ayni sekli tasiyan bir sahtenin adres filtresiyle elendigi yer
  // `fetchRange`tir, burasi degil.
  expect('graduated', log, 3, 2)
  return {
    kind: 'graduated',
    ...ref,
    curve: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    to: addressFrom(log.topics[2] as Hex),
    baseAmountTok: uint(log.data, 0),
    quoteAmountWei: uint(log.data, 1),
  }
}

function decodeDeposited(log: RawLog, ref: LogRef): DepositedEvent {
  expect('deposited', log, 3, 1)
  return {
    kind: 'deposited',
    ...ref,
    escrow: addressOf(log),
    recipient: addressFrom(log.topics[1] as Hex),
    from: addressFrom(log.topics[2] as Hex),
    amountWei: uint(log.data, 0),
  }
}

function decodeClaimed(log: RawLog, ref: LogRef): ClaimedEvent {
  expect('claimed', log, 2, 1)
  return {
    kind: 'claimed',
    ...ref,
    escrow: addressOf(log),
    recipient: addressFrom(log.topics[1] as Hex),
    amountWei: uint(log.data, 0),
  }
}

function decodeTransfer(log: RawLog, ref: LogRef): TransferEvent {
  // EIP-7708 DUVARI. Bkz. `ForbiddenEmitter`.
  if (isForbiddenEmitter(log.address)) throw new ForbiddenEmitter(log.address.toLowerCase())
  expect('transfer', log, 3, 1)
  return {
    kind: 'transfer',
    ...ref,
    token: addressOf(log),
    from: addressFrom(log.topics[1] as Hex),
    to: addressFrom(log.topics[2] as Hex),
    amountTok: uint(log.data, 0),
  }
}

/**
 * ISARETLI OKUMA. `int128` ve `int24` ABI'de 256 bite ISARET GENISLETILEREK
 * kodlanir, yani ham kelime iki tumleyendir.
 *
 * `uint`i olduğu gibi kullanan bir okuma NEGATIF miktarlari 1.1e77
 * civarinda DEV POZITIF sayilara cevirir. Sonucu sessizdir ve tam da bu
 * dosyanin korumaya calistigi seydir: `Swap.amount0` alis/satis YONUNU tasiyan
 * alandir, yani isaret kaybi her SATISI bir ALIS gibi kaydeder.
 */
function int(data: Hex, index: number): bigint {
  const raw = uint(data, index)
  return raw >= 1n << 255n ? raw - (1n << 256n) : raw
}

function decodePoolSwap(log: RawLog, ref: LogRef): PoolSwapEvent {
  // topic0 + id + sender = UC topic; data ALTI kelime.
  expect('poolSwap', log, 3, 6)
  return {
    kind: 'poolSwap',
    ...ref,
    poolManager: addressOf(log),
    poolId: log.topics[1] as Hex,
    sender: addressFrom(log.topics[2] as Hex),
    amount0: int(log.data, 0),
    amount1: int(log.data, 1),
    sqrtPriceX96: uint(log.data, 2),
    liquidity: uint(log.data, 3),
    tick: Number(int(log.data, 4)),
    poolFeeBps: Number(uint(log.data, 5)),
    // IKISI DE CEKME KATMANINDA DOLDURULUR. Bkz. alan yorumlari.
    pool: null,
    protocolFeeUnits: 0n,
    creatorFeeUnits: 0n,
    feePaired: false,
  }
}

function decodePoolInitialize(log: RawLog, ref: LogRef): PoolInitializeEvent {
  // topic0 + id + currency0 + currency1 = DORT topic; data BES kelime.
  expect('poolInitialize', log, 4, 5)
  return {
    kind: 'poolInitialize',
    ...ref,
    poolManager: addressOf(log),
    poolId: log.topics[1] as Hex,
    currency0: addressFrom(log.topics[2] as Hex),
    currency1: addressFrom(log.topics[3] as Hex),
    fee: Number(uint(log.data, 0)),
    tickSpacing: Number(int(log.data, 1)),
    hooks: addressFrom(word(log.data, 2)),
    sqrtPriceX96: uint(log.data, 3),
    tick: Number(int(log.data, 4)),
  }
}

function decodePoolFee(log: RawLog, ref: LogRef): PoolFeeEvent {
  expect('poolFee', log, 2, 2)
  return {
    kind: 'poolFee',
    ...ref,
    hook: addressOf(log),
    poolId: log.topics[1] as Hex,
    protocolFeeUnits: uint(log.data, 0),
    creatorFeeUnits: uint(log.data, 1),
  }
}

/*
 * ---------------------------------------------------------------------------
 * BUYBACK COZUCULERI
 * ---------------------------------------------------------------------------
 *
 * `expect(kind, log, topics, words)` HER BIRINDE COZUCUNUN ILK SATIRIDIR ve
 * bu bir tercih degil: bir olayin `indexed` sayisi degisirse topic'ler KAYAR
 * ve alanlar sessizce birbirinin yerine gecer. `expect` o kaymayi ADIYLA
 * bildirir; onsuz `venue` alaninda bir `token` adresi bulunur ve hicbir sey
 * kirmizi olmaz.
 */

/**
 * `BuybackEnabledUpdated(token, by, enabled)`.
 *
 * `enabled` INDEKSLI DEGILDIR, yani `data`nin ilk kelimesindedir ve ABI'de
 * `bool` 32 bayta SIFIRLA DOLDURULARAK kodlanir. Kelimenin TAMAMINA bakiyoruz,
 * son bayta degil: `uint(...) !== 0n` her mesru kodlamayi dogru okur ve
 * standart disi bir dolgu da sessizce `false` olmaz.
 */
function decodeBuybackEnabledUpdated(log: RawLog, ref: LogRef): BuybackEnabledUpdatedEvent {
  expect('buybackEnabledUpdated', log, 3, 1)
  return {
    kind: 'buybackEnabledUpdated',
    ...ref,
    factory: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    by: addressFrom(log.topics[2] as Hex),
    enabled: uint(log.data, 0) !== 0n,
  }
}

function decodeBuybackAccrued(log: RawLog, ref: LogRef): BuybackAccruedEvent {
  expect('buybackAccrued', log, 3, 2)
  return {
    kind: 'buybackAccrued',
    ...ref,
    treasury: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    venue: addressFrom(log.topics[2] as Hex),
    quoteAmount: uint(log.data, 0),
    pending: uint(log.data, 1),
  }
}

function decodeBuybackExecuted(log: RawLog, ref: LogRef): BuybackExecutedEvent {
  expect('buybackExecuted', log, 2, 2)
  return {
    kind: 'buybackExecuted',
    ...ref,
    treasury: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    quoteSpent: uint(log.data, 0),
    tokensBought: uint(log.data, 1),
  }
}

/**
 * @dev `reason` DINAMIK BIR DIZEDIR, yani `data` UC kelime tasir: tutar,
 *      dizenin OFSETI, ve dizenin kendisi. `dynamicBytes` ofseti izler --
 *      ikinci kelimeyi dogrudan okumak ofsetin KENDISINI dize sanardi.
 */
function decodeBuybackSkipped(log: RawLog, ref: LogRef): BuybackSkippedEvent {
  expect('buybackSkipped', log, 2, 2)
  return {
    kind: 'buybackSkipped',
    ...ref,
    treasury: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    quoteReturnedToCreator: uint(log.data, 0),
    reason: hexToString(dynamicBytes('buybackSkipped', log.data, 1)),
  }
}

function decodeBuybackLocked(log: RawLog, ref: LogRef): BuybackLockedEvent {
  expect('buybackLocked', log, 2, 4)
  return {
    kind: 'buybackLocked',
    ...ref,
    vault: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    tokenAmount: uint(log.data, 0),
    vestingStart: uint(log.data, 1),
    vestingEnd: uint(log.data, 2),
    totalLocked: uint(log.data, 3),
  }
}

function decodeVestingReleased(log: RawLog, ref: LogRef): VestingReleasedEvent {
  expect('vestingReleased', log, 3, 2)
  return {
    kind: 'vestingReleased',
    ...ref,
    vault: addressOf(log),
    token: addressFrom(log.topics[1] as Hex),
    caller: addressFrom(log.topics[2] as Hex),
    creatorAmount: uint(log.data, 0),
    protocolAmount: uint(log.data, 1),
  }
}

/**
 * Olay adi -> cozucu. Kapsam testi bu nesnenin ANAHTARLARINI kullanir: bir
 * olay eklenip cozucusu yazilmadiginda, ya da cozucu yazilip hicbir fixture
 * onu egzersiz etmediginde test kirilir.
 */
export const DECODERS: Readonly<Record<EventKind, (log: RawLog, ref: LogRef) => DecodedEvent>> =
  Object.freeze({
    launched: decodeLaunched,
    trade: decodeTrade,
    completed: decodeCompleted,
    graduated: decodeGraduated,
    deposited: decodeDeposited,
    claimed: decodeClaimed,
    transfer: decodeTransfer,
    poolSwap: decodePoolSwap,
    poolInitialize: decodePoolInitialize,
    poolFee: decodePoolFee,
    buybackEnabledUpdated: decodeBuybackEnabledUpdated,
    buybackAccrued: decodeBuybackAccrued,
    buybackExecuted: decodeBuybackExecuted,
    buybackSkipped: decodeBuybackSkipped,
    buybackLocked: decodeBuybackLocked,
    vestingReleased: decodeVestingReleased,
  })

// ---------------------------------------------------------------------------
// fetchRange
// ---------------------------------------------------------------------------

/**
 * OGRENILEN ADRES GENISLIGI, CAGRILAR ARASINDA TASINIR.
 *
 * ROUND 7'DE OLCULEN KUSUR, VE O KUSUR BU DOSYANIN KENDI DUZELTMESININ
 * ICINDEYDI. `getLogsChunked` daralmayi bir YEREL degiskende tutuyordu, yani
 * YAPISKANLIK yalnizca TEK BIR CAGRI boyunca yasiyordu. Birim testi tam da
 * onu olcuyor ve geciyor. Canlida (proxy, gercek zincir, 41 adreslik izleme
 * kumesi) sonuc soyleydi:
 *
 *   blok N   : 41 RED, 20 RED, 10 RED, 5 kabul, 5 x8 ...
 *   blok N+1 : 41 RED, 20 RED, 10 RED, 5 kabul, ...     <-- BASTAN
 *
 * Yani duvar HER ARALIKTA yeniden kesfediliyordu: parcali sorgu basina 3
 * bosa istek, aralik basina 6, SONSUZA KADAR. Olculen endpoint UC bosluksuz
 * `eth_getLogs`ta hiz sinirini tetikliyor, yani bu tam olarak `runWithRetry`
 * merdivenini surekli mesgul tutan sey; canli kosumda indexer 5/8. denemede
 * bekliyordu. Keeper'in "yakinsamayan tarama" wedge'iyle AYNI sekil, ve o
 * orada imleci kalici kilarak cozulmustu.
 *
 * TASIYICI ACIK, KURESEL DEGIL. Modul seviyesinde bir degisken testleri
 * birbirine baglardi (bir testin daralttigi genislik sonrakinin beklentisini
 * degistirirdi) -- yani gizli bir on kosul, ki bu depo onu bir kusur sayar.
 * Bunun yerine `pacer` ile AYNI omru ve AYNI threading'i tasiyan bir nesne:
 * `index.ts` bir tane yaratir, dongunun tamami onu paylasir.
 *
 * MONOTON: yalnizca KUCULUR. Geri buyuyen bir genislik, duvari her seferinde
 * yeniden bulup ayni firtinayi uretirdi.
 */
export interface AddressWidthMemo {
  /** Bugune kadar KABUL EDILDIGI gorulen en genis adres filtresi. */
  width: number
}

export const createAddressWidthMemo = (): AddressWidthMemo => ({
  width: Number.POSITIVE_INFINITY,
})

export interface FetchOptions {
  pacer?: Pacer
  addressChunk?: number
  /** Bkz. `AddressWidthMemo`. Verilmezse daralma cagri basina unutulur. */
  widthMemo?: AddressWidthMemo
  /**
   * `blockTimestamp` eksik oldugunda cagrilir. SESSIZ DUSMEK YASAK: o yol blok
   * basina bir ek istek demektir ve sessiz bir performans ucurumu bir hatadan
   * daha kotudur -- kimse aramaz.
   */
  onTimestampFallback?: (blocks: readonly bigint[]) => void
  /**
   * Bir graduation hedefinin havuz kablolamasini cozer. VERILMEZSE bu aralikta
   * mezun olan token'lar icin havuz izlenmez -- yalnizca `watch.pools`
   * kullanilir. Testlerin cogu bunu vermez ve VERMEMELI: havuzu olmayan bir
   * aralik, indexer'in bugunku uretim durumudur.
   */
  resolveHook?: HookResolver
  /** Hedefin locker OLMADIGI hal. Sessiz dusmek YASAK; bkz. cagri yeri. */
  onTargetWithoutPool?: (token: Address, target: Address) => void
}

function defaultTimestampWarning(blocks: readonly bigint[]): void {
  console.warn(
    `[indexer] eth_getLogs ${blocks.length} blok icin blockTimestamp DONDURMEDI; ` +
      `blok basina bir ek eth_getBlockByNumber cagrisina dusuluyor. ` +
      `Arc'ta bu alan olculmustu (ornek "0x6a6a7f0a") -- RPC degismis olabilir.`,
  )
}

/**
 * Bir blok araligindaki butun arcpad olaylari, `event_seq`'e gore SIRALI.
 *
 * IKI FAZLIDIR VE TEK FAZLI BIR TASARIMIN GERCEK HATASINI KAPATIR: tek fazli
 * bir cekiste `Transfer` sorgusu `address: knownTokens` ile suzulur; bir launch
 * AYNI ARALIKTA oldugunda token adresi henuz `knownTokens`'te degildir, yani o
 * launch'in mint `Transfer`'i HIC CEKILMEZ -- ve imlec ilerledigi icin bir daha
 * da cekilmez. Kayip kalicidir ve `SUM(holders.balance_tok) = 1e27` iddiasini
 * kalici olarak kirar.
 *
 * Siranin ZORUNLU oldugu OLCULDU: `launch()` mint `Transfer`'ini `Launched`'DAN
 * ONCE yayar -- `contracts/fixtures/launch.json`'da `Transfer` logIndex 0,
 * `Launched` logIndex 1; canli zincirde de ayni (smoke-receipts.json, launch).
 */
export async function fetchRange(
  client: RpcClient,
  watch: WatchSet,
  from: bigint,
  to: bigint,
  options: FetchOptions = {},
): Promise<DecodedEvent[]> {
  const pacer = options.pacer ?? createPacer()
  const chunk = options.addressChunk ?? ADDRESS_FILTER_CHUNK

  // FAZ 1: provenance kokunun kendisi. YALNIZCA factory adresinden.
  // Baska bir adresten gelen bir `Launched` HIC CEKILMEZ -- adres filtresi
  // ingest yolunun butun provenance kontrolunun BIRINCI yarisidir (ikincisi
  // Task 6'nin CREATE2 turetmesi).
  const launched = await getLogs(
    client,
    { from, to, address: watch.factory, topics: [TOPIC0.launched] },
    pacer,
  )

  // FAZ 1.5: izleme kumesini AYNI ARALIK icinde buyut.
  const curves = new Set<Address>(watch.curves)
  const tokens = new Set<Address>(watch.tokens)
  for (const log of launched) {
    if (log.topics.length < 3) continue // sekil kontrolu cozucude; burada atlamak yeter
    tokens.add(addressFrom(log.topics[1] as Hex))
    curves.add(addressFrom(log.topics[2] as Hex))
  }

  // FAZ 2: geri kalan her sey, GUNCELLENMIS kumeyle.
  //
  // SIRA DEGISTI VE BU BILINCLIDIR: curve sorgusu transfer sorgusundan ONCE
  // biter, cunku FAZ 1.6 onun sonucuna bakip transfer kumesini buyutur. Bedeli
  // YOK: uc sorgu da ayni pacer'dan gecer (bkz. `createPacer`), yani
  // `Promise.all` zaten es zamanlilik uretmiyordu -- yalnizca sirayi
  // gizliyordu.
  const [curveLogs, escrowLogs] = await Promise.all([
    // `Trade`/`Completed`/`Graduated` topic0'lari arcpad'e ozgudur AMA adres
    // filtresi yine de ZORUNLUDUR: herkes ayni imzayi tasiyan bir olay
    // YAYABILIR (bkz. `contracts/fixtures/forged.json` -- gercek `topic0`,
    // sahte yayinci). Filtre olmadan sahte bir `Trade` gercek bir islem gibi
    // girerdi.
    //
    // `Graduated` BURAYA AITTIR VE ESCROW SORGUSUNA DEGIL: yayinci curve'dur
    // (`emit Graduated(...)` `BondingCurve.graduate()` icindedir), yani izleme
    // kumesi `curves`tir. Escrow filtresine konsaydi HICBIR ZAMAN doner ve
    // "cekiliyor ama hic gelmiyor" arizasi tamamen sessiz olurdu.
    /*
     * ============ MALIYET AKTIVITEYLE OLCEKLENIR, KAYIT SAYISIYLA DEGIL ============
     *
     * ONCEKI HAL ADRES FILTRESI KULLANIYORDU ve o filtre `launches`'in TAMAMINI
     * tasiyordu: her 500 launch, HER DONGUDE bir `eth_getLogs` cagrisi daha
     * demekti. Yanlis olcekleme buydu -- bedel KAYIT sayisina baglanmisti, oysa
     * kayit ucretsizdir (olculdu: launch basina 0,039 USDC) ve populerlik
     * dogrudan kayit uretir. 100.000 launch, adres filtreli sorguda dongu
     * basina +200 cagri; Arc `eth_getLogs`i IP basina MALIYET BUTCESIYLE
     * sinirladigi ve butce bitince tek bloklu sorgu bile reddedildigi icin
     * sonuc, veri katmaninin KALICI olarak durmasiydi. Saldiri olarak da
     * ucuzdu, ama asil sorun saldiri degil: BASARI ayni yuku uretir.
     *
     * Uc `topic0` arcpad'e OZGUDUR, dolayisiyla adres filtresi olmadan sorulan
     * bir aralik yalnizca arcpad olaylarini (arti sahtelerini) dondurur ve
     * boyutu AKTIVITEYLE orantilidir -- dogru olcekleme budur.
     *
     * FILTRE KALDIRILMADI, TASINDI. Adres filtresinin islevi provenance'ti ve
     * o islev asagida, `curves` kumesine karsi AYNEN yapiliyor. Iki fark var
     * ve ikisi de lehimize:
     *   - Cagri sayisi N'den BAGIMSIZ (ceil(N/500) -> 1).
     *   - Sahte olay maliyeti saldirgana KALICI degil SUREKLI: yayin
     *       durdugunda etki biter. Launch spam'i ise tek odemeyle sonsuza
     *       kadar surerdi.
     *
     * INGEST'TEKI `UnknownCurve` HALT'I YERINDE KALIR VE KALMALIDIR: bu
     * filtreden sonra oraya bilinmeyen bir curve ULASAMAZ, dolayisiyla ulasirsa
     * gercekten bir hata vardir. Filtreyi ingest'e tasimak o sinyali yok
     * ederdi.
     */
    getLogs(
      client,
      { from, to, topics: [[TOPIC0.trade, TOPIC0.completed, TOPIC0.graduated]] },
      pacer,
    ).then((logs) => logs.filter((log) => curves.has(log.address.toLowerCase() as Address))),
    getLogs(
      client,
      { from, to, address: watch.escrow, topics: [[TOPIC0.deposited, TOPIC0.claimed]] },
      pacer,
    ),
    // EIP-7708 DUVARI: `Transfer` ASLA adres filtresi olmadan sorulmaz.
    // Filtresiz sorgunun olculen hacmi 11.692 log / 1.000 blok ve icinde her
    // native hareket var.
  ])

  /*
   * FAZ 1.6: BU ARALIKTA CURVE'U OLAY YAYAN TOKEN'LARI TRANSFER KUMESINE EKLE.
   *
   * `watch.tokens` yalnizca DAHA ONCE islem gormus tokenlari tasir (bkz. o
   * alanin notu). Bir tokenin ILK ALIMI ayni islemde hem `Trade` hem
   * `Transfer` uretir, yani o an kumede degildir ve transfer'i kacardi --
   * `holders.balance_tok >= 0` CHECK'i bunu gurultuyle yakalardi ama once
   * indexer dururdu. Bu faz o durumu hic dogurmaz.
   *
   * FAZ 1.5 ILE AYNI ARIZANIN IKINCI YUZU: orada launch, burada ilk islem.
   */
  for (const log of curveLogs) {
    const token = watch.curveToToken.get(log.address.toLowerCase() as Address)
    if (token !== undefined) tokens.add(token)
  }

  const transferLogs = await getLogsChunked(
    client,
    [...tokens],
    [TOPIC0.transfer],
    from,
    to,
    pacer,
    chunk,
    options.widthMemo,
  )

  // FAZ 2.5: BU ARALIKTA MEZUN OLAN TOKEN'LARIN HAVUZLARINI KUMEYE EKLE.
  //
  // FAZ 1.5 ILE AYNI ARIZA, BIR KAT YUKARIDA. Tek fazli bir cekiste havuz
  // sorgusu `watch.pools` ile suzulur; bir token AYNI ARALIKTA mezun olup
  // islem gorurse `PoolId` henuz kumede degildir, yani o `Swap`ler HIC
  // CEKILMEZ -- ve imlec ilerledigi icin bir daha da cekilmez. Kayip
  // KALICIDIR ve tam olarak "fiyat gecmisi kopmaz" iddiasinin ilk saniyesini
  // siler.
  const pools = new Map<Hex, PoolRef>(watch.pools)
  const bornHere: PoolRef[] = []
  for (const log of curveLogs) {
    if (log.topics[0] !== TOPIC0.graduated || log.topics.length < 3) continue
    const token = addressFrom(log.topics[1] as Hex)
    const target = addressFrom(log.topics[2] as Hex)
    const wiring = (await options.resolveHook?.(target)) ?? null
    if (wiring === null) {
      // HEDEF BIR LOCKER DEGIL -> HAVUZ DA YOK. Prova factory'sinin hedefi
      // `0x…dEaD`tir, yani bu MESRU bir zincir durumudur ve durmak yanlis
      // olurdu. Sessiz de degil: bir uyari yazilir, cunku bir arayuz o token
      // icin "havuzda islem goruyor" demeye baslayamaz.
      ;(options.onTargetWithoutPool ?? defaultTargetWithoutPoolWarning)(token, target)
      continue
    }
    const ref: PoolRef = {
      poolId: poolIdFor(token, wiring.hook),
      token,
      curve: addressOf(log),
      target,
      hook: wiring.hook,
      poolManager: wiring.poolManager,
      tokenIsCurrency0: baseIsCurrency0(token),
    }
    pools.set(ref.poolId, ref)
    bornHere.push(ref)
  }

  // FAZ 3: HAVUZ KATMANI. `pools` bossa TEK BIR ISTEK BILE YAPILMAZ -- ve
  // bugun oyle: uretim factory'sinin `graduationTarget`i `0x0`.
  const poolLogs = await getPoolLogs(client, [...pools.values()], from, to, pacer)

  // FAZ 4: BUYBACK KATMANI. Iki sorgu, ve ikisi de ADRES FILTRELIDIR.
  //
  // POLITIKA AYRI SORULUR, `Launched` ILE BIRLESTIRILMEZ. Ikisi de fabrikadan
  // gelir, yani tek bir `topics: [[launched, policy]]` filtresi cazip gorunur
  // -- ve YANLIS olurdu: FAZ 1.5 dongusu her donen logun `topics[2]`sini bir
  // CURVE sanip izleme kumesine ekler, oysa politika olayinda o alan `by`,
  // yani bir cuzdan. Sonucu sessizdir: kumeye giren sahte "curve" hicbir sey
  // yaymaz, ama `Trade` filtresi ondan sonra onu da kabul eder.
  //
  // BES OLAY ICIN ADRES FILTRESI ZORUNLUDUR. Topic'ler arcpad'e ozguymus gibi
  // gorunur ama `forged.json` bu depoda tam olarak bunun neden yetmedigini
  // kaydediyor: herkes ayni imzayi tasiyan bir olay YAYABILIR. Iki adres
  // oldugu icin filtre ucuzdur -- curve olaylarindaki "N ile olceklenme"
  // sorunu burada YOKTUR.
  const [policyLogs, buybackLogs] = await Promise.all([
    getLogs(
      client,
      { from, to, address: watch.factory, topics: [TOPIC0.buybackEnabledUpdated] },
      pacer,
    ),
    watch.buyback === null
      ? Promise.resolve([] as RawLog[])
      : getLogs(
          client,
          {
            from,
            to,
            address: [watch.buyback.treasury, watch.buyback.vault],
            topics: [
              [
                TOPIC0.buybackAccrued,
                TOPIC0.buybackExecuted,
                TOPIC0.buybackSkipped,
                TOPIC0.buybackLocked,
                TOPIC0.vestingReleased,
              ],
            ],
          },
          pacer,
        ),
  ])

  const decoded = await decodeAll(
    client,
    [
      ...launched,
      ...curveLogs,
      ...escrowLogs,
      ...transferLogs,
      ...poolLogs,
      ...policyLogs,
      ...buybackLogs,
    ],
    from,
    to,
    pacer,
    options,
  )

  return attachPoolContext(decoded, pools, bornHere)
}

/**
 * `topics[1]` (yani `PoolId`) filtresinde tek cagrida gecirilecek deger sayisi.
 *
 * OLCULMEMISTIR VE BU YAZILI OLMALI: bugun zincirde arcpad havuzu YOKTUR
 * (uretim `graduationTarget`i `0x0`), yani Arc'in topic filtresi kardinalite
 * sinirini olcecek bir sorgu kurulamaz. `ADDRESS_FILTER_CHUNK` (500, olculdu)
 * yerine daha muhafazakar bir sayi seciliyor cunku bilinmeyen bir sinirda
 * fazladan bir tur, kacirilmis bir logdan ucuzdur. Ilk gercek havuz
 * acildiginda olculup guncellenmeli.
 */
export const POOL_ID_FILTER_CHUNK = 100

/**
 * Havuz katmaninin BUTUN loglari, TEK BIR SORGU SEKLINDE.
 *
 * UC OLAY, IKI ADRES, BIR CAGRI -- ve bu bir tasarruf numarasi degil, uc
 * olayin ORTAK OZELLIGINDEN cikan bir sey: `Swap`, `Initialize` ve
 * `SwapFeeCollected`in UCUNDE DE `PoolId` `topic1`dir. Dolayisiyla ayni
 * `topics` filtresi ucunu birden secer ve `address` listesi
 * {PoolManager, hook} olur. Ayri ayri sorulsaydi aralik basina UC istek
 * olurdu; Arc'in siniri JSON-RPC NESNESI sayar (20 red, 15 gecer), yani
 * uctan bire inmek gercek bir butce farkidir.
 *
 * `address` ZORUNLUDUR: `PoolManager` zincirdeki HER havuzun `Swap`ini yayar,
 * ve filtresiz bir sorgu -- topic1 kelepcesi olsa bile -- adres filtresinin
 * dustugu bir dugumde her seyi geri getirirdi. Ayni gerekce `Transfer`in
 * EIP-7708 duvarinin gerekcesiyle aynidir.
 */
async function getPoolLogs(
  client: RpcClient,
  refs: readonly PoolRef[],
  from: bigint,
  to: bigint,
  pacer: Pacer,
): Promise<RawLog[]> {
  if (refs.length === 0) return []
  const addresses = [...new Set(refs.flatMap((r) => [r.poolManager, r.hook]))]
  const ids = [...new Set(refs.map((r) => r.poolId))]
  const topic0s = [TOPIC0.poolSwap, TOPIC0.poolInitialize, TOPIC0.poolFee]
  const out: RawLog[] = []
  for (let i = 0; i < ids.length; i += POOL_ID_FILTER_CHUNK) {
    const slice = ids.slice(i, i + POOL_ID_FILTER_CHUNK)
    out.push(
      ...(await getLogs(client, { from, to, address: addresses, topics: [topic0s, slice] }, pacer)),
    )
  }
  return out
}

function defaultTargetWithoutPoolWarning(token: Address, target: Address): void {
  console.warn(
    `[indexer] ${token} ${target} hedefine mezun oldu ama o hedef bir ArcpadLocker gibi ` +
      `cevap vermiyor (hook()/poolManager() okunamadi). HAVUZ ACILMAMIS demektir; bu ` +
      `token icin mezuniyet SONRASI islem gecmisi OLMAYACAK.`,
  )
}

/**
 * ================ HAVUZ BAGLAMI: SAHIPLIK VE UCRET ================
 *
 * Cozucu logu cozer; KIME AIT oldugunu ve UCRETININ ne oldugunu bilemez.
 * Ikisi de burada, cekme katmaninin bildigi seylerden kurulur.
 *
 * UCRET ESLEMESI EN YAKIN LOGA GORE YAPILIR, "ONCEKI"NE YA DA "SONRAKI"NE
 * GORE DEGIL -- CUNKU IKISI DE OLUYOR. `ArcpadHook` ucreti quote SPECIFIED
 * tarafta oldugunda `_beforeSwap`ta tahsil eder (log `Swap`ten ONCE gelir),
 * UNSPECIFIED tarafta oldugunda `_afterSwap`ta (log `Swap`ten SONRA gelir).
 * Dort swap seklinin ikisi bir dalda, ikisi otekinde. "Ucret her zaman
 * swap'ten oncedir" diye yazilmis bir esleme, islemlerin YARISINDA ucreti
 * kaybederdi.
 *
 * ANAHTAR (islem, havuz) CIFTIDIR: cok adimli bir islem birden cok havuza
 * dokunabilir ve her havuzun ucreti KENDI swap'ine aittir.
 */
export function attachPoolContext(
  events: readonly DecodedEvent[],
  pools: ReadonlyMap<Hex, PoolRef>,
  bornHere: readonly PoolRef[] = [],
): DecodedEvent[] {
  // SAHIPLIK ONCE COZULUR: ucret eslemesi swap'in QUOTE bacagini bilmek
  // zorunda, ve hangi bacagin quote oldugu `PoolRef`in siralama bayragindan
  // gelir. Ilk yazimda `pool` en SONDA dolduruluyordu ve o sirada esleme
  // her swap'i "quote bacagi bilinmiyor" halinde goruyordu.
  const swaps: PoolSwapEvent[] = []
  const fees: PoolFeeEvent[] = []
  const initialized = new Set<Hex>()
  for (const raw of events) {
    const event = raw.kind === 'poolSwap' ? { ...raw, pool: pools.get(raw.poolId) ?? null } : raw
    if (event.kind === 'poolSwap') swaps.push(event)
    else if (event.kind === 'poolFee') fees.push(event)
    else if (event.kind === 'poolInitialize') {
      assertDerivedPoolKey(event, pools)
      initialized.add(event.poolId)
    }
  }

  // (1) BU ARALIKTA DOGAN HER HAVUZUN `Initialize`I DE BU ARALIKTA OLMALI.
  for (const ref of bornHere) {
    if (!initialized.has(ref.poolId)) {
      throw new PoolNotInitialized(ref.token, ref.poolId, ref.target)
    }
  }

  // (2) UCRETLER: (tx, havuz) icinde, SIRAYLA, ve QUOTE BACAGI SIFIR OLAN
  //     SWAP'LER ATLANARAK.
  //
  // ILK HALI "EN YAKIN LOG" IDI VE O MAKINE OLU CIKTI -- OLCULDU, akil
  // yurutulmedi. Uc mutant kosuldu: "mesafe hep sifir" (yani ilk aday alinir)
  // 39 testin HICBIRINI kirmadi. Sebep aritmetik degil FIZIKSEL: hook ucreti
  // ya `_beforeSwap`ta (log swap'ten HEMEN once) ya `_afterSwap`ta (HEMEN
  // sonra) yayar, yani ulasilabilir her dizide "sirayla ata" ile "en yakini
  // ata" AYNI cifti verir. Mesafe hesabi, hicbir ulasilabilir girdide karar
  // vermeyen bir koddu.
  //
  // GERCEKTEN KARAR VEREN TEK SEY SU: QUOTE BACAGI SIFIR OLAN BIR SWAP'IN
  // UCRETI OLAMAZ. `ArcpadHook._collect` ucreti `feeOn(amount, bps)`ten
  // hesaplar ve `amount == 0` iken iki parca da sifirdir; `fee == 0` dalinda
  // fonksiyon HIC log yaymadan doner. Bu satir olmadan bir toz swap'i (18/6
  // decimal farkindan dogan, quote bacagi sifir olan swap) KENDINDEN SONRAKI
  // swap'in ucretini calardi ve iki satir birden yanlis olurdu.
  //
  // KALAN BELIRSIZLIK ADIYLA YAZILI: ayni islemde ayni havuza iki kez
  // dokunan ve IKISININ DE ucreti olan bir dizide, hangi ucretin hangi swap'e
  // ait oldugu LOGLARDAN COZULEMEZ -- dal secimi `zeroForOne`/`exactInput`e
  // baglidir ve `Swap` logu ikisini de TASIMAZ. Sirayla atama o durumda dogru
  // TOPLAMI verir ve satirlar arasinda yer degistirebilir. `fee_events`in
  // kaydettigi sey zaten toplamdir (`Deposited`), yani muhasebe etkilenmez.
  const claimed = new Set<PoolFeeEvent>()
  const paired = new Map<PoolSwapEvent, PoolFeeEvent>()
  for (const swap of swaps) {
    if (quoteLegOf(swap) === 0n) continue
    const fee = fees.find(
      (f) => !claimed.has(f) && f.poolId === swap.poolId && f.txHash === swap.txHash,
    )
    if (fee !== undefined) {
      claimed.add(fee)
      paired.set(swap, fee)
    }
  }
  for (const fee of fees) {
    if (!claimed.has(fee)) throw new UnpairedPoolFee(fee.poolId, fee.txHash, 1)
  }

  const bySeq = new Map(swaps.map((s) => [s.seq, s]))
  return events.map((event) => {
    if (event.kind !== 'poolSwap') return event
    const resolved = bySeq.get(event.seq) ?? event
    const fee = paired.get(resolved)
    return {
      ...resolved,
      protocolFeeUnits: fee?.protocolFeeUnits ?? 0n,
      creatorFeeUnits: fee?.creatorFeeUnits ?? 0n,
      feePaired: fee !== undefined,
    }
  })
}

/**
 * Bir swap'in QUOTE bacagi. `pool` bilinmiyorsa siralama da bilinmiyordur;
 * o halde ucret eslemesi YAPILMAZ ve karar uygulama katmanina
 * (`UnknownPool`) birakilir -- burada sessizce bir bacagi secmek, yanlis
 * bacagi secmenin en kolay yolu olurdu.
 */
function quoteLegOf(swap: PoolSwapEvent): bigint | undefined {
  if (swap.pool === null) return undefined
  return swap.pool.tokenIsCurrency0 ? swap.amount1 : swap.amount0
}

/**
 * `Initialize`in BES ALANI, turetilen `PoolKey`e karsi. Tek tek, ve hepsi.
 *
 * Yalnizca `PoolId`nin esitligine bakmak VAKUM olurdu: log zaten `topic1`
 * uzerinde O KIMLIKLE suzulerek geldi, yani esitlik tanim geregi dogrudur.
 * Olculen sey ANAHTARIN KENDISIDIR -- siralama, sabitler ve hook adresi.
 */
function assertDerivedPoolKey(event: PoolInitializeEvent, pools: ReadonlyMap<Hex, PoolRef>): void {
  const ref = pools.get(event.poolId)
  if (ref === undefined) return
  const key = poolKeyFor(ref.token, ref.hook)
  const checks: [string, string, string][] = [
    ['currency0', key.currency0, event.currency0],
    ['currency1', key.currency1, event.currency1],
    ['fee', String(key.fee), String(event.fee)],
    ['tickSpacing', String(key.tickSpacing), String(event.tickSpacing)],
    ['hooks', key.hooks, event.hooks],
  ]
  for (const [field, derived, onChain] of checks) {
    if (derived.toLowerCase() !== onChain.toLowerCase()) {
      throw new PoolKeyMismatch(event.poolId, field, derived, onChain)
    }
  }
}

/**
 * SERT IDDIALAR + cozme. Dordu de indexer'in davranisinin bagli oldugu,
 * olculmus ama hicbir yerde yazili olmayan olgulardir; varsayimi kontrole
 * cevirmek onlari yazili hale getirir.
 */
export async function decodeAll(
  client: RpcClient,
  raw: readonly RawLog[],
  from: bigint,
  to: bigint,
  pacer: Pacer,
  options: FetchOptions = {},
): Promise<DecodedEvent[]> {
  const missing: bigint[] = []
  const seen = new Set<string>()

  interface Prepared {
    log: RawLog
    kind: EventKind
    seq: bigint
    blockNumber: bigint
    logIndex: number
  }
  const prepared: Prepared[] = []

  for (const log of raw) {
    // (1) Arc'ta reorg YOKTUR.
    const blockNumber = BigInt(log.blockNumber)
    if (log.removed === true) throw new RemovedLog(blockNumber)

    // (2) Log istenen araligin ICINDE olmali. Disinda bir log, ya filtrenin
    //     uygulanmadigini ya RPC'nin kendi finalized'inin onunde oldugunu
    //     gosterir; ikisi de imleci bozar.
    if (blockNumber < from || blockNumber > to) throw new LogOutOfRange(blockNumber, from, to)

    const topic0 = log.topics[0]
    const kind = topic0 === undefined ? undefined : KIND_BY_TOPIC0.get(topic0)
    // Bilinmeyen bir topic0 SESSIZCE atlanmaz degil -- atlanir, ama yalnizca
    // filtrelerimizin ISTEMEDIGI bir sey oldugu icin: dort sorgunun dordu de
    // topic filtresi tasir, yani buraya bilinmeyen bir topic0 gelmesi RPC'nin
    // filtreyi uygulamadigi anlamina gelir. Ayni sinifta bir ariza olan
    // "adres filtresi dusmus" durumu `ForbiddenEmitter` ile yakalanir; burada
    // atlamak, cozulemeyen bir logu olay saymamaktir.
    if (kind === undefined) continue

    // (3) `blockTimestamp` her logda VAR (olculdu: "blockTimestamp":"0x6a6a7f0a").
    if (log.blockTimestamp === undefined) missing.push(blockNumber)

    const logIndex = Number(BigInt(log.logIndex))
    const seq = toSeq(blockNumber, logIndex)
    const key = `${blockNumber}:${logIndex}`
    // AYNI log iki sorgudan da gelirse iki kez uygulanirdi. Bugun mumkun
    // degil (filtreler ayrik) ama "bugun mumkun degil" bir kontrol degildir.
    if (seen.has(key)) throw new UnorderedLogs(seq, seq)
    seen.add(key)
    prepared.push({ log, kind, seq, blockNumber, logIndex })
  }

  const timestamps = await resolveTimestamps(client, missing, pacer, options)

  // Dort sorgunun BIRLESIMI sirali degildir; siralama BURADA yapilir.
  prepared.sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1))

  const out: DecodedEvent[] = []
  let prev: bigint | undefined
  for (const p of prepared) {
    // (4) SIRA. Holder deltalari siraya BAGIMLIDIR.
    if (prev !== undefined && p.seq <= prev) throw new UnorderedLogs(prev, p.seq)
    prev = p.seq

    const raw = p.log.blockTimestamp
    const seconds = raw === undefined ? timestamps.get(p.blockNumber) : BigInt(raw)
    if (seconds === undefined) throw new MissingTimestamp(p.blockNumber)

    out.push(
      DECODERS[p.kind](p.log, {
        seq: p.seq,
        blockNumber: p.blockNumber,
        logIndex: p.logIndex,
        txHash: p.log.transactionHash,
        blockTime: new Date(Number(seconds) * 1000),
      }),
    )
  }
  return out
}

/** Eksik timestamp'ler icin blok basina BIR ek cagri -- ve bir uyari. */
async function resolveTimestamps(
  client: RpcClient,
  missing: readonly bigint[],
  pacer: Pacer,
  options: FetchOptions,
): Promise<Map<bigint, bigint>> {
  const out = new Map<bigint, bigint>()
  if (missing.length === 0) return out
  const distinct = [...new Set(missing)]
  ;(options.onTimestampFallback ?? defaultTimestampWarning)(distinct)
  for (const blockNumber of distinct) {
    const block = (await pacer.run(() =>
      client.request({
        method: 'eth_getBlockByNumber',
        params: [`0x${blockNumber.toString(16)}`, false],
      }),
    )) as { timestamp?: Hex } | null
    if (block?.timestamp === undefined) throw new MissingTimestamp(blockNumber)
    out.set(blockNumber, BigInt(block.timestamp))
  }
  return out
}
