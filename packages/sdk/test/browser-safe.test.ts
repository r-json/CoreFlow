import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const srcDir = new URL('../src/', import.meta.url);
const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

describe('src is browser-safe', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(5);
  });
  it.each(files)('%s has no node: import, require, process or Buffer', (name) => {
    const text = readFileSync(new URL(name, srcDir), 'utf8');
    expect(text).not.toMatch(/['"]node:/);
    expect(text).not.toMatch(/\brequire\s*\(/);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\bprocess\./);
    expect(text).not.toMatch(/from ['"](fs|path|crypto|os|stream|util)['"]/);
  });
});
