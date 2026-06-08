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
const btnResetPages = document.getElementById('btnResetPages');

const btnSelect = document.getElementById('btnSelect');
const btnPen = document.getElementById('btnPen');
const btnEraser = document.getElementById('btnEraser');
const btnLasso = document.getElementById('btnLasso');
const btnLine = document.getElementById('btnLine');
const btnCircle = document.getElementById('btnCircle');
const btnRect = document.getElementById('btnRect');
const btnRoundRect = document.getElementById('btnRoundRect');
const btnDiamond = document.getElementById('btnDiamond');
const btnArrow = document.getElementById('btnArrow');
const btnTheme = document.getElementById('btnTheme');
const sizeLabel = document.getElementById('sizeLabel');
const shapeTextEditor = document.getElementById('shapeTextEditor');
const eraserCursor = document.getElementById('eraserCursor');

const W = canvas.width;
const H = canvas.height;

// Flowchart shape tools (drag to size). Box shapes also accept a text label.
const SHAPE_TOOLS = ['rect', 'roundrect', 'diamond', 'arrow'];
const TEXT_SHAPES = ['rect', 'roundrect', 'diamond'];
const SHAPE_FONT_PX = 22;
const SHAPE_FONT = `500 ${SHAPE_FONT_PX}px 'DM Sans', system-ui, -apple-system, sans-serif`;
const ACCENT = '#e87040';

let theme = 'dark'; // 'dark' = white canvas, 'light' = black canvas
function canvasBgColor() { return theme === 'dark' ? '#ffffff' : '#0c0c0f'; }

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

// Last pointer position over the canvas (for the eraser size indicator)
let lastPointer = null;

// Line / circle / shape drag state
let lineStart = null;
let shapeEnd = null;

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

// Selection / direct-manipulation state
let selectedId = null;
let dragState = null;
// Active flowchart text editor target (the box object) or null
let editing = null;
let editingBox = null;

const HANDLE_HIT = 13;   // hit radius (canvas px) for resize handles
const HANDLE_DRAW = 9;   // drawn handle square size
const SNAP_MARGIN = 12;  // how far outside a box an arrow endpoint still snaps

// ─── Pages ───
let pages = []; // each: { ink: dataURL, shapes: [...], data: dataURL, undoStack: [] }
let currentPage = 0;
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
        theme,
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
    if (s.type === 'arrow') continue;
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

// Topmost shape at a point (boxes by bounds, arrows by distance to the line).
function shapeAt(pos) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'arrow') {
      const [p1, p2] = arrowEnds(s);
      if (pointToSegment(pos.x, pos.y, p1.x, p1.y, p2.x, p2.y) <= 8) return s;
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
function strokeBoxPath(c, type, x, y, w, h) {
  c.beginPath();
  if (type === 'rect') {
    c.rect(x, y, w, h);
  } else if (type === 'roundrect') {
    const r = Math.min(40, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  } else if (type === 'diamond') {
    c.moveTo(x + w / 2, y);
    c.lineTo(x + w, y + h / 2);
    c.lineTo(x + w / 2, y + h);
    c.lineTo(x, y + h / 2);
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
  } else {
    strokeBox(c, s.type, s.x, s.y, s.w, s.h, s.color, s.lineWidth);
    if (s !== editingBox && s.text) fillBoxText(c, s.type, s.x, s.y, s.w, s.h, s.text, s.color);
  }
}

// ─── Compositing ───
function render() {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = canvasBgColor();
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(inkCanvas, 0, 0);
  for (const s of shapes) drawShape(ctx, s);
  if (currentTool === 'select' && selectedId) drawSelection();
}

function drawSelection() {
  const s = shapeById(selectedId);
  if (!s) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  if (s.type === 'arrow') {
    const [p1, p2] = arrowEnds(s);
    ctx.setLineDash([]);
    for (const p of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
    }
  } else {
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.setLineDash([]);
    for (const [cx, cy] of boxCorners(s)) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(cx - HANDLE_DRAW / 2, cy - HANDLE_DRAW / 2, HANDLE_DRAW, HANDLE_DRAW);
      ctx.strokeRect(cx - HANDLE_DRAW / 2, cy - HANDLE_DRAW / 2, HANDLE_DRAW, HANDLE_DRAW);
    }
  }
  ctx.restore();
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
  theme = persisted.theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('light-theme', theme === 'light');
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

function cloneShapes(arr) { return arr.map(s => ({ ...s })); }

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
  selectedId = null;
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
    thumb.addEventListener('click', () => switchPage(i));

    const img = document.createElement('img');
    img.src = page.data;
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

  const activeThumb = pageStripInner.querySelector('.page-thumb.active');
  if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  updateStatusPage();
}

btnAddPage.addEventListener('click', addPage);
btnResetPages.addEventListener('click', resetAllPages);

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
  selectedId = null;
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
  if (tool !== 'select') selectedId = null;
  currentTool = tool;

  btnSelect.classList.toggle('active', tool === 'select');
  btnPen.classList.toggle('active', tool === 'pen');
  btnEraser.classList.toggle('active', tool === 'eraser');
  btnLasso.classList.toggle('active', tool === 'lasso');
  btnLine.classList.toggle('active', tool === 'line');
  btnCircle.classList.toggle('active', tool === 'circle');
  btnRect.classList.toggle('active', tool === 'rect');
  btnRoundRect.classList.toggle('active', tool === 'roundrect');
  btnDiamond.classList.toggle('active', tool === 'diamond');
  btnArrow.classList.toggle('active', tool === 'arrow');

  canvas.classList.toggle('eraser-cursor', tool === 'eraser');
  canvas.classList.toggle('lasso-cursor', tool === 'lasso');
  canvas.classList.toggle('pen-cursor', tool === 'pen');
  canvas.classList.toggle('select-cursor', tool === 'select');
  canvas.classList.toggle('shape-cursor', SHAPE_TOOLS.includes(tool));
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
    pen: 'Pen', eraser: 'Eraser', line: 'Line', circle: 'Circle',
    rect: 'Box', roundrect: 'Rounded', diamond: 'Diamond', arrow: 'Arrow',
  };
  sizeLabel.textContent = labels[currentTool] || 'Size';
  sizeValue.textContent = brushSize.value + 'px';
}

btnSelect.addEventListener('click', () => setTool('select'));
btnPen.addEventListener('click', () => setTool('pen'));
btnEraser.addEventListener('click', () => setTool('eraser'));
btnLasso.addEventListener('click', () => setTool('lasso'));
btnLine.addEventListener('click', () => setTool('line'));
btnCircle.addEventListener('click', () => setTool('circle'));
btnRect.addEventListener('click', () => setTool('rect'));
btnRoundRect.addEventListener('click', () => setTool('roundrect'));
btnDiamond.addEventListener('click', () => setTool('diamond'));
btnArrow.addEventListener('click', () => setTool('arrow'));

// ─── Theme Toggle (inverts canvas: white ↔ black) ───
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

async function toggleTheme() {
  commitCurrentPage();

  theme = theme === 'dark' ? 'light' : 'dark';
  document.body.classList.toggle('light-theme', theme === 'light');

  for (const page of pages) {
    page.ink = await invertImageDataURL(page.ink);
    page.shapes.forEach(s => { s.color = invertHex(s.color); });
    page.undoStack = await Promise.all(page.undoStack.map(async (snap) => ({
      ink: await invertImageDataURL(snap.ink),
      shapes: snap.shapes.map(s => ({ ...s, color: invertHex(s.color) })),
    })));
  }

  // Flip default pen colour if user is still on the previous default
  if (colorPicker.value.toLowerCase() === (theme === 'light' ? '#000000' : '#ffffff')) {
    const inverted = theme === 'light' ? '#ffffff' : '#000000';
    colorPicker.value = inverted;
    document.getElementById('colorSwatch').style.background = inverted;
  }

  shapes = pages[currentPage].shapes;
  loadPage(currentPage);
  flattenAllThumbnails();
  renderPageStrip();
  persistState();
  showToast(theme === 'light' ? 'Chalkboard mode' : 'Whiteboard mode');
}

btnTheme.addEventListener('click', toggleTheme);

// ─── Brush Size ───
brushSize.addEventListener('input', () => {
  const val = parseInt(brushSize.value, 10);
  const key = currentTool === 'eraser' ? 'eraser' : 'pen';
  toolSizes[key] = val;
  sizeValue.textContent = val + 'px';
  if (currentTool === 'eraser' && lastPointer) updateEraserCursor(lastPointer);
});

// ─── Color Picker ───
colorPicker.addEventListener('input', () => {
  document.getElementById('colorSwatch').style.background = colorPicker.value;
  // Recolour the selected shape, if any
  if (currentTool === 'select' && selectedId) {
    const s = shapeById(selectedId);
    if (s) { s.color = colorPicker.value; render(); saveUndoState(); syncCurrentPage(); }
  }
  if (currentTool === 'eraser') setTool('pen');
});

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
  if (lassoPoints.length >= 3) {
    // Erase the enclosed ink (shapes are vector — delete them with Select).
    inkCtx.save();
    inkCtx.globalCompositeOperation = 'destination-out';
    inkCtx.beginPath();
    inkCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) inkCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    inkCtx.closePath();
    inkCtx.fill();
    inkCtx.restore();
    saveUndoState();
    syncCurrentPage();
    showToast('Region erased');
  }
  lassoPoints = [];
  render();
  setTool(previousTool === 'lasso' ? 'pen' : previousTool);
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
  selectedId = box.id;
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
  lineStart = null;
  shapeEnd = null;
  if (!start) { render(); return; }

  const size = Number(brushSize.value);

  if (tool === 'arrow') {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 6) { render(); return; }
    const from = boxAt(start, SNAP_MARGIN);
    const to = boxAt(end, SNAP_MARGIN);
    const s = {
      id: newId(), type: 'arrow',
      x1: start.x, y1: start.y, x2: end.x, y2: end.y,
      from: from ? from.id : null,
      to: to ? to.id : null,
      color: colorPicker.value, lineWidth: size,
    };
    shapes.push(s);
    selectedId = s.id;
    render();
    saveUndoState();
    syncCurrentPage();
    if (from || to) showToast('Arrow snapped to box');
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
    id: newId(), type: tool,
    x: b.x, y: b.y, w: b.w, h: b.h,
    text: '', color: colorPicker.value, lineWidth: size,
  };
  shapes.push(s);
  render();
  openBoxEditor(s);
}

// ─── Select / Move / Resize interactions ───
function startSelect(pos) {
  const sel = selectedId ? shapeById(selectedId) : null;
  if (sel && sel.type !== 'arrow') {
    const h = handleAt(pos, sel);
    if (h) { dragState = { mode: 'resize', box: sel, handle: h, moved: false }; return; }
  }

  const hit = shapeAt(pos);
  if (hit) {
    selectedId = hit.id;
    if (hit.type === 'arrow') {
      dragState = {
        mode: 'arrowmove', shape: hit, start: pos,
        orig: { x1: hit.x1, y1: hit.y1, x2: hit.x2, y2: hit.y2 }, moved: false,
      };
    } else {
      dragState = { mode: 'move', box: hit, start: pos, orig: { x: hit.x, y: hit.y }, moved: false };
    }
  } else {
    selectedId = null;
    dragState = null;
  }
  render();
}

function moveSelect(pos) {
  if (!dragState) return;
  dragState.moved = true;
  if (dragState.mode === 'move') {
    const b = dragState.box;
    b.x = dragState.orig.x + (pos.x - dragState.start.x);
    b.y = dragState.orig.y + (pos.y - dragState.start.y);
  } else if (dragState.mode === 'arrowmove') {
    const s = dragState.shape;
    // Translating an arrow detaches it so it stays where you drop it.
    s.from = null; s.to = null;
    const dx = pos.x - dragState.start.x, dy = pos.y - dragState.start.y;
    s.x1 = dragState.orig.x1 + dx; s.y1 = dragState.orig.y1 + dy;
    s.x2 = dragState.orig.x2 + dx; s.y2 = dragState.orig.y2 + dy;
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
  const sel = selectedId ? shapeById(selectedId) : null;
  if (sel && sel.type !== 'arrow') {
    const h = handleAt(pos, sel);
    if (h === 'nw' || h === 'se') { canvas.style.cursor = 'nwse-resize'; return; }
    if (h === 'ne' || h === 'sw') { canvas.style.cursor = 'nesw-resize'; return; }
  }
  canvas.style.cursor = shapeAt(pos) ? 'move' : 'default';
}

function deleteSelected() {
  if (!selectedId) return;
  const i = shapes.findIndex(s => s.id === selectedId);
  if (i < 0) return;
  const removed = shapes[i];
  shapes.splice(i, 1);
  // Detach any arrows that were bound to the removed box.
  shapes.forEach(s => {
    if (s.type === 'arrow') {
      if (s.from === removed.id) s.from = null;
      if (s.to === removed.id) s.to = null;
    }
  });
  selectedId = null;
  render();
  saveUndoState();
  syncCurrentPage();
  showToast('Deleted');
}

// ─── Drawing dispatch ───
function startDraw(e) {
  if (editing) { commitTextEditor(); return; }
  const pos = getPosition(e);

  if (currentTool === 'select') {
    isDrawing = true;
    startSelect(pos);
    return;
  }

  if (currentTool === 'lasso') {
    isDrawing = true;
    lassoPoints = [pos];
    return;
  }

  if (currentTool === 'line' || currentTool === 'circle' || SHAPE_TOOLS.includes(currentTool)) {
    isDrawing = true;
    lineStart = pos;
    shapeEnd = pos;
    return;
  }

  // pen / eraser — draw directly onto the ink layer
  isDrawing = true;
  lastX = pos.x;
  lastY = pos.y;
  if (currentTool === 'eraser') {
    inkCtx.globalCompositeOperation = 'destination-out';
    inkCtx.lineWidth = toolSizes.eraser;
    inkCtx.beginPath();
    inkCtx.arc(pos.x, pos.y, toolSizes.eraser / 2, 0, Math.PI * 2);
    inkCtx.fill();
  } else {
    inkCtx.globalCompositeOperation = 'source-over';
    inkCtx.strokeStyle = colorPicker.value;
    inkCtx.fillStyle = colorPicker.value;
    inkCtx.lineWidth = toolSizes.pen;
    inkCtx.beginPath();
    inkCtx.arc(pos.x, pos.y, toolSizes.pen / 2, 0, Math.PI * 2);
    inkCtx.fill();
  }
  render();
}

function draw(e) {
  if (!isDrawing) return;
  const pos = getPosition(e);

  if (currentTool === 'select') { moveSelect(pos); return; }

  if (currentTool === 'lasso') {
    const last = lassoPoints[lassoPoints.length - 1];
    if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) > 2) lassoPoints.push(pos);
    render();
    drawLassoPreview();
    return;
  }

  if (currentTool === 'line') {
    shapeEnd = pos;
    render();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = colorPicker.value;
    ctx.lineWidth = toolSizes.pen;
    ctx.beginPath();
    ctx.moveTo(lineStart.x, lineStart.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (currentTool === 'circle') {
    shapeEnd = pos;
    render();
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = colorPicker.value;
    ctx.lineWidth = toolSizes.pen;
    const cx = (lineStart.x + pos.x) / 2;
    const cy = (lineStart.y + pos.y) / 2;
    const rx = Math.abs(pos.x - lineStart.x) / 2;
    const ry = Math.abs(pos.y - lineStart.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (SHAPE_TOOLS.includes(currentTool)) {
    shapeEnd = pos;
    render();
    const size = Number(brushSize.value);
    if (currentTool === 'arrow') {
      strokeArrow(ctx, lineStart.x, lineStart.y, pos.x, pos.y, colorPicker.value, size);
      const target = boxAt(pos, SNAP_MARGIN);
      if (target) highlightBox(target);
    } else {
      const b = normBounds(lineStart.x, lineStart.y, pos.x, pos.y);
      strokeBox(ctx, currentTool, b.x, b.y, b.w, b.h, colorPicker.value, size);
    }
    return;
  }

  // pen / eraser
  inkCtx.beginPath();
  inkCtx.moveTo(lastX, lastY);
  inkCtx.lineTo(pos.x, pos.y);
  inkCtx.stroke();
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
  if (currentTool === 'lasso') { commitLasso(); return; }
  if (SHAPE_TOOLS.includes(currentTool)) { finishShape(); return; }

  if (currentTool === 'line' || currentTool === 'circle') {
    // Commit the preview onto the ink layer.
    inkCtx.save();
    inkCtx.globalCompositeOperation = 'source-over';
    inkCtx.strokeStyle = colorPicker.value;
    inkCtx.lineWidth = toolSizes.pen;
    const end = shapeEnd || lineStart;
    if (currentTool === 'line') {
      inkCtx.beginPath();
      inkCtx.moveTo(lineStart.x, lineStart.y);
      inkCtx.lineTo(end.x, end.y);
      inkCtx.stroke();
    } else {
      const cx = (lineStart.x + end.x) / 2;
      const cy = (lineStart.y + end.y) / 2;
      const rx = Math.abs(end.x - lineStart.x) / 2;
      const ry = Math.abs(end.y - lineStart.y) / 2;
      if (rx > 0.5 && ry > 0.5) {
        inkCtx.beginPath();
        inkCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        inkCtx.stroke();
      }
    }
    inkCtx.restore();
    lineStart = null;
    shapeEnd = null;
    render();
    saveUndoState();
    syncCurrentPage();
    return;
  }

  // pen / eraser already committed to the ink layer
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
  if (currentTool === 'select' && !isDrawing) updateSelectCursor(pos);
});
canvas.addEventListener('mouseup', stopDraw);
canvas.addEventListener('mouseout', (e) => { stopDraw(e); hideEraserCursor(); });
canvas.addEventListener('dblclick', (e) => {
  const pos = getPosition(e);
  const box = boxAt(pos, 0);
  if (box) { selectedId = box.id; openBoxEditor(box); }
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
  selectedId = null;
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

  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
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
  if (e.key === 'i') setTool('line');
  if (e.key === 'o') setTool('circle');
  if (e.key === 'r') setTool('rect');
  if (e.key === 'g') setTool('roundrect');
  if (e.key === 'd') setTool('diamond');
  if (e.key === 'a') setTool('arrow');
  if (e.key === 't') toggleTheme();

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
setTool('pen');
renderPageStrip();
