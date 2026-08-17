import { arcTestnet, createArcClient } from '@arcpad/shared'
import {
  type Account,
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  type Hex,
  http,
  RawContractError,
  type Address,
} from 'viem'
import { withRateLimitRetry } from '../chainReader'
import { LOCKER_ABI } from './abi'
import type { GraduationWriter, ReceiptSummary, SimulateResult } from './executor'

type ArcClient = ReturnType<typeof createArcClient>

/**
 * `GraduationWriter`in TEK gercek uygulamasi. `viemChainReader` ile ayni
 * kural: ICINDE KARAR YOKTUR. viem imzalarini dar arayuze cevirir, hiz siniri
 * icin ayni geri-cekilmeyi kullanir, ve revert'i SINIFLANDIRMAZ -- yalnizca
 * HAM DORT BAYTI cikarir. Siniflandirma `outcome.ts`te, canli RPC olmadan
 * test edilebilen SAF bir fonksiyondadir.
 */
export function viemGraduationWriter(opts: {
  client: ArcClient
  rpcUrl: string
  locker: Address
  /**
   * `undefined` = imzalayan yok. `simulate` yine calisir (`graduate` IZINSIZ
   * oldugu icin `msg.sender`in cevaba etkisi yoktur), `send` ise ADIYLA
   * FIRLATIR. Anahtarsiz bir yurutucunun "yayinladim" demesi mumkun degildir.
   */
  account?: Account | undefined
  /** `eth_call`in `from`u. Imzalayan varsa onun adresidir. */
  caller: Address
  /** Makbuzu beklerken en fazla ne kadar. */
  receiptTimeoutMs?: number
}): GraduationWriter {
  const signer = opts.account
  const wallet =
    signer === undefined
      ? undefined
      : createWalletClient({ account: signer, chain: arcTestnet, transport: http(opts.rpcUrl) })

  return {
    account: opts.caller,

    async simulate(curve: Address, blockNumber: bigint): Promise<SimulateResult> {
      try {
        await withRateLimitRetry(() =>
          opts.client.simulateContract({
            address: opts.locker,
            abi: LOCKER_ABI,
            functionName: 'graduate',
            args: [curve],
            account: opts.caller,
            // ============ BLOGA SABITLENIR ============
            // Bekleyen kume `head`te okundu. Simulasyonu `latest`e karsi
            // yapmak, iki gozlemin farkli bloklardan gelmesi demekti -- Arc'ta
            // blok suresi ~350ms, yani "ardisik iki okuma es zamanli degildir"
            // tuzagi bu depoda ZATEN iki kez yanlis bulgu uretti.
            blockNumber,
          }),
        )
        return { ok: true }
      } catch (error) {
        const revertData = extractRevertData(error)
        if (revertData === undefined) throw error
        return { ok: false, revertData, detail: describe(error) }
      }
    },

    send(curve: Address): Promise<Hex> {
      if (wallet === undefined || signer === undefined) {
        return Promise.reject(
          new Error(
            'this executor has no signer, so it cannot broadcast. KEEPER_DRY_RUN=false requires KEEPER_GRADUATE_PRIVATE_KEY; reaching this line means the two were separated somewhere after config load.',
          ),
        )
      }
      // YENIDEN DENEME YOK. `withRateLimitRetry` OKUMALAR icindir; bir yazma
      // istegini yeniden denemek, kabul edilmis ama henuz gorunmeyen bir
      // islemi IKINCI KEZ gondermektir. Hiz siniri burada arizadir, bir
      // sonraki gecis dener.
      return wallet.writeContract({
        address: opts.locker,
        abi: LOCKER_ABI,
        functionName: 'graduate',
        args: [curve],
        chain: arcTestnet,
        account: signer,
      })
    },

    async wait(hash: Hex): Promise<ReceiptSummary> {
      const receipt = await opts.client.waitForTransactionReceipt({
        hash,
        timeout: opts.receiptTimeoutMs ?? 120_000,
      })
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        transactionHash: receipt.transactionHash,
      }
    },
  }
}

/**
 * HAM REVERT VERISI, viem'in COZUMUNDEN DEGIL.
 *
 * `undefined` doner = "bu bir revert DEGIL" (ag hatasi, hiz siniri, zaman
 * asimi) ve cagiran onu YUKARI FIRLATIR. `null` doner = "revert, ama VERISI
 * YOK" -- kodu olmayan bir adres, gaz bitmesi, ciplak `revert()`. Ikisi ayri
 * seylerdir ve `classifyRevert` de onlari ayri siniflandirir.
 *
 * NEDEN `errorName` KULLANILMIYOR. viem `errorName`i ancak GECILEN ABI'de
 * varsa doldurur; bilmedigi bir hata `undefined` verir, yani "tanimadim" ile
 * "revert degil" AYNI degere duserdi. Dort bayt her zaman oradadir.
 */
export function extractRevertData(error: unknown): string | null | undefined {
  if (!(error instanceof BaseError)) return undefined

  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) {
    // `raw` HER ZAMAN ham `data`dir (viem 2.55.8, errors/contract.js:227
    // `this.raw = data`), ABI onu cozebilse de cozemese de. `signature` ise
    // YALNIZCA cozulemedigi durumda dolar -- yani ikisini de `??` ile almak,
    // "ABI'de var" ve "ABI'de yok" dallarinin IKISINI birden kapsar.
    const raw = reverted.raw ?? reverted.signature
    return typeof raw === 'string' && raw.startsWith('0x') && raw !== '0x' ? raw : null
  }

  const rawContract = error.walk((e) => e instanceof RawContractError)
  if (rawContract instanceof RawContractError) {
    const data = rawContract.data
    if (typeof data === 'string') return data
    if (data !== undefined && typeof data === 'object' && 'data' in data) {
      const inner = (data as { data?: unknown }).data
      if (typeof inner === 'string') return inner
    }
    return null
  }

  // "execution reverted" METNI, VERI OLMADAN. Bazi uclar dort bayti hic
  // vermez; bu hala bir revert'tir ve bir ag hatasi degildir.
  if (/execution reverted/i.test(error.details ?? error.shortMessage ?? '')) return null
  return undefined
}

function describe(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
