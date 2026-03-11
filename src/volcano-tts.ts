import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execFile } from "child_process";
import { writeFileSync as writeSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { SupportedLang } from "./types.js";

const CACHE_DIR = path.resolve(import.meta.dirname ?? ".", "../.tts-cache");
const VOLCANO_API = "https://openspeech.bytedance.com/api/v1/tts";

interface VolcanoConfig {
  apiKey: string;
  cluster: string;
  voiceType: string;
}

export interface TTSResult {
  audio: Buffer;
  durationMs: number;
  sizeBytes: number;
}

function parseWavDuration(buf: Buffer): number {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
  const byteRate = buf.readUInt32LE(28);
  if (byteRate === 0) return 0;
  return Math.round(((buf.length - 44) / byteRate) * 1000);
}

function parseMp3Duration(buf: Buffer): number {
  return Math.round((buf.length / (24000 / 8)) * 1000);
}

function cacheKey(text: string, lang: string, voiceType: string): string {
  const input = `volc:${voiceType}:${lang}:${text}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function execFilePromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export class VolcanoTTSClient {
  private config: VolcanoConfig;
  private cacheEnabled: boolean;
  private encoding: "mp3" | "wav";

  constructor(cacheEnabled = true) {
    this.config = {
      apiKey: process.env.VOLCANO_API_KEY ?? "",
      cluster: process.env.VOLCANO_CLUSTER ?? "volcano_icl",
      voiceType: process.env.VOLCANO_VOICE ?? "S_M1MG1D2W1",
    };
    this.encoding = "mp3";
    this.cacheEnabled = cacheEnabled;
    if (cacheEnabled) {
      try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
    }
    if (!this.config.apiKey) {
      process.stderr.write("[VolcanoTTS] WARNING: VOLCANO_API_KEY not set\n");
    }
    process.stderr.write(`[VolcanoTTS] cluster=${this.config.cluster}, voice=${this.config.voiceType}\n`);
  }

  async synthesize(text: string, lang: SupportedLang = "zh"): Promise<TTSResult> {
    const cached = this.readCache(text, lang);
    if (cached) return cached;

    const result = await this.doSynthesize(text, lang);
    this.writeCache(text, lang, result.audio);
    return result;
  }

  async playLocal(audio: Buffer): Promise<void> {
    if (process.platform !== "darwin") {
      process.stderr.write("[VolcanoTTS] playLocal: not macOS, skipping.\n");
      return;
    }
    const ext = this.encoding === "wav" ? ".wav" : ".mp3";
    const tmpPath = path.join(tmpdir(), `oirc-play-${Date.now().toString(36)}${ext}`);
    try {
      writeSync(tmpPath, audio);
      await execFilePromise("afplay", [tmpPath]);
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  async checkHealth(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  private async doSynthesize(text: string, lang: SupportedLang): Promise<TTSResult> {
    const reqid = crypto.randomUUID().replace(/-/g, "");
    const explicitLang = lang === "zh" ? "zh-cn" : lang === "en" ? "en" : lang === "ja" ? "ja" : lang === "ko" ? "ko" : undefined;

    const payload = {
      app: {
        cluster: this.config.cluster,
      },
      user: { uid: "openclaw-irc" },
      audio: {
        voice_type: this.config.voiceType,
        encoding: this.encoding,
        speed_ratio: 1.0,
        ...(explicitLang ? { explicit_language: explicitLang } : {}),
      },
      request: { reqid, text, operation: "query" },
    };

    process.stderr.write(`[VolcanoTTS] synthesize: lang=${lang}, voice=${this.config.voiceType}, text="${text.slice(0, 30)}..."\n`);

    const response = await fetch(VOLCANO_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      throw new Error(`Volcano TTS HTTP ${response.status}: ${errText}`);
    }

    const result = await response.json() as {
      code: number;
      message: string;
      data?: string;
      addition?: { duration?: string };
    };

    if (result.code !== 3000) {
      throw new Error(`Volcano TTS error ${result.code}: ${result.message}`);
    }

    if (!result.data) {
      throw new Error("Volcano TTS returned no audio data");
    }

    const audio = Buffer.from(result.data, "base64");
    const durationMs = result.addition?.duration
      ? parseInt(result.addition.duration, 10)
      : (this.encoding === "wav" ? parseWavDuration(audio) : parseMp3Duration(audio));

    process.stderr.write(`[VolcanoTTS] done: ${(audio.length / 1024).toFixed(1)}KB, ~${durationMs}ms\n`);
    return { audio, durationMs, sizeBytes: audio.length };
  }

  private readCache(text: string, lang: string): TTSResult | null {
    if (!this.cacheEnabled) return null;
    const fp = path.join(CACHE_DIR, `${cacheKey(text, lang, this.config.voiceType)}.${this.encoding}`);
    if (!existsSync(fp)) return null;
    try {
      const audio = readFileSync(fp);
      const durationMs = this.encoding === "wav" ? parseWavDuration(audio) : parseMp3Duration(audio);
      return { audio, durationMs, sizeBytes: audio.length };
    } catch { return null; }
  }

  private writeCache(text: string, lang: string, audio: Buffer): void {
    if (!this.cacheEnabled) return;
    try {
      const fp = path.join(CACHE_DIR, `${cacheKey(text, lang, this.config.voiceType)}.${this.encoding}`);
      writeFileSync(fp, audio);
    } catch { /* ignore */ }
  }
}
