import type { Layer, Psd } from "ag-psd";
import type { CanvasConnection, CanvasNodeData } from "../types";
import { CanvasNodeType } from "../types";

type LayerRole = NonNullable<CanvasNodeData["metadata"]>["layerRole"];
type Bounds = { left: number; top: number; right: number; bottom: number; width: number; height: number };

const roleOrder: Record<NonNullable<LayerRole>, number> = {
    background: 0,
    product: 1,
    text: 2,
};

export function collectPsdLayerNodes(anchor: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (anchor.metadata?.removeBackground) return [];
    const explicitGroupId = anchor.metadata?.layerGroupId;
    if (explicitGroupId) {
        return nodes.filter((node) => node.metadata?.layerGroupId === explicitGroupId && layerRole(node));
    }

    const sourceIds = new Set<string>();
    if (anchor.metadata?.layerSourceId) sourceIds.add(anchor.metadata.layerSourceId);
    connections.filter((connection) => connection.toNodeId === anchor.id).forEach((connection) => sourceIds.add(connection.fromNodeId));

    for (const sourceId of sourceIds) {
        const group = connections
            .filter((connection) => connection.fromNodeId === sourceId)
            .map((connection) => nodes.find((node) => node.id === connection.toNodeId))
            .filter((node): node is CanvasNodeData => Boolean(node && layerRole(node) && !node.metadata?.removeBackground));
        if (group.some((node) => node.id === anchor.id) && group.length >= 2) return group;
    }

    return [];
}

export async function buildLayerGroupPsd(anchor: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const groupNodes = collectPsdLayerNodes(anchor, nodes, connections);
    if (!groupNodes.length) throw new Error("只有智能分层生成的图层可以导出 PSD");

    const bounds = unionBounds(groupNodes.map(nodeBounds));
    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    const bottomToTop = [...groupNodes].sort((a, b) => layerSortValue(a, nodes) - layerSortValue(b, nodes));
    const layers = await Promise.all(bottomToTop.map((node) => renderNodeLayer(node, bounds)));
    const compositeCanvas = composeCanvas(width, height, layers);

    const psd: Psd = {
        width,
        height,
        canvas: compositeCanvas,
        children: layers.reverse(),
    };
    const { writePsd } = await import("ag-psd");
    const buffer = writePsd(psd);
    return {
        blob: new Blob([buffer], { type: "application/octet-stream" }),
        fileName: `${safeFileName(anchor.metadata?.layerGroupId || anchor.metadata?.layerSourceId || anchor.id)}.psd`,
        layerCount: layers.length,
    };
}

export function layerRole(node: CanvasNodeData): LayerRole | null {
    const role = node.metadata?.layerRole;
    if (role === "background" || role === "product" || role === "text") return role;
    if (node.type === CanvasNodeType.Text && node.metadata?.layerText) return "text";
    if (node.type === CanvasNodeType.Image && node.title === "背景层") return "background";
    if (node.type === CanvasNodeType.Image && node.title === "主体层") return "product";
    return null;
}

async function renderNodeLayer(node: CanvasNodeData, documentBounds: Bounds): Promise<Layer> {
    const role = layerRole(node);
    const bounds = nodeBounds(node);
    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持 PSD 图层导出");

    if (node.metadata?.rotation) {
        ctx.translate(node.position.x - bounds.left, node.position.y - bounds.top);
        ctx.rotate((node.metadata.rotation * Math.PI) / 180);
    }

    if (node.type === CanvasNodeType.Image && node.metadata?.content) {
        const image = await loadImage(node.metadata.content);
        drawImageNode(ctx, image, node);
    } else if (node.type === CanvasNodeType.Text) {
        drawTextNode(ctx, node);
    }

    return {
        name: layerName(node, role),
        left: Math.round(bounds.left - documentBounds.left),
        top: Math.round(bounds.top - documentBounds.top),
        opacity: node.metadata?.textOpacity ?? 1,
        canvas,
    };
}

function drawImageNode(ctx: CanvasRenderingContext2D, image: HTMLImageElement, node: CanvasNodeData) {
    const width = Math.max(1, Math.round(node.width));
    const height = Math.max(1, Math.round(node.height));
    if (node.metadata?.freeResize) {
        ctx.drawImage(image, 0, 0, width, height);
        return;
    }
    const ratio = Math.min(width / Math.max(1, image.naturalWidth || image.width), height / Math.max(1, image.naturalHeight || image.height));
    const drawWidth = Math.max(1, (image.naturalWidth || image.width) * ratio);
    const drawHeight = Math.max(1, (image.naturalHeight || image.height) * ratio);
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawTextNode(ctx: CanvasRenderingContext2D, node: CanvasNodeData) {
    const fontSize = Math.max(1, node.metadata?.fontSize || 14);
    const fontStyle = node.metadata?.fontStyle || "normal";
    const fontWeight = node.metadata?.fontWeight || "normal";
    const fontFamily = node.metadata?.fontFamily || "sans-serif";
    const lineHeight = fontSize * 1.16;
    ctx.globalAlpha = clamp01(node.metadata?.textOpacity ?? 1);
    ctx.fillStyle = node.metadata?.textColor || "#111111";
    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.textBaseline = "top";

    const lines = wrapText(ctx, node.metadata?.content || "", Math.max(1, node.width), fontSize);
    lines.forEach((line, index) => {
        ctx.fillText(line, 0, index * lineHeight);
    });
}

function composeCanvas(width: number, height: number, layers: Layer[]) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    layers.forEach((layer) => {
        if (layer.canvas) ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
    });
    return canvas;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSize: number) {
    const hardLines = text.split(/\r?\n/);
    const wrapped: string[] = [];
    hardLines.forEach((line) => {
        let current = "";
        for (const char of line) {
            const next = current + char;
            if (current && ctx.measureText(next).width > maxWidth) {
                wrapped.push(current);
                current = char;
            } else {
                current = next;
            }
        }
        wrapped.push(current || " ");
    });
    return wrapped.length ? wrapped : [" "];
}

function nodeBounds(node: CanvasNodeData): Bounds {
    const width = Math.max(1, node.width);
    const height = Math.max(1, node.height);
    const rotation = node.metadata?.rotation || 0;
    if (!rotation) return toBounds(node.position.x, node.position.y, width, height);
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const points = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: 0, y: height },
        { x: width, y: height },
    ].map((point) => ({ x: node.position.x + point.x * cos - point.y * sin, y: node.position.y + point.x * sin + point.y * cos }));
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function unionBounds(items: Bounds[]): Bounds {
    const left = Math.min(...items.map((item) => item.left));
    const top = Math.min(...items.map((item) => item.top));
    const right = Math.max(...items.map((item) => item.right));
    const bottom = Math.max(...items.map((item) => item.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function toBounds(left: number, top: number, width: number, height: number) {
    return { left, top, right: left + width, bottom: top + height, width, height };
}

function layerSortValue(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const role = layerRole(node);
    const base = role ? roleOrder[role] * 100000 : 500000;
    return base + Math.max(0, nodes.findIndex((item) => item.id === node.id));
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        if (!src.startsWith("blob:") && !src.startsWith("data:")) image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("PSD 导出读取图片失败"));
        image.src = src;
    });
}

function layerName(node: CanvasNodeData, role: LayerRole | null) {
    if (role === "background") return "背景层";
    if (role === "product") return "主体层";
    if (role === "text") return `文字 - ${(node.metadata?.content || node.title || "文本").slice(0, 32)}`;
    return node.title || node.id;
}

function safeFileName(value: string) {
    return `layer-${value}`.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
}

function clamp01(value: number) {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
}
