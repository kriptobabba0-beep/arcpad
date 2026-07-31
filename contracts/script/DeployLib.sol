// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {Profile} from "./Profiles.sol";

/// @dev Safe'in yalnizca yoklamanin ihtiyac duydugu iki uyesi.
interface ISafeProbe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

struct Plan {
    uint256 chainId;
    Profile profile;
    address deployer;
    address governor;
    address treasury;
    bytes32 escrowSalt;
    bytes32 factorySalt;
    bytes escrowInitcode;
    bytes factoryInitcode;
    address escrow;
    address factory;
}

library DeployLib {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Kanonik deterministik deployer. Arc testnet'te OLCULDU: 69 bayt.
    address internal constant CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant CREATE2_FACTORY_CODE_LENGTH = 69;

    /// @dev KOD KIMLIGI, UZUNLUK DEGIL. Onceki hali `code.length == 69`
    ///      kontrol ediyordu ve bu YETERSIZDI: 69 baytlik HERHANGI bir kontrat
    ///      geciyordu. Bunun varsayimsal olmadigini bu dosyanin KENDI testleri
    ///      gosteriyor -- D5 ve D6 taniklari tam olarak o durumu kullaniyor
    ///      (69 baytlik, kanonik OLMAYAN bir deployer etch'lenir ve on-kontrol
    ///      bunu kabul eder). Onemli olan varsayim "o adreste 69 baytlik bir
    ///      sey var" degil, "o adreste KANONIK deployer var"dir: her tahmin
    ///      edilen adresi dogru kilan sey budur.
    ///
    ///      DEGER ARC TESTNET'TEN OLCULDU, bir incelemeciden veya
    ///      dokumantasyondan alinmadi:
    ///        cast keccak $(cast code 0x4e59b448... --rpc-url $ARC_RPC_URL)
    ///        -> 0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989
    bytes32 internal constant CREATE2_FACTORY_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    /// @dev `LaunchFactory` constructor'inin ABI-encode edilmis alti argumani:
    ///      6 * 32 bayt. Initcode'un KUYRUGUDUR.
    uint256 internal constant FACTORY_ARG_BYTES = 192;

    /// @dev Salt'lar SECILMEZ, TURETILIR.
    ///      keccak256("arcpad.FeeEscrow.v1")
    ///        = 0xc86ad978a80671d39d91fd5b65d5b29cc34a84fb29664012ce6de14effefa718
    ///      keccak256("arcpad.LaunchFactory.v1")
    ///        = 0xbe555c18d58e8926d5c280a3e9cbc89e2f14c6032e597b69644113c7092390e4
    bytes32 internal constant ESCROW_SALT = keccak256("arcpad.FeeEscrow.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("arcpad.LaunchFactory.v1");

    uint256 internal constant MIN_SAFE_THRESHOLD = 2;
    uint256 internal constant MIN_SAFE_OWNERS = 3;

    /// @dev Tahmini deploy maliyetinin 5 kati. TURETME: olculen 25 gwei'de
    ///      escrow ~189k + factory ~2,90M ~= 3,1M gaz = 0,0775 USDC; 5 kati
    ///      0,39; yukari yuvarlanmis hali 0,5 USDC. SECILMEDI, olculen bir
    ///      buyuklukten okundu.
    uint256 internal constant MIN_DEPLOYER_BALANCE = 0.5e18;

    error Create2DeployerMissing(address expected, uint256 codeLength);
    error Create2DeployerNotCanonical(address at, bytes32 expected, bytes32 actual);
    error InitcodeDoesNotEncodeThePlan(string field);
    error NotAMultisig(string role, address account);
    error MultisigThresholdTooLow(string role, address account, uint256 threshold);
    error MultisigTooFewOwners(string role, address account, uint256 owners);
    error AlreadyDeployed(string what, address at);
    error Create2Failed(bytes32 salt);
    error InsufficientDeployerBalance(address deployer, uint256 have, uint256 need);
    error ProfileNotAsDeployed(string field, uint256 expected, uint256 actual);
    error GovernanceNotAsDeployed(string field, address expected, address actual);

    function predict(bytes32 salt, bytes memory initcode) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(initcode)))))
        );
    }

    /// @dev ARGUMAN SIRASI: (escrow, treasury, governor, T, V, S).
    ///      **T, V'DEN ONCE GELIR.** Faz 1c'nin kayda gecirdigi "derlenen bir
    ///      hata": ikisi de uint256'dir, takas derleyiciden gecer. BUGUN
    ///      fail-closed'dir -- T = 4_292e15 ile `S >= T` olur ve constructor
    ///      `DegenerateProfile()` doner (olculdu) -- ama bu KAZA ESERI
    ///      dogrudur, tasarim geregi degil, cunku baska bir profil ciftinde
    ///      takas gecerli bir profil uretebilir. Kemer: `assertAsDeployed`
    ///      deploy edilmis factory'den GERI OKUR.
    function build(uint256 chainId, Profile memory p, address deployer, address governor, address treasury)
        internal
        pure
        returns (Plan memory plan)
    {
        plan.chainId = chainId;
        plan.profile = p;
        plan.deployer = deployer;
        plan.governor = governor;
        plan.treasury = treasury;

        plan.escrowSalt = ESCROW_SALT;
        plan.factorySalt = FACTORY_SALT;

        // FeeEscrow'un CONSTRUCTOR ARGUMANI YOKTUR (olculdu: kaynakta sifir
        // `constructor` gecisi), yani initcode'u salt creation code'dur ve
        // adresi ayni salt ile HER ZINCIRDE AYNIDIR. Adres defterinin bu
        // ozelligi tasiyan TEK uyesidir; factory tasimaz, cunku argumanlarinin
        // ucu zincire ozgudur.
        plan.escrowInitcode = type(FeeEscrow).creationCode;
        plan.escrow = predict(ESCROW_SALT, plan.escrowInitcode);

        plan.factoryInitcode = abi.encodePacked(
            type(LaunchFactory).creationCode,
            abi.encode(plan.escrow, treasury, governor, p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply)
        );
        plan.factory = predict(FACTORY_SALT, plan.factoryInitcode);
    }

    function assertDeployable(Plan memory plan) internal view {
        // IKI AYRI DURUM, IKI AYRI HATA. "Deployer hic yok" (yeni bir zincir)
        // ile "adreste baska bir sey var" operator icin ayni sey degildir.
        if (CREATE2_FACTORY.code.length == 0) {
            revert Create2DeployerMissing(CREATE2_FACTORY, 0);
        }
        if (CREATE2_FACTORY.codehash != CREATE2_FACTORY_CODEHASH) {
            revert Create2DeployerNotCanonical(CREATE2_FACTORY, CREATE2_FACTORY_CODEHASH, CREATE2_FACTORY.codehash);
        }
        if (plan.deployer.balance < MIN_DEPLOYER_BALANCE) {
            revert InsufficientDeployerBalance(plan.deployer, plan.deployer.balance, MIN_DEPLOYER_BALANCE);
        }
        _assertInitcodeEncodesThePlan(plan);
        _assertMultisig("governor", plan.governor);
        _assertMultisig("treasury", plan.treasury);
        if (plan.escrow.code.length != 0) revert AlreadyDeployed("FeeEscrow", plan.escrow);
        if (plan.factory.code.length != 0) revert AlreadyDeployed("LaunchFactory", plan.factory);
    }

    /// @dev BASILAN SAYILARIN GERCEKTEN DEPLOY EDILECEK SAYILAR OLDUGUNU
    ///      KANITLAR -- ve `assertDeployable` icinde durdugu icin bunu HEM
    ///      `plan()` HEM `run()` yapar, HERHANGI BIR SEY DEPLOY EDILMEDEN ONCE.
    ///
    /// @dev NICIN GEREKLI. `_print`, `V`yi `p.profile`den, initcode hash'ini
    ///      ise `keccak256(p.factoryInitcode)`ten okur; bu ikisinin AYNI SEYI
    ///      soyledigini `plan()` yolunda hicbir sey iddia etmiyordu. `build`
    ///      icinde `V`yi sabitleyen bir hata (mutant D14) kuru kosuda
    ///      `V 4292000000000000000` yazdirip yanina 4292000000000000000000'e
    ///      baglanan bir initcode hash'i koyardi -- ve basilan adres de hash de
    ///      KENDI ICINDE TUTARLI olurdu. Yani operatorun inceledigi ciktinin
    ///      KENDISI yalan soyleyebilirdi. Brief'in 6. adimi tam olarak bu
    ///      ciktiyi inceleme delili yaptigi icin bu bir teshis bosluğundan
    ///      fazlasidir.
    ///
    /// @dev BU, GERI OKUMANIN YERINI ALMAZ; ONDAN ONCE GELIR. `assertAsDeployed`
    ///      deploy EDILMIS kontrattan okur (dolayisiyla constructor'in gercekten
    ///      ne sakladigini gorur); bu ise deploy EDILECEK baytlari cozer. Ikisi
    ///      birlikte "plan -> initcode -> deploy edilmis kontrat" zincirinin her
    ///      iki halkasini da kapatir.
    function _assertInitcodeEncodesThePlan(Plan memory plan) private pure {
        // Escrow'un initcode'u SALT creation code'dur; argumani yoktur.
        if (keccak256(plan.escrowInitcode) != keccak256(type(FeeEscrow).creationCode)) {
            revert InitcodeDoesNotEncodeThePlan("escrowInitcode");
        }

        bytes memory initcode = plan.factoryInitcode;
        if (initcode.length <= FACTORY_ARG_BYTES) revert InitcodeDoesNotEncodeThePlan("factoryInitcodeLength");

        bytes memory tail = new bytes(FACTORY_ARG_BYTES);
        uint256 start = initcode.length - FACTORY_ARG_BYTES;
        for (uint256 i = 0; i < FACTORY_ARG_BYTES; ++i) {
            tail[i] = initcode[start + i];
        }
        (address escrow_, address treasury_, address governor_, uint256 t, uint256 v, uint256 s) =
            abi.decode(tail, (address, address, address, uint256, uint256, uint256));

        if (escrow_ != plan.escrow) revert InitcodeDoesNotEncodeThePlan("escrow");
        if (treasury_ != plan.treasury) revert InitcodeDoesNotEncodeThePlan("treasury");
        if (governor_ != plan.governor) revert InitcodeDoesNotEncodeThePlan("governor");
        if (t != plan.profile.virtualTokenReserves) revert InitcodeDoesNotEncodeThePlan("T");
        if (v != plan.profile.virtualQuoteReserves) revert InitcodeDoesNotEncodeThePlan("V");
        if (s != plan.profile.saleSupply) revert InitcodeDoesNotEncodeThePlan("S");
    }

    /// @dev EOA REDDEDILIR VE SEBEBI YAPISALDIR: bir EOA'nin `getThreshold()`
    ///      uyesi yoktur. Kontrat DEGISMEZ: `LaunchFactory` bilerek musamahali
    ///      kalir (ciplak bir `BondingCurve` icin ve testlerde EOA governor
    ///      mesrudur); politika deploy katmanindadir.
    ///
    /// @dev KOD UZUNLUGU KONTROLU `try`DEN ONCE GELIR VE GEREKLIDIR. Plan bu
    ///      satiri TASIMIYORDU ve gerekcesi soyleydi: "solc'un extcodesize
    ///      kontrolu cagriyi revert ettirir ve `catch` `NotAMultisig` uretir."
    ///      OLCULDU VE YANLIS. Kodsuz bir adrese yapilan `try` cagrisinda
    ///      extcodesize kontrolu CAGIRANIN ICINDE bos veriyle revert eder,
    ///      yani `catch` HIC CALISMAZ: donen veri `0x`tir, `NotAMultisig`
    ///      degil. (Ayni yoklama KODU OLAN ama Safe OLMAYAN bir adres icin
    ///      plandaki gibi calisir: donen veri `0x3ba18bfc...`, yani
    ///      `NotAMultisig`.) Bu satir olmadan deploy YINE fail-closed olurdu --
    ///      ama ISIMSIZ bos bir revert ile, ve operator icin "governor bir
    ///      multisig degil" ile "bir sey patladi" arasindaki fark tam olarak
    ///      bu satirdir. Mutant D16 bunu olcer.
    function _assertMultisig(string memory role, address account) private view {
        if (account.code.length == 0) revert NotAMultisig(role, account);

        try ISafeProbe(account).getThreshold() returns (uint256 threshold) {
            if (threshold < MIN_SAFE_THRESHOLD) revert MultisigThresholdTooLow(role, account, threshold);
        } catch {
            revert NotAMultisig(role, account);
        }
        try ISafeProbe(account).getOwners() returns (address[] memory owners) {
            if (owners.length < MIN_SAFE_OWNERS) revert MultisigTooFewOwners(role, account, owners.length);
        } catch {
            revert NotAMultisig(role, account);
        }
    }

    /// @dev `new C{salt:}` DEGIL, DEPLOYER'A ACIK CAGRI. Sebep olculebilir:
    ///      `forge test` icinde `new C{salt:}` CREATE2 opcode'unu CAGIRAN
    ///      KONTRATTA calistirir, `forge script --broadcast` ise deterministik
    ///      deployer uzerinden gonderir -- IKI FARKLI ADRES. Acik cagri ikisini
    ///      AYNI yapar; bedeli test fixture'inda tek bir `vm.etch`tir. Aksi
    ///      halde prova, canli kosunun hic uretmeyecegi bir adresi dogrulardi.
    function deploy(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, initcode));
        if (!ok || ret.length != 20) revert Create2Failed(salt);
        deployed = address(bytes20(ret));
    }

    /// @dev DERLEME ZAMANI KONTROLLERININ GOREMEDIGI TEK SINIF: cozulen profil
    ///      ile constructor'a GECIRILEN degerin ayrismasi. Yanlis BUYUKLUKTEKI
    ///      bir `V` yedi korumadan da gecer (olculdu), yani onu yakalayan TEK
    ///      SATIR budur.
    function assertAsDeployed(Plan memory plan) internal view {
        LaunchFactory f = LaunchFactory(plan.factory);
        if (f.VIRTUAL_TOKEN_RESERVES() != plan.profile.virtualTokenReserves) {
            revert ProfileNotAsDeployed("T", plan.profile.virtualTokenReserves, f.VIRTUAL_TOKEN_RESERVES());
        }
        if (f.VIRTUAL_QUOTE_RESERVES() != plan.profile.virtualQuoteReserves) {
            revert ProfileNotAsDeployed("V", plan.profile.virtualQuoteReserves, f.VIRTUAL_QUOTE_RESERVES());
        }
        if (f.SALE_SUPPLY() != plan.profile.saleSupply) {
            revert ProfileNotAsDeployed("S", plan.profile.saleSupply, f.SALE_SUPPLY());
        }
        if (f.escrow() != plan.escrow) revert GovernanceNotAsDeployed("escrow", plan.escrow, f.escrow());
        if (f.governor() != plan.governor) revert GovernanceNotAsDeployed("governor", plan.governor, f.governor());
        if (f.protocolTreasury() != plan.treasury) {
            revert GovernanceNotAsDeployed("treasury", plan.treasury, f.protocolTreasury());
        }
        if (f.graduationTarget() != address(0)) {
            revert GovernanceNotAsDeployed("graduationTarget", address(0), f.graduationTarget());
        }
        if (f.launchCount() != 0) revert ProfileNotAsDeployed("launchCount", 0, f.launchCount());
    }
}
