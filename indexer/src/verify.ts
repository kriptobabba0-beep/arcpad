import type { Queryable } from '@arcpad/db'
import type { DecodedEvent } from './logs'

/**
 * DEFTER KAPSAMI -- `SUM(holders.balance_tok) = 1e27`'IN YERINI ALAN KONTROL.
 *
 * ================================================================
 * NICIN TOPLAM YETMEZ (olculdu, iddia edilmedi)
 * ================================================================
 *
 * Planin Global Kisitlar bolumu (EIP-7708, madde 3) sunu soyluyordu: "Butun
 * `Transfer`'larin yakalandigini kanitlayan TEK kontrol
 * `SUM(holders.balance_tok) = 1e27`'dir. Bir `Transfer` dusurulurse bu esitlik
 * kirilir." Iki yari da olculdu ve IKISI DE YANLIS:
 *
 *   - Mint DISINDAKI her `Transfer` bir bakiyeyi azaltip digerini AYNI KADAR
 *     artirir. Dusurulmesi toplami DEGISTIRMEZ.
 *     (`apply-transfer.test.ts`, "mint DISINDAKI bir Transfer atlandiginda
 *     toplam KORUNUR")
 *   - Bir deltanin IKI KEZ uygulanmasi da toplami degistirmez -- gozden
 *     gecirme bunu ayrica olctu: kasitli bir cift uygulamadan sonra toplam
 *     hala tam olarak 1e27'ydi.
 *
 * Yani toplam ne DUSMEYI ne de CIFT SAYIMI gorur. Gorebildigi tek sey mint'in
 * kendisinin kaybolmasi ve bakiyelerin uydurulmasidir; o kadar. Toplam
 * iddiasi testte KALDI ama adi ve yorumu bunu soyluyor -- kimse onu bir kapi
 * sanip geri getirmesin diye.
 *
 * ================================================================
 * YERINE NE GECTI
 * ================================================================
 *
 * DEFTERIN KENDISI, ve onu ZINCIRE karsi tutan bu fonksiyon.
 *
 * Bir aralik islendikten sonra, o aralikta COZULMUS her olayin kendi defter
 * tablosunda bir satiri OLMAK ZORUNDADIR. Kayip bir `Transfer` -- bir
 * holder'in SON transferi olsa, yani hicbir bakiyeyi negatife dusurmese
 * bile -- burada gorunur, cunku kontrol bakiyelere degil OLAY KIMLIKLERINE
 * bakar.
 *
 * Maliyeti aralik basina UC sorgudur (`= ANY($1)`), ve dogru yeri ingest
 * dongusunun kendisidir: `run.ts` her araligin sonunda cagirir, yani kontrol
 * bir testin degil URETIM YOLUNUN uzerindedir.
 *
 * KAPSAMADIGI SEY, acikca: zincirin verdigi log kumesinin kendisi eksikse bu
 * fonksiyon bunu goremez -- cozulmus olaylarla defteri karsilastirir, zinciri
 * yeniden sorgulamaz. O bosluk `eth_getLogs`in dogru cevap verdigi
 * varsayimidir ve onu kapatan sey Task 12'nin canli testidir (ayni araligi
 * gercek RPC'den ikinci kez cekip karsilastirir).
 */
export class LedgerGap extends Error {
  constructor(
    readonly table: string,
    readonly missing: readonly bigint[],
  ) {
    super(
      `LedgerGap: ${table} tablosunda ${missing.length} olay eksik ` +
        `(ilk: ${missing[0]?.toString() ?? '-'}). Bir aralik uygulandi ama ` +
        `cozulmus olaylarin hepsi deftere girmedi.`,
    )
    this.name = 'LedgerGap'
  }
}

/*
 * BUYBACK OLAYLARI COZULUR AMA HENUZ DEFTERE YAZILMAZ -- VE BU BILINCLI BIR
 * ARA DURUMDUR, BIR UNUTMA DEGIL.
 *
 * Cozme katmani (imzalar, tipler, `DECODERS`) tamamlandi ve ABI'ye karsi
 * dogrulaniyor; KALICILIK katmani (migration + `apply/buyback.ts`) ayri bir
 * adimdir ve GERCEK bir Postgres olmadan dogrulanamaz -- bu depoda veritabani
 * testleri bilerek ATLANMAZ, kosulamiyorsa kirmizi olur.
 *
 * `null` YAZMANIN ANLAMI BURADA "defteri yok" DEGIL, "defteri HENUZ yok"dur.
 * Ikisi ayni satirla ifade edildigi icin asagidaki not zorunludur: bir sonraki
 * oturum `buyback_events` tablosunu ekledigi anda bu bes satir tablo adiyla
 * degismelidir, yoksa kapsam kontrolu buyback satirlarini SESSIZCE aramaz.
 */
const LEDGER_OF: Record<DecodedEvent['kind'], string | null> = {
  launched: 'launches',
  trade: 'trades',
  transfer: 'token_transfers',
  deposited: 'fee_events',
  claimed: 'fee_events',
  // `Completed` bir DURUM GECISIDIR, defter satiri yoktur: `curve_state`
  // uzerinde `WHERE NOT complete` ile idempotenttir. Kapsam kontrolu onu
  // ATLAR ve bu bir bosluk degil, olayin dogasidir.
  completed: null,
  // `Graduated` de oyle: `WHERE NOT graduated`. Bir DELTA tasimaz -- mezuniyet
  // odemesinin holder muhasebesi, zincirin gercekten yaydigi `Transfer`
  // logundan gelir ve ONUN defteri `token_transfers`tir. Buraya bir defter
  // adi yazmak, ayni hareketi iki tabloda aramak olurdu.
  graduated: null,
  // HAVUZ ISLEMI `trades`E GIRER -- `source = 'pool'` ile, AMA AYNI DEFTERE.
  // Kapsam kontrolu bu yuzden onu da kapsar ve KAPSAMASI SART: mezuniyetten
  // sonraki bir islemin sessizce dusmesi, tam olarak bu ingest yolunun var
  // olma sebebini ortadan kaldirirdi.
  poolSwap: 'trades',
  // Ikisi de defter tasimaz; gerekce `apply/pool.ts`,
  // `POOL_EVENTS_WITHOUT_LEDGER`. `poolFee`nin defteri `fee_events`tir ama
  // ORAYA `Deposited` uzerinden girer, bu olay uzerinden DEGIL -- buraya
  // `fee_events` yazmak, ayni parayi iki kaynaktan aramak olurdu ve
  // `event_seq`leri de tutmazdi.
  poolInitialize: null,
  poolFee: null,
  // TODO(buyback-persistence): `buyback_events` tablosu eklenince bes satir da
  // o tablo adini tasimali. Bkz. ustteki not.
  buybackAccrued: null,
  buybackExecuted: null,
  buybackSkipped: null,
  buybackLocked: null,
  vestingReleased: null,
}

/**
 * `launches` `event_seq` yerine `created_seq` tasir; digerleri `event_seq`.
 * Kolon adi tabloya gore secilir, sorgu metnine gomulmez.
 */
const SEQ_COLUMN: Record<string, string> = {
  launches: 'created_seq',
  trades: 'event_seq',
  token_transfers: 'event_seq',
  fee_events: 'event_seq',
}

/**
 * Bir araligin butun olaylarinin GERCEKTEN yazildigini dogrular.
 *
 * Ayni islemin ICINDE cagrilmali: aksi halde "yazildi" cevabi baska bir
 * yazicinin gorunurlugune baglanir.
 */
export async function assertRangeApplied(
  db: Queryable,
  events: readonly DecodedEvent[],
): Promise<void> {
  const wanted = new Map<string, bigint[]>()
  for (const event of events) {
    const table = LEDGER_OF[event.kind]
    if (table === null) continue
    const list = wanted.get(table)
    if (list === undefined) wanted.set(table, [event.seq])
    else list.push(event.seq)
  }

  for (const [table, seqs] of wanted) {
    const column = SEQ_COLUMN[table]
    if (column === undefined) throw new Error(`assertRangeApplied: ${table} icin seq kolonu yok`)
    const { rows } = await db.query<{ seq: string }>(
      `SELECT ${column}::text AS seq FROM ${table} WHERE ${column} = ANY($1::bigint[])`,
      [seqs.map((s) => s.toString())],
    )
    const present = new Set(rows.map((r) => BigInt(r.seq)))
    const missing = seqs.filter((s) => !present.has(s))
    if (missing.length > 0) throw new LedgerGap(table, missing)
  }
}
