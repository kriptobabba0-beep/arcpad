import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { TOPIC0 } from '../src/arc'
import type { WatchSet } from '../src/logs'
import { fetchRange } from '../src/logs'
import { FakeNode, rawLogs } from './fixtures'

/**
 * ============ CEKME KATMANI: BUYBACK LOGLARI GERCEKTEN ISTENIYOR MU ============
 *
 * BU DOSYA OLCULMUS BIR DELIGIN UZERINE YAZILDI. Buyback'in cozme katmani --
 * imzalar, tipler, `DECODERS`, fixture'lar -- tamamlanmisti ve butun kapilari
 * yesildi; `fetchRange` ise hazine ve kasa adreslerini HIC SORMUYORDU. Yani
 * uretimde tek bir buyback logu gelmezdi ve HICBIR SEY KIRMIZI OLMAZDI:
 *
 *   - `logs.test.ts` loglari DOSYADAN okur, `fetchRange`ten degil;
 *   - `apply-buyback.test.ts` olaylari fixture'dan alir, cekmez;
 *   - "hic buyback logu yok" zaten MESRU bir durumdur (ozellik varsayilan
 *     kapali), yani sifir sonuc bir alarm uretmez.
 *
 * Cozucunun dogru olmasi, logun CEKILDIGINI soylemez. Bu dosya tam olarak o
 * cumleyi olcer: FILTRELERE bakar, dosyaya degil.
 */

/** `buyback` fixture'inin yayincilari (dosyadan OKUNDU). */
const TREASURY = '0xc7183455a4c133ae270771860664b6b7ec320bb1' as Address
const VAULT = '0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9' as Address
/** `buyback-policy` fixture'inin fabrikasi. */
const POLICY_FACTORY = '0xf62849f9a0b5bf2913b396098f7c7019b51a820a' as Address

const BLOCK = 54_800_000n
const ESCROW = '0x00000000000000000000000000000000000e5c00' as Address

function watch(over: Partial<WatchSet> = {}): WatchSet {
  return {
    factory: POLICY_FACTORY,
    escrow: ESCROW,
    curves: new Set(),
    tokens: new Set(),
    curveToToken: new Map(),
    pools: new Map(),
    buyback: null,
    ...over,
  }
}

/** Her iki senaryonun loglari, AYNI bloga temellendirilmis. */
function allLogs() {
  return [
    ...rawLogs('buyback', { block: BLOCK }),
    ...rawLogs('buyback-policy', { block: BLOCK, txHash: `0x${'b1'.repeat(32)}` }).map(
      (log, i) => ({
        ...log,
        // Ayni blokta iki senaryo var; `logIndex` cakismasin diye politika
        // loglari yukari tasiniyor. `UnorderedLogs` muhafizi YANIT ICI sirayi
        // olcer, yani cakisan bir kimlik burada gurultulu duserdi.
        logIndex: `0x${(100 + i).toString(16)}` as `0x${string}`,
      }),
    ),
  ]
}

const kindsOf = (events: readonly { kind: string }[]): string[] => events.map((e) => e.kind).sort()

/** Hazine ve kasadan gelen BES olay -- politika HARIC. */
const MONEY_KINDS: ReadonlySet<string> = new Set([
  'buybackAccrued',
  'buybackExecuted',
  'buybackSkipped',
  'buybackLocked',
  'vestingReleased',
])

describe('cekme katmani -- buyback', () => {
  /**
   * HAZINE VERILMEDIGINDE BES OLAY GELMEZ -- VE SORULMAZ DA.
   *
   * Iki iddia birden: sonucta yoklar, VE filtrelerin hicbiri hazineyi anmiyor.
   * Yalnizca birincisi olsaydi, "sordu ama dugum bos dondu" hali ayni yesili
   * verirdi.
   */
  it('watch.buyback null iken hazine HIC SORULMAZ', async () => {
    const node = new FakeNode(allLogs())
    const events = await fetchRange(node, watch(), BLOCK, BLOCK)

    expect(events.filter((e) => MONEY_KINDS.has(e.kind))).toHaveLength(0)

    const addressed = node.logFilters.flatMap((f) => {
      const a = f['address']
      return a === undefined ? [] : Array.isArray(a) ? (a as string[]) : [a as string]
    })
    expect(addressed.map((a) => a.toLowerCase())).not.toContain(TREASURY)
    expect(addressed.map((a) => a.toLowerCase())).not.toContain(VAULT)
  })

  it('hazine verildiginde BESI DE gelir', async () => {
    const node = new FakeNode(allLogs())
    const events = await fetchRange(
      node,
      watch({ buyback: { treasury: TREASURY, vault: VAULT } }),
      BLOCK,
      BLOCK,
    )

    /*
     * PARA OLAYLARI SUZULUYOR, ve corpus'un geri kalani BILEREK disarida:
     * `buyback-policy` fixture'i bir `Launched` ve onun mint `Transfer`ini de
     * tasir, ve ikisi de MESRU olarak cekilir (fabrika izleniyor, FAZ 1.5
     * tokeni kumeye ekliyor). Onlari da iddiaya katmak, bu testi buyback
     * hakkinda degil corpus'un sekli hakkinda yapardi.
     */
    expect(kindsOf(events.filter((e) => MONEY_KINDS.has(e.kind)))).toEqual([
      'buybackAccrued',
      'buybackExecuted',
      'buybackLocked',
      'vestingReleased',
    ])
  })

  /**
   * SORGU IKI ADRESI DE TASIR VE BES TOPIC'I DE.
   *
   * Filtrenin SEKLI olculuyor, yalnizca sonucu degil: dort topic tasiyan bir
   * filtre bu corpus'ta yine dort olay dondurebilir (`buyback` fixture'inda
   * `BuybackSkipped` YOKTUR), yani sonuca bakan bir test eksik topic'i
   * goremezdi.
   */
  it('tek sorgu, iki adres, bes topic', async () => {
    const node = new FakeNode(allLogs())
    await fetchRange(node, watch({ buyback: { treasury: TREASURY, vault: VAULT } }), BLOCK, BLOCK)

    const buybackFilter = node.logFilters.find((f) => {
      const a = f['address']
      return Array.isArray(a) && (a as string[]).map((x) => x.toLowerCase()).includes(TREASURY)
    })
    expect(buybackFilter, 'hazineyi soran bir filtre yok').toBeDefined()
    expect((buybackFilter!['address'] as string[]).map((a) => a.toLowerCase()).sort()).toEqual(
      [TREASURY, VAULT].sort(),
    )
    expect(((buybackFilter!['topics'] as string[][])[0] ?? []).sort()).toEqual(
      [
        TOPIC0.buybackAccrued,
        TOPIC0.buybackExecuted,
        TOPIC0.buybackSkipped,
        TOPIC0.buybackLocked,
        TOPIC0.vestingReleased,
      ].sort(),
    )
  })

  // -----------------------------------------------------------------
  // POLITIKA: FABRIKADAN, VE HAZINEDEN BAGIMSIZ
  // -----------------------------------------------------------------

  /**
   * POLITIKA HAZINE OLMADAN DA GELIR, ve bu bir ayrinti degil: creator
   * `launchWithBuyback` cagirdiginda fabrika bayragi YAZAR -- hazine hic
   * kurulmamis olsa bile. O hali kaciran bir cekme, ozelligi acmis bir
   * token'i ekranda "kapali" gosterirdi.
   */
  it('politika olaylari hazineden BAGIMSIZ gelir', async () => {
    const node = new FakeNode(allLogs())
    const events = await fetchRange(node, watch(), BLOCK, BLOCK)
    const policy = events.filter((e) => e.kind === 'buybackEnabledUpdated')
    expect(policy).toHaveLength(2)
  })

  /** `bool` GERCEKTEN OKUNUYOR: iki log, iki farkli deger. */
  it('acma ve kapatma AYRI cozulur', async () => {
    const node = new FakeNode(allLogs())
    const events = await fetchRange(node, watch(), BLOCK, BLOCK)
    const flags = events
      .filter((e) => e.kind === 'buybackEnabledUpdated')
      .map((e) => (e.kind === 'buybackEnabledUpdated' ? e.enabled : null))
    expect(flags.sort()).toEqual([false, true])
  })

  /**
   * ============ POLITIKA `Launched` SORGUSUNA KATILMAZ ============
   *
   * Ikisi de fabrikadan gelir, yani tek bir `topics: [[launched, policy]]`
   * filtresi bir cagri tasarrufu gibi gorunur. YANLIS OLURDU ve arizasi
   * sessizdir: FAZ 1.5 dongusu donen her logun `topics[2]`sini bir CURVE sanip
   * izleme kumesine ekler, oysa politika olayinda o alan `by` -- bir cuzdan.
   * Kumeye giren sahte "curve" hicbir sey yaymaz, ama `Trade` filtresi ondan
   * sonra onun yaydigi her seyi de kabul eder.
   *
   * Bu yuzden olculen sey SONUC DEGIL FILTRENIN KENDISI: `Launched` sorgusunun
   * topic listesi TAM OLARAK tek elemanli olmali.
   */
  it('Launched sorgusu politika topic ini TASIMAZ', async () => {
    const node = new FakeNode(allLogs())
    await fetchRange(node, watch(), BLOCK, BLOCK)

    const launchedFilter = node.logFilters.find((f) => {
      const t = (f['topics'] as unknown[] | undefined)?.[0]
      const list = Array.isArray(t) ? (t as string[]) : t === undefined ? [] : [t as string]
      return list.includes(TOPIC0.launched)
    })
    expect(launchedFilter, 'Launched sorgusu yok').toBeDefined()
    const topic0 = (launchedFilter!['topics'] as unknown[])[0]
    const list = Array.isArray(topic0) ? (topic0 as string[]) : [topic0 as string]
    expect(list).toEqual([TOPIC0.launched])
  })
})
