import { describe, expect, it } from 'vitest'
import { CURVE_STATE_POLL_MS, curveReadFrom } from '@/components/token/useCurveState'
import { approvalStateOf } from '@/components/token/useApproval'
import { CREATOR, ZERO_CREATOR } from './fixtures'

/**
 * ZINCIR OKUMALARININ SAF YARISI.
 *
 * Cozumleme ve onay karari React'tan ayri duruyor, cunku ikisi de bir
 * RENDER'DAN degil bir DEGERDEN cikiyor -- ve bir cuzdan baglamis tarayici
 * kurmadan olculebilmeleri, olculmeleri icin gereken tek sart.
 */

const EIGHT = [
  1_073_000_000_000_000_000_000_000_000n,
  4_292_000_000_000_000_000n,
  793_100_000_000_000_000_000_000_000n,
  0n,
  false,
  CREATOR,
  95n,
  30n,
] as const

describe('curveReadFrom', () => {
  it('turns the eight results into a state and a fee pair', () => {
    const read = curveReadFrom([...EIGHT])
    expect(read).toEqual({
      state: {
        virtualTokenReserves: EIGHT[0],
        virtualQuoteReserves: EIGHT[1],
        realTokenReserves: EIGHT[2],
        realQuoteReserves: EIGHT[3],
        complete: false,
        creator: CREATOR,
      },
      fees: { protocolFeeBps: 95n, creatorFeeBps: 30n },
    })
  })

  it('reads the fee rates from the CHAIN rather than carrying 95/30 as a constant', () => {
    // Faz 2 `LaunchFactory`'yi bir `feeSchedule` argumaniyla yeniden dagitiyor.
    // Sabit tasiyan bir panel o gun 95/30 gostermeye devam eder ve zincir baska
    // bir sey alir -- ekran ile imza ayrisir.
    const read = curveReadFrom([...EIGHT.slice(0, 6), 120n, 45n])
    expect(read?.fees).toEqual({ protocolFeeBps: 120n, creatorFeeBps: 45n })
  })

  it('keeps a zero creator as a zero creator', () => {
    const read = curveReadFrom([...EIGHT.slice(0, 5), ZERO_CREATOR, 95n, 30n])
    expect(read?.state.creator).toBe(ZERO_CREATOR)
  })

  it.each([
    ['a short answer', EIGHT.slice(0, 7)],
    ['a reserve that is not a bigint', [null, ...EIGHT.slice(1)]],
    ['a complete flag that is not a bool', [...EIGHT.slice(0, 4), 0n, ...EIGHT.slice(5)]],
    ['a creator that is not a string', [...EIGHT.slice(0, 5), 0n, 95n, 30n]],
    ['fee rates that did not decode', [...EIGHT.slice(0, 6), undefined, 30n]],
  ])('refuses %s rather than filling the gap with a zero', (_name, values) => {
    // YARIM BIR DURUM, DURUMSUZLUKTAN TEHLIKELI: eksik bir rezerv `0n`'a
    // duserdi, ve `0n` rezerv planlayici icin "butun arz satildi" demek.
    expect(curveReadFrom([...values])).toBeUndefined()
  })

  it('polls every 2000 ms -- not every block', () => {
    // Arc'in blok suresi ~350 ms. Blok basina yenilemek saniyede ~3 istek
    // demek ve hicbir sey kazandirmiyor: kullaniciyi bayat bir kotadan koruyan
    // sey SLIPAJ ARGUMANIDIR, yenileme sikligi degil.
    expect(CURVE_STATE_POLL_MS).toBe(2000)
  })
})

describe('approvalStateOf', () => {
  it('needs nothing when nothing is being sold', () => {
    expect(approvalStateOf(undefined, null)).toBe('notNeeded')
    expect(approvalStateOf(0n, 0n)).toBe('notNeeded')
  })

  it('waits rather than guessing while the allowance is still loading', () => {
    // Bilinmeyeni "gerekli" saymak, okuma inerken bir saniyeligine "Approve"
    // yazip sonra "Sell"e donmek demek; kullanici o arada basarsa gereksiz bir
    // islem oder.
    expect(approvalStateOf(undefined, 100n)).toBe('unknown')
  })

  it('asks for an approval when the allowance is short, and only then', () => {
    // "allowance kontrolunu kaldir" MUTANTI BURADA OLUR: kontrol olmadan her
    // satis dogrudan gonderilir ve zincir `ERC20InsufficientAllowance` doner.
    expect(approvalStateOf(99n, 100n)).toBe('required')
    expect(approvalStateOf(0n, 100n)).toBe('required')
    expect(approvalStateOf(100n, 100n)).toBe('sufficient')
    expect(approvalStateOf(101n, 100n)).toBe('sufficient')
  })
})
