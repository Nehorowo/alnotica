/**
 * The Telegram WebApp surface, typed via `@twa-dev/types` rather than `any`.
 *
 * Everything degrades: the app must still render in a plain browser tab (which is
 * how it gets developed) when `window.Telegram` is absent.
 */
import type { WebApp } from '@twa-dev/types';
declare global {
    interface Window {
        Telegram?: {
            WebApp: WebApp;
        };
    }
}
export declare function webApp(): WebApp | null;
/** Copies `themeParams` onto CSS variables so Tailwind's tokens follow the theme. */
export declare function applyTheme(app: WebApp | null): void;
export declare function initTelegram(): WebApp | null;
export declare function haptic(style?: 'light' | 'medium' | 'heavy'): void;
export declare function notify(type: 'error' | 'success' | 'warning'): void;
export interface MainButtonState {
    readonly text: string;
    readonly visible: boolean;
    readonly enabled?: boolean;
    readonly loading?: boolean;
    onClick?(): void;
}
export declare function setMainButton(state: MainButtonState): void;
export declare function closeApp(): void;
/** The signed launch payload the API needs. Empty in a plain browser tab. */
export declare function initData(): string;
/** `?startapp=` payload, when the app was opened from a deep link. */
export declare function startParam(): string | null;
//# sourceMappingURL=telegram.d.ts.map