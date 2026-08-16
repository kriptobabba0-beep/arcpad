import type { Address, Hex } from 'viem'
import { toEventSelector } from 'viem'
import { USDC_ERC20_ADDRESS } from '@arcpad/shared'

/**
 * SINIR NOTU -- bu dosyanin normal evi `@arcpad/shared/src/arc.ts`'tir (plan
 * Task 1) ve o paket SU AN baska bir ajanin elinde; Task 1 henuz inmedi
 * (`packages/shared/src/` icinde ne `arc.ts` ne `artifacts.generated.ts` var,
 * olculdu 2026-08-01). `cursor.ts`'in acilisindaki ayni karar burada da
 * gecerlidir: pakete uzanmak yerine ihtiyac duyulan sey bu taskin sahip oldugu
 * sinirda tanimlanir. Task 1 indigi gun bu dosya
 * `export { ... } from '@arcpad/shared'` satirlarina iner ve `logs.ts`
 * DEGISMEZ -- tuketiciler sabitleri ADA gore kullanir, degere gore degil.
 *
 * IKI SEY BURADA TEKRARLANMIYOR: `USDC_ERC20_ADDRESS` @arcpad/shared'dan
 * ITHAL EDILIYOR (ikinci bir kopya, iki degerin sessizce ayrismasi demekti) ve
 * `ARC_GETLOGS_MAX_RANGE` `cursor.ts`'te zaten var.
 */

/**
 * EIP-7708'in sistem adresi. Arc'ta NATIVE varligin her hareketi buradan 18
 * decimal'lik bir `Transfer` logu yayar.
 *
 * OLCULDU (Arc testnet):
 *   tx 0xcdb86510...ae093 -- duz native transfer (input 0x, value 85615523834970299)
 *     -> TEK log, emitter 0xfff...ffe, 18 decimal. 0x3600... hic log yaymadi.
 *   tx 0xc9004d69...74611 -- USDC.transfer(0x1208...0e12, 1_768_280)
 *     -> logIndex 0: emitter 0xfff...ffe, data 1_768_280_000_000_000_000
 *     -> logIndex 1: emitter 0x3600...0000, data 1_768_280
 *     AYNI hareket, IKI log, IKI gorunum.
 *
 * BU DEPODAKI CANLI KANIT: `contracts/fixtures/arc-live/smoke-receipts.json`
 * bes gercek smoke makbuzunu aynen tasir ve dordunde ucer tane 0xfff...ffe
 * `Transfer`'i vardir. Test bunlari SENTETIK bir log yerine dogrudan oradan
 * okur.
 */
export const EIP7708_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe' as const

/**
 * `Transfer` logu cozen hicbir yol bu emitterlardan gelen bir logu KABUL
 * ETMEZ. Kume halinde duruyor cunku kontrol bir `if` degil bir uyelik
 * sorgusudur: Arc baska bir sistem emitter'i eklerse tek yer degisir.
 *
 * Adresler KUCUK HARFTIR. `eth_getLogs` adresleri kucuk harf dondurur
 * (olculdu, smoke-receipts.json'daki 38 logun hepsi) ama uyelik sorgusu bir
 * dizge esitligidir: buyuk harfli bir giris kumeyi SESSIZCE etkisiz kilardi.
 * `isForbiddenEmitter` girdiyi de kucultur, yani duvar buyuk/kucuk harften
 * bagimsizdir.
 */
export const FORBIDDEN_TRANSFER_EMITTERS: ReadonlySet<string> = new Set<string>([
  EIP7708_SYSTEM_EMITTER,
  USDC_ERC20_ADDRESS.toLowerCase(),
])

export function isForbiddenEmitter(address: string): boolean {
  return FORBIDDEN_TRANSFER_EMITTERS.has(address.toLowerCase())
}

/**
 * `eth_getLogs`'un OLCULMUS sonuc siniri (plan, Global Kisitlar):
 *   filtresiz 1.000 blok -> -32602 "query exceeds max results 20000,
 *                                   retry with the range 54325373-54326275"
 */
export const ARC_GETLOGS_MAX_RESULTS = 20_000

/**
 * `eth_getLogs`'un `address` dizisinde tek cagrida gecirilecek adres sayisi.
 * 1.000 giris KABUL EDILDI (50/500/1.000 denendi, hepsi ok); yarisinda
 * duruyoruz cunku sinir belgelenmis degil, olculmustur ve degisebilir.
 */
export const ADDRESS_FILTER_CHUNK = 500

/**
 * OLAY IMZALARI.
 *
 * Bunlar `contracts/out/**`'tan URETILMIS degil ELLE yazilmistir -- Task 1'in
 * ureticisi henuz yok. O yuzden dogrulama iki yerden gelir ve ikisi de GERCEK
 * YURUTMEDEN cikan bayta bakar:
 *
 *   1. `test/topics.test.ts` her `topic0`'i plandaki olculmus literal'e karsi
 *      tutar (`cast keccak` ciktisi, spec'ten kopyalanmadi).
 *   2. AYNI test iki yonlu olarak fixture'lara bakar: `contracts/fixtures/`
 *      icindeki her log `TOPIC0`'in bir degerini tasir, ve `TOPIC0`'in her
 *      degeri en az bir fixture logunda gorulur. Fixture'lar Foundry'nin
 *      GERCEK yurutmesinden cikti (Task 4), yani bir imza yanlis yazilirsa
 *      hesaplanan selector hicbir gercek logla ortusmez.
 *
 * Bir literal listesi (1) tek basina yeterli olmazdi: imzayi ve literal'i
 * birlikte yanlis yazmak ikisini de tutarli kilar. Fixture'lar bu yolu kapatir.
 */
export const EVENT_SIGNATURES = {
  launched: 'Launched(address,address,address,string,string,string,bytes32)',
  trade: 'Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  completed: 'Completed(address,uint256,uint256)',
  /**
   * TERMINAL DURUM. `BondingCurve.sol:283`.
   *
   * `Completed` "satis arzi bitti"dir, `Graduated` "curve artik hicbir sey
   * fiyatlamiyor"dur ve IKISI AYNI SEY DEGILDIR: canli smoke curve'u
   * `0x7938BE34...` SU AN complete AMA graduated DEGIL (uretim factory'sinde
   * `graduationTarget` sifir, `graduate()` `0xfe30fa5b` ile revert eder).
   * Aradaki fark bir kullanicinin ekraninda gorunur -- biri "havuz aciliyor",
   * oteki "curve kapandi, fiyat artik havuzda".
   *
   * BU IMZA ELLE YAZILDI AMA ELLE DOGRULANMADI: `topics.test.ts` onu
   * `packages/shared/src/abi/bondingCurve.ts`ten -- `abi-parity` CI is'inin
   * GERCEK bir `forge build` ciktisiyla IKI YONLU karsilastirdigi tek kopya --
   * yeniden turetir. Dolayisiyla buradaki bir yazim hatasi, `Launched`in
   * fixture kontrolunun yaptigi isin aynisini yapan bir kapiya carpar.
   *
   * ISIM CARPISMASI YOK, OLCULDU: Faz 2'nin havuz katmani bilerek
   * `PoolSeeded` adini tasir (`ArcpadLocker.sol:62`, gerekcesi `:58`de yazili),
   * yani bu topic0 tek bir kontrata aittir.
   */
  graduated: 'Graduated(address,address,uint256,uint256)',
  deposited: 'Deposited(address,address,uint256)',
  claimed: 'Claimed(address,uint256)',
  transfer: 'Transfer(address,address,uint256)',

  // -------------------------------------------------------------------------
  // MEZUNIYETTEN SONRAKI VENUE. Bu uc olay `PoolManager` ve `ArcpadHook`tan
  // gelir, `contracts/src/`ten DEGIL, ve imzalari
  // `pool-events.generated.ts`ten -- `contracts/out/**`in COMMIT'LENMIS
  // ozeti -- iki yonlu dogrulanir (`topics.test.ts`). `packages/shared`in
  // `abi/` kopyasina konmadilar: orada `abi-parity` TAM ABI karsilastirmasi
  // yapar ve `ARCPAD_ERROR_ABI` uzerinden frontend'in hata sozlugu buyurdu.
  // -------------------------------------------------------------------------

  /**
   * V4'un `PoolManager.Swap`i. `PoolId` bir `type ... is bytes32` oldugu icin
   * TEL UZERINDEKI tip `bytes32`tir -- `PoolId` yazmak baska bir selector
   * uretirdi ve o selector hicbir gercek logla ortusmezdi.
   *
   * `id` ve `sender` INDEKSLIDIR; miktar/fiyat/likidite alanlari DEGILDIR.
   * Bunun tasiyici sonucu sudur: hangi havuza ait oldugu SUNUCU TARAFINDA
   * suzulebilir (`topics[1]`), yani zincirdeki her havuzun `Swap`ini cekip
   * istemcide elemek ZORUNDA DEGILIZ.
   */
  poolSwap: 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
  /**
   * `PoolManager.Initialize`. Havuzun DOGUM ANI, ve turetmemizin TEK
   * bagimsiz tanigi: `currency0`/`currency1` indeksli, `fee`/`tickSpacing`/
   * `hooks` ise data'da. Turettigimiz `PoolKey`in her alani bu logdan
   * dogrulanir; turetme yanlis olsaydi tek belirti "cekiliyor ama hic
   * gelmiyor" olurdu -- bu deponun `Graduated`i escrow filtresine koymanin
   * bedeli olarak zaten adlandirdigi sessiz ariza.
   */
  poolInitialize: 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)',
  /**
   * `ArcpadHook.SwapFeeCollected`. HAVUZUN UCRETI SIFIRDIR (spec §412,
   * `GraduationMath.POOL_FEE = 0`), yani `Swap.fee` alani her zaman 0 gelir ve
   * onu ucret sanan bir okuma her havuz islemini UCRETSIZ kaydeder. Gercek
   * ucret BURADAN gelir, quote'un 6 decimal biriminde, ve `FeeEscrow`a
   * `quoteWei(...)` ile 18 decimal olarak yatirilir.
   */
  poolFee: 'SwapFeeCollected(bytes32,uint256,uint256)',

  /*
   * ---------------------------------------------------------------------
   * BUYBACK NESLI -- BES OLAY, IKI KONTRAT
   * ---------------------------------------------------------------------
   *
   * NICIN HEPSI GEREKLI. Bir kullanicinin token sayfasinda gormesi gereken
   * sey "ne kadar geri alindi ve ne kadar kilitli"dir, ve o rakam TEK bir
   * olaydan cikmaz:
   *
   *   buybackAccrued   butce BUYUR   (her islemde, egri ya da havuz)
   *   buybackExecuted  butce HARCANIR + token alinir
   *   buybackSkipped   butce CREATOR'A DONER -- harcanmadi, KAYBOLMADI da
   *   buybackLocked    alinan token kasaya girer, vesting saati baslar
   *   vestingReleased  hak edilen dagitilir (%70 creator / %30 protokol)
   *
   * `buybackSkipped` OLMADAN DEFTER KAPANMAZ: `accrued` ile `executed`
   * arasindaki fark aciklanamaz kalir ve arayuz "para nerede" sorusuna
   * cevap veremez. Uc durumun uc ayri olayi olmasi tam da bunun icin.
   *
   * `venue` INDEKSLIDIR ve tasiyicidir: ayni token icin tahakkuk hem
   * EGRIDEN hem HOOK'tan gelebilir, ve ikisi launch'in hangi asamasinda
   * oldugunu soyler -- indexer bunu bir birlestirme yapmadan okur.
   */
  /*
   * ALTINCISI PARA DEGIL KARAR TASIR -- ve tam da bu yuzden gerekli.
   *
   * Ustteki bes olay ancak buyback CALISMAYA BASLADIKTAN sonra vardir. Bir
   * kullanicinin token sayfasinda gormesi gereken ilk sey ise "bu token'da
   * buyback acik mi", ve o soru ILK TAHAKKUKTAN ONCE sorulur: ozelligi acmis
   * ama henuz islem gormemis bir token, bes olaydan hicbirini yaymamistir.
   * Onsuz ekran onu buyback'siz bir token'dan AYIRT EDEMEZ.
   *
   * Ayrica TEK YONLU DEGILDIR: creator sonradan KAPATABILIR (izin modeli
   * `BuybackPermissions.t.sol`da yuruyor), ve kapanmis bir buyback'i acik
   * gostermek, kullaniciya var olmayan bir taahhut vaat etmek olurdu.
   *
   * YAYINCI FABRIKADIR -- hazine degil. `launchWithBuyback` icinden ve
   * `setBuybackEnabled`ten yayilir, yani cekme katmaninda `Launched` ile AYNI
   * adres filtresine duser ama AYRI bir sorgudur: ikisini tek `topics`
   * filtresinde birlestirmek, izleme kumesini buyuten dongude `topics[2]`yi
   * curve saniyordu -- oysa politika olayinda o alan `by`, yani bir CUZDAN.
   */
  buybackEnabledUpdated: 'BuybackEnabledUpdated(address,address,bool)',
  buybackAccrued: 'BuybackAccrued(address,address,uint256,uint256)',
  buybackExecuted: 'BuybackExecuted(address,uint256,uint256)',
  buybackSkipped: 'BuybackSkipped(address,uint256,string)',
  buybackLocked: 'BuybackLocked(address,uint256,uint256,uint256,uint256)',
  vestingReleased: 'VestingReleased(address,address,uint256,uint256)',
} as const

export type EventKind = keyof typeof EVENT_SIGNATURES

export const TOPIC0: Readonly<Record<EventKind, Hex>> = Object.freeze(
  Object.fromEntries(
    Object.entries(EVENT_SIGNATURES).map(([kind, sig]) => [kind, toEventSelector(sig)]),
  ) as Record<EventKind, Hex>,
)

/** `topic0` -> olay adi. Cozucu secimi bir arama, bir `if` zinciri degildir. */
export const KIND_BY_TOPIC0: ReadonlyMap<Hex, EventKind> = new Map(
  (Object.entries(TOPIC0) as [EventKind, Hex][]).map(([kind, topic]) => [topic, kind]),
)

/** Sifir adres. `Transfer`'in mint bacagi bunu `from` olarak tasir. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
