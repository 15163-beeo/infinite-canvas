"use client";

import { useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Progress, Select, Tag } from "antd";
import {
    Bot,
    CheckCircle2,
    ChevronLeft,
    Copy,
    Download,
    Edit3,
    FileArchive,
    Folder,
    ImagePlus,
    LoaderCircle,
    Pause,
    Play,
    RefreshCw,
    RotateCcw,
    Sparkles,
    Square,
    Upload,
} from "lucide-react";

import { cn } from "@/lib/utils";

type PackageGroup = "main" | "sub" | "detail";
type PackageStatus = "idle" | "planning" | "running" | "paused" | "success";
type ItemStatus = "planning" | "waiting" | "running" | "success" | "failed" | "paused";

type PackageItem = {
    id: string;
    group: PackageGroup;
    index: number;
    title: string;
    size: string;
    status: ItemStatus;
    prompt: string;
    imageUrl?: string;
    elapsed?: number;
};

const productTypes = ["健康护理", "保健食品", "消字号", "营养补充", "个护护理"];
const visualStyles = ["干净专业", "电商详情", "清爽科技", "自然草本", "高端质感"];
const statusLabel: Record<ItemStatus, string> = {
    planning: "规划中",
    waiting: "等待中",
    running: "生成中",
    success: "成功",
    failed: "失败",
    paused: "已暂停",
};
const statusColor: Record<ItemStatus, string> = {
    planning: "text-sky-300 border-sky-500/40 bg-sky-500/10",
    waiting: "text-stone-300 border-stone-500/40 bg-stone-500/10",
    running: "text-cyan-300 border-cyan-500/40 bg-cyan-500/10",
    success: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
    failed: "text-red-300 border-red-500/40 bg-red-500/10",
    paused: "text-amber-300 border-amber-500/40 bg-amber-500/10",
};

const demoImages = [
    "https://images.unsplash.com/photo-1612817288484-6f916006741a?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1620916297397-a4a5402a3c6c?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1617897903246-719242758050?auto=format&fit=crop&w=900&q=80",
    "https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=900&q=80",
];

const groupMeta: Record<PackageGroup, { title: string; subtitle: string; folder: string }> = {
    main: { title: "主图", subtitle: "1 张 · 1:1", folder: "主图" },
    sub: { title: "副图", subtitle: "4 张 · 1:1", folder: "副图" },
    detail: { title: "详情图", subtitle: "11 张 · 竖版长图", folder: "详情图" },
};

const initialProduct = {
    name: "曼诺森舒缓精华乳",
    type: "健康护理",
    sellingPoints: "舒缓护理、清爽肤感、适合日常皮肤管理，包装干净专业",
    specs: "80ml / 按压泵瓶 / 乳液质地",
    people: "日常护理人群、敏感肌护理需求人群",
    scene: "电商主图、平台副图、详情页分屏长图",
    style: "干净专业",
};

export default function EcomSuiteDemoPage() {
    const { message } = App.useApp();
    const timerRef = useRef<number | null>(null);
    const [product, setProduct] = useState(initialProduct);
    const [packageStatus, setPackageStatus] = useState<PackageStatus>("idle");
    const [items, setItems] = useState<PackageItem[]>(createPackageItems("planning"));
    const [activeItemId, setActiveItemId] = useState<string | null>(null);
    const [promptEditor, setPromptEditor] = useState<PackageItem | null>(null);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [folderOpen, setFolderOpen] = useState(false);

    const packageName = `${product.name || "未命名产品"}-产品图包`;
    const doneCount = items.filter((item) => item.status === "success").length;
    const runningItem = items.find((item) => item.status === "running");
    const progressPercent = Math.round((doneCount / items.length) * 100);

    const groupedItems = useMemo(
        () =>
            (["main", "sub", "detail"] as PackageGroup[]).map((group) => ({
                group,
                items: items.filter((item) => item.group === group),
                done: items.filter((item) => item.group === group && item.status === "success").length,
            })),
        [items],
    );

    const clearTimer = () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = null;
    };

    const runPackage = () => {
        clearTimer();
        const nextItems = createPackageItems("waiting", product);
        setItems(nextItems);
        setPackageStatus("planning");
        setActiveItemId(null);
        setFolderOpen(false);
        message.success("已创建产品图包，正在规划提示词");
        timerRef.current = window.setTimeout(() => {
            setPackageStatus("running");
            runQueue(nextItems, 0);
        }, 900);
    };

    const runQueue = (snapshot: PackageItem[], startIndex: number) => {
        const nextIndex = snapshot.findIndex((item, index) => index >= startIndex && item.status !== "success");
        if (nextIndex < 0) {
            setPackageStatus("success");
            setActiveItemId(null);
            message.success("产品图包生成完成");
            return;
        }
        const current = snapshot[nextIndex];
        setActiveItemId(current.id);
        setItems((value) =>
            value.map((item) =>
                item.id === current.id
                    ? { ...item, status: "running", elapsed: 0 }
                    : item.status === "paused" || item.status === "planning"
                      ? { ...item, status: "waiting" }
                      : item,
            ),
        );
        const started = Date.now();
        const tick = () => {
            const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000));
            setItems((value) => value.map((item) => (item.id === current.id && item.status === "running" ? { ...item, elapsed } : item)));
        };
        const tickId = window.setInterval(tick, 500);
        timerRef.current = window.setTimeout(() => {
            window.clearInterval(tickId);
            const imageUrl = demoImages[nextIndex % demoImages.length];
            const nextSnapshot = snapshot.map((item) => (item.id === current.id ? { ...item, status: "success" as const, imageUrl, elapsed: Math.round((Date.now() - started) / 1000) } : item));
            setItems(nextSnapshot);
            runQueue(nextSnapshot, nextIndex + 1);
        }, 1900 + (nextIndex % 3) * 500);
    };

    const pausePackage = () => {
        clearTimer();
        setPackageStatus("paused");
        setActiveItemId(null);
        setItems((value) => value.map((item) => (item.status === "running" || item.status === "waiting" || item.status === "planning" ? { ...item, status: "paused" } : item)));
        message.warning("已暂停生成，当前请求已取消");
    };

    const continuePackage = () => {
        clearTimer();
        const nextItems = items.map((item) => (item.status === "paused" || item.status === "failed" ? { ...item, status: "waiting" as const } : item));
        setItems(nextItems);
        setPackageStatus("running");
        runQueue(nextItems, 0);
    };

    const retryItem = (target: PackageItem) => {
        clearTimer();
        const nextItems = items.map((item) => (item.id === target.id ? { ...item, status: "waiting" as const, imageUrl: undefined, elapsed: 0 } : item));
        setItems(nextItems);
        setPackageStatus("running");
        runQueue(nextItems, Math.max(0, nextItems.findIndex((item) => item.id === target.id)));
    };

    const rewritePrompt = (target: PackageItem) => {
        setItems((value) =>
            value.map((item) =>
                item.id === target.id
                    ? {
                          ...item,
                          status: "waiting",
                          prompt: `${item.prompt}\n补充优化：统一产品包装外观，强化${groupMeta[item.group].title}用途，文案保持健康护理合规表达。`,
                      }
                    : item,
            ),
        );
        message.success("已用 gpt-5.5 模拟重写提示词，可重新生成该图");
    };

    const savePrompt = () => {
        if (!promptEditor) return;
        setItems((value) => value.map((item) => (item.id === promptEditor.id ? { ...item, prompt: promptEditor.prompt, status: item.status === "success" ? "waiting" : item.status } : item)));
        setPromptEditor(null);
        message.success("提示词已更新");
    };

    const downloadGroup = (label: string) => {
        message.success(`${label} 下载演示：真实版本会生成 ZIP 文件夹`);
    };

    return (
        <main className="h-full overflow-hidden bg-[#10100f] text-stone-100">
            <div className="grid h-full grid-cols-[420px_minmax(0,1fr)] gap-3 p-3">
                <aside className="flex min-h-0 flex-col rounded-lg border border-stone-800 bg-[#171614]">
                    <div className="border-b border-stone-800 p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h1 className="text-2xl font-semibold tracking-normal text-white">{folderOpen ? "图包工作流模板" : "产品图包生成"}</h1>
                                <p className="mt-1 text-xs text-stone-400">{folderOpen ? "当前文件夹对应的工作流表单，修改后可重新生成整套图。" : "上传产品图，填写信息，点击后在结果区创建图包文件夹。"}</p>
                            </div>
                            <Tag className="m-0 border-cyan-500/40 bg-cyan-500/10 text-cyan-200">Demo</Tag>
                        </div>
                    </div>
                    <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                        {folderOpen ? (
                            <section className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs text-cyan-100">
                                <div className="mb-2 flex items-center gap-2 font-medium">
                                    <Folder className="size-4" />
                                    {packageName}
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    {groupedItems.map(({ group, items: groupItems, done }) => (
                                        <div key={group} className="rounded bg-black/30 px-2 py-1">
                                            {groupMeta[group].title} {done}/{groupItems.length}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ) : null}
                        <section className="rounded-lg border border-stone-800 bg-black/40 p-3">
                            <div className="mb-3 flex items-center justify-between">
                                <div className="text-sm font-medium">产品参考图</div>
                                <Button size="small" icon={<Upload className="size-3.5" />}>
                                    上传
                                </Button>
                            </div>
                            <div className="grid min-h-40 place-items-center rounded-md border border-dashed border-stone-700 bg-[#111] text-center text-sm text-stone-500">
                                <div>
                                    <ImagePlus className="mx-auto mb-2 size-8 text-stone-500" />
                                    使用当前产品白底图作为参考
                                </div>
                            </div>
                        </section>
                        <section className="space-y-3 rounded-lg border border-stone-800 bg-black/40 p-3">
                            <div className="text-sm font-medium">产品信息</div>
                            <Field label="产品名称">
                                <Input value={product.name} onChange={(event) => setProduct({ ...product, name: event.target.value })} />
                            </Field>
                            <Field label="产品类型">
                                <Select className="w-full" value={product.type} options={productTypes.map((value) => ({ value, label: value }))} onChange={(type) => setProduct({ ...product, type })} />
                            </Field>
                            <Field label="核心卖点">
                                <Input.TextArea value={product.sellingPoints} autoSize={{ minRows: 3, maxRows: 5 }} onChange={(event) => setProduct({ ...product, sellingPoints: event.target.value })} />
                            </Field>
                            <Field label="规格/成分">
                                <Input.TextArea value={product.specs} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(event) => setProduct({ ...product, specs: event.target.value })} />
                            </Field>
                            <Field label="适用人群">
                                <Input value={product.people} onChange={(event) => setProduct({ ...product, people: event.target.value })} />
                            </Field>
                            <Field label="使用场景">
                                <Input value={product.scene} onChange={(event) => setProduct({ ...product, scene: event.target.value })} />
                            </Field>
                            <Field label="视觉风格">
                                <Select className="w-full" value={product.style} options={visualStyles.map((value) => ({ value, label: value }))} onChange={(style) => setProduct({ ...product, style })} />
                            </Field>
                        </section>
                        <section className="rounded-lg border border-stone-800 bg-black/40 p-3">
                            <div className="mb-2 text-sm font-medium">内置图包结构</div>
                            <div className="grid grid-cols-3 gap-2 text-center text-xs">
                                <PlanPill title="主图" value="1张 · 1:1" />
                                <PlanPill title="副图" value="4张 · 1:1" />
                                <PlanPill title="详情图" value="11张 · 竖版" />
                            </div>
                        </section>
                    </div>
                    <div className="border-t border-stone-800 p-4">
                        {packageStatus === "running" || packageStatus === "planning" ? (
                            <Button block danger icon={<Pause className="size-4" />} onClick={pausePackage}>
                                暂停生成
                            </Button>
                        ) : packageStatus === "paused" ? (
                            <Button block type="primary" icon={<Play className="size-4" />} onClick={continuePackage}>
                                继续生成
                            </Button>
                        ) : (
                            <Button block type="primary" icon={<Sparkles className="size-4" />} onClick={runPackage}>
                                运行保健品图包模板
                            </Button>
                        )}
                    </div>
                </aside>

                <section className="min-h-0 overflow-hidden rounded-lg border border-stone-800 bg-[#171716]">
                    {!folderOpen ? (
                        <PackageFolderOverview
                            packageName={packageName}
                            status={packageStatus}
                            items={items}
                            doneCount={doneCount}
                            runningTitle={runningItem?.title}
                            groupedItems={groupedItems}
                            onOpen={() => setFolderOpen(true)}
                            onDownload={() => downloadGroup("整包 ZIP")}
                            onRestart={runPackage}
                        />
                    ) : (
                        <PackageDetail
                            packageName={packageName}
                            doneCount={doneCount}
                            items={items}
                            runningTitle={runningItem?.title}
                            progressPercent={progressPercent}
                            groupedItems={groupedItems}
                            activeItemId={activeItemId}
                            onBack={() => setFolderOpen(false)}
                            onDownloadGroup={downloadGroup}
                            onRestart={runPackage}
                            onPreview={(item) => item.imageUrl && setPreviewImage(item.imageUrl)}
                            onRetry={retryItem}
                            onRewrite={rewritePrompt}
                            onEdit={setPromptEditor}
                            onCopy={(item) => {
                                void navigator.clipboard?.writeText(item.prompt);
                                message.success("已复制提示词");
                            }}
                            onDownloadItem={(item) => downloadGroup(item.title)}
                        />
                    )}
                </section>
            </div>

            <Modal title="手动修改提示词" open={Boolean(promptEditor)} onCancel={() => setPromptEditor(null)} onOk={savePrompt} okText="保存" cancelText="取消" width={720}>
                <Input.TextArea value={promptEditor?.prompt || ""} autoSize={{ minRows: 8, maxRows: 14 }} onChange={(event) => setPromptEditor(promptEditor ? { ...promptEditor, prompt: event.target.value } : null)} />
            </Modal>
            <Modal open={Boolean(previewImage)} footer={null} onCancel={() => setPreviewImage(null)} width={720}>
                {previewImage ? <img src={previewImage} alt="预览" className="mt-6 max-h-[70vh] w-full rounded-lg object-cover" /> : null}
            </Modal>
        </main>
    );
}

function PackageFolderOverview({
    packageName,
    status,
    items,
    doneCount,
    runningTitle,
    groupedItems,
    onOpen,
    onDownload,
    onRestart,
}: {
    packageName: string;
    status: PackageStatus;
    items: PackageItem[];
    doneCount: number;
    runningTitle?: string;
    groupedItems: Array<{ group: PackageGroup; items: PackageItem[]; done: number }>;
    onOpen: () => void;
    onDownload: () => void;
    onRestart: () => void;
}) {
    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-stone-800 p-4">
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className="text-xl font-semibold">全部结果</h2>
                        <Tag className="m-0 bg-stone-800 text-stone-200">{status === "idle" ? 0 : 1}</Tag>
                        {runningTitle ? <Tag className="m-0 border-cyan-500/40 bg-cyan-500/10 text-cyan-200">1个生成中</Tag> : null}
                    </div>
                    <p className="mt-1 text-xs text-stone-500">这里先出现产品图包文件夹，点击文件夹进入主图/副图/详情图。</p>
                </div>
                <div className="flex gap-2">
                    <Button icon={<FileArchive className="size-4" />} onClick={onDownload}>
                        下载整包
                    </Button>
                    <Button icon={<RotateCcw className="size-4" />} onClick={onRestart}>
                        重新开始
                    </Button>
                </div>
            </div>
            <div className="p-4">
                <button type="button" className="group w-[340px] rounded-lg border border-stone-800 bg-[#11100f] p-4 text-left transition hover:border-cyan-500/60" onClick={onOpen}>
                    <div className="mb-4 flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <Folder className="size-6 shrink-0 text-cyan-300" />
                            <div className="min-w-0">
                                <div className="truncate font-semibold text-white">{packageName}</div>
                                <div className="mt-1 text-xs text-stone-500">产品图包文件夹</div>
                            </div>
                        </div>
                        <Tag className="m-0 bg-stone-800 text-stone-200">{doneCount}/{items.length}</Tag>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                        {groupedItems.map(({ group, items: groupItems, done }) => (
                            <div key={group} className="rounded bg-black/40 px-2 py-2 text-center">
                                <div className="text-stone-300">{groupMeta[group].title}</div>
                                <div className="mt-1 text-stone-500">{done}/{groupItems.length}</div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-4 h-1.5 overflow-hidden rounded bg-stone-800">
                        <div className="h-full bg-cyan-400 transition-all" style={{ width: `${Math.round((doneCount / items.length) * 100)}%` }} />
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-stone-500">
                        <span>{runningTitle ? `正在生成：${runningTitle}` : status === "success" ? "已完成" : status === "paused" ? "已暂停" : "等待运行"}</span>
                        <span className="text-cyan-300 group-hover:text-cyan-200">打开</span>
                    </div>
                </button>
            </div>
        </div>
    );
}

function PackageDetail({
    packageName,
    doneCount,
    items,
    runningTitle,
    progressPercent,
    groupedItems,
    activeItemId,
    onBack,
    onDownloadGroup,
    onRestart,
    onPreview,
    onRetry,
    onRewrite,
    onEdit,
    onCopy,
    onDownloadItem,
}: {
    packageName: string;
    doneCount: number;
    items: PackageItem[];
    runningTitle?: string;
    progressPercent: number;
    groupedItems: Array<{ group: PackageGroup; items: PackageItem[]; done: number }>;
    activeItemId: string | null;
    onBack: () => void;
    onDownloadGroup: (label: string) => void;
    onRestart: () => void;
    onPreview: (item: PackageItem) => void;
    onRetry: (item: PackageItem) => void;
    onRewrite: (item: PackageItem) => void;
    onEdit: (item: PackageItem) => void;
    onCopy: (item: PackageItem) => void;
    onDownloadItem: (item: PackageItem) => void;
}) {
    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-stone-800 p-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Button size="small" icon={<ChevronLeft className="size-3.5" />} onClick={onBack}>
                            返回
                        </Button>
                        <Folder className="size-5 text-cyan-300" />
                        <h2 className="truncate text-xl font-semibold">{packageName}</h2>
                        <Tag className="m-0 border-stone-600 bg-stone-800 text-stone-200">{doneCount}/{items.length}</Tag>
                        {runningTitle ? <Tag className="m-0 border-cyan-500/40 bg-cyan-500/10 text-cyan-200">正在生成：{runningTitle}</Tag> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-stone-400">
                        {groupedItems.map(({ group, items: groupItems, done }) => (
                            <span key={group} className="rounded bg-black/40 px-2 py-1">
                                {groupMeta[group].title} {done}/{groupItems.length}
                            </span>
                        ))}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button icon={<FileArchive className="size-4" />} onClick={() => onDownloadGroup("整包 ZIP")}>
                        下载整包
                    </Button>
                    <Button icon={<RotateCcw className="size-4" />} onClick={onRestart}>
                        重新开始
                    </Button>
                </div>
            </div>
            <div className="border-b border-stone-800 px-4 py-3">
                <Progress percent={progressPercent} strokeColor="#22d3ee" trailColor="#292524" />
            </div>
            <div className="thin-scrollbar h-[calc(100%-126px)] overflow-y-auto p-4">
                <div className="space-y-5">
                    {groupedItems.map(({ group, items: groupItems, done }) => (
                        <section key={group} className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Folder className="size-4 text-stone-400" />
                                    <div>
                                        <div className="font-medium">{groupMeta[group].title}</div>
                                        <div className="text-xs text-stone-500">{groupMeta[group].subtitle}</div>
                                    </div>
                                    <Tag className="m-0 bg-stone-800 text-stone-200">{done}/{groupItems.length}</Tag>
                                </div>
                                <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownloadGroup(groupMeta[group].title)}>
                                    下载{groupMeta[group].title}
                                </Button>
                            </div>
                            <div className={cn("grid gap-3", group === "detail" ? "grid-cols-2 xl:grid-cols-4" : "grid-cols-2 xl:grid-cols-5")}>
                                {groupItems.map((item) => (
                                    <PackageItemCard
                                        key={item.id}
                                        item={item}
                                        active={item.id === activeItemId}
                                        onPreview={() => onPreview(item)}
                                        onRetry={() => onRetry(item)}
                                        onRewrite={() => onRewrite(item)}
                                        onEdit={() => onEdit(item)}
                                        onCopy={() => onCopy(item)}
                                        onDownload={() => onDownloadItem(item)}
                                    />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block space-y-1.5 text-sm">
            <span className="text-xs font-medium text-stone-300">{label}</span>
            {children}
        </label>
    );
}

function PlanPill({ title, value }: { title: string; value: string }) {
    return (
        <div className="rounded-md border border-stone-800 bg-[#111] px-2 py-2">
            <div className="font-medium text-stone-100">{title}</div>
            <div className="mt-1 text-stone-500">{value}</div>
        </div>
    );
}

function PackageItemCard({
    item,
    active,
    onPreview,
    onRetry,
    onRewrite,
    onEdit,
    onCopy,
    onDownload,
}: {
    item: PackageItem;
    active: boolean;
    onPreview: () => void;
    onRetry: () => void;
    onRewrite: () => void;
    onEdit: () => void;
    onCopy: () => void;
    onDownload: () => void;
}) {
    const isTall = item.group === "detail";
    return (
        <article className={cn("overflow-hidden rounded-lg border bg-[#11100f]", active ? "border-cyan-400 shadow-[0_0_0_1px_rgba(34,211,238,.35)]" : "border-stone-800")}>
            <button type="button" className={cn("relative grid w-full place-items-center overflow-hidden bg-black/60", isTall ? "aspect-[2/3]" : "aspect-square")} onClick={onPreview}>
                {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.title} className="h-full w-full object-cover" />
                ) : (
                    <div className="flex flex-col items-center gap-2 text-stone-500">
                        {item.status === "running" || item.status === "planning" ? <LoaderCircle className="size-7 animate-spin text-cyan-300" /> : item.status === "paused" ? <Square className="size-7 text-amber-300" /> : <ImagePlus className="size-7" />}
                        <span className="text-xs">{statusLabel[item.status]}</span>
                        {item.elapsed ? <span className="rounded bg-black px-2 py-0.5 text-xs text-stone-300">{item.elapsed}秒</span> : null}
                    </div>
                )}
                <span className={cn("absolute right-2 top-2 rounded border px-2 py-0.5 text-xs", statusColor[item.status])}>{statusLabel[item.status]}</span>
                {item.status === "success" ? (
                    <span className="absolute left-2 top-2 rounded bg-emerald-500 px-2 py-0.5 text-xs font-medium text-black">
                        <CheckCircle2 className="mr-1 inline size-3" />
                        1张
                    </span>
                ) : null}
            </button>
            <div className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{item.title}</div>
                        <div className="mt-0.5 text-xs text-stone-500">{item.size}</div>
                    </div>
                    <Tag className="m-0 shrink-0 text-[10px]">{item.index}</Tag>
                </div>
                <div className="line-clamp-2 min-h-8 text-xs leading-4 text-stone-400">{item.prompt}</div>
                <div className="grid grid-cols-2 gap-1">
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
                        重试
                    </Button>
                    <Button size="small" icon={<Bot className="size-3.5" />} onClick={onRewrite}>
                        AI重写
                    </Button>
                    <Button size="small" icon={<Edit3 className="size-3.5" />} onClick={onEdit}>
                        改提示词
                    </Button>
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={onCopy}>
                        复制
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={onDownload}>
                        下载
                    </Button>
                </div>
            </div>
        </article>
    );
}

function createPackageItems(status: ItemStatus, product = initialProduct): PackageItem[] {
    const titles: Array<{ group: PackageGroup; title: string; size: string }> = [
        { group: "main", title: "主图 · 白底产品图", size: "1024x1024" },
        { group: "sub", title: "副图 · 核心卖点", size: "1024x1024" },
        { group: "sub", title: "副图 · 成分规格", size: "1024x1024" },
        { group: "sub", title: "副图 · 使用场景", size: "1024x1024" },
        { group: "sub", title: "副图 · 适用人群", size: "1024x1024" },
        { group: "detail", title: "详情图 · 产品介绍", size: "1024x1536" },
        { group: "detail", title: "详情图 · 卖点一", size: "1024x1536" },
        { group: "detail", title: "详情图 · 卖点二", size: "1024x1536" },
        { group: "detail", title: "详情图 · 成分说明", size: "1024x1536" },
        { group: "detail", title: "详情图 · 使用方法", size: "1024x1536" },
        { group: "detail", title: "详情图 · 使用场景", size: "1024x1536" },
        { group: "detail", title: "详情图 · 包装细节", size: "1024x1536" },
        { group: "detail", title: "详情图 · 规格参数", size: "1024x1536" },
        { group: "detail", title: "详情图 · 注意事项", size: "1024x1536" },
        { group: "detail", title: "详情图 · 品质总结", size: "1024x1536" },
        { group: "detail", title: "详情图 · 收尾长图", size: "1024x1536" },
    ];
    return titles.map((item, index) => ({
        ...item,
        id: `${item.group}-${index + 1}`,
        index: index + 1,
        status,
        prompt: buildPrompt(item.group, item.title, product),
    }));
}

function buildPrompt(group: PackageGroup, title: string, product: typeof initialProduct) {
    const base = `基于上传的产品参考图，为「${product.name}」生成${title}。产品类型：${product.type}。核心卖点：${product.sellingPoints}。规格/成分：${product.specs}。适用人群：${product.people}。视觉风格：${product.style}。`;
    if (group === "main") return `${base} 画面为1:1电商主图，产品居中，白底干净，包装外观保持一致，文案克制合规。`;
    if (group === "sub") return `${base} 画面为1:1平台副图，突出一个清晰信息点，包含简洁中文标题和辅助信息，不出现治疗、治愈、绝对化功效。`;
    return `${base} 画面为竖版详情页模块，信息分区清楚，适合详情页连续阅读，文字层级明确，避免医疗功效承诺。`;
}
