import * as assert from 'assert';
import { parseSshConfigOutput, formatSshConfigEntry } from '../../sshConfigManager';
import { SshConfigEntry } from '../../types';

suite('SshConfigManager', () => {
  suite('parseSshConfigOutput', () => {
    test('parses a single SSH config entry', () => {
      const input = [
        'Host cs-test',
        '  HostName localhost',
        '  User codespace',
        '  ProxyCommand gh codespace ssh -c test --stdio',
        '  IdentityFile ~/.ssh/codespaces',
        '  StrictHostKeyChecking no',
      ].join('\n');

      const entries = parseSshConfigOutput(input);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].host, 'cs-test');
      assert.strictEqual(entries[0].hostName, 'localhost');
      assert.strictEqual(entries[0].user, 'codespace');
      assert.strictEqual(entries[0].identityFile, '~/.ssh/codespaces');
    });

    test('parses multiple entries', () => {
      const input = [
        'Host cs-one',
        '  HostName localhost',
        '  User user1',
        'Host cs-two',
        '  HostName localhost',
        '  User user2',
      ].join('\n');

      const entries = parseSshConfigOutput(input);
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].host, 'cs-one');
      assert.strictEqual(entries[1].host, 'cs-two');
    });

    test('skips comments and empty lines', () => {
      const input = [
        '# This is a comment',
        '',
        'Host cs-test',
        '  HostName localhost',
        '',
        '  # Another comment',
        '  User codespace',
      ].join('\n');

      const entries = parseSshConfigOutput(input);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].host, 'cs-test');
      assert.strictEqual(entries[0].user, 'codespace');
    });

    test('returns empty array for empty input', () => {
      const entries = parseSshConfigOutput('');
      assert.strictEqual(entries.length, 0);
    });
  });

  suite('formatSshConfigEntry', () => {
    test('formats a full entry', () => {
      const entry: SshConfigEntry = {
        host: 'cs-test',
        hostName: 'localhost',
        user: 'codespace',
        proxyCommand: 'gh codespace ssh -c test --stdio',
        identityFile: '~/.ssh/codespaces',
        strictHostKeyChecking: 'no',
      };

      const output = formatSshConfigEntry(entry);
      assert.ok(output.includes('Host cs-test'));
      assert.ok(output.includes('HostName localhost'));
      assert.ok(output.includes('User codespace'));
      assert.ok(output.includes('IdentityFile ~/.ssh/codespaces'));
    });

    test('rejects values with newlines (injection prevention)', () => {
      const entry: SshConfigEntry = {
        host: 'cs-test\nHost evil',
        hostName: 'localhost',
        user: 'codespace',
      };

      assert.throws(() => formatSshConfigEntry(entry), /Invalid SSH config value/);
    });

    test('rejects values with control characters', () => {
      const entry: SshConfigEntry = {
        host: 'cs-test',
        hostName: 'localhost\x00evil',
        user: 'codespace',
      };

      assert.throws(() => formatSshConfigEntry(entry), /Invalid SSH config value/);
    });
  });
});
