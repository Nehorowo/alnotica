/**
 * @vitest-environment jsdom
 *
 * The Mini App's two structural promises: user text is never treated as markup,
 * and every colour comes from Telegram's theme so the app is right in both
 * schemes without a palette of its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clear, el, errorBlock, mount, skeleton } from './dom.js';
import { applyTheme } from './telegram.js';

// Paths are resolved from the repository root: under jsdom `import.meta.url` is
// an http URL and cannot be turned into a file path.
const read = (name: string) => readFileSync(join(process.cwd(), 'apps/miniapp/src', name), 'utf8');

describe('DOM helpers', () => {
  it('renders user text as text, never as markup', () => {
    const node = el('span', {}, ['Стрижка <люкс> & укладка']);
    expect(node.textContent).toBe('Стрижка <люкс> & укладка');
    // The angle brackets are content, so they arrive escaped in the serialization
    // and there is no child element to be found.
    expect(node.children).toHaveLength(0);
    expect(node.innerHTML).toBe('Стрижка &lt;люкс&gt; &amp; укладка');
  });

  it('does not execute a script smuggled in a name', () => {
    const node = el('div', {}, ['<img src=x onerror=alert(1)>']);
    expect(node.querySelector('img')).toBeNull();
  });

  it('sets attributes and skips absent ones', () => {
    const node = el('button', {
      type: 'button',
      disabled: false,
      'aria-pressed': true,
      class: 'a b',
    });
    expect(node.getAttribute('type')).toBe('button');
    expect(node.hasAttribute('disabled')).toBe(false);
    expect(node.getAttribute('aria-pressed')).toBe('');
    expect(node.className).toBe('a b');
  });

  it('mounts and clears a root', () => {
    const root = document.createElement('div');
    mount(root, el('p', {}, ['один']), el('p', {}, ['два']));
    expect(root.children).toHaveLength(2);
    clear(root);
    expect(root.children).toHaveLength(0);
  });

  it('shows skeletons rather than an endless spinner', () => {
    const node = skeleton(4);
    expect(node.querySelectorAll('.skeleton')).toHaveLength(4);
  });

  it('offers a retry on failure', () => {
    let retried = 0;
    const node = errorBlock('Сеть недоступна', () => retried++);
    const button = node.querySelector('button');
    expect(node.textContent).toContain('Сеть недоступна');
    button?.dispatchEvent(new Event('click'));
    expect(retried).toBe(1);
  });
});

describe('theming', () => {
  it('copies themeParams onto the CSS variables Tailwind reads', () => {
    applyTheme({
      themeParams: {
        bg_color: '#101010',
        secondary_bg_color: '#202020',
        text_color: '#fafafa',
        hint_color: '#888888',
        link_color: '#6ab3f3',
        button_color: '#5288c1',
        button_text_color: '#ffffff',
        destructive_text_color: '#ec3942',
      },
    } as unknown as Parameters<typeof applyTheme>[0]);

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--tg-theme-bg-color')).toBe('#101010');
    expect(style.getPropertyValue('--tg-theme-text-color')).toBe('#fafafa');
    expect(style.getPropertyValue('--tg-theme-button-color')).toBe('#5288c1');
  });

  it('does nothing when Telegram is absent, so a plain browser still renders', () => {
    expect(() => applyTheme(null)).not.toThrow();
  });
});

describe('source-level guarantees', () => {
  const sources = ['dom.ts', 'client-view.ts', 'staff-view.ts', 'main.ts', 'api.ts'].map(read);

  it('never assigns innerHTML anywhere', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\.innerHTML\s*=/);
      expect(source).not.toMatch(/insertAdjacentHTML/);
    }
  });

  it('declares a fallback for every theme variable, in both schemes', () => {
    const css = read('styles.css');
    const variables = [
      'bg-color',
      'secondary-bg-color',
      'text-color',
      'hint-color',
      'link-color',
      'button-color',
      'button-text-color',
      'destructive-text-color',
    ];
    const [light, dark] = css.split('@media (prefers-color-scheme: dark)');
    for (const name of variables) {
      // A missing fallback shows up as black-on-black in whichever scheme lacks it.
      expect(light).toContain(`--tg-theme-${name}:`);
      expect(dark).toContain(`--tg-theme-${name}:`);
    }
  });

  it('keeps the page from ever scrolling sideways on a 360 px screen', () => {
    expect(read('styles.css')).toContain('overflow-x: hidden');
    // The one horizontally scrolling element is the day strip, and it is confined.
    expect(read('client-view.ts')).toContain('overflow-x-auto');
  });

  it('takes response types from the shared package rather than redeclaring them', () => {
    const api = read('api.ts');
    expect(api).toContain("from '@alnotica/shared'");
    expect(api).toContain('availabilityResponseSchema');
    expect(api).toContain('bookResponseSchema');
    expect(api).toContain('scheduleResponseSchema');
  });

  it('keeps every tap target at least 44 px', () => {
    for (const source of ['client-view.ts', 'staff-view.ts'].map(read)) {
      const buttons = source.match(/el\(\s*'button'/g) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      expect(source).toContain('min-h-tap');
    }
    expect(read('../tailwind.config.js')).toContain("tap: '44px'");
  });
});
