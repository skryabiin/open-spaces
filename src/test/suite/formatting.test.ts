import * as assert from 'assert';
import { formatBytes, formatMachineSpecs, getTimeAgo, getIdleTimeRemaining } from '../../utils/formatting';

suite('Formatting', () => {
  suite('formatBytes', () => {
    test('formats zero bytes', () => {
      const result = formatBytes(0);
      assert.ok(result.includes('0'));
    });

    test('formats megabytes', () => {
      const result = formatBytes(512 * 1024 * 1024);
      assert.ok(result.includes('512'));
    });

    test('formats gigabytes', () => {
      const result = formatBytes(8 * 1024 * 1024 * 1024);
      assert.ok(result.includes('8'));
    });
  });

  suite('formatMachineSpecs', () => {
    test('formats machine with cpus and memory', () => {
      const result = formatMachineSpecs({
        cpus: 4,
        memoryInBytes: 8 * 1024 * 1024 * 1024,
        storageInBytes: 32 * 1024 * 1024 * 1024,
        displayName: '4-core',
      });
      assert.ok(result.includes('4'));
    });

    test('returns displayName as fallback', () => {
      const result = formatMachineSpecs({
        cpus: 0,
        memoryInBytes: 0,
        storageInBytes: 0,
        displayName: 'Custom Machine',
      });
      assert.ok(result.includes('Custom Machine'));
    });
  });

  suite('getTimeAgo', () => {
    test('returns "Just now" for recent dates', () => {
      const result = getTimeAgo(new Date());
      assert.ok(result.includes('now') || result.includes('Just'));
    });

    test('returns minutes ago for recent times', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const result = getTimeAgo(fiveMinAgo);
      assert.ok(result.includes('5'));
    });

    test('returns hours ago', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const result = getTimeAgo(threeHoursAgo);
      assert.ok(result.includes('3'));
    });

    test('handles future dates gracefully', () => {
      const future = new Date(Date.now() + 60000);
      const result = getTimeAgo(future);
      assert.ok(result.includes('now') || result.includes('Just'));
    });
  });

  suite('getIdleTimeRemaining', () => {
    test('returns null for missing lastUsedAt', () => {
      const result = getIdleTimeRemaining('', 30);
      assert.strictEqual(result, null);
    });

    test('returns null for zero timeout', () => {
      const result = getIdleTimeRemaining(new Date().toISOString(), 0);
      assert.strictEqual(result, null);
    });

    test('returns imminent when time has elapsed', () => {
      const longAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();
      const result = getIdleTimeRemaining(longAgo, 30);
      assert.ok(result);
      assert.strictEqual(result.isLow, true);
    });

    test('returns remaining time', () => {
      const justNow = new Date().toISOString();
      const result = getIdleTimeRemaining(justNow, 60);
      assert.ok(result);
      assert.ok(result.text.includes('60') || result.text.includes('59') || result.text.includes('1h'));
    });
  });
});
