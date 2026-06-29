"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, Modal } from "antd";
import { ArrowUp, RotateCcw, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";
import type { CanvasImageRect } from "../types";

type DragMode = "draw" | "move" | "resize";
type ResizeHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

const handles: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const minSize = 0.02;

export function CanvasNodeLocalEditDialog({
    dataUrl,
    open,
    loading = false,
    onClose,
    onConfirm,
}: {
    dataUrl: string;
    open: boolean;
    loading?: boolean;
    onClose: () => void;
    onConfirm: (selection: CanvasImageRect, prompt: string) => void;
}) {
    const boxRef = useRef<HTMLDivElement>(null);
    const [selection, setSelection] = useState<CanvasImageRect | null>(null);
    const [prompt, setPrompt] = useState("");
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const selectionSize = image && selection
        ? {
              width: Math.max(1, Math.round(selection.width * image.width)),
              height: Math.max(1, Math.round(selection.height * image.height)),
          }
        : null;

    useEffect(() => {
        if (!open) return;
        setSelection(null);
        setPrompt("");
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    const startDrag = (mode: DragMode, event: ReactPointerEvent, handle?: ResizeHandle) => {
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        event.preventDefault();
        event.stopPropagation();
        const startPoint = pointToNormalized(event.clientX, event.clientY, box);
        const startSelection = selection;
        if (mode !== "draw" && !startSelection) return;
        const move = (nextEvent: PointerEvent) => {
            const nextPoint = pointToNormalized(nextEvent.clientX, nextEvent.clientY, box);
            setSelection(() => {
                if (mode === "draw") return createSelection(startPoint, nextPoint);
                if (!startSelection) return null;
                const dx = nextPoint.x - startPoint.x;
                const dy = nextPoint.y - startPoint.y;
                return mode === "move" ? moveSelection(startSelection, dx, dy) : resizeSelection(startSelection, dx, dy, handle || "se");
            });
        };
        const up = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || !selection || loading) return;
        onConfirm(selection, text);
    };

    const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        submit();
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={loading ? undefined : onClose} footer={null} width={980} centered destroyOnHidden maskClosable={!loading}>
            <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-xl font-semibold">局部编辑</h2>
                        <p className="mt-1 text-sm opacity-60">先框选区域，再输入修改内容。确认后会把“区域1 ...”写入右侧提示框，发送时才真正生成。</p>
                    </div>
                    <Button icon={<X className="size-4" />} onClick={onClose} disabled={loading}>
                        取消
                    </Button>
                </div>

                <div className="flex justify-center rounded-2xl border bg-black/90 p-4">
                    <div ref={boxRef} className="relative inline-block max-w-full overflow-hidden rounded-xl bg-black select-none">
                        <img
                            src={dataUrl}
                            alt=""
                            className="block max-h-[70vh] max-w-full opacity-95"
                            draggable={false}
                            onPointerDown={(event) => startDrag("draw", event)}
                        />
                        <SelectionMask selection={selection} />

                        {!selection ? (
                            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
                                <div className="rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">拖动框选需要修改的区域</div>
                            </div>
                        ) : null}

                        {selection ? (
                            <>
                                <div className="absolute cursor-move border-2 border-[#2f80ff] shadow-[0_0_0_1px_rgba(47,128,255,.2),0_0_28px_rgba(15,23,42,.22)]" style={rectStyle(selection)} onPointerDown={(event) => startDrag("move", event)}>
                                    <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-[#2f80ff] px-2 py-1 text-[11px] font-semibold leading-none text-white">区域1</div>
                                    {handles.map((handle) => (
                                        <button
                                            key={handle}
                                            type="button"
                                            className="absolute size-3 rounded-full border border-[#1d4ed8] bg-white"
                                            style={handleStyle(handle)}
                                            onPointerDown={(event) => startDrag("resize", event, handle)}
                                            aria-label="调整编辑区域"
                                        />
                                    ))}
                                </div>

                                <div className="absolute z-20 flex items-center gap-2 rounded-2xl border border-white/18 bg-stone-950/38 p-2 shadow-[0_20px_58px_rgba(0,0,0,.42)] ring-1 ring-white/10 backdrop-blur-2xl" style={promptBubbleStyle(selection)}>
                                    <button
                                        type="button"
                                        className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/20 bg-white/10 text-white/80 shadow-inner shadow-white/5 transition hover:scale-[1.02] hover:bg-white/18 hover:text-white disabled:opacity-45"
                                        onClick={() => {
                                            setSelection(null);
                                            setPrompt("");
                                        }}
                                        disabled={loading}
                                        aria-label="重新框选"
                                    >
                                        <RotateCcw className="size-4" />
                                    </button>
                                    <div className="rounded-full border border-sky-300/45 bg-sky-500/30 px-2.5 py-1 text-xs font-semibold text-sky-50 shadow-[0_0_18px_rgba(56,189,248,.22)]">区域1</div>
                                    <Input
                                        value={prompt}
                                        placeholder="描述你的修改"
                                        onChange={(event) => setPrompt(event.target.value)}
                                        onKeyDown={onPromptKeyDown}
                                        disabled={loading}
                                        className="min-w-0 flex-1 !rounded-xl !border-white/15 !bg-black/32 !px-3 !text-sm !text-white shadow-inner shadow-black/20 placeholder:!text-white/45 focus:!border-sky-300/55 focus:!bg-black/42"
                                    />
                                    <Button
                                        shape="circle"
                                        icon={<ArrowUp className="size-4" />}
                                        onClick={submit}
                                        disabled={!prompt.trim() || loading}
                                        aria-label="写入提示词"
                                        className="!grid !h-9 !w-9 !min-w-9 !place-items-center !border-white/20 !bg-white/12 !text-white hover:!border-sky-300/55 hover:!bg-sky-400/28 disabled:!bg-white/8 disabled:!text-white/35"
                                    />
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex items-center justify-between text-xs opacity-60">
                    <span>{selectionSize ? `当前选区 ${selectionSize.width} x ${selectionSize.height}` : "尚未选择区域"}</span>
                    {image ? <span>{`原图 ${image.width} x ${image.height}`}</span> : null}
                </div>
            </div>
        </Modal>
    );
}

function SelectionMask({ selection }: { selection: CanvasImageRect | null }) {
    if (!selection) return null;
    return (
        <>
            <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/55" style={{ height: `${selection.y * 100}%` }} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55" style={{ height: `${(1 - selection.y - selection.height) * 100}%` }} />
            <div className="pointer-events-none absolute bg-black/55" style={{ left: 0, top: `${selection.y * 100}%`, width: `${selection.x * 100}%`, height: `${selection.height * 100}%` }} />
            <div className="pointer-events-none absolute bg-black/55" style={{ right: 0, top: `${selection.y * 100}%`, width: `${(1 - selection.x - selection.width) * 100}%`, height: `${selection.height * 100}%` }} />
        </>
    );
}

function createSelection(start: { x: number; y: number }, end: { x: number; y: number }): CanvasImageRect {
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.max(minSize, Math.abs(end.x - start.x));
    const height = Math.max(minSize, Math.abs(end.y - start.y));
    return {
        x: clamp(left, 0, 1 - width),
        y: clamp(top, 0, 1 - height),
        width: clamp(width, minSize, 1),
        height: clamp(height, minSize, 1),
    };
}

function moveSelection(selection: CanvasImageRect, dx: number, dy: number): CanvasImageRect {
    return {
        ...selection,
        x: clamp(selection.x + dx, 0, 1 - selection.width),
        y: clamp(selection.y + dy, 0, 1 - selection.height),
    };
}

function resizeSelection(selection: CanvasImageRect, dx: number, dy: number, handle: ResizeHandle): CanvasImageRect {
    let next = { ...selection };
    if (handle.includes("e")) next.width = selection.width + dx;
    if (handle.includes("s")) next.height = selection.height + dy;
    if (handle.includes("w")) {
        next.x = selection.x + dx;
        next.width = selection.width - dx;
    }
    if (handle.includes("n")) {
        next.y = selection.y + dy;
        next.height = selection.height - dy;
    }
    next.width = clamp(next.width, minSize, 1);
    next.height = clamp(next.height, minSize, 1);
    next.x = clamp(next.x, 0, 1 - next.width);
    next.y = clamp(next.y, 0, 1 - next.height);
    return next;
}

function rectStyle(selection: CanvasImageRect) {
    return {
        left: `${selection.x * 100}%`,
        top: `${selection.y * 100}%`,
        width: `${selection.width * 100}%`,
        height: `${selection.height * 100}%`,
    };
}

function promptBubbleStyle(selection: CanvasImageRect) {
    const showAbove = selection.y + selection.height > 0.7;
    return {
        left: `${clamp(selection.x + selection.width / 2, 0.18, 0.82) * 100}%`,
        top: `${(showAbove ? Math.max(0.06, selection.y - 0.06) : Math.min(0.94, selection.y + selection.height + 0.04)) * 100}%`,
        width: "min(460px, calc(100% - 24px))",
        transform: `translate(-50%, ${showAbove ? "-100%" : "0"})`,
    };
}

function handleStyle(handle: ResizeHandle) {
    const top = handle.includes("n") ? "-6px" : handle.includes("s") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    const left = handle.includes("w") ? "-6px" : handle.includes("e") ? "calc(100% - 6px)" : "calc(50% - 6px)";
    return { top, left, cursor: `${handle}-resize` };
}

function pointToNormalized(clientX: number, clientY: number, box: DOMRect) {
    return {
        x: clamp((clientX - box.left) / box.width, 0, 1),
        y: clamp((clientY - box.top) / box.height, 0, 1),
    };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
