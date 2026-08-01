// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title GraduationMath
/// @notice Curve'un kapanis durumunu bir V4 havuz acilisina ceviren SAF
///         aritmetik. Depolama yok, dis cagri yok, `PoolManager` yok.
///
/// @dev UC SESSIZ HATA burada yasar ve burada kapanir: `address(0)`'in
///      anahtara sizmasi, siralamanin VARSAYILMASI, ve 10^12 donusumunun
///      KAYBOLMASI. Ucu de calisma zamaninda gorunmez -- yanlis siralama
///      revert etmez, kayip 10^12 revert etmez; ikisi de sessizce YANLIS bir
///      havuz acar. Bu yuzden hepsi burada, saf ve tek basina test edilebilir
///      bir katmanda toplanmistir.
library GraduationMath {
    /// @notice Arc'in ERC-20 USDC arayuzu. Havuzun quote bacagi BUDUR ve
    ///         `address(0)` DEGILDIR. Arc dokumani emir kipinde: "ERC-20 USDC
    ///         kontratini dogrudan cift tokeni olarak kullan", "WUSDC deploy
    ///         ETME", "native'i ERC-20 arayuzuyle eslestirme -- ikisi ayni
    ///         varliktir." `PoolManager` ikisini AYIRT EDEMEZ: "native"
    ///         kavraminin tamami `currency.isAddressZero()`dur.
    address internal constant QUOTE = 0x3600000000000000000000000000000000000000;

    /// @notice 1 ERC-20 birimi = 10^12 wei.
    /// @dev Arc'ta native varlik USDC'nin KENDISIDIR: 18 decimal'lik bir native
    ///      gorunum ve 6 decimal'lik bir ERC-20 gorunum, AYNI BAKIYENIN iki
    ///      yuzu. Asla toplanmazlar. Hicbir calisma zamani kontrolu 1e12'lik
    ///      bir hatayi goremez -- bakiyeler tutarli kalir, yalnizca fiyat 10^6
    ///      kat kayar. Sabitin TEK bir yerde bulunmasinin sebebi budur.
    uint256 internal constant QUOTE_SCALE = 1e12;

    uint256 internal constant Q192 = 1 << 192;

    /// @notice V4 LP ucreti. SIFIR, ve `LPFeeLibrary.DYNAMIC_FEE_FLAG`
    ///         (0x800000) DEGIL -- yani `PoolManager.updateDynamicLPFee`
    ///         `UnauthorizedDynamicLPFeeUpdate()` ile doner ve HOOK'UN KENDISI
    ///         BILE havuz ucretini degistiremez. Sifir olmasinin sebebi: V4'te
    ///         havuz ucreti pozisyonlara birikir, arcpad'in tek pozisyonunun
    ///         cikarma yolu yoktur, dolayisiyla sifir olmayan bir ucret
    ///         sonsuza kadar yakilirdi. Ucret hook'ta tahsil edilir.
    uint24 internal constant POOL_FEE = 0;

    /// @notice Havuzda tek bir tam aralik pozisyon oldugu icin tick yogunlugu
    ///         EKONOMIK OLARAK ATILDIR. Secimi belirleyen tek sey sinir
    ///         davranisidir: tickSpacing = 1 ile ust sinir TAM OLARAK
    ///         `MAX_SQRT_PRICE` olur -- `getTickAtSqrtPrice`in KENDISININ
    ///         reddettigi deger. 60, locker'in dokundugu her sqrt fiyatini
    ///         V4'un dogruladigi araligin KESINLIKLE icinde tutar ve gereken
    ///         tick araligina (+-442.827) iki kat pay birakir.
    int24 internal constant TICK_SPACING = 60;

    int24 internal constant TICK_LOWER = -887220; // TickMath.minUsableTick(60)
    int24 internal constant TICK_UPPER = 887220; // TickMath.maxUsableTick(60)

    /// @dev Sabit gaz icin SABIT YAZILIR; DOGRULUGU testte `TickMath`e karsi
    ///      kanitlanir. Sabiti elle degistiren bir mutasyon orada olur --
    ///      `TickMath`i hic cagirmayan bir sabit, cagirmayan bir testle
    ///      birlikte hicbir sey ifade etmezdi.
    uint160 internal constant SQRT_LOWER = 4306310044;
    uint160 internal constant SQRT_UPPER = 1457652066949847389969617340386294118487833376468;

    error ZeroBase();
    error BaseIsQuote();
    error ZeroReserves();
    error PriceOutOfRange();

    /// @notice Bir launch tokeni icin arcpad'in KANONIK havuz anahtari.
    /// @param base Launch tokeni.
    /// @param hooks Havuza baglanacak hook. ENJEKTE EDILIR, sabit DEGILDIR.
    /// @return key Kanonik `PoolKey`.
    /// @return baseIsCurrency0 Token'in `currency0` olup olmadigi. Cagiran bu
    ///         bayragi fiyat hesabina TASIMAK ZORUNDADIR; tasimamak fiyati
    ///         tersine cevirir ve HICBIR revert uretmez.
    ///
    /// @dev SIRALAMA HESAPLANIR, VARSAYILMAZ. `PoolManager` kati
    ///      `currency0 < currency1` uygular (`>=` reddedilir). USDC
    ///      `0x36...`'da oturur ve `LaunchFactory`'nin salt'i TURETILMISTIR,
    ///      madenle bulunmamis; token adresleri 160-bit uzayda tekduzedir,
    ///      dolayisiyla `0x36/0x100 = %21,09375`i USDC'nin ALTINA duser.
    ///      "Token her zaman currency1" diye yazilmis bir kod HER BES
    ///      LAUNCH'TAN BIRINDE `CurrenciesOutOfOrderOrEqual` ile revert eder.
    ///
    /// @dev `address(0)` ANAHTARA GIREMEZ ve bu bir KANITTIR, kontrol degil:
    ///      `QUOTE` sifir olmayan bir sabit oldugu icin, `base != 0`
    ///      saglandiginda iki bacaktan hangisi `currency0` olursa olsun sifir
    ///      OLAMAZ. `ZeroBase()` kontrolu, kaniti kanit yapan sey. V4 bunu
    ///      KENDISI reddetmez: `{address(0), 0x3600...}` ciftinin
    ///      `currency0 < currency1`i GECER ve sessizce USDC'nin KENDISINE
    ///      karsi bir havuz olur -- native gorunumle ERC-20 gorunumu ayni
    ///      varlik oldugu icin. Reddetmek arcpad'in isi.
    function poolKey(address base, IHooks hooks) internal pure returns (PoolKey memory key, bool baseIsCurrency0) {
        if (base == address(0)) revert ZeroBase();
        if (base == QUOTE) revert BaseIsQuote();
        baseIsCurrency0 = base < QUOTE;
        key = PoolKey({
            currency0: Currency.wrap(baseIsCurrency0 ? base : QUOTE),
            currency1: Currency.wrap(baseIsCurrency0 ? QUOTE : base),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hooks
        });
    }

    /// @notice Native 18-decimal quote wei -> 6-decimal ERC-20 birimi.
    /// @dev TABAN, ve kalan `quoteWeiAmount % QUOTE_SCALE` wei cagiranda KALICI
    ///      olarak kalir: 1 ERC-20 biriminin altinda oldugu icin ERC-20
    ///      arayuzuyle hareket ettirilemez. Graduation basina en fazla
    ///      `10^12 - 1` wei. Bu bir kayip degil, bir OZELLIGIN BEDELI: locker
    ///      kendi bakiyesini HIC OKUMADIGI icin biriken artik hicbir zaman
    ///      sonraki bir launch'a atanamaz -- ve bakiye okumamak, ucuncu bir
    ///      tarafin bagisla defteri kaydirmasini imkansiz kilan sey.
    function quoteUnits(uint256 quoteWeiAmount) internal pure returns (uint256) {
        return quoteWeiAmount / QUOTE_SCALE;
    }

    /// @notice `quoteUnits`'in tersi: 6-decimal ERC-20 birimi -> native wei.
    /// @dev Hook ucreti `take` ile 6-decimal birimde alir ama
    ///      `FeeEscrow.deposit{value:}` native wei ister. Carpma KONTROLLUDUR
    ///      ve tasarsa revert eder; `units` bir swap miktarindan geldigi ve
    ///      `uint128`e sigdigi icin pratikte ulasilamaz.
    /// @dev BU FONKSIYON BURADA DURUR, hook'ta DEGIL, cunku `QUOTE_SCALE`
    ///      yalnizca bu dosyada bulunabilir.
    function quoteWei(uint256 units) internal pure returns (uint256) {
        return units * QUOTE_SCALE;
    }

    /// @notice Curve'un kapanis fiyatinin karekoku, Q64.96.
    /// @param quoteFinal `curve.virtualQuoteReserves()` -- 18 decimal native wei.
    /// @param baseFinal `curve.virtualTokenReserves()` -- 18 decimal token wei.
    /// @param baseIsCurrency0 `poolKey`'in dondurdugu bayrak.
    ///
    /// @dev TANIM BIR KEZ YAZILIR ve iki siralamada da AYNI BICIMDEDIR:
    ///        oran(X192)   = floor(pay * 2^192 / payda)
    ///        sqrtPriceX96 = floor(sqrt(oran(X192)))
    ///      Iki dalda da ASAGI yuvarlanir, dolayisiyla havuz `P_final`'da ya da
    ///      ondan EN FAZLA BIR ULP asagida acar ve YON IKI SIRALAMADA AYNIDIR.
    ///      Bir dali `2^192 / digerSqrt` ile hesaplamak YASAKTIR: o yon YUKARI
    ///      yuvarlar, ve tek bir invariant icin iki farkli tanim tam olarak bir
    ///      tutarsizligin plana sizma bicimidir.
    ///
    /// @dev `baseFinal * QUOTE_SCALE` KONTROLLU aritmetiktir ve tasarsa revert
    ///      eder; sessiz sarma yoktur. Sinir disi profiller deploy aninda
    ///      `isSeedable` ile elenir, dolayisiyla bu revert graduation aninda
    ///      ULASILAMAZ olur -- ama savunma yine de burada durur.
    function sqrtPriceX96(uint256 quoteFinal, uint256 baseFinal, bool baseIsCurrency0) internal pure returns (uint160) {
        if (quoteFinal == 0 || baseFinal == 0) revert ZeroReserves();
        uint256 scaled = baseFinal * QUOTE_SCALE;
        uint256 s = Math.sqrt(
            baseIsCurrency0 ? FullMath.mulDiv(quoteFinal, Q192, scaled) : FullMath.mulDiv(scaled, Q192, quoteFinal)
        );
        if (s <= TickMath.MIN_SQRT_PRICE || s >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfRange();
        return uint160(s);
    }

    /// @notice Bir profilin HER IKI siralamada temsil edilebilir bir havuz
    ///         acilis fiyati uretip uretmedigi. REVERT ETMEZ.
    ///
    /// @dev REVERT ETMEMESI TASIYICIDIR: cagiran (deploy zamani profil
    ///      kontrolu) bunu KENDI hatasiyla reddedebilsin diye. Revert etseydi
    ///      kullanici `FullMath`in ya da bu kutuphanenin hatasini gorurdu ve
    ///      HANGI KATMANIN reddettigi kaybolurdu -- deponun `ZeroAmount`
    ///      carpismasi dersinin aynisi.
    ///
    /// @dev Tasma kosulu ARITMETIK olarak, `FullMath`i CAGIRMADAN hesaplanir:
    ///      `FullMath.mulDiv(a, 2^192, d)` sonucu ancak `d > a >> 64` iken 256
    ///      bite sigar, cunku `prod1 = (a * 2^192) >> 256 = a >> 64` ve guard
    ///      `require(d > prod1)`. Iki kontrol de gereklidir cunku iki
    ///      SIRALAMANIN pay ve paydasi terstir.
    ///
    /// @dev KAPANISTAKI MIN/MAX KONJONKSIYONU FIILEN OLU KODDUR VE BU
    ///      OLCULDU: yerine `return true` konuldugunda paketin 491 testinin
    ///      HICBIRI kirilmaz, ve 400.000'den fazla ornekte konjonksiyon
    ///      sonucu BIR KEZ BILE belirlemedi -- ustundeki iki tasma korumasi
    ///      KATI OLARAK DAHA GUCLUDUR (yaklasik dokuz buyukluk mertebesi).
    ///      BIRAKILIYOR cunku yonu KORUMACIDIR (yanlis tarafa dusmez) ve
    ///      `sqrtPriceX96`in kendi `PriceOutOfRange` sinirini AYNEN yansitir;
    ///      ama "ikisi ayni sinirdan konusur" demek YANLIS olurdu ve
    ///      denmiyor. Bedeli deploy yolunda iki `sqrt` ve iki `mulDiv`dir --
    ///      launch basina degil, FACTORY BASINA BIR KEZ.
    function isSeedable(uint256 quoteFinal, uint256 baseFinal) internal pure returns (bool) {
        if (quoteFinal == 0 || baseFinal == 0) return false;
        if (baseFinal > type(uint256).max / QUOTE_SCALE) return false;
        uint256 scaled = baseFinal * QUOTE_SCALE;
        if (scaled <= (quoteFinal >> 64)) return false; // token = currency0 dali
        if (quoteFinal <= (scaled >> 64)) return false; // USDC  = currency0 dali
        uint256 a = Math.sqrt(FullMath.mulDiv(quoteFinal, Q192, scaled));
        uint256 b = Math.sqrt(FullMath.mulDiv(scaled, Q192, quoteFinal));
        return a > TickMath.MIN_SQRT_PRICE && a < TickMath.MAX_SQRT_PRICE && b > TickMath.MIN_SQRT_PRICE
            && b < TickMath.MAX_SQRT_PRICE;
    }

    /// @notice Tam aralik pozisyonun likiditesi.
    /// @dev ASAGI yuvarlar; `Pool.modifyLiquidity` gerekli miktarlari YUKARI
    ///      yuvarlar. Yonler ZIT oldugu icin bacak basina 1 wei tasma teorik
    ///      olarak mumkundur -- dort kanonik durumda OLCULDU: yok. Cagiran yine
    ///      de acik bir kontrol tasimalidir, cunku aksi halde ariza
    ///      `SafeERC20`nin icinde, HANGI KATMANIN yetersiz kaldigini
    ///      soylemeyen bir revert olarak gorunurdu.
    function seedLiquidity(uint160 sqrtPrice, uint256 amount0, uint256 amount1) internal pure returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmounts(sqrtPrice, SQRT_LOWER, SQRT_UPPER, amount0, amount1);
    }
}
