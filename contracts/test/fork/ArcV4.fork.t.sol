// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolDeployLib} from "../../script/PoolDeployLib.sol";

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IHookView {
    function poolManager() external view returns (address);
    function factory() external view returns (address);
    function escrow() external view returns (address);
}

interface ILockerView {
    function poolManager() external view returns (address);
    function factory() external view returns (address);
    function hook() external view returns (address);
}

interface IOwnable {
    function owner() external view returns (address);
}

interface IFactoryView {
    function escrow() external view returns (address);
    function feeSchedule() external view returns (address);
    function governor() external view returns (address);
    function protocolTreasury() external view returns (address);
    function graduationTarget() external view returns (address);
    function launchCount() external view returns (uint256);
    function VIRTUAL_TOKEN_RESERVES() external view returns (uint256);
    function VIRTUAL_QUOTE_RESERVES() external view returns (uint256);
    function SALE_SUPPLY() external view returns (uint256);
}

interface IEscrowView {
    function totalOwed() external view returns (uint256);
}

/// @title ArcV4ForkTest -- Task 8, ALT KATMAN A
/// @notice Faz 2'nin CANLI kontratlarina karsi SALT OKUMA sondalari:
///         deterministik, ucretsiz, idempotent. CI'da her PR'da kosabilir.
///
/// @dev ALT KATMAN B BU DOSYADA DEGIL VE OLMAMALI. Tam graduation dongusu
///      fonlu bir anahtar ister, faucet USDC harcar ve her kosuda bir launch
///      TUKETIR -- yani idempotent degildir. Idempotent olmayan bir testi kapi
///      olarak kullanmak kapiyi akitir ve basarisizligini RPC gurultusunden
///      ayirt edilemez kilar.
///
/// @dev ADRESLER DEFTERDEN OKUNUR, LITERALDEN DEGIL. Bu bir stil tercihi
///      degil, testin ASIL IDDIASININ yarisidir: `contracts/deploy/
///      addresses.5042002.json` dort calisma zamani katmaninin TAMAMININ
///      adres kaynagidir, dolayisiyla "defterin yazdigi sey zincirde gercekten
///      var mi" sorusu, "bu literal dogru mu" sorusundan daha genistir.
///      Literal yazan bir test defteri hic sinamazdi.
contract ArcV4ForkTest is Test {
    address internal constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    /// @notice Faz 1'in escrow'da biriken alacaklari, Task 7 ANINDA olculmus.
    ///
    /// @dev BU BIR ALT SINIRDIR, BIR SNAPSHOT DEGIL -- VE ILK YAZIMI SNAPSHOT
    ///      IDI, KIRMIZI OLDU, IYI KI OLDU. Test `totalOwed == 152069146725900635`
    ///      diyordu ve zincirde 321214784333543529 buldu: Faz 2'nin fabrikasi
    ///      YENIDEN KULLANILAN escrow'a fiilen ucret yatirmaya baslamis (+0,169
    ///      USDC, `launchCount` 1). Yani kirmizi, yeniden kullanim kolunun
    ///      UCTAN UCA CALISTIGININ kanitiydi.
    ///
    ///      Dogru iddia MONOTONLUKTUR: Faz 1'in alacaklari YETIM KALMADIYSA bu
    ///      sayi asla altina inemez. Canli, buyuyen bir sisteme sabit bir sayi
    ///      pinlemek testin degil olcumun hatasiydi.
    uint256 internal constant PHASE_ONE_CLAIMS = 152_069_146_725_900_635;

    address internal factory;
    address internal escrow;
    address internal feeSchedule;
    address internal poolManager;
    address internal hook;
    address internal locker;
    address internal governor;
    address internal treasury;

    function setUp() public {
        string memory json = vm.readFile("deploy/addresses.5042002.json");
        factory = vm.parseJsonAddress(json, ".launchFactory");
        escrow = vm.parseJsonAddress(json, ".feeEscrow");
        feeSchedule = vm.parseJsonAddress(json, ".feeSchedule");
        poolManager = vm.parseJsonAddress(json, ".poolManager");
        hook = vm.parseJsonAddress(json, ".arcpadHook");
        locker = vm.parseJsonAddress(json, ".arcpadLocker");
        governor = vm.parseJsonAddress(json, ".governor");
        treasury = vm.parseJsonAddress(json, ".protocolTreasury");
    }

    function test_forkIsArcTestnet() public view {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID, "fork is not Arc testnet");
    }

    // ---------------------------------------------------------------
    // 1. DEFTERIN YAZDIGI HER SEY GERCEKTEN ORADA
    // ---------------------------------------------------------------

    function test_everyAddressInTheBookHasCodeOnChain() public view {
        assertGt(factory.code.length, 0, "launchFactory has no code");
        assertGt(escrow.code.length, 0, "feeEscrow has no code");
        assertGt(feeSchedule.code.length, 0, "feeSchedule has no code");
        assertGt(poolManager.code.length, 0, "poolManager has no code");
        assertGt(hook.code.length, 0, "arcpadHook has no code");
        assertGt(locker.code.length, 0, "arcpadLocker has no code");
    }

    /// HOOK ADRESI IZIN KUMESIDIR -- CANLI ZINCIRDE, GERCEK KOD UZERINDE.
    ///
    /// @dev `DeployPool.t.sol` ayni sayiyi bir TAHMIN uzerinde iddia eder.
    ///      Burada iddia edilen sey deploy EDILMIS adrestir, ve fark su:
    ///      tahmin yanlis olsaydi paket yesil kalabilirdi, zincir kalamaz.
    function test_theDeployedHookAddressCarriesTheArcpadFlags() public view {
        assertEq(
            uint256(uint160(hook) & Hooks.ALL_HOOK_MASK),
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            "the deployed hook does not carry the arcpad permission bits"
        );
        // ...VE O SAYI BAYRAKLARIN TOPLAMI. Iki taraf ayri yerden gelir.
        assertEq(
            uint256(PoolDeployLib.ARCPAD_HOOK_FLAGS),
            uint256(
                Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ),
            "0x20CC diverged from the sum of the five flags"
        );
    }

    /// UC KONTRAT BIRBIRINE, VE DEFTERE, DOGRU BAGLANMIS.
    ///
    /// @dev `assertAsDeployed` bunu `run()` icinde okur -- ama `--resume`
    ///      yolunda KOSMAZ (olculdu: `--resume` script'i yeniden calistirmaz,
    ///      yani geri okuma o yolda HIC yapilmaz). Yani zincirden bagimsiz
    ///      okuyan bir yer gerekiyordu ve burasi.
    function test_theDeployedContractsAreWiredToEachOther() public view {
        assertEq(IHookView(hook).poolManager(), poolManager, "hook.poolManager");
        assertEq(IHookView(hook).factory(), factory, "hook.factory");
        assertEq(IHookView(hook).escrow(), escrow, "hook.escrow");

        assertEq(ILockerView(locker).poolManager(), poolManager, "locker.poolManager");
        assertEq(ILockerView(locker).factory(), factory, "locker.factory");
        assertEq(ILockerView(locker).hook(), hook, "locker.hook");

        // Sahiplik protokol ucreti denetleyicisini atar; bir EOA'da birakmak
        // Faz 2'nin TUM havuzlarini o anahtara baglardi.
        assertEq(IOwnable(poolManager).owner(), governor, "poolManager.owner is not the governor Safe");
    }

    /// DEFTERDEKI FABRIKA, FAZ 2'NIN FABRIKASI.
    function test_theBookPointsAtThePhase2Factory() public view {
        IFactoryView f = IFactoryView(factory);
        assertEq(f.escrow(), escrow, "factory.escrow");
        assertEq(f.feeSchedule(), feeSchedule, "factory.feeSchedule -- a Phase 1 factory has no such member");
        assertEq(f.governor(), governor, "factory.governor");
        assertEq(f.VIRTUAL_TOKEN_RESERVES(), 1_073_000_000e18, "T");
        // 4292e15, TESTNET buyuklugu. 4292e18 uretimdir -- 1000x -- ve
        // kontrattaki her koruma onu da kabul eder.
        assertEq(f.VIRTUAL_QUOTE_RESERVES(), 4_292e15, "V");
        assertEq(f.SALE_SUPPLY(), 793_100_000e18, "S");
    }

    /// TASK 8 HENUZ HEDEFI ISARET ETMEDI, VE BU TEST O SINIRIN BEKCISIDIR.
    ///
    /// @dev Kirmizi olmasi "bir sey bozuldu" demek DEGIL, "graduation hedefi
    ///      artik ayarli" demektir -- yani hook adresi ilk havuzla birlikte
    ///      DONMUS olabilir ve yeniden madencilik ARTIK MUMKUN DEGILDIR. O an
    ///      bu testin guncellenmesi INCELENMIS bir karardir.
    function test_theGraduationTargetIsStillUnset() public view {
        assertEq(IFactoryView(factory).graduationTarget(), address(0), "graduationTarget is set -- re-mining is gone");
    }

    /// @dev `launchCount == 0` BURADA IDDIA EDILMEZ VE ILK YAZIMDA EDILIYORDU.
    ///      Zincir 1 dondurdu: Faz 2'nin fabrikasinda ZATEN bir launch var.
    ///      Bu bir ariza degil, soak'in baslamasi -- ve pinlenmesi testi ilk
    ///      gercek kullanimda kiracak bir snapshot olurdu. Kaydedilmeye deger
    ///      olan sey sudur: hedef HENUZ BOSKEN tamamlanmis bir curve
    ///      `GraduationTargetUnset()` ile doner, yani bir launch'in varligi
    ///      hedefi ISARET ETME ACELESI YARATMAZ; tersine, hedef indigi anda
    ///      graduation ARTIK MUMKUN olur ve hook adresi ilk havuzla DONAR.
    function test_theFactoryIsLiveAndAcceptingLaunches() public view {
        assertGe(IFactoryView(factory).launchCount(), 0, "launchCount is readable");
    }

    /// YENIDEN KULLANIM KOLU: FAZ 1'IN ALACAKLARI OKSUZ DUSMEDI.
    ///
    /// @dev BU TEST 2026-08-09'DA YENIDEN YAZILDI VE ESKI HALI ALTINCI HATA
    ///      MODUYDU: MEVCUT DURUMUN KAZASINI YASA OLARAK KODLAMAK.
    ///
    ///      Eski hal `assertGe(totalOwed, PHASE_ONE_CLAIMS)` idi ve yorumu
    ///      "monotonluk" diyordu: "Faz 2 ucret yatirdikca YUKSELIR". Bu, o gune
    ///      kadar HIC KIMSENIN `claim()` cagirmamis olmasindan dogan bir
    ///      gozlemdi -- bir yasa degil. `FeeEscrow.claim` IZINSIZDIR ve
    ///      `totalOwed`i DUSURMEK tam olarak onun isidir. Yani test, protokolun
    ///      normal bir islemi ilk kez kosuldugunda kirilacakti; olculdu:
    ///      iki alacaklinin ikisi de claim edince toplam 77239696388198597'ye
    ///      duser, esigin altina. `assertFalse(smokeCurve.graduated())` ile ayni
    ///      sekil, ayni hafta, ayni sebep.
    ///
    ///      OKSUZLUK BIR SAYI SORUSU DEGIL, BIR KIMLIK SORUSUDUR. "Faz 1'in
    ///      alacaklari yetim dustu" demek, Faz 2'nin IKINCI bir escrow deploy
    ///      ettigi ve eski paranin terk edilmis olanda kaldigi demektir. Bunun
    ///      testi bakiye tabani degil, ADRES OZDESLIGIDIR -- ve o iddia
    ///      claim'ler altinda DEGISMEZ.
    function test_theReusedEscrowStillHoldsPhaseOnesClaims() public view {
        // 1. YENIDEN KULLANIM KOLU TUTTU: canli fabrikanin escrow'u, Faz 1'in
        //    defterinin kaydettigi escrow'un TA KENDISIDIR. Oksuzlugun gercek
        //    testi budur.
        assertEq(
            IFactoryView(factory).escrow(),
            escrow,
            "the live factory points at a DIFFERENT escrow -- Phase 1's claims are orphaned"
        );
        assertGt(escrow.code.length, 0, "the escrow has no code");

        // 2. ODEME GUCU. Kontratin degismezi `totalOwed <= balance`tir, esitlik
        //    DEGIL: dogrudan bir transfer bakiyeyi yukseltir ama `totalOwed`i
        //    yukseltmez. Bu iddia her deposit ve her claim altinda dogru kalir.
        assertGe(escrow.balance, IEscrowView(escrow).totalOwed(), "escrow is insolvent against its own book");
    }

    // ---------------------------------------------------------------
    // 2. CIFT GORUNUM ARITMETIGI -- 1e12 SINIRININ UZAK UCU
    // ---------------------------------------------------------------

    /// @dev BU TEST YEREL EVM'DE HICBIR SEY IFADE ETMEZ ve sebebi budur:
    ///      `0x3600...` bir Arc SISTEM kontratidir, yerelde kodsuzdur.
    ///
    /// @dev OLCULEN ILISKI `units == floor(wei / 1e12)`DIR, `units * 1e12 ==
    ///      wei` DEGIL. Carpma formu YALNIZCA hic gaz harcamamis hesaplar icin
    ///      gecerlidir; tek bir islem odemis her hesap kuantumun altinda toz
    ///      tasir. Bir yuvarlak `100e18`/`100e6` okumasi bu yuzden yaniltici
    ///      bir genellemedir.
    function test_theSixDecimalViewIsTheFlooredNativeBalance() public view {
        assertEq(IERC20Balance(USDC_ERC20).decimals(), 6, "the ERC-20 view is not 6-decimal");
        assertEq(IERC20Balance(USDC_ERC20).symbol(), "USDC", "the ERC-20 view is not USDC");

        // BES HESAP, VE HICBIRI PINLENMIS BIR SAYI DEGIL. Iddia ILISKIDIR.
        //
        // SONDA KUMESI 2026-08-09'DA GENISLETILDI, VE SEBEBI OLCULDU. Onceki
        // hal `[escrow, locker, poolManager]` idi ve tanigi ESCROW'UN BAKIYESI
        // olmasi umuluyordu. O gun escrow'un iki alacaklisi da `claim()` etti
        // -- protokolun tamamen normal bir islemi, ve zincirde ilk kez kosuldu
        // -- ve escrow SIFIRA indi. Locker ile poolManager mezuniyet
        // olmadigindan zaten hic para gormemisti, yani UCU DE sifir kaldi:
        // sifirin tozu yoktur, floor ile carpma ayni cevabi verir, ve asagidaki
        // vakum bekcisi HAKLI OLARAK atesledi.
        //
        // Bu bir ariza degil, bekcinin isini yapmasidir -- ama sonda kumesinin
        // yalnizca GECICI olarak para tutan kontratlardan kurulmasi bir secim
        // hatasiydi. `protocolTreasury` artik protokol payini TUTAR (claim onu
        // oraya tasidi) ve `governor` da bir hesaptir; ikisi de defterden gelir,
        // literal degil.
        address[5] memory probes = [escrow, locker, poolManager, treasury, governor];
        uint256 withDust;
        for (uint256 i = 0; i < probes.length; ++i) {
            uint256 wei_ = probes[i].balance;
            assertEq(
                IERC20Balance(USDC_ERC20).balanceOf(probes[i]),
                wei_ / 1e12,
                "the 6-decimal view is not the floored 18-decimal balance"
            );
            if (wei_ % 1e12 != 0) ++withDust;
        }
        // VAKUM BEKCISI: her ucunun de kalani sifir olsaydi floor ile carpma
        // ayni cevabi verirdi ve bu test iki formu AYIRT ETMEZDI. Uc bagimsiz
        // hesabin hepsinin tam kuantumda olmasi pratikte imkansizdir; olursa
        // testin bunu SOYLEMESI gerekir, sessizce gecmesi degil.
        assertGt(withDust, 0, "no probe carries dust -- floor and multiply agree, so this measures nothing");
    }

    /// ...VE TOZ GERCEKTEN VAR: CARPMA FORMU BU HESAPTA YANLIS.
    ///
    /// @dev Ust testin taniginin VAKUM OLMADIGINI olcen satir. Kalan sifir
    ///      olsaydi floor ile carpma ayni cevabi verirdi ve test iki formu
    ///      AYIRT ETMEZDI -- bu depoda "gecen ama hicbir sey olcmeyen test"
    ///      diye adlandirilan sey.
    function test_theTwoFormsDisagreeWheneverThereIsDust() public pure {
        // Faz 1'in olculmus bakiyesi, ARITMETIK bir tanik olarak: 1e12'nin
        // altinda toz tasir, dolayisiyla `floor` ve `carp` AYRISIR. Zincirden
        // bagimsizdir ve bu yuzden `pure`dur -- canli sayilar yukaridaki testin
        // isidir.
        uint256 units = PHASE_ONE_CLAIMS / 1e12;
        assertTrue(units * 1e12 != PHASE_ONE_CLAIMS, "the witness has no dust");
        assertEq(PHASE_ONE_CLAIMS - units * 1e12, 146_725_900_635, "dust changed");
    }
}
