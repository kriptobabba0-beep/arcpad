import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type AddressBook,
  addressBookPath,
  AddressBookError,
  assertEnvMatchesBook,
  loadAddressBook,
  parseAddressBook,
  toDeployment,
} from '../src/addresses'
import { REPO_ROOT } from '../src/profiles'

const FIXTURE_DIR = join(REPO_ROOT, 'contracts', 'deploy', 'testdata')
const CHAIN = 31337

function rawFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(addressBookPath(CHAIN, FIXTURE_DIR), 'utf8')) as Record<
    string,
    unknown
  >
}

/** Fixture'i tek bir alandan bozar. Her negatif test TEK bir sey degistirir. */
function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...rawFixture(), [field]: value }
}

function book(): AddressBook {
  return loadAddressBook(CHAIN, FIXTURE_DIR)
}

/** Alan adini TASIYAN bir hata bekler -- yalnizca "firlatti" degil. */
function expectFieldError(fn: () => unknown, field: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AddressBookError)
    expect((error as AddressBookError).field).toBe(field)
    return
  }
  throw new Error(`expected a throw naming "${field}", but nothing was thrown`)
}

describe('adres defteri', () => {
  it('loads the fixture and checksums every address', () => {
    const b = book()
    expect(b.chainId).toBe(31337)
    expect(b.chainKey).toBe('local-rehearsal')
    expect(b.profile).toBe('testnet')
    expect(b.launchFactory).toBe('0xeeaE42fa79dA76cF5186CE47e5c66BF496DF66f3')
    expect(b.feeEscrow).toBe('0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6')
    expect(b.governor).toBe('0x0000000000000000000000000000000000000601')
    expect(b.protocolTreasury).toBe('0x0000000000000000000000000000000000007EA5')
    expect(b.graduationTarget).toBe('0x0000000000000000000000000000000000000000')
    expect(b.smokeToken).toBeNull()
    expect(b.smokeCurve).toBeNull()
  })

  it('rejects an address that is not EIP-55 checksummed', () => {
    // Kucuk harfe indirilmis ayni adres. Zincir ustunde AYNI adrestir; bir
    // defterde ise iki farkli dize demektir ve env karsilastirmasini
    // gurultusuzce kaydirir.
    expectFieldError(
      () =>
        parseAddressBook(
          withField('launchFactory', '0xeeae42fa79da76cf5186ce47e5c66bf496df66f3'),
          CHAIN,
        ),
      'launchFactory',
    )
  })

  it('rejects a book whose chainId disagrees with its filename', () => {
    expectFieldError(() => parseAddressBook(withField('chainId', 5042002), CHAIN), 'chainId')
  })

  it('rejects a book whose reserves disagree with the profile it names', () => {
    // H3'un BIR KATMAN YUKARISI: testnet adini tasiyip uretim V'si tasimak.
    expectFieldError(
      () => parseAddressBook(withField('virtualQuoteReserves', '4292000000000000000000'), CHAIN),
      'virtualQuoteReserves',
    )
  })

  it('rejects a profile name it does not know', () => {
    expectFieldError(() => parseAddressBook(withField('profile', 'staging'), CHAIN), 'profile')
  })

  it('rejects startBlock that is not the min of the two deploy blocks', () => {
    expectFieldError(() => parseAddressBook(withField('startBlock', '2'), CHAIN), 'startBlock')
  })

  it('rejects any aliased pair among factory/escrow/governor/treasury', () => {
    const fields = ['launchFactory', 'feeEscrow', 'governor', 'protocolTreasury'] as const
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < fields.length; i += 1) {
      for (let j = i + 1; j < fields.length; j += 1) {
        pairs.push([fields[i] as string, fields[j] as string])
      }
    }
    // ALTI CIFT, dordu degil: dort roldan secilen her ikili.
    expect(pairs).toHaveLength(6)

    const base = rawFixture()
    for (const [a, b] of pairs) {
      expectFieldError(() => parseAddressBook({ ...base, [b]: base[a] }, CHAIN), a)
    }
  })

  it('parses 1e27 without precision loss', () => {
    const b = book()
    expect(b.totalSupply).toBe(10n ** 27n)
    expect(b.totalSupply > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)

    // KAYBIN KENDISI, gosterilerek. Bir IEEE-754 double 1e27 ile 1e27+1'i
    // AYIRT EDEMEZ -- ikisi ayni degerdir. `bigint` ayirt eder. Alanin
    // ondalik DIZE olarak tasinmasinin sebebi tam olarak budur.
    expect(1e27 + 1).toBe(1e27)
    expect(b.totalSupply + 1n).not.toBe(b.totalSupply)
  })

  it('rejects a numeric field written as a JSON number rather than a decimal string', () => {
    expectFieldError(() => parseAddressBook(withField('totalSupply', 1e27), CHAIN), 'totalSupply')
  })

  it('requires smokeToken/smokeCurve to be PRESENT as null, not absent', () => {
    // Task 7 bir DEGER degisikligi olmali, SEMA degisikligi degil.
    const b = rawFixture()
    delete b.smokeToken
    expectFieldError(() => parseAddressBook(b, CHAIN), 'smokeToken')
  })

  it('validates smokeToken the same way as every other address once it is filled', () => {
    expectFieldError(() => parseAddressBook(withField('smokeToken', '0xnope'), CHAIN), 'smokeToken')
    const ok = parseAddressBook(
      withField('smokeToken', '0x0000000000000000000000000000000000001234'),
      CHAIN,
    )
    expect(ok.smokeToken).toBe('0x0000000000000000000000000000000000001234')
  })

  it('rejects a malformed initcode hash', () => {
    expectFieldError(
      () => parseAddressBook(withField('escrowInitcodeHash', '0xdeadbeef'), CHAIN),
      'escrowInitcodeHash',
    )
  })

  it('toDeployment produces exactly the nine fields packages/db declares', () => {
    const d = toDeployment(book())
    // IKI YONLU. Faz 1b'nin yuzey testleri ISIM SAYIYORDU ve bes ikame
    // paketi yesil biraktu; ders bir kayit tipine AYNEN tasinir -- eklenen
    // bir alan da eksilen bir alan kadar hatadir.
    expect(Object.keys(d).sort()).toEqual(
      [
        'chainId',
        'escrow',
        'factory',
        'protocolTreasury',
        'saleSupplyTok',
        'startBlock',
        'totalSupplyTok',
        'virtualQuoteReservesWei',
        'virtualTokenReservesTok',
      ].sort(),
    )
    expect(d.factory).toBe('0xeeaE42fa79dA76cF5186CE47e5c66BF496DF66f3')
    expect(d.escrow).toBe('0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6')
    expect(d.startBlock).toBe(1n)
    expect(d.totalSupplyTok).toBe(10n ** 27n)
  })

  describe('assertEnvMatchesBook', () => {
    function goodEnv(b: AddressBook): Record<string, string | undefined> {
      return {
        NEXT_PUBLIC_ARC_CHAIN_ID: String(b.chainId),
        NEXT_PUBLIC_ARCPAD_FACTORY: b.launchFactory,
        NEXT_PUBLIC_ARCPAD_ESCROW: b.feeEscrow,
        ARC_FACTORY_ADDRESS: b.launchFactory,
        ARC_ESCROW_ADDRESS: b.feeEscrow,
        ARC_START_BLOCK: String(b.startBlock),
      }
    }

    it('accepts an env that agrees with the book', () => {
      const b = book()
      expect(() => assertEnvMatchesBook(goodEnv(b), b)).not.toThrow()
    })

    it('throws naming the stale variable -- a case per variable', () => {
      const b = book()
      const stale: Record<string, string> = {
        NEXT_PUBLIC_ARC_CHAIN_ID: '5042002',
        NEXT_PUBLIC_ARCPAD_FACTORY: '0x0000000000000000000000000000000000009999',
        NEXT_PUBLIC_ARCPAD_ESCROW: '0x0000000000000000000000000000000000009999',
        ARC_FACTORY_ADDRESS: '0x0000000000000000000000000000000000009999',
        ARC_ESCROW_ADDRESS: '0x0000000000000000000000000000000000009999',
        ARC_START_BLOCK: '999',
      }
      for (const [name, value] of Object.entries(stale)) {
        expectFieldError(() => assertEnvMatchesBook({ ...goodEnv(b), [name]: value }, b), name)
      }
    })

    it('throws naming the MISSING variable -- a case per variable', () => {
      const b = book()
      for (const name of Object.keys(goodEnv(b))) {
        const env = { ...goodEnv(b) }
        delete env[name]
        expectFieldError(() => assertEnvMatchesBook(env, b), name)
      }
    })

    it('accepts a lowercase env address, because the chain does not care about case', () => {
      const b = book()
      const env = { ...goodEnv(b), ARC_FACTORY_ADDRESS: b.launchFactory.toLowerCase() }
      expect(() => assertEnvMatchesBook(env, b)).not.toThrow()
    })
  })
})
