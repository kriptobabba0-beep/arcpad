import { ARCPAD_ERROR_ABI, formatTokenAmount } from '@arcpad/shared/browser'
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, HttpRequestError } from 'viem'
import { InsufficientFundsError, UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  readFailure,
  resolveCellCopy,
  stillPendingFailure,
  wrongNetworkFailure,
} from '@/components/errors/failureCopy'
import { ERROR_SURFACE, REACHABLE_BY_ACTION } from '@/components/errors/reachableErrors'
import { type ArcpadAction, decodeArcpadError } from '@/lib/decodeRevert'
import { ARCPAD_ACTIONS } from '@/lib/failureTable'

/**
 * IKI BOYUTLU TAMLIK: HER EYLEM x HER ULASILABILIR HATA BIR METNE SAHIP.
 *
 * "Bir yolda kapatilan ozellik hepsinde kapatilmis gorunur" hatasinin
 * panzehiri tam olarak budur. Curve'un UC giris noktasi var ve `CurveComplete`
 * ucunde UC AYRI cumle demektir; tek satirlik bir sozluk tam gorunurken
 * yuzeyin ucte birini kapatir.
 */

function revertedWith(errorName: string, args: readonly unknown[] = []): unknown {
  const data = encodeErrorResult({
    abi: ARCPAD_ERROR_ABI,
    errorName,
    ...(args.length > 0 ? { args } : {}),
  } as Parameters<typeof encodeErrorResult>[0])
  const inner = new ContractFunctionRevertedError({
    abi: ARCPAD_ERROR_ABI,
    data,
    functionName: 'buyExactQuoteIn',
  })
  const outer = new BaseError('The contract function reverted.')
  ;(outer as { cause?: unknown }).cause = inner
  return outer
}

const SYMBOL = 'DIFF'

describe('every cell on the surface has text', () => {
  it('every action x surface cell has a title AND a remedy', () => {
    let cells = 0
    for (const action of ARCPAD_ACTIONS) {
      for (const name of Object.keys(ERROR_SURFACE[action])) {
        const copy = resolveCellCopy(action, name)
        expect(copy, `${action} x ${name} has no copy`).toBeDefined()
        expect(copy?.title.length, `${action} x ${name} has no title`).toBeGreaterThan(0)
        expect(copy?.body.length, `${action} x ${name} has no body`).toBeGreaterThan(0)
        expect(copy?.remedy ?? '', `${action} x ${name} has no remedy`).not.toBe('')
        cells += 1
      }
    }
    // 50 -> 51: `launch:BuybackUnavailable`. Metni ELLE yazildi ve
    // `remedy` alani bos DEGIL -- kullanicinin cikisi var: kutuyu kaldir.
    expect(cells).toBe(51) // anti-vacuity
  })

  it('a reachable cell never falls back to the operator sentence', () => {
    // Operator metni ADI yazar ve "sizin yaptiginiz seyle ilgisi yok" der.
    // Ulasilabilir bir hataya onu vermek, kullaniciya carenin kendisinde
    // olmadigini soylemek olur.
    for (const action of ARCPAD_ACTIONS) {
      for (const name of REACHABLE_BY_ACTION[action]) {
        const copy = resolveCellCopy(action, name)
        expect(copy?.title, `${action} x ${name} got the operator fallback`).not.toMatch(
          /is misconfigured\.$/,
        )
      }
    }
  })

  it('CurveComplete says three different things on the three entrypoints', () => {
    const titles = (['buyExactQuoteIn', 'buyExactTokensOut', 'sellExactTokensIn'] as const).map(
      (action) => resolveCellCopy(action, 'CurveComplete')?.title,
    )
    expect(titles.every((title) => (title?.length ?? 0) > 0)).toBe(true)
    // Satis kapanmasi bir "sold out" degildir: satici zaten token tutuyor.
    expect(titles[2]).not.toBe(titles[0])
  })

  it('the two library-layer refusals are NOT the empty-input text', () => {
    // `NetTooSmall` ve `ProceedsTooSmall` GECERLI girdilerdir; sonuc yetersiz.
    // Onlari "Enter an amount." ile birlestirmek kullaniciya zaten yazdigi
    // seyi yazmasini soyler.
    const zeroIn = resolveCellCopy('buyExactQuoteIn', 'ZeroQuoteIn')?.title
    const netTooSmall = resolveCellCopy('buyExactQuoteIn', 'NetTooSmall')?.title
    const zeroTokensIn = resolveCellCopy('sellExactTokensIn', 'ZeroTokensIn')?.title
    const proceeds = resolveCellCopy('sellExactTokensIn', 'ProceedsTooSmall')?.title
    expect(netTooSmall).not.toBe(zeroIn)
    expect(proceeds).not.toBe(zeroTokensIn)
    expect(netTooSmall).toMatch(/too small to buy/i)
    expect(proceeds).toMatch(/too small to return any USDC after fees/i)
  })
})

describe('the copy writes the numbers it was given', () => {
  it('NotEnoughTokensToBuy names the remaining reserve and the other entrypoint', () => {
    const remaining = 1_234_500_000_000_000_000_000n
    const copy = resolveCellCopy('buyExactTokensOut', 'NotEnoughTokensToBuy', undefined, {
      symbol: SYMBOL,
      realTokenReservesTok: remaining,
    })
    expect(copy?.title).toContain(formatTokenAmount(remaining))
    expect(copy?.title).toContain(SYMBOL)
    expect(`${copy?.title} ${copy?.remedy}`).toMatch(/Spend USDC/)
    // ...ve bu, genel slipaj metni DEGILDIR.
    expect(copy?.title).not.toMatch(/slippage/i)
  })

  it('SlippageExceeded has TWO reasons on buyExactTokensOut, told apart locally', () => {
    // Kontrat `total > maxQuoteIn || total > msg.value` der ve TEK selector
    // doner. Arayuz iki degeri de bildigi icin ayirir.
    const priceMoved = resolveCellCopy('buyExactTokensOut', 'SlippageExceeded', undefined, {
      maxQuoteInWei: 10n ** 18n,
      sentValueWei: 10n ** 18n,
    })
    const shortValue = resolveCellCopy('buyExactTokensOut', 'SlippageExceeded', undefined, {
      maxQuoteInWei: 10n ** 18n,
      sentValueWei: 10n ** 17n,
    })
    expect(priceMoved?.title).toMatch(/slippage limit/i)
    expect(shortValue?.title).toMatch(/did not send enough USDC/i)
    expect(shortValue?.title).not.toBe(priceMoved?.title)
    // Ve tekrar denemenin anlami farkli: eksik deger toleransla duzelmez.
    expect(priceMoved?.retryable).toBe(true)
    expect(shortValue?.retryable).toBe(false)
  })

  it('ERC20InsufficientAllowance writes the SHORTFALL, not the requirement', () => {
    const allowance = 1_000_000_000_000_000_000n
    const needed = 3_000_000_000_000_000_000n
    const copy = resolveCellCopy(
      'sellExactTokensIn',
      'ERC20InsufficientAllowance',
      ['0x00000000000000000000000000000000000000aa', allowance, needed],
      { symbol: SYMBOL },
    )
    expect(copy?.title).toContain(formatTokenAmount(needed - allowance))
    expect(copy?.title).not.toContain(formatTokenAmount(needed))
    expect(copy?.title).toContain(SYMBOL)
  })

  it('ERC20InsufficientBalance writes what the seller actually holds', () => {
    const balance = 42_000_000_000_000_000_000n
    const copy = resolveCellCopy(
      'sellExactTokensIn',
      'ERC20InsufficientBalance',
      ['0x00000000000000000000000000000000000000aa', balance, balance * 2n],
      { symbol: SYMBOL },
    )
    expect(copy?.title).toContain(formatTokenAmount(balance))
  })

  it('a parameterised error without its arguments still says something useful', () => {
    const copy = resolveCellCopy('sellExactTokensIn', 'ERC20InsufficientAllowance')
    expect(copy?.title.length).toBeGreaterThan(0)
    expect(copy?.remedy).toMatch(/approve/i)
  })
})

describe('failures that are not reverts are first-class', () => {
  it('a user rejection is NOT shown as an error', () => {
    const failure = readFailure(
      decodeArcpadError(new UserRejectedRequestError(new Error('denied')), {
        action: 'buyExactQuoteIn',
      }),
    )
    expect(failure.tone).toBe('neutral')
    expect(failure.title).toBe('Cancelled.')
    expect(failure.title).not.toMatch(/error|failed|refused|wrong/i)
    expect(failure.retryable).toBe(false)
    // Girdiler korunur ve metin bunu SOYLER.
    expect(failure.remedy).toMatch(/still here/i)
  })

  it('insufficient funds names the trade and the gas as TWO figures', () => {
    const failure = readFailure(
      decodeArcpadError(new InsufficientFundsError({ cause: new BaseError('x') }), {
        action: 'buyExactQuoteIn',
      }),
      { tradeAmountWei: 5n * 10n ** 18n, gasReserveWei: 10n ** 15n },
    )
    expect(failure.body).toMatch(/5(\.0+)? USDC/)
    expect(failure.body).toMatch(/for gas/)
    expect(failure.body).toMatch(/same balance on Arc/)
  })

  it('an Arc zero-address string revert is not an unknown error', () => {
    const failure = readFailure(
      decodeArcpadError(new Error('execution reverted: Zero address not allowed'), {
        action: 'launch',
      }),
    )
    expect(failure.title).toMatch(/zero address/i)
    expect(failure.title).not.toMatch(/something went wrong/i)
  })

  it('an Arc runtime blocklist refusal gets its own sentence', () => {
    const failure = readFailure(
      decodeArcpadError(new Error('execution reverted: sender is blocked'), {
        action: 'buyExactQuoteIn',
      }),
    )
    expect(failure.title).toMatch(/rejected by the network/i)
  })

  it('an empty revert does NOT guess a cause', () => {
    const inner = new ContractFunctionRevertedError({
      abi: ARCPAD_ERROR_ABI,
      data: '0x',
      functionName: 'launch',
    })
    const failure = readFailure(decodeArcpadError(inner, { action: 'launch' }))
    expect(failure.title).toBe('The transaction was rejected on-chain without a reason.')
    expect(failure.body).toMatch(/does not guess/i)
  })

  it('a transport failure is retryable and says so', () => {
    const failure = readFailure(
      decodeArcpadError(new HttpRequestError({ url: 'https://rpc.example', status: 503 }), {
        action: 'sellExactTokensIn',
      }),
    )
    expect(failure.retryable).toBe(true)
    expect(failure.tone).toBe('warn')
  })

  it('the unknown branch is never silent: raw kept, copy offered', () => {
    const weird = { nobody: 'expected this' }
    const failure = readFailure(decodeArcpadError(weird, { action: 'approve' }))
    expect(failure.name).toBe('Unknown')
    expect(failure.showRaw).toBe(true)
    expect(failure.raw).toBe(weird)
    expect(failure.remedy).toMatch(/copy/i)
  })

  it('a missing receipt is PENDING, never failed', () => {
    // Arc'ta finality ~350 ms olculdu; makbuzun gelmemesi neredeyse her zaman
    // RPC tarafidir. "Basarisiz" demek ayni islemi ikinci kez yaptirtir.
    const failure = stillPendingFailure('buyExactQuoteIn')
    expect(failure.title).toBe('Still pending.')
    expect(failure.title).not.toMatch(/fail/i)
    expect(failure.remedy).toMatch(/ArcScan/)
  })

  it('the wrong network is a switch, not a lecture', () => {
    const failure = wrongNetworkFailure('Arc Testnet', 'launch')
    expect(failure.name).toBe('WrongNetwork')
    expect(failure.remedy).toMatch(/Switch to Arc Testnet/)
  })
})

describe('a decoded revert reaches its cell copy end to end', () => {
  it.each<[ArcpadAction, string, RegExp]>([
    ['buyExactQuoteIn', 'CurveComplete', /sold out/i],
    ['buyExactQuoteIn', 'NetTooSmall', /too small to buy/i],
    ['buyExactTokensOut', 'NotEnoughTokensToBuy', /curve/i],
    ['sellExactTokensIn', 'ProceedsTooSmall', /after fees/i],
    ['sellExactTokensIn', 'PayoutFailed', /could not receive USDC/i],
    ['claim', 'NothingToClaim', /nothing to claim/i],
  ])('%s + %s reads as real copy', (action, name, pattern) => {
    const failure = readFailure(decodeArcpadError(revertedWith(name), { action }))
    expect(failure.name).toBe(name)
    expect(failure.title).toMatch(pattern)
    expect(failure.remedy.length).toBeGreaterThan(0)
  })

  it('an error with no cell for THIS action names itself instead of vanishing', () => {
    const failure = readFailure(
      decodeArcpadError(revertedWith('NothingToClaim'), { action: 'sellExactTokensIn' }),
    )
    expect(failure.body).toContain('NothingToClaim()')
    expect(failure.title).toMatch(/misconfigured/i)
  })
})
