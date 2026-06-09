"use client";

import { App, Button, Checkbox, Empty, Image, Input, Modal, Select, Space, Switch, Tag, Typography } from "antd";
import { AlertCircle, ArrowDown, ArrowUp, Bot, CheckCircle2, Copy, Download, Edit3, FilePlus2, Globe2, Layers3, LoaderCircle, LockKeyhole, Play, Plus, Sparkles, Trash2, WandSparkles } from "lucide-react";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useEffect, useMemo, useRef, useState } from "react";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { deleteUserWorkflow, draftUserWorkflow, fetchUserConfig, fetchUserWorkflows, saveUserWorkflow, type CreativeWorkflowRecord } from "@/services/api/user-config";
import { deleteStoredImages, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { defaultConfig, localChannelForActiveModel, normalizeLocalChannels, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type WorkflowVariableType = "text" | "textarea" | "select";
type WorkflowMode = "single_image" | "multi_image_series";

type WorkflowVariable = {
    id: string;
    key: string;
    label: string;
    type: WorkflowVariableType;
    required: boolean;
    defaultValue: string;
    options: string[];
    placeholder?: string;
};

export type WorkflowGenerationConfig = Pick<
    AiConfig,
    "model" | "imageModel" | "imageChannelId" | "quality" | "size" | "count" | "apiMode" | "outputFormat" | "outputCompression" | "moderation" | "timeout" | "streamImages" | "streamPartialImages" | "responseFormatB64Json" | "codexCli"
> & {
    systemPrompt: string;
    promptTemplate: string;
    negativePrompt: string;
};

type WorkflowSeriesConfig = {
    targetCount: string;
    promptModel: string;
    promptChannelId: string;
    promptInstruction: string;
    reviewRequired: boolean;
    concurrency: string;
};

type CreativeWorkflow = {
    id: string;
    ownerUserId?: string;
    scope: "private" | "public";
    editable?: boolean;
    mode: WorkflowMode;
    name: string;
    category: string;
    description: string;
    variables: WorkflowVariable[];
    config: WorkflowGenerationConfig;
    seriesConfig: WorkflowSeriesConfig;
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
};

type SeriesPromptDraft = {
    id: string;
    title: string;
    prompt: string;
    status: "draft" | "running" | "success" | "failed";
    error?: string;
    resultIds?: string[];
};

export type WorkflowRunResult = {
    id: string;
    workflowId: string;
    workflowName: string;
    prompt: string;
    imageUrl: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    durationMs: number;
    createdAt: number;
};

export type WorkflowExternalTaskStart = {
    taskId: string;
    workflowId: string;
    workflowName: string;
    workflowMode: WorkflowMode;
    prompt: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    apiMode: AiConfig["apiMode"];
    config: WorkflowGenerationConfig;
    count: number;
    startedAt: number;
    seriesRunId?: string;
    seriesTitle?: string;
    seriesIndex?: number;
    seriesTotal?: number;
};

export type WorkflowExternalTaskSuccess = {
    taskId: string;
    images: WorkflowRunResult[];
    durationMs: number;
    endedAt: number;
};

export type WorkflowExternalTaskFailure = {
    taskId: string;
    error: string;
    durationMs: number;
    endedAt: number;
};

export type WorkflowRunnerRequest = {
    id: string;
    workflowId: string;
    inputs?: Record<string, string>;
    references?: ReferenceImage[];
};

type WorkflowTask = {
    id: string;
    status: "running" | "success" | "failed";
    workflowId: string;
    workflowName: string;
    prompt: string;
    inputs: Record<string, string>;
    references: ReferenceImage[];
    model: string;
    apiMode: AiConfig["apiMode"];
    config: WorkflowGenerationConfig;
    count: number;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    images: WorkflowRunResult[];
    error?: string;
    seriesRunId?: string;
    seriesTitle?: string;
    seriesIndex?: number;
    seriesTotal?: number;
};

type ImageHistoryLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: WorkflowGenerationConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败";
    images: Array<{
        id: string;
        dataUrl: string;
        storageKey: string;
        durationMs: number;
        width: number;
        height: number;
        bytes: number;
        mimeType: string;
    }>;
    thumbnails: string[];
    errors: string[];
    categoryIds: string[];
    workflowId: string;
    workflowName: string;
    workflowInputs: Record<string, unknown>;
    workflowSeriesRunId?: string;
};

type GenerationCategory = { id: string; name: string; createdAt: number };

const WORKFLOW_STORE_KEY = "infinite-canvas:creative-workflows";
const SERIES_DRAFT_STORE_PREFIX = "infinite-canvas:series-drafts:";
const CATEGORY_STORE_KEY = "infinite-canvas:image_generation_categories";
const workflowStore = localforage.createInstance({ name: "infinite-canvas", storeName: "creative_workflows" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const categoryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_categories" });
const excludedPromptPlannerModels = ["gpt-image-2", "gpt-5.4-mini"];

const variableTypeOptions: Array<{ value: WorkflowVariableType; label: string }> = [
    { value: "text", label: "一行文字" },
    { value: "textarea", label: "多行说明" },
    { value: "select", label: "下拉选项" },
];

const workflowModeOptions: Array<{ value: WorkflowMode; label: string }> = [
    { value: "single_image", label: "单张出图" },
    { value: "multi_image_series", label: "一套多图" },
];

export function CreativeWorkflowWorkspace({
    embedded = false,
    hideTaskList = false,
    runnerRequest,
    onGenerationLogSaved,
    onWorkflowTaskStarted,
    onWorkflowTaskSuccess,
    onWorkflowTaskFailure,
    onWorkbenchTakeover,
    onRunnerRequestHandled,
}: {
    embedded?: boolean;
    hideTaskList?: boolean;
    runnerRequest?: WorkflowRunnerRequest | null;
    onGenerationLogSaved?: () => void;
    onWorkflowTaskStarted?: (task: WorkflowExternalTaskStart) => void;
    onWorkflowTaskSuccess?: (task: WorkflowExternalTaskSuccess) => void;
    onWorkflowTaskFailure?: (task: WorkflowExternalTaskFailure) => void;
    onWorkbenchTakeover?: () => void;
    onRunnerRequestHandled?: () => void;
} = {}) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [workflows, setWorkflows] = useState<CreativeWorkflow[]>([]);
    const [editingWorkflow, setEditingWorkflow] = useState<CreativeWorkflow | null>(null);
    const [runningWorkflow, setRunningWorkflow] = useState<CreativeWorkflow | null>(null);
    const [runnerVisible, setRunnerVisible] = useState(false);
    const [inputValues, setInputValues] = useState<Record<string, string>>({});
    const [workflowReferences, setWorkflowReferences] = useState<ReferenceImage[]>([]);
    const workflowReferenceInputRef = useRef<HTMLInputElement>(null);
    const [workflowAssetPickerOpen, setWorkflowAssetPickerOpen] = useState(false);
    const [runResults, setRunResults] = useState<WorkflowRunResult[]>([]);
    const [workflowTasks, setWorkflowTasks] = useState<WorkflowTask[]>([]);
    const [seriesDrafts, setSeriesDrafts] = useState<SeriesPromptDraft[]>([]);
    const [seriesDraftLoading, setSeriesDraftLoading] = useState(false);
    const [seriesBatchAppend, setSeriesBatchAppend] = useState("");
    const [now, setNow] = useState(Date.now());
    const [query, setQuery] = useState("");
    const [workflowCategory, setWorkflowCategory] = useState("all");
    const [agentOpen, setAgentOpen] = useState(false);
    const [agentPrompt, setAgentPrompt] = useState("");
    const [agentScope, setAgentScope] = useState<"private" | "public">("private");
    const [agentTextModel, setAgentTextModel] = useState("");
    const [agentTextChannelId, setAgentTextChannelId] = useState("");
    const [agentLoading, setAgentLoading] = useState(false);
    const [agentDraft, setAgentDraft] = useState<CreativeWorkflow | null>(null);
    const [agentWarnings, setAgentWarnings] = useState<string[]>([]);
    const [agentReferences, setAgentReferences] = useState<ReferenceImage[]>([]);
    const agentReferenceInputRef = useRef<HTMLInputElement>(null);
    const [agentAssetPickerOpen, setAgentAssetPickerOpen] = useState(false);
    const workflowSyncEnabledRef = useRef(false);
    const seriesDraftsLoadedRef = useRef(false);
    const handledRunnerRequestIdRef = useRef("");

    const filteredWorkflows = useMemo(() => {
        const text = query.trim().toLowerCase();
        return workflows.filter((workflow) => {
            if (workflowCategory !== "all" && (workflow.category || "未分类") !== workflowCategory) return false;
            if (!text) return true;
            return [workflow.name, workflow.category, workflow.description].some((value) => value.toLowerCase().includes(text));
        });
    }, [query, workflowCategory, workflows]);

    const workflowCategories = useMemo(() => Array.from(new Set(workflows.map((workflow) => workflow.category || "未分类"))).sort((a, b) => a.localeCompare(b, "zh-CN")), [workflows]);

    const renderedPrompt = useMemo(() => (runningWorkflow ? renderWorkflowPrompt(runningWorkflow, inputValues) : ""), [inputValues, runningWorkflow]);
    const runningTaskCount = workflowTasks.filter((task) => task.status === "running").length;
    const activeSeriesDrafts = seriesDrafts.filter((item) => item.status !== "success");
    const agentModel = agentTextModel || effectiveConfig.textModel || effectiveConfig.model;
    const agentChannelId = agentTextChannelId || effectiveConfig.textChannelId;
    const agentModelInfo = useMemo(() => describeModelSelection(effectiveConfig, agentModel, agentChannelId), [agentChannelId, agentModel, effectiveConfig]);

    useEffect(() => {
        if (!isUserReady) return;
        void refreshWorkflows();
    }, [isUserReady, token]);

    useEffect(() => {
        if (!agentTextModel && (effectiveConfig.textModel || effectiveConfig.model)) setAgentTextModel(effectiveConfig.textModel || effectiveConfig.model);
        if (!agentTextChannelId && effectiveConfig.textChannelId) setAgentTextChannelId(effectiveConfig.textChannelId);
    }, [agentTextChannelId, agentTextModel, effectiveConfig.model, effectiveConfig.textChannelId, effectiveConfig.textModel]);

    useEffect(() => {
        if (!runningTaskCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [runningTaskCount]);

    useEffect(() => {
        if (!runningWorkflow || runningWorkflow.mode !== "multi_image_series" || !seriesDraftsLoadedRef.current) return;
        void workflowStore.setItem(seriesDraftStorageKey(runningWorkflow.id), seriesDrafts);
    }, [runningWorkflow?.id, runningWorkflow?.mode, seriesDrafts]);

    useEffect(() => {
        if (!runnerRequest || !workflows.length) return;
        if (handledRunnerRequestIdRef.current === runnerRequest.id) return;
        const workflow = workflows.find((item) => item.id === runnerRequest.workflowId) || workflows.find(isProductPackageWorkflow);
        if (!workflow) return;
        handledRunnerRequestIdRef.current = runnerRequest.id;
        openRunner(workflow, { inputs: runnerRequest.inputs, references: runnerRequest.references });
        onRunnerRequestHandled?.();
    }, [runnerRequest?.id, workflows.length]);

    const refreshWorkflows = async () => {
        if (token) {
            try {
                const config = await fetchUserConfig(token);
                workflowSyncEnabledRef.current = config.syncCapabilities?.workflows === true;
                if (!workflowSyncEnabledRef.current) throw new Error("workflow sync unavailable");
                const remote = await fetchUserWorkflows<CreativeWorkflow>(token);
                const workflows = ensureStarterProductPackageWorkflow(remote.map(recordToWorkflow), effectiveConfig).sort((a, b) => b.updatedAt - a.updatedAt);
                if (workflows.length) {
                    setWorkflows(workflows);
                    await workflowStore.setItem(WORKFLOW_STORE_KEY, workflows);
                    return;
                }
                const local = await workflowStore.getItem<CreativeWorkflow[]>(WORKFLOW_STORE_KEY);
                const seed = local?.length ? ensureStarterProductPackageWorkflow(local.map(normalizeWorkflow), effectiveConfig) : createStarterWorkflows(effectiveConfig);
                const saved = await Promise.all(seed.map((workflow) => saveUserWorkflow(token, workflowToRecord(normalizeWorkflow(workflow)))));
                setWorkflows(saved.map(recordToWorkflow).sort((a, b) => b.updatedAt - a.updatedAt));
                return;
            } catch {
                // Use local workflows when account sync is unavailable.
            }
        }
        const stored = await workflowStore.getItem<CreativeWorkflow[]>(WORKFLOW_STORE_KEY);
        if (stored?.length) {
            const workflows = ensureStarterProductPackageWorkflow(stored.map(normalizeWorkflow), effectiveConfig).sort((a, b) => b.updatedAt - a.updatedAt);
            setWorkflows(workflows);
            await workflowStore.setItem(WORKFLOW_STORE_KEY, workflows);
            return;
        }
        const seed = createStarterWorkflows(effectiveConfig);
        setWorkflows(seed);
        await workflowStore.setItem(WORKFLOW_STORE_KEY, seed);
    };

    const saveWorkflows = async (items: CreativeWorkflow[]) => {
        const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
        setWorkflows(sorted);
        await workflowStore.setItem(WORKFLOW_STORE_KEY, sorted);
    };

    const openRunner = (workflow: CreativeWorkflow, preset?: { inputs?: Record<string, string>; references?: ReferenceImage[] }) => {
        seriesDraftsLoadedRef.current = false;
        const promptRuntime = workflow.mode === "multi_image_series" ? resolveWorkflowPromptRuntime(workflow, effectiveConfig) : null;
        setRunningWorkflow(promptRuntime ? { ...workflow, seriesConfig: { ...workflow.seriesConfig, promptModel: promptRuntime.model, promptChannelId: promptRuntime.channelId } } : workflow);
        setRunnerVisible(true);
        setInputValues({ ...createDefaultInputValues(workflow), ...(preset?.inputs || {}) });
        setWorkflowReferences([...(preset?.references || [])]);
        setSeriesDrafts([]);
        if (workflow.mode === "multi_image_series") {
            void workflowStore.getItem<SeriesPromptDraft[]>(seriesDraftStorageKey(workflow.id)).then((drafts) => {
                setSeriesDrafts((drafts || []).map(normalizeSeriesDraft));
                seriesDraftsLoadedRef.current = true;
            });
        } else {
            seriesDraftsLoadedRef.current = true;
        }
    };

    const closeRunner = () => {
        setRunningWorkflow(null);
        setRunnerVisible(false);
        setSeriesDrafts([]);
        setSeriesBatchAppend("");
        seriesDraftsLoadedRef.current = false;
    };

    const addWorkflowReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
            }),
        );
        setWorkflowReferences((value) => [...value, ...next]);
    };

    const removeWorkflowReference = async (id: string) => {
        const reference = workflowReferences.find((item) => item.id === id);
        setWorkflowReferences((value) => value.filter((item) => item.id !== id));
        if (reference?.storageKey && isDisposableReferenceFile(reference) && !referenceUsedByWorkflowTask(reference, workflowTasks)) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const addAgentReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const next = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
            }),
        );
        setAgentReferences((value) => [...value, ...next]);
    };

    const removeAgentReference = async (id: string) => {
        const reference = agentReferences.find((item) => item.id === id);
        setAgentReferences((value) => value.filter((item) => item.id !== id));
        if (reference?.storageKey && isDisposableReferenceFile(reference)) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const cleanupAgentReferences = async () => {
        const keys = agentReferences.filter(isDisposableReferenceFile).map((item) => item.storageKey).filter((key): key is string => Boolean(key));
        setAgentReferences([]);
        if (keys.length) await deleteStoredImages(keys).catch((error) => message.error(error instanceof Error ? error.message : "参考图文件删除失败"));
    };

    const insertWorkflowAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            const text = payload.content.trim();
            if (text) setInputValues((value) => ({ ...value, [runningWorkflow?.variables[0]?.key || "asset_text"]: text }));
            setWorkflowAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning("视频素材不能作为工作流参考图");
            return;
        }
        setWorkflowReferences((value) => [
            ...value,
            {
                id: nanoid(),
                name: payload.title,
                type: payload.mimeType || "image/png",
                dataUrl: payload.dataUrl,
                storageKey: payload.storageKey,
                source: payload.source === "asset" ? "asset" : "library",
                assetId: payload.assetId,
                temporary: false,
            },
        ]);
        setWorkflowAssetPickerOpen(false);
    };

    const insertAgentAsset = (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            const text = payload.content.trim();
            if (text) setAgentPrompt((value) => (value.trim() ? `${value.trim()}\n\n${text}` : text));
            setAgentAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning("视频素材不能作为工作流 Agent 参考图");
            return;
        }
        setAgentReferences((value) => [
            ...value,
            {
                id: nanoid(),
                name: payload.title,
                type: payload.mimeType || "image/png",
                dataUrl: payload.dataUrl,
                storageKey: payload.storageKey,
                source: payload.source === "asset" ? "asset" : "library",
                assetId: payload.assetId,
                temporary: false,
            },
        ]);
        setAgentAssetPickerOpen(false);
    };

    const saveWorkflow = async (workflow: CreativeWorkflow) => {
        if (!workflow.name.trim()) {
            message.error("请输入工作流名称");
            return;
        }
        if (!workflow.config.promptTemplate.trim()) {
            message.error("请输入提示词模板");
            return;
        }
        const now = Date.now();
        let normalized = normalizeWorkflow({ ...workflow, name: workflow.name.trim(), category: workflow.category.trim(), updatedAt: now, createdAt: workflow.createdAt || now });
        try {
            if (token && workflowSyncEnabledRef.current) {
                normalized = recordToWorkflow(await saveUserWorkflow(token, workflowToRecord(normalized)));
                await refreshWorkflows();
            } else {
                await saveWorkflows([normalized, ...workflows.filter((item) => item.id !== normalized.id)]);
            }
        } catch (error) {
            await saveWorkflows([normalized, ...workflows.filter((item) => item.id !== normalized.id)]);
            message.warning(error instanceof Error && error.message === "接口不存在" ? "工作流同步接口不可用，已先保存到本地。请重启后端后再同步到账号。" : "远端保存失败，已先保存到本地");
        }
        if (agentDraft?.id === workflow.id) {
            await cleanupAgentReferences();
            setAgentDraft(null);
        }
        setEditingWorkflow(null);
        message.success("工作流已保存");
    };

    const duplicateWorkflow = async (workflow: CreativeWorkflow) => {
        const now = Date.now();
        const copy = normalizeWorkflow({ ...workflow, id: nanoid(), ownerUserId: undefined, editable: true, scope: "private", name: `${workflow.name} 副本`, createdAt: now, updatedAt: now, lastRunAt: undefined });
        try {
            if (token && workflowSyncEnabledRef.current) {
                await saveUserWorkflow(token, workflowToRecord(copy));
                await refreshWorkflows();
            } else {
                await saveWorkflows([copy, ...workflows]);
            }
        } catch (error) {
            await saveWorkflows([copy, ...workflows]);
            message.warning(error instanceof Error && error.message === "接口不存在" ? "工作流同步接口不可用，副本已先保存到本地。请重启后端。" : "远端复制失败，副本已先保存到本地");
        }
    };

    const deleteWorkflow = (workflow: CreativeWorkflow) => {
        modal.confirm({
            title: "删除工作流",
            content: `确定删除「${workflow.name}」吗？本地模板会被移除，已生成的图片历史不受影响。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    if (token && workflowSyncEnabledRef.current) {
                        await deleteUserWorkflow(token, workflow.id);
                        await refreshWorkflows();
                    } else {
                        await saveWorkflows(workflows.filter((item) => item.id !== workflow.id));
                    }
                } catch (error) {
                    await saveWorkflows(workflows.filter((item) => item.id !== workflow.id));
                    message.warning(error instanceof Error && error.message === "接口不存在" ? "工作流同步接口不可用，已先从本地移除。请重启后端。" : "远端删除失败，已先从本地移除");
                }
                if (runningWorkflow?.id === workflow.id) setRunningWorkflow(null);
            },
        });
    };

    const runWorkflowAgent = async () => {
        const text = agentPrompt.trim();
        if (!text) {
            message.error("请输入工作流需求");
            return;
        }
        if (!token) {
            message.warning("请先登录后使用工作流创建 Agent");
            return;
        }
        setAgentLoading(true);
        try {
            const textModel = agentTextModel || effectiveConfig.textModel || effectiveConfig.model;
            const textChannelId = agentTextChannelId || effectiveConfig.textChannelId;
            const textConfig = { ...effectiveConfig, model: textModel, textModel, textChannelId, activeChannelId: textChannelId };
            if (!isAiConfigReady(textConfig, textModel)) {
                openConfigDialog(true);
                return;
            }
            const localChannel = effectiveConfig.channelMode === "local" ? localChannelForActiveModel(textConfig) : null;
            const referenceDataUrls = await Promise.all(agentReferences.map((image) => imageToDataUrl(image)));
            const result = await draftUserWorkflow<Partial<CreativeWorkflow>>(token, {
                prompt: text,
                scope: agentScope,
                model: textModel,
                channelId: textChannelId,
                channelMode: effectiveConfig.channelMode,
                baseUrl: localChannel?.baseUrl,
                apiKey: localChannel?.apiKey,
                references: referenceDataUrls.filter(Boolean),
            });
            setAgentDraft(normalizeAgentDraft(result.draft, effectiveConfig, agentScope));
            setAgentWarnings(result.warnings || []);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "工作流 Agent 生成失败");
        } finally {
            setAgentLoading(false);
        }
    };

    const applyAgentDraft = () => {
        if (!agentDraft) return;
        setEditingWorkflow(agentDraft);
        setAgentOpen(false);
    };

    const runWorkflow = async () => {
        if (!runningWorkflow) return;
        const missing = runningWorkflow.variables.find((item) => item.required && !String(inputValues[item.key] || "").trim());
        if (missing) {
            message.error(`请填写 ${missing.label}`);
            return;
        }
        if (runningWorkflow.mode === "multi_image_series") {
            await generateSeriesPromptDrafts();
            return;
        }
        void startWorkflowImageTask(runningWorkflow, renderedPrompt, { ...inputValues }, [...workflowReferences]);
    };

    const generateSeriesPromptDrafts = async () => {
        if (!runningWorkflow) return;
        const promptRuntime = resolveWorkflowPromptRuntime(runningWorkflow, effectiveConfig);
        const promptModel = promptRuntime.model;
        const promptChannelId = promptRuntime.channelId;
        const textConfig = { ...effectiveConfig, model: promptModel, textModel: promptModel, textChannelId: promptChannelId, activeChannelId: promptChannelId, systemPrompt: effectiveConfig.systemPrompts.workflow || effectiveConfig.systemPrompt };
        if (!isAiConfigReady(textConfig, promptModel)) {
            message.warning("请先完成文本模型配置");
            openConfigDialog(true);
            return;
        }
        setSeriesDraftLoading(true);
        try {
            const count = Math.max(1, Math.min(20, Number(runningWorkflow.seriesConfig.targetCount) || Number(runningWorkflow.config.count) || 4));
            const answer = await requestImageQuestion(textConfig, [{ role: "user", content: buildSeriesPromptDraftRequest(runningWorkflow, renderedPrompt, count, inputValues) }], () => {});
            const drafts = parseSeriesPromptDrafts(answer, count, renderedPrompt);
            setSeriesDrafts(drafts);
            message.success("多图提示词已生成，请审核后发送到生图工作台");
            if (runningWorkflow.seriesConfig.reviewRequired === false) {
                window.setTimeout(() => {
                    drafts.forEach((draft, index) => void runSeriesDraft(draft, index));
                }, 0);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "多图提示词生成失败");
        } finally {
            setSeriesDraftLoading(false);
        }
    };

    const updateSeriesDraft = (id: string, patch: Partial<SeriesPromptDraft>) => {
        setSeriesDrafts((value) => value.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    const moveSeriesDraft = (id: string, direction: -1 | 1) => {
        setSeriesDrafts((value) => {
            const index = value.findIndex((item) => item.id === id);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= value.length) return value;
            const next = [...value];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    };

    const deleteSeriesDraft = (id: string) => {
        setSeriesDrafts((value) => value.filter((item) => item.id !== id));
    };

    const applySeriesBatchAppend = () => {
        const text = seriesBatchAppend.trim();
        if (!text) {
            message.warning("请输入要追加的批量要求");
            return;
        }
        setSeriesDrafts((value) => value.map((item) => ({ ...item, prompt: `${item.prompt.trim()}\n${text}`.trim(), status: item.status === "success" ? "draft" : item.status })));
        setSeriesBatchAppend("");
    };

    const runSeriesDraft = (draft: SeriesPromptDraft, index: number, seriesRunId?: string, seriesTotal?: number) => {
        if (!runningWorkflow || draft.status === "running" || !draft.prompt.trim()) return Promise.resolve();
        updateSeriesDraft(draft.id, { status: "running", error: undefined });
        return startWorkflowImageTask(runningWorkflow, draft.prompt.trim(), { ...inputValues }, [...workflowReferences], 1, draft.id, draft.title || `第 ${index + 1} 张`, index + 1, seriesRunId || nanoid(), seriesTotal || activeSeriesDrafts.length);
    };

    const runAllSeriesDrafts = async () => {
        if (!runningWorkflow) return;
        const drafts = activeSeriesDrafts.filter((item) => item.prompt.trim() && item.status !== "running");
        if (!drafts.length) {
            message.warning("没有可生成的提示词");
            return;
        }
        const concurrency = Math.max(1, Math.min(6, Number(runningWorkflow.seriesConfig.concurrency) || 3));
        const seriesRunId = nanoid();
        for (let index = 0; index < drafts.length; index += concurrency) {
            const batch = drafts.slice(index, index + concurrency);
            await Promise.all(batch.map((draft) => runSeriesDraft(draft, Math.max(0, seriesDrafts.findIndex((item) => item.id === draft.id)), seriesRunId, drafts.length)));
        }
    };

    const startWorkflowImageTask = (workflow: CreativeWorkflow, promptSnapshot: string, inputSnapshot: Record<string, string>, referencesSnapshot: ReferenceImage[], countOverride?: number, seriesDraftId?: string, seriesTitle?: string, seriesIndex?: number, seriesRunId?: string, seriesTotal?: number) => {
        if (isProductPackageWorkflow(workflow) && !referencesSnapshot.length) {
            message.warning("建议先上传产品参考图，否则很难保持包装一致，也更容易生成失败");
        }
        const runtime = resolveWorkflowRuntime(workflow, effectiveConfig);
        const model = runtime.model;
        const baseRunConfig = buildRunConfig(effectiveConfig, workflow.config, runtime);
        const runConfig = seriesIndex ? { ...baseRunConfig, size: resolveSeriesImageSize(seriesIndex, baseRunConfig.size) } : baseRunConfig;
        if (!isAiConfigReady(runConfig, model)) {
            message.warning("请先完成 API 配置");
            openConfigDialog(true);
            return;
        }

        const startedAt = Date.now();
        const performanceStartedAt = performance.now();
        const count = Math.max(1, Math.min(10, countOverride || Number(runConfig.count) || 1));
        const taskId = nanoid();
        const taskConfig = { ...workflow.config, model, imageModel: model, imageChannelId: runtime.channelId, apiMode: runtime.apiMode, size: runConfig.size, count: String(count) };
        if (embedded) {
            setRunnerVisible(false);
            onWorkbenchTakeover?.();
        }
        onWorkflowTaskStarted?.({
            taskId,
            workflowId: workflow.id,
            workflowName: workflow.name,
            workflowMode: workflow.mode,
            prompt: promptSnapshot,
            inputs: inputSnapshot,
            references: referencesSnapshot,
            model,
            apiMode: runtime.apiMode,
            config: taskConfig,
            count,
            startedAt,
            seriesRunId,
            seriesTitle,
            seriesIndex,
            seriesTotal,
        });
        setWorkflowTasks((value) => [
            {
                id: taskId,
                status: "running",
                workflowId: workflow.id,
                workflowName: workflow.name,
                prompt: promptSnapshot,
                inputs: inputSnapshot,
                references: referencesSnapshot,
                model,
                apiMode: runtime.apiMode,
                config: taskConfig,
                count,
                startedAt,
                images: [],
                seriesRunId,
                seriesTitle,
                seriesIndex,
                seriesTotal,
            },
            ...value,
        ]);
        message.success(seriesTitle ? `${seriesTitle} 已发送到生图工作台` : "工作流任务已发送到生图工作台");
        return executeWorkflowTask({ taskId, workflow, prompt: promptSnapshot, inputSnapshot, references: referencesSnapshot, runConfig, taskConfig, model, count, startedAt, performanceStartedAt, seriesDraftId, seriesRunId, seriesTitle, seriesIndex });
    };

    const executeWorkflowTask = async ({
        taskId,
        workflow,
        prompt,
        inputSnapshot,
        references,
        runConfig,
        taskConfig,
        model,
        count,
        startedAt,
        performanceStartedAt,
        seriesDraftId,
        seriesRunId,
        seriesTitle,
        seriesIndex,
    }: {
        taskId: string;
        workflow: CreativeWorkflow;
        prompt: string;
        inputSnapshot: Record<string, string>;
        references: ReferenceImage[];
        runConfig: AiConfig;
        taskConfig: WorkflowGenerationConfig;
        model: string;
        count: number;
        startedAt: number;
        performanceStartedAt: number;
        seriesDraftId?: string;
        seriesRunId?: string;
        seriesTitle?: string;
        seriesIndex?: number;
    }) => {
        try {
            const images = await Promise.all(Array.from({ length: count }, () => (references.length ? requestEdit({ ...runConfig, count: "1" }, prompt, references) : requestGeneration({ ...runConfig, count: "1" }, prompt))));
            const flattened = images.flat();
            if (!flattened.length) throw new Error("接口没有返回图片");
            const durationMs = performance.now() - performanceStartedAt;
            const storedImages = await Promise.all(
                flattened.map(async (image) => {
                    const meta = await readImageMeta(image.dataUrl);
                    const stored = await uploadImage(image.dataUrl);
                    const persistedUrl = stored.url || image.dataUrl;
                    return {
                        id: image.id,
                        dataUrl: persistedUrl,
                        displayUrl: stored.url,
                        storageKey: stored.storageKey,
                        durationMs,
                        width: stored.width || meta.width,
                        height: stored.height || meta.height,
                        bytes: stored.bytes || getDataUrlByteSize(image.dataUrl),
                        mimeType: stored.mimeType || meta.mimeType,
                    };
                }),
            );
            const category = await ensureWorkflowCategory(workflow.name);
            const log = buildImageHistoryLog({
                workflow,
                prompt,
                config: taskConfig,
                model,
                images: storedImages,
                durationMs,
                inputs: inputSnapshot,
                references,
                categoryIds: category ? [category.id] : [],
                seriesRunId,
                seriesTitle,
                seriesIndex,
            });
            await imageLogStore.setItem(log.id, serializeHistoryLog(log));
            onGenerationLogSaved?.();
            const finishedAt = Date.now();
            setWorkflows((value) => {
                const next = value.map((item) => (item.id === workflow.id ? { ...item, lastRunAt: finishedAt, updatedAt: finishedAt } : item)).sort((a, b) => b.updatedAt - a.updatedAt);
                void workflowStore.setItem(WORKFLOW_STORE_KEY, next);
                return next;
            });
            if (token && workflowSyncEnabledRef.current && workflow.editable !== false) void saveUserWorkflow(token, workflowToRecord({ ...workflow, lastRunAt: finishedAt, updatedAt: finishedAt })).catch(() => {});
            setRunningWorkflow((value) => (value?.id === workflow.id ? { ...value, lastRunAt: finishedAt, updatedAt: finishedAt } : value));
            const nextResults = storedImages.map((image) => ({
                id: image.id,
                workflowId: workflow.id,
                workflowName: workflow.name,
                prompt,
                imageUrl: image.displayUrl,
                storageKey: image.storageKey,
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                mimeType: image.mimeType,
                durationMs,
                createdAt: finishedAt,
            }));
            if (seriesDraftId) {
                updateSeriesDraft(seriesDraftId, { status: "success", resultIds: nextResults.map((image) => image.id) });
            }
            setWorkflowTasks((value) =>
                value.map((task) =>
                    task.id === taskId
                        ? {
                              ...task,
                              status: "success",
                              endedAt: finishedAt,
                              durationMs,
                              images: nextResults,
                          }
                        : task,
                ),
            );
            setRunResults((value) => [...nextResults, ...value]);
            onWorkflowTaskSuccess?.({ taskId, images: nextResults, durationMs, endedAt: finishedAt });
            message.success("工作流运行完成，结果已写入生图历史");
        } catch (error) {
            const finishedAt = Date.now();
            const messageText = error instanceof Error ? error.message : "工作流运行失败";
            if (seriesDraftId) {
                updateSeriesDraft(seriesDraftId, { status: "failed", error: messageText });
            }
            setWorkflowTasks((value) =>
                value.map((task) =>
                    task.id === taskId
                        ? {
                              ...task,
                              status: "failed",
                              endedAt: finishedAt,
                              durationMs: finishedAt - startedAt,
                              error: messageText,
                          }
                        : task,
                ),
            );
            onWorkflowTaskFailure?.({ taskId, error: messageText, durationMs: finishedAt - startedAt, endedAt: finishedAt });
            message.error(messageText);
        }
    };

    return (
        <main className={`${embedded ? "h-full" : "h-full overflow-y-auto bg-stone-50 p-4 dark:bg-stone-950"} text-stone-950 dark:text-stone-50`}>
            <div className={`${embedded ? "h-full overflow-y-auto p-4" : "mx-auto max-w-7xl"} flex flex-col gap-4`}>
                <section
                    className={`${embedded ? "border-b border-stone-200 pb-4 dark:border-stone-800" : "rounded-lg border border-stone-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-stone-800 dark:bg-stone-900/70"} flex flex-wrap items-center justify-between gap-3`}
                >
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-lg font-semibold">
                            <WandSparkles className="size-5" />
                            创作工作流
                        </div>
                        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{embedded ? "选择模板并启动任务，结果会写入生图历史。" : "把固定提示词和参数沉淀成模板，每次只填写变量即可批量复用。"}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            className="w-36"
                            value={workflowCategory}
                            options={[{ value: "all", label: "全部分类" }, ...workflowCategories.map((category) => ({ value: category, label: category }))]}
                            onChange={setWorkflowCategory}
                        />
                        <Input.Search allowClear placeholder="搜索名称、分类、描述" className="w-72 max-w-full" value={query} onChange={(event) => setQuery(event.target.value)} />
                        <Button icon={<Bot className="size-4" />} onClick={() => setAgentOpen(true)}>
                            AI 创建
                        </Button>
                        <Button icon={<Layers3 className="size-4" />} onClick={() => setEditingWorkflow(createBlankWorkflow(effectiveConfig, "multi_image_series"))}>
                            新建多图
                        </Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditingWorkflow(createBlankWorkflow(effectiveConfig))}>
                            新建工作流
                        </Button>
                    </div>
                </section>

                <section className={`${embedded ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"} grid gap-3`}>
                    {filteredWorkflows.map((workflow) => (
                        <WorkflowCard key={workflow.id} workflow={workflow} onRun={() => openRunner(workflow)} onEdit={() => setEditingWorkflow(workflow)} onCopy={() => void duplicateWorkflow(workflow)} onDelete={() => deleteWorkflow(workflow)} />
                    ))}
                    {!filteredWorkflows.length ? (
                        <div className="col-span-full rounded-lg border border-dashed border-stone-300 bg-white/70 py-14 dark:border-stone-800 dark:bg-stone-900/60">
                            <Empty description="暂无工作流" />
                        </div>
                    ) : null}
                </section>

                {!hideTaskList && workflowTasks.length ? (
                    <section className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-base font-semibold">
                                <LoaderCircle className={`size-4 ${runningTaskCount ? "animate-spin" : ""}`} />
                                工作流任务
                                <Tag className="m-0">{workflowTasks.length} 个</Tag>
                                {runningTaskCount ? (
                                    <Tag className="m-0" color="processing">
                                        {runningTaskCount} 运行中
                                    </Tag>
                                ) : null}
                            </div>
                            <Button size="small" onClick={() => setWorkflowTasks((value) => value.filter((task) => task.status === "running"))}>
                                清理已完成
                            </Button>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                            {workflowTasks.map((task) => (
                                <WorkflowTaskCard key={task.id} task={task} now={now} onCopyPrompt={() => void navigator.clipboard.writeText(task.prompt)} onDownload={(image, index) => saveAs(image.imageUrl, `workflow-task-${index + 1}.png`)} />
                            ))}
                        </div>
                    </section>
                ) : null}

                {!hideTaskList && runResults.length ? (
                    <section className="space-y-3">
                        <div className="flex items-center gap-2 text-base font-semibold">
                            <Sparkles className="size-4" />
                            最近运行结果
                            <Tag className="m-0">{runResults.length} 张</Tag>
                        </div>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                            {runResults.map((result, index) => (
                                <div key={result.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
                                    <Image src={result.imageUrl} alt={result.workflowName} className="aspect-[4/3] object-cover" />
                                    <div className="space-y-1 p-2 text-xs">
                                        <div className="line-clamp-1 font-medium">{result.workflowName}</div>
                                        <div className="flex flex-wrap gap-1 text-stone-500">
                                            <Tag className="m-0 text-[10px]">
                                                {result.width}x{result.height}
                                            </Tag>
                                            <Tag className="m-0 text-[10px]">{formatBytes(result.bytes)}</Tag>
                                            <Tag className="m-0 text-[10px]">{formatDuration(result.durationMs)}</Tag>
                                        </div>
                                        <div className="flex justify-end gap-1">
                                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(result.prompt)} />
                                            <Button size="small" icon={<Download className="size-3.5" />} onClick={() => saveAs(result.imageUrl, `workflow-${index + 1}.png`)} />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>

            <WorkflowEditorModal
                open={Boolean(editingWorkflow)}
                workflow={editingWorkflow}
                modelConfig={effectiveConfig}
                theme={theme}
                onChange={setEditingWorkflow}
                onCancel={() => setEditingWorkflow(null)}
                onSave={(workflow) => void saveWorkflow(workflow)}
            />
            <Modal title="AI 创建工作流" open={agentOpen} width={980} onCancel={() => setAgentOpen(false)} footer={null} destroyOnHidden>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-sm font-medium">描述你要沉淀的创作流程</div>
                            <div className="flex min-w-0 items-center gap-2">
                                <div className="hidden min-w-[220px] max-w-[360px] sm:block">
                                    <ModelPicker
                                        config={effectiveConfig}
                                        fullWidth
                                        value={agentModel}
                                        channelId={agentChannelId}
                                        placeholder="选择 Agent 文本模型"
                                        onChange={(model, channelId) => {
                                            setAgentTextModel(model);
                                            setAgentTextChannelId(channelId || "");
                                        }}
                                        onMissingConfig={() => openConfigDialog(true)}
                                    />
                                </div>
                                <div className="hidden min-w-0 max-w-[220px] truncate rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-300 lg:block" title={`${agentModelInfo.channelName} · ${agentModelInfo.modelName}`}>
                                    {agentModelInfo.channelName}
                                </div>
                                <div className="inline-flex rounded-md border border-stone-300 p-0.5 dark:border-stone-700">
                                    <button type="button" title="个人工作流" className={`inline-flex size-8 items-center justify-center rounded ${agentScope === "private" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500"}`} onClick={() => setAgentScope("private")}>
                                        <LockKeyhole className="size-4" />
                                    </button>
                                    <button type="button" title="公开工作流" className={`inline-flex size-8 items-center justify-center rounded ${agentScope === "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500"}`} onClick={() => setAgentScope("public")}>
                                        <Globe2 className="size-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="sm:hidden">
                            <ModelPicker
                                config={effectiveConfig}
                                fullWidth
                                value={agentModel}
                                channelId={agentChannelId}
                                placeholder="选择 Agent 文本模型"
                                onChange={(model, channelId) => {
                                    setAgentTextModel(model);
                                    setAgentTextChannelId(channelId || "");
                                }}
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                        </div>
                        <Input.TextArea value={agentPrompt} autoSize={{ minRows: 14, maxRows: 22 }} placeholder="例如：创建一个电商海报工作流，只需要输入产品名称、核心卖点、活动信息，固定商业摄影质感和营销文案结构。" onChange={(event) => setAgentPrompt(event.target.value)} />
                        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-medium">参考图</div>
                                    <div className="mt-1 text-xs text-stone-500">可上传样例图，作为创建工作流的视觉参考。</div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="small" onClick={() => setAgentAssetPickerOpen(true)}>
                                        我的素材
                                    </Button>
                                    <Button size="small" onClick={() => agentReferenceInputRef.current?.click()}>
                                        上传
                                    </Button>
                                </div>
                            </div>
                            <input
                                ref={agentReferenceInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                onChange={(event) => {
                                    const input = event.currentTarget;
                                    void addAgentReferences(input.files).finally(() => {
                                        input.value = "";
                                    });
                                }}
                            />
                            {agentReferences.length ? (
                                <div className="mt-3 grid grid-cols-5 gap-2">
                                    {agentReferences.map((image) => (
                                        <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                onClick={() => void removeAgentReference(image.id)}
                                                aria-label="删除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                        <Button block type="primary" loading={agentLoading} icon={<Sparkles className="size-4" />} onClick={() => void runWorkflowAgent()}>
                            生成工作流草稿
                        </Button>
                    </div>
                    <aside className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-sm font-medium">草稿预览</div>
                        {agentDraft ? (
                            <>
                                <div>
                                    <div className="text-base font-semibold">{agentDraft.name}</div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        <Tag className="m-0">{agentDraft.category || "未分类"}</Tag>
                                        <Tag className="m-0">{agentDraft.variables.length} 个变量</Tag>
                                        <Tag className="m-0">{agentDraft.scope === "public" ? "公开" : "个人"}</Tag>
                                    </div>
                                </div>
                                <p className="text-sm text-stone-500 dark:text-stone-400">{agentDraft.description || "暂无描述"}</p>
                                <div className="max-h-60 overflow-y-auto rounded-md bg-stone-100 p-3 text-xs dark:bg-stone-950">
                                    <div className="whitespace-pre-wrap">{agentDraft.config.promptTemplate}</div>
                                </div>
                                {agentWarnings.length ? (
                                    <div className="space-y-1 text-xs text-amber-600 dark:text-amber-300">
                                        {agentWarnings.map((item) => (
                                            <div key={item}>{item}</div>
                                        ))}
                                    </div>
                                ) : null}
                                <Button block type="primary" onClick={applyAgentDraft}>
                                    应用到编辑器
                                </Button>
                            </>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成后在这里预览草稿" />
                        )}
                    </aside>
                </div>
            </Modal>
            <Modal title={runningWorkflow?.name || "运行工作流"} open={Boolean(runningWorkflow) && runnerVisible} width={980} onCancel={closeRunner} footer={null} destroyOnHidden>
                {runningWorkflow ? (
                    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
                        <div className="space-y-3">
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="text-sm font-medium">变量输入</div>
                                <div className="mt-3 space-y-3">
                                    {runningWorkflow.variables.map((variable) => (
                                        <WorkflowVariableInput key={variable.id} variable={variable} value={inputValues[variable.key] || ""} onChange={(value) => setInputValues((current) => ({ ...current, [variable.key]: value }))} />
                                    ))}
                                    {!runningWorkflow.variables.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此工作流没有变量" /> : null}
                                </div>
                            </div>
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="text-sm font-medium">参考图</div>
                                    <div className="flex gap-2">
                                        <Button size="small" onClick={() => setWorkflowAssetPickerOpen(true)}>
                                            我的素材
                                        </Button>
                                        <Button size="small" onClick={() => workflowReferenceInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <input
                                    ref={workflowReferenceInputRef}
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    className="hidden"
                                    onChange={(event) => {
                                        const input = event.currentTarget;
                                        void addWorkflowReferences(input.files).finally(() => {
                                            input.value = "";
                                        });
                                    }}
                                />
                                {workflowReferences.length ? (
                                    <div className="mt-3 grid grid-cols-4 gap-2">
                                        {workflowReferences.map((image) => (
                                            <div key={image.id} className="group relative overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                                <img src={image.dataUrl} alt={image.name} className="aspect-square w-full object-cover" />
                                                <button
                                                    type="button"
                                                    className="absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/65 text-white opacity-0 transition group-hover:opacity-100"
                                                    onClick={() => void removeWorkflowReference(image.id)}
                                                    aria-label="删除参考图"
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="mt-3 rounded-md border border-dashed border-stone-300 py-5 text-center text-xs text-stone-500 dark:border-stone-800">未添加参考图</div>
                                )}
                            </div>
                            <Button block type="primary" size="large" loading={seriesDraftLoading} icon={runningWorkflow.mode === "multi_image_series" ? <Layers3 className="size-4" /> : <Play className="size-4" />} onClick={() => void runWorkflow()}>
                                {runningWorkflow.mode === "multi_image_series" ? "生成提示词" : "启动任务"}
                            </Button>
                        </div>
                        <div className="space-y-3">
                            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="mb-2 flex items-center justify-between">
                                    <span className="text-sm font-medium">生成提示词预览</span>
                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(renderedPrompt)}>
                                        复制
                                    </Button>
                                </div>
                                <Typography.Paragraph className="!mb-0 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">{renderedPrompt || "填写变量后会在这里预览最终提示词"}</Typography.Paragraph>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-stone-500 dark:text-stone-400">
                                {runningWorkflow.mode === "multi_image_series" ? (
                                    <div className="col-span-2 rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-950">
                                        <div className="mb-1">提示词模型</div>
                                        <ModelPicker
                                            config={effectiveConfig}
                                            fullWidth
                                            value={resolveWorkflowPromptRuntime(runningWorkflow, effectiveConfig).model}
                                            channelId={resolveWorkflowPromptRuntime(runningWorkflow, effectiveConfig).channelId}
                                            excludeModels={excludedPromptPlannerModels}
                                            onChange={(model, channelId) => setRunningWorkflow((current) => (current ? { ...current, seriesConfig: { ...current.seriesConfig, promptModel: model, promptChannelId: channelId || "" } } : current))}
                                            onMissingConfig={() => openConfigDialog(false)}
                                        />
                                    </div>
                                ) : null}
                                <InfoPill label="模型" value={resolveWorkflowRuntime(runningWorkflow, effectiveConfig).model} />
                                <InfoPill label="接口" value={resolveWorkflowRuntime(runningWorkflow, effectiveConfig).apiMode === "responses" ? "Responses" : "Images"} />
                                <EditableWorkflowSize value={runningWorkflow.config.size || effectiveConfig.size || "auto"} onChange={(value) => setRunningWorkflow((current) => (current ? { ...current, config: { ...current.config, size: value } } : current))} />
                                <EditableWorkflowCount
                                    label={runningWorkflow.mode === "multi_image_series" ? "草稿数量" : "数量"}
                                    value={runningWorkflow.mode === "multi_image_series" ? runningWorkflow.seriesConfig.targetCount || "4" : runningWorkflow.config.count || "1"}
                                    max={runningWorkflow.mode === "multi_image_series" ? 20 : 10}
                                    onChange={(value) =>
                                        setRunningWorkflow((current) =>
                                            current
                                                ? current.mode === "multi_image_series"
                                                    ? { ...current, seriesConfig: { ...current.seriesConfig, targetCount: value } }
                                                    : { ...current, config: { ...current.config, count: value } }
                                                : current,
                                        )
                                    }
                                />
                            </div>
                            {runningWorkflow.mode === "multi_image_series" ? (
                                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 text-sm font-medium">
                                            <Layers3 className="size-4" />
                                            多图提示词
                                            <Tag className="m-0">{seriesDrafts.length} 条</Tag>
                                        </div>
                                        <div className="flex gap-2">
                                            <Button size="small" loading={seriesDraftLoading} onClick={() => void generateSeriesPromptDrafts()}>
                                                重新生成
                                            </Button>
                                            <Button size="small" type="primary" disabled={!activeSeriesDrafts.length} onClick={() => void runAllSeriesDrafts()}>
                                                发送工作台并开始
                                            </Button>
                                        </div>
                                    </div>
                                    {seriesDrafts.length ? (
                                        <>
                                            <div className="mb-3 flex gap-2">
                                                <Input value={seriesBatchAppend} placeholder="批量追加要求，例如：统一使用同一套品牌色和字体风格" onChange={(event) => setSeriesBatchAppend(event.target.value)} />
                                                <Button onClick={applySeriesBatchAppend}>批量追加</Button>
                                            </div>
                                            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                                                {seriesDrafts.map((draft, index) => (
                                                    <SeriesPromptDraftCard
                                                        key={draft.id}
                                                        draft={draft}
                                                        index={index}
                                                        isFirst={index === 0}
                                                        isLast={index === seriesDrafts.length - 1}
                                                        onChange={(patch) => updateSeriesDraft(draft.id, patch)}
                                                        onGenerate={() => void runSeriesDraft(draft, index)}
                                                        onCopy={() => void navigator.clipboard.writeText(draft.prompt)}
                                                        onMoveUp={() => moveSeriesDraft(draft.id, -1)}
                                                        onMoveDown={() => moveSeriesDraft(draft.id, 1)}
                                                        onDelete={() => deleteSeriesDraft(draft.id)}
                                                    />
                                                ))}
                                            </div>
                                        </>
                                    ) : (
                                        <div className="rounded-md border border-dashed border-stone-300 py-10 text-center text-sm text-stone-500 dark:border-stone-800">点击“生成提示词”后在这里审核每张图的提示词</div>
                                    )}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </Modal>
            <AssetPickerModal open={agentAssetPickerOpen} defaultTab="my-assets" onInsert={insertAgentAsset} onClose={() => setAgentAssetPickerOpen(false)} />
            <AssetPickerModal open={workflowAssetPickerOpen} defaultTab="my-assets" onInsert={insertWorkflowAsset} onClose={() => setWorkflowAssetPickerOpen(false)} />
        </main>
    );
}

function WorkflowCard({ workflow, onRun, onEdit, onCopy, onDelete }: { workflow: CreativeWorkflow; onRun: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void }) {
    const editable = workflow.editable !== false;
    return (
        <article className="group flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-xl dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700">
            <div className="h-1 bg-gradient-to-r from-stone-900 via-stone-500 to-stone-300 opacity-80 dark:from-stone-100 dark:via-stone-500 dark:to-stone-800" />
            <div className="flex flex-1 flex-col p-3.5">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="line-clamp-1 text-base font-semibold">{workflow.name}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0">{workflow.category || "未分类"}</Tag>
                        <Tag className="m-0" color={workflow.mode === "multi_image_series" ? "purple" : undefined}>
                            {workflow.mode === "multi_image_series" ? "多图" : "单图"}
                        </Tag>
                        <Tag className="m-0">{workflow.variables.length} 个变量</Tag>
                        <Tag className="m-0" color={workflow.scope === "public" ? "blue" : undefined}>
                            {workflow.scope === "public" ? "公开" : "个人"}
                        </Tag>
                    </div>
                </div>
                <Button type="primary" size="small" icon={<Play className="size-3.5" />} onClick={onRun}>
                    运行
                </Button>
            </div>
            <p className="mt-3 line-clamp-2 min-h-10 text-sm text-stone-500 dark:text-stone-400">{workflow.description || "暂无描述"}</p>
            <div className="mt-3 rounded-md bg-stone-100/80 p-3 text-xs text-stone-600 dark:bg-stone-950/80 dark:text-stone-300">
                <div className="line-clamp-5 whitespace-pre-wrap">{workflow.config.promptTemplate}</div>
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-stone-500">
                <span>{workflow.lastRunAt ? `最近运行 ${formatDate(workflow.lastRunAt)}` : `创建于 ${formatDate(workflow.createdAt)}`}</span>
                <div className="flex gap-1">
                    <Button size="small" disabled={!editable} icon={<Edit3 className="size-3.5" />} onClick={onEdit} />
                    <Button size="small" icon={<FilePlus2 className="size-3.5" />} onClick={onCopy} />
                    <Button size="small" disabled={!editable} danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
                </div>
            </div>
            </div>
        </article>
    );
}

function WorkflowTaskCard({ task, now, onCopyPrompt, onDownload }: { task: WorkflowTask; now: number; onCopyPrompt: () => void; onDownload: (image: WorkflowRunResult, index: number) => void }) {
    const elapsedMs = task.status === "running" ? now - task.startedAt : task.durationMs || (task.endedAt || task.startedAt) - task.startedAt;
    const statusView = {
        running: { label: "运行中", color: "processing", icon: <LoaderCircle className="size-4 animate-spin" /> },
        success: { label: "成功", color: "success", icon: <CheckCircle2 className="size-4" /> },
        failed: { label: "失败", color: "error", icon: <AlertCircle className="size-4" /> },
    }[task.status];

    return (
        <article className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-start justify-between gap-3 border-b border-stone-200 p-3 dark:border-stone-800">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 text-stone-500 dark:text-stone-400">{statusView.icon}</span>
                        <div className="truncate font-medium">{task.workflowName}</div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                        <Tag className="m-0" color={statusView.color}>
                            {statusView.label}
                        </Tag>
                        <Tag className="m-0">{formatDuration(elapsedMs)}</Tag>
                        <Tag className="m-0">{formatDate(task.startedAt)}</Tag>
                    </div>
                </div>
                <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopyPrompt}>
                    复制提示词
                </Button>
            </div>
            <div className="space-y-3 p-3">
                <div className="line-clamp-2 whitespace-pre-wrap text-sm text-stone-600 dark:text-stone-300">{task.prompt}</div>
                <div className="flex flex-wrap gap-1">
                    <Tag className="m-0 text-[10px]">{task.model}</Tag>
                    <Tag className="m-0 text-[10px]">{task.apiMode === "responses" ? "Responses" : "Images"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.size || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.quality || "auto"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.config.outputFormat || "png"}</Tag>
                    <Tag className="m-0 text-[10px]">{task.count} 张</Tag>
                    {task.config.streamImages ? <Tag className="m-0 text-[10px]">流式 {task.config.streamPartialImages || "1"}</Tag> : null}
                    <Tag className="m-0 text-[10px]">超时 {task.config.timeout || "600"}s</Tag>
                </div>
                {Object.keys(task.inputs).length ? (
                    <div className="flex flex-wrap gap-1">
                        {Object.entries(task.inputs)
                            .filter(([, value]) => String(value).trim())
                            .slice(0, 6)
                            .map(([key, value]) => (
                                <Tag key={key} className="m-0 max-w-full text-[10px]">
                                    <span className="font-medium">{key}</span>: <span className="inline-block max-w-48 truncate align-bottom">{String(value)}</span>
                                </Tag>
                            ))}
                    </div>
                ) : null}
                {task.error ? <div className="rounded-md bg-red-100 px-2.5 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">{task.error}</div> : null}
                {task.images.length ? (
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        {task.images.map((image, index) => (
                            <div key={image.id} className="overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-950">
                                <Image src={image.imageUrl} alt={`${task.workflowName} ${index + 1}`} className="aspect-[4/3] object-cover" />
                                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] text-stone-500">
                                    <span className="truncate">
                                        {image.width}x{image.height} · {formatBytes(image.bytes)}
                                    </span>
                                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)} />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : task.status === "running" ? (
                    <div className="flex h-28 items-center justify-center rounded-md border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-800">生成中 {formatDuration(elapsedMs)}</div>
                ) : null}
            </div>
        </article>
    );
}

function SeriesPromptDraftCard({
    draft,
    index,
    isFirst,
    isLast,
    onChange,
    onGenerate,
    onCopy,
    onMoveUp,
    onMoveDown,
    onDelete,
}: {
    draft: SeriesPromptDraft;
    index: number;
    isFirst: boolean;
    isLast: boolean;
    onChange: (patch: Partial<SeriesPromptDraft>) => void;
    onGenerate: () => void;
    onCopy: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onDelete: () => void;
}) {
    const statusView = {
        draft: { label: "待生成", color: undefined },
        running: { label: "生成中", color: "processing" },
        success: { label: "已完成", color: "success" },
        failed: { label: "失败", color: "error" },
    }[draft.status];
    return (
        <article className="rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-950">
            <div className="mb-2 flex items-center justify-between gap-2">
                <Input value={draft.title} className="max-w-[280px]" placeholder={`第 ${index + 1} 张标题`} onChange={(event) => onChange({ title: event.target.value })} />
                <div className="flex shrink-0 items-center gap-1">
                    <Tag className="m-0" color={statusView.color}>{statusView.label}</Tag>
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopy} />
                    <Button size="small" disabled={isFirst} icon={<ArrowUp className="size-3.5" />} onClick={onMoveUp} />
                    <Button size="small" disabled={isLast} icon={<ArrowDown className="size-3.5" />} onClick={onMoveDown} />
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
                    <Button size="small" type="primary" loading={draft.status === "running"} disabled={draft.status === "success"} icon={<Play className="size-3.5" />} onClick={onGenerate}>
                        生成
                    </Button>
                </div>
            </div>
            <Input.TextArea value={draft.prompt} autoSize={{ minRows: 3, maxRows: 7 }} onChange={(event) => onChange({ prompt: event.target.value, status: draft.status === "success" ? "draft" : draft.status })} />
            {draft.error ? <div className="mt-2 rounded-md bg-red-100 px-2.5 py-1.5 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">{draft.error}</div> : null}
        </article>
    );
}

function WorkflowEditorModal({
    open,
    workflow,
    modelConfig,
    theme,
    onChange,
    onCancel,
    onSave,
}: {
    open: boolean;
    workflow: CreativeWorkflow | null;
    modelConfig: AiConfig;
    theme: CanvasTheme;
    onChange: (workflow: CreativeWorkflow | null) => void;
    onCancel: () => void;
    onSave: (workflow: CreativeWorkflow) => void;
}) {
    if (!workflow) return null;
    const { message } = App.useApp();
    const patch = (next: Partial<CreativeWorkflow>) => onChange({ ...workflow, ...next });
    const patchConfig = (next: Partial<WorkflowGenerationConfig>) => patch({ config: { ...workflow.config, ...next } });
    const patchSeriesConfig = (next: Partial<WorkflowSeriesConfig>) => patch({ seriesConfig: { ...workflow.seriesConfig, ...next } });
    const patchVariable = (id: string, next: Partial<WorkflowVariable>) => patch({ variables: workflow.variables.map((item) => (item.id === id ? normalizeVariable({ ...item, ...next }) : item)) });
    const removeVariable = (id: string) => patch({ variables: workflow.variables.filter((item) => item.id !== id) });
    const templateTokens = workflow.variables.map((variable) => ({
        id: variable.id,
        label: variable.label || variable.key,
        preferredToken: `{{${variable.label || variable.key}}}`,
        legacyToken: `{{${variable.key}}}`,
        showLegacy: Boolean(variable.key && variable.label && variable.key !== variable.label),
    }));
    const copyToken = async (token: string) => {
        try {
            await navigator.clipboard.writeText(token);
            message.success(`已复制 ${token}`);
        } catch {
            message.error("复制失败，请手动复制");
        }
    };

    return (
        <Modal title={workflow.createdAt ? "编辑工作流" : "新建工作流"} open={open} width={1080} onCancel={onCancel} onOk={() => onSave(workflow)} okText="保存" cancelText="取消" destroyOnHidden>
            <div className="grid max-h-[72vh] gap-4 overflow-y-auto pr-1 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="space-y-4">
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <div className="text-sm font-medium">基础信息</div>
                                <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">先把这个工作流是干什么的、给谁用，说清楚。</div>
                            </div>
                            <div className="inline-flex rounded-md border border-stone-300 bg-transparent p-0.5 dark:border-stone-700">
                                <button
                                    type="button"
                                    title="仅自己可见"
                                    className={`inline-flex h-8 items-center gap-1 rounded px-2 text-xs transition ${workflow.scope !== "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`}
                                    onClick={() => patch({ scope: "private" })}
                                >
                                    <LockKeyhole className="size-3.5" />
                                    仅自己可见
                                </button>
                                <button
                                    type="button"
                                    title="全部账号可见"
                                    className={`inline-flex h-8 items-center gap-1 rounded px-2 text-xs transition ${workflow.scope === "public" ? "border border-stone-400 text-stone-950 dark:border-stone-500 dark:text-stone-50" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"}`}
                                    onClick={() => patch({ scope: "public" })}
                                >
                                    <Globe2 className="size-3.5" />
                                    全部账号可见
                                </button>
                            </div>
                        </div>
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">工作流名称</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">别人一眼就能看懂这个工作流是做什么的。</div>
                            <Input value={workflow.name} placeholder="例如：健康产品图包生成" onChange={(event) => patch({ name: event.target.value })} />
                        </label>
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">分类</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">方便在工作台里归类查找。</div>
                            <Input value={workflow.category} placeholder="例如：电商产品图包" onChange={(event) => patch({ category: event.target.value })} />
                        </label>
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">出图方式</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">单张出图适合一次只生 1 张；一套多图适合先拆主图、副图、详情图。</div>
                            <Select value={workflow.mode} options={workflowModeOptions} onChange={(mode) => patch({ mode })} />
                        </label>
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">适用场景说明</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">简单说清楚：上传什么、填写什么、最后会产出什么。</div>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={workflow.description} placeholder="例如：上传产品白底图后，自动拆主图、副图、详情图。" onChange={(event) => patch({ description: event.target.value })} />
                        </label>
                    </section>
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-medium">让使用者填写的信息</div>
                                <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">这里决定别人运行这个工作流时，要填哪些内容。名称尽量直接，比如“产品名称”“核心卖点”。</div>
                            </div>
                            <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => patch({ variables: [...workflow.variables, createVariable("", "新字段")] })}>
                                添加变量
                            </Button>
                        </div>
                        <div className="space-y-2">
                            {workflow.variables.map((variable, index) => (
                                <div key={variable.id} className="space-y-3 rounded-lg border border-stone-200 bg-stone-100 p-3 dark:border-stone-800 dark:bg-stone-950">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="text-xs text-stone-500 dark:text-stone-400">字段 {index + 1}</div>
                                        <Button danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => removeVariable(variable.id)}>
                                            删除
                                        </Button>
                                    </div>
                                    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
                                        <label className="space-y-1.5 text-sm">
                                            <div className="font-medium">别人会看到的名称</div>
                                            <Input value={variable.label} placeholder="例如：产品名称" onChange={(event) => patchVariable(variable.id, { label: event.target.value })} />
                                        </label>
                                        <label className="space-y-1.5 text-sm">
                                            <div className="font-medium">填写方式</div>
                                            <Select
                                                value={variable.type}
                                                options={variableTypeOptions}
                                                onChange={(value) => {
                                                    const inferredOptions = inferVariableOptions(variable);
                                                    patchVariable(variable.id, { type: value, options: value === "select" && !variable.options.length ? inferredOptions : variable.options });
                                                }}
                                            />
                                        </label>
                                        <div className="flex items-end">
                                            <Checkbox checked={variable.required} onChange={(event) => patchVariable(variable.id, { required: event.target.checked })}>
                                                必填
                                            </Checkbox>
                                        </div>
                                    </div>
                                    <VariableEditorValueControls variable={variable} onChange={(next) => patchVariable(variable.id, next)} />
                                    <details className="rounded-md border border-dashed border-stone-300 px-3 py-2 text-sm dark:border-stone-700">
                                        <summary className="cursor-pointer list-none font-medium text-stone-700 dark:text-stone-200">高级设置：模板兼容字段</summary>
                                        <div className="mt-2 space-y-1.5">
                                            <div className="text-xs text-stone-500 dark:text-stone-400">这个字段主要给旧模板兼容用。小白一般不用改，默认保持现在这样就行。</div>
                                            <Input value={variable.key} placeholder="例如：product_name" onChange={(event) => patchVariable(variable.id, { key: event.target.value })} />
                                            <div className="text-xs text-stone-500 dark:text-stone-400">
                                                当前兼容写法：
                                                <code className="ml-1 rounded bg-stone-200 px-1 py-0.5 text-[11px] text-stone-900 dark:bg-stone-800 dark:text-stone-100">{`{{${variable.key}}}`}</code>
                                            </div>
                                        </div>
                                    </details>
                                </div>
                            ))}
                        </div>
                    </section>
                    <section className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div>
                            <div className="text-sm font-medium">提示词模板</div>
                            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                                这里写的是最终喂给模型的提示词骨架。现在可以直接写中文占位符，比如
                                <code className="mx-1 rounded bg-stone-200 px-1 py-0.5 text-[11px] text-stone-900 dark:bg-stone-800 dark:text-stone-100">{"{{产品名称}}"}</code>
                                ，也兼容旧写法
                                <code className="mx-1 rounded bg-stone-200 px-1 py-0.5 text-[11px] text-stone-900 dark:bg-stone-800 dark:text-stone-100">{"{{product_name}}"}</code>
                                。
                            </div>
                        </div>
                        {templateTokens.length ? (
                            <div className="rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">
                                <div className="mb-2 font-medium">可直接复制的占位符</div>
                                <div className="flex flex-wrap gap-2">
                                    {templateTokens.map((token) => (
                                        <div key={token.id} className="inline-flex items-center gap-1 rounded-full border border-stone-300 px-2 py-1 text-xs dark:border-stone-700">
                                            <button type="button" className="font-medium text-stone-900 dark:text-stone-100" onClick={() => void copyToken(token.preferredToken)}>
                                                {token.preferredToken}
                                            </button>
                                            {token.showLegacy ? <span className="text-stone-500 dark:text-stone-400">兼容 {token.legacyToken}</span> : null}
                                            <Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={() => void copyToken(token.preferredToken)} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">角色说明（可选）</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">只有当你想固定模型的语气、身份、规则时再填；不填也可以。</div>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={workflow.config.systemPrompt} placeholder="例如：你是一个电商主图策划助手，擅长生成合规、好转化的图片提示词。" onChange={(event) => patchConfig({ systemPrompt: event.target.value })} />
                        </label>
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">生成提示词模板</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">把固定要求写死，把需要别人填写的内容放成占位符。</div>
                            <Input.TextArea autoSize={{ minRows: 7, maxRows: 14 }} value={workflow.config.promptTemplate} placeholder={"例如：为 {{产品名称}} 生成电商主图。\n产品卖点：{{核心卖点}}\n要求：严格参考上传产品图，保持包装一致。"} onChange={(event) => patchConfig({ promptTemplate: event.target.value })} />
                        </label>
                        <label className="block space-y-1.5 text-sm">
                            <div className="font-medium">不想出现的内容（可选）</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">这里专门写禁止项，比如夸大文案、杂乱背景、手部畸形、包装变形。</div>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={workflow.config.negativePrompt} placeholder="例如：避免夸大功效、避免药品风、避免包装文字错误、避免背景过乱。" onChange={(event) => patchConfig({ negativePrompt: event.target.value })} />
                        </label>
                    </section>
                </div>
                <aside className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div>
                        <div className="text-sm font-medium">出图设置</div>
                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">这里只放真正影响出图结果的配置；接口兼容类设置已经收进高级设置。</div>
                    </div>
                    <div className="space-y-1.5">
                        <div className="text-sm font-medium">用哪个模型出图</div>
                        <ModelPicker config={modelConfig} fullWidth value={workflow.config.imageModel || workflow.config.model} channelId={workflow.config.imageChannelId || modelConfig.imageChannelId} onChange={(value, channelId) => patchConfig({ imageModel: value, model: value, ...(channelId ? { imageChannelId: channelId } : {}) })} />
                    </div>
                    {workflow.mode === "multi_image_series" ? (
                        <div className="space-y-3 rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">
                            <div className="flex items-center gap-2 font-medium">
                                <Layers3 className="size-4" />
                                自动拆图规则
                            </div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">这块决定系统先帮你拆成几张图、每张图偏什么内容，以及要不要先给你审核提示词。</div>
                            <ModelPicker
                                config={modelConfig}
                                fullWidth
                                value={workflow.seriesConfig.promptModel || modelConfig.textModel || modelConfig.model}
                                channelId={workflow.seriesConfig.promptChannelId || modelConfig.textChannelId}
                                placeholder="选择用来先拆提示词的文字模型"
                                excludeModels={excludedPromptPlannerModels}
                                onChange={(model, channelId) => patchSeriesConfig({ promptModel: model, promptChannelId: channelId || "" })}
                            />
                            <div className="grid grid-cols-2 gap-2">
                                <Space.Compact className="w-full">
                                    <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-2 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">先拆成几张</span>
                                    <Input value={workflow.seriesConfig.targetCount} onChange={(event) => patchSeriesConfig({ targetCount: event.target.value })} />
                                </Space.Compact>
                                <Space.Compact className="w-full">
                                    <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-2 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">同时生成几张</span>
                                    <Input value={workflow.seriesConfig.concurrency} onChange={(event) => patchSeriesConfig({ concurrency: event.target.value })} />
                                </Space.Compact>
                            </div>
                            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} value={workflow.seriesConfig.promptInstruction} placeholder="例如：固定拆成 1 张主图、4 张副图、11 张详情图；详情图统一做竖版长图模块。" onChange={(event) => patchSeriesConfig({ promptInstruction: event.target.value })} />
                            <ToggleRow label="先给我看拆好的每张提示词" checked={workflow.seriesConfig.reviewRequired !== false} onChange={(checked) => patchSeriesConfig({ reviewRequired: checked })} />
                        </div>
                    ) : null}
                    <ImageSettingsPanel
                        config={{ ...defaultConfig, ...workflow.config, model: workflow.config.model || defaultConfig.model, imageModel: workflow.config.imageModel || workflow.config.model || defaultConfig.imageModel }}
                        onConfigChange={(key, value) => patchConfig({ [key]: value } as Partial<WorkflowGenerationConfig>)}
                        theme={theme}
                        showTitle={false}
                        className="space-y-4"
                        maxCount={10}
                        quickCount={6}
                        collapsible
                    />
                    <details className="rounded-md bg-stone-100 p-3 text-sm dark:bg-stone-950">
                        <summary className="cursor-pointer list-none font-medium">高级接口设置（一般不用改）</summary>
                        <div className="mt-3 space-y-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">只有在接口兼容、超时、外部工作台接入时再改这里。日常出图保持默认即可。</div>
                            <label className="block space-y-1.5">
                                <div className="font-medium">接口模式</div>
                                <Select
                                    className="w-full"
                                    value={workflow.config.apiMode}
                                    options={[
                                        { value: "images", label: "Images API（直接生图，默认）" },
                                        { value: "responses", label: "Responses API（适合复杂链路）" },
                                    ]}
                                    onChange={(value) => patchConfig({ apiMode: value })}
                                />
                            </label>
                            <ToggleRow label="流式返回图片过程" checked={workflow.config.streamImages} onChange={(checked) => patchConfig({ streamImages: checked })} />
                            <ToggleRow label="返回 Base64 数据" checked={workflow.config.responseFormatB64Json} onChange={(checked) => patchConfig({ responseFormatB64Json: checked })} />
                            <ToggleRow label="兼容 Codex CLI 调用" checked={workflow.config.codexCli} onChange={(checked) => patchConfig({ codexCli: checked })} />
                            <Space.Compact className="w-full">
                                <span className="inline-flex h-8 shrink-0 items-center rounded-l-md border border-r-0 border-stone-300 bg-stone-50 px-3 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">超时(秒)</span>
                                <Input value={workflow.config.timeout} onChange={(event) => patchConfig({ timeout: event.target.value })} />
                            </Space.Compact>
                        </div>
                    </details>
                </aside>
            </div>
        </Modal>
    );
}

function WorkflowVariableInput({ variable, value, onChange }: { variable: WorkflowVariable; value: string; onChange: (value: string) => void }) {
    return (
        <label className="block space-y-1.5 text-sm">
            <span className="flex items-center gap-1 font-medium">
                {variable.label || variable.key}
                {variable.required ? <span className="text-red-500">*</span> : null}
            </span>
            {variable.type === "textarea" ? (
                <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} value={value} placeholder={variable.placeholder || variable.defaultValue} onChange={(event) => onChange(event.target.value)} />
            ) : variable.type === "select" ? (
                <Select className="w-full" value={value || undefined} placeholder={variable.placeholder || "请选择"} options={variable.options.map((item) => ({ value: item, label: item }))} onChange={onChange} />
            ) : (
                <Input value={value} placeholder={variable.placeholder || variable.defaultValue} onChange={(event) => onChange(event.target.value)} />
            )}
        </label>
    );
}

function VariableEditorValueControls({ variable, onChange }: { variable: WorkflowVariable; onChange: (next: Partial<WorkflowVariable>) => void }) {
    const [optionDraft, setOptionDraft] = useState(variable.options.join(" / "));
    useEffect(() => {
        if (variable.type === "select") setOptionDraft(variable.options.join(" / "));
    }, [variable.id, variable.type]);

    if (variable.type === "select") {
        return (
            <div className="grid gap-2 lg:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                    <div className="font-medium">不知道怎么填时的提示语</div>
                    <Input value={variable.placeholder || ""} placeholder="例如：请选择你想要的风格" onChange={(event) => onChange({ placeholder: event.target.value })} />
                </label>
                <label className="space-y-1.5 text-sm">
                    <div className="font-medium">默认选项</div>
                    <Select className="w-full" value={variable.defaultValue || undefined} placeholder="默认选项" options={variable.options.map((item) => ({ value: item, label: item }))} onChange={(value) => onChange({ defaultValue: value })} />
                </label>
                <label className="space-y-1.5 text-sm lg:col-span-2">
                    <div className="font-medium">可选内容</div>
                    <div className="text-xs text-stone-500 dark:text-stone-400">用 `/` 分隔，例如：简约白底 / 自然草本 / 科研感。</div>
                    <Input
                        value={optionDraft}
                        placeholder="例如：自动 / 清冷私房 / 极简韩系"
                        onChange={(event) => {
                            const text = event.target.value;
                            setOptionDraft(text);
                            const options = parseVariableOptions(text);
                            onChange({ options, defaultValue: options.includes(variable.defaultValue) ? variable.defaultValue : options[0] || "" });
                        }}
                    />
                </label>
            </div>
        );
    }
    if (variable.type === "textarea") {
        return (
            <div className="grid gap-2 lg:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                    <div className="font-medium">输入框提示语</div>
                    <Input value={variable.placeholder || ""} placeholder="例如：把产品卖点、功效、场景都写在这里" onChange={(event) => onChange({ placeholder: event.target.value })} />
                </label>
                <label className="space-y-1.5 text-sm">
                    <div className="font-medium">默认内容</div>
                    <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={variable.defaultValue} placeholder="留空表示不预填" onChange={(event) => onChange({ defaultValue: event.target.value })} />
                </label>
            </div>
        );
    }
    return (
        <div className="grid gap-2 lg:grid-cols-2">
            <label className="space-y-1.5 text-sm">
                <div className="font-medium">输入框提示语</div>
                <Input value={variable.placeholder || ""} placeholder="例如：请输入产品名称" onChange={(event) => onChange({ placeholder: event.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
                <div className="font-medium">默认内容</div>
                <Input value={variable.defaultValue} placeholder="留空表示不预填" onChange={(event) => onChange({ defaultValue: event.target.value })} />
            </label>
        </div>
    );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span>{label}</span>
            <Switch size="small" checked={checked} onChange={onChange} />
        </div>
    );
}

function InfoPill({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-950">
            <div>{label}</div>
            <div className="mt-1 truncate text-stone-900 dark:text-stone-100">{value}</div>
        </div>
    );
}

function EditableWorkflowSize({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const options = ["auto", "1:1", "9:16", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "1152x2048"];
    return (
        <label className="rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-950">
            <div>尺寸</div>
            <select className="mt-1 h-7 w-full rounded border border-stone-300 bg-background px-2 text-xs text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" value={value} onChange={(event) => onChange(event.target.value)}>
                {options.map((item) => (
                    <option key={item} value={item}>
                        {item}
                    </option>
                ))}
            </select>
        </label>
    );
}

function EditableWorkflowCount({ label, value, max, onChange }: { label: string; value: string; max: number; onChange: (value: string) => void }) {
    return (
        <label className="rounded-md bg-stone-100 px-3 py-2 dark:bg-stone-950">
            <div>{label}</div>
            <input
                className="mt-1 h-7 w-full rounded border border-stone-300 bg-background px-2 text-xs text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100"
                type="number"
                min={1}
                max={max}
                value={value}
                onChange={(event) => onChange(String(Math.max(1, Math.min(max, Number(event.target.value) || 1))))}
            />
        </label>
    );
}

function createBlankWorkflow(config: AiConfig, mode: WorkflowMode = "single_image"): CreativeWorkflow {
    const now = Date.now();
    const series = mode === "multi_image_series";
    return normalizeWorkflow({
        id: nanoid(),
        scope: "private",
        editable: true,
        name: series ? "健康产品图包生成" : "",
        category: series ? "电商产品图包" : "",
        description: series ? "上传一张产品图，填写产品信息后自动拆成主图、副图和详情图。" : "",
        mode,
        variables: series
            ? [
                  createVariable("product_name", "产品名称"),
                  createVariable("product_type", "产品类型"),
                  createVariable("selling_points", "卖点", "textarea"),
                  createVariable("specs", "规格"),
                  createVariable("target_people", "适用人群"),
                  createVariable("style", "统一风格"),
              ]
            : [createVariable("product_name", "产品名称"), createVariable("selling_points", "产品卖点", "textarea")],
        config: {
            ...createWorkflowConfig(config),
            ...(series
                ? {
                      count: "1",
                      size: "1:1",
                      promptTemplate:
                          "为 {{product_name}} 生成一套电商产品图包。\n产品类型：{{product_type}}\n核心卖点：{{selling_points}}\n规格信息：{{specs}}\n适用人群：{{target_people}}\n统一风格：{{style}}\n要求：严格参考上传产品图，保持包装外观、瓶身/盒型、标签、品牌视觉一致；文案表达适合健康护理/保健品/消字号电商场景，避免医疗功效承诺。",
                  }
                : {}),
        },
        seriesConfig: series ? createProductPackageSeriesConfig(config) : createWorkflowSeriesConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterWorkflows(config: AiConfig) {
    return [createStarterWorkflow(config), createStarterProductPackageWorkflow(config), createStarterSeriesWorkflow(config)];
}

function ensureStarterProductPackageWorkflow(workflows: CreativeWorkflow[], config: AiConfig) {
    if (workflows.some((workflow) => isProductPackageWorkflow(workflow))) return workflows;
    return [createStarterProductPackageWorkflow(config), ...workflows];
}

function createStarterWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "public",
        editable: true,
        name: "电商海报生成",
        category: "电商海报",
        description: "固定海报构图、商业摄影质感和营销文案结构，只替换产品与卖点。",
        mode: "single_image",
        variables: [createVariable("product_name", "产品名称"), createVariable("selling_points", "核心卖点", "textarea"), createVariable("campaign", "活动信息")],
        config: {
            ...createWorkflowConfig(config),
            promptTemplate: "为 {{product_name}} 生成一张高端电商海报。\n核心卖点：{{selling_points}}\n活动信息：{{campaign}}\n要求：主体清晰、构图高级、商品有强烈质感，画面适合社交媒体和电商首图。",
        },
        seriesConfig: createWorkflowSeriesConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterSeriesWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "public",
        editable: true,
        name: "小红书文章配图组",
        category: "多图创作",
        description: "根据文章主题和内容生成多张风格统一的封面、步骤、要点和总结配图。",
        mode: "multi_image_series",
        variables: [createVariable("article_topic", "文章主题"), createVariable("article_content", "文章内容", "textarea"), createVariable("visual_style", "视觉风格")],
        config: {
            ...createWorkflowConfig(config),
            count: "1",
            promptTemplate: "为小红书/公众号文章《{{article_topic}}》生成系列配图。\n文章内容：{{article_content}}\n视觉风格：{{visual_style}}\n要求：画面适合移动端阅读，主题连贯，每张图表达一个清晰信息点。",
        },
        seriesConfig: {
            ...createWorkflowSeriesConfig(config),
            targetCount: "6",
            promptInstruction: "拆成封面图、问题/痛点图、核心步骤图、细节说明图、对比/案例图和总结图；每张图都需要独立完整的图片提示词。",
            concurrency: "3",
        },
        createdAt: now,
        updatedAt: now,
    });
}

function createStarterProductPackageWorkflow(config: AiConfig): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: "public",
        editable: true,
        name: "健康产品图包生成",
        category: "电商产品图包",
        description: "给一张产品图和基础信息，自动规划主图 1 张、副图 4 张、详情图 11 张。",
        mode: "multi_image_series",
        variables: [
            createVariable("product_name", "产品名称"),
            createVariable("product_type", "产品类型"),
            createVariable("selling_points", "核心卖点", "textarea"),
            createVariable("specs", "规格"),
            createVariable("target_people", "适用人群"),
            createVariable("style", "统一风格"),
        ],
        config: {
            ...createWorkflowConfig(config),
            count: "1",
            size: "1:1",
            promptTemplate:
                "为 {{product_name}} 生成一套电商产品图包。\n产品类型：{{product_type}}\n核心卖点：{{selling_points}}\n规格信息：{{specs}}\n适用人群：{{target_people}}\n统一风格：{{style}}\n要求：严格参考上传产品图，保持包装外观、瓶身/盒型、标签、品牌视觉一致；文案表达适合健康护理/保健品/消字号电商场景，避免医疗功效承诺。",
        },
        seriesConfig: createProductPackageSeriesConfig(config),
        createdAt: now,
        updatedAt: now,
    });
}

function createProductPackageSeriesConfig(config: AiConfig): WorkflowSeriesConfig {
    return {
        ...createWorkflowSeriesConfig(config),
        targetCount: "16",
        promptInstruction:
            "固定拆成 16 张：1 张主图（1:1，白底/浅底，产品居中清晰）；4 张副图（1:1，核心卖点、成分/规格、使用场景、适用人群/质感展示）；11 张详情图（竖版长图，详情页模块，包括产品利益点、成分/规格、使用步骤、场景、质感、包装细节、注意事项、品牌背书风格总结）。每张图标题必须带主图/副图/详情图分类，文案合规，不写治疗、根治、药效、医生背书和夸大承诺。",
        concurrency: "3",
    };
}

function createWorkflowConfig(config: AiConfig): WorkflowGenerationConfig {
    return {
        model: config.model || defaultConfig.model,
        imageModel: config.imageModel || config.model || defaultConfig.imageModel,
        imageChannelId: config.imageChannelId || "",
        quality: config.quality || defaultConfig.quality,
        size: config.size || defaultConfig.size,
        count: config.count || "1",
        apiMode: config.apiMode || "images",
        outputFormat: config.outputFormat || "png",
        outputCompression: config.outputCompression || "100",
        moderation: config.moderation || "auto",
        timeout: config.timeout || "600",
        streamImages: Boolean(config.streamImages),
        streamPartialImages: config.streamPartialImages || "1",
        responseFormatB64Json: config.responseFormatB64Json !== false,
        codexCli: Boolean(config.codexCli),
        systemPrompt: config.systemPrompts.workflow || config.systemPrompt || "",
        promptTemplate: "",
        negativePrompt: "",
    };
}

function isExcludedPromptPlannerModel(model: string) {
    return excludedPromptPlannerModels.includes(model.trim().toLowerCase());
}

function availablePromptPlannerModels(config: AiConfig) {
    const channels =
        config.channelMode === "remote"
            ? config.publicChannels.map((channel) => channel.models || [])
            : normalizeLocalChannels(config).map((channel) => channel.models || []);
    return Array.from(new Set(channels.flatMap((models) => models).filter((model) => model && !isExcludedPromptPlannerModel(model))));
}

function resolvePromptPlannerModel(config: AiConfig, preferredModel?: string) {
    const normalizedPreferred = preferredModel?.trim() || "";
    const available = availablePromptPlannerModels(config);
    if (normalizedPreferred && !isExcludedPromptPlannerModel(normalizedPreferred) && (!available.length || available.includes(normalizedPreferred))) return normalizedPreferred;
    if (!available.length) return defaultConfig.textModel;
    if (available.includes(defaultConfig.textModel)) return defaultConfig.textModel;
    const textModel = config.textModel?.trim() || "";
    if (textModel && !isExcludedPromptPlannerModel(textModel) && available.includes(textModel)) return textModel;
    const baseModel = config.model?.trim() || "";
    if (baseModel && !isExcludedPromptPlannerModel(baseModel) && available.includes(baseModel)) return baseModel;
    return available[0];
}

function createWorkflowSeriesConfig(config: AiConfig): WorkflowSeriesConfig {
    return {
        targetCount: "4",
        promptModel: resolvePromptPlannerModel(config, config.textModel || config.model || defaultConfig.textModel),
        promptChannelId: config.textChannelId || "",
        promptInstruction: "围绕同一主题拆分成封面图、核心信息图、场景图和总结图；每张图需要画面重点不同但视觉风格一致。",
        reviewRequired: true,
        concurrency: "3",
    };
}

function describeModelSelection(config: AiConfig, modelName: string, channelId: string) {
    const selectedModel = modelName || "未选择模型";
    if (config.channelMode === "local") {
        const channel = localChannelForActiveModel({ ...config, model: selectedModel, activeChannelId: channelId });
        return { channelName: channel?.name || "本地直连", modelName: selectedModel };
    }
    const channel =
        config.publicChannels.find((item) => item.id === channelId && item.models.includes(selectedModel)) ||
        config.publicChannels.find((item) => item.models.includes(selectedModel)) ||
        config.publicChannels.find((item) => item.id === channelId) ||
        config.publicChannels[0];
    return { channelName: channel?.name || "云端渠道", modelName: selectedModel };
}

function resolveWorkflowPromptRuntime(workflow: CreativeWorkflow, baseConfig: AiConfig) {
    const fallbackModel = resolvePromptPlannerModel(baseConfig, baseConfig.textModel || baseConfig.model || defaultConfig.textModel);
    const preferredModel = resolvePromptPlannerModel(baseConfig, workflow.seriesConfig.promptModel || fallbackModel);
    const preferredChannelId = workflow.seriesConfig.promptChannelId || baseConfig.textChannelId;
    if (isModelAvailableForChannel(baseConfig, preferredModel, preferredChannelId)) {
        return { model: preferredModel, channelId: preferredChannelId || channelIdForModelName(baseConfig, preferredModel) };
    }
    if (isModelAvailableForChannel(baseConfig, fallbackModel, baseConfig.textChannelId || channelIdForModelName(baseConfig, fallbackModel))) {
        return { model: fallbackModel, channelId: baseConfig.textChannelId || channelIdForModelName(baseConfig, fallbackModel) };
    }
    return { model: fallbackModel, channelId: baseConfig.textChannelId || channelIdForModelName(baseConfig, fallbackModel) };
}

function isModelAvailableForChannel(config: AiConfig, model: string, channelId?: string) {
    if (!model.trim()) return false;
    const channels =
        config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({ id: channel.id, models: channel.models }))
            : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, models: channel.models }));
    if (!channels.length) return true;
    return channels.some((channel) => channel.models.includes(model) && (!channelId || channel.id === channelId));
}

function channelIdForModelName(config: AiConfig, model: string) {
    const channels =
        config.channelMode === "remote"
            ? config.publicChannels.map((channel) => ({ id: channel.id, models: channel.models }))
            : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, models: channel.models }));
    return channels.find((channel) => channel.models.includes(model))?.id || "";
}

function createVariable(key = "", label = "", type: WorkflowVariableType = "text"): WorkflowVariable {
    return normalizeVariable({ id: nanoid(), key, label, type, required: true, defaultValue: "", options: [] });
}

function normalizeVariableType(value: string | undefined): WorkflowVariableType {
    if (value === "textarea" || value === "select") return value;
    return "text";
}

function normalizeAgentDraft(draft: Partial<CreativeWorkflow>, config: AiConfig, scope: "private" | "public"): CreativeWorkflow {
    const now = Date.now();
    return normalizeWorkflow({
        id: nanoid(),
        scope: draft.scope === "public" ? "public" : scope,
        editable: true,
        name: draft.name || "AI 创建工作流",
        category: draft.category || "",
        description: draft.description || "",
        mode: draft.mode === "multi_image_series" ? "multi_image_series" : "single_image",
        variables: (draft.variables || []).map((variable) => ({ ...createVariable(), ...variable, id: variable.id || nanoid() })),
        config: { ...createWorkflowConfig(config), ...(draft.config || {}) },
        seriesConfig: { ...createWorkflowSeriesConfig(config), ...(draft.seriesConfig || {}) },
        createdAt: now,
        updatedAt: now,
    });
}

function normalizeVariable(variable: WorkflowVariable): WorkflowVariable {
    const legacyUnsupportedType = String(variable.type) === "boolean" || String(variable.type) === "number";
    const normalizedType = normalizeVariableType(String(variable.type || ""));
    const normalizedKey = normalizeVariableKey(variable.key) || normalizeVariableKey(variable.label) || fallbackVariableKey(variable.id);
    const label = variable.label?.trim() || (!variable.key?.trim() && /^field_[\w]+$/i.test(normalizedKey) ? "新字段" : normalizedKey);
    const normalizedDefaultValue = variable.defaultValue == null ? "" : String(variable.defaultValue);
    return {
        ...variable,
        type: normalizedType,
        key: normalizedKey,
        label,
        placeholder: legacyUnsupportedType ? "" : variable.placeholder?.trim() || "",
        defaultValue: legacyUnsupportedType && /^(true|false)$/i.test(normalizedDefaultValue) ? "" : normalizedDefaultValue,
        options: normalizedType === "select" ? (Array.isArray(variable.options) ? variable.options : parseVariableOptions(String(variable.options || ""))) : [],
    };
}

function normalizeWorkflow(workflow: CreativeWorkflow): CreativeWorkflow {
    const normalized: CreativeWorkflow = {
        ...workflow,
        scope: workflow.scope === "public" ? "public" : "private",
        editable: workflow.editable !== false,
        mode: workflow.mode === "multi_image_series" ? "multi_image_series" : "single_image",
        variables: (workflow.variables || []).map(normalizeVariable),
        config: { ...createWorkflowConfig(defaultConfig), ...(workflow.config || {}) },
        seriesConfig: { ...createWorkflowSeriesConfig(defaultConfig), ...(workflow.seriesConfig || {}) },
        createdAt: workflow.createdAt || Date.now(),
        updatedAt: workflow.updatedAt || Date.now(),
    };
    normalized.seriesConfig = {
        ...normalized.seriesConfig,
        promptModel: resolvePromptPlannerModel(defaultConfig, normalized.seriesConfig.promptModel || defaultConfig.textModel),
    };
    if (isProductPackageWorkflow(normalized) && (!normalized.seriesConfig.targetCount || normalized.seriesConfig.targetCount === "6")) {
        normalized.seriesConfig = { ...normalized.seriesConfig, targetCount: "16" };
    }
    return normalized;
}

function createDefaultInputValues(workflow: CreativeWorkflow) {
    return Object.fromEntries(workflow.variables.map((variable) => [variable.key, variable.defaultValue || ""]));
}

function renderPromptTemplate(template: string, values: Record<string, string>, aliases: Record<string, string> = {}) {
    return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, rawKey: string) => {
        const key = rawKey.trim();
        return values[key] ?? aliases[key] ?? "";
    });
}

function renderWorkflowPrompt(workflow: CreativeWorkflow, values: Record<string, string>) {
    const formattedValues = Object.fromEntries(workflow.variables.map((variable) => [variable.key, formatWorkflowVariableValue(variable, values[variable.key])]));
    const aliasValues = Object.fromEntries(workflow.variables.map((variable) => [variable.label, formattedValues[variable.key] || ""]));
    const prompt = renderPromptTemplate(workflow.config.promptTemplate, formattedValues, aliasValues).trim();
    const negativePrompt = workflow.config.negativePrompt.trim();
    return negativePrompt ? `${prompt}\n\n避免：${negativePrompt}` : prompt;
}

function normalizeVariableKey(value: string) {
    return value
        .trim()
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_");
}

function fallbackVariableKey(id: string) {
    const suffix = id.replace(/[^\w]/g, "").slice(0, 6) || "value";
    return `field_${suffix}`;
}

function formatWorkflowVariableValue(variable: WorkflowVariable, value: string | undefined) {
    return value ?? variable.defaultValue ?? "";
}

function parseVariableOptions(text: string) {
    return text
        .split(/[\/\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function buildSeriesPromptDraftRequest(workflow: CreativeWorkflow, basePrompt: string, count: number, values: Record<string, string>) {
    const variables = Object.entries(values)
        .filter(([, value]) => String(value).trim())
        .map(([key, value]) => `- ${key}: ${value}`)
        .join("\n");
    const productPackageMode = isProductPackageWorkflow(workflow);
    const productPackageRules = [
        "产品图包固定图位：",
        "1. 第 1 张必须是【主图】。1:1，白底/浅底或干净商业摄影背景，产品完整清晰，少量合规短文案。",
        "2. 第 2-5 张必须是【副图】。1:1，分别覆盖核心卖点、成分/规格、使用场景、适用人群或质感包装。",
        "3. 第 6 张以后必须是【详情图】。竖版详情页模块，适合电商详情页向下阅读，单张只讲一个模块。",
        "4. 标题必须按顺序写成：主图、副图1、副图2、副图3、副图4、详情图1、详情图2……",
        "5. 详情图提示词要明确竖版长图/详情页模块，不要写成普通方图。",
    ].join("\n");
    return [
        "你是电商多图创作策划助手。请基于工作流信息，为同一产品生成一组互相连贯但画面重点不同的图片生成提示词。",
        "必须只返回 JSON，不要 Markdown。JSON 结构为：{\"items\":[{\"title\":\"主图\",\"prompt\":\"完整图片提示词\"}]}。",
        `目标张数：${count}`,
        `工作流名称：${workflow.name}`,
        `工作流分类：${workflow.category || "未分类"}`,
        `工作流描述：${workflow.description || "无"}`,
        workflow.seriesConfig.promptInstruction ? `系列拆分规则：${workflow.seriesConfig.promptInstruction}` : "",
        productPackageMode ? productPackageRules : "",
        variables ? `用户输入变量：\n${variables}` : "",
        `基础提示词：\n${basePrompt}`,
        [
            "生成要求：",
            "1. 每条 prompt 必须可以独立用于图片生成。",
            "2. 每条 prompt 控制在 120-220 个中文字符，使用短句，不要写成长篇作文。",
            "3. 每条 prompt 直接写完整图片提示词，不要以“任务：”开头；内容顺序包含参考图要求、画面构图、文案要求、合规限制、禁止项。",
            "4. 如果有参考产品图，必须强调保持包装外观、品牌名、瓶身/盒型结构、配色和标签设计一致。",
            "5. 电商健康/护理/消字号/保健品类，必须避免治疗、根治、消炎、抗菌率、药效承诺、前后对比、医生背书、虚假认证、密集小字。",
            "6. 标题要用真实图位名称，例如主图、核心卖点图、成分规格图、适用场景图、使用步骤图、详情页模块图。",
            productPackageMode ? "7. 如果是详情图，prompt 必须写明竖版长图、详情页模块、纵向排版、留白清晰。" : "",
            "8. 不要输出解释文字，不要在 JSON 外输出任何内容。",
        ].join("\n"),
    ]
        .filter(Boolean)
        .join("\n\n");
}

function isProductPackageWorkflow(workflow: CreativeWorkflow) {
    const text = `${workflow.name} ${workflow.category} ${workflow.description} ${workflow.seriesConfig.promptInstruction}`.toLowerCase();
    return /图包|主图|副图|详情图|保健|健康|消字号|product package/i.test(text);
}

function resolveSeriesImageSize(seriesIndex: number, fallback?: string) {
    return seriesIndex >= 6 ? "9:16" : fallback || "1:1";
}

function parseSeriesPromptDrafts(content: string, count: number, fallbackPrompt: string): SeriesPromptDraft[] {
    const jsonText = extractJSONText(content);
    if (jsonText) {
        try {
            const payload = JSON.parse(jsonText) as { items?: Array<{ title?: string; prompt?: string }> } | Array<{ title?: string; prompt?: string }>;
            const items = Array.isArray(payload) ? payload : payload.items || [];
            const drafts = items
                .map((item, index) => ({ id: nanoid(), title: item.title?.trim() || `第 ${index + 1} 张`, prompt: item.prompt?.trim() || "", status: "draft" as const }))
                .filter((item) => item.prompt);
            if (drafts.length) return drafts.slice(0, count);
        } catch {
            // Fall back to line parsing below.
        }
    }
    const lines = content
        .split(/\n+/)
        .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, count);
    if (lines.length) {
        return lines.map((line, index) => ({ id: nanoid(), title: `第 ${index + 1} 张`, prompt: line, status: "draft" as const }));
    }
    return Array.from({ length: count }, (_, index) => ({ id: nanoid(), title: `第 ${index + 1} 张`, prompt: `${fallbackPrompt}\n\n系列图片：第 ${index + 1} 张，画面重点与其他图片保持差异。`, status: "draft" as const }));
}

function extractJSONText(content: string) {
    const trimmed = content.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) return trimmed.slice(objectStart, objectEnd + 1);
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) return trimmed.slice(arrayStart, arrayEnd + 1);
    return "";
}

function seriesDraftStorageKey(workflowId: string) {
    return `${SERIES_DRAFT_STORE_PREFIX}${workflowId}`;
}

function normalizeSeriesDraft(draft: SeriesPromptDraft): SeriesPromptDraft {
    return {
        id: draft.id || nanoid(),
        title: draft.title || "未命名",
        prompt: draft.prompt || "",
        status: draft.status === "running" ? "draft" : draft.status || "draft",
        error: draft.error,
        resultIds: Array.isArray(draft.resultIds) ? draft.resultIds : [],
    };
}

function inferVariableOptions(variable: WorkflowVariable) {
    return parseVariableOptions([variable.defaultValue, variable.placeholder, variable.options.join("/")].filter(Boolean).join("/"));
}

function workflowToRecord(workflow: CreativeWorkflow): CreativeWorkflowRecord<CreativeWorkflow> {
    return {
        id: workflow.id,
        ownerUserId: workflow.ownerUserId,
        scope: workflow.scope === "public" ? "public" : "private",
        name: workflow.name,
        category: workflow.category,
        description: workflow.description,
        data: workflow,
        createdAt: new Date(workflow.createdAt).toISOString(),
        updatedAt: new Date(workflow.updatedAt).toISOString(),
        lastRunAt: workflow.lastRunAt ? new Date(workflow.lastRunAt).toISOString() : undefined,
        editable: workflow.editable !== false,
    };
}

function recordToWorkflow(record: CreativeWorkflowRecord<CreativeWorkflow>): CreativeWorkflow {
    const data = record.data || ({} as CreativeWorkflow);
    return normalizeWorkflow({
        ...data,
        id: record.id || data.id,
        ownerUserId: record.ownerUserId,
        scope: record.scope === "public" ? "public" : "private",
        editable: record.editable,
        name: record.name || data.name || "",
        category: record.category || data.category || "",
        description: record.description || data.description || "",
        createdAt: record.createdAt ? Date.parse(record.createdAt) : data.createdAt,
        updatedAt: record.updatedAt ? Date.parse(record.updatedAt) : data.updatedAt,
        lastRunAt: record.lastRunAt ? Date.parse(record.lastRunAt) : data.lastRunAt,
    });
}

function resolveWorkflowRuntime(workflow: CreativeWorkflow, baseConfig: AiConfig) {
    const workflowModel = workflow.config.imageModel || workflow.config.model;
    const fallbackModel = baseConfig.imageModel || baseConfig.model;
    if (!workflowModel) return { model: fallbackModel, apiMode: baseConfig.apiMode, channelId: baseConfig.imageChannelId };
    if (baseConfig.channelMode === "remote" && workflowModel !== fallbackModel && (!baseConfig.models.length || !baseConfig.models.includes(workflowModel))) {
        return { model: fallbackModel, apiMode: baseConfig.apiMode, channelId: baseConfig.imageChannelId };
    }
    return { model: workflowModel, apiMode: workflow.config.apiMode || baseConfig.apiMode, channelId: workflow.config.imageChannelId || baseConfig.imageChannelId };
}

function buildRunConfig(baseConfig: AiConfig, workflowConfig: WorkflowGenerationConfig, runtime: { model: string; apiMode: AiConfig["apiMode"]; channelId: string }): AiConfig {
    return {
        ...baseConfig,
        ...workflowConfig,
        model: runtime.model,
        imageModel: runtime.model,
        imageChannelId: runtime.channelId,
        activeChannelId: runtime.channelId,
        apiMode: runtime.apiMode,
        systemPrompt: workflowConfig.systemPrompt || baseConfig.systemPrompts.workflow || baseConfig.systemPrompt,
        count: workflowConfig.count || "1",
    };
}

function buildImageHistoryLog({
    workflow,
    prompt,
    config,
    model,
    images,
    durationMs,
    inputs,
    references,
    categoryIds,
    seriesRunId,
    seriesTitle,
    seriesIndex,
}: {
    workflow: CreativeWorkflow;
    prompt: string;
    config: WorkflowGenerationConfig;
    model: string;
    images: ImageHistoryLog["images"];
    durationMs: number;
    inputs: Record<string, unknown>;
    references: ReferenceImage[];
    categoryIds: string[];
    seriesRunId?: string;
    seriesTitle?: string;
    seriesIndex?: number;
}): ImageHistoryLog {
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: seriesTitle ? `${workflow.name} · ${seriesTitle}` : workflow.name,
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config,
        references,
        durationMs,
        successCount: images.length,
        failCount: 0,
        imageCount: images.length,
        size: config.size,
        quality: config.quality,
        status: "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl),
        errors: [],
        categoryIds,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowInputs: { ...inputs, ...(seriesTitle ? { seriesTitle, seriesIndex } : {}) },
        workflowSeriesRunId: seriesRunId,
    };
}

async function ensureWorkflowCategory(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const categories = (await categoryStore.getItem<GenerationCategory[]>(CATEGORY_STORE_KEY)) || [];
    const existing = categories.find((item) => item.name === trimmed);
    if (existing) return existing;
    const nextCategory = { id: nanoid(), name: trimmed, createdAt: Date.now() };
    await categoryStore.setItem(CATEGORY_STORE_KEY, [...categories, nextCategory]);
    return nextCategory;
}

function serializeHistoryLog(log: ImageHistoryLog): ImageHistoryLog {
    return {
        ...log,
        images: log.images.map((image) => ({ ...image, dataUrl: image.dataUrl?.startsWith("http") ? image.dataUrl : "" })),
        thumbnails: log.images.map((image) => (image.dataUrl?.startsWith("http") ? image.dataUrl : "")),
    };
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    return reference.temporary === true || reference.source === "upload" || reference.source === "clipboard";
}

function referenceUsedByWorkflowTask(reference: ReferenceImage, tasks: WorkflowTask[]) {
    if (!reference.storageKey) return false;
    return tasks.some((task) => task.references.some((item) => item.storageKey === reference.storageKey));
}

function formatDate(value: number) {
    return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
