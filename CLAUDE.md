# CLAUDE.md

VS Code extension that connects to GitHub Codespaces from Code-OSS/VSCodium via SSH tunneling.

## Commands

```bash
npm run compile    # Build TypeScript
npm run watch      # Dev mode with auto-rebuild
npm run lint       # ESLint
npm run package    # Create .vsix
```

## Structure

- `src/extension.ts` - Entry point, command registration
- `src/codespaceManager.ts` - Core codespace operations
- `src/ghCli.ts` - GitHub CLI wrapper
- `src/sshConfigManager.ts` - SSH config file management
- `src/ui/` - Tree view provider and items
