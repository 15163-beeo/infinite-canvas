export type ReferenceImage = {
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    width?: number;
    height?: number;
    bytes?: number;
    source?: "upload" | "clipboard" | "asset" | "result" | "library" | "workflow";
    assetId?: string;
    temporary?: boolean;
};
