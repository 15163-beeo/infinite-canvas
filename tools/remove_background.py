import argparse
import io
import math
from collections import deque
from pathlib import Path

from PIL import Image
from rembg import new_session, remove

from cutout_postprocess import remove_edge_backdrop


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove background from an image using rembg.")
    parser.add_argument("--input", help="Input image path")
    parser.add_argument("--output", help="Output PNG path")
    parser.add_argument("--model", default="u2netp", help="rembg model name")
    parser.add_argument("--warmup", action="store_true", help="Only preload the model and exit")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = new_session(args.model)
    if args.warmup:
        return 0
    if not args.input or not args.output:
        raise SystemExit("--input and --output are required unless --warmup is set")
    source = Path(args.input).read_bytes()
    result = remove_background_bytes(source, session)
    Path(args.output).write_bytes(result)
    return 0


def remove_background_bytes(source: bytes, session) -> bytes:
    cutout = try_flat_background_cutout_image(source)
    if cutout is not None:
        return trim_transparent_image(cutout)
    cutout = Image.open(io.BytesIO(remove(source, session=session))).convert("RGBA")
    cutout = remove_edge_backdrop(cutout)
    cutout = keep_primary_components(cutout, 24)
    return trim_transparent_image(cutout)


def trim_transparent_bounds(png_bytes: bytes) -> bytes:
    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    return trim_transparent_image(image)


def trim_transparent_image(image: Image.Image) -> bytes:
    bbox = alpha_bbox(image, 24)
    if bbox:
        image = image.crop(bbox)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def try_flat_background_cutout(source: bytes) -> bytes | None:
    output = try_flat_background_cutout_image(source)
    if output is None:
        return None
    return trim_transparent_image(output)


def try_flat_background_cutout_image(source: bytes) -> Image.Image | None:
    image = Image.open(io.BytesIO(source)).convert("RGBA")
    width, height = image.size
    if width < 32 or height < 32:
        return None

    corners = [
        image.getpixel((0, 0)),
        image.getpixel((width - 1, 0)),
        image.getpixel((0, height - 1)),
        image.getpixel((width - 1, height - 1)),
    ]
    background = tuple(round(sum(pixel[index] for pixel in corners) / len(corners)) for index in range(3))
    border_pixels = sample_border_pixels(image)
    if not border_pixels:
        return None

    background_spread = percentile([color_distance(pixel[:3], background) for pixel in border_pixels], 0.9)
    if background_spread > 22:
        return None

    output = Image.new("RGBA", (width, height))
    for y in range(height):
        for x in range(width):
            r, g, b, a = image.getpixel((x, y))
            alpha = estimate_alpha((r, g, b), background, background_spread)
            final_alpha = min(a, alpha)
            output.putpixel((x, y), (r, g, b, final_alpha))

    output = keep_primary_components(output, 24)
    bbox = alpha_bbox(output, 24)
    if not bbox:
        return None
    return output


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
            min_x = max_x = x
            min_y = max_y = y
            while queue:
                cx, cy = queue.popleft()
                pixels.append((cx, cy))
                min_x = min(min_x, cx)
                min_y = min(min_y, cy)
                max_x = max(max_x, cx)
                max_y = max(max_y, cy)
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height or visited[ny][nx]:
                        continue
                    visited[ny][nx] = True
                    if alpha.getpixel((nx, ny)) >= threshold:
                        queue.append((nx, ny))
            components.append(
                {
                    "pixels": pixels,
                    "area": len(pixels),
                    "bbox": (min_x, min_y, max_x + 1, max_y + 1),
                    "center": ((min_x + max_x) / 2, (min_y + max_y) / 2),
                }
            )

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
