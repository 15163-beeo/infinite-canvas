"use client";

"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { useUserStore } from "@/stores/use-user-store";

const protectedPrefixes = ["/image", "/workflows", "/video", "/canvas", "/assets", "/asset-library"];

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const isProtectedPage = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

    useEffect(() => {
        if (!isReady || !isProtectedPage || user) return;
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }, [isProtectedPage, isReady, pathname, router, user]);

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            <div className="min-h-0 flex-1 overflow-hidden">{isProtectedPage && (!isReady || !user) ? null : children}</div>
        </div>
    );
}
