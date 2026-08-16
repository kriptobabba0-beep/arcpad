import { ARCPAD_ACTIONS, type ArcpadAction, type FailureKey } from '@/lib/failureTable'

/**
 * ULASILABILIR HATA YUZEYI -- OTORITE.
 *
 * `FAILURE_TABLE` bir SOZLUKTUR: bir hucreye metin verir. Bu dosya ise
 * hucrelerin KENDISININ var olup olmadigina karar verir, ve karari
 * kontratlarin kaynagindan turer: bir giris noktasinin cagri yolu boyunca
 * gecen fonksiyonlarin `revert` yerlerinin birlesimi.
 *
 * NEDEN AYRI BIR OTORITE GEREKIYOR. Tablonun kapisi tek yonluydu -- "ABI
 * icindeki her hata ya tabloda ya ulasilamaz listesinde" -- ve o kapi TERS
 * yonu hic gormuyor: tabloda duran ama o giris noktasinin KODUNDA hic
 * bulunmayan bir satiri kiran bir sey yoktu. Olculdu: 18 hucre boyleydi
 * (12si `launch` altinda, hepsi factory constructor icinde duran ve deploy
 * edilmis bir factory uzerinden `launch` cagrisinin ASLA donduremeyecegi
 * hatalar), ve ayni anda `ZeroRecipient` ucret yatirma yolunda CANLIYKEN uc
 * ticaret eyleminin hicbirinde yoktu. Olu satirlar tabloyu tam gosterir,
 * eksik satir ise kullaniciya "bilinmeyen hata" yazdirir.
 *
 * TURETME TAUTOLOJI DEGILDIR: `test/errors/reconcile.test.ts` bu dosyayi
 * kontratlarin `.sol` kaynagini TARAYARAK yeniden uretir ve iki yonlu
 * karsilastirir. Buradaki her `at` alani, o fonksiyonun govdesinde gercekten
 * `revert <ad>()` yazdigi icin dogrulanir; uydurma bir alinti kirmizi olur.
 */

/**
 * `user`     -- arayuzu normal kullanan biri bunu alabilir (yaris, slipaj,
 *               kontrat cuzdan). Task 5 sayaclari bunlari YURUR.
 * `guarded`  -- kod yolu canli ama istemci girdiyi engelliyor; simulasyon ya
 *               da elle kurulmus bir cagri yine ulasir.
 * `operator` -- yalnizca YANLIS KURULMUS bir deployment uretir. Kullanicinin
 *               yapabilecegi bir sey yok, ama sessiz de kalmamali.
 */
export type ErrorReach = 'user' | 'guarded' | 'operator'

export type SurfaceCell = {
  readonly reach: ErrorReach
  /**
   * `revert` ifadesinin gercekten yazili oldugu Solidity fonksiyonlari,
   * `Birim.fonksiyon` biciminde. Kapi bunlari kaynaktan DOGRULAR.
   *
   * Bir adin ayni eylemde birden fazla atis yeri olabilir ve bu bir ayrinti
   * degil: `NetTooSmall` bu giris noktasindan IKI ayri `CurveMath`
   * fonksiyonundan cikar (`gross = 2` icin `correctedNetQuoteIn`, `gross`
   * degeri 1 ya da 3 icin `quoteBuyTokensOut`; `gross = 4` gecer). Metin
   * aynidir, sayac ikisini ayri yurur.
   */
  readonly at: readonly string[]
  /** Bu sinifa neden konuldugu. Yorum degil, kapinin okudugu alan. */
  readonly why: string
}

type Surface = Readonly<Record<string, SurfaceCell>>

const cell = (reach: ErrorReach, at: readonly string[], why: string): SurfaceCell => ({
  reach,
  at,
  why,
})

/**
 * Her eylemin cagri yolu: giris noktasindan baslayip revert uretebilecek her
 * fonksiyonu iceren sirali liste. Kapi bunu iki sekilde kullanir --
 * (1) yol uzerindeki `revert` adlarinin birlesimini turetir, (2) her `at`
 * alaninin bu listede bulunmasini ister, yani "yuzeye yazayim da gecsin"
 * mumkun degil.
 *
 * `ERC20.*` OpenZeppelin kaynagidir (`contracts/lib/openzeppelin-contracts`).
 * Disarida birakmak, satisin en olasi gercek hatasini
 * (`ERC20InsufficientAllowance`) turetmenin disinda birakirdi.
 */
export const CALL_PATH: Readonly<Record<ArcpadAction, readonly string[]>> = {
  launch: [
    // GIRIS `launchWithBuyback`TIR, `launch` DEGIL -- VE BU BILINCLI.
    //
    // Create formu kutu isaretliyse `launchWithBuyback`, degilse `launch`
    // cagirir; ikisi de AYNI `_launch` govdesine duser. Yol, eylemin
    // ULASABILECEGI EN GENIS yuzeyi tarif etmelidir, dar olani degil: dar
    // olani secmek `BuybackUnavailable`i turetilen kumeden dislar ve o hata
    // -- kutu isaretliyken hazine bagli degilse -- kullanicinin GORECEGI
    // seydir.
    //
    // Ters secim SESSIZ OLURDU: `launch` girisiyle yazilan bir yol da yesil
    // kalir, cunku `_launch` yine yoldadir ve oteki adlarin hepsi turetilir.
    // Yalnizca `BuybackUnavailable` eksik kalirdi ve kullanici "bilinmeyen
    // hata" gorurdu.
    'LaunchFactory.launchWithBuyback',
    // ORTAK GOVDE. Iki giris de buraya duser; `EmptyName`/`EmptySymbol` ve
    // `BuybackUnavailable` burada revert eder, `BondingCurve`i de bu insa
    // eder -- yani hem `at` alintilarinin hem `new` hop'unun dayanagi.
    'LaunchFactory._launch',
    'BondingCurve.constructor',
    'CurveMath.poolSeedSupply',
    'LaunchToken.constructor',
    'ERC20._mint',
    'ERC20._update',
    'BondingCurve.bind',
  ],
  approve: ['ERC20.approve', 'ERC20._approve'],
  buyExactQuoteIn: [
    'BondingCurve.buyExactQuoteIn',
    'CurveMath.correctedNetQuoteIn',
    'CurveMath.netQuoteInBeforeCorrection',
    'CurveMath.feeOn',
    'CurveMath.quoteBuyTokensOut',
    'CurveMath.quoteBuyCost',
    'BondingCurve._settleBuy',
    'ERC20.transfer',
    'ERC20._transfer',
    'ERC20._update',
    'FeeEscrow.deposit',
  ],
  buyExactTokensOut: [
    'BondingCurve.buyExactTokensOut',
    'CurveMath.quoteBuyCost',
    'CurveMath.feeOn',
    'BondingCurve._settleBuy',
    'ERC20.transfer',
    'ERC20._transfer',
    'ERC20._update',
    'FeeEscrow.deposit',
  ],
  sellExactTokensIn: [
    'BondingCurve.sellExactTokensIn',
    'CurveMath.quoteSellProceeds',
    'CurveMath.feeOn',
    'ERC20.transferFrom',
    'ERC20._spendAllowance',
    'ERC20._transfer',
    'ERC20._update',
    'FeeEscrow.deposit',
  ],
  claim: ['FeeEscrow.claim'],
}

/** Cagri yolundaki birimlerin kaynak dosyalari. Kapi bunlari okur. */
export const SOURCE_UNITS: Readonly<Record<string, string>> = {
  BondingCurve: 'contracts/src/BondingCurve.sol',
  LaunchFactory: 'contracts/src/LaunchFactory.sol',
  LaunchToken: 'contracts/src/LaunchToken.sol',
  FeeEscrow: 'contracts/src/FeeEscrow.sol',
  CurveMath: 'contracts/src/libraries/CurveMath.sol',
  ERC20: 'contracts/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol',
}

/**
 * Yolda `revert` yeri VAR ama ayni yolda DAHA ONCE donen bir koruma yuzunden
 * ulasilamayan adlar. Her biri gerekcesiyle YAZILI durur, cunku bir istisnayi
 * yazmadan cikarmak tam olarak olu satirlarin olusma bicimidir.
 *
 * Kapi bunlari da denetler: burada duran bir ad TURETILEN kumede yoksa
 * (kontrat degismis, `revert` kalkmis) test kirmizi olur -- bayat bir istisna
 * da bir yalandir.
 */
export const SHADOWED_BY_GUARD: Readonly<Record<ArcpadAction, Readonly<Record<string, string>>>> = {
  launch: {
    ERC20InvalidReceiver:
      'mint alicisi curve; bir satir once `ZeroCurve()` ile sifir olmadigi kontrol edildi',
    ERC20InsufficientBalance:
      '`_update` bakiye kontrolunu yalnizca gonderen sifir DEGILKEN yapar; bu yoldaki tek `_update` bir mint',
  },
  approve: {
    ERC20InvalidApprover: 'onaylayan `msg.sender`; imzalanmis bir islemin gondericisi sifir olamaz',
  },
  buyExactQuoteIn: {
    ERC20InvalidSender: 'gonderen `address(this)`, yani cagrilan curve kontratinin kendisi',
    ERC20InvalidReceiver: 'alici `msg.sender`; imzalanmis bir islemin gondericisi sifir olamaz',
    ERC20InsufficientBalance:
      'curve satis arzini bind sirasinda tutar (`TokenBalanceBelowSaleAndSeed`) ve alim `realTokenReserves` degerini asamaz',
  },
  buyExactTokensOut: {
    ERC20InvalidSender: 'gonderen `address(this)`, yani cagrilan curve kontratinin kendisi',
    ERC20InvalidReceiver: 'alici `msg.sender`; imzalanmis bir islemin gondericisi sifir olamaz',
    ERC20InsufficientBalance:
      'curve satis arzini bind sirasinda tutar ve `NotEnoughTokensToBuy` rezervin ustunu zaten reddeder',
  },
  sellExactTokensIn: {
    ERC20InvalidSender: 'gonderen `msg.sender`; imzalanmis bir islemin gondericisi sifir olamaz',
    ERC20InvalidReceiver: 'alici `address(this)`, yani cagrilan curve kontratinin kendisi',
  },
  claim: {},
}

/**
 * HER EYLEM x ULASILABILIR HATA. Anahtarin ikinci yarisi ad, birincisi eylem.
 * Selector KATMANI SOYLEMEZ (`CurveMath.ZeroAmount()` ile
 * `FeeEscrow.ZeroAmount()` ayni `0x1f2a2005` dort baytini tasir), o yuzden
 * katman buradan gelir.
 */
export const ERROR_SURFACE: Readonly<Record<ArcpadAction, Surface>> = {
  // ---- launch -------------------------------------------------------------
  // Kullanici sinifinda TEK BIR ad yok: adlandirilmis her revert ya istemcinin
  // engelledigi bir girdi ya da bir kurulum hatasi. Bu eylemin kullaniciya
  // gorunen tek gercek basarisizligi VERI TASIMAYAN revert olur (`payable`
  // olmayan `launch` cagrisina deger, CREATE2 carpismasi, gas tukenmesi) ve
  // onun bir selector'u -- dolayisiyla bir hucresi -- yoktur; cozucunun
  // `EmptyRevert` dali onu tasir ve TAHMIN ETMEZ.
  launch: {
    /// Kutu ISARETLIYKEN ve hazine HENUZ BAGLI DEGILKEN kullanicinin gordugu
    /// sey. `guarded` DEGILDIR: form bunu engelleyemez, cunku hazinenin bagli
    /// olup olmadigi zincir durumudur -- simulasyon gorur, form goremez.
    BuybackUnavailable: cell(
      'user',
      ['LaunchFactory._launch'],
      'buyback kutusu isaretli ama fabrikada hazine bagli degil; kutu kaldirilinca launch gecer',
    ),
    EmptyName: cell(
      'guarded',
      ['LaunchFactory._launch'],
      'form bos ada izin vermez; simulasyon gorur',
    ),
    EmptySymbol: cell(
      'guarded',
      ['LaunchFactory._launch'],
      'form bos sembole izin vermez; simulasyon gorur',
    ),
    NameTooLong: cell('guarded', ['LaunchToken.constructor'], 'bayt sayaci 32 baytta durdurur'),
    SymbolTooLong: cell('guarded', ['LaunchToken.constructor'], 'bayt sayaci 13 baytta durdurur'),
    UriTooLong: cell('guarded', ['LaunchToken.constructor'], 'bayt sayaci 200 baytta durdurur'),
    ZeroEscrow: cell('operator', ['BondingCurve.constructor'], 'escrow adresini factory gecirir'),
    ZeroVirtualTokenReserves: cell(
      'operator',
      ['BondingCurve.constructor'],
      'profil sabitlerini factory gecirir',
    ),
    ZeroVirtualQuoteReserves: cell(
      'operator',
      ['BondingCurve.constructor'],
      'profil sabitlerini factory gecirir',
    ),
    ZeroSaleSupply: cell(
      'operator',
      ['BondingCurve.constructor'],
      'profil sabitlerini factory gecirir',
    ),
    SaleSupplyNotBelowTokenReserves: cell(
      'operator',
      ['BondingCurve.constructor'],
      'S < T tasiyici esitsizligi; factory constructor onu `DegenerateProfile` ile zaten korur',
    ),
    NotFactory: cell('operator', ['BondingCurve.bind'], 'bind cagrisini factory kendisi yapar'),
    AlreadyBound: cell('operator', ['BondingCurve.bind'], 'curve ayni islemde yeni dogdu'),
    ZeroToken: cell('operator', ['BondingCurve.bind'], 'token ayni islemde deploy edildi'),
    TokenDoesNotPointBack: cell(
      'operator',
      ['BondingCurve.bind'],
      'iki CREATE2 adresi ayni salt ile turetilir',
    ),
    TokenBalanceBelowSaleAndSeed: cell(
      'operator',
      ['BondingCurve.bind'],
      'token tum arzi curve adresine basar',
    ),
  },

  // ---- approve ------------------------------------------------------------
  // OZ `approve` BUNDAN BASKA hicbir sekilde revert etmez. Kisa liste dogru
  // listedir: onay basarisizliklari kontrat DISIDIR (kullanici reddi, fon, ag)
  // ve cozucunun o dallarina duser.
  approve: {
    ERC20InvalidSpender: cell(
      'operator',
      ['ERC20._approve'],
      'harcayan, okuma modelinden gelen curve adresi; sifirsa arayuz bozuk demektir',
    ),
  },

  // ---- buyExactQuoteIn ----------------------------------------------------
  buyExactQuoteIn: {
    CurveComplete: cell(
      'user',
      ['BondingCurve.buyExactQuoteIn'],
      'YARISLA: kullanici imzalarken curve tukenebilir',
    ),
    ZeroQuoteIn: cell('guarded', ['BondingCurve.buyExactQuoteIn'], 'bos girdi engelli'),
    NetTooSmall: cell(
      'guarded',
      ['CurveMath.correctedNetQuoteIn', 'CurveMath.quoteBuyTokensOut'],
      'kuantalama: arayuz kuantumu 1e12, sinir ise `gross <= 3`',
    ),
    SlippageExceeded: cell(
      'user',
      ['BondingCurve.buyExactQuoteIn'],
      'fiyat, kotasyon ile madencilik arasinda hareket eder',
    ),
    RefundFailed: cell(
      'user',
      ['BondingCurve._settleBuy'],
      'kontrat cuzdan ya da bloklanmis adres iadeyi alamaz',
    ),
    NotBound: cell('operator', ['BondingCurve.buyExactQuoteIn'], 'launch atomiktir'),
    ZeroReserve: cell(
      'operator',
      ['CurveMath.quoteBuyTokensOut', 'CurveMath.quoteBuyCost'],
      'rezervler curve constructor icinde sifirsuz dogrulanir',
    ),
    InvalidBps: cell(
      'operator',
      ['CurveMath.feeOn', 'CurveMath.netQuoteInBeforeCorrection'],
      'ucret oranlari immutable sabitler',
    ),
    ZeroAmount: cell(
      'operator',
      ['FeeEscrow.deposit'],
      'canli atis yeri ESCROW; `CurveMath` icindeki ayni adi `ZeroQuoteIn` oldurur. Ayni selector, farkli katman',
    ),
    ZeroRecipient: cell(
      'operator',
      ['FeeEscrow.deposit'],
      '`protocolTreasury()` factory uzerinden CANLI okunur; bir rotasyon onu sifira alirsa her alim burada doner',
    ),
  },

  // ---- buyExactTokensOut --------------------------------------------------
  buyExactTokensOut: {
    CurveComplete: cell(
      'user',
      ['BondingCurve.buyExactTokensOut'],
      'YARISLA: kullanici imzalarken curve tukenebilir',
    ),
    ZeroTokensOut: cell('guarded', ['BondingCurve.buyExactTokensOut'], 'bos girdi engelli'),
    NotEnoughTokensToBuy: cell(
      'user',
      ['BondingCurve.buyExactTokensOut'],
      'BU GIRIS NOKTASINA OZGU: kismi doldurma yok, sinirda revert eder',
    ),
    SlippageExceeded: cell(
      'user',
      ['BondingCurve.buyExactTokensOut'],
      'IKI SEBEP: `total > maxQuoteIn` ve `total > msg.value`. Tek selector',
    ),
    RefundFailed: cell(
      'user',
      ['BondingCurve._settleBuy'],
      'kontrat cuzdan ya da bloklanmis adres iadeyi alamaz',
    ),
    NotBound: cell('operator', ['BondingCurve.buyExactTokensOut'], 'launch atomiktir'),
    ZeroReserve: cell(
      'operator',
      ['CurveMath.quoteBuyCost'],
      'rezervler curve constructor icinde sifirsuz dogrulanir',
    ),
    InvalidBps: cell('operator', ['CurveMath.feeOn'], 'ucret oranlari immutable sabitler'),
    ZeroAmount: cell(
      'operator',
      ['FeeEscrow.deposit'],
      'canli atis yeri ESCROW; `CurveMath` icindeki ayni adi `ZeroTokensOut` oldurur',
    ),
    ZeroRecipient: cell(
      'operator',
      ['FeeEscrow.deposit'],
      '`protocolTreasury()` factory uzerinden CANLI okunur',
    ),
  },

  // ---- sellExactTokensIn --------------------------------------------------
  sellExactTokensIn: {
    CurveComplete: cell(
      'user',
      ['BondingCurve.sellExactTokensIn'],
      'YARISLA: tamamlanan bir curve satisi da kapatir',
    ),
    ZeroTokensIn: cell('guarded', ['BondingCurve.sellExactTokensIn'], 'bos girdi engelli'),
    ProceedsTooSmall: cell(
      'guarded',
      ['BondingCurve.sellExactTokensIn'],
      'olculdu (1 USDC alim sonrasi durumda): son reddedilen 495_643_839, ilk kabul edilen 495_643_840; arayuz kuantumu 1e12, uc buyukluk mertebesi ustunde',
    ),
    SlippageExceeded: cell(
      'user',
      ['BondingCurve.sellExactTokensIn'],
      'fiyat, kotasyon ile madencilik arasinda hareket eder',
    ),
    PayoutFailed: cell(
      'user',
      ['BondingCurve.sellExactTokensIn'],
      'kontrat cuzdan ya da bloklanmis adres odemeyi alamaz',
    ),
    ERC20InsufficientAllowance: cell(
      'user',
      ['ERC20._spendAllowance'],
      'EN OLASI GERCEK HATA: satis `transferFrom` ile calisir, once onay gerekir',
    ),
    ERC20InsufficientBalance: cell(
      'user',
      ['ERC20._update'],
      'satici elindekinden fazlasini satmaya calisabilir',
    ),
    NotBound: cell('operator', ['BondingCurve.sellExactTokensIn'], 'launch atomiktir'),
    ZeroReserve: cell(
      'operator',
      ['CurveMath.quoteSellProceeds'],
      'rezervler curve constructor icinde sifirsuz dogrulanir',
    ),
    InvalidBps: cell('operator', ['CurveMath.feeOn'], 'ucret oranlari immutable sabitler'),
    ZeroAmount: cell(
      'operator',
      ['FeeEscrow.deposit'],
      'canli atis yeri ESCROW; `CurveMath` icindeki ayni adi `ZeroTokensIn` oldurur',
    ),
    ZeroRecipient: cell(
      'operator',
      ['FeeEscrow.deposit'],
      '`protocolTreasury()` factory uzerinden CANLI okunur',
    ),
  },

  // ---- claim --------------------------------------------------------------
  claim: {
    NothingToClaim: cell('user', ['FeeEscrow.claim'], 'iki kez cekmek ya da hic ucret olmamasi'),
    TransferFailed: cell(
      'user',
      ['FeeEscrow.claim'],
      'alici bir kontrat cuzdansa native transfer basarisiz olabilir',
    ),
  },
}

/**
 * Brief ile ayni ad: `REACHABLE_BY_ACTION`. `operator` sinifi DISARIDA -- bir
 * fark testinin sayaci yalnizca DOGRU KURULMUS bir zincirde yurutulebilen
 * hatalari yuruyebilir, ve "ulasilabilir dedigimiz ama hic yurumeyen" bir
 * satir tam olarak rapora yazilmasi gereken seydir.
 */
export const REACHABLE_BY_ACTION: Readonly<Record<ArcpadAction, readonly string[]>> =
  Object.fromEntries(
    ARCPAD_ACTIONS.map((action): [ArcpadAction, readonly string[]] => [
      action,
      Object.entries(ERROR_SURFACE[action])
        .filter(([, spec]) => spec.reach !== 'operator')
        .map(([name]) => name)
        .sort(),
    ]),
  ) as Record<ArcpadAction, readonly string[]>

/** Yuzeydeki TUM adlar (operator dahil). Iki boyutlu tamlik kapisi bunu yurur. */
export function surfaceNamesOf(action: ArcpadAction): readonly string[] {
  return Object.keys(ERROR_SURFACE[action]).sort()
}

/** Yuzeyin `(eylem, ad)` anahtarlari -- `FAILURE_TABLE` ile ayni bicim. */
export function surfaceKeys(): readonly FailureKey[] {
  return ARCPAD_ACTIONS.flatMap((action) =>
    surfaceNamesOf(action).map((name): FailureKey => `${action}:${name}`),
  )
}

export function surfaceCell(action: ArcpadAction, name: string): SurfaceCell | undefined {
  return ERROR_SURFACE[action][name]
}

// ---------------------------------------------------------------------------
// `web/lib/failureTable.ts` DOSYASINA UYGULANACAK DUZELTME -- VERI OLARAK
// ---------------------------------------------------------------------------

export type TableFix = { readonly key: FailureKey; readonly why: string }

/**
 * NEDEN BU DEFTER VAR. Bu paket `web/lib/` altina yazamaz (orasi baska bir
 * izin sahibinin), ama farki SESSIZ birakmak da olmaz. Defter farki VERI
 * yapar: kapi "tablo ile otorite arasindaki her fark burada YAZILI olmali"
 * der. Bugun yesildir; duzeltme uygulandiktan sonra da yesil kalir (olmayan
 * bir anahtari silmek etkisizdir, var olan bir anahtari eklemek de). Ama YENI
 * ve yazilmamis bir fark cikar cikmaz kirmizi olur.
 *
 * Defter bir siginak DEGILDIR: kapi her `remove` girdisinin otoritede
 * OLMADIGINI ve her `add` girdisinin otoritede OLDUGUNU ayrica dogrular. Yani
 * canli bir hucreyi buraya yazip gizlemek mumkun degil.
 */
export const TABLE_FIX_REMOVE: readonly TableFix[] = [
  // Asagidaki 12 satirin hepsi `LaunchFactory` CONSTRUCTOR icinde duruyor.
  // Deploy edilmis bir factory uzerinden yapilan `launch` cagrisi bunlarin
  // hicbirini donduremez -- deploy ya basarili olmustur ya da factory yoktur.
  { key: 'launch:DegenerateProfile', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:EscrowHasNoCode', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:EscrowIsNotAFeeEscrow', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:GovernorIsTheEscrow', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:TreasuryIsTheEscrow', why: 'LaunchFactory constructor + governance setter' },
  { key: 'launch:ZeroEscrowAddress', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:ZeroGovernorAddress', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:ZeroTreasuryAddress', why: 'LaunchFactory constructor + governance setter' },
  { key: 'launch:GraduationRaiseTooSmall', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:SaleAndSeedExceedSupply', why: 'LaunchFactory constructor, launch degil' },
  { key: 'launch:SaleAndSeedStrandSupply', why: 'LaunchFactory constructor, launch degil' },
  {
    key: 'launch:ZeroReserve',
    why: 'launch yolundaki tek CurveMath cagrisi `poolSeedSupply` ve o yalnizca `InsufficientTokenReserve` atar',
  },
  {
    key: 'approve:ERC20InvalidApprover',
    why: 'onaylayan `msg.sender`; imzalanmis bir islemin gondericisi sifir olamaz',
  },
  {
    key: 'buyExactQuoteIn:PayoutFailed',
    why: '`PayoutFailed` YALNIZCA `sellExactTokensIn` icinde; alim yolunun karsiligi `RefundFailed`',
  },
  {
    key: 'buyExactTokensOut:PayoutFailed',
    why: '`PayoutFailed` YALNIZCA `sellExactTokensIn` icinde; alim yolunun karsiligi `RefundFailed`',
  },
  {
    key: 'sellExactTokensIn:ERC20InvalidSender',
    why: 'gonderen `msg.sender`; imzalanmis bir islemin gondericisi sifir olamaz',
  },
  {
    key: 'sellExactTokensIn:ERC20InvalidReceiver',
    why: 'alici `address(this)`, yani cagrilan curve',
  },
  {
    key: 'claim:ZeroRecipient',
    why: 'claim sifir adresi reddetmez; `owed[0] == 0` oldugu icin `NothingToClaim` doner',
  },
]

export const TABLE_FIX_ADD: readonly TableFix[] = [
  {
    key: 'buyExactQuoteIn:ZeroRecipient',
    why: '`_settleBuy` -> `FeeEscrow.deposit(protocolTreasury())`; treasury factory uzerinden CANLI okunur',
  },
  {
    key: 'buyExactTokensOut:ZeroRecipient',
    why: '`_settleBuy` -> `FeeEscrow.deposit(protocolTreasury())`; treasury factory uzerinden CANLI okunur',
  },
  { key: 'sellExactTokensIn:ZeroRecipient', why: 'satis yolu da ayni yatirimi yapar' },
]

/**
 * Defter uygulandiktan sonra HICBIR hucresi kalmayacak adlar. Bunlarin
 * `UNREACHABLE_BY_CONSTRUCTION` listesine tasinmasi ZORUNLUDUR, yoksa Task 3
 * ABI tamlik kapisi ("her hata ya tabloda ya listede") kirilir. Duzeltmenin
 * UYGULANABILIR oldugunu kapi bu liste uzerinden ispatlar.
 */
export const TABLE_FIX_UNREACHABLE: readonly string[] = [
  'DegenerateProfile',
  'EscrowHasNoCode',
  'EscrowIsNotAFeeEscrow',
  'GovernorIsTheEscrow',
  'TreasuryIsTheEscrow',
  'ZeroEscrowAddress',
  'ZeroGovernorAddress',
  'ZeroTreasuryAddress',
  'GraduationRaiseTooSmall',
  'SaleAndSeedExceedSupply',
  'SaleAndSeedStrandSupply',
  'ERC20InvalidApprover',
  'ERC20InvalidSender',
  'ERC20InvalidReceiver',
]
