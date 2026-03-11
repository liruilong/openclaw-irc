export const EMOTIONS = [
  "Happy",
  "Confused",
  "Sad",
  "Fun",
  "Agree",
  "Drink",
  "Wave",
  "Think",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export const EMOTION_ANIMATIONS: Record<Emotion, { name: string; animId: number }> = {
  Happy:    { name: "Story_Joy",         animId: 1001 },
  Confused: { name: "Story_Frustration", animId: 1302 },
  Sad:      { name: "Story_Sad",         animId: 1002 },
  Fun:      { name: "Story_Fun",         animId: 1003 },
  Agree:    { name: "Story_Agree",       animId: 1301 },
  Drink:    { name: "Work_DrinkTea",     animId: 256  },
  Wave:     { name: "WaveHand",          animId: 5001 },
  Think:    { name: "Thinking",          animId: 252  },
};

export const EMOTION_COLORS: Record<Emotion, string> = {
  Happy:    "#FFD700",
  Confused: "#FF8C00",
  Sad:      "#6EB5FF",
  Fun:      "#FF69B4",
  Agree:    "#7CFC00",
  Drink:    "#DDA0DD",
  Wave:     "#FFFFFF",
  Think:    "#B0C4DE",
};

export const SUPPORTED_LANGS = ["ja", "zh", "en", "ko", "yue"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
