/**
 * ============================================================================
 *  FAZ H -- STRES VE OLASILIK: RASTGELE BIR ISLEM DIZISI, HER ADIMDA OLCULEN
 * ============================================================================
 *
 * FAZ B'DEN FARKI, VE NEDEN IKISI DE GEREKLI.
 *
 * Faz B **secilmis** islemleri planlayiciya karsi tutar: bir alim, bir satim,
 * bir sinir degeri. Iddiasi "bu islem dogru hesaplaniyor"dur ve o iddia
 * DEGERLIDIR -- ama tek bir islem hakkindadir.
 *
 * Bu faz **rastgele bir DIZI** kosar ve iddiasi baskadir: "yuzlerce islemden
 * sonra da zincir ile model AYNI yerde duruyor". Aradaki fark birikimli
 * hatadir -- her adimda bir wei'lik bir yuvarlama sapmasi, kirk adim sonra
 * gorunur bir sapmadir ve TEK islemlik hicbir test onu goremez.
 *
 * Ayrica her adimda DORT DEGISMEZ olculur (asagida). Bir invariant suite'i
 * bunlari zaten simule ediyor; burada olculen sey GERCEK ZINCIRDIR -- gercek
 * gaz, gercek `msg.value`, gercek `block.timestamp`, ve Arc'in kendi
 * 10^12'lik iki-gorunum sinirinin altinda.
 *
 * ============ TOHUM SABITTIR VE RAPORA YAZILIR ============
 *
 * `ARC_STRESS_SEED` verilmezse zamandan turetilir, ama HER ZAMAN basilir.
 * Kirmizi bir kosunun yeniden uretilemez olmasi, o kosuyu bir gozlem degil bir
 * hikaye yapardi.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import { bondingCurveAbi, feeEscrowAbi, launchTokenAbi } from '../../packages/shared/src/abi/index'
import {
  asTok,
  asWei,
  planBuyExactQuoteIn,
  planSellExactTokensIn,
  type CurveState,
  type FeeBps,
} from '../../packages/shared/src/trade'
import { book, type Campaign, read, send } from './harness'

const CURVE_ABI = bondingCurveAbi as unknown as Abi
const TOKEN_ABI = launchTokenAbi as unknown as Abi
const ESCROW_ABI = feeEscrowAbi as unknown as Abi

/** Kacinci adimda bir tam durum karsilastirmasi yapilir. */
const CYCLES = Number(process.env['ARC_STRESS_CYCLES'] ?? 24)

/**
 * `mulberry32` -- otuz iki bitlik, tohumlanabilir, BAGIMLILIKSIZ.
 *
 * `Math.random()` KULLANILMAZ: tohumlanamaz, dolayisiyla kirmizi bir kosu
 * yeniden uretilemez. Kriptografik olmasi gerekmiyor; gereken tek sey ayni
 * tohumun ayni diziyi vermesi.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function feeBps(pub: PublicClient, curve: Address): Promise<FeeBps> {
  const [p, c] = await Promise.all([
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'PROTOCOL_FEE_BPS' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'CREATOR_FEE_BPS' }),
  ])
  return { protocolFeeBps: p, creatorFeeBps: c }
}

type Snapshot = {
  state: CurveState
  /** Egrinin ZINCIRDEKI native bakiyesi. `realQuoteReserves` ile karsilastirilir. */
  balanceWei: bigint
  tokenBalance: bigint
  protocolOwed: bigint
  creatorOwed: bigint
}

async function snapshot(
  pub: PublicClient,
  curve: Address,
  token: Address,
  who: Address,
  creator: Address,
): Promise<Snapshot> {
  const b = book()
  const [vt, vq, rt, rq, complete, bal, tok, pOwed, cOwed] = await Promise.all([
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'virtualTokenReserves' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'virtualQuoteReserves' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'realTokenReserves' }),
    read<bigint>(pub, { address: curve, abi: CURVE_ABI, functionName: 'realQuoteReserves' }),
    read<boolean>(pub, { address: curve, abi: CURVE_ABI, functionName: 'complete' }),
    pub.getBalance({ address: curve }),
    read<bigint>(pub, { address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] }),
    read<bigint>(pub, {
      address: b.feeEscrow,
      abi: ESCROW_ABI,
      functionName: 'owed',
      args: [b.protocolTreasury],
    }),
    read<bigint>(pub, {
      address: b.feeEscrow,
      abi: ESCROW_ABI,
      functionName: 'owed',
      args: [creator],
    }),
  ])
  return {
    state: {
      virtualTokenReserves: vt,
      virtualQuoteReserves: vq,
      realTokenReserves: asTok(rt),
      realQuoteReserves: asWei(rq),
      complete,
      creator,
    },
    balanceWei: bal,
    tokenBalance: tok,
    protocolOwed: pOwed,
    creatorOwed: cOwed,
  }
}

function must(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}

/**
 * HER ADIMDAN SONRA KOSAN DORT DEGISMEZ.
 *
 * Bunlar "islem dogru hesaplandi mi" DEGIL, "sistem hala tutarli mi"
 * sorusudur -- ve ikisi ayri seylerdir: dogru hesaplanmis bir islem dizisi de
 * defteri kaydirabilir.
 */
function assertInvariants(before: Snapshot, after: Snapshot, buying: boolean): void {
  // 1. ODEME GUCU. Egri, `realQuoteReserves` kadarini HER ZAMAN odeyebilmeli.
  //    `>=`, `==` DEGIL: Arc'ta ucuncu bir taraf egrinin bakiyesini hicbir kod
  //    calistirmadan sisirebilir (tek bakiye, iki gorunum).
  must(
    after.balanceWei >= after.state.realQuoteReserves,
    `odeme gucu dustu: bakiye ${after.balanceWei} < realQuote ${after.state.realQuoteReserves}`,
  )

  // 2. UCRET DEFTERI GERI GITMEZ. Escrow'da borc yalnizca ARTAR (ya da bir
  //    `claim` ile sifirlanir; bu faz claim CAGIRMAZ, yani burada yalnizca
  //    artabilir).
  must(
    after.protocolOwed >= before.protocolOwed && after.creatorOwed >= before.creatorOwed,
    `escrow defteri geri gitti: p ${before.protocolOwed}->${after.protocolOwed}, c ${before.creatorOwed}->${after.creatorOwed}`,
  )

  // 3. YON. Alim quote'u artirir ve token rezervini azaltir; satim tersi.
  //    Sanal rezervler de ayni yonde hareket eder.
  if (buying) {
    must(
      after.state.virtualQuoteReserves > before.state.virtualQuoteReserves &&
        after.state.virtualTokenReserves < before.state.virtualTokenReserves,
      'alim sanal rezervleri yanlis yone tasidi',
    )
    must(
      after.state.realTokenReserves < before.state.realTokenReserves,
      'alim gercek token rezervini azaltmadi',
    )
  } else {
    must(
      after.state.virtualQuoteReserves < before.state.virtualQuoteReserves &&
        after.state.virtualTokenReserves > before.state.virtualTokenReserves,
      'satim sanal rezervleri yanlis yone tasidi',
    )
    must(
      after.state.realTokenReserves > before.state.realTokenReserves,
      'satim gercek token rezervini artirmadi',
    )
  }

  // 4. SABIT CARPIM ASLA KUCULMEZ. `k = vq * vt` yuvarlama yuzunden BUYUYEBILIR
  //    (her adimda protokol lehine), ama KUCULMESI, egriden deger sizmasi
  //    demektir. Bu, tek bir islemde gorunmeyecek kadar kucuk ve kirk islemde
  //    gorunecek kadar birikimli olan tam olarak o seydir.
  const kBefore = before.state.virtualQuoteReserves * before.state.virtualTokenReserves
  const kAfter = after.state.virtualQuoteReserves * after.state.virtualTokenReserves
  must(kAfter >= kBefore, `sabit carpim KUCULDU: ${kBefore} -> ${kAfter}`)
}

export async function phaseStress(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  token: Address,
  curve: Address,
): Promise<void> {
  c.phase('FAZ H -- stres ve olasilik (canli egri)')

  const me = w.account!.address
  const seed = Number(process.env['ARC_STRESS_SEED'] ?? Date.now() % 2147483647)
  const next = rng(seed)
  const fees = await feeBps(pub, curve)

  console.log(
    `  (tohum ${seed}, ${CYCLES} dongu, ucretler ${fees.protocolFeeBps}/${fees.creatorFeeBps})`,
  )

  /*
   * ============ TEK VE SINIRSIZ IZIN, DONGUDEN ONCE ============
   *
   * `sellExactTokensIn` `transferFrom` YAPAR: satici, egriye ONCEDEN izin
   * vermek zorundadir. Ilk kosu bunu atladi ve zincir `0xfb8f41b2`
   * (`ERC20InsufficientAllowance`) ile dustu -- BondingCurve'un ABI'sinde
   * olmayan bir selector oldugu icin viem onu cozemedi bile. Kayda geciyor:
   * bu bir urun kusuru DEGIL, egrinin satis yolunun gercek on kosuludur.
   *
   * IZIN SINIRSIZ VE BIR KEZ. Satis basina dar bir izin (Faz B'nin yaptigi,
   * ve orada DOGRU olan) burada dongunun ORTASINDA tukenirdi -- bu depoda
   * havuz supurmesinde bir kez olculdu ve "revert Error" diye gorunmustu.
   */
  await send(pub, w, {
    address: token,
    abi: TOKEN_ABI,
    functionName: 'approve',
    args: [curve, 2n ** 256n - 1n],
  })

  let drifts = 0
  let maxDriftTok = 0n
  let buys = 0
  let sells = 0

  for (let i = 1; i <= CYCLES; i++) {
    const before = await snapshot(pub, curve, token, me, me)
    if (before.state.complete) {
      c.skip(`H${i}`, 'egri tamamlandi, dizi burada biter')
      break
    }

    // ALIM MI SATIM MI: elde token yoksa zorunlu alim; varsa %35 satim.
    const canSell = before.tokenBalance > 1_000n
    const buying = !canSell || next() > 0.35

    if (buying) {
      /*
       * TUTAR LOGARITMIK OLARAK DAGITILIR, DOGRUSAL DEGIL.
       *
       * Dogrusal bir dagilim [0,02 , 0,20] araliginda neredeyse hep ORTA
       * buyuklukte islem uretir ve kucuk tutarlarin yuvarlama davranisini --
       * yani hatanin GERCEKTEN yasadigi yeri -- hic ziyaret etmez.
       */
      const exp = -3 + next() * 2.2 // 10^-3 .. 10^-0.8 USDC
      const valueWei = BigInt(Math.floor(10 ** exp * 1e18))
      if (valueWei < 1_000_000n) continue

      const plan = planBuyExactQuoteIn(
        before.state,
        {
          virtualTokenReserves: before.state.virtualTokenReserves,
          virtualQuoteReserves: before.state.virtualQuoteReserves,
          saleSupply: before.state.realTokenReserves,
        },
        fees,
        valueWei,
        0,
      )

      await send(pub, w, {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'buyExactQuoteIn',
        args: [0n],
        value: valueWei,
      })
      buys++

      const after = await snapshot(pub, curve, token, me, me)
      const got = after.tokenBalance - before.tokenBalance
      const drift = got > plan.tokens ? got - plan.tokens : plan.tokens - got
      if (drift !== 0n) {
        drifts++
        if (drift > maxDriftTok) maxDriftTok = drift
      }
      assertInvariants(before, after, true)
      await c.check(`H${i} alim ${valueWei} wei`, () => {
        must(got === plan.tokens, `planlayici ${plan.tokens}, zincir ${got} (sapma ${drift})`)
        return Promise.resolve(`${got} token, k korundu`)
      })
    } else {
      // SATIM: bakiyenin %10-%90'i.
      const frac = 10n + BigInt(Math.floor(next() * 80))
      const tokensIn = (before.tokenBalance * frac) / 100n
      if (tokensIn === 0n) continue

      let plan
      try {
        plan = planSellExactTokensIn(
          before.state,
          {
            virtualTokenReserves: before.state.virtualTokenReserves,
            virtualQuoteReserves: before.state.virtualQuoteReserves,
            saleSupply: before.state.realTokenReserves,
          },
          fees,
          tokensIn,
          0,
        )
      } catch (error) {
        // PLANLAYICI REDDETTI. Bu bir ariza degil bir CEVAPTIR ve zincirin de
        // reddetmesi beklenir; ayri bir vaka olarak kaydedilir.
        c.skip(`H${i} satim ${tokensIn}`, `planlayici reddetti: ${(error as Error).message}`)
        continue
      }

      const balBefore = await pub.getBalance({ address: me })
      const sent = await send(pub, w, {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'sellExactTokensIn',
        args: [tokensIn, 0n],
      })
      sells++
      const balAfter = await pub.getBalance({ address: me })
      // GAZ GERI EKLENIR: net degisim = gelen quote - odenen gaz.
      const received = balAfter - balBefore + sent.feeWei

      /*
       * ============ SATIMDA BEKLENEN TUTAR `args[1]`DIR, `value` DEGIL ============
       *
       * `TradePlan.value` `msg.value`dir ve bir SATIMDA TANIMI GEREGI SIFIRDIR
       * (`trade.ts:367`). Ilk hal onu "beklenen gelir" sanip her satimi kirmizi
       * yapti: "planlayici 0 wei, zincir 179454853928888644". Sayi dogruydu,
       * KARSILASTIRILAN ALAN yanlisti -- ve bu, denetim kosumunun ucuncu kez
       * odedigi ayni sinif: dogrulanan seyi dogrulayanin modeli kirik.
       *
       * NET gelir `args[1]`dir: `slipDown(netOut, slipBps)`, ve `slipBps` sifir
       * gecildigi icin TAM `netOut`. `curveAmount` ise ucret ONCESI hasilattir
       * (`proceeds`), yani o da yanlis alan olurdu.
       */
      const expectedNet = plan.args[1] as bigint

      const after = await snapshot(pub, curve, token, me, me)
      const drift = received > expectedNet ? received - expectedNet : expectedNet - received
      if (drift !== 0n) {
        drifts++
        if (drift > maxDriftTok) maxDriftTok = drift
      }
      assertInvariants(before, after, false)
      await c.check(`H${i} satim ${tokensIn} token`, () => {
        must(
          after.tokenBalance === before.tokenBalance - tokensIn,
          `token bakiyesi ${before.tokenBalance - tokensIn} olmaliydi, ${after.tokenBalance}`,
        )
        must(
          received === expectedNet,
          `planlayici ${expectedNet} wei, zincir ${received} (sapma ${drift})`,
        )
        return Promise.resolve(`${received} wei net, k korundu`)
      })
    }
  }

  await c.check('H-ozet dizi boyunca SIFIR birikimli sapma', () => {
    must(
      drifts === 0,
      `${drifts} adimda planlayici ile zincir ayristi (en buyuk sapma ${maxDriftTok})`,
    )
    return Promise.resolve(`${buys} alim + ${sells} satim, tohum ${seed}`)
  })
}
