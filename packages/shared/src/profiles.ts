import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters, type Hex, keccak256 } from 'viem'

/**
 * Bir curve profilinin ekonomiyi belirleyen ucu.
 *
 * AD VE ALANLAR Faz 4'un `web/lib/profile.ts` tanimiyla BIREBIR AYNIDIR; iki
 * taraf arasinda bir cevirici katman olmamasi bilincli bir karardir.
 */
export type CurveProfile = {
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  saleSupply: bigint
}

/**
 * `keccak256(abi.encode(T, V, S))`, PROFIL BASINA, ELLE YAZILMIS.
 *
 * `contracts/script/Profiles.sol` icindeki `TESTNET_DIGEST` /
 * `PRODUCTION_DIGEST` ile AYNI literallerdir ve oyle olmalidir. Dosyadan
 * okunani hash'leyip buraya yazan bir uretim adimi TOTOLOJI olurdu: hash
 * her zaman kendisiyle esitlenirdi. Elle yazilmis olmalari sayesinde
 * `profiles.test.ts` GERCEK bir capraz-dil kapisidir -- Solidity ile
 * TypeScript "testnet"in ne demek oldugu konusunda ayrisirsa, bunu soyleyen
 * test odur.
 */
export const PROFILE_DIGESTS = {
  testnet: '0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d',
  production: '0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3',
} as const

export type ProfileName = keyof typeof PROFILE_DIGESTS

export const PROFILE_NAMES = Object.keys(PROFILE_DIGESTS) as ProfileName[]

export function isProfileName(name: string): name is ProfileName {
  return Object.prototype.hasOwnProperty.call(PROFILE_DIGESTS, name)
}

/** Depo koku. Bu dosya `<root>/packages/shared/src/profiles.ts`tir. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const PROFILES_TOML_PATH = join(REPO_ROOT, 'contracts', 'deploy', 'profiles.toml')

/**
 * `keccak256(abi.encode(uint256,uint256,uint256))` -- Solidity'nin
 * `abi.encode(T, V, S)` ciktisiyla BAYT BAYT ayni.
 */
export function profileDigest(p: CurveProfile): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [p.virtualTokenReserves, p.virtualQuoteReserves, p.saleSupply],
    ),
  )
}

/**
 * `profiles.toml`u okur.
 *
 * BU GENEL BIR TOML AYRISTIRICISI DEGILDIR VE OLMAYA CALISMAZ. Node'da
 * yerlesik bir TOML ayristiricisi yoktur (`node:util` icinde yok, olculdu) ve
 * yalnizca bu tek dosya icin bir bagimlilik eklemek tedarik zinciri
 * yuzeyini bedavaya buyuturdu. Bunun yerine: SADECE bu dosyanin sekli
 * (`[profiles.<ad>]` bolumleri ve `anahtar = "ondalik dize"` satirlari)
 * taninir ve TANIMADIGI HER SATIRDA FIRLATIR -- sessizce atlamaz. Sessizce
 * atlamak, eksik bir alani `undefined` yapip hatayi bir katman oteye
 * tasirdi.
 *
 * Ayristirmanin dogrulugu ayrica ARKADAN da korunur: cikan ucluler
 * `PROFILE_DIGESTS`e karsi hash'lenir, yani yanlis ayristirilmis bir sayi
 * digest'i tutturamaz ve GURULTULU bicimde patlar.
 */
export function readProfiles(
  tomlPath: string = PROFILES_TOML_PATH,
): Record<ProfileName, CurveProfile> {
  const raw = readFileSync(tomlPath, 'utf8')
  const sections = new Map<string, Map<string, string>>()

  let current: Map<string, string> | undefined
  let lineNumber = 0

  for (const rawLine of raw.split(/\r?\n/)) {
    lineNumber += 1
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const section = /^\[profiles\.([A-Za-z0-9_-]+)\]$/.exec(line)
    if (section) {
      current = new Map()
      sections.set(section[1] as string, current)
      continue
    }

    const pair = /^([A-Za-z0-9_]+)\s*=\s*"(\d+)"$/.exec(line)
    if (pair) {
      if (!current) {
        throw new Error(
          `profiles.toml:${lineNumber}: key "${pair[1]}" appears before any [profiles.*] section`,
        )
      }
      current.set(pair[1] as string, pair[2] as string)
      continue
    }

    throw new Error(
      `profiles.toml:${lineNumber}: unrecognised line ${JSON.stringify(rawLine)}. ` +
        'This reader understands only [profiles.<name>] sections and key = "<decimal string>" pairs.',
    )
  }

  const out = {} as Record<ProfileName, CurveProfile>
  for (const name of PROFILE_NAMES) {
    const fields = sections.get(name)
    if (!fields) throw new Error(`profiles.toml: missing section [profiles.${name}]`)
    out[name] = {
      virtualTokenReserves: requireField(fields, name, 'virtualTokenReserves'),
      virtualQuoteReserves: requireField(fields, name, 'virtualQuoteReserves'),
      saleSupply: requireField(fields, name, 'saleSupply'),
    }
  }
  return out
}

function requireField(fields: Map<string, string>, profile: string, key: string): bigint {
  const value = fields.get(key)
  if (value === undefined)
    throw new Error(`profiles.toml: [profiles.${profile}] is missing "${key}"`)
  // Ondalik DIZE olarak okunur ve dogrudan bigint'e gecer. `Number` YASAK:
  // T = 1.073e27 bir IEEE-754 double'a sigmaz ve sessizce yuvarlanirdi.
  return BigInt(value)
}
