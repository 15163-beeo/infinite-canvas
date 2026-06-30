"use client";

import { App, Button, Drawer, Empty, Image, Input, Modal, Select, Tag, Tooltip } from "antd";
import { Download, Eye, Gauge, History, ImagePlus, LoaderCircle, Pencil, RefreshCw, Settings2, Sparkles, Trash2, UploadCloud, WandSparkles, X } from "lucide-react";
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
import { createAestheticMirrorJob, fetchAestheticMirrorJob, type AestheticMirrorJobImagePayload } from "@/services/api/aesthetic-mirror";
import { requestEdit } from "@/services/api/image";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { normalizeLocalChannels, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type UploadRole = "reference" | "product";
type MirrorStatus = "idle" | "running" | "success" | "failed";
type MirrorMode = "single" | "batch";

type MirrorResult = {
    id: string;
    status: MirrorStatus;
    prompt: string;
    jobId?: string;
    referenceId?: string;
    referenceName?: string;
    referenceIndex?: number;
    groupIndex?: number;
    dataUrl?: string;
    width?: number;
    height?: number;
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
    referenceIndex?: number;
    referenceName?: string;
    groupIndex?: number;
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
    groupCount: number;
    durationMs: number;
    status: "生成中" | "成功" | "失败";
    references: ReferenceImage[];
    products: ReferenceImage[];
    images: MirrorHistoryImage[];
    errors: string[];
};

type AspectRatio = "1:1" | "3:4" | "4:5" | "9:16" | "16:9";
type ImageSize = "auto" | "1K" | "2K";
type ProductPresence = "required" | "optional" | "forbidden";
type ReferenceLayoutType = "product_hero" | "symptom_grid" | "doctor_endorsement" | "mechanism" | "data_proof" | "comparison";

type ReferenceRule = {
    productPresence?: ProductPresence;
    layoutType?: ReferenceLayoutType;
};

type ParsedReferenceRules = {
    globalExtraPrompt: string;
    rules: Record<number, ReferenceRule>;
};

const maxProductImages = 6;
const singleModeReferenceLimit = 1;
const batchModeReferenceLimit = 20;
const maxMirrorHistoryLogs = 50;
const aestheticMirrorBatchRequestGapMs = 2500;
const aestheticMirrorBatchTransientRetryCount = 2;
const aestheticMirrorBatchTransientRetryBaseDelayMs = 8000;
const mirrorHistoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "aesthetic_mirror_logs" });
const basePrompt = `System Prompt

你是资深电商视觉策略师、商业摄影导演、AI 图像提示词工程师。

你的任务是根据【参考图】提取可迁移的视觉风格，包括构图、背景质感、信息层级、产品展示方式、视觉风格等，用产品素材图中的真实产品重新设计类似风格的爆款电商图。并将该风格迁移到【商品图】上，生成适合图像生成模型使用的高质量prompt。

你必须遵守：
1. 只复刻风格，不复制参考图中的品牌、Logo、人物身份、受保护角色、商标、具体版式或独特版权元素。
2. 严格保持产品的瓶形轮廓、颜色、透明液体质感、瓶盖、标签结构、品牌logo标识和文字、可见细节，不要重绘成新产品，不要替换包装，不要伪造新品牌或新标签。
3. 产品真实清晰、不变形，产品位置、大小、角度、透视、光影和阴影要自然匹配参考图，文字锐化清晰、无乱码。
4. 不得虚构商品不存在的功能、认证、材质或功效。
5. 参考图中没有具体产品的，AI生成的电商图也严禁摆放产品。
6. 用户需求与商品事实冲突时，以商品事实为准。
7. 输出必须服务于电商转化，画面应清晰、专业、可商用。

You are a senior e-commerce visual strategist, commercial photography director, and AI image prompt engineer.
Your task is to extract transferable visual styles from the [Reference Image], including composition, background texture, information hierarchy, product display methods, visual tone and more. Redesign high-converting e-commerce product visuals in the matching style using the actual product from the product material image, then generate high-quality prompts compatible with image generation models to apply this style to the [Product Image].
You must abide by the following rules strictly:
1.Replicate only the visual style. Do not copy brands, logos, character identities, copyrighted characters, trademarks, exclusive layout formats or proprietary copyrighted elements from the reference image.
2.Precisely retain the product’s bottle shape, color, transparent liquid texture, cap design, label structure, brand logo, text content and all visible details. Do not redraw it as a new product, alter packaging, fabricate fake brands or custom labels.
3.Keep the product realistic, sharp and distortion-free. Naturally match the product’s position, scale, shooting angle, perspective, light and shadow to the reference image. Ensure all text is sharp, legible and free of garbled characters.
4.Do not fabricate non-existent functions, certifications, materials or efficacy claims for the product.
5.No products are allowed to be placed in the AI-generated e-commerce artwork when no specific product appears in the reference image.
6.In case of conflicts between user requirements and the actual product attributes, always prioritize the factual specifications of the product.
7.All outputs shall be optimized for e-commerce conversion, featuring crisp, professional visuals fully eligible for commercial use.`;

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

const gptImage2StableSizeMap: Record<Exclude<ImageSize, "auto">, Record<AspectRatio, string>> = {
    "1K": {
        "1:1": "1024x1024",
        "3:4": "1024x1536",
        "4:5": "1024x1536",
        "9:16": "1024x1536",
        "16:9": "1536x1024",
    },
    "2K": {
        "1:1": "2048x2048",
        "3:4": "1440x2160",
        "4:5": "1440x2160",
        "9:16": "1440x2160",
        "16:9": "2160x1440",
    },
};

const aestheticMirrorGptImage2ModelAliases = new Set(["gpt-image-2", "gpt-image-2-official", "novadream-img-2"]);

function normalizeAestheticMirrorModelName(model: string) {
    return model.trim().toLowerCase();
}

function isAestheticMirrorGptImage2Model(model: string) {
    return aestheticMirrorGptImage2ModelAliases.has(normalizeAestheticMirrorModelName(model));
}

function isAestheticMirrorApimartChannel(config: AiConfig, channelId: string, model: string) {
    const channels =
        config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({ id: channel.id, name: channel.name || "云端渠道", baseUrl: channel.baseUrl, models: channel.models }))
            : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, name: channel.name || "本地渠道", baseUrl: channel.baseUrl, models: channel.models }));
    const channel =
        channels.find((item) => item.id === channelId && item.models.includes(model)) ||
        channels.find((item) => item.models.includes(model)) ||
        channels.find((item) => item.id === channelId);
    const value = `${channel?.baseUrl || ""} ${channel?.name || ""}`.toLowerCase();
    return value.includes("apimart.ai") || value.includes("apimart");
}

function normalizeAestheticMirrorImageSize(config: AiConfig, model: string, channelId: string, imageSize: ImageSize): ImageSize {
    if (!isAestheticMirrorGptImage2Model(model) || !isAestheticMirrorApimartChannel(config, channelId, model)) return imageSize;
    if (imageSize === "2K" || imageSize === "auto") return "1K";
    return imageSize;
}

export default function AestheticMirrorPage() {
    const { message, modal } = App.useApp();
    const router = useRouter();
    const referenceInputRef = useRef<HTMLInputElement>(null);
    const productInputRef = useRef<HTMLInputElement>(null);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const token = useUserStore((state) => state.token);
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const createCanvasProject = useCanvasStore((state) => state.createProject);
    const updateCanvasProject = useCanvasStore((state) => state.updateProject);
    const [mirrorMode, setMirrorMode] = useState<MirrorMode>("single");
    const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
    const [productImages, setProductImages] = useState<ReferenceImage[]>([]);
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
    const promptTemplate = basePrompt;

    const isGenerating = results.some((item) => item.status === "running");
    const finalPrompt = useMemo(() => buildFinalPrompt(promptTemplate, extraPrompt), [promptTemplate, extraPrompt]);
    const parsedReferenceRules = useMemo(() => parseReferenceRules(extraPrompt), [extraPrompt]);
    const batchPromptTemplate = useMemo(() => buildBatchPromptTemplate(promptTemplate), [promptTemplate]);
    const batchFinalPrompt = useMemo(() => buildFinalPrompt(batchPromptTemplate, parsedReferenceRules.globalExtraPrompt), [batchPromptTemplate, parsedReferenceRules.globalExtraPrompt]);
    const modelChannelName = useMemo(() => resolveModelChannelName(effectiveConfig, modelChannelId, model), [effectiveConfig, model, modelChannelId]);
    const isBatchMode = mirrorMode === "batch";
    const referenceLimit = isBatchMode ? batchModeReferenceLimit : singleModeReferenceLimit;
    const effectiveResultCount = isBatchMode ? Math.max(1, referenceImages.length) * imageCount : imageCount;
    const canGenerate = referenceImages.length > 0 && productImages.length > 0 && !isGenerating;
    const successCount = results.filter((item) => item.status === "success").length;

    useEffect(() => {
        setModel(effectiveConfig.imageModel || effectiveConfig.model);
        setModelChannelId(effectiveConfig.imageChannelId || effectiveConfig.activeChannelId);
    }, [effectiveConfig.activeChannelId, effectiveConfig.imageChannelId, effectiveConfig.imageModel, effectiveConfig.model]);

    useEffect(() => {
        void refreshHistoryLogs();
    }, []);

    const changeMirrorMode = (nextMode: MirrorMode) => {
        if (nextMode === mirrorMode) return;
        if (nextMode === "single" && referenceImages.length > 1) {
            setReferenceImages((items) => items.slice(0, singleModeReferenceLimit));
            message.info("已切到单图复刻，仅保留第一张参考图");
        }
        setMirrorMode(nextMode);
    };

    const uploadFiles = async (sourceFiles: File[], role: UploadRole) => {
        const files = sourceFiles.filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        const maxImages = role === "reference" ? referenceLimit : maxProductImages;
        const currentCount = role === "reference" ? referenceImages.length : productImages.length;
        const limitedFiles = role === "reference" && !isBatchMode ? files.slice(0, maxImages) : files.slice(0, Math.max(0, maxImages - currentCount));
        if (!limitedFiles.length) {
            message.warning(role === "reference" ? `参考设计图最多上传 ${maxImages} 张` : `产品素材最多上传 ${maxProductImages} 张`);
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
                setReferenceImages((items) => (isBatchMode ? [...items, ...nextImages].slice(0, referenceLimit) : nextImages.slice(0, referenceLimit)));
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

    const updateResult = (id: string, patch: Partial<MirrorResult>) => {
        setResults((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const prepareBatchJobImage = async (image: ReferenceImage): Promise<AestheticMirrorJobImagePayload> => ({
        name: image.name || "image.png",
        type: image.type || "image/png",
        storageKey: image.storageKey?.startsWith("server:") ? image.storageKey : undefined,
        dataUrl: image.storageKey?.startsWith("server:") ? undefined : await imageToDataUrl(image),
    });

    const waitForBatchJob = async (jobId: string) => {
        const startedAt = Date.now();
        for (;;) {
            const job = await fetchAestheticMirrorJob(jobId, token);
            if (job.status === "success" || job.status === "failed") return job;
            if (Date.now() - startedAt > 15 * 60 * 1000) throw new Error("批量复刻任务等待超时");
            await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
    };

    const createAndWaitForBatchJobWithRetry = async (payload: Parameters<typeof createAestheticMirrorJob>[0], slotId: string) => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                if (attempt > 0) {
                    updateResult(slotId, { status: "running", error: `AI 上游繁忙，正在第 ${attempt + 1} 次尝试` });
                }
                const created = await createAestheticMirrorJob(payload, token);
                updateResult(slotId, { jobId: created.id, status: created.status === "failed" ? "failed" : "running", error: created.error });
                const completed = await waitForBatchJob(created.id);
                if (completed.status !== "success" || !completed.imageDataUrl) throw new Error(completed.error || "接口没有返回这张图片");
                return completed;
            } catch (error) {
                if (attempt >= aestheticMirrorBatchTransientRetryCount || !isTransientAestheticMirrorJobError(error)) throw error;
                await sleep(aestheticMirrorBatchTransientRetryBaseDelayMs * (attempt + 1));
            }
        }
    };

    const runRemoteBatchGenerate = async (batchPlans: Array<{ slot: MirrorResult; reference: ReferenceImage; referenceIndex: number; groupIndex: number }>, requestConfig: AiConfig, requestModel: string, requestChannelId: string) => {
        const [preparedReferences, preparedProducts] = await Promise.all([Promise.all(referenceImages.map((image) => prepareBatchJobImage(image))), Promise.all(productImages.map((image) => prepareBatchJobImage(image)))]);
        const items: Array<
            | {
                  status: "success";
                  image: { id: string; dataUrl: string; referenceIndex: number; referenceName: string; groupIndex: number };
              }
            | { status: "failed"; error: string }
        > = [];
        for (const [index, plan] of batchPlans.entries()) {
            try {
                updateResult(plan.slot.id, { status: "running", error: undefined });
                const completed = await createAndWaitForBatchJobWithRetry(
                    {
                        prompt: plan.slot.prompt,
                        promptTemplate,
                        extraPrompt,
                        model: requestModel,
                        channelId: requestChannelId,
                        size: requestConfig.size,
                        quality: quality,
                        outputFormat: "png",
                        referenceImage: preparedReferences[plan.referenceIndex],
                        productImages: preparedProducts,
                        metadata: { referenceIndex: plan.referenceIndex, groupIndex: plan.groupIndex },
                    },
                    plan.slot.id,
                );
                const imageDataUrl = completed.imageDataUrl;
                if (!imageDataUrl) throw new Error("接口没有返回这张图片");
                const meta = await readImageMeta(imageDataUrl);
                updateResult(plan.slot.id, { status: "success", dataUrl: imageDataUrl, width: meta.width, height: meta.height, error: undefined });
                items.push({
                    status: "success",
                    image: {
                        id: plan.slot.id,
                        dataUrl: imageDataUrl,
                        referenceIndex: plan.referenceIndex,
                        referenceName: plan.reference.name,
                        groupIndex: plan.groupIndex,
                    },
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "生成失败";
                updateResult(plan.slot.id, { status: "failed", error: errorMessage });
                items.push({ status: "failed", error: errorMessage });
            }
            if (index < batchPlans.length - 1) {
                await sleep(aestheticMirrorBatchRequestGapMs);
            }
        }
        return items;
    };

    const runDirectBatchGenerate = async (batchPlans: Array<{ slot: MirrorResult; reference: ReferenceImage; referenceIndex: number; groupIndex: number }>, requestConfig: AiConfig) =>
        (async () => {
            const items: Array<
                | {
                      status: "success";
                      image: { id: string; dataUrl: string; referenceIndex: number; referenceName: string; groupIndex: number };
                  }
                | { status: "failed"; error: string }
            > = [];
            for (const [index, plan] of batchPlans.entries()) {
                try {
                    updateResult(plan.slot.id, { status: "running", error: undefined });
                    const images = await requestEdit(requestConfig, plan.slot.prompt, [plan.reference, ...productImages]);
                    const image = images[0];
                    if (!image?.dataUrl) throw new Error("接口没有返回这张图片");
                    const meta = await readImageMeta(image.dataUrl);
                    updateResult(plan.slot.id, { status: "success", dataUrl: image.dataUrl, width: meta.width, height: meta.height, error: undefined });
                    items.push({
                        status: "success",
                        image: {
                            id: plan.slot.id,
                            dataUrl: image.dataUrl,
                            referenceIndex: plan.referenceIndex,
                            referenceName: plan.reference.name,
                            groupIndex: plan.groupIndex,
                        },
                    });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : "生成失败";
                    updateResult(plan.slot.id, { status: "failed", error: errorMessage });
                    items.push({ status: "failed", error: errorMessage });
                }
                if (index < batchPlans.length - 1) {
                    await sleep(aestheticMirrorBatchRequestGapMs);
                }
            }
            return items;
        })();

    const submitGenerate = async (override?: { count?: number; replaceId?: string }) => {
        const selectedReferences = (isBatchMode ? referenceImages : referenceImages.slice(0, 1)).slice(0, referenceLimit);
        if (!selectedReferences.length) {
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
        const effectiveImageSize = normalizeAestheticMirrorImageSize(requestBaseConfig, requestModel, requestChannelId, imageSize);

        const isBatchRun = isBatchMode && !override?.replaceId;
        const batchPlans = isBatchRun
            ? selectedReferences.flatMap((reference, referenceIndex) =>
                  Array.from({ length: imageCount }, (_, groupIndex) => ({
                      slot: {
                          id: nanoid(),
                          status: "running" as const,
                          prompt: buildBatchTaskPrompt(batchFinalPrompt, referenceIndex, groupIndex, reference.name, parsedReferenceRules.rules[referenceIndex]),
                          referenceId: reference.id,
                          referenceName: reference.name,
                          referenceIndex,
                          groupIndex,
                      },
                      reference,
                      referenceIndex,
                      groupIndex,
                  })),
              )
            : [];
        const count = isBatchRun ? batchPlans.length : override?.count || imageCount;
        const startedAt = performance.now();
        const historySnapshot = {
            prompt: finalPrompt,
            promptTemplate,
            extraPrompt,
            model: requestModel,
            modelChannelId: requestChannelId,
            modelChannelName,
            aspectRatio,
            imageSize: effectiveImageSize,
            quality,
            count,
            groupCount: isBatchRun ? imageCount : 1,
            references: [...selectedReferences],
            products: [...productImages],
        };
        const slots = isBatchRun ? batchPlans.map((plan) => ({ ...plan.slot, status: "idle" as const })) : Array.from({ length: count }, () => ({ id: nanoid(), status: "running" as const, prompt: finalPrompt }));
        if (override?.replaceId) {
            setResults((items) => items.map((item) => (item.id === override.replaceId ? slots[0] : item)));
        } else {
            setResults(slots);
        }

        const pendingLog = await saveHistoryFromSnapshot({ ...historySnapshot, status: "生成中", images: [], errors: [], durationMs: 0 });
        const historyLogMeta = pendingLog ? { id: pendingLog.id, createdAt: pendingLog.createdAt } : {};

        try {
            const requestConfig = buildRequestConfig(requestBaseConfig, requestModel, requestChannelId, aspectRatio, effectiveImageSize, quality, isBatchRun ? 1 : count);
            if (isBatchRun) {
                const batchItems = requestBaseConfig.channelMode === "remote" && Boolean(token) ? await runRemoteBatchGenerate(batchPlans, requestConfig, requestModel, requestChannelId) : await runDirectBatchGenerate(batchPlans, requestConfig);
                const images = batchItems
                    .filter(
                        (
                            item,
                        ): item is {
                            status: "success";
                            image: { id: string; dataUrl: string; referenceIndex: number; referenceName: string; groupIndex: number };
                        } => item.status === "success",
                    )
                    .map((item) => item.image);
                const errors = batchItems.filter((item): item is { status: "failed"; error: string } => item.status === "failed").map((item) => item.error);
                if (images.length > 0) message.success(`已生成 ${images.length}/${count} 张详情图`);
                if (!images.length) message.error(errors[0] || "生成失败");
                else if (errors.length) message.warning(`有 ${errors.length} 张生成失败`);
                void saveHistoryFromSnapshot({ ...historySnapshot, ...historyLogMeta, status: images.length ? "成功" : "失败", images, errors, durationMs: performance.now() - startedAt });
                return;
            }
            const images = await Promise.all((await requestEdit(requestConfig, finalPrompt, [...selectedReferences.slice(0, 1), ...productImages])).map((image) => enrichMirrorResultImage(image)));
            setResults((items) => {
                const targetIds = override?.replaceId ? [slots[0].id] : slots.map((slot) => slot.id);
                let imageIndex = 0;
                return items.map((item) => {
                    if (!targetIds.includes(item.id)) return item;
                    const image = images[imageIndex++];
                    if (image?.dataUrl) return { ...item, status: "success", dataUrl: image.dataUrl, width: image.width, height: image.height };
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
            const node = await buildCanvasImageNodeFromResult(result, index, aspectRatio, imageSize);
            const projectId = createCanvasProject(`爆款复刻 · ${resultDisplayTitle(result, index)}`);
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
        const nextMode: MirrorMode = log.references.length > 1 ? "batch" : "single";
        const nextReferenceLimit = nextMode === "batch" ? batchModeReferenceLimit : singleModeReferenceLimit;
        setMirrorMode(nextMode);
        setReferenceImages(log.references.slice(0, nextReferenceLimit));
        setProductImages(log.products.slice(0, maxProductImages));
        setExtraPrompt(log.extraPrompt || "");
        setModel(log.model || effectiveConfig.imageModel || effectiveConfig.model);
        setModelChannelId(log.modelChannelId || "");
        if (log.model) updateConfig("imageModel", log.model);
        if (log.modelChannelId) updateConfig("imageChannelId", log.modelChannelId);
        setAspectRatio(log.aspectRatio || "1:1");
        setImageSize(log.imageSize || "1K");
        setQuality(log.quality || "auto");
        setImageCount(nextMode === "batch" ? resolveHistoryGroupCount(log) : Math.max(1, Math.min(4, log.count || log.images.length || 1)));
        setResults(
            log.images.length
                ? log.images.map((image) => {
                      const reference = image.referenceIndex !== undefined ? log.references[image.referenceIndex] : undefined;
                      return {
                          id: image.id,
                          status: "success",
                          prompt: log.prompt,
                          dataUrl: image.dataUrl,
                          width: image.width,
                          height: image.height,
                          referenceId: reference?.id,
                          referenceName: image.referenceName || reference?.name,
                          referenceIndex: image.referenceIndex,
                          groupIndex: image.groupIndex,
                      };
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
            <input ref={referenceInputRef} hidden type="file" accept="image/*" multiple={isBatchMode} onChange={(event) => void handleUpload(event, "reference")} />
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
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => changeMirrorMode("single")}
                                        className={cn(
                                            "rounded-md border px-3 py-1.5 text-sm font-medium transition",
                                            !isBatchMode
                                                ? "border-stone-900 bg-stone-950 text-white dark:border-cyan-500/40 dark:bg-cyan-500/18 dark:text-cyan-100"
                                                : "border-stone-300 bg-white text-stone-700 hover:border-stone-400 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300 dark:hover:border-stone-500 dark:hover:text-stone-100",
                                        )}
                                    >
                                        单图复刻
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => changeMirrorMode("batch")}
                                        className={cn(
                                            "rounded-md border px-3 py-1.5 text-sm font-medium transition",
                                            isBatchMode
                                                ? "border-stone-900 bg-stone-950 text-white dark:border-cyan-500/40 dark:bg-cyan-500/18 dark:text-cyan-100"
                                                : "border-stone-300 bg-white text-stone-700 hover:border-stone-400 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300 dark:hover:border-stone-500 dark:hover:text-stone-100",
                                        )}
                                    >
                                        批量复刻
                                    </button>
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
                            subtitle={`${referenceImages.length}/${referenceLimit}`}
                            images={referenceImages}
                            emptyText={isBatchMode ? "上传多张风格参考" : "上传风格参考"}
                            maxImages={referenceLimit}
                            singlePreview={!isBatchMode}
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
                                <ControlField label={isBatchMode ? "每张参考图生成" : "数量"}>
                                    <Select value={imageCount} options={[1, 2, 3, 4].map((value) => ({ label: isBatchMode ? `${value} 组` : `${value} 张`, value }))} onChange={setImageCount} />
                                    {isBatchMode ? (
                                        <div className="mt-1 text-xs text-stone-500">
                                            {referenceImages.length} 张参考图 × {imageCount} 组 = {effectiveResultCount} 张
                                        </div>
                                    ) : null}
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
                        <div
                            key={image.id}
                            className="group relative overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-black"
                            style={image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : { aspectRatio: "1 / 1" }}
                        >
                            <button type="button" className="block w-full cursor-zoom-in" onClick={() => onPreview?.(image)} aria-label="预览图片">
                                <img src={image.dataUrl} alt={image.name} className="h-full w-full object-contain" />
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
    const title = resultDisplayTitle(result, index);
    const ratioStyle = result.width && result.height ? { aspectRatio: `${result.width} / ${result.height}` } : undefined;
    return (
        <article className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-[#11100f] dark:shadow-none">
            <div className={cn("group relative grid place-items-center bg-stone-100 dark:bg-black", !ratioStyle && ratioClass)} style={ratioStyle}>
                {result.status === "running" ? (
                    <div className="flex flex-col items-center gap-3 text-stone-500">
                        <LoaderCircle className="size-8 animate-spin text-stone-900 dark:text-stone-200" />
                        <span className="text-sm">分析风格并生成中</span>
                    </div>
                ) : result.status === "idle" ? (
                    <div className="flex flex-col items-center gap-3 text-stone-500">
                        <div className="grid size-8 place-items-center rounded-full border border-dashed border-stone-400 dark:border-stone-600" />
                        <span className="text-sm">等待生成</span>
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
    groupCount: number;
    durationMs: number;
    status: MirrorHistoryLog["status"];
    references: ReferenceImage[];
    products: ReferenceImage[];
    images: Array<{ id: string; dataUrl: string; referenceIndex?: number; referenceName?: string; groupIndex?: number }>;
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
        groupCount: input.groupCount,
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
        promptTemplate: basePrompt,
        extraPrompt: log.extraPrompt || "",
        model: log.model || "",
        modelChannelId: log.modelChannelId || "",
        modelChannelName: log.modelChannelName || "",
        aspectRatio,
        imageSize,
        quality: log.quality || "auto",
        count: Math.max(1, Math.min(batchModeReferenceLimit * 4, Number(log.count) || log.images?.length || 1)),
        groupCount: Math.max(1, Math.min(4, Number(log.groupCount) || 1)),
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

async function cloneHistoryImages(images: Array<{ id: string; dataUrl: string; referenceIndex?: number; referenceName?: string; groupIndex?: number }>) {
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
                referenceIndex: image.referenceIndex,
                referenceName: image.referenceName,
                groupIndex: image.groupIndex,
            };
        }),
    );
}

async function enrichMirrorResultImage<T extends { dataUrl: string }>(image: T): Promise<T & { width: number; height: number }> {
    const meta = await readImageMeta(image.dataUrl);
    return { ...image, width: meta.width, height: meta.height };
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
            referenceIndex: image.referenceIndex,
            referenceName: image.referenceName,
            groupIndex: image.groupIndex,
        }));
}

function resolveHistoryGroupCount(log: MirrorHistoryLog) {
    if (log.groupCount > 0) return Math.max(1, Math.min(4, log.groupCount));
    if (log.references.length > 1 && log.count > log.references.length) {
        return Math.max(1, Math.min(4, Math.ceil(log.count / log.references.length)));
    }
    return Math.max(1, Math.min(4, log.count || log.images.length || 1));
}

function historyTitle(prompt: string) {
    const compact = prompt.replace(/\s+/g, " ").trim();
    return compact.slice(0, 18) || "爆款复刻";
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isTransientAestheticMirrorJobError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /(Please wait|try again later|rate limit|temporar|timeout|ECONNRESET|ETIMEDOUT|上游错误|限流|繁忙|超时|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b)/i.test(message);
}

function buildFinalPrompt(promptTemplate: string, extraPrompt: string) {
    return [(promptTemplate || basePrompt).trim(), extraPrompt.trim()].filter(Boolean).join("\n\n");
}

function buildBatchPromptTemplate(promptTemplate: string) {
    const template = (promptTemplate || basePrompt).trim();
    const batchAwareProductRule =
        "产品素材图里的产品需要严格保持真实外观、瓶型轮廓、颜色、透明液体质感、瓶盖、标签结构、品牌标识和可见细节，不要重绘成新产品，不要替换包装，不要伪造新品牌或新标签。是否让产品作为主视觉，优先由当前参考图的版式类型和任务要求决定：如果当前参考图是产品主视觉、卖点海报或主图，产品应作为主要主体；如果当前参考图是医生背书、症状拼图、成分机理、数据证明、对比说明等信息型版式，可以不出现产品，或仅保留极小的辅助产品元素，不要强行改成统一的居中单瓶海报。";
    const strictProductRule = "产品素材图里的产品必须作为唯一产品主体，严格保持产品的瓶型轮廓、颜色、透明液体质感、瓶盖、标签结构、品牌标识和可见细节，不要重绘成新产品，不要替换包装，不要伪造新品牌或新标签。";
    if (template.includes(strictProductRule)) {
        return template.replace(strictProductRule, batchAwareProductRule);
    }
    return `${template}\n\n${batchAwareProductRule}`;
}

function parseReferenceRules(extraPrompt: string): ParsedReferenceRules {
    const rules: Record<number, ReferenceRule> = {};
    const globalSegments: string[] = [];
    const segments = extraPrompt
        .split(/[\n；;。]+/)
        .map((segment) => segment.trim())
        .filter(Boolean);

    for (const segment of segments) {
        const referenceIndexes = extractReferenceIndexes(segment);
        if (!referenceIndexes.length) {
            globalSegments.push(segment);
            continue;
        }

        let matched = false;
        const hasForbiddenProductRule = /(不需要出现产品|不要出现产品|无需出现产品|不需要产品|不要产品|无产品|不出产品|不放产品|产品不用出现)/.test(segment);
        const hasRequiredProductRule = /(需要出现产品|必须出现产品|要出现产品|必须有产品|需要产品|要有产品|必须放产品|产品必须出现)/.test(segment);
        if (hasForbiddenProductRule) {
            referenceIndexes.forEach((referenceIndex) => mergeReferenceRule(rules, referenceIndex, { productPresence: "forbidden" }));
            matched = true;
        } else if (hasRequiredProductRule) {
            referenceIndexes.forEach((referenceIndex) => mergeReferenceRule(rules, referenceIndex, { productPresence: "required" }));
            matched = true;
        }

        const layoutType = inferReferenceLayoutType(segment);
        if (layoutType) {
            referenceIndexes.forEach((referenceIndex) =>
                mergeReferenceRule(rules, referenceIndex, {
                    layoutType,
                    productPresence: rules[referenceIndex]?.productPresence || (layoutType === "product_hero" ? "required" : "optional"),
                }),
            );
            matched = true;
        }

        if (!matched) {
            globalSegments.push(segment);
            continue;
        }

        const residual = cleanReferenceRuleSegment(segment);
        if (residual) globalSegments.push(residual);
    }

    return {
        globalExtraPrompt: globalSegments.join("\n").trim(),
        rules,
    };
}

function extractReferenceIndexes(segment: string) {
    const match = segment.match(/(?:图|第)\s*([0-9][0-9/、,，及和\s]*)\s*(?:张|图)?/);
    if (!match?.[1]) return [];
    const indexes = match[1]
        .replace(/[及和]/g, "/")
        .split(/[\/、,，\s]+/)
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
        .map((value) => value - 1);
    return Array.from(new Set(indexes));
}

function mergeReferenceRule(rules: Record<number, ReferenceRule>, referenceIndex: number, patch: ReferenceRule) {
    rules[referenceIndex] = { ...rules[referenceIndex], ...patch };
}

function inferReferenceLayoutType(segment: string): ReferenceLayoutType | undefined {
    if (/(医生背书|医生图|专家背书|专家图|医师背书|临床背书|权威背书|医师图|专家肖像|医生肖像)/.test(segment)) return "doctor_endorsement";
    if (/(症状拼图|症状图|问题拼图|场景拼图|多宫格|九宫格|拼图|痛点图|问题图)/.test(segment)) return "symptom_grid";
    if (/(机理图|原理图|成分机理图|成分图|配方图|机制图|作用路径|分子图)/.test(segment)) return "mechanism";
    if (/(数据证明图|数据图|检测图|证书图|证明图|认证图|实验图|报告图|检测证明|临床数据)/.test(segment)) return "data_proof";
    if (/(对比图|前后对比|前后对照|对照图|对比说明)/.test(segment)) return "comparison";
    if (/(主图|主视觉|单品海报|卖点海报|单瓶海报|产品海报|产品主视觉)/.test(segment)) return "product_hero";
    return undefined;
}

function cleanReferenceRuleSegment(segment: string) {
    return segment
        .replace(/(?:图|第)\s*[0-9][0-9/、,，及和\s]*(?:张|图)?/g, " ")
        .replace(/(?:都)?(?:不需要出现产品|不要出现产品|无需出现产品|不需要产品|不要产品|无产品|不出产品|不放产品|产品不用出现)/g, " ")
        .replace(/(?:都)?(?:需要出现产品|必须出现产品|要出现产品|必须有产品|需要产品|要有产品|必须放产品|产品必须出现)/g, " ")
        .replace(
            /(?:做|走|改成|做成|出成)?(?:医生背书|医生图|专家背书|专家图|医师背书|临床背书|权威背书|医师图|专家肖像|医生肖像|症状拼图|症状图|问题拼图|场景拼图|多宫格|九宫格|拼图|痛点图|问题图|机理图|原理图|成分机理图|成分图|配方图|机制图|作用路径|分子图|数据证明图|数据图|检测图|证书图|证明图|认证图|实验图|报告图|检测证明|临床数据|对比图|前后对比|前后对照|对照图|对比说明|主图|主视觉|单品海报|卖点海报|单瓶海报|产品海报|产品主视觉)/g,
            " ",
        )
        .replace(/^[，,、/\s]+|[，,、/\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function buildBatchTaskPrompt(basePromptText: string, referenceIndex: number, groupIndex: number, referenceName?: string, rule?: ReferenceRule) {
    const resolvedLayoutType = rule?.layoutType;
    const resolvedProductPresence = rule?.productPresence || (resolvedLayoutType === "product_hero" ? "required" : resolvedLayoutType ? "optional" : undefined);
    const label = `当前任务只对应参考图 ${referenceIndex + 1}${referenceName ? `（${referenceName}）` : ""}，当前生成第 ${groupIndex + 1} 组。只学习这一张参考图的版式、信息层级、背景氛围、构图和卖点组织，不要融合其他参考图。`;
    const genericLayoutRule = "优先复刻当前参考图自身的版式类型。如果它是产品主视觉，就突出产品；如果它是医生背书、症状拼图、成分机理、数据证明或对比说明这类信息型版式，就优先保留信息结构，不要为了塞入产品而统一改成居中单瓶海报。";
    const productPresenceRule =
        resolvedProductPresence === "forbidden"
            ? "本任务明确要求不需要出现产品。允许完全不放产品，不要在画面中央放单瓶，不要为了塞入产品打乱原有的信息分区和版式结构。"
            : resolvedProductPresence === "required"
              ? "本任务明确要求必须出现产品，产品应作为主视觉或主要信息锚点，且必须保持真实外观、包装、标签和品牌细节。"
              : resolvedProductPresence === "optional"
                ? "本任务可以不出现产品，也可以只保留极小的辅助产品元素。是否出现产品，以当前参考图的信息结构和表达目标优先。"
                : "";
    const layoutRule =
        resolvedLayoutType === "doctor_endorsement"
            ? "版式重点放在医生或专家背书、权威感、可信度和医疗信息层级，可以以人物、证书、背书文案和信任元素为主。"
            : resolvedLayoutType === "symptom_grid"
              ? "版式重点做成症状拼图或问题说明图，允许多宫格、多分区、症状示意、痛点说明和信息清单，信息密度可以更高。"
              : resolvedLayoutType === "mechanism"
                ? "版式重点做成成分机理或作用原理说明图，突出结构化说明、图标、路径、机制解释和科普信息。"
                : resolvedLayoutType === "data_proof"
                  ? "版式重点做成数据证明或检测认证图，突出图表、数据、证书、实验结果、检测说明和可信证据表达。"
                  : resolvedLayoutType === "comparison"
                    ? "版式重点做成前后对比或对照说明图，强调差异对比、结果对照、分栏信息和可读性。"
                    : resolvedLayoutType === "product_hero"
                      ? "版式重点做成产品主视觉海报，突出产品主体、核心卖点、品牌识别和电商投流主图感。"
                      : "";
    return [basePromptText.trim(), label, genericLayoutRule, productPresenceRule, layoutRule].filter(Boolean).join("\n\n");
}

function buildRequestConfig(config: AiConfig, model: string, channelId: string, aspectRatio: AspectRatio, imageSize: ImageSize, quality: string, count: number): AiConfig {
    const normalizedImageSize = normalizeAestheticMirrorImageSize(config, model, channelId, imageSize);
    return {
        ...config,
        model,
        imageModel: model,
        imageChannelId: channelId,
        activeChannelId: channelId,
        size: resolveAestheticMirrorRequestSize(config, model, channelId, aspectRatio, normalizedImageSize),
        quality,
        count: String(count),
        outputFormat: "png",
        responseFormatB64Json: true,
    };
}

function resolveAestheticMirrorRequestSize(config: AiConfig, model: string, channelId: string, aspectRatio: AspectRatio, imageSize: ImageSize) {
    if (imageSize === "auto") return aspectRatio;
    if (isAestheticMirrorGptImage2Model(model)) {
        if (isAestheticMirrorApimartChannel(config, channelId, model)) {
            return sizeMap[imageSize][aspectRatio] || aspectRatio;
        }
        return gptImage2StableSizeMap[imageSize][aspectRatio];
    }
    return sizeMap[imageSize][aspectRatio] || aspectRatio;
}

function resultDisplayTitle(result: MirrorResult | MirrorHistoryImage, index: number) {
    const referenceLabel = result.referenceIndex !== undefined ? `参考 ${result.referenceIndex + 1}` : "";
    const groupLabel = result.groupIndex !== undefined ? `第 ${result.groupIndex + 1} 组` : "";
    const labels = [referenceLabel, groupLabel].filter(Boolean);
    return labels.length ? labels.join(" · ") : `详情图方案 ${index + 1}`;
}

function resolveModelChannelName(config: AiConfig, channelId: string, model: string) {
    const channels =
        config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({ id: channel.id, name: channel.name || "云端渠道", models: channel.models }))
            : config.localChannels.map((channel) => ({ id: channel.id, name: channel.name || "本地渠道", models: channel.models }));
    return channels.find((channel) => channel.id === channelId && channel.models.includes(model))?.name || channels.find((channel) => channel.models.includes(model))?.name || "";
}

async function buildCanvasImageNodeFromResult(result: MirrorResult, index: number, aspectRatio: AspectRatio, imageSize: ImageSize): Promise<CanvasNodeData> {
    const image = await estimateCanvasImageMeta(result.dataUrl || "", aspectRatio, imageSize, result.width, result.height);
    const size = fitNodeSize(image.width, image.height);
    const title = resultDisplayTitle(result, index);
    return {
        id: `image-${Date.now()}-${nanoid().slice(0, 5)}`,
        type: CanvasNodeType.Image,
        title,
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

async function estimateCanvasImageMeta(url: string, aspectRatio: AspectRatio, imageSize: ImageSize, width?: number, height?: number) {
    const explicitSize = sizeMap[imageSize][aspectRatio];
    let dimensions = width && height ? { width, height } : parseCanvasImageDimensions(explicitSize || aspectRatio);
    if ((!width || !height) && url.startsWith("data:")) {
        const meta = await readImageMeta(url);
        if (meta.width > 0 && meta.height > 0) {
            dimensions = { width: meta.width, height: meta.height };
        }
    }
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
