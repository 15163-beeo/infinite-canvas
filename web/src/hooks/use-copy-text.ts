"use client";

import { App } from "antd";
import copy from "copy-to-clipboard";

export function useCopyText() {
    const { message } = App.useApp();

    return async (value: string, successText = "已复制") => {
        try {
            if (await copy(value)) {
                message.success(successText);
                return true;
            }
        } catch {}
        message.error("复制失败，请手动复制");
        return false;
    };
}
