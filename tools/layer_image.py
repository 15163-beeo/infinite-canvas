import argparse
import io
import json
import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove

from cutout_postprocess import remove_edge_backdrop


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Split an image into background and product layers.")
    parser.add_argument("--input", help="Input image path")
    parser.add_argument("--background-output", help="Background PNG path")
    parser.add_argument("--product-output", help="Product PNG path")
    parser.add_argument("--meta-output", help="Metadata JSON path")
    parser.add_argument("--model", default="u2netp", help="rembg model name")
    parser.add_argument("--warmup", action="store_true", help="Only preload the model and exit")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = new_session(args.model)
    if args.warmup:
        return 0
    if not args.input or not args.background_output or not args.product_output or not args.meta_output:
        raise SystemExit("--input, --background-output, --product-output and --meta-output are required unless --warmup is set")
    source = Path(args.input).read_bytes()
    result = build_layer_result(source, session)
    Path(args.background_output).write_bytes(result["background"])
    Path(args.product_output).write_bytes(result["product"])
    Path(args.meta_output).write_text(json.dumps(result["meta"], ensure_ascii=False), encoding="utf-8")
    return 0


def build_layer_result(source: bytes, session) -> dict:
    source_image = Image.open(io.BytesIO(source)).convert("RGBA")
    cutout = remove_background_rgba(source, session)
    cutout = keep_primary_components(cutout, 24)
    bbox = alpha_bbox(cutout, 24)
    if not bbox:
        raise ValueError("未识别到主体")

    background = build_background_image(source_image, cutout)
    product = cutout.crop(bbox)
    return {
        "background": image_to_png_bytes(background),
        "product": image_to_png_bytes(product),
        "meta": {
            "original_width": source_image.width,
            "original_height": source_image.height,
            "product_offset_x": bbox[0],
            "product_offset_y": bbox[1],
            "product_width": bbox[2] - bbox[0],
            "product_height": bbox[3] - bbox[1],
            "text_layers": [],
        },
    }


def build_background_image(source_image: Image.Image, cutout: Image.Image) -> Image.Image:
    flat_background = detect_flat_background(source_image)
    if flat_background is not None:
        background_color, _ = flat_background
        return Image.new("RGBA", source_image.size, background_color + (255,))

    bbox = alpha_bbox(cutout, 24)
    if not bbox:
        return source_image.copy()

    mask = build_soft_fill_mask(cutout.getchannel("A"), source_image.size)
    fill_patch = synthesize_background_patch(source_image, bbox)
    filled = source_image.copy()
    filled.paste(fill_patch, box=(bbox[0], bbox[1]))
    return Image.composite(filled, source_image, mask)


def build_soft_fill_mask(alpha: Image.Image, size: tuple[int, int]) -> Image.Image:
    width, height = size
    mask = alpha.point(lambda value: 255 if value >= 24 else 0, mode="L")
    expand = max(5, (round(min(width, height) / 120) * 2) + 1)
    blur_radius = max(3, round(min(width, height) / 80))
    return mask.filter(ImageFilter.MaxFilter(size=expand)).filter(ImageFilter.GaussianBlur(radius=blur_radius))


def synthesize_background_patch(source_image: Image.Image, bbox: tuple[int, int, int, int]) -> Image.Image:
    x0, y0, x1, y1 = bbox
    width, height = source_image.size
    patch_width = max(1, x1 - x0)
    patch_height = max(1, y1 - y0)
    strip = max(8, round(min(width, height) / 18))
    candidates: list[Image.Image] = []

    left_x = max(0, x0 - strip)
    if left_x < x0:
        candidates.append(source_image.crop((left_x, y0, x0, y1)).resize((patch_width, patch_height), Image.Resampling.BILINEAR))
    right_x = min(width, x1 + strip)
    if x1 < right_x:
        candidates.append(source_image.crop((x1, y0, right_x, y1)).resize((patch_width, patch_height), Image.Resampling.BILINEAR))
    top_y = max(0, y0 - strip)
    if top_y < y0:
        candidates.append(source_image.crop((x0, top_y, x1, y0)).resize((patch_width, patch_height), Image.Resampling.BILINEAR))
    bottom_y = min(height, y1 + strip)
    if y1 < bottom_y:
        candidates.append(source_image.crop((x0, y1, x1, bottom_y)).resize((patch_width, patch_height), Image.Resampling.BILINEAR))

    if not candidates:
        return source_image.crop(bbox).filter(ImageFilter.GaussianBlur(radius=max(4, round(min(patch_width, patch_height) / 12))))

    layers = [np.array(candidate.convert("RGB"), dtype=np.float32) for candidate in candidates]
    merged = np.mean(layers, axis=0).clip(0, 255).astype(np.uint8)
    patch = Image.fromarray(merged, "RGB").filter(ImageFilter.GaussianBlur(radius=max(2, round(min(patch_width, patch_height) / 20))))
    return patch.convert("RGBA")


def remove_background_rgba(source: bytes, session) -> Image.Image:
    color_key_result = try_flat_background_cutout_image(source)
    if color_key_result is not None:
        return color_key_result
    return remove_edge_backdrop(Image.open(io.BytesIO(remove(source, session=session))).convert("RGBA"))


def image_to_png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def try_flat_background_cutout_image(source: bytes) -> Image.Image | None:
    image = Image.open(io.BytesIO(source)).convert("RGBA")
    width, height = image.size
    flat_background = detect_flat_background(image)
    if flat_background is None:
        return None
    background, background_spread = flat_background

    output = Image.new("RGBA", (width, height))
    for y in range(height):
        for x in range(width):
            r, g, b, a = image.getpixel((x, y))
            alpha = estimate_alpha((r, g, b), background, background_spread)
            final_alpha = min(a, alpha)
            output.putpixel((x, y), (r, g, b, final_alpha))

    return keep_primary_components(output, 24)


def detect_flat_background(image: Image.Image) -> tuple[tuple[int, int, int], float] | None:
    width, height = image.size
    if width < 32 or height < 32:
        return None

    border_pixels = sample_border_pixels(image)
    if not border_pixels:
        return None

    background = tuple(int(round(float(np.median([pixel[index] for pixel in border_pixels])))) for index in range(3))
    distances = [color_distance(pixel[:3], background) for pixel in border_pixels]
    spread90 = percentile(distances, 0.9)
    spread98 = percentile(distances, 0.98)
    max_distance = max(distances) if distances else 0

    if spread90 > 18 or spread98 > 28 or max_distance > 42:
        return None

    return background, spread90


def sample_border_pixels(image: Image.Image) -> list[tuple[int, int, int, int]]:
    width, height = image.size
    pixels = []
    step_x = max(1, width // 24)
    step_y = max(1, height // 24)
    for x in range(0, width, step_x):
        pixels.append(image.getpixel((x, 0)))
        pixels.append(image.getpixel((x, height - 1)))
    for y in range(0, height, step_y):
        pixels.append(image.getpixel((0, y)))
        pixels.append(image.getpixel((width - 1, y)))
    return pixels


def color_distance(color: tuple[int, int, int], background: tuple[int, int, int]) -> float:
    dr = color[0] - background[0]
    dg = color[1] - background[1]
    db = color[2] - background[2]
    return math.sqrt(dr * dr + dg * dg + db * db)


def estimate_alpha(color: tuple[int, int, int], background: tuple[int, int, int], background_spread: float) -> int:
    distance = color_distance(color, background)
    low = max(10.0, background_spread * 3.0 + 4.0)
    high = max(low + 28.0, low * 2.0)
    alpha = smoothstep(low, high, distance)
    if alpha <= 0.03:
        return 0
    if alpha >= 0.995:
        return 255
    return max(0, min(255, round(alpha * 255)))


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if value <= edge0:
        return 0.0
    if value >= edge1:
        return 1.0
    ratio = (value - edge0) / max(edge1 - edge0, 1e-6)
    return ratio * ratio * (3.0 - 2.0 * ratio)


def alpha_bbox(image: Image.Image, threshold: int) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A")
    width, height = image.size
    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    for y in range(height):
        for x in range(width):
            if alpha.getpixel((x, y)) < threshold:
                continue
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
    if max_x < min_x or max_y < min_y:
        return alpha.getbbox()
    return (min_x, min_y, max_x + 1, max_y + 1)


def keep_primary_components(image: Image.Image, threshold: int) -> Image.Image:
    alpha = image.getchannel("A")
    width, height = image.size
    visited = [[False for _ in range(width)] for _ in range(height)]
    components = []

    for y in range(height):
        for x in range(width):
            if visited[y][x] or alpha.getpixel((x, y)) < threshold:
                continue
            queue = deque([(x, y)])
            visited[y][x] = True
            pixels = []
            while queue:
                cx, cy = queue.popleft()
                pixels.append((cx, cy))
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height or visited[ny][nx]:
                        continue
                    visited[ny][nx] = True
                    if alpha.getpixel((nx, ny)) >= threshold:
                        queue.append((nx, ny))
            components.append({"pixels": pixels, "area": len(pixels)})

    if len(components) <= 1:
        return image

    components.sort(key=lambda item: item["area"], reverse=True)
    keep_pixels = set(components[0]["pixels"])
    output = image.copy()
    for y in range(height):
        for x in range(width):
            if (x, y) in keep_pixels:
                continue
            r, g, b, _ = output.getpixel((x, y))
            output.putpixel((x, y), (r, g, b, 0))
    return output


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * ratio)))
    return ordered[index]


if __name__ == "__main__":
    raise SystemExit(main())
