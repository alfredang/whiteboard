// ─── DOM References ───
const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
const colorPicker = document.getElementById('colorPicker');
const brushSize = document.getElementById('brushSize');
const sizeValue = document.getElementById('sizeValue');
const statusMsg = document.getElementById('statusMsg');
const statusCoords = document.getElementById('statusCoords');
const toast = document.getElementById('toast');
const pageStripInner = document.getElementById('pageStripInner');

const btnSelect = document.getElementById('btnSelect');
const selBar = document.getElementById('selBar');
const btnPen = document.getElementById('btnPen');
const btnEraser = document.getElementById('btnEraser');
const btnLasso = document.getElementById('btnLasso');
const sizeLabel = document.getElementById('sizeLabel');
const shapeTextEditor = document.getElementById('shapeTextEditor');
const eraserCursor = document.getElementById('eraserCursor');

// Dropdown triggers / panels
const btnShapes = document.getElementById('btnShapes');
const btnProcess = document.getElementById('btnProcess');
const btnColor = document.getElementById('btnColor');
const btnTemplate = document.getElementById('btnTemplate');
const shapesIcon = document.getElementById('shapesIcon');
const processIcon = document.getElementById('processIcon');
const swatchGrid = document.getElementById('swatchGrid');
const colorSwatch = document.getElementById('colorSwatch');

// Logical drawing size. Every coordinate in this file is in these units; the
// backing store is scaled up for high-DPI screens so ink stays sharp.
const W = canvas.width;
const H = canvas.height;
const PIXEL_SCALE = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
canvas.width = Math.round(W * PIXEL_SCALE);
canvas.height = Math.round(H * PIXEL_SCALE);
ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);

// ─── Tool definitions ───
// Each shape/flowchart tool maps to a concrete geometry `type` plus behaviour
// flags. The same geometry can appear in both the Shapes and Process menus
// (e.g. diamond / decision) — only the flags differ.
const TOOL_DEFS = {
  // ── Basic shapes (Shapes dropdown) ──
  rect:          { type: 'rect',          menu: 'shapes' },
  roundrect:     { type: 'roundrect',     menu: 'shapes' },
  circle:        { type: 'circle',        menu: 'shapes' },
  triangle:      { type: 'triangle',      menu: 'shapes' },
  righttriangle: { type: 'righttriangle', menu: 'shapes' },
  diamond:       { type: 'diamond',       menu: 'shapes' },
  pentagon:      { type: 'pentagon',      menu: 'shapes' },
  hexagon:       { type: 'hexagon',       menu: 'shapes' },
  star:          { type: 'star',          menu: 'shapes' },
  parallelogram: { type: 'parallelogram', menu: 'shapes' },
  trapezoid:     { type: 'trapezoid',     menu: 'shapes' },
  line:          { type: 'line',          menu: 'shapes', lineLike: true },
  arrow:         { type: 'arrow',         menu: 'shapes', lineLike: true },
  doublearrow:   { type: 'doublearrow',   menu: 'shapes', lineLike: true },
  // ── Flowchart elements (Process dropdown) — labelled nodes + snapping connector ──
  process:    { type: 'roundrect',     menu: 'process', autoEdit: true },
  decision:   { type: 'diamond',       menu: 'process', autoEdit: true },
  terminator: { type: 'capsule',       menu: 'process', autoEdit: true },
  data:       { type: 'parallelogram', menu: 'process', autoEdit: true },
  document:   { type: 'document',      menu: 'process', autoEdit: true },
  subroutine: { type: 'subroutine',    menu: 'process', autoEdit: true },
  database:   { type: 'cylinder',      menu: 'process', autoEdit: true },
  manualinput:{ type: 'manualinput',   menu: 'process', autoEdit: true },
  preparation:{ type: 'hexagon',       menu: 'process', autoEdit: true },
  offpage:    { type: 'offpage',       menu: 'process', autoEdit: true },
  onpage:     { type: 'circle',        menu: 'process', autoEdit: true },
  delay:      { type: 'delay',         menu: 'process', autoEdit: true },
  display:    { type: 'display',       menu: 'process', autoEdit: true },
  connector:  { type: 'arrow',         menu: 'process', lineLike: true, snap: true },
};
const SHAPE_TOOLS = Object.keys(TOOL_DEFS);
function isShapeTool(t) { return Object.prototype.hasOwnProperty.call(TOOL_DEFS, t); }
function isLineTool(t) { return isShapeTool(t) && TOOL_DEFS[t].lineLike; }
// Geometry types that are line-like (resolved by endpoints, not bounds).
const LINE_TYPES = ['line', 'arrow', 'doublearrow'];
function isLineType(type) { return LINE_TYPES.includes(type); }
function isStroke(s) { return s.type === 'stroke'; }
// Box-like = has x/y/w/h bounds (rect, circle, diamond, flowchart nodes, …).
function isBoxLike(s) { return !isLineType(s.type) && !isStroke(s); }

// Bounding box of a freehand stroke's point list.
function strokeBounds(s) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of s.pts) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const SHAPE_FONT_PX = 22;
const SHAPE_FONT = `500 ${SHAPE_FONT_PX}px 'DM Sans', system-ui, -apple-system, sans-serif`;
const ACCENT = '#e87040';

// ─── Templates (paper styles) ───
// A template is two independent axes that the user can mix freely:
//   • surface — the paper colour + default ink. `dark` marks a dark surface;
//     crossing the light/dark boundary recolours existing ink so it stays visible.
//   • pattern — an optional overlay (blank / lines / dots / grid) drawn on top
//     of the surface colour. Any pattern can sit on any surface.
const SURFACES = {
  whiteboard: { bg: '#ffffff', ink: '#111111', dark: false },
  paper:      { bg: '#f8f4e1', ink: '#111111', dark: false },
  blackboard: { bg: '#16241c', ink: '#f4f4f0', dark: true  },
};
const PATTERNS = ['blank', 'lines', 'dots', 'grid'];
let surface = 'whiteboard';
let pattern = 'blank';
function tpl() { return SURFACES[surface]; }
function canvasBgColor() { return tpl().bg; }

// ─── Layered model ───
// The freehand strokes live on an offscreen "ink" canvas (raster). Flowchart
// boxes and arrows live as vector objects in the per-page `shapes` array and
// are re-rendered on top of the ink each frame. The visible canvas is a
// composite of: background + ink + shapes + (selection overlay).
const inkCanvas = document.createElement('canvas');
inkCanvas.width = W;
inkCanvas.height = H;
const inkCtx = inkCanvas.getContext('2d');
inkCtx.lineCap = 'round';
inkCtx.lineJoin = 'round';

// ─── State ───
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let currentTool = 'pen'; // 'select' | 'pen' | 'eraser' | 'lasso' | 'line' | 'circle' | shapes

// Per-tool sizes
const toolSizes = { pen: 4, eraser: 20 };
const toolSizeRange = { pen: { min: 1, max: 50 }, eraser: { min: 5, max: 120 } };

// Lasso state
let lassoPoints = [];
let previousTool = 'pen';
let lassoMoving = false; // true while dragging an element with the lasso tool

// Last pointer position over the canvas (for the eraser size indicator)
let lastPointer = null;

// Line / circle / shape drag state
let lineStart = null;
let shapeEnd = null;

// Freehand pen stroke currently being drawn (a vector object in `shapes`).
let activeStroke = null;

// Shapes for the current page (reference into pages[currentPage].shapes)
let shapes = [];
let shapeSeq = 1;
// Ids carry a random per-load tag so two devices sharing a live board never
// mint the same id.
const CLIENT_TAG = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
function newId() { return 's' + (shapeSeq++) + CLIENT_TAG; }
function newPageId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function bumpSeq(arr) {
  for (const s of arr) {
    const m = /^s(\d+)/.exec(String(s.id));
    const n = m ? parseInt(m[1], 10) : NaN;
    if (!isNaN(n) && n >= shapeSeq) shapeSeq = n + 1;
  }
}

// Selection / direct-manipulation state. The selection is a list of shape ids
// so the lasso (and clicks) can act on several elements at once.
let selectedIds = [];
let dragState = null;
function clearSelection() { selectedIds = []; }
function selectOnly(id) { selectedIds = id ? [id] : []; }
function isSelected(id) { return selectedIds.indexOf(id) !== -1; }

// Centre point of a shape (midpoint for lines, centroid for strokes) — used by the lasso.
function shapeCenterPoint(s) {
  if (isLineType(s.type)) {
    const [p1, p2] = arrowEnds(s);
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
  if (isStroke(s)) {
    let sx = 0, sy = 0;
    for (const [px, py] of s.pts) { sx += px; sy += py; }
    return { x: sx / s.pts.length, y: sy / s.pts.length };
  }
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

// Ray-casting point-in-polygon test (poly is a list of {x,y}). The loop wraps
// poly[last]→poly[0], so the lasso loop is treated as closed automatically.
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Does a lasso polygon catch this element? Mirrors notepadapp:
//  • box   → centre (or any corner) inside
//  • line  → start / end / midpoint inside
//  • stroke→ a majority (≥50%) of its points inside
function lassoHits(s, poly) {
  if (isLineType(s.type)) {
    const [p1, p2] = arrowEnds(s);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return [p1, p2, mid].some(p => pointInPolygon(p, poly));
  }
  if (isStroke(s)) {
    let inside = 0;
    for (const [px, py] of s.pts) if (pointInPolygon({ x: px, y: py }, poly)) inside++;
    return inside * 2 >= s.pts.length;
  }
  if (pointInPolygon(boxCenter(s), poly)) return true;
  return boxCorners(s).some(([x, y]) => pointInPolygon({ x, y }, poly));
}
// Active flowchart text editor target (the box object) or null
let editing = null;
let editingBox = null;

const HANDLE_HIT = 13;   // hit radius (canvas px) for resize handles
const HANDLE_DRAW = 9;   // drawn handle square size
const SNAP_MARGIN = 12;  // how far outside a box an arrow endpoint still snaps

// ─── Pages ───
let pages = []; // each: { ink: dataURL, shapes: [...], data: dataURL, undoStack: [] }
let currentPage = 0;
let dragPageIndex = null; // index of the page thumbnail being dragged
let justDragged = false;  // guards the click that fires after a drop
let dropInsertPos = null; // gap index (0..n) where a dropped page will land
// Dashed vertical line showing the drop position during a drag.
const dropIndicator = document.createElement('div');
dropIndicator.className = 'page-drop-indicator';
const MAX_UNDO = 30;
const STORAGE_KEY = 'whiteboard.state.v1';

// A transparent ink bitmap used for blank pages
function transparentInk() {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  return tmp.toDataURL();
}

// Pages saved by older versions hold freehand ink as a bitmap (`page.ink`);
// today's pen draws vector strokes and the bitmap stays blank. `hasInk` marks
// the pages that really have bitmap ink, and `inkDirty` that it has changed,
// so a live session only ever sends the bitmap for those.
function touchInk(page) { if (page.hasInk) page.inkDirty = true; }
function detectInk(page) {
  const img = new Image();
  img.onload = () => {
    const tmp = document.createElement('canvas');
    tmp.width = 300; tmp.height = 175;
    const t = tmp.getContext('2d');
    t.drawImage(img, 0, 0, 300, 175);
    const d = t.getImageData(0, 0, 300, 175).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) { page.hasInk = true; return; }
  };
  img.src = page.ink;
}

let saveTimer;
function persistState() {
  // A live session mirrors every committed change to the shared board. A guest
  // device shows the host's board, so it leaves its own saved board alone.
  if (window.Live) {
    Live.localChanged();
    if (Live.isGuest()) return;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload = {
        surface,
        pattern,
        currentPage,
        pages: pages.map(p => ({ id: p.id, ink: p.ink, shapes: p.shapes })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      // Quota exceeded or storage unavailable — fail silently
    }
  }, 250);
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.pages) || parsed.pages.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Shape geometry helpers ───
function normBounds(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function shapeById(id) { return shapes.find(s => s.id === id); }
function boxCenter(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

// Topmost box whose (optionally expanded) bounds contain the point.
function boxAt(pos, margin = 0) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (!isBoxLike(s)) continue;
    if (pos.x >= s.x - margin && pos.x <= s.x + s.w + margin &&
        pos.y >= s.y - margin && pos.y <= s.y + s.h + margin) return s;
  }
  return null;
}

function pointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Topmost shape at a point (boxes by bounds, lines/arrows by distance to the line).
function shapeAt(pos) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (isLineType(s.type)) {
      const [p1, p2] = arrowEnds(s);
      if (pointToSegment(pos.x, pos.y, p1.x, p1.y, p2.x, p2.y) <= 8) return s;
    } else if (isStroke(s)) {
      const tol = Math.max(8, s.lineWidth / 2 + 4);
      for (let k = 1; k < s.pts.length; k++) {
        if (pointToSegment(pos.x, pos.y, s.pts[k - 1][0], s.pts[k - 1][1], s.pts[k][0], s.pts[k][1]) <= tol) return s;
      }
      if (s.pts.length === 1 && Math.hypot(pos.x - s.pts[0][0], pos.y - s.pts[0][1]) <= tol) return s;
    } else if (pos.x >= s.x && pos.x <= s.x + s.w && pos.y >= s.y && pos.y <= s.y + s.h) {
      return s;
    }
  }
  return null;
}

// Point on a box's border in the direction of (tx, ty) from its centre.
function anchorOnBox(box, tx, ty) {
  const c = boxCenter(box);
  const dx = tx - c.x, dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = box.w / 2, hh = box.h / 2;
  let scale;
  if (box.type === 'diamond') {
    scale = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else if (box.type === 'circle') {
    // Intersection of the ray with the ellipse boundary.
    scale = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else {
    scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  }
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

// Resolve an arrow's two endpoints, honouring box bindings.
function arrowEnds(s) {
  const a = s.from ? shapeById(s.from) : null;
  const b = s.to ? shapeById(s.to) : null;
  const target1 = b ? boxCenter(b) : { x: s.x2, y: s.y2 };
  const target2 = a ? boxCenter(a) : { x: s.x1, y: s.y1 };
  const p1 = a ? anchorOnBox(a, target1.x, target1.y) : { x: s.x1, y: s.y1 };
  const p2 = b ? anchorOnBox(b, target2.x, target2.y) : { x: s.x2, y: s.y2 };
  return [p1, p2];
}

// ─── Shape drawing (onto any context) ───
// Trace a closed polygon through a list of [x,y] points.
function polyPath(c, pts) {
  pts.forEach((p, i) => (i === 0 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1])));
  c.closePath();
}

// Regular polygon inscribed in the bounding ellipse.
function regularPoly(c, cx, cy, rx, ry, sides, rot) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  polyPath(c, pts);
}

// N-point star inscribed in the bounding ellipse.
function starPoly(c, cx, cy, rx, ry, points, innerRatio) {
  const pts = [];
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 1 : innerRatio;
    const a = -Math.PI / 2 + i * step;
    pts.push([cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)]);
  }
  polyPath(c, pts);
}

function strokeBoxPath(c, type, x, y, w, h) {
  c.beginPath();
  const cx = x + w / 2, cy = y + h / 2;
  if (type === 'rect') {
    c.rect(x, y, w, h);
  } else if (type === 'roundrect' || type === 'capsule') {
    // roundrect = soft corners; capsule = fully-rounded "terminator" pill.
    const r = type === 'capsule' ? Math.min(w / 2, h / 2) : Math.min(40, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  } else if (type === 'circle') {
    c.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (type === 'diamond') {
    polyPath(c, [[cx, y], [x + w, cy], [cx, y + h], [x, cy]]);
  } else if (type === 'triangle') {
    polyPath(c, [[cx, y], [x + w, y + h], [x, y + h]]);
  } else if (type === 'righttriangle') {
    polyPath(c, [[x, y], [x, y + h], [x + w, y + h]]);
  } else if (type === 'pentagon') {
    regularPoly(c, cx, cy, w / 2, h / 2, 5, -Math.PI / 2);
  } else if (type === 'hexagon') {
    // Elongated horizontal hexagon (also the flowchart "preparation" symbol).
    polyPath(c, [
      [x, cy], [x + w * 0.25, y], [x + w * 0.75, y],
      [x + w, cy], [x + w * 0.75, y + h], [x + w * 0.25, y + h],
    ]);
  } else if (type === 'star') {
    starPoly(c, cx, cy, w / 2, h / 2, 5, 0.42);
  } else if (type === 'parallelogram') {
    const s = Math.min(w * 0.25, h * 0.8);
    polyPath(c, [[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]]);
  } else if (type === 'trapezoid') {
    const s = Math.min(w * 0.22, h);
    polyPath(c, [[x + s, y], [x + w - s, y], [x + w, y + h], [x, y + h]]);
  } else if (type === 'manualinput') {
    polyPath(c, [[x, y + h * 0.28], [x + w, y], [x + w, y + h], [x, y + h]]);
  } else if (type === 'offpage') {
    // Off-page connector: home-plate pointing down.
    polyPath(c, [[x, y], [x + w, y], [x + w, y + h * 0.62], [cx, y + h], [x, y + h * 0.62]]);
  } else if (type === 'subroutine') {
    // Predefined process: rectangle with two inner vertical bars.
    c.rect(x, y, w, h);
    const inset = Math.min(w * 0.12, 16);
    c.moveTo(x + inset, y); c.lineTo(x + inset, y + h);
    c.moveTo(x + w - inset, y); c.lineTo(x + w - inset, y + h);
  } else if (type === 'document') {
    // Rectangle with a wavy bottom edge.
    const b = y + h * 0.82;
    c.moveTo(x, y);
    c.lineTo(x + w, y);
    c.lineTo(x + w, b);
    c.bezierCurveTo(x + w * 0.66, y + h * 1.08, x + w * 0.33, y + h * 0.6, x, b);
    c.closePath();
  } else if (type === 'cylinder') {
    // Database cylinder.
    const ry = Math.min(h * 0.16, 22);
    c.moveTo(x, y + ry);
    c.lineTo(x, y + h - ry);
    c.ellipse(cx, y + h - ry, w / 2, ry, 0, Math.PI, 0, true);
    c.lineTo(x + w, y + ry);
    c.ellipse(cx, y + ry, w / 2, ry, 0, 0, Math.PI * 2);
  } else if (type === 'delay') {
    // Half-rounded "delay" symbol.
    const split = x + w * 0.55;
    c.moveTo(x, y);
    c.lineTo(split, y);
    c.ellipse(split, cy, w * 0.45, h / 2, 0, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x, y + h);
    c.closePath();
  } else if (type === 'display') {
    // Flowchart "display": pointed left, rounded right.
    const split = x + w * 0.82;
    c.moveTo(x + w * 0.15, y);
    c.lineTo(split, y);
    c.ellipse(split, cy, w * 0.18, h / 2, 0, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x + w * 0.15, y + h);
    c.lineTo(x, cy);
    c.closePath();
  }
}

function strokeBox(c, type, x, y, w, h, color, lw) {
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.lineJoin = 'round';
  strokeBoxPath(c, type, x, y, w, h);
  c.stroke();
  c.restore();
}

function strokeArrow(c, x1, y1, x2, y2, color, lw) {
  const head = Math.max(10, lw * 3 + 6);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  c.stroke();
  c.restore();
}

function strokeLine(c, x1, y1, x2, y2, color, lw) {
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
  c.restore();
}

// Render a freehand pen stroke. Three or more points are drawn as a chain of
// quadratic curves through the segment midpoints, which rounds off the corners
// between samples; `sharp` strokes (recognised polygons) stay a plain polyline.
// Width of a pressure-sensitive stroke at one sample. Half pressure draws the
// nominal width; a light touch thins to 35% and a firm one swells to 165%.
function pressureWidth(lw, p) {
  const pr = p[2] == null ? 0.5 : p[2];
  return Math.max(0.6, lw * (0.35 + 1.3 * pr));
}

// Stylus strokes carry a pressure value per point ([x, y, pressure]) and are
// drawn with a varying width. Same curve as strokeFreehand, cut into runs of
// equal (half-pixel quantised) width so a long stroke stays a handful of paths.
function strokePressure(c, pts, color, lw) {
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0][0], pts[0][1], pressureWidth(lw, pts[0]) / 2, 0, Math.PI * 2);
    c.fill();
    c.restore();
    return;
  }
  const n = pts.length;
  let px = pts[0][0], py = pts[0][1];
  let runW = null;
  for (let i = 1; i < n; i++) {
    const w = Math.round((pressureWidth(lw, pts[i - 1]) + pressureWidth(lw, pts[i])) * 1) / 2;
    if (w !== runW) {
      if (runW !== null) c.stroke();
      c.beginPath();
      c.moveTo(px, py);
      c.lineWidth = w;
      runW = w;
    }
    if (i === n - 1) {
      px = pts[i][0]; py = pts[i][1];
      c.lineTo(px, py);
    } else {
      px = (pts[i][0] + pts[i + 1][0]) / 2; py = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0], pts[i][1], px, py);
    }
  }
  c.stroke();
  c.restore();
}

function strokeFreehand(c, pts, color, lw, sharp) {
  if (!pts || pts.length === 0) return;
  if (!sharp && pts[0].length > 2) { strokePressure(c, pts, color, lw); return; }
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = lw;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0][0], pts[0][1], lw / 2, 0, Math.PI * 2);
    c.fill();
  } else {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    if (sharp || pts.length < 3) {
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        c.quadraticCurveTo(pts[i][0], pts[i][1],
          (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    }
    c.stroke();
  }
  c.restore();
}

function strokeDoubleArrow(c, x1, y1, x2, y2, color, lw) {
  const head = Math.max(10, lw * 3 + 6);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
  c.beginPath();
  // Head at the end
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  // Head at the start
  c.moveTo(x1, y1);
  c.lineTo(x1 + head * Math.cos(angle - Math.PI / 6), y1 + head * Math.sin(angle - Math.PI / 6));
  c.moveTo(x1, y1);
  c.lineTo(x1 + head * Math.cos(angle + Math.PI / 6), y1 + head * Math.sin(angle + Math.PI / 6));
  c.stroke();
  c.restore();
}

function wrapLines(c, text, maxWidth) {
  const out = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (c.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = words[i];
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function fillBoxText(c, type, x, y, w, h, text, color) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const maxWidth = (type === 'diamond' ? w * 0.58 : w * 0.84);
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = color;
  c.font = SHAPE_FONT;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const lines = wrapLines(c, text, maxWidth);
  const lineHeight = SHAPE_FONT_PX * 1.25;
  const startY = cy - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => c.fillText(line, cx, startY + i * lineHeight));
  c.restore();
}

function drawShape(c, s) {
  if (s.type === 'arrow') {
    const [p1, p2] = arrowEnds(s);
    strokeArrow(c, p1.x, p1.y, p2.x, p2.y, s.color, s.lineWidth);
  } else if (s.type === 'doublearrow') {
    const [p1, p2] = arrowEnds(s);
    strokeDoubleArrow(c, p1.x, p1.y, p2.x, p2.y, s.color, s.lineWidth);
  } else if (s.type === 'line') {
    const [p1, p2] = arrowEnds(s);
    strokeLine(c, p1.x, p1.y, p2.x, p2.y, s.color, s.lineWidth);
  } else if (s.type === 'stroke') {
    strokeFreehand(c, s.pts, s.color, s.lineWidth, s.sharp);
  } else {
    strokeBox(c, s.type, s.x, s.y, s.w, s.h, s.color, s.lineWidth);
    if (s !== editingBox && s.text) fillBoxText(c, s.type, s.x, s.y, s.w, s.h, s.text, s.color);
  }
}

// Draw the active template's background pattern (grid / dots / lines) onto a
// context that has already been filled with the surface colour.
function drawPaperPattern(c) {
  if (!pattern || pattern === 'blank') return;
  const step = 28;
  const dark = tpl().dark;
  c.save();
  c.globalCompositeOperation = 'source-over';
  if (pattern === 'grid') {
    c.strokeStyle = dark ? 'rgba(190, 220, 200, 0.16)' : 'rgba(60, 90, 160, 0.12)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = step; x < W; x += step) { c.moveTo(x, 0); c.lineTo(x, H); }
    for (let y = step; y < H; y += step) { c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
  } else if (pattern === 'dots') {
    c.fillStyle = dark ? 'rgba(205, 225, 210, 0.28)' : 'rgba(40, 40, 60, 0.22)';
    for (let x = step; x < W; x += step) {
      for (let y = step; y < H; y += step) {
        c.beginPath();
        c.arc(x, y, 1.3, 0, Math.PI * 2);
        c.fill();
      }
    }
  } else if (pattern === 'lines') {
    c.strokeStyle = dark ? 'rgba(200, 220, 205, 0.22)' : 'rgba(150, 120, 60, 0.30)';
    c.lineWidth = 1;
    c.beginPath();
    for (let y = step; y < H; y += step) { c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
  }
  c.restore();
}

// ─── Compositing ───
// Paint the page (background, pattern, ink, shapes) onto a context, leaving
// out one shape if asked.
function paintBoard(c, skip) {
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, W, H);
  c.fillStyle = canvasBgColor();
  c.fillRect(0, 0, W, H);
  drawPaperPattern(c);
  c.drawImage(inkCanvas, 0, 0, W, H);
  for (const s of shapes) if (s !== skip) drawShape(c, s);
}

// While a pen stroke is being drawn, the rest of the page is frozen in a
// bitmap, so each frame repaints one stroke instead of every shape on the
// page. This keeps a stylus responsive on a full page.
const penLayer = document.createElement('canvas');
penLayer.width = canvas.width;
penLayer.height = canvas.height;
const penLayerCtx = penLayer.getContext('2d');
penLayerCtx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
let penLayerFor = null; // the stroke the frozen layer was built around
function invalidatePenLayer() { penLayerFor = null; }

function render() {
  if (isDrawing && currentTool === 'pen' && activeStroke && shapes[shapes.length - 1] === activeStroke) {
    if (penLayerFor !== activeStroke) {
      paintBoard(penLayerCtx, activeStroke);
      penLayerFor = activeStroke;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(penLayer, 0, 0, W, H);
    drawShape(ctx, activeStroke);
    return;
  }
  penLayerFor = null;
  paintBoard(ctx, null);
  if (showsSelection() && selectedIds.length) drawSelection();
  updateSelBar();
}

// Both Select and Lasso show and manipulate the current selection.
function showsSelection() { return currentTool === 'select' || currentTool === 'lasso'; }

function drawSelection() {
  // Resize handles only when exactly one shape is selected; a multi-selection
  // just gets an outline per element.
  const single = selectedIds.length === 1;
  const frame = groupFrame();
  for (const id of selectedIds) {
    const s = shapeById(id);
    if (!s) continue;
    if (frame && single) continue; // a lone stroke is outlined by the frame itself
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    if (isLineType(s.type)) {
      const [p1, p2] = arrowEnds(s);
      ctx.setLineDash([]);
      for (const p of [p1, p2]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
      }
    } else if (isStroke(s)) {
      const b = strokeBounds(s);
      const pad = Math.max(4, s.lineWidth / 2);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    } else {
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.setLineDash([]);
      if (single) {
        for (const [cx, cy] of boxCorners(s)) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(cx - HANDLE_DRAW / 2, cy - HANDLE_DRAW / 2, HANDLE_DRAW, HANDLE_DRAW);
          ctx.strokeRect(cx - HANDLE_DRAW / 2, cy - HANDLE_DRAW / 2, HANDLE_DRAW, HANDLE_DRAW);
        }
      }
    }
    ctx.restore();
  }
  if (frame) {
    // One frame round the whole selection; its corners scale everything together.
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    for (const [cx, cy] of boxCorners(frame)) {
      ctx.fillRect(cx - FRAME_HANDLE / 2, cy - FRAME_HANDLE / 2, FRAME_HANDLE, FRAME_HANDLE);
      ctx.strokeRect(cx - FRAME_HANDLE / 2, cy - FRAME_HANDLE / 2, FRAME_HANDLE, FRAME_HANDLE);
    }
    ctx.restore();
  }
}

function boxCorners(b) {
  return [
    [b.x, b.y], [b.x + b.w, b.y],
    [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
  ];
}

// Handles are easier to hit with a finger or stylus than with a mouse.
function handleReach() { return activeType === 'touch' || activeType === 'pen' ? 24 : HANDLE_HIT; }

function handleAt(pos, box) {
  const reach = handleReach();
  const map = {
    nw: [box.x, box.y], ne: [box.x + box.w, box.y],
    sw: [box.x, box.y + box.h], se: [box.x + box.w, box.y + box.h],
  };
  for (const k in map) {
    if (Math.abs(pos.x - map[k][0]) <= reach && Math.abs(pos.y - map[k][1]) <= reach) return k;
  }
  return null;
}

// ─── Selection geometry ───
const FRAME_HANDLE = 11; // drawn size of the group frame's corner handles
const FRAME_PAD = 8;     // gap between the selection and its frame

function selectedShapes() { return selectedIds.map(id => shapeById(id)).filter(Boolean); }

function shapeBounds(s) {
  if (isLineType(s.type)) {
    const [p1, p2] = arrowEnds(s);
    return normBounds(p1.x, p1.y, p2.x, p2.y);
  }
  if (isStroke(s)) return strokeBounds(s);
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

// Bounding box of everything selected, or null when nothing is.
function selectionBounds() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of selectedShapes()) {
    const b = shapeBounds(s);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// The frame drawn round a selection of several elements, or round one freehand
// stroke. A lone box keeps its own resize handles and a lone line its end dots.
function groupFrame() {
  const sel = selectedShapes();
  if (!sel.length || (sel.length === 1 && !isStroke(sel[0]))) return null;
  const b = selectionBounds();
  return { x: b.x - FRAME_PAD, y: b.y - FRAME_PAD, w: b.w + FRAME_PAD * 2, h: b.h + FRAME_PAD * 2 };
}

function inBounds(pos, b) {
  return pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h;
}

// Is the point on the current selection: a handle, or anywhere inside the
// group frame? Pressing there acts on the selection instead of starting a lasso.
function selectionGrab(pos) {
  const frame = groupFrame();
  if (frame) return !!handleAt(pos, frame) || inBounds(pos, frame);
  const sel = selectedShapes();
  return sel.length === 1 && isBoxLike(sel[0]) && !!handleAt(pos, sel[0]);
}

// ─── Init Canvas ───
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

// Restore from localStorage if present, otherwise create a blank first page
const persisted = loadPersistedState();
if (persisted) {
  if (persisted.surface && SURFACES[persisted.surface]) {
    surface = persisted.surface;
    if (PATTERNS.includes(persisted.pattern)) pattern = persisted.pattern;
  } else if (persisted.template) {
    // Backward-compat: the old single-axis template combined surface + pattern.
    const LEGACY = {
      whiteboard: ['whiteboard', 'blank'],
      blackboard: ['blackboard', 'blank'],
      grid:       ['whiteboard', 'grid'],
      dotted:     ['whiteboard', 'dots'],
      lined:      ['whiteboard', 'lines'],
    };
    const [s, p] = LEGACY[persisted.template] || ['whiteboard', 'blank'];
    surface = s; pattern = p;
  } else if (persisted.theme) {
    // Backward-compat: the old binary theme toggle.
    surface = persisted.theme === 'light' ? 'blackboard' : 'whiteboard';
  }
  pages = persisted.pages.map(p => {
    // Backward-compat: older saves stored a flattened bitmap as `data`.
    const ink = p.ink || p.data || transparentInk();
    const sh = Array.isArray(p.shapes) ? p.shapes : [];
    return { id: p.id || newPageId(), ink, shapes: sh, data: ink, undoStack: [{ ink, shapes: cloneShapes(sh) }] };
  });
  currentPage = Math.min(persisted.currentPage || 0, pages.length - 1);
  pages.forEach(p => { bumpSeq(p.shapes); detectInk(p); });
  loadPage(currentPage);
  flattenAllThumbnails();
} else {
  pages.push(makeBlankPage());
  loadPage(0);
}
renderPageStrip();

function cloneShapes(arr) {
  return arr.map(s => (s.pts ? { ...s, pts: s.pts.map(p => p.slice()) } : { ...s }));
}

function makeBlankPage() {
  const ink = transparentInk();
  const data = flattenInkAndShapes(null, []);
  return { id: newPageId(), ink, shapes: [], data, undoStack: [{ ink, shapes: [] }] };
}

// Flatten background + an ink bitmap (or the live inkCanvas if null) + shapes.
function flattenInkAndShapes(inkImg, shapeArr) {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const t = tmp.getContext('2d');
  t.fillStyle = canvasBgColor();
  t.fillRect(0, 0, W, H);
  drawPaperPattern(t);
  if (inkImg) t.drawImage(inkImg, 0, 0);
  else t.drawImage(inkCanvas, 0, 0);
  const prevEditing = editingBox; editingBox = null;
  for (const s of shapeArr) drawShape(t, s);
  editingBox = prevEditing;
  return tmp.toDataURL();
}

// Current page flattened synchronously from the live ink canvas.
function flattenCurrentSync() { return flattenInkAndShapes(null, shapes); }

// Re-flatten every page's thumbnail asynchronously (used after load/theme).
function flattenAllThumbnails() {
  pages.forEach((page, i) => {
    if (i === currentPage) { page.data = flattenCurrentSync(); return; }
    const img = new Image();
    img.onload = () => {
      page.data = flattenInkAndShapes(img, page.shapes);
      const thumbImg = pageStripInner.querySelectorAll('.page-thumb img')[i];
      if (thumbImg) thumbImg.src = page.data;
    };
    img.src = page.ink;
  });
}

// ─── Page Management ───
function addPage() {
  commitCurrentPage();
  const page = makeBlankPage();
  pages.push(page);
  currentPage = pages.length - 1;
  loadPage(currentPage);
  renderPageStrip();
  persistState();
  showToast(`Page ${pages.length} added`);
}

function deletePage(index) {
  if (pages.length <= 1) { showToast('Need at least one page'); return; }
  // A page with something on it is not thrown away on a stray tap.
  if (index === currentPage) commitCurrentPage();
  const doomed = pages[index];
  if ((doomed.shapes.length || doomed.hasInk) && !confirm(`Delete page ${index + 1} and everything on it?`)) return;
  pages.splice(index, 1);
  if (currentPage >= pages.length) currentPage = pages.length - 1;
  else if (currentPage > index) currentPage--;
  loadPage(currentPage);
  renderPageStrip();
  persistState();
  showToast('Page deleted');
}

function resetAllPages() {
  if (!confirm('Delete all pages and start fresh? This cannot be undone.')) return;
  pages = [makeBlankPage()];
  currentPage = 0;
  loadPage(0);
  renderPageStrip();
  persistState();
  showToast('All pages reset');
}

// Wipe the contents of every page but keep the page count and order.
function clearAllPages() {
  if (!confirm('Clear the contents of all pages? This cannot be undone.')) return;
  pages.forEach(p => {
    touchInk(p);
    p.ink = transparentInk();
    p.shapes = [];
    p.undoStack = [{ ink: p.ink, shapes: [] }];
  });
  shapes = pages[currentPage].shapes;
  clearSelection();
  loadPage(currentPage);
  flattenAllThumbnails();
  renderPageStrip();
  persistState();
  showToast('All pages cleared');
}

// Position the dashed insertion line at gap `pos` (0..pages.length).
function showDropIndicator(pos) {
  dropInsertPos = pos;
  const thumbs = pageStripInner.querySelectorAll('.page-thumb');
  if (thumbs.length === 0) return;
  const gap = 8;
  let x;
  if (pos >= thumbs.length) {
    const last = thumbs[thumbs.length - 1];
    x = last.offsetLeft + last.offsetWidth + gap / 2;
  } else {
    x = thumbs[pos].offsetLeft - gap / 2;
  }
  dropIndicator.style.left = x + 'px';
  dropIndicator.classList.add('visible');
}

function hideDropIndicator() {
  dropIndicator.classList.remove('visible');
  dropInsertPos = null;
}

// Move a page into gap `insertPos` (drag-and-drop reorder).
function movePage(from, insertPos) {
  if (from === null || from === undefined || insertPos === null) return;
  if (insertPos === from || insertPos === from + 1) return; // dropped in place
  if (editing) commitTextEditor();
  commitCurrentPage();
  const current = pages[currentPage]; // remember which page is active by identity
  const moved = pages.splice(from, 1)[0];
  const target = from < insertPos ? insertPos - 1 : insertPos;
  pages.splice(target, 0, moved);
  currentPage = pages.indexOf(current);
  shapes = pages[currentPage].shapes;
  renderPageStrip();
  persistState();
  showToast('Pages reordered');
}

function switchPage(index) {
  if (index === currentPage) return;
  if (editing) commitTextEditor();
  commitCurrentPage();
  currentPage = index;
  loadPage(index);
  renderPageStrip();
  persistState();
}

// Persist the live ink canvas + shapes back into the current page object.
function commitCurrentPage() {
  pages[currentPage].ink = inkCanvas.toDataURL();
  pages[currentPage].shapes = shapes;
  pages[currentPage].data = flattenCurrentSync();
}

function loadPage(index) {
  const page = pages[index];
  shapes = page.shapes;
  clearSelection();
  dragState = null;
  const img = new Image();
  img.onload = () => {
    inkCtx.clearRect(0, 0, W, H);
    inkCtx.drawImage(img, 0, 0);
    render();
  };
  img.src = page.ink;
  updateStatusPage();
}

function updateStatusPage() {
  statusMsg.textContent = `Page ${currentPage + 1} of ${pages.length}`;
}

// ─── Page Strip Rendering ───
function renderPageStrip() {
  if (pages.length > 0) pages[currentPage].data = flattenCurrentSync();

  pageStripInner.innerHTML = '';
  pages.forEach((page, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'page-thumb' + (i === currentPage ? ' active' : '');
    thumb.addEventListener('click', () => { if (!justDragged) switchPage(i); });

    // Drag-and-drop reordering with a dashed insertion line
    thumb.draggable = true;
    thumb.addEventListener('dragstart', (e) => {
      dragPageIndex = i;
      justDragged = false;
      thumb.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    thumb.addEventListener('dragend', () => {
      thumb.classList.remove('dragging');
      hideDropIndicator();
      dragPageIndex = null;
      // Swallow the click that fires right after a drag.
      setTimeout(() => { justDragged = false; }, 0);
    });
    thumb.addEventListener('dragover', (e) => {
      if (dragPageIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = thumb.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      showDropIndicator(after ? i + 1 : i);
    });
    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      justDragged = true;
      const pos = dropInsertPos;
      hideDropIndicator();
      movePage(dragPageIndex, pos);
    });

    const img = document.createElement('img');
    img.src = page.data;
    img.draggable = false; // let the parent .page-thumb own the drag, not the image
    thumb.appendChild(img);

    const label = document.createElement('div');
    label.className = 'page-thumb-label';
    label.textContent = i + 1;
    thumb.appendChild(label);

    if (pages.length > 1) {
      const del = document.createElement('button');
      del.className = 'page-thumb-delete';
      del.textContent = '×';
      del.title = 'Delete page';
      del.addEventListener('click', (e) => { e.stopPropagation(); deletePage(i); });
      thumb.appendChild(del);
    }
    pageStripInner.appendChild(thumb);
  });
  // "Add page" tile, always right after the last page.
  const add = document.createElement('button');
  add.className = 'page-add';
  add.id = 'btnAddPage';
  add.title = 'Add page';
  add.setAttribute('aria-label', 'Add page');
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  add.addEventListener('click', addPage);
  pageStripInner.appendChild(add);
  pageStripInner.appendChild(dropIndicator);

  const activeThumb = pageStripInner.querySelector('.page-thumb.active');
  if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  updateStatusPage();
}


// Clear / reset dropdown menu
document.querySelectorAll('#resetPanel .menu-item').forEach(item => {
  item.addEventListener('click', () => {
    const action = item.dataset.reset;
    if (action === 'current') clearCanvas();
    else if (action === 'all') clearAllPages();
    else if (action === 'delete') resetAllPages();
    closeDropdowns();
  });
});

// ─── Undo (per-page) ───
function saveUndoState() {
  const page = pages[currentPage];
  if (page.undoStack.length >= MAX_UNDO) page.undoStack.shift();
  page.undoStack.push({ ink: inkCanvas.toDataURL(), shapes: cloneShapes(shapes) });
}

function undo() {
  const page = pages[currentPage];
  if (page.undoStack.length <= 1) return;
  page.undoStack.pop();
  touchInk(page);
  const snap = page.undoStack[page.undoStack.length - 1];
  page.shapes = cloneShapes(snap.shapes);
  shapes = page.shapes;
  clearSelection();
  const img = new Image();
  img.onload = () => {
    inkCtx.clearRect(0, 0, W, H);
    inkCtx.drawImage(img, 0, 0);
    render();
    syncCurrentPage();
  };
  img.src = snap.ink;
  showToast('Undone');
}

// ─── Tool Switching ───
function setTool(tool) {
  if (editing) commitTextEditor();

  if (tool === 'lasso' && currentTool !== 'lasso') previousTool = currentTool;
  if (tool !== 'select') clearSelection();
  currentTool = tool;

  btnSelect.classList.toggle('active', tool === 'select');
  btnPen.classList.toggle('active', tool === 'pen');
  btnEraser.classList.toggle('active', tool === 'eraser');
  btnLasso.classList.toggle('active', tool === 'lasso');

  // Dropdown triggers light up when their tool is the active one; the chosen
  // palette item is marked so re-opening the menu shows the current selection.
  const def = TOOL_DEFS[tool];
  // NB: coerce to a real boolean — classList.toggle(class, undefined) *flips*
  // the class instead of removing it, which would leave triggers stuck "on".
  btnShapes.classList.toggle('active', !!def && def.menu === 'shapes');
  // A collapsed rail's toggle lights up while one of its tools is in use.
  const shapeToggle = document.getElementById('railToggle');
  if (shapeToggle) shapeToggle.classList.toggle('active', !!def && def.menu === 'shapes');
  const flowToggle = document.getElementById('colorRailToggle');
  if (flowToggle) flowToggle.classList.toggle('active', !!def && def.menu === 'process');
  btnProcess.classList.toggle('active', !!def && def.menu === 'process');
  document.querySelectorAll('.palette-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tool === tool);
  });

  canvas.classList.toggle('eraser-cursor', tool === 'eraser');
  canvas.classList.toggle('lasso-cursor', tool === 'lasso');
  canvas.classList.toggle('pen-cursor', tool === 'pen');
  canvas.classList.toggle('select-cursor', tool === 'select');
  canvas.classList.toggle('shape-cursor', isShapeTool(tool));
  canvas.style.cursor = '';
  if (tool !== 'eraser') hideEraserCursor();

  syncSizeControl();
  render();
}

function syncSizeControl() {
  if (currentTool === 'lasso' || currentTool === 'select') {
    sizeLabel.textContent = currentTool === 'lasso' ? 'Lasso' : 'Select';
    brushSize.disabled = true;
    sizeValue.textContent = '—';
    return;
  }
  brushSize.disabled = false;
  const sizeKey = (currentTool === 'eraser') ? 'eraser' : 'pen';
  const range = toolSizeRange[sizeKey];
  brushSize.min = range.min;
  brushSize.max = range.max;
  brushSize.value = toolSizes[sizeKey];
  const labels = {
    pen: 'Pen', eraser: 'Eraser',
    rect: 'Rect', roundrect: 'Rounded', circle: 'Circle', triangle: 'Triangle',
    righttriangle: 'R.Triangle', diamond: 'Diamond', pentagon: 'Pentagon',
    hexagon: 'Hexagon', star: 'Star', parallelogram: 'Parallel', trapezoid: 'Trapezoid',
    line: 'Line', arrow: 'Arrow', doublearrow: 'Dbl Arrow',
    process: 'Process', decision: 'Decision', terminator: 'Start/End', data: 'Data',
    document: 'Document', subroutine: 'Subroutine', database: 'Database',
    manualinput: 'Input', preparation: 'Preparation', offpage: 'Off-page',
    onpage: 'On-page', delay: 'Delay', display: 'Display', connector: 'Connector',
  };
  sizeLabel.textContent = labels[currentTool] || 'Size';
  sizeValue.textContent = brushSize.value + 'px';
}

btnSelect.addEventListener('click', () => setTool('select'));
btnPen.addEventListener('click', () => setTool('pen'));
btnEraser.addEventListener('click', () => setTool('eraser'));
btnLasso.addEventListener('click', () => setTool('lasso'));

// ─── Dropdown menus (Shapes / Process / Color / Template) ───
const dropdowns = [...document.querySelectorAll('.dropdown')];

function closeDropdowns(except) {
  dropdowns.forEach(dd => {
    if (dd === except) return;
    dd.querySelector('.dropdown-panel').classList.remove('open');
    dd.querySelector('.dropdown-trigger').classList.remove('open');
  });
}

function toggleDropdown(dd) {
  const panel = dd.querySelector('.dropdown-panel');
  const trigger = dd.querySelector('.dropdown-trigger');
  const willOpen = !panel.classList.contains('open');
  closeDropdowns(dd);
  panel.classList.toggle('open', willOpen);
  trigger.classList.toggle('open', willOpen);
}

dropdowns.forEach(dd => {
  dd.querySelector('.dropdown-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown(dd);
  });
});

// ─── Side rails ───
// Shapes down the left edge, flowchart elements (and colours, added below)
// down the right; on a phone they are rows above and below the board. The
// items are copies of the dropdown palette buttons, so a tap picks the tool
// exactly as the dropdown did; dragging one onto the board drops a ready-made
// shape there.
const shapeRail = document.getElementById('shapeRail');
const colorRail = document.getElementById('colorRail');
[['shapePanel', 'Shapes', shapeRail], ['processPanel', 'Flowchart', colorRail]].forEach(([panelId, title, rail]) => {
  const group = document.createElement('div');
  group.className = 'rail-group';
  const label = document.createElement('div');
  label.className = 'palette-title';
  label.textContent = title;
  const grid = document.createElement('div');
  grid.className = 'rail-grid';
  document.querySelectorAll(`#${panelId} .palette-item`).forEach(item => {
    const copy = item.cloneNode(true);
    copy.title = (copy.title || '') + ' · drag onto the board to place';
    grid.appendChild(copy);
  });
  group.append(label, grid);
  rail.appendChild(group);
});

// Collapse / expand a side rail (shapes on the left; flowchart and colours on
// the right).
// Both start collapsed on every load; the board is resized to the space the
// rails leave.
function wireRailToggle(rail, toggle, what) {
  toggle.addEventListener('click', () => {
    const collapsed = rail.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = (collapsed ? 'Show ' : 'Hide ') + what;
    if (editing) commitTextEditor();
    resizeCanvas();
    updateSelBar();
  });
}
wireRailToggle(shapeRail, document.getElementById('railToggle'), 'shapes');


// Drop a default-sized shape centred on a board position.
const ROUND_TYPES = ['circle', 'triangle', 'righttriangle', 'diamond', 'pentagon', 'hexagon', 'star'];
function placeShape(tool, pos) {
  const def = TOOL_DEFS[tool];
  if (!def) return;
  if (editing) commitTextEditor();
  const size = toolSizes.pen;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  let s;
  if (def.lineLike) {
    const half = 80;
    const cx = clamp(pos.x, half + 4, W - half - 4), cy = clamp(pos.y, 4, H - 4);
    const start = { x: cx - half, y: cy }, end = { x: cx + half, y: cy };
    const from = def.snap ? boxAt(start, SNAP_MARGIN) : null;
    const to = def.snap ? boxAt(end, SNAP_MARGIN) : null;
    s = {
      id: newId(), type: def.type, x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      from: from ? from.id : null, to: to ? to.id : null,
      color: colorPicker.value, lineWidth: size,
    };
  } else {
    const round = def.menu === 'shapes' && ROUND_TYPES.includes(def.type);
    const w = round ? 120 : 170, h = round ? 120 : 90;
    s = {
      id: newId(), type: def.type,
      x: clamp(pos.x - w / 2, 2, W - w - 2), y: clamp(pos.y - h / 2, 2, H - h - 2), w, h,
      text: '', color: colorPicker.value, lineWidth: size,
    };
  }
  shapes.push(s);
  // Switch to Select so the new shape can be moved or resized straight away.
  setTool('select');
  selectOnly(s.id);
  render();
  if (def.autoEdit) {
    openBoxEditor(s);
  } else {
    saveUndoState();
    syncCurrentPage();
  }
}

// Dragging from the rail. Touch and stylus moves along the rail scroll it;
// a move across it (or out of it) picks the shape up.
let railDrag = null;
let railSuppressClick = false;
function railIsRow(rail) { return getComputedStyle(rail).flexDirection === 'row'; }
function railOverCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
function railPickUp(d) {
  d.mode = 'drag';
  d.ghost = document.createElement('div');
  d.ghost.className = 'rail-ghost';
  d.ghost.appendChild(d.item.querySelector('svg').cloneNode(true));
  document.body.appendChild(d.ghost);
  document.body.classList.add('rail-dragging');
}
function railEnd() {
  if (!railDrag) return;
  if (railDrag.ghost) railDrag.ghost.remove();
  try { railDrag.item.releasePointerCapture(railDrag.id); } catch { /* not captured */ }
  document.body.classList.remove('rail-dragging');
  canvas.classList.remove('drop-target');
  railDrag = null;
}
[shapeRail, colorRail].forEach(rail => {
  rail.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.palette-item');
    if (!item || railDrag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    railSuppressClick = false;
    railDrag = { rail, item, tool: item.dataset.tool, id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, mode: null, ghost: null };
    try { item.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  rail.addEventListener('pointermove', (e) => {
    const d = railDrag;
    if (!d || d.rail !== rail || e.pointerId !== d.id) return;
    if (!d.mode) {
      const dx = Math.abs(e.clientX - d.x0), dy = Math.abs(e.clientY - d.y0);
      if (Math.hypot(dx, dy) < 8) return;
      const row = railIsRow(rail);
      const canScroll = row ? rail.scrollWidth > rail.clientWidth : rail.scrollHeight > rail.clientHeight;
      const along = row ? dx : dy, across = row ? dy : dx;
      if (e.pointerType !== 'mouse' && canScroll && along > across) d.mode = 'scroll';
      else railPickUp(d);
    }
    if (d.mode === 'scroll') {
      if (railIsRow(rail)) rail.scrollLeft -= e.clientX - d.lx;
      else rail.scrollTop -= e.clientY - d.ly;
      const r = rail.getBoundingClientRect();
      if (e.clientX < r.left - 12 || e.clientX > r.right + 12 || e.clientY < r.top - 12 || e.clientY > r.bottom + 12) railPickUp(d);
    }
    if (d.mode === 'drag') {
      e.preventDefault();
      d.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      canvas.classList.toggle('drop-target', railOverCanvas(e));
    }
    d.lx = e.clientX; d.ly = e.clientY;
  });
  rail.addEventListener('pointerup', (e) => {
    const d = railDrag;
    if (!d || d.rail !== rail || e.pointerId !== d.id) return;
    const mode = d.mode, tool = d.tool;
    const drop = mode === 'drag' && railOverCanvas(e) ? getPosition(e) : null;
    railEnd();
    if (mode) railSuppressClick = true;   // it was a drag or a scroll, not a tap
    if (drop) placeShape(tool, drop);
  });
  rail.addEventListener('pointercancel', railEnd);
  rail.addEventListener('click', (e) => {
    if (!railSuppressClick) return;
    railSuppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
});

// Pick a shape/process tool from a palette and remember it on the trigger icon.
document.querySelectorAll('.palette-item').forEach(item => {
  item.addEventListener('click', () => {
    const tool = item.dataset.tool;
    setTool(tool);
    // Mirror the chosen glyph onto the dropdown trigger.
    const def = TOOL_DEFS[tool];
    const svg = item.querySelector('svg');
    if (def && svg) {
      const targetIcon = def.menu === 'shapes' ? shapesIcon : processIcon;
      targetIcon.innerHTML = svg.innerHTML;
    }
    closeDropdowns();
  });
});

// Close any open dropdown when clicking elsewhere.
document.addEventListener('click', () => closeDropdowns());

// ─── Ink / colour helpers ───
function invertImageDataURL(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const tmp = document.createElement('canvas');
      tmp.width = img.width;
      tmp.height = img.height;
      const tctx = tmp.getContext('2d');
      tctx.drawImage(img, 0, 0);
      const id = tctx.getImageData(0, 0, tmp.width, tmp.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
      tctx.putImageData(id, 0, 0);
      resolve(tmp.toDataURL());
    };
    img.src = dataURL;
  });
}

function invertHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = 255 - ((n >> 16) & 255);
  const g = 255 - ((n >> 8) & 255);
  const b = 255 - (n & 255);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ─── Template (paper style) ───
function applyCanvasBg() {
  canvas.style.background = canvasBgColor();
}

function setColor(hex) {
  colorPicker.value = hex;
  colorSwatch.style.background = hex;
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.classList.toggle('active', (sw.dataset.color || '').toLowerCase() === hex.toLowerCase());
  });
}

function syncTemplateMenu() {
  document.querySelectorAll('.template-item[data-surface]').forEach(el => {
    el.classList.toggle('active', el.dataset.surface === surface);
  });
  document.querySelectorAll('.template-item[data-pattern]').forEach(el => {
    el.classList.toggle('active', el.dataset.pattern === pattern);
  });
}

// Change the paper surface (whiteboard ⇄ blackboard). The pattern overlay is
// left untouched, so e.g. a lined blackboard stays lined.
async function setSurface(name) {
  if (!SURFACES[name] || name === surface) { closeDropdowns(); return; }
  commitCurrentPage();

  const prev = SURFACES[surface];
  const next = SURFACES[name];
  const crossesDark = prev.dark !== next.dark;

  // Crossing the light/dark boundary recolours existing ink so it stays visible.
  if (crossesDark) {
    for (const page of pages) {
      touchInk(page);
      page.ink = await invertImageDataURL(page.ink);
      page.shapes.forEach(s => { s.color = invertHex(s.color); });
      page.liveDirty = true;
      page.undoStack = await Promise.all(page.undoStack.map(async (snap) => ({
        ink: await invertImageDataURL(snap.ink),
        shapes: snap.shapes.map(s => ({ ...s, color: invertHex(s.color) })),
      })));
    }
    // Flip the default pen colour if it still matches the old surface's default.
    if (colorPicker.value.toLowerCase() === prev.ink.toLowerCase()) {
      setColor(next.ink);
    }
  }

  surface = name;
  applyCanvasBg();
  syncTemplateMenu();

  shapes = pages[currentPage].shapes;
  loadPage(currentPage);
  flattenAllThumbnails();
  renderPageStrip();
  closeDropdowns();
  persistState();
  showToast(`${name.charAt(0).toUpperCase() + name.slice(1)} surface`);
}

// Change the overlay pattern (blank / lines / dots / grid) on the current surface.
function setPattern(name) {
  if (!PATTERNS.includes(name) || name === pattern) { closeDropdowns(); return; }
  pattern = name;
  syncTemplateMenu();
  render();
  flattenAllThumbnails();
  renderPageStrip();
  closeDropdowns();
  persistState();
  const label = name === 'blank' ? 'Blank' : name.charAt(0).toUpperCase() + name.slice(1);
  showToast(`${label} pattern`);
}

document.querySelectorAll('.template-item[data-surface]').forEach(item => {
  item.addEventListener('click', () => setSurface(item.dataset.surface));
});
document.querySelectorAll('.template-item[data-pattern]').forEach(item => {
  item.addEventListener('click', () => setPattern(item.dataset.pattern));
});

// ─── Colour palette ───
const PALETTE = [
  '#111111', '#444444', '#808080', '#b8b8b8', '#e0e0e0', '#ffffff',
  '#cc0000', '#e84040', '#ff7373', '#ff57a8', '#d90084', '#9c27b0',
  '#8b4513', '#ff7300', '#ff9900', '#ffc107', '#ffd600', '#d6d633',
  '#338033', '#4caf50', '#2ecc71', '#00bcbc', '#0078ff', '#1a4dcc',
  '#5a9bff', '#163a8a',
];

function buildPalette() {
  PALETTE.forEach(hex => {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.color = hex;
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      applyColor(hex);
      closeDropdowns();
    });
    swatchGrid.appendChild(sw);
  });
}

// ─── Colour rail ───
// The palette's colours in the right rail, under the flowchart elements.
// A tap sets the pen colour and recolours the selection, like the palette.
(() => {
  const group = document.createElement('div');
  group.className = 'rail-group';
  const label = document.createElement('div');
  label.className = 'palette-title';
  label.textContent = 'Colours';
  const grid = document.createElement('div');
  grid.className = 'rail-grid color-grid';
  PALETTE.forEach(hex => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.dataset.color = hex;
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener('click', () => applyColor(hex));
    grid.appendChild(sw);
  });
  group.append(label, grid);
  colorRail.appendChild(group);
  // Mark the current colour now that these swatches exist.
  setColor(colorPicker.value);
})();
wireRailToggle(colorRail, document.getElementById('colorRailToggle'), 'flowchart and colours');

// Apply a colour to the pen and to every selected shape.
function applyColor(hex) {
  setColor(hex);
  colorSelection(hex);
  if (currentTool === 'eraser') setTool('pen');
}

// Recolour whatever is selected (Select or Lasso tool).
function colorSelection(hex) {
  if (!showsSelection()) return;
  const sel = selectedShapes();
  if (!sel.length) return;
  sel.forEach(s => { s.color = hex; });
  render();
  saveUndoState();
  syncCurrentPage();
}

// Quick marker colours cycled by Ctrl/Cmd+A. The first entry is the surface's
// default ink, so it is black on a whiteboard and chalk-white on a blackboard.
const QUICK_COLORS = [
  [null, 'Default'], ['#cc0000', 'Red'], ['#0078ff', 'Blue'],
  ['#338033', 'Green'], ['#ff7300', 'Orange'], ['#9c27b0', 'Purple'],
];
function cyclePenColor(dir) {
  const list = QUICK_COLORS.map(([hex, name]) => [hex || tpl().ink, name]);
  const cur = colorPicker.value.toLowerCase();
  const i = list.findIndex(([hex]) => hex.toLowerCase() === cur);
  // From a colour outside the list, start at the first (forward) or last (back).
  const next = i === -1 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  applyColor(list[next][0]);
  showToast(`Pen colour: ${list[next][1]}`);
}

// ─── Brush Size ───
brushSize.addEventListener('input', () => {
  const val = parseInt(brushSize.value, 10);
  const key = currentTool === 'eraser' ? 'eraser' : 'pen';
  toolSizes[key] = val;
  sizeValue.textContent = val + 'px';
  if (currentTool === 'eraser' && lastPointer) updateEraserCursor(lastPointer);
});

// ─── Custom Color Picker (inside the palette dropdown) ───
colorPicker.addEventListener('input', () => applyColor(colorPicker.value));

// ─── Position Helper ───
function getPosition(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  if (e.touches && e.touches.length > 0) {
    return {
      x: (e.touches[0].clientX - rect.left) * scaleX,
      y: (e.touches[0].clientY - rect.top) * scaleY,
    };
  }
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

// ─── Eraser size indicator ───
function updateEraserCursor(pos) {
  lastPointer = pos;
  if (currentTool !== 'eraser') { eraserCursor.classList.remove('visible'); return; }
  const sx = canvas.offsetWidth / W;
  const sy = canvas.offsetHeight / H;
  eraserCursor.style.width = (toolSizes.eraser * sx) + 'px';
  eraserCursor.style.height = (toolSizes.eraser * sy) + 'px';
  eraserCursor.style.left = (canvas.offsetLeft + pos.x * sx) + 'px';
  eraserCursor.style.top = (canvas.offsetTop + pos.y * sy) + 'px';
  eraserCursor.classList.add('visible');
}
function hideEraserCursor() { eraserCursor.classList.remove('visible'); }

// ─── Lasso preview (drawn on the composite each frame) ───
function drawLassoPreview() {
  if (lassoPoints.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = 'rgba(232, 112, 64, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
  for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function commitLasso() {
  // Free-form select: every element the lasso loop (auto-closed) catches becomes
  // part of the selection. The lasso tool stays active — press on any selected
  // element afterwards to drag the whole group, or lasso again to reselect.
  const ids = lassoPoints.length >= 3
    ? shapes.filter(s => lassoHits(s, lassoPoints)).map(s => s.id)
    : [];
  lassoPoints = [];
  selectedIds = ids;
  render();
  if (ids.length) showToast(`${ids.length} element${ids.length > 1 ? 's' : ''} selected`);
}

// ─── Floating text editor for box labels ───
function canvasToScreenRect(x1, y1, x2, y2) {
  const sx = canvas.offsetWidth / W;
  const sy = canvas.offsetHeight / H;
  const b = normBounds(x1, y1, x2, y2);
  return {
    left: canvas.offsetLeft + b.x * sx,
    top: canvas.offsetTop + b.y * sy,
    width: b.w * sx,
    height: b.h * sy,
    sx, sy,
  };
}

function openBoxEditor(box) {
  editing = box;
  editingBox = box;
  selectOnly(box.id);
  const r = canvasToScreenRect(box.x, box.y, box.x + box.w, box.y + box.h);
  const inset = box.type === 'diamond' ? 0.24 : 0.12;
  const padX = r.width * inset;
  const padY = r.height * inset;
  shapeTextEditor.style.left = (r.left + padX) + 'px';
  shapeTextEditor.style.top = (r.top + padY) + 'px';
  shapeTextEditor.style.width = Math.max(20, r.width - padX * 2) + 'px';
  shapeTextEditor.style.height = Math.max(20, r.height - padY * 2) + 'px';
  shapeTextEditor.style.fontSize = (SHAPE_FONT_PX * r.sy) + 'px';
  shapeTextEditor.style.color = box.color;
  shapeTextEditor.value = box.text || '';
  shapeTextEditor.classList.add('visible');
  render(); // hide the box's baked text behind the editor
  setTimeout(() => { shapeTextEditor.focus(); shapeTextEditor.select(); }, 0);
}

function commitTextEditor() {
  if (!editing) return;
  const box = editing;
  box.text = shapeTextEditor.value.trim();
  editing = null;
  editingBox = null;
  shapeTextEditor.classList.remove('visible');
  shapeTextEditor.value = '';
  render();
  saveUndoState();
  syncCurrentPage();
}

function cancelTextEditor() {
  if (!editing) return;
  editing = null;
  editingBox = null;
  shapeTextEditor.classList.remove('visible');
  shapeTextEditor.value = '';
  render();
}

shapeTextEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitTextEditor();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelTextEditor();
  }
  e.stopPropagation();
});
shapeTextEditor.addEventListener('blur', () => { if (editing) commitTextEditor(); });

// ─── Finalize a flowchart shape after a drag ───
function finishShape() {
  const start = lineStart;
  const end = shapeEnd || start;
  const tool = currentTool;
  const def = TOOL_DEFS[tool];
  lineStart = null;
  shapeEnd = null;
  if (!start || !def) { render(); return; }

  const size = Number(brushSize.value);

  // Line-like tools: line (no head), arrow & connector (with head, connector snaps).
  if (def.lineLike) {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 6) { render(); return; }
    const from = def.snap ? boxAt(start, SNAP_MARGIN) : null;
    const to = def.snap ? boxAt(end, SNAP_MARGIN) : null;
    const s = {
      id: newId(), type: def.type,
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      from: from ? from.id : null,
      to: to ? to.id : null,
      color: colorPicker.value, lineWidth: size,
    };
    shapes.push(s);
    selectOnly(s.id);
    render();
    saveUndoState();
    syncCurrentPage();
    if (from || to) showToast('Connector snapped to box');
    return;
  }

  // Box shapes: a click or tiny drag becomes a sensibly-sized default box.
  let x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;
  const MIN = 24;
  if (Math.abs(x2 - x1) < MIN || Math.abs(y2 - y1) < MIN) {
    const dw = 170, dh = 90;
    x1 = start.x - dw / 2; y1 = start.y - dh / 2;
    x2 = start.x + dw / 2; y2 = start.y + dh / 2;
  }
  const pad = 2;
  x1 = Math.max(pad, Math.min(x1, W - pad));
  x2 = Math.max(pad, Math.min(x2, W - pad));
  y1 = Math.max(pad, Math.min(y1, H - pad));
  y2 = Math.max(pad, Math.min(y2, H - pad));

  const b = normBounds(x1, y1, x2, y2);
  const s = {
    id: newId(), type: def.type,
    x: b.x, y: b.y, w: b.w, h: b.h,
    text: '', color: colorPicker.value, lineWidth: size,
  };
  shapes.push(s);
  selectOnly(s.id);
  render();
  // Flowchart nodes open the label editor immediately; plain shapes just select.
  if (def.autoEdit) {
    openBoxEditor(s);
  } else {
    saveUndoState();
    syncCurrentPage();
  }
}

// ─── Select / Move / Resize interactions ───
// Build the drag state for moving every selected shape together.
function startGroupMove(pos) {
  const items = selectedShapes().map(s => {
    if (isLineType(s.type)) return { shape: s, kind: 'line', orig: { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 } };
    if (isStroke(s)) return { shape: s, kind: 'stroke', orig: { pts: s.pts.map(p => p.slice()) } };
    return { shape: s, kind: 'box', orig: { x: s.x, y: s.y } };
  });
  return { mode: 'move', start: pos, items, moved: false, single: items.length === 1 };
}

// ─── Scaling a selection ───
// Snapshot of every selected shape, so a scale is always applied to the
// original geometry (no drift while dragging).
function scaleItems() {
  return selectedShapes().map(s => {
    if (isLineType(s.type)) {
      // An end bound to a box that is not being scaled too is cut loose, or the
      // binding would hold that end where it is.
      const [p1, p2] = arrowEnds(s);
      return {
        shape: s, kind: 'line',
        orig: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y },
        freeFrom: !!s.from && !isSelected(s.from),
        freeTo: !!s.to && !isSelected(s.to),
      };
    }
    if (isStroke(s)) return { shape: s, kind: 'stroke', orig: { pts: s.pts.map(p => p.slice()), lineWidth: s.lineWidth } };
    return { shape: s, kind: 'box', orig: { x: s.x, y: s.y, w: s.w, h: s.h } };
  });
}

// Scale the snapshot by factor f about the point (ox, oy).
function applyScale(items, ox, oy, f) {
  for (const it of items) {
    const s = it.shape, o = it.orig;
    if (it.kind === 'line') {
      if (it.freeFrom) s.from = null;
      if (it.freeTo) s.to = null;
      s.x1 = ox + (o.x1 - ox) * f; s.y1 = oy + (o.y1 - oy) * f;
      s.x2 = ox + (o.x2 - ox) * f; s.y2 = oy + (o.y2 - oy) * f;
    } else if (it.kind === 'stroke') {
      s.pts = o.pts.map(p => [ox + (p[0] - ox) * f, oy + (p[1] - oy) * f, ...p.slice(2)]);
      s.lineWidth = Math.max(0.5, o.lineWidth * f);
    } else {
      s.x = ox + (o.x - ox) * f; s.y = oy + (o.y - oy) * f;
      s.w = o.w * f; s.h = o.h * f;
    }
  }
}

// Keep a scale factor from shrinking the selection to nothing or blowing it
// up far beyond the board.
function clampScale(f, b) {
  const big = Math.max(b.w, b.h, 1);
  const lo = Math.min(1, 16 / big);
  const hi = Math.max(1, (Math.max(W, H) * 2) / big);
  return Math.max(lo, Math.min(hi, f));
}

// Scale the selection about its centre (the action bar's bigger / smaller buttons).
function scaleSelection(f) {
  const b = selectionBounds();
  if (!b) return;
  f = clampScale(f, b);
  if (f === 1) return;
  applyScale(scaleItems(), b.x + b.w / 2, b.y + b.h / 2, f);
  render();
  saveUndoState();
  syncCurrentPage();
}

function startSelect(pos, additive) {
  // Resize only when exactly one box-like shape is selected and a handle is grabbed.
  if (selectedIds.length === 1) {
    const sel = shapeById(selectedIds[0]);
    if (sel && isBoxLike(sel)) {
      const h = handleAt(pos, sel);
      if (h) { dragState = { mode: 'resize', box: sel, handle: h, moved: false }; render(); return; }
    }
  }

  // A corner of the group frame scales the whole selection from the opposite corner.
  const frame = groupFrame();
  if (frame) {
    const h = handleAt(pos, frame);
    if (h) {
      const anchor = {
        x: h.includes('w') ? frame.x + frame.w : frame.x,
        y: h.includes('n') ? frame.y + frame.h : frame.y,
      };
      dragState = {
        mode: 'scale', anchor, items: scaleItems(), bounds: selectionBounds(),
        startDist: Math.max(1, Math.hypot(pos.x - anchor.x, pos.y - anchor.y)), moved: false,
      };
      render();
      return;
    }
    // Anywhere else inside the frame drags the selection, so thin handwriting
    // does not have to be hit exactly.
    if (!additive && inBounds(pos, frame) && !shapeAt(pos)) {
      dragState = startGroupMove(pos);
      render();
      return;
    }
  }

  const hit = shapeAt(pos);
  if (hit) {
    if (additive) {
      // Shift-click toggles a shape in/out of the selection (no drag).
      if (isSelected(hit.id)) selectedIds = selectedIds.filter(id => id !== hit.id);
      else selectedIds.push(hit.id);
      dragState = null;
    } else {
      // Clicking a shape outside the current selection selects just it; clicking
      // one already in the selection keeps the whole group, so it moves together.
      if (!isSelected(hit.id)) selectOnly(hit.id);
      dragState = startGroupMove(pos);
    }
  } else {
    if (!additive) clearSelection();
    dragState = null;
  }
  render();
}

function moveSelect(pos) {
  if (!dragState) return;
  dragState.moved = true;
  if (dragState.mode === 'move') {
    const dx = pos.x - dragState.start.x, dy = pos.y - dragState.start.y;
    for (const it of dragState.items) {
      const s = it.shape;
      if (it.kind === 'line') {
        // A lone line/arrow drag detaches so it follows the cursor; in a group
        // move keep bindings so bound connectors track their boxes.
        if (dragState.single) { s.from = null; s.to = null; }
        s.x1 = it.orig.x1 + dx; s.y1 = it.orig.y1 + dy;
        s.x2 = it.orig.x2 + dx; s.y2 = it.orig.y2 + dy;
      } else if (it.kind === 'stroke') {
        s.pts = it.orig.pts.map(p => [p[0] + dx, p[1] + dy, ...p.slice(2)]);
      } else {
        s.x = it.orig.x + dx; s.y = it.orig.y + dy;
      }
    }
  } else if (dragState.mode === 'scale') {
    const a = dragState.anchor;
    const f = clampScale(Math.hypot(pos.x - a.x, pos.y - a.y) / dragState.startDist, dragState.bounds);
    applyScale(dragState.items, a.x, a.y, f);
  } else if (dragState.mode === 'resize') {
    const b = dragState.box;
    let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
    if (dragState.handle.includes('n')) y1 = pos.y;
    if (dragState.handle.includes('s')) y2 = pos.y;
    if (dragState.handle.includes('w')) x1 = pos.x;
    if (dragState.handle.includes('e')) x2 = pos.x;
    const nb = normBounds(x1, y1, x2, y2);
    b.x = nb.x; b.y = nb.y;
    b.w = Math.max(20, nb.w); b.h = Math.max(20, nb.h);
  }
  render();
}

function endSelect() {
  if (dragState && dragState.moved) { saveUndoState(); syncCurrentPage(); }
  dragState = null;
  updateSelBar();
}

function updateSelectCursor(pos) {
  if (selectedIds.length === 1) {
    const sel = shapeById(selectedIds[0]);
    if (sel && isBoxLike(sel)) {
      const h = handleAt(pos, sel);
      if (h === 'nw' || h === 'se') { canvas.style.cursor = 'nwse-resize'; return; }
      if (h === 'ne' || h === 'sw') { canvas.style.cursor = 'nesw-resize'; return; }
    }
  }
  const frame = groupFrame();
  if (frame) {
    const h = handleAt(pos, frame);
    if (h === 'nw' || h === 'se') { canvas.style.cursor = 'nwse-resize'; return; }
    if (h === 'ne' || h === 'sw') { canvas.style.cursor = 'nesw-resize'; return; }
    if (inBounds(pos, frame)) { canvas.style.cursor = 'move'; return; }
  }
  canvas.style.cursor = shapeAt(pos) ? 'move' : (currentTool === 'lasso' ? 'crosshair' : 'default');
}

// ─── Selection action bar (colour, size, delete) ───
// Floats beside the selection so everything can be done by touch, with no
// keyboard: tap a colour, make the selection bigger or smaller, or delete it.
const SEL_ICONS = {
  smaller: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  bigger: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
};
const SEL_SCALE_STEP = 1.2;

function buildSelBar() {
  const add = (cls, title, html, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = html;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); b.blur(); });
    selBar.appendChild(b);
    return b;
  };
  const divider = () => {
    const d = document.createElement('span');
    d.className = 'sel-divider';
    selBar.appendChild(d);
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SEL_ICONS[name]}</svg>`;

  QUICK_COLORS.forEach(([hex, name]) => {
    const b = add('sel-color', name, '<span></span>', (btn) => colorSelection(btn.dataset.color));
    if (hex) { b.dataset.color = hex; b.firstChild.style.background = hex; }
    else b.dataset.surfaceInk = '1'; // follows the board: black on white, chalk on black
  });
  divider();
  add('sel-btn', 'Smaller', icon('smaller'), () => scaleSelection(1 / SEL_SCALE_STEP));
  add('sel-btn', 'Bigger', icon('bigger'), () => scaleSelection(SEL_SCALE_STEP));
  divider();
  add('sel-btn danger', 'Delete', icon('trash'), () => deleteSelected());

  // Presses on the bar must not reach the board or close anything behind it.
  selBar.addEventListener('pointerdown', (e) => e.stopPropagation());
}

function updateSelBar() {
  const b = (showsSelection() && !isDrawing && !editing) ? selectionBounds() : null;
  if (!b) { selBar.classList.remove('visible'); return; }

  const ink = selBar.querySelector('[data-surface-ink]');
  if (ink) { ink.dataset.color = tpl().ink; ink.firstChild.style.background = tpl().ink; }
  selBar.classList.add('visible');

  // Above the selection when there is room, otherwise below it, and always
  // inside the board area.
  const pad = FRAME_PAD + 14;
  const r = canvasToScreenRect(b.x, b.y, b.x + b.w, b.y + b.h);
  const box = selBar.parentElement;
  const bw = selBar.offsetWidth, bh = selBar.offsetHeight;
  let top = r.top - pad - bh;
  if (top < 4) top = r.top + r.height + pad;
  if (top + bh > box.clientHeight - 4) top = Math.max(4, box.clientHeight - bh - 4);
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(4, Math.min(left, box.clientWidth - bw - 4));
  selBar.style.left = left + 'px';
  selBar.style.top = top + 'px';
}

function deleteSelected() {
  if (!selectedIds.length) return;
  const removeSet = new Set(selectedIds);
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (removeSet.has(shapes[i].id)) shapes.splice(i, 1);
  }
  // Detach any connectors/lines that were bound to a removed box.
  shapes.forEach(s => {
    if (isLineType(s.type)) {
      if (removeSet.has(s.from)) s.from = null;
      if (removeSet.has(s.to)) s.to = null;
    }
  });
  const n = removeSet.size;
  clearSelection();
  render();
  saveUndoState();
  syncCurrentPage();
  showToast(n > 1 ? `${n} deleted` : 'Deleted');
}

// ─── Eraser (works on legacy raster ink + vector strokes) ───
// Split every freehand stroke around the points falling inside the eraser
// circle, dropping tiny leftover fragments.
function eraseStrokesAt(pos, radius) {
  let changed = false;
  const next = [];
  for (const s of shapes) {
    if (!isStroke(s)) { next.push(s); continue; }
    const runs = [];
    let run = [];
    for (const p of s.pts) {
      if (Math.hypot(p[0] - pos.x, p[1] - pos.y) <= radius) {
        if (run.length) { runs.push(run); run = []; }
        changed = true;
      } else {
        run.push(p);
      }
    }
    if (run.length) runs.push(run);
    if (runs.length === 1 && runs[0].length === s.pts.length) {
      next.push(s); // untouched
    } else {
      changed = true;
      for (const r of runs) {
        if (r.length >= 2) next.push({ id: newId(), type: 'stroke', pts: r, color: s.color, lineWidth: s.lineWidth, ...(s.sharp ? { sharp: true } : {}) });
      }
    }
  }
  if (changed) { shapes.length = 0; shapes.push(...next); }
  return changed;
}

function eraseAt(pos) {
  touchInk(pages[currentPage]);
  // Legacy raster ink: punch a hole along the drag.
  inkCtx.save();
  inkCtx.globalCompositeOperation = 'destination-out';
  inkCtx.lineWidth = toolSizes.eraser;
  inkCtx.lineCap = 'round';
  inkCtx.beginPath();
  inkCtx.moveTo(lastX, lastY);
  inkCtx.lineTo(pos.x, pos.y);
  inkCtx.stroke();
  inkCtx.beginPath();
  inkCtx.arc(pos.x, pos.y, toolSizes.eraser / 2, 0, Math.PI * 2);
  inkCtx.fill();
  inkCtx.restore();
  // Vector strokes: split/remove points within the eraser radius.
  eraseStrokesAt(pos, toolSizes.eraser / 2);
}

// ─── Pen engine: stabiliser, Shift-straight, hold-to-straighten ───
// The ink does not follow the cursor directly. It follows a "brush" point that
// the cursor drags along on a short string: movements smaller than the string
// length (hand tremor, mouse jitter) do not move the brush at all.
const SMOOTH_LEVELS = { off: 0, low: 3, medium: 6, high: 12 }; // string length, canvas px
const SMOOTH_KEY = 'whiteboard.smoothing';
const smoothSelect = document.getElementById('smoothLevel');
let smoothing = 'medium';
try {
  const saved = localStorage.getItem(SMOOTH_KEY);
  if (saved && saved in SMOOTH_LEVELS) smoothing = saved;
} catch { /* storage unavailable */ }
smoothSelect.value = smoothing;
smoothSelect.addEventListener('change', () => {
  smoothing = smoothSelect.value;
  try { localStorage.setItem(SMOOTH_KEY, smoothing); } catch { /* ignore */ }
  smoothSelect.blur(); // give the keyboard back to the tool shortcuts
});

const PEN_MIN_DIST = 1.5;  // drop samples closer than this to the previous point
const HOLD_MS = 550;       // hold still this long to tidy the stroke into a shape
const HOLD_SLOP = 4;       // movement (canvas px) that still counts as holding still

let brush = null;        // stabilised pen position
let penStylus = false;   // the current stroke comes from a stylus (Apple Pencil, Surface Pen)
let brushP = 0.5;        // smoothed stylus pressure
const STYLUS_STRING = 1.5; // a stylus is steady already: cap the stabiliser string here

function r1(v) { return Math.round(v * 10) / 10; }
// Pressure of a pointer event, or null when the device does not report one.
function pressureOf(e) {
  return e && e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : null;
}
let penPointer = null;   // latest raw pointer position
let penStraight = false; // Shift held: the stroke is a straight segment
let holdAnchor = null;
let holdTimer = null;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// Snap the direction start→pos to the nearest 45° step. With `tolDeg` the snap
// only applies when the direction is already within that tolerance.
function snapAngle(start, pos, tolDeg) {
  const len = dist(start, pos);
  if (len === 0) return pos;
  const ang = Math.atan2(pos.y - start.y, pos.x - start.x);
  const step = Math.PI / 4;
  const near = Math.round(ang / step) * step;
  if (tolDeg !== undefined && Math.abs(ang - near) > (tolDeg * Math.PI) / 180) return pos;
  return { x: start.x + len * Math.cos(near), y: start.y + len * Math.sin(near) };
}

// Shift while dragging a shape tool: lines lock to 45° steps, boxes become square.
function constrainEnd(start, pos, def) {
  if (def.lineLike) return snapAngle(start, pos);
  const side = Math.max(Math.abs(pos.x - start.x), Math.abs(pos.y - start.y));
  return {
    x: start.x + (pos.x < start.x ? -side : side),
    y: start.y + (pos.y < start.y ? -side : side),
  };
}

function penPoint(x, y) {
  return penStylus ? [r1(x), r1(y), Math.round(brushP * 100) / 100] : [r1(x), r1(y)];
}

function penAddPoint(x, y) {
  const pts = activeStroke.pts;
  const last = pts[pts.length - 1];
  if (Math.hypot(x - last[0], y - last[1]) >= PEN_MIN_DIST) pts.push(penPoint(x, y));
}

function armHold(pos) {
  holdAnchor = pos;
  clearTimeout(holdTimer);
  holdTimer = setTimeout(snapHeldStroke, HOLD_MS);
}

function penStart(pos, pressure) {
  penStylus = pressure != null;
  brushP = penStylus ? pressure : 0.5;
  activeStroke = {
    id: newId(), type: 'stroke', pts: [penPoint(pos.x, pos.y)],
    color: colorPicker.value, lineWidth: toolSizes.pen,
  };
  shapes.push(activeStroke);
  brush = { x: pos.x, y: pos.y };
  penPointer = pos;
  penStraight = false;
  armHold(pos);
}

function penMove(pos, shift, pressure) {
  if (!activeStroke) return;
  penPointer = pos;
  if (penStylus && pressure != null) brushP += (pressure - brushP) * 0.4;
  if (!holdAnchor || dist(pos, holdAnchor) > HOLD_SLOP) armHold(pos);

  if (shift) {
    // Straight segment from where the stroke began, easing onto 45° steps.
    const p0 = activeStroke.pts[0];
    const end = snapAngle({ x: p0[0], y: p0[1] }, pos, 6);
    activeStroke.pts = [[p0[0], p0[1]], [r1(end.x), r1(end.y)]];
    penStraight = true;
    brush = { x: end.x, y: end.y };
    return;
  }
  penStraight = false;

  const r = penStylus ? Math.min(SMOOTH_LEVELS[smoothing], STYLUS_STRING) : SMOOTH_LEVELS[smoothing];
  const d = dist(pos, brush);
  if (d <= r) return;
  const k = (d - r) / d;
  brush.x += (pos.x - brush.x) * k;
  brush.y += (pos.y - brush.y) * k;
  penAddPoint(brush.x, brush.y);
}

function penEnd() {
  clearTimeout(holdTimer);
  // The brush trails the cursor by the string length — close that gap.
  if (activeStroke && !penStraight && penPointer && activeStroke.pts.length > 1) {
    penAddPoint(penPointer.x, penPointer.y);
  }
  activeStroke = null;
  brush = null;
  penPointer = null;
  holdAnchor = null;
}

// Resample a point list to roughly even spacing so slow and fast parts of a
// stroke weigh the same in the shape tests below.
function resamplePts(pts, spacing) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const seg = Math.hypot(x2 - x1, y2 - y1);
    if (seg === 0) continue;
    let t = spacing - carry;
    while (t <= seg) {
      out.push([x1 + ((x2 - x1) * t) / seg, y1 + ((y2 - y1) * t) / seg]);
      t += spacing;
    }
    carry = seg - (t - spacing);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Ramer–Douglas–Peucker: keep only the points that deviate more than eps.
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let worst = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegment(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]);
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst <= eps) return [a, b];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}

// Corner points of a closed loop: simplify, merge the overlapping start/end,
// then drop any vertex that sits on a nearly straight run.
function loopCorners(pts, diag) {
  let v = rdp(pts, diag * 0.07);
  if (v.length > 2 && Math.hypot(v[0][0] - v[v.length - 1][0], v[0][1] - v[v.length - 1][1]) < diag * 0.25) v.pop();
  let changed = true;
  while (changed && v.length > 3) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const p = v[(i + v.length - 1) % v.length], q = v[i], n = v[(i + 1) % v.length];
      const a1 = Math.atan2(p[1] - q[1], p[0] - q[0]);
      const a2 = Math.atan2(n[1] - q[1], n[0] - q[0]);
      let ang = Math.abs(a1 - a2);
      if (ang > Math.PI) ang = Math.PI * 2 - ang;
      if (ang > (150 * Math.PI) / 180) { v.splice(i, 1); changed = true; break; }
    }
  }
  return v;
}

// Decide what clean shape (if any) a freehand stroke was meant to be.
// Returns { kind: 'line' | 'ellipse' | 'rect' | 'polygon', ... } or null.
function recognizeStroke(rawPts) {
  if (rawPts.length < 2) return null;
  const pts = resamplePts(rawPts, 4);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len < 50) return null;

  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);

  // Open stroke → a straight line, if it never strays far from its chord.
  if (gap > len * 0.25) {
    let dev = 0;
    for (const p of pts) dev = Math.max(dev, pointToSegment(p[0], p[1], first[0], first[1], last[0], last[1]));
    if (dev > Math.max(6, gap * 0.1) || len > gap * 1.3) return null;
    const end = snapAngle({ x: first[0], y: first[1] }, { x: last[0], y: last[1] }, 4);
    return { kind: 'line', x1: first[0], y1: first[1], x2: end.x, y2: end.y };
  }

  // Closed loop → ellipse, rectangle or polygon.
  const b = strokeBounds({ pts });
  if (b.w < 16 || b.h < 16) return null;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  let err = 0;
  for (const p of pts) err += Math.abs(Math.hypot((p[0] - cx) / (b.w / 2), (p[1] - cy) / (b.h / 2)) - 1);
  err /= pts.length;

  const ellipse = () => {
    // Nearly round → a true circle.
    if (Math.abs(b.w - b.h) / Math.max(b.w, b.h) < 0.15) {
      const d = (b.w + b.h) / 2;
      return { kind: 'ellipse', x: cx - d / 2, y: cy - d / 2, w: d, h: d };
    }
    return { kind: 'ellipse', x: b.x, y: b.y, w: b.w, h: b.h };
  };
  if (err < 0.09) return ellipse();

  const corners = loopCorners(pts, Math.hypot(b.w, b.h));
  if (corners.length === 4) {
    // Axis-aligned if each corner sits near its own corner of the bounding box.
    const tol = Math.min(b.w, b.h) * 0.25;
    const used = new Set();
    for (const [x, y] of corners) {
      const k = boxCorners(b).findIndex(([bx, by]) => Math.hypot(x - bx, y - by) <= tol);
      if (k !== -1) used.add(k);
    }
    if (used.size === 4) return { kind: 'rect', x: b.x, y: b.y, w: b.w, h: b.h };
  }
  if (corners.length === 3 || corners.length === 4) {
    return { kind: 'polygon', pts: corners.concat([corners[0]]).map(p => p.slice()) };
  }
  return err < 0.2 ? ellipse() : null;
}

// Fired when the pen is held still mid-stroke: swap the wobbly stroke for the
// clean shape it resembles. The rest of the drag is ignored until release.
function snapHeldStroke() {
  if (!activeStroke || !isDrawing || currentTool !== 'pen' || penStraight) return;
  const pts = activeStroke.pts.slice();
  if (penPointer) pts.push([penPointer.x, penPointer.y]);
  const hit = recognizeStroke(pts);
  if (!hit) return;

  const base = { id: activeStroke.id, color: activeStroke.color, lineWidth: activeStroke.lineWidth };
  let shape, label;
  if (hit.kind === 'line') {
    shape = { ...base, type: 'line', x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2, from: null, to: null };
    label = 'line';
  } else if (hit.kind === 'ellipse') {
    shape = { ...base, type: 'circle', x: hit.x, y: hit.y, w: hit.w, h: hit.h, text: '' };
    label = hit.w === hit.h ? 'circle' : 'oval';
  } else if (hit.kind === 'rect') {
    shape = { ...base, type: 'rect', x: hit.x, y: hit.y, w: hit.w, h: hit.h, text: '' };
    label = 'rectangle';
  } else {
    shape = { ...base, type: 'stroke', pts: hit.pts, sharp: true };
    label = hit.pts.length === 4 ? 'triangle' : 'quadrilateral';
  }
  const i = shapes.indexOf(activeStroke);
  if (i !== -1) shapes.splice(i, 1, shape);
  activeStroke = null;
  render();
  if (window.Live) Live.localChanged();
  showToast(`Tidied to ${label}`);
}

// Coalesce pen/eraser redraws to one per animation frame.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// ─── Drawing dispatch ───
function startDraw(e) {
  if (editing) { commitTextEditor(); return; }
  const pos = getPosition(e);

  if (currentTool === 'select') {
    isDrawing = true;
    startSelect(pos, e.shiftKey);
    return;
  }

  if (currentTool === 'lasso') {
    isDrawing = true;
    // Press on an element → move it (or the whole selection); empty space → lasso.
    if (shapeAt(pos) || selectionGrab(pos)) {
      lassoMoving = true;
      startSelect(pos, e.shiftKey);
    } else {
      lassoMoving = false;
      if (!e.shiftKey) clearSelection();
      lassoPoints = [pos];
      render();
    }
    return;
  }

  if (isShapeTool(currentTool)) {
    isDrawing = true;
    lineStart = pos;
    shapeEnd = pos;
    return;
  }

  // pen → new vector stroke; eraser → remove ink + strokes under the cursor
  isDrawing = true;
  lastX = pos.x;
  lastY = pos.y;
  if (currentTool === 'eraser') {
    eraseAt(pos);
  } else {
    penStart(pos, pressureOf(e));
  }
  render();
}

function draw(e) {
  if (!isDrawing) return;
  let pos = getPosition(e);

  if (currentTool === 'select') { moveSelect(pos); return; }

  if (currentTool === 'lasso') {
    if (lassoMoving) { moveSelect(pos); return; }
    const last = lassoPoints[lassoPoints.length - 1];
    if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) > 2) lassoPoints.push(pos);
    render();
    drawLassoPreview();
    return;
  }

  if (isShapeTool(currentTool)) {
    const def = TOOL_DEFS[currentTool];
    if (e.shiftKey) pos = constrainEnd(lineStart, pos, def);
    shapeEnd = pos;
    render();
    const size = Number(brushSize.value);
    if (def.lineLike) {
      if (def.type === 'line') {
        strokeLine(ctx, lineStart.x, lineStart.y, pos.x, pos.y, colorPicker.value, size);
      } else if (def.type === 'doublearrow') {
        strokeDoubleArrow(ctx, lineStart.x, lineStart.y, pos.x, pos.y, colorPicker.value, size);
      } else {
        strokeArrow(ctx, lineStart.x, lineStart.y, pos.x, pos.y, colorPicker.value, size);
      }
      if (def.snap) {
        const target = boxAt(pos, SNAP_MARGIN);
        if (target) highlightBox(target);
      }
    } else {
      const b = normBounds(lineStart.x, lineStart.y, pos.x, pos.y);
      strokeBox(ctx, def.type, b.x, b.y, b.w, b.h, colorPicker.value, size);
    }
    return;
  }

  // pen / eraser
  if (currentTool === 'eraser') {
    eraseAt(pos);
  } else {
    // Use every sample the browser batched into this frame, not just the last.
    const batch = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (batch.length) for (const ce of batch) penMove(getPosition(ce), e.shiftKey, pressureOf(ce));
    else penMove(pos, e.shiftKey, pressureOf(e));
  }
  lastX = pos.x;
  lastY = pos.y;
  scheduleRender();
}

function highlightBox(box) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
  ctx.restore();
}

function stopDraw() {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentTool === 'select') { endSelect(); return; }
  if (currentTool === 'lasso') {
    if (lassoMoving) { lassoMoving = false; endSelect(); return; }
    commitLasso();
    return;
  }
  if (isShapeTool(currentTool)) { finishShape(); return; }

  // pen (vector stroke) / eraser
  penEnd();
  render();
  saveUndoState();
  syncCurrentPage();
}

function syncCurrentPage() {
  commitCurrentPage();
  const thumbImg = pageStripInner.querySelectorAll('.page-thumb img')[currentPage];
  if (thumbImg) thumbImg.src = pages[currentPage].data;
  persistState();
}

// ─── Pointer events (mouse, touch and stylus) ───
// The pointer is captured for the length of a drag, so a stroke carries on
// when the cursor slips off the canvas instead of being cut short.
let activePointer = null;
let activeType = null;
// Finger strokes: a touch shorter than GRAZE_MS that moves less than GRAZE_PX
// leaves no mark.
const GRAZE_MS = 150;
const GRAZE_PX = 12;
let fingerStroke = null; // { t, x, y, reach } of the finger drawing now

// No text selection outside the text fields. On an iPad a long press or a
// resting palm on the page strip or a rail selected the page and opened the
// Copy / Look Up / Translate menu over the board. The CSS blocks it; this
// catches any selection the browser starts anyway.
function editableTarget(n) {
  const el = n && (n.nodeType === 1 ? n : n.parentElement);
  return !!(el && el.closest('input, textarea, [contenteditable="true"]'));
}
document.addEventListener('selectstart', e => {
  if (!editableTarget(e.target)) e.preventDefault();
}, true);
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || editableTarget(sel.anchorNode)
      || editableTarget(document.activeElement)) return;
  sel.removeAllRanges();
});

// Palm rejection. Once a stylus has touched the board the app is Pencil-only:
// only the Pencil writes on the board. Fingers still press the toolbar, the
// page strip, the rails and the selection bar, and on the board they use
// gestures (swipe to turn the page, double-tap for the next colour, triple-tap
// for black). A touch while the Pencil is down or just after it lifts is the
// palm and does nothing. The hand button that appears in the toolbar turns
// finger drawing on. The device is remembered, so after a reload the palm is
// ignored from the first stroke.
const STYLUS_KEY = 'whiteboard-stylus';
const FINGER_KEY = 'whiteboard-finger-draw';
// An iPad is used with a Pencil, so it starts in stylus-only mode before the
// Pencil has touched the board; the hand button turns finger drawing on.
const IS_IPAD = /iPad/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let stylusSeen = IS_IPAD;
let fingerDraw = false;
try {
  stylusSeen = stylusSeen || localStorage.getItem(STYLUS_KEY) === '1';
  fingerDraw = localStorage.getItem(FINGER_KEY) === '1';
} catch { /* storage unavailable */ }
let fingerHintShown = false; // the finger-gesture hint, once per visit
const GESTURE_HINT = 'Only the Pencil writes. Fingers: swipe to turn pages, double-tap for the next colour, triple-tap for black';
const btnFinger = document.getElementById('btnFinger');
function syncFingerBtn() {
  btnFinger.hidden = !stylusSeen;
  btnFinger.classList.toggle('active', fingerDraw);
  btnFinger.title = fingerDraw
    ? 'Finger drawing is on. Tap for Pencil only (palm rejection, finger gestures)'
    : 'Pencil only: fingers press buttons and use gestures, the palm is ignored. Tap to draw with a finger too';
}
btnFinger.addEventListener('click', () => {
  fingerDraw = !fingerDraw;
  try { localStorage.setItem(FINGER_KEY, fingerDraw ? '1' : '0'); } catch { /* ignore */ }
  syncFingerBtn();
  resetTaps();
  showToast(fingerDraw ? 'Finger drawing on' : GESTURE_HINT);
});
syncFingerBtn();

// ─── Finger gestures on the board (Pencil-only mode) ───
//   • swipe left / right — next / previous page;
//   • double-tap — the next pen colour;
//   • triple-tap — back to the pen in black (the board's default ink).
// The double-tap waits one tap-gap to see whether a third tap follows.
// (A web page cannot see the double-tap on the barrel of an Apple Pencil.)
const TAP_MS = 250;        // a tap is down and up within this
const DOUBLE_TAP_MS = 400; // gap allowed between taps in one sequence
const TAP_SLOP = 24;       // screen px a tap may move, and the taps may differ by
const SWIPE_PX = 80;       // a swipe travels at least this far sideways…
const SWIPE_MS = 700;      // …within this time, and mostly sideways
let lastTap = null;        // last tap of the sequence: { x, y, t, n }
let tapTimer = null;       // pending double-tap action
function resetTaps() { lastTap = null; clearTimeout(tapTimer); tapTimer = null; }
function defaultPen() {
  setTool('pen');
  applyColor(tpl().ink);
  showToast(tpl().dark ? 'Pen: chalk (default ink)' : 'Pen: black');
}
function turnPage(dir) {
  const to = currentPage + dir;
  if (to < 0) { showToast('This is the first page'); return; }
  if (to >= pages.length) { showToast('Last page: tap + to add one'); return; }
  switchPage(to);
  showToast(`Page ${to + 1} of ${pages.length}`);
}
function fingerTap(x, y, now) {
  const chained = lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < TAP_SLOP * 2;
  const n = chained ? lastTap.n + 1 : 1;
  clearTimeout(tapTimer); tapTimer = null;
  if (n >= 3) { resetTaps(); defaultPen(); return; }
  lastTap = { x, y, t: now, n };
  if (n === 2) tapTimer = setTimeout(() => { resetTaps(); cyclePenColor(1); }, DOUBLE_TAP_MS);
}
// g: { x, y, t, reach } recorded when the finger landed; e: its pointerup.
function fingerGesture(g, e) {
  const now = performance.now();
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy) && now - g.t <= SWIPE_MS) {
    resetTaps();
    turnPage(dx < 0 ? 1 : -1); // finger moves left: the next page comes in from the right
    return;
  }
  if (now - g.t <= TAP_MS && g.reach <= TAP_SLOP) fingerTap(e.clientX, e.clientY, now);
  else resetTaps();
}

// Throw away whatever the active pointer was doing (a palm that landed just
// before the stylus) without committing it.
function abortDraw() {
  const id = activePointer;
  activePointer = null;
  try { canvas.releasePointerCapture(id); } catch { /* not captured */ }
  if (!isDrawing) return;
  if (currentTool === 'pen' && activeStroke) {
    const i = shapes.indexOf(activeStroke);
    if (i !== -1) shapes.splice(i, 1);
    clearTimeout(holdTimer);
    activeStroke = null; brush = null; penPointer = null; holdAnchor = null;
    isDrawing = false;
    render();
    if (window.Live) Live.localChanged();
    return;
  }
  if (isShapeTool(currentTool)) { isDrawing = false; lineStart = null; render(); return; }
  stopDraw();
}

// ─── Palm guard (whole page) ───
// The hand that holds the stylus rests on the screen, and that palm reaches
// the toolbar, the page strip, the rails and the selection bar as well as the
// board. A touch counts as palm, and does nothing at all, when
//   • it lands while the stylus is down, or shortly after it lifts;
//   • the stylus lands while it is down (a palm that got there first);
//   • on the board, its contact area is palm-sized (where the browser reports
//     one). Not used on the controls: iPad Safari reports a contact box of
//     twice the touch radius, so a firm fingertip already measures 60–80 px;
//   • in Pencil-only mode, it lands on the board while another touch is
//     there (a palm is several contacts; it also ends any gesture).
// Any other touch works the controls. On the board, in Pencil-only mode it
// never draws: it is read as a gesture (swipe, double- or triple-tap).
// Listeners on window, capture phase: they run before every other handler.
const PALM_SETTLE_MS = 1000; // after the stylus lifts, a new touch on the board is still the palm
const PALM_SETTLE_UI_MS = 500; // …and on a button: a shorter wait, so a finger can reach for a control
const PALM_SIZE = 150;       // CSS px: a contact this wide is a palm (a fingertip is 40–100 on iPad)
const PALM_CLICK_MS = 1000;  // how long after a palm lifts its click is swallowed
let stylusDown = false;
let stylusUpAt = -Infinity;
const touchesDown = new Map(); // touch pointerId -> { palm, board, gesture }
let lastUp = null;             // { palm, t } of the last pointer to lift (its click follows)
function stylusMode() { return stylusSeen && !fingerDraw; }
function stylusRecent(ms = PALM_SETTLE_MS) { return stylusDown || performance.now() - stylusUpAt < ms; }
function palmSized(e) { return Math.max(e.width || 0, e.height || 0) >= PALM_SIZE; }
// Everything a touch has started is dropped once it turns out to be a palm.
function dropPalmTouches() {
  touchesDown.forEach(t => { t.palm = true; t.gesture = null; });
  resetTaps();
  if (railDrag && railDrag.id !== stylusPointerId) railEnd();
  if (activePointer !== null && activeType === 'touch') abortDraw();
}
let stylusPointerId = null;
function noteStylus() {
  if (stylusSeen) return;
  stylusSeen = true;
  try { localStorage.setItem(STYLUS_KEY, '1'); } catch { /* ignore */ }
  syncFingerBtn();
  fingerHintShown = true;
  showToast('Pencil detected: palm is ignored. ' + GESTURE_HINT);
}
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') {
    noteStylus();
    stylusDown = true;
    stylusPointerId = e.pointerId;
    dropPalmTouches();
    return;
  }
  if (e.pointerType !== 'touch') return;
  const board = e.target === canvas;
  let palm = (stylusSeen && stylusRecent(board ? PALM_SETTLE_MS : PALM_SETTLE_UI_MS))
    || (board && palmSized(e));
  let gesture = null;
  if (board && stylusMode()) {
    let crowd = false;
    touchesDown.forEach(t => { if (t.board) { crowd = true; t.palm = true; t.gesture = null; } });
    if (crowd) { palm = true; resetTaps(); }
    if (!palm) {
      gesture = { x: e.clientX, y: e.clientY, t: performance.now(), reach: 0 };
      if (!fingerHintShown) { fingerHintShown = true; showToast(GESTURE_HINT); }
    }
  }
  touchesDown.set(e.pointerId, { palm, board, gesture });
  // A palm does nothing; a gesture finger never reaches the drawing code.
  if (palm || gesture) { e.stopPropagation(); e.preventDefault(); }
}, true);
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  const t = touchesDown.get(e.pointerId);
  if (!t) return;
  // A palm often lands small and spreads as it settles.
  if (!t.palm && t.board && palmSized(e)) {
    t.palm = true;
    t.gesture = null;
    resetTaps();
    if (activePointer === e.pointerId) abortDraw();
  }
  if (t.gesture) {
    t.gesture.reach = Math.max(t.gesture.reach, Math.hypot(e.clientX - t.gesture.x, e.clientY - t.gesture.y));
    e.stopPropagation();
    e.preventDefault();
  } else if (t.palm) e.stopPropagation();
}, true);
function palmUp(e) {
  if (e.pointerType === 'pen') {
    stylusDown = false;
    stylusUpAt = performance.now();
    stylusPointerId = null;
  }
  const t = e.pointerType === 'touch' ? touchesDown.get(e.pointerId) : null;
  if (t) touchesDown.delete(e.pointerId);
  if (t && t.gesture && !t.palm) {
    e.stopPropagation();
    if (e.type === 'pointerup') fingerGesture(t.gesture, e);
    else resetTaps();
  }
  // The click (or double-click) a palm or a gesture finger would make is swallowed.
  lastUp = { palm: !!(t && (t.palm || t.gesture)), t: performance.now() };
}
window.addEventListener('pointerup', palmUp, true);
window.addEventListener('pointercancel', palmUp, true);
// A browser can skip a touch's pointerup (a system gesture, the app losing
// focus); a touch list that empties says every contact really has lifted.
// Deferred, so a pointerup that comes after the touchend still finds its touch.
function clearTouches(e) {
  if (e && e.touches && e.touches.length) return;
  setTimeout(() => { if (!e || !e.touches || e.touches.length === 0) touchesDown.clear(); }, 0);
}
window.addEventListener('touchend', clearTouches, true);
window.addEventListener('touchcancel', clearTouches, true);
window.addEventListener('blur', () => { touchesDown.clear(); stylusDown = false; });
// The click a palm would have made on a button, a page or a rail item, and
// the double-click (label editor) or long-press menu it could open.
function swallowPalmClick(e) {
  const up = lastUp;
  if (!up || !up.palm || performance.now() - up.t > PALM_CLICK_MS) return;
  e.stopPropagation();
  e.preventDefault();
}
window.addEventListener('click', swallowPalmClick, true);
window.addEventListener('dblclick', swallowPalmClick, true);
window.addEventListener('contextmenu', (e) => {
  if (stylusMode() && touchesDown.size) { e.stopPropagation(); e.preventDefault(); }
  else swallowPalmClick(e);
}, true);

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen' && activePointer !== null && activeType === 'touch') abortDraw();
  if (e.pointerType === 'touch' && stylusMode()) return; // gestures only: the palm guard already stops these
  // Finger drawing: a second touch during a finger stroke means a palm (or a
  // pinch) is on the board, so the stroke is dropped rather than kept.
  if (e.pointerType === 'touch' && activePointer !== null && activeType === 'touch') { abortDraw(); return; }
  if (activePointer !== null) return;                    // ignore extra fingers
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  activePointer = e.pointerId;
  activeType = e.pointerType;
  fingerStroke = e.pointerType === 'touch' ? { t: performance.now(), x: e.clientX, y: e.clientY, reach: 0 } : null;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  startDraw(e);
});

canvas.addEventListener('pointermove', (e) => {
  if (activePointer !== null && e.pointerId !== activePointer) return;
  if (fingerStroke && e.pointerId === activePointer) {
    fingerStroke.reach = Math.max(fingerStroke.reach, Math.hypot(e.clientX - fingerStroke.x, e.clientY - fingerStroke.y));
  }
  draw(e);
  const pos = getPosition(e);
  statusCoords.textContent = `${Math.round(pos.x)}, ${Math.round(pos.y)}`;
  updateEraserCursor(pos);
  if (showsSelection() && !isDrawing) updateSelectCursor(pos);
});

function endPointer(e) {
  if (e.pointerId !== activePointer) return;
  // A finger that only brushes the board (brief and nearly still) is a graze
  // of the hand, not a dot: its mark is dropped.
  const f = fingerStroke;
  fingerStroke = null;
  if (f && currentTool === 'pen' && performance.now() - f.t < GRAZE_MS && f.reach < GRAZE_PX) { abortDraw(); return; }
  activePointer = null;
  stopDraw();
  if (e.pointerType !== 'mouse') hideEraserCursor();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
canvas.addEventListener('pointerleave', () => { if (!isDrawing) hideEraserCursor(); });

canvas.addEventListener('dblclick', (e) => {
  const pos = getPosition(e);
  const box = boxAt(pos, 0);
  if (box) { selectOnly(box.id); openBoxEditor(box); }
});

// ─── Actions ───
function clearCanvas() {
  touchInk(pages[currentPage]);
  inkCtx.clearRect(0, 0, W, H);
  shapes.length = 0;
  clearSelection();
  render();
  saveUndoState();
  syncCurrentPage();
  showToast('Page cleared');
}

function exportPDF() {
  commitCurrentPage();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [W, H] });
  pages.forEach((page, i) => {
    if (i > 0) pdf.addPage([W, H], 'landscape');
    pdf.addImage(page.data, 'PNG', 0, 0, W, H);
  });
  pdf.save(`whiteboard-${pages.length}pages-${Date.now()}.pdf`);
  showToast(`Exported ${pages.length} page${pages.length > 1 ? 's' : ''} as PDF`);
}

// ─── Toast ───
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
}

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  // Don't hijack typing in the box label editor.
  if (editing || e.target === shapeTextEditor) return;

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
    e.preventDefault();
    deleteSelected();
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    // Ctrl/Cmd+A: next pen colour (Shift reverses). Overrides the browser's Select All.
    if (e.key.toLowerCase() === 'a') { e.preventDefault(); cyclePenColor(e.shiftKey ? -1 : 1); return; }
    // Page navigation: Ctrl+Left/Right
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (currentPage > 0) switchPage(currentPage - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); if (currentPage < pages.length - 1) switchPage(currentPage + 1); }
    return;
  }

  if (e.key === 'v') setTool('select');
  if (e.key === 'b') setTool('pen');
  if (e.key === 'e') setTool('eraser');
  if (e.key === 'l') setTool('lasso');
  if (e.key === 'r') setTool('rect');
  if (e.key === 'o') setTool('circle');
  if (e.key === 'i') setTool('line');
  if (e.key === 'a') setTool('arrow');
  if (e.key === 'p') setTool('process');
  if (e.key === 'd') setTool('decision');
  if (e.key === 'g') setTool('terminator');
  if (e.key === 'c') setTool('connector');

  if (e.key === 'PageUp') { e.preventDefault(); if (currentPage > 0) switchPage(currentPage - 1); }
  if (e.key === 'PageDown') { e.preventDefault(); if (currentPage < pages.length - 1) switchPage(currentPage + 1); }
});

// ─── Canvas Resize ───
function resizeCanvas() {
  const container = document.querySelector('.canvas-container');
  const maxWidth = container.clientWidth - 48;
  const maxHeight = container.clientHeight - 48;
  const aspectRatio = 1200 / 700;
  let newWidth = Math.min(1200, maxWidth);
  let newHeight = newWidth / aspectRatio;
  if (newHeight > maxHeight) {
    newHeight = maxHeight;
    newWidth = newHeight * aspectRatio;
  }
  canvas.style.width = newWidth + 'px';
  canvas.style.height = newHeight + 'px';
}

window.addEventListener('resize', () => {
  if (editing) commitTextEditor();
  resizeCanvas();
  updateSelBar();
});
resizeCanvas();

// ─── Initial render ───
buildPalette();
buildSelBar();
applyCanvasBg();
setColor(tpl().ink);
syncTemplateMenu();
setTool('pen');
renderPageStrip();
