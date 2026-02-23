#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getToolDefinitions, handleToolCall, cleanup } from './tools.js';

const server = new Server(
  { name: 'Wisepanel', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleToolCall(name, args || {});
    return { content: [{ type: 'text', text: result }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
