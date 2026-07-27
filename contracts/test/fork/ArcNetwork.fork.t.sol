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

    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    function test_forkIsArcTestnet() public view {
        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID, "fork is not Arc testnet");
    }

    function test_expectedSystemContractsArePresent() public view {
        assertGt(USDC_ERC20.code.length, 0, "USDC ERC-20 view missing");
        assertGt(MULTICALL3.code.length, 0, "Multicall3 missing");
        assertGt(PERMIT2.code.length, 0, "Permit2 missing");
    }

    /// Uniswap V4 icin hayati: Arc bu opcode'u desteklemezse V4 hic calismaz.
    function test_transientStorageWorksOnArc() public {
        TransientProbe probe = new TransientProbe();
        assertEq(probe.roundTrip(1153), 1153, "EIP-1153 unavailable on Arc");
    }

    /// Kanonik Uniswap deployment'i Arc testnet'te YOKTUR. Bu test bunu
    /// belgeler; bir gun gecmeye baslarsa Faz 2'nin kendi PoolManager'ini
    /// deploy etme karari yeniden degerlendirilmelidir.
    function test_noCanonicalUniswapDeploymentOnArcTestnet() public view {
        address canonicalV3Factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
        assertEq(canonicalV3Factory.code.length, 0, "canonical Uniswap appeared on Arc testnet - revisit Phase 2 plan");
    }
}
