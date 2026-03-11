import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { EMOTIONS, EMOTION_ANIMATIONS, SUPPORTED_LANGS } from "./types.js";
import type { Emotion, SupportedLang } from "./types.js";
import { VolcanoTTSClient } from "./volcano-tts.js";
import { Bridge } from "./ws-bridge.js";
import { EmbeddedIRCServer } from "./irc-server.js";
import { IRCBridge } from "./llm-client.js";

const WS_PORT = parseInt(process.env.WS_PORT ?? "9881", 10);
const MCP_HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? "9884", 10);
const IRC_PORT = parseInt(process.env.IRC_PORT ?? "6667", 10);
const IRC_CHANNEL = process.env.IRC_CHANNEL ?? "#miku";
const IRC_OPENCLAW_NICK = process.env.IRC_OPENCLAW_NICK ?? "miku";

const localTTS = new VolcanoTTSClient();
const bridge = new Bridge(WS_PORT);
const ircServer = new EmbeddedIRCServer({ port: IRC_PORT });
const ircBridge = new IRCBridge({
  port: IRC_PORT,
  channel: IRC_CHANNEL,
  openclawNick: IRC_OPENCLAW_NICK,
});

// Local TTS fallback: plays via Mac system audio when no WS speaker is registered
bridge.onLocalTTS(async (text: string, lang: string) => {
  try {
    const result = await localTTS.synthesize(text, lang as SupportedLang);
    await localTTS.playLocal(result.audio);
  } catch (err) {
    process.stderr.write(`[openclaw-irc] local TTS error: ${err instanceof Error ? err.message : err}\n`);
  }
});

// WS chat → IRC bridge → OpenClaw → reply broadcast
bridge.onChatInput(async (text: string) => {
  process.stderr.write(`[openclaw-irc] chat: "${text.slice(0, 60)}"\n`);
  const reply = await ircBridge.chat(text);
  process.stderr.write(`[openclaw-irc] reply: "${reply.slice(0, 60)}"\n`);
  await bridge.broadcastSpeakText({ text: reply, lang: "zh" });
});

// ── MCP Tools ──

function registerTools(server: McpServer): void {
  server.tool(
    "speak",
    `Let the character speak. Broadcasts text to all connected WebSocket clients.
Each client independently decides whether to synthesize TTS audio.
If no speaker client is connected, the server plays TTS locally via Mac system audio.
Available emotions: ${EMOTIONS.join(", ")}
Emotion-to-animation mapping: ${EMOTIONS.map((e) => `${e} -> ${EMOTION_ANIMATIONS[e].name} (id:${EMOTION_ANIMATIONS[e].animId})`).join(", ")}
Supported languages: ${SUPPORTED_LANGS.join(", ")}`,
    {
      text: z.string().describe("The text for the character to speak"),
      emotion: z
        .enum(EMOTIONS)
        .default("Happy")
        .describe("The emotion/animation to display"),
      lang: z
        .enum(SUPPORTED_LANGS)
        .default("ja")
        .describe("Language of the text for TTS synthesis"),
      subtitle: z
        .string()
        .optional()
        .describe("Subtitle text. Defaults to the speak text. Use this to show a translation."),
      color: z
        .string()
        .optional()
        .describe("Subtitle text color as hex (e.g. '#FFD700'). Defaults to emotion color."),
      motion: z
        .string()
        .optional()
        .describe("Motion group name for Live2D model (e.g. 'w-cute02-pose'). If not specified, auto-selected by emotion."),
    },
    async ({ text, emotion, lang, subtitle, color, motion }) => {
      const displayText = subtitle ?? text;
      process.stderr.write(`[openclaw-irc] speak: emotion="${emotion}" text="${displayText.slice(0, 40)}"\n`);
      try {
        const motions = motion ? [motion] : undefined;
        const { clientCount, localFallback } = await bridge.broadcastSpeakText({
          text: displayText,
          emotion,
          motions,
          color,
          lang,
        });

        const parts = [
          `"${displayText}" [${emotion}] (${EMOTION_ANIMATIONS[emotion as Emotion].name}).`,
          `${clientCount} client(s), ${bridge.speakerCount} speaker(s).`,
        ];
        if (localFallback) parts.push("Local TTS fallback played.");

        return { content: [{ type: "text", text: parts.join(" ") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `speak failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_status",
    "Check connection status of IRC, WebSocket clients, and TTS service.",
    {},
    async () => {
      const ttsOk = await localTTS.checkHealth();
      return {
        content: [{
          type: "text",
          text: [
            `=== openclaw-irc ===`,
            `IRC Server: :${IRC_PORT}`,
            `IRC Bridge: ${ircBridge.isConnected ? "CONNECTED" : "DISCONNECTED"} (${IRC_CHANNEL})`,
            `WebSocket: :${WS_PORT} (${bridge.clientCount} client(s))`,
            `Speakers: ${bridge.speakerCount} (local TTS ${bridge.speakerCount === 0 ? "ACTIVE" : "INACTIVE"})`,
            `Volcano TTS: ${ttsOk ? "OK" : "NOT CONFIGURED"}`,
          ].join("\n"),
        }],
      };
    }
  );
}

const mcpServer = new McpServer({ name: "openclaw-irc", version: "1.0.0" });
registerTools(mcpServer);

// ── HTTP MCP Transport ──

const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

function startHttpMcp(): void {
  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && httpTransports[sessionId]) {
        transport = httpTransports[sessionId];
      } else if (!sessionId && req.method === "POST") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        if (isInitializeRequest(parsed)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              httpTransports[sid] = transport;
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && httpTransports[sid]) delete httpTransports[sid];
          };

          const s = new McpServer({ name: "openclaw-irc", version: "1.0.0" });
          registerTools(s);
          await s.connect(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }));
          return;
        }
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }));
        return;
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        await transport.handleRequest(req, res, JSON.parse(body));
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      process.stderr.write(`[MCP-HTTP] Error: ${error instanceof Error ? error.message : error}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`[MCP-HTTP] Port ${MCP_HTTP_PORT} in use, retrying in 2s...\n`);
      httpServer.close();
      setTimeout(() => startHttpMcp(), 2000);
      return;
    }
    process.stderr.write(`[MCP-HTTP] Error: ${err.message}\n`);
  });

  httpServer.listen(MCP_HTTP_PORT, "0.0.0.0", () => {
    process.stderr.write(`[MCP-HTTP] http://0.0.0.0:${MCP_HTTP_PORT}/mcp\n`);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Main ──

async function main() {
  await ircServer.start();
  ircBridge.connect();
  bridge.start();
  startHttpMcp();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  process.stderr.write(`[openclaw-irc] started (IRC:${IRC_PORT} WS:${WS_PORT} MCP:${MCP_HTTP_PORT})\n`);
}

main().catch((err) => {
  process.stderr.write(`[openclaw-irc] fatal: ${err}\n`);
  process.exit(1);
});
