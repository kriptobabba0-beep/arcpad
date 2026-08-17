// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title ProbeArcChain
/// @notice Faz 2 Task 0. Iki paralel arastirma celisiyor: biri Uniswap
///         Labs'in v2+v3+v4'u chain `5042`'ye deploy ettigini bildiriyor,
///         digeri Arc'in tum dokumantasyonunda YALNIZCA `5042002`'nin
///         gectigini olcuyor. Bu sonda celisikiyi ZINCIRE SORARAK kapatir.
///
/// @dev    `vm.createSelectFork` KULLANILMAZ. Fork yerel revm'de kosar ve
///         uzak istemcinin kendi cevabini gizler; ayni ders Faz 0'da
///         `test_nativeTransferToZeroAddressReverts` ile kayda gecti. Burada
///         her cagri `vm.rpc` ile DOGRUDAN uzak hosta gider.
///
///         POZITIF KONTROL ZORUNLULUGU. Faz 0'in fork testi tam su hatayi
///         yapti: `try/catch` ile sarilmis bir `vm.rpc`, bir 429'u da
///         "beklenen revert" gibi okuyordu. Bu sondada bir hostun V4
///         adreslerinde `0x` gormesi, YALNIZCA ayni hostta iki pozitif
///         kontrol (USDC ERC-20 gorunumu ve CREATE2 deployer) KOD DONDURDUYSE
///         bir sey ifade eder. Aksi halde sonuc "V4 yok" degil, "SONDA
///         GECERSIZ"dir. Script bunu kendisi hesaplar ve gecersizse
///         `run()` sonunda GURULTULU bicimde revert eder -- sessiz bir
///         bos kosu asla "V4 bulunamadi" diye okunamasin diye.
contract ProbeArcChain is Script {
    /// Aday host listesi. Task 0 briefi bu listeyi TAM olarak sabitler ve
    /// genisletilmesini yasaklar.
    string[7] internal hosts = [
        "https://rpc.testnet.arc.io", // dokumante, 5042002 bekleniyor
        "https://rpc.testnet.arc.network", // eski alan adi, dokumante DEGIL
        "https://rpc.mainnet.arc.io", // olculdu: Cloudflare 403 HTML
        "https://rpc.arc.io",
        "https://rpc.mainnet.arc.network",
        "https://arc.rpc.circle.com",
        "https://rpc.arc.network"
    ];

    /// Ilk DORDU kanonik V4 `PoolManager` adresleridir. Son IKISI POZITIF
    /// KONTROLDUR ve sondanin gecerliligi onlara baglidir.
    address[6] internal probeTargets = [
        0x000000000004444c5dc75cB358380D2e3dE08A90, // V4 PoolManager (Ethereum mainnet)
        0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32, // V4 PoolManager (Arbitrum/X Layer/Ink/Soneium)
        0x1F98400000000000000000000000000000000004, // V4 PoolManager (Unichain)
        // NOT: Task 0 briefi bu adresi `0x498581fF718922c3f8e6a244956aF099B2652b2b`
        // yazar; o yazim EIP-55 checksum'ini GECMEZ (solc 9429 ile reddeder).
        // Adres baytlari ayni, yalnizca tek harfin buyuk/kucuk hali yanlis.
        0x498581fF718922c3f8e6A244956aF099B2652b2b, // V4 PoolManager (Base)
        0x3600000000000000000000000000000000000000, // ERC-20 USDC       -- POZITIF KONTROL
        0x4e59b44847b379578588920cA78FbF26c0B4956C // CREATE2 deployer  -- POZITIF KONTROL
    ];

    uint256 internal constant V4_TARGET_COUNT = 4;
    uint256 internal constant FIRST_POSITIVE_CONTROL = 4;

    /// Celisen iki iddia.
    uint256 internal constant CLAIMED_CHAIN_ID = 5042;
    uint256 internal constant DOCUMENTED_CHAIN_ID = 5042002;

    /// Arc, ES ZAMANLI *VE* ARDISIK `eth_call`'lari hiz sinirlar (Faz 0
    /// olcumu). Sonda 7 host x 3 + cevap veren host basina 6 cagri yapar;
    /// pacing olmadan bir 429 sessizce "kod yok" gibi okunabilirdi -- ki
    /// pozitif kontrolun yakalamak icin var oldugu hata tam olarak budur.
    uint256 internal constant PACE_MS = 250;

    struct HostResult {
        bool reachable;
        uint256 chainId;
        uint256 blockNumber;
        string clientVersion;
        bool positiveControlsPassed;
        uint256 v4AddressesWithCode;
        uint256 probeErrors;
    }

    function run() external {
        console2.log("=== ProbeArcChain ===");
        console2.log("chain id iddiasi (hazirlik denetimi):", CLAIMED_CHAIN_ID);
        console2.log("chain id dokumante (Arc llms-full.txt):", DOCUMENTED_CHAIN_ID);
        console2.log("");

        HostResult[7] memory results;

        uint256 reachableCount;
        bool anyHostClaimsChainId;
        bool claimedChainHasV4;
        bool anyValidProbe;

        for (uint256 i = 0; i < hosts.length; i++) {
            results[i] = probeHost(hosts[i]);

            if (!results[i].reachable) continue;
            reachableCount++;

            if (results[i].positiveControlsPassed) anyValidProbe = true;

            if (results[i].chainId == CLAIMED_CHAIN_ID) {
                anyHostClaimsChainId = true;
                // Sonuc B, YALNIZCA sonda o hostta GECERLIYKEN iddia
                // edilebilir. Gecersiz bir sondada `v4AddressesWithCode == 0`
                // hicbir sey kanitlamaz.
                if (results[i].positiveControlsPassed && results[i].v4AddressesWithCode > 0) {
                    claimedChainHasV4 = true;
                }
            }
        }

        console2.log("=== OZET ===");
        console2.log("cevap veren host sayisi:", reachableCount);
        console2.log("pozitif kontrolu GECEN host sayisi (gecerli sonda):", anyValidProbe ? 1 : 0);

        // Bir hostun bile gecerli sonda vermedigi kosu, "V4 yok" DEGIL,
        // "sonda gecersiz"dir. Bu, gorevin tek olumcul hatasini kapatir.
        require(anyValidProbe, "SONDA GECERSIZ: hicbir host pozitif kontrolleri gecmedi; 0x sonuclari anlamsiz");

        if (!anyHostClaimsChainId) {
            console2.log("SONUC: A -- hicbir host 5042 dondurmedi.");
            console2.log("5042 dogrulanamadi. Faz 2 kendi PoolManager'ini deploy eder. src/ degismez.");
        } else if (claimedChainHasV4) {
            console2.log("SONUC: B -- bir host 5042 dondurdu VE kanonik bir V4 adresi kod tasiyor.");
        } else {
            console2.log("SONUC: C -- bir host 5042 dondurdu ama dort V4 adresinin hicbiri kod tasimiyor.");
        }
    }

    function probeHost(string memory host) internal returns (HostResult memory result) {
        console2.log("--- host:", host);

        try vm.rpc(host, "eth_chainId", "[]") returns (bytes memory raw) {
            result.reachable = true;
            result.chainId = toUint(raw);
            console2.log("  eth_chainId:", result.chainId);
        } catch {
            console2.log("  eth_chainId: CEVAP YOK (DNS/baglanti/HTTP hatasi)");
            return result;
        }

        pace();
        try vm.rpc(host, "eth_blockNumber", "[]") returns (bytes memory raw) {
            result.blockNumber = toUint(raw);
            console2.log("  eth_blockNumber:", result.blockNumber);
        } catch {
            result.probeErrors++;
            console2.log("  eth_blockNumber: HATA");
        }

        pace();
        try vm.rpc(host, "web3_clientVersion", "[]") returns (bytes memory raw) {
            result.clientVersion = string(raw);
            console2.log("  web3_clientVersion:", result.clientVersion);
        } catch {
            result.probeErrors++;
            console2.log("  web3_clientVersion: HATA");
        }

        uint256 positiveControlsWithCode;

        for (uint256 j = 0; j < probeTargets.length; j++) {
            pace();

            string memory params = string.concat("[\"", vm.toString(probeTargets[j]), "\",\"latest\"]");

            // ONEMLI: cagrinin KENDISININ hata vermesi ile adresin BOS olmasi
            // ayri ayri kaydedilir. Ikisini ayni kovaya atmak, Faz 0'in
            // 429'u "beklenen revert" sayan hatasinin ta kendisidir.
            try vm.rpc(host, "eth_getCode", params) returns (bytes memory code) {
                bool isPositiveControl = j >= FIRST_POSITIVE_CONTROL;

                console2.log(
                    string.concat(
                        "  eth_getCode ",
                        vm.toString(probeTargets[j]),
                        isPositiveControl ? "  [POZITIF KONTROL]" : "  [V4 PoolManager]"
                    ),
                    code.length
                );

                if (code.length > 0) {
                    if (isPositiveControl) positiveControlsWithCode++;
                    else result.v4AddressesWithCode++;
                }
            } catch {
                result.probeErrors++;
                console2.log(
                    string.concat("  eth_getCode ", vm.toString(probeTargets[j]), ": RPC HATASI (kod yok DEMEK DEGIL)")
                );
            }
        }

        result.positiveControlsPassed = positiveControlsWithCode == 2;

        if (result.positiveControlsPassed) {
            console2.log("  pozitif kontroller: GECTI -- bu hostun 0x sonuclari anlamli");
        } else {
            console2.log("  pozitif kontroller: DUSTU -- bu hostun 0x sonuclari ANLAMSIZ (sonda gecersiz)");
        }
    }

    /// JSON-RPC quantity cevaplari minimal big-endian bayt dizisi olarak
    /// doner (`0x4cef52` -> 3 bayt). `abi.decode` burada CALISMAZ.
    function toUint(bytes memory raw) internal pure returns (uint256 value) {
        require(raw.length <= 32, "quantity 32 bayttan uzun");
        for (uint256 i = 0; i < raw.length; i++) {
            value = (value << 8) | uint8(raw[i]);
        }
    }

    function pace() internal {
        vm.sleep(PACE_MS);
    }
}
