/**
 * Minimal DOM helpers.
 *
 * Every piece of user-supplied text goes in through `textContent`. There is no
 * `innerHTML` anywhere in this app: a service called `Стрижка <люкс>` must render
 * as itself, not as markup.
 */
export type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'dataset') continue;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function mount(root: HTMLElement, ...children: Node[]): void {
  root.replaceChildren(...children);
}

/** Skeletons, never an endless spinner: the user must see shape and progress. */
export function skeleton(count = 3): HTMLElement {
  return el(
    'div',
    { class: 'space-y-3' },
    Array.from({ length: count }, () => el('div', { class: 'skeleton h-12 w-full' })),
  );
}

export function errorBlock(message: string, onRetry?: () => void): HTMLElement {
  const children: Node[] = [el('p', { class: 'text-center text-sm text-hint' }, [message])];
  if (onRetry) {
    const retry = el(
      'button',
      {
        class: 'mx-auto block min-h-tap rounded-xl bg-button px-5 text-button-text',
        type: 'button',
      },
      ['Повторить'],
    );
    retry.addEventListener('click', onRetry);
    children.push(retry);
  }
  return el('div', { class: 'space-y-4 py-8' }, children);
}

export function heading(value: string): HTMLElement {
  return el('h1', { class: 'mb-1 text-lg font-semibold' }, [value]);
}

export function subheading(value: string): HTMLElement {
  return el('p', { class: 'mb-4 text-sm text-hint' }, [value]);
}
