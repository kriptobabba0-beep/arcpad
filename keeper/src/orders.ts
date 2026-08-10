import { argv, env as processEnv, exit } from 'node:process'
import {
  createPool,
  expireDueOrders,
  listLiveOrders,
  markTriggered,
  type Pool,
} from '@arcpad/db'
import {
  assertArcChain,
  type CurveProfile,
  createArcClient,
  loadAddressBook,
} from '@arcpad/shared'
import {
  alert,
  type AlertSink,
  consoleSinkFor,
  createThrottle,
  fileSink,
  heartbeat,
  multiSink,
} from './alert'
import { viemChainReader } from './chainReader'
import { loadRepoEnv } from './env'
import { runPollLoop } from './graduate/loop'
import { type OrderStore, type PassOrder, runOrderPass } from './orders/pass'
import { fitsPoll } from './orders/scan'
import type { CurveConstants } from './orders/pass'

/**
 * ============ EMIR YURUTUCUSU -- GIRIS NOKTASI ============
 *
 * `pnpm --filter @arcpad/keeper orders -- --once`
 *
 * ==========================================================================
 *  BU SUREC HICBIR SEY YAYINLAMAZ, VE ADI ONU SOYLEMELI
 * ==========================================================================
 *
 * "Yurutucu" (executor) sozcugu graduation tarafinda BIR ISLEM GONDERMEK
 * demek. Burada demiyor, ve sebebi bir tercih degil bir OLCUM:
 * `test/localchain/custodyProof.ts` canli kontratlara karsi (Arc fork'u,
 * 21/21) bir ucuncu tarafin bir kullanicinin fonuyla o kullanici adina islem
 * yapamayacagini gosterdi. Kontratlar donduruldugu icin de bunun bir caresi
 * YOK. Dolayisiyla bu surecin urunu iki veritabani gecisidir: TETIKLEME ve
 * SURE ASIMI. Doldurma islemi sahibin cuzdanindan cikar.
 *
 * BUNUN BIR SONUCU DA SUDUR: BU SUREC BIR ANAHTAR TASIMAZ. `graduate.ts`
 * sifreli bir keystore ister; burada imzalanacak hicbir sey yok, yani
 * `KEEPER_PRIVATE_KEY` OKUNMAZ ve okunmamalidir. Islem gondermeyen bir
 * surecin anahtara erisimi, yalnizca calinabilecek bir anahtar demektir.
 *
 * ==========================================================================
 *  NEDEN `graduate.ts`IN ICINE KONMADI
 * ==========================================================================
 *
 * `graduate.ts`in kendi dosya basligi ayrilmanin uc gerekcesini yaziyor
 * (izleyicinin salt-okur olmasi, ayri imlec dosyalari, ayri alarm bileseni).
 * Buraya bir dorduncusu ekleniyor ve en agiri o: **graduation surecinin bir
 * ANAHTARI VAR.** Emir taramasini onun icine koymak, anahtar tasiyan bir
 * surece bir Postgres baglantisi ve kullanici-yazili satirlarin okunmasini
 * eklerdi. Iki sorumlulugun ayri kalmasi, ikisinden birinin arizasinin
 * otekini tasimamasi demek.
 */

const COMPONENT = 'keeper.orders'
const DEFAULT_POLL_MS = 15_000

type OrdersConfig = {
  readonly databaseUrl: string
  readonly rpcUrl: string
  readonly pollIntervalMs: number
  readonly once: boolean
  readonly maxOrdersPerPass: number | undefined
  readonly alertLog: string | undefined
}

export function loadOrdersConfig(
  env: Record<string, string | undefined>,
  opts: { once: boolean },
): OrdersConfig {
  const databaseUrl = blank(env['DATABASE_URL'])
  if (databaseUrl === undefined) {
    // ATLAMAK YOK. Emirsiz bir emir yurutucusu "saglikli" gorunur ve HICBIR
    // SEY yapmaz -- bu depoda tam olarak boyle bir surec 13 saniyede olup
    // cikis kodu 0 dondurmustu.
    throw new Error('DATABASE_URL is required: the order pass reads and writes `limit_orders`.')
  }
  const rpcUrl = blank(env['ARC_RPC_URL'])
  if (rpcUrl === undefined) throw new Error('ARC_RPC_URL is required.')

  const rawPoll = blank(env['KEEPER_ORDERS_POLL_MS'])
  const pollIntervalMs = rawPoll === undefined ? DEFAULT_POLL_MS : Number(rawPoll)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`KEEPER_ORDERS_POLL_MS must be a positive integer, got "${rawPoll ?? ''}"`)
  }
  const rawCap = blank(env['KEEPER_ORDERS_PER_PASS'])
  const maxOrdersPerPass = rawCap === undefined ? undefined : Number(rawCap)
  if (maxOrdersPerPass !== undefined && (!Number.isInteger(maxOrdersPerPass) || maxOrdersPerPass <= 0)) {
    throw new Error(`KEEPER_ORDERS_PER_PASS must be a positive integer, got "${rawCap ?? ''}"`)
  }
  return {
    databaseUrl,
    rpcUrl,
    pollIntervalMs,
    once: opts.once,
    maxOrdersPerPass,
    alertLog: blank(env['KEEPER_ALERT_LOG']),
  }
}

function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

/**
 * VERITABANI PORTUNUN GERCEK UYGULAMASI.
 *
 * `@arcpad/db`nin satirini `PassOrder`a DARALTIR ve daraltma BURADA yapilir --
 * gecis kodunun icinde degil. Gecis, emrin imzasini, nonce'unu ya da
 * `created_at`ini GORMEZ; gormedigi bir alani yanlislikla bir karara
 * katamaz.
 */
export function pgOrderStore(pool: Pool, alertFn: (message: string) => void): OrderStore {
  return {
    listLive: async (limit: number): Promise<readonly PassOrder[]> => {
      const rows = await listLiveOrders(pool, { limit })
      return rows.map((row) => ({
        orderSeq: row.orderSeq,
        token: row.token,
        ownerAddr: row.ownerAddr,
        isBuy: row.isBuy,
        amount: row.amount,
        minOut: row.minOut,
        expiresAt: row.expiresAt,
        // `listLiveOrders` YALNIZCA bu ikisini dondurur; baska bir durum
        // gelirse tip daralmasi degil, GURULTULU bir hata olmali.
        status: assertLive(row.status, row.orderSeq),
      }))
    },
    markTriggered: async (orderSeq: bigint, blockNumber: bigint): Promise<boolean> => {
      const result = await markTriggered(pool, orderSeq, blockNumber)
      if (!result.changed) {
        // KAYBEDILEN YARIS SESSIZ OLAMAZ: kullanici tam o anda iptal etmis
        // olabilir ve bu OLAGAN bir sonuctur -- ama gorunmez olmasi, gercek
        // bir kilit sorununu da gorunmez yapardi.
        alertFn(`orders-trigger-no-op seq=${orderSeq}`)
      }
      return result.changed
    },
    expireDue: (asOf: Date) => expireDueOrders(pool, asOf),
  }
}

function assertLive(status: string, orderSeq: bigint): 'open' | 'triggered' {
  if (status === 'open' || status === 'triggered') return status
  throw new Error(
    `limit_orders ${orderSeq}: listLiveOrders returned status "${status}", which is terminal. ` +
      'LIVE_STATUSES and the pass have drifted apart.',
  )
}

async function main(): Promise<number> {
  loadRepoEnv()
  const once = argv.includes('--once')
  const config = loadOrdersConfig(processEnv, { once })

  const sinks: AlertSink[] = [consoleSinkFor(COMPONENT)]
  if (config.alertLog !== undefined) sinks.push(fileSink(config.alertLog, { component: COMPONENT }))
  const sink = multiSink(...sinks)
  const throttle = createThrottle()
  /*
   * UC SEVIYE IKIYE INDIRILIR, VE HANGISININ `page` OLDUGU BURADA KARARA
   * BAGLANIR. `AlertLevel` yalnizca "uyandirir mi" sorusunu yanitlar
   * (`alert.ts`), ve BU SUREC KIMSEYI UYANDIRMAZ: emirler bir para akisini
   * durdurmaz, geciktirir. `warn`in `page` olmasi, uzun vadede olu-adam
   * anahtarini gurultuyle doldurup GERCEK sayfalari sagirlastirirdi.
   *
   * Anahtar bazli bastirma yine de uygulanir: her geciste tekrarlanan bir
   * uyari, on dakikada bir satira iner.
   */
  const emit = (level: 'info' | 'warn' | 'page', key: string, message: string): void => {
    if (!throttle.shouldEmit(key, Date.now())) return
    alert(level === 'page' ? 'page' : 'ok', message, sink)
  }

  const client = createArcClient(config.rpcUrl)
  // ZINCIR KIMLIGI ONCE. Yanlis zincire bagli bir emir taramasi, baska bir
  // agin rezervlerine gore emir tetiklerdi.
  await assertArcChain(client)
  const reader = viemChainReader(client)

  /*
   * DEFTER, ZINCIR KIMLIGINDEN. `chain.ts` disinda bir zincir sabiti YOKTUR
   * (dort ayri track bunu kendi kapisinin disindan kirdi); kimlik istemciden
   * OKUNUR, yani bu dosya bir sayi tasimaz.
   *
   * `KEEPER_ADDRESS_BOOK_DIR` bos DIZE olarak gelebilir (`.env.example` onu
   * boyle gonderiyor ve dotenv `''` verir) -- `??` onu yakalamaz ve
   * `loadAddressBook(id, '')` ciplak bir goreli yola doner. `config.ts` bunu
   * bir kez olcup duzeltmisti; ayni tuzagi ikinci kez kurmamak icin ayni
   * `blank` suzgeci burada da var.
   */
  const chainId = await client.getChainId()
  const bookDir = blank(processEnv['KEEPER_ADDRESS_BOOK_DIR'])
  const book = bookDir === undefined ? loadAddressBook(chainId) : loadAddressBook(chainId, bookDir)
  const profile: CurveProfile = {
    virtualTokenReserves: book.virtualTokenReserves,
    virtualQuoteReserves: book.virtualQuoteReserves,
    saleSupply: book.saleSupply,
  }

  const pool = createPool(config.databaseUrl)
  const store = pgOrderStore(pool, (message) => {
    emit('info', 'orders-trigger-no-op', message)
  })
  // ONBELLEK SUREC OMRU BOYUNCA YASAR ve gecise DISARIDAN verilir: `creator`,
  // `PROTOCOL_FEE_BPS` ve `CREATOR_FEE_BPS` zincirde immutable'dir
  // (`BondingCurve.sol:180`), yani her geciste yeniden okumak curve basina uc
  // alt cagriyi bedavaya harcamak olurdu.
  const constants = new Map<string, CurveConstants>()

  // TOKEN -> CURVE, `launches`tan, ve BIR KEZ. Bir emir token'a asilidir,
  // zincir okumalari curve'e.
  const curveCache = new Map<string, string | null>()
  const curveOf = async (token: string): Promise<string | null> => {
    const cached = curveCache.get(token)
    if (cached !== undefined) return cached
    const { rows } = await pool.query<{ curve: string }>(
      'SELECT curve FROM launches WHERE token = $1',
      [token.toLowerCase()],
    )
    const curve = rows[0]?.curve ?? null
    curveCache.set(token, curve)
    return curve
  }

  let stopped = false
  const stop = (): void => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const pass = async (): Promise<void> => {
    const summary = await runOrderPass({
      client: reader,
      store,
      curveOf,
      profile,
      constants,
      ...(config.maxOrdersPerPass === undefined ? {} : { maxOrdersPerPass: config.maxOrdersPerPass }),
      alert: emit,
    })
    const fit = fitsPoll(summary.cost, config.pollIntervalMs)
    heartbeat(
      sink,
      'current',
      `block=${summary.blockNumber} scanned=${summary.scanned} ` +
        `triggered=${summary.triggered.length} expired=${summary.expired.length} ` +
        `subcalls=${summary.cost.subcalls} rpc=${summary.cost.rpcObjects} ` +
        `est=${fit.estimatedMs}ms headroom=${fit.headroom.toFixed(1)}x`,
    )
    if (!fit.fits) {
      // BIR GECIS POLL ARALIGINDAN UZUNSA UST USTE BINMEZ (`runPollLoop`
      // kendini yeniden zamanlar), yalnizca SEYRELIR -- ama seyrelmesi
      // gorunmez olamaz: emirler gecikir ve kullanici bunu bir "dolmadi"
      // olarak yasar.
      emit('warn', 'orders-pass-over-budget', `orders-pass-over-budget est=${fit.estimatedMs}ms poll=${config.pollIntervalMs}ms`)
    }
    if (config.once) stopped = true
  }

  try {
    console.log(
      `orders keeper ready -- mode=${config.once ? 'once' : `loop@${config.pollIntervalMs}ms`} ` +
        'THIS PROCESS BROADCASTS NOTHING AND HOLDS NO KEY',
    )
    await runPollLoop({ pass, stopped: () => stopped, pollIntervalMs: config.pollIntervalMs })
    return 0
  } finally {
    await pool.end()
  }
}

// `import.meta.main` yerine argv kontrolu: bu dosya testlerden de import
// EDILEBILIR olmali (`loadOrdersConfig`, `pgOrderStore`), ve import edildiginde
// bir surec baslatmamali.
if (processEnv['VITEST'] === undefined) {
  main().then(
    (code) => exit(code),
    (error: unknown) => {
      console.error(error)
      exit(1)
    },
  )
}
