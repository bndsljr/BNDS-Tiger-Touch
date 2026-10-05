#!/usr/bin/env python3
"""
生成一个测试音频，用于验证「音频播放 + 演出时钟同步」链路。

用途：在没有真实演出音频时，把整条链路（浏览器播放 → 服务端时钟锚定 →
漂移校正 → 卡点触发）跑通用。音频每 2 秒有一个短促节拍音，
便于人工听辨"灯光是否踩在拍子上"。

用法：
    python3 tools/make_test_audio.py [--out data/测试音频-30秒.wav] [--seconds 30]
"""

from __future__ import annotations

import argparse
import math
import pathlib
import struct
import wave


def generate(out: pathlib.Path, seconds: float, sample_rate: int = 22050) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        frames = bytearray()
        for i in range(int(sample_rate * seconds)):
            t = i / sample_rate
            phase = t % 2.0
            if phase < 0.08:
                # 每 2 秒一个节拍音
                env = 1.0 - phase / 0.08
                v = math.sin(2 * math.pi * 880 * t) * env * 0.6
            else:
                # 低电平底噪，避免完全静音（部分浏览器的自动播放策略对纯静音更严格）
                v = math.sin(2 * math.pi * 220 * t) * 0.05
            frames += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
        w.writeframes(bytes(frames))
    print(f"已生成 {out}（{out.stat().st_size} 字节，{seconds} 秒，每 2 秒一个节拍音）")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="data/测试音频-30秒.wav")
    ap.add_argument("--seconds", type=float, default=30.0)
    args = ap.parse_args()
    generate(pathlib.Path(args.out), args.seconds)


if __name__ == "__main__":
    main()
