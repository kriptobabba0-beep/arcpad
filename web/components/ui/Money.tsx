import { formatUsdcAmount, type Rounding } from '@arcpad/shared/browser'
import { cx } from './cx'
import { UsdcMark } from './UsdcMark'

export type MoneyProps = {
  /**
   * NATIVE (18 ondalikli) tutar. HER ZAMAN. Prop'un adi `native` cunku bu
   * arayuzdeki en yuksek riskli detay bir isim meselesi: Arc'ta native gaz
   * varligi USDC'nin KENDISIDIR ve ayni fonun iki gorunumu vardir --
   * 18 ondalikli native, 6 ondalikli ERC-20
   * (0x3600000000000000000000000000000000000000).
   *
   * 1e12'lik bir hata hicbir calisma zamani kontrolunun goremeyecegi bir
   * hatadir: "buyuk bakiye" ile "1e12 ile olceklenmis kucuk bakiye" arasinda
   * calisma zamaninda hicbir isaret yoktur. Bu yuzden sinir acikca
   * isimlendirilmistir: iceri native girer, disari 6 ondalikli TEK bir figur
   * cikar. Iki gorunum asla iki satir olarak gosterilmez.
   */
  native: bigint
  /**
   * ZORUNLU, varsayilani YOK.
   *   'down' -> bakiye, alacak, ELE GECEN tutar. Asla var olmayan parayi gostermez.
   *   'up'   -> maliyet, odenecek tutar, ust sinir. Asla odenecekten azini gostermez.
   * Varsayilan verilmedi cunku "hangi yon" sorusunun her para hucresinde bir
   * cevabi vardir ve sessizce yanlis olani secmek kullanici-zararidir.
   */
  rounding: Rounding
  /** En fazla 6 -- yedinci ondalik yalnizca native gorunumde vardir. */
  maxFractionDigits?: number
  /** ` USDC` ekler. Tek varlikli bir kolonda gereksiz, tek bir figurde sart. */
  unit?: boolean
  className?: string
}

/**
 * HER PARA HUCRESI BUNDAN GECER, ve `tabular-nums`'i tasiyan sey budur.
 *
 * Oransal rakamlarla cizilen bir para kolonu satir satir kayar: `1` ile `8`
 * ayni genislikte olmadigi icin ondalik noktalari hizalanmaz ve goz bir listeyi
 * taramak yerine her satiri ayri ayri okumak zorunda kalir. Bu urunun tamami
 * hizli tarama uzerine kurulu, dolayisiyla tabular rakamlar bir suslemenin
 * degil okunabilirligin parcasi.
 */
export function Money({
  native,
  rounding,
  maxFractionDigits,
  unit = false,
  className,
}: MoneyProps) {
  const text = formatUsdcAmount(native, {
    rounding,
    ...(maxFractionDigits === undefined ? {} : { maxFractionDigits }),
  })

  return (
    <span className={cx('tabular-nums', className)} data-rounding={rounding}>
      {text}
      {/*
        BIRIM ARTIK ISARET + AD. Isaret `aria-hidden`, ad okunur -- bkz.
        `UsdcMark`. Metin "USDC" tek basina dogruydu; isaret onu bir MARKA
        yapar ve para birimini bir bakista taninir kilar.
      */}
      {unit ? <UsdcMark size={14} className="ml-1.5 text-muted" /> : null}
    </span>
  )
}
