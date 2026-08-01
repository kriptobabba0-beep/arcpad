import type { ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { Address } from '@/components/ui/Address'
import { Money } from '@/components/ui/Money'
import { getWebConfig } from '@/lib/addresses'

/**
 * GECICI. Task 8 bu dosyayi Explore izgarasiyla degistirir.
 *
 * Iki sey ONEMLI ve o gorevden once de dogru olmali:
 *  - `<main>` BURADA YOK. Landmark kabuktadir (`components/layout/AppShell`);
 *    ikinci bir `main` sayfada iki ana bolge demektir ve atlama baglantisinin
 *    hedefi belirsizlesir.
 *  - Gosterilen her sey GERCEK yapilandirmadan gelir. Uydurulmus bir token
 *    satiri kabugun dogru gorunmesini saglar ama yanlis seyi dogrular.
 */
export default function Home() {
  const { chain, addresses } = getWebConfig()

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-12">
      <div className="flex flex-col gap-3">
        {/* Slogan ALTBILGIDE duruyor; burada tekrar etmek onu iki kez soyler
            ve ikisi de zayiflar. Bu baslik sayfanin isini soyler. */}
        <h1 className="font-serif text-5xl leading-[1.05] tracking-[-0.02em]">
          Pointed at {chain.name}
        </h1>
        <p className="text-sm text-muted">
          The explore grid lands with Task 8. Below is the address book this build actually reads.
        </p>
      </div>

      <Card className="divide-y divide-border">
        <Row label="Network">
          {/* Ag adi zaten "Arc Testnet" diyor; yanina bir "testnet" rozeti
              koymak ayni seyi iki kez soyler. Rozet basliktaki kilitte. */}
          <span>{chain.name}</span>
        </Row>
        <Row label="Chain ID">
          <span className="tabular-nums">{chain.id}</span>
        </Row>
        <Row label="Factory">
          <Address value={addresses.launchFactory} copy explorer label="Launch factory" />
        </Row>
        <Row label="Fee escrow">
          <Address value={addresses.feeEscrow} copy explorer label="Fee escrow" />
        </Row>
        {/*
          Bir bakiye AŞAĞI yuvarlanir: `rounding="down"` var olmayan parayi
          gostermemeyi garanti eder. Girdi 18 ondalikli native, cikti 6
          ondalikli ERC-20 gorunumu -- TEK figur, iki degil.
        */}
        <Row label="Graduation raise">
          <Money native={12_161_433_369_060_378_706n} rounding="down" unit />
        </Row>
      </Card>

      <p className="text-[12px] leading-relaxed text-muted">
        On Arc the native gas asset is USDC itself. Your wallet may show this balance with 18
        decimals; this site shows the same balance with 6. It is one balance, shown two ways.
      </p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  )
}
