import { clear } from './dom.js';
export interface ClientViewOptions {
  readonly root: HTMLElement;
  readonly slug: string;
  readonly serviceId: string;
  readonly staffId: string;
}
export declare function renderClientView(options: ClientViewOptions): Promise<void>;
export { clear };
//# sourceMappingURL=client-view.d.ts.map
