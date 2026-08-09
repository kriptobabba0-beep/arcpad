import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env as processEnv, exit } from 'node:process'
import { createArcClient } from '@arcpad/shared'
import {
  type Address,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { viemChainReader } from '../../src/chainReader'
import { viemGraduationWriter } from '../../src/graduate/chain'
import { type CurveOutcome, runGraduationPass } from '../../src/graduate/executor'
import { fileCurveLocks } from '../../src/graduate/lock'
import { classifyRevert } from '../../src/graduate/outcome'
import { memoryQuarantineStore } from '../../src/graduate/state'
import { fileCursorStore } from '../../src/watch/graduationWindow'

/**
 * ============ YEREL ZINCIR KANITI ============
 *
 * `pnpm --filter @arcpad/keeper graduate:localchain-proof`
 *
 * NE OLCER, VE NEDEN BIRIM TESTLERI YETMEZ. Birim testleri kesif, kilit,
 * karantina ve siniflandirmayi sahte bir zincire karsi olcer. OLCEMEDIKLERI
 * sey YAZMA YOLUDUR: viem'in islemi kurmasi, imzalamasi, gondermesi, makbuzu
 * beklemesi, ve -- en onemlisi -- makbuzun ARDINDAN `graduated()`i GERI
 * OKUMASI. Bu depoda ciddi olan her kusur BIR SEY CALISTIRARAK bulundu.
 *
 * NASIL: `anvil --fork-url <Arc testnet>`. Fork YEREL bir EVM'e UZAK durumu
 * verir; uretim fabrikasina, disposable fabrikaya ya da herhangi bir zincire
 * TEK BIR ISLEM bile yayinlanmaz.
 *
 * ============ FORK'UN SAGLAYAMADIGI TEK SEY, VE KONTROL GRUBU ============
 *
 * `ArcpadLocker.graduate` son adiminda havuzun quote bacagini CANLI USDC
 * (`0x3600...`) ile oder. O kontrat Arc'in `0x1800...` native-varlik
 * precompile'ina iner; precompile'in zincirdeki kodu TEK BAYTTIR (`0x01`) ve
 * gercek davranis DUGUMDEDIR. revm o bayti `ADD` olarak calistirir ve cagri
 * duser.
 *
 * OLCULDU, VARSAYILMADI (bu betigin ADIM 2'si, ve ayni sey elle de goruldu):
 *   anvil fork, gercek locker, tamamlanmis curve
 *     -> 0x1425ea42  FailedInnerCall()   (OZ `Address`, USDC'nin icinden)
 *
 * Yani fork'ta GERCEK locker calisamaz. Bu yuzden ADIM 3 locker adresine
 * MINIMAL bir stand-in yerlestirir: yaptigi tek sey `curve.graduate()`
 * cagirmak ve odemeyi kabul etmektir.
 *
 * BU IKAME NEDEN MESRU: degistirilen bagimlilik BAGIMSIZ OLARAK KAPSANMIS
 * durumda -- `contracts/test/fork/GraduationCycle.live.fork.t.sol` locker'in
 * havuz adimini CANLI `PoolManager` ve CANLI USDC ile 8/8 olcuyor. Burada
 * olculen sey KEEPER'in yolu: kesif -> simulasyon -> yayin -> makbuz -> geri
 * okuma. Sahte, test edilen kodun isini YAPMIYOR; test edilen kodun ALTINDAKI
 * ve baska yerde olculen bir katmani, fork'un tasiyamadigi icin ikame ediyor.
 * Ve ADIM 2 o ikamenin GEREKLI oldugunu kanitlar -- kontrol grubu olmadan
 * "zararsiz" ile "gerekli" ayirt edilemezdi.
 *
 * ============ STAND-IN'IN BYTECODE'U ============
 *
 * Solidity YOK, `forge` YOK -- bu gorev `contracts/`e dokunmaz ve derleyici
 * calistirmaz. 36 baytlik runtime, elle yazildi:
 *
 *   0x00  63 d3618cca   PUSH4 graduate()      selector
 *   0x05  60 e0         PUSH1 0xe0
 *   0x07  1b            SHL                   -> sola hizala
 *   0x08  60 00         PUSH1 0x00
 *   0x0a  52            MSTORE                mem[0..4] = selector
 *   0x0b  60 00         PUSH1 0x00            retSize
 *   0x0d  60 00         PUSH1 0x00            retOffset
 *   0x0f  60 04         PUSH1 0x04            argsSize
 *   0x11  60 00         PUSH1 0x00            argsOffset
 *   0x13  60 00         PUSH1 0x00            value
 *   0x15  60 04 35      PUSH1 0x04 CALLDATALOAD   -> graduate(address) argumani
 *   0x18  5a            GAS
 *   0x19  f1            CALL
 *   0x1a  60 22         PUSH1 0x22
 *   0x1c  57            JUMPI                 basariliysa STOP'a
 *   0x1d  60 00 60 00 fd  REVERT
 *   0x22  5b 00         JUMPDEST STOP
 *
 * Bos calldata ile cagrildiginda (curve'un `target.call{value:R}("")` odeme
 * bacagi) `CALLDATALOAD(4)` sifirdir, yani `address(0)`a bos bir cagri yapar,
 * basarir ve STOP eder: odeme KABUL EDILIR. `receive()`in ciplak olmasi
 * gerektigi kurali burada da korunur.
 */
const LOCKER_STANDIN_RUNTIME =
  '0x63d3618cca60e01b600052600060006004600060006004355af160225760006000fd5b00' as Hex

// ---------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------

const ARC_RPC = processEnv['ARC_RPC_URL'] ?? 'https://rpc.testnet.arc.network'
const REQUESTED_PORT = Number(processEnv['KEEPER_PROOF_PORT'] ?? 58_547)
const FORK_BLOCK = BigInt(processEnv['KEEPER_PROOF_FORK_BLOCK'] ?? 56_029_795)

/** Uretim yigini -- defterden, ve BU BETIK ONA HIC YAZMAZ. */
const PROD_FACTORY = '0x5CA156f1809aB784655410d0f4B0704d2b306B47' as Address
const PROD_LOCKER = '0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8' as Address
const PROD_START_BLOCK = 55_870_261n

/** Disposable yigin -- `HANDOFF-2026-08-09.md`, silahlanma penceresi acik. */
const DISPOSABLE_FACTORY = '0xfE11Db901168B0B0f7474b72a2e39b3d805b4849' as Address
const DISPOSABLE_LOCKER = '0x1AfD2eF32C445FAdC95f05Ed237ed4C9dAE9d33F' as Address
const DISPOSABLE_ETA = 1_786_489_311n

/** Satis arzi -- `addresses.5042002.json`. */
const SALE_SUPPLY = 793_100_000_000_000_000_000_000_000n

/** anvil'in ilk gelistirici hesabi. Yalnizca YEREL fork'ta gecerlidir. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex

const FACTORY_WRITE_ABI = parseAbi([
  'function applyGraduationTarget()',
  'function launch(string name, string symbol, string uri) returns (address, address)',
])
const CURVE_WRITE_ABI = parseAbi([
  'function buyExactTokensOut(uint256 tokensOut, uint256 maxQuoteIn) payable',
  'function complete() view returns (bool)',
  'function graduated() view returns (bool)',
])

// ---------------------------------------------------------------
// Kucuk bir iddia catisi -- vitest YOK, cunku bu betik anvil'i KENDISI
// baslatir ve tek bir komutla kosulabilir olmalidir.
// ---------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
    return
  }
  failures.push(label)
  console.error(`  FAIL  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
}

async function main(): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), 'arcpad-graduation-proof-'))
  let anvil: ChildProcess | undefined

  try {
    console.log(`[1] forking Arc at block ${FORK_BLOCK} on 127.0.0.1:${REQUESTED_PORT}`)
    anvil = await startAnvil(REQUESTED_PORT)

    const rpcUrl = `http://127.0.0.1:${REQUESTED_PORT}`
    const client = createArcClient(rpcUrl)
    const reader = viemChainReader(client)

    // ============ ISTEDIGIM PORT, ALDIGIM PORT MU ============
    // AGENT-CONTEXT'in Postgres dersi: bir baska surece baglanip onun
    // durumunu degistirmek, bu depoda BIR KEZ gerceklesti.
    const chainId = await client.getChainId()
    check('the fork answers on the port that was asked for', chainId === 5_042_002, `chainId=${chainId}`)
    const forkHead = await client.getBlockNumber()
    check('the fork is pinned to the requested block', forkHead === FORK_BLOCK, `head=${forkHead}`)

    const wallet = createWalletClient({
      account: privateKeyToAccount(DEV_KEY),
      chain: client.chain,
      transport: http(rpcUrl),
    })

    // ---------------------------------------------------------------
    // ADIM 1 -- URETIM SEKLI: HEDEF SIFIR, BEKLEYEN CURVE VAR, SIFIR SAYFA
    // ---------------------------------------------------------------
    console.log('[2] production shape: graduationTarget == 0x0 with a completed curve waiting')
    {
      const emitted: { level: string; message: string }[] = []
      const summary = await runGraduationPass({
        client: reader,
        writer: viemGraduationWriter({
          client,
          rpcUrl,
          locker: PROD_LOCKER,
          caller: wallet.account.address,
        }),
        factory: PROD_FACTORY,
        locker: PROD_LOCKER,
        startBlock: PROD_START_BLOCK,
        store: fileCursorStore(join(scratch, 'prod.cursor'), {
          chainId: 5_042_002,
          factory: PROD_FACTORY,
          startBlock: PROD_START_BLOCK,
        }),
        quarantine: memoryQuarantineStore(),
        locks: fileCurveLocks(join(scratch, 'locks-prod'), 'proof'),
        dryRun: true,
        maxChunksPerPoll: 40,
        alert: (level, _key, message) => emitted.push({ level, message }),
      })

      check('the production factory reads graduationTarget 0x0', summary.target === '0x0000000000000000000000000000000000000000')
      check('the completed smoke curve IS in the pending set', summary.pending.length >= 1, `pending=${summary.pending.length} raise=${summary.pendingQuoteWei}`)
      check(
        'NOTHING pages while the platform has not armed its target',
        emitted.every((e) => e.level !== 'page'),
        emitted.map((e) => e.level).join(','),
      )
      check(
        'the backlog is still reported by name',
        emitted.some((e) => e.message.includes('graduation-waiting-for-target')),
      )

      // ============ GERCEK REVERT -> GERCEK VIEM -> GERCEK SINIFLANDIRICI ============
      //
      // Yurutucu silahlanmamis bir fabrikada CAGRI YAPMAZ (dogrusu budur), o
      // yuzden `0xfe30fa5b` yolunu bu satirlar ACIKCA yurutur. Birim testi
      // dort bayti pinler; BURASI o dort baytin gercekten bir Arc dugumunden,
      // viem'in hata sarmalayicilarindan gecerek siniflandiriciya vardigini
      // gosterir -- yani zincir ile karar arasindaki BUTUN yol.
      const simulation = await viemGraduationWriter({
        client,
        rpcUrl,
        locker: PROD_LOCKER,
        caller: wallet.account.address,
      }).simulate(summary.pending[0]?.curve ?? PROD_LOCKER, summary.head)
      check(
        'a real GraduationTargetUnset revert survives viem and reaches the classifier',
        !simulation.ok && simulation.revertData === '0xfe30fa5b',
        simulation.ok ? 'simulation succeeded' : String(simulation.revertData),
      )
      const classified = classifyRevert(simulation.ok ? null : simulation.revertData)
      check(
        '...and it is classified as target-unset, which CANNOT page',
        classified.code === 'target-unset' && !classified.pageable,
        `${classified.code} pageable=${String(classified.pageable)}`,
      )
    }

    // ---------------------------------------------------------------
    // ADIM 2 -- DISPOSABLE YIGINI SILAHLA, BIR CURVE TAMAMLA
    // ---------------------------------------------------------------
    console.log('[3] arming the disposable factory on the fork and completing a curve')
    await rpc(rpcUrl, 'evm_setNextBlockTimestamp', [Number(DISPOSABLE_ETA) + 90])
    await rpc(rpcUrl, 'evm_mine', [])
    await send(wallet, client, {
      to: DISPOSABLE_FACTORY,
      data: encodeFunctionData({ abi: FACTORY_WRITE_ABI, functionName: 'applyGraduationTarget' }),
    })
    const armedTarget = await client.readContract({
      address: DISPOSABLE_FACTORY,
      abi: parseAbi(['function graduationTarget() view returns (address)']),
      functionName: 'graduationTarget',
    })
    check('applyGraduationTarget is permissionless and landed', armedTarget === DISPOSABLE_LOCKER, armedTarget)

    const startBlock = await client.getBlockNumber()
    const curve = await launchAndBuyOut(wallet, client, 'KPRPROOF1')
    check(
      'the fixture curve is complete and NOT graduated',
      (await curveFlag(client, curve, 'complete')) && !(await curveFlag(client, curve, 'graduated')),
      curve,
    )

    const cursorPath = join(scratch, 'disposable.cursor')
    const makePass = async (opts: {
      dryRun: boolean
      lockOwner?: string
      lockDir?: string
    }): Promise<{ outcomes: CurveOutcome[]; pages: string[]; pending: number }> => {
      const pages: string[] = []
      const summary = await runGraduationPass({
        client: reader,
        writer: viemGraduationWriter({
          client,
          rpcUrl,
          locker: DISPOSABLE_LOCKER,
          account: opts.dryRun ? undefined : privateKeyToAccount(DEV_KEY),
          caller: wallet.account.address,
        }),
        factory: DISPOSABLE_FACTORY,
        locker: DISPOSABLE_LOCKER,
        startBlock,
        store: fileCursorStore(cursorPath, {
          chainId: 5_042_002,
          factory: DISPOSABLE_FACTORY,
          startBlock,
        }),
        quarantine: memoryQuarantineStore(),
        locks: fileCurveLocks(opts.lockDir ?? join(scratch, 'locks'), opts.lockOwner ?? 'proof'),
        dryRun: opts.dryRun,
        maxChunksPerPoll: 40,
        alert: (level, _key, message) => {
          if (level === 'page') pages.push(message)
        },
      })
      return { outcomes: summary.outcomes, pages, pending: summary.pending.length }
    }

    // ---------------------------------------------------------------
    // ADIM 3 -- KONTROL GRUBU: GERCEK LOCKER FORK'TA CALISAMAZ
    // ---------------------------------------------------------------
    console.log('[4] control: the REAL locker against the fork')
    {
      const result = await makePass({ dryRun: true })
      const outcome = result.outcomes[0]
      check(
        'the real ArcpadLocker CANNOT run on a fork (Arc 0x1800 precompile)',
        outcome?.code === 'unknown-revert',
        `${outcome?.code} ${outcome?.detail.slice(0, 120)}`,
      )
      check('...and that is loud, not silent', result.pages.length === 1)
    }

    // ---------------------------------------------------------------
    // ADIM 4 -- STAND-IN, SONRA KURU KOSU
    // ---------------------------------------------------------------
    console.log('[5] substituting the locker with the minimal stand-in')
    await rpc(rpcUrl, 'anvil_setCode', [DISPOSABLE_LOCKER, LOCKER_STANDIN_RUNTIME])
    {
      const result = await makePass({ dryRun: true })
      check(
        'dry run SIMULATES GREEN and broadcasts nothing',
        result.outcomes[0]?.code === 'would-graduate',
        result.outcomes[0]?.code,
      )
      check(
        'the curve is still not graduated after a dry run',
        !(await curveFlag(client, curve, 'graduated')),
      )
      check('a dry run pages about nothing', result.pages.length === 0)
    }

    // ---------------------------------------------------------------
    // ADIM 5 -- GERCEK YAYIN
    // ---------------------------------------------------------------
    console.log('[6] broadcasting for real against the local chain')
    {
      const result = await makePass({ dryRun: false })
      const outcome = result.outcomes[0]
      check(
        'the executor BROADCAST and the curve graduated',
        outcome?.code === 'graduated',
        `${outcome?.code} tx=${outcome?.transactionHash ?? '(none)'} gas=${outcome?.gasUsed ?? '?'}`,
      )
      check(
        'graduated() reads TRUE on chain -- the receipt was not taken on trust',
        await curveFlag(client, curve, 'graduated'),
      )
      check('a successful graduation pages about nothing', result.pages.length === 0)
    }

    // ---------------------------------------------------------------
    // ADIM 6 -- IDEMPOTENSLIK
    // ---------------------------------------------------------------
    console.log('[7] second pass over the same curve')
    {
      const result = await makePass({ dryRun: false })
      check(
        'a graduated curve leaves the pending set entirely',
        result.pending === 0 && result.outcomes.length === 0,
        `pending=${result.pending} outcomes=${result.outcomes.length}`,
      )
      check('nothing pages', result.pages.length === 0)
    }

    // ---------------------------------------------------------------
    // ADIM 7 -- YARIS: BASKASI ONCE MEZUN EDERSE
    // ---------------------------------------------------------------
    console.log('[8] race: a third party graduates first')
    {
      const second = await launchAndBuyOut(wallet, client, 'KPRPROOF2')
      // "Baskasi" tam olarak ayni izinsiz cagriyi yapar.
      await send(wallet, client, {
        to: DISPOSABLE_LOCKER,
        data: encodeFunctionData({
          abi: parseAbi(['function graduate(address curve)']),
          functionName: 'graduate',
          args: [second],
        }),
      })
      check('the third party won', await curveFlag(client, second, 'graduated'), second)
      const result = await makePass({ dryRun: false })
      check(
        'the keeper spends no gas and pages about nothing',
        result.pages.length === 0 && result.outcomes.every((o) => o.transactionHash === undefined),
      )
    }

    // ---------------------------------------------------------------
    // ADIM 8 -- KILIT
    // ---------------------------------------------------------------
    console.log('[9] two executors, one curve')
    {
      const third = await launchAndBuyOut(wallet, client, 'KPRPROOF3')
      const sharedLocks = join(scratch, 'shared-locks')
      const holder = fileCurveLocks(sharedLocks, 'executor-A')
      holder.acquire(third, Date.now())
      const result = await makePass({ dryRun: false, lockDir: sharedLocks, lockOwner: 'executor-B' })
      const outcome = result.outcomes.find((o) => o.curve.toLowerCase() === third.toLowerCase())
      check(
        'the second executor does not touch a curve the first holds',
        outcome?.code === 'locked-elsewhere',
        outcome?.code,
      )
      check('...and the curve is still not graduated', !(await curveFlag(client, third, 'graduated')))
    }
  } finally {
    if (anvil !== undefined) await stopAnvil(anvil)
    rmSync(scratch, { recursive: true, force: true })
  }

  console.log('')
  console.log(`GRADUATION LOCALCHAIN PROOF: ${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  return failures.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------
// Yardimcilar
// ---------------------------------------------------------------

async function launchAndBuyOut(
  wallet: ReturnType<typeof createWalletClient>,
  client: ReturnType<typeof createArcClient>,
  name: string,
): Promise<Address> {
  const receipt = await send(wallet, client, {
    to: DISPOSABLE_FACTORY,
    data: encodeFunctionData({
      abi: FACTORY_WRITE_ABI,
      functionName: 'launch',
      args: [name, 'KPR', 'ipfs://x'],
    }),
  })
  // `Launched(token, curve, creator, ...)` -- ikinci indexed alan curve'dur.
  const launched = receipt.logs.find(
    (log) => log.address.toLowerCase() === DISPOSABLE_FACTORY.toLowerCase() && log.topics.length >= 4,
  )
  if (launched === undefined) throw new Error('no Launched log in the launch receipt')
  const curve = `0x${(launched.topics[2] as string).slice(26)}` as Address

  await send(wallet, client, {
    to: curve,
    data: encodeFunctionData({
      abi: CURVE_WRITE_ABI,
      functionName: 'buyExactTokensOut',
      args: [SALE_SUPPLY, 2n ** 256n - 1n],
    }),
    value: 50_000_000_000_000_000_000n,
  })
  return curve
}

function curveFlag(
  client: ReturnType<typeof createArcClient>,
  curve: Address,
  fn: 'complete' | 'graduated',
): Promise<boolean> {
  return client.readContract({ address: curve, abi: CURVE_WRITE_ABI, functionName: fn })
}

async function send(
  wallet: ReturnType<typeof createWalletClient>,
  client: ReturnType<typeof createArcClient>,
  tx: { to: Address; data: Hex; value?: bigint },
): Promise<{ logs: { address: string; topics: readonly string[] }[] }> {
  const hash = await wallet.sendTransaction({
    account: wallet.account as never,
    chain: client.chain,
    to: tx.to,
    data: tx.data,
    ...(tx.value === undefined ? {} : { value: tx.value }),
  })
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`setup transaction reverted: ${hash}`)
  return receipt as unknown as { logs: { address: string; topics: readonly string[] }[] }
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { message: string } }
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/**
 * ============ ISTEDIGIM PORT, BOS MU ============
 *
 * BU KONTROL BIR OLCUMDEN SONRA EKLENDI, tedbir olarak degil. Ilk kosuda bu
 * betigin `anvil`i porta baglanamadi (`os error 10048`) cunku BIR ONCEKI
 * kosunun anvil'i hayattaydi; hazir-olma sondasi ise porta cevap veren HERHANGI
 * bir sunucuyu "benim anvil'im" sandi ve betik BASKA BIR SURECIN zincirine
 * yazmaya basladi. Fork blogu iddiasi onu yakaladi (`head=56029805`), ama
 * yakalayan sey sansa kalmamalidir.
 *
 * Bu, AGENT-CONTEXT'in Postgres dersinin ta kendisi: bir track'in `initdb`i
 * porta baglanamadi, `psql` sessizce BASKA bir cluster'a baglandi ve bir e2e
 * kosusu baskasinin veritabanini TRUNCATE etti.
 */
async function assertPortIsFree(port: number): Promise<void> {
  try {
    await rpc(`http://127.0.0.1:${port}`, 'eth_chainId', [])
  } catch {
    return
  }
  throw new Error(
    `something is ALREADY listening on 127.0.0.1:${port} and answering JSON-RPC. This script refuses to reuse it: a leftover node carries another run's state, and the last time this happened the run silently drove someone else's chain. Stop it (Windows: taskkill /F /IM anvil.exe) or set KEEPER_PROOF_PORT.`,
  )
}

/**
 * `shell: false`, VE BU DA OLCULDU. `shell: true` ile Windows'ta `spawn` bir
 * `cmd.exe` acar ve `anvil`i ONUN altinda calistirir; `child.kill()` yalnizca
 * kabugu oldurur ve anvil YETIM KALIR -- bir sonraki kosunun portunu tutan sey
 * tam olarak buydu. Ikili adiyla cagrilinca `kill` gercek sureci bulur.
 */
function anvilBinary(): string {
  return process.platform === 'win32' ? 'anvil.exe' : 'anvil'
}

async function startAnvil(port: number): Promise<ChildProcess> {
  await assertPortIsFree(port)
  const child = spawn(
    anvilBinary(),
    [
      '--fork-url',
      ARC_RPC,
      '--fork-block-number',
      String(FORK_BLOCK),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let fatal: string | undefined
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text === '') return
    console.error(`  [anvil] ${text}`)
    if (/os error 10048|address( already)? in use/i.test(text)) fatal = text
  })

  const deadline = Date.now() + 120_000
  for (;;) {
    if (fatal !== undefined) throw new Error(`anvil could not bind port ${port}: ${fatal}`)
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`)
    try {
      await rpc(`http://127.0.0.1:${port}`, 'eth_chainId', [])
      return child
    } catch {
      if (Date.now() > deadline) throw new Error(`anvil did not come up on port ${port}`)
      await new Promise((done) => setTimeout(done, 400))
    }
  }
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
  // WINDOWS SIGORTASI. `SIGTERM` burada gercek bir sinyal degildir; surec agaci
  // hayatta kalabilir ve HAYATTA KALDIGI OLCULDU.
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }
}

main()
  .then((code) => {
    process.exitCode = code
    setTimeout(() => exit(code), 5_000).unref()
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
    setTimeout(() => exit(1), 5_000).unref()
  })
