import { getWebConfig } from '@/lib/addresses'

/**
 * BIR ISLEMIN DURUM SATIRI -- KISA VE EYLEM ICEREN.
 *
 * Yedi hal var ve altisi metinli; `idle` hicbir sey CIZMEZ (bos bir kutu,
 * ekran okuyucuya duyurulacak bir degisiklik uretmeden yer kaplar).
 *
 * `stillPending` AYRI BIR HALDIR ve `failed` DEGILDIR. Arc'ta blok
 * ~350 ms'de kapaniyor (olculdu), yani makbuz gelmemesi neredeyse her zaman
 * RPC tarafindadir. Ikisini birlestirmek kullaniciya ayni islemi ikinci kez
 * yaptirtir -- ve ilki bu sirada zaten madenci tarafindan alinmistir.
 */
export type TxPhase =
  'idle' | 'signing' | 'broadcast' | 'confirmed' | 'stillPending' | 'cancelled' | 'failed'

/** ArcScan islem baglantisi. Adres KAYITTAN gelir, sabit yazilmaz. */
export function arcScanTxUrl(hash: string): string {
  return `${getWebConfig().chain.blockExplorers.default.url}/tx/${hash}`
}

const LINES: Readonly<Record<Exclude<TxPhase, 'idle'>, string>> = {
  signing: 'Confirm this in your wallet.',
  broadcast: 'Sent. Waiting for the receipt.',
  confirmed: 'Done.',
  stillPending: 'Still pending.',
  cancelled: 'Cancelled.',
  failed: 'That transaction did not go through.',
}

export function TxStatus({ state, hash }: { state: TxPhase; hash?: `0x${string}` }) {
  if (state === 'idle') return null

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
      <span data-testid="tx-status-line" data-phase={state}>
        {LINES[state]}
      </span>
      {/*
        BAGLANTI HER DURUMDA HASH ILE BIRLIKTE. Bir hash varsa kullanici onu
        gorebilmeli: "gonderildi" diyip nereye gonderildigini soylememek,
        basarisiz bir islemde kullaniciyi tamamen kor birakir.
      */}
      {hash ? (
        <a
          href={arcScanTxUrl(hash)}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-sm text-accent underline-offset-2 hover:underline"
        >
          View on ArcScan
        </a>
      ) : null}
    </p>
  )
}
