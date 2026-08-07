export interface CommonsPublishData {
  runId?: string;
  topic: string;
  topologyType: string;
  numRounds: number;
  modelGroup: string;
  agentCount: number;
  totalTokens?: number;
  durationSeconds?: number;
  responses: Array<{
    round: number;
    agent: string;
    role: string;
    message: string;
    model?: string;
    provider?: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface MagicPromptResponse {
  success: boolean;
  outcome:
    | { kind: 'transformed'; text: string }
    | { kind: 'no_change_needed'; text: string }
    | { kind: 'fail_closed'; text: string; failures: Array<{ gate: string; index: number; reason: string }> };
  llm: { provider: string; model: string; tier: string; latencyMs: number };
  charge: { charged: boolean; usdAmount: number; remainingBalance: number; error?: string };
  metaPromptVersion?: string;
}

export interface CommonsPublishResult {
  slug: string;
  url: string;
  existing: boolean;
}

export interface StreamOptions {
  question: string;
  topology?: string;
  model_group?: string;
  rounds?: number;
  context?: string;
  compression?: string;
  short_responses?: boolean;
  show_and_audit_reasoning?: boolean;
  web_search_enabled?: boolean;
}

export class PublishError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
    public details?: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export class WisepanelClient {
  private apiUrl: string;
  private apiKey: string;

  constructor() {
    this.apiUrl = process.env.WISEPANEL_API_URL || 'https://api.wisepanel.ai';
    const key = process.env.WISEPANEL_API_KEY;
    if (!key) throw new Error('WISEPANEL_API_KEY environment variable is required. Generate one at wisepanel.ai/settings');
    this.apiKey = key;
  }

  private getToken(): string {
    return this.apiKey;
  }

  async startStream(
    options: StreamOptions,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = {
      topic: options.context
        ? `${options.context}\n\n${options.question}`
        : options.question,
      session_id: `mcp-${Date.now()}`,
      polyhedron_type: options.topology || 'small',
      num_rounds: options.rounds || 1,
      model_group: options.model_group || 'smart',
      short_response_mode: options.short_responses || false,
      context_strategy: options.compression || 'aggressive',
      // Pass undefined through rather than coercing to false. The API treats an
      // explicit false as an opt-out and an absent field as "use the default"
      // (show_and_audit_reasoning defaults true server-side). Coercing here made
      // every MCP run silently opt out of audit scaffolding while the website,
      // which omits the field, got it — same backend, opposite behavior.
      show_and_audit_reasoning: options.show_and_audit_reasoning,
      web_search_enabled: options.web_search_enabled,
    };

    const res = await fetch(
      `${this.apiUrl}/v1/context-engine/orchestrator/runs/start-stream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.getToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      }
    );

    if (!res.ok) {
      throw new Error(`API ${res.status}: ${await res.text()}`);
    }
    if (!res.body) throw new Error('No response body');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split('\n\n');
      buf = parts.pop() || '';

      for (const part of parts) {
        const dataLines: string[] = [];
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        }
        const data = dataLines.join('');
        if (data) {
          try { onEvent(JSON.parse(data)); } catch { /* skip malformed */ }
        }
      }
    }
  }

  async magicPrompt(topic: string): Promise<MagicPromptResponse> {
    const res = await fetch(`${this.apiUrl}/v1/magic-prompt/transform`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ topic }),
    });

    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }

    if (!res.ok) {
      // 402 and 500 still carry a fail_closed outcome whose text is the original
      // topic, so callers can fall back to it rather than losing the input.
      const msg = (parsed?.message as string) || (parsed?.error as string) || text;
      throw new Error(`Magic Prompt failed (${res.status}): ${msg}`);
    }
    return parsed as unknown as MagicPromptResponse;
  }

  async publishToCommons(data: CommonsPublishData): Promise<CommonsPublishResult> {
    const res = await fetch(`${this.apiUrl}/v1/commons/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      throw new PublishError(
        (parsed?.message as string) || (parsed?.error as string) || `Publish failed (${res.status}): ${text}`,
        res.status,
        (parsed?.code as string) || undefined,
        parsed,
      );
    }
    return res.json();
  }

  async cancelRun(runId: string): Promise<void> {
    const res = await fetch(
      `${this.apiUrl}/v1/context-engine/orchestrator/runs/${runId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.getToken()}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
  }
}
