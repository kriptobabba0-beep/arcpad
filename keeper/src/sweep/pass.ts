import type { Address, Hex } from 'viem'
import {
  DEFAULT_SWEEP_POLICY,
  type SkipReason,
  type SweepDecision,
  type SweepPassSummary,
  type SweepPolicy,
  emptySummary,
  foldDecision,
  planSweep,
} from './decide'

/**
 * ============================================================================
 *  SUPURME GECISI -- KARARIN CEVRESINDEKI YURUTME
 * ============================================================================
 *
 * NICIN VAR. `decide.ts` KARARI verir ve 19 testi vardir; bu dosyadan once o
 * kararı CAGIRAN hicbir sey YOKTU. Olculdu: `planSweep`in tek referansi kendi
 * test dosyasiydi -- yani buyback ozelliginin anahtarcisi bir MODULDU, bir
 * SUREC degil.
 *
 * Sonucu sessizdi ve tam olarak bu deponun tekrar tekrar odedigi sekildeydi:
 * hicbir test kirmizi olmaz, hicbir alarm calmaz, para hazinede birikir ve
 * `SWEEP_GRACE` (7 gun) dolduktan sonra supurme IZINSIZ hale gelir. O andan
 * itibaren supurmeyi CAGIRAN taraf `minTokensOut`u da SECER -- yani sifir
 * gecebilir, yani slipaj korumasi kapanir. Anahtarcinin var olma sebebi
 * tam olarak o yedi gundur.
 *
 * ZINCIRE DOKUNAN HER SEY `SweepChain` ARKASINDA. `graduate/executor.ts`in
 * ogrettigi kural: karar veren kod RPC taklidine baglanirsa, taklit gercekten
 * sapar. Burada gecis TAMAMEN enjekte edilmis bir arayuze karsi kosar ve
 * `test/sweep-pass.test.ts` onu gercek bir dugum olmadan yurutur.
 *
 * ============ CIFT GONDERIM ZINCIRDE KAPALI, BURADA DEGIL ============
 *
 * Bir dosya kilidi YOKTUR ve gerekmez: `sweep` ETKILERI ONCE yazar
 * (`pendingQuote[token] = 0`, `BuybackTreasury.sol:206`), dolayisiyla ayni
 * tokene ikinci bir supurme `NothingPending` ile duser. Iki surecin ayni anda
 * kosmasi GAZ kaybettirir, PARA kaybettirmez. `graduate`in kilidi baska bir
 * sey icindir (orada ikinci cagri `PoolAlreadyInitialized` ile TUM mezuniyeti
 * dusururdu).
 */

/** Bir tokenin, karar icin gereken zincir durumu -- TEK BLOKTAN okunmus. */
export type TokenSweepState = {
  readonly token: Address
  readonly curve: Address
  /** `BuybackTreasury.spendable(token)`. Mezuniyet sonrasi UST SINIRDIR. */
  readonly spendableWei: bigint
  readonly permissionless: boolean
  /** `true` ise merci havuzdur, egri degil. Teklifin kaynagini belirler. */
  readonly graduated: boolean
}

export type SendOutcome = {
  readonly status: 'success' | 'reverted'
  readonly blockNumber: bigint
  readonly gasUsed: bigint
  readonly transactionHash: Hex
}

export type SimulateOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string }

/**
 * Gecisin zincirle konustugu TEK yuzey. Icinde KARAR YOKTUR -- `chainReader`
 * ve `graduate/chain.ts` ile ayni kural.
 */
export interface SweepChain {
  /** Butun okumalarin sabitlendigi blok. Arc'ta blok ~350ms; iki okuma es
   *  zamanli DEGILDIR ve bu depoda o tuzak iki kez yanlis bulgu uretti. */
  head(): Promise<bigint>
  /** `[from, to]` araligindaki `BuybackAccrued` loglarindaki tokenlar. */
  accruedTokens(from: bigint, to: bigint): Promise<readonly Address[]>
  /** `MIN_SWEEP_WEI` -- KONTRATTAN, keeper tarafinda literal DEGIL. */
  minSweepWei(blockNumber: bigint): Promise<bigint>
  /** Bu anahtarci fabrikanin kayitli anahtarcisi mi. */
  isDesignatedKeeper(blockNumber: bigint): Promise<boolean>
  readToken(token: Address, blockNumber: bigint): Promise<TokenSweepState>
  /**
   * Supurmenin GERCEKTEN uretecegi token miktari. `null` = bilinemedi.
   *
   * Egri mercii icin `@arcpad/shared`in SEVKEDILMIS planlayicisi kullanilir
   * (`planBuyExactQuoteIn`); havuz mercii icin `SlippageTooHigh(got, ...)`
   * donus kanali okunur. Ikisi de matematigi YENIDEN YAZMAZ -- bu deponun
   * denetim kosumunda uc yanlis kirmizi tam olarak yeniden yazmaktan cikti.
   */
  quote(state: TokenSweepState, blockNumber: bigint): Promise<bigint | null>
  /** Gercek `sweep`i `eth_call` ile dener. Gondermeden ONCE, her zaman. */
  simulate(
    token: Address,
    minTokensOut: bigint,
    deadline: bigint,
    blockNumber: bigint,
  ): Promise<SimulateOutcome>
  send(token: Address, minTokensOut: bigint, deadline: bigint): Promise<Hex>
  wait(hash: Hex): Promise<SendOutcome>
}

export type SweepPassDeps = {
  readonly chain: SweepChain
  /** Bu gecisin bakacagi tokenlar. Kesif cagirana aittir; bkz. `candidates`. */
  readonly tokens: readonly Address[]
  readonly nowSeconds: number
  /** Test belirler, uretimde `crypto.randomInt`. Bkz. `decide.ts`. */
  readonly jitterSeed: () => number
  readonly policy?: SweepPolicy
  /** `true` ise HICBIR SEY GONDERILMEZ; simulasyona kadar her sey kosar. */
  readonly dryRun: boolean
  /** Jitter beklemesi. Test aninda gecilir. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly onEvent?: (event: SweepEvent) => void
  /** Tek gecisde en fazla kac supurme yayinlanir. */
  readonly maxPerPass?: number
}

export type SweepEvent =
  | { readonly kind: 'skip'; readonly token: Address; readonly reason: SkipReason }
  | {
      readonly kind: 'simulation-refused'
      readonly token: Address
      readonly minTokensOut: bigint
      readonly detail: string
    }
  | { readonly kind: 'dry-run'; readonly token: Address; readonly minTokensOut: bigint }
  | {
      readonly kind: 'sent'
      readonly token: Address
      readonly minTokensOut: bigint
      readonly outcome: SendOutcome
    }
  | { readonly kind: 'read-failed'; readonly token: Address; readonly detail: string }
  | { readonly kind: 'budget-exhausted'; readonly remaining: number }

export type SweepPassResult = {
  readonly head: bigint
  readonly summary: SweepPassSummary
  /** Yayinlanan islemler -- kuru kosuda BOS. */
  readonly sent: readonly { token: Address; hash: Hex; outcome: SendOutcome }[]
  /** Simulasyonun REDDETTIGI supurmeler. Sifir olmayan bir sayi ALARM konusudur. */
  readonly refused: number
  /** Okumasi dusen tokenlar. Gecisi durdurmaz. */
  readonly unreadable: number
}

const DEFAULT_MAX_PER_PASS = 4

/**
 * KESIF: `BuybackAccrued` loglarindan aday kumesi.
 *
 * SAF VE BIRIKIMLIDIR. Bir token bir kez tahakkuk gordugunde SONSUZA KADAR
 * adaydir -- tekrar tahakkuk edebilir, ve `spendable` sifirsa gecis onu
 * `nothing-pending` diye zaten atlar. Kumeden CIKARMA yolu bilerek yoktur:
 * cikarmanin dogru kosulu "bir daha hic tahakkuk etmeyecek"tir ve bu
 * bilinemez.
 *
 * SIRA KORUNUR (`Set` ekleme sirasini korur), boylece gecis butcesi
 * tukendiginde hep AYNI tokenlar one gecmez -- cagiran donduren kumeyi
 * kaydirabilir.
 */
export function candidates(
  known: Iterable<Address>,
  fresh: Iterable<Address>,
): readonly Address[] {
  const set = new Set<Address>()
  for (const a of known) set.add(a.toLowerCase() as Address)
  for (const a of fresh) set.add(a.toLowerCase() as Address)
  return [...set]
}

async function sleepDefault(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * BIR GECIS.
 *
 * SIRA -- ve her adimin neden o sirada oldugu:
 *
 *   1. `head` BIR KEZ okunur ve her sey ona sabitlenir.
 *   2. `MIN_SWEEP_WEI` ve anahtarci kimligi BIR KEZ okunur (token basina
 *      degil): ikisi de tokene bagli DEGILDIR.
 *   3. Token basina: durum -> UCUZ KAPILAR -> (gerekirse) teklif -> karar.
 *   4. Karar `sweep` ise: SIMULE ET, sonra jitter kadar bekle, sonra gonder.
 *
 * 3. ADIMDAKI IKI ASAMALI KARAR BILINCLIDIR. `planSweep` once
 * `quotedTokensOut: null` ile cagrilir; `no-quote` DISINDA bir sebeple
 * atliyorsa (esik, yetki, bos butce) teklif icin TEK BIR RPC bile harcanmaz.
 * Kapilarin kendisi yine TEK YERDE (`decide.ts`) durur -- burada
 * kopyalanmaz.
 */
export async function runSweepPass(deps: SweepPassDeps): Promise<SweepPassResult> {
  const policy = deps.policy ?? DEFAULT_SWEEP_POLICY
  const sleep = deps.sleep ?? sleepDefault
  const budget = deps.maxPerPass ?? DEFAULT_MAX_PER_PASS
  const emit = deps.onEvent ?? ((): void => {})

  const head = await deps.chain.head()
  const minSweepWei = await deps.chain.minSweepWei(head)
  const isDesignatedKeeper = await deps.chain.isDesignatedKeeper(head)

  let summary = emptySummary()
  const sent: { token: Address; hash: Hex; outcome: SendOutcome }[] = []
  let refused = 0
  let unreadable = 0
  let published = 0

  for (const token of deps.tokens) {
    if (published >= budget) {
      emit({ kind: 'budget-exhausted', remaining: deps.tokens.length - deps.tokens.indexOf(token) })
      break
    }

    let state: TokenSweepState
    try {
      state = await deps.chain.readToken(token, head)
    } catch (error) {
      // OKUMASI DUSEN BIR TOKEN GECISI DURDURMAZ. Bir tokenin egrisinin
      // silinmis olmasi ya da tek bir RPC arizasi, DIGER tokenlarin
      // supurulmesini engellememeli -- ve sayilir, cunku sessizce atlanan
      // bir token olculemez.
      unreadable++
      emit({ kind: 'read-failed', token, detail: describe(error) })
      continue
    }

    const base = {
      token,
      spendableWei: state.spendableWei,
      minSweepWei,
      permissionless: state.permissionless,
      isDesignatedKeeper,
    }

    // ILK GECIS: TEKLIFSIZ. Ucuz kapilarin hepsi burada calisir.
    const provisional = planSweep(
      { ...base, quotedTokensOut: null },
      deps.nowSeconds,
      deps.jitterSeed(),
      policy,
    )
    if (provisional.action === 'skip' && provisional.reason !== 'no-quote') {
      summary = foldDecision(summary, provisional)
      emit({ kind: 'skip', token, reason: provisional.reason })
      continue
    }

    // Buraya gelindiyse teklif DISINDA her sey gecti; simdi teklif icin
    // odemeye deger.
    const quoted = await deps.chain.quote(state, head)
    const decision: SweepDecision = planSweep(
      { ...base, quotedTokensOut: quoted },
      deps.nowSeconds,
      deps.jitterSeed(),
      policy,
    )
    summary = foldDecision(summary, decision)

    if (decision.action === 'skip') {
      emit({ kind: 'skip', token, reason: decision.reason })
      continue
    }

    const deadline = BigInt(decision.deadline)

    /*
     * SIMULASYON, GONDERMEDEN ONCE, HER ZAMAN.
     *
     * Teklif bir TAHMINDIR; `sweep`in kendisi ise fiyat etkisi sinirini,
     * esikleri ve merci secimini KOSAR. Ikisi ayrilirsa gonderilen islem
     * `SlippageTooHigh` ile duser ve gazi yakar. Bu `eth_call` o farki
     * ONCEDEN gorur -- `graduate/executor.ts`in ayni disiplini.
     */
    const simulated = await deps.chain.simulate(token, decision.minTokensOut, deadline, head)
    if (!simulated.ok) {
      refused++
      emit({
        kind: 'simulation-refused',
        token,
        minTokensOut: decision.minTokensOut,
        detail: simulated.detail,
      })
      continue
    }

    if (deps.dryRun) {
      emit({ kind: 'dry-run', token, minTokensOut: decision.minTokensOut })
      continue
    }

    // JITTER, GONDERMEDEN HEMEN ONCE. Simulasyondan SONRA olmasi kasitli:
    // beklemenin amaci yayin ANINI ongorulemez kilmaktir, ve beklemeden once
    // simule etmek o pencereyi bosa harcamaz.
    if (decision.delayMs > 0) await sleep(decision.delayMs)

    const hash = await deps.chain.send(token, decision.minTokensOut, deadline)
    const outcome = await deps.chain.wait(hash)
    published++
    sent.push({ token, hash, outcome })
    emit({ kind: 'sent', token, minTokensOut: decision.minTokensOut, outcome })
  }

  return { head, summary, sent, refused, unreadable }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
