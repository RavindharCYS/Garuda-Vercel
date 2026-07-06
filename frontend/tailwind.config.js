/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary:        '#1a0820',
        secondary:      '#7B3FAD',
        'accent-purple':'#5B2D8B',
        'light-purple': '#DFC4F2',
        surface:        '#ffffff',
        background:     '#F9F9FB',
        'on-background':'#100D14',
        'gray-subtle':  '#766D82',
      },
      fontFamily: {
        headline: ['"Cormorant Garamond"', 'serif'],
        body:     ['"IBM Plex Sans"', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0.75rem',
        lg:      '1rem',
        xl:      '1.5rem',
        '2xl':   '2rem',
        '3xl':   '3rem',
        full:    '9999px',
      },
      animation: {
        'marquee':    'marquee 30s linear infinite',
        'truck':      'truck 2s ease-in-out infinite',
        'garuda-fly': 'garudaFly 2s ease-in-out forwards',
        'spin-slow':  'spin 3s linear infinite',
        'fadeIn':     'fadeIn 0.5s ease-in-out',
        'slideUp':    'slideUp 0.4s ease-out',
      },
      keyframes: {
        marquee:   { '0%': { transform:'translateX(0)' }, '100%': { transform:'translateX(-50%)' } },
        truck:     { '0%,100%': { transform:'translateX(0)' }, '50%': { transform:'translateX(8px)' } },
        garudaFly: {
          '0%':   { transform:'translate(-80px,-40px) rotate(-15deg) scale(0.7)', opacity:'0' },
          '60%':  { transform:'translate(10px,5px) rotate(5deg) scale(1.1)', opacity:'1' },
          '100%': { transform:'translate(0,0) rotate(0deg) scale(1)', opacity:'1' },
        },
        fadeIn:  { '0%': { opacity:'0' }, '100%': { opacity:'1' } },
        slideUp: { '0%': { transform:'translateY(16px)', opacity:'0' }, '100%': { transform:'translateY(0)', opacity:'1' } },
      }
    }
  },
  plugins: [],
}
