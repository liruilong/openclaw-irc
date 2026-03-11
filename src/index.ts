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

const WS_PORT = parseInt(process.env.WS_PORT ?? "9891", 10);
const MCP_HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? "9894", 10);
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

bridge.onLocalTTS(async (text: string, lang: string) => {
  try {
    const result = await localTTS.synthesize(text, lang as SupportedLang);
    await localTTS.playLocal(result.audio);
  } catch (err) {
    process.stderr.write(`[openclaw-irc] Local TTS fallback error: ${err instanceof Error ? err.message : err}\n`);
  }
});

bridge.onChatInput(async (text: string) => {
  try {
    process.stderr.write(`[openclaw-irc] chat via IRC: "${text.slice(0, 60)}"\n`);
    const reply = await ircBridge.chat(text);
    process.stderr.write(`[openclaw-irc] IRC reply: "${reply.slice(0, 60)}"\n`);
    await bridge.broadcastSpeakText({ text: reply, lang: "zh" });
  } catch (err) {
    process.stderr.write(`[openclaw-irc] IRC chat error: ${err instanceof Error ? err.message : err}\n`);
  }
});

function registerTools(server: McpServer): void {
  server.tool(
    "speak",
    `Let the character speak with a specific emotion/animation.
Broadcasts text to all connected WebSocket clients (OLV, Spine-pet, Subtitle).
Each client independently decides whether to synthesize TTS audio.
If no audio-capable client (speaker) is connected, the server plays TTS locally via Mac system audio.
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
        .describe("Subtitle text. Defaults to the speak text if not provided."),
      color: z
        .string()
        .optional()
        .describe("Subtitle text color as hex (e.g. '#FFD700'). Defaults to emotion color."),
      motion: z
        .string()
        .optional()
        .describe("Motion group name for Live2D model. If not specified, uses default."),
    },
    async ({ text, emotion, lang, subtitle, color, motion }) => {
      const displayText = subtitle ?? text;
      process.stderr.write(`[openclaw-irc] speak: emotion="${emotion}" motion="${motion}"\n`);
      try {
        const motions = motion ? [motion] : undefined;
        const { clientCount, localFallback } = await bridge.broadcastSpeakText({
          text: displayText,
          emotion,
          motions,
          color,
          lang,
        });

        const parts: string[] = [
          `Character speaks "${displayText}" with [${emotion}] animation (${EMOTION_ANIMATIONS[emotion as Emotion].name}).`,
        ];
        parts.push(`Broadcast to ${clientCount} client(s), ${bridge.speakerCount} speaker(s) registered.`);
        if (localFallback) parts.push("Local TTS fallback: played via Mac system audio.");

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
    "Check connection status of IRC, WebSocket clients, and TTS.",
    {},
    async () => {
      const ttsOk = await localTTS.checkHealth();

      return {
        content: [
          {
            type: "text",
            text: [
              `=== openclaw-irc Status ===`,
              `IRC Server: port ${IRC_PORT}`,
              `IRC Bridge: ${ircBridge.isConnected ? "CONNECTED" : "NOT CONNECTED"} (channel: ${IRC_CHANNEL})`,
              `WebSocket (port ${WS_PORT}): ${bridge.clientCount} client(s) connected`,
              `Registered speakers: ${bridge.speakerCount} (local TTS fallback ${bridge.speakerCount === 0 ? "ACTIVE" : "INACTIVE"})`,
              `Volcano TTS: ${ttsOk ? "OK" : "NOT CONFIGURED"}`,
            ].join("\n"),
          },
        ],
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
              process.stderr.write(`[MCP-HTTP] Session initialized: ${sid}\n`);
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && httpTransports[sid]) {
              delete httpTransports[sid];
              process.stderr.write(`[MCP-HTTP] Session closed: ${sid}\n`);
            }
          };

          const sessionMcp = new McpServer({ name: "openclaw-irc", version: "1.0.0" });
          registerTools(sessionMcp);
          await sessionMcp.connect(transport);

          await transport.handleRequest(req, res, parsed);
          return;
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: expected initialize" }, id: null }));
          return;
        }
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session" }, id: null }));
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
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
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
    process.stderr.write(`[MCP-HTTP] Server error: ${err.message}\n`);
  });

  httpServer.listen(MCP_HTTP_PORT, "0.0.0.0", () => {
    process.stderr.write(`[MCP-HTTP] Streamable HTTP MCP at http://0.0.0.0:${MCP_HTTP_PORT}/mcp\n`);
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

// ── Start ──

async function main() {
  await ircServer.start();
  ircBridge.connect();
  bridge.start();
  startHttpMcp();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  process.stderr.write(
    `[openclaw-irc] Started (IRC: ${IRC_PORT}, WS: ${WS_PORT}, HTTP-MCP: ${MCP_HTTP_PORT})\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[openclaw-irc] Fatal error: ${err}\n`);
  process.exit(1);
});
