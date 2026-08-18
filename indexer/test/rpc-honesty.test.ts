import { describe, expect, it } from 'vitest'
import { judge } from '../scripts/rpc-honesty'

/**
 * ANTI-VACUITY. Bir durustluk olceri "her sey durust" demeye egilimlidir, ve
 * oyle dediginde hicbir sey olcmemis olur. Asagidaki vakalar 2026-08-18'de
 * URETIMDE olculen uc davranisin ta kendisidir.
 */
describe('rpc durustluk yargisi', () => {
  it('BOS CEVAP yalandir -- olculen ariza tam olarak buydu', () => {
    // blockdaemon, 36 log iceren aralik icin hatasiz `[]` donduruyordu.
    const { verdict, detail } = judge(36, { count: 0 })
    expect(verdict).toBe('YALANCI')
    expect(detail).toContain('BOS CEVAP')
  })

  it('HATA yalan degildir -- "bilmiyorum" ile "hicbir sey yok" ayni sey degil', () => {
    // Budanmis gecmis, aralik siniri ve oran siniri: ucunde de uc REDDEDER,
    // ve reddetme viem'in failover'ini tetikler. Zararli olan sessiz kabuldur.
    expect(judge(36, { error: 'pruned history unavailable' }).verdict).toBe('TANIKLIK YOK')
    expect(judge(36, { error: 'ranges over 10000 blocks are not supported' }).verdict).toBe(
      'TANIKLIK YOK',
    )
    expect(judge(36, { error: 'rate limit exceeded' }).verdict).toBe('TANIKLIK YOK')
  })

  it('dogru sayi durusttur', () => {
    expect(judge(36, { count: 36 }).verdict).toBe('DURUST')
  })

  it('EKSIK sayi da yalandir, yalnizca sifir degil', () => {
    // Secmeli kayip da kayiptir. Yalnizca sifiri yakalayan bir olcer, bir ucun
    // araligin BIR KISMINI dusurmesini gecirirdi.
    const { verdict, detail } = judge(36, { count: 12 })
    expect(verdict).toBe('YALANCI')
    expect(detail).not.toContain('BOS CEVAP')
  })
})
