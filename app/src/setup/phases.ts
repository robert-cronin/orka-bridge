import { useEffect, useRef, useState } from 'react';
import type { SetupStatus, WorkspaceProgress } from './state';

// The named stages inside "Get your workspace ready", in order. Native reports where setup is
// (localVm and the image phase); this is the one place that names those stages for people.
export const setupPhases = [
  { id: 'check', label: 'Check the cluster files' },
  { id: 'install', label: 'Install the cluster files' },
  { id: 'start', label: 'Start the workspace' },
] as const;
export type SetupPhase = (typeof setupPhases)[number]['id'];
export type PhaseState = 'done' | 'current' | 'waiting';

export function currentPhase(status: SetupStatus): SetupPhase | undefined {
  if (status.localVm === 'starting') return 'start';
  if (status.localVm === 'installing' && status.workspaceProgress?.phase === 'materializing') return 'install';
  if (status.localVm === 'preparing' || status.localVm === 'installing') return 'check';
  return undefined;
}
export function phaseState(phase: SetupPhase, current: SetupPhase | undefined, ready: boolean): PhaseState {
  if (ready) return 'done';
  if (!current) return 'waiting';
  const at = setupPhases.findIndex(p => p.id === current), index = setupPhases.findIndex(p => p.id === phase);
  return index < at ? 'done' : index === at ? 'current' : 'waiting';
}
export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// Times each stage as this window sees it. A stage first seen mid-way starts from native's own
// elapsed time only when native's clock is that stage's: it restarts for Start, and a file phase
// left over from before Start is never reused.
export function usePhaseTimes(current: SetupPhase | undefined, progress: WorkspaceProgress | undefined) {
  const times = useRef(new Map<SetupPhase, { start: number; end?: number }>());
  const previous = useRef<SetupPhase | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  if (current !== previous.current) {
    const at = Date.now();
    if (previous.current) { const last = times.current.get(previous.current); if (last && last.end === undefined) last.end = at; }
    if (current && !times.current.has(current)) {
      const own = progress && (current === 'start' ? progress.phase === 'starting' : progress.phase !== 'starting' && times.current.size === 0);
      const seeded = own ? progress.elapsedMs : 0;
      times.current.set(current, { start: at - seeded });
    }
    previous.current = current;
  }
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current]);
  return (phase: SetupPhase) => {
    const time = times.current.get(phase);
    return time ? (time.end ?? now) - time.start : undefined;
  };
}
