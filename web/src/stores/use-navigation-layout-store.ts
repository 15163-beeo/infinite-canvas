import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NavigationPlacement = "top" | "side";

type NavigationLayoutStore = {
    placement: NavigationPlacement;
    sidebarCollapsed: boolean;
    setPlacement: (placement: NavigationPlacement) => void;
    setSidebarCollapsed: (collapsed: boolean) => void;
    togglePlacement: () => void;
    toggleSidebarCollapsed: () => void;
};

export const useNavigationLayoutStore = create<NavigationLayoutStore>()(
    persist(
        (set) => ({
            placement: "top",
            sidebarCollapsed: false,
            setPlacement: (placement) => set({ placement }),
            setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
            togglePlacement: () => set((state) => ({ placement: state.placement === "top" ? "side" : "top" })),
            toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
        }),
        { name: "infinite-canvas:navigation_layout_store" },
    ),
);
