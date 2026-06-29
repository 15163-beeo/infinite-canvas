"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Plus, X } from "lucide-react";
import { Button } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { CreditSymbol, requestCreditCost } from "@/constant/credits";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import type { NodeGenerationInput } from "./canvas-node-generation";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type ReferenceMentionItem = {
    nodeId: string;
    key: string;
    label: string;
    title: string;
    thumbnail: string;
};

type MentionState = {
    start: number;
    end: number;
    query: string;
};

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    inputs?: NodeGenerationInput[];
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onPasteImage?: (nodeId: string, file: File) => boolean;
    onPreviewReference?: (referenceNodeId: string) => void;
    onRemoveReference?: (nodeId: string, referenceNodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ node, inputs = [], isRunning, onPromptChange, onConfigChange, onGenerate, onPasteImage, onPreviewReference, onRemoveReference, onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const modelCosts = useConfigStore((state) => state.publicSettings?.modelChannel.modelCosts);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isLocalEditDraft = node.type === CanvasNodeType.Image && !hasImageContent && Boolean(node.metadata?.editMaskRect);
    const isEditingExistingText = hasTextContent;
    const [prompt, setPrompt] = useState(isEditingExistingText ? "" : node.metadata?.prompt || "");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [mentionState, setMentionState] = useState<MentionState | null>(null);
    const [activeMentionIndex, setActiveMentionIndex] = useState(0);
    const credits = requestCreditCost({ channelMode: config.channelMode, modelCosts, model: config.model, count: mode === "image" ? config.count : 1 });
    const referenceInputs = inputs.filter((input): input is NodeGenerationInput & { image: NonNullable<NodeGenerationInput["image"]> } => input.type === "image" && Boolean(input.image));
    const referenceItems = useMemo<ReferenceMentionItem[]>(
        () =>
            referenceInputs.map((input, index) => ({
                nodeId: input.nodeId,
                key: `${input.nodeId}-${index}`,
                label: `图片${index + 1}`,
                title: input.title || `参考图 ${index + 1}`,
                thumbnail: input.image.dataUrl,
            })),
        [referenceInputs],
    );
    const filteredMentionItems = mentionState
        ? referenceItems.filter((item) => {
              const query = mentionState.query.trim().toLowerCase();
              return !query || item.label.toLowerCase().includes(query) || item.title.toLowerCase().includes(query);
          })
        : [];
    const showReferenceStrip = mode === "image" && Boolean(onPasteImage);
    const showMentionPanel = mode === "image" && Boolean(mentionState) && referenceItems.length > 0;

    useEffect(() => {
        setPrompt(isEditingExistingText ? "" : node.metadata?.prompt || "");
    }, [isEditingExistingText, node.id, node.metadata?.prompt]);

    useEffect(() => {
        if (!filteredMentionItems.length) {
            setActiveMentionIndex(0);
            return;
        }
        setActiveMentionIndex((current) => Math.min(current, filteredMentionItems.length - 1));
    }, [filteredMentionItems.length]);

    useEffect(() => {
        return () => {
            if (document.activeElement === textareaRef.current) textareaRef.current?.blur();
        };
    }, []);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingText) onPromptChange(node.id, value);
    };

    const syncMentionState = (value: string, caret: number) => {
        if (mode !== "image" || !referenceItems.length) {
            setMentionState(null);
            return;
        }
        const nextMention = detectReferenceMention(value, caret);
        setMentionState(nextMention);
        if (!nextMention) setActiveMentionIndex(0);
    };

    const insertMention = (item: ReferenceMentionItem) => {
        if (!mentionState) return;
        const nextPrompt = `${prompt.slice(0, mentionState.start)}@${item.label} ${prompt.slice(mentionState.end)}`;
        updatePrompt(nextPrompt);
        setMentionState(null);
        setActiveMentionIndex(0);
        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            const caret = mentionState.start + item.label.length + 2;
            textarea.focus();
            textarea.setSelectionRange(caret, caret);
        });
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        onGenerate(node.id, mode, text);
    };

    return (
        <div
            className="rounded-[24px] border p-3.5 shadow-2xl backdrop-blur-md"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {showReferenceStrip ? (
                <div className="thin-scrollbar mb-3 flex min-w-0 items-start gap-2 overflow-x-auto pb-1">
                    {referenceItems.map((item) => (
                        <button
                            key={item.key}
                            title={item.title}
                            type="button"
                            className="group relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-xl border"
                            style={{ background: theme.node.fill, borderColor: theme.node.stroke }}
                            onClick={() => onPreviewReference?.(item.nodeId)}
                        >
                            <div className="size-full bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url(${item.thumbnail})` }} aria-label={item.title} />
                            <div className="absolute inset-x-0 bottom-0 bg-black/58 px-1.5 py-1 text-left text-[10px] font-semibold leading-none text-white backdrop-blur-sm">{`@${item.label}`}</div>
                            {onRemoveReference ? (
                                <span
                                    role="button"
                                    aria-label="移除参考图"
                                    className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full border opacity-100 shadow-sm transition hover:scale-105"
                                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onRemoveReference(node.id, item.nodeId);
                                    }}
                                >
                                    <X className="size-3" />
                                </span>
                            ) : null}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="group flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-xl border border-dashed transition hover:scale-[1.02]"
                        style={{ background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.muted }}
                        onClick={() => fileInputRef.current?.click()}
                        title="上传参考图"
                    >
                        <Plus className="size-5" strokeWidth={2.4} />
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.currentTarget.value = "";
                            if (!file) return;
                            onPasteImage?.(node.id, file);
                        }}
                    />
                </div>
            ) : null}
            <div className="relative">
                <textarea
                    ref={textareaRef}
                    value={prompt}
                    onChange={(event) => {
                        const value = event.target.value;
                        updatePrompt(value);
                        syncMentionState(value, event.target.selectionStart ?? value.length);
                    }}
                    onPaste={(event) => {
                        const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
                        if (!file || !onPasteImage?.(node.id, file)) return;
                        event.preventDefault();
                    }}
                    onClick={(event) => syncMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                    onKeyUp={(event) => syncMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                    onKeyDown={(event) => {
                        if (showMentionPanel && filteredMentionItems.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveMentionIndex((current) => (current + 1) % filteredMentionItems.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveMentionIndex((current) => (current - 1 + filteredMentionItems.length) % filteredMentionItems.length);
                                return;
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                insertMention(filteredMentionItems[activeMentionIndex] || filteredMentionItems[0]);
                                return;
                            }
                        }
                        if (event.key === "Escape" && mentionState) {
                            setMentionState(null);
                            return;
                        }
                        if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey) return;
                        event.preventDefault();
                        submit();
                    }}
                    className="thin-scrollbar h-32 w-full resize-none rounded-2xl border px-4 py-3 text-sm leading-6 outline-none"
                    style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                    placeholder={
                        mode === "video"
                            ? "描述要生成的视频内容"
                            : mode === "image"
                              ? hasImageContent
                                  ? "请输入你想要把这张图修改成什么"
                                  : isLocalEditDraft
                                    ? "例如：区域1 修改成品质级"
                                    : "描述要生成的图片内容"
                              : hasTextContent
                                ? "请输入你想要将本段文本修改成什么"
                                : "请输入你想要生成的文本内容"
                    }
                />
                {showMentionPanel ? (
                    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-2xl border shadow-2xl" style={{ background: theme.node.panel, borderColor: theme.node.stroke }}>
                        {filteredMentionItems.length ? (
                            <div className="thin-scrollbar max-h-56 overflow-y-auto">
                                {filteredMentionItems.map((item, index) => (
                                    <button
                                        key={`mention-${item.key}`}
                                        type="button"
                                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition"
                                        style={{ background: index === activeMentionIndex ? theme.node.fill : "transparent", color: theme.node.text }}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            insertMention(item);
                                        }}
                                    >
                                        <img src={item.thumbnail} alt={item.title} className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.label}</span>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="px-3 py-3 text-sm" style={{ color: theme.node.muted }}>
                                没有匹配的参考图
                            </div>
                        )}
                    </div>
                ) : null}
            </div>
            <div className="mt-2.5 flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} channelId={config.imageChannelId} onChange={(model, channelId) => onConfigChange(node.id, { model, ...(channelId ? { imageChannelId: channelId } : {}) })} onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} channelId={config.videoChannelId} onChange={(model, channelId) => onConfigChange(node.id, { model, ...(channelId ? { videoChannelId: channelId } : {}) })} onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasVideoSettingsPopover
                                config={config}
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "videoSeconds" ? { seconds: value } : { [key]: value })}
                            />
                        </>
                    ) : (
                        <ModelPicker config={config} value={config.model} channelId={config.textChannelId} onChange={(model, channelId) => onConfigChange(node.id, { model, ...(channelId ? { textChannelId: channelId } : {}) })} onMissingConfig={() => openConfigDialog(true)} />
                    )}
                </div>
                <Button type="primary" className="!h-11 !min-w-[56px] shrink-0 !rounded-full !px-4" disabled={isRunning || !prompt.trim()} onClick={submit} aria-label="生成">
                    <span className="flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
                            <CreditSymbol />
                            {credits.toLocaleString()}
                        </span>
                        {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                    </span>
                </Button>
            </div>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : globalConfig.textModel;
    return {
        ...globalConfig,
        model: node.metadata?.model || defaultModel || globalConfig.model || defaultConfig.model,
        imageChannelId: node.metadata?.imageChannelId || globalConfig.imageChannelId,
        videoChannelId: node.metadata?.videoChannelId || globalConfig.videoChannelId,
        textChannelId: node.metadata?.textChannelId || globalConfig.textChannelId,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        outputFormat: node.metadata?.outputFormat || globalConfig.outputFormat || defaultConfig.outputFormat,
        outputCompression: node.metadata?.outputCompression || globalConfig.outputCompression || defaultConfig.outputCompression,
        moderation: node.metadata?.moderation || globalConfig.moderation || defaultConfig.moderation,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        count: String(node.metadata?.count || (mode === "image" ? 1 : globalConfig.count) || defaultConfig.count),
    };
}

function detectReferenceMention(value: string, caret: number): MentionState | null {
    const prefix = value.slice(0, caret);
    const matched = prefix.match(/(^|\s)@([^\s@]*)$/);
    if (!matched) return null;
    return {
        start: caret - matched[2].length - 1,
        end: caret,
        query: matched[2],
    };
}
