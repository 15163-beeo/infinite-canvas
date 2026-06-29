import { FileText, ImagePlus, Images, Maximize2, Video, WandSparkles } from "lucide-react";
import { promptLibraryEnabled } from "./feature-flags";

const allNavigationTools = [
    {
        slug: "canvas",
        label: "我的画布",
        icon: Maximize2,
    },
    {
        slug: "image",
        label: "生图工作台",
        icon: ImagePlus,
    },
    {
        slug: "aesthetic-mirror",
        label: "爆款复刻",
        icon: WandSparkles,
    },
    {
        slug: "video",
        label: "视频创作台",
        icon: Video,
    },
    {
        slug: "prompts",
        label: "提示词库",
        icon: FileText,
    },
    {
        slug: "assets",
        label: "我的素材",
        icon: Images,
    },
] as const;

export const navigationTools = allNavigationTools.filter((tool) => promptLibraryEnabled || tool.slug !== "prompts");

export type NavigationToolSlug = (typeof allNavigationTools)[number]["slug"];
