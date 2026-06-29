import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { getImageBlob, imageToDataUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { nanoid } from "nanoid";

export type ChatCompletionMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type ApimartImageTaskSubmitResponse = {
    data?: Array<{ status?: string; task_id?: string; id?: string }>;
    error?: { message?: string } | string;
    code?: number;
    msg?: string;
    message?: string;
};

type ApimartImageTaskStatusResponse = {
    data?: {
        id?: string;
        status?: string;
        progress?: number;
        result?: {
            images?: unknown[];
        };
        error?: { message?: string; code?: number | string; type?: string } | string;
    };
    error?: { message?: string } | string;
    code?: number;
    msg?: string;
    message?: string;
};

type ApimartImageUploadResponse = {
    url?: string;
    error?: { message?: string } | string;
    msg?: string;
    message?: string;
};

type ResponsesApiResponse = {
    output?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};

type GeneratedImage = { id: string; dataUrl: string };

type ParsedImageResponse = {
    images: GeneratedImage[];
    responseBody: string;
};

export type EditImageOptions = {
    maskDataUrl?: string;
};

export type ImageTextDetectionItem = {
    text: string;
    box_2d?: number[];
    rotate_rect?: unknown;
};

type ImageTextDetectionReference = ReferenceImage & {
    ocrSources?: string[];
};

export class ImageRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "ImageRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

type ImageRequestParams = {
    n: number;
    quality: string;
    size: string;
    outputFormat: "png" | "jpeg" | "webp";
    outputCompression: number;
    moderation: "auto" | "low";
    timeoutSeconds: number;
    streamPartialImages: number;
};

type ImageResolutionValue = "1k" | "2k" | "4k";
type PresetRatio = "1:1" | "3:2" | "2:3" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9";

const COMMON_REQUEST_SIZES: Record<PresetRatio, Record<ImageResolutionValue, string>> = {
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
const TIER_PIXEL_BUDGET: Record<ImageResolutionValue, number> = {
    "1k": 1_572_864,
    "2k": 4_194_304,
    "4k": MAX_IMAGE_PIXELS,
};
const MIME_MAP: Record<ImageRequestParams["outputFormat"], string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
};
const PROMPT_REWRITE_GUARD_PREFIX = "Use the following text as the complete prompt. Do not rewrite it:";
const EDIT_RESPONSES_FALLBACK_DISABLED_MODELS = new Set(["gpt-image-2"]);
const APIMART_GPT_IMAGE_2_MODEL = "gpt-image-2";
const APIMART_GPT_IMAGE_2_OFFICIAL_MODEL = "gpt-image-2-official";
const APIMART_TASK_POLL_INTERVAL_MS = 3000;
const APIMART_GPT_IMAGE_2_MAX_WAIT_SECONDS = 240;
const OCR_REQUEST_IMAGE_LIMIT = 8;

function normalizeQuality(_quality: string) {
    return "auto";
}

function normalizeOutputFormat(value: string): ImageRequestParams["outputFormat"] {
    return value === "jpeg" || value === "webp" ? value : "png";
}

function normalizeModeration(value: string): ImageRequestParams["moderation"] {
    return value === "low" ? "low" : "auto";
}

function normalizeModelName(value: string | undefined) {
    return (value || "").trim().toLowerCase();
}

function normalizeBoundedInteger(value: string | number, fallback: number, min: number, max: number) {
    const number = Math.floor(Math.abs(Number(value)));
    if (!Number.isFinite(number) || number < min) return fallback;
    return Math.max(min, Math.min(max, number));
}

function resolveRequestSize(size: string | undefined) {
    const value = (size || "").trim().toLowerCase();
    if (!value || value === "auto") return "auto";

    if (value in COMMON_REQUEST_SIZES) return COMMON_REQUEST_SIZES[value as PresetRatio]["1k"];

    const dimensions = parsePixelSize(value);
    if (dimensions) return normalizeRequestPixelSize(dimensions.width, dimensions.height);

    const ratio = parseRatio(value);
    if (ratio) return calculateRequestImageSize("1k", `${ratio.width}:${ratio.height}`) || COMMON_REQUEST_SIZES["1:1"]["1k"];

    return "auto";
}

function createImageRequestParams(config: AiConfig): ImageRequestParams {
    const quality = normalizeQuality(config.quality);
    const outputFormat = normalizeOutputFormat(config.outputFormat);
    return {
        n: normalizeBoundedInteger(config.count, 1, 1, 15),
        quality,
        size: resolveRequestSize(config.size),
        outputFormat,
        outputCompression: normalizeBoundedInteger(config.outputCompression, 100, 0, 100),
        moderation: normalizeModeration(config.moderation),
        timeoutSeconds: normalizeBoundedInteger(config.timeout, 600, 1, 3600),
        streamPartialImages: normalizeBoundedInteger(config.streamPartialImages, 1, 0, 3),
    };
}

function normalizeBase64Image(value: string, fallbackMime: string) {
    return value.startsWith("data:") ? value : `data:${fallbackMime};base64,${value}`;
}

function resolveImageDataUrl(item: Record<string, unknown>, mime: string) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return normalizeBase64Image(item.b64_json, mime);
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.data
            ?.map((item) => resolveImageDataUrl(item, mime))
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("接口没有返回图片", payload);
    }

    return images;
}

function parsePixelSize(value: string | undefined) {
    const match = value?.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : null;
}

function parseRatio(value: string) {
    const match = value.match(/^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

function getPresetRatioKey(ratioWidth: number, ratioHeight: number): PresetRatio | null {
    if (!Number.isInteger(ratioWidth) || !Number.isInteger(ratioHeight)) return null;
    const divisor = gcd(ratioWidth, ratioHeight);
    const key = `${ratioWidth / divisor}:${ratioHeight / divisor}`;
    return key in COMMON_REQUEST_SIZES ? (key as PresetRatio) : null;
}

function calculateRequestImageSize(resolution: ImageResolutionValue, ratioValue: string) {
    const parsed = parseRatio(ratioValue);
    if (!parsed) return null;

    const presetRatioKey = getPresetRatioKey(parsed.width, parsed.height);
    if (presetRatioKey) return COMMON_REQUEST_SIZES[presetRatioKey][resolution];

    const targetRatio = parsed.width / parsed.height;
    const pixelBudget = TIER_PIXEL_BUDGET[resolution];
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

function normalizeRequestDimensions(width: number, height: number) {
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

function normalizeRequestPixelSize(width: number, height: number) {
    const normalized = normalizeRequestDimensions(width, height);
    return `${normalized.width}x${normalized.height}`;
}

function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}

function isApimartGptImage2Model(config: AiConfig) {
    if (normalizeModelName(config.model || config.imageModel) !== APIMART_GPT_IMAGE_2_MODEL) return false;
    return activeImageChannelBaseUrl(config).toLowerCase().includes("apimart.ai");
}

function activeImageChannelBaseUrl(config: AiConfig) {
    if (config.channelMode === "local") return localChannelForActiveModel(config)?.baseUrl || config.baseUrl || "";
    const preferredId = channelIdForActiveModel(config);
    const channel =
        config.publicChannels.find((item) => item.id === preferredId && item.models.includes(config.model)) || config.publicChannels.find((item) => item.models.includes(config.model)) || config.publicChannels.find((item) => item.id === preferredId);
    return channel?.baseUrl || "";
}

function isApimartSuccessCode(payload: { code?: number }) {
    return typeof payload.code !== "number" || payload.code === 0 || payload.code === 200;
}

function readPayloadErrorMessage(payload: { error?: { message?: string } | string; msg?: string; message?: string }) {
    if (payload.msg) return payload.msg;
    if (payload.message) return payload.message;
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || "";
}

function parseApimartTaskId(payload: ApimartImageTaskSubmitResponse) {
    if (!isApimartSuccessCode(payload)) {
        throw new ImageRequestError(readPayloadErrorMessage(payload) || "APIMart 请求失败", payload);
    }
    const first = payload.data?.[0];
    const taskId = first?.task_id || first?.id || "";
    if (!taskId) {
        throw new ImageRequestError("APIMart 没有返回任务 ID", payload);
    }
    return taskId;
}

function apimartResolutionForSize(size: string | undefined): "1k" | "2k" | "4k" {
    const dimensions = parsePixelSize(size);
    if (!dimensions) return "1k";
    const longSide = Math.max(dimensions.width, dimensions.height);
    const pixels = dimensions.width * dimensions.height;
    if (pixels >= 6_000_000 || longSide >= 2800) return "4k";
    if (longSide >= 1800) return "2k";
    return "1k";
}

function apimartRequestSize(params: ImageRequestParams) {
    return params.size && params.size !== "auto" ? params.size : undefined;
}

function collectStringUrls(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
    return [];
}

function collectApimartTaskImageUrls(payload: ApimartImageTaskStatusResponse) {
    const images = payload.data?.result?.images;
    if (!Array.isArray(images)) return [];
    const urls = images.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        return ["url", "urls", "image_url"].flatMap((key) => collectStringUrls(record[key]));
    });
    return Array.from(new Set(urls));
}

function apimartTaskStatusUrl(config: AiConfig, taskId: string) {
    const url = aiApiUrl(config, `/tasks/${encodeURIComponent(taskId)}`);
    if (config.channelMode !== "remote") return url;
    return `${url}?model=${encodeURIComponent(config.model || APIMART_GPT_IMAGE_2_MODEL)}`;
}

async function delay(ms: number) {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollApimartImageTask(config: AiConfig, taskId: string, timeoutSeconds: number): Promise<{ images: GeneratedImage[]; payload: ApimartImageTaskStatusResponse }> {
    const maxWaitSeconds = Math.min(timeoutSeconds, APIMART_GPT_IMAGE_2_MAX_WAIT_SECONDS);
    const deadline = Date.now() + maxWaitSeconds * 1000;
    let lastPayload: ApimartImageTaskStatusResponse | null = null;
    while (Date.now() < deadline) {
        const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        const response = await requestWithTransientRetry(() =>
            withTimeout(remainingSeconds, (signal) =>
                fetch(apimartTaskStatusUrl(config, taskId), {
                    method: "GET",
                    headers: aiHeaders(config),
                    signal,
                }),
            ),
        );
        if (!response.ok) {
            const error = await fetchErrorDetail(response, "任务查询失败");
            throw new ImageRequestError(error.message, error.detail);
        }

        const payload = (await response.json()) as ApimartImageTaskStatusResponse;
        lastPayload = payload;
        if (!isApimartSuccessCode(payload)) {
            throw new ImageRequestError(readPayloadErrorMessage(payload) || "APIMart 任务查询失败", payload);
        }

        const status = (payload.data?.status || "").toLowerCase();
        if (status === "completed" || status === "success" || status === "succeeded") {
            const urls = collectApimartTaskImageUrls(payload);
            if (urls.length) return { images: urls.map((dataUrl) => ({ id: nanoid(), dataUrl })), payload };
            throw new ImageRequestError("APIMart 任务已完成但没有返回图片 URL", payload);
        }
        if (status === "failed" || status === "failure" || status === "cancelled" || status === "canceled") {
            const error = payload.data?.error;
            const message = typeof error === "string" ? error : error?.message;
            throw new ImageRequestError(message || `APIMart 图片任务${status === "cancelled" ? "已取消" : "失败"}`, payload);
        }

        await delay(Math.min(APIMART_TASK_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    const progress = typeof lastPayload?.data?.progress === "number" ? `，当前进度 ${lastPayload.data.progress}%` : "";
    throw new ImageRequestError(`APIMart gpt-image-2 任务超过 ${maxWaitSeconds} 秒仍未完成${progress}。这通常是上游排队或任务卡住，请稍后重试或切换更快渠道。`, lastPayload || { task_id: taskId });
}

async function uploadApimartReferenceImage(config: AiConfig, reference: ReferenceImage, timeoutSeconds: number) {
    const dataUrl = await imageToDataUrl(reference);
    const file = dataUrlToFile({ ...reference, dataUrl });
    const formData = new FormData();
    if (config.channelMode === "remote") formData.set("model", APIMART_GPT_IMAGE_2_MODEL);
    formData.set("file", file);
    const response = await requestWithTransientRetry(() =>
        withTimeout(timeoutSeconds, (signal) =>
            fetch(aiApiUrl(config, "/uploads/images"), {
                method: "POST",
                headers: aiHeaders(config),
                body: formData,
                signal,
            }),
        ),
    );
    if (!response.ok) {
        const error = await fetchErrorDetail(response, "APIMart 参考图上传失败");
        throw new ImageRequestError(error.message, error.detail);
    }
    const payload = (await response.json()) as ApimartImageUploadResponse;
    if (payload.url) return encodeURI(payload.url);
    throw new ImageRequestError(readPayloadErrorMessage(payload) || "APIMart 参考图上传后没有返回 URL", payload);
}

async function uploadApimartReferenceImages(config: AiConfig, references: ReferenceImage[], timeoutSeconds: number) {
    if (!references.length) return [];
    return Promise.all(references.map((reference) => uploadApimartReferenceImage(config, reference, timeoutSeconds)));
}

function getStringRecordValue(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function collectResponsesImageStrings(value: unknown, depth = 0): string[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) return value.flatMap((item) => collectResponsesImageStrings(item, depth + 1));
    if (typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return ["result", "b64_json", "base64", "image", "image_data", "data"].flatMap((key) => collectResponsesImageStrings(record[key], depth + 1));
}

function getResponsesImageResultBase64(result: unknown) {
    return collectResponsesImageStrings(result)[0] || "";
}

function collectResponsesImageBase64(item: Record<string, unknown>) {
    const values: string[] = [];
    const result = getResponsesImageResultBase64(item.result);
    if (result) values.push(result);
    values.push(...collectResponsesImageStrings(item));
    return Array.from(new Set(values));
}

function parseResponsesPayload(payload: ResponsesApiResponse, mime: string): GeneratedImage[] {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new ImageRequestError(payload.msg || "请求失败", payload);
    }
    const images =
        payload.output
            ?.filter((item) => item.type === "image_generation_call")
            .flatMap((item) => collectResponsesImageBase64(item))
            .filter(Boolean)
            .map((b64) => ({ id: nanoid(), dataUrl: normalizeBase64Image(b64, mime) })) || [];

    if (images.length === 0) {
        throw new ImageRequestError("Responses API 没有返回图片", payload);
    }

    return images;
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError(error)) {
        const responseData: unknown = error.response?.data;
        if (typeof responseData === "string") {
            try {
                const payload = JSON.parse(responseData) as { error?: { message?: string } | string; msg?: string; message?: string };
                if (payload.msg) return payload.msg;
                if (payload.message) return payload.message;
                if (typeof payload.error === "string") return payload.error;
                if (payload.error?.message) return payload.error.message;
            } catch {
                if (responseData.trim()) return responseData.trim();
            }
        }
        if (responseData && typeof responseData === "object") {
            const payload = responseData as { error?: { message?: string } | string; msg?: string; message?: string };
            if (payload.msg) return payload.msg;
            if (payload.message) return payload.message;
            if (typeof payload.error === "string") return payload.error;
            if (payload.error?.message) return payload.error.message;
        }
        return error.response?.status ? `${fallback}：${error.response.status}` : fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

async function fetchErrorDetail(response: Response, fallback: string) {
    try {
        const text = await response.text();
        if (!text.trim()) return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
        try {
            const payload = JSON.parse(text) as { error?: { message?: string }; msg?: string; message?: string };
            return { message: payload.msg || payload.error?.message || payload.message || `${fallback}：${response.status}`, detail: payload };
        } catch {
            return { message: text.trim() || `${fallback}：${response.status}`, detail: text };
        }
    } catch {
        return { message: `${fallback}：${response.status}`, detail: `${response.status} ${response.statusText}` };
    }
}

function formatErrorDetail(detail: unknown) {
    if (detail == null) return "";
    if (typeof detail === "string") return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}

function timeoutError(timeoutSeconds: number) {
    return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`;
}

function isFetchFailure(error: unknown) {
    if (!(error instanceof Error)) return false;
    const summary = `${error.name} ${error.message}`.toLowerCase();
    return summary.includes("failed to fetch") || summary.includes("load failed") || summary.includes("networkerror when attempting to fetch resource");
}

function connectionFailureDetail(config: AiConfig, endpoint: string) {
    const target = aiApiUrl(config, endpoint);
    if (config.channelMode === "local") {
        return {
            message: "接口连接失败：浏览器未能直连上游接口",
            detail: ["浏览器没有拿到生图接口响应。", "常见原因：", "1. Base URL 不可达、证书异常或 DNS 解析失败", "2. 上游接口不支持浏览器跨域访问（CORS）", "3. 当前网络无法访问上游接口", `请求地址：${target}`].join("\n"),
        };
    }
    return {
        message: "接口连接失败：前端没有拿到服务响应",
        detail: ["前端没有拿到图片接口响应。", "常见原因：", "1. 页面打开后服务被重启或切换了端口", "2. 13001 前端或 18080 后端暂时不可用", "3. 浏览器到当前站点的网络连接中断", `请求地址：${target}`].join("\n"),
    };
}

function normalizeRequestFailure(config: AiConfig, endpoint: string, error: unknown) {
    if (error instanceof ImageRequestError) return error;
    if (isFetchFailure(error)) {
        const failure = connectionFailureDetail(config, endpoint);
        return new ImageRequestError(failure.message, failure.detail);
    }
    if (error instanceof Error) return new ImageRequestError(error.message, error.message);
    return new ImageRequestError("请求失败", error);
}

async function withTimeout<T>(timeoutSeconds: number, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
        return await run(controller.signal);
    } catch (error) {
        if (controller.signal.aborted) throw new Error(timeoutError(timeoutSeconds));
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function isTransientStatus(status: number) {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number) {
    return 700 * attempt;
}

async function requestWithTransientRetry(run: () => Promise<Response>, retries = 2) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await run();
            if (!isTransientStatus(response.status) || attempt === retries) return response;
            lastError = new Error(`上游接口临时不可用：${response.status}`);
        } catch (error) {
            lastError = error;
            if (attempt === retries) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay(attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error("请求失败");
}

function parseServerSentEventBlock(block: string) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return null;
    return JSON.parse(data) as Record<string, unknown>;
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void) {
    if (!response.body) throw new ImageRequestError("接口未返回可读取的流式响应", `${response.status} ${response.statusText}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Record<string, unknown>[] = [];

    const processBlock = (block: string) => {
        let event: Record<string, unknown> | null = null;
        try {
            event = parseServerSentEventBlock(block);
        } catch (error) {
            throw new ImageRequestError(error instanceof Error ? error.message : "流式响应解析失败", block);
        }
        if (!event) return;
        events.push(event);
        const error = event.error;
        if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as { message?: unknown }).message === "string") {
            throw new ImageRequestError((error as { message: string }).message, event);
        }
        onEvent(event);
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.search(/\r?\n\r?\n/);
        while (separatorIndex >= 0) {
            const separator = buffer.match(/\r?\n\r?\n/)?.[0] || "\n\n";
            processBlock(buffer.slice(0, separatorIndex));
            buffer = buffer.slice(separatorIndex + separator.length);
            separatorIndex = buffer.search(/\r?\n\r?\n/);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
    return events;
}

function isEventStreamResponse(response: Response) {
    return response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream") ?? false;
}

async function parseImagesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    const completedItems: Record<string, unknown>[] = [];
    let resultPayload: ImageApiResponse | null = null;
    const events = await readJsonServerSentEvents(response, (event) => {
        const type = typeof event.type === "string" ? event.type : "";
        const object = typeof event.object === "string" ? event.object : "";
        if (object === "image.generation.result" || object === "image.edit.result") {
            resultPayload = event as ImageApiResponse;
        }
        if (type === "image_generation.completed" || type === "image_edit.completed") {
            completedItems.push(event);
        }
    });
    if (resultPayload) return parseImagePayload(resultPayload, mime);
    if (completedItems.length) return parseImagePayload({ data: completedItems }, mime);
    throw new ImageRequestError("流式接口未返回最终图片数据", events);
}

async function parseResponsesStreamResponse(response: Response, mime: string): Promise<GeneratedImage[]> {
    let completedPayload: ResponsesApiResponse | null = null;
    const output: Record<string, unknown>[] = [];
    const partialImages: string[] = [];
    const events = await readJsonServerSentEvents(response, (event) => {
        if (event.type === "response.image_generation_call.partial_image") {
            const b64 = getStringRecordValue(event, "partial_image_b64");
            if (b64) partialImages.push(b64);
            return;
        }
        const responsePayload = event.response;
        if (responsePayload && typeof responsePayload === "object" && !Array.isArray(responsePayload)) {
            completedPayload = responsePayload as ResponsesApiResponse;
        }
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "image_generation_call") {
            output.push(item as Record<string, unknown>);
        }
    });
    try {
        return parseResponsesPayload(completedPayload || { output }, mime);
    } catch (error) {
        if (!partialImages.length) {
            throw new ImageRequestError(error instanceof Error ? error.message : "Responses API 没有返回图片", {
                completedPayload,
                output,
                events,
            });
        }
        const lastPartialImage = partialImages[partialImages.length - 1];
        return [{ id: nanoid(), dataUrl: normalizeBase64Image(lastPartialImage, mime) }];
    }
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
    let deltaText = "";
    for (const eventBlock of chunk.split("\n\n")) {
        const data = eventBlock
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
        if (!data || data === "[DONE]") continue;
        const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
        deltaText += delta;
    }
    if (deltaText) onDelta(deltaText);
}

function parseChatCompletionText(payload: unknown) {
    const data = payload as { choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown }; text?: unknown }>; error?: { message?: string } | string; msg?: string; message?: string };
    if (data.msg) throw new Error(data.msg);
    if (data.message) throw new Error(data.message);
    if (typeof data.error === "string") throw new Error(data.error);
    if (data.error?.message) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") return item;
                if (item && typeof item === "object" && "text" in item && typeof (item as { text?: unknown }).text === "string") return (item as { text: string }).text;
                return "";
            })
            .join("");
    }
    return "";
}

async function requestImageQuestionNonStream(config: AiConfig, messages: ChatCompletionMessage[]) {
    const response = await axios.post(
        aiApiUrl(config, "/chat/completions"),
        {
            model: config.model,
            messages: withSystemMessage(config, messages),
            stream: false,
        },
        {
            headers: {
                ...aiHeaders(config, "application/json"),
            } as Record<string, string>,
            timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
        },
    );
    return parseChatCompletionText(response.data);
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = (config.systemPrompts.image || config.systemPrompt).trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withPromptGuard(config: AiConfig, prompt: string) {
    return config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    return config.channelMode === "remote"
        ? {
              Authorization: `Bearer ${token}`,
              ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}),
              ...(contentType ? { "Content-Type": contentType } : {}),
          }
        : {
              Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}`,
              ...(contentType ? { "Content-Type": contentType } : {}),
          };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

async function writeLocalAICallLog(config: AiConfig, endpoint: string, startedAt: number, status: number, timeoutSeconds: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local") return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method: "POST",
            model: config.model,
            channelId: channel?.id || config.activeChannelId || "",
            channelName: channel?.name || "本地直连",
            status,
            durationMs: Date.now() - startedAt,
            credits: 0,
            requestBody,
            responseBody,
            error,
        }),
    }).catch(() => {});
}

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogImages(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogImages(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogImages);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || (item.length > 2048 && looksLikeBase64(item)))) {
            record[key] = `[redacted image/string len=${item.length}]`;
            continue;
        }
        redactLogImages(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function summarizeFormData(formData: FormData) {
    const fields: Record<string, string[]> = {};
    const files: Array<{ field: string; name: string; size: number; type: string }> = [];
    formData.forEach((value, key) => {
        if (value instanceof File) {
            files.push({ field: key, name: value.name, size: value.size, type: value.type });
            return;
        }
        fields[key] = [...(fields[key] || []), String(value)];
    });
    return { fields, files };
}

function summarizeGeneratedImages(images: GeneratedImage[], source: string) {
    return stringifyLogPayload({
        source,
        imageCount: images.length,
        images: images.map((image) => ({ id: image.id, dataUrl: image.dataUrl.startsWith("data:image/") ? `[redacted image len=${image.dataUrl.length}]` : image.dataUrl })),
    });
}

function withSystemMessage(config: AiConfig, messages: ChatCompletionMessage[]) {
    const systemPrompt = (config.systemPrompts.text || config.systemPrompt).trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

async function requestApimartGptImage2Single(config: AiConfig, prompt: string, inputImageUrls: string[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    if (inputImageUrls.length > 16) {
        throw new ImageRequestError("APIMart gpt-image-2 最多支持 16 张参考图", { count: inputImageUrls.length });
    }
    const requestSize = apimartRequestSize(params);
    const body: Record<string, unknown> = {
        model: inputImageUrls.length && config.channelMode !== "remote" ? APIMART_GPT_IMAGE_2_OFFICIAL_MODEL : APIMART_GPT_IMAGE_2_MODEL,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        n: 1,
        resolution: apimartResolutionForSize(params.size || requestSize),
    };
    if (requestSize) body.size = requestSize;
    if (inputImageUrls.length) {
        body.image_urls = inputImageUrls;
        body.official_fallback = true;
    }

    return requestAndParseImages(
        config,
        "/images/generations",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/generations"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            const submitPayload = (await response.json()) as ApimartImageTaskSubmitResponse;
            const taskId = parseApimartTaskId(submitPayload);
            const result = await pollApimartImageTask(config, taskId, params.timeoutSeconds);
            return {
                images: result.images,
                responseBody: stringifyLogPayload({ submit: submitPayload, task: result.payload }),
            };
        },
    );
}

async function requestImageGenerationSingle(config: AiConfig, prompt: string, params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const body: Record<string, unknown> = {
        model: config.model,
        prompt: withPromptGuard(config, withSystemPrompt(config, prompt)),
        output_format: params.outputFormat,
        moderation: params.moderation,
    };
    if (params.n > 1) body.n = params.n;
    if (params.size) body.size = params.size;
    if (params.quality && params.quality !== "auto" && !config.codexCli) body.quality = params.quality;
    if (params.outputFormat !== "png") body.output_compression = params.outputCompression;
    if (config.responseFormatB64Json) body.response_format = "b64_json";
    if (config.streamImages) {
        body.stream = true;
        body.partial_images = params.streamPartialImages;
    }

    return requestAndParseImages(
        config,
        "/images/generations",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/generations"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestImageEditSingle(config: AiConfig, prompt: string, references: ReferenceImage[], params: ImageRequestParams, options?: EditImageOptions): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", withPromptGuard(config, withSystemPrompt(config, prompt)));
    formData.set("output_format", params.outputFormat);
    formData.set("moderation", params.moderation);
    if (params.n > 1) formData.set("n", String(params.n));
    if (params.size) formData.set("size", params.size);
    if (params.quality && params.quality !== "auto" && !config.codexCli) formData.set("quality", params.quality);
    if (params.outputFormat !== "png") formData.set("output_compression", String(params.outputCompression));
    if (config.responseFormatB64Json) formData.set("response_format", "b64_json");
    if (config.streamImages) {
        formData.set("stream", "true");
        formData.set("partial_images", String(params.streamPartialImages));
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    // OpenAI's multipart examples for multi-image edits use the array field name `image[]`.
    files.forEach((file) => formData.append("image[]", file));
    if (options?.maskDataUrl) {
        formData.set("mask", dataUrlToFile({ id: "mask", name: "mask.png", type: "image/png", dataUrl: options.maskDataUrl }));
    }

    return requestAndParseImages(
        config,
        "/images/edits",
        summarizeFormData(formData),
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/images/edits"), {
                        method: "POST",
                        headers: aiHeaders(config),
                        body: formData,
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseImagesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ImageApiResponse;
            return { images: parseImagePayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

function createResponsesImageTool(config: AiConfig, params: ImageRequestParams, isEdit: boolean) {
    const tool: Record<string, unknown> = {
        type: "image_generation",
        action: isEdit ? "edit" : "generate",
        size: params.size || "auto",
        output_format: params.outputFormat,
        moderation: params.moderation,
    };
    if (params.quality && params.quality !== "auto" && !config.codexCli) tool.quality = params.quality;
    if (params.outputFormat !== "png") tool.output_compression = params.outputCompression;
    if (config.streamImages) tool.partial_images = params.streamPartialImages;
    return tool;
}

function createResponsesInput(config: AiConfig, prompt: string, inputImageDataUrls: string[]) {
    const text = config.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt;
    if (!inputImageDataUrls.length) return text;
    return [
        {
            role: "user",
            content: [
                { type: "input_text", text },
                ...inputImageDataUrls.map((dataUrl) => ({
                    type: "input_image",
                    image_url: dataUrl,
                })),
            ],
        },
    ];
}

async function requestResponsesSingle(config: AiConfig, prompt: string, inputImageDataUrls: string[], params: ImageRequestParams): Promise<GeneratedImage[]> {
    const mime = MIME_MAP[params.outputFormat];
    const body: Record<string, unknown> = {
        model: config.model,
        input: createResponsesInput(config, withSystemPrompt(config, prompt), inputImageDataUrls),
        tools: [createResponsesImageTool(config, params, inputImageDataUrls.length > 0)],
        tool_choice: "required",
    };
    if (config.streamImages) body.stream = true;

    return requestAndParseImages(
        config,
        "/responses",
        body,
        params.timeoutSeconds,
        () =>
            requestWithTransientRetry(() =>
                withTimeout(params.timeoutSeconds, (signal) =>
                    fetch(aiApiUrl(config, "/responses"), {
                        method: "POST",
                        headers: aiHeaders(config, "application/json"),
                        body: JSON.stringify(body),
                        signal,
                    }),
                ),
            ),
        async (response) => {
            if (config.streamImages && isEventStreamResponse(response)) {
                const images = await parseResponsesStreamResponse(response, mime);
                return { images, responseBody: summarizeGeneratedImages(images, "event-stream") };
            }
            const payload = (await response.json()) as ResponsesApiResponse;
            return { images: parseResponsesPayload(payload, mime), responseBody: stringifyLogPayload(payload) };
        },
    );
}

async function requestAndParseImages(config: AiConfig, endpoint: string, requestBody: unknown, timeoutSeconds: number, fetchResponse: () => Promise<Response>, parseResponse: (response: Response) => Promise<ParsedImageResponse>) {
    const startedAt = Date.now();
    let logged = false;
    try {
        const response = await fetchResponse();
        if (!response.ok) {
            const error = await fetchErrorDetail(response, "请求失败");
            logged = true;
            void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), stringifyLogPayload(error.detail || error.message), error.message);
            throw new ImageRequestError(error.message, error.detail);
        }
        const parsed = await parseResponse(response);
        logged = true;
        void writeLocalAICallLog(config, endpoint, startedAt, response.status, timeoutSeconds, stringifyLogPayload(requestBody), parsed.responseBody, "");
        return parsed.images;
    } catch (error) {
        const normalized = normalizeRequestFailure(config, endpoint, error);
        if (!logged) {
            void writeLocalAICallLog(config, endpoint, startedAt, 0, timeoutSeconds, stringifyLogPayload(requestBody), "", normalized.detail || normalized.message);
        }
        throw normalized;
    }
}

function shouldFallbackEditToResponses(config: AiConfig, error: unknown) {
    // Some upstreams expose /responses but do not actually support image edit tools for these models.
    if (EDIT_RESPONSES_FALLBACK_DISABLED_MODELS.has(normalizeModelName(config.imageModel)) || EDIT_RESPONSES_FALLBACK_DISABLED_MODELS.has(normalizeModelName(config.model))) {
        return false;
    }
    if (!(error instanceof ImageRequestError)) return false;
    const summary = `${error.message}\n${error.detail || ""}`.toLowerCase();
    return summary.includes("524") || summary.includes("502") || summary.includes("gateway") || summary.includes("上游错误");
}

function isUnsupportedEditResponsesFallback(error: unknown) {
    if (!(error instanceof ImageRequestError)) return false;
    const summary = `${error.message}\n${error.detail || ""}`.toLowerCase();
    return summary.includes("only supported on /v1/images/generations and /v1/images/edits");
}

function isUnsupportedResponsesImageRequest(error: unknown) {
    if (!(error instanceof ImageRequestError)) return false;
    const summary = `${error.message}\n${error.detail || ""}`.toLowerCase();
    return summary.includes("only supported on /v1/images/generations and /v1/images/edits");
}

function mergeEditFallbackFailure(primaryError: unknown, fallbackError: unknown) {
    const primary = primaryError instanceof ImageRequestError ? primaryError : new ImageRequestError(primaryError instanceof Error ? primaryError.message : "图片编辑请求失败", primaryError);
    if (isUnsupportedEditResponsesFallback(fallbackError)) return primary;
    if (!(fallbackError instanceof ImageRequestError)) return primary;
    return new ImageRequestError(primary.message, [primary.detail || primary.message, "", "兜底重试（/responses）也失败：", fallbackError.detail || fallbackError.message].filter(Boolean).join("\n"));
}

function buildEditResponsesFallbackConfig(config: AiConfig): AiConfig {
    return {
        ...config,
        apiMode: "responses",
        streamImages: true,
        streamPartialImages: String(Math.max(1, normalizeBoundedInteger(config.streamPartialImages, 1, 0, 3))),
    };
}

async function requestEditViaResponsesFallback(config: AiConfig, prompt: string, references: ReferenceImage[], count: number) {
    const fallbackConfig = buildEditResponsesFallbackConfig(config);
    if (count <= 1) return requestImages({ ...fallbackConfig, count: "1" }, prompt, references);

    const results = await Promise.allSettled(Array.from({ length: count }, () => requestImages({ ...fallbackConfig, count: "1" }, prompt, references)));
    const images = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (images.length) return images;
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    throw firstError?.reason || new Error("参考图兜底重试失败");
}

async function requestImages(config: AiConfig, prompt: string, references: ReferenceImage[], options?: EditImageOptions): Promise<GeneratedImage[]> {
    const requestConfig = config;
    const params = createImageRequestParams(requestConfig);
    const hasMask = Boolean(options?.maskDataUrl);
    const useApimartGptImage2 = isApimartGptImage2Model(requestConfig);
    const useConcurrentSingleRequests = requestConfig.apiMode === "responses" || requestConfig.codexCli || requestConfig.streamImages || useApimartGptImage2;
    if (params.n > 1 && useConcurrentSingleRequests) {
        const results = await Promise.allSettled(Array.from({ length: params.n }, () => requestImages({ ...requestConfig, count: "1" }, prompt, references, options)));
        const images = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
        if (images.length) return images;
        const firstError = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        throw firstError?.reason || new Error("所有并发请求均失败");
    }
    if (useApimartGptImage2) {
        if (hasMask) {
            throw new ImageRequestError("APIMart gpt-image-2 暂不支持 mask 局部编辑，请使用参考图编辑或切换支持 /images/edits 的渠道。", { model: requestConfig.model });
        }
        const inputImageUrls = await uploadApimartReferenceImages(requestConfig, references, params.timeoutSeconds);
        return requestApimartGptImage2Single(requestConfig, prompt, inputImageUrls, params);
    }
    const inputImageDataUrls = references.length ? await Promise.all(references.map((image) => imageToDataUrl(image))) : [];
    if (requestConfig.apiMode === "responses" && !hasMask) {
        try {
            return await requestResponsesSingle(requestConfig, prompt, inputImageDataUrls, params);
        } catch (error) {
            if (!isUnsupportedResponsesImageRequest(error)) throw error;
            if (references.length) return requestImageEditSingle({ ...requestConfig, apiMode: "images", streamImages: false }, prompt, references, params, options);
            return requestImageGenerationSingle({ ...requestConfig, apiMode: "images", streamImages: false }, prompt, params);
        }
    }
    if (!references.length) return requestImageGenerationSingle(requestConfig, prompt, params);
    try {
        return await requestImageEditSingle(requestConfig, prompt, references, params, options);
    } catch (error) {
        if (hasMask || !shouldFallbackEditToResponses(requestConfig, error)) throw error;
        try {
            return await requestEditViaResponsesFallback(requestConfig, prompt, references, params.n);
        } catch (fallbackError) {
            throw mergeEditFallbackFailure(error, fallbackError);
        }
    }
}

export async function requestGeneration(config: AiConfig, prompt: string) {
    try {
        const images = await requestImages(config, prompt, []);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: EditImageOptions) {
    try {
        const images = await requestImages(config, prompt, references, options);
        refreshRemoteUser(config);
        return images;
    } catch (error) {
        if (error instanceof ImageRequestError) throw error;
        throw new Error(error instanceof Error ? error.message : "请求失败");
    }
}

export async function requestImageTextDetection(reference: ImageTextDetectionReference) {
    const sourceImages = await imageToOcrSourceDataUrls(reference);
    if (!sourceImages.length) throw new Error("图片读取失败，无法识别文字");
    const ocrImages = await buildOcrRequestImages(sourceImages);
    const response = await fetch("/api/image-text-ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: ocrImages }),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: { items?: ImageTextDetectionItem[] } } | null;
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "文字识别失败");
    const seen = new Set<string>();
    const items = Array.isArray(payload.data?.items)
        ? payload.data.items
              .map((item) => ({ ...item, text: (item?.text || "").replace(/\s+/g, " ").trim() }))
              .filter((item) => {
                  const key = imageTextDetectionKey(item.text);
                  if (!item.text || !key || seen.has(key) || isInvalidImageTextDetection(item.text)) return false;
                  seen.add(key);
                  return true;
              })
        : [];
    const cleanItems = removeImageTextDetectionFragments(items);
    if (!cleanItems.length) throw new Error("没有识别到可编辑文字");
    return cleanItems;
}

async function imageToOcrSourceDataUrls(reference: ImageTextDetectionReference) {
    const candidates = [{ dataUrl: reference.dataUrl, url: reference.url, storageKey: reference.storageKey }, ...(reference.ocrSources || []).map((source, index) => ocrSourceReference(source, index))];
    const images: string[] = [];
    for (const candidate of candidates) {
        try {
            const image = await imageToDataUrl(candidate);
            if (image && !images.includes(image)) images.push(image);
        } catch {
            // Continue with other available sources.
        }
    }
    return images;
}

function ocrSourceReference(source: string, index: number): Pick<ReferenceImage, "id" | "name" | "type" | "dataUrl" | "url" | "storageKey"> {
    const value = source.trim();
    const isStorageKey = value.startsWith("image:") || value.startsWith("server:");
    const isDataUrl = value.startsWith("data:");
    return {
        id: `ocr-source-${index}`,
        name: `ocr-source-${index}.png`,
        type: "image/png",
        dataUrl: isDataUrl ? value : "",
        url: !isStorageKey && !isDataUrl ? value : "",
        storageKey: isStorageKey ? value : undefined,
    };
}

async function buildOcrRequestImages(sourceImages: string[]) {
    const images: string[] = [];
    const prepared = await Promise.all(sourceImages.map((sourceImage) => prepareImagesForOcr(sourceImage)));
    const add = (variants: string[]) => {
        for (const variant of variants) {
            if (variant && !images.includes(variant)) images.push(variant);
            if (images.length >= OCR_REQUEST_IMAGE_LIMIT) return true;
        }
        return false;
    };
    for (const variants of prepared) if (add(variants.slice(0, 1))) return images;
    for (const variants of prepared) if (add(variants.slice(1, 3))) return images;
    for (const variants of prepared) if (add(variants.slice(-1))) return images;
    for (const variants of prepared) if (add(variants.slice(3, -1))) return images;
    return images;
}

async function prepareImagesForOcr(dataUrl: string) {
    if (!dataUrl.startsWith("data:image/")) return [dataUrl];
    const images = [dataUrl];
    try {
        const image = await loadImageElement(dataUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) return images;

        const bounds = imageContentBounds(image, width, height);
        const contentMaxSide = Math.max(bounds.width, bounds.height);
        for (const scale of ocrUpscaleFactors(contentMaxSide)) {
            const upscaled = renderOcrImageVariant(image, bounds, scale);
            if (upscaled && !images.includes(upscaled)) images.push(upscaled);
        }
        for (const edgeBounds of ocrEdgeDetailBounds(bounds)) {
            const edge = renderOcrImageVariant(image, edgeBounds, 6);
            if (edge && !images.includes(edge)) images.push(edge);
        }
    } catch {
        return images;
    }
    return images.slice(0, 7);
}

function loadImageElement(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片加载失败"));
        image.src = src;
    });
}

type OcrImageBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};

function imageContentBounds(image: HTMLImageElement, width: number, height: number): OcrImageBounds {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { x: 0, y: 0, width, height };
    context.drawImage(image, 0, 0, width, height);

    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const alpha = pixels[(y * width + x) * 4 + 3];
            if (alpha <= 12) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    if (right < left || bottom < top) return { x: 0, y: 0, width, height };

    const margin = Math.ceil(Math.max(right - left + 1, bottom - top + 1) * 0.035);
    const x = Math.max(0, left - margin);
    const y = Math.max(0, top - margin);
    const nextRight = Math.min(width, right + margin + 1);
    const nextBottom = Math.min(height, bottom + margin + 1);
    return { x, y, width: nextRight - x, height: nextBottom - y };
}

function ocrUpscaleFactors(contentMaxSide: number) {
    // qwen-vl-ocr recognizes small text better when the visible content area is enlarged.
    // Large images are sent as-is to avoid losing detail through resampling.
    if (contentMaxSide < 360) return [4, 6];
    if (contentMaxSide < 700) return [3, 4];
    if (contentMaxSide < 1100) return [2];
    if (contentMaxSide < 1400) return [1.5];
    return [];
}

function ocrEdgeDetailBounds(bounds: OcrImageBounds): OcrImageBounds[] {
    if (bounds.width < 90 || bounds.height < 90) return [];
    const verticalWidth = Math.max(72, Math.round(bounds.width * 0.34));
    const horizontalHeight = Math.max(72, Math.round(bounds.height * 0.32));
    return [
        { x: bounds.x, y: bounds.y + bounds.height - horizontalHeight, width: bounds.width, height: horizontalHeight },
        { x: bounds.x + bounds.width - verticalWidth, y: bounds.y, width: verticalWidth, height: bounds.height },
        { x: bounds.x, y: bounds.y, width: verticalWidth, height: bounds.height },
        { x: bounds.x, y: bounds.y, width: bounds.width, height: horizontalHeight },
    ];
}

function renderOcrImageVariant(image: HTMLImageElement, bounds: OcrImageBounds, requestedScale: number) {
    const maxSide = Math.max(bounds.width, bounds.height);
    const scale = Math.min(requestedScale, 4096 / Math.max(1, maxSide));
    if (scale <= 1.02 && bounds.x === 0 && bounds.y === 0 && bounds.width === image.naturalWidth && bounds.height === image.naturalHeight) return "";

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bounds.width * scale));
    canvas.height = Math.max(1, Math.round(bounds.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
}

function isInvalidImageTextDetection(value: string) {
    const text = value.trim();
    if (!text) return true;
    if (/^[\[\]{}(),:，、\s]+$/.test(text)) return true;
    if (/^-?\d+(?:\.\d+)?\s*,?$/.test(text)) return true;
    if (/^[\d\s,.\-+\[\]]+$/.test(text)) return true;
    if (/^["']?(data|items|text|box_2d|bbox|rotate_rect|ocr_result|processed_text)["']?\s*:?\s*\[?\s*$/i.test(text)) return true;
    if (/^["'][^"']*["']\s*:/.test(text)) return true;
    return text.includes('"rotate_rect"') || text.includes('"box_2d"') || text.includes('"bbox"') || text.includes('"data"') || text.includes('"text"');
}

function removeImageTextDetectionFragments<T extends { text: string }>(items: T[]) {
    const entries = items.map((item, index) => ({ item, index, text: item.text.trim(), key: imageTextDetectionKey(item.text) })).filter((entry) => entry.text && entry.key);
    return entries
        .filter((entry) => {
            if (isLowInformationImageTextFragment(entry.text, entry.key)) return false;
            return !entries.some((other) => isContainedImageTextFragment(entry, other));
        })
        .map((entry) => entry.item);
}

function isContainedImageTextFragment(current: { index: number; text: string; key: string }, other: { index: number; key: string }) {
    if (other.index === current.index) return false;
    if (other.key.length <= current.key.length || !other.key.includes(current.key)) return false;

    if (current.key.length <= 2) return true;
    if (/[\u3400-\u9fff]/.test(current.key) && current.key.length <= 4) return true;
    if (/^[a-z]+$/.test(current.key) && current.key.length <= 6 && !isAllCapsStandaloneImageText(current.text)) return true;
    if (/\d/.test(current.key) && current.key.length <= 4) return true;

    return other.key.length - current.key.length <= 8 && (other.key.startsWith(current.key) || other.key.endsWith(current.key));
}

function isLowInformationImageTextFragment(text: string, key: string) {
    if (/^[\u3400-\u9fff]$/.test(key)) return true;
    if (/^[a-z]{1,2}$/.test(key) && !isAllCapsStandaloneImageText(text)) return true;
    return false;
}

function isAllCapsStandaloneImageText(value: string) {
    const token = value.replace(/[^A-Za-z0-9]/g, "");
    return token.length >= 2 && /^[A-Z0-9]+$/.test(token) && /[A-Z]/.test(token);
}

function imageTextDetectionKey(value: string) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s.,:;'"`~!@#$%^&*()[\]{}<>?/\\|+=_\-，。；：、？！“”‘’（）【】《》·•]+/g, "");
}

export type RemoveBackgroundResult = {
    blob: Blob;
    originalWidth: number;
    originalHeight: number;
    productOffsetX: number;
    productOffsetY: number;
    productWidth: number;
    productHeight: number;
};

export async function requestRemoveBackground(reference: ReferenceImage, config?: AiConfig) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用去背景");
    const formData = new FormData();
    formData.append("file", await referenceToFile(reference));
    formData.set("response", "json");
    appendLayerImageConfig(formData, config);

    let response: Response;
    try {
        response = await fetch("/api/v1/images/remove-background", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
        });
    } catch {
        throw new Error("去背景接口连接失败，请确认后端服务已启动");
    }

    if (!response.ok) {
        const error = await fetchErrorDetail(response, "去背景失败");
        throw new Error(error.message);
    }

    if (response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
        const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null;
        if (payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || "去背景失败");
        return normalizeRemoveBackgroundResult(payload.data);
    }

    const blob = await response.blob();
    if (blob.type.includes("json")) {
        try {
            const payload = JSON.parse(await blob.text()) as { msg?: string };
            throw new Error(payload.msg || "去背景失败");
        } catch (error) {
            if (error instanceof Error) throw error;
        }
        throw new Error("去背景失败");
    }
    if (!blob.size) throw new Error("去背景结果为空");
    return {
        blob,
        originalWidth: 0,
        originalHeight: 0,
        productOffsetX: 0,
        productOffsetY: 0,
        productWidth: 0,
        productHeight: 0,
    };
}

async function normalizeRemoveBackgroundResult(value: unknown): Promise<RemoveBackgroundResult> {
    const record = isRecord(value) ? value : {};
    const imageDataUrl = pickString(record, ["imageDataUrl", "productDataUrl", "product_url", "productUrl", "foreground_url", "foregroundUrl"]);
    if (!imageDataUrl) throw new Error("去背景结果为空");
    const blob = dataUrlToFile({ id: "remove-background", name: "remove-background.png", type: "image/png", dataUrl: imageDataUrl });
    return {
        blob,
        originalWidth: positiveNumber(pickNumber(record, ["originalWidth", "original_width", "width"]), 0),
        originalHeight: positiveNumber(pickNumber(record, ["originalHeight", "original_height", "height"]), 0),
        productOffsetX: finiteNumber(pickNumber(record, ["productOffsetX", "product_offset_x"]), 0),
        productOffsetY: finiteNumber(pickNumber(record, ["productOffsetY", "product_offset_y"]), 0),
        productWidth: finiteNumber(pickNumber(record, ["productWidth", "product_width"]), 0),
        productHeight: finiteNumber(pickNumber(record, ["productHeight", "product_height"]), 0),
    };
}

export type LayerImageTextLayer = {
    text: string;
    position: { x: number; y: number };
    size?: { width: number; height: number };
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    fontSize: number;
    color?: string;
    strokeColor?: string;
    strokeWidth?: number;
    rotation?: number;
    opacity?: number;
};

export type LayerImageResult = {
    backgroundDataUrl: string;
    productDataUrl: string;
    compositeDataUrl: string;
    textLayers: LayerImageTextLayer[];
    originalWidth: number;
    originalHeight: number;
    productOffsetX: number;
    productOffsetY: number;
    productWidth: number;
    productHeight: number;
};

export async function requestLayerImage(reference: ReferenceImage, config?: AiConfig) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用智能分层");
    const formData = new FormData();
    formData.append("file", await referenceToFile(reference));
    appendLayerImageConfig(formData, config);

    let response: Response;
    try {
        response = await fetch("/api/v1/images/layer-image", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
        });
    } catch {
        throw new Error("智能分层接口连接失败，请确认后端服务已启动");
    }

    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null;
    if (!response.ok || payload?.code !== 0 || !payload?.data) {
        throw new Error(payload?.msg || "智能分层失败");
    }
    const result = normalizeLayerImageResult(payload.data);
    if (!result.backgroundDataUrl && !result.productDataUrl && !result.compositeDataUrl && !result.textLayers.length) {
        throw new Error("智能分层结果为空");
    }
    return result;
}

function appendLayerImageConfig(formData: FormData, config?: AiConfig) {
    if (!config) return;
    const textModel = config.textModel || config.model;
    const imageModel = config.imageModel || config.model;
    formData.set("channelMode", config.channelMode);
    formData.set("model", imageModel);
    formData.set("textModel", textModel);
    formData.set("channelId", config.imageChannelId || config.activeChannelId || "");
    formData.set("textChannelId", config.textChannelId || "");
    if (config.channelMode !== "local") return;
    const imageConfig = { ...config, model: imageModel, activeChannelId: config.imageChannelId || config.activeChannelId };
    const textConfig = { ...config, model: textModel, activeChannelId: config.textChannelId || config.activeChannelId };
    const imageChannel = localChannelForActiveModel(imageConfig);
    const textChannel = localChannelForActiveModel(textConfig);
    formData.set("baseUrl", imageChannel?.baseUrl || config.baseUrl);
    formData.set("apiKey", imageChannel?.apiKey || config.apiKey);
    formData.set("textBaseUrl", textChannel?.baseUrl || imageChannel?.baseUrl || config.baseUrl);
    formData.set("textApiKey", textChannel?.apiKey || imageChannel?.apiKey || config.apiKey);
}

function normalizeLayerImageResult(value: unknown): LayerImageResult {
    const record = isRecord(value) ? value : {};
    const textLayersValue = record.textLayers ?? record.text_layers;
    const textLayers = Array.isArray(textLayersValue) ? textLayersValue.map(normalizeLayerImageTextLayer).filter((layer): layer is LayerImageTextLayer => Boolean(layer)) : [];
    const originalWidth = positiveNumber(pickNumber(record, ["originalWidth", "original_width", "width"]), 1);
    const originalHeight = positiveNumber(pickNumber(record, ["originalHeight", "original_height", "height"]), 1);

    return {
        backgroundDataUrl: pickString(record, ["backgroundDataUrl", "background_url", "backgroundUrl", "background", "bg_url", "bgUrl", "background_image_url", "backgroundImageUrl"]),
        productDataUrl: pickString(record, ["productDataUrl", "product_url", "productUrl", "foreground_url", "foregroundUrl", "product_image_url", "productImageUrl", "subject_url", "subjectUrl"]),
        compositeDataUrl: pickString(record, ["compositeDataUrl", "composite_url", "compositeUrl", "full_image_url", "fullImageUrl", "merged_image_url", "mergedImageUrl", "raster_url", "rasterUrl", "preview_url", "previewUrl"]),
        textLayers,
        originalWidth,
        originalHeight,
        productOffsetX: finiteNumber(pickNumber(record, ["productOffsetX", "product_offset_x"]), 0),
        productOffsetY: finiteNumber(pickNumber(record, ["productOffsetY", "product_offset_y"]), 0),
        productWidth: finiteNumber(pickNumber(record, ["productWidth", "product_width"]), 0),
        productHeight: finiteNumber(pickNumber(record, ["productHeight", "product_height"]), 0),
    };
}

function normalizeLayerImageTextLayer(value: unknown): LayerImageTextLayer | null {
    if (!isRecord(value)) return null;
    const text = pickString(value, ["text", "content"]);
    if (!text) return null;
    const position = isRecord(value.position) ? value.position : value;
    const size = isRecord(value.size) ? value.size : value;
    const width = finiteNumber(pickNumber(size, ["width", "w"]), 0);
    const height = finiteNumber(pickNumber(size, ["height", "h"]), 0);
    return {
        text,
        position: {
            x: finiteNumber(pickNumber(position, ["x", "left"]), 0),
            y: finiteNumber(pickNumber(position, ["y", "top"]), 0),
        },
        size: width > 0 || height > 0 ? { width, height } : undefined,
        fontFamily: pickString(value, ["fontFamily", "font_family"]) || undefined,
        fontWeight: pickString(value, ["fontWeight", "font_weight"]) || undefined,
        fontStyle: pickString(value, ["fontStyle", "font_style"]) || undefined,
        fontSize: positiveNumber(pickNumber(value, ["fontSize", "font_size"]), 14),
        color: pickString(value, ["color", "fill"]) || undefined,
        strokeColor: pickString(value, ["strokeColor", "stroke_color"]) || undefined,
        strokeWidth: finiteNumber(pickNumber(value, ["strokeWidth", "stroke_width"]), 0),
        rotation: finiteNumber(pickNumber(value, ["rotation", "angle"]), 0),
        opacity: finiteNumber(pickNumber(value, ["opacity"]), 1),
    };
}

function pickString(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const value = record[key];
        const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
        if (Number.isFinite(number)) return number;
    }
    return NaN;
}

function finiteNumber(value: number, fallback: number) {
    return Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function referenceToFile(reference: ReferenceImage) {
    if (reference.storageKey?.startsWith("image:")) {
        const blob = await getImageBlob(reference.storageKey);
        if (blob) return new File([blob], reference.name || "reference.png", { type: blob.type || reference.type || "image/png" });
    }

    const directUrl = [reference.dataUrl, reference.url].find((value) => typeof value === "string" && value && !value.startsWith("data:"));
    if (directUrl) {
        try {
            const response = await fetch(directUrl);
            if (response.ok) {
                const blob = await response.blob();
                return new File([blob], reference.name || "reference.png", { type: blob.type || reference.type || "image/png" });
            }
        } catch {}
    }

    const dataUrl = reference.dataUrl.startsWith("data:") ? reference.dataUrl : await imageToDataUrl(reference);
    return dataUrlToFile({ ...reference, dataUrl });
}

export async function requestImageQuestion(config: AiConfig, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
    let buffer = "";
    let answer = "";
    let processedLength = 0;

    try {
        const response = await axios.post(
            aiApiUrl(config, "/chat/completions"),
            {
                model: config.model,
                messages: withSystemMessage(config, messages),
                stream: true,
            },
            {
                headers: {
                    ...aiHeaders(config, "application/json"),
                } as Record<string, string>,
                responseType: "text",
                timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
                onDownloadProgress: (event) => {
                    const responseText = String(event.event?.target?.responseText || "");
                    const nextText = responseText.slice(processedLength);
                    processedLength = responseText.length;
                    buffer += nextText;
                    const chunks = buffer.split("\n\n");
                    buffer = chunks.pop() || "";
                    for (const chunk of chunks) {
                        parseStreamChunk(chunk, (delta) => {
                            answer += delta;
                            onDelta(answer);
                        });
                    }
                },
            },
        );
        if (typeof response.data === "object" && response.data && "code" in response.data && (response.data as { code?: number; msg?: string }).code !== 0) {
            throw new Error((response.data as { msg?: string }).msg || "请求失败");
        }
        if (typeof response.data === "string") {
            let apiError = "";
            try {
                const payload = JSON.parse(response.data) as { code?: number; msg?: string };
                if (typeof payload.code === "number" && payload.code !== 0) {
                    apiError = payload.msg || "请求失败";
                }
            } catch {
                // ignore plain text stream content
            }
            if (apiError) throw new Error(apiError);
        }
        if (buffer) {
            parseStreamChunk(buffer, (delta) => {
                answer += delta;
                onDelta(answer);
            });
        }
    } catch (error) {
        try {
            const fallbackAnswer = await requestImageQuestionNonStream(config, messages);
            if (fallbackAnswer) {
                onDelta(fallbackAnswer);
                answer = fallbackAnswer;
            }
        } catch (fallbackError) {
            throw new Error(readAxiosError(fallbackError, readAxiosError(error, "请求失败")));
        }
    }
    refreshRemoteUser(config);
    return answer || "没有返回内容";
}

export async function fetchImageModels(config: AiConfig) {
    if (config.channelMode === "remote") return config.models;
    try {
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
            timeout: normalizeBoundedInteger(config.timeout, 600, 1, 3600) * 1000,
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}
