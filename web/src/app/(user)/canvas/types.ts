export type Position = {
    x: number;
    y: number;
};

export type CanvasImageRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeMetadata = {
    content?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    startedAt?: number;
    durationMs?: number;
    fontSize?: number;
    textColor?: string;
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
    textStrokeColor?: string;
    textStrokeWidth?: number;
    textOpacity?: number;
    rotation?: number;
    layerText?: boolean;
    layerGroupId?: string;
    boundGroupId?: string;
    layerSourceId?: string;
    layerRole?: "background" | "product" | "text";
    mergedLayer?: boolean;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    imageChannelId?: string;
    videoChannelId?: string;
    textChannelId?: string;
    size?: string;
    quality?: string;
    outputFormat?: "png" | "jpeg" | "webp";
    outputCompression?: string;
    moderation?: "auto" | "low";
    count?: number;
    seconds?: string;
    vquality?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    removeBackground?: boolean;
    hidePromptPanel?: boolean;
    removeBackgroundVersion?: number;
    removeBackgroundSourceWidth?: number;
    removeBackgroundSourceHeight?: number;
    removeBackgroundSourceNaturalWidth?: number;
    removeBackgroundSourceNaturalHeight?: number;
    removeBackgroundOriginalWidth?: number;
    removeBackgroundOriginalHeight?: number;
    removeBackgroundProductOffsetX?: number;
    removeBackgroundProductOffsetY?: number;
    removeBackgroundProductWidth?: number;
    removeBackgroundProductHeight?: number;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    inputOrder?: string[];
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    skipInitialStorageUpload?: boolean;
    editSourceNodeId?: string;
    editMaskRect?: CanvasImageRect;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
    source?: "node" | "asset" | "library";
    assetId?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant";
    mode: "ask" | "image";
    text: string;
    isLoading?: boolean;
    references?: CanvasAssistantReference[];
    images?: CanvasAssistantImage[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState = {
    type: "node";
    x: number;
    y: number;
    nodeId: string;
};
