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
      'Start a Wisepanel deliberation. Convenes a panel of AI models (Claude, Gemini, Perplexity) ' +
      'to debate a question from assigned perspectives. Returns run_id immediately. ' +
      'After starting, poll with wisepanel_poll every 10-15 seconds. When an agent_response event appears, ' +
      'briefly summarize that panelist\'s key argument to the user before polling again. ' +
      'Each panelist participates in multiple conversation nodes, so total responses will exceed panel size. ' +
      'When status is "completed", provide a final synthesis of all perspectives, ' +
      'then ask the user if they\'d like to publish to the Wisepanel Commons using wisepanel_publish. ' +
      'Do NOT call wisepanel_result after polling — you already have all the data from poll events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question or topic for the panel to deliberate' },
        topology: {
          type: 'string',
          enum: ['tetrahedron', 'octahedron', 'icosahedron'],
          description: 'Panel geometry: tetrahedron (4 panelists), octahedron (6), icosahedron (12). Default: tetrahedron',
        },
        model_group: {
          type: 'string',
          enum: ['mixed', 'fast', 'smart', 'informed'],
          description: 'Model selection: mixed (diverse providers), fast (speed-optimized), smart (reasoning-optimized), informed (search-augmented). Default: mixed',
        },
        rounds: { type: 'number', minimum: 1, maximum: 5, description: 'Deliberation rounds (1-5). More rounds deepen the debate. Default: 1' },
        context: { type: 'string', description: 'Additional context to frame the deliberation' },
        short_responses: { type: 'boolean', description: 'Request concise panelist responses. Default: false' },
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
  return {
    question: args.question as string,
    topology: args.topology as string | undefined,
    model_group: args.model_group as string | undefined,
    rounds: args.rounds as number | undefined,
    context: args.context as string | undefined,
    short_responses: args.short_responses as boolean | undefined,
  };
}

// handleDeliberate commented out — synchronous blocking tool superseded by start+poll flow.
// async function handleDeliberate(args: Record<string, unknown>): Promise<string> {
//   const options = extractOptions(args);
//   const events: SSEEvent[] = [];
//   const abort = new AbortController();
//   const timeout = setTimeout(() => abort.abort(), 5 * 60_000);
//   try {
//     await client.startStream(options, (event) => { events.push(event as SSEEvent); }, abort.signal);
//   } finally { clearTimeout(timeout); }
//   const final = events.find(e => e.type === 'final');
//   if (final) return formatFinalResult(final);
//   const error = events.find(e => e.type === 'error');
//   if (error) return `Error: ${error.message || error.error || 'Unknown error'}`;
//   const responses = events.filter(e => e.type === 'agent_response');
//   if (responses.length) return responses.map(formatAgentResponse).join('\n\n---\n\n');
//   return 'Deliberation completed but no responses received.';
// }

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

export async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'wisepanel_start': return handleStart(args);
    case 'wisepanel_poll': return handlePoll(args);
    case 'wisepanel_result': return handleResult(args);
    case 'wisepanel_cancel': return handleCancel(args);
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
