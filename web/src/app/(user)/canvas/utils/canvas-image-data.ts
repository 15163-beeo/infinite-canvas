"use client";

import type { CanvasImageRect } from "../types";

type LocalEditAssets = {
    annotatedDataUrl: string;
};

type PixelRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ImageAngleTransform = {
    horizontalAngle: number;
    pitchAngle: number;
    cameraDistance: number;
    wideAngle: boolean;
};

export async function cropDataUrl(dataUrl: string, crop?: CanvasImageRect) {
    const image = await loadImage(dataUrl);
    if (crop) {
        const rect = toPixelRect(image, crop);
        return drawCrop(image, rect.x, rect.y, rect.width, rect.height);
    }
    const size = Math.min(image.width, image.height);
    const sx = Math.max(0, Math.floor((image.width - size) / 2));
    const sy = Math.max(0, Math.floor((image.height - size) / 2));
    return drawCrop(image, sx, sy, size, size);
}

export async function prepareLocalEditAssets(dataUrl: string, rect: CanvasImageRect): Promise<LocalEditAssets> {
    const image = await loadImage(dataUrl);
    const selectionRect = toPixelRect(image, rect);
    return {
        annotatedDataUrl: createSelectionAnnotationDataUrl(image, selectionRect),
    };
}

export async function transformAngleDataUrl(dataUrl: string, params: ImageAngleTransform) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    const padding = Math.round(Math.max(image.width, image.height) * 0.18);
    canvas.width = image.width + padding * 2;
    canvas.height = image.height + padding * 2;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const horizontal = params.horizontalAngle / 60;
    const pitch = params.pitchAngle / 45;
    const distanceScale = 1.12 - params.cameraDistance * 0.035;
    const wideScale = params.wideAngle ? 0.88 : 1;
    const scale = Math.max(0.64, Math.min(1.1, distanceScale * wideScale));
    const width = image.width * scale * (1 - Math.abs(horizontal) * 0.28);
    const height = image.height * scale * (1 - Math.abs(pitch) * 0.18);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const skewX = horizontal * image.width * 0.18;
    const skewY = pitch * image.height * 0.12;
    const x = cx - width / 2 + horizontal * padding * 0.5;
    const y = cy - height / 2 + pitch * padding * 0.45;

    context.save();
    context.setTransform(1, pitch * 0.08, horizontal * -0.1, 1, 0, 0);
    context.drawImage(image, x + skewX, y + skewY, width, height);
    context.restore();

    if (params.wideAngle) {
        const gradient = context.createRadialGradient(cx, cy, Math.min(canvas.width, canvas.height) * 0.2, cx, cy, Math.max(canvas.width, canvas.height) * 0.62);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(0,0,0,0.18)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
    }

    return canvas.toDataURL("image/png");
}

function drawCrop(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const context = canvas.getContext("2d");
    if (!context) return image.src;
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.src = dataUrl;
    });
}

function toPixelRect(image: HTMLImageElement, rect: CanvasImageRect): PixelRect {
    const x = clamp(Math.floor(rect.x * image.width), 0, Math.max(0, image.width - 1));
    const y = clamp(Math.floor(rect.y * image.height), 0, Math.max(0, image.height - 1));
    const width = clamp(Math.ceil(rect.width * image.width), 1, Math.max(1, image.width - x));
    const height = clamp(Math.ceil(rect.height * image.height), 1, Math.max(1, image.height - y));
    return { x, y, width, height };
}

function createSelectionAnnotationDataUrl(image: HTMLImageElement, selectionRect: PixelRect) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, image.width);
    canvas.height = Math.max(1, image.height);
    const context = canvas.getContext("2d");
    if (!context) return "";

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    context.fillStyle = "rgba(0, 0, 0, 0.28)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
        image,
        selectionRect.x,
        selectionRect.y,
        selectionRect.width,
        selectionRect.height,
        selectionRect.x,
        selectionRect.y,
        selectionRect.width,
        selectionRect.height,
    );

    const strokeWidth = Math.max(4, Math.round(Math.max(canvas.width, canvas.height) * 0.006));
    const cornerLength = clamp(Math.round(Math.max(selectionRect.width, selectionRect.height) * 0.14), 18, 56);
    const fontSize = clamp(Math.round(Math.max(canvas.width, canvas.height) * 0.024), 18, 36);
    const labelPaddingX = Math.round(fontSize * 0.65);
    const labelPaddingY = Math.round(fontSize * 0.35);
    const labelText = "区域1";

    context.strokeStyle = "#ff453a";
    context.lineWidth = strokeWidth;
    context.strokeRect(selectionRect.x, selectionRect.y, selectionRect.width, selectionRect.height);
    drawCornerGuides(context, selectionRect, cornerLength, strokeWidth);

    context.font = `700 ${fontSize}px sans-serif`;
    const labelWidth = Math.ceil(context.measureText(labelText).width) + labelPaddingX * 2;
    const labelHeight = fontSize + labelPaddingY * 2;
    const topLabelY = selectionRect.y - labelHeight - strokeWidth * 2;
    const labelY = topLabelY >= strokeWidth ? topLabelY : selectionRect.y + strokeWidth * 2;
    const labelX = clamp(selectionRect.x, strokeWidth, Math.max(strokeWidth, canvas.width - labelWidth - strokeWidth));

    context.fillStyle = "#ff453a";
    fillRoundedRect(context, labelX, labelY, labelWidth, labelHeight, Math.max(10, Math.round(labelHeight / 2.6)));
    context.fillStyle = "#ffffff";
    context.textBaseline = "middle";
    context.fillText(labelText, labelX + labelPaddingX, labelY + labelHeight / 2);

    return canvas.toDataURL("image/png");
}

function drawCornerGuides(context: CanvasRenderingContext2D, rect: PixelRect, size: number, strokeWidth: number) {
    context.beginPath();
    context.moveTo(rect.x, rect.y + size);
    context.lineTo(rect.x, rect.y);
    context.lineTo(rect.x + size, rect.y);

    context.moveTo(rect.x + rect.width - size, rect.y);
    context.lineTo(rect.x + rect.width, rect.y);
    context.lineTo(rect.x + rect.width, rect.y + size);

    context.moveTo(rect.x + rect.width, rect.y + rect.height - size);
    context.lineTo(rect.x + rect.width, rect.y + rect.height);
    context.lineTo(rect.x + rect.width - size, rect.y + rect.height);

    context.moveTo(rect.x + size, rect.y + rect.height);
    context.lineTo(rect.x, rect.y + rect.height);
    context.lineTo(rect.x, rect.y + rect.height - size);
    context.stroke();

    context.lineWidth = Math.max(2, Math.round(strokeWidth * 0.55));
    context.strokeStyle = "rgba(255, 255, 255, 0.92)";
    context.beginPath();
    context.moveTo(rect.x, rect.y + size);
    context.lineTo(rect.x, rect.y);
    context.lineTo(rect.x + size, rect.y);

    context.moveTo(rect.x + rect.width - size, rect.y);
    context.lineTo(rect.x + rect.width, rect.y);
    context.lineTo(rect.x + rect.width, rect.y + size);

    context.moveTo(rect.x + rect.width, rect.y + rect.height - size);
    context.lineTo(rect.x + rect.width, rect.y + rect.height);
    context.lineTo(rect.x + rect.width - size, rect.y + rect.height);

    context.moveTo(rect.x + size, rect.y + rect.height);
    context.lineTo(rect.x, rect.y + rect.height);
    context.lineTo(rect.x, rect.y + rect.height - size);
    context.stroke();
}

function fillRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.lineTo(x + width - safeRadius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    context.lineTo(x + width, y + height - safeRadius);
    context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    context.lineTo(x + safeRadius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    context.lineTo(x, y + safeRadius);
    context.quadraticCurveTo(x, y, x + safeRadius, y);
    context.closePath();
    context.fill();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
