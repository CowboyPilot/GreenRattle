/*
Web Audio bridge to the WASM Rattlegram modem.

TX: renders the whole message to an int16 buffer via the WASM encoder,
converts to float32 and plays it through an AudioBufferSourceNode.

RX: getUserMedia -> AudioWorklet captures mono float32, converts to int16
in 20 ms chunks (rate / 50 samples, matching the Android app) and feeds
the WASM decoder on the main thread.
*/

export const STATUS = {
	OKAY: 0, FAIL: 1, SYNC: 2, DONE: 3, HEAP: 4, NOPE: 5, PING: 6,
};

const PAYLOAD_SIZE = 170;
const CALL_BUF = 10;

export class Modem {
	constructor(wasm) {
		this.wasm = wasm; // emscripten module instance
		this.ctx = null;
		this.micStream = null;
		this.micSource = null;
		this.worklet = null;
		this.decoderRate = 0;
		this.onStatus = () => {};   // (statusName, detail)
		this.onMessage = () => {};  // ({callSign, payloadBytes, mode, cfo, flips})
		this.onPing = () => {};     // ({callSign, cfo})
		this.onSpectrum = null;     // optional (spectrumImageData, spectrogramImageData)

		// While transmitting (and for a short tail afterwards) captured audio
		// is dropped instead of decoded, so the app never receives its own
		// outgoing message. Simpler and more reliable than stopping/restarting
		// the mic stream.
		this.muted = false;
		this._unmuteTimer = null;
		this.txTailGuardMs = 300;

		// scratch WASM buffers
		this._payloadPtr = wasm._malloc(PAYLOAD_SIZE);
		this._callPtr = wasm._malloc(CALL_BUF);
		this._cfoPtr = wasm._malloc(4);
		this._modePtr = wasm._malloc(4);
		this._feedPtr = 0;
		this._feedCap = 0;
		this._spectrumPtr = 0;
		this._spectrogramPtr = 0;
	}

	async ensureContext() {
		if (!this.ctx) {
			this.ctx = new (window.AudioContext || window.webkitAudioContext)();
			await this.ctx.audioWorklet.addModule("js/capture-worklet.js");
		}
		if (this.ctx.state === "suspended")
			await this.ctx.resume();
		return this.ctx;
	}

	get sampleRate() {
		return this.ctx ? Math.round(this.ctx.sampleRate) : 48000;
	}

	// ---------- transmit ----------

	// payloadBytes: Uint8Array(170), callSign: string (<= 9 ASCII chars)
	// Returns a promise that resolves when playback ends.
	async transmit(payloadBytes, callSign, opts = {}) {
		const ctx = await this.ensureContext();
		const rate = this.sampleRate;
		const wasm = this.wasm;
		if (!wasm._rg_create_encoder(rate))
			throw new Error(`Encoder does not support ${rate} Hz.`);

		const carrier = opts.carrierFrequency ?? 1500;
		const noise = opts.noiseSymbols ?? 6;
		const fancy = opts.fancyHeader ?? false;

		wasm.HEAPU8.set(payloadBytes, this._payloadPtr);
		const cs = new Uint8Array(CALL_BUF);
		const ascii = (callSign || "ANONYMOUS").toUpperCase().slice(0, 9);
		for (let i = 0; i < ascii.length; i++)
			cs[i] = ascii.charCodeAt(i);
		wasm.HEAPU8.set(cs, this._callPtr);
		wasm._rg_configure_encoder(this._payloadPtr, this._callPtr, carrier, noise, fancy ? 1 : 0);

		const extendedLength = Math.floor((1280 * rate) / 8000) * 9 / 8;
		const chunkPtr = wasm._malloc(extendedLength * 2);
		const chunks = [];
		// produce() returns true while more audio remains
		for (let guard = 0; guard < 1000; guard++) {
			const more = wasm._rg_produce_encoder(chunkPtr, 0);
			chunks.push(wasm.HEAP16.slice(chunkPtr / 2, chunkPtr / 2 + extendedLength));
			if (!more)
				break;
		}
		wasm._free(chunkPtr);

		const total = chunks.length * extendedLength;
		const audio = ctx.createBuffer(1, total, rate);
		const ch = audio.getChannelData(0);
		let off = 0;
		for (const c of chunks) {
			for (let i = 0; i < c.length; i++)
				ch[off + i] = c[i] / 32768;
			off += c.length;
		}

		const durationSec = total / rate;

		// Gate the decoder for the whole transmission so we don't decode our
		// own audio through the mic. Cleared a short guard time after playback
		// ends, to also skip the room echo of the tail.
		this.muted = true;
		if (this._unmuteTimer) {
			clearTimeout(this._unmuteTimer);
			this._unmuteTimer = null;
		}

		return new Promise(resolve => {
			const src = ctx.createBufferSource();
			src.buffer = audio;
			src.connect(ctx.destination);
			let done = false;
			const finish = () => {
				if (done)
					return;
				done = true;
				clearTimeout(safety);
				this._unmuteTimer = setTimeout(() => {
					this.muted = false;
					this._unmuteTimer = null;
				}, this.txTailGuardMs);
				resolve(durationSec);
			};
			// onended is normally reliable; the timeout is a safety net so the
			// mic can never get stuck muted if it doesn't fire.
			const safety = setTimeout(finish, durationSec * 1000 + 1500);
			src.onended = finish;
			src.start();
		});
	}

	// ---------- receive ----------

	async startListening() {
		if (this.micStream)
			return;
		const ctx = await this.ensureContext();
		const rate = this.sampleRate;
		if (!this.wasm._rg_create_decoder(rate))
			throw new Error(`Decoder does not support ${rate} Hz.`);
		this.decoderRate = rate;

		this.micStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
		});
		this.micSource = ctx.createMediaStreamSource(this.micStream);
		this.worklet = new AudioWorkletNode(ctx, "capture-worklet", {
			processorOptions: { chunkSize: Math.floor(rate / 50) },
		});
		this.worklet.port.onmessage = (e) => this._onChunk(e.data);
		this.micSource.connect(this.worklet);
		// keep node alive without echoing the mic
		const sink = ctx.createGain();
		sink.gain.value = 0;
		this.worklet.connect(sink).connect(ctx.destination);
	}

	stopListening() {
		if (this.worklet) {
			this.worklet.port.onmessage = null;
			this.worklet.disconnect();
			this.worklet = null;
		}
		if (this.micSource) {
			this.micSource.disconnect();
			this.micSource = null;
		}
		if (this.micStream) {
			this.micStream.getTracks().forEach(t => t.stop());
			this.micStream = null;
		}
	}

	get listening() {
		return !!this.micStream;
	}

	_onChunk(int16Chunk) {
		if (this.muted)
			return; // drop our own transmission instead of decoding it
		const wasm = this.wasm;
		const bytes = int16Chunk.length * 2;
		if (this._feedCap < bytes) {
			if (this._feedPtr)
				wasm._free(this._feedPtr);
			this._feedPtr = wasm._malloc(bytes);
			this._feedCap = bytes;
		}
		wasm.HEAP16.set(int16Chunk, this._feedPtr / 2);
		if (!wasm._rg_feed_decoder(this._feedPtr, int16Chunk.length, 0))
			return;
		const status = wasm._rg_process_decoder();
		if (this.onSpectrum)
			this._emitSpectrum();
		switch (status) {
			case STATUS.OKAY:
				break;
			case STATUS.FAIL:
				this.onStatus("fail");
				break;
			case STATUS.NOPE: {
				const st = this._staged();
				this.onStatus("nope", st);
				break;
			}
			case STATUS.PING: {
				const st = this._staged();
				this.onPing(st);
				break;
			}
			case STATUS.HEAP:
				this.onStatus("heap");
				this.stopListening();
				break;
			case STATUS.SYNC: {
				const st = this._staged();
				this.onStatus("sync", st);
				this._lastStaged = st;
				break;
			}
			case STATUS.DONE: {
				const flips = wasm._rg_fetch_decoder(this._payloadPtr);
				const st = this._lastStaged || this._staged();
				if (flips < 0) {
					this.onStatus("decode-failed", st);
				} else {
					const payload = new Uint8Array(
						wasm.HEAPU8.buffer, this._payloadPtr, PAYLOAD_SIZE).slice();
					this.onMessage({
						callSign: st.callSign, payloadBytes: payload,
						mode: st.mode, cfo: st.cfo, flips,
					});
				}
				break;
			}
		}
	}

	_staged() {
		const wasm = this.wasm;
		wasm._rg_staged_decoder(this._cfoPtr, this._modePtr, this._callPtr);
		const cfo = wasm.HEAPF32[this._cfoPtr / 4];
		const mode = wasm.HEAP32[this._modePtr / 4];
		const callBytes = wasm.HEAPU8.subarray(this._callPtr, this._callPtr + CALL_BUF);
		let callSign = "";
		for (const b of callBytes) {
			if (b === 0)
				break;
			callSign += String.fromCharCode(b);
		}
		return { cfo, mode, callSign: callSign.trim() };
	}

	_emitSpectrum() {
		const wasm = this.wasm;
		const W = 360, H = 128, N = W * H * 4;
		if (!this._spectrumPtr) {
			this._spectrumPtr = wasm._malloc(N);
			this._spectrogramPtr = wasm._malloc(N);
		}
		wasm._rg_spectrum_decoder(this._spectrumPtr, this._spectrogramPtr, 0xFF00FF00);
		const spec = new Uint8ClampedArray(wasm.HEAPU8.buffer, this._spectrumPtr, N).slice();
		const gram = new Uint8ClampedArray(wasm.HEAPU8.buffer, this._spectrogramPtr, N).slice();
		// Android ARGB int (little endian = BGRA bytes) -> RGBA
		argbToRgba(spec);
		argbToRgba(gram);
		this.onSpectrum(new ImageData(spec, W, H), new ImageData(gram, W, H));
	}
}

function argbToRgba(bytes) {
	for (let i = 0; i < bytes.length; i += 4) {
		const b = bytes[i], r = bytes[i + 2];
		bytes[i] = r;
		bytes[i + 2] = b;
		bytes[i + 3] = 255;
	}
}
