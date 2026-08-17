import { describe, expect, it } from 'vitest'
import {
  erc20ToNative,
  formatPriceWeiPerToken,
  formatTokenAmount,
  formatTokenCompact,
  formatUsdc,
  formatUsdcCompact,
  formatUsdcQuote,
  nativeToErc20,
  parseUsdcAmount,
  USDC_VIEW_SCALE,
} from '../src/usdc'

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

describe('parseUsdcAmount quantises input to six decimals', () => {
  it('accepts a whole number and scales it to the native view', () => {
    expect(parseUsdcAmount('1')).toEqual({ ok: true, value: 1_000_000_000_000_000_000n })
  })

  it('accepts exactly six decimals -- the finest input the ERC-20 view can echo', () => {
    expect(parseUsdcAmount('0.000001')).toEqual({ ok: true, value: 1_000_000_000_000n })
    expect(parseUsdcAmount('12.161433')).toEqual({ ok: true, value: 12_161_433_000_000_000_000n })
  })

  /**
   * THE QUANTISATION ITSELF. A seventh decimal is REJECTED, not truncated:
   * truncating would sign a transaction for an amount the user did not type
   * and cannot see echoed back.
   *
   * This is also the test that kills `parseUnits(text, 6) -> parseUnits(text,
   * 18)`: under 18 decimals `1.2345678` is a perfectly good input.
   */
  it('rejects a seventh decimal rather than silently truncating it', () => {
    expect(parseUsdcAmount('1.2345678')).toEqual({ ok: false, reason: 'tooManyDecimals' })
    expect(parseUsdcAmount('0.0000001')).toEqual({ ok: false, reason: 'tooManyDecimals' })
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-1', 'negative'],
    ['-0.5', 'negative'],
    ['1e3', 'exponent'],
    ['1E3', 'exponent'],
    ['1,5', 'notANumber'],
    ['NaN', 'notANumber'],
    ['Infinity', 'notANumber'],
    ['0x10', 'notANumber'],
    ['1.2.3', 'notANumber'],
    ['.', 'notANumber'],
    ['+1', 'notANumber'],
  ])('rejects %j with reason %s', (text, reason) => {
    expect(parseUsdcAmount(text)).toEqual({ ok: false, reason })
  })

  it('rejects rather than throws -- a form field shows a message, not a stack', () => {
    for (const bad of ['', '-1', '1e3', '1.2345678', 'NaN']) {
      expect(() => parseUsdcAmount(bad)).not.toThrow()
    }
  })

  it('every accepted value is a whole multiple of the quantum', () => {
    // Derived by hand: the smallest accepted input is 1e12 wei, so no accepted
    // value can ever land inside NetTooSmall's 3-wei ceiling.
    for (const text of ['0', '0.000001', '0.999999', '1', '1000.5', '12.313451']) {
      const parsed = parseUsdcAmount(text)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error('unreachable')
      expect(parsed.value % USDC_VIEW_SCALE).toBe(0n)
    }
  })
})

describe('formatUsdcCompact', () => {
  it('prints the opening market cap of every sanctioned profile as $4.00', () => {
    // LaunchFactory.MIN_OPENING_MARKET_CAP == 4e18, and a fresh curve sits
    // exactly on it: V * supplyConstant / T = 4292e15 * 1e27 / 1073e24.
    expect(formatUsdcCompact(4_000_000_000_000_000_000n)).toBe('$4.00')
  })

  it('prints four significant digits with a suffix above one thousand', () => {
    expect(formatUsdcCompact(57_530_000_000_000_000_000_000_000n)).toBe('$57.53M')
    expect(formatUsdcCompact(4_000_000_000_000_000_000_000n)).toBe('$4.000K')
    expect(formatUsdcCompact(999_900_000_000_000_000_000_000n)).toBe('$999.9K')
    expect(formatUsdcCompact(1_234_000_000_000_000_000_000_000_000n)).toBe('$1.234B')
  })

  it('rounds DOWN -- a market cap is a claim about money that exists', () => {
    expect(formatUsdcCompact(57_539_999_999_999_999_999_999_999n)).toBe('$57.53M')
    expect(formatUsdcCompact(4_009_999_999_999_999_999n)).toBe('$4.00')
  })

  it('crosses the suffix boundary at exactly one thousand', () => {
    expect(formatUsdcCompact(999_999_999_999_999_999_999n)).toBe('$999.99')
    expect(formatUsdcCompact(1_000_000_000_000_000_000_000n)).toBe('$1.000K')
  })
})

describe('formatTokenAmount', () => {
  it('shows a token base amount at six decimals, rounded down', () => {
    // 200_723_953_120_761_740_526_324_105 _tok is 200_723_953.120761... tokens.
    expect(formatTokenAmount(200_723_953_120_761_740_526_324_105n)).toBe('200,723,953.120761')
    expect(formatTokenAmount(0n)).toBe('0.000000')
    expect(formatTokenAmount(1n)).toBe('0.000000')
  })
})

/**
 * The subscript is written as a CODE POINT, not as a literal glyph: a
 * reviewer cannot tell U+2088 from U+2085 at a glance, and the whole point
 * of the expectation is the digit inside it.
 */
const sub = (n: number) => String.fromCodePoint(0x2080 + n)

describe('formatPriceWeiPerToken', () => {
  it('compresses the zero run', () => {
    expect(formatPriceWeiPerToken(4_000_000_000n)).toBe(`0.0${sub(8)}4`)
    expect(formatPriceWeiPerToken(4_000_000_000_000n)).toBe(`0.0${sub(5)}4`)
  })

  it('leaves a short zero run alone', () => {
    // 0.04 USDC per token: writing `0.0<sub>1</sub>4` would be harder to read
    // than the number it replaces.
    expect(formatPriceWeiPerToken(40_000_000_000_000_000n)).toBe('0.04')
  })

  it('falls back to plain six-decimal formatting at or above 1 USDC per token', () => {
    expect(formatPriceWeiPerToken(1_500_000_000_000_000_000n)).toBe('1.500000')
  })

  it('prints zero as zero', () => {
    expect(formatPriceWeiPerToken(0n)).toBe('0')
  })
})

/**
 * ============================================================================
 *  KOTA SATIRLARININ BICIMI -- KULLANICININ SAYDIGI SIFIRLAR
 * ============================================================================
 *
 * Bildirilen iki kusur ayni koktendi: alim panelinin ozet satirlari BAKIYE
 * bicimini kullaniyordu. Bir bakiyede alti ondalik DOGRUDUR -- "tam olarak
 * neye sahibim" sorusunun cevabi budur ve yuvarlamak yalan olurdu. Ama bir
 * KOTA yaklasik bir sayidir; satirin basinda zaten `~` durur ve
 * `~ 11,000,000.000000 LOCKED` okuyan kimse o alti sifirdan bir sey ogrenmez.
 */
describe('formatTokenCompact', () => {
  const TOK = 10n ** 18n

  it('MILYONLARI `M`, BINLERI `K` yapar -- bildirilen iki ornek', () => {
    expect(formatTokenCompact(11_000_000n * TOK)).toBe('11.00M')
    expect(formatTokenCompact(20_000n * TOK)).toBe('20.00K')
  })

  it('DORT ANLAMLI BASAMAK -- `formatUsdcCompact` ile AYNI kural', () => {
    /*
     * Ikinci bir kural yazilsaydi ayni sayfada bir tutar ve bir token adedi
     * farkli cozunurlukte gorunurdu. Nokta soldan sagi izler.
     *
     * YUVARLAMA ASAGI: bu sayi bir KOTA (`You receive ~ X`) ve yukari
     * yuvarlamak, kullaniciya alamayacagi bir adedi vaat etmek olurdu.
     */
    expect(formatTokenCompact(1_234_567n * TOK)).toBe('1.234M')
    expect(formatTokenCompact(11_000_000n * TOK)).toBe('11.00M')
    expect(formatTokenCompact(111_000_000n * TOK)).toBe('111.0M')
    expect(formatUsdcCompact(1_234_567n * 10n ** 18n)).toBe('$1.234M')
  })

  it('BINDEN AZI KISALTILMAZ -- `999` -> `0.99K` okunmaz olurdu', () => {
    expect(formatTokenCompact(999n * TOK)).toBe('999')
    // Milyar da kisalir; bir memecoin arzi buraya kolayca ulasir.
    expect(formatTokenCompact(2_500_000_000n * TOK)).toBe('2.500B')
  })

  it('BIR TOKENDEN AZI KISALTILMAZ -- orada her basamak anlamli', () => {
    /*
     * `0.5` tokeni `0.0K` yapmak, kullanicinin elindeki seyi SIFIR gostermek
     * olurdu. Tam sayi kismi sifirsa tam bicime dusulur.
     */
    expect(formatTokenCompact(TOK / 2n)).toContain('0.5')
  })

  it('NEGATIF BIR TOKEN ADEDI YOKTUR -- sessizce bicimlenmez, ATAR', () => {
    expect(() => formatTokenCompact(-1n)).toThrow(RangeError)
  })
})

describe('formatUsdcQuote', () => {
  const USDC = 10n ** 18n

  it('KOTADA IKI ONDALIK, ve gereksiz sifirlar ATILIR', () => {
    // Bildirilen kusur: `~ 5,000.000000 USDC`.
    expect(formatUsdcQuote(5_000n * USDC, 'up')).toBe('5,000')
    expect(formatUsdcQuote(1_500_000_000_000_000_000n, 'up')).toBe('1.5')
    expect(formatUsdcQuote(1_250_000_000_000_000_000n, 'up')).toBe('1.25')
  })

  it('BIR USDC`DEN AZI ALTI ONDALIK TASIR -- yoksa kucuk kota `0` gorunurdu', () => {
    /*
     * Iki ondalik bir esik degil bir OLCEK secimi: 0.004 USDC`lik bir satis
     * `0.00` yazsaydi kullanici hicbir sey almadigini sanirdi. USDC zaten alti
     * ondalikli; kuculdukce cozunurluk artar.
     */
    expect(formatUsdcQuote(4_000_000_000_000_000n, 'down')).toBe('0.004')
    expect(formatUsdcQuote(0n, 'down')).toBe('0')
  })

  it('YUVARLAMA YONU CAGIRANIN -- odenen YUKARI, alinan ASAGI', () => {
    /*
     * Ikisini ayni yone yuvarlamak, kullanicinin lehine gorunen ama tutmayan
     * bir sayi uretir. `You pay` yukari, `You receive` asagi.
     */
    const awkward = 1_234_567_800_000_000_000n
    expect(formatUsdcQuote(awkward, 'up')).toBe('1.24')
    expect(formatUsdcQuote(awkward, 'down')).toBe('1.23')
  })

  it('NEGATIF BIR KOTA YOKTUR -- ATAR', () => {
    expect(() => formatUsdcQuote(-1n, 'up')).toThrow(RangeError)
  })
})
