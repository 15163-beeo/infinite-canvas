"use client";

import { useState, type ReactNode } from "react";
import { ConfigProvider } from "antd";

import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
];

const formatOptions = [
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
];

const moderationOptions = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
];

const aspectOptions = [
    { value: "1:1", label: "1:1", width: 1024, height: 1024, icon: "square" },
    { value: "3:2", label: "3:2", width: 1536, height: 1024, icon: "landscape" },
    { value: "2:3", label: "2:3", width: 1024, height: 1536, icon: "portrait" },
    { value: "16:9", label: "16:9", width: 1280, height: 720, icon: "landscape" },
    { value: "9:16", label: "9:16", width: 720, height: 1280, icon: "portrait" },
    { value: "4:3", label: "4:3", width: 1024, height: 768, icon: "landscape" },
    { value: "3:4", label: "3:4", width: 768, height: 1024, icon: "portrait" },
    { value: "21:9", label: "21:9", width: 1280, height: 544, icon: "landscape" },
    { value: "auto", label: "auto", width: 0, height: 0, icon: "auto" },
];

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "size" | "count" | "outputFormat" | "outputCompression" | "moderation", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
    collapsible?: boolean;
};

type ImageSettingSectionKey = "resolution" | "size" | "aspect" | "count" | "format" | "compression" | "moderation";

const defaultCollapsedSettings: Record<ImageSettingSectionKey, boolean> = {
    resolution: false,
    size: true,
    aspect: true,
    count: true,
    format: true,
    compression: true,
    moderation: true,
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10, collapsible = false }: ImageSettingsPanelProps) {
    const [collapsedSettings, setCollapsedSettings] = useState(defaultCollapsedSettings);
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const activeResolution = imageResolutionValue(activeSize);
    const outputFormat = config.outputFormat || "png";
    const outputCompression = Math.max(0, Math.min(100, Math.floor(Number(config.outputCompression) || 100)));
    const moderation = config.moderation || "auto";
    const selectedAspectKey = activeSize === "auto" ? "auto" : readAspectKey(activeSize);
    const selectedAspect = aspectOptions.find((item) => item.value === selectedAspectKey);
    const dimensions = readSizeDimensions(activeSize, selectedAspect || aspectOptions[0]);
    const selectAspect = (value: string) => {
        const option = aspectOptions.find((item) => item.value === value);
        if (!option || option.value === "auto") {
            onConfigChange("size", "auto");
            return;
        }
        onConfigChange("size", resolveImageSizeForResolution(option.value, activeResolution));
    };
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        onConfigChange("size", normalizeImageSize(`${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`));
    };
    const renderSection = (key: ImageSettingSectionKey, title: string, summary: string, children: ReactNode) => {
        if (!collapsible) {
            return (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{title}</SettingTitle>
                    {children}
                </div>
            );
        }
        const collapsed = collapsedSettings[key];
        return (
            <CollapsibleSettingGroup
                key={key}
                title={title}
                summary={summary}
                collapsed={collapsed}
                theme={theme}
                onToggle={() =>
                    setCollapsedSettings((value) => ({
                        ...value,
                        [key]: !value[key],
                    }))
                }
            >
                {children}
            </CollapsibleSettingGroup>
        );
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">图像设置</div> : null}
                {renderSection(
                    "resolution",
                    "分辨率",
                    imageResolutionLabel(activeSize),
                    <div className="grid grid-cols-3 gap-2.5">
                        {resolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={activeResolution === item.value} theme={theme} onClick={() => onConfigChange("size", resolveImageSizeForResolution(activeSize, item.value))}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>,
                )}
                {renderSection(
                    "size",
                    "尺寸",
                    activeSize === "auto" ? "auto" : `${dimensions.width || 0}x${dimensions.height || 0}`,
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={activeSize === "auto"} theme={theme} onChange={(value) => updateDimension("width", value)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={activeSize === "auto"} theme={theme} onChange={(value) => updateDimension("height", value)} />
                    </div>,
                )}
                {renderSection(
                    "aspect",
                    "宽高比",
                    selectedAspect?.label || activeSize,
                    <div className="grid grid-cols-4 gap-2.5">
                        {aspectOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedAspectKey === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectAspect(item.value)}
                            >
                                <AspectIcon type={item.icon} width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.label}</span>
                            </button>
                        ))}
                    </div>,
                )}
                {renderSection(
                    "count",
                    "生成张数",
                    `${count} 张`,
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {value} 张
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>,
                )}
                {renderSection(
                    "format",
                    "格式",
                    imageFormatLabel(outputFormat),
                    <div className="grid grid-cols-3 gap-2.5">
                        {formatOptions.map((item) => (
                            <OptionPill key={item.value} selected={outputFormat === item.value} theme={theme} onClick={() => onConfigChange("outputFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>,
                )}
                {renderSection(
                    "compression",
                    "压缩",
                    outputFormat === "png" ? "PNG 不压缩" : `${outputCompression}`,
                    <RangeInput value={outputCompression} disabled={outputFormat === "png"} theme={theme} onChange={(value) => onConfigChange("outputCompression", String(value))} />,
                )}
                {renderSection(
                    "moderation",
                    "审核",
                    moderation === "low" ? "低" : "自动",
                    <div className="grid grid-cols-2 gap-2.5">
                        {moderationOptions.map((item) => (
                            <OptionPill key={item.value} selected={moderation === item.value} theme={theme} onClick={() => onConfigChange("moderation", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>,
                )}
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: { Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text } },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

type ImageResolutionValue = "1k" | "2k" | "4k";
type PresetRatio = "1:1" | "3:2" | "2:3" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9";

const commonResolutionSizes: Record<PresetRatio, Record<ImageResolutionValue, string>> = {
    "1:1": { "1k": "1024x1024", "2k": "2048x2048", "4k": "2880x2880" },
    "3:2": { "1k": "1536x1024", "2k": "2160x1440", "4k": "3456x2304" },
    "2:3": { "1k": "1024x1536", "2k": "1440x2160", "4k": "2304x3456" },
    "16:9": { "1k": "1280x720", "2k": "2560x1440", "4k": "3840x2160" },
    "9:16": { "1k": "720x1280", "2k": "1440x2560", "4k": "2160x3840" },
    "4:3": { "1k": "1024x768", "2k": "2048x1536", "4k": "3200x2400" },
    "3:4": { "1k": "768x1024", "2k": "1536x2048", "4k": "2400x3200" },
    "21:9": { "1k": "1280x544", "2k": "2560x1088", "4k": "3840x1600" },
};

const SIZE_MULTIPLE = 16;
const MAX_EDGE = 3840;
const MAX_ASPECT_RATIO = 3;
const MIN_IMAGE_PIXELS = 655_360;
const MAX_IMAGE_PIXELS = 8_294_400;
const MAX_RATIO_ERROR = 0.01;

const tierPixelBudget: Record<ImageResolutionValue, number> = {
    "1k": 1_572_864,
    "2k": 4_194_304,
    "4k": MAX_IMAGE_PIXELS,
};

export function imageResolutionValue(size: string): ImageResolutionValue {
    const dimensions = parseDimensions(size);
    if (!dimensions) return "1k";
    const longSide = Math.max(dimensions.width, dimensions.height);
    const pixels = dimensions.width * dimensions.height;
    if (pixels >= 6_000_000) return "4k";
    if (longSide >= 3000) return "4k";
    if (longSide >= 1800) return "2k";
    return "1k";
}

export function imageResolutionLabel(size: string) {
    return imageResolutionValue(size).toUpperCase();
}

export function imageAspectValue(size: string) {
    if ((size || "").trim() === "auto") return "auto";
    return readAspectKey(size) || "1:1";
}

export function resolveImageSizeForResolution(size: string, resolution: string) {
    const normalized = normalizeResolution(resolution);
    const aspectKey = readAspectKey(size);
    const commonSize = aspectKey ? commonResolutionSizes[aspectKey]?.[normalized] : undefined;
    if (commonSize) return commonSize;

    const dimensions = parseDimensions(size) || { width: 1, height: 1 };
    return calculateImageSize(normalized, `${dimensions.width}:${dimensions.height}`) || normalizeImageSize(`${dimensions.width}x${dimensions.height}`);
}

export function imageSizeLabel(size: string) {
    return aspectOptions.find((item) => item.value === size)?.label || size;
}

export function imageFormatLabel(value: string) {
    return ({ png: "PNG", jpeg: "JPEG", webp: "WebP" } as Record<string, string>)[value] || value;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function CollapsibleSettingGroup({ title, summary, collapsed, theme, children, onToggle }: { title: string; summary: string; collapsed: boolean; theme: CanvasTheme; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="overflow-hidden rounded-lg border" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}>
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onToggle}>
                <span className="min-w-0">
                    <span className="font-medium">{title}</span>
                    {collapsed ? (
                        <span className="ml-2 truncate text-xs" style={{ color: theme.node.muted }}>
                            {summary}
                        </span>
                    ) : null}
                </span>
                <span className="shrink-0 text-xs" style={{ color: theme.node.muted }}>
                    {collapsed ? "展开" : "收起"}
                </span>
            </button>
            {!collapsed ? (
                <div className="border-t p-3" style={{ borderColor: theme.node.stroke }}>
                    {children}
                </div>
            ) : null}
        </section>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function RangeInput({ value, disabled, theme, onChange }: { value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number) => void }) {
    return (
        <div className="grid grid-cols-[1fr_64px] items-center gap-2.5" style={{ opacity: disabled ? 0.55 : 1 }}>
            <input
                type="range"
                min={0}
                max={100}
                disabled={disabled}
                className="min-w-0 accent-current"
                style={{ color: theme.node.activeStroke }}
                value={value}
                onChange={(event) => onChange(Number(event.target.value) || 0)}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={disabled}
                    className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                    value={value}
                    onChange={(event) => onChange(Math.max(0, Math.min(100, Number(event.target.value) || 0)))}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </label>
        </div>
    );
}

function AspectIcon({ type, width, height, color }: { type: string; width: number; height: number; color: string }) {
    if (type === "auto") return null;
    const ratio = width / Math.max(1, height);
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function readSizeDimensions(size: string, fallback: { width: number; height: number }) {
    const match = parseDimensions(size);
    return {
        width: match ? match.width : fallback.width,
        height: match ? match.height : fallback.height,
    };
}

function normalizeResolution(value: string): ImageResolutionValue {
    return value === "2k" || value === "4k" ? value : "1k";
}

function parseDimensions(size: string) {
    const match = size?.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function parseRatio(value: string) {
    const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

function readAspectKey(size: string): PresetRatio | null {
    const option = aspectOptions.find((item) => item.value === size);
    if (option?.value && option.value !== "auto") return option.value as PresetRatio;

    const dimensions = parseDimensions(size);
    if (!dimensions) return null;
    const ratio = dimensions.width / Math.max(1, dimensions.height);
    return (
        (Object.keys(commonResolutionSizes) as PresetRatio[]).find((key) => {
            const [width, height] = key.split(":").map(Number);
            return Math.abs(ratio - width / height) < 0.02;
        }) || null
    );
}

function getPresetRatioKey(ratioWidth: number, ratioHeight: number): PresetRatio | null {
    if (!Number.isInteger(ratioWidth) || !Number.isInteger(ratioHeight)) return null;
    const divisor = gcd(ratioWidth, ratioHeight);
    const key = `${ratioWidth / divisor}:${ratioHeight / divisor}`;
    return key in commonResolutionSizes ? (key as PresetRatio) : null;
}

function calculateImageSize(resolution: ImageResolutionValue, ratioValue: string) {
    const parsed = parseRatio(ratioValue);
    if (!parsed) return null;

    const presetRatioKey = getPresetRatioKey(parsed.width, parsed.height);
    if (presetRatioKey) return commonResolutionSizes[presetRatioKey][resolution];

    const targetRatio = parsed.width / parsed.height;
    const pixelBudget = tierPixelBudget[resolution];
    let bestWidth = 0;
    let bestHeight = 0;
    let bestPixels = 0;

    for (let width = SIZE_MULTIPLE; width <= MAX_EDGE; width += SIZE_MULTIPLE) {
        const idealHeight = width / targetRatio;
        const candidates = [Math.floor(idealHeight / SIZE_MULTIPLE) * SIZE_MULTIPLE, Math.ceil(idealHeight / SIZE_MULTIPLE) * SIZE_MULTIPLE];
        for (const height of candidates) {
            if (height < SIZE_MULTIPLE || height > MAX_EDGE) continue;
            const pixels = width * height;
            if (pixels > pixelBudget || pixels < MIN_IMAGE_PIXELS) continue;
            if (Math.max(width / height, height / width) > MAX_ASPECT_RATIO) continue;
            const ratioError = Math.abs(width / height - targetRatio) / targetRatio;
            if (ratioError > MAX_RATIO_ERROR) continue;
            if (pixels > bestPixels) {
                bestPixels = pixels;
                bestWidth = width;
                bestHeight = height;
            }
        }
    }

    return bestPixels ? `${bestWidth}x${bestHeight}` : null;
}

function floorToMultiple(value: number, multiple: number) {
    return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function roundToMultiple(value: number, multiple: number) {
    return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function ceilToMultiple(value: number, multiple: number) {
    return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}

function normalizeDimensions(width: number, height: number) {
    let normalizedWidth = roundToMultiple(width, SIZE_MULTIPLE);
    let normalizedHeight = roundToMultiple(height, SIZE_MULTIPLE);

    const scaleToFit = (scale: number) => {
        normalizedWidth = floorToMultiple(normalizedWidth * scale, SIZE_MULTIPLE);
        normalizedHeight = floorToMultiple(normalizedHeight * scale, SIZE_MULTIPLE);
    };
    const scaleToFill = (scale: number) => {
        normalizedWidth = ceilToMultiple(normalizedWidth * scale, SIZE_MULTIPLE);
        normalizedHeight = ceilToMultiple(normalizedHeight * scale, SIZE_MULTIPLE);
    };

    for (let index = 0; index < 4; index += 1) {
        const maxEdge = Math.max(normalizedWidth, normalizedHeight);
        if (maxEdge > MAX_EDGE) scaleToFit(MAX_EDGE / maxEdge);
        if (normalizedWidth / normalizedHeight > MAX_ASPECT_RATIO) normalizedWidth = floorToMultiple(normalizedHeight * MAX_ASPECT_RATIO, SIZE_MULTIPLE);
        else if (normalizedHeight / normalizedWidth > MAX_ASPECT_RATIO) normalizedHeight = floorToMultiple(normalizedWidth * MAX_ASPECT_RATIO, SIZE_MULTIPLE);
        const pixels = normalizedWidth * normalizedHeight;
        if (pixels > MAX_IMAGE_PIXELS) scaleToFit(Math.sqrt(MAX_IMAGE_PIXELS / pixels));
        else if (pixels < MIN_IMAGE_PIXELS) scaleToFill(Math.sqrt(MIN_IMAGE_PIXELS / pixels));
    }

    return { width: normalizedWidth, height: normalizedHeight };
}

function normalizeImageSize(size: string) {
    const dimensions = parseDimensions(size);
    if (!dimensions) return size.trim();
    const normalized = normalizeDimensions(dimensions.width, dimensions.height);
    return `${normalized.width}x${normalized.height}`;
}

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}
