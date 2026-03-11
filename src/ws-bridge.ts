import { WebSocketServer, WebSocket } from "ws";
import { EMOTION_COLORS } from "./types.js";
import type { Emotion } from "./types.js";

export interface SpeakTextMessage {
  type: "speak_text";
  text: string;
  emotion?: string;
  motions?: string[];
  color?: string;
  lang?: string;
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  private port: number;
  private clients = new Set<WebSocket>();
  private speakers = new Set<WebSocket>();
  private onLocalTTSCallback: ((text: string, lang: string) => Promise<void>) | null = null;
  private onChatInputCallback: ((text: string) => Promise<void>) | null = null;

  constructor(port = 9891) {
    this.port = port;
  }

  onLocalTTS(callback: (text: string, lang: string) => Promise<void>): void {
    this.onLocalTTSCallback = callback;
  }

  onChatInput(callback: (text: string) => Promise<void>): void {
    this.onChatInputCallback = callback;
  }

  get speakerCount(): number {
    return this.speakers.size;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  start(): void {
    if (this.wss) return;

    const wss = new WebSocketServer({ port: this.port });

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        this.log(`Port ${this.port} in use, retrying in 2s...`);
        wss.close();
        setTimeout(() => this.start(), 2000);
        return;
      }
      this.log(`WS error: ${err.message}`);
    });

    wss.on("listening", () => {
      this.wss = wss;
      this.log(`WebSocket listening on port ${this.port}`);
    });

    wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.log(`Client connected (total: ${this.clients.size})`);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(ws, msg);
        } catch { /* ignore */ }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.speakers.delete(ws);
        this.log(`Client disconnected (total: ${this.clients.size}, speakers: ${this.speakers.size})`);
      });

      ws.on("error", () => {
        this.clients.delete(ws);
        this.speakers.delete(ws);
      });
    });
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "register_speaker":
        this.speakers.add(ws);
        this.log(`Speaker registered (total: ${this.speakers.size})`);
        break;

      case "chat":
        if (typeof msg.text === "string" && this.onChatInputCallback) {
          this.onChatInputCallback(msg.text);
        }
        break;

      default:
        break;
    }
  }

  async broadcastSpeakText(opts: {
    text: string;
    emotion?: string;
    motions?: string[];
    color?: string;
    lang?: string;
  }): Promise<{ clientCount: number; localFallback: boolean }> {
    const { text, emotion, lang } = opts;
    const effectiveColor = opts.color ?? (emotion ? EMOTION_COLORS[emotion as Emotion] : undefined);

    const msg: SpeakTextMessage = {
      type: "speak_text",
      text,
      emotion,
      motions: opts.motions,
      color: effectiveColor,
      lang,
    };
    const payload = JSON.stringify(msg);

    let clientCount = 0;
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        clientCount++;
      }
    }

    let localFallback = false;
    if (this.speakers.size === 0 && this.onLocalTTSCallback && text) {
      localFallback = true;
      try {
        await this.onLocalTTSCallback(text, lang ?? "zh");
      } catch (err) {
        this.log(`Local TTS fallback failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.log(`broadcastSpeakText: "${text.slice(0, 40)}" -> ${clientCount} clients, speakers=${this.speakers.size}, localFallback=${localFallback}`);
    return { clientCount, localFallback };
  }

  stop(): void {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    this.speakers.clear();
    this.wss?.close();
    this.wss = null;
  }

  private log(msg: string): void {
    process.stderr.write(`[Bridge] ${msg}\n`);
  }
}
