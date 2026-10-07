<p align="center">
  <img src="assets/logo.svg" alt="ai-joker: a grinning cassette DJ in jester headphones" width="600">
</p>

# ai-joker

A local music agent with an OpenTUI chat interface, AI SDK tool calling, and mpv playback. Runs on Bun with Linux or macOS Unix sockets.

<p align="center">
  <img src="assets/screenshot.png" alt="ai-joker terminal chat browsing the music library and playing tracks" width="1000">
</p>

## Run

Install [Bun](https://bun.sh) and `mpv`, then:

```sh
bun install
# Edit config.toml with your API URL, model, and music library path.
bun start
# Or use a separate config:
bun start ./config.local.toml
```

The model must support OpenAI-compatible chat completions, streaming, and tool calling. `base_url` is the API root, usually ending in `/v1`, not `/chat/completions`. For example, OpenAI uses `https://api.openai.com/v1` with a model such as `gpt-4o-mini`.

Set the key in `.env`, which Bun loads automatically:

```sh
OPENAI_API_KEY=your-key
```

`llm.api_key_env` selects the environment variable. `llm.api_key` can set a key directly, but don't commit it. Local servers can run without a key. Relative library paths resolve from the config's directory; `~/` expands to your home.

Configure one or more music directories:

```toml
[music]
libraries = ["~/Music", "/mnt/music", "../albums"]
```

The old `library = "~/Music"` setting still works. Use either `library` or `libraries`, not both. With multiple directories, track paths include a numbered prefix, such as `[2]/Artist/song.flac`. The welcome message lists the corresponding directories. Use the full returned path for `/play` or `/add` when filenames collide. Duplicate directories and overlapping files are indexed only once, using the first directory that contains the file.

## Chat and controls

Try "play some Miles Davis" or "find ambient music and queue three tracks". The agent searches filenames and folders, then plays exact library paths through mpv. It can rescan, replace or append a queue, and control playback. Tool calls and results appear in the chat.

For broad requests, the agent uses `ls_library` to list folders and track counts, then calls it again with a folder ID to see titles. It can call the tool repeatedly with different folders or the returned `next_offset`. Each reply contains at most 100 entries and 6,000 characters of catalog text, defaulting to 40 entries. These are character limits, not exact token counts; multiple replies still add to the conversation context. The existing eight-step limit bounds each chat turn.

Listings use IDs such as `S1:F2` for folders and `S1:T42` for tracks. The agent can pass track IDs directly to `play_tracks`; `/play` and `/add` accept them too. A rescan invalidates old IDs rather than letting them select different songs. `search_library` still handles specific queries. The listing tool only reads the scanned catalog, not arbitrary filesystem paths or shell commands.

| Command | What it does |
| --- | --- |
| `/library [query]` | Search, showing up to 30 matches |
| `/scan` | Rescan the music directory |
| `/play <path or query>` | Replace the queue and play a unique match |
| `/add <path or query>` | Append a unique match, starting playback if idle |
| `/pause`, `/resume`, `/toggle` | Pause controls |
| `/stop` | Stop and clear the queue |
| `/next`, `/prev` | Move through the queue |
| `/queue` | List the mpv queue |
| `/volume <0-100>` | Set volume |
| `/seek <seconds>` | Seek relative to the current position, negative goes back |
| `/cancel` | Cancel the LLM request without stopping music |
| `/help`, `/quit` | Help or exit |

Use exact relative paths when a query matches multiple tracks. Paths with spaces do not need quotes. Slash commands cancel an active LLM request and do not call the API, so playback controls work while the server is unavailable. Escape cancels chat. Page Up/Down or the mouse wheel scrolls. Ctrl+C exits and stops this app's mpv process.

The app scans every configured directory recursively at startup and on `/scan`. A missing or unreadable directory fails the scan without replacing the previous index. It skips symlinks, macOS `._*` metadata files, and `__MACOSX` directories, and accepts MP3, FLAC, WAV, OGG, Opus, M4A, AAC, AIFF, ALAC, WMA, APE, and WavPack files. Search uses filenames, not audio tags. Playback rejects unscanned paths and paths resolving outside the library. mpv runs without your personal config or video output. When starting playback, the app waits for mpv to start playing before returning success. Invalid files and audio-output failures appear in the chat and player status, including failures in later queued tracks. A successful playback start clears the status error.

Chat history stays in memory for this session. Requests include your chat and tool results, including relative filenames, so only use an API you trust. Nothing uploads audio files.

## Checks

```sh
bun test
bun llm-library-tracks.js --self-test
bun run typecheck
```

The integration check uses a local mock API and real mpv with a null audio output. It skips if mpv is not installed. No API key or sound device is needed.
