/**
 * Minimal DOM helpers.
 *
 * Every piece of user-supplied text goes in through `textContent`. There is no
 * `innerHTML` anywhere in this app: a service called `Стрижка <люкс>` must render
 * as itself, not as markup.
 */
export type Attrs = Record<string, string | number | boolean | undefined>;
export declare function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: (Node | string)[]): HTMLElementTagNameMap[K];
export declare function text(value: string): Text;
export declare function clear(node: HTMLElement): void;
export declare function mount(root: HTMLElement, ...children: Node[]): void;
/** Skeletons, never an endless spinner: the user must see shape and progress. */
export declare function skeleton(count?: number): HTMLElement;
export declare function errorBlock(message: string, onRetry?: () => void): HTMLElement;
export declare function heading(value: string): HTMLElement;
export declare function subheading(value: string): HTMLElement;
//# sourceMappingURL=dom.d.ts.map