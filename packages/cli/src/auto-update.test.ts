import { describe, test, expect } from 'vitest';
import { isAutoUpdateEnabled, planAutoUpdate } from './auto-update.js';

describe('auto-update default', () => {
  test('default ON for every edition (cloud included)', () => {
    expect(isAutoUpdateEnabled('cloud', undefined)).toBe(true);
    expect(isAutoUpdateEnabled('selfhost', undefined)).toBe(true);
  });

  test('explicit opt-out wins', () => {
    expect(isAutoUpdateEnabled('cloud', '0')).toBe(false);
    expect(isAutoUpdateEnabled('selfhost', 'off')).toBe(false);
  });

  test('a cloud device updates when the server advertises a newer CLI', () => {
    const plan = planAutoUpdate(
      'https://chat-recall.munhq.com',
      { edition: 'cloud', cli: { version: '0.3.3', sha256: 'a'.repeat(64) } },
      '0.3.2',
      undefined,
    );
    expect(plan.update).toBe(true);
    expect(plan.to).toBe('0.3.3');
  });
});
