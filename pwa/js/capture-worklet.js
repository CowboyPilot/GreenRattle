// AudioWorklet processor: batches mono input into fixed int16 chunks
// (rate / 50 samples = 20 ms) and posts them to the main thread.
class CaptureWorklet extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.chunkSize = options.processorOptions.chunkSize;
		this.buffer = new Int16Array(this.chunkSize);
		this.fill = 0;
	}

	process(inputs) {
		const input = inputs[0];
		if (!input || !input[0])
			return true;
		const samples = input[0];
		for (let i = 0; i < samples.length; i++) {
			let s = samples[i] * 32768;
			if (s > 32767) s = 32767;
			else if (s < -32768) s = -32768;
			this.buffer[this.fill++] = s;
			if (this.fill === this.chunkSize) {
				this.port.postMessage(this.buffer);
				this.buffer = new Int16Array(this.chunkSize);
				this.fill = 0;
			}
		}
		return true;
	}
}

registerProcessor("capture-worklet", CaptureWorklet);
