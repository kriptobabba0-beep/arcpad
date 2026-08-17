'use client'

import { asTok, asWei, bondingCurveAbi, type CurveState, type FeeBps } from '@arcpad/shared/browser'
import { useCallback } from 'react'
import { useReadContracts } from 'wagmi'
import type { HexAddress } from '@/components/read/types'

/**
 * PANEL REZERVLERI ZINCIRDEN OKUR, VERITABANINDAN DEGIL.
 *
 * Bu dosyada ve `TradePanel.tsx`'te `@arcpad/db` ya da `lib/db` import'u YOK,
 * ve bu iki testle kapatilir: bir kaynak-metni iddiasi ve `getPool`'u her
 * cagrida atacak sekilde sahtelenmis bir render. Gerekcesi urun kararidir:
 * indexer dustugunde kullanici listeleri ve gecmisi kaybeder, ISLEM YAPMA
 * YETENEGINI DEGIL.
 *
 * YENILEME 2000 ms. Arc'in blok suresi ~350 ms, yani blok basina yenilemek
 * saniyede ~3 istek demek ve hicbir sey kazandirmiyor: kullaniciyi bayat bir
 * kotadan koruyan sey SLIPAJ ARGUMANIDIR (`minTokensOut` / `maxQuoteIn` /
 * `minQuoteOut`), yenileme sikligi degil. Daha sik yenilemek, korunmayi bir
 * yaris kosuluna cevirir.
 *
 * `creator` DA OKUNUR cunku `creator === 0x0` ucret dokumunu degistirir (K2):
 * creator payi hic alinmaz ve protokol payina KATLANMAZ. Okunmasaydi panel
 * sifir olmayan bir creator ucreti gosterir, zincir ise almazdi.
 *
 * BRIEF ALTI ALAN DIYOR, BURASI SEKIZ OKUYOR -- ve iki fazlanin sebebi
 * olculmus: `PROTOCOL_FEE_BPS` ve `CREATOR_FEE_BPS` planlayicinin ZORUNLU
 * argumani. Kaynagi zincir degil de bir sabit olsaydi, Faz 2'nin `feeSchedule`
 * argumanini alan yeni `LaunchFactory`'si ile arayuz SESSIZCE ayrisirdi:
 * panel 95/30 gostermeye devam eder, zincir baska bir sey alirdi. Ikisi de
 * `constant`, yani ayni multicall'a binmelerinin maliyeti iki kelime.
 */

export const CURVE_STATE_POLL_MS = 2000

export type CurveRead = {
  readonly state: CurveState
  readonly fees: FeeBps
}

/**
 * Sekiz ham sonucu tipli hale getirir -- ve BIR TANESI BILE beklenen sekilde
 * degilse `undefined` doner.
 *
 * Kismi bir `CurveState` uretmek en pahali secenek olurdu: eksik bir rezerv
 * `0n`'a duserdi, `0n` rezerv ise planlayicinin sifira bolmesi ya da butun
 * arzin satildigini sanmasi demek. Yarim bir durum, durumsuzluktan tehlikeli.
 */
export function curveReadFrom(values: readonly unknown[] | undefined): CurveRead | undefined {
  if (values === undefined || values.length < 8) return undefined
  const [vT, vQ, rT, rQ, complete, creator, protocolBps, creatorBps] = values
  if (
    typeof vT !== 'bigint' ||
    typeof vQ !== 'bigint' ||
    typeof rT !== 'bigint' ||
    typeof rQ !== 'bigint' ||
    typeof complete !== 'boolean' ||
    typeof creator !== 'string' ||
    typeof protocolBps !== 'bigint' ||
    typeof creatorBps !== 'bigint'
  ) {
    return undefined
  }
  return {
    state: {
      virtualTokenReserves: vT,
      virtualQuoteReserves: vQ,
      realTokenReserves: asTok(rT),
      realQuoteReserves: asWei(rQ),
      complete,
      creator,
    },
    fees: { protocolFeeBps: protocolBps, creatorFeeBps: creatorBps },
  }
}

export type CurveStateHandle = {
  readonly state: CurveState | undefined
  readonly fees: FeeBps | undefined
  readonly isPending: boolean
  readonly refetch: () => void
}

export function useCurveState(curve: HexAddress | undefined): CurveStateHandle {
  const contract = { address: curve as `0x${string}`, abi: bondingCurveAbi } as const

  const { data, isPending, refetch } = useReadContracts({
    // TEK MULTICALL. Arc ardisik `eth_call`'lari da hiz sinirliyor, yani sekiz
    // ayri okuma sekiz kez sinirlanma sansi -- ve bir tanesi dustugunde
    // kullanici tutarsiz bir anlik goruntu gorurdu: yeni rezervler, eski
    // `complete`.
    allowFailure: false,
    contracts: [
      { ...contract, functionName: 'virtualTokenReserves' },
      { ...contract, functionName: 'virtualQuoteReserves' },
      { ...contract, functionName: 'realTokenReserves' },
      { ...contract, functionName: 'realQuoteReserves' },
      { ...contract, functionName: 'complete' },
      { ...contract, functionName: 'creator' },
      { ...contract, functionName: 'PROTOCOL_FEE_BPS' },
      { ...contract, functionName: 'CREATOR_FEE_BPS' },
    ],
    query: {
      enabled: curve !== undefined,
      refetchInterval: CURVE_STATE_POLL_MS,
      // Sekme arka plandayken yenilemeyi surdurmek, kimsenin bakmadigi bir
      // ekran icin saniyede yarim istek demek. Odaga donuldugunde bir kez
      // yenilemek ayni tazeligi bedavaya verir.
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  })

  const read = curveReadFrom(data as readonly unknown[] | undefined)

  return {
    state: read?.state,
    fees: read?.fees,
    isPending: curve !== undefined && isPending,
    refetch: useCallback(() => {
      void refetch()
    }, [refetch]),
  }
}
