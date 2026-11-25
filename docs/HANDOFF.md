# eDEX AI — handoff (2026-11-25)

Plan: `C:\Users\joker\.claude\plans\pasted-content-id-110f-edex-ai-ethereal-bunny.md` (approved).
Repo: `C:\_web_apps_2025\eDexUI_AI\edex-ai`, branch `edex-ai` (local only, no remote push).
Installed original binary for visual comparison: `..\eDEX-UI\` (untouched).

## Done
- **M0** (`8e48aa0`): Electron 45.3.0, node-pty 1.1 (prebuilt, no rebuild), @xterm 5.5, ws 8, systeminformation 5.33;
  `@electron/remote` replaced by `src/bridge/legacyRemote.js` + `src/main/legacyBridge.js`; terminal sockets on 127.0.0.1
  with per-launch token + `file://` origin check (upstream was LAN-exposed); update check / external IP lookups opt-in;
  `--dev` windowed mode; `EDEXAI_HOME` settings override; DOM terminal renderer (WebGL opt-in `termWebGL`, it misrenders on GTX 1070).
- **M1** (`28a2c74`): `src/main/browser.js` sandboxed WebContentsView tabs, `src/security/urlPolicy.js`, browser panel
  (`src/classes/browserPanel.class.js`, `mod_browser.css`), TERM/SPLIT/WEB layouts, zod IPC (`src/main/ipc.js`).
- **M2** (committed with this file): tool registry (`src/tools/`), OpenRouter + Ollama providers (`src/ai/providers/`),
  orchestrator (`src/ai/orchestrator.js`), assistant service (`src/main/assistant.js`), assistant panel
  (`src/classes/assistantPanel.class.js`, `mod_assistant.css`), config (`src/config/edex-ai.example.json` -> `<userData>/edex-ai.json`),
  benchmark `scripts/bench.mjs`.
  - Model: `nvidia/nemotron-3.5-lightning:free` 12/12 bench, median TTFT 725 ms, turn 1.7 s. gemma-4 / ling free models
    returned 429 upstream; super-vl 11/12 but ~20 s TTFT. Results in `docs/bench-2026-11-25-openrouter.json`.
  - API key: env `apiOpenRouterEDEXAI` (user scope); app falls back to reading `HKCU\Environment` (`src/config/config.js`).
  - M2 smoke with real LLM passed 12/12 (example command 6.1 s end to end; file:// refused; cancel works).
- **CPU fix (uncommitted work now committed, not fully verified)**: upstream's per-core systeminformation cluster pinned the CPU at
  100% (~30 powershell.exe). Replaced by `src/main/siService.js` (one persistent PowerShell, shared cache, allowlist);
  `src/_multithread.js` rewritten. Measured total CPU 26–35% with the app running (was 100%).

## Next steps (in order)
1. **Fix the M0 smoke failure after the siService change**: "telemetry widgets show live values" failed once.
   Run `node tests/smoke/launch.mjs --only=m0 --keep`, then `node scripts/dev/cdp-eval.mjs "document.querySelector('#mod_toplist').innerText"`
   (and cpuinfo/ramwatcher) to see which widget is empty. Suspects: `processes` interval, the renderer passing a
   callback arg, or a widget calling an si function not in `MIN_INTERVAL` (allowlist in `src/main/siService.js`).
2. EPIPE on quit came from the old cluster workers; confirm it is gone with the new service.
3. Re-run all checks: `npm test` (29 unit tests) and `node tests/smoke/launch.mjs` (m0+m1+m2).
4. **M3 voice**: `voice/sidecar.py` (port Kairo code: `C:\_web_apps_2025\kairo\docs\voice-tts-handoff.md`; Piper 1.8 +
   faster-whisper 1.2.1 already installed), WebSocket on 127.0.0.1 + token + origin check; `src/main/voice.js` to manage
   the subprocess and register IPC `edexai:voice:ptt|mute|stop` (the panel already calls these; currently no handler,
   which logs "No handler registered"). Status must add `voice` + `pttKey` to `edexai:assistant:status`.
   Push-to-talk: press -> stop TTS (barge-in) -> record; release -> transcribe (vad_filter) -> `orchestrator.handle(text, {source:"voice"})`;
   use `orchestrator.answerPendingByVoice` for spoken yes/no; pass `speech` {speak, stop} to the Orchestrator.
   Import numpy/onnxruntime/ctranslate2 on the main thread before any stdin reader (Kairo fix #1). Log latency numbers.
5. README (setup, env var, models/voices, demo, measured latency table, cloud-LLM note), `scripts/setup.ps1`, `scripts/pick-models.mjs`.
6. Later: wake word (openWakeWord), renderer contextIsolation migration, packaging.

## Useful commands
- Run app: `npm start` (from repo root). Unit tests: `npm test`. Smoke: `node tests/smoke/launch.mjs [--only=m0,m1,m2] [--keep]`.
- Benchmark: `node scripts/bench.mjs --provider=openrouter --models=<id,id>` (or `--provider=ollama`).
- Stop a kept smoke app with the task stop / Ctrl+C on that run — never kill all electron.exe (other apps use it).
