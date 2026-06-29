import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type TextOcrItem = {
    text: string;
    box_2d?: number[];
    rotate_rect?: unknown;
};

type DashScopePayload = {
    output?: {
        choices?: Array<{
            message?: {
                content?: unknown;
            };
        }>;
    };
    code?: string;
    message?: string;
    request_id?: string;
};

let localEnvCache: Record<string, string> | null = null;

export async function POST(request: NextRequest) {
    const { image, images } = (await request.json().catch(() => ({}))) as { image?: string; images?: string[] };
    const inputImages = normalizeInputImages(image, images);
    if (!inputImages.length) return Response.json({ code: 1, data: null, msg: "缺少图片" }, { status: 400 });

    const apiKey = envValue("DASHSCOPE_API_KEY");
    if (!apiKey) return Response.json({ code: 1, data: null, msg: "未配置 DASHSCOPE_API_KEY" }, { status: 500 });

    const baseUrl = (envValue("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
    const model = envValue("DASHSCOPE_OCR_MODEL") || "qwen-vl-ocr";
    const endpoint = `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;

    try {
        const groups: TextOcrItem[][] = [];
        let lastError: OcrRequestError | null = null;

        for (const inputImage of inputImages) {
            try {
                groups.push(await requestDashScopeOcr({ endpoint, apiKey, model, image: inputImage }));
            } catch (error) {
                lastError = normalizeOcrRequestError(error);
            }
        }

        if (!groups.length && lastError) {
            return Response.json({ code: 1, data: null, msg: lastError.message }, { status: lastError.status });
        }

        const items = mergeOcrItems(groups);
        return Response.json({ code: 0, data: { items }, msg: "" });
    } catch (error) {
        return Response.json({ code: 1, data: null, msg: error instanceof Error ? error.message : "OCR 请求失败" }, { status: 502 });
    }
}

class OcrRequestError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "OcrRequestError";
        this.status = status;
    }
}

function normalizeInputImages(image?: string, images?: string[]) {
    const seen = new Set<string>();
    return [image, ...(Array.isArray(images) ? images : [])]
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => {
            if (!item || seen.has(item)) return false;
            seen.add(item);
            return true;
        })
        .slice(0, 8);
}

async function requestDashScopeOcr({ endpoint, apiKey, model, image }: { endpoint: string; apiKey: string; model: string; image: string }) {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            input: {
                messages: [
                    {
                        role: "user",
                        content: [
                            { image },
                            {
                                text: [
                                    "请识别图片中所有肉眼可见文字。",
                                    "请按从上到下、从左到右、从中心到四边的顺序完整扫描，不要只识别主标题。",
                                    "大字、小字、低对比文字、横排、竖排、旋转文字、边缘文字、角落文字、图形内文字、英文、数字、符号和单位都要识别。",
                                    "尤其不要漏掉图片底部、右侧、边缘区域的规格、净含量、单位数字、说明文字。",
                                    "只识别确定存在的文字，不翻译、不补全、不改写。",
                                    "每个独立短语、标题、小字、英文行都单独作为一项；不要把一个中文词拆成单字，不要把相邻不同区域的文字合并成一项。",
                                    '只返回 JSON：{"data":[{"text":"原文","box_2d":[x1,y1,x2,y2]}]}。不要返回 Markdown 代码块，不要返回解释。',
                                ].join("\n"),
                            },
                        ],
                    },
                ],
            },
            parameters: { result_format: "message" },
        }),
    });
    const payload = (await response.json().catch(() => null)) as DashScopePayload | null;
    if (!response.ok) throw new OcrRequestError(dashScopeError(payload, response.status), response.status);
    return normalizeOcrItems(payload);
}

function normalizeOcrRequestError(error: unknown) {
    if (error instanceof OcrRequestError) return error;
    return new OcrRequestError(error instanceof Error ? error.message : "OCR 请求失败", 502);
}

function envValue(key: string) {
    return process.env[key] || readLocalEnv()[key] || "";
}

function readLocalEnv() {
    if (localEnvCache) return localEnvCache;
    const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../.env")];
    localEnvCache = {};
    for (const file of candidates) {
        if (!existsSync(file)) continue;
        Object.assign(localEnvCache, parseEnvFile(readFileSync(file, "utf8")));
    }
    return localEnvCache;
}

function parseEnvFile(content: string) {
    const values: Record<string, string> = {};
    content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const index = trimmed.indexOf("=");
        if (index <= 0) return;
        const key = trimmed.slice(0, index).trim();
        let value = trimmed.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        values[key] = value;
    });
    return values;
}

function dashScopeError(payload: DashScopePayload | null, status: number) {
    return payload?.message || payload?.code || `OCR 请求失败：${status}`;
}

function normalizeOcrItems(payload: DashScopePayload | null): TextOcrItem[] {
    const content = payload?.output?.choices?.[0]?.message?.content;
    const values = normalizeUnknownContent(content);
    const items = values.flatMap((value) => parseOcrValue(value)).flatMap(expandOcrItem);
    const seen = new Set<string>();
    return items
        .map((item) => ({ ...item, text: item.text.replace(/\s+/g, " ").trim() }))
        .filter((item) => {
            if (!item.text || seen.has(item.text) || isRawOcrPayloadText(item.text)) return false;
            seen.add(item.text);
            return true;
        })
        .slice(0, 80);
}

function mergeOcrItems(groups: TextOcrItem[][]) {
    const merged = new Map<string, TextOcrItem>();
    for (const item of groups.flat()) {
        const text = item.text.replace(/\s+/g, " ").trim();
        const key = ocrTextKey(text);
        if (!text || !key || isRawOcrPayloadText(text)) continue;
        const next = { ...item, text };
        const current = merged.get(key);
        if (!current || ocrTextScore(next.text) > ocrTextScore(current.text)) merged.set(key, next);
    }
    return removeTruncatedOcrItems(Array.from(merged.values())).slice(0, 80);
}

function ocrTextKey(value: string) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s.,:;'"`~!@#$%^&*()[\]{}<>?/\\|+=_\-，。；：、？！“”‘’（）【】《》·•]+/g, "");
}

function ocrTextScore(value: string) {
    let score = value.length;
    if (/[A-Za-z]\s+[A-Za-z]/.test(value)) score += 8;
    if (/[\u3400-\u9fff]/.test(value)) score += 2;
    if (/[0-9][gG]|[0-9].*[颗瓶盒袋]/.test(value)) score += 2;
    if (/[：:()（）×]/.test(value)) score += 1;
    if (isRawOcrPayloadText(value)) score -= 1000;
    return score;
}

function removeTruncatedOcrItems(items: TextOcrItem[]) {
    const entries = items
        .map((item, index) => ({ item, index, text: item.text.trim(), key: ocrTextKey(item.text) }))
        .filter((entry) => entry.text && entry.key);
    return entries
        .filter((entry) => {
            if (isLowInformationOcrFragment(entry.text, entry.key)) return false;
            return !entries.some((other) => isContainedOcrFragment(entry, other));
        })
        .map((entry) => entry.item);
}

function isContainedOcrFragment(current: { index: number; text: string; key: string }, other: { index: number; key: string }) {
    if (other.index === current.index) return false;
    if (other.key.length <= current.key.length || !other.key.includes(current.key)) return false;

    if (current.key.length <= 2) return true;
    if (containsCjk(current.key) && current.key.length <= 4) return true;
    if (/^[a-z]+$/.test(current.key) && current.key.length <= 6 && !isAllCapsStandaloneToken(current.text)) return true;
    if (/\d/.test(current.key) && current.key.length <= 4) return true;

    const isClosePrefixOrSuffix = other.key.length - current.key.length <= 8 && (other.key.startsWith(current.key) || other.key.endsWith(current.key));
    return isClosePrefixOrSuffix;
}

function isLowInformationOcrFragment(text: string, key: string) {
    if (/^[\u3400-\u9fff]$/.test(key)) return true;
    if (/^[a-z]{1,2}$/.test(key) && !isAllCapsStandaloneToken(text)) return true;
    return false;
}

function isAllCapsStandaloneToken(value: string) {
    const token = value.replace(/[^A-Za-z0-9]/g, "");
    return token.length >= 2 && /^[A-Z0-9]+$/.test(token) && /[A-Z]/.test(token);
}

function expandOcrItem(item: TextOcrItem): TextOcrItem[] {
    return splitMergedText(item.text).map((text) => ({ ...item, text }));
}

function splitMergedText(value: string) {
    const lines = value
        .split(/\r?\n|[|｜]/)
        .map((line) => line.trim())
        .filter(Boolean);
    const result: string[] = [];
    for (const line of lines.length ? lines : [value.trim()]) {
        if (isRawOcrPayloadText(line)) continue;
        const tokens = line.split(/\s+/).filter(Boolean);
        if (tokens.length <= 1) {
            result.push(line);
            continue;
        }
        let latinBuffer: string[] = [];
        const flushLatin = () => {
            if (!latinBuffer.length) return;
            result.push(latinBuffer.join(" "));
            latinBuffer = [];
        };
        for (const token of tokens) {
            if (containsCjk(token)) {
                flushLatin();
                result.push(token);
                continue;
            }
            latinBuffer.push(token);
        }
        flushLatin();
    }
    return result;
}

function containsCjk(value: string) {
    return /[\u3400-\u9fff]/.test(value);
}

function normalizeUnknownContent(value: unknown): unknown[] {
    if (Array.isArray(value)) return value.flatMap(normalizeUnknownContent);
    if (!value || typeof value !== "object") return [value];
    const record = value as Record<string, unknown>;
    return [record.ocr_result, record.text, record.processed_text, record.data, value].filter((item) => item !== undefined);
}

function parseOcrValue(value: unknown): TextOcrItem[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(parseOcrValue);
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.data)) return parseOcrValue(record.data);
        const text = typeof record.text === "string" ? record.text : "";
        if (text) {
            const box = readNumberArray(record.box_2d || record.bbox);
            if (box || record.rotate_rect || !looksLikeStructuredOcrPayload(text)) {
                return [{ text, box_2d: box, rotate_rect: record.rotate_rect }];
            }
            return parseOcrValue(text);
        }
        return [record.processed_text, record.data].flatMap(parseOcrValue);
    }
    if (typeof value !== "string") return [];

    const json = parseJsonFromText(value);
    if (json) return parseOcrValue(json);

    const regexItems = Array.from(value.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g))
        .map((match) => ({ text: unescapeJsonString(match[1]) }))
        .filter((item) => item.text.trim());
    if (regexItems.length) return regexItems;
    if (isRawOcrPayloadText(value)) return [];

    return value
        .split(/\r?\n/)
        .map((line) => ({ text: line.trim() }))
        .filter((item) => item.text && !isRawOcrPayloadText(item.text));
}

function parseJsonFromText(value: string) {
    const cleaned = value
        .replace(/^\s*`{3,}\s*(?:json)?/i, "")
        .replace(/`{3,}\s*$/i, "")
        .trim();
    const start = Math.min(...[cleaned.indexOf("["), cleaned.indexOf("{")].filter((index) => index >= 0));
    if (!Number.isFinite(start)) return null;
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    } catch {
        return null;
    }
}

function isRawOcrPayloadText(value: string) {
    const text = value.trim();
    if (!text) return true;
    if (/^`{2,}\s*(json)?/i.test(text)) return true;
    if (/^~{2,}\s*(json)?/i.test(text)) return true;
    if (/^[\[\]{}(),:，、\s]+$/.test(text)) return true;
    if (/^-?\d+(?:\.\d+)?\s*,?$/.test(text)) return true;
    if (/^[\d\s,.\-+\[\]]+$/.test(text)) return true;
    if (/^["']?(data|items|text|box_2d|bbox|rotate_rect|ocr_result|processed_text)["']?\s*:?\s*\[?\s*$/i.test(text)) return true;
    if (/^["']?(x1|y1|x2|y2|left|top|right|bottom)["']?\s*:/i.test(text)) return true;
    if (/^["'][^"']*["']\s*:/.test(text)) return true;
    if (text.includes('"rotate_rect"') || text.includes('"box_2d"') || text.includes('"bbox"') || text.includes('"data"') || text.includes('"text"')) return true;
    return false;
}

function looksLikeStructuredOcrPayload(value: string) {
    const text = value.trim();
    if (!text) return false;
    if (/^`{2,}\s*(json)?/i.test(text)) return true;
    if (text.startsWith("{") || text.startsWith("[")) return true;
    return text.includes('"data"') || text.includes('"text"') || text.includes('"box_2d"') || text.includes('"rotate_rect"');
}

function unescapeJsonString(value: string) {
    try {
        return JSON.parse(`"${value}"`) as string;
    } catch {
        return value.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    }
}

function readNumberArray(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    const numbers = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
    return numbers.length >= 4 ? numbers.slice(0, 4) : undefined;
}
