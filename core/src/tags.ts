// Prompt marker parsing for TTS lanes (Optic entities.ts pattern idea,
// audio-shaped). Fish S1-mini supports inline emotion/tone/special tags
// like (whispering) or (laughing); unknown markers are reported so the
// caller can fix the prompt instead of silently losing direction.

const FISH_MARKERS = new Set([
  // Emotion
  "angry", "sad", "disdainful", "excited", "surprised", "satisfied",
  "unhappy", "anxious", "hysterical", "delighted", "scared", "worried",
  "indifferent", "upset", "impatient", "nervous", "guilty", "scornful",
  "frustrated", "depressed", "panicked", "furious", "empathetic",
  "embarrassed", "reluctant", "disgusted", "keen", "moved", "proud",
  "relaxed", "grateful", "confident", "interested", "curious", "confused",
  "joyful", "disapproving", "negative", "denying", "astonished", "serious",
  "sarcastic", "conciliative", "comforting", "sincere", "sneering",
  "hesitating", "yielding", "painful", "awkward", "amused",
  // Tone
  "in a hurry tone", "shouting", "screaming", "whispering", "soft tone",
  // Special
  "laughing", "chuckling", "sobbing", "crying loudly", "sighing",
  "panting", "groaning", "crowd laughing", "background laughter",
  "audience laughing",
]);

export interface PromptTags {
  tags: string[];
  unknown: string[];
}

export function parsePromptTags(prompt: string, toolId: string): PromptTags {
  if (!toolId.startsWith("tts-")) return { tags: [], unknown: [] };
  const tags: string[] = [];
  const unknown: string[] = [];
  for (const m of prompt.matchAll(/\(([^()]{1,40})\)/g)) {
    const marker = m[1].trim().toLowerCase();
    if (!marker) continue;
    if (toolId === "tts-fish-s1mini" && FISH_MARKERS.has(marker)) {
      if (!tags.includes(marker)) tags.push(marker);
    } else if (toolId === "tts-fish-s1mini") {
      if (!unknown.includes(m[1].trim())) unknown.push(m[1].trim());
    } else if (!tags.includes(m[1].trim())) {
      // Other TTS lanes accept free-form style hints (cpm2 style control).
      tags.push(m[1].trim());
    }
  }
  return { tags, unknown };
}
