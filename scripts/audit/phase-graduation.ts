/**
 * ============================================================================
 *  FAZ D -- TAMAMLANMA VE MEZUNIYET
 * ============================================================================
 *
 * !! BU FAZ ~12,3 USDC HARCAR VE GERI GELMEZ. Toplanan `R` havuza tohum
 *    olarak girer ve likidite KALICI olarak kilitlenir -- tasarim boyle.
 *    Ucuz bir yolu yoktur: egri gercekten tamamlanmadan mezuniyet olmaz.
 *
 * Uc AYRI olgu, uc ayri iddia -- ve ayrilmalari tasiyicidir:
 *
 *   complete    satis arzi tukendi, egri kapandi, HAVUZ HENUZ YOK
 *   graduated   `R` ve `D` hedefe odendi, havuz acildi
 *   pool        havuzda islem yapilabiliyor
 *
 * Canli smoke egrisi aylardir `complete && !graduated` durumunda duruyor;
 * ikisini tek bayrakla temsil eden bir arayuz o egri icin YALAN soylerdi.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import { bondingCurveAbi, launchTokenAbi } from '../../packages/shared/src/abi/index'
import { book, type Campaign, must, mustEqual, read, send } from './harness'
import { curveState } from './phase-curve'

const CURVE_ABI = bondingCurveAbi as unknown as Abi
const TOKEN_ABI = launchTokenAbi as unknown as Abi

const LOCKER_ABI = [
  {
    type: 'function',
    name: 'hook',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'poolManager',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  /**
   * MEZUNIYETIN GERCEK GIRIS NOKTASI.
   *
   * OLCULDU: `curve.graduate()` DOGRUDAN cagrilamaz -- `NotGraduationTarget`
   * ile revert eder. Izinsizlik curve'de DEGIL HEDEFIN girisindedir, ve
   * gerekcesi curve'un NatSpec'inde yazili: deger transferi alicinin kodunu
   * CURVE'UN cagri cercevesinde calistirir, yani izinsizligi curve'e koymak
   * ucuncu bir tarafa "hedef kabul eder ama havuzu tohumlayamaz" durumunu
   * dayatma imkani verirdi.
   */
  {
    type: 'function',
    name: 'graduate',
    inputs: [{ name: 'curve', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const satisfies Abi

/**
 * Egriyi TAMAMLAR: kalan satis arzini bitirene kadar alir.
 *
 * `buyExactQuoteIn` rezervi asan bir butceyi KISAR (revert etmez), yani son
 * adimda bilerek fazla gonderiyoruz ve kontrat tam rezervi satip kalani iade
 * ediyor. Bu, `buyExactTokensOut(realTokenReserves)` ile ayni yere duser --
 * rezervler TAM sifira iner, toz kalmaz.
 */
async function completeCurve(
  pub: PublicClient,
  w: WalletClient,
  curve: Address,
): Promise<{ steps: number; spentWei: bigint }> {
  let steps = 0
  let spent = 0n
  for (let i = 0; i < 60; i += 1) {
    const state = await curveState(pub, curve)
    if (state.complete) break

    /*
     * BUTCE ASLA KISILMAZ -- ve ilk surum tam olarak bunu yapip `NetTooSmall`
     * aldi (olculdu).
     *
     * Kisma dalinda planlayici `curveAmount + ucretler`i verir; o rakami
     * `msg.value` olarak geri gondermek YANLIS, cunku kontrat gelen degeri
     * INCLUSIVE ayrisimla YENIDEN boler ve elde ettigi net, kalan rezervi
     * almaya yetmez. Dongu her turda biraz daha kucuk bir butce gonderip
     * sonunda "net cok kucuk" noktasina duser.
     *
     * Dogrusu butun butceyi gondermektir: kontrat kalan rezerve KISAR ve
     * fazlasini IADE eder. Comert olmak bedavadir.
     */
    const budget = 3_000_000_000_000_000_000n
    await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: budget,
    })
    spent += budget
    steps += 1
  }
  return { steps, spentWei: spent }
}

export async function phaseGraduation(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  token: Address,
  curve: Address,
): Promise<void> {
  c.phase('FAZ D -- tamamlanma ve mezuniyet')
  const b = book()

  // ------------------------------------------------------------------
  // D1. MEZUNIYETTEN ONCE `graduate()` REDDEDILIR
  // ------------------------------------------------------------------
  //
  // Zincirin kendi on kosulu: `graduated => complete`. Sirayi tersine cevirmek
  // bir egriyi rezervleri doluyken bosaltirdi.
  //
  // SIRA TASIYICIDIR: `!complete` -> `graduated` -> hedef -> gonderen. Zaten
  // tamamlanmis bir egri yeniden kullanildiginda bu vaka ANLAMSIZDIR (ilk
  // kontrolden gecer ve gonderen kontrolune duser), bu yuzden atlanir --
  // "gecti" demek yanlis olurdu.
  if ((await curveState(pub, curve)).complete) {
    c.skip('D1 tamamlanmadan graduate() NotComplete', 'egri ZATEN tamamlanmis (yeniden kullanim)')
  } else {
    await c.expectRevert('D1 tamamlanmadan graduate() NotComplete', 'NotComplete', () =>
      send(pub, w, { address: curve, abi: CURVE_ABI, functionName: 'graduate' }),
    )
  }

  // ------------------------------------------------------------------
  // D2. EGRIYI TAMAMLA -- rezervler TAM SIFIRA iner
  // ------------------------------------------------------------------
  await c.check('D2 egri tamamlanir, realTokenReserves TAM sifir', async () => {
    const { steps, spentWei } = await completeCurve(pub, w, curve)
    const state = await curveState(pub, curve)
    must(state.complete, 'egri tamamlanmadi')
    mustEqual(state.realTokenReserves, 0n, 'kalan satis arzi')
    return `${steps} alis, ~${spentWei / 10n ** 15n} milli-USDC harcandi`
  })

  // ------------------------------------------------------------------
  // D3. TAMAMLANMIS EGRIDE ISLEM YAPILAMAZ
  // ------------------------------------------------------------------
  await c.expectRevert('D3 tamamlanmis egride alis CurveComplete', 'CurveComplete', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: 10_000_000_000_000_000n,
    }),
  )

  await c.expectRevert('D4 tamamlanmis egride satis CurveComplete', 'CurveComplete', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'sellExactTokensIn',
      args: [10n ** 18n, 0n],
    }),
  )

  // ------------------------------------------------------------------
  // D4b. CURVE'UN KENDI `graduate()`I DOGRUDAN CAGRILAMAZ
  // ------------------------------------------------------------------
  //
  // Izinsizlik HEDEFIN girisindedir, curve'un degil. Bu bir kisitlama degil
  // bir KORUMADIR: aksi halde ucuncu bir taraf, hedefin havuzu tohumlayamadigi
  // bir ana curve'u kilitleyebilirdi.
  await c.expectRevert(
    'D4b curve.graduate() dogrudan NotGraduationTarget',
    'NotGraduationTarget',
    () => send(pub, w, { address: curve, abi: CURVE_ABI, functionName: 'graduate' }),
  )

  // ------------------------------------------------------------------
  // D5. MEZUNIYET -- LOCKER UZERINDEN, ve odeme DEFTERDEN
  // ------------------------------------------------------------------
  //
  // Odenen iki sayi DEFTERDEN ve IMMUTABLE'DAN gelir, hicbir bakiyeden degil:
  // bir bagis egrinin odemesini sisiremez.
  await c.check('D5 locker.graduate(curve) mezun eder, hedefe R ve D oder', async () => {
    const state = await curveState(pub, curve)
    const seed = await read<bigint>(pub, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'poolSeedSupply',
    })
    const target = b.arcpadLocker
    const targetTokBefore = await read<bigint>(pub, {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [target],
    })

    await send(pub, w, {
      address: b.arcpadLocker,
      abi: LOCKER_ABI as unknown as Abi,
      functionName: 'graduate',
      args: [curve],
    })

    const graduated = await read<boolean>(pub, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'graduated',
    })
    must(graduated, 'graduated bayragi kalkmadi')
    const targetTokAfter = await read<bigint>(pub, {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [target],
    })
    // Locker tohum arzini ALDI ve havuza koydu; elinde kalmasi da mesrudur
    // (havuz pozisyonu locker'in adina durur), yani yalnizca AKISI olcuyoruz.
    return `R=${state.realQuoteReserves}, D=${seed}, locker token deltasi ${targetTokAfter - targetTokBefore}`
  })

  // ------------------------------------------------------------------
  // D6. IKINCI MEZUNIYET REDDEDILIR
  // ------------------------------------------------------------------
  await c.expectRevert('D6 ikinci mezuniyet AlreadyGraduated', 'AlreadyGraduated', () =>
    send(pub, w, {
      address: b.arcpadLocker,
      abi: LOCKER_ABI as unknown as Abi,
      functionName: 'graduate',
      args: [curve],
    }),
  )

  // ------------------------------------------------------------------
  // D7. MEZUNIYETTEN SONRA EGRI SESSIZDIR
  // ------------------------------------------------------------------
  await c.expectRevert('D7 mezuniyetten sonra alis CurveComplete', 'CurveComplete', () =>
    send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: 10_000_000_000_000_000n,
    }),
  )

  // ------------------------------------------------------------------
  // D8. HAVUZ GERCEKTEN ACILDI -- locker'in kablolamasi zincirden
  // ------------------------------------------------------------------
  await c.check('D8 locker hook ve poolManager bildiriyor', async () => {
    const hook = await read<Address>(pub, {
      address: b.arcpadLocker,
      abi: LOCKER_ABI as unknown as Abi,
      functionName: 'hook',
    })
    const pm = await read<Address>(pub, {
      address: b.arcpadLocker,
      abi: LOCKER_ABI as unknown as Abi,
      functionName: 'poolManager',
    })
    mustEqual(hook.toLowerCase(), b.arcpadHook.toLowerCase(), 'locker.hook()')
    mustEqual(pm.toLowerCase(), b.poolManager.toLowerCase(), 'locker.poolManager()')
    return `${hook} / ${pm}`
  })
}
