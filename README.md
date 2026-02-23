# Wisepanel MCP Server

An MCP server that gives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and any MCP-compatible client direct access to [Wisepanel's](https://wisepanel.ai) multi-agent deliberation platform.

Run deliberations across Claude, Gemini, and Perplexity. Stream panelist responses in real-time. Publish to the [Wisepanel Commons](https://wisepanel.ai/commons).

## Quick Start

Add to your MCP client config (e.g. `~/.mcp.json` for Claude Code):

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

Get your API key at [wisepanel.ai/settings](https://wisepanel.ai/settings).

## Tools

### `wisepanel_start`

Start a deliberation. Convenes a panel of AI models to debate a question from assigned perspectives. Returns `run_id` immediately.

| Parameter | Type | Description |
|---|---|---|
| `question` | string (required) | The topic for the panel to deliberate |
| `topology` | string | Panel geometry: `tetrahedron` (4 panelists), `octahedron` (6), `icosahedron` (12) |
| `model_group` | string | `mixed` (diverse providers), `fast`, `smart` (reasoning-optimized), `informed` (search-augmented) |
| `rounds` | number | Deliberation rounds (1-5). More rounds deepen the debate |
| `context` | string | Additional framing context |
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
