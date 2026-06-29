"use client";

import {
    AlertCircle,
    BookOpen,
    CheckSquare,
    ChevronLeft,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    Copy,
    Download,
    Folder,
    FileArchive,
    FolderPlus,
    History,
    ImagePlus,
    Link2,
    LoaderCircle,
    PanelBottom,
    PanelLeft,
    PenLine,
    Plus,
    RotateCcw,
    SlidersHorizontal,
    Sparkles,
    Trash2,
    Upload,
    WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Mentions, Modal, Tag, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { cn } from "@/lib/utils";
import { createZip } from "@/lib/zip";

import { ImageSettingsPanel, imageAspectValue, imageFormatLabel, imageResolutionLabel, imageResolutionValue, imageSizeLabel, resolveImageSizeForResolution } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { promptLibraryEnabled } from "@/constant/feature-flags";
import { CreativeWorkflowWorkspace, type WorkflowExternalTaskFailure, type WorkflowRunnerRequest, type WorkflowExternalTaskStart, type WorkflowExternalTaskSuccess } from "@/components/workflows/creative-workflow-workspace";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { ImageRequestError, requestEdit, requestGeneration } from "@/services/api/image";
import { currentImageHistoryScope, isHistoryLogKeyInScope, scopedImageHistoryCategoryKey, scopedImageHistoryLogKey } from "@/services/image-history-storage";
import { fetchUserConfig, syncUserImageHistory } from "@/services/api/user-config";
import { collectImageStorageKeys, deleteStoredImages, imageToDataUrl, resolveImageUrl, setImageBlob, uploadImage } from "@/services/image-storage";
import { ensureImageShareLink, type ImageShareLinkResult } from "@/services/image-share-link";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { useCopyText } from "@/hooks/use-copy-text";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    shareId?: string;
    shareUrl?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "waiting" | "running" | "success" | "failed";
    createdAt: number;
    startedAt?: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    image?: GeneratedImage;
    logId?: string;
    error?: string;
    errorDetail?: string;
    durationMs?: number;
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
    workflowTaskId?: string;
    versionGroupId?: string;
    versionNo?: number;
    retryOfLogId?: string;
    retryOfVersionNo?: number;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: GeneratedImage[];
    thumbnails: string[];
    errors: string[];
    errorDetails?: string[];
    categoryIds: string[];
    workflowId?: string;
    workflowName?: string;
    workflowInputs?: Record<string, unknown>;
    workflowSeriesRunId?: string;
    versionGroupId?: string;
    versionNo?: number;
    retryOfLogId?: string;
    retryOfVersionNo?: number;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count" | "apiMode" | "outputFormat" | "outputCompression" | "moderation" | "timeout" | "streamImages" | "streamPartialImages" | "responseFormatB64Json" | "codexCli">;
type RequestSnapshot = { text: string; requestText: string; requestConfig: AiConfig; displayConfig: GenerationLogConfig; references: ReferenceImage[] };
type GenerationCategory = { id: string; name: string; createdAt: number };
type ResultViewMode = "all" | "category";
type ProductPackageGroup = "main" | "sub" | "detail" | "sku" | "other";
type ProductPackageItemStatus = "waiting" | "running" | "success" | "failed";

type ProductPackageItem = {
    id: string;
    logId?: string;
    taskId?: string;
    selected?: boolean;
    group: ProductPackageGroup;
    index: number;
    groupIndex: number;
    title: string;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    status: ProductPackageItemStatus;
    image?: GeneratedImage;
    error?: string;
    errorDetail?: string;
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    sourceFolderName?: string;
    sourceFileName?: string;
};

type ParsedFolderPackageItem = {
    file: File;
    group: ProductPackageGroup;
    folderName: string;
    fileName: string;
};

type ParsedFolderPackage = {
    rootName: string;
    transparentFile: File;
    items: ParsedFolderPackageItem[];
    skippedCount: number;
};

type ProductImagePackage = {
    id: string;
    workflowId: string;
    workflowName: string;
    packageName: string;
    productName: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    config: GenerationLogConfig;
    createdAt: number;
    updatedAt: number;
    totalCount: number;
    items: ProductPackageItem[];
};

type SubmitGenerationOptions = {
    replaceLog?: GenerationLog | null;
    anchorLog?: GenerationLog | null;
    retrySourceLog?: GenerationLog | null;
    batchMode?: boolean;
    onAccepted?: () => void;
};

type GenerationTaskEntry = {
    id: string;
    snapshot: RequestSnapshot;
};

type PackageQuickStartDraft = {
    productName: string;
    productType: string;
    sellingPoints: string;
    specs: string;
    targetPeople: string;
    style: string;
    notes: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type WorkbenchLayout = "side" | "bottom";
type CollapsibleSectionKey = "prompt" | "references" | "settings";
type CollapsedSections = Record<CollapsibleSectionKey, boolean>;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";
const PACKAGE_STORE_KEY = "infinite-canvas:image_product_packages";
const WORKBENCH_LAYOUT_KEY = "infinite-canvas:image-workbench-layout";
const WORKBENCH_BOTTOM_COLLAPSED_KEY = "infinite-canvas:image-workbench-bottom-collapsed";
const RESULT_VIEW_MODE_KEY = "infinite-canvas:image-result-view-mode";
const WORKFLOW_BUTTON_POSITION_KEY = "infinite-canvas:workflow-button-position";
const BATCH_GENERATION_CONFIRM_THRESHOLD = 30;
const folderPackageWorkflowId = "folder-reference-package";
const packageGroupOrder: ProductPackageGroup[] = ["main", "sku", "detail", "sub", "other"];
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const categoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_categories" });
const packageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_product_packages" });
const defaultCollapsedSections: CollapsedSections = { prompt: false, references: true, settings: true };
const demoProductWorkflowId = "demo-product-package";
const defaultPackageQuickStartDraft: PackageQuickStartDraft = {
    productName: "",
    productType: "保健品",
    sellingPoints: "",
    specs: "",
    targetPeople: "",
    style: "高级感电商产品摄影，干净、可信、适合健康护理/保健品视觉",
    notes: "避免医疗承诺、治疗暗示、医生背书、夸大功效",
};

export default function ImagePage() {
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const folderInputRef = useRef<HTMLInputElement>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [productPackages, setProductPackages] = useState<ProductImagePackage[]>([]);
    const [activePackageId, setActivePackageId] = useState<string | null>(null);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [categories, setCategories] = useState<GenerationCategory[]>([]);
    const [resultViewMode, setResultViewModeState] = useState<ResultViewMode>("all");
    const [activeResultCategoryId, setActiveResultCategoryId] = useState<string | null>(null);
    const [batchMode, setBatchMode] = useState(false);
    const [workbenchLayout, setWorkbenchLayoutState] = useState<WorkbenchLayout>("side");
    const [workbenchBottomCollapsed, setWorkbenchBottomCollapsedState] = useState(false);
    const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>(defaultCollapsedSections);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [workflowDrawerOpen, setWorkflowDrawerOpen] = useState(false);
    const [packageQuickStartOpen, setPackageQuickStartOpen] = useState(false);
    const [workflowRunnerRequest, setWorkflowRunnerRequest] = useState<WorkflowRunnerRequest | null>(null);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
    const [selectedResultIds, setSelectedResultIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [linkingImageId, setLinkingImageId] = useState("");
    const [now, setNow] = useState(Date.now());
    const [workflowButtonPosition, setWorkflowButtonPosition] = useState({ x: 0, y: 0 });
    const [packageQuickStartDraft, setPackageQuickStartDraft] = useState<PackageQuickStartDraft>(defaultPackageQuickStartDraft);
    const [packageQuickStartReferences, setPackageQuickStartReferences] = useState<ReferenceImage[]>([]);
    const workflowButtonDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const packageTaskMapRef = useRef<Record<string, string>>({});
    const accountHistorySyncEnabledRef = useRef(false);
    const productPackagesLoadedRef = useRef(false);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const pendingCount = results.filter((item) => item.status === "running").length + productPackages.reduce((total, item) => total + item.items.filter((packageItem) => packageItem.status === "running").length, 0);
    const historyProductPackages = useMemo(() => buildHistoryProductPackages(logs), [logs]);
    const productPackageFolders = useMemo(() => mergeProductPackages(productPackages, historyProductPackages), [productPackages, historyProductPackages]);
    const activePackage = activePackageId ? productPackageFolders.find((item) => item.id === activePackageId) || null : null;

    useEffect(() => {
        void refreshLogs();
        void refreshCategories();
        void refreshProductPackages();
        try {
            const storedLayout = window.localStorage?.getItem(WORKBENCH_LAYOUT_KEY);
            if (storedLayout === "side" || storedLayout === "bottom") setWorkbenchLayoutState(storedLayout);
            setWorkbenchBottomCollapsedState(window.localStorage?.getItem(WORKBENCH_BOTTOM_COLLAPSED_KEY) === "true");
            const storedViewMode = window.localStorage?.getItem(RESULT_VIEW_MODE_KEY);
            if (storedViewMode === "all" || storedViewMode === "category") setResultViewModeState(storedViewMode);
            const storedButtonPosition = JSON.parse(window.localStorage?.getItem(WORKFLOW_BUTTON_POSITION_KEY) || "null") as { x?: number; y?: number } | null;
            if (typeof storedButtonPosition?.x === "number" && typeof storedButtonPosition?.y === "number") setWorkflowButtonPosition(clampWorkflowButtonPosition(storedButtonPosition));
            else setWorkflowButtonPosition(defaultWorkflowButtonPosition());
        } catch {
            // Local storage can be unavailable in restricted browser contexts.
            setWorkflowButtonPosition(defaultWorkflowButtonPosition());
        }
    }, []);

    useEffect(() => {
        if (!isUserReady || !token) return;
        void loadAccountImageHistory(token);
    }, [isUserReady, token]);

    useEffect(() => {
        if (!productPackagesLoadedRef.current) return;
        void replaceStoredProductPackages(productPackages);
    }, [productPackages]);

    useEffect(() => {
        if (!pendingCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [pendingCount]);

    useEffect(() => {
        const resultIds = new Set(results.map((item) => item.id));
        setSelectedResultIds((ids) => (ids.every((id) => resultIds.has(id)) ? ids : ids.filter((id) => resultIds.has(id))));
    }, [results]);

    useEffect(() => {
        folderInputRef.current?.setAttribute("webkitdirectory", "");
        folderInputRef.current?.setAttribute("directory", "");
    }, []);

    const setWorkbenchLayout = (layout: WorkbenchLayout) => {
        setWorkbenchLayoutState(layout);
        try {
            window.localStorage?.setItem(WORKBENCH_LAYOUT_KEY, layout);
        } catch {
            // Keep the in-memory layout even when persistence is unavailable.
        }
    };

    const setWorkbenchBottomCollapsed = (collapsed: boolean) => {
        setWorkbenchBottomCollapsedState(collapsed);
        try {
            window.localStorage?.setItem(WORKBENCH_BOTTOM_COLLAPSED_KEY, String(collapsed));
        } catch {
            // Keep the collapsed state in memory if persistence is blocked.
        }
    };

    const setResultViewMode = (mode: ResultViewMode) => {
        setResultViewModeState(mode);
        try {
            window.localStorage?.setItem(RESULT_VIEW_MODE_KEY, mode);
        } catch {
            // Keep current view in memory if persistence is blocked.
        }
    };

    const persistWorkflowButtonPosition = (position: { x: number; y: number }) => {
        const nextPosition = clampWorkflowButtonPosition(position);
        setWorkflowButtonPosition(nextPosition);
        try {
            window.localStorage?.setItem(WORKFLOW_BUTTON_POSITION_KEY, JSON.stringify(nextPosition));
        } catch {
            // Keep the drag position in memory when localStorage is unavailable.
        }
    };

    const handleWorkflowButtonPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = workflowButtonPosition.x || workflowButtonPosition.y ? workflowButtonPosition : defaultWorkflowButtonPosition();
        workflowButtonDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y, moved: false };
    };

    const handleWorkflowButtonPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = workflowButtonDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        setWorkflowButtonPosition(clampWorkflowButtonPosition({ x: drag.originX + dx, y: drag.originY + dy }));
    };

    const handleWorkflowButtonPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = workflowButtonDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        persistWorkflowButtonPosition({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
    };

    const toggleCollapsedSection = (section: CollapsibleSectionKey) => {
        setCollapsedSections((value) => ({ ...value, [section]: !value[section] }));
    };

    const addReferences = async (files?: FileList | File[] | null, options?: { successMessage?: string | false }) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        const hideLoading = message.loading("正在上传参考图...", 0);
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            if (options?.successMessage !== false) message.success(options?.successMessage || "参考图上传成功");
        } catch (error) {
            message.error(error instanceof Error ? `上传参考图失败：${error.message}` : "上传参考图失败");
        } finally {
            hideLoading();
        }
    };

    const pasteReferenceImagesIntoPrompt = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const imageFiles = extractClipboardImageFiles(event);
        if (!imageFiles.length) return;
        event.preventDefault();
        await addReferences(imageFiles, { successMessage: false });
        message.success(`已粘贴 ${imageFiles.length} 张参考图，可用 ${imageFiles.map((_, index) => `@${referenceAlias(references.length + index)}`).join(" ")}`);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            const hideLoading = message.loading("正在上传并读取参考图...", 0);
            try {
                const nextReferences = await Promise.all(
                    blobs.map(async (blob, index) => {
                        const image = await uploadImage(blob);
                        return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "clipboard" as const, temporary: true };
                    }),
                );
                setReferences((value) => [...value, ...nextReferences]);
                message.success(`已成功上传并读取 ${nextReferences.length} 张参考图`);
            } finally {
                hideLoading();
            }
        } catch {
            message.error("剪切板里没有可读取的图片");
        }
    };

    const confirmFolderPackageImport = (parsed: ParsedFolderPackage) => {
        const counts = folderPackageGroupCounts(parsed.items);
        return new Promise<boolean>((resolve) => {
            modal.confirm({
                title: "导入套图文件夹",
                width: 640,
                content: (
                    <div className="space-y-3 text-sm">
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
                            <div className="font-medium">透明图</div>
                            <div className="mt-1 text-stone-500 dark:text-stone-400">{parsed.transparentFile.name}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            {packageGroupOrder.map((group) =>
                                counts[group] ? (
                                    <div key={group} className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                                        <div className="font-medium">{packageGroupTitle(group)}</div>
                                        <div className="text-stone-500 dark:text-stone-400">{counts[group]} 张</div>
                                    </div>
                                ) : null,
                            )}
                        </div>
                        <div className="text-stone-500 dark:text-stone-400">
                            将创建「{parsed.rootName}-套图生成」，共 {parsed.items.length} 个任务，默认每张参考图生成 1 张，并一次性全部发起。
                            {parsed.skippedCount ? ` 已跳过 ${parsed.skippedCount} 个非图片或根目录外文件。` : ""}
                        </div>
                    </div>
                ),
                okText: "创建并生成",
                cancelText: "取消",
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
    };

    const importPackageFolder = async (files?: FileList | null) => {
        const promptText = prompt.trim();
        let parsed: ParsedFolderPackage;
        try {
            parsed = parseFolderPackageFiles(Array.from(files || []));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "文件夹读取失败");
            return;
        }

        const hideLoading = message.loading("正在上传套图参考...", 0);
        try {
            const modelName = effectiveConfig.imageModel || effectiveConfig.model || model || "gpt-image-2";
            const requestBaseConfig: AiConfig = { ...effectiveConfig, model: modelName, imageModel: modelName, activeChannelId: effectiveConfig.imageChannelId, count: "1" };
            const transparentReference = await uploadReferenceFile(parsed.transparentFile);
            const itemReferences = await Promise.all(parsed.items.map((item) => uploadReferenceFile(item.file, item.folderName)));
            const groupIndexByGroup = new Map<ProductPackageGroup, number>();
            const packageId = `folder:${nanoid()}`;
            const configSnapshot = buildGenerationLogConfig({ ...requestBaseConfig, count: String(parsed.items.length) });
            const items = await Promise.all(
                parsed.items.map(async (item, index) => {
                    const groupIndex = (groupIndexByGroup.get(item.group) || 0) + 1;
                    groupIndexByGroup.set(item.group, groupIndex);
                    const itemReference = itemReferences[index];
                    const itemSize = (await resolveReferenceOutputSize(itemReference, requestBaseConfig.size)) || requestBaseConfig.size;
                    const itemConfig = buildGenerationLogConfig({ ...requestBaseConfig, size: itemSize, count: "1" });
                    return {
                        id: `${packageId}:${index + 1}`,
                        group: item.group,
                        index: index + 1,
                        groupIndex,
                        title: `${packageGroupTitle(item.group)}-${String(groupIndex).padStart(2, "0")}`,
                        prompt: promptText,
                        model: modelName,
                        config: itemConfig,
                        references: [transparentReference, itemReference],
                        status: "waiting" as const,
                        selected: false,
                        sourceFolderName: item.folderName,
                        sourceFileName: item.fileName,
                    };
                }),
            );
            const nextPackage: ProductImagePackage = {
                id: packageId,
                workflowId: folderPackageWorkflowId,
                workflowName: "文件夹套图生成",
                packageName: `${parsed.rootName}-套图生成`,
                productName: parsed.rootName,
                inputs: { productName: parsed.rootName, prompt: promptText, transparentFile: parsed.transparentFile.name },
                references: [transparentReference],
                model: modelName,
                config: configSnapshot,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                totalCount: items.length,
                items,
            };
            setReferences([transparentReference]);
            setProductPackages((value) => [nextPackage, ...value.filter((item) => item.id !== nextPackage.id)]);
            setActivePackageId(packageId);
            setResultViewMode("all");
            setActiveResultCategoryId(null);
            message.success(`已创建 ${items.length} 个待生成任务，勾选后点击开始生成`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导入套图文件夹失败");
        } finally {
            hideLoading();
        }
    };

    const runFolderPackageTasks = async (packageData: ProductImagePackage, requestBaseConfig: AiConfig, itemIds?: string[]) => {
        const targetIds = itemIds ? new Set(itemIds) : null;
        const runnableItems = packageData.items.filter((item) => (!targetIds || targetIds.has(item.id)) && item.status !== "running" && item.prompt.trim());
        await Promise.all(runnableItems.map((item) => runFolderPackageItem(packageData, item, requestBaseConfig)));
    };

    const runFolderPackageItem = async (packageData: ProductImagePackage, item: ProductPackageItem, requestBaseConfig: AiConfig) => {
        const startedAt = Date.now();
        const taskStartedAt = performance.now();
        const existingLog = findPackageLogForRetry(logs, packageData.id, item);
        const historyLogs = packageItemHistoryLogs(logs, packageData.id, item.index);
        const versionMeta = existingLog
            ? buildPackageItemRetryVersionMeta(packageData.id, item.index, existingLog, historyLogs)
            : {
                  versionGroupId: packageItemVersionGroupId(packageData.id, item.index),
                  nextVersionNo: 1,
                  retryOfLogId: undefined,
                  retryOfVersionNo: undefined,
              };
        setProductPackages((value) => upsertRetriedPackage(value, packageData, item.id, { status: "running", selected: false, startedAt, endedAt: undefined, durationMs: undefined, error: undefined, errorDetail: undefined, image: undefined }));
        setNow(startedAt);
        try {
            const requestConfig = packageItemRequestConfig(requestBaseConfig, packageData.model, item.config);
            const result = await requestEdit(requestConfig, item.prompt, item.references);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const stored = await uploadImage(image.dataUrl);
            const endedAt = Date.now();
            const nextImage: GeneratedImage = {
                id: image.id,
                dataUrl: stored.url,
                storageKey: stored.storageKey,
                durationMs: performance.now() - taskStartedAt,
                width: stored.width || meta.width,
                height: stored.height || meta.height,
                bytes: stored.bytes || getDataUrlByteSize(image.dataUrl),
                mimeType: stored.mimeType || meta.mimeType,
            };
            const log = buildPackageRetryLog({
                baseLog: existingLog,
                logId: nanoid(),
                packageData,
                item,
                prompt: item.prompt,
                model: packageData.model,
                config: item.config,
                references: item.references,
                images: [nextImage],
                durationMs: endedAt - startedAt,
                errors: [],
                errorDetails: [],
                status: "成功",
                versionGroupId: versionMeta.versionGroupId,
                versionNo: versionMeta.nextVersionNo,
                retryOfLogId: versionMeta.retryOfLogId,
                retryOfVersionNo: versionMeta.retryOfVersionNo,
            });
            setProductPackages((value) =>
                upsertRetriedPackage(value, packageData, item.id, { status: "success", selected: false, startedAt, endedAt, durationMs: endedAt - startedAt, error: undefined, errorDetail: undefined, image: nextImage, logId: log.id }),
            );
            await saveLog(log);
        } catch (error) {
            const endedAt = Date.now();
            const nextError = errorMessage(error);
            const nextErrorDetail = errorDetail(error);
            const log = buildPackageRetryLog({
                baseLog: existingLog,
                logId: nanoid(),
                packageData,
                item,
                prompt: item.prompt,
                model: packageData.model,
                config: item.config,
                references: item.references,
                images: [],
                durationMs: endedAt - startedAt,
                errors: [nextError],
                errorDetails: [nextErrorDetail],
                status: "失败",
                versionGroupId: versionMeta.versionGroupId,
                versionNo: versionMeta.nextVersionNo,
                retryOfLogId: versionMeta.retryOfLogId,
                retryOfVersionNo: versionMeta.retryOfVersionNo,
            });
            setProductPackages((value) =>
                upsertRetriedPackage(value, packageData, item.id, { status: "failed", selected: false, startedAt, endedAt, durationMs: endedAt - startedAt, error: nextError, errorDetail: nextErrorDetail, image: undefined, logId: log.id }),
            );
            await saveLog(log);
        }
    };

    const updateProductPackageItems = (packageId: string, updater: (item: ProductPackageItem) => ProductPackageItem) => {
        const sourcePackage = productPackageFolders.find((item) => item.id === packageId);
        if (!sourcePackage) return;
        setProductPackages((value) => {
            const existing = value.find((item) => item.id === packageId);
            const base = existing || sourcePackage;
            const nextPackage = { ...base, updatedAt: Date.now(), items: base.items.map(updater) };
            return existing ? value.map((item) => (item.id === packageId ? nextPackage : item)) : [nextPackage, ...value];
        });
    };

    const togglePackageItemSelected = (packageId: string, itemId: string, checked: boolean) => {
        updateProductPackageItems(packageId, (item) => (item.id === itemId ? { ...item, selected: checked } : item));
    };

    const selectPackageItems = (packageId: string, group: ProductPackageGroup | "all", checked: boolean) => {
        updateProductPackageItems(packageId, (item) => {
            if (group !== "all" && item.group !== group) return item;
            if (item.status === "running") return item;
            return { ...item, selected: checked };
        });
    };

    const startSelectedPackageItems = async (packageId: string, group: ProductPackageGroup | "all" = "all", promptOverride?: string) => {
        const targetPackage = productPackageFolders.find((item) => item.id === packageId);
        if (!targetPackage) {
            message.error("没有找到这个套图文件夹");
            return;
        }
        const bulkPrompt = promptOverride?.trim() || "";
        const shouldApplyBulkPrompt = (item: ProductPackageItem) => item.selected && (group === "all" || item.group === group) && item.status !== "running";
        const runPackage = bulkPrompt
            ? {
                  ...targetPackage,
                  updatedAt: Date.now(),
                  items: targetPackage.items.map((item) => (shouldApplyBulkPrompt(item) ? { ...item, prompt: bulkPrompt } : item)),
              }
            : targetPackage;
        if (bulkPrompt) {
            setProductPackages((value) => value.map((item) => (item.id === packageId ? runPackage : item)));
        }
        const selectedItems = runPackage.items.filter((item) => item.selected && (group === "all" || item.group === group));
        if (!selectedItems.length) {
            message.warning(group === "all" ? "请先勾选要生成的图片" : `请先勾选${packageGroupTitle(group)}里要生成的图片`);
            return;
        }
        const runnableItems = selectedItems.filter((item) => item.status !== "running");
        const missingPrompt = runnableItems.filter((item) => !item.prompt.trim());
        if (missingPrompt.length) {
            message.error(`有 ${missingPrompt.length} 张没有提示词，请先补充提示词`);
            return;
        }
        const modelName = targetPackage.model || effectiveConfig.imageModel || effectiveConfig.model || model || "gpt-image-2";
        const requestBaseConfig: AiConfig = { ...effectiveConfig, model: modelName, imageModel: modelName, activeChannelId: effectiveConfig.imageChannelId, count: "1" };
        if (!isAiConfigReady(requestBaseConfig, modelName)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }
        setActivePackageId(packageId);
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        message.success(`${bulkPrompt ? "已套用批量提示词，" : ""}已开始生成 ${runnableItems.length} 张`);
        await runFolderPackageTasks(
            clonePackageForRetry(runPackage),
            requestBaseConfig,
            runnableItems.map((item) => item.id),
        );
    };

    const removeReference = async (id: string) => {
        const reference = references.find((item) => item.id === id);
        setReferences((value) => value.filter((ref) => ref.id !== id));
        if (!reference || !shouldDeleteReferenceFile(reference, logs, results)) {
            message.success("已从工作台移除参考图");
            return;
        }
        if (reference?.storageKey) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const pastePromptFromClipboard = async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                message.error("剪切板里没有可读取的文本");
                return;
            }
            setPrompt(text);
            setCollapsedSections((value) => ({ ...value, prompt: false }));
            message.success("已读取剪切板文本");
        } catch {
            message.error("剪切板里没有可读取的文本");
        }
    };

    const clearPrompt = () => {
        setPrompt("");
        setCollapsedSections((value) => ({ ...value, prompt: false }));
    };

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        await submitGenerationBatch(snapshot, {
            batchMode,
            onAccepted: () => {
                setPrompt("");
                setReferences([]);
                setCollapsedSections((value) => ({ ...value, prompt: false, references: true }));
            },
        });
    };

    const retryLog = async (log: GenerationLog) => {
        const taskCount = Math.max(1, Number(log.config.count) || log.imageCount || 1);
        const snapshot = buildRequestSnapshot({ promptText: log.prompt, referenceItems: log.references, taskCount });
        if (!snapshot) return;
        await submitGenerationBatch(snapshot, { anchorLog: taskCount === 1 ? log : null, retrySourceLog: log });
    };

    const submitGenerationBatch = async (snapshot: RequestSnapshot, options?: SubmitGenerationOptions) => {
        setPreviewLog(null);
        const taskCount = Math.max(1, Number(snapshot.displayConfig.count) || 1);
        const shouldSplitReferences = Boolean(options?.batchMode && snapshot.references.length > 1);
        const referenceSnapshots = shouldSplitReferences ? await Promise.all(snapshot.references.map((reference) => buildReferenceScopedSnapshot(snapshot, reference))) : [];
        const taskEntries: GenerationTaskEntry[] = shouldSplitReferences
            ? referenceSnapshots.flatMap((taskSnapshot) =>
                  Array.from({ length: taskCount }, () => ({
                      id: nanoid(),
                      snapshot: taskSnapshot,
                  })),
              )
            : Array.from({ length: taskCount }, () => ({ id: nanoid(), snapshot }));
        const totalTaskCount = taskEntries.length;
        if (shouldSplitReferences && totalTaskCount > BATCH_GENERATION_CONFIRM_THRESHOLD) {
            const confirmed = await new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: "确认批量生成",
                    content: `批量模式会把 ${snapshot.references.length} 张参考图拆成独立任务，每张生成 ${taskCount} 张，共 ${totalTaskCount} 张。是否继续？`,
                    okText: "继续生成",
                    cancelText: "取消",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            });
            if (!confirmed) return;
        }
        options?.onAccepted?.();
        const replaceLog = totalTaskCount === 1 ? options?.replaceLog || null : null;
        const anchorLog = totalTaskCount === 1 ? options?.anchorLog || replaceLog : null;
        const retrySourceLog = options?.retrySourceLog || null;
        const retryVersionMeta = retrySourceLog ? buildRetryVersionMeta(retrySourceLog, logs) : null;
        const batchCategoryIds = replaceLog?.categoryIds?.length ? replaceLog.categoryIds : retrySourceLog?.categoryIds?.length ? retrySourceLog.categoryIds : activeResultCategoryId ? [activeResultCategoryId] : [];
        const batchStartedAt = Date.now();
        const queuedTasks = taskEntries.map((entry, index) =>
            createPendingResult(entry.id, entry.snapshot, "running", {
                logId: replaceLog?.id || anchorLog?.id,
                createdAt: replaceLog?.createdAt || anchorLog?.createdAt,
                startedAt: batchStartedAt,
                versionGroupId: retryVersionMeta?.versionGroupId,
                versionNo: retryVersionMeta ? retryVersionMeta.nextVersionNo + index : undefined,
                retryOfLogId: retryVersionMeta?.retryOfLogId,
                retryOfVersionNo: retryVersionMeta?.retryOfVersionNo,
            }),
        );
        setResults((value) => [...queuedTasks, ...value.filter((item) => !anchorLog || item.logId !== anchorLog.id || (item.status !== "waiting" && item.status !== "running"))]);
        setNow(Date.now());

        let successCount = 0;
        let failCount = 0;
        let firstFailure: unknown = null;

        const runTaskAtIndex = async (index: number) => {
            const taskEntry = taskEntries[index];
            const resultId = taskEntry.id;
            const taskSnapshot = taskEntry.snapshot;
            const startedAt = Date.now();
            const taskConfig = buildSingleResultLogConfig(taskSnapshot.displayConfig);
            setResults((value) => updateResult(value, resultId, { status: "running", startedAt, error: undefined, errorDetail: undefined, durationMs: undefined }));
            setNow(startedAt);
            const taskStartedAt = performance.now();

            try {
                const image = await runGenerationTask(resultId, taskSnapshot);
                successCount += 1;
                try {
                    const stored = await uploadImage(image.dataUrl);
                    const durableImage = { ...image, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                    const log = buildLog({
                        id: replaceLog?.id,
                        createdAt: replaceLog?.createdAt,
                        prompt: taskSnapshot.text,
                        model: taskSnapshot.displayConfig.imageModel || taskSnapshot.displayConfig.model,
                        config: taskConfig,
                        references: taskSnapshot.references,
                        durationMs: durableImage.durationMs,
                        successCount: 1,
                        failCount: 0,
                        status: "成功",
                        images: [durableImage],
                        errors: [],
                        errorDetails: [],
                        categoryIds: batchCategoryIds,
                        versionGroupId: retryVersionMeta?.versionGroupId,
                        versionNo: retryVersionMeta ? retryVersionMeta.nextVersionNo + index : undefined,
                        retryOfLogId: retryVersionMeta?.retryOfLogId,
                        retryOfVersionNo: retryVersionMeta?.retryOfVersionNo,
                    });
                    setResults((value) => updateResult(value, resultId, { image: durableImage, logId: log.id }));
                    await saveLog(log);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "保存生成记录失败");
                }
            } catch (error) {
                const nextError = errorMessage(error);
                const nextErrorDetail = errorDetail(error);
                failCount += 1;
                if (!firstFailure) firstFailure = error;
                try {
                    const log = buildLog({
                        id: replaceLog?.id,
                        createdAt: replaceLog?.createdAt,
                        prompt: taskSnapshot.text,
                        model: taskSnapshot.displayConfig.imageModel || taskSnapshot.displayConfig.model,
                        config: taskConfig,
                        references: taskSnapshot.references,
                        durationMs: performance.now() - taskStartedAt,
                        successCount: 0,
                        failCount: 1,
                        status: "失败",
                        images: [],
                        errors: [nextError],
                        errorDetails: [nextErrorDetail],
                        categoryIds: batchCategoryIds,
                        versionGroupId: retryVersionMeta?.versionGroupId,
                        versionNo: retryVersionMeta ? retryVersionMeta.nextVersionNo + index : undefined,
                        retryOfLogId: retryVersionMeta?.retryOfLogId,
                        retryOfVersionNo: retryVersionMeta?.retryOfVersionNo,
                    });
                    setResults((value) => updateResult(value, resultId, { logId: log.id }));
                    await saveLog(log);
                } catch (saveError) {
                    message.error(saveError instanceof Error ? saveError.message : "保存生成记录失败");
                }
            }
        };

        await Promise.all(taskEntries.map((_entry, index) => runTaskAtIndex(index)));

        if (successCount > 0) {
            if (failCount > 0) {
                message.warning(`已生成 ${successCount} 张，失败 ${failCount} 张`);
                return;
            }
            message.success(totalTaskCount > 1 ? `已生成 ${successCount} 张图片` : "图片已生成");
            return;
        }
        message.error(firstFailure instanceof Error ? firstFailure.message : "生成失败");
    };

    const downloadImage = async (image: GeneratedImage, index: number) => {
        try {
            const dataUrl = await imageToDataUrl(image);
            const response = await fetch(dataUrl || image.dataUrl);
            const blob = await response.blob();
            saveAs(blob, `image-${index + 1}.${imageExtension(image.mimeType || blob.type || dataUrl || image.dataUrl)}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片下载失败");
        }
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        try {
            if (image.storageKey) {
                const url = await resolveImageUrl(image.storageKey, image.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: image.mimeType || "image/png", dataUrl: url || image.dataUrl, storageKey: image.storageKey, source: "result", temporary: false }]);
            } else {
                const source = await imageToDataUrl(image);
                const stored = await uploadImage(source || image.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: "result", temporary: false }]);
            }
            message.success("已加入参考图");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加入参考图失败");
        }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = image.storageKey
            ? {
                  url: await resolveImageUrl(image.storageKey, image.dataUrl),
                  storageKey: image.storageKey,
                  width: image.width,
                  height: image.height,
                  bytes: image.bytes,
                  mimeType: image.mimeType || "image/png",
              }
            : await uploadImage(await imageToDataUrl(image));
        addAsset({
            kind: "image",
            title: `生成结果 ${index + 1}`,
            coverUrl: stored.url,
            tags: [],
            source: "生图工作台",
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType, shareId: image.shareId, shareUrl: image.shareUrl },
            metadata: { source: "image-page", prompt },
        });
        message.success("已加入我的素材");
    };

    const copyGeneratedImageLink = async (image: GeneratedImage, index: number) => {
        setLinkingImageId(image.id);
        const hideLoading = message.loading(image.shareUrl ? "正在复制链接..." : "正在生成图片链接...", 0);
        try {
            const link = await ensureImageShareLink(image, `image-${index + 1}`);
            await patchGeneratedImageShareLink(image.id, link);
            copyText(link.url, "图片链接已复制");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片链接生成失败");
        } finally {
            hideLoading();
            setLinkingImageId("");
        }
    };

    const patchGeneratedImageShareLink = async (imageId: string, link: ImageShareLinkResult) => {
        const patch = { shareId: link.id, shareUrl: link.url };
        const patchImage = (image: GeneratedImage) => (image.id === imageId ? { ...image, ...patch } : image);
        setResults((value) => value.map((item) => (item.image?.id === imageId ? { ...item, image: patchImage(item.image) } : item)));
        const nextPackages = productPackages.map((pkg) => ({ ...pkg, items: pkg.items.map((item) => (item.image?.id === imageId ? { ...item, image: patchImage(item.image) } : item)) }));
        setProductPackages(nextPackages);
        setPreviewLog((value) => {
            if (!value) return value;
            const nextImages = value.images.map(patchImage);
            return { ...value, images: nextImages, thumbnails: nextImages.map((image) => image.dataUrl) };
        });

        let changed = false;
        const nextLogs = logs.map((log) => {
            if (!log.images.some((image) => image.id === imageId)) return log;
            changed = true;
            const nextImages = log.images.map(patchImage);
            return { ...log, images: nextImages, thumbnails: nextImages.map((image) => image.dataUrl) };
        });
        if (!changed) return;
        setLogs(nextLogs);
        await Promise.all(nextLogs.filter((log) => log.images.some((image) => image.id === imageId)).map((log) => logStore.setItem(scopedImageHistoryLogKey(log.id), serializeLog(log))));
        await persistImageHistory(nextLogs, categories, nextPackages);
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const reference =
                payload.storageKey || payload.source === "asset"
                    ? {
                          id: nanoid(),
                          name: payload.title,
                          type: payload.mimeType || "image/png",
                          dataUrl: payload.dataUrl,
                          storageKey: payload.storageKey,
                          source: "asset" as const,
                          assetId: payload.assetId,
                          temporary: false,
                      }
                    : (() => null)();
            if (reference) {
                setReferences((value) => [...value, reference]);
            } else {
                const stored = await uploadImage(payload.dataUrl);
                setReferences((value) => [
                    ...value,
                    { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: payload.source === "library" ? "library" : "upload", temporary: payload.source !== "library" },
                ]);
            }
        } else {
            message.warning("视频素材不能作为生图参考图");
        }
        setAssetPickerOpen(false);
    };

    const deleteSelectedItems = async (options?: { resultIds?: string[]; logIds?: string[]; packageIds?: string[] }) => {
        const resultIds = options?.resultIds ?? selectedResultIds;
        const logIds = options?.logIds ?? selectedLogIds;
        const packageIds = options?.packageIds ?? selectedPackageIds;
        const selectedResultSet = new Set(resultIds);
        const selectedPackageSet = new Set(packageIds);
        const packageLogIds = new Set(productPackageFolders.filter((pkg) => selectedPackageSet.has(pkg.id)).flatMap((pkg) => pkg.items.map((item) => item.logId).filter((id): id is string => Boolean(id))));
        const selectedLogSet = new Set(logIds);
        const deletedResults = results.filter((result) => selectedResultSet.has(result.id));
        let nextResults = results.filter((result) => !selectedResultSet.has(result.id));
        const deletedLogs = logs.filter((log) => selectedLogSet.has(log.id) || packageLogIds.has(log.id));
        const nextLogs = logs.filter((log) => !selectedLogSet.has(log.id) && !packageLogIds.has(log.id));
        const deletedLogIds = new Set(deletedLogs.map((log) => log.id));
        const nextPackages = reconcileProductPackagesAfterLogDeletion(productPackages, nextLogs, deletedLogIds, selectedPackageSet);
        if (previewLog && (selectedLogSet.has(previewLog.id) || packageLogIds.has(previewLog.id))) {
            setPreviewLog(null);
            nextResults = nextResults.filter((item) => item.status === "waiting" || item.status === "running");
        }
        const retainedKeys = collectImageStorageKeys({ assets: useAssetStore.getState().assets, projects: useCanvasStore.getState().projects, logs: nextLogs, productPackages: nextPackages, results: nextResults, references });
        const imageKeys = Array.from(new Set([...disposableLogStorageKeys(deletedLogs, nextLogs, retainedKeys), ...disposableResultStorageKeys(deletedResults, retainedKeys)]));
        try {
            await Promise.all([deleteStoredImages(imageKeys), ...deletedLogs.map((log) => logStore.removeItem(scopedImageHistoryLogKey(log.id)))]);
            setResults(nextResults);
            setLogs(nextLogs);
            setProductPackages(nextPackages);
            setReferences((value) => value.filter((item) => !item.storageKey || !imageKeys.includes(item.storageKey)));
            if (deletedLogs.length || selectedPackageSet.size) {
                await persistImageHistory(nextLogs, categories, nextPackages);
                await refreshLogs();
            }
            if (activePackageId && !nextPackages.some((pkg) => pkg.id === activePackageId)) setActivePackageId(null);
            setSelectedResultIds((value) => value.filter((id) => !selectedResultSet.has(id)));
            setSelectedLogIds((value) => value.filter((id) => !selectedLogSet.has(id) && !packageLogIds.has(id)));
            setSelectedPackageIds((value) => value.filter((id) => !selectedPackageSet.has(id)));
            setDeleteConfirmOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    const deleteSelectedLogs = () => void deleteSelectedItems();

    const deleteResult = (result: GenerationResult) => {
        modal.confirm({
            title: "删除新生成结果",
            content: "确定删除这张新生成结果吗？",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => deleteSelectedItems({ resultIds: [result.id], logIds: [], packageIds: [] }),
        });
    };

    const deleteLog = (log: GenerationLog) => {
        modal.confirm({
            title: "删除生成结果",
            content: "确定删除这条生成结果吗？",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const nextLogs = logs.filter((item) => item.id !== log.id);
                const deletedLogIds = new Set([log.id]);
                const nextPackages = reconcileProductPackagesAfterLogDeletion(productPackages, nextLogs, deletedLogIds);
                const retainedKeys = collectImageStorageKeys({ assets: useAssetStore.getState().assets, projects: useCanvasStore.getState().projects, results, references });
                const imageKeys = disposableLogStorageKeys([log], nextLogs, retainedKeys);
                await Promise.all([deleteStoredImages(imageKeys), logStore.removeItem(scopedImageHistoryLogKey(log.id))]);
                setLogs(nextLogs);
                setProductPackages(nextPackages);
                setReferences((value) => value.filter((item) => !item.storageKey || !imageKeys.includes(item.storageKey)));
                await persistImageHistory(nextLogs, categories, nextPackages);
                setSelectedLogIds((value) => value.filter((id) => id !== log.id));
                if (previewLog?.id === log.id) setPreviewLog(null);
                if (activePackageId && !nextPackages.some((pkg) => pkg.id === activePackageId)) setActivePackageId(null);
                await refreshLogs();
            },
        });
    };

    const saveLog = async (log: GenerationLog) => {
        const storedLogs = await readStoredLogs();
        const nextLogs = [log, ...storedLogs.filter((item) => item.id !== log.id)].sort((a, b) => b.createdAt - a.createdAt);
        setLogs(nextLogs);
        await logStore.setItem(scopedImageHistoryLogKey(log.id), serializeLog(log));
        await persistImageHistory(nextLogs, categories, productPackages);
        await refreshLogs();
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());
    const refreshCategories = async () => setCategories(await readStoredCategories());
    const refreshProductPackages = async () => {
        const storedPackages = await readStoredProductPackages();
        productPackagesLoadedRef.current = true;
        setProductPackages(storedPackages);
    };

    const loadAccountImageHistory = async (currentToken: string) => {
        try {
            const config = await fetchUserConfig(currentToken);
            accountHistorySyncEnabledRef.current = config.syncCapabilities?.userData === true;
            const remote = config.imageHistory as { logs?: GenerationLog[]; categories?: GenerationCategory[]; packages?: ProductImagePackage[] } | undefined;
            const remoteLogs = Array.isArray(remote?.logs) ? remote.logs : [];
            const remoteCategories = Array.isArray(remote?.categories) ? remote.categories : [];
            const remotePackages = await normalizeProductPackages(Array.isArray(remote?.packages) ? remote.packages : []);
            if (remoteLogs.length || remoteCategories.length || remotePackages.length) {
                const localLogs = await readStoredLogs();
                const localCategories = await readStoredCategories();
                const localPackages = await readStoredProductPackages();
                const mergedLogs = await mergeGenerationLogs(remoteLogs, localLogs);
                const mergedCategories = mergeGenerationCategories(remoteCategories, localCategories);
                const mergedPackages = mergeProductPackages(remotePackages, localPackages);
                await replaceStoredImageHistory(mergedLogs, mergedCategories);
                await replaceStoredProductPackages(mergedPackages);
                setLogs(mergedLogs);
                setCategories(mergedCategories);
                productPackagesLoadedRef.current = true;
                setProductPackages(mergedPackages);
                if (accountHistorySyncEnabledRef.current && (mergedLogs.length !== remoteLogs.length || mergedCategories.length !== remoteCategories.length || mergedPackages.length !== remotePackages.length || mergedLogs.some(hasUnsyncedLocalImages))) {
                    await syncUserImageHistory(currentToken, await imageHistorySnapshot(mergedLogs, mergedCategories, mergedPackages));
                }
                return;
            }
            const localLogs = await readStoredLogs();
            const localCategories = await readStoredCategories();
            const localPackages = await readStoredProductPackages();
            if (accountHistorySyncEnabledRef.current && (localLogs.length || localCategories.length || localPackages.length)) await syncUserImageHistory(currentToken, await imageHistorySnapshot(localLogs, localCategories, localPackages));
        } catch {
            // Keep local history available when account sync fails.
        }
    };

    const persistImageHistory = async (nextLogs: GenerationLog[], nextCategories: GenerationCategory[], nextPackages: ProductImagePackage[] = productPackages) => {
        if (!token || !accountHistorySyncEnabledRef.current) return;
        await syncUserImageHistory(token, await imageHistorySnapshot(nextLogs, nextCategories, nextPackages)).catch(() => {
            accountHistorySyncEnabledRef.current = false;
        });
    };

    const createCategory = async (name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            message.error("请输入分类名称");
            return null;
        }
        const existing = categories.find((item) => item.name === trimmedName);
        if (existing) return existing;
        const nextCategory = { id: nanoid(), name: trimmedName, createdAt: Date.now() };
        const nextCategories = [...categories, nextCategory];
        setCategories(nextCategories);
        await categoryStore.setItem(scopedImageHistoryCategoryKey(), nextCategories);
        await persistImageHistory(logs, nextCategories);
        return nextCategory;
    };

    const renameCategory = async (category: GenerationCategory, name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            message.error("请输入分类名称");
            return;
        }
        const nextCategories = categories.map((item) => (item.id === category.id ? { ...item, name: trimmedName } : item));
        setCategories(nextCategories);
        await categoryStore.setItem(scopedImageHistoryCategoryKey(), nextCategories);
        await persistImageHistory(logs, nextCategories);
        message.success("已重命名分类");
    };

    const deleteCategory = (category: GenerationCategory) => {
        modal.confirm({
            title: "删除分类",
            content: `确定删除分类「${category.name}」吗？分类内的生成结果会移至未分类。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const nextCategories = categories.filter((item) => item.id !== category.id);
                const nextLogs = logs.map((log) => ({ ...log, categoryIds: log.categoryIds.filter((id) => id !== category.id) }));
                setCategories(nextCategories);
                setLogs(nextLogs);
                await categoryStore.setItem(scopedImageHistoryCategoryKey(), nextCategories);
                await Promise.all(nextLogs.map((log) => logStore.setItem(scopedImageHistoryLogKey(log.id), serializeLog(log))));
                await persistImageHistory(nextLogs, nextCategories);
                message.success("已删除分类");
            },
        });
    };

    const updateLogCategories = async (log: GenerationLog, categoryIds: string[]) => {
        const nextLog = { ...log, categoryIds };
        const nextLogs = logs.map((item) => (item.id === log.id ? nextLog : item));
        setLogs(nextLogs);
        await logStore.setItem(scopedImageHistoryLogKey(log.id), serializeLog(nextLog));
        await persistImageHistory(nextLogs, categories);
        await refreshLogs();
        message.success(categoryIds.length ? "已更新分类" : "已移至未分类");
    };

    const toggleLogCategory = async (log: GenerationLog, categoryId: string) => {
        const nextCategoryIds = log.categoryIds.includes(categoryId) ? log.categoryIds.filter((id) => id !== categoryId) : [...log.categoryIds, categoryId];
        await updateLogCategories(log, nextCategoryIds);
    };

    const updateHistoryLogPrompt = async (log: GenerationLog, promptText: string) => {
        const nextPrompt = promptText.trim();
        if (!nextPrompt) {
            message.error("提示词不能为空");
            return false;
        }
        const nextLog = {
            ...log,
            prompt: nextPrompt,
            title: nextPrompt.slice(0, 12) || log.title || "未命名",
        };
        const nextLogs = logs.map((item) => (item.id === log.id ? nextLog : item));
        setLogs(nextLogs);
        if (previewLog?.id === log.id) {
            setPreviewLog(nextLog);
            setPrompt(nextPrompt);
        }
        await logStore.setItem(scopedImageHistoryLogKey(log.id), serializeLog(nextLog));
        await persistImageHistory(nextLogs, categories);
        await refreshLogs();
        message.success("已更新提示词");
        return true;
    };

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        setCollapsedSections((value) => ({ ...value, prompt: false, references: !log.references?.length }));
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        if (log.config.apiMode) updateConfig("apiMode", log.config.apiMode);
        if (log.config.outputFormat) updateConfig("outputFormat", log.config.outputFormat);
        if (log.config.outputCompression) updateConfig("outputCompression", log.config.outputCompression);
        if (log.config.moderation) updateConfig("moderation", log.config.moderation);
        if (log.config.timeout) updateConfig("timeout", log.config.timeout);
        if (typeof log.config.streamImages === "boolean") updateConfig("streamImages", log.config.streamImages);
        if (log.config.streamPartialImages) updateConfig("streamPartialImages", log.config.streamPartialImages);
        if (typeof log.config.responseFormatB64Json === "boolean") updateConfig("responseFormatB64Json", log.config.responseFormatB64Json);
        if (typeof log.config.codexCli === "boolean") updateConfig("codexCli", log.config.codexCli);
    };

    const copyPrompt = (text: string) => {
        copyText(text, "提示词已复制");
    };

    const buildRequestSnapshot = ({ promptText = prompt, referenceItems = references, taskCount = generationCount }: { promptText?: string; referenceItems?: ReferenceImage[]; taskCount?: number } = {}) => {
        const text = promptText.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        const resolvedReferences = resolvePromptReferences(text, referenceItems);
        if (resolvedReferences.error) {
            message.error(resolvedReferences.error);
            return null;
        }
        if (!resolvedReferences.requestText.trim()) {
            message.error("请在引用参考图之外补充文字描述");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return {
            text,
            requestText: resolvedReferences.requestText,
            requestConfig: { ...effectiveConfig, model, activeChannelId: effectiveConfig.imageChannelId, count: "1" },
            displayConfig: buildGenerationLogConfig({ ...effectiveConfig, model, count: String(taskCount) }),
            references: resolvedReferences.references,
        };
    };

    const runGenerationTask = async (resultId: string, snapshot: RequestSnapshot) => {
        const itemStartedAt = performance.now();
        try {
            const result = snapshot.references.length ? await requestEdit(snapshot.requestConfig, snapshot.requestText, snapshot.references) : await requestGeneration(snapshot.requestConfig, snapshot.requestText);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage: GeneratedImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl), mimeType: meta.mimeType };
            setResults((value) => updateResult(value, resultId, { status: "success", image: nextImage, durationMs: nextImage.durationMs }));
            return nextImage;
        } catch (error) {
            setResults((value) => updateResult(value, resultId, { status: "failed", error: errorMessage(error), errorDetail: errorDetail(error), durationMs: performance.now() - itemStartedAt }));
            throw error;
        }
    };

    const retryResult = (result: GenerationResult) => {
        const snapshot = buildRequestSnapshot({ promptText: result.prompt, referenceItems: result.references, taskCount: 1 });
        if (!snapshot) return;
        const retrySourceLog = result.logId ? logs.find((item) => item.id === result.logId) || null : null;
        void submitGenerationBatch(snapshot, { anchorLog: retrySourceLog, retrySourceLog });
    };

    const updateResultPrompt = (resultId: string, promptText: string) => {
        const text = promptText.trim();
        if (!text) {
            message.error("请输入提示词");
            return false;
        }
        setResults((value) => updateResult(value, resultId, { prompt: text }));
        message.success("已更新提示词");
        return true;
    };

    const retryPackageItem = async (packageId: string, itemId: string, promptOverride?: string) => {
        const targetPackage = productPackageFolders.find((pkg) => pkg.id === packageId);
        const targetItem = targetPackage?.items.find((item) => item.id === itemId);
        if (!targetPackage || !targetItem) {
            message.error("没有找到这张图");
            return;
        }
        const promptText = (promptOverride ?? targetItem.prompt).trim();
        if (!promptText) {
            message.error("这张图还没有可用提示词");
            return;
        }
        const workingItem = { ...targetItem, prompt: promptText };
        const itemModel = targetItem.model || effectiveConfig.imageModel || effectiveConfig.model;
        const requestConfig: AiConfig = {
            ...effectiveConfig,
            model: itemModel,
            imageModel: itemModel,
            activeChannelId: effectiveConfig.imageChannelId,
            count: "1",
            quality: targetItem.config.quality || effectiveConfig.quality,
            size: targetItem.config.size || effectiveConfig.size,
            apiMode: targetItem.config.apiMode || effectiveConfig.apiMode,
            outputFormat: targetItem.config.outputFormat || effectiveConfig.outputFormat,
            outputCompression: targetItem.config.outputCompression || effectiveConfig.outputCompression,
            moderation: targetItem.config.moderation || effectiveConfig.moderation,
            timeout: targetItem.config.timeout || effectiveConfig.timeout,
            streamImages: typeof targetItem.config.streamImages === "boolean" ? targetItem.config.streamImages : effectiveConfig.streamImages,
            streamPartialImages: targetItem.config.streamPartialImages || effectiveConfig.streamPartialImages,
            responseFormatB64Json: typeof targetItem.config.responseFormatB64Json === "boolean" ? targetItem.config.responseFormatB64Json : effectiveConfig.responseFormatB64Json,
            codexCli: typeof targetItem.config.codexCli === "boolean" ? targetItem.config.codexCli : effectiveConfig.codexCli,
        };
        if (!isAiConfigReady(requestConfig, itemModel)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }

        const livePackage = clonePackageForRetry(targetPackage);
        const retryReferences = (workingItem.references.length ? workingItem.references : targetPackage.references).filter((item) => Boolean(item.dataUrl));
        const historyLogs = packageItemHistoryLogs(logs, packageId, workingItem.index);
        const existingLog = findPackageLogForRetry(logs, packageId, workingItem);
        const nextLogId = nanoid();
        const retryVersionMeta = buildPackageItemRetryVersionMeta(packageId, workingItem.index, existingLog, historyLogs);
        const startedAt = Date.now();
        const resolvedPrompt = resolvePromptReferences(promptText, retryReferences);
        if (resolvedPrompt.error) {
            message.error(resolvedPrompt.error);
            return;
        }
        if (!resolvedPrompt.requestText.trim()) {
            message.error("请在引用参考图之外补充文字描述");
            return;
        }

        setProductPackages((value) =>
            upsertRetriedPackage(value, livePackage, itemId, { prompt: promptText, status: "running", selected: false, startedAt, endedAt: undefined, durationMs: undefined, error: undefined, errorDetail: undefined, image: undefined, logId: nextLogId }),
        );
        setActivePackageId(packageId);
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        setNow(Date.now());

        try {
            const result = resolvedPrompt.references.length ? await requestEdit(requestConfig, resolvedPrompt.requestText, resolvedPrompt.references) : await requestGeneration(requestConfig, resolvedPrompt.requestText);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const stored = await uploadImage(image.dataUrl);
            const endedAt = Date.now();
            const durationMs = endedAt - startedAt;
            const nextImage: GeneratedImage = {
                id: image.id,
                dataUrl: stored.url,
                storageKey: stored.storageKey,
                durationMs,
                width: stored.width || meta.width,
                height: stored.height || meta.height,
                bytes: stored.bytes || getDataUrlByteSize(image.dataUrl),
                mimeType: stored.mimeType || meta.mimeType,
            };
            setProductPackages((value) =>
                upsertRetriedPackage(value, livePackage, itemId, {
                    prompt: promptText,
                    status: "success",
                    selected: false,
                    startedAt,
                    endedAt,
                    durationMs: endedAt - startedAt,
                    error: undefined,
                    errorDetail: undefined,
                    image: nextImage,
                    logId: nextLogId,
                }),
            );
            const nextLog = buildPackageRetryLog({
                baseLog: existingLog,
                logId: nextLogId,
                packageData: targetPackage,
                item: workingItem,
                prompt: promptText,
                model: itemModel,
                config: buildGenerationLogConfig({ ...requestConfig, model: itemModel, imageModel: itemModel, count: "1" }),
                references: resolvedPrompt.references,
                images: [nextImage],
                durationMs: endedAt - startedAt,
                errors: [],
                errorDetails: [],
                status: "成功",
                versionGroupId: retryVersionMeta.versionGroupId,
                versionNo: retryVersionMeta.nextVersionNo,
                retryOfLogId: retryVersionMeta.retryOfLogId,
                retryOfVersionNo: retryVersionMeta.retryOfVersionNo,
            });
            await saveLog(nextLog);
            message.success(`${targetItem.title} 已重新生成`);
        } catch (error) {
            const endedAt = Date.now();
            const nextError = errorMessage(error);
            const nextErrorDetail = errorDetail(error);
            setProductPackages((value) =>
                upsertRetriedPackage(value, livePackage, itemId, {
                    prompt: promptText,
                    status: "failed",
                    selected: false,
                    startedAt,
                    endedAt,
                    durationMs: endedAt - startedAt,
                    error: nextError,
                    errorDetail: nextErrorDetail,
                    image: undefined,
                    logId: nextLogId,
                }),
            );
            const nextLog = buildPackageRetryLog({
                baseLog: existingLog,
                logId: nextLogId,
                packageData: targetPackage,
                item: workingItem,
                prompt: promptText,
                model: itemModel,
                config: buildGenerationLogConfig({ ...requestConfig, model: itemModel, imageModel: itemModel, count: "1" }),
                references: resolvedPrompt.references,
                images: [],
                durationMs: endedAt - startedAt,
                errors: [nextError],
                errorDetails: [nextErrorDetail],
                status: "失败",
                versionGroupId: retryVersionMeta.versionGroupId,
                versionNo: retryVersionMeta.nextVersionNo,
                retryOfLogId: retryVersionMeta.retryOfLogId,
                retryOfVersionNo: retryVersionMeta.retryOfVersionNo,
            });
            await saveLog(nextLog);
            message.error(nextError);
        }
    };

    const openPackageWorkflowRunner = (packageData: ProductImagePackage) => {
        const runnerReferences = references.length ? references : packageData.references;
        setWorkflowDrawerOpen(true);
        setWorkflowRunnerRequest({
            id: nanoid(),
            workflowId: packageData.workflowId,
            inputs: packageData.inputs,
            references: runnerReferences,
        });
    };

    const openPackageQuickStart = () => {
        setPackageQuickStartOpen(true);
        if (!packageQuickStartReferences.length && references.length) {
            setPackageQuickStartReferences([...references]);
        }
    };

    const addPackageQuickStartReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        const hideLoading = message.loading("正在上传产品图...", 0);
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
                }),
            );
            setPackageQuickStartReferences((value) => [...value, ...nextReferences]);
            message.success("产品图已加入");
        } catch (error) {
            message.error(error instanceof Error ? `上传产品图失败：${error.message}` : "上传产品图失败");
        } finally {
            hideLoading();
        }
    };

    const startPackageQuickStartDemo = () => {
        const productName = packageQuickStartDraft.productName.trim();
        if (!productName) {
            message.error("请输入产品名称");
            return;
        }
        const packageId = `demo:${nanoid()}`;
        const packageInputs = buildPackageQuickStartInputs(packageQuickStartDraft);
        const packageReferences = (packageQuickStartReferences.length ? packageQuickStartReferences : references).map((item) => ({ ...item }));
        const modelName = effectiveConfig.imageModel || effectiveConfig.model || model || "gpt-image-1";
        const configSnapshot = buildGenerationLogConfig({ ...effectiveConfig, model: modelName, imageModel: modelName, count: "16" });
        const nextPackage: ProductImagePackage = {
            id: packageId,
            workflowId: demoProductWorkflowId,
            workflowName: "小白图包 Demo",
            packageName: `${productName}-图包预演`,
            productName,
            inputs: packageInputs,
            references: packageReferences,
            model: modelName,
            config: configSnapshot,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalCount: 16,
            items: createQuickStartPackageItems({
                packageId,
                draft: packageQuickStartDraft,
                references: packageReferences,
                model: modelName,
                config: configSnapshot,
            }),
        };
        setReferences(packageReferences);
        setProductPackages((value) => [nextPackage, ...value.filter((item) => item.id !== nextPackage.id)]);
        setActivePackageId(packageId);
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        setPackageQuickStartOpen(false);
        message.success("图包 Demo 已创建，已跳到结果页");
    };

    const updatePackageItemPrompt = async (packageId: string, itemId: string, nextPrompt: string, options?: { silent?: boolean; allowEmpty?: boolean }) => {
        const promptText = nextPrompt.trim();
        if (!promptText && !options?.allowEmpty) {
            message.error("提示词不能为空");
            return;
        }
        const targetPackage = productPackageFolders.find((pkg) => pkg.id === packageId);
        const targetItem = targetPackage?.items.find((item) => item.id === itemId);
        if (!targetPackage || !targetItem) {
            if (!options?.silent) message.error("没有找到这张图");
            return;
        }
        if (productPackages.some((pkg) => pkg.id === packageId && pkg.items.some((item) => item.id === itemId))) {
            setProductPackages((value) =>
                value.map((pkg) =>
                    pkg.id === packageId
                        ? {
                              ...pkg,
                              updatedAt: Date.now(),
                              items: pkg.items.map((item) => (item.id === itemId ? { ...item, prompt: promptText } : item)),
                          }
                        : pkg,
                ),
            );
        }
        if (targetItem.logId && promptText) {
            const nextLogs = logs.map((log) => (log.id === targetItem.logId ? { ...log, prompt: promptText, title: targetItem.title || log.title } : log));
            const nextLog = nextLogs.find((log) => log.id === targetItem.logId);
            setLogs(nextLogs);
            if (nextLog) await logStore.setItem(scopedImageHistoryLogKey(nextLog.id), serializeLog(nextLog));
            await persistImageHistory(nextLogs, categories);
        }
        if (!options?.silent) message.success("提示词已更新");
    };

    const handleWorkflowTaskStarted = (task: WorkflowExternalTaskStart) => {
        setPrompt(task.prompt);
        setReferences([...(task.references || [])]);
        setWorkbenchLayout("side");
        setCollapsedSections((value) => ({ ...value, prompt: false, references: !(task.references || []).length }));
        updateConfig("model", task.model);
        updateConfig("imageModel", task.model);
        updateConfig("activeChannelId", task.config.imageChannelId || "");
        updateConfig("imageChannelId", task.config.imageChannelId || "");
        updateConfig("apiMode", task.apiMode);
        updateConfig("count", "1");
        if (task.config.quality) updateConfig("quality", task.config.quality);
        if (task.config.size) updateConfig("size", task.config.size);
        if (task.config.outputFormat) updateConfig("outputFormat", task.config.outputFormat);
        if (task.config.outputCompression) updateConfig("outputCompression", task.config.outputCompression);
        if (task.config.moderation) updateConfig("moderation", task.config.moderation);
        if (task.config.timeout) updateConfig("timeout", task.config.timeout);
        if (typeof task.config.streamImages === "boolean") updateConfig("streamImages", task.config.streamImages);
        if (task.config.streamPartialImages) updateConfig("streamPartialImages", task.config.streamPartialImages);
        if (typeof task.config.responseFormatB64Json === "boolean") updateConfig("responseFormatB64Json", task.config.responseFormatB64Json);
        if (typeof task.config.codexCli === "boolean") updateConfig("codexCli", task.config.codexCli);
        const configSnapshot = buildGenerationLogConfig({
            ...effectiveConfig,
            ...task.config,
            model: task.model,
            imageModel: task.model,
            apiMode: task.apiMode,
            count: String(task.count),
        });
        if (isProductPackageTask(task)) {
            const packageId = task.seriesRunId || `${task.workflowId}:${task.startedAt}`;
            packageTaskMapRef.current[task.taskId] = packageId;
            setProductPackages((value) => upsertProductPackageTask(value, task, configSnapshot, packageId));
            setActivePackageId(packageId);
            setResultViewMode("all");
            setActiveResultCategoryId(null);
            setNow(Date.now());
            return;
        }
        const pendingItems: GenerationResult[] = Array.from({ length: task.count }, (_, index) => ({
            id: createWorkflowResultId(task.taskId, index),
            status: "running",
            createdAt: task.startedAt,
            startedAt: task.startedAt,
            prompt: task.prompt,
            model: task.model,
            config: configSnapshot,
            references: task.references || [],
            workflowId: task.workflowId,
            workflowName: task.workflowName,
            workflowInputs: task.inputs,
            workflowTaskId: task.taskId,
        }));
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        setResults((value) => [...pendingItems, ...value]);
        setNow(Date.now());
    };

    const handleWorkflowTaskSuccess = (task: WorkflowExternalTaskSuccess) => {
        const packageId = packageTaskMapRef.current[task.taskId];
        if (packageId) {
            setProductPackages((value) =>
                value.map((pkg) => {
                    if (pkg.id !== packageId || !pkg.items.some((item) => item.taskId === task.taskId)) return pkg;
                    let imageOffset = 0;
                    const nextItems = pkg.items.map((item) => {
                        if (item.taskId !== task.taskId) return item;
                        const image = task.images[imageOffset++];
                        if (!image) return { ...item, status: "failed" as const, error: "接口没有返回图片", endedAt: task.endedAt, durationMs: task.durationMs };
                        const nextImage: GeneratedImage = {
                            id: image.id,
                            dataUrl: image.imageUrl,
                            storageKey: image.storageKey,
                            durationMs: image.durationMs || task.durationMs,
                            width: image.width,
                            height: image.height,
                            bytes: image.bytes,
                            mimeType: image.mimeType,
                        };
                        return { ...item, status: "success" as const, image: nextImage, endedAt: task.endedAt, durationMs: task.durationMs };
                    });
                    return { ...pkg, updatedAt: task.endedAt, items: nextItems };
                }),
            );
            setResultViewMode("all");
            setActiveResultCategoryId(null);
            void refreshLogs();
            return;
        }
        setResults((value) => {
            const next = [...value];
            task.images.forEach((image, index) => {
                const resultId = createWorkflowResultId(task.taskId, index);
                const existingIndex = next.findIndex((item) => item.id === resultId);
                const nextImage: GeneratedImage = {
                    id: image.id,
                    dataUrl: image.imageUrl,
                    storageKey: image.storageKey,
                    durationMs: image.durationMs || task.durationMs,
                    width: image.width,
                    height: image.height,
                    bytes: image.bytes,
                    mimeType: image.mimeType,
                };
                if (existingIndex >= 0) {
                    next[existingIndex] = { ...next[existingIndex], status: "success", image: nextImage, durationMs: task.durationMs };
                } else {
                    next.unshift({
                        id: resultId,
                        status: "success",
                        createdAt: task.endedAt,
                        prompt: image.prompt,
                        model: effectiveConfig.imageModel || effectiveConfig.model,
                        config: buildGenerationLogConfig(effectiveConfig),
                        references: [],
                        image: nextImage,
                        durationMs: task.durationMs,
                        workflowId: image.workflowId,
                        workflowName: image.workflowName,
                        workflowTaskId: task.taskId,
                    });
                }
            });
            return next;
        });
        setResultViewMode("all");
        setActiveResultCategoryId(null);
        void refreshLogs().then(() => {
            setResults((value) => value.filter((item) => item.workflowTaskId !== task.taskId));
        });
    };

    const handleWorkflowTaskFailure = (task: WorkflowExternalTaskFailure) => {
        const packageId = packageTaskMapRef.current[task.taskId];
        if (packageId) {
            setProductPackages((value) =>
                value.map((pkg) =>
                    pkg.id === packageId && pkg.items.some((item) => item.taskId === task.taskId)
                        ? {
                              ...pkg,
                              updatedAt: task.endedAt,
                              items: pkg.items.map((item) =>
                                  item.taskId === task.taskId
                                      ? {
                                            ...item,
                                            status: "failed",
                                            error: task.error,
                                            errorDetail: task.error,
                                            endedAt: task.endedAt,
                                            durationMs: task.durationMs,
                                        }
                                      : item,
                              ),
                          }
                        : pkg,
                ),
            );
            return;
        }
        setResults((value) =>
            value.map((item) =>
                item.workflowTaskId === task.taskId
                    ? {
                          ...item,
                          status: "failed",
                          error: task.error,
                          durationMs: task.durationMs,
                      }
                    : item,
            ),
        );
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className={`${workbenchLayout === "side" ? "grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]" : "relative flex flex-col"} min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:overflow-hidden`}>
                {workbenchLayout === "side" ? (
                    <>
                        {activePackage ? (
                            <PackageWorkbenchPanel
                                packageData={activePackage}
                                currentReferences={references}
                                currentLayout={workbenchLayout}
                                onLayoutChange={setWorkbenchLayout}
                                onClose={() => setActivePackageId(null)}
                                onEditWorkflow={() => openPackageWorkflowRunner(activePackage)}
                                onRemoveReference={(id) => void removeReference(id)}
                            />
                        ) : (
                            <WorkbenchPanel
                                layout="side"
                                currentLayout={workbenchLayout}
                                collapsedSections={collapsedSections}
                                prompt={prompt}
                                references={references}
                                config={effectiveConfig}
                                model={model}
                                batchMode={batchMode}
                                canGenerate={canGenerate}
                                pendingCount={pendingCount}
                                updateConfig={updateConfig}
                                onBatchModeChange={setBatchMode}
                                openConfigDialog={openConfigDialog}
                                onLayoutChange={setWorkbenchLayout}
                                onToggleSection={toggleCollapsedSection}
                                onPromptChange={setPrompt}
                                onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                                onOpenAssetPicker={() => setAssetPickerOpen(true)}
                                onPastePrompt={() => void pastePromptFromClipboard()}
                                onPromptPaste={(event) => void pasteReferenceImagesIntoPrompt(event)}
                                onClearPrompt={clearPrompt}
                                onPasteReferences={() => void addReferencesFromClipboard()}
                                onUploadReferences={() => fileInputRef.current?.click()}
                                onImportPackageFolder={() => folderInputRef.current?.click()}
                                onRemoveReference={(id) => void removeReference(id)}
                                onGenerate={() => void generate()}
                            />
                        )}
                        <ResultsPanel
                            results={results}
                            productPackages={productPackageFolders}
                            activePackageId={activePackageId}
                            logs={logs}
                            categories={categories}
                            resultViewMode={resultViewMode}
                            activeCategoryId={activeResultCategoryId}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            selectedPackageIds={selectedPackageIds}
                            selectedResultIds={selectedResultIds}
                            activeLogId={previewLog?.id}
                            linkingImageId={linkingImageId}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onSelectedPackageIdsChange={setSelectedPackageIds}
                            onSelectedResultIdsChange={setSelectedResultIds}
                            onResultViewModeChange={setResultViewMode}
                            onActiveCategoryChange={setActiveResultCategoryId}
                            onOpenPackage={setActivePackageId}
                            onClosePackage={() => setActivePackageId(null)}
                            onCreateCategory={createCategory}
                            onRenameCategory={(category, name) => void renameCategory(category, name)}
                            onDeleteCategory={deleteCategory}
                            onToggleLogCategory={(log, categoryId) => void toggleLogCategory(log, categoryId)}
                            onClearLogCategories={(log) => void updateLogCategories(log, [])}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onDeleteResult={deleteResult}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                            onRetryLog={(log) => void retryLog(log)}
                            onCopyPrompt={copyPrompt}
                            onUpdateLogPrompt={updateHistoryLogPrompt}
                            onUpdateResultPrompt={updateResultPrompt}
                            onUpdatePackageItemPrompt={(packageId, itemId, nextPrompt, options) => void updatePackageItemPrompt(packageId, itemId, nextPrompt, options)}
                            onRetryPackageItem={(packageId, itemId, promptOverride) => void retryPackageItem(packageId, itemId, promptOverride)}
                            onTogglePackageItemSelected={togglePackageItemSelected}
                            onSelectPackageItems={selectPackageItems}
                            onStartSelectedPackageItems={(packageId, group, promptOverride) => void startSelectedPackageItems(packageId, group, promptOverride)}
                            onImportPackageFolder={() => folderInputRef.current?.click()}
                            onEdit={addResultToReferences}
                            onDownload={downloadImage}
                            onDownloadPackageItem={(item) => item.image && void downloadImage(item.image, item.index - 1)}
                            onCopyImageLink={copyGeneratedImageLink}
                            onSaveAsset={saveResultToAssets}
                            onRetry={retryResult}
                        />
                    </>
                ) : (
                    <>
                        <ResultsPanel
                            className={cn("min-h-[360px] flex-1 transition-[padding-bottom]", activePackage ? "pb-4" : workbenchBottomCollapsed ? "pb-24 lg:pb-24" : "pb-[300px] lg:pb-[320px]")}
                            results={results}
                            productPackages={productPackageFolders}
                            activePackageId={activePackageId}
                            logs={logs}
                            categories={categories}
                            resultViewMode={resultViewMode}
                            activeCategoryId={activeResultCategoryId}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            selectedPackageIds={selectedPackageIds}
                            selectedResultIds={selectedResultIds}
                            activeLogId={previewLog?.id}
                            linkingImageId={linkingImageId}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onSelectedPackageIdsChange={setSelectedPackageIds}
                            onSelectedResultIdsChange={setSelectedResultIds}
                            onResultViewModeChange={setResultViewMode}
                            onActiveCategoryChange={setActiveResultCategoryId}
                            onOpenPackage={setActivePackageId}
                            onClosePackage={() => setActivePackageId(null)}
                            onCreateCategory={createCategory}
                            onRenameCategory={(category, name) => void renameCategory(category, name)}
                            onDeleteCategory={deleteCategory}
                            onToggleLogCategory={(log, categoryId) => void toggleLogCategory(log, categoryId)}
                            onClearLogCategories={(log) => void updateLogCategories(log, [])}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onDeleteResult={deleteResult}
                            onPreviewLog={(log) => void previewGenerationLog(log)}
                            onRetryLog={(log) => void retryLog(log)}
                            onCopyPrompt={copyPrompt}
                            onUpdateLogPrompt={updateHistoryLogPrompt}
                            onUpdateResultPrompt={updateResultPrompt}
                            onUpdatePackageItemPrompt={(packageId, itemId, nextPrompt, options) => void updatePackageItemPrompt(packageId, itemId, nextPrompt, options)}
                            onRetryPackageItem={(packageId, itemId, promptOverride) => void retryPackageItem(packageId, itemId, promptOverride)}
                            onTogglePackageItemSelected={togglePackageItemSelected}
                            onSelectPackageItems={selectPackageItems}
                            onStartSelectedPackageItems={(packageId, group, promptOverride) => void startSelectedPackageItems(packageId, group, promptOverride)}
                            onImportPackageFolder={() => folderInputRef.current?.click()}
                            onEdit={addResultToReferences}
                            onDownload={downloadImage}
                            onDownloadPackageItem={(item) => item.image && void downloadImage(item.image, item.index - 1)}
                            onCopyImageLink={copyGeneratedImageLink}
                            onSaveAsset={saveResultToAssets}
                            onRetry={retryResult}
                        />
                        {!activePackage ? (
                            <WorkbenchPanel
                                layout="bottom"
                                currentLayout={workbenchLayout}
                                collapsedSections={collapsedSections}
                                prompt={prompt}
                                references={references}
                                config={effectiveConfig}
                                model={model}
                                batchMode={batchMode}
                                canGenerate={canGenerate}
                                pendingCount={pendingCount}
                                updateConfig={updateConfig}
                                onBatchModeChange={setBatchMode}
                                openConfigDialog={openConfigDialog}
                                onLayoutChange={setWorkbenchLayout}
                                onToggleSection={toggleCollapsedSection}
                                onPromptChange={setPrompt}
                                onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                                onOpenAssetPicker={() => setAssetPickerOpen(true)}
                                onPastePrompt={() => void pastePromptFromClipboard()}
                                onPromptPaste={(event) => void pasteReferenceImagesIntoPrompt(event)}
                                onClearPrompt={clearPrompt}
                                onPasteReferences={() => void addReferencesFromClipboard()}
                                onUploadReferences={() => fileInputRef.current?.click()}
                                onImportPackageFolder={() => folderInputRef.current?.click()}
                                onRemoveReference={(id) => void removeReference(id)}
                                onGenerate={() => void generate()}
                                bottomCollapsed={workbenchBottomCollapsed}
                                onBottomCollapsedChange={setWorkbenchBottomCollapsed}
                            />
                        ) : null}
                    </>
                )}
            </main>
            <button
                type="button"
                className="fixed z-50 inline-flex touch-none select-none items-center gap-2 rounded-full border border-sky-300/70 bg-white/90 px-4 py-3 text-sm font-semibold text-stone-950 shadow-[0_18px_50px_rgba(14,165,233,0.28),0_8px_18px_rgba(0,0,0,0.14)] ring-1 ring-white/70 backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-sky-300 hover:bg-white hover:shadow-[0_22px_64px_rgba(14,165,233,0.36),0_10px_22px_rgba(0,0,0,0.18)] dark:border-sky-400/40 dark:bg-stone-900/88 dark:text-stone-100 dark:ring-white/10 dark:hover:bg-stone-900"
                style={{ left: workflowButtonPosition.x || defaultWorkflowButtonPosition().x, top: workflowButtonPosition.y || defaultWorkflowButtonPosition().y }}
                onPointerDown={handleWorkflowButtonPointerDown}
                onPointerMove={handleWorkflowButtonPointerMove}
                onPointerUp={handleWorkflowButtonPointerUp}
                onClick={() => {
                    if (workflowButtonDragRef.current?.moved) {
                        workflowButtonDragRef.current = null;
                        return;
                    }
                    workflowButtonDragRef.current = null;
                    setWorkflowDrawerOpen(true);
                }}
            >
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.9)]" />
                <WandSparkles className="size-4 text-sky-500 dark:text-sky-300" />
                工作流
            </button>
            <Drawer title="创作工作流" placement="right" size="min(1120px, 92vw)" open={workflowDrawerOpen} onClose={() => setWorkflowDrawerOpen(false)} styles={{ body: { padding: 0 } }} destroyOnHidden={false}>
                <CreativeWorkflowWorkspace
                    embedded
                    hideTaskList
                    runnerRequest={workflowRunnerRequest}
                    onRunnerRequestHandled={() => setWorkflowRunnerRequest(null)}
                    onWorkflowTaskStarted={handleWorkflowTaskStarted}
                    onWorkflowTaskSuccess={handleWorkflowTaskSuccess}
                    onWorkflowTaskFailure={handleWorkflowTaskFailure}
                    onWorkbenchTakeover={() => setWorkflowDrawerOpen(false)}
                    onGenerationLogSaved={() => {
                        void (async () => {
                            const nextCategories = await readStoredCategories();
                            const nextLogs = await readStoredLogs();
                            setCategories(nextCategories);
                            setLogs(nextLogs);
                            await persistImageHistory(nextLogs, nextCategories);
                        })();
                    }}
                />
            </Drawer>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <input
                ref={folderInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void importPackageFolder(event.target.files);
                    event.target.value = "";
                }}
            />
            {promptLibraryEnabled ? <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} /> : null}
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <PackageQuickStartModal
                open={packageQuickStartOpen}
                draft={packageQuickStartDraft}
                references={packageQuickStartReferences}
                hasCurrentReferences={Boolean(references.length)}
                onChange={(patch) => setPackageQuickStartDraft((value) => ({ ...value, ...patch }))}
                onUseCurrentReferences={() => setPackageQuickStartReferences(references.map((item) => ({ ...item })))}
                onRemoveReference={(id) => setPackageQuickStartReferences((value) => value.filter((item) => item.id !== id))}
                onUploadReferences={(files) => void addPackageQuickStartReferences(files)}
                onCancel={() => setPackageQuickStartOpen(false)}
                onSubmit={startPackageQuickStartDemo}
            />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedResultIds.length + selectedLogIds.length + selectedPackageIds.length} 项吗？
            </Modal>
        </div>
    );
}

const quickSizeOptions = [
    { value: "auto", label: "auto" },
    { value: "1:1", label: "1:1" },
    { value: "3:2", label: "3:2" },
    { value: "2:3", label: "2:3" },
    { value: "4:3", label: "4:3" },
    { value: "3:4", label: "3:4" },
    { value: "9:16", label: "9:16" },
    { value: "16:9", label: "16:9" },
];

const quickResolutionOptions = [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];

const quickFormatOptions = [
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
];

const quickModerationOptions = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
];

const fullImageWrapperStyle: CSSProperties = { width: "100%", height: "100%" };
const fullImageContainStyle: CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };
const thumbnailImageCoverStyle: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

function PackageWorkbenchPanel({
    packageData,
    currentReferences,
    currentLayout,
    onLayoutChange,
    onClose,
    onEditWorkflow,
    onRemoveReference,
}: {
    packageData: ProductImagePackage;
    currentReferences: ReferenceImage[];
    currentLayout: WorkbenchLayout;
    onLayoutChange: (layout: WorkbenchLayout) => void;
    onClose: () => void;
    onEditWorkflow: () => void;
    onRemoveReference: (id: string) => void;
}) {
    const stats = getVisiblePackageStats(packageData);
    const groupCounts = getVisiblePackageGroupCounts(packageData);
    const displayReferences = currentReferences.length ? currentReferences : packageData.references;
    const canEditWorkflow = packageData.workflowId !== folderPackageWorkflowId;
    const isFolderPackage = packageData.workflowId === folderPackageWorkflowId;
    return (
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:min-h-0">
            <div className="shrink-0 border-b border-stone-200 p-4 dark:border-stone-800">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                            <FileArchive className="size-4" />
                            图包工作流模板
                        </div>
                        <h1 className="mt-1 truncate text-2xl font-semibold text-stone-950 dark:text-stone-100">{packageData.productName}</h1>
                        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{packageData.workflowName}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        {canEditWorkflow ? (
                            <Button size="small" type="primary" icon={<WandSparkles className="size-3.5" />} onClick={onEditWorkflow}>
                                修改工作流
                            </Button>
                        ) : null}
                        <Button size="small" onClick={onClose}>
                            返回
                        </Button>
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {packageGroupOrder.map((group) =>
                        groupCounts[group] ? (
                            <Tag key={group} className="m-0" color={packageGroupColor(group)}>
                                {packageGroupTitle(group)} {groupCounts[group]}
                            </Tag>
                        ) : null,
                    )}
                    <Tag className="m-0">
                        {stats.success}/{stats.total} 完成
                    </Tag>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
                    <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${stats.percent}%` }} />
                </div>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <section className="rounded-lg border border-stone-200 bg-background p-3 dark:border-stone-800">
                    <div className="mb-2 text-sm font-semibold">填写信息</div>
                    <div className="space-y-2 text-xs">
                        {Object.entries(packageData.inputs)
                            .filter(([, value]) => String(value).trim())
                            .map(([key, value]) => (
                                <div key={key} className="rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                                    <div className="mb-1 text-stone-500 dark:text-stone-400">{packageInputLabel(key)}</div>
                                    <div className="whitespace-pre-wrap text-stone-800 dark:text-stone-200">{String(value)}</div>
                                </div>
                            ))}
                        {!Object.values(packageData.inputs).some((value) => String(value).trim()) ? <div className="rounded-md bg-stone-50 p-3 text-center text-stone-500 dark:bg-stone-900">暂无填写信息</div> : null}
                    </div>
                </section>
                <section className="rounded-lg border border-stone-200 bg-background p-3 dark:border-stone-800">
                    <div className="mb-2 text-sm font-semibold">参考图</div>
                    <ReferenceStrip references={displayReferences} compact onRemoveReference={displayReferences.length ? onRemoveReference : undefined} />
                </section>
                <section className="rounded-lg border border-stone-200 bg-background p-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
                    <div className="mb-2 text-sm font-semibold text-stone-800 dark:text-stone-100">模型参数</div>
                    <div className="flex flex-wrap gap-1.5">
                        <Tag className="m-0">{packageData.model}</Tag>
                        <Tag className="m-0">{packageData.config.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                        {isFolderPackage ? (
                            <Tag className="m-0">跟随参考图比例</Tag>
                        ) : (
                            <>
                                <Tag className="m-0">主/副 1:1</Tag>
                                <Tag className="m-0">详情 9:16</Tag>
                            </>
                        )}
                        <Tag className="m-0">{imageResolutionLabel(packageData.config.size || "auto")}</Tag>
                    </div>
                </section>
            </div>
            <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                <div className="flex rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                    <Button className="flex-1" size="small" type={currentLayout === "side" ? "primary" : "text"} icon={<PanelLeft className="size-3.5" />} onClick={() => onLayoutChange("side")}>
                        侧边
                    </Button>
                    <Button className="flex-1" size="small" type={currentLayout === "bottom" ? "primary" : "text"} icon={<PanelBottom className="size-3.5" />} onClick={() => onLayoutChange("bottom")}>
                        底部
                    </Button>
                </div>
            </div>
        </div>
    );
}

function WorkbenchPanel({
    layout,
    currentLayout,
    collapsedSections,
    prompt,
    references,
    config,
    model,
    batchMode,
    canGenerate,
    pendingCount,
    updateConfig,
    onBatchModeChange,
    openConfigDialog,
    onLayoutChange,
    onToggleSection,
    onPromptChange,
    onOpenPromptLibrary,
    onOpenAssetPicker,
    onPastePrompt,
    onPromptPaste,
    onClearPrompt,
    onPasteReferences,
    onUploadReferences,
    onImportPackageFolder,
    onRemoveReference,
    onGenerate,
    bottomCollapsed = false,
    onBottomCollapsedChange,
}: {
    layout: WorkbenchLayout;
    currentLayout: WorkbenchLayout;
    collapsedSections: CollapsedSections;
    prompt: string;
    references: ReferenceImage[];
    config: AiConfig;
    model: string;
    batchMode: boolean;
    canGenerate: boolean;
    pendingCount: number;
    updateConfig: UpdateAiConfig;
    onBatchModeChange: (value: boolean) => void;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    onLayoutChange: (layout: WorkbenchLayout) => void;
    onToggleSection: (section: CollapsibleSectionKey) => void;
    onPromptChange: (value: string) => void;
    onOpenPromptLibrary: () => void;
    onOpenAssetPicker: () => void;
    onPastePrompt: () => void;
    onPromptPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void | Promise<void>;
    onClearPrompt: () => void;
    onPasteReferences: () => void;
    onUploadReferences: () => void;
    onImportPackageFolder: () => void;
    onRemoveReference: (id: string) => void;
    onGenerate: () => void;
    bottomCollapsed?: boolean;
    onBottomCollapsedChange?: (collapsed: boolean) => void;
}) {
    const quickAspect = imageAspectValue(config.size || "auto");
    const quickResolution = imageResolutionValue(config.size || "auto");
    const updateQuickAspect = (value: string) => updateConfig("size", value === "auto" ? "auto" : resolveImageSizeForResolution(value, quickResolution));
    const updateQuickResolution = (value: string) => updateConfig("size", resolveImageSizeForResolution(quickAspect === "auto" ? "1:1" : quickAspect, value));

    if (layout === "bottom") {
        const toggleBottomCollapsed = (collapsed: boolean) => onBottomCollapsedChange?.(collapsed);
        if (bottomCollapsed) {
            return (
                <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-5 sm:bottom-7 sm:px-10 lg:px-16">
                    <div className="pointer-events-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white/78 px-3 py-2 shadow-[0_18px_70px_rgba(15,23,42,.22),0_6px_18px_rgba(15,23,42,.10)] backdrop-blur-2xl dark:border-stone-800 dark:bg-stone-950/72 dark:shadow-[0_24px_80px_rgba(0,0,0,.55)]">
                        <button
                            type="button"
                            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-700 transition hover:border-sky-300 hover:text-sky-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-200"
                            title="展开工作台"
                            onClick={() => toggleBottomCollapsed(false)}
                        >
                            <ChevronUp className="size-4" />
                        </button>
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleBottomCollapsed(false)}>
                            <div className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{prompt.trim() || "生图工作台"}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <span>{references.length ? `${references.length} 张参考图` : "暂无参考图"}</span>
                                <span>{imageSizeLabel(config.size || "auto")}</span>
                                {pendingCount ? <span>{pendingCount} 生成中</span> : null}
                            </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-2">
                            <Button title="上传参考图" icon={<Upload className="size-4" />} onClick={onUploadReferences} />
                            <Button title="导入套图文件夹" icon={<FileArchive className="size-4" />} onClick={onImportPackageFolder} />
                            <Button type="primary" className="rounded-xl" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                {pendingCount ? "生成中" : "开始"}
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }
        return (
            <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-5 sm:bottom-7 sm:px-10 lg:px-16">
                <div className="pointer-events-auto relative w-full max-w-5xl rounded-[24px] bg-white/65 p-4 shadow-[0_32px_100px_rgba(15,23,42,.22),0_10px_34px_rgba(15,23,42,.10)] ring-1 ring-white/50 backdrop-blur-2xl dark:bg-stone-950/60 dark:ring-white/10 dark:shadow-[0_34px_110px_rgba(0,0,0,.58)]">
                    <button
                        type="button"
                        className="absolute left-1/2 top-0 z-10 inline-flex h-8 w-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-stone-200 bg-white/95 text-stone-600 shadow-lg transition hover:border-sky-300 hover:text-sky-500 dark:border-stone-800 dark:bg-stone-900/95 dark:text-stone-200"
                        title="隐藏工作台"
                        onClick={() => toggleBottomCollapsed(true)}
                    >
                        <ChevronDown className="size-4" />
                    </button>
                    <div className="flex flex-col gap-3">
                        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                            <PromptMentionsInput
                                value={prompt}
                                references={references}
                                placeholder="描述你想生成的图片，可直接粘贴截图，并用 @图片1 指定参考图..."
                                autoSize={{ minRows: 2, maxRows: 4 }}
                                className="rounded-2xl"
                                canGenerate={canGenerate}
                                onChange={onPromptChange}
                                onPaste={onPromptPaste}
                                onGenerate={onGenerate}
                            />
                            <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                <Button title="清空输入" icon={<Trash2 className="size-4" />} onClick={onClearPrompt} />
                                {promptLibraryEnabled ? <Button title="提示词库" icon={<BookOpen className="size-4" />} onClick={onOpenPromptLibrary} /> : null}
                                <Button title="我的素材" icon={<FolderPlus className="size-4" />} onClick={onOpenAssetPicker} />
                                <Button title="导入套图文件夹" icon={<FileArchive className="size-4" />} onClick={onImportPackageFolder} />
                                <Button title="切换到侧边工作台" icon={<PanelLeft className="size-4" />} onClick={() => onLayoutChange("side")} />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[1.15fr_1fr_1fr_0.95fr_0.9fr_0.9fr_auto_auto]">
                            <QuickSelect label="尺寸" value={quickAspect} options={quickSizeOptions} onChange={updateQuickAspect} />
                            <QuickSelect label="分辨率" value={quickResolution} options={quickResolutionOptions} onChange={updateQuickResolution} />
                            <QuickSelect label="格式" value={config.outputFormat || "png"} options={quickFormatOptions} onChange={(value) => updateConfig("outputFormat", value as AiConfig["outputFormat"])} />
                            <QuickBatchToggle checked={batchMode} referenceCount={references.length} count={Math.max(1, Math.min(10, Number(config.count) || 1))} onChange={onBatchModeChange} />
                            <QuickSelect label="审核" value={config.moderation || "auto"} options={quickModerationOptions} onChange={(value) => updateConfig("moderation", value as AiConfig["moderation"])} />
                            <QuickNumber label="数量" value={config.count || "1"} min={1} max={10} onChange={(value) => updateConfig("count", value)} />
                            <ReferenceQuickActions references={references} onUploadReferences={onUploadReferences} />
                            <Button type="primary" className="h-11 min-w-28 rounded-xl" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                            </Button>
                        </div>
                        {references.length ? <ReferenceStrip className="mt-3" references={references} compact onRemoveReference={onRemoveReference} /> : null}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:min-h-0">
            <div className="shrink-0 p-4 pb-3">
                <WorkbenchHeader currentLayout={currentLayout} onLayoutChange={onLayoutChange} />
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
                <CollapsibleWorkbenchSection title="提示词" collapsed={collapsedSections.prompt} summary={prompt.trim() || "未填写提示词"} onToggle={() => onToggleSection("prompt")}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPastePrompt}>
                                读取剪贴板
                            </Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={onClearPrompt}>
                                清空
                            </Button>
                            {promptLibraryEnabled ? (
                                <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={onOpenPromptLibrary}>
                                    查看提示词库
                                </Button>
                            ) : null}
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onOpenAssetPicker}>
                                查看我的素材
                            </Button>
                            <Button size="small" icon={<FileArchive className="size-3.5" />} onClick={onImportPackageFolder}>
                                导入套图文件夹
                            </Button>
                        </div>
                        <PromptMentionsInput
                            value={prompt}
                            references={references}
                            rows={6}
                            placeholder="描述画面主体、风格、构图、光线和用途，可直接粘贴截图，并用 @图片1 引用参考图"
                            canGenerate={canGenerate}
                            onChange={onPromptChange}
                            onPaste={onPromptPaste}
                            onGenerate={onGenerate}
                        />
                    </div>
                </CollapsibleWorkbenchSection>

                <CollapsibleWorkbenchSection
                    title="参考图"
                    count={references.length}
                    collapsed={collapsedSections.references}
                    summary={references.length ? `已选择 ${references.length} 张参考图` : "暂无参考图"}
                    onToggle={() => onToggleSection("references")}
                >
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPasteReferences}>
                                剪切板
                            </Button>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={onUploadReferences}>
                                上传
                            </Button>
                        </div>
                        <ReferenceStrip references={references} onRemoveReference={onRemoveReference} />
                    </div>
                </CollapsibleWorkbenchSection>

                <CollapsibleWorkbenchSection title="参数" collapsed={collapsedSections.settings} summary={settingsSummary(config, model)} onToggle={() => onToggleSection("settings")}>
                    <div className="space-y-3">
                        <GenerationSettings config={config} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                    </div>
                </CollapsibleWorkbenchSection>
            </div>
            <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                    {pendingCount ? `继续提交（${pendingCount} 个生成中）` : "开始生成"}
                </Button>
            </div>
        </div>
    );
}

function WorkbenchHeader({ currentLayout, onLayoutChange, compact = false }: { currentLayout: WorkbenchLayout; onLayoutChange: (layout: WorkbenchLayout) => void; compact?: boolean }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
                <h1 className={`${compact ? "text-base" : "text-2xl"} font-semibold text-stone-950 dark:text-stone-100`}>生图工作台</h1>
            </div>
            <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                <Button size="small" type={currentLayout === "side" ? "primary" : "text"} icon={<PanelLeft className="size-3.5" />} onClick={() => onLayoutChange("side")}>
                    侧边
                </Button>
                <Button size="small" type={currentLayout === "bottom" ? "primary" : "text"} icon={<PanelBottom className="size-3.5" />} onClick={() => onLayoutChange("bottom")}>
                    底部
                </Button>
            </div>
        </div>
    );
}

function CollapsibleWorkbenchSection({ title, count, collapsed, summary, children, onToggle }: { title: string; count?: number; collapsed: boolean; summary: string; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={onToggle}>
                <span className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold">{title}</span>
                    {typeof count === "number" ? <Tag className="m-0 text-xs">{count}</Tag> : null}
                    {collapsed ? <span className="truncate text-xs text-stone-500 dark:text-stone-400">{summary}</span> : null}
                </span>
                {collapsed ? <ChevronDown className="size-4 shrink-0 text-stone-400" /> : <ChevronUp className="size-4 shrink-0 text-stone-400" />}
            </button>
            {!collapsed ? <div className="border-t border-stone-200 p-3 dark:border-stone-800">{children}</div> : null}
        </section>
    );
}

function ReferenceStrip({ references, compact = false, className = "", onRemoveReference }: { references: ReferenceImage[]; compact?: boolean; className?: string; onRemoveReference?: (id: string) => void }) {
    return (
        <div
            className={`hover-scrollbar hover-scrollbar-hint flex w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 overscroll-x-contain dark:border-stone-700 ${compact ? "min-h-14" : "min-h-24 pb-3"} ${className}`}
            onWheel={(event) => {
                if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                event.preventDefault();
                event.currentTarget.scrollLeft += event.deltaY;
            }}
        >
            {references.map((item, index) => (
                <div key={item.id} className={`${compact ? "size-12" : "size-20"} group relative shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800`}>
                    <Image src={item.dataUrl} alt={item.name} preview={{ mask: null }} wrapperStyle={fullImageWrapperStyle} style={thumbnailImageCoverStyle} />
                    <div className="absolute bottom-1 left-1 rounded bg-black/65 px-1 py-0.5 text-[10px] leading-none text-white">{referenceAlias(index)}</div>
                    {onRemoveReference ? (
                        <button type="button" className="absolute right-1 top-1 z-20 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => onRemoveReference(item.id)} aria-label="移除参考图">
                            <Trash2 className="size-3.5" />
                        </button>
                    ) : null}
                </div>
            ))}
            {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
        </div>
    );
}

function ReferenceQuickActions({ references, onUploadReferences }: { references: ReferenceImage[]; onUploadReferences: () => void }) {
    return (
        <div className="flex h-11 items-center gap-1 rounded-xl border border-stone-200 bg-background px-2 dark:border-stone-800">
            {references[0] ? <img src={references[0].dataUrl} alt={references[0].name} className="size-7 rounded object-cover" /> : null}
            {references.length ? <span className="min-w-7 text-xs text-stone-500">{references.length} 张</span> : null}
            <Button size="small" type="text" icon={<Upload className="size-3.5" />} onClick={onUploadReferences} />
        </div>
    );
}

function PromptMentionsInput({
    value,
    references,
    placeholder,
    rows,
    autoSize,
    className,
    canGenerate,
    onChange,
    onPaste,
    onGenerate,
}: {
    value: string;
    references: ReferenceImage[];
    placeholder: string;
    rows?: number;
    autoSize?: { minRows?: number; maxRows?: number };
    className?: string;
    canGenerate: boolean;
    onChange: (value: string) => void;
    onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void | Promise<void>;
    onGenerate: () => void;
}) {
    const mentionOptions = references.map((item, index) => ({
        value: referenceAlias(index),
        label: (
            <div className="flex items-center gap-2 py-1">
                <img src={item.dataUrl} alt={item.name || referenceAlias(index)} className="size-9 rounded object-cover" />
                <div className="min-w-0">
                    <div className="text-sm font-medium leading-5">{referenceAlias(index)}</div>
                    <div className="truncate text-xs leading-5 text-stone-500">{item.name || "参考图"}</div>
                </div>
            </div>
        ),
    }));

    return (
        <Mentions
            value={value}
            rows={rows}
            autoSize={autoSize}
            className={className}
            prefix={["@"]}
            options={mentionOptions}
            placeholder={placeholder}
            notFoundContent={references.length ? "没有匹配的参考图" : "先粘贴或上传参考图"}
            onChange={onChange}
            onPaste={(event) => void onPaste(event as ReactClipboardEvent<HTMLTextAreaElement>)}
            onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && canGenerate) {
                    event.preventDefault();
                    onGenerate();
                }
            }}
        />
    );
}

function extractClipboardImageFiles(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const itemFiles = Array.from(event.clipboardData.items || [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
    return itemFiles.length ? itemFiles : Array.from(event.clipboardData.files || []).filter((file) => file.type.startsWith("image/"));
}

function parseFolderPackageFiles(files: File[]): ParsedFolderPackage {
    if (!files.length) throw new Error("请选择一个套图参考文件夹");
    const imageFiles = files.filter(isImageFile);
    if (!imageFiles.length) throw new Error("文件夹里没有可用图片");
    const rootedFiles = imageFiles
        .map((file) => ({
            file,
            parts: fileRelativePath(file)
                .split(/[\\/]+/)
                .filter(Boolean),
        }))
        .filter((item) => item.parts.length >= 2);
    if (!rootedFiles.length) throw new Error("请选择文件夹，不要只选择散图");
    const rootName = rootedFiles[0]?.parts[0] || "套图参考";
    const rootImages = rootedFiles.filter((item) => item.parts.length === 2);
    if (!rootImages.length) throw new Error("请在总文件夹根目录放入透明图");
    const transparent = rootImages.find((item) => /透明|透图|产品|主体/i.test(item.parts[item.parts.length - 1])) || rootImages[0];
    const items = rootedFiles
        .filter((item) => item.parts.length >= 3 && item.file !== transparent.file)
        .map((item) => {
            const folderName = item.parts[1] || "其他参考";
            return {
                file: item.file,
                group: resolveFolderPackageGroup(folderName),
                folderName,
                fileName: item.parts[item.parts.length - 1] || item.file.name,
            };
        })
        .sort(sortParsedFolderPackageItems);
    if (!items.length) throw new Error("请在参考子文件夹中放入图片，例如：参考主图、参考详情图、参考SKU");
    return { rootName, transparentFile: transparent.file, items, skippedCount: files.length - imageFiles.length };
}

function isImageFile(file: File) {
    return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
}

function fileRelativePath(file: File) {
    return file.webkitRelativePath || file.name;
}

function resolveFolderPackageGroup(folderName: string): ProductPackageGroup {
    const text = folderName.toLowerCase();
    if (/主图|main/.test(text)) return "main";
    if (/副图|sub/.test(text)) return "sub";
    if (/详情|detail/.test(text)) return "detail";
    if (/sku|规格|款式|变体/.test(text)) return "sku";
    return "other";
}

function sortParsedFolderPackageItems(a: ParsedFolderPackageItem, b: ParsedFolderPackageItem) {
    const groupDiff = packageGroupOrder.indexOf(a.group) - packageGroupOrder.indexOf(b.group);
    if (groupDiff) return groupDiff;
    const folderDiff = a.folderName.localeCompare(b.folderName, "zh-CN", { numeric: true });
    if (folderDiff) return folderDiff;
    return a.fileName.localeCompare(b.fileName, "zh-CN", { numeric: true });
}

function folderPackageGroupCounts(items: ParsedFolderPackageItem[]) {
    return packageGroupOrder.reduce(
        (counts, group) => {
            counts[group] = items.filter((item) => item.group === group).length;
            return counts;
        },
        { main: 0, sub: 0, detail: 0, sku: 0, other: 0 } as Record<ProductPackageGroup, number>,
    );
}

async function uploadReferenceFile(file: File, folderName?: string): Promise<ReferenceImage> {
    const image = await uploadImage(file);
    return {
        id: nanoid(),
        name: folderName ? `${folderName}/${file.name}` : file.name,
        type: image.mimeType,
        dataUrl: image.url,
        storageKey: image.storageKey,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        source: "upload",
        temporary: true,
    };
}

function packageItemRequestConfig(baseConfig: AiConfig, model: string, itemConfig: GenerationLogConfig): AiConfig {
    return {
        ...baseConfig,
        model,
        imageModel: model,
        activeChannelId: baseConfig.imageChannelId,
        count: "1",
        quality: itemConfig.quality || baseConfig.quality,
        size: itemConfig.size || baseConfig.size,
        apiMode: itemConfig.apiMode || baseConfig.apiMode,
        outputFormat: itemConfig.outputFormat || baseConfig.outputFormat,
        outputCompression: itemConfig.outputCompression || baseConfig.outputCompression,
        moderation: itemConfig.moderation || baseConfig.moderation,
        timeout: itemConfig.timeout || baseConfig.timeout,
        streamImages: typeof itemConfig.streamImages === "boolean" ? itemConfig.streamImages : baseConfig.streamImages,
        streamPartialImages: itemConfig.streamPartialImages || baseConfig.streamPartialImages,
        responseFormatB64Json: typeof itemConfig.responseFormatB64Json === "boolean" ? itemConfig.responseFormatB64Json : baseConfig.responseFormatB64Json,
        codexCli: typeof itemConfig.codexCli === "boolean" ? itemConfig.codexCli : baseConfig.codexCli,
    };
}

function referenceAlias(index: number) {
    return `图片${index + 1}`;
}

function resolvePromptReferences(promptText: string, referenceItems: ReferenceImage[]) {
    const mentionPattern = /@图片([0-9]+|[一二三四五六七八九十两]+)/g;
    const matches = [...promptText.matchAll(mentionPattern)];
    if (!matches.length) {
        return { requestText: promptText, references: [...referenceItems] };
    }

    const pickedReferences: ReferenceImage[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
        const targetIndex = parseReferenceMentionIndex(match[1]);
        if (!targetIndex || targetIndex < 1 || targetIndex > referenceItems.length) {
            return { requestText: "", references: [] as ReferenceImage[], error: `没有找到 @图片${match[1]} 对应的参考图` };
        }
        const reference = referenceItems[targetIndex - 1];
        if (!reference || seen.has(reference.id)) continue;
        seen.add(reference.id);
        pickedReferences.push(reference);
    }

    return {
        requestText: promptText
            .replace(mentionPattern, "")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        references: pickedReferences,
    };
}

function parseReferenceMentionIndex(value: string) {
    const text = value.trim();
    if (/^\d+$/.test(text)) return Number(text);
    if (text === "十") return 10;
    const numerals: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (text.startsWith("十")) {
        const tail = text.slice(1);
        return 10 + (numerals[tail] || 0);
    }
    if (text.endsWith("十")) {
        const head = numerals[text.slice(0, -1)] || 0;
        return head * 10;
    }
    if (text.includes("十")) {
        const [headText, tailText] = text.split("十");
        const head = numerals[headText] || 0;
        const tail = numerals[tailText] || 0;
        return head * 10 + tail;
    }
    return numerals[text] || null;
}

function QuickSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            {label}
            <select className="h-11 min-w-0 rounded-xl border border-stone-200 bg-background px-3 text-sm text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" value={value} onChange={(event) => onChange(event.target.value)}>
                {options.map((item) => (
                    <option key={item.value} value={item.value}>
                        {item.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

function QuickNumber({ label, value, min, max, disabled, onChange }: { label: string; value: string; min: number; max: number; disabled?: boolean; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            {label}
            <input
                className="h-11 min-w-0 rounded-xl border border-stone-200 bg-background px-3 text-sm text-stone-900 outline-none disabled:opacity-50 dark:border-stone-800 dark:text-stone-100"
                type="number"
                min={min}
                max={max}
                disabled={disabled}
                value={value}
                onChange={(event) => onChange(String(Math.max(min, Math.min(max, Number(event.target.value) || min))))}
            />
        </label>
    );
}

function QuickBatchToggle({ checked, referenceCount, count, onChange }: { checked: boolean; referenceCount: number; count: number; onChange: (value: boolean) => void }) {
    const active = checked && referenceCount > 1;
    const summary = active ? `${referenceCount} 图 × ${count} 张 = ${referenceCount * count} 结果` : checked ? "待多图" : "关闭";
    const title = active ? `批量模式：${summary}，每张图跟随自身宽高比` : checked ? "批量模式已开，上传多张参考图后会拆成独立任务并跟随参考图比例" : "批量模式关闭";

    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            批量
            <button
                type="button"
                aria-pressed={checked}
                title={title}
                className={cn(
                    "flex h-11 min-w-0 items-center gap-2 rounded-xl border px-3 text-left text-sm outline-none transition",
                    checked ? "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100" : "border-stone-200 bg-background text-stone-900 dark:border-stone-800 dark:text-stone-100",
                )}
                onClick={() => onChange(!checked)}
            >
                <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", checked ? "bg-sky-600 text-white" : "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300")}>
                    {checked ? "开" : "关"}
                </span>
                <span className="min-w-0 truncate">{summary}</span>
            </button>
        </label>
    );
}

function settingsSummary(config: AiConfig, model: string) {
    return [
        model,
        imageSizeLabel(config.size || "auto"),
        imageResolutionLabel(config.size || "auto"),
        imageFormatLabel(config.outputFormat || "png"),
        `压缩 ${config.outputCompression || "100"}`,
        `审核 ${config.moderation || "auto"}`,
        `${config.count || "1"} 张`,
        `${config.timeout || "600"}s`,
        config.streamImages ? `流式 ${config.streamPartialImages || "1"}` : "非流式",
    ].join(" · ");
}

function PackageQuickStartModal({
    open,
    draft,
    references,
    hasCurrentReferences,
    onChange,
    onUseCurrentReferences,
    onRemoveReference,
    onUploadReferences,
    onCancel,
    onSubmit,
}: {
    open: boolean;
    draft: PackageQuickStartDraft;
    references: ReferenceImage[];
    hasCurrentReferences: boolean;
    onChange: (patch: Partial<PackageQuickStartDraft>) => void;
    onUseCurrentReferences: () => void;
    onRemoveReference: (id: string) => void;
    onUploadReferences: (files?: FileList | null) => void;
    onCancel: () => void;
    onSubmit: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    return (
        <Modal title="小白图包 Demo" open={open} width={880} onCancel={onCancel} onOk={onSubmit} okText="开始并跳到结果页" cancelText="取消" okButtonProps={{ disabled: !draft.productName.trim() }} destroyOnHidden={false}>
            <div className="space-y-4">
                <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100">
                    <div className="font-medium">这个 Demo 先看流程，不改你现在的主逻辑。</div>
                    <div className="mt-1 text-xs text-sky-800 dark:text-sky-200">填好信息后，会直接创建一个图包文件夹，然后跳到结果页，里面按主图 / 副图 / 详情图拆好 16 张。</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <Tag className="m-0" color="blue">
                            主图 1
                        </Tag>
                        <Tag className="m-0" color="cyan">
                            副图 4
                        </Tag>
                        <Tag className="m-0" color="purple">
                            详情图 11
                        </Tag>
                    </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1">
                        <div className="text-sm font-medium">产品名称</div>
                        <Input value={draft.productName} placeholder="例如：维生素C咀嚼片" onChange={(event) => onChange({ productName: event.target.value })} />
                    </label>
                    <label className="space-y-1">
                        <div className="text-sm font-medium">产品类型</div>
                        <Input value={draft.productType} placeholder="例如：保健品 / 消字号喷剂" onChange={(event) => onChange({ productType: event.target.value })} />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                        <div className="text-sm font-medium">核心卖点</div>
                        <Input.TextArea value={draft.sellingPoints} autoSize={{ minRows: 3, maxRows: 6 }} placeholder="例如：补充VC、清爽口感、便携小瓶、适合日常保养" onChange={(event) => onChange({ sellingPoints: event.target.value })} />
                    </label>
                    <label className="space-y-1">
                        <div className="text-sm font-medium">规格信息</div>
                        <Input value={draft.specs} placeholder="例如：60片 / 0.8g*30袋" onChange={(event) => onChange({ specs: event.target.value })} />
                    </label>
                    <label className="space-y-1">
                        <div className="text-sm font-medium">适用人群</div>
                        <Input value={draft.targetPeople} placeholder="例如：熬夜党 / 上班族 / 家庭常备" onChange={(event) => onChange({ targetPeople: event.target.value })} />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                        <div className="text-sm font-medium">视觉风格</div>
                        <Input.TextArea value={draft.style} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="例如：高级感商业摄影、干净白底、健康护理电商风格" onChange={(event) => onChange({ style: event.target.value })} />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                        <div className="text-sm font-medium">补充要求</div>
                        <Input.TextArea value={draft.notes} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="例如：避免夸大承诺，不要医生形象，不要药品感" onChange={(event) => onChange({ notes: event.target.value })} />
                    </label>
                </div>
                <section className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900/60">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <div className="text-sm font-medium">产品图</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">这里放白底图或包装图，Demo 会拿它做图包封面和提示词参考。</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {hasCurrentReferences ? (
                                <Button size="small" onClick={onUseCurrentReferences}>
                                    使用当前参考图
                                </Button>
                            ) : null}
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                上传产品图
                            </Button>
                        </div>
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            void onUploadReferences(event.target.files);
                            event.target.value = "";
                        }}
                    />
                    <ReferenceStrip references={references} compact onRemoveReference={onRemoveReference} />
                </section>
            </div>
        </Modal>
    );
}

function ResultsPanel({
    className = "",
    results,
    productPackages,
    activePackageId,
    logs,
    categories,
    resultViewMode,
    activeCategoryId,
    pendingCount,
    now,
    selectedLogIds,
    selectedPackageIds,
    selectedResultIds,
    activeLogId,
    linkingImageId,
    onSelectedLogIdsChange,
    onSelectedPackageIdsChange,
    onSelectedResultIdsChange,
    onResultViewModeChange,
    onActiveCategoryChange,
    onOpenPackage,
    onClosePackage,
    onCreateCategory,
    onRenameCategory,
    onDeleteCategory,
    onToggleLogCategory,
    onClearLogCategories,
    onDeleteSelected,
    onDeleteLog,
    onDeleteResult,
    onPreviewLog,
    onRetryLog,
    onCopyPrompt,
    onUpdateLogPrompt,
    onUpdateResultPrompt,
    onUpdatePackageItemPrompt,
    onRetryPackageItem,
    onTogglePackageItemSelected,
    onSelectPackageItems,
    onStartSelectedPackageItems,
    onImportPackageFolder,
    onEdit,
    onDownload,
    onDownloadPackageItem,
    onCopyImageLink,
    onSaveAsset,
    onRetry,
}: {
    className?: string;
    results: GenerationResult[];
    productPackages: ProductImagePackage[];
    activePackageId: string | null;
    logs: GenerationLog[];
    categories: GenerationCategory[];
    resultViewMode: ResultViewMode;
    activeCategoryId: string | null;
    pendingCount: number;
    now: number;
    selectedLogIds: string[];
    selectedPackageIds: string[];
    selectedResultIds: string[];
    activeLogId?: string;
    linkingImageId: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onSelectedPackageIdsChange: (ids: string[]) => void;
    onSelectedResultIdsChange: (ids: string[]) => void;
    onResultViewModeChange: (mode: ResultViewMode) => void;
    onActiveCategoryChange: (id: string | null) => void;
    onOpenPackage: (id: string) => void;
    onClosePackage: () => void;
    onCreateCategory: (name: string) => Promise<GenerationCategory | null>;
    onRenameCategory: (category: GenerationCategory, name: string) => void;
    onDeleteCategory: (category: GenerationCategory) => void;
    onToggleLogCategory: (log: GenerationLog, categoryId: string) => void;
    onClearLogCategories: (log: GenerationLog) => void;
    onDeleteSelected: () => void;
    onDeleteLog: (log: GenerationLog) => void;
    onDeleteResult: (result: GenerationResult) => void;
    onPreviewLog: (log: GenerationLog) => void;
    onRetryLog: (log: GenerationLog) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onUpdateLogPrompt: (log: GenerationLog, prompt: string) => boolean | Promise<boolean>;
    onUpdateResultPrompt: (resultId: string, prompt: string) => boolean;
    onUpdatePackageItemPrompt: (packageId: string, itemId: string, prompt: string, options?: { silent?: boolean; allowEmpty?: boolean }) => void | Promise<void>;
    onRetryPackageItem: (packageId: string, itemId: string, promptOverride?: string) => void | Promise<void>;
    onTogglePackageItemSelected: (packageId: string, itemId: string, checked: boolean) => void;
    onSelectPackageItems: (packageId: string, group: ProductPackageGroup | "all", checked: boolean) => void;
    onStartSelectedPackageItems: (packageId: string, group?: ProductPackageGroup | "all", promptOverride?: string) => void | Promise<void>;
    onImportPackageFolder: () => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onDownloadPackageItem: (item: ProductPackageItem) => void;
    onCopyImageLink: (image: GeneratedImage, index: number) => void | Promise<void>;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onRetry: (result: GenerationResult) => void;
}) {
    const packageLogIds = new Set(productPackages.flatMap((pkg) => pkg.items.map((item) => item.logId).filter((id): id is string => Boolean(id))));
    const allLogIds = new Set(logs.map((log) => log.id));
    const baseVisibleLogs = logs.filter((log) => !packageLogIds.has(log.id));
    const baseLogVersionGroups = buildLogVersionGroups(baseVisibleLogs);
    const anchoredRetryResults = results.filter((result) => (result.status === "waiting" || result.status === "running") && (result.versionGroupId || (result.logId && allLogIds.has(result.logId))));
    const anchoredRetryResultIds = new Set(anchoredRetryResults.map((result) => result.id));
    const retryResultByVersionGroup = new Map<string, GenerationResult>();
    anchoredRetryResults.forEach((result) => retryResultByVersionGroup.set(resolveResultVersionGroupId(result), result));
    const standaloneResults = results.filter((result) => !anchoredRetryResultIds.has(result.id) && (!result.logId || !allLogIds.has(result.logId)));
    const visiblePackages = resultViewMode === "all" ? productPackages : [];
    const categoryGroups = categories.map((category) => ({ category, logs: latestLogsByVersionGroup(baseVisibleLogs.filter((log) => log.categoryIds.includes(category.id))) }));
    const activeCategory = activeCategoryId ? categories.find((category) => category.id === activeCategoryId) : null;
    const activePackage = activePackageId ? productPackages.find((item) => item.id === activePackageId) || null : null;
    const rawVisibleLogs = resultViewMode === "category" ? (activeCategoryId ? baseVisibleLogs.filter((log) => log.categoryIds.includes(activeCategoryId)) : baseVisibleLogs.filter((log) => !log.categoryIds.length)) : baseVisibleLogs;
    const visibleLogs = latestLogsByVersionGroup(rawVisibleLogs);
    const visiblePackageCount = visiblePackages.length;
    const totalCount = activePackage ? activePackage.items.length : visiblePackageCount + standaloneResults.length + (resultViewMode === "category" ? (activeCategoryId ? visibleLogs.length : categories.length + visibleLogs.length) : visibleLogs.length);
    const shouldShowGrid = totalCount > 0;
    const allVisibleResultsSelected = Boolean(standaloneResults.length) && standaloneResults.every((result) => selectedResultIds.includes(result.id));
    const allVisibleLogsSelected = Boolean(visibleLogs.length) && visibleLogs.every((log) => selectedLogIds.includes(log.id));
    const allVisiblePackagesSelected = Boolean(visiblePackages.length) && visiblePackages.every((pkg) => selectedPackageIds.includes(pkg.id));
    const hasSelectableItems = Boolean(standaloneResults.length || visibleLogs.length || visiblePackages.length);
    const allVisibleItemsSelected = hasSelectableItems && (!standaloneResults.length || allVisibleResultsSelected) && (!visibleLogs.length || allVisibleLogsSelected) && (!visiblePackages.length || allVisiblePackagesSelected);
    const toggleVisibleItems = () => {
        if (allVisibleItemsSelected) {
            onSelectedResultIdsChange(selectedResultIds.filter((id) => !standaloneResults.some((result) => result.id === id)));
            onSelectedLogIdsChange(selectedLogIds.filter((id) => !visibleLogs.some((log) => log.id === id)));
            onSelectedPackageIdsChange(selectedPackageIds.filter((id) => !visiblePackages.some((pkg) => pkg.id === id)));
            return;
        }
        onSelectedResultIdsChange(Array.from(new Set([...selectedResultIds, ...standaloneResults.map((result) => result.id)])));
        onSelectedLogIdsChange(Array.from(new Set([...selectedLogIds, ...visibleLogs.map((log) => log.id)])));
        onSelectedPackageIdsChange(Array.from(new Set([...selectedPackageIds, ...visiblePackages.map((pkg) => pkg.id)])));
    };
    const renderResultCard = (result: GenerationResult, index: number) => {
        const selected = selectedResultIds.includes(result.id);
        const onSelectedChange = (checked: boolean) => onSelectedResultIdsChange(checked ? Array.from(new Set([...selectedResultIds, result.id])) : selectedResultIds.filter((id) => id !== result.id));
        const onDelete = () => onDeleteResult(result);
        return result.status === "success" && result.image ? (
            <ResultImageCard
                key={result.id}
                result={result}
                image={result.image}
                index={index}
                selected={selected}
                onSelectedChange={onSelectedChange}
                onDelete={onDelete}
                onCopyPrompt={onCopyPrompt}
                onUpdatePrompt={onUpdateResultPrompt}
                onRetry={() => onRetry(result)}
                onEdit={onEdit}
                onDownload={onDownload}
                onCopyLink={onCopyImageLink}
                onSaveAsset={onSaveAsset}
                linking={linkingImageId === result.image.id}
            />
        ) : result.status === "failed" ? (
            <FailedImageCard key={result.id} result={result} error={result.error || "生成失败"} selected={selected} onSelectedChange={onSelectedChange} onDelete={onDelete} onCopyPrompt={onCopyPrompt} onRetry={() => onRetry(result)} />
        ) : (
            <PendingImageCard key={result.id} result={result} now={now} selected={selected} onSelectedChange={onSelectedChange} onDelete={onDelete} onCopyPrompt={onCopyPrompt} />
        );
    };

    useEffect(() => {
        if (activeCategoryId && !categories.some((category) => category.id === activeCategoryId)) onActiveCategoryChange(null);
    }, [activeCategoryId, categories, onActiveCategoryChange]);

    if (activePackage) {
        return (
            <PackageResultsPanel
                className={className}
                packageData={activePackage}
                logs={logs}
                now={now}
                onBack={onClosePackage}
                onCopyPrompt={onCopyPrompt}
                onPreviewLog={onPreviewLog}
                onUpdatePrompt={(itemId, prompt, options) => onUpdatePackageItemPrompt(activePackage.id, itemId, prompt, options)}
                onRetryItem={(itemId, promptOverride) => onRetryPackageItem(activePackage.id, itemId, promptOverride)}
                onToggleItemSelected={(itemId, checked) => onTogglePackageItemSelected(activePackage.id, itemId, checked)}
                onSelectItems={(group, checked) => onSelectPackageItems(activePackage.id, group, checked)}
                onStartSelected={(group, promptOverride) => onStartSelectedPackageItems(activePackage.id, group, promptOverride)}
                onImportPackageFolder={onImportPackageFolder}
                onDownloadPackageItem={onDownloadPackageItem}
                onDownloadImage={onDownload}
                linkingImageId={linkingImageId}
                onCopyImageLink={onCopyImageLink}
                onSaveAsset={onSaveAsset}
                onEdit={onEdit}
            />
        );
    }

    return (
        <div className={`thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5 ${className}`}>
            <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <History className="size-4 text-stone-400" />
                    <h2 className="truncate text-xl font-semibold">{activeCategory ? activeCategory.name : "全部结果"}</h2>
                    <Tag className="m-0">{totalCount}</Tag>
                    {pendingCount ? <Tag className="m-0 px-2 py-1">{pendingCount} 个生成中</Tag> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {activeCategory ? (
                        <Button size="small" onClick={() => onActiveCategoryChange(null)}>
                            返回分类
                        </Button>
                    ) : null}
                    <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                        <Button
                            size="small"
                            type={resultViewMode === "all" ? "primary" : "text"}
                            onClick={() => {
                                onActiveCategoryChange(null);
                                onResultViewModeChange("all");
                            }}
                        >
                            全部展示
                        </Button>
                        <Button size="small" type={resultViewMode === "category" ? "primary" : "text"} onClick={() => onResultViewModeChange("category")}>
                            分类展示
                        </Button>
                    </div>
                    <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!hasSelectableItems} onClick={toggleVisibleItems}>
                        {allVisibleItemsSelected ? "取消" : "全选"}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedResultIds.length && !selectedLogIds.length && !selectedPackageIds.length} onClick={onDeleteSelected}>
                        删除
                    </Button>
                </div>
            </div>
            {shouldShowGrid ? (
                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {resultViewMode === "all"
                        ? productPackages.map((packageData) => (
                              <ProductPackageFolderCard
                                  key={packageData.id}
                                  packageData={packageData}
                                  selected={selectedPackageIds.includes(packageData.id)}
                                  onSelectedChange={(checked) => onSelectedPackageIdsChange(checked ? [...selectedPackageIds, packageData.id] : selectedPackageIds.filter((id) => id !== packageData.id))}
                                  onOpen={() => onOpenPackage(packageData.id)}
                              />
                          ))
                        : null}
                    {standaloneResults.map((result, index) => renderResultCard(result, index))}
                    {resultViewMode === "category" ? (
                        <>
                            {!activeCategoryId
                                ? categoryGroups.map(({ category, logs: categoryLogs }) => (
                                      <CategoryCard key={category.id} category={category} logs={categoryLogs} onRename={onRenameCategory} onDelete={onDeleteCategory} onOpen={() => onActiveCategoryChange(category.id)} />
                                  ))
                                : null}
                        </>
                    ) : null}
                    {visibleLogs.map((log, index) => {
                        const groupId = resolveLogVersionGroupId(log);
                        const retryResult = retryResultByVersionGroup.get(groupId);
                        if (retryResult) return renderResultCard(retryResult, index);
                        return (
                            <HistoryLogCard
                                key={log.id}
                                log={log}
                                historyLogs={baseLogVersionGroups.get(groupId) || [log]}
                                categories={categories}
                                index={index}
                                selected={selectedLogIds.includes(log.id)}
                                active={activeLogId === log.id}
                                onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                                onDelete={() => onDeleteLog(log)}
                                onToggleCategory={(categoryId) => onToggleLogCategory(log, categoryId)}
                                onClearCategories={() => onClearLogCategories(log)}
                                onCreateCategory={onCreateCategory}
                                onPreview={() => onPreviewLog(log)}
                                onRetry={() => onRetryLog(log)}
                                onPreviewHistoryLog={onPreviewLog}
                                onRetryHistoryLog={onRetryLog}
                                onUpdatePrompt={(promptText) => onUpdateLogPrompt(log, promptText)}
                                onCopyPrompt={onCopyPrompt}
                                onEdit={onEdit}
                                onDownload={onDownload}
                                onCopyLink={onCopyImageLink}
                                onSaveAsset={onSaveAsset}
                                linkingImageId={linkingImageId}
                            />
                        );
                    })}
                </div>
            ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                    <ImagePlus className="mb-4 size-11 text-stone-400" />
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成图片" />
                </div>
            )}
        </div>
    );
}

function CategoryCard({
    category,
    logs,
    onRename,
    onDelete,
    onOpen,
}: {
    category: GenerationCategory;
    logs: GenerationLog[];
    onRename: (category: GenerationCategory, name: string) => void;
    onDelete: (category: GenerationCategory) => void;
    onOpen: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(category.name);
    const images = logs.flatMap((log) => log.images).slice(0, 6);

    useEffect(() => {
        setName(category.name);
    }, [category.name]);

    const saveName = () => {
        const value = name.trim();
        if (!value) return;
        onRename(category, value);
        setEditing(false);
    };

    return (
        <div className="group relative min-h-[360px] overflow-hidden rounded-lg border border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60 sm:min-h-[420px]">
            <button type="button" className="absolute inset-0 z-0 text-left" onClick={onOpen} aria-label={`打开分类 ${category.name}`} />
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                {images.length ? (
                    <>
                        {images.map((image, index) => (
                            <img
                                key={`${image.id}-${index}`}
                                src={image.dataUrl}
                                alt=""
                                className={`${images.length === 1 ? "inset-0 size-full rounded-none border-0" : "h-[92%] w-[86%] rounded-lg border border-white/80 dark:border-stone-900"} absolute object-cover shadow-xl transition-transform duration-200 group-hover:scale-[1.02]`}
                                style={{
                                    left: images.length === 1 ? 0 : `${3 + index * 4}%`,
                                    top: images.length === 1 ? 0 : `${4 + index * 3}%`,
                                    transform: images.length === 1 ? "none" : `rotate(${(index - 2) * 4}deg)`,
                                    zIndex: index + 1,
                                }}
                            />
                        ))}
                    </>
                ) : (
                    <div className="flex size-full items-center justify-center text-sm text-stone-500">暂无图片</div>
                )}
            </div>
            <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3 pt-10 text-white">
                {editing ? <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} onPressEnter={saveName} onBlur={saveName} /> : <div className="truncate text-sm font-semibold">{category.name}</div>}
            </div>
            <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                <Tag className="m-0 text-[10px]">{logs.length} 条</Tag>
                <Tag className="m-0 text-[10px]">{images.length} 图</Tag>
            </div>
            <div className="absolute bottom-2 right-2 z-20 flex gap-1">
                <Button title="改名" size="small" icon={<PenLine className="size-3.5" />} onClick={() => setEditing(true)} />
                <Button title="删除" size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => onDelete(category)} />
            </div>
        </div>
    );
}

function ProductPackageFolderCard({ packageData, selected, onSelectedChange, onOpen }: { packageData: ProductImagePackage; selected: boolean; onSelectedChange: (checked: boolean) => void; onOpen: () => void }) {
    const stats = getVisiblePackageStats(packageData);
    const mainCoverUrl = packageData.items.find((item) => item.group === "main" && item.image?.dataUrl)?.image?.dataUrl || packageData.items.find((item) => item.image?.dataUrl)?.image?.dataUrl || packageData.references[0]?.dataUrl || null;
    const visibleGroupCounts = getVisiblePackageGroupCounts(packageData);
    const groupDoneCounts = packageGroupOrder.reduce(
        (counts, group) => {
            counts[group] = packageData.items.filter((item) => item.group === group && shouldDisplayPackageItem(item) && item.status === "success").length;
            return counts;
        },
        { main: 0, sub: 0, detail: 0, sku: 0, other: 0 } as Record<ProductPackageGroup, number>,
    );
    return (
        <div className="group relative min-h-[360px] overflow-hidden rounded-lg border border-stone-200 bg-stone-100/60 dark:border-stone-800 dark:bg-stone-900/60 sm:min-h-[420px]">
            <button type="button" className="absolute inset-0 z-10 text-left transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-xl dark:hover:border-sky-500/50" onClick={onOpen} aria-label={`打开图包 ${packageData.packageName}`} />
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                {mainCoverUrl ? (
                    <div className="absolute inset-0 flex items-center justify-center p-4">
                        <img src={mainCoverUrl} alt="" className="max-h-[78%] max-w-[84%] rounded-lg border border-white/85 object-contain shadow-xl transition-transform duration-200 group-hover:scale-[1.02] dark:border-stone-950" />
                    </div>
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-3 text-stone-400">
                        <Folder className="size-16 text-sky-500/80 dark:text-sky-300/80" />
                        <span className="text-sm">产品图包文件夹</span>
                    </div>
                )}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/55 to-transparent p-3 pt-16 text-white">
                <div className="mb-2 flex items-center gap-2">
                    <FileArchive className="size-4 shrink-0 text-sky-200" />
                    <div className="min-w-0 truncate text-sm font-semibold">{packageData.packageName}</div>
                </div>
                <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/20">
                    <div className="h-full rounded-full bg-sky-300 transition-all" style={{ width: `${stats.percent}%` }} />
                </div>
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                    {packageGroupOrder.map((group) =>
                        visibleGroupCounts[group] ? (
                            <span key={group} className="rounded bg-white/15 px-1.5 py-0.5">
                                {packageGroupTitle(group)} {groupDoneCounts[group]}/{visibleGroupCounts[group]}
                            </span>
                        ) : null,
                    )}
                    <span className="rounded bg-white/15 px-1.5 py-0.5">{stats.running ? `${stats.running} 生成中` : `${stats.success}/${stats.total} 完成`}</span>
                </div>
            </div>
            <div className="absolute left-1.5 top-1.5 z-30 flex items-center gap-1 rounded-md bg-white/85 px-1.5 py-1 shadow-sm dark:bg-stone-950/80">
                <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
            </div>
            <div className="pointer-events-none absolute right-1.5 top-1.5 z-20 flex gap-1">
                <Tag className="m-0 text-[10px]" color={stats.failed ? "red" : stats.running ? "processing" : stats.success === stats.total ? "green" : "blue"}>
                    {stats.failed ? `失败 ${stats.failed}` : stats.running ? "生成中" : stats.success === stats.total ? "已完成" : "等待中"}
                </Tag>
                <Tag className="m-0 text-[10px]">{stats.total} 图</Tag>
            </div>
        </div>
    );
}

function ProductPackageReferenceCard({ packageData }: { packageData: ProductImagePackage }) {
    const productReference = packageData.references[0] || packageData.items.flatMap((item) => item.references)[0];
    const stats = getVisiblePackageStats(packageData);
    return (
        <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-[#141414]">
            <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2 dark:border-stone-800">
                <div className="min-w-0">
                    <div className="text-xs text-stone-500 dark:text-stone-400">{referenceAlias(0)} · 透明主图</div>
                    <div className="truncate text-sm font-semibold">{packageData.productName}</div>
                </div>
                <Tag className="m-0">{stats.total} 张参考</Tag>
            </div>
            <div className="relative aspect-square bg-[linear-gradient(45deg,rgba(120,113,108,.14)_25%,transparent_25%),linear-gradient(-45deg,rgba(120,113,108,.14)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,rgba(120,113,108,.14)_75%),linear-gradient(-45deg,transparent_75%,rgba(120,113,108,.14)_75%)] bg-[length:18px_18px] bg-[position:0_0,0_9px,9px_-9px,-9px_0] p-3 dark:bg-[linear-gradient(45deg,rgba(255,255,255,.08)_25%,transparent_25%),linear-gradient(-45deg,rgba(255,255,255,.08)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,rgba(255,255,255,.08)_75%),linear-gradient(-45deg,transparent_75%,rgba(255,255,255,.08)_75%)]">
                <div className="absolute left-2 top-2 z-10 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">{referenceAlias(0)}</div>
                {productReference?.dataUrl ? (
                    <Image src={productReference.dataUrl} alt={productReference.name || packageData.productName} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} preview={{ mask: null }} />
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
                        <ImagePlus className="size-7" />
                        <span>没有透明主图</span>
                    </div>
                )}
            </div>
            <div className="space-y-1 border-t border-stone-200 p-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
                <div className="truncate">{productReference?.name || "未命名产品图"}</div>
                <div className="flex flex-wrap gap-1.5">
                    {productReference?.width && productReference.height ? (
                        <Tag className="m-0 text-[10px]">
                            {productReference.width}x{productReference.height}
                        </Tag>
                    ) : null}
                    {productReference?.bytes ? <Tag className="m-0 text-[10px]">{formatBytes(productReference.bytes)}</Tag> : null}
                    <Tag className="m-0 text-[10px]">{packageData.model || "未配置模型"}</Tag>
                </div>
            </div>
        </section>
    );
}

function PackageResultsPanel({
    className,
    packageData,
    logs,
    now,
    onBack,
    onCopyPrompt,
    onPreviewLog,
    onUpdatePrompt,
    onRetryItem,
    onToggleItemSelected,
    onSelectItems,
    onStartSelected,
    onImportPackageFolder,
    onDownloadPackageItem,
    onDownloadImage,
    linkingImageId,
    onCopyImageLink,
    onSaveAsset,
    onEdit,
}: {
    className?: string;
    packageData: ProductImagePackage;
    logs: GenerationLog[];
    now: number;
    onBack: () => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onPreviewLog: (log: GenerationLog) => void;
    onUpdatePrompt: (itemId: string, prompt: string, options?: { silent?: boolean; allowEmpty?: boolean }) => void | Promise<void>;
    onRetryItem: (itemId: string, promptOverride?: string) => void | Promise<void>;
    onToggleItemSelected: (itemId: string, checked: boolean) => void;
    onSelectItems: (group: ProductPackageGroup | "all", checked: boolean) => void;
    onStartSelected: (group?: ProductPackageGroup | "all", promptOverride?: string) => void | Promise<void>;
    onImportPackageFolder: () => void;
    onDownloadPackageItem: (item: ProductPackageItem) => void;
    onDownloadImage: (image: GeneratedImage, index: number) => void;
    linkingImageId: string;
    onCopyImageLink: (image: GeneratedImage, index: number) => void | Promise<void>;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
}) {
    const { message } = App.useApp();
    const [bulkPrompt, setBulkPrompt] = useState("");
    const stats = getVisiblePackageStats(packageData);
    const itemHistoryMap = useMemo(() => buildPackageItemHistoryMap(logs, packageData.id), [logs, packageData.id]);
    const groups = useMemo(
        () =>
            packageGroupOrder.map((group) => ({
                group,
                items: packageData.items.filter((item) => item.group === group && shouldDisplayPackageItem(item)),
            })),
        [packageData.items],
    );
    const visibleGroups = groups.filter(({ items }) => items.length);
    const selectableItems = packageData.items.filter((item) => shouldDisplayPackageItem(item) && item.status !== "running");
    const selectedCount = selectableItems.filter((item) => item.selected).length;
    const allSelectableSelected = Boolean(selectableItems.length) && selectableItems.every((item) => item.selected);
    const selectedRunnableCount = selectableItems.filter((item) => item.selected && item.prompt.trim()).length;
    const bulkPromptText = bulkPrompt.trim();
    const displayRunnableCount = bulkPromptText ? selectedCount : selectedRunnableCount;
    const selectedItemsForGroup = (group: ProductPackageGroup | "all" = "all") => selectableItems.filter((item) => item.selected && (group === "all" || item.group === group));
    const applyBulkPromptToSelected = async (group: ProductPackageGroup | "all" = "all") => {
        const nextPrompt = bulkPrompt.trim();
        if (!nextPrompt) {
            message.warning("请先输入批量提示词");
            return false;
        }
        const targets = selectedItemsForGroup(group);
        if (!targets.length) {
            message.warning(group === "all" ? "请先勾选要应用的图片" : `请先勾选${packageGroupTitle(group)}里的图片`);
            return false;
        }
        await Promise.all(targets.map((item) => Promise.resolve(onUpdatePrompt(item.id, nextPrompt, { silent: true }))));
        message.success(`已应用到 ${targets.length} 张`);
        return true;
    };
    const startSelectedWithBulkPrompt = async (group: ProductPackageGroup | "all" = "all") => {
        await Promise.resolve(onStartSelected(group, bulkPromptText || undefined));
    };
    const downloadPackageItems = async (items: ProductPackageItem[], fileName: string) => {
        const imageItems = items.filter((item) => item.image);
        if (!imageItems.length) {
            message.warning("这个文件夹还没有可下载的图片");
            return;
        }
        try {
            const imageFiles = await Promise.all(
                imageItems.map(async (item) => {
                    const image = item.image as GeneratedImage;
                    const source = await imageToDataUrl(image);
                    const response = await fetch(source || image.dataUrl);
                    const blob = await response.blob();
                    const ext = imageExtension(image.mimeType || blob.type || source || image.dataUrl);
                    const groupName = packageGroupTitle(item.group);
                    return {
                        name: `${groupName}/${String(item.groupIndex).padStart(2, "0")}-${safeFileName(item.title)}.${ext}`,
                        data: blob,
                    };
                }),
            );
            const promptText = items
                .map((item) => `${item.title}\n${stripPromptTaskPrefix(item.prompt || "")}`)
                .filter((text) => text.trim())
                .join("\n\n---\n\n");
            const zip = await createZip([...imageFiles, { name: "prompts.txt", data: promptText }]);
            saveAs(zip, `${safeFileName(fileName)}.zip`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载图包失败");
        }
    };
    return (
        <div className={`thin-scrollbar rounded-xl border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 dark:bg-[#101010] lg:min-h-0 lg:overflow-y-auto lg:p-5 ${className || ""}`}>
            <div className="sticky top-0 z-20 -mx-4 -mt-4 mb-5 border-b border-stone-200 bg-card/95 px-4 py-3 backdrop-blur dark:border-stone-800 dark:bg-[#101010]/95 lg:-mx-5 lg:-mt-5 lg:px-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <Button size="small" icon={<ChevronLeft className="size-3.5" />} onClick={onBack}>
                            返回
                        </Button>
                        <FileArchive className="size-4 text-sky-500" />
                        <h2 className="truncate text-xl font-semibold">{packageData.packageName}</h2>
                        <Tag className="m-0">
                            {stats.success}/{stats.total}
                        </Tag>
                        {stats.running ? (
                            <Tag className="m-0" color="processing">
                                {stats.running} 生成中
                            </Tag>
                        ) : null}
                        {stats.failed ? (
                            <Tag className="m-0" color="red">
                                失败 {stats.failed}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={onImportPackageFolder}>
                            上传套图
                        </Button>
                        <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!selectableItems.length} onClick={() => onSelectItems("all", !allSelectableSelected)}>
                            {allSelectableSelected ? "取消全选" : "全部勾选"}
                        </Button>
                        <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={!selectedCount} onClick={() => void startSelectedWithBulkPrompt("all")}>
                            开始生成{selectedCount ? ` ${displayRunnableCount}/${selectedCount}` : ""}
                        </Button>
                        <Button size="small" icon={<Download className="size-3.5" />} disabled={!stats.success} onClick={() => void downloadPackageItems(packageData.items, packageData.packageName)}>
                            下载图包
                        </Button>
                    </div>
                </div>
            </div>
            <div className="mb-5 grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
                <ProductPackageReferenceCard packageData={packageData} />
                <div className="rounded-xl border border-stone-200 bg-stone-50/75 p-3 dark:border-stone-800 dark:bg-stone-950/50">
                    <div className="mb-3 flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                        <span>图包进度</span>
                        <span>{stats.percent}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
                        <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${stats.percent}%` }} />
                    </div>
                    <div className="mt-3 rounded-lg border border-stone-200 bg-white/85 p-2 dark:border-stone-800 dark:bg-[#141414]">
                        <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                            <span className="font-medium text-stone-700 dark:text-stone-200">批量提示词</span>
                            <span className="text-stone-500 dark:text-stone-400">{selectedCount ? `已勾选 ${selectedCount} 张` : "先勾选图片"}</span>
                        </div>
                        <Input.TextArea
                            value={bulkPrompt}
                            autoSize={{ minRows: 4, maxRows: 8 }}
                            placeholder="例如：把图片1的产品替换到图片2里，保持图片2构图、背景、排版和文字风格"
                            className="!rounded-lg !border-stone-200 !bg-stone-50/80 !py-2.5 !text-xs dark:!border-stone-800 dark:!bg-stone-950/70"
                            onChange={(event) => setBulkPrompt(event.target.value)}
                        />
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                            <Button size="small" disabled={!bulkPromptText || !selectedCount} onClick={() => void applyBulkPromptToSelected("all")}>
                                应用到已勾选
                            </Button>
                            <Button size="small" type="primary" icon={<Sparkles className="size-3.5" />} disabled={!selectedCount} onClick={() => void startSelectedWithBulkPrompt("all")}>
                                应用并开始
                            </Button>
                        </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        {visibleGroups.map(({ group, items }) => {
                            const completedCount = items.filter((item) => item.status === "success").length;
                            const runningCount = items.filter((item) => item.status === "running").length;
                            const failedCount = items.filter((item) => item.status === "failed").length;
                            const groupSelectable = items.filter((item) => item.status !== "running");
                            const groupSelected = groupSelectable.filter((item) => item.selected).length;
                            const allGroupSelected = Boolean(groupSelectable.length) && groupSelectable.every((item) => item.selected);
                            return (
                                <div key={group} className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-[#141414]">
                                    <div className={cn("h-1", packageGroupAccentClass(group))} />
                                    <div className="space-y-2 px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className={cn("size-2 rounded-full", packageGroupAccentClass(group))} />
                                                <span className="truncate text-sm font-medium">{packageGroupSectionTitle(group)}</span>
                                            </div>
                                            <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                                                {completedCount}/{items.length}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between gap-2">
                                            <Checkbox checked={allGroupSelected} indeterminate={groupSelected > 0 && !allGroupSelected} disabled={!groupSelectable.length} onChange={(event) => onSelectItems(group, event.target.checked)}>
                                                <span className="text-xs">勾选本组 {groupSelected ? `${groupSelected}/${groupSelectable.length}` : ""}</span>
                                            </Checkbox>
                                            <Button size="small" type="text" className="!h-6 !px-1.5 text-xs" disabled={!groupSelected} onClick={() => void startSelectedWithBulkPrompt(group)}>
                                                生成
                                            </Button>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {runningCount ? <span className="rounded bg-sky-500/12 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-300">{runningCount} 生成中</span> : null}
                                            {failedCount ? <span className="rounded bg-red-500/12 px-1.5 py-0.5 text-[10px] text-red-600 dark:text-red-300">失败 {failedCount}</span> : null}
                                            {!runningCount && !failedCount ? (
                                                groupSelected ? (
                                                    <span className="rounded bg-sky-500/12 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-300">已勾选 {groupSelected}</span>
                                                ) : (
                                                    <span className="rounded bg-stone-500/12 px-1.5 py-0.5 text-[10px] text-stone-500">{completedCount === items.length ? "已完成" : "等待勾选"}</span>
                                                )
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
            <div className="space-y-6">
                {visibleGroups.map(({ group, items }) => {
                    if (!items.length) return null;
                    const completedCount = items.filter((item) => item.status === "success").length;
                    const runningCount = items.filter((item) => item.status === "running").length;
                    const failedCount = items.filter((item) => item.status === "failed").length;
                    const sourceFolders = Array.from(new Set(items.map((item) => item.sourceFolderName).filter(Boolean)));
                    return (
                        <section key={group} className={cn("relative overflow-hidden rounded-xl border shadow-sm", packageGroupBlockClass(group))}>
                            <div className={cn("absolute left-0 top-0 h-full w-1", packageGroupAccentClass(group))} />
                            <div className={cn("border-b px-4 py-3 pl-5", packageGroupHeaderClass(group))}>
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-3">
                                        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold", packageGroupMarkClass(group))}>{packageGroupShortTitle(group)}</div>
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="text-lg font-semibold leading-tight">{packageGroupSectionTitle(group)}</h3>
                                                <Tag className="m-0">
                                                    {completedCount}/{items.length}
                                                </Tag>
                                                {runningCount ? (
                                                    <Tag className="m-0" color="processing">
                                                        {runningCount} 生成中
                                                    </Tag>
                                                ) : null}
                                                {failedCount ? (
                                                    <Tag className="m-0" color="red">
                                                        失败 {failedCount}
                                                    </Tag>
                                                ) : null}
                                            </div>
                                            <div className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{sourceFolders.length ? `来源：${sourceFolders.join("、")}` : packageGroupTitle(group)}</div>
                                        </div>
                                    </div>
                                    <Button size="small" icon={<Download className="size-3.5" />} disabled={!items.some((item) => item.image)} onClick={() => void downloadPackageItems(items, `${packageData.packageName}-${packageGroupTitle(group)}`)}>
                                        下载本组
                                    </Button>
                                </div>
                            </div>
                            <div className="p-3 pl-4 lg:p-4 lg:pl-5">
                                <div className={cn("grid gap-3", group === "detail" ? "sm:grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3" : "sm:grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3")}>
                                    {items.map((item) => (
                                        <PackageItemCard
                                            key={item.id}
                                            item={item}
                                            now={now}
                                            selected={Boolean(item.selected)}
                                            onSelectedChange={(checked) => onToggleItemSelected(item.id, checked)}
                                            onCopyPrompt={onCopyPrompt}
                                            onUpdatePrompt={(prompt, options) => onUpdatePrompt(item.id, prompt, options)}
                                            onRetry={(promptOverride) => onRetryItem(item.id, promptOverride)}
                                            onDownload={() => onDownloadPackageItem(item)}
                                            onCopyLink={() => item.image && void onCopyImageLink(item.image, item.index - 1)}
                                            linking={Boolean(item.image && linkingImageId === item.image.id)}
                                            historyLogs={itemHistoryMap.get(item.index) || []}
                                            linkingImageId={linkingImageId}
                                            onPreviewHistoryLog={onPreviewLog}
                                            onDownloadHistoryImage={onDownloadImage}
                                            onCopyHistoryImageLink={onCopyImageLink}
                                            onSaveAsset={() => item.image && void onSaveAsset(item.image, item.index - 1)}
                                            onEdit={() => item.image && void onEdit(item.image, item.index - 1)}
                                        />
                                    ))}
                                </div>
                            </div>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}

function PackageItemCard({
    item,
    now,
    selected,
    onSelectedChange,
    onCopyPrompt,
    onUpdatePrompt,
    onRetry,
    onDownload,
    onCopyLink,
    linking,
    historyLogs,
    linkingImageId,
    onPreviewHistoryLog,
    onDownloadHistoryImage,
    onCopyHistoryImageLink,
    onSaveAsset,
    onEdit,
}: {
    item: ProductPackageItem;
    now: number;
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onUpdatePrompt: (prompt: string, options?: { silent?: boolean; allowEmpty?: boolean }) => void | Promise<void>;
    onRetry: (promptOverride?: string) => void;
    onDownload: () => void;
    onCopyLink: () => void;
    linking: boolean;
    historyLogs: GenerationLog[];
    linkingImageId: string;
    onPreviewHistoryLog: (log: GenerationLog) => void;
    onDownloadHistoryImage: (image: GeneratedImage, index: number) => void;
    onCopyHistoryImageLink: (image: GeneratedImage, index: number) => void | Promise<void>;
    onSaveAsset: () => void;
    onEdit: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [detailOpen, setDetailOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [promptDraft, setPromptDraft] = useState(stripPromptTaskPrefix(item.prompt));
    const aspect = packageItemAspectClass(item);
    const referenceImage = packageTaskReference(item);
    const referenceInputIndex = referenceImage ? item.references.findIndex((reference) => reference.id === referenceImage.id) : -1;
    const referenceLabel = referenceInputIndex >= 0 ? `${referenceAlias(referenceInputIndex)} · 参考图` : "参考图";
    const savedPrompt = stripPromptTaskPrefix(item.prompt);
    const promptDirty = promptDraft.trim() !== savedPrompt.trim();
    useEffect(() => {
        setPromptDraft(stripPromptTaskPrefix(item.prompt));
    }, [item.prompt]);
    const savePromptDraft = async (value = promptDraft, allowEmpty = false) => {
        const nextPrompt = value.trim();
        if ((!nextPrompt && !allowEmpty) || nextPrompt === savedPrompt.trim()) return Boolean(nextPrompt);
        await Promise.resolve(onUpdatePrompt(nextPrompt, { silent: true, allowEmpty }));
        return Boolean(nextPrompt);
    };
    const runCurrentPrompt = async () => {
        const nextPrompt = promptDraft.trim();
        if (!nextPrompt || item.status === "running") return;
        if (promptDirty) await savePromptDraft(nextPrompt);
        onRetry(nextPrompt);
    };
    return (
        <div
            className={cn(
                "overflow-hidden rounded-xl border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:bg-[#121212]",
                selected
                    ? "border-sky-500 shadow-[0_0_0_1px_rgba(14,165,233,.35)]"
                    : item.status === "failed"
                      ? "border-red-300/80 dark:border-red-900/80"
                      : item.status === "running"
                        ? "border-sky-400/70 dark:border-sky-700/80"
                        : "border-stone-200 dark:border-stone-800",
            )}
        >
            <div className="flex items-center justify-between gap-2 border-b border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <Checkbox checked={selected} disabled={item.status === "running"} onChange={(event) => onSelectedChange(event.target.checked)}>
                    <span className="text-xs font-medium">{item.title}</span>
                </Checkbox>
                <Tag className="m-0 text-[10px]" color={packageStatusColor(item.status)}>
                    {packageStatusLabel(item.status)}
                </Tag>
            </div>
            <div className="grid grid-cols-2 gap-px bg-stone-200 dark:bg-stone-800">
                <PackageComparisonPane className={aspect} label={referenceLabel}>
                    {referenceImage?.dataUrl ? <Image src={referenceImage.dataUrl} alt={referenceImage.name || `${item.title}参考图`} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} preview={{ mask: null }} /> : <EmptyReferencePane />}
                </PackageComparisonPane>
                <PackageComparisonPane className={aspect} label="生成图">
                    {item.status === "success" && item.image ? (
                        <Image src={item.image.dataUrl} alt={item.title} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} />
                    ) : item.status === "failed" ? (
                        <div className="flex size-full flex-col items-center justify-center gap-3 p-5 text-center text-red-500">
                            <AlertCircle className="size-7" />
                            <span className="text-sm font-medium">生成失败</span>
                        </div>
                    ) : item.status === "running" ? (
                        <div className="flex size-full flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                            <LoaderCircle className="size-6 animate-spin text-sky-500" />
                            <span>生成中</span>
                            <span className="rounded-full bg-white/80 px-2 py-1 text-xs text-stone-600 shadow-sm dark:bg-stone-950/70 dark:text-stone-300">{formatDuration(Math.max(0, now - (item.startedAt || now)))}</span>
                        </div>
                    ) : (
                        <div className="flex size-full flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                            <ImagePlus className="size-7" />
                            <span>等待生成</span>
                        </div>
                    )}
                </PackageComparisonPane>
            </div>
            <div className="space-y-1 border-t border-stone-200 p-1.5 text-xs dark:border-stone-800">
                <div className="rounded-md bg-stone-50 p-1 dark:bg-stone-900">
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium text-stone-500 dark:text-stone-400">提示词</span>
                        {promptDirty ? <span className="text-[10px] text-sky-500">自动保存</span> : null}
                    </div>
                    <Input.TextArea
                        value={promptDraft}
                        autoSize={{ minRows: expanded ? 4 : 1, maxRows: expanded ? 6 : 1 }}
                        disabled={item.status === "running"}
                        placeholder="例如：把图片1的产品替换到图片2里，保持图片2构图和文字风格"
                        className="!rounded-lg !border-stone-200 !bg-white/80 !text-xs dark:!border-stone-800 dark:!bg-stone-950/60"
                        onChange={(event) => {
                            const nextValue = event.target.value;
                            setPromptDraft(nextValue);
                            void savePromptDraft(nextValue, true);
                        }}
                    />
                    <div className="mt-1 flex flex-wrap justify-end gap-x-2 gap-y-1">
                        <Button size="small" type="text" className="!h-5 !px-1.5 whitespace-nowrap text-xs" disabled={!promptDraft.trim()} onClick={() => void onCopyPrompt(promptDraft.trim())}>
                            复制
                        </Button>
                        <Button size="small" type="text" className="!h-5 !px-1.5 whitespace-nowrap text-xs" onClick={() => setExpanded((value) => !value)}>
                            {expanded ? "收起" : "展开"}
                        </Button>
                    </div>
                </div>
                {item.error ? (
                    <div className="flex items-start justify-between gap-2 rounded-md bg-red-100 px-2 py-1 text-red-600 dark:bg-red-950/40 dark:text-red-300">
                        <span className="line-clamp-2 min-w-0">{item.error}</span>
                        <Button size="small" type="text" className="!h-auto !p-0 text-xs" onClick={() => setDetailOpen(true)}>
                            详情
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-stone-200 px-2 py-1.5 dark:border-stone-800">
                <div className="text-[10px] text-stone-500 dark:text-stone-400">第 {item.index} 张</div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" className="!h-7" icon={<RotateCcw className="size-3.5" />} disabled={item.status === "running" || !promptDraft.trim()} onClick={() => void runCurrentPrompt()}>
                        {item.image || item.status === "failed" ? "重试" : "生成"}
                    </Button>
                    <Button size="small" icon={<History className="size-3.5" />} disabled={!historyLogs.length} onClick={() => setHistoryOpen(true)}>
                        历史{historyLogs.length > 1 ? ` ${historyLogs.length}` : ""}
                    </Button>
                    <Button size="small" loading={linking} icon={<Link2 className="size-3.5" />} disabled={!item.image} onClick={onCopyLink} />
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={!item.image} onClick={onSaveAsset} />
                    <Button size="small" icon={<ImagePlus className="size-3.5" />} disabled={!item.image} onClick={onEdit} />
                    <Button size="small" icon={<Download className="size-3.5" />} disabled={!item.image} onClick={onDownload} />
                </div>
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{formatFailureDetailText(item.errorDetail, item.error)}</pre>
            </Modal>
            <PackageItemHistoryModal
                open={historyOpen}
                item={item}
                logs={historyLogs}
                linkingImageId={linkingImageId}
                onClose={() => setHistoryOpen(false)}
                onPreviewLog={(log) => {
                    setHistoryOpen(false);
                    onPreviewHistoryLog(log);
                }}
                onCopyPrompt={onCopyPrompt}
                onDownload={onDownloadHistoryImage}
                onCopyLink={onCopyHistoryImageLink}
            />
        </div>
    );
}

function PackageComparisonPane({ className, label, children }: { className: string; label: string; children: ReactNode }) {
    return (
        <div
            className={cn(
                "relative bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08),transparent_58%),linear-gradient(135deg,rgba(120,113,108,0.10),rgba(28,25,23,0.03))] dark:bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.07),transparent_58%),linear-gradient(135deg,rgba(68,64,60,0.32),rgba(12,12,12,0.95))]",
                className,
            )}
        >
            <div className="absolute left-1.5 top-1.5 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{label}</div>
            {children}
        </div>
    );
}

function EmptyReferencePane() {
    return (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-stone-500 dark:text-stone-400">
            <ImagePlus className="size-7" />
            <span>没有参考图</span>
        </div>
    );
}

function PackageItemHistoryModal({
    open,
    item,
    logs,
    linkingImageId,
    onClose,
    onPreviewLog,
    onCopyPrompt,
    onDownload,
    onCopyLink,
}: {
    open: boolean;
    item: ProductPackageItem;
    logs: GenerationLog[];
    linkingImageId: string;
    onClose: () => void;
    onPreviewLog: (log: GenerationLog) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onDownload: (image: GeneratedImage, index: number) => void;
    onCopyLink: (image: GeneratedImage, index: number) => void | Promise<void>;
}) {
    const sortedLogs = sortPackageItemHistoryLogs(logs);
    return (
        <Modal title={`${item.title} 历史记录（${sortedLogs.length}）`} open={open} width={960} footer={null} onCancel={onClose}>
            {sortedLogs.length ? (
                <div className="grid max-h-[70vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                    {sortedLogs.map((historyLog, index) => {
                        const image = historyLog.images.find((entry) => Boolean(entry.dataUrl));
                        const isCurrent = historyLog.id === item.logId;
                        const versionLabel = resolvePackageHistoryVersionLabel(historyLog, index);
                        return (
                            <div key={historyLog.id} className={cn("overflow-hidden rounded-xl border bg-background dark:bg-stone-950", isCurrent ? "border-sky-500 shadow-[0_0_0_1px_rgba(14,165,233,.35)]" : "border-stone-200 dark:border-stone-800")}>
                                <div className="relative aspect-square bg-stone-100 dark:bg-stone-900">
                                    <div className="absolute left-2 top-2 z-10 flex flex-wrap gap-1">
                                        <Tag className="m-0 text-[10px]" color={isCurrent ? "blue" : "default"}>
                                            {versionLabel}
                                        </Tag>
                                        {isCurrent ? (
                                            <Tag className="m-0 text-[10px]" color="processing">
                                                当前
                                            </Tag>
                                        ) : null}
                                        <Tag className="m-0 text-[10px]" color={historyLog.failCount ? "red" : "green"}>
                                            {historyLog.status}
                                        </Tag>
                                    </div>
                                    {image ? (
                                        <Image src={image.dataUrl} alt={`${item.title} ${versionLabel}`} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} />
                                    ) : (
                                        <div className="flex size-full flex-col items-center justify-center gap-2 p-5 text-center text-sm text-red-500">
                                            <AlertCircle className="size-7" />
                                            <span>{historyLog.errors[0] || "没有可显示的图片"}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-2 border-t border-stone-200 p-3 text-xs dark:border-stone-800">
                                    <div className="flex flex-wrap items-center gap-1 text-[11px] text-stone-500 dark:text-stone-400">
                                        <span>{formatLogTime(historyLog.createdAt)}</span>
                                        <span>{formatDuration(historyLog.durationMs)}</span>
                                        {historyLog.retryOfVersionNo ? <Tag className="m-0 text-[10px]">由 V{historyLog.retryOfVersionNo} 重试</Tag> : null}
                                    </div>
                                    <div className="line-clamp-2 whitespace-pre-wrap text-stone-700 dark:text-stone-200">{stripPromptTaskPrefix(historyLog.prompt)}</div>
                                    <div className="flex flex-wrap gap-1">
                                        <Button size="small" onClick={() => onPreviewLog(historyLog)}>
                                            载入
                                        </Button>
                                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(stripPromptTaskPrefix(historyLog.prompt))}>
                                            复制
                                        </Button>
                                        <Button size="small" loading={Boolean(image && linkingImageId === image.id)} icon={<Link2 className="size-3.5" />} disabled={!image} onClick={() => image && void onCopyLink(image, item.index - 1)} />
                                        <Button size="small" icon={<Download className="size-3.5" />} disabled={!image} onClick={() => image && onDownload(image, item.index - 1)} />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <Empty description="暂无历史记录" />
            )}
        </Modal>
    );
}

function packageGroupTitle(group: ProductPackageGroup) {
    if (group === "main") return "主图";
    if (group === "sub") return "副图";
    if (group === "sku") return "SKU";
    if (group === "other") return "其他参考";
    return "详情图";
}

function packageGroupShortTitle(group: ProductPackageGroup) {
    if (group === "main") return "主";
    if (group === "sku") return "SKU";
    if (group === "detail") return "详";
    if (group === "sub") return "副";
    return "其";
}

function packageGroupSectionTitle(group: ProductPackageGroup) {
    if (group === "main") return "主图区";
    if (group === "sku") return "SKU 区";
    if (group === "detail") return "详情区";
    if (group === "sub") return "副图区";
    return "其他参考区";
}

function packageGroupColor(group: ProductPackageGroup) {
    if (group === "main") return "blue";
    if (group === "sub") return "cyan";
    if (group === "detail") return "purple";
    if (group === "sku") return "gold";
    return "default";
}

function packageGroupBlockClass(group: ProductPackageGroup) {
    if (group === "main") return "border-sky-300/70 bg-white dark:border-sky-900/70 dark:bg-[#141b20]";
    if (group === "sku") return "border-amber-300/75 bg-white dark:border-amber-900/70 dark:bg-[#1d1910]";
    if (group === "detail") return "border-fuchsia-300/70 bg-white dark:border-fuchsia-900/70 dark:bg-[#1b141c]";
    if (group === "sub") return "border-cyan-300/70 bg-white dark:border-cyan-900/70 dark:bg-[#121c1d]";
    return "border-stone-200 bg-white dark:border-stone-800 dark:bg-[#171717]";
}

function packageGroupHeaderClass(group: ProductPackageGroup) {
    if (group === "main") return "border-sky-200/70 bg-sky-50/85 dark:border-sky-900/70 dark:bg-sky-950/25";
    if (group === "sku") return "border-amber-200/80 bg-amber-50/90 dark:border-amber-900/70 dark:bg-amber-950/25";
    if (group === "detail") return "border-fuchsia-200/75 bg-fuchsia-50/85 dark:border-fuchsia-900/70 dark:bg-fuchsia-950/25";
    if (group === "sub") return "border-cyan-200/75 bg-cyan-50/85 dark:border-cyan-900/70 dark:bg-cyan-950/25";
    return "border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/70";
}

function packageGroupMarkClass(group: ProductPackageGroup) {
    if (group === "main") return "bg-sky-500 text-white shadow-sm shadow-sky-500/25";
    if (group === "sku") return "bg-amber-400 text-stone-950 shadow-sm shadow-amber-500/25";
    if (group === "detail") return "bg-fuchsia-500 text-white shadow-sm shadow-fuchsia-500/25";
    if (group === "sub") return "bg-cyan-500 text-white shadow-sm shadow-cyan-500/25";
    return "bg-stone-700 text-white shadow-sm";
}

function packageGroupAccentClass(group: ProductPackageGroup) {
    if (group === "main") return "bg-sky-500";
    if (group === "sku") return "bg-amber-400";
    if (group === "detail") return "bg-fuchsia-500";
    if (group === "sub") return "bg-cyan-500";
    return "bg-stone-500";
}

function packageItemAspectClass(item: ProductPackageItem) {
    const dimensions = parsePixelSize(item.config.size);
    if (!dimensions) return item.group === "detail" ? "aspect-[3/4]" : "aspect-square";
    const ratio = dimensions.width / Math.max(1, dimensions.height);
    if (ratio < 0.72) return "aspect-[3/4]";
    if (ratio < 0.95) return "aspect-[4/5]";
    if (ratio > 1.25) return "aspect-[4/3]";
    return "aspect-square";
}

function packageTaskReference(item: ProductPackageItem) {
    return item.references[1] || item.references.find((reference) => Boolean(reference.dataUrl));
}

function packageStatusLabel(status: ProductPackageItemStatus) {
    if (status === "success") return "成功";
    if (status === "failed") return "失败";
    if (status === "running") return "生成中";
    return "等待中";
}

function packageStatusColor(status: ProductPackageItemStatus) {
    if (status === "success") return "green";
    if (status === "failed") return "red";
    if (status === "running") return "processing";
    return "default";
}

function shouldDisplayPackageItem(item: ProductPackageItem) {
    return Boolean(item.prompt.trim() || item.image || item.error || item.status !== "waiting" || (item.sourceFileName && packageTaskReference(item)));
}

function stripPromptTaskPrefix(prompt: string) {
    return prompt.replace(/^\s*任务[：:]\s*/, "");
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [modelCollapsed, setModelCollapsed] = useState(false);

    return (
        <div className="space-y-3">
            <SettingSubsection title="模型" summary={model || "未选择模型"} collapsed={modelCollapsed} onToggle={() => setModelCollapsed((value) => !value)}>
                <ModelPicker
                    config={config}
                    value={model}
                    channelId={config.imageChannelId}
                    onChange={(value, channelId) => {
                        updateConfig("imageModel", value);
                        if (channelId) updateConfig("imageChannelId", channelId);
                    }}
                    fullWidth
                    onMissingConfig={() => openConfigDialog(false)}
                />
            </SettingSubsection>
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-3" maxCount={10} collapsible />
        </div>
    );
}

function SettingSubsection({ title, summary, collapsed, children, onToggle }: { title: string; summary: string; collapsed: boolean; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left" onClick={onToggle}>
                <span className="min-w-0">
                    <span className="font-medium">{title}</span>
                    {collapsed ? <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">{summary}</span> : null}
                </span>
                {collapsed ? <ChevronDown className="size-4 shrink-0 text-stone-400" /> : <ChevronUp className="size-4 shrink-0 text-stone-400" />}
            </button>
            {!collapsed ? <div className="border-t border-stone-200 p-3 dark:border-stone-800">{children}</div> : null}
        </section>
    );
}

function ResultSelectionControls({ selected, onSelectedChange, onDelete }: { selected: boolean; onSelectedChange: (checked: boolean) => void; onDelete: () => void }) {
    return (
        <div className="absolute left-1.5 top-1.5 z-20 flex items-center gap-1 rounded-md bg-white/85 px-1.5 py-1 shadow-sm dark:bg-stone-950/80">
            <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
            {selected ? <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={onDelete} /> : null}
        </div>
    );
}

function ResultImageCard({
    result,
    image,
    index,
    selected,
    onSelectedChange,
    onDelete,
    onCopyPrompt,
    onUpdatePrompt,
    onRetry,
    onEdit,
    onDownload,
    onCopyLink,
    linking,
    onSaveAsset,
}: {
    result: GenerationResult;
    image: GeneratedImage;
    index: number;
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onUpdatePrompt: (resultId: string, prompt: string) => boolean;
    onRetry: () => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onCopyLink: (image: GeneratedImage, index: number) => void | Promise<void>;
    linking: boolean;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const [promptEditorOpen, setPromptEditorOpen] = useState(false);
    const [promptDraft, setPromptDraft] = useState(result.prompt);

    useEffect(() => {
        if (!promptEditorOpen) setPromptDraft(result.prompt);
    }, [result.prompt, promptEditorOpen]);

    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className="relative aspect-[4/3] bg-stone-100 dark:bg-stone-900">
                <ResultSelectionControls selected={selected} onSelectedChange={onSelectedChange} onDelete={onDelete} />
                <span className="absolute right-1.5 top-1.5 z-10 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] leading-none text-white shadow-sm">新生成</span>
                <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} />
            </div>
            <TaskInfo
                result={result}
                onCopyPrompt={onCopyPrompt}
                promptActions={
                    <>
                        <Button size="small" type="text" icon={<PenLine className="size-3.5" />} onClick={() => setPromptEditorOpen(true)}>
                            修改
                        </Button>
                        <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} onClick={onRetry}>
                            重新生成
                        </Button>
                    </>
                }
            />
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                    <span>{formatLogTime(result.createdAt)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <ParameterButton
                        items={[
                            { label: "模型", value: result.model },
                            { label: "接口", value: result.config.apiMode === "responses" ? "Responses" : "Images" },
                            { label: "请求尺寸", value: result.config.size || "auto" },
                            { label: "实际像素", value: `${image.width}x${image.height}` },
                            { label: "分辨率", value: imageResolutionLabel(result.config.size || `${image.width}x${image.height}`) },
                            { label: "格式", value: result.config.outputFormat || "png" },
                            { label: "压缩", value: (result.config.outputFormat || "png") !== "png" ? result.config.outputCompression || "100" : "" },
                            { label: "审核", value: result.config.moderation || "auto" },
                            { label: "超时", value: `${result.config.timeout || "600"}s` },
                            { label: "文件大小", value: formatBytes(image.bytes) },
                        ]}
                    />
                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={onRetry} />
                    <Button size="small" loading={linking} icon={<Link2 className="size-3.5" />} onClick={() => void onCopyLink(image, index)} />
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)} />
                    <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => void onEdit(image, index)} />
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)} />
                </div>
            </div>
            <Modal
                title="修改提示词"
                open={promptEditorOpen}
                width={760}
                onCancel={() => setPromptEditorOpen(false)}
                onOk={() => {
                    if (onUpdatePrompt(result.id, promptDraft)) setPromptEditorOpen(false);
                }}
                okText="保存"
                cancelText="取消"
            >
                <Input.TextArea value={promptDraft} rows={8} onChange={(event) => setPromptDraft(event.target.value)} placeholder="输入新的提示词" />
            </Modal>
        </div>
    );
}

function PendingImageCard({
    result,
    now,
    selected,
    onSelectedChange,
    onDelete,
    onCopyPrompt,
}: {
    result: GenerationResult;
    now: number;
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
}) {
    const isRunning = result.status === "running";
    const startedAt = result.startedAt || result.createdAt;
    return (
        <div className="overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="relative aspect-[4/3]">
                <ResultSelectionControls selected={selected} onSelectedChange={onSelectedChange} onDelete={onDelete} />
                <div
                    className="absolute inset-0 opacity-60"
                    style={{
                        backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                        backgroundSize: "16px 16px",
                    }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                    {isRunning ? <LoaderCircle className="size-6 animate-spin" /> : <WandSparkles className="size-6" />}
                    <span>{isRunning ? "生成中" : "等待中"}</span>
                    {isRunning ? (
                        <span className="rounded-full bg-white/80 px-2 py-1 text-xs text-stone-600 shadow-sm dark:bg-stone-950/70 dark:text-stone-300">{formatDuration(Math.max(0, now - startedAt))}</span>
                    ) : (
                        <span className="rounded-full bg-white/80 px-2 py-1 text-xs text-stone-600 shadow-sm dark:bg-stone-950/70 dark:text-stone-300">队列中</span>
                    )}
                </div>
            </div>
            <TaskInfo result={isRunning ? { ...result, durationMs: Math.max(0, now - startedAt) } : result} onCopyPrompt={onCopyPrompt} />
        </div>
    );
}

function FailedImageCard({
    result,
    error,
    selected,
    onSelectedChange,
    onDelete,
    onCopyPrompt,
    onRetry,
}: {
    result: GenerationResult;
    error: string;
    selected: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onRetry: () => void;
}) {
    const [detailOpen, setDetailOpen] = useState(false);
    const detail = result.errorDetail || error;
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="relative flex aspect-[4/3] flex-col items-center justify-center gap-3 p-5 text-center">
                <ResultSelectionControls selected={selected} onSelectedChange={onSelectedChange} onDelete={onDelete} />
                <AlertCircle className="size-7 text-red-500" />
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <TaskInfo result={result} error={error} onCopyPrompt={onCopyPrompt} />
            <div className="flex justify-end gap-2 border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" onClick={() => setDetailOpen(true)}>
                    详情
                </Button>
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{formatFailureDetailText(detail, error)}</pre>
            </Modal>
        </div>
    );
}

function ParameterButton({ title = "参数", items, buttonClassName = "" }: { title?: string; items: Array<{ label: string; value: string }>; buttonClassName?: string }) {
    const [open, setOpen] = useState(false);
    const visibleItems = items.filter((item) => item.value.trim());
    return (
        <>
            <Button size="small" type="text" icon={<SlidersHorizontal className="size-3.5" />} className={buttonClassName} onClick={() => setOpen(true)}>
                {title}
            </Button>
            <Modal title={title} open={open} width={420} onCancel={() => setOpen(false)} footer={null}>
                <div className="space-y-2">
                    {visibleItems.map((item) => (
                        <div key={item.label} className="flex items-start justify-between gap-3 rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-800">
                            <span className="shrink-0 text-stone-500 dark:text-stone-400">{item.label}</span>
                            <span className="text-right text-stone-900 dark:text-stone-100">{item.value}</span>
                        </div>
                    ))}
                    {!visibleItems.length ? <div className="text-sm text-stone-500 dark:text-stone-400">暂无参数</div> : null}
                </div>
            </Modal>
        </>
    );
}

function TaskInfo({ result, error, onCopyPrompt, promptActions }: { result: GenerationResult; error?: string; onCopyPrompt: (text: string) => void | Promise<void>; promptActions?: ReactNode }) {
    const [expanded, setExpanded] = useState(false);
    const visibleReferences = result.references.filter((item) => Boolean(item.dataUrl));

    return (
        <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <div className="rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{result.prompt}</div>
                {visibleReferences.length ? <ReferenceStrip className="mt-2 border-stone-200 bg-white/60 dark:border-stone-800 dark:bg-stone-950/40" references={visibleReferences} compact /> : null}
                <div className="mt-2 flex justify-end gap-1">
                    {promptActions}
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(result.prompt)}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
            </div>
            {error ? <div className="rounded-md bg-red-100 px-2 py-1.5 text-red-600 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>
    );
}

function HistoryLogCard({
    log,
    historyLogs,
    categories,
    index,
    selected,
    active,
    onSelectedChange,
    onDelete,
    onToggleCategory,
    onClearCategories,
    onCreateCategory,
    onPreview,
    onRetry,
    onPreviewHistoryLog,
    onRetryHistoryLog,
    onUpdatePrompt,
    onCopyPrompt,
    onEdit,
    onDownload,
    onCopyLink,
    linkingImageId,
    onSaveAsset,
}: {
    log: GenerationLog;
    historyLogs: GenerationLog[];
    categories: GenerationCategory[];
    index: number;
    selected: boolean;
    active: boolean;
    onSelectedChange: (checked: boolean) => void;
    onDelete: () => void;
    onToggleCategory: (categoryId: string) => void;
    onClearCategories: () => void;
    onCreateCategory: (name: string) => Promise<GenerationCategory | null>;
    onPreview: () => void;
    onRetry: () => void;
    onPreviewHistoryLog: (log: GenerationLog) => void;
    onRetryHistoryLog: (log: GenerationLog) => void;
    onUpdatePrompt: (prompt: string) => boolean | Promise<boolean>;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onCopyLink: (image: GeneratedImage, index: number) => void | Promise<void>;
    linkingImageId: string;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const displayImages = log.images.filter((image) => Boolean(image.dataUrl));
    const firstImage = displayImages[0];
    const [expanded, setExpanded] = useState(false);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const [categoryName, setCategoryName] = useState("");
    const [detailOpen, setDetailOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [promptEditorOpen, setPromptEditorOpen] = useState(false);
    const [promptDraft, setPromptDraft] = useState(log.prompt);
    const categoryMenuRef = useRef<HTMLDivElement>(null);
    const logCategories = categories.filter((category) => log.categoryIds.includes(category.id));
    const sortedHistoryLogs = useMemo(() => sortLogVersions(historyLogs), [historyLogs]);
    const createCategory = async () => {
        const category = await onCreateCategory(categoryName);
        if (!category) return;
        setCategoryName("");
        onToggleCategory(category.id);
        setCategoryOpen(false);
    };
    const closeThen = (action: () => void) => {
        setCategoryOpen(false);
        action();
    };

    useEffect(() => {
        if (!categoryOpen) return;
        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!categoryMenuRef.current?.contains(event.target as Node)) setCategoryOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutsidePointer);
        return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
    }, [categoryOpen]);

    useEffect(() => {
        if (!promptEditorOpen) setPromptDraft(log.prompt);
    }, [log.prompt, promptEditorOpen]);

    return (
        <div className={`relative overflow-visible rounded-lg border bg-background dark:bg-stone-950 ${active ? "border-stone-900 dark:border-stone-100" : "border-stone-200 dark:border-stone-800"}`}>
            <div className="relative aspect-[4/3] overflow-hidden rounded-t-lg bg-stone-100 dark:bg-stone-900">
                <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-white/85 px-1.5 py-1 shadow-sm dark:bg-stone-950/80">
                    <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                    {selected ? <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={onDelete} /> : null}
                </div>
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                    <Tag className="m-0 text-[10px]" color={log.failCount ? "red" : "blue"}>
                        {log.failCount ? `失败 ${log.failCount}` : "成功"}
                    </Tag>
                    {sortedHistoryLogs.length > 1 ? (
                        <Tag className="m-0 text-[10px]">
                            版本 {resolveLogVersionNo(log)}/{sortedHistoryLogs.length}
                        </Tag>
                    ) : null}
                    <Tag className="m-0 text-[10px]">{log.imageCount} 张</Tag>
                </div>
                {firstImage ? (
                    <Image src={firstImage.dataUrl} alt={`历史结果 ${index + 1}`} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} />
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 p-5 text-center text-sm text-red-500">
                        <AlertCircle className="size-7" />
                        <span>{log.errors[0] || "没有可显示的图片"}</span>
                    </div>
                )}
                {displayImages.length > 1 ? (
                    <div className="absolute bottom-1.5 left-1.5 right-1.5 flex gap-1 overflow-hidden">
                        {displayImages.slice(0, 4).map((image) => (
                            <img key={image.id} src={image.dataUrl} alt="" className="size-8 shrink-0 rounded border border-white/80 object-cover shadow-sm dark:border-stone-900/80" />
                        ))}
                    </div>
                ) : null}
            </div>
            <div className="space-y-2 border-t border-stone-200 p-2.5 text-xs dark:border-stone-800">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{log.prompt}</div>
                {log.references.some((item) => Boolean(item.dataUrl)) ? (
                    <ReferenceStrip className="border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/70" references={log.references.filter((item) => Boolean(item.dataUrl))} compact />
                ) : null}
                <div className="flex items-center justify-end gap-1">
                    <Button size="small" type="text" icon={<PenLine className="size-3.5" />} onClick={() => closeThen(() => setPromptEditorOpen(true))}>
                        修改
                    </Button>
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => closeThen(() => void onCopyPrompt(log.prompt))}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => closeThen(() => setExpanded((value) => !value))}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400">
                    {logCategories.length ? (
                        logCategories.map((category) => (
                            <Tag key={category.id} className="m-0 text-[10px]" color="purple">
                                {category.name}
                            </Tag>
                        ))
                    ) : (
                        <Tag className="m-0 text-[10px]">未分类</Tag>
                    )}
                    <span>{formatLogTime(log.createdAt)}</span>
                    <span>{formatDuration(log.durationMs)}</span>
                </div>
                {log.errors[0] ? (
                    <div className="flex items-start justify-between gap-2 rounded-md bg-red-100 px-2 py-1 text-red-600 dark:bg-red-950/40 dark:text-red-300">
                        <span className="line-clamp-2 min-w-0">{log.errors[0]}</span>
                        <Button size="small" type="text" className="!h-auto !p-0 text-xs" onClick={() => setDetailOpen(true)}>
                            详情
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div ref={categoryMenuRef} className="relative flex flex-wrap gap-1">
                    <Button size="small" onClick={() => closeThen(onPreview)}>
                        载入
                    </Button>
                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => closeThen(onRetry)}>
                        重试
                    </Button>
                    <Button size="small" icon={<History className="size-3.5" />} onClick={() => closeThen(() => setHistoryOpen(true))}>
                        历史{sortedHistoryLogs.length > 1 ? ` ${sortedHistoryLogs.length}` : ""}
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setCategoryOpen((value) => !value)}>
                        分类
                    </Button>
                    <ParameterButton
                        items={[
                            { label: "模型", value: log.model },
                            { label: "接口", value: log.config.apiMode === "responses" ? "Responses" : "Images" },
                            { label: "请求尺寸", value: log.config.size || "auto" },
                            { label: "实际像素", value: firstImage ? `${firstImage.width}x${firstImage.height}` : "" },
                            { label: "分辨率", value: imageResolutionLabel(log.config.size || "auto") },
                            { label: "格式", value: log.config.outputFormat || "png" },
                            { label: "压缩", value: (log.config.outputFormat || "png") !== "png" ? log.config.outputCompression || "100" : "" },
                            { label: "审核", value: log.config.moderation || "auto" },
                            { label: "超时", value: `${log.config.timeout || "600"}s` },
                            { label: "耗时", value: formatDuration(log.durationMs) },
                            { label: "工作流", value: log.workflowName || "" },
                        ]}
                    />
                    {categoryOpen ? (
                        <div className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-lg border border-stone-200 bg-background p-2 shadow-2xl dark:border-stone-800 dark:bg-stone-950">
                            <div className="max-h-44 space-y-1 overflow-y-auto">
                                {categories.map((category) => (
                                    <label key={category.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-stone-100 dark:hover:bg-stone-900">
                                        <Checkbox checked={log.categoryIds.includes(category.id)} onChange={() => closeThen(() => onToggleCategory(category.id))} />
                                        <span className="truncate">{category.name}</span>
                                    </label>
                                ))}
                                {!categories.length ? <div className="px-2 py-3 text-center text-xs text-stone-500">暂无分类</div> : null}
                            </div>
                            <div className="mt-2 flex gap-1 border-t border-stone-200 pt-2 dark:border-stone-800">
                                <Input size="small" value={categoryName} placeholder="新分类" onChange={(event) => setCategoryName(event.target.value)} onPressEnter={() => void createCategory()} />
                                <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => void createCategory()} />
                            </div>
                            <Button size="small" type="link" className="!mt-1 !h-auto !p-0 text-xs" onClick={() => closeThen(onClearCategories)}>
                                移至未分类
                            </Button>
                        </div>
                    ) : null}
                </div>
                {firstImage ? (
                    <div className="flex shrink-0 gap-1">
                        <Button size="small" loading={linkingImageId === firstImage.id} icon={<Link2 className="size-3.5" />} onClick={() => closeThen(() => void onCopyLink(firstImage, index))} />
                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => closeThen(() => void onSaveAsset(firstImage, index))} />
                        <Button size="small" icon={<ImagePlus className="size-3.5" />} onClick={() => closeThen(() => void onEdit(firstImage, index))} />
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => closeThen(() => onDownload(firstImage, index))} />
                    </div>
                ) : null}
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{formatFailureDetailText(log.errorDetails?.[0], log.errors[0])}</pre>
            </Modal>
            <VersionHistoryModal
                open={historyOpen}
                currentLogId={log.id}
                logs={sortedHistoryLogs}
                onClose={() => setHistoryOpen(false)}
                onPreviewLog={(historyLog) => {
                    setHistoryOpen(false);
                    onPreviewHistoryLog(historyLog);
                }}
                onRetryLog={(historyLog) => {
                    setHistoryOpen(false);
                    onRetryHistoryLog(historyLog);
                }}
                onCopyPrompt={onCopyPrompt}
                onDownload={onDownload}
                onCopyLink={onCopyLink}
                linkingImageId={linkingImageId}
            />
            <Modal
                title="修改提示词"
                open={promptEditorOpen}
                width={760}
                onCancel={() => setPromptEditorOpen(false)}
                onOk={() => {
                    void Promise.resolve(onUpdatePrompt(promptDraft)).then((updated) => {
                        if (updated) setPromptEditorOpen(false);
                    });
                }}
                okText="保存"
                cancelText="取消"
            >
                <Input.TextArea value={promptDraft} rows={8} onChange={(event) => setPromptDraft(event.target.value)} placeholder="输入新的提示词" />
            </Modal>
        </div>
    );
}

function VersionHistoryModal({
    open,
    currentLogId,
    logs,
    onClose,
    onPreviewLog,
    onRetryLog,
    onCopyPrompt,
    onDownload,
    onCopyLink,
    linkingImageId,
}: {
    open: boolean;
    currentLogId: string;
    logs: GenerationLog[];
    onClose: () => void;
    onPreviewLog: (log: GenerationLog) => void;
    onRetryLog: (log: GenerationLog) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onDownload: (image: GeneratedImage, index: number) => void;
    onCopyLink: (image: GeneratedImage, index: number) => void | Promise<void>;
    linkingImageId: string;
}) {
    const sortedLogs = sortLogVersions(logs);
    return (
        <Modal title={`历史版本（${sortedLogs.length}）`} open={open} width={960} footer={null} onCancel={onClose}>
            {sortedLogs.length ? (
                <div className="grid max-h-[70vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                    {sortedLogs.map((historyLog) => {
                        const image = historyLog.images.find((item) => Boolean(item.dataUrl));
                        const isCurrent = historyLog.id === currentLogId;
                        return (
                            <div key={historyLog.id} className={cn("overflow-hidden rounded-xl border bg-background dark:bg-stone-950", isCurrent ? "border-sky-500 shadow-[0_0_0_1px_rgba(14,165,233,.35)]" : "border-stone-200 dark:border-stone-800")}>
                                <div className="relative aspect-square bg-stone-100 dark:bg-stone-900">
                                    <div className="absolute left-2 top-2 z-10 flex flex-wrap gap-1">
                                        <Tag className="m-0 text-[10px]" color={isCurrent ? "blue" : "default"}>
                                            版本 {resolveLogVersionNo(historyLog)}
                                        </Tag>
                                        {isCurrent ? (
                                            <Tag className="m-0 text-[10px]" color="processing">
                                                当前
                                            </Tag>
                                        ) : null}
                                        {historyLog.retryOfVersionNo ? <Tag className="m-0 text-[10px]">由 V{historyLog.retryOfVersionNo} 重试</Tag> : null}
                                    </div>
                                    {image ? (
                                        <Image src={image.dataUrl} alt={`版本 ${resolveLogVersionNo(historyLog)}`} wrapperStyle={fullImageWrapperStyle} style={fullImageContainStyle} />
                                    ) : (
                                        <div className="flex size-full flex-col items-center justify-center gap-2 p-5 text-center text-sm text-red-500">
                                            <AlertCircle className="size-7" />
                                            <span>{historyLog.errors[0] || "没有可显示的图片"}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-2 border-t border-stone-200 p-3 text-xs dark:border-stone-800">
                                    <div className="flex flex-wrap items-center gap-1 text-[11px] text-stone-500 dark:text-stone-400">
                                        <span>{formatLogTime(historyLog.createdAt)}</span>
                                        <span>{formatDuration(historyLog.durationMs)}</span>
                                        <Tag className="m-0 text-[10px]" color={historyLog.failCount ? "red" : "green"}>
                                            {historyLog.status}
                                        </Tag>
                                    </div>
                                    <div className="line-clamp-2 whitespace-pre-wrap text-stone-700 dark:text-stone-200">{historyLog.prompt}</div>
                                    <div className="flex flex-wrap gap-1">
                                        <Button size="small" onClick={() => onPreviewLog(historyLog)}>
                                            载入
                                        </Button>
                                        <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => onRetryLog(historyLog)}>
                                            重试
                                        </Button>
                                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(historyLog.prompt)}>
                                            复制
                                        </Button>
                                        <Button size="small" loading={Boolean(image && linkingImageId === image.id)} icon={<Link2 className="size-3.5" />} disabled={!image} onClick={() => image && void onCopyLink(image, 0)} />
                                        <Button size="small" icon={<Download className="size-3.5" />} disabled={!image} onClick={() => image && onDownload(image, 0)} />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <Empty description="暂无历史版本" />
            )}
        </Modal>
    );
}

function createPendingResult(
    id: string,
    snapshot: RequestSnapshot,
    status: "waiting" | "running" = "waiting",
    overrides?: Partial<Pick<GenerationResult, "createdAt" | "startedAt" | "logId" | "versionGroupId" | "versionNo" | "retryOfLogId" | "retryOfVersionNo">>,
): GenerationResult {
    const createdAt = overrides?.createdAt || Date.now();
    return {
        id,
        status,
        createdAt,
        startedAt: overrides?.startedAt ?? (status === "running" ? createdAt : undefined),
        prompt: snapshot.text,
        model: snapshot.displayConfig.imageModel || snapshot.displayConfig.model,
        config: snapshot.displayConfig,
        references: snapshot.references,
        logId: overrides?.logId,
        versionGroupId: overrides?.versionGroupId,
        versionNo: overrides?.versionNo,
        retryOfLogId: overrides?.retryOfLogId,
        retryOfVersionNo: overrides?.retryOfVersionNo,
    };
}

function isProductPackageTask(task: WorkflowExternalTaskStart) {
    if (!task.seriesIndex) return false;
    const text = `${task.workflowName} ${Object.values(task.inputs || {}).join(" ")}`.toLowerCase();
    return task.workflowMode === "multi_image_series" && (/图包|主图|副图|详情图|保健|健康|消字号|产品/.test(text) || (task.seriesTotal || 0) >= 12);
}

function mergeProductPackages(livePackages: ProductImagePackage[], historyPackages: ProductImagePackage[]) {
    const byId = new Map<string, ProductImagePackage>();
    historyPackages.forEach((pkg) => byId.set(pkg.id, pkg));
    livePackages.forEach((pkg) => byId.set(pkg.id, pkg));
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function buildHistoryProductPackages(logs: GenerationLog[]) {
    const groups = new Map<string, GenerationLog[]>();
    logs.filter(isProductPackageHistoryLog).forEach((log) => {
        const key = historyProductPackageKey(log);
        groups.set(key, [...(groups.get(key) || []), log]);
    });
    return [...groups.entries()]
        .map(([packageId, packageLogs]) => buildHistoryProductPackage(packageId, packageLogs))
        .filter((pkg): pkg is ProductImagePackage => Boolean(pkg))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

function buildPackageItemHistoryMap(logs: GenerationLog[], packageId: string) {
    const groups = new Map<number, GenerationLog[]>();
    logs.filter((log) => isProductPackageHistoryLog(log) && historyProductPackageKey(log) === packageId).forEach((log) => {
        const index = resolveHistorySeriesIndex(log);
        if (!index) return;
        groups.set(index, [...(groups.get(index) || []), log]);
    });
    groups.forEach((items, index) => groups.set(index, sortPackageItemHistoryLogs(items)));
    return groups;
}

function packageItemHistoryLogs(logs: GenerationLog[], packageId: string, itemIndex: number) {
    return sortPackageItemHistoryLogs(logs.filter((log) => isProductPackageHistoryLog(log) && historyProductPackageKey(log) === packageId && resolveHistorySeriesIndex(log) === itemIndex));
}

function sortPackageItemHistoryLogs(logs: GenerationLog[]) {
    return [...logs].sort((a, b) => resolveLogVersionNo(a) - resolveLogVersionNo(b) || a.createdAt - b.createdAt);
}

function packageItemVersionGroupId(packageId: string, itemIndex: number) {
    return `${packageId}:${itemIndex}`;
}

function buildPackageItemRetryVersionMeta(packageId: string, itemIndex: number, sourceLog: GenerationLog | undefined, historyLogs: GenerationLog[]) {
    const versionGroupId = sourceLog?.versionGroupId || packageItemVersionGroupId(packageId, itemIndex);
    const relatedLogs = historyLogs.filter((log) => (log.versionGroupId || packageItemVersionGroupId(historyProductPackageKey(log), resolveHistorySeriesIndex(log))) === versionGroupId);
    const maxVersionNo = Math.max(1, ...relatedLogs.map(resolveLogVersionNo), ...(sourceLog ? [resolveLogVersionNo(sourceLog)] : []));
    return {
        versionGroupId,
        nextVersionNo: maxVersionNo + 1,
        retryOfLogId: sourceLog?.id,
        retryOfVersionNo: sourceLog ? resolveLogVersionNo(sourceLog) : undefined,
    };
}

function resolvePackageHistoryVersionLabel(log: GenerationLog, fallbackIndex: number) {
    const versionNo = Number(log.versionNo);
    return `版本 ${Number.isFinite(versionNo) && versionNo > 0 ? Math.floor(versionNo) : fallbackIndex + 1}`;
}

function buildHistoryProductPackage(packageId: string, packageLogs: GenerationLog[]): ProductImagePackage | null {
    const logs = [...packageLogs].sort((a, b) => resolveHistorySeriesIndex(a) - resolveHistorySeriesIndex(b) || a.createdAt - b.createdAt);
    const firstLog = logs[0];
    if (!firstLog) return null;
    const isFolderPackage = firstLog.workflowId === folderPackageWorkflowId;
    const maxIndex = Math.max(isFolderPackage ? 1 : 16, ...logs.map(resolveHistorySeriesIndex));
    const itemByIndex = new Map<number, ProductPackageItem>();
    logs.forEach((log) => {
        const index = resolveHistorySeriesIndex(log);
        if (!index) return;
        itemByIndex.set(index, buildHistoryPackageItem(packageId, log, index));
    });
    const inputs = normalizePackageInputs(firstLog.workflowInputs);
    const productName = resolvePackageProductName(inputs) || "未命名产品";
    const updatedAt = Math.max(...logs.map((log) => log.createdAt + (log.durationMs || 0)));
    return {
        id: packageId,
        workflowId: firstLog.workflowId || "",
        workflowName: firstLog.workflowName || "工作流",
        packageName: isFolderPackage ? `${productName || firstLog.workflowName || "产品"}-套图生成` : `${productName || firstLog.workflowName || "产品"}-产品图包`,
        productName,
        inputs,
        references: firstLog.references || [],
        model: firstLog.model || firstLog.config.imageModel || firstLog.config.model,
        config: firstLog.config,
        createdAt: Math.min(...logs.map((log) => log.createdAt)),
        updatedAt,
        totalCount: maxIndex,
        items: Array.from({ length: maxIndex }, (_, offset) => {
            const index = offset + 1;
            return itemByIndex.get(index) || createHistoryPackagePlaceholderItem(packageId, index, firstLog);
        }),
    };
}

function buildHistoryPackageItem(packageId: string, log: GenerationLog, index: number): ProductPackageItem {
    const image = log.images[0];
    const group = resolveHistoryPackageGroup(log, index);
    return {
        id: `${packageId}:${index}`,
        logId: log.id,
        group,
        index,
        groupIndex: resolveHistoryGroupIndex(log, index),
        title: resolveHistorySeriesTitle(log, index),
        prompt: log.prompt,
        model: log.model || log.config.imageModel || log.config.model,
        config: buildPackageItemConfig(log.config, index),
        references: log.references || [],
        status: image ? "success" : "failed",
        image,
        error: log.errors[0],
        errorDetail: log.errorDetails?.[0],
        startedAt: log.createdAt,
        endedAt: log.createdAt + (log.durationMs || 0),
        durationMs: log.durationMs,
        sourceFolderName: typeof log.workflowInputs?.sourceFolderName === "string" ? log.workflowInputs.sourceFolderName : undefined,
        sourceFileName: typeof log.workflowInputs?.sourceFileName === "string" ? log.workflowInputs.sourceFileName : undefined,
    };
}

function createHistoryPackagePlaceholderItem(packageId: string, index: number, log: GenerationLog): ProductPackageItem {
    return {
        id: `${packageId}:${index}`,
        group: packageGroupFromIndex(index),
        index,
        groupIndex: packageGroupIndex(index),
        title: defaultPackageItemTitle(index),
        prompt: "",
        model: log.model || log.config.imageModel || log.config.model,
        config: buildPackageItemConfig(log.config, index),
        references: log.references || [],
        status: "waiting",
    };
}

function isProductPackageHistoryLog(log: GenerationLog) {
    const index = resolveHistorySeriesIndex(log);
    if (!index || !log.workflowId) return false;
    const inputText = Object.values(log.workflowInputs || {})
        .map((value) => String(value || ""))
        .join(" ");
    const text = `${log.workflowName || ""} ${log.title || ""} ${inputText}`.toLowerCase();
    return /图包|套图|主图|副图|详情图|sku|保健|健康|消字号|产品|product package/.test(text);
}

function historyProductPackageKey(log: GenerationLog) {
    if (log.workflowSeriesRunId) return log.workflowSeriesRunId;
    const inputs = normalizePackageInputs(log.workflowInputs);
    const productName = resolvePackageProductName(inputs) || "product";
    const timeBucket = Math.floor((log.createdAt || 0) / (30 * 60 * 1000));
    return `history:${log.workflowId || log.workflowName || "workflow"}:${productName}:${timeBucket}`;
}

function resolveHistorySeriesIndex(log: GenerationLog) {
    const raw = log.workflowInputs?.seriesIndex;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const text = `${log.workflowInputs?.seriesTitle || ""} ${log.title || ""}`;
    const detail = text.match(/详情图\s*(\d+)/);
    if (detail) return 5 + Number(detail[1]);
    const sub = text.match(/副图\s*(\d+)/);
    if (sub) return 1 + Number(sub[1]);
    if (/主图/.test(text)) return 1;
    return 0;
}

function resolveHistorySeriesTitle(log: GenerationLog, index: number) {
    const raw = log.workflowInputs?.seriesTitle;
    const title = typeof raw === "string" ? raw.trim() : "";
    return title || defaultPackageItemTitle(index);
}

function resolveHistoryPackageGroup(log: GenerationLog, index: number): ProductPackageGroup {
    const group = log.workflowInputs?.seriesGroup;
    return isProductPackageGroup(group) ? group : packageGroupFromIndex(index);
}

function resolveHistoryGroupIndex(log: GenerationLog, index: number) {
    const raw = Number(log.workflowInputs?.groupIndex);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : packageGroupIndex(index);
}

function upsertProductPackageTask(packages: ProductImagePackage[], task: WorkflowExternalTaskStart, configSnapshot: GenerationLogConfig, packageId: string): ProductImagePackage[] {
    const totalCount = Math.max(task.seriesTotal || 16, task.seriesIndex || 1);
    const existing = packages.find((item) => item.id === packageId);
    const productName = resolvePackageProductName(task.inputs);
    const packageName = `${productName || task.workflowName || "产品"}-产品图包`;
    const baseItems = existing?.items.length ? existing.items : createPackagePlaceholderItems(totalCount, task, configSnapshot);
    const nextItems = baseItems.map((item) => {
        if (item.index !== task.seriesIndex) return item;
        return {
            ...item,
            taskId: task.taskId,
            title: task.seriesTitle || item.title,
            prompt: task.prompt,
            model: task.model,
            config: configSnapshot,
            references: task.references || [],
            status: "running" as const,
            startedAt: task.startedAt,
            error: undefined,
            errorDetail: undefined,
        };
    });
    const nextPackage: ProductImagePackage = {
        id: packageId,
        workflowId: task.workflowId,
        workflowName: task.workflowName,
        packageName,
        productName: productName || "未命名产品",
        inputs: task.inputs || {},
        references: task.references || [],
        model: task.model,
        config: configSnapshot,
        createdAt: existing?.createdAt || task.startedAt,
        updatedAt: task.startedAt,
        totalCount,
        items: nextItems,
    };
    return existing ? packages.map((item) => (item.id === packageId ? nextPackage : item)) : [nextPackage, ...packages];
}

function createPackagePlaceholderItems(totalCount: number, task: WorkflowExternalTaskStart, configSnapshot: GenerationLogConfig): ProductPackageItem[] {
    return Array.from({ length: totalCount }, (_, offset) => {
        const index = offset + 1;
        const group = packageGroupFromIndex(index);
        const groupIndex = packageGroupIndex(index);
        return {
            id: `${task.seriesRunId || task.workflowId}:${index}`,
            group,
            index,
            groupIndex,
            title: defaultPackageItemTitle(index),
            prompt: "",
            model: task.model,
            config: buildPackageItemConfig(configSnapshot, index),
            references: task.references || [],
            status: "waiting" as const,
        };
    });
}

function buildPackageItemConfig(config: GenerationLogConfig, index: number): GenerationLogConfig {
    return { ...config, size: index >= 6 ? "9:16" : "1:1", count: "1" };
}

function packageGroupFromIndex(index: number): ProductPackageGroup {
    if (index === 1) return "main";
    if (index <= 5) return "sub";
    return "detail";
}

function isProductPackageGroup(value: unknown): value is ProductPackageGroup {
    return typeof value === "string" && packageGroupOrder.includes(value as ProductPackageGroup);
}

function packageGroupIndex(index: number) {
    if (index === 1) return 1;
    if (index <= 5) return index - 1;
    return index - 5;
}

function defaultPackageItemTitle(index: number) {
    if (index === 1) return "主图";
    if (index <= 5) return `副图${index - 1}`;
    return `详情图${index - 5}`;
}

function packageInputLabel(key: string) {
    const labels: Record<string, string> = {
        product_name: "产品名称",
        product_type: "产品类型",
        selling_points: "核心卖点",
        specs: "规格信息",
        target_people: "适用人群",
        style: "视觉风格",
        notes: "补充要求",
    };
    return labels[key] || key;
}

function buildPackageQuickStartInputs(draft: PackageQuickStartDraft) {
    return {
        product_name: draft.productName.trim(),
        product_type: draft.productType.trim(),
        selling_points: draft.sellingPoints.trim(),
        specs: draft.specs.trim(),
        target_people: draft.targetPeople.trim(),
        style: draft.style.trim(),
        notes: draft.notes.trim(),
    };
}

function createQuickStartPackageItems({ packageId, draft, references, model, config }: { packageId: string; draft: PackageQuickStartDraft; references: ReferenceImage[]; model: string; config: GenerationLogConfig }) {
    const prompts = buildQuickStartPackagePrompts(draft);
    const startedAt = Date.now();
    return prompts.map((prompt, offset) => {
        const index = offset + 1;
        const group = packageGroupFromIndex(index);
        return {
            id: `${packageId}:${index}`,
            group,
            index,
            groupIndex: packageGroupIndex(index),
            title: defaultPackageItemTitle(index),
            prompt,
            model,
            config: buildPackageItemConfig(config, index),
            references,
            status: index === 1 ? ("running" as const) : ("waiting" as const),
            startedAt: index === 1 ? startedAt : undefined,
        };
    });
}

function buildQuickStartPackagePrompts(draft: PackageQuickStartDraft) {
    const productName = draft.productName.trim() || "产品";
    const productType = draft.productType.trim() || "健康护理产品";
    const sellingPoints = draft.sellingPoints.trim() || "突出核心卖点、包装质感、规格信息";
    const specs = draft.specs.trim() || "规格信息按包装真实表达";
    const targetPeople = draft.targetPeople.trim() || "适合目标用户日常使用";
    const style = draft.style.trim() || "高级感电商产品摄影，干净可信";
    const notes = draft.notes.trim() || "避免治疗承诺、医疗暗示、夸大表述";
    const consistency = `严格参考上传产品图，保持包装外观、瓶身/盒型、标签信息、品牌配色一致。`;
    const compliance = `文案表达适合保健品/健康护理/消字号电商场景，${notes}。`;
    const summary = `产品名称：${productName}。产品类型：${productType}。核心卖点：${sellingPoints}。规格信息：${specs}。适用人群：${targetPeople}。视觉风格：${style}。`;

    const prompts = [
        `任务：生成【主图】。1:1 电商主图，白底或浅底，产品居中完整清晰，包装质感高级，少量合规短文案。${summary}${consistency}${compliance}`,
        `任务：生成【副图1】。1:1 卖点图，突出 ${sellingPoints}，信息层级清晰，商业化构图，保留真实产品包装。${consistency}${compliance}`,
        `任务：生成【副图2】。1:1 成分/规格图，围绕 ${specs} 做清晰模块化展示，可辅助轻量图形，但主视觉仍是产品本体。${consistency}${compliance}`,
        `任务：生成【副图3】。1:1 使用场景图，表达 ${targetPeople} 的日常使用氛围，画面干净有生活感，产品主体清晰。${consistency}${compliance}`,
        `任务：生成【副图4】。1:1 信任感/质感展示，强调品牌感、包装细节、材质和高级感，不要做成药品海报。${consistency}${compliance}`,
        `任务：生成【详情图1】。9:16 详情页封面长图，总览 ${productName} 的核心利益点和包装形象，适合电商详情页第一屏。${summary}${consistency}${compliance}`,
        `任务：生成【详情图2】。9:16 详情页卖点模块，分点拆解 ${sellingPoints}，一屏只讲一个重点，信息清晰。${consistency}${compliance}`,
        `任务：生成【详情图3】。9:16 成分/配方模块，围绕 ${productType} 的常见关注点展开说明，避免医疗功效承诺。${consistency}${compliance}`,
        `任务：生成【详情图4】。9:16 规格参数模块，清晰展示 ${specs}，版式适合电商详情页向下阅读。${consistency}${compliance}`,
        `任务：生成【详情图5】。9:16 适用人群模块，围绕 ${targetPeople} 做场景化表达，语气克制可信。${consistency}${compliance}`,
        `任务：生成【详情图6】。9:16 使用方式模块，展示食用/使用步骤与频次，信息分段明确。${consistency}${compliance}`,
        `任务：生成【详情图7】。9:16 产品质感模块，重点表现包装、瓶身、标签、开盒或细节特写。${consistency}${compliance}`,
        `任务：生成【详情图8】。9:16 使用场景模块，强化办公室、居家、通勤等贴近日常的健康护理场景。${consistency}${compliance}`,
        `任务：生成【详情图9】。9:16 购买理由模块，归纳卖点、便携性、包装感、适合送礼或自用等电商表达。${consistency}${compliance}`,
        `任务：生成【详情图10】。9:16 注意事项模块，展示存放方式、食用/使用提醒、合规说明等，避免夸张语气。${consistency}${compliance}`,
        `任务：生成【详情图11】。9:16 收尾转化模块，总结 ${productName} 的视觉调性和核心价值，适合详情页结尾。${consistency}${compliance}`,
    ];

    return prompts;
}

function normalizePackageInputs(inputs?: Record<string, unknown>): Record<string, string> {
    const ignored = new Set(["seriesTitle", "seriesIndex", "seriesTotal"]);
    return Object.fromEntries(
        Object.entries(inputs || {})
            .filter(([key, value]) => !ignored.has(key) && String(value || "").trim())
            .map(([key, value]) => [key, String(value).trim()]),
    );
}

function resolvePackageProductName(inputs?: Record<string, unknown>) {
    const candidates = ["product_name", "productName", "name", "产品名称", "product"];
    for (const key of candidates) {
        const value = inputs?.[key];
        if (String(value || "").trim()) return String(value).trim();
    }
    return "";
}

function getPackageStats(pkg: ProductImagePackage) {
    const success = pkg.items.filter((item) => item.status === "success").length;
    const failed = pkg.items.filter((item) => item.status === "failed").length;
    const running = pkg.items.filter((item) => item.status === "running").length;
    const waiting = pkg.items.filter((item) => item.status === "waiting").length;
    return { success, failed, running, waiting, total: pkg.items.length, percent: pkg.items.length ? Math.round((success / pkg.items.length) * 100) : 0 };
}

function getVisiblePackageItems(pkg: ProductImagePackage) {
    return pkg.items.filter(shouldDisplayPackageItem);
}

function getVisiblePackageStats(pkg: ProductImagePackage) {
    const items = getVisiblePackageItems(pkg);
    const success = items.filter((item) => item.status === "success").length;
    const failed = items.filter((item) => item.status === "failed").length;
    const running = items.filter((item) => item.status === "running").length;
    const waiting = items.filter((item) => item.status === "waiting").length;
    return { success, failed, running, waiting, total: items.length, percent: items.length ? Math.round((success / items.length) * 100) : 0 };
}

function getVisiblePackageGroupCounts(pkg: ProductImagePackage) {
    const items = getVisiblePackageItems(pkg);
    return packageGroupOrder.reduce(
        (counts, group) => {
            counts[group] = items.filter((item) => item.group === group).length;
            return counts;
        },
        { main: 0, sub: 0, detail: 0, sku: 0, other: 0 } as Record<ProductPackageGroup, number>,
    );
}

function clonePackageForRetry(packageData: ProductImagePackage): ProductImagePackage {
    return {
        ...packageData,
        references: [...packageData.references],
        items: packageData.items.map((item) => ({
            ...item,
            references: [...item.references],
            image: item.image ? { ...item.image } : undefined,
        })),
    };
}

function reconcileProductPackagesAfterLogDeletion(packages: ProductImagePackage[], nextLogs: GenerationLog[], deletedLogIds: Set<string>, selectedPackageIds: Set<string> = new Set()) {
    const nextLogIds = new Set(nextLogs.map((log) => log.id));
    return packages.flatMap((pkg) => {
        if (selectedPackageIds.has(pkg.id)) return [];
        let touched = false;
        const nextItems = pkg.items.map((item) => {
            if (!item.logId || !deletedLogIds.has(item.logId)) return item;
            touched = true;
            return {
                ...item,
                logId: undefined,
                taskId: undefined,
                prompt: "",
                status: "waiting" as const,
                image: undefined,
                error: undefined,
                errorDetail: undefined,
                startedAt: undefined,
                endedAt: undefined,
                durationMs: undefined,
            };
        });
        if (!touched) return [pkg];
        const hasRemainingLinkedItems = nextItems.some((item) => item.logId && nextLogIds.has(item.logId));
        const hasActiveItems = nextItems.some((item) => item.status === "running");
        const hasVisibleItems = nextItems.some(shouldDisplayPackageItem);
        if (!hasRemainingLinkedItems && !hasActiveItems && !hasVisibleItems) return [];
        return [{ ...pkg, updatedAt: Date.now(), items: nextItems }];
    });
}

function upsertRetriedPackage(packages: ProductImagePackage[], packageData: ProductImagePackage, itemId: string, patch: Partial<ProductPackageItem>) {
    const existing = packages.find((item) => item.id === packageData.id);
    const base = existing || packageData;
    const nextPackage: ProductImagePackage = {
        ...base,
        updatedAt: patch.endedAt || patch.startedAt || Date.now(),
        items: base.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    };
    return existing ? packages.map((item) => (item.id === packageData.id ? nextPackage : item)) : [nextPackage, ...packages];
}

function findPackageLogForRetry(logs: GenerationLog[], packageId: string, item: ProductPackageItem) {
    if (item.logId) {
        const exact = logs.find((log) => log.id === item.logId);
        if (exact) return exact;
    }
    return [...logs].filter((log) => isProductPackageHistoryLog(log) && historyProductPackageKey(log) === packageId && resolveHistorySeriesIndex(log) === item.index).sort((a, b) => b.createdAt - a.createdAt)[0];
}

function buildPackageRetryLog({
    baseLog,
    logId,
    packageData,
    item,
    prompt,
    model,
    config,
    references,
    images,
    durationMs,
    errors,
    errorDetails,
    status,
    versionGroupId,
    versionNo,
    retryOfLogId,
    retryOfVersionNo,
}: {
    baseLog?: GenerationLog;
    logId: string;
    packageData: ProductImagePackage;
    item: ProductPackageItem;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    images: GeneratedImage[];
    durationMs: number;
    errors: string[];
    errorDetails: string[];
    status: GenerationLog["status"];
    versionGroupId?: string;
    versionNo?: number;
    retryOfLogId?: string;
    retryOfVersionNo?: number;
}): GenerationLog {
    return {
        id: logId,
        createdAt: Date.now(),
        title: `${packageData.workflowName || "工作流"} · ${item.title}`,
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config,
        references,
        durationMs,
        successCount: images.length,
        failCount: status === "失败" ? 1 : 0,
        imageCount: 1,
        size: config.size,
        quality: config.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors,
        errorDetails,
        categoryIds: baseLog?.categoryIds || [],
        workflowId: packageData.workflowId || baseLog?.workflowId,
        workflowName: packageData.workflowName || baseLog?.workflowName,
        workflowInputs: { ...packageData.inputs, seriesTitle: item.title, seriesIndex: item.index, seriesGroup: item.group, groupIndex: item.groupIndex, sourceFolderName: item.sourceFolderName, sourceFileName: item.sourceFileName },
        workflowSeriesRunId: packageData.id || baseLog?.workflowSeriesRunId,
        versionGroupId: versionGroupId || baseLog?.versionGroupId || packageItemVersionGroupId(packageData.id, item.index),
        versionNo: versionNo || baseLog?.versionNo || 1,
        retryOfLogId,
        retryOfVersionNo,
    };
}

function generationLogStorageKeys(log: GenerationLog) {
    return [...log.images.map((image) => image.storageKey), ...log.references.filter(isDisposableReferenceFile).map((image) => image.storageKey)].filter((key): key is string => Boolean(key));
}

function generationResultStorageKeys(result: GenerationResult) {
    return [result.image?.storageKey, ...result.references.filter(isDisposableReferenceFile).map((image) => image.storageKey)].filter((key): key is string => Boolean(key));
}

function referenceUsedByGeneration(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    return logs.some((log) => log.references.some((item) => item.storageKey === reference.storageKey)) || results.some((result) => result.references.some((item) => item.storageKey === reference.storageKey));
}

function shouldDeleteReferenceFile(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    if (!isDisposableReferenceFile(reference)) return false;
    return !referenceUsedByGeneration(reference, logs, results);
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    return reference.temporary === true || reference.source === "upload" || reference.source === "clipboard";
}

function disposableLogStorageKeys(deletedLogs: GenerationLog[], remainingLogs: GenerationLog[], protectedKeys: Iterable<string> = []) {
    const deletedKeys = new Set(deletedLogs.flatMap(generationLogStorageKeys));
    const retainedKeys = new Set([...remainingLogs.flatMap(generationLogStorageKeys), ...protectedKeys]);
    return [...deletedKeys].filter((key) => !retainedKeys.has(key));
}

function disposableResultStorageKeys(deletedResults: GenerationResult[], protectedKeys: Iterable<string> = []) {
    const deletedKeys = new Set(deletedResults.flatMap(generationResultStorageKeys));
    const retainedKeys = new Set(protectedKeys);
    return [...deletedKeys].filter((key) => !retainedKeys.has(key));
}

function createWorkflowResultId(taskId: string, index: number) {
    return `${taskId}:${index}`;
}

function updateResult(results: GenerationResult[], id: string, next: Partial<GenerationResult>) {
    return results.map((item) => (item.id === id ? { ...item, ...next } : item));
}

function errorMessage(error: unknown) {
    if (error instanceof ImageRequestError) return error.message;
    if (error instanceof Error) return formatFailureSummaryText(error.message);
    return "生成失败";
}

function errorDetail(error: unknown) {
    if (error instanceof ImageRequestError) return formatFailureDetailText(error.detail, error.message);
    if (error instanceof Error) return formatFailureDetailText(error.stack || error.message, error.message);
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error || "生成失败");
    }
}

function formatFailureSummaryText(value?: string) {
    const text = (value || "").trim();
    if (!text) return "生成失败";
    if (/failed to fetch|load failed|networkerror when attempting to fetch resource/i.test(text)) {
        return "接口连接失败，请稍后重试";
    }
    return (
        text
            .split(/\r?\n/, 1)[0]
            .replace(/^Error:\s*/, "")
            .trim() || "生成失败"
    );
}

function formatFailureDetailText(detail?: string, fallback?: string) {
    const raw = `${detail || fallback || ""}`.trim();
    if (!raw) return "没有详情";
    const normalized = raw.replace(/\r\n/g, "\n");
    if (/failed to fetch|load failed|networkerror when attempting to fetch resource/i.test(normalized)) {
        return ["接口连接失败，前端没有拿到服务响应。", "常见原因：", "1. 页面打开后服务被重启或切换了端口", "2. 浏览器到当前站点的网络短暂中断", "3. 模型渠道接口暂时不可达", "", `原始错误：${formatFailureSummaryText(normalized)}`].join("\n");
    }
    if (/(^|\n)\s*at\s+.+:\d+:\d+/m.test(normalized)) {
        return formatFailureSummaryText(normalized);
    }
    return normalized;
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        const scope = currentImageHistoryScope();
        await logStore.iterate<GenerationLog, void>((value, key) => {
            if (!isHistoryLogKeyInScope(key, scope)) return;
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function readStoredCategories() {
    if (typeof window === "undefined") return [];
    try {
        const value = await categoryStore.getItem<GenerationCategory[]>(scopedImageHistoryCategoryKey());
        return Array.isArray(value) ? value.filter((item) => item.id && item.name).sort((a, b) => a.createdAt - b.createdAt) : [];
    } catch {
        return [];
    }
}

async function replaceStoredImageHistory(logs: GenerationLog[], categories: GenerationCategory[]) {
    if (typeof window === "undefined") return;
    await clearScopedStoredLogs();
    await Promise.all(logs.map((log) => logStore.setItem(scopedImageHistoryLogKey(log.id), serializeLog(log))));
    await categoryStore.setItem(scopedImageHistoryCategoryKey(), categories);
}

async function readStoredProductPackages() {
    if (typeof window === "undefined") return [];
    try {
        const value = await packageStore.getItem<ProductImagePackage[]>(scopedProductPackageStoreKey());
        return await normalizeProductPackages(Array.isArray(value) ? value : []);
    } catch {
        return [];
    }
}

async function replaceStoredProductPackages(packages: ProductImagePackage[]) {
    if (typeof window === "undefined") return;
    await packageStore.setItem(scopedProductPackageStoreKey(), packages.map(serializeProductPackage));
}

function scopedProductPackageStoreKey(scope = currentImageHistoryScope()) {
    return `${PACKAGE_STORE_KEY}:${scope}`;
}

async function clearScopedStoredLogs() {
    const scope = currentImageHistoryScope();
    const removableKeys: string[] = [];
    await logStore.iterate<GenerationLog, void>((_value, key) => {
        if (isHistoryLogKeyInScope(key, scope)) removableKeys.push(key);
    });
    await Promise.all(removableKeys.map((key) => logStore.removeItem(key)));
}

async function imageHistorySnapshot(logs: GenerationLog[], categories: GenerationCategory[], packages: ProductImagePackage[] = []) {
    return {
        logs: await Promise.all(logs.map(buildSyncableLog)),
        categories,
        packages: await Promise.all(packages.map(buildSyncableProductPackage)),
    };
}

function hasInlineImageData(log: Partial<GenerationLog>) {
    return [...(log.images || []), ...(log.references || [])].some((item) => item.dataUrl?.startsWith("data:image/"));
}

function hasUnsyncedLocalImages(log: Partial<GenerationLog>) {
    return [...(log.images || []), ...(log.references || [])].some((item) => item.storageKey?.startsWith("image:") && !item.dataUrl?.startsWith("data:image/"));
}

async function mergeGenerationLogs(remoteLogs: GenerationLog[], localLogs: GenerationLog[]) {
    const normalized = await Promise.all([...remoteLogs, ...localLogs].map(normalizeLog));
    const byId = new Map<string, GenerationLog>();
    for (const log of normalized) {
        const existing = byId.get(log.id);
        if (
            !existing ||
            log.createdAt > existing.createdAt ||
            (log.createdAt === existing.createdAt &&
                (log.images.length + log.failCount > existing.images.length + existing.failCount || (log.images.length + log.failCount === existing.images.length + existing.failCount && logImageDataScore(log) > logImageDataScore(existing))))
        ) {
            byId.set(log.id, log);
        }
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function mergeGenerationCategories(remoteCategories: GenerationCategory[], localCategories: GenerationCategory[]) {
    const byId = new Map<string, GenerationCategory>();
    [...remoteCategories, ...localCategories].forEach((category) => {
        if (category.id && category.name) byId.set(category.id, category);
    });
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

async function normalizeProductPackages(packages: Partial<ProductImagePackage>[]) {
    const normalized = await Promise.all(packages.map(normalizeProductPackage));
    return normalized.filter((pkg): pkg is ProductImagePackage => Boolean(pkg)).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function normalizeProductPackage(pkg: Partial<ProductImagePackage>): Promise<ProductImagePackage | null> {
    if (!pkg?.id) return null;
    const references = await normalizeStoredReferences(pkg.references);
    const items = await Promise.all((pkg.items || []).map((item, index) => normalizeProductPackageItem(pkg.id || "", item, index + 1, references)));
    const visibleItems = items.filter((item): item is ProductPackageItem => Boolean(item));
    if (!visibleItems.length) return null;
    const createdAt = Number(pkg.createdAt) || Date.now();
    return {
        id: pkg.id,
        workflowId: pkg.workflowId || folderPackageWorkflowId,
        workflowName: pkg.workflowName || "文件夹套图生成",
        packageName: pkg.packageName || `${pkg.productName || "未命名产品"}-套图生成`,
        productName: pkg.productName || resolvePackageProductName(pkg.inputs) || "未命名产品",
        inputs: normalizePackageInputs(pkg.inputs),
        references,
        model: pkg.model || pkg.config?.imageModel || pkg.config?.model || visibleItems[0]?.model || "",
        config: normalizeLogConfig({ config: pkg.config, model: pkg.model || visibleItems[0]?.model || "", imageCount: pkg.totalCount || visibleItems.length }),
        createdAt,
        updatedAt: Number(pkg.updatedAt) || createdAt,
        totalCount: Math.max(Number(pkg.totalCount) || 0, visibleItems.length),
        items: visibleItems,
    };
}

async function normalizeProductPackageItem(packageId: string, item: Partial<ProductPackageItem>, fallbackIndex: number, packageReferences: ReferenceImage[]): Promise<ProductPackageItem | null> {
    const index = Number(item.index) > 0 ? Math.floor(Number(item.index)) : fallbackIndex;
    const group = isProductPackageGroup(item.group) ? item.group : packageGroupFromIndex(index);
    const itemReferences = await normalizeStoredReferences(item.references);
    const references = itemReferences.length ? itemReferences : packageReferences;
    const image = item.image ? await hydrateStoredHistoryImage(item.image) : undefined;
    const status = isProductPackageItemStatus(item.status) ? item.status : image?.dataUrl ? "success" : "waiting";
    return {
        id: item.id || `${packageId}:${index}`,
        logId: item.logId,
        taskId: item.taskId,
        selected: Boolean(item.selected),
        group,
        index,
        groupIndex: Number(item.groupIndex) > 0 ? Math.floor(Number(item.groupIndex)) : packageGroupIndex(index),
        title: item.title || defaultPackageItemTitle(index),
        prompt: item.prompt || "",
        model: item.model || "",
        config: normalizeLogConfig({ config: item.config, model: item.model || "", imageCount: 1 }),
        references,
        status,
        image: image?.dataUrl ? image : undefined,
        error: item.error,
        errorDetail: item.errorDetail,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        durationMs: item.durationMs,
        sourceFolderName: item.sourceFolderName,
        sourceFileName: item.sourceFileName,
    };
}

async function normalizeStoredReferences(references?: Partial<ReferenceImage>[]): Promise<ReferenceImage[]> {
    const normalized: Array<ReferenceImage | null> = await Promise.all(
        (references || []).map(async (item, index) => {
            if (!item?.dataUrl && !item?.storageKey) return null;
            const reference: ReferenceImage = {
                id: item.id || nanoid(),
                name: item.name || `参考图-${index + 1}`,
                type: item.type || "image/png",
                dataUrl: item.dataUrl || "",
                storageKey: item.storageKey,
                width: item.width,
                height: item.height,
                bytes: item.bytes,
                source: item.source || "upload",
                assetId: item.assetId,
                temporary: item.temporary,
            };
            const hydrated = await hydrateStoredHistoryImage(reference);
            return hydrated.dataUrl ? hydrated : null;
        }),
    );
    return normalized.filter((item): item is ReferenceImage => item !== null);
}

function isProductPackageItemStatus(value: unknown): value is ProductPackageItemStatus {
    return value === "waiting" || value === "running" || value === "success" || value === "failed";
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all((log.references || []).map((item) => hydrateStoredHistoryImage(item)));
    const images = await Promise.all((log.images || []).map((item) => hydrateStoredHistoryImage(item)));
    const visibleImages = images.filter((image) => Boolean(image.dataUrl));
    const config = normalizeLogConfig(log);
    const rawSuccessCount = log.successCount ?? log.imageCount ?? 0;
    const rawFailCount = log.failCount || 0;
    const expectedImageCount = Math.max(log.imageCount || 0, rawSuccessCount + rawFailCount, visibleImages.length);
    const missingImageCount = Math.max(0, rawSuccessCount - visibleImages.length);
    const successCount = visibleImages.length;
    const failCount = rawFailCount + missingImageCount;
    const errors = [...(log.errors || [])];
    if (missingImageCount > 0 && !errors.some((item) => item.includes("图片文件丢失") || item.includes("无法读取"))) {
        errors.unshift(missingImageCount > 1 ? `${missingImageCount} 张图片文件丢失或无法读取` : "图片文件丢失或无法读取");
    }
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount,
        failCount,
        imageCount: expectedImageCount,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: failCount > 0 ? "失败" : successCount > 0 ? "成功" : log.status || "失败",
        images: visibleImages,
        thumbnails: visibleImages.map((image) => image.dataUrl),
        errors,
        errorDetails: log.errorDetails || [],
        categoryIds: Array.isArray(log.categoryIds) ? log.categoryIds : [],
        workflowId: log.workflowId,
        workflowName: log.workflowName,
        workflowInputs: log.workflowInputs,
        workflowSeriesRunId: log.workflowSeriesRunId,
        versionGroupId: typeof log.versionGroupId === "string" && log.versionGroupId ? log.versionGroupId : undefined,
        versionNo: Number.isFinite(Number(log.versionNo)) && Number(log.versionNo) > 0 ? Math.floor(Number(log.versionNo)) : undefined,
        retryOfLogId: typeof log.retryOfLogId === "string" && log.retryOfLogId ? log.retryOfLogId : undefined,
        retryOfVersionNo: Number.isFinite(Number(log.retryOfVersionNo)) && Number(log.retryOfVersionNo) > 0 ? Math.floor(Number(log.retryOfVersionNo)) : undefined,
    };
}

function logImageDataScore(log: Partial<GenerationLog>) {
    return [...(log.images || []), ...(log.references || [])].reduce((score, item) => {
        if (item.dataUrl?.startsWith("data:image/")) return score + 2;
        if (item.dataUrl) return score + 1;
        return score;
    }, 0);
}

async function hydrateStoredHistoryImage<T extends { dataUrl?: string; storageKey?: string }>(item: T): Promise<T> {
    const resolved = await resolveImageUrl(item.storageKey, item.dataUrl);
    if (resolved && !resolved.startsWith("data:image/")) return { ...item, dataUrl: resolved };
    if (item.storageKey?.startsWith("image:") && item.dataUrl?.startsWith("data:image/")) {
        try {
            const blob = await (await fetch(item.dataUrl)).blob();
            const url = await setImageBlob(item.storageKey, blob);
            return { ...item, dataUrl: url };
        } catch {
            return { ...item, dataUrl: resolved || item.dataUrl };
        }
    }
    return { ...item, dataUrl: resolved || item.dataUrl };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: persistableImageUrl(item.dataUrl, item.storageKey) })),
        images: log.images.map((image) => ({ ...image, dataUrl: persistableImageUrl(image.dataUrl, image.storageKey) })),
        thumbnails: log.images.map((image) => persistableImageUrl(image.dataUrl, image.storageKey)),
    };
}

function serializeProductPackage(pkg: ProductImagePackage): ProductImagePackage {
    return {
        ...pkg,
        references: pkg.references.map(serializeReferenceImage),
        items: pkg.items.map((item) => ({
            ...item,
            references: item.references.map(serializeReferenceImage),
            image: item.image ? { ...item.image, dataUrl: persistableImageUrl(item.image.dataUrl, item.image.storageKey) } : undefined,
        })),
    };
}

function serializeReferenceImage(reference: ReferenceImage): ReferenceImage {
    return { ...reference, dataUrl: persistableImageUrl(reference.dataUrl, reference.storageKey) };
}

function persistableImageUrl(dataUrl?: string, storageKey?: string) {
    if (storageKey?.startsWith("server:")) return "";
    if (storageKey?.startsWith("image:")) return dataUrl?.startsWith("data:image/") ? dataUrl : "";
    if (!dataUrl?.startsWith("data:image/")) return dataUrl || "";
    return dataUrl;
}

async function buildSyncableLog(log: GenerationLog): Promise<GenerationLog> {
    return {
        ...log,
        references: await Promise.all(log.references.map(async (item) => ({ ...item, dataUrl: await syncableImageUrl(item.dataUrl, item.storageKey) }))),
        images: await Promise.all(log.images.map(async (image) => ({ ...image, dataUrl: await syncableImageUrl(image.dataUrl, image.storageKey) }))),
        thumbnails: await Promise.all(log.images.map((image) => syncableImageUrl(image.dataUrl, image.storageKey))),
    };
}

async function buildSyncableProductPackage(pkg: ProductImagePackage): Promise<ProductImagePackage> {
    return {
        ...pkg,
        references: await Promise.all(pkg.references.map(syncableReferenceImage)),
        items: await Promise.all(
            pkg.items.map(async (item) => ({
                ...item,
                references: await Promise.all(item.references.map(syncableReferenceImage)),
                image: item.image ? { ...item.image, dataUrl: await syncableImageUrl(item.image.dataUrl, item.image.storageKey) } : undefined,
            })),
        ),
    };
}

async function syncableReferenceImage(reference: ReferenceImage): Promise<ReferenceImage> {
    return { ...reference, dataUrl: await syncableImageUrl(reference.dataUrl, reference.storageKey) };
}

async function syncableImageUrl(dataUrl?: string, storageKey?: string) {
    if (storageKey?.startsWith("server:")) return "";
    if (storageKey?.startsWith("image:")) {
        try {
            return await imageToDataUrl({ dataUrl, storageKey });
        } catch {
            return persistableImageUrl(dataUrl, storageKey);
        }
    }
    if (dataUrl?.startsWith("blob:")) {
        try {
            const response = await fetch(dataUrl);
            if (!response.ok) return "";
            return await blobToDataUrl(await response.blob());
        } catch {
            return "";
        }
    }
    return persistableImageUrl(dataUrl, storageKey);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
        apiMode: log.config?.apiMode || "images",
        outputFormat: log.config?.outputFormat || "png",
        outputCompression: log.config?.outputCompression || "100",
        moderation: log.config?.moderation || "auto",
        timeout: log.config?.timeout || "600",
        streamImages: log.config?.streamImages || false,
        streamPartialImages: log.config?.streamPartialImages || "1",
        responseFormatB64Json: log.config?.responseFormatB64Json !== false,
        codexCli: log.config?.codexCli || false,
    };
}

function buildGenerationLogConfig(config: AiConfig): GenerationLogConfig {
    return {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
        apiMode: config.apiMode,
        outputFormat: config.outputFormat,
        outputCompression: config.outputCompression,
        moderation: config.moderation,
        timeout: config.timeout,
        streamImages: config.streamImages,
        streamPartialImages: config.streamPartialImages,
        responseFormatB64Json: config.responseFormatB64Json,
        codexCli: config.codexCli,
    };
}

function buildSingleResultLogConfig(config: GenerationLogConfig): GenerationLogConfig {
    return { ...config, count: "1" };
}

async function buildReferenceScopedSnapshot(snapshot: RequestSnapshot, reference: ReferenceImage): Promise<RequestSnapshot> {
    const referenceSize = await resolveReferenceOutputSize(reference, snapshot.displayConfig.size);
    if (!referenceSize) return { ...snapshot, references: [reference] };
    return {
        ...snapshot,
        requestConfig: { ...snapshot.requestConfig, size: referenceSize },
        displayConfig: { ...snapshot.displayConfig, size: referenceSize },
        references: [reference],
    };
}

async function resolveReferenceOutputSize(_reference: ReferenceImage, baseSize: string | undefined) {
    const requestedSize = (baseSize || "").trim();
    if (requestedSize && requestedSize !== "auto") return requestedSize;
    return "";
}

function parsePixelSize(value?: string) {
    const match = `${value || ""}`.trim().match(/^(\d+)x(\d+)$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

function imageExtension(value: string) {
    const lower = value.toLowerCase();
    if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
    if (lower.includes("webp")) return "webp";
    return "png";
}

function safeFileName(value: string) {
    return (
        value
            .replace(/[\\/:*?"<>|]+/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "未命名"
    );
}

function defaultWorkflowButtonPosition() {
    if (typeof window === "undefined") return { x: 24, y: 320 };
    return { x: Math.max(16, window.innerWidth - 132), y: Math.max(96, Math.round(window.innerHeight / 2)) };
}

function clampWorkflowButtonPosition(position: { x?: number; y?: number }) {
    if (typeof window === "undefined") return { x: Number(position.x) || 24, y: Number(position.y) || 320 };
    return {
        x: Math.min(Math.max(12, Number(position.x) || 12), Math.max(12, window.innerWidth - 120)),
        y: Math.min(Math.max(72, Number(position.y) || 72), Math.max(72, window.innerHeight - 64)),
    };
}

function resolveLogVersionGroupId(log: GenerationLog) {
    return log.versionGroupId || log.id;
}

function resolveResultVersionGroupId(result: GenerationResult) {
    return result.versionGroupId || result.logId || result.id;
}

function resolveLogVersionNo(log: GenerationLog) {
    const versionNo = Number(log.versionNo);
    return Number.isFinite(versionNo) && versionNo > 0 ? Math.floor(versionNo) : 1;
}

function sortLogVersions(logs: GenerationLog[]) {
    return [...logs].sort((a, b) => resolveLogVersionNo(a) - resolveLogVersionNo(b) || a.createdAt - b.createdAt);
}

function buildLogVersionGroups(logs: GenerationLog[]) {
    const groups = new Map<string, GenerationLog[]>();
    logs.forEach((log) => {
        const groupId = resolveLogVersionGroupId(log);
        groups.set(groupId, [...(groups.get(groupId) || []), log]);
    });
    groups.forEach((items, groupId) => groups.set(groupId, sortLogVersions(items)));
    return groups;
}

function latestLogsByVersionGroup(logs: GenerationLog[]) {
    return [...buildLogVersionGroups(logs).values()]
        .map((items) => items[items.length - 1])
        .filter((item): item is GenerationLog => Boolean(item))
        .sort((a, b) => b.createdAt - a.createdAt);
}

function buildRetryVersionMeta(sourceLog: GenerationLog, allLogs: GenerationLog[]) {
    const versionGroupId = resolveLogVersionGroupId(sourceLog);
    const groupLogs = allLogs.filter((log) => resolveLogVersionGroupId(log) === versionGroupId);
    const nextVersionNo = Math.max(resolveLogVersionNo(sourceLog), ...groupLogs.map(resolveLogVersionNo), 1) + 1;
    return {
        versionGroupId,
        nextVersionNo,
        retryOfLogId: sourceLog.id,
        retryOfVersionNo: resolveLogVersionNo(sourceLog),
    };
}

function buildLog({
    id,
    createdAt,
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
    errors,
    errorDetails,
    categoryIds,
    versionGroupId,
    versionNo,
    retryOfLogId,
    retryOfVersionNo,
}: {
    id?: string;
    createdAt?: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
    errors: string[];
    errorDetails?: string[];
    categoryIds?: string[];
    versionGroupId?: string;
    versionNo?: number;
    retryOfLogId?: string;
    retryOfVersionNo?: number;
}): GenerationLog {
    const logConfig = config;
    return {
        id: id || nanoid(),
        createdAt: createdAt || Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors,
        errorDetails,
        categoryIds: categoryIds || [],
        versionGroupId,
        versionNo,
        retryOfLogId,
        retryOfVersionNo,
    };
}

function formatLogTime(value: number) {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
