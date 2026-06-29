# Error Log

## [ERR-20260610-001] powershell_path_parentheses

**Logged**: 2026-06-10T12:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
PowerShell treated an unquoted path segment containing `(user)` as syntax while running `git diff`.

### Error
```text
The term 'user\' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

### Context
- Command attempted: `git diff -- ... web\src\app\(user\)\canvas\[id]\canvas-client-page.tsx ...`
- Recurring example: `rg ... web/src/app/(user)/canvas` failed because PowerShell parsed `(user)` instead of treating it as a path.
- PowerShell requires paths containing parentheses to be quoted or passed as literal arguments.

### Suggested Fix
Use quoted paths, `--%`, or run `git diff -- 'path-with-(parentheses)'` in PowerShell.

### Metadata
- Reproducible: yes
- Related Files: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`

---

## [ERR-20260626-003] server_deploy_ssh_auth_failed

**Logged**: 2026-06-26T17:50:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary
Deployment to `192.168.10.128` is blocked because SSH requires credentials and no usable key or password helper is available in this session.

### Error
```text
admin123@192.168.10.128: Permission denied (publickey,password).
root@192.168.10.128: Permission denied (publickey,password).
```

### Context
- Target ports are reachable: `22` and `13001`.
- `http://192.168.10.128:13001/aesthetic-mirror` currently returns `404`, so the server appears to run an older build without the new route.
- Prepared clean deployment archive: `.local/deploy-src-aesthetic-mirror-clean-20260626-174924.tgz`.
- Local machine has `ssh.exe`, `scp.exe`, and `tar.exe`, but no `sshpass`, `plink`, `pscp`, or `winscp.com`.

### Suggested Fix
Provide a working SSH credential/key for the server, or use GitHub push plus a server-side pull/rebuild path if the server is configured for that workflow.

### Metadata
- Reproducible: yes
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`

### Resolution
- **Resolved**: 2026-06-26T17:59:00+08:00
- **Notes**: User provided SSH password; deployed through Paramiko SFTP/SSH, rebuilt `infinite-canvas-13001`, and verified `/aesthetic-mirror` plus `/api/health`.

---

## [ERR-20260626-004] remote_source_backup_too_broad

**Logged**: 2026-06-26T17:59:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary
Remote pre-deploy source backup was too broad and started creating a multi-GB tarball.

### Error
```text
/home/admin123/apps/infinite-canvas-backup-20260626-175326.tgz reached 1.9G while tar was still running.
```

### Context
- Operation attempted: backup `/home/admin123/apps/infinite-canvas` before extracting a clean deployment archive.
- The exclude list omitted large local/project artifact directories on the server.
- The backup was unnecessary because the deploy only needed to preserve `.env`, compose files, and data volume.

### Suggested Fix
For this server, do not create full source tar backups before normal Docker rebuild deploys. Preserve only `.env`, `docker-compose.server.yml`, `docker-compose.yml`, and rely on the uploaded source archive plus Git history for code recovery.

### Metadata
- Reproducible: yes
- Related Files: `docker-compose.server.yml`

### Resolution
- **Resolved**: 2026-06-26T17:59:00+08:00
- **Notes**: Killed the tar process, removed the incomplete 1.9GB backup, created a small config-only backup, then deployed successfully.

---

## [ERR-20260626-002] powershell_grouped_route_path_unquoted

**Logged**: 2026-06-26T17:33:37+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
PowerShell treated `(user)` in an unquoted Next.js grouped route path as an expression, causing an `rg` command to fail.

### Error
```text
The term 'user' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

### Context
- Operation attempted: search `web/src/app/(user)/aesthetic-mirror/page.tsx` with `rg`.
- Environment: Windows PowerShell in `E:\image\infinite-canvas`.
- Cause: the route group path was not quoted.

### Suggested Fix
Always quote paths containing parentheses in PowerShell, for example: `rg -n "pattern" 'web/src/app/(user)/aesthetic-mirror/page.tsx'`.

### Metadata
- Reproducible: yes
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`

### Resolution
- **Resolved**: 2026-06-26T17:33:37+08:00
- **Notes**: Re-ran the search with the grouped route path wrapped in single quotes.

---

## [ERR-20260626-003] aesthetic_mirror_history_remote_image_cors

**Logged**: 2026-06-26T17:18:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
爆款复刻历史记录为空，因为保存历史时直接读取 APIMart 返回的远程图片 URL 可能被浏览器 CORS 拦截。

### Error
```text
历史记录保存失败；生成结果可见，但 IndexedDB 历史抽屉为空。
```

### Context
- Operation attempted: save `requestEdit()` generated images into `aesthetic_mirror_logs`.
- Some image providers return HTTP(S) result URLs instead of inline data URLs.
- Browser-side `fetch(remoteUrl)` can fail due to CORS, so `buildMirrorHistoryLog()` aborted before writing localforage.

### Suggested Fix
When persisting generated remote images into local history, convert them through the app proxy `/api/remote-image` and then `FileReader.readAsDataURL()` before writing IndexedDB.

### Metadata
- Reproducible: yes
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`

### Resolution
- **Resolved**: 2026-06-26T17:18:00+08:00
- **Notes**: Added `historyImageToDataUrl()` fallback that proxies remote HTTP(S) images through `/api/remote-image` before saving history.

---

## [ERR-20260626-002] parallel_tsc_next_build_next_types_race

**Logged**: 2026-06-26T16:52:00+08:00
**Priority**: low
**Status**: resolved
**Area**: frontend

### Summary
Running `npx tsc --noEmit` in parallel with `npm run build` caused `.next/types` files to disappear while TypeScript was reading them.

### Error
```text
error TS6053: File 'E:/image/infinite-canvas/web/.next/types/app/(user)/aesthetic-mirror/page.ts' not found.
```

### Context
- Operation attempted: verify `web/src/app/(user)/aesthetic-mirror/page.tsx` after adding local history.
- `npm run build` rewrites `.next`, while `tsc` includes `.next/types/**/*.ts` from `tsconfig.json`.
- Re-running `npx tsc --noEmit` after build completed passed.

### Suggested Fix
Do not run `npx tsc --noEmit` and `npm run build` in parallel in this project. Run build first, then typecheck.

### Metadata
- Reproducible: yes
- Related Files: `web/tsconfig.json`, `web/src/app/(user)/aesthetic-mirror/page.tsx`

### Resolution
- **Resolved**: 2026-06-26T16:52:00+08:00
- **Notes**: Re-ran `npx tsc --noEmit` serially after build; it passed.

---

## [ERR-20260622-001] powershell_parenthesized_paths

**Logged**: 2026-06-22T09:38:00+08:00
**Priority**: low
**Status**: pending
**Area**: frontend

### Summary
PowerShell interpreted unquoted Next.js route paths like `web/src/app/(user)/canvas/[id]/...` as syntax/globs, causing inspection commands to fail.

### Error
```text
The term 'user\' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

### Context
- Operation attempted: `git diff` / `git status` against files under `web/src/app/(user)/canvas/[id]/...`.
- Environment: Windows PowerShell in `E:\image\infinite-canvas`.
- Paths containing parentheses and square brackets need literal handling.

### Suggested Fix
Use `-LiteralPath` for PowerShell file cmdlets and `git --% ...` or quoted pathspecs for Git commands when targeting Next.js route folders containing `(user)` or `[id]`.

### Metadata
- Reproducible: yes
- Related Files: `web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`

---

## [ERR-20260612-001] docker_compose_rebuild_timeout

**Logged**: 2026-06-12T18:50:00+08:00
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Remote `docker compose up -d --build` timed out before replacing the running container.

### Error
```text
command timed out after 244028 milliseconds
```

### Context
- Command attempted from Windows PowerShell via SSH: `docker compose -f docker-compose.server.yml up -d --build`
- The later explicit `docker compose build app` succeeded, but took about 7 minutes.
- Decisive slow step: final image `apt-get update` and package install from Debian mirror, especially package index/download.
- The old container stayed healthy during the timeout, so a timeout here does not prove deploy failure.

### Suggested Fix
Use separate deploy steps with a long timeout: `docker compose build app` then `docker compose up -d app`. Consider optimizing the Dockerfile so OS package installation is cached or handled by a pinned base image.

### Metadata
- Reproducible: yes
- Related Files: `Dockerfile`, `docker-compose.server.yml`

---

## [ERR-20260613-001] apply_patch_workspace_root_mismatch

**Logged**: 2026-06-13T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
`apply_patch` resolved file paths from `C:\Users\admin\Desktop\image` instead of the nested repo `C:\Users\admin\Desktop\image\infinite-canvas`.

### Error
```text
Failed to read file to update C:\Users\admin\Desktop\image\model\setting.go: 系统找不到指定的路径。 (os error 3)
```

### Context
- Operation attempted: update `model/setting.go` from the nested repo.
- The shell workdir was the repo, but `apply_patch` does not accept a workdir parameter and used the conversation root.

### Suggested Fix
Prefix patch paths with `infinite-canvas/` when the active project is the nested repo.

### Metadata
- Reproducible: yes
- Related Files: `model/setting.go`

---

## [ERR-20260618-001] t8star_models_local_tls_eof

**Logged**: 2026-06-18T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
Local Windows `urllib` request to the T8Star OpenAI-compatible `/v1/models` endpoint intermittently failed during TLS handshake.

### Error
```text
ssl.SSLEOFError: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol
```

## [ERR-20260625-001] powershell_unquoted_grouped_route_path

**Logged**: 2026-06-25T16:35:12.5697744+08:00
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
PowerShell interprets unquoted Next.js grouped route paths such as `web/src/app/(user)` instead of passing them as literal paths.

### Error
```text
The term 'user' is not recognized as a name of a cmdlet, function, script file, or executable program.
```

### Context
- Operation attempted: `rg -n "...pattern..." web/src/stores web/src/components/layout web/src/app/(user)`.
- Environment: Windows PowerShell.

### Suggested Fix
Quote grouped route paths in PowerShell commands, e.g. `'web/src/app/(user)'`.

### Metadata
- Reproducible: yes
- Related Files: `web/src/app/(user)/layout.tsx`

---

### Context
- Operation attempted: test `https://ai.t8star.org/v1/models` from local Windows before updating image channel settings.
- The same endpoint had already returned JSON in a prior test, so this appears to be intermittent/local network or TLS behavior.
- Do not print or persist API keys in diagnostics.

### Suggested Fix
Use the remote container environment for final channel verification and treat local one-off TLS EOF as non-decisive unless repeated.

### Metadata
- Reproducible: unknown
- Related Files: `web/src/services/api/image.ts`

---

## [ERR-20260621-001] remote_sqlite_data_backup_permission

**Logged**: 2026-06-21T14:20:00+08:00
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
The remote deployment user could read the project SQLite DB but could not create a sibling backup file inside `data/`.

### Error
```text
cp: cannot create regular file 'data/infinite-canvas.db.bak-20260621-apimart-gpt-image-2': Permission denied
sqlite3.OperationalError: attempt to write a readonly database
```

### Context
- Operation attempted: backup `/home/admin123/apps/infinite-canvas/data/infinite-canvas.db` before editing model channel settings.
- Environment: SSH as `admin123` on `192.168.10.128`.
- The project-level `backups/` directory is writable and should be used for ad hoc deployment backups.
- The live DB file can be owned by `root:root`; host-side Python as `admin123` may read but cannot write it.

### Suggested Fix
For remote DB backups in this project, copy to `backups/<name>.db` instead of writing new files under `data/`. If DB JSON must be edited directly, run the Python/sqlite operation through `docker exec -i infinite-canvas-13001 ...` so it executes as container root against `/app/data/infinite-canvas.db`.

### Metadata
- Reproducible: yes
- Related Files: `data/infinite-canvas.db`

---

## [ERR-20260621-002] remote_apimart_network_blocked

**Logged**: 2026-06-21T14:30:00+08:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
The deployed server cannot reach `https://api.apimart.ai`, so APIMart-backed `gpt-image-2` requests fail even though the app code and channel settings are deployed.

### Error
```text
Post "https://api.apimart.ai/v1/images/generations": dial tcp 103.42.176.244:443: i/o timeout
curl: (28) Failed to connect to api.apimart.ai port 443 after 10002 ms: Timeout was reached
curl: (35) Recv failure: Connection reset by peer
```

### Context
- Server: `admin123@192.168.10.128`.
- Public DNS from another network returned Cloudflare A records `172.67.70.35`, `104.26.11.94`, and `104.26.10.94`.
- Server DNS resolved `api.apimart.ai` to suspicious/non-working addresses and `curl --resolve` to the Cloudflare A records still failed.
- App health remained OK on `http://127.0.0.1:13001/api/health`.

### Suggested Fix
Fix the server's outbound network path for APIMart: configure a working proxy/NAT/DNS route or firewall allowlist for `api.apimart.ai:443`. After network is fixed, retry image generation without changing app code.

### Metadata
- Reproducible: yes
- Related Files: `web/src/services/api/image.ts`, `handler/ai.go`, `router/router.go`

### Resolution
- **Resolved**: 2026-06-21T18:35:00+08:00
- **Notes**: The server already had a working `gpt-remote-browser-gpt-proxy-1` xray container on Docker network `gpt-remote-browser-net`. Persistently attached `infinite-canvas-13001` to that external network in `docker-compose.server.yml` and set `HTTP_PROXY` / `HTTPS_PROXY` to `http://gpt-proxy:10808`. Verified `gpt-image-2` text-to-image and image-to-image submissions through the deployed app both returned APIMart `task_id`.

---

## [ERR-20260626-001] powershell_new_item_literal_path_unavailable

**Logged**: 2026-06-26T15:04:13.3018015+08:00
**Priority**: low
**Status**: pending
**Area**: infra

### Summary
The local PowerShell environment rejected `New-Item -LiteralPath`, so directory creation for a Next.js grouped route path failed.

### Error
```text
New-Item: A parameter cannot be found that matches parameter name 'LiteralPath'.
```

### Context
- Operation attempted: create `web/src/app/(user)/aesthetic-mirror` before copying a page file.
- Environment: Windows PowerShell in this workspace.

### Suggested Fix
Use `New-Item -Path` with a quoted path for directory creation in this environment, and reserve `-LiteralPath` for cmdlets confirmed to support it.

### Metadata
- Reproducible: unknown
- Related Files: `web/src/app/(user)/aesthetic-mirror/page.tsx`

---
