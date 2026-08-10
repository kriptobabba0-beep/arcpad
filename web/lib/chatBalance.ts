import { launchTokenAbi, MULTICALL3_ADDRESS } from '@arcpad/shared/browser'
import { createPublicClient, http } from 'viem'
import { getWebConfig } from './addresses'
import type { HexAddress } from '@/components/read/types'

/**
 * ==========================================================================
 *  HOLDER KAPISI: BIR ZINCIR OKUMASI, YAZMA YOLUNUN UZERINDE
 * ==========================================================================
 *
 * "Holder" bir INDEXER olcumu OLAMAZ. `holders` tablosu indexer'in ulastigi
 * yere kadar dogrudur ve olculdu: canli bir kosuda indexer basin 767 504 blok
 * gerisindeydi (bkz. `packages/db/src/queries.ts`). O tabloya bakarak kapi
 * kurmak, uc dakika once token'ini satmis bir hesabin yazmasina -- ya da uc
 * dakika once ALMIS birinin yazamamasina -- izin verirdi. Kapi ZINCIRDEN
 * okunur.
 *
 * ==========================================================================
 *  BLOK: SORULMAZ, AYNI CAGRIDAN GERI GELIR
 * ==========================================================================
 *
 * `eth_blockNumber` + `eth_call` IKI cagridir ve arada blok ilerler
 * (Arc'ta blok suresi ~350ms), yani okunan bakiye rapor edilen bloga AIT
 * OLMAYABILIR. Bu tam olarak bu depoda iki kez YANLIS BULGU uretmis olan
 * "ardisik RPC cagrilari es zamanli gozlem degildir" tuzagi.
 *
 * Cozum: `Multicall3.getBlockNumber()` ile `LaunchToken.balanceOf(...)` AYNI
 * `aggregate3` icinde. Tek bir `eth_call` tek bir blokta calisir, yani donen
 * blok numarasi bakiyenin OLCULDUGU blogun ta kendisidir -- iki degeri
 * ayirmak MUMKUN DEGIL. Saklanan `balance_block_number` bu sayidir ve satiri
 * bir archive node ile bagimsizca dogrulanabilir kilan sey odur.
 *
 * ==========================================================================
 *  MALIYET, VE ARC'IN HIZ SINIRI
 * ==========================================================================
 *
 * POST BASINA TAM OLARAK BIR JSON-RPC OBJESI. Arc hiz sinirini HTTP istegi
 * degil JSON-RPC OBJESI sayarak uygular (olculdu: tek bir istekte 20 obje
 * `-32005` ile reddediliyor ve 3/6/9 sn merdiveninde sekiz denemede de
 * reddedilmeye devam ediyor; 15 geciyor). Bu yolun fan-out'u YOKTUR: bir
 * mesaj = bir obje. Yani chat yazma yolu tek basina o sinira yaklasamaz --
 * yaklasan bir sey olursa o baska bir yoldur.
 *
 * ==========================================================================
 *  RPC DUSTUGUNDE: KAPALI DUSER
 * ==========================================================================
 *
 * Okuma basarisiz olursa mesaj YAZILMAZ (rota 503 doner). Alternatif --
 * bakiyeyi bilinmez kabul edip yazmak -- iki seyi birden bozardi: (a)
 * kapiyi, cunku holder olmayan biri yazabilirdi; (b) KAYDI, cunku
 * `balance_tok` sutunu artik olculmemis bir sayi tasirdi ve o sutunun butun
 * degeri OLCULMUS olmasindan geliyor. Bedeli acikca yazili: RPC dustugunde
 * chat'e YAZILAMAZ. OKUMA etkilenmez -- panel Postgres'ten gelir.
 *
 * YENIDEN DENEME MERDIVENI YOK: tek objelik bir cagri hiz sinirina takilmaz,
 * ve takildiysa sebep RPC'nin genel durumudur; kullaniciyi bekleten bir
 * merdiven, ona 9 saniye sonra ayni hatayi verirdi.
 */

/** `getBlockNumber()` -- Multicall3'un kendi view'i. Tek ihtiyac duyulan parca. */
const MULTICALL3_BLOCK_ABI = [
  {
    type: 'function',
    name: 'getBlockNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'blockNumber', type: 'uint256' }],
  },
] as const

export type HolderReading =
  | { readonly ok: true; readonly balanceTok: bigint; readonly blockNumber: bigint }
  | { readonly ok: false; readonly reason: 'unavailable' }

export interface HolderReader {
  (token: HexAddress, holder: HexAddress): Promise<HolderReading>
}

/**
 * GERCEK OKUYUCU. Tek `eth_call`, iki sonuc, tek blok.
 *
 * `allowFailure: true`: `balanceOf` bir launch token'inda revert etmez, ama
 * bu rotaya gelen `token` bir kullanici degeridir ve `launches` kontrolu
 * ONCE yapilsa bile bir kontratin davranisini varsaymak yanlis olur. Bir
 * basarisizlik `unavailable`dir -- `0` DEGIL, cunku "okuyamadik" ile
 * "bakiyesi sifir" ayni cumle degildir ve ikincisi kullaniciya "token al"
 * dedirtir.
 */
export const readHolderBalance: HolderReader = async (token, holder) => {
  const config = getWebConfig()
  const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
  try {
    const [block, balance] = await client.multicall({
      allowFailure: true,
      contracts: [
        {
          address: MULTICALL3_ADDRESS,
          abi: MULTICALL3_BLOCK_ABI,
          functionName: 'getBlockNumber',
        },
        {
          address: token,
          abi: launchTokenAbi,
          functionName: 'balanceOf',
          args: [holder],
        },
      ],
    })
    if (block?.status !== 'success' || balance?.status !== 'success') {
      return { ok: false, reason: 'unavailable' }
    }
    if (typeof block.result !== 'bigint' || typeof balance.result !== 'bigint') {
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true, balanceTok: balance.result, blockNumber: block.result }
  } catch (error) {
    console.error('[chat] holder balance read failed; the post is refused', error)
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * TEST DIKISI -- `lib/db.ts`in `setPoolForTesting`i ile AYNI sinifta.
 *
 * Rota bir fonksiyon parametresi alamaz (imzasi Next tarafindan sabit), yani
 * enjeksiyon modul duzeyinde. Bunun tasidigi asil iddia negatif olan:
 * testler buraya HER CAGRIDA ATAN bir okuyucu koyup, gecersiz imzali bir
 * POST'un onu HIC CAGIRMADIGINI olcebiliyor.
 */
let override: HolderReader | undefined

export function setHolderReaderForTesting(replacement: HolderReader | undefined): void {
  override = replacement
}

export function getHolderReader(): HolderReader {
  return override ?? readHolderBalance
}
