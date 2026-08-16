// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

/// SAHTECI. Gercek bir launch'in her alanini kopyalayan, kendi icinde
/// TAMAMEN TUTARLI bir launch uretir: kendi curve'unu deploy eder (curve'un
/// constructor'i herkese aciktir), token'i ona basar ve bind eder -- yani
/// `curve.token()` geri isaret eder, arzin tamami curve'dedir, profil bire
/// bir aynidir ve curve fiilen ticaret yapar.
///
/// Bu kontratin varlik sebebi, sahteciligin GERCEKTEN mumkun oldugunu once
/// olcmektir. Faz 1b'nin dersi baglayicidir: kurgunun saldiriyi mumkun
/// kildigi dogrulanmadan yazilan bir "sahtecilik testi" hicbir sey kanitlamaz.
///
/// F1'DEN SONRA SAHTECININ ISI ARTTI VE BU KAYDA GECIRILIYOR: curve artik
/// `protocolTreasury()`i her yatirimda FACTORY'SINDEN okur, dolayisiyla
/// sahtecinin kendisi de `ILaunchFactory`nin iki uyesini SUNMAK zorundadir --
/// aksi halde sahte curve'de HICBIR islem yapilamaz ve sahtecilik "tamamen
/// tutarli" olmaz. Iki uyeyi de gercek factory'den yansitir; maliyeti iki
/// satirdir, yani bu bir GUVENLIK ozelligi DEGILDIR ve boyle sunulmamalidir.
/// Ayiran tek sey hala `isCanonical`dir.
contract Forger {
    LaunchFactory public target;

    function forge(
        LaunchFactory f,
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address creator_,
        bytes32 salt_
    ) external returns (BondingCurve curve, LaunchToken token) {
        target = f;
        curve = new BondingCurve(
            creator_, f.escrow(), f.VIRTUAL_TOKEN_RESERVES(), f.VIRTUAL_QUOTE_RESERVES(), f.SALE_SUPPLY()
        );
        token = new LaunchToken(name_, symbol_, uri_, creator_, address(curve), salt_);
        curve.bind(address(token));
    }

    /// @dev Sahte curve'un factory'si BUDUR, dolayisiyla iki okuma da buraya
    ///      duser. Gercek factory'nin degerleri aynen yansitilir.
    function protocolTreasury() external view returns (address) {
        return target.protocolTreasury();
    }

    /// @dev Buyback KAPALI: sifir hazine, sifir pay. Bu taslaklarin isi
    ///      egriyi calistirmaktir; buyback'in kendi testleri ayri dosyada.
    function buybackPolicy(address) external pure returns (address, uint256) {
        return (address(0), 0);
    }

    function graduationTarget() external view returns (address) {
        return target.graduationTarget();
    }
}

/// KODU OLAN ama defter OLMAYAN adres: `owed(address)` selector'u yok ve
/// fallback'i de yok. En gercekci operator hatasinin sekli budur -- yanlis
/// yapistirilmis bir kontrat adresi (token, curve, factory, Safe...).
contract NotALedger {
    function unrelated() external pure returns (uint256) {
        return 1;
    }
}

/// Uyeyi TASIYAN ama REVERT EDEN defter.
contract RevertingLedger {
    function owed(address) external pure returns (uint256) {
        revert("no ledger here");
    }
}

/// Uyeyi tasiyan ama YAPISAL OLARAK IMKANSIZ cevap donduren defter:
/// `owed[address(0)]` bir `FeeEscrow`da ASLA sifirdan farkli olamaz, cunku
/// `deposit` sifir aliciyi `ZeroRecipient()` ile reddeder.
contract LyingLedger {
    function owed(address) external pure returns (uint256) {
        return 1;
    }
}

/// ACIK HUCRE: dolgun bir fallback ile 32 bayt SIFIR donduren kontrat.
/// Yoklamayi GECER. Kayitli ve bilincli; bkz. `EscrowIsNotAFeeEscrow` NatSpec'i.
contract PermissiveFallback {
    fallback(bytes calldata) external payable returns (bytes memory) {
        return abi.encode(uint256(0));
    }
}

/// MESRU BIR ESCROW'UN VEKILI. `delegatecall` ile gercek uygulamaya gider,
/// dolayisiyla yoklamaya SIFIR doner ve KABUL EDILMELIDIR -- yoklama davranisi
/// olcer, kod hash'ini degil.
contract EscrowProxy {
    address internal immutable IMPLEMENTATION;

    constructor(address implementation_) {
        IMPLEMENTATION = implementation_;
    }

    fallback() external payable {
        address impl = IMPLEMENTATION;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

/// Graduation hedefi. `receive()` ciplak bir kabuldur.
contract Seeder {
    function pull(BondingCurve curve) external returns (uint256, uint256) {
        return curve.graduate();
    }

    receive() external payable {}
}

/// `launch`'i bir SOZLESME olarak cagiran aktor. Cagiran ekseninin ikinci
/// yarisi: creator'in EOA olmadigi durumda da kayit ve turetme dogru olmali.
contract ContractLauncher {
    function go(LaunchFactory f, string memory n, string memory s, string memory u)
        external
        returns (address token, address curve)
    {
        return f.launch(n, s, u);
    }
}

contract LaunchFactoryTest is Test {
    /// Faz 2: factory'nin yedinci constructor argumani. KODU OLMALI.
    FeeSchedule internal FEE_SCHEDULE;

    // Uretim profili (spec 5.3, 18 decimal native gorunum).
    uint256 internal constant T = 1_073_000_000e18;
    uint256 internal constant V = 4_292e18;
    uint256 internal constant S = 793_100_000e18;
    uint256 internal constant N = 1_000_000_000e18; // LaunchToken.TOTAL_SUPPLY

    /// Testnet profili yalnizca `V`'de ayrisir: tam 1000x kucuk.
    uint256 internal constant V_TESTNET = 4_292e15;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant GOVERNOR = address(0x600D);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant BUYER = address(0xB0FFEE);

    FeeEscrow internal escrow;
    LaunchFactory internal factory;

    function setUp() public {
        FEE_SCHEDULE = new FeeSchedule();
        escrow = new FeeEscrow();
        factory = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        vm.deal(ALICE, 100e18);
        vm.deal(BOB, 100e18);
        vm.deal(BUYER, 1_000_000e18);
    }

    function _newFactory(uint256 t_, uint256 v_, uint256 s_) internal returns (LaunchFactory) {
        return new LaunchFactory(address(escrow), TREASURY, GOVERNOR, t_, v_, s_, address(FEE_SCHEDULE));
    }

    /// Fuzz edilen bir dizeyi token sinirlarina sigdirir; bos ise yedegi verir.
    function _fit(string calldata v, uint256 max, string memory fallback_) internal pure returns (string memory) {
        bytes calldata b = bytes(v);
        if (b.length == 0) return fallback_;
        if (b.length > max) {
            bytes memory cut = b[:max];
            return string(cut);
        }
        return v;
    }

    // ---------------------------------------------------------------
    // Provenance -- bu gorevin tasiyici ozelligi
    // ---------------------------------------------------------------

    /// Sahteci, gercek bir launch'in her alanini iddia eden bir token deploy
    /// eder ve arzini GERCEK curve'un adresine basar. Faz 1b'nin custody
    /// incelemesi bunun mumkun oldugunu olcmustu; burada elenmesi gerekir.
    function test_aForgedTokenClaimingARealCurveIsNotCanonical() public {
        vm.prank(ALICE);
        (address realToken, address realCurve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        LaunchToken forged =
            new LaunchToken("Arc Coin", "ARC", "ipfs://cid", LaunchToken(realToken).creator(), realCurve, bytes32(0));

        // Sahte token gercek gibi OKUNUR...
        assertEq(forged.name(), LaunchToken(realToken).name());
        assertEq(forged.symbol(), LaunchToken(realToken).symbol());
        assertEq(forged.metadataURI(), LaunchToken(realToken).metadataURI());
        assertEq(forged.creator(), LaunchToken(realToken).creator());
        assertEq(forged.curve(), realCurve);
        assertEq(forged.totalSupply(), LaunchToken(realToken).totalSupply());
        // ...ve arzinin tamami GERCEK curve'un adresindedir.
        assertEq(forged.balanceOf(realCurve), N);

        // ...ama kanonik DEGILDIR.
        assertTrue(factory.isCanonical(realToken));
        assertFalse(factory.isCanonical(address(forged)));
    }

    /// TASIYICI TEST. Onceki test'in sahtesi tek noktadan ayirt edilebilir:
    /// gercek curve'un `token()` alani sahteyi degil gercegi isaret eder.
    /// Bu test o kacamagi da kapatir -- sahteci KENDI curve'unu deploy eder,
    /// ayni profille, kendi token'ini bind eder ve gercek launch'in her
    /// alanini kopyalar. Sonucta:
    ///   - `token.curve()` ve `curve.token()` BIRBIRINI isaret eder,
    ///   - arzin tamami curve'dedir,
    ///   - profil (T, V, S, D) bire bir aynidir,
    ///   - curve fiilen ticaret yapar ve ayni fiyati verir.
    /// Yani sahte launch BOZUK DEGILDIR, calisan bir klondur. Yerel hicbir
    /// kontrol onu ayirmaz; ayiran tek sey provenance'tir.
    function test_aFullyConsistentForgedLaunchIsSeparatedOnlyByIsCanonical() public {
        vm.prank(ALICE);
        (address realToken, address realCurve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        bytes32 realSalt = LaunchToken(realToken).launchSalt();

        Forger forger = new Forger();
        (BondingCurve fakeCurve, LaunchToken fakeToken) =
            forger.forge(factory, "Arc Coin", "ARC", "ipfs://cid", ALICE, realSalt);

        // --- 1. Token tarafi bire bir ayni okunur ---
        assertEq(fakeToken.name(), LaunchToken(realToken).name());
        assertEq(fakeToken.symbol(), LaunchToken(realToken).symbol());
        assertEq(fakeToken.metadataURI(), LaunchToken(realToken).metadataURI());
        assertEq(fakeToken.creator(), LaunchToken(realToken).creator());
        assertEq(fakeToken.launchSalt(), realSalt);
        assertEq(fakeToken.totalSupply(), LaunchToken(realToken).totalSupply());
        assertEq(fakeToken.decimals(), LaunchToken(realToken).decimals());

        // --- 2. Iki yonlu bag da kurulmustur ---
        assertEq(fakeToken.curve(), address(fakeCurve));
        assertEq(fakeCurve.token(), address(fakeToken));
        assertEq(BondingCurve(realCurve).token(), realToken);
        assertEq(fakeToken.balanceOf(address(fakeCurve)), N);
        assertEq(LaunchToken(realToken).balanceOf(realCurve), N);

        // --- 3. Profil ve tohum arzi da ayni ---
        assertEq(fakeCurve.INITIAL_VIRTUAL_TOKEN_RESERVES(), BondingCurve(realCurve).INITIAL_VIRTUAL_TOKEN_RESERVES());
        assertEq(fakeCurve.INITIAL_VIRTUAL_QUOTE_RESERVES(), BondingCurve(realCurve).INITIAL_VIRTUAL_QUOTE_RESERVES());
        assertEq(fakeCurve.INITIAL_REAL_TOKEN_RESERVES(), BondingCurve(realCurve).INITIAL_REAL_TOKEN_RESERVES());
        assertEq(fakeCurve.poolSeedSupply(), BondingCurve(realCurve).poolSeedSupply());
        assertEq(fakeCurve.creator(), BondingCurve(realCurve).creator());
        assertEq(fakeCurve.escrow(), BondingCurve(realCurve).escrow());
        assertEq(fakeCurve.protocolTreasury(), BondingCurve(realCurve).protocolTreasury());

        // --- 4. Sahte curve BOZUK DEGIL: ayni fiyattan ticaret yapiyor ---
        // F1'den sonra bu ancak sahteci `ILaunchFactory`nin iki uyesini de
        // sunuyorsa dogrudur (bkz. `Forger` NatSpec'i) -- sunmayan bir sahteci
        // hicbir islem yapamaz. Iki satirlik bir maliyet, yani bir guvenlik
        // ozelligi DEGIL; ama sahte curve'un artik gercek bir factory'ye
        // BAGIMLI olmasi kayda deger: `f.protocolTreasury()` degistiginde
        // sahte curve'un ucret alicisi da degisir.
        vm.prank(BUYER);
        fakeCurve.buyExactTokensOut{value: 10e18}(1e24, type(uint256).max);
        vm.prank(BUYER);
        BondingCurve(realCurve).buyExactTokensOut{value: 10e18}(1e24, type(uint256).max);
        assertEq(fakeCurve.realQuoteReserves(), BondingCurve(realCurve).realQuoteReserves());
        assertEq(fakeToken.balanceOf(BUYER), LaunchToken(realToken).balanceOf(BUYER));

        // --- 5. Ayiran TEK sey ---
        assertTrue(factory.isCanonical(realToken), "the real token must be canonical");
        assertFalse(factory.isCanonical(address(fakeToken)), "a forged launch must not be canonical");
    }

    /// Sahteci dogru salt'i tahmin etse bile adresi tutturamaz: o adrese
    /// deploy etmek yalnizca factory'nin elindedir.
    function test_aForgedTokenCannotBecomeCanonicalByGuessingTheSalt() public {
        vm.prank(ALICE);
        (address realToken,) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        bytes32 realSalt = LaunchToken(realToken).launchSalt();

        LaunchToken forged = new LaunchToken(
            "Arc Coin", "ARC", "ipfs://cid", LaunchToken(realToken).creator(), LaunchToken(realToken).curve(), realSalt
        );
        assertEq(forged.launchSalt(), realSalt);
        assertFalse(factory.isCanonical(address(forged)));
    }

    /// Bir factory yalnizca KENDI urettigini tanir. CREATE2 adresi deployer'i
    /// icerdigi icin bu bedavaya gelir, ama test edilmezse ikinci bir factory
    /// (ornegin testnet profili) uretimin token'larini kutsayabilir.
    function test_aTokenFromAnotherFactoryIsNotCanonical() public {
        LaunchFactory other = _newFactory(T, V, S);

        vm.prank(ALICE);
        (address tokenA,) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(ALICE);
        (address tokenB,) = other.launch("Arc Coin", "ARC", "ipfs://cid");

        assertTrue(factory.isCanonical(tokenA));
        assertTrue(other.isCanonical(tokenB));
        assertFalse(factory.isCanonical(tokenB));
        assertFalse(other.isCanonical(tokenA));
    }

    /// `isCanonical`'in TASIYICI SATIRI bir adres esitligidir, ve o esitligin
    /// GENISLIGI test edilmeliydi -- edilmiyordu. Karsilastirmayi dusuk 96
    /// bite daraltmak (yani `uint96(uint160(...))`) 36 testlik paketi tamamen
    /// yesil birakiyor ama `isCanonical` bir sahteciye `true` diyor.
    /// Dokumante edilen ~2^80'lik carpisma isi ~2^48'e duser; bu erisilebilir.
    ///
    /// Ikiz, gercek token'in CALISMA ZAMANI KODU (immutable'lar kodun icinde
    /// tasinir: creator, curve, launchSalt) ve string slot'lari (name, symbol,
    /// metadataURI) baska bir adrese kopyalanarak kurulur; ikiz alti alanin
    /// ALTISINI DA bire bir ayni dondurur ve yalnizca ADRESI ayrisir.
    ///
    /// TEST GENISLIK-AGNOSTIKTIR ve bu bilerekdir. Onceki hali TEK bir ikiz
    /// kuruyordu (`token ^ (1 << 159)`) ve iddiasi `uint96(twin) ==
    /// uint96(token)` idi -- yani BIR daraltmaya gore yazilmisti, ozellige
    /// gore degil. Ayna yonu (yuksek bitleri karsilastirmak) o testi tamamen
    /// yesil birakiyordu ve `token ^ 1` ikizi KANONIK saymiyordu; ustelik
    /// hedefli grinding ~2^64'e, hedefsiz dogum-gunu isi ~2^32'ye duserek
    /// kapatilmaya calisilan ~2^48'den DAHA KOTU oluyordu.
    ///
    /// Bit indeksi 0..159 arasinda dolasilarak TEK BIT ceviren her ikiz
    /// denenir. Bu, her iki yonu ve aradaki her daraltmayi tek seferde
    /// oldurur -- ve ozel durum eklemeye devam etme tesvikini kaldirir.
    function testFuzz_noSingleBitTwinOfACanonicalTokenIsCanonical() public {
        vm.prank(ALICE);
        (address token,) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        assertTrue(factory.isCanonical(token));

        // FIXTURE ON KOSULU -- testin butun oldurme gucu buna dayanir.
        // `vm.etch` + slot 0..7, 31 BAYTTAN UZUN bir dizeyi YENIDEN URETMEZ:
        // uzun dizeler ayri slot'lara tasar ve ikizde SIFIR olarak geri gelir.
        // Fixture uzarsa ikiz alan-esdegerligini kaybeder, `isCanonical(twin)`
        // YANLIS SEBEPLE false doner, ve dusuk-yon daraltma mutantlari (M40 ve
        // maske varyanti) hayatta kalir -- olculdu. Bu yuzden kosul
        // varsayilmaz, IDDIA EDILIR.
        assertLe(bytes(LaunchToken(token).name()).length, 31, "fixture name must fit one slot");
        assertLe(bytes(LaunchToken(token).symbol()).length, 31, "fixture symbol must fit one slot");
        assertLe(bytes(LaunchToken(token).metadataURI()).length, 31, "fixture URI must fit one slot");

        bytes memory code = token.code;
        bytes32[8] memory slots;
        for (uint256 i = 0; i < 8; i++) {
            slots[i] = vm.load(token, bytes32(i));
        }
        bool stringsChecked = false;

        for (uint256 bit = 0; bit < 160; bit++) {
            address twin = address(uint160(uint256(uint160(token)) ^ (uint256(1) << bit)));
            // Kurulumun kendisini bozacak carpismalar disarida birakilir.
            if (twin == address(0) || twin == address(factory) || twin == address(escrow)) continue;
            if (twin == LaunchToken(token).curve() || twin == address(this)) continue;

            vm.etch(twin, code);
            for (uint256 i = 0; i < 8; i++) {
                vm.store(twin, bytes32(i), slots[i]);
            }

            // Ikiz gercekten AYIRT EDILEMEZ. Uc immutable HER ZAMAN esittir --
            // calisma zamani kodunun icinde tasinirlar ve `vm.etch` onlari tek
            // basina yeniden uretir -- yani bu uc iddia `vm.store` kopyasinin
            // CALISIP CALISMADIGINI SOYLEMEZ.
            assertEq(LaunchToken(twin).creator(), LaunchToken(token).creator());
            assertEq(LaunchToken(twin).curve(), LaunchToken(token).curve());
            assertEq(LaunchToken(twin).launchSalt(), LaunchToken(token).launchSalt());

            // Soyleyen sey BUDUR ve IKINCI ON KOSULU kapatir: dizeler
            // STORAGE'dadir, yani yalnizca `metadataURI` slot 0..7 ARALIGINDA
            // durdugu surece kopyalanirlar. Bugun slot 5'te; `LaunchToken`'a
            // UC yeni durum degiskeni eklemek onu 8'e iter ve ikizin URI'si
            // BOS doner -- o noktada dongu yesil kalir ama M40 hayatta kalir.
            // Olculdu. Kosul yorumla degil iddiayla tutulur, cunku yorum
            // `LaunchToken` degistiginde sessizce yanlislasir; Faz 1d alan
            // ekleyebilir.
            //
            // Yalnizca ILK ikizde calisir: kosul dongu boyunca sabittir ve her
            // yinelemede uc dize karsilastirmak gazi gereksiz buyutur.
            if (!stringsChecked) {
                stringsChecked = true;
                assertEq(LaunchToken(twin).name(), LaunchToken(token).name(), "etch lost the name slot");
                assertEq(LaunchToken(twin).symbol(), LaunchToken(token).symbol(), "etch lost the symbol slot");
                assertEq(
                    LaunchToken(twin).metadataURI(),
                    LaunchToken(token).metadataURI(),
                    "etch lost the metadataURI slot -- is it still within slots 0..7?"
                );
            }

            assertFalse(factory.isCanonical(twin), "a single-bit twin must not be canonical");
        }
        assertTrue(stringsChecked, "the loop must have run at least one twin");
    }

    /// Genislik testinin kurulumunun gercekten ayirt edilemez oldugunu, dizeler
    /// dahil, tek bir ikiz uzerinde ayrica sabitler. (Dongudeki testte her
    /// yinelemede uc dize karsilastirmak gazi gereksiz buyutuyor.)
    function test_anEtchedTwinIsByteIdenticalOnEveryFieldIsCanonicalReads() public {
        vm.prank(ALICE);
        (address token,) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        address twin = address(uint160(uint256(uint160(token)) ^ 1));
        vm.etch(twin, token.code);
        for (uint256 i = 0; i < 8; i++) {
            vm.store(twin, bytes32(i), vm.load(token, bytes32(i)));
        }

        assertEq(LaunchToken(twin).name(), LaunchToken(token).name());
        assertEq(LaunchToken(twin).symbol(), LaunchToken(token).symbol());
        assertEq(LaunchToken(twin).metadataURI(), LaunchToken(token).metadataURI());
        assertEq(LaunchToken(twin).creator(), LaunchToken(token).creator());
        assertEq(LaunchToken(twin).curve(), LaunchToken(token).curve());
        assertEq(LaunchToken(twin).launchSalt(), LaunchToken(token).launchSalt());
        assertEq(LaunchToken(twin).totalSupply(), LaunchToken(token).totalSupply());

        assertFalse(factory.isCanonical(twin));
    }

    /// Salt'in ENJEKTIF olmasi gerekir. `abi.encode` uzunluk-onekli oldugu
    /// icin oyle; `abi.encodePacked`'a gecmek butun paketi yesil birakir ama
    /// bitisik alanlarin sinirini yok eder ve iki FARKLI launch ayni curve
    /// adresine duser -- curve'un initcode'unda metadata YOKTUR, dolayisiyla
    /// salt onun tek ayiricisidir.
    ///
    /// `launch` uzerinden somurulebilir DEGILDIR (monoton nonce salt'lari
    /// zaten ayirir) ve `isCanonical` etkilenmez; onemi, mevcut testlerin
    /// koru olan sekli olmasidir:
    /// `test_predictAddressesMatchesWhatLaunchActuallyDeploys` factory'den
    /// tureyen IKI degeri karsilastirir, yani her iki salt yerine de AYNI
    /// mutasyon uygulandiginda hicbir sey gormez.
    function test_theSaltSeparatesAdjacentMetadataFields() public view {
        (address tokenA, address curveA) = factory.predictAddresses(ALICE, "ab", "c", "", 0);
        (address tokenB, address curveB) = factory.predictAddresses(ALICE, "a", "bc", "", 0);
        assertTrue(curveA != curveB, "name|symbol boundary collapsed in the salt");
        assertTrue(tokenA != tokenB);

        (, address curveC) = factory.predictAddresses(ALICE, "a", "b", "c", 0);
        (, address curveD) = factory.predictAddresses(ALICE, "a", "bc", "", 0);
        assertTrue(curveC != curveD, "symbol|uri boundary collapsed in the salt");
    }

    /// Kodsuz adresler icin `false`; revert DEGIL.
    function test_isCanonicalIsFalseForAddressesWithNoCode() public view {
        assertFalse(factory.isCanonical(address(0)));
        assertFalse(factory.isCanonical(ALICE));
        assertFalse(factory.isCanonical(address(0xDEAD)));
    }

    /// ACIK BIRAKILAN HUCRE, bilerek pinlenmistir. `isCanonical` token'in
    /// alanlarini dogrudan okur; `launchSalt()` selector'u OLMAYAN bir
    /// kontrat verilirse cagri revert eder, `false` DONMEZ. Fail-closed'dur
    /// (kanonik saymaz) ve zincir disi cagiran icin revert = "kanonik degil"
    /// demektir; ama davranis pinlenmezse sessizce degisebilir.
    function test_isCanonicalRevertsForAContractThatIsNotALaunchToken() public {
        vm.prank(ALICE);
        (, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        (bool ok,) = address(factory).staticcall(abi.encodeCall(LaunchFactory.isCanonical, (curve)));
        assertFalse(ok, "isCanonical is expected to revert, not return, on a non-LaunchToken contract");

        (ok,) = address(factory).staticcall(abi.encodeCall(LaunchFactory.isCanonical, (address(escrow))));
        assertFalse(ok);
    }

    /// Kanoniklik ticaretten SONRA da bozulmaz: yalnizca immutable alanlarin
    /// fonksiyonudur.
    function testFuzz_everyLaunchIsCanonical(string calldata n, string calldata s, string calldata u) public {
        string memory name_ = _fit(n, 32, "n");
        string memory symbol_ = _fit(s, 13, "s");
        string memory uri_ = _fit(u, 200, "");

        vm.prank(ALICE);
        (address token,) = factory.launch(name_, symbol_, uri_);
        assertTrue(factory.isCanonical(token));
    }

    function testFuzz_everyLaunchIsCanonicalForAnyCreator(address creator_) public {
        vm.assume(creator_ != address(0));
        vm.assume(creator_.code.length == 0);
        vm.prank(creator_);
        (address token,) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        assertTrue(factory.isCanonical(token));
        assertEq(LaunchToken(token).creator(), creator_);
    }

    // ---------------------------------------------------------------
    // Launch'in urettigi durum
    // ---------------------------------------------------------------

    function test_theEntireSupplyIsAtTheCurveAfterLaunch() public {
        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(LaunchToken(token).totalSupply(), N);
        assertEq(LaunchToken(token).balanceOf(curve), N);
        assertEq(LaunchToken(token).balanceOf(ALICE), 0);
        assertEq(LaunchToken(token).balanceOf(address(factory)), 0);
    }

    /// Factory YALNIZCA kendi bastigi token'i bind eder. Bu, Task 2'den
    /// devreden birinci yukumluluktur: `bind`'in bakiye korumasi bir
    /// yapilandirma kontroludur, mulkiyet kaniti degildir.
    function test_launchBindsTheCurveToTheTokenItMinted() public {
        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(BondingCurve(curve).token(), token);
        assertEq(LaunchToken(token).curve(), curve);
        assertEq(BondingCurve(curve).factory(), address(factory));
        assertEq(BondingCurve(curve).creator(), ALICE);
    }

    /// `bind`'e baska yol yok: factory disindaki herkes `NotFactory`, factory
    /// dahil herkes `AlreadyBound` alir. Ikincisi tasiyicidir -- ileride
    /// factory'ye ikinci bir bind yolu eklense bile curve zaten baglidir.
    function test_noSecondPathToBindExistsOnALaunchedCurve() public {
        vm.prank(ALICE);
        (, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        LaunchToken evil = new LaunchToken("Arc Coin", "ARC", "ipfs://cid", ALICE, curve, bytes32(0));

        vm.prank(BOB);
        vm.expectRevert(BondingCurve.NotFactory.selector);
        BondingCurve(curve).bind(address(evil));

        vm.prank(address(factory));
        vm.expectRevert(BondingCurve.AlreadyBound.selector);
        BondingCurve(curve).bind(address(evil));
    }

    function test_theLaunchedCurveIsImmediatelyTradeable() public {
        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        vm.prank(BUYER);
        BondingCurve(curve).buyExactQuoteIn{value: 1e18}(0);

        assertGt(LaunchToken(token).balanceOf(BUYER), 0);
        assertLt(BondingCurve(curve).realTokenReserves(), S);
        assertTrue(factory.isCanonical(token), "trading must not affect canonicality");
    }

    function test_twoLaunchesWithIdenticalMetadataProduceDifferentAddresses() public {
        vm.prank(ALICE);
        (address t1, address c1) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(ALICE);
        (address t2, address c2) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertTrue(t1 != t2);
        assertTrue(c1 != c2);
        assertTrue(LaunchToken(t1).launchSalt() != LaunchToken(t2).launchSalt());
        assertTrue(factory.isCanonical(t1));
        assertTrue(factory.isCanonical(t2));
    }

    function test_twoCreatorsWithIdenticalMetadataProduceDifferentAddresses() public {
        vm.prank(ALICE);
        (address t1, address c1) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BOB);
        (address t2, address c2) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertTrue(t1 != t2);
        assertTrue(c1 != c2);
        assertEq(LaunchToken(t1).creator(), ALICE);
        assertEq(LaunchToken(t2).creator(), BOB);
    }

    function test_launchCountIncrementsOncePerLaunch() public {
        assertEq(factory.launchCount(), 0);
        vm.prank(ALICE);
        factory.launch("a", "A", "");
        assertEq(factory.launchCount(), 1);
        vm.prank(BOB);
        factory.launch("b", "B", "");
        assertEq(factory.launchCount(), 2);
    }

    function test_predictAddressesMatchesWhatLaunchActuallyDeploys() public {
        (address pToken, address pCurve) = factory.predictAddresses(ALICE, "Arc Coin", "ARC", "ipfs://cid", 0);
        assertEq(pToken.code.length, 0, "predict must not deploy anything");
        assertEq(pCurve.code.length, 0, "predict must not deploy anything");

        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(token, pToken);
        assertEq(curve, pCurve);

        // Ikinci launch'in nonce'u 1'dir ve o da onceden bilinebilir.
        (address pToken2, address pCurve2) = factory.predictAddresses(ALICE, "Arc Coin", "ARC", "ipfs://cid", 1);
        vm.prank(ALICE);
        (address token2, address curve2) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        assertEq(token2, pToken2);
        assertEq(curve2, pCurve2);
    }

    /// Olay indexer'in ihtiyac duydugu HER alani tasimali. `recordLogs` ile
    /// okunur; `expectEmit` beklenen degerleri `predictAddresses`'ten almak
    /// zorunda birakirdi ve test dairesel olurdu.
    function test_launchEmitsLaunchedWithEveryFieldTheIndexerNeeds() public {
        vm.recordLogs();
        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(factory)) continue;
            if (logs[i].topics[0] != keccak256("Launched(address,address,address,string,string,string,bytes32)")) {
                continue;
            }
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), curve);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), ALICE);
            (string memory n, string memory s, string memory u, bytes32 salt) =
                abi.decode(logs[i].data, (string, string, string, bytes32));
            assertEq(n, "Arc Coin");
            assertEq(s, "ARC");
            assertEq(u, "ipfs://cid");
            assertEq(salt, LaunchToken(token).launchSalt());
        }
        assertTrue(found, "Launched was never emitted");
    }

    /// Kullanici karari: launch UCRETSIZ. Ne factory ne escrow bakiye alir ve
    /// `launch` payable DEGILDIR -- deger gonderen bir cagri revert eder.
    function test_launchIsFreeAndTakesNoFee() public {
        uint256 before = ALICE.balance;

        vm.prank(ALICE);
        factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(ALICE.balance, before);
        assertEq(address(factory).balance, 0);
        assertEq(address(escrow).balance, 0);

        vm.prank(ALICE);
        (bool ok,) = address(factory).call{value: 1 wei}(
            abi.encodeWithSignature("launch(string,string,string)", "Arc Coin", "ARC", "ipfs://cid")
        );
        assertFalse(ok, "launch must not be payable");
    }

    function test_aContractCanLaunchAndIsRecordedAsTheCreator() public {
        ContractLauncher launcher = new ContractLauncher();
        (address token, address curve) = launcher.go(factory, "Arc Coin", "ARC", "ipfs://cid");

        assertEq(LaunchToken(token).creator(), address(launcher));
        assertEq(BondingCurve(curve).creator(), address(launcher));
        assertTrue(factory.isCanonical(token));
    }

    // ---------------------------------------------------------------
    // Metadata kapilari
    // ---------------------------------------------------------------

    function test_launchRevertsOnEmptyName() public {
        vm.prank(ALICE);
        vm.expectRevert(LaunchFactory.EmptyName.selector);
        factory.launch("", "ARC", "ipfs://cid");
    }

    function test_launchRevertsOnEmptySymbol() public {
        vm.prank(ALICE);
        vm.expectRevert(LaunchFactory.EmptySymbol.selector);
        factory.launch("Arc Coin", "", "ipfs://cid");
    }

    /// Bos URI kabul edilir -- token katmani da kabul ediyor ve ne spec ne
    /// pump.fun bos olmama sarti koyuyor.
    function test_launchAcceptsAnEmptyUri() public {
        vm.prank(ALICE);
        (address token,) = factory.launch("Arc Coin", "ARC", "");
        assertEq(bytes(LaunchToken(token).metadataURI()).length, 0);
        assertTrue(factory.isCanonical(token));
    }

    /// Uzunluk tavanlari TOKEN katmanindadir ve factory onlari kopyalamaz;
    /// launch fail-closed olarak token'in hatasiyla doner.
    function test_launchPropagatesTheTokenMetadataLimits() public {
        vm.prank(ALICE);
        vm.expectRevert(LaunchToken.NameTooLong.selector);
        factory.launch("123456789012345678901234567890123", "ARC", "u"); // 33

        vm.prank(ALICE);
        vm.expectRevert(LaunchToken.SymbolTooLong.selector);
        factory.launch("Arc Coin", "12345678901234", "u"); // 14

        vm.prank(ALICE);
        vm.expectRevert(LaunchToken.UriTooLong.selector);
        factory.launch("Arc Coin", "ARC", new string(201));
    }

    // ---------------------------------------------------------------
    // Profil: factory ne tasiyorsa curve onu tasir
    // ---------------------------------------------------------------

    /// MC5'in dersi: immutable'lari kontrol etmek YETMEZ, CANLI rezervler de
    /// kontrol edilmeli. Ayni ders factory katmaninda tekrar edilir.
    function test_everyLaunchedCurveCarriesTheFactoryProfile() public {
        vm.prank(ALICE);
        (, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(BondingCurve(curve).INITIAL_VIRTUAL_TOKEN_RESERVES(), T);
        assertEq(BondingCurve(curve).INITIAL_VIRTUAL_QUOTE_RESERVES(), V);
        assertEq(BondingCurve(curve).INITIAL_REAL_TOKEN_RESERVES(), S);
        assertEq(BondingCurve(curve).virtualTokenReserves(), T);
        assertEq(BondingCurve(curve).virtualQuoteReserves(), V);
        assertEq(BondingCurve(curve).realTokenReserves(), S);
        assertEq(BondingCurve(curve).escrow(), address(escrow));
        assertEq(BondingCurve(curve).protocolTreasury(), TREASURY);
    }

    /// Testnet factory'sinin urettigi curve URETIM fiyatlarindan ISLEM
    /// YAPMAMALI. Sadece immutable'lari degil canli rezervleri de karsilastir.
    function test_aTestnetFactoryStampsTheTestnetProfileOnEveryCurve() public {
        LaunchFactory testnet = _newFactory(T, V_TESTNET, S);

        vm.prank(ALICE);
        (, address curve) = testnet.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(testnet.VIRTUAL_QUOTE_RESERVES(), V_TESTNET);
        assertEq(BondingCurve(curve).INITIAL_VIRTUAL_QUOTE_RESERVES(), V_TESTNET);
        assertEq(BondingCurve(curve).virtualQuoteReserves(), V_TESTNET, "live reserves ignored the factory profile");
        assertEq(BondingCurve(curve).INITIAL_VIRTUAL_TOKEN_RESERVES(), T);
        assertEq(BondingCurve(curve).virtualTokenReserves(), T);
        assertEq(BondingCurve(curve).INITIAL_REAL_TOKEN_RESERVES(), S);
        assertEq(BondingCurve(curve).realTokenReserves(), S);

        // Ayni token miktari testnet'te tam 1000 kat ucuza gelmeli.
        //
        // Esitlik `+1` yuzunden ciplak bolmeyle KURULAMAZ: `quoteBuyCost`
        // floor(...) + 1 dondurur, yani prodQ = floor(A) + 1 ve
        // testQ = floor(A/1000) + 1. `+1`'ler cikarilinca kalan iliski TAM'dir
        // (floor(floor(A)/1000) == floor(A/1000)); asagidaki iddia bu yuzden
        // yaklasik degil kesindir.
        vm.prank(ALICE);
        (, address prodCurve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve).buyExactTokensOut{value: 100e18}(1e24, type(uint256).max);
        vm.prank(BUYER);
        BondingCurve(prodCurve).buyExactTokensOut{value: 100e18}(1e24, type(uint256).max);
        uint256 prodQ = BondingCurve(prodCurve).realQuoteReserves();
        uint256 testQ = BondingCurve(curve).realQuoteReserves();
        assertEq((prodQ - 1) / 1000, testQ - 1, "the testnet curve did not trade at 1/1000 of production");
    }

    // ---------------------------------------------------------------
    // Dejenere profiller -- Task 2'den devreden ikinci yukumluluk
    // ---------------------------------------------------------------

    /// Uretim profilinin acilis piyasa degeri tam 4.000 USDC, testnet'inki tam
    /// 4 USDC. ELLE hesaplanir (V*N/T), kutuphane cagrilmaz: testin kendi
    /// kaynagini dogrulamasi bu projenin defalarca yakaladigi totolojidir.
    function test_theTwoBlessedProfilesOpenAtFourThousandAndFourUsdc() public view {
        assertEq((V * N) / T, 4000e18);
        assertEq((V_TESTNET * N) / T, 4e18);
        // Taban, iki kutsanmis profilin KUCUGUNE tam oturur.
        assertEq(factory.MIN_OPENING_MARKET_CAP(), 4e18);
        assertEq(factory.MIN_OPENING_MARKET_CAP(), (V_TESTNET * N) / T);
    }

    function test_theTestnetProfileIsAcceptedExactlyAtTheFloor() public {
        LaunchFactory testnet = _newFactory(T, V_TESTNET, S);
        assertEq(testnet.VIRTUAL_QUOTE_RESERVES(), V_TESTNET);

        // Bir wei asagisi REDDEDILIR: sinir tam olarak burada.
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, V_TESTNET - 1, S);
    }

    function test_constructorRejectsAnOpeningMarketCapBelowTheFloor() public {
        // Brief'in ornegi: V = 1 ile tum satis arzi uc wei'ye satiliyor.
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, 1, S);

        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, 0, S);
    }

    /// TASIYICI: taban `V`'ye DEGIL `V*N/T` uclusune konur. `V`'ye konan her
    /// taban `T`'yi buyuterek asilirdi.
    ///
    /// PROFIL, ALTI KORUMANIN BESINI DE GECER ve yalnizca piyasa degerini
    /// ihlal eder -- yani rediin sebebi tek basina belirlenmistir. `S`,
    /// verilen `T` icin `S + D <= N` saglayan EN BUYUK degerdir, dolayisiyla
    /// `S + D` bandin tam ustunde (`= N`) oturur:
    ///
    ///   T = 1_010_000_000e18
    ///   S =   909_501_243_788_791_097_297_807_355   (= sMax(T))
    ///   D =    90_498_756_211_208_902_702_192_645,  S + D = N TAM
    ///   V = 4,03e18 -> M = 3_990_099_009_900_990_099 < 4e18   RED
    ///                  R = 36_470_998_753_117_187_788 >= taban (sebep bu degil)
    ///                  ve V = 4,03e18 CIPLAK bir `V >= 4e18` tabanini GECERDI
    ///   V = 4,04e18 -> M = 4e18 TAM                            KABUL
    ///
    /// Ayni `T` ve ayni `S` ile yalnizca `V/T` orani karari degistiriyor.
    function test_theFloorCannotBeDefeatedByRaisingTheTokenReserves() public {
        uint256 t6 = 1_010_000_000e18;
        uint256 s6 = 909_501_243_788_791_097_297_807_355;
        uint256 d6 = (s6 * (t6 - s6)) / t6;

        // Reddin sebebi YALNIZCA piyasa degeri olmali.
        assertLt(s6, t6);
        assertGt(d6, 0);
        assertEq(s6 + d6, N, "S must be the largest one this T admits");
        assertGe(s6 + d6, factory.MIN_SALE_AND_SEED());
        assertGe((4.03e18 * s6) / (t6 - s6), factory.MIN_GRADUATION_RAISE(), "must pass the raise floor");
        assertLt((4.03e18 * N) / t6, 4e18, "the market cap must be the only violation");
        assertGe(uint256(4.03e18), factory.MIN_OPENING_MARKET_CAP(), "a bare V-floor would have accepted it");

        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(t6, 4.03e18, s6);

        // Ayni T ve S, yalnizca V buyutuldu -> oran geri geliyor.
        LaunchFactory ok = _newFactory(t6, 4.04e18, s6);
        assertEq((4.04e18 * N) / t6, 4e18, "the accepted profile must sit exactly on the floor");
        assertEq(ok.VIRTUAL_QUOTE_RESERVES(), 4.04e18);
        assertEq(ok.SALE_SUPPLY(), s6);
    }

    /// `poolSeedSupply(S, T) == 0` hicbir curve invariant'ini bozmaz, o yuzden
    /// curve'de korumasi yoktur -- ama Faz 2'ye sifir tohumlu bir graduation
    /// devrederdi. Uc dejenere sekil de burada elenir.
    function test_constructorRejectsAProfileWithAZeroPoolSeed() public {
        // S = 1  ->  D = floor(1*(T-1)/T) = 0
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, V, 1);

        // T - S = 1  ->  D = floor((T-1)*1/T) = 0
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, V, T - 1);

        // S = 0
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, V, 0);

        // KABUL EDILEN TARAF, `D == 1`. Koruma `== 0` diye kurulur, `<= 1`
        // diye degil, ve sinirin ustu ayrica pinlenmelidir.
        //
        // `D` yalnizca UCLARDA kucuktur; `S + D` bandi kucuk-`S` ucunu tamamen
        // kestigi icin geriye buyuk-`S` ucu kalir. `T = N` alinirsa
        // `S = T - 2` hem `D = 1` verir hem de `S + D = N - 1` ile bandin
        // icinde kalir:
        //   T = 1e27, S = T - 2  ->  D = floor((T-2)*2/T) = 1
        //                            S + D = N - 1  (tavanin altinda, tabanin ustunde)
        //                            M = V = 4e18,  R = V(T-2)/2  devasa
        //
        // FAZ 2 BU KABUL TARAFINI DA ULASILAMAZ KILDI. `D == 1` yalnizca
        // `T - S` COK KUCUKKEN olur (burada 2), ve o zaman
        // `scaled = (T-S)*1e12 = 2e12` iken `Vq_final = V*T/(T-S)` devasa
        // olur; `scaled <= Vq_final >> 64` saglanir ve `isSeedable` false
        // doner. Cikis yolu V'yi kucultmektir ama piyasa degeri tabani
        // V >= 4e18 ister -- ve tarama (T, S, V) uzerinde BOS kume verdi.
        // Yani `D == 1` bir daha deploy EDILEMEZ; sinirin ustu artik
        // `ProfileNotSeedable` tarafindan tutuluyor ve pinlenen budur.
        vm.expectRevert(LaunchFactory.ProfileNotSeedable.selector);
        _newFactory(N, 4e18, N - 2);
    }

    // ---------------------------------------------------------------
    // Faz 2: feeSchedule ve feeScheduleOf
    // ---------------------------------------------------------------

    /// `feeScheduleOf` IKI IS YAPAR VE IKINCISI VARLIK SEBEBIDIR: hook'a
    /// SABIT GAZLI, sahteciilige kapali bir kanoniklik kaniti verir.
    /// `feeScheduleOf[token] != 0` <=> bu factory o token'i uretti.
    function test_feeScheduleOfIsWrittenForEveryLaunchAndZeroForAForgedToken() public {
        vm.prank(ALICE);
        (address token,) = factory.launch("Arc", "ARC", "ipfs://a");
        assertEq(factory.feeScheduleOf(token), address(FEE_SCHEDULE), "launch schedule'i dondurmadi");
        assertEq(factory.feeSchedule(), address(FEE_SCHEDULE));

        // Ikinci bir launch da AYNI schedule'i alir -- tablo factory basina
        // sabittir, launch basina degil.
        vm.prank(ALICE);
        (address token2,) = factory.launch("Arc2", "ARC2", "ipfs://b");
        assertEq(factory.feeScheduleOf(token2), address(FEE_SCHEDULE));

        // SAHTE token: bu factory uretmedi, dolayisiyla SIFIR.
        assertEq(factory.feeScheduleOf(address(0xF04CED)), address(0), "sahte token schedule tasiyor");
        assertEq(factory.feeScheduleOf(address(0)), address(0));

        // Ve iki yol AYNI cevabi verir: mapping'in kanoniklik kaniti olmasi
        // tam olarak budur.
        assertTrue(factory.isCanonical(token));
        assertTrue(factory.feeScheduleOf(token) != address(0));
        assertFalse(factory.isCanonical(address(0xF04CED)));
        assertEq(factory.feeScheduleOf(address(0xF04CED)), address(0));
    }

    /// `FeeScheduleAssigned` `Launched`DAN ONCE yayilir -- defter yazimi her
    /// sonraki olaydan ve her dis cagridan once biter.
    function test_theScheduleAssignmentIsEmittedBeforeLaunched() public {
        vm.recordLogs();
        vm.prank(ALICE);
        (address token,) = factory.launch("Arc", "ARC", "ipfs://a");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 assignedAt = type(uint256).max;
        uint256 launchedAt = type(uint256).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("FeeScheduleAssigned(address,address)")) assignedAt = i;
            if (logs[i].topics[0] == keccak256("Launched(address,address,address,string,string,string,bytes32)")) {
                launchedAt = i;
            }
        }
        assertTrue(assignedAt != type(uint256).max, "FeeScheduleAssigned yayilmadi");
        assertTrue(launchedAt != type(uint256).max, "Launched yayilmadi");
        assertLt(assignedAt, launchedAt, "atama Launched'dan SONRA yayilmis");
        assertEq(logs[assignedAt].topics[1], bytes32(uint256(uint160(token))));
    }

    /// KOD KONTROLU treasury/governor'da YOKKEN burada VARDIR ve fark
    /// yapisaldir: schedule bir odeme ALICISI degil, CAGRILAN bir kontrattir.
    function test_theFeeScheduleMustBeNonZeroAndHaveCode() public {
        vm.expectRevert(LaunchFactory.ZeroFeeSchedule.selector);
        new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(0));

        vm.expectRevert(LaunchFactory.FeeScheduleHasNoCode.selector);
        new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(0xDEAD));

        // KONTROL: kodu olan bir adresle GECER.
        LaunchFactory ok = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(ok.feeSchedule(), address(FEE_SCHEDULE));
    }

    /// TEK-IHLAL TANIGI, `ProfileNotSeedable` ICIN. Deponun
    /// `GraduationRaiseTooSmall` dersi aynen gecerlidir: tek bir tanik iki
    /// korumayi birden ihlal ediyorsa hangisinin reddettigi OLCULEMEZ.
    /// Bu uclu OBUR BES korumadan da gecer ve YALNIZCA seedability'yi ihlal
    /// eder; her biri asagida elle dogrulanir.
    ///
    /// Turetme: T = 2e27, S = 585_786_437_626_904_951_198_311_276, V = 30e18
    ///   Vt_final = T - S      = 1_414_213_562_373_095_048_801_688_724
    ///   R        = V*S/(T-S)  = 12_426_406_871_192_851_464
    ///   Vq_final = V + R      = 42_426_406_871_192_851_464
    ///   sinir    = (Vt_final * 1e12) >> 64
    ///            = 76_675_366_...   ->  Vq_final ONUN ALTINDA, yani
    ///   `USDC = currency0` dalinda FullMath.mulDiv TASARDI.
    function test_aProfileViolatingOnlyTheSeedabilityGuardIsRejectedByIt() public {
        uint256 t7 = 2_000_000_000e18;
        uint256 s7 = 585_786_437_626_904_951_198_311_276;
        uint256 v7 = 30e18;
        uint256 d7 = (s7 * (t7 - s7)) / t7;

        // OBUR BES KORUMA: hepsi GECIYOR.
        assertLt(s7, t7, "S < T");
        assertGt(d7, 0, "D > 0");
        assertLe(s7 + d7, N, "S + D tavanin altinda");
        assertGe(s7 + d7, factory.MIN_SALE_AND_SEED(), "S + D tabanin ustunde");
        assertGe((v7 * N) / t7, factory.MIN_OPENING_MARKET_CAP(), "piyasa degeri tabani gecildi");
        assertGe((v7 * s7) / (t7 - s7), factory.MIN_GRADUATION_RAISE(), "raise tabani gecildi");

        // Geriye TEK sebep kalir.
        vm.expectRevert(LaunchFactory.ProfileNotSeedable.selector);
        _newFactory(t7, v7, s7);

        // KONTROL: ayni T ve S, seedable bir V ile KABUL. Bu olmadan test
        // "herhangi bir sebeple reddedildi"yi de gecerdi.
        LaunchFactory ok = _newFactory(t7, 60e18, s7);
        assertEq(ok.SALE_SUPPLY(), s7);
    }

    /// TEK-IHLAL TANIGI, `D == 0` korumasi icin. Onceki tanıklarin hepsi
    /// (`S = 1`, `S = 0`, `S = T-1`) BASKA korumalari da ihlal ediyordu, yani
    /// bu korumanin dogrulanmasi tamamen SIRAYA baglıydi. `T = N` ve
    /// `S = T - 1` bunu izole eder: `D = 0` disinda her sey gecerli.
    function test_aProfileViolatingOnlyThePoolSeedGuardIsRejectedByIt() public {
        uint256 sSole = N - 1; // T = N

        assertEq((sSole * (N - sSole)) / N, 0, "D must be zero");
        assertLe(sSole + 0, N, "must pass the ceiling");
        assertGe(sSole + 0, factory.MIN_SALE_AND_SEED(), "must pass the sale+seed floor");
        assertGe((4e18 * N) / N, 4e18, "must pass the market-cap floor");
        assertGe((4e18 * sSole) / (N - sSole), factory.MIN_GRADUATION_RAISE(), "must pass the raise floor");

        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(N, 4e18, sSole);
    }

    /// Bir profil DORT korumadan da gecip yine de HICBIR SEY LAUNCH EDEMEZ:
    /// `S + D > N` ise curve arzin tamamini alsa bile satmayi ve tohumlamayi
    /// planladigi miktari karsilayamaz, ve `bind` her seferinde
    /// `TokenBalanceBelowSaleAndSeed` ile doner. Incelemenin tanigi
    /// `S = 900_000_000e18`: `D = 1,451e26`, `M = 4_000e18`,
    /// `R = 2,23e22` -- hepsi gecerli, ama `S + D = 1,045e27 > 1e27`.
    ///
    /// Bu bir PROFIL hatasidir; bedelini ilk creator odememeli ve hatayi
    /// baska bir katman soylememeli. Deploy aninda, factory'nin kendi
    /// hatasiyla elenir.
    function test_constructorRejectsAProfileWhoseSaleAndSeedExceedTheSupply() public {
        uint256 sWitness = 900_000_000e18;

        // Once tanigin OBUR UC korumadan gectigini elle dogrula.
        assertLt(sWitness, T);
        assertGt((sWitness * (T - sWitness)) / T, 0, "witness must pass the pool-seed guard");
        assertGe((V * N) / T, 4e18, "witness must pass the market-cap floor");
        assertGe((V * sWitness) / (T - sWitness), factory.MIN_GRADUATION_RAISE(), "witness must pass the raise floor");
        // ...ve `S + D`'nin gercekten arzi astigini.
        assertGt(sWitness + (sWitness * (T - sWitness)) / T, N);

        vm.expectRevert(LaunchFactory.SaleAndSeedExceedSupply.selector);
        _newFactory(T, V, sWitness);
    }

    /// SIRA TANIGI. `V = 1` ile ayni `S` ucu birden ihlal eder: tavan (`S+D>N`),
    /// piyasa degeri (`M = 0`) ve raise (`R` cok kucuk). Hangisinin
    /// raporlandigi SIRAYA baglidir ve sira baglayicidir -- tavan piyasa
    /// degerinden ve raise'den ONCE gelir. Tavani asagi tasiyan bir mutasyon
    /// ayni girdide `DegenerateProfile()` dondurur ve burada gorunur.
    function test_theCeilingIsReportedBeforeTheMarketCapAndRaiseFloors() public {
        uint256 sWitness = 900_000_000e18;
        assertGt(sWitness + (sWitness * (T - sWitness)) / T, N, "witness must violate the ceiling");
        assertLt((uint256(1) * N) / T, 4e18, "witness must ALSO violate the market-cap floor");
        assertLt((uint256(1) * sWitness) / (T - sWitness), factory.MIN_GRADUATION_RAISE(), "...and the raise floor");

        vm.expectRevert(LaunchFactory.SaleAndSeedExceedSupply.selector);
        _newFactory(T, 1, sWitness);
    }

    /// Tavanin AYNASI: profil calisir ama mint'in tuketilmeyen kismi cikisi
    /// olmayan bir curve'de sonsuza kadar kalir.
    ///
    /// TANIK, incelemenin olctugu profil: `T = 1_000e18`, `S = 739,1e18`,
    /// `V = 4_293e15`. Bes korumanin BESINI de geciyordu -- `D = 192,8e18 > 0`,
    /// `S + D = 931,9e18 <= N`, `M = 4_293e24 >> 4e18`,
    /// `R = 12_161_580_298_965_120_735 >= taban` -- ve tum satis arzi 12,16
    /// USDC'ye alinirken mint'in %99,9999'u curve'de kaliyordu. Raise tabani
    /// bunu goremez: `R` yalnizca `S/T` oranina bakar, `T` ile `S` birlikte
    /// kucultuldugunde oran degismez.
    function test_constructorRejectsAProfileThatWouldStrandMostOfTheMint() public {
        uint256 tSmall = 1_000e18;
        uint256 sSmall = 739.1e18;
        uint256 vSmall = 4_293e15;
        uint256 dSmall = (sSmall * (tSmall - sSmall)) / tSmall;

        // Once OBUR BES korumadan gectigini elle dogrula.
        assertLt(sSmall, tSmall);
        assertGt(dSmall, 0, "witness must pass the pool-seed guard");
        assertLe(sSmall + dSmall, N, "witness must pass the ceiling");
        assertGe((vSmall * N) / tSmall, 4e18, "witness must pass the market-cap floor");
        assertGe((vSmall * sSmall) / (tSmall - sSmall), factory.MIN_GRADUATION_RAISE(), "...and the raise floor");
        // ...ve mint'in ne kadarini biraktigini.
        assertLt(sSmall + dSmall, factory.MIN_SALE_AND_SEED());
        assertLt((sSmall + dSmall) * 1_000_000 / N, 1, "the witness must strand >99.9999% of the mint");

        vm.expectRevert(LaunchFactory.SaleAndSeedStrandSupply.selector);
        _newFactory(tSmall, vSmall, sSmall);
    }

    /// Taban IKI YONDEN pinlenir ve iki kutsanmis profil TAM UZERINDE oturur.
    ///
    /// TURETME (elle, kutuphane cagrilmadan):
    ///   S = 793_100_000e18,  D = floor(S(T-S)/T) = 206_886_011_183_597_390_493_942_218
    ///   S + D = 999_986_011_183_597_390_493_942_218 = MIN_SALE_AND_SEED
    /// Tavanla birlikte `S + D`'yi 13.988,82 tokenlik bir banda hapseder.
    function test_theSaleAndSeedFloorIsTheBlessedProfilesOwnValue() public view {
        uint256 d = (S * (T - S)) / T;
        assertEq(d, 206_886_011_183_597_390_493_942_218);
        assertEq(S + d, 999_986_011_183_597_390_493_942_218);
        assertEq(factory.MIN_SALE_AND_SEED(), S + d);
        assertEq(factory.MIN_SALE_AND_SEED(), 999_986_011_183_597_390_493_942_218);
        // Bitisik deger, tabanin GRANULERLIGINI sabitler: bir wei asagisi
        // gercekten ayri bir sayidir ve taban onu KABUL ETMEMELIDIR.
        assertEq((S - 1) + ((S - 1) * (T - (S - 1))) / T, 999_986_011_183_597_390_493_942_217);
        // Band genisligi: tavan eksi taban.
        assertEq(N - factory.MIN_SALE_AND_SEED(), 13_988_816_402_609_506_057_782);
    }

    /// Sinir BIR WEI ile pinlenir, obur uc korumada oldugu gibi.
    ///
    /// Onceki hali `S - 1e18` kullaniyordu -- BIR TOKEN asagisi -- ve bu
    /// olculebilir bir bosluktu: `f(S - 1e18) = MIN - 521_714_819_198_508_854`,
    /// yani tabani yarim tokene kadar gevseten HER mutasyon (`< MIN - k`,
    /// `k <= 521_714_819_198_508_854`) paketi yesil birakiyordu. `S - 1`
    /// tam bitisik degeri secer:
    ///
    ///   f(S)     = 999_986_011_183_597_390_493_942_218 = MIN
    ///   f(S - 1) = 999_986_011_183_597_390_493_942_217 = MIN - 1
    ///
    /// Sinir `factory.MIN_SALE_AND_SEED()`'ten OKUNMAZ, ELLE turetilir --
    /// raise tabani testindeki gerekcenin aynisi: okunsaydi sabiti degistiren
    /// bir mutant testin bekledigi siniri de birlikte kaydirirdi.
    function test_theSaleAndSeedFloorIsPinnedFromBelow() public {
        uint256 floor_ = S + (S * (T - S)) / T; // 999_986_011_183_597_390_493_942_218

        // Uretim S'i TAM tabandadir -- ve `floor_` elle turetildigi icin
        // asagidaki karsilastirma dairesel DEGILDIR. (Onceki hali
        // `assertEq(S + (S*(T-S))/T, floor_)` idi: bes satir once ayni ifadeyle
        // atanmis bir yerele ayni ifadeyi karsilastiriyordu, yani hicbir
        // mutasyonun ulasamayacagi bir totoloji.)
        LaunchFactory atFloor = _newFactory(T, V, S);
        assertEq(atFloor.SALE_SUPPLY(), S);
        assertEq(atFloor.MIN_SALE_AND_SEED(), floor_, "production must sit exactly at the floor");

        // Bir WEI asagisi: `S + D` tam olarak bir eksilir ve REDDEDILIR.
        uint256 sLower = S - 1;
        assertEq(sLower + (sLower * (T - sLower)) / T, floor_ - 1, "S - 1 must land exactly one wei below");

        // TANIK TEK-IHLALLI OLMAK ZORUNDA. Aksi halde `S - 1` baska bir
        // korumaya da takilirdi, `expectRevert` SIRA sayesinde yine saglanirdi
        // ve tabani gevseten mutantlar (M48, M49) paketi yesil birakirdi. Ayni
        // sekil dosyadaki obur uc tanik testinde de var; bu tanik onu miras
        // almamisti.
        assertLt(sLower, T, "must pass S < T");
        assertGt((sLower * (T - sLower)) / T, 0, "must pass the pool-seed guard");
        assertLe(sLower + (sLower * (T - sLower)) / T, N, "must pass the ceiling");
        assertGe((V * N) / T, 4e18, "must pass the market-cap floor");
        assertGe((V * sLower) / (T - sLower), factory.MIN_GRADUATION_RAISE(), "must pass the raise floor");

        vm.expectRevert(LaunchFactory.SaleAndSeedStrandSupply.selector);
        _newFactory(T, V, sLower);
    }

    /// SIRA TANIGI, taban icin. `T = uretim`, `S = 1e18`, `V = 1`: taban,
    /// piyasa degeri ve raise UCU BIRDEN ihlal edilir; taban once gelir.
    function test_theSaleAndSeedFloorIsReportedBeforeTheMarketCapAndRaiseFloors() public {
        uint256 sTiny = 1e18;
        assertLt(sTiny + (sTiny * (T - sTiny)) / T, factory.MIN_SALE_AND_SEED());
        assertLt((uint256(1) * N) / T, 4e18, "witness must ALSO violate the market-cap floor");
        assertLt((uint256(1) * sTiny) / (T - sTiny), factory.MIN_GRADUATION_RAISE(), "...and the raise floor");

        vm.expectRevert(LaunchFactory.SaleAndSeedStrandSupply.selector);
        _newFactory(T, 1, sTiny);
    }

    /// Sinir TAM OLARAK pinlenir, iki taraftan.
    ///
    /// TURETME: `f(S) = S + floor(S(T-S)/T)` monoton azalmayandir (`S < T`
    /// icin gercel tureVi `(2T-2S)/T > 0`; tabana yuvarlama adimlari 0 ya da
    /// 1 yapar, dolayisiyla dusmez), yani `f(S) <= N` kosulunu saglayan EN
    /// BUYUK `S` tektir ve ikili aramayla bulunur:
    ///
    ///   sMax    = 793_126_814_431_964_561_597_182_417
    ///   D(sMax) = 206_873_185_568_035_438_402_817_583
    ///   toplam  = 1_000_000_000_000_000_000_000_000_000 = N  TAM OLARAK
    ///   sMax+1 -> toplam = N + 1  REDDEDILIR
    ///
    /// Uretim `S`'i (793_100_000e18) bu tavanin yalnizca %0,0033 altindadir.
    function test_theSaleAndSeedCeilingIsPinnedFromBothSides() public {
        uint256 sMax = 793_126_814_431_964_561_597_182_417;

        // Toplamin TAM OLARAK N oldugunu elle dogrula (kutuphane cagrilmaz).
        assertEq(sMax + (sMax * (T - sMax)) / T, N, "sMax must saturate the supply exactly");
        assertEq((sMax + 1) + ((sMax + 1) * (T - (sMax + 1))) / T, N + 1, "sMax + 1 must exceed it by one");

        LaunchFactory atCeiling = _newFactory(T, V, sMax);
        assertEq(atCeiling.SALE_SUPPLY(), sMax);

        vm.expectRevert(LaunchFactory.SaleAndSeedExceedSupply.selector);
        _newFactory(T, V, sMax + 1);

        // Ve uretim profili tavanin ALTINDA, ama yapisik.
        assertLt(S, sMax);
        assertEq(sMax - S, 26_814_431_964_561_597_182_417);
    }

    /// Tavandaki profil yalnizca DEPLOY olmakla kalmaz, gercekten LAUNCH ve
    /// BIND eder -- yani sinir `bind`'in kabul ettigi yerle bire bir ayni.
    /// Ayri bir iddia: `bind` `bakiye >= S + D` ister ve tavan tam esitliktir.
    function test_theProfileAtTheCeilingCanStillLaunchAndBind() public {
        uint256 sMax = 793_126_814_431_964_561_597_182_417;
        LaunchFactory atCeiling = _newFactory(T, V, sMax);

        vm.prank(ALICE);
        (address token, address curve) = atCeiling.launch("Arc Coin", "ARC", "ipfs://cid");

        assertEq(BondingCurve(curve).token(), token);
        assertEq(
            BondingCurve(curve).INITIAL_REAL_TOKEN_RESERVES() + BondingCurve(curve).poolSeedSupply(),
            N,
            "the ceiling profile must consume the mint exactly"
        );
        assertTrue(atCeiling.isCanonical(token));
    }

    // ---------------------------------------------------------------
    // Graduation raise tabani -- controller kararindan sonra eklendi
    // ---------------------------------------------------------------

    /// Taban, testnet profilinin KENDI graduation raise'idir; elle turetilir
    /// ve kutuphane CAGRILMAZ.
    ///
    ///   R = floor(V * S / (T - S))
    ///   testnet: floor(4_292e15 * 793_100_000e18 / 279_900_000e18)
    ///          = 12_161_433_369_060_378_706 wei  (~12,1614 USDC)
    ///   uretim : 12_161_433_369_060_378_706_680 wei  (~12.161,43 USDC)
    ///
    /// Uretim TAM 1000 kati DEGILDIR (+680): `floor` iki farkli olcekte
    /// alinir. Ikisi de tabani gecer, testnet TAM UZERINDE oturur -- yani
    /// taban, spec'i bozmadan konabilecek EN YUKSEK degerdir; piyasa degeri
    /// tabanindaki turetmenin aynisi.
    function test_theGraduationRaiseFloorIsTheTestnetProfilesOwnRaise() public view {
        assertEq(factory.MIN_GRADUATION_RAISE(), 12_161_433_369_060_378_706);
        assertEq(factory.MIN_GRADUATION_RAISE(), (V_TESTNET * S) / (T - S));
        assertEq((V * S) / (T - S), 12_161_433_369_060_378_706_680);
        // Iki kutsanmis profil de tabani gecer; testnet esitlikle.
        assertGe((V_TESTNET * S) / (T - S), factory.MIN_GRADUATION_RAISE());
        assertGt((V * S) / (T - S), factory.MIN_GRADUATION_RAISE());
    }

    /// Iki kutsanmis profil de DEPLOY OLABILMEYE devam etmeli. Bu, tabanin
    /// yukaridan sinirlanmasidir ve ayri bir mutant (taban uretim raise'ine
    /// cikarilmis) tarafindan olculur.
    function test_bothBlessedProfilesStillDeployUnderTheRaiseFloor() public {
        LaunchFactory prod = _newFactory(T, V, S);
        LaunchFactory testnet = _newFactory(T, V_TESTNET, S);
        assertEq(prod.VIRTUAL_QUOTE_RESERVES(), V);
        assertEq(testnet.VIRTUAL_QUOTE_RESERVES(), V_TESTNET);

        // Ve ikisi de gercekten launch edebiliyor.
        vm.prank(ALICE);
        (address t1,) = prod.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(ALICE);
        (address t2,) = testnet.launch("Arc Coin", "ARC", "ipfs://cid");
        assertTrue(prod.isCanonical(t1));
        assertTrue(testnet.isCanonical(t2));
    }

    /// TEK-IHLAL TANIGI, raise tabani icin.
    ///
    /// Uretim `(S, T)`'sinde piyasa degeri ve raise tabanlari TAM OLARAK ayni
    /// `V`'de kesisir (ikisi de testnet profilinden turetilmistir), dolayisiyla
    /// orada ayrilamazlar. Ayrilabilecekleri yer `R/M = 1/((2-s)(1-s))`
    /// oraninin 1'in ALTINA dustugu yerdir, yani `s = S/T < 0,382`:
    ///
    ///   T = 2_000_000_000e18
    ///   S =   585_786_437_626_904_951_198_311_276  (= sMax(T), S + D = N TAM)
    ///   V = 8e18  -> M = 4e18 TAM (taban gecildi, esitlikle)
    ///                R = 3_313_708_498_984_760_390 < taban   RED
    ///   V = 30e18 -> R = 12_426_406_871_192_851_464 >= taban KABUL
    function test_constructorRejectsAProfileWhoseGraduationRaiseIsBelowTheFloor() public {
        uint256 t7 = 2_000_000_000e18;
        uint256 s7 = 585_786_437_626_904_951_198_311_276;
        uint256 d7 = (s7 * (t7 - s7)) / t7;

        // Once OBUR BES korumadan gectigini elle dogrula.
        assertLt(s7, t7);
        assertGt(d7, 0);
        assertEq(s7 + d7, N, "S + D must sit exactly at the ceiling");
        assertGe(s7 + d7, factory.MIN_SALE_AND_SEED());
        assertGe((8e18 * N) / t7, 4e18, "the market-cap floor must not be the reason");
        assertLt((8e18 * s7) / (t7 - s7), factory.MIN_GRADUATION_RAISE(), "the raise must be the only violation");

        vm.expectRevert(LaunchFactory.GraduationRaiseTooSmall.selector);
        _newFactory(t7, 8e18, s7);

        // Ayni T ve S, V buyutulunce KABUL.
        //
        // V = 30e18 DEGIL 60e18, VE SEBEBI FAZ 2'DIR: 30e18 ile
        // `Vq_final = 42_426_406_871_192_851_464` cikar ve bu
        // `((T-S)*1e12) >> 64 = 76_675_366_...` sinirinin ALTINDA kalir, yani
        // profil `ProfileNotSeedable` ile reddedilir. Bu bir test hilesi
        // degil, olculen bir kisittir: o profil GERCEKTEN havuz acamazdi.
        // Ayni (T, S) icin seedable olan en kucuk V 54_210_108_624_275_221_701;
        // 60e18 onun rahatca ustunde ve raise tabanini da gecer.
        LaunchFactory ok = _newFactory(t7, 60e18, s7);
        assertEq(ok.SALE_SUPPLY(), s7);
    }

    /// Raise tabaninin ILK iki tanigi -- `S = 2` (tum satis arzi UC WEI'ye) ve
    /// `S`'den `e18` dusuren operator hatasi (3.214 wei) -- hala REDDEDILIYOR,
    /// ama artik `S + D` TABANI onlari daha once yakaliyor. Ikisi de mint'in
    /// neredeyse tamamini kilitliyordu, yani yeni korumanin tarifine tam
    /// uyuyorlar. Tarih olarak degil, DAVRANIS olarak sabitlenmistir: hangi
    /// koruma yakalarsa yakalasin, bu profiller deploy EDILEMEZ.
    function test_theOriginalRaiseWitnessesAreStillRejected() public {
        vm.expectRevert(LaunchFactory.SaleAndSeedStrandSupply.selector);
        _newFactory(T, V, 2);

        vm.expectRevert(LaunchFactory.SaleAndSeedStrandSupply.selector);
        _newFactory(T, V, 793_100_000);
    }

    /// Tabani IKI YONDEN de pinler, ve tam esitlikle.
    ///
    /// `S = T/2` secilir cunku orada `R = floor(V*S/(T-S)) = V` OLUR: raise tam
    /// olarak `V`'ye indirgenir, boylece taban bir wei ustunden ve bir wei
    /// altindan yakalanabilir. `T` ise `S + D = 0,75T`'nin `S + D` bandina
    /// dusmesi icin secilir:
    ///   T = 1_333_320_000e18 -> S = T/2, D = T/4, S + D = 999_990_000e18
    ///   taban 999_986_011_183_597_390_493_942_218 <= 999_990_000e18 <= N  ✓
    /// Ayni profilde acilis piyasa degeri 9_121_166_238_457_668_606 (>> 4e18)
    /// kaldigi icin reddin sebebi yalnizca raise tabanidir.
    ///
    /// Taban `factory.MIN_GRADUATION_RAISE()`'ten OKUNMAZ, ELLE turetilir.
    /// Okunsaydi test kendine gonderme yapardi: sabiti bir wei degistiren bir
    /// mutant, testin bekledigi siniri de birlikte kaydirir ve davranis
    /// tarafi hicbir seyi yakalamazdi (olculdu -- o halde M32'yi yalnizca
    /// literal iddiasi olduruyordu).
    function test_theGraduationRaiseFloorIsPinnedFromBothSides() public {
        uint256 t7 = 1_333_320_000e18;
        uint256 half = t7 / 2;
        uint256 floor_ = (V_TESTNET * S) / (T - S); // 12_161_433_369_060_378_706

        // Kurulumun gecerliligi: S + D bandin icinde, piyasa degeri cok ustte.
        assertEq(half + (half * (t7 - half)) / t7, 999_990_000e18, "S + D must land in the band");
        assertGe(half + (half * (t7 - half)) / t7, factory.MIN_SALE_AND_SEED());
        assertLe(half + (half * (t7 - half)) / t7, N);
        assertGe((floor_ * N) / t7, 4e18, "the market-cap floor must not be the reason");

        // Tam tabanda: R == MIN_GRADUATION_RAISE.
        assertEq((floor_ * half) / (t7 - half), floor_, "S = T/2 must reduce the raise to exactly V");

        // FAZ 2 BU TANIGIN KABUL TARAFINI ULASILAMAZ KILDI, VE BU BIR
        // KAYIPTIR -- ORTULMUYOR, PINLENIYOR.
        //
        // `ProfileNotSeedable` gercek bir kisit ekler ve bu profil onu
        // GECEMEZ. Turetme (arama ile de dogrulandi: cozum kumesi BOS):
        //   S = T/2 oldugu icin R == V, yani Vq_final = 2*floor_
        //                              = 24_322_866_738_120_757_412
        //   seedability ise Vq_final > ((T-S)*1e12) >> 64
        //                              = 36_139_711_015_459_319_298 ister
        //   -> T < ~8,97e26 gerekir; ama `S + D = 0,75T` bandi T ~ 1,3333e27
        //      ister. IKI ARALIK KESISMEZ.
        // (T, S) ailesi genellestirilip R == floor_ TAM olacak sekilde tarandi
        // -- band, piyasa degeri ve seedability'yi AYNI ANDA saglayan hicbir
        // ucluk yok.
        //
        // Yani taban artik TEK YONDEN pinlenir, ve bu test o gercegi kayda
        // gecirir: tam tabanda `ProfileNotSeedable`, bir wei altinda
        // `GraduationRaiseTooSmall`. IKI FARKLI RED, ve ikisinin FARKLI
        // olmasi SIRAYI da pinler -- raise kontrolu seedability'den ONCE
        // kosar, aksi halde ikisi de ayni hatayi verirdi.
        vm.expectRevert(LaunchFactory.ProfileNotSeedable.selector);
        _newFactory(t7, floor_, half);

        // Bir wei altinda: REDDEDILIR, VE BASKA BIR SEBEPLE.
        vm.expectRevert(LaunchFactory.GraduationRaiseTooSmall.selector);
        _newFactory(t7, floor_ - 1, half);
    }

    /// `S >= T` curve'un tasiyici esitsizligini bozar ve `CurveMath`
    /// icinden `InsufficientTokenReserve()` ile patlardi; factory onu KENDI
    /// hatasiyla, deploy aninda eler.
    function test_constructorRejectsASaleSupplyNotBelowTheTokenReserves() public {
        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, V, T);

        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(T, V, T + 1);

        vm.expectRevert(LaunchFactory.DegenerateProfile.selector);
        _newFactory(0, V, 0);
    }

    /// Sifir escrow/treasury DEPLOY ANINDA elenir, ilk launch'ta degil.
    /// Curve de reddederdi (fail-closed), ama o zaman yanlis yapilandirilmis
    /// bir factory zincirde sessizce durur ve hatayi ilk creator'in islemi
    /// oderdi.
    ///
    /// Hata adlari `BondingCurve`'unkilerden AYRIDIR (`ZeroEscrowAddress` /
    /// `ZeroTreasuryAddress`), yani revert verisi hangi KATMANIN reddettigini
    /// de soyler -- Task 2'nin selector carpismasi dersinin geregi. Asagidaki
    /// iki iddia bunu ayrica sabitler.
    function test_constructorRejectsAZeroEscrowOrTreasury() public {
        vm.expectRevert(LaunchFactory.ZeroEscrowAddress.selector);
        new LaunchFactory(address(0), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        vm.expectRevert(LaunchFactory.ZeroTreasuryAddress.selector);
        new LaunchFactory(address(escrow), address(0), GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        vm.expectRevert(LaunchFactory.ZeroGovernorAddress.selector);
        new LaunchFactory(address(escrow), TREASURY, address(0), T, V, S, address(FEE_SCHEDULE));

        assertTrue(
            LaunchFactory.ZeroEscrowAddress.selector != BondingCurve.ZeroEscrow.selector,
            "factory and curve must not share an error selector"
        );
    }

    /// KODSUZ bir escrow, `SaleAndSeedExceedSupply`'in engelledigi terminal
    /// durumun BIR ADIM SONRASIDIR ve daha da gec farkedilir.
    ///
    /// Korumasiz halin olculen sonucu: factory deploy oluyor, `launch`
    /// BASARIYOR, `bind` basariyor, curve `N`'in tamamini tutuyor ve
    /// `isCanonical` **true** donuyor -- yani indexer onu gercek bir launch
    /// olarak listeliyor. Sonra HER iki alim giris noktasi da sonsuza kadar
    /// revert ediyor (`BondingCurve` her islemde `IFeeEscrow(escrow).deposit`
    /// cagirir; solc'un extcodesize kontrolu patlar) ve mint'in %100'u cikisi
    /// olmayan bir curve'de kilitli kaliyor. Hata ne deploy'da, ne creator'in
    /// launch'inda, ancak BIR ALICININ isleminde goruluyor.
    function test_constructorRejectsACodelessEscrow() public {
        vm.expectRevert(LaunchFactory.EscrowHasNoCode.selector);
        new LaunchFactory(address(0xE0A), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        // KABUL EDILEN TARAF: kodu olan bir escrow gecer ve gercekten ticaret
        // yapar -- kontrolun fazla siki olmadigini gosterir.
        LaunchFactory ok = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        vm.prank(ALICE);
        (address token, address curve) = ok.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve).buyExactQuoteIn{value: 1e18}(0);
        assertGt(LaunchToken(token).balanceOf(BUYER), 0);
    }

    /// KOD VARLIGI YETMEZ. `EscrowHasNoCode` bir adres SEKLINI eliyor, gitmek
    /// istedigi durumu degil: KODU OLAN ama yanlis turde bir escrow ile
    /// factory deploy olur, `launch` BASARIR, `isCanonical` **true** doner --
    /// yani indexer onu gercek bir launch olarak listeler -- ve sonra her alim
    /// sonsuza kadar revert eder, mint'in %100'u cikisi olmayan bir curve'de
    /// kalir. Tam olarak kod kontrolunun ENGELLEMEK ICIN yazildigi durum, bir
    /// adres sekli oteden.
    ///
    /// UC BASARISIZLIK SEKLI DE AYNI SELECTOR'U URETMELI -- `try/catch`in
    /// varlik sebebi budur; onsuz (a) ve (b) CAGRILANIN revert verisini yukari
    /// tasir ve hangi katmanin reddettigi kaybolurdu.
    function test_constructorRejectsACodedButWrongTypeEscrow() public {
        // MOCK'LAR ONCE DEPLOY EDILIR. Arguman icindeki bir `new`, `vm`in
        // "sonraki cagri"sidir ve beklentiyi KENDISI tuketir -- ilk hali
        // boyleydi ve test "revert etmedi" diye dusuyordu.
        address noMember = address(new NotALedger());
        address reverting = address(new RevertingLedger());
        address lying = address(new LyingLedger());
        address someToken = address(new LaunchToken("Arc Coin", "ARC", "ipfs://cid", ALICE, address(this), bytes32(0)));

        // (a) uye YOK (ve fallback de yok)
        vm.expectRevert(LaunchFactory.EscrowIsNotAFeeEscrow.selector);
        new LaunchFactory(noMember, TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        // (b) uye REVERT ediyor
        vm.expectRevert(LaunchFactory.EscrowIsNotAFeeEscrow.selector);
        new LaunchFactory(reverting, TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        // (c) YAPISAL OLARAK IMKANSIZ cevap
        vm.expectRevert(LaunchFactory.EscrowIsNotAFeeEscrow.selector);
        new LaunchFactory(lying, TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        // ...ve gercekci operator hatasinin kendisi: baska bir arcpad
        // kontratini yapistirmak.
        vm.expectRevert(LaunchFactory.EscrowIsNotAFeeEscrow.selector);
        new LaunchFactory(someToken, TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
    }

    /// YOKLAMA FAZLA KISITLAMIYOR -- iki kabul tanigi.
    ///
    /// (1) ZATEN KULLANIMDA olan bir escrow gecer. Bu, `totalOwed() == 0`
    ///     seklinde bir yoklamanin NEDEN yanlis olacagini sabitler: her deger
    ///     mesrudur, dolayisiyla onceden bilinen bir cevap degildir.
    ///     `owed[address(0)]` ise `deposit`'in `ZeroRecipient()` korumasi
    ///     yuzunden HER ZAMAN sifirdir.
    /// (2) VEKIL arkasindaki mesru bir escrow gecer -- yoklama davranisi olcer,
    ///     kod hash'i ya da kod uzunlugu degil.
    function test_theLedgerProbeAcceptsAUsedEscrowAndAProxiedOne() public {
        // (1) escrow'a gercek bir alacak yaz.
        escrow.deposit{value: 1 ether}(ALICE);
        assertGt(escrow.totalOwed(), 0, "on kosul: escrow KULLANIMDA olmali");
        assertGt(escrow.owed(ALICE), 0);
        assertEq(escrow.owed(address(0)), 0, "sifir alici anahtari yazilamaz");

        LaunchFactory used = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(used.escrow(), address(escrow));

        // (2) vekil.
        EscrowProxy proxy = new EscrowProxy(address(new FeeEscrow()));
        LaunchFactory proxied = new LaunchFactory(address(proxy), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(proxied.escrow(), address(proxy));

        // ...ve vekilli factory gercekten ticaret yapar: yoklama kozmetik
        // degil, calisan bir escrow'u kabul ettigi olculuyor.
        vm.prank(ALICE);
        (, address curve) = proxied.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve).buyExactQuoteIn{value: 1e18}(0);
        assertGt(FeeEscrow(address(proxy)).owed(TREASURY), 0, "vekilli escrow ucreti yazmadi");
    }

    /// YOKLANAN ANAHTARIN OZELLIGI, TEK BIR ADRESLE DEGIL FUZZ ILE.
    ///
    /// Iddia sudur: escrow'un KIME alacak yazdigi, factory'nin onu kabul
    /// etmesini DEGISTIRMEMELIDIR. Bu, `owed(address(0))` disinda herhangi bir
    /// anahtari yoklayan her hali eler -- `owed(address(1))`, `owed(TREASURY)`,
    /// `owed(msg.sender)`... -- cunku o anahtarlarin hepsi mesru olarak
    /// yazilabilir ve yazildiklarinda saglikli bir escrow REDDEDILIRDI.
    /// `address(0)` tek istisnadir ve istisna olmasi `deposit`'in
    /// `ZeroRecipient()` korumasindan gelir; asagidaki ikinci iddia o sebebi
    /// dogrudan pinler.
    ///
    /// AILENIN DETERMINISTIK YARISI. Asagidaki fuzz iddiasi DOGRU ama YETMEZ ve
    /// bu OLCULDU: `owed(address(1))` yoklayan mutant (P4) 256 kosuluk fuzz'i
    /// SAG GECTI, cunku fuzzer'in 2^160 adres icinden tam olarak `address(1)`i
    /// secmesi gerekiyordu. Rastgeleligin kapatmadigi yeri isimlendirilmis bir
    /// kume kapatir: bir yoklamanin makul olarak secebilecegi HER anahtara
    /// alacak yazilir ve escrow yine de KABUL EDILMELIDIR.
    ///
    /// Bu, "bir mutanti kovalamak" degil AILEYI adlandirmaktir: listedeki her
    /// adres, birinin `owed(address(0))` yerine yazmayi dusunebilecegi bir
    /// anahtardir.
    function test_theLedgerProbeIgnoresCreditAtEveryPlausibleProbeKey() public {
        address[9] memory keys =
            [address(1), address(2), address(0xdead), TREASURY, GOVERNOR, ALICE, BOB, address(escrow), address(this)];

        vm.deal(address(this), 100 ether);
        for (uint256 i = 0; i < keys.length; i++) {
            escrow.deposit{value: 1 ether}(keys[i]);
            assertGt(escrow.owed(keys[i]), 0, "on kosul: her anahtara alacak yazilmali");
        }

        LaunchFactory f = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(f.escrow(), address(escrow), "escrow makul bir anahtarda alacagi oldugu icin reddedildi");

        // ...ve YAZILAMAYAN tek anahtar hala sifir. Yoklamanin dayandigi sey
        // budur ve listedeki hicbir adres bu ozelligi tasimaz.
        assertEq(escrow.owed(address(0)), 0, "yazilamayan tek anahtar");
    }

    /// Tek bir adresle yazilmis hali yalnizca o adresi yoklayan mutanti
    /// oldururdu; ozellik olarak yazilmis hali AILEYI oldurur.
    function testFuzz_theLedgerProbeIgnoresWhichRecipientsHaveCredit(address recipient, uint96 amount) public {
        vm.assume(recipient != address(0));
        amount = uint96(bound(amount, 1, 1_000e18));
        // `vm.deal` bakiyeyi ATAR, eklemez -- ikinci `deposit` icin de yer
        // birakilmali, aksi halde o cagri OutOfFunds ile duser ve
        // `vm.expectRevert` sahte bir hata verir (olculdu).
        vm.deal(address(this), uint256(amount) + 1 ether);
        escrow.deposit{value: amount}(recipient);
        assertGt(escrow.owed(recipient), 0, "on kosul: alacak yazilmali");

        LaunchFactory f = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(f.escrow(), address(escrow), "escrow bir aliciya alacak yazdigi icin reddedildi");

        // VE SEBEBIN KENDISI: sifir alici anahtari YAZILAMAZ, dolayisiyla
        // `owed[address(0)]` her zaman sifirdir. Yoklamanin dayandigi degismez
        // budur ve varsayim degil, escrow'un kendi korumasinin sonucudur.
        vm.expectRevert(FeeEscrow.ZeroRecipient.selector);
        escrow.deposit{value: 1}(address(0));
        assertEq(escrow.owed(address(0)), 0);
    }

    /// ACIK HUCRE, CALISTIRILABILIR HALDE. Dolgun bir fallback ile 32 bayt
    /// sifir donduren bir kontrat yoklamayi GECER. Kapatmak icin kod hash'i ya
    /// da ERC-165 gerekirdi ve ikisi de vekilleri/yukseltmeleri disarida
    /// birakirdi. Bu test o siniri OLCUYOR; kapali olmayan bir hucreyi kapali
    /// gostermemek icin buradadir.
    function test_theLedgerProbeDoesNotSeeAPermissiveFallback() public {
        PermissiveFallback wrong = new PermissiveFallback();
        LaunchFactory accepted = new LaunchFactory(address(wrong), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(accepted.escrow(), address(wrong), "acik hucre kapandiysa bu testi guncelle");

        // VE KACIRILANIN SONUCU OLCULUYOR. Bu sekil FAIL-CLOSED DEGILDIR:
        // ticaret CALISIR, ucret "escrow"a girer ve SESSIZCE KAYBOLUR --
        // fallback her cagriya sifir dondugu icin hicbir alacak yazilmaz ve
        // `claim` yolu yoktur. Kodsuz/yanlis-tur escrow'da bedel BRICKLENMIS
        // BIR CURVE'DIR (gorunur), burada KAYIP UCRETTIR (gorunmez). Ikisi
        // arasindaki fark, bu hucreyi acik birakmanin gercek maliyetidir.
        vm.prank(ALICE);
        (, address curve) = accepted.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve).buyExactQuoteIn{value: 1e18}(0);
        assertGt(address(wrong).balance, 0, "ucret sahte escrow'a girmedi");
        assertEq(FeeEscrow(address(wrong)).owed(TREASURY), 0, "sahte defter alacak yazmiyor");
    }

    /// SIRA TANIGI: `address(0)` hem sifir hem kodsuzdur. Sifir kontrolu ONCE
    /// gelir ve bu sabittir.
    function test_aZeroEscrowIsReportedAsZeroNotAsCodeless() public {
        vm.expectRevert(LaunchFactory.ZeroEscrowAddress.selector);
        new LaunchFactory(address(0), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(address(0).code.length, 0, "address(0) violates BOTH escrow guards");
    }

    /// AYNA: `protocolTreasury` icin bir KOD KONTROLU yoktur ve olmamalidir.
    /// Escrow'daki alacak pull-based oldugu icin EOA bir treasury ile ticaret
    /// sorunsuz calisir. Bu test o asimetriyi sabitler -- treasury'ye bir kod
    /// kontrolu eklenirse burada kirilir (mutant M51, `setUp()`te olur).
    ///
    /// DUZELTME (F1): eski hali "risk tam olarak TEK bir argumandadir" diyordu
    /// ve bunu CALISTIRILABILIR BIR YASAK olarak sabitliyordu. O genelleme
    /// YANLISTI ve olculdu: risk IKI argumandadir, ve ikincisinin kotu degeri
    /// birincisinin IYI degeridir (`protocolTreasury == escrow`). Bu test artik
    /// dar olani sabitler -- "kod kontrolu YOK" -- ve genis olani
    /// (`hicbir treasury kontrolu yok`) DEGIL; esitsizlik korumasinin kendi
    /// testi `test_constructorRejectsTheEscrowAsTheTreasury`tir.
    ///
    /// M51 hakkinda: kod kontrolu mutanti HALA `setUp()`te olur, cunku
    /// TREASURY bir EOA'dir. Degisen sey mutantin ne kanitladigi: artik
    /// "treasury'de hicbir koruma olmamali" degil, "treasury'de KOD KONTROLU
    /// olmamali" demektir. Bir Safe treasury `receive()`i olan bir kontrattir
    /// ve kabul edilmek zorundadir; asagidaki ikinci yari onu olcer.
    function test_anEoaTreasuryIsAcceptedAndTradesNormally() public {
        assertEq(TREASURY.code.length, 0, "the treasury fixture must be an EOA for this test to mean anything");

        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve).buyExactQuoteIn{value: 1e18}(0);
        assertGt(LaunchToken(token).balanceOf(BUYER), 0, "an EOA treasury must not brick trading");

        // ...VE PROTOKOL PAYININ GERCEKTEN TREASURY'YE YAZILDIGI. Bu iddia
        // olmadan test, "EOA treasury guvenlidir" ile "treasury hic onemli
        // degildir"i AYIRT EDEMEZ: ucreti `address(0xDEAD)`'e yonlendiren bir
        // mutasyon 11 `BondingCurveTest` testini kirmizi yapar ve buradaki
        // hicbir seyi -- yani asimetriyi kilitlemekle gorevli testi --
        // kirmaz. Olculdu.
        assertGt(escrow.owed(TREASURY), 0, "the protocol fee must actually be credited to the treasury");

        // Ve MEKANIZMA push degil PULL: escrow alacagi defterine yazar,
        // treasury'ye gondermez. Kodsuz escrow'un aksine EOA treasury'nin
        // ticaret kirmamasinin SEBEBI tam olarak budur.
        assertEq(TREASURY.balance, 0, "the credit must be pull-based, not pushed to the treasury");

        // IKINCI YARI: KOD SAHIBI bir treasury de kabul edilir. Bir Safe
        // `receive()`i olan bir kontrattir; `code.length == 0` seklindeki bir
        // koruma onu DISLARDI. Kabul edilen kume "EOA"lar degil,
        // "escrow OLMAYAN, sifir OLMAYAN her adres"tir.
        Seeder safeLike = new Seeder();
        LaunchFactory f2 =
            new LaunchFactory(address(escrow), address(safeLike), GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        vm.prank(ALICE);
        (, address curve2) = f2.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve2).buyExactQuoteIn{value: 1e18}(0);
        assertGt(escrow.owed(address(safeLike)), 0, "kontrat treasury de calismali");
    }

    // ---------------------------------------------------------------
    // F1 -- protokol ucret alicisi: koruma ve rotasyon
    // ---------------------------------------------------------------

    /// F1'IN KORUMASI. Iki adres argumani KOMSUDUR ve escrow'u ikisine birden
    /// yapistirmak gercek bir operator hatasidir; eski tek koruma
    /// (`!= address(0)`) onu gecirirdi.
    ///
    /// Korumasiz halin OLCULEN sonucu (Faz 1c final incelemesi, P4 probu):
    /// factory kurulur, `launch` basarir, `isCanonical` true doner, HER islem
    /// basarir -- ve tek bir 100 USDC'lik `buyExactQuoteIn`de
    /// 938_271_604_938_271_605 wei kalici olarak talep edilemez hale gelir,
    /// cunku `FeeEscrow`un `receive()`i yoktur ve `claim(escrow)`
    /// `TransferFailed()` ile doner. Hicbir hacim siniri yoktur: 95 bps'in
    /// tamami, sonsuza kadar.
    ///
    /// SIRA TANIGI da burada: `address(0)` hem sifirdir hem escrow DEGILDIR,
    /// dolayisiyla sifir kontrolu ONCE gelir ve bu sabittir.
    function test_constructorRejectsTheEscrowAsTheTreasury() public {
        vm.expectRevert(LaunchFactory.TreasuryIsTheEscrow.selector);
        new LaunchFactory(address(escrow), address(escrow), GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        vm.expectRevert(LaunchFactory.ZeroTreasuryAddress.selector);
        new LaunchFactory(address(escrow), address(0), GOVERNOR, T, V, S, address(FEE_SCHEDULE));

        // Ve escrow'un KENDISI disinda her sey gecer -- koruma dardir.
        LaunchFactory ok = new LaunchFactory(address(escrow), TREASURY, GOVERNOR, T, V, S, address(FEE_SCHEDULE));
        assertEq(ok.protocolTreasury(), TREASURY);
    }

    /// Ucuncu adres argumaninin ayni hucresi. `governor == escrow` GOVERNANCE'I
    /// SONSUZA KADAR OLDURUR: escrow hicbir cagri yapamaz, dolayisiyla hicbir
    /// hedef atanamaz (yani HICBIR curve mezun olamaz) ve treasury
    /// dondurulemez. Deploy aninda bilinebilir, dolayisiyla burada elenir.
    ///
    /// `governor == protocolTreasury` ise KABUL EDILIR: ayni Safe pekala ikisi
    /// birden olabilir.
    function test_constructorRejectsTheEscrowAsGovernorButAcceptsTheTreasuryAsGovernor() public {
        vm.expectRevert(LaunchFactory.GovernorIsTheEscrow.selector);
        new LaunchFactory(address(escrow), TREASURY, address(escrow), T, V, S, address(FEE_SCHEDULE));

        vm.expectRevert(LaunchFactory.ZeroGovernorAddress.selector);
        new LaunchFactory(address(escrow), TREASURY, address(0), T, V, S, address(FEE_SCHEDULE));

        LaunchFactory ok = new LaunchFactory(address(escrow), TREASURY, TREASURY, T, V, S, address(FEE_SCHEDULE));
        assertEq(ok.governor(), TREASURY);
        assertEq(ok.protocolTreasury(), TREASURY);
    }

    /// F1'IN CEKIRDEGI, GERCEK FACTORY UZERINDEN: rotasyon CANLI bir curve'e
    /// ULASIR.
    ///
    /// `BondingCurve.protocolTreasury` bir immutable KOPYA olsaydi bu test
    /// yazilamazdi ve `FeeEscrow` kisit (4)'un Faz 1c'ye biraktigi borc
    /// odenmemis kalirdi: Arc treasury'yi bloklarsa ticaret devam eder,
    /// `owed[bloklu]` buyur, `claim` revert eder ve hicbir yol yeniden
    /// yonlendirmez -- ne gelecek launch'lar icin, ne canli curve'ler icin.
    ///
    /// IKINCI YARI: BIRIKMIS ALACAK TASINMAZ. `owed[eski]` eski adresin talebi
    /// olarak aynen durur; rotasyonun kapattigi sey KANAMANIN DEVAMIDIR,
    /// gecmis degil (kisit (4) bunu zaten soyluyor).
    function test_rotatingTheTreasuryRedirectsTheFeesOfEveryLiveCurve() public {
        address newTreasury = address(0xBEEF);

        vm.prank(ALICE);
        (, address curveA) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BOB);
        (, address curveB) = factory.launch("Brc Coin", "BRC", "ipfs://cid2");

        vm.prank(BUYER);
        BondingCurve(curveA).buyExactQuoteIn{value: 10e18}(0);
        uint256 owedOld = escrow.owed(TREASURY);
        assertGt(owedOld, 0);

        vm.expectEmit(true, true, false, false, address(factory));
        emit LaunchFactory.ProtocolTreasuryChanged(TREASURY, newTreasury);
        vm.prank(GOVERNOR);
        factory.setProtocolTreasury(newTreasury);

        // IKI CANLI CURVE DE yeni adresi gorur -- rotasyon "gelecek
        // launch'lar" ile sinirli DEGILDIR.
        assertEq(BondingCurve(curveA).protocolTreasury(), newTreasury, "canli curve A rotasyonu gormedi");
        assertEq(BondingCurve(curveB).protocolTreasury(), newTreasury, "canli curve B rotasyonu gormedi");

        vm.prank(BUYER);
        BondingCurve(curveA).buyExactQuoteIn{value: 10e18}(0);
        vm.prank(BUYER);
        BondingCurve(curveB).buyExactQuoteIn{value: 10e18}(0);

        assertGt(escrow.owed(newTreasury), 0, "yeni treasury'ye yazilmadi");
        assertEq(escrow.owed(TREASURY), owedOld, "birikmis alacak tasindi");

        // VE ESKI ADRES BIRIKMISI HALA CEKEBILIR.
        escrow.claim(TREASURY);
        assertEq(TREASURY.balance, owedOld);
    }

    /// Setter'in korumalari CONSTRUCTOR'INKININ AYNISIDIR. Bir setter
    /// constructor'in korumalarini gevsetirse koruma yok demektir -- ve
    /// `BondingCurve` bu degeri DOGRULAMAZ, yani sifir olmama garantisinin tek
    /// yeri burasidir. Sifir bir treasury her islemi `FeeEscrow.ZeroRecipient`
    /// ile kirardi.
    function test_theTreasurySetterCarriesTheSameGuardsAsTheConstructor() public {
        vm.prank(GOVERNOR);
        vm.expectRevert(LaunchFactory.ZeroTreasuryAddress.selector);
        factory.setProtocolTreasury(address(0));

        vm.prank(GOVERNOR);
        vm.expectRevert(LaunchFactory.TreasuryIsTheEscrow.selector);
        factory.setProtocolTreasury(address(escrow));

        assertEq(factory.protocolTreasury(), TREASURY, "basarisiz cagri degeri degistirdi");
    }

    /// ROTASYON `isCanonical`I VE `predictAddresses`I BOZMAZ -- ve bu bir
    /// TUZAKTIR: `protocolTreasury` curve'un constructor argumanlari arasinda
    /// KALSAYDI, initcode'un parcasi olurdu ve ilk rotasyondan sonra
    /// `_curveAddress` her ONCEKI curve icin yanlis adres uretirdi;
    /// `isCanonical` o launch'lar icin sessizce `false` donerdi -- indexer
    /// gercek launch'lari sahte sayardi.
    function test_isCanonicalAndPredictAddressesSurviveATreasuryRotation() public {
        vm.prank(ALICE);
        (address token, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        assertTrue(factory.isCanonical(token));

        (address predictedToken, address predictedCurve) =
            factory.predictAddresses(BOB, "Brc Coin", "BRC", "ipfs://cid2", factory.launchCount());

        vm.prank(GOVERNOR);
        factory.setProtocolTreasury(address(0xBEEF));

        assertTrue(factory.isCanonical(token), "rotasyon eski launch'i kanonik OLMAKTAN cikardi");

        vm.prank(BOB);
        (address token2, address curve2) = factory.launch("Brc Coin", "BRC", "ipfs://cid2");
        assertEq(token2, predictedToken, "rotasyon onizlenen token adresini kaydirdi");
        assertEq(curve2, predictedCurve, "rotasyon onizlenen curve adresini kaydirdi");
        assertTrue(factory.isCanonical(token2));
        assertEq(BondingCurve(curve).protocolTreasury(), BondingCurve(curve2).protocolTreasury());
    }

    // ---------------------------------------------------------------
    // D3 -- graduation hedefi: iki fazli, uc gunluk, kamuya acik
    // ---------------------------------------------------------------

    /// Hedef ATANMADAN once her `graduate()` cagrisi `GraduationTargetUnset`
    /// ile doner ve bu, Faz 2 var olmadigi surece herkesin gorecegi hatadir.
    function test_theGraduationTargetStartsUnsetAndGraduationSaysSo() public {
        assertEq(factory.graduationTarget(), address(0));
        assertEq(factory.pendingGraduationTarget(), address(0));
        assertEq(factory.pendingGraduationTargetEta(), 0);

        vm.prank(ALICE);
        (, address curve) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BUYER);
        BondingCurve(curve).buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);

        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        BondingCurve(curve).graduate();
    }

    /// YALNIZCA GOVERNOR. Iki setter de ayni kapiya baglidir; `apply` ise
    /// IZINSIZDIR (asagida).
    function test_onlyTheGovernorMayProposeATargetOrRotateTheTreasury() public {
        vm.prank(ALICE);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        factory.proposeGraduationTarget(address(0xF00D));

        vm.prank(ALICE);
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        factory.setProtocolTreasury(address(0xF00D));

        // Factory'nin KENDISI de degil, deploy eden de degil.
        vm.expectRevert(LaunchFactory.NotGovernor.selector);
        factory.proposeGraduationTarget(address(0xF00D));
    }

    function test_aZeroGraduationTargetCannotBeProposed() public {
        vm.prank(GOVERNOR);
        vm.expectRevert(LaunchFactory.ZeroGraduationTarget.selector);
        factory.proposeGraduationTarget(address(0));
    }

    /// UC GUN, VE SINIRIN IKI TARAFI DA OLCULUR. `eta - 1` reddedilir, `eta`
    /// tam kabul edilir.
    ///
    /// `apply` IZINSIZDIR ve bu bilinclidir: governor onerirken yetkisini
    /// ZATEN kullanmistir, ikinci adim yalnizca surenin gectiginin
    /// dogrulanmasidir -- yani hedefin inmesi governor'in ikinci bir islem
    /// yapmasina BAGIMLI degildir.
    function test_theTargetLandsOnlyAfterTheDelayAndAnyoneMayApplyIt() public {
        address target = address(0xF00D);

        vm.expectRevert(LaunchFactory.NoPendingGraduationTarget.selector);
        factory.applyGraduationTarget();

        uint256 eta = block.timestamp + factory.GRADUATION_TARGET_DELAY();
        vm.expectEmit(true, false, false, true, address(factory));
        emit LaunchFactory.GraduationTargetProposed(target, eta);
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(target);

        assertEq(factory.GRADUATION_TARGET_DELAY(), 1 days);
        assertEq(factory.pendingGraduationTarget(), target);
        assertEq(factory.pendingGraduationTargetEta(), eta);
        assertEq(factory.graduationTarget(), address(0), "oneri hemen indi");

        vm.warp(eta - 1);
        vm.prank(ALICE);
        vm.expectRevert(LaunchFactory.GraduationTargetDelayNotElapsed.selector);
        factory.applyGraduationTarget();

        vm.warp(eta);
        vm.expectEmit(true, true, false, false, address(factory));
        emit LaunchFactory.GraduationTargetChanged(address(0), target);
        // IZINSIZ: cagiran ALICE, governor DEGIL.
        vm.prank(ALICE);
        factory.applyGraduationTarget();

        assertEq(factory.graduationTarget(), target);
        assertEq(factory.pendingGraduationTarget(), address(0), "bekleyen temizlenmedi");
        assertEq(factory.pendingGraduationTargetEta(), 0, "eta temizlenmedi");

        // Ve ikinci bir `apply` bekleyen olmadigi icin duser -- `eta == 0`
        // bekleyen olmamanin TANIMIDIR ve sira bu yuzden onemlidir: sure
        // kontrolu once gelseydi bos durumda "bekle" denirdi.
        vm.expectRevert(LaunchFactory.NoPendingGraduationTarget.selector);
        factory.applyGraduationTarget();
    }

    /// PENCERE UST SINIRI: `eta + GRADUATION_TARGET_DELAY` aninda HALA inebilir,
    /// bir saniye sonrasinda INEMEZ.
    ///
    /// Alt sinirin iki tarafi yukaridaki testte yurunuyor; burada UST sinirin
    /// iki tarafi yurunuyor. Ikisini ayri testlerde tutmak bilincli: pencerenin
    /// bir ucunu silen bir mutasyon otekinin testini KIRMAMALI, yoksa hangi
    /// ucun korundugu olculemez.
    function test_theProposalCanStillLandOnTheLastSecondOfTheWindow() public {
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0xF00D));
        uint256 deadline = factory.pendingGraduationTargetEta() + factory.GRADUATION_TARGET_DELAY();

        vm.warp(deadline);
        vm.prank(ALICE);
        factory.applyGraduationTarget();

        assertEq(factory.graduationTarget(), address(0xF00D));
        assertEq(factory.pendingGraduationTargetEta(), 0);
    }

    function test_theProposalExpiresOneSecondLater() public {
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0xF00D));
        uint256 deadline = factory.pendingGraduationTargetEta() + factory.GRADUATION_TARGET_DELAY();

        vm.warp(deadline + 1);
        vm.expectRevert(LaunchFactory.GraduationTargetProposalExpired.selector);
        factory.applyGraduationTarget();

        assertEq(factory.graduationTarget(), address(0), "suresi gecmis oneri indi");

        // SURESI GECMIS ONERI ATILDIR ama okunabilir kalir; temizleyen bir uye
        // YOKTUR ve gerekmez -- inebilecegi tek fonksiyon artik reddediyor.
        assertEq(factory.pendingGraduationTarget(), address(0xF00D));

        // CARE: YENIDEN ONER. Sure bastan baslar ve pencere yeniden acilir.
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0xF00D));
        vm.warp(factory.pendingGraduationTargetEta());
        factory.applyGraduationTarget();
        assertEq(factory.graduationTarget(), address(0xF00D));
    }

    /// F-A: UST SINIRIN VARLIK SEBEBI, UCTAN UCA.
    ///
    /// Ust sinirsiz halin olculen senaryosu: gun 0'da HENUZ TAMAMLANMIS HIC
    /// CURVE YOKKEN bir hedef onerilir -- kimse itiraz etmez, cunku
    /// bosaltilacak bir sey yoktur. Gun 3'te pencere acilir, kimse indirmez,
    /// izleyenler onerinin dusuruldugunu sanir. Gun 368'de iki launch
    /// tamamlanmistir ve TEK BIR ISLEM `apply` + iki `graduate()` yapar:
    /// hirsizlik anindaki IHBAR SURESI SIFIRDIR.
    ///
    /// Gecikmenin tek yazili caresi "uc gun icinde tamamlanmis curve'leri
    /// bosalt"tir ve o care, oneri aninda BOS olan kumeyi korur. Ust sinir tam
    /// olarak bu ayrisimi kapatir: ihbar ile inme arasindaki mesafe ihbar
    /// suresini asamaz.
    function test_aProposalMadeBeforeAnyCurveCompletedCannotBeLandedAYearLater() public {
        Seeder attacker = new Seeder();

        // GUN 0: hicbir curve tamamlanmamis. Oneri yapilir.
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(attacker));
        uint256 deadline = factory.pendingGraduationTargetEta() + factory.GRADUATION_TARGET_DELAY();

        // GUN 368: iki launch tamamlanmis durumda.
        vm.warp(deadline + 365 days);
        vm.prank(ALICE);
        (, address curveA) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        vm.prank(BOB);
        (, address curveB) = factory.launch("Brc Coin", "BRC", "ipfs://cid2");
        vm.prank(BUYER);
        BondingCurve(curveA).buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        vm.prank(BUYER);
        BondingCurve(curveB).buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        assertTrue(BondingCurve(curveA).complete() && BondingCurve(curveB).complete());

        uint256 raiseAtRisk = BondingCurve(curveA).realQuoteReserves() + BondingCurve(curveB).realQuoteReserves();
        assertGt(raiseAtRisk, 24_000e18, "senaryonun riske attigi tutar");

        // TEK ISLEM: indir + iki curve'u mezun et. ILK ADIM DUSER.
        vm.expectRevert(LaunchFactory.GraduationTargetProposalExpired.selector);
        factory.applyGraduationTarget();

        // ...ve hedef atanmadigi icin iki curve de hala mezun edilemez.
        assertEq(factory.graduationTarget(), address(0));
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        attacker.pull(BondingCurve(curveA));
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        attacker.pull(BondingCurve(curveB));
        assertEq(address(attacker).balance, 0, "saldirgan raise'i aldi");

        // VE DOGRU YOL HALA CALISIYOR: yeniden oner, UC GUN BEKLE -- bu sefer
        // ihbar suresi tamamlanmis curve'ler ZATEN VARKEN isliyor, yani
        // gecikmenin caresi (bosaltma) fiilen uygulanabilir durumda.
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(attacker));
        vm.warp(factory.pendingGraduationTargetEta());
        factory.applyGraduationTarget();
        attacker.pull(BondingCurve(curveA));
        assertGt(address(attacker).balance, 0);
    }

    /// ONERININ UZERINE YAZMAK MUMKUNDUR VE SURE BASTAN BASLAR. Ayri bir
    /// "iptal" uyesi yoktur: yanlis bir oneriyi geri almak dogrusunu yeniden
    /// onermektir.
    function test_proposingAgainReplacesThePendingTargetAndRestartsTheClock() public {
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0xBAD));
        uint256 firstEta = factory.pendingGraduationTargetEta();

        vm.warp(block.timestamp + 2 days);
        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(0xF00D));

        assertEq(factory.pendingGraduationTarget(), address(0xF00D));
        // `firstEta + 2 gun`, `block.timestamp + 3 gun` DEGIL: ikinci sekil
        // TIMESTAMP'in ortak-alt-ifade elenmesine acik ve testi kendi
        // kurgusundan bagimsiz olarak yaniltabilir (bkz. asagidaki testin
        // notu). Buradaki iki deger de FACTORY'DEN okunur.
        assertEq(factory.pendingGraduationTargetEta(), firstEta + 2 days, "saat bastan baslamadi");
        assertGt(factory.pendingGraduationTargetEta(), firstEta, "saat bastan baslamadi");

        // Ilk onerinin ORIJINAL suresi gelse bile inecek olan ikincidir --
        // ve o da henuz hazir degildir.
        vm.warp(firstEta);
        vm.expectRevert(LaunchFactory.GraduationTargetDelayNotElapsed.selector);
        factory.applyGraduationTarget();

        vm.warp(factory.pendingGraduationTargetEta());
        factory.applyGraduationTarget();
        assertEq(factory.graduationTarget(), address(0xF00D));
    }

    /// R-11. DEPLOY EDILMIS CIFT CALISIYOR: gercek factory, gercek curve,
    /// gercek hedef, ve arada 3 gunluk timelock.
    ///
    /// Bu testin olctugu sey ne factory'nin ne curve'un tek basina
    /// olcemedigi seydir: curve'un bytecode'undaki `0xa4b20f13` STATICCALL'u,
    /// factory'nin AYNI ADLA ve AYNI MUTABILITE ile sundugu uyeye dusuyor mu.
    /// Bir invariant harness'inda hedef bir mock'tur ve orada kanitlanan sey
    /// gercek `LaunchFactory` hakkinda HICBIR SEY soylemez -- bu depoda on kez
    /// olusmus "bir giris noktasinda kapatilan ozellik hepsinde kapatilmis
    /// gorunur" hatasinin bir katman yukarisi.
    function test_theDeployedPairGraduatesEndToEnd() public {
        Seeder seeder = new Seeder();

        vm.prank(ALICE);
        (address token, address curveAddr) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        BondingCurve curve = BondingCurve(curveAddr);

        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);
        assertTrue(curve.complete());

        // HEDEF INMEDEN once cagri `GraduationTargetUnset` ile doner...
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        seeder.pull(curve);

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(seeder));

        // ...ve ONERI YETMEZ, INMESI gerekir.
        vm.expectRevert(BondingCurve.GraduationTargetUnset.selector);
        seeder.pull(curve);

        vm.warp(factory.pendingGraduationTargetEta());
        factory.applyGraduationTarget();

        uint256 r = curve.realQuoteReserves();
        uint256 d = curve.poolSeedSupply();
        (uint256 base, uint256 quote) = seeder.pull(curve);

        assertEq(base, d);
        assertEq(quote, r);
        assertEq(LaunchToken(token).balanceOf(address(seeder)), d);
        assertEq(address(seeder).balance, r);
        assertTrue(curve.graduated());
        assertTrue(factory.isCanonical(token), "mezun bir launch kanonik kalmali");
    }

    /// D3'UN VAROLMA SEBEBI: BOZUK BIR HEDEFTEN TEK CIKIS. Hedef odemeyi
    /// alamiyorsa graduation revert eder ve curve mezun OLMAZ; care hedefi
    /// yeniden isaretlemektir -- ve o da uc gun surer.
    ///
    /// Arc'ta bugun Uniswap V4 HICBIR YERDE yoktur (dort kanonik `PoolManager`
    /// adresi de 5042002 zincirinde kodsuzdur), yani ilk hedef kendi deploy
    /// ettigimiz bir sey olacak ve mainnet'ten once en az bir kez
    /// degistirilecektir. Tek seferlik bir latch riskli degil, gelistirme
    /// yoluyla BAGDASMAZ olurdu.
    function test_abrokenTargetIsRecoverableOnlyBecauseTheTargetCanBeRepointed() public {
        NoReceiveTarget broken = new NoReceiveTarget();
        Seeder good = new Seeder();

        vm.prank(ALICE);
        (, address curveAddr) = factory.launch("Arc Coin", "ARC", "ipfs://cid");
        BondingCurve curve = BondingCurve(curveAddr);
        vm.prank(BUYER);
        curve.buyExactTokensOut{value: 20_000e18}(S, type(uint256).max);

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(broken));
        // SURE FACTORY'DEN OKUNUR, `block.timestamp + 3 days` DIYE
        // HESAPLANMAZ. Olculdu: `via_ir` + optimizer altinda solc ayni cagri
        // cercevesindeki TIMESTAMP okumalarini ORTAK ALT IFADE olarak eler --
        // gercek zincirde dogru, `vm.warp` altinda YANLIS. Ikinci bir
        // `vm.warp(block.timestamp + 3 days)` bu yuzden ILK degeri yeniden
        // kullaniyordu ve testi sahte bir sebeple kirmizi yapiyordu.
        vm.warp(factory.pendingGraduationTargetEta());
        factory.applyGraduationTarget();

        vm.expectRevert(BondingCurve.GraduationPayoutFailed.selector);
        broken.pull(curve);
        assertFalse(curve.graduated(), "bozuk hedef bayragi latch etti");

        vm.prank(GOVERNOR);
        factory.proposeGraduationTarget(address(good));
        vm.warp(factory.pendingGraduationTargetEta());
        factory.applyGraduationTarget();

        (uint256 base, uint256 quote) = good.pull(curve);
        assertEq(base, curve.poolSeedSupply());
        assertEq(quote, curve.realQuoteReserves());
        assertTrue(curve.graduated());
    }
}

/// `receive()` OLMAYAN hedef: odemenin native bacagi cagrilacak bir fonksiyon
/// bulamaz ve butun islem geri alinir.
contract NoReceiveTarget {
    function pull(BondingCurve curve) external returns (uint256, uint256) {
        return curve.graduate();
    }
}
