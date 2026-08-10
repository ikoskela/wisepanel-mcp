# Wisepanel MCP Server

**The decision-intelligence layer between frontier models and high-consequence decisions.**

[Wisepanel](https://wisepanel.ai) takes a question, builds a panel of AI agents around it, and
has them argue it out. You get back the positions that survived the argument, the reasoning
behind each one, and the disagreements that never resolved.

This MCP server exposes that to [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
and any MCP-compatible client.

## Why

A single model gives you one answer, fluently, whether or not it is right. That is fine for
most questions. It is a bad property for the ones where being wrong is expensive.

The failure usually isn't ignorance. A model commits to a framing early and then argues for
it, so you never see the objection, the alternative, or the assumption doing the work. Ask
again and you get the same framing in different words. Ask three models separately and you get
three confident answers with no way to choose between them.

## How it works

Wisepanel builds disagreement in deliberately, at three levels.

**One — each agent is handed a conflict to resolve.** Roles are derived from your question, and
each is defined by two forces that genuinely oppose each other: cost against access, speed
against safety, proven against new. The agent can't champion one side. It has to reach a
position that answers both, so it arrives with something worked through rather than a talking
point.

**Two — every agent resolved a different conflict, so their positions don't match.** The agent
holding cost against access lands somewhere the one holding speed against safety does not.
These aren't two sides of an argument. They are several honest resolutions of the same
question that disagree about what mattered most, and between them they cover the ground the
question actually occupies.

**Three — the structure makes them contend.** Agents are placed on the *edges* of a
polyhedron, so each one works at two vertices — two separate conversations. At its second
vertex an agent is not merely a participant but a delegate from the first, instructed to
represent what its co-participants concluded there alongside its own position. Every vertex
therefore hears whole conversations it was not part of, argued by someone who was.

That last part is what makes a small panel go further than its headcount. Six agents means
twelve seats, and each seat imports another discussion — so a point raised anywhere reaches
the entire panel within a few hops, with no aggregator, no summarizer and no bottleneck.
Speaking order is balanced, so no agent frames the discussion first or takes the last word.
[Details](#topology).

## Isn't this just asking three models?

Pasting the same question into Claude, GPT and Gemini is a real technique, and it works for a
real reason: different labs train on different data with different methods, so their priors
genuinely differ. Wisepanel does the same thing — roles are spread across Anthropic, OpenAI,
Google and Perplexity by default, so no single lab's blind spots go unchallenged.

But the model is only one of the places bias enters. There are four, and doing it by hand
reaches one.

**Your framing goes to everyone unchanged.** You paste the same words three times, so you
sample three training substrates against a single reading of the question. When the question
carries an assumption — and questions about decisions usually do — you get three confident
answers to the wrong question.
[`wisepanel_magic_prompt`](#wisepanel_magic_prompt) rewrites the framing before the panel sees
it.

**Each model answers as itself.** You get Claude's median take, GPT's median take, Gemini's
median take, and medians cluster. A model asked a neutral question gives a balanced answer;
it will not volunteer the strongest case against your plan, because that isn't what it was
asked for. Assigning a role changes what the model is optimising for, which produces arguments
none of them offer unprompted.

**Bouncing answers between models makes anchoring worse, not better.** Feed A's response to B
and B now reasons inside A's framing — models tend to accept a stated position and refine it
rather than discard it and start over. So the sequential version is more biased than three
independent queries, and whichever model you happened to open first sets the terms. Wisepanel
balances speaking order and spreads the conversation across vertices precisely so no single
position gets to be the one everyone reacts to.

**The reconciliation lands on you.** Three answers arrive; nothing has compared them. You do
that work yourself, with your own priors, usually at the end of a long day on a decision you
already lean one way about. A panel does the contending first and hands you what survived it.

Then there is the part that doesn't scale by hand. Three models is three samples. A panel is
6 to 30 roles chosen to span the question, each holding an opposition, each carrying a second
conversation to its other vertex — twelve seats at the smallest size. You are not going to
hand-run that, and you are certainly not going to do it consistently on every decision that
deserves it.

**Where doing it by hand wins:** it's free, it's immediate, and you keep complete control of
the wording. For most questions that is the right trade. This is for the ones where it isn't.

## Checks around the argument

- **The question is checked for bias first.**
  [`wisepanel_magic_prompt`](#wisepanel_magic_prompt) rewrites loaded framing, embedded
  assumptions and false binaries before the panel sees them. A biased question produces a
  confident answer to the wrong thing.
- **Reasoning is auditable.** Agents attribute claims, surface assumptions and flag each
  other's gaps — on by default. See [`show_and_audit_reasoning`](#wisepanel_start).
- **Claims can be checked against sources.** Optional native web search verifies dates,
  citations, figures and rules instead of trusting recall. See
  [`web_search_enabled`](#wisepanel_start).

## When to use it

**When being wrong is expensive** — architecture calls you'll live with for years, migrations,
security and privacy trade-offs, vendor selection, anything where you want the strongest case
against your instinct before you commit. It is slower and costs more than a single query. That
is the trade you are making.

**Don't use it** for questions with a known answer, or where you would not act differently
given a dissenting view.

Runs stream live, so you watch the argument develop rather than waiting for a verdict.
Completed deliberations can also be published to the
[Wisepanel Commons](https://wisepanel.ai/commons).

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
| `topology` | string | Panel size — see [Topology](#topology). `small` (6 agents, default), `medium` (12), `large` (30) |
| `model_group` | string | See [Model groups](#model-groups). Default `smart` |
| `rounds` | number | Polyhedron traversals (1-5). Default `1` — see [Rounds](#rounds) |
| `context` | string | Additional framing context |
| `context_file` | string | Path to a file used as context, for payloads too large to pass inline. Concatenated after `context` if both are given |
| `compression` | string | Context compression: `none`, `moderate`, `aggressive` (default) |
| `short_responses` | boolean | Request concise panelist responses. Default `false` |
| `show_and_audit_reasoning` | boolean | Reasoning-quality scaffolding + cross-agent audit. **Server default is on** — omit to accept it, pass `false` to opt out. ~1.45x cost |
| `web_search_enabled` | boolean | Let agents verify factual claims via native provider web search. Requires `smart`. Default `false`. ~3.25x cost, ~6.5x combined with audit |

<a name="topology"></a>
#### Topology

Agents sit on the polyhedron's **edges**, so the agent count is the edge count:

| `topology` | Polyhedron | Vertices | Agents | Responses per round |
|---|---|---|---|---|
| `small` | tetrahedron | 4 | 6 | ~12 |
| `medium` | octahedron | 6 | 12 | ~24 |
| `large` | icosahedron | 12 | 30 | ~60 |

Time and cost scale with agent count — `large` is 5× `small`. Escalate when a question needs
more genuinely distinct perspectives, not when you want a better answer from the same ones.

**Why edges rather than vertices.** Every edge of a Platonic solid is equivalent under the
solid's symmetry group, and speaking order is balanced so no agent consistently anchors or
consistently gets the last word. There is no hub and no privileged seat. Graph diameter stays
small — 1, 2 and 3 respectively — so an insight raised anywhere reaches the whole panel in a
few hops. Because each agent sits on an edge, it is simultaneously a participant and a bridge:
propagation is a side effect of participation, with no messenger or aggregator role.

| Structure | Uniform influence | Fast propagation | Cost |
|---|---|---|---|
| Hub-and-spoke | ✗ one position frames everything | ✓ | linear |
| Chain / round-robin | ✗ anchoring, last-word advantage | ✗ | linear |
| All-to-all | ✓ | ✓ | O(n²) |
| **Polyhedral edges** | **✓** | **✓** | **linear** |

All-to-all buys the same reach and uniformity at quadratic cost. Edge assignment on a regular
polyhedron is the structure that gets both at linear cost.

<a name="model-groups"></a>
#### Model groups

Cost is relative to `smart`, the default:

| Group | Relative cost | Use when |
|---|---|---|
| `smart` | 1× (baseline) | default; current flagships (Opus 5, GPT-5.6 Sol, Gemini 3.1 Pro Preview) |
| `cheap` / `fast` | ~¼× | small models; `fast` optimises latency, `cheap` optimises cost — same tier |
| `mixed` | < 1× | random across all providers; cheaper on average, quality varies seat to seat |
| `informed` | ~1× | search-capable models incl. Perplexity Sonar; the answer turns on current facts |
| `large` | varies | largest context windows — for big context payloads, not better answers |
| `anthropic-fable` | ~2× | Claude Fable 5 on every seat; only when maximum capability is explicitly wanted |

Single-provider groups (`openai`, `anthropic`, `google`, `perplexity`) pin every seat to one
vendor, which removes cross-vendor diversity — usually the point of a panel.

<a name="rounds"></a>
#### Rounds

Agents sit on the **edges** of the polyhedron, not the vertices. Each agent connects two
vertices (conversation nodes) and contributes at **both** endpoints every round — so
`rounds: 1` already produces roughly `num_agents × 2` responses.

Rounds are full polyhedron traversals, not chat turns. `rounds: 1` is already substantial
deliberation. Use 2+ only when agents need to react to other agents' *completed* positions —
e.g. a binary strategic decision with sharply opposing arguments.

### `wisepanel_magic_prompt`

Rewrite a question to remove framing that would bias the panel toward a predetermined
answer — loaded wording, embedded assumptions, false binaries — while preserving intent.
Optional pre-step before `wisepanel_start`.

| Parameter | Type | Description |
|---|---|---|
| `question` | string (required) | The question to rewrite, as the user wrote it |

Returns one of three outcomes. The original question is echoed back in every case, so you
can always fall back to it:

| `outcome` | Meaning | Billed |
|---|---|---|
| `transformed` | Rewritten. Response includes `rewritten` | yes |
| `no_change_needed` | Already unbiased — use the original | no |
| `fail_closed` | No safe rewrite produced — use the original | no |

**Show the user both versions and let them choose.** The rewrite can shift emphasis in ways
they may not want, so it should never be substituted silently. This mirrors the web app,
where the transform runs only on an explicit click, behind a cost confirmation, with revert
available.

Billed separately from the deliberation, and only when the text actually changes.

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

## Patent pending

Wisepanel's multi-agent deliberation architecture — including the polyhedral topology and the
reasoning-audit and verification subsystems — is the subject of pending US patent applications
assigned to QuROI, Inc.

## License

MIT — see [LICENSE](LICENSE).

The MIT license covers the client in this repository only. It grants no license, express or
implied, to any patent, or to the Wisepanel platform and the methods it implements.
