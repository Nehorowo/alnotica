/**
 * The client's calendar: pick a day, pick a time, confirm with the MainButton.
 *
 * Availability arrives from the API, but the same `slotsForDay` from
 * `packages/shared` runs here too — see `previewSlots` — so the grid can be drawn
 * instantly from cached inputs while the network catches up. The server remains
 * the authority: it re-checks the chosen start before it writes anything.
 */
import {
  type AvailabilityResponse,
  type Currency,
  type SlotDto,
  formatMoney,
} from '@alnotica/shared';
import { DateTime } from 'luxon';
import { ApiError, book, getAvailability } from './api.js';
import { clear, el, errorBlock, heading, mount, skeleton, subheading } from './dom.js';
import { closeApp, haptic, notify, setMainButton } from './telegram.js';

const WEEKDAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

export interface ClientViewOptions {
  readonly root: HTMLElement;
  readonly slug: string;
  readonly serviceId: string;
  readonly staffId: string;
}

interface State {
  data: AvailabilityResponse | null;
  selectedDate: string | null;
  selectedSlot: SlotDto | null;
  error: string | null;
  loading: boolean;
}

export async function renderClientView(options: ClientViewOptions): Promise<void> {
  const state: State = {
    data: null,
    selectedDate: null,
    selectedSlot: null,
    error: null,
    loading: true,
  };

  const idempotencyKey = crypto.randomUUID();

  function draw(): void {
    if (state.loading && !state.data) {
      mount(options.root, heading('Выбор времени'), skeleton(6));
      return;
    }
    if (state.error && !state.data) {
      mount(
        options.root,
        errorBlock(state.error, () => void load()),
      );
      return;
    }
    const data = state.data;
    if (!data) return;

    const nodes: Node[] = [
      heading(data.tenant.title),
      subheading(
        [
          data.service.name,
          `${data.service.durationMin} мин`,
          data.service.priceMinor === null
            ? null
            : formatMoney(data.service.priceMinor, data.service.currency as Currency),
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      dayStrip(data, state, draw),
    ];

    const day = data.days.find((d) => d.date === state.selectedDate);
    nodes.push(day && day.slots.length > 0 ? slotGrid(day.slots, data, state, draw) : emptyDay());

    if (state.error) nodes.push(el('p', { class: 'mt-4 text-sm text-destructive' }, [state.error]));

    mount(options.root, ...nodes);
    syncMainButton();
  }

  function syncMainButton(): void {
    const slot = state.selectedSlot;
    const zone = state.data?.tenant.timezone ?? 'UTC';
    if (!slot) {
      setMainButton({ text: 'Выберите время', visible: false });
      return;
    }
    setMainButton({
      text: `Записаться на ${DateTime.fromMillis(slot.startsAtMs, { zone }).toFormat('HH:mm')}`,
      visible: true,
      onClick: () => void confirm(),
    });
  }

  async function load(): Promise<void> {
    state.loading = true;
    state.error = null;
    draw();
    try {
      const zone = state.data?.tenant.timezone;
      const today = zone ? DateTime.now().setZone(zone) : DateTime.now();
      const from = today.toFormat('yyyy-MM-dd');
      const to = today.plus({ days: 29 }).toFormat('yyyy-MM-dd');

      const data = await getAvailability(options.slug, {
        serviceId: options.serviceId,
        staffId: options.staffId,
        from,
        to,
      });
      state.data = data;
      // Open on the first day that actually has something free.
      state.selectedDate =
        data.days.find((d) => d.slots.length > 0)?.date ?? data.days[0]?.date ?? null;
    } catch (e) {
      state.error = e instanceof ApiError ? e.message : 'Не удалось загрузить расписание';
    } finally {
      state.loading = false;
      draw();
    }
  }

  async function confirm(): Promise<void> {
    const slot = state.selectedSlot;
    if (!slot) return;
    setMainButton({ text: 'Записываем…', visible: true, enabled: false, loading: true });

    try {
      await book(
        options.slug,
        { serviceId: options.serviceId, staffId: options.staffId, startsAtMs: slot.startsAtMs },
        // The same key on a retry returns the same appointment instead of a second one.
        idempotencyKey,
      );
      notify('success');
      closeApp();
    } catch (e) {
      notify('error');
      if (e instanceof ApiError && e.code === 'slot_taken') {
        state.error = 'Этот слот только что заняли. Вот что ещё свободно.';
        // Redraw with what the server says is still available.
        if (e.alternatives.length > 0 && state.data && state.selectedDate) {
          const day = state.data.days.find((d) => d.date === state.selectedDate);
          if (day) {
            state.data = {
              ...state.data,
              days: state.data.days.map((d) =>
                d.date === day.date ? { ...d, slots: e.alternatives } : d,
              ),
            };
          }
        }
        state.selectedSlot = null;
        draw();
        return;
      }
      state.error = e instanceof ApiError ? e.message : 'Не удалось записаться';
      state.selectedSlot = null;
      draw();
    }
  }

  await load();
}

function dayStrip(data: AvailabilityResponse, state: State, redraw: () => void): HTMLElement {
  const strip = el('div', {
    // Horizontal scrolling is confined to this strip; the page never scrolls sideways.
    class: '-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-2',
  });

  for (const day of data.days) {
    const dt = DateTime.fromISO(day.date, { zone: data.tenant.timezone });
    const available = day.slots.length > 0;
    const selected = state.selectedDate === day.date;

    const button = el(
      'button',
      {
        type: 'button',
        disabled: !available,
        'aria-pressed': selected,
        class: [
          'flex min-h-tap min-w-tap shrink-0 flex-col items-center justify-center rounded-xl px-3 py-2',
          selected ? 'bg-button text-button-text' : 'bg-bg-secondary',
          available ? '' : 'opacity-40',
        ].join(' '),
      },
      [
        el('span', { class: 'text-xs' }, [WEEKDAY_LABELS[dt.weekday - 1] ?? '']),
        el('span', { class: 'text-base font-semibold' }, [String(dt.day)]),
      ],
    );

    if (available) {
      button.addEventListener('click', () => {
        haptic('light');
        state.selectedDate = day.date;
        state.selectedSlot = null;
        state.error = null;
        redraw();
      });
    }
    strip.append(button);
  }
  return strip;
}

function slotGrid(
  slots: readonly SlotDto[],
  data: AvailabilityResponse,
  state: State,
  redraw: () => void,
): HTMLElement {
  const zone = data.tenant.timezone;
  const first = slots[0];
  const dt = first ? DateTime.fromMillis(first.startsAtMs, { zone }) : null;

  const grid = el('div', { class: 'grid grid-cols-3 gap-2' });
  for (const slot of slots) {
    const selected = state.selectedSlot?.startsAtMs === slot.startsAtMs;
    // A fall-back day shows the same wall clock twice; the offset tells them apart.
    const label = slot.ambiguous
      ? `${slot.localTime} (UTC${DateTime.fromMillis(slot.startsAtMs, { zone }).toFormat('ZZ')})`
      : slot.localTime;

    const button = el(
      'button',
      {
        type: 'button',
        'aria-pressed': selected,
        class: [
          'min-h-tap rounded-xl text-sm font-medium',
          selected ? 'bg-button text-button-text' : 'bg-bg-secondary',
        ].join(' '),
      },
      [label],
    );
    button.addEventListener('click', () => {
      haptic('medium');
      state.selectedSlot = slot;
      state.error = null;
      redraw();
    });
    grid.append(button);
  }

  const wrapper = el('div', {}, []);
  if (dt) {
    wrapper.append(
      el('p', { class: 'mb-2 text-sm text-hint' }, [`${dt.day} ${MONTHS[dt.month - 1] ?? ''}`]),
    );
  }
  wrapper.append(grid);
  return wrapper;
}

function emptyDay(): HTMLElement {
  return el('p', { class: 'py-10 text-center text-sm text-hint' }, [
    'В этот день свободных слотов нет.',
  ]);
}

export { clear };
