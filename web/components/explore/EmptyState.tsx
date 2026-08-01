import Link from 'next/link'
import { buttonClassName } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

/**
 * BOS DURUMLAR BIRINCI SINIFTIR, ve DORDU BIRBIRINDEN AYRIDIR.
 *
 * Aynisini soyleyen tek bir "no results" kutusu, kullaniciya YANLIS SEYI
 * soyler: filtresi bos oldugunda "urun bos" der, veritabani dustugunde "hic
 * launch yok" der. Ikisi de yanlis ve ikisi de kullaniciyi yanlis eyleme
 * yonlendirir -- ilki sayfayi terk etmeye, ikincisi token yaratmaya.
 */
function Shell({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { href: string; label: string } | undefined
}) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <p className="font-serif text-2xl leading-tight">{title}</p>
      <p className="max-w-md text-sm text-muted">{body}</p>
      {action ? (
        <Link href={action.href} className={buttonClassName({ variant: 'primary' })}>
          {action.label}
        </Link>
      ) : null}
    </Card>
  )
}

/** Urun gercekten bos. Ilk gun. `Create` cagrisi burada dogru olan sey. */
export function NoLaunchesYet() {
  return (
    <Shell
      title="No launches yet."
      body="Nothing has been launched on this network. Be the first — creating a token is free and takes one transaction."
      action={{ href: '/create', label: 'Create a token' }}
    />
  )
}

/**
 * FILTRE bos, urun degil. Metin filtreyi ADIYLA anar ve onu temizleyen bir
 * link verir; `Create` cagrisi burada YOK cunku kullanicinin problemi token
 * eksikligi degil, cok dar bir filtre.
 */
export function NoLaunchesForFilter({ ageDays }: { ageDays: number | null }) {
  const window =
    ageDays === 1 ? 'the last 24 hours' : ageDays === 7 ? 'the last 7 days' : 'this filter'
  return (
    <Shell
      title={`No launches in ${window}.`}
      body="There are launches on this network, just none inside this window."
      action={{ href: '/', label: 'Clear filters' }}
    />
  )
}

/**
 * VERITABANI DUSTU. Sayfa 500 VERMEZ.
 *
 * Metin ne kaybedildigini ve neyin hâlâ calistigini AYRI AYRI soyler, cunku
 * kullanicinin bir sonraki hamlesi buna bagli: token yaratmak ve islem
 * yapmak zincire gider ve veritabanina hic ihtiyac duymaz.
 */
export function ReadUnavailable({ what }: { what: string }) {
  return (
    <Shell
      title="Can't load the index right now."
      body={`${what} comes from our indexer, which is not responding. Trading and creating tokens go straight to the chain and still work.`}
      action={{ href: '/create', label: 'Create a token' }}
    />
  )
}

/**
 * Curve complete bolumu BUGUN BOS ve bu bir hata degil urunun ilk gunudur.
 * Bolum yine cizilir: basligin altindaki tek satir, bolumu gorup de bos
 * bulan birine neyin bekledigini soyler.
 */
export function NoCompleteCurves() {
  return (
    <p className="rounded-card border border-border bg-surface px-5 py-8 text-center text-sm text-muted">
      No curve has sold out yet. When one does, it lands here.
    </p>
  )
}
