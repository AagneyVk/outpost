#!/usr/bin/env bash
# Run inside a throwaway container with /lab mounted read-only and no network.
set -euo pipefail
python3 /lab/patch-gecko-fixture.py
cd /build/gecko.js
cp build-lib.sh build-fixture.sh
# Faster compression and no wasm optimizer: this build is only a functional test.
sed -i 's/zstd -q -f --ultra -22/zstd -q -f -3/' build-fixture.sh
source /build/emsdk/emsdk_env.sh >/dev/null 2>&1
export PATH="/root/.cargo/bin:$PATH"
export GECKO_RELEASE=1 NO_WASM_OPT=1 GECKO_DATA_ZSTD_LEVEL=3
bash build-fixture.sh
