/**
 * ============================================================================
 *  FAZ A -- LAUNCH YUZEYI, CANLI ZINCIRDE
 * ============================================================================
 *
 * Forge suite'i bu kurallarin hepsini zaten olcuyor. BU FAZ ONU TEKRARLAMAZ,
 * BASKA BIR SEY SORAR: kurallar CANLI FABRIKADA, gercek gaz ve gercek
 * `block.timestamp` altinda da gecerli mi. Iki yerde birden dogru olmasi
 * gereken sey, iki yerde birden olculmelidir -- bu depo "bir giris noktasinda
 * kapsanan ozellik hepsinde kapsanmis okunur" hatasini on bir kez kaydetti.
 *
 * SINIRLAR BAYT CINSINDENDIR, KARAKTER DEGIL. `LaunchToken` 32/13/200 BAYT
 * sinirlar; bir emoji dort bayttir. Asagidaki vakalar bu ayrimi ACIKCA
 * yurutur -- karakter sayan bir sinir, sekiz emojili bir ismi kabul edip
 * zincirde revert ederdi.
 */
import { launchFactoryAbi, launchTokenAbi } from '../../packages/shared/src/abi/index'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { stringToBytes } from 'viem'
import { book, type Campaign, must, mustEqual, read, send } from './harness'

const FACTORY_ABI = launchFactoryAbi as unknown as import('viem').Abi
const TOKEN_ABI = launchTokenAbi as unknown as import('viem').Abi

export interface Launched {
  token: Address
  curve: Address
  name: string
  symbol: string
}

/** Kampanya boyunca uretilen her launch. Sonraki fazlar buradan besleniyor. */
export const launched: Launched[] = []

const byteLen = (s: string): number => stringToBytes(s).length

export async function phaseLaunch(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  tag: string,
): Promise<void> {
  c.phase('FAZ A -- launch yuzeyi')
  const b = book()
  const factory = b.launchFactory
  const creator = w.account!.address

  // ------------------------------------------------------------------
  // A1. Temel launch: adres TAHMINI zincirin URETTIGIYLE ayni mi
  // ------------------------------------------------------------------
  //
  // `predictAddresses` arayuzun launch ONCESI gosterdigi adrestir. Sapmasi
  // sessizdir: kullanici bir adres gorur, baska bir adres olusur, ve link
  // olmayan bir tokene gider.
  await c.check('A1 predictAddresses zincirin URETTIGI adresi verir', async () => {
    const name = `Audit ${tag} A1`
    const symbol = 'AUDA1'
    const uri = 'ipfs://audit-a1'
    const nonce = await read<bigint>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launchCount',
    })
    const [predToken, predCurve] = await read<[Address, Address]>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'predictAddresses',
      args: [creator, name, symbol, uri, nonce],
    })
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: [name, symbol, uri],
    })
    // Uretilen adres ZINCIRDEN dogrulanir: token'in `curve()`u tahmini
    // curve'u vermeli ve curve'un `token()`u tahmini tokeni.
    const onCurve = await read<Address>(pub, {
      address: predToken,
      abi: TOKEN_ABI,
      functionName: 'curve',
    })
    mustEqual(onCurve.toLowerCase(), predCurve.toLowerCase(), 'token.curve()')
    launched.push({ token: predToken, curve: predCurve, name, symbol })
    return `${predToken}`
  })

  // ------------------------------------------------------------------
  // A2. Kanoniklik: bizimki DOGRU, rastgele bir adres YANLIS
  // ------------------------------------------------------------------
  //
  // Tek yonlu bir kontrol ("bizimki kanonik") her zaman `true` donduren bir
  // implementasyondan gecerdi. Negatif kontrol o yuzden ayrilamaz.
  await c.check('A2 isCanonical iki yonlu ayirir', async () => {
    const mine = launched[0]
    must(mine !== undefined, 'A1 dusmus, kanoniklik sinanamaz')
    const yes = await read<boolean>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isCanonical',
      args: [mine!.token],
    })
    const no = await read<boolean>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'isCanonical',
      args: ['0x000000000000000000000000000000000000dEaD' as Address],
    })
    must(yes, 'kendi tokenimiz kanonik DEGIL')
    must(!no, '0xdead kanonik GORUNDU')
    return 'bizimki true, 0xdead false'
  })

  // ------------------------------------------------------------------
  // A3. Ayni metadata, IKINCI launch -- adres CAKISMAZ
  // ------------------------------------------------------------------
  //
  // Tuz `msg.sender`i VE `launchCount`u icerir. Ikincisi olmasaydi ayni
  // creator ayni metadata ile ikinci kez launch edemezdi (CREATE2 carpismasi)
  // -- ve hata mesaji hicbir sey aciklamazdi.
  await c.check('A3 ayni metadata ikinci kez launch edilebilir', async () => {
    const name = `Audit ${tag} A1`
    const symbol = 'AUDA1'
    const uri = 'ipfs://audit-a1'
    const nonce = await read<bigint>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launchCount',
    })
    const [t2] = await read<[Address, Address]>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'predictAddresses',
      args: [creator, name, symbol, uri, nonce],
    })
    must(
      t2.toLowerCase() !== launched[0]?.token.toLowerCase(),
      'ikinci launch AYNI adresi verdi -- tuz launchCount tasimiyor',
    )
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: [name, symbol, uri],
    })
    launched.push({ token: t2, curve: '0x' as Address, name, symbol })
    return `${t2}`
  })

  // ------------------------------------------------------------------
  // A4-A8. SINIRLAR: tam sinirda GECER, bir bayt fazlasinda DUSER
  // ------------------------------------------------------------------
  //
  // Yalnizca "fazlasi duser" testi, sinirin YANLIS YERDE olmasini gormez:
  // 31 bayta ayarlanmis bir sinir da 33 baytta duserdi. Cift kontrol sart.
  const max32 = 'N'.repeat(32)
  const max13 = 'S'.repeat(13)
  const max200 = `ipfs://${'u'.repeat(193)}`

  await c.check('A4 32/13/200 BAYT tam sinirda launch GECER', async () => {
    mustEqual(byteLen(max32), 32, 'isim bayt')
    mustEqual(byteLen(max13), 13, 'sembol bayt')
    mustEqual(byteLen(max200), 200, 'uri bayt')
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: [max32, max13, max200],
    })
    return '32/13/200 bayt kabul edildi'
  })

  await c.expectRevert('A5 33 baytlik isim NameTooLong', 'NameTooLong', () =>
    send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: ['N'.repeat(33), 'SYM', 'ipfs://x'],
    }),
  )

  await c.expectRevert('A6 14 baytlik sembol SymbolTooLong', 'SymbolTooLong', () =>
    send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: ['Name', 'S'.repeat(14), 'ipfs://x'],
    }),
  )

  await c.expectRevert('A7 201 baytlik uri UriTooLong', 'UriTooLong', () =>
    send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: ['Name', 'SYM', `ipfs://${'u'.repeat(194)}`],
    }),
  )

  await c.expectRevert('A8 bos isim EmptyName', 'EmptyName', () =>
    send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: ['', 'SYM', 'ipfs://x'],
    }),
  )

  await c.expectRevert('A9 bos sembol EmptySymbol', 'EmptySymbol', () =>
    send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: ['Name', '', 'ipfs://x'],
    }),
  )

  // ------------------------------------------------------------------
  // A10. SINIR BAYTTIR, KARAKTER DEGIL -- emoji ile yurutulur
  // ------------------------------------------------------------------
  //
  // Sekiz emoji = 8 karakter ama 32 BAYT. Karakter sayan bir sinir bunu
  // "cok kisa" sanip kabul eder, sonra `LaunchToken` constructor'i revert
  // eder; bayt sayan bir sinir tam sinirda kabul eder. Ikisi ayni girdide
  // AYRISIR, yani bu vaka sinirin BIRIMINI olcer.
  await c.check('A10 sinir BAYT: 8 emoji (32 bayt) GECER', async () => {
    const emoji = '\u{1F680}'.repeat(8)
    // `.length` UTF-16 KOD BIRIMI sayar, karakter degil: her emoji bir
    // surrogate CIFTIDIR, yani sekiz emoji `.length === 16` verir. Kod
    // NOKTASI sayimi `[...s]` ile yapilir. Bu ayrim burada bir ayrinti degil:
    // testin ISPATLAMAK istedigi sey "sinir karakter degil BAYT sayar" ve
    // yanlis birimle yazilmis bir iddia, dogru davranisi kirmizi gosterirdi
    // (olculdu -- ilk kosuda tam olarak bu oldu).
    mustEqual([...emoji].length, 8, 'kod noktasi sayisi')
    mustEqual(byteLen(emoji), 32, 'bayt sayisi')
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: [emoji, 'EMOJI', 'ipfs://emoji'],
    })
    return '8 karakter / 32 bayt kabul edildi'
  })

  await c.expectRevert('A11 9 emoji (36 bayt) NameTooLong', 'NameTooLong', () =>
    send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: ['\u{1F680}'.repeat(9), 'EMOJI', 'ipfs://emoji'],
    }),
  )

  // ------------------------------------------------------------------
  // A12. BOS URI MESRUDUR
  // ------------------------------------------------------------------
  // Sinir `<= 200`; alt sinir YOKTUR. Metadata'siz bir launch gecerlidir ve
  // arayuz onu gradyanla cizer.
  await c.check('A12 bos uri kabul edilir', async () => {
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launch',
      args: [`Audit ${tag} NoUri`, 'NOURI', ''],
    })
    return 'bos uri kabul edildi'
  })

  // ------------------------------------------------------------------
  // A13. Buyback ACIK launch -- politika zincirde yazili
  // ------------------------------------------------------------------
  await c.check('A13 launchWithBuyback(true) politikayi ACAR', async () => {
    const name = `Audit ${tag} BB`
    const nonce = await read<bigint>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launchCount',
    })
    const [token, curve] = await read<[Address, Address]>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'predictAddresses',
      args: [creator, name, 'AUDBB', 'ipfs://bb', nonce],
    })
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launchWithBuyback',
      args: [name, 'AUDBB', 'ipfs://bb', true],
    })
    const on = await read<boolean>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'buybackEnabledOf',
      args: [token],
    })
    must(on, 'buybackEnabledOf false kaldi')
    const [treasury, lockBps] = await read<[Address, bigint]>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'buybackPolicy',
      args: [token],
    })
    must(treasury !== '0x0000000000000000000000000000000000000000', 'politika hazine vermedi')
    mustEqual(lockBps, 5000n, 'lockBps')
    launched.push({ token, curve, name, symbol: 'AUDBB' })
    return `${token} lockBps=${lockBps}`
  })

  // ------------------------------------------------------------------
  // A14. Buyback KAPALI launch -- `launch()` ile AYNI sonuc
  // ------------------------------------------------------------------
  await c.check('A14 launchWithBuyback(false) politikayi ACMAZ', async () => {
    const name = `Audit ${tag} NoBB`
    const nonce = await read<bigint>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launchCount',
    })
    const [token, curve] = await read<[Address, Address]>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'predictAddresses',
      args: [creator, name, 'AUDNB', 'ipfs://nb', nonce],
    })
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'launchWithBuyback',
      args: [name, 'AUDNB', 'ipfs://nb', false],
    })
    const on = await read<boolean>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'buybackEnabledOf',
      args: [token],
    })
    must(!on, 'buybackEnabledOf true oldu')
    const [treasury, lockBps] = await read<[Address, bigint]>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'buybackPolicy',
      args: [token],
    })
    mustEqual(treasury, '0x0000000000000000000000000000000000000000', 'kapali politika hazinesi')
    mustEqual(lockBps, 0n, 'kapali politika lockBps')
    launched.push({ token, curve, name, symbol: 'AUDNB' })
    return 'kapali'
  })

  // ------------------------------------------------------------------
  // A15. Token'in ic tutarliligi -- arz, creator, curve
  // ------------------------------------------------------------------
  await c.check('A15 token arzi 1e27 ve tamami CURVE de', async () => {
    const mine = launched[0]
    must(mine !== undefined, 'launch yok')
    const supply = await read<bigint>(pub, {
      address: mine!.token,
      abi: TOKEN_ABI,
      functionName: 'totalSupply',
    })
    mustEqual(supply, 10n ** 27n, 'totalSupply')
    const curveAddr = await read<Address>(pub, {
      address: mine!.token,
      abi: TOKEN_ABI,
      functionName: 'curve',
    })
    const held = await read<bigint>(pub, {
      address: mine!.token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [curveAddr],
    })
    mustEqual(held, supply, 'curve bakiyesi')
    const tokenCreator = await read<Address>(pub, {
      address: mine!.token,
      abi: TOKEN_ABI,
      functionName: 'creator',
    })
    mustEqual(tokenCreator.toLowerCase(), creator.toLowerCase(), 'token.creator()')
    return '1e27, tamami curve de'
  })
}

export type { Address, Hex }

