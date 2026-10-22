import { describe, expect, it } from "vitest";
import { gain, pitch, readWav16, sineTake, spectrum, writeWav16 } from "./fx.js";

describe("fx dsp", () => {
  it("wav roundtrips 16-bit mono", () => {
    const buf = sineTake(22050, 1, 440);
    const pcm = readWav16(buf);
    expect(pcm.sr).toBe(22050);
    expect(pcm.data.length).toBe(22050);
    expect(writeWav16(pcm.sr, pcm.data).length).toBe(buf.length);
  });

  it("rejects non-wav bytes", () => {
    expect(() => readWav16(Buffer.from("hello"))).toThrow(/RIFF/);
  });

  it("spectrum finds 440Hz peak", () => {
    const pcm = readWav16(sineTake(22050, 2, 440));
    const spec = spectrum(pcm);
    expect(spec.peaks.length).toBeGreaterThan(0);
    expect(Math.abs(spec.peaks[0].hz - 440)).toBeLessThan(12);
  });

  it("tuner reads A4", () => {
    const p = pitch(readWav16(sineTake(22050, 2, 440)));
    expect(p.note).toBe("A4");
    expect(Math.abs(p.cents)).toBeLessThan(8);
    expect(Math.abs(p.hz - 440)).toBeLessThan(3);
  });

  it("gain +6dB doubles peak, normalize caps at 0.99", () => {
    const pcm = readWav16(sineTake(22050, 1, 220));
    const peak = (d: Float32Array) => Math.max(...Array.from(d, (v) => Math.abs(v)));
    const g = gain(pcm, { db: 6 });
    expect(peak(g.data) / peak(pcm.data)).toBeCloseTo(2, 1);
    const n = gain(pcm, { db: 30, normalize: true });
    expect(peak(n.data)).toBeLessThanOrEqual(0.991);
  });
});
