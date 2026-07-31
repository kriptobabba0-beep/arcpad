import type { Address } from '../src/hex'
import type {
  CompletedEvent,
  FeeLedgerEvent,
  IngestEvent,
  LaunchEvent,
  TradeEvent,
  TransferEvent,
} from '../src/apply'
import type { Deployment } from '../src/deployment'
import { toHexBytes } from '../src/hex'
import { toSeq } from '../src/seq'

export function addr(n: number): Address {
  return `0x${n.toString(16).padStart(40, '0')}`
}

export function hash32(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`
}

export const ZERO = addr(0)

/**
 * Faz 1c'nin curve profili. `sale_supply_tok < virtual_token_reserves_tok`
 * kisiti bu sayilarla saglanir; testler ondan once bu iliskiyi bozarsa
 * `deployment` satiri hic yazilamaz ve arizanin sebebi gizlenir.
 */
export const PROFILE = {
  virtualTokenReservesTok: 1_073_000_000n * 10n ** 18n,
  virtualQuoteReservesWei: 30n * 10n ** 18n,
  saleSupplyTok: 793_100_000n * 10n ** 18n,
  totalSupplyTok: 10n ** 27n,
}

export const DEPLOYMENT: Deployment = {
  chainId: 10_207n,
  factory: addr(0xfac),
  escrow: addr(0xe5c),
  protocolTreasury: addr(0x77e),
  ...PROFILE,
  startBlock: 54_000_000n,
}

export const TOKEN = addr(0x7000)
export const CURVE = addr(0xc000)
export const CREATOR = addr(0xc4ea)
export const ALICE = addr(0xa11ce)
export const BOB = addr(0xb0b)

const BLOCK = 54_325_469n
/** Arc'ta ardisik bloklarin %49,1'i AYNI timestamp'i tasir; fixture bunu taklit eder. */
const T0 = new Date('2026-07-30T12:00:00.000Z')

function ref(logIndex: number, block = BLOCK, time = T0) {
  return {
    eventSeq: toSeq(block, logIndex),
    blockNumber: block,
    logIndex,
    txHash: hash32(0xda7a + logIndex),
    blockTime: time,
  }
}

export const LAUNCH: LaunchEvent = {
  kind: 'launch',
  ...ref(0),
  token: TOKEN,
  curve: CURVE,
  creator: CREATOR,
  name: 'Arc Pad Test',
  symbol: 'APT',
  uri: 'ipfs://bafyexampleexampleexample',
  // Gecerli UTF-8 tasiyan bir launch icin ham baytlar gosterim metninden
  // TURETILEBILIR; dusman metinli olan icin turetilemez (bkz. text.test.ts).
  nameHex: toHexBytes('Arc Pad Test'),
  symbolHex: toHexBytes('APT'),
  uriHex: toHexBytes('ipfs://bafyexampleexampleexample'),
  salt: hash32(0x5a17),
  virtualTokenReservesTok: PROFILE.virtualTokenReservesTok,
  virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei,
  realTokenReservesTok: PROFILE.saleSupplyTok,
  realQuoteReservesWei: 0n,
}

/** Arz curve'e basilir: `from` SIFIR ADRESTIR, yani curve bir holder olur. */
export const MINT: TransferEvent = {
  kind: 'transfer',
  ...ref(1),
  token: TOKEN,
  from: ZERO,
  to: CURVE,
  amountTok: PROFILE.totalSupplyTok,
}

const BUY_TOKENS = 1_000_000n * 10n ** 18n
const BUY_QUOTE = 28_000_000_000_000_000n

export const BUY: TradeEvent = {
  kind: 'trade',
  ...ref(2, BLOCK + 1n, T0), // AYNI timestamp, SONRAKI blok. Siralama seq ile.
  token: TOKEN,
  curve: CURVE,
  trader: ALICE,
  isBuy: true,
  tokenAmountTok: BUY_TOKENS,
  quoteAmountWei: BUY_QUOTE,
  protocolFeeWei: 266_000_000_000_000n,
  // SIFIR DEGIL: bu curve'un creator'i sifir degil.
  creatorFeeWei: 84_000_000_000_000n,
  virtualTokenReservesTok: PROFILE.virtualTokenReservesTok - BUY_TOKENS,
  virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei + BUY_QUOTE,
  realTokenReservesTok: PROFILE.saleSupplyTok - BUY_TOKENS,
  realQuoteReservesWei: BUY_QUOTE,
}

export const BUY_TRANSFER: TransferEvent = {
  kind: 'transfer',
  ...ref(3, BLOCK + 1n, T0),
  token: TOKEN,
  from: CURVE,
  to: ALICE,
  amountTok: BUY_TOKENS,
}

export const PROTOCOL_FEE: FeeLedgerEvent = {
  kind: 'fee',
  ...ref(4, BLOCK + 1n, T0),
  feeKind: 'deposit',
  recipient: DEPLOYMENT.protocolTreasury,
  from: CURVE,
  amountWei: BUY.protocolFeeWei,
}

export const CREATOR_FEE: FeeLedgerEvent = {
  kind: 'fee',
  ...ref(5, BLOCK + 1n, T0),
  feeKind: 'deposit',
  recipient: CREATOR,
  from: CURVE,
  amountWei: BUY.creatorFeeWei,
}

const SELL_TOKENS = 400_000n * 10n ** 18n
const SELL_QUOTE = 11_000_000_000_000_000n

export const SELL: TradeEvent = {
  kind: 'trade',
  ...ref(0, BLOCK + 2n, new Date(T0.getTime() + 1000)),
  token: TOKEN,
  curve: CURVE,
  trader: ALICE,
  isBuy: false,
  tokenAmountTok: SELL_TOKENS,
  quoteAmountWei: SELL_QUOTE,
  protocolFeeWei: 104_500_000_000_000n,
  creatorFeeWei: 33_000_000_000_000n,
  virtualTokenReservesTok: PROFILE.virtualTokenReservesTok - BUY_TOKENS + SELL_TOKENS,
  virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei + BUY_QUOTE - SELL_QUOTE,
  realTokenReservesTok: PROFILE.saleSupplyTok - BUY_TOKENS + SELL_TOKENS,
  realQuoteReservesWei: BUY_QUOTE - SELL_QUOTE,
}

export const SELL_TRANSFER: TransferEvent = {
  kind: 'transfer',
  ...ref(1, BLOCK + 2n, new Date(T0.getTime() + 1000)),
  token: TOKEN,
  from: ALICE,
  to: CURVE,
  amountTok: SELL_TOKENS,
}

export const CREATOR_CLAIM: FeeLedgerEvent = {
  kind: 'fee',
  ...ref(2, BLOCK + 2n, new Date(T0.getTime() + 1000)),
  feeKind: 'claim',
  recipient: CREATOR,
  from: null,
  amountWei: BUY.creatorFeeWei,
}

/** Kalan butun arzi tuketen alim: `real_token_reserves_tok` sifira iner. */
const FINAL_TOKENS = PROFILE.saleSupplyTok - BUY_TOKENS + SELL_TOKENS
const FINAL_QUOTE = 900_000_000_000_000_000n

export const FINAL_BUY: TradeEvent = {
  kind: 'trade',
  ...ref(0, BLOCK + 3n, new Date(T0.getTime() + 2000)),
  token: TOKEN,
  curve: CURVE,
  trader: BOB,
  isBuy: true,
  tokenAmountTok: FINAL_TOKENS,
  quoteAmountWei: FINAL_QUOTE,
  protocolFeeWei: 8_550_000_000_000_000n,
  creatorFeeWei: 2_700_000_000_000_000n,
  virtualTokenReservesTok: PROFILE.virtualTokenReservesTok - PROFILE.saleSupplyTok,
  virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei + BUY_QUOTE - SELL_QUOTE + FINAL_QUOTE,
  realTokenReservesTok: 0n,
  realQuoteReservesWei: BUY_QUOTE - SELL_QUOTE + FINAL_QUOTE,
}

export const FINAL_TRANSFER: TransferEvent = {
  kind: 'transfer',
  ...ref(1, BLOCK + 3n, new Date(T0.getTime() + 2000)),
  token: TOKEN,
  from: CURVE,
  to: BOB,
  amountTok: FINAL_TOKENS,
}

export const COMPLETED: CompletedEvent = {
  kind: 'completed',
  ...ref(2, BLOCK + 3n, new Date(T0.getTime() + 2000)),
  token: TOKEN,
  realQuoteReservesWei: FINAL_BUY.realQuoteReservesWei,
  poolSeedSupplyTok: PROFILE.totalSupplyTok - PROFILE.saleSupplyTok,
}

/**
 * Bir blok araliginin TAMAMI, zincir sirasinda. Bes olay tipinin HEPSI ve her
 * birinin iki dali (alim/satim, yatirma/cekme, mint/normal transfer) burada.
 */
export const RANGE: readonly IngestEvent[] = [
  LAUNCH,
  MINT,
  BUY,
  BUY_TRANSFER,
  PROTOCOL_FEE,
  CREATOR_FEE,
  SELL,
  SELL_TRANSFER,
  CREATOR_CLAIM,
  FINAL_BUY,
  FINAL_TRANSFER,
  COMPLETED,
]

export const RANGE_TO = BLOCK + 3n

/**
 * Blok numarasindan deterministik bir blok hash'i. `sync_state.last_block_hash`
 * NOT NULL oldugu icin her imlec yazimi bir hash ister; testlerin ayni blok
 * icin ayni hash'i vermesi, imlecin idempotency iddiasini bozmaz.
 */
export function hashFor(block: bigint): string {
  return `0x${block.toString(16).padStart(64, '0')}`
}

/**
 * Imlecin BOS oldugu (ilk kosu) durumda `replayRange`e gecilen parent hash.
 * `assertContinuous` o dalda hicbir sey karsilastirmaz, ama argüman ZORUNLU
 * oldugu icin cagiran yine de bir deger vermek zorundadir -- ve bu sabitin
 * adi, degerin neden onemsiz oldugunu cagri yerinde okunur kilar.
 */
export const GENESIS = hashFor(0n)
