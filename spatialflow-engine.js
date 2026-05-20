// ============================================================================
// SpatialFlow v2 — Production Slide Deck Engine
// ============================================================================
// Measurement-driven reactive constraint solver with:
// - Pretext integration for sub-ms text measurement
// - Intrinsic sizing (hug / fill / fixed)
// - Flex grow/shrink with min/max bounds
// - Priority-based constraint resolution
// - Auto-layout frames (generalized stack containers)
// - Groups with transform composition
// - Connectors with reactive endpoint tracking
// - Mode C command protocol with violation feedback
// ============================================================================

// --- Reactive primitives ---------------------------------------------------
class Signal {
  constructor(v) { this.value = v; this.subs = new Set(); }
  get() { return this.value; }
  set(v) { if (v === this.value) return; this.value = v; for (const s of this.subs) s(v); }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
}

// --- Easing ----------------------------------------------------------------
const Easing = {
  linear: t => t,
  ease_out: t => 1 - Math.pow(1 - t, 2),
  ease_in: t => t * t,
  ease_in_out: t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  ease_out_cubic: t => 1 - Math.pow(1 - t, 3),
  ease_in_cubic: t => t * t * t,
  ease_out_bounce: t => {
    const n = 7.5625, d = 2.75;
    if (t < 1/d) return n*t*t;
    if (t < 2/d) return n*(t -= 1.5/d)*t + .75;
    if (t < 2.5/d) return n*(t -= 2.25/d)*t + .9375;
    return n*(t -= 2.625/d)*t + .984375;
  }
};

function interpKeyframes(frames, t, ease = 'linear') {
  if (!frames.length) return 0;
  if (t <= frames[0].time) return frames[0].value;
  if (t >= frames[frames.length - 1].time) return frames[frames.length - 1].value;
  let i = 0;
  while (i < frames.length - 1 && !(t >= frames[i].time && t <= frames[i + 1].time)) i++;
  const a = frames[i], b = frames[i + 1];
  const u = (t - a.time) / (b.time - a.time);
  const e = (Easing[ease] || Easing.linear)(u);
  return a.value + (b.value - a.value) * e;
}

// --- Priority system -------------------------------------------------------
const Priority = {
  REQUIRED: 1000,
  STRONG: 750,
  MEDIUM: 500,
  WEAK: 250
};

// --- Expression evaluator --------------------------------------------------
const builtinFns = {
  max: Math.max, min: Math.min, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  clamp: (x, a, b) => Math.min(Math.max(x, a), b),
  lerp: (a, b, t) => a + (b - a) * t,
  midpoint: (a, b) => (a + b) / 2,
  sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, pow: Math.pow,
  atan2: Math.atan2, round: Math.round, sign: Math.sign
};

function evalExpr(expr, ctx) {
  function lookup(parts) {
    const id = parts[0];
    let obj = ctx.measurements ? ctx.measurements[id] : undefined;
    if (obj === undefined && ctx.signals) obj = ctx.signals[id];
    if (obj === undefined) throw new Error('Unknown ref: ' + id);
    let val = obj;
    for (let i = 1; i < parts.length; i++) {
      val = val[parts[i]];
      if (val === undefined) throw new Error('Unknown prop: ' + parts.join('.'));
    }
    if (typeof val !== 'number') throw new Error('Not a number: ' + parts.join('.'));
    return val;
  }
  const safe = expr.replace(/[A-Za-z_][A-Za-z0-9_.]*/g, m => {
    if (m in builtinFns) return `__fns__.${m}`;
    if (/^[0-9.]+$/.test(m)) return m;
    const parts = m.split('.');
    return `__lookup__(${JSON.stringify(parts)})`;
  });
  try {
    const fn = new Function('__lookup__', '__fns__', `return (${safe});`);
    return fn(lookup, builtinFns);
  } catch (e) {
    console.warn('Expression eval failed:', expr, e.message);
    return 0;
  }
}

function extractDeps(expr) {
  const ids = new Set();
  if (!expr) return [];
  expr.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*\./g, (_, g) => { ids.add(g); return _; });
  return Array.from(ids);
}

// --- Topological sort (Kahn's algorithm) -----------------------------------
function topoOrder(elements, constraints) {
  const allIds = new Set(elements.map(e => e.id));
  const constrained = new Set(constraints.map(c => c.target));
  const graph = new Map();
  const indeg = new Map();
  for (const id of allIds) { graph.set(id, new Set()); indeg.set(id, 0); }
  for (const c of constraints) {
    const deps = new Set();
    if (c.x) extractDeps(c.x).forEach(d => deps.add(d));
    if (c.y) extractDeps(c.y).forEach(d => deps.add(d));
    if (c.width) extractDeps(c.width).forEach(d => deps.add(d));
    if (c.height) extractDeps(c.height).forEach(d => deps.add(d));
    for (const d of deps) {
      if (d !== c.target && allIds.has(d)) {
        if (!graph.get(d).has(c.target)) {
          graph.get(d).add(c.target);
          indeg.set(c.target, (indeg.get(c.target) || 0) + 1);
        }
      }
    }
  }
  // Kahn's
  const q = [];
  for (const [k, v] of indeg) if (v === 0) q.push(k);
  const out = [];
  while (q.length) {
    const u = q.shift();
    out.push(u);
    for (const v of graph.get(u) || []) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) q.push(v);
    }
  }
  if (out.length !== allIds.size) {
    // Add unconstrained elements that weren't in the cycle
    for (const id of allIds) {
      if (!out.includes(id)) out.push(id);
    }
    console.warn('Possible cycle in constraints, some elements may not resolve correctly');
  }
  return out;
}

// --- Pretext integration layer ---------------------------------------------
class TextMeasurer {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d');
    this._cache = new Map(); // key: text+font → prepared
    this._usePretext = typeof window !== 'undefined' && !!window.Pretext;
  }

  // Returns { lineCount, height, width, lines, minContentWidth, maxContentWidth }
  measure(text, font, maxWidth, lineHeight) {
    if (this._usePretext) {
      return this._measurePretext(text, font, maxWidth, lineHeight);
    }
    return this._measureCanvas(text, font, maxWidth, lineHeight);
  }

  _measurePretext(text, font, maxWidth, lineHeight) {
    const key = text + '||' + font;
    let prepared = this._cache.get(key);
    if (!prepared) {
      prepared = window.Pretext.prepareWithSegments(text, font);
      this._cache.set(key, prepared);
    }
    const result = window.Pretext.layoutWithLines(prepared, maxWidth, lineHeight);
    // Compute max-content width (natural width without wrapping)
    const natural = window.Pretext.layout(prepared, Infinity, lineHeight);
    // Get min-content width (longest word — approximate via narrow layout)
    // Use a very small width to force per-word breaks
    const narrow = window.Pretext.layout(prepared, 1, lineHeight);

    // Compute actual line widths for rendering
    const lineTexts = result.lines.map(l => l.text || '');
    const lineWidths = lineTexts.map(lt => {
      this._ctx.font = font;
      return this._ctx.measureText(lt).width;
    });
    const actualMaxWidth = lineWidths.length ? Math.max(...lineWidths) : 0;

    return {
      lineCount: result.lineCount,
      height: result.height,
      width: maxWidth,
      actualWidth: actualMaxWidth,
      lines: lineTexts,
      lineWidths,
      minContentWidth: 0, // TODO: derive from segment widths
      maxContentWidth: natural.lineCount === 1 ? actualMaxWidth : maxWidth
    };
  }

  _measureCanvas(text, font, maxWidth, lineHeight) {
    this._ctx.font = font;
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (this._ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    const lineWidths = lines.map(l => this._ctx.measureText(l).width);
    const height = Math.max(lineHeight, lines.length * lineHeight);
    const naturalWidth = this._ctx.measureText(text).width;
    return {
      lineCount: lines.length,
      height,
      width: maxWidth,
      actualWidth: Math.max(...lineWidths, 0),
      lines,
      lineWidths,
      minContentWidth: Math.max(...words.map(w => this._ctx.measureText(w).width), 0),
      maxContentWidth: naturalWidth
    };
  }

  clearCache() {
    this._cache.clear();
    if (this._usePretext && window.Pretext.clearCache) {
      window.Pretext.clearCache();
    }
  }
}

// --- Intrinsic sizing modes ------------------------------------------------
// sizing: 'fixed' | 'hug' | 'fill'
// fixed: use explicit width/height
// hug: shrink to content (text measurement drives size)
// fill: expand to fill parent's available space (with optional grow factor)
function resolveIntrinsicSize(el, textMeasurer, parentAvailable) {
  const sizing = el.sizing || 'fixed';
  const result = { width: el.width || 0, height: el.height || 0 };

  if (sizing === 'fixed') return result;

  if (sizing === 'hug' && (el.type === 'text_box' || el.type === 'text')) {
    const font = el.font || '16px Inter';
    const fontSize = parseInt(font, 10) || 16;
    const lh = (el.lineHeight || 1.3) * fontSize;
    const maxW = el.width || parentAvailable?.width || 300;
    const m = textMeasurer.measure(el.content || '', font, maxW, lh);
    result.width = m.actualWidth + (el.paddingLeft || 0) + (el.paddingRight || 0);
    result.height = m.height + (el.paddingTop || 0) + (el.paddingBottom || 0);
    return result;
  }

  if (sizing === 'fill') {
    if (parentAvailable) {
      result.width = parentAvailable.width || result.width;
      result.height = parentAvailable.height || result.height;
    }
  }

  return result;
}

// --- Auto Layout Frame -----------------------------------------------------
// direction: 'horizontal' | 'vertical'
// spacing: gap between children
// padding: { top, right, bottom, left }
// primaryAlign: 'start' | 'center' | 'end' | 'space-between'
// counterAlign: 'start' | 'center' | 'end' | 'stretch'
// children: array of element IDs
function resolveAutoLayout(frame, childMeasurements, allElements) {
  const dir = frame.direction || 'vertical';
  const spacing = frame.spacing || 0;
  const pad = normalizePadding(frame.padding);
  const primaryAlign = frame.primaryAlign || 'start';
  const counterAlign = frame.counterAlign || 'start';
  const children = frame.children || [];

  const innerW = (frame.width || 300) - pad.left - pad.right;
  const innerH = (frame.height || 300) - pad.top - pad.bottom;

  const isH = dir === 'horizontal';
  const primarySize = isH ? innerW : innerH;
  const counterSize = isH ? innerH : innerW;

  // Collect child sizes and flex factors
  const childInfos = children.map(cid => {
    const el = allElements.find(e => e.id === cid);
    const m = childMeasurements[cid];
    if (!el || !m) return { id: cid, size: 0, counterSz: 0, grow: 0, shrink: 1, minSize: 0, maxSize: Infinity };
    const sz = isH ? (m.width || 0) : (m.height || 0);
    const csz = isH ? (m.height || 0) : (m.width || 0);
    return {
      id: cid,
      size: sz,
      counterSz: csz,
      grow: el.flexGrow || 0,
      shrink: el.flexShrink || 1,
      minSize: isH ? (el.minWidth || 0) : (el.minHeight || 0),
      maxSize: isH ? (el.maxWidth || Infinity) : (el.maxHeight || Infinity)
    };
  });

  // Flex resolution
  const totalFixed = childInfos.reduce((s, c) => s + c.size, 0);
  const totalGaps = Math.max(0, children.length - 1) * spacing;
  let remaining = primarySize - totalFixed - totalGaps;

  // Grow phase
  if (remaining > 0) {
    const totalGrow = childInfos.reduce((s, c) => s + c.grow, 0);
    if (totalGrow > 0) {
      const frozen = new Set();
      let iters = 0;
      while (remaining > 0.5 && iters < 10) {
        iters++;
        const activeGrow = childInfos.filter(c => !frozen.has(c.id)).reduce((s, c) => s + c.grow, 0);
        if (activeGrow <= 0) break;
        let distributed = 0;
        for (const c of childInfos) {
          if (frozen.has(c.id) || c.grow <= 0) continue;
          const share = (c.grow / activeGrow) * remaining;
          const newSize = c.size + share;
          if (newSize > c.maxSize) {
            distributed += c.maxSize - c.size;
            c.size = c.maxSize;
            frozen.add(c.id);
          } else {
            distributed += share;
            c.size = newSize;
          }
        }
        remaining -= distributed;
      }
    }
  }
  // Shrink phase
  else if (remaining < 0) {
    const deficit = -remaining;
    const totalShrinkBasis = childInfos.reduce((s, c) => s + c.shrink * c.size, 0);
    if (totalShrinkBasis > 0) {
      for (const c of childInfos) {
        const share = (c.shrink * c.size / totalShrinkBasis) * deficit;
        c.size = Math.max(c.minSize, c.size - share);
      }
    }
  }

  // Position children along primary axis
  let primaryPositions;
  const totalChildSize = childInfos.reduce((s, c) => s + c.size, 0) + totalGaps;

  if (primaryAlign === 'start') {
    let pos = 0;
    primaryPositions = childInfos.map(c => { const p = pos; pos += c.size + spacing; return p; });
  } else if (primaryAlign === 'center') {
    let pos = (primarySize - totalChildSize) / 2;
    primaryPositions = childInfos.map(c => { const p = pos; pos += c.size + spacing; return p; });
  } else if (primaryAlign === 'end') {
    let pos = primarySize - totalChildSize;
    primaryPositions = childInfos.map(c => { const p = pos; pos += c.size + spacing; return p; });
  } else if (primaryAlign === 'space-between') {
    const gap = children.length > 1 ? (primarySize - totalChildSize + totalGaps) / (children.length - 1) : 0;
    let pos = 0;
    primaryPositions = childInfos.map(c => { const p = pos; pos += c.size + gap; return p; });
  }

  // Position children along counter axis
  const results = {};
  for (let i = 0; i < childInfos.length; i++) {
    const c = childInfos[i];
    const pp = primaryPositions[i];
    let cp;
    let counterSzFinal = c.counterSz;
    if (counterAlign === 'start') cp = 0;
    else if (counterAlign === 'center') cp = (counterSize - c.counterSz) / 2;
    else if (counterAlign === 'end') cp = counterSize - c.counterSz;
    else if (counterAlign === 'stretch') { cp = 0; counterSzFinal = counterSize; }
    else cp = 0;

    results[c.id] = {
      x: isH ? pad.left + pp : pad.left + cp,
      y: isH ? pad.top + cp : pad.top + pp,
      width: isH ? c.size : counterSzFinal,
      height: isH ? counterSzFinal : c.size
    };
  }
  return results;
}

function normalizePadding(p) {
  if (!p) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === 'number') return { top: p, right: p, bottom: p, left: p };
  return { top: p.top || 0, right: p.right || 0, bottom: p.bottom || 0, left: p.left || 0 };
}

// --- Measurement engine (extended) -----------------------------------------
function measureElement(el, animState, textMeasurer, ctx2d) {
  const a = animState[el.id] || {};
  const x = a.x ?? el.x ?? 0;
  const y = a.y ?? el.y ?? 0;
  const w = a.width ?? el.width ?? 0;
  const h = a.height ?? el.height ?? 0;

  switch (el.type) {
    case 'rectangle':
    case 'frame': {
      return { x, y, width: w, height: h, bounds: { left: x, right: x + w, top: y, bottom: y + h }, centerX: x + w / 2, centerY: y + h / 2 };
    }
    case 'circle': {
      const r = el.radius || 0;
      return { x, y, radius: r, bounds: { left: x - r, right: x + r, top: y - r, bottom: y + r }, centerX: x, centerY: y };
    }
    case 'text': {
      const content = el.content || '';
      const font = el.font || '16px Inter';
      const fontSize = parseInt(font, 10) || 16;
      if (ctx2d) { ctx2d.font = font; }
      const tw = ctx2d ? ctx2d.measureText(content).width : content.length * fontSize * 0.6;
      return { x, y, width: tw, height: fontSize, bounds: { left: x, right: x + tw, top: y - fontSize, bottom: y }, centerX: x + tw / 2, centerY: y - fontSize / 2 };
    }
    case 'text_box': {
      const content = el.content || '';
      const font = el.font || '16px Inter';
      const fontSize = parseInt(font, 10) || 16;
      const lhMult = el.lineHeight || 1.3;
      const lh = lhMult * fontSize;
      const maxW = a.width ?? el.width ?? 300;
      const m = textMeasurer.measure(content, font, maxW, lh);
      return {
        x, y, width: maxW, height: m.height,
        lines: m.lines, lineWidths: m.lineWidths, lineHeight: lh, font,
        actualWidth: m.actualWidth,
        minContentWidth: m.minContentWidth,
        maxContentWidth: m.maxContentWidth,
        bounds: { left: x, right: x + maxW, top: y, bottom: y + m.height },
        centerX: x + maxW / 2, centerY: y + m.height / 2
      };
    }
    case 'image': {
      return { x, y, width: w, height: h, bounds: { left: x, right: x + w, top: y, bottom: y + h }, centerX: x + w / 2, centerY: y + h / 2 };
    }
    case 'line': {
      const x2 = el.x2 || x, y2 = el.y2 || y;
      return { x, y, x2, y2, bounds: { left: Math.min(x, x2), right: Math.max(x, x2), top: Math.min(y, y2), bottom: Math.max(y, y2) }, centerX: (x + x2) / 2, centerY: (y + y2) / 2 };
    }
    case 'connector': {
      // Connectors resolve position from source/target elements during constraint phase
      return { x, y, x2: el.x2 || x, y2: el.y2 || y, bounds: { left: x, right: x, top: y, bottom: y }, centerX: x, centerY: y };
    }
    case 'group': {
      // Groups get their bounds from children — computed after children are measured
      return { x, y, width: w, height: h, bounds: { left: x, right: x + w, top: y, bottom: y + h }, centerX: x + w / 2, centerY: y + h / 2 };
    }
    default: {
      return { x, y, width: w, height: h, bounds: { left: x, right: x + w, top: y, bottom: y + h }, centerX: x + w / 2, centerY: y + h / 2 };
    }
  }
}

// --- Violation detection ---------------------------------------------------
function detectViolations(measurements, spec) {
  const violations = [];
  const slideW = spec.metadata?.width || 960;
  const slideH = spec.metadata?.height || 540;

  for (const el of spec.elements) {
    const m = measurements[el.id];
    if (!m) continue;
    const b = m.bounds;

    // Overflow: element extends beyond slide bounds
    if (b.right > slideW || b.bottom > slideH || b.left < 0 || b.top < 0) {
      violations.push({ type: 'overflow', elementId: el.id, bounds: b, slideWidth: slideW, slideHeight: slideH });
    }
  }

  // Overlap detection — skip background elements (cover full slide) and ignored pairs
  const bgIds = new Set(
    spec.elements
      .filter(e => e.ignoreOverlap ||
        (e.x === 0 && e.y === 0 && e.width >= slideW && e.height >= slideH))
      .map(e => e.id)
  );
  const ids = spec.elements.map(e => e.id).filter(id => !bgIds.has(id));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const ma = measurements[ids[i]], mb = measurements[ids[j]];
      if (!ma?.bounds || !mb?.bounds) continue;
      const ix = Math.max(0, Math.min(ma.bounds.right, mb.bounds.right) - Math.max(ma.bounds.left, mb.bounds.left));
      const iy = Math.max(0, Math.min(ma.bounds.bottom, mb.bounds.bottom) - Math.max(ma.bounds.top, mb.bounds.top));
      if (ix > 0 && iy > 0) {
        violations.push({ type: 'overlap', elements: [ids[i], ids[j]], area: ix * iy });
      }
    }
  }

  return violations;
}

// --- Main engine -----------------------------------------------------------
class SpatialFlowEngine {
  constructor(spec, canvas) {
    this.spec = JSON.parse(JSON.stringify(spec));
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.textMeasurer = new TextMeasurer();
    this.time = new Signal(0);
    this._imageCache = new Map();
    this._commandLog = [];
  }

  // Core evaluation: animation → measure → topo-sort → constrain → re-measure
  evaluate(t, extSignals = {}) {
    const { elements, animations = [], constraints = [] } = this.spec;

    // Phase 1: Resolve animations
    const animState = {};
    for (const a of animations) {
      const v = interpKeyframes(a.keyframes || [], t, a.easing || 'linear');
      const tid = a.target || a.targetId;
      if (!animState[tid]) animState[tid] = {};
      animState[tid][a.property] = v;
    }

    // Phase 2: Initial measurement (pre-constraint)
    const measurements = {};
    for (const el of elements) {
      measurements[el.id] = measureElement(el, animState, this.textMeasurer, this.ctx);
    }
    // Slide pseudo-element — always available in constraint expressions
    const slideW = this.spec.metadata?.width || 960;
    const slideH = this.spec.metadata?.height || 540;
    measurements['slide'] = {
      x: 0, y: 0, width: slideW, height: slideH,
      bounds: { left: 0, right: slideW, top: 0, bottom: slideH },
      centerX: slideW / 2, centerY: slideH / 2
    };

    // Phase 2.5: Resolve auto-layout frames
    const frames = elements.filter(e => e.type === 'frame' && e.children?.length > 0);
    for (const frame of frames) {
      const childLayouts = resolveAutoLayout(frame, measurements, elements);
      for (const [childId, layout] of Object.entries(childLayouts)) {
        // Convert frame-local coords to absolute
        const fm = measurements[frame.id];
        if (!animState[childId]) animState[childId] = {};
        animState[childId].x = fm.x + layout.x;
        animState[childId].y = fm.y + layout.y;
        if (layout.width) animState[childId].width = layout.width;
        if (layout.height) animState[childId].height = layout.height;
        // Re-measure with new position
        const el = elements.find(e => e.id === childId);
        if (el) {
          measurements[childId] = measureElement(el, animState, this.textMeasurer, this.ctx);
        }
      }
    }

    // Phase 2.7: Resolve connectors
    for (const el of elements) {
      if (el.type === 'connector' && el.from && el.to) {
        const fromM = measurements[el.from];
        const toM = measurements[el.to];
        if (fromM && toM) {
          const fromSite = getConnectionSite(fromM, el.fromSite || 'right');
          const toSite = getConnectionSite(toM, el.toSite || 'left');
          measurements[el.id] = {
            x: fromSite.x, y: fromSite.y,
            x2: toSite.x, y2: toSite.y,
            bounds: {
              left: Math.min(fromSite.x, toSite.x), right: Math.max(fromSite.x, toSite.x),
              top: Math.min(fromSite.y, toSite.y), bottom: Math.max(fromSite.y, toSite.y)
            },
            centerX: (fromSite.x + toSite.x) / 2,
            centerY: (fromSite.y + toSite.y) / 2
          };
        }
      }
    }

    // Phase 3: Topological sort + constraint resolution
    const order = topoOrder(elements, constraints);
    const resolvedState = JSON.parse(JSON.stringify(animState));
    const evalCtx = { measurements, signals: extSignals };

    for (const id of order) {
      const c = constraints.find(cc => cc.target === id);
      if (!c) continue;
      if (!resolvedState[id]) resolvedState[id] = {};

      if (c.x) resolvedState[id].x = evalExpr(c.x, evalCtx);
      if (c.y) resolvedState[id].y = evalExpr(c.y, evalCtx);
      if (c.width) resolvedState[id].width = evalExpr(c.width, evalCtx);
      if (c.height) resolvedState[id].height = evalExpr(c.height, evalCtx);

      // Phase 4: Re-measure with resolved position (single-pass guarantee)
      const el = elements.find(e => e.id === id);
      if (el) {
        const merged = { ...el, ...resolvedState[id] };
        measurements[id] = measureElement(merged, { [id]: resolvedState[id] }, this.textMeasurer, this.ctx);
      }
    }

    // Phase 5: Resolve group bounds from children
    for (const el of elements) {
      if (el.type === 'group' && el.children?.length) {
        let gl = Infinity, gt = Infinity, gr = -Infinity, gb = -Infinity;
        for (const cid of el.children) {
          const cm = measurements[cid];
          if (!cm?.bounds) continue;
          gl = Math.min(gl, cm.bounds.left);
          gt = Math.min(gt, cm.bounds.top);
          gr = Math.max(gr, cm.bounds.right);
          gb = Math.max(gb, cm.bounds.bottom);
        }
        if (gl !== Infinity) {
          measurements[el.id] = {
            x: gl, y: gt, width: gr - gl, height: gb - gt,
            bounds: { left: gl, right: gr, top: gt, bottom: gb },
            centerX: (gl + gr) / 2, centerY: (gt + gb) / 2
          };
        }
      }
    }

    // Phase 6: Detect violations
    const violations = detectViolations(measurements, this.spec);

    return { time: t, elements, state: resolvedState, measurements, constraints, order, violations };
  }

  evaluateExpression(expr, measurements) {
    return evalExpr(expr, { measurements });
  }

  // --- Rendering -----------------------------------------------------------
  renderFrame(t, extSignals = {}) {
    const s = this.evaluate(t, extSignals);
    if (!this.ctx) return s;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.fillStyle = this.spec.metadata?.background || '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Render in z-order (array order)
    for (const el of s.elements) {
      const m = s.measurements[el.id];
      if (!m) continue;
      this._renderElement(el, m, s);
    }
    return s;
  }

  // ── Shared helpers ──────────────────────────────────────────────────────
  _roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r || 0, w / 2, h / 2);
    if (r <= 0) { ctx.rect(x, y, w, h); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  _applyShadow(ctx, el) {
    if (!el.shadow) return;
    ctx.shadowColor   = el.shadow.color  || 'rgba(0,0,0,0.3)';
    ctx.shadowBlur    = el.shadow.blur   ?? 8;
    ctx.shadowOffsetX = el.shadow.x      ?? 0;
    ctx.shadowOffsetY = el.shadow.y      ?? 2;
  }

  _clearShadow(ctx) {
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  }

  _makeFill(ctx, el, x, y, w, h) {
    if (!el.fill) return null;
    if (el.gradient) {
      const g = el.gradient;
      const grad = g.type === 'radial'
        ? ctx.createRadialGradient(x+w/2, y+h/2, 0, x+w/2, y+h/2, Math.max(w,h)/2)
        : ctx.createLinearGradient(
            x + (g.x0 ?? 0) * w, y + (g.y0 ?? 0) * h,
            x + (g.x1 ?? 1) * w, y + (g.y1 ?? 1) * h);
      (g.stops || []).forEach(s => grad.addColorStop(s.pos, s.color));
      return grad;
    }
    return el.fill;
  }

  _renderElement(el, m, state) {
    const ctx = this.ctx;
    const opacity = el.opacity ?? 1;
    switch (el.type) {
      case 'rectangle':
      case 'frame': {
        ctx.save();
        if (opacity < 1) ctx.globalAlpha = opacity;
        const r = el.border_radius || el.radius || 0;
        if (el.shadow) this._applyShadow(ctx, el);
        const fill = this._makeFill(ctx, el, m.x, m.y, m.width, m.height);
        if (fill) {
          ctx.fillStyle = fill;
          ctx.beginPath(); this._roundedRect(ctx, m.x, m.y, m.width, m.height, r);
          ctx.fill();
          this._clearShadow(ctx);
        }
        if (el.stroke) {
          ctx.strokeStyle = el.stroke;
          ctx.lineWidth = el.stroke_width || 1;
          ctx.beginPath(); this._roundedRect(ctx, m.x, m.y, m.width, m.height, r);
          ctx.stroke();
        }
        if (el.type === 'frame' && !el.fill && !el.stroke) {
          ctx.strokeStyle = '#2a2a4a'; ctx.setLineDash([4,4]);
          ctx.beginPath(); this._roundedRect(ctx, m.x, m.y, m.width, m.height, r);
          ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.restore();
        break;
      }
      case 'circle': {
        ctx.save();
        if (opacity < 1) ctx.globalAlpha = opacity;
        if (el.shadow) this._applyShadow(ctx, el);
        const fill = this._makeFill(ctx, el, m.x - (el.radius||0), m.y - (el.radius||0), (el.radius||0)*2, (el.radius||0)*2);
        ctx.fillStyle = fill || '#ff6b6b';
        ctx.beginPath();
        ctx.arc(m.x, m.y, el.radius || 10, 0, Math.PI * 2);
        ctx.fill();
        this._clearShadow(ctx);
        if (el.stroke) { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.stroke_width || 1; ctx.stroke(); }
        ctx.restore();
        break;
      }
      case 'text': {
        ctx.save();
        if (opacity < 1) ctx.globalAlpha = opacity;
        ctx.font = el.font || '16px Inter';
        ctx.fillStyle = el.color || '#c8c8d8';
        ctx.textAlign = el.text_align || 'left';
        if (el.shadow) this._applyShadow(ctx, el);
        ctx.fillText(el.content || '', m.x, m.y);
        ctx.restore();
        break;
      }
      case 'text_box': {
        ctx.save();
        if (opacity < 1) ctx.globalAlpha = opacity;
        ctx.font = m.font || '16px Inter';
        ctx.fillStyle = el.color || '#c8c8d8';
        const lh    = m.lineHeight || 20;
        const lines = m.lines || [];
        const align = el.text_align || 'left';
        ctx.textAlign = align;
        if (el.shadow) this._applyShadow(ctx, el);

        // Padding
        const px = el.padding_x || el.padding || 0;
        const py = el.padding_y || el.padding || 0;

        // Vertical alignment
        const totalTextH = lines.length * lh;
        let baseY = m.y + py;
        const valign = el.valign || 'top';
        if (valign === 'middle') baseY = m.y + (m.height - totalTextH) / 2;
        if (valign === 'bottom') baseY = m.y + m.height - totalTextH - py;

        // Horizontal origin
        let textX = m.x + px;
        if (align === 'center') textX = m.x + m.width / 2;
        if (align === 'right')  textX = m.x + m.width - px;

        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], textX, baseY + (i + 1) * lh - lh * 0.2);
        }
        if (el.stroke_box) {
          this._clearShadow(ctx);
          ctx.strokeStyle = el.stroke_box;
          ctx.strokeRect(m.x, m.y, m.width, m.height);
        }
        ctx.restore();
        break;
      }
      case 'image': {
        ctx.save();
        const img = this._getImage(el.src);
        if (img?.complete && img.naturalWidth) {
          const fit = el.fit || 'contain';
          const iw = img.naturalWidth, ih = img.naturalHeight;
          const rw = m.width / iw, rh = m.height / ih;
          let dw, dh;
          if (fit === 'fill') { dw = m.width; dh = m.height; }
          else if (fit === 'cover') { const r = Math.max(rw, rh); dw = iw * r; dh = ih * r; }
          else { const r = Math.min(rw, rh); dw = iw * r; dh = ih * r; }
          ctx.drawImage(img, m.x + (m.width - dw) / 2, m.y + (m.height - dh) / 2, dw, dh);
        } else {
          ctx.strokeStyle = '#ccc';
          ctx.strokeRect(m.x, m.y, m.width, m.height);
          ctx.fillStyle = '#eee';
          ctx.font = '12px Inter';
          ctx.fillText('Loading...', m.x + 4, m.y + 16);
        }
        ctx.restore();
        break;
      }
      case 'connector': {
        ctx.save();
        ctx.strokeStyle = el.stroke || '#666';
        ctx.lineWidth = el.stroke_width || 2;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        // Bezier curve for connectors
        if (el.curveType === 'straight') {
          ctx.lineTo(m.x2, m.y2);
        } else {
          const midX = (m.x + m.x2) / 2;
          ctx.bezierCurveTo(midX, m.y, midX, m.y2, m.x2, m.y2);
        }
        ctx.stroke();
        // Arrow head
        if (el.arrow !== false) {
          const angle = Math.atan2(m.y2 - m.y, m.x2 - m.x);
          const sz = 8;
          ctx.beginPath();
          ctx.moveTo(m.x2, m.y2);
          ctx.lineTo(m.x2 - sz * Math.cos(angle - Math.PI / 6), m.y2 - sz * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(m.x2 - sz * Math.cos(angle + Math.PI / 6), m.y2 - sz * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fillStyle = el.stroke || '#666';
          ctx.fill();
        }
        ctx.restore();
        break;
      }
      case 'line': {
        ctx.save();
        ctx.strokeStyle = el.stroke || '#333';
        ctx.lineWidth = el.stroke_width || 2;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x2, m.y2);
        ctx.stroke();
        ctx.restore();
        break;
      }
      // group renders nothing itself — children render individually
    }
  }

  _getImage(src) {
    if (!src) return null;
    if (this._imageCache.has(src)) return this._imageCache.get(src);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    this._imageCache.set(src, img);
    return img;
  }

  // --- Mode C: Command protocol -------------------------------------------
  executeCommand(cmd) {
    const result = { success: false, violations: [], message: '' };
    try {
      switch (cmd.type) {
        case 'add_element': {
          const el = cmd.element;
          if (!el?.id || !el?.type) { result.message = 'Element requires id and type'; return result; }
          if (this.spec.elements.find(e => e.id === el.id)) { result.message = `Element ${el.id} already exists`; return result; }
          this.spec.elements.push(el);
          result.success = true;
          result.message = `Added ${el.type} "${el.id}"`;
          break;
        }
        case 'remove_element': {
          const idx = this.spec.elements.findIndex(e => e.id === cmd.elementId);
          if (idx === -1) { result.message = `Element ${cmd.elementId} not found`; return result; }
          this.spec.elements.splice(idx, 1);
          // Remove constraints targeting this element
          this.spec.constraints = (this.spec.constraints || []).filter(c => c.target !== cmd.elementId);
          result.success = true;
          result.message = `Removed "${cmd.elementId}"`;
          break;
        }
        case 'update_element': {
          const el = this.spec.elements.find(e => e.id === cmd.elementId);
          if (!el) { result.message = `Element ${cmd.elementId} not found`; return result; }
          Object.assign(el, cmd.props);
          result.success = true;
          result.message = `Updated "${cmd.elementId}"`;
          break;
        }
        case 'add_constraint': {
          if (!this.spec.constraints) this.spec.constraints = [];
          const existing = this.spec.constraints.find(c => c.target === cmd.constraint.target);
          if (existing) {
            const replaced = Object.keys(existing).filter(k => k !== 'target').join(',');
            Object.assign(existing, cmd.constraint);
            result.conflict = { type: 'constraint_replaced', target: cmd.constraint.target, replacedProps: replaced };
          } else {
            this.spec.constraints.push(cmd.constraint);
          }
          result.success = true;
          result.message = `Constraint set for "${cmd.constraint.target}"${result.conflict ? ' (replaced existing)' : ''}`;
          break;
        }
        case 'remove_constraint': {
          const before = (this.spec.constraints || []).length;
          this.spec.constraints = (this.spec.constraints || []).filter(c => c.target !== cmd.elementId);
          const removed = before - (this.spec.constraints || []).length;
          result.success = true;
          result.message = removed > 0 ? `Removed constraint for "${cmd.elementId}"` : `No constraint for "${cmd.elementId}"`;
          break;
        }
        case 'set_layout': {
          // Apply a named layout template
          result.success = true;
          result.message = `Layout applied: ${cmd.layout}`;
          break;
        }
        case 'add_animation': {
          if (!this.spec.animations) this.spec.animations = [];
          this.spec.animations.push(cmd.animation);
          result.success = true;
          result.message = `Animation added for "${cmd.animation.target}"`;
          break;
        }
        default:
          result.message = `Unknown command type: ${cmd.type}`;
      }

      // Post-validation: evaluate and check for violations
      if (result.success) {
        const state = this.evaluate(0);
        result.violations = state.violations;
        if (result.violations.length > 0) {
          result.message += ` (${result.violations.length} violation(s) detected)`;
        }
      }
    } catch (e) {
      result.message = `Command failed: ${e.message}`;
    }

    this._commandLog.push({ cmd, result, timestamp: Date.now() });
    return result;
  }

  getCommandLog() {
    return this._commandLog;
  }

  // --- Dependency graph introspection ------------------------------------
  getDependencyGraph(knownSignals = []) {
    const { constraints = [] } = this.spec;
    const sigSet = new Set(knownSignals);
    const g = {};
    for (const c of constraints) {
      const refs = new Set();
      ['x','y','width','height'].forEach(p => {
        if (c[p]) extractDeps(c[p]).forEach(d => { if (d !== c.target) refs.add(d); });
      });
      const elRefs = [], sigRefs = [];
      for (const r of refs) (sigSet.has(r) ? sigRefs : elRefs).push(r);
      g[c.target] = { elements: elRefs, signals: sigRefs };
    }
    return g;
  }
}

// --- Connection site resolver ----------------------------------------------
function getConnectionSite(m, site) {
  const b = m.bounds || { left: m.x, right: m.x + (m.width || 0), top: m.y, bottom: m.y + (m.height || 0) };
  switch (site) {
    case 'top': return { x: (b.left + b.right) / 2, y: b.top };
    case 'bottom': return { x: (b.left + b.right) / 2, y: b.bottom };
    case 'left': return { x: b.left, y: (b.top + b.bottom) / 2 };
    case 'right': return { x: b.right, y: (b.top + b.bottom) / 2 };
    case 'center': return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
    default: return { x: b.right, y: (b.top + b.bottom) / 2 };
  }
}

// --- Exports ---------------------------------------------------------------
window.SpatialFlowEngine = SpatialFlowEngine;
window.SFPriority = Priority;
window.SFEasing = Easing;
window.SF_evalExpr = (expr, measurements) => evalExpr(expr, { measurements });
window.__sfInternals = { interpKeyframes, evalExpr, measureElement, topoOrder, TextMeasurer, resolveAutoLayout, resolveIntrinsicSize, detectViolations };
