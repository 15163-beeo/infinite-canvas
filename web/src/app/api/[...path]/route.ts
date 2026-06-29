import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

const PROXY_TIMEOUT_MS = 15 * 60 * 1000;

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

function proxyHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    return headers;
}

function responseHeaders(headersSource: Headers | IncomingHttpHeaders) {
    const headers = new Headers(headersSource instanceof Headers ? headersSource : undefined);
    if (!(headersSource instanceof Headers)) {
        for (const [key, value] of Object.entries(headersSource)) {
            if (Array.isArray(value)) {
                value.forEach((item) => headers.append(key, item));
            } else if (typeof value === "string") {
                headers.set(key, value);
            }
        }
    }
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}

type ProxyResponse = {
    status: number;
    statusText: string;
    headers: Headers;
    body: ReadableStream<Uint8Array>;
};

async function proxyViaNodeRequest(target: string, method: string, headers: Headers, body?: Buffer): Promise<ProxyResponse> {
    const url = new URL(target);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options: RequestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: Object.fromEntries(headers.entries()),
    };

    return await new Promise<ProxyResponse>((resolve, reject) => {
        const upstream = send(options, (response) => {
            resolve({
                status: response.statusCode || 502,
                statusText: response.statusMessage || "",
                headers: responseHeaders(response.headers),
                body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
            });
        });

        upstream.setTimeout(PROXY_TIMEOUT_MS, () => {
            upstream.destroy(new Error(`Proxy upstream timeout after ${PROXY_TIMEOUT_MS}ms`));
        });
        upstream.on("error", reject);

        if (body?.length) upstream.write(body);
        upstream.end();
    });
}

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:18080";
    const target = `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
        const requestBody = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
        const response = await proxyViaNodeRequest(target, request.method, proxyHeaders(request), requestBody);

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } catch (error) {
        console.error("Failed to proxy", target, error);
        return Response.json({ code: 1, data: null, msg: "接口连接失败，请确认后端服务已启动" }, { status: 502 });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
