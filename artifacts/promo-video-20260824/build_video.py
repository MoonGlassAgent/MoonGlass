from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
import imageio_ffmpeg


ROOT = Path(r"D:\Projects\ASIC_Flow\MoonGlass")
OUT = ROOT / "artifacts" / "promo-video-20260824"
W, H, FPS = 1080, 1920, 24

SCENES = [
    ("e2e-screenshots/dark-projects.png", 7.0, "一个工作区，贯穿 ASIC IP 全流程", "需求规格 · 架构 · RTL · 验证 · QA · 综合"),
    ("e2e-screenshots/04-workspace-req.png", 8.5, "六阶段工程流程", "每一步都有状态、门禁、证据与变更响应"),
    ("e2e-screenshots/workspace-session-tabs-highlight.png", 10.0, "主 Agent，面向最终交付", "真实读写工程 · 调用工具 · 失败分析 · 修复回归"),
    ("e2e-screenshots/design-browser-highlight-fixed.png", 8.0, "理解设计，不只生成代码", "层次浏览 · 源码定位 · 交叉探查"),
    ("artifacts/dark-mode-workspace.png", 10.5, "验证结论，必须有证据", "测试日志 · 覆盖率 · RTL 原始证据 · 独立 Review"),
    ("e2e-screenshots/gate-fix-action.png", 7.5, "让芯片开发更快，也更像工程", "MoonGlass ASIC Design Agent · 已开源"),
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    names = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ]
    for name in names:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def fit_crop(img: Image.Image, width: int, height: int, zoom: float, pan: float) -> Image.Image:
    scale = max(width / img.width, height / img.height) * zoom
    nw, nh = int(img.width * scale), int(img.height * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    max_x = max(0, nw - width)
    max_y = max(0, nh - height)
    x = int(max_x * (0.42 + 0.12 * pan))
    y = int(max_y * (0.45 + 0.08 * math.sin(pan * math.pi)))
    return img.crop((x, y, x + width, y + height))


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *size), radius=radius, fill=255)
    return mask


def render_scene(src: Path, title: str, subtitle: str, progress: float, scene_idx: int) -> Image.Image:
    source = Image.open(src).convert("RGB")
    bg = fit_crop(source, W, H, 1.18 + progress * 0.025, progress)
    bg = bg.filter(ImageFilter.GaussianBlur(28))
    bg = ImageEnhance.Brightness(bg).enhance(0.27)

    frame = bg.convert("RGBA")
    draw = ImageDraw.Draw(frame, "RGBA")
    draw.rectangle((0, 0, W, H), fill=(5, 10, 18, 105))

    # Brand lockup
    icon = Image.open(ROOT / "dist/.icon-ico/icon.ico").convert("RGBA").resize((74, 74), Image.Resampling.LANCZOS)
    frame.alpha_composite(icon, (66, 70))
    draw.text((158, 74), "MoonGlass", font=font(42, True), fill=(246, 249, 252, 255))
    draw.text((160, 122), "ASIC DESIGN AGENT", font=font(19, True), fill=(84, 209, 166, 255))

    # Main product screenshot
    card_w, card_h = 952, 1010
    screenshot = fit_crop(source, card_w, card_h, 1.0 + progress * 0.035, progress - 0.5)
    screenshot = ImageEnhance.Contrast(screenshot).enhance(1.03)
    screenshot = screenshot.convert("RGBA")
    shadow = Image.new("RGBA", (card_w + 40, card_h + 40), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((18, 18, card_w + 18, card_h + 18), 20, fill=(0, 0, 0, 135))
    shadow = shadow.filter(ImageFilter.GaussianBlur(16))
    frame.alpha_composite(shadow, (44, 300))
    frame.paste(screenshot, (64, 300), rounded_mask((card_w, card_h), 18))
    draw.rounded_rectangle((64, 300, 1016, 1310), 18, outline=(109, 224, 187, 130), width=2)

    # Claim and supporting line
    draw.text((64, 1408), title, font=font(53, True), fill=(250, 252, 255, 255))
    draw.rounded_rectangle((64, 1500, 1016, 1584), 12, fill=(16, 24, 35, 224))
    draw.text((92, 1523), subtitle, font=font(28), fill=(193, 205, 218, 255))

    # Stage marker
    stages = ["REQ_SPEC", "ARCH", "RTL", "VERIF", "QA", "SYNTH"]
    x, y = 64, 1680
    for i, label in enumerate(stages):
        active = i <= scene_idx
        fill = (22, 163, 120, 255) if active else (51, 61, 75, 255)
        draw.ellipse((x, y, x + 20, y + 20), fill=fill)
        draw.text((x + 30, y - 6), label, font=font(18, True), fill=(225, 232, 240, 255) if active else (119, 130, 145, 255))
        x += 165

    draw.text((64, 1815), "moonglassagent.github.io/MoonGlass", font=font(23), fill=(135, 151, 169, 255))
    return frame.convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    silent = OUT / "MoonGlass-promo-silent.mp4"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    manifest_lines: list[str] = []
    for idx, (relative, duration, title, subtitle) in enumerate(SCENES):
        still = OUT / f"scene-{idx + 1:02d}.png"
        render_scene(ROOT / relative, title, subtitle, 0.5, idx).save(still, optimize=True)
        manifest_lines.extend([f"file '{still.as_posix()}'", f"duration {duration}"])
    manifest_lines.append(f"file '{(OUT / f'scene-{len(SCENES):02d}.png').as_posix()}'")
    manifest = OUT / "scenes.txt"
    manifest.write_text("\n".join(manifest_lines) + "\n", encoding="utf-8")
    subprocess.run([
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(manifest),
        "-vf", f"fps={FPS}", "-an", "-vcodec", "libx264", "-preset", "medium",
        "-crf", "20", "-pix_fmt", "yuv420p", str(silent),
    ], check=True)

    voice = OUT / "narration.wav"
    final = OUT / "MoonGlass-ASIC-Design-Agent-短视频-中文配音.mp4"
    subprocess.run([
        ffmpeg, "-y", "-i", str(silent), "-i", str(voice), "-c:v", "copy", "-c:a", "aac",
        "-b:a", "192k", "-af", "loudnorm=I=-16:LRA=7:TP=-1.5", "-shortest", str(final)
    ], check=True)
    print(final)


if __name__ == "__main__":
    main()
