import { firstTestPreference } from '../setup/first-test';
import { welcomePreference } from '../setup/Welcome';

// The guided first run adds a steps header until a new person leaves setup. Someone who
// already dismissed Welcome before this existed never enters it.
export const guidedPreference = 'bridge.firstRun.v1';
export function guidedFirstRun() {
  try {
    const value = localStorage.getItem(guidedPreference);
    if (value === 'active') return true;
    // Welcome or the automatic first test having run means this isn't a first launch, even if this key is new.
    if (value !== null || localStorage.getItem(welcomePreference) === '1' || localStorage.getItem(firstTestPreference) !== null) return false;
    localStorage.setItem(guidedPreference, 'active');
    return true;
  } catch { return false; }
}
export function finishGuidedFirstRun() {
  try { localStorage.setItem(guidedPreference, 'done'); } catch { /* A presentation preference must not block Bridge. */ }
}

export const guidedSteps = ['Set up', 'Connect AI', 'Try it'] as const;
// Setup's four stages map onto three guided steps: choosing and starting the workspace are one.
export function guidedStep(setupStep: number, done: boolean): number {
  if (done) return guidedSteps.length;
  return setupStep >= 4 ? 2 : setupStep === 3 ? 1 : 0;
}

// The header already counts the guided steps, so a setup line drops its own "step 2 of 4" while guided.
export function withoutStepCount(line: string) {
  return line.replace(/,? ?step \d+ of \d+$/i, '');
}
