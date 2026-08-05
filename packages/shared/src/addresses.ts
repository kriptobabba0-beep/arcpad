import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Address,
  getAddress,
  getCreate2Address,
  type Hex,
  isAddress,
  keccak256,
  toBytes,
} from 'viem'
import {
  chainKeyFor,
  type CurveProfile,
  isProfileName,
  PROFILE_DIGESTS,
  type ProfileName,
  profileDigest,
  readProfiles,
  REPO_ROOT,
} from './profiles'

/**
 * `DeployLib.sol`daki uclunun ikizi. Defterin `escrowInitcodeHash` /
 * `factoryInitcodeHash` alanlarinin var olma sebebi "her iki adres YALNIZCA
 * defterden yeniden turetilebilsin" idi; yukleyici bunu YAPMIYORDU (inceleme
 * bulgusu M-5). Artik yapiyor, yani defter kendi kendini dogruluyor.
 */
export const CREATE2_FACTORY: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
export const ESCROW_SALT: Hex = keccak256(toBytes('arcpad.FeeEscrow.v1'))
export const FACTORY_SALT: Hex = keccak256(toBytes('arcpad.LaunchFactory.v1'))

export const GOVERNANCE_PATH = join(REPO_ROOT, 'contracts', 'deploy', 'expected-governance.json')

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

  // I-4. Onceki hal `requireString` ile yetiniyordu, yani BOS OLMAYAN HER
  // DIZEYI kabul ediyordu: 31337 icin `"arc-testnet"` tasiyan bir defter de,
  // `"totally-made-up"` tasiyan bir defter de tertemiz yukleniyordu. Bag
  // Solidity tarafinda derlenip mutasyonla test edilirken (P12/P14) onu
  // TUKETEN tarafta hic dogrulanmiyordu.
  const chainKey = requireString(o, 'chainKey')
  const expectedChainKey = chainKeyFor(chainId)
  if (chainKey !== expectedChainKey) {
    throw new AddressBookError(
      'chainKey',
      `book says "${chainKey}" but chain ${chainId} is "${expectedChainKey}"`,
    )
  }

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
  // TEK KOPYA. Burada ELLE YAZILMIS ikinci bir tablo vardi ve hicbir test
  // onu `PROFILE_DIGESTS` ile dogrudan karsilastirmiyordu (inceleme bulgusu
  // M-1). Kaynak zaten `profiles.ts`teydi; ikinci kopyanin kazandirdigi
  // hicbir sey yoktu, kaybettirebilecegi sey sessiz bir kaymaydi.
  const expected = PROFILE_DIGESTS[book.profile]
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

  // SIRA ONEMLI VE OLCULEREK SECILDI. Takma-ad kontrolu, tureme
  // kontrolunden ONCE gelir: escrow adresini `launchFactory` alanina
  // yapistirmak IKISINI BIRDEN ihlal eder ("takma ad" ve "kendi initcode
  // hash'inden turemiyor"), ve operatore daha yararli olan teshis birincisidir
  // -- ne yaptigini soyler, yalnizca sonucu degil. Tureme kontrolu once
  // konuldugunda alti-cift testi olculebilir bicimde `feeEscrow` diyordu,
  // beklenen `launchFactory` yerine.
  for (let i = 0; i < DISTINCT_FIELDS.length; i += 1) {
    for (let j = i + 1; j < DISTINCT_FIELDS.length; j += 1) {
      const a = DISTINCT_FIELDS[i] as (typeof DISTINCT_FIELDS)[number]
      const b = DISTINCT_FIELDS[j] as (typeof DISTINCT_FIELDS)[number]
      if (book[a] === book[b]) {
        throw new AddressBookError(a, `aliases ${b} (both ${book[a]})`)
      }
    }
  }

  // M-5. Iki initcode hash'i defterde TAM OLARAK "adresler yalnizca defterden
  // yeniden turetilebilsin" diye duruyor. Yukleyici bunu yapmiyordu, yani
  // alanlar bir IDDIA'ydi; artik yapiyor, yani bir ISPAT. Elle duzenlenmis bir
  // defter -- takma ad kontrollerinin varlik sebebi -- burada da yakalanir.
  assertDerivedAddress(book, 'feeEscrow', ESCROW_SALT, book.escrowInitcodeHash)
  assertDerivedAddress(book, 'launchFactory', FACTORY_SALT, book.factoryInitcodeHash)

  // M-6. Iki dosya da commit'li ve ayni agac tarafindan okunuyor; birbirleriyle
  // celismelerine izin vermek icin bir sebep yok. `expected-governance.json`
  // Solidity tarafinda ayrica bir digest'e de baglidir (Profiles.sol), yani bu
  // capraz kontrol defteri O bagin ucuna iliştirir.
  assertGovernanceAgrees(book)

  return book
}

function assertDerivedAddress(
  book: AddressBook,
  field: 'feeEscrow' | 'launchFactory',
  salt: Hex,
  initcodeHash: Hex,
): void {
  const derived = getCreate2Address({ from: CREATE2_FACTORY, salt, bytecodeHash: initcodeHash })
  if (derived !== book[field]) {
    throw new AddressBookError(
      field,
      `is ${book[field]} but CREATE2(${CREATE2_FACTORY}, ${salt}, ${initcodeHash}) derives ${derived}`,
    )
  }
}

function assertGovernanceAgrees(book: AddressBook): void {
  let raw: string
  try {
    raw = readFileSync(GOVERNANCE_PATH, 'utf8')
  } catch {
    throw new AddressBookError('governor', `cannot read ${GOVERNANCE_PATH}`)
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const entry = parsed[book.chainKey]
  if (typeof entry !== 'object' || entry === null) {
    throw new AddressBookError(
      'chainKey',
      `expected-governance.json has no entry for "${book.chainKey}"`,
    )
  }
  const e = entry as Record<string, unknown>
  for (const [bookField, jsonField] of [
    ['governor', 'governor'],
    ['protocolTreasury', 'treasury'],
  ] as const) {
    const declared = e[jsonField]
    if (typeof declared !== 'string' || !isAddress(declared, { strict: false })) {
      throw new AddressBookError(
        bookField,
        `expected-governance.json ${book.chainKey}.${jsonField} is not an address`,
      )
    }
    if (getAddress(declared) !== book[bookField]) {
      throw new AddressBookError(
        bookField,
        `book says ${book[bookField]} but expected-governance.json ${book.chainKey}.${jsonField} says ${getAddress(declared)}`,
      )
    }
  }
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
 * DEFTER -> ENV BAGI, TEK TABLO.
 *
 * URETICI (`webEnvBlock`) ve DENETCI (`assertEnvMatchesBook`) BU TABLODAN
 * TUREK. Onceki hal iki ayri elle yazilmis listeydi ve ikisi de ayni alti adi
 * tekrarliyordu: denetciye bir degisken eklemek ureticiye eklemeyi
 * gerektirmiyordu, yani `pnpm addressbook`in bastigi blok preflight'in
 * istediginden EKSIK olabilirdi ve fark ancak bir CI kosusunda -- ya da
 * uretimde -- gorunurdu. Bir tablo, iki tuketici: ayrisma yazilamaz hale
 * gelir.
 *
 * `kind` bir bicim degil bir DOGRULAMA secimidir: `address` olanlar
 * buyuk/kucuk harften bagimsiz karsilastirilip EIP-55'e cevrilir, `plain`
 * olanlar dize esitligiyle tutulur. Bir chain id'yi adres gibi dogrulamak
 * imkansiz, bir adresi dize gibi dogrulamak ise checksum farkinda YANLIS
 * ALARM verirdi.
 */
type EnvBinding = {
  readonly name: string
  readonly kind: 'plain' | 'address'
  readonly valueOf: (book: AddressBook) => string
}

export const WEB_ENV_BINDINGS: readonly EnvBinding[] = Object.freeze([
  { name: 'NEXT_PUBLIC_ARC_CHAIN_ID', kind: 'plain', valueOf: (b) => String(b.chainId) },
  { name: 'NEXT_PUBLIC_ARCPAD_FACTORY', kind: 'address', valueOf: (b) => b.launchFactory },
  { name: 'NEXT_PUBLIC_ARCPAD_ESCROW', kind: 'address', valueOf: (b) => b.feeEscrow },
  { name: 'ARC_FACTORY_ADDRESS', kind: 'address', valueOf: (b) => b.launchFactory },
  { name: 'ARC_ESCROW_ADDRESS', kind: 'address', valueOf: (b) => b.feeEscrow },
  { name: 'ARC_START_BLOCK', kind: 'plain', valueOf: (b) => String(b.startBlock) },
] as const satisfies readonly EnvBinding[])

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
  for (const binding of WEB_ENV_BINDINGS) {
    if (binding.kind === 'address') {
      expectEnvAddress(env, binding.name, binding.valueOf(book) as Address)
    } else {
      expectEnv(env, binding.name, binding.valueOf(book))
    }
  }
}

/**
 * DEFTERDEN URETILEN `KEY=VALUE` BLOGU -- CI'IN `$GITHUB_ENV`E EKLEDIGI SEY.
 *
 * NEDEN VAR: `web`in uretim derlemesi `NEXT_PUBLIC_ARC_CHAIN_ID` olmadan
 * `/_not-found` on-render'inda `WebConfigError` ile DUSER, ve `node.yml`in iki
 * derleme is'i de degiskenlerin HICBIRINI ayarlamiyordu -- yani o kapi hic
 * yesil olmadi ve olamazdi. Cozum degerleri is akisina YAPISTIRMAK DEGILDIR
 * (defterin ustunden atlayan ucuncu bir kopya, ve `indexer-live.yml`de tam
 * olarak bu yapildi): CI defteri OKUR, defteri dogrulayan ayni yukleyiciden
 * gecirir ve bu blogu yazar. Adres kaymasi boylece derlemeyi kirar, sessizce
 * yanlis bir factory'ye baglanmaz.
 */
export function webEnvBlock(book: AddressBook): string {
  return WEB_ENV_BINDINGS.map((binding) => `${binding.name}=${binding.valueOf(book)}`).join('\n')
}

/**
 * BOS DIZE "AYARLANMAMIS" DEMEKTIR, "yanlis deger" DEMEK DEGIL.
 *
 * `.env.example` bu degiskenleri BOS gonderir -- kasitli olarak: adresler
 * oraya kopyalansaydi "yapilandirilmamis" durumu ulasilamaz hale gelir ve Faz
 * 4 preflight'inin belgelenmis EXIT KODU 2'si olu kod olurdu. Dolayisiyla
 * `cp .env.example .env` yapan ILK kisi bu yola KESINLIKLE girer.
 *
 * `?? ` ve `=== undefined` yalnizca null/undefined'i yakalar; bos dize
 * SUZULUP GECER ve karsilastirmaya duserdi. Sonuc yine bir hata olurdu ama
 * mesaji YANLIS olurdu: 'NEXT_PUBLIC_ARCPAD_FACTORY is "" but the address book
 * says "0x..."' -- yani operatore "yanlis deger koymussun" derdi, oysa hic
 * deger koymamistir. Keeper ajani ayni sinifin bir baskasini kendi
 * `KEEPER_ADDRESS_BOOK_DIR`inde buldu; bu, ayni dersin burada uygulanmasidir.
 */
function isUnset(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === ''
}

function expectEnv(env: Record<string, string | undefined>, name: string, expected: string): void {
  const actual = env[name]
  if (isUnset(actual))
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
  if (isUnset(actual))
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
