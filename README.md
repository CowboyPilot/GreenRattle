# GreenRattle — offline PWA with AES-256 encryption

A Progressive Web App port of [Rattlegram](https://github.com/CowboyPilot/rattlegram)
(text over audio, up to 170 bytes per transmission) with optional AES-256-GCM
message encryption and QR/file key exchange. Runs fully offline once installed.

## Layout

- `pwa/` — the app. Static files, no build step. Serve this directory.
- `wasm-src/` — C++ WebAssembly bindings (`wasm_bindings.cpp`) and `build.sh`,
  which compiles the original Rattlegram DSP headers to `pwa/wasm/rattlegram.js`.
- `rattlegram-src/` — the DSP core (`app/src/main/cpp/*.hh`/`.cpp`) vendored
  unmodified from the upstream Android app, plus its original `LICENSE`. The
  rest of the Android project (Gradle, fastlane, Java UI) isn't needed here
  and was left out.

## Building the WASM module

Only needed after changing `wasm_bindings.cpp` or the DSP headers
(a prebuilt `pwa/wasm/rattlegram.js` is checked in):

```sh
brew install emscripten
./wasm-src/build.sh
```

## Running / deploying

Any static file server works:

```sh
python3 -m http.server 8321 --directory pwa
```

For installation as a PWA and microphone/camera access, the app must be served
over **HTTPS** (or `localhost`). The service worker (`pwa/sw.js`) precaches
everything; after the first visit the app works with no network at all. Bump
`VERSION` in `sw.js` when deploying updates.

## Encryption design

- **Keys**: AES-256, up to 10 in the store (localStorage), each identified by a
  two-character uppercase hex ID (`01`–`FF`, `00` reserved for "unencrypted").
- **Key exchange**: each key can be shown as a QR code or saved as a JSON file;
  both contain `{app, type: "aes256-key", id, key(base64), created}` and can be
  imported by camera scan or file upload. Importing an existing ID replaces
  that key.
- **Wire format** (inside the fixed 170-byte Rattlegram payload):
  - bytes 0–1: ASCII key ID. `00` = unencrypted.
  - unencrypted: bytes 2+ are UTF-8 text (max 168 bytes).
  - encrypted: byte 2 = ciphertext length, bytes 3–14 = random 96-bit IV,
    then AES-256-GCM ciphertext + 16-byte tag (max 139 bytes of plaintext).
    The key ID is bound as GCM additional authenticated data, so tampering
    with the header or ciphertext is detected instead of showing garbage.
- **Interop**: payloads whose first two bytes are not valid uppercase hex are
  treated as legacy messages from stock Rattlegram clients and shown as-is.
  (A stock message that happens to start with two hex digits will be
  misidentified — unavoidable with an in-band header.)

## Verified

- Encoder → decoder loopback at 48 kHz in-browser: 0 bit flips, call sign and
  encrypted text recovered via the wire-format key ID.
- Unknown key ID, tampered ciphertext, and legacy plaintext all handled.
- QR generate → jsQR read round-trip.
- Service worker caches all 13 assets; app loads offline.
