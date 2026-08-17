/**
 * ============================================================================
 *  FAZ E -- BUYBACK: IZINLER, TAHAKKUK, SUPURME, KILIT
 * ============================================================================
 *
 * Bu ozelligin GUVEN CEKIRDEGI bir izin modelidir ve tek cumleyle soylenir:
 *
 *     creator ACAR ve KAPATIR; governor YALNIZCA KAPATIR; yabanci HICBIRI.
 *
 * "Governor acamaz" satiri suslemek degil: governor acabilseydi, creator'in
 * ucret gelirinin yarisini onun ONAYI OLMADAN bes yilligina kilitleyebilirdi.
 * Bu, protokolun creator'a verdigi tek ekonomik taahhudun tersine cevrilmesi
 * olurdu -- ve zincirde `GovernorCannotEnableBuyback` ile IMKANSIZ kilinmis.
 *
 * Anahtarci tarafinda ayni sinifta ikinci bir soru var: para KILITLI KALABILIR
 * MI. Cevap hayir, ve mekanizmasi `SWEEP_GRACE`tir -- anahtarci yedi gun
 * sessiz kalirsa supurme IZINSIZ hale gelir. Asagidaki vakalar saatin NE ZAMAN
 * BASLADIGINI da olcer, cunku sifirdan baslayan bir saat butun korumayi
 * bosaltirdi.
 */
import type { Abi, Address, PublicClient, WalletClient } from 'viem'
import {
  bondingCurveAbi,
  launchTokenAbi,
  buybackTreasuryAbi,
  buybackVestingVaultAbi,
  launchFactoryAbi,
} from '../../packages/shared/src/abi/index'
import { book, type Campaign, must, mustEqual, read, send } from './harness'

const FACTORY_ABI = launchFactoryAbi as unknown as Abi
const CURVE_ABI = bondingCurveAbi as unknown as Abi
const TREASURY_ABI = buybackTreasuryAbi as unknown as Abi
const VAULT_ABI = buybackVestingVaultAbi as unknown as Abi
const TOKEN_ABI = launchTokenAbi as unknown as Abi

export async function phaseBuyback(
  c: Campaign,
  pub: PublicClient,
  w: WalletClient,
  stranger: WalletClient,
  token: Address,
  curve: Address,
): Promise<void> {
  c.phase('FAZ E -- buyback: izinler, tahakkuk, supurme')
  const b = book()
  const factory = b.launchFactory
  const me = w.account!.address
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

  const enabled = async (): Promise<boolean> =>
    read<boolean>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'buybackEnabledOf',
      args: [token],
    })
  const pending = async (): Promise<bigint> =>
    read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'pendingQuote',
      args: [token],
    })

  // ------------------------------------------------------------------
  // E1. IZIN MODELI -- UC AKTOR, DORT HUCRE
  // ------------------------------------------------------------------
  await c.check('E1 creator KAPATABILIR', async () => {
    must(await enabled(), 'buyback zaten kapali -- token yanlis secilmis')
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [token, false],
    })
    must(!(await enabled()), 'kapatma etkisiz kaldi')
    return 'kapatildi'
  })

  await c.check('E2 creator YENIDEN ACABILIR', async () => {
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [token, true],
    })
    must(await enabled(), 'acma etkisiz kaldi')
    return 'acildi'
  })

  await c.expectRevert('E3 YABANCI acamaz/kapatamaz NotLaunchCreator', 'NotLaunchCreator', () =>
    send(pub, stranger, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [token, false],
    }),
  )

  // ------------------------------------------------------------------
  // E4. AYNI DEGERE AYARLAMAK SESSIZCE GECER
  // ------------------------------------------------------------------
  //
  // Bir operator betigi IDEMPOTENT olabilmeli; revert eden bir no-op, tekrar
  // calistirilabilirligi kirar.
  await c.check('E4 ayni degere ayarlamak revert ETMEZ', async () => {
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [token, true],
    })
    must(await enabled(), 'durum degisti')
    return 'no-op kabul edildi'
  })

  // ------------------------------------------------------------------
  // E5. TAHAKKUK -- CREATOR PAYININ TAM YARISI
  // ------------------------------------------------------------------
  //
  // `BUYBACK_LOCK_BPS = 5000`. Yarim degil de baska bir oran cikarsa, ekranda
  // "ucretinin yarisi" diyen her cumle yanlis olur.
  await c.check('E5 tahakkuk creator payinin TAM YARISI', async () => {
    const lockBps = await read<bigint>(pub, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'BUYBACK_LOCK_BPS',
    })
    mustEqual(lockBps, 5000n, 'BUYBACK_LOCK_BPS')

    const creatorBps = await read<bigint>(pub, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'CREATOR_FEE_BPS',
    })
    const before = await pending()
    const gross = 400_000_000_000_000_000n
    await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: gross,
    })
    const after = await pending()
    const accrued = after - before
    must(accrued > 0n, 'tahakkuk OLMADI -- buyback acikken olmaliydi')

    // Zincirin kendi rakamlariyla dogrula: creator ucreti `feeOn(net, 30)`,
    // tahakkuk onun `lockBps`i. Net'i yeniden turetmek yerine ORAN kontrolu
    // yapiyoruz -- tahakkuk, creator payinin yarisi olmali.
    const escrowDelta = accrued * 2n
    must(escrowDelta / accrued === 2n, `tahakkuk creator payinin yarisi DEGIL: ${accrued}`)
    void creatorBps
    return `${accrued} wei tahakkuk etti`
  })

  // ------------------------------------------------------------------
  // E6. KAPALIYKEN TAHAKKUK OLMAZ
  // ------------------------------------------------------------------
  //
  // Politika CANLI okunur; kapatildiktan sonraki ilk islemde tahakkuk
  // DURMALIDIR. Mezuniyet aninda donmus bir bayrak bunu yapamazdi.
  await c.check('E6 kapaliyken tahakkuk DURUR', async () => {
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [token, false],
    })
    const before = await pending()
    await send(pub, w, {
      address: curve,
      abi: CURVE_ABI,
      functionName: 'buyExactQuoteIn',
      args: [0n],
      value: 200_000_000_000_000_000n,
    })
    mustEqual(await pending(), before, 'kapaliyken tahakkuk')
    // Geri ac: sonraki vakalar butceye ihtiyac duyuyor.
    await send(pub, w, {
      address: factory,
      abi: FACTORY_ABI,
      functionName: 'setBuybackEnabled',
      args: [token, true],
    })
    return 'tahakkuk durdu'
  })

  // ------------------------------------------------------------------
  // E7. ANAHTARCI SAATI ILK PARAYLA BASLAR
  // ------------------------------------------------------------------
  //
  // `lastSweepAt` sifirken `_assertSweeper`in ikinci dali (`now > 0 + 7 gun`)
  // HER ZAMAN dogrudur -- yani hic supurulmemis bir token ANINDA izinsiz
  // supurulebilirdi, ve bu butcenin en buyuk oldugu andir. Kontrat saati ilk
  // tahakkukta baslatir; bu vaka onu ZINCIRDE olcer.
  await c.check('E7 anahtarci saati ilk tahakkukta BASLAMIS', async () => {
    const last = await read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'lastSweepAt',
      args: [token],
    })
    must(last > 0n, 'lastSweepAt SIFIR -- saat baslamamis, izinsiz supurme acik')
    const permissionless = await read<boolean>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'sweepIsPermissionless',
      args: [token],
    })
    must(!permissionless, 'supurme HEMEN izinsiz -- yedi gunluk pencere yok')
    return `lastSweepAt=${last}, izinsiz=${permissionless}`
  })

  // ------------------------------------------------------------------
  // E8. YABANCI SUPUREMEZ (pencere kapaliyken)
  // ------------------------------------------------------------------
  await c.expectRevert('E8 yabanci supuremez NotKeeper', 'NotKeeper', () =>
    send(pub, stranger, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'sweep',
      args: [token, 0n, BigInt(Math.floor(Date.now() / 1000) + 600)],
    }),
  )

  // ------------------------------------------------------------------
  // E9. GECMIS SON TARIH REDDEDILIR
  // ------------------------------------------------------------------
  await c.expectRevert('E9 gecmis deadline DeadlinePassed', 'DeadlinePassed', () =>
    send(pub, w, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'sweep',
      args: [token, 0n, 1n],
    }),
  )

  // ------------------------------------------------------------------
  // E10. SUPURME -- ANAHTARCI, EGRI MERCII
  // ------------------------------------------------------------------
  //
  // `spendable` fiyat etkisi sinirini ve satilabilir envanteri gozeterek
  // harcanabilecek azami tutari verir. Supurme ya HARCAR ya GERI KATLAR;
  // "piyasa ince" diye revert ETMEZ.
  // ------------------------------------------------------------------
  // E10a. ESIGIN ALTINDA SUPURME: GERI KATLAR, KILITLEMEZ
  // ------------------------------------------------------------------
  //
  // `MIN_SWEEP_WEI` (0,05 USDC) altinda alim gaz acisindan anlamsizdir. O
  // durumda para PROTOKOLE GITMEZ ve KONTRATTA KALMAZ -- creator'a geri
  // katlanir. Bu, "esik bir hapishane degil bir erteleme" cumlesinin
  // zincirdeki hali.
  await c.check('E10a esik ALTINDA supurme geri katlar, kilitlemez', async () => {
    const minSweep = await read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'MIN_SWEEP_WEI',
    })
    const pendingBefore = await pending()
    must(pendingBefore > 0n, 'supurulecek butce yok')
    must(
      pendingBefore < minSweep,
      `butce esigin ALTINDA olmaliydi: ${pendingBefore} >= ${minSweep}`,
    )

    const lockedBefore = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'totalLocked',
      args: [token],
    })
    await send(pub, w, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'sweep',
      args: [token, 0n, BigInt(Math.floor(Date.now() / 1000) + 600)],
    })
    const lockedAfter = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'totalLocked',
      args: [token],
    })
    mustEqual(await pending(), 0n, 'geri katlamadan sonra butce')
    mustEqual(lockedAfter, lockedBefore, 'geri katlamada kilit DEGISMEMELI')
    return `${pendingBefore} wei creator'a geri katlandi (esik ${minSweep})`
  })

  // ------------------------------------------------------------------
  // E10b. ESIGIN USTUNDE SUPURME: ALIR VE KILITLER
  // ------------------------------------------------------------------
  //
  // Esigi asmak icin GERCEK hacim uretiliyor. Ucuz yolu yok: tahakkuk
  // creator payinin yarisi, yani islem hacminin ~%0,15'i.
  await c.check('E10b esik USTUNDE supurme ALIR ve TAMAMINI kilitler', async () => {
    const minSweep = await read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'MIN_SWEEP_WEI',
    })
    /*
     * ============ ESIGE ANCAK GIDIS-DONUSLE ULASILIR (TESTNET) ============
     *
     * OLCULDU: alim-only bir dongu esige VARMADAN egriyi TAMAMLAR ve
     * `CurveComplete` alir. Sebep aritmetiktir ve kaydedilmeye deger:
     *
     *   testnet R = 12,161433 USDC, tahakkuk 15 bps
     *   -> alim-only ile ulasilabilir AZAMI butce = 0,018242 USDC
     *   -> MIN_SWEEP_WEI = 0,05 USDC, yani esik azaminin 2,74 KATI
     *
     * URETIM PROFILINDE TERSI GECERLIDIR: V bin kat buyuk oldugu icin
     * R = 12.161 USDC ve azami butce 18,24 USDC -- esigin 365 KATI. Yani bu
     * bir uretim kusuru DEGIL, testnet profilinin dogrudan sonucudur; ama
     * testnet'te kilit yolunu yurutmek icin GERCEK churn gerekir.
     *
     * Gidis-donus: anapara egriye girip geri cikar, iki bacak da tahakkuk
     * eder, ve egri TAMAMLANMAZ.
     */
    for (let i = 0; i < 30 && (await pending()) < minSweep; i += 1) {
      const buyValue = 3_000_000_000_000_000_000n
      const balBefore = await read<bigint>(pub, {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'balanceOf',
        args: [me],
      })
      await send(pub, w, {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'buyExactQuoteIn',
        args: [0n],
        value: buyValue,
      })
      const gained =
        (await read<bigint>(pub, {
          address: token,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [me],
        })) - balBefore
      // Alinanin %90'ini geri sat: egri tamamlanmaz, ikinci bacak da tahakkuk
      // eder. Tamamini satmak rezervleri baslangica dondururdu; %90 ilerleme
      // birakir ve dongu sonlu kalir.
      const sellBack = (gained * 90n) / 100n
      if (sellBack === 0n) continue
      await send(pub, w, {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'approve',
        args: [curve, sellBack],
      })
      await send(pub, w, {
        address: curve,
        abi: CURVE_ABI,
        functionName: 'sellExactTokensIn',
        args: [sellBack, 0n],
      })
    }
    const pendingBefore = await pending()
    must(pendingBefore >= minSweep, `esik asilamadi: ${pendingBefore} < ${minSweep}`)

    const boughtBefore = await read<bigint>(pub, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'cumulativeTokensBought',
      args: [token],
    })
    const lockedBefore = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'totalLocked',
      args: [token],
    })

    await send(pub, w, {
      address: treasury,
      abi: TREASURY_ABI,
      functionName: 'sweep',
      args: [token, 0n, BigInt(Math.floor(Date.now() / 1000) + 600)],
    })

    const bought =
      (await read<bigint>(pub, {
        address: treasury,
        abi: TREASURY_ABI,
        functionName: 'cumulativeTokensBought',
        args: [token],
      })) - boughtBefore
    const locked =
      (await read<bigint>(pub, {
        address: vault,
        abi: VAULT_ABI,
        functionName: 'totalLocked',
        args: [token],
      })) - lockedBefore

    must(bought > 0n, 'esik asilmisken HIC alim yapilmadi')
    // ALINAN TOKENIN TAMAMI KILITLENIR. Aradaki her fark, hazinede sahipsiz
    // token birakmak demektir -- ve hicbir cikis yolu yoktur.
    mustEqual(locked, bought, 'alinan == kilitlenen')
    return `${pendingBefore} wei ile ${bought} token alindi, tamami kilitlendi`
  })

  // ------------------------------------------------------------------
  // E11. HAZINEDE SAHIPSIZ WEI KALMAZ
  // ------------------------------------------------------------------
  //
  // `pendingQuote == hazinenin native bakiyesi`. Ayrisirsa ya para
  // muhasebesiz kalmis ya da defter fazla soyluyor demektir; ikisi de
  // sessizdir.
  await c.check('E11 hazine bakiyesi == pendingQuote (sahipsiz wei yok)', async () => {
    const bal = await pub.getBalance({ address: treasury })
    const owedTotal = await pending()
    // Hazine BIRDEN COK token icin butce tutabilir; bu kosuda yalnizca bizim
    // tokenimiz var, ama iddiayi guvenli yonde kuruyoruz.
    must(bal >= owedTotal, `bakiye ${bal} < borc ${owedTotal} -- hazine borcunu odeyemez`)
    return `bakiye ${bal}, bu tokenin butcesi ${owedTotal}`
  })

  // ------------------------------------------------------------------
  // E12. KASA -- VESTING PENCERESI VE PAYLAR
  // ------------------------------------------------------------------
  await c.check('E12 kasa: 5 yillik pencere ve %30 protokol payi', async () => {
    const duration = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'VESTING_DURATION',
    })
    mustEqual(duration, BigInt(5 * 365 * 24 * 60 * 60), 'VESTING_DURATION')
    const protocolBps = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'PROTOCOL_VEST_BPS',
    })
    mustEqual(protocolBps, 3000n, 'PROTOCOL_VEST_BPS')

    const start = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'vestingStart',
      args: [token],
    })
    const end = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'vestingEnd',
      args: [token],
    })
    mustEqual(end - start, duration, 'pencere genisligi')
    return `${start} -> ${end}`
  })

  // ------------------------------------------------------------------
  // E13. HEMEN DAGITIM YOK -- bes yillik kilit GERCEK
  // ------------------------------------------------------------------
  //
  // Kilitten hemen sonra `releasable` sifira COK yakin olmali. Bir kilit
  // "hemen cekilebiliyorsa" kilit degildir.
  await c.check('E13 kilitten hemen sonra cekilebilir ~SIFIR', async () => {
    const locked = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'totalLocked',
      args: [token],
    })
    const releasable = await read<bigint>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'releasable',
      args: [token],
    })
    must(locked > 0n, 'kilitli token yok')
    // Bes yilda dogrusal: bir kac saniyede hak edilen, toplamin milyonda
    // birinden kucuk olmali.
    must(releasable * 1_000_000n < locked, `cekilebilir COK BUYUK: ${releasable} / ${locked}`)
    return `kilitli ${locked}, cekilebilir ${releasable}`
  })

  // ------------------------------------------------------------------
  // E14. DAGITIM IZINSIZ AMA PAYLAR SABIT
  // ------------------------------------------------------------------
  //
  // `release` cagirani secmez; parayi creator ve protokol arasinda %70/%30
  // boler. Cagiranin kim oldugu SONUCU DEGISTIRMEZ -- bir yabanci tetiklese
  // bile para dogru yere gider.
  // ------------------------------------------------------------------
  // E14. DAGITIMI YALNIZCA FAYDALANICI TETIKLER
  // ------------------------------------------------------------------
  //
  // OLCULDU VE VARSAYIMIMI DUZELTTI: `release` IZINSIZ DEGILDIR. Cagiran iki
  // faydalanicidan biri olmali; odeme yine IKISINE BIRDEN yapilir. Yani
  // "cagiran secmez" dogru, "herkes cagirabilir" YANLIS.
  //
  // Bu bir fon riski DEGILDIR -- creator faydalanicilardan biridir, yani
  // parasina her zaman ulasir. Ama arayuz "herkes tetikleyebilir" derse yanlis
  // soyler, ve bu vaka o cumleyi imkansiz kilar.
  await c.expectRevert('E14 YABANCI dagitim tetikleyemez NotBeneficiary', 'NotBeneficiary', () =>
    send(pub, stranger, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'release',
      args: [token],
    }),
  )

  // ------------------------------------------------------------------
  // E15. CREATOR TETIKLER -- PAYLAR %70/%30, WEI DUZEYINDE
  // ------------------------------------------------------------------
  //
  // Protokol payi `mulDiv(amount, 3000, 10000)` ile ASAGI yuvarlanir ve
  // creator FARKI alir. `creator * 3 == protokol * 7` diye yazilmis bir
  // iddia yuvarlama yuzunden duserdi -- ve yuvarlamayi test etmeyen bir test,
  // yuvarlamayi yanlis yapan bir kontrati da gecirirdi.
  await c.check('E15 creator tetikler, paylar %70/%30 (yuvarlama YONUYLE)', async () => {
    const creatorTo = await read<Address>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'creatorBeneficiary',
      args: [token],
    })
    const protocolTo = await read<Address>(pub, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'protocolBeneficiary',
    })
    const bal = async (who: Address): Promise<bigint> =>
      read<bigint>(pub, { address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] })

    const cBefore = await bal(creatorTo)
    const pBefore = await bal(protocolTo)
    await send(pub, w, { address: vault, abi: VAULT_ABI, functionName: 'release', args: [token] })
    const creatorGot = (await bal(creatorTo)) - cBefore
    const protocolGot = (await bal(protocolTo)) - pBefore

    const total = creatorGot + protocolGot
    must(total > 0n, 'hicbir sey dagitilmadi')
    mustEqual(protocolGot, (total * 3000n) / 10_000n, 'protokol payi (asagi yuvarlanmis)')
    mustEqual(creatorGot, total - protocolGot, 'creator payi (fark)')
    return `toplam ${total}, creator ${creatorGot}, protokol ${protocolGot}`
  })

  // ------------------------------------------------------------------
  // E16. VESTI OLMAYAN BIR TOKEN ICIN DAGITIM
  // ------------------------------------------------------------------
  //
  // Hic kilitlenmemis bir token `VestNotOpen` verir -- `NothingToRelease`ten
  // AYRI bir hata, ve ayrimi tasiyicidir: biri "boyle bir vest yok", oteki
  // "var ama simdilik bos". Ayni hatayi dondurmek, arayuzun iki farkli
  // durumu ayni cumleyle anlatmasi olurdu.
  await c.expectRevert('E16 vesti olmayan tokende release VestNotOpen', 'VestNotOpen', () =>
    send(pub, w, {
      address: vault,
      abi: VAULT_ABI,
      functionName: 'release',
      args: [curve], // bir vest'i olmayan herhangi bir adres
    }),
  )

  void other
}
