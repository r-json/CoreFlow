import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// test/lib.test.ts runs in plain Node, without a DOM.
const hasDom = typeof window !== 'undefined';

// The app scrolls to the top on navigation; the test DOM does not scroll.
if (hasDom) window.scrollTo = () => {};

afterEach(() => {
  if (!hasDom) return;
  cleanup();
  window.location.hash = '';
});
