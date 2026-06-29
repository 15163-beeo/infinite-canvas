"use client";

import { Menu, PanelLeft, PanelLeftClose, PanelLeftOpen, PanelTop, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { useConfigStore } from "@/stores/use-config-store";
import { useNavigationLayoutStore, type NavigationPlacement } from "@/stores/use-navigation-layout-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";

type AppTopNavProps = {
    hidden?: boolean;
    placement?: NavigationPlacement;
};

export function AppTopNav({ hidden = false, placement = "top" }: AppTopNavProps) {
    const pathname = usePathname();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const navigationPlacement = useNavigationLayoutStore((state) => state.placement);
    const sidebarCollapsed = useNavigationLayoutStore((state) => state.sidebarCollapsed);
    const toggleNavigationPlacement = useNavigationLayoutStore((state) => state.togglePlacement);
    const toggleSidebarCollapsed = useNavigationLayoutStore((state) => state.toggleSidebarCollapsed);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const slug = pathname.split("/").filter(Boolean)[0];
    const activeToolSlug = navigationTools.some((tool) => tool.slug === slug) ? (slug as NavigationToolSlug) : undefined;
    const isSidePlacement = placement === "side";
    const iconButtonClass = "inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const renderUtilityActions = (showNavigationToggle = true, orientation: "horizontal" | "vertical" = "horizontal") => (
        <div className={cn("my-auto flex min-w-0 items-center justify-end justify-self-end whitespace-nowrap", orientation === "vertical" ? "flex-col gap-2" : "h-9 gap-2")}>
            {showNavigationToggle ? <NavigationLayoutToggleButton placement={navigationPlacement} onToggle={toggleNavigationPlacement} className={iconButtonClass} /> : null}
            {isReady && user ? (
                <UserStatusActions orientation={orientation} />
            ) : (
                <>
                    <button type="button" className={iconButtonClass} onClick={() => openConfigDialog(false)} aria-label="配置" title="配置">
                        <Settings2 className="size-4" />
                    </button>
                    <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={iconButtonClass} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
                    <Link href="/login" className={cn("text-sm font-medium text-stone-600 underline-offset-4 transition hover:text-stone-950 hover:underline dark:text-stone-300 dark:hover:text-stone-100", orientation === "vertical" && "px-1 text-xs")}>
                        登录
                    </Link>
                </>
            )}
        </div>
    );

    return (
        <>
            {!hidden && !isSidePlacement ? (
                <header className="sticky top-0 z-20 h-16 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl dark:border-stone-800">
                    <div className="mx-auto flex h-full max-w-7xl items-stretch justify-between gap-5 px-6">
                        <div className="flex min-w-0 items-center">
                            <AppLogo className="h-full" />

                            <button
                                type="button"
                                className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 md:hidden dark:text-stone-300 dark:hover:text-white"
                                onClick={() => setMobileNavOpen(true)}
                                aria-label="打开导航菜单"
                                title="导航菜单"
                            >
                                <Menu className="size-5" />
                            </button>

                            <nav className="hide-scrollbar ml-8 hidden h-16 min-w-0 items-center gap-7 overflow-x-auto md:flex">
                                {navigationTools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeToolSlug;
                                    return (
                                        <Link
                                            key={tool.slug}
                                            href={`/${tool.slug}`}
                                            className={cn(
                                                "relative flex h-16 shrink-0 items-center gap-2 text-sm leading-6 transition after:absolute after:inset-x-0 after:bottom-0 after:h-px",
                                                active
                                                    ? "font-medium text-stone-950 after:bg-stone-950 dark:text-stone-100 dark:after:bg-stone-100"
                                                    : "text-stone-500 after:bg-transparent hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100",
                                            )}
                                        >
                                            <Icon className="size-4" />
                                            <span className="truncate">{tool.label}</span>
                                        </Link>
                                    );
                                })}
                            </nav>
                        </div>

                        {renderUtilityActions()}
                    </div>
                </header>
            ) : null}

            {!hidden && isSidePlacement ? (
                <>
                    <header className="sticky top-0 z-20 h-14 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl md:hidden dark:border-stone-800">
                        <div className="flex h-full items-center justify-between gap-3 px-4">
                            <div className="flex min-w-0 items-center">
                                <AppLogo className="h-14" />
                                <button
                                    type="button"
                                    className="ml-3 inline-flex size-8 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white"
                                    onClick={() => setMobileNavOpen(true)}
                                    aria-label="打开导航菜单"
                                    title="导航菜单"
                                >
                                    <Menu className="size-5" />
                                </button>
                            </div>
                            {renderUtilityActions()}
                        </div>
                    </header>

                    <aside className={cn("hidden h-dvh shrink-0 flex-col border-r border-stone-200 bg-background/95 backdrop-blur-xl transition-[width] duration-200 md:flex dark:border-stone-800", sidebarCollapsed ? "w-16" : "w-60")}>
                        <div className={cn("flex shrink-0 border-b border-stone-200 dark:border-stone-800", sidebarCollapsed ? "h-32 flex-col items-center justify-center gap-2 px-2 py-3" : "h-16 items-center justify-between gap-3 px-4")}>
                            <AppLogo className={sidebarCollapsed ? "h-8 justify-center" : "h-full"} compact={sidebarCollapsed} />
                            <div className={cn("flex shrink-0 items-center", sidebarCollapsed ? "flex-col gap-2" : "gap-1")}>
                                <SidebarCollapseButton collapsed={sidebarCollapsed} onToggle={toggleSidebarCollapsed} className={iconButtonClass} />
                                <NavigationLayoutToggleButton placement={navigationPlacement} onToggle={toggleNavigationPlacement} className={iconButtonClass} />
                            </div>
                        </div>

                        <nav className={cn("thin-scrollbar flex-1 space-y-1 overflow-y-auto py-4", sidebarCollapsed ? "px-2" : "px-3")}>
                            {navigationTools.map((tool) => {
                                const Icon = tool.icon;
                                const active = tool.slug === activeToolSlug;
                                return (
                                    <Link
                                        key={tool.slug}
                                        href={`/${tool.slug}`}
                                        title={sidebarCollapsed ? tool.label : undefined}
                                        aria-label={tool.label}
                                        className={cn(
                                            "flex h-11 items-center rounded-lg text-sm transition",
                                            sidebarCollapsed ? "justify-center px-0" : "gap-3 px-3",
                                            active
                                                ? "bg-stone-100 font-medium text-stone-950 shadow-sm dark:bg-stone-800 dark:text-stone-100"
                                                : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                                        )}
                                    >
                                        <Icon className="size-4 shrink-0" />
                                        {!sidebarCollapsed ? <span className="min-w-0 truncate">{tool.label}</span> : null}
                                    </Link>
                                );
                            })}
                        </nav>

                        <div className={cn("shrink-0 border-t border-stone-200 py-3 dark:border-stone-800", sidebarCollapsed ? "px-2" : "px-3")}>{renderUtilityActions(false, sidebarCollapsed ? "vertical" : "horizontal")}</div>
                    </aside>
                </>
            ) : null}

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={activeToolSlug} onClose={() => setMobileNavOpen(false)} />
            <AppConfigModal />
        </>
    );
}

function AppLogo({ className, compact = false }: { className?: string; compact?: boolean }) {
    return (
        <Link
            href="/"
            className={cn(
                "flex shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300",
                compact && "size-8 justify-center gap-0",
                className,
            )}
            title={compact ? "无限画布" : undefined}
            aria-label="无限画布"
        >
            <span
                className="size-5 shrink-0 bg-current"
                style={{
                    mask: "url(/logo.svg) center / contain no-repeat",
                    WebkitMask: "url(/logo.svg) center / contain no-repeat",
                }}
            />
            {!compact ? <span className="text-base font-medium">无限画布</span> : null}
        </Link>
    );
}

function SidebarCollapseButton({ collapsed, onToggle, className }: { collapsed: boolean; onToggle: () => void; className?: string }) {
    const title = collapsed ? "展开侧边栏" : "收起侧边栏";
    const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

    return (
        <button type="button" className={className} onClick={onToggle} aria-label={title} title={title}>
            <Icon className="size-4" />
        </button>
    );
}

function NavigationLayoutToggleButton({ placement, onToggle, className }: { placement: NavigationPlacement; onToggle: () => void; className?: string }) {
    const nextPlacement = placement === "top" ? "side" : "top";
    const title = nextPlacement === "side" ? "切换到侧边导航" : "切换到顶部导航";
    const Icon = nextPlacement === "side" ? PanelLeft : PanelTop;

    return (
        <button type="button" className={className} onClick={onToggle} aria-label={title} title={title}>
            <Icon className="size-4" />
        </button>
    );
}
