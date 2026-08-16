#!/usr/bin/env tsx
/**
 * ============================================================================
 *  CANLI DENETIM KAMPANYASI -- giris noktasi
 * ============================================================================
 *
 * !! GERCEK ISLEM GONDERIR VE PARA HARCAR (Arc testnet).
 *
 *   pnpm --filter @arcpad/scripts exec tsx audit/run.ts <faz> [<faz> ...]
 *
 * Fazlar BAGIMSIZ calisir ve tek tek secilebilir; bir kampanya yarida
 * kaldiginda bastan baslamak GEREKMEZ. Rapor her kosuda
 * `scripts/audit/report-<zaman>.json` olarak yazilir.
 *
 * `TAG` her kosuya benzersiz bir isim eki verir: ayni ismi iki kez launch
 * etmek zincirde MESRUDUR (tuz `launchCount` tasir) ama raporda hangi kosunun
 * hangi tokeni urettigi okunamaz hale gelirdi.
 */
import { formatEther } from 'viem'
import type { Address } from 'viem'
import { balance, Campaign, clients, deployerKey, read, send, wallet } from './harness'
import { phaseLaunch } from './phase-launch'
import { phaseCurve } from './phase-curve'
import { book } from './harness'
import { launchFactoryAbi, launchTokenAbi } from '../../packages/shared/src/abi/index'

/**
 * Faz B/C icin TAZE bir launch. Onceki kosunun tokenini yeniden kullanmak
 * cazip ama YANLIS olurdu: rezervleri bilinmeyen bir egride "beklenen cikti"
 * hesabi gecmiste kalmis bir duruma dayanirdi.
 */
async function freshLaunch(
  pub: Parameters<typeof read>[0],
  w: ReturnType<typeof wallet>,
  tag: string,
  buyback: boolean,
): Promise<{ token: Address; curve: Address }> {
  const b = book()
  const abi = launchFactoryAbi as unknown as import('viem').Abi
  const creator = w.account!.address
  const name = `Audit ${tag} ${buyback ? 'BB' : 'C'}`
  const symbol = buyback ? 'AUBB' : 'AUC'
  const uri = 'ipfs://audit-curve'
  const nonce = await read<bigint>(pub, {
    address: b.launchFactory,
    abi,
    functionName: 'launchCount',
  })
  const [token, curve] = await read<[Address, Address]>(pub, {
    address: b.launchFactory,
    abi,
    functionName: 'predictAddresses',
    args: [creator, name, symbol, uri, nonce],
  })
  await send(pub, w, {
    address: b.launchFactory,
    abi,
    functionName: 'launchWithBuyback',
    args: [name, symbol, uri, buyback],
  })
  const onChainCurve = await read<Address>(pub, {
    address: token,
    abi: launchTokenAbi as unknown as import('viem').Abi,
    functionName: 'curve',
  })
  if (onChainCurve.toLowerCase() !== curve.toLowerCase()) {
    throw new Error(`tahmin sapti: ${curve} vs ${onChainCurve}`)
  }
  return { token, curve }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2)
  if (wanted.length === 0) {
    console.error('kullanim: tsx audit/run.ts <faz> [<faz> ...]   fazlar: launch')
    process.exit(2)
  }

  const { pub, rpc } = clients()
  const w = wallet(deployerKey())
  const me = w.account!.address
  const tag = new Date().toISOString().slice(11, 16).replace(':', '')

  const chainId = await pub.getChainId()
  if (chainId !== 5_042_002) throw new Error(`yanlis zincir: ${chainId}`)
  const before = await balance(pub, me)

  console.log(`RPC      ${rpc}`)
  console.log(`hesap    ${me}`)
  console.log(`bakiye   ${formatEther(before)} USDC`)
  console.log(`etiket   ${tag}`)

  const c = new Campaign()
  c.startBalanceWei = before

  for (const phase of wanted) {
    if (phase === 'launch') {
      await phaseLaunch(c, pub, w, tag)
    } else if (phase === 'curve') {
      const fresh = await freshLaunch(pub, w, tag, false)
      console.log(`  (taze egri ${fresh.curve})`)
      await phaseCurve(c, pub, w, fresh.token, fresh.curve)
    } else {
      console.error(`bilinmeyen faz: ${phase}`)
      process.exit(2)
    }
  }

  const after = await balance(pub, me)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await c.report(new URL(`./report-${stamp}.json`, import.meta.url).pathname.slice(1), before - after)
  process.exit(c.failed === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

