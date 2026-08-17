/**
 * ============================================================================
 *  FAZ C -- UCRET DEFTERI: ESCROW
 * ============================================================================
 *
 * Escrow'un tek isi parayi TUTMAK ve DOGRU kisiye vermektir. Buradaki vakalar
 * o iki cumleyi ayri ayri yurutur, ve bir ucuncusunu de: escrow'un BAKIYESI
 * ile BORCU ayni sey degildir.
 *
 * `totalOwed <= balance` (esitlik DEGIL) escrow'un kendi NatSpec'inde yazili
 * bir kisittir: kontrata `deposit()` DISINDAN da para girebilir
 * (`selfdestruct`, coinbase, ya da bir `call`) ve o para TALEP EDILEMEZ.
 * Arayuzun escrow bakiyesini "talep edilebilir ucret" diye gostermesi bu
 * yuzden bir yalan olurdu -- ve bu faz esitsizligin YONUNU olcer.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import { feeEscrowAbi } from '../../packages/shared/src/abi/index'
import { balance, book, type Campaign, must, mustEqual, read, send } from './harness'

const ESCROW_ABI = feeEscrowAbi as unknown as Abi

/**
 * Arc'in ERC-20 gorunumu. NATIVE VARLIGIN AYNISIDIR, ikinci bir varlik degil.
 * Ayrim tasiyicidir: `transfer()` hedefin native bakiyesini artirir ama
 * `receive()`i CAGIRMAZ.
 */
const USDC_ERC20 = '0x3600000000000000000000000000000000000000' as Address
const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const satisfies Abi

export async function phaseFees(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  stranger: WalletClient,
): Promise<void> {
  c.phase('FAZ C -- ucret defteri: escrow')
  const b = book()
  const escrow = b.feeEscrow
  const me = w.account!.address
  const other = stranger.account!.address

  const owed = async (who: Address): Promise<bigint> =>
    read<bigint>(pub, { address: escrow, abi: ESCROW_ABI, functionName: 'owed', args: [who] })

  // ------------------------------------------------------------------
  // C1. TALEP: borc SIFIRLANIR ve para CUZDANA gecer
  // ------------------------------------------------------------------
  await c.check('C1 claim: borc sifirlanir, para cuzdana gecer', async () => {
    const before = await owed(me)
    must(before > 0n, 'talep edilecek ucret yok -- once egri fazi kosmali')
    const walletBefore = await balance(pub, me)
    const receipt = await send(pub, w, {
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'claim',
      args: [me],
    })
    const walletAfter = await balance(pub, me)
    mustEqual(await owed(me), 0n, 'talepten sonra borc')
    mustEqual(walletAfter - walletBefore + receipt.feeWei, before, 'cuzdana gecen')
    return `${before} wei alindi`
  })

  // ------------------------------------------------------------------
  // C2. BOS TALEP: sessizce gecmez, ADIYLA reddedilir
  // ------------------------------------------------------------------
  //
  // Sessizce gecen bir talep, arayuze "basarili" der ve kullanici parasinin
  // nereye gittigini arar. Revert, bir kabalik degil bir cevaptir.
  await c.expectRevert('C2 bos bakiyede claim NothingToClaim', 'NothingToClaim', () =>
    send(pub, w, { address: escrow, abi: ESCROW_ABI, functionName: 'claim', args: [me] }),
  )

  // ------------------------------------------------------------------
  // C3. TALEP IZINSIZDIR AMA YONU DEGISTIREMEZ
  // ------------------------------------------------------------------
  //
  // `claim(recipient)` HERKES tarafindan cagrilabilir -- bu bir acik degil bir
  // OZELLIKTIR (bir operator creator adina gaz odeyebilir). Kritik olan sey
  // paranin NEREYE gittigi: cagirana degil, `recipient`e. Bunu olcmeyen bir
  // test, "herkes cagirabilir"i bir zafiyet sanip yanlis yeri duzeltirdi.
  await c.check('C3 claim IZINSIZ ama para YALNIZCA alicinin', async () => {
    // Once bir ucret uretelim: yabanci bir cuzdandan bize borc olusturmanin
    // yolu bir alis, ama burada daha ucuzu var -- onceki fazlarda protokol
    // hazinesinin birikmis borcu ZATEN var ve onu YABANCI bir cuzdanla talep
    // edip paranin HAZINEYE gittigini olcebiliriz.
    const treasury = b.protocolTreasury
    const before = await owed(treasury)
    must(before > 0n, 'protokol hazinesinin borcu yok')
    const treasuryBefore = await balance(pub, treasury)
    const strangerBefore = await balance(pub, other)

    const receipt = await send(pub, stranger, {
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'claim',
      args: [treasury],
    })

    const treasuryAfter = await balance(pub, treasury)
    const strangerAfter = await balance(pub, other)
    mustEqual(treasuryAfter - treasuryBefore, before, 'hazineye gecen')
    // Yabanci YALNIZCA gaz odedi; bir wei bile almadi.
    mustEqual(strangerBefore - strangerAfter, receipt.feeWei, 'yabancinin odedigi (yalnizca gaz)')
    return `${before} wei hazineye, yabanci yalnizca gaz odedi`
  })

  // ------------------------------------------------------------------
  // C4. BAGIS TALEP EDILEMEZ -- `totalOwed <= balance`
  // ------------------------------------------------------------------
  //
  // Escrow'a dogrudan para gondermek MUMKUNDUR ve o para hicbir defterde
  // gorunmez. Bu bir kusur degil, EVM'in gercegi; kusur olan onu "talep
  // edilebilir" diye gostermek olurdu. Vaka esitsizligi ZINCIRDE kurar.
  // C4a. DUZ NATIVE GONDERIM REDDEDILIR -- `receive()` YOKTUR.
  //
  // Bu bir SERTLESTIRMEDIR ve olculmesi gerekir: `receive()` eklemek escrow'u
  // muhasebesiz para kabul eder hale getirirdi.
  await c.check('C4a duz native gonderim REDDEDILIR (receive yok)', async () => {
    let rejected = false
    try {
      const hash = await w.sendTransaction({
        account: w.account!,
        chain: null,
        to: escrow,
        value: 1_000_000_000_000_000n,
      })
      const r = await pub.waitForTransactionReceipt({ hash })
      rejected = r.status !== 'success'
    } catch {
      rejected = true
    }
    must(rejected, 'escrow duz native gonderimi KABUL ETTI -- receive() eklenmis olmali')
    return 'reddedildi'
  })

  // C4b. ERC-20 GORUNUMUNDEN GELEN PARA TALEP EDILEMEZ.
  //
  // Arc'ta native varlik ile `0x3600...` ERC-20'si AYNI bakiyenin iki
  // gorunumudur. `transfer()` hedefin native bakiyesini artirir ve
  // `receive()` HIC CALISMAZ -- yani escrow parayi alir, defterine yazmaz.
  // Kusur olan bu degil, bunu "talep edilebilir ucret" diye gostermek olurdu:
  // gecerli kisit `totalOwed <= balance`tir, esitlik DEGIL.
  await c.check('C4b ERC-20 gorunumunden gelen para BORCA girmez', async () => {
    const donation = 1_000n // 0,001 USDC, 6 decimal gorunumde
    const balBefore = await balance(pub, escrow)
    const owedBefore = await owed(me)
    const totalBefore = await read<bigint>(pub, {
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'totalOwed',
    })

    await send(pub, w, {
      address: USDC_ERC20,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [escrow, donation],
    })

    const balAfter = await balance(pub, escrow)
    must(balAfter > balBefore, 'ERC-20 transferi escrow bakiyesini ARTIRMADI')
    mustEqual(await owed(me), owedBefore, 'bagistan sonra borc')
    mustEqual(
      await read<bigint>(pub, { address: escrow, abi: ESCROW_ABI, functionName: 'totalOwed' }),
      totalBefore,
      'totalOwed',
    )
    const total = await read<bigint>(pub, {
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'totalOwed',
    })
    must(total <= balAfter, `KISIT KIRILDI: totalOwed ${total} > bakiye ${balAfter}`)
    return `bakiye +${balAfter - balBefore}, borc DEGISMEDI, totalOwed <= bakiye`
  })

  // ------------------------------------------------------------------
  // C5. SIFIR ALICIYA YATIRIM YASAK
  // ------------------------------------------------------------------
  //
  // Sifir adres bir cuzdan degildir; oraya yazilan borc SONSUZA KADAR
  // kilitli kalirdi. Egrinin sifir-creator dali tam olarak bu yuzden ucreti
  // HIC almaz -- yatirmayi denemez.
  await c.expectRevert('C5 sifir aliciya deposit ZeroRecipient', 'ZeroRecipient', () =>
    send(pub, w, {
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'deposit',
      args: ['0x0000000000000000000000000000000000000000' as Address],
      value: 1_000_000_000_000n,
    }),
  )

  // ------------------------------------------------------------------
  // C6. SIFIR TUTARLI YATIRIM YASAK
  // ------------------------------------------------------------------
  await c.expectRevert('C6 sifir tutarli deposit ZeroAmount', 'ZeroAmount', () =>
    send(pub, w, {
      address: escrow,
      abi: ESCROW_ABI,
      functionName: 'deposit',
      args: [me],
      value: 0n,
    }),
  )
}
