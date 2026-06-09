"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import {
    adjustAdminUserCredits,
    deleteAdminUser,
    fetchAdminInviteCodes,
    fetchAdminUsers,
    generateAdminInviteCodes,
    saveAdminUser,
    setAdminInviteCodeStatus,
    setAdminUserStatus,
    type AdminInviteCodeStatus,
    type AdminUser,
} from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export function useAdminUsers() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const clearSession = useUserStore((state) => state.clearSession);
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(defaultPageSize);

    const query = useQuery({
        queryKey: ["admin", "users", token, keyword, page, pageSize],
        queryFn: () => fetchAdminUsers(token, { keyword, page, pageSize }),
        enabled: Boolean(token),
        retry: false,
    });

    const inviteCodeQuery = useQuery({
        queryKey: ["admin", "invite-codes", token],
        queryFn: () => fetchAdminInviteCodes(token, { page: 1, pageSize: 20 }),
        enabled: Boolean(token),
        retry: false,
    });

    const saveMutation = useMutation({
        mutationFn: (user: Partial<AdminUser> & { password?: string }) => saveAdminUser(token, user),
        onSuccess: async (_, user) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success(user.id ? "用户已保存" : "用户已新增");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteAdminUser(token, id),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success("用户已删除");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
    });

    const creditMutation = useMutation({
        mutationFn: ({ id, credits }: { id: string; credits: number }) => adjustAdminUserCredits(token, id, credits),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success("算力点已调整");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "调整失败"),
    });

    const statusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: AdminUser["status"] }) => setAdminUserStatus(token, id, status),
        onSuccess: async (_, payload) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
            message.success(payload.status === "ban" ? "用户已禁用" : "用户已启用");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "状态更新失败"),
    });

    const generateInviteMutation = useMutation({
        mutationFn: ({ count, remark }: { count: number; remark?: string }) => generateAdminInviteCodes(token, count, remark || ""),
        onSuccess: async (items) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "invite-codes"] });
            message.success(`已生成 ${items.length} 个邀请码`);
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "生成邀请码失败"),
    });

    const inviteStatusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: AdminInviteCodeStatus }) => setAdminInviteCodeStatus(token, id, status),
        onSuccess: async (_, payload) => {
            await queryClient.invalidateQueries({ queryKey: ["admin", "invite-codes"] });
            message.success(payload.status === "disabled" ? "邀请码已停用" : "邀请码已恢复");
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "邀请码状态更新失败"),
    });

    useEffect(() => {
        if (query.isError || inviteCodeQuery.isError) {
            const queryError = query.isError ? query.error : inviteCodeQuery.error;
            const errorMessage = queryError instanceof Error ? queryError.message : "读取后台数据失败";
            message.error(errorMessage);
            if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) clearSession();
        }
    }, [clearSession, inviteCodeQuery.error, inviteCodeQuery.isError, message, query.error, query.isError]);

    const updateFilters = (next: Partial<{ keyword: string; page: number; pageSize: number }>) => {
        const queryState = { keyword, page, pageSize, ...next };
        if (next.keyword !== undefined || next.pageSize !== undefined) queryState.page = 1;
        setKeyword(queryState.keyword);
        setPage(queryState.page);
        setPageSize(queryState.pageSize);
    };

    const data = query.data;

    return {
        users: data?.items || [],
        inviteCodes: inviteCodeQuery.data?.items || [],
        keyword,
        page,
        pageSize,
        total: data?.total || 0,
        isLoading:
            query.isFetching ||
            inviteCodeQuery.isFetching ||
            saveMutation.isPending ||
            deleteMutation.isPending ||
            creditMutation.isPending ||
            statusMutation.isPending ||
            generateInviteMutation.isPending ||
            inviteStatusMutation.isPending,
        searchUsers: (value = keyword) => updateFilters({ keyword: value }),
        changePage: (value: number) => updateFilters({ page: value }),
        changePageSize: (value: number) => updateFilters({ pageSize: value }),
        resetFilters: () => updateFilters({ keyword: "", page: 1, pageSize: defaultPageSize }),
        refreshUsers: () => query.refetch(),
        saveUser: (user: Partial<AdminUser> & { password?: string }) => saveMutation.mutateAsync(user),
        adjustCredits: (id: string, credits: number) => creditMutation.mutateAsync({ id, credits }),
        setUserStatus: (id: string, status: AdminUser["status"]) => statusMutation.mutateAsync({ id, status }),
        deleteUser: (id: string) => deleteMutation.mutateAsync(id),
        refreshInviteCodes: () => inviteCodeQuery.refetch(),
        generateInviteCodes: (count: number, remark?: string) => generateInviteMutation.mutateAsync({ count, remark }),
        setInviteCodeStatus: (id: string, status: AdminInviteCodeStatus) => inviteStatusMutation.mutateAsync({ id, status }),
    };
}
