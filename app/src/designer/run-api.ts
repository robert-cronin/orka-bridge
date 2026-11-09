import { invoke, isTauri } from '@tauri-apps/api/core';
import { isSourceId, type SourceId } from './agent-api';
export type Verdict = 'passed' | 'failed' | 'unknown';
type Assertion = { id: string; kind: 'contains' | 'toolCalled'; verdict: Verdict };
type Case = { id: string; phase: string; answer: string | null; completedTools: string[]; assertions: Assertion[]; verdict: Verdict };
type Receipt = { kind: 'Agent' | 'Task'; name: string; uid: string };
export const errors = {
  session: 'The running local VM is not available for Run.',
  source: 'Check the format of your saved agent and check files.',
  model: 'Connect the local VM model in Clusters before running the example.',
  submit: 'Submission was not confirmed. A named resource may still exist; it was not retried.',
  observe: 'Observation did not finish. The acknowledged Task may still be running.',
} as const;
export type RunSnapshot = { state: 'idle' | 'running' | 'complete' | 'unknown'; canRun: boolean; modelConnected?: boolean; source?: SourceId | null; sourceCurrent?: boolean; report: { cases: Case[]; verdict: Verdict } | null; acknowledged: Receipt[]; pending: Omit<Receipt, 'uid'> | null; error: keyof typeof errors | null };
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const verdict = (value: unknown): value is Verdict => value === 'passed' || value === 'failed' || value === 'unknown';
function valid(value: unknown): value is RunSnapshot {
  const keys = ['state', 'canRun', 'report', 'acknowledged', 'pending', 'error'];
  if (typeof value === 'object' && value !== null) {
    if ('source' in value) keys.push('source');
    if ('modelConnected' in value) keys.push('modelConnected');
  }
  if (!record(value, keys) || ('modelConnected' in value && typeof value.modelConnected !== 'boolean') || ('source' in value && value.source !== null && !isSourceId(value.source)) || typeof value.state !== 'string' || !['idle', 'running', 'complete', 'unknown'].includes(value.state) || typeof value.canRun !== 'boolean' || value.state === 'running' && value.canRun || value.error !== null && !(typeof value.error === 'string' && Object.hasOwn(errors, value.error))) return false;
  if (!Array.isArray(value.acknowledged) || value.acknowledged.length > 33 || !value.acknowledged.every(r => record(r, ['kind', 'name', 'uid']) && (r.kind === 'Agent' || r.kind === 'Task') && text(r.name) && text(r.uid))) return false;
  if (value.pending !== null && !(record(value.pending, ['kind', 'name']) && (value.pending.kind === 'Agent' || value.pending.kind === 'Task') && text(value.pending.name))) return false;
  if (value.report === null) return value.state !== 'complete';
  const report = value.report;
  return record(report, ['cases', 'verdict']) && verdict(report.verdict) && Array.isArray(report.cases) && report.cases.length > 0 && report.cases.length <= 32 && report.cases.every(c =>
    record(c, ['id', 'phase', 'answer', 'completedTools', 'assertions', 'verdict']) && text(c.id) && text(c.phase) && verdict(c.verdict) && (c.answer === null || typeof c.answer === 'string' && c.answer.length <= 1048576)
    && Array.isArray(c.completedTools) && c.completedTools.length <= 6000 && c.completedTools.every(t => text(t))
    && Array.isArray(c.assertions) && c.assertions.length > 0 && c.assertions.length <= 64 && c.assertions.every(a => record(a, ['id', 'kind', 'verdict']) && text(a.id) && (a.kind === 'contains' || a.kind === 'toolCalled') && verdict(a.verdict)));
}
export async function runCall(command: 'setup_run_status' | 'setup_run_example'): Promise<{ ok: true; snapshot: RunSnapshot } | { ok: false; message: string }> {
  if (!isTauri()) return { ok: false, message: 'Run is available only in the native app.' };
  try { const value = await invoke<unknown>(command); if (valid(value)) return { ok: true, snapshot: value }; } catch { /* Never expose native errors or diagnostics. */ }
  return { ok: false, message: 'Run information is not supported by this build.' };
}
