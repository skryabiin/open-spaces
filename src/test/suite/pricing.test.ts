import * as assert from 'assert';
import { getHourlyPrice } from '../../utils/pricing';

suite('Pricing', () => {
  test('getHourlyPrice returns correct price for exact CPU match', () => {
    assert.strictEqual(getHourlyPrice(2), 0.18);
    assert.strictEqual(getHourlyPrice(4), 0.36);
    assert.strictEqual(getHourlyPrice(8), 0.72);
    assert.strictEqual(getHourlyPrice(16), 1.44);
    assert.strictEqual(getHourlyPrice(32), 2.88);
  });

  test('getHourlyPrice rounds up to next tier for non-standard CPU counts', () => {
    assert.strictEqual(getHourlyPrice(1), 0.18);
    assert.strictEqual(getHourlyPrice(3), 0.36);
    assert.strictEqual(getHourlyPrice(6), 0.72);
  });

  test('getHourlyPrice returns null for CPUs above highest tier', () => {
    assert.strictEqual(getHourlyPrice(64), null);
  });
});
