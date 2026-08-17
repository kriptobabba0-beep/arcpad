// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title FeeSchedule
/// @notice Graduation SONRASI havuz ucret kademeleri. Launch aninda dondurulur:
///         `LaunchFactory` her token'i deploy edildigi schedule'a baglar ve
///         tabloyu guncellemek YENI bir `FeeSchedule` deploy etmek demektir --
///         ki o da YALNIZCA sonraki launch'lari etkiler.
///
/// @dev IKI FARKLI "UCRET KADEMESI" VARDIR VE KARISTIRMAK BU DOSYANIN TEK
///      GERCEK TUZAGIDIR:
///        (1) `PoolKey.fee` -- V4'un LP ucreti. arcpad'de SIFIR ve
///            DEGISTIRILEMEZ (dinamik bayrak tasimadigi icin
///            `updateDynamicLPFee` hook'a bile kapali). Havuzun KALICI
///            KIMLIGININ parcasidir.
///        (2) BU DOSYA -- hook'un tahsil ettigi, market cap'e endeksli oran.
///
/// @dev DEPOLAMA YOKTUR. Tablo `pure` fonksiyonun ICINDEDIR, yani
///      degistirilemezlik garantisi BYTECODE'DAN gelir. Constructor'da yazilan
///      bir storage dizisi de setter'siz degistirilemez olurdu, ama bytecode
///      hem daha guclu hem daha ucuzdur.
///
/// @dev TABLO OLCULDU, VARSAYILMADI. Kaynak, pump.fun AMM'inin canli
///      `FeeConfig` hesabidir:
///        `5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx`
///        owner `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`, 4073 bayt
///      Hesap IKI kademe dizisi tasir ve YANLISINI OKUMAK SESSIZ BIR HATADIR:
///        - offset   69: SOL dizisi -- esikler 0, 420.000, 1.470.000, ...
///                       98.240.000. BU DIZI KULLANILMAZ.
///        - offset 1073: `stable_fee_tiers` (USDC) -- esikler 0, 59.000,
///                       300.000, ... 20.000.000. KULLANILAN BUDUR.
///      Iki dizinin lp/protokol/creator kolonlari AYNIDIR; yalnizca esikler
///      ayrisir, dolayisiyla yanlis diziyi okumak hicbir toplami bozmaz ve
///      hicbir testte gorunmezdi -- yalnizca kademe gecislerini ~7 kat yanlis
///      yere koyardi.
contract FeeSchedule {
    /// @notice Kademe secimi mint'in GERCEK arziyla degil bu sabitle yapilir.
    ///         Tum launch'lar ayni arza sahip oldugu icin market cap saf bir
    ///         FIYAT fonksiyonuna iner.
    uint256 public constant SUPPLY_CONSTANT = 1e27;

    uint256 public constant TIER_COUNT = 25;

    /// @dev 11M..19M bandinin creator bps'i, 8-bit lane'lerde, i = 0..8.
    ///      i = 0 -> EN DUSUK bayt. Degerler: 28,25,23,20,18,15,13,10,8.
    ///      (20M ve ustu ayri bir dalda, 5.)
    ///      Spec bu bandin yalnizca UC NOKTALARINI veriyordu; ara satirlar
    ///      canli hesaptan OKUNDU ve enterpolasyona gerek kalmadi.
    uint256 private constant CREATOR_BPS_11M_20M = 0x05080A0D0F121417191C;

    uint256 private constant UNIT = 1e6; // 1 USDC, 6 decimal
    uint256 private constant MILLION = 1e6 * UNIT;

    /// @notice Market cap, quote'un TABAN BIRIMINDE (USDC icin 6 decimal).
    /// @param quoteRaw Havuzun ham quote miktari -- 6 decimal.
    /// @param baseRaw Havuzun ham base miktari -- 18 decimal.
    /// @dev DONUSUM YOKTUR ve OLMAMALIDIR: `SUPPLY_CONSTANT = 1e27` sabit arzi
    ///      18 decimal'de tasidigi icin oran zaten 6-decimal quote biriminde
    ///      bir sonuc verir. Buraya bir 1e12 eklemek ya da cikarmak sessizce
    ///      10^12 kat kayik bir kademe secerdi.
    /// @dev `FullMath` KULLANILIR: `quoteRaw * 1e27` uretim buyuklugunde
    ///      (1,2e10 * 1e27 = 1,2e37) rahat sigar ama sinirsiz `quoteRaw` icin
    ///      sigmaz, ve tasan bir market cap EN DUSUK kademeye duserdi.
    function marketCap(uint256 quoteRaw, uint256 baseRaw) external pure returns (uint256) {
        if (baseRaw == 0) return 0;
        return FullMath.mulDiv(quoteRaw, SUPPLY_CONSTANT, baseRaw);
    }

    /// @notice Verilen market cap icin protokol ve creator bps'i.
    ///
    /// @dev ESIKLER KAPSAYICIDIR (`>=`). Tarama YUKARIDAN asagiyadir.
    ///
    /// @dev LP PAYI PROTOKOLE KATLANMISTIR (kademe 0'da 2, ustunde 20 bps).
    ///      Windfall DEGIL KURTARMADIR: spec'in tablosunda bir LP kolonu vardir
    ///      ama arcpad'de o payin ALICISI YOKTUR -- tek LP, cikarma yolu
    ///      olmayan kalici pozisyondur, dolayisiyla ona akan her sey YAKILIRDI.
    ///      arcpad'in protokolu zaten O pozisyonun sahibidir; hook'ta tahsil
    ///      etmek payi geri kazanmaktir. Katlamanin dogrulugu TAHMIN DEGIL
    ///      KONTROL EDILEBILIR: katlanmis `protocolBps + creatorBps`, canli
    ///      tablonun Toplam kolonuna 25 satirin 25'inde esittir.
    ///
    /// @dev KADEME 0'IN PROTOKOL PAYI TAM OLARAK 95'TIR -- `BondingCurve`in
    ///      `PROTOCOL_FEE_BPS`iyle ayni sayi, ve creator 30 da
    ///      `CREATOR_FEE_BPS` ile ayni. Tesaduf degildir: bolusum graduation
    ///      oncesiyle BIREBIR ayni tutulur, yani GRADUATION TRADER ICIN
    ///      UCRET-NOTRDUR. Orani degistiren sey mezuniyet degil, ILK ESIK
    ///      GECISIDIR.
    function tierFor(uint256 marketCapUnits) external pure returns (uint256 protocolBps, uint256 creatorBps) {
        if (marketCapUnits < 59_000 * UNIT) return (95, 30); // kademe 0
        protocolBps = 25; // 5 + 20 (LP katlandi)
        if (marketCapUnits >= 20 * MILLION) return (protocolBps, 5);
        if (marketCapUnits >= 11 * MILLION) {
            uint256 i = marketCapUnits / MILLION - 11; // 0..8
            return (protocolBps, (CREATOR_BPS_11M_20M >> (8 * i)) & 0xFF);
        }
        if (marketCapUnits >= 3 * MILLION) {
            uint256 i = marketCapUnits / MILLION - 3; // 0..7
            return (protocolBps, 65 - 5 * i);
        }
        if (marketCapUnits >= 2 * MILLION) return (protocolBps, 70);
        if (marketCapUnits >= 900_000 * UNIT) return (protocolBps, 75);
        if (marketCapUnits >= 700_000 * UNIT) return (protocolBps, 80);
        if (marketCapUnits >= 500_000 * UNIT) return (protocolBps, 85);
        if (marketCapUnits >= 300_000 * UNIT) return (protocolBps, 90);
        return (protocolBps, 95); // 59.000..300.000
    }
}
