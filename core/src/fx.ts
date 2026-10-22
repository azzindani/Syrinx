// Pure-TS DSP for CPU-native fx tools. No deps, no GPU.
// WAV scope: RIFF, PCM16 or IEEE-float32, mono or stereo (mixed to mono).

export interface Pcm {
  sr: number;
  data: Float32Array;
}

export function readWav16(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a RIFF wav");
  }
  let pos = 12;
  let fmt: { audio: number; ch: number; sr: number; bits: number } | null = null;
  let start = -1;
  let len = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        audio: buf.readUInt16LE(pos + 8),
        ch: buf.readUInt16LE(pos + 10),
        sr: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      start = pos + 8;
      len = size;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || start < 0) throw new Error("wav missing fmt/data");
  if (fmt.audio !== 1 && fmt.audio !== 3) throw new Error(`wav encoding ${fmt.audio} unsupported (need PCM16/float32)`);
  if (fmt.bits !== 16 && !(fmt.audio === 3 && fmt.bits === 32)) {
    throw new Error(`wav ${fmt.bits}-bit unsupported (need 16-bit PCM or 32-bit float)`);
  }
  const bytes = fmt.bits / 8;
  const frames = Math.floor(len / bytes / fmt.ch);
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const off = start + (i * fmt.ch + c) * bytes;
      s += fmt.audio === 3 ? buf.readFloatLE(off) : buf.readInt16LE(off) / 32768;
    }
    data[i] = s / fmt.ch;
  }
  return { sr: fmt.sr, data };
}

export function writeWav16(sr: number, data: Float32Array): Buffer {
  const head = Buffer.alloc(44);
  const n = data.length;
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + n * 2, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(n * 2, 40);
  const body = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    body.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return Buffer.concat([head, body]);
}

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export interface Peak {
  hz: number;
  mag: number;
}

// Magnitude spectrum of a 4096-sample Hann window at file middle.
export function spectrum(pcm: Pcm, size = 4096): { sr: number; peaks: Peak[] } {
  const n = Math.min(size, pcm.data.length);
  const off = Math.max(0, Math.floor((pcm.data.length - n) / 2));
  const w = hann(n);
  const mags: number[] = [];
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n;
      const v = pcm.data[off + i] * w[i];
      re += v * Math.cos(a);
      im -= v * Math.sin(a);
    }
    mags.push(Math.hypot(re, im) / n);
  }
  const hzPerBin = pcm.sr / n;
  const peaks: Peak[] = [];
  for (let k = 2; k < mags.length - 1; k++) {
    if (mags[k] > mags[k - 1] && mags[k] >= mags[k + 1] && mags[k] > 1e-4) {
      peaks.push({ hz: k * hzPerBin, mag: mags[k] });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);
  const top: Peak[] = [];
  for (const p of peaks) {
    if (top.length >= 5) break;
    if (top.every((t) => Math.abs(t.hz - p.hz) > hzPerBin * 2)) top.push(p);
  }
  return { sr: pcm.sr, peaks: top };
}

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export interface Pitch {
  hz: number;
  note: string;
  cents: number;
  confidence: number;
}

// Autocorrelation pitch on a mid-file window. Range 50–2000 Hz.
export function pitch(pcm: Pcm): Pitch {
  const sr = pcm.sr;
  const n = Math.min(sr * 2, pcm.data.length);
  const off = Math.max(0, Math.floor((pcm.data.length - n) / 2));
  const minLag = Math.floor(sr / 2000);
  const maxLag = Math.min(Math.ceil(sr / 50), n - 1);
  let best = -1;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 2) s += pcm.data[off + i] * pcm.data[off + i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  const hz = sr / bestLag;
  const midi = 69 + 12 * Math.log2(hz / 440);
  const round = Math.round(midi);
  const cents = Math.round((midi - round) * 100);
  const note = `${NOTES[((round % 12) + 12) % 12]}${Math.floor(round / 12) - 1}`;
  let energy = 0;
  for (let i = 0; i < n; i += 4) energy += pcm.data[off + i] ** 2;
  return { hz: Math.round(hz * 10) / 10, note, cents, confidence: Math.min(1, best / Math.max(1e-9, energy)) };
}

export interface GainOpts {
  db: number;
  normalize?: boolean;
  fadeInSec?: number;
  fadeOutSec?: number;
}

export function gain(pcm: Pcm, opts: GainOpts): Pcm {
  const out = new Float32Array(pcm.data);
  const k = 10 ** (opts.db / 20);
  for (let i = 0; i < out.length; i++) out[i] *= k;
  if (opts.normalize) {
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 1e-9) {
      const g = 0.99 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= g;
    }
  }
  const fade = (sec: number | undefined, start: boolean) => {
    if (!sec || sec <= 0) return;
    const m = Math.min(out.length, Math.floor(sec * pcm.sr));
    for (let i = 0; i < m; i++) {
      const t = start ? i / m : (m - i) / m;
      const idx = start ? i : out.length - m + i;
      out[idx] *= t;
    }
  };
  fade(opts.fadeInSec, true);
  fade(opts.fadeOutSec, false);
  return { sr: pcm.sr, data: out };
}

// Test helper: render a sine take in the stub 16-bit mono format.
export function sineTake(sr: number, seconds: number, freq: number): Buffer {
  const n = Math.floor(sr * seconds);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sr);
  return writeWav16(sr, data);
}
