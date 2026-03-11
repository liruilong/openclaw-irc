import { createRequire } from "module";
import { EventEmitter } from "events";

const require = createRequire(import.meta.url);
const IrcFramework = require("irc-framework");

export interface IRCBridgeOptions {
  host?: string;
  port?: number;
  nick?: string;
  channel?: string;
  openclawNick?: string;
  chatTimeoutMs?: number;
  silenceMs?: number;
}

/**
 * IRC client that bridges chat between WebSocket clients and OpenClaw.
 * Connects to the embedded IRC server, joins #miku, and relays messages.
 */
export class IRCBridge extends EventEmitter {
  private client: InstanceType<typeof IrcFramework.Client>;
  private host: string;
  private port: number;
  private nick: string;
  private channel: string;
  private openclawNick: string;
  private chatTimeoutMs: number;
  private silenceMs: number;
  private connected = false;
  private pendingReply: {
    resolve: (text: string) => void;
    buffer: string;
    timer: ReturnType<typeof setTimeout> | null;
    silenceTimer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  constructor(opts: IRCBridgeOptions = {}) {
    super();
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 6667;
    this.nick = opts.nick ?? "bridge";
    this.channel = opts.channel ?? "#miku";
    this.openclawNick = opts.openclawNick ?? "miku";
    this.chatTimeoutMs = opts.chatTimeoutMs ?? 120_000;
    this.silenceMs = opts.silenceMs ?? 3000;

    this.client = new IrcFramework.Client();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.client.on("registered", () => {
      this.connected = true;
      this.log(`connected as ${this.nick}`);
      this.client.join(this.channel);
    });

    this.client.on("join", (evt: { channel: string; nick: string }) => {
      this.log(`${evt.nick} joined ${evt.channel}`);
    });

    this.client.on("message", (evt: { target: string; nick: string; message: string }) => {
      if (evt.nick === this.nick) return;
      const isChannel = evt.target.toLowerCase() === this.channel.toLowerCase();
      const isDM = evt.target.toLowerCase() === this.nick.toLowerCase();
      if (!isChannel && !isDM) return;

      this.log(`<${evt.nick}> ${evt.message.slice(0, 60)}`);

      if (this.pendingReply && evt.nick.toLowerCase() === this.openclawNick.toLowerCase()) {
        const p = this.pendingReply;
        if (p.buffer) p.buffer += "\n";
        p.buffer += evt.message;

        if (p.silenceTimer) clearTimeout(p.silenceTimer);
        p.silenceTimer = setTimeout(() => {
          this.finishReply();
        }, this.silenceMs);
      }

      this.emit("channel_message", {
        nick: evt.nick,
        channel: evt.target,
        message: evt.message,
      });
    });

    this.client.on("close", () => {
      this.connected = false;
      this.log("disconnected, reconnecting in 5s...");
      setTimeout(() => this.connect(), 5000);
    });

    this.client.on("socket close", () => {
      this.connected = false;
    });
  }

  connect(): void {
    this.log(`connecting to ${this.host}:${this.port} as ${this.nick}`);
    this.client.connect({
      host: this.host,
      port: this.port,
      nick: this.nick,
      username: this.nick,
      gecos: "openclaw-irc bridge",
      auto_reconnect: false,
    });
  }

  /**
   * Send a message to the channel and wait for OpenClaw's reply.
   * Collects multi-line replies using silence detection + absolute timeout.
   */
  async chat(text: string): Promise<string> {
    if (!this.connected) {
      return "IRC 未连接，请稍后再试";
    }

    if (this.pendingReply) {
      this.finishReply();
    }

    this.client.say(this.openclawNick, text);
    this.log(`sent to ${this.openclawNick}: ${text.slice(0, 60)}`);

    return new Promise<string>((resolve) => {
      const absoluteTimer = setTimeout(() => {
        this.finishReply();
      }, this.chatTimeoutMs);

      this.pendingReply = {
        resolve,
        buffer: "",
        timer: absoluteTimer,
        silenceTimer: null,
      };
    });
  }

  /**
   * Send a message to the channel without waiting for a reply.
   */
  send(text: string): void {
    if (!this.connected) {
      this.log("send failed: not connected");
      return;
    }
    this.client.say(this.openclawNick, text);
    this.log(`fire-and-forget to ${this.openclawNick}: ${text.slice(0, 60)}`);
  }

  private finishReply(): void {
    if (!this.pendingReply) return;
    const p = this.pendingReply;
    this.pendingReply = null;

    if (p.timer) clearTimeout(p.timer);
    if (p.silenceTimer) clearTimeout(p.silenceTimer);

    const reply = p.buffer.trim() || "（无回复）";
    p.resolve(reply);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private log(msg: string): void {
    process.stderr.write(`[IRC-Bridge] ${msg}\n`);
  }
}
