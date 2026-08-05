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
FROZEN = {
    "BondingCurve": "8e2460fff48ee5b6c591d0c62041936a7c63099d2ae1d636fa3bd2b927b4982f",
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
    # `LaunchFactory` BILEREK BURADA DEGIL: Faz 2 ona `feeSchedule` argumani
    # ekledi, yani initcode'unun DEGISMESI BEKLENIYOR. Task 7 onu zincire
    # yazdiginda buraya EKLENMELIDIR -- o andan itibaren hareket etmesi
    # turetilmis her curve ve token adresini kaydirir.
    "FeeEscrow": "bf5338882879119b63c1908b67f50ce699aa3d05e3665138b5196e5161e957f8",
    "FeeSchedule": "93cdb1ff0a4bcf15489fe446382af1b632548b208f693f76664986a55e45dd5c",
}

# Canli olculmus adresler. `docs/`ta degil BURADA duruyorlar cunku kapinin
# kendisi onlari okur.
LIVE = {
    "LaunchToken": "0x1bd93613a7BC470a739D9615cdc65e535d958fab",
    "BondingCurve": "0x7938BE340A14A12f94a83AEa246d9d2566324c9C",
    "LaunchFactory": "0x0d75a4fFb8CD6dB4237557E9519591b94d6Ab439",
}

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", action="store_true", help="canli Arc kodunu da karsilastir")
    ap.add_argument("--no-build", action="store_true", help="frozen profili yeniden derleme (SADECE hata ayiklama)")
    a = ap.parse_args()

    if not a.no_build:
        build_frozen()
    check_settings()
    check_hashes()
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
