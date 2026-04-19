# Diagnostic Lens

A VS Code extension that enhances how diagnostics (errors, warnings, hints, info) are visually presented inline within the editor — without altering the editor's layout or behavior.

## Features

- **Inline pill indicators** appended at the end of every line with a diagnostic
- An arrow `->` precedes the pill, visually separating it from the code
- **Dot mode**: when your cursor is elsewhere, compact colored dots indicate the types of diagnostics present
- **Message mode**: when your cursor is on a diagnostic line, the pill shows the highest-severity message (up to 30 characters, configurable)
- **Color blending**: the pill background is blended with your editor's background — no harsh transparency artifacts
- **Contrast-aware text**: pill text color automatically adjusts for readability
- Works with diagnostics from all extensions: rust-analyzer, Pylance, ESLint, GCC integrations, and more

## Configuration

All settings are under `diagnosticLens.*`:

| Setting | Default | Description |
|---|---|---|
| `enableErrors` | `true` | Show indicators for errors |
| `enableWarnings` | `true` | Show indicators for warnings |
| `enableHints` | `true` | Show indicators for hints |
| `enableInfo` | `true` | Show indicators for informational messages |
| `pillTransparency` | `0.15` | Background blend intensity (0 = editor bg, 1 = full diagnostic color) |
| `pillOpacity` | `0.9` | Visual opacity of the pill (0–1) |
| `maxMessageLength` | `30` | Max characters shown in message mode |

## Severity Colors

| Severity | Color |
|---|---|
| Error | Red |
| Warning | Yellow |
| Information | Blue |
| Hint | Green |

## Installation

### From `.vsix` file

```bash
code --install-extension diagnostic-lens-0.1.0.vsix
```

### Building from source

```bash
npm install
npm run compile
npx vsce package
```

## Design Principles

- Does **not** modify or reflow editor text
- Does **not** introduce layout shifts
- Does **not** degrade editor performance (debounced updates, decoration type caching)
- Preserves all default VS Code interactions, cursor behavior, and existing decorations
- Respects line wrapping behavior
