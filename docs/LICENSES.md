# Licenses and provenance

eDEX AI is a fork of **eDEX-UI** by Gabriel "Squared" Saillard.

| Item | Source | License | Notes |
| --- | --- | --- | --- |
| eDEX-UI (base code, themes, sounds, fonts bundle) | https://github.com/GitSquared/edex-ui @ `04a00c4` (v2.2.8, archived Oct 2021) | GPL-3.0 | The whole fork stays GPL-3.0. Check bundled font licenses under `src/assets/fonts` before redistribution. |
| Electron 45 | npm `electron` | MIT (Chromium: BSD + others) | No Widevine / proprietary codecs in stock builds. |
| xterm.js 5.5 + addons | npm `@xterm/*` | MIT | |
| node-pty 1.1 | npm `node-pty` | MIT | Prebuilt N-API binaries, no rebuild needed. |
| systeminformation 5 | npm | MIT | |
| zod 4 | npm | MIT | |
| Piper TTS (`piper-tts` 1.8) | https://github.com/OHF-Voice/piper1-gpl | GPL-3.0 | Compatible with this GPL-3.0 project. |
| Piper voice models | Hugging Face `rhasspy/piper-voices` | Per voice (see each `MODEL_CARD`) | Some voices are CC BY-NC or carry dataset terms; check before distributing. |
| faster-whisper / Whisper models | https://github.com/SYSTRAN/faster-whisper, OpenAI Whisper weights | MIT | |
| OpenRouter free models | https://openrouter.ai | Per model provider | Cloud service. Free tiers are rate-limited and providers may log prompts; see README. |
| Ollama + local models (optional fallback) | https://ollama.com | MIT (Ollama); per-model licenses | |

The installed eDEX-UI 2.2.8 binary in `..\eDEX-UI\` is kept untouched as the visual baseline.
