import Link from 'next/link'
import { TokenArtwork } from '@/components/layout/TokenArtwork'
import { Address } from '@/components/ui/Address'
import type { HexAddress } from '@/components/read/types'

/**
 * ============================================================================
 *  TOKEN KIMLIGI -- SAYFANIN ILK UC SATIRI
 * ============================================================================
 *
 * Geri baglantisi, gorsel, ad, ve adin ALTINDA sembol + adres + kopyala.
 * Hiyerarsi bilincli: bir kullanici once neye baktigini (ad), sonra hangi
 * sozlesmeye baktigini (adres) bilmek ister, ve ikisi ayni satirda esit
 * agirlikta olsaydi ikincisi birinciyi bogardi.
 *
 * ADRES KISALTILMIS AMA KOPYALANABILIR. Bir launchpad'de "dogru token mu"
 * sorusunun tek kesin cevabi adrestir; goz kirpma mesafesinde olmali ama
 * basligin yerini almamali. `Address` bileseni kisaltmayi ve kopyalamayi
 * zaten tasiyor -- ikinci bir kopya yazmak, iki farkli kisaltma bicimi
 * demek olurdu.
 *
 * GERI BAGLANTISI GERCEK BIR `<Link>`: yeni sekmede acilabilir, adresi
 * kopyalanabilir. Tarayicinin geri dugmesine birakmak, sayfaya bir aramadan
 * gelen birini cikmaza sokar.
 */
export function TokenIdentity({
  name,
  symbol,
  token,
  imageUrl,
  badges,
}: {
  name: string
  symbol: string
  token: HexAddress
  imageUrl?: string | null
  /** Adin yanindaki rozetler -- yasam dongusu, provenance, sosyal. */
  badges?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/"
        className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted transition-colors duration-150 hover:text-text"
      >
        <span aria-hidden="true">&lsaquo;</span> Home
      </Link>

      <div className="flex items-center gap-4">
        {/*
          64px: referans tasarimin oranini tasir ve ad ile birlikte tek bir
          "kimlik bloku" okunur. `TokenArtwork` gorsel yoksa o token'a ozel
          bir gradyan cizer -- kirik bir resim ikonu DEGIL.
        */}
        <TokenArtwork address={token} uri={imageUrl ?? null} size={64} symbol={symbol} />

        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate font-serif text-[28px] leading-none">{name}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-[13px] uppercase tracking-[0.06em] text-muted">{symbol}</span>
            <Address value={token} copy />
            {badges}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Kimlik satirindaki kucuk rozet.
 *
 * `tone` bir renk DEGIL bir ANLAM tasir: `info` notrdur, `accent` bu
 * launchpad'in kendi isaretidir, `warn` dikkat ister. Cagri yerinde renk
 * secmek, ayni anlamin iki sayfada iki farkli renkle cikmasinin yoludur.
 */
export function IdentityBadge({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'accent' | 'warn' | 'blue'
  children: React.ReactNode
}) {
  const palette = {
    info: 'border-white/12 bg-white/6 text-muted',
    accent: 'border-accent/30 bg-accent/12 text-accent',
    warn: 'border-negative/30 bg-negative/12 text-negative',
    /*
     * MAVI: "curve complete" bir ARIZA DEGIL, bir ASAMA.
     *
     * Kirmiziydi ve yanlis seyi soyluyordu: kirmizi bu arayuzde "bir sey
     * ters gitti" demek (reddedilen islem, satis yonu, dar slipaj uyarisi).
     * Satis arzinin tukenmesi ise bir launch'in BASARISI. Mavi notrdur ve
     * "durum degisti" der.
     */
    blue: 'border-[#3adcff]/30 bg-[#3adcff]/12 text-[#3adcff]',
  }[tone]

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none ${palette}`}
    >
      {children}
    </span>
  )
}
