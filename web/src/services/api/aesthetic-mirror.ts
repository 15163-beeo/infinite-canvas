"use client";

import { apiGet, apiPost } from "@/services/api/request";

export type AestheticMirrorJobImagePayload = {
    name: string;
    type: string;
    storageKey?: string;
    dataUrl?: string;
};

export type AestheticMirrorJobPayload = {
    mode?: "aesthetic_mirror" | "sku_replace";
    prompt?: string;
    promptTemplate?: string;
    extraPrompt?: string;
    userPrompt?: string;
    skuText?: string;
    model: string;
    channelId: string;
    aspectRatio?: string;
    imageSize?: string;
    size?: string;
    quality: string;
    outputFormat: "png" | "jpeg" | "webp";
    referenceImage: AestheticMirrorJobImagePayload;
    productImages: AestheticMirrorJobImagePayload[];
    metadata: {
        referenceIndex: number;
        groupIndex: number;
        skuIndex?: number;
        skuName?: string;
        isBatch?: boolean;
        runId?: string;
    };
};

export type AestheticMirrorJob = {
    id: string;
    mode?: "aesthetic_mirror" | "sku_replace";
    status: "queued" | "running" | "success" | "failed";
    phase: "queued" | "analyzing" | "generating" | "success" | "failed";
    referenceIndex: number;
    groupIndex: number;
    skuIndex?: number;
    skuName?: string;
    resolvedPrompt?: string;
    requestedAspectRatio?: string;
    requestedImageSize?: string;
    resolvedUpstreamSize?: string;
    actualSize?: string;
    width?: number;
    height?: number;
    imageDataUrl?: string;
    error?: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
};

export function createAestheticMirrorJob(payload: AestheticMirrorJobPayload, token: string) {
    return apiPost<AestheticMirrorJob>("/api/v1/aesthetic-mirror/jobs", payload, token);
}

export function fetchAestheticMirrorJob(id: string, token: string) {
    return apiGet<AestheticMirrorJob>(`/api/v1/aesthetic-mirror/jobs/${encodeURIComponent(id)}`, undefined, token);
}
