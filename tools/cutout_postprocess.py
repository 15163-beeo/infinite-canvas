from __future__ import annotations

import math
from collections import deque

from PIL import Image


def remove_edge_backdrop(image: Image.Image, alpha_threshold: int = 24) -> Image.Image:
    """Remove a flat color panel that rembg kept as part of the foreground.

    This handles icon/product-card inputs where the real subject sits on a
    uniform colored plate that touches the cutout bounds.
    """
    image = image.convert("RGBA")
    bbox = _alpha_bbox(image, alpha_threshold)
    if not bbox:
        return image

    x0, y0, x1, y1 = bbox
    width = x1 - x0
    height = y1 - y0
    if width < 16 or height < 16:
        return image

    samples = _sample_visible_bbox_edge(image, bbox, alpha_threshold)
    if len(samples) < 16:
        return image

    backdrop = tuple(int(round(_median([pixel[channel] for pixel in samples]))) for channel in range(3))
    distances = [_color_distance(pixel, backdrop) for pixel in samples]
    spread85 = _percentile(distances, 0.85)
    spread95 = _percentile(distances, 0.95)
    if spread85 > 34 or spread95 > 54:
        return image

    cutoff = max(34.0, min(76.0, spread95 + 18.0))
    alpha = image.getchannel("A")
    seeds = _edge_seed_pixels(image, bbox, backdrop, cutoff, alpha_threshold)
    if not seeds:
        return image

    visible_before = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            if alpha.getpixel((x, y)) >= alpha_threshold:
                visible_before += 1
    if visible_before == 0:
        return image

    removable = _connected_similar_pixels(image, bbox, seeds, backdrop, cutoff)
    visible_removed = sum(1 for x, y in removable if alpha.getpixel((x, y)) >= alpha_threshold)
    if visible_removed < max(8, int(visible_before * 0.08)):
        return image

    visible_remaining = visible_before - visible_removed
    if visible_remaining < max(12, int(visible_before * 0.03)):
        return image

    output = image.copy()
    for x, y in removable:
        r, g, b, _ = output.getpixel((x, y))
        output.putpixel((x, y), (r, g, b, 0))
    return output


def _sample_visible_bbox_edge(image: Image.Image, bbox: tuple[int, int, int, int], alpha_threshold: int) -> list[tuple[int, int, int]]:
    x0, y0, x1, y1 = bbox
    width = x1 - x0
    height = y1 - y0
    inset = max(1, round(min(width, height) * 0.035))
    step = max(1, min(width, height) // 96)
    min_alpha = max(96, alpha_threshold)
    samples: list[tuple[int, int, int]] = []

    def add(x: int, y: int) -> None:
        r, g, b, a = image.getpixel((x, y))
        if a >= min_alpha:
            samples.append((r, g, b))

    for x in range(x0, x1, step):
        for y in range(y0, min(y1, y0 + inset), step):
            add(x, y)
        for y in range(max(y0, y1 - inset), y1, step):
            add(x, y)
    for y in range(y0, y1, step):
        for x in range(x0, min(x1, x0 + inset), step):
            add(x, y)
        for x in range(max(x0, x1 - inset), x1, step):
            add(x, y)
    return samples


def _edge_seed_pixels(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    backdrop: tuple[int, int, int],
    cutoff: float,
    alpha_threshold: int,
) -> list[tuple[int, int]]:
    x0, y0, x1, y1 = bbox
    seeds: list[tuple[int, int]] = []

    def add(x: int, y: int) -> None:
        r, g, b, a = image.getpixel((x, y))
        if a >= alpha_threshold and _color_distance((r, g, b), backdrop) <= cutoff:
            seeds.append((x, y))

    for x in range(x0, x1):
        add(x, y0)
        add(x, y1 - 1)
    for y in range(y0, y1):
        add(x0, y)
        add(x1 - 1, y)
    return seeds


def _connected_similar_pixels(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    seeds: list[tuple[int, int]],
    backdrop: tuple[int, int, int],
    cutoff: float,
) -> set[tuple[int, int]]:
    x0, y0, x1, y1 = bbox
    queue = deque(seeds)
    visited = set(seeds)
    removable: set[tuple[int, int]] = set()

    while queue:
        x, y = queue.popleft()
        r, g, b, a = image.getpixel((x, y))
        if a <= 0 or _color_distance((r, g, b), backdrop) > cutoff:
            continue
        removable.add((x, y))
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < x0 or ny < y0 or nx >= x1 or ny >= y1 or (nx, ny) in visited:
                continue
            visited.add((nx, ny))
            queue.append((nx, ny))
    return removable


def _alpha_bbox(image: Image.Image, threshold: int) -> tuple[int, int, int, int] | None:
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
        return None
    return (min_x, min_y, max_x + 1, max_y + 1)


def _color_distance(color: tuple[int, int, int], background: tuple[int, int, int]) -> float:
    dr = color[0] - background[0]
    dg = color[1] - background[1]
    db = color[2] - background[2]
    return math.sqrt(dr * dr + dg * dg + db * db)


def _percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * ratio)))
    return ordered[index]


def _median(values: list[int]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2
