import { beforeEach, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { toFunctionSelector } from 'viem'
import { applyEvents } from '../src/apply'
import { createPacer, decodeAll, type RpcClient } from '../src/logs'
import { poolIdFor } from '../src/pool'
import { createHookResolver, loadWatchSet } from '../src/run'
import { constructedGraduatedLog, FakeNode, LIVE, liveDecodedEvents } from './fixtures'
import { LIVE_DEPLOYMENT, pool, resetSchema, seedDeployment } from './db'

/**
 * ============ HOOK ADRESI ZINCIRDEN OKUNUR, ENV'DEN DEGIL ============
 *
 * `config.ts` "env'den okunabilen tek adres FACTORY'dir" diye yaziyor ve
 * gerekcesi olculmustu: yanlis bir `V` market cap'i 1000 kat kaydirir ve
 * hicbir kontrol bunu goremez. Hook adresi AYNI SINIFTA, hatta daha sessiz:
 * `PoolId` bir hash oldugu icin yanlis bir hook hicbir hata uretmeden BASKA
 * bir kimlik verir ve o kimlik SONSUZA KADAR bos doner.
 */

const LOCKER = '0x0e7771091a3471dc12cbfe38836badc7bf5a98e8' as Address
const HOOK = '0xd95198cd806b736c8ececffc23976b59f565e0cc' as Address
const POOL_MANAGER = '0x617321a877e024c870516cd599a581dcdca6c09b' as Address
const DEAD = '0x000000000000000000000000000000000000dead' as Address

const HOOK_SELECTOR = toFunctionSelector('hook()')
const POOL_MANAGER_SELECTOR = toFunctionSelector('poolManager()')

const word = (address: Address): Hex => `0x${address.slice(2).padStart(64, '0')}`

/**
 * `eth_call`lari SAYAN ve cevaplayan bir dugum. `FakeNode` yalnizca
 * `eth_getLogs`/`eth_getBlockByNumber` bilir; burada olculen sey CAGRI SAYISI
 * oldugu icin ayri bir sahte gerekiyor -- ve o sahte gercek kodun isini
 * YAPMIYOR: cozumleme, onbellekleme ve siniflandirma test edilen tarafta.
 */
class CallNode implements RpcClient {
  calls: { to: string; data: string }[] = []
  constructor(
    private readonly answers: Record<string, Hex | Error>,
    private readonly onCall?: () => void,
  ) {}
  async request(args: { method: string; params?: unknown }): Promise<unknown> {
    if (args.method !== 'eth_call') throw new Error(`beklenmeyen metod: ${args.method}`)
    const [call] = args.params as [{ to: string; data: string }]
    this.calls.push(call)
    this.onCall?.()
    const answer = this.answers[`${call.to.toLowerCase()}:${call.data}`]
    if (answer === undefined) return '0x'
    if (answer instanceof Error) throw answer
    return answer
  }
}

const lockerAnswers = (): Record<string, Hex> => ({
  [`${LOCKER}:${HOOK_SELECTOR}`]: word(HOOK),
  [`${LOCKER}:${POOL_MANAGER_SELECTOR}`]: word(POOL_MANAGER),
})

describe('graduation hedefinin havuz kablolamasi', () => {
  it('hook ve poolManager ZINCIRDEN okunur', async () => {
    const node = new CallNode(lockerAnswers())
    const resolve = createHookResolver(node, createPacer())
    expect(await resolve(LOCKER)).toEqual({ hook: HOOK, poolManager: POOL_MANAGER })
  })

  /**
   * ONBELLEK: MEZUNIYET BASINA IKI CAGRI, ARALIK BASINA SIFIR.
   *
   * `pacer`/`widthMemo` ile ayni omur, ayni gerekce. Onbelleksiz bir cozucu
   * her aralikta ayni iki `eth_call`i tekrar yapardi ve Arc'in siniri
   * JSON-RPC NESNESI sayar.
   */
  it('sonuc ONBELLEKLENIR -- ikinci cagri zincire GITMEZ', async () => {
    const node = new CallNode(lockerAnswers())
    const resolve = createHookResolver(node, createPacer())
    await resolve(LOCKER)
    await resolve(LOCKER)
    await resolve(LOCKER.toUpperCase() as Address)
    expect(node.calls).toHaveLength(2)
  })

  /**
   * HEDEF BIR LOCKER DEGILSE `null` -- VE BU ONBELLEKLENIR.
   * `0x…dEaD` kodsuzdur; `eth_call` `0x` doner.
   */
  it('locker olmayan bir hedef null doner ve o da onbelleklenir', async () => {
    const node = new CallNode({})
    const resolve = createHookResolver(node, createPacer())
    expect(await resolve(DEAD)).toBeNull()
    expect(await resolve(DEAD)).toBeNull()
    expect(node.calls).toHaveLength(1)
  })

  /**
   * ============ DUZELTMENIN ICINDEKI KUSUR, KAPATILDI ============
   *
   * Ilk yazim her hatayi `catch {}` ile `null`a ceviriyordu. O hal, TEK BIR
   * hiz siniri yanitinin havuz izlemesini SUREC OMRU BOYUNCA kapatmasi
   * demekti: `null` onbellege girer ve bir daha hic sorulmaz. Yani "gecici bir
   * seyi kalici saymak" -- `run.ts`in kendi yazili asimetrisi -- burada
   * SESSIZ bir veri kaybi olarak geri gelirdi.
   *
   * Bugun gecici hata YUKARI FIRLAR ve `runWithRetry` merdivenine girer.
   */
  it('GECICI bir hata YUTULMAZ ve onbellege girmez', async () => {
    const rateLimited = Object.assign(new Error('rate limit exceeded'), { code: -32005 })
    const node = new CallNode({ [`${LOCKER}:${HOOK_SELECTOR}`]: rateLimited })
    const resolve = createHookResolver(node, createPacer())
    await expect(resolve(LOCKER)).rejects.toThrow(/rate limit/)
    // VE ONBELLEK KIRLENMEDI: ikinci deneme zincire TEKRAR gider.
    const before = node.calls.length
    await expect(resolve(LOCKER)).rejects.toThrow(/rate limit/)
    expect(node.calls.length).toBeGreaterThan(before)
  })

  it('sifir adres donduren bir hedef locker sayilmaz', async () => {
    const node = new CallNode({
      [`${LOCKER}:${HOOK_SELECTOR}`]: `0x${'0'.repeat(64)}`,
      [`${LOCKER}:${POOL_MANAGER_SELECTOR}`]: word(POOL_MANAGER),
    })
    expect(await createHookResolver(node, createPacer())(LOCKER)).toBeNull()
  })
})

describe('izleme kumesi havuzlari VERITABANINDAN kurar', () => {
  beforeEach(async () => {
    await resetSchema()
    await seedDeployment()
    await applyEvents(pool, LIVE_DEPLOYMENT, await liveDecodedEvents())
  })

  it('MEZUN OLMAYAN bir curve icin havuz YOK -- ve hic cagri yapilmaz', async () => {
    const node = new CallNode(lockerAnswers())
    const watch = await loadWatchSet(pool, LIVE_DEPLOYMENT, createHookResolver(node, createPacer()))
    expect(watch.pools.size).toBe(0)
    expect(node.calls).toHaveLength(0)
    // Ama izleme kumesinin geri kalani BOZULMADI -- `LEFT JOIN` her launch'i
    // tasir, mezun olsun olmasin.
    expect(watch.curves.has(LIVE.curve)).toBe(true)
    expect(watch.tokens.has(LIVE.token)).toBe(true)
  })

  it('MEZUN bir curve icin havuz kimligi TURETILIR', async () => {
    const [graduated] = await decodeAll(
      new FakeNode([]),
      [
        constructedGraduatedLog({
          curve: LIVE.curve,
          token: LIVE.token,
          to: LOCKER,
          baseAmountTok: 1n,
          quoteAmountWei: 1n,
          block: 56_099_000n,
          logIndex: 0,
        }),
      ],
      56_099_000n,
      56_099_000n,
      createPacer(),
    )
    if (graduated?.kind !== 'graduated') throw new Error('graduated cozulmedi')
    await applyEvents(pool, LIVE_DEPLOYMENT, [graduated])

    const node = new CallNode(lockerAnswers())
    const watch = await loadWatchSet(pool, LIVE_DEPLOYMENT, createHookResolver(node, createPacer()))
    const id = poolIdFor(LIVE.token, HOOK)
    expect([...watch.pools.keys()]).toEqual([id])
    expect(watch.pools.get(id)).toMatchObject({
      token: LIVE.token,
      curve: LIVE.curve,
      target: LOCKER,
      hook: HOOK,
      poolManager: POOL_MANAGER,
      tokenIsCurrency0: true,
    })
  })

  /**
   * COZUCU VERILMEZSE HAVUZ KATMANI TAMAMEN KAPALIDIR. Bu, uretimin BUGUNKU
   * hali degil -- `index.ts` her zaman bir cozucu verir -- ama testlerin
   * cogunun kostugu hal, ve o hal de sifir maliyetli olmali.
   */
  it('cozucu YOKSA havuz kumesi bostur', async () => {
    const watch = await loadWatchSet(pool, LIVE_DEPLOYMENT)
    expect(watch.pools.size).toBe(0)
  })
})
