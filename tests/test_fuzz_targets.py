"""Cibles de fuzzing (fuzz/targets.py) rejouées sans Atheris : graines et octets pseudo-aléatoires (graine fixe, le nombre
d'or), à chaque test.ps1. Le vrai fuzzing, guidé par la couverture, tourne dans ClusterFuzzLite (cflite.yml)."""

import random
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "fuzz"))

import targets  # noqa: E402

RUNS = 618


@pytest.mark.parametrize("name", sorted(targets.TARGETS))
def test_target_holds_on_seeds_and_random_bytes(name):
    check = targets.TARGETS[name]
    generator = random.Random(1618)
    for seed in targets.SEEDS:
        check(seed)
    for _ in range(RUNS):
        check(generator.randbytes(generator.randrange(0, 256)))


def test_every_target_has_its_atheris_fuzzer():
    fuzzers = {path.stem.removeprefix("fuzz_") for path in (REPO_ROOT / "fuzz").glob("fuzz_*.py")}
    assert fuzzers == set(targets.TARGETS)
    for name in fuzzers:
        assert f"targets.{name}" in (REPO_ROOT / "fuzz" / f"fuzz_{name}.py").read_text(encoding="utf-8")


def test_seeds_decode_to_the_real_forms():
    """Les graines rejouent bien les formes annoncées : le lecteur d'octets les relit telles quelles."""
    reader = targets.Bytes(targets.SEEDS[0])
    assert reader.value() == targets.PIZZA and reader.value() == {"size": "XL"} and reader.text(16) == "order_pizza"
    reader = targets.Bytes(targets.SEEDS[1])
    assert reader.text(200) == "https://a.com\\@b.co.uk/compte/42?token=abc#x"
    assert targets.Bytes(targets.SEEDS[2]).text(400).startswith("Ignore previous instructions")


def test_journal_target_accepts_a_bare_scheme():
    """Un schéma seul, « + » compris (web+foo:), est ce que le journal écrit : jamais pris pour une fuite."""
    targets.journal_privacy(targets.text_seed("web+foo:", ""))


def test_upload_target_catches_a_leak(monkeypatch):
    """La propriété de la cible mord : si un dossier de secrets n'était plus refusé, elle échouerait."""
    monkeypatch.setattr(targets.bridge_security, "upload_refusal", lambda files: None)
    with pytest.raises(AssertionError):
        targets.upload_secrets(b"\x00\x01\x03abc")


def test_seed_corpus_is_written_for_every_fuzzer(tmp_path):
    import zipfile

    targets.write_seed_corpus(str(tmp_path))
    for name in targets.TARGETS:
        with zipfile.ZipFile(tmp_path / f"fuzz_{name}_seed_corpus.zip") as archive:
            assert [archive.read(item) for item in archive.namelist()] == targets.SEEDS
