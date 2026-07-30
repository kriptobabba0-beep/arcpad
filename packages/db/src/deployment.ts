import type { Address } from './hex'
import { lower } from './hex'
import type { Queryable } from './pool'

/**
 * Bu veritabaninin indexledigi dagitim. TEKIL: `deployment` tablosunun
 * `CHECK (id = 1)` kisiti ikinci bir satiri imkansiz kilar.
 */
export interface Deployment {
  chainId: bigint
  factory: Address
  escrow: Address
  protocolTreasury: Address
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  saleSupplyTok: bigint
  totalSupplyTok: bigint
  startBlock: bigint
}

interface DeploymentRow {
  chain_id: string
  factory: string
  escrow: string
  protocol_treasury: string
  virtual_token_reserves_tok: string
  virtual_quote_reserves_wei: string
  sale_supply_tok: string
  total_supply_tok: string
  start_block: string
}

export async function getDeployment(db: Queryable): Promise<Deployment | null> {
  const { rows } = await db.query<DeploymentRow>('SELECT * FROM deployment WHERE id = 1')
  const row = rows[0]
  if (row === undefined) return null
  // Butun sayisal sutunlar STRING gelir (bkz. pool.ts) ve `BigInt(...)` ile
  // TAM olarak geri kurulur. `Number(...)` 1e27'yi sessizce bozardi.
  return {
    chainId: BigInt(row.chain_id),
    factory: row.factory as Address,
    escrow: row.escrow as Address,
    protocolTreasury: row.protocol_treasury as Address,
    virtualTokenReservesTok: BigInt(row.virtual_token_reserves_tok),
    virtualQuoteReservesWei: BigInt(row.virtual_quote_reserves_wei),
    saleSupplyTok: BigInt(row.sale_supply_tok),
    totalSupplyTok: BigInt(row.total_supply_tok),
    startBlock: BigInt(row.start_block),
  }
}

/**
 * Tekil dagitim satirini yazar.
 *
 * ON CONFLICT DO NOTHING: ayni dagitimi iki kez yazmak bir NO-OP'tur, FARKLI
 * bir dagitimi yazmak da sessizce ESKISINI KORUR. Uyusmazligi burada
 * DUZELTMEK yanlis olurdu -- profil degistiyse (testnet `V` ile uretim `V`
 * arasinda tam 1000x fark var) veritabanindaki butun market cap'ler zaten
 * yanlis olur; dogru davranis acilista uyusmazligi gorup HALT etmektir ve o
 * karsilastirma `getDeployment`'in isidir.
 */
export async function putDeployment(db: Queryable, d: Deployment): Promise<void> {
  await db.query(
    `INSERT INTO deployment (
       id, chain_id, factory, escrow, protocol_treasury,
       virtual_token_reserves_tok, virtual_quote_reserves_wei,
       sale_supply_tok, total_supply_tok, start_block
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      d.chainId.toString(),
      lower(d.factory),
      lower(d.escrow),
      lower(d.protocolTreasury),
      d.virtualTokenReservesTok.toString(),
      d.virtualQuoteReservesWei.toString(),
      d.saleSupplyTok.toString(),
      d.totalSupplyTok.toString(),
      d.startBlock.toString(),
    ],
  )
}
