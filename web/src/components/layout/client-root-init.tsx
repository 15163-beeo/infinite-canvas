"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { fetchUserConfig } from "@/services/api/user-config";
import { defaultUserStorageProvider, saveUserStorageProvider } from "@/services/image-storage";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const hydrateAccountAssets = useAssetStore((state) => state.hydrateAccountAssets);
    const stopAccountAssetSync = useAssetStore((state) => state.stopAccountAssetSync);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";
    const isStaticDemoPage = pathname === "/image-workbench-version-demo" || pathname === "/image/version-demo";

    useEffect(() => {
        if (isStaticDemoPage) return;
        void loadPublicSettings();
    }, [isStaticDemoPage, loadPublicSettings]);

    useEffect(() => {
        if (!isLoginPage && !isStaticDemoPage) void hydrateUser();
    }, [hydrateUser, isLoginPage, isStaticDemoPage]);

    useEffect(() => {
        if (token && user?.id) {
            void hydrateAccountAssets(token);
            void fetchUserConfig(token)
                .then((payload) => {
                    if (payload.modelConfig) {
                        Object.entries(payload.modelConfig).forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                    }
                    if (payload.storageProvider) {
                        const next = { ...defaultUserStorageProvider(), ...payload.storageProvider, enabled: true };
                        saveUserStorageProvider(next);
                    }
                })
                .catch(() => {});
            return;
        }
        stopAccountAssetSync();
    }, [hydrateAccountAssets, stopAccountAssetSync, token, user?.id, updateConfig]);

    return <>{children}</>;
}
