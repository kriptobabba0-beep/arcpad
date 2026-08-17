import { beforeAll, describe, expect, it } from 'vitest'
import { applyCompleted, applyLaunch, applyTrade, applyTransfer } from '../src/apply'
import type { LaunchEvent, TradeEvent } from '../src/apply'
import { putDeployment } from '../src/deployment'
import { listTokens } from '../src/queries'
import { toSeq } from '../src/seq'
import { pool, resetSchema } from './setup'
import { addr, BUY, DEPLOYMENT, hash32, LAUNCH, PROFILE, ZERO } from './fixtures'

/**
 * ==========================================================================
 *  `token_overview.created_seq` ARTIK `token_stats`TEN GELIR -- BU ONUN KAPISI
 * ==========================================================================
 *
 * `017_sort_keys.sql` view'in `created_seq`ini `l.created_seq`ten
 * `ts.created_seq`e cevirdi, boylece `search_key(volume_24h_wei, created_seq)`
 * TEK TABLOYA cozulur ve ifade indeksi ona hizmet eder (olculdu: `Sort=2` ->
 * `Sort=0`).
 *
 * O degisiklik BIR ESITLIGE dayanir: `token_stats.created_seq` her zaman
 * `launches.created_seq`e esittir. Esitlik bugun YAPISALDIR --
 *
 *   * `applyLaunch` ikisini TEK ifadede, AYNI `ins` CTE'sinden yazar;
 *   * hicbir `UPDATE` `created_seq`e dokunmaz;
 *   * `JOIN token_stats` bir INNER JOIN, yani NULL/satir-kumesi riski yok;
 *   * `applyLaunch` TEK yazma yolu -- indexer de (`admit.ts`) onu cagirir.
 *
 * -- ama YAPISAL, ZORLANMIS demek degildir. Bu dosya onu zorlar.
 *
 * VE NEDEN ONCE ZORLANMAMISTI, KAYDA DEGER: ayni degisiklik bir kez yapildi ve
 * `web/e2e/db/explore-and-search.spec.ts` "`oldest` yaratilis sirasina gore
 * ARTMALI" diyerek dustugu icin GERI ALINDI. Sonra o e2e testinin `/?sort=
 * oldest` surdugu, Explore'un ise `?sort=`i HIC okumadigi ortaya cikti: hata
 * bu degisiklikten DEGIL, silinmis bir URL sozlesmesinden geliyordu. Yani
 * calisan bir degisiklik, ilgisiz bir kusur yuzunden geri alinmisti.
 *
 * DERS BU DOSYANIN VAR OLMA SEBEBI: bir iddianin NEREDE kanitlandigi, neyi
 * kanitladigi kadar onemli. `oldest`in yonu bir URL parametresinin degil, bu
 * semanin ozelligidir -- o yuzden artik BURADA, arayuzun ulasamadigi yerde
 * olculuyor.
 */

/** Ayni sekil, farkli token/curve/seq. `created_seq` = `toSeq(BLOCK+i, 0)`. */
function launchAt(i: number): LaunchEvent {
  const block = 1_000n + BigInt(i) * 10n
  return {
    ...LAUNCH,
    eventSeq: toSeq(block, 0),
    blockNumber: block,
    logIndex: 0,
    txHash: hash32(0xa000 + i),
    token: addr(0x7000 + i),
    curve: addr(0xc000 + i),
    name: `Sort Fixture ${String(i).padStart(2, '0')}`,
    symbol: `SF${i}`,
  }
}

/** `launchAt(i)`nin curve'unde bir alim. Hacmi i ile DEGISIR. */
function buyAt(i: number, nth: number): TradeEvent {
  const block = 1_000n + BigInt(i) * 10n + BigInt(nth) + 1n
  const quote = BigInt(i + 1) * 1_000_000_000_000_000n
  const tokens = BigInt(i + 1) * 1_000n * 10n ** 18n
  return {
    ...BUY,
    eventSeq: toSeq(block, 2),
    blockNumber: block,
    logIndex: 2,
    txHash: hash32(0xb000 + i * 8 + nth),
    token: addr(0x7000 + i),
    curve: addr(0xc000 + i),
    tokenAmountTok: tokens,
    quoteAmountWei: quote,
    virtualTokenReservesTok: PROFILE.virtualTokenReservesTok - tokens,
    virtualQuoteReservesWei: PROFILE.virtualQuoteReservesWei + quote,
    realTokenReservesTok: PROFILE.saleSupplyTok - tokens,
    realQuoteReservesWei: quote,
  }
}

const COUNT = 12

describe('token_stats.created_seq, `token_overview`in siralama anahtari', () => {
  beforeAll(async () => {
    await resetSchema()
    await putDeployment(pool, DEPLOYMENT)

    /*
     * HER YAZMA YOLU KOSULUR, YALNIZCA `applyLaunch` DEGIL.
     *
     * Esitligi kiracak sey bir gelecekteki `UPDATE`tir, ve bir metin taramasi
     * onu ancak yazildigi bicimde yakalar. Bunun yerine olaylarin KENDISI
     * oynatilir: launch, transfer, iki alim ve bir `Completed`. Boyle bir
     * `UPDATE` eklendigi gun bu dosya duser, nasil yazildigina bakmaksizin.
     */
    for (let i = 0; i < COUNT; i += 1) {
      await applyLaunch(pool, launchAt(i))
      await applyTransfer(pool, {
        kind: 'transfer',
        eventSeq: toSeq(1_000n + BigInt(i) * 10n, 1),
        blockNumber: 1_000n + BigInt(i) * 10n,
        logIndex: 1,
        txHash: hash32(0xc700 + i),
        blockTime: LAUNCH.blockTime,
        token: addr(0x7000 + i),
        from: ZERO,
        to: addr(0xc000 + i),
        amountTok: PROFILE.totalSupplyTok,
      })

      // Ucte birinde islem VAR, gerisinde YOK: hacim gercekten degisir ve
      // "hic islem gormemis" dali da kapsanir.
      if (i % 3 === 0) {
        await applyTrade(pool, buyAt(i, 0))
        await applyTrade(pool, buyAt(i, 1))
      }

      // Ilk ikisi tamamlanir, yani `Completed` yolu da bu esitligi gormus olur.
      if (i < 2) {
        await applyCompleted(pool, {
          kind: 'completed',
          eventSeq: toSeq(1_000n + BigInt(i) * 10n, 9),
          blockNumber: 1_000n + BigInt(i) * 10n,
          logIndex: 9,
          txHash: hash32(0xd000 + i),
          blockTime: LAUNCH.blockTime,
          token: addr(0x7000 + i),
          realQuoteReservesWei: 12_161_433_369_060_378_706n,
          poolSeedSupplyTok: 206_886_011_183_597_390_493_942_218n,
        })
      }
    }
  })

  it('on iki launch ve `token_stats` satirlari yazildi -- altindaki her iddianin on kosulu', async () => {
    const { rows } = await pool.query<{ l: string; s: string }>(
      `SELECT (SELECT count(*) FROM launches)::text AS l,
              (SELECT count(*) FROM token_stats)::text AS s`,
    )
    expect(Number(rows[0]!.l)).toBe(COUNT)
    expect(Number(rows[0]!.s)).toBe(COUNT)
  })

  it('`token_stats.created_seq` HER satirda `launches.created_seq`e ESITTIR', async () => {
    const { rows } = await pool.query<{ token: string; l: string; s: string }>(
      `SELECT l.token, l.created_seq::text AS l, ts.created_seq::text AS s
         FROM launches l JOIN token_stats ts ON ts.token = l.token
        WHERE ts.created_seq IS DISTINCT FROM l.created_seq`,
    )
    // Ayrisan satirlari ADIYLA basar: bir sayi "kac tane" der, hangi token
    // oldugunu SOYLEMEZ, ve o fark ayiklamanin tamamidir.
    expect(rows, `ayrisan satirlar: ${JSON.stringify(rows)}`).toEqual([])
  })

  it('ve `token_stats`i olmayan bir launch YOKTUR -- INNER JOIN bunu varsayar', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM launches l
        WHERE NOT EXISTS (SELECT 1 FROM token_stats ts WHERE ts.token = l.token)`,
    )
    // Bu, view'in `JOIN token_stats`inin (INNER) hicbir launch'i DUSURMEDIGI
    // iddiasidir. `LEFT JOIN`e cevrilmesi gerekmedigi de tam olarak budur.
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('view `created_seq`i `launches`in degeriyle AYNI verir', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM token_overview o JOIN launches l ON l.token = o.token
        WHERE o.created_seq IS DISTINCT FROM l.created_seq`,
    )
    // Kaynak degisikligi GOZLENEBILIR sozlesmeyi degistirmedi. Bu iddia,
    // view'i yanlis tabloya baglayan bir gelecekteki duzenlemeyi yakalar.
    expect(Number(rows[0]!.n)).toBe(0)
  })

  /*
   * `oldest` VE `newest` -- ARAYUZUN DEGIL, SEMANIN OZELLIGI.
   *
   * Bu iddia daha once yalnizca bir Playwright testinde vardi ve o test
   * Explore'un OKUMADIGI bir URL parametresini suruyordu, yani hicbir sey
   * olcmuyordu. Burada URL yok: `SORTS`un iki anahtari dogrudan cagriliyor.
   *
   * `limit` KUME BOYUTUNDAN BUYUK: kirpilmis iki liste ters cevrilince
   * birbirini vermez (30 satirin 24'u alinirsa `newest` 29..06, `oldest`
   * 00..23 verir ve tersi 06..29'dur), yani kirpma bu iddiayi SESSIZCE
   * yanlislardi. Tam kume aliniyor.
   */
  it('`oldest`, `newest`in TAM TERSIDIR -- ve ikisi de yaratilis sirasindadir', async () => {
    const newest = await listTokens(pool, { sort: 'newest', limit: COUNT + 5 })
    const oldest = await listTokens(pool, { sort: 'oldest', limit: COUNT + 5 })

    expect(newest.rows.length, 'tam kume alinmali, yoksa tersleme iddiasi cokler').toBe(COUNT)
    expect(oldest.rows.length).toBe(COUNT)

    const seqOf = (rows: readonly { createdSeq: bigint }[]): bigint[] =>
      rows.map((row) => row.createdSeq)

    const down = seqOf(newest.rows)
    const up = seqOf(oldest.rows)

    for (let i = 1; i < down.length; i += 1) {
      expect(down[i]! < down[i - 1]!, '`newest` AZALMALI').toBe(true)
    }
    for (let i = 1; i < up.length; i += 1) {
      expect(up[i]! > up[i - 1]!, '`oldest` ARTMALI').toBe(true)
    }
    // Ve ikisi ayni kumenin iki yonudur: bir varsayilana dusen `sort`
    // ikisini de ayni yonde verirdi ve yukaridaki iki dongu bunu yakalamazdi
    // (biri gecerdi). Tersleme, o kaciklari kapatir.
    expect(up.map(String)).toEqual([...down].reverse().map(String))
  })

  it('`volume` siralamasi hacme gore AZALIR, ve bag-bozma `created_seq`tir', async () => {
    const { rows } = await listTokens(pool, { sort: 'volume', limit: COUNT + 5 })
    expect(rows.length).toBe(COUNT)

    /*
     * KAYNAK DEGISIKLIGININ ASIL RISKI BURADA OLCULUR. `volume` anahtari
     * `search_key(volume_24h_wei, created_seq)` -- yani `created_seq` YALNIZCA
     * bag-bozmadir. Sekiz token hacimsizdir (esit), dolayisiyla bu listenin
     * kuyrugu TAMAMEN bag-bozma anahtarina gore sirali olmak zorundadir ve
     * kaynagi yanlis tabloya baglamak tam orada gorunurdu.
     */
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1]!
      const cur = rows[i]!
      const dropped = cur.volume24hWei < prev.volume24hWei
      const tied = cur.volume24hWei === prev.volume24hWei
      expect(dropped || tied, 'hacim ARTAMAZ').toBe(true)
      if (tied) {
        expect(cur.createdSeq < prev.createdSeq, 'esitlikte `created_seq` AZALMALI').toBe(true)
      }
    }

    // PRE-KOSUL: kuyrukta gercekten esitlik VAR. Olmasaydi yukaridaki `if`
    // hic girilmez ve bag-bozma iddiasi vakumda gecerdi.
    const ties = rows.filter((row) => row.volume24hWei === 0n).length
    expect(ties, 'fixture hacimsiz token TASIMALI, yoksa bag-bozma olculmez').toBeGreaterThan(1)
  })
})
