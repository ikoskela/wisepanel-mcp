# Wisepanel MCP Server

An MCP server that gives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and any MCP-compatible client direct access to [Wisepanel's](https://wisepanel.ai) multi-agent deliberation platform.

Run deliberations across Claude, Gemini, and Perplexity. Stream panelist responses in real-time. Publish to the [Wisepanel Commons](https://wisepanel.ai/commons).

## Quick Start

Get your API key at [wisepanel.ai/settings](https://wisepanel.ai/settings), then:

```bash
claude mcp add wisepanel --scope user \
  --env WISEPANEL_API_KEY=wp_sk_ExampleOnly0000-replace-with-your-own-key \
  -- npx -y wisepanel-mcp
```

Paste the key **exactly as shown on the settings page** — the whole `wp_sk_…` string and
nothing else. Quotes around it are optional and harmless. Do **not** add a `Bearer` prefix:
the server sends `Authorization: Bearer <your-key>` itself, so including it yields
`Bearer Bearer wp_sk_…` and auth fails.

Restart Claude Code and run `/mcp` — `wisepanel` should show as connected.

`✔ Connected` only means the server process launched. Your API key isn't checked
until the first call, so a bad key still shows as connected. To confirm auth
actually works, run a deliberation and check that it returns a `run_id`.

> **This is a stdio server, not a remote one.** There is no HTTP endpoint —
> `claude mcp add --transport http` will not work no matter what URL you give it.
> Everything after the `--` is the command that launches the server locally.

<details>
<summary>Other MCP clients (manual config)</summary>

Add to your client's config file — `~/.claude.json` for Claude Code, or the
equivalent for Cursor, Windsurf, Claude Desktop, etc.:

```json
{
  "mcpServers": {
    "Wisepanel": {
      "command": "npx",
      "args": ["-y", "wisepanel-mcp"],
      "env": {
        "WISEPANEL_API_KEY": "your-api-key"
      }
    }
  }
}
```

</details>

### Configuration

| Variable | Required | Default |
|---|---|---|
| `WISEPANEL_API_KEY` | yes | — |
| `WISEPANEL_API_URL` | no | `https://api.wisepanel.ai` |

### Troubleshooting

**`'url' is not a valid URL`** — the server was added with `--transport http`.
Remove it and re-add using the stdio command above:

```bash
claude mcp remove wisepanel --scope user
```

**`WISEPANEL_API_KEY environment variable is required`** — the key didn't reach
the server process. Pass it with `--env` as shown, not as an `Authorization`
header; headers apply to remote servers only.

**`API 401` / not authenticated despite a valid key** — check the stored value with
`claude mcp get wisepanel`. It must be the bare `wp_sk_…` string. A `Bearer ` prefix, a
trailing space, or a partial paste are the usual causes.

**Not authenticated** — verify the key is active at
[wisepanel.ai/settings](https://wisepanel.ai/settings). Keys are secrets: never
paste them into chat, issues, or screenshots. If one leaks, revoke and reissue it.

## Tools

### `wisepanel_start`

Start a deliberation. Convenes a panel of AI models to debate a question from assigned perspectives. Returns `run_id` immediately.

| Parameter | Type | Description |
|---|---|---|
| `question` | string (required) | The topic for the panel to deliberate |
| `topology` | string | Panel size: `small` (faster), `medium` (balanced), `large` (thorough) |
| `model_group` | string | `mixed` (random), `smart`, `fast`, `cheap`, `informed` (search-augmented), `large` (largest context). Or single provider: `openai`, `anthropic`, `google`, `perplexity` |
| `rounds` | number | Deliberation rounds (1-5). More rounds deepen the debate |
| `context` | string | Additional framing context |
| `compression` | string | Context compression: `none`, `moderate`, `aggressive` (default) |
| `short_responses` | boolean | Request concise panelist responses |

### `wisepanel_poll`

Long-polls a running deliberation (waits up to 15s for new events). Returns panelist responses as they arrive.

### `wisepanel_result`

Retrieve full results of a completed deliberation. Only needed if you didn't poll it live.

### `wisepanel_cancel`

Cancel a running deliberation.

### `wisepanel_publish`

Publish a completed deliberation to the [Wisepanel Commons](https://wisepanel.ai/commons). Makes it publicly viewable and shareable.

### `wisepanel_list_runs`

List all deliberation runs in the current session.

## Typical Flow

```
1. wisepanel_start    -> returns run_id
2. wisepanel_poll     -> (repeat) returns panelist responses as they arrive
3. On completion, poll includes publish_available: true
4. wisepanel_publish  -> publishes to Commons, returns public URL
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WISEPANEL_API_KEY` | Yes | Your Wisepanel API key |
| `WISEPANEL_API_URL` | No | API base URL (defaults to `https://api.wisepanel.ai`) |

## Development

```bash
git clone https://github.com/ikoskela/wisepanel-mcp.git
cd wisepanel-mcp
npm install
npm run dev
```

## License

MIT
