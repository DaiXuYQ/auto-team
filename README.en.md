# Team Rotation

> **QQ Group: 1105888476**
>
> Welcome to share usage feedback, feature ideas, deployment experience, and open-source contributions.

Team Rotation is a lightweight local management console for Team workspaces and Free account pools. It organizes Team records, account records, seat rotation, quota checks, automatic refill, OAuth handoff, and Sub2API JSON import/export in one place.

## Features

- Manage Team owners, workspaces, seats, and current members.
- Display 5-hour and 7-day quota snapshots for Team members.
- Rotate members by quota or join time, with configurable limits and automatic refill.
- Track Free account credential status, joined Teams, and Sub2API status.
- Import and export Sub2API JSON while keeping sensitive credential handling on the server.
- Expose a local HTTP API and MCP Streamable HTTP endpoint for agent integrations.

## Related Open-Source Project

- [icloud-mail](https://github.com/t508708/icloud-mail): an independent open-source project for registering iCloud mailboxes when you need more email accounts.

## Installation

```powershell
npm install
npm run server
```

In another terminal, start Vite:

```powershell
npm run dev
```

Open <http://localhost:5173> in your browser and sign in with the default password `daixuteam`. Development requires both `npm run server` and `npm run dev`: Vite proxies `/api` to the local API server.

For deployment with the built page served by the API process, build and start the server:

```powershell
npm run build
npm run server
```

The API listens on `http://127.0.0.1:8786` by default.

## Version Label

The current version comes from the `version` field in `package.json` and is displayed in the dashboard. The project does not connect to GitHub to check for updates. See [CHANGELOG.md](./CHANGELOG.md) for release notes.

For each release, update the semantic version in `package.json` and `package-lock.json`, and add release notes.

## Security Notes

- The dashboard's default password is `daixuteam`; set `TEAM_ROTATION_LOGIN_PASSWORD` before starting the server to override it. Use a strong replacement for remote deployments. Login creates a seven-day, HttpOnly, SameSite=Lax cookie scoped to `/api`. Sessions live in server memory, so a server restart requires signing in again; logout invalidates the current session.
- Keep passwords, 2FA secrets, access tokens, and refresh tokens on a controlled server.
- The server listens on `127.0.0.1` by default. Non-loopback `HOST` requires `TEAM_ROTATION_API_TOKEN` and `TEAM_ROTATION_DATA_KEY`. Dashboard login does not replace the API token: protected requests from the signed-in dashboard still need it when configured. The browser stores the token only for the current session and clears it on logout. Programmatic HTTP clients with a valid API token do not need a dashboard cookie session. Use HTTPS behind a reverse proxy for remote access.
- MCP authentication is independent of dashboard login. It continues to use `TEAM_ROTATION_API_TOKEN` by default, with `MCP_AUTH_TOKEN` available as an override.
- Do not commit `data/state.json`, `data/.state-key`, or any other credential-bearing file.

## Contribution

1. Fork the repository.
2. Create a focused feature or fix branch.
3. Run the test suite with `npm test`.
4. Submit a pull request with a clear description.

## License

This project is released under the [MIT License](./LICENSE.md). Please retain the original copyright and license notices when redistributing the project or substantial portions of it. You are responsible for credential security, privacy, compliance, and authorized use of any connected third-party service.
