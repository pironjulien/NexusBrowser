"""Fuzzer Atheris de la cible journal_privacy (fuzz/targets.py), lancé par ClusterFuzzLite (atheris n'existe que dans son image)."""

import sys

import atheris

with atheris.instrument_imports():
    import targets


def main() -> None:
    atheris.Setup(sys.argv, targets.journal_privacy)
    atheris.Fuzz()


if __name__ == "__main__":
    main()
