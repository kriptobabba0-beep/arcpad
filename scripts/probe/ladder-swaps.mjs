#!/usr/bin/env node
/**
 * ============================================================================
 *  MERDIVEN -- BES ISLEM, BESER DAKIKA ARAYLA, UC YENI CUZDAN
 * ============================================================================
 *
 * !! BU BETIK GERCEK ISLEM GONDERIR VE PARA HARCAR. Yaklasik 7,6 USDC:
 *    3 x 1,5 fonlama + 2,6 alis + gaz. TESTNET icindir; `RPC` sabiti Arc
 *    testnet'i gosterir ve baska bir aga cevrilmemelidir.
 *
 *    Depodaki diger probe'lar (`verify-numbers`, `verify-quote`) SALT
 *    OKUNURDUR; bu ayrim bilinclidir ve dosya adlarindan degil BU NOTTAN
 *    okunur.
 *
 * Amac ekrandaki UC seyi ayni anda sinamak:
 *
 *   1. 5 DAKIKALIK MUMLAR. Bes islem beser dakika arayla dusunce her biri
 *      KENDI kovasina duser. Bugune kadarki veri iki sikiya kumede oldugu icin
 *      1H ve 24H ayni tek mumu uretiyordu; bu seri 5M'i gercekten doldurur.
 *
 *   2. FDV MERDIVENI. Dort alis fiyati basamak basamak yukari tasir, son
 *      satis geri indirir. Duz bir cizgi yerine bir SEKIL olusur, yani
 *      mumlarin govdesi, fitili ve rengi gorunur hale gelir.
 *
 *   3. HOLDER SAYACI. Uc alis UC AYRI CUZDANDAN gelir, yani sayac 1 -> 4
 *      olmali. Ayni cuzdanla dort kez almak sayaci HIC degistirmezdi ve
 *      "holder sayisi calisiyor mu" sorusunu cevapsiz birakirdi.
 *
 * ============ CUZDANLAR TURETILIR, SAKLANMAZ ============
 *
 * Yeni anahtarlar deployer anahtarindan `keccak256(key || i)` ile turetilir.
 * Hicbir yere YAZILMAZ ve hicbir zaman BASILMAZ -- yalnizca adresleri
 * gorunur. Tekrar uretilebilirler cunku turetme burada yaziyor; guvenligin
 * tamami deployer anahtarindadir, ki o zaten bu makinede.
 *
 * NONCE ELLE YURUTULMEZ: islemler arasinda dakikalar var, yani `pending`
 * nonce yarisini yaratan kosul (arka arkaya gonderim) burada yok.
 */
import { readFileSync } from 'node:fs'
import { concatHex, createPublicClient, createWalletClient, formatUnits, http, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC = 'https://rpc.testnet.arc.network'
const TOKEN = '0x99340e06e6acfb7ca625fb2ab6636bd51e87a526'
const CURVE = '0x2E812f107742b1b9180144EAd240A46C892eEaB1'
const STEP_MS = 5 * 60 * 1000

const chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
}

const CURVE_ABI = [
  {
    type: 'function',
    name: 'buyExactQuoteIn',
    stateMutability: 'payable',
    inputs: [{ name: 'minTokensOut', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sellExactTokensIn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokensIn', type: 'uint256' },
      { name: 'minQuoteOut', type: 'uint256' },
    ],
    outputs: [],
  },
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
]
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
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 's', type: 'address' },
      { name: 'v', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
]

function deployerKey() {
  const raw = readFileSync(new URL('../../.env.deployer', import.meta.url), 'utf8')
  const line = raw.split('\n').find((x) => x.startsWith('DEPLOYER_PRIVATE_KEY='))
  return line.slice('DEPLOYER_PRIVATE_KEY='.length).trim()
}

const pub = createPublicClient({ chain, transport: http(RPC) })
const root = deployerKey()
const deployer = privateKeyToAccount(root)

/** Turetilmis cuzdan. Anahtar DONDURULUR ama asla basilmaz. */
function derived(index) {
  const key = keccak256(concatHex([root, `0x${index.toString(16).padStart(2, '0')}`]))
  return privateKeyToAccount(key)
}

function client(account) {
  return createWalletClient({ account, chain, transport: http(RPC) })
}

const usdc = (wei) => `${Number(formatUnits(wei, 18)).toFixed(4)} USDC`

async function fdv() {
  const [q, t] = await Promise.all([
    pub.readContract({ address: CURVE, abi: CURVE_ABI, functionName: 'virtualQuoteReserves' }),
    pub.readContract({ address: CURVE, abi: CURVE_ABI, functionName: 'virtualTokenReserves' }),
  ])
  // FDV = vQ * N / vT, N = 1e27 (toplam arz).
  return (q * 10n ** 27n) / t
}

async function fund(to, amountWei) {
  const hash = await client(deployer).sendTransaction({
    to,
    value: amountWei,
    chain,
    account: deployer,
  })
  await pub.waitForTransactionReceipt({ hash })
}

async function buy(account, quoteWei, label) {
  const hash = await client(account).writeContract({
    address: CURVE,
    abi: CURVE_ABI,
    functionName: 'buyExactQuoteIn',
    // `minTokensOut: 0` YALNIZCA BURADA KABUL EDILEBILIR: bu bir probe,
    // rakip islem yok ve amac zincire bir mum yazmak. Uretim yolunda bu deger
    // ASLA sifir degildir -- panel `poolPlan`dan gelen slipaj korumasini
    // gonderir.
    args: [0n],
    value: quoteWei,
    chain,
    account,
  })
  const rc = await pub.waitForTransactionReceipt({ hash })
  console.log(`  ${label} ALIS ${usdc(quoteWei)} -> blok ${rc.blockNumber}, FDV ${usdc(await fdv())}`)
}

async function sell(account, label, fraction) {
  const balance = await pub.readContract({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })
  const amount = (balance * BigInt(fraction)) / 100n
  if (amount === 0n) {
    console.log(`  ${label} SATIS atlandi -- bakiye yok`)
    return
  }
  const approveHash = await client(account).writeContract({
    address: TOKEN,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [CURVE, amount],
    chain,
    account,
  })
  await pub.waitForTransactionReceipt({ hash: approveHash })

  const hash = await client(account).writeContract({
    address: CURVE,
    abi: CURVE_ABI,
    functionName: 'sellExactTokensIn',
    args: [amount, 0n],
    chain,
    account,
  })
  const rc = await pub.waitForTransactionReceipt({ hash })
  console.log(
    `  ${label} SATIS %${fraction} -> blok ${rc.blockNumber}, FDV ${usdc(await fdv())}`,
  )
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------

const w1 = derived(1)
const w2 = derived(2)
const w3 = derived(3)

console.log('MERDIVEN -- $LOCKED')
console.log(`token   ${TOKEN}`)
console.log(`curve   ${CURVE}`)
console.log(`baslangic FDV ${usdc(await fdv())}`)
console.log(`cuzdanlar: ${w1.address} ${w2.address} ${w3.address}`)
console.log('')

// Fonlama TEK SEFERDE, merdiven baslamadan: her basamakta fonlamak, o
// basamagin kendi bloguna iki islem koyar ve mumlari kirletirdi.
console.log('cuzdanlar fonlaniyor (her biri 1.5 USDC)...')
for (const [i, w] of [w1, w2, w3].entries()) {
  const have = await pub.getBalance({ address: w.address })
  if (have >= 10n ** 18n) {
    console.log(`  ${i + 1}. cuzdan zaten fonlu (${usdc(have)})`)
    continue
  }
  await fund(w.address, 1_500_000_000_000_000_000n)
  console.log(`  ${i + 1}. cuzdan fonlandi`)
}
console.log('')

/*
 * BASAMAKLAR. Dort alis yukari, son satis asagi -- yani bir tepe ve bir
 * inis. Miktarlar KUCULEREK gider (0.90 -> 0.70 -> 0.55 -> 0.45) cunku egri
 * uzerinde her alis bir oncekinden pahalidir; esit miktarlar giderek KUCULEN
 * basamaklar cizerdi ve merdiven duzlesirdi.
 */
const steps = [
  { at: 0, run: () => buy(deployer, 900_000_000_000_000_000n, 'deployer') },
  { at: 1, run: () => buy(w1, 700_000_000_000_000_000n, 'cuzdan-1') },
  { at: 2, run: () => buy(w2, 550_000_000_000_000_000n, 'cuzdan-2') },
  { at: 3, run: () => buy(w3, 450_000_000_000_000_000n, 'cuzdan-3') },
  { at: 4, run: () => sell(deployer, 'deployer', 35) },
]

const t0 = Date.now()
for (const step of steps) {
  const due = t0 + step.at * STEP_MS
  const sleep = due - Date.now()
  if (sleep > 0) {
    console.log(`+${step.at * 5} dk bekleniyor (${Math.round(sleep / 1000)} sn)...`)
    await wait(sleep)
  }
  console.log(`[+${step.at * 5} dk]`)
  await step.run()
}

console.log('')
console.log(`bitis FDV ${usdc(await fdv())}`)
console.log('SIMDI: indexer 5 dakikalik mumlari ve holder sayisini yansitmali.')
