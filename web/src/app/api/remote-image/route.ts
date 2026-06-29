import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024;

function isPrivateIPv4(hostname: string) {
    const parts = hostname.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

function isBlockedHost(hostname: string) {
    const normalized = hostname.toLowerCase();
    if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) return true;
    if (isPrivateIPv4(normalized)) return true;
    return isIP(normalized) === 6 && (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80"));
}

async function assertSafeRemoteImageUrl(rawUrl: string) {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("图片地址无效");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只支持 http/https 图片地址");
    if (isBlockedHost(url.hostname)) throw new Error("不允许读取本地或内网图片地址");
    const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
    if (addresses.some((item) => isBlockedHost(item.address))) throw new Error("图片地址解析到不允许的网络");
    return url.toString();
}

async function fetchSafeRemoteImage(rawUrl: string, redirectCount = 0): Promise<Response> {
    const target = await assertSafeRemoteImageUrl(rawUrl);
    const upstream = await fetch(target, {
        headers: {
            accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
            "user-agent": "Mozilla/5.0 InfiniteCanvasImageProxy/1.0",
        },
        redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = upstream.headers.get("location");
        if (!location || redirectCount >= 5) throw new Error("远程图片跳转无效");
        return fetchSafeRemoteImage(new URL(location, target).toString(), redirectCount + 1);
    }
    return upstream;
}

export async function POST(request: Request) {
    try {
        const body = (await request.json().catch(() => null)) as { url?: string } | null;
        const upstream = await fetchSafeRemoteImage(String(body?.url || ""));
        if (!upstream.ok) {
            return Response.json({ code: 1, msg: `远程图片读取失败：${upstream.status}` }, { status: 502 });
        }
        const contentType = upstream.headers.get("content-type") || "application/octet-stream";
        if (!contentType.toLowerCase().startsWith("image/")) {
            return Response.json({ code: 1, msg: "远程地址不是图片" }, { status: 415 });
        }
        const contentLength = Number(upstream.headers.get("content-length") || "0");
        if (contentLength > MAX_REMOTE_IMAGE_BYTES) {
            return Response.json({ code: 1, msg: "远程图片过大" }, { status: 413 });
        }
        const blob = await upstream.blob();
        if (blob.size > MAX_REMOTE_IMAGE_BYTES) {
            return Response.json({ code: 1, msg: "远程图片过大" }, { status: 413 });
        }
        return new Response(blob, {
            status: 200,
            headers: {
                "content-type": contentType,
                "cache-control": "no-store",
            },
        });
    } catch (error) {
        return Response.json({ code: 1, msg: error instanceof Error ? error.message : "远程图片读取失败" }, { status: 400 });
    }
}
