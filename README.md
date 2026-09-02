# team轮转

一个面向 Team 空间和 Free 账号池的轻量管理台。界面围绕 Team 记录与账号记录组织，服务端继续保留真实 Team 检测、额度查询和自动补位能力。

1. 在 Team 维护中查看所有者、席位和当前成员。
2. 在 Team 成员列表中查看每个账号的 5h / 7d 额度。
3. 只对 5h 或 7d 已用完的账号执行移出，并记录移出原因、加入空间和下次可重试时间。
4. 从待加入池补满空席位。
5. 在 Free 账号维护中记录邮箱、密码/2FA 是否已录入、加入过的 Team 和 Sub2API 状态。
6. 下载 Sub2API JSON，后续可替换为真实推送适配器。

## 启动

```powershell
npm install
npm run dev
```

然后打开 <http://localhost:5173>。前端和服务端默认从空状态启动，不包含预置母号、子号或历史记录。数据以服务端 `data/state.json` 为准；该文件使用 AES-256-GCM 加密，可以在“设置”中调整预警阈值和轮询周期。

前端不会生成演示账号。Free 账号可以通过“导入 Sub2API JSON”导入真实 `accounts[].credentials` 和 `accounts[].extra`，也可以粘贴 `邮箱----密码----2FA`（或使用 `|`、逗号）保存登录凭据。开启自动补位后，没有 Free JSON 的账号会先通过 RT 或邮箱、密码、2FA 自动取得 AT/RT；已有 AT 过期时优先用 RT 刷新。遇到邮箱验证码、Turnstile 或浏览器设备校验时不会伪造成功，界面会保留验证状态。JSON 的完整凭据只提交并加密保存在服务端，界面和 API 响应只返回脱敏 token。

混合 Sub2API 文件会按 `credentials.plan_type` 分流：`team` 记录按 `chatgpt_account_id` 合并为空间，并保留该空间的多个所有者；`free` 记录进入 Free 账号池。同一邮箱同时存在 Free 和 Team 记录时不会互相覆盖。

需要启动持久化 API 时，先构建再运行：

```powershell
npm run build
npm run server
```

服务监听 `http://127.0.0.1:8786`，并提供 `/api/state`、`/api/history`、`/api/settings`、`/api/mothers/*`（Team 所有者与空间操作）、`/api/children/import`、`/api/children/:id/login`、`/api/children/:id/acquire`、`/api/children/:id/join`、`/api/children/:id/switch`、`/api/children/:id/kick`、`/api/maintenance/check`、`/api/maintenance/refill` 和 `/api/sub2api/export`。Free 账号只用于登录、取得凭据和加入 Team，不单独检测额度；5h / 7d 额度只保存和检测在对应 Team 空间下。`/api/state` 额外返回脱敏的 `teams` 汇总、账号凭据状态、加入历史和 Sub2API 状态；前端同步时可传 `includeHistory=false` 跳过历史。`/api/history?page=1&pageSize=20` 返回当前页 `items` 及 `total`、`totalPages` 等分页信息，不带分页参数时保持返回完整数组。单个成员检测失败只记录为部分失败，不会阻断其他成员或已确认额度状态的补位。

## 安全配置

- 默认只监听 `127.0.0.1`。设置非本机 `HOST` 时，必须同时设置 `TEAM_ROTATION_API_TOKEN`，否则服务拒绝启动。页面第一次访问受保护 API 时会要求输入 Token，并仅保存到当前浏览器会话。
- 状态文件默认使用 `data/.state-key` 加密；非本机监听必须设置独立的 `TEAM_ROTATION_DATA_KEY`（32 字节 Base64、64 位十六进制或高强度口令），并单独备份该密钥。密钥丢失后无法解密状态数据。
- 跨域前端通过 `TEAM_ROTATION_ALLOWED_ORIGINS` 配置允许来源，多个来源使用逗号分隔。默认只允许同源以及本机 Vite 开发地址。
- MCP 默认复用 `TEAM_ROTATION_API_TOKEN`；也可以单独设置 `MCP_AUTH_TOKEN`。远程部署仍应在 HTTPS 反向代理后使用。

## Agent MCP 接入

服务端同时提供符合 MCP Streamable HTTP 规范的 `POST /mcp` 端点。先启动 `npm run server`，然后在支持 HTTP MCP 的 Agent 中配置：

```json
{
  "mcpServers": {
    "team-rotation": {
      "url": "http://127.0.0.1:8786/mcp"
    }
  }
}
```

只支持本地 stdio 的客户端可以使用仓库内的桥接命令（同样需要服务端运行）：

```json
{
  "mcpServers": {
    "team-rotation": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "F:/ai-work/gpt-tila-team",
      "env": { "QUOTA_HUB_MCP_URL": "http://127.0.0.1:8786/mcp" }
    }
  }
}
```

MCP 工具包括 `get_state`、`list_teams`、`list_accounts`、`get_history`、`check_team_quota`、`check_all_teams`、`refill_team`、`refill_all_teams`、`acquire_missing_free_json` 和 `update_settings`。其中检测、补位、批量获取 Free JSON 和设置更新会真实改变系统状态；MCP 返回沿用脱敏投影，不返回完整密码、2FA、Access Token 或 refresh token。需要跨机器接入时设置 `HOST=0.0.0.0` 和 `MCP_AUTH_TOKEN`，客户端使用 `Authorization: Bearer <token>`。

## 与真实服务对接

当前实现把登录、Team invite、workspace/select、额度查询和 Sub2API 推送保留为可替换的适配边界。参考实现位于 `F:\ai-work\ai-gpt-k12`：

- 邀请申请/管理员同意：`server/k12-invite.ts` 与 `server/index.ts` 中的 `approveK12WorkspaceRequestByAdmin`。
- 切换空间并取得 workspace AT：`selectAuthWorkspace` / `switchToK12WorkspaceAccessToken`。
- 5h/7d 额度：`probeChatGptUsageQuota`，请求 `/backend-api/wham/usage`。
- Sub2API OAuth：`codex_register/src/sub2api.ts`。

接入真实服务时请将完整 AT、refresh token、密码和 2FA 仅保存在受控服务端，前端只展示脱敏值；不要把浏览器 localStorage 当作生产凭据保险库。
