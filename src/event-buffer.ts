import type { CommonsPublishData } from './client.js';

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

interface RunState {
  events: SSEEvent[];
  lastPollIndex: number;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  agentsTotal: number;
  agentsResponded: number;
  estimatedCost: number;
  finalResult: SSEEvent | null;
  topic: string;
}

const INTERESTING_TYPES = new Set([
  'agent_response', 'phase_start', 'conversation_complete',
  'final', 'error', 'cost_estimation', 'agents_created',
  'billing_complete', 'roles_generated',
]);

export class EventBuffer {
  private runs = new Map<string, RunState>();
  private waiters = new Map<string, Array<() => void>>();

  createRun(runId: string): void {
    this.runs.set(runId, {
      events: [],
      lastPollIndex: 0,
      status: 'running',
      agentsTotal: 0,
      agentsResponded: 0,
      estimatedCost: 0,
      finalResult: null,
      topic: '',
    });
  }

  addEvent(runId: string, event: SSEEvent): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.events.push(event);

    switch (event.type) {
      case 'connection':
        if (event.topic) run.topic = event.topic as string;
        break;
      case 'agents_created':
        run.agentsTotal = (event.count as number) ?? 0;
        break;
      case 'agent_response':
        run.agentsResponded++;
        break;
      case 'cost_estimation':
        run.estimatedCost = (event.estimated_cost as number) ?? 0;
        break;
      case 'final':
        run.status = event.status === 'canceled' ? 'canceled' : 'completed';
        run.finalResult = event;
        if (!run.topic) {
          const conv = event.conversation as Record<string, unknown> | undefined;
          if (conv?.topic) run.topic = conv.topic as string;
        }
        break;
      case 'error':
        run.status = 'failed';
        break;
      case 'cancelled':
        run.status = 'canceled';
        break;
    }

    if (INTERESTING_TYPES.has(event.type) || event.type === 'cancelled') {
      this.notifyWaiters(runId);
    }
  }

  /** Wait up to timeoutMs for new interesting events. Resolves immediately if events are already pending. */
  waitForEvents(runId: string, timeoutMs = 15_000): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve();

    const hasNew = run.events
      .slice(run.lastPollIndex)
      .some(e => INTERESTING_TYPES.has(e.type));
    if (hasNew || run.status !== 'running') return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeWaiter(runId, settle);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      if (!this.waiters.has(runId)) this.waiters.set(runId, []);
      this.waiters.get(runId)!.push(settle);
    });
  }

  private removeWaiter(runId: string, fn: () => void): void {
    const list = this.waiters.get(runId);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.waiters.delete(runId);
  }

  private notifyWaiters(runId: string): void {
    const list = this.waiters.get(runId);
    if (!list) return;
    const copy = [...list];
    this.waiters.delete(runId);
    for (const fn of copy) fn();
  }

  getNewEvents(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;

    const newEvents = run.events
      .slice(run.lastPollIndex)
      .filter(e => INTERESTING_TYPES.has(e.type));
    run.lastPollIndex = run.events.length;

    return {
      status: run.status,
      newEvents,
      agentsResponded: run.agentsResponded,
      agentsTotal: run.agentsTotal,
    };
  }

  getResult(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return { status: run.status, result: run.finalResult };
  }

  getRunInfo(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      status: run.status,
      agentsTotal: run.agentsTotal,
      agentsResponded: run.agentsResponded,
      estimatedCost: run.estimatedCost,
    };
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  getPublishData(runId: string): CommonsPublishData | null {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'completed' || !run.finalResult) return null;

    const final = run.finalResult;
    const conv = final.conversation as Record<string, unknown> | undefined;
    if (!conv) return null;

    // Run ID from connection event
    const connectionEvent = run.events.find(e => e.type === 'connection');
    const apiRunId = (connectionEvent?.run_id as string) || runId;

    // Topology — try known field names, fall back to inference from agent count
    const topologyType = (conv.polyhedron_type as string) ||
      (conv.topology_type as string) ||
      (conv.topology as string) ||
      inferTopology(run.agentsTotal);

    // Build flat responses array from round_results (canonical structure)
    const responses: CommonsPublishData['responses'] = [];
    const roundResults = (conv.round_results as Array<Record<string, unknown>>) || [];

    for (const round of roundResults) {
      const nodeResults = (round.node_results as Array<Record<string, unknown>>) || [];
      for (const node of nodeResults) {
        const roundNum = (node.round as number) || 1;
        const nodeResponses = (node.responses as Array<Record<string, unknown>>) || [];
        for (const r of nodeResponses) {
          responses.push({
            round: roundNum,
            agent: (r.agent_name as string) || '',
            role: (r.agent_role as string) || '',
            message: stripThinkTags((r.message as string) || ''),
            model: (r.model as string) || undefined,
            provider: (r.provider as string) || undefined,
          });
        }
      }
    }

    return {
      runId: apiRunId,
      topic: (conv.topic as string) || '',
      topologyType,
      numRounds: (conv.total_rounds as number) || 1,
      modelGroup: (conv.model_group as string) || 'mixed',
      agentCount: run.agentsTotal,
      totalTokens: (conv.total_tokens as number) || undefined,
      durationSeconds: (conv.duration_seconds as number) || (conv.duration as number) || undefined,
      responses,
    };
  }

  listRuns(): Array<{ runId: string; status: string; topic: string; agentsTotal: number; agentsResponded: number }> {
    const result: Array<{ runId: string; status: string; topic: string; agentsTotal: number; agentsResponded: number }> = [];
    for (const [runId, run] of this.runs) {
      result.push({
        runId,
        status: run.status,
        topic: run.topic,
        agentsTotal: run.agentsTotal,
        agentsResponded: run.agentsResponded,
      });
    }
    return result;
  }

  setStatus(runId: string, status: RunState['status']): void {
    const run = this.runs.get(runId);
    if (run) run.status = status;
  }
}

function stripThinkTags(message: string): string {
  return message.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function inferTopology(agentCount: number): string {
  if (agentCount <= 4) return 'small';
  if (agentCount <= 6) return 'medium';
  return 'large';
}
