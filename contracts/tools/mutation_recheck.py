#!/usr/bin/env python3
"""
MUTANTI HANGI TEST OLDURDU.

Ilk kosuda bes mutant "derleme hatasi" diye siniflandirildi ve o siniflandirma
YANLISTI -- kod pekala derleniyor. Yanlis siniflandirmanin gizledigi soru sudur
ve tek onemli olan odur:

    Mutanti bir DAVRANIS testi mi oldurdu, yoksa yalnizca bir BYTECODE PINI mi?

Ikisi ayni sey degildir. `frozen_bytecode_gate` ya da `Surface`in ABI sayimi,
kaynak degistigi icin duser -- davranisi HIC calistirmadan. Yalnizca onlarin
dustugu bir mutant, o davranisin TESTSIZ oldugu anlamina gelir; kapi yalnizca
"birisi bu dosyaya dokundu" diyor, "bu koruma calisiyor" demiyor.

Bu betik her mutant icin DUSEN TEST ADLARINI yazar ve pin testlerini ayirir.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mutation_campaign import MUTANTS, CONTRACTS, ROOT  # noqa: E402

# Kaynak degistigi icin duserler; davranisi olcmezler.
PIN_MARKERS = ("frozen", "Frozen", "bytecode", "Bytecode", "Surface", "Census", "census",
               "CreationCode", "creationCode", "initcode", "Initcode")


def is_pin(test_name: str) -> bool:
    return any(m in test_name for m in PIN_MARKERS)


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    selected = [m for m in MUTANTS if only is None or only.lower() in m.name.lower()]
    print(f"{len(selected)} mutant yeniden inceleniyor\n")
    bad: list[str] = []

    for i, m in enumerate(selected, 1):
        src = CONTRACTS / m.path
        original = src.read_text(encoding="utf-8")
        needle = m.find.strip()
        if needle not in original:
            print(f"[{i}] {m.name}: DESEN YOK")
            continue
        src.write_text(original.replace(needle, m.replace.strip()), encoding="utf-8")
        try:
            p = subprocess.run(
                ["forge", "test", "--match-contract", m.tests, "--no-match-path", "test/fork/*"],
                cwd=CONTRACTS, capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            out = (p.stdout or "") + (p.stderr or "")
        finally:
            src.write_text(original, encoding="utf-8")
            subprocess.run(["git", "checkout", "--", f"contracts/{m.path}"], cwd=ROOT,
                           capture_output=True)

        failing = re.findall(r"\[FAIL[^\]]*\]\s+(\w+)", out)
        behaviour = [t for t in failing if not is_pin(t)]
        pins = [t for t in failing if is_pin(t)]

        if p.returncode == 0:
            verdict = "HAYATTA -- hicbir test olmedi"
            bad.append(m.name)
        elif behaviour:
            verdict = f"DAVRANIS testi oldurdu ({len(behaviour)})"
        elif pins:
            verdict = "YALNIZCA PIN dustu -- DAVRANIS TESTSIZ"
            bad.append(m.name)
        elif "Compiler run failed" in out:
            verdict = "DERLENMEDI -- mutant gecersiz"
            bad.append(m.name)
        else:
            verdict = "dustu ama sebep okunamadi"
            bad.append(m.name)

        print(f"[{i}] {m.name}\n     {verdict}")
        for t in behaviour[:4]:
            print(f"       davranis: {t}")
        for t in pins[:2]:
            print(f"       pin:      {t}")

    print("\n" + "=" * 70)
    if bad:
        print("INCELENMESI GEREKEN:")
        for n in bad:
            print("  -", n)
    else:
        print("hepsini bir DAVRANIS testi oldurdu")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
