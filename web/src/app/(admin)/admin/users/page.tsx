"use client";

import { CopyOutlined, DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Avatar, Button, Card, Col, Divider, Flex, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";

import type { AdminInviteCode, AdminUser } from "@/services/api/admin";
import { useAdminUsers } from "./use-admin-users";

type UserFormValues = Partial<AdminUser> & { password?: string };
type InviteCodeFormValues = { count: number; remark?: string };

const roleOptions = [
    { label: "普通用户", value: "user" },
    { label: "管理员", value: "admin" },
];

const statusOptions = [
    { label: "正常", value: "active" },
    { label: "禁用", value: "ban" },
];

export default function AdminUsersPage() {
    const { users, inviteCodes, keyword, page, pageSize, total, isLoading, searchUsers, changePage, changePageSize, resetFilters, refreshUsers, refreshInviteCodes, saveUser: saveAdminUser, adjustCredits, setUserStatus, deleteUser, generateInviteCodes, setInviteCodeStatus } = useAdminUsers();
    const [form] = Form.useForm<UserFormValues>();
    const [inviteCodeForm] = Form.useForm<InviteCodeFormValues>();
    const [keywordText, setKeywordText] = useState(keyword);
    const [editingUser, setEditingUser] = useState<Partial<AdminUser> | null>(null);
    const [deletingUser, setDeletingUser] = useState<AdminUser | null>(null);

    useEffect(() => setKeywordText(keyword), [keyword]);

    useEffect(() => {
        if (editingUser) form.setFieldsValue({ role: "user", status: "active", ...editingUser, password: "" });
    }, [editingUser, form]);

    const saveUser = async () => {
        const value = await form.validateFields();
        const userValue = { ...value };
        delete userValue.credits;
        await saveAdminUser({ ...editingUser, ...userValue, password: value.password || undefined });
        setEditingUser(null);
    };

    const saveCredits = async () => {
        if (!editingUser?.id) return;
        await adjustCredits(editingUser.id, form.getFieldValue("credits") || 0);
    };

    const submitInviteCodes = async () => {
        const value = await inviteCodeForm.validateFields();
        await generateInviteCodes(Number(value.count) || 1, value.remark || "");
        inviteCodeForm.setFieldsValue({ count: value.count, remark: value.remark });
    };

    const columns: ProColumns<AdminUser>[] = [
        {
            title: "用户",
            dataIndex: "username",
            width: 260,
            render: (_, item) => (
                <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                    <Avatar src={item.avatarUrl || undefined}>{(item.displayName || item.username || "U").slice(0, 1).toUpperCase()}</Avatar>
                    <Flex vertical style={{ minWidth: 0 }}>
                        <Typography.Text strong ellipsis>
                            {item.displayName || item.username}
                        </Typography.Text>
                        <Typography.Text type="secondary" ellipsis>
                            {item.username}
                        </Typography.Text>
                    </Flex>
                </Flex>
            ),
        },
        {
            title: "角色",
            dataIndex: "role",
            width: 100,
            render: (_, item) => <Tag color={item.role === "admin" ? "gold" : "default"}>{item.role === "admin" ? "管理员" : "用户"}</Tag>,
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (_, item) => <Tag color={item.status === "ban" ? "red" : "green"}>{item.status === "ban" ? "禁用" : "正常"}</Tag>,
        },
        {
            title: "算力点",
            dataIndex: "credits",
            width: 100,
            render: (_, item) => <Typography.Text>{item.credits}</Typography.Text>,
        },
        {
            title: "Linux.do",
            dataIndex: "linuxDoId",
            width: 140,
            render: (_, item) => <Typography.Text type="secondary">{item.linuxDoId || "-"}</Typography.Text>,
        },
        {
            title: "最近登录",
            dataIndex: "lastLoginAt",
            width: 180,
            render: (_, item) => <Typography.Text type="secondary">{item.lastLoginAt ? dayjs(item.lastLoginAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Typography.Text>,
        },
        {
            title: "操作",
            key: "actions",
            width: 180,
            align: "right",
            render: (_, item) => (
                <Space size={4}>
                    <Tooltip title={item.status === "ban" ? "启用" : "禁用"}>
                        <Button
                            type="text"
                            size="small"
                            icon={item.status === "ban" ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                            onClick={() => void setUserStatus(item.id, item.status === "ban" ? "active" : "ban")}
                        />
                    </Tooltip>
                    <Tooltip title="编辑">
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingUser(item)} />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingUser(item)} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    const inviteColumns = [
        {
            title: "邀请码",
            dataIndex: "code",
            width: 220,
            render: (_: unknown, item: AdminInviteCode) => (
                <Typography.Text copyable={{ text: item.code, icon: <CopyOutlined /> }} strong>
                    {item.code}
                </Typography.Text>
            ),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 110,
            render: (_: unknown, item: AdminInviteCode) => {
                if (item.status === "used") return <Tag color="green">已使用</Tag>;
                if (item.status === "disabled") return <Tag color="red">已停用</Tag>;
                return <Tag color="blue">未使用</Tag>;
            },
        },
        {
            title: "使用人",
            dataIndex: "usedByName",
            width: 140,
            render: (_: unknown, item: AdminInviteCode) => <Typography.Text type="secondary">{item.usedByName || "-"}</Typography.Text>,
        },
        {
            title: "备注",
            dataIndex: "remark",
            render: (_: unknown, item: AdminInviteCode) => <Typography.Text type="secondary">{item.remark || "-"}</Typography.Text>,
        },
        {
            title: "生成时间",
            dataIndex: "createdAt",
            width: 180,
            render: (_: unknown, item: AdminInviteCode) => <Typography.Text type="secondary">{item.createdAt ? dayjs(item.createdAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Typography.Text>,
        },
        {
            title: "操作",
            key: "actions",
            width: 120,
            align: "right" as const,
            render: (_: unknown, item: AdminInviteCode) =>
                item.status === "used" ? (
                    <Typography.Text type="secondary">已锁定</Typography.Text>
                ) : (
                    <Button size="small" onClick={() => void setInviteCodeStatus(item.id, item.status === "disabled" ? "unused" : "disabled")}>
                        {item.status === "disabled" ? "恢复" : "停用"}
                    </Button>
                ),
        },
    ];

    return (
        <main className="p-3 md:p-6">
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Flex vertical gap={16}>
                        <Flex align="center" justify="space-between" gap={12} wrap>
                            <Space>
                                <Typography.Text strong>邀请码</Typography.Text>
                                <Tag>{inviteCodes.length} 条</Tag>
                            </Space>
                            <Button icon={<ReloadOutlined />} onClick={() => void refreshInviteCodes()}>
                                刷新邀请码
                            </Button>
                        </Flex>
                        <Form form={inviteCodeForm} layout="vertical" initialValues={{ count: 5, remark: "" }} requiredMark={false}>
                            <Row gutter={16} align="bottom">
                                <Col flex="140px">
                                    <Form.Item name="count" label="生成数量" rules={[{ required: true, message: "请输入数量" }]}>
                                        <InputNumber min={1} max={50} precision={0} style={{ width: "100%" }} />
                                    </Form.Item>
                                </Col>
                                <Col flex="320px">
                                    <Form.Item name="remark" label="备注">
                                        <Input placeholder="例如：测试组、运营组、内部试用" />
                                    </Form.Item>
                                </Col>
                                <Col flex="none">
                                    <Form.Item>
                                        <Button type="primary" onClick={() => void submitInviteCodes()}>
                                            生成邀请码
                                        </Button>
                                    </Form.Item>
                                </Col>
                            </Row>
                        </Form>
                        <Table<AdminInviteCode>
                            rowKey="id"
                            size="small"
                            pagination={false}
                            columns={inviteColumns}
                            dataSource={inviteCodes}
                            scroll={{ x: 860 }}
                        />
                    </Flex>
                </Card>
                <Card variant="borderless">
                    <Form layout="vertical">
                        <Row gutter={16} align="bottom">
                            <Col flex="360px">
                                <Form.Item label="关键词">
                                    <Input.Search
                                        value={keywordText}
                                        placeholder="搜索用户名、昵称、邮箱或 Linux.do ID"
                                        allowClear
                                        enterButton={<SearchOutlined />}
                                        onSearch={() => searchUsers(keywordText)}
                                        onChange={(event) => setKeywordText(event.target.value)}
                                    />
                                </Form.Item>
                            </Col>
                            <Col flex="none">
                                <Form.Item>
                                    <Space>
                                        <Button
                                            onClick={() => {
                                                setKeywordText("");
                                                resetFilters();
                                            }}
                                        >
                                            重置
                                        </Button>
                                        <Button type="primary" icon={<ReloadOutlined />} onClick={() => searchUsers(keywordText)}>
                                            查询
                                        </Button>
                                    </Space>
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>
                <ProTable<AdminUser>
                    rowKey="id"
                    columns={columns}
                    dataSource={users}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    scroll={{ x: 980 }}
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>用户列表</Typography.Text>
                            <Tag>{total} 人</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refreshUsers() }}
                    toolBarRender={() => [
                        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditingUser({ role: "user", status: "active" })}>
                            新增
                        </Button>,
                    ]}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 50, 100],
                        showTotal: (value) => `共 ${value} 人`,
                        onChange: (nextPage, nextPageSize) => (nextPageSize !== pageSize ? changePageSize(nextPageSize) : changePage(nextPage)),
                    }}
                />
            </Flex>

            <Modal title={editingUser?.id ? "编辑用户" : "新增用户"} open={Boolean(editingUser)} width={680} onCancel={() => setEditingUser(null)} onOk={() => void saveUser()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Typography.Text strong>基础信息</Typography.Text>
                    <Row gutter={14}>
                        <Col span={12}>
                            <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="password" label={editingUser?.id ? "新密码" : "密码"} rules={editingUser?.id ? [] : [{ required: true, message: "请输入密码" }]}>
                                <Input.Password autoComplete="new-password" />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="displayName" label="昵称">
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="email" label="邮箱">
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
                                <Select options={roleOptions} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="status" label="状态" rules={[{ required: true, message: "请选择状态" }]}>
                                <Select options={statusOptions} />
                            </Form.Item>
                        </Col>
                    </Row>
                    {editingUser?.id ? (
                        <>
                            <Divider style={{ margin: "4px 0 16px" }} />
                            <Typography.Text strong>算力点调整</Typography.Text>
                            <Row gutter={14}>
                                <Col span={12}>
                                    <Form.Item label="算力点">
                                        <Space.Compact style={{ width: "100%" }}>
                                            <Form.Item name="credits" noStyle>
                                                <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                                            </Form.Item>
                                            <Button onClick={() => void saveCredits()}>调整</Button>
                                        </Space.Compact>
                                    </Form.Item>
                                </Col>
                            </Row>
                        </>
                    ) : null}
                </Form>
            </Modal>

            <Modal
                title="删除用户"
                open={Boolean(deletingUser)}
                onCancel={() => setDeletingUser(null)}
                onOk={async () => {
                    if (!deletingUser) return;
                    await deleteUser(deletingUser.id);
                    setDeletingUser(null);
                }}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定删除「{deletingUser?.displayName || deletingUser?.username}」吗？删除后该账号将无法继续登录。
            </Modal>
        </main>
    );
}
