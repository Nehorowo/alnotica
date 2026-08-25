/**
 * Entry point. The mode and the tenant come from the launch URL, which the bot
 * builds when it renders the `web_app` button.
 */
import './styles.css';
import { renderClientView } from './client-view.js';
import { el, mount } from './dom.js';
import { renderStaffView } from './staff-view.js';
import { initTelegram, startParam } from './telegram.js';

const root = document.getElementById('app');
if (!root) throw new Error('#app is missing');

initTelegram();

const params = new URLSearchParams(window.location.search);
// `startapp=` is the other way in, when the app is opened from a deep link
// rather than from a button we built ourselves.
const fromStartParam = new URLSearchParams((startParam() ?? '').replace(/^\?/, ''));

function param(name: string): string | null {
  return params.get(name) ?? fromStartParam.get(name);
}

const slug = param('tenant');
const mode = param('mode') === 'staff' ? 'staff' : 'client';

if (!slug) {
  mount(
    root,
    el('p', { class: 'py-10 text-center text-sm text-hint' }, [
      'Не понятно, к какому мастеру записываться. Откройте ссылку из бота.',
    ]),
  );
} else if (mode === 'staff') {
  void renderStaffView({ root, slug });
} else {
  const serviceId = param('service');
  const staffId = param('staff') ?? 'any';
  if (!serviceId) {
    mount(
      root,
      el('p', { class: 'py-10 text-center text-sm text-hint' }, [
        'Не выбрана услуга. Вернитесь в бот и выберите её.',
      ]),
    );
  } else {
    void renderClientView({ root, slug, serviceId, staffId });
  }
}
