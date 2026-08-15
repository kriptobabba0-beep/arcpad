#!/usr/bin/env python3
"""Dondurulmus bytecode kapisi.

NICIN BU DOSYA VAR. Dondurulmus `BondingCurve` hash'i, Faz 2 boyunca
`forge inspect ... | sha256sum` ile elle olculuyordu ve o olcum SESSIZCE
YALAN SOYLEDI: `out/` icindeki artifact'i iki ayri derleme isi yaziyordu
(biri `optimizer_runs = 800`, oteki `44444444`) ve hangisinin kazandigi
CAGRI SIRASINA bagliydi. Olculdu -- ayni agacta, ARADA HICBIR KAYNAK
DEGISIKLIGI OLMADAN, ilk cagri `8e2460ff...`, sonraki her cagri
`e73842c9...` dondu. Saatlerce "hash yerinde" diye raporlandi.

KAPI BU YUZDEN KENDI PROFILINDEN OKUR (`[profile.frozen]`, `out-frozen/`).
O dizine default/ci profilinin hicbir isi yazamaz, dolayisiyla okunan
artifact'i yalnizca 800 ayarli is uretmis olabilir. Kapi her cagrida once
o profili KENDISI derler; bayat bir artifact uzerinden gecmesi mumkun
degildir.

Kosum:
    make frozen-hash              # zincire dokunmaz
    make frozen-hash-chain        # ARC_RPC_URL ile canli kodu da karsilastirir
"""

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.dirname(HERE)
REPO = os.path.dirname(CONTRACTS)

# `forge inspect <path>:<name> bytecode | sha256sum` -- HEX METNININ sha256'si,
# baytlarin keccak'i DEGIL. (keccak `0xdf476afe...` verir ve tam olarak bir
# kirilma gibi gorunur.)
# ===========================================================================
#  NESIL AYRIMI: CANLI OLAN V1, KAYNAKTAKI V2
# ===========================================================================
#
# Creator-funded buyback & lock, `BondingCurve`e bir ucret ayrimi
# (`_settleCreatorFee`) ve `LaunchFactory`ye bir constructor argumani ekledi.
# Ikisi de INITCODE DEGISTIRIR -- ve `LaunchFactory`nin initcode'u bir ADRES
# BELIRLEYICISIDIR, yani bu tanim geregi YENI BIR NESILDIR.
#
# ESKI PINLER SILINMEZ, BURAYA TASINIR. Asagidaki `LIVE` adreslerinde duran
# kod hala V1'dir ve oyle KALACAKTIR. Literalleri ustune yazip gecseydik canli
# dagitimin dogrulanabilirligini kaybederdik -- ve bu dosyanin butun varlik
# sebebi tam olarak o dogrulanabilirliktir.
#
# DEGISMEYEN UCU (LaunchToken, FeeEscrow, FeeSchedule) BILEREK BURAYA
# KOPYALANMADI: onlarin V1 ve V2 hash'leri AYNIDIR, yani nesil ayrimi onlara
# dokunmaz ve iki yerde tutmak ikinci bir dogruluk kaynagi yaratirdi.
LEGACY_V1 = {
    # Canli: 0x7938BE340A14A12f94a83AEa246d9d2566324c9C
    "BondingCurve": "8e2460fff48ee5b6c591d0c62041936a7c63099d2ae1d636fa3bd2b927b4982f",
    # Canli: 0x5CA156f1809aB784655410d0f4B0704d2b306B47
    "LaunchFactory": "e88224f8e769d2d4e50f302f6c5dc76fb738c80f5b0452f3c4f05fad889321a0",
}

FROZEN = {
    "BondingCurve": "d1402acad9b43eda7c79b7e9548089458502b98ced9e7f2e7e8b29c9725d4356",
    "LaunchToken": "d4c19416664f373cb5e8504f9e2060bb874b0894ef4c6e266b4d9121e405f805",
    # ---------------------------------------------------------------
    # FAZ 2 EKI, VE EKLENME SEBEBI OLCULDU.
    #
    # Bu iki satirdan ONCE kapi `FeeEscrow` ve `FeeSchedule` icin YALNIZCA
    # `optimizer_runs`a bakiyordu, yani onlar hakkinda hicbir SABIT referans
    # tasimiyordu. Sonucu su sekilde olculdu: `FeeSchedule.tierFor`in kademe
    # 0 protokol payi 95 -> 94 yapildiginda, `make frozen-hash` YESIL
    # kaliyordu ve hemen ardindan `Deploy.t.sol` 53/53 GECIYORDU -- cunku
    # `DeployLib.assertMatchesFrozenBuild`in referansi `out-frozen/`dir ve
    # kapinin kendisi o dizini DEGISTIRILMIS KAYNAKTAN yeniden uretiyordu.
    # `Makefile`in `test: frozen-hash` on kosulu bunu OTOMATIK yapiyor.
    # Yani iddia, duzenlenmis derlemeyi KENDISIYLE karsilastiriyordu.
    #
    # TUREVI OLMAYAN TEK REFERANS ELLE YAZILMIS BIR LITERALDIR. Bunlar
    # `Profiles.TESTNET_DIGEST` ile AYNI mekanizmadir: degeri degistirmek
    # DERLENEN/INCELENEN bir satiri degistirmeyi gerektirir, ve tek dosyalik
    # bir kaza -- ki kazalar tek dosyaliktir -- yakalanir.
    #
    # BU IKISININ NICIN ONEMLI OLDUGU, AYRI AYRI:
    #   FeeEscrow   : ZATEN CANLI (0xEEd4431e..., 152069146725900635 wei) ve
    #                 constructor argumani olmadigi icin adresi
    #                 `predict(ESCROW_SALT, creationCode)`tir. Kaynaktaki
    #                 herhangi bir degisiklik adresi kaydirir; `AlreadyDeployed`
    #                 kontrolu YENI adreste kod bulamaz, yani deploy IKINCI bir
    #                 escrow indirir ve canli alacaklarin tamami yetim kalir.
    #   FeeSchedule : hook her swap'ta `tierFor`i cagirir, ve adresi
    #                 `LaunchFactory`nin constructor argumanidir, yani FACTORY
    #                 ADRESINI de belirler.
    #
    "FeeEscrow": "bf5338882879119b63c1908b67f50ce699aa3d05e3665138b5196e5161e957f8",
    "FeeSchedule": "93cdb1ff0a4bcf15489fe446382af1b632548b208f693f76664986a55e45dd5c",
    # ---------------------------------------------------------------
    # `LaunchFactory` ARTIK MUAF DEGIL, VE MUAFIYETI KALDIRAN SEY OLCULMUS BIR
    # SALDIRIDIR.
    #
    # Eski gerekce: "Faz 2 ona `feeSchedule` argumani ekledi, yani
    # initcode'unun degismesi beklenir." O gerekce initcode'un CANLI Faz 1
    # fabrikasindan farkli olmasi hakkindaydi ve HALA DOGRUDUR -- `check_chain`
    # `LaunchFactory`yi zaten bayt karsilastirmasina SOKMAZ. Ama muafiyet
    # yanlislikla sunu da soyluyordu: "bu agacin ICINDE hareket etmesi de
    # serbest."
    #
    # OLCULDU: constructor'daki dort atamanin SIRASINI degistirmek --
    # anlambilimsel olarak hicbir sey degistirmez -- kapiyi YESIL ve paketi
    # 607/607 birakiyor, fabrika adresini 0x5CA156f1... -> 0x2F0C56DB...
    # kaydiriyordu. `ArcpadHook`un madenlenmis tuzu o adrese BAGLI oldugu icin
    # hook KODSUZ bir fabrikaya baglanmis olurdu: `_beforeInitialize` sonsuza
    # kadar revert eder, hicbir havuz acilamaz, ve hook adresi her `PoolKey`de
    # yayinlandigi icin YENIDEN MADENLENEMEZ.
    #
    # Yani Faz 2'de `LaunchFactory`nin initcode'u BIR ADRES BELIRLEYICISIDIR.
    # Task 7 onu zincire yazdiginda bu satir DEGISMEZ -- pin zaten
    # yayinlanacak baytlardir.
    "LaunchFactory": "30949cdfb4969a97d960064261903d71f091421e6dcacd016b7c548ce03a808f",
}

# Canli olculmus adresler. `docs/`ta degil BURADA duruyorlar cunku kapinin
# kendisi onlari okur.
LIVE = {
    "LaunchToken": "0x1bd93613a7BC470a739D9615cdc65e535d958fab",
    "BondingCurve": "0x7938BE340A14A12f94a83AEa246d9d2566324c9C",
    "LaunchFactory": "0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439",
}

# ---------------------------------------------------------------------------
# FAZ 2, TASK 7 -- ZINCIRE YAZILDI. Bu tablo ZINCIRDEN degil BROADCAST
# DOSYASINDAN alindi ve sebebi olculdu: bir adresi kisaltilmis bir metinden
# ("0x5CA156f1...6B47") ELLE TAMAMLAMAK, kodsuz bir adres uretir ve o adres
# "deploy olmamis" gibi okunur. Adresler yalnizca uretildikleri yerden gelir.
#
# HER SATIRIN ARTIFACT'I FARKLI OLABILIR VE BU KASITLIDIR:
#   out-frozen/  -> `[profile.frozen]`, 800. YALNIZCA o profil yazabilir.
#   out/...v4core.json -> `PoolManager`a ULASAN birimler 44444444'te derlenir,
#                         ve YAYINLANAN bytecode ODUR (`ArcpadHook.t.sol`,
#                         `ArcpadLocker.t.sol`, `PoolSeedInvariants.t.sol` de
#                         `PoolManager`i ismiyle import eder, yani PAKETIN
#                         SINADIGI baytlar 44444444'lulardir).
# Yanlis varyanti secmek SESSIZ DEGILDIR: uzunluklar tutmaz ve kapi duser.
LIVE_PHASE2 = [
    # (ad, adres, artifact dizini, artifact yolu)
    ("FeeEscrow", "0xEEd4431eAD3E27F16D97f677A9C4c1a963DF8dC6",
     "out-frozen", "FeeEscrow.sol/FeeEscrow.json"),
    ("FeeSchedule", "0x47548C1ce996b24846E948B815459D98BB08dc84",
     "out-frozen", "FeeSchedule.sol/FeeSchedule.json"),
    ("LaunchFactory", "0x5CA156f1809aB784655410d0f4B0704d2b306B47",
     "out-frozen", "LaunchFactory.sol/LaunchFactory.json"),
    ("PoolManager", "0x617321A877e024C870516CD599A581dCDCa6c09b",
     "out", "PoolManager.sol/PoolManager.json"),
    ("ArcpadHook", "0xd95198Cd806B736C8EcEcfFC23976b59F565e0cC",
     "out", "ArcpadHook.sol/ArcpadHook.v4core.json"),
    ("ArcpadLocker", "0x0e7771091a3471Dc12CbfE38836BaDC7bf5a98E8",
     "out", "ArcpadLocker.sol/ArcpadLocker.v4core.json"),
]

# `ArcpadHook`un izin kumesi, adresin ALT 14 BITINDE. `PoolDeployLib`teki
# literalin ve `V4Wiring.t.sol`un bayraklardan turettigi degerin aynisi.
ARCPAD_HOOK_FLAGS = 0x20CC
HOOK_MASK = 0x3FFF

failures = []
notes = []


def fail(msg):
    failures.append(msg)
    print("  FAIL  " + msg)


def ok(msg):
    print("  ok    " + msg)


def artifact(name):
    p = os.path.join(CONTRACTS, "out-frozen", name + ".sol", name + ".json")
    if not os.path.exists(p):
        print("KAPI CALISAMADI: %s yok. `FOUNDRY_PROFILE=frozen forge build` kosmadi mi?" % p)
        sys.exit(2)
    with open(p) as f:
        return json.load(f)


def sha_of_inspect_output(hexstr):
    """`forge inspect ... bytecode | sha256sum` ciktisinin AYNISI."""
    return hashlib.sha256((hexstr + "\n").encode()).hexdigest()


def build_frozen():
    print("== [profile.frozen] derleniyor (out-frozen/) ==")
    env = dict(os.environ, FOUNDRY_PROFILE="frozen")
    r = subprocess.run(["forge", "build"], cwd=CONTRACTS, env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        sys.stdout.write(r.stdout.decode(errors="replace"))
        print("KAPI CALISAMADI: frozen profil derlenemedi.")
        sys.exit(2)


def check_settings():
    """AYARIN KENDISI, sonucun yani sira. Bir sonraki kisi `[profile.frozen]`e
    dokunursa hash zaten kirilir; bu satir SEBEBI de soyler."""
    print("== derleyici ayarlari ==")
    for name in ("BondingCurve", "LaunchFactory", "LaunchToken", "FeeEscrow", "FeeSchedule", "CurveMath"):
        runs = artifact(name)["metadata"]["settings"]["optimizer"]["runs"]
        (ok if runs == 800 else fail)("%-14s optimizer_runs = %s" % (name, runs))


def check_hashes():
    print("== dondurulmus creation code ==")
    for name, expected in FROZEN.items():
        got = sha_of_inspect_output(artifact(name)["bytecode"]["object"])
        if got == expected:
            ok("%-14s %s" % (name, got))
        else:
            # "PIN'I YENIDEN URETMEYIN" METNI BURADA DA DURUYOR VE SEBEBI
            # OLCULDU: bu kapinin kendi referans dizinini (`out-frozen/`) her
            # cagrida yeniden urettigi icin, kirmizi bir satiri "temizlemenin"
            # en kolay yolu degeri buraya kopyalamaktir -- ve o hareket
            # kapiyi tam olarak kapatmak icin var oldugu seye acar.
            fail("%-14s %s  (BEKLENEN %s) -- pin'i YENIDEN URETMEYIN, sebebini bulun"
                 % (name, got, expected))


def check_every_compared_contract_has_a_literal():
    """KAYNAKTAN TURETILEN KAPI: `DeployLib`in karsilastirdigi HER kontratin
    burada ELLE YAZILMIS bir hash'i olmali.

    NICIN. `assertMatchesFrozenBuild`in referansi `out-frozen/`dir ve o dizini
    BU KAPI her cagrida yeniden uretir; `Makefile`in `test: frozen-hash` on
    kosulu da bunu otomatik yapar. Yani o iddia, literal olmayan bir kontrat
    icin duzenlenmis derlemeyi KENDISIYLE karsilastirir -- olculdu:
    `FeeSchedule` 95 -> 94 ile kapi YESIL, `Deploy.t.sol` 53/53.

    Literal'ler eklendi, ama BIR SONRAKI kontrat icin ayni delik yeniden
    acilirdi. Bu satir onu kapatir ve elle tutulan bir listeye guvenmez:
    isimler `DeployLib.sol` KAYNAGINDAN, `_frozenCreationCode(dir, "X")`
    cagrilarindan okunur.

    `LaunchFactory` TEK ISTISNADIR ve gerekcesi yazilidir: Faz 2 ona
    `feeSchedule` argumani ekledi, yani initcode'unun DEGISMESI beklenir.
    Task 7 onu yayinladigi ANDA `FROZEN`a eklenmelidir -- o andan sonra
    hareket etmesi turetilen her curve ve token adresini kaydirir.
    """
    print("== DeployLib'in karsilastirdigi her kontratin literali var mi ==")
    # ARTIK MUAF KIMSE YOK. Bos birakilmasi kasitlidir: bir sonraki muafiyet
    # gerekcesiyle BURAYA yazilmali ve kapinin ciktisinda GORUNMELIDIR.
    excused = {}
    src_path = os.path.join(CONTRACTS, "script", "DeployLib.sol")
    with open(src_path, encoding="utf-8") as f:
        src = f.read()

    # IKI LISTE VARDI VE KURAL BIRINI GORMUYORDU -- BU BIR INCELEME BULGUSU.
    # Ilk hali yalnizca `_frozenCreationCode` cagrilarini tariyordu, yani
    # KARDES kumeyi (yeniden kullanim kimlik kontrolunun karsilastirdigi
    # kontratlar, `_assertVacantOrTheFrozenBuild`) hic gormuyordu: oraya
    # literali olmayan bir isim eklemek kapiyi YESIL ve SESSIZ birakiyordu.
    # Ikisi de ayni ozelligi tasir -- referans `out-frozen/`dir, o dizin bu
    # agactan uretilir, dolayisiyla literalsiz her isim KENDISIYLE
    # karsilastirilir.
    # ILK ARGUMAN HERHANGI BIR IFADE OLABILIR, `dir` OLMAK ZORUNDA DEGIL --
    # ve bunu `dir`e sabitlemek bir ELEME BOSLUGUYDU: `_frozenCreationCode(d,
    # "X")` diye yazilmis bir cagri SESSIZCE sayilmazdi, ve liste bos
    # olmadigi icin fail-closed dal da tetiklenmezdi. Kural artik ilk
    # argumani UMURSAMAZ; okudugu tek sey KONTRAT ADIDIR.
    initcode_cmp = re.findall(r'_frozenCreationCode\(\s*[^,()]+\s*,\s*"([A-Za-z0-9_]+)"\s*\)', src)
    runtime_cmp = re.findall(r'_assertVacantOrTheFrozenBuild\(\s*[^,()]+\s*,\s*"([A-Za-z0-9_]+)"', src)
    if not initcode_cmp:
        fail("DeployLib.sol icinde `_frozenCreationCode(dir, \"...\")` cagrisi BULUNAMADI -- "
             "kapi kaynaktan turetiyor ve turetme BOS dondu")
        return
    if not runtime_cmp:
        fail("DeployLib.sol icinde `_assertVacantOrTheFrozenBuild(dir, \"...\")` cagrisi BULUNAMADI -- "
             "yeniden kullanim kumesi BOS gorunuyor")
        return

    for name in sorted(set(initcode_cmp) | set(runtime_cmp)):
        where = []
        if name in initcode_cmp:
            where.append("initcode")
        if name in runtime_cmp:
            where.append("yeniden kullanim")
        tag = "+".join(where)
        if name in FROZEN:
            ok("%-14s karsilastiriliyor (%s) VE literali var" % (name, tag))
        elif name in excused:
            print("  --    %-14s literali YOK (bilincli): %s" % (name, excused[name]))
            notes.append("%s'nin literali yok: %s" % (name, excused[name]))
        else:
            fail("%s `DeployLib` tarafindan karsilastiriliyor (%s) ama FROZEN'da literali YOK -- "
                 "referansi bu agactan uretiliyor, yani iddia kendisiyle karsilastiriyor" % (name, tag))


def check_factory_embeds():
    """(1)-(2) YUZEYLERI SABITLER, BU SATIR BAGIMLILIGI SABITLER.

    `LaunchFactory` `new BondingCurve(...)` ve `new LaunchToken{salt:}(...)`
    yazar, yani IKI initcode'u da KENDI runtime kodunun icinde tasir.
    Adresler CREATE2 ile o initcode'dan turer. Tek basina hash'leri
    karsilastirmak bunu GOREMEZ: olculdu -- `LaunchToken`in bagimsiz
    artifact'i pin'e BIRE BIR uyarken, fabrikanin gomdugu initcode BASKA bir
    derlemeden geliyordu ve TURETILEN HER TOKEN ADRESI kaymisti.
    """
    print("== fabrikanin GOMDUGU initcode ==")
    factory = artifact("LaunchFactory")["deployedBytecode"]["object"][2:].lower()
    for name in ("BondingCurve", "LaunchToken"):
        init = artifact(name)["bytecode"]["object"][2:].lower()
        if init in factory:
            ok("LaunchFactory, frozen %s initcode'unu iceriyor" % name)
        else:
            fail("LaunchFactory frozen %s initcode'unu ICERMIYOR -- turetilen adresler kayar" % name)


def frozen_closure():
    """Frozen profilin FIILEN derledigi dosyalarin kumesi.

    Elle yazilmis bir liste degil: her artifact'in kendi
    `metadata.sources` anahtarlari, yani solc'un o girdide gordugu dosyalar.
    """
    files = set()
    for name in ("BondingCurve", "LaunchFactory", "LaunchToken", "FeeEscrow", "FeeSchedule", "CurveMath"):
        files.update(artifact(name)["metadata"]["sources"].keys())
    return files


def check_no_restriction_touches_the_frozen_closure():
    """AYARIN KENDISINI OLCEN SATIR, SONUCU DEGIL -- VE BU KAPININ EN COK
    IHTIYAC DUYDUGU SATIRDIR.

    Kirilma tam olarak soyle oldu: `compilation_restrictions` `paths`i
    `lib/v4-core/src/**` yaziyordu, ve `libraries/CurveMath.sol` --
    DONDURULMUS ALTI DOSYADAN BIRI -- `lib/v4-core/src/libraries/FullMath.sol`i
    import ediyor. Bir solc girdisinin TEK optimizer ayari oldugu icin
    `CurveMath` iceren her birim 44444444 olmak zorunda kaldi ve
    `BondingCurve`, `LaunchFactory` onunla birlikte kaydi.

    `[profile.frozen]` KENDI kisitlarini bosalttigi icin, o glob'u yeniden
    genisleten biri BU KAPIYI TEK BASINA KIRAMAZDI: kapi yesil kalir,
    `out/`taki artifact'ler ve `forge test`in derledigi bytecode kayar.
    Bu satir tam olarak o boslugu kapatir ve mekanizmayi -- "dondurulmus
    kapanistaki HICBIR dosya kisitli OLAMAZ" -- calistirilabilir kilar.
    """
    print("== default/ci kisitlari dondurulmus kapanisa dokunuyor mu ==")
    closure = frozen_closure()
    for profile in ("default", "ci"):
        env = dict(os.environ, FOUNDRY_PROFILE=profile)
        r = subprocess.run(["forge", "config", "--json"], cwd=CONTRACTS, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if r.returncode != 0:
            fail("%s profili icin `forge config --json` basarisiz" % profile)
            continue
        cfg = json.loads(r.stdout.decode())
        hits = []
        for restriction in (cfg.get("compilation_restrictions") or []):
            pattern = restriction.get("paths")
            if not pattern:
                continue
            # `fnmatch`in `*`i `/` uzerinden de eslesir, yani bu kontrol
            # globset'ten DAHA GENIS -- fazladan eslesme uretebilir, kacirma
            # uretemez. Bir kapinin yanlislik yonu bu olmali.
            hits += [(pattern, f) for f in sorted(closure) if fnmatch.fnmatch(f, pattern)]
        if hits:
            fail("[profile.%s] kisiti dondurulmus kapanistaki %d dosyayla eslesiyor "
                 "(ornek: %s -> %s) -- dondurulmus bytecode KAYAR"
                 % (profile, len(hits), hits[0][0], hits[0][1]))
        else:
            ok("[profile.%s] hicbir kisiti dondurulmus kapanistaki %d dosyayla eslesmiyor"
               % (profile, len(closure)))


def check_indexer_pin():
    """Faz 3'un pin'i ile kapinin pin'i AYRISAMAZ."""
    print("== indexer pin'i ==")
    p = os.path.join(REPO, "indexer", "src", "launch-token.generated.ts")
    if not os.path.exists(p):
        notes.append("indexer pin dosyasi yok, atlandi: %s" % p)
        print("  --    %s yok, atlandi" % p)
        return
    with open(p, encoding="utf-8") as f:
        src = f.read()
    m = re.search(r"LAUNCH_TOKEN_CREATION_CODE: Hex =\s*'(0x[0-9a-fA-F]+)'", src)
    if not m:
        fail("indexer pin dosyasi okunamadi (LAUNCH_TOKEN_CREATION_CODE bulunamadi)")
        return
    pinned = m.group(1).lower()
    built = artifact("LaunchToken")["bytecode"]["object"].lower()
    if pinned == built:
        ok("launch-token.generated.ts, frozen LaunchToken initcode'una esit (%d bayt)" % (len(built[2:]) // 2))
    else:
        fail("launch-token.generated.ts frozen initcode'dan AYRISTI "
             "(pin %d bayt, frozen %d bayt) -- pin'i YENIDEN URETMEYIN, sebebini bulun"
             % (len(pinned[2:]) // 2, len(built[2:]) // 2))


# ---------------------------------------------------------------------------
# Zincir
# ---------------------------------------------------------------------------

def immutable_mask(art):
    """Artifact'in KENDI `immutableReferences`i. Elle goz karari bir aralik
    listesi degil; solc'un bildirdigi aralik."""
    spans = []
    for _, refs in (art["deployedBytecode"].get("immutableReferences") or {}).items():
        for r in refs:
            spans.append((r["start"], r["start"] + r["length"]))
    return spans


def artifact_at(dirname, relpath):
    """`artifact()`in dizin-parametreli ikizi. `ArcpadHook` ve `ArcpadLocker`
    `[profile.frozen]`in `skip` listesindedir (v4-core'a ulasirlar), yani
    `out-frozen/` altinda HIC uretilmezler -- onlar icin tek kaynak `out/`tur."""
    p = os.path.join(CONTRACTS, dirname, relpath)
    if not os.path.exists(p):
        fail("artifact yok: %s" % p)
        return None
    with open(p) as f:
        return json.load(f)


def compare_artifact_to_chain(name, address, art, rpc):
    """`compare_to_chain`in govdesi, artifact DISARIDAN verilmis hali."""
    if art is None:
        return
    local = art["deployedBytecode"]["object"][2:].lower()
    r = subprocess.run(["cast", "code", address, "--rpc-url", rpc],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        fail("%s: `cast code` basarisiz -- %s" % (name, r.stdout.decode(errors="replace").strip()[:200]))
        return
    onchain = r.stdout.decode().strip()[2:].lower()
    if len(onchain) == 0:
        fail("%s: %s adresinde kod YOK" % (name, address))
        return
    if len(onchain) != len(local):
        fail("%s: uzunluk farkli -- zincir %d bayt, artifact %d bayt (AYNI KONTRAT DEGIL)"
             % (name, len(onchain) // 2, len(local) // 2))
        return
    spans = immutable_mask(art)

    def masked(i):
        return any(a <= i < b for a, b in spans)
    bad = [i for i in range(len(onchain) // 2)
           if onchain[2 * i:2 * i + 2] != local[2 * i:2 * i + 2] and not masked(i)]
    if bad:
        fail("%s: immutable ARALIKLARININ DISINDA %d bayt farkli (ilk offset %d)"
             % (name, len(bad), bad[0]))
        return
    differing = sum(1 for i in range(len(onchain) // 2)
                    if onchain[2 * i:2 * i + 2] != local[2 * i:2 * i + 2])
    ok("%-14s %s  %d bayt, fark YALNIZCA immutable slotlarda (%d bayt, %d aralik)"
       % (name, address, len(local) // 2, differing, len(spans)))


def compare_to_chain(name, address, rpc):
    art = artifact(name)
    local = art["deployedBytecode"]["object"][2:].lower()
    r = subprocess.run(["cast", "code", address, "--rpc-url", rpc],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        fail("%s: `cast code` basarisiz -- %s" % (name, r.stdout.decode(errors="replace").strip()[:200]))
        return
    onchain = r.stdout.decode().strip()[2:].lower()
    if len(onchain) == 0:
        fail("%s: %s adresinde kod YOK" % (name, address))
        return
    if len(onchain) != len(local):
        fail("%s: uzunluk farkli -- zincir %d bayt, frozen %d bayt (AYNI KONTRAT DEGIL)"
             % (name, len(onchain) // 2, len(local) // 2))
        return
    spans = immutable_mask(art)
    def masked(i):
        return any(a <= i < b for a, b in spans)
    bad = [i for i in range(len(onchain) // 2)
           if onchain[2 * i:2 * i + 2] != local[2 * i:2 * i + 2] and not masked(i)]
    if bad:
        fail("%s: immutable ARALIKLARININ DISINDA %d bayt farkli (ilk offset %d)"
             % (name, len(bad), bad[0]))
    else:
        differing = sum(1 for i in range(len(onchain) // 2)
                        if onchain[2 * i:2 * i + 2] != local[2 * i:2 * i + 2])
        ok("%-14s %s  %d bayt, fark YALNIZCA immutable slotlarda (%d bayt, %d aralik)"
           % (name, address, len(local) // 2, differing, len(spans)))


def check_chain():
    print("== canli zincir ==")
    rpc = os.environ.get("ARC_RPC_URL")
    if not rpc:
        env_path = os.path.join(REPO, ".env")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("ARC_RPC_URL="):
                        rpc = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not rpc:
        print("  --    ARC_RPC_URL yok, zincir karsilastirmasi ATLANDI")
        notes.append("zincir karsilastirmasi atlandi (ARC_RPC_URL yok)")
        return
    compare_to_chain("LaunchToken", LIVE["LaunchToken"], rpc)
    compare_to_chain("BondingCurve", LIVE["BondingCurve"], rpc)
    # `LaunchFactory` BILEREK BYTE KARSILASTIRMASINA GIRMEZ: canli fabrika
    # Faz 1 kaynagindandir, Faz 2 ona `feeSchedule` argumani ekledi. Anlamli
    # olan iddia sudur -- canli fabrikanin GOMDUGU initcode'lar, bu agacin
    # frozen initcode'lariyla ayni olmali; adresler onlardan turer.
    r = subprocess.run(["cast", "code", LIVE["LaunchFactory"], "--rpc-url", rpc],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        fail("LaunchFactory: `cast code` basarisiz")
        return
    live_factory = r.stdout.decode().strip()[2:].lower()
    for name in ("BondingCurve", "LaunchToken"):
        init = artifact(name)["bytecode"]["object"][2:].lower()
        if init in live_factory:
            ok("CANLI fabrika, frozen %s initcode'unu iceriyor" % name)
        else:
            fail("CANLI fabrika frozen %s initcode'unu ICERMIYOR -- bu agac zinciri URETEMIYOR" % name)

    check_chain_phase2(rpc)


def call(rpc, address, sig):
    r = subprocess.run(["cast", "call", address, sig, "--rpc-url", rpc],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        return None
    return r.stdout.decode(errors="replace").strip()


def same_addr(a, b):
    return a is not None and b is not None and a.lower() == b.lower()


def check_chain_phase2(rpc):
    """TASK 7'NIN INDIRDIGI BES YENI ADRES + YENIDEN KULLANILAN ESCROW.

    BU KONTROLUN PENCERESI KAPANIYOR VE SEBEBI YAPISALDIR: `ArcpadHook`un
    adresi izin kumesini kodlar ve her `PoolKey`in ALANIDIR, yani Task 8'in
    ILK havuz initialize'ina kadar yeniden madenlenebilir, ondan SONRA asla.
    Burada bulunan bir uyusmazlik duzeltilebilir; ayni uyusmazlik Task 8'den
    sonra duzeltilemez."""
    print("== FAZ 2 / Task 7, canli zincir ==")
    for name, address, dirname, relpath in LIVE_PHASE2:
        compare_artifact_to_chain(name, address, artifact_at(dirname, relpath), rpc)

    addr = dict((n, a) for n, a, _, _ in LIVE_PHASE2)

    # IZIN KUMESI ARTIK BIR TAHMIN DEGIL, GERCEK KOD. Adresin alt 14 biti
    # zincirdeki hook'un ta kendisinden okunur.
    low = int(addr["ArcpadHook"], 16) & HOOK_MASK
    if low == ARCPAD_HOOK_FLAGS:
        ok("ArcpadHook adresinin alt 14 biti 0x%04X -- arcpad izin kumesi" % low)
    else:
        fail("ArcpadHook adresinin alt 14 biti 0x%04X, beklenen 0x%04X -- HOOK YANLIS IZINLERLE INDI"
             % (low, ARCPAD_HOOK_FLAGS))

    # ...VE O SAYI BAYRAKLARIN TOPLAMI. `V4Wiring.t.sol` bunu Solidity'de
    # `Hooks.*` sabitlerinden turetir; burada literal durur, iki taraf
    # birbirini olcsun diye.
    flags = {"BEFORE_INITIALIZE": 0x2000, "BEFORE_SWAP": 0x80, "AFTER_SWAP": 0x40,
             "BEFORE_SWAP_RETURNS_DELTA": 0x8, "AFTER_SWAP_RETURNS_DELTA": 0x4}
    total = 0
    for v in flags.values():
        total |= v
    if total == ARCPAD_HOOK_FLAGS:
        ok("0x%04X == %s" % (total, " | ".join(flags)))
    else:
        fail("bayraklarin toplami 0x%04X, pin 0x%04X" % (total, ARCPAD_HOOK_FLAGS))

    # BAGLANTILAR. `assertAsDeployed` bunlari `run()` icinde okur -- ama
    # `--resume` yolunda KOSMAZ (olculdu), yani zincirden bagimsiz okumak
    # opsiyonel degildir.
    wiring = [
        ("hook.poolManager", addr["ArcpadHook"], "poolManager()(address)", addr["PoolManager"]),
        ("hook.factory", addr["ArcpadHook"], "factory()(address)", addr["LaunchFactory"]),
        ("hook.escrow", addr["ArcpadHook"], "escrow()(address)", addr["FeeEscrow"]),
        ("locker.poolManager", addr["ArcpadLocker"], "poolManager()(address)", addr["PoolManager"]),
        ("locker.factory", addr["ArcpadLocker"], "factory()(address)", addr["LaunchFactory"]),
        ("locker.hook", addr["ArcpadLocker"], "hook()(address)", addr["ArcpadHook"]),
        ("factory.escrow", addr["LaunchFactory"], "escrow()(address)", addr["FeeEscrow"]),
        ("factory.feeSchedule", addr["LaunchFactory"], "feeSchedule()(address)", addr["FeeSchedule"]),
        ("poolManager.owner", addr["PoolManager"], "owner()(address)",
         "0x970534698e4592932F31892759147f79EB0D2C22"),
    ]
    for label, target, sig, want in wiring:
        got = call(rpc, target, sig)
        if same_addr(got, want):
            ok("%-20s -> %s" % (label, want))
        else:
            fail("%s -> %s, beklenen %s" % (label, got, want))

    # PROFIL SAYILARI. Yanlis BUYUKLUKTEKI bir `V` yedi korumadan da gecer;
    # onu yakalayan tek yer zincirin kendisidir.
    for sig, want in (("VIRTUAL_TOKEN_RESERVES()(uint256)", "1073000000000000000000000000"),
                      ("VIRTUAL_QUOTE_RESERVES()(uint256)", "4292000000000000000"),
                      ("SALE_SUPPLY()(uint256)", "793100000000000000000000000"),
                      ("launchCount()(uint256)", "0")):
        got = call(rpc, addr["LaunchFactory"], sig)
        got = (got or "").split()[0] if got else got
        if got == want:
            ok("factory.%-28s = %s" % (sig.split("(")[0], want))
        else:
            fail("factory.%s = %s, beklenen %s" % (sig.split("(")[0], got, want))

    # YENIDEN KULLANIM KOLU GERCEKTEN ISLEDI MI. Faz 1'in alacaklari IKINCI
    # bir escrow'a yetim dusmediyse bu sayi KIMILDAMAMIS olmali.
    owed = call(rpc, addr["FeeEscrow"], "totalOwed()(uint256)")
    owed = (owed or "").split()[0] if owed else owed
    if owed == "152069146725900635":
        ok("FeeEscrow.totalOwed = 152069146725900635 -- YENIDEN KULLANILDI, Faz 1 alacaklari YERINDE")
    else:
        fail("FeeEscrow.totalOwed = %s, beklenen 152069146725900635 -- IKINCI BIR ESCROW MU INDI?" % owed)

    # `graduationTarget` HENUZ BOS OLMALI: Task 8 ayri ve INCELENMIS bir adim.
    gt = call(rpc, addr["LaunchFactory"], "graduationTarget()(address)")
    if same_addr(gt, "0x0000000000000000000000000000000000000000"):
        ok("factory.graduationTarget = 0x0 -- Task 8 HENUZ KOSMADI")
    else:
        fail("factory.graduationTarget = %s -- BOS OLMALIYDI" % gt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", action="store_true", help="canli Arc kodunu da karsilastir")
    ap.add_argument("--no-build", action="store_true", help="frozen profili yeniden derleme (SADECE hata ayiklama)")
    a = ap.parse_args()

    if not a.no_build:
        build_frozen()
    check_settings()
    check_hashes()
    check_every_compared_contract_has_a_literal()
    check_factory_embeds()
    check_no_restriction_touches_the_frozen_closure()
    check_indexer_pin()
    if a.chain:
        check_chain()

    print()
    for n in notes:
        print("NOT: " + n)
    if failures:
        print("DONDURULMUS BYTECODE KAPISI KIRMIZI -- %d iddia dustu:" % len(failures))
        for f_ in failures:
            print("  - " + f_)
        sys.exit(1)
    print("DONDURULMUS BYTECODE KAPISI YESIL.")


if __name__ == "__main__":
    main()
