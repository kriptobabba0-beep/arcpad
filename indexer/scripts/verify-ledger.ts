/**
 * =============================================================================
 *  DEFTERI ZINCIRE KARSI DOGRULAR -- TOPLAMLA DEGIL, KONTROL NOKTASIYLA
 * =============================================================================
 *
 * NEDEN TOPLAM YETMEZ. 2026-08-18'de bir uc `eth_getLogs` icin hata vermeden
 * BOS DIZI dondu; indexer "olay yok" kabul edip imleci ilerletti ve 36 escrow
 * logu sessizce kayboldu. Toplamlari karsilastirmak bunu bulamazdi: bir toplam
 * kaybin NEREDE oldugunu soylemez, ve kayip yeterince kucukse yuvarlamaya
 * benzer. Ayrisma ancak ARTAN bloklarda `owed()` okunarak yerellestirilebilir.
 *
 * `owed(recipient)` = o aliciya yapilan mevduatlar EKSI cekimler. Bizim
 * karsiligimiz `fee_events` uzerinde ayni farkin `block_number <= N` ile
 * kisitlanmis halidir. Ikisi her kontrol noktasinda esit olmak ZORUNDADIR.
 *
 * BU BETIK KENDI KENDINI SINAR (`--self-test`): bir alicinin SON olayindan bir
 * onceki bloga kadarki toplamini zincirin GUNCEL degeriyle karsilastirir --
 * tanim geregi AYRISMASI gereken bir sorgu. Ayrisma gormezse betik KIRMIZI
 * doner. Sessizce "esit" diyen bir dogrulayici hicbir sey kanitlamaz, ve bu
 * deponun en pahali arizalari tam olarak o siniftandi.
 *
 * `cast` KULLANILMAZ: sunucuda foundry kurulu degil, ve selector'i sabit
 * yazmak onu kimsenin bir daha dogrulamayacagi bir sayi haline getirirdi.
 * `viem` zaten bir bagimlilik ve selector'i ABI'den KENDISI turetir.
 */
import { Pool } from 'pg'
import { createPublicClient, http } from 'viem'

const ESCROW_ABI = [
  {
    type: 'function',
    name: 'owed',
    stateMutability: 'view',
    inputs: [{ name: 'recipient', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

function required(key: string): string {
  const value = process.env[key]
  if (value === undefined || value === '') throw new Error(`${key} ayarli degil`)
  return value
}

const escrow = required('ARC_ESCROW_ADDRESS') as `0x${string}`
const pool = new Pool({ connectionString: required('DATABASE_URL') })
const client = createPublicClient({ transport: http(required('ARC_RPC_URL')) })

async function chainOwed(recipient: string, block: bigint): Promise<bigint> {
  return client.readContract({
    address: escrow,
    abi: ESCROW_ABI,
    functionName: 'owed',
    args: [recipient as `0x${string}`],
    blockNumber: block,
  })
}

async function ledgerOwed(recipient: string, block: bigint): Promise<bigint> {
  const { rows } = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount_wei ELSE -amount_wei END), 0)::text AS net
       FROM fee_events
      WHERE recipient = $1 AND block_number <= $2`,
    [recipient, block.toString()],
  )
  return BigInt(rows[0].net)
}

async function main(): Promise<number> {
  const selfTest = process.argv.includes('--self-test')
  const head = await client.getBlockNumber()

  if (selfTest) {
    console.log('=== POZITIF KONTROL: ayrismasi GEREKEN bir karsilastirma ===')
    const { rows } = await pool.query<{ recipient: string; block_number: string }>(
      'SELECT recipient, block_number FROM fee_events ORDER BY event_seq DESC LIMIT 1',
    )
    if (rows.length === 0) {
      console.error('HATA: `fee_events` BOS -- pozitif kontrol kosulamaz, yani')
      console.error('bu kosunun yesili hicbir sey kanitlamaz.')
      return 1
    }
    const { recipient, block_number } = rows[0]
    const before = BigInt(block_number) - 1n
    const ledger = await ledgerOwed(recipient, before)
    const chain = await chainOwed(recipient, head)
    console.log(`  alici          : ${recipient}`)
    console.log(`  defter <= ${before} : ${ledger}`)
    console.log(`  zincir @ ${head} : ${chain}`)
    if (ledger === chain) {
      console.error('  KIRMIZI: son olaydan ONCEKI toplam, zincirin GUNCEL degerine esit.')
      console.error('  Karsilastirma farki GORMUYOR -- arac bozuk, dogrulama anlamsiz.')
      return 1
    }
    console.log('  OK: arac farki goruyor. Dogrulama anlamli.\n')
  }

  const { rows: firstRows } = await pool.query<{ first: string | null }>(
    'SELECT MIN(block_number)::text AS first FROM fee_events',
  )
  const first = firstRows[0].first
  if (first === null) {
    console.error('HATA: `fee_events` bos -- dogrulanacak bir sey yok.')
    return 1
  }

  // Sabit bir kontrol noktasi listesi zincir ilerledikce anlamini yitirirdi;
  // noktalar ilk olaydan head'e ESIT ARALIKLA turetilir.
  const env = process.env.CHECKPOINTS
  const checkpoints: bigint[] =
    env !== undefined && env !== ''
      ? env.trim().split(/\s+/).map(BigInt)
      : (() => {
          const lo = BigInt(first)
          const step = (head - lo) / 6n
          return step <= 0n
            ? [head]
            : [lo + step, lo + 2n * step, lo + 3n * step, lo + 4n * step, lo + 5n * step, head]
        })()

  const { rows: recipients } = await pool.query<{ recipient: string }>(
    'SELECT DISTINCT recipient FROM fee_events ORDER BY 1',
  )

  let failed = false
  for (const { recipient } of recipients) {
    for (const block of checkpoints) {
      const ledger = await ledgerOwed(recipient, block)
      let chain: bigint
      try {
        chain = await chainOwed(recipient, block)
      } catch (error) {
        // SORULAMAYAN BIR NOKTA YESIL DEGILDIR. Uc cevap vermediyse o kontrol
        // noktasi DOGRULANMAMISTIR, ve dogrulanmamis bir noktayi gecmis saymak
        // tam olarak bu betigin bulmak icin yazildigi sinif olurdu.
        console.log(`SORULAMADI ${recipient} @ ${block} -- ${(error as Error).message.split('\n')[0]}`)
        failed = true
        continue
      }
      if (ledger === chain) {
        console.log(`esit       ${recipient} @ ${block}  ${chain}`)
      } else {
        console.log(`AYRISMA    ${recipient} @ ${block}  defter=${ledger}  zincir=${chain}`)
        failed = true
      }
    }
  }

  if (failed) {
    console.error('\nDEFTER ZINCIRLE UYUSMUYOR. Ayrismanin ILK gorundugu blok ile bir onceki')
    console.error('esit blok arasinda ikili arama yapin; kayip o penceredededir.')
    return 1
  }
  console.log('\nButun kontrol noktalari esit.')
  return 0
}

main()
  .then(async (code) => {
    await pool.end()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error(error)
    await pool.end()
    process.exit(1)
  })
