import { EventEmitter } from "node:events";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const configSchema = z.object({
  llm: z.object({
    base_url: z.url().refine((url) => /^https?:/.test(url), "Use an HTTP or HTTPS API URL"),
    model: z.string().trim().min(1),
    api_key: z.string().optional(),
    api_key_env: z.string().min(1).default("OPENAI_API_KEY"),
  }),
  music: z.object({
    library: z.string().trim().min(1).optional(),
    libraries: z.array(z.string().trim().min(1)).min(1).optional(),
  }).refine((music) => (music.library !== undefined) !== (music.libraries !== undefined), {
    message: "Set either music.library or music.libraries, not both.",
  }).transform((music) => ({ libraries: music.libraries ?? [music.library!] })),
  player: z.object({ binary: z.string().min(1).default("mpv") }).default({ binary: "mpv" }),
});

export async function loadConfig(file = "config.toml") {
  const config = configSchema.parse(Bun.TOML.parse(await Bun.file(file).text()));
  config.music.libraries = config.music.libraries.map((path) => path === "~" ? homedir()
    : path.startsWith("~/") ? join(homedir(), path.slice(2))
    : resolve(dirname(resolve(file)), path));
  return config;
}

const audioExtensions = new Set([
  ".mp3", ".flac", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".aiff", ".aif", ".alac", ".wma", ".ape", ".wv",
]);

export class Library {
  tracks: string[] = [];
  roots: string[];
  private files = new Map<string, { root: string; path: string }>();
  private labels = new Map<string, string>();
  constructor(roots: string | string[]) {
    this.roots = typeof roots === "string" ? [roots] : roots;
  }

  async scan() {
    const roots = [...new Set(await Promise.all(this.roots.map((root) => realpath(root))))];
    const files = new Map<string, { root: string; path: string }>();
    const labels = new Map<string, string>();
    for (const [index, root] of roots.entries()) {
      const directories = [root];
      while (directories.length) {
        const directory = directories.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith("._") || entry.name === "__MACOSX") continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) directories.push(path);
          else if (entry.isFile() && audioExtensions.has(extname(entry.name).toLowerCase()) && !labels.has(path)) {
            const track = `${roots.length > 1 ? `[${index + 1}]/` : ""}${relative(root, path)}`;
            files.set(track, { root, path });
            labels.set(path, track);
          }
        }
      }
    }
    this.roots = roots;
    this.files = files;
    this.labels = labels;
    this.tracks = [...files.keys()].sort((a, b) => a.localeCompare(b));
    return { total: this.tracks.length };
  }

  label(file: string) {
    return this.labels.get(file) ?? file;
  }

  search(query = "", offset = 0, limit = 30) {
    // ponytail: filenames only, read audio tags when filename search is insufficient.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.tracks.filter((track) => terms.every((term) => track.toLowerCase().includes(term)));
    return { total: matches.length, tracks: matches.slice(offset, offset + limit), offset };
  }

  async file(track: string) {
    const entry = this.files.get(track);
    if (!entry) throw new Error("Track is not in the scanned library. Search or /scan first.");
    const file = await realpath(entry.path);
    const local = relative(entry.root, file);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
      throw new Error("Track resolves outside the music library.");
    }
    return file;
  }
}

export const controlSchema = z.object({
  action: z.enum(["pause", "resume", "toggle", "stop", "next", "prev", "volume", "seek"]),
  value: z.number().finite().optional().describe("Volume 0 to 100, or relative seek seconds"),
}).superRefine(({ action, value }, ctx) => {
  if ((action === "volume" || action === "seek") && value === undefined) {
    ctx.addIssue({ code: "custom", message: `${action} requires a number` });
  }
  if (action === "volume" && value !== undefined && (value < 0 || value > 100)) {
    ctx.addIssue({ code: "custom", message: "Volume must be between 0 and 100" });
  }
});

type PlaylistEntry = { filename: string; current?: boolean; playing?: boolean };

export class Player extends EventEmitter {
  private process?: Bun.Subprocess<"ignore", "ignore", "pipe">;
  private directory = "";
  private socketPath = "";
  private closed = false;
  private monitor?: Socket;
  private playbackStarted = false;
  private playbackError?: string;
  private lastLog = "";

  async start(binary = "mpv") {
    if (!Bun.which(binary)) throw new Error(`Cannot find ${binary}. Install mpv or set player.binary.`);
    this.directory = await mkdtemp(join(tmpdir(), "ai-joker-"));
    this.socketPath = join(this.directory, "mpv.sock");
    try {
      this.process = Bun.spawn([
        binary, "--no-config", "--idle=yes", "--no-video", "--no-terminal", "--input-terminal=no",
        `--input-ipc-server=${this.socketPath}`,
      ], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const errors = new Response(this.process.stderr).text();
      for (let attempt = 0; attempt < 60; attempt++) {
        if (this.process.exitCode !== null) throw new Error(`mpv exited: ${(await errors).trim()}`);
        try {
          await this.command(["get_property", "idle-active"]);
          await this.watchPlayback();
          return;
        } catch {
          await Bun.sleep(50);
        }
      }
      throw new Error("mpv did not open its IPC socket within 3 seconds.");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async watchPlayback() {
    const socket = createConnection(this.socketPath);
    this.monitor = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { socket.destroy(new Error("Invalid event from mpv.")); return; }
        if (message.event === "log-message" && !message.prefix.startsWith("ipc_")) {
          this.lastLog = message.text.trim().slice(-2000);
        } else if (message.event === "playback-restart") {
          this.playbackStarted = true;
          this.playbackError = undefined;
        } else if (message.event === "end-file" && message.reason === "error") {
          this.playbackError = `mpv: ${message.file_error || this.lastLog || "Playback failed"}`;
          this.emit("playback-error", this.playbackError);
        }
      }
    });
    socket.on("error", () => {}); // The close event reports disconnects; startup errors reject below.
    socket.on("close", () => {
      if (!this.closed) {
        this.playbackError = "mpv disconnected.";
        this.emit("playback-error", this.playbackError);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => { socket.off("error", reject); resolve(); });
    });
    socket.write(`${JSON.stringify({ command: ["request_log_messages", "error"] })}\n`);
  }

  command<T = unknown>(command: unknown[]): Promise<T> {
    if (this.closed || !this.process || this.process.exitCode !== null) {
      return Promise.reject(new Error("mpv is not running."));
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      const finish = (error?: Error, data?: T) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(data as T);
      };
      const timer = setTimeout(() => finish(new Error("mpv command timed out.")), 4000);
      socket.on("error", (error) => finish(error));
      socket.on("end", () => finish(new Error("mpv disconnected.")));
      socket.on("connect", () => socket.write(`${JSON.stringify({ command, request_id: 1 })}\n`));
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.request_id !== 1) continue;
            finish(message.error === "success" ? undefined : new Error(`mpv ${command[0]}: ${message.error}`), message.data);
            return;
          } catch {
            finish(new Error("Invalid response from mpv."));
            return;
          }
        }
      });
    });
  }

  async play(library: Library, tracks: string[], append = false, signal?: AbortSignal) {
    if (!tracks.length || tracks.length > 100) throw new Error("Choose between 1 and 100 tracks.");
    const files = await Promise.all(tracks.map((track) => library.file(track)));
    const startsPlayback = !append || await this.command<boolean>(["get_property", "idle-active"]);
    if (startsPlayback) {
      this.playbackStarted = false;
      this.playbackError = undefined;
      this.lastLog = "";
    }
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted();
      await this.command(["loadfile", file, append || index > 0 ? "append-play" : "replace"]);
      if (index === 0 && startsPlayback) {
        await this.command(["set_property", "pause", false]);
        const deadline = Date.now() + 10_000;
        while (true) {
          signal?.throwIfAborted();
          if (this.playbackError) throw new Error(this.playbackError);
          if (this.playbackStarted) break;
          if (Date.now() >= deadline) throw new Error("mpv did not start playback within 10 seconds.");
          await Bun.sleep(25);
        }
      }
    }
    signal?.throwIfAborted();
    return { queued: tracks, append };
  }

  async control(input: z.input<typeof controlSchema>) {
    const { action, value } = controlSchema.parse(input);
    const commands: Record<string, unknown[]> = {
      pause: ["set_property", "pause", true], resume: ["set_property", "pause", false],
      toggle: ["cycle", "pause"], stop: ["stop"], next: ["playlist-next", "force"],
      prev: ["playlist-prev", "force"], volume: ["set_property", "volume", value],
      seek: ["seek", value, "relative"],
    };
    await this.command(commands[action]!);
    if (action === "stop") await this.command(["playlist-clear"]);
    return { action, value };
  }

  async status() {
    const [queue, paused, volume, idle] = await Promise.all([
      this.command<PlaylistEntry[]>(["get_property", "playlist"]),
      this.command<boolean>(["get_property", "pause"]),
      this.command<number>(["get_property", "volume"]),
      this.command<boolean>(["get_property", "idle-active"]),
    ]);
    return { queue, paused, volume, error: this.playbackError, current: idle ? undefined : queue.find((entry) => entry.playing || entry.current)?.filename };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.monitor?.destroy();
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
      await this.process.exited;
    }
    // Remove only the private temporary directory created by this player.
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
