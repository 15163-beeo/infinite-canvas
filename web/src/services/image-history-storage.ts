"use client";

import localforage from "localforage";
import { useUserStore } from "@/stores/use-user-store";

type StoredHistoryImage = {
    storageKey?: string;
};

type StoredHistoryReference = StoredHistoryImage & {
    temporary?: boolean;
    source?: string;
};

type StoredGenerationLog = {
    images?: StoredHistoryImage[];
    references?: StoredHistoryReference[];
};

const HISTORY_LOG_SCOPE_PREFIX = "scope:";
const HISTORY_CATEGORY_SCOPE_PREFIX = "infinite-canvas:image_generation_categories:";
const imageHistoryLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export async function readStoredImageHistoryStorageKeys() {
    const keys = new Set<string>();
    if (typeof window === "undefined") return keys;
    try {
        const scope = currentImageHistoryScope();
        await imageHistoryLogStore.iterate<StoredGenerationLog, void>((value, key) => {
            if (!isHistoryLogKeyInScope(key, scope)) return;
            collectImageHistoryStorageKeys(value, keys);
        });
    } catch {
        // Ignore browser storage read failures during best-effort cleanup protection.
    }
    return keys;
}

export function collectImageHistoryStorageKeys(log: Partial<StoredGenerationLog>, keys = new Set<string>()) {
    (log.images || []).forEach((image) => {
        if (image.storageKey?.startsWith("image:") || image.storageKey?.startsWith("server:")) keys.add(image.storageKey);
    });
    (log.references || []).forEach((reference) => {
        if (!isDisposableHistoryReference(reference)) return;
        if (reference.storageKey?.startsWith("image:") || reference.storageKey?.startsWith("server:")) keys.add(reference.storageKey);
    });
    return keys;
}

function isDisposableHistoryReference(reference: StoredHistoryReference) {
    return reference.temporary === true || reference.source === "upload" || reference.source === "clipboard";
}

export function currentImageHistoryScope() {
    return useUserStore.getState().user?.id || "guest";
}

export function scopedImageHistoryLogKey(id: string, scope = currentImageHistoryScope()) {
    return `${HISTORY_LOG_SCOPE_PREFIX}${scope}:${id}`;
}

export function isHistoryLogKeyInScope(key: string, scope = currentImageHistoryScope()) {
    return key.startsWith(`${HISTORY_LOG_SCOPE_PREFIX}${scope}:`);
}

export function scopedImageHistoryCategoryKey(scope = currentImageHistoryScope()) {
    return `${HISTORY_CATEGORY_SCOPE_PREFIX}${scope}`;
}
