# New Feature & Improvement Proposals

Ten improvements for Open Spaces, focused on gaps not covered by FEATURE_IDEAS.md.

---

## 1. User-Configurable Settings

The extension currently has zero `contributes.configuration` settings — every value (polling intervals, SSH config path, timeouts, default shell) is hardcoded. Exposing key knobs as VS Code settings would let power users tune behavior without forking the extension.

Suggested settings:
- `openSpaces.sshConfigPath` — custom SSH config file location (default `~/.ssh/config`)
- `openSpaces.pollingInterval` — transitional-state polling interval in ms (default 5000)
- `openSpaces.backgroundRefreshInterval` — tree auto-refresh interval (default 60000)
- `openSpaces.sshProbeRetries` / `sshProbeDelay` — SSH readiness probe tuning
- `openSpaces.defaultMachineType` — pre-select a machine type in the create flow
- `openSpaces.defaultIdleTimeout` — default idle timeout for new codespaces

---

## 2. Status Bar Integration

Add a persistent status bar item that shows the current connection state at a glance: connected codespace name, machine type, and idle-time remaining. Clicking the item could open a quick-pick menu with common actions (disconnect, stop, open SSH terminal). This keeps critical info visible without needing the sidebar open.

---

## 3. Codespace Search & Filter

Users with many codespaces across multiple repos need a way to quickly narrow the tree view. Add a filter input at the top of the sidebar (via `TreeView.message` or a custom webview) supporting:
- Free-text search across codespace name, repo, and branch
- State filter chips (Running / Stopped / All)
- Sort options (last used, name, repo)

---

## 4. Bulk Operations

Currently every action (stop, delete) targets a single codespace. Add multi-select support so users can select several codespaces and batch-stop or batch-delete them. This is especially useful for cleanup after a sprint or when switching projects. Implement via VS Code's native tree multi-select API and a confirmation dialog summarizing the batch.

---

## 5. Codespace Creation Templates

Let users save a codespace configuration (repo, branch, machine type, idle timeout, devcontainer path) as a named template. Templates would be stored in workspace or global settings and surfaced as a quick-pick list when creating a new codespace, reducing repetitive input for teams that spin up the same environment frequently.

---

## 6. Cost Estimation & Usage Tracking

Show estimated cost information alongside machine specs in the detail view — e.g. "$0.18/hr" for a 2-core machine, "$0.36/hr" for 4-core. A summary panel could display total active hours this billing cycle (derived from `gh api` billing endpoints). This helps users make informed decisions about machine type and idle timeout.

---

## 7. Devcontainer Configuration Preview

Before connecting or creating, let users preview the `devcontainer.json` for a codespace or repository. Display it in a read-only editor tab fetched via `gh api` (repo contents endpoint). This helps users verify features, extensions, and post-create commands before committing to a potentially long container build.

---

## 8. Automatic Stale Codespace Cleanup

Add a notification or tree decoration that flags codespaces idle for a configurable number of days (e.g. 14). On extension activation, scan for stale codespaces and prompt the user: "You have 3 codespaces unused for 14+ days. Stop or delete them to save costs?" This prevents billing surprises from forgotten environments.

---

## 9. Connection Health Monitor

After connecting via SSH, periodically ping the remote to detect dropped connections. If the connection becomes unresponsive, show a warning notification with options to reconnect or disconnect gracefully. This avoids the current experience where a dead tunnel leaves the user in a broken remote window with no clear indication of what went wrong.

---

## 10. Automated Test Suite

The project currently has no tests. Adding a test suite would improve reliability and make contributing safer. Suggested approach:
- **Unit tests** for pure functions (`formatting.ts`, `sshConfigManager.ts`, `constants.ts`) using Mocha + the VS Code test runner
- **Integration tests** for `ghCli.ts` using a mock `child_process.execFile` to verify command construction and response parsing
- **UI tests** for `codespaceTreeProvider.ts` verifying tree structure, polling logic, and state transitions
- Add `npm test` script and CI workflow (GitHub Actions) to run on every PR
