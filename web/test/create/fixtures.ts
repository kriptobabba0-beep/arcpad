import { launchFactoryAbi } from '@arcpad/shared/browser'
import { type Address, encodeAbiParameters, encodeEventTopics, type Log } from 'viem'

/**
 * `Launched` LOGU, GERCEK TOPIC'LERLE KURULUR.
 *
 * Elle yazilmis bir `topics[0]` ile bir sahte kursaydik, `parseEventLogs`
 * hicbir seyi cozemez ve testler "adres bulunamadi" dalini olcerdi -- yani
 * olcmek istedigimiz seyin TERSINI. `encodeEventTopics` imzayi ABI'den
 * hesaplar, dolayisiyla olay imzasi bir gun degisirse bu fixture da onunla
 * birlikte degisir.
 */
export const FACTORY = '0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439' as Address
export const CREATOR = '0x7938BE340A14A12f94a83AEa246d9d2566324c9C' as Address
export const SMOKE_TOKEN = '0x1bd93613a7BC470a739D9615cdc65e535d958fab' as Address
export const SMOKE_CURVE = '0x7938BE340A14A12f94a83AEa246d9d2566324c9C' as Address

const SALT = `0x${'11'.repeat(32)}` as const

export function launchedLog(options: {
  token: Address
  curve: Address
  creator?: Address
  /** Logu YAYAN kontrat. Factory disinda bir adres verildiginde reddedilmeli. */
  emitter?: Address
  name?: string
  symbol?: string
  uri?: string
}): Log {
  const topics = encodeEventTopics({
    abi: launchFactoryAbi,
    eventName: 'Launched',
    args: {
      token: options.token,
      curve: options.curve,
      creator: options.creator ?? CREATOR,
    },
  })
  const data = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }],
    [options.name ?? 'Diffusion', options.symbol ?? 'DIFF', options.uri ?? '', SALT],
  )
  return {
    address: options.emitter ?? FACTORY,
    topics,
    data,
    blockHash: `0x${'22'.repeat(32)}`,
    blockNumber: 54_661_500n,
    logIndex: 0,
    transactionHash: `0x${'33'.repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log
}
