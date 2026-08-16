/**
 * ============================================================================
 *  PANELIN GOSTERDIGI KOTA, GERCEKLESEN ISLEMLE KARSILASTIRILIR
 * ============================================================================
 *
 * Egri sozlesmesinde bir `quote...` view fonksiyonu YOKTUR: panel, kotayi
 * `planBuyExactQuoteIn` ile ISTEMCIDE hesaplar. Yani "kullaniciya gosterilen
 * 21.5K FRONG dogru mu" sorusunun cevabi bir birim testinde DEGILDIR --
 * birim testi hem girdiyi hem beklenen ciktiyi ayni yerden alir.
 *
 * Buradaki iddia sudur:
 *
 *     planBuyExactQuoteIn(islem ONCESI rezervler, gonderilen tutar).tokens
 *       ==  islem SONRASI bakiye  -  islem ONCESI bakiye
 *
 * Sol taraf panelin ekrana yazacagi sayi, sag taraf zincirin GERCEKTEN
 * verdigi. Aralarindaki her sey -- `correctedNetQuoteIn`in bir wei'lik
 * duzeltmesi, ucret bolusumu, `mulDiv` tabanlari -- bu tek karsilastirmada
 * sinanir. Fonksiyon PANELIN CAGIRDIGININ AYNISIDIR; probe kendi
 * matematigini yazsaydi olctugu sey urun degil kendi kopyasi olurdu.
 *
 * Rezervler islem ONCESI BLOKTAN okunur (`blockNumber: n - 1`), yani girdi de
 * cikti da zincirden gelir.
 */
import { createPublicClient, http } from 'viem'
/*
 * `asTok` / `asWei` MARKALAMA. `@arcpad/shared` iki USDC gorunumunu TIP
 * duzeyinde ayirir (`TokAmount` ve `WeiUsdc`); ciplak bir `bigint` gecirmek
 * derlenmez. Bu kapi Arc'a ozgudur ve amaci tam olarak 1e12'lik bir olcek
 * karisikligini derleme aninda yakalamaktir -- probe da ondan muaf degil.
 */
import { arcTestnet, asTok, asWei, planBuyExactQuoteIn } from '@arcpad/shared'

const TOKEN = '0x99340e06e6acfb7ca625fb2ab6636bd51e87a526' as const
const CURVE = '0x2E812f107742b1b9180144EAd240A46C892eEaB1' as const

/*
 * ZINCIR VE RPC REGISTRY'DEN GELIR, BURADA YENIDEN YAZILMAZ.
 *
 * Bu blok bir zamanlar `id: 5042002` ve RPC host'unu ELLE tasiyordu, yani
 * `packages/shared/src/chain.ts`in yaninda IKINCI bir dogruluk kaynagiydi --
 * ve `chain-registry.test.ts` tam olarak bunu yakalar ("no tracked source
 * outside the registry carries the chain id or an Arc host").
 *
 * Bir prob icin bu, kozmetikten fazlasidir: probun VAR OLMA SEBEBI urunun
 * gordugu sayiyi urunun gordugu yerden dogrulamaktir. Kendi zincir tanimini
 * tasiyan bir prob, urun baska bir RPC'ye tasindiginda ESKI zinciri olcmeye
 * devam eder ve YESIL kalir -- yani en cok ise yarayacagi anda sessizce
 * yaniltir.
 */
const chain = arcTestnet
const RPC = chain.rpcUrls.default.http[0]

const u256 = (name: string) =>
  ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  }) as const
const CURVE_ABI = [
  u256('virtualQuoteReserves'),
  u256('virtualTokenReserves'),
  u256('realTokenReserves'),
  u256('realQuoteReserves'),
  u256('PROTOCOL_FEE_BPS'),
  u256('CREATOR_FEE_BPS'),
  {
    type: 'function',
    name: 'graduated',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'creator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const
const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const pub = createPublicClient({ chain, transport: http(RPC) })

/** `<blok>:<alici>:<gonderilenWei>` -- merdivenin makbuzlarindan. */
const TRADES = process.argv.slice(2).map((raw) => {
  const [block, buyer, sent] = raw.split(':')
  return { block: BigInt(block!), buyer: buyer! as `0x${string}`, sent: BigInt(sent!) }
})

if (TRADES.length === 0) {
  console.log('kullanim: verify-quote.ts <blok>:<alici>:<gonderilenWei> ...')
  process.exit(2)
}

const read = (name: string, blockNumber: bigint) =>
  pub.readContract({
    address: CURVE,
    abi: CURVE_ABI,
    functionName: name as 'virtualQuoteReserves',
    blockNumber,
  })

let bad = 0
for (const t of TRADES) {
  const before = t.block - 1n
  const [vQ, vT, rT, rQ, protocolFeeBps, creatorFeeBps, complete, creator, balBefore, balAfter] =
    await Promise.all([
      read('virtualQuoteReserves', before) as Promise<bigint>,
      read('virtualTokenReserves', before) as Promise<bigint>,
      read('realTokenReserves', before) as Promise<bigint>,
      read('realQuoteReserves', before) as Promise<bigint>,
      read('PROTOCOL_FEE_BPS', before) as Promise<bigint>,
      read('CREATOR_FEE_BPS', before) as Promise<bigint>,
      pub.readContract({
        address: CURVE,
        abi: CURVE_ABI,
        functionName: 'graduated',
        blockNumber: before,
      }) as Promise<boolean>,
      pub.readContract({
        address: CURVE,
        abi: CURVE_ABI,
        functionName: 'creator',
        blockNumber: before,
      }) as Promise<string>,
      pub.readContract({
        address: TOKEN,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [t.buyer],
        blockNumber: before,
      }) as Promise<bigint>,
      pub.readContract({
        address: TOKEN,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [t.buyer],
        blockNumber: t.block,
      }) as Promise<bigint>,
    ])

  const plan = planBuyExactQuoteIn(
    {
      virtualQuoteReserves: vQ,
      virtualTokenReserves: vT,
      realTokenReserves: asTok(rT),
      realQuoteReserves: asWei(rQ),
      complete,
      creator,
    },
    // Profil yalnizca `graduationRaise` icin okunur; alis kotasi ona bakmaz.
    { virtualQuoteReserves: vQ, virtualTokenReserves: vT, saleSupply: asTok(rT) },
    { protocolFeeBps, creatorFeeBps },
    t.sent,
    // Slipaj kotayi DEGISTIRMEZ, yalnizca zincire giden alt siniri belirler.
    250,
  )

  const actual = balAfter - balBefore
  const ok = plan.tokens === actual
  if (!ok) bad += 1
  console.log(`${ok ? '  ok  ' : '  FARK'} blok ${t.block}  gonderilen ${t.sent} wei`)
  console.log(`        panelin gosterecegi : ${plan.tokens}`)
  console.log(
    `        zincirin verdigi    : ${actual}${ok ? '' : `   fark ${plan.tokens - actual}`}`,
  )
}

console.log('')
console.log(bad === 0 ? 'KOTA MATEMATIGI: her islem BIREBIR.' : `KOTA MATEMATIGI: ${bad} SAPMA.`)
process.exit(bad === 0 ? 0 : 1)
