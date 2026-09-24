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

- [icloud-mail](https://github.com/t508708/icloud-mail): an iCloud email registration tool.

## Installation

```powershell
npm install
npm run dev
```

Open <http://localhost:5173> in your browser.

For the persistent API, build and start the server:

```powershell
npm run build
npm run server
```

The API listens on `http://127.0.0.1:8786` by default.

## Security Notes

- Keep passwords, 2FA secrets, access tokens, and refresh tokens on a controlled server.
- When exposing the API beyond localhost, configure an API token and use HTTPS behind a reverse proxy.
- Do not commit `data/state.json`, `data/.state-key`, or any other credential-bearing file.

## Contribution

1. Fork the repository.
2. Create a focused feature or fix branch.
3. Run the test suite with `npm test`.
4. Submit a pull request with a clear description.

## License

This project is released under the [MIT License](./LICENSE.md). Please retain the original copyright and license notices when redistributing the project or substantial portions of it. You are responsible for credential security, privacy, compliance, and authorized use of any connected third-party service.