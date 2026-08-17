// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {BuybackDeployLib, BuybackPlan} from "./BuybackDeployLib.sol";
import {DeployLib} from "./DeployLib.sol";
import {PoolDeployLib} from "./PoolDeployLib.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";

/// @title DeployBuyback
/// @notice Buyback neslinin iki kalici kontrati. `Deploy` ve `DeployPool`in
///         ikizi -- `plan()` KURU KOSU, `run()` GERCEK, ikisi de AYNI
///         `_resolve()`den gecer.
///
/// @dev BU SCRIPT `DeployPool`DAN SONRA KOSAR. Sirasi zorunludur ama sebebi
///      bir constructor argumani DEGILDIR: hazine `graduationHook`u fabrikadan
///      calisma zamaninda okur. Zorunlu kilan sey ADIM 4'tur -- governor
///      `setGraduationHook(hook)` cagirabilmek icin hook'un ZINCIRDE olmasi
///      gerekir, ve o cagri olmadan mezuniyet sonrasi tahakkuk CALISMAZ.
///
/// @dev GOVERNOR ADIMLARI BURADA YAPILMAZ VE YAPILAMAZ. `setBuybackTreasury`,
///      `setGraduationHook` ve `setBuybackKeeper` `onlyGovernor`dur, governor
///      ise 2-of-3 bir Safe'tir. Script onlari YAZDIRIR; imzalamak operatorun
///      isidir. Bir `vm.prank` ile "halletmek" mumkun DEGILDIR ve olmamalidir:
///      ilk ikisi BIR KEZ yazilir, yani yanlis bir adres GERI ALINAMAZ.
contract DeployBuyback is Script {
    function plan() public view returns (BuybackPlan memory p) {
        p = _resolve();
        _print(p, "DRY RUN -- hicbir sey yayinlanmadi");
    }

    function run() public returns (BuybackPlan memory p) {
        p = _resolve();
        _print(p, "YAYINLANIYOR");

        vm.startBroadcast();
        // SIRA ZORUNLU: hazine kasanin adresini constructor argumani olarak
        // alir. Ters sira, kasanin adresini bilmeden hazineyi kodlamak
        // demektir ve CREATE2 on-tahmini cozulemezdi.
        address vaultAddr = DeployLib.deploy(p.vaultSalt, p.vaultInitcode);
        address treasuryAddr = DeployLib.deploy(p.treasurySalt, p.treasuryInitcode);
        vm.stopBroadcast();

        require(vaultAddr == p.vault, "vault address diverged from the plan");
        require(treasuryAddr == p.treasury, "treasury address diverged from the plan");

        BuybackDeployLib.assertAsDeployed(p);
        console2.log("read-back OK: iki kontrat da cozulen kablolamayi tasiyor");

        _printGovernorSteps(p);
    }

    /// @dev ADRESLER TURETMEDEN GELIR, ORTAM DEGISKENINDEN DEGIL --
    ///      `DeployPool._resolve`in ayni gerekcesi: bir `vm.envAddress`
    ///      satiri, kabuk gecmisindeki bir yazim hatasinin KALICI bir hazine
    ///      adresi uretebildigi bir dunya acardi.
    function _resolve() private view returns (BuybackPlan memory p) {
        uint256 chainId = block.chainid;
        p = BuybackDeployLib.build(
            chainId, PoolDeployLib.factoryFor(chainId), PoolDeployLib.escrowFor(chainId), PoolDeployLib.ARC_POOL_MANAGER
        );
        BuybackDeployLib.assertDeployable(p);
    }

    function _print(BuybackPlan memory p, string memory mode) private pure {
        console2.log("=== arcpad buyback deploy ===");
        console2.log(mode);
        console2.log("chainId              ", p.chainId);
        console2.log("factory              ", p.factory);
        console2.log("escrow               ", p.escrow);
        console2.log("PoolManager          ", p.poolManager);
        console2.log("BuybackVestingVault  ", p.vault);
        console2.log("BuybackTreasury      ", p.treasury);
    }

    /**
     * @dev OPERATOR KONTROL LISTESI, VE SIRASI TASIYICIDIR.
     *
     *      ADIM 3 OLMADAN OZELLIK SESSIZCE KAPALIDIR ve bu GUVENLI bir ara
     *      durumdur: `buybackPolicy` sifir doner, `setBuybackEnabled(true)`
     *      `BuybackUnavailable` ile reddedilir, egri ucretin tamamini
     *      creator'a oder. Yani yarim kalmis bir kurulum PARA KAYBETTIRMEZ.
     *
     *      ADIM 4 OLMADAN OZELLIK YALNIZCA EGRI ASAMASINDA CALISIR ve bu
     *      SESSIZDIR: mezuniyetten sonra hook `accrue` cagirir, hazine
     *      `NotAccrualVenue` ile reddeder ve SWAP TUMDEN REVERT EDER. Yani
     *      adim 4 atlanirsa mezun havuzlarda TICARET DURUR. Bu satirin
     *      buyuk harfle yazilmasinin sebebi budur.
     *
     *      ADIM 5 opsiyoneldir: anahtarci atanmasa bile `SWEEP_GRACE` (7 gun)
     *      sonrasinda supurme IZINSIZ hale gelir, yani fonlar kilitlenmez --
     *      yalnizca ilk supurme yedi gun gecikir.
     */
    function _printGovernorSteps(BuybackPlan memory p) private view {
        address hook = PoolDeployLib.ARC_HOOK;
        console2.log("");
        console2.log("SIRADAKI ADIMLAR -- GOVERNOR SAFE, VE OTOMATIK DEGILDIR:");
        console2.log("  3) setBuybackTreasury(", p.treasury, ")   [BIR KEZ, geri alinamaz]");
        console2.log("  4) setGraduationHook (", hook, ")   [BIR KEZ, geri alinamaz]");
        console2.log("  5) setBuybackKeeper  ( <anahtarci EOA> )   [dondurulebilir]");
        console2.log("");
        console2.log("ADIM 4 ATLANIRSA MEZUN HAVUZLARDA TICARET DURUR:");
        console2.log("  hook accrue cagirir -> hazine NotAccrualVenue der -> swap REVERT eder.");
        console2.log("ADIM 3 atlanirsa ozellik yalnizca KAPALI kalir (guvenli ara durum).");

        LaunchFactory f = LaunchFactory(p.factory);
        console2.log("");
        console2.log("ZINCIRDEKI MEVCUT DURUM (yayin oncesi okundu):");
        console2.log("  buybackTreasury  ", f.buybackTreasury());
        console2.log("  graduationHook   ", f.graduationHook());
        console2.log("  buybackKeeper    ", f.buybackKeeper());
    }
}
