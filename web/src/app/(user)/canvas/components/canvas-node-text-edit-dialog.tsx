"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, Type, X } from "lucide-react";

import { requestImageTextDetection, type ImageTextDetectionItem } from "@/services/api/image";
import type { CanvasNodeData, ViewportTransform } from "../types";

export type CanvasImageTextEditChange = {
    index: number;
    from: string;
    to: string;
    item: ImageTextDetectionItem;
};

type CanvasNodeTextEditDialogProps = {
    node: CanvasNodeData | null;
    open: boolean;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    onClose: () => void;
    onConfirm: (node: CanvasNodeData, changes: CanvasImageTextEditChange[]) => Promise<void> | void;
};

const PANEL_WIDTH = 300;
const PANEL_MARGIN = 16;
const PANEL_HEADER_HEIGHT = 48;
const PANEL_FOOTER_HEIGHT = 76;
const PANEL_BODY_PADDING = 32;
const PANEL_INPUT_HEIGHT = 44;
const PANEL_INPUT_GAP = 12;
const PANEL_LOADING_BODY_HEIGHT = 192;
const TEXT_DETECTION_CACHE_VERSION = "fragment-filter-v3";
const textDetectionCache = new Map<string, ImageTextDetectionItem[]>();

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function estimatePanelHeight({ loading, itemCount, hasError, maxHeight }: { loading: boolean; itemCount: number; hasError: boolean; maxHeight: number }) {
    if (loading) return Math.min(maxHeight, PANEL_HEADER_HEIGHT + PANEL_BODY_PADDING + PANEL_LOADING_BODY_HEIGHT);
    if (itemCount > 0) {
        const listHeight = itemCount * PANEL_INPUT_HEIGHT + Math.max(0, itemCount - 1) * PANEL_INPUT_GAP;
        return Math.min(maxHeight, PANEL_HEADER_HEIGHT + PANEL_BODY_PADDING + listHeight + PANEL_FOOTER_HEIGHT);
    }
    return Math.min(maxHeight, PANEL_HEADER_HEIGHT + PANEL_BODY_PADDING + (hasError ? 96 : 112) + PANEL_FOOTER_HEIGHT);
}

export function CanvasNodeTextEditDialog({ node, open, viewport, viewportSize, onClose, onConfirm }: CanvasNodeTextEditDialogProps) {
    const [items, setItems] = useState<ImageTextDetectionItem[]>([]);
    const [edits, setEdits] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState("");

    const changes = useMemo(
        () =>
            items
                .map((item, index) => ({ index, from: item.text, to: (edits[index] || "").trim(), item }))
                .filter((item) => item.from.trim() && item.to && item.to !== item.from),
        [edits, items],
    );

    const detectText = async () => {
        if (!node?.metadata?.content) return;
        const cacheKey = textDetectionCacheKey(node);
        const cachedItems = textDetectionCache.get(cacheKey);
        if (cachedItems?.length) {
            setItems(cachedItems);
            setEdits(cachedItems.map((item) => item.text));
            setError("");
            return;
        }
        setLoading(true);
        setError("");
        setItems([]);
        setEdits([]);
        try {
            const result = await requestImageTextDetection({
                id: node.id,
                name: `${node.title || node.id}.png`,
                type: node.metadata.mimeType || "image/png",
                dataUrl: node.metadata.content,
                storageKey: node.metadata.storageKey,
                ocrSources: node.metadata.references,
            });
            textDetectionCache.set(cacheKey, result);
            setItems(result);
            setEdits(result.map((item) => item.text));
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "文字识别失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!open || !node?.id) return;
        void detectText();
    }, [open, node?.id]);

    const handleConfirm = async () => {
        if (!node || !changes.length) return;
        setApplying(true);
        try {
            await onConfirm(node, changes);
        } finally {
            setApplying(false);
        }
    };

    if (!open || !node) return null;

    const maxPanelHeight = Math.min(560, Math.max(220, viewportSize.height - 96));
    const estimatedPanelHeight = estimatePanelHeight({ loading, itemCount: items.length, hasError: Boolean(error), maxHeight: maxPanelHeight });
    const nodeScreenLeft = viewport.x + node.position.x * viewport.k;
    const nodeScreenTop = viewport.y + node.position.y * viewport.k;
    const nodeScreenRight = viewport.x + (node.position.x + node.width) * viewport.k;
    const rightSideLeft = nodeScreenRight + 18;
    const leftSideLeft = nodeScreenLeft - PANEL_WIDTH - 18;
    const panelLeft = rightSideLeft + PANEL_WIDTH <= viewportSize.width - PANEL_MARGIN ? rightSideLeft : clamp(leftSideLeft, PANEL_MARGIN, viewportSize.width - PANEL_WIDTH - PANEL_MARGIN);
    const panelTop = clamp(nodeScreenTop, PANEL_MARGIN, viewportSize.height - estimatedPanelHeight - PANEL_MARGIN);
    const isSubmitDisabled = loading || !changes.length || applying;

    return (
        <div
            data-canvas-no-zoom
            data-canvas-ui-interaction-lock="true"
            className="absolute z-[130] animate-in fade-in slide-in-from-left-2"
            style={{ left: panelLeft, top: panelTop }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="flex w-[300px] flex-col overflow-hidden rounded-2xl border border-[#3b3732] bg-[#1f1d1a] text-[#f4f4f5] shadow-[0_24px_70px_rgba(0,0,0,.42)]" style={{ maxHeight: maxPanelHeight }}>
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#34302b] bg-[#24211e]/95 px-4 text-xs font-extrabold">
                    <div className="flex items-center gap-2.5">
                        <Type className="size-3.5 text-[#d4d4d8]" />
                        编辑文字
                    </div>
                    <button type="button" className="grid size-7 place-items-center rounded-lg text-[#a8a29e] transition hover:bg-white/10 hover:text-white" onClick={onClose} disabled={applying} aria-label="关闭">
                        <X className="size-4" />
                    </button>
                </div>

                <div className={`custom-scrollbar min-h-0 flex-1 ${loading ? "overflow-hidden" : "overflow-y-auto"}`}>
                    <div className="space-y-3 p-4">
                        {error ? <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">{error}</div> : null}

                        {loading ? (
                            <div className="grid h-40 place-items-center rounded-xl border border-dashed border-[#403b35] bg-[#25221f]">
                                <div className="flex flex-col items-center gap-3 text-[#a8a29e]">
                                    <Loader2 className="size-6 animate-spin" />
                                    <div className="text-xs font-medium">AI 正在识别文字...</div>
                                </div>
                            </div>
                        ) : items.length ? (
                            items.map((item, index) => (
                                <div key={`${item.text}-${index}`} className="group relative">
                                    <input
                                        type="text"
                                        value={edits[index] || ""}
                                        className="h-11 w-full rounded-xl border border-[#403b35] bg-[#2a2723] px-3 text-sm leading-5 text-[#fafafa] outline-none transition-all placeholder:text-[#78716c] focus:border-[#6b6358] focus:bg-[#211f1c]"
                                        onChange={(event) => setEdits((prev) => prev.map((text, itemIndex) => (itemIndex === index ? event.target.value : text)))}
                                    />
                                </div>
                            ))
                        ) : (
                            <div className="grid h-24 place-items-center rounded-xl border border-dashed border-[#49433b] bg-[#25221f] text-sm text-[#a8a29e]">暂无可编辑文字</div>
                        )}
                    </div>

                    {!loading ? (
                        <div className="border-t border-[#34302b] p-4">
                            <button
                                type="button"
                                className={`flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold shadow-lg transition-all active:scale-95 ${
                                    isSubmitDisabled ? "cursor-not-allowed border border-[#403b35] bg-[#2a2723] text-[#78716c] shadow-none" : "border border-[#fafafa] bg-[#050505] text-white hover:bg-[#141414]"
                                }`}
                                disabled={isSubmitDisabled}
                                onClick={() => void handleConfirm()}
                            >
                                <Sparkles className="size-3.5" />
                                {applying ? "修改中..." : "开始修改"}
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function textDetectionCacheKey(node: CanvasNodeData) {
    const contentKey = node.metadata?.storageKey || node.metadata?.content || node.id;
    const referencesKey = (node.metadata?.references || []).join("|");
    return `${TEXT_DETECTION_CACHE_VERSION}:${node.id}:${contentKey}:${referencesKey}`;
}
