import * as assert from 'assert';
import { findStaleCodespaces } from '../../staleDetector';
import { Codespace } from '../../types';

function makeCodespace(overrides: Partial<Codespace>): Codespace {
  return {
    name: 'test-codespace',
    displayName: 'Test Codespace',
    state: 'Shutdown',
    repository: 'owner/repo',
    owner: 'owner',
    branch: 'main',
    lastUsedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    machineName: 'basicLinux32gb',
    gitStatus: {
      ref: 'main',
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false,
      hasUnpushedChanges: false,
    },
    ...overrides,
  };
}

suite('StaleDetector', () => {
  test('findStaleCodespaces returns codespaces older than threshold', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const codespaces = [
      makeCodespace({ name: 'old', lastUsedAt: oldDate }),
      makeCodespace({ name: 'new', lastUsedAt: new Date().toISOString() }),
    ];
    const stale = findStaleCodespaces(codespaces, 14);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].name, 'old');
  });

  test('findStaleCodespaces ignores running codespaces', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const codespaces = [
      makeCodespace({ name: 'running-old', state: 'Available', lastUsedAt: oldDate }),
    ];
    const stale = findStaleCodespaces(codespaces, 14);
    assert.strictEqual(stale.length, 0);
  });

  test('findStaleCodespaces returns empty array when no stale codespaces', () => {
    const codespaces = [
      makeCodespace({ name: 'recent', lastUsedAt: new Date().toISOString() }),
    ];
    const stale = findStaleCodespaces(codespaces, 14);
    assert.strictEqual(stale.length, 0);
  });

  test('findStaleCodespaces handles empty input', () => {
    const stale = findStaleCodespaces([], 14);
    assert.strictEqual(stale.length, 0);
  });
});
