import { Address } from '@/components/ui/Address'

/**
 * ============================================================================
 *  INFO -- SAYFANIN SONU, VE TABLOLARIN ALTINDA
 * ============================================================================
 *
 * Kim baslatti, X hesabi, sozlesme adresi, aciklama. Referans tasarimda bu
 * blok en altta durur ve dogru yeri orasi: bunlar bir kez okunan, sonra bir
 * daha bakilmayan alanlardir. Ustte olsalardi fiyati ve islemleri asagi iter,
 * yani her ziyarette kaydirma maliyeti odenirdi.
 *
 * ACIKLAMA METNI ZINCIRDEN DEGIL, METADATA'DAN gelir ve `sanitiseForDisplay`
 * ile temizlenmis olarak buraya ulasir (`lib/metadata.ts`). Burada tekrar
 * temizlenmez: iki yerde temizlemek, birinin gun gelip degismesi ve digerinin
 * unutulmasi demektir.
 */
export function TokenInfo({
  creator,
  token,
  x,
  telegram,
  description,
}: {
  creator: string
  token: string
  x?: string | undefined
  telegram?: string | undefined
  description?: string | undefined
}) {
  return (
    <section className="flex flex-col gap-5" data-testid="token-info">
      <h2 className="text-[15px] font-medium">Info</h2>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Field label="Launched by">
          {/*
            KOPYALANABILIR. Bir launchpad'de "bu adresi tanıyor muyum" sorusu
            bir arama gerektirir ve arama kopyalamayla baslar; kisaltilmis bir
            adresi elle yazmak hata uretir.
          */}
          <Address value={creator} copy label="Creator address" />
        </Field>

        <Field label="X account">
          {x === undefined ? (
            <span className="text-muted">&mdash;</span>
          ) : (
            /*
              `rel="noopener noreferrer"` VE `target="_blank"`: bu baglanti
              kullanicinin girdigi bir metinden gelir. `noopener` olmadan
              acilan sayfa `window.opener` uzerinden bu sekmeyi baska bir
              adrese yonlendirebilir -- ve bir launchpad'de o, kimlik avinin
              tam olarak isleyis bicimidir.
            */
            <a
              href={x}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text underline decoration-white/20 underline-offset-4 transition-colors hover:decoration-white/50"
            >
              {handleOf(x)}
            </a>
          )}
        </Field>

        <Field label="Contract address">
          <Address value={token} copy label="Contract address" />
        </Field>
      </div>

      {telegram === undefined ? null : (
        <Field label="Telegram">
          <a
            href={telegram}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text underline decoration-white/20 underline-offset-4 transition-colors hover:decoration-white/50"
          >
            {handleOf(telegram)}
          </a>
        </Field>
      )}

      <Field label="Description">
        {description === undefined ? (
          <span className="text-muted">No description.</span>
        ) : (
          // `break-words`: bir aciklama bosluksuz uzun bir dize olabilir ve
          // tasarsa sayfanin TAMAMINI yatay kaydiriyor olurdu.
          <p className="max-w-[70ch] break-words text-[13px] leading-relaxed">{description}</p>
        )}
      </Field>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-muted">{label}</span>
      <div className="text-[13px]">{children}</div>
    </div>
  )
}

/** `https://x.com/zacklabadie` -> `@zacklabadie`. Cozulemezse adresin kendisi. */
function handleOf(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '')
    return path === '' ? url : `@${path.split('/')[0]}`
  } catch {
    return url
  }
}
