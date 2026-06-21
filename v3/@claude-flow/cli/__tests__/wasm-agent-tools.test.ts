/**
 * Tests for WASM Agent MCP Tools
 *
 * Validates all 10 MCP tool handlers work correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the agent-wasm module ───────────────────────────────

const mockAgentInfo = {
  id: 'wasm-agent-1-test',
  state: 'idle' as const,
  config: {},
  model: 'test-model',
  turnCount: 0,
  fileCount: 0,
  isStopped: false,
  createdAt: '2026-03-17T00:00:00.000Z',
};

vi.mock('../src/ruvector/agent-wasm.js', () => ({
  isAgentWasmAvailable: vi.fn(),
  initAgentWasm: vi.fn(),
  createWasmAgent: vi.fn(),
  promptWasmAgent: vi.fn(),
  executeWasmTool: vi.fn(),
  getWasmAgent: vi.fn(),
  listWasmAgents: vi.fn(),
  terminateWasmAgent: vi.fn(),
  getWasmAgentState: vi.fn(),
  getWasmAgentTools: vi.fn(),
  getWasmAgentTodos: vi.fn(),
  exportWasmState: vi.fn(),
  createWasmMcpServer: vi.fn(),
  listGalleryTemplates: vi.fn(),
  getGalleryCount: vi.fn(),
  getGalleryCategories: vi.fn(),
  searchGalleryTemplates: vi.fn(),
  getGalleryTemplate: vi.fn(),
  createAgentFromTemplate: vi.fn(),
  buildRvfContainer: vi.fn(),
  buildRvfFromTemplate: vi.fn(),
}));

import { wasmAgentTools } from '../src/mcp-tools/wasm-agent-tools.js';
import * as AgentWasm from '../src/ruvector/agent-wasm.js';

// ── Helper ───────────────────────────────────────────────────

function findTool(name: string) {
  const tool = wasmAgentTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  return findTool(name).handler(args);
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ── Tests ────────────────────────────────────────────────────

describe('wasm-agent-tools MCP', () => {
  // mockReset: true in vitest.config.ts resets all mock implementations before each test.
  // Re-apply implementations here so every test starts with the expected mock behaviour.
  beforeEach(() => {
    vi.mocked(AgentWasm.createWasmAgent).mockResolvedValue({ ...mockAgentInfo });
    vi.mocked(AgentWasm.promptWasmAgent).mockResolvedValue('Agent response');
    vi.mocked(AgentWasm.executeWasmTool).mockResolvedValue({ success: true, output: 'ok' });
    vi.mocked(AgentWasm.listWasmAgents).mockReturnValue([{ ...mockAgentInfo }]);
    vi.mocked(AgentWasm.terminateWasmAgent).mockReturnValue(true);
    vi.mocked(AgentWasm.getWasmAgentTools).mockReturnValue(['read_file', 'write_file']);
    vi.mocked(AgentWasm.exportWasmState).mockReturnValue('{"state":"exported"}');
    vi.mocked(AgentWasm.listGalleryTemplates).mockResolvedValue([{ id: 'coder', name: 'Coder Agent' }]);
    vi.mocked(AgentWasm.searchGalleryTemplates).mockResolvedValue([{ id: 'coder', name: 'Coder Agent', relevance: 0.7 }]);
    vi.mocked(AgentWasm.createAgentFromTemplate).mockResolvedValue({ ...mockAgentInfo, id: 'wasm-agent-2-tpl' });
  });
  it('exports 10 tools', () => {
    expect(wasmAgentTools).toHaveLength(10);
  });

  it('all tools have required fields', () => {
    for (const tool of wasmAgentTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  describe('wasm_agent_create', () => {
    it('creates with config', async () => {
      const data = parseResult(await callTool('wasm_agent_create', { instructions: 'Test' }));
      expect(data.success).toBe(true);
      expect(data.agent.id).toBe('wasm-agent-1-test');
    });

    it('creates from template', async () => {
      const data = parseResult(await callTool('wasm_agent_create', { template: 'coder' }));
      expect(data.success).toBe(true);
      expect(data.source).toBe('gallery');
    });
  });

  it('wasm_agent_prompt returns response', async () => {
    const result = await callTool('wasm_agent_prompt', { agentId: 'test', input: 'Hello' });
    expect(result.content[0].text).toBe('Agent response');
  });

  it('wasm_agent_tool executes tool', async () => {
    const result = await callTool('wasm_agent_tool', { agentId: 'test', toolName: 'read_file', toolInput: { path: 'x' } });
    const text = result.content[0].text;
    expect(text).toContain('success');
  });

  it('wasm_agent_list lists agents', async () => {
    const data = parseResult(await callTool('wasm_agent_list'));
    expect(data.count).toBe(1);
  });

  it('wasm_agent_terminate terminates', async () => {
    const data = parseResult(await callTool('wasm_agent_terminate', { agentId: 'test' }));
    expect(data.success).toBe(true);
  });

  it('wasm_agent_files lists files', async () => {
    const result = await callTool('wasm_agent_files', { agentId: 'test' });
    expect(result.content[0].text).toContain('read_file');
  });

  it('wasm_agent_export exports state', async () => {
    const result = await callTool('wasm_agent_export', { agentId: 'test' });
    expect(result.content[0].text).toBe('{"state":"exported"}');
  });

  it('wasm_gallery_list lists templates', async () => {
    const data = parseResult(await callTool('wasm_gallery_list'));
    expect(data.count).toBe(1);
    expect(data.templates[0].id).toBe('coder');
  });

  it('wasm_gallery_search finds templates', async () => {
    const data = parseResult(await callTool('wasm_gallery_search', { query: 'code' }));
    expect(data.count).toBe(1);
  });

  it('wasm_gallery_create creates from template', async () => {
    const data = parseResult(await callTool('wasm_gallery_create', { template: 'coder' }));
    expect(data.success).toBe(true);
    expect(data.template).toBe('coder');
  });
});
