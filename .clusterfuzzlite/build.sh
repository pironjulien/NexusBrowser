#!/bin/bash -eu
# Un fuzzer par fichier fuzz/fuzz_*.py ; modules du dépôt embarqués, avec les fichiers qu'ils lisent à l'import à côté
# d'eux (racine du paquet PyInstaller) : politique des garde-fous et scripts de lecture de la page.
for fuzzer in "$SRC"/nexusbrowser/fuzz/fuzz_*.py; do
  compile_python_fuzzer "$fuzzer" \
    --paths="$SRC/nexusbrowser/fuzz" --paths="$SRC/nexusbrowser/client" --paths="$SRC/nexusbrowser/native-host" \
    --add-data="$SRC/nexusbrowser/client/garde-fous.json:." \
    --add-data="$SRC/nexusbrowser/client/trigger_probe.js:." \
    --add-data="$SRC/nexusbrowser/client/webmcp_probe.js:."
done
# Graines de fuzz/targets.py (formes réelles) en corpus de départ.
python3 -c "import sys; sys.path.insert(0, '$SRC/nexusbrowser/fuzz'); import targets; targets.write_seed_corpus('$OUT')"
