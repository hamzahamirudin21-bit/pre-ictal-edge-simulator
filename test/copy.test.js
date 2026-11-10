import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHRASES = ['detects', 'predicts', 'diagnosis', 'clinically validated', 'accuracy for patients'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('UI copy rules', () => {
  const uiFiles = walk(join(root, 'src', 'ui'));
  const html = readFileSync(join(root, 'index.html'), 'utf8').replace(
    /<div\b[^>]*\bid="disclaimer"[^>]*>[\s\S]*?<\/div>/,
    '',
  );
  const targets = [
    { name: 'index.html', text: html },
    { name: 'src/main.js', text: readFileSync(join(root, 'src', 'main.js'), 'utf8') },
    ...uiFiles.map((f) => ({ name: f, text: readFileSync(f, 'utf8') })),
  ];

  it('scans at least one file under src/ui', () => {
    expect(uiFiles.length).toBeGreaterThan(0);
  });

  it('does not use the old pre-ictal-like label', () => {
    const old = 'pre-ictal-like (simulation knob, not clinical)';
    for (const { name, text } of targets) {
      expect(text.toLowerCase().includes(old), `${name} contains the old label`).toBe(false);
    }
  });

  it('shows the HRV shift label somewhere under src/ui', () => {
    const label = 'HRV shift (illustrative, not clinical)';
    const found = uiFiles.some((f) => readFileSync(f, 'utf8').includes(label));
    expect(found).toBe(true);
  });

  it('contains no clinical-claim phrases', () => {
    for (const { name, text } of targets) {
      const lower = text.toLowerCase();
      for (const phrase of PHRASES) {
        expect(lower.includes(phrase), `${name} contains "${phrase}"`).toBe(false);
      }
    }
  });
});
