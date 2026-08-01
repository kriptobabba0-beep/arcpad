import Link from 'next/link'
import { buttonClassName } from '@/components/ui/Button'
import { Pill } from '@/components/ui/Pill'
import { getWebConfig } from '@/lib/addresses'
import { BRAND } from '@/lib/brand'
import { SearchBar } from './SearchBar'
import { WalletButton } from './WalletButton'

/**
 * KABUGUN UST SERIDI.
 *
 * Marka adi TEK BIR SABITTEN gelir (`web/lib/brand.ts`); "arcpad" isaretlemeye
 * dagitilmaz. `BRAND.wordmark` gecici bir kod adidir ve nihai marka kararinda
 * degisecek olan tek dosya odur.
 *
 * AG ADI WORDMARK'IN YANINDA DURUYOR, ve bu bilincli bir risk. Alternatifi onu
 * ayarlar altina, ya da yalnizca bir hata durumunda gorunen bir serite koymak.
 * Ama bu urun KAMUYA ACIK BIR TESTNET'te duruyor: buradaki token'larin parasal
 * degeri yok ve USDC Circle'in faucet'inden geliyor. Hangi agda oldugunuz bir
 * ayar degil, urunun ne oldugu; dolayisiyla marka kilidinin parcasi.
 */
export function Header() {
  const { chain } = getWebConfig()

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <Link
          href="/"
          className="flex items-baseline gap-2 rounded-sm"
          aria-label={`${BRAND.name} home`}
        >
          {/*
            Serif wordmark, geometrik sans govde (§7.3). Serif YALNIZCA burada,
            footer'daki sloganda ve token monogramlarinda gorunur -- ucu de
            "kimlik" isi. Arayuzun geri kalani tek bir sans yuzudur; iki yuzun
            her yerde yarismasi yogun bir tarama yuzeyini yorar.
          */}
          <span className="font-serif text-[26px] leading-none tracking-[-0.015em] text-text">
            {BRAND.wordmark}
          </span>
        </Link>

        {/*
          Gizleme SARMALAYICIDA, Pill'in kendi className'inde DEGIL. `cx`
          cakisma cozmez (bkz. `components/ui/cx.ts`) ve `hidden` ile Pill'in
          taban `inline-flex`'i ayni ozelliktir: hangisinin kazandigini
          Tailwind'in URETIM SIRASI belirler, yazim sirasi degil. Olculdu --
          `className="hidden sm:inline-flex"` 390px'te gizlemedi.
        */}
        {chain.testnet ? (
          <span className="hidden sm:block">
            <Pill tone="accent" dot>
              {chain.name}
            </Pill>
          </span>
        ) : null}

        <nav aria-label="Primary" className="ml-3 hidden md:block">
          <Link
            href="/"
            className="rounded-sm px-1 text-sm text-muted transition-colors duration-150 hover:text-text"
          >
            Explore
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/*
            Tetikleyici ve ⌘K dinleyicisi `SearchTrigger`'da, icerik Task 9'un
            `SearchDialog`'unda, ikisini birlestiren istemci siniri
            `SearchBar`'da. Bolunmenin sebebi: kabuk, veritabanina ve
            `verifyCanonical`'a bagli olan aramadan ONCE ayakta olmali.
          */}
          <SearchBar />
          {/*
            `aria-label` KOSULSUZ. Dar ekranda "Create" metni gizlenir ve
            geriye yalnizca `aria-hidden` bir `+` kalir -- yani baglantinin
            erisilebilir ADI hic olmaz ve ekran okuyucu "link" diye okur.
            Etiketi gizlemek bir gorsel karar; adi kaybetmek bir hata.
          */}
          <Link
            href="/create"
            aria-label="Create a token"
            className={buttonClassName({ variant: 'secondary' })}
          >
            <span aria-hidden="true" className="text-accent">
              +
            </span>
            <span className="hidden sm:inline">Create</span>
          </Link>
          <WalletButton />
        </div>
      </div>
    </header>
  )
}
