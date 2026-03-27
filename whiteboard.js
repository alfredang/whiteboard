// ─── DOM References ───
const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
const colorPicker = document.getElementById('colorPicker');
const brushSize = document.getElementById('brushSize');
const sizeValue = document.getElementById('sizeValue');
const statusMsg = document.getElementById('statusMsg');
const statusCoords = document.getElementById('statusCoords');
const toast = document.getElementById('toast');

const btnPen = document.getElementById('btnPen');
const btnEraser = document.getElementById('btnEraser');

// ─── State ───
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let currentTool = 'pen'; // 'pen' | 'eraser'
let undoStack = [];
const MAX_UNDO = 30;

// ─── Init Canvas ───
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.strokeStyle = colorPicker.value;
ctx.lineWidth = brushSize.value;

// Save initial blank state
saveUndoState();

// ─── Tool Switching ───
function setTool(tool) {
  currentTool = tool;
  btnPen.classList.toggle('active', tool === 'pen');
  btnEraser.classList.toggle('active', tool === 'eraser');
  canvas.classList.toggle('eraser-cursor', tool === 'eraser');

  if (tool === 'pen') {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = colorPicker.value;
  } else {
    ctx.globalCompositeOperation = 'destination-out';
  }
}

btnPen.addEventListener('click', () => setTool('pen'));
btnEraser.addEventListener('click', () => setTool('eraser'));

// ─── Brush Size ───
brushSize.addEventListener('input', () => {
  sizeValue.textContent = brushSize.value + 'px';
  ctx.lineWidth = brushSize.value;
});

// ─── Color Picker ───
colorPicker.addEventListener('input', () => {
  ctx.strokeStyle = colorPicker.value;
  document.getElementById('colorSwatch').style.background = colorPicker.value;
  if (currentTool === 'eraser') setTool('pen');
});

// ─── Undo State ───
function saveUndoState() {
  if (undoStack.length >= MAX_UNDO) undoStack.shift();
  undoStack.push(canvas.toDataURL());
}

function undo() {
  if (undoStack.length <= 1) return;
  undoStack.pop(); // remove current
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, 0, 0);
    if (currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
    }
  };
  img.src = undoStack[undoStack.length - 1];
  showToast('Undone');
}

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

// ─── Drawing ───
function startDraw(e) {
  isDrawing = true;
  const pos = getPosition(e);
  lastX = pos.x;
  lastY = pos.y;
  // Dot for single click
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
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  lastX = pos.x;
  lastY = pos.y;
}

function stopDraw() {
  if (isDrawing) {
    isDrawing = false;
    saveUndoState();
  }
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
  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  }
  saveUndoState();
  showToast('Canvas cleared');
}

function downloadCanvas() {
  const link = document.createElement('a');
  link.download = 'whiteboard-' + Date.now() + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast('Image saved');
}

// ─── Toast ───
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
}

// ─── Status flash ───
function flashStatus(msg) {
  statusMsg.textContent = msg;
  statusMsg.classList.add('flash');
  setTimeout(() => {
    statusMsg.textContent = 'Ready';
    statusMsg.classList.remove('flash');
  }, 2500);
}

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Z → undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undo();
  }
  // B → pen
  if (e.key === 'b' && !e.ctrlKey && !e.metaKey) setTool('pen');
  // E → eraser
  if (e.key === 'e' && !e.ctrlKey && !e.metaKey) setTool('eraser');
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
