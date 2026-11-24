import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readForm } from '../designer/agent-form';
import { assistantFailure, assistantInstructions, assistantName, ensureAssistant } from './assistant';

const id = '3b2b93c4-375c-4815-9717-39852a96e414';
// Native's created_seed for a new agent.
const seed = '---\nname: "bridge-assistant"\nmodel: "gpt-5.6-terra"\nkmx:\n  schemaVersion: 1\n  runtime: orka\n---\n\n';
const source = { agent: 'a'.repeat(64), tests: 'b'.repeat(64) };
let calls: { command: string; args: Record<string, unknown> }[] = [];
function native({ existing = false, tools = ['web_search', 'web_fetch'], catalog = true, content = seed } = {}) {
  calls = [];
  vi.stubGlobal('isTauri', true);
  mockIPC((command, args) => {
    calls.push({ command, args: args as Record<string, unknown> });
    if (command === 'agents_list') return existing ? [{ id, name: assistantName, path: null, available: true }] : [];
    if (command === 'workspace_catalog') {
      if (!catalog) throw 'catalogUnavailable';
      return { defaultModel: 'gpt-5.6-terra', models: { state: 'ready', items: [{ id: 'gpt-5.6-terra' }] }, tools: { state: 'ready', items: tools.map(name => ({ kind: 'builtin', name, description: name })) } };
    }
    if (command === 'agent_create') return id;
    if (command === 'agent_open') return { documentId: id, name: assistantName, agent: content, tests: 'Checks', source };
    if (command === 'agent_save') return { documentId: id, name: assistantName, agent: (args as { content: string }).content, tests: 'Checks', source };
    throw Error(`unexpected ${command}`);
  });
}
beforeEach(() => { calls = []; });
afterEach(() => { clearMocks(); vi.unstubAllGlobals(); });
const saved = () => calls.find(call => call.command === 'agent_save')!.args.content as string;

test('creates the assistant once, with its instructions and only the tools the workspace offers', async () => {
  native({ tools: ['web_fetch', 'web_search', 'file_read'] });
  expect(await ensureAssistant()).toBe(id);
  expect(calls.find(call => call.command === 'agent_create')!.args).toEqual({ name: assistantName, model: 'gpt-5.6-terra' });
  const form = readForm(saved());
  expect(form.instructions).toBe(assistantInstructions(['web_search', 'web_fetch']));
  expect(form.tools.map(tool => tool.name).sort()).toEqual(['web_fetch', 'web_search']);
  // The save is fenced on the seed native just created.
  expect(calls.find(call => call.command === 'agent_save')!.args.expectedSource).toEqual(source);
});

const edited = '---\nname: "bridge-assistant"\nmodel: "gpt-5.6-terra"\nkmx:\n  schemaVersion: 1\n  runtime: orka\n---\n\nMy own instructions.';
test('reuses an existing assistant without writing anything, even one the person changed', async () => {
  native({ existing: true, content: edited });
  expect(await ensureAssistant()).toBe(id);
  expect(calls.some(call => call.command === 'agent_create' || call.command === 'agent_save')).toBe(false);
});

test('a person’s own bridge-assistant with only a description is left alone', async () => {
  native({ existing: true, content: '---\nname: "bridge-assistant"\ndescription: "Mine"\nmodel: "gpt-5.6-terra"\nkmx:\n  schemaVersion: 1\n  runtime: orka\n---\n\n' });
  expect(await ensureAssistant()).toBe(id);
  expect(calls.some(call => call.command === 'agent_save')).toBe(false);
});

test('fills an assistant an earlier attempt created but couldn’t fill, fenced on its current source', async () => {
  native({ existing: true });
  expect(await ensureAssistant()).toBe(id);
  expect(calls.some(call => call.command === 'agent_create')).toBe(false);
  expect(readForm(saved()).instructions).toBe(assistantInstructions(['web_search', 'web_fetch']));
  expect(calls.find(call => call.command === 'agent_save')!.args.expectedSource).toEqual(source);
});

test('the instructions only mention tools the assistant was given', () => {
  expect(assistantInstructions(['web_fetch'])).not.toMatch(/search the web|Use code/);
  expect(assistantInstructions(['web_fetch'])).toMatch(/read the page/);
  expect(assistantInstructions(['web_search', 'web_fetch', 'code_exec'])).toMatch(/search the web[\s\S]*Use code/);
});

test('concurrent callers share one creation', async () => {
  native();
  expect(await Promise.all([ensureAssistant(), ensureAssistant()])).toEqual([id, id]);
  expect(calls.filter(call => call.command === 'agent_create')).toHaveLength(1);
});

test('without a readable catalog it adds only web_fetch', async () => {
  native({ catalog: false });
  await ensureAssistant();
  expect(readForm(saved()).tools.map(tool => tool.name)).toEqual(['web_fetch']);
});

test('failures are reported as a kind, never as native text', async () => {
  vi.stubGlobal('isTauri', true);
  mockIPC(command => { if (command === 'agents_list') throw Error('SECRET_MARKER'); throw Error(command); });
  const error = await ensureAssistant().catch((e: unknown) => e);
  expect(assistantFailure(error)).toBe('listUnreadable');
  expect(String(error)).not.toContain('SECRET_MARKER');
  expect(assistantFailure(Error('SECRET_MARKER'))).toBe('notSaved');
});
