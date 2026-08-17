#!/usr/bin/env python3
"""
============================================================================
 BAGIMLILIK SABITLEME KAPISI
============================================================================

Mezuniyet sonrasi butun likidite `v4-core`un `PoolManager`inda durur ve her
`LaunchToken` OZ'un `ERC20`sidir. Yani bu depo, KENDI kodundan cok daha fazla
degeri BASKASININ koduna emanet ediyor -- ve o kodun hangi commit oldugu
`.gitmodules`ta DEGIL, ust deponun agacinda yazilidir.

BU KAPI DENETIMDE (ucuncu gecis) ACILDI ve sebebi sudur: sabitlemelerin
DOGRULUGU incelendi ama SABIT KALDIGINI kimse kontrol etmiyordu. Tek bir
`git submodule update --remote`, denetlenmis kodu sessizce baska bir seyle
degistirir ve HICBIR test bunu gormezdi -- butun testler yeni kodla derlenir
ve yesil kalir.

============ ONCE BIR UYARI: `git describe` BAYAT ETIKETLE YALAN SOYLER ============

Bu blogun ILK hali UCUNUN nitelemesini YANLIS yaziyordu ve sebebi sudur:
`git submodule status`un parantez icinde gosterdigi metin `git describe`dir ve
o, YEREL KLONDA BULUNAN etiketlere bakar. Etiketler bayatsa en yakin ESKI
etikete gore "surum + N commit" der. Bu depoda tam olarak bu oldu:

    fetch ONCESI                          fetch SONRASI (gercek)
    openzeppelin  v5.0.0-12-gdbb6104c  ->  v5.0.2        (KARARLI SURUM)
    uniswap-hooks v1.2.0-rc.0-21-g...  ->  v1.2.1        (KARARLI SURUM)

Yani "release adayinin 21 commit ilerisi" diye okunan sey, aslinda KARARLI
v1.2.1'in TA KENDISIYDI. Bir pini degerlendirmeden once `git fetch --tags`.

============ INCELEMENIN SONUCU, VE NICIN BU COMMIT'LER ============

  openzeppelin   TAM OLARAK `v5.0.2` -- kararli surum, v5.0.0'IN ILERISI
                 OLMASI BIR KAZANCTIR: v5.0.1 ERC2771Context/Multicall
                 acigini, v5.0.2 Base64 duzeltmesini getirir. Ikisini de
                 kullanmiyoruz, ama yon ileri.
                 OLCULDU: derledigimiz 9 OZ dosyasi ile v5.0.0'da DEGISEN
                 dosyalarin KESISIMI TEK DOSYADIR -- `utils/Context.sol`,
                 eklenen sey `_contextSuffixLength()`. `LaunchToken`,
                 `LaunchFactory` ve `BondingCurve` v5.0.0'a karsi yeniden
                 derlendi: initcode ve deployed bytecode BIT BIT AYNI.
                 Yani o ekleme olu koddur, optimizer atiyor.

  uniswap-hooks  TAM OLARAK `v1.2.1` -- kararli surum (rev-parse ile
                 dogrulandi). Ondan derledigimiz dosya SAYISI IKIDIR:
                 `base/BaseHook.sol` ve `utils/CurrencySettler.sol`.
                 Ikincisi v1.2.0-rc.0'dan beri HIC DEGISMEDI.
                 BaseHook'taki degisiklik ARC'TA CALISMANIN ONKOSULUDUR,
                 tercih degil: rc.0'da `poolManager()` SANAL bir fonksiyondu
                 ve SABIT KODLANMIS MAINNET adresi donuyordu
                 (0x000000000004444c5dc75cB358380D2e3dE08A90 -- Arc'ta o
                 adreste KOD YOK, olculdu). O surume sabitlenip override
                 edilmeseydi `onlyPoolManager` bizim PoolManager'imizi
                 REDDEDER ve HICBIR HAVUZ ACILAMAZDI. Yeni halde adres
                 constructor'dan gelir ve `immutable`dir -- bir alt sinif
                 EZEMEZ, yani ayrica guclendirmedir.

  v4-core        v4.0.0 + 21 commit; DAHA YENI ETIKET YOK, yani gercekten
                 etiketin ilerisindeyiz. AMA DAVRANISI DEGISMEDIGI TAHMIN
                 EDILMEDI, KANITLANDI:
                   * 46 uretim dosyasinin 41'i v4.0.0 ile BYTE-IDENTICAL.
                   * Degisen 5: PoolManager.sol, Hooks.sol, IHooks.sol,
                     IPoolManager.sol ve yeni PoolOperation.sol. Hepsi ayni
                     islem: `ModifyLiquidityParams`/`SwapParams` struct'lari
                     `IPoolManager`dan ayri bir dosyaya tasindi. Struct
                     alanlari, sirasi ve tipleri BIREBIR AYNI.
                   * `PoolManager` v4.0.0'a karsi AYNI derleyici ayarlariyla
                     (solc 0.8.26, runs 44444444, cancun, viaIR) yeniden
                     derlendi: deployed bytecode BIT BIT AYNI.
                   * `Hooks.sol` internal bir kutuphanedir, yani PoolManager'a
                     INLINE edilir -- ustteki bit esitligi onun kod uretimini
                     de kanitlar. IHooks/IPoolManager arayuz, runtime kodu yok.
                 Ve bu, en cok onem verilmesi gereken yerdir: `PoolManager`i
                 BIZ deploy ediyoruz (CREATE2, salt keccak("arcpad.PoolManager.v1"),
                 0x617321A877e024C870516CD599A581dCDCa6c09b), yani mezuniyet
                 likiditesini tutan bytecode BIZIM derlememizdir.

                 EN GUCLU KANIT VE OLCULDU: Arc'taki bu kontrat ile ETHEREUM
                 MAINNET'teki KANONIK Uniswap v4 PoolManager'i
                 (0x000000000004444c5dc75cB358380D2e3dE08A90) 24.009 BAYTIN
                 TAMAMINDA AYNIDIR -- tek fark 13618. bayttaki 20 bayttir ve o
                 20 bayt her kontratin KENDI ADRESIDIR (noDelegateCall'in
                 immutable'i):
                     mainnet: 000000000004444c5dc75cb358380d2e3de08a90
                     arc    : 617321a877e024c870516cd599a581dcdca6c09b
                 Yani "esdeger" ya da "ayni kaynaktan derlenmis" degil: AYNI
                 BAYTLAR. Uniswap v4'un butun denetim yuzeyi bizim dagitimimiza
                 DOGRUDAN uygulanir. Bu ayni zamanda derleyici ayarlarimizin
                 Uniswap'inkiyle birebir ortustugunu de kanitlar.

  v4-periphery   ETIKET YOK -- klonda hic etiket yok, main dalinin bir
                 commit'i (3245c3cb, 2026-07-13). TEK GERCEK ACIK NOKTA BU,
                 ve yuzeyi TEK DOSYADIR: `libraries/LiquidityAmounts.sol`.
                 O dosyanin TUM gecmisi iki commit: 2024-11-22 (islevsel) ve
                 2025-11-03 "Fix linting" -- ki o commit'in bu dosyadaki tam
                 diff'i BIR `if` GOVDESINE SUSLU PARANTEZ EKLEMEKTIR. Yani
                 anlamca 2024-11 surumu; matematik Uniswap V3'ten beri ayni.
                 Ayrica sonucuna GUVENILMIYOR: `ArcpadLocker` likiditeyi
                 `PoolManager`in KENDI durumundan geri okur
                 (`getPositionInfo` -> `PositionNotSeeded`), fiyati geri okur
                 (`getSlot0` -> `PoolPriceMismatch`) ve havuzun talep ettigi
                 miktarlari elindekiyle karsilastirir (`SeedShortfall`).
                 Kutuphane yanilsa sonuc SESSIZ KAYIP degil, REVERT'tir.

  forge-std      v1.16.2, temiz etiket. Yalnizca test.

============ NICIN IKI KONTROL, VE IKINCISI NICIN GEREKLI ============

Ilk kontrol yukaridaki bes literaldir. Tek basina YETMEZ, ve sebebi olculdu:
agacta 30'dan fazla IC ICE submodule var (`lib/v4-core/lib/solmate`,
`lib/uniswap-hooks/lib/v4-core`, ...) ve ust seviye `git submodule status`
onlara HIC BAKMAZ. Ic ice bir kopyada `git checkout <baska>` yapmak, ust
seviyenin bes hash'ini OLDUGU GIBI birakir. Yani yalnizca literal karsilastiran
bir kapi, agacin derinliginde duran bir degisikligi YESIL gecirirdi.

Ikinci kontrol bunu kapatir: `--recursive` ciktisindaki HER satirin durum
oneki bos olmalidir. `+` "checkout, ebeveynin KAYDETTIGI commit'ten farkli"
demektir -- ic ice kayma tam olarak boyle gorunur. `-` "hic kurulmamis"
demektir ve o da kirmizidir: kurulmamis bir bagimlilik, dogrulanmamis bir
bagimliliktir. Ikisi birlikte sunu verir: kaydedilen pinler DOGRU, ve agacta
hicbir yer kaydedilenden SAPMAMIS.

Bes literalin agacin TAMAMINI temsil ettigi de olculdu, tahmin edilmedi: yedi
uretim kontratinin (`ArcpadHook`, `ArcpadLocker`, `LaunchFactory`,
`BondingCurve`, `LaunchToken`, `FeeEscrow`, `FeeSchedule`) `forge inspect
metadata` kaynak listesinde `lib/<x>/lib/<y>` bicimli TEK BIR yol yok --
hepsi ilk seviye bes submodule'e derleniyor. `auto_detect_remappings = true`
oldugu icin bu KENDILIGINDEN dogru degildi; bakildi.

============ BU KAPI NE YAPAR, NE YAPMAZ ============

Sabitlemelerin DEGISMEDIGINI soyler. Yeni bir commit'in GUVENLI oldugunu
SOYLEMEZ -- onu bir insan inceler. Kapi duserse dogru tepki hash'i
guncellemek DEGIL, once yukaridaki incelemeyi o commit icin TEKRARLAMAKTIR;
sonra hem hash hem gerekce burada guncellenir.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# path -> (beklenen commit, beklenen etiket ya da None, kisa gerekce)
#
# ETIKET SUTUNU BIR YORUM DEGIL, KONTROL EDILIR. Bu blogun ilk hali ucunun
# nitelemesini bayat `git describe` ciktisina bakarak yanlis yazdi; bir metin
# yanlis olabilir, `git rev-parse v5.0.2 == pin` olamaz. Etiket yerelde yoksa
# kontrol ATLANIR ve bu SOYLENIR -- commit hash'i zaten baglayicidir, etiket
# ona ANLAM katar.
PINS: dict[str, tuple[str, str | None, str]] = {
    "contracts/lib/v4-core": (
        "46c6834698c48bc4a463a86d8420f4eb1d7f3b75",
        None,  # daha yeni etiket yok; v4.0.0 + 21 commit
        "v4.0.0+21; PoolManager bytecode'u v4.0.0 ile BIT BIT AYNI (olculdu)",
    ),
    "contracts/lib/openzeppelin-contracts": (
        "dbb6104ce834628e473d2173bbc9d47f81a9eec3",
        "v5.0.2",
        "kararli surum; kesisim tek dosya (Context.sol), bytecode degismiyor",
    ),
    "contracts/lib/uniswap-hooks": (
        "acbd604c409a827f7f98c9517236da860c4fca1a",
        "v1.2.1",
        "kararli surum; rc.0'daki sabit MAINNET adresi Arc'ta calismazdi",
    ),
    "contracts/lib/v4-periphery": (
        "3245c3cb99c48fa1dc2459c3b60abc37d4294aba",
        None,  # depoda hic etiket yok
        "etiketsiz; tek dosya (LiquidityAmounts), sonucu locker'da geri okunur",
    ),
    "contracts/lib/forge-std": (
        "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b",
        "v1.16.2",
        "temiz etiket; yalnizca test",
    ),
}


def tag_commit(sub_path: str, tag: str) -> str | None:
    """Etiketin cozuldugu commit; etiket yerelde yoksa None."""
    r = subprocess.run(
        ["git", "-C", str(ROOT / sub_path), "rev-parse", f"{tag}^{{commit}}"],
        capture_output=True,
        text=True,
    )
    return r.stdout.strip() if r.returncode == 0 else None


def submodule_status(recursive: bool) -> list[tuple[str, str, str]]:
    """(durum_oneki, sha, yol) -- onek bos, '+', '-' ya da 'U' olur."""
    cmd = ["git", "submodule", "status"] + (["--recursive"] if recursive else [])
    out = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=True).stdout
    rows: list[tuple[str, str, str]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        # " <sha> <yol> (<describe>)" -- ILK karakter durumu bildirir ve
        # `strip()` onu YER. Bu yuzden satir ham haliyle ayristirilir.
        prefix = line[0] if line[0] in "+-U" else " "
        parts = line[1:].split() if prefix != " " else line.split()
        if len(parts) >= 2:
            rows.append((prefix, parts[0], parts[1].replace("\\", "/")))
    return rows


# --mainnet ile kosulan ZINCIR kontrolu. CI'da KOSMAZ ve bu bilinclidir:
# disaridaki bir RPC'yi zorunlu kapiya cevirmek, kapiyi ag hatasiyla kirmizi
# yapardi -- ve "insanlarin gormezden gelmeye alistigi bir kapi, hic olmayan
# bir kapidan kotudur" dersi bu depoda iki kez ogrenildi. Elle kosulur.
ARC_RPC = ["https://rpc.testnet.arc.network"]
# Birden fazla ucnokta, cunku bir kamu RPC'sinin reddi bir BULGU degildir.
# `User-Agent` sart: ciplak urllib istegi publicnode'da 403 aliyor (olculdu).
ETH_RPC = [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
]
ARC_POOL_MANAGER = "0x617321A877e024C870516CD599A581dCDCa6c09b"
# Uniswap v4'un Ethereum mainnet'teki kanonik PoolManager'i.
ETH_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90"
# `noDelegateCall`in `immutable`i: kontratin KENDI adresi. Iki dagitimin
# ayrilmasi GEREKEN tek yer burasidir.
IMMUTABLE_SELF_OFFSET = 13618


def get_code(rpcs: list[str], address: str) -> str | None:
    import json as _json
    import urllib.request

    body = _json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": [address, "latest"]}
    ).encode()
    for rpc in rpcs:
        try:
            req = urllib.request.Request(
                rpc,
                data=body,
                headers={"Content-Type": "application/json", "User-Agent": "arcpad-pin-gate/1"},
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                code = _json.loads(r.read())["result"].lower().removeprefix("0x")
            if code:
                return code
        except Exception:
            continue
    return None


def check_mainnet_identity() -> bool:
    print("== PoolManager: Arc vs Ethereum mainnet ==")
    arc = get_code(ARC_RPC, ARC_POOL_MANAGER)
    eth = get_code(ETH_RPC, ETH_POOL_MANAGER)

    # Ag hatasi bir BULGU degildir -- ama SESSIZ de gecmez.
    if arc is None or eth is None:
        which = "Arc" if arc is None else "mainnet"
        print(f"  ATLANDI  {which} RPC'lerinin hicbirinden kod alinamadi")
        return True

    lo, hi = IMMUTABLE_SELF_OFFSET * 2, (IMMUTABLE_SELF_OFFSET + 20) * 2
    diffs = [i for i in range(min(len(arc), len(eth))) if arc[i] != eth[i]]
    outside = [i for i in diffs if not (lo <= i < hi)]

    print(f"  arc     {len(arc) // 2} bayt")
    print(f"  mainnet {len(eth) // 2} bayt")
    if len(arc) != len(eth) or outside:
        print(f"  KIRMIZI  immutable adres alani DISINDA {len(outside)} nibble farkli")
        if outside:
            print(f"           ilk fark bayt {outside[0] // 2}")
        return False
    print(f"  ok      yalnizca {IMMUTABLE_SELF_OFFSET}. bayttaki 20 bayt farkli -- her")
    print("          kontratin KENDI adresi. Geri kalan her bayt AYNI.")
    print("          arc     ->", arc[lo:hi])
    print("          mainnet ->", eth[lo:hi])
    return True


def main() -> int:
    have = {path: sha for _, sha, path in submodule_status(recursive=False)}
    bad: list[str] = []

    print("== bagimlilik sabitlemeleri ==")
    for path, (want, tag, why) in PINS.items():
        name = path[len("contracts/lib/") :]
        got = have.get(path)
        if got is None:
            print(f"  EKSIK  {path} -- submodule agacta yok")
            bad.append(path)
            continue
        if got != want:
            print(f"  KAYDI  {path}\n         beklenen {want}\n         bulunan  {got}")
            bad.append(path)
            continue

        if tag is None:
            label = "(etiket yok)"
        else:
            resolved = tag_commit(path, tag)
            if resolved is None:
                label = f"[{tag}?]"  # etiket yerelde yok -- `git fetch --tags`
            elif resolved != want:
                print(f"  ETIKET {path} -- {tag} -> {resolved[:12]}, pin {want[:12]} DEGIL")
                bad.append(path)
                continue
            else:
                label = f"[{tag}]"
        print(f"  ok     {name:24} {want[:12]} {label:12} {why}")

    for path in have:
        if path not in PINS:
            print(f"  YENI   {path} -- sabitlenmemis bir bagimlilik eklendi")
            bad.append(path)

    # Ikinci kontrol: agacin TAMAMI kaydedilenle ayni yerde mi. Ust seviye
    # hash'ler dogru olsa bile ic ice bir kopya kaymis olabilir.
    rows = submodule_status(recursive=True)
    drifted = [(p, path) for p, _, path in rows if p != " "]
    print(f"\n== ic ice agac ({len(rows)} submodule, ozyinelemeli) ==")
    if drifted:
        for prefix, path in drifted:
            reason = {"+": "kaydedilen commit'ten FARKLI", "-": "KURULMAMIS", "U": "birlesme catismasi"}[prefix]
            print(f"  SAPMA  {path} -- {reason}")
            bad.append(path)
    else:
        print("  ok     her submodule ebeveyninin kaydettigi commit'te")

    if "--mainnet" in sys.argv:
        print()
        if not check_mainnet_identity():
            bad.append("PoolManager/mainnet")

    if bad:
        print(
            "\nBAGIMLILIK SABITLEME KAPISI KIRMIZI.\n"
            "Dogru tepki hash'i guncellemek DEGIL: once yeni commit'i incele\n"
            "(uretim kodu ne degisti, kullandigimiz dosyalara dokundu mu),\n"
            "sonra hem hash'i hem gerekceyi bu dosyada guncelle."
        )
        return 1

    print("\nBAGIMLILIK SABITLEME KAPISI YESIL.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
