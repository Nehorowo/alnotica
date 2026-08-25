/**
 * The Telegram WebApp surface, typed via `@twa-dev/types` rather than `any`.
 *
 * Everything degrades: the app must still render in a plain browser tab (which is
 * how it gets developed) when `window.Telegram` is absent.
 */
import type { WebApp } from '@twa-dev/types';

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp };
  }
}

export function webApp(): WebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/** Copies `themeParams` onto CSS variables so Tailwind's tokens follow the theme. */
export function applyTheme(app: WebApp | null): void {
  if (!app) return;
  const map: Record<string, string | undefined> = {
    '--tg-theme-bg-color': app.themeParams.bg_color,
    '--tg-theme-secondary-bg-color': app.themeParams.secondary_bg_color,
    '--tg-theme-text-color': app.themeParams.text_color,
    '--tg-theme-hint-color': app.themeParams.hint_color,
    '--tg-theme-link-color': app.themeParams.link_color,
    '--tg-theme-button-color': app.themeParams.button_color,
    '--tg-theme-button-text-color': app.themeParams.button_text_color,
    '--tg-theme-destructive-text-color': app.themeParams.destructive_text_color,
  };
  for (const [name, value] of Object.entries(map)) {
    if (value) document.documentElement.style.setProperty(name, value);
  }
}

export function initTelegram(): WebApp | null {
  const app = webApp();
  if (!app) return null;
  app.ready();
  app.expand();
  applyTheme(app);
  // The theme can change while the app is open.
  app.onEvent('themeChanged', () => applyTheme(app));
  return app;
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  webApp()?.HapticFeedback?.impactOccurred(style);
}

export function notify(type: 'error' | 'success' | 'warning'): void {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}

export interface MainButtonState {
  readonly text: string;
  readonly visible: boolean;
  readonly enabled?: boolean;
  readonly loading?: boolean;
  onClick?(): void;
}

let mainButtonHandler: (() => void) | null = null;

export function setMainButton(state: MainButtonState): void {
  const app = webApp();
  if (!app) return;
  const button = app.MainButton;

  if (mainButtonHandler) {
    button.offClick(mainButtonHandler);
    mainButtonHandler = null;
  }

  if (!state.visible) {
    button.hide();
    return;
  }

  button.setText(state.text);
  if (state.enabled === false) button.disable();
  else button.enable();
  if (state.loading) button.showProgress(false);
  else button.hideProgress();

  if (state.onClick) {
    mainButtonHandler = state.onClick;
    button.onClick(mainButtonHandler);
  }
  button.show();
}

export function closeApp(): void {
  webApp()?.close();
}

/** The signed launch payload the API needs. Empty in a plain browser tab. */
export function initData(): string {
  return webApp()?.initData ?? '';
}

/** `?startapp=` payload, when the app was opened from a deep link. */
export function startParam(): string | null {
  return webApp()?.initDataUnsafe?.start_param ?? null;
}
