import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCLAIMER_TEXT } from '../src/disclaimer.js';

describe('disclaimer', () => {
  it('states that data is synthetic and not a medical device', () => {
    expect(DISCLAIMER_TEXT).toMatch(/synthetic/i);
    expect(DISCLAIMER_TEXT).toMatch(/NOT a medical device/);
    expect(DISCLAIMER_TEXT).toMatch(/no clinical claims/i);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const normalize = (s) => s.replace(/\s+/g, ' ').trim();
const readRoot = (rel) => readFileSync(resolve(here, '..', rel), 'utf8');

describe('disclaimer visibility in static files', () => {
  it('index.html static #disclaimer banner contains the standard text', () => {
    const html = readRoot('index.html');
    const m = html.match(/<div\b[^>]*\bid="disclaimer"[^>]*>([\s\S]*?)<\/div>/);
    expect(m, '#disclaimer element found').not.toBeNull();
    const text = normalize(m[1].replace(/<[^>]*>/g, ''));
    expect(text).toContain(normalize(DISCLAIMER_TEXT));
  });

  it('src/generator/README.md contains the standard text', () => {
    const md = normalize(readRoot('src/generator/README.md'));
    expect(md).toContain(normalize(DISCLAIMER_TEXT));
  });
});
