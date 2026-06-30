"use client";

import { apiGet, apiPost } from "@/services/api/request";

export type AestheticMirrorJobImagePayload = {
    name: string;
    type: string;
    storageKey?: string;
    dataUrl?: string;
};

export type AestheticMirrorJobPayload = {
    prompt: string;
    promptTemplate?: string;
    extraPrompt?: string;
    model: string;
    channelId: string;
    size: string;
    quality: string;
    outputFormat: "png" | "jpeg" | "webp";
    referenceImage: AestheticMirrorJobImagePayload;
    productImages: AestheticMirrorJobImagePayload[];
    metadata: {
        referenceIndex: number;
        groupIndex: number;
    };
};

export type AestheticMirrorJob = {
    id: string;
    status: "queued" | "running" | "success" | "failed";
    referenceIndex: number;
    groupIndex: number;
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
