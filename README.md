<p align="center"><img alt="eDEX" src="media/logo.png"></p>

# eDEX AI

A voice-controlled fork of [eDEX-UI](https://github.com/GitSquared/edex-ui) (archived 2021): the same sci-fi terminal and
system monitor, plus an embedded Chromium browser and an assistant you can type to or talk to. It opens sites, searches,
switches layouts, reads system stats and answers out loud, and it only claims an action worked when the tool really reported success.

**Status: proof of concept (Windows tested).** Original upstream README: [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md).

## What's in it

| Part | How |
| --- | --- |
| Shell, terminal, telemetry | Upstream eDEX UI, modernized: Electron 45, node-pty 1.1, xterm.js 5.5, systeminformation 5.33 |
| Embedded browser | Electron `WebContentsView` tabs, sandboxed, own session, http(s) only; TERM / SPLIT / WEB layouts |
| Assistant | Typed, validated tools (zod) driven by an LLM: OpenRouter free models by default, local Ollama as fallback |
| Voice | Python sidecar: faster-whisper (speech-to-text, CPU) + Piper (text-to-speech), push-to-talk, barge-in |

## Setup (Windows)

Requirements: Node.js 22+, Python 3.10+, Git. Then, from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

It installs the Node and Python dependencies, downloads the Whisper `base` model (~150 MB) and a Piper voice
(`en_US-ryan-high`, ~120 MB) into `%APPDATA%\eDEX AI\voices`, checks the API key and runs the unit tests.

### LLM provider

- **OpenRouter (default):** create a key at https://openrouter.ai/keys and store it as a user environment variable:
  ```powershell
  [Environment]::SetEnvironmentVariable("apiOpenRouterEDEXAI", "<your key>", "User")
  ```
  The key is read only by the main process (environment first, then the user registry hive), never logged and never
  given to the UI or web pages. Free models are rate-limited and their providers may log prompts.
- **Ollama (offline):** install Ollama and a tool-capable model (e.g. `ollama pull gemma4`), then set `"provider": "ollama"`.

Settings live in `%APPDATA%\eDEX AI\edex-ai.json` (created on first start from
[src/config/edex-ai.example.json](src/config/edex-ai.example.json)): provider and model, tool limits, search provider,
voice options (Python path, Whisper model/device, Piper voice, audio devices, push-to-talk key).

## Use

```powershell
npm start
```

- **BROWSER** tab (top of the terminal) or the TERM / SPLIT / WEB buttons switch layouts; type a URL or a search in the URL bar.
- The **assistant panel** sits where the on-screen keyboard was (KEYBOARD / ASSISTANT swap them).
  Type a command, or **hold F8** (or the HOLD TO TALK button) and speak. REC shows while the mic is recording.
- Try: *"Open YouTube and search for black hole documentaries, then switch to split view"*, *"How busy is my CPU?"*,
  *"Go back"*, *"Pause the video"*, *"Open a new terminal tab"*.
- **CANCEL** (or pressing push-to-talk while it speaks) stops the current action and speech. Actions that already ran are not undone.
- Approved commands (`src/config/approved-commands.json`: ipconfig, ping, nvidia-smi, ollama list) always ask for confirmation
  (APPROVE / DENY, or say "yes" / "no"). The assistant can never run arbitrary shell commands.

## Security model

- Web pages run in sandboxed, context-isolated views with no preload and no Node; they cannot reach `localhost`/`127.x`
  (requests are blocked), cannot navigate to `file:`/`javascript:`/custom schemes, popups only open http(s) tabs,
  downloads are blocked and permissions (camera, mic, location, notifications…) are denied.
- The terminal WebSockets listen on 127.0.0.1 only and require a per-launch token and the app's `file://` origin
  (upstream listened on every interface with no authentication).
- Privileged IPC checks the sender frame and validates every payload; model tool calls are validated and policy-checked
  in code before anything runs. Page titles are passed to the model as untrusted data only.
- The voice sidecar talks over stdin/stdout (no network port). Raw audio stays in memory and is dropped after transcription.
- Outbound lookups from upstream (update check, external IP / GeoIP) are off by default (`updateCheck`, `externalIpLookup` in settings.json).
- Known limitation: the legacy eDEX renderer still has Node access (it only loads the bundled UI). Moving it to
  `contextIsolation` is a planned milestone.

## Measured (GTX 1070 8 GB, Ryzen 5 1600, 64 GB, Windows 10; OpenRouter `nvidia/nemotron-3.5-lightning:free`)

| Step | Result |
| --- | --- |
| LLM time to first token | median 725 ms (12-command benchmark, 12/12 correct tool calls) |
| Typed "YouTube + split view" command, end to end | 6.1 s (3 LLM rounds, page load ~3 s) |
| Speech-to-text, Whisper base int8 CPU | 1.5 s for 3 s of speech |
| Piper first audio | 0.5 s standalone, 1.3 s in app after the reply |
| Spoken "split view + open wikipedia.org" turn | LLM + tools 3.4 s, first audio 1.3 s later |
| Voice models cold load | 16–25 s at startup (background) |
| App CPU load | 10–35 % total (upstream design pinned 100 % with current systeminformation) |

Free-model availability changes; `npm run pick-models` lists current free tool-capable models and
`node scripts/bench.mjs --provider=openrouter --models=a,b` benchmarks them.

## Develop and test

```powershell
npm test                                  # unit tests (URL policy, tools, orchestrator, terminal auth)
python tests\voice\test_sidecar.py        # voice: STT round trip, TTS, barge-in, mute (plays a short phrase)
node tests\smoke\launch.mjs               # full app smoke test over CDP (M0-M3), screenshots in tests\smoke\out
```

The smoke test starts the app with a temporary settings folder (`EDEXAI_HOME`) and a loopback-only debugging port.
Project status and next steps: [docs/HANDOFF.md](docs/HANDOFF.md). Licenses: [docs/LICENSES.md](docs/LICENSES.md).

## License

GPL-3.0, like upstream eDEX-UI by Gabriel "Squared" Saillard. Piper is GPL-3.0; check each voice's model card before redistributing.
