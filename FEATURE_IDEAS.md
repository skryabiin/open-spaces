# Open Spaces Feature Ideas

Potential features to add to the extension.

## High-Value Features

- [x] **Create Codespace** - Add ability to create new codespaces directly from the extension. Users could right-click a repository (or use command palette) to create a codespace with options for branch, machine type, and region.

- [x] **Delete Codespace** - Allow users to delete codespaces from the tree view with a confirmation dialog. This completes the CRUD lifecycle.

- [x] **Open SSH Terminal** - Add a command to open a terminal session directly connected to a codespace via SSH, without opening the full remote workspace. Useful for quick commands or troubleshooting.

- [ ] **Port Forwarding Management** - Create a UI to view/manage forwarded ports on running codespaces using `gh codespace ports`. Could show port number, visibility (public/private), and allow changing visibility.

- [ ] **Codespace Logs Viewer** - Add ability to view creation logs and devcontainer logs for debugging failed or misbehaving codespaces (`gh codespace logs`).

## Quality-of-Life Features

- [ ] **Quick Connect (Last Used)** - Add a status bar item or command that quickly connects to your most recently used codespace with one click.

- [ ] **Auto-Stop Timer** - Show remaining idle timeout and allow users to extend it, or configure auto-stop behavior to save billing.

- [ ] **Machine Type Display & Upgrade** - Show current machine specs (cores, RAM) in the detail view. Allow changing machine type for stopped codespaces.

- [ ] **Codespace Rename** - Allow renaming codespaces to more meaningful display names.

- [ ] **Copy SSH Command** - Right-click option to copy the SSH connection command to clipboard for use in external terminals.

## Advanced Features

- [ ] **Multi-Account Support** - Support switching between multiple GitHub accounts/organizations.

- [ ] **Secrets Management** - View and manage codespace secrets via `gh codespace secret`.

- [ ] **Prebuild Status** - Show prebuild availability for repositories and trigger prebuilds.
