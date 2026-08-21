import { describe, it, expect } from 'vitest';
import { formatMB } from './bytes';

const MB = 1024 * 1024;

describe('formatMB', () => {
  it('renders whole megabytes without a decimal', () => {
    expect(formatMB(50 * MB)).toBe('50 MB');
    expect(formatMB(300 * MB)).toBe('300 MB');
  });

  it('keeps one decimal for fractional values so small usage never reads as zero', () => {
    expect(formatMB(0.4 * MB)).toBe('0.4 MB');
    expect(formatMB(12.34 * MB)).toBe('12.3 MB');
  });

  it('never renders a lying "0 MB" for real usage', () => {
    expect(formatMB(100 * 1024)).not.toBe('0 MB'); // ~0.1 MB
  });

  it('drops the decimal at 100 MB and above — noise at that size', () => {
    expect(formatMB(123.6 * MB)).toBe('124 MB');
  });

  it('degrades to a dash on garbage rather than NaN in the UI', () => {
    expect(formatMB(null)).toBe('—');
    expect(formatMB(undefined)).toBe('—');
    expect(formatMB(-5)).toBe('—');
    expect(formatMB(Number.NaN)).toBe('—');
  });
});
