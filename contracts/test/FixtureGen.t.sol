// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BuybackTreasury} from "../src/BuybackTreasury.sol";
import {BuybackVestingVault} from "../src/BuybackVestingVault.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

/// SAHTE TOKEN. `LaunchToken`'in alan alan kopyasi ARTI bir `mint()` yolu.
/// Fazladan uye tam olarak bunun icin var: creationCode'u degistirir,
/// dolayisiyla `LaunchFactory.isCanonical`'in CREATE2 turetmesi -- ayni salt,
/// ayni deployer, ayni constructor argumanlari verilse bile -- TUTMAZ. Sahte
/// olusun diye alan uydurmak yerine gercek bir sapma kullaniliyor: Faz 2/3'un
/// korkmasi gereken sey "eksik alanli" bir token degil, FAZLADAN YETKI tasiyan
/// bir token'dir.
contract RogueToken is ERC20 {
    address public immutable creator;
    address public immutable curve;
    string public metadataURI;
    bytes32 public immutable launchSalt;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        address curve_,
        bytes32 launchSalt_
    ) ERC20(name_, symbol_) {
        creator = creator_;
        curve = curve_;
        metadataURI = metadataURI_;
        launchSalt = launchSalt_;
        _mint(curve_, 1_000_000_000e18);
    }

    /// GERCEK `LaunchToken`DA BOYLE BIR YOL YOKTUR.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// SAHTE FACTORY. `Launched` olayini BIRE BIR ayni imzayla yayar, yani topic0
/// gercegiyle AYNIDIR ve topic'e bakan hicbir filtre ikisini ayiramaz. Ayirt
/// eden tek sey emitter adresi ve CREATE2 turetmesidir; `forged.json`'in
/// varlik sebebi budur.
///
/// @dev Ureten curve GERCEK `BondingCurve`dir (constructor'i herkese aciktir),
///      yani sahtecilik "tutarli": curve token'i geri isaret eder, arzin
///      tamami curve'dedir ve curve fiilen ticaret yapabilir. Bu yuzden iki
///      `ILaunchFactory` uyesi de burada tasinir.
contract RogueFactory {
    event Launched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        string uri,
        bytes32 salt
    );

    address public immutable escrow;
    address public protocolTreasury;
    address public graduationTarget;

    uint256 internal immutable T;
    uint256 internal immutable V;
    uint256 internal immutable S;

    constructor(address escrow_, address treasury_, uint256 t_, uint256 v_, uint256 s_) {
        escrow = escrow_;
        protocolTreasury = treasury_;
        T = t_;
        V = v_;
        S = s_;
    }

    function launch(string memory name_, string memory symbol_, string memory uri_, address creator_, bytes32 salt_)
        external
        returns (address token, address curve)
    {
        curve = address(new BondingCurve{salt: salt_}(creator_, escrow, T, V, S));
        token = address(new RogueToken{salt: salt_}(name_, symbol_, uri_, creator_, curve, salt_));
        emit Launched(token, curve, creator_, name_, symbol_, uri_, salt_);
        BondingCurve(curve).bind(token);
    }
}

/// @title FixtureGenTest
/// @notice Faz 3'un indexer'inin test edilecegi olay yuklerini GERCEK
///         YURUTMEDEN uretir. Hicbir log elle yazilmaz: her fixture
///         `vm.recordLogs()` -> gercek cagri -> `vm.getRecordedLogs()`
///         zincirinin ciktisidir ve kontrat kaynagina HIC dokunulmaz.
///
/// @dev NICIN ELLE YAZILAN YUK YASAK -- BU DEPODA OLCULMUS BIR HATA. Adres
///      defteri ureticisinin sentetik fixture'i forge'un broadcast dosyasini
///      `transactionType: "CALL"` + dolu `additionalContracts` diye
///      modelliyordu; forge gercekte `"CREATE2"` yaziyor, adresi
///      `transactions[].contractAddress`a koyuyor ve `additionalContracts`i
///      BOS birakiyor. Fixture gercekten COMERTTI ve hatayi ancak ilk gercek
///      makbuz gosterdi. Ayni sinif olay yuklerinde daha da sinsidir: sapan
///      bir yuk testi yesil BIRAKIR.
///
/// @dev DRIFT KAPISI BU DOSYANIN TEK GERCEK IDDIASIDIR. `make fixtures`
///      dosyalari yeniden uretir; CI ardindan `git diff --exit-code --
///      contracts/fixtures` kosar. Kontratlarin olay SEKLI ya da DEGERLERI
///      degisirse fixture'lar degisir, diff kirlenir, CI kirilir. "Fixture
///      kontrattan sapamaz" iddiasinin calistirilabilir hali budur; baska
///      hicbir sey onu tasimaz.
///
/// @dev ============================================================
///      OLCULMUS ACIK HUCRE -- BU FIXTURE'LAR ARC'IN LOG AKISININ TAMAMI
///      DEGILDIR. Foundry/anvil standart EVM kosar; Arc kosmaz. Arc'ta
///      EIP-7708 geregi HER native USDC hareketi ek bir ERC-20 `Transfer`
///      logu yayar. Canli smoke makbuzlarindan OLCULDU (asagidaki tx'ler,
///      `eth_getTransactionReceipt`, 2026-08-01):
///
///        sistem emitter = 0xfffffffffffffffffffffffffffffffffffffffe  (18 decimal)
///
///      Bir ALIM Arc'ta 7 log uretir, burada 4:
///        li+0  7708  alici -> curve      (msg.value)      <-- BURADA YOK
///        li+1  Trade (curve)
///        li+2  Transfer (token, curve -> alici)
///        li+3  7708  curve -> escrow     (protocolFee)    <-- BURADA YOK
///        li+4  Deposited (escrow)
///        li+5  7708  curve -> escrow     (creatorFee)     <-- BURADA YOK
///        li+6  Deposited (escrow)
///      Bir SATIS Arc'ta 7 log uretir, burada 4 (bastaki 7708 yoktur, sondaki
///      odeme 7708'i vardir). LAUNCH'ta fark YOKTUR: deger hareketi olmadigi
///      icin Arc da tam olarak 2 log uretir (olculdu).
///
///      SONUC, ACIKCA: `logIndex`ler BITISIK DEGILDIR ve "Trade'den sonraki
///      log token Transfer'idir" turunden bir varsayim Arc'ta YANLISTIR.
///      Fixture'lar bunu YEREL olarak kapatamaz; kapatilacagi yer canli
///      makbuzlardir. `contracts/fixtures/arc-live/smoke-receipts.json`
///      canli akisi aynen tasir ve `fixtures/*.json` glob'una GIRMEZ.
///      ============================================================
///
/// @dev BLOK BAGLAMI PINLENIR (`vm.roll`/`vm.warp`), foundry varsayilanina
///      birakilmaz: aksi halde araci yukseltmek fixture'lari kirletir ve drift
///      kapisi kontrat degisikligi degil toolchain degisikligi olcerdi.
///      DEGERLER TASIYICI DEGILDIR ve senaryolar arasi bir SIRA IMA ETMEZ --
///      her senaryo bagimsiz bir dunyadir. `chainId` bilerek 31337 olarak
///      yaziliyor (Arc 5042002'dir): fixture'in YEREL uretim oldugu dosyanin
///      kendisinden okunabilmelidir.
///
/// @dev `logIndex` `vm.getRecordedLogs()`ta YOKTUR; sirayi biz veriyoruz ve
///      bunun BIR VARSAYIM oldugu burada yaziliyor: gercek zincirde `logIndex`
///      BLOK kapsamlidir (canli smoke'ta 78..84), testte ise tx kapsamli bir
///      sayaca (0..n) dusuyor. Indexer bu farka duyarli DEGILDIR (event_seq'i
///      gercek log'dan kurar), ama fixture'lardaki MUTLAK degerler gercek
///      zincirdekilerle AYNI OLMAZ.
contract FixtureGenTest is Test {
    /// Faz 2: factory'nin yedinci constructor argumani. KODU OLMALI.
    FeeSchedule internal FEE_SCHEDULE;

    // -----------------------------------------------------------------
    // Profil -- TESTNET, ve bu secim tasiyicidir
    // -----------------------------------------------------------------
    //
    // Canli deploy testnet profilini kullanir; `vT - rT == T - S` ve
    // `vQ - rQ == V` ozdeslikleri bes canli smoke durumunda bu SAYILARLA
    // dogrulandi. Uretim profili (`V = 4_292e18`) ile uretilen bir fixture
    // ikinci ozdesligi baska bir sabitle saglar ve canli zincirle
    // karsilastirilamaz hale gelirdi.
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e15;
    uint256 internal constant S = 793_100_000e18;

    uint256 internal constant PROTOCOL_BPS = 95;
    uint256 internal constant CREATOR_BPS = 30;

    address internal constant CREATOR = address(0xC7EA);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant GOVERNOR = address(0x60F);
    address internal constant TRADER = address(0xB0B);

    uint256 internal constant FIXTURE_BLOCK = 1;
    uint256 internal constant FIXTURE_TIMESTAMP = 1;

    /// Arc'in EIP-7708 sistem emitter'i, CANLI MAKBUZDAN OKUNDU (2026-08-01).
    /// Bu depoda tasinan onceki varsayim `0x3600...0000` (6 decimal USDC
    /// ERC-20'si) idi; native hareketlerin logu ORADAN DEGIL buradan geliyor
    /// ve 18 deciamldir. Fark tasiyicidir: `0x3600...`a gore yazilmis bir
    /// filtre HICBIR native hareketi gormez.
    string internal constant ARC_NATIVE_TRANSFER_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";

    string internal constant ARC_LIVE_CAPTURE = "./fixtures/arc-live/smoke-receipts.json";

    // Olay kimlikleri. `keccak256(imza)` ile burada yeniden turetilir ve
    // CANLI ZINCIRDEN OKUNAN topic0'larla karsilastirilir; ikincisi olmadan
    // bu satirlar kendi kendini dogrulayan bir totoloji olurdu.
    bytes32 internal constant TRADE_TOPIC0 =
        keccak256("Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)");
    bytes32 internal constant COMPLETED_TOPIC0 = keccak256("Completed(address,uint256,uint256)");
    bytes32 internal constant LAUNCHED_TOPIC0 =
        keccak256("Launched(address,address,address,string,string,string,bytes32)");
    bytes32 internal constant TRANSFER_TOPIC0 = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant DEPOSITED_TOPIC0 = keccak256("Deposited(address,address,uint256)");
    bytes32 internal constant CLAIMED_TOPIC0 = keccak256("Claimed(address,uint256)");
    /// Buyback POLITIKASI -- para degil KARAR. `enabled` INDEKSLI DEGILDIR,
    /// yani `data`da durur ve cozucu onu okumak zorundadir.
    bytes32 internal constant BUYBACK_ENABLED_TOPIC0 = keccak256("BuybackEnabledUpdated(address,address,bool)");

    FeeEscrow internal escrow;
    LaunchFactory internal factory;
    BuybackVestingVault internal vault;
    BuybackTreasury internal treasury;
    address internal constant KEEPER = address(0x4EE9);

    /// BU TEST KONTRATI `zero_creator` senaryosunun curve'unu DOGRUDAN deploy
    /// eder, yani o curve icin `factory` BUDUR ve `ILaunchFactory`nin iki
    /// uyesini tasimak ZORUNDADIR. Diger senaryolarin curve'leri gercek
    /// `LaunchFactory`den gelir ve okumalari oraya duser.
    address public protocolTreasury = TREASURY;
    address public graduationTarget;

    bytes32 internal constant FEE_SCHEDULE_ASSIGNED_TOPIC0 =
        0xe027304f2e5e4d74279f1d1b4ac8f3d1916482aa45475d7dd67699ee58d8d479;

    function setUp() public {
        FEE_SCHEDULE = new FeeSchedule();
        vm.roll(FIXTURE_BLOCK);
        vm.warp(FIXTURE_TIMESTAMP);
        vm.createDir("./fixtures", true);

        escrow = new FeeEscrow();
        factory = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        // BUYBACK KABLOLAMASI. `PoolManager` GEREKMEZ ve verilmez: bu paketin
        // urettigi fixture'lar EGRI asamasindadir, yani supurme egri
        // merciinden gecer. Havuz mercii `BuybackPoolVenue.t.sol`da ve canli
        // fork paketinde yurunur.
        vault = new BuybackVestingVault(address(factory));
        treasury = new BuybackTreasury(address(factory), address(escrow), vault, IPoolManager(address(0xB00C)));
        vm.startPrank(GOVERNOR);
        factory.setBuybackTreasury(address(treasury));
        factory.setBuybackKeeper(KEEPER);
        vm.stopPrank();

        vm.deal(CREATOR, 1_000e18);
        vm.deal(TRADER, 1_000e18);
    }

    // =================================================================
    // 1. launch -- LOG SIRASI
    // =================================================================

    /// `launch()` once curve'u, sonra token'i uretir; token'in constructor'i
    /// arzi curve'e basar ve `Transfer` ORADA dusar. `Launched` ondan SONRA,
    /// `bind`'den ONCE yayilir ve `bind` hicbir log yaymaz (iki cagrisi da
    /// `view`, yani STATICCALL, ve STATICCALL altinda LOG yasaktir).
    /// Dolayisiyla bir launch isleminde `Transfer` `Launched`'DAN ONCE gelir.
    /// CANLI ZINCIRDE DE OYLE: tx 0x1b5ad264..., blok 54663376, li 18 =
    /// token `Transfer`, li 19 = factory `Launched`, toplam 2 log.
    function test_fixture_launch() public {
        vm.recordLogs();
        vm.prank(CREATOR);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://arcpad/smoke");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // FAZ 2: UC LOG. `FeeScheduleAssigned` `Launched`den ONCE gelir,
        // cunku defter yazimi (feeScheduleOf) her dis cagridan ve her sonraki
        // olaydan once biter.
        assertEq(logs.length, 3, "launch tam olarak UC log uretmeli");

        assertEq(logs[0].emitter, token, "ilk log token'dan gelmeli (mint)");
        assertEq(logs[0].topics[0], TRANSFER_TOPIC0, "ilk log Transfer olmali");
        assertEq(logs[0].topics[1], bytes32(0), "mint kaynagi sifir adres");
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(curve))), "mint hedefi curve");

        assertEq(logs[1].emitter, address(factory), "ikinci log factory'den gelmeli");
        assertEq(logs[1].topics[0], FEE_SCHEDULE_ASSIGNED_TOPIC0, "ikinci log FeeScheduleAssigned olmali");
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(token))), "atama token'a indeksli");
        assertEq(logs[1].topics[2], bytes32(uint256(uint160(address(FEE_SCHEDULE)))), "atama schedule'a indeksli");

        assertEq(logs[2].emitter, address(factory), "ucuncu log factory'den gelmeli");
        assertEq(logs[2].topics[0], LAUNCHED_TOPIC0, "ucuncu log Launched olmali");
        assertEq(logs[2].topics.length, 4, "Launched uc indeksli parametre tasir");

        // CANLI YAKALAMA BU SENARYO ICIN ARTIK ESKIDIR, VE BU SESSIZCE
        // GECILMIYOR -- ACIKCA PINLENIYOR.
        //
        // `fixtures/arc-live/smoke-receipts.json` 0x0d75a4fF...'deki ALTI
        // ARGUMANLI factory'den yakalandi ve o factory `FeeScheduleAssigned`
        // yaymiyordu: canli makbuzda IKI kontrat logu var (Transfer,
        // Launched), bizde artik UC. Fark BEKLENENDIR ve Task 7 yedi
        // argumanli factory'yi deploy edip yakalamayi yenileyene kadar surer.
        // Asagidaki iddia o ara durumu tasir: canli akisin IKI logu, bizim
        // birinci ve UCUNCU logumuzla AYNI SIRADA eslesmeli. Eslesmezse
        // graduation oncesi akista gercek bir sapma var demektir.
        _assertLaunchMatchesSupersededCapture(logs);
        _dump("launch", logs);
    }

    // =================================================================
    // 2. buyExactTokensOut -- IADE SIFIR DEGIL
    // =================================================================

    /// @dev UCRET PARCALARDAN TOPLANIR, BIR TOPLAMDAN BOLUNMEZ, ve bu fixture
    ///      o farki TASIR: asagidaki iddia `protocolFee + creatorFee`'nin
    ///      `feeOn(quoteAmount, 125)`ten TAM 1 WEI fazla oldugunu pinler.
    ///      Fark canli smoke'un 1. isleminde de gorulmustu (...635 vs ...634)
    ///      ve escrow toplanmis rakami tutuyor.
    ///
    /// @dev MIKTAR SERBEST DEGIL VE ON KOSUL BURAYA YAZILIYOR -- aksi halde bu
    ///      "kimsenin yazmadigi bir sebeple gecen test" olurdu. Fark yalnizca
    ///      `(95c mod 1e4) + (30c mod 1e4) < 1e4` iken 1 weidir. OLCULDU:
    ///        tokensOut = 100_000_000e18 -> c = 441_109_969_167_523_125,
    ///          artiklar 6875 + 3750 = 10625 >= 1e4 -> iki kural AYNI sayiyi
    ///          verir (5_513_874_614_594_040) ve fixture SIFIR kanit tasirdi;
    ///        tokensOut =  99_999_999e18 -> c = 441_109_964_303_073_007,
    ///          artiklar 5665 + 210 = 5875 < 1e4 -> toplanmis 1 wei buyuk
    ///          (5_513_874_553_788_414 vs 5_513_874_553_788_413).
    ///      Yuvarlak sayi bilerek BIRAKILDI; 1 eksigi seciliyor.
    function test_fixture_buyExactTokensOut() public {
        (address token, address curve) = _launch();

        vm.recordLogs();
        vm.prank(TRADER);
        BondingCurve(curve).buyExactTokensOut{value: 1e18}(99_999_999e18, 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 4, "Trade + Transfer + Deposited x2");

        assertEq(logs[0].emitter, curve, "Trade curve'den");
        assertEq(logs[0].topics[0], TRADE_TOPIC0, "log 0 = Trade");
        // TOKEN TRANSFERI TRADE'DEN SONRA GELIR -- ALIMDA DA, SATISTA DA.
        // Kati CEI: defter -> olay -> dis cagri. Gorev brifinginin "alimda
        // TERSI" ifadesi kontratla ve canli zincirle CELISIR; bkz. rapor.
        assertEq(logs[1].emitter, token, "log 1 = token Transfer");
        assertEq(logs[1].topics[0], TRANSFER_TOPIC0, "log 1 = Transfer");
        assertEq(logs[2].emitter, address(escrow), "log 2 = Deposited (protokol)");
        assertEq(logs[2].topics[0], DEPOSITED_TOPIC0, "log 2 = Deposited");
        assertEq(logs[2].topics[1], bytes32(uint256(uint160(TREASURY))), "protokol payi treasury'ye");
        assertEq(logs[3].emitter, address(escrow), "log 3 = Deposited (creator)");
        assertEq(logs[3].topics[1], bytes32(uint256(uint160(CREATOR))), "creator payi creator'a");

        (uint256 quoteAmount, uint256 protocolFee, uint256 creatorFee) = _assertTrade(logs[0], true, TRADER);

        // IADE SIFIR DEGIL: butce 1e18, curve tarafi + ucretler ondan kucuk.
        assertLt(quoteAmount + protocolFee + creatorFee, 1e18, "bu senaryonun iadesi sifir olmamali");

        // TOPLANMIS != BOLUNMUS, tam 1 wei.
        assertEq(
            protocolFee + creatorFee, _ceilBps(quoteAmount, 125) + 1, "toplanmis ucret bolunmusten 1 wei buyuk olmali"
        );

        // CANLI: tx 0x65bf2b3c..., blok 54663526, 7 logdan 3'u EIP-7708.
        _assertMatchesLiveArc(2, "buy_exact_tokens_out", 3, logs);
        _dump("buy_exact_tokens_out", logs);
    }

    // =================================================================
    // 3. buyExactQuoteIn -- KISMA YOK
    // =================================================================

    function test_fixture_buyExactQuoteIn() public {
        (address token, address curve) = _launch();

        vm.recordLogs();
        vm.prank(TRADER);
        BondingCurve(curve).buyExactQuoteIn{value: 1e18}(0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 4, "Trade + Transfer + Deposited x2");
        assertEq(logs[0].topics[0], TRADE_TOPIC0, "log 0 = Trade");
        assertEq(logs[1].emitter, token, "log 1 = token Transfer");
        assertEq(logs[2].topics[0], DEPOSITED_TOPIC0, "log 2 = Deposited");
        assertEq(logs[3].topics[0], DEPOSITED_TOPIC0, "log 3 = Deposited");

        _assertTrade(logs[0], true, TRADER);

        // KISMA TETIKLENMEDI: curve tamamlanmadi, dolayisiyla `Completed` YOK
        // ve `realTokenReserves` sifirdan buyuk kaldi.
        assertFalse(BondingCurve(curve).complete(), "bu senaryoda curve tamamlanmamali");
        assertGt(BondingCurve(curve).realTokenReserves(), 0, "rezerv tukenmemeli");

        // CANLI: tx 0x19b31cd0..., blok 54663522, 7 logdan 3'u EIP-7708.
        _assertMatchesLiveArc(1, "buy_exact_quote_in", 3, logs);
        _dump("buy_exact_quote_in", logs);
    }

    // =================================================================
    // 4. buyExactQuoteIn -- KISMA + TAMAMLANMA
    // =================================================================

    /// `Completed` YALNIZCA burada uretilebilir: satis arzinin tamami tek
    /// islemde alinir, `realTokenReserves` sifira iner ve `Completed` `Trade`
    /// ile AYNI tx'te, hemen ardindan yayilir. Canli zincirde de bitisiktir
    /// (tx 0x2d18eac2..., li 26 = Trade, li 27 = Completed).
    function test_fixture_buyExactQuoteInClamped() public {
        (address token, address curve) = _launch();

        vm.recordLogs();
        vm.prank(TRADER);
        BondingCurve(curve).buyExactQuoteIn{value: 20e18}(0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 5, "Trade + Completed + Transfer + Deposited x2");
        assertEq(logs[0].topics[0], TRADE_TOPIC0, "log 0 = Trade");
        assertEq(logs[1].emitter, curve, "Completed curve'den");
        assertEq(logs[1].topics[0], COMPLETED_TOPIC0, "log 1 = Completed");
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(token))), "Completed token'i indeksler");
        assertEq(logs[2].emitter, token, "log 2 = token Transfer");
        assertEq(logs[3].topics[0], DEPOSITED_TOPIC0, "log 3 = Deposited");
        assertEq(logs[4].topics[0], DEPOSITED_TOPIC0, "log 4 = Deposited");

        _assertTrade(logs[0], true, TRADER);

        // KISMA'NIN GOZLENEBILIR IZI: `Trade`in son iki alani, LOGDAN
        // okunarak, `realTokenReserves == 0` ve `realQuoteReserves == R + 1`.
        (,,,,,,, uint256 rT, uint256 rQ) =
            abi.decode(logs[0].data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        assertEq(rT, 0, "kisma satis arzinin TAMAMINI satar");
        assertEq(rQ, 12_161_433_369_060_378_707, "R = floor(V*S/(T-S)) + 1 (quoteBuyCost'un +1'i)");

        // `Completed`in yuku de logdan dogrulanir.
        (uint256 completedRQ, uint256 poolSeed) = abi.decode(logs[1].data, (uint256, uint256));
        assertEq(completedRQ, rQ, "Completed ile Trade ayni rezervi bildirmeli");
        assertEq(poolSeed, 206_886_011_183_597_390_493_942_218, "D = floor(S(T-S)/T)");

        // CANLI: tx 0x2d18eac2..., blok 54663673, 8 logdan 3'u EIP-7708.
        // O islem `buyExactTokensOut` ile yapildi; burada `buyExactQuoteIn`
        // kismasiyla ayni yere dusuluyor. Iddia GIRIS NOKTASI degil, tamamlanan
        // bir alimin LOG DIZISIDIR -- ve ikisinin ayni olmasi zaten Task 5'in
        // "iki yol ayni handler'a duser" varsayiminin on kosuludur.
        _assertMatchesLiveArc(4, "buy_exact_tokens_out_fill", 3, logs);
        _dump("buy_exact_quote_in_clamped", logs);
    }

    // =================================================================
    // 5. sellExactTokensIn
    // =================================================================

    /// SATISTA DA `Transfer` `Trade`'DEN SONRA GELIR. Bu, brifingin
    /// "alimda TERSI" iddiasinin OLCULEREK REDDEDILDIGI yer: iki yon de ayni
    /// CEI sirasini izler (defter -> olay -> dis cagri). Canli zincirde de
    /// oyle: tx 0xe8cf9752..., li 61 = Trade, li 62 = token Transfer.
    function test_fixture_sell() public {
        (address token, address curve) = _launch();

        vm.prank(TRADER);
        BondingCurve(curve).buyExactTokensOut{value: 1e18}(100_000_000e18, 1e18);
        vm.prank(TRADER);
        LaunchToken(token).approve(curve, type(uint256).max);

        uint256 balanceBefore = TRADER.balance;

        vm.recordLogs();
        vm.prank(TRADER);
        BondingCurve(curve).sellExactTokensIn(50_000_000e18, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 4, "Trade + Transfer + Deposited x2");
        assertEq(logs[0].emitter, curve, "log 0 = Trade");
        assertEq(logs[0].topics[0], TRADE_TOPIC0, "log 0 = Trade");
        assertEq(logs[1].emitter, token, "log 1 = token Transfer (satici -> curve)");
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(TRADER))), "kaynak satici");
        assertEq(logs[1].topics[2], bytes32(uint256(uint160(curve))), "hedef curve");
        assertEq(logs[2].topics[0], DEPOSITED_TOPIC0, "log 2 = Deposited");
        assertEq(logs[3].topics[0], DEPOSITED_TOPIC0, "log 3 = Deposited");

        (uint256 quoteAmount, uint256 protocolFee, uint256 creatorFee) = _assertTrade(logs[0], false, TRADER);

        // ODEME LOG URETMEZ (yerelde). Gozlenebilir tek izi bakiyedir ve
        // `Trade`in alanlarindan TAM olarak yeniden kurulur -- Faz 3'un
        // "durumu logdan kur" iddiasinin satis bacagi budur.
        assertEq(
            TRADER.balance - balanceBefore,
            quoteAmount - protocolFee - creatorFee,
            "net odeme Trade alanlarindan cikmali"
        );

        // CANLI: tx 0xe8cf9752..., blok 54663533, 7 logdan 3'u EIP-7708
        // (bastaki YOK, sondaki odeme VAR).
        _assertMatchesLiveArc(3, "sell", 3, logs);
        _dump("sell", logs);
    }

    // =================================================================
    // 6. zero creator -- TEK `Deposited`
    // =================================================================

    /// `creator == address(0)` olan bir curve FACTORY'DEN URETILEMEZ
    /// (`launch` creator'i `msg.sender` yapar ve `LaunchToken` sifir creator'i
    /// reddeder), bu yuzden curve DOGRUDAN deploy edilir -- yani bu fixture'in
    /// curve'u KANONIK DEGILDIR ve `Launched`i da yoktur. Tasidigi ozellik
    /// yalnizca sudur: creator payi alinmadigi icin escrow'a YALNIZCA BIR
    /// yatirim yapilir. "Her ticaret iki `Deposited` uretir" varsayan bir
    /// handler burada kirilir.
    function test_fixture_zeroCreator() public {
        BondingCurve curve = new BondingCurve(address(0), address(escrow), T, V, S);
        LaunchToken token =
            new LaunchToken("Arc Coin", "ARC", "ipfs://arcpad/smoke", CREATOR, address(curve), bytes32(0));
        curve.bind(address(token));

        assertEq(curve.factory(), address(this), "curve'un factory'si bu test kontratidir");
        assertEq(curve.creator(), address(0), "senaryonun on kosulu: sifir creator");

        vm.recordLogs();
        vm.prank(TRADER);
        curve.buyExactTokensOut{value: 1e18}(100_000_000e18, 1e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 3, "Trade + Transfer + TEK Deposited");
        assertEq(logs[0].topics[0], TRADE_TOPIC0, "log 0 = Trade");
        assertEq(logs[1].emitter, address(token), "log 1 = token Transfer");
        assertEq(logs[2].emitter, address(escrow), "log 2 = Deposited");
        assertEq(logs[2].topics[0], DEPOSITED_TOPIC0, "log 2 = Deposited");
        assertEq(logs[2].topics[1], bytes32(uint256(uint160(TREASURY))), "tek yatirim protokolundur");

        (,, uint256 creatorFee) = _assertTrade(logs[0], true, TRADER);
        assertEq(creatorFee, 0, "creator payi alinmamali");

        _dump("zero_creator", logs);
    }

    // =================================================================
    // 7. claim
    // =================================================================

    /// TEK `Claimed` yolu. `FeeEscrow.claim` olayi DIS CAGRIDAN SONRA yayar
    /// (defter -> transfer -> olay), yani alici bir kontratsa onun logu
    /// `Claimed`DEN ONCE duser. Burada alici bir EOA'dir, dolayisiyla tek log.
    function test_fixture_claim() public {
        (, address curve) = _launch();

        vm.prank(TRADER);
        BondingCurve(curve).buyExactTokensOut{value: 1e18}(100_000_000e18, 1e18);

        uint256 owed = escrow.owed(TREASURY);
        assertGt(owed, 0, "claim edilecek bir alacak olmali");

        vm.recordLogs();
        escrow.claim(TREASURY);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1, "tek Claimed");
        assertEq(logs[0].emitter, address(escrow), "Claimed escrow'dan");
        assertEq(logs[0].topics[0], CLAIMED_TOPIC0, "log 0 = Claimed");
        assertEq(logs[0].topics.length, 2, "Claimed yalnizca alicisini indeksler");
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(TREASURY))), "alici treasury");
        assertEq(abi.decode(logs[0].data, (uint256)), owed, "tutar defterdeki alacak");

        _dump("claim", logs);
    }

    // =================================================================
    // 8. forged -- REDDETME YOLU
    // =================================================================

    /// Rogue bir factory'nin `Launched`'i AYNI topic0'i tasir; ayiran sey
    /// emitter ve CREATE2 turetmesidir. Iki sapma birlikte olculur:
    /// creationCode farkli (rogue token `mint()` tasir) ve `isCanonical`
    /// false doner.
    function test_fixture_forged() public {
        assertTrue(
            keccak256(type(RogueToken).creationCode) != keccak256(type(LaunchToken).creationCode),
            "rogue token'in creationCode'u gercekinden FARKLI olmali"
        );

        RogueFactory rogue = new RogueFactory(address(escrow), TREASURY, T, V, S);
        bytes32 salt = keccak256(abi.encode(CREATOR, "Arc Coin", "ARC", "ipfs://arcpad/smoke", uint256(0)));

        vm.recordLogs();
        vm.prank(CREATOR);
        (address token, address curve) = rogue.launch("Arc Coin", "ARC", "ipfs://arcpad/smoke", CREATOR, salt);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2, "sahte launch da tam olarak iki log uretir");
        assertEq(logs[0].emitter, token, "log 0 = rogue token mint");
        assertEq(logs[0].topics[0], TRANSFER_TOPIC0, "log 0 = Transfer");
        assertEq(logs[1].emitter, address(rogue), "log 1 = rogue factory'nin Launched'i");
        assertEq(logs[1].topics[0], LAUNCHED_TOPIC0, "SAHTENIN topic0'i GERCEGIYLE AYNIDIR");
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(token))), "iddia edilen token");
        assertEq(logs[1].topics[2], bytes32(uint256(uint160(curve))), "iddia edilen curve");
        assertEq(logs[1].topics[3], bytes32(uint256(uint160(CREATOR))), "iddia edilen creator");

        // SAHTECILIK TUTARLIDIR: curve token'i geri isaret eder ve arzin
        // tamami curve'dedir -- yani "eksik" oldugu icin degil, TURETME
        // TUTMADIGI icin reddedilir.
        assertEq(BondingCurve(curve).token(), token, "sahte bag da tutarli");
        assertFalse(factory.isCanonical(token), "gercek factory sahteyi kanonik SAYMAMALI");

        _dump("forged", logs);
    }

    // =================================================================
    // Yardimcilar
    // =================================================================

    function _launch() private returns (address token, address curve) {
        vm.prank(CREATOR);
        (token, curve) = factory.launch("Arc Coin", "ARC", "ipfs://arcpad/smoke");
    }

    /// @notice Yerel olarak uretilen log dizisini, AYNI cagrinin ARC TESTNET'TE
    ///         birakmis oldugu GERCEK makbuzla karsilastirir.
    ///
    /// @dev BU, RAPORDA BIR CUMLE OLMAK YERINE CALISTIRILABILIR OLMAK ZORUNDA.
    ///      "Yerel fixture'lar canli zincirle ayni sekli tasiyor" iddiasi, bir
    ///      kez olculup rapora yazildiginda BIR SONRAKI degisiklikte sessizce
    ///      yanlislanir. Burada her kosuda yeniden olculuyor.
    ///
    /// @dev KARSILASTIRMA `topic0` DIZISI UZERINDENDIR, degerler uzerinden
    ///      DEGIL, ve sinir acikca soyleniyor: canli smoke baska miktarlarla
    ///      yapildi, dolayisiyla veriler AYNI OLAMAZ. Bu iddianin kapattigi sey
    ///      OLAY SIRASIDIR -- brifingin "alimda Transfer, Trade'den ONCE gelir"
    ///      ifadesinin yanlislandigi yer tam olarak burasi.
    ///
    /// @dev SISTEM LOGLARI ELENIR AMA VARLIKLARI IDDIA EDILIR: aksi halde
    ///      canli yakalamadan EIP-7708 loglarini silmek bu testi yesil
    ///      birakirdi ve acik hucre kaybolurdu.
    /// @dev `launch` icin ozel karsilastirma. Genel `_assertMatchesLiveArc`
    ///      log SAYILARININ esit olmasini bekler; Faz 2 factory'ye bir olay
    ///      ekledigi icin bu senaryoda esit DEGILLER. Yakalama yenilenene
    ///      kadar dogrulanabilecek olan sey, canli akisin iki logunun bizim
    ///      birinci ve ucuncu logumuza SIRASIYLA denk gelmesidir.
    function _assertLaunchMatchesSupersededCapture(Vm.Log[] memory logs) private view {
        string memory json = vm.readFile(ARC_LIVE_CAPTURE);
        string memory base = "$.receipts[0]";
        require(
            keccak256(bytes(vm.parseJsonString(json, string.concat(base, ".scenario")))) == keccak256(bytes("launch")),
            "canli yakalamada senaryo indeksi kaymis"
        );
        require(
            !vm.keyExistsJson(json, string.concat(base, ".logs[2]")),
            "canli makbuzda artik ikiden fazla log var -- yakalama yenilenmis olabilir, bu yardimci kaldirilmali"
        );
        assertEq(
            vm.parseJsonString(json, string.concat(base, ".logs[0].topics[0]")),
            _hex(abi.encodePacked(logs[0].topics[0])),
            "canli birinci log (Transfer) ayrisiyor"
        );
        assertEq(
            vm.parseJsonString(json, string.concat(base, ".logs[1].topics[0]")),
            _hex(abi.encodePacked(logs[2].topics[0])),
            "canli ikinci log (Launched) bizim ucuncu logumuzla ayrisiyor"
        );
    }

    function _assertMatchesLiveArc(
        uint256 receiptIndex,
        string memory expectScenario,
        uint256 expectedSystemLogs,
        Vm.Log[] memory logs
    ) private view {
        string memory json = vm.readFile(ARC_LIVE_CAPTURE);
        string memory base = string.concat("$.receipts[", vm.toString(receiptIndex), "]");

        // INDEKS KAYMASINA KARSI: senaryo etiketi de dogrulanir, aksi halde
        // canli yakalamaya bir makbuz eklemek butun karsilastirmalari sessizce
        // baska tx'lere kaydirirdi.
        require(
            keccak256(bytes(vm.parseJsonString(json, string.concat(base, ".scenario"))))
                == keccak256(bytes(expectScenario)),
            "canli yakalamada senaryo indeksi kaymis"
        );

        uint256 total = expectedSystemLogs + logs.length;
        require(
            !vm.keyExistsJson(json, string.concat(base, ".logs[", vm.toString(total), "]")),
            "canli makbuzda beklenenden FAZLA log var"
        );

        uint256 matched;
        uint256 systemLogs;
        for (uint256 i = 0; i < total; ++i) {
            string memory path = string.concat(base, ".logs[", vm.toString(i), "]");
            string memory emitter = vm.parseJsonString(json, string.concat(path, ".address"));
            if (keccak256(bytes(emitter)) == keccak256(bytes(ARC_NATIVE_TRANSFER_EMITTER))) {
                systemLogs++;
                continue;
            }
            require(matched < logs.length, "canli akis fixture'dan FAZLA kontrat logu tasiyor");
            require(
                keccak256(bytes(vm.parseJsonString(json, string.concat(path, ".topics[0]"))))
                    == keccak256(bytes(_hex(abi.encodePacked(logs[matched].topics[0])))),
                "topic0 dizisi canli zincirden AYRISIYOR"
            );
            matched++;
        }
        require(matched == logs.length, "fixture canli akista bulunmayan bir kontrat logu tasiyor");
        require(systemLogs == expectedSystemLogs, "canli yakalamadaki EIP-7708 log sayisi degismis");
    }

    /// @dev `Trade`in TAMAMI LOGDAN cozulur, curve'un depolamasindan DEGIL --
    ///      Faz 3 durumu tam olarak boyle yeniden kuracak. Iki ozdeslik canli
    ///      zincirde bes smoke durumunda dogrulanmisti ve fixture'lar onlari
    ///      TASIMAK zorundadir; alan listesini tasimak yetmez.
    function _assertTrade(Vm.Log memory log, bool expectBuy, address expectTrader)
        private
        pure
        returns (uint256 quoteAmount, uint256 protocolFee, uint256 creatorFee)
    {
        require(log.topics.length == 2, "Trade iki topic tasir: topic0 + indexed trader");
        require(log.topics[1] == bytes32(uint256(uint160(expectTrader))), "trader topic'i");
        require(log.data.length == 288, "Trade yuku dokuz kelimedir");

        uint256 tokenAmount;
        uint256 vT;
        uint256 vQ;
        uint256 rT;
        uint256 rQ;
        bool isBuy;
        (isBuy, tokenAmount, quoteAmount, protocolFee, creatorFee, vT, vQ, rT, rQ) =
            abi.decode(log.data, (bool, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));

        require(isBuy == expectBuy, "yon bayragi");
        require(tokenAmount != 0, "sifir token'li bir Trade yayilamaz");
        require(quoteAmount != 0, "sifir quote'lu bir Trade yayilamaz");

        // BES CANLI SMOKE DURUMUNDA DOGRULANMIS IKI OZDESLIK.
        require(vT - rT == T - S, "vT - rT == T - S bozuldu");
        require(vQ - rQ == V, "vQ - rQ == V bozuldu");

        // Ucret parcalari INCLUSIVE degil EXCLUSIVE sozlesmedir ve her biri
        // TAVANA yuvarlanir. `CurveMath` CAGRILMAZ: testin kutuphaneyi
        // kendisiyle karsilastirmasi bu deponun yakaladigi totoloji sinifidir.
        require(protocolFee == _ceilBps(quoteAmount, PROTOCOL_BPS), "protokol payi");
        require(creatorFee == 0 || creatorFee == _ceilBps(quoteAmount, CREATOR_BPS), "creator payi");
    }

    function _ceilBps(uint256 amount, uint256 bps) private pure returns (uint256) {
        return (amount * bps + 9_999) / 10_000;
    }

    // -----------------------------------------------------------------
    // Serilestirme -- ELLE, VE NICIN
    // -----------------------------------------------------------------
    //
    // `vm.serializeX` + `vm.writeJson` ANAHTAR SIRASINI garanti etmez ve
    // drift kapisi tam olarak BAYT esitligine dayanir: sirasi oynayan bir
    // serilestirici, hicbir kontrat degismeden `git diff`i kirletir ve kapiyi
    // gurultuye bogar. Elle kurulan dize sirayi, girintiyi ve satir sonunu
    // (`\n`; `.gitattributes` zaten `eol=lf` zorlar) TAMAMEN belirler.
    //
    // Adresler ve topic'ler KUCUK HARF yazilir, cunku `eth_getLogs` boyle
    // dondurur; `vm.toString(address)` EIP-55 checksum'li dondurur ve fixture
    // gercek RPC ciktisindan SAPARDI.

    // =================================================================
    // BUYBACK -- BES OLAYIN HEPSI TEK SENARYODA
    // =================================================================

    /**
     * TAHAKKUK -> SUPURME -> KILIT -> DAGITIM.
     *
     * @dev BU FIXTURE ZORUNLUDUR, SUSLEME DEGIL. `indexer/test/topics.test.ts`
     *      her `TOPIC0` degerinin EN AZ BIR GERCEK LOGDA gorulmesini ister ve
     *      `logs.test.ts` her handler'in bir fixture tarafindan egzersiz
     *      edilmesini. Bes buyback olayi kaydedilip fixture uretilmeseydi dort
     *      kapi birden kirmizi olurdu -- ve olmasi gerekirdi: imzasi hicbir
     *      gercek loga uymayan bir cozucu, sessizce hicbir sey indekslemez.
     *
     * @dev LOGLAR FOUNDRY'NIN GERCEK YURUTMESINDEN CIKAR, elle kurulmaz. Bir
     *      imza yanlis yazilirsa hesaplanan selector bu loglarin hicbiriyle
     *      ortusmez ve kapi ANINDA duser; elle yazilmis bir fixture ayni yanlis
     *      imzayi tasiyip iki tarafi da tutarli kilardi.
     */
    function test_fixture_buyback() public {
        vm.prank(CREATOR);
        (address token, address curve) = factory.launchWithBuyback("Buyback Coin", "BBK", "ipfs://bb", true);

        // AL-SAT DONGUSU: esigi (`MIN_SWEEP_WEI`) asacak kadar ucret uretir.
        // Tek yonlu alimla toplanabilecek ucret testnet profilinde esigin
        // ALTINDA kalir -- `BuybackLifecycle.t.sol`da olculdu.
        for (uint256 i = 0; i < 10; ++i) {
            vm.prank(TRADER);
            BondingCurve(payable(curve)).buyExactQuoteIn{value: 5e18}(0);
            uint256 held = LaunchToken(token).balanceOf(TRADER);
            if (held == 0) continue;
            vm.startPrank(TRADER);
            LaunchToken(token).approve(curve, held);
            BondingCurve(payable(curve)).sellExactTokensIn(held, 0);
            vm.stopPrank();
        }
        require(treasury.pendingQuote(token) > treasury.MIN_SWEEP_WEI(), "butce esigin altinda");

        // ---- KAYIT BURADA BASLAR: supurme + dagitim ----
        vm.recordLogs();

        vm.prank(KEEPER);
        treasury.sweep(token, 0, block.timestamp + 600);

        // Vesting saatinin ilerlemesi icin MUTLAK bir an kurulur; goreli warp
        // `via_ir` altinda sessizce etkisiz kalabilir (bkz. devir belgesi §6).
        vm.warp(FIXTURE_TIMESTAMP + 365 days);
        vm.prank(CREATOR);
        vault.release(token);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        // ANTI-VAKUM: bes olayin BESI de gercekten yayildi mi. Bir tanesi
        // eksikse fixture o `TOPIC0` icin bos kalir ve indexer kapisi
        // -- dogru olarak -- kirmizi olur; burada ADIYLA yakalanir.
        assertTrue(_hasTopic(logs, keccak256("BuybackAccrued(address,address,uint256,uint256)")), "BuybackAccrued yok");
        assertTrue(_hasTopic(logs, keccak256("BuybackExecuted(address,uint256,uint256)")), "BuybackExecuted yok");
        assertTrue(_hasTopic(logs, keccak256("BuybackLocked(address,uint256,uint256,uint256,uint256)")), "BuybackLocked yok");
        assertTrue(
            _hasTopic(logs, keccak256("VestingReleased(address,address,uint256,uint256)")), "VestingReleased yok"
        );

        _dump("buyback", logs);
    }

    /**
     * ...VE `BuybackSkipped` AYRI BIR SENARYODUR.
     *
     * @dev Ayni islemde uretilemez: supurme ya HARCAR ya GERI KATLAR, ikisini
     *      birden yapmaz. Tamamlanmis bir egride alim yapilamaz, dolayisiyla
     *      butun butce creator'a doner ve olay ORADA yayilir.
     */
    function test_fixture_buybackSkipped() public {
        vm.prank(CREATOR);
        (address token, address curve) = factory.launchWithBuyback("Skip Coin", "SKP", "ipfs://sk", true);

        vm.prank(TRADER);
        BondingCurve(payable(curve)).buyExactQuoteIn{value: 5e18}(0);

        // Egriyi TAMAMLA: bundan sonra alim kabul edilmez, supurme geri katlar.
        // ARGUMAN PRANK'TEN ONCE OKUNUR. `vm.prank` YALNIZCA bir sonraki
        // cagriyi etkiler ve arguman ifadeleri ondan ONCE degerlendirilir;
        // ic okuma prank'i tuketirse alimi TEST KONTRATI yapar ve egrinin
        // iadesi `RefundFailed()` ile duser (olculdu, iki kez).
        uint256 remaining = BondingCurve(payable(curve)).realTokenReserves();
        vm.deal(TRADER, 1_000_000e18);
        vm.prank(TRADER);
        BondingCurve(payable(curve)).buyExactTokensOut{value: 100_000e18}(remaining, type(uint256).max);
        require(BondingCurve(payable(curve)).complete(), "egri tamamlanmadi");

        vm.recordLogs();
        vm.prank(KEEPER);
        treasury.sweep(token, 0, block.timestamp + 600);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(
            _hasTopic(logs, keccak256("BuybackSkipped(address,uint256,string)")), "BuybackSkipped yayilmadi"
        );
        _dump("buyback-skipped", logs);
    }

    /**
     * ...VE POLITIKA UCUNCU BIR SENARYODUR: PARA DEGIL, KARAR.
     *
     * @dev NEDEN AYRI BIR FIXTURE GEREKTI. `BuybackEnabledUpdated` bir tutar
     *      tasimaz, ama arayuzun ILK TAHAKKUKTAN ONCE "bu token'da buyback
     *      acik" diyebilmesinin TEK yolu odur. Onsuz ekran, ozelligi acmis ama
     *      henuz islem gormemis bir token'i buyback'siz bir token'dan ayirt
     *      EDEMEZ -- ve creator'in sonradan KAPATMASI hicbir yerde gorunmez.
     *
     * @dev IKI LOG, IKI YON, TEK KAYIT. Acilis `launchWithBuyback`in ICINDEN
     *      gelir (yani `Launched` ile AYNI islemde, ki indexer'in iki fazli
     *      uygulamasi tam olarak bu sirayla sinanir: launch satiri once
     *      yazilmazsa politika satiri yabanci anahtara carpar), kapanis ise
     *      ayri bir `setBuybackEnabled` cagrisindan. Yalnizca birini kaydetmek,
     *      cozucunun `bool`u okudugunu degil yalnizca bir sabiti dondurdugunu
     *      da gecirirdi.
     */
    function test_fixture_buybackPolicy() public {
        vm.recordLogs();

        vm.prank(CREATOR);
        (address token,) = factory.launchWithBuyback("Policy Coin", "POL", "ipfs://po", true);

        // KAPATMA: creator kendi tercihini geri alabilir (izin modeli
        // `BuybackPermissions.t.sol`da yuruyor; burada yalnizca LOGU lazim).
        vm.prank(CREATOR);
        factory.setBuybackEnabled(token, false);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        // ANTI-VAKUM: IKI log, ve `enabled` alani IKI FARKLI deger tasimali.
        // Tek bir log yeterli olsaydi, `bool`u hic okumayan bir cozucu de
        // gecerdi.
        assertEq(_countTopic(logs, BUYBACK_ENABLED_TOPIC0), 2, "iki politika logu bekleniyordu");
        assertTrue(_hasTopic(logs, LAUNCHED_TOPIC0), "Launched yok -- ayni islem sinanamaz");

        bool sawTrue;
        bool sawFalse;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != BUYBACK_ENABLED_TOPIC0) continue;
            if (abi.decode(logs[i].data, (bool))) sawTrue = true;
            else sawFalse = true;
        }
        assertTrue(sawTrue, "ACMA logu yok");
        assertTrue(sawFalse, "KAPATMA logu yok");

        _dump("buyback-policy", logs);
    }

    function _hasTopic(Vm.Log[] memory logs, bytes32 topic0) private pure returns (bool) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) return true;
        }
        return false;
    }

    function _countTopic(Vm.Log[] memory logs, bytes32 topic0) private pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == topic0) ++n;
        }
    }

    function _dump(string memory name_, Vm.Log[] memory logs) private {
        string memory out = string.concat(
            "{\n",
            '  "scenario": "',
            name_,
            '",\n',
            '  "source": "foundry-local",\n',
            '  "nativeTransferLogsOmitted": true,\n',
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "blockNumber": ',
            vm.toString(block.number),
            ",\n",
            '  "blockTimestamp": ',
            vm.toString(block.timestamp),
            ",\n",
            '  "logs": ['
        );

        for (uint256 i = 0; i < logs.length; ++i) {
            out = string.concat(out, i == 0 ? "\n" : ",\n", _logJson(logs[i], i));
        }
        out = string.concat(out, logs.length == 0 ? "]\n}\n" : "\n  ]\n}\n");

        vm.writeFile(string.concat("./fixtures/", name_, ".json"), out);
    }

    function _logJson(Vm.Log memory log, uint256 index) private pure returns (string memory) {
        string memory topics;
        for (uint256 j = 0; j < log.topics.length; ++j) {
            topics =
                string.concat(topics, j == 0 ? "\n" : ",\n", '        "', _hex(abi.encodePacked(log.topics[j])), '"');
        }
        return string.concat(
            "    {\n",
            '      "logIndex": ',
            vm.toString(index),
            ",\n",
            '      "address": "',
            _hex(abi.encodePacked(log.emitter)),
            '",\n',
            '      "topics": [',
            topics,
            log.topics.length == 0 ? "]" : "\n      ]",
            ",\n",
            '      "data": "',
            _hex(log.data),
            '"\n',
            "    }"
        );
    }

    function _hex(bytes memory raw) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + raw.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < raw.length; ++i) {
            out[2 + i * 2] = alphabet[uint8(raw[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(raw[i]) & 0x0f];
        }
        return string(out);
    }

    /**
     * @dev BUYBACK KAPALI TASLAGI. `BondingCurve` her ucret dagitiminda
     *      fabrikasina bu soruyu sorar ve fabrika, egriyi deploy eden
     *      kontrattir -- yani bu test kontrati. Sifir hazine "kapali"
     *      demektir, dolayisiyla fixture'lar buyback ONCESI davranisi
     *      olcmeye devam eder ve indexer ile karsilastirmalari degismez.
     */
    function buybackPolicy(address) external pure returns (address, uint256) {
        return (address(0), 0);
    }
}
