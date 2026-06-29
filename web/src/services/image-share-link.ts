"use client";

import { imageToDataUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";

export type ShareableImageInput = {
    id?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    shareId?: string;
    shareUrl?: string;
};

export type ImageShareLinkResult = {
    id?: string;
    url: string;
};

export async function ensureImageShareLink(image: ShareableImageInput, fileName = "image.png"): Promise<ImageShareLinkResult> {
    if (image.shareUrl) return { id: image.shareId, url: absoluteUrl(image.shareUrl) };
    if (image.storageKey?.startsWith("server:")) {
        const id = image.storageKey.slice("server:".length);
        return { id, url: absoluteUrl(`/api/files/${encodeURIComponent(id)}/content`) };
    }

    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再生成图片链接");

    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("图片读取失败，无法生成链接");
    const blob = await imageSourceToBlob(dataUrl);
    const formData = new FormData();
    formData.append("file", blob, withImageExtension(fileName, blob.type || image.mimeType || "image/png"));

    const response = await fetch("/api/v1/image-links", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string; data?: { id?: string; url?: string } } | null;
    if (!response.ok || payload?.code !== 0 || !payload.data?.url) {
        throw new Error(payload?.msg || "图片链接生成失败");
    }
    return { id: payload.data.id, url: absoluteUrl(payload.data.url) };
}

function absoluteUrl(url: string) {
    if (/^https?:\/\//i.test(url)) return url;
    if (typeof window === "undefined") return url;
    return new URL(url, window.location.origin).toString();
}

async function imageSourceToBlob(source: string) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
    return response.blob();
}

function withImageExtension(fileName: string, mimeType: string) {
    const cleanName = fileName.trim() || "image";
    if (/\.(png|jpe?g|webp|gif)$/i.test(cleanName)) return cleanName;
    if (mimeType === "image/jpeg") return `${cleanName}.jpg`;
    if (mimeType === "image/webp") return `${cleanName}.webp`;
    if (mimeType === "image/gif") return `${cleanName}.gif`;
    return `${cleanName}.png`;
}
