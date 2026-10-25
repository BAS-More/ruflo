/**
 * V3 MCP Tool-Input Array Limits
 *
 * Upper bounds for every array a v3 MCP tool accepts. Each value is used twice:
 * by the zod schema (`.max(N)`) and by the JSON inputSchema (`maxItems: N`) that
 * Ajv checks in the tool registry, so both must come from here to stay in sync.
 *
 * Without these, a single tools/call can carry millions of items and make the
 * server spend seconds of CPU and gigabytes of heap before any handler runs.
 */

export const MCP_ARRAY_LIMITS = {
  /** Tags stored on a memory entry or session */
  tags: 50,
  /** Tags used as a filter; filter cost grows with each tag */
  tagFilter: 20,
  /** Task IDs a task depends on */
  dependencies: 100,
  /** Capabilities a single agent requires */
  capabilities: 50,
  /** Capabilities a swarm advertises (a superset of its agents') */
  swarmCapabilities: 100,
  /** Agent types to prefer or scale */
  agentTypes: 100,
  /** Component names for a health check */
  healthComponents: 20,
  /** Component names for metrics (an enum of 5) */
  metricsComponents: 5,
} as const;
