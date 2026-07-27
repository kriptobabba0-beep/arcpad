import { describe, expect, it } from 'vitest'
import { erc20ToNative, formatUsdc, nativeToErc20 } from '../src/usdc'

describe('USDC iki gorunum arasinda donusum', () => {
  it('18 decimal native degeri 6 decimal ERC-20 gorunumune indirir', () => {
    // 1 USDC = 1e18 native = 1e6 ERC-20
    expect(nativeToErc20(1_000_000_000_000_000_000n)).toBe(1_000_000n)
  })

  it('mikro-USDC altindaki kalintiyi asagi yuvarlar, yukari degil', () => {
    // 1.9999995 mikro-USDC: ERC-20 gorunumu 1 mikro-USDC gormelidir.
    expect(nativeToErc20(1_999_999_500_000n)).toBe(1n)
  })

  it('6 decimal ERC-20 degeri kayipsiz sekilde native gorunume cikarir', () => {
    expect(erc20ToNative(1_000_000n)).toBe(1_000_000_000_000_000_000n)
  })

  it('gidis-donus asla deger yaratmaz', () => {
    const native = 1_234_567_891_234_567_891n
    expect(erc20ToNative(nativeToErc20(native))).toBeLessThanOrEqual(native)
  })

  it('sifiri sifir olarak korur', () => {
    expect(nativeToErc20(0n)).toBe(0n)
    expect(erc20ToNative(0n)).toBe(0n)
  })

  it('negatif native degeri reddeder', () => {
    // Arc'ta bir bakiye asla negatif olamaz. BigInt bolme sifira dogru
    // keser (asagiya degil), yani negatif girdide sessizce yanlis
    // yuvarlamak yerine acikca hata firlatilmalidir.
    expect(() => nativeToErc20(-1n)).toThrow(RangeError)
  })
})

describe('formatUsdc', () => {
  it('locale bagimsiz olarak nokta ondalik kullanir', () => {
    // Makinenin locale'i tr-TR olsa bile virgul ondalik URETMEMELI.
    expect(formatUsdc(1_234_500_000_000_000_000_000n)).toBe('1,234.50')
  })

  it('varsayilan olarak iki ondalik basamak gosterir', () => {
    expect(formatUsdc(1_000_000_000_000_000_000n)).toBe('1.00')
  })

  it('istendiginde daha fazla ondalik basamak gosterir', () => {
    // 1.5e12 native = 0.0000015 USDC; 7 basamak istenmezse yuvarlanir.
    expect(formatUsdc(1_500_000_000_000n, { maxFractionDigits: 7 })).toBe('0.0000015')
  })

  it('kesir kismi ~15 anlamli basamaktan sonra hassasiyet kaybedebilir (dokumante sinir)', () => {
    // native = 1 USDC + en kucuk native birim (1e-18 USDC). Kesir Number'a
    // cevrilirken IEEE-754 double hassasiyeti (~15-17 anlamli basamak)
    // asilir: 1'e eklenen 1e-18 buyuklugu double toplaminda kaybolur ve
    // deger tam 1 olarak yuvarlanir. formatUsdc goruntuleme icindir; zincir
    // uzeri muhasebe bu fonksiyona dayanmamalidir.
    expect(formatUsdc(1_000_000_000_000_000_001n, { maxFractionDigits: 18 })).toBe('1.00')
  })
})
