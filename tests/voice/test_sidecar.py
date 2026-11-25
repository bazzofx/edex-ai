"""Voice sidecar checks without a microphone.

1. Round trip: Piper speaks a command, the audio is resampled to 16 kHz and faster-whisper
   transcribes it (tests STT + TTS models, no mic needed).
2. Protocol: start sidecar.py as a subprocess, wait for "ready", ask it to speak, expect
   speak_start (with firstAudioMs) and speak_done, then barge-in with "stop" on a long text.

Run: python tests/voice/test_sidecar.py
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "voice"))
import sidecar  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}", flush=True)


def round_trip():
    voice = sidecar.find_voice("", [Path(os.environ.get("LOCALAPPDATA", "")) / "Luci" / "voices"])
    check("a Piper voice is installed", voice is not None, str(voice))
    if not voice:
        return
    from piper import PiperVoice
    v = PiperVoice.load(str(voice))
    phrase = "Open YouTube and search for black hole documentaries."
    chunks = list(v.synthesize(phrase))
    audio = np.concatenate([c.audio_float_array for c in chunks]).astype("float32")
    sr = chunks[0].sample_rate
    # Linear resample to 16 kHz
    n = int(len(audio) * sidecar.SAMPLE_RATE / sr)
    audio16 = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype("float32")
    t = time.perf_counter()
    stt = sidecar.Transcriber("base", "cpu", "int8", "en")
    load = time.perf_counter() - t
    t = time.perf_counter()
    text = stt.transcribe(audio16)
    ms = (time.perf_counter() - t) * 1000
    norm = text.lower().replace("-", " ")
    ok = "youtube" in norm and "black hole" in norm
    check("faster-whisper transcribes Piper speech", ok, f"{text!r} in {ms:.0f} ms ({len(audio16)/16000:.1f} s audio, model load {load:.1f} s)")


def protocol():
    p = subprocess.Popen([sys.executable, "-u", str(ROOT / "voice" / "sidecar.py")],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         text=True, encoding="utf-8")
    events = []
    lock = threading.Condition()

    def read():
        for line in p.stdout:
            with lock:
                events.append(json.loads(line))
                lock.notify_all()

    threading.Thread(target=read, daemon=True).start()

    def wait(pred, timeout):
        end = time.time() + timeout
        with lock:
            while time.time() < end:
                for e in events:
                    if pred(e):
                        return e
                lock.wait(0.2)
        return None

    def send(obj):
        p.stdin.write(json.dumps(obj) + "\n")
        p.stdin.flush()

    try:
        ready = wait(lambda e: e["event"] == "status" and e["state"] in ("ready", "error"), 90)
        check("sidecar starts and reports ready", ready and ready["state"] == "ready", json.dumps(ready))
        send({"cmd": "speak", "id": "t1", "text": "Voice check."})
        start = wait(lambda e: e["event"] == "speak_start" and e["id"] == "t1", 20)
        check("speech starts with a first-audio time", start is not None, json.dumps(start))
        done = wait(lambda e: e["event"] == "speak_done" and e["id"] == "t1", 20)
        check("speech finishes", done is not None and not done["interrupted"] and not done["error"], json.dumps(done))
        send({"cmd": "speak", "id": "t2", "text": "This is a much longer sentence that should be cut off before it ends because we test barge in."})
        wait(lambda e: e["event"] == "speak_start" and e["id"] == "t2", 20)
        time.sleep(0.4)
        send({"cmd": "stop"})
        done2 = wait(lambda e: e["event"] == "speak_done" and e["id"] == "t2", 10)
        check("stop interrupts speech (barge-in)", done2 is not None and done2["interrupted"], json.dumps(done2))
        send({"cmd": "mute", "muted": True})
        send({"cmd": "ptt_start"})
        err = wait(lambda e: e["event"] == "error" and "muted" in e["message"], 5)
        check("muted microphone refuses to record", err is not None, json.dumps(err))
        send({"cmd": "quit"})
        p.wait(10)
        check("sidecar exits on quit", p.returncode == 0, f"exit {p.returncode}")
    finally:
        if p.poll() is None:
            p.kill()


if __name__ == "__main__":
    round_trip()
    protocol()
    print(f"\n{sum(results)}/{len(results)} voice checks passed")
    sys.exit(0 if all(results) else 1)
