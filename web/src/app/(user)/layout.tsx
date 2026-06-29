"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { cn } from "@/lib/utils";
import { useNavigationLayoutStore } from "@/stores/use-navigation-layout-store";
import { useUserStore } from "@/stores/use-user-store";

const protectedPrefixes = ["/image", "/aesthetic-mirror", "/workflows", "/video", "/canvas", "/assets", "/asset-library"];
const publicPaths = ["/image/version-demo"];

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const navigationPlacement = useNavigationLayoutStore((state) => state.placement);
    const isPublicPath = publicPaths.includes(pathname);
    const isProtectedPage = !isPublicPath && protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    const hideWorkspaceChrome = /^\/canvas\/[^/]+/.test(pathname);
    const effectiveNavigationPlacement = hideWorkspaceChrome ? "top" : navigationPlacement;

    useEffect(() => {
        if (!isReady || !isProtectedPage || user) return;
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }, [isProtectedPage, isReady, pathname, router, user]);

    return (
        <div className={cn("flex h-dvh overflow-hidden bg-background text-foreground", effectiveNavigationPlacement === "side" ? "flex-col md:flex-row" : "flex-col")}>
            <AppTopNav hidden={hideWorkspaceChrome} placement={effectiveNavigationPlacement} />
            <div className="min-h-0 flex-1 overflow-hidden">{isProtectedPage && (!isReady || !user) ? null : children}</div>
        </div>
    );
}
