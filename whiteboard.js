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

const btnPen = document.getElementById('btnPen');
const btnEraser = document.getElementById('btnEraser');
const btnLasso = document.getElementById('btnLasso');
const btnLine = document.getElementById('btnLine');
const btnCircle = document.getElementById('btnCircle');
const btnTheme = document.getElementById('btnTheme');
const sizeLabel = document.getElementById('sizeLabel');

let theme = 'dark'; // 'dark' = white canvas, 'light' = black canvas
function canvasBgColor() { return theme === 'dark' ? '#ffffff' : '#0c0c0f'; }

// ─── State ───
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let currentTool = 'pen'; // 'pen' | 'eraser' | 'lasso'

// Per-tool sizes
const toolSizes = { pen: 4, eraser: 20 };
const toolSizeRange = { pen: { min: 1, max: 50 }, eraser: { min: 5, max: 120 } };

// Lasso state
let lassoPoints = [];
let previousTool = 'pen';

// Line / circle state
let lineStart = null;

// Offscreen snapshot canvas used to restore the pre-shape state each frame
const snapCanvas = document.createElement('canvas');
snapCanvas.width = canvas.width;
snapCanvas.height = canvas.height;
const snapCtx = snapCanvas.getContext('2d');
let hasSnapshot = false;

function takeSnapshot() {
  snapCtx.clearRect(0, 0, snapCanvas.width, snapCanvas.height);
  snapCtx.drawImage(canvas, 0, 0);
  hasSnapshot = true;
}
function restoreSnapshot() {
  if (!hasSnapshot) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(snapCanvas, 0, 0);
  ctx.restore();
}

// ─── Pages ───
let pages = []; // each: { data: dataURL, undoStack: string[] }
let currentPage = 0;
const MAX_UNDO = 30;
const STORAGE_KEY = 'whiteboard.state.v1';

let saveTimer;
function persistState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const payload = {
        theme,
        currentPage,
        pages: pages.map(p => ({ data: p.data })),
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

// ─── Init Canvas ───
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.strokeStyle = colorPicker.value;
ctx.lineWidth = brushSize.value;

// Fill canvas background initially
ctx.fillStyle = canvasBgColor();
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = colorPicker.value;

// Restore from localStorage if present, otherwise create a blank first page
const persisted = loadPersistedState();
if (persisted) {
  theme = persisted.theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('light-theme', theme === 'light');
  // Re-paint background to match restored theme before loading page bitmaps
  ctx.fillStyle = canvasBgColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  pages = persisted.pages.map(p => ({ data: p.data, undoStack: [p.data] }));
  currentPage = Math.min(persisted.currentPage || 0, pages.length - 1);
  loadPage(currentPage);
} else {
  pages.push({ data: canvas.toDataURL(), undoStack: [canvas.toDataURL()] });
}
renderPageStrip();

// ─── Page Management ───
function addPage() {
  // Save current page before adding
  saveCurrentPageData();

  const blankData = createBlankDataURL();
  pages.push({ data: blankData, undoStack: [blankData] });

  currentPage = pages.length - 1;
  loadPage(currentPage);
  renderPageStrip();
  persistState();
  showToast(`Page ${pages.length} added`);
}

function deletePage(index) {
  if (pages.length <= 1) {
    showToast('Need at least one page');
    return;
  }

  pages.splice(index, 1);

  if (currentPage >= pages.length) {
    currentPage = pages.length - 1;
  } else if (currentPage > index) {
    currentPage--;
  }

  loadPage(currentPage);
  renderPageStrip();
  persistState();
  showToast('Page deleted');
}

function switchPage(index) {
  if (index === currentPage) return;
  saveCurrentPageData();
  currentPage = index;
  loadPage(index);
  renderPageStrip();
  persistState();
}

function saveCurrentPageData() {
  const dataURL = canvas.toDataURL();
  pages[currentPage].data = dataURL;
}

function loadPage(index) {
  const page = pages[index];
  const img = new Image();
  img.onload = () => {
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
    }
  };
  img.src = page.data;
  updateStatusPage();
}

function createBlankDataURL() {
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.fillStyle = canvasBgColor();
  tmpCtx.fillRect(0, 0, tmp.width, tmp.height);
  return tmp.toDataURL();
}

function updateStatusPage() {
  statusMsg.textContent = `Page ${currentPage + 1} of ${pages.length}`;
}

// ─── Page Strip Rendering ───
function renderPageStrip() {
  // Save current before rendering thumbnails
  if (pages.length > 0) {
    pages[currentPage].data = canvas.toDataURL();
  }

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
      del.textContent = '\u00d7';
      del.title = 'Delete page';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePage(i);
      });
      thumb.appendChild(del);
    }

    pageStripInner.appendChild(thumb);
  });

  // Scroll active into view
  const activeThumb = pageStripInner.querySelector('.page-thumb.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  updateStatusPage();
}

btnAddPage.addEventListener('click', addPage);

// ─── Undo (per-page) ───
function saveUndoState() {
  const page = pages[currentPage];
  if (page.undoStack.length >= MAX_UNDO) page.undoStack.shift();
  page.undoStack.push(canvas.toDataURL());
}

function undo() {
  const page = pages[currentPage];
  if (page.undoStack.length <= 1) return;
  page.undoStack.pop();
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, 0, 0);
    if (currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
    }
    updateCurrentThumbnail();
  };
  img.src = page.undoStack[page.undoStack.length - 1];
  showToast('Undone');
}

// ─── Tool Switching ───
function setTool(tool) {
  if (tool === 'lasso' && currentTool !== 'lasso') {
    previousTool = currentTool;
  }
  currentTool = tool;
  btnPen.classList.toggle('active', tool === 'pen');
  btnEraser.classList.toggle('active', tool === 'eraser');
  btnLasso.classList.toggle('active', tool === 'lasso');
  btnLine.classList.toggle('active', tool === 'line');
  btnCircle.classList.toggle('active', tool === 'circle');
  canvas.classList.toggle('eraser-cursor', tool === 'eraser');
  canvas.classList.toggle('lasso-cursor', tool === 'lasso');

  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    // pen / line / circle / lasso
    ctx.globalCompositeOperation = 'source-over';
    if (tool !== 'lasso') ctx.strokeStyle = colorPicker.value;
  }

  syncSizeControl();
}

function syncSizeControl() {
  if (currentTool === 'lasso') {
    sizeLabel.textContent = 'Lasso';
    brushSize.disabled = true;
    sizeValue.textContent = '—';
    return;
  }
  brushSize.disabled = false;
  // line/circle share pen's size settings
  const sizeKey = (currentTool === 'eraser') ? 'eraser' : 'pen';
  const range = toolSizeRange[sizeKey];
  brushSize.min = range.min;
  brushSize.max = range.max;
  brushSize.value = toolSizes[sizeKey];
  const labels = { pen: 'Pen', eraser: 'Eraser', line: 'Line', circle: 'Circle' };
  sizeLabel.textContent = labels[currentTool] || 'Size';
  sizeValue.textContent = brushSize.value + 'px';
  ctx.lineWidth = brushSize.value;
}

btnPen.addEventListener('click', () => setTool('pen'));
btnEraser.addEventListener('click', () => setTool('eraser'));
btnLasso.addEventListener('click', () => setTool('lasso'));
btnLine.addEventListener('click', () => setTool('line'));
btnCircle.addEventListener('click', () => setTool('circle'));

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
        d[i]     = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
      tctx.putImageData(id, 0, 0);
      resolve(tmp.toDataURL());
    };
    img.src = dataURL;
  });
}

async function toggleTheme() {
  // Persist the on-screen canvas into the current page before inverting
  saveCurrentPageData();

  theme = theme === 'dark' ? 'light' : 'dark';
  document.body.classList.toggle('light-theme', theme === 'light');

  // Invert every page's bitmap AND its undo stack
  for (const page of pages) {
    page.data = await invertImageDataURL(page.data);
    page.undoStack = await Promise.all(page.undoStack.map(invertImageDataURL));
  }

  // Flip default pen color if user is still on the previous default
  if (colorPicker.value.toLowerCase() === (theme === 'light' ? '#000000' : '#ffffff')) {
    const inverted = theme === 'light' ? '#ffffff' : '#000000';
    colorPicker.value = inverted;
    ctx.strokeStyle = inverted;
    document.getElementById('colorSwatch').style.background = inverted;
  }

  loadPage(currentPage);
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
  ctx.lineWidth = val;
});

// ─── Color Picker ───
colorPicker.addEventListener('input', () => {
  ctx.strokeStyle = colorPicker.value;
  document.getElementById('colorSwatch').style.background = colorPicker.value;
  if (currentTool === 'eraser') setTool('pen');
});

// ─── Position Helper ───
function getPosition(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

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

// ─── Lasso (preview drawn directly on main canvas) ───
function drawLassoPreview() {
  if (lassoPoints.length < 2) return;
  restoreSnapshot();
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = '#e87040';
  ctx.fillStyle = 'rgba(232, 112, 64, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
  for (let i = 1; i < lassoPoints.length; i++) {
    ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function commitLasso() {
  // Restore pre-lasso state to remove the preview overlay
  restoreSnapshot();

  if (lassoPoints.length >= 3) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
      ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = canvasBgColor();
    ctx.fill();
    ctx.restore();
    saveUndoState();
    updateCurrentThumbnail();
    showToast('Region deleted');
  }

  lassoPoints = [];
  hasSnapshot = false;
  // Auto-revert to previous tool so user can keep drawing
  setTool(previousTool === 'lasso' ? 'pen' : previousTool);
}

// ─── Drawing ───
function startDraw(e) {
  const pos = getPosition(e);

  if (currentTool === 'lasso') {
    isDrawing = true;
    takeSnapshot();
    lassoPoints = [pos];
    return;
  }

  if (currentTool === 'line' || currentTool === 'circle') {
    isDrawing = true;
    lineStart = pos;
    takeSnapshot();
    return;
  }

  isDrawing = true;
  lastX = pos.x;
  lastY = pos.y;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, ctx.lineWidth / 2, 0, Math.PI * 2);
  if (currentTool === 'pen') {
    ctx.fillStyle = ctx.strokeStyle;
  }
  ctx.fill();
}

function draw(e) {
  if (!isDrawing) return;
  const pos = getPosition(e);

  if (currentTool === 'lasso') {
    const last = lassoPoints[lassoPoints.length - 1];
    if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) > 2) {
      lassoPoints.push(pos);
      drawLassoPreview();
    }
    return;
  }

  if (currentTool === 'line') {
    restoreSnapshot();
    ctx.beginPath();
    ctx.moveTo(lineStart.x, lineStart.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    return;
  }

  if (currentTool === 'circle') {
    restoreSnapshot();
    const cx = (lineStart.x + pos.x) / 2;
    const cy = (lineStart.y + pos.y) / 2;
    const rx = Math.abs(pos.x - lineStart.x) / 2;
    const ry = Math.abs(pos.y - lineStart.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  lastX = pos.x;
  lastY = pos.y;
}

function stopDraw() {
  if (!isDrawing) return;
  isDrawing = false;

  if (currentTool === 'lasso') {
    commitLasso();
    return;
  }

  if (currentTool === 'line' || currentTool === 'circle') {
    lineStart = null;
    hasSnapshot = false;
  }

  saveUndoState();
  updateCurrentThumbnail();
}

function updateCurrentThumbnail() {
  const dataURL = canvas.toDataURL();
  pages[currentPage].data = dataURL;
  const thumbImg = pageStripInner.querySelectorAll('.page-thumb img')[currentPage];
  if (thumbImg) thumbImg.src = dataURL;
  persistState();
}

// Mouse events
canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', (e) => {
  draw(e);
  const pos = getPosition(e);
  statusCoords.textContent = `${Math.round(pos.x)}, ${Math.round(pos.y)}`;
});
canvas.addEventListener('mouseup', stopDraw);
canvas.addEventListener('mouseout', stopDraw);

// Touch events
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDraw(e); });
canvas.addEventListener('touchmove', (e) => { e.preventDefault(); draw(e); });
canvas.addEventListener('touchend', stopDraw);

// ─── Actions ───
function clearCanvas() {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = canvasBgColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  }
  saveUndoState();
  updateCurrentThumbnail();
  showToast('Page cleared');
}

function exportPDF() {
  // Save current page first
  saveCurrentPageData();

  const { jsPDF } = window.jspdf;
  // Landscape orientation matching canvas aspect ratio
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [canvas.width, canvas.height] });

  pages.forEach((page, i) => {
    if (i > 0) pdf.addPage([canvas.width, canvas.height], 'landscape');
    pdf.addImage(page.data, 'PNG', 0, 0, canvas.width, canvas.height);
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
  }
  if (e.key === 'b' && !e.ctrlKey && !e.metaKey) setTool('pen');
  if (e.key === 'e' && !e.ctrlKey && !e.metaKey) setTool('eraser');
  if (e.key === 'l' && !e.ctrlKey && !e.metaKey) setTool('lasso');
  if (e.key === 'i' && !e.ctrlKey && !e.metaKey) setTool('line');
  if (e.key === 'o' && !e.ctrlKey && !e.metaKey) setTool('circle');
  if (e.key === 't' && !e.ctrlKey && !e.metaKey) toggleTheme();

  // Page navigation: PgUp/PgDn or Ctrl+Left/Right
  if (e.key === 'PageUp' || ((e.ctrlKey || e.metaKey) && e.key === 'ArrowLeft')) {
    e.preventDefault();
    if (currentPage > 0) switchPage(currentPage - 1);
  }
  if (e.key === 'PageDown' || ((e.ctrlKey || e.metaKey) && e.key === 'ArrowRight')) {
    e.preventDefault();
    if (currentPage < pages.length - 1) switchPage(currentPage + 1);
  }
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

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Initial render ───
renderPageStrip();
