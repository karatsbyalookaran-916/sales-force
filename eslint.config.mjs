// Flat config. Deliberately small: rules that catch real mistakes, nothing stylistic
// that .editorconfig and review already handle.
import js from '@eslint/js';

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', indexedDB: 'readonly',
  fetch: 'readonly', crypto: 'readonly', caches: 'readonly', self: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', AbortSignal: 'readonly',
  Response: 'readonly', Request: 'readonly', URL: 'readonly', Blob: 'readonly',
  FormData: 'readonly', Event: 'readonly', CustomEvent: 'readonly', matchMedia: 'readonly',
  requestAnimationFrame: 'readonly', getComputedStyle: 'readonly', alert: 'readonly',
  confirm: 'readonly', prompt: 'readonly', HTMLElement: 'readonly', Image: 'readonly',
  BroadcastChannel: 'readonly', history: 'readonly', URLSearchParams: 'readonly'
};

const nodeGlobals = {
  process: 'readonly', Buffer: 'readonly', console: 'readonly', URL: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', globalThis: 'readonly', crypto: 'readonly',
  fetch: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  AbortSignal: 'readonly', structuredClone: 'readonly', URLSearchParams: 'readonly'
};

export default [
  { ignores: ['node_modules/**', 'karats-pdf-libs/**', 'test-results/**', 'data/**', 'fonts/**'] },

  {
    ...js.configs.recommended,
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' }
  },

  {
    files: ['lib/**/*.mjs', 'server/**/*.mjs', 'api/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
    rules: {
      // Unhandled promises are the failure mode that matters most here: a dropped
      // database write is silent, and the request still returns 200.
      'no-floating-decimal': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-return-await': 'error',
      'require-atomic-updates': 'error'
    }
  },

  {
    // Runs under Node, but its page.evaluate() callbacks are browser code, so it
    // legitimately references both sets of globals.
    files: ['tests/browser.mjs'],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } }
  },

  {
    files: ['app/**/*.js', 'sw.js'],
    languageOptions: { globals: browserGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart']
    }
  }
];
