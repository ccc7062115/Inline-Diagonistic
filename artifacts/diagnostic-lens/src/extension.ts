import * as vscode from 'vscode';

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface DiagnosticConfig {
  enableErrors: boolean;
  enableWarnings: boolean;
  enableHints: boolean;
  enableInfo: boolean;
  enableGlyphMarginDots: boolean;
  glyphDotOpacity: number;
  pillTransparency: number;
  pillOpacity: number;
  maxMessageLength: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface PillVisualState {
  lineLength: number;
  contentLength: number;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cssNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
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

function clearPillAnimationState(): void {
  for (const timer of pillAnimationTimers.values()) {
    clearTimeout(timer);
  }
  pillVisualState.clear();
  pillAnimationTimers.clear();
  pillAnimationSeq.clear();
}

// --------------------------------------------------------------------------
// Per-editor active decoration key tracking
// --------------------------------------------------------------------------

/** Maps editor URI → set of cache keys currently applied to it */
const editorApplied = new Map<string, Set<string>>();
const pillVisualState = new Map<string, Map<number, PillVisualState>>();
const pillAnimationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pillAnimationSeq = new Map<string, number>();

function clearEditorDecorations(editor: vscode.TextEditor): void {
  const uri = editor.document.uri.toString();
  const timer = pillAnimationTimers.get(uri);
  if (timer) {
    clearTimeout(timer);
    pillAnimationTimers.delete(uri);
  }
  pillVisualState.delete(uri);
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
    enableGlyphMarginDots: cfg.get<boolean>('enableGlyphMarginDots', true),
    glyphDotOpacity:  clamp01(cfg.get<number>('glyphDotOpacity', 1)),
    pillTransparency: clamp01(cfg.get<number>('pillTransparency', 0.15)),
    pillOpacity:      clamp01(cfg.get<number>('pillOpacity', 0.9)),
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
      textDecoration: pillDecorationCss(0, 1, 1),
      margin: '0 0 0 4px',
      fontStyle: 'normal',
      fontWeight: 'normal',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  }));
}

function pillDecorationCss(translateCh: number, scaleX: number, opacity: number): string {
  return [
    'none',
    'display: inline-block',
    'box-sizing: border-box',
    'border-radius: 999px',
    'padding: 1px 7px',
    'transform-origin: left center',
    'backface-visibility: hidden',
    'will-change: transform, opacity',
    `opacity: ${cssNumber(opacity)}`,
    `transform: translate3d(${cssNumber(translateCh)}ch, 0, 0) scaleX(${cssNumber(scaleX)})`,
    'transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-in-out, background-color 180ms ease-in-out, color 180ms ease-in-out',
  ].join('; ') + ';';
}

function getPillMotion(
  previous: PillVisualState | undefined,
  lineLength: number,
  contentLength: number
): { initialTranslateCh: number; initialScaleX: number; initialOpacity: number } {
  if (!previous) {
    return {
      initialTranslateCh: 0,
      initialScaleX: 0.92,
      initialOpacity: 0,
    };
  }

  const lengthDelta = previous.lineLength - lineLength;
  const previousContentLength = Math.max(previous.contentLength, 1);
  const nextContentLength = Math.max(contentLength, 1);

  return {
    initialTranslateCh: clamp(lengthDelta, -40, 40),
    initialScaleX: clamp(previousContentLength / nextContentLength, 0.72, 1.34),
    initialOpacity: 1,
  };
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

  const uri = editor.document.uri.toString();
  const previousVisualState = pillVisualState.get(uri) ?? new Map<number, PillVisualState>();
  const nextVisualState = new Map<number, PillVisualState>();
  const sequence = (pillAnimationSeq.get(uri) ?? 0) + 1;
  pillAnimationSeq.set(uri, sequence);

  const existingTimer = pillAnimationTimers.get(uri);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pillAnimationTimers.delete(uri);
  }

  const arrowBatch: vscode.DecorationOptions[] = [];

  // pill batches keyed by pillBgHex|pillOpacity
  const pillBatches  = new Map<string, BatchEntry & { settledRanges: vscode.DecorationOptions[]; bgHex: string; opacity: number }>();

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
    const lineLength = editor.document.lineAt(line).text.length;

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

    const pillMotion = getPillMotion(previousVisualState.get(line), lineLength, pillContent.length);
    const pillKey = `${bgHex}|${cfg.pillOpacity}`;
    if (!pillBatches.has(pillKey)) {
      pillBatches.set(pillKey, { ranges: [], settledRanges: [], bgHex, opacity: cfg.pillOpacity });
    }
    const pillOptions = {
      range: eolRange(line),
      renderOptions: {
        after: {
          contentText: pillContent,
          color: textColor,
          backgroundColor: bgRgba,
          textDecoration: pillDecorationCss(
            pillMotion.initialTranslateCh,
            pillMotion.initialScaleX,
            pillMotion.initialOpacity
          ),
        },
      },
    };
    const settledPillOptions = {
      range: eolRange(line),
      renderOptions: {
        after: {
          contentText: pillContent,
          color: textColor,
          backgroundColor: bgRgba,
          textDecoration: pillDecorationCss(0, 1, 1),
        },
      },
    };
    pillBatches.get(pillKey)!.ranges.push(pillOptions);
    pillBatches.get(pillKey)!.settledRanges.push(settledPillOptions);
    nextVisualState.set(line, {
      lineLength,
      contentLength: pillContent.length,
    });

    if (cfg.enableGlyphMarginDots) {
      if (!gutterBatches.has(dominant)) {
        gutterBatches.set(dominant, []);
      }
      gutterBatches.get(dominant)!.push({
        range: new vscode.Range(line, 0, line, 0),
      });
    }
  }

  const previousKeys = new Set(editorApplied.get(editor.document.uri.toString()) ?? []);
  const nextKeys = new Set<string>();

  // ── Apply Arrow ──────────────────────────────────────────────────────────
  const arrowType = getArrowType();
  editor.setDecorations(arrowType, arrowBatch);
  nextKeys.add(ARROW_KEY);

  // ── Apply Pills ──────────────────────────────────────────────────────────
  for (const [pillKey, { ranges, bgHex, opacity }] of pillBatches) {
    const pillType = getPillType(bgHex, opacity);
    editor.setDecorations(pillType, ranges);
    nextKeys.add(`pill|${bgHex}|${opacity}`);
  }

  // ── Apply Gutter dots ────────────────────────────────────────────────────
  for (const [severity, ranges] of gutterBatches) {
    const gutterType = getGutterType(severity, cfg.glyphDotOpacity);
    editor.setDecorations(gutterType, ranges);
    nextKeys.add(`gutter|${toHex(SEVERITY_COLORS[severity])}|${cfg.glyphDotOpacity}`);
  }

  for (const staleKey of previousKeys) {
    if (nextKeys.has(staleKey)) { continue; }
    const dt = decorationCache.get(staleKey);
    if (dt) { editor.setDecorations(dt, []); }
  }

  editorApplied.set(editor.document.uri.toString(), nextKeys);
  for (const key of nextKeys) {
    recordApplied(editor, key);
  }

  pillVisualState.set(uri, nextVisualState);

  const settleTimer = setTimeout(() => {
    if (pillAnimationSeq.get(uri) !== sequence) { return; }
    for (const { settledRanges, bgHex, opacity } of pillBatches.values()) {
      const pillType = getPillType(bgHex, opacity);
      editor.setDecorations(pillType, settledRanges);
    }
    pillAnimationTimers.delete(uri);
  }, 16);
  pillAnimationTimers.set(uri, settleTimer);
}

// --------------------------------------------------------------------------
// Main update function
// --------------------------------------------------------------------------

function updateEditor(editor: vscode.TextEditor | undefined): void {
  if (!editor) { return; }

  const cfg        = getConfig();
  const diags      = vscode.languages.getDiagnostics(editor.document.uri);
  const activeLine = editor.selection.active.line;

  if (diags.length === 0) {
    clearEditorDecorations(editor);
    return;
  }

  const lineMap = buildLineMap(diags, cfg);
  if (lineMap.size === 0) {
    clearEditorDecorations(editor);
    return;
  }

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

  // Initial pass
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

    // Cursor movement → active line may change → pill content changes
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
        clearPillAnimationState();
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
  clearPillAnimationState();
  editorApplied.clear();
}
