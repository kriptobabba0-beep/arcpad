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

============ INCELEMENIN SONUCU, VE NICIN BU COMMIT'LER ============

Hicbiri temiz bir surum etiketinde DEGIL, ve bu incelendi:

  v4-core        v4.0.0 + 21 commit. Uretim farki YALNIZCA bir yeniden
                 duzenleme: `ModifyLiquidityParams`/`SwapParams`
                 `IPoolManager`dan `types/PoolOperation.sol`a tasindi ve
                 cagri yerleri guncellendi. Aritmetik, mantik ve kontrol
                 akisi DEGISMEDI -- yani davranissal olarak denetlenmis
                 v4.0.0. Kalan 20 commit CI/npm/paketleme.

  openzeppelin   v5.0.0 + 12 commit. `contracts/token/` altinda tek fark
                 `ERC1155/IERC1155.sol` ve onu KULLANMIYORUZ. `ERC20`
                 -- `LaunchToken`in tabani -- HIC DEGISMEDI.

  uniswap-hooks  v1.2.0-rc.0 + 21 commit. `BaseHook` degisti ve degisiklik
                 GUCLENDIRMEDIR: `poolManager` sanal bir fonksiyondan
                 constructor'da yazilan bir `immutable`a dondu, yani bir alt
                 sinif onu artik EZEMEZ. `onlyPoolManager`in semantigi ayni.
                 Geri kalan degisiklikler `oracles/panoptic/*` altinda ve o
                 modulu kullanmiyoruz.

  v4-periphery   ETIKET YOK -- main dalinin bir commit'i. Uretimde ondan
                 alinan TEK sey `LiquidityAmounts` (77 satir, son anlamli
                 degisiklik 2024-11). Ustelik `ArcpadLocker` onun sonucuna
                 GUVENMEZ: `SeedShortfall` miktarlari, `PositionNotSeeded`
                 ise `PoolManager`in KENDI durumundan geri okunan likiditeyi
                 dogrular. Kutuphane yanilsa yakalanir.

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

# path -> (beklenen commit, kisa gerekce)
PINS: dict[str, tuple[str, str]] = {
    "contracts/lib/v4-core": (
        "46c6834698c48bc4a463a86d8420f4eb1d7f3b75",
        "v4.0.0 + yalnizca struct tasima refactor'u",
    ),
    "contracts/lib/openzeppelin-contracts": (
        "dbb6104ce834628e473d2173bbc9d47f81a9eec3",
        "v5.0.0; ERC20 hic degismedi",
    ),
    "contracts/lib/uniswap-hooks": (
        "acbd604c409a827f7f98c9517236da860c4fca1a",
        "v1.2.0-rc.0; BaseHook'ta poolManager immutable'a cevrildi (guclendirme)",
    ),
    "contracts/lib/v4-periphery": (
        "3245c3cb99c48fa1dc2459c3b60abc37d4294aba",
        "etiketsiz main; uretimde yalnizca LiquidityAmounts, sonucu locker'da dogrulanir",
    ),
    "contracts/lib/forge-std": (
        "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b",
        "v1.16.2; yalnizca test",
    ),
}


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


def main() -> int:
    have = {path: sha for _, sha, path in submodule_status(recursive=False)}
    bad: list[str] = []

    print("== bagimlilik sabitlemeleri ==")
    for path, (want, why) in PINS.items():
        got = have.get(path)
        if got is None:
            print(f"  EKSIK  {path} -- submodule agacta yok")
            bad.append(path)
            continue
        if got != want:
            print(f"  KAYDI  {path}\n         beklenen {want}\n         bulunan  {got}")
            bad.append(path)
            continue
        print(f"  ok     {path[len('contracts/lib/'):]:24} {want[:12]}  {why}")

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
