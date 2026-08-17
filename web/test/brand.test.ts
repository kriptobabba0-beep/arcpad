import { describe, expect, it } from 'vitest'
import { BRAND } from '../lib/brand'

describe('BRAND', () => {
  it('marka adini tek bir yerden verir', () => {
    expect(BRAND.name).toBe('arcpad')
  })

  it('wordmark ile ad ayni kaynaktan turer', () => {
    expect(BRAND.wordmark).toBe(BRAND.name)
  })

  it('tagline zinciri adiyla anar', () => {
    expect(BRAND.tagline).toContain('Arc')
  })
})
