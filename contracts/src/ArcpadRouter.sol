// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "uniswap-hooks/utils/CurrencySettler.sol";

import {GraduationMath} from "./libraries/GraduationMath.sol";

/// @title ArcpadRouter
/// @notice MEZUNIYET SONRASI TICARETIN TEK GIRIS NOKTASI. V4'te bir EOA
///         `PoolManager.swap`i CAGIRAMAZ -- `swap` `onlyWhenUnlocked`tir ve
///         kilidi yalnizca `unlock` acar, `unlock` da geri cagriyi
///         `IUnlockCallback(msg.sender)`e yapar. Yani takas etmek icin
///         callback'i TUTAN bir kontrat gerekir. Arc'ta kanonik bir Uniswap
///         deployment'i olmadigi icin Universal Router da yoktur; bu kontrat o
///         boslugu doldurur ve BASKA HICBIR SEY YAPMAZ.
///
/// @dev BU KONTRAT YIGININ TEK DEGISTIRILEBILIR PARCASIDIR VE BU KASITLIDIR.
///      `ArcpadHook`un adresi her `PoolKey`in bir ALANIDIR, `ArcpadLocker`in
///      adresi factory'nin `graduationTarget`idir; ikisi de ilk graduation'dan
///      sonra pratikte dondurulur. Router'in adresini ise HICBIR SEY GOMMEZ --
///      ne havuz, ne hook, ne factory, ne token. Burada bulunan bir kusurun
///      caresi YENI BIR ROUTER YAYINLAMAKTIR. Bu yuzden yuzey KUCUK tutulur:
///      bir yol eklemek kolaydir, kalici bir yolu geri almak degildir.
///
/// @dev KULLANICI PARASI BU KONTRATTA DINLENMEZ. Girdi bacaginda odeme
///      `payer -> PoolManager` DOGRUDAN gider (`sync` -> `transferFrom` ->
///      `settle`); cikti bacaginda `PoolManager -> recipient` DOGRUDAN gider
///      (`take`). Hicbir yolda `address(this)` bir bakiye tutmaz, dolayisiyla
///      "yarim kalmis bir islemde para router'da kaldi" durumu TEMSIL
///      EDILEMEZ. Kismi doluluk da ayrica REDDEDILIR (asagida).
///
/// @dev 10^12 SINIRI BU DOSYADA YOKTUR VE OLMAMALIDIR. Arc'ta USDC hem
///      18-decimal native gorunum hem `0x3600...`daki 6-decimal ERC-20
///      gorunumdur -- AYNI BAKIYENIN iki yuzu, ve iliski
///      `units == floor(wei / 1e12)`dir, `units * 1e12 == wei` DEGIL. Havuzun
///      quote bacagi ERC-20 GORUNUMDUR: `PoolManager`in bu havuz icin tuttugu
///      her delta 6-decimal birimdedir. Router yalnizca o deltalari settle
///      eder, yani DONUSUM YAPACAK BIR YERI YOKTUR. Sistemdeki iki donusum
///      noktasi oldugu yerde kalir:
///        `GraduationMath.quoteUnits` -- locker, graduation basina BIR KEZ
///        `GraduationMath.quoteWei`   -- hook, ucret yatirimi basina BIR KEZ
///      `payable` bir `swapWithNative` girisi eklemek IKINCI bir sinir ve
///      SWAP BASINA toz uretirdi; bunun UCRETSIZ oldugu icin degil GEREKSIZ
///      oldugu icin yapilmadigi olculdu: `IERC20(0x3600...).transferFrom`
///      kullanicinin TEK bakiyesini hareket ettirir, yani sarmalama adimi
///      YOKTUR. Kullanici router'a `0x3600...` uzerinden `approve` verir ve
///      native bakiyesi harcanir.
///
/// @dev ROUTER BIR `transferFrom` HARCAYANIDIR, VE ARC'TA BUNUN OLCULMUS BIR
///      BEDELI VAR. Canli USDC'nin `transfer`i yalnizca `0x1800...0000`
///      precompile'ina iner; `transferFrom` ise ONDAN ONCE
///      `0x1800...0001`e `isBlocklisted(HARCAYAN)` diye sorar -- yani
///      ROUTER'IN KENDI ADRESINI. Olculdu (2026-08-09, canli `eth_call`):
///      o precompile'in zincirdeki kodu tek bayttir (`0x01`) ve
///      `isBlocklisted(0x70997970...)` = `true`,
///      `isBlocklisted(0xe92c64C4...)` = `false`. Graduation yolu
///      `transferFrom` HIC kullanmadigi icin bu precompile Faz 2 boyunca
///      gorunmedi.
///      SONUCU ACIKCA: bu router'in adresi bloklanirsa onun uzerinden
///      HICBIR takas yapilamaz, ama graduation etkilenmez. Caresi yukaridaki
///      "tek degistirilebilir parca" ozelligidir -- yeni bir router.
///      Alternatif YOKTUR: EOA'nin `PoolManager`a onceden odemesi mumkun
///      degildir (`sync`/`settle` muhasebesi ayni islem icinde olmak
///      zorundadir) ve Arc'ta Permit2 deploy edilmemistir.
///
/// @dev BU KONTRAT `payable` DEGILDIR, `receive()`I YOKTUR VE KENDI BAKIYESINI
///      HIC OKUMAZ -- `ArcpadLocker`in kuralinin aynisi ve ayni sebeple.
///      Arc'ta ucuncu bir taraf bu kontratin hem native hem ERC-20 bakiyesini,
///      burada HICBIR KOD CALISTIRMADAN sisirebilir. Miktarlarin TEK kaynagi
///      `PoolManager.swap`in dondurdugu `BalanceDelta`dir; `balanceOf` ve
///      `address(this).balance` bu dosyada HIC GECMEZ. Bir bagis bu yuzden
///      ETKISIZDIR ve kalicidir.
contract ArcpadRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    /// @dev V4'un kabul ettigi EN UC fiyat sinirlari. `Pool.swap` `zeroForOne`
    ///      dalinda `limit <= MIN_SQRT_PRICE`i, obur dalinda
    ///      `limit >= MAX_SQRT_PRICE`i reddeder, yani +1/-1 ZORUNLUDUR.
    ///      Kullaniciya bir fiyat siniri PARAMETRESI VERILMEZ: onun tasidigi
    ///      garantiyi `minOut`/`maxIn` ZATEN tasir ve iki mekanizma tek bir
    ///      islemde birbirini gizler.
    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    IPoolManager public immutable poolManager;
    IHooks public immutable hook;

    /// @notice Router uzerinden gecen her takas.
    ///
    /// @dev ISIM NE `Swap` NE `Trade`, VE BU BIR INDEXER TUZAGINDAN
    ///      KACINMADIR: `PoolManager` zaten `Swap(...)` yayiyor ve
    ///      `BondingCurve` zaten `Trade(...)` yayiyor. Ayni isimde iki olay
    ///      farkli topic0'lar uretir, dolayisiyla birine gore yazilmis bir
    ///      filtre oburu icin SESSIZCE BOS doner -- `PoolSeeded`in
    ///      `Graduated` OLMAMASININ sebebiyle ayni sebep.
    ///
    /// @dev NICIN GEREKLI. `PoolManager.Swap`in `sender`i ROUTER'dir, gercek
    ///      kullanici degil; havuz seviyesinde kullanici KIMLIGI KAYBOLUR.
    ///      `buy` INDEKSLI DEGILDIR -- `BondingCurve.Trade`in yon bayraginin
    ///      aynisi, ve tutarli olmasi kasitlidir.
    event RouterSwap(
        address indexed token,
        address indexed payer,
        address indexed recipient,
        bool buy,
        uint256 amountIn,
        uint256 amountOut
    );

    error NotPoolManager();
    error DeadlinePassed(uint256 deadline, uint256 nowTimestamp);
    error ZeroRecipient();
    error AmountOutOfRange(uint256 amount);
    error TooLittleReceived(uint256 got, uint256 min);
    error TooMuchRequested(uint256 paid, uint256 max);
    error PartialFill(int256 requested, int256 filled);
    error LegSignsUnexpected(int256 inDelta, int256 outDelta);

    /// @dev QUOTER'IN TASIYICISI. Bir hata degil, BIR DONUS KANALIDIR:
    ///      `_quote` islemi bilerek revert ettirir ve degeri buradan okur.
    error QuoteResult(uint256 amountIn, uint256 amountOut);
    error QuoteDidNotRevert();

    /// @dev `unlockCallback`in TEK girdisi. `payer` BURADA, kullanicidan
    ///      GELMEZ -- ayrintisi `_swap`te.
    struct Call {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
        bool quoting;
    }

    constructor(IPoolManager poolManager_, IHooks hook_) {
        poolManager = poolManager_;
        hook = hook_;
    }

    // ---------------------------------------------------------------
    // Takas -- dort sekil, dort ince sarmalayici
    // ---------------------------------------------------------------
    //
    // DORT AYRI GIRIS VAR AMA DORT AYRI KORUMA YOK, VE AYRIM TASIYICIDIR.
    // Bu deponun kendi olcumu: "bir ozelligin bir giris noktasinda
    // kapatilmasi, HEPSINDE kapatilmis gibi okunur" -- on bir ornek. Bu
    // yuzden deadline, alici, miktar sinirlari ve slippage kontrollerinin
    // TAMAMI `_swap`in ICINDE, TEK BIRER KOPYA halinde durur. Sarmalayicilar
    // yalnizca (yon, kesinlik) ciftini ve HANGI donusun dondurulecegini
    // secer; her birinin kendi testi tam olarak o secimi olcer.
    //
    // BIRIMLER IMZADAN OKUNUR VE BU KASITLIDIR: `quote*` alanlari 6-decimal
    // ERC-20 birimi, `tokens*` alanlari 18-decimal wei. Tek bir
    // `swap(bool buy, ...)` girisi bu ayrimi ARAYUZDEN silerdi.

    /// @notice USDC ver, token al. Verilen miktar TAM olarak harcanir.
    function buyExactIn(address token, uint256 quoteIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        (, tokensOut) = _swap(token, true, true, quoteIn, minTokensOut, to, deadline);
    }

    /// @notice Token al, TAM olarak istenen kadar. USDC girdisi `maxQuoteIn`i asamaz.
    function buyExactOut(address token, uint256 tokensOut, uint256 maxQuoteIn, address to, uint256 deadline)
        external
        returns (uint256 quoteIn)
    {
        (quoteIn,) = _swap(token, true, false, tokensOut, maxQuoteIn, to, deadline);
    }

    /// @notice Token ver, USDC al. Verilen token TAM olarak harcanir.
    function sellExactIn(address token, uint256 tokensIn, uint256 minQuoteOut, address to, uint256 deadline)
        external
        returns (uint256 quoteOut)
    {
        (, quoteOut) = _swap(token, false, true, tokensIn, minQuoteOut, to, deadline);
    }

    /// @notice USDC al, TAM olarak istenen kadar. Token girdisi `maxTokensIn`i asamaz.
    function sellExactOut(address token, uint256 quoteOut, uint256 maxTokensIn, address to, uint256 deadline)
        external
        returns (uint256 tokensIn)
    {
        (tokensIn,) = _swap(token, false, false, quoteOut, maxTokensIn, to, deadline);
    }

    // ---------------------------------------------------------------
    // Quote -- KULLANICIYA GOSTERILEN SAYI, HOOK'UN PAYI DUSULMUS
    // ---------------------------------------------------------------
    //
    // `eth_call` ILE CAGRILMAK ICINDIR ve `view` OLAMAZ: V4'te bir fiyat
    // ancak SWAP'IN KENDISINI CALISTIRARAK bilinir. Havuz ucreti SIFIRDIR ve
    // ucreti hook `beforeSwap`/`afterSwap` deltalariyla alir, yani AMM
    // matematigini disarida yeniden uygulayan bir hesap hook'un payini
    // GOREMEZ ve kullaniciya YANLIS sayi gosterirdi. Buradaki yol gercek
    // `PoolManager.swap`i, gercek hook'la calistirir ve settle etmeden ONCE
    // revert eder; dondurulen sayi kullanicinin FIILEN alacagi sayidir.
    //
    // REVERT'IN TAMAMI GERI ALINIR: `unlock`un transient kilidi de,
    // deltalar da. Bu, Uniswap'in kendi V4 `Quoter`inin deseninin aynisidir.

    function quoteBuyExactIn(address token, uint256 quoteIn) external returns (uint256 tokensOut) {
        (, tokensOut) = _quote(token, true, true, quoteIn);
    }

    function quoteBuyExactOut(address token, uint256 tokensOut) external returns (uint256 quoteIn) {
        (quoteIn,) = _quote(token, true, false, tokensOut);
    }

    function quoteSellExactIn(address token, uint256 tokensIn) external returns (uint256 quoteOut) {
        (, quoteOut) = _quote(token, false, true, tokensIn);
    }

    function quoteSellExactOut(address token, uint256 quoteOut) external returns (uint256 tokensIn) {
        (tokensIn,) = _quote(token, false, false, quoteOut);
    }

    // ---------------------------------------------------------------
    // Cekirdek
    // ---------------------------------------------------------------

    /// @dev `payer` BURADA, `msg.sender`DEN YAZILIR VE BASKA HICBIR YERDEN
    ///      GELEMEZ. Router'in gucu tam olarak kullanicilarin ona verdigi
    ///      ERC-20 `approve`larindan ibarettir; `payer`i bir PARAMETRE yapan
    ///      bir router, o onaylari veren HERKESI herkese acardi. Bu kontratta
    ///      `payer`i tasiyan tek yapi `Call`dir, `Call`i uretebilen tek yer bu
    ///      fonksiyondur (ve `_quote`, ki o da settle etmez), ve `Call`i
    ///      COZEN tek yer `unlockCallback`tir -- o da yalnizca `PoolManager`i
    ///      dinler.
    function _swap(address token, bool buy, bool exactIn, uint256 amount, uint256 bound, address to, uint256 deadline)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        // Arc'ta blok zaman damgalari ARTMAYABILIR (esit olabilir, geriye
        // gitmez -- olculdu: 553 ardisik ciftin 271'i esit). `>` bu yuzden
        // dogru operatordur ve `>=` bir deadline'i, ayni saniyeye dusen
        // gecerli bir islemde REDDEDERDI.
        if (block.timestamp > deadline) revert DeadlinePassed(deadline, block.timestamp);
        if (to == address(0)) revert ZeroRecipient();

        (PoolKey memory key, bool zeroForOne) = _resolve(token, buy);
        Call memory c = Call({
            payer: msg.sender,
            recipient: to,
            key: key,
            zeroForOne: zeroForOne,
            amountSpecified: _amountSpecified(exactIn, amount),
            quoting: false
        });

        // MIKTARLAR `unlock`IN DONUSUNDEN GELIR, BIR DEPOLAMA ALANINDAN
        // DEGIL. Bir `_lastDelta` alani cagrilar arasi bir kanal acardi ve bu
        // kontratin TEK durumsuz olma ozelligini kaybettirirdi.
        (amountIn, amountOut) = abi.decode(poolManager.unlock(abi.encode(c)), (uint256, uint256));

        // SLIPPAGE KORUMASI ROUTER'DA, ARAYUZDE DEGIL. Iki kopya vardir ve
        // ikisi de BURADADIR; sarmalayicilarda tekrar edilmezler.
        if (exactIn) {
            if (amountOut < bound) revert TooLittleReceived(amountOut, bound);
        } else {
            if (amountIn > bound) revert TooMuchRequested(amountIn, bound);
        }

        emit RouterSwap(token, msg.sender, to, buy, amountIn, amountOut);
    }

    /// @dev `payer`/`recipient` SIFIRDIR VE OLMALIDIR. Quote yolu settle
    ///      ETMEZ, ama `quoting` bayragini dusuren bir mutasyon bu satirlar
    ///      sayesinde `transferFrom(address(0), ...)` ile GURULTULU duser --
    ///      `msg.sender` yazmak, ayni mutasyonu SESSIZ bir gercek takasa
    ///      cevirirdi.
    function _quote(address token, bool buy, bool exactIn, uint256 amount)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        (PoolKey memory key, bool zeroForOne) = _resolve(token, buy);
        Call memory c = Call({
            payer: address(0),
            recipient: address(0),
            key: key,
            zeroForOne: zeroForOne,
            amountSpecified: _amountSpecified(exactIn, amount),
            quoting: true
        });

        try poolManager.unlock(abi.encode(c)) returns (bytes memory) {
            revert QuoteDidNotRevert();
        } catch (bytes memory reason) {
            return _decodeQuote(reason);
        }
    }

    /// @notice `PoolManager.unlock`in geri cagrisi.
    ///
    /// @dev IKI KATMAN, VE IKINCISI YAPISALDIR -- `ArcpadLocker`inkiyle AYNI
    ///      ARGUMAN:
    ///        (1) `msg.sender` kontrolu: bir saldirgan bu fonksiyonu DOGRUDAN
    ///            cagirip kendi `Call`ini (ornegin `payer = kurban`) cozduremez.
    ///        (2) `PoolManager.unlock` geri cagriyi `IUnlockCallback(msg.sender)`
    ///            uzerine yapar, yani BIR SALDIRGANIN `unlock`U BU CALLBACK'I
    ///            HIC CALISTIRMAZ -- kendi kontratininkini calistirir.
    ///      Disari acilan tek sey callback'in KABUL EDILMESIDIR, ICERIGI degil.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Call memory c = abi.decode(data, (Call));

        BalanceDelta delta = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: c.amountSpecified,
                sqrtPriceLimitX96: c.zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            ""
        );

        (uint256 amountIn, uint256 amountOut) = _amounts(delta, c.zeroForOne);

        // KISMI DOLULUK REDDEDILIR, VE TEK BIR ESITLIK DORT SEKLI DE KAPSAR.
        // `swapDelta`nin SPECIFIED bacagi, hook'un deltasi ZATEN dusuldukten
        // sonra, tam doluluk halinde `amountSpecified`in KENDISIDIR (dort
        // sekilde de; hook'un `beforeSwap` payi `amountToSwap`i buyutur ya da
        // kucultur ve `Hooks.afterSwap` onu cagirandan geri alir). Fiyat
        // sinirina carpan bir swap ise EKSIK doldurur ve esitlik BOZULUR.
        // Bunu yakalamayan bir router'da `buyExactOut` SESSIZCE "istedigin
        // kadar degil, olabildigi kadar" anlamina gelirdi.
        int256 specified = c.amountSpecified < 0 ? -int256(amountIn) : int256(amountOut);
        if (specified != c.amountSpecified) revert PartialFill(c.amountSpecified, specified);

        if (c.quoting) revert QuoteResult(amountIn, amountOut);

        // ODEME KULLANICIDAN DOGRUDAN `PoolManager`A GIDER; ROUTER ARADA
        // BAKIYE TUTMAZ. `burn: false` -- ERC-6909 yolu HIC KULLANILMAZ.
        (Currency inC, Currency outC) =
            c.zeroForOne ? (c.key.currency0, c.key.currency1) : (c.key.currency1, c.key.currency0);
        inC.settle(poolManager, c.payer, amountIn, false);
        outC.take(poolManager, c.recipient, amountOut, false);

        return abi.encode(amountIn, amountOut);
    }

    // ---------------------------------------------------------------
    // Saf yardimcilar
    // ---------------------------------------------------------------

    /// @dev ANAHTAR KULLANICIDAN ALINMAZ, TURETILIR. `hook` `immutable`dir,
    ///      yani bu router yalnizca ARCPAD'IN KANONIK anahtarlarina
    ///      dokunabilir. Sonucu su: `token` bu factory'nin uretmedigi bir
    ///      adres olsa bile, o anahtarda bir havuz ACILAMAMISTIR --
    ///      `ArcpadHook._beforeInitialize` hem cagiranin graduation hedefi
    ///      olmasini hem token'in factory'den gelmesini ister -- dolayisiyla
    ///      `swap` `PoolNotInitialized` ile duser ve router O ADRESE HICBIR
    ///      CAGRI YAPMAMIS olur. Kullanicinin `PoolKey` verebildigi bir
    ///      router, kendi ERC-20'sunu havuza koyan bir saldirgana router'in
    ///      onaylarini kullandirabilirdi.
    function _resolve(address token, bool buy) private view returns (PoolKey memory key, bool zeroForOne) {
        bool baseIsCurrency0;
        (key, baseIsCurrency0) = GraduationMath.poolKey(token, hook);
        // buy  = quote ver, token al  -> quote'un bulundugu bacaktan cikilir.
        // sell = token ver, quote al  -> token'in bulundugu bacaktan cikilir.
        zeroForOne = buy ? !baseIsCurrency0 : baseIsCurrency0;
    }

    /// @dev UST SINIR ZORUNLUDUR VE SESSIZ BIR ISARET DEGISIMINI ONLER.
    ///      `int256(amount)` `2^255`in ustunde NEGATIFE sarar; `exactIn`
    ///      dalindaki `-` onu POZITIFE cevirir, yani exact-INPUT bir istek
    ///      sessizce exact-OUTPUT olurdu. Sinir `int128` cunku
    ///      `PoolManager._accountPoolBalanceDelta` deltalari `int128`e
    ///      indirger; daha genis bir sinir hatayi yalnizca daha derine iterdi.
    function _amountSpecified(bool exactIn, uint256 amount) private pure returns (int256) {
        if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert AmountOutOfRange(amount);
        return exactIn ? -int256(amount) : int256(amount);
    }

    /// @dev ISARETLER YAPISALDIR: girdi bacagi HER ZAMAN bir borc (negatif),
    ///      cikti bacagi HER ZAMAN bir alacak (pozitif). Ihlali REVERT'tir,
    ///      `uint` donusumu DEGIL -- ki sessizce sarmasin.
    ///
    ///      `outDelta < 0` ULASILABILIR VE OLCULDU: hook'un ucreti
    ///      `feeOn(x,95) + feeOn(x,30)` ile TAVANA yuvarlandigi icin, 1
    ///      birimlik bir quote ciktisi 2 birimlik ucret uretir. O takas,
    ///      settle edilseydi, kullaniciya HER IKI bacaktan da odetirdi.
    ///      `inDelta > 0` ise arcpad hook'uyla ULASILAMAZ -- hook hicbir
    ///      zaman negatif delta dondurmez -- ve boyle kaydediliyor; tek bir
    ///      kontrol olmasinin sebebi, ulasilamayan yarinin kendi basina bir
    ///      mutant uretmemesidir.
    function _amounts(BalanceDelta delta, bool zeroForOne) private pure returns (uint256 amountIn, uint256 amountOut) {
        (int256 inDelta, int256 outDelta) = zeroForOne
            ? (int256(delta.amount0()), int256(delta.amount1()))
            : (int256(delta.amount1()), int256(delta.amount0()));
        if (inDelta > 0 || outDelta < 0) revert LegSignsUnexpected(inDelta, outDelta);
        amountIn = uint256(-inDelta);
        amountOut = uint256(outDelta);
    }

    /// @dev SELECTOR IDDIA EDILIR, `catch` SESSIZ BIR YUTMA OLMASIN DIYE.
    ///      Kendi hatamiz degilse revert AYNEN geri kabartilir: bir
    ///      `PoolNotInitialized`, `PartialFill` ya da hook revert'i quote
    ///      yolunda da AYNI hatayla gorunmelidir. Aksi halde arayuz "0 alirsin"
    ///      diye okurdu.
    function _decodeQuote(bytes memory reason) private pure returns (uint256 amountIn, uint256 amountOut) {
        if (reason.length == 4 + 64) {
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(reason, 0x20))
            }
            if (selector == QuoteResult.selector) {
                assembly ("memory-safe") {
                    amountIn := mload(add(reason, 0x24))
                    amountOut := mload(add(reason, 0x44))
                }
                return (amountIn, amountOut);
            }
        }
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
