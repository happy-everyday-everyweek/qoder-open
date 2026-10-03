export interface AppConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
  maxTurns: number;
  compactThreshold: number;
  skipConfirmation: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const baseUrl = overrides.baseUrl ?? env['QODER_OPEN_BASE_URL'] ?? 'https://api.openai.com/v1';
  const apiKey = overrides.apiKey ?? env['QODER_OPEN_API_KEY'] ?? '';
  const model = overrides.model ?? env['QODER_OPEN_MODEL'] ?? 'gpt-4o-mini';
  const provider = overrides.provider ?? env['QODER_OPEN_PROVIDER'] ?? 'openai-compatible';
  const maxTurns = overrides.maxTurns ?? Number.parseInt(env['QODER_OPEN_MAX_TURNS'] ?? '40', 10);
  const compactThreshold =
    overrides.compactThreshold ?? Number.parseInt(env['QODER_OPEN_COMPACT_TOKENS'] ?? '60000', 10);
  const skipConfirmation = overrides.skipConfirmation ?? env['QODER_OPEN_YES'] === '1';

  return {
    baseUrl,
    apiKey,
    model,
    provider,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 40,
    compactThreshold:
      Number.isFinite(compactThreshold) && compactThreshold > 1000 ? compactThreshold : 60_000,
    skipConfirmation,
  };
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a software engineering agent working directly in the user\u0027s workspace.',
  'Work in small steps: inspect the repository before editing, prefer targeted edits over rewrites,',
  'and verify your changes by running the project\u0027s own build, test and lint commands.',
  'Use the todo list to keep track of multi-step work and update it as you go.',
  'Report accurately what you verified versus what you assumed.',
].join('\n');
