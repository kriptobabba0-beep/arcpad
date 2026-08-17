// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// `LaunchToken.TOTAL_SUPPLY`'in DOSYA DUZEYINDEKI kaynagi.
//
// Solidity bir kontratin `constant` uyesine `LaunchToken.TOTAL_SUPPLY` diye
// disaridan erisime izin VERMEZ (Error 9582). `LaunchFactory`'nin acilis
// piyasa degeri kontrolu `N`'e DERLEME ZAMANINDA ihtiyac duyuyor; sayiyi
// orada tekrar yazmak sessizce ayrisabilen ikinci bir kaynak yaratirdi -- ve
// asagidaki NatSpec tam olarak o olcek ayrismasinin nicin hicbir yerde revert
// etmedigini anlatiyor. Tek kaynak burasidir; kontratin `public constant`'i
// onu aynen yansitir, yani ABI getter'i degismez.
//
// (Dosya duzeyindeki degiskenler NatSpec etiketi KABUL ETMEZ -- `@notice`
// burada Error 6546 verir; bu yuzden duz yorum.)
uint256 constant LAUNCH_TOKEN_TOTAL_SUPPLY = 1_000_000_000e18;

/// @title LaunchToken
/// @notice arcpad uzerinde baslatilan sabit arzli token.
/// @dev Tum arz constructor'da TEK SEFERDE bonding curve adresine basilir.
///      Curve, satilabilir kismi kendi sayaciyla sinirlar; rezerve kalan ayni
///      bakiyede durur ve graduation'da havuza aktarilir. pump.fun'in yaptigi
///      da budur: token_total_supply'in tamami curve hesabina gider,
///      real_token_reserves yalnizca satilabilir kismi sinirlar.
/// @dev Sonradan mint yolu YOKTUR. Metadata token uzerinde durur, boylece
///      arayuz ve indexer zincirden okuyabilir ve bir backend'e bagimli olmaz.
contract LaunchToken is ERC20 {
    /// pump.fun ile ayni sinirlar.
    uint256 private constant MAX_NAME_LENGTH = 32;
    uint256 private constant MAX_SYMBOL_LENGTH = 13;
    uint256 private constant MAX_URI_LENGTH = 200;

    /// @notice Her launch'in arzi AYNIDIR ve burada sabitlenir (spec 5.3).
    /// @dev Parametre DEGIL sabit olmasinin sebebi calisma zamaninda
    ///      yakalanamayan bir eslesmedir: `CurveMath.marketCap` piyasa degerini
    ///      mint'in gercek arzindan degil, kendisine verilen `supplyConstant`
    ///      parametresinden hesaplar (spec bunu bilerek boyle ister). Iki deger
    ///      ayni olcekte olmazsa hicbir sey revert etmez; sistem yanlis ama
    ///      kendi icinde tutarli calisir. Ornek: curve 6 basamakli Solana
    ///      sabitiyle (1e15) kalibre edilir, factory dogru sekilde 1e27 basar,
    ///      market cap 1e12 kat kucuk cikar, her launch sonsuza kadar fee
    ///      tier 0'a sabitlenir ve graduation esigi anlamsizlasir. Serbest bir
    ///      constructor argumani bu hatayi mumkun kilar; sabit kilmaz.
    uint256 public constant TOTAL_SUPPLY = LAUNCH_TOKEN_TOTAL_SUPPLY;

    error NameTooLong();
    error SymbolTooLong();
    error UriTooLong();
    error ZeroCreator();
    error ZeroCurve();

    /// @notice Kayittaki creator. Ucreti fiilen alacak cuzdan BU DEGILDIR:
    ///         degistirilebilir fee-recipient cuzdani curve/registry uzerinde
    ///         durur ve creator onu launch'tan sonra degistirebilir; ayrica
    ///         3 gunluk protokol onerili bir devir yolu vardir (spec 5.7),
    ///         Faz 5'te de ucret paylasimi gelir (spec 5.8). Buradaki
    ///         `immutable` yalnizca "kim baslatti" kaydidir; ucret akisini
    ///         buraya baglamak akisi kalici olarak devredilemez yapardi.
    address public immutable creator;

    /// @notice Arzin tamaminin basildigi bonding curve.
    address public immutable curve;

    /// @notice Logo ve aciklamayi tasiyan metadata isaretcisi (IPFS).
    string public metadataURI;

    /// @notice Bu token'i ureten launch'in CREATE2 salt'i.
    /// @dev DOGRULAMANIN TASIYICI ALANI. `LaunchFactory.isCanonical`, token'in
    ///      KENDI adresini yalnizca token'in acikladigi verilerden yeniden
    ///      turetir:
    ///
    ///        beklenen = CREATE2(factory, launchSalt,
    ///                           keccak(creationCode ++ abi.encode(
    ///                             name, symbol, metadataURI, creator, curve,
    ///                             launchSalt)))
    ///
    ///      Factory'den tureyen bir adrese YALNIZCA factory deploy
    ///      edebildiginden, esitlik provenance'in kendisidir. Salt burada
    ///      durmak zorundadir: aksi halde dogrulayicinin elinde turetmeyi
    ///      tamamlayacak veri olmaz ve eslesme yeniden "saklanan bir
    ///      isaretci"ye duser -- ki bu, herkesin gercek bir launch'in
    ///      creator'ini, curve'unu ve URI'sini iddia eden bir token basmasina
    ///      izin veren tam olarak o durumdur.
    ///
    ///      SIFIR OLABILIR ve bu bilinclidir: bu kontrat factory'siz de
    ///      deploy edilebilir (testler ve sahtecilik senaryolari boyle kurar),
    ///      ve sifir bir salt kanonikligi zaten saglamaz. Buraya bir
    ///      `ZeroSalt` korumasi koymak sahteciyi hic durdurmaz -- o da
    ///      keccak-benzeri bir sayi uydurabilir -- ama dogrulamanin gucunun
    ///      salt'in "gecerliligi"nden geldigi yanilsamasini yaratirdi.
    bytes32 public immutable launchSalt;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address creator_,
        address curve_,
        bytes32 launchSalt_
    ) ERC20(name_, symbol_) {
        if (bytes(name_).length > MAX_NAME_LENGTH) revert NameTooLong();
        if (bytes(symbol_).length > MAX_SYMBOL_LENGTH) revert SymbolTooLong();
        if (bytes(metadataURI_).length > MAX_URI_LENGTH) revert UriTooLong();
        if (creator_ == address(0)) revert ZeroCreator();
        if (curve_ == address(0)) revert ZeroCurve();

        creator = creator_;
        curve = curve_;
        metadataURI = metadataURI_;
        launchSalt = launchSalt_;

        _mint(curve_, TOTAL_SUPPLY);
    }
}
