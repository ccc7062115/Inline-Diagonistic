import * as vscode from 'vscode';

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface DiagnosticConfig {
  enableErrors: boolean;
  enableWarnings: boolean;
  enableHints: boolean;
  enableInfo: boolean;
  pillTransparency: number;
  pillOpacity: number;
  maxMessageLength: number;
}

interface SeverityColor {
  r: number;
  g: number;
  b: number;
}

// --------------------------------------------------------------------------
// Severity helpers
// --------------------------------------------------------------------------

const SEVERITY_ORDER = [
  vscode.DiagnosticSeverity.Error,
  vscode.DiagnosticSeverity.Warning,
  vscode.DiagnosticSeverity.Information,
  vscode.DiagnosticSeverity.Hint,
];

const SEVERITY_COLORS: Record<vscode.DiagnosticSeverity, SeverityColor> = {
  [vscode.DiagnosticSeverity.Error]:       { r: 240, g: 71,  b: 71  },
  [vscode.DiagnosticSeverity.Warning]:     { r: 229, g: 192, b: 59  },
  [vscode.DiagnosticSeverity.Information]: { r: 75,  g: 156, b: 240 },
  [vscode.DiagnosticSeverity.Hint]:        { r: 100, g: 200, b: 140 },
};

const SEVERITY_DOT_CHAR: Record<vscode.DiagnosticSeverity, string> = {
  [vscode.DiagnosticSeverity.Error]:       '●',
  [vscode.DiagnosticSeverity.Warning]:     '●',
  [vscode.DiagnosticSeverity.Information]: '●',
  [vscode.DiagnosticSeverity.Hint]:        '●',
};

function highestSeverity(severities: vscode.DiagnosticSeverity[]): vscode.DiagnosticSeverity {
  for (const s of SEVERITY_ORDER) {
    if (severities.includes(s)) { return s; }
  }
  return severities[0];
}

// --------------------------------------------------------------------------
// Color utilities
// --------------------------------------------------------------------------

function parseHexColor(hex: string): SeverityColor | null {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return null;
}

/**
 * Simulate a blended background by mixing editorBg with the diagnostic color.
 * transparency=0 → fully editor background, transparency=1 → full diagnostic color.
 */
function blendColors(bg: SeverityColor, fg: SeverityColor, transparency: number): SeverityColor {
  const t = Math.max(0, Math.min(1, transparency));
  return {
    r: Math.round(bg.r + (fg.r - bg.r) * t),
    g: Math.round(bg.g + (fg.g - bg.g) * t),
    b: Math.round(bg.b + (fg.b - bg.b) * t),
  };
}

function luminance(c: SeverityColor): number {
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

function contrastRatio(a: SeverityColor, b: SeverityColor): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function bestTextColor(bg: SeverityColor): string {
  const white: SeverityColor = { r: 255, g: 255, b: 255 };
  const black: SeverityColor = { r: 20, g: 20, b: 20 };
  return contrastRatio(bg, white) >= contrastRatio(bg, black) ? '#ffffff' : '#141414';
}

function toHex(c: SeverityColor): string {
  return (
    '#' +
    c.r.toString(16).padStart(2, '0') +
    c.g.toString(16).padStart(2, '0') +
    c.b.toString(16).padStart(2, '0')
  );
}

function toRgba(c: SeverityColor, opacity: number): string {
  return `rgba(${c.r},${c.g},${c.b},${opacity})`;
}

// --------------------------------------------------------------------------
// Decoration type cache
// The extension creates one TextEditorDecorationType per unique style combo.
// We reuse them to avoid leaking decoration types (each creates a CSS rule).
// --------------------------------------------------------------------------

const decorationCache = new Map<string, vscode.TextEditorDecorationType>();

function getOrCreateDecorationType(
  key: string,
  options: vscode.DecorationRenderOptions
): vscode.TextEditorDecorationType {
  const cached = decorationCache.get(key);
  if (cached) { return cached; }
  const dt = vscode.window.createTextEditorDecorationType(options);
  decorationCache.set(key, dt);
  return dt;
}

function clearDecorationCache(): void {
  for (const dt of decorationCache.values()) {
    dt.dispose();
  }
  decorationCache.clear();
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

function getConfig(): DiagnosticConfig {
  const cfg = vscode.workspace.getConfiguration('diagnosticLens');
  return {
    enableErrors:     cfg.get<boolean>('enableErrors', true),
    enableWarnings:   cfg.get<boolean>('enableWarnings', true),
    enableHints:      cfg.get<boolean>('enableHints', true),
    enableInfo:       cfg.get<boolean>('enableInfo', true),
    pillTransparency: cfg.get<number>('pillTransparency', 0.15),
    pillOpacity:      cfg.get<number>('pillOpacity', 0.9),
    maxMessageLength: cfg.get<number>('maxMessageLength', 30),
  };
}

function isSeverityEnabled(sev: vscode.DiagnosticSeverity, cfg: DiagnosticConfig): boolean {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:       return cfg.enableErrors;
    case vscode.DiagnosticSeverity.Warning:     return cfg.enableWarnings;
    case vscode.DiagnosticSeverity.Information: return cfg.enableInfo;
    case vscode.DiagnosticSeverity.Hint:        return cfg.enableHints;
  }
}

// --------------------------------------------------------------------------
// Editor background detection
// --------------------------------------------------------------------------

function getEditorBackground(): SeverityColor {
  // Try to get the theme color via API — falls back gracefully if unavailable.
  const themeColor = new vscode.ThemeColor('editor.background');
  void themeColor; // We can't read the actual hex via API; use a sensible default per kind.
  // We use a neutral dark fallback. Users can fine-tune via transparency setting.
  return { r: 30, g: 30, b: 30 };
}

// --------------------------------------------------------------------------
// Pill rendering
// --------------------------------------------------------------------------

function truncate(msg: string, max: number): string {
  if (msg.length <= max) { return msg; }
  return msg.slice(0, max) + '…';
}

interface PillStyle {
  pillBg: string;
  pillBgOpaque: string;
  textColor: string;
  opacity: number;
}

function computePillStyle(
  dominantSeverity: vscode.DiagnosticSeverity,
  cfg: DiagnosticConfig,
  editorBg: SeverityColor
): PillStyle {
  const diagColor = SEVERITY_COLORS[dominantSeverity];
  const blended = blendColors(editorBg, diagColor, cfg.pillTransparency);
  const textColor = bestTextColor(blended);
  const pillBg = toRgba(blended, cfg.pillOpacity);
  const pillBgOpaque = toHex(blended);
  return { pillBg, pillBgOpaque, textColor, opacity: cfg.pillOpacity };
}

// --------------------------------------------------------------------------
// Main decoration manager
// --------------------------------------------------------------------------

type LineDecorationsMap = Map<
  number,
  { diagnostics: vscode.Diagnostic[]; severities: vscode.DiagnosticSeverity[] }
>;

function groupDiagnosticsByLine(
  diags: readonly vscode.Diagnostic[],
  cfg: DiagnosticConfig
): LineDecorationsMap {
  const map: LineDecorationsMap = new Map();
  for (const diag of diags) {
    if (!isSeverityEnabled(diag.severity, cfg)) { continue; }
    const line = diag.range.start.line;
    if (!map.has(line)) {
      map.set(line, { diagnostics: [], severities: [] });
    }
    const entry = map.get(line)!;
    entry.diagnostics.push(diag);
    if (!entry.severities.includes(diag.severity)) {
      entry.severities.push(diag.severity);
    }
  }
  return map;
}

// We need separate decoration types per line because each carries unique text.
// To keep things tidy we batch by (severity, isActive) for the static style,
// but the `contentText` is unique per line so we still create per-line types.
// However, creating hundreds of decoration types is expensive. We instead use a
// single decoration type with `after` per line range — VS Code supports
// per-range `renderOptions` with `after.contentText` which lets us reuse one
// decoration type and inject unique text per range via the options object.

function applyDecorations(
  editor: vscode.TextEditor,
  lineMap: LineDecorationsMap,
  activeLine: number,
  cfg: DiagnosticConfig
): void {
  const editorBg = getEditorBackground();

  // Group ranges by a style key so we can batch into fewer decoration types.
  // Style key = severity + active + transparency + opacity (all affect visual appearance).
  type StyleKey = string;
  const styleGroups = new Map<
    StyleKey,
    { options: vscode.DecorationRenderOptions; ranges: vscode.DecorationOptions[] }
  >();

  for (const [line, { diagnostics, severities }] of lineMap) {
    const isActive = line === activeLine;
    const dominant = highestSeverity(severities);
    const { pillBg, textColor } = computePillStyle(dominant, cfg, editorBg);

    let contentText: string;

    if (isActive) {
      // Show highest severity message text
      const sorted = [...diagnostics].sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );
      const msg = sorted[0].message.replace(/\n/g, ' ').trim();
      contentText = ' ' + truncate(msg, cfg.maxMessageLength) + ' ';
    } else {
      // Show colored dots for each distinct severity type present
      const sortedSeverities = SEVERITY_ORDER.filter(s => severities.includes(s));
      const dots = sortedSeverities
        .map(s => {
          const c = SEVERITY_COLORS[s];
          return SEVERITY_DOT_CHAR[s];
        })
        .join(' ');
      contentText = ' ' + dots + ' ';
    }

    // The arrow is placed between the line end and the pill.
    const arrowText = ' -> ';

    // Style key: we use a per-line key because contentText is unique,
    // but VS Code's DecorationRenderOptions.after.contentText can be set
    // per-range via the `renderOptions` of each DecorationOptions entry.
    // We reuse one decoration type per (dominant severity + isActive flag +
    // transparency config) and vary `contentText` via per-range renderOptions.

    const dominantColorKey = toHex(
      blendColors(editorBg, SEVERITY_COLORS[dominant], cfg.pillTransparency)
    );
    const styleKey = `${dominantColorKey}|${cfg.pillOpacity}`;

    if (!styleGroups.has(styleKey)) {
      // Base decoration type — we'll use per-range renderOptions to override contentText.
      const baseOptions: vscode.DecorationRenderOptions = {
        after: {
          margin: '0 0 0 4px',
          border: '0px',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      };
      styleGroups.set(styleKey, { options: baseOptions, ranges: [] });
    }

    // Compute dot colors for non-active lines as inline CSS
    let dotColorsStyle = '';
    if (!isActive) {
      const sortedSevs = SEVERITY_ORDER.filter(s => severities.includes(s));
      dotColorsStyle = sortedSevs
        .map(s => toRgba(SEVERITY_COLORS[s], cfg.pillOpacity))
        .join('|');
    }

    // Build per-range overrides using VS Code's `renderOptions` property.
    const rangeOptions: vscode.DecorationOptions = {
      range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
      renderOptions: {
        after: {
          contentText: arrowText + contentText,
          color: textColor,
          backgroundColor: pillBg,
          border: `1px solid ${pillBg}`,
          margin: '0 0 0 2px',
          fontStyle: 'normal',
          fontWeight: 'normal',
        },
      },
    };

    styleGroups.get(styleKey)!.ranges.push(rangeOptions);
  }

  // Apply each group as a single decoration type
  const allActiveKeys = new Set<string>();
  for (const [key, { options, ranges }] of styleGroups) {
    const dt = getOrCreateDecorationType(key, options);
    editor.setDecorations(dt, ranges);
    allActiveKeys.add(key);
  }

  // Clear decoration types that were previously used for this editor but are no longer needed
  // (handled by clearing all types during a full refresh — see clearForEditor)
}

// --------------------------------------------------------------------------
// Active decorations tracker per editor URI
// --------------------------------------------------------------------------

const editorActiveKeys = new Map<string, Set<string>>();

function clearForEditor(editor: vscode.TextEditor): void {
  const uri = editor.document.uri.toString();
  const prev = editorActiveKeys.get(uri);
  if (prev) {
    for (const key of prev) {
      const dt = decorationCache.get(key);
      if (dt) { editor.setDecorations(dt, []); }
    }
  }
}

// --------------------------------------------------------------------------
// Main update function
// --------------------------------------------------------------------------

function updateEditor(editor: vscode.TextEditor | undefined): void {
  if (!editor) { return; }

  const cfg = getConfig();
  const diags = vscode.languages.getDiagnostics(editor.document.uri);
  const activeLine = editor.selection.active.line;

  // Clear existing decorations first
  clearForEditor(editor);

  if (diags.length === 0) { return; }

  const lineMap = groupDiagnosticsByLine(diags, cfg);
  if (lineMap.size === 0) { return; }

  applyDecorations(editor, lineMap, activeLine, cfg);
}

// --------------------------------------------------------------------------
// Debounce
// --------------------------------------------------------------------------

function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number
): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => fn(...args), ms);
  };
}

// --------------------------------------------------------------------------
// Extension entry points
// --------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const debouncedUpdate = debounce((editor: vscode.TextEditor | undefined) => {
    updateEditor(editor);
  }, 100);

  // Initial pass on all visible editors
  for (const editor of vscode.window.visibleTextEditors) {
    updateEditor(editor);
  }

  // When diagnostics change
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (e.uris.some(u => u.toString() === editor.document.uri.toString())) {
          debouncedUpdate(editor);
        }
      }
    })
  );

  // When the active editor changes (need to redraw + update active line)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      debouncedUpdate(editor);
    })
  );

  // When the cursor moves (active line changes → pill content changes)
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      debouncedUpdate(e.textEditor);
    })
  );

  // When a new visible editor appears (e.g. split)
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) {
        debouncedUpdate(editor);
      }
    })
  );

  // When the document text changes (diagnostics may shift)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const editor = vscode.window.visibleTextEditors.find(
        ed => ed.document.uri.toString() === e.document.uri.toString()
      );
      if (editor) { debouncedUpdate(editor); }
    })
  );

  // When settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('diagnosticLens')) {
        clearDecorationCache();
        for (const editor of vscode.window.visibleTextEditors) {
          updateEditor(editor);
        }
      }
    })
  );
}

export function deactivate(): void {
  clearDecorationCache();
}
