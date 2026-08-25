/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.ts'],
  theme: {
    extend: {
      colors: {
        // Every colour comes from Telegram's themeParams, so the app is correct
        // in light and dark without a theme of its own to keep in sync.
        bg: 'var(--tg-theme-bg-color)',
        'bg-secondary': 'var(--tg-theme-secondary-bg-color)',
        text: 'var(--tg-theme-text-color)',
        hint: 'var(--tg-theme-hint-color)',
        link: 'var(--tg-theme-link-color)',
        button: 'var(--tg-theme-button-color)',
        'button-text': 'var(--tg-theme-button-text-color)',
        destructive: 'var(--tg-theme-destructive-text-color)',
      },
      minHeight: {
        // Telegram's own guidance, and the smallest comfortable tap target.
        tap: '44px',
      },
      minWidth: {
        tap: '44px',
      },
    },
  },
  plugins: [],
};
