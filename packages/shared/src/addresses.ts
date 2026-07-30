import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, getAddress, type Hex, isAddress } from 'viem'
import {
  type CurveProfile,
  isProfileName,
  type ProfileName,
  profileDigest,
  readProfiles,
  REPO_ROOT,
} from './profiles'

/**
 * DEFTER. Indexer, keeper, fork testleri ve (env uzerinden) web -- dordu de
 * BU dosyadan okur, kimse adres kopyalamaz.
 *
 * `smokeToken` / `smokeCurve` Task 7 doldurana kadar `null`dur. TIPTE
 * BASTAN VARDIRLAR: boylece Task 7 bir DEGER degisikligidir, SEMA
 * degisikligi degil, ve `loadAddressBook` onlari da diger her adres gibi
 * dogrular.
 */
export type AddressBook = {
  chainId: number
  chainKey: string
  profile: ProfileName
  virtualTokenReserves: bigint
  virtualQuoteReserves: bigint
  saleSupply: bigint
  totalSupply: bigint
  launchFactory: Address
  feeEscrow: Address
  governor: Address
  protocolTreasury: Address
  graduationTarget: Address
  feeEscrowBlock: bigint
  launchFactoryBlock: bigint
  startBlock: bigint
  deployTx: Hex
  escrowInitcodeHash: Hex
  factoryInitcodeHash: Hex
  commit: string
  smokeToken: Address | null
  smokeCurve: Address | null
}

/** Faz 3'un `packages/db` kaydinin TAM OLARAK dokuz alani. */
export type Deployment = {
  chainId: number
  factory: Address
  escrow: Address
  protocolTreasury: Address
  virtualTokenReservesTok: bigint
  virtualQuoteReservesWei: bigint
  saleSupplyTok: bigint
  totalSupplyTok: bigint
  startBlock: bigint
}

export class AddressBookError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'AddressBookError'
    this.field = field
  }
}

/**
 * TAKMA AD (ALIASING) KONTROLU DORT ROL UZERINDE, ALTI CIFT.
 *
 * Dekoratif degildir. Faz 1c'nin son incelemesi escrow'u treasury argumanina
 * yapistirmanin ZINCIR USTUNDEKI her korumadan (biri haric) gectigini ve 100
 * USDC'lik her alista 938.271.604.938.271.605 wei'lik TALEP EDILEMEZ protokol
 * ucreti maliyeti oldugunu buldu. Factory artik `treasury == escrow`i
 * reddediyor; defter ise TAKMA ADLARIN HEPSINI reddeder -- kontratin BILEREK
 * izin verdiklerini de. `governor == protocolTreasury` zincir ustunde
 * MESRUDUR, ama insan eliyle yazilmis bir defterde yine de yakalanmaya deger
 * bir hatadir.
 *
 * Operator gercekten iki rol icin tek bir Safe istiyorsa, bu
 * `expected-governance.json` icinde acikca `"governorIsTreasury": true`
 * olarak KAYDEDILECEK bir karardir, sessiz bir gecis degil.
 */
const DISTINCT_FIELDS = ['launchFactory', 'feeEscrow', 'governor', 'protocolTreasury'] as const

export const DEFAULT_BOOK_DIR = join(REPO_ROOT, 'contracts', 'deploy')

export function addressBookPath(chainId: number, dir: string = DEFAULT_BOOK_DIR): string {
  return join(dir, `addresses.${chainId}.json`)
}

/**
 * Defteri okur, dogrular, checksum'lar. Her basarisizlik ALANI ADIYLA firlatir.
 *
 * @param dir Fixture'lari `testdata/` altindan yurumek icin vardir; uretim
 *            yolu varsayilan `contracts/deploy`tir.
 */
export function loadAddressBook(chainId: number, dir: string = DEFAULT_BOOK_DIR): AddressBook {
  const path = addressBookPath(chainId, dir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new AddressBookError('file', `cannot read ${path}`)
  }
  return parseAddressBook(JSON.parse(raw) as unknown, chainId)
}

/**
 * Dogrulamanin CEKIRDEGI, dosya sisteminden bagimsiz. Negatif testler bunu
 * dogrudan yurur; gecici dosya yazmak zorunda kalmak testleri gercek
 * dogrulamadan uzaklastirirdi.
 */
export function parseAddressBook(input: unknown, expectedChainId: number): AddressBook {
  if (typeof input !== 'object' || input === null)
    throw new AddressBookError('root', 'not an object')
  const o = input as Record<string, unknown>

  const chainId = requireNumber(o, 'chainId')
  // DOSYA ADI ILE ICERIK AYRISAMAZ: addresses.5042002.json icinde 31337
  // yazmasi, indexer'in yanlis zinciri indekslemesi demektir.
  if (chainId !== expectedChainId) {
    throw new AddressBookError(
      'chainId',
      `book says ${chainId} but the filename says ${expectedChainId}`,
    )
  }

  const chainKey = requireString(o, 'chainKey')
  const profileName = requireString(o, 'profile')
  if (!isProfileName(profileName)) {
    throw new AddressBookError('profile', `"${profileName}" is not a known profile`)
  }

  const book: AddressBook = {
    chainId,
    chainKey,
    profile: profileName,
    virtualTokenReserves: requireBigint(o, 'virtualTokenReserves'),
    virtualQuoteReserves: requireBigint(o, 'virtualQuoteReserves'),
    saleSupply: requireBigint(o, 'saleSupply'),
    totalSupply: requireBigint(o, 'totalSupply'),
    launchFactory: requireAddress(o, 'launchFactory'),
    feeEscrow: requireAddress(o, 'feeEscrow'),
    governor: requireAddress(o, 'governor'),
    protocolTreasury: requireAddress(o, 'protocolTreasury'),
    graduationTarget: requireAddress(o, 'graduationTarget'),
    feeEscrowBlock: requireBigint(o, 'feeEscrowBlock'),
    launchFactoryBlock: requireBigint(o, 'launchFactoryBlock'),
    startBlock: requireBigint(o, 'startBlock'),
    deployTx: requireHash(o, 'deployTx', 32),
    escrowInitcodeHash: requireHash(o, 'escrowInitcodeHash', 32),
    factoryInitcodeHash: requireHash(o, 'factoryInitcodeHash', 32),
    commit: requireString(o, 'commit'),
    smokeToken: requireNullableAddress(o, 'smokeToken'),
    smokeCurve: requireNullableAddress(o, 'smokeCurve'),
  }

  // Defter KENDI zinciriyle celisemez: adini verdigi profilin sayilari
  // profiles.toml'dakilerle AYNI olmali, ve o ucluler pinlenmis digest'i
  // tutturmali. H3'un bir katman yukarisi.
  const profile = readProfiles()[book.profile]
  assertReserve(book, profile, 'virtualTokenReserves')
  assertReserve(book, profile, 'virtualQuoteReserves')
  assertReserve(book, profile, 'saleSupply')

  const digest = profileDigest({
    virtualTokenReserves: book.virtualTokenReserves,
    virtualQuoteReserves: book.virtualQuoteReserves,
    saleSupply: book.saleSupply,
  })
  const expected = PROFILE_DIGEST_LOOKUP[book.profile]
  if (digest !== expected) {
    throw new AddressBookError(
      'profile',
      `digest ${digest} does not match the pinned ${expected} for "${book.profile}"`,
    )
  }

  // Indexer'in `fromBlock`u. Escrow ONCE deploy edilir, ama iki bileseni de
  // ayri tutuyoruz: bugun factory blogundan baslamak hicbir sey kacirmaz,
  // ileride escrow-onceli bir olay eklenirse kacirirdi.
  const expectedStart =
    book.feeEscrowBlock < book.launchFactoryBlock ? book.feeEscrowBlock : book.launchFactoryBlock
  if (book.startBlock !== expectedStart) {
    throw new AddressBookError(
      'startBlock',
      `${book.startBlock} is not min(feeEscrowBlock=${book.feeEscrowBlock}, launchFactoryBlock=${book.launchFactoryBlock})=${expectedStart}`,
    )
  }

  for (let i = 0; i < DISTINCT_FIELDS.length; i += 1) {
    for (let j = i + 1; j < DISTINCT_FIELDS.length; j += 1) {
      const a = DISTINCT_FIELDS[i] as (typeof DISTINCT_FIELDS)[number]
      const b = DISTINCT_FIELDS[j] as (typeof DISTINCT_FIELDS)[number]
      if (book[a] === book[b]) {
        throw new AddressBookError(a, `aliases ${b} (both ${book[a]})`)
      }
    }
  }

  return book
}

const PROFILE_DIGEST_LOOKUP: Record<ProfileName, string> = {
  testnet: '0xa67f784bd45f49baa48601d390ecafdb2fe44aadffd974b4b0bd582c10d6600d',
  production: '0x7def5669fd9a5fd109bf35f1d1b04c651e124b6f0f22c37ced26fb77880a80e3',
}

function assertReserve(book: AddressBook, profile: CurveProfile, key: keyof CurveProfile): void {
  if (book[key] !== profile[key]) {
    throw new AddressBookError(
      key,
      `book says ${book[key]} but profile "${book.profile}" says ${profile[key]}`,
    )
  }
}

/** Faz 3'un `putDeployment()` satiri. Dokuz alan, ne eksik ne fazla. */
export function toDeployment(book: AddressBook): Deployment {
  return {
    chainId: book.chainId,
    factory: book.launchFactory,
    escrow: book.feeEscrow,
    protocolTreasury: book.protocolTreasury,
    virtualTokenReservesTok: book.virtualTokenReserves,
    virtualQuoteReservesWei: book.virtualQuoteReserves,
    saleSupplyTok: book.saleSupply,
    totalSupplyTok: book.totalSupply,
    startBlock: book.startBlock,
  }
}

/**
 * Faz 4'un `preflight`inin BESINCI iddiasi.
 *
 * Env'in var olma sebebi secim degil ZORUNLULUKTUR: Next `NEXT_PUBLIC_*`i
 * BUILD ANINDA gomer, yani istek aninda okunan bir JSON istemci paketine hic
 * ulasmaz. Bunun yarattigi bayat-env riskini kapatan sey de bu fonksiyondur.
 */
export function assertEnvMatchesBook(
  env: Record<string, string | undefined>,
  book: AddressBook,
): void {
  expectEnv(env, 'NEXT_PUBLIC_ARC_CHAIN_ID', String(book.chainId))
  expectEnvAddress(env, 'NEXT_PUBLIC_ARCPAD_FACTORY', book.launchFactory)
  expectEnvAddress(env, 'NEXT_PUBLIC_ARCPAD_ESCROW', book.feeEscrow)
  expectEnvAddress(env, 'ARC_FACTORY_ADDRESS', book.launchFactory)
  expectEnvAddress(env, 'ARC_ESCROW_ADDRESS', book.feeEscrow)
  expectEnv(env, 'ARC_START_BLOCK', String(book.startBlock))
}

function expectEnv(env: Record<string, string | undefined>, name: string, expected: string): void {
  const actual = env[name]
  if (actual === undefined)
    throw new AddressBookError(name, 'is not set, but the address book is configured')
  if (actual !== expected)
    throw new AddressBookError(name, `is "${actual}" but the address book says "${expected}"`)
}

/** Adresler BUYUK-KUCUK HARFTEN BAGIMSIZ karsilastirilir, sonra checksum'lanir. */
function expectEnvAddress(
  env: Record<string, string | undefined>,
  name: string,
  expected: Address,
): void {
  const actual = env[name]
  if (actual === undefined)
    throw new AddressBookError(name, 'is not set, but the address book is configured')
  if (!isAddress(actual, { strict: false }))
    throw new AddressBookError(name, `is "${actual}", not an address`)
  if (getAddress(actual) !== expected) {
    throw new AddressBookError(name, `is "${actual}" but the address book says "${expected}"`)
  }
}

// --- field readers, each naming its field ---

function requireNumber(o: Record<string, unknown>, field: string): number {
  const v = o[field]
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new AddressBookError(field, `expected a safe integer, got ${JSON.stringify(v)}`)
  }
  return v
}

function requireString(o: Record<string, unknown>, field: string): string {
  const v = o[field]
  if (typeof v !== 'string' || v === '')
    throw new AddressBookError(field, `expected a non-empty string, got ${JSON.stringify(v)}`)
  return v
}

/**
 * HER ZAMAN ONDALIK DIZE, ASLA `number`. `totalSupply` 1e27'dir ve bir
 * IEEE-754 double'a SIGMAZ; JSON'da sayi olarak yazilsa sessizce yuvarlanirdi.
 */
function requireBigint(o: Record<string, unknown>, field: string): bigint {
  const v = o[field]
  if (typeof v !== 'string' || !/^\d+$/.test(v)) {
    throw new AddressBookError(field, `expected a decimal string, got ${JSON.stringify(v)}`)
  }
  return BigInt(v)
}

function requireAddress(o: Record<string, unknown>, field: string): Address {
  const v = o[field]
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) {
    throw new AddressBookError(field, `expected an address, got ${JSON.stringify(v)}`)
  }
  const checksummed = getAddress(v)
  if (v !== checksummed)
    throw new AddressBookError(field, `is not EIP-55 checksummed; expected ${checksummed}`)
  return checksummed
}

function requireNullableAddress(o: Record<string, unknown>, field: string): Address | null {
  if (!(field in o))
    throw new AddressBookError(
      field,
      'is missing; it must be present as null until Task 7 fills it',
    )
  if (o[field] === null) return null
  return requireAddress(o, field)
}

function requireHash(o: Record<string, unknown>, field: string, bytes: number): Hex {
  const v = o[field]
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)
  if (typeof v !== 'string' || !pattern.test(v)) {
    throw new AddressBookError(
      field,
      `expected a ${bytes}-byte hex string, got ${JSON.stringify(v)}`,
    )
  }
  return v as Hex
}
