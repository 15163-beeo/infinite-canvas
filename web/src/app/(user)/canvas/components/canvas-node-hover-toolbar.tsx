"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, Segmented, Tooltip } from "antd";
import { Download, Eraser, FileArchive, FolderPlus, Image as ImageIcon, Layers3, Minus, Pencil, Plus, RefreshCw, Scissors, Type, Video, WandSparkles } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "../types";

type CanvasNodeHoverToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onInfo: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    canExportPsd: boolean;
    onExportPsd: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onLocalEdit: (node: CanvasNodeData) => void;
    onEditImageText: (node: CanvasNodeData) => void;
    onLayerImage: (node: CanvasNodeData) => void;
    onRemoveBackground: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
};

export function CanvasNodeHoverToolbar({
    node,
    viewport,
    onKeep,
    onLeave,
    onInfo,
    onEditText,
    onDecreaseFont,
    onIncreaseFont,
    onGenerateImage,
    onUpload,
    onDownload,
    canExportPsd,
    onExportPsd,
    onSaveAsset,
    onCrop,
    onLocalEdit,
    onEditImageText,
    onLayerImage,
    onRemoveBackground,
    onRetry,
}: CanvasNodeHoverToolbarProps) {
    if (!node) return null;
    if (node.type === CanvasNodeType.Config) return null;

    const left = viewport.x + (node.position.x + node.width / 2) * viewport.k;
    const top = viewport.y + node.position.y * viewport.k - 14;
    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const hasVideo = isVideo && Boolean(node.metadata?.content);
    const isText = node.type === CanvasNodeType.Text;
    const isLayerText = isText && Boolean(node.metadata?.layerText);
    const canRetry = node.metadata?.status === "error";
    const hasToolbarActions = canRetry || hasImage || hasVideo || isText || isVideo || canExportPsd;

    if (!hasToolbarActions) return null;

    return (
        <div
            data-canvas-no-zoom
            className="absolute z-[70] flex h-12 -translate-x-1/2 -translate-y-full items-center overflow-visible rounded-[18px] border border-black/10 bg-white text-[15px] text-[#242529] shadow-[0_8px_28px_rgba(15,23,42,.12)]"
            style={{ left, top }}
            onMouseEnter={() => onKeep(node.id)}
            onMouseLeave={onLeave}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {canRetry ? <ToolbarAction title="重新生成" label="重试" icon={<RefreshCw className="size-4" />} onClick={() => onRetry(node)} /> : null}
            {hasImage || hasVideo || isText ? <ToolbarAction title="加入我的素材" label="存素材" icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(node)} /> : null}
            {hasImage || hasVideo ? <IconAction title={hasVideo ? "下载视频" : "下载图片"} icon={<Download className="size-5" />} onClick={() => onDownload(node)} /> : null}
            {canExportPsd ? <ToolbarAction title="导出当前智能分层组 PSD" label="导出整组PSD" icon={<FileArchive className="size-4" />} onClick={() => onExportPsd(node)} /> : null}
            {isText ? <ToolbarAction title="编辑文本" label="编辑文字" icon={<Pencil className="size-4" />} onClick={() => onEditText(node)} /> : null}
            {isText && !isLayerText ? <ToolbarAction title="用文本生图" label="生图" icon={<ImageIcon className="size-4" />} onClick={() => onGenerateImage(node)} /> : null}
            {isText ? <ToolbarAction title="减小字号" label="缩小" icon={<Minus className="size-4" />} onClick={() => onDecreaseFont(node)} /> : null}
            {isText ? <ToolbarAction title="增大字号" label="放大" icon={<Plus className="size-4" />} onClick={() => onIncreaseFont(node)} /> : null}
            {isVideo ? <ToolbarAction title={hasVideo ? "替换视频" : "上传视频"} label={hasVideo ? "替换视频" : "上传视频"} icon={<Video className="size-4" />} onClick={() => onUpload(node)} /> : null}
            {hasImage ? <ToolbarAction title="裁剪并生成新节点" label="裁剪" icon={<Scissors className="size-4" />} onClick={() => onCrop(node)} /> : null}
            {hasImage ? <ToolbarAction title="识别并替换图片里的文字" label="编辑文字" icon={<Type className="size-4" />} onClick={() => onEditImageText(node)} /> : null}
            {hasImage ? <ToolbarAction title="框选一个矩形区域并重新生成该区域" label="局部编辑" icon={<WandSparkles className="size-4" />} onClick={() => onLocalEdit(node)} /> : null}
            {hasImage ? <ToolbarAction title="拆分背景层和主体层" label="智能分层" icon={<Layers3 className="size-4" />} onClick={() => onLayerImage(node)} /> : null}
            {hasImage ? <ToolbarAction title="去除背景并生成新节点" label="去背景" icon={<Eraser className="size-4" />} onClick={() => onRemoveBackground(node)} /> : null}
        </div>
    );
}

export function CanvasNodeInfoModal({ node, open, onClose }: { node: CanvasNodeData | null; open: boolean; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [view, setView] = useState<"info" | "json">("info");
    const imageBytes = node?.type === CanvasNodeType.Image && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const batchCount = node?.type === CanvasNodeType.Image ? node.metadata?.batchChildIds?.length || 0 : 0;
    const json = useMemo(() => {
        if (!node) return "";
        return JSON.stringify(
            node,
            (key, value) => {
                if (key === "title") return undefined;
                if (key === "content" && typeof value === "string" && value.startsWith("data:image/")) {
                    return "[base64 image]";
                }
                return value;
            },
            2,
        );
    }, [node]);

    useEffect(() => {
        if (open) setView("info");
    }, [node?.id, open]);

    const title = (
        <div className="flex items-center justify-between gap-4 pr-12">
            <span>节点信息</span>
            <Segmented
                size="small"
                value={view}
                onChange={(value) => setView(value as "info" | "json")}
                options={[
                    { label: "信息", value: "info" },
                    { label: "JSON", value: "json" },
                ]}
            />
        </div>
    );

    return (
        <Modal className="canvas-node-info-modal" title={title} open={open && Boolean(node)} centered footer={null} onCancel={onClose}>
            {node ? (
                <div className="h-[56vh] min-h-[360px] text-sm">
                    {view === "info" ? (
                        <div className="thin-scrollbar h-full space-y-3 overflow-auto pr-1">
                            <InfoRow label="ID" value={node.id} />
                            <InfoRow label="类型" value={node.type === CanvasNodeType.Text ? "文本" : node.type === CanvasNodeType.Image ? "图片" : node.type === CanvasNodeType.Video ? "视频" : "生成配置"} />
                            <InfoRow label="尺寸" value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                            <InfoRow label="位置" value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                            <InfoRow label="状态" value={node.metadata?.status || "idle"} />
                            {batchCount > 1 ? <InfoRow label="图片组" value={`${batchCount} 张`} /> : null}
                            {node.metadata?.prompt ? <InfoRow label="提示词" value={node.metadata.prompt} /> : null}
                            {imageBytes ? <InfoRow label="图片大小" value={formatBytes(imageBytes)} /> : null}
                            {node.metadata?.errorDetails ? (
                                <div className="rounded-lg border p-3 text-red-400" style={{ borderColor: theme.node.stroke }}>
                                    {node.metadata.errorDetails}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <pre className="thin-scrollbar h-full overflow-auto rounded-lg border p-3 text-xs leading-5" style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}>
                            {json}
                        </pre>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}

function ToolbarAction({ title, label, icon, onClick, hint, active = false, danger = false }: { title: string; label: string; icon: ReactNode; onClick?: () => void; hint?: string; active?: boolean; danger?: boolean }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className={`group relative flex h-12 items-center whitespace-nowrap px-1.5 ${danger ? "text-[#ef4444]" : ""}`} onClick={onClick} aria-label={title}>
                <span className={`flex h-9 items-center gap-2 rounded-lg px-2.5 transition group-hover:bg-[#f0f0f1] ${active ? "bg-[#eeeeef]" : ""}`}>
                    {icon}
                    <span>{label}</span>
                    {hint ? <span className="text-[#a3a3a3]">{hint}</span> : null}
                </span>
            </button>
        </Tooltip>
    );
}

function IconAction({ title, icon, onClick }: { title: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip title={title} placement="top" mouseEnterDelay={0.2}>
            <button type="button" className="group relative grid h-12 w-12 place-items-center px-1.5" onClick={onClick} aria-label={title}>
                <span className="grid size-9 place-items-center rounded-lg transition group-hover:bg-[#f0f0f1]">{icon}</span>
            </button>
        </Tooltip>
    );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <span className="opacity-50">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{value}</span>
        </div>
    );
}
