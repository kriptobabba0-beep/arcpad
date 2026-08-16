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
import {
  balance,
  book,
  Campaign,
  clients,
  derivedKey,
  deployerKey,
  read,
  send,
  wallet,
} from './harness'
import { phaseLaunch } from './phase-launch'
import { phaseCurve } from './phase-curve'
import { phaseFees } from './phase-fees'
import { phaseGraduation } from './phase-graduation'
import { phaseBuyback } from './phase-buyback'
import {
  bondingCurveAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../../packages/shared/src/abi/index'

/**
 * Turetilmis bir cuzdani YALNIZCA gerekiyorsa fonlar.
 *
 * Kosulsuz fonlamak her kosuda bir islem daha demekti; ve turetilmis cuzdanlar
 * tekrar uretilebilir oldugu icin onceki kosudan kalan bakiye ZATEN oradadir.
 */
async function fundIfNeeded(
  pub: Parameters<typeof read>[0],
  from: ReturnType<typeof wallet>,
  to: Address,
  want: bigint,
): Promise<void> {
  const have = await balance(pub, to)
  if (have >= want) return
  const hash = await from.sendTransaction({
    account: from.account!,
    chain: null,
    to,
    value: want - have,
  })
  await pub.waitForTransactionReceipt({ hash })
  console.log(`  (${to} fonlandi: ${want - have} wei)`)
}

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
    } else if (phase === 'fees') {
      // Once bir islem yaparak ucret URET: bos bir escrow'da C1 "talep
      // edilecek ucret yok" der ve faz kendi on kosulunu saglamadigi icin
      // atlanmis olurdu.
      const fresh = await freshLaunch(pub, w, tag, false)
      await send(pub, w, {
        address: fresh.curve,
        abi: bondingCurveAbi as unknown as import('viem').Abi,
        functionName: 'buyExactQuoteIn',
        args: [0n],
        value: 200_000_000_000_000_000n,
      })
      const stranger = wallet(derivedKey('audit-stranger'))
      await fundIfNeeded(pub, w, stranger.account!.address, 50_000_000_000_000_000n)
      await phaseFees(c, pub, w, stranger)
    } else if (phase === 'graduate') {
      /*
       * VAR OLAN BIR EGRI YENIDEN KULLANILABILIR: `--curve=0x...`.
       *
       * Bir mezuniyet ~12,3 USDC yakar ve GERI GELMEZ. Yarida kalmis bir
       * kosunun tamamladigi egriyi atip yenisini acmak, ayni parayi ikinci kez
       * odemek olurdu -- ve testnet USDC'si faucet'ten 10'ar geliyor.
       */
      const given = wanted.find((a) => a.startsWith('--curve='))?.slice('--curve='.length)
      const target =
        given === undefined
          ? await freshLaunch(pub, w, tag, false)
          : {
              curve: given as Address,
              token: await read<Address>(pub, {
                address: given as Address,
                abi: bondingCurveAbi as unknown as import('viem').Abi,
                functionName: 'token',
              }),
            }
      console.log(`  (mezun edilecek egri ${target.curve})`)
      await phaseGraduation(c, pub, w, target.token, target.curve)
    } else if (phase === 'buyback') {
      const fresh = await freshLaunch(pub, w, tag, true)
      console.log(`  (buyback ACIK egri ${fresh.curve})`)
      // Tahakkuk icin once bir islem gerek: bos bir butcede supurme vakalari
      // kendi on kosulunu saglamadigi icin atlanmis olurdu.
      await send(pub, w, {
        address: fresh.curve,
        abi: bondingCurveAbi as unknown as import('viem').Abi,
        functionName: 'buyExactQuoteIn',
        args: [0n],
        value: 2_000_000_000_000_000_000n,
      })
      const bbStranger = wallet(derivedKey('audit-stranger'))
      await fundIfNeeded(pub, w, bbStranger.account!.address, 50_000_000_000_000_000n)
      await phaseBuyback(c, pub, w, bbStranger, fresh.token, fresh.curve)
    } else if (phase.startsWith('--')) {
      // bayrak; faz degil
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


