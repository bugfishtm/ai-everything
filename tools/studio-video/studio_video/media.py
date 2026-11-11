"""Media access through ffmpeg / ffprobe: facts about files, video frames, audio samples."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

SR = 44100


class MediaError(Exception):
    pass


def _need(tool: str) -> str:
    p = shutil.which(tool)
    if not p:
        raise MediaError(f"{tool} is not installed")
    return p


_probe_cache: dict[str, dict] = {}


def probe(path: str | Path) -> dict:
    """Duration, picture size, frame rate and sound of a media file."""
    p = Path(path)
    key = f"{p.resolve()}:{p.stat().st_mtime_ns if p.exists() else 0}"
    if key in _probe_cache:
        return _probe_cache[key]
    if not p.is_file():
        raise MediaError(f"file not found: {p}")
    r = subprocess.run([_need("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(p)], capture_output=True, text=True)
    if r.returncode != 0:
        raise MediaError(f"{p.name} is not a media file ffmpeg can read: {(r.stderr or '').strip().splitlines()[-1] if r.stderr.strip() else 'unknown format'}")
    try:
        data = json.loads(r.stdout or "{}")
    except ValueError:
        raise MediaError(f"cannot read {p.name}") from None
    out: dict = {"file": str(p), "duration": 0.0, "video": None, "audio": None, "bytes": p.stat().st_size, "format": (data.get("format") or {}).get("format_name", "")}
    try:
        out["duration"] = float((data.get("format") or {}).get("duration") or 0)
    except ValueError:
        pass
    for s in data.get("streams") or []:
        if s.get("codec_type") == "video" and out["video"] is None and (s.get("disposition") or {}).get("attached_pic", 0) != 1:
            num, _, den = str(s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1").partition("/")
            fps = float(num) / float(den or 1) if float(den or 1) else 0.0
            rot = 0
            for sd in s.get("side_data_list") or []:
                if "rotation" in sd:
                    rot = int(sd["rotation"])
            w, h = int(s.get("width") or 0), int(s.get("height") or 0)
            if abs(rot) in (90, 270):
                w, h = h, w
            out["video"] = {"codec": s.get("codec_name"), "width": w, "height": h, "fps": round(fps, 3), "frames": int(s.get("nb_frames") or 0) or None}
            if not out["duration"] and s.get("duration"):
                out["duration"] = float(s["duration"])
        elif s.get("codec_type") == "audio" and out["audio"] is None:
            out["audio"] = {"codec": s.get("codec_name"), "channels": int(s.get("channels") or 0), "rate": int(s.get("sample_rate") or 0)}
    out["duration"] = round(out["duration"], 3)
    _probe_cache[key] = out
    return out


class VideoReader:
    """Frames of a video file at the timeline's size and frame rate, read forward through one ffmpeg process.

    Asking for an earlier frame (or one far ahead) restarts ffmpeg there, so single frames work too."""

    def __init__(self, path: Path, size: tuple[int, int], fps: float, start: float = 0.0, speed: float = 1.0, fit: str = "cover", background=(0, 0, 0)):
        self.path, self.size, self.fps, self.start, self.speed, self.fit = Path(path), size, fps, float(start), max(0.05, float(speed)), fit
        self.bg = "0x%02x%02x%02x" % tuple(background[:3])
        self.proc: subprocess.Popen | None = None
        self.index = -1                  # index of the frame in self.last
        self.last: Image.Image | None = None
        self.ended = False
        self.frame_bytes = size[0] * size[1] * 3

    def _open(self, index: int) -> None:
        self.close()
        w, h = self.size
        if self.fit == "contain":
            vf = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={self.bg}"
        elif self.fit == "stretch":
            vf = f"scale={w}:{h}"
        else:
            vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
        chain = (f"setpts=PTS/{self.speed}," if abs(self.speed - 1) > 1e-6 else "") + f"fps={self.fps}," + vf + ",setsar=1"
        t_src = self.start + index / self.fps * self.speed
        cmd = [_need("ffmpeg"), "-v", "error", "-nostdin", "-ss", f"{max(0.0, t_src):.4f}", "-i", str(self.path), "-an", "-vf", chain,
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=self.frame_bytes * 2)
        self.index = index - 1
        self.ended = False

    def frame(self, t: float) -> Image.Image:
        """The picture at t seconds after the clip's start (timeline time, the speed is applied)."""
        want = max(0, int(round(t * self.fps)))
        if self.proc is None or want <= self.index - 1 or want > self.index + self.fps * 3:
            if not (want == self.index and self.last is not None):
                self._open(want)
        while self.index < want and not self.ended:
            data = self.proc.stdout.read(self.frame_bytes) if self.proc and self.proc.stdout else b""
            if len(data) < self.frame_bytes:
                self.ended = True
                break
            self.last = Image.frombuffer("RGB", self.size, data, "raw", "RGB", 0, 1).copy()
            self.index += 1
        if self.last is None:
            raise MediaError(f"{self.path.name}: no picture at {self.start + t * self.speed:.2f}s (the file is {probe(self.path)['duration']:.2f}s long)")
        return self.last

    def close(self) -> None:
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            self.proc = None


def decode_audio(path: Path, start: float = 0.0, dur: float | None = None, speed: float = 1.0) -> np.ndarray:
    """Sound of a media file as float stereo at 44.1 kHz (empty when it has none)."""
    info = probe(path)
    if not info.get("audio"):
        return np.zeros((0, 2), dtype=np.float32)
    cmd = [_need("ffmpeg"), "-v", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", f"{start:.4f}"]
    if dur is not None:
        cmd += ["-t", f"{max(0.0, dur) * speed:.4f}"]
    cmd += ["-i", str(path), "-vn"]
    if abs(speed - 1) > 1e-6:
        s, parts = speed, []
        while s > 2.0:                    # atempo works between 0.5 and 2: chain it
            parts.append("atempo=2.0")
            s /= 2
        while s < 0.5:
            parts.append("atempo=0.5")
            s *= 2
        parts.append(f"atempo={s:.5f}")
        cmd += ["-af", ",".join(parts)]
    cmd += ["-ac", "2", "-ar", str(SR), "-f", "f32le", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise MediaError(f"cannot read the sound of {Path(path).name}: {(r.stderr or b'').decode(errors='replace').strip().splitlines()[-1] if r.stderr.strip() else 'unknown error'}")
    return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).copy()


def open_image(path: Path) -> Image.Image:
    try:
        im = Image.open(path)
        im.load()
    except Exception as e:  # noqa: BLE001
        raise MediaError(f"cannot read the picture {Path(path).name}: {e}") from None
    return im.convert("RGBA")
