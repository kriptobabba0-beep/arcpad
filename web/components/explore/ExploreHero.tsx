import Link from 'next/link'
import { buttonClassName } from '@/components/ui/Button'

/**
 * SAYFANIN ILK EKRANI, VE ONCEDEN YOKTU.
 *
 * Explore bir `sr-only` `h1` ile aciliyordu, yani goren bir ziyaretci icin
 * sayfanin ilk ogesi bir uyari kutusuydu. Bu iki seyi birden yapiyordu:
 * urunun NE OLDUGUNU hicbir yerde soylemiyor, ve ilk izlenimi bir hataya
 * benzetiyordu.
 *
 * BASLIK ARTIK GORUNUR, ve `sr-only` olan kaldirildi -- iki `h1` (biri gizli,
 * biri gorunur) ekran okuyucuya sayfanin iki adi oldugunu soylerdi.
 *
 * CTA BURADA TEKRAR EDIYOR VE BU BILINCLI. Ustteki cubukta da bir "Create"
 * var; oradaki her sayfada duran kalici bir eylemdir, buradaki ise bu
 * sayfanin TEKLIFIDIR. Referans arayuzlerin ikisi de ayni tekrari yapiyor,
 * ve sebebi olculebilir: izgaraya bakan biri "ben de yapabilir miyim"
 * sorusunun cevabini gorselin yaninda ariyor, menude degil.
 *
 * ZINCIRIN ADI CUMLENIN ICINDE. Ustteki "ARC TESTNET" rozeti bir durum
 * gostergesidir; burada ise urunun tanimina giriyor, cunku "hangi zincir"
 * sorusu bir launchpad'de ilk sorulan sorudur.
 */
export function ExploreHero() {
  return (
    <section className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
      <div className="flex max-w-[56ch] flex-col gap-3">
        <h1 className="font-serif text-[40px] leading-[1.05]">Launch a token on Arc</h1>
        <p className="text-[15px] leading-relaxed text-muted">
          Every launch gets the same fixed supply and the same bonding curve. Creating one is free —
          you pay gas, and nothing else. Trading fees are{' '}
          <span className="text-text">0.95% protocol + 0.30% creator</span>, and the creator share
          is yours on every buy and every sell.
        </p>
      </div>

      <Link href="/create" className={buttonClassName({ variant: 'primary', size: 'lg' })}>
        Launch a token
      </Link>
    </section>
  )
}
