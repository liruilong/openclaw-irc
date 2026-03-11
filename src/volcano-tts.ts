import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execFile } from "child_process";
import { writeFileSync as writeSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { SupportedLang } from "./types.js";

const CACHE_DIR = path.resolve(import.meta.dirname ?? ".", "../.tts-cache");
const VOLCANO_V3_API = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

interface VolcanoConfig {
  appid: string;
  token: string;
  voiceType: string;
  resourceId: string;
}

export interface TTSResult {
  audio: Buffer;
  durationMs: number;
  sizeBytes: number;
}

function parseMp3Duration(buf: Buffer): number {
  const bytesPerSecond = 24000 / 8;
  return Math.round((buf.length / bytesPerSecond) * 1000);
}

function cacheKey(text: string, lang: string, voiceType: string): string {
  const input = `volc-v3:${voiceType}:${lang}:${text}`;
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

  constructor(cacheEnabled = true) {
    this.config = {
      appid: process.env.VOLCANO_APPID ?? "",
      token: process.env.VOLCANO_TOKEN ?? "",
      voiceType: process.env.VOLCANO_VOICE ?? "zh_female_shuangkuaisisi_moon_bigtts",
      resourceId: process.env.VOLCANO_RESOURCE_ID ?? "seed-icl-1.0",
    };
    this.cacheEnabled = cacheEnabled;
    if (cacheEnabled) {
      try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
    }
    if (!this.config.appid || !this.config.token) {
      process.stderr.write("[VolcanoTTS] WARNING: VOLCANO_APPID or VOLCANO_TOKEN not set\n");
    }
    process.stderr.write(`[VolcanoTTS] V3 API, voice=${this.config.voiceType}, resource=${this.config.resourceId}\n`);
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
    const tmpPath = path.join(tmpdir(), `oirc-play-${Date.now().toString(36)}.mp3`);
    try {
      writeSync(tmpPath, audio);
      await execFilePromise("afplay", [tmpPath]);
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  async checkHealth(): Promise<boolean> {
    return !!(this.config.appid && this.config.token);
  }

  private async doSynthesize(text: string, lang: SupportedLang): Promise<TTSResult> {
    const reqid = crypto.randomUUID();
    const explicitLang = lang === "zh" ? "zh-cn" : lang === "en" ? "en" : lang === "ja" ? "ja" : undefined;

    const payload = {
      user: { uid: "openclaw-irc" },
      req_params: {
        text,
        speaker: this.config.voiceType,
        audio_params: {
          format: "mp3",
          sample_rate: 24000,
        },
        ...(explicitLang ? { additions: JSON.stringify({ explicit_language: explicitLang }) } : {}),
      },
    };

    process.stderr.write(`[VolcanoTTS] V3 synthesize: lang=${lang}, speaker=${this.config.voiceType}, text="${text.slice(0, 30)}..."\n`);

    const isApiKey = this.config.token.includes("-");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Api-Resource-Id": this.config.resourceId,
      "X-Api-Request-Id": reqid,
    };
    if (isApiKey) {
      headers["Authorization"] = `Bearer;${this.config.token}`;
    } else {
      headers["X-Api-App-Id"] = this.config.appid;
      headers["X-Api-Access-Key"] = this.config.token;
    }

    const response = await fetch(VOLCANO_V3_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      throw new Error(`Volcano TTS V3 HTTP ${response.status}: ${errText}`);
    }

    const audioChunks: Buffer[] = [];
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Volcano TTS V3: no response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed) as {
            code?: number;
            message?: string;
            data?: string;
            event?: string;
          };

          if (chunk.code && chunk.code !== 0 && chunk.code !== 20000000) {
            throw new Error(`Volcano TTS V3 error ${chunk.code}: ${chunk.message ?? "unknown"}`);
          }

          if (chunk.data) {
            audioChunks.push(Buffer.from(chunk.data, "base64"));
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Volcano TTS V3 error")) throw e;
        }
      }
    }

    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as { code?: number; message?: string; data?: string };
        if (chunk.code && chunk.code !== 0 && chunk.code !== 20000000) {
          throw new Error(`Volcano TTS V3 error ${chunk.code}: ${chunk.message ?? "unknown"}`);
        }
        if (chunk.data) {
          audioChunks.push(Buffer.from(chunk.data, "base64"));
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Volcano TTS V3 error")) throw e;
      }
    }

    if (audioChunks.length === 0) {
      throw new Error("Volcano TTS V3 returned no audio data");
    }

    const audio = Buffer.concat(audioChunks);
    const durationMs = parseMp3Duration(audio);

    process.stderr.write(`[VolcanoTTS] V3 done: ${(audio.length / 1024).toFixed(1)}KB, ~${durationMs}ms\n`);
    return { audio, durationMs, sizeBytes: audio.length };
  }

  private readCache(text: string, lang: string): TTSResult | null {
    if (!this.cacheEnabled) return null;
    const fp = path.join(CACHE_DIR, `${cacheKey(text, lang, this.config.voiceType)}.mp3`);
    if (!existsSync(fp)) return null;
    try {
      const audio = readFileSync(fp);
      const durationMs = parseMp3Duration(audio);
      return { audio, durationMs, sizeBytes: audio.length };
    } catch { return null; }
  }

  private writeCache(text: string, lang: string, audio: Buffer): void {
    if (!this.cacheEnabled) return;
    try {
      const fp = path.join(CACHE_DIR, `${cacheKey(text, lang, this.config.voiceType)}.mp3`);
      writeFileSync(fp, audio);
    } catch { /* ignore */ }
  }
}
