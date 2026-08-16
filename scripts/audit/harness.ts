/**
 * ============================================================================
 *  CANLI ZINCIR DENETIM KOSUMU -- Arc testnet'e GERCEK islem gonderir
 * ============================================================================
 *
 * !! BU DOSYA PARA HARCAR. `scripts/probe/verify-*` SALT OKUNURDUR; bu
 *    degildir, ve ayrim dosya adindan degil BU NOTTAN okunur.
 *
 * ============ NEDEN BIR FORGE SCRIPT'I DEGIL ============
 *
 * Bir `forge script --broadcast` diziyi TEK bir yayin olarak surer: ortadaki
 * bir `require` duserse ONCEKI adimlar da geri alinir ve kampanya hicbir sey
 * ogretmeden biter. Bir denetim kampanyasinin istedigi bunun TERSIDIR --
 * her vaka BAGIMSIZ yurumeli, dusen vaka KAYDEDILMELI, ve kosu devam
 * etmelidir. Yuzlerce vakada ilk hatada durmak, kalan yuzlerce hakkinda
 * hicbir sey soylemez.
 *
 * ============ ABI'LER ELLE YAZILMAZ ============
 *
 * `@arcpad/shared` dagitilan ABI'yi tasir ve `abi-parity` onu derlenmis
 * artifact ile IKI YONDE karsilastirir. Buraya elle bir ABI yazmak, ikinci bir
 * dogruluk kaynagi yaratirdi -- ve yanlis yazilmis bir imza, hicbir sey
 * kirmizi olmadan yanlis fonksiyonu cagirirdi.
 *
 * ============ CUZDANLAR TURETILIR, SAKLANMAZ ============
 *
 * `keccak256(deployerKey || etiket)`. Hicbir yere yazilmaz, hicbir zaman
 * basilmaz; yalnizca adresleri gorunur. Guvenligin tamami deployer
 * anahtarindadir, ki o zaten bu makinede (`.env.deployer`).
 */
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  formatEther,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ARCPAD_ERROR_ABI } from '../../packages/shared/src/abi/index'
import { arcTestnet, ARC_TESTNET_CHAIN_ID } from '../../packages/shared/src/chain'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/**
 * ZINCIR KAYITTAN GELIR, BURADA YENIDEN TANIMLANMAZ.
 *
 * Ilk surum zincir kimligini ve adi buraya SABIT yazdi ve
 * `chain-registry.test.ts` -- dogru olarak -- kirmizi oldu: kural, chain id ve
 * Arc host'larinin YALNIZCA kayitta yasamasidir. Gerekcesi kapinin kendi
 * yorumunda yazili: dagilmis literaller "yeni bir ag eklemek" isini bir kayit
 * girisinden bir AVA cevirir.
 */
export const ARC = arcTestnet

function envLine(file: string, key: string): string {
  const raw = readFileSync(join(REPO, file), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim()
  }
  throw new Error(`${file} icinde ${key} yok`)
}

function rpcUrl(): string {
  return envLine('.env', 'ARC_RPC_URL')
}

export interface Book {
  launchFactory: Address
  feeEscrow: Address
  governor: Address
  protocolTreasury: Address
  feeSchedule: Address
  poolManager: Address
  arcpadHook: Address
  arcpadLocker: Address
  arcpadRouter: Address
  virtualTokenReserves: string
  virtualQuoteReserves: string
  saleSupply: string
  totalSupply: string
}

export function book(): Book {
  // DOSYA ADI DA KAYITTAN KURULUR. `addresses.5042002.json` diye yazmak chain
  // id'yi ikinci bir yere kopyalamak olurdu ve kayit kapisi -- dogru olarak --
  // bunu da sizinti sayar: bir gun ikinci bir ag eklendiginde bu satir sessizce
  // yanlis dosyayi okurdu.
  const file = join(REPO, 'contracts/deploy', `addresses.${ARC_TESTNET_CHAIN_ID}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Book
}

/**
 * ARC ES ZAMANLI ISTEKLERI SINIRLAR -- her cagri TEK bir siradan gecer.
 *
 * `indexer/src/logs.ts::createPacer`in aynisinin kucugu. Burada
 * ithal EDILMIYOR cunku o paket bir `Queryable` ve bir konfigurasyon zinciri
 * getirir; kopyalanan sey on satirlik bir kuyruk, ve olculmus gerekcesi
 * orada yazili.
 */
/**
 * GECICI ARC HATALARI -- MESAJDAN TANINIR, cunku kod her zaman gelmez.
 *
 * OLCULDU: kirk adimlik bir stres dongusu "Request exceeds defined limit." ile
 * dustu ve bir simulasyon "The request took too long to respond." aldi. Ikisi
 * de ZINCIR HAKKINDA HICBIR SEY SOYLEMEZ -- ama yeniden denemeyen bir kosumda
 * "kontrat bozuk" gibi okunurlar, ve bir denetim kampanyasinda en pahali sey
 * budur: altyapi gurultusunu bulgu sanmak.
 *
 * Kalici hatalar (revert) BURADAN GECMEZ ve gecmemeli: bir `SlippageExceeded`
 * bes kez tekrar denenirse kampanya bes kat yavaslar ve sonuc degismez.
 */
const TRANSIENT = [
  'exceeds defined limit',
  'took too long to respond',
  'rate limit',
  'too many requests',
  'timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'socket hang up',
  'fetch failed',
  'service unavailable',
]

function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  if (code === -32005 || code === 429 || code === 503) return true
  const text = error instanceof Error ? `${error.message}` : String(error)
  const lower = text.toLowerCase()
  return TRANSIENT.some((needle) => lower.includes(needle.toLowerCase()))
}

/**
 * TEK SIRA + GERI CEKILME.
 *
 * `indexer/src/logs.ts::createPacer`in kucugu, arti bir retry merdiveni.
 * Merdiven USTEL: 1s, 2s, 4s, 8s, 16s. Sabit araliklı bir merdiven Arc'in
 * maliyet butcesi dolduğunda onu doldurmaya devam ederdi.
 */
class Pacer {
  private chain: Promise<unknown> = Promise.resolve()
  /** Kac kez geri cekildik -- rapora girer; sessiz bir toparlanma olculemez. */
  retries = 0

  constructor(
    private readonly gapMs: number,
    private readonly attempts: number,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        try {
          const out = await fn()
          await sleep(this.gapMs)
          return out
        } catch (error) {
          if (!isTransient(error)) throw error
          lastError = error
          this.retries += 1
          const backoff = 1000 * 2 ** attempt
          console.log(`    (gecici RPC hatasi, ${backoff}ms sonra tekrar)`)
          await sleep(backoff)
        }
      }
      throw lastError
    })
    this.chain = next.catch(() => undefined)
    return next as Promise<T>
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const pacer = new Pacer(
  Number(process.env['ARC_PACE_MS'] ?? 250),
  Number(process.env['ARC_ATTEMPTS'] ?? 6),
)

export function clients(): { pub: PublicClient; rpc: string } {
  const rpc = rpcUrl()
  const pub = createPublicClient({
    chain: ARC,
    // `retryCount: 0` -- viem'in varsayilani (3) TEK bir paced istegi DORT
    // bosluksuz HTTP istegine cevirir ve bunu pacer'in GORMEDIGI yerde yapar.
    // Indexer ayni satiri ayni gerekceyle tasiyor.
    transport: http(rpc, { retryCount: 0 }),
  }) as PublicClient
  return { pub, rpc }
}

export function deployerKey(): Hex {
  return envLine('.env.deployer', 'DEPLOYER_PRIVATE_KEY') as Hex
}

/** `keccak256(deployerKey || etiket)` -- tekrar uretilebilir, saklanmaz. */
export function derivedKey(label: string): Hex {
  return keccak256(concatHex([deployerKey(), toHex(label)]))
}

export function wallet(key: Hex): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: ARC,
    transport: http(rpcUrl(), { retryCount: 0 }),
  })
}

// ---------------------------------------------------------------------------
// Vaka kaydi
// ---------------------------------------------------------------------------

export type Outcome = 'pass' | 'fail' | 'skip'

export interface CaseResult {
  phase: string
  name: string
  outcome: Outcome
  detail: string
  txHash?: Hex
  gasUsed?: string
}

export class Campaign {
  readonly results: CaseResult[] = []
  private phaseName = '-'
  /** Kampanyanin BASLANGIC bakiyesi; rapor harcamayi buradan cikarir. */
  startBalanceWei = 0n

  phase(name: string): void {
    this.phaseName = name
    console.log(`\n=== ${name} ===`)
  }

  private record(r: CaseResult): void {
    this.results.push(r)
    const mark = r.outcome === 'pass' ? 'OK  ' : r.outcome === 'skip' ? 'ATLA' : 'DUS '
    console.log(`  ${mark} ${r.name}${r.detail === '' ? '' : ` -- ${r.detail}`}`)
  }

  /**
   * Bir vakayi kosar. ATMASI beklenmez; atarsa DUS olarak kaydedilir ve
   * kampanya DEVAM EDER.
   *
   * `detail` donduren bir vaka onu rapora yazar -- olculen sayiyi kaydetmek,
   * "gecti" demekten her zaman daha degerlidir.
   */
  async check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
    try {
      const detail = await fn()
      this.record({ phase: this.phaseName, name, outcome: 'pass', detail: detail ?? '' })
      return true
    } catch (error) {
      this.record({
        phase: this.phaseName,
        name,
        outcome: 'fail',
        detail: describe(error),
      })
      return false
    }
  }

  skip(name: string, why: string): void {
    this.record({ phase: this.phaseName, name, outcome: 'skip', detail: why })
  }

  /**
   * BIR CAGRININ BELIRLI BIR HATAYLA DUSMESI beklenir.
   *
   * `expected` bir hata ADIDIR (`NotKeeper`) ve `ARCPAD_ERROR_ABI` uzerinden
   * cozulur. Yalnizca "revert etti" demek YETMEZ: yanlis sebeple revert eden
   * bir cagri, korumanin calistigini degil BASKA bir seyin bozuk oldugunu
   * gosterir -- ve iki hal ayni yesili verirdi.
   */
  async expectRevert(name: string, expected: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn()
      this.record({
        phase: this.phaseName,
        name,
        outcome: 'fail',
        detail: `revert BEKLENIYORDU (${expected}), cagri BASARILI oldu`,
      })
      return false
    } catch (error) {
      const decoded = revertName(error)
      if (decoded === expected) {
        this.record({ phase: this.phaseName, name, outcome: 'pass', detail: expected })
        return true
      }
      this.record({
        phase: this.phaseName,
        name,
        outcome: 'fail',
        detail: `${expected} bekleniyordu, ${decoded ?? describe(error)} geldi`,
      })
      return false
    }
  }

  get passed(): number {
    return this.results.filter((r) => r.outcome === 'pass').length
  }
  get failed(): number {
    return this.results.filter((r) => r.outcome === 'fail').length
  }
  get skipped(): number {
    return this.results.filter((r) => r.outcome === 'skip').length
  }

  async report(file: string, spentWei: bigint): Promise<void> {
    const payload = {
      chainId: ARC.id,
      finishedAt: new Date().toISOString(),
      passed: this.passed,
      failed: this.failed,
      skipped: this.skipped,
      // GERI CEKILME SAYISI RAPORA GIRER. Sessiz bir toparlanma ile hic
      // olmayan bir sorun ayni loga sahiptir; bu depo o dersi indexer'da
      // ayrica kaydetti.
      rpcRetries: pacer.retries,
      spentUsdc: formatEther(spentWei),
      results: this.results,
    }
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(
      `\n=== TOPLAM: ${this.passed} gecti, ${this.failed} dustu, ${this.skipped} atlandi ` +
        `(harcanan ${formatEther(spentWei)} USDC) ===`,
    )
    if (this.failed > 0) {
      console.log('\nDUSENLER:')
      for (const r of this.results.filter((x) => x.outcome === 'fail')) {
        console.log(`  [${r.phase}] ${r.name}: ${r.detail}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Hata cozme
// ---------------------------------------------------------------------------

/** Bir viem hatasindan arcpad hata ADINI cikarir; cozemezse `null`. */
export function revertName(error: unknown): string | null {
  const data = revertData(error)
  if (data === null) return null
  try {
    return decodeErrorResult({ abi: ARCPAD_ERROR_ABI as Abi, data }).errorName
  } catch {
    // Panic ve Error(string) ARCPAD sozlugunde YOKTUR; ikisi de mesru
    // cevaplardir ve adlariyla donerler.
    if (data.startsWith('0x4e487b71')) return `Panic(0x${data.slice(-2)})`
    if (data.startsWith('0x08c379a0')) return 'Error(string)'
    return null
  }
}

function revertData(error: unknown): Hex | null {
  let cursor: unknown = error
  for (let depth = 0; depth < 12 && cursor !== null && cursor !== undefined; depth += 1) {
    const node = cursor as { data?: unknown; cause?: unknown }
    const data = node.data
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) return data as Hex
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { data?: unknown }).data === 'string'
    ) {
      return (data as { data: Hex }).data
    }
    cursor = node.cause
  }
  return null
}

export function describe(error: unknown): string {
  const name = revertName(error)
  if (name !== null) return `revert ${name}`
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]?.slice(0, 200) ?? 'bilinmeyen hata'
}

// ---------------------------------------------------------------------------
// Islem yardimcilari
// ---------------------------------------------------------------------------

export interface SendResult {
  hash: Hex
  gasUsed: bigint
  blockNumber: bigint
  /**
   * FIILEN ODENEN gaz, wei.
   *
   * ============ `tx.gasPrice` DEGIL, `receipt.effectiveGasPrice` ============
   *
   * OLCULDU VE IKI VAKAYI SAHTE KIRMIZI YAPTI. EIP-1559'da `tx.gasPrice`
   * AZAMI ucrettir (`maxFeePerGas`), zincirin tahsil ettigi degil. Aradaki
   * fark bu kosuda ~3,4 gwei'ydi ve bir satista 5,04e14 wei ediyordu -- yani
   * "planlayici zincirle ayrisiyor" gibi gorunen sey tamamen olcum hatasiydi.
   *
   * Bakiye farkindan gaz duserek net odemeyi bulan HER vaka bu alani
   * kullanmali; `gasUsed * tx.gasPrice` yazan bir vaka satista fazla, alista
   * eksik olcer -- ve iki yon de "kontrat bozuk" gibi okunur.
   */
  feeWei: bigint
}

/**
 * Bir islem gonderir ve MAKBUZU BEKLER.
 *
 * Nonce ELLE YURUTULMEZ: her cagri makbuzu bekledigi icin `pending` nonce
 * yarisini yaratan kosul (arka arkaya gonderim) olusmaz. Bedeli hiz, kazanci
 * her adimin zincire GERCEKTEN indigini bilmek -- bir denetim kampanyasinda
 * dogru takas budur.
 *
 * `status === 'reverted'` bir ISTISNA olarak firlatilir: makbuzu sessizce
 * dondurmek, "islem gonderildi" ile "islem calisti" arasindaki farki kaybeder.
 */
export async function send(
  pub: PublicClient,
  w: WalletClient,
  request: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
    value?: bigint
  },
): Promise<SendResult> {
  const account = w.account
  if (account === undefined) throw new Error('cuzdanin hesabi yok')
  // SIMULASYON ONCE: revert eden bir cagri boylece GAZ HARCAMADAN ve ARCPAD
  // hata adiyla doner. `expectRevert` tam olarak buna dayanir.
  const { request: prepared } = await pacer.run(() =>
    pub.simulateContract({
      account,
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      ...(request.args === undefined ? {} : { args: request.args }),
      ...(request.value === undefined ? {} : { value: request.value }),
    }),
  )
  const hash = await pacer.run(() => w.writeContract(prepared))
  const receipt = await pacer.run(() => pub.waitForTransactionReceipt({ hash }))
  if (receipt.status !== 'success') throw new Error(`islem REVERT etti: ${hash}`)
  return {
    hash,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
  }
}

/** Salt okuma. Pacer'dan gecer. */
export async function read<T>(
  pub: PublicClient,
  request: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<T> {
  return pacer.run(() =>
    pub.readContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      ...(request.args === undefined ? {} : { args: request.args }),
    }),
  ) as Promise<T>
}

export async function balance(pub: PublicClient, address: Address): Promise<bigint> {
  return pacer.run(() => pub.getBalance({ address }))
}

/** Iddia; mesaji OLCULEN degeri tasir, yalnizca "beklenen != gelen" degil. */
export function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

export function mustEqual(actual: unknown, expected: unknown, what: string): void {
  const a = typeof actual === 'bigint' ? actual.toString() : String(actual)
  const e = typeof expected === 'bigint' ? expected.toString() : String(expected)
  if (a !== e) throw new Error(`${what}: beklenen ${e}, olculen ${a}`)
}
