// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title UsdcMock -- Arc'in TEK BAKIYE, IKI GORUNUM ozelligi
 *
 * @notice `balanceOf` SAKLANMAZ, native bakiyeden TURETILIR; her transfer
 *         native bakiyeyi hareket ettirir.
 *
 * @dev BU SADAKAT ZORUNLUDUR, SUSLEME DEGIL. Arc'ta USDC hem gaz varligidir
 *      hem `0x3600...`daki ERC-20'dir ve IKISI AYNI BAKIYEDIR (canli olcum,
 *      blok 54019678: bir ERC-20 transferi alicinin native bakiyesini
 *      kredilendirir ve `receive()`i CALISTIRMAZ).
 *
 *      AYRI BIR ERC-20 DEFTERI TUTAN BIR MOCK SESSIZCE YANLIS OLCER:
 *        - `BondingCurve.graduate()` quote'u `call{value:}` ile oder, yani
 *          locker'in ERC-20 gorunumu SIFIR kalir ve tohumlama underflow eder;
 *        - `ArcpadHook` ucreti `take` ile ERC-20 olarak alir ama
 *          `FeeEscrow.deposit{value:}` ile native olarak harcar -- iki defterli
 *          bir mock'ta o para YOKTAN var olurdu;
 *        - `BuybackTreasury` native `pendingQuote` tutar ama havuza ERC-20
 *          olarak oder.
 *      Ucu de bu tek dosyadaki `_move`a dayanir.
 *
 * @dev TEK KOPYA, VE NEDEN. Bu kontrat bir zamanlar `ArcpadHook.t.sol` ile
 *      `ArcpadLocker.t.sol` icinde IKI KEZ yaziliydi ve ikincisinin yorumu
 *      "birincisinin aynisi" diyordu -- yani ayrisabilecegi zaten biliniyordu.
 *      Ucuncu bir kopya (`BuybackPoolVenue.t.sol`) eklenecekken buraya
 *      cikarildi: ayrisan bir mock, testleri kirmizi yapmaz -- YANLIS YESIL
 *      yapar, cunku her paket kendi dunyasinda tutarli kalir.
 */
contract UsdcMock {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => mapping(address => uint256)) public allowance;

    function balanceOf(address a) public view returns (uint256) {
        return a.balance / 1e12;
    }

    function totalSupply() external pure returns (uint256) {
        return type(uint256).max;
    }

    function mint(address to, uint256 units) external {
        _credit(to, units);
        emit Transfer(address(0), to, units);
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        return _move(msg.sender, to, a);
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        return _move(f, to, a);
    }

    function _move(address f, address t, uint256 units) private returns (bool) {
        uint256 wei_ = units * 1e12;
        require(f.balance >= wei_, "usdc: insufficient");
        VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).deal(f, f.balance - wei_);
        VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).deal(t, t.balance + wei_);
        emit Transfer(f, t, units);
        return true;
    }

    function _credit(address to, uint256 units) private {
        VmLike(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).deal(to, to.balance + units * 1e12);
    }
}

interface VmLike {
    function deal(address, uint256) external;
}
