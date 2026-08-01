import { describe, expect, it } from 'vitest'
import { toEventSelector } from 'viem'
import {
  ADDRESS_FILTER_CHUNK,
  ARC_GETLOGS_MAX_RESULTS,
  EIP7708_SYSTEM_EMITTER,
  EVENT_SIGNATURES,
  FORBIDDEN_TRANSFER_EMITTERS,
  isForbiddenEmitter,
  KIND_BY_TOPIC0,
  TOPIC0,
} from '../src/arc'
import { fixtureNames, loadFixtureFile, loadSmoke } from './fixtures'

/**
 * `TOPIC0` iki YONDEN birden tutuluyor. Tek yon yeterli DEGILDIR:
 * imzayi ve literal'i birlikte yanlis yazmak ikisini de tutarli kilar --
 * GERCEK loglar tutmaz.
 */
describe('topic0 kimlikleri', () => {
  it('olculmus literallerle ortusur', () => {
    expect(TOPIC0.launched).toBe(
      '0x18335d7ceae0e8415362afcfc11b534b5bfbf6b27c59420bf3d8e783b39de1c7',
    )
    expect(TOPIC0.trade).toBe('0x733bb99acb17010119efa3b694a341a4be53fb2e7ea4800188314660780de278')
    expect(TOPIC0.completed).toBe(
      '0x5f364ec8cbeb22a7121d682d8fbbf96032bfc28c76d26628d8562dfbb285b50a',
    )
    expect(TOPIC0.deposited).toBe(
      '0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7',
    )
    expect(TOPIC0.claimed).toBe(
      '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a',
    )
    expect(TOPIC0.transfer).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
  })

  it('literal degil HESAPLANIR', () => {
    for (const [kind, signature] of Object.entries(EVENT_SIGNATURES)) {
      expect(TOPIC0[kind as keyof typeof EVENT_SIGNATURES]).toBe(toEventSelector(signature))
    }
  })

  // ILK YON: her fixture logu bizim tanidigimiz bir olaydir. Bir imza yanlis
  // yazilirsa hesaplanan selector hicbir gercek logla ortusmez.
  it('yerel fixture larin her logu TOPIC0 dan birini tasir', () => {
    for (const name of fixtureNames()) {
      for (const log of loadFixtureFile(name).logs) {
        expect(KIND_BY_TOPIC0.get(log.topics[0]!), `${name} logIndex ${log.logIndex}`).toBeDefined()
      }
    }
  })

  // IKINCI YON: her `TOPIC0` degeri en az bir gercek logda GORULUR. Yalnizca
  // birinci yon olsaydi, hic yayilmayan uydurma bir imza yesil kalirdi.
  it('her TOPIC0 degeri en az bir gercek logda gorulur', () => {
    const seen = new Set<string>()
    for (const name of fixtureNames()) {
      for (const log of loadFixtureFile(name).logs) seen.add(log.topics[0]!)
    }
    expect([...Object.values(TOPIC0)].filter((t) => !seen.has(t))).toEqual([])
  })

  // UCUNCU: CANLI zincir. Yerel fixture'lar Foundry'den, bunlar Arc'tan.
  it('canli Arc makbuzlarindaki her sozlesme logu da tanidiktir', () => {
    for (const receipt of loadSmoke().receipts) {
      for (const log of receipt.logs) {
        if (isForbiddenEmitter(log.address)) continue
        expect(
          KIND_BY_TOPIC0.get(log.topics[0]!),
          `${receipt.scenario} ${log.logIndex}`,
        ).toBeDefined()
      }
    }
  })
})

describe('yasakli emitter kumesi', () => {
  it('tam olarak iki adres tasir', () => {
    expect([...FORBIDDEN_TRANSFER_EMITTERS].sort()).toEqual([
      '0x3600000000000000000000000000000000000000',
      '0xfffffffffffffffffffffffffffffffffffffffe',
    ])
  })

  // Adres kucuk/buyuk harf duyarli bir dizge olarak saklanir; kume uyeligi de
  // oyle. Buyuk harfli bir giris duvari SESSIZCE etkisiz kilardi.
  it('buyuk harfli yazim da yakalanir', () => {
    expect(isForbiddenEmitter(EIP7708_SYSTEM_EMITTER.toUpperCase())).toBe(true)
    expect(isForbiddenEmitter('0x3600000000000000000000000000000000000000'.toUpperCase())).toBe(
      true,
    )
  })

  it('canli smoke un 7708 yayincisi tam olarak bu kumededir', () => {
    const smoke = loadSmoke()
    expect(isForbiddenEmitter(smoke.nativeTransferEmitter)).toBe(true)
    // Ve o yayinci canli makbuzlarda GERCEKTEN var -- yoksa bu duvar
    // test edilmemis bir kod yolu olurdu.
    const count = smoke.receipts
      .flatMap((r) => r.logs)
      .filter((l) => isForbiddenEmitter(l.address)).length
    expect(count).toBe(12)
  })

  // Bir launch token'i yasakli olamaz: olsaydi butun bakiyeleri duserdi.
  it('canli launch token yasakli DEGILDIR', () => {
    expect(isForbiddenEmitter('0x1bd93613a7bc470a739d9615cdc65e535d958fab')).toBe(false)
  })
})

describe('olculmus RPC sinirlari', () => {
  it('sabitler olculmus degerlerdir', () => {
    expect(ARC_GETLOGS_MAX_RESULTS).toBe(20_000)
    // 1.000 kabul edildi; yarisinda duruyoruz.
    expect(ADDRESS_FILTER_CHUNK).toBe(500)
  })
})
