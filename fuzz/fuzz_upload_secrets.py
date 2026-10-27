"""Fuzzer Atheris de la cible upload_secrets (fuzz/targets.py), lancé par ClusterFuzzLite (atheris n'existe que dans son image)."""

import sys

import atheris

with atheris.instrument_imports():
    import targets


def main() -> None:
    atheris.Setup(sys.argv, targets.upload_secrets)
    atheris.Fuzz()


if __name__ == "__main__":
    main()
