import { readWorkspaceCatalog } from '../catalog';
import { agentCall } from '../designer/agent-api';
import { addTool, changeDescription, changeInstructions, readForm } from '../designer/agent-form';
import { createDocument, listDocuments } from '../designer/documents-api';

// Bridge's built-in assistant is an ordinary agent in the person's agent folder, so it can be
// read, changed or deleted like any other. Home recognises it by this reserved name.
export const assistantName = 'bridge-assistant';
export const assistantLabel = 'Bridge';
export const assistantDescription = 'Bridge’s built-in assistant. Ask it anything.';
// Tried in this order; only tools the workspace offers are added.
export const assistantTools = ['web_search', 'web_fetch', 'code_exec'] as const;
// The instructions only mention what the assistant can actually do with the tools it was given.
export function assistantInstructions(tools: readonly string[]) {
  const web = tools.includes('web_search') ? 'When a question needs current or specific information, search the web and read the pages you rely on. Say which pages you used.'
    : tools.includes('web_fetch') ? 'When someone gives you a link, read the page before answering. Say which pages you used.' : undefined;
  return [
    'You are Bridge, the assistant built into the Bridge desktop app. Help with everyday questions and small jobs.',
    'Answer plainly and briefly. Use short lists when they make an answer easier to scan.',
    web,
    tools.includes('code_exec') ? 'Use code for calculations and for working with data, and give the result in words.' : undefined,
    'If you can’t do something, or a tool fails, say so. Don’t guess or make up sources.',
    'If someone wants an agent of their own for a repeated job, tell them they can make one in Designer with New agent.',
  ].filter(Boolean).join('\n');
}

// Why the assistant couldn't be set up, as a finite kind; the words live in one table.
export type AssistantFailure = 'listUnreadable' | 'fileUnavailable' | 'notSaved';
export const assistantFailureCopy: Record<AssistantFailure, string> = {
  listUnreadable: 'Bridge couldn’t read your agents.',
  fileUnavailable: 'Its file couldn’t be opened. Check it in Designer.',
  notSaved: 'Its file couldn’t be created or saved.',
};
export class AssistantError extends Error {
  constructor(readonly kind: AssistantFailure) { super(assistantFailureCopy[kind]); }
}
export function assistantFailure(error: unknown): AssistantFailure {
  return error instanceof AssistantError ? error.kind : 'notSaved';
}

let pending: Promise<string> | undefined;
// Returns the assistant's document id, creating and filling it the first time. Concurrent callers share one creation.
export function ensureAssistant(): Promise<string> {
  pending ??= create().finally(() => { pending = undefined; });
  return pending;
}

async function create(): Promise<string> {
  const list = await listDocuments();
  if (!list) throw new AssistantError('listUnreadable');
  const existing = list.find(entry => entry.name === assistantName);
  if (existing && !existing.available) throw new AssistantError('fileUnavailable');
  const catalog = await readWorkspaceCatalog(new AbortController().signal);
  const id = existing?.id ?? await createDocument(assistantName, catalog?.defaultModel ?? undefined);
  const seed = await agentCall('agent_open', undefined, id);
  // Only a bare seed is filled: a new file, or one an earlier attempt created but couldn't fill.
  // A file with instructions, tools or a description is someone's agent, and is left alone.
  const form = readForm(seed.agent);
  if (form.instructions.trim() || form.tools.length || form.description?.trim()) return id;
  const offered = catalog?.tools.state === 'ready'
    ? new Set(catalog.tools.items.filter(tool => tool.kind === 'builtin' && tool.available !== false).map(tool => tool.name))
    : undefined;
  // Without a readable catalog, web_fetch is the one tool the bundled example proves the workspace runs.
  const tools = offered ? assistantTools.filter(name => offered.has(name)) : ['web_fetch'];
  let agent = changeDescription(changeInstructions(seed.agent, assistantInstructions(tools)), assistantDescription);
  for (const tool of tools) agent = addTool(agent, tool);
  // Fenced on the source just read, so a concurrent edit makes this save fail rather than overwrite it.
  await agentCall('agent_save', agent, id, seed.source);
  return id;
}
