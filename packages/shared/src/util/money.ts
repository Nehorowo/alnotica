/**
 * Money is always an integer count of minor units (kopecks). Floats never touch it.
 */
export type Currency = 'RUB' | 'EUR' | 'USD' | 'KZT';

const SYMBOLS: Record<Currency, string> = {
  RUB: '₽',
  EUR: '€',
  USD: '$',
  KZT: '₸',
};

/** Non-breaking space, so an amount never wraps across a line in a message. */
const NBSP = ' ';

export function formatMoney(priceMinor: number, currency: Currency = 'RUB'): string {
  const sign = priceMinor < 0 ? '-' : '';
  const abs = Math.abs(priceMinor);
  const major = Math.trunc(abs / 100);
  const minor = abs % 100;
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const tail = minor === 0 ? '' : `,${String(minor).padStart(2, '0')}`;
  return `${sign}${grouped}${tail}${NBSP}${SYMBOLS[currency]}`;
}

export function sumMinor(values: readonly (number | null | undefined)[]): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}
