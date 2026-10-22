import { describe, expect, it } from "vitest";
import { parsePromptTags } from "./tags.js";

describe("prompt tags", () => {
  it("extracts known fish markers, flags unknown ones", () => {
    const r = parsePromptTags("hello (whispering) world (saxophone)", "tts-fish-s1mini");
    expect(r.tags).toEqual(["whispering"]);
    expect(r.unknown).toEqual(["saxophone"]);
  });

  it("dedupes repeat markers and ignores empty parens", () => {
    const r = parsePromptTags("(laughing) ha (laughing) ()", "tts-fish-s1mini");
    expect(r.tags).toEqual(["laughing"]);
    expect(r.unknown).toEqual([]);
  });

  it("treats other tts lanes as free-form style hints", () => {
    const r = parsePromptTags("(slightly faster, cheerful tone) hi", "tts-cpm2");
    expect(r.tags).toEqual(["slightly faster, cheerful tone"]);
  });

  it("ignores non-tts tools", () => {
    expect(parsePromptTags("(epic) loop", "music-musicgen-small")).toEqual({ tags: [], unknown: [] });
  });
});
