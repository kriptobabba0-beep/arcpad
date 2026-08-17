import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAbiParameters, type Hex, keccak256 } from 'viem'

/**
 * Bir curve profilinin ekonomiyi belirleyen ucu.
 *
 * AD VE ALANLAR Faz 4'un `web/lib/profile.ts` tanimiyla BIREBIR AYNIDIR; iki
 * taraf arasinda bir cevirici katman olmamasi bilincli bir karardir.
 *
 * TANIM ARTIK `curve.ts`TE: bu modul `node:fs` okur ve tarayici girisinden
 * ERISILEMEZ, ama kota motorunun ayni tipi adlandirmasi gerekiyor. Buradan
 * yeniden disa aktariliyor, yani mevcut her importer aynen calisir; TEK bir
 * tanim vardir, ikiz degil.
 */
export type { CurveProfile } from './curve'
import type { CurveProfile } from './curve'

/**
 * PROFIL KIMLIGI ARTIK `profileNames.ts`TE, ve sebebi `CurveProfile`inkiyle
 * AYNI: bu modul `node:fs` okur ve tarayici girisinden erisilemez, ama al-sat
 * panelinin para kisayollari profilin ADINA baglidir. Buradan yeniden disa
 * aktariliyor, yani mevcut her importer aynen calisir; TEK bir tanim vardir.
 */
export { isProfileName, PROFILE_DIGESTS, PROFILE_NAMES, type ProfileName } from './profileNames'
import { PROFILE_NAMES, type ProfileName } from './profileNames'

/**
 * ZINCIR -> GOVERNANCE ANAHTARI. `Profiles.sol`daki `chainKeyFor`in ikizi.
 *
 * BURADA OLMASININ SEBEBI BIR INCELEME BULGUSUDUR (I-4). Bag Solidity
 * tarafinda derleniyor ve mutasyonla test ediliyordu (P12/P14), ama defterin
 * kendi `chainKey` alani HICBIR SEYE karsi dogrulanmiyordu: 31337 icin
 * `"arc-testnet"` -- hatta `"totally-made-up"` -- tasiyan bir defter tertemiz
 * yukleniyordu. Bu, deponun EN COK TEKRAR EDEN kusurunun bir ornegi daha:
 * ozellik bir tuketicide kapali, KARDESINDE acik.
 *
 * Bahis o bulgudan sonra daha da yukseldi: keeper artik `chainKey`i defterden
 * OKUYOR ve `expected-governance.json` icindeki izin listesini onunla
 * indeksliyor -- yani yanlis bir anahtar artik yalnizca hos gorulmuyor,
 * KULLANILIYOR.
 *
 * Literaller ELLE yazilmistir, `PROFILE_DIGESTS` gibi. Solidity tarafi
 * `Profiles.t.sol::test_eachChainCarriesItsOwnGovernanceKey` icinde AYNI iki
 * literale pinlenmistir, dolayisiyla iki dilin ayrismasi CI'da gorunur.
 */
export const CHAIN_KEYS = {
  5042002: 'arc-testnet',
  31337: 'local-rehearsal',
} as const satisfies Record<number, string>

export type RegisteredChainId = keyof typeof CHAIN_KEYS

export function chainKeyFor(chainId: number): string {
  const key = (CHAIN_KEYS as Record<number, string | undefined>)[chainId]
  if (key === undefined) {
    throw new Error(
      `unregistered chain ${chainId}; add it to Profiles.sol and CHAIN_KEYS together, in a reviewed commit`,
    )
  }
  return key
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
      const name = section[1] as string
      // GERCEK TOML da tekrarlanan bir tabloyu REDDEDER. Onceki hal sessizce
      // SONUNCUYU aliyordu (`sections.set` uzerine yaziyordu) -- ve bu,
      // "taninmadigi her satirda firlatir" diye belgelenen bir okuyucunun
      // kabul ettigi TEK bozukluktu. Inceleme bulgusu M-4.
      if (sections.has(name)) {
        throw new Error(`profiles.toml:${lineNumber}: duplicate section [profiles.${name}]`)
      }
      current = new Map()
      sections.set(name, current)
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
