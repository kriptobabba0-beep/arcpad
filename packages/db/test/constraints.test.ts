import { beforeAll, describe, expect, it } from 'vitest'
import { putDeployment } from '../src/deployment'
import { replayRange } from '../src/apply'
import type { PoolClient } from '../src/pool'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import {
  addr,
  ALICE,
  CURVE,
  DEPLOYMENT,
  GENESIS,
  hash32,
  hashFor,
  RANGE,
  RANGE_TO,
  TOKEN,
} from './fixtures'

/**
 * `public` icindeki ORDINARY tablolarin TAM listesi. Sayi degil KUME: eskiden
 * `toHaveLength(14)` idi ve bir tabloyu silip baskasini eklemeye GORUNMEZDI.
 */
const ALL_TABLES = [
  'chat_messages',
  'creator_history',
  'curve_state',
  'deployment',
  'fee_balances',
  'fee_events',
  'holders',
  'launches',
  'limit_orders',
  'rejected_launches',
  'schema_migrations',
  'schema_state',
  'sync_state',
  'token_stats',
  'token_transfers',
  'trades',
]

interface PgError extends Error {
  code?: string
  constraint?: string
}

async function failure(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn()
  } catch (error) {
    return error as PgError
  }
  throw new Error('beklenen hata olusmadi')
}

describe('kisitlar gercekten bagli mi', () => {
  beforeAll(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)
    await replayRange(pool, RANGE, RANGE_TO, hashFor(RANGE_TO), GENESIS)
    // Elle inceleme tablosunun da bir tohum satiri olsun ki asagidaki tarama
    // onu de kapsayabilsin.
    await pool.query(
      `INSERT INTO rejected_launches
         (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
       VALUES ($1, $2, $3, 'not_canonical', $4, $5, $6, '0x')`,
      [
        toSeq(54_000_001n, 0).toString(),
        addr(0xbad),
        addr(0xbad1),
        addr(0x900d),
        addr(0xfac),
        hash32(0x70b1),
      ],
    )
    /*
     * CHAT'IN TOHUM SATIRI. Bu tarama "her tablo BOS OLMAMALI" diye bir
     * muhafiz tasiyor (I-5) ve satirlarini var olan bir satiri KOPYALAYARAK
     * bozuyor -- yani tohumu olmayan bir tablo taramadan SESSIZCE duserdi.
     *
     * `chat_messages`in yazicisi indexer DEGIL, `web`in POST rotasidir, yani
     * `replayRange` onu asla doldurmaz ve tohum elle konmak ZORUNDA.
     */
    await pool.query(
      `INSERT INTO chat_messages
         (token, author_addr, body, balance_tok, balance_block_number,
          nonce_hex, signature_hex, issued_at)
       VALUES ($1, $2, 'gm', 1, 55000000, $3, $4, now())`,
      [TOKEN, ALICE, hash32(0xc4a7), `0x${'ab'.repeat(65)}`],
    )
    /*
     * EMIRLERIN TOHUM SATIRI, ayni gerekceyle: `limit_orders`in yazicisi da
     * indexer degil `web`in POST rotasidir, yani `replayRange` onu asla
     * doldurmaz ve tohumsuz bir tablo bosluk muhafizini patlatirdi.
     *
     * ALIM tarafi secildi cunku `limit_orders_side_units_check` iki daldan
     * BIRINI dolu ister; satiri KOPYALAYIP tek bir sutunu bozan tarama, o
     * dalin butun sutunlarini birlikte tasir ve boylece yalnizca bozulan
     * sutunun kisitini olcer.
     */
    await pool.query(
      `INSERT INTO limit_orders
         (token, owner_addr, is_buy, amount_wei, min_out_tok, status, expires_at,
          nonce_hex, signature_hex, issued_at)
       VALUES ($1, $2, true, 1000000000000000000, 500, 'open', now() + interval '1 day',
               $3, $4, now())`,
      [TOKEN, ALICE, hash32(0x0dea), `0x${'cd'.repeat(65)}`],
    )
  })

  // ---------------------------------------------------------------
  // "BIR TABLODA TEST EDILEN KISIT HEPSINDE TEST EDILMIS GIBI OKUNUR."
  //
  // Adres deseni `^0x[0-9a-f]{40}$` semada ON BES ayri sutunda tekrar ediyor.
  // `launches.token`'a buyuk harfli bir adres yazmaya calisip reddedildigini
  // gormek, `trades.trader`'in de reddettigini GOSTERMEZ. Bu yuzden aile
  // orneklenmez, KATALOGDAN TURETILIP TAMAMI taranir: kacini test ettigimizi
  // sayarken degil, semanin kac tane oldugunu SOYLEMESINE gore.
  //
  // Her sutun icin gercek bir INSERT denenir: var olan gecerli bir satir
  // jsonb uzerinden kopyalanir, YALNIZCA hedef sutun bozulur ve yeniden
  // yazilir. Bu, kisitin o sutuna BAGLI oldugunu gosterir -- `pg_constraint`
  // icinde bir metnin var oldugunu degil.
  // ---------------------------------------------------------------
  it('adres deseni tasiyan HER sutun buyuk harfli adresi reddeder', async () => {
    const { rows: guarded } = await pool.query<{ rel: string; col: string }>(`
      SELECT c.conrelid::regclass::text AS rel, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.connamespace = 'public'::regnamespace AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%[0-9a-f]{40}%'
      ORDER BY 1, 2`)

    expect(guarded.map((g) => `${g.rel}.${g.col}`)).toEqual([
      'chat_messages.author_addr',
      'creator_history.creator',
      'curve_state.curve',
      'curve_state.graduation_target_addr',
      'deployment.escrow',
      'deployment.factory',
      'deployment.protocol_treasury',
      'fee_balances.recipient',
      'fee_events.from_addr',
      'fee_events.recipient',
      'holders.holder',
      'launches.curve',
      'launches.launch_creator',
      'launches.token',
      'limit_orders.owner_addr',
      'rejected_launches.expected',
      'rejected_launches.raw_addr',
      'token_transfers.from_addr',
      'token_transfers.to_addr',
      'trades.trader',
    ])

    // EIP-55 checksum'li bicim. Zincirden gelen adresler BOYLE gelir; kucuk
    // harfe indirmeyi unutan bir yazici tam olarak bunu gonderir.
    const MIXED = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01'
    const VALID = '0x00000000000000000000000000000000deadbeef'

    /**
     * COK SUTUNLU BIR INVARIANTIN ICINDE DURAN SUTUNLAR ICIN YOLDAS ALANLAR.
     *
     * POZITIF KONTROLU MUMKUN KILAR, KAPIYI GEVSETMEZ. `curve_state`in
     * `graduated_iff_payout` kisiti "mezun bir satir DORT alani da doludur, ve
     * mezun OLMAYAN bir satir DORDUNU DE bos tutar" der. Yani mezun olmayan
     * bir satira TEK BASINA gecerli bir `graduation_target_addr` yazmak
     * MESRU DEGILDIR ve 23514 verir -- desen kisiti calismadigi icin degil,
     * BASKA bir kisit dogru calistigi icin. Yoldas alanlar olmadan pozitif
     * kontrol dogru sebeple basarisiz olur ve testi YANLIS sebeple kirmizi
     * yapar.
     *
     * Kisiti tek yonlu yapmak (yalnizca `graduated => dolu`) bu satiri
     * gereksiz kilardi ve YANLIS OLURDU: o zaman canli bir curve'un satirinda
     * bir graduation hedefi durabilir ve `token_overview` onu disari verirdi
     * -- kullaniciya "bu curve mezun oldu" diyen bir alan, mezun olmayan bir
     * curve icin.
     */
    const COMPANION: Record<string, Record<string, unknown>> = {
      'curve_state.graduation_target_addr': {
        graduated: true,
        graduated_seq: '99999999',
        graduation_base_tok: '0',
        graduation_quote_wei: '0',
      },
    }

    const client: PoolClient = await pool.connect()
    const checked: string[] = []
    try {
      await client.query('BEGIN')
      for (const { rel, col } of guarded) {
        await client.query('SAVEPOINT s')
        // `$1::text, $2::text` ACIK CAST: castsiz hali `creator_history` icin
        // 42P18 (indeterminate parameter datatype) veriyordu ve o tablo icin
        // test yanlis sebeple kirmizi oluyordu.
        //
        // `$3::jsonb` YOLDAS ALANLAR icin ve varsayilani `{}`tir, yani bu
        // taramanin on yedi sutunundan on altisi icin hicbir sey degistirmez.
        /*
         * `OVERRIDING SYSTEM VALUE` OLMADAN BU TARAMA `chat_messages`TE
         * PATLIYORDU, ve verdigi hata 23514 DEGIL 428C9 idi
         * ("cannot insert a non-DEFAULT value into column message_seq").
         *
         * Sebep: `chat_messages.message_seq` `GENERATED ALWAYS AS IDENTITY`.
         * Bu tarama satiri OLDUGU GIBI kopyalar, yani kimlik sutununu da
         * yazmaya calisir. `OVERRIDING SYSTEM VALUE` o yasagi bu ifade icin
         * kaldirir ve kimlik sutunu OLMAYAN tablolarda hicbir sey degistirmez
         * (olculdu: bir identity sutunu bulunmayan tabloda da kabul edilir).
         *
         * Kopyalanan satirin birincil anahtari CAKISIR, ama bu taramayi
         * bozmaz: CHECK kisitlari satir duzeyinde, benzersizlik ise indekse
         * yazarken denetlenir -- yani BOZUK adres yine 23514 verir, ve
         * pozitif kontrol zaten yalnizca "23514 DEGIL" iddiasindadir.
         */
        const mutate = `
          INSERT INTO ${rel} OVERRIDING SYSTEM VALUE
          SELECT (jsonb_populate_record(
                    NULL::${rel},
                    to_jsonb(x) || jsonb_build_object($1::text, $2::text) || $3::jsonb)).*
          FROM ${rel} x LIMIT 1`
        const companion = JSON.stringify(COMPANION[`${rel}.${col}`] ?? {})

        const bad = await failure(() => client.query(mutate, [col, MIXED, companion]))
        expect(bad.code, `${rel}.${col} 23514 vermeliydi, ${bad.code} verdi`).toBe('23514')
        // Sutun ADI kisitin adinda geciyor: patlayan sey BU sutunun muhafizi,
        // baska bir sutunun ya da baska bir tablonunki degil.
        expect(bad.constraint).toBe(`${rel}_${col}_check`)
        await client.query('ROLLBACK TO SAVEPOINT s')

        // POZITIF KONTROL: ayni mutasyon GECERLI bir adresle 23514 VERMEZ.
        // Bu olmadan yukaridaki iddia, satirin baska bir sebeple bozulmus
        // olmasiyla da saglanabilirdi.
        await client.query('SAVEPOINT s2')
        try {
          await client.query(mutate, [col, VALID, companion])
        } catch (error) {
          const e = error as PgError
          expect(e.code, `${rel}.${col} gecerli adreste 23514 verdi`).not.toBe('23514')
        }
        await client.query('ROLLBACK TO SAVEPOINT s2')
        checked.push(`${rel}.${col}`)
      }
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    // Tarama gercekten butun aileyi gezdi.
    expect(checked).toHaveLength(20)
  })

  it('adres tasiyan HER sutun ya desenle ya yabanci anahtarla korunur', async () => {
    // Yukaridaki tarama YALNIZCA desenli sutunlari gorur. Adres tasiyip deseni
    // OLMAYAN sutunlar da var (`trades.token`, `curve_state.token`, ...); onlar
    // `launches`'a yabanci anahtardir ve bicim garantisini oradan DEVRALIR.
    //
    // ADAYLAR ARTIK ELLE YAZILMIS BIR AD LISTESINDEN GELMIYOR. Onceki hali
    // `a.attname IN ('token','curve',...)` idi ve `fee_recipient` ya da
    // `graduation_target` gibi YENI bir adres sutunu her iki adres testine de
    // GORUNMEZ olurdu -- yani "adreslerin hepsi korundu" ifadesinin erisimi
    // varsayimdi. Simdi aday kumesi VERIDEN olculuyor: tohumlanmis
    // veritabanindaki her metin sutunu okunur ve butun NULL-olmayan degerleri
    // adres desenine uyan her sutun, adini kim koymus olursa olsun, adaydir.
    const { rows: textCols } = await pool.query<{ rel: string; col: string }>(`
      SELECT c.relname AS rel, a.attname AS col
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind = 'r' AND a.atttypid = 'text'::regtype
      ORDER BY 1, 2`)
    expect(textCols.length).toBeGreaterThan(0)

    const candidates: { rel: string; col: string }[] = []
    for (const { rel, col } of textCols) {
      const { rows } = await pool.query<{ n: number; addressy: number }>(
        `SELECT count(v)::int AS n,
                count(*) FILTER (WHERE v ~ '^0x[0-9a-f]{40}$')::int AS addressy
         FROM (SELECT "${col}" AS v FROM "${rel}") s`,
      )
      const r = rows[0]
      if (r && r.n > 0 && r.n === r.addressy) candidates.push({ rel, col })
    }

    // Olcum ancak her tablonun SATIRI varsa anlamli; bos bir tablo her sutunu
    // sessizce aday olmaktan cikarirdi. Bu, "test tesadufen bos oldugu icin
    // gecti" arizasinin bu testteki hali.
    //
    // ONCEKI HALI KENDISI BOS GECIYORDU. Aday tablolari `c.reltuples = 0` ile
    // suzuyordu; PostgreSQL >= 14'te hic ANALYZE edilmemis bir iliskinin
    // `reltuples` degeri **-1**'dir ve az once sifirlanmis bir veritabaninda
    // BU HER TABLO demektir. Olculdu: 13 tablonun 13'u -1, `empties` bos, ve
    // `count(*)` iddiasi SIFIR tablo uzerinde kosuyordu. Vacuity'yi durdurmak
    // icin yazilmis muhafiz vacuity ile geciyordu.
    //
    // Cozum tahmini tamamen atmak: her tablo dogrudan SAYILIR. On uc tablo
    // icin maliyet onemsiz, ve sayilan tablo sayisi da iddia edilir ki sorgu
    // bir gun bos donerse bu testin kendisi kirilsin.
    const { rows: allTables } = await pool.query<{ rel: string }>(`
      SELECT c.relname AS rel FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r' ORDER BY 1`)
    // SAYI DEGIL KUME. `toHaveLength(14)` bir tabloyu silip baskasini eklemeye
    // GORUNMEZDI -- `EXPECTED_INVENTORY`nin her yerde yerine gectigi sekil.
    expect(allTables.map((t) => t.rel)).toEqual(ALL_TABLES)
    const rowCounts: { rel: string; n: number }[] = []
    for (const { rel } of allTables) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM "${rel}"`)
      rowCounts.push({ rel, n: rows[0]?.n ?? 0 })
    }
    expect(rowCounts.map((t) => t.rel)).toEqual(ALL_TABLES)
    expect(rowCounts.filter((t) => t.n === 0)).toEqual([])

    const kinds = await Promise.all(
      candidates.map(async ({ rel, col }) => {
        const { rows } = await pool.query<{ kind: string }>(
          `SELECT CASE
             WHEN EXISTS (SELECT 1 FROM pg_constraint k
                          WHERE k.conrelid = $1::regclass AND k.contype = 'c'
                            AND (SELECT attnum FROM pg_attribute
                                 WHERE attrelid = $1::regclass AND attname = $2) = ANY(k.conkey)
                            AND pg_get_constraintdef(k.oid) LIKE '%[0-9a-f]{40}%')
               THEN 'pattern'
             WHEN EXISTS (SELECT 1 FROM pg_constraint k
                          WHERE k.conrelid = $1::regclass AND k.contype = 'f'
                            AND (SELECT attnum FROM pg_attribute
                                 WHERE attrelid = $1::regclass AND attname = $2) = ANY(k.conkey))
               THEN 'fkey'
             ELSE 'UNGUARDED' END AS kind`,
          [rel, col],
        )
        return { name: `${rel}.${col}`, kind: rows[0]?.kind ?? 'UNGUARDED' }
      }),
    )

    // Aday kumesinin kendisi de sabitlenir: sessizce KUCULMESI, "hepsi
    // korunuyor" ifadesini bosaltmanin en kolay yolu olurdu.
    expect(kinds.map((k) => k.name)).toEqual([
      'chat_messages.author_addr',
      'chat_messages.token',
      'creator_history.creator',
      'creator_history.token',
      'curve_state.curve',
      'curve_state.token',
      'deployment.escrow',
      'deployment.factory',
      'deployment.protocol_treasury',
      'fee_balances.recipient',
      'fee_events.from_addr',
      'fee_events.recipient',
      'holders.holder',
      'holders.token',
      'launches.curve',
      'launches.launch_creator',
      'launches.token',
      'limit_orders.owner_addr',
      'limit_orders.token',
      'rejected_launches.curve',
      'rejected_launches.expected',
      'rejected_launches.raw_addr',
      'rejected_launches.token',
      'token_stats.token',
      'token_transfers.from_addr',
      'token_transfers.to_addr',
      'token_transfers.token',
      'trades.curve',
      'trades.token',
      'trades.trader',
    ])

    // `rejected_launches.{token,curve}` TEK ISTISNADIR ve bilerek oyle:
    // reddedilmis bir launch'un adresleri tanim geregi guvenilmezdir; onlara
    // `launches`'in desenini dayatmak kaydin var olma amacini -- elle inceleme
    // -- yok ederdi. Istisna BURADA, ISMIYLE duruyor; sessiz olsaydi bir
    // sonraki korumasiz sutun de fark edilmezdi.
    expect(kinds.filter((k) => k.kind === 'UNGUARDED').map((k) => k.name)).toEqual([
      'rejected_launches.curve',
      'rejected_launches.token',
    ])
  })

  it('I-5 DISLERI: bir tablo BOS olsaydi bosluk muhafizi patlardi', async () => {
    // Muhafizin kendisi eskiden vacuity ile geciyordu (`reltuples = 0` ama
    // PostgreSQL >= 14 hic ANALYZE edilmemis iliskiler icin -1 tutar, yani
    // taze bir veritabaninda ADAY LISTESI BOSTU ve `count(*)` iddiasi SIFIR
    // tablo uzerinde kosuyordu). Tahmin atildi ve her tablo dogrudan
    // sayiliyor; burada o sayimin GERCEKTEN patladigi gosteriliyor.
    const client: PoolClient = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM creator_history')
      const { rows: allTables } = await client.query<{ rel: string }>(`
        SELECT c.relname AS rel FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r' ORDER BY 1`)
      expect(allTables.map((t) => t.rel)).toEqual(ALL_TABLES)
      // SIRAYLA, `Promise.all` DEGIL. Tek bir `PoolClient` uzerinde on dort
      // `client.query()` ayni anda baslatiliyordu; `pg` bunu her kosuda
      // `DeprecationWarning: Calling client.query() when the client is already
      // executing a query` diye basiyor ve `pg@9`da HATA olacak.
      const counts: { rel: string; n: number }[] = []
      for (const { rel } of allTables) {
        const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int n FROM "${rel}"`)
        counts.push({ rel, n: rows[0]?.n ?? 0 })
      }
      // Bos tablo GORULUYOR -- eski muhafiz burada bos liste dondururdu.
      expect(counts.filter((t) => t.n === 0).map((t) => t.rel)).toEqual(['creator_history'])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  // ---------------------------------------------------------------
  // SISTEM ADRESI BIR LAUNCH KIMLIGI OLAMAZ
  // ---------------------------------------------------------------
  it('native USDC adresi `launches`e GIREMEZ (EIP-7708 duvarini KOSULSUZ yapan sey)', async () => {
    // Gozden gecirme bunu calistirarak gosterdi: desen kontrolu 0x3600...0000'i
    // kabul ediyordu ve satir temiz giriyordu. O halde duvarin gucu tamamen
    // Task 6'nin -- HENUZ YAZILMAMIS -- provenance dogrulamasina baglıydi.
    for (const bad of [
      '0x3600000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
    ]) {
      const e = await failure(() =>
        pool.query(
          `INSERT INTO launches
             (token, curve, launch_creator, name, symbol, uri,
              name_hex, symbol_hex, uri_hex, salt, created_seq, created_at, tx_hash)
           VALUES ($1, $2, $2, 'x', 'X', '', '0x78', '0x58', '0x', $3, 99, now(), $4)`,
          [bad, addr(0xdd), hash32(0x1), hash32(0x2)],
        ),
      )
      expect(e.code, bad).toBe('23514')
      expect(e.constraint, bad).toBe('launches_token_is_not_a_system_address')
    }
  })

  it('sistem adresi bir CURVE de olamaz', async () => {
    const e = await failure(() =>
      pool.query(
        `INSERT INTO launches
           (token, curve, launch_creator, name, symbol, uri,
            name_hex, symbol_hex, uri_hex, salt, created_seq, created_at, tx_hash)
         VALUES ($1, $2, $1, 'x', 'X', '', '0x78', '0x58', '0x', $3, 98, now(), $4)`,
        [addr(0xdd), '0x3600000000000000000000000000000000000000', hash32(0x1), hash32(0x2)],
      ),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('launches_curve_is_not_a_system_address')
  })

  it('curve_state.curve `launches(curve)`e baglidir (sahte curve turetilemez)', async () => {
    // Onceden yalnizca desen kontrolu vardi, yani `launches`'takinden BASKA bir
    // curve adresi tasiyan bir curve_state satiri mesruydu ve `trades.curve`
    // ondan tureyerek butun islem gecmisini sahte bir curve'e baglayabilirdi.
    //
    // TOKEN'in ZATEN bir curve_state satiri var ve `token` UNIQUE, yani onu
    // kullanmak 23505 verirdi ve test YANLIS SEBEPTEN gecerdi (ilk kosuda tam
    // olarak bu oldu). Bu yuzden curve_state'i OLMAYAN taze bir launch
    // uretiliyor: patlayan tek sey yabanci anahtar olabilsin.
    await pool.query(
      `INSERT INTO launches
         (token, curve, launch_creator, name, symbol, uri,
          name_hex, symbol_hex, uri_hex, salt, created_seq, created_at, tx_hash)
       VALUES ($1, $2, $2, 'orphan', 'ORP', '', '0x6f', '0x4f', '0x', $3, 12345, now(), $4)`,
      [addr(0x7f01), addr(0xcf01), hash32(0x5f01), hash32(0x6f01)],
    )

    const e = await failure(() =>
      pool.query(
        `INSERT INTO curve_state
           (curve, token, virtual_token_reserves_tok, virtual_quote_reserves_wei,
            real_token_reserves_tok, real_quote_reserves_wei, last_seq)
         VALUES ($1, $2, 1, 1, 1, 1, 1)`,
        [addr(0xfeed), addr(0x7f01)],
      ),
    )
    expect(e.code).toBe('23503')
    expect(e.constraint).toBe('curve_state_curve_fkey')

    // POZITIF KONTROL: ayni satir DOGRU curve ile gecer, yani reddin sebebi
    // gercekten yabanci anahtardi.
    await pool.query(
      `INSERT INTO curve_state
         (curve, token, virtual_token_reserves_tok, virtual_quote_reserves_wei,
          real_token_reserves_tok, real_quote_reserves_wei, last_seq)
       VALUES ($1, $2, 1, 1, 1, 1, 1)`,
      [addr(0xcf01), addr(0x7f01)],
    )
  })

  it('ham log sutunlari metin TASIYAMAZ (U+0000 kamasi yapisal olarak kapali)', async () => {
    // `raw` eskiden `jsonb` idi ve `launches`'ta kapatilan kamayi bir tablo
    // oteye tasiyordu. Simdi tabloda cozulmus metnin konabilecegi bir yer yok:
    // uc sutun da onaltilik desenle kisitli.
    for (const [col, value] of [
      ['raw_addr', 'not-an-address'],
      ['raw_topics_hex', '0xzz'],
      ['raw_data_hex', 'plain text'],
    ] as const) {
      const e = await failure(() =>
        pool.query(
          `INSERT INTO rejected_launches
             (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
           VALUES (77, $1, $1, 'r', $1, $2, $3, $4)`,
          [
            addr(0x1),
            col === 'raw_addr' ? value : addr(0x2),
            col === 'raw_topics_hex' ? value : '',
            col === 'raw_data_hex' ? value : '0x',
          ],
        ),
      )
      expect(e.code, col).toBe('23514')
      expect(e.constraint, col).toBe(`rejected_launches_${col}_check`)
    }
  })

  // I-4, CALISTIRILARAK. Gozden geciren bunu KAYNAKTAN okuyarak kapatmisti.
  it('`reason` U+0000 tasiyamaz (kama bir sutun oteye kaymadi)', async () => {
    // Kisitsiz `text` olsaydi bu sunucu tarafinda 22021 verir, islemi geri
    // alir ve indexer'i o blokta kilitlerdi -- `raw jsonb`de kapatilan kamanin
    // aynisi. Simdi desen onu ONCE reddediyor.
    const e = await failure(() =>
      pool.query(
        `INSERT INTO rejected_launches
           (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
         VALUES (61, $1, $1, $2, $1, $1, '', '0x')`,
        [addr(0x1), 'bad\u0000name'],
      ),
    )
    // Surucu/sunucu NUL'u reddeder (22021) ya da desen reddeder (23514);
    // hangisi once davranirsa davransin, SESSIZ gecmez.
    expect(['22021', '23514']).toContain(e.code)
  })

  it('`reason` a cozulmus bir isim ENTERPOLE EDILEMEZ', async () => {
    // Bir Task 6 yazarinin yazacagi en dogal satir. Desen bosluklari, buyuk
    // harfleri ve iki nokta ustustesini reddediyor, yani bu satir DERLENIR ama
    // CALISMAZ -- ve arizayi ilk reddedilen launch'ta degil ilk TESTTE gorur.
    for (const reason of ['name mismatch: Arc Pad Test', 'NotCanonical', 'x'.repeat(65), '']) {
      const e = await failure(() =>
        pool.query(
          `INSERT INTO rejected_launches
             (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
           VALUES (62, $1, $1, $2, $1, $1, '', '0x')`,
          [addr(0x1), reason],
        ),
      )
      expect(e.code, reason).toBe('23514')
      expect(e.constraint, reason).toBe('rejected_launches_reason_check')
    }
  })

  it('`reason` MESRU bir etiketi kabul eder (desen fazla siki degil)', async () => {
    await pool.query(
      `INSERT INTO rejected_launches
         (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
       VALUES (63, $1, $1, 'not_canonical', $1, $1, '', '0x')`,
      [addr(0x1)],
    )
  })

  it('bes topic li bir log reddedilir (EVM tavani dort)', async () => {
    const five = Array.from({ length: 5 }, (_, i) => hash32(i)).join(',')
    const e = await failure(() =>
      pool.query(
        `INSERT INTO rejected_launches
           (created_seq, token, curve, reason, expected, raw_addr, raw_topics_hex, raw_data_hex)
         VALUES (76, $1, $1, 'r', $1, $1, $2, '0x')`,
        [addr(0x1), five],
      ),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('rejected_launches_raw_topics_hex_check')
  })

  // ---------------------------------------------------------------
  // EIP-7708 CIFT SAYIM
  // ---------------------------------------------------------------
  it('native USDC Transfer logu `token_transfers`e GIREMEZ (EIP-7708)', async () => {
    // Arc, bir sistem adresinden yapilan HER native hareket icin bir
    // `Transfer` logu yayar. Bunlarin yayincisi 6 decimal native-USDC
    // ERC-20'sidir. `token` sutunu `launches(token)`a yabanci anahtar oldugu
    // icin boyle bir log SESSIZCE bakiyelere karisamaz: 23503 ile patlar.
    const USDC = '0x3600000000000000000000000000000000000000'
    const e = await failure(() =>
      pool.query(
        `INSERT INTO token_transfers
           (event_seq, block_number, log_index, tx_hash, block_time, token, from_addr, to_addr, amount_tok)
         VALUES ($1, 54325470, 9, $2, now(), $3, $4, $5, 1000000)`,
        [toSeq(54_325_470n, 9).toString(), hash32(0xfeed), USDC, addr(0x1), ALICE],
      ),
    )
    expect(e.code).toBe('23503')
    expect(e.constraint).toBe('token_transfers_token_fkey')

    // Ve `holders` da ayni kapidan gecer -- iki tabloda AYRI AYRI gosteriliyor,
    // cunku birinde kapali olmasi digerinde kapali oldugunu gostermez.
    const h = await failure(() =>
      pool.query(
        'INSERT INTO holders (token, holder, balance_tok, last_seq) VALUES ($1, $2, 1, 1)',
        [USDC, ALICE],
      ),
    )
    expect(h.code).toBe('23503')
    expect(h.constraint).toBe('holders_token_fkey')
  })

  // ---------------------------------------------------------------
  // "SESSIZ VERI KAYBINI GURULTULU HATAYA CEVIREN" KISITLAR
  // ---------------------------------------------------------------
  it('eksik bir Transfer bakiyeyi negatife dusurunce GURULTULU patlar', async () => {
    // ALICE'in bakiyesi var ama sahip oldugundan fazlasini gonderen bir
    // transfer (yani ondan onceki bir alim logu DUSMUS) `balance_tok >= 0`
    // ile geri alinir. Sessiz kayip yok.
    const { rows } = await pool.query<{ balance_tok: string }>(
      'SELECT balance_tok FROM holders WHERE token = $1 AND holder = $2',
      [TOKEN, ALICE],
    )
    const balance = BigInt(rows[0]?.balance_tok ?? '0')
    expect(balance).toBeGreaterThan(0n)

    const e = await failure(() =>
      pool.query(
        `UPDATE holders SET balance_tok = balance_tok - $3
         WHERE token = $1 AND holder = $2`,
        [TOKEN, ALICE, (balance + 1n).toString()],
      ),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('holders_balance_tok_check')
  })

  it('escrow defter esitligi kirilirsa GURULTULU patlar', async () => {
    const e = await failure(() =>
      pool.query('UPDATE fee_balances SET claimable_wei = claimable_wei + 1'),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('claimable_is_the_difference')
  })

  it('tamamlanmis bir curve bos olmak ZORUNDA', async () => {
    const e = await failure(() =>
      pool.query('UPDATE curve_state SET real_token_reserves_tok = 1 WHERE curve = $1', [CURVE]),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('complete_means_empty')
  })

  it('`complete` ile `completed_seq` birlikte hareket eder', async () => {
    const e = await failure(() =>
      pool.query('UPDATE curve_state SET completed_seq = NULL WHERE curve = $1', [CURVE]),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('completed_iff_seq')
  })

  it('`deposit` her zaman bir `from` tasir, `claim` hicbir zaman tasimaz', async () => {
    const missing = await failure(() =>
      pool.query("UPDATE fee_events SET from_addr = NULL WHERE kind = 'deposit'"),
    )
    expect(missing.code).toBe('23514')
    expect(missing.constraint).toBe('deposit_has_from')

    const extra = await failure(() =>
      pool.query("UPDATE fee_events SET from_addr = $1 WHERE kind = 'claim'", [CURVE]),
    )
    expect(extra.code).toBe('23514')
    expect(extra.constraint).toBe('deposit_has_from')
  })

  it('ikinci bir `deployment` satiri imkansizdir', async () => {
    const e = await failure(() =>
      pool.query(
        `INSERT INTO deployment (id, chain_id, factory, escrow, protocol_treasury,
           virtual_token_reserves_tok, virtual_quote_reserves_wei, sale_supply_tok,
           total_supply_tok, start_block)
         VALUES (2, 1, $1, $1, $1, 2, 1, 1, 1, 1)`,
        [addr(0x1)],
      ),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('deployment_id_check')
  })

  it('sale supply sanal token rezervinin ustune cikamaz', async () => {
    const e = await failure(() =>
      pool.query('UPDATE deployment SET sale_supply_tok = virtual_token_reserves_tok'),
    )
    expect(e.code).toBe('23514')
    expect(e.constraint).toBe('sale_supply_below_token_reserves')
  })

  it('log_index semada da 2^20-1 ile sinirlidir (seq kodlamasiyla ayni tavan)', async () => {
    // `toSeq`in TypeScript kontrolu ile semanin CHECK'i AYNI tavani soylemek
    // zorunda; ayrilirlarsa biri digerinin yakaladigini kacirir.
    for (const table of ['trades', 'token_transfers', 'fee_events']) {
      const { rows } = await pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = $1::regclass AND conname = $2`,
        [table, `${table}_log_index_check`],
      )
      expect(rows[0]?.def, table).toContain('1048575')
    }
  })
})
