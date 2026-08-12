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
        /**
         * Base surfaces. Not pure grey — there's a slight blue cast, which is
         * what stops a dark UI reading as muddy. `void` is the page behind
         * everything; the rest step upward as elements stack.
         */
        void: '#07070c',
        surface: {
          DEFAULT: 'rgba(22, 23, 34, 0.72)',
          solid: '#161722',
          raised: '#1c1e2b',
          sunken: '#101119',
        },
        /** Hairlines. Alpha rather than solid so glass panels show through. */
        edge: {
          DEFAULT: 'rgba(255, 255, 255, 0.08)',
          strong: 'rgba(255, 255, 255, 0.14)',
          soft: 'rgba(255, 255, 255, 0.045)',
        },
        /** Indigo → violet accent. */
        brand: {
          50: '#eef1ff',
          100: '#e0e5ff',
          200: '#c5cdff',
          300: '#a3aaff',
          400: '#8b83ff',
          500: '#6f5cf5',
          600: '#5b45e8',
          700: '#4a35c4',
          800: '#3d2d9e',
          900: '#2a1f6b',
        },
        /** Teal, for success and the "live" states in the campaign log. */
        mint: {
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
        },
      },

      borderRadius: {
        '4xl': '1.75rem',
      },

      backdropBlur: {
        xs: '2px',
      },

      boxShadow: {
        /** Glass panels: a soft drop plus an inner top highlight. */
        glass: '0 8px 32px -8px rgba(0, 0, 0, 0.6), inset 0 1px 0 0 rgba(255, 255, 255, 0.06)',
        'glass-lg': '0 24px 64px -16px rgba(0, 0, 0, 0.7), inset 0 1px 0 0 rgba(255, 255, 255, 0.08)',
        glow: '0 0 24px -4px rgba(111, 92, 245, 0.45)',
        'glow-sm': '0 0 12px -2px rgba(111, 92, 245, 0.4)',
      },

      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #6f5cf5 0%, #8b5cf6 50%, #a855f7 100%)',
        'surface-sheen': 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 60%)',
      },

      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },

      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(111, 92, 245, 0.4)' },
          '50%': { boxShadow: '0 0 0 8px rgba(111, 92, 245, 0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
      },
    },
  },
  plugins: [],
};
