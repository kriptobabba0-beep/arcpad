/**
 * =============================================================================
 *  HANGI UC YALAN SOYLUYOR -- BOS BIR CEVAP BIR CEVAPTIR
 * =============================================================================
 *
 * 2026-08-18'de ayni 36 escrow logu IKI KEZ kayboldu. Sebep bir kesinti degil,
 * bir YALANDI: `rpc.blockdaemon.testnet.arc.network` 36 log iceren bir aralik
 * icin HATASIZ BOS DIZI donduruyordu. viem'in `fallback` tasiyicisi yedege
 * yalnizca birincil uc REDDEDERSE gecer -- bos bir dizi red degil, CEVAPTIR.
 * Yani failover tam da yalanin gerektigi yerde tetiklenmiyordu.
 *
 * O uc elle bulundu. Bu betik onu OLCULEBILIR yapar.
 *
 * UC SONUC, VE AYRIMLARI ONEMLIDIR:
 *
 *   DURUST        beklenen sayiyi dondurdu.
 *   TANIKLIK YOK  hata dondurdu (budanmis gecmis, aralik siniri, oran siniri).
 *                 Bu bir kusur DEGIL: uc "bilmiyorum" demis olur, ve
 *                 "bilmiyorum" ile "hicbir sey yok" arasindaki fark bu
 *                 dosyanin butun konusudur.
 *   YALANCI       hatasiz YANLIS sayi dondurdu -- ozellikle sifir. KIRMIZI.
 *
 * REFERANS ARALIK SABIT YAZILMAZ. Defterden en yeni ucret olayi okunur ve
 * onun etrafinda dar bir pencere kurulur; boylece zincir ilerledikce olcum
 * gecerli kalir ve budanmis uclar taze bloklari hala gorebilir. Aralik dar
 * tutulur cunku uclarin cogu 10.000 blokta reddediyor -- genis bir pencere
 * yalanci ile sinirli ucu ayirt edilemez kilardi.
 */
import { Pool } from 'pg'

type Verdict = 'DURUST' | 'TANIKLIK YOK' | 'YALANCI'

export type EndpointResult = {
  readonly url: string
  readonly verdict: Verdict
  readonly detail: string
}

/**
 * Tek bir ucun tek bir aralik hakkindaki cevabini yargilar.
 *
 * Disa acik, cunku dogru davranisi bir BIRIM TESTI olcer: sahte bir uc sifir
 * dondurdugunde `YALANCI` cikmali. O kontrol olmadan betik "her sey durust"
 * diyen ve hicbir seyi olcmeyen bir sey olurdu -- yani aradigi arizanin
 * kendisi.
 */
export function judge(
  expected: number,
  answer: { count: number } | { error: string },
): {
  verdict: Verdict
  detail: string
} {
  if ('error' in answer) return { verdict: 'TANIKLIK YOK', detail: answer.error.slice(0, 60) }
  if (answer.count === expected) return { verdict: 'DURUST', detail: `${answer.count} log` }
  return {
    verdict: 'YALANCI',
    detail: `${answer.count} log dondu, ${expected} olmali${answer.count === 0 ? ' -- BOS CEVAP' : ''}`,
  }
}

async function askEndpoint(
  url: string,
  address: string,
  from: bigint,
  to: bigint,
): Promise<{ count: number } | { error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address }],
      }),
      signal: AbortSignal.timeout(25_000),
    })
    const body = (await response.json()) as { result?: unknown[]; error?: { message?: string } }
    if (body.error !== undefined) return { error: body.error.message ?? 'bilinmeyen hata' }
    if (!Array.isArray(body.result)) return { error: 'cevapta `result` dizisi yok' }
    return { count: body.result.length }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

async function main(): Promise<number> {
  const escrow = process.env.ARC_ESCROW_ADDRESS
  const primary = process.env.ARC_RPC_URL
  const databaseUrl = process.env.DATABASE_URL
  if (escrow === undefined || primary === undefined || databaseUrl === undefined) {
    console.error('HATA: ARC_ESCROW_ADDRESS, ARC_RPC_URL ve DATABASE_URL gerekli')
    return 1
  }
  const urls = [primary, ...(process.env.ARC_RPC_FALLBACK_URLS ?? '').split(',')]
    .map((u) => u.trim())
    .filter((u) => u !== '')

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    // Referans: defterdeki EN YENI ucret olayinin blogu. Taze oldugu icin
    // budanmis bir uc bile onu gorebilmelidir -- yani sifir cevabi
    // "budadim"la aciklanamaz.
    const { rows } = await pool.query<{ block_number: string; n: string }>(
      `SELECT block_number::text, count(*)::text AS n
         FROM fee_events
        WHERE block_number = (SELECT max(block_number) FROM fee_events)
        GROUP BY block_number`,
    )
    const reference = rows[0]
    if (reference === undefined) {
      console.error('HATA: `fee_events` bos -- referans aralik turetilemiyor, ve')
      console.error('referanssiz bir durustluk olcumu hicbir sey kanitlamaz.')
      return 1
    }
    const block = BigInt(reference.block_number)
    const expected = Number(reference.n)
    console.log(`referans: blok ${block}, ${expected} log (defterden turetildi)\n`)

    const results: EndpointResult[] = []
    for (const url of urls) {
      const answer = await askEndpoint(url, escrow, block, block)
      const { verdict, detail } = judge(expected, answer)
      const host = new URL(url).host
      results.push({ url: host, verdict, detail })
      console.log(`  ${verdict.padEnd(13)} ${host.padEnd(38)} ${detail}`)
    }

    const liars = results.filter((r) => r.verdict === 'YALANCI')
    const honest = results.filter((r) => r.verdict === 'DURUST')
    console.log()
    if (liars.length > 0) {
      console.error(`YALAN SOYLEYEN UC: ${liars.map((l) => l.url).join(', ')}`)
      console.error('Bu uc yedek zincirinden CIKARILMALIDIR. Hata veren bir uctan KOTUDUR:')
      console.error('hata failover tetikler, yalan tetiklemez -- ve veri sessizce kaybolur.')
      return 1
    }
    if (honest.length === 0) {
      // Hicbiri cevap veremediyse olcum YAPILMAMISTIR. Bunu yesil saymak,
      // "kosmayan bir kapi rapor vermez" arizasinin ta kendisi olurdu.
      console.error('HICBIR UC TANIKLIK EDEMEDI -- durustluk OLCULEMEDI, yesil sayilamaz.')
      return 1
    }
    console.log(
      `${honest.length} uc durust, ${results.length - honest.length} uc taniklik edemedi.`,
    )
    return 0
  } finally {
    await pool.end()
  }
}

// Test dosyasi `judge`i import edebilsin diye yalnizca dogrudan calistirildiginda kos.
if (process.argv[1]?.endsWith('rpc-honesty.ts') === true) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
