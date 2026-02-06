import * as assert from 'assert';
import { TRANSITIONAL_STATES, isTransitionalState } from '../../constants';

suite('Constants', () => {
  test('TRANSITIONAL_STATES contains expected states', () => {
    assert.ok(TRANSITIONAL_STATES.includes('Starting'));
    assert.ok(TRANSITIONAL_STATES.includes('ShuttingDown'));
    assert.ok(TRANSITIONAL_STATES.includes('Provisioning'));
    assert.ok(TRANSITIONAL_STATES.includes('Rebuilding'));
    assert.ok(TRANSITIONAL_STATES.includes('Exporting'));
    assert.ok(TRANSITIONAL_STATES.includes('Updating'));
  });

  test('TRANSITIONAL_STATES does not contain stable states', () => {
    assert.ok(!TRANSITIONAL_STATES.includes('Available'));
    assert.ok(!TRANSITIONAL_STATES.includes('Shutdown'));
    assert.ok(!TRANSITIONAL_STATES.includes('Failed'));
  });

  test('isTransitionalState returns true for transitional states', () => {
    assert.strictEqual(isTransitionalState('Starting'), true);
    assert.strictEqual(isTransitionalState('ShuttingDown'), true);
    assert.strictEqual(isTransitionalState('Provisioning'), true);
  });

  test('isTransitionalState returns false for stable states', () => {
    assert.strictEqual(isTransitionalState('Available'), false);
    assert.strictEqual(isTransitionalState('Shutdown'), false);
    assert.strictEqual(isTransitionalState('Failed'), false);
  });
});
