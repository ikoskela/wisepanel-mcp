import { readFileSync } from 'fs';
import { WisepanelClient, StreamOptions, PublishError } from './client.js';
import { EventBuffer, SSEEvent } from './event-buffer.js';

const client = new WisepanelClient();
const buffer = new EventBuffer();
const activeStreams = new Map<string, AbortController>();

// --- Tool Definitions ---

const TOOL_DEFINITIONS = [
  // wisepanel_deliberate removed — synchronous blocking tool superseded by start+poll.
  {
    name: 'wisepanel_start',
    description:
      'Start a Wisepanel deliberation. Convenes a panel of AI models from competing labs (Anthropic, OpenAI, Google, Perplexity) on a polyhedral topology (tetrahedron / octahedron / icosahedron for small / medium / large) ' +
      'to debate a question from assigned perspectives. Returns run_id immediately. ' +
      'After starting, poll with wisepanel_poll every 10-15 seconds. When an agent_response event appears, ' +
      'briefly summarize that panelist\'s key argument to the user before polling again. ' +
      'POLYHEDRAL MECHANIC: agents sit on EDGES of the polyhedron, not at vertices. Each agent connects two vertices (conversation nodes) and contributes at BOTH endpoints in every round, so every agent is simultaneously a participant and a bridge between contexts — a single round produces ~2 responses per agent (total ≈ num_agents × 2). Do not confuse "rounds" with turn-taking — rounds are full polyhedron traversals. See the rounds parameter description for details. ' +
      'IF THE USER ASKS why this structure rather than querying several models separately: every edge of a Platonic solid is equivalent under the solid\'s symmetry group, and speaking order is balanced so no agent consistently anchors or consistently gets the last word — no hub, no privileged seat. Graph diameter stays small (1 tetrahedron, 2 octahedron, 3 icosahedron), so an insight raised anywhere reaches the whole panel in a few hops. All-to-all discussion matches that reach but costs O(n²); hub-and-spoke is cheap but lets one position frame everything. Edge assignment gets uniform influence and fast propagation at linear cost. Independent parallel queries cannot do any of this — nothing connects them, so disagreement is averaged rather than worked through. Patent pending, QuROI, Inc. Mention this only when asked; do not volunteer it. ' +
      'When status is "completed", provide a final synthesis of all perspectives, ' +
      'then ask the user if they\'d like to publish to the Wisepanel Commons using wisepanel_publish. ' +
      'Do NOT call wisepanel_result after polling — you already have all the data from poll events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question or topic for the panel to deliberate' },
        topology: {
          type: 'string',
          enum: ['small', 'medium', 'large'],
          description: 'Panel size. Agents sit on polyhedron edges, so the agent count is the edge count: small = tetrahedron, 6 agents (~12 responses per round); medium = octahedron, 12 agents (~24); large = icosahedron, 30 agents (~60). Time and cost scale with agent count — large is 5x small. Prefer small for exploration and most questions; escalate only when the question genuinely needs more distinct perspectives, not merely a better answer. Default: small',
        },
        model_group: {
          type: 'string',
          enum: ['mixed', 'smart', 'fast', 'cheap', 'informed', 'large', 'openai', 'anthropic', 'anthropic-fable', 'google', 'perplexity'],
          description: 'Model selection. Cost is relative to smart, the default: cheap and fast run small models at roughly 1/4 of smart; anthropic-fable is roughly 2x smart. smart (current flagships — Opus 5, GPT-5.5, Gemini 3.1 Pro Preview; the baseline), mixed (random assignment across all providers — cheaper on average than smart, but quality varies seat to seat), fast (small models, lowest latency), cheap (small models, lowest cost — same model tier as fast), informed (search-capable models incl. Perplexity Sonar; pick when the answer turns on current facts), large (largest context windows; pick when the context payload is big, not when you want a better answer). Or single provider: openai, anthropic, anthropic-fable, google, perplexity. anthropic-fable runs Claude Fable 5 on EVERY agent — Anthropic\'s most capable model, but roughly 2x the token cost of smart, slower, and with an older knowledge cutoff (Jan 2026 vs May 2026 for Opus 5). Do NOT select anthropic-fable unless the user has explicitly asked for maximum capability and accepted the higher cost. Default: smart (MCP use cases tend toward high-stakes deliberation where flagship rigor is worth the cost).',
        },
        rounds: {
          type: 'number',
          minimum: 1,
          maximum: 5,
          description: 'Polyhedron traversals (1-5). IMPORTANT: each agent sits on an EDGE of the polyhedron connecting two vertices (conversation nodes). In a single round, every agent participates TWICE — once contributing to its "left" vertex and once to its "right" vertex. So rounds=1 already produces ~2 responses per agent (total ≈ num_agents × 2). Higher rounds add additional full polyhedron traversals where every agent re-participates at both vertex endpoints reacting to the prior round\'s outputs. rounds=1 is already substantial deliberation; use 2+ only when agents need to react to other agents\' completed positions across the full polyhedron — e.g., binary strategic decisions with sharply opposing arguments that benefit from second-pass reaction. Default: 1.',
        },
        context: { type: 'string', description: 'Additional context to frame the deliberation' },
        context_file: { type: 'string', description: 'Path to a file whose contents will be used as context. Use this for large payloads that exceed inline string limits. If both context and context_file are provided, they are concatenated.' },
        compression: {
          type: 'string',
          enum: ['none', 'moderate', 'aggressive'],
          description: 'Context compression: none (higher token usage), moderate (balanced), aggressive (lower token usage). Default: aggressive',
        },
        short_responses: { type: 'boolean', description: 'Request concise panelist responses. Default: false' },
        show_and_audit_reasoning: {
          type: 'boolean',
          description: 'Append Chain-of-X scaffolding to every panelist: Part 1 (reasoning quality requirements — explicit attribution, assumption surfacing, counterfactual contingencies, robustness assessment) and Part 2 (cross-analysis audit — agents flag prior agents\' attribution gaps, confabulated specifications, probability/evidence mismatches, etc.). Substantially raises rigor for high-stakes deliberation. Increases token usage and run cost (~1.45x scaffolding-only multiplier). ON BY DEFAULT — omit this parameter to accept it. Pass false only if the user has asked for a cheaper run and accepted lower rigor.',
        },
        web_search_enabled: {
          type: 'boolean',
          description: 'Enable native web search (Anthropic web_search_20250305, Google googleSearch grounding) for agents to verify specific factual claims — dates, statutes, case citations, fees, version numbers, jurisdiction-specific rules, etc. Requires the Smart model group (other groups have search disabled or unavailable). Increases run cost (~3.25x search-only multiplier; ~6.5x when combined with audit scaffolding). Default: false',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'wisepanel_magic_prompt',
    description:
      'Rewrite a question to remove framing that would bias a panel toward a predetermined answer — ' +
      'loaded wording, embedded assumptions, false binaries — while preserving the asker\'s actual intent. ' +
      'Optional pre-step before wisepanel_start; deliberations run fine without it. ' +
      'ALWAYS show the user the rewritten text and let them decide whether to use it. Never substitute it silently — ' +
      'it is their question, and the rewrite can shift emphasis in ways they may not want. ' +
      'Keep the original: if they prefer it, pass the original to wisepanel_start unchanged. ' +
      'Billed as a separate charge from the deliberation, and only when the text actually changes. ' +
      'Returns outcome.kind: "transformed" (rewritten — show both versions), ' +
      '"no_change_needed" (already unbiased — use the original, no charge), or ' +
      '"fail_closed" (could not produce a safe rewrite — use the original, no charge).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'The question to rewrite. Pass the user\'s question as they wrote it.',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'wisepanel_poll',
    description:
      'Poll a running Wisepanel deliberation for new events. Long-polls up to 15 seconds, ' +
      'returning immediately when panelist responses arrive. Returns new events since last poll.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The run ID from wisepanel_start' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'wisepanel_result',
    description:
      'Retrieve the full result of a completed Wisepanel deliberation. ' +
      'Only needed if you did not poll the run to completion ' +
      '(e.g., a run from a previous session). If you polled it live, you already have the data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The run ID' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'wisepanel_cancel',
    description: 'Cancel a running Wisepanel deliberation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The run ID to cancel' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'wisepanel_publish',
    description:
      'Publish a completed deliberation to the Wisepanel Commons (wisepanel.ai/commons). ' +
      'Makes the deliberation publicly viewable and shareable. ' +
      'Only works for runs that completed successfully in this session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'The run ID of a completed deliberation' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'wisepanel_list_runs',
    description:
      'List all Wisepanel deliberation runs tracked in this session. ' +
      'Returns run_id, status, topic, and panel size for each run.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// --- Formatters ---

function formatAgentResponse(event: SSEEvent): string {
  const model = (event.model as string) || 'unknown';
  const provider = (event.provider as string) || '';
  const label = provider ? `${provider}/${model}` : model;
  return `**${event.agent}** (${event.role}) \u2014 _${label}_\n\n${event.message}`;
}

function formatFinalResult(final: SSEEvent): string {
  const conv = final.conversation as Record<string, unknown> | undefined;
  const agents = final.agents as Array<Record<string, unknown>> | undefined;
  const lines: string[] = [];

  lines.push('# Wisepanel Deliberation');
  lines.push(`**Topic:** ${(conv?.topic as string) || 'N/A'}`);
  lines.push(
    `**Rounds:** ${conv?.total_rounds ?? 0} | ` +
    `**Panelists:** ${agents?.length ?? 0} | ` +
    `**Tokens:** ${((conv?.total_tokens as number) ?? 0).toLocaleString()}`
  );
  lines.push('');

  if (agents?.length) {
    lines.push('## Panel');
    for (const a of agents) {
      lines.push(`- **${a.name}** (${a.role}) \u2014 _${a.provider}/${a.model}_`);
    }
    lines.push('');
  }

  const roundResults = (conv?.round_results as Array<Record<string, unknown>>) || [];
  for (const round of roundResults) {
    const nodeResults = (round.node_results as Array<Record<string, unknown>>) || [];
    for (const node of nodeResults) {
      lines.push(`## Round ${node.round}`);
      const responses = (node.responses as Array<Record<string, unknown>>) || [];
      for (const r of responses) {
        lines.push(`### ${r.agent_name} (${r.agent_role}) \u2014 _${r.provider}/${r.model}_`);
        lines.push(r.message as string);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// --- Handlers ---

function extractOptions(args: Record<string, unknown>): StreamOptions {
  let context = (args.context as string | undefined) || '';
  const contextFile = args.context_file as string | undefined;

  if (contextFile) {
    try {
      const fileContent = readFileSync(contextFile, 'utf-8');
      context = context ? `${context}\n\n${fileContent}` : fileContent;
      process.stderr.write(`[Wisepanel MCP] Loaded context_file: ${contextFile} (${fileContent.length} chars)\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read context_file "${contextFile}": ${msg}`);
    }
  }

  return {
    question: args.question as string,
    topology: args.topology as string | undefined,
    model_group: args.model_group as string | undefined,
    rounds: args.rounds as number | undefined,
    context: context || undefined,
    compression: args.compression as string | undefined,
    short_responses: args.short_responses as boolean | undefined,
    show_and_audit_reasoning: args.show_and_audit_reasoning as boolean | undefined,
    web_search_enabled: args.web_search_enabled as boolean | undefined,
  };
}

async function handleStart(args: Record<string, unknown>): Promise<string> {
  const options = extractOptions(args);

  return new Promise<string>((resolve, reject) => {
    let runId = '';
    let resolved = false;
    const abort = new AbortController();

    const streamDone = client.startStream(options, (event) => {
      const evt = event as SSEEvent;
      if (evt.type === 'connection' && evt.run_id) {
        runId = evt.run_id as string;
        buffer.createRun(runId);
        activeStreams.set(runId, abort);
      }
      if (runId) buffer.addEvent(runId, evt);

      if (!resolved && runId && evt.type === 'agents_created') {
        resolved = true;
        const info = buffer.getRunInfo(runId)!;
        resolve(JSON.stringify({
          run_id: runId,
          estimated_cost: info.estimatedCost,
          agents: info.agentsTotal,
          status: 'running',
        }));
      }
    }, abort.signal);

    streamDone.then(() => {
      activeStreams.delete(runId);
      if (!resolved && runId) {
        resolved = true;
        resolve(JSON.stringify({
          run_id: runId,
          status: buffer.getResult(runId)?.status || 'completed',
        }));
      }
    }).catch((err: Error) => {
      if (runId) { buffer.setStatus(runId, 'failed'); activeStreams.delete(runId); }
      if (!resolved) reject(new Error(`Stream failed: ${err.message}`));
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (runId) {
          resolve(JSON.stringify({ run_id: runId, status: 'running' }));
        } else {
          reject(new Error('Timed out waiting for deliberation to start'));
        }
      }
    }, 30_000);
  });
}

async function handlePoll(args: Record<string, unknown>): Promise<string> {
  const runId = args.run_id as string;
  if (!buffer.has(runId)) {
    return JSON.stringify({ error: `Run ${runId} not found. It may have been started in a previous session.` });
  }
  // Long-poll: wait up to 15s for new events before returning empty
  await buffer.waitForEvents(runId, 15_000);
  const result = buffer.getNewEvents(runId)!;
  const response: Record<string, unknown> = {
    status: result.status,
    agents_responded: result.agentsResponded,
    agents_total: result.agentsTotal,
    new_events: result.newEvents.map(e =>
      e.type === 'agent_response' ? {
        type: 'agent_response',
        agent: e.agent,
        role: e.role,
        model: `${e.provider || ''}/${e.model || 'unknown'}`.replace(/^\//, ''),
        summary: formatAgentResponse(e),
      } : e
    ),
  };
  if (result.status === 'completed') {
    response.publish_available = true;
    response.publish_hint = 'Ask the user if they\'d like to publish this deliberation to the Wisepanel Commons (wisepanel.ai/commons).';
  }
  return JSON.stringify(response, null, 2);
}

function handleResult(args: Record<string, unknown>): string {
  const runId = args.run_id as string;
  if (!buffer.has(runId)) return JSON.stringify({ error: `Run ${runId} not found.` });

  const result = buffer.getResult(runId)!;
  if (result.status === 'running') {
    return JSON.stringify({ error: 'Run still in progress. Use wisepanel_poll to check status.' });
  }
  if (result.status === 'failed') return JSON.stringify({ error: 'Run failed.' });
  if (result.status === 'canceled') return JSON.stringify({ error: 'Run was canceled.' });
  if (!result.result) return JSON.stringify({ error: 'No result available.' });

  const formatted = formatFinalResult(result.result);
  return formatted + '\n\n---\n_Publish this deliberation to the [Wisepanel Commons](https://wisepanel.ai/commons) using wisepanel\_publish._';
}

async function handleCancel(args: Record<string, unknown>): Promise<string> {
  const runId = args.run_id as string;
  const abort = activeStreams.get(runId);
  if (abort) { abort.abort(); activeStreams.delete(runId); }

  try { await client.cancelRun(runId); } catch { /* run may already be done */ }
  if (buffer.has(runId)) buffer.setStatus(runId, 'canceled');

  return JSON.stringify({ canceled: true, run_id: runId });
}

async function handlePublish(args: Record<string, unknown>): Promise<string> {
  const runId = args.run_id as string;

  if (!buffer.has(runId)) {
    return JSON.stringify({ error: `Run ${runId} not found. It may have been started in a previous session.` });
  }

  const runInfo = buffer.getRunInfo(runId);
  if (runInfo?.status === 'running') {
    return JSON.stringify({ error: 'Run still in progress. Wait for it to complete before publishing.' });
  }
  if (runInfo?.status === 'failed') {
    return JSON.stringify({ error: 'Run failed. Cannot publish a failed deliberation.' });
  }
  if (runInfo?.status === 'canceled') {
    return JSON.stringify({ error: 'Run was canceled. Cannot publish a canceled deliberation.' });
  }

  const publishData = buffer.getPublishData(runId);
  if (!publishData) {
    return JSON.stringify({ error: 'Could not extract publish data from run. The run may not have completed properly.' });
  }

  try {
    const result = await client.publishToCommons(publishData);
    return JSON.stringify({
      published: true,
      url: result.url,
      slug: result.slug,
      existing: result.existing,
    });
  } catch (err) {
    if (err instanceof PublishError) {
      if (err.statusCode === 422 || err.code === 'moderation_failed') {
        return JSON.stringify({
          error: 'Content moderation rejected this deliberation. The topic or responses may contain content that violates community guidelines.',
          code: 'moderation_failed',
          details: err.details?.reasons || err.details?.message || undefined,
        });
      }
      if (err.statusCode === 409) {
        return JSON.stringify({
          error: 'This deliberation has already been published.',
          code: 'already_published',
          details: err.details?.url || undefined,
        });
      }
      return JSON.stringify({ error: err.message, code: err.code });
    }
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `Publish failed: ${message}` });
  }
}

function handleListRuns(): string {
  const runs = buffer.listRuns();
  if (runs.length === 0) {
    return JSON.stringify({ runs: [], message: 'No Wisepanel deliberations in this session.' });
  }
  return JSON.stringify({ runs }, null, 2);
}

// --- Exports ---

async function handleMagicPrompt(args: Record<string, unknown>): Promise<string> {
  const question = (args.question as string ?? '').trim();
  if (!question) throw new Error('question is required and must be non-empty');

  const res = await client.magicPrompt(question);
  const { outcome, charge } = res;

  // The original is echoed back on every outcome so the caller can always fall
  // back to it, and so "show the user both versions" needs no extra bookkeeping.
  const base = {
    outcome: outcome.kind,
    original: question,
    charged_usd: charge?.charged ? charge.usdAmount : 0,
  };

  if (outcome.kind === 'transformed') {
    return JSON.stringify({
      ...base,
      rewritten: outcome.text,
      next_step:
        'Show the user both versions and ask which to use. Pass their choice to wisepanel_start.',
    }, null, 2);
  }

  if (outcome.kind === 'no_change_needed') {
    return JSON.stringify({
      ...base,
      next_step: 'No bias found. Use the original question as written.',
    }, null, 2);
  }

  return JSON.stringify({
    ...base,
    next_step: 'Could not produce a safe rewrite. Use the original question as written.',
  }, null, 2);
}

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'wisepanel_start': return handleStart(args);
    case 'wisepanel_poll': return handlePoll(args);
    case 'wisepanel_result': return handleResult(args);
    case 'wisepanel_cancel': return handleCancel(args);
    case 'wisepanel_magic_prompt': return handleMagicPrompt(args);
    case 'wisepanel_publish': return handlePublish(args);
    case 'wisepanel_list_runs': return handleListRuns();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export function getToolDefinitions() { return TOOL_DEFINITIONS; }

export function cleanup() {
  for (const [, abort] of activeStreams) abort.abort();
  activeStreams.clear();
}
