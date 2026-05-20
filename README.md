# SpatialFlow

**A reactive constraint layout engine designed to be reasoned about by AI agents.**

SpatialFlow unifies three things that every other layout system treats separately: time-based animation, measurement-driven spatial constraints, and AI agent authoring. The result is a canvas where elements express *relationships*, not positions — and where an AI agent can write behavior that survives layout changes.

---

## The Core Idea

Every design tool today has the same fundamental problem: they store *positions*, not *relationships*.

When you place a subtitle 20px below a title in Figma, PowerPoint, or CSS, you're storing `y: 180`. If the title grows (longer content, larger font), the subtitle doesn't move. You go back and manually fix it. This is the hidden cost of every design update.

SpatialFlow solves this by storing the *intent*:

> "subtitle always appears 16px below the title's bottom edge"

Which compiles to a live constraint expression:

```js
subtitle.y = title.bounds.bottom + 16
```

This expression re-evaluates every frame. The title grows → `title.bounds.bottom` increases → subtitle moves automatically. No manual updates. No broken layouts.

The deeper insight: **if you give an AI agent a canvas with well-defined, measurable primitives, the agent generates adaptive logic — not snapshots.**

---

## Architecture

### The Reactive Dataflow Graph

SpatialFlow's engine is a 6-layer reactive pipeline:

```
time → animations → measurements → constraints → state → render
  t       A(t)          M(A(t))       C(M(t))              pixels
```

**Key insight:** `C(t)` — the constraint layer — is defined in terms of `M(t)` (measurements of other elements), not `t` (time) directly. This means `subtitle.y = title.bounds.bottom + 16` is not a function of time. It's a function of title's *current rendered bounds*, which themselves may be a function of time.

**Signal types:**
- `Signal` — holds a value, set externally (time, mouse position)
- `Computed` — lazy function of other signals, only re-evaluates when dependencies change
- `Effect` — side effect triggered by signal changes (renders to canvas)

**Dependency tracking:** Every constraint expression is parsed to extract element IDs. A topological sort (Kahn's algorithm) ensures elements are resolved in dependency order — no element computes its constraint before its dependencies are measured.

### Measurement-Driven Constraints

The measurement layer exposes rich spatial data for every element:

```js
element.x, element.y, element.width, element.height
element.bounds.left, element.bounds.right, element.bounds.top, element.bounds.bottom
element.centerX, element.centerY
element.actualWidth  // actual rendered text width (not box width)
```

Plus a `slide` pseudo-element always available:

```js
slide.width, slide.height, slide.centerX, slide.centerY
```

And live signals:

```js
mouse.x, mouse.y          // cursor position in canvas coordinates
scroll.x, scroll.y        // scroll offset
viewport.width, height    // window dimensions
time.ms, time.s, time.norm // elapsed time (0–1 normalized)
container.width, ...      // any named custom signal
```

Constraint expressions are evaluated using a sandboxed expression evaluator that maps dotted references to live measurement lookups:

```js
// Expression string stored in spec:
"hero_box.bounds.left > slide.width - hero_box.bounds.right ? hero_box.bounds.left - label.width - 12 : hero_box.bounds.right + 12"

// Evaluates every frame to a number, using current measurements + signals as context
```

Math functions available in expressions: `sin`, `cos`, `sqrt`, `pow`, `atan2`, `clamp`, `lerp`, `midpoint`, `abs`, `min`, `max`, `round`, `sign`.

---

## The Four Phases

### Phase 1 — Interactive Signals

Any signal (mouse, scroll, viewport, time, custom) can be a root of the constraint graph. Elements constrain their position based on other elements' *measured bounds*, which themselves may depend on signals.

**What this enables that CSS/GSAP can't:**

```js
// CSS can do: scroll → animation value
// SpatialFlow does: scroll → measurement of element A → constraint position of element B
// The cross-element measurement dependency is what no other system has.

// Example: chain of 6 boxes cascading from mouse position
constraints: [
  { target: 'box0', x: 'mouse.x - 28', y: 'mouse.y - 18' },
  { target: 'box1', x: 'box0.bounds.right + 10', y: 'box0.bounds.top' },
  { target: 'box2', x: 'box1.bounds.right + 10', y: 'box1.bounds.top' },
  // ... box3, box4, box5 — 1 mouse signal drives 16 constraint resolutions
]
```

**Demo:** `spatialflow-interactive.html`

Three scenes:
- **Cascade Chain** — mouse moves box0, boxes 1–5 chain through `bounds.right` constraints
- **Orbital** — 5 satellites orbit mouse position using `time.ms` + `mouse.x/y` as co-drivers
- **Reflow** — a `container.width` slider signal drives two-column layout recalculation

---

### Phase 2 — Agent Negotiation Protocol

The engine exposes a command protocol (Mode C) that an AI agent calls to modify the spec. Unlike one-shot generation, this is a **negotiation loop**:

```
Agent → command array
Engine → executes commands
Engine → reports violations (overflow, conflicts)
Agent → receives violation context, corrects in next round
(max 3 rounds)
```

**Command types:**

```json
{ "type": "add_element",     "element": { "id": "...", "type": "rectangle", ... } }
{ "type": "remove_element",  "elementId": "..." }
{ "type": "update_element",  "elementId": "...", "props": { ... } }
{ "type": "add_constraint",  "constraint": { "target": "...", "x": "expr", "y": "expr" } }
{ "type": "remove_constraint","elementId": "..." }
{ "type": "add_animation",   "animation": { "target": "...", "property": "x", "keyframes": [...] } }
```

**Violation types:**
- `overflow` — element extends beyond slide bounds → triggers correction round
- `overlap` — elements overlap (background excluded, not treated as error)
- `constraint_replaced` — conflict detected when adding a constraint for an element that already has one

**Key discovery:** Agents generate *conditional expressions*, not just hardcoded positions. When asked "make the label appear on whichever side of the hero box has more space", Claude generated:

```js
hero_box.bounds.left > slide.width - hero_box.bounds.right
  ? hero_box.bounds.left - label.width - 12
  : hero_box.bounds.right + 12
```

A ternary that evaluates which side has more room — **every frame** — without any re-compilation. The agent reasoned about the geometry and wrote generalized logic, not a snapshot answer.

**Demo:** `spatialflow-negotiate.html`

Features: live canvas, negotiation log with expandable command JSON, raw API response viewer, delta readout showing what actually moved (e.g., `title: x 80 → 230`), element flash highlight on modification.

---

### Phase 3 — Semantic Intents

Intents are stored as living relationships between elements. Unlike Phase 2 (one-time commands), intents persist in a registry and can be re-compiled when layout context changes.

**Intent types:**

| Type | Description | Re-compile needed? |
|------|-------------|-------------------|
| `reactive` | Expression re-evaluates every frame. Survives any layout change. | Never |
| `directional` | Depends on WHICH direction to apply. Correct at compile time, may go stale if layout shifts significantly. | When dependency moves |
| `measure` | Driven by actual rendered measurements (text width, content height). Always live. | Never |

**Intent record structure:**

```js
{
  id: "intent_1",
  natural: "subtitle always appears 16px directly below the title's bottom edge",
  compiled: [
    {
      target: "subtitle",
      prop: "y",
      expr: "title.bounds.bottom + 16",
      explanation: "subtitle top locked 16px below title bottom edge",
      type: "reactive",
      deps: ["title"]
    }
  ],
  stale: false,
  deps: ["title"]
}
```

**The stress test demo:**

1. Compile: "subtitle always 16px below title" → `y = title.bounds.bottom + 16` (reactive)
2. Hit "Grow title" → title expands to 3 lines → subtitle follows **automatically** — no re-compile needed
3. Compile: "label on whichever side of hero box has more space" (directional)
4. Hit "Move hero box left" → intent goes yellow/stale
5. Click re-compile → Claude evaluates new geometry, flips the expression

**Conflict detection:** The registry tracks which intents constrain the same `target.prop` pair. Conflicting intents show a red border and strikethrough on the overridden expression.

**Demo:** `spatialflow-semantic.html`

---

### Phase 4 — Authoring Surface

The canvas becomes directly manipulable by humans and agents simultaneously.

**Human interactions:**
- **Click to select** — violet selection ring appears, inspector shows live measurements
- **Drag to move** — fires `update_element` in real-time, constraints propagate immediately
- **Add elements** — rectangle, circle, text, text_box buttons drop elements onto canvas

**Agent interaction:**
- Select an element
- Type an intent in natural language, Claude compiles it in context of that element
- Constraint arrows appear on SVG overlay connecting dependency elements to targets

**Constraint arrows (SVG overlay):**
- Green solid → reactive intent
- Yellow dashed → directional intent
- Teal dotted → measure intent
- Blue dashed → signal dependency

**Inspector panel** shows for selected element:
- Live x, y, width, height, centerX, centerY, actualWidth (updating every frame)
- Active constraint expressions
- Intent chips showing which intents govern this element

**Demo:** `spatialflow-author.html`

---

## File Structure

```
spatialflow-engine.js         — Core engine (923 lines)
spatialflow-interactive.html  — Phase 1: Interactive signals demo
spatialflow-negotiate.html    — Phase 2: Agent negotiation demo
spatialflow-semantic.html     — Phase 3: Semantic intents demo
spatialflow-author.html       — Phase 4: Authoring surface demo
spatialflow-v2.html           — Original v2 slide engine (reference)
pretext-bundle.js             — Sub-pixel text measurement library
```

---

## The Engine (`spatialflow-engine.js`)

### Class: `SpatialFlowEngine`

```js
const engine = new SpatialFlowEngine(spec, canvasElement);
```

**`evaluate(t, extSignals)`** — Runs the full 6-phase pipeline and returns `{ time, elements, state, measurements, constraints, order, violations }`.

**`renderFrame(t, extSignals)`** — Evaluates and renders to canvas. Returns state.

**`executeCommand(cmd)`** — Mode C protocol. Modifies spec and returns `{ success, message, violations, conflict }`.

**`getDependencyGraph(knownSignals)`** — Returns `{ target: { elements: [...], signals: [...] } }` for all constraints.

### Spec Format

```js
{
  metadata: {
    width: 960,
    height: 540,
    background: "#0d0d14",
    duration: 8000           // animation duration in ms
  },
  elements: [
    {
      id: "title",
      type: "text_box",      // rectangle | circle | text | text_box | image | line | connector | frame | group
      x: 60, y: 60,
      width: 460, height: 70,
      content: "SpatialFlow",
      font: "bold 42px DM Sans",
      color: "#e8e8f8"
    }
  ],
  constraints: [
    {
      target: "subtitle",
      y: "title.bounds.bottom + 16"   // only specify properties you want to override
    }
  ],
  animations: [
    {
      target: "dot",
      property: "radius",
      keyframes: [{ time: 0, value: 34 }, { time: 1500, value: 60 }, { time: 3000, value: 34 }],
      easing: "ease_in_out"
    }
  ]
}
```

### Easing Functions

`linear`, `ease_out`, `ease_in`, `ease_in_out`, `ease_out_cubic`, `ease_in_cubic`, `ease_out_bounce`

### Constraint Expression Syntax

Expressions are strings evaluated against the current measurement context:

```
"title.bounds.bottom + 16"                         — element measurement + constant
"slide.centerX - 250"                               — slide pseudo-element
"mouse.x + 100 * cos(time.ms * 0.001)"             — signal + math
"clamp(hero.bounds.right + 20, 20, slide.width)"   — math functions
"a.bounds.left > slide.width/2 ? expr_a : expr_b"  — ternary conditional
```

### Element Types

| Type | Key Properties |
|------|---------------|
| `rectangle` | x, y, width, height, fill, stroke, stroke_width |
| `circle` | x, y, radius, fill, stroke |
| `text` | x, y, content, font, color |
| `text_box` | x, y, width, height, content, font, color, lineHeight |
| `image` | x, y, width, height, src, fit (contain/cover/fill) |
| `line` | x, y, x2, y2, stroke, stroke_width |
| `connector` | from (element id), to (element id), fromSite, toSite, stroke, arrow |
| `frame` | x, y, width, height, children[], direction, spacing, padding, primaryAlign, counterAlign |

### Violation Detection

The engine automatically detects:
- **Overflow** — element extends outside slide bounds
- **Overlap** — elements intersect (background elements excluded)
- **Constraint conflict** — two intents constrain the same `target.prop`

Background detection is automatic: any element at (0,0) with dimensions ≥ slide dimensions is treated as background and excluded from overlap checks. Elements can also set `ignoreOverlap: true`.

---

## What Makes This Novel

Validated against academic literature (2025):

| System | Reactive | Measurement-driven | Animation | Agent-native |
|--------|----------|-------------------|-----------|-------------|
| Reactive Vega | ✓ | ✗ | ✗ | ✗ |
| Cassowary/Autolayout | ✗ | ✗ | ✗ | ✗ |
| Framer Motion/GSAP | ✗ | ✗ | ✓ | ✗ |
| Figma Auto Layout | ✗ | Partial | ✗ | ✗ |
| SceneCraft (LLM→Blender) | ✗ | ✗ | ✗ | ✓ one-shot |
| ConstraintLLM (EMNLP 2025) | ✗ | ✗ | ✗ | ✓ (industrial optimization) |
| **SpatialFlow** | ✓ | ✓ | ✓ | ✓ live loop |

The combination of all four doesn't exist elsewhere. The closest academic work is Reactive Vega (2015) for streaming dataflow, and ConstraintLLM (EMNLP 2025) for LLM ↔ constraint solver negotiation — but neither applies to spatial layout, and neither has a live reactive runtime.

---

## Key Insight

> **The canvas is a shared reasoning surface between agents and humans.**

When an agent generates a constraint expression, it isn't just executing a command — it's writing behavior that runs forever. The expression `hero_box.bounds.left > slide.width - hero_box.bounds.right ? left_expr : right_expr` is a piece of reactive logic that evaluates which side has more space *every frame*, without the agent being involved again.

This changes what the system is. It's not "an agent that manipulates a canvas." It's **a canvas designed to be reasoned about by agents** — one where the agent's output is a living relationship, not a snapshot.

The measurement layer is the key enabler: named elements with measurable properties give the agent something concrete to reason about. The agent can write `slide.centerX - title.actualWidth / 2` because it knows both those things are real, live, named values. It writes *generalized logic*, not a hardcoded answer.

---

## Running

No build step. Open any HTML file directly in a browser:

```bash
open spatialflow-interactive.html   # Phase 1 — interactive signals
open spatialflow-negotiate.html     # Phase 2 — agent negotiation (requires Anthropic API key)
open spatialflow-semantic.html      # Phase 3 — semantic intents (requires Anthropic API key)
open spatialflow-author.html        # Phase 4 — authoring surface (requires Anthropic API key)
```

For Phase 2–4, enter your Anthropic API key in the UI. It's saved to `localStorage` so you only need to enter it once per browser.

The engine is a single vanilla JS file with no dependencies. The HTML demos use Google Fonts (JetBrains Mono, DM Sans) loaded from CDN.

---

## Next Directions

- **Data signals** — plug live data (CSV, API response, WebSocket) in as root signals. Chart bars become measurable elements. Agent can write `callout.y = chart.bar_enterprise.bounds.top - 20`.
- **Export** — serialize spec + intent registry to JSON. Use as a universal layout description for Keynote, PowerPoint, web renderers.
- **3D extension** — z coordinate + perspective projection as a measurement. Camera as a signal.
- **Multi-renderer** — same spec drives Canvas 2D, WebGL, SVG, DOM, or native Swift.
- **Collaborative authoring** — multiple agents work on different parts of the spec simultaneously. Changes propagate through the shared reactive graph.

---

## Built With

- Vanilla JavaScript — no framework, no bundler
- Canvas 2D API for rendering
- SVG for constraint arrow overlay
- Claude Sonnet (via Anthropic API) for intent compilation and negotiation
- Pretext — sub-pixel text measurement library by Cheng Lou

---

*SpatialFlow — built May 2026*
