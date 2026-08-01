'use client'

import type { UsdcBalance } from '@arcpad/shared/browser'

/**
 * =========================================================================
 *  GECICI STUB -- TASK 2 GELDIGINDE BU DOSYA SILINIR.
 * =========================================================================
 *
 * TODO(task-2): `web/hooks/useUsdcBalance.ts` bu dalgada BASKA BIR IZIN
 * SAHIBINDE. O dosya indigi anda yapilacak sey uc satir:
 *   1. `WalletButton.tsx`'te import'u `@/hooks/useUsdcBalance`'a cevir,
 *   2. `web/test/ui/wallet-button.test.tsx`'in `vi.mock` hedefini guncelle,
 *   3. bu dosyayi sil.
 *
 * Donen sekil UYDURULMADI: `UsdcBalance` `@arcpad/shared/browser`'in gercek
 * tipidir ve TEK bir fonun iki okumasini TEK bir degerde tasir (`wei` 18
 * ondalikli native, `units` 6 ondalikli ERC-20). Kabuk bu sekle karsi
 * dizildigi icin Task 2'nin hook'u takildiginda yerlesim degismez.
 *
 * Stub BILEREK `undefined` doner ve wagmi'nin `useBalance`'ini CAGIRMAZ.
 * K1'in uygulama maddesi `useBalance`'i import etmeye izinli tek modulun
 * `web/lib/balance.ts` oldugunu soyluyor ve Task 2 bunu bir eslint kuraliyla
 * kapatiyor; buraya gecici bir ikinci bakiye kaynagi yazmak, o kural indiginde
 * baska bir izin sahibinin dalini kirardi. Bakiyesi olmayan bir cuzdan
 * dugmesi dogru cizilir (bakiye yerine `—`), yanlis bakiye cizen bir dugme
 * cizilmez.
 */
export type UsdcBalanceState = {
  readonly balance: UsdcBalance | undefined
  readonly isPending: boolean
}

export function useUsdcBalance(): UsdcBalanceState {
  return { balance: undefined, isPending: false }
}
