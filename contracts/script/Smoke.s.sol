// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {DeployLib, Plan} from "./DeployLib.sol";
import {Profile, Profiles} from "./Profiles.sol";

/// @title Smoke
/// @notice Task 7: CANLI zincirde bir launch, UC GIRIS NOKTASINDAN DA islem,
///         bilincli bir tamamlama, ve bosluklarin kanitlanmasi.
///
/// @dev ADIMLARA BOLUNDU VE SEBEBI SU: her adim ayri yayinlanir, aralarinda
///      zincirden DOGRULANIR. Tek bir dev `run()` daha az tur atardi ama bir
///      revert her seyi goturur ve hangi adimda oldugunu ancak trace'ten
///      cikarirdik.
///
/// @dev UC GIRIS NOKTASI DA YURUNUR. Bu deponun bir numarali kusuru "bir giris
///      noktasinda kapali olan hepsinde kapali okunur"; yalnizca
///      `buyExactQuoteIn` yuruten bir smoke, o kusurun TA KENDISI olurdu.
contract Smoke is Script {
    string internal constant SMOKE_NAME = "Arcpad Smoke";
    string internal constant SMOKE_SYMBOL = "SMOKE";
    string internal constant SMOKE_URI = "ipfs://arcpad-smoke-v1";

    /// @notice Deploy edilmis factory, defterden degil ZINCIR VERISINDEN
    ///         turetilir -- adres defteri Task 7'den SONRA yazilacak.
    function factoryAddress() public view returns (address) {
        Profile memory p = Profiles.forChain(block.chainid);
        (address governor, address treasury) = Profiles.governanceForChain(block.chainid);
        Plan memory plan = DeployLib.build(block.chainid, p, msg.sender, governor, treasury);
        return plan.factory;
    }

    // ---------------------------------------------------------------
    // Step A -- a real launch
    // ---------------------------------------------------------------

    function smokeLaunch() public returns (address token, address curve) {
        LaunchFactory f = LaunchFactory(factoryAddress());

        (address predictedToken, address predictedCurve) =
            f.predictAddresses(msg.sender, SMOKE_NAME, SMOKE_SYMBOL, SMOKE_URI, f.launchCount());

        vm.startBroadcast();
        (token, curve) = f.launch(SMOKE_NAME, SMOKE_SYMBOL, SMOKE_URI);
        vm.stopBroadcast();

        require(token == predictedToken, "token address diverged from predictAddresses");
        require(curve == predictedCurve, "curve address diverged from predictAddresses");
        require(f.isCanonical(token), "the factory does not recognise its own token");
        require(f.launchCount() == 1, "launchCount did not move to 1");

        console2.log("=== SMOKE: launch ===");
        console2.log("token       ", token);
        console2.log("curve       ", curve);
        console2.log("launchCount ", f.launchCount());
        console2.log("isCanonical ", f.isCanonical(token));
        console2.log("TOTAL_SUPPLY", LaunchToken(token).TOTAL_SUPPLY());
        console2.log("curve holds ", LaunchToken(token).balanceOf(curve));
    }

    // ---------------------------------------------------------------
    // Step B -- all three entrypoints
    // ---------------------------------------------------------------

    function smokeTrades(address curve) public {
        BondingCurve c = BondingCurve(payable(curve));
        LaunchToken t = LaunchToken(c.token());

        // --- 1. buyExactQuoteIn ---
        uint256 gross1 = 0.05e18;
        _logState(c, "before buyExactQuoteIn");
        vm.startBroadcast();
        c.buyExactQuoteIn{value: gross1}(1);
        vm.stopBroadcast();
        _logState(c, "after  buyExactQuoteIn");

        // --- 2. buyExactTokensOut ---
        uint256 tokensOut = 1_000_000e18;
        uint256 cost = CurveMath.quoteBuyCost(tokensOut, c.virtualQuoteReserves(), c.virtualTokenReserves());
        // UCRETLER PARCALARDAN TOPLANIR, 125'ten BOLUNMEZ: `feeOn` yukari
        // yuvarlar, yani feeOn(x,95) + feeOn(x,30) >= feeOn(x,125) ve esitlik
        // GARANTI DEGILDIR.
        uint256 fee2 = CurveMath.feeOn(cost, c.PROTOCOL_FEE_BPS()) + CurveMath.feeOn(cost, c.CREATOR_FEE_BPS());
        vm.startBroadcast();
        c.buyExactTokensOut{value: cost + fee2}(tokensOut, cost + fee2);
        vm.stopBroadcast();
        _logState(c, "after  buyExactTokensOut");

        // --- 3. sellExactTokensIn ---
        uint256 tokensIn = 500_000e18;
        vm.startBroadcast();
        t.approve(curve, tokensIn);
        c.sellExactTokensIn(tokensIn, 1);
        vm.stopBroadcast();
        _logState(c, "after  sellExactTokensIn");

        console2.log("=== SMOKE: all three entrypoints exercised ===");
        console2.log("trader token balance", t.balanceOf(msg.sender));
    }

    // ---------------------------------------------------------------
    // Step C -- deliberate completion
    // ---------------------------------------------------------------

    function smokeFill(address curve) public {
        BondingCurve c = BondingCurve(payable(curve));
        uint256 remaining = c.realTokenReserves();
        require(remaining > 0, "already complete");

        uint256 cost = CurveMath.quoteBuyCost(remaining, c.virtualQuoteReserves(), c.virtualTokenReserves());
        uint256 fee = CurveMath.feeOn(cost, c.PROTOCOL_FEE_BPS()) + CurveMath.feeOn(cost, c.CREATOR_FEE_BPS());

        console2.log("=== SMOKE: fill ===");
        console2.log("remaining sale supply", remaining);
        console2.log("cost                 ", cost);
        console2.log("fee (95 + 30, summed)", fee);
        console2.log("gross                ", cost + fee);

        vm.startBroadcast();
        c.buyExactTokensOut{value: cost + fee}(remaining, cost + fee);
        vm.stopBroadcast();

        require(c.complete(), "curve did not complete");
        _logState(c, "after  fill");
        console2.log("complete       ", c.complete());
        console2.log("poolSeedSupply ", c.poolSeedSupply());
    }

    // ---------------------------------------------------------------
    // Read-only verification
    // ---------------------------------------------------------------

    /// @notice Escrow'un defteri, UCRETLERIN PARCALARDAN toplanmis haliyle.
    function escrowLedger(address curve)
        public
        view
        returns (uint256 owedProtocol, uint256 owedCreator, uint256 total)
    {
        BondingCurve c = BondingCurve(payable(curve));
        FeeEscrow e = FeeEscrow(payable(c.escrow()));
        owedProtocol = e.owed(c.protocolTreasury());
        owedCreator = e.owed(c.creator());
        total = e.totalOwed();
        console2.log("=== SMOKE: escrow ledger ===");
        console2.log("owed protocol", owedProtocol);
        console2.log("owed creator ", owedCreator);
        console2.log("totalOwed    ", total);
        console2.log("escrow balance", c.escrow().balance);
    }

    function _logState(BondingCurve c, string memory when) private view {
        console2.log("--", when);
        console2.log("   virtualTokenReserves", c.virtualTokenReserves());
        console2.log("   virtualQuoteReserves", c.virtualQuoteReserves());
        console2.log("   realTokenReserves   ", c.realTokenReserves());
        console2.log("   realQuoteReserves   ", c.realQuoteReserves());
    }
}
