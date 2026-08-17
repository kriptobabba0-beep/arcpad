import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_FIELDS, type LaunchFields } from '@/components/create/fields'
import {
  type LaunchDriver,
  launchedFromReceipt,
  launchRequest,
  useLaunch,
} from '@/components/create/useLaunch'
import { renderWithProviders } from '../ui/harness'
import { CREATOR, FACTORY, launchedLog, SMOKE_CURVE, SMOKE_TOKEN } from './fixtures'

const GOOD: LaunchFields = { ...EMPTY_FIELDS, name: 'Diffusion', symbol: 'DIFF' }

/** Hook'u calistiran ve durumunu ekrana yazan en kucuk bilesen. */
function Probe({ driver, fields = GOOD }: { driver: LaunchDriver; fields?: LaunchFields }) {
  const launch = useLaunch({ driver })
  return (
    <div>
      <span data-testid="status">{launch.status}</span>
      <span data-testid="token">{launch.result?.token ?? ''}</span>
      <span data-testid="failure">{launch.failure?.name ?? ''}</span>
      <span data-testid="errors">{Object.keys(launch.fieldErrors).join(',')}</span>
      <button type="button" onClick={() => void launch.submit(fields)}>
        go
      </button>
    </div>
  )
}

function stubDriver(overrides: Partial<LaunchDriver> = {}): LaunchDriver {
  return {
    simulate: vi.fn(async () => undefined),
    write: vi.fn(async () => '0xfeed' as const),
    receipt: vi.fn(async () => ({
      logs: [launchedLog({ token: SMOKE_TOKEN, curve: SMOKE_CURVE })],
    })),
    ...overrides,
  }
}

/**
 * `web/` KOKU, cwd'den bulunur.
 *
 * `import.meta.url` DENENDI VE CALISMIYOR: Vite bileşen projesinde onu kendi
 * sarmalayicisina cevirdigi icin cozulen yol `test/create/undefined` cikti --
 * yani test, olcmek istedigi seyi degil bir ENOENT'i olcuyordu. cwd ise
 * `pnpm --filter @arcpad/web test` altinda her zaman `web/`dir; depo kokunden
 * kosulma ihtimaline karsi ikinci bir aday denenir ve ikisi de tutmazsa test
 * SESSIZCE gecmek yerine acikca patlar.
 */
const WEB_ROOT = existsSync(join(process.cwd(), 'components', 'create'))
  ? process.cwd()
  : join(process.cwd(), 'web')

function readWebSource(relative: string): string {
  const path = join(WEB_ROOT, relative)
  if (!existsSync(path)) throw new Error(`cannot find ${relative} from cwd ${process.cwd()}`)
  return readFileSync(path, 'utf8')
}

/**
 * IKI GIRIS NOKTASI, VE BAYRAK GERCEKTEN TASINIR.
 *
 * `launchRequest` bayragi YOKSAYSAYDI hicbir sey kirmizi olmazdi: cagri
 * basarili olur, token dogar, ve buyback SESSIZCE kapali kalir. Kullanicinin
 * isaretledigi kutu ile zincirde olan sey ancak burada esitlenir.
 */
describe('launchRequest -- buyback giris noktasi secer', () => {
  it('kutu KAPALIYKEN uc argumanli `launch` cagrilir', () => {
    const r = launchRequest(FACTORY, { name: 'D', symbol: 'D', uri: '', buyback: false })
    expect(r.functionName).toBe('launch')
    expect(r.args).toHaveLength(3)
  })

  it('kutu ACIKKEN `launchWithBuyback` cagrilir ve dorduncu arguman TRUE olur', () => {
    const r = launchRequest(FACTORY, { name: 'D', symbol: 'D', uri: '', buyback: true })
    expect(r.functionName).toBe('launchWithBuyback')
    expect(r.args).toHaveLength(4)
    expect(r.args[3]).toBe(true)
  })

  /// ANTI-VAKUM: iki dal GERCEKTEN farkli istekler uretir.
  it('iki dal ayni istegi uretmez', () => {
    const off = launchRequest(FACTORY, { name: 'D', symbol: 'D', uri: '', buyback: false })
    const on = launchRequest(FACTORY, { name: 'D', symbol: 'D', uri: '', buyback: true })
    expect(off.functionName).not.toBe(on.functionName)
  })
})

describe('launchRequest -- `value` YOKTUR', () => {
  it('istek nesnesinde `value` anahtari bulunmaz', () => {
    const request = launchRequest(FACTORY, {
      name: 'Diffusion',
      symbol: 'DIFF',
      uri: '',
      buyback: false,
    })
    /*
     * `LaunchFactory.launch` `payable` DEGILDIR. Deger tasiyan bir cagri
     * VERI TASIMAYAN bir revert verir ve o revert, disaridan bakildiginda bir
     * CREATE2 carpismasindan ve gazin bitmesinden ayirt EDILEMEZ.
     */
    expect(Object.keys(request)).not.toContain('value')
    expect(request.functionName).toBe('launch')
    expect(request.args).toEqual(['Diffusion', 'DIFF', ''])
  })

  it('surucuye FIILEN verilen nesnede de `value` yoktur', async () => {
    const user = userEvent.setup()
    // Tip parametresi surucunun IMZASINDAN alinir, boylece yakalanan
    // argumanlar `unknown` degil `LaunchRequest`tir ve `value` anahtari bir
    // iddiaya konu olabilir.
    const simulate = vi.fn<LaunchDriver['simulate']>(async () => undefined)
    const write = vi.fn<LaunchDriver['write']>(async () => '0xfeed')
    renderWithProviders(<Probe driver={stubDriver({ simulate, write })} />, { connected: true })

    await user.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('launched'))

    // Iki cagri da ayni nesneyi alir; mutantin saklanabilecegi ikinci bir yer yok.
    expect(Object.keys(simulate.mock.calls[0]?.[0] ?? {})).not.toContain('value')
    expect(Object.keys(write.mock.calls[0]?.[0] ?? {})).not.toContain('value')
  })

  it('degersiz cagrinin BOS REVERT’i kullaniciya sebepsiz-red olarak anlatilir', async () => {
    const user = userEvent.setup()
    /*
     * `payable` olmayan bir fonksiyona deger gondermek, CREATE2 carpismasi ve
     * gazin bitmesi disaridan BIREBIR ayni gorunur: `0x` veri, secici yok,
     * sebep yok. `decodeArcpadError`in dorduncu dali bunu TAHMIN ETMEDEN
     * anlatir; Task 14'un bos-revert dali budur.
     */
    const emptyRevert = Object.assign(new Error('reverted'), { data: '0x' })
    renderWithProviders(
      <Probe
        driver={stubDriver({
          simulate: vi.fn(async () => {
            throw emptyRevert
          }),
        })}
      />,
      { connected: true },
    )

    await user.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByTestId('failure')).toHaveTextContent('EmptyRevert'))
  })
})

describe('launchedFromReceipt -- adres MAKBUZDAN gelir', () => {
  it('olaydaki adresler dondurulur', () => {
    const logs = [launchedLog({ token: SMOKE_TOKEN, curve: SMOKE_CURVE })]
    expect(launchedFromReceipt(logs, FACTORY)).toEqual({ token: SMOKE_TOKEN, curve: SMOKE_CURVE })
  })

  it('ARAYA GIREN BIR LAUNCH: tahmin edilen adres yanlis, makbuzdaki dogru', () => {
    /*
     * `predictAddresses` salt'a `launchCount`'u katar ve `launchCount`
     * GLOBALDIR: tahmin ile gonderim arasinda baska birinin launch'i araya
     * girerse tahmin gecersiz olur. Zincirin FIILEN deploy ettigi adres
     * tahminden baskadir ve ekranda gorunmesi gereken odur -- yanlis bir adres
     * kopyalanip paylasildiginda dogrudan bir dolandiricilik yoludur.
     */
    const predicted = '0x000000000000000000000000000000000000dEaD'
    const logs = [launchedLog({ token: SMOKE_TOKEN, curve: SMOKE_CURVE })]

    const found = launchedFromReceipt(logs, FACTORY)
    expect(found?.token).toBe(SMOKE_TOKEN)
    expect(found?.token).not.toBe(predicted)
  })

  it('FACTORY DISINDA bir kontratin `Launched` logu REDDEDILIR', () => {
    // Olay imzasi bir sir degildir: bir taklitci ayni topic'lerle log yayip
    // bu ekrani kendi sectigi adrese yonlendirebilirdi.
    const logs = [launchedLog({ token: SMOKE_TOKEN, curve: SMOKE_CURVE, emitter: CREATOR })]
    expect(launchedFromReceipt(logs, FACTORY)).toBeNull()
  })

  it('`predictAddresses` /create yuzeyinde HIC CAGRILMAZ', () => {
    // Kaynak duzeyinde bir kapi. Fonksiyon arayuzde kullanilmaz; Task 5'in
    // harness'i onu makbuzdaki adresle karsilastirmak icin kullanir ve TEK
    // tuketicisi odur.
    for (const file of [
      'components/create/useLaunch.ts',
      'components/create/LaunchForm.tsx',
      'components/create/LaunchResult.tsx',
      'components/create/TokenPreviewCard.tsx',
      'app/create/page.tsx',
    ]) {
      const source = readWebSource(file)
      expect(source).not.toMatch(/predictAddresses\s*\(/)
      expect(source).not.toMatch(/functionName:\s*['"]predictAddresses['"]/)
    }
  })
})

describe('useLaunch -- yasam dongusu', () => {
  it('draft -> ... -> launched, ve adres olaydan okunur', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Probe driver={stubDriver()} />, { connected: true })

    expect(screen.getByTestId('status')).toHaveTextContent('draft')
    await user.click(screen.getByRole('button', { name: 'go' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('launched'))
    expect(screen.getByTestId('token')).toHaveTextContent(SMOKE_TOKEN)
  })

  it('SIMULASYON IKINCI KAPIDIR: kontrat reddederse cuzdan HIC ACILMAZ', async () => {
    const user = userEvent.setup()
    const write = vi.fn(async () => '0xfeed' as const)
    const simulate = vi.fn(async () => {
      throw Object.assign(new Error('reverted'), { reason: 'NameTooLong' })
    })

    /*
     * Bu vaka istemci dogrulamasinin ARTIK YAKALAMADIGI durumu temsil eder:
     * ad istemciye gore gecerli ama kontrat baska bir sinir dayatiyor.
     * Simulasyon kaldirilirsa kullanici cuzdan penceresini acar, imzalar ve
     * gaz oder; simulasyonla ogrendigi sey aynidir ve BEDAVADIR.
     */
    renderWithProviders(<Probe driver={stubDriver({ simulate, write })} />, { connected: true })
    await user.click(screen.getByRole('button', { name: 'go' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('failed'))
    expect(simulate).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('istemci dogrulamasi 36 baytlik ismi simulasyona HIC GOTURMEZ', async () => {
    const user = userEvent.setup()
    const simulate = vi.fn(async () => undefined)
    renderWithProviders(
      <Probe driver={stubDriver({ simulate })} fields={{ ...GOOD, name: '\u{1F680}'.repeat(9) }} />,
      { connected: true },
    )

    await user.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByTestId('errors')).toHaveTextContent('name'))
    expect(simulate).not.toHaveBeenCalled()
    expect(screen.getByTestId('status')).toHaveTextContent('draft')
  })

  it('makbuz geldi ama `Launched` cikmadiysa BASARI SAYILMAZ', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Probe driver={stubDriver({ receipt: vi.fn(async () => ({ logs: [] })) })} />,
      { connected: true },
    )

    await user.click(screen.getByRole('button', { name: 'go' }))
    // Gosterecek bir token adresi yoksa, tahmin edilecek bir tane de yoktur.
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('failed'))
    expect(screen.getByTestId('token').textContent).toBe('')
  })

  it('cuzdan reddi bir HATA degil bir KARARDIR ve oyle adlandirilir', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Probe
        driver={stubDriver({
          write: vi.fn(async () => {
            throw Object.assign(new Error('User rejected'), { code: 4001 })
          }),
        })}
      />,
      { connected: true },
    )

    await user.click(screen.getByRole('button', { name: 'go' }))
    await waitFor(() => expect(screen.getByTestId('failure')).toHaveTextContent('UserRejected'))
  })
})
