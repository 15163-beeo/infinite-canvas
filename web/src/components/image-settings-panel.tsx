"use client";

import { useState, type ReactNode } from "react";
import { ConfigProvider } from "antd";

import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", label: "自动" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
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
    { value: "4:3", label: "4:3", width: 1344, height: 1024, icon: "landscape" },
    { value: "3:4", label: "3:4", width: 1024, height: 1344, icon: "portrait" },
    { value: "9:16", label: "9:16", width: 1024, height: 1792, icon: "portrait" },
    { value: "1:1-2k", label: "1:1(2k)", size: "2048x2048", width: 2048, height: 2048, icon: "square" },
    { value: "16:9-2k", label: "16:9(2k)", size: "2048x1152", width: 2048, height: 1152, icon: "landscape" },
    { value: "9:16-2k", label: "9:16(2k)", size: "1152x2048", width: 1152, height: 2048, icon: "portrait" },
    { value: "16:9-4k", label: "16:9(4k)", size: "3840x2160", width: 3840, height: 2160, icon: "landscape" },
    { value: "9:16-4k", label: "9:16(4k)", size: "2160x3840", width: 2160, height: 3840, icon: "portrait" },
    { value: "auto", label: "auto", width: 0, height: 0, icon: "auto" },
];

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "quality" | "size" | "count" | "outputFormat" | "outputCompression" | "moderation", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
    collapsible?: boolean;
};

type ImageSettingSectionKey = "quality" | "size" | "aspect" | "count" | "format" | "compression" | "moderation";

const defaultCollapsedSettings: Record<ImageSettingSectionKey, boolean> = {
    quality: false,
    size: true,
    aspect: true,
    count: true,
    format: true,
    compression: true,
    moderation: true,
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10, collapsible = false }: ImageSettingsPanelProps) {
    const [collapsedSettings, setCollapsedSettings] = useState(defaultCollapsedSettings);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const outputFormat = config.outputFormat || "png";
    const outputCompression = Math.max(0, Math.min(100, Math.floor(Number(config.outputCompression) || 100)));
    const moderation = config.moderation || "auto";
    const selectedAspect = aspectOptions.find((item) => (item.size || item.value) === activeSize || item.value === activeSize);
    const dimensions = readSizeDimensions(activeSize, selectedAspect || aspectOptions[0]);
    const selectAspect = (value: string) => {
        const option = aspectOptions.find((item) => item.value === value);
        onConfigChange("size", option?.size || option?.value || "auto");
    };
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
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
                    "quality",
                    "质量",
                    imageQualityLabel(quality),
                    <div className="grid grid-cols-4 gap-2.5">
                        {qualityOptions.map((item) => (
                            <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
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
                                style={{ borderColor: selectedAspect?.value === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
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

export function imageQualityLabel(value: string) {
    return ({ auto: "自动", high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value;
}

export function imageSizeLabel(size: string) {
    return aspectOptions.find((item) => (item.size || item.value) === size || item.value === size)?.label || size;
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
    const match = size?.match(/^(\d+)x(\d+)$/);
    return {
        width: match ? Number(match[1]) : fallback.width,
        height: match ? Number(match[2]) : fallback.height,
    };
}
