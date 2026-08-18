import type { Address } from 'viem'

/**
 * ============================================================================
 *  BOS BIR `eth_getLogs` CEVABI, "OLAY YOK" DEMEK DEGILDIR
 * ============================================================================
 *
 * ============ OLCULEN ARIZA (2026-08-18, uretim) ============
 *
 * Indexer 57.180.976-57.181.241 araligindaki **36** escrow olayini KACIRDI ve
 * imleci ilerletti. Sonra bir `Claimed` geldi ve defterde karsiligi olmayan bir
 * cekim `CHECK (claimable_wei >= 0)`'i patlatti -- servis 46 kez cokup yeniden
 * basladi. Zincirle karsilastirma kaybi wei wei dogruladi:
 *
 *   owed(0xe92c64c4...) @57179323  bizim 24_882_521_395_944_722  zincir AYNI
 *   owed(0xe92c64c4...) @57185000  bizim 24_882_521_395_944_722  zincir
 *                                        84_229_572_150_402_885   <- AYRISMA
 *
 * ============ NEDEN GORUNMEDI ============
 *
 * `getLogs` aralik-cok-genis HATALARINI zaten dogru isliyor (`RANGE_ERROR_CODES`,
 * bolerek kucultme). Ama birincil uc REDDETMEDI: bos bir dizi dondu. viem bir
 * hata gormedigi icin yedek uca GECMEDI, indexer de "bu aralikta olay yok"
 * kabul edip imleci ilerletti.
 *
 * Ve bu, deponun ZATEN OLCTUGU bir davranis. `indexer.env`:
 *
 *   "measured 2026-08-11: the primary answered 0/10 eth_getLogs calls one
 *    second apart while this one answered 10/10 ... viem only reaches this one
 *    when the primary REFUSES."
 *
 * Not "refuses" ile "returns empty" arasindaki fark, sessiz ve KALICI veri
 * kaybidir. Cokme aslinda bir SANSTI: `CHECK` kisiti olmasaydi eksik defter
 * sessizce yasardi.
 *
 * ============ NICIN HER BOS ARALIK DOGRULANMAZ ============
 *
 * Bos bir aralik TEK BASINA dogrulanamaz: zincirde gercekten bos araliklar var
 * ve cogunluk onlar. Hepsini ikinci bir uca sormak RPC maliyetini ~iki katina
 * cikarirdi -- ve bu indexer'in tarama hizi zaten Arc'in hiz limitine bagli.
 *
 * Dogrulanabilir hale gelmesi icin BAGIMSIZ bir tanik gerekir. O yuzden
 * ORNEKLEME: her `sampleEvery` bos aralikta BIR tanesi taniga sorulur. Yakalanan
 * sey tek bir cagri degil, ucun BOZUK DURUMU -- ve olculen ariza tam olarak bir
 * durumdu (0/10'a karsi 10/10), tek bir talihsiz cagri degil.
 *
 * ============ UC SESSIZ BASARISIZLIK KAPATILDI ============
 *
 * 1. TANIK YOKSA MUHAFIZ NO-OP'TUR -- ve bunu SOYLER. Yapilandirilmamis bir
 *    dagitimda (`ARC_RPC_FALLBACK_URLS` bos) capraz kontrol MUMKUN DEGILDIR.
 *    Sessizce hicbir sey yapan bir muhafiz, olmayan bir muhafizdan KOTUDUR:
 *    varligi guven verir.
 * 2. TANIK SUREKLI HATA VERIYORSA MUHAFIZ DURUR. Hatalari yutmak, muhafizi
 *    yeniden sessiz bir no-op'a cevirirdi -- yani duzeltilen sinifin ta kendisi.
 *    `maxWitnessFailures` ardisik hatadan sonra ATILIR.
 * 3. TANIK DA BOS DERSE bu bir ONAY'dir, bir belirsizlik degil: sayac sifirlanir
 *    ve tarama devam eder. Iki bagimsiz ucun ayni bosluk uzerinde anlasmasi,
 *    elimizdeki en guclu kanittir.
 */

/** Tanik uc, bos denen bir aralikta OLAY BULDU. Imlec ILERLEMEMELIDIR. */
export class EmptyRangeDisputed extends Error {
  constructor(
    readonly from: bigint,
    readonly to: bigint,
    readonly witnessEvents: number,
  ) {
    super(
      `EmptyRangeDisputed: [${from}, ${to}] birincil ucta BOS dondu ama tanik uc ` +
        `${witnessEvents} olay buldu. Bu aralik ATLANMAMALI -- imlec ilerletilmedi. ` +
        'Birincil uc `eth_getLogs` icin bozuk durumda olabilir (bkz. ARC_RPC_FALLBACK_URLS).',
    )
    this.name = 'EmptyRangeDisputed'
  }
}

/**
 * ============ TANIGIN BIR UFKU VAR, VE ALTINDA SUSAR ============
 *
 * OLCULDU (uretim, 2026-08-18): tanik uc `pruned history unavailable` donduruyor.
 * Budanmis bir dugum eski bloklarin loglarini TUTMAZ -- yani o aralik hakkinda
 * tanikligi YOKTUR. Bu bir ariza DEGIL, yapisal bir sinir.
 *
 * Ilk surum bunu "cevap veremedi" sayiyordu ve ard arda bes kez gorunce
 * `WitnessUnavailable` atip indexer'i durduruyordu -- geriye donuk tarama
 * boyunca her ~10 dakikada bir. Yanlisti: tanigin susmasi, birincil ucun
 * yalan soyledigi anlamina gelmez, ve durmak KORUMA EKLEMEZ (o aralikta zaten
 * dogrulama yapilamiyor) -- yalnizca isi keser.
 *
 * Dogru model: "tanik bu aralik hakkinda konusamaz" ayri bir sonuctur. Atlanir,
 * hata sayilmaz, ama SESSIZ de gecilmez: cagiran, tarihsel araligin
 * DOGRULANMADIGINI bilmelidir.
 */
const CANNOT_TESTIFY = /pruned|history unavailable|state unavailable|missing trie node/i

function cannotTestify(error: unknown): boolean {
  // Hem viem'in `details` alanini hem duz mesaji tarar: sarmalayici degisebilir,
  // sunucunun cumlesi degismez.
  const parts: string[] = []
  if (error instanceof Error) parts.push(error.message)
  const details = (error as { details?: unknown } | null)?.details
  if (typeof details === 'string') parts.push(details)
  const cause = (error as { cause?: unknown } | null)?.cause
  if (cause instanceof Error) parts.push(cause.message)
  const causeDetails = (cause as { details?: unknown } | null)?.details
  if (typeof causeDetails === 'string') parts.push(causeDetails)
  return CANNOT_TESTIFY.test(parts.join(' | '))
}

/** Tanik ardisik olarak cevap veremedi: muhafiz KOSAMIYOR, yani gecerli degil. */
export class WitnessUnavailable extends Error {
  constructor(
    readonly consecutiveFailures: number,
    override readonly cause: unknown,
  ) {
    super(
      `WitnessUnavailable: tanik uc ust uste ${consecutiveFailures} kez cevap veremedi. ` +
        'Bos aralik dogrulamasi KOSAMIYOR; kosamayan bir muhafiz, guven veren bir no-op olurdu.',
    )
    this.name = 'WitnessUnavailable'
  }
}

/** Bir araligi BAGIMSIZ bir ucta sorar ve bulunan olay sayisini doner. */
export type RangeWitness = (from: bigint, to: bigint) => Promise<number>

export interface EmptyRangeGuard {
  /** Tanik yapilandirilmamissa `false`. Cagiran bunu LOGLAMALIDIR. */
  readonly enabled: boolean
  /** Bir aralik bos dondu. Ornekleme sirasi geldiyse dogrular. */
  readonly onEmptyRange: (from: bigint, to: bigint) => Promise<void>
  /** Test ve teshis icin: su ana kadar kac bos aralik gorundu. */
  readonly emptyRangesSeen: () => number
  /** Test ve teshis icin: kac dogrulama yapildi. */
  readonly verifications: () => number
  /**
   * Tanigin UFKUNUN ALTINDA kaldigi icin dogrulanamayan aralik sayisi. Sifirdan
   * buyukse o araliklar DOGRULANMAMISTIR -- cagiran bunu gorunur kilmalidir.
   */
  readonly silencedByHorizon: () => number
}

export interface EmptyRangeGuardOptions {
  /**
   * BAGIMSIZ bir uc. `null` ise muhafiz kapalidir ve `enabled` bunu bildirir.
   * Ayni istemciyi vermek ANLAMSIZDIR: yalan soyleyen uca kendi yalanini
   * sormak, dogrulama degil tekrardir.
   */
  readonly witness: RangeWitness | null
  /**
   * Kac bos aralikta bir dogrulama yapilir. 25: 1000 bloklu araliklarla
   * 25.000 blokta bir ek `fetchRange` demektir -- olculen kayip 265 blokluk bir
   * pencerede oldu, yani bir bozuk DURUM birkac ornekleme icinde yakalanir.
   * Maliyet, bos araliklarin ~%4'u.
   */
  readonly sampleEvery?: number
  /** Ardisik tanik hatasi tavani. Asilirsa `WitnessUnavailable` atilir. */
  readonly maxWitnessFailures?: number
}

const DEFAULT_SAMPLE_EVERY = 25
const DEFAULT_MAX_WITNESS_FAILURES = 5

export function createEmptyRangeGuard(options: EmptyRangeGuardOptions): EmptyRangeGuard {
  const sampleEvery = Math.max(1, options.sampleEvery ?? DEFAULT_SAMPLE_EVERY)
  const maxFailures = Math.max(1, options.maxWitnessFailures ?? DEFAULT_MAX_WITNESS_FAILURES)
  const witness = options.witness

  let seen = 0
  let verified = 0
  let failures = 0
  let silenced = 0

  return {
    enabled: witness !== null,
    emptyRangesSeen: () => seen,
    verifications: () => verified,
    silencedByHorizon: () => silenced,
    onEmptyRange: async (from: bigint, to: bigint): Promise<void> => {
      seen += 1
      if (witness === null) return
      if (seen % sampleEvery !== 0) return

      let count: number
      try {
        count = await witness(from, to)
      } catch (error) {
        if (cannotTestify(error)) {
          // TANIGIN UFKUNUN ALTINDA. Ariza degil, sinir: sayaci ARTIRMAZ.
          // Sayilsaydi geriye donuk her tarama `WitnessUnavailable` ile durur ve
          // muhafiz, korudugu isi imkansiz kilardi.
          silenced += 1
          return
        }
        failures += 1
        // TAVANA KADAR YUTULUR: tek bir tanik hatasi ingest'i durdurmamali,
        // cunku tanik tanim geregi IKINCIL bir uctur ve onun gecici arizasi
        // bizim verimizi bozmaz. Ama SURELI yutmak muhafizi no-op yapar.
        if (failures >= maxFailures) throw new WitnessUnavailable(failures, error)
        return
      }
      failures = 0
      verified += 1
      if (count > 0) throw new EmptyRangeDisputed(from, to, count)
    },
  }
}

/**
 * Tanik istemcinin adresi. `arcRpcUrls` birincil + yedekleri DEDUPLIKE eder,
 * yani ikinci eleman gercekten BASKA bir uctur. Yedek yoksa `null` -- ve
 * cagiran bunu `enabled: false` olarak gorur.
 */
export function witnessUrlFrom(urls: readonly string[]): string | null {
  return urls.length >= 2 ? (urls[1] as string) : null
}

/** Yalnizca tip icin: tanigin sordugu izleme kumesi cagiranin kumesiyle AYNI olmali. */
export type WitnessScope = { readonly factory: Address; readonly escrow: Address }
