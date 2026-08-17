import { type Hex, toFunctionSelector } from 'viem'
import type { AlertLevel } from '../alert'
import { CURVE_ERROR_ABI, LOCKER_ABI } from './abi'

/**
 * ============ BIR REVERT'IN NE ANLAMA GELDIGI ============
 *
 * Bu dosyanin tamami tek bir ayrim uzerine kurulu, ve o ayrim gorev tanimindan
 * kelimesi kelimesine alindi:
 *
 *   "ASLA BASARAMAYACAK bir revert (bloklanmis odeme hedefi) ile SONRA
 *    BASARACAK bir revert (`GraduationTargetUnset()`, ki uretim fabrikasinda
 *    BUGUN dogrudur ve BILEREK oyledir) AYNI SEY DEGILDIR."
 *
 * Somut olcum, bu gorev tarafindan CANLI zincire karsi yapildi (2026-08-09,
 * blok 56029795, `rpc.testnet.arc.network`):
 *
 *   locker.graduate(0xDdB9e739...f27b)  -> 0xfe30fa5b  GraduationTargetUnset()
 *   locker.graduate(0x53Bba88F...44c9)  -> 0x0701727f  NotComplete()
 *
 * Birincisi uretim fabrikasinin BUGUNKU, KASITLI durumudur: hedef `0x0` ve
 * oyle kalmalidir. Bes saniyelik bir poll araliginda bunun her defasinda
 * sayfa cikarmasi gunde ~17.000 sayfa demektir -- `createThrottle`in var olma
 * sebebi olan sayinin ta kendisi -- ve bir hafta icinde rota bu sayfayi
 * susturmayi ogrenir. O yuzden `target-unset` UYANDIRMAZ; hicbir tekrar
 * araliginda, hicbir ust uste sayimda uyandirmaz (`pageable: false`).
 */

/** Yurutucunun tanidigi sonuc siniflari. */
export type GraduationCode =
  /** Islem indi ve `graduated()` artik `true`. */
  | 'graduated'
  /** Bu kosuda yayin YAPILMADI (kuru kosu), ama simulasyon GECTI. */
  | 'would-graduate'
  /** `AlreadyGraduated()` -- baskasi kazandi. Bu bir ariza DEGILDIR. */
  | 'already-graduated'
  /** `GraduationTargetUnset()` -- platform hedefini henuz silahlamadi. */
  | 'target-unset'
  /** `NotGraduationTarget()` -- fabrika BASKA bir adresi gosteriyor. */
  | 'not-the-target'
  /** `NotComplete()` -- slot "complete" dedi, cagri "degil" dedi. */
  | 'not-complete'
  /** `CurveNotFromFactory()` -- kesif bu fabrikaya ait olmayan bir curve verdi. */
  | 'not-canonical'
  /** `GraduationPayoutFailed()` -- hedefin `receive()`i reddetti (bloklama). */
  | 'payout-rejected'
  /** Havuz adiminin herhangi bir basarisizligi. */
  | 'pool-step-failed'
  /** Tanimadigimiz revert verisi. Fail-closed: sayfa. */
  | 'unknown-revert'
  /** Zincir/RPC arizasi -- revert DEGIL. */
  | 'chain-error'

export type Disposition =
  /** Bu curve icin yapilacak baska is yok. */
  | 'done'
  /** Bir sonraki gecis yeniden dener; durum kendiliginden degisebilir. */
  | 'retry'
  /** Birileri bir sey degistirmedikce yeniden denemek anlamsiz. Karantina. */
  | 'quarantine'

export type Classification = {
  code: GraduationCode
  errorName: string | null
  selector: Hex | null
  level: AlertLevel
  disposition: Disposition
  /**
   * BU BULGU HIC UYANDIRABILIR MI. `level` tek basina yetmez: yurutucu ayni
   * curve icin ust uste basarisizliklari SAYAR ve esigi asinca yukseltir.
   * `pageable: false` o yukseltmeyi de kapatir -- yani `target-unset` hicbir
   * yoldan sayfaya donusemez.
   */
  pageable: boolean
  reason: string
}

const SELECTORS: Record<string, Hex> = (() => {
  const map: Record<string, Hex> = {}
  for (const abi of [CURVE_ERROR_ABI, LOCKER_ABI]) {
    for (const entry of abi) {
      if (entry.type !== 'error') continue
      map[entry.name] = toFunctionSelector(`${entry.name}()`)
    }
  }
  return map
})()

/**
 * CANLI ZINCIRDEN OLCULEN IKI SELECTOR, ELLE PINLENDI.
 *
 * Turetme (`SELECTORS`) ve pin AYRI KAYNAKLARDIR ve `assertSelectorsAgree`
 * ikisini karsilastirir. Yalnizca turetmeye guvenmek, ABI'deki bir isim
 * yazim hatasini SESSIZ yapardi: yanlis yazilmis bir ad yanlis bir selector
 * uretir, hicbir sey firlatmaz, ve zincirin gonderdigi `0xfe30fa5b` sonsuza
 * kadar `unknown-revert` -- yani SAYFA -- olurdu. Tam olarak "uyandirmamali"
 * denen sey uyandirirdi.
 */
export const MEASURED_SELECTORS = {
  GraduationTargetUnset: '0xfe30fa5b',
  NotComplete: '0x0701727f',
} as const satisfies Record<string, Hex>

export function assertSelectorsAgree(): void {
  for (const [name, measured] of Object.entries(MEASURED_SELECTORS)) {
    const derived = SELECTORS[name]
    if (derived !== measured) {
      throw new Error(
        `the ABI in keeper/src/graduate/abi.ts derives ${name} as ${derived ?? '(missing)'}, but the live chain returned ${measured} for it on 2026-08-09. One of the two is wrong and the keeper would misclassify a real revert.`,
      )
    }
  }
}

/** Solidity'nin iki yerlesik hatasi. */
const ERROR_STRING_SELECTOR = '0x08c379a0'
const PANIC_SELECTOR = '0x4e487b71'

type Rule = Omit<Classification, 'selector' | 'errorName'>

/**
 * ADI OLAN HER REVERT ICIN BIR KURAL. Bir `default` dali YOKTUR ve olmamali:
 * tablodan dusen her sey `unknown-revert`, yani SAYFA olur (fail-closed).
 */
const RULES: Record<string, Rule> = {
  AlreadyGraduated: {
    code: 'already-graduated',
    level: 'ok',
    disposition: 'done',
    pageable: false,
    reason:
      'AlreadyGraduated(): this curve is already graduated. ArcpadLocker.graduate is PERMISSIONLESS, so any party -- a user, a searcher, the web UI, another keeper -- can land it first. That is the design working, not a fault; the keeper spent no gas because the simulation caught it.',
  },
  GraduationTargetUnset: {
    code: 'target-unset',
    level: 'ok',
    disposition: 'retry',
    // GOREV TANIMININ ACIK SARTI. Uretim fabrikasinda `graduationTarget` BUGUN
    // `0x0` ve OYLE KALMALIDIR; bu satir onu bir alarma cevirmemenin kodudur.
    pageable: false,
    reason:
      'GraduationTargetUnset(): the factory has not armed graduationTarget yet, so BondingCurve.graduate() reverts for every curve, completed or not. This is TRUE OF THE PRODUCTION FACTORY TODAY AND DELIBERATELY SO. Nothing is wrong, nothing is stuck, and no one should be woken; the call will start succeeding the moment the target is applied.',
  },
  NotGraduationTarget: {
    code: 'not-the-target',
    level: 'page',
    disposition: 'retry',
    pageable: true,
    reason:
      "NotGraduationTarget(): the factory's graduationTarget is a NON-ZERO address that is not the locker this keeper is configured with. Every completed curve now pays out through some other contract and this keeper cannot graduate anything. Either the keeper points at a stale locker or governance re-pointed the factory -- see the graduation-window runbook.",
  },
  NotComplete: {
    code: 'not-complete',
    level: 'ok',
    disposition: 'retry',
    pageable: true,
    reason:
      "NotComplete(): the curve's complete() slot read true at the pinned block but the call disagreed. A reorg or a stale read; the next pass re-reads the slot. If it persists, discovery is wrong.",
  },
  CurveNotFromFactory: {
    code: 'not-canonical',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      'CurveNotFromFactory(): the locker refused this address because the factory it is bound to does not know its token. Discovery handed the executor a curve from a DIFFERENT factory -- a cursor built for another deployment, or a locker/factory pair that do not belong together.',
  },
  GraduationPayoutFailed: {
    code: 'payout-rejected',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      "GraduationPayoutFailed(): the curve's native payout leg to the graduation target returned false. On Arc the observed cause of this is the node-level blocklist behind the 0x1800 precompile. Retrying cannot fix it -- the target has to stop being refused -- so this curve is quarantined rather than re-attempted every pass.",
  },
  TokenTransferFailed: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      'TokenTransferFailed(): the base leg of graduate() returned false. LaunchToken is an OZ ERC20 that reverts rather than returning false, so reaching this at all means the token at that address is not the one the factory deployed.',
  },
  ZeroLiquidity: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      "ZeroLiquidity(): the locker computed zero seed liquidity from the curve's closing reserves. Nothing the keeper can retry into success.",
  },
  SeedShortfall: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      'SeedShortfall(): the pool asked the locker for more than graduate() paid it. A rounding boundary the locker checks explicitly so the failure is diagnosable rather than surfacing inside a transfer.',
  },
  PoolPriceMismatch: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      'PoolPriceMismatch(): the pool did not open at the price the locker computed. The pool for this token already existed at another price, or PoolManager state diverged.',
  },
  PositionNotSeeded: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason:
      "PositionNotSeeded(): the locker's read-back of PoolManager's own position state did not match what it added.",
  },
  UnexpectedCredit: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason: 'UnexpectedCredit(): adding liquidity produced a positive delta leg.',
  },
  NotPoolManager: {
    code: 'pool-step-failed',
    level: 'page',
    disposition: 'quarantine',
    pageable: true,
    reason: "NotPoolManager(): the locker's unlock callback was entered by something else.",
  },
}

const BY_SELECTOR: Map<Hex, { name: string; rule: Rule }> = new Map(
  Object.entries(RULES).flatMap(([name, rule]) => {
    const selector = SELECTORS[name]
    return selector === undefined ? [] : [[selector, { name, rule }] as const]
  }),
)

/**
 * REVERT VERISINDEN SINIFA. SAF: viem yok, zincir yok, sadece dort bayt.
 *
 * NEDEN HAM HEX UZERINDEN VE viem'IN `errorName`I UZERINDEN DEGIL. viem
 * `decodeErrorResult` icin ABI'ye ihtiyac duyar ve ABI'de OLMAYAN bir hata
 * `errorName: undefined` verir -- yani "tanimadim" ile "cozemedim" ayni
 * degere duser. Dort bayt uzerinden calismak sinifi tek bir yerde tutar ve bu
 * fonksiyonu canli bir zincir olmadan, GERCEK olculmus verilerle test
 * edilebilir kilar.
 */
export function classifyRevert(data: string | undefined | null): Classification {
  if (data === undefined || data === null || data === '0x' || data === '') {
    return {
      code: 'unknown-revert',
      errorName: null,
      selector: null,
      level: 'page',
      disposition: 'retry',
      pageable: true,
      reason:
        'the call reverted with NO return data. That is what a call into an address with no code, an out-of-gas, or a bare `revert()` looks like; none of them is a graduation outcome this keeper models.',
    }
  }

  const selector = data.slice(0, 10).toLowerCase() as Hex
  const hit = BY_SELECTOR.get(selector)
  if (hit !== undefined) {
    return { ...hit.rule, errorName: hit.name, selector }
  }

  if (selector === ERROR_STRING_SELECTOR || selector === PANIC_SELECTOR) {
    const kind = selector === PANIC_SELECTOR ? 'Panic(uint256)' : 'Error(string)'
    return {
      code: 'unknown-revert',
      errorName: kind,
      selector,
      level: 'page',
      disposition: 'retry',
      pageable: true,
      reason: `the call reverted with a builtin ${kind}, not one of the graduation surface's custom errors. On a forked chain this is what Arc's 0x1800 native-asset precompile produces inside live USDC; on the real chain it means a layer below the graduation surface failed.`,
    }
  }

  return {
    code: 'unknown-revert',
    errorName: null,
    selector,
    level: 'page',
    disposition: 'retry',
    pageable: true,
    reason: `the call reverted with ${selector}, which is not in this keeper's graduation error table. Fail-closed: an unmodelled revert wakes someone rather than being silently retried forever.`,
  }
}

/** Zincir/RPC arizasi. Revert DEGIL, dolayisiyla ayri bir giris noktasi. */
export function chainErrorClassification(detail: string, consecutive: number): Classification {
  return {
    code: 'chain-error',
    errorName: null,
    selector: null,
    level: consecutive >= CHAIN_ERRORS_BEFORE_PAGE ? 'page' : 'ok',
    disposition: 'retry',
    pageable: true,
    reason:
      consecutive >= CHAIN_ERRORS_BEFORE_PAGE
        ? `the graduation call could not be made on ${consecutive} CONSECUTIVE passes, so it is not converging: ${detail}`
        : `the graduation call could not be made this pass (${consecutive} in a row, below the ${CHAIN_ERRORS_BEFORE_PAGE} that pages) and will be retried: ${detail}`,
  }
}

/**
 * Ust uste kac zincir arizasindan SONRA sayfa cikar.
 *
 * `SCAN_FAILURES_BEFORE_PAGE` ile ayni gerekce (bkz. `graduationWindow.ts`
 * `ScanHealth`): tek bir gecici hiz siniri sayfa DEGILDIR, ust uste sureni
 * sayfadir.
 */
export const CHAIN_ERRORS_BEFORE_PAGE = 2
