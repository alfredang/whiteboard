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
const btnAddPage = document.getElementById('btnAddPage');

const btnSelect = document.getElementById('btnSelect');
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

const W = canvas.width;
const H = canvas.height;

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
// Each template defines the canvas surface colour, the default ink colour, an
// optional background pattern, and whether it counts as a "dark" surface
// (crossing the light/dark boundary recolours existing ink so it stays visible).
const TEMPLATES = {
  whiteboard: { bg: '#ffffff', ink: '#111111', dark: false, pattern: null },
  blackboard: { bg: '#16241c', ink: '#f4f4f0', dark: true,  pattern: null },
  grid:       { bg: '#ffffff', ink: '#111111', dark: false, pattern: 'grid' },
  dotted:     { bg: '#fcfcfc', ink: '#111111', dark: false, pattern: 'dots' },
  lined:      { bg: '#fffdf5', ink: '#111111', dark: false, pattern: 'lines' },
};
let template = 'whiteboard';
function tpl() { return TEMPLATES[template]; }
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
function newId() { return 's' + (shapeSeq++); }
function bumpSeq(arr) {
  for (const s of arr) {
    const n = parseInt(String(s.id).replace(/\D/g, ''), 10);
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

let saveTimer;
function persistState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload = {
        template,
        currentPage,
        pages: pages.map(p => ({ ink: p.ink, shapes: p.shapes })),
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

// Render a freehand pen stroke (a polyline through its captured points).
function strokeFreehand(c, pts, color, lw) {
  if (!pts || pts.length === 0) return;
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
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
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
    strokeFreehand(c, s.pts, s.color, s.lineWidth);
  } else {
    strokeBox(c, s.type, s.x, s.y, s.w, s.h, s.color, s.lineWidth);
    if (s !== editingBox && s.text) fillBoxText(c, s.type, s.x, s.y, s.w, s.h, s.text, s.color);
  }
}

// Draw the active template's background pattern (grid / dots / lines) onto a
// context that has already been filled with the surface colour.
function drawPaperPattern(c) {
  const pattern = tpl().pattern;
  if (!pattern) return;
  const step = 28;
  c.save();
  c.globalCompositeOperation = 'source-over';
  if (pattern === 'grid') {
    c.strokeStyle = 'rgba(60, 90, 160, 0.12)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = step; x < W; x += step) { c.moveTo(x, 0); c.lineTo(x, H); }
    for (let y = step; y < H; y += step) { c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
  } else if (pattern === 'dots') {
    c.fillStyle = 'rgba(40, 40, 60, 0.22)';
    for (let x = step; x < W; x += step) {
      for (let y = step; y < H; y += step) {
        c.beginPath();
        c.arc(x, y, 1.3, 0, Math.PI * 2);
        c.fill();
      }
    }
  } else if (pattern === 'lines') {
    c.strokeStyle = 'rgba(150, 120, 60, 0.30)';
    c.lineWidth = 1;
    c.beginPath();
    for (let y = step; y < H; y += step) { c.moveTo(0, y); c.lineTo(W, y); }
    c.stroke();
  }
  c.restore();
}

// ─── Compositing ───
function render() {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = canvasBgColor();
  ctx.fillRect(0, 0, W, H);
  drawPaperPattern(ctx);
  ctx.drawImage(inkCanvas, 0, 0);
  for (const s of shapes) drawShape(ctx, s);
  if (showsSelection() && selectedIds.length) drawSelection();
}

// Both Select and Lasso show and manipulate the current selection.
function showsSelection() { return currentTool === 'select' || currentTool === 'lasso'; }

function drawSelection() {
  // Resize handles only when exactly one shape is selected; a multi-selection
  // just gets an outline per element.
  const single = selectedIds.length === 1;
  for (const id of selectedIds) {
    const s = shapeById(id);
    if (!s) continue;
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
}

function boxCorners(b) {
  return [
    [b.x, b.y], [b.x + b.w, b.y],
    [b.x, b.y + b.h], [b.x + b.w, b.y + b.h],
  ];
}

function handleAt(pos, box) {
  const map = {
    nw: [box.x, box.y], ne: [box.x + box.w, box.y],
    sw: [box.x, box.y + box.h], se: [box.x + box.w, box.y + box.h],
  };
  for (const k in map) {
    if (Math.abs(pos.x - map[k][0]) <= HANDLE_HIT && Math.abs(pos.y - map[k][1]) <= HANDLE_HIT) return k;
  }
  return null;
}

// ─── Init Canvas ───
ctx.lineCap = 'round';
ctx.lineJoin = 'round';

// Restore from localStorage if present, otherwise create a blank first page
const persisted = loadPersistedState();
if (persisted) {
  if (persisted.template && TEMPLATES[persisted.template]) {
    template = persisted.template;
  } else if (persisted.theme) {
    // Backward-compat: the old binary theme toggle.
    template = persisted.theme === 'light' ? 'blackboard' : 'whiteboard';
  }
  pages = persisted.pages.map(p => {
    // Backward-compat: older saves stored a flattened bitmap as `data`.
    const ink = p.ink || p.data || transparentInk();
    const sh = Array.isArray(p.shapes) ? p.shapes : [];
    return { ink, shapes: sh, data: ink, undoStack: [{ ink, shapes: cloneShapes(sh) }] };
  });
  currentPage = Math.min(persisted.currentPage || 0, pages.length - 1);
  pages.forEach(p => bumpSeq(p.shapes));
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
  return { ink, shapes: [], data, undoStack: [{ ink, shapes: [] }] };
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
  pageStripInner.appendChild(dropIndicator);

  const activeThumb = pageStripInner.querySelector('.page-thumb.active');
  if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  updateStatusPage();
}

btnAddPage.addEventListener('click', addPage);

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

async function setTemplate(name) {
  if (!TEMPLATES[name] || name === template) { closeDropdowns(); return; }
  commitCurrentPage();

  const prev = TEMPLATES[template];
  const next = TEMPLATES[name];
  const crossesDark = prev.dark !== next.dark;

  // Crossing the light/dark boundary recolours existing ink so it stays visible.
  if (crossesDark) {
    for (const page of pages) {
      page.ink = await invertImageDataURL(page.ink);
      page.shapes.forEach(s => { s.color = invertHex(s.color); });
      page.undoStack = await Promise.all(page.undoStack.map(async (snap) => ({
        ink: await invertImageDataURL(snap.ink),
        shapes: snap.shapes.map(s => ({ ...s, color: invertHex(s.color) })),
      })));
    }
    // Flip the default pen colour if it still matches the old template's default.
    if (colorPicker.value.toLowerCase() === prev.ink.toLowerCase()) {
      setColor(next.ink);
    }
  }

  template = name;
  applyCanvasBg();

  // Reflect the active template in the dropdown.
  document.querySelectorAll('.template-item').forEach(el => {
    el.classList.toggle('active', el.dataset.template === name);
  });

  shapes = pages[currentPage].shapes;
  loadPage(currentPage);
  flattenAllThumbnails();
  renderPageStrip();
  closeDropdowns();
  persistState();
  showToast(`${name.charAt(0).toUpperCase() + name.slice(1)} template`);
}

document.querySelectorAll('.template-item').forEach(item => {
  item.addEventListener('click', () => setTemplate(item.dataset.template));
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

// Apply a colour to the pen and to every selected shape.
function applyColor(hex) {
  setColor(hex);
  if (currentTool === 'select' && selectedIds.length) {
    let changed = false;
    selectedIds.forEach(id => { const s = shapeById(id); if (s) { s.color = hex; changed = true; } });
    if (changed) { render(); saveUndoState(); syncCurrentPage(); }
  }
  if (currentTool === 'eraser') setTool('pen');
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
  if (ids.length) showToast(`${ids.length} element${ids.length > 1 ? 's' : ''} selected — drag to move`);
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
  const items = selectedIds.map(id => shapeById(id)).filter(Boolean).map(s => {
    if (isLineType(s.type)) return { shape: s, kind: 'line', orig: { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 } };
    if (isStroke(s)) return { shape: s, kind: 'stroke', orig: { pts: s.pts.map(p => p.slice()) } };
    return { shape: s, kind: 'box', orig: { x: s.x, y: s.y } };
  });
  return { mode: 'move', start: pos, items, moved: false, single: items.length === 1 };
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
        s.pts = it.orig.pts.map(p => [p[0] + dx, p[1] + dy]);
      } else {
        s.x = it.orig.x + dx; s.y = it.orig.y + dy;
      }
    }
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
  canvas.style.cursor = shapeAt(pos) ? 'move' : (currentTool === 'lasso' ? 'crosshair' : 'default');
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
        if (r.length >= 2) next.push({ id: newId(), type: 'stroke', pts: r, color: s.color, lineWidth: s.lineWidth });
      }
    }
  }
  if (changed) { shapes.length = 0; shapes.push(...next); }
  return changed;
}

function eraseAt(pos) {
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
    if (shapeAt(pos)) {
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
    activeStroke = {
      id: newId(), type: 'stroke', pts: [[pos.x, pos.y]],
      color: colorPicker.value, lineWidth: toolSizes.pen,
    };
    shapes.push(activeStroke);
  }
  render();
}

function draw(e) {
  if (!isDrawing) return;
  const pos = getPosition(e);

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
    shapeEnd = pos;
    render();
    const def = TOOL_DEFS[currentTool];
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
  } else if (activeStroke) {
    activeStroke.pts.push([pos.x, pos.y]);
  }
  lastX = pos.x;
  lastY = pos.y;
  render();
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
  activeStroke = null;
  saveUndoState();
  syncCurrentPage();
}

function syncCurrentPage() {
  commitCurrentPage();
  const thumbImg = pageStripInner.querySelectorAll('.page-thumb img')[currentPage];
  if (thumbImg) thumbImg.src = pages[currentPage].data;
  persistState();
}

// ─── Mouse events ───
canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', (e) => {
  draw(e);
  const pos = getPosition(e);
  statusCoords.textContent = `${Math.round(pos.x)}, ${Math.round(pos.y)}`;
  updateEraserCursor(pos);
  if (showsSelection() && !isDrawing) updateSelectCursor(pos);
});
canvas.addEventListener('mouseup', stopDraw);
canvas.addEventListener('mouseout', (e) => { stopDraw(e); hideEraserCursor(); });
canvas.addEventListener('dblclick', (e) => {
  const pos = getPosition(e);
  const box = boxAt(pos, 0);
  if (box) { selectOnly(box.id); openBoxEditor(box); }
});

// ─── Touch events ───
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDraw(e); });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  draw(e);
  updateEraserCursor(getPosition(e));
});
canvas.addEventListener('touchend', (e) => { stopDraw(e); hideEraserCursor(); });

// ─── Actions ───
function clearCanvas() {
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
});
resizeCanvas();

// ─── Initial render ───
buildPalette();
applyCanvasBg();
setColor(tpl().ink);
document.querySelectorAll('.template-item').forEach(el => {
  el.classList.toggle('active', el.dataset.template === template);
});
setTool('pen');
renderPageStrip();
