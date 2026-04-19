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
  dotSize: number;
  dotOpacity: number;
  arrowColor: string;
  arrowOpacity: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

// --------------------------------------------------------------------------
// Severity constants
// --------------------------------------------------------------------------

const SEVERITY_ORDER: vscode.DiagnosticSeverity[] = [
  vscode.DiagnosticSeverity.Error,
  vscode.DiagnosticSeverity.Warning,
  vscode.DiagnosticSeverity.Information,
  vscode.DiagnosticSeverity.Hint,
];

const SEVERITY_COLORS: Record<vscode.DiagnosticSeverity, RGB> = {
  [vscode.DiagnosticSeverity.Error]:       { r: 240, g: 71,  b: 71  },
  [vscode.DiagnosticSeverity.Warning]:     { r: 229, g: 192, b: 59  },
  [vscode.DiagnosticSeverity.Information]: { r: 75,  g: 156, b: 240 },
  [vscode.DiagnosticSeverity.Hint]:        { r: 100, g: 200, b: 140 },
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

function blendColors(bg: RGB, fg: RGB, t: number): RGB {
  t = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(bg.r + (fg.r - bg.r) * t),
    g: Math.round(bg.g + (fg.g - bg.g) * t),
    b: Math.round(bg.b + (fg.b - bg.b) * t),
  };
}

function luminance(c: RGB): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function bestTextColor(bg: RGB): string {
  const white: RGB = { r: 255, g: 255, b: 255 };
  const black: RGB = { r: 20,  g: 20,  b: 20  };
  return contrastRatio(bg, white) >= contrastRatio(bg, black) ? '#ffffff' : '#141414';
}

function toHex(c: RGB): string {
  return (
    '#' +
    c.r.toString(16).padStart(2, '0') +
    c.g.toString(16).padStart(2, '0') +
    c.b.toString(16).padStart(2, '0')
  );
}

function toRgba(c: RGB, opacity: number): string {
  return `rgba(${c.r},${c.g},${c.b},${opacity})`;
}

/**
 * Parse a user-supplied hex color string into RGB.
 * Returns null if invalid, so callers can fall back to a default.
 */
function parseHex(hex: string): RGB | null {
  const clean = hex.replace(/^#/, '');
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

/** Default editor background — used for pill color blending. */
const EDITOR_BG: RGB = { r: 30, g: 30, b: 30 };

/** Default muted arrow color when none is configured. */
const ARROW_DEFAULT: RGB = { r: 140, g: 140, b: 140 };

// --------------------------------------------------------------------------
// SVG glyph icon
// --------------------------------------------------------------------------

/**
 * Build a data-URI SVG circle for the glyph margin.
 * dotSize scales the radius (base radius = 4.5 in a 16×16 viewBox).
 * dotOpacity controls the fill opacity.
 */
function makeDotSvgUri(color: string, dotSize: number, dotOpacity: number): vscode.Uri {
  const r = Math.min(7, Math.max(1.5, 4.5 * dotSize));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="${r.toFixed(2)}" fill="${color}" opacity="${dotOpacity}"/>` +
    `</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

// --------------------------------------------------------------------------
// Decoration type cache
// --------------------------------------------------------------------------

const decorationCache = new Map<string, vscode.TextEditorDecorationType>();

function getOrCreate(
  key: string,
  make: () => vscode.DecorationRenderOptions
): vscode.TextEditorDecorationType {
  const cached = decorationCache.get(key);
  if (cached) { return cached; }
  const dt = vscode.window.createTextEditorDecorationType(make());
  decorationCache.set(key, dt);
  return dt;
}

function clearDecorationCache(): void {
  for (const dt of decorationCache.values()) { dt.dispose(); }
  decorationCache.clear();
}

// --------------------------------------------------------------------------
// Per-editor applied-decoration tracking
// --------------------------------------------------------------------------

const editorApplied = new Map<string, Set<string>>();

function clearEditorDecorations(editor: vscode.TextEditor): void {
  const uri = editor.document.uri.toString();
  const keys = editorApplied.get(uri);
  if (!keys) { return; }
  for (const key of keys) {
    const dt = decorationCache.get(key);
    if (dt) { editor.setDecorations(dt, []); }
  }
  keys.clear();
}

function recordApplied(editor: vscode.TextEditor, key: string): void {
  const uri = editor.document.uri.toString();
  if (!editorApplied.has(uri)) { editorApplied.set(uri, new Set()); }
  editorApplied.get(uri)!.add(key);
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
    dotSize:          cfg.get<number>('dotSize', 1.0),
    dotOpacity:       cfg.get<number>('dotOpacity', 0.85),
    arrowColor:       cfg.get<string>('arrowColor', ''),
    arrowOpacity:     cfg.get<number>('arrowOpacity', 0.55),
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
// Helpers
// --------------------------------------------------------------------------

function truncate(msg: string, max: number): string {
  return msg.length <= max ? msg : msg.slice(0, max) + '…';
}

type LineMap = Map<
  number,
  { diagnostics: vscode.Diagnostic[]; severities: vscode.DiagnosticSeverity[] }
>;

function buildLineMap(diags: readonly vscode.Diagnostic[], cfg: DiagnosticConfig): LineMap {
  const map: LineMap = new Map();
  for (const diag of diags) {
    if (!isSeverityEnabled(diag.severity, cfg)) { continue; }
    const line = diag.range.start.line;
    if (!map.has(line)) { map.set(line, { diagnostics: [], severities: [] }); }
    const entry = map.get(line)!;
    entry.diagnostics.push(diag);
    if (!entry.severities.includes(diag.severity)) { entry.severities.push(diag.severity); }
  }
  return map;
}

function eolRange(line: number): vscode.Range {
  return new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER);
}

// --------------------------------------------------------------------------
// Arrow decoration
//
// Uses U+2192 (→) — a single Unicode glyph that always renders as one
// connected unit regardless of font, zoom level, or ligature settings.
// Color and opacity are fully user-configurable.
// --------------------------------------------------------------------------

function arrowCssColor(cfg: DiagnosticConfig): string {
  const rgb = cfg.arrowColor ? parseHex(cfg.arrowColor) : null;
  const base = rgb ?? ARROW_DEFAULT;
  return toRgba(base, cfg.arrowOpacity);
}

function getArrowType(cfg: DiagnosticConfig): vscode.TextEditorDecorationType {
  const color = arrowCssColor(cfg);
  const key = `arrow|${color}`;
  return getOrCreate(key, () => ({
    after: {
      // No background — the arrow is visually outside the pill.
      margin: '0 0 0 8px',
      fontStyle: 'normal',
      fontWeight: 'normal',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  }));
}

// --------------------------------------------------------------------------
// Pill decoration
//
// Two variants are registered separately so that dot-mode pills can inject
// a scaled font-size for the ● glyphs without affecting message-mode pills.
//
// Pill padding uses em units so it scales with the editor font size.
// --------------------------------------------------------------------------

function getPillType(
  bgHex: string,
  pillOpacity: number,
  mode: 'dot' | 'msg',
  dotSize: number
): vscode.TextEditorDecorationType {
  const key = `pill|${mode}|${bgHex}|${pillOpacity}|${dotSize}`;
  return getOrCreate(key, () => {
    // Dot mode: enlarge the ● glyphs via font-size injection.
    // Message mode: normal font size, slightly more generous horizontal padding.
    const dotFontSize = Math.max(0.5, Math.min(2.5, dotSize * 1.1));
    const cssExtra =
      mode === 'dot'
        ? `font-size: ${dotFontSize}em; border-radius: 999px; padding: 0.15em 0.55em;`
        : `border-radius: 999px; padding: 0.18em 0.7em;`;

    return {
      after: {
        // textDecoration is injected verbatim into CSS — the semicolons after
        // "none" let us append border-radius, padding, and font-size without
        // a dedicated API (a widely-used VS Code extension technique).
        textDecoration: `none; ${cssExtra}`,
        margin: '0 0 0 4px',
        fontStyle: 'normal',
        fontWeight: 'normal',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    };
  });
}

// --------------------------------------------------------------------------
// Glyph margin decoration
// --------------------------------------------------------------------------

function getGutterType(
  severity: vscode.DiagnosticSeverity,
  dotSize: number,
  dotOpacity: number
): vscode.TextEditorDecorationType {
  const color = toHex(SEVERITY_COLORS[severity]);
  const key = `gutter|${color}|${dotSize}|${dotOpacity}`;
  return getOrCreate(key, () => ({
    gutterIconPath: makeDotSvgUri(color, dotSize, dotOpacity),
    gutterIconSize: 'contain',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  }));
}

// --------------------------------------------------------------------------
// Apply all decorations for one editor
// --------------------------------------------------------------------------

function applyDecorations(
  editor: vscode.TextEditor,
  lineMap: LineMap,
  activeLine: number,
  cfg: DiagnosticConfig
): void {
  // Resolve arrow color once — same across all lines.
  const arrowRgba = arrowCssColor(cfg);

  const arrowBatch: vscode.DecorationOptions[] = [];

  // Separate pill batches for dot-mode and msg-mode to allow different font-size.
  const dotPillBatches = new Map<string, { ranges: vscode.DecorationOptions[]; bgHex: string }>();
  const msgPillBatches = new Map<string, { ranges: vscode.DecorationOptions[]; bgHex: string }>();

  const gutterBatches = new Map<vscode.DiagnosticSeverity, vscode.DecorationOptions[]>();

  for (const [line, { diagnostics, severities }] of lineMap) {
    const isActive  = line === activeLine;
    const dominant  = highestSeverity(severities);
    const diagColor = SEVERITY_COLORS[dominant];
    const blended   = blendColors(EDITOR_BG, diagColor, cfg.pillTransparency);
    const bgHex     = toHex(blended);
    const bgRgba    = toRgba(blended, cfg.pillOpacity);
    const textColor = bestTextColor(blended);

    // ── Arrow — U+2192 (→): single glyph, always one visual unit ────────
    arrowBatch.push({
      range: eolRange(line),
      renderOptions: {
        after: {
          contentText: '\u2192',   // → right arrow, single glyph
          color: arrowRgba,
        },
      },
    });

    // ── Pill ─────────────────────────────────────────────────────────────
    if (isActive) {
      // Message mode: show highest-severity diagnostic text.
      const sorted = [...diagnostics].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );
      const raw = sorted[0].message.replace(/\n/g, ' ').trim();
      const pillContent = truncate(raw, cfg.maxMessageLength);

      const batchKey = bgHex;
      if (!msgPillBatches.has(batchKey)) {
        msgPillBatches.set(batchKey, { ranges: [], bgHex });
      }
      msgPillBatches.get(batchKey)!.ranges.push({
        range: eolRange(line),
        renderOptions: {
          after: {
            contentText: pillContent,
            color: textColor,
            backgroundColor: bgRgba,
          },
        },
      });
    } else {
      // Dot mode: one ● per distinct severity present, colored by dot opacity.
      // Each ● uses the pill's single text color — VS Code doesn't allow
      // per-character color within a single `after` element, so dots are
      // uniformly colored against the blended pill background.
      const dots = SEVERITY_ORDER
        .filter(s => severities.includes(s))
        .map(() => '\u25CF')  // ● BLACK CIRCLE
        .join(' ');

      // Apply dotOpacity to the text color for dot-specific opacity control.
      const dotTextRgb = bestTextColor(blended) === '#ffffff'
        ? { r: 255, g: 255, b: 255 }
        : { r: 20,  g: 20,  b: 20  };
      const dotColor = toRgba(dotTextRgb, cfg.dotOpacity);

      const batchKey = `${bgHex}|${cfg.dotOpacity}`;
      if (!dotPillBatches.has(batchKey)) {
        dotPillBatches.set(batchKey, { ranges: [], bgHex });
      }
      dotPillBatches.get(batchKey)!.ranges.push({
        range: eolRange(line),
        renderOptions: {
          after: {
            contentText: dots,
            color: dotColor,
            backgroundColor: bgRgba,
          },
        },
      });
    }

    // ── Glyph margin ─────────────────────────────────────────────────────
    if (!gutterBatches.has(dominant)) { gutterBatches.set(dominant, []); }
    gutterBatches.get(dominant)!.push({
      range: new vscode.Range(line, 0, line, 0),
    });
  }

  // ── Apply arrow ──────────────────────────────────────────────────────────
  {
    const arrowKey = `arrow|${arrowRgba}`;
    const arrowType = getArrowType(cfg);
    editor.setDecorations(arrowType, arrowBatch);
    recordApplied(editor, arrowKey);
  }

  // ── Apply dot-mode pills ─────────────────────────────────────────────────
  for (const [batchKey, { ranges, bgHex }] of dotPillBatches) {
    const typeKey = `pill|dot|${bgHex}|${cfg.pillOpacity}|${cfg.dotSize}`;
    const pillType = getPillType(bgHex, cfg.pillOpacity, 'dot', cfg.dotSize);
    editor.setDecorations(pillType, ranges);
    recordApplied(editor, typeKey);
  }

  // ── Apply message-mode pills ─────────────────────────────────────────────
  for (const [, { ranges, bgHex }] of msgPillBatches) {
    const typeKey = `pill|msg|${bgHex}|${cfg.pillOpacity}|${cfg.dotSize}`;
    const pillType = getPillType(bgHex, cfg.pillOpacity, 'msg', cfg.dotSize);
    editor.setDecorations(pillType, ranges);
    recordApplied(editor, typeKey);
  }

  // ── Apply glyph margin dots ──────────────────────────────────────────────
  for (const [severity, ranges] of gutterBatches) {
    const gutterKey = `gutter|${toHex(SEVERITY_COLORS[severity])}|${cfg.dotSize}|${cfg.dotOpacity}`;
    const gutterType = getGutterType(severity, cfg.dotSize, cfg.dotOpacity);
    editor.setDecorations(gutterType, ranges);
    recordApplied(editor, gutterKey);
  }
}

// --------------------------------------------------------------------------
// Main update function
// --------------------------------------------------------------------------

function updateEditor(editor: vscode.TextEditor | undefined): void {
  if (!editor) { return; }

  const cfg        = getConfig();
  const diags      = vscode.languages.getDiagnostics(editor.document.uri);
  const activeLine = editor.selection.active.line;

  clearEditorDecorations(editor);

  if (diags.length === 0) { return; }

  const lineMap = buildLineMap(diags, cfg);
  if (lineMap.size === 0) { return; }

  applyDecorations(editor, lineMap, activeLine, cfg);
}

// --------------------------------------------------------------------------
// Debounce
// --------------------------------------------------------------------------

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(() => fn(...args), ms);
  };
}

// --------------------------------------------------------------------------
// Extension lifecycle
// --------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const debouncedUpdate = debounce((editor: vscode.TextEditor | undefined) => {
    updateEditor(editor);
  }, 80);

  for (const editor of vscode.window.visibleTextEditors) {
    updateEditor(editor);
  }

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (e.uris.some(u => u.toString() === editor.document.uri.toString())) {
          debouncedUpdate(editor);
        }
      }
    }),

    vscode.window.onDidChangeActiveTextEditor(editor => {
      debouncedUpdate(editor);
    }),

    vscode.window.onDidChangeTextEditorSelection(e => {
      debouncedUpdate(e.textEditor);
    }),

    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) { debouncedUpdate(editor); }
    }),

    vscode.workspace.onDidChangeTextDocument(e => {
      const editor = vscode.window.visibleTextEditors.find(
        ed => ed.document.uri.toString() === e.document.uri.toString()
      );
      if (editor) { debouncedUpdate(editor); }
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('diagnosticLens')) {
        clearDecorationCache();
        editorApplied.clear();
        for (const editor of vscode.window.visibleTextEditors) {
          updateEditor(editor);
        }
      }
    })
  );
}

export function deactivate(): void {
  clearDecorationCache();
  editorApplied.clear();
}
