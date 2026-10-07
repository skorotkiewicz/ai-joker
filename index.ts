import {
  BoxRenderable, createCliRenderer, InputRenderable, InputRenderableEvents,
  ScrollBoxRenderable, TextRenderable, type CliRenderer,
} from "@opentui/core";
import { help, MusicAgent } from "./agent";
import { Library, loadConfig, Player } from "./music";

export function mountUI(renderer: CliRenderer, agent: MusicAgent, model: string, quit: () => void) {
  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
  const header = new TextRenderable(renderer, {
    content: `ai-joker | ${model} | ${agent.library.tracks.length} tracks`, height: 1, flexShrink: 0,
    fg: "#d7bb74", wrapMode: "none",
  });
  const playback = new TextRenderable(renderer, { content: "Stopped", height: 1, flexShrink: 0, fg: "#9fc085", wrapMode: "none" });
  const chat = new ScrollBoxRenderable(renderer, {
    flexGrow: 1, minHeight: 0, stickyScroll: true, stickyStart: "bottom",
    contentOptions: { flexDirection: "column" },
  });
  const entry = new BoxRenderable(renderer, { height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: "#262b26" });
  const input = new InputRenderable(renderer, {
    flexGrow: 1, placeholder: "Ask for music or /help", maxLength: 4000,
    textColor: "#deded2", focusedBackgroundColor: "#262b26", cursorColor: "#d7bb74",
  });
  entry.add(new TextRenderable(renderer, { content: "> ", width: 2, fg: "#d7bb74" }));
  entry.add(input);
  root.add(header);
  root.add(playback);
  root.add(chat);
  root.add(entry);
  root.add(new TextRenderable(renderer, {
    content: "/help  /pause  /stop  /next | PgUp/PgDn scroll | Esc cancel | Ctrl+C quit",
    height: 1, flexShrink: 0, fg: "#889385", wrapMode: "none",
  }));
  renderer.root.add(root);
  input.focus();

  let closed = false;
  let chatJob: Promise<void> | undefined;
  let commands = Promise.resolve();
  let commandCount = 0;
  let polling = false;
  const add = (role: string, text: string) => {
    if (closed) return;
    const node = new TextRenderable(renderer, {
      content: `${role}> ${text}`, width: "100%", flexShrink: 0, wrapMode: "word",
      fg: role === "you" ? "#d7bb74" : role === "agent" ? "#deded2" : "#889385",
    });
    chat.add(node);
    return node;
  };
  add("system", `Libraries:\n${agent.library.roots.map((root, index) => `[${index + 1}] ${root}`).join("\n")}\n${help}`);

  const onPlaybackError = (message: string) => { add("error", message); };
  agent.player.on("playback-error", onPlaybackError);

  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const state = await agent.player.status();
      if (!closed) {
        playback.content = state.error ? `Player error: ${state.error}`
          : `${state.current ? state.paused ? "Paused" : "Playing" : "Stopped"} | ${state.current ? agent.library.label(state.current) : "No track"} | vol ${Math.round(state.volume)} | queue ${state.queue.length}`;
        header.content = `ai-joker | ${model} | ${agent.library.tracks.length} tracks${agent.busy ? " | thinking" : ""}`;
      }
    } catch (error) {
      if (!closed) playback.content = `Player error: ${error instanceof Error ? error.message : String(error)}`;
    } finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), 1000);
  void poll();

  const submit = (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text || closed) return Promise.resolve();
    if (text === "/quit" || text === "/exit") { quit(); return Promise.resolve(); }
    if (text.startsWith("/")) {
      agent.cancel();
      commandCount++;
      commands = commands.then(async () => {
        await chatJob;
        if (closed) return;
        add("you", text);
        try { add("system", await agent.command(text)); }
        catch (error) { add("error", error instanceof Error ? error.message : String(error)); }
        await poll();
      }).finally(() => { commandCount--; });
      return commands;
    }
    if (agent.busy || commandCount) {
      add("system", "Wait for the current request, or use /cancel. Playback commands still work.");
      input.value = text;
      return Promise.resolve();
    }
    add("you", text);
    let reply: TextRenderable | undefined;
    let answer = "";
    chatJob = (async () => {
      try {
        await agent.chat(text, (delta) => {
          answer += delta;
          if (!closed) {
            reply ??= add("agent", "");
            if (reply) reply.content = `agent> ${answer}`;
          }
        }, (name, result) => {
          reply = undefined;
          answer = "";
          if (!closed) add("tool", result === undefined ? name : `${name}: ${JSON.stringify(result).slice(0, 1500)}`);
        });
        if (!answer && !closed) add("agent", "See tool results above.");
      } catch (error) {
        if (!closed) {
          const message = error instanceof Error ? error.message : String(error);
          add("system", error instanceof Error && error.name === "AbortError" ? "Cancelled." : `LLM error: ${message}. Slash commands still work.`);
        }
      }
      await poll();
    })();
    return chatJob;
  };
  input.on(InputRenderableEvents.ENTER, (text: string) => {
    input.value = "";
    void submit(text);
  });
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") quit();
    else if (key.name === "escape") agent.cancel();
    else if (key.name === "pageup") chat.scrollBy(-1, "viewport");
    else if (key.name === "pagedown") chat.scrollBy(1, "viewport");
  });
  renderer.on("destroy", () => {
    closed = true;
    clearInterval(timer);
    agent.player.off("playback-error", onPlaybackError);
    agent.cancel();
  });
  return { input, submit };
}

async function main() {
  const config = await loadConfig(process.argv[2]);
  const library = new Library(config.music.libraries);
  await library.scan();
  const player = new Player();
  let renderer: CliRenderer | undefined;
  let quit = () => {};
  try {
    await player.start(config.player.binary);
    renderer = await createCliRenderer({
      exitOnCtrlC: false, exitSignals: [], consoleMode: "disabled", backgroundColor: "#161916",
    });
    const finished = new Promise<void>((resolve) => { quit = resolve; });
    for (const signal of signals) process.on(signal, quit);
    const agent = new MusicAgent(config, library, player);
    mountUI(renderer, agent, config.llm.model, quit);
    await finished;
  } finally {
    for (const signal of signals) process.off(signal, quit);
    renderer?.destroy();
    await player.close();
  }
}

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
