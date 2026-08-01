import type { HexAddress, TokenOverview } from '@/components/read/types'

/**
 * ⌘K TESTLERININ ORTAK FIXTURE'I.
 *
 * `TokenOverview` otuz dort alan tasiyor ve her testte elle yazilmasi, alan
 * listesi degistiginde otuz ayri yerde derleme hatasi demek olurdu. Degerler
 * SEKIL olarak gercek: `numeric(78,0)` kolonlari dize, `_wei` alanlari 18
 * ondalikli, `_seq` alanlari ondalik basamak.
 */
export function overview(patch: Partial<TokenOverview> = {}): TokenOverview {
  return {
    token: '0x1111111111111111111111111111111111111111',
    curve: '0x2222222222222222222222222222222222222222',
    name: 'Doge Arc',
    symbol: 'DOGEARC',
    uri: 'ipfs://bafyexample/metadata.json',
    name_hex: '0x446f676520417263',
    symbol_hex: '0x444f4745415243',
    uri_hex: '0x69706673',
    salt: '0x00',
    launch_creator: '0x3333333333333333333333333333333333333333',
    fee_creator: '0x3333333333333333333333333333333333333333',
    virtual_token_reserves_tok: '1073000000000000000000000000',
    virtual_quote_reserves_wei: '6500000000000000000',
    real_token_reserves_tok: '793100000000000000000000000',
    real_quote_reserves_wei: '500000000000000000',
    complete: false,
    completed_seq: null,
    pool_seed_supply_tok: null,
    market_cap_wei: '6052733351875009052',
    price_wei_per_token: '6052733351',
    progress_ppm: 253087,
    graduation_raise_wei: '12161433369060378706',
    holder_count: 12,
    volume_total_wei: '900000000000000000',
    volume_24h_wei: '400000000000000000',
    ath_market_cap_wei: '7052733351875009052',
    trade_count: 4,
    buy_count: 3,
    last_trade_seq: '42',
    last_buy_seq: '41',
    last_trade_at: '2026-07-30T10:00:00.000Z',
    last_buy_at: '2026-07-30T09:59:00.000Z',
    created_seq: '7',
    created_at: '2026-07-29T08:00:00.000Z',
    ...patch,
  }
}

/** Sekli gecerli, defterde olmayan bir adres. Buyuk harfli: normalizasyon olculur. */
export const PASTED = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
export const PASTED_LOWER = PASTED.toLowerCase() as HexAddress
