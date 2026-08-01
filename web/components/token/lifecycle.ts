/**
 * UC DURUM, BUGUNDEN (S6, K5).
 *
 * `BondingCurve`'un bugunku TEK durumu `bool complete`. Spec'in dort fazli
 * yasam dongusu (`NotGraduated/Swept/PoolCreated/Rescued`) kontratta YOK ve
 * yazilmayacak. `graduate()` ve `Graduated` olayi gelmek uzere ama bu dalda
 * mevcut degil.
 *
 * `graduated` dali BUGUN ULASILAMAZ ve yine de burada: tipi ve ekrani bugunden
 * hazir olsun ki Faz 2 bir YENIDEN YAZIM degil, yalnizca bir veri kaynagi
 * baglama isi olsun. Testi bir fixture ile bugun yazilir.
 */
export type Lifecycle =
  | { readonly kind: 'trading' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'graduated'; readonly poolNote: string }

export function resolveLifecycle(source: {
  complete: boolean
  /** Faz 2. Bugun her zaman `false`/`undefined` gelir. */
  graduated?: boolean | undefined
  poolNote?: string | undefined
}): Lifecycle {
  if (source.graduated === true) {
    return { kind: 'graduated', poolNote: source.poolNote ?? 'Trading has moved to the pool.' }
  }
  return source.complete ? { kind: 'complete' } : { kind: 'trading' }
}

/**
 * ARC'IN BLOK SURESI, ve grafik aralik pill'lerinin TEK KAYNAGI.
 *
 * Olculdu: ~350 ms. BLOK SURESI DEGISIRSE BURASI DEGISIR -- asagidaki dort
 * pencere bu sabitten turetilir, hicbiri elle yazilmaz. Elle yazilsalardi
 * blok suresi degistiginde "1H" etiketi bir saati gostermemeye baslar ve
 * hicbir test bunu fark etmezdi.
 */
export const BLOCKS_PER_SECOND = 1000 / 350

export type RangeKey = '5M' | '1H' | '6H' | '1D' | 'ALL'

/** Pencerenin BLOK cinsinden genisligi. `ALL` sinirsizdir. */
export function rangeToBlocks(range: RangeKey): number | null {
  const seconds: Record<Exclude<RangeKey, 'ALL'>, number> = {
    '5M': 5 * 60,
    '1H': 60 * 60,
    '6H': 6 * 60 * 60,
    '1D': 24 * 60 * 60,
  }
  if (range === 'ALL') return null
  return Math.round(seconds[range] * BLOCKS_PER_SECOND)
}

export const RANGE_KEYS: readonly RangeKey[] = ['5M', '1H', '6H', '1D', 'ALL']

/**
 * `eventSeq` -> blok numarasi.
 *
 * Faz 3'un kodlamasi: `eventSeq = (block << 20) | logIndex` (LOG_INDEX_BITS
 * = 20). X ekseni BUNDAN turetilir, duvar saatinden DEGIL: olculdu, 553
 * ardisik blok ciftinin 271'i (%49,0) ayni timestamp'i tasiyor, yani zamana
 * oturtulan bir eksende bloklarin yarisi UST USTE duser.
 */
export const LOG_INDEX_BITS = 20n

export function blockOfSeq(eventSeq: bigint): number {
  return Number(eventSeq >> LOG_INDEX_BITS)
}
