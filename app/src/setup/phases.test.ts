import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { currentPhase, formatElapsed, phaseState, setupPhases, usePhaseTimes } from './phases';
import type { SetupStatus } from './state';

const status = (localVm: SetupStatus['localVm'], phase?: 'verifying' | 'materializing' | 'starting'): SetupStatus =>
  ({ selected: 'localVm', localVm, model: 'locked', workspaceProgress: phase ? { phase, bytes: null, totalBytes: null, elapsedMs: 0, remainingMs: null } : null });
afterEach(() => { vi.useRealTimers(); });

test('native setup state maps to one named stage, in order', () => {
  expect(setupPhases.map(p => p.id)).toEqual(['check', 'install', 'start']);
  expect(currentPhase(status('preparing'))).toBe('check');
  expect(currentPhase(status('installing', 'verifying'))).toBe('check');
  expect(currentPhase(status('installing', 'materializing'))).toBe('install');
  expect(currentPhase(status('starting', 'materializing'))).toBe('start');
  for (const localVm of ['idle', 'ready', 'failed', 'cancelled'] as const) expect(currentPhase(status(localVm))).toBeUndefined();
  expect(['check', 'install', 'start'].map(p => phaseState(p as 'check', 'install', false))).toEqual(['done', 'current', 'waiting']);
  expect(phaseState('start', undefined, true)).toBe('done');
});

test('each stage keeps its own time, and Start never inherits a file phase clock', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const progress = (phase: 'materializing' | 'starting', elapsedMs: number) => ({ phase, bytes: null, totalBytes: null, elapsedMs, remainingMs: null });
  const { result, rerender } = renderHook(({ current, p }) => usePhaseTimes(current, p), { initialProps: { current: 'install' as 'install' | 'start', p: progress('materializing', 20_000) } });
  expect(result.current('install')).toBe(20_000);
  act(() => { vi.advanceTimersByTime(10_000); });
  // Start is first seen with a stale file-phase clock, so it starts from now.
  rerender({ current: 'start', p: progress('materializing', 54_000) });
  expect(result.current('install')).toBe(30_000);
  expect(result.current('start')).toBe(0);
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(result.current('start')).toBe(5_000);
  expect(result.current('check')).toBeUndefined();
  expect(formatElapsed(5_000)).toBe('5 s');
  expect(formatElapsed(125_000)).toBe('2 min 5 s');
});

test('pausing or failing, then starting again, times each stage afresh', () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  type P = { current: 'check' | 'install' | undefined };
  const { result, rerender } = renderHook(({ current }: P) => usePhaseTimes(current, undefined), { initialProps: { current: 'install' } as P });
  act(() => { vi.advanceTimersByTime(30_000); });
  rerender({ current: undefined });
  act(() => { vi.advanceTimersByTime(60_000); });
  rerender({ current: 'check' });
  expect(result.current('install')).toBeUndefined();
  expect(result.current('check')).toBe(0);
});
