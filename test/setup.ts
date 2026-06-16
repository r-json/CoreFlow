import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock localStorage globally
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
})();

// Only patch the DOM globals when running under a browser-like environment
// (jsdom). Server-only test files use `@vitest-environment node`, where
// `window` is undefined.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
  });
}


