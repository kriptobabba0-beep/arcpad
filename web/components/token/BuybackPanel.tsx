import { LiveNumber } from '@/components/ui/LiveNumber'
import type { TokenBuyback } from '@/lib/read'

/**
 * ============================================================================
 *  CREATOR-FONLU BUYBACK & LOCK -- "SOZ VERILEN SEY OLDU MU"
 * ============================================================================
 *
 * Creator, kendi ucret payinin YARISINI geri alima ayirabilir; alinan token
 * bes yil kilitlenir. Bu panel tek bir soruyu cevaplar: SOZ TUTULDU MU.
 *
 * ============ NE GOSTERILMEZ, VE NEDEN ============
 *
 * "SU ANDA CEKILEBILIR" GOSTERILMEZ. `BuybackVestingVault` vesting'i
 * checkpoint'li hesaplar (`yeni = vestsizKalan * gecen / (bitis - sonGuncelleme)`)
 * ve `lastUpdate` her kilitte ve her dagitimda yeniden yazilir. Yani hak
 * edilmis tutar YOL BAGIMLIDIR ve olaylardan yeniden kurulamaz. Dogrusal bir
 * yaklasim TEK KILITLI tokenlerde dogru cevabi verirdi -- tam da bu yuzden
 * tehlikeli: ekranda dogru gorunen sayi, ikinci kilitten sonra sessizce
 * yanlislasirdi. Canli rakam isteyen bir gun `vault.releasable(token)`i
 * ZINCIRDEN okumali.
 *
 * Gosterilen ZAMAN ILERLEMESI ise bir OLGUDUR: pencerenin ne kadari gecti.
 * Token miktari hakkinda bir sey soylemez ve soylememesi icin etiketi de
 * "Vesting window" der, "vested" demez.
 *
 * ============ UC HAL, UC AYRI EKRAN ============
 *
 *   veri yok        -> panel HIC cizilmez (cagri yeri karar verir)
 *   enabled=false   -> "kapali" satiri + GECMIS durur. Kapatilmis bir buyback
 *                      gecmisi SILMEZ: alinan token hala kilitlidir.
 *   enabled=true    -> tam panel.
 *
 * "Hic buyback olmadi" ile "kapatildi" ayni ekran DEGILDIR ve bu ayrimi
 * yapabilmemizin tek sebebi politika olayini indekslemis olmamiz.
 */
export function BuybackPanel({ buyback, symbol }: { buyback: TokenBuyback; symbol: string }) {
  const spent = buyback.spentTotalWei
  const returned = buyback.returnedTotalWei
  const pending = buyback.pendingQuoteWei
  const released = buyback.releasedCreatorTok + buyback.releasedProtocolTok

  return (
    <section data-testid="buyback-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">Creator buyback</h2>
        <StatusPill enabled={buyback.enabled} />
      </div>

      <p className="text-[13px] text-muted">
        {buyback.enabled ? (
          <>
            Half of the creator&apos;s fee on every trade is set aside to buy {symbol} back from the
            market. Everything bought is locked for five years.
          </>
        ) : (
          <>
            The creator has turned buyback off. Nothing new is being set aside — anything already
            bought stays locked.
          </>
        )}
      </p>

      {/*
        DORT SAYI, VE DORDU DE BIR OLGU. `pending` zincirin kendi mutlak
        degerinden gelir; oteki ucu kumulatif toplamlardir.
      */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Figure
          label="Bought back"
          testId="buyback-bought"
          value={<LiveNumber value={buyback.boughtTotalTok} format="token" />}
          suffix={symbol}
        />
        <Figure
          label="Locked"
          testId="buyback-locked"
          value={<LiveNumber value={buyback.lockedTotalTok} format="token" />}
          suffix={symbol}
        />
        <Figure
          label="Spent buying"
          testId="buyback-spent"
          value={<LiveNumber value={spent} format="usdc" />}
        />
        <Figure
          label="Budget waiting"
          testId="buyback-pending"
          value={<LiveNumber value={pending} format="usdc" />}
        />
      </dl>

      {/*
        GERI KATLAMA YALNIZCA OLDUYSA GORUNUR -- ve olduysa GORUNMEK ZORUNDA.
        `accrued` ile `spent` arasindaki farki aciklayan tek sey budur; onsuz
        fark bir KAYIP gibi okunur. Sifirken bir satir cizmek ise panele
        cevabi olmayan bir soru eklerdi.
      */}
      {returned === 0n ? null : (
        <p className="text-[13px] text-muted" data-testid="buyback-returned">
          <LiveNumber value={returned} format="usdc" /> went back to the creator — a sweep found no
          safe way to buy at that moment.
        </p>
      )}

      {buyback.vestingStartAt === null || buyback.vestingEndAt === null ? null : (
        <VestingWindow start={buyback.vestingStartAt} end={buyback.vestingEndAt} />
      )}

      {released === 0n ? null : (
        <p className="text-[13px] text-muted" data-testid="buyback-released">
          <LiveNumber value={buyback.releasedCreatorTok} format="token" /> {symbol} released to the
          creator and <LiveNumber value={buyback.releasedProtocolTok} format="token" /> {symbol} to
          the protocol.
        </p>
      )}
    </section>
  )
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      data-testid="buyback-status"
      className={
        'rounded-pill px-2.5 py-1 text-[12px] font-medium ' +
        (enabled ? 'bg-[#4ade80]/12 text-[#4ade80]' : 'bg-white/8 text-muted-raised')
      }
    >
      {enabled ? 'On' : 'Off'}
    </span>
  )
}

function Figure({
  label,
  value,
  suffix,
  testId,
}: {
  label: string
  value: React.ReactNode
  suffix?: string
  testId: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="text-[15px] font-medium tabular-nums" data-testid={testId}>
        {value}
        {suffix === undefined ? null : (
          <span className="ml-1 text-[13px] text-muted">{suffix}</span>
        )}
      </dd>
    </div>
  )
}

/**
 * PENCERENIN NE KADARI GECTI -- BIR ZAMAN OLGUSU, BIR TUTAR DEGIL.
 *
 * `<progress>` DEGIL bir `<div>` cifti kullanilmasinin sebebi `VolumePanel`in
 * cubugununkinin TERSI: orada tamamlanan bir sey yoktu, burada VAR (pencere
 * gercekten ilerliyor) ama ilerleyen sey TOKEN DEGIL ZAMAN. Etiket bunu
 * soyler; yuzdeyi bir token miktarina baglayan hicbir metin yok.
 *
 * `now` DISARIDAN VERILEBILIR ve testte oyle verilir: `Date.now()`a bagli bir
 * bilesen, zamanla sessizce degisen bir test uretirdi.
 */
export function VestingWindow({ start, end, now }: { start: Date; end: Date; now?: Date }) {
  const at = (now ?? new Date()).getTime()
  const from = start.getTime()
  const to = end.getTime()
  const span = to - from
  const elapsed = span <= 0 ? 0 : Math.min(Math.max(at - from, 0), span)
  const percent = span <= 0 ? 0 : (elapsed / span) * 100

  return (
    <div className="flex flex-col gap-2" data-testid="buyback-vesting">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-muted">Vesting window</span>
        <span className="text-[13px] font-medium tabular-nums" data-testid="buyback-vesting-pct">
          {percent.toFixed(1)}% elapsed
        </span>
      </div>
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-pill bg-white/8"
        role="img"
        aria-label={`${percent.toFixed(1)}% of the five-year vesting window has elapsed`}
      >
        <span className="bg-[#4ade80]" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[12px] text-muted tabular-nums" data-testid="buyback-vesting-dates">
        {iso(start)} → {iso(end)}
      </p>
    </div>
  )
}

/**
 * GUN COZUNURLUGU, VE `en-CA` LOCALE'I ISO SIRASI ICIN.
 *
 * Kok eslint kurali locale'i ACIKCA istiyor (varsayilan locale sunucu ile
 * tarayicida farkli cikar ve hydration uyusmazligi uretir). `en-CA` seciliyor
 * cunku `YYYY-MM-DD` verir: bes yillik bir pencerede gun/ay sirasinin
 * belirsiz olmasi, tam da yanlis okunacak yerdir.
 */
function iso(value: Date): string {
  return value.toLocaleDateString('en-CA', { timeZone: 'UTC' })
}
