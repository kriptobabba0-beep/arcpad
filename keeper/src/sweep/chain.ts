import {
  type CurveState,
  type FeeBps,
  arcTestnet,
  asTok,
  asWei,
  createArcClient,
  planBuyExactQuoteIn,
} from '@arcpad/shared'
import {
  type Account,
  type Address,
  type Hex,
  createWalletClient,
  decodeErrorResult,
  getAddress,
  http,
} from 'viem'
import { withRateLimitRetry } from '../chainReader'
import { extractRevertData } from '../graduate/chain'
import { CURVE_ABI, FACTORY_ABI, TOKEN_ABI, TREASURY_ABI } from './abi'
import type { SendOutcome, SimulateOutcome, SweepChain, TokenBudget, TokenSweepState } from './pass'

type ArcClient = ReturnType<typeof createArcClient>

/**
 * BIR `aggregate3` PARCASINDA KAC TOKEN.
 *
 * `keeper/src/watch/graduationWindow.ts` alt cagri genisligini 500 olarak
 * OLCTU (`DEFAULT_CURVE_BATCH_SUBCALLS`, gerekcesi orada). Butce okumasi token
 * basina IKI alt cagri harcar, dolayisiyla ayni sinir 250 tokene karsilik
 * gelir. Sayi buradan turetilir, ikinci bir olcum olarak yazilmaz.
 */
const SWEEP_BATCH_TOKENS = 250

/**
 * ============ `SweepChain`IN TEK GERCEK UYGULAMASI ============
 *
 * `viemChainReader` ve `viemGraduationWriter` ile AYNI kural: ICINDE KARAR
 * YOKTUR. viem imzalarini dar arayuze cevirir, okumalar icin ayni
 * geri-cekilmeyi kullanir, ve hicbir esigi kendi bilmez.
 *
 * ============ TEKLIF, IKI MERCI, IKI YOL -- VE HICBIRINDE ============
 * ============ MATEMATIK YENIDEN YAZILMAZ                 ============
 *
 * EGRI: `@arcpad/shared`in `planBuyExactQuoteIn`i. Bu, web'in ve denetim
 * kosumunun kullandigi AYNI planlayicidir ve `curve-differential.test.ts` onu
 * canli zincire karsi olcer. Denetim kosumunda ogrenildi: egri matematigini
 * kosum tarafinda YENIDEN YAZMAK uc yanlis kirmizi uretti (`feeOn` YUKARI
 * yuvarlar, `buyExactQuoteIn` INCLUSIVE'dir, cikti formulu `net - 1` tasir).
 * Bir daha yazilmiyor.
 *
 * HAVUZ: `SlippageTooHigh(got, minTokensOut)` bir DONUS KANALIDIR.
 * `minTokensOut = type(uint256).max` ile yapilan bir `eth_call` ZORUNLU olarak
 * duser ve `got` alaninda havuzun GERCEKTEN verecegi miktari tasir -- fiyat
 * etkisi sinirinin kirptigi tutar da DAHIL. Baska bir yolu yoktur:
 * `BuybackTreasury.spendable` mezuniyet sonrasi bir UST SINIR doner ve
 * NatSpec'i "gercekte harcanan tutar `BuybackExecuted` olayindan okunur" der.
 */
export function viemSweepChain(opts: {
  client: ArcClient
  rpcUrl: string
  treasury: Address
  factory: Address
  /** `undefined` = imzalayan yok. `send` ADIYLA FIRLATIR. */
  account?: Account | undefined
  /** `eth_call`in `from`u. Imzalayan varsa onun adresi. */
  caller: Address
  receiptTimeoutMs?: number
}): SweepChain {
  const signer = opts.account
  const wallet =
    signer === undefined
      ? undefined
      : createWalletClient({ account: signer, chain: arcTestnet, transport: http(opts.rpcUrl) })

  const read = <T>(args: Parameters<ArcClient['readContract']>[0]): Promise<T> =>
    withRateLimitRetry(() => opts.client.readContract(args)) as Promise<T>

  return {
    async head(): Promise<bigint> {
      const block = await withRateLimitRetry(() => opts.client.getBlock())
      return block.number
    },

    async accruedTokens(from: bigint, to: bigint): Promise<readonly Address[]> {
      const logs = await withRateLimitRetry(() =>
        opts.client.getLogs({
          address: opts.treasury,
          event: TREASURY_ABI[9] as never,
          fromBlock: from,
          toBlock: to,
        }),
      )
      const out: Address[] = []
      for (const log of logs) {
        const token = (log as { args?: { token?: Address } }).args?.token
        if (token !== undefined) out.push(getAddress(token).toLowerCase() as Address)
      }
      return out
    },

    minSweepWei(blockNumber: bigint): Promise<bigint> {
      return read<bigint>({
        address: opts.treasury,
        abi: TREASURY_ABI,
        functionName: 'MIN_SWEEP_WEI',
        blockNumber,
      })
    },

    async isDesignatedKeeper(blockNumber: bigint): Promise<boolean> {
      const designated = await read<Address>({
        address: opts.factory,
        abi: FACTORY_ABI,
        functionName: 'buybackKeeper',
        blockNumber,
      })
      return getAddress(designated) === getAddress(opts.caller)
    },

    /**
     * ============ UCUZ KAPI, `aggregate3` ILE ============
     *
     * Iki gorunum de HAZINEDE ve tek argumanli, yani token basina IKI alt
     * cagri. Parca genisligi `SWEEP_BATCH_SUBCALLS` (500), dolayisiyla bir
     * `eth_call` **250 tokeni** okur. Bin token -> dort cagri.
     *
     * `multicall`in `allowFailure: false`u KASITLIDIR. Bir alt cagri revert
     * ederse bu fonksiyon FIRLAR; sessizce sifir dondurmek "butcesi yok" ile
     * "okuyamadim"i ayni sey yapardi ve ikincisi bir tokeni SESSIZCE
     * supurulmeden birakirdi -- `chainReader.readContractBatch`in yazili
     * gerekcesiyle ayni.
     */
    async budgets(
      tokens: readonly Address[],
      blockNumber: bigint,
    ): Promise<readonly TokenBudget[]> {
      const out: TokenBudget[] = []
      for (let i = 0; i < tokens.length; i += SWEEP_BATCH_TOKENS) {
        const chunk = tokens.slice(i, i + SWEEP_BATCH_TOKENS)
        const calls = chunk.flatMap((token) => [
          {
            address: opts.treasury,
            abi: TREASURY_ABI,
            functionName: 'spendable' as const,
            args: [token] as const,
          },
          {
            address: opts.treasury,
            abi: TREASURY_ABI,
            functionName: 'sweepIsPermissionless' as const,
            args: [token] as const,
          },
        ])
        const results = (await withRateLimitRetry(() =>
          opts.client.multicall({ contracts: calls as never, allowFailure: false, blockNumber }),
        )) as unknown[]
        for (const [j, token] of chunk.entries()) {
          out.push({
            token,
            spendableWei: results[j * 2] as bigint,
            permissionless: results[j * 2 + 1] as boolean,
          })
        }
      }
      return out
    },

    async readToken(token: Address, blockNumber: bigint): Promise<TokenSweepState> {
      // EGRI TOKENDEN OKUNUR, FABRIKADAN DEGIL. `LaunchToken.curve`
      // `immutable`dir ve fabrika tarafindan yazilir, yani bu okuma bir
      // KANITTIR -- `ArcpadLocker`in ayni gerekcesi.
      const curve = await read<Address>({
        address: token,
        abi: TOKEN_ABI,
        functionName: 'curve',
        blockNumber,
      })
      const [spendableWei, permissionless, graduated] = await Promise.all([
        read<bigint>({
          address: opts.treasury,
          abi: TREASURY_ABI,
          functionName: 'spendable',
          args: [token],
          blockNumber,
        }),
        read<boolean>({
          address: opts.treasury,
          abi: TREASURY_ABI,
          functionName: 'sweepIsPermissionless',
          args: [token],
          blockNumber,
        }),
        read<boolean>({
          address: curve,
          abi: CURVE_ABI,
          functionName: 'graduated',
          blockNumber,
        }),
      ])
      return { token, curve: getAddress(curve), spendableWei, permissionless, graduated }
    },

    async quote(state: TokenSweepState, blockNumber: bigint): Promise<bigint | null> {
      if (state.graduated) return quoteOnPool(state, blockNumber)
      return quoteOnCurve(state, blockNumber)
    },

    async simulate(
      token: Address,
      minTokensOut: bigint,
      deadline: bigint,
      blockNumber: bigint,
    ): Promise<SimulateOutcome> {
      try {
        await withRateLimitRetry(() =>
          opts.client.simulateContract({
            address: opts.treasury,
            abi: TREASURY_ABI,
            functionName: 'sweep',
            args: [token, minTokensOut, deadline],
            account: opts.caller,
            // BLOGA SABITLENIR. Bekleyen butce `head`te okundu; simulasyonu
            // `latest`e karsi yapmak iki gozlemi farkli bloklara koyardi ve
            // Arc'ta blok suresi ~350ms.
            blockNumber,
          }),
        )
        return { ok: true }
      } catch (error) {
        const revertData = extractRevertData(error)
        // AG ARIZASI BIR RED DEGILDIR. `undefined` = revert bile degil;
        // yukari firlatilir ve gecis onu okunamayan token olarak sayar.
        if (revertData === undefined) throw error
        return { ok: false, detail: describeRevert(revertData) }
      }
    },

    send(token: Address, minTokensOut: bigint, deadline: bigint): Promise<Hex> {
      if (wallet === undefined || signer === undefined) {
        return Promise.reject(
          new Error(
            'this sweeper has no signer, so it cannot broadcast. KEEPER_SWEEP_DRY_RUN=false requires KEEPER_SWEEP_PRIVATE_KEY; reaching this line means the two were separated somewhere after config load.',
          ),
        )
      }
      // YENIDEN DENEME YOK -- `graduate/chain.ts` ile ayni gerekce: bir yazma
      // istegini yeniden denemek, kabul edilmis ama henuz gorunmeyen bir
      // islemi ikinci kez gondermektir.
      return wallet.writeContract({
        address: opts.treasury,
        abi: TREASURY_ABI,
        functionName: 'sweep',
        args: [token, minTokensOut, deadline],
        chain: arcTestnet,
        account: signer,
      })
    },

    async wait(hash: Hex): Promise<SendOutcome> {
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

  /**
   * EGRI MERCII. `spendable` burada KESINDIR (`_spendableOnCurve`in kapali
   * form sonucu), dolayisiyla planlayiciya verilecek tutar tam olarak odur.
   *
   * `slipBps: 0` GECILIR ve bu bilinclidir: slipaj `planSweep`in isidir ve
   * politikadan gelir. Burada istenen sey HAM BEKLENTIDIR; iki yerde slipaj
   * uygulamak onu iki kez kirpardi.
   */
  async function quoteOnCurve(state: TokenSweepState, blockNumber: bigint): Promise<bigint | null> {
    const curveRead = <T>(functionName: string): Promise<T> =>
      read<T>({ address: state.curve, abi: CURVE_ABI, functionName, blockNumber })

    const [vt, vq, rt, rq, complete, creator] = await Promise.all([
      curveRead<bigint>('virtualTokenReserves'),
      curveRead<bigint>('virtualQuoteReserves'),
      curveRead<bigint>('realTokenReserves'),
      curveRead<bigint>('realQuoteReserves'),
      curveRead<boolean>('complete'),
      curveRead<Address>('creator'),
    ])

    const curveState: CurveState = {
      virtualTokenReserves: vt,
      virtualQuoteReserves: vq,
      realTokenReserves: asTok(rt),
      realQuoteReserves: asWei(rq),
      complete,
      creator,
    }
    // UCRET ORANLARI EGRIDEN OKUNUR, SABITTEN DEGIL. Egrinin alim yolu
    // `FeeSchedule` kademelerini KULLANMAZ -- o, havuz tarafinin
    // mekanizmasidir; egride oranlar `PROTOCOL_FEE_BPS`/`CREATOR_FEE_BPS`
    // sabitleridir. Yine de OKUNUR: bir gun degisirse kirilmasi gereken sey
    // test degil, bu satirdir.
    const fees: FeeBps = {
      protocolFeeBps: await curveRead<bigint>('PROTOCOL_FEE_BPS'),
      creatorFeeBps: await curveRead<bigint>('CREATOR_FEE_BPS'),
    }

    const profile = {
      virtualTokenReserves: vt,
      virtualQuoteReserves: vq,
      // Profilin `saleSupply`i YALNIZCA ilerleme yuzdesi icin kullanilir ve
      // beklenen cikti miktarini ETKILEMEZ; burada acilis rezervinden
      // turetilmesi guvenlidir.
      saleSupply: asTok(rt),
    }

    try {
      const plan = planBuyExactQuoteIn(curveState, profile, fees, state.spendableWei, 0)
      return plan.tokens
    } catch {
      // Planlayici REDDETTI (tamamlanmis egri, cok kucuk tutar, ...). Bu bir
      // ariza degil bir CEVAPTIR: teklif yok, dolayisiyla supurme yok.
      return null
    }
  }

  /**
   * HAVUZ MERCII. `SlippageTooHigh`in `got` alani.
   *
   * Cagri ZORUNLU olarak duser ve dusmesi BEKLENIR; dusmemesi tek bir seyi
   * gosterir -- havuzun `type(uint256).max` token verdigini, ki imkansizdir.
   * O yuzden basari `null` doner: teshis edilemeyen bir durumda supurmemek
   * dogru cevaptir.
   */
  async function quoteOnPool(state: TokenSweepState, blockNumber: bigint): Promise<bigint | null> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600)
    try {
      await withRateLimitRetry(() =>
        opts.client.simulateContract({
          address: opts.treasury,
          abi: TREASURY_ABI,
          functionName: 'sweep',
          args: [state.token, 2n ** 256n - 1n, deadline],
          account: opts.caller,
          blockNumber,
        }),
      )
      return null
    } catch (error) {
      const data = extractRevertData(error)
      if (typeof data !== 'string') return null
      try {
        const decoded = decodeErrorResult({ abi: TREASURY_ABI, data: data as Hex })
        if (decoded.errorName !== 'SlippageTooHigh') return null
        const got = (decoded.args as readonly bigint[] | undefined)?.[0]
        return typeof got === 'bigint' && got > 0n ? got : null
      } catch {
        return null
      }
    }
  }
}

/**
 * Ham dort bayti OKUNUR bir dizeye cevirir; cozemezse HAM HALINI birakir.
 * Siniflandirma YAPMAZ -- `graduate/outcome.ts`in ayni ayrimi.
 */
export function describeRevert(data: string | null): string {
  if (data === null) return 'reverted without data'
  try {
    const decoded = decodeErrorResult({ abi: TREASURY_ABI, data: data as Hex })
    const args = (decoded.args as readonly unknown[] | undefined) ?? []
    return args.length === 0
      ? decoded.errorName
      : `${decoded.errorName}(${args.map(String).join(', ')})`
  } catch {
    return data
  }
}
