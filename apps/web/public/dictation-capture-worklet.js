// Audio worklet for dictation: mixes the microphone down to mono, resamples it to 16 kHz and
// posts it to the main thread in 100 ms blocks. Served as a file because the desktop CSP
// does not allow worklets from blob: URLs.
const TARGET_RATE = 16000;
const BLOCK = TARGET_RATE / 10;

class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.position = 0;
    this.previous = 0;
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let frame = 0; frame < frames; frame++) {
      let sample = 0;
      for (const channel of channels) sample += channel[frame];
      sample /= channels.length;
      // Linear interpolation between the previous and this input frame.
      while (this.position <= 1) {
        this.block[this.filled++] = this.previous + (sample - this.previous) * this.position;
        if (this.filled === BLOCK) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(BLOCK);
          this.filled = 0;
        }
        this.position += this.step;
      }
      this.position -= 1;
      this.previous = sample;
    }
    return true;
  }
}

registerProcessor("dictation-capture", DictationCaptureProcessor);
