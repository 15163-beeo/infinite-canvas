"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlignCenter, AlignLeft, AlignRight, Download, Home, ImageIcon, Images, Layers, LayoutGrid, Link2, List, Menu, MessageSquare, Plus, Redo2, Settings2, Trash2, Undo2, Unlink, Upload, Video } from "lucide-react";
import { saveAs } from "file-saver";

import { requestEdit, requestGeneration, requestImageQuestion, requestLayerImage, requestRemoveBackground, type LayerImageTextLayer, type RemoveBackgroundResult } from "@/services/api/image";
import { requestVideoGeneration } from "@/services/api/video";
import { defaultConfig, type AiConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { readStoredImageHistoryStorageKeys } from "@/services/image-history-storage";
import { collectImageStorageKeys, deleteStoredImages, imageToDataUrl, resolveImageUrl, storeImageBlobLocally, uploadImage, type UploadedImage } from "@/services/image-storage";
import { resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, prepareLocalEditAssets } from "../utils/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "../utils/canvas-node-size";
import { buildLayerGroupPsd, collectPsdLayerNodes } from "../utils/canvas-psd-export";
import { App, Button, Dropdown, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import { ActiveConnectionPath, ConnectionPath } from "../components/canvas-connections";
import { CanvasConfigNodePanel } from "../components/canvas-config-node-panel";
import { CanvasAssistantPanel } from "../components/canvas-assistant-panel";
import { CanvasNodeContextMenu } from "../components/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "../components/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "../components/canvas-node-crop-dialog";
import { buildNodeChatMessages, buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext, type NodeGenerationInput } from "../components/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "../components/canvas-node-hover-toolbar";
import { CanvasNodeTextEditDialog, type CanvasImageTextEditChange } from "../components/canvas-node-text-edit-dialog";
import { CanvasNodeLocalEditDialog } from "../components/canvas-node-local-edit-dialog";
import { InfiniteCanvas } from "../components/infinite-canvas";
import { Minimap } from "../components/canvas-mini-map";
import { CanvasNode } from "../components/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "../components/canvas-node-prompt-panel";
import { CanvasToolbar } from "../components/canvas-toolbar";
import { AssetPickerModal, type AssetPickerTab, type InsertAssetPayload } from "../components/asset-picker-modal";
import { CanvasZoomControls } from "../components/canvas-zoom-controls";
import { useCanvasStore } from "../stores/use-canvas-store";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasImageGenerationType,
    type CanvasImageRect,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "../types";
import type { ReferenceImage } from "@/types/image";

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

type GroupResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const REMOVE_BACKGROUND_PROMPT_PREFIXES = ["Remove the original background", "Remove the background completely"];
const REMOVE_BACKGROUND_RESULT_VERSION = 3;
const GROUP_RESIZE_MIN_SIZE = 32;
const MULTI_SELECT_LAYOUT_GAP = 24;
const MAX_EXPORT_CANVAS_DIMENSION = 4096;
const GROUP_RESIZE_HANDLES: { handle: GroupResizeHandle; left: string; top: string; transform: string }[] = [
    { handle: "nw", left: "0%", top: "0%", transform: "translate(-50%, -50%)" },
    { handle: "n", left: "50%", top: "0%", transform: "translate(-50%, -50%)" },
    { handle: "ne", left: "100%", top: "0%", transform: "translate(-50%, -50%)" },
    { handle: "e", left: "100%", top: "50%", transform: "translate(-50%, -50%)" },
    { handle: "se", left: "100%", top: "100%", transform: "translate(-50%, -50%)" },
    { handle: "s", left: "50%", top: "100%", transform: "translate(-50%, -50%)" },
    { handle: "sw", left: "0%", top: "100%", transform: "translate(-50%, -50%)" },
    { handle: "w", left: "0%", top: "50%", transform: "translate(-50%, -50%)" },
];

function isEditableEventTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']"));
}

function groupResizeCursor(handle: GroupResizeHandle) {
    if (handle === "n" || handle === "s") return "ns-resize";
    if (handle === "e" || handle === "w") return "ew-resize";
    if (handle === "nw" || handle === "se") return "nwse-resize";
    return "nesw-resize";
}

function getNodesBounds(nodes: CanvasNodeData[]) {
    if (!nodes.length) return null;
    const left = Math.min(...nodes.map((node) => node.position.x));
    const top = Math.min(...nodes.map((node) => node.position.y));
    const right = Math.max(...nodes.map((node) => node.position.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.position.y + node.height));
    return { left, top, width: right - left, height: bottom - top };
}

function expandSelectionWithBoundGroups(ids: Set<string>, nodes: CanvasNodeData[]) {
    const expanded = new Set(ids);
    const groupIds = new Set<string>();
    nodes.forEach((node) => {
        if (expanded.has(node.id) && node.metadata?.boundGroupId) groupIds.add(node.metadata.boundGroupId);
    });
    if (!groupIds.size) return expanded;
    nodes.forEach((node) => {
        if (node.metadata?.boundGroupId && groupIds.has(node.metadata.boundGroupId)) expanded.add(node.id);
    });
    return expanded;
}

function withoutBoundGroupId(metadata: CanvasNodeMetadata | undefined) {
    if (!metadata) return metadata;
    const next = { ...metadata };
    delete next.boundGroupId;
    return next;
}

function fitContainRect(x: number, y: number, width: number, height: number, naturalWidth: number, naturalHeight: number) {
    const scale = Math.min(width / Math.max(1, naturalWidth), height / Math.max(1, naturalHeight));
    const drawWidth = Math.max(1, naturalWidth * scale);
    const drawHeight = Math.max(1, naturalHeight * scale);
    return {
        x: x + (width - drawWidth) / 2,
        y: y + (height - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
    };
}

function loadCanvasImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败，无法导出"));
        image.src = src;
    });
}

async function renderCanvasNodesToPngBlob(nodes: CanvasNodeData[], bounds: { left: number; top: number; width: number; height: number }) {
    if (!nodes.length) throw new Error("没有可导出的元素");
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const scale = Math.max(0.1, Math.min(window.devicePixelRatio || 1, 2, MAX_EXPORT_CANVAS_DIMENSION / width, MAX_EXPORT_CANVAS_DIMENSION / height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持画布导出");
    context.scale(scale, scale);
    context.clearRect(0, 0, width, height);

    for (const node of nodes) {
        await drawCanvasNode(context, node, bounds.left, bounds.top);
    }

    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("导出失败"));
                return;
            }
            resolve(blob);
        }, "image/png");
    });
}

async function drawCanvasNode(context: CanvasRenderingContext2D, node: CanvasNodeData, offsetX: number, offsetY: number) {
    const x = node.position.x - offsetX;
    const y = node.position.y - offsetY;
    const width = Math.max(1, node.width);
    const height = Math.max(1, node.height);

    if ((node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && node.metadata?.content) {
        if (node.type === CanvasNodeType.Video) {
            context.save();
            context.fillStyle = "#0f172a";
            context.fillRect(x, y, width, height);
            context.fillStyle = "#ffffff";
            context.font = "14px sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText("VIDEO", x + width / 2, y + height / 2);
            context.restore();
            return;
        }

        const source = await resolveImageUrl(node.metadata.storageKey, node.metadata.content);
        const image = await loadCanvasImage(source);
        const naturalWidth = node.metadata.naturalWidth || image.naturalWidth || width;
        const naturalHeight = node.metadata.naturalHeight || image.naturalHeight || height;
        const rect = node.metadata.freeResize ? { x, y, width, height } : fitContainRect(x, y, width, height, naturalWidth, naturalHeight);
        context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
        return;
    }

    if (node.type === CanvasNodeType.Text) {
        drawTextCanvasNode(context, node, x, y, width, height);
        return;
    }

    context.save();
    context.fillStyle = "rgba(255,255,255,.92)";
    context.strokeStyle = "rgba(15,23,42,.16)";
    context.lineWidth = 1;
    context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);
    context.fillStyle = "#475569";
    context.font = "14px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(node.title || node.type, x + width / 2, y + height / 2);
    context.restore();
}

function drawTextCanvasNode(context: CanvasRenderingContext2D, node: CanvasNodeData, x: number, y: number, width: number, height: number) {
    const text = node.metadata?.content || "";
    const fontSize = Math.max(6, node.metadata?.fontSize || 14);
    const fontFamily = node.metadata?.fontFamily || (node.metadata?.layerText ? "sans-serif" : "monospace");
    const fontWeight = node.metadata?.fontWeight || "normal";
    const fontStyle = node.metadata?.fontStyle || "normal";
    const lineHeight = fontSize * (node.metadata?.layerText ? 1.16 : 1.45);
    const padding = node.metadata?.layerText ? 0 : 16;
    const maxWidth = Math.max(1, width - padding * 2);

    context.save();
    if (!node.metadata?.layerText) {
        context.fillStyle = "rgba(255,255,255,.94)";
        context.strokeStyle = "rgba(15,23,42,.12)";
        context.fillRect(x, y, width, height);
        context.strokeRect(x, y, width, height);
    }
    context.globalAlpha = typeof node.metadata?.textOpacity === "number" ? Math.min(1, Math.max(0, node.metadata.textOpacity)) : 1;
    context.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    const lines = wrapCanvasText(context, text, maxWidth);
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillStyle = node.metadata?.textColor || "#1f2937";
    const strokeWidth = Math.max(0, node.metadata?.textStrokeWidth || 0);
    if (strokeWidth) {
        context.lineWidth = strokeWidth;
        context.strokeStyle = node.metadata?.textStrokeColor || "transparent";
    }
    lines.forEach((line, index) => {
        const lineX = x + padding;
        const lineY = y + padding + index * lineHeight;
        if (lineY > y + height) return;
        if (strokeWidth) context.strokeText(line, lineX, lineY);
        context.fillText(line, lineX, lineY);
    });
    context.restore();
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
    const lines: string[] = [];
    const paragraphs = (text || " ").split(/\r?\n/);
    paragraphs.forEach((paragraph) => {
        let current = "";
        Array.from(paragraph || " ").forEach((char) => {
            const next = `${current}${char}`;
            if (current && context.measureText(next).width > maxWidth) {
                lines.push(current);
                current = char;
            } else {
                current = next;
            }
        });
        lines.push(current);
    });
    return lines;
}

function getClipboardImageFile(data: DataTransfer | null) {
    if (!data) return null;
    const file = Array.from(data.files).find((item) => item.type.startsWith("image/"));
    if (file) return file.name ? file : new File([file], "clipboard-image.png", { type: file.type || "image/png" });

    const item = Array.from(data.items).find((entry) => entry.kind === "file" && entry.type.startsWith("image/"));
    if (!item) return null;
    const itemFile = item.getAsFile();
    if (!itemFile) return null;
    return itemFile.name ? itemFile : new File([itemFile], "clipboard-image.png", { type: itemFile.type || item.type || "image/png" });
}

function createCanvasNode(type: CanvasNodeType, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function CanvasRefreshShell() {
    return (
        <main className="relative h-full min-h-0 overflow-hidden bg-background text-foreground">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                    backgroundSize: "28px 28px",
                }}
            />

            <div className="absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div className="absolute bottom-24 left-6 z-50 h-40 w-[240px] rounded-lg border shadow-2xl backdrop-blur-sm" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div className="absolute bottom-5 left-5 z-50 flex h-14 w-[260px] items-center gap-2 rounded-xl border px-2 shadow-lg backdrop-blur" style={{ background: "var(--background)", borderColor: "var(--border)" }} aria-hidden="true">
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}

function ConnectionCreateMenu({ pending, onCreate, onClose }: { pending: PendingConnectionCreate; onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video) => void; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div
            className="absolute z-[120] w-[300px] rounded-[18px] border p-3 shadow-2xl backdrop-blur"
            data-connection-create-menu
            style={{ left: pending.position.x, top: pending.position.y, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    引用该节点生成
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label="关闭">
                    ×
                </button>
            </div>
            <div className="grid gap-1">
                <ConnectionCreateOption theme={theme} icon={<List className="size-5" />} title="文本生成" description="脚本、广告词、品牌文案" onClick={() => onCreate(CanvasNodeType.Text)} />
                <ConnectionCreateOption theme={theme} icon={<ImageIcon className="size-5" />} title="图片生成" onClick={() => onCreate(CanvasNodeType.Image)} />
                <ConnectionCreateOption theme={theme} icon={<Video className="size-5" />} title="视频生成" onClick={() => onCreate(CanvasNodeType.Video)} />
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-5" />} title="配置节点" description="模型、尺寸、数量和输入顺序" onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-16 w-full cursor-pointer items-center gap-3 rounded-2xl px-3 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-11 shrink-0 place-items-center rounded-xl" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-semibold leading-5">{title}</span>
                {description ? (
                    <span className="mt-1 block truncate text-sm" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

function InfiniteCanvasPage() {
    const { message } = App.useApp();
    const params = useParams<{ id: string }>();
    const router = useRouter();
    const projectId = params.id;
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const legacyRemoveBackgroundCheckedRef = useRef(new Set<string>());
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const toolbarHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });
    const groupResizeRef = useRef<{
        isResizing: boolean;
        handle: GroupResizeHandle;
        startX: number;
        startY: number;
        hasMoved: boolean;
        bounds: { left: number; top: number; width: number; height: number };
        initialNodes: { id: string; x: number; y: number; width: number; height: number; fontSize?: number }[];
    }>({
        isResizing: false,
        handle: "se",
        startX: 0,
        startY: 0,
        hasMoved: false,
        bounds: { left: 0, top: 0, width: 1, height: 1 },
        initialNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("select");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [assetPickerTab, setAssetPickerTab] = useState<AssetPickerTab>("my-assets");
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [localEditNodeId, setLocalEditNodeId] = useState<string | null>(null);
    const [imageTextEditNodeId, setImageTextEditNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [assistantCollapsed, setAssistantCollapsed] = useState(true);
    const [assistantMounted, setAssistantMounted] = useState(false);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setEditingNodeId(null);
        setSelectionBox(null);
        setContextMenu(null);
        const project = openProject(projectId);
        if (!project) {
            router.replace("/canvas");
            return;
        }

        const restore = async () => {
            const restoredNodes = normalizeCanvasNodes(await hydrateCanvasImages(resetInterruptedGeneration(project.nodes)), project.connections);
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
        };
        void restore();
    }, [hydrated, openProject, projectId, router]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    const removeConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu(null);
    }, []);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        const legacyNodes = nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.removeBackground && (node.metadata.removeBackgroundVersion || 0) < REMOVE_BACKGROUND_RESULT_VERSION);
        legacyNodes.forEach((node) => {
            if (legacyRemoveBackgroundCheckedRef.current.has(node.id)) return;
            legacyRemoveBackgroundCheckedRef.current.add(node.id);
            void (async () => {
                const references = await resolveMetadataReferences(node.metadata || {});
                const reference = references?.[0];
                if (!reference) return;
                const removeBackgroundResult = await requestRemoveBackground(reference, buildGenerationConfig(effectiveConfig, node, "image"));
                const uploadedImage = await storeImageBlobLocally(removeBackgroundResult.blob);
                const imageSize = removeBackgroundNodeSize(uploadedImage, removeBackgroundSourceMetrics(node, nodesRef.current, connectionsRef.current), removeBackgroundResult);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: { ...item.metadata, ...imageMetadata(uploadedImage), ...removeBackgroundResultMetadata(removeBackgroundResult), removeBackground: true, removeBackgroundVersion: REMOVE_BACKGROUND_RESULT_VERSION },
                              }
                            : item,
                    ),
                );
            })().catch((error) => {
                console.warn("legacy remove background upgrade failed", error);
            });
        });
    }, [nodes, projectLoaded]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen) return;
            if (toolbarHideTimerRef.current) {
                clearTimeout(toolbarHideTimerRef.current);
                toolbarHideTimerRef.current = null;
            }
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {
        if (toolbarHideTimerRef.current) clearTimeout(toolbarHideTimerRef.current);
        toolbarHideTimerRef.current = setTimeout(() => {
            setToolbarNodeId((current) => {
                const selectedIds = selectedNodeIdsRef.current;
                if (current && selectedIds.size === 1 && selectedIds.has(current)) return current;
                return null;
            });
            toolbarHideTimerRef.current = null;
        }, 120);
    }, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video, pending: PendingConnectionCreate) => {
            const metadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          outputFormat: effectiveConfig.outputFormat,
                          outputCompression: effectiveConfig.outputCompression,
                          moderation: effectiveConfig.moderation,
                          count: 1,
                      }
                    : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(shouldAutoOpenNodeDialog(newNode) ? newNode.id : null);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.moderation, effectiveConfig.outputCompression, effectiveConfig.outputFormat, effectiveConfig.size, message, setConnecting],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectableNodeAtPoint = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle) => {
            const world = screenToCanvas(clientX, clientY);
            return (
                [...nodesRef.current]
                    .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                    .reverse()
                    .find(
                        (node) =>
                            node.id !== current.nodeId &&
                            Boolean(normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) &&
                            world.x >= node.position.x &&
                            world.x <= node.position.x + node.width &&
                            world.y >= node.position.y &&
                            world.y <= node.position.y + node.height,
                    )?.id || null
            );
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !isHiddenBatchChild(node, nodes, collapsingBatchIds) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [collapsingBatchIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const toolbarNode = toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null;
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const localEditNode = localEditNodeId ? nodeById.get(localEditNodeId) || null : null;
    const imageTextEditNode = imageTextEditNodeId ? nodeById.get(imageTextEditNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const toolbarPsdLayerNodes = useMemo(() => (toolbarNode ? collectPsdLayerNodes(toolbarNode, nodes, connections) : []), [connections, nodes, toolbarNode]);
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const selectedVisibleNodes = useMemo(() => nodes.filter((node) => selectedNodeIds.has(node.id) && !isHiddenBatchChild(node, nodes, collapsingBatchIds)), [collapsingBatchIds, nodes, selectedNodeIds]);
    const selectedGroupBounds = useMemo(() => {
        if (selectedVisibleNodes.length <= 1) return null;
        return getNodesBounds(selectedVisibleNodes);
    }, [selectedVisibleNodes]);
    const selectedBoundGroupId = useMemo(() => {
        if (selectedVisibleNodes.length <= 1) return null;
        const firstGroupId = selectedVisibleNodes[0]?.metadata?.boundGroupId;
        if (!firstGroupId || selectedVisibleNodes.some((node) => node.metadata?.boundGroupId !== firstGroupId)) return null;
        const visibleGroupNodes = nodes.filter((node) => node.metadata?.boundGroupId === firstGroupId && !isHiddenBatchChild(node, nodes, collapsingBatchIds));
        return visibleGroupNodes.length > 1 && visibleGroupNodes.every((node) => selectedNodeIds.has(node.id)) ? firstGroupId : null;
    }, [collapsingBatchIds, nodes, selectedNodeIds, selectedVisibleNodes]);
    const groupFrameBorderWidth = Math.max(0.5, 1 / viewport.k);
    const groupHandleSize = Math.max(4, 10 / viewport.k);
    const groupHandleBorderWidth = Math.max(0.5, 1 / viewport.k);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);

    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const nodeInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);

    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          outputFormat: effectiveConfig.outputFormat,
                          outputCompression: effectiveConfig.outputCompression,
                          moderation: effectiveConfig.moderation,
                          count: 1,
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(shouldAutoOpenNodeDialog(newNode) ? newNode.id : null);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.moderation, effectiveConfig.outputCompression, effectiveConfig.outputFormat, effectiveConfig.size, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            const removedNodes = nodesRef.current.filter((node) => allIds.has(node.id));
            const remainingNodes = nodesRef.current.filter((node) => !allIds.has(node.id));
            const removedKeys = collectImageStorageKeys(removedNodes);
            const usedKeys = collectImageStorageKeys({ nodes: remainingNodes, chatSessions, assets: useAssetStore.getState().assets });
            void readStoredImageHistoryStorageKeys()
                .then((historyKeys) => {
                    historyKeys.forEach((key) => usedKeys.add(key));
                    const disposableKeys = [...removedKeys].filter((key) => !usedKeys.has(key));
                    if (!disposableKeys.length) return;
                    return deleteStoredImages(disposableKeys);
                })
                .catch((error) => message.error(error instanceof Error ? error.message : "图片文件删除失败"));
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                    const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || node.metadata.content,
                            naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                        },
                    };
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setLocalEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setImageTextEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setContextMenu((current) => (current && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, message, projectId],
    );

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setAngleNodeId(null);
        setLocalEditNodeId(null);
        setImageTextEditNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [chatSessions, cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(shouldAutoOpenNodeDialog(next) ? id : null);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...nextNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(nextNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(nextNodes.find((node) => shouldAutoOpenNodeDialog(node))?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        const normalizedEntry = { ...entry, nodes: normalizeCanvasNodes(entry.nodes, entry.connections) };
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(normalizedEntry.nodes);
        setConnections(normalizedEntry.connections);
        setChatSessions(normalizedEntry.chatSessions);
        setActiveChatId(normalizedEntry.activeChatId);
        setBackgroundMode(normalizedEntry.backgroundMode);
        setShowImageInfo(normalizedEntry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
        setToolbarNodeId(null);
        setTimeout(() => {
            lastHistoryRef.current = normalizedEntry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(`无限画布 ${useCanvasStore.getState().projects.length + 1}`);
        router.push(`/canvas/${id}`);
    }, [createProject, router]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        cleanupAssetImages();
        router.push("/canvas");
    }, [cleanupAssetImages, deleteProjects, projectId, router]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setSelectedConnectionId(null);

        const currentSelected = selectedNodeIdsRef.current;
        const currentNodes = nodesRef.current;
        const nextSelected = new Set(currentSelected);
        const clickedNode = currentNodes.find((node) => node.id === nodeId);
        if (!event.shiftKey && !event.metaKey && !event.ctrlKey && (clickedNode?.type === CanvasNodeType.Image || clickedNode?.type === CanvasNodeType.Video || clickedNode?.type === CanvasNodeType.Config)) {
            setDialogNodeId(nodeId);
        }
        const clickedGroupId = clickedNode?.metadata?.boundGroupId;
        const clickedGroupNodeIds = clickedGroupId ? currentNodes.filter((node) => node.metadata?.boundGroupId === clickedGroupId).map((node) => node.id) : [nodeId];
        const clickedGroupFullySelected = clickedGroupNodeIds.every((id) => nextSelected.has(id));

        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (clickedGroupFullySelected) {
                clickedGroupNodeIds.forEach((id) => nextSelected.delete(id));
            } else {
                clickedGroupNodeIds.forEach((id) => nextSelected.add(id));
            }
        } else {
            const alreadySelected = clickedGroupFullySelected || nextSelected.has(nodeId);
            if (!alreadySelected) {
                nextSelected.clear();
                clickedGroupNodeIds.forEach((id) => nextSelected.add(id));
            }
        }

        const expandedSelected = expandSelectionWithBoundGroups(nextSelected, currentNodes);
        setSelectedNodeIds(expandedSelected);
        const dragIds = new Set(expandedSelected);
        currentNodes.forEach((node) => {
            if (nextSelected.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const startGroupResize = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>, handle: GroupResizeHandle) => {
            event.preventDefault();
            event.stopPropagation();

            const selectedIds = selectedNodeIdsRef.current;
            if (selectedIds.size <= 1) return;

            const currentNodes = nodesRef.current;
            const selectedNodes = currentNodes.filter((node) => selectedIds.has(node.id) && !isHiddenBatchChild(node, currentNodes, collapsingBatchIds));
            if (selectedNodes.length <= 1) return;

            const left = Math.min(...selectedNodes.map((node) => node.position.x));
            const top = Math.min(...selectedNodes.map((node) => node.position.y));
            const right = Math.max(...selectedNodes.map((node) => node.position.x + node.width));
            const bottom = Math.max(...selectedNodes.map((node) => node.position.y + node.height));

            groupResizeRef.current = {
                isResizing: true,
                handle,
                startX: event.clientX,
                startY: event.clientY,
                hasMoved: false,
                bounds: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
                initialNodes: selectedNodes.map((node) => ({
                    id: node.id,
                    x: node.position.x,
                    y: node.position.y,
                    width: node.width,
                    height: node.height,
                    fontSize: typeof node.metadata?.fontSize === "number" ? node.metadata.fontSize : undefined,
                })),
            };
            historyPausedRef.current = true;
            nodeDraggingRef.current = true;
            setIsNodeDragging(true);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            document.body.style.cursor = groupResizeCursor(handle);
        },
        [collapsingBatchIds],
    );

    const finishGroupResize = useCallback(() => {
        if (!groupResizeRef.current.isResizing) return;
        groupResizeRef.current.isResizing = false;
        groupResizeRef.current.hasMoved = false;
        groupResizeRef.current.initialNodes = [];
        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        document.body.style.cursor = "default";
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            setNodes((prev) =>
                prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    if (!initial) return node;
                    return { ...node, position: { x: initial.x + dx, y: initial.y + dy } };
                }),
            );
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        if (wasClick && clickedNodeId) {
            setToolbarNodeId(clickedNodeId);
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type === CanvasNodeType.Image || clickedNode?.type === CanvasNodeType.Video || clickedNode?.type === CanvasNodeType.Config) {
                setDialogNodeId(clickedNodeId);
            } else if (shouldAutoOpenNodeDialog(clickedNode)) {
                setDialogNodeId(clickedNodeId);
            } else {
                setDialogNodeId(null);
            }
            if (clickedNode?.type !== CanvasNodeType.Text) setEditingNodeId(null);
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (groupResizeRef.current.isResizing) {
                event.preventDefault();
                const resize = groupResizeRef.current;
                const dx = (event.clientX - resize.startX) / currentViewport.k;
                const dy = (event.clientY - resize.startY) / currentViewport.k;
                const { bounds, handle } = resize;
                const startRight = bounds.left + bounds.width;
                const startBottom = bounds.top + bounds.height;
                let left = bounds.left;
                let top = bounds.top;
                let right = startRight;
                let bottom = startBottom;

                if (handle.includes("w")) left = Math.min(bounds.left + dx, startRight - GROUP_RESIZE_MIN_SIZE);
                if (handle.includes("e")) right = Math.max(startRight + dx, bounds.left + GROUP_RESIZE_MIN_SIZE);
                if (handle.includes("n")) top = Math.min(bounds.top + dy, startBottom - GROUP_RESIZE_MIN_SIZE);
                if (handle.includes("s")) bottom = Math.max(startBottom + dy, bounds.top + GROUP_RESIZE_MIN_SIZE);

                const nextWidth = Math.max(GROUP_RESIZE_MIN_SIZE, right - left);
                const nextHeight = Math.max(GROUP_RESIZE_MIN_SIZE, bottom - top);
                const scaleX = nextWidth / Math.max(1, bounds.width);
                const scaleY = nextHeight / Math.max(1, bounds.height);
                const averageScale = Math.max(0.1, (scaleX + scaleY) / 2);
                const initialById = new Map(resize.initialNodes.map((node) => [node.id, node]));

                if (Math.abs(event.clientX - resize.startX) > 3 || Math.abs(event.clientY - resize.startY) > 3) {
                    resize.hasMoved = true;
                }

                setNodes((prev) =>
                    prev.map((node) => {
                        const initial = initialById.get(node.id);
                        if (!initial) return node;
                        const metadata = node.type === CanvasNodeType.Text && typeof initial.fontSize === "number" ? { ...node.metadata, fontSize: Math.max(6, Math.round(initial.fontSize * averageScale)) } : node.metadata;
                        return {
                            ...node,
                            position: {
                                x: left + (initial.x - bounds.left) * scaleX,
                                y: top + (initial.y - bounds.top) * scaleY,
                            },
                            width: Math.max(1, initial.width * scaleX),
                            height: Math.max(1, initial.height * scaleY),
                            metadata,
                        };
                    }),
                );
                return;
            }

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                    setDialogNodeId(null);
                }

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const targetNodeId = getConnectableNodeAtPoint(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = targetNodeId;
                setConnectionTargetNodeId(targetNodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectableNodeAtPoint, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(expandSelectionWithBoundGroups(nextSelected, nodesRef.current));
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            if (groupResizeRef.current.isResizing) {
                finishGroupResize();
                return;
            }

            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const targetNodeId = getConnectableNodeAtPoint(event.clientX, event.clientY, currentConnection) || connectionTargetNodeIdRef.current;
                if (targetNodeId) {
                    connectNodes(currentConnection, targetNodeId);
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishGroupResize, finishNodeDrag, getConnectableNodeAtPoint, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            if (groupResizeRef.current.isResizing) {
                finishGroupResize();
                return;
            }
            finishNodeDrag(event.clientX, event.clientY);
        };
        const cancelNodeDrag = () => {
            finishGroupResize();
            finishNodeDrag();
        };
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishGroupResize, finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const getClipboardImageTargetNode = useCallback(() => {
        if (selectedNodeIdsRef.current.size !== 1) return null;
        const nodeId = Array.from(selectedNodeIdsRef.current)[0];
        const node = nodesRef.current.find((item) => item.id === nodeId) || null;
        if (!node) return null;
        if (node.type === CanvasNodeType.Config) return node;
        return node.type === CanvasNodeType.Image && !node.metadata?.content ? node : null;
    }, []);

    const createReferenceImageNodeForTarget = useCallback(async (file: File, targetNode: CanvasNodeData) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const existingImageInputs = buildNodeGenerationInputs(targetNode.id, nodesRef.current, connectionsRef.current).filter((input) => input.type === "image").length;
        const gap = 96;
        const stackGap = 24;
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: {
                x: targetNode.position.x - gap - size.width - existingImageInputs * (size.width + stackGap),
                y: targetNode.position.y + targetNode.height / 2 - size.height / 2,
            },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: newNode.id, toNodeId: targetNode.id }]);
        setSelectedNodeIds(new Set([newNode.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const handleNodePromptPasteImage = useCallback(
        (nodeId: string, file: File) => {
            const targetNode = nodesRef.current.find((node) => node.id === nodeId) || null;
            if (!targetNode) return false;
            if (targetNode.type !== CanvasNodeType.Config && (targetNode.type !== CanvasNodeType.Image || Boolean(targetNode.metadata?.content))) return false;
            void createReferenceImageNodeForTarget(file, targetNode);
            message.success("已为当前生成节点添加参考图");
            return true;
        },
        [createReferenceImageNodeForTarget, message],
    );

    const removeNodeReference = useCallback(
        (nodeId: string, referenceNodeId: string) => {
            const removedConnectionIds = connectionsRef.current.filter((connection) => connection.fromNodeId === referenceNodeId && connection.toNodeId === nodeId).map((connection) => connection.id);
            if (!removedConnectionIds.length) return;
            const removedConnectionIdSet = new Set(removedConnectionIds);
            setConnections((prev) => prev.filter((connection) => !removedConnectionIdSet.has(connection.id)));
            setSelectedConnectionId((current) => (current && removedConnectionIdSet.has(current) ? null : current));
            message.success("已取消参考图连线");
        },
        [message],
    );

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    const pasteImageFileToCanvas = useCallback(
        (file: File, position = getCanvasCenter()) => {
            const targetNode = getClipboardImageTargetNode();
            if (targetNode) {
                void createReferenceImageNodeForTarget(file, targetNode);
                message.success("已为当前生成节点添加参考图");
            } else {
                void createImageFileNode(file, position);
                message.success("已从剪切板添加图片");
            }
        },
        [createImageFileNode, createReferenceImageNodeForTarget, getCanvasCenter, getClipboardImageTargetNode, message],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        try {
            const items = await navigator.clipboard.read();
            const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
            if (imageItem) {
                const imageType = imageItem.types.find((type) => type.startsWith("image/"));
                if (!imageType) return;
                const blob = await imageItem.getType(imageType);
                pasteImageFileToCanvas(new File([blob], "clipboard-image.png", { type: imageType }));
                return;
            }

            const text = await navigator.clipboard.readText();
            if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
        } catch (error) {
            console.warn("System clipboard read failed; waiting for paste event fallback.", error);
        }
    }, [createTextNodeFromClipboard, message, pasteImageFileToCanvas]);

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            if (isEditableEventTarget(event.target)) return;

            const file = getClipboardImageFile(event.clipboardData);
            if (file) {
                event.preventDefault();
                pasteImageFileToCanvas(file);
                return;
            }

            const text = event.clipboardData?.getData("text/plain") || "";
            if (createTextNodeFromClipboard(text)) {
                event.preventDefault();
                message.success("已从剪切板添加文本");
            }
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [createTextNodeFromClipboard, message, pasteImageFileToCanvas]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isEditableEventTarget(event.target)) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                if (pasteCopiedNodes()) {
                    event.preventDefault();
                    return;
                }
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    removeConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setLocalEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, removeConnection, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position, metadataPatch?: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? {
                          ...node,
                          width,
                          height,
                          position: position || node.position,
                          metadata: metadataPatch ? { ...node.metadata, ...metadataPatch } : node.metadata,
                      }
                    : node,
            ),
        );
    }, []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, []);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const openNodePanel = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Config)) return;
        setSelectedNodeIds(new Set([nodeId]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setEditingNodeId(null);
        setDialogNodeId(nodeId);
    }, []);

    useEffect(() => {
        if (editingNodeId) return;
        setNodes((prev) => {
            const next = prev.filter((node) => hasRenderableTextContent(node));
            return next.length === prev.length ? prev : next;
        });
    }, [editingNodeId]);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const getSelectedGroupNodes = useCallback(() => {
        const currentNodes = nodesRef.current;
        return currentNodes.filter((node) => selectedNodeIdsRef.current.has(node.id) && !isHiddenBatchChild(node, currentNodes, collapsingBatchIds));
    }, [collapsingBatchIds]);

    const alignSelectedNodes = useCallback(
        (alignment: "left" | "centerY" | "right") => {
            const selectedNodes = getSelectedGroupNodes();
            if (selectedNodes.length <= 1) return;
            const bounds = getNodesBounds(selectedNodes);
            if (!bounds) return;
            const selectedIds = new Set(selectedNodes.map((node) => node.id));
            const centerY = bounds.top + bounds.height / 2;
            const right = bounds.left + bounds.width;
            setNodes((prev) =>
                prev.map((node) => {
                    if (!selectedIds.has(node.id)) return node;
                    if (alignment === "left") return { ...node, position: { ...node.position, x: bounds.left } };
                    if (alignment === "right") return { ...node, position: { ...node.position, x: right - node.width } };
                    return { ...node, position: { ...node.position, y: centerY - node.height / 2 } };
                }),
            );
            message.success("图片已对齐");
        },
        [getSelectedGroupNodes, message],
    );

    const autoLayoutSelectedNodes = useCallback(() => {
        const selectedNodes = getSelectedGroupNodes();
        if (selectedNodes.length <= 1) return;
        const bounds = getNodesBounds(selectedNodes);
        if (!bounds) return;
        let cursorX = bounds.left;
        const centerY = bounds.top + bounds.height / 2;
        const nextPositionById = new Map<string, Position>();
        [...selectedNodes]
            .sort((first, second) => first.position.x - second.position.x || first.position.y - second.position.y)
            .forEach((node) => {
                nextPositionById.set(node.id, { x: cursorX, y: centerY - node.height / 2 });
                cursorX += node.width + MULTI_SELECT_LAYOUT_GAP;
            });
        setNodes((prev) => prev.map((node) => (nextPositionById.has(node.id) ? { ...node, position: nextPositionById.get(node.id)! } : node)));
    }, [getSelectedGroupNodes]);

    const bindSelectedNodes = useCallback(() => {
        const selectedNodes = getSelectedGroupNodes();
        if (selectedNodes.length <= 1) return;
        const selectedIds = new Set(selectedNodes.map((node) => node.id));
        const groupId = `bound-${nanoid()}`;
        setNodes((prev) => prev.map((node) => (selectedIds.has(node.id) ? { ...node, metadata: { ...node.metadata, boundGroupId: groupId } } : node)));
        setSelectedNodeIds(new Set(selectedIds));
        setSelectedConnectionId(null);
        message.success("已绑定元素");
    }, [getSelectedGroupNodes, message]);

    const unbindSelectedNodes = useCallback(() => {
        const selectedNodes = getSelectedGroupNodes();
        if (selectedNodes.length <= 1) return;
        const selectedIds = new Set(selectedNodes.map((node) => node.id));
        const groupIds = new Set(selectedNodes.map((node) => node.metadata?.boundGroupId).filter((id): id is string => Boolean(id)));
        setNodes((prev) =>
            prev.map((node) => {
                if (!selectedIds.has(node.id) && (!node.metadata?.boundGroupId || !groupIds.has(node.metadata.boundGroupId))) return node;
                return { ...node, metadata: withoutBoundGroupId(node.metadata) };
            }),
        );
        message.success("已解绑元素");
    }, [getSelectedGroupNodes, message]);

    const exportSelectedNodes = useCallback(async () => {
        const selectedNodes = getSelectedGroupNodes();
        const bounds = getNodesBounds(selectedNodes);
        if (selectedNodes.length <= 1 || !bounds) return;
        const key = "canvas-selection-export";
        message.open({ key, type: "loading", content: "正在导出选中元素...", duration: 0 });
        try {
            const blob = await renderCanvasNodesToPngBlob(selectedNodes, bounds);
            saveAs(blob, `canvas-selection-${Date.now()}.png`);
            message.open({ key, type: "success", content: "已导出选中元素" });
        } catch (error) {
            message.open({ key, type: "error", content: error instanceof Error ? error.message : "导出失败" });
        }
    }, [getSelectedGroupNodes, message]);

    const mergeSelectedNodes = useCallback(async () => {
        const selectedNodes = getSelectedGroupNodes();
        const bounds = getNodesBounds(selectedNodes);
        if (selectedNodes.length <= 1 || !bounds) return;
        const key = "canvas-selection-merge";
        message.open({ key, type: "loading", content: "正在合并图层...", duration: 0 });
        try {
            const blob = await renderCanvasNodesToPngBlob(selectedNodes, bounds);
            const uploaded = await storeImageBlobLocally(blob);
            const selectedIds = new Set(selectedNodes.map((node) => node.id));
            const mergedId = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const mergedNode: CanvasNodeData = {
                id: mergedId,
                type: CanvasNodeType.Image,
                title: "合并图层",
                position: { x: bounds.left, y: bounds.top },
                width: bounds.width,
                height: bounds.height,
                metadata: { ...imageMetadata(uploaded), prompt: "合并图层", freeResize: true, mergedLayer: true },
            };
            setNodes((prev) => [...prev.filter((node) => !selectedIds.has(node.id)), mergedNode]);
            setConnections((prev) => prev.filter((connection) => !selectedIds.has(connection.fromNodeId) && !selectedIds.has(connection.toNodeId)));
            setSelectedNodeIds(new Set([mergedId]));
            setSelectedConnectionId(null);
            setToolbarNodeId(mergedId);
            setDialogNodeId(null);
            message.open({ key, type: "success", content: "图层合并完成" });
        } catch (error) {
            message.open({ key, type: "error", content: error instanceof Error ? error.message : "合并失败" });
        }
    }, [getSelectedGroupNodes, message]);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : imageExtension(node.metadata.content)}`);
    }, []);

    const exportLayerPsd = useCallback(
        async (node: CanvasNodeData) => {
            const key = `export-psd-${node.id}`;
            message.open({ key, type: "loading", content: "正在导出 PSD...", duration: 0 });
            try {
                const result = await buildLayerGroupPsd(node, nodesRef.current, connectionsRef.current);
                saveAs(result.blob, result.fileName);
                message.open({ key, type: "success", content: `已导出当前分层组 PSD（${result.layerCount} 层）` });
            } catch (error) {
                message.open({ key, type: "error", content: error instanceof Error ? error.message : "PSD 导出失败" });
            }
        },
        [message],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success("已加入我的素材");
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success("已加入我的素材");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success("已加入我的素材");
        },
        [addAsset, message],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(null);
        setCropNodeId(null);
    }, []);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationStartedAt = Date.now();
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(null);
            try {
                const image = await requestEdit(generationConfig, prompt, [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }]).then(
                    (items) => items[0],
                );
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, durationMs: Date.now() - generationStartedAt, ...generationMetadata } } : item,
                    ),
                );
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, durationMs: Date.now() - generationStartedAt } } : item)));
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, openConfigDialog],
    );

    const localEditImageNode = useCallback(
        (node: CanvasNodeData, rect: CanvasImageRect, prompt: string) => {
            if (!node.metadata?.content) return;
            const reference = sourceNodeReferenceImages(node)[0];
            if (!reference) return;

            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const draftPrompt = buildLocalEditDraftPrompt(prompt);
            const generationMetadata: CanvasNodeMetadata = {
                ...buildImageGenerationMetadata("edit", generationConfig, 1, [reference]),
                editSourceNodeId: node.id,
                editMaskRect: rect,
            };

            setLocalEditNodeId(null);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: "局部编辑",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt: draftPrompt, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
        },
        [effectiveConfig],
    );

    const applyImageTextEditNode = useCallback(
        async (node: CanvasNodeData, changes: CanvasImageTextEditChange[]) => {
            if (!node.metadata?.content || !changes.length) return;
            const reference = sourceNodeReferenceImages(node)[0];
            if (!reference) return;

            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const prompt = buildImageTextEditPrompt(changes);
            const generationStartedAt = Date.now();
            const generationMetadata: CanvasNodeMetadata = {
                ...buildImageGenerationMetadata("edit", generationConfig, 1, [reference]),
                editSourceNodeId: node.id,
            };

            setImageTextEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: "文字修改",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, hidePromptPanel: true, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);

            try {
                const image = await requestEdit(generationConfig, prompt, [reference]).then((items) => items[0]);
                const resultDataUrl = await restoreTransparentBackdropForTransparentReference(reference, image.dataUrl);
                const uploaded = await uploadImage(resultDataUrl);
                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, durationMs: Date.now() - generationStartedAt, hidePromptPanel: true, ...generationMetadata },
                              }
                            : item,
                    ),
                );
                message.success("已生成文字修改图片");
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "文字修改失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, durationMs: Date.now() - generationStartedAt, hidePromptPanel: true } } : item)));
                message.error(errorDetails);
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, isAiConfigReady, message, openConfigDialog],
    );

    const removeBackgroundNode = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const reference = sourceNodeReferenceImages(node)[0];
            if (!reference) return;

            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const generationStartedAt = Date.now();
            const sourceMetrics = canvasImageSourceMetrics(node);
            const generationMetadata = buildRemoveBackgroundMetadata(reference, sourceMetrics);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: "去背景",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, removeBackground: true, hidePromptPanel: true, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            try {
                const removeBackgroundResult = await requestRemoveBackground(reference, buildGenerationConfig(effectiveConfig, node, "image"));
                const uploaded = await storeImageBlobLocally(removeBackgroundResult.blob);
                const size = removeBackgroundNodeSize(uploaded, sourceMetrics, removeBackgroundResult);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === childId
                            ? {
                                  ...item,
                                  width: size.width,
                                  height: size.height,
                                  metadata: {
                                      ...item.metadata,
                                      ...imageMetadata(uploaded),
                                      ...removeBackgroundResultMetadata(removeBackgroundResult),
                                      durationMs: Date.now() - generationStartedAt,
                                      removeBackground: true,
                                      hidePromptPanel: true,
                                      ...generationMetadata,
                                  },
                              }
                            : item,
                    ),
                );
                message.success("已生成去背景图片");
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "去背景失败";
                setNodes((prev) =>
                    prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, durationMs: Date.now() - generationStartedAt, removeBackground: true, hidePromptPanel: true } } : item)),
                );
            } finally {
                setRunningNodeId(null);
            }
        },
        [message],
    );

    const layerImageNode = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            const reference = sourceNodeReferenceImages(node)[0];
            const sourceMetrics = canvasImageSourceMetrics(node);
            if (!reference || !sourceMetrics) return;

            const loadingKey = `layer-image-${node.id}`;
            setRunningNodeId(node.id);
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.open({ key: loadingKey, type: "loading", content: "智能分层中...", duration: 0 });

            try {
                const result = await requestLayerImage(reference, buildGenerationConfig(effectiveConfig, node, "image"));
                const backgroundSource = result.backgroundDataUrl || (!result.productDataUrl ? result.compositeDataUrl : "");
                const [backgroundImage, productImage] = await Promise.all([backgroundSource ? uploadImage(backgroundSource) : Promise.resolve(null), result.productDataUrl ? uploadImage(result.productDataUrl) : Promise.resolve(null)]);
                const baseX = node.position.x + node.width + 96;
                const baseY = node.position.y;
                const scaleX = sourceMetrics.displayWidth / Math.max(1, result.originalWidth);
                const scaleY = sourceMetrics.displayHeight / Math.max(1, result.originalHeight);
                const derivedMetadata = buildDerivedImageMetadata(reference);
                const layerGroupId = nanoid();
                const layerSourceId = node.id;
                const layerNodes: CanvasNodeData[] = [];

                if (backgroundImage) {
                    const backgroundId = nanoid();
                    layerNodes.push({
                        id: backgroundId,
                        type: CanvasNodeType.Image,
                        title: "背景层",
                        position: { x: baseX, y: baseY },
                        width: sourceMetrics.displayWidth,
                        height: sourceMetrics.displayHeight,
                        metadata: { ...imageMetadata(backgroundImage), ...derivedMetadata, layerGroupId, layerSourceId, layerRole: "background" },
                    });
                }

                if (productImage) {
                    const productId = nanoid();
                    layerNodes.push({
                        id: productId,
                        type: CanvasNodeType.Image,
                        title: "主体层",
                        position: {
                            x: baseX + result.productOffsetX * scaleX,
                            y: baseY + result.productOffsetY * scaleY,
                        },
                        width: Math.max(1, result.productWidth * scaleX || productImage.width),
                        height: Math.max(1, result.productHeight * scaleY || productImage.height),
                        metadata: { ...imageMetadata(productImage), ...derivedMetadata, layerGroupId, layerSourceId, layerRole: "product" },
                    });
                }

                const textNodes = createLayerTextNodes(result.textLayers, {
                    baseX,
                    baseY,
                    displayWidth: sourceMetrics.displayWidth,
                    scaleX,
                    scaleY,
                    productOffsetX: result.productOffsetX,
                    productOffsetY: result.productOffsetY,
                    productWidth: productImage ? result.productWidth : 0,
                    productHeight: productImage ? result.productHeight : 0,
                    layerGroupId,
                    layerSourceId,
                });
                textNodes.forEach((textNode) => {
                    layerNodes.push(textNode);
                });

                if (!layerNodes.length) throw new Error("智能分层结果为空");
                setNodes((prev) => [...prev, ...layerNodes]);
                setSelectedNodeIds(new Set([layerNodes.find((item) => item.title === "主体层")?.id || layerNodes[layerNodes.length - 1].id]));
                const layerNames = [backgroundImage ? "背景层" : "", productImage ? "主体层" : "", textNodes.length ? `${textNodes.length} 个文字层` : ""].filter(Boolean);
                message.open({ key: loadingKey, type: "success", content: `已生成${layerNames.join("、")}` });
            } catch (error) {
                message.open({ key: loadingKey, type: "error", content: error instanceof Error ? error.message : "智能分层失败" });
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, message],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            const target = uploadTargetRef.current;
            if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) return;

            if (target?.nodeId) {
                if (file.type.startsWith("video/")) {
                    const video = await uploadMediaFile(file, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: file.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(null);
                    uploadTargetRef.current = null;
                    event.target.value = "";
                    return;
                }
                const image = await uploadImage(file);
                const size = fitNodeSize(image.width, image.height);
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === target.nodeId
                            ? {
                                  ...node,
                                  type: CanvasNodeType.Image,
                                  title: file.name,
                                  width: size.width,
                                  height: size.height,
                                  metadata: {
                                      ...node.metadata,
                                      ...imageMetadata(image),
                                      errorDetails: undefined,
                                      freeResize: false,
                                      isBatchRoot: undefined,
                                      batchRootId: undefined,
                                      batchChildIds: undefined,
                                      batchUsesReferenceImages: undefined,
                                      generationType: undefined,
                                      model: undefined,
                                      size: undefined,
                                      quality: undefined,
                                      outputFormat: undefined,
                                      outputCompression: undefined,
                                      moderation: undefined,
                                      count: undefined,
                                      references: undefined,
                                      editSourceNodeId: undefined,
                                      editMaskRect: undefined,
                                      primaryImageId: undefined,
                                      imageBatchExpanded: undefined,
                                  },
                              }
                            : node,
                    ),
                );
                setSelectedNodeIds(new Set([target.nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(null);
            } else {
                const position = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                void (file.type.startsWith("video/") ? createVideoFileNode(file, position) : createImageFileNode(file, position));
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/") || item.type.startsWith("video/"));
            if (!file) return;

            const pos = screenToCanvas(event.clientX, event.clientY);
            void (file.type.startsWith("video/") ? createVideoFileNode(file, pos) : createImageFileNode(file, pos));
        },
        [createImageFileNode, createVideoFileNode, screenToCanvas],
    );

    const pasteAssistantImage = useCallback(
        (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            void createImageFileNode(file, position);
            message.success("已从剪切板添加图片");
        },
        [createImageFileNode, message, screenToCanvas, size.height, size.width],
    );

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
    }, []);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const localEditSourceNode = mode === "image" ? resolveLocalEditSourceNode(sourceNode, nodesRef.current, connectionsRef.current) : null;
            const localEditRect = sourceNode?.metadata?.editMaskRect;
            const isLocalEditDraft = Boolean(mode === "image" && sourceNode?.type === CanvasNodeType.Image && !sourceNode.metadata?.content && localEditRect && localEditSourceNode?.metadata?.content);
            if (isLocalEditDraft && sourceNode && localEditRect && localEditSourceNode) {
                const effectivePrompt = prompt.trim();
                if (!effectivePrompt) return;

                const singleImageConfig = { ...generationConfig, count: "1" };
                const generationStartedAt = Date.now();
                setRunningNodeId(nodeId);
                setSelectedNodeIds(new Set([nodeId]));
                setSelectedConnectionId(null);
                setDialogNodeId(null);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: effectivePrompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, errorDetails: undefined } } : node)),
                );

                try {
                    const mergedDataUrl = await requestLocalEditComposite(singleImageConfig, effectivePrompt, localEditSourceNode, localEditRect);
                    const uploaded = await uploadImage(mergedDataUrl);
                    const imageSize = fitNodeSize(uploaded.width, uploaded.height, sourceNode.width, sourceNode.height);
                    const generationMetadata: CanvasNodeMetadata = {
                        ...buildImageGenerationMetadata("edit", singleImageConfig, 1, sourceNodeReferenceImages(localEditSourceNode)),
                        editSourceNodeId: localEditSourceNode.id,
                        editMaskRect: localEditRect,
                    };
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId
                                ? {
                                      ...node,
                                      width: imageSize.width,
                                      height: imageSize.height,
                                      position: {
                                          x: node.position.x + node.width / 2 - imageSize.width / 2,
                                          y: node.position.y + node.height / 2 - imageSize.height / 2,
                                      },
                                      metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: effectivePrompt, durationMs: Date.now() - generationStartedAt, ...generationMetadata },
                                  }
                                : node,
                        ),
                    );
                } catch (error) {
                    const errorDetails = error instanceof Error ? error.message : "生成失败";
                    message.error(errorDetails);
                    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, durationMs: Date.now() - generationStartedAt } } : node)));
                } finally {
                    setRunningNodeId(null);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && mode === "text") {
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            const generationStartedAt = Date.now();
            if (markSourceStatus)
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const referenceImages = sourceReference.length ? sourceReference : generationContext.referenceImages;
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const gap = 96;
                    const rowGap = 36;
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + gap,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            startedAt: generationStartedAt,
                            durationMs: undefined,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36),
                            y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + rowGap),
                        },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    const batchConnections = [...(isEmptyImageNode ? [] : [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]), ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))];

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, startedAt: generationStartedAt, durationMs: undefined, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                        ...childNodes,
                    ]);
                    setConnections((prev) => [...prev, ...batchConnections]);
                    setSelectedNodeIds(new Set([isConfigNode ? nodeId : rootId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(null);

                    let hasSuccess = false;
                    let hasFailure = false;
                    await Promise.all(
                        targetIds.map(async (targetId) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt).then((items) => items[0]);
                                const uploaded = await uploadImage(image.dataUrl);
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded), primaryImageId: targetId, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt) },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded), durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt) },
                                            };
                                        return node;
                                    });
                                });
                                hasSuccess = true;
                                if (isConfigNode)
                                    setNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: undefined } } : node,
                                        ),
                                    );
                                return true;
                            } catch (error) {
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                hasFailure = true;
                                setNodes((prev) =>
                                    prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails } } : node)),
                                );
                                return false;
                            }
                        }),
                    );
                    if (hasFailure) message.error(hasSuccess ? "部分图片生成失败" : "全部图片生成失败");
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? {
                                      ...node,
                                      metadata: {
                                          ...node.metadata,
                                          status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                          durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt),
                                          errorDetails: hasSuccess ? undefined : "全部图片生成失败",
                                      },
                                  }
                                : node.id === nodeId && isEmptyImageNode
                                  ? {
                                        ...node,
                                        metadata: {
                                            ...node.metadata,
                                            status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                            durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt),
                                            errorDetails: hasSuccess ? undefined : "全部图片生成失败",
                                        },
                                    }
                                  : node.id === rootId && !hasSuccess
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - (node.metadata?.startedAt || generationStartedAt), errorDetails: "全部图片生成失败" } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            references: generationContext.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    setSelectedNodeIds(new Set([videoId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(null);
                    const video = await uploadMediaFile(await requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages), "video");
                    const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === videoId
                                ? {
                                      ...node,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...node.metadata,
                                          ...videoMetadata(video),
                                          prompt: effectivePrompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          references: generationContext.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
                                      },
                                  }
                                : node,
                        ),
                    );
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: prompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt, status: NODE_STATUS_LOADING, fontSize: 14 },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, prompt, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const answers = await Promise.all(
                    (childIds.length ? childIds : [nodeId]).map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(generationConfig, buildNodeChatMessages({ ...generationContext, prompt: effectivePrompt }), (text) => {
                            localStreamed = text;
                            streamed = text;
                            if (isConfigNode) return;
                            setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                        }).then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }));
                    }),
                );
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? { ...node, type: CanvasNodeType.Text, title: prompt.slice(0, 32) || "Generated Text", metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                                : node,
                    ),
                );
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, openConfigDialog],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const connectedImageSourceNode = findConnectedSourceImageNode(node.id, nodesRef.current, connectionsRef.current);
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const isRemoveBackgroundNode = Boolean(savedImageMetadata?.removeBackground || node.metadata?.removeBackground || node.title === "去背景" || isRemoveBackgroundPrompt(savedImageMetadata?.prompt || node.metadata?.prompt));
            const isLocalEditNode = Boolean(savedImageMetadata?.editMaskRect);
            const isImageTextEditNode = Boolean(savedImageMetadata?.hidePromptPanel || (node.title === "文字修改" && savedImageMetadata?.editSourceNodeId && savedImageMetadata?.generationType === "edit"));
            const localEditSourceNode = isLocalEditNode && savedImageMetadata ? (savedImageMetadata.editSourceNodeId ? nodesRef.current.find((item) => item.id === savedImageMetadata.editSourceNodeId) || null : null) || connectedImageSourceNode : null;
            const baseGenerationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          outputFormat: savedImageMetadata.outputFormat || effectiveConfig.outputFormat,
                          outputCompression: savedImageMetadata.outputCompression || effectiveConfig.outputCompression,
                          moderation: savedImageMetadata.moderation || effectiveConfig.moderation,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : "image"), count: "1" };
            const generationConfig = isRemoveBackgroundNode ? null : baseGenerationConfig;
            if (generationConfig && !isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context =
                isRemoveBackgroundNode || hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!isRemoveBackgroundNode && !prompt) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            if (isLocalEditNode && (!savedImageMetadata?.editMaskRect || !localEditSourceNode?.metadata?.content)) {
                const errorDetails = "局部编辑源图已丢失，无法继续重试";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
                return;
            }
            const generationType = isRemoveBackgroundNode ? "edit" : savedImageMetadata?.generationType;
            const useReferenceImages = isRemoveBackgroundNode ? true : isLocalEditNode ? true : generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages = isLocalEditNode
                ? sourceNodeReferenceImages(localEditSourceNode)
                : isRemoveBackgroundNode
                  ? hasSavedImageMetadata && savedImageMetadata
                      ? await resolveMetadataReferences(savedImageMetadata)
                      : sourceNodeReferenceImages(connectedImageSourceNode)
                  : hasSavedImageMetadata && savedImageMetadata
                    ? await resolveMetadataReferences(savedImageMetadata)
                    : useReferenceImages
                      ? context?.referenceImages.length
                          ? context.referenceImages
                          : sourceNodeReferenceImages(batchRoot || sourceNode)
                      : [];
            if (useReferenceImages && (!retryReferenceImages || !retryReferenceImages.length)) {
                const errorDetails = isLocalEditNode ? "局部编辑源图已丢失，无法继续重试" : "参考图片已丢失，无法继续重试";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
                return;
            }

            const retryStartedAt = Date.now();
            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, startedAt: retryStartedAt, durationMs: undefined, errorDetails: undefined } } : item)));

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context || !generationConfig) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(generationConfig, buildNodeChatMessages({ ...context, prompt }), (text) => {
                        streamed = text;
                        setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                    });
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    if (!generationConfig) return;
                    const video = await uploadMediaFile(await requestVideoGeneration(generationConfig, prompt, retryReferenceImages || []), "video");
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: { ...item.metadata, ...videoMetadata(video), prompt, model: generationConfig.model, size: generationConfig.size, seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality },
                                  }
                                : item,
                        ),
                    );
                    return;
                }

                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                if (isRemoveBackgroundNode) {
                    const reference = retryReferenceImages?.[0];
                    if (!reference) throw new Error("参考图片已丢失，无法继续重试");
                    const removeBackgroundResult = await requestRemoveBackground(reference, buildGenerationConfig(effectiveConfig, connectedImageSourceNode || sourceNode, "image"));
                    const uploadedImage = await storeImageBlobLocally(removeBackgroundResult.blob);
                    const sourceMetrics = removeBackgroundSourceMetrics(node, nodesRef.current, connectionsRef.current) || canvasImageSourceMetrics(connectedImageSourceNode);
                    const imageSize = removeBackgroundNodeSize(uploadedImage, sourceMetrics, removeBackgroundResult);
                    const generationMetadata = buildRemoveBackgroundMetadata(reference, sourceMetrics);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      type: CanvasNodeType.Image,
                                      width: imageSize.width,
                                      height: imageSize.height,
                                      metadata: {
                                          ...item.metadata,
                                          ...imageMetadata(uploadedImage),
                                          ...removeBackgroundResultMetadata(removeBackgroundResult),
                                          durationMs: Date.now() - retryStartedAt,
                                          removeBackground: true,
                                          hidePromptPanel: true,
                                          ...generationMetadata,
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }

                if (!generationConfig) return;
                let generatedDataUrl =
                    isLocalEditNode && localEditSourceNode?.metadata?.content && savedImageMetadata?.editMaskRect
                        ? await requestLocalEditComposite(generationConfig, prompt, localEditSourceNode, savedImageMetadata.editMaskRect)
                        : (useReferenceImages ? await requestEdit(generationConfig, prompt, retryReferenceImages || []).then((items) => items[0]) : await requestGeneration(generationConfig, prompt).then((items) => items[0])).dataUrl;
                if (isImageTextEditNode && useReferenceImages && retryReferenceImages?.[0]) {
                    generatedDataUrl = await restoreTransparentBackdropForTransparentReference(retryReferenceImages[0], generatedDataUrl);
                }
                const uploadedImage = await uploadImage(generatedDataUrl);
                const imageSize = fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                const generationMetadata = isLocalEditNode
                    ? {
                          ...buildImageGenerationMetadata("edit", generationConfig, savedImageMetadata?.count || 1, retryReferenceImages || []),
                          editSourceNodeId: localEditSourceNode?.id || savedImageMetadata?.editSourceNodeId,
                          editMaskRect: savedImageMetadata?.editMaskRect,
                      }
                    : savedImageMetadata?.generationType
                      ? {
                            generationType: savedImageMetadata.generationType,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            quality: generationConfig.quality,
                            outputFormat: generationConfig.outputFormat,
                            outputCompression: generationConfig.outputCompression,
                            moderation: generationConfig.moderation,
                            count: savedImageMetadata.count || 1,
                            references: savedImageMetadata.references,
                            editSourceNodeId: savedImageMetadata.editSourceNodeId,
                            editMaskRect: savedImageMetadata.editMaskRect,
                        }
                      : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryReferenceImages || []);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: isRemoveBackgroundNode
                                      ? { ...item.metadata, ...imageMetadata(uploadedImage), durationMs: Date.now() - retryStartedAt, removeBackground: true, hidePromptPanel: true, ...generationMetadata }
                                      : { ...item.metadata, ...imageMetadata(uploadedImage), prompt, durationMs: Date.now() - retryStartedAt, hidePromptPanel: isImageTextEditNode || item.metadata?.hidePromptPanel, ...generationMetadata },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, durationMs: Date.now() - retryStartedAt, errorDetails } } : item)));
            } finally {
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, message, openConfigDialog],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    outputFormat: effectiveConfig.outputFormat,
                    outputCompression: effectiveConfig.outputCompression,
                    moderation: effectiveConfig.moderation,
                    count: 1,
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.moderation, effectiveConfig.outputCompression, effectiveConfig.outputFormat, effectiveConfig.size, message],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => router.push("/")}
                    onProjects={() => router.push("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    assistantCollapsed={assistantCollapsed}
                    onExpandAssistant={() => {
                        setAssistantMounted(true);
                        setAssistantCollapsed(false);
                    }}
                />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    interactionMode={canvasTool}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "auto", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .filter((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                return Boolean(from && to && !isHiddenBatchConnectionEndpoint(from, nodes) && !isHiddenBatchConnectionEndpoint(to, nodes));
                            })
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        onSelect={() => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu(null);
                                        }}
                                        onDelete={() => removeConnection(connection.id)}
                                    />
                                );
                            })}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            isEditingRequested={editingNodeId === node.id}
                            showPanel={
                                dialogNodeId === node.id && selectedNodeIds.size === 1 && selectedNodeIds.has(node.id) && !selectionBox && imageTextEditNodeId !== node.id && localEditNodeId !== node.id && cropNodeId !== node.id && angleNodeId !== node.id
                            }
                            batchCount={batchChildCountById.get(node.id) || 0}
                            batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                            batchClosing={Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId))}
                            batchOpening={openingBatchIds.has(node.id)}
                            batchRecovering={collapsingBatchIds.has(node.id)}
                            batchMotion={batchMotionById.get(node.id)}
                            showImageInfo={showImageInfo}
                            renderPanel={(panelNode) => (
                                <CanvasNodePromptPanel
                                    node={panelNode}
                                    inputs={nodeInputsById.get(panelNode.id) || []}
                                    isRunning={runningNodeId === panelNode.id}
                                    onPromptChange={handleNodePromptChange}
                                    onConfigChange={handleConfigNodeChange}
                                    onGenerate={handleGenerateNode}
                                    onPasteImage={handleNodePromptPasteImage}
                                    onPreviewReference={setPreviewNodeId}
                                    onRemoveReference={removeNodeReference}
                                    onImageSettingsOpenChange={(open) => {
                                        setNodeImageSettingsOpen(open);
                                        if (open) setToolbarNodeId(null);
                                    }}
                                />
                            )}
                            renderNodeContent={(contentNode) => (
                                <CanvasConfigNodePanel
                                    node={contentNode}
                                    isRunning={runningNodeId === contentNode.id}
                                    inputSummary={getInputSummary(nodeInputsById.get(contentNode.id) || [])}
                                    inputs={nodeInputsById.get(contentNode.id) || []}
                                    onConfigChange={handleConfigNodeChange}
                                    onTextInputChange={handleNodeContentChange}
                                    onGenerate={(nodeId) => {
                                        const target = nodesRef.current.find((item) => item.id === nodeId);
                                        void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.prompt || "");
                                    }}
                                />
                            )}
                            onMouseDown={handleNodeMouseDown}
                            onOpenPanel={openNodePanel}
                            onHoverStart={(nodeId) => {
                                if (nodeDraggingRef.current) return;
                                setHoveredNodeId(nodeId);
                                keepNodeToolbar(nodeId);
                            }}
                            onHoverEnd={(nodeId) => {
                                setHoveredNodeId((current) => (current === nodeId ? null : current));
                                hideNodeToolbar();
                            }}
                            onConnectStart={handleConnectStart}
                            onResize={handleNodeResize}
                            onContentChange={handleNodeContentChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onRetry={(node) => void handleRetryNode(node)}
                            onGenerateImage={generateImageFromTextNode}
                            onViewImage={(node) => setPreviewNodeId(node.id)}
                            onContextMenu={(event, id) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
                            }}
                        />
                    ))}

                    {selectedGroupBounds && !selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[95]"
                            style={{
                                left: selectedGroupBounds.left,
                                top: selectedGroupBounds.top,
                                width: selectedGroupBounds.width,
                                height: selectedGroupBounds.height,
                                border: `${groupFrameBorderWidth}px solid #b8d4ff`,
                                background: "transparent",
                                boxSizing: "border-box",
                            }}
                        >
                            {GROUP_RESIZE_HANDLES.map((item) => (
                                <div
                                    key={item.handle}
                                    data-canvas-no-zoom
                                    className="pointer-events-auto absolute rounded-[2px] bg-white"
                                    style={{
                                        left: item.left,
                                        top: item.top,
                                        width: groupHandleSize,
                                        height: groupHandleSize,
                                        transform: item.transform,
                                        border: `${groupHandleBorderWidth}px solid #b8d4ff`,
                                        boxShadow: `0 0 0 ${Math.max(0.5, 1 / viewport.k)}px rgba(255,255,255,.8)`,
                                        cursor: groupResizeCursor(item.handle),
                                    }}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onMouseDown={(event) => startGroupResize(event, item.handle)}
                                />
                            ))}
                        </div>
                    ) : null}

                    {selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[100] border"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                                borderColor: "#ff4d5a",
                                background: "rgba(79, 70, 229, 0.10)",
                            }}
                        />
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                </InfiniteCanvas>

                <CanvasMultiSelectToolbar
                    bounds={!selectionBox && !isNodeDragging && selectedGroupBounds ? selectedGroupBounds : null}
                    viewport={viewport}
                    viewportSize={size}
                    selectedCount={selectedVisibleNodes.length}
                    isBoundGroup={Boolean(selectedBoundGroupId)}
                    onAlignLeft={() => alignSelectedNodes("left")}
                    onAlignCenterY={() => alignSelectedNodes("centerY")}
                    onAlignRight={() => alignSelectedNodes("right")}
                    onAutoLayout={autoLayoutSelectedNodes}
                    onBind={bindSelectedNodes}
                    onUnbind={unbindSelectedNodes}
                    onExport={() => void exportSelectedNodes()}
                    onMerge={() => void mergeSelectedNodes()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                />

                <CanvasNodeHoverToolbar
                    node={hasMultipleSelectedNodes || isNodeDragging || nodeImageSettingsOpen ? null : toolbarNode}
                    viewport={viewport}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    canExportPsd={toolbarPsdLayerNodes.length > 0}
                    onExportPsd={(node) => void exportLayerPsd(node)}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onLocalEdit={(node) => setLocalEditNodeId(node.id)}
                    onEditImageText={(node) => setImageTextEditNodeId(node.id)}
                    onLayerImage={(node) => void layerImageNode(node)}
                    onRemoveBackground={(node) => void removeBackgroundNode(node)}
                    onRetry={(node) => void handleRetryNode(node)}
                />

                <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canvasTool={canvasTool}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                    onOpenAssetLibrary={() => {
                        setAssetPickerTab("library");
                        setAssetPickerOpen(true);
                    }}
                    onOpenMyAssets={() => {
                        setAssetPickerTab("my-assets");
                        setAssetPickerOpen(true);
                    }}
                />

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            deleteNodes(new Set([contextMenu.nodeId]));
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {localEditNode?.metadata?.content ? (
                    <CanvasNodeLocalEditDialog dataUrl={localEditNode.metadata.content} open={Boolean(localEditNode)} onClose={() => setLocalEditNodeId(null)} onConfirm={(rect, prompt) => void localEditImageNode(localEditNode!, rect, prompt)} />
                ) : null}

                <CanvasNodeTextEditDialog node={imageTextEditNode} open={Boolean(imageTextEditNode)} viewport={viewport} viewportSize={size} onClose={() => setImageTextEditNodeId(null)} onConfirm={applyImageTextEditNode} />

                <Modal
                    title="图片详情"
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? <img src={previewNode.metadata.content} alt={previewNode.title || "图片"} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} defaultTab={assetPickerTab} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
            {assistantMounted ? (
                <CanvasAssistantPanel
                    nodes={nodes}
                    selectedNodeIds={selectedNodeIds}
                    sessions={chatSessions}
                    activeSessionId={activeChatId}
                    onSelectNodeIds={setSelectedNodeIds}
                    onSessionsChange={handleAssistantSessionsChange}
                    onInsertImage={insertAssistantImage}
                    onInsertText={insertAssistantText}
                    onPasteImage={pasteAssistantImage}
                    onCollapseStart={() => setAssistantCollapsed(true)}
                    onCollapse={() => setAssistantMounted(false)}
                />
            ) : null}
        </main>
    );
}

function CanvasMultiSelectToolbar({
    bounds,
    viewport,
    viewportSize,
    selectedCount,
    isBoundGroup,
    onAlignLeft,
    onAlignCenterY,
    onAlignRight,
    onAutoLayout,
    onBind,
    onUnbind,
    onExport,
    onMerge,
    onDelete,
}: {
    bounds: { left: number; top: number; width: number; height: number } | null;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    selectedCount: number;
    isBoundGroup: boolean;
    onAlignLeft: () => void;
    onAlignCenterY: () => void;
    onAlignRight: () => void;
    onAutoLayout: () => void;
    onBind: () => void;
    onUnbind: () => void;
    onExport: () => void;
    onMerge: () => void;
    onDelete: () => void;
}) {
    if (!bounds || selectedCount <= 1) return null;

    const rawLeft = viewport.x + (bounds.left + bounds.width / 2) * viewport.k;
    const rawTop = viewport.y + bounds.top * viewport.k - 18;
    const left = Math.min(Math.max(rawLeft, 18), Math.max(18, viewportSize.width - 18));
    const top = Math.max(74, Math.min(rawTop, Math.max(74, viewportSize.height - 16)));

    return (
        <div data-canvas-no-zoom className="absolute z-[120] -translate-x-1/2 -translate-y-full pointer-events-auto" style={{ left, top }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex h-11 max-w-[calc(100vw-32px)] items-center gap-1 overflow-x-auto whitespace-nowrap rounded-2xl border border-zinc-200 bg-white/95 p-1 text-zinc-700 shadow-xl backdrop-blur-md">
                <span className="px-2 text-[10px] font-bold text-zinc-400">{selectedCount} 张已选中</span>
                <MultiToolbarDivider />
                <MultiToolbarButton label="左对齐" icon={<AlignLeft className="size-3.5" />} onClick={onAlignLeft} />
                <MultiToolbarButton label="垂直居中" icon={<AlignCenter className="size-3.5" />} onClick={onAlignCenterY} />
                <MultiToolbarButton label="右对齐" icon={<AlignRight className="size-3.5" />} onClick={onAlignRight} />
                <MultiToolbarDivider />
                <MultiToolbarButton label="自动排版" icon={<LayoutGrid className="size-3.5" />} onClick={onAutoLayout} />
                <MultiToolbarButton label={isBoundGroup ? "解绑元素" : "绑定元素"} icon={isBoundGroup ? <Unlink className="size-3.5" /> : <Link2 className="size-3.5" />} onClick={isBoundGroup ? onUnbind : onBind} />
                <MultiToolbarDivider />
                <MultiToolbarButton label="导出" icon={<Download className="size-3.5" />} onClick={onExport} />
                <MultiToolbarDivider />
                <MultiToolbarButton label="合并图层" icon={<Layers className="size-3.5" />} onClick={onMerge} className="text-emerald-600 hover:bg-emerald-50" />
                <MultiToolbarDivider />
                <MultiToolbarButton label="删除" icon={<Trash2 className="size-3.5" />} onClick={onDelete} className="text-red-600 hover:bg-red-50" />
            </div>
        </div>
    );
}

function MultiToolbarButton({ label, icon, onClick, className = "" }: { label: string; icon: ReactNode; onClick: () => void; className?: string }) {
    return (
        <button type="button" className={`flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-bold transition-all hover:bg-zinc-100 active:scale-95 ${className}`} onClick={onClick}>
            {icon}
            {label}
        </button>
    );
}

function MultiToolbarDivider() {
    return <div className="h-5 w-px shrink-0 bg-zinc-200" />;
}

function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onHome,
    onProjects,
    onCreateProject,
    onDeleteProject,
    onImportImage,
    onUndo,
    onRedo,
    assistantCollapsed,
    onExpandAssistant,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onHome: () => void;
    onProjects: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onImportImage: () => void;
    onUndo: () => void;
    onRedo: () => void;
    assistantCollapsed: boolean;
    onExpandAssistant: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const accountRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [accountOpen, setAccountOpen] = useState(false);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    useEffect(() => {
        if (!accountOpen) return;
        const close = (event: PointerEvent) => {
            if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [accountOpen]);

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between px-4">
                <div className="pointer-events-auto flex min-w-0 items-center gap-3">
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "home", icon: <Home className="size-4" />, label: "主页", onClick: onHome },
                                { key: "projects", icon: <Images className="size-4" />, label: "我的画布", onClick: onProjects },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: "新建画布", onClick: onCreateProject },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: "删除当前画布", onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: "导入图片", onClick: onImportImage },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text="撤销" shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text="重做" shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-9 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="打开画布菜单">
                            <Menu className="size-5" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current"
                                onDoubleClick={onStartTitleEditing}
                                title="双击修改画布名称"
                            >
                                {title}
                            </button>
                        )}
                    </div>
                </div>

                <div className="pointer-events-auto flex items-center gap-1.5">
                    <UserStatusActions
                        variant="canvas"
                        accountOpen={accountOpen}
                        onAccountOpenChange={setAccountOpen}
                        accountRef={accountRef}
                        getPopupContainer={(node) => node.parentElement || document.body}
                        onOpenShortcuts={() => {
                            setShortcutsOpen(true);
                            setAccountOpen(false);
                        }}
                    />
                    {assistantCollapsed ? (
                        <>
                            <span className="h-6 w-px" style={{ background: theme.toolbar.border }} />
                            <Button
                                type="text"
                                className="!h-10 !rounded-xl !px-3 !font-medium"
                                style={{ background: theme.toolbar.panel, color: theme.node.text, boxShadow: "0 10px 30px rgba(28,25,23,.10)" }}
                                icon={<MessageSquare className="size-4" />}
                                onClick={onExpandAssistant}
                            >
                                助手
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>
            <Modal title="快捷键" open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-2 border-t pt-4 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["拖动画布"]} value="平移视图" />
                    <Shortcut keys={["滚轮"]} value="缩放画布" />
                    <Shortcut keys={["缩放滑杆"]} value="精确调整缩放" />
                    <Shortcut keys={["拖动空白"]} value="框选多个节点" />
                    <Shortcut keys={["Shift / Ctrl / Cmd", "点击"]} value="追加选择节点" />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value="全选节点" />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value="复制 / 粘贴节点，或粘贴剪切板文本/图片" />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value="撤销" />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value="重做" />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value="重做" />
                    <Shortcut keys={["Delete / Backspace"]} value="删除选中" />
                    <Shortcut keys={["Esc"]} value="取消选择并关闭浮层" />
                    <Shortcut keys={["拖入图片"]} value="上传到画布" />
                </div>
            </Modal>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-6 rounded-lg px-1 py-1.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1.5">
                        {index ? <span className="text-xs opacity-35">+</span> : null}
                        <kbd
                            className="min-w-9 rounded-md border px-2.5 py-1.5 text-center text-xs font-medium leading-none shadow-[inset_0_-1px_0_rgba(0,0,0,.08),0_1px_2px_rgba(0,0,0,.06)]"
                            style={{ borderColor: "rgba(120,113,108,.28)", background: "linear-gradient(#fff, rgba(245,245,244,.92))", color: "rgb(68,64,60)" }}
                        >
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-sm opacity-55">{value}</span>
        </div>
    );
}

function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

function removeBackgroundResultMetadata(result: RemoveBackgroundResult): CanvasNodeMetadata {
    return {
        removeBackgroundOriginalWidth: result.originalWidth || undefined,
        removeBackgroundOriginalHeight: result.originalHeight || undefined,
        removeBackgroundProductOffsetX: result.productOffsetX || undefined,
        removeBackgroundProductOffsetY: result.productOffsetY || undefined,
        removeBackgroundProductWidth: result.productWidth || undefined,
        removeBackgroundProductHeight: result.productHeight || undefined,
    };
}

function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4" };
}

function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        outputFormat: config.outputFormat,
        outputCompression: config.outputCompression,
        moderation: config.moderation,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

type RemoveBackgroundSourceMetrics = {
    displayWidth: number;
    displayHeight: number;
    naturalWidth: number;
    naturalHeight: number;
};

function buildRemoveBackgroundMetadata(reference: ReferenceImage, sourceMetrics?: RemoveBackgroundSourceMetrics | null): CanvasNodeMetadata {
    const url = referenceUrl(reference);
    return {
        generationType: "edit",
        references: url ? [url] : [],
        removeBackground: true,
        removeBackgroundVersion: REMOVE_BACKGROUND_RESULT_VERSION,
        removeBackgroundSourceWidth: sourceMetrics?.displayWidth,
        removeBackgroundSourceHeight: sourceMetrics?.displayHeight,
        removeBackgroundSourceNaturalWidth: sourceMetrics?.naturalWidth,
        removeBackgroundSourceNaturalHeight: sourceMetrics?.naturalHeight,
    };
}

function buildDerivedImageMetadata(reference: ReferenceImage): CanvasNodeMetadata {
    const url = referenceUrl(reference);
    return {
        generationType: "edit",
        references: url ? [url] : [],
    };
}

type LayerTextLayout = {
    baseX: number;
    baseY: number;
    displayWidth: number;
    scaleX: number;
    scaleY: number;
    productOffsetX: number;
    productOffsetY: number;
    productWidth: number;
    productHeight: number;
    layerGroupId: string;
    layerSourceId: string;
};

function createLayerTextNodes(textLayers: LayerImageTextLayer[], layout: LayerTextLayout): CanvasNodeData[] {
    const minScale = Math.min(layout.scaleX, layout.scaleY);
    return textLayers.flatMap((layer, index) => {
        const text = layer.text?.trim();
        if (!text) return [];
        const sourceWidth = Math.max(0, layer.size?.width || estimateLayerTextSourceWidth(layer));
        const sourceHeight = Math.max(0, layer.size?.height || layer.fontSize * 1.2);
        if (overlapsProductBounds(layer.position.x, layer.position.y, sourceWidth, sourceHeight, layer.rotation || 0, layout)) return [];

        let fontSize = Math.max(1, Math.round((layer.fontSize || 14) * minScale));
        if ((layer.size?.height || 0) > 0) {
            fontSize = Math.min(fontSize, Math.max(1, Math.round((layer.size?.height || 0) * layout.scaleY * 1.12)));
        }

        const offsetX = layer.position.x * layout.scaleX;
        const maxWidth = Math.max(1, layout.displayWidth - offsetX);
        const scaledSizeWidth = (layer.size?.width || 0) * layout.scaleX;
        const estimatedWidth = fontSize * Math.max(2, text.length) * 1.08;
        const padding = Math.ceil(fontSize * 0.14);
        const width = Math.min(Math.max(scaledSizeWidth > 0 ? scaledSizeWidth * 1.26 : estimatedWidth, fontSize) + padding, maxWidth);
        const height = Math.max(fontSize * 1.45, sourceHeight * layout.scaleY * 1.18);

        return [
            {
                id: nanoid(),
                type: CanvasNodeType.Text,
                title: text.slice(0, 32) || `文字层 ${index + 1}`,
                position: {
                    x: layout.baseX + offsetX,
                    y: layout.baseY + layer.position.y * layout.scaleY,
                },
                width: Math.max(1, width),
                height: Math.max(1, height),
                metadata: {
                    content: text,
                    status: NODE_STATUS_SUCCESS,
                    fontSize,
                    textColor: layer.color || "#111111",
                    fontFamily: layer.fontFamily || "sans-serif",
                    fontWeight: layer.fontWeight || "normal",
                    fontStyle: layer.fontStyle || "normal",
                    textStrokeColor: layer.strokeColor || undefined,
                    textStrokeWidth: layer.strokeWidth ? Math.max(0, layer.strokeWidth * minScale) : undefined,
                    textOpacity: typeof layer.opacity === "number" ? layer.opacity : 1,
                    rotation: layer.rotation || 0,
                    layerText: true,
                    layerGroupId: layout.layerGroupId,
                    layerSourceId: layout.layerSourceId,
                    layerRole: "text",
                },
            },
        ];
    });
}

function estimateLayerTextSourceWidth(layer: LayerImageTextLayer) {
    return Math.max(1, (layer.fontSize || 14) * Math.max(2, layer.text.length) * 0.62);
}

function hasRenderableTextContent(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Text) return true;
    const content = (node.metadata?.content || "").replace(/\u200B/g, "").trim();
    return Boolean(content);
}

function overlapsProductBounds(x: number, y: number, width: number, height: number, rotation: number, layout: LayerTextLayout) {
    if (layout.productWidth <= 0 || layout.productHeight <= 0 || width <= 0 || height <= 0) return false;
    const textBounds = rotatedBounds(x, y, width, height, rotation);
    const productBounds = {
        left: layout.productOffsetX,
        top: layout.productOffsetY,
        right: layout.productOffsetX + layout.productWidth,
        bottom: layout.productOffsetY + layout.productHeight,
    };
    const overlapLeft = Math.max(textBounds.left, productBounds.left);
    const overlapTop = Math.max(textBounds.top, productBounds.top);
    const overlapRight = Math.min(textBounds.right, productBounds.right);
    const overlapBottom = Math.min(textBounds.bottom, productBounds.bottom);
    if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) return false;

    const centerX = (textBounds.left + textBounds.right) / 2;
    const centerY = (textBounds.top + textBounds.bottom) / 2;
    const centerInsideProduct = centerX >= productBounds.left && centerX <= productBounds.right && centerY >= productBounds.top && centerY <= productBounds.bottom;
    const overlapArea = (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
    const textArea = Math.max(1, (textBounds.right - textBounds.left) * (textBounds.bottom - textBounds.top));
    return centerInsideProduct && overlapArea / textArea > 0.35;
}

function rotatedBounds(x: number, y: number, width: number, height: number, rotation: number) {
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const points = [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
    ].map(([pointX, pointY]) => ({
        x: x + pointX * cos - pointY * sin,
        y: y + pointX * sin + pointY * cos,
    }));
    return {
        left: Math.min(...points.map((point) => point.x)),
        top: Math.min(...points.map((point) => point.y)),
        right: Math.max(...points.map((point) => point.x)),
        bottom: Math.max(...points.map((point) => point.y)),
    };
}

function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const isStoredImage = url.startsWith("image:") || url.startsWith("server:");
            const dataUrl = isStoredImage ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: isStoredImage ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            if (node.type === CanvasNodeType.Video && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, content) } };
            if (node.type !== CanvasNodeType.Image || !content) return normalizeCanvasNode(node);
            if (node.metadata?.storageKey) return normalizeCanvasNode({ ...node, metadata: { ...node.metadata, content: await resolveImageUrl(node.metadata.storageKey, content) } });
            if (node.metadata?.skipInitialStorageUpload) return normalizeCanvasNode(node);
            if (!content.startsWith("data:image/")) return normalizeCanvasNode(node);
            return normalizeCanvasNode({ ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadImage(content)) } });
        }),
    );
}

function canvasImageSourceMetrics(node: CanvasNodeData | null): RemoveBackgroundSourceMetrics | null {
    if (!node || node.type !== CanvasNodeType.Image) return null;
    const naturalWidth = Math.max(1, node.metadata?.naturalWidth || node.width || 0);
    const naturalHeight = Math.max(1, node.metadata?.naturalHeight || node.height || 0);
    const displayWidth = Math.max(1, node.width || naturalWidth);
    const displayHeight = Math.max(1, node.height || naturalHeight);
    if (!naturalWidth || !naturalHeight || !displayWidth || !displayHeight) return null;
    return { displayWidth, displayHeight, naturalWidth, naturalHeight };
}

function removeBackgroundSourceMetrics(node: CanvasNodeData, nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = []): RemoveBackgroundSourceMetrics | null {
    const metadata = node.metadata;
    const displayWidth = Math.max(0, metadata?.removeBackgroundSourceWidth || 0);
    const displayHeight = Math.max(0, metadata?.removeBackgroundSourceHeight || 0);
    const naturalWidth = Math.max(0, metadata?.removeBackgroundSourceNaturalWidth || 0);
    const naturalHeight = Math.max(0, metadata?.removeBackgroundSourceNaturalHeight || 0);
    if (displayWidth && displayHeight && naturalWidth && naturalHeight) return { displayWidth, displayHeight, naturalWidth, naturalHeight };
    return canvasImageSourceMetrics(findConnectedSourceImageNode(node.id, nodes, connections));
}

function removeBackgroundNodeSize(image: Pick<UploadedImage, "width" | "height">, sourceMetrics?: RemoveBackgroundSourceMetrics | null, result?: RemoveBackgroundResult | null) {
    const naturalWidth = Math.max(1, image.width);
    const naturalHeight = Math.max(1, image.height);
    if (!sourceMetrics) return { width: naturalWidth, height: naturalHeight };
    const productWidth = Math.max(0, result?.productWidth || 0);
    const productHeight = Math.max(0, result?.productHeight || 0);
    const sourceRelativeHeight = productHeight > 0 && result?.originalHeight ? (sourceMetrics.displayHeight * productHeight) / Math.max(1, result.originalHeight) : 0;
    const height = Math.max(sourceMetrics.displayHeight, sourceRelativeHeight);
    const width = (height * naturalWidth) / naturalHeight || (productWidth > 0 && result?.originalWidth ? (sourceMetrics.displayWidth * productWidth) / Math.max(1, result.originalWidth) : naturalWidth);
    return { width: Math.max(1, width), height: Math.max(1, height) };
}

function normalizeCanvasNodes(nodes: CanvasNodeData[], connections: CanvasConnection[] = []) {
    return nodes.map((node) => normalizeCanvasNode(node, nodes, connections));
}

function normalizeCanvasNode(node: CanvasNodeData, nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = []) {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.removeBackground || node.metadata?.freeResize) return node;
    const naturalWidth = Math.max(1, node.metadata.naturalWidth || 0);
    const naturalHeight = Math.max(1, node.metadata.naturalHeight || 0);
    if (!naturalWidth || !naturalHeight) return node;

    const expectedSize = removeBackgroundNodeSize({ width: naturalWidth, height: naturalHeight }, removeBackgroundSourceMetrics(node, nodes, connections));
    const widthDiff = Math.abs(node.width - expectedSize.width) / Math.max(1, expectedSize.width);
    const heightDiff = Math.abs(node.height - expectedSize.height) / Math.max(1, expectedSize.height);
    if (widthDiff <= 0.2 && heightDiff <= 0.2) return node;

    const centerX = node.position.x + node.width / 2;
    const centerY = node.position.y + node.height / 2;
    return {
        ...node,
        width: expectedSize.width,
        height: expectedSize.height,
        position: {
            x: centerX - expectedSize.width / 2,
            y: centerY - expectedSize.height / 2,
        },
    };
}

async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                    images: await Promise.all((message.images || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const next = { ...node, metadata: { ...node.metadata, ...(patch || {}) } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof patch?.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(patch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
    };
}

function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? config.imageModel : mode === "video" ? config.videoModel : config.textModel;
    const activeChannelId = mode === "image" ? node?.metadata?.imageChannelId || config.imageChannelId : mode === "video" ? node?.metadata?.videoChannelId || config.videoChannelId : node?.metadata?.textChannelId || config.textChannelId;
    return {
        ...config,
        model: node?.metadata?.model || defaultModel || config.model || defaultConfig.model,
        activeChannelId,
        imageChannelId: node?.metadata?.imageChannelId || config.imageChannelId,
        videoChannelId: node?.metadata?.videoChannelId || config.videoChannelId,
        textChannelId: node?.metadata?.textChannelId || config.textChannelId,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        outputFormat: node?.metadata?.outputFormat || config.outputFormat || defaultConfig.outputFormat,
        outputCompression: node?.metadata?.outputCompression || config.outputCompression || defaultConfig.outputCompression,
        moderation: node?.metadata?.moderation || config.moderation || defaultConfig.moderation,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        count: String(node?.metadata?.count || (mode === "image" ? 1 : config.count) || defaultConfig.count),
    };
}

function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    return nodes.map((node) => (node.metadata?.status === "loading" ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "页面刷新后生成已中断，请重新生成。" } } : node));
}

function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

function findConnectedSourceImageNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id) || null;
        if (node?.type === CanvasNodeType.Image && node.metadata?.content) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

function resolveLocalEditSourceNode(node: CanvasNodeData | undefined, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (!node) return null;
    if (node.metadata?.editSourceNodeId) {
        const sourceNode = nodes.find((item) => item.id === node.metadata?.editSourceNodeId) || null;
        if (sourceNode?.type === CanvasNodeType.Image && sourceNode.metadata?.content) return sourceNode;
    }
    return findConnectedSourceImageNode(node.id, nodes, connections);
}

function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

function buildLocalEditDraftPrompt(prompt: string) {
    const cleanedPrompt = prompt.replace(/^区域\s*1[:：]?\s*/u, "").trim();
    return cleanedPrompt ? `区域1 ${cleanedPrompt}` : "区域1";
}

async function requestLocalEditComposite(config: AiConfig, prompt: string, sourceNode: CanvasNodeData, rect: CanvasImageRect) {
    if (sourceNode.type !== CanvasNodeType.Image || !sourceNode.metadata?.content) {
        throw new Error("局部编辑源图已丢失");
    }
    const reference = sourceNodeReferenceImages(sourceNode)[0];
    if (!reference) throw new Error("局部编辑参考图已丢失");

    const localEditAssets = await prepareLocalEditAssets(sourceNode.metadata.content, rect);
    const annotationReference = buildLocalEditAnnotationReference(reference, localEditAssets.annotatedDataUrl);
    const result = await requestEdit(config, buildLocalEditPrompt(prompt), [reference, annotationReference]).then((items) => items[0]);
    return result.dataUrl;
}

function buildLocalEditAnnotationReference(reference: ReferenceImage, dataUrl: string): ReferenceImage {
    return {
        ...reference,
        dataUrl,
        type: "image/png",
        storageKey: undefined,
        url: undefined,
        temporary: true,
    };
}

function buildLocalEditPrompt(prompt: string) {
    const text = prompt.trim();
    return [
        "第1张参考图是原图，第2张参考图是同一张图的区域标注图。红框和“区域1”只用于指出允许修改的位置，最终成图中不要保留任何标注元素。",
        "仅修改区域1内与需求直接相关的内容，区域1外的所有文字、排版、Logo、图案、配色、材质、边缘、透视、阴影、反光、背景和构图都必须保持不变。",
        "如果需求涉及改字，必须保留原有字体风格、字重、字号、排版、透视、材质和印刷质感，只替换目标文字内容。",
        "输出完整成品图，不要裁切，不要扩图，不要新增无关元素。",
        text,
    ]
        .filter(Boolean)
        .join("\n");
}

function buildImageTextEditPrompt(changes: CanvasImageTextEditChange[]) {
    const replacements = changes.map((change, index) => `${index + 1}. Replace "${change.from}" with "${change.to}".`).join("\n");
    return [
        "对参考图进行文字替换。只修改下面列出的文字内容，其他所有元素必须保持不变。",
        "保持原图尺寸、构图、背景、图案、Logo、颜色、材质、透视、阴影、反光、字体风格、字号、字重、排版和印刷质感。",
        "不要添加标注、边框、水印、解释文字或无关元素。输出完整成品图。",
        replacements,
    ].join("\n");
}

async function restoreTransparentBackdropForTransparentReference(reference: ReferenceImage, generatedImage: string) {
    try {
        const sourceDataUrl = await imageToDataUrl(reference);
        const source = await readImageDataFromDataUrl(sourceDataUrl);
        if (!hasTransparentEdge(source)) return generatedImage;

        const generatedDataUrl = await imageToDataUrl({ dataUrl: generatedImage });
        const generated = await readImageDataFromDataUrl(generatedDataUrl);
        if (hasTransparentEdge(generated)) return generatedDataUrl;

        return removeConnectedEdgeBackdrop(generated) || generatedDataUrl;
    } catch {
        return generatedImage;
    }
}

type CanvasImagePixels = {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    imageData: ImageData;
    width: number;
    height: number;
};

function readImageDataFromDataUrl(src: string) {
    return new Promise<CanvasImagePixels>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) {
                reject(new Error("图片处理失败"));
                return;
            }
            context.drawImage(image, 0, 0, width, height);
            resolve({ canvas, context, imageData: context.getImageData(0, 0, width, height), width, height });
        };
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = src;
    });
}

function hasTransparentEdge(image: CanvasImagePixels) {
    let total = 0;
    let transparent = 0;
    visitEdgePixels(image.width, image.height, (index) => {
        total += 1;
        if (image.imageData.data[index * 4 + 3] < 24) transparent += 1;
    });
    return total > 0 && transparent / total > 0.18;
}

function removeConnectedEdgeBackdrop(image: CanvasImagePixels) {
    const backdrop = dominantEdgeColor(image);
    if (!backdrop) return "";

    const { imageData, width, height, canvas, context } = image;
    const pixels = imageData.data;
    const total = width * height;
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    const threshold = 54;

    const enqueue = (index: number) => {
        if (visited[index]) return;
        const offset = index * 4;
        if (pixels[offset + 3] < 24 || colorDistance([pixels[offset], pixels[offset + 1], pixels[offset + 2]], backdrop) > threshold) return;
        visited[index] = 1;
        queue[tail++] = index;
    };

    visitEdgePixels(width, height, enqueue);
    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) enqueue(index - 1);
        if (x + 1 < width) enqueue(index + 1);
        if (y > 0) enqueue(index - width);
        if (y + 1 < height) enqueue(index + width);
    }

    const removedRatio = tail / Math.max(1, total);
    if (removedRatio < 0.01 || removedRatio > 0.82) return "";

    for (let i = 0; i < tail; i += 1) {
        pixels[queue[i] * 4 + 3] = 0;
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
}

function dominantEdgeColor(image: CanvasImagePixels): [number, number, number] | null {
    const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
    visitEdgePixels(image.width, image.height, (index) => {
        const offset = index * 4;
        const alpha = image.imageData.data[offset + 3];
        if (alpha < 128) return;
        const r = image.imageData.data[offset];
        const g = image.imageData.data[offset + 1];
        const b = image.imageData.data[offset + 2];
        const key = `${Math.round(r / 12)},${Math.round(g / 12)},${Math.round(b / 12)}`;
        const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        buckets.set(key, bucket);
    });
    const best = Array.from(buckets.values()).reduce<{ count: number; r: number; g: number; b: number } | null>((current, bucket) => (!current || bucket.count > current.count ? bucket : current), null);
    return best && best.count > 8 ? [Math.round(best.r / best.count), Math.round(best.g / best.count), Math.round(best.b / best.count)] : null;
}

function visitEdgePixels(width: number, height: number, visit: (index: number) => void) {
    if (width <= 0 || height <= 0) return;
    for (let x = 0; x < width; x += 1) {
        visit(x);
        if (height > 1) visit((height - 1) * width + x);
    }
    for (let y = 1; y + 1 < height; y += 1) {
        visit(y * width);
        if (width > 1) visit(y * width + width - 1);
    }
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}

function shouldAutoOpenNodeDialog(node: CanvasNodeData | null | undefined) {
    if (!node) return false;
    return node.type === CanvasNodeType.Config;
}

function isRemoveBackgroundPrompt(prompt?: string) {
    const normalized = prompt?.trim() || "";
    return REMOVE_BACKGROUND_PROMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
