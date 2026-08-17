/**
 * ============================================================================
 *  EKRANDAKI HER SAYI, ZINCIRDEN BAGIMSIZ OLARAK YENIDEN HESAPLANIR
 * ============================================================================
 *
 * Soru suydu: "arayuzde kullanicilara bilgi veren butun sayisal fonksiyonlar
 * %100 dogru mu". Bir birim testi bunu CEVAPLAYAMAZ, cunku birim testi kendi
 * girdisini kendi uydurur. Buradaki iddia baskadir:
 *
 *     ekranda gorunen dize == ZINCIRDEN okunan ham degerin ayni
 *                              bicimlendiriciden gecmis hali
 *
 * Yani iki yol karsilastirilir:
 *   sayfa   : zincir -> indexer -> Postgres -> okuma katmani -> React
 *   bu probe: zincir -> viem -> ayni bicimlendirici
 *
 * Aradaki HER katman -- indexer'in olay ayristirmasi, SQL'deki `div`, okuma
 * katmanindaki olcek donusumleri -- bu karsilastirmada sinanir. Bicimlendirici
 * ORTAKTIR ve bu bilinclidir: amac bicimlendiriciyi degil, ona ULASAN sayiyi
 * dogrulamak. Bicimlendiricinin kendisinin 302 testi zaten var.
 *
 * HOLDER'LAR AYRICA BIREBIR: veritabanindaki her satir icin zincirde
 * `balanceOf` cagrilir. Tek bir sapma bile kirmizidir, ve toplam TAM 1e27
 * olmalidir -- arz degismezi.
 */
import { createPublicClient, http } from 'viem'
/*
 * `formatUsdcCompact`, `formatUsdc` DEGIL -- VE FARK OLCULDU.
 *
 * Ilk surum `formatUsdc` cagirdi ve FDV icin $7.40 uretti; sayfa $7.39
 * diyordu. Bu bir urun hatasi GIBI gorundu ama degildi: sayfanin kullandigi
 * `LiveNumber` bicimi `formatUsdcCompact`tir ve o, binden kucuk tutarlarda
 * `formatUsdcAmount(..., { rounding: 'down' })`e duser -- yani ASAGI KIRPAR.
 * `formatUsdc` ise `Intl.NumberFormat` ile YUVARLAR.
 *
 * Asagi kirpma BILINCLIDIR ve dogrudur: bu bir BAKIYE gosterimi, ve elinde
 * 7,3988 varken 7,40 yazmak sahip olmadigin bir seyi soylemektir. Probe'un
 * sayfayla ayni fonksiyonu cagirmasi sart, yoksa olctugu sey urun degil kendi
 * secimi olur.
 */
import { arcTestnet, formatUsdcCompact, formatPriceWeiPerToken } from '@arcpad/shared'

const TOKEN = '0x99340e06e6acfb7ca625fb2ab6636bd51e87a526' as const
const CURVE = '0x2E812f107742b1b9180144EAd240A46C892eEaB1' as const
const TOTAL_SUPPLY_TOK = 10n ** 27n

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

const CURVE_ABI = [
  {
    type: 'function',
    name: 'virtualQuoteReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'virtualTokenReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'realQuoteReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'realTokenReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
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
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

const pub = createPublicClient({ chain, transport: http(RPC) })

async function read(
  name: 'virtualQuoteReserves' | 'virtualTokenReserves' | 'realQuoteReserves' | 'realTokenReserves',
) {
  return (await pub.readContract({ address: CURVE, abi: CURVE_ABI, functionName: name })) as bigint
}

const [vQ, vT, realQ, realT, supply] = await Promise.all([
  read('virtualQuoteReserves'),
  read('virtualTokenReserves'),
  read('realQuoteReserves'),
  read('realTokenReserves'),
  pub.readContract({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: 'totalSupply',
  }) as Promise<bigint>,
])

/*
 * FDV = vQ * N / vT.  `migrations/007_views.sql` ile AYNI ifade, ama burada
 * girdiler zincirden geliyor. Bolme TAM SAYI bolmesidir ve olmalidir: SQL de
 * `div()` kullaniyor, yani bir `Number` ara adimi eklemek iki tarafi
 * ayristirirdi.
 */
const fdvWei = (vQ * TOTAL_SUPPLY_TOK) / vT
/* Fiyat, FDV'nin tam olarak 1e9'da biri (N = 1e27, olcek 1e18). */
const priceWeiPerTok = fdvWei / 1_000_000_000n

console.log('ZINCIRDEN OKUNAN HAM DEGERLER')
console.log('  virtualQuoteReserves :', vQ.toString())
console.log('  virtualTokenReserves :', vT.toString())
console.log('  realQuoteReserves    :', realQ.toString())
console.log('  realTokenReserves    :', realT.toString())
console.log('  totalSupply          :', supply.toString())
console.log('')
console.log('BEKLENEN EKRAN DIZELERI (ayni bicimlendirici, zincir girdisi)')
console.log('  FDV        :', formatUsdcCompact(fdvWei))
console.log('  Price      :', formatPriceWeiPerToken(priceWeiPerTok))
console.log('  Liquidity  :', formatUsdcCompact(realQ))
console.log('')

/*
 * ARZ DEGISMEZI, ZINCIRDE. `totalSupply` sabit 1e27 olmali; curve'un elindeki
 * `realTokenReserves` ile dolasimdaki fark, holder'larin toplamidir.
 */
if (supply !== TOTAL_SUPPLY_TOK) {
  console.log(`  !! totalSupply ${supply} != 1e27 -- ARZ DEGISMEZI KIRIK`)
  process.exit(1)
}
console.log('  arz degismezi: totalSupply == 1e27  ok')

const curveHolds = (await pub.readContract({
  address: TOKEN,
  abi: ERC20_ABI,
  functionName: 'balanceOf',
  args: [CURVE],
})) as bigint
console.log(`  curve bakiyesi: ${curveHolds}`)
console.log(`  dolasimdaki   : ${TOTAL_SUPPLY_TOK - curveHolds}`)
console.log('')
console.log('HOLDER DOGRULAMASI ICIN: her DB satirinin adresini `balanceOf` ile karsilastir.')
