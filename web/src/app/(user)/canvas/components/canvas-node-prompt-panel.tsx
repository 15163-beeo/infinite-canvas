"use client";

import { useEffect, useState } from "react";
import { ArrowUp, LoaderCircle, X } from "lucide-react";
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
    const isEditingExistingText = hasTextContent;
    const [prompt, setPrompt] = useState(isEditingExistingText ? "" : node.metadata?.prompt || "");
    const credits = requestCreditCost({ channelMode: config.channelMode, modelCosts, model: config.model, count: mode === "image" ? config.count : 1 });
    const referenceInputs = inputs.filter((input): input is NodeGenerationInput & { image: NonNullable<NodeGenerationInput["image"]> } => input.type === "image" && Boolean(input.image));

    useEffect(() => {
        setPrompt(isEditingExistingText ? "" : node.metadata?.prompt || "");
    }, [isEditingExistingText, node.id, node.metadata?.prompt]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingText) onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        onGenerate(node.id, mode, text);
    };

    return (
        <div
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {referenceInputs.length ? (
                <div className="thin-scrollbar mb-2 flex min-w-0 items-center gap-2 overflow-x-auto">
                    {referenceInputs.map((input, index) => (
                        <button
                            key={`${input.nodeId}-${index}`}
                            title={input.title}
                            type="button"
                            className="group relative size-12 shrink-0 overflow-hidden rounded-lg border"
                            style={{ background: theme.node.fill, borderColor: theme.node.stroke }}
                            onClick={() => onPreviewReference?.(input.nodeId)}
                        >
                            <div className="size-full bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url(${input.image.dataUrl})` }} aria-label={input.title} />
                            <span className="absolute right-0.5 top-0.5 rounded-sm bg-black/60 px-1 text-[8px] font-medium leading-tight text-white">{index + 1}</span>
                            {onRemoveReference ? (
                                <span
                                    role="button"
                                    aria-label="移除参考图"
                                    className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border opacity-100 shadow-sm transition hover:scale-105"
                                    style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onRemoveReference(node.id, input.nodeId);
                                    }}
                                >
                                    <X className="size-3" />
                                </span>
                            ) : null}
                        </button>
                    ))}
                </div>
            ) : null}
            <div className="relative">
                <textarea
                    value={prompt}
                    onChange={(event) => updatePrompt(event.target.value)}
                    onPaste={(event) => {
                        const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
                        if (!file || !onPasteImage?.(node.id, file)) return;
                        event.preventDefault();
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey) return;
                        event.preventDefault();
                        submit();
                    }}
                    className="thin-scrollbar h-24 w-full resize-none rounded-xl border px-3 py-2 text-sm leading-5 outline-none"
                    style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                    placeholder={mode === "video" ? "描述要生成的视频内容" : mode === "image" ? (hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容") : hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容"}
                />
            </div>

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
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
                <Button type="primary" className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3" disabled={isRunning || !prompt.trim()} onClick={submit} aria-label="生成">
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
