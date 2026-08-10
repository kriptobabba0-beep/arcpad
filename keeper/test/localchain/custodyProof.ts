import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { env as processEnv, exit } from 'node:process'
import {
  createPublicClient,
  createWalletClient,
  type Address,
  type Hex,
  http,
  parseAbi,
  toFunctionSelector,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * ==========================================================================
 *  CUSTODY PROOF -- BASKASI BENIM FONUMLA TICARET YAPABILIR MI?
 * ==========================================================================
 *
 * `pnpm --filter @arcpad/keeper custody-proof`
 *
 * SORU, VE HICBIR URUN OZELLIGINE BAGLI DEGIL: bir islem, SAHIBININ FONUYLA
 * ve SAHIBINE TESLIMATLA, BASKA BIR ADRES tarafindan gonderilebilir mi? Yani
 * arcpad'in bir sunucusu -- keeper -- kullanicinin YERINE ticaret yapabilir
 * mi? Cevap HAYIRSA, bu sunucu bir VEKIL degil bir GOZLEMCIDIR, ve bu, uzerine
 * urun kurulabilecek ya da kurulamayacak bir SINIRDIR.
 *
 * ============ BU DOSYA NEDEN DURUYOR ============
 *
 * Bu olcum ILK KEZ limit emirleri icin yapildi ve o ozellik URUNDEN KALDIRILDI
 * (migration 015). DOSYA KALDI, cunku olctugu sey limit emirlerine ait DEGIL:
 * zincirin kendi custody sinirina ait. "Keeper kullanici adina yapsin" diyen
 * HER gelecek onerinin -- otomatik satis, stop-loss, abonelikli alim, tek
 * tikla ne olursa -- cevabi burada, ve iddia degil OLCUM olarak duruyor.
 * Limit emirleri o onerilerin yalnizca BIRINCISIYDI.
 *
 * Kontratlar dondurulmus oldugu icin bu cevap yeniden muzakere edilemez. Onu
 * degistirmenin tek yolu yeni kontrat yayinlamaktir, ve o gun geldiginde bu
 * dosya "hala boyle mi" sorusunu CALISTIRARAK cevaplar.
 *
 * ============ NASIL ============
 *
 * `anvil --fork-url <Arc testnet>`, yani UZAK durum YEREL bir EVM'de. Hicbir
 * zincire TEK BIR ISLEM bile yayinlanmaz; kullanilan curve canli
 * `0x53Bba88F...44c9` ACIK e2e curve'udur ve fork'ta ona yapilan alim gercek
 * zincirde HICBIR IZ BIRAKMAZ (AGENT-CONTEXT o curve'un acik kalmasini
 * istiyor -- burasi onu kapatmaz cunku burasi zincir degil).
 *
 * FORK'UN TASIYABILECEGI SEY: curve'un alim/satim yolu. Gerekcesi, bu depoda
 * `graduationProof.ts`in tam TERSI: orada locker'in odeme bacagi Arc'in
 * `0x1800...` native precompile'ina indigi icin fork DUSUYORDU. Curve'un alim
 * yolunda oyle bir inis YOKTUR -- `LaunchToken` duz bir OZ ERC20'dur (kendi
 * bytecode'u), `FeeEscrow.deposit` duz bir `call{value:}`dir, iade de oyle.
 * Ve bu VARSAYILMIYOR: ADIM 1 fork'ta gercekten dolan bir alim uretir; dusen
 * bir precompile olsaydi o adim FAIL derdi.
 *
 * ============ NE OLCULUYOR ============
 *
 *   1  Bir ucuncu taraf ("keeper") curve'e `buyExactQuoteIn` gonderir.
 *      TOKENLER KEEPER'A GIDER, fonu harcayan tarafa DEGIL. Kontrol grubu:
 *      ayni cagriyi sahip yaparsa tokenler SAHIBE gider -- yani olculen sey
 *      "kimse alamiyor" degil, "ALAN, CAGIRANDIR".
 *   2  Sahip keeper'a SINIRSIZ `approve` verir. Keeper `sellExactTokensIn`
 *      cagirir. ONAY HICBIR SEY SATIN ALMAZ: curve `transferFrom(msg.sender,
 *      ...)` yapar, yani keeper'in KENDI bakiyesinden ceker ve keeper'in
 *      tokeni yoktur. Kontrol grubu: keeper KENDI aldigi tokenle satabilir --
 *      yani basarisizlik "satis bozuk" degil "onay yanlis tarafta".
 *   3  Curve'de, 1 ve 2'nin kapattigi kapinin YANINDA acik bir kapi yoktur:
 *      gizli bir `buyFor(address)`, bir `executeWithSig`, bir `setOperator`
 *      YOK. `DELEGATION_CANDIDATES`in tamami zincirde tek tek denenir.
 *   4  Ayni probe `ArcpadRouter` icin. Router'in dort takas girisi bir ALICI
 *      (`to`) ALIR ama bir ODEYEN (`payer`) ALMAZ.
 *
 * 3 ve 4'un teknigi BIR DAVRANIS PROBE'UDUR, bir bytecode taramasi DEGIL, ve
 * aradaki fark olculerek ogrenildi. ILK surum bir PUSH4 taramasiydi ve YANLIS
 * CIKTI: curve'de 38 "bilinmeyen" dort-bayt sabiti buldu, neredeyse hepsi ozel
 * hata selector'u (`0xc0ba73dd NotEnoughTokensToBuy`) ya da CAGRILAN tarafin
 * selector'u (`0xa9059cbb transfer`). Dort-bayt SABITLERINI sayiyordu, GIRIS
 * NOKTALARINI degil.
 *
 * Yerine gecen probe, kontratin KENDI davranisini kullanir: `fallback()`
 * olmadigi icin BILINMEYEN bir selector BOS veriyle revert eder, bilinen bir
 * selector ise ya doner ya da DOLU veriyle (bir ozel hatayla) revert eder. Bu
 * ayrimin yanlis pozitifi yoktur, ve KENDI KONTROLUNU TASIR: gercekten var
 * olan girisler (`complete()`, `realTokenReserves()`, `poolManager()`,
 * `hook()`) ayni probe'dan PRESENT olarak gecer -- yani "hicbiri yok" sonucu,
 * probe'un korlugu ile aciklanamaz.
 */

// ---------------------------------------------------------------
// Sabitler -- hepsi ya adres defterinden ya AGENT-CONTEXT'ten
// ---------------------------------------------------------------

const ARC_RPC = processEnv['ARC_RPC_URL'] ?? 'https://rpc.testnet.arc.network'
const REQUESTED_PORT = Number(processEnv['KEEPER_CUSTODY_PORT'] ?? 58_611)

/** ACIK, ticareti yapilabilir e2e curve'u. Fork'ta kullanilir, zincirde DEGIL. */
const OPEN_CURVE = '0x53Bba88F1b9897A8B61c860E9E7413ca1a1644c9' as Address
const OPEN_TOKEN = '0x637aF6afD61bb182C5843895D1E8e6Fb5f56199A' as Address
/** Mezuniyet sonrasi ticaretin tek girisi. `addresses.5042002.json`. */
const ROUTER = '0x6D9f42706C7E7bF3D2Ad3123ca7397DA6F0bB7cd' as Address

/** anvil'in ilk iki gelistirici hesabi. YALNIZCA yerel fork'ta gecerlidir. */
const KEEPER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

/** Bir mikro-USDC'nin 1e12 kati: alanin kuantasi, ve curve icin anlamli. */
const BUY_BUDGET_WEI = 1_000_000_000_000_000n // 0.001 USDC (18-decimal native)

const CURVE_ABI = parseAbi([
  'function buyExactQuoteIn(uint256 minTokensOut) payable',
  'function buyExactTokensOut(uint256 tokensOut, uint256 maxQuoteIn) payable',
  'function sellExactTokensIn(uint256 tokensIn, uint256 minQuoteOut)',
  'function complete() view returns (bool)',
  'function graduated() view returns (bool)',
  'function token() view returns (address)',
  'function realTokenReserves() view returns (uint256)',
])
const TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

const MAX_UINT256 = 2n ** 256n - 1n
/** `ERC20InsufficientBalance(address,uint256,uint256)`. */
const ERC20_INSUFFICIENT_BALANCE = '0xe450d38c'

/**
 * Router'in DORT takas girisi. Her biri bir ALICI (`address to`) alir ve
 * hicbiri bir ODEYEN almaz -- `payer` `_swap` icinde `msg.sender`den yazilir
 * ve `ArcpadRouter.sol`un kendi NatSpec'i onu neden PARAMETRE YAPMADIGINI
 * yaziyor ("o onaylari veren HERKESI herkese acardi").
 */
const ROUTER_SWAP_SIGNATURES = [
  'buyExactIn(address,uint256,uint256,address,uint256)',
  'buyExactOut(address,uint256,uint256,address,uint256)',
  'sellExactIn(address,uint256,uint256,address,uint256)',
  'sellExactOut(address,uint256,uint256,address,uint256)',
] as const

/**
 * DELEGE YETKIYI TASIYABILECEK HER MAKUL IMZA. Hicbirinin var olmamasi
 * beklenir; varlik testi `probeSignatures` ile ZINCIRDE yapilir.
 *
 * Liste iki aileden secildi: (a) baska AMM'lerde gercekten bulunan "birinin
 * adina" girisleri (`*For`, `onBehalfOf`, `recipient` alan versiyonlar),
 * (b) EIP-2612 / EIP-1271 / meta-transaction yuzeyleri, ki bunlar bir
 * keeper'in kullanicinin imzasiyla islem yurutmesinin STANDART yollaridir.
 */
const DELEGATION_CANDIDATES = [
  'buyFor(address,uint256)',
  'buyExactQuoteInFor(address,uint256)',
  'buyExactQuoteIn(uint256,address)',
  'buyExactTokensOut(uint256,uint256,address)',
  'sellFor(address,uint256,uint256)',
  'sellExactTokensInFor(address,uint256,uint256)',
  'sellExactTokensIn(uint256,uint256,address)',
  'buyExactIn(address,uint256,uint256,address,address,uint256)',
  'swapFor(address,address,uint256,uint256)',
  'executeOrder(bytes)',
  'executeWithSig(address,bytes,bytes)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'isValidSignature(bytes32,bytes)',
  'multicall(bytes[])',
  'setOperator(address,bool)',
] as const

// ---------------------------------------------------------------
// Kucuk iddia catisi -- `graduationProof.ts` ile ayni sekil
// ---------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
    return
  }
  failures.push(label)
  console.error(`  FAIL  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
}

async function main(): Promise<number> {
  let anvil: ChildProcess | undefined
  try {
    const head = await liveHead()
    // FORK BLOGU CANLI BASTAN ALINIR ve YAZILIR. Sabit bir blok, e2e curve
    // launch edilmeden onceye dusme riskini tasiyacakti; onun yerine blok
    // RAPORLANIR, yani kosu tekrar edilebilir kalir.
    const forkBlock = head - 8n
    console.log(`[1] forking Arc at block ${forkBlock} (live head ${head}) on 127.0.0.1:${REQUESTED_PORT}`)
    anvil = await startAnvil(REQUESTED_PORT, forkBlock)

    const rpcUrl = `http://127.0.0.1:${REQUESTED_PORT}`
    const client = createPublicClient({ transport: http(rpcUrl) })

    // ISTEDIGIM PORT, ALDIGIM PORT MU -- AGENT-CONTEXT'in Postgres dersi.
    const chainId = await client.getChainId()
    check('the fork answers on the port that was asked for', chainId === 5_042_002, `chainId=${chainId}`)

    const keeper = privateKeyToAccount(KEEPER_KEY)
    const owner = privateKeyToAccount(OWNER_KEY)
    const keeperWallet = createWalletClient({ account: keeper, transport: http(rpcUrl) })
    const ownerWallet = createWalletClient({ account: owner, transport: http(rpcUrl) })

    const [isComplete, isGraduated, boundToken, reserves] = await Promise.all([
      client.readContract({ address: OPEN_CURVE, abi: CURVE_ABI, functionName: 'complete' }),
      client.readContract({ address: OPEN_CURVE, abi: CURVE_ABI, functionName: 'graduated' }),
      client.readContract({ address: OPEN_CURVE, abi: CURVE_ABI, functionName: 'token' }),
      client.readContract({ address: OPEN_CURVE, abi: CURVE_ABI, functionName: 'realTokenReserves' }),
    ])
    check('the fixture curve is OPEN on the fork', !isComplete && !isGraduated, `complete=${isComplete} graduated=${isGraduated}`)
    check('the fixture curve is bound to the fixture token', boundToken.toLowerCase() === OPEN_TOKEN.toLowerCase(), boundToken)
    check('the curve still has sale supply to sell', reserves > 0n, `realTokenReserves=${reserves}`)

    // ---------------------------------------------------------------
    // ADIM 1 -- ALIM: TOKENLER CAGIRANA GIDER, BASKASINA DEGIL
    // ---------------------------------------------------------------
    console.log('[2] a third party buys: who ends up holding the tokens?')
    const beforeKeeper = await tokenBalance(client, keeper.address)
    const beforeOwner = await tokenBalance(client, owner.address)
    check('both accounts start with zero of the token', beforeKeeper === 0n && beforeOwner === 0n, `keeper=${beforeKeeper} owner=${beforeOwner}`)

    const keeperBuy = await keeperWallet.writeContract({
      address: OPEN_CURVE,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: BUY_BUDGET_WEI,
      chain: null,
    })
    const keeperBuyReceipt = await client.waitForTransactionReceipt({ hash: keeperBuy })
    check('the buy actually executed on the fork', keeperBuyReceipt.status === 'success', `status=${keeperBuyReceipt.status}`)

    const afterKeeper = await tokenBalance(client, keeper.address)
    const afterOwner = await tokenBalance(client, owner.address)
    check(
      'THE TOKENS WENT TO THE CALLER (the keeper), not to any other party',
      afterKeeper > 0n,
      `keeper=${afterKeeper}`,
    )
    check(
      'THE ORDER OWNER RECEIVED NOTHING -- there is no recipient parameter to give them',
      afterOwner === 0n,
      `owner=${afterOwner}`,
    )

    // KONTROL GRUBU. Olculen sey "kimse alamiyor" DEGIL, "alan CAGIRANDIR".
    const ownerBuy = await ownerWallet.writeContract({
      address: OPEN_CURVE,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: BUY_BUDGET_WEI,
      chain: null,
    })
    await client.waitForTransactionReceipt({ hash: ownerBuy })
    const ownerAfterOwnBuy = await tokenBalance(client, owner.address)
    check(
      'CONTROL: the same call made BY the owner credits the OWNER',
      ownerAfterOwnBuy > 0n,
      `owner=${ownerAfterOwnBuy}`,
    )

    // ---------------------------------------------------------------
    // ADIM 2 -- ONAY HICBIR SEY SATIN ALMAZ, VE ILK OLCUM BUNU DAHA SERT
    //           SOYLEDI: CURVE'UN ISTEDIGI ONAY YANLIS TARAFTA DEGIL,
    //           BASKA BIR CIFT UZERINDE.
    // ---------------------------------------------------------------
    //
    // ILK KOSU `0xfb8f41b2` = `ERC20InsufficientAllowance` dondu, ki
    // BEKLEDIGIM `ERC20InsufficientBalance` DEGILDI ve daha keskin bir sey
    // soyluyor: curve `transferFrom(msg.sender, address(this), tokensIn)`
    // yapiyor, yani ihtiyac duydugu onay `sahip -> keeper` DEGIL
    // `keeper -> CURVE`dir. Sahibin keeper'a verdigi sinirsiz onay o cagriya
    // HIC GIRMEZ. Bu yuzden asagida keeper curve'e de onay VERIR -- yani
    // "onay eksikti" mazereti tamamen kapanir -- ve geriye kalan tek engel
    // BAKIYENIN KIMDE OLDUGUDUR.
    console.log('[3] the owner grants an unlimited allowance to the keeper. Does it buy anything?')
    await waitFor(client, ownerWallet.writeContract({
      address: OPEN_TOKEN, abi: TOKEN_ABI, functionName: 'approve',
      args: [keeper.address, MAX_UINT256], chain: null,
    }))
    await waitFor(client, keeperWallet.writeContract({
      address: OPEN_TOKEN, abi: TOKEN_ABI, functionName: 'approve',
      args: [OPEN_CURVE, MAX_UINT256], chain: null,
    }))
    const toKeeper = await allowanceOf(client, owner.address, keeper.address)
    const toCurve = await allowanceOf(client, keeper.address, OPEN_CURVE)
    check('the owner -> keeper allowance is in place', toKeeper === MAX_UINT256, `${toKeeper}`)
    check('the keeper -> curve allowance is in place too', toCurve === MAX_UINT256, `${toCurve}`)

    const keeperHeld = await tokenBalance(client, keeper.address)
    const ownerHeld = await tokenBalance(client, owner.address)
    const attempt = await trySell(client, keeperWallet, keeperHeld + ownerHeld)
    check(
      'A SELL OF (keeper + owner) TOKENS REVERTS even with BOTH allowances at max',
      !attempt.ok,
      attempt.ok ? 'it succeeded' : attempt.reason,
    )
    check(
      'and it reverts on BALANCE, not allowance -- the curve pulls from msg.sender',
      !attempt.ok && attempt.reason.includes(ERC20_INSUFFICIENT_BALANCE),
      attempt.ok ? '' : attempt.reason,
    )

    // KONTROL GRUBU. Basarisizlik "satis yolu bozuk" DEGIL: keeper KENDI
    // tokenini satabilir, ve HASILAT DA KEEPER'A GIDER -- iki bacak da
    // `msg.sender`e baglidir, biri degil.
    const keeperNativeBefore = await client.getBalance({ address: keeper.address })
    const ownerNativeBefore = await client.getBalance({ address: owner.address })
    const ownSell = await trySell(client, keeperWallet, keeperHeld)
    check(
      'CONTROL: the keeper CAN sell what it holds ITSELF -- the sell path works',
      ownSell.ok,
      ownSell.ok ? '' : ownSell.reason,
    )
    const ownerNativeAfter = await client.getBalance({ address: owner.address })
    check(
      'THE PROCEEDS WENT TO THE CALLER: the owner\'s native balance did not move',
      ownerNativeAfter === ownerNativeBefore,
      `owner ${ownerNativeBefore} -> ${ownerNativeAfter}`,
    )
    const keeperNativeAfter = await client.getBalance({ address: keeper.address })
    check(
      'CONTROL: the seller\'s own native balance DID move (so the leg is measurable)',
      keeperNativeAfter !== keeperNativeBefore,
      `keeper ${keeperNativeBefore} -> ${keeperNativeAfter}`,
    )

    // ---------------------------------------------------------------
    // ADIM 3 & 4 -- "DELEGE EDILMIS" BIR GIRIS NOKTASI YOK
    // ---------------------------------------------------------------
    //
    // ILK HALI BIR PUSH4 TARAMASIYDI VE ATILDI. Olculdu: curve'un runtime
    // bytecode'unda 38, router'inkinde 5 adet dort-baytlik sabit bilinen
    // ABI'nin disinda cikti ve BUYUK COGUNLUGU FONKSIYON DEGILDI -- ozel hata
    // selector'lari (`0xc0ba73dd` = `NotEnoughTokensToBuy()`, `0x4e487b71` =
    // `Panic(uint256)`), cagrilan ARAYUZLERIN selector'lari (`0xa9059cbb` =
    // `transfer`, `0x23b872dd` = `transferFrom`, `0x70a08231` = `balanceOf`,
    // `0xf340fa01` = `deposit(address)`) ve derleyici sabitleri. Yani tarama
    // "bilinmeyen giris noktasi" degil "dort baytlik sabit" sayiyordu ve
    // IDDIAYI TASIYAMAZDI.
    //
    // YERINE GECEN SEY DAVRANISI OLCER: her iki kontrat da `fallback()`
    // TASIMAZ, dolayisiyla BILINMEYEN bir selector BOS VERIYLE (`0x`) revert
    // eder, BILINEN bir fonksiyon ise ya deger doner ya dort baytlik bir hata
    // doner. Boylece "bu imza var mi" sorusu tek bir `eth_call` ile, yanlis
    // pozitifsiz cevaplanir. Aday listesi, delege yetkiyi TASIYABILECEK her
    // makul isimdir; hicbiri var olmamalidir.
    console.log('[4] does a delegated entrypoint exist on the DEPLOYED code?')
    const curveProbe = await probeSignatures(client, OPEN_CURVE, DELEGATION_CANDIDATES)
    check(
      'BondingCurve: NOT ONE delegated entrypoint exists on chain',
      curveProbe.present.length === 0,
      curveProbe.present.join(','),
    )
    const routerProbe = await probeSignatures(client, ROUTER, DELEGATION_CANDIDATES)
    check(
      'ArcpadRouter: NOT ONE delegated entrypoint exists on chain',
      routerProbe.present.length === 0,
      routerProbe.present.join(','),
    )
    // POZITIF KONTROL. Bir probe'un HER ZAMAN "yok" demesi, hicbir sey
    // olcmemekle ayni gorunur; bu satirlar probe'un VAR olani gordugunu
    // gosterir.
    const curveControl = await probeSignatures(client, OPEN_CURVE, ['complete()', 'realTokenReserves()'])
    check(
      'CONTROL: the same probe DOES see the curve\'s real entrypoints',
      curveControl.present.length === 2,
      curveControl.present.join(','),
    )
    const routerControl = await probeSignatures(client, ROUTER, ['poolManager()', 'hook()'])
    check(
      'CONTROL: the same probe DOES see the router\'s real entrypoints',
      routerControl.present.length === 2,
      routerControl.present.join(','),
    )
    check(
      "the router's four swap signatures take a recipient but NOT a payer",
      ROUTER_SWAP_SIGNATURES.every((s) => s.endsWith('address,uint256)')),
      ROUTER_SWAP_SIGNATURES.join(' '),
    )

    console.log('')
    console.log(`fork block ${forkBlock} -- ${passed} checks passed, ${failures.length} failed`)
    if (failures.length > 0) {
      for (const f of failures) console.error(`  FAILED: ${f}`)
      return 1
    }
    console.log('CUSTODY VERDICT: no address other than the fund owner can trade the owner\'s funds')
    console.log('                 into the owner\'s hands on either venue. The keeper cannot trade')
    console.log('                 on a user\'s behalf, and no delegated entrypoint exists to let it.')
    return 0
  } finally {
    if (anvil !== undefined) await stopAnvil(anvil)
  }
}

// ---------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------

type PublicClient = ReturnType<typeof createPublicClient>
type Wallet = ReturnType<typeof createWalletClient>

async function tokenBalance(client: PublicClient, who: Address): Promise<bigint> {
  return client.readContract({ address: OPEN_TOKEN, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] })
}

/** Bir satisi DENER. Revert bir ARIZA DEGIL, olculen sonucun kendisidir. */
async function trySell(
  client: PublicClient,
  wallet: Wallet,
  tokensIn: bigint,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (tokensIn === 0n) return { ok: false, reason: 'nothing to sell' }
  try {
    const hash = await wallet.writeContract({
      address: OPEN_CURVE,
      abi: CURVE_ABI,
      functionName: 'sellExactTokensIn',
      args: [tokensIn, 0n],
      chain: null,
      account: wallet.account ?? null,
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    return receipt.status === 'success' ? { ok: true } : { ok: false, reason: 'reverted' }
  } catch (error) {
    return { ok: false, reason: shortError(error) }
  }
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const data = revertDataOf(error)
  return `${data ?? ''} ${text}`.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * BIR IMZA ZINCIRDE VAR MI? Tek bir `eth_call`, yanlis pozitifsiz.
 *
 * Ne `BondingCurve` ne `ArcpadRouter` bir `fallback()` tasir, dolayisiyla
 * dispatcher eslesmeyen bir selector'da BOS VERIYLE (`revert(0,0)`) duser.
 * Buradaki ayrim tam olarak odur:
 *
 *   bos veriyle revert   -> imza YOK          (dispatcher'in fallthrough'u)
 *   deger doner          -> imza VAR
 *   4+ baytla revert     -> imza VAR ve calisti, sonra kendi hatasini attı
 *
 * Argumanlar SIFIRLA doldurulur; hicbir aday `payable` olmadigi icin `value`
 * gonderilmez, yani bir yanlislikla gercek bir islem yapilamaz -- ve zaten
 * `eth_call`dir, durum yazmaz.
 */
async function probeSignatures(
  client: PublicClient,
  address: Address,
  signatures: readonly string[],
): Promise<{ present: string[]; absent: string[] }> {
  const code = await client.getCode({ address })
  if (code === undefined || code === '0x') throw new Error(`${address} carries no code on the fork`)
  const present: string[] = []
  const absent: string[] = []
  for (const signature of signatures) {
    const selector = toFunctionSelector(signature)
    // Argumanlarin sayisi kadar sifir kelime. Fazlasi zararsizdir (solc
    // calldata boyunu dogrulamaz), eksigi `calldataload`u sifir okutur.
    const words = signature.slice(signature.indexOf('(') + 1, -1)
    const arity = words === '' ? 0 : words.split(',').length
    const data = `${selector}${'0'.repeat(64 * arity)}` as Hex
    try {
      await client.call({ to: address, data })
      present.push(signature)
    } catch (error) {
      // viem bos veriyle donen revert'i `data: undefined` olarak tasir; bir
      // ozel hata ise `0x`ten uzun bir `data` tasir.
      const revertData = revertDataOf(error)
      if (revertData !== null && revertData.length > 2) present.push(signature)
      else absent.push(signature)
    }
  }
  return { present, absent }
}

/** viem'in hata zincirinde tasidigi ham revert verisi. */
function revertDataOf(error: unknown): string | null {
  for (let node = error, depth = 0; node !== null && node !== undefined && depth < 12; depth += 1) {
    const o = node as { data?: unknown; raw?: unknown; cause?: unknown }
    if (typeof o.data === 'string' && o.data.startsWith('0x')) return o.data
    if (typeof o.raw === 'string' && o.raw.startsWith('0x')) return o.raw
    node = o.cause
  }
  return null
}

async function allowanceOf(client: PublicClient, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({
    address: OPEN_TOKEN,
    abi: TOKEN_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  })
}

async function waitFor(client: PublicClient, sent: Promise<Hex>): Promise<void> {
  const hash = await sent
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
}

async function liveHead(): Promise<bigint> {
  const client = createPublicClient({ transport: http(ARC_RPC) })
  return client.getBlockNumber()
}

function anvilBinary(): string {
  return processEnv['ANVIL_BIN'] ?? 'anvil'
}

async function assertPortIsFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) => reject(new Error(`port ${port} is not free: ${String(error)}`)))
    probe.once('listening', () => probe.close(() => resolve()))
    probe.listen(port, '127.0.0.1')
  })
}

async function startAnvil(port: number, forkBlock: bigint): Promise<ChildProcess> {
  await assertPortIsFree(port)
  const child = spawn(
    anvilBinary(),
    [
      '--fork-url',
      ARC_RPC,
      '--fork-block-number',
      String(forkBlock),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let fatal: string | undefined
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text === '') return
    console.error(`  [anvil] ${text}`)
    if (/os error 10048|address( already)? in use/i.test(text)) fatal = text
  })

  const deadline = Date.now() + 180_000
  for (;;) {
    if (fatal !== undefined) throw new Error(`anvil could not bind port ${port}: ${fatal}`)
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`)
    try {
      const probe = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) })
      await probe.getChainId()
      return child
    } catch {
      if (Date.now() > deadline) throw new Error(`anvil did not come up on port ${port}`)
      await new Promise((done) => setTimeout(done, 500))
    }
  }
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
  // WINDOWS SIGORTASI -- `graduationProof.ts` ile ayni gerekce: `SIGTERM`
  // burada gercek bir sinyal degildir ve surec agaci hayatta kalabilir.
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    console.error(error)
    exit(1)
  },
)
