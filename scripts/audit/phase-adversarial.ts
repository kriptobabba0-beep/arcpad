/**
 * ============================================================================
 *  FAZ G -- DUSMANCA: CANLI DAGITIMIN ERISIM KONTROLU
 * ============================================================================
 *
 * Forge suite'i bu korumalarin hepsini KENDI kurdugu bir yiginda olcuyor. Bu
 * faz baska bir soru sorar ve testlerin CEVAPLAYAMADIGI tek soru budur:
 *
 *     CANLI dagitim DOGRU kablolanmis mi?
 *
 * Bir kontrat mukemmel yazilmis olabilir ve yanlis governor'la deploy
 * edilmis olabilir; iki hal de butun birim testlerinden gecer. Asagidaki
 * vakalar zincirdeki GERCEK adreslere karsi kosar ve her biri bir YETKISIZ
 * cagridir -- yani gecmesi beklenen bir sey yok, hepsi REDDEDILMELI.
 *
 * ============ NEDEN "YABANCI" GERCEK BIR CUZDAN ============
 *
 * `eth_call`de `from` uydurmak kolaydir ama bir SIMULASYONDUR. Buradaki
 * yabanci turetilmis, fonlanmis, GERCEK bir cuzdandir ve islemleri gercekten
 * gonderilir: "zincir bunu reddeder" iddiasi ancak zincir reddettiginde
 * kanitlanir.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import {
  bondingCurveAbi,
  buybackTreasuryAbi,
  buybackVestingVaultAbi,
  launchFactoryAbi,
  launchTokenAbi,
} from '../../packages/shared/src/abi/index'
import { book, type Campaign, must, mustEqual, read, send } from './harness'

const FACTORY_ABI = launchFactoryAbi as unknown as Abi
const CURVE_ABI = bondingCurveAbi as unknown as Abi
const TOKEN_ABI = launchTokenAbi as unknown as Abi
const TREASURY_ABI = buybackTreasuryAbi as unknown as Abi
const VAULT_ABI = buybackVestingVaultAbi as unknown as Abi

const LOCKER_ABI = [
  {
    type: 'function',
    name: 'graduate',
    inputs: [{ name: 'curve', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const satisfies Abi

export async function phaseAdversarial(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  stranger: WalletClient,
  token: Address,
  curve: Address,
): Promise<void> {
  c.phase('FAZ G -- dusmanca: canli erisim kontrolu')
  const b = book()
  const factory = b.launchFactory
  const other = stranger.account!.address
  const treasury = await read<Address>(pub, {
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'buybackTreasury',
  })
  const vault = await read<Address>(pub, {
    address: treasury,
    abi: TREASURY_ABI,
    functionName: 'vault',
  })

  // ------------------------------------------------------------------
  // G1-G4. GOVERNOR YETKILERI -- YABANCIYA KAPALI
  // ------------------------------------------------------------------
  //
  // Dordu de zincirin en agir yetkileri: protokol hazinesini degistirmek,
  // mezuniyet hedefi onermek, hook ve anahtarci atamak. Yanlis bir governor
  // ile deploy edilmis bir fabrika butun birim testlerinden gecerdi.
  await c.expectRevert('G1 yabanci protokol hazinesini degistiremez', 'NotGovernor', () =>
    send(pub, stranger, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setProtocolTreasury',
      args: [other],
    }),
  )

  await c.expectRevert('G2 yabanci mezuniyet hedefi oneremez', 'NotGovernor', () =>
    send(pub, stranger, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'proposeGraduationTarget',
      args: [other],
    }),
  )

  await c.expectRevert('G3 yabanci anahtarci atayamaz', 'NotGovernor', () =>
    send(pub, stranger, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackKeeper',
      args: [other],
    }),
  )

  await c.expectRevert('G4 yabanci graduation hook atayamaz', 'NotGovernor', () =>
    send(pub, stranger, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setGraduationHook',
      args: [other],
    }),
  )

  // ------------------------------------------------------------------
  // G5. HAZINE BIR KEZ YAZILIR -- governor bile DEGISTIREMEZ
  // ------------------------------------------------------------------
  //
  // Degistirilebilir olsaydi governor, creator'larin ayrilmis paylarini kendi
  // kontrol ettigi bir adrese yonlendirebilirdi. Yabanci `NotGovernor` alir;
  // asil iddia governor'in da alacagi cevaptir ama onu denemek CANLI yigini
  // riske atardi -- burada yalnizca yabanci yolu yuruyoruz ve tek-yazimlik
  // olma ZINCIRDEN okunarak dogrulaniyor.
  await c.check('G5 buybackTreasury ZATEN yazili (tek yazimlik)', async () => {
    must(
      treasury !== '0x0000000000000000000000000000000000000000',
      'buybackTreasury bos -- tek yazimlik koruma HENUZ baglanmamis',
    )
    return treasury
  })

  await c.expectRevert('G6 yabanci hazineyi degistiremez', 'NotGovernor', () =>
    send(pub, stranger, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackTreasury',
      args: [other],
    }),
  )

  // ------------------------------------------------------------------
  // G7. TAHAKKUK YALNIZCA IKI MERCIDEN
  // ------------------------------------------------------------------
  //
  // Bir sahtekar baska bir tokenin butcesini sisirememeli. `accrue` yalnizca
  // tokenin KENDI egrisinden ya da kayitli mezuniyet hook'undan kabul edilir.
  await c.expectRevert('G7 yabanci accrue cagiramaz NotAccrualVenue', 'NotAccrualVenue', () =>
    send(pub, stranger, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'accrue',
      args: [token],
      value: 1_000_000_000_000_000n,
    }),
  )

  // ------------------------------------------------------------------
  // G8. KASAYA YALNIZCA HAZINE KILIT KOYAR
  // ------------------------------------------------------------------
  //
  // Aksi halde herhangi biri kasaya token kilitleyip vesting takvimini
  // (agirlikli baslangic) ILERI iterek gercek kilidi geciktirebilirdi.
  await c.expectRevert(
    'G8 yabanci kasaya kilit koyamaz NotBuybackTreasury',
    'NotBuybackTreasury',
    () =>
      send(pub, stranger, {
        address: vault,
        abi: VAULT_ABI,
        functionName: 'lock',
        args: [token, 1n, other],
      }),
  )

  // ------------------------------------------------------------------
  // G9. SAHTE BIR CURVE MEZUN EDILEMEZ
  // ------------------------------------------------------------------
  //
  // Locker, verilen curve'un fabrikadan geldigini TOKEN uzerinden dogrular.
  // Bu satir olmadan bir saldirgan kanonik havuzu kendi sectigi toz
  // likiditeyle acar ve gercek mezuniyeti SONSUZA KADAR kilitlerdi
  // (`PoolAlreadyInitialized`, cikis yolu yok). Depoda PoC'si var; burada
  // CANLI locker'a karsi yuruyor.
  await c.check('G9 sahte curve mezun edilemez', async () => {
    let rejected = false
    let why = ''
    try {
      await send(pub, stranger, {
        address: b.arcpadLocker,
        abi: LOCKER_ABI as unknown as Abi,
        functionName: 'graduate',
        // Fabrikadan gelmeyen bir adres: escrow'un kendisi. `token()` cagrisi
        // ya revert eder ya da kanonik olmayan bir sey doner; iki halde de
        // locker REDDETMELI.
        args: [b.feeEscrow],
      })
    } catch (error) {
      rejected = true
      why = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 80) : ''
    }
    must(rejected, 'SAHTE CURVE MEZUN EDILDI -- kanoniklik kontrolu YOK')
    return `reddedildi (${why})`
  })

  // ------------------------------------------------------------------
  // G10. BAGLANMIS BIR CURVE YENIDEN BAGLANAMAZ
  // ------------------------------------------------------------------
  //
  // `bind` yalnizca fabrikadan ve yalnizca BIR KEZ. Ikinci bir bind, bir
  // curve'u baska bir tokene isaret ettirip arzini bosaltirdi.
  await c.expectRevert('G10 curve yeniden baglanamaz', 'NotFactory', () =>
    send(pub, stranger, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'bind',
      args: [token],
    }),
  )

  // ------------------------------------------------------------------
  // G11. TOKEN MINT EDILEMEZ -- boyle bir yuzey YOK
  // ------------------------------------------------------------------
  //
  // Arz constructor'da basilir ve bir daha artmaz. Bu vaka bir REVERT degil
  // bir YOKLUK olcer: ABI'de `mint` yoksa cagrilacak bir sey de yoktur.
  await c.check('G11 token ABI sinde mint YOK', async () => {
    const names = (launchTokenAbi as unknown as { name?: string }[])
      .map((e) => e.name ?? '')
      .filter((n) => /mint|burn|owner|upgrade/i.test(n))
    mustEqual(names.length, 0, `beklenmeyen yuzey: ${names.join(', ')}`)
    const supply = await read<bigint>(pub, {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'totalSupply',
    })
    mustEqual(supply, 10n ** 27n, 'totalSupply')
    return 'mint/burn/owner/upgrade yuzeyi yok, arz 1e27'
  })

  // ------------------------------------------------------------------
  // G12. CANLI KABLOLAMA DEFTERLE AYNI
  // ------------------------------------------------------------------
  //
  // Defter bir BELGEDIR; zincir GERCEKTIR. Ayrisirlarsa keeper ve arayuz
  // yanlis adrese konusur ve hicbir test bunu gormez.
  await c.check('G12 zincirdeki kablolama defterle AYNI', async () => {
    const escrow = await read<Address>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'escrow',
    })
    const protocolTreasury = await read<Address>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'protocolTreasury',
    })
    const governor = await read<Address>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'governor',
    })
    const gradTarget = await read<Address>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'graduationTarget',
    })
    mustEqual(escrow.toLowerCase(), b.feeEscrow.toLowerCase(), 'escrow')
    mustEqual(protocolTreasury.toLowerCase(), b.protocolTreasury.toLowerCase(), 'protocolTreasury')
    mustEqual(governor.toLowerCase(), b.governor.toLowerCase(), 'governor')
    mustEqual(gradTarget.toLowerCase(), b.arcpadLocker.toLowerCase(), 'graduationTarget')
    return 'escrow/hazine/governor/hedef -- dordu de defterle ayni'
  })

  // ------------------------------------------------------------------
  // G13. GOVERNOR BIR SAFE, BIR EOA DEGIL
  // ------------------------------------------------------------------
  //
  // Deploy kapisi `getThreshold()`/`getOwners()` sorar, yani bir EOA governor
  // ile deploy IMKANSIZDIR. Bu vaka o kapinin CANLI sonucunu dogrular: en agir
  // yetkiler tek bir anahtarin arkasinda DEGIL.
  await c.check('G13 governor kod TASIYOR (Safe, EOA degil)', async () => {
    const code = await pub.getCode({ address: b.governor })
    must(code !== undefined && code !== '0x', 'governor bir EOA -- coklu imza YOK')
    return `${(code!.length - 2) / 2} bayt kod`
  })
}
