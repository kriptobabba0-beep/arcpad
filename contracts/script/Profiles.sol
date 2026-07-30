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

    error UnregisteredChain(uint256 chainId);
    error UnknownProfileName(string name);
    error ProfileDigestMismatch(string name, bytes32 expected, bytes32 actual);

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

    /// @dev Ondalik STRING olarak okunur; TOML tamsayilari i64'tur ve
    ///      T = 1.073e27 SIGMAZ.
    function _num(string memory toml, string memory name, string memory key) private pure returns (uint256) {
        return vm.parseUint(vm.parseTomlString(toml, string.concat(".profiles.", name, ".", key)));
    }
}
