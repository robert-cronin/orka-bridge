import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ExamplePair } from '../setup/state';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
export type SourceId = { agent: string; tests: string };
export type AgentPair = ExamplePair & { source?: SourceId; path?: string };
export function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'object' && value !== null && Object.keys(value).sort().join(',') === 'agent,tests'
    && 'agent' in value && typeof value.agent === 'string' && /^[a-f0-9]{64}$/.test(value.agent)
    && 'tests' in value && typeof value.tests === 'string' && /^[a-f0-9]{64}$/.test(value.tests);
}
export function sameSource(left?: SourceId, right?: SourceId | null): boolean | undefined {
  return left && right ? left.agent === right.agent && left.tests === right.tests : undefined;
}
export async function agentCall(command: 'agent_open' | 'agent_save', content?: string): Promise<AgentPair> {
  if (!isTauri()) throw Error('Open the desktop app to edit your agent.');
  try {
    const value = await invoke<unknown>(command, content === undefined ? {} : { content });
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && ['agent,tests', 'agent,source,tests', 'agent,path,tests', 'agent,path,source,tests'].includes(Object.keys(value).sort().join(','))
      && (!('path' in value) || (typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 32768 && !value.path.includes('\0')))
      && (!('source' in value) || isSourceId(value.source))
      && 'agent' in value && typeof value.agent === 'string'
      && 'tests' in value && typeof value.tests === 'string' && value.tests.length > 0
      && new TextEncoder().encode(value.agent).length <= 1048576
      && new TextEncoder().encode(value.tests).length <= 1048576) return { agent: value.agent, tests: value.tests, ...('source' in value ? { source: value.source as SourceId } : {}), ...('path' in value ? { path: value.path as string } : {}) };
  } catch { /* Never display native paths or file contents from an error. */ }
  throw Error(command === 'agent_open' ? 'Your agent folder could not be opened.' : 'Your changes could not be saved. Your draft is still here.');
}

// Only display unambiguous single-line front matter. The raw editor also accepts
// unfinished YAML; unsupported metadata is omitted, never guessed from the prompt.
export function agentInfo(source?: string): { name?: string; description?: string } {
  const header = source?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  function scalar(key: string) {
    const text = header?.match(new RegExp(`^${key}: +(.+)$`, 'm'))?.[1]?.trim();
    if (!text || /^[>|[\]{&*!#]/.test(text)) return undefined;
    if (text.startsWith('"')) { try { const parsed: unknown = JSON.parse(text); return typeof parsed === 'string' ? parsed : undefined; } catch { return undefined; } }
    if (text.startsWith("'")) return text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : undefined;
    return text.split(/\s+#/)[0];
  }
  const name = scalar('name');
  return { name: name && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined, description: scalar('description') };
}
