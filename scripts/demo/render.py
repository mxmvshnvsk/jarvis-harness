#!/usr/bin/env python3
"""Renders scripts/demo/out/<scenario>.json into docs/assets/<scenario>.gif.

A fake terminal: dark theme, DejaVu Sans Mono, typed commands, output with a short hold.
    python3 scripts/demo/render.py [scenario...]
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "scripts" / "demo" / "out"
ASSETS = ROOT / "docs" / "assets"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

COLS, ROWS = 108, 34
SIZE = 15
PAD = 18
BG = (24, 26, 32)
FG = (214, 216, 222)
DIM = (120, 124, 134)
PROMPT = (124, 196, 128)
CMD = (236, 238, 242)
ACCENT = (108, 170, 255)
WARN = (247, 184, 72)
OK = (124, 196, 128)
BAD = (240, 100, 100)

font = ImageFont.truetype(FONT, SIZE)
bold = ImageFont.truetype(FONT_BOLD, SIZE)
CW = font.getlength("M")
LH = SIZE + 6
W = int(PAD * 2 + CW * COLS)
H = int(PAD * 2 + LH * ROWS + 26)


def color_for(line: str):
    s = line.strip()
    if "WAITING_HUMAN" in s or s.startswith("waiting") or "AWAITING APPROVAL" in s:
        return WARN
    if "COMPLETED" in s or s.startswith("approve:") or s.startswith("applied") or "resolved" in s or "success" in s and "#" in s:
        return OK
    if "FAIL" in s or "REGRESSION" in s or "denied" in s:
        return BAD
    if s.startswith("run run_") or s.startswith("thread ") or s.startswith("session ") or s.startswith("review package"):
        return ACCENT
    if s.startswith(("steps:", "artifacts:", "events:", "tokens", "Jarvis", "You (", "Jarvis (")):
        return ACCENT
    if s.startswith(("+", "-")) and not s.startswith(("+++", "---")):
        return OK if s.startswith("+") else BAD
    if s.startswith("#"):
        return DIM
    return FG


def frame(lines, cursor=True):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # window chrome
    d.rounded_rectangle((0, 0, W, 26), radius=0, fill=(36, 38, 46))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((12 + i * 20, 7, 24 + i * 20, 19), fill=c)
    d.text((W / 2 - 40, 5), "jarvis — zsh", font=font, fill=DIM)
    y = 26 + PAD
    shown = lines[-ROWS:]
    for kind, text in shown:
        if kind == "cmd":
            d.text((PAD, y), "❯ ", font=bold, fill=PROMPT)
            d.text((PAD + CW * 2, y), text, font=bold, fill=CMD)
        else:
            d.text((PAD, y), text[:COLS], font=font, fill=color_for(text))
        y += LH
    if cursor and shown:
        kind, text = shown[-1]
        x = PAD + CW * (len(text) + (2 if kind == "cmd" else 0))
        d.rectangle((x, y - LH + 2, x + CW, y - 4), fill=PROMPT if kind == "cmd" else FG)
    return img


def wrap(text):
    out = []
    for line in text.rstrip("\n").split("\n"):
        line = line.expandtabs(4)
        if not line:
            out.append(("out", ""))
            continue
        while len(line) > COLS:
            out.append(("out", line[:COLS]))
            line = "  " + line[COLS:]
        out.append(("out", line))
    return out


def trim(lines, max_rows):
    if len(lines) <= max_rows:
        return lines
    return lines[: max_rows - 1] + [("out", "  … (output trimmed for the recording)")]


def render(name):
    frames_json = json.loads((OUT / f"{name}.json").read_text())
    images, durations = [], []
    screen = []

    def emit(img, ms):
        images.append(img)
        durations.append(ms)

    for step in frames_json:
        cmd = step["command"]
        # type the command
        typed = ""
        for ch in cmd:
            typed += ch
            emit(frame(screen + [("cmd", typed)]), 28 if ch != " " else 60)
        emit(frame(screen + [("cmd", typed)], cursor=False), 450)
        screen = screen + [("cmd", cmd)]
        out = trim(wrap(step["output"]), ROWS - 3)
        # reveal output in chunks
        for i in range(0, len(out), 4):
            emit(frame(screen + out[: i + 4], cursor=False), 70)
        screen = screen + out + [("out", "")]
        emit(frame(screen, cursor=False), 2600)
    emit(frame(screen, cursor=False), 3500)
    ASSETS.mkdir(parents=True, exist_ok=True)
    target = ASSETS / f"{name}.gif"
    # palette-reduce for size
    pal = [im.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for im in images]
    pal[0].save(target, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{target} ({target.stat().st_size // 1024} KB, {len(images)} frames)")


for scenario in sys.argv[1:] or ["work", "clarify", "review"]:
    render(scenario)
