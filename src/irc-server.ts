import { createRequire } from "module";
import { EventEmitter } from "events";

const require = createRequire(import.meta.url);
const ircdkit = require("ircdkit");

export interface IRCServerOptions {
  port?: number;
  hostname?: string;
  maxNickLength?: number;
}

interface IRCConnection extends EventEmitter {
  id: number;
  nickname: string;
  username: string;
  realname: string | null;
  hostname: string;
  mask: string;
  isAuthed: boolean;
  send(...args: unknown[]): void;
  close(fn?: () => void): void;
  _socket: unknown;
}

interface IRCServer extends EventEmitter {
  listen(port: number, host?: string): IRCServer;
  close(fn?: () => void): void;
  getConnection(key: string, value: string): IRCConnection | false;
  removeConnection(conn: IRCConnection): void;
  _connections: IRCConnection[];
  host: string;
  config(key: string, value?: unknown): unknown;
}

type ChannelMembers = Map<string, IRCConnection>;

export class EmbeddedIRCServer {
  private server: IRCServer;
  private channels = new Map<string, ChannelMembers>();
  private port: number;

  constructor(opts: IRCServerOptions = {}) {
    this.port = opts.port ?? 6667;

    this.server = ircdkit({
      hostname: opts.hostname ?? "openclaw-irc",
      maxNickLength: opts.maxNickLength ?? 32,
      requireNickname: true,
    }) as IRCServer;

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.on("connection", (client: IRCConnection) => {
      this.log(`client connected: id=${client.id}`);

      client.on("data", (line: string) => {
        if (!line) return;
        const parts = line.split(" ");
        if (parts[0]?.toUpperCase() !== "NICK" || !parts[1]) return;
        const nick = parts[1];
        const existing = this.server.getConnection("nickname", nick);
        if (existing && existing.id !== client.id) {
          this.log(`ghost: kicking old ${nick} (id=${existing.id}) for new id=${client.id}`);
          this.ghostConnection(existing);
        }
      });

      client.on("authenticated", () => {
        for (const conn of this.server._connections) {
          if (conn.nickname === client.nickname && conn.id !== client.id) {
            this.log(`ghost-auth: kicking duplicate ${client.nickname} (id=${conn.id}) for id=${client.id}`);
            this.ghostConnection(conn);
          }
        }
        client.send(true, "422", client.nickname, ":MOTD File is missing");
      });

      client.on("JOIN", (channel: string) => {
        const ch = channel.toLowerCase();
        if (!this.channels.has(ch)) {
          this.channels.set(ch, new Map());
        }
        const members = this.channels.get(ch)!;
        members.set(client.nickname, client);

        for (const [, member] of members) {
          member.send(client.mask, "JOIN", ch);
        }

        const nickList = [...members.keys()].join(" ");
        client.send(true, "353", client.nickname, "=", ch, `:${nickList}`);
        client.send(true, "366", client.nickname, ch, ":End of /NAMES list");

        this.log(`${client.nickname} joined ${ch}`);
      });

      client.on("PART", (channel: string, reason?: string) => {
        const ch = channel.toLowerCase();
        const members = this.channels.get(ch);
        if (!members) return;

        const partMsg = reason ? `:${reason}` : `:${client.nickname}`;
        for (const [, member] of members) {
          member.send(client.mask, "PART", ch, partMsg);
        }
        members.delete(client.nickname);
        if (members.size === 0) this.channels.delete(ch);

        this.log(`${client.nickname} parted ${ch}`);
      });

      client.on("PRIVMSG", (target: string, text: string) => {
        if (target.startsWith("#")) {
          const ch = target.toLowerCase();
          const members = this.channels.get(ch);
          if (!members) {
            client.send(true, "403", client.nickname, target, ":No such channel");
            return;
          }
          for (const [nick, member] of members) {
            if (nick !== client.nickname) {
              member.send(client.mask, "PRIVMSG", target, `:${text}`);
            }
          }
        } else {
          const targetConn = this.server.getConnection("nickname", target);
          if (!targetConn) {
            client.send(true, "401", client.nickname, target, ":No such nick");
            return;
          }
          targetConn.send(client.mask, "PRIVMSG", target, `:${text}`);
        }
      });

      client.on("PING", (token: string) => {
        client.send(true, "PONG", token ? `:${token}` : `:${this.server.host}`);
      });

      client.on("WHO", (target: string) => {
        if (target.startsWith("#")) {
          const ch = target.toLowerCase();
          const members = this.channels.get(ch);
          if (members) {
            for (const [, member] of members) {
              client.send(true, "352", client.nickname, target, member.username, member.hostname, "openclaw-irc", member.nickname, "H", `:0 ${member.realname ?? member.username}`);
            }
          }
        }
        client.send(true, "315", client.nickname, target, ":End of /WHO list");
      });

      const cleanup = (reason: string) => {
        for (const [ch, members] of this.channels) {
          const existing = members.get(client.nickname);
          if (existing && existing.id === client.id) {
            this.log(`${client.nickname} leaving ${ch} (${reason}, id=${client.id})`);
            members.delete(client.nickname);
            for (const [, member] of members) {
              member.send(client.mask, "QUIT", `:${client.nickname}`);
            }
            if (members.size === 0) this.channels.delete(ch);
          }
        }
      };

      client.on("end", () => cleanup("end"));
      client.on("close", () => cleanup("close"));
      client.on("user:quit", () => cleanup("quit"));
    });

    this.server.on("error", (err: Error) => {
      this.log(`server error: ${err.message}`);
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.on("listening", () => {
        this.log(`IRC server listening on port ${this.port}`);
        resolve();
      });
      this.server.listen(this.port, "0.0.0.0");
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private ghostConnection(conn: IRCConnection): void {
    const nick = conn.nickname;
    for (const [ch, members] of this.channels) {
      const existing = members.get(nick);
      if (existing && existing.id === conn.id) {
        members.delete(nick);
        for (const [, m] of members) {
          m.send(conn.mask, "QUIT", ":Ghosted by reconnect");
        }
        if (members.size === 0) this.channels.delete(ch);
      }
    }
    conn.close();
    this.server.removeConnection(conn);
  }

  private log(msg: string): void {
    process.stderr.write(`[IRC-Server] ${msg}\n`);
  }
}
