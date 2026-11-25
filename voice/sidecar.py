"""eDEX AI voice sidecar: push-to-talk speech-to-text (faster-whisper) and text-to-speech (Piper).

Runs as a child process of the Electron main process and talks JSON lines over stdin/stdout:
no network socket is opened. stdout carries protocol messages only; logs go to stderr.

Commands (one JSON object per line on stdin):
  {"cmd": "ptt_start"}                 stop any speech (barge-in), start recording
  {"cmd": "ptt_stop"}                  stop recording, transcribe, emit "transcript"
  {"cmd": "ptt_cancel"}                stop recording and drop the audio
  {"cmd": "speak", "id": "x", "text": "..."}
  {"cmd": "stop"}                      stop speech now, drop the queue
  {"cmd": "mute", "muted": true}       refuse to record while muted
  {"cmd": "status"}
  {"cmd": "quit"}

Events (stdout):
  {"event": "status", "state": "loading|ready|error", "stt": ..., "tts": ..., "detail": ...}
  {"event": "recording", "on": true|false}
  {"event": "transcript", "text": "...", "sttMs": 812, "audioSec": 2.4}
  {"event": "speak_start", "id": "x", "firstAudioMs": 640}
  {"event": "speak_done", "id": "x", "interrupted": false, "error": null}
  {"event": "error", "message": "..."}

Raw audio is kept in memory only and discarded after transcription.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path

# Import compiled extensions on the main thread BEFORE starting the stdin reader thread:
# on Windows a thread blocked on a stdin pipe can make another thread's native import hang.
import numpy as np  # noqa: E402
import sounddevice as sd  # noqa: E402

SAMPLE_RATE = 16000
MAX_RECORD_SECONDS = 30
_out_lock = threading.Lock()


def emit(event: str, **data) -> None:
    line = json.dumps({"event": event, **data}, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"[voice] {msg}\n")
    sys.stderr.flush()


# ── Recording ────────────────────────────────────────────────────────────────
class Recorder:
    def __init__(self, device=None) -> None:
        self.device = device
        self.max_samples = MAX_RECORD_SECONDS * SAMPLE_RATE
        self._lock = threading.Lock()
        self._frames: list[np.ndarray] = []
        self._count = 0
        self._stream = None
        self.active = False

    def start(self) -> None:
        with self._lock:
            self._frames, self._count = [], 0
        self.active = True
        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                      device=self.device, callback=self._cb, blocksize=1024)
        self._stream.start()

    def _cb(self, indata, frames, time_info, status) -> None:
        if not self.active:
            return
        with self._lock:
            if self._count < self.max_samples:
                self._frames.append(indata[:, 0].copy())
                self._count += frames

    def stop(self) -> np.ndarray | None:
        self.active = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None
        with self._lock:
            audio = np.concatenate(self._frames) if self._frames else None
            self._frames, self._count = [], 0
        return audio


# ── Speech to text ───────────────────────────────────────────────────────────
PROMPT = ("eDEX. Open YouTube, search for, switch to split view, browser, terminal, new tab, close tab, "
          "go back, pause the video, system stats, CPU, memory, Wikipedia, GitHub.")


class Transcriber:
    def __init__(self, model: str, device: str, compute_type: str, language: str | None) -> None:
        from faster_whisper import WhisperModel
        self.language = language or None
        self.model = WhisperModel(model, device=device, compute_type=compute_type)

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _ = self.model.transcribe(
            audio, language=self.language, beam_size=5, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            initial_prompt=PROMPT, condition_on_previous_text=False,
        )
        return "".join(s.text for s in segments).strip()


# ── Text to speech ───────────────────────────────────────────────────────────
class Speaker:
    """Piper TTS with a worker thread. stop() cuts the current reply and drops queued ones."""

    def __init__(self, voice_path: Path, device=None, speed: float = 1.0) -> None:
        from piper import PiperVoice
        self.voice = PiperVoice.load(str(voice_path))
        self.device = device
        self.speed = speed
        self._queue: queue.Queue = queue.Queue()
        self._generation = 0
        self.speaking = False
        threading.Thread(target=self._run, daemon=True).start()

    def warm_up(self) -> None:
        for _ in self.voice.synthesize("Ready."):
            pass

    def say(self, sid: str, text: str) -> None:
        self._queue.put((self._generation, sid, " ".join(text.split()), time.perf_counter()))

    def stop(self) -> None:
        self._generation += 1
        try:
            sd.stop()
        except Exception:  # noqa: BLE001
            pass

    def _run(self) -> None:
        from piper import SynthesisConfig
        while True:
            gen, sid, text, queued_at = self._queue.get()
            if gen != self._generation:
                emit("speak_done", id=sid, interrupted=True, error=None)
                continue
            stopped = lambda g=gen: g != self._generation  # noqa: E731
            self.speaking = True
            first = None
            error = None
            try:
                cfg = SynthesisConfig(length_scale=1.0 / max(0.5, self.speed))
                for chunk in self.voice.synthesize(text, syn_config=cfg):
                    if stopped():
                        break
                    audio = chunk.audio_float_array.astype("float32")
                    sd.play(audio, chunk.sample_rate, device=self.device)
                    if first is None:
                        first = (time.perf_counter() - queued_at) * 1000
                        emit("speak_start", id=sid, firstAudioMs=round(first))
                    while sd.get_stream().active:
                        if stopped():
                            sd.stop()
                            break
                        time.sleep(0.03)
            except Exception as e:  # noqa: BLE001 - a failed reply must not kill the worker
                error = str(e)
            finally:
                self.speaking = False
            emit("speak_done", id=sid, interrupted=stopped(), error=error)


def find_voice(name: str, dirs: list[Path]) -> Path | None:
    candidates = [name] if name else ["en_US-ryan-high", "en_US-hifi_tts_92-medium", "en_US-lessac-medium"]
    for d in dirs:
        for n in candidates:
            p = d / f"{n}.onnx"
            if p.exists() and Path(f"{p}.json").exists():
                return p
        if not name:
            for p in sorted(d.glob("*.onnx")):
                if Path(f"{p}.json").exists():
                    return p
    return None


# ── Main loop ────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--whisper-model", default="base")
    ap.add_argument("--whisper-device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--language", default="en")
    ap.add_argument("--voice", default="", help="Piper voice name (file stem)")
    ap.add_argument("--voice-dir", action="append", default=[])
    ap.add_argument("--input-device", default=None)
    ap.add_argument("--output-device", default=None)
    args = ap.parse_args()

    def dev(v):
        if v in (None, "", "null"):
            return None
        return int(v) if str(v).isdigit() else v

    emit("status", state="loading", stt=None, tts=None, detail="loading speech models")
    t0 = time.perf_counter()
    stt = tts = None
    problems = []
    try:
        stt = Transcriber(args.whisper_model, args.whisper_device, args.compute_type, args.language)
    except Exception as e:  # noqa: BLE001
        problems.append(f"speech-to-text: {e}")
    voice_dirs = [Path(p) for p in args.voice_dir] + [Path(os.environ.get("LOCALAPPDATA", "")) / "Luci" / "voices"]
    voice_path = find_voice(args.voice, [d for d in voice_dirs if d.is_dir()])
    if voice_path is None:
        problems.append("text-to-speech: no Piper voice found (see README: Voice setup)")
    else:
        try:
            tts = Speaker(voice_path, device=dev(args.output_device))
            tts.warm_up()
        except Exception as e:  # noqa: BLE001
            tts = None
            problems.append(f"text-to-speech: {e}")
    recorder = Recorder(device=dev(args.input_device))
    load_ms = round((time.perf_counter() - t0) * 1000)
    log(f"models loaded in {load_ms} ms (voice: {voice_path.name if voice_path else 'none'})")

    state = "ready" if stt else "error"
    emit("status", state=state, stt=args.whisper_model if stt else None,
         tts=voice_path.stem if tts else None, detail="; ".join(problems) or f"loaded in {load_ms} ms")

    muted = False
    commands: queue.Queue = queue.Queue()

    def reader() -> None:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                commands.put(json.loads(raw))
            except json.JSONDecodeError:
                emit("error", message="bad command line")
        commands.put({"cmd": "quit"})

    threading.Thread(target=reader, daemon=True).start()

    while True:
        msg = commands.get()
        cmd = msg.get("cmd")
        try:
            if cmd == "ptt_start":
                if tts:
                    tts.stop()  # barge-in: never record our own voice
                if muted:
                    emit("error", message="microphone is muted")
                elif not stt:
                    emit("error", message="speech-to-text is not available: " + "; ".join(problems))
                elif not recorder.active:
                    recorder.start()
                    emit("recording", on=True)
            elif cmd in ("ptt_stop", "ptt_cancel"):
                if not recorder.active:
                    continue
                audio = recorder.stop()
                emit("recording", on=False)
                if cmd == "ptt_cancel":
                    continue
                seconds = 0.0 if audio is None else len(audio) / SAMPLE_RATE
                if seconds < 0.3:
                    emit("transcript", text="", sttMs=0, audioSec=round(seconds, 2))
                    continue
                t = time.perf_counter()
                text = stt.transcribe(audio)
                del audio
                emit("transcript", text=text, sttMs=round((time.perf_counter() - t) * 1000), audioSec=round(seconds, 2))
            elif cmd == "speak":
                if not tts:
                    emit("speak_done", id=msg.get("id"), interrupted=False, error="text-to-speech is not available")
                else:
                    tts.say(str(msg.get("id")), str(msg.get("text", ""))[:2000])
            elif cmd == "stop":
                if tts:
                    tts.stop()
            elif cmd == "mute":
                muted = bool(msg.get("muted"))
                if muted and recorder.active:
                    recorder.stop()
                    emit("recording", on=False)
            elif cmd == "status":
                emit("status", state=state, stt=args.whisper_model if stt else None,
                     tts=voice_path.stem if tts else None, detail="; ".join(problems) or "ready")
            elif cmd == "quit":
                if recorder.active:
                    recorder.stop()
                if tts:
                    tts.stop()
                return 0
        except Exception as e:  # noqa: BLE001 - report and keep serving
            if recorder.active and cmd != "ptt_start":
                recorder.stop()
                emit("recording", on=False)
            emit("error", message=f"{cmd}: {e}")


if __name__ == "__main__":
    sys.exit(main())
