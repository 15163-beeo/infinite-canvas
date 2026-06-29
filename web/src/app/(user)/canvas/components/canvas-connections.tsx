import { useState } from "react";
import { Unlink2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

export function ConnectionPath({
    connection,
    from,
    to,
    active,
    onSelect,
    onDelete,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    onSelect: () => void;
    onDelete: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [hovered, setHovered] = useState(false);
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const dx = Math.abs(endX - startX);
    const curvature = Math.max(dx * 0.5, 50);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
    const midPoint = cubicBezierPoint(
        0.5,
        { x: startX, y: startY },
        { x: startX + curvature, y: startY },
        { x: endX - curvature, y: endY },
        { x: endX, y: endY },
    );
    const showDisconnect = active || hovered;

    return (
        <g data-connection-id={connection.id}>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="20"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect();
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 8 : 6}
                strokeOpacity={active ? 0.16 : 0.1}
                strokeLinecap="round"
                fill="none"
                style={{ pointerEvents: "none" }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 4 : 3}
                strokeOpacity={active ? 1 : 0.88}
                strokeLinecap="round"
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
            {showDisconnect ? (
                <foreignObject x={midPoint.x - 17} y={midPoint.y - 17} width={34} height={34} style={{ overflow: "visible", pointerEvents: "auto" }}>
                    <div
                        data-connection-id={connection.id}
                        className="flex h-[34px] w-[34px] items-center justify-center"
                        style={{ pointerEvents: "auto" }}
                        onMouseEnter={() => setHovered(true)}
                        onMouseLeave={() => setHovered(false)}
                    >
                        <button
                            type="button"
                            className="flex h-8 w-8 items-center justify-center rounded-full border shadow-[0_10px_24px_rgba(15,23,42,.18)] transition hover:scale-105"
                            style={{
                                background: "rgba(255,255,255,.96)",
                                borderColor: "rgba(15,23,42,.10)",
                                color: hovered || active ? "#ef4444" : "#475569",
                                pointerEvents: "auto",
                            }}
                            aria-label="断开连线"
                            title="断开连线"
                            onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                            onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onDelete();
                            }}
                        >
                            <Unlink2 className="size-4" />
                        </button>
                    </div>
                </foreignObject>
            ) : null}
        </g>
    );
}

export function ActiveConnectionPath({ node, handle, mouseWorld }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
    const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
    const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
    const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
    const distance = Math.abs(endX - startX);
    const curvature = Math.max(distance * 0.5, 56);
    const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

    return (
        <>
            <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="10" strokeOpacity="0.14" strokeLinecap="round" fill="none" />
            <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="4" strokeOpacity="0.96" strokeLinecap="round" fill="none" strokeDasharray="8 7" />
        </>
    );
}

function cubicBezierPoint(t: number, p0: Position, p1: Position, p2: Position, p3: Position) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    return {
        x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
        y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
    };
}
