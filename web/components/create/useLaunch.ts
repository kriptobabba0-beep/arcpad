'use client'

import { launchFactoryAbi } from '@arcpad/shared/browser'
import { useCallback, useMemo, useRef, useState } from 'react'
import { type Address, getAddress, type Hex, type Log, parseEventLogs } from 'viem'
import { useConfig } from 'wagmi'
import { simulateContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { getWebConfig } from '@/lib/addresses'
import { type ArcpadFailure, decodeArcpadError } from '@/lib/decodeRevert'
import { type LaunchArgs, type LaunchFields, validateLaunch } from './fields'

/**
 * ISLEM YASAM DONGUSU.
 *
 *   draft -> validating -> simulating -> awaitingSignature -> pending(hash)
 *         -> launched(token, curve) | failed
 *
 * Alti durum, cunku kullanicinin bekledigi sey her adimda BASKA bir sey:
 * `simulating` sirasinda hicbir sey imzalanmamistir ve iptal bedavadir,
 * `awaitingSignature` sirasinda top cuzdandadir, `pending` sirasinda islem
 * zincirdedir ve geri alinamaz. Tek bir "loading" bunlarin ucunu de ayni
 * gosterirdi.
 */
export type LaunchStatus =
  'draft' | 'validating' | 'simulating' | 'awaitingSignature' | 'pending' | 'launched' | 'failed'

export type LaunchedAddresses = {
  readonly token: Address
  readonly curve: Address
}

export type LaunchRequest = {
  readonly address: Address
  readonly abi: typeof launchFactoryAbi
  readonly functionName: 'launch'
  readonly args: readonly [string, string, string]
}

/**
 * `launch`'a HICBIR ZAMAN `value` KONMAZ.
 *
 * `LaunchFactory.launch` `payable` DEGILDIR. Deger tasiyan bir cagri, VERI
 * TASIMAYAN bir revert verir -- `decodeRevert.ts`'in 4. dali bunu "zincir
 * sebep vermeden reddetti" diye anlatir ve dogru olan da budur: disaridan
 * bakan biri icin `payable` olmayan bir fonksiyona deger gondermek, bir CREATE2
 * carpismasi ve gazin bitmesi BIREBIR ayni gorunur.
 *
 * Istegi tek bir yerde KURMAK, "value ekle" mutantinin saklanabilecegi yer
 * birakmiyor: `create/useLaunch.test.tsx` hem bu nesnede hem de surucunun
 * `simulateContract`'a fiilen verdigi nesnede `value` anahtarini ariyor.
 */
export function launchRequest(factory: Address, args: LaunchArgs): LaunchRequest {
  return {
    address: factory,
    abi: launchFactoryAbi,
    functionName: 'launch',
    args: [args.name, args.symbol, args.uri],
  }
}

/**
 * ADRES MAKBUZUN `Launched` OLAYINDAN OKUNUR. `predictAddresses` ARAYUZDE HIC
 * KULLANILMAZ.
 *
 * `predictAddresses` salt'a `launchCount`'u katar ve `launchCount` GLOBALDIR:
 * tahmin ile gonderim arasinda araya giren BASKA bir launch tahmini gecersiz
 * kilar. Launch ekraninda yanlis bir token adresi gostermek, o adres
 * kopyalanip paylasildiginda dogrudan bir dolandiricilik yoludur -- kullanici
 * kendi launch'i sandigi adrese para gonderir.
 *
 * IKINCI KAPI, ADRES FILTRESI: yalnizca FACTORY'nin yaydigi log kabul edilir.
 * `Launched` imzasi bir sirdir degil; herhangi bir kontrat ayni topic'lerle
 * log yayabilir ve makbuzda bizim islemimizin dokundugu her kontratin loglari
 * durur. Filtre olmadan, launch isleminde cagrilan bir token sahte bir
 * `Launched` yayarak bu ekrani kendi sectigi adrese yonlendirebilirdi.
 */
export function launchedFromReceipt(
  logs: readonly Log[],
  factory: Address,
): LaunchedAddresses | null {
  const wanted = factory.toLowerCase()
  const mine = logs.filter((log) => log.address?.toLowerCase() === wanted)
  const parsed = parseEventLogs({ abi: launchFactoryAbi, eventName: 'Launched', logs: mine })
  const first = parsed[0]
  if (first === undefined) return null
  return { token: getAddress(first.args.token), curve: getAddress(first.args.curve) }
}

/**
 * ZINCIRE DOKUNAN UC ISLEM, ENJEKTE EDILEBILIR BICIMDE.
 *
 * Testler burada bir cift `vi.fn()` gecer, boylece `simulateContract`'a
 * VERILEN nesne iddiaya konu olabilir. Gercek surucu `wagmi/actions`'i
 * kullanir; ikisi de ayni `LaunchRequest`'i alir.
 */
export type LaunchDriver = {
  simulate(request: LaunchRequest): Promise<void>
  write(request: LaunchRequest): Promise<Hex>
  receipt(hash: Hex): Promise<{ readonly logs: readonly Log[] }>
}

export type LaunchState = {
  readonly status: LaunchStatus
  readonly hash?: Hex
  readonly result?: LaunchedAddresses
  readonly failure?: ArcpadFailure
}

export type UseLaunch = LaunchState & {
  submit(fields: LaunchFields): Promise<void>
  reset(): void
  /** Alan bazli istemci hatalari. Simulasyon degil, ilk kapi. */
  readonly fieldErrors: Readonly<Record<string, string>>
}

export function useLaunch(options?: { driver?: LaunchDriver }): UseLaunch {
  const config = useConfig()
  const [state, setState] = useState<LaunchState>({ status: 'draft' })
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})

  // Bir gonderim surerken ikinci bir gonderimi engeller. `status` state'ine
  // bakmak YETMEZ: `setState` toplu islenir ve iki hizli tiklama ayni turda
  // ikisi de `draft` gorur.
  const inFlight = useRef(false)

  const injected = options?.driver
  const driver = useMemo<LaunchDriver>(() => injected ?? wagmiDriver(config), [injected, config])

  const reset = useCallback(() => {
    setState({ status: 'draft' })
    setFieldErrors({})
  }, [])

  const submit = useCallback(
    async (fields: LaunchFields) => {
      if (inFlight.current) return
      const factory = getWebConfig().addresses.launchFactory

      setState({ status: 'validating' })
      const validation = validateLaunch(fields)
      if (!validation.ok) {
        setFieldErrors(validation.errors as Record<string, string>)
        setState({ status: 'draft' })
        return
      }
      setFieldErrors({})

      const request = launchRequest(factory, validation.args)
      inFlight.current = true
      try {
        /*
         * SIMULASYON IKINCI KAPIDIR VE KALDIRILAMAZ.
         *
         * Istemci dogrulamasi `EmptyName`/`NameTooLong` gibi hatalari zaten
         * engeller. Ama istemci dogrulamasi ile kontrat bir gun ayrisirsa --
         * ornegin `MAX_NAME_LENGTH` degisir ve bu dosya guncellenmezse --
         * simulasyon olmadan kullanici cuzdan penceresini acar, imzalar ve
         * gaz oder. Simulasyonla ogrendigi sey aynidir ve BEDAVADIR.
         */
        setState({ status: 'simulating' })
        await driver.simulate(request)

        setState({ status: 'awaitingSignature' })
        const hash = await driver.write(request)

        setState({ status: 'pending', hash })
        const { logs } = await driver.receipt(hash)

        const addresses = launchedFromReceipt(logs, factory)
        if (addresses === null) {
          // Makbuz geldi ama FACTORY'den `Launched` cikmadi. Bu bir basari
          // degildir ve basari gibi gosterilmez: elimizde gosterecek bir
          // token adresi yok, tahmin edecegimiz de yok.
          setState({
            status: 'failed',
            hash,
            failure: decodeArcpadError(
              new Error(
                'The transaction was mined but the factory did not emit Launched. ' +
                  'Open it in the explorer before doing anything else.',
              ),
              { action: 'launch' },
            ),
          })
          return
        }
        setState({ status: 'launched', hash, result: addresses })
      } catch (error) {
        /*
         * CUZDAN REDDINDE (EIP-1193 4001) FORM AYNEN DURUR.
         *
         * Bu en sik yasanan durumdur -- kullanici pencereyi gorur, tutari bir
         * daha okur, vazgecer. Formu sifirlamak, on dakikalik bir isi bir
         * "Reject" tusuna baglamak olurdu. Hook yalnizca `status`'u dusurur;
         * ALANLARA HIC DOKUNMAZ (alanlar zaten `LaunchForm`'un state'inde).
         */
        setState({ status: 'failed', failure: decodeArcpadError(error, { action: 'launch' }) })
      } finally {
        inFlight.current = false
      }
    },
    [driver],
  )

  return { ...state, submit, reset, fieldErrors }
}

/** Gercek surucu. `account`/`chainId` wagmi'nin baglantisindan gelir. */
function wagmiDriver(config: ReturnType<typeof useConfig>): LaunchDriver {
  return {
    async simulate(request) {
      await simulateContract(config, request)
    },
    async write(request) {
      return writeContract(config, request)
    },
    async receipt(hash) {
      return waitForTransactionReceipt(config, { hash })
    },
  }
}
