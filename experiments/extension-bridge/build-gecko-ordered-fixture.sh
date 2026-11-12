#!/usr/bin/env bash
# Test only. The container has no network and the fixture mount is read-only.
set -euo pipefail
source /build/emsdk/emsdk_env.sh >/dev/null 2>&1
export PATH="/root/.cargo/bin:$PATH"
export GECKO_RELEASE=1 NO_WASM_OPT=1 GECKO_DATA_ZSTD_LEVEL=3
export EM_CONFIG=/build/em_config OUTPOST_ORDERED_FIXTURE=1
python3 /lab/patch-necko-fixture.py
python3 /lab/patch-necko-order-fixture.py
python3 /lab/patch-gecko-fixture.py
make -C /build/obj-full-emscripten-release/netwerk/protocol/http -B -j2 Unified_cpp_protocol_http5.o
bash /build/gecko.js/relink-engine-r.sh
cd /build/gecko.js
cp build-lib.sh build-fixture.sh
sed -i 's/zstd -q -f --ultra -22/zstd -q -f -3/' build-fixture.sh
bash build-fixture.sh
