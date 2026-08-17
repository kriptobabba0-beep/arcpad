// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

contract LaunchTokenTest is Test {
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant CURVE = address(0xCC0E);
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    /// Task 3'te eklendi. Bu dosya provenance'i OLCMEZ -- olcen taraf
    /// `LaunchFactory.t.sol`'dur; burada yalnizca alanin tasindigi ve hicbir
    /// seyi degistirmedigi sabitlenir. Deger bilerek "keccak gibi durmayan"
    /// bir sabittir: `launchSalt`'in gecerliligi diye bir sey YOKTUR, kanoniklik
    /// salt'tan degil ADRES ESITLIGINDEN gelir.
    bytes32 internal constant SALT = bytes32(uint256(0xA11CE5A17));

    function _deploy() internal returns (LaunchToken) {
        return new LaunchToken("Arc Test Coin", "ATC", "ipfs://cid", CREATOR, CURVE, SALT);
    }

    /// Arz bir constructor argumani DEGIL sabittir: spec 5.3'e gore her
    /// launch ayni arza sahiptir ve `CurveMath.marketCap`'in `supplyConstant`
    /// parametresiyle olcek olarak ortusmesi gerekir -- ortusmezse hicbir sey
    /// revert etmez, sistem sadece yanlis calisir. Sabitin degeri bu yuzden
    /// testte de ayrica pinlenir.
    function test_totalSupplyConstantIsOneBillionWithEighteenDecimals() public {
        LaunchToken t = _deploy();
        assertEq(t.TOTAL_SUPPLY(), 1_000_000_000e18);
        assertEq(t.TOTAL_SUPPLY(), SUPPLY);
        assertEq(t.TOTAL_SUPPLY(), t.totalSupply());
    }

    function test_entireSupplyIsMintedToTheCurve() public {
        LaunchToken t = _deploy();
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(CURVE), SUPPLY);
        assertEq(t.balanceOf(CREATOR), 0);
        assertEq(t.balanceOf(address(this)), 0);

        // Arzin NEREDE oldugu kadar KIMIN HAREKET ETTIREBILECEGI de sabittir:
        // curve'un bakiyesi uzerinde onceden verilmis hicbir yetki olmamali.
        // Aksi halde constructor'a eklenecek tek bir `_approve` satiri butun
        // arzi ucuncu bir tarafa acar ve bakiye tabanli testlerin hicbiri
        // bunu goremez.
        assertEq(t.allowance(CURVE, CREATOR), 0);
        assertEq(t.allowance(CURVE, address(this)), 0);
        assertEq(t.allowance(CURVE, address(t)), 0);
    }

    function test_metadataIsReadableOnChain() public {
        LaunchToken t = _deploy();
        assertEq(t.name(), "Arc Test Coin");
        assertEq(t.symbol(), "ATC");
        assertEq(t.metadataURI(), "ipfs://cid");
        assertEq(t.creator(), CREATOR);
        assertEq(t.curve(), CURVE);
        assertEq(t.launchSalt(), SALT);
    }

    /// `launchSalt` sifir OLABILIR ve bu bilinclidir. Bir `ZeroSalt` korumasi
    /// hicbir sahteciyi durdurmaz -- sahteci keccak gibi duran bir sayi
    /// uydurabilir -- ama dogrulamanin gucunun salt'in "gecerliligi"nden
    /// geldigi yanilsamasini yaratirdi. Guc ADRES ESITLIGINDEDIR.
    function test_aZeroLaunchSaltIsAccepted() public {
        LaunchToken t = new LaunchToken("n", "s", "u", CREATOR, CURVE, bytes32(0));
        assertEq(t.launchSalt(), bytes32(0));
        assertEq(t.balanceOf(CURVE), SUPPLY);
    }

    /// Salt SONRADAN yazilamaz: `immutable`, ve makul hicbir setter yok.
    /// Yazilabilseydi bir token, kanonik bir adrese denk gelene kadar salt
    /// deneyebilirdi.
    function test_launchSaltCannotBeRewritten() public {
        LaunchToken t = _deploy();
        bytes[3] memory payloads = [
            abi.encodeWithSignature("setLaunchSalt(bytes32)", bytes32(uint256(1))),
            abi.encodeWithSignature("setSalt(bytes32)", bytes32(uint256(1))),
            abi.encodeWithSignature("launchSalt(bytes32)", bytes32(uint256(1)))
        ];
        for (uint256 i = 0; i < payloads.length; i++) {
            (bool ok,) = address(t).call(payloads[i]);
            ok; // onemli olan cagrinin basarisi degil, alanin degismemesi.
            assertEq(t.launchSalt(), SALT, "launchSalt was rewritten");
        }
    }

    function test_decimalsAreEighteen() public {
        assertEq(_deploy().decimals(), 18);
    }

    /// Sonradan mint yolu olmamali: toplam arz sonsuza kadar sabit.
    ///
    /// Bu test bir YUZEY taramasidir, tek bir probe degil. Onceki hali tek bir
    /// selector'u tek bir cagirandan deneyip `assertFalse(ok)` diyordu; o
    /// bicim iki sekilde birden kordur: `ok == false` "boyle bir fonksiyon
    /// yok" ile "fonksiyon revert etti"yi ayirt edemez, ve tek selector bir
    /// yuzey degildir. Olculdu: `mint(address,uint256)` (curve'e kapali),
    /// `mintTo(address,uint256)` ve `mint(uint256)` eklemelerinin ucu de
    /// eski testi yesil birakti.
    ///
    /// Bu yuzden: makul selector kumesi x makul cagiran kumesi denenir ve her
    /// denemeden SONRA `totalSupply()`'in degismedigi iddia edilir. Kriter
    /// cagrinin basarisiz olmasi degil, arzin artmamis olmasidir.
    function test_noMintPathExistsForAnyPlausibleSelectorOrCaller() public {
        LaunchToken t = _deploy();

        address[3] memory callers = [address(this), CURVE, CREATOR];

        for (uint256 i = 0; i < callers.length; i++) {
            address who = callers[i];

            bytes[5] memory payloads = [
                abi.encodeWithSignature("mint(address,uint256)", who, 1e27),
                abi.encodeWithSignature("mint(uint256)", 1e27),
                abi.encodeWithSignature("mintTo(address,uint256)", who, 1e27),
                abi.encodeWithSignature("mint(uint256,address)", 1e27, who),
                abi.encodeWithSignature("mint(address,uint256)", who, 1)
            ];

            for (uint256 j = 0; j < payloads.length; j++) {
                vm.prank(who);
                (bool ok,) = address(t).call(payloads[j]);
                ok; // sonuc onemli degil: onemli olan arzin degismemesi.
                assertEq(t.totalSupply(), SUPPLY, "a mint path increased totalSupply");
                assertEq(t.balanceOf(CURVE), SUPPLY, "a mint path moved supply off the curve");
                assertEq(t.balanceOf(who), who == CURVE ? SUPPLY : 0, "a mint path credited a caller");
            }
        }
    }

    // --- metadata sinirlari (pump.fun ile ayni) ---

    function test_nameAtLimitIsAccepted() public {
        string memory n = "12345678901234567890123456789012"; // 32
        LaunchToken t = new LaunchToken(n, "ATC", "u", CREATOR, CURVE, SALT);
        assertEq(t.name(), n);
    }

    function test_revertsWhenNameExceedsLimit() public {
        vm.expectRevert(LaunchToken.NameTooLong.selector);
        new LaunchToken("123456789012345678901234567890123", "ATC", "u", CREATOR, CURVE, SALT); // 33
    }

    function test_symbolAtLimitIsAccepted() public {
        string memory s = "1234567890123"; // 13
        LaunchToken t = new LaunchToken("n", s, "u", CREATOR, CURVE, SALT);
        assertEq(t.symbol(), s);
    }

    function test_revertsWhenSymbolExceedsLimit() public {
        vm.expectRevert(LaunchToken.SymbolTooLong.selector);
        new LaunchToken("n", "12345678901234", "u", CREATOR, CURVE, SALT); // 14
    }

    /// URI sinirini ALTTAN da pinler. Dosyadaki en uzun URI 10 bayt oldugu
    /// icin [11, 200] araligindaki HER sinir ayirt edilemezdi: `>` yerine
    /// `>=`, MAX_URI_LENGTH = 100 ve MAX_URI_LENGTH = 11 mutasyonlarinin ucu
    /// de suiti yesil birakti. Tam 200 baytlik bir URI ucunu birden oldurur.
    function test_uriAtLimitIsAccepted() public {
        string memory uri = new string(200);
        LaunchToken t = new LaunchToken("n", "s", uri, CREATOR, CURVE, SALT);
        assertEq(bytes(t.metadataURI()).length, 200);
    }

    function test_revertsWhenUriExceedsLimit() public {
        string memory long = new string(201);
        vm.expectRevert(LaunchToken.UriTooLong.selector);
        new LaunchToken("n", "s", long, CREATOR, CURVE, SALT);
    }

    /// Bos metadata KABUL EDILIR ve bu bilincli bir karardir: ne pump.fun ne
    /// de spec bos olmama sarti koyar, dolayisiyla uyumlu varsayilan kabul
    /// etmektir. Test bunu pinler; boyle bir sart sonradan sessizce eklenirse
    /// (ornegin `if (bytes(name_).length == 0) revert NameTooLong();`) burada
    /// gorunur.
    function test_emptyMetadataIsAccepted() public {
        LaunchToken t = new LaunchToken("", "", "", CREATOR, CURVE, SALT);
        assertEq(bytes(t.name()).length, 0);
        assertEq(bytes(t.symbol()).length, 0);
        assertEq(bytes(t.metadataURI()).length, 0);
        assertEq(t.balanceOf(CURVE), SUPPLY);
    }

    // --- sifir kontrolleri ---

    function test_revertsOnZeroCreator() public {
        vm.expectRevert(LaunchToken.ZeroCreator.selector);
        new LaunchToken("n", "s", "u", address(0), CURVE, SALT);
    }

    function test_revertsOnZeroCurve() public {
        vm.expectRevert(LaunchToken.ZeroCurve.selector);
        new LaunchToken("n", "s", "u", CREATOR, address(0), SALT);
    }

    // --- transfer davranisi standart olmali ---

    function test_transfersBehaveLikeStandardErc20() public {
        LaunchToken t = _deploy();
        vm.prank(CURVE);
        t.transfer(address(this), 100e18);
        assertEq(t.balanceOf(address(this)), 100e18);
        assertEq(t.balanceOf(CURVE), SUPPLY - 100e18);
    }

    function testFuzz_totalSupplyIsInvariantUnderTransfers(uint256 amount) public {
        LaunchToken t = _deploy();
        amount = bound(amount, 0, SUPPLY);
        vm.prank(CURVE);
        t.transfer(address(this), amount);
        assertEq(t.totalSupply(), SUPPLY);
        assertEq(t.balanceOf(CURVE) + t.balanceOf(address(this)), SUPPLY);
    }
}
