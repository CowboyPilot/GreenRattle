/*
WebAssembly interface to the Rattlegram C++ encoder and decoder.

Mirrors app/src/main/cpp/native-lib.cpp from the Android app, with plain
extern "C" exports instead of JNI.

DSP code Copyright 2022 Ahmet Inan <inan@aicodix.de>
*/

#include <emscripten/emscripten.h>
#include <cstdint>
#define assert(expr) do {} while (0)
#include "encoder.hh"
#include "decoder.hh"

static EncoderInterface *encoder;
static DecoderInterface *decoder;

extern "C" {

EMSCRIPTEN_KEEPALIVE
int rg_create_encoder(int sampleRate) {
	if (encoder && encoder->rate() == sampleRate)
		return 1;
	delete encoder;
	switch (sampleRate) {
		case 8000:
			encoder = new(std::nothrow) Encoder<8000>();
			break;
		case 16000:
			encoder = new(std::nothrow) Encoder<16000>();
			break;
		case 32000:
			encoder = new(std::nothrow) Encoder<32000>();
			break;
		case 44100:
			encoder = new(std::nothrow) Encoder<44100>();
			break;
		case 48000:
			encoder = new(std::nothrow) Encoder<48000>();
			break;
		default:
			encoder = nullptr;
	}
	return encoder != nullptr;
}

EMSCRIPTEN_KEEPALIVE
void rg_destroy_encoder() {
	delete encoder;
	encoder = nullptr;
}

// payload: 170 bytes, callSign: NUL terminated ASCII (max 9 chars + NUL)
EMSCRIPTEN_KEEPALIVE
void rg_configure_encoder(const uint8_t *payload, const int8_t *callSign,
		int carrierFrequency, int noiseSymbols, int fancyHeader) {
	if (!encoder)
		return;
	encoder->configure(payload, callSign, carrierFrequency, noiseSymbols, fancyHeader != 0);
}

// audioBuffer must hold extended_length * (channelSelect ? 2 : 1) int16 samples
// extended_length = ((1280 * rate) / 8000) * 9 / 8
EMSCRIPTEN_KEEPALIVE
int rg_produce_encoder(int16_t *audioBuffer, int channelSelect) {
	if (!encoder)
		return 0;
	return encoder->produce(audioBuffer, channelSelect);
}

EMSCRIPTEN_KEEPALIVE
int rg_create_decoder(int sampleRate) {
	if (decoder && decoder->rate() == sampleRate)
		return 1;
	delete decoder;
	switch (sampleRate) {
		case 8000:
			decoder = new(std::nothrow) Decoder<8000>();
			break;
		case 16000:
			decoder = new(std::nothrow) Decoder<16000>();
			break;
		case 32000:
			decoder = new(std::nothrow) Decoder<32000>();
			break;
		case 44100:
			decoder = new(std::nothrow) Decoder<44100>();
			break;
		case 48000:
			decoder = new(std::nothrow) Decoder<48000>();
			break;
		default:
			decoder = nullptr;
	}
	return decoder != nullptr;
}

EMSCRIPTEN_KEEPALIVE
void rg_destroy_decoder() {
	delete decoder;
	decoder = nullptr;
}

EMSCRIPTEN_KEEPALIVE
int rg_feed_decoder(const int16_t *audioBuffer, int sampleCount, int channelSelect) {
	if (!decoder)
		return 0;
	return decoder->feed(audioBuffer, sampleCount, channelSelect);
}

// returns STATUS_* (0 OKAY, 1 FAIL, 2 SYNC, 3 DONE, 4 HEAP, 5 NOPE, 6 PING)
EMSCRIPTEN_KEEPALIVE
int rg_process_decoder() {
	if (!decoder)
		return 4; // STATUS_HEAP
	return decoder->process();
}

// carrierFrequencyOffset: 1 float, operationMode: 1 int32, callSign: 10 bytes
EMSCRIPTEN_KEEPALIVE
void rg_staged_decoder(float *carrierFrequencyOffset, int32_t *operationMode, uint8_t *callSign) {
	if (!decoder)
		return;
	decoder->staged(carrierFrequencyOffset, operationMode, callSign);
}

// payload: 170 bytes; returns bit flips corrected (>= 0) or < 0 on failure
EMSCRIPTEN_KEEPALIVE
int rg_fetch_decoder(uint8_t *payload) {
	if (!decoder)
		return -1;
	return decoder->fetch(payload);
}

// spectrum/spectrogram: 360x128 uint32 pixels each
EMSCRIPTEN_KEEPALIVE
void rg_spectrum_decoder(uint32_t *spectrumPixels, uint32_t *spectrogramPixels, int spectrumTint) {
	if (!decoder)
		return;
	decoder->spectrum(spectrumPixels, spectrogramPixels, spectrumTint);
}

} // extern "C"
