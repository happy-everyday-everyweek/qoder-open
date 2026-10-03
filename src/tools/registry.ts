import type { ToolDefinition, ToolRegistry } from './types.ts';

export function createRegistry(definitions: ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const def of definitions) {
    if (byName.has(def.name)) {
      throw new Error(`duplicate tool name: ${def.name}`);
    }
    byName.set(def.name, def);
  }

  return {
    list(): ToolDefinition[] {
      return [...byName.values()];
    },
    get(name: string): ToolDefinition | undefined {
      return byName.get(name);
    },
    schemas() {
      return [...byName.values()].map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      }));
    },
  };
}
