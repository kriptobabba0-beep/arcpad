// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/// @dev Transient storage'i gercek Arc calistirma katmaninda deneyen yardimci.
///      Yerel EVM'de gecmesi Arc'ta gececegi anlamina gelmez; bu yuzden ayni
///      kontrol hem birim hem fork testinde var.
contract TransientProbe {
    function roundTrip(uint256 value) external returns (uint256 readBack) {
        assembly {
            tstore(0, value)
            readBack := tload(0)
        }
    }
}

contract ArcNetworkForkTest is Test {
    /// Arc'ta native varlik USDC'nin kendisidir. Bu adres ayni bakiyenin
    /// 6 decimal'lik ERC-20 gorunumudur -- ayri bir token DEGILDIR.
    address internal constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    function test_forkIsArcTestnet() public view {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID, "fork is not Arc testnet");
    }

    function test_expectedSystemContractsArePresent() public view {
        assertGt(USDC_ERC20.code.length, 0, "USDC ERC-20 view missing");
        assertGt(MULTICALL3.code.length, 0, "Multicall3 missing");
        assertGt(PERMIT2.code.length, 0, "Permit2 missing");
    }

    /// Faz 2'nin butun hook-deploy stratejisi bu factory uzerinden CREATE2
    /// salt madenciligine dayanir (design spec SS3.1, "Dogrulanmis gercekler").
    /// Adres bos donerse hook adres madenciligi hic baslayamaz.
    function test_create2DeployerIsPresent() public view {
        assertGt(CREATE2_DEPLOYER.code.length, 0, "CREATE2 deterministic deployer missing");
    }

    /// Uniswap V4 icin hayati: Arc bu opcode'u desteklemezse V4 hic calismaz.
    function test_transientStorageWorksOnArc() public {
        TransientProbe probe = new TransientProbe();
        assertEq(probe.roundTrip(1153), 1153, "EIP-1153 unavailable on Arc");
    }

    /// Design spec SS3.3, "Arc'in EVM farklari": "PREVRANDAO her zaman 0 --
    /// zincir ustu rastgelelik yok." Bu projede rastgelelige ihtiyac yoktur,
    /// ama varsayim sessizce degisirse (Arc bir gun gercek prevrandao
    /// donmeye baslarsa) bunu erken yakalamak icin varsayim burada surekli
    /// dogrulanir.
    function test_prevrandaoIsAlwaysZeroOnArc() public view {
        assertEq(block.prevrandao, 0, "Arc started returning nonzero PREVRANDAO - revisit randomness assumptions");
    }

    /// Design spec SS3.3: "Sifir adrese native transfer yasak ('Zero address
    /// not allowed' ile revert). Native USDC yakilamaz."
    ///
    /// Bu kural Arc'in calistirma istemcisine gomulu, standart EVM bytecode
    /// semantiginin DISINDA bir davranistir -- forge'un forklu testte
    /// kullandigi yerel revm bunu uygulamaz (dogrudan `address(0).call{value:
    /// 1}("")` yerelde SESSIZCE basarili doner; bu denendi ve dogrulandi).
    /// Bu yuzden cagri `vm.rpc` ile forkun arkasindaki GERCEK Arc RPC'sine
    /// `eth_call` olarak gonderilir; yalnizca o zaman gercek revert
    /// gozlemlenebilir. try/catch, RPC hatasinin testin kendisini revert
    /// ettirmesini engeller -- yalnizca cagrinin basarisiz oldugu dogrulanir.
    function test_nativeTransferToZeroAddressReverts() public {
        string memory params = string.concat(
            '[{"from":"',
            vm.toString(address(this)),
            '","to":"0x0000000000000000000000000000000000000000","value":"0x1"},"latest"]'
        );

        bool reverted;
        try vm.rpc("eth_call", params) {
            reverted = false;
        } catch {
            reverted = true;
        }
        assertTrue(reverted, "native transfer to zero address should revert on Arc");
    }

    /// Kanonik Uniswap deployment'i Arc testnet'te YOKTUR -- ama design spec
    /// SS3.4'un belirttigi gibi testnet'te onlarca dogrulanmis UCUNCU TARAF
    /// PoolManager/V4Quoter/V3Factory deployment'i VAR. Bu test hepsini
    /// degil, yalnizca Uniswap'in resmi V3 factory adresini kontrol eder:
    /// Uniswap'in tum aglarda ayni CREATE2 adresiyle deploy ettigi, iyi
    /// bilinen tekil bir kontrat, bu yuzden "Uniswap burada resmi olarak
    /// deploy etmedi" iddiasi icin temsilci (proxy) adres olarak secildi.
    function test_noCanonicalUniswapV3FactoryOnArcTestnet() public view {
        address canonicalV3Factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        assertEq(
            canonicalV3Factory.code.length,
            0,
            "canonical Uniswap V3 factory appeared on Arc testnet - revisit Phase 2 plan"
        );
    }
}
