import argparse
import io
import json
import math
from collections import deque
from pathlib import Path

from PIL import Image
from layer_image import constrain_cutout_to_focus_box, parse_focus_box
from rembg import new_session, remove

from cutout_postprocess import remove_edge_backdrop, solidify_foreground_alpha


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove background from an image using rembg.")
    parser.add_argument("--input", help="Input image path")
    parser.add_argument("--output", help="Output PNG path")
    parser.add_argument("--meta-output", help="Metadata JSON path")
    parser.add_argument("--focus-left", type=int, help="Optional focus box left")
    parser.add_argument("--focus-top", type=int, help="Optional focus box top")
    parser.add_argument("--focus-right", type=int, help="Optional focus box right")
    parser.add_argument("--focus-bottom", type=int, help="Optional focus box bottom")
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
    result = build_remove_background_result(source, session, parse_focus_box(args.focus_left, args.focus_top, args.focus_right, args.focus_bottom))
    Path(args.output).write_bytes(result["image"])
    if args.meta_output:
        Path(args.meta_output).write_text(json.dumps(result["meta"], ensure_ascii=False), encoding="utf-8")
    return 0


def build_remove_background_result(source: bytes, session, focus_box: tuple[int, int, int, int] | None = None) -> dict:
    source_image = Image.open(io.BytesIO(source)).convert("RGBA")
    cutout = build_cutout_image(source, session, focus_box)
    bbox = alpha_bbox(cutout, 24)
    if not bbox:
        raise ValueError("去背景结果为空")
    return {
        "image": trim_transparent_image(cutout),
        "meta": {
            "original_width": source_image.width,
            "original_height": source_image.height,
            "product_offset_x": bbox[0],
            "product_offset_y": bbox[1],
            "product_width": bbox[2] - bbox[0],
            "product_height": bbox[3] - bbox[1],
        },
    }


def remove_background_bytes(source: bytes, session, focus_box: tuple[int, int, int, int] | None = None) -> bytes:
    return build_remove_background_result(source, session, focus_box)["image"]


def build_cutout_image(source: bytes, session, focus_box: tuple[int, int, int, int] | None = None) -> Image.Image:
    source_image = Image.open(io.BytesIO(source)).convert("RGBA")
    cutout = try_flat_background_cutout_image(source)
    if cutout is None:
        cutout = Image.open(io.BytesIO(remove(source, session=session))).convert("RGBA")
        cutout = remove_edge_backdrop(cutout)
    if focus_box is not None:
        cutout = constrain_cutout_to_focus_box(cutout, focus_box)
    cutout = keep_primary_components(cutout, 24, focus_box)
    return solidify_foreground_alpha(cutout, 80, source_image)


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

    output = solidify_foreground_alpha(keep_primary_components(output, 24), 24, image)
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


def keep_primary_components(image: Image.Image, threshold: int, focus_box: tuple[int, int, int, int] | None = None) -> Image.Image:
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

    selected = select_focus_components(components, focus_box, width, height) if focus_box is not None else None
    if not selected:
        components.sort(key=lambda item: item["area"], reverse=True)
        selected = [components[0]]
    keep_pixels = set()
    for component in selected:
        keep_pixels.update(component["pixels"])
    output = image.copy()
    for y in range(height):
        for x in range(width):
            if (x, y) in keep_pixels:
                continue
            r, g, b, _ = output.getpixel((x, y))
            output.putpixel((x, y), (r, g, b, 0))
    return output


def select_focus_components(components: list[dict], focus_box: tuple[int, int, int, int], width: int, height: int) -> list[dict]:
    left, top, right, bottom = clamp_box(focus_box, width, height)
    focus_area = max(1, (right - left) * (bottom - top))
    focus_center_x = (left + right) / 2
    focus_center_y = (top + bottom) / 2
    diagonal = max(1.0, math.sqrt(width * width + height * height))
    candidates: list[dict] = []

    for component in components:
        bbox = component["bbox"]
        overlap = intersection_area(bbox, (left, top, right, bottom))
        comp_left, comp_top, comp_right, comp_bottom = bbox
        bbox_area = max(1, (comp_right - comp_left) * (comp_bottom - comp_top))
        if overlap <= 0 or overlap / bbox_area < 0.55:
            continue
        candidates.append(component)

    if not candidates:
        return []

    candidates.sort(key=lambda item: item["area"], reverse=True)
    primary = candidates[0]
    primary_bbox = primary["bbox"]
    primary_area = max(1, primary["area"])
    selected = [primary]

    for component in candidates[1:]:
        bbox = component["bbox"]
        comp_left, comp_top, comp_right, comp_bottom = bbox
        center_x = (comp_left + comp_right) / 2
        center_y = (comp_top + comp_bottom) / 2
        distance = math.sqrt((center_x - focus_center_x) ** 2 + (center_y - focus_center_y) ** 2) / diagonal
        close_to_primary = box_distance(bbox, primary_bbox) <= max(10, min(width, height) * 0.035)
        meaningful_piece = component["area"] >= max(80, primary_area * 0.006)
        if is_focus_edge_fragment(component, primary_bbox, focus_box, width, height, primary_area):
            continue
        if (close_to_primary or distance < 0.16) and meaningful_piece:
            selected.append(component)

    return selected


def is_focus_edge_fragment(
    component: dict,
    primary_bbox: tuple[int, int, int, int],
    focus_box: tuple[int, int, int, int],
    width: int,
    height: int,
    primary_area: int,
) -> bool:
    left, top, right, bottom = clamp_box(focus_box, width, height)
    comp_left, comp_top, comp_right, comp_bottom = component["bbox"]
    area = component["area"]
    edge_pad_x = max(4, round(width * 0.012))
    edge_pad_y = max(4, round(height * 0.012))
    near_left = comp_left <= left + edge_pad_x
    near_right = comp_right >= right - edge_pad_x
    near_top = comp_top <= top + edge_pad_y
    near_bottom = comp_bottom >= bottom - edge_pad_y
    small = area < primary_area * 0.03
    far_from_primary = box_distance(component["bbox"], primary_bbox) > max(18, min(width, height) * 0.05)
    return small and far_from_primary and (near_left or near_right or near_top or near_bottom)


def box_distance(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> float:
    if intersection_area(box_a, box_b) > 0:
        return 0.0
    dx = max(box_b[0] - box_a[2], box_a[0] - box_b[2], 0)
    dy = max(box_b[1] - box_a[3], box_a[1] - box_b[3], 0)
    return math.sqrt(dx * dx + dy * dy)


def clamp_box(box: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    left = max(0, min(width - 1, left))
    top = max(0, min(height - 1, top))
    right = max(left + 1, min(width, right))
    bottom = max(top + 1, min(height, bottom))
    return (left, top, right, bottom)


def intersection_area(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> int:
    left = max(box_a[0], box_b[0])
    top = max(box_a[1], box_b[1])
    right = min(box_a[2], box_b[2])
    bottom = min(box_a[3], box_b[3])
    if right <= left or bottom <= top:
        return 0
    return (right - left) * (bottom - top)


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * ratio)))
    return ordered[index]


if __name__ == "__main__":
    raise SystemExit(main())
