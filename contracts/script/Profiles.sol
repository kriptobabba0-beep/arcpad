// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";

/// @notice Bir curve profili: ekonomiyi belirleyen ucu ve adi.
struct Profile {
    string name;
    uint256 virtualTokenReserves; // T
    uint256 virtualQuoteReserves; // V
    uint256 saleSupply; // S
}

/// @title Profiles
/// @notice ZINCIR -> PROFIL bagi. Bu depodaki TEK fail-open degeri kapatan sey.
///
/// @dev SORUN. `LaunchFactory`in yedi korumasindan ikisi
///      (`MIN_OPENING_MARKET_CAP`, `MIN_GRADUATION_RAISE`) TESTNET profilinin
///      kendi degeri uzerine oturur. Yani testnet profili HER zincirde yediden
///      de gecer: olculdu, deploy edilebilir en kucuk `V` TAM OLARAK testnet
///      `V`sidir -- uretimin 1000 kati altinda, sifir paylik. Kontrat tarafinda
///      buna koruma konamaz ve konmamalidir: testnet profili ZORUNLUDUR (Circle
///      faucet'i istek basina 10 USDC verir; 12.161 USDC'lik uretim esiginde
///      graduation kodu hic test edilemezdi). Kontrol bu yuzden BURADA.
///
/// @dev UC PARCA, HER BIRI TEK BIR IS:
///        (1) zincir -> profil ADI   -- BURADA, `pure`, PARAMETRESIZ.
///        (2) profil adi -> DIGEST   -- BURADA, profil basina bir sabit.
///        (3) profil adi -> SAYILAR  -- `deploy/profiles.toml`, VERI.
///      (1) TEK BASINA YETMEZ: zinciri bir ADA baglar, ad ise BUYUKLUKTEN hic
///      soz etmez -- testnet satirinda kaymis bir `V` yine "testnet" diye
///      cozulur ve yine deploy olur. FAIL-OPEN'I KAPATAN PARCA (2)'DIR.
///      (3)'un veri olmasi TypeScript tarafiyla TEK KAYNAK paylasmak icindir.
///
/// @dev BAGI VERIYE TASIMAK YASAKTIR. `[chains.5042002].profile = "..."` gibi
///      bir satir, kontrolun engellemek icin var oldugu islemi -- bir veri
///      dosyasi duzenleyip baska bir profil deploy etmeyi -- MUMKUN kilardi.
///
/// @dev URETIM ZINCIR ID'SI BILEREK KAYITSIZDIR. Circle hicbir mainnet chain id
///      yayinlamadi; ucuncu taraflarin andigi `5042` dogrulanamadi ve Arc'in
///      kendi dokumaninda GECMEZ. `nameForChain(5042)` BUGUN revert eder ve
///      etmelidir: mainnet deploy'u chain id'yi ekleyen INCELENMIS bir commit
///      gerektirir -- yani yanlis profili farkedecek olan incelemeyi.
library Profiles {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant TESTNET = "testnet";
    string internal constant PRODUCTION = "production";

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;
    uint256 internal constant LOCAL_REHEARSAL_CHAIN_ID = 31337;

    /// @dev keccak256(abi.encode(T, V, S)). ELLE TURETILDI. Dosyadan okunan
    ///      ucluyu hash'leyip buraya karsilastiran bir test TOTOLOJIDIR; sabit
    ///      ELLE YAZILMIS literallere pinlenir (bkz.
    ///      test_digestIsTheHashOfTheHandWrittenTriple).
    ///
    /// @dev BU DIGEST'IN NEYI KAPATTIGI, NEYI KAPATMADIGI -- VE IKINCISININ
    ///      NEDEN BASKA BIR YERE AIT OLDUGU. Olculdu (inceleme, iki saldiri):
    ///
    ///        (a) YALNIZCA `profiles.toml` duzenlenirse: 29/44 Solidity ve
    ///            14/41 TypeScript testi kirmizilasir, VE `plan()` ile `run()`
    ///            hicbir sey insa edilmeden once `ProfileDigestMismatch` ile
    ///            olur. Yani bu digest DEPLOY ZAMANINDA kapatir.
    ///
    ///        (b) `profiles.toml` VE yukaridaki sabit BIRLIKTE duzenlenirse:
    ///            deploy zamanindaki kapi GECER. Kalan 8 kirmizi testin hepsi
    ///            BAGIMSIZ ELLE YAZILMIS literallerden gelir --
    ///            `test_digestIsTheHashOfTheHandWrittenTriple`,
    ///            `Deploy.t.sol`daki yerinde literaller, ve TypeScript
    ///            tarafindaki `PROFILE_DIGESTS`. Yani CI ZAMANINDA kapanir.
    ///
    ///      AYRIM KASITLIDIR VE (b)'yi deploy zamanina tasimak MUMKUN DEGILDIR.
    ///      Tek dosyalik duzenleme bir KAZADIR: kaymis bir us bir yazim
    ///      hatasidir ve yazim hatalari dogasi geregi tek dosyaliktir; kazanin
    ///      zarar verecegi ANDA yakalanmasi gerekir, o yuzden digest buradadir.
    ///      Iki dosyalik duzenleme KAZA DEGILDIR; ve ona karsi HICBIR deploy
    ///      zamani kontrolu ILKESEL OLARAK yardim edemez, cunku her deploy
    ///      zamani kontrolu deploy'u AGACTAKI bir seyle karsilastirir ve
    ///      koordineli bir duzenleme agaci degistirir. Ucuncu bir sabit eklemek
    ///      bunu yalnizca uc dosyalik bir duzenlemeye cevirirdi. Savunma daha
    ///      guclu bir KONTROL degil, DAHA BUYUK VE DAHA GOZE CARPAN BIR
    ///      DIFF'tir -- ve "iki dilde bes dosyayi tutarli bicimde duzenlemek
    ///      zorundasin" kuralini uygulayan sey fazlaliktir: CI'da kontrol
    ///      edilir, insan tarafindan diff'te okunur.
    ///
    ///      OZET: digest DEPLOY ZAMANINDA bir DOGRULUK kapisidir; elle yazilmis
    ///      literaller INCELEME ZAMANINDA bir BUTUNLUK kapisidir.
    ///
    ///      BAGLI OLDUGU KOSUL, ACIKCA: bu yalnizca CI ZORUNLU BIR KAPI
    ///      KALDIGI SURECE gecerlidir. Fork isini tavsiye niteligine
    ///      dusurmek, (b)'ye karsi tek savunmayi da dusurur.
    ///        T = 1_073_000_000e18, V = 4_292e15, S = 793_100_000e18
    bytes32 internal constant TESTNET_DIGEST = 0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d;
    ///        T = 1_073_000_000e18, V = 4_292e18, S = 793_100_000e18
    bytes32 internal constant PRODUCTION_DIGEST = 0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3;

    string internal constant PROFILES_PATH = "deploy/profiles.toml";
    string internal constant GOVERNANCE_PATH = "deploy/expected-governance.json";

    /// @dev SAYILARIN dosyasi bir digest ile bagliydi; ADRESLERIN dosyasi
    ///      DEGILDI, ve o asimetri yanlis taraftaydi. `governor` ve `treasury`
    ///      factory'nin initcode'una girer, yani factory adresini KALICI olarak
    ///      belirler -- ve `LaunchFactory` her curve ile her token adresini
    ///      `address(this)`ten turettigi icin ARC'TA URETILECEK HER ADRESI
    ///      transitif olarak belirler. `assertDeployable` yalnizca ">= 2-of-3
    ///      Safe" ister; bunu HERHANGI bir Safe saglar.
    ///
    ///      Bugun aciklik SIFIRDIR cunku arc-testnet girisi sifirdir ve sifir
    ///      fail-closed'dir. AMA TASK 4 O GIRISI DOLDURACAK. O an geldiginde
    ///      JSON'u TEK BASINA duzenlemek yanlis bir factory adresi uretebilirdi;
    ///      bu digest onu, sayilar tarafinda `ProfileDigestMismatch`in yaptigi
    ///      seyin AYNISIYLA kapatir: dosyayi degistirmek DERLENEN bir sabiti de
    ///      degistirmeyi, yani INCELENMIS bir commit'i gerektirir.
    ///
    ///      keccak256(abi.encode(governor, treasury, owners)).
    ///
    /// @dev `owners` DA ICERIDEDIR VE BU BIR INCELEME BULGUSUDUR. Ilk hal
    ///      yalnizca `(governor, treasury)`yi baglıyordu; ama Task 4 ayni
    ///      dosyaya UCUNCU bir adres-belirleyici alan ekledi. `owners`
    ///      Safe'in initializer'ina girer, initializer salt'a girer, salt
    ///      Safe ADRESINE girer -- ve Safe adresi factory'nin constructor
    ///      argumanidir. Yani owner dizisini degistirmek (SIRASINI degistirmek
    ///      dahil) factory adresini ve transitif olarak Arc'ta uretilecek her
    ///      adresi degistirir. Baglanmamis birakmak, digest'in kapattigi
    ///      yolu ucuncu bir alan icin acik birakmakti.
    ///
    ///      SIRA DA BAGLANIR VE BU KASITLIDIR: `abi.encode` diziyi sirasiyla
    ///      kodlar, yani JSON'daki owner sirasini degistirmek digest'i
    ///      degistirir. Dogru davranis budur -- o sira Safe adresinin ta
    ///      kendisini belirler, dolayisiyla "zararsiz bir yeniden siralama"
    ///      diye bir sey YOKTUR.
    ///
    ///        arc-testnet : governor 0x9705…2C22, treasury 0xebBe…B10c.
    ///          Task 4'te CANLI OLARAK deploy edilen iki Safe (2-of-3, SafeL2
    ///          singleton 0x29fc…C762 -- proxy'lerin slot 0'indan dogrulandi).
    ///          Onceki deger keccak256(abi.encode(0, 0)) =
    ///          0xad3228b6…5fb5 idi ve dosya bos oldugu surece fail-closed
    ///          davraniyordu; bu satirin Task 4'te degismesi ZORUNLULUGU
    ///          I-5'in tam olarak istedigi seydi -- dosyayi doldurmak
    ///          DERLENEN bir sabiti de degistirmeyi, yani incelenmis bir
    ///          commit'i gerektirdi.
    bytes32 internal constant ARC_TESTNET_GOVERNANCE_DIGEST =
        0xb6e2e4ecdaf85e412134db6b712d40f865ad41530e34d39899cb217c84ef7231;
    ///        local-rehearsal : (0x...0601, 0x...7EA5)
    bytes32 internal constant LOCAL_REHEARSAL_GOVERNANCE_DIGEST =
        0xe6f2c135e35a3802236d62ccc1e86fd7ddf7fafc066cb2dc036b4d63ad9a1892;

    error UnregisteredChain(uint256 chainId);
    error UnknownProfileName(string name);
    error ProfileDigestMismatch(string name, bytes32 expected, bytes32 actual);
    error UnknownChainKey(string chainKey);
    error GovernanceDigestMismatch(string chainKey, bytes32 expected, bytes32 actual);

    /// @notice Bu zincire hangi profil aittir.
    /// @dev PARAMETRESIZ VE `pure`. Cagiran bir profil GECIREMEZ; "sessizce
    ///      atlanamaz" ozelligi tam olarak budur.
    function nameForChain(uint256 chainId) internal pure returns (string memory) {
        if (chainId == ARC_TESTNET_CHAIN_ID) return TESTNET;
        if (chainId == LOCAL_REHEARSAL_CHAIN_ID) return TESTNET;
        revert UnregisteredChain(chainId);
    }

    /// @notice Bu zincirin governance kaydindaki anahtari.
    /// @dev Profil adiyla AYNI DEGILDIR: iki zincir de "testnet" profilini
    ///      kullanir ama AYRI governance adresleri tasir.
    function chainKeyFor(uint256 chainId) internal pure returns (string memory) {
        if (chainId == ARC_TESTNET_CHAIN_ID) return "arc-testnet";
        if (chainId == LOCAL_REHEARSAL_CHAIN_ID) return "local-rehearsal";
        revert UnregisteredChain(chainId);
    }

    function digestFor(string memory name) internal pure returns (bytes32) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256(bytes(TESTNET))) return TESTNET_DIGEST;
        if (h == keccak256(bytes(PRODUCTION))) return PRODUCTION_DIGEST;
        revert UnknownProfileName(name);
    }

    /// @notice MEKANIZMA: verilen dosyadan verilen profili okur ve digest'ler.
    /// @dev Politikadan AYRI DURUR, cunku negatif testin GERCEK bir bozuk
    ///      dosyayi yurumesi gerekir.
    function readFrom(string memory tomlPath, string memory name) internal view returns (Profile memory p) {
        string memory toml = vm.readFile(tomlPath);
        p.name = name;
        p.virtualTokenReserves = _num(toml, name, "virtualTokenReserves");
        p.virtualQuoteReserves = _num(toml, name, "virtualQuoteReserves");
        p.saleSupply = _num(toml, name, "saleSupply");

        bytes32 expected = digestFor(name);
        bytes32 actual = keccak256(abi.encode(p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply));
        if (actual != expected) revert ProfileDigestMismatch(name, expected, actual);
    }

    /// @notice POLITIKA: bu zincire ait profil.
    function forChain(uint256 chainId) internal view returns (Profile memory) {
        return readFrom(PROFILES_PATH, nameForChain(chainId));
    }

    function governanceDigestFor(string memory chainKey) internal pure returns (bytes32) {
        bytes32 h = keccak256(bytes(chainKey));
        if (h == keccak256("arc-testnet")) return ARC_TESTNET_GOVERNANCE_DIGEST;
        if (h == keccak256("local-rehearsal")) return LOCAL_REHEARSAL_GOVERNANCE_DIGEST;
        revert UnknownChainKey(chainKey);
    }

    /// @notice MEKANIZMA: governance dosyasini okur ve digest'ler.
    /// @dev `readFrom`un ADRESLER icin ikizi, ve bilincli olarak AYNI SEKILDE
    ///      yazildi: mekanizma (verilen dosya) politikadan (kanonik yol)
    ///      ayridir, boylece negatif test GERCEK bir bozuk dosya yurutebilir.
    function readGovernanceFrom(string memory jsonPath, string memory chainKey)
        internal
        view
        returns (address governor, address treasury, address[] memory owners)
    {
        string memory json = vm.readFile(jsonPath);
        governor = vm.parseJsonAddress(json, string.concat(".", chainKey, ".governor"));
        treasury = vm.parseJsonAddress(json, string.concat(".", chainKey, ".treasury"));
        owners = vm.parseJsonAddressArray(json, string.concat(".", chainKey, ".owners"));

        bytes32 expected = governanceDigestFor(chainKey);
        bytes32 actual = keccak256(abi.encode(governor, treasury, owners));
        if (actual != expected) revert GovernanceDigestMismatch(chainKey, expected, actual);
    }

    /// @notice POLITIKA: bu zincire ait governance.
    function governanceForChain(uint256 chainId) internal view returns (address governor, address treasury) {
        (governor, treasury,) = readGovernanceFrom(GOVERNANCE_PATH, chainKeyFor(chainId));
    }

    /// @notice Bu zincirin BEYAN EDILEN owner kumesi, BEYAN EDILEN SIRASIYLA.
    /// @dev SIRA KORUNUR. Bu dizi Safe'in initializer'ina oldugu gibi girer;
    ///      siralamak Safe adresini -- ve onunla factory adresini -- degistirir.
    function ownersForChain(uint256 chainId) internal view returns (address[] memory owners) {
        (,, owners) = readGovernanceFrom(GOVERNANCE_PATH, chainKeyFor(chainId));
    }

    /// @dev Ondalik STRING olarak okunur; TOML tamsayilari i64'tur ve
    ///      T = 1.073e27 SIGMAZ.
    function _num(string memory toml, string memory name, string memory key) private pure returns (uint256) {
        return vm.parseUint(vm.parseTomlString(toml, string.concat(".profiles.", name, ".", key)));
    }
}
