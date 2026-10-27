# ClusterFuzzLite (https://google.github.io/clusterfuzzlite/): image de construction des fuzzers Atheris de fuzz/.
FROM gcr.io/oss-fuzz-base/base-builder-python@sha256:21f6fab17ace4dc76e1c56de91ee95d3d03da021df94b41056ba036f6c6f55e9
COPY . $SRC/nexusbrowser
WORKDIR $SRC/nexusbrowser
COPY .clusterfuzzlite/build.sh $SRC/
