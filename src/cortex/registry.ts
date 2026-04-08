/**
 * Cortex Registry — central lookup for agents and tools.
 *
 * Agents are registered at module load time. The engine resolves them by id
 * when handling an event or chat message. Tools are registered alongside the
 * agent that owns them so the engine can build per-agent allowlists.
 *
 * The registry is intentionally a simple in-memory map. There are no plans
 * to persist agent definitions to the database — they're code, not data.
 * Agent rollout is managed via deploy, not via a runtime config.
 */

import type { CortexAgentDefinition, CortexToolDefinition } from "./protocol.js";

const agents = new Map<string, CortexAgentDefinition>();

/** Register an agent. Throws on duplicate id so accidental shadowing surfaces immediately. */
export function registerAgent(agent: CortexAgentDefinition): void {
  if (agents.has(agent.id)) {
    throw new Error(
      `Cortex: agent "${agent.id}" is already registered. Duplicate registration usually means an import cycle or two files defining the same id.`,
    );
  }
  agents.set(agent.id, agent);
}

/** Look up an agent by id. Returns undefined for unknown ids. */
export function getAgent(id: string): CortexAgentDefinition | undefined {
  return agents.get(id);
}

/** Iterate every registered agent. Useful for the activity log + admin views. */
export function listAgents(): CortexAgentDefinition[] {
  return [...agents.values()];
}

/** Find a tool by name within an agent's tool set. */
export function getAgentTool(agentId: string, toolName: string): CortexToolDefinition | undefined {
  const agent = agents.get(agentId);
  if (!agent) return undefined;
  return agent.tools.find((t) => t.name === toolName);
}

/**
 * Reset the registry. ONLY for use in tests — production code should never
 * call this. Exported here so tests can rebuild the registry between runs
 * without leaking agent state across files.
 */
export function __resetRegistry__(): void {
  agents.clear();
}
