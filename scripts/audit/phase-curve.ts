/**
 * ============================================================================
 *  FAZ B -- EGRI: PLANLAYICI ILE ZINCIR ARASINDA DIFERANSIYEL
 * ============================================================================
 *
 * ============ NEDEN KENDI FORMULUMU YAZMIYORUM ============
 *
 * Ilk surum egri matematigini bu dosyaya YENIDEN PORTLADI ve uc vakada
 * kirmizi verdi. Ucu de BENIM modelimin hatasiydi: `feeOn` TAVANA yuvarlar
 * (tabana degil), `buyExactQuoteIn` INCLUSIVE ayrisim kullanir
 * (`correctedNetQuoteIn`), ve cikti formulu `net - 1`'i pay ve paydanin
 * IKISINDE birden tasir. Yani ucuncu bir port yazmak, dogrulanacak seyi
 * dogrulayanin kendisi yapmak olurdu.
 *
 * Bu surum bunun yerine `@arcpad/shared`in PLANLAYICISINI kullanir -- yani
 * ARAYUZUN kullandigi kodun ta kendisini. Iddia boylece cok daha degerli hale
 * gelir:
 *
 *     "Kullaniciya gosterilen sayi, zincirin verdigi sayidir."
 *
 * Bu ayrisirsa arayuz kullaniciya yalan soyluyor demektir, ve bu tam olarak
 * bir launchpad'de en pahali sessiz hatadir. Diferansiyel test iki
 * implementasyonu birbirine karsi tutar; iki kopya ayni yanlisi yapmadikca
 * hata gorunur.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import { bondingCurveAbi, feeEscrowAbi, launchTokenAbi } from '../../packages/shared/src/abi/index'
import {
  asTok,
  asWei,
  planBuyExactQuoteIn,
  planBuyExactTokensOut,
  planSellExactTokensIn,
  type CurveState,
  type FeeBps,
} from '../../packages/shared/src/trade'
import { book, type Campaign, must, mustEqual, read, send } from './harness'

const CURVE_ABI = bondingCurveAbi as unknown as Abi
const TOKEN_ABI = launchTokenAbi as unknown as Abi
const ESCROW_ABI = feeEscrowAbi as unknown as Abi

/** Zincirden OKUNUR, sabitten degil: bir gun degisirse test degil KOD kirilmali. */
async function feeBps(pub: PublicClient, curve: Address): Promise<FeeBps> {
  const [p, c] = await Promise.all([
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'PROTOCOL_FEE_BPS' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'CREATOR_FEE_BPS' }),
  ])
  return { protocolFeeBps: p, creatorFeeBps: c }
}

export async function curveState(pub: PublicClient, curve: Address): Promise<CurveState> {
  const [vt, vq, rt, rq, complete, creator] = await Promise.all([
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'virtualTokenReserves' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'virtualQuoteReserves' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'realTokenReserves' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'realQuoteReserves' }),
    read<boolean>(pub, { address: curve, abi: CURVE_ABI, functionName: 'complete' }),
    read<Address>(pub, { address: curve, abi: CURVE_ABI, functionName: 'creator' }),
  ])
  return {
    virtualTokenReserves: vt,
    virtualQuoteReserves: vq,
    realTokenReserves: asTok(rt),
    realQuoteReserves: asWei(rq),
    complete,
    creator,
  }
}

const profileOf = (b: ReturnType<typeof book>) => ({
  virtualTokenReserves: BigInt(b.virtualTokenReserves),
  virtualQuoteReserves: BigInt(b.virtualQuoteReserves),
  saleSupply: asTok(BigInt(b.saleSupply)),
  totalSupply: asTok(BigInt(b.totalSupply)),
})

export async function phaseCurve(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  token: Address,
  curve: Address,
): Promise<void> {
  c.phase('FAZ B -- egri: planlayici <-> zincir diferansiyeli')
  const b = book()
  const profile = profileOf(b)
  const fees = await feeBps(pub, curve)
  const me = w.account!.address

  const held = async (): Promise<bigint> =>
    read<bigint>(pub, { address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [me] })

  // ------------------------------------------------------------------
  // B1. ALIS -- planlayicinin sozu, zincirin verdigi
  // ------------------------------------------------------------------
  await c.check('B1 buyExactQuoteIn: plan == zincir (token, ucret, rezerv)', async () => {
    const state = await curveState(pub, curve)
    const gross = 500_000_000_000_000_000n // 0,5 USDC
    const plan = planBuyExactQuoteIn(state, profile, fees, gross, 0)

    const before = await held()
    await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [plan.args[0]],
      value: gross,
    })
    const after = await held()
    mustEqual(after - before, plan.tokens, 'alinan token')

    const post = await curveState(pub, curve)
    mustEqual(post.virtualQuoteReserves - state.virtualQuoteReserves, plan.curveAmount, 'vQ artisi')
    mustEqual(state.virtualTokenReserves - post.virtualTokenReserves, plan.tokens, 'vT azalisi')
    mustEqual(post.realQuoteReserves - state.realQuoteReserves, plan.curveAmount, 'rQ artisi')
    return `${plan.tokens} token, curveIn ${plan.curveAmount}`
  })

  // ------------------------------------------------------------------
  // B2. UCRET -- ESCROW'DA olculur, iki pay AYRI
  // ------------------------------------------------------------------
  //
  // Toplamdan bolen bir kontrat "toplam dogru" testinden gecerdi; iki payi
  // ayri okumak o yolu kapatir. `feeOn(x,95) + feeOn(x,30)` != `feeOn(x,125)`
  // ve fark her seferinde protokolun aleyhinedir -- kontrat bunu ismiyle
  // yaziyor.
  await c.check('B2 ucret: iki pay AYRI, planla birebir', async () => {
    const escrow = b.feeEscrow
    const treasury = b.protocolTreasury
    const owed = async (who: Address): Promise<bigint> =>
      read<bigint>(pub, { address: escrow, abi: ESCROW_ABI, functionName: 'owed', args: [who] })

    const state = await curveState(pub, curve)
    const gross = 300_000_000_000_000_000n
    const plan = planBuyExactQuoteIn(state, profile, fees, gross, 0)
    const pBefore = await owed(treasury)
    const cBefore = await owed(me)

    await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [plan.args[0]],
      value: gross,
    })

    mustEqual((await owed(treasury)) - pBefore, plan.protocolFee, 'protokol payi')
    mustEqual((await owed(me)) - cBefore, plan.creatorFee, 'creator payi')
    // INCLUSIVE SOZLESME: net + iki ucret, butceyi ASAMAZ ve en fazla 1 eksik
    // kalir. Bu bir esitlik degil bir ESITSIZLIK iddiasidir -- kontratin
    // NatSpec'i olculmus haliyle boyle diyor (%99,95 esit, kalaninda 1 eksik).
    const spent = plan.curveAmount + plan.protocolFee + plan.creatorFee
    must(spent <= gross, `net+ucret butceyi ASTI: ${spent} > ${gross}`)
    must(gross - spent <= 1n, `iade 1 weiden BUYUK: ${gross - spent}`)
    return `protokol ${plan.protocolFee}, creator ${plan.creatorFee}, iade ${gross - spent}`
  })

  // ------------------------------------------------------------------
  // B3. SATIS -- ucret CIKTIDAN kesilir
  // ------------------------------------------------------------------
  await c.check('B3 sellExactTokensIn: plan == zincir (net odeme)', async () => {
    const bal = await held()
    must(bal > 0n, 'satacak token yok')
    const tokensIn = bal / 4n
    const state = await curveState(pub, curve)
    const plan = planSellExactTokensIn(state, profile, fees, asTok(tokensIn), 0)

    await send(pub, w, {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'approve',
      args: [curve, tokensIn],
    })
    const nativeBefore = await pub.getBalance({ address: me })
    const receipt = await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'sellExactTokensIn',
      args: [tokensIn, plan.args[1] ?? 0n],
    })
    const nativeAfter = await pub.getBalance({ address: me })
    const net = nativeAfter - nativeBefore + receipt.feeWei
    const expectedNet = plan.curveAmount - plan.protocolFee - plan.creatorFee
    mustEqual(net, expectedNet, 'net odenen')
    return `net ${net}`
  })

  // ------------------------------------------------------------------
  // B4. TAM MIKTAR ALIMI -- exclusive sozlesme ve IADE
  // ------------------------------------------------------------------
  await c.check('B4 buyExactTokensOut: plan == zincir, fazlalik IADE', async () => {
    const state = await curveState(pub, curve)
    const want = asTok(1_000_000n * 10n ** 18n)
    const plan = planBuyExactTokensOut(state, profile, fees, want, 0)
    const overpay = plan.value + 200_000_000_000_000_000n

    const before = await held()
    const nativeBefore = await pub.getBalance({ address: me })
    const receipt = await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactTokensOut',
      args: [want, plan.args[1] ?? plan.value],
      value: overpay,
    })
    const nativeAfter = await pub.getBalance({ address: me })
    const spent = nativeBefore - nativeAfter - receipt.feeWei

    mustEqual((await held()) - before, want, 'alinan token TAM istenen')
    // Harcanan, planin `curveAmount + ucretler`i olmali; gerisi IADE.
    mustEqual(spent, plan.curveAmount + plan.protocolFee + plan.creatorFee, 'harcanan')
    return `harcanan ${spent}, iade ${overpay - spent}`
  })

  // ------------------------------------------------------------------
  // B5-B8. KORUMALAR
  // ------------------------------------------------------------------
  await c.expectRevert('B5 alista slipaj korumasi SlippageExceeded', 'SlippageExceeded', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [10n ** 30n],
      value: 100_000_000_000_000_000n,
    }),
  )

  await c.expectRevert('B6 sifir degerli alis ZeroQuoteIn', 'ZeroQuoteIn', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: 0n,
    }),
  )

  await c.expectRevert('B7 sifir token satisi ZeroTokensIn', 'ZeroTokensIn', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'sellExactTokensIn',
      args: [0n, 0n],
    }),
  )

  await c.expectRevert('B8 sifir token alimi ZeroTokensOut', 'ZeroTokensOut', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactTokensOut',
      args: [0n, 10n ** 18n],
      value: 10n ** 18n,
    }),
  )

  await c.expectRevert('B9 maxQuoteIn yetmezse SlippageExceeded', 'SlippageExceeded', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactTokensOut',
      args: [1_000_000n * 10n ** 18n, 1n],
      value: 10n ** 18n,
    }),
  )

  // ------------------------------------------------------------------
  // B10. COK KUCUK BUTCE -- para odeyip HICBIR SEY ALMAMAK yasak
  // ------------------------------------------------------------------
  //
  // `NetTooSmall` arcpad'in KARARIDIR, pump.fun'da dogrulanmis bir davranis
  // degil. Onsuz 1-2 wei'lik bir alim sifir token dondururdu.
  await c.expectRevert('B10 iki wei alis NetTooSmall', 'NetTooSmall', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: 2n,
    }),
  )

  // ------------------------------------------------------------------
  // B11. BAKIYEDEN FAZLA SATIS
  // ------------------------------------------------------------------
  await c.check('B11 bakiyeden fazla satis DUSER', async () => {
    const bal = await held()
    const tooMuch = bal + 10n ** 18n
    await send(pub, w, {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'approve',
      args: [curve, tooMuch],
    })
    let reverted = false
    try {
      await send(pub, w, {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'sellExactTokensIn',
        args: [tooMuch, 0n],
      })
    } catch {
      reverted = true
    }
    must(reverted, 'bakiyeden fazla satis GECTI')
    return 'reddedildi'
  })

  // ------------------------------------------------------------------
  // B12. SABIT CARPIM ASLA KUCULMEZ
  // ------------------------------------------------------------------
  //
  // Bir ESITLIK degil bir ESITSIZLIK: tabana yuvarlama `k`yi her islemde bir
  // miktar BUYUTUR. Onemli olan yonudur -- kuculen bir `k` egriden deger
  // sizdirir, ve butun yuvarlama yonleri tam olarak bunu engellemek icin
  // secilmistir.
  await c.check('B12 sabit carpim k asla KUCULMEZ', async () => {
    const before = await curveState(pub, curve)
    const kBefore = before.virtualTokenReserves * before.virtualQuoteReserves
    await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: 123_456_789_012_345_678n,
    })
    const after = await curveState(pub, curve)
    const kAfter = after.virtualTokenReserves * after.virtualQuoteReserves
    must(kAfter >= kBefore, `k KUCULDU: ${kBefore} -> ${kAfter}`)
    return `k +${kAfter - kBefore}`
  })

  // ------------------------------------------------------------------
  // B13. STRES: YUZ ISLEM, HER BIRINDE PLAN == ZINCIR
  // ------------------------------------------------------------------
  //
  // Tek bir islemin dogru olmasi, YUZUNCUSUNUN de dogru olacagini soylemez:
  // rezervler her islemle kayar ve yuvarlama hatalari BIRIKIR. Bu dongu tam
  // olarak birikimi arar -- her adimda planlayici ile zinciri yeniden
  // karsilastirir ve ilk ayrismada durur.
  await c.check('B13 stres: 40 alis/satis, her adimda plan == zincir', async () => {
    let steps = 0
    for (let i = 0; i < 40; i += 1) {
      const state = await curveState(pub, curve)
      if (state.complete) break
      const buy = i % 3 !== 2
      if (buy) {
        // Miktar her adimda DEGISIR: sabit bir miktar ayni yuvarlama
        // kalintisini tekrarlar ve birikimi gizlerdi.
        const gross = 10_000_000_000_000_000n + BigInt(i) * 1_234_567_890_123n
        const plan = planBuyExactQuoteIn(state, profile, fees, gross, 0)
        const before = await held()
        await send(pub, w, {
          address: curve,
          abi: CURVE_ABI,
          functionName: 'buyExactQuoteIn',
          args: [plan.args[0]],
          value: gross,
        })
        mustEqual((await held()) - before, plan.tokens, `adim ${i} alis token`)
      } else {
        const bal = await held()
        if (bal === 0n) continue
        const tokensIn = bal / 10n
        if (tokensIn === 0n) continue
        const plan = planSellExactTokensIn(state, profile, fees, asTok(tokensIn), 0)
        await send(pub, w, {
          address: token,
          abi: TOKEN_ABI,
          functionName: 'approve',
          args: [curve, tokensIn],
        })
        const nativeBefore = await pub.getBalance({ address: me })
        const receipt = await send(pub, w, {
          address: curve,
          abi: CURVE_ABI,
          functionName: 'sellExactTokensIn',
          args: [tokensIn, plan.args[1] ?? 0n],
        })
        const nativeAfter = await pub.getBalance({ address: me })
        const net = nativeAfter - nativeBefore + receipt.feeWei
        mustEqual(net, plan.curveAmount - plan.protocolFee - plan.creatorFee, `adim ${i} satis net`)
      }
      steps += 1
    }
    return `${steps} islem, sapma YOK`
  })
}
