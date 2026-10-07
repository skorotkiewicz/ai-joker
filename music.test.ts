import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, unlink, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { MusicAgent } from "./agent";
import { mountUI } from "./index";
import { configSchema, Library, loadConfig, Player } from "./music";

function silence() {
  const bytes = Buffer.alloc(44 + 8000 * 2 * 60);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function waitForTrack(player: Player, path: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const current = await player.command<string>(["get_property", "path"]);
      const time = await player.command<number>(["get_property", "time-pos"]);
      if (current === path && typeof time === "number") return;
    } catch { /* mpv is still opening the track. */ }
    await Bun.sleep(20);
  }
  throw new Error(`mpv did not load ${path}`);
}

test("TOML validation and paths relative to config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "joker-config-"));
  try {
    const path = join(dir, "config.toml");
    await Bun.write(path, '[llm]\nbase_url="http://localhost:1234/v1"\nmodel="test"\n[music]\nlibrary="tracks"\n');
    expect((await loadConfig(path)).music.libraries).toEqual([join(dir, "tracks")]);
    await Bun.write(path, `[llm]\nbase_url="http://localhost:1234/v1"\nmodel="test"\n[music]\nlibraries=["tracks", "~/Music", ${JSON.stringify(join(dir, "other"))}]\n`);
    expect((await loadConfig(path)).music.libraries).toEqual([join(dir, "tracks"), join(homedir(), "Music"), join(dir, "other")]);
    const valid = { llm: { base_url: "http://localhost/v1", model: "test" } };
    for (const music of [{}, { libraries: [] }, { libraries: [""] }, { library: "tracks", libraries: ["other"] }]) {
      expect(configSchema.safeParse({ ...valid, music }).success).toBe(false);
    }
    expect(configSchema.safeParse({ llm: { base_url: "file:///tmp", model: "" }, music: { library: "" } }).success).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("multiple libraries keep duplicate filenames distinct and rescan atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "joker-libraries-"));
  const roots = [join(dir, "one"), join(dir, "two")];
  const track = "Artist/song.wav";
  try {
    for (const root of roots) {
      await mkdir(join(root, "Artist"), { recursive: true });
      await Bun.write(join(root, track), silence());
    }
    const library = new Library([roots[0]!, roots[0]!, roots[1]!, join(roots[0]!, "Artist")]);
    expect(await library.scan()).toEqual({ total: 2 });
    expect(library.search("song").tracks).toEqual([`[1]/${track}`, `[2]/${track}`]);
    expect(library.roots).toEqual([roots[0]!, roots[1]!, join(roots[0]!, "Artist")]);
    expect(await library.file(`[1]/${track}`)).toBe(join(roots[0]!, track));
    expect(await library.file(`[2]/${track}`)).toBe(join(roots[1]!, track));
    expect(library.label(join(roots[1]!, track))).toBe(`[2]/${track}`);
    await expect(library.file(track)).rejects.toThrow("not in the scanned");
    await expect(library.file("[2]/../one/Artist/song.wav")).rejects.toThrow("not in the scanned");
    await unlink(join(roots[0]!, track));
    await symlink(join(roots[1]!, track), join(roots[0]!, track));
    await expect(library.file(`[1]/${track}`)).rejects.toThrow("outside");
    library.roots.push(join(dir, "missing"));
    await expect(library.scan()).rejects.toThrow();
    expect(library.tracks).toEqual([`[1]/${track}`, `[2]/${track}`]);
    expect(await library.file(`[2]/${track}`)).toBe(join(roots[1]!, track));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(!Bun.which("mpv"))("library, real mpv, mock tool loop, and terminal input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "joker-test-"));
  const root = join(dir, "music");
  const player = new Player();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ui: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
  try {
    await mkdir(join(root, "Artist"), { recursive: true });
    const tracks = ["Artist/First song.wav", "Artist/Second  song.WAV"];
    for (const track of tracks) await Bun.write(join(root, track), silence());
    await Bun.write(join(root, "readme.txt"), "not music");
    await Bun.write(join(dir, "outside.wav"), silence());
    await symlink(join(dir, "outside.wav"), join(root, "linked.wav"));
    const library = new Library(root);
    expect(await library.scan()).toEqual({ total: 2 });
    expect(library.search("artist first").tracks).toEqual([tracks[0]!]);
    expect(library.search("", 1, 1).tracks).toEqual([tracks[1]!]);
    await expect(library.file("../outside.wav")).rejects.toThrow("not in the scanned");
    await unlink(join(root, tracks[0]!));
    await symlink(join(dir, "outside.wav"), join(root, tracks[0]!));
    await expect(library.file(tracks[0]!)).rejects.toThrow("outside");
    await unlink(join(root, tracks[0]!));
    await Bun.write(join(root, tracks[0]!), silence());

    const binary = join(dir, "mpv-null");
    await Bun.write(binary, `#!/bin/sh\nexec '${Bun.which("mpv")}' --ao=null "$@"\n`);
    await chmod(binary, 0o700);
    await player.start(binary);
    await expect(player.play(library, [tracks[0]!, "invalid.wav"])).rejects.toThrow();
    expect((await player.status()).queue).toHaveLength(0);
    await player.play(library, tracks);
    await waitForTrack(player, join(root, tracks[0]!));
    expect((await player.status()).queue).toHaveLength(2);
    await player.control({ action: "pause" });
    expect((await player.status()).paused).toBe(true);
    await player.control({ action: "resume" });
    expect((await player.status()).paused).toBe(false);
    await player.control({ action: "next" });
    await waitForTrack(player, join(root, tracks[1]!));
    expect((await player.status()).current).toBe(join(root, tracks[1]!));
    await player.control({ action: "prev" });
    await waitForTrack(player, join(root, tracks[0]!));
    await player.control({ action: "volume", value: 37 });
    expect((await player.status()).volume).toBe(37);
    await expect(player.control({ action: "volume", value: 101 })).rejects.toThrow();
    await expect(player.control({ action: "seek" })).rejects.toThrow();
    await player.control({ action: "seek", value: 2 });
    await player.control({ action: "stop" });
    expect((await player.status()).queue).toHaveLength(0);

    let requests = 0;
    let mode: "tools" | "slow" | "error" = "tools";
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
        const body = await request.json() as { model: string; tools: unknown[]; messages: { role: string }[] };
        expect(body.model).toBe("test-model");
        expect(body.tools.length).toBe(5);
        requests++;
        if (mode === "error") return new Response("offline", { status: 503 });
        if (mode === "slow") {
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
          } }), { headers: { "Content-Type": "text/event-stream" } });
        }
        const toolResults = body.messages.filter((message) => message.role === "tool").length;
        const name = toolResults === 0 ? "search_library" : "play_tracks";
        const input = toolResults === 0 ? { query: "first" } : { tracks: [tracks[0]], append: false };
        const delta = toolResults < 2
          ? { tool_calls: [{ index: 0, id: `call-${toolResults}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] }
          : { content: "Playing First song." };
        const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
          id: "chat-test", object: "chat.completion.chunk", created: 1, model: "test-model",
          choices: [{ index: 0, delta, finish_reason }],
        });
        return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, toolResults < 2 ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const config = configSchema.parse({ llm: { base_url: `${server.url}v1`, model: "test-model" }, music: { library: root } });
    const agent = new MusicAgent(config, library, player);
    ui = await createTestRenderer({ width: 80, height: 20 });
    let quit = false;
    const app = mountUI(ui.renderer, agent, "test-model", () => { quit = true; });
    await app.submit("play the first song");
    expect(requests).toBe(3);
    await ui.renderOnce();
    const responseFrame = ui.captureCharFrame();
    expect(responseFrame).toContain("Playing First song.");
    expect(responseFrame.indexOf("play_tracks:")).toBeLessThan(responseFrame.indexOf("Playing First song."));
    await waitForTrack(player, join(root, tracks[0]!));
    expect((await player.status()).current).toBe(join(root, tracks[0]!));
    await app.submit("/pause");
    expect((await player.status()).paused).toBe(true);
    await app.submit(`/add ${tracks[1]}`);
    expect((await player.status()).queue).toHaveLength(2);
    await app.submit("/play Artist");
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Choose an exact path");
    expect(requests).toBe(3);

    mode = "slow";
    const active = app.submit("find more music");
    for (let attempt = 0; requests < 4 && attempt < 100; attempt++) await Bun.sleep(10);
    expect(requests).toBe(4);
    await app.submit("/stop");
    await active;
    expect(agent.busy).toBe(false);
    expect((await player.status()).queue).toHaveLength(0);

    mode = "error";
    await app.submit("hello");
    await app.submit("/volume 22");
    expect((await player.status()).volume).toBe(22);
    await ui.mockInput.typeText("/help");
    ui.mockInput.pressEnter();
    await Bun.sleep(50);
    expect(app.input.value).toBe("");
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("/library");
    await Bun.write(join(root, "Artist/Second song.WAV"), silence());
    await app.submit("/scan");
    expect(library.tracks).toHaveLength(3);
    await app.submit(`/play ${tracks[1]}`);
    await waitForTrack(player, join(root, tracks[1]!));
    ui.resize(40, 12);
    await ui.renderOnce();
    const narrow = ui.captureCharFrame();
    expect(narrow).toContain("ai-joker");
    expect(narrow).toContain("Ask for music or /help");
    ui.mockInput.pressCtrlC();
    expect(quit).toBe(true);

    const secondRoot = join(dir, "music-other");
    await mkdir(join(secondRoot, "Artist"), { recursive: true });
    await Bun.write(join(secondRoot, tracks[0]!), silence());
    const multiple = new Library([root, secondRoot]);
    expect(await multiple.scan()).toEqual({ total: 4 });
    const multiAgent = new MusicAgent({ ...config, music: { libraries: [root, secondRoot] } }, multiple, player);
    ui.renderer.destroy();
    ui = await createTestRenderer({ width: 80, height: 20 });
    const multiApp = mountUI(ui.renderer, multiAgent, "test-model", () => {});
    await multiApp.submit(`/play [2]/${tracks[0]}`);
    await waitForTrack(player, join(secondRoot, tracks[0]!));
    expect(await multiAgent.command("/queue")).toContain(`[2]/${tracks[0]}`);
    await multiApp.submit("/queue");
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain(`Playing | [2]/${tracks[0]}`);
    expect(requests).toBe(6); // Three tool-loop requests, one cancelled request, and two failed attempts.
    await player.close();
    await player.close();
    await expect(player.status()).rejects.toThrow("not running");
  } finally {
    ui?.renderer.destroy();
    server?.stop(true);
    await player.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
