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
    ///      keccak256(abi.encode(governor, treasury)).
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
        0x00280904e53954edb8d84701d76d127dcdb861cafb039b5e0093ae0234f74375;
    ///        local-rehearsal : (0x...0601, 0x...7EA5)
    bytes32 internal constant LOCAL_REHEARSAL_GOVERNANCE_DIGEST =
        0x53ba4ecc78a97624249985e3dd16ece64902e4efc1b151cf0b314764f8d5539a;

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
        returns (address governor, address treasury)
    {
        string memory json = vm.readFile(jsonPath);
        governor = vm.parseJsonAddress(json, string.concat(".", chainKey, ".governor"));
        treasury = vm.parseJsonAddress(json, string.concat(".", chainKey, ".treasury"));

        bytes32 expected = governanceDigestFor(chainKey);
        bytes32 actual = keccak256(abi.encode(governor, treasury));
        if (actual != expected) revert GovernanceDigestMismatch(chainKey, expected, actual);
    }

    /// @notice POLITIKA: bu zincire ait governance.
    function governanceForChain(uint256 chainId) internal view returns (address governor, address treasury) {
        return readGovernanceFrom(GOVERNANCE_PATH, chainKeyFor(chainId));
    }

    /// @dev Ondalik STRING olarak okunur; TOML tamsayilari i64'tur ve
    ///      T = 1.073e27 SIGMAZ.
    function _num(string memory toml, string memory name, string memory key) private pure returns (uint256) {
        return vm.parseUint(vm.parseTomlString(toml, string.concat(".profiles.", name, ".", key)));
    }
}
