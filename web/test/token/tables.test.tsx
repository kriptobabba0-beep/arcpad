import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { HexAddress, HolderRow, Page, ReadResult, TradeRow } from '@/components/read/types'
import { HoldersTable } from '@/components/token/HoldersTable'
import { TableTabs } from '@/components/token/TableTabs'
import { relativeAge, TradesTable } from '@/components/token/TradesTable'
import { feeBreakdown, walletDeltaWei } from '@/components/token/walletDelta'
import { BUY_ONE_USDC, CLIMBING, SELL_ONE_USDC, ok } from '../fixtures/readModel'

/**
 * SON ISLEMLER VE HOLDERS TABLOLARI.
 *
 * Sabitlenmis vektorler `../fixtures/readModel`ten: 1 USDC'lik alim K2'nin
 * OLCULMUS vektorudur ve bu testin tamami onun uzerinde duruyor --
 *
 *   curve tutari     987_654_320_987_654_320   -> 0,987654 USDC
 *   protokol payi      9_382_716_049_382_717   -> 0,009383
 *   creator payi       2_962_962_962_962_963   -> 0,002963
 *   CUZDANDAN CIKAN  1_000_000_000_000_000_000 -> 1,000000  (tam olarak butce)
 *
 * Bu vektor secildi cunku iki sayi birbirine benzemez: curve tutarini gosteren
 * bir mutant "0,987655" yazar, dogru olan "1,000000". Uydurma bir vektorde bu
 * fark bir basamak olabilir ve mutant hayatta kalir.
 */

const CURVE = CLIMBING.curve
/** Launch anindaki creator. KALICIDIR -- holders'taki `dev` rozeti buna bakar. */
const LAUNCH_CREATOR = CLIMBING.launchCreator
/** Creator DEGISTI (Faz 1d). Ucreti bugun bu cuzdan aliyor. */
const NEW_CREATOR = '0x00000000000000000000000000000000000000dd' as HexAddress
const RANDOM_TRADER = '0x00000000000000000000000000000000000000cc' as HexAddress

/** Alimin oldugu an. Yas testleri buna gore sabitlenir. */
const TRADE_AT = BUY_ONE_USDC.blockTime.getTime()

/**
 * CREATOR-DEGISTI FIXTURE'I.
 *
 * Iki satir, ve ikisi de `trader === feeCreator` karsilastirmasini YANLIS
 * yapar:
 *   - `DEV_TRADE`  : ilk creator'in islemi. Bugunun `feeCreator`'i o degil,
 *                    ama islem yapildiginda oydu -> `isDev = true`.
 *   - `LATE_TRADE` : bugunun `feeCreator`'inin, creator OLMADAN ONCEKI islemi
 *                    -> `isDev = false`.
 * `trader === overview.feeCreator` yazan bir mutant bu iki rozeti TERS
 * cevirir; indexer'in turettigi alani okuyan kod cevirmez.
 */
const DEV_TRADE: TradeRow = {
  ...BUY_ONE_USDC,
  eventSeq: 4_194_306n,
  trader: LAUNCH_CREATOR,
  isDev: true,
}

const LATE_TRADE: TradeRow = {
  ...SELL_ONE_USDC,
  eventSeq: 4_194_307n,
  trader: NEW_CREATOR,
  isDev: false,
}

function trades(rows: readonly TradeRow[], nextCursor: string | null = null): Page<TradeRow> {
  return { rows, nextCursor }
}

function holders(rows: readonly HolderRow[], nextCursor: string | null = null): Page<HolderRow> {
  return { rows, nextCursor }
}

function holder(address: string, balanceTok: bigint): HolderRow {
  // Faz 3'un `HolderRow`'u IKI alan tasir: `holder` ve `balanceTok`. `token`
  // ve `last_seq` view'de yok -- sorgu zaten tek bir token icin cagriliyor.
  return { holder: address, balanceTok }
}

/** Bir satirin `n`. hucresi. Kolon sirasi bilerek konumsal: basliklar da oyle. */
function cellAt(row: HTMLElement, index: number): HTMLElement {
  const cells = within(row).getAllByRole('cell')
  const cell = cells[index]
  if (!cell) throw new Error(`satirda ${index}. hucre yok (${cells.length} hucre var)`)
  return cell
}

/**
 * `<Money>`'nin YAZDIGI sey -- hucrenin tamami degil.
 *
 * Hucre ayrica gorsel etiketi ve ekran okuyucuya giden ucret dokumunu tasir;
 * ikisi de icinde rakam gecen dizeler. "Hucrede 0,987655 gecmiyor" demek
 * dokumu de dislardi ve iddia yanlis nedenle yesil kalirdi.
 */
function moneyText(cell: HTMLElement): string {
  const money = cell.querySelector<HTMLElement>('[data-rounding]')
  if (!money) throw new Error('hucrede <Money> yok')
  return money.textContent ?? ''
}

describe('<TradesTable> -- cuzdandan cikan tutar', () => {
  /** MUTANT 1: alim satirinda `quoteAmountWei` goster. */
  it('alim satiri ucret DAHIL tutari gosterir, curve tutarini degil', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const row = screen.getAllByRole('row')[1] as HTMLElement
    // Butce tam olarak 1 USDC: curve 0,987654 + 0,009383 + 0,002963.
    expect(moneyText(cellAt(row, 3))).toBe('1.000000')
    // Curve tutari (yukari yuvarlanmis hali) ekranda TUTAR olarak durmaz.
    expect(moneyText(cellAt(row, 3))).not.toBe('0.987655')
    expect(moneyText(cellAt(row, 3))).not.toBe('0.987654')
  })

  it('satim satiri ucret DUSULMUS tutari gosterir', () => {
    render(<TradesTable rows={[SELL_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const row = screen.getAllByRole('row')[1] as HTMLElement
    // 987654320987654319 - 12345679012345680 = 975308641975308639 -> 0,975308
    expect(moneyText(cellAt(row, 3))).toBe('0.975308')
  })

  it('alim YUKARI, satim ASAGI yuvarlanir -- maliyet eksik, gelir fazla gosterilmez', () => {
    render(<TradesTable rows={[BUY_ONE_USDC, SELL_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const rows = screen.getAllByRole('row')
    expect(cellAt(rows[1] as HTMLElement, 3).querySelector('[data-rounding]')).toHaveAttribute(
      'data-rounding',
      'up',
    )
    expect(cellAt(rows[2] as HTMLElement, 3).querySelector('[data-rounding]')).toHaveAttribute(
      'data-rounding',
      'down',
    )
  })

  it('dokum curve tutarini ve IKI ucret parcasini AYRI ve MUTLAK gosterir', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const cell = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 3)
    const sentence = cell.getAttribute('title') ?? ''

    expect(sentence).toContain('0.987655 to the curve')
    expect(sentence).toContain('0.009383 protocol fee')
    expect(sentence).toContain('0.002963 creator fee')
    // Ayni cumle ekran okuyucuya da gider; tooltip bir gorme bicimine bagli degil.
    expect(cell.textContent).toContain('0.987655 to the curve')
    // ORAN YOK. Olculdu: toplam ucret butcenin %1,2345679'u, %1,25'i degil --
    // ekrana yuzde yazmak aritmetigi tutarsiz gosterirdi.
    expect(sentence).not.toContain('%')
  })

  it('satimda dokum ucretleri DUSULMUS olarak anlatir', () => {
    render(<TradesTable rows={[SELL_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const cell = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 3)
    const sentence = cell.getAttribute('title') ?? ''
    expect(sentence).toContain('Received 0.975308 USDC')
    expect(sentence).toContain('less 0.009383 protocol fee')
  })
})

/**
 * UCRETSIZ SATIR: TIP DUZEYINDE ULASILAMAZ, DAVRANISI YINE DE SABIT.
 *
 * `listTrades` bugun onuc kolonun hepsini seciyor, yani `TradeRow`'un iki
 * ucret alani ZORUNLU ve asagidaki satir TypeScript'te KURULAMAZ -- bu yuzden
 * `unknown` uzerinden geciliyor ve gecis burada, tek yerde yapiliyor.
 *
 * NEDEN YINE DE OLCULUYOR: bu dallarin ULASILAMAZ oldugu yaziliydi ama
 * KOSULMUYORDU. Olculdu (2026-08-05): `walletDelta.ts`'teki iki `=== undefined`
 * korumasi da SILINDIGINDE `@arcpad/web` suiti 667/667 YESIL kaliyordu --
 * yani dallar "ulasilamaz" degil, "olculmemis" durumdaydi ve ikisi ayni sey
 * degil. Bir gun bir sorgu ucretleri secmeyi birakirsa (ya da satir bir JSON
 * sinirindan gecerse) dogru cevap `—`'dir; `quoteAmountWei`'ye DUSMEK,
 * kullaniciya banka ekstresiyle uyusmayan bir sayiyi "cuzdandan cikan" diye
 * etiketlemek olurdu. Yanlis sayi, eksik sayidan pahalidir.
 *
 * Bu blok o cevabi SABITLER; dallarin canliya ulasilabilir oldugunu IDDIA
 * ETMEZ.
 */
const FEELESS_TRADE = (() => {
  const row: Record<string, unknown> = { ...BUY_ONE_USDC }
  delete row.protocolFeeWei
  delete row.creatorFeeWei
  return row as unknown as TradeRow
})()

describe('<TradesTable> -- ucret parcalari gelmediginde', () => {
  it('`walletDeltaWei` ve `feeBreakdown` `null` doner -- curve tutarina DUSULMEZ', () => {
    expect(walletDeltaWei(FEELESS_TRADE)).toBeNull()
    expect(feeBreakdown(FEELESS_TRADE)).toBeNull()
    // NEGATIF KONTROL: ayni vektor ucretleriyle birlikte `null` DEGIL, ve
    // donen sayi curve tutari da degil. Bu satir olmadan yukaridaki iddia
    // "her zaman null donen bir fonksiyon" tarafindan da saglanirdi.
    expect(walletDeltaWei(BUY_ONE_USDC)).toBe(1_000_000_000_000_000_000n)
    expect(walletDeltaWei(BUY_ONE_USDC)).not.toBe(BUY_ONE_USDC.quoteAmountWei)
  })

  it('tablo "—" cizer ve curve tutarini TUTAR olarak yazmaz', () => {
    render(<TradesTable rows={[FEELESS_TRADE]} nextCursor={null} now={TRADE_AT} />)

    const cell = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 3)
    // `<Money>` HIC cizilmez -- bir tutar yok, bu yuzden bicimlendirilecek bir
    // sayi da yok.
    expect(cell.querySelector('[data-rounding]')).toBeNull()
    expect(cell.textContent).toContain('—')
    expect(cell.textContent).not.toContain('0.987654')
    expect(cell.textContent).not.toContain('0.987655')
    expect(cell.textContent).not.toContain('1.000000')
  })

  it('dokum cumlesi YARIM kurulmaz -- eksikligi soyler', () => {
    render(<TradesTable rows={[FEELESS_TRADE]} nextCursor={null} now={TRADE_AT} />)

    const cell = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 3)
    const sentence = cell.getAttribute('title') ?? ''
    expect(sentence).toBe('Fee breakdown is not available for this trade yet.')
    // "curve tutari X" deyip ucretleri atlayan yarim bir dokum, kullanicinin
    // odedigi tutari curve tutari sanmasina yol acar.
    expect(sentence).not.toContain('to the curve')
  })
})

describe('<TradesTable> -- yon, rozet, yas', () => {
  it('yonu HEM ok HEM sozcukle tasir; ok ekran okuyucudan gizlidir', () => {
    render(<TradesTable rows={[BUY_ONE_USDC, SELL_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const buy = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 0)
    const sell = cellAt(screen.getAllByRole('row')[2] as HTMLElement, 0)

    expect(buy.textContent).toContain('▲')
    expect(within(buy).getByText('Buy', { exact: false })).toBeInTheDocument()
    expect(sell.textContent).toContain('▼')
    expect(within(sell).getByText('Sell', { exact: false })).toBeInTheDocument()

    // Renk TEK BASINA anlam tasimaz, ama tasidigi anlam da dogru olmali.
    expect(buy.querySelector('.text-positive')).not.toBeNull()
    expect(sell.querySelector('.text-negative')).not.toBeNull()

    const arrow = buy.querySelector('[aria-hidden="true"]:not(.sm\\:hidden)')
    expect(arrow?.textContent).toBe('▲')
  })

  /** MUTANT 2: `isDev`'i `trader === overview.feeCreator` ile hesapla. */
  it('dev rozeti `row.isDev`ten gelir -- creator degistiginde gecmis yanlis boyanmaz', () => {
    render(<TradesTable rows={[DEV_TRADE, LATE_TRADE]} nextCursor={null} now={TRADE_AT} />)

    const devRow = screen.getAllByRole('row')[1] as HTMLElement
    const lateRow = screen.getAllByRole('row')[2] as HTMLElement

    // Bugunun `feeCreator`'i NEW_CREATOR; bu satirin trader'i O DEGIL ama
    // islem yapildiginda creator oydu.
    expect(within(devRow).getByText('dev')).toBeInTheDocument()
    // Bugunun `feeCreator`'i tam olarak bu adres -- ve satir yine de dev degil.
    expect(within(lateRow).queryByText('dev')).toBeNull()

    expect(cellAt(devRow, 4).textContent).toContain(LAUNCH_CREATOR.slice(0, 6))
    expect(cellAt(lateRow, 4).textContent).toContain(NEW_CREATOR.slice(0, 6))
  })

  it('yas `blockTime`ten okunur ve gelecege dusmus bir damga negatif gostermez', () => {
    expect(relativeAge(new Date('2026-07-31T12:00:00.000Z'), TRADE_AT)).toBe('0s')
    expect(relativeAge(new Date('2026-07-31T12:00:00.000Z'), TRADE_AT + 45_000)).toBe('45s')
    expect(relativeAge(new Date('2026-07-31T12:00:00.000Z'), TRADE_AT + 90_000)).toBe('1m')
    expect(relativeAge(new Date('2026-07-31T12:00:00.000Z'), TRADE_AT + 7_200_000)).toBe('2h')
    expect(relativeAge(new Date('2026-07-31T12:00:00.000Z'), TRADE_AT + 3 * 86_400_000)).toBe('3d')
    // Sunucu ile tarayici saati arasindaki fark "-3s" yazdirmamali.
    expect(relativeAge(new Date('2026-07-31T12:00:00.000Z'), TRADE_AT - 3_000)).toBe('0s')
    expect(relativeAge(new Date('not a timestamp'), TRADE_AT)).toBe('—')
  })

  it('yas hucresi <time dateTime> tasir -- ham damga makineye acik kalir', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT + 60_000} />)

    const cell = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 5)
    const time = cell.querySelector('time')
    expect(time).toHaveAttribute('dateTime', BUY_ONE_USDC.blockTime.toISOString())
    expect(time?.textContent).toBe('1m')
  })

  it('fiyat SATIRIN KENDI rezervlerinden gelir', () => {
    // mulDiv(5279654320987654320, 1e18, 872276046879238259473675895) = 6052733351
    // -> 0,0₈6052 (dokuz sifirli oncu kosu bastirilmis hali)
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)
    expect(cellAt(screen.getAllByRole('row')[1] as HTMLElement, 2).textContent).toContain('6052')
  })
})

describe('<TradesTable> -- tablo semantigi ve hizalama', () => {
  it('gorsel olarak gizli bir <caption> tasir', () => {
    const { container } = render(
      <TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT} />,
    )
    const caption = container.querySelector('caption')
    expect(caption).not.toBeNull()
    expect(caption?.className.split(/\s+/)).toContain('sr-only')
    expect(caption?.textContent).toContain('Recent trades')
  })

  it('her baslik `scope="col"` tasir ve SIRALANABILIR KOLON YOKTUR', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)

    const heads = screen.getAllByRole('columnheader')
    expect(heads).toHaveLength(6)
    for (const head of heads) {
      expect(head).toHaveAttribute('scope', 'col')
      // Sira ZINCIR sirasidir; kullanici sıralamasi onu bozar.
      expect(head.querySelector('button')).toBeNull()
      expect(head.getAttribute('aria-sort')).toBeNull()
    }
  })

  it('butun sayisal hucreler saga hizali ve tabular-nums', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} symbol="DIFF" now={TRADE_AT} />)

    const row = screen.getAllByRole('row')[1] as HTMLElement
    // Amount, Price, USDC, Age -- Type ve Trader sayisal degil.
    for (const index of [1, 2, 3, 5]) {
      const classes = cellAt(row, index).className.split(/\s+/)
      expect(classes).toContain('text-right')
      expect(classes).toContain('tabular-nums')
    }

    const heads = screen.getAllByRole('columnheader')
    for (const index of [1, 2, 3, 5]) {
      expect((heads[index] as HTMLElement).className.split(/\s+/)).toContain('text-right')
    }
    expect(heads[1]?.textContent).toBe('Amount (DIFF)')
  })

  it('DAR EKRANDA YATAY KAYDIRMA YOK -- hicbir sarmalayici overflow acmaz', () => {
    const { container } = render(
      <TradesTable rows={[BUY_ONE_USDC, SELL_ONE_USDC]} nextCursor={null} now={TRADE_AT} />,
    )
    for (const node of container.querySelectorAll<HTMLElement>('*')) {
      for (const cls of node.className.split?.(/\s+/) ?? []) {
        expect(cls).not.toMatch(/^(max-sm:)?overflow(-x)?-(auto|scroll)$/)
      }
    }
    // Satirlar dar ekranda karta doner; kart duzeni sinif recetesinde durur.
    const row = screen.getAllByRole('row')[1] as HTMLElement
    expect(row.className).toContain('max-sm:block')
    expect(cellAt(row, 0).className).toContain('max-sm:flex')
  })

  it('dar ekranin gorsel etiketi ekran okuyucuda IKINCI kez okunmaz', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor={null} now={TRADE_AT} />)
    const cell = cellAt(screen.getAllByRole('row')[1] as HTMLElement, 2)
    const label = cell.querySelector('.sm\\:hidden')
    expect(label?.textContent).toBe('Price')
    expect(label).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('<HoldersTable>', () => {
  /** MUTANT 3: curve'u listeden cikarmayi kaldir. */
  it('curve LISTEDE DEGILDIR -- arzin satilmamis kismi bir holder satiri degildir', () => {
    render(
      <HoldersTable
        rows={[
          holder(CURVE, 592376046879238259473675895n),
          holder(RANDOM_TRADER, 164000000000000000000000n),
        ]}
        nextCursor={null}
        curve={CURVE}
      />,
    )

    expect(screen.getAllByRole('row')).toHaveLength(2) // baslik + tek holder
    expect(screen.queryByText(`${CURVE.slice(0, 6)}…${CURVE.slice(-4)}`)).toBeNull()
    expect(
      screen.getByText(`${RANDOM_TRADER.slice(0, 6)}…${RANDOM_TRADER.slice(-4)}`),
    ).toBeInTheDocument()
  })

  it('curve karsilastirmasi buyuk/kucuk harfe duyarsizdir', () => {
    // Cagiran taraf `viem`den gelen EIP-55 checksum dizesini tutuyor olabilir.
    const checksummed = ('0x' + CURVE.slice(2).toUpperCase()) as HexAddress
    render(
      <HoldersTable
        rows={[holder(CURVE, 5n), holder(RANDOM_TRADER, 164000000000000000000000n)]}
        nextCursor={null}
        curve={checksummed}
      />,
    )
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  /** MUTANT 4: "curve haric" dipnotunu sil. */
  it('yuzdelerin %100 vermemesini ACIKCA soyler', () => {
    render(
      <HoldersTable
        rows={[holder(RANDOM_TRADER, 164000000000000000000000n)]}
        nextCursor={null}
        curve={CURVE}
      />,
    )
    expect(
      screen.getByText('Excludes the curve, which holds the unsold supply.'),
    ).toBeInTheDocument()
  })

  it('sira, bakiye ve arz payini yazar; pay IKI ondalik ve tamamen bigint', () => {
    render(
      <HoldersTable
        rows={[
          // 5e25 / 1e27 = %5,00
          holder(LAUNCH_CREATOR, 50000000000000000000000000n),
          // 1e26'nin BIR ALTI. bigint: floor(999,99...) -> %9,99
          // IEEE-754: Number(9999...9) 1e26'ya yuvarlanir -> %10,00 (yanlis).
          holder(RANDOM_TRADER, 99999999999999999999999999n),
        ]}
        nextCursor={null}
        curve={CURVE}
        launchCreator={LAUNCH_CREATOR}
        symbol="DIFF"
      />,
    )

    const rows = screen.getAllByRole('row')
    expect(cellAt(rows[1] as HTMLElement, 0).textContent).toContain('1')
    expect(cellAt(rows[1] as HTMLElement, 3).textContent).toContain('5.00%')
    expect(cellAt(rows[2] as HTMLElement, 0).textContent).toContain('2')
    expect(cellAt(rows[2] as HTMLElement, 3).textContent).toContain('9.99%')
    expect(cellAt(rows[2] as HTMLElement, 3).textContent).not.toContain('10.00%')

    expect(screen.getAllByRole('columnheader')[2]?.textContent).toBe('Balance (DIFF)')
  })

  it('dev rozeti `launchCreator`a bakar -- degisebilen `feeCreator`a degil', () => {
    render(
      <HoldersTable
        rows={[holder(LAUNCH_CREATOR, 5000000000000000000000n), holder(NEW_CREATOR, 1000n)]}
        nextCursor={null}
        curve={CURVE}
        launchCreator={LAUNCH_CREATOR}
      />,
    )
    const rows = screen.getAllByRole('row')
    expect(within(rows[1] as HTMLElement).getByText('dev')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).queryByText('dev')).toBeNull()
  })

  it('sayisal hucreler saga hizali ve tabular-nums; caption gizli', () => {
    const { container } = render(
      <HoldersTable
        rows={[holder(RANDOM_TRADER, 164000000000000000000000n)]}
        nextCursor={null}
        curve={CURVE}
      />,
    )

    const row = screen.getAllByRole('row')[1] as HTMLElement
    for (const index of [0, 2, 3]) {
      const classes = cellAt(row, index).className.split(/\s+/)
      expect(classes).toContain('text-right')
      expect(classes).toContain('tabular-nums')
    }
    expect(container.querySelector('caption')?.className.split(/\s+/)).toContain('sr-only')
    for (const head of screen.getAllByRole('columnheader')) {
      expect(head).toHaveAttribute('scope', 'col')
      expect(head.querySelector('button')).toBeNull()
    }
  })
})

describe('bos durumlar -- ucu de ayri', () => {
  /** MUTANT 6: bos-islem metnini bos tabloyla degistir. */
  it('hic islem yoksa bir CUMLE ve al-sat paneline bir baglanti cizer', () => {
    render(<TradesTable rows={[]} nextCursor={null} tradePanelHref="#trade" />)

    expect(screen.getByText('No trades yet. Be the first.')).toBeInTheDocument()
    // Bos bir tablo govdesi ya da iskelet DEGIL: bu urunun ilk gununde HER
    // token boyle ve bos bir tablo dogru olan durumu hata gibi gosterir.
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('link', { name: 'Buy this token' })).toHaveAttribute('href', '#trade')
  })

  it('holder yoksa AYRI bir metin cizer -- "curve haric" kararinin sonucu', () => {
    // Launch'tan hemen sonra: arzin tamami curve'de, curve haric tutuluyor.
    render(
      <HoldersTable
        rows={[holder(CURVE, 1000000000000000000000000000n)]}
        nextCursor={null}
        curve={CURVE}
      />,
    )

    expect(
      screen.getByText('No holders yet — the curve holds the entire supply.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    // Iki bos durum AYNI cumle degildir.
    expect(screen.queryByText('No trades yet. Be the first.')).toBeNull()
  })

  it('veritabani dustugunde iki sekme de aciklayici kutu gosterir', async () => {
    const user = userEvent.setup()
    const down: ReadResult<Page<never>> = { ok: false, reason: 'unavailable', indexer: null }

    render(<TableTabs trades={down} holders={down} />)

    const tradesPanel = document.getElementById('token-tables-panel-trades') as HTMLElement
    expect(
      within(tradesPanel).getByText('Trade history is unavailable right now.'),
    ).toBeInTheDocument()
    // Sayfanin geri kalanina guvenilip guvenilemeyecegini SOYLER.
    expect(
      within(tradesPanel).getByText(/read the chain directly and are unaffected/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Holders' }))
    expect(screen.getByText('Holder data is unavailable right now.')).toBeInTheDocument()

    // Dusmus okumada sayi YAZILMAZ: "(0)" ile "sayamiyoruz" ayni sey degil.
    expect(screen.getByRole('tab', { name: 'Trades' })).toBeInTheDocument()
  })

  it('bir sekme dusup oteki ayakta kalabilir', () => {
    render(
      <TableTabs
        trades={ok(trades([BUY_ONE_USDC]))}
        holders={{ ok: false, reason: 'unavailable', indexer: null }}
        overview={CLIMBING}
      />,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Trades (1)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Holders' })).toBeInTheDocument()
  })
})

describe('keyset sayfalama', () => {
  /** MUTANT 5: ikinci siralama anahtarini sil. */
  it('esit bakiyeli holder iki sayfada birden gelse bile BIR KEZ cizilir', async () => {
    const user = userEvent.setup()

    // `(balanceTok DESC, holder ASC)`in ikinci anahtari dusurulduğunde olan
    // sey budur: esit bakiyeli B, birinci sayfanin sonunda VE ikinci sayfanin
    // basinda cikar.
    const A = holder('0x00000000000000000000000000000000000000a1', 300000000000000000000000000n)
    const B = holder('0x00000000000000000000000000000000000000b2', 100000000000000000000000000n)
    const C = holder('0x00000000000000000000000000000000000000c3', 100000000000000000000000000n)

    const loadMore = vi.fn(async () => ok(holders([B, C])))

    render(<HoldersTable rows={[A, B]} nextCursor="cursor-1" curve={CURVE} loadMore={loadMore} />)
    expect(screen.getAllByRole('row')).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: 'Load more holders' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4))

    // Imlec gecti, B tekrarlanmadi, sira numaralari kaymadi.
    expect(loadMore).toHaveBeenCalledWith('cursor-1')
    const shortB = `${B.holder.slice(0, 6)}…${B.holder.slice(-4)}`
    expect(screen.getAllByText(shortB)).toHaveLength(1)
    const rows = screen.getAllByRole('row')
    expect(cellAt(rows[1] as HTMLElement, 0).textContent).toContain('1')
    expect(cellAt(rows[2] as HTMLElement, 0).textContent).toContain('2')
    expect(cellAt(rows[3] as HTMLElement, 0).textContent).toContain('3')
  })

  it('islemler eklenerek gelir ve imlec bittiginde dugme kaybolur', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn(async () => ok(trades([LATE_TRADE])))

    render(
      <TradesTable
        rows={[BUY_ONE_USDC]}
        nextCursor="seq-4194304"
        loadMore={loadMore}
        now={TRADE_AT}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Load more trades' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(loadMore).toHaveBeenCalledWith('seq-4194304')
    expect(screen.queryByRole('button', { name: 'Load more trades' })).toBeNull()
  })

  it('sonraki sayfa dustugunde YUKLENMIS satirlar yerinde kalir', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn(async () => ({
      ok: false as const,
      reason: 'unavailable' as const,
      indexer: null,
    }))

    render(
      <TradesTable rows={[BUY_ONE_USDC]} nextCursor="seq-1" loadMore={loadMore} now={TRADE_AT} />,
    )

    await user.click(screen.getByRole('button', { name: 'Load more trades' }))
    expect(
      await screen.findByText('Could not load more rows — the rows above are still current.'),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('`loadMore` verilmediginde dugme HIC cizilmez', () => {
    render(<TradesTable rows={[BUY_ONE_USDC]} nextCursor="seq-1" now={TRADE_AT} />)
    expect(screen.queryByRole('button', { name: 'Load more trades' })).toBeNull()
  })
})

describe('<TableTabs>', () => {
  it('iki sekme cizer, sayilari basarili okumadan alir ve panel degistirir', async () => {
    const user = userEvent.setup()

    render(
      <TableTabs
        trades={ok(trades([BUY_ONE_USDC, SELL_ONE_USDC]))}
        holders={ok(holders([holder(RANDOM_TRADER, 164000000000000000000000n)]))}
        overview={CLIMBING}
        now={TRADE_AT}
      />,
    )

    const tradesTab = screen.getByRole('tab', { name: 'Trades (2)' })
    expect(tradesTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('table')).toHaveAccessibleName(/Recent trades/)

    await user.click(screen.getByRole('tab', { name: 'Holders (1)' }))
    expect(screen.getByRole('table')).toHaveAccessibleName(/Token holders/)
    // Gizlenen panel AGACTA kalir, `aria-controls` kirilmaz.
    expect(document.getElementById('token-tables-panel-trades')).not.toBeNull()
    expect(tradesTab).toHaveAttribute('aria-controls', 'token-tables-panel-trades')
  })

  it('overview verildiginde curve holders listesinden cikar', () => {
    render(
      <TableTabs
        trades={ok(trades([]))}
        holders={ok(holders([holder(CURVE, 1000n)]))}
        overview={CLIMBING}
      />,
    )
    // Trades paneli acik; holders paneli gizli ama agacta.
    expect(screen.getByText('No trades yet. Be the first.')).toBeInTheDocument()
    expect(
      within(document.getElementById('token-tables-panel-holders') as HTMLElement).getByText(
        'No holders yet — the curve holds the entire supply.',
      ),
    ).toBeInTheDocument()
  })
})

/**
 * =========================================================================
 *  SEKME ETIKETI, CIZILEN SATIRLARI SAYAR -- VE BU, DUZELTMENIN ICINDEKI HATA.
 * =========================================================================
 *
 * Token sayfasi `loadMoreTrades`/`loadMoreHolders` gecmeye baslayana kadar
 * tablo hicbir zaman ikinci sayfayi gormuyordu, dolayisiyla "gelen sayfanin
 * uzunlugu" ile "ekrandaki satir sayisi" HER ZAMAN ayniydi. Boslugu kapatan
 * degisiklik ikisini ayirdi: 50 satirin ustunde "Trades (25)" yazan bir
 * etiket, tam olarak duzeltilen sinifin duzeltmenin icinde yeniden dogmus
 * hâli olurdu. Bu yuzden sayfalama durumu `<TableTabs>`e tasindi ve etiket ile
 * tablo AYNI diziyi sayiyor.
 */
describe('<TableTabs> -- sayfalama ve etiketteki sayi', () => {
  it('sunucu eyleminden gelen sayfa eklenir VE etiketteki sayi onunla birlikte artar', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn(async () => ok(trades([LATE_TRADE])))

    render(
      <TableTabs
        trades={ok(trades([BUY_ONE_USDC, SELL_ONE_USDC], 'seq-4194304'))}
        holders={ok(holders([]))}
        overview={CLIMBING}
        loadMoreTrades={loadMore}
        now={TRADE_AT}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Trades (2)' })).toBeInTheDocument()
    // Basliksiz satir dahil 3: 1 baslik + 2 govde.
    expect(screen.getAllByRole('row')).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: 'Load more trades' }))

    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4))
    expect(loadMore).toHaveBeenCalledWith('seq-4194304')
    // MUTANT: sayiyi `valueOf(trades).rows.length`ten al -> burada "(2)" yazar.
    expect(screen.getByRole('tab', { name: 'Trades (3)' })).toBeInTheDocument()
  })

  it('`loadMore` gecilmediginde dugme HIC cizilmez -- eski davranis aynen duruyor', () => {
    render(
      <TableTabs
        trades={ok(trades([BUY_ONE_USDC], 'seq-4194304'))}
        holders={ok(holders([]))}
        overview={CLIMBING}
        now={TRADE_AT}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Load more trades' })).toBeNull()
  })

  it('holders etiketi CURVE satirini saymaz, cunku tablo onu cizmiyor', () => {
    // SQL zaten curve'u disliyor; bu satir son savunma hattinin karsiligi.
    // Etiket `page.rows.length` okusaydi "(2)" yazardi ve tabloda 1 satir
    // olurdu -- basligin altindaki sayinin tablodan farkli olmasi.
    render(
      <TableTabs
        trades={ok(trades([]))}
        holders={ok(holders([holder(CURVE, 1000n), holder(RANDOM_TRADER, 500n)]))}
        overview={CLIMBING}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Holders (1)' })).toBeInTheDocument()
  })

  it('holders sayfasi da eklenir ve sayisi buyur', async () => {
    const user = userEvent.setup()
    const A = holder('0x00000000000000000000000000000000000000a1', 300000000000000000000000000n)
    const B = holder('0x00000000000000000000000000000000000000b2', 100000000000000000000000000n)
    const loadMore = vi.fn(async () => ok(holders([B])))

    render(
      <TableTabs
        trades={ok(trades([]))}
        holders={ok(
          holders([A], '300000000000000000000000000:0x00000000000000000000000000000000000000a1'),
        )}
        overview={CLIMBING}
        loadMoreHolders={loadMore}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'Holders (1)' }))
    await user.click(screen.getByRole('button', { name: 'Load more holders' }))

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Holders (2)' })).toBeInTheDocument(),
    )
    expect(loadMore).toHaveBeenCalledWith(
      '300000000000000000000000000:0x00000000000000000000000000000000000000a1',
    )
  })
})
