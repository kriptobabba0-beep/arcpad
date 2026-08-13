import { Money } from '@/components/ui/Money'
import { LiveNumber } from '@/components/ui/LiveNumber'

/**
 * PAYI DA PAYDASI DA YAZILI.
 *
 * YUZDE TOKEN SATISI UZERINDENDIR, TOPLANAN QUOTE UZERINDEN DEGIL -- ve bu
 * bir tercih degil bir zorunluluk. Gerekcesi Faz 3'un turetmesi:
 * `quoteBuyCost` her alimda `floor(...) + 1` doner, yani biriken quote
 * tamamlanmada `R`'yi ASAR. Olculdu: canli smoke curve `12161433369060378714`
 * topladi, `R` ise `12161433369060378706` -- 8 wei fazla. Quote tabanli bir
 * yuzde bu yuzden %100'u GECER; token tabanli olan tam sifirda tam
 * `1_000_000` verir.
 *
 * Iki sayi BIRLIKTE gosterilir. Yalnizca yuzde gosterilseydi neyin yuzdesi
 * oldugu saklanmis olurdu; yalnizca tutar gosterilseydi kullanici hedefe ne
 * kadar kaldigini kendisi hesaplardi.
 */
export function ProgressToGraduation({
  ppm,
  raisedWei,
  targetWei,
}: {
  ppm: number
  raisedWei: bigint
  targetWei: bigint
}) {
  /*
   * ONDA BIR YUZDE, BIR TAM SAYI OLARAK. `LiveNumber` aritmetigi `bigint`
   * uzerinde yapar. `ppm` MILYONDA BIR: yuzde `ppm / 10 000`, onda bir yuzde
   * ise `ppm / 1 000` (`ppm=253000` -> `253` -> `25.3%`).
   */
  const tenths = BigInt(Math.round(ppm / 1_000))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">
          <LiveNumber value={tenths} format="percent1" className="font-medium" />{' '}
          <span className="text-muted">to graduation</span>
        </p>
        <p className="text-[13px] text-muted">
          {/*
            Toplanan tutar ASAGI yuvarlanir (ele gecen para), hedef YUKARI
            (ulasilmasi gereken esik). Ikisini ayni yone yuvarlamak, sinirda
            "hedefe ulasildi" gorunen ama ulasilmamis bir satir uretir.
          */}
          <Money native={raisedWei} rounding="down" /> of <Money native={targetWei} rounding="up" />{' '}
          USDC raised
        </p>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(tenths) / 10}
        aria-label="Progress to graduation"
        className="h-1.5 overflow-hidden rounded-pill bg-white/8"
      >
        <div
          className="h-full rounded-pill bg-accent transition-[width] duration-300"
          style={{ width: `${Math.min(100, ppm / 10_000)}%` }}
        />
      </div>
    </div>
  )
}
