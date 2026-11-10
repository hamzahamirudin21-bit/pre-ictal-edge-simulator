import { describe, it, expect } from 'vitest';
import { DISCLAIMER_TEXT } from '../src/disclaimer.js';

describe('disclaimer', () => {
  it('states that data is synthetic and not a medical device', () => {
    expect(DISCLAIMER_TEXT).toMatch(/synthetic/i);
    expect(DISCLAIMER_TEXT).toMatch(/NOT a medical device/);
    expect(DISCLAIMER_TEXT).toMatch(/no clinical claims/i);
  });
});