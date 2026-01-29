# Open Spaces

Connect to GitHub Codespaces from Code-OSS, VS Codium, or other open-source VS Code distributions using the GitHub CLI and [open-remote-ssh](https://open-vsx.org/extension/jeanp413/open-remote-ssh).

## Features

- **Browse Codespaces** - View all your GitHub Codespaces in a sidebar tree view
- **Connect via SSH** - Connect to codespaces using SSH tunneling (no proprietary extensions required)
- **Start/Stop Codespaces** - Manage codespace lifecycle directly from the editor
- **Rebuild Codespaces** - Trigger regular or full rebuilds from the context menu
- **Automatic SSH Configuration** - Manages `~/.ssh/config` entries automatically
- **Authentication Helper** - Quick access to GitHub CLI authentication

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated with `codespace` scope
- [open-remote-ssh](https://open-vsx.org/extension/jeanp413/open-remote-ssh) extension installed
- SSHD feature in `.devcontainer/devcontainer.json`:

```json
    "features": {
        "ghcr.io/devcontainers/features/sshd:1": {},    
        ...
    }
```

## Installation

### From Open VSX

Search for "Open Spaces" in the extensions marketplace.

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/skryabiin/open-spaces/releases)
2. Install via command palette: `Extensions: Install from VSIX...`

## Setup

1. Install the GitHub CLI: https://cli.github.com/
2. Authenticate with codespace scope:
   ```bash
   gh auth login --scopes codespace
   ```
3. Install the open-remote-ssh extension
4. Open the "GitHub Codespaces" view in the activity bar

## Usage

### Connecting to a Codespace

1. Click the GitHub Codespaces icon in the activity bar
2. Your codespaces will be listed by repository
3. Click the plug icon to connect, or right-click for more options

### Managing Codespaces

- **Start**: Click the play icon on a stopped codespace
- **Stop**: Click the stop icon on a running codespace
- **Rebuild**: Right-click and select "Rebuild Codespace"
- **Full Rebuild**: Right-click and select "Rebuild Codespace (Full)" to rebuild without cache

### Disconnecting

When connected to a codespace, click the disconnect icon in the view title bar.

## How It Works

This extension uses the GitHub CLI to:
1. List your codespaces (`gh codespace list`)
2. Generate SSH configuration (`gh codespace ssh --config`)
3. Manage codespace state (`gh codespace start/stop`)

SSH configuration is written to a managed section in `~/.ssh/config`, which open-remote-ssh uses to establish the connection.

## Port Forwarding

Port forwarding works via SSH tunneling. Ports defined in your `devcontainer.json` will be forwarded automatically by VS Code's Remote SSH functionality.

**Note**: If you have `onAutoForward: "openBrowser"` configured, it may open a random forwarded port instead of the expected localhost port. Set `onAutoForward: "silent"` if you prefer to navigate to `localhost:<port>` directly.

## Troubleshooting

### "GitHub CLI not installed"

Install the GitHub CLI from https://cli.github.com/

### "Authentication required"

Run `gh auth login --scopes codespace` or click the terminal icon in the extension view.

### Codespaces not appearing

- Ensure you're authenticated: `gh auth status`
- Check codespace scope: `gh auth status` should show `codespace` in scopes
- Refresh the view using the refresh icon

### Connection fails

- Verify open-remote-ssh is installed
- Check that `gh codespace ssh` works from the terminal
- Ensure SSH keys are set up: `gh codespace ssh <codespace-name>` will prompt to create keys if needed

## License

MIT

## Contributing

Contributions welcome! Please open an issue or pull request at https://github.com/skryabiin/open-spaces
