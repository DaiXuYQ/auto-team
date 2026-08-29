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

然后打开 <http://localhost:5173>。前端和服务端默认从空状态启动，不包含预置母号、子号或历史记录。数据以服务端 `data/state.json` 为准；可以在“设置”中调整预警阈值和轮询周期。

前端不会生成演示账号。Free 账号可以通过“导入 Sub2API JSON”导入真实 `accounts[].credentials` 和 `accounts[].extra`，也可以粘贴 `邮箱----密码----2FA`（或使用 `|`、逗号）保存登录凭据。已有 `refresh_token` 的账号可在 Free 列表点击“刷新 AT”，服务端会真实请求 OpenAI 更新并保存 AT；只有邮箱/密码/2FA 的账号会进入登录验证等待状态，遇到邮箱验证码、Turnstile 或浏览器设备校验时不会伪造成功，完成验证后可录入真实 AT。JSON 的完整凭据只提交并保存到服务端 `data/state.json`，界面和 API 响应只返回脱敏 token。

混合 Sub2API 文件会按 `credentials.plan_type` 分流：`team` 记录按 `chatgpt_account_id` 合并为空间，并保留该空间的多个所有者；`free` 记录进入 Free 账号池。同一邮箱同时存在 Free 和 Team 记录时不会互相覆盖。

需要启动持久化 API 时，先构建再运行：

```powershell
npm run build
npm run server
```

服务监听 `http://127.0.0.1:8786`，并提供 `/api/state`、`/api/history`、`/api/settings`、`/api/mothers/*`（Team 所有者与空间操作）、`/api/children/import`、`/api/children/:id/login`、`/api/children/:id/acquire`、`/api/children/:id/probe`、`/api/children/:id/join`、`/api/children/:id/switch`、`/api/children/:id/kick`、`/api/maintenance/check`、`/api/maintenance/refill` 和 `/api/sub2api/export`。`/api/state` 额外返回脱敏的 `teams` 汇总、账号凭据状态、加入历史和 Sub2API 状态；前端同步时可传 `includeHistory=false` 跳过历史。`/api/history?page=1&pageSize=20` 返回当前页 `items` 及 `total`、`totalPages` 等分页信息，不带分页参数时保持返回完整数组。开启服务端自动补位后，轮询只处理拥有真实所有者 AT 和空间 ID 的 Team；没有真实凭据的记录不会被标记为已加入或被远端操作。API 的完整 AT/refresh token、密码和 2FA 只写入本地 `data/state.json`，接口响应会脱敏；生产环境应进一步加认证、HTTPS 和密钥加密。

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

MCP 工具包括 `get_state`、`list_teams`、`list_accounts`、`get_history`、`check_team_quota`、`check_all_teams`、`refill_team`、`refill_all_teams` 和 `update_settings`。其中检测、补位和设置更新会真实改变系统状态；MCP 返回沿用脱敏投影，不返回完整密码、2FA、Access Token 或 refresh token。需要跨机器接入时设置 `HOST=0.0.0.0` 和 `MCP_AUTH_TOKEN`，客户端使用 `Authorization: Bearer <token>`。

## 与真实服务对接

当前实现把登录、Team invite、workspace/select、额度查询和 Sub2API 推送保留为可替换的适配边界。参考实现位于 `F:\ai-work\ai-gpt-k12`：

- 邀请申请/管理员同意：`server/k12-invite.ts` 与 `server/index.ts` 中的 `approveK12WorkspaceRequestByAdmin`。
- 切换空间并取得 workspace AT：`selectAuthWorkspace` / `switchToK12WorkspaceAccessToken`。
- 5h/7d 额度：`probeChatGptUsageQuota`，请求 `/backend-api/wham/usage`。
- Sub2API OAuth：`codex_register/src/sub2api.ts`。

接入真实服务时请将完整 AT、refresh token、密码和 2FA 仅保存在受控服务端，前端只展示脱敏值；不要把浏览器 localStorage 当作生产凭据保险库。
