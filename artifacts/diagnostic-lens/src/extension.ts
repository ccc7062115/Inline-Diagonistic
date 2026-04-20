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
  glyphDotOpacity: number;
  maxMessageLength: number;
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

/**
 * Blend editor background with the diagnostic color.
 * transparency=0 → editor bg only; transparency=1 → full diagnostic color.
 */
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

// Default editor background (dark). Blending keeps pill subtle by default.
const EDITOR_BG: RGB = { r: 30, g: 30, b: 30 };

// --------------------------------------------------------------------------
// SVG glyph icon generation
// --------------------------------------------------------------------------

function makeDotSvgUri(color: string, opacity: number): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="4" fill="${color}" opacity="${opacity}"/>` +
    `</svg>`;
  return vscode.Uri.parse(
    `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  );
}

// --------------------------------------------------------------------------
// Decoration type cache — keyed by unique style string
// --------------------------------------------------------------------------

const decorationCache = new Map<string, vscode.TextEditorDecorationType>();
const documentLineMaps = new Map<string, LineMap>();

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
// Per-editor active decoration key tracking
// --------------------------------------------------------------------------

/** Maps editor URI → set of cache keys currently applied to it */
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
    pillTransparency: clamp01(cfg.get<number>('pillTransparency', 0.15)),
    pillOpacity:      clamp01(cfg.get<number>('pillOpacity', 0.9)),
    glyphDotOpacity:  clamp01(cfg.get<number>('glyphDotOpacity', 0.9)),
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
// Helpers
// --------------------------------------------------------------------------

function truncate(msg: string, max: number): string {
  return msg.length <= max ? msg : msg.slice(0, max) + '…';
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

type LineMap = Map<
  number,
  { diagnostics: vscode.Diagnostic[]; severities: vscode.DiagnosticSeverity[] }
>;

function mergeLineEntry(
  map: LineMap,
  line: number,
  diagnostics: vscode.Diagnostic[],
  severities: vscode.DiagnosticSeverity[]
): void {
  if (!map.has(line)) { map.set(line, { diagnostics: [], severities: [] }); }
  const entry = map.get(line)!;
  entry.diagnostics.push(...diagnostics);
  for (const severity of severities) {
    if (!entry.severities.includes(severity)) { entry.severities.push(severity); }
  }
}

function lineBreakCount(text: string): number {
  if (text.length === 0) { return 0; }
  return text.split(/\r\n|\r|\n/).length - 1;
}

function clampLine(document: vscode.TextDocument, line: number): number {
  return Math.max(0, Math.min(Math.max(0, document.lineCount - 1), line));
}

function transformLine(
  originalLine: number,
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  document: vscode.TextDocument
): number {
  let offset = 0;
  const ordered = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);

  for (const change of ordered) {
    const start = change.range.start.line;
    const end = change.range.end.line;
    const added = lineBreakCount(change.text);
    const removed = end - start;
    const delta = added - removed;
    const isEmpty = change.range.isEmpty;
    const insertsBeforeSameLine = isEmpty && added > 0 && originalLine === start && change.range.start.character === 0;
    const isAfterChangedRange = originalLine > end || (originalLine === end && change.range.end.character === 0 && removed > 0);

    if (insertsBeforeSameLine || isAfterChangedRange) {
      offset += delta;
      continue;
    }

    if (originalLine < start || (originalLine === start && isEmpty)) {
      continue;
    }

    if (originalLine >= start && originalLine <= end) {
      return clampLine(document, start + offset);
    }
  }

  return clampLine(document, originalLine + offset);
}

function transformLineMap(
  map: LineMap,
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  document: vscode.TextDocument
): LineMap {
  const transformed: LineMap = new Map();
  for (const [line, entry] of map) {
    const nextLine = transformLine(line, changes, document);
    mergeLineEntry(transformed, nextLine, entry.diagnostics, entry.severities);
  }
  return transformed;
}

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

// End-of-line anchor range for a given line
function eolRange(line: number): vscode.Range {
  return new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER);
}

// --------------------------------------------------------------------------
// Arrow decoration type (shared, created once per session)
// --------------------------------------------------------------------------

const ARROW_KEY = 'arrow';

function getArrowType(): vscode.TextEditorDecorationType {
  return getOrCreate(ARROW_KEY, () => ({
    after: {
      // plain arrow, no background, no border — purely separate from the pill
      margin: '0 0 0 6px',
      fontStyle: 'normal',
      fontWeight: 'normal',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  }));
}

// --------------------------------------------------------------------------
// Pill decoration type (one per blended-color + opacity combo)
// --------------------------------------------------------------------------

function getPillType(pillBgHex: string, pillOpacity: number): vscode.TextEditorDecorationType {
  const key = `pill|${pillBgHex}|${pillOpacity}`;
  return getOrCreate(key, () => ({
    after: {
      // The textDecoration property is injected verbatim into CSS,
      // allowing us to smuggle in border-radius and padding for the pill shape.
      textDecoration: 'none; border-radius: 999px; padding: 1px 7px;',
      margin: '0 0 0 4px',
      fontStyle: 'normal',
      fontWeight: 'normal',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  }));
}

// --------------------------------------------------------------------------
// Glyph margin decoration type (one per severity, 4 max)
// --------------------------------------------------------------------------

function getGutterType(
  severity: vscode.DiagnosticSeverity,
  opacity: number
): vscode.TextEditorDecorationType {
  const color = toHex(SEVERITY_COLORS[severity]);
  const key = `gutter|${color}|${opacity}`;
  return getOrCreate(key, () => ({
    gutterIconPath: makeDotSvgUri(color, opacity),
    gutterIconSize: '60%',
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
  // We batch ranges per style key to minimise decoration type count.
  //
  // Layer 1 – Arrow (" -> "):  one shared type, contentText set per-range
  // Layer 2 – Pill (dots/msg): one type per blended color, contentText per-range
  // Layer 3 – Gutter dot:      one type per severity (max 4)

  type BatchEntry = { ranges: vscode.DecorationOptions[] };

  const arrowBatch: vscode.DecorationOptions[] = [];

  // pill batches keyed by pillBgHex|pillOpacity
  const pillBatches  = new Map<string, BatchEntry & { bgHex: string; opacity: number }>();

  // gutter batches keyed by DiagnosticSeverity
  const gutterBatches = new Map<vscode.DiagnosticSeverity, vscode.DecorationOptions[]>();

  for (const [line, { diagnostics, severities }] of lineMap) {
    const isActive  = line === activeLine;
    const dominant  = highestSeverity(severities);
    const diagColor = SEVERITY_COLORS[dominant];
    const blended   = blendColors(EDITOR_BG, diagColor, cfg.pillTransparency);
    const bgHex     = toHex(blended);
    const bgRgba    = toRgba(blended, cfg.pillOpacity);
    const textColor = bestTextColor(blended);

    // ── Arrow ────────────────────────────────────────────────────────────
    arrowBatch.push({
      range: eolRange(line),
      renderOptions: {
        after: {
          contentText: '->',
          color: new vscode.ThemeColor('editorInlayHint.foreground'),
        },
      },
    });

    // ── Pill ─────────────────────────────────────────────────────────────
    let pillContent: string;
    if (isActive) {
      const sorted = [...diagnostics].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );
      const msg = sorted[0].message.replace(/\n/g, ' ').trim();
      pillContent = truncate(msg, cfg.maxMessageLength);
    } else {
      // One dot per distinct severity present, ordered highest → lowest
      pillContent = SEVERITY_ORDER
        .filter(s => severities.includes(s))
        .map(() => '●')
        .join(' ');
    }

    const pillKey = `${bgHex}|${cfg.pillOpacity}`;
    if (!pillBatches.has(pillKey)) {
      pillBatches.set(pillKey, { ranges: [], bgHex, opacity: cfg.pillOpacity });
    }
    pillBatches.get(pillKey)!.ranges.push({
      range: eolRange(line),
      renderOptions: {
        after: {
          contentText: pillContent,
          color: textColor,
          backgroundColor: bgRgba,
        },
      },
    });

    // ── Gutter ───────────────────────────────────────────────────────────
    if (!gutterBatches.has(dominant)) {
      gutterBatches.set(dominant, []);
    }
    // Gutter icons use a start-of-line range (character 0)
    gutterBatches.get(dominant)!.push({
      range: new vscode.Range(line, 0, line, 0),
    });
  }

  // ── Apply Arrow ──────────────────────────────────────────────────────────
  const arrowType = getArrowType();
  editor.setDecorations(arrowType, arrowBatch);
  recordApplied(editor, ARROW_KEY);

  // ── Apply Pills ──────────────────────────────────────────────────────────
  for (const [pillKey, { ranges, bgHex, opacity }] of pillBatches) {
    const pillType = getPillType(bgHex, opacity);
    editor.setDecorations(pillType, ranges);
    recordApplied(editor, `pill|${bgHex}|${opacity}`);
  }

  // ── Apply Gutter dots ────────────────────────────────────────────────────
  for (const [severity, ranges] of gutterBatches) {
    const gutterType = getGutterType(severity, cfg.glyphDotOpacity);
    editor.setDecorations(gutterType, ranges);
    recordApplied(editor, `gutter|${toHex(SEVERITY_COLORS[severity])}|${cfg.glyphDotOpacity}`);
  }
}

// --------------------------------------------------------------------------
// Main update function
// --------------------------------------------------------------------------

function paintEditor(editor: vscode.TextEditor | undefined, lineMap: LineMap | undefined): void {
  if (!editor) { return; }

  const cfg = getConfig();
  const activeLine = editor.selection.active.line;

  clearEditorDecorations(editor);

  if (!lineMap || lineMap.size === 0) { return; }

  applyDecorations(editor, lineMap, activeLine, cfg);
}

function refreshEditorFromDiagnostics(editor: vscode.TextEditor | undefined): void {
  if (!editor) { return; }

  const cfg = getConfig();
  const diags = vscode.languages.getDiagnostics(editor.document.uri);
  const key = editor.document.uri.toString();

  if (diags.length === 0) {
    documentLineMaps.delete(key);
    paintEditor(editor, undefined);
    return;
  }

  const lineMap = buildLineMap(diags, cfg);
  if (lineMap.size === 0) {
    documentLineMaps.delete(key);
    paintEditor(editor, undefined);
    return;
  }

  documentLineMaps.set(key, lineMap);
  paintEditor(editor, lineMap);
}

function repaintEditor(editor: vscode.TextEditor | undefined): void {
  if (!editor) { return; }

  const key = editor.document.uri.toString();
  const lineMap = documentLineMaps.get(key);

  if (lineMap) {
    paintEditor(editor, lineMap);
  } else {
    refreshEditorFromDiagnostics(editor);
  }
}

// --------------------------------------------------------------------------
// Extension lifecycle
// --------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Initial pass
  for (const editor of vscode.window.visibleTextEditors) {
    refreshEditorFromDiagnostics(editor);
  }

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (e.uris.some(u => u.toString() === editor.document.uri.toString())) {
          refreshEditorFromDiagnostics(editor);
        }
      }
    }),

    vscode.window.onDidChangeActiveTextEditor(editor => {
      repaintEditor(editor);
    }),

    // Cursor movement → active line may change → pill content changes
    vscode.window.onDidChangeTextEditorSelection(e => {
      repaintEditor(e.textEditor);
    }),

    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) { repaintEditor(editor); }
    }),

    vscode.workspace.onDidChangeTextDocument(e => {
      const key = e.document.uri.toString();
      const current = documentLineMaps.get(key);
      if (current) {
        documentLineMaps.set(key, transformLineMap(current, e.contentChanges, e.document));
      }
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === key) {
          repaintEditor(editor);
        }
      }
    }),

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('diagnosticLens')) {
        clearDecorationCache();
        editorApplied.clear();
        for (const editor of vscode.window.visibleTextEditors) {
          refreshEditorFromDiagnostics(editor);
        }
      }
    })
  );
}

export function deactivate(): void {
  clearDecorationCache();
  editorApplied.clear();
  documentLineMaps.clear();
}
