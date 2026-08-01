import type { Address, Hex } from 'viem'
import { toEventSelector } from 'viem'
import { USDC_ERC20_ADDRESS } from '@arcpad/shared'

/**
 * SINIR NOTU -- bu dosyanin normal evi `@arcpad/shared/src/arc.ts`'tir (plan
 * Task 1) ve o paket SU AN baska bir ajanin elinde; Task 1 henuz inmedi
 * (`packages/shared/src/` icinde ne `arc.ts` ne `artifacts.generated.ts` var,
 * olculdu 2026-08-01). `cursor.ts`'in acilisindaki ayni karar burada da
 * gecerlidir: pakete uzanmak yerine ihtiyac duyulan sey bu taskin sahip oldugu
 * sinirda tanimlanir. Task 1 indigi gun bu dosya
 * `export { ... } from '@arcpad/shared'` satirlarina iner ve `logs.ts`
 * DEGISMEZ -- tuketiciler sabitleri ADA gore kullanir, degere gore degil.
 *
 * IKI SEY BURADA TEKRARLANMIYOR: `USDC_ERC20_ADDRESS` @arcpad/shared'dan
 * ITHAL EDILIYOR (ikinci bir kopya, iki degerin sessizce ayrismasi demekti) ve
 * `ARC_GETLOGS_MAX_RANGE` `cursor.ts`'te zaten var.
 */

/**
 * EIP-7708'in sistem adresi. Arc'ta NATIVE varligin her hareketi buradan 18
 * decimal'lik bir `Transfer` logu yayar.
 *
 * OLCULDU (Arc testnet):
 *   tx 0xcdb86510...ae093 -- duz native transfer (input 0x, value 85615523834970299)
 *     -> TEK log, emitter 0xfff...ffe, 18 decimal. 0x3600... hic log yaymadi.
 *   tx 0xc9004d69...74611 -- USDC.transfer(0x1208...0e12, 1_768_280)
 *     -> logIndex 0: emitter 0xfff...ffe, data 1_768_280_000_000_000_000
 *     -> logIndex 1: emitter 0x3600...0000, data 1_768_280
 *     AYNI hareket, IKI log, IKI gorunum.
 *
 * BU DEPODAKI CANLI KANIT: `contracts/fixtures/arc-live/smoke-receipts.json`
 * bes gercek smoke makbuzunu aynen tasir ve dordunde ucer tane 0xfff...ffe
 * `Transfer`'i vardir. Test bunlari SENTETIK bir log yerine dogrudan oradan
 * okur.
 */
export const EIP7708_SYSTEM_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe' as const

/**
 * `Transfer` logu cozen hicbir yol bu emitterlardan gelen bir logu KABUL
 * ETMEZ. Kume halinde duruyor cunku kontrol bir `if` degil bir uyelik
 * sorgusudur: Arc baska bir sistem emitter'i eklerse tek yer degisir.
 *
 * Adresler KUCUK HARFTIR. `eth_getLogs` adresleri kucuk harf dondurur
 * (olculdu, smoke-receipts.json'daki 38 logun hepsi) ama uyelik sorgusu bir
 * dizge esitligidir: buyuk harfli bir giris kumeyi SESSIZCE etkisiz kilardi.
 * `isForbiddenEmitter` girdiyi de kucultur, yani duvar buyuk/kucuk harften
 * bagimsizdir.
 */
export const FORBIDDEN_TRANSFER_EMITTERS: ReadonlySet<string> = new Set<string>([
  EIP7708_SYSTEM_EMITTER,
  USDC_ERC20_ADDRESS.toLowerCase(),
])

export function isForbiddenEmitter(address: string): boolean {
  return FORBIDDEN_TRANSFER_EMITTERS.has(address.toLowerCase())
}

/**
 * `eth_getLogs`'un OLCULMUS sonuc siniri (plan, Global Kisitlar):
 *   filtresiz 1.000 blok -> -32602 "query exceeds max results 20000,
 *                                   retry with the range 54325373-54326275"
 */
export const ARC_GETLOGS_MAX_RESULTS = 20_000

/**
 * `eth_getLogs`'un `address` dizisinde tek cagrida gecirilecek adres sayisi.
 * 1.000 giris KABUL EDILDI (50/500/1.000 denendi, hepsi ok); yarisinda
 * duruyoruz cunku sinir belgelenmis degil, olculmustur ve degisebilir.
 */
export const ADDRESS_FILTER_CHUNK = 500

/**
 * OLAY IMZALARI.
 *
 * Bunlar `contracts/out/**`'tan URETILMIS degil ELLE yazilmistir -- Task 1'in
 * ureticisi henuz yok. O yuzden dogrulama iki yerden gelir ve ikisi de GERCEK
 * YURUTMEDEN cikan bayta bakar:
 *
 *   1. `test/topics.test.ts` her `topic0`'i plandaki olculmus literal'e karsi
 *      tutar (`cast keccak` ciktisi, spec'ten kopyalanmadi).
 *   2. AYNI test iki yonlu olarak fixture'lara bakar: `contracts/fixtures/`
 *      icindeki her log `TOPIC0`'in bir degerini tasir, ve `TOPIC0`'in her
 *      degeri en az bir fixture logunda gorulur. Fixture'lar Foundry'nin
 *      GERCEK yurutmesinden cikti (Task 4), yani bir imza yanlis yazilirsa
 *      hesaplanan selector hicbir gercek logla ortusmez.
 *
 * Bir literal listesi (1) tek basina yeterli olmazdi: imzayi ve literal'i
 * birlikte yanlis yazmak ikisini de tutarli kilar. Fixture'lar bu yolu kapatir.
 */
export const EVENT_SIGNATURES = {
  launched: 'Launched(address,address,address,string,string,string,bytes32)',
  trade: 'Trade(address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)',
  completed: 'Completed(address,uint256,uint256)',
  deposited: 'Deposited(address,address,uint256)',
  claimed: 'Claimed(address,uint256)',
  transfer: 'Transfer(address,address,uint256)',
} as const

export type EventKind = keyof typeof EVENT_SIGNATURES

export const TOPIC0: Readonly<Record<EventKind, Hex>> = Object.freeze(
  Object.fromEntries(
    Object.entries(EVENT_SIGNATURES).map(([kind, sig]) => [kind, toEventSelector(sig)]),
  ) as Record<EventKind, Hex>,
)

/** `topic0` -> olay adi. Cozucu secimi bir arama, bir `if` zinciri degildir. */
export const KIND_BY_TOPIC0: ReadonlyMap<Hex, EventKind> = new Map(
  (Object.entries(TOPIC0) as [EventKind, Hex][]).map(([kind, topic]) => [topic, kind]),
)

/** Sifir adres. `Transfer`'in mint bacagi bunu `from` olarak tasir. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
