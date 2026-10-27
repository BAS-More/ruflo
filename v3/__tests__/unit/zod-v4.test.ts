/** Regression coverage for Zod 4's record, issue and pre-parse default APIs. */
import { describe, expect, it } from 'vitest';
import { validateAgentConfig, validateMCPServerConfig, ConfigValidator } from '../../@claude-flow/shared/src/core/config/validator.js';
import { NetworkRouteInputSchema } from '../../@claude-flow/browser/src/domain/types.js';
import { FormulaSchema } from '../../plugins/gastown-bridge/src/types.js';
import { sanitizeBeadOutput } from '../../plugins/gastown-bridge/src/sanitizers.js';
import { HierarchyNodeSchema } from '../../plugins/hyperbolic-reasoning/src/types.js';
import { PrimeRadiantConfigSchema, AgentStateSchema, MemoryEntrySchema } from '../../plugins/prime-radiant/src/schemas.js';
import { AgentStateSchema as ToolAgentStateSchema } from '../../plugins/prime-radiant/src/tools/types.js';
import { DependencyResolveInputSchema } from '../../plugins/quantum-optimizer/src/types.js';

describe('Zod 4 schema migration', () => {
  const metadata = { enabled: true, count: 2, nested: { label: 'value' } };

  it('preserves arbitrary string-keyed metadata and applies agent defaults', () => {
    const result = validateAgentConfig({ id: 'agent-1', name: 'Agent', type: 'coder', metadata });
    expect(result.success).toBe(true);
    expect(result.data?.metadata).toEqual(metadata);
    expect(result.data?.maxConcurrentTasks).toBe(5);
  });

  it('reports invalid configuration issues rather than throwing a TypeError', () => {
    const result = validateAgentConfig({ id: 42 });
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'id', code: 'invalid_type' }),
    ]));
    expect(() => ConfigValidator.validateAgentOrThrow({ id: 42 }))
      .toThrow('Invalid agent configuration');
  });

  it('validates boolean capability dictionaries', () => {
    const config = { transport: { type: 'stdio' }, capabilities: { experimental: { feature: true } } };
    expect(validateMCPServerConfig(config).data?.capabilities?.experimental).toEqual({ feature: true });
    expect(validateMCPServerConfig({ ...config, capabilities: { experimental: { feature: 'yes' } } }).success).toBe(false);
  });

  it('validates browser header dictionaries', () => {
    expect(NetworkRouteInputSchema.parse({ urlPattern: '*', headers: { accept: 'text/plain' } }).headers)
      .toEqual({ accept: 'text/plain' });
    expect(NetworkRouteInputSchema.safeParse({ urlPattern: '*', headers: { accept: 42 } }).success).toBe(false);
  });

  it('preserves Gas Town formula variables and metadata', () => {
    const vars = { target: { name: 'target', required: true } };
    const result = FormulaSchema.parse({ name: 'build', description: '', type: 'workflow', version: 1, vars, metadata });
    expect(result.vars).toEqual(vars);
    expect(result.metadata).toEqual(metadata);
    expect(FormulaSchema.safeParse({ ...result, vars: { target: 42 } }).success).toBe(false);
  });

  it('formats invalid Gas Town output through the domain error path', () => {
    try {
      sanitizeBeadOutput('{"id":42}');
      expect.fail('invalid bead must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/parse/i);
    }
  });

  it('preserves plugin metadata records', () => {
    expect(HierarchyNodeSchema.parse({ id: 'root', parent: null, features: metadata }).features).toEqual(metadata);
    expect(AgentStateSchema.parse({ agentId: 'agent', embedding: [1], metadata }).metadata).toEqual(metadata);
    expect(ToolAgentStateSchema.parse({ agentId: 'agent', embedding: [1], metadata }).metadata).toEqual(metadata);
    expect(MemoryEntrySchema.parse({ key: 'key', content: 'text', embedding: [1], metadata }).metadata).toEqual(metadata);
  });

  it('parses nested default values rather than short-circuiting to empty objects', () => {
    expect(PrimeRadiantConfigSchema.parse({})).toEqual({
      coherence: { warnThreshold: 0.3, rejectThreshold: 0.7, cacheEnabled: true, cacheTTL: 60000 },
      spectral: { stabilityThreshold: 0.1, maxMatrixSize: 1000 },
      causal: { maxBackdoorPaths: 10, confidenceThreshold: 0.8 },
    });
    expect(PrimeRadiantConfigSchema.parse({ coherence: { cacheTTL: 1000 } }).coherence.cacheTTL).toBe(1000);
  });

  it('validates dependency and lockfile string dictionaries', () => {
    const input = { packages: [{ name: 'app', version: '1.0.0', dependencies: { lib: '^2.0.0' } }], constraints: { lockfile: { lib: '2.0.1' } } };
    const parsed = DependencyResolveInputSchema.parse(input);
    expect(parsed.packages[0].dependencies).toEqual({ lib: '^2.0.0' });
    expect(parsed.constraints?.lockfile).toEqual({ lib: '2.0.1' });
    expect(DependencyResolveInputSchema.safeParse({ ...input, constraints: { lockfile: { lib: 2 } } }).success).toBe(false);
  });
});
