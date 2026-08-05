import { beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from '../src/pool'
import { pool, resetSchema } from './setup'

/**
 * ADLANDIRMA KAPISI.
 *
 * Arc'in native varligi USDC'dir ve IKI GORUNUMU vardir: 18 decimal native ve
 * 0x3600000000000000000000000000000000000000 adresindeki 6 decimal ERC-20
 * (canli testnette dogrulandi: symbol USDC, decimals 6, chainId 5042002).
 * Ikisi AYNI bakiyenin iki gorunumudur ve ASLA toplanmaz. Bir sutunun hangi
 * gorunumu tasidigi ADINDAN anlasilmazsa, yanlis gorunumu yazmak sessiz kalir
 * ve hicbir CHECK onu yakalayamaz -- 1e12'lik bir carpan hatasi tamamen
 * gecerli bir sayidir.
 *
 * ------------------------------------------------------------------
 * KAPININ ERISIMI OLCULDU, VARSAYILMADI -- ve ilk hali DARDI.
 *
 * Onceki kapi YALNIZCA `numeric(78,0)` sutunlarina bakiyordu. Gozden geciren
 * gercek kapi kodunu bir probe migration'iyla calistirdi ve UCU DE gecti:
 *   ALTER TABLE trades ADD COLUMN price_wei    numeric(78,6);  -- scale 6
 *   ALTER TABLE trades ADD COLUMN quote_number numeric;        -- precision NULL
 *   ALTER TABLE trades ADD COLUMN fill_count   bigint;         -- tipe bakilmiyor
 * `7 passed (7)`.
 *
 * Bu tam olarak kapinin tasiyici oldugu yere dusuyor: **6 decimal bir USDC
 * tutari en dogal olarak `bigint`tir** (100 USDC = 1e8, rahat sigar), 18
 * decimal gorunum ise 1e20'dir ve `bigint`i tasirir. Yani kapinin ayirmak icin
 * var oldugu gorunum, tam da kapinin hic bakmadigi tipte yasiyor.
 *
 * Istenen ozellik "her numeric(78,0) iyi adlandirilmis" DEGIL, **"hicbir sutun
 * gorunumunu bildirmeden bir USDC miktari tasiyamaz"**. Yeni kural:
 *   - her `numeric` TAM OLARAK numeric(78,0) olmali VE `_wei`/`_tok` ile bitmeli;
 *   - her tamsayi sutunu `_wei`/`_tok` ile BITMEMELI ve bildirilmis bir
 *     para-disi sonek tasimali;
 *   - `real`/`double precision`/`money` tamamen yasak;
 *   - ve TIP BOLUNTUSUNUN KENDISI katalogla karsilastirilir, boylece sonradan
 *     eklenen bir tip boluntunun disina SESSIZCE kacamaz.
 *
 * `fill_count bigint` BILEREK GECER: o bir sayacdir, bildirilmis `_count`
 * sonegini tasir, ve onu reddetmek semadaki her sayaci numeric(78,0)'a iterdi
 * -- guvenlik kazanci olmadan daha kotu bir sema. Yani gozden gecirenin uc
 * probe'undan IKISI kusur, ucuncusu degil.
 * ------------------------------------------------------------------
 * KAPININ SINIRI -- NE YAPAR, NE YAPMAZ.
 *
 * Bu kapi 1e12'lik gorunum hatasini IMKANSIZ KILMAZ; onu BILDIRILMIS kilar.
 * Bir sutunun adi hangi gorunumu tasidigini SOYLEMEK zorundadir; o adin
 * DOGRU olup olmadigina kapi bakamaz. Iki somut kacis, ikisi de olculdu ve
 * ikisi de bu sinirin icinde:
 *
 *   - `quote_number bigint GENERATED ALWAYS AS (quote_amount_wei / 1e12)
 *     STORED` -- bildirilmis bir sonek tasir (`_number`), yani kapidan gecer.
 *     Gercek bir 1e12 kucultmesidir. Kapinin verdigi sey sudur: birinin
 *     `_number` diye ADLANDIRMAYI secmis olmasi ve bunun kod incelemesinde
 *     gorunmesi.
 *   - `id bigint` cok satirli bir tabloda -- `id` muafiyeti `CHECK (id = 1)`
 *     tekil satir gerekcesine DAYANIR, ama kapi o CHECK'i HIC OKUMAZ. Muafiyet
 *     adin kendisine verilmistir.
 *
 * Bu ikisini kapatmak, ifadeleri ve kisitlari yorumlamak demek olurdu; kapi
 * bunu yapmaz. Ama parmak izi (`schemaInventory`) uretim ifadelerini ve
 * tetikleyicileri ICERIR, yani boyle bir sutunun SONRADAN sessizce eklenmesi
 * yakalanir -- iki savunma ayni deligi degil, birbirinin komsusunu kapatir.
 * ------------------------------------------------------------------
 */

/** Bildirilmis sonekler. Hicbiri para gorunumu BILDIRMEZ; para `_wei`/`_tok`tur. */
const NON_MONEY_SUFFIX =
  /(_ppm|_bps|_seq|_at|_time|_count|_id|_block|_number|_index|_hash|_hex|_addr)$/
const MONEY_SUFFIX = /(_wei|_tok)$/
const FORBIDDEN = /(_usdc|_uusdc|_micro|_e6)$/

/**
 * TIP BOLUNTUSU -- `information_schema.columns.data_type` degerleri.
 * Semada gecen her tip bu dort kumeden BIRINDE olmak ZORUNDA; degilse
 * `unclassified` dolar ve kapi kirilir.
 */
const NUMERIC_TYPES = new Set(['numeric', 'decimal'])
const INTEGER_TYPES = new Set(['smallint', 'integer', 'bigint'])
/** Para icin kayan nokta HER ZAMAN yanlistir; `money` ise locale'e bagimlidir. */
const BANNED_TYPES = new Set(['real', 'double precision', 'money'])
const NON_AMOUNT_TYPES = new Set([
  'text',
  'character varying',
  'character',
  'boolean',
  'timestamp with time zone',
  'timestamp without time zone',
  'date',
  'jsonb',
  'json',
  'bytea',
  'uuid',
])

/**
 * MUAFIYETLER TIPE BAGLIDIR.
 *
 * Onceki hali tek bir ada gore anahtarlanmis kumeydi ve TIPE HIC BAKMIYORDU.
 * Gozden gecirenin probe'u calistirildi ve deligi ISPATLADI: `token`, `name`,
 * `id`, `reason`, `salt`, `source` adlarindan HERHANGI BIRINI tasiyan bir
 * `bigint` sutunu ALTI kovanin ALTISINDAN da gecti (`*** NO FINDING ***`,
 * her biri examined +1). `is_buy`i dusurup `bigint` olarak geri eklemek de
 * ayni sekilde kacti. Yani kapinin var olma sebebi -- gorunumunu bildirmeden
 * miktar tasiyan sutun -- tam olarak muafiyet listesinin altindan geciyordu.
 *
 * Kural: bir muafiyet YALNIZCA sutunun tipi bir miktar tasiyamayacak tipteyse
 * gecerlidir. Tamsayi tiplerinde tek mesru muafiyet `id`dir; `numeric` icin
 * muafiyet HIC yoktur (zaten `_wei`/`_tok` sart).
 */
const EXEMPT_NON_AMOUNT = new Set([
  'token',
  'curve',
  'trader',
  'holder',
  'recipient',
  'creator',
  'launch_creator',
  'factory',
  'escrow',
  'protocol_treasury',
  'name',
  'symbol',
  'uri',
  'salt',
  'kind',
  'reason',
  'expected',
  'source',
  'complete',
  // `curve_state.graduated` / `token_overview.graduated` -- `complete` ile AYNI
  // sinifta bir boolean durum bayragi, ve ondan AYRI bir olgu. Sonek
  // koymanin yolu yok: `_at` bir zaman damgasi BILDIRIR ve bu bir zaman degil,
  // `_seq` ise ayri sutunda (`graduated_seq`) zaten var. Muafiyet TIP
  // KAPSAMLIDIR -- `graduated bigint` yine yakalanir.
  'graduated',
  'is_buy',
  'filename',
  // `token_overview.fee_creator` -- ucreti O ANDA alan adres
  // (`creator_at(...)`). Bir ADRESTIR, miktar degil, ve `creator` gibi muaf
  // adlarla ayni sinifta. Ayri yazilmasinin sebebi `launch_creator`dan FARKLI
  // bir soru cevaplamasi: "kim baslatti" degil "ucreti kim aliyor".
  'fee_creator',
  // `schema_state.inventory_json` -- envanterin JSON metni. TAM AD olarak ve
  // YALNIZCA amount-olmayan tipler icin muaf.
  //
  // ILK DENEMEDE `_json` bir SONEK olarak eklenmisti ve bu YANLISTI: `_json`
  // bir KAP adidir, bir MIKTAR TURU degil -- serialize edilmis bir deger
  // istedigi kadar USDC tutari tasiyabilir. Dahasi `NON_MONEY_SUFFIX`i
  // `undeclaredInteger` de okudugu icin sonek metinle sinirli kalmiyordu;
  // olculdu: `fee_json bigint`, `amount_json bigint`, `balance_json integer`
  // UCU DE hicbir kovaya dusmuyordu. Bu commit'te tip-kapsamli muafiyet
  // makinesi kuruldu ve sonra kendi yeni adim icin kapsamsiz yol secildi.
  'inventory_json',
])

/**
 * Tamsayi tipinde de mesru olan TEK ad: tekil satirli tablolarin
 * (`deployment`, `sync_state`, `schema_state`) sabit birincil anahtari. Bir
 * tutar DEGILDIR ve olamaz: `CHECK (id = 1)`.
 */
const EXEMPT_INTEGER = new Set(['id'])

/** Butun muaf adlar -- yalnizca "olu giris" testi icin. */
const EXEMPT = new Set([...EXEMPT_NON_AMOUNT, ...EXEMPT_INTEGER])

/** Bu sutunun tipi icin gecerli muafiyet kumesi. */
function exemptFor(col: Col): ReadonlySet<string> {
  if (INTEGER_TYPES.has(col.data_type)) return EXEMPT_INTEGER
  if (NUMERIC_TYPES.has(col.data_type)) return NO_EXEMPTION
  return EXEMPT_NON_AMOUNT
}

const NO_EXEMPTION: ReadonlySet<string> = new Set()

interface Col {
  table_schema: string
  table_name: string
  relkind: string
  column_name: string
  data_type: string
  numeric_precision: number | null
  numeric_scale: number | null
}

type Ref = { table_name: string; column_name: string }

/**
 * Sutun tasiyan relkind'lar ve kapinin onlara ne yaptigi. Kume KATALOGLA
 * karsilastirilir: siniflandirilmamis bir relkind (ornegin bir MATVIEW ilk
 * kez eklendiginde) testi kirar ve ekleyeni karar vermeye zorlar.
 */
const EXAMINED_RELKINDS = new Set([
  'r', // ordinary table
  'p', // partitioned table
  'v', // view
  'm', // materialized view
  'f', // foreign table
])
/** Sutunu olan ama urun verisi TASIMAYAN relkind'lar. */
const IGNORED_RELKINDS = new Set([
  'c', // composite type
])

/**
 * SAYIMIN ERISIMI DE OLCULUR.
 *
 * Onceki hali `information_schema.columns WHERE table_schema='public'` idi ve
 * ERISIMI HIC OLCULMEMISTI -- yani I-1'in kapattigi ariza kipinin bir ust
 * kattaki hali. Iki tam kacis olculdu:
 *
 *   - `public` icindeki bir MATERIALIZED VIEW `examined`i SIFIR kadar
 *     oynatiyordu: information_schema matview'lari hic listelemez. Ve bu
 *     teorik degil: `volume_24h_wei` PENCERELI oldugu icin Task 11'e
 *     birakildi, ve onu bir matview olarak kurmak en bariz cozum.
 *   - `public` DISINDA bir semadaki tablo sifir bulgu uretiyordu -- `double
 *     precision` icin `banned` bile.
 *
 * Bu yuzden sayim `pg_class`/`pg_attribute`'tan gelir, SISTEM DISI HER
 * SEMADAN ve kullanici sutunu tasiyan HER relkind'dan. Ustelik relkind
 * kumesinin kendisi de -- tip boluntusu gibi -- iddia edilir.
 */
const ALL_COLUMNS = `
  SELECT n.nspname AS table_schema,
         c.relname AS table_name,
         c.relkind::text AS relkind,
         a.attname AS column_name,
         format_type(COALESCE(bt.oid, t.oid), NULL) AS data_type,
         CASE WHEN COALESCE(bt.typname, t.typname) = 'numeric' AND a.atttypmod <> -1
              THEN ((a.atttypmod - 4) >> 16) & 65535 END AS numeric_precision,
         CASE WHEN COALESCE(bt.typname, t.typname) = 'numeric' AND a.atttypmod <> -1
              THEN (a.atttypmod - 4) & 65535 END AS numeric_scale
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND c.relkind = ANY ('{r,p,v,m,f}')
  ORDER BY 1, 2, 4`

/** Kullanici sutunu tasiyan ve dolayisiyla kapinin bakmasi gereken relkind'lar. */
const DATA_RELKINDS = `
  SELECT DISTINCT c.relkind::text AS relkind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_%'
    AND c.relkind NOT IN ('i', 'I', 'S', 't')
  ORDER BY 1`

/** Sistem disi semalar. */
const SCHEMAS = `
  SELECT nspname AS name FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema')
    AND nspname NOT LIKE 'pg\\_%'
  ORDER BY 1`

const ref = (r: Col): Ref => ({ table_name: r.table_name, column_name: r.column_name })

interface Report {
  examined: number
  numerics: number
  integers: number
  /** Sistem disi semalar. `['public']` disina cikmasi bir bulgudur. */
  schemas: string[]
  /** Kataloga gore sutun tasiyan relkind'lardan siniflandirilmamis olanlar. */
  unclassifiedRelkinds: string[]
  /** Sayimin gercekten gordugu (sema, relkind) ciftleri -- erisimin kendisi. */
  reach: string[]
  /** Semada gecip de boluntude yeri olmayan tipler. */
  unclassified: string[]
  /** Kayan nokta / `money` tipli sutunlar. */
  banned: Ref[]
  /** `numeric` olup tam numeric(78,0) olmayan VEYA `_wei`/`_tok` ile bitmeyen. */
  badNumeric: Ref[]
  /** Tamsayi tipinde olup para adi tasiyan. */
  moneyNamedInteger: Ref[]
  /** Tamsayi tipinde olup bildirilmis bir para-disi sonek tasimayan. */
  undeclaredInteger: Ref[]
  /** 6 decimal gorunumu ima eden ad. */
  forbidden: Ref[]
  /** Tipten bagimsiz: hicbir bildirilmis sonek tasimayan ve muaf olmayan. */
  unsuffixed: Ref[]
  /**
   * Sayimin gordugu HER sutun, `sema:relkind:tablo.sutun` olarak sirali.
   *
   * `examined` bir SAYIDIR ve bir-cikar-bir-ekle ona gorunmez: gozden
   * gecirenin probe'u bunu calistirarak gosterdi (`SWAP: drop one column, add
   * one column -> delta +0, NO FINDING`). Kume o takasi gorur, ve fail-closed
   * OLCULUR: hem silme hem ekleme yonu asagida test ediliyor.
   */
  inventory: string[]
}

/**
 * KAPININ KENDISI, tek bir yerde. Hem gercek semaya hem de asagidaki NEGATIF
 * KONTROLLERE AYNI kod uygulanir -- iki ayri kopya olsaydi, negatif kontrolun
 * gecmesi gercek kapinin calistigini gostermezdi.
 */
async function gate(db: {
  query: (t: string) => Promise<{ rows: Record<string, string>[] }>
}): Promise<Report> {
  const all = (await db.query(ALL_COLUMNS)).rows as unknown as Col[]
  const relkinds = (await db.query(DATA_RELKINDS)).rows.map((r) => r['relkind'] as string)
  const schemas = (await db.query(SCHEMAS)).rows.map((r) => r['name'] as string)
  const numerics = all.filter((r) => NUMERIC_TYPES.has(r.data_type))
  const integers = all.filter((r) => INTEGER_TYPES.has(r.data_type))

  const classified = (t: string) =>
    NUMERIC_TYPES.has(t) || INTEGER_TYPES.has(t) || BANNED_TYPES.has(t) || NON_AMOUNT_TYPES.has(t)

  return {
    examined: all.length,
    numerics: numerics.length,
    integers: integers.length,
    schemas,
    unclassifiedRelkinds: relkinds
      .filter((k) => !EXAMINED_RELKINDS.has(k) && !IGNORED_RELKINDS.has(k))
      .sort(),
    reach: [...new Set(all.map((r) => `${r.table_schema}:${r.relkind}`))].sort(),
    unclassified: [...new Set(all.map((r) => r.data_type))].filter((t) => !classified(t)).sort(),
    banned: all.filter((r) => BANNED_TYPES.has(r.data_type)).map(ref),
    badNumeric: numerics
      .filter(
        (r) =>
          r.numeric_precision !== 78 || r.numeric_scale !== 0 || !MONEY_SUFFIX.test(r.column_name),
      )
      .map(ref),
    moneyNamedInteger: integers.filter((r) => MONEY_SUFFIX.test(r.column_name)).map(ref),
    undeclaredInteger: integers
      .filter((r) => !NON_MONEY_SUFFIX.test(r.column_name) && !EXEMPT_INTEGER.has(r.column_name))
      .map(ref),
    forbidden: all.filter((r) => FORBIDDEN.test(r.column_name)).map(ref),
    unsuffixed: all
      .filter(
        (r) =>
          !MONEY_SUFFIX.test(r.column_name) &&
          !NON_MONEY_SUFFIX.test(r.column_name) &&
          !exemptFor(r).has(r.column_name),
      )
      .map(ref),
    inventory: all
      .map((r) => `${r.table_schema}:${r.relkind}:${r.table_name}.${r.column_name}`)
      .sort(),
  }
}

/** Gecici bir sutunla kapiyi calistirir ve HER ZAMAN geri alir. */
async function withColumn(ddl: string, check: (r: Report) => void): Promise<void> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(ddl)
    check(await gate(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

/**
 * SAYIMIN GORDUGU HER SUTUN. Bir SAYI degil bir KUME, cunku gozden gecirenin
 * probe'u bir-cikar-bir-ekle takasinin sayiya gorunmez oldugunu calistirarak
 * gosterdi (`delta +0, NO FINDING`). Liste elle bakildiginda semanin tam
 * envanteri olarak da okunur.
 */
const EXPECTED_INVENTORY = [
  'public:r:creator_history.creator',
  'public:r:creator_history.from_seq',
  'public:r:creator_history.token',
  'public:r:curve_state.complete',
  'public:r:curve_state.completed_seq',
  'public:r:curve_state.curve',
  'public:r:curve_state.graduated',
  'public:r:curve_state.graduated_seq',
  'public:r:curve_state.graduation_base_tok',
  'public:r:curve_state.graduation_quote_wei',
  'public:r:curve_state.graduation_target_addr',
  'public:r:curve_state.last_seq',
  'public:r:curve_state.pool_seed_supply_tok',
  'public:r:curve_state.real_quote_reserves_wei',
  'public:r:curve_state.real_token_reserves_tok',
  'public:r:curve_state.token',
  'public:r:curve_state.virtual_quote_reserves_wei',
  'public:r:curve_state.virtual_token_reserves_tok',
  'public:r:deployment.chain_id',
  'public:r:deployment.escrow',
  'public:r:deployment.factory',
  'public:r:deployment.id',
  'public:r:deployment.protocol_treasury',
  'public:r:deployment.sale_supply_tok',
  'public:r:deployment.start_block',
  'public:r:deployment.total_supply_tok',
  'public:r:deployment.virtual_quote_reserves_wei',
  'public:r:deployment.virtual_token_reserves_tok',
  'public:r:fee_balances.claimable_wei',
  'public:r:fee_balances.claimed_total_wei',
  'public:r:fee_balances.deposited_total_wei',
  'public:r:fee_balances.last_seq',
  'public:r:fee_balances.recipient',
  'public:r:fee_events.amount_wei',
  'public:r:fee_events.block_number',
  'public:r:fee_events.block_time',
  'public:r:fee_events.event_seq',
  'public:r:fee_events.from_addr',
  'public:r:fee_events.kind',
  'public:r:fee_events.log_index',
  'public:r:fee_events.recipient',
  'public:r:fee_events.tx_hash',
  'public:r:holders.balance_tok',
  'public:r:holders.holder',
  'public:r:holders.last_seq',
  'public:r:holders.token',
  'public:r:launches.created_at',
  'public:r:launches.created_seq',
  'public:r:launches.curve',
  'public:r:launches.launch_creator',
  'public:r:launches.name',
  'public:r:launches.name_hex',
  'public:r:launches.salt',
  'public:r:launches.symbol',
  'public:r:launches.symbol_hex',
  'public:r:launches.token',
  'public:r:launches.tx_hash',
  'public:r:launches.uri',
  'public:r:launches.uri_hex',
  'public:r:rejected_launches.created_seq',
  'public:r:rejected_launches.curve',
  'public:r:rejected_launches.expected',
  'public:r:rejected_launches.raw_addr',
  'public:r:rejected_launches.raw_data_hex',
  'public:r:rejected_launches.raw_topics_hex',
  'public:r:rejected_launches.reason',
  'public:r:rejected_launches.seen_at',
  'public:r:rejected_launches.token',
  'public:r:schema_migrations.applied_at',
  'public:r:schema_migrations.checksum_hex',
  'public:r:schema_migrations.filename',
  'public:r:schema_state.fingerprint_hex',
  'public:r:schema_state.id',
  'public:r:schema_state.inventory_json',
  'public:r:schema_state.updated_at',
  'public:r:sync_state.head_block',
  'public:r:sync_state.id',
  'public:r:sync_state.last_block',
  'public:r:sync_state.last_block_hash',
  'public:r:sync_state.updated_at',
  'public:r:token_stats.ath_market_cap_wei',
  'public:r:token_stats.buy_count',
  'public:r:token_stats.created_at',
  'public:r:token_stats.created_seq',
  'public:r:token_stats.holder_count',
  'public:r:token_stats.last_buy_at',
  'public:r:token_stats.last_buy_seq',
  'public:r:token_stats.last_trade_at',
  'public:r:token_stats.last_trade_seq',
  'public:r:token_stats.market_cap_wei',
  'public:r:token_stats.token',
  'public:r:token_stats.trade_count',
  'public:r:token_stats.volume_24h_refreshed_at',
  'public:r:token_stats.volume_24h_wei',
  'public:r:token_stats.volume_total_wei',
  'public:r:token_transfers.amount_tok',
  'public:r:token_transfers.block_number',
  'public:r:token_transfers.block_time',
  'public:r:token_transfers.event_seq',
  'public:r:token_transfers.from_addr',
  'public:r:token_transfers.log_index',
  'public:r:token_transfers.to_addr',
  'public:r:token_transfers.token',
  'public:r:token_transfers.tx_hash',
  'public:r:trades.block_number',
  'public:r:trades.block_time',
  'public:r:trades.creator_fee_wei',
  'public:r:trades.curve',
  'public:r:trades.event_seq',
  'public:r:trades.is_buy',
  'public:r:trades.log_index',
  'public:r:trades.protocol_fee_wei',
  'public:r:trades.quote_amount_wei',
  'public:r:trades.real_quote_reserves_wei',
  'public:r:trades.real_token_reserves_tok',
  'public:r:trades.source',
  'public:r:trades.token',
  'public:r:trades.token_amount_tok',
  'public:r:trades.trader',
  'public:r:trades.tx_hash',
  'public:r:trades.virtual_quote_reserves_wei',
  'public:r:trades.virtual_token_reserves_tok',
  // ---------------------------------------------------------------
  // TURETILMIS OKUMA MODELI (007_views.sql). Bir VIEW'in sutunlari da
  // kapidan gecer: `relkind 'v'` incelenen kumededir, yani turetilmis bir
  // kolon da gorunumunu ADIYLA bildirmek zorundadir. `price_wei_per_tok`
  // adinin `price_wei_per_token` OLMAMASININ sebebi budur.
  // ---------------------------------------------------------------
  'public:v:token_overview.ath_market_cap_wei',
  'public:v:token_overview.buy_count',
  'public:v:token_overview.complete',
  'public:v:token_overview.completed_seq',
  'public:v:token_overview.created_at',
  'public:v:token_overview.created_seq',
  'public:v:token_overview.curve',
  'public:v:token_overview.fee_creator',
  'public:v:token_overview.graduated',
  'public:v:token_overview.graduated_seq',
  'public:v:token_overview.graduation_base_tok',
  'public:v:token_overview.graduation_quote_wei',
  'public:v:token_overview.graduation_raise_wei',
  'public:v:token_overview.graduation_target_addr',
  'public:v:token_overview.holder_count',
  'public:v:token_overview.last_buy_at',
  'public:v:token_overview.last_buy_seq',
  'public:v:token_overview.last_trade_at',
  'public:v:token_overview.last_trade_seq',
  'public:v:token_overview.launch_creator',
  'public:v:token_overview.market_cap_wei',
  'public:v:token_overview.name',
  'public:v:token_overview.pool_seed_supply_tok',
  'public:v:token_overview.price_wei_per_tok',
  'public:v:token_overview.progress_ppm',
  'public:v:token_overview.real_quote_reserves_wei',
  'public:v:token_overview.real_token_reserves_tok',
  'public:v:token_overview.symbol',
  'public:v:token_overview.token',
  'public:v:token_overview.trade_count',
  'public:v:token_overview.uri',
  'public:v:token_overview.virtual_quote_reserves_wei',
  'public:v:token_overview.virtual_token_reserves_tok',
  'public:v:token_overview.volume_24h_wei',
  'public:v:token_overview.volume_total_wei',
]

describe('adlandirma kapisi', () => {
  beforeAll(resetSchema)

  it('tip boluntusu semanin TAMAMINI kapsar', async () => {
    // Asagidaki butun kurallar "su tipteki sutunlar" diye baslar; hicbiri
    // boluntunun disinda kalan bir tipi goremez. Bu yuzden boluntunun kendisi
    // katalogla karsilastiriliyor.
    const g = await gate(pool)
    expect(g.unclassified).toEqual([])
  })

  // ---------------------------------------------------------------
  // SAYIMIN ERISIMI. Tip boluntusu dogru olsa bile, sayim bir iliskiyi hic
  // GORMUYORSA kural o iliskiye uygulanmaz. Onceki sayim iki seyi tamamen
  // kaciriyordu (olculdu): `public` icindeki matview'lar ve `public` disindaki
  // semalar. Asagidaki uc test erisimi OLCER.
  // ---------------------------------------------------------------

  it('SAYIM: incelenen sutunlarin KUMESI sabitlenir, sayisi degil', async () => {
    // `examined` bir SAYIDIR ve bir-cikar-bir-ekle ona gorunmez. Gozden
    // gecirenin probe'u bunu calistirarak gosterdi:
    //   SWAP: drop one column, add one column -> delta +0, NO FINDING
    // Kume o takasi gorur. Fail-closed'in IKI YONU de asagida OLCULUYOR --
    // "silince zaten kirilir" bir akil yurutmedir, olcum degil.
    const g = await gate(pool)
    // `expect(g.examined).toBe(g.inventory.length)` BURADAYDI ve BIR SEY
    // OLCMUYORDU: iki taraf da `all.length`ten, ayni ifadenin icinde turuyordu
    // -- yani `ALL_COLUMNS` bos donse bile `0 === 0` gecerdi. Sayim artik
    // BAGIMSIZ bir sorguyla, `information_schema` uzerinden dogrulaniyor;
    // `ALL_COLUMNS` katalogu okudugu icin bu gercekten ikinci bir olcumdur.
    const { rows: independent } = await pool.query<{ n: number }>(`
      SELECT count(*)::int n
      FROM information_schema.columns ic
      JOIN pg_class c ON c.relname = ic.table_name
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = ic.table_schema
      WHERE ic.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND ic.table_schema NOT LIKE 'pg\\_%'
        AND c.relkind = ANY ('{r,p,v,f}')`)
    // ON KOSUL YAZILI: `information_schema.columns` MATVIEW'lari HIC
    // listelemez (kapinin `pg_class`a gecmesinin sebebi de buydu), yani ikinci
    // olcum ancak matview YOKKEN esittir. Varsayilmiyor, SINANIYOR.
    const { rows: mv } = await pool.query<{ n: number }>(`
      SELECT count(*)::int n FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind = 'm'`)
    expect(mv[0]?.n).toBe(0)
    expect(independent[0]?.n).toBeGreaterThan(0)
    expect(g.examined).toBe(independent[0]?.n)
    expect(g.inventory).toEqual(EXPECTED_INVENTORY)
  })

  it('SAYIM fail-closed: bir sutun SILININCE kirilir', async () => {
    const before = await gate(pool)
    // SUTUN SECIMI: `token_overview` view'i `trade_count`a BAGIMLI oldugu icin
    // onu dusurmek artik bagimlilik hatasi verir (Postgres reddeder). Probe,
    // view'in OKUMADIGI bir sutuna tasindi -- olculen ozellik ayni: kume bir
    // sutun eksildigini gorur.
    await withColumn('ALTER TABLE token_stats DROP COLUMN volume_24h_refreshed_at', (g) => {
      expect(g.inventory).not.toEqual(EXPECTED_INVENTORY)
      expect(before.inventory.filter((x) => !g.inventory.includes(x))).toEqual([
        'public:r:token_stats.volume_24h_refreshed_at',
      ])
    })
  })

  it('SAYIM fail-closed: bir sutun EKLENINCE kirilir', async () => {
    await withColumn('ALTER TABLE token_stats ADD COLUMN extra_seq bigint', (g) => {
      // Adi kusursuz -- hicbir KURAL kovasina dusmez. Yakalayan tek sey kume.
      expect(g.undeclaredInteger).toEqual([])
      expect(g.unsuffixed).toEqual([])
      expect(g.inventory).not.toEqual(EXPECTED_INVENTORY)
      expect(g.inventory.filter((x) => !EXPECTED_INVENTORY.includes(x))).toEqual([
        'public:r:token_stats.extra_seq',
      ])
    })
  })

  it('SAYIM fail-closed: BIR CIKAR BIR EKLE (sayinin goremedigi takas)', async () => {
    // Probe'un `delta +0, NO FINDING` dedigi tam durum.
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE token_stats DROP COLUMN volume_24h_refreshed_at')
      await client.query('ALTER TABLE trades ADD COLUMN fill_count bigint')
      const g = await gate(client)
      // SAYI degismedi -- eski iddia bunu gecirirdi.
      expect(g.examined).toBe(EXPECTED_INVENTORY.length)
      // KUME degisti.
      expect(g.inventory).not.toEqual(EXPECTED_INVENTORY)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('SAYIM fail-closed: bir TABLO dusurulunce kirilir', async () => {
    await withColumn('DROP TABLE creator_history', (g) => {
      expect(g.inventory.filter((x) => x.startsWith('public:r:creator_history.'))).toEqual([])
      expect(g.inventory).not.toEqual(EXPECTED_INVENTORY)
    })
  })

  it('SAYIM: sistem disi tek sema `public`tir', async () => {
    // Kapsam iddiasi: baska bir semada tablo YOK. Olsaydi asagidaki erisim
    // testi onu gorurdu; bu test ise "bakmamiz gereken tek yer burasi"
    // ifadesini sabitler.
    expect((await gate(pool)).schemas).toEqual(['public'])
  })

  it('SAYIM: sutun tasiyan her relkind ya incelenir ya da acikca yok sayilir', async () => {
    // MATVIEW'LAR ICIN ONEMLI: `volume_24h_wei` PENCERELI oldugu icin Task
    // 11'e birakildi ve onu bir matview olarak kurmak en bariz cozum. Sayim
    // `pg_class`'tan geldigi icin boyle bir matview GORULUR; relkind kumesi de
    // burada sabitlenir ki yeni bir iliski tipi sessizce disarida kalmasin.
    const g = await gate(pool)
    expect(g.unclassifiedRelkinds).toEqual([])
    // Bugun semada yalnizca sirali tablolar var.
    expect(g.reach).toEqual(['public:r', 'public:v'])
  })

  it('her numeric TAM OLARAK numeric(78,0) ve _wei/_tok ile biter', async () => {
    const g = await gate(pool)
    // Bos kumeyi gecmesini onler -- "hepsi gecti" sifir sutun uzerinde de
    // dogrudur.
    expect(g.numerics).toBe(42)
    expect(g.badNumeric).toEqual([])
  })

  it('hicbir tamsayi sutunu para adi tasimaz', async () => {
    // Bir tutari `bigint`e koymak, 6 decimal gorunumu secmek demektir. Adi
    // `_wei`/`_tok` yapmak o secimi GIZLERDI; kural, parayi numeric(78,0)'a
    // mecbur birakir.
    const g = await gate(pool)
    expect(g.integers).toBeGreaterThan(0)
    expect(g.moneyNamedInteger).toEqual([])
  })

  it('her tamsayi sutunu bildirilmis bir para-disi sonek tasir', async () => {
    expect((await gate(pool)).undeclaredInteger).toEqual([])
  })

  it('kayan nokta ve money tipi semada hic yok', async () => {
    expect((await gate(pool)).banned).toEqual([])
  })

  it('hicbir kolon 6 decimal gorunumu ima etmez', async () => {
    expect((await gate(pool)).forbidden).toEqual([])
  })

  it('her kolon tanimli bir sonek tasir', async () => {
    // Muafiyet listesi ACIKTIR: yeni bir sonekisiz kolon eklemek bu testi
    // kirar ve ekleyeni ya sonek koymaya ya listeyi buyutmeye ZORLAR. Sessiz
    // bir `amount` kolonu imkansiz.
    expect((await gate(pool)).unsuffixed).toEqual([])
  })

  it('muafiyet listesinde OLU giris yoktur', async () => {
    // Bir muafiyet, korudugu sutun silindikten sonra listede kalirsa, listeye
    // bakan biri o adin hala mesru oldugunu sanir. Liste semayla birlikte
    // yasar.
    const { rows } = await pool.query<Col>(ALL_COLUMNS)
    const live = new Set(rows.map((r) => r.column_name))
    expect([...EXEMPT].filter((n) => !live.has(n))).toEqual([])
  })

  // ---------------------------------------------------------------
  // NEGATIF KONTROLLER -- TIP BASINA BIR TANE.
  //
  // Kural basina degil TIP basina, cunku kapinin kacirdigi sey bir kural
  // degil bir TIPTI. Her biri gecici bir sutun ekler, AYNI kapi kodunu
  // calistirir, kirildigini gosterir ve geri alir.
  // ---------------------------------------------------------------

  it("numeric(78,6): olcek yanlissa yakalanir (gozden gecirenin 1. probe'u)", async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN price_wei numeric(78,6)', (g) => {
      expect(g.badNumeric).toEqual([{ table_name: 'trades', column_name: 'price_wei' }])
      // Sonek kapisi bunu GORMEZ -- `_wei` bildirilmis bir sonektir. Yakalayan
      // sey tip+olcek kurali; ikisinin AYRI isleri oldugu boyle gorulur.
      expect(g.unsuffixed).toEqual([])
    })
  })

  it("ciplak numeric: precision NULL da kacamaz (gozden gecirenin 2. probe'u)", async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN quote_number numeric', (g) => {
      expect(g.badNumeric).toEqual([{ table_name: 'trades', column_name: 'quote_number' }])
    })
  })

  it('bigint: sonekisiz bir tutar yakalanir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN amount bigint', (g) => {
      expect(g.undeclaredInteger).toEqual([{ table_name: 'trades', column_name: 'amount' }])
      expect(g.unsuffixed).toEqual([{ table_name: 'trades', column_name: 'amount' }])
    })
  })

  it('bigint: para ADLI bir tamsayi yakalanir (6 decimal gorunumun dogal evi)', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN fee_wei bigint', (g) => {
      expect(g.moneyNamedInteger).toEqual([{ table_name: 'trades', column_name: 'fee_wei' }])
      // ESKI KAPININ IKI TESTI DE BUNU KACIRIRDI: numeric degil, ve `_wei`
      // bildirilmis bir sonek. Gozden gecirmenin isaret ettigi delik buydu.
      expect(g.badNumeric).toEqual([])
      expect(g.unsuffixed).toEqual([])
    })
  })

  it('integer ve smallint de ayni kurala tabidir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN fee_tok integer', (g) => {
      expect(g.moneyNamedInteger).toEqual([{ table_name: 'trades', column_name: 'fee_tok' }])
    })
    await withColumn('ALTER TABLE trades ADD COLUMN dust_tok smallint', (g) => {
      expect(g.moneyNamedInteger).toEqual([{ table_name: 'trades', column_name: 'dust_tok' }])
    })
  })

  it('double precision ve real yasaktir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN price_wei double precision', (g) => {
      expect(g.banned).toEqual([{ table_name: 'trades', column_name: 'price_wei' }])
    })
    await withColumn('ALTER TABLE trades ADD COLUMN rate_ppm real', (g) => {
      expect(g.banned).toEqual([{ table_name: 'trades', column_name: 'rate_ppm' }])
      // Adi kusursuz; yakalayan sey YALNIZCA tip.
      expect(g.unsuffixed).toEqual([])
    })
  })

  it('money tipi yasaktir', async () => {
    await withColumn('ALTER TABLE trades ADD COLUMN fee_wei money', (g) => {
      expect(g.banned).toEqual([{ table_name: 'trades', column_name: 'fee_wei' }])
    })
  })

  it('BOLUNTUNUN DISINDAKI bir tip sessizce kacamaz', async () => {
    // Kapinin erisimini "olculmus" yapan sey budur. `interval` ve `inet` ne
    // sayisal ne de metinsel kumede; boluntu testi onlari YAKALAR ve ekleyeni
    // ya siniflandirmaya ya reddetmeye zorlar.
    await withColumn('ALTER TABLE trades ADD COLUMN nap interval', (g) => {
      expect(g.unclassified).toEqual(['interval'])
    })
    await withColumn('ALTER TABLE trades ADD COLUMN net inet', (g) => {
      expect(g.unclassified).toEqual(['inet'])
    })
  })

  // ---------------------------------------------------------------
  // ERISIM KACISLARI -- gozden gecirmenin olctugu iki tam kacis.
  // ---------------------------------------------------------------

  it('KACIS: `public` icindeki bir MATERIALIZED VIEW artik gorulur', async () => {
    // Olculen eski davranis: matview `examined`i SIFIR kadar oynatiyordu,
    // cunku information_schema matview'lari hic listelemez.
    const before = await gate(pool)
    await withColumn(
      `CREATE MATERIALIZED VIEW mv_window AS
         SELECT token, sum(quote_amount_wei)::numeric(78,6) AS price_wei,
                count(*)::bigint AS amount
         FROM trades GROUP BY token`,
      (g) => {
        // Sayim GERCEKTEN buyudu.
        expect(g.examined).toBe(before.examined + 3)
        expect(g.reach).toEqual(['public:m', 'public:r', 'public:v'])
        // Ve kurallar matview'a da uygulaniyor.
        expect(g.badNumeric).toEqual([{ table_name: 'mv_window', column_name: 'price_wei' }])
        expect(g.undeclaredInteger).toEqual([{ table_name: 'mv_window', column_name: 'amount' }])
      },
    )
    expect((await gate(pool)).examined).toBe(before.examined)
  })

  it('KACIS: baska bir SEMADAKI tablo artik gorulur', async () => {
    // Olculen eski davranis: `public` disindaki bir tablo sifir bulgu
    // uretiyordu -- `double precision` icin `banned` bile.
    const before = await gate(pool)
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE SCHEMA reporting')
      await client.query('CREATE TABLE reporting.rollup (price double precision, amount bigint)')
      const g = await gate(client)
      expect(g.examined).toBe(before.examined + 2)
      expect(g.schemas).toEqual(['public', 'reporting'])
      expect(g.reach).toEqual(['public:r', 'public:v', 'reporting:r'])
      expect(g.banned).toEqual([{ table_name: 'rollup', column_name: 'price' }])
      expect(g.undeclaredInteger).toEqual([{ table_name: 'rollup', column_name: 'amount' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect((await gate(pool)).schemas).toEqual(['public'])
  })

  it('KACIS: bir VIEW de kurallara tabidir', async () => {
    const before = await gate(pool)
    await withColumn(
      `CREATE VIEW v_leak AS SELECT event_seq, quote_amount_wei AS fee_usdc FROM trades`,
      (g) => {
        expect(g.examined).toBe(before.examined + 2)
        expect(g.forbidden).toEqual([{ table_name: 'v_leak', column_name: 'fee_usdc' }])
      },
    )
  })

  // ---------------------------------------------------------------
  // MUAFIYETIN TIP DELIGI -- gozden gecirenin probe'u calistirilarak
  // ispatlandi. Alti muaf adin ALTISI da `bigint` olarak butun kovalardan
  // geciyordu.
  // ---------------------------------------------------------------
  it('MUAF bir AD, tamsayi tipinde artik muaf DEGILDIR', async () => {
    for (const nm of ['token', 'name', 'reason', 'salt', 'source', 'is_buy', 'filename']) {
      await withColumn(`CREATE TABLE probe_${nm} ("${nm}" bigint)`, (g) => {
        expect(g.undeclaredInteger, nm).toEqual([{ table_name: `probe_${nm}`, column_name: nm }])
        expect(g.unsuffixed, nm).toEqual([{ table_name: `probe_${nm}`, column_name: nm }])
      })
    }
  })

  it('`is_buy`i dusurup bigint olarak geri eklemek de yakalanir', async () => {
    // Probe'un `DROP then RE-ADD (attisdropped path)` senaryosu: eskiden
    // delta 0 ve HIC BULGU YOKTU.
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('ALTER TABLE trades DROP COLUMN is_buy')
      await client.query('ALTER TABLE trades ADD COLUMN is_buy bigint')
      const g = await gate(client)
      expect(g.undeclaredInteger).toEqual([{ table_name: 'trades', column_name: 'is_buy' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('`_json` bir SONEK DEGILDIR: kap adi, miktar turu degil', async () => {
    // `_json` bir sonek olarak kabul edilmisti ve olculdu ki `NON_MONEY_SUFFIX`i
    // `undeclaredInteger` de okudugu icin metinle sinirli kalmiyordu. Ucu de
    // ESKIDEN hicbir kovaya dusmuyordu.
    for (const [col, type] of [
      ['fee_json', 'bigint'],
      ['amount_json', 'bigint'],
      ['balance_json', 'integer'],
    ] as const) {
      await withColumn(`CREATE TABLE probe_j (${col} ${type})`, (g) => {
        expect(g.undeclaredInteger, col).toEqual([{ table_name: 'probe_j', column_name: col }])
        expect(g.unsuffixed, col).toEqual([{ table_name: 'probe_j', column_name: col }])
      })
    }
  })

  it('`inventory_json` TAM AD olarak muaftir ve gecer', async () => {
    // Muafiyet tip-kapsamlidir: metin olarak gecer, tamsayi olarak GECMEZ.
    const g = await gate(pool)
    expect(g.unsuffixed).toEqual([])
    expect(g.inventory).toContain('public:r:schema_state.inventory_json')
    await withColumn('CREATE TABLE probe_inv (inventory_json bigint)', (h) => {
      expect(h.undeclaredInteger).toEqual([
        { table_name: 'probe_inv', column_name: 'inventory_json' },
      ])
    })
  })

  it('SINIR, ACIKCA: GENERATED bir 1e12 kucultmesi bildirilmis adla GECER', async () => {
    // Kapinin ne YAPMADIGINI kayda geciriyor. Gercek bir gorunum hatasi, ama
    // `_number` bildirilmis bir sonek oldugu icin kapi onu gecirir. Kapinin
    // verdigi sey, birinin o adi SECMIS olmasidir.
    await withColumn(
      `ALTER TABLE trades ADD COLUMN quote_number bigint
       GENERATED ALWAYS AS ((quote_amount_wei / 1000000000000)::bigint) STORED`,
      (g) => {
        expect(g.undeclaredInteger).toEqual([])
        expect(g.unsuffixed).toEqual([])
        expect(g.moneyNamedInteger).toEqual([])
        // Ama KUME onu gorur -- yani sonradan sessizce eklenemez.
        expect(g.inventory).toContain('public:r:trades.quote_number')
        expect(g.inventory).not.toEqual(EXPECTED_INVENTORY)
      },
    )
  })

  it('SINIR, ACIKCA: `id bigint` cok satirli bir tabloda GECER', async () => {
    // DOCSTRING'IN IKINCI SINIRI, artik KENDI testiyle. Gozden geciren bunu
    // kayda gecirdi: iki sinirdan biri (`GENERATED`) icin yazilmis bir test
    // vardi, otekini yalnizca BASKA BIR SEY icin yazilmis bir test
    // (`MUAF bir AD, hala kendi tipinde muaftir`, `id smallint` ile) tesadufen
    // tutuyordu ve o testin yorumu `CHECK (id = 1)`den hic bahsetmiyordu --
    // yani "kimsenin yazmadigi bir gerekce yuzunden gecen test".
    //
    // `id` muafiyeti tekil satir gerekcesine DAYANIR (`deployment`,
    // `sync_state`, `schema_state` hepsi `CHECK (id = 1)` tasir) ama kapi o
    // CHECK'i HIC OKUMAZ: muafiyet ADIN kendisine verilmistir. Asagidaki tablo
    // IKI satir tasir ve SIFIR kisiti vardir, ve kapi yine de sessizdir.
    // Kapatmak, kisitlari yorumlamak demek olurdu -- kapi bunu yapmaz; komsu
    // savunma (parmak izi) yapar, ve alt tarafta o da olculuyor.
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TABLE many_probe (id bigint, token text)')
      await client.query('INSERT INTO many_probe (id, token) VALUES (1, $1), (2, $2)', [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
      ])
      const { rows: cons } = await client.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_constraint WHERE conrelid = 'many_probe'::regclass`,
      )
      const { rows: many } = await client.query<{ n: number }>(
        'SELECT count(*)::int n FROM many_probe',
      )
      // Gerekce GERCEKTEN yok: iki satir, sifir kisit.
      expect(cons[0]?.n).toBe(0)
      expect(many[0]?.n).toBe(2)

      const g = await gate(client)
      expect(g.undeclaredInteger).toEqual([])
      expect(g.unsuffixed).toEqual([])
      // Ama KUME onu gorur -- sinirin komsu yarisi. `id bigint` bir tabloya
      // sonradan sessizce eklenemez.
      expect(g.inventory).toContain('public:r:many_probe.id')
      expect(g.inventory).not.toEqual(EXPECTED_INVENTORY)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('MUAF bir AD, hala kendi tipinde muaftir (kapi fazla siki degil)', async () => {
    // `is_buy boolean`, `token text` gecmeye devam etmeli; aksi halde sema
    // adlarinin yarisini yeniden adlandirmak gerekirdi.
    //
    // NOT: bu test bir POZITIF KONTROLDUR ve `id smallint` iceriyor olmasi
    // TESADUFTUR. `id` muafiyetinin SINIR yarisi artik yukaridaki
    // `SINIR, ACIKCA: \`id bigint\`...` testinde, kendi gerekcesiyle duruyor.
    await withColumn('CREATE TABLE probe_ok (is_buy boolean, token text, id smallint)', (g) => {
      expect(g.unsuffixed).toEqual([])
      expect(g.undeclaredInteger).toEqual([])
    })
  })

  // ---------------------------------------------------------------
  // PROBE'DAN GELEN RELKIND KAPSAMI. Bunlar SQL'de yaziliydi ama hicbir test
  // olusturmuyordu -- yani yalnizca YAPI GEREGI iddia ediliyorlardi. Artik
  // olculuyorlar.
  // ---------------------------------------------------------------
  it('RELKIND p: bolumlenmis tablo ve COCUKLARI gorulur', async () => {
    const before = await gate(pool)
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE TABLE part_parent (token text, fee_wei bigint)
                          PARTITION BY RANGE (token)`)
      await client.query(`CREATE TABLE part_a PARTITION OF part_parent
                          FOR VALUES FROM ('a') TO ('m')`)
      const g = await gate(client)
      // Ebeveyn (p) + cocuk (r) = 4 sutun.
      expect(g.examined).toBe(before.examined + 4)
      expect(g.reach).toEqual(['public:p', 'public:r', 'public:v'])
      expect(g.moneyNamedInteger.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual([
        'part_a.fee_wei',
        'part_parent.fee_wei',
      ])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('RELKIND f: yabanci tablo gorulur', async () => {
    const before = await gate(pool)
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE EXTENSION IF NOT EXISTS file_fdw')
      await client.query('CREATE SERVER probe_fs FOREIGN DATA WRAPPER file_fdw')
      await client.query(`CREATE FOREIGN TABLE ft_leak (fee_usdc double precision, amount bigint)
                          SERVER probe_fs OPTIONS (filename 'C:/Windows/win.ini', format 'csv')`)
      const g = await gate(client)
      expect(g.examined).toBe(before.examined + 2)
      expect(g.reach).toEqual(['public:f', 'public:r', 'public:v'])
      expect(g.banned).toEqual([{ table_name: 'ft_leak', column_name: 'fee_usdc' }])
      expect(g.forbidden).toEqual([{ table_name: 'ft_leak', column_name: 'fee_usdc' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('RELKIND m, `public` DISINDA: matview + yabanci sema birlikte gorulur', async () => {
    // Onceki "yabanci sema" testi bir SEMA kacisiydi, relkind kacisi degil;
    // ikisi birlikte hic denenmemisti.
    const before = await gate(pool)
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE SCHEMA rollup')
      await client.query(`CREATE MATERIALIZED VIEW rollup.mv AS
                          SELECT token, 1::double precision AS fee_usdc FROM launches`)
      const g = await gate(client)
      expect(g.examined).toBe(before.examined + 2)
      expect(g.reach).toEqual(['public:r', 'public:v', 'rollup:m'])
      expect(g.schemas).toEqual(['public', 'rollup'])
      expect(g.banned).toEqual([{ table_name: 'mv', column_name: 'fee_usdc' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('KAPSAM DISI, ACIKCA: `pg_temp` ve kullanilmayan composite type', async () => {
    // Ikisi de probe'da `ESCAPED`/artefakt olarak gorundu ve ikisi de BILEREK
    // disarida. Sessiz kalmasinlar diye burada ISIMLERIYLE duruyorlar.
    //
    // - `pg_temp_N`: oturuma bagli; oturum bitince yok olur, urun verisi
    //   tasiyamaz. `pg\_%` suzgeci onu disarida birakir.
    // - Kullanilmayan bir composite type (relkind `c`): hicbir sey saklamaz.
    //   Bir SUTUN onu kullandigi anda tipi `unclassified`a duser ve kapi
    //   kirilir -- asagida olculuyor.
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TEMP TABLE t_leak (fee_usdc double precision)')
      await client.query('CREATE TYPE money_t AS (fee_usdc double precision)')
      const g = await gate(client)
      expect(g.reach).toEqual(['public:r', 'public:v'])
      expect(g.schemas).toEqual(['public'])
      expect(g.banned).toEqual([])
      // Ama o tipi KULLANAN bir sutun yakalanir:
      await client.query('ALTER TABLE trades ADD COLUMN blob money_t')
      expect((await gate(client)).unclassified).toEqual(['money_t'])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('POZITIF KONTROL: fill_count bigint GECER (kapi fazla siki degil)', async () => {
    // Gozden gecirenin ucuncu probe'u. Bu bir KUSUR DEGILDIR ve reddetmek
    // semadaki her sayaci numeric(78,0)'a iterdi. Kapinin buradan gecmesi,
    // yukaridaki sertlestirmelerin fazla genis OLMADIGININ kanitidir.
    await withColumn('ALTER TABLE trades ADD COLUMN fill_count bigint', (g) => {
      expect(g.badNumeric).toEqual([])
      expect(g.moneyNamedInteger).toEqual([])
      expect(g.undeclaredInteger).toEqual([])
      expect(g.unsuffixed).toEqual([])
      expect(g.banned).toEqual([])
      expect(g.unclassified).toEqual([])
    })
  })

  it('NEGATIF KONTROL: amount_uusdc eklenince kapi UC testte birden kirilir', async () => {
    // Planin teslim kriteri: "`amount_uusdc` eklenince adlandirma kapisi iki
    // testte kirilir". Iddia edilmiyor, calistiriliyor -- ve aslinda uc.
    await withColumn('ALTER TABLE trades ADD COLUMN amount_uusdc numeric(78,0)', (g) => {
      const one = [{ table_name: 'trades', column_name: 'amount_uusdc' }]
      expect(g.badNumeric).toEqual(one)
      expect(g.forbidden).toEqual(one)
      expect(g.unsuffixed).toEqual(one)
    })
  })

  it('geri alma gercekten oldu: sema tertemiz', async () => {
    const g = await gate(pool)
    expect(g.unclassified).toEqual([])
    expect(g.banned).toEqual([])
    expect(g.badNumeric).toEqual([])
    expect(g.moneyNamedInteger).toEqual([])
    expect(g.undeclaredInteger).toEqual([])
    expect(g.forbidden).toEqual([])
    expect(g.unsuffixed).toEqual([])
  })
})
