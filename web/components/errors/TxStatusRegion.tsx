'use client'

import { cx } from '@/components/ui/cx'
import { FailureNotice } from './FailureNotice'
import type { ReadableFailure } from './failureCopy'
import { TxStatus, type TxPhase } from './TxStatus'

/**
 * TEK DUYURU BOLGESI, VE IKI POLITENESS.
 *
 * Iki `aria-live` bolgesi HER ZAMAN DOM'da durur, icleri bos olsa bile. Bu
 * bir suslemenin degil calisma bicimi meselesi: ekran okuyucular bir canli
 * bolgeyi ONCEDEN kaydeder ve icerigin DEGISMESINI dinler. Bolgeyi metinle
 * BIRLIKTE monte etmek, ilk mesajin cogu zaman hic duyurulmamasi demektir --
 * kullanicinin en cok duymasi gereken mesaj da genelde ilkidir.
 *
 * POLITENESS AYRIMI DA TASIYICIDIR: ilerleme `polite` ile duyurulur
 * (kullanicinin yaptigi isi bolmez), basarisizlik `assertive` ile -- kullanici
 * parasi hakkinda bir seyin yanlis gittigini SIRADAKI ISI BEKLEMEDEN
 * duymalidir. Tek bir polite bolge, hata mesajini kuyrugun sonuna koyar.
 *
 * NEREYE TAKILIR: uygulama kabuguna, BIR KEZ. Panel basina bir bolge acmak
 * bolge sayisini panel sayisi kadar cogaltir ve okuyucunun hangisini
 * dinleyecegi tanimsiz hale gelir.
 */
export function TxStatusRegion({
  state = 'idle',
  hash,
  failure,
  onRetry,
  onSwitchNetwork,
  className,
}: {
  state?: TxPhase
  hash?: `0x${string}`
  failure?: ReadableFailure
  onRetry?: () => void
  onSwitchNetwork?: () => void
  className?: string
}) {
  // Basarisizlik varken ilerleme satiri SUSAR: iki bolge ayni anda konusursa
  // okuyucu ikisini pespese okur ve eylem iceren cumle ikinci sirada kalir.
  const phase: TxPhase = failure ? 'idle' : state

  return (
    <div className={cx('flex flex-col gap-2', className)} data-testid="tx-status-region">
      <div role="status" aria-live="polite" data-testid="tx-status-polite">
        <TxStatus state={phase} {...(hash ? { hash } : {})} />
      </div>
      <div role="alert" aria-live="assertive" data-testid="tx-status-assertive">
        {failure ? (
          <FailureNotice
            failure={failure}
            {...(hash ? { hash } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(onSwitchNetwork ? { onSwitchNetwork } : {})}
          />
        ) : null}
      </div>
    </div>
  )
}
