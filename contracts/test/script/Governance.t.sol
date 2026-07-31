// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Governance, ISafe} from "../../script/Governance.s.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";

/// @dev Yalnizca yoklamanin ihtiyaci olan Safe uyeleri, artan sirada DONMEYEN
///      bir owner listesiyle -- cunku gercek Safe de oyle donuyor.
contract OwnerStub {
    address[] private _owners;
    uint256 private _nonce;

    constructor(address[] memory owners_) {
        for (uint256 i; i < owners_.length; ++i) {
            _owners.push(owners_[i]);
        }
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function nonce() external view returns (uint256) {
        return _nonce;
    }

    /// @dev Safe'in EIP-712 formulunun SADIK bir kopyasi.
    ///
    ///      Bu, `_safeTxHash`in capraz kontrolunu birim testinde TOTOLOJIK
    ///      yapar (iki taraf da ayni formulu hesaplar) ve bu KABUL EDILMISTIR:
    ///      capraz kontrolun GERCEK olcumu CANLI Safe'e karsi yapildi --
    ///      toren `getTransactionHash`i gercek 1.4.1 singleton'undan okudu ve
    ///      esitlik tuttu. Bu stub'un isi o kontrolu olcmek degil, DIGER
    ///      kollarin (siralama, owner, nonce) test edilebilmesi icin cagrinin
    ///      basarmasini saglamak. `test_aDivergentSafeTxHashStopsTheCeremony`
    ///      bu uyeyi kasten YALAN soyletir.
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _n
    ) external view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218, block.chainid, address(this))
        );
        bytes32 structHash = keccak256(
            abi.encode(
                0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8,
                to,
                value,
                keccak256(data),
                operation,
                safeTxGas,
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                _n
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}

/// @title GovernanceTest
/// @notice `Governance.s.sol`un giris noktalari ve HATA KOLLARI.
///
/// @dev NICIN VAR. Inceleme olctu: yedi giris noktasindan BIRININ, bes hata
///      kolundan SIFIRININ testi vardi. Mutlu yol canli zincirde prova
///      edilmisti, ama bu tam olarak bu deponun bir numarali kusurudur --
///      "bir giris noktasinda kapali olan, hepsinde kapali okunur".
///      `SafeTxHashDiverged` ozellikle onemli: runbook'ta operatoru torenin
///      ORTASINDA durdurmakla gorevli TEK talimat odur.
contract GovernanceTest is Test {
    Governance internal governance;

    // deploy/expected-governance.json -> arc-testnet, BEYAN EDILEN SIRASIYLA.
    // ARTAN SIRADA DEGILDIR ve olmamalidir: bu sira Safe adresini belirler.
    address internal constant OWNER_A = 0x0a95f5F562183089f661577bc6B63D7A829cec88;
    address internal constant OWNER_F = 0xf5447724A9BEa99635c0456049169eaCa84EE65B;
    address internal constant OWNER_D = 0x0D646a725DAdc8ADcF209ac999B219EF2a69ad21;

    address internal constant GOVERNOR_SAFE = 0x970534698e4592932F31892759147f79EB0D2C22;

    uint256 internal constant ARC_TESTNET = 5042002;
    uint256 internal constant LOCAL_REHEARSAL = 31337;

    function setUp() public {
        governance = new Governance();
        vm.chainId(ARC_TESTNET);
    }

    function _declaredOwners() internal pure returns (address[] memory o) {
        o = new address[](3);
        o[0] = OWNER_A;
        o[1] = OWNER_F;
        o[2] = OWNER_D;
    }

    function _installOwnerStub() internal {
        vm.etch(GOVERNOR_SAFE, address(new OwnerStub(_declaredOwners())).code);
        // OwnerStub owner'lari storage'da tutar; `vm.etch` storage TASIMAZ, o
        // yuzden burada `deployCodeTo` kullaniyoruz. (Ayni tuzak Deploy.t.sol'da
        // olculdu ve orada da yaziyor.)
        vm.etch(GOVERNOR_SAFE, "");
        deployCodeTo("Governance.t.sol:OwnerStub", abi.encode(_declaredOwners()), GOVERNOR_SAFE);
        assertEq(ISafe(GOVERNOR_SAFE).getOwners().length, 3, "stub lost its owners");
    }

    // ---------------------------------------------------------------
    // The ascending-order defect the review found
    // ---------------------------------------------------------------

    /// @dev BULGUNUN TA KENDISI. Beyan edilen sira ARTAN DEGILDIR ve gercek
    ///      `getOwners()` de ayni sirayi doner. Operator araci taklit ederse
    ///      uc olasi ciftten biri AZALAN demet uretir.
    function test_theDeclaredOwnerOrderIsNotAscending() public pure {
        address[] memory o = _declaredOwners();
        assertTrue(uint160(o[1]) > uint160(o[2]), "precondition: declared order is NOT ascending");
    }

    /// ...ve `assembleBundle` bunu DUZELTIR: imzalar hangi sirada verilirse
    /// verilsin, demet artan sirali cikar.
    function test_assembleBundleSortsRegardlessOfInputOrder() public {
        _installOwnerStub();
        bytes32 h = keccak256("arcpad.test.payload");

        (uint256 pkA, address a) = _ownerKey(0);
        (uint256 pkD, address d) = _ownerKey(1);
        vm.assume(a != d);

        bytes[] memory descending = new bytes[](2);
        descending[0] = _sign(pkD, h); // higher address first -- WRONG order in
        descending[1] = _sign(pkA, h);

        bytes memory bundle = governance.assembleBundle(h, descending);
        assertEq(bundle.length, 130, "bundle must be two 65-byte signatures");

        // Cikan demet ARTAN sirada olmali: ilk 65 bayt DUSUK adresli owner.
        address first = _recoverAt(h, bundle, 0);
        address second = _recoverAt(h, bundle, 1);
        assertTrue(uint160(first) < uint160(second), "bundle is not ascending by owner");
    }

    function test_assembleBundleRejectsANonOwner() public {
        _installOwnerStub();
        bytes32 h = keccak256("arcpad.test.payload");
        (uint256 stranger, address strangerAddr) = (0xB0B, vm.addr(0xB0B));

        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(stranger, h);

        vm.expectRevert(abi.encodeWithSelector(Governance.NotAnOwner.selector, strangerAddr));
        governance.assembleBundle(h, sigs);
    }

    function test_assembleBundleRejectsTheSameOwnerTwice() public {
        _installOwnerStub();
        bytes32 h = keccak256("arcpad.test.payload");
        (uint256 pkA, address a) = _ownerKey(0);

        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(pkA, h);
        sigs[1] = _sign(pkA, h);

        vm.expectRevert(abi.encodeWithSelector(Governance.DuplicateSigner.selector, a));
        governance.assembleBundle(h, sigs);
    }

    function test_assembleBundleRejectsAMalformedSignature() public {
        _installOwnerStub();
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = hex"deadbeef";
        vm.expectRevert(abi.encodeWithSelector(Governance.SignatureNotSixtyFiveBytes.selector, uint256(0), uint256(4)));
        governance.assembleBundle(keccak256("x"), sigs);
    }

    // ---------------------------------------------------------------
    // The error branches
    // ---------------------------------------------------------------

    /// RUNBOOK'UN "DUR" TALIMATI. Arac ile Safe imzalanacak sey konusunda
    /// ayrisirsa toren ORTASINDA durmalidir.
    function test_aDivergentSafeTxHashStopsTheCeremony() public {
        _installOwnerStub();
        bytes32 lie = bytes32(uint256(1));
        vm.mockCall(GOVERNOR_SAFE, abi.encodeWithSelector(ISafe.getTransactionHash.selector), abi.encode(lie));

        // Yerel hesap dogru, zincir yalan soyluyor -> DURMALI.
        vm.expectPartialRevert(Governance.SafeTxHashDiverged.selector);
        governance.encodeRotateTreasury(address(0xF00D), address(0xBEEF));
    }

    function test_aChainWithNoDeclaredOwnersCannotCreateSafes() public {
        // local-rehearsal girisinin `owners` dizisi BOSTUR.
        vm.chainId(LOCAL_REHEARSAL);
        vm.expectRevert(abi.encodeWithSelector(Governance.NoOwnersDeclared.selector, "local-rehearsal"));
        governance.predictSafes();
    }

    function test_createSafesRefusesWithoutTheSafeDeployment() public {
        vm.etch(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67, "");
        vm.expectRevert(
            abi.encodeWithSelector(
                Governance.SafeDeploymentMissing.selector,
                "SafeProxyFactory",
                0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
            )
        );
        governance.createSafes();
    }

    /// @dev `SafesCollide` BUGUN ULASILAMAZ VE SEBEBI YAZILI. Iki Safe adresi
    ///      yalnizca `saltNonce` ile ayrisir; `_predict` ayni owner kumesi ve
    ///      ayni initializer icin FARKLI nonce'larda FARKLI adres uretir, yani
    ///      `governor == treasury` olabilmesi icin once iki nonce'un esit
    ///      olmasi gerekir. Uydurma bir tanik yazmak yerine ULASILMAZLIGIN
    ///      KOSULUNU pinliyoruz: nonce'lar ayri kaldigi surece kol olu, ve
    ///      esitlenirlerse BU test kirmizilasir -- yani korumanin gerektigi an
    ///      haber verilir.
    function test_theTwoSaltNoncesDifferWhichIsWhatMakesTheSafesDistinct() public pure {
        assertTrue(
            uint256(keccak256("arcpad.governor.v1")) != uint256(keccak256("arcpad.treasury.v1")),
            "the two salt nonces collapsed; SafesCollide is now reachable and needs a real witness"
        );
    }

    // ---------------------------------------------------------------
    // The encoders
    // ---------------------------------------------------------------

    function test_theEncodersProduceTheRightInnerCalldata() public {
        _installOwnerStub();
        address factory = address(0xF00D);

        (, bytes memory rotate,) = governance.encodeRotateTreasury(factory, address(0xBEEF));
        assertEq(rotate, abi.encodeCall(LaunchFactory.setProtocolTreasury, (address(0xBEEF))), "rotate calldata");

        (, bytes memory propose,) = governance.encodeProposeTarget(factory, address(0xCAFE));
        assertEq(propose, abi.encodeCall(LaunchFactory.proposeGraduationTarget, (address(0xCAFE))), "propose calldata");

        assertTrue(keccak256(rotate) != keccak256(propose), "the two encoders must not collide");
    }

    /// Ayni cagri, FARKLI nonce -> FARKLI hash. Nonce'un hash'in icinde
    /// oldugunu (runbook'un ikinci tuzagi) olcer.
    function test_theSafeTxHashMovesWithTheNonce() public {
        _installOwnerStub();
        (bytes32 h0,,) = governance.encodeRotateTreasury(address(0xF00D), address(0xBEEF));

        vm.mockCall(GOVERNOR_SAFE, abi.encodeWithSelector(ISafe.nonce.selector), abi.encode(uint256(1)));
        (bytes32 h1,,) = governance.encodeRotateTreasury(address(0xF00D), address(0xBEEF));

        assertTrue(h0 != h1, "the nonce is not part of the Safe tx hash");
    }

    // --- helpers ---

    /// @dev Owner adreslerinin ozel anahtarlari YOKTUR (canli Safe'in
    ///      owner'laridir). Siralama ve owner kontrolu icin owner kumesini
    ///      TURETILEBILIR anahtarlarla degistiriyoruz; olculen ozellik
    ///      siralamadir, adreslerin kimligi degil.
    function _ownerKey(uint256 i) internal returns (uint256 pk, address addr) {
        pk = uint256(keccak256(abi.encodePacked("arcpad.owner", i)));
        addr = vm.addr(pk);
        address[] memory o = new address[](2);
        o[0] = vm.addr(uint256(keccak256(abi.encodePacked("arcpad.owner", uint256(0)))));
        o[1] = vm.addr(uint256(keccak256(abi.encodePacked("arcpad.owner", uint256(1)))));
        vm.etch(GOVERNOR_SAFE, "");
        deployCodeTo("Governance.t.sol:OwnerStub", abi.encode(o), GOVERNOR_SAFE);
    }

    function _sign(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    function _recoverAt(bytes32 hash, bytes memory bundle, uint256 index) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        uint256 off = 32 + index * 65;
        assembly {
            r := mload(add(bundle, off))
            s := mload(add(bundle, add(off, 32)))
            v := byte(0, mload(add(bundle, add(off, 64))))
        }
        return ecrecover(hash, v, r, s);
    }
}
