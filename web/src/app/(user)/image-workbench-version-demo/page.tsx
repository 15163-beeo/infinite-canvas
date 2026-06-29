"use client";

import { useMemo, useState } from "react";
import { App, Button, Input, Tag } from "antd";
import { Copy, Download, ImagePlus, LoaderCircle, Plus, RotateCcw, Settings2, Sparkles, Upload } from "lucide-react";

import { cn } from "@/lib/utils";

type DemoVersion = {
    id: string;
    versionNo: number;
    prompt: string;
    status: "success" | "running" | "failed";
    createdAt: string;
    duration: string;
    size: string;
    badge: string;
    imageTheme: string;
    note: string;
    retryOf?: number;
};

const initialVersions: DemoVersion[] = [
    {
        id: "v1",
        versionNo: 1,
        prompt: "生成一张口腔护理产品电商主图，白色背景，产品居中，突出专业护理。",
        status: "success",
        createdAt: "14:18:06",
        duration: "58s",
        size: "2048 x 2048",
        badge: "初版",
        imageTheme: "from-sky-100 via-white to-cyan-200",
        note: "第一版保留在历史里，不会被重试覆盖。",
    },
    {
        id: "v2",
        versionNo: 2,
        prompt: "保留产品主体，强化主标题层级，背景加入轻微玻璃质感。",
        status: "success",
        createdAt: "14:20:11",
        duration: "1m 12s",
        size: "2048 x 2048",
        badge: "重试",
        imageTheme: "from-emerald-100 via-white to-teal-200",
        note: "版本2由版本1重试生成，版本1仍可切回查看。",
        retryOf: 1,
    },
    {
        id: "v3",
        versionNo: 3,
        prompt: "继续保留包装，增强卖点文字、真实光影和电商平台主图质感。",
        status: "success",
        createdAt: "14:22:43",
        duration: "1m 05s",
        size: "2880 x 2880",
        badge: "当前最佳",
        imageTheme: "from-amber-100 via-white to-lime-200",
        note: "默认展示最新版本，用户可以点版本1/2/3切换。",
        retryOf: 2,
    },
];

const promptPool = [
    "保留产品主体，优化标题排版，增强背景干净程度。",
    "基于当前版本继续重试，强化卖点区域和产品边缘锐度。",
    "保持构图不变，提升真实摄影光影，减少文字杂乱。",
    "只优化产品质感和画面层次，旧版本继续保留。",
];

export default function ImageWorkbenchVersionDemoPage() {
    const { message } = App.useApp();
    const [versions, setVersions] = useState(initialVersions);
    const [activeVersionId, setActiveVersionId] = useState(initialVersions[initialVersions.length - 1].id);
    const [prompt, setPrompt] = useState("把这张产品主图改得更像高转化电商图，保留包装文字和主体。");

    const activeVersion = versions.find((item) => item.id === activeVersionId) || versions[versions.length - 1];
    const latestVersion = versions[versions.length - 1];
    const versionTabs = useMemo(() => versions.map((item) => `版本 ${item.versionNo}`).join(" / "), [versions]);

    const retryCurrent = () => {
        const nextNo = versions.length + 1;
        const next: DemoVersion = {
            id: `v${nextNo}`,
            versionNo: nextNo,
            prompt: promptPool[nextNo % promptPool.length],
            status: "success",
            createdAt: new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            duration: `${52 + nextNo * 6}s`,
            size: nextNo % 2 ? "2880 x 2880" : "2048 x 2048",
            badge: "新重试",
            imageTheme: nextNo % 2 ? "from-blue-100 via-white to-slate-200" : "from-orange-100 via-white to-yellow-200",
            note: `版本${nextNo}由版本${activeVersion.versionNo}重试生成，前面的版本全部保留。`,
            retryOf: activeVersion.versionNo,
        };
        setVersions((value) => [...value, next]);
        setActiveVersionId(next.id);
        message.success(`新增版本 ${nextNo}，没有覆盖旧图`);
    };

    return (
        <main className="h-full overflow-auto bg-[#f5f1e8] text-[#1f1c17]">
            <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-4 p-4 lg:p-6">
                <header className="rounded-3xl border border-black/10 bg-white/80 p-5 shadow-[0_18px_60px_rgba(38,31,22,.12)]">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <div className="mb-2 flex flex-wrap gap-2">
                                <Tag className="m-0 bg-black px-3 py-1 text-white">生图工作台 Demo</Tag>
                                <Tag className="m-0 bg-amber-100 px-3 py-1 text-amber-800">重试保留版本</Tag>
                            </div>
                            <h1 className="text-3xl font-black tracking-[-0.04em] lg:text-5xl">点击重试后，不覆盖旧图</h1>
                            <p className="mt-2 text-sm text-stone-600">这个页面模拟生图工作台结果卡片：每次重试新增一个版本，旧图片、提示词、尺寸、耗时都能回看。</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button icon={<RotateCcw className="size-4" />} onClick={() => {
                                setVersions(initialVersions);
                                setActiveVersionId(initialVersions[initialVersions.length - 1].id);
                            }}>
                                重置 demo
                            </Button>
                            <Button type="primary" icon={<Sparkles className="size-4" />} onClick={retryCurrent}>
                                模拟点击重试
                            </Button>
                        </div>
                    </div>
                </header>

                <section className="grid min-h-[720px] gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
                    <aside className="flex flex-col gap-4 rounded-3xl border border-black/10 bg-white p-4 shadow-[0_16px_50px_rgba(38,31,22,.1)]">
                        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
                            <div className="mb-3 flex items-center gap-2 font-black">
                                <Sparkles className="size-4" />
                                提示词
                            </div>
                            <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} />
                            <Button className="mt-3 w-full" type="primary" icon={<Plus className="size-4" />} onClick={retryCurrent}>
                                用当前提示词重试
                            </Button>
                        </div>

                        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
                            <div className="mb-3 flex items-center gap-2 font-black">
                                <Upload className="size-4" />
                                参考图
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <ReferenceTile label="原图" tone="bg-blue-100" />
                                <ReferenceTile label="区域标注" tone="bg-emerald-100" />
                            </div>
                        </div>

                        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
                            <div className="mb-3 flex items-center gap-2 font-black">
                                <Settings2 className="size-4" />
                                生成设置
                            </div>
                            <div className="grid gap-2 text-sm">
                                <SettingRow label="模型" value="gpt-image-2" />
                                <SettingRow label="分辨率" value="2K" />
                                <SettingRow label="比例" value="1:1" />
                                <SettingRow label="输出" value="PNG" />
                            </div>
                        </div>
                    </aside>

                    <section className="rounded-3xl border border-black/10 bg-white p-4 shadow-[0_16px_50px_rgba(38,31,22,.1)]">
                        <div className="mb-4 flex flex-col gap-3 border-b border-stone-200 pb-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <h2 className="text-2xl font-black">生成结果</h2>
                                <p className="text-sm text-stone-500">版本组：{versionTabs}</p>
                            </div>
                            <div className="flex gap-2">
                                <Button icon={<Download className="size-4" />}>下载当前版本</Button>
                                <Button icon={<ImagePlus className="size-4" />}>加入参考图</Button>
                            </div>
                        </div>

                        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                            <div className="rounded-3xl border border-stone-200 bg-stone-100 p-4">
                                <div className="mb-3 flex flex-wrap gap-2">
                                    {versions.map((version) => (
                                        <button
                                            key={version.id}
                                            type="button"
                                            onClick={() => setActiveVersionId(version.id)}
                                            className={cn(
                                                "rounded-full border px-4 py-2 text-sm font-bold transition",
                                                version.id === activeVersion.id ? "border-black bg-black text-white" : "border-stone-300 bg-white text-stone-700 hover:border-black",
                                            )}
                                        >
                                            版本 {version.versionNo}
                                            {version.id === latestVersion.id ? " · 最新" : ""}
                                        </button>
                                    ))}
                                </div>

                                <div className={cn("relative grid min-h-[520px] place-items-center overflow-hidden rounded-3xl bg-gradient-to-br", activeVersion.imageTheme)}>
                                    <div className="absolute left-6 top-6 rounded-full bg-white/75 px-4 py-2 text-xs font-black shadow-lg">
                                        当前查看：版本 {activeVersion.versionNo}
                                    </div>
                                    {activeVersion.retryOf ? <div className="absolute right-6 top-6 rounded-full bg-black px-4 py-2 text-xs font-black text-white">由版本 {activeVersion.retryOf} 重试</div> : null}
                                    <DemoProduct version={activeVersion.versionNo} />
                                    <div className="absolute bottom-6 left-6 right-6 rounded-2xl bg-white/80 p-4 shadow-xl backdrop-blur">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Tag className="m-0 bg-black text-white">{activeVersion.badge}</Tag>
                                            <Tag className="m-0">{activeVersion.size}</Tag>
                                            <Tag className="m-0">{activeVersion.duration}</Tag>
                                        </div>
                                        <p className="mt-2 text-sm text-stone-600">{activeVersion.note}</p>
                                    </div>
                                </div>
                            </div>

                            <aside className="space-y-4">
                                <div className="rounded-3xl border border-stone-200 bg-stone-50 p-4">
                                    <h3 className="mb-3 font-black">当前版本信息</h3>
                                    <div className="grid gap-2 text-sm">
                                        <SettingRow label="版本号" value={`版本 ${activeVersion.versionNo}`} />
                                        <SettingRow label="状态" value={activeVersion.status === "success" ? "成功" : activeVersion.status} />
                                        <SettingRow label="生成时间" value={activeVersion.createdAt} />
                                        <SettingRow label="耗时" value={activeVersion.duration} />
                                        <SettingRow label="尺寸" value={activeVersion.size} />
                                    </div>
                                </div>

                                <div className="rounded-3xl border border-stone-200 bg-stone-50 p-4">
                                    <div className="mb-3 flex items-center justify-between">
                                        <h3 className="font-black">该版本提示词</h3>
                                        <Button size="small" icon={<Copy className="size-3" />}>复制</Button>
                                    </div>
                                    <p className="rounded-2xl bg-white p-3 text-sm leading-6 text-stone-600">{activeVersion.prompt}</p>
                                </div>

                                <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4">
                                    <h3 className="mb-2 font-black text-amber-900">真实功能要做成这样</h3>
                                    <p className="text-sm leading-6 text-amber-800">重试时新建 log，不再 replace 旧 log。结果卡片按 versionGroupId 聚合，默认显示最新版本，点版本标签可切换旧图。</p>
                                </div>
                            </aside>
                        </div>
                    </section>
                </section>
            </div>
        </main>
    );
}

function ReferenceTile({ label, tone }: { label: string; tone: string }) {
    return (
        <div className={cn("grid aspect-square place-items-center rounded-2xl border border-stone-200", tone)}>
            <div className="rounded-full bg-white/80 px-3 py-1 text-xs font-black text-stone-700 shadow">{label}</div>
        </div>
    );
}

function SettingRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
            <span className="text-stone-500">{label}</span>
            <span className="font-bold text-stone-900">{value}</span>
        </div>
    );
}

function DemoProduct({ version }: { version: number }) {
    return (
        <div className="relative h-[360px] w-[280px]">
            <div className="absolute inset-x-10 bottom-4 h-12 rounded-full bg-black/20 blur-xl" />
            <div className="absolute left-1/2 top-4 h-[315px] w-[190px] -translate-x-1/2 rounded-[2.2rem] border border-white/80 bg-white/90 shadow-[0_35px_90px_rgba(26,23,18,.25)]">
                <div className="mx-auto mt-7 h-10 w-28 rounded-full bg-stone-900" />
                <div className="mx-auto mt-5 h-5 w-24 rounded-full bg-stone-300" />
                <div className="mx-auto mt-8 grid size-28 place-items-center rounded-full bg-gradient-to-br from-cyan-100 to-emerald-100 text-4xl font-black text-stone-800">{version}</div>
                <div className="mx-auto mt-7 h-4 w-32 rounded-full bg-stone-200" />
                <div className="mx-auto mt-3 h-4 w-24 rounded-full bg-stone-200" />
                <div className="absolute bottom-8 left-1/2 h-12 w-28 -translate-x-1/2 rounded-2xl bg-stone-900/10" />
            </div>
            <LoaderCircle className="absolute right-7 top-16 size-6 animate-spin text-stone-500/60" />
        </div>
    );
}
