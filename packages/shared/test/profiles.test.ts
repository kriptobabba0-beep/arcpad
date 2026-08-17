import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  CHAIN_KEYS,
  chainKeyFor,
  PROFILE_DIGESTS,
  profileDigest,
  readProfiles,
  REPO_ROOT,
} from '../src/profiles'

describe('curve profilleri', () => {
  it('the TOML matches the pinned digest for both profiles', () => {
    // CAPRAZ-DIL KAPISI. `PROFILE_DIGESTS` ELLE yazilmistir ve
    // `contracts/script/Profiles.sol` icindeki literallerin AYNISIDIR.
    // Solidity ile TypeScript "testnet"in ne demek oldugu konusunda
    // ayrisirsa, bunu soyleyen test budur.
    const profiles = readProfiles()
    expect(profileDigest(profiles.testnet)).toBe(PROFILE_DIGESTS.testnet)
    expect(profileDigest(profiles.production)).toBe(PROFILE_DIGESTS.production)
  })

  it('the two profiles differ in exactly one field, by exactly 1000x', () => {
    const { testnet, production } = readProfiles()
    expect(production.virtualTokenReserves).toBe(testnet.virtualTokenReserves)
    expect(production.saleSupply).toBe(testnet.saleSupply)
    expect(production.virtualQuoteReserves / testnet.virtualQuoteReserves).toBe(1000n)
    expect(production.virtualQuoteReserves).not.toBe(testnet.virtualQuoteReserves)
  })

  it('production is 4292e18 and testnet is 4292e15', () => {
    const { testnet, production } = readProfiles()
    expect(testnet.virtualQuoteReserves).toBe(4_292_000_000_000_000_000n)
    expect(production.virtualQuoteReserves).toBe(4_292_000_000_000_000_000_000n)
  })

  it('T and S are the pinned literals, read without precision loss', () => {
    const { testnet } = readProfiles()
    // 1.073e27 ve 7.931e26 -- ikisi de bir IEEE-754 double'a SIGMAZ.
    expect(testnet.virtualTokenReserves).toBe(1_073_000_000n * 10n ** 18n)
    expect(testnet.saleSupply).toBe(793_100_000n * 10n ** 18n)
    expect(testnet.virtualTokenReserves).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
  })

  it('the digest separates the two magnitudes', () => {
    expect(PROFILE_DIGESTS.testnet).not.toBe(PROFILE_DIGESTS.production)
  })

  it('the digest covers field ORDER, not only field values', () => {
    // Solidity tarafinda P7 mutanti ile olculen ozelligin TypeScript ikizi:
    // T ile V'yi takas etmek BASKA bir digest verir.
    const { testnet } = readProfiles()
    const transposed = profileDigest({
      virtualTokenReserves: testnet.virtualQuoteReserves,
      virtualQuoteReserves: testnet.virtualTokenReserves,
      saleSupply: testnet.saleSupply,
    })
    expect(transposed).not.toBe(PROFILE_DIGESTS.testnet)
  })

  // I-4'un TS tarafi. Iki literal de ELLE yazilir ve Solidity tarafi
  // `Profiles.t.sol::test_eachChainCarriesItsOwnGovernanceKey` icinde AYNI
  // ikisine pinlenir; iki dilin ayrismasi bu ikili sayesinde CI'da gorunur.
  it('binds each registered chain to its own governance key', () => {
    expect(CHAIN_KEYS[5042002]).toBe('arc-testnet')
    expect(CHAIN_KEYS[31337]).toBe('local-rehearsal')
    expect(chainKeyFor(5042002)).toBe('arc-testnet')
    expect(chainKeyFor(31337)).toBe('local-rehearsal')
  })

  it('refuses an unregistered chain rather than inventing a key', () => {
    for (const id of [0, 1, 5042, 5042001, 5042003, 8453, 31338, 42161]) {
      expect(() => chainKeyFor(id)).toThrow(/unregistered chain/)
    }
  })

  // M-4.
  it('rejects a duplicate [profiles.*] section rather than taking the last', () => {
    const doubled = join(REPO_ROOT, 'contracts', 'deploy', 'testdata', 'duplicate-section.toml')
    expect(() => readProfiles(doubled)).toThrow(/duplicate section/)
  })

  it('refuses a line it does not understand instead of skipping it', () => {
    // Ayristirici DAR olmasina izin verilen bir seydir, ama SESSIZ olmasina
    // degil: taninmayan bir satiri atlamak eksik bir alani `undefined`
    // yapip hatayi bir katman oteye tasirdi.
    expect(() => readProfiles('package.json')).toThrow(/unrecognised line/)
  })
})
