import { beforeEach, describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { getTokenBuyback, getTokenOverview, snapshot, toSeq } from '@arcpad/db'
import { applyEvents, UnknownBuybackToken } from '../src/apply'
import type { DecodedEvent } from '../src/logs'
import { assertRangeApplied, LedgerGap } from '../src/verify'
import { fixtureEvents } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/**
 * BUYBACK DEFTERI -- `buyback_events` ve `buyback_state`.
 *
 * ================================================================
 * FIXTURE BIR ISLEM DILIMIDIR, BIR GECMIS DEGIL -- VE BU OLCULDU
 * ================================================================
 *
 * `FixtureGen.t.sol` `buyback` senaryosunu TEK BIR islemin loglarindan uretir:
 * tahakkuk -> supurme -> kilit -> dagitim. O islemdeki tahakkuk 94.672.977.389.008
 * wei'dir, ama supurmenin harcadigi 63.904.259.737.580.596 wei -- yani butcenin
 * neredeyse tamami DAHA ONCEKI islemlerde birikmistir ve o loglar dosyada YOKTUR.
 *
 * Bunun iki sonucu var ve ikisi de bu dosyanin sekline dogrudan yansiyor:
 *
 *   1. Dosyada `Launched` LOGU YOKTUR. `buyback_events.token` `launches(token)`a
 *      yabanci anahtardir (semanin butun token sutunlari gibi), yani testin
 *      launch satirini KENDISI tohumlamasi gerekir. Uydurulan tek sey budur;
 *      buyback olaylarinin kendisi FixtureGen'in urettigi gercek loglardir.
 *
 *   2. `pending_quote_wei` BU DILIMDE NEGATIFE GIDERDI. Yazici bu yuzden
 *      `GREATEST(0, ...)` ile kirpar -- ve kirpmanin BAGLADIGI, asagida ayri bir
 *      testle OLCULUR. Uretimde baglamaz: `deployment.start_block` fabrikanin
 *      dagitim blogudur, yani hazine hic var olmadan once baslar ve hicbir
 *      tahakkuk goruntunun disinda kalamaz.
 */

/** `buyback` fixture'inin tokeni ve egrisi (dosyadan OKUNDU, uydurulmadi). */
const TOKEN = '0x13b7a4d11755b001ff004bc520a7f4947cc7dbfd' as Address
const CURVE = '0x8ffbcb695748cb1a1f4fc18f07634a9c1e27d562' as Address

const BLOCK = 54_661_500n

/** `buyback-skipped` AYRI bir tokendir: tek islemde harcama ve geri katlama
 *  BIRLIKTE olusamaz, yani iki senaryo iki dosyadir. */
const SKIPPED_TOKEN = '0x912d678c62a174745dd0638e69d88e9b399e02f1' as Address
const SKIPPED_BLOCK = 54_661_600n

/** `buyback-policy` fixture'inin tokeni -- kendi launch'iyla birlikte gelir. */
const POLICY_TOKEN = '0x82203e5b78acd0b74c6e8ae6a1c0cc30241101c0' as Address
const POLICY_FACTORY = '0xf62849f9a0b5bf2913b396098f7c7019b51a820a' as Address
const POLICY_BLOCK = 54_661_700n

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`

interface StateRow {
  enabled: boolean
  enabled_by_addr: string | null
  pending_quote_wei: string
  accrued_total_wei: string
  spent_total_wei: string
  returned_total_wei: string
  bought_total_tok: string
  locked_total_tok: string
  released_creator_tok: string
  released_protocol_tok: string
  vesting_start_at: string | null
  vesting_end_at: string | null
}

async function state(token: Address): Promise<StateRow> {
  const { rows } = await pool.query<StateRow>(
    `SELECT enabled, enabled_by_addr,
            pending_quote_wei::text, accrued_total_wei::text, spent_total_wei::text,
            returned_total_wei::text, bought_total_tok::text, locked_total_tok::text,
            released_creator_tok::text, released_protocol_tok::text,
            vesting_start_at, vesting_end_at
       FROM buyback_state WHERE token = $1`,
    [token],
  )
  const row = rows[0]
  if (!row) throw new Error(`buyback_state satiri yok: ${token}`)
  return row
}

/**
 * FK duvarini asmak icin ASGARI launch satiri.
 *
 * `admit()` KULLANILAMAZ: provenance dogrulamasi tokeni CREATE2 ile yeniden
 * turetir ve fixture'in tokeni bu testin uydurdugu bir tuzdan turemez. Satiri
 * dogrudan yazmak, `constraints.test.ts`in `rejected_launches` ve
 * `chat_messages` icin yaptigi seyin aynisidir.
 */
async function seedLaunch(token: Address, curve: Address, block: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO launches
       (token, curve, launch_creator, name, symbol, uri,
        name_hex, symbol_hex, uri_hex, salt, created_seq, created_at, tx_hash)
     VALUES ($1,$2,$3,'Buyback Fixture','BBF','',
             '0x4275796261636b20466978747572', '0x424246', '0x',
             $4, $5, to_timestamp(1), $6)`,
    [
      token,
      curve,
      '0x000000000000000000000000000000000000c7ea',
      `0x${'11'.repeat(32)}`,
      toSeq(block - 1n, 0).toString(),
      `0x${'22'.repeat(32)}`,
    ],
  )
}

const isBuyback = (e: DecodedEvent): boolean =>
  e.kind.startsWith('buyback') || e.kind === 'vestingReleased'

/**
 * Fixture'in YALNIZCA buyback olaylari.
 *
 * Ticaret ve transfer olaylari DISARIDA birakilir cunku onlarin kendi on
 * kosullari var (`curve_state`, `holders`) ve bu dosyanin olctugu sey onlar
 * degil. `applyEvents`in tuketici `switch`i sayesinde bu bir kapsam kaybi
 * degildir: buyback dali baska hicbir olaya bagli degildir.
 */
async function buybackEvents(name = 'buyback', block = BLOCK): Promise<DecodedEvent[]> {
  return (await fixtureEvents(name, { block })).filter(isBuyback)
}

describe('apply/buyback', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
    await seedLaunch(TOKEN, CURVE, BLOCK)
  })

  it('fixture in DORT buyback olayi da deftere girer', async () => {
    const counts = await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    expect(counts.buyback).toBe(4)

    const { rows } = await pool.query<{ kind: string }>(
      'SELECT kind FROM buyback_events ORDER BY event_seq',
    )
    expect(rows.map((r) => r.kind)).toEqual(['accrued', 'executed', 'locked', 'released'])
  })

  /**
   * `counts.buyback` `fees`E KARISMAZ.
   *
   * Ayri sayilmasinin gerekcesi `poolSwaps`inkiyle ayni ve testi de oyle
   * olmali: birlestirilmis bir sayac, buyback'in HIC gelmedigi hali onun
   * geldigi ama sayilmadigi halinden ayirt edemezdi.
   */
  it('buyback sayaci ucret sayacina KARISMAZ', async () => {
    const counts = await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    expect(counts.fees).toBe(0)
    expect(counts.total).toBe(4)
  })

  // ---------------------------------------------------------------
  // TOPLAM TABLOSU -- degerler FIXTURE'DAN OKUNDU, hesaplanmadi
  // ---------------------------------------------------------------

  it('toplam tablosu fixture in olculmus rakamlarini tasir', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    const s = await state(TOKEN)

    expect(BigInt(s.accrued_total_wei)).toBe(94_672_977_389_008n)
    expect(BigInt(s.spent_total_wei)).toBe(63_904_259_737_580_596n)
    expect(BigInt(s.returned_total_wei)).toBe(0n)
    expect(BigInt(s.bought_total_tok)).toBe(15_550_159_190_581_009_077_265_247n)
    // ALINAN ile KILITLENEN bu fixture'da BIREBIR esit -- canli zincirde de
    // oyleydi (14.435.072,652524 BBP). Esitlik bir KISIT DEGILDIR (kasa birden
    // fazla supurmenin tokenini biriktirebilir), ama burada bir OLGUDUR.
    expect(BigInt(s.locked_total_tok)).toBe(BigInt(s.bought_total_tok))
  })

  /**
   * DAGITIM %30 PROTOKOL / %70 CREATOR -- ve bolme YONU de olculur.
   *
   * Kontrat protokol payini `amount * 3000 / 10000` ile ASAGI yuvarlar, creator
   * payini FARKTAN alir. Iki tutari `creator * 3 == protocol * 7` ile
   * karsilastiran bir test bu fixture'da YEDI wei farkla duserdi -- yani
   * yuvarlamayi test etmeyen bir test, yuvarlamayi yanlis yapan bir kontrati da
   * gecirirdi.
   */
  it('dagitim %30 / %70 -- yuvarlama YONUYLE birlikte', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    const s = await state(TOKEN)
    const creator = BigInt(s.released_creator_tok)
    const protocol = BigInt(s.released_protocol_tok)
    const total = creator + protocol

    expect(protocol).toBe((total * 3000n) / 10_000n)
    expect(creator).toBe(total - protocol)
  })

  it('vesting penceresi tam 5 yil (157.680.000 saniye)', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    const s = await state(TOKEN)
    const start = new Date(s.vesting_start_at!).getTime()
    const end = new Date(s.vesting_end_at!).getTime()
    expect((end - start) / 1000).toBe(157_680_000)
  })

  /**
   * KIRPMA BU DILIMDE BAGLAR -- VE BU GIZLENMIYOR.
   *
   * Fixture tek bir islemin loglaridir: tahakkuk 94.672.977.389.008 wei,
   * harcama 63.904.259.737.580.596 wei. Fark NEGATIFTIR ve bir buyback
   * arizasi degil, dilimin kendisidir -- harcanan butce daha onceki
   * islemlerde birikti ve o loglar dosyada yok.
   *
   * Uretimde baglayamaz: `deployment.start_block` fabrikanin dagitim blogudur,
   * yani indexer hazine var olmadan once baslar.
   */
  it('DILIM uygulandiginda pending SIFIRA kirpilir, negatife DUSMEZ', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    const s = await state(TOKEN)

    // Kirpmanin GERCEKTEN bagladiginin kaniti: ham fark negatif.
    expect(BigInt(s.spent_total_wei)).toBeGreaterThan(BigInt(s.accrued_total_wei))
    expect(BigInt(s.pending_quote_wei)).toBe(0n)
  })

  /**
   * TAHAKKUK MUTLAK ATAR -- ve bu, kirpmanin kalici bir sapmaya donusmesini
   * engelleyen tek sey.
   *
   * Dilim yuzunden sifira kirpilmis bir butce, bir SONRAKI tahakkukta zincirin
   * kendi `pending` degerine geri doner. Toplayan bir yazici bunu yapamazdi:
   * kirpilan miktar sonsuza kadar eksik kalirdi.
   */
  it('sonraki tahakkuk butceyi zincirin MUTLAK degerine geri kurar', async () => {
    const first = await buybackEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, first)
    expect(BigInt((await state(TOKEN)).pending_quote_wei)).toBe(0n)

    // AYNI fixture, BIR SONRAKI bloga temellendirilmis: ayni tahakkuk, yeni
    // `event_seq`. Zincirin yaydigi `pending` degismedigi icin butce tam olarak
    // o degere kurulmali.
    const again = (await buybackEvents('buyback', BLOCK + 1n)).filter(
      (e) => e.kind === 'buybackAccrued',
    )
    await applyEvents(pool, LIVE_DEPLOYMENT, again)
    expect(BigInt((await state(TOKEN)).pending_quote_wei)).toBe(94_672_977_389_008n)
  })

  // ---------------------------------------------------------------
  // GERI KATLAMA -- AYRI BIR SENARYO, AYRI BIR FIXTURE
  // ---------------------------------------------------------------

  /**
   * `BuybackSkipped` OLMADAN DEFTER KAPANMAZ: `accrued` ile `executed`
   * arasindaki farki aciklayan tek olay budur, ve o olmadan fark bir KAYIP
   * gibi okunur.
   */
  it('geri katlama returned_total_wei e yazilir ve sebebi AYNEN saklanir', async () => {
    await seedLaunch(SKIPPED_TOKEN, addr(0x5c00), SKIPPED_BLOCK)
    const events = await buybackEvents('buyback-skipped', SKIPPED_BLOCK)
    expect(await applyEvents(pool, LIVE_DEPLOYMENT, events)).toMatchObject({ buyback: 1 })

    const s = await state(SKIPPED_TOKEN)
    expect(BigInt(s.returned_total_wei)).toBe(18_242_150_053_590_568n)
    expect(BigInt(s.spent_total_wei)).toBe(0n)

    const { rows } = await pool.query<{ reason: string }>(
      "SELECT reason FROM buyback_events WHERE kind = 'skipped'",
    )
    // TIRE ICERIR. `rejected_launches.reason`in `^[a-z_]{1,64}$` desenini bu
    // kolona dayatmak, zincirin MESRU bir dizesini reddedip ingest'i o blokta
    // sonsuza kadar kilitlerdi.
    expect(rows[0]?.reason).toBe('below-threshold-or-unsafe')
  })

  // ---------------------------------------------------------------
  // EXACTLY-ONCE
  // ---------------------------------------------------------------

  it('ayni araligi iki kez uygulamak veritabanini AYNI birakir', async () => {
    const events = await buybackEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const before = await snapshot(pool)

    const second = await applyEvents(pool, LIVE_DEPLOYMENT, events)
    expect(second.total).toBe(0)
    expect(await snapshot(pool)).toEqual(before)
  })

  /**
   * NEGATIF KONTROL: artim defter satirina BAGLI.
   *
   * Defter satiri silinince ayni olay yeniden yazilir VE toplam bir kez daha
   * artar. Bu, `bought_total_tok`un bir DELTA oldugunu ve onu ikinci kez
   * uygulanmaktan koruyan tek seyin `ON CONFLICT DO NOTHING` oldugunu
   * gosterir -- birincil anahtarin "kendiliginden koruduguna" guvenmek bu
   * depoda daha once yanlis cikti.
   */
  it('defter satiri silinince ayni olay YENIDEN uygulanir (negatif kontrol)', async () => {
    const events = await buybackEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    const boughtOnce = BigInt((await state(TOKEN)).bought_total_tok)

    await pool.query("DELETE FROM buyback_events WHERE kind = 'executed'")
    const executed = events.find((e) => e.kind === 'buybackExecuted')!
    await applyEvents(pool, LIVE_DEPLOYMENT, [executed])

    expect(BigInt((await state(TOKEN)).bought_total_tok)).toBe(boughtOnce * 2n)
  })

  // ---------------------------------------------------------------
  // KAPSAM KONTROLU -- §9'un "ucu birlikte gitmezse sessiz kalir" satiri
  // ---------------------------------------------------------------

  /**
   * `LEDGER_OF`taki bes satirin DISLERI VAR MI.
   *
   * Migration, yazici ve `LEDGER_OF` ayni commit'te gitmek zorundaydi cunku
   * ucundan biri eksik oldugunda hicbir sey KIRMIZI olmuyor: tablo yoksa
   * yazici patlar (gurultulu), ama `LEDGER_OF` `null` kalirsa kapsam kontrolu
   * buyback satirlarini ARAMAZ ve dusen bir olay SESSIZ kalir.
   *
   * Bu test o sessizligi imkansiz kilar: bir olay bilerek uygulanmaz ve
   * kontrolun onu GORMESI beklenir.
   */
  it('uygulanmamis bir buyback olayi kapsam kontrolunde LedgerGap uretir', async () => {
    const events = await buybackEvents()
    const withoutLock = events.filter((e) => e.kind !== 'buybackLocked')
    await applyEvents(pool, LIVE_DEPLOYMENT, withoutLock)

    await expect(assertRangeApplied(pool, events)).rejects.toThrow(LedgerGap)
    // Ve eksigi TABLO ADIYLA soyler -- mesaj olmadan operator nereye bakacagini
    // bilemezdi.
    await expect(assertRangeApplied(pool, events)).rejects.toThrow(/buyback_events/)
  })

  it('hepsi uygulandiginda kapsam kontrolu SESSIZ gecer', async () => {
    const events = await buybackEvents()
    await applyEvents(pool, LIVE_DEPLOYMENT, events)
    await expect(assertRangeApplied(pool, events)).resolves.toBeUndefined()
  })

  // ---------------------------------------------------------------
  // SINIRLAR
  // ---------------------------------------------------------------

  it('launches ta olmayan bir token icin buyback olayi DURDURUR', async () => {
    await seedLaunch(SKIPPED_TOKEN, addr(0x5c00), SKIPPED_BLOCK)
    await pool.query('DELETE FROM buyback_state')
    await pool.query('DELETE FROM launches WHERE token = $1', [SKIPPED_TOKEN])

    const events = await buybackEvents('buyback-skipped', SKIPPED_BLOCK)
    await expect(applyEvents(pool, LIVE_DEPLOYMENT, events)).rejects.toThrow(UnknownBuybackToken)
  })

  // ---------------------------------------------------------------
  // POLITIKA -- PARA DEGIL KARAR
  // ---------------------------------------------------------------

  /**
   * ARAYUZUN ILK SORDUGU SEY, ILK TAHAKKUKTAN ONCE CEVAPLANABILIR OLMALI.
   *
   * `buyback-policy` fixture'i `launchWithBuyback`in ACMASINI ve
   * `setBuybackEnabled`in KAPATMASINI tasir. Ikisi de ayni tokene ait, yani
   * son durum KAPALI -- ve toplam tablosu bunu soylemeli.
   */
  it('politika olaylari deftere girer ve SON durum toplamda durur', async () => {
    await seedLaunch(POLICY_TOKEN, addr(0x9c00), POLICY_BLOCK)
    const events = await buybackEvents('buyback-policy', POLICY_BLOCK)
    expect(await applyEvents(pool, LIVE_DEPLOYMENT, events)).toMatchObject({ buyback: 2 })

    const { rows } = await pool.query<{ kind: string; enabled: boolean }>(
      'SELECT kind, enabled FROM buyback_events ORDER BY event_seq',
    )
    expect(rows).toEqual([
      { kind: 'policy', enabled: true },
      { kind: 'policy', enabled: false },
    ])

    const s = await state(POLICY_TOKEN)
    expect(s.enabled).toBe(false)
    // KIM YAPTI da saklanir: acan creator, kapatan da creator.
    expect(s.enabled_by_addr).toBe('0x000000000000000000000000000000000000c7ea')
  })

  /**
   * SIRA MUHAFIZI: GERIDEN GELEN BIR TOGGLE GUNCEL DURUMU EZMEZ.
   *
   * Uretimde ulasilamaz (imlec yalnizca ileri gider) ama yazicinin dogrulugu
   * cagiranin bir ozelligine BAGLI OLMAMALI. Burada kasitli olarak once YENI
   * olay, sonra ESKI olay uygulanir.
   */
  it('eski bir politika olayi YENI durumu ezmez', async () => {
    await seedLaunch(POLICY_TOKEN, addr(0x9c00), POLICY_BLOCK)
    const events = await buybackEvents('buyback-policy', POLICY_BLOCK)
    const [opened, closed] = [events[0]!, events[1]!]

    // Once KAPATMA (yeni), sonra ACMA (eski).
    await applyEvents(pool, LIVE_DEPLOYMENT, [closed])
    expect((await state(POLICY_TOKEN)).enabled).toBe(false)
    await applyEvents(pool, LIVE_DEPLOYMENT, [opened])
    expect((await state(POLICY_TOKEN)).enabled).toBe(false)
  })

  /**
   * POLITIKA `Launched` ILE AYNI ISLEMDE GELIR -- VE FK O YUZDEN TUTAR.
   *
   * Fixture'da politika logu `logIndex 1`, `Launched` ise `logIndex 3`: yani
   * KATI `event_seq` sirasiyla yazan bir dongu, `launches` satiri HENUZ YOKKEN
   * politika satirini yazmaya calisirdi. `applyEvents`in iki fazi bunu
   * onler, ve bu test o fazlari GERCEK bir log sirasiyla yurutur.
   */
  it('ayni islemdeki launch ve politika, iki fazli uygulamayla yazilir', async () => {
    const all = await fixtureEvents('buyback-policy', { block: POLICY_BLOCK })
    const launched = all.find((e) => e.kind === 'launched')
    expect(launched, 'fixture bir Launched tasimali').toBeDefined()
    expect(launched!.logIndex).toBeGreaterThan(
      all.find((e) => e.kind === 'buybackEnabledUpdated')!.logIndex,
    )

    /*
     * FABRIKA FIXTURE'INKI OLMALI -- VE BU BIR KOLAYLIK DEGIL, TESTIN
     * DEGERININ KENDISI.
     *
     * `admit` tokeni CREATE2 ile YENIDEN TURETIR ve `deployment.factory`ye
     * gore dogrular. Canli fabrikayla cagrilinca fixture'in launch'i
     * `NonCanonicalLaunch` ile REDDEDILDI (olculdu) -- yani provenance kapisi
     * calisiyor. Fabrikayi fixture'inkine cevirmek o kapiyi GEVSETMEZ:
     * turetme yine kosar ve fixture'in tokeni GERCEKTEN o fabrikadan
     * turedigi icin gecer. Boylece bu test, launch'i tohumlayarak degil
     * URETIM YOLUNDAN gecirerek kurar.
     */
    const deployment = { ...LIVE_DEPLOYMENT, factory: POLICY_FACTORY }

    // `transfer` DISARIDA: mint'in kendi on kosullari var ve bu testin olctugu
    // sey o degil. Launch + politika, tam olarak zincirdeki sirayla.
    const events = all.filter((e) => e.kind === 'launched' || e.kind === 'buybackEnabledUpdated')
    await expect(applyEvents(pool, deployment, events)).resolves.toMatchObject({
      launches: 1,
      buyback: 2,
    })
    await expect(assertRangeApplied(pool, events)).resolves.toBeUndefined()

    // VE POLITIKA SATIRI GERCEKTEN O LAUNCH'A BAGLANDI.
    const s = await state(POLICY_TOKEN)
    expect(s.enabled).toBe(false)
  })

  /**
   * ============ LISTE SUTUNU: `token_overview.buyback_enabled` ============
   *
   * Kart rozetinin BESLENDIGI yer. `getTokenBuyback`ten AYRI olmasi sart:
   * explore sayfasi kirk kart cizer ve kart basina bir sorgu kirk yuvarlak yol
   * demekti.
   *
   * Burada `admit` uzerinden gercek bir launch yazilir, yani `curve_state` ve
   * `token_stats` satirlari da olusur -- `token_overview` UCUNU DE `JOIN`
   * eder ve eksik biri satiri sessizce yok ederdi.
   */
  it('token_overview politikayi TASIR -- acik hal', async () => {
    const all = await fixtureEvents('buyback-policy', { block: POLICY_BLOCK })
    const deployment = { ...LIVE_DEPLOYMENT, factory: POLICY_FACTORY }
    const opened = all.filter(
      (e) => e.kind === 'launched' || (e.kind === 'buybackEnabledUpdated' && e.enabled),
    )
    await applyEvents(pool, deployment, opened)

    const { rows } = await getTokenOverview(pool, POLICY_TOKEN)
    expect(rows?.buybackEnabled).toBe(true)
    expect(rows?.buybackLockedTok).toBe(0n)
  })

  it('token_overview politikayi TASIR -- kapatilmis hal', async () => {
    const all = await fixtureEvents('buyback-policy', { block: POLICY_BLOCK })
    const deployment = { ...LIVE_DEPLOYMENT, factory: POLICY_FACTORY }
    await applyEvents(
      pool,
      deployment,
      all.filter((e) => e.kind === 'launched' || e.kind === 'buybackEnabledUpdated'),
    )

    const { rows } = await getTokenOverview(pool, POLICY_TOKEN)
    expect(rows?.buybackEnabled).toBe(false)
  })

  /**
   * LEFT JOIN: BUYBACK GORMEMIS BIR TOKEN LISTEDEN DUSMEZ.
   *
   * `JOIN` yazmak, ozelligi acmamis butun tokenleri explore sayfasindan
   * SILERDI -- ve bugun bu, tokenlerin neredeyse tamamidir. Bu test o hatayi
   * kart sayisiyla degil, satirin VARLIGIYLA olcer.
   */
  it('buyback gormemis bir token overview da DURUR (false / 0)', async () => {
    const all = await fixtureEvents('buyback-policy', { block: POLICY_BLOCK })
    const deployment = { ...LIVE_DEPLOYMENT, factory: POLICY_FACTORY }
    await applyEvents(
      pool,
      deployment,
      all.filter((e) => e.kind === 'launched'),
    )

    const { rows } = await getTokenOverview(pool, POLICY_TOKEN)
    expect(rows, 'buybacksiz token overview dan DUSTU').not.toBeNull()
    expect(rows?.buybackEnabled).toBe(false)
    expect(rows?.buybackLockedTok).toBe(0n)
  })

  // ---------------------------------------------------------------
  // OKUMA MODELI
  // ---------------------------------------------------------------

  it('getTokenBuyback durumu ve gecmisi birlikte doner', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    const { rows } = await getTokenBuyback(pool, TOKEN)
    expect(rows).not.toBeNull()
    expect(rows!.boughtTotalTok).toBe(15_550_159_190_581_009_077_265_247n)
    expect(rows!.lockedTotalTok).toBe(rows!.boughtTotalTok)
    // GECMIS EN YENI ONCE: panel son olayi ustte gostermeli.
    expect(rows!.history.map((h) => h.kind)).toEqual(['released', 'locked', 'executed', 'accrued'])
  })

  /**
   * HIC BUYBACK OLMAYAN BIR TOKEN `null` DONER -- `enabled: false` DEGIL.
   *
   * Ikisi ayni ekran degildir: birincisi "bu ozellik burada hic soz konusu
   * olmadi", ikincisi "acilmisti, KAPATILDI". Ayni degeri dondurmek, panelin
   * o iki hali ayirt etmesini IMKANSIZ kilardi.
   */
  it('buyback gormemis bir token icin null doner', async () => {
    const { rows } = await getTokenBuyback(pool, TOKEN)
    expect(rows).toBeNull()
  })

  it('gecmis siniri asilmaz', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())
    const { rows } = await getTokenBuyback(pool, TOKEN, { historyLimit: 2 })
    expect(rows!.history).toHaveLength(2)
    // ...ve TOPLAMLAR sinirdan ETKILENMEZ: ozet defterden degil durumdan gelir.
    expect(rows!.boughtTotalTok).toBe(15_550_159_190_581_009_077_265_247n)
  })

  /**
   * TUR <-> KOLON KISITLARI GERCEKTEN BAGLI.
   *
   * Semanin `*_iff_*` kisitlari, "hangi kolon hangi turde dolu" bilgisini
   * `apply/buyback.ts` ile PAYLASIR. Iki kopyadan biri bozulursa oteki
   * yakalamali; bu test kopyalardan SEMADAKININ dislerini olcer.
   */
  it('ture uymayan bir kolon SUNUCUDA reddedilir', async () => {
    await applyEvents(pool, LIVE_DEPLOYMENT, await buybackEvents())

    // `reason` yalnizca `skipped`ta dolu olabilir.
    await expect(
      pool.query("UPDATE buyback_events SET reason = 'x' WHERE kind = 'accrued'"),
    ).rejects.toThrow(/buyback_reason_iff_skipped/)

    // `pending_wei` yalnizca `accrued`ta.
    await expect(
      pool.query("UPDATE buyback_events SET pending_wei = 1 WHERE kind = 'executed'"),
    ).rejects.toThrow(/buyback_pending_iff_accrued/)

    // Vesting penceresi ILERI akar.
    await expect(
      pool.query(
        "UPDATE buyback_events SET vesting_end_at = vesting_start_at WHERE kind = 'locked'",
      ),
    ).rejects.toThrow(/buyback_vesting_window_is_forward/)
  })
})
