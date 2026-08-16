/**
 * ============================================================================
 *  FAZ F -- HAVUZ MERCII: MEZUNIYET SONRASI ISLEM, UCRET VE BUYBACK
 * ============================================================================
 *
 * Projenin KALAN TEK kanitlanmamis yolu buydu. Egri mercii canli zincirde
 * kanitlanmisti; havuz mercii yalnizca canli bir FORK'a karsi kosuyordu.
 *
 * Uc ayri iddia, ve ucu de mezuniyetten SONRA anlamli:
 *
 *   1. Havuzda islem yapilabiliyor (router uzerinden, gercek V4 swap).
 *   2. Hook ucreti AYNI ekonomiyi uretiyor -- protokol ve creator paylari
 *      escrow'a, egrideki gibi.
 *   3. Buyback havuzdan ALIM yapiyor ve kasaya kilitliyor.
 *
 * ============ BIRIMLER: HAVUZ 6 DECIMAL KONUSUR ============
 *
 * Egri native wei (18 decimal) ile calisir; havuz Arc'in ERC-20 gorunumuyle,
 * yani 6 decimal. `GraduationMath.quoteUnits/quoteWei` arasindaki 10^12
 * donusumu bu fazda HER miktarda gecerlidir -- karistirmak 10^12 kat hata
 * verir ve bu depo onu `_marketCap` icin bir kez odedi.
 *
 * Router `payable` DEGILDIR: kullanicinin USDC'sini `0x3600...` ERC-20
 * gorunumunden `transferFrom` ile ceker, yani ONCE approve gerekir.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import {
  buybackTreasuryAbi,
  buybackVestingVaultAbi,
  feeEscrowAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../../packages/shared/src/abi/index'
import { book, type Campaign, must, mustEqual, read, send } from './harness'

const TOKEN_ABI = launchTokenAbi as unknown as Abi
const ESCROW_ABI = feeEscrowAbi as unknown as Abi
const FACTORY_ABI = launchFactoryAbi as unknown as Abi
const TREASURY_ABI = buybackTreasuryAbi as unknown as Abi
const VAULT_ABI = buybackVestingVaultAbi as unknown as Abi

/** Arc'in ERC-20 gorunumu -- native varligin AYNISI, 6 decimal. */
const USDC_ERC20 = '0x3600000000000000000000000000000000000000' as Address
const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const satisfies Abi

const ROUTER_ABI = [
  {
    type: 'function',
    name: 'buyExactIn',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'quoteIn', type: 'uint256' },
      { name: 'minTokensOut', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'sellExactIn',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'tokensIn', type: 'uint256' },
      { name: 'minQuoteOut', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'quoteOut', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const satisfies Abi

const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 900)

export async function phasePool(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  token: Address,
): Promise<void> {
  c.phase('FAZ F -- havuz mercii: islem, ucret, buyback')
  const b = book()
  const me = w.account!.address
  const router = b.arcpadRouter
  const escrow = b.feeEscrow
  const treasury = await read<Address>(pub, {
    address: b.launchFactory,
    abi: FACTORY_ABI,
    functionName: 'buybackTreasury',
  })
  const vault = await read<Address>(pub, {
    address: treasury,
    abi: TREASURY_ABI,
    functionName: 'vault',
  })

  const owed = async (who: Address): Promise<bigint> =>
    read<bigint>(pub, { address: escrow, abi: ESCROW_ABI, functionName: 'owed', args: [who] })
  const heldTok = async (): Promise<bigint> =>
    read<bigint>(pub, { address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [me] })
  const pending = async (): Promise<bigint> =>
    read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'pendingQuote',
      args: [token],
    })

  // ------------------------------------------------------------------
  // F1. ROUTER'IN HOOK'U CANLI HOOK OLMALI
  // ------------------------------------------------------------------
  //
  // Router `hook`u constructor'dan alir, yani yeni bir hook YENI BIR ROUTER
  // demektir. Bayat bir router `PoolKey`i yanlis kurar ve V4 sessizce BASKA
  // bir havuza bakar -- islem revert etmez, HIC BULMAZ.
  await c.check('F1 router canli hook u bildiriyor', async () => {
    const hook = await read<Address>(pub, {
      address: router,
      abi: [
        { type: 'function', name: 'hook', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
      ] as unknown as Abi,
      functionName: 'hook',
    })
    mustEqual(hook.toLowerCase(), b.arcpadHook.toLowerCase(), 'router.hook()')
    return hook
  })

  // ------------------------------------------------------------------
  // F2. HAVUZDA ALIM -- gercek V4 swap
  // ------------------------------------------------------------------
  /*
   * ONAY BIR KEZ VE BOL VERILIR.
   *
   * OLCULDU: dar bir onay (`quoteIn * 10`) F6'nin dongusunde tukendi ve
   * `transferFrom` bir ERC-20 hatasiyla dustu -- rapora "revert Error" diye
   * dusen sey buydu. Havuz merciinin bozuk oldugunu DUSUNDUREN bir satirdi;
   * oysa simulasyon ayni anda BASARILIYDI. Onay bir on kosuldur, bir test
   * konusu degil.
   */
  await send(pub, w, {
    address: USDC_ERC20,
    abi: ERC20_ABI as unknown as Abi,
    functionName: 'approve',
    args: [router, 500_000_000n], // 500 USDC, 6 decimal
  })

  await c.check('F2 havuzda alim: token gelir, USDC gider', async () => {
    const quoteIn = 500_000n // 0,5 USDC, 6 decimal
    const tokBefore = await heldTok()
    await send(pub, w, {
      address: router,
      abi: ROUTER_ABI as unknown as Abi,
      functionName: 'buyExactIn',
      args: [token, quoteIn, 0n, me, deadline()],
    })
    const gained = (await heldTok()) - tokBefore
    must(gained > 0n, 'havuz alimi HIC token vermedi')
    return `${gained} token alindi (${quoteIn} birim USDC ile)`
  })

  // ------------------------------------------------------------------
  // F3. HOOK UCRETI ESCROW'A GIRER -- IKI PAY AYRI
  // ------------------------------------------------------------------
  //
  // Mezuniyet, creator'in gelirini SESSIZCE degistirmemeli: havuz yolu da
  // ayni iki payi ayni escrow'a yatirmali. Ayrisan bir yol, "ucret gecmisi
  // mezuniyette kopmaz" iddiasini bosaltirdi.
  await c.check('F3 hook ucreti escrow a girer (protokol + creator)', async () => {
    const treasuryAddr = b.protocolTreasury
    const pBefore = await owed(treasuryAddr)
    const cBefore = await owed(me)

    const quoteIn = 500_000n
    await send(pub, w, {
      address: router,
      abi: ROUTER_ABI as unknown as Abi,
      functionName: 'buyExactIn',
      args: [token, quoteIn, 0n, me, deadline()],
    })

    const pDelta = (await owed(treasuryAddr)) - pBefore
    const cDelta = (await owed(me)) - cBefore
    must(pDelta > 0n, 'protokol payi havuzda TAHSIL EDILMEDI')
    // Creator payinin bir kismi buyback'e ayrilmis olabilir; toplam pozitif
    // olmali ama esitlik iddia EDILMEZ -- ayrim bir sonraki vakada olculur.
    return `protokol +${pDelta}, creator nakdi +${cDelta}`
  })

  // ------------------------------------------------------------------
  // F4. BUYBACK HAVUZ MERCIINDEN TAHAKKUK EDER
  // ------------------------------------------------------------------
  //
  // Tahakkukun MERCII (`venue`) hook olmali. Egri mercii ile karistirilmasi,
  // "butce nereden birikti" sorusunu cevapsiz birakirdi.
  await c.check('F4 buyback HAVUZ merciinden tahakkuk eder', async () => {
    const enabled = await read<boolean>(pub, {
      address: b.launchFactory,
      abi: FACTORY_ABI,
      functionName: 'buybackEnabledOf',
      args: [token],
    })
    must(enabled, 'bu token icin buyback KAPALI -- faz yanlis token ile kosuyor')

    const before = await pending()
    await send(pub, w, {
      address: router,
      abi: ROUTER_ABI as unknown as Abi,
      functionName: 'buyExactIn',
      args: [token, 1_000_000n, 0n, me, deadline()],
    })
    const after = await pending()
    must(after > before, 'havuz isleminde buyback TAHAKKUK ETMEDI')
    return `+${after - before} wei (havuz merciinden)`
  })

  // ------------------------------------------------------------------
  // F5. HAVUZDA SATIS
  // ------------------------------------------------------------------
  await c.check('F5 havuzda satis: token gider, USDC gelir', async () => {
    const bal = await heldTok()
    must(bal > 0n, 'satacak token yok')
    const tokensIn = bal / 4n
    await send(pub, w, {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'approve',
      args: [router, tokensIn],
    })
    const usdcBefore = await read<bigint>(pub, {
      address: USDC_ERC20,
      abi: ERC20_ABI as unknown as Abi,
      functionName: 'balanceOf',
      args: [me],
    })
    await send(pub, w, {
      address: router,
      abi: ROUTER_ABI as unknown as Abi,
      functionName: 'sellExactIn',
      args: [token, tokensIn, 0n, me, deadline()],
    })
    const usdcAfter = await read<bigint>(pub, {
      address: USDC_ERC20,
      abi: ERC20_ABI as unknown as Abi,
      functionName: 'balanceOf',
      args: [me],
    })
    // Gaz da ayni bakiyeden odendigi icin KESIN esitlik iddia edilmez; satisin
    // bakiyeyi ARTIRDIGI olculur.
    must(usdcAfter > usdcBefore, 'satis USDC getirmedi')
    return `${tokensIn} token satildi`
  })

  // ------------------------------------------------------------------
  // F6. HAVUZ MERCIINDEN SUPURME -- KALAN TEK KANITLANMAMIS YOL
  // ------------------------------------------------------------------
  //
  // Mezuniyetten sonra `_spendableOnCurve` SIFIR doner; havuz mercii olmasa
  // buyback payi her supurmede creator'a geri katlanirdi. Bu vaka, alinan
  // tokenin GERCEKTEN havuzdan geldigini ve kasaya kilitlendigini olcer.
  await c.check('F6 havuzdan supurme: alim yapilir ve kilitlenir', async () => {
    const minSweep = await read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'MIN_SWEEP_WEI',
    })
    // Esigi asana kadar havuzda al-sat.
    for (let i = 0; i < 30 && (await pending()) < minSweep; i += 1) {
      await send(pub, w, {
        address: router,
        abi: ROUTER_ABI as unknown as Abi,
        functionName: 'buyExactIn',
        args: [token, 3_000_000n, 0n, me, deadline()],
      })
    }
    const budget = await pending()
    must(budget >= minSweep, `esik asilamadi: ${budget} < ${minSweep}`)

    const boughtBefore = await read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'cumulativeTokensBought',
      args: [token],
    })
    const lockedBefore = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'totalLocked',
      args: [token],
    })

    await send(pub, w, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'sweep',
      args: [token, 0n, deadline()],
    })

    const bought =
      (await read<bigint>(pub, {
        address: treasury,
        abi: TREASURY_ABI,
        functionName: 'cumulativeTokensBought',
        args: [token],
      })) - boughtBefore
    const locked =
      (await read<bigint>(pub, {
        address: vault,
        abi: VAULT_ABI,
        functionName: 'totalLocked',
        args: [token],
      })) - lockedBefore

    must(bought > 0n, 'HAVUZDAN alim yapilmadi -- havuz mercii calismiyor')
    mustEqual(locked, bought, 'alinan == kilitlenen')
    return `${budget} wei ile ${bought} token HAVUZDAN alindi, tamami kilitlendi`
  })

  // ------------------------------------------------------------------
  // F7. HAZINE UCRETTEN MUAF -- havuzda da
  // ------------------------------------------------------------------
  //
  // Hazine kendi havuzumuzdan alim yaparken hook ucreti odeseydi iki sey
  // olurdu: protokol creator'in buyback butcesinden pay alirdi, ve alimin
  // creator payinin bir kismi supurme SIRASINDA hazineye geri yatilirdi.
  // Ikisi de olculmustu; bu vaka muafiyetin CANLI oldugunu dogrular.
  await c.check('F7 supurme sonrasi butce SIFIRLANIR (hazine ucret odemez)', async () => {
    const after = await pending()
    // Muafiyet olmasaydi supurmenin KENDI alimi yeni bir creator ucreti
    // dogurur ve onun yarisi hazineye GERI tahakkuk ederdi -- yani butce
    // sifirlanmazdi.
    must(
      after === 0n,
      `supurmeden sonra butce SIFIR DEGIL (${after}) -- hazine ucret odemis olabilir`,
    )
    return 'butce sifir'
  })
}
