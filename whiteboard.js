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
let lassoSnapshot = null; // ImageData of canvas before lasso preview
let previousTool = 'pen';

// ─── Pages ───
let pages = []; // each: { data: dataURL, undoStack: string[] }
let currentPage = 0;
const MAX_UNDO = 30;

// ─── Init Canvas ───
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.strokeStyle = colorPicker.value;
ctx.lineWidth = brushSize.value;

// Fill canvas background initially
ctx.fillStyle = canvasBgColor();
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = colorPicker.value;

// Create first page (after canvas is initialized)
pages.push({ data: canvas.toDataURL(), undoStack: [canvas.toDataURL()] });
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
  showToast('Page deleted');
}

function switchPage(index) {
  if (index === currentPage) return;
  saveCurrentPageData();
  currentPage = index;
  loadPage(index);
  renderPageStrip();
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
  canvas.classList.toggle('eraser-cursor', tool === 'eraser');
  canvas.classList.toggle('lasso-cursor', tool === 'lasso');

  if (tool === 'pen') {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = colorPicker.value;
  } else if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'source-over';
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
  const range = toolSizeRange[currentTool];
  brushSize.min = range.min;
  brushSize.max = range.max;
  brushSize.value = toolSizes[currentTool];
  sizeLabel.textContent = currentTool === 'pen' ? 'Pen' : 'Eraser';
  sizeValue.textContent = brushSize.value + 'px';
  ctx.lineWidth = brushSize.value;
}

btnPen.addEventListener('click', () => setTool('pen'));
btnEraser.addEventListener('click', () => setTool('eraser'));
btnLasso.addEventListener('click', () => setTool('lasso'));

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
  showToast(theme === 'light' ? 'Chalkboard mode' : 'Whiteboard mode');
}

btnTheme.addEventListener('click', toggleTheme);

// ─── Brush Size ───
brushSize.addEventListener('input', () => {
  const val = parseInt(brushSize.value, 10);
  if (currentTool === 'pen' || currentTool === 'eraser') {
    toolSizes[currentTool] = val;
  }
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
  if (!lassoSnapshot || lassoPoints.length < 2) return;
  // Restore the pre-lasso canvas state, then draw preview on top
  ctx.putImageData(lassoSnapshot, 0, 0);
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
  // Restore snapshot so preview is gone
  if (lassoSnapshot) ctx.putImageData(lassoSnapshot, 0, 0);

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
  lassoSnapshot = null;
  // Auto-revert to previous tool so user can keep drawing
  setTool(previousTool === 'lasso' ? 'pen' : previousTool);
}

// ─── Drawing ───
function startDraw(e) {
  const pos = getPosition(e);

  if (currentTool === 'lasso') {
    isDrawing = true;
    lassoSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    lassoPoints = [pos];
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

  saveUndoState();
  updateCurrentThumbnail();
}

function updateCurrentThumbnail() {
  const dataURL = canvas.toDataURL();
  pages[currentPage].data = dataURL;
  const thumbImg = pageStripInner.querySelectorAll('.page-thumb img')[currentPage];
  if (thumbImg) thumbImg.src = dataURL;
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
