"use client";

import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { canUploadImagesToServer, cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";
import { fetchUserAssetData, syncUserAssetData } from "@/services/api/user-config";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string; shareId?: string; shareUrl?: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    hydrateAccountAssets: (token: string) => Promise<void>;
    syncAccountAssets: (token: string) => Promise<void>;
    stopAccountAssetSync: () => void;
    cleanupImages: (extra?: unknown, deleteCandidates?: unknown) => void;
};

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
let activeAssetSyncToken = "";
let isHydratingAccountAssets = false;
let syncTimer: number | null = null;

type AssetSnapshot = { assets: Asset[] };

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(parsed.state.assets.map(normalizeAsset));
        return parsed;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                scheduleAssetSync(get);
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => {
                    const assets = state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset));
                    window.setTimeout(() => scheduleAssetSync(get), 0);
                    return { assets };
                }),
            removeAsset: (id) => {
                let removedAsset: Asset | undefined;
                set((state) => {
                    removedAsset = state.assets.find((asset) => asset.id === id);
                    return { assets: state.assets.filter((asset) => asset.id !== id) };
                });
                get().cleanupImages(undefined, removedAsset);
                window.setTimeout(() => scheduleAssetSync(get), 0);
            },
            hydrateAccountAssets: async (token) => {
                if (!token) return;
                activeAssetSyncToken = token;
                isHydratingAccountAssets = true;
                try {
                    const remote = await fetchUserAssetData<AssetSnapshot>(token);
                    const remoteAssets = Array.isArray(remote?.assets) ? await Promise.all(remote.assets.map(normalizeAsset)) : [];
                    if (remoteAssets.length) {
                        set((state) => ({ assets: mergeAssets(remoteAssets, state.assets) }));
                        window.setTimeout(() => {
                            if (activeAssetSyncToken === token) void get().syncAccountAssets(token).catch(() => {});
                        }, 0);
                    } else if (get().assets.length) {
                        await syncUserAssetData(token, { assets: get().assets });
                    }
                } finally {
                    isHydratingAccountAssets = false;
                }
            },
            syncAccountAssets: async (token) => {
                if (!token) return;
                await syncUserAssetData(token, { assets: get().assets });
            },
            stopAccountAssetSync: () => {
                activeAssetSyncToken = "";
                if (syncTimer) window.clearTimeout(syncTimer);
                syncTimer = null;
            },
            cleanupImages: (extra, deleteCandidates) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
                    await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra }, deleteCandidates);
                    await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
        },
    ),
);

function scheduleAssetSync(get: () => AssetStore) {
    if (isHydratingAccountAssets || !activeAssetSyncToken || typeof window === "undefined") return;
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        void get().syncAccountAssets(activeAssetSyncToken).catch(() => {});
    }, 600);
}

function mergeAssets(remoteAssets: Asset[], localAssets: Asset[]) {
    const records = new Map<string, Asset>();
    [...localAssets, ...remoteAssets].forEach((asset) => {
        const previous = records.get(asset.id);
        if (!previous || Date.parse(asset.updatedAt || "") >= Date.parse(previous.updatedAt || "")) {
            records.set(asset.id, asset);
        }
    });
    return Array.from(records.values()).sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
}

async function normalizeAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "video") {
        if (!asset.data.storageKey) return asset;
        return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
    }
    if (asset.kind !== "image") return asset;
    if (asset.data.storageKey) {
        const resolvedDataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl || asset.coverUrl || "");
        if (asset.data.storageKey.startsWith("image:") && resolvedDataUrl && (await canUploadImagesToServer())) {
            try {
                const image = await uploadImage(resolvedDataUrl);
                if (image.storageKey.startsWith("server:")) {
                    return {
                        ...asset,
                        coverUrl: !asset.coverUrl || asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl,
                        data: {
                            ...asset.data,
                            dataUrl: image.url,
                            storageKey: image.storageKey,
                            width: asset.data.width || image.width,
                            height: asset.data.height || image.height,
                            bytes: image.bytes,
                            mimeType: image.mimeType,
                        },
                    };
                }
            } catch {
                // Keep the existing local reference when the old browser blob is no longer available.
            }
        }
        return {
            ...asset,
            coverUrl: !asset.coverUrl || asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:image/") ? resolvedDataUrl || asset.coverUrl : asset.coverUrl,
            data: { ...asset.data, dataUrl: resolvedDataUrl || asset.data.dataUrl },
        };
    }
    if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
    const image = await uploadImage(asset.data.dataUrl);
    return {
        ...asset,
        coverUrl: !asset.coverUrl || asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl,
        data: {
            ...asset.data,
            dataUrl: image.url,
            storageKey: image.storageKey,
            width: asset.data.width || image.width,
            height: asset.data.height || image.height,
            bytes: image.bytes,
            mimeType: image.mimeType,
        },
    };
}
