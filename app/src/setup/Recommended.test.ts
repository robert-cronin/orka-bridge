import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('a route whose computer check failed does not keep its Recommended chip', () => {
  const steps = readFileSync('src/setup/steps.css', 'utf8');
  expect(steps).toMatch(/\.workspace-option:has\(\.workspace-failure-explanation\) > \.chip \{ display: none; \}/);
  // The failed check and the chip are both inside the option, so the selector has something to match.
  const setup = readFileSync('src/setup/Setup.tsx', 'utf8');
  expect(setup).toMatch(/<span className="chip">Recommended<\/span>/);
  expect(readFileSync('src/setup/Preflight.tsx', 'utf8')).toMatch(/workspace-failure-explanation/);
});
