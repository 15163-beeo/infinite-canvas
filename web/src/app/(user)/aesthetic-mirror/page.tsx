"use client";

import { App, Button, Drawer, Empty, Image, Input, Modal, Select, Tag, Tooltip } from "antd";
import { Copy, Download, Eye, Gauge, History, ImagePlus, LoaderCircle, Pencil, RefreshCw, Settings2, Sparkles, Trash2, UploadCloud, WandSparkles, X } from "lucide-react";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";

import { useCanvasStore } from "../canvas/stores/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../canvas/types";
import { fitNodeSize } from "../canvas/utils/canvas-node-size";
import { ModelPicker } from "@/components/model-picker";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { requestEdit } from "@/services/api/image";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type UploadRole = "reference" | "product";
type MirrorStatus = "idle" | "running" | "success" | "failed";

type MirrorResult = {
    id: string;
    status: MirrorStatus;
    prompt: string;
    referenceId?: string;
    referenceName?: string;
    referenceIndex?: number;
    dataUrl?: string;
    error?: string;
};

type MirrorHistoryImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    width: number;
    height: number;
    bytes: number;
};

type MirrorHistoryLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    promptTemplate: string;
    extraPrompt: string;
    model: string;
    modelChannelId: string;
    modelChannelName: string;
    aspectRatio: AspectRatio;
    imageSize: ImageSize;
    quality: string;
    count: number;
    durationMs: number;
    status: "生成中" | "成功" | "失败";
    references: ReferenceImage[];
    products: ReferenceImage[];
    images: MirrorHistoryImage[];
    errors: string[];
};

type AspectRatio = "1:1" | "3:4" | "4:5" | "9:16" | "16:9";
type ImageSize = "auto" | "1K" | "2K";

const maxProductImages = 6;
const maxReferenceImages = 20;
const maxMirrorHistoryLogs = 50;
const promptTemplateStorageKey = "infinite-canvas:aesthetic-mirror:prompt-template";
const mirrorHistoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "aesthetic_mirror_logs" });
const basePrompt =
    "基于分析参考图的视觉语言，包括构图、背景质感、信息层级、产品展示方式、视觉风格等，用产品素材图中的真实产品重新设计类似风格的爆款电商图。参考图只用于学习版式、背景、光影、排版节奏和电商视觉语言，不得把参考图里的产品主体、瓶型、标签、品牌、文字或专属图形迁移到结果中。产品素材图里的产品必须作为唯一产品主体，严格保持产品的瓶型轮廓、颜色、透明液体质感、瓶盖、标签结构、品牌标识和可见细节，不要重绘成新产品，不要替换包装，不要伪造新品牌或新标签。整体风格高级、干净，产品真实清晰、不变形，产品位置、大小、角度、透视、光影和阴影要自然匹配参考图，文字锐化清晰、无乱码，画面高清适合电商投流。不要照抄参考图的品牌、文字和专属图形。";

const aspectRatioOptions: Array<{ label: string; value: AspectRatio; hint: string }> = [
    { label: "1:1 正方形", value: "1:1", hint: "平台主图/方形详情模块" },
    { label: "3:4 详情竖图", value: "3:4", hint: "详情页分屏模块" },
    { label: "4:5 投流竖图", value: "4:5", hint: "广告投放常用比例" },
    { label: "9:16 长竖图", value: "9:16", hint: "移动端沉浸展示" },
    { label: "16:9 横版", value: "16:9", hint: "横版场景图" },
];

const sizeMap: Record<ImageSize, Partial<Record<AspectRatio, string>>> = {
    auto: {},
    "1K": {
        "1:1": "1024x1024",
        "3:4": "768x1024",
        "4:5": "896x1120",
        "9:16": "720x1280",
        "16:9": "1280x720",
    },
    "2K": {
        "1:1": "2048x2048",
        "3:4": "1536x2048",
        "4:5": "1792x2240",
        "9:16": "1440x2560",
        "16:9": "2560x1440",
    },
};

export default function AestheticMirrorPage() {
    const { message, modal } = App.useApp();
    const router = useRouter();
    const referenceInputRef = useRef<HTMLInputElement>(null);
    const productInputRef = useRef<HTMLInputElement>(null);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const createCanvasProject = useCanvasStore((state) => state.createProject);
    const updateCanvasProject = useCanvasStore((state) => state.updateProject);
    const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
    const [productImages, setProductImages] = useState<ReferenceImage[]>([]);
    const [promptTemplate, setPromptTemplate] = useState(() => readStoredPromptTemplate());
    const [promptDraft, setPromptDraft] = useState(() => readStoredPromptTemplate());
    const [promptEditorOpen, setPromptEditorOpen] = useState(false);
    const [extraPrompt, setExtraPrompt] = useState("");
    const [model, setModel] = useState(effectiveConfig.imageModel || effectiveConfig.model);
    const [modelChannelId, setModelChannelId] = useState(effectiveConfig.imageChannelId || effectiveConfig.activeChannelId);
    const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
    const [imageSize, setImageSize] = useState<ImageSize>("1K");
    const [quality, setQuality] = useState("auto");
    const [imageCount, setImageCount] = useState(1);
    const [results, setResults] = useState<MirrorResult[]>([]);
    const [historyLogs, setHistoryLogs] = useState<MirrorHistoryLog[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [activeHistoryLogId, setActiveHistoryLogId] = useState("");
    const [activePreview, setActivePreview] = useState<MirrorResult | null>(null);
    const [activeUploadPreview, setActiveUploadPreview] = useState<ReferenceImage | null>(null);

    const isGenerating = results.some((item) => item.status === "running");
    const finalPrompt = useMemo(() => buildFinalPrompt(promptTemplate, extraPrompt), [promptTemplate, extraPrompt]);
    const promptDraftFinal = useMemo(() => buildFinalPrompt(promptDraft, extraPrompt), [promptDraft, extraPrompt]);
    const modelChannelName = useMemo(() => resolveModelChannelName(effectiveConfig, modelChannelId, model), [effectiveConfig, model, modelChannelId]);
    const isBatchMode = referenceImages.length > 1;
    const effectiveResultCount = isBatchMode ? referenceImages.length : imageCount;
    const canGenerate = referenceImages.length > 0 && productImages.length > 0 && !isGenerating;
    const successCount = results.filter((item) => item.status === "success").length;

    useEffect(() => {
        setModel(effectiveConfig.imageModel || effectiveConfig.model);
        setModelChannelId(effectiveConfig.imageChannelId || effectiveConfig.activeChannelId);
    }, [effectiveConfig.activeChannelId, effectiveConfig.imageChannelId, effectiveConfig.imageModel, effectiveConfig.model]);

    useEffect(() => {
        void refreshHistoryLogs();
    }, []);

    useEffect(() => {
        try {
            window.localStorage.setItem(promptTemplateStorageKey, promptTemplate);
        } catch {
            // Local persistence is best-effort; generation can still proceed.
        }
    }, [promptTemplate]);

    const uploadFiles = async (sourceFiles: File[], role: UploadRole) => {
        const files = sourceFiles.filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        const maxImages = role === "reference" ? maxReferenceImages : maxProductImages;
        const currentCount = role === "reference" ? referenceImages.length : productImages.length;
        const limitedFiles = files.slice(0, Math.max(0, maxImages - currentCount));
        if (!limitedFiles.length) {
            message.warning(role === "reference" ? `参考设计图最多上传 ${maxReferenceImages} 张` : `产品素材最多上传 ${maxProductImages} 张`);
            return;
        }
        const hide = message.loading("正在读取图片...", 0);
        try {
            const nextImages = await Promise.all(
                limitedFiles.map(async (file) => {
                    const uploaded = await uploadImage(file);
                    return {
                        id: nanoid(),
                        name: file.name,
                        type: uploaded.mimeType || file.type || "image/png",
                        dataUrl: uploaded.url,
                        storageKey: uploaded.storageKey,
                        width: uploaded.width,
                        height: uploaded.height,
                        bytes: uploaded.bytes,
                        source: "upload" as const,
                        temporary: true,
                    };
                }),
            );
            if (role === "reference") {
                setReferenceImages((items) => [...items, ...nextImages].slice(0, maxReferenceImages));
            } else {
                setProductImages((items) => [...items, ...nextImages].slice(0, maxProductImages));
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片上传失败");
        } finally {
            hide();
        }
    };

    const handleUpload = async (event: ChangeEvent<HTMLInputElement>, role: UploadRole) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        await uploadFiles(files, role);
    };

    const removeImage = async (role: UploadRole, id: string) => {
        const list = role === "reference" ? referenceImages : productImages;
        const target = list.find((item) => item.id === id);
        if (target) await cleanupStoredImages([target]).catch(() => undefined);
        if (role === "reference") setReferenceImages((items) => items.filter((item) => item.id !== id));
        else setProductImages((items) => items.filter((item) => item.id !== id));
    };

    const submitGenerate = async (override?: { count?: number; replaceId?: string }) => {
        if (!referenceImages.length) {
            message.warning("请先上传参考设计图");
            return;
        }
        if (!productImages.length) {
            message.warning("请先上传产品素材图");
            return;
        }
        const requestModel = model || effectiveConfig.imageModel || effectiveConfig.model;
        const requestChannelId = modelChannelId || effectiveConfig.imageChannelId || effectiveConfig.activeChannelId;
        const requestBaseConfig = { ...effectiveConfig, model: requestModel, imageModel: requestModel, imageChannelId: requestChannelId, activeChannelId: requestChannelId };
        if (!isAiConfigReady(requestBaseConfig, requestModel)) {
            message.warning("请先配置可用的图片模型渠道");
            openConfigDialog(true);
            return;
        }

        const isBatchRun = referenceImages.length > 1 && !override?.replaceId;
        const count = isBatchRun ? referenceImages.length : override?.count || imageCount;
        const startedAt = performance.now();
        const historySnapshot = {
            prompt: finalPrompt,
            promptTemplate,
            extraPrompt,
            model: requestModel,
            modelChannelId: requestChannelId,
            modelChannelName,
            aspectRatio,
            imageSize,
            quality,
            count,
            references: [...referenceImages],
            products: [...productImages],
        };
        const slots = isBatchRun
            ? referenceImages.map((reference, index) => ({
                  id: nanoid(),
                  status: "running" as const,
                  prompt: finalPrompt,
                  referenceId: reference.id,
                  referenceName: reference.name,
                  referenceIndex: index,
              }))
            : Array.from({ length: count }, () => ({ id: nanoid(), status: "running" as const, prompt: finalPrompt }));
        if (override?.replaceId) {
            setResults((items) => items.map((item) => (item.id === override.replaceId ? slots[0] : item)));
        } else {
            setResults(slots);
        }

        const pendingLog = await saveHistoryFromSnapshot({ ...historySnapshot, status: "生成中", images: [], errors: [], durationMs: 0 });
        const historyLogMeta = pendingLog ? { id: pendingLog.id, createdAt: pendingLog.createdAt } : {};

        try {
            const requestConfig = buildRequestConfig(requestBaseConfig, requestModel, requestChannelId, aspectRatio, imageSize, quality, isBatchRun ? 1 : count);
            if (isBatchRun) {
                const batchItems = await Promise.all(
                    referenceImages.map(async (reference, index) => {
                        try {
                            const images = await requestEdit(requestConfig, finalPrompt, [reference, ...productImages]);
                            const image = images[0];
                            if (!image?.dataUrl) throw new Error("接口没有返回这张图片");
                            setResults((items) => items.map((item) => (item.id === slots[index].id ? { ...item, status: "success", dataUrl: image.dataUrl } : item)));
                            return { status: "success" as const, image };
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : "生成失败";
                            setResults((items) => items.map((item) => (item.id === slots[index].id ? { ...item, status: "failed", error: errorMessage } : item)));
                            return { status: "failed" as const, error: errorMessage };
                        }
                    }),
                );
                const images = batchItems.filter((item): item is { status: "success"; image: { id: string; dataUrl: string } } => item.status === "success").map((item) => item.image);
                const errors = batchItems.filter((item): item is { status: "failed"; error: string } => item.status === "failed").map((item) => item.error);
                if (images.length > 0) message.success(`已生成 ${images.length}/${count} 张详情图`);
                if (!images.length) message.error(errors[0] || "生成失败");
                else if (errors.length) message.warning(`有 ${errors.length} 张生成失败`);
                void saveHistoryFromSnapshot({ ...historySnapshot, ...historyLogMeta, status: images.length ? "成功" : "失败", images, errors, durationMs: performance.now() - startedAt });
                return;
            }
            const images = await requestEdit(requestConfig, finalPrompt, [...referenceImages, ...productImages]);
            setResults((items) => {
                const targetIds = override?.replaceId ? [slots[0].id] : slots.map((slot) => slot.id);
                let imageIndex = 0;
                return items.map((item) => {
                    if (!targetIds.includes(item.id)) return item;
                    const image = images[imageIndex++];
                    if (image?.dataUrl) return { ...item, status: "success", dataUrl: image.dataUrl };
                    return { ...item, status: "failed", error: "接口没有返回这张图片" };
                });
            });
            if (images.length > 0) message.success(`已生成 ${images.length} 张详情图`);
            void saveHistoryFromSnapshot({ ...historySnapshot, ...historyLogMeta, status: "成功", images, errors: [], durationMs: performance.now() - startedAt });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            setResults((items) =>
                items.map((item) => {
                    const target = override?.replaceId ? item.id === slots[0].id : slots.some((slot) => slot.id === item.id);
                    return target ? { ...item, status: "failed", error: errorMessage } : item;
                }),
            );
            message.error(errorMessage);
            void saveHistoryFromSnapshot({ ...historySnapshot, ...historyLogMeta, status: "失败", images: [], errors: [errorMessage], durationMs: performance.now() - startedAt });
        }
    };

    const copyPrompt = async () => {
        await navigator.clipboard?.writeText(finalPrompt);
        message.success("提示词已复制");
    };

    const openPromptEditor = () => {
        setPromptDraft(promptTemplate);
        setPromptEditorOpen(true);
    };

    const savePromptTemplate = () => {
        const nextPrompt = promptDraft.trim() || basePrompt;
        setPromptTemplate(nextPrompt);
        setPromptDraft(nextPrompt);
        setPromptEditorOpen(false);
        message.success("提示词已更新");
    };

    const resetPromptTemplate = () => {
        setPromptDraft(basePrompt);
    };

    const copyPromptDraft = async () => {
        await navigator.clipboard?.writeText(promptDraftFinal);
        message.success("提示词已复制");
    };

    const downloadResult = async (result: MirrorResult) => {
        if (!result.dataUrl) return;
        const response = await fetch(result.dataUrl);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `detail-style-${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const openResultInCanvas = async (result: MirrorResult, index: number) => {
        if (!result.dataUrl) return;
        if (!canvasHydrated) {
            message.warning("画布数据还在加载，请稍后再试");
            return;
        }
        try {
            const node = buildCanvasImageNodeFromResult(result, index, aspectRatio, imageSize);
            const projectId = createCanvasProject(`爆款复刻 方案 ${index + 1}`);
            updateCanvasProject(projectId, {
                nodes: [node],
                connections: [],
                chatSessions: [],
                activeChatId: null,
                viewport: initialCenteredCanvasViewport(),
            });
            message.success("已放入画布");
            router.push(`/canvas/${projectId}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "进入画布失败");
        }
    };

    const refreshHistoryLogs = async () => {
        setHistoryLogs(await readMirrorHistoryLogs());
    };

    const saveHistoryFromSnapshot = async (snapshot: MirrorHistoryBuildInput) => {
        try {
            const log = await buildMirrorHistoryLog(snapshot);
            const nextLogs = await saveMirrorHistoryLog(log);
            setHistoryLogs(nextLogs);
            setActiveHistoryLogId(log.id);
            return log;
        } catch (error) {
            console.warn("保存爆款复刻历史失败", error);
            message.warning(error instanceof Error ? `历史记录保存失败：${error.message}` : "生成完成，但历史记录保存失败");
            return null;
        }
    };

    const restoreHistoryLog = (log: MirrorHistoryLog) => {
        setReferenceImages(log.references.slice(0, maxReferenceImages));
        setProductImages(log.products.slice(0, maxProductImages));
        setPromptTemplate(log.promptTemplate || basePrompt);
        setPromptDraft(log.promptTemplate || basePrompt);
        setExtraPrompt(log.extraPrompt || "");
        setModel(log.model || effectiveConfig.imageModel || effectiveConfig.model);
        setModelChannelId(log.modelChannelId || "");
        if (log.model) updateConfig("imageModel", log.model);
        if (log.modelChannelId) updateConfig("imageChannelId", log.modelChannelId);
        setAspectRatio(log.aspectRatio || "1:1");
        setImageSize(log.imageSize || "1K");
        setQuality(log.quality || "auto");
        setImageCount(Math.max(1, Math.min(4, log.count || log.images.length || 2)));
        setResults(
            log.images.length
                ? log.images.map((image, index) => {
                      const reference = log.references[index];
                      return { id: image.id, status: "success", prompt: log.prompt, dataUrl: image.dataUrl, referenceId: reference?.id, referenceName: reference?.name, referenceIndex: reference ? index : undefined };
                  })
                : [{ id: log.id, status: log.status === "生成中" ? "running" : "failed", prompt: log.prompt, error: log.errors[0] || (log.status === "生成中" ? undefined : "生成失败") }],
        );
        setActiveHistoryLogId(log.id);
        setHistoryOpen(false);
        message.success("已恢复历史记录");
    };

    const deleteHistoryLog = async (log: MirrorHistoryLog) => {
        await mirrorHistoryStore.removeItem(log.id);
        setHistoryLogs((items) => items.filter((item) => item.id !== log.id));
        if (activeHistoryLogId === log.id) setActiveHistoryLogId("");
        message.success("已删除历史记录");
    };

    const clearHistoryLogs = () => {
        if (!historyLogs.length) return;
        modal.confirm({
            title: "清空历史记录",
            content: `确定清空 ${historyLogs.length} 条爆款复刻历史记录吗？`,
            okText: "清空",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await Promise.all(historyLogs.map((log) => mirrorHistoryStore.removeItem(log.id)));
                setHistoryLogs([]);
                setActiveHistoryLogId("");
            },
        });
    };

    return (
        <main className="h-full overflow-hidden bg-stone-50 text-stone-950 dark:bg-[#10100f] dark:text-stone-100">
            <input ref={referenceInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => void handleUpload(event, "reference")} />
            <input ref={productInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => void handleUpload(event, "product")} />

            <div className="grid h-full grid-cols-1 gap-3 p-3 lg:grid-cols-[390px_minmax(0,1fr)]">
                <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-[#171614] dark:shadow-none">
                    <div className="shrink-0 border-b border-stone-200 p-4 dark:border-stone-800">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="grid size-8 place-items-center rounded-md border border-stone-900 bg-stone-950 text-white dark:border-stone-700 dark:bg-[#111] dark:text-stone-100">
                                        <WandSparkles className="size-4" />
                                    </span>
                                    <h1 className="truncate text-xl font-semibold tracking-normal text-stone-950 dark:text-white">爆款复刻</h1>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Tag className="m-0 border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-black/50 dark:text-stone-200">Style Mirror</Tag>
                                    <Tag className="m-0 border-stone-300 bg-stone-950 text-white dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200">电商投流</Tag>
                                </div>
                            </div>
                            <Tooltip title="打开模型配置">
                                <Button icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false)} />
                            </Tooltip>
                        </div>
                    </div>

                    <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                        <UploadPanel
                            title="参考设计图"
                            subtitle={`${referenceImages.length}/${maxReferenceImages}`}
                            images={referenceImages}
                            emptyText="上传风格参考"
                            maxImages={maxReferenceImages}
                            onUpload={() => referenceInputRef.current?.click()}
                            onDropFiles={(files) => void uploadFiles(files, "reference")}
                            onPreview={(image) => setActiveUploadPreview(image)}
                            onRemove={(id) => void removeImage("reference", id)}
                        />
                        <UploadPanel
                            title="产品素材图"
                            subtitle={`${productImages.length}/${maxProductImages}`}
                            images={productImages}
                            emptyText="上传产品图片"
                            maxImages={maxProductImages}
                            onUpload={() => productInputRef.current?.click()}
                            onDropFiles={(files) => void uploadFiles(files, "product")}
                            onRemove={(id) => void removeImage("product", id)}
                        />

                        <section className="space-y-2">
                            <PanelHeader title="补充提示词" icon={<Sparkles className="size-4" />} />
                            <Input.TextArea value={extraPrompt} onChange={(event) => setExtraPrompt(event.target.value)} placeholder="可补充产品卖点、目标平台、画面禁忌或文案要求" autoSize={{ minRows: 4, maxRows: 7 }} maxLength={600} showCount />
                        </section>

                        <section className="space-y-3">
                            <PanelHeader title="生成参数" icon={<Gauge className="size-4" />} />
                            <ControlField label="模型">
                                <ModelPicker
                                    config={effectiveConfig}
                                    value={model}
                                    channelId={modelChannelId}
                                    onChange={(value, channelId) => {
                                        setModel(value);
                                        setModelChannelId(channelId || "");
                                        updateConfig("imageModel", value);
                                        if (channelId) updateConfig("imageChannelId", channelId);
                                    }}
                                    fullWidth
                                    onMissingConfig={() => openConfigDialog(false)}
                                />
                                <div className="mt-1 truncate text-xs text-stone-500">当前渠道：{modelChannelName || "未匹配渠道"}</div>
                            </ControlField>
                            <ControlField label="尺寸比例">
                                <Select className="w-full" value={aspectRatio} options={aspectRatioOptions.map((item) => ({ label: item.label, value: item.value }))} onChange={(value) => setAspectRatio(value)} />
                            </ControlField>
                            <div className="grid grid-cols-2 gap-2">
                                <ControlField label="质量">
                                    <Select
                                        value={quality}
                                        options={[
                                            { label: "自动", value: "auto" },
                                            { label: "高", value: "high" },
                                            { label: "中", value: "medium" },
                                        ]}
                                        onChange={setQuality}
                                    />
                                </ControlField>
                                <ControlField label="清晰度">
                                    <Select
                                        value={imageSize}
                                        options={[
                                            { label: "自动", value: "auto" },
                                            { label: "1K", value: "1K" },
                                            { label: "2K", value: "2K" },
                                        ]}
                                        onChange={setImageSize}
                                    />
                                </ControlField>
                            </div>
                            <div className="grid grid-cols-1 gap-2">
                                <ControlField label="数量">
                                    <Select disabled={isBatchMode} value={imageCount} options={[1, 2, 3, 4].map((value) => ({ label: `${value} 张`, value }))} onChange={setImageCount} />
                                    {isBatchMode ? <div className="mt-1 text-xs text-stone-500">批量模式按参考图数量生成：{referenceImages.length} 张</div> : null}
                                </ControlField>
                            </div>
                        </section>
                    </div>

                    <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                        <Button type="primary" size="large" block icon={isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />} disabled={!canGenerate} onClick={() => void submitGenerate()}>
                            {isGenerating ? "正在生成" : `生成 ${effectiveResultCount} 张详情图`}
                        </Button>
                        <div className="mt-2 flex items-center justify-between text-xs text-stone-500">
                            <span>{aspectRatioOptions.find((item) => item.value === aspectRatio)?.hint}</span>
                            <button type="button" className="font-medium text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white" onClick={() => void copyPrompt()}>
                                复制提示词
                            </button>
                        </div>
                    </div>
                </aside>

                <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-[#171716] dark:shadow-none">
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 p-4 dark:border-stone-800">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h2 className="text-xl font-semibold text-stone-950 dark:text-white">生成结果</h2>
                                <Tag className="m-0 border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
                                    {successCount}/{results.length || effectiveResultCount}
                                </Tag>
                                {isGenerating ? <Tag className="m-0 border-stone-300 bg-stone-950 text-white dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200">生成中</Tag> : null}
                            </div>
                            <p className="mt-1 truncate text-xs text-stone-500">参考设计图学习风格，产品素材图保持主体一致。</p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                            <Button icon={<History className="size-4" />} onClick={() => setHistoryOpen(true)}>
                                历史 {historyLogs.length}
                            </Button>
                            <Button icon={<Copy className="size-4" />} onClick={openPromptEditor}>
                                提示词
                            </Button>
                            <Button icon={<RefreshCw className="size-4" />} disabled={isGenerating || results.length === 0} onClick={() => void submitGenerate()}>
                                重新生成
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
                        {results.length === 0 ? (
                            <EmptyResult />
                        ) : (
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                {results.map((result, index) => (
                                    <ResultCard
                                        key={result.id}
                                        result={result}
                                        index={index}
                                        aspectRatio={aspectRatio}
                                        onPreview={() => setActivePreview(result)}
                                        onDownload={() => void downloadResult(result)}
                                        onOpenCanvas={() => void openResultInCanvas(result, index)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </section>
            </div>

            <Modal open={Boolean(activePreview?.dataUrl)} footer={null} onCancel={() => setActivePreview(null)} width={860} centered>
                {activePreview?.dataUrl ? <img src={activePreview.dataUrl} alt="详情图预览" className="mt-6 max-h-[76vh] w-full rounded-lg object-contain" /> : null}
            </Modal>
            <Modal open={Boolean(activeUploadPreview)} footer={null} onCancel={() => setActiveUploadPreview(null)} width={720} centered>
                {activeUploadPreview ? <img src={activeUploadPreview.dataUrl} alt={activeUploadPreview.name} className="mt-6 max-h-[76vh] w-full rounded-lg object-contain" /> : null}
            </Modal>
            <Modal
                title="编辑提示词"
                open={promptEditorOpen}
                width={820}
                onCancel={() => setPromptEditorOpen(false)}
                footer={[
                    <Button key="reset" icon={<RefreshCw className="size-4" />} onClick={resetPromptTemplate}>
                        恢复默认
                    </Button>,
                    <Button key="copy" icon={<Copy className="size-4" />} onClick={() => void copyPromptDraft()}>
                        复制当前
                    </Button>,
                    <Button key="cancel" onClick={() => setPromptEditorOpen(false)}>
                        取消
                    </Button>,
                    <Button key="save" type="primary" onClick={savePromptTemplate}>
                        保存
                    </Button>,
                ]}
            >
                <div className="space-y-4 pt-2">
                    <label className="block space-y-2">
                        <span className="text-sm font-semibold text-stone-700 dark:text-stone-200">核心提示词</span>
                        <Input.TextArea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} autoSize={{ minRows: 8, maxRows: 14 }} placeholder="输入爆款复刻的核心提示词" showCount />
                    </label>
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600 dark:border-stone-800 dark:bg-[#111] dark:text-stone-300">
                        <div className="mb-2 font-semibold">最终提交给模型</div>
                        <div className="max-h-36 overflow-y-auto whitespace-pre-wrap leading-5">{promptDraftFinal}</div>
                    </div>
                </div>
            </Modal>
            <Drawer title="爆款复刻历史" placement="right" size={420} open={historyOpen} onClose={() => setHistoryOpen(false)}>
                <MirrorHistoryPanel logs={historyLogs} activeLogId={activeHistoryLogId} onRestore={restoreHistoryLog} onDelete={(log) => void deleteHistoryLog(log)} onClear={clearHistoryLogs} />
            </Drawer>
        </main>
    );
}

function UploadPanel({
    title,
    subtitle,
    images,
    emptyText,
    maxImages,
    singlePreview = false,
    onUpload,
    onDropFiles,
    onPreview,
    onRemove,
}: {
    title: string;
    subtitle: string;
    images: ReferenceImage[];
    emptyText: string;
    maxImages: number;
    singlePreview?: boolean;
    onUpload: () => void;
    onDropFiles: (files: File[]) => void;
    onPreview?: (image: ReferenceImage) => void;
    onRemove: (id: string) => void;
}) {
    const [dragging, setDragging] = useState(false);
    const handleDragEnter = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (Array.from(event.dataTransfer.types).includes("Files")) {
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
        }
    };
    const handleDragOver = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        if (Array.from(event.dataTransfer.types).includes("Files")) setDragging(true);
    };
    const handleDragLeave = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setDragging(false);
    };
    const handleDrop = (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) onDropFiles(files);
    };
    const dropHandlers = {
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
    };
    const dropZoneActiveClass = "border-cyan-500 bg-cyan-50 text-cyan-700 dark:border-cyan-400 dark:bg-cyan-500/10 dark:text-cyan-100";
    const canAddMore = images.length < maxImages;

    return (
        <section className="space-y-2">
            <div className="flex items-center justify-between">
                <PanelHeader title={title} icon={<ImagePlus className="size-4" />} />
                <Tag className="m-0 border-stone-300 bg-white text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200">{subtitle}</Tag>
            </div>
            {images.length && singlePreview ? (
                <div className={cn("rounded-lg", dragging && "outline outline-2 outline-cyan-500/70 outline-offset-2")} {...dropHandlers}>
                    {images.map((image) => (
                        <div key={image.id} className="group relative overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-black">
                            <button type="button" className="block w-full cursor-zoom-in" onClick={() => onPreview?.(image)} aria-label="预览图片">
                                <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                            </button>
                            <span className="pointer-events-none absolute inset-0 bg-black/0 transition group-hover:bg-black/10 dark:group-hover:bg-white/5" />
                            <button
                                type="button"
                                className="absolute left-2 top-2 grid size-9 place-items-center rounded-full border border-white/80 bg-black/80 text-white opacity-0 shadow-[0_4px_14px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-black/20 hover:bg-white hover:text-stone-950 group-hover:opacity-100"
                                onClick={() => onPreview?.(image)}
                                aria-label="预览图片"
                            >
                                <Eye className="size-5 stroke-[2.5]" />
                            </button>
                            <button
                                type="button"
                                className="absolute right-2 top-2 grid size-9 place-items-center rounded-full border border-white/80 bg-black/80 text-white opacity-0 shadow-[0_4px_14px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-black/20 hover:bg-white hover:text-stone-950 group-hover:opacity-100"
                                onClick={() => onRemove(image.id)}
                                aria-label="删除图片"
                            >
                                <X className="size-5 stroke-[2.5]" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : images.length ? (
                <div className={cn("grid grid-cols-3 gap-2 rounded-md", dragging && "outline outline-2 outline-cyan-500/70 outline-offset-2")} {...dropHandlers}>
                    {images.map((image) => (
                        <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 bg-white dark:border-stone-800 dark:bg-black">
                            {onPreview ? (
                                <button type="button" className="block w-full cursor-zoom-in" onClick={() => onPreview(image)} aria-label="预览图片">
                                    <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                </button>
                            ) : (
                                <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                            )}
                            <button
                                type="button"
                                className="absolute right-1 top-1 grid size-7 place-items-center rounded-full border border-white/80 bg-black/80 text-white opacity-0 shadow-[0_3px_10px_rgba(0,0,0,0.45)] backdrop-blur transition hover:border-black/20 hover:bg-white hover:text-stone-950 group-hover:opacity-100"
                                onClick={() => onRemove(image.id)}
                                aria-label="删除图片"
                            >
                                <X className="size-4 stroke-[2.5]" />
                            </button>
                        </div>
                    ))}
                    {canAddMore ? (
                        <button
                            type="button"
                            className={cn(
                                "grid aspect-square place-items-center rounded-md border border-dashed border-stone-300 bg-stone-50 text-stone-500 transition hover:border-stone-500 hover:text-stone-950 dark:border-stone-700 dark:bg-[#111] dark:hover:text-stone-100",
                                dragging && dropZoneActiveClass,
                            )}
                            onClick={onUpload}
                            aria-label={emptyText}
                        >
                            <UploadCloud className="size-5" />
                        </button>
                    ) : null}
                </div>
            ) : (
                <button
                    type="button"
                    className={cn(
                        "grid min-h-36 w-full place-items-center rounded-lg border border-dashed border-stone-300 bg-stone-50 text-sm text-stone-500 transition hover:border-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:border-stone-700 dark:bg-[#111] dark:hover:bg-black/60 dark:hover:text-stone-100",
                        dragging && dropZoneActiveClass,
                    )}
                    onClick={onUpload}
                    {...dropHandlers}
                >
                    <span className="flex flex-col items-center gap-2">
                        <UploadCloud className="size-7" />
                        {emptyText}
                    </span>
                </button>
            )}
        </section>
    );
}

function PanelHeader({ title, icon }: { title: string; icon: ReactNode }) {
    return (
        <div className="flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-stone-200">
            <span className="text-stone-500">{icon}</span>
            {title}
        </div>
    );
}

function ControlField({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block space-y-1.5 text-xs font-medium text-stone-600 dark:text-stone-400">
            <span>{label}</span>
            {children}
        </label>
    );
}

function EmptyResult() {
    return (
        <div className="grid h-full min-h-[520px] place-items-center rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-800 dark:bg-[#10100f]">
            <div className="max-w-sm text-center">
                <div className="mx-auto grid size-16 place-items-center rounded-lg border border-stone-200 bg-white text-stone-500 shadow-sm dark:border-stone-800 dark:bg-[#171614] dark:shadow-none">
                    <WandSparkles className="size-7" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-stone-950 dark:text-white">等待生成详情图</h3>
                <p className="mt-2 text-sm leading-6 text-stone-500">结果会按生成数量出现在这里，可预览、下载或进入画布。</p>
            </div>
        </div>
    );
}

function ResultCard({ result, index, aspectRatio, onPreview, onDownload, onOpenCanvas }: { result: MirrorResult; index: number; aspectRatio: AspectRatio; onPreview: () => void; onDownload: () => void; onOpenCanvas: () => void }) {
    const ratioClass = aspectRatio === "16:9" ? "aspect-video" : aspectRatio === "9:16" ? "aspect-[9/16]" : aspectRatio === "3:4" ? "aspect-[3/4]" : aspectRatio === "4:5" ? "aspect-[4/5]" : "aspect-square";
    const title = result.referenceIndex !== undefined ? `参考 ${result.referenceIndex + 1} · 详情图方案` : `详情图方案 ${index + 1}`;
    return (
        <article className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-[#11100f] dark:shadow-none">
            <div className={cn("group relative grid place-items-center bg-stone-100 dark:bg-black", ratioClass)}>
                {result.status === "running" ? (
                    <div className="flex flex-col items-center gap-3 text-stone-500">
                        <LoaderCircle className="size-8 animate-spin text-stone-900 dark:text-stone-200" />
                        <span className="text-sm">分析风格并生成中</span>
                    </div>
                ) : result.status === "success" && result.dataUrl ? (
                    <Image src={result.dataUrl} alt={title} preview={false} className="h-full w-full object-cover" />
                ) : (
                    <div className="px-6 text-center text-sm text-red-600 dark:text-red-300">{result.error || "生成失败"}</div>
                )}
                <span className="absolute left-2 top-2 rounded border border-stone-200 bg-white/90 px-2 py-1 text-xs font-medium text-stone-700 shadow-sm dark:border-stone-700 dark:bg-black/80 dark:text-stone-100 dark:shadow-none">#{index + 1}</span>
                {result.status === "success" && result.dataUrl ? (
                    <>
                        <div className="pointer-events-none absolute inset-0 z-10 bg-black/35 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100" />
                        <div className="absolute inset-0 z-20 flex scale-95 items-center justify-center gap-2 opacity-0 transition duration-200 group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100">
                            <Tooltip title="放大预览">
                                <Button shape="circle" icon={<Eye className="size-4" />} aria-label="放大预览" className="border-0 bg-white/95 text-stone-700 shadow-lg backdrop-blur hover:!bg-white hover:!text-stone-950" onClick={onPreview} />
                            </Tooltip>
                            <Tooltip title="下载">
                                <Button shape="circle" icon={<Download className="size-4" />} aria-label="下载" className="border-0 bg-white/95 text-stone-700 shadow-lg backdrop-blur hover:!bg-white hover:!text-stone-950" onClick={onDownload} />
                            </Tooltip>
                            <Tooltip title="进入画布">
                                <Button shape="circle" icon={<Pencil className="size-4" />} aria-label="进入画布" className="border-0 bg-emerald-500 text-white shadow-lg backdrop-blur hover:!bg-emerald-500 hover:!text-white" onClick={onOpenCanvas} />
                            </Tooltip>
                        </div>
                    </>
                ) : null}
            </div>
            <div className="p-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-stone-950 dark:text-white">{title}</div>
                    {result.referenceName ? <div className="mt-0.5 truncate text-xs text-stone-500">{result.referenceName}</div> : null}
                    <div className="mt-0.5 text-xs text-stone-500">{statusText(result.status)}</div>
                </div>
            </div>
        </article>
    );
}

function MirrorHistoryPanel({ logs, activeLogId, onRestore, onDelete, onClear }: { logs: MirrorHistoryLog[]; activeLogId: string; onRestore: (log: MirrorHistoryLog) => void; onDelete: (log: MirrorHistoryLog) => void; onClear: () => void }) {
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-stone-500">
                    <History className="size-4" />
                    <span>最多保留 {maxMirrorHistoryLogs} 条</span>
                </div>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={onClear}>
                    清空
                </Button>
            </div>
            {!logs.length ? (
                <div className="grid min-h-72 place-items-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史记录" />
                </div>
            ) : (
                <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                    {logs.map((log) =>
                        log.images.length ? (
                            log.images.map((image, index) => (
                                <div
                                    key={`${log.id}-${image.id}`}
                                    role="button"
                                    tabIndex={0}
                                    className={cn(
                                        "group relative overflow-hidden rounded-lg border bg-black shadow-sm transition focus:outline-none",
                                        "hover:border-stone-500 focus-visible:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500/40",
                                        activeLogId === log.id ? "border-cyan-500 shadow-[0_0_0_1px_rgba(6,182,212,.35)]" : "border-stone-800",
                                    )}
                                    style={{ aspectRatio: image.width && image.height ? `${image.width} / ${image.height}` : "1 / 1" }}
                                    onClick={() => onRestore(log)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            onRestore(log);
                                        }
                                    }}
                                >
                                    <img src={image.dataUrl} alt={image.name || `爆款复刻历史图 ${index + 1}`} className="h-full w-full object-cover" />
                                    {log.images.length > 1 ? <span className="absolute left-2 top-2 rounded border border-white/20 bg-black/70 px-2 py-1 text-xs font-medium text-white shadow-sm">#{index + 1}</span> : null}
                                    <Tooltip title="删除">
                                        <Button
                                            size="small"
                                            danger
                                            type="primary"
                                            shape="circle"
                                            className="!absolute right-2 top-2 z-10 opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
                                            icon={<Trash2 className="size-3.5" />}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onDelete(log);
                                            }}
                                        />
                                    </Tooltip>
                                </div>
                            ))
                        ) : (
                            <div
                                key={log.id}
                                role="button"
                                tabIndex={0}
                                className={cn(
                                    "group relative grid aspect-square place-items-center overflow-hidden rounded-lg border bg-black text-center shadow-sm transition focus:outline-none",
                                    "hover:border-stone-500 focus-visible:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500/40",
                                    activeLogId === log.id ? "border-cyan-500 shadow-[0_0_0_1px_rgba(6,182,212,.35)]" : "border-stone-800",
                                )}
                                onClick={() => onRestore(log)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        onRestore(log);
                                    }
                                }}
                            >
                                <div className={cn("flex flex-col items-center gap-3 px-6 text-sm", log.status === "生成中" ? "text-stone-300" : "text-red-300")}>
                                    {log.status === "生成中" ? <LoaderCircle className="size-8 animate-spin" /> : <Trash2 className="size-8" />}
                                    <span>{log.status === "生成中" ? "生成中" : log.errors[0] || "生成失败"}</span>
                                </div>
                                <Tooltip title="删除">
                                    <Button
                                        size="small"
                                        danger
                                        type="primary"
                                        shape="circle"
                                        className="!absolute right-2 top-2 z-10 opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
                                        icon={<Trash2 className="size-3.5" />}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onDelete(log);
                                        }}
                                    />
                                </Tooltip>
                            </div>
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

type MirrorHistoryBuildInput = {
    id?: string;
    createdAt?: number;
    prompt: string;
    promptTemplate: string;
    extraPrompt: string;
    model: string;
    modelChannelId: string;
    modelChannelName: string;
    aspectRatio: AspectRatio;
    imageSize: ImageSize;
    quality: string;
    count: number;
    durationMs: number;
    status: MirrorHistoryLog["status"];
    references: ReferenceImage[];
    products: ReferenceImage[];
    images: Array<{ id: string; dataUrl: string }>;
    errors: string[];
};

async function buildMirrorHistoryLog(input: MirrorHistoryBuildInput): Promise<MirrorHistoryLog> {
    const [references, products, images] = await Promise.all([cloneHistoryReferences(input.references), cloneHistoryReferences(input.products), cloneHistoryImages(input.images)]);
    return {
        id: input.id || nanoid(),
        createdAt: input.createdAt || Date.now(),
        title: historyTitle(input.prompt),
        prompt: input.prompt,
        promptTemplate: input.promptTemplate,
        extraPrompt: input.extraPrompt,
        model: input.model,
        modelChannelId: input.modelChannelId,
        modelChannelName: input.modelChannelName,
        aspectRatio: input.aspectRatio,
        imageSize: input.imageSize,
        quality: input.quality,
        count: input.count,
        durationMs: input.durationMs,
        status: input.status,
        references,
        products,
        images,
        errors: input.errors,
    };
}

async function saveMirrorHistoryLog(log: MirrorHistoryLog) {
    await mirrorHistoryStore.setItem(log.id, log);
    const logs = await readMirrorHistoryLogs();
    const removable = logs.slice(maxMirrorHistoryLogs);
    if (removable.length) await Promise.all(removable.map((item) => mirrorHistoryStore.removeItem(item.id)));
    return logs.slice(0, maxMirrorHistoryLogs);
}

async function readMirrorHistoryLogs() {
    if (typeof window === "undefined") return [];
    const logs: MirrorHistoryLog[] = [];
    try {
        await mirrorHistoryStore.iterate<MirrorHistoryLog, void>((value) => {
            logs.push(normalizeMirrorHistoryLog(value));
        });
    } catch {
        return [];
    }
    return logs.sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeMirrorHistoryLog(log: Partial<MirrorHistoryLog>): MirrorHistoryLog {
    const aspectRatio: AspectRatio = aspectRatioOptions.some((item) => item.value === log.aspectRatio) ? (log.aspectRatio as AspectRatio) : "1:1";
    const imageSize = log.imageSize === "auto" || log.imageSize === "1K" || log.imageSize === "2K" ? log.imageSize : "1K";
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || historyTitle(log.prompt || ""),
        prompt: log.prompt || "",
        promptTemplate: log.promptTemplate || basePrompt,
        extraPrompt: log.extraPrompt || "",
        model: log.model || "",
        modelChannelId: log.modelChannelId || "",
        modelChannelName: log.modelChannelName || "",
        aspectRatio,
        imageSize,
        quality: log.quality || "auto",
        count: Math.max(1, Math.min(maxReferenceImages, Number(log.count) || log.images?.length || 2)),
        durationMs: log.durationMs || 0,
        status: log.status === "失败" ? "失败" : log.status === "生成中" ? "生成中" : "成功",
        references: normalizeHistoryReferences(log.references || []),
        products: normalizeHistoryReferences(log.products || []),
        images: normalizeHistoryImages(log.images || []),
        errors: Array.isArray(log.errors) ? log.errors.filter(Boolean) : [],
    };
}

async function cloneHistoryReferences(images: ReferenceImage[]) {
    return Promise.all(images.map(cloneHistoryReference));
}

async function cloneHistoryReference(image: ReferenceImage): Promise<ReferenceImage> {
    const dataUrl = await historyImageToDataUrl(image);
    const meta = await readImageMeta(dataUrl);
    return {
        id: image.id || nanoid(),
        name: image.name || "image.png",
        type: image.type || meta.mimeType || "image/png",
        dataUrl,
        width: image.width || meta.width,
        height: image.height || meta.height,
        bytes: image.bytes || getDataUrlByteSize(dataUrl),
        source: image.source,
        assetId: image.assetId,
        temporary: false,
    };
}

async function cloneHistoryImages(images: Array<{ id: string; dataUrl: string }>) {
    return Promise.all(
        images.map(async (image, index) => {
            const dataUrl = await historyImageToDataUrl({ dataUrl: image.dataUrl });
            const meta = await readImageMeta(dataUrl);
            return {
                id: image.id || nanoid(),
                name: `详情图 ${index + 1}.png`,
                type: meta.mimeType || "image/png",
                dataUrl,
                width: meta.width,
                height: meta.height,
                bytes: getDataUrlByteSize(dataUrl),
            };
        }),
    );
}

async function historyImageToDataUrl(image: { dataUrl?: string; url?: string; storageKey?: string }) {
    let lastError = "";
    try {
        const dataUrl = await imageToDataUrl(image);
        if (dataUrl) return dataUrl;
    } catch (error) {
        lastError = error instanceof Error ? error.message : "图片读取失败";
    }

    const remoteUrl = [image.dataUrl, image.url].find((value) => typeof value === "string" && /^https?:\/\//i.test(value));
    if (!remoteUrl) throw new Error(lastError || "图片读取失败");

    const response = await fetch("/api/remote-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: remoteUrl }),
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { msg?: string } | null;
        throw new Error(payload?.msg || `远程图片读取失败：${response.status}`);
    }
    return blobToDataUrl(await response.blob());
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(blob);
    });
}

function normalizeHistoryReferences(images: ReferenceImage[]) {
    return images
        .filter((image) => Boolean(image?.dataUrl))
        .map((image) => ({
            id: image.id || nanoid(),
            name: image.name || "image.png",
            type: image.type || "image/png",
            dataUrl: image.dataUrl,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            source: image.source,
            assetId: image.assetId,
            temporary: false,
        }));
}

function normalizeHistoryImages(images: MirrorHistoryImage[]) {
    return images
        .filter((image) => Boolean(image?.dataUrl))
        .map((image, index) => ({
            id: image.id || nanoid(),
            name: image.name || `详情图 ${index + 1}.png`,
            type: image.type || "image/png",
            dataUrl: image.dataUrl,
            width: image.width || 1024,
            height: image.height || 1024,
            bytes: image.bytes || getDataUrlByteSize(image.dataUrl),
        }));
}

function historyTitle(prompt: string) {
    const compact = prompt.replace(/\s+/g, " ").trim();
    return compact.slice(0, 18) || "爆款复刻";
}

function readStoredPromptTemplate() {
    if (typeof window === "undefined") return basePrompt;
    try {
        return window.localStorage.getItem(promptTemplateStorageKey)?.trim() || basePrompt;
    } catch {
        return basePrompt;
    }
}

function buildFinalPrompt(promptTemplate: string, extraPrompt: string) {
    return [(promptTemplate || basePrompt).trim(), extraPrompt.trim()].filter(Boolean).join("\n\n");
}

function buildRequestConfig(config: AiConfig, model: string, channelId: string, aspectRatio: AspectRatio, imageSize: ImageSize, quality: string, count: number): AiConfig {
    return {
        ...config,
        model,
        imageModel: model,
        imageChannelId: channelId,
        activeChannelId: channelId,
        size: sizeMap[imageSize][aspectRatio] || aspectRatio,
        quality,
        count: String(count),
        outputFormat: "png",
        responseFormatB64Json: true,
    };
}

function resolveModelChannelName(config: AiConfig, channelId: string, model: string) {
    const channels =
        config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({ id: channel.id, name: channel.name || "云端渠道", models: channel.models }))
            : config.localChannels.map((channel) => ({ id: channel.id, name: channel.name || "本地渠道", models: channel.models }));
    return channels.find((channel) => channel.id === channelId && channel.models.includes(model))?.name || channels.find((channel) => channel.models.includes(model))?.name || "";
}

function buildCanvasImageNodeFromResult(result: MirrorResult, index: number, aspectRatio: AspectRatio, imageSize: ImageSize): CanvasNodeData {
    const image = estimateCanvasImageMeta(result.dataUrl || "", aspectRatio, imageSize);
    const size = fitNodeSize(image.width, image.height);
    return {
        id: `image-${Date.now()}-${nanoid().slice(0, 5)}`,
        type: CanvasNodeType.Image,
        title: `爆款复刻 方案 ${index + 1}`,
        position: { x: -size.width / 2, y: -size.height / 2 },
        width: size.width,
        height: size.height,
        metadata: {
            content: image.url,
            prompt: result.prompt,
            status: "success",
            naturalWidth: image.width,
            naturalHeight: image.height,
            mimeType: image.mimeType,
            bytes: image.bytes,
            skipInitialStorageUpload: true,
            hidePromptPanel: true,
        },
    };
}

function estimateCanvasImageMeta(url: string, aspectRatio: AspectRatio, imageSize: ImageSize) {
    const explicitSize = sizeMap[imageSize][aspectRatio];
    const dimensions = parseCanvasImageDimensions(explicitSize || aspectRatio);
    return {
        url,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: url.match(/^data:([^;]+)/)?.[1] || "image/png",
        bytes: url.startsWith("data:") ? getDataUrlByteSize(url) : 0,
    };
}

function parseCanvasImageDimensions(size: string) {
    const match = size.match(/^(\d+)(?:x|:)(\d+)/);
    const width = Math.max(1, Number(match?.[1]) || 1);
    const height = Math.max(1, Number(match?.[2]) || 1);
    if (size.includes("x")) return { width, height };
    const maxSide = 1024;
    return width >= height ? { width: maxSide, height: Math.round((maxSide * height) / width) } : { width: Math.round((maxSide * width) / height), height: maxSide };
}

function initialCenteredCanvasViewport() {
    if (typeof window === "undefined") return { x: 600, y: 360, k: 1 };
    return { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2), k: 1 };
}

function statusText(status: MirrorStatus) {
    if (status === "running") return "生成中";
    if (status === "success") return "已完成";
    if (status === "failed") return "失败";
    return "等待中";
}

async function cleanupStoredImages(images: ReferenceImage[]) {
    const keys = images.map((image) => image.storageKey).filter((key): key is string => Boolean(key));
    if (keys.length) await deleteStoredImages(keys);
}
