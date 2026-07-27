import { describe, expect, it } from 'vitest'
import { nextRange } from '../src/cursor'

describe('nextRange', () => {
  it('imlec head ile ayniysa islenecek bir sey yoktur', () => {
    expect(nextRange(100n, 100n, 1000n)).toBeNull()
  })

  it('imlec head gerisindeyse imlecten sonraki bloktan baslar', () => {
    expect(nextRange(100n, 150n, 1000n)).toEqual({ from: 101n, to: 150n })
  })

  it('araligi maxSpan ile sinirlar', () => {
    expect(nextRange(0n, 10_000n, 500n)).toEqual({ from: 1n, to: 500n })
  })

  it('head imlecin gerisine duserse null doner (yeniden baglanma guvenligi)', () => {
    expect(nextRange(200n, 150n, 1000n)).toBeNull()
  })

  it('tam olarak maxSpan kadar blok kaldiginda tek aralikta bitirir', () => {
    expect(nextRange(0n, 500n, 500n)).toEqual({ from: 1n, to: 500n })
  })
})
