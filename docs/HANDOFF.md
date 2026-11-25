# eDEX AI — handoff

Last update: 2026-11-25. Remote: https://github.com/bazzofx/edex-ai (`main`). `upstream` remote = GitSquared/edex-ui.

## Status: M0–M3 done (initial deliverable complete)
- **M0** modernization: Electron 45.3, node-pty 1.1, @xterm 5.5 (DOM renderer; WebGL opt-in `termWebGL`), ws 8,
  `@electron/remote` replaced by `src/bridge/legacyRemote.js` + `src/main/legacyBridge.js`, terminal sockets locked down,
  systeminformation via one cached service (`src/main/siService.js`; no `si.powerShellStart()`, it hangs `processes()`).
- **M1** browser: `src/main/browser.js`, `src/security/urlPolicy.js`, `src/classes/browserPanel.class.js`.
- **M2** assistant: `src/tools/`, `src/ai/` (orchestrator + OpenRouter/Ollama), `src/main/assistant.js`, assistant panel.
- **M3** voice: `voice/sidecar.py` (stdin/stdout JSON lines, faster-whisper + Piper), `src/main/voice.js`, F8 push-to-talk,
  barge-in, mute, spoken yes/no for confirmations.
- Checks: `npm test` 29/29, `python tests/voice/test_sidecar.py` 8/8, `node tests/smoke/launch.mjs` 51/51.
- Measured numbers: README → "Measured".

## Next steps
1. **Wake word** (openWakeWord) in the sidecar, opt-in, with echo handling (mute while speaking, or AEC).
2. **Streaming TTS**: speak the first sentence while the rest is generated (now the full reply is spoken after the LLM finishes).
3. **Renderer migration** to `contextIsolation` + `src/bridge/edexai.js` as a contextBridge preload; remove Node from the UI.
4. Optional advanced page interaction (pick/play a specific video): needs reliable page automation; keep page text untrusted.
5. Packaging (`npm run prebuild-windows && npm run build-windows`) and bundling/locating Python for the voice sidecar.
6. Cold voice-model load takes 16–25 s; consider a smaller Whisper (`tiny.en`) or loading STT lazily.

## Gotchas
- Free OpenRouter models often return 429 from their upstream provider; `nemotron-3.5-lightning:free` was reliable on 2026-11-25.
- The OpenRouter key env var may be set at user scope after the shell started; the app also reads `HKCU\Environment`.
- Stop a kept smoke run with Ctrl+C on that run (it kills only its own process tree) — never kill all `electron.exe`.
- Python packages may live in user site-packages: don't run the sidecar with `python -I`.
