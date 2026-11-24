import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/app.css', 'utf8');
const palettes = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(([, block]) =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])),
);

describe('Estuary theme contract', () => {
  it.each([
    ['light', 0, '#f2f1ed', '#1b2026', '#1f62b0', '#17793f'],
    ['dark', 1, '#1f2226', '#e6e4df', '#8ab8ea', '#7cc598'],
  ] as const)('%s keeps neutral chrome and Orka phase meanings', (_, index, page, ink, running, succeeded) => {
    expect(palettes[index]).toMatchObject({
      'color-page': page, 'color-text': ink,
      'color-status-running': running, 'color-status-succeeded': succeeded,
    });
  });
  it.each([0, 1])('keeps secondary, faint and failure text readable in palette %s', index => {
    const palette = palettes[index];
    const luminance = (hex: string) => {
      const rgb = hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    const components = readFileSync('src/components/design-system.css', 'utf8');
    const stale = components.match(/\.status-stale\s*\{\s*--status:\s*var\(--([\w-]+)\);\s*--status-tint:\s*var\(--([\w-]+)\)/)!;
    const [staleInk, staleSurface] = [luminance(palette[stale[1]]), luminance(palette[stale[2]])].sort((a, b) => b - a);
    expect((staleInk + 0.05) / (staleSurface + 0.05)).toBeGreaterThanOrEqual(4.5);
    for (const ink of ['color-text-secondary', 'color-text-tertiary', 'color-status-failed']) {
      for (const surface of ['color-page', 'color-card', 'color-chrome', 'color-hover']) {
        const [a, b] = [luminance(palette[ink]), luminance(palette[surface])].sort((a, b) => b - a);
        expect((a + 0.05) / (b + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('declares themed thin scrollbars and a sidebar of full-width page buttons', () => {
    const shell = readFileSync('src/shell.css', 'utf8');
    const controls = readFileSync('src/components/controls.css', 'utf8');
    expect(shell).toMatch(/scrollbar-width:\s*thin/);
    expect(shell).toMatch(/scrollbar-color:\s*var\(--color-text-tertiary\)\s+var\(--color-page\)/);
    expect(shell).toMatch(/\.app-shell\s*\{[^}]*grid-template-areas:\s*"title title"\s*"nav main"\s*"status main"/);
    expect(shell).toMatch(/\.page-tab\s*\{[^}]*width:\s*100%/);
    // Narrow windows keep a rail with page names, and the status card becomes a bar below the page, as main's footer was.
    const compact = shell.slice(shell.indexOf('@media (max-width: 820px)'));
    expect(compact).toMatch(/\.app-shell\s*\{[^}]*--sidebar-width:\s*76px;[^}]*grid-template-areas:\s*"title title"\s*"nav main"\s*"status status"/);
    expect(compact).toMatch(/\.brand b, \.nav-group-label, \.tab-copy small\s*\{\s*display:\s*none/);
    // The compact bar sits on the chrome like main's footer: native walks sample the window corner as chrome.
    expect(compact).toMatch(/\.status-bar\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/);
    // The rail keeps the sidebar's 8px padding, so the window's left edge never lands on a page button.
    expect(compact).not.toMatch(/\.page-nav\s*\{[^}]*padding/);
    expect(compact).not.toMatch(/\.tab-copy\s*\{[^}]*display:\s*none|\.tab-copy b[^{]*\{[^}]*display:\s*none|clip-path|\.status-lines[^{]*\{[^}]*(display:\s*none|position:\s*absolute)|\.host-label[^{]*\{[^}]*(display:\s*none|position:\s*absolute)/);
    expect(controls).toMatch(/\.button-quiet\s*\{[^}]*padding-inline:\s*0/);
  });
  it('uses the system dark preference and bundled reading and code families', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(palettes[0]['font-ui']).toContain('Inter Variable');
    expect(palettes[0]['font-mono']).toContain('JetBrains Mono Variable');
  });
});
