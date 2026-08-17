import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCreate2Address } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  type AddressBook,
  addressBookPath,
  AddressBookError,
  assertEnvMatchesBook,
  CREATE2_FACTORY,
  ESCROW_SALT,
  FACTORY_SALT,
  ARCPAD_HOOK_FLAGS,
  HOOK_ADDRESS_MASK,
  loadAddressBook,
  parseAddressBook,
  ROUTER_SALT,
  toDeployment,
  webEnvBlock,
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

  // I-4. `chainKey` Solidity tarafinda derlenip mutasyonla test ediliyordu
  // (P12/P14) ve DEFTERDE hicbir seye karsi dogrulanmiyordu.
  it('rejects a book whose chainKey is not the one registered for its chainId', () => {
    expectFieldError(
      () => parseAddressBook(withField('chainKey', 'arc-testnet'), CHAIN),
      'chainKey',
    )
  })

  it('rejects an invented chainKey', () => {
    expectFieldError(
      () => parseAddressBook(withField('chainKey', 'totally-made-up'), CHAIN),
      'chainKey',
    )
  })

  // M-2. `assertReserve` uc rezerv icin de cagriliyor; negatif testi yalnizca
  // `V`nin vardi. Ayni aile, bir alan olcegunde -- I-1'in TS'teki ikizi.
  it('rejects a book whose T disagrees with the profile it names', () => {
    expectFieldError(
      () =>
        parseAddressBook(withField('virtualTokenReserves', '1073000000000000000000000001'), CHAIN),
      'virtualTokenReserves',
    )
  })

  it('rejects a book whose S disagrees with the profile it names', () => {
    expectFieldError(
      () => parseAddressBook(withField('saleSupply', '793100000000000000000000001'), CHAIN),
      'saleSupply',
    )
  })

  // M-5. Iki hash defterde "adresleri yalnizca defterden yeniden turet"
  // diye duruyor; yukleyici artik gercekten turetiyor.
  it('rejects a book whose feeEscrow does not match its own escrowInitcodeHash', () => {
    expectFieldError(
      () =>
        parseAddressBook(
          withField('feeEscrow', '0x000000000000000000000000000000000000BEEF'),
          CHAIN,
        ),
      'feeEscrow',
    )
  })

  it('rejects a book whose launchFactory does not match its own factoryInitcodeHash', () => {
    expectFieldError(
      () =>
        parseAddressBook(
          withField('launchFactory', '0x000000000000000000000000000000000000bEEF'),
          CHAIN,
        ),
      'launchFactory',
    )
  })

  it('re-derives both addresses from the book alone', () => {
    const b = book()
    expect(
      getCreate2Address({
        from: CREATE2_FACTORY,
        salt: ESCROW_SALT,
        bytecodeHash: b.escrowInitcodeHash,
      }),
    ).toBe(b.feeEscrow)
    expect(
      getCreate2Address({
        from: CREATE2_FACTORY,
        salt: FACTORY_SALT,
        bytecodeHash: b.factoryInitcodeHash,
      }),
    ).toBe(b.launchFactory)
  })

  // M-6.
  it('rejects a book whose governance disagrees with expected-governance.json', () => {
    expectFieldError(
      () =>
        parseAddressBook(
          withField('governor', '0x00000000000000000000000000000000000006A1'),
          CHAIN,
        ),
      'governor',
    )
    expectFieldError(
      () =>
        parseAddressBook(
          withField('protocolTreasury', '0x0000000000000000000000000000000000007EA6'),
          CHAIN,
        ),
      'protocolTreasury',
    )
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
        // Havuz router'i. Defterde ZORUNLUDUR ve yukleyici onu CREATE2 ile
        // yeniden turetir, yani buradaki deger bir kopya degil bir turetmedir.
        NEXT_PUBLIC_ARCPAD_ROUTER: b.arcpadRouter,
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
        NEXT_PUBLIC_ARCPAD_ROUTER: '0x0000000000000000000000000000000000009999',
        ARC_FACTORY_ADDRESS: '0x0000000000000000000000000000000000009999',
        ARC_ESCROW_ADDRESS: '0x0000000000000000000000000000000000009999',
        ARC_START_BLOCK: '999',
      }
      for (const [name, value] of Object.entries(stale)) {
        expectFieldError(() => assertEnvMatchesBook({ ...goodEnv(b), [name]: value }, b), name)
      }
    })

    // .env.example bu degiskenleri BOS gonderiyor, yani `cp .env.example .env`
    // yapan ilk kisi TAM OLARAK bu yola giriyor. Bos dize "ayarlanmamis"
    // sayilmali; aksi halde mesaj operatore "yanlis deger koydun" derdi.
    it('treats an EMPTY string as unset, not as a wrong value -- a case per variable', () => {
      const b = book()
      for (const name of Object.keys(goodEnv(b))) {
        for (const empty of ['', '   ']) {
          const env = { ...goodEnv(b), [name]: empty }
          try {
            assertEnvMatchesBook(env, b)
            throw new Error(`expected a throw for ${name}=${JSON.stringify(empty)}`)
          } catch (error) {
            expect(error).toBeInstanceOf(AddressBookError)
            expect((error as AddressBookError).field).toBe(name)
            expect((error as AddressBookError).message).toContain('is not set')
          }
        }
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

  // =====================================================================
  // THE PRODUCER AND THE CHECKER ARE ONE TABLE.
  //
  // `webEnvBlock` writes CI's environment; `assertEnvMatchesBook` refuses a
  // deploy whose environment disagrees with the book. They used to be two
  // hand-written lists of the same six names, and nothing compared them --
  // so a variable added to the checker and forgotten in the producer would
  // have turned every CI web build red for a reason that has nothing to do
  // with the code, which is precisely the failure this whole change exists
  // to end.
  // =====================================================================
  describe('webEnvBlock', () => {
    /**
     * WRITTEN OUT, NOT DERIVED FROM `WEB_ENV_BINDINGS`.
     *
     * Deriving the expectation from the table under test would make this
     * assertion vacuous -- it would pass for any table, including an empty
     * one. These six names are the contract `.env.example`, `preflight` and
     * both CI jobs depend on.
     */
    const EXPECTED_NAMES = [
      'ARC_ESCROW_ADDRESS',
      'ARC_FACTORY_ADDRESS',
      'ARC_START_BLOCK',
      'NEXT_PUBLIC_ARCPAD_ESCROW',
      'NEXT_PUBLIC_ARCPAD_FACTORY',
      // YEDINCI AD. Bunu eklemeden binding'i eklemek bu testi kirar, ve KIRMASI
      // gerekir: `webEnvBlock` CI'in derleme ortamini yazar, yani bu liste
      // "uretimde hangi degiskenler var" sozlesmesidir. Turetilmis olsaydi
      // sozlesme, denetledigi tablonun bir kopyasi olurdu.
      'NEXT_PUBLIC_ARCPAD_ROUTER',
      'NEXT_PUBLIC_ARC_CHAIN_ID',
    ]

    function parseBlock(text: string): Record<string, string> {
      const out: Record<string, string> = {}
      for (const line of text.split('\n')) {
        if (line === '') continue
        const eq = line.indexOf('=')
        expect(eq, `no "=" in ${JSON.stringify(line)}`).toBeGreaterThan(0)
        out[line.slice(0, eq)] = line.slice(eq + 1)
      }
      return out
    }

    it('produces exactly what the checker demands -- no more, no less', () => {
      const b = book()
      const produced = parseBlock(webEnvBlock(b))
      expect(Object.keys(produced).sort()).toEqual(EXPECTED_NAMES)
      expect(() => assertEnvMatchesBook(produced, b)).not.toThrow()
    })

    it('every binding names a variable the checker actually reads', () => {
      const b = book()
      // Dropping any ONE produced variable must make the checker throw, naming
      // that variable. A binding the checker ignores would survive this.
      for (const name of Object.keys(parseBlock(webEnvBlock(b)))) {
        const env = parseBlock(webEnvBlock(b))
        delete env[name]
        expectFieldError(() => assertEnvMatchesBook(env, b), name)
      }
    })

    it('no line carries a stray space, a quote or a CR -- $GITHUB_ENV is literal', () => {
      // GitHub appends this text to a file and parses `KEY=VALUE` verbatim: a
      // trailing space or a quote becomes part of the VALUE, and the address
      // then fails to parse at build time rather than here.
      for (const line of webEnvBlock(book()).split('\n')) {
        expect(line).toMatch(/^[A-Z0-9_]+=[^\s"']+$/)
      }
    })
  })

  // =====================================================================
  // THE CI STEP ITSELF.
  //
  // Same shape as `abi-parity.test.ts`'s assertion that its job exists: a
  // mechanism whose only consumer is a workflow file is unmeasured unless
  // something reads that file. Measured on this tree: `pnpm --filter
  // @arcpad/web build` exits 1 with `WebConfigError:
  // NEXT_PUBLIC_ARC_CHAIN_ID: is not set` when these values are absent, so a
  // job that builds `web` without the step CANNOT be green.
  // =====================================================================
  describe('the workflow reads the book before it builds web', () => {
    /**
     * COMMENTS ARE STRIPPED BEFORE THE "no pasted literal" CHECKS.
     *
     * Not a convenience: the comment that RECORDS the removed literal --
     * "`ARC_FACTORY_ADDRESS: '0x0d75a4ff...'` used to be here, and why that was
     * wrong" -- is the most valuable line in the file, and a check that forbade
     * it would delete the reason along with the defect. YAML comments cannot
     * set an environment variable, so nothing is lost.
     */
    function withoutComments(text: string): string {
      return text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')
    }

    const workflow = (): string =>
      readFileSync(join(REPO_ROOT, '.github', 'workflows', 'node.yml'), 'utf8')

    /** Steps, in file order, as `name` -> `run` is too loose; keep raw blocks. */
    function stepIndex(text: string, needle: string): number {
      const at = text.indexOf(needle)
      expect(at, `workflow does not contain ${JSON.stringify(needle)}`).toBeGreaterThan(-1)
      return at
    }

    it('every job that builds web reads the address book FIRST', () => {
      const text = workflow()
      // The two commands that end in a real `next build`.
      for (const build of [
        'run: pnpm --filter @arcpad/web build',
        'run: pnpm --filter @arcpad/web release-gate',
      ]) {
        const buildAt = stepIndex(text, build)
        const envAt = text.lastIndexOf('run: pnpm addressbook --env-only >> "$GITHUB_ENV"', buildAt)
        expect(envAt, `no address-book step before "${build}"`).toBeGreaterThan(-1)
      }
    })

    it('no NEXT_PUBLIC value is pasted into the workflow', () => {
      // The remedy is READING the book, not copying it. A literal here would
      // outlive the book the first time the factory is redeployed -- the exact
      // defect that sat in `indexer-live.yml`.
      expect(withoutComments(workflow())).not.toMatch(/NEXT_PUBLIC_[A-Z_]+:\s*['"]?0x/)
    })

    it('the live workflow no longer pastes a factory address', () => {
      const live = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'indexer-live.yml'), 'utf8')
      expect(withoutComments(live)).not.toMatch(/ARC_FACTORY_ADDRESS:\s*['"]?0x/)
      expect(live).toContain('run: pnpm addressbook --env-only >> "$GITHUB_ENV"')
    })
  })

  // =====================================================================
  // FAZ 2 / TASK 7'NIN DORT ADRESI, VE OLU SEMANIN CANLANDIRILMASI
  // =====================================================================
  //
  // `contracts/deploy/addresses.schema.json` bu depoda BIR SEYI HIC
  // DOGRULAMIYORDU: onu okuyan tek bir satir yoktu (olculdu -- tum agacta sifur
  // referans). Sonucu su sekilde gorundu: Task 7'nin defterine dort alan ELLE
  // eklendi, sema `additionalProperties: false` diyordu, ve HICBIR SEY kirmizi
  // olmadi. Bir kapinin var OLMASI ile KOSUYOR olmasi arasindaki fark budur.
  //
  // Asagidaki uc iddia semayi yukleyiciye ve GERCEK defterlere BAGLAR. Bir
  // JSON-Schema motoru gerekmedi ve bilerek eklenmedi (`pnpm-lock.yaml`
  // paylasilan bir dosya): olculen ariza alan KUMESI ayrismasiydi, ve onu
  // yakalayan sey kume esitligidir.
  describe('sema, defter ve yukleyici ayni alan kumesi uzerinde anlasir', () => {
    const schemaPath = join(REPO_ROOT, 'contracts', 'deploy', 'addresses.schema.json')
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      required: string[]
      properties: Record<string, unknown>
      additionalProperties?: boolean
    }

    const REAL_BOOKS: Array<[string, string, number]> = [
      ['arc testnet', join(REPO_ROOT, 'contracts', 'deploy'), 5042002],
      ['local rehearsal fixture', FIXTURE_DIR, 31337],
    ]

    it('the schema still forbids unknown fields, or none of this measures anything', () => {
      expect(schema.additionalProperties).toBe(false)
      expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)))
    })

    for (const [label, dir, chainId] of REAL_BOOKS) {
      it(`${label}: the file's keys are EXACTLY the schema's`, () => {
        const raw = JSON.parse(readFileSync(addressBookPath(chainId, dir), 'utf8')) as Record<
          string,
          unknown
        >
        // Iki yon de tasiyicidir: eksik alan yukleyiciyi patlatir, FAZLA alan
        // ise `additionalProperties: false`u ihlal eder ve tam olarak boyle
        // sessizce girdi.
        expect(new Set(Object.keys(raw))).toEqual(new Set(schema.required))
      })

      it(`${label}: the loader produces EXACTLY those fields`, () => {
        // Ucuncu bag: sema ve dosya anlassa bile, TS tipi geride kalabilirdi.
        expect(new Set(Object.keys(loadAddressBook(chainId, dir)))).toEqual(
          new Set(schema.required),
        )
      })
    }
  })

  describe('havuz katmaninin dort adresi', () => {
    it('loads all four from the fixture', () => {
      const b = book()
      expect(b.feeSchedule).toBe('0x47548C1ce996b24846E948B815459D98BB08dc84')
      expect(b.poolManager).toBe('0x617321A877e024C870516CD599A581dCDCa6c09b')
      expect(b.arcpadHook).toBe('0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC')
      expect(b.arcpadLocker).toBe('0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8')
    })

    for (const field of ['feeSchedule', 'poolManager', 'arcpadHook', 'arcpadLocker'] as const) {
      it(`rejects a book with no ${field}`, () => {
        const raw = rawFixture()
        delete raw[field]
        expectFieldError(() => parseAddressBook(raw, CHAIN), field)
      })
    }

    // BU IDDIA DIGER UCUNUN TASIYAMADIGI SEYI TASIR. Bir hook adresi kendi
    // IZIN KUMESIDIR: alt 14 bit `PoolManager`in kabul ettigi seydir. Yanlis
    // yazilmis bir hook adresi "kotu veri" degildir, ACILMAYAN BIR HAVUZDUR --
    // ve hicbir tuketici katman bakmiyordu.
    it('rejects a hook address that does not carry the arcpad flag bits', () => {
      // Son karakteri degistirmek alt bitleri kaydirir: ...e0cC -> ...e0cD
      const broken = '0xd95198Cd806B736C8EcEcfFC23976b59F565e0cD'
      expectFieldError(() => parseAddressBook(withField('arcpadHook', broken), CHAIN), 'arcpadHook')
    })

    it('the real arc testnet book carries a hook with the flags', () => {
      // Pozitif kontrol: negatif test tek basina "her seye kizan bir kontrol"
      // ile de gecerdi.
      const live = loadAddressBook(5042002, join(REPO_ROOT, 'contracts', 'deploy'))
      expect(Number(BigInt(live.arcpadHook) & BigInt(HOOK_ADDRESS_MASK))).toBe(ARCPAD_HOOK_FLAGS)
      expect(ARCPAD_HOOK_FLAGS).toBe(0x2000 | 0x80 | 0x40 | 0x8 | 0x4)
    })

    it('rejects a pool address pasted into the wrong field', () => {
      // Sekiz alan, 28 cift. Elle yazilan bir defterde en olasi hata budur.
      expectFieldError(
        () => parseAddressBook(withField('poolManager', rawFixture().arcpadLocker), CHAIN),
        'poolManager',
      )
    })
  })

  // =====================================================================
  // ROUTER: MEZUNIYET SONRASI TICARETIN TEK GIRIS NOKTASI
  // =====================================================================
  //
  // `arcpadRouter` ZORUNLUDUR ve nullable DEGILDIR. Gerekce `smokeToken`in
  // TERSIDIR: smoke cifti bir launch'in ARTIGIDIR ve olmayabilir; router ise
  // bir dagitimin ULASILABILIRLIGIDIR. V4 bir EOA'ya swap girisi vermez ve
  // Arc'ta Universal Router yoktur, yani router'i olmayan bir defter "mezun
  // olan her token'in kilitli oldugu" bir dagitimi tarif eder. "Simdilik
  // null" tam olarak smoke ciftinin sessiz delik oldugu yoldur.
  describe('router', () => {
    /*
     * IKI AYRI SABIT, VE AYRIMI DENETIM ACTI (2026-08-13).
     *
     * Onceki hal TEK bir `LIVE_ROUTER` tutuyordu ve onu HEM sentetik
     * fixture'da HEM canli defterde kullaniyordu. Ikisi ayni sey DEGIL:
     * fixture ayristirıcinin sekil kontrolu icin uydurulmus bir kayittir,
     * canli defter ise zincirde duran adrestir. Router yeniden dagitildiginda
     * (hook degistigi icin -- `hook` router'in `immutable` constructor
     * argumani) tek sabit ikisini birden hareket ettirmeye calisti ve
     * cakisti.
     *
     * Ayri tutmak sadece bu kosuyu duzeltmiyor: fixture'in canli adresi
     * IZLEMEK ZORUNDA OLMADIGINI da soyluyor.
     */
    const FIXTURE_ROUTER = '0x6D9f42706C7E7bF3D2Ad3123ca7397DA6F0bB7cd'
    // V2 nesli (buyback), 16 Agustos 2026'da yayinlandi. Onceki nesil PoolDeployLib.LEGACY_V1_* sabitlerinde kayitli.
    const LIVE_ROUTER = '0x51Bb2Ce3f5347e5447beFf6B72801d75cCe79fD5'

    it('loads the router and its initcode hash from the fixture', () => {
      const b = book()
      expect(b.arcpadRouter).toBe(FIXTURE_ROUTER)
      expect(b.routerInitcodeHash).toBe(
        '0x7881b11cfa16440a113a1311bc091f041764f4a0d8b240ec03a91bb5d78af8eb',
      )
    })

    for (const field of ['arcpadRouter', 'routerInitcodeHash'] as const) {
      it(`rejects a book with no ${field}`, () => {
        const raw = rawFixture()
        delete raw[field]
        expectFieldError(() => parseAddressBook(raw, CHAIN), field)
      })
    }

    /**
     * THE CARRY PATH'S PROOF, AND WHAT SEPARATES THE ROUTER FROM THE POOL
     * TRIPLE. `poolManager` / `arcpadHook` / `arcpadLocker` are COPIED into
     * the book and nothing offline can re-derive them -- 7675f04 accepted
     * that deliberately, because their initcode hashes are not recorded. The
     * router's IS recorded, so it joins `feeEscrow` and `launchFactory` in
     * the class of fields the book proves rather than asserts.
     */
    it('re-derives the router from the book alone', () => {
      const b = book()
      expect(
        getCreate2Address({
          from: CREATE2_FACTORY,
          salt: ROUTER_SALT,
          bytecodeHash: b.routerInitcodeHash,
        }),
      ).toBe(b.arcpadRouter)
    })

    it('rejects a book whose arcpadRouter does not match its own routerInitcodeHash', () => {
      expectFieldError(
        () =>
          parseAddressBook(
            withField('arcpadRouter', '0x000000000000000000000000000000000000bEEF'),
            CHAIN,
          ),
        'arcpadRouter',
      )
    })

    /**
     * THE HASH IS THE OTHER HALF OF THE SAME PAIR. Editing it alone must be
     * just as red as editing the address alone -- otherwise "re-derived" only
     * covers one of the two ways a hand edit can land.
     */
    it('rejects a book whose routerInitcodeHash does not derive its own arcpadRouter', () => {
      const b = rawFixture()
      const hash = b.routerInitcodeHash as string
      expectFieldError(
        () =>
          parseAddressBook(
            { ...b, routerInitcodeHash: `${hash.slice(0, -1)}${hash.endsWith('b') ? 'c' : 'b'}` },
            CHAIN,
          ),
        'arcpadRouter',
      )
    })

    it('the real arc testnet book carries the deployed router', () => {
      // Pozitif kontrol, `hook bayraklari` testinin ikizi: negatif testler tek
      // baslarina "her seye kizan bir kontrol" ile de gecerdi.
      const live = loadAddressBook(5042002, join(REPO_ROOT, 'contracts', 'deploy'))
      expect(live.arcpadRouter).toBe(LIVE_ROUTER)
      expect(
        getCreate2Address({
          from: CREATE2_FACTORY,
          salt: ROUTER_SALT,
          bytecodeHash: live.routerInitcodeHash,
        }),
      ).toBe(live.arcpadRouter)
    })

    /**
     * DOKUZ ALAN, 36 CIFT -- ve HER CIFT SURULUR, sayilmakla yetinilmez.
     *
     * `graduationTarget` BILEREK DISARIDADIR: `applyGraduationTarget` indigi
     * an `arcpadLocker`a ESIT olur, yani onu listeye eklemek defteri
     * protokolun dogru calistigi gun kirmizi yapardi. Bu satir o karari
     * KAYDEDER; aksi halde bir sonraki okuyucu eksiklik sanip ekler.
     */
    it('rejects every one of the 36 aliased pairs across the nine distinct roles', () => {
      const fields = [
        'launchFactory',
        'feeEscrow',
        'governor',
        'protocolTreasury',
        'feeSchedule',
        'poolManager',
        'arcpadHook',
        'arcpadLocker',
        'arcpadRouter',
      ] as const
      const pairs: Array<[string, string]> = []
      for (let i = 0; i < fields.length; i += 1) {
        for (let j = i + 1; j < fields.length; j += 1) {
          pairs.push([fields[i] as string, fields[j] as string])
        }
      }
      expect(pairs).toHaveLength(36)

      const base = rawFixture()
      for (const [a, b] of pairs) {
        expectFieldError(() => parseAddressBook({ ...base, [b]: base[a] }, CHAIN), a)
      }

      // ...VE `graduationTarget` LOCKER'A ESIT OLABILIR. Bugun 0x0; yarin
      // arm edildiginde locker olacak ve defter YINE yuklenmelidir.
      expect(() =>
        parseAddressBook({ ...base, graduationTarget: base.arcpadLocker }, CHAIN),
      ).not.toThrow()
    })
  })
})
