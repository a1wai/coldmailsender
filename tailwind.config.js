/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './lib/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand palette — deep slate canvas with an indigo/violet accent.
        ink: {
          950: '#08090f',
          900: '#0d0f17',
          850: '#12141e',
          800: '#171a26',
          700: '#212536',
          600: '#2e3348',
          500: '#3d4459',
        },
        brand: {
          50: '#eef2ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(99, 102, 241, 0.45)' },
          '100%': { boxShadow: '0 0 0 10px rgba(99, 102, 241, 0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'pulse-ring': 'pulse-ring 1.4s ease-out infinite',
      },
    },
  },
  plugins: [],
};
