import { readFileSync } from 'node:fs';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import App from '../App';
import { noUpgrade } from '../setup/test-upgrade';
import { guidedStep, withoutStepCount } from './guided';

afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function nativeSetup(status: Record<string, unknown>) {
  vi.stubGlobal('isTauri', true);
  mockIPC(command => {
    if (command === 'workspace_upgrade_status') return noUpgrade;
    if (command === 'setup_status') return status;
    if (command === 'setup_requirements') return { memoryBytes: 6 * 1024 ** 3, imageBytes: 3e9, stateDiskBytes: 32e9, freeDiskBytes: 64424509440, downloadBytes: null };
    return { kind: 'version', version: 'v0.4.2', hasDiagnostics: false };
  });
}
const shell = () => document.querySelector('.app-shell')!;

test('a first launch is guided: the title bar shows the setup steps while navigation and the status card stay', async () => {
  nativeSetup({ selected: null, localVm: 'idle', model: 'locked' });
  render(<App />);
  expect(shell().classList.contains('guided')).toBe(true);
  const steps = within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole('listitem');
  expect(steps.map(step => step.textContent)).toEqual(['1Set up', '2Connect AI', '3Try it']);
  expect(steps[0].getAttribute('aria-current')).toBe('step');
  expect(localStorage.getItem('bridge.firstRun.v1')).toBe('active');
  expect(screen.getByRole('contentinfo').querySelector('[role="status"]')).not.toBeNull();
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Home', 'Overview', 'Designer', 'Clusters']);
});

test('someone who already dismissed Welcome keeps the sidebar', () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1');
  nativeSetup({ selected: 'localVm', localVm: 'ready', model: 'available' });
  render(<App />);
  expect(shell().classList.contains('guided')).toBe(false);
  expect(screen.queryByRole('list', { name: 'Setup progress' })).toBeNull();
});

test('leaving the guided run is remembered', async () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1');
  localStorage.setItem('bridge.firstRun.v1', 'active');
  nativeSetup({ selected: 'localVm', localVm: 'starting', model: 'locked' });
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  expect(shell().classList.contains('guided')).toBe(true);
  await user.click(await screen.findByRole('button', { name: 'Show all of Bridge' }));
  expect(shell().classList.contains('guided')).toBe(false);
  expect(localStorage.getItem('bridge.firstRun.v1')).toBe('done');
  unmount();
  render(<App />);
  expect(shell().classList.contains('guided')).toBe(false);
});

test('opening another page ends the guided run', async () => {
  localStorage.setItem('bridge.welcomeSeen.v1', '1');
  localStorage.setItem('bridge.firstRun.v1', 'active');
  nativeSetup({ selected: 'localVm', localVm: 'starting', model: 'locked' });
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: 'Overview' }));
  await waitFor(() => expect(shell().classList.contains('guided')).toBe(false));
  expect(localStorage.getItem('bridge.firstRun.v1')).toBe('done');
});

test('setup stages map onto three guided steps', () => {
  expect([0, 1, 2, 3, 4].map(step => guidedStep(step, false))).toEqual([0, 0, 0, 1, 2]);
  expect(guidedStep(4, true)).toBe(3);
});

test('an install whose automatic first test already ran is not a first launch', () => {
  localStorage.setItem('bridge.firstTest.v1', 'attempted');
  nativeSetup({ selected: null, localVm: 'idle', model: 'locked' });
  render(<App />);
  expect(shell().classList.contains('guided')).toBe(false);
});

test('a chosen workspace without a dismissed Welcome means cleared storage, so guidance ends', async () => {
  nativeSetup({ selected: 'localVm', localVm: 'ready', model: 'available' });
  render(<App />);
  await waitFor(() => expect(shell().classList.contains('guided')).toBe(false));
  expect(localStorage.getItem('bridge.firstRun.v1')).toBe('done');
});

test('the status card stays during guidance and at narrow widths keeps its text visible', () => {
  const guided = readFileSync('src/firstrun/firstrun.css', 'utf8');
  const shellCss = readFileSync('src/shell.css', 'utf8');
  expect(guided).not.toMatch(/status-bar[^}]*display:\s*none/);
  const compact = shellCss.slice(shellCss.indexOf('@media (max-width: 820px)'));
  expect(compact).not.toMatch(/\.status-lines[^{]*\{[^}]*display:\s*none/);
  expect(compact).not.toMatch(/clip-path/);
});

test('a guided setup line keeps its words and drops its own step count', () => {
  expect(withoutStepCount('Setting up, step 2 of 4')).toBe('Setting up');
  expect(withoutStepCount('Getting your workspace ready, step 2 of 4')).toBe('Getting your workspace ready');
  expect(withoutStepCount('Workspace ready')).toBe('Workspace ready');
});

test('the guided layout hides the choice card step count that the header replaces', () => {
  expect(readFileSync('src/firstrun/firstrun.css', 'utf8')).toMatch(/\.app-shell\.guided \.workspace-choice-step \{ display: none; \}/);
});
