# 安全说明

## 支持范围

当前项目处于快速开发阶段，更适合个人或小团队自托管。安全问题优先处理以下范围：

- 鉴权绕过。
- 管理后台权限问题。
- 用户数据越权读取或删除。
- API Key、S3/R2 Secret 泄露风险。
- 文件上传、对象存储删除相关风险。

## 敏感配置

生产部署前必须修改：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `JWT_SECRET`
- S3/R2 `accessKeyId` 和 `secretAccessKey`

不要把 `.env`、数据库文件、R2 Secret、真实 API Key 提交到仓库。

## 部署建议

- 只对外暴露前端站点端口或域名。
- Go 后端端口建议只监听内网或本机，由 Next.js `/api/*` 代理访问。
- 使用 HTTPS。
- 定期备份 `data/` 和 `.env`。
- Cloudflare R2 建议使用最小权限的 Access Key。

## 报告方式

如果你发现安全问题，请不要直接公开利用细节。可以先通过 GitHub Issue 提供最小复现描述，或联系仓库维护者后再补充敏感细节。
