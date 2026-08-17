import Link from 'next/link'
import { getWebConfig } from '@/lib/addresses'
import { BRAND } from '@/lib/brand'

/**
 * ALT SERIT, VE ICINDEKI IKI UYARI ISTEGE BAGLI DEGIL.
 *
 * Risk notu: kullanicinin imzaladigi sey geri alinamaz ve fon hicbir asamada
 * bizde durmaz. "Custody" kelimesi burada teknik degil hukuki bir iddia ve
 * dogru olmasi gerekiyor -- yazma yolu dogrudan zincire, kullanicinin
 * cuzdanindan gider; hicbir yazma sunucudan gecmez.
 *
 * Testnet uyarisi: urun KAMUYA ACIK bir testnet'te duruyor. Buradaki USDC
 * Circle'in faucet'inden geliyor ve gercek para degil; bunu yazmayan bir
 * arayuz, "$57M market cap" gosterdiginde yalan soylemis olur.
 *
 * Ikisi de zincirin KAYDINDAN besleniyor: ag adi ve testnet olup olmadigi
 * `chain` kaydindan okunuyor, elle yazilmiyor. Bir gun mainnet geldiginde
 * cumle kendiliginden dogru kalir -- ya da hic cizilmez.
 */
export function Footer() {
  const { chain } = getWebConfig()

  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <p className="font-serif text-[22px] leading-tight text-text">{BRAND.tagline}</p>
        </div>

        <nav aria-label="Footer" className="flex gap-6 text-sm">
          <Link href="/" className="rounded-sm text-muted transition-colors hover:text-text">
            Explore
          </Link>
          <Link href="/create" className="rounded-sm text-muted transition-colors hover:text-text">
            Create
          </Link>
        </nav>
      </div>

      <div className="mx-auto max-w-[1400px] border-t border-border px-4 py-6 sm:px-6">
        {chain.testnet ? (
          <p className="mb-2 text-[13px] font-medium text-accent">
            {chain.name}. Tokens here have no monetary value.
          </p>
        ) : null}
        <p className="max-w-3xl text-[12px] leading-relaxed text-muted">
          Transactions are submitted through your wallet and are irreversible. Tokens can be
          volatile or lose all value. {BRAND.name} does not custody assets.
        </p>
      </div>
    </footer>
  )
}
