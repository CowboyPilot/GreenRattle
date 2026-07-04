#!/bin/sh
# Build the Rattlegram DSP core to WebAssembly.
# Requires emscripten (brew install emscripten).
set -e
cd "$(dirname "$0")"

CPP_DIR="../rattlegram-src/app/src/main/cpp"
OUT_DIR="../pwa/wasm"
mkdir -p "$OUT_DIR"

emcc wasm_bindings.cpp \
	-I "$CPP_DIR" \
	-std=c++17 -O2 \
	-s MODULARIZE=1 \
	-s EXPORT_NAME=createRattlegram \
	-s ENVIRONMENT=web \
	-s SINGLE_FILE=1 \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["HEAP8","HEAPU8","HEAP16","HEAP32","HEAPU32","HEAPF32"]' \
	-o "$OUT_DIR/rattlegram.js"

echo "Built $OUT_DIR/rattlegram.js"
