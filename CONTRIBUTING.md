# 贡献指南

感谢你关注无限画布。本仓库是基于 `basketikun/infinite-canvas` 的二次开发版本，继续遵循 AGPL-3.0 协议。

## 开发环境

推荐本地非 Docker 开发：

```bash
cp .env.example .env
go run .
```

另开一个终端：

```bash
cd web
npm install
npm run dev
```

默认地址：

- 前端：`http://localhost:13000`
- 后端：`http://localhost:18080`

## 提交前检查

```bash
cd web
npx tsc --noEmit
```

```bash
go test ./...
```

## Pull Request 要求

- 描述这次变更解决的问题和主要方案。
- UI 变更请附截图或录屏。
- 涉及数据库、配置、部署或接口时，同步更新 `docs/`。
- 不要提交真实 API Key、R2 Secret、数据库文件或本地生成文件。

## 二次开发说明

如果你基于本仓库继续 fork：

- 保留原作者和本仓库的协议声明。
- 使用当前源码或自己的镜像部署，不要直接使用原作者镜像。
- 涉及公开服务时请自行配置管理员账号、JWT 密钥和对象存储权限。
