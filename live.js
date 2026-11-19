// ─── Live sessions ───
// Share the board between devices in real time: start a session on the
// classroom PC, scan the QR code with an iPad, and draw there with the Pencil.
//
// The board lives in Firebase Realtime Database under rooms/<CODE>:
//   meta/created            when the room was made (rooms lock after 48 hours)
//   order                   page ids, comma separated, in strip order
//   sp                      "<surface>|<pattern>"
//   cur                     id of the page on screen (every device follows it)
//   presence/<client>       one entry per connected device
//   pages/<pageId>/shapes/<shapeId>   one record per stroke or shape
//   pages/<pageId>/ink      bitmap ink from boards saved by older versions
//
// Each stroke or shape is its own record, so two devices can draw at once and
// only the changed records travel. This file is a classic script that shares
// the globals of whiteboard.js; the Firebase SDK is loaded on first use.
(function () {
  'use strict';

  const FIREBASE_VERSION = '12.12.1';
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyAoDxBDRC6AOvQ_vfZBVPwSso4iE1kyfFM',
    authDomain: 'edtools-whiteboard-asia.firebaseapp.com',
    databaseURL: 'https://edtools-whiteboard-asia-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'edtools-whiteboard-asia',
    storageBucket: 'edtools-whiteboard-asia.firebasestorage.app',
    messagingSenderId: '495817066410',
    appId: '1:495817066410:web:781b3a669cdd4af0bc0dd3',
  };
  const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  const CODE_RE = /^[A-Z2-9]{6}$/;
  const HOST_KEY = 'whiteboard.live.host';
  const LIVE_TICK_MS = 60;

  let fb = null;        // Firebase database functions, once loaded
  let db = null;
  let room = null;      // { code, host, ref, subs: Map(pageId → [unsub]), unsubs: [], ready }
  let synced = new Map(); // pageId → Map(shapeId → signature of what the room holds)
  let orderSynced = '';
  let spSynced = '';
  let curSynced = '';
  let pendingCur = null;  // a page switch from another device, waiting for a quiet moment
  let lastCurId = null;
  let flushQueued = false;
  let liveSentN = 0;      // points of the in-progress stroke already sent
  let liveSentFor = null;
  let tickTimer = null;
  let deviceCount = 0;
  let online = false;

  // ─── Wire format ───
  // Points travel as one compact string ("x,y,p;x,y,p") instead of nested
  // arrays, which the database would store as one node per number.
  function encPts(pts) { return pts.map(p => p.join(',')).join(';'); }
  function decPts(str) { return str ? str.split(';').map(t => t.split(',').map(Number)) : []; }

  function toWire(s) {
    const o = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (v == null || k === 'id') continue;
      if (typeof v === 'number' && !isFinite(v)) continue;
      if (k === 'pts') o.p = encPts(v);
      else o[k] = v;
    }
    return o;
  }

  function fromWire(o, id) {
    const s = { id };
    for (const k of Object.keys(o)) {
      if (k === 'by' || k === 'live') continue;
      if (k === 'p') s.pts = decPts(o.p);
      else s[k] = o[k];
    }
    if (s.type === 'stroke' && !s.pts) s.pts = [];
    return s;
  }

  // Order-independent fingerprint of a wire record (who wrote it left out).
  function sig(o) {
    return JSON.stringify(Object.keys(o).filter(k => k !== 'by' && k !== 'live').sort().map(k => [k, o[k]]));
  }

  // Every shape carries `z`, its stacking position. New shapes go on top
  // (timestamp); a shape that appears mid-list (an eraser fragment) slots
  // between its neighbours.
  function ensureZ(arr) {
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (typeof s.z !== 'number') {
        let next = null;
        for (let j = i + 1; j < arr.length; j++) {
          if (typeof arr[j].z === 'number') { next = arr[j].z; break; }
        }
        if (next !== null && (prev === null || next > prev)) s.z = prev === null ? next - 1 : (prev + next) / 2;
        else s.z = Math.max(Date.now(), prev === null ? 0 : prev + 1);
      }
      prev = s.z;
    }
  }

  function syncedMap(pageId) {
    let m = synced.get(pageId);
    if (!m) { m = new Map(); synced.set(pageId, m); }
    return m;
  }

  function pageById(id) { return pages.find(p => p.id === id); }
  function shapePath(pageId, shapeId) { return `pages/${pageId}/shapes/${shapeId}`; }

  // ─── Local → room ───
  function localChanged() {
    if (!room || !room.ready || flushQueued) return;
    flushQueued = true;
    queueMicrotask(flush);
  }

  function diffPage(page, up) {
    ensureZ(page.shapes);
    const m = syncedMap(page.id);
    const seen = new Set();
    for (const s of page.shapes) {
      seen.add(s.id);
      const w = toWire(s);
      const inProgress = s === activeStroke;
      const g = sig(w) + (inProgress ? '~' : '');
      if (m.get(s.id) === g) continue;
      m.set(s.id, g);
      w.by = CLIENT_TAG;
      if (inProgress) w.live = 1;
      up[shapePath(page.id, s.id)] = w;
    }
    for (const id of [...m.keys()]) {
      if (!seen.has(id)) { m.delete(id); up[shapePath(page.id, id)] = null; }
    }
  }

  function flush() {
    flushQueued = false;
    if (!room || !room.ready) return;
    const up = {};

    const ids = pages.map(p => p.id);
    const order = ids.join(',');
    if (order !== orderSynced) {
      up.order = order;
      orderSynced = order;
      for (const id of [...synced.keys()]) {
        if (!ids.includes(id)) { up[`pages/${id}`] = null; synced.delete(id); }
      }
      for (const id of [...room.subs.keys()]) if (!ids.includes(id)) unsubPage(id);
      ids.forEach(subPage);
    }

    const sp = surface + '|' + pattern;
    if (sp !== spSynced) { up.sp = sp; spSynced = sp; }

    const cur = pages[currentPage].id;
    if (pendingCur === null && cur !== curSynced) { up.cur = cur; curSynced = cur; }

    pages.forEach((page, i) => {
      // The page on screen is checked every time; any other page only when
      // something replaced or flagged its contents.
      if (i === currentPage || page.id === lastCurId || page.liveDirty || page.shapes !== page.liveRef) {
        diffPage(page, up);
        page.liveDirty = false;
        page.liveRef = page.shapes;
      }
      if (page.inkDirty && page.hasInk) {
        page.inkDirty = false;
        page.inkSent = page.ink;
        up[`pages/${page.id}/ink`] = page.ink;
      }
    });
    lastCurId = cur;

    if (Object.keys(up).length) fb.update(room.ref, up).catch(onWriteError);
  }

  // Stream the stroke being drawn so the other screen sees it grow, and pick
  // up page switches that arrived mid-stroke.
  function tick() {
    if (!room || !room.ready) return;
    if (pendingCur !== null) followCur();
    if (!isDrawing || !activeStroke || currentTool !== 'pen') { liveSentFor = null; return; }
    const n = activeStroke.pts.length;
    if (liveSentFor === activeStroke && liveSentN === n) return;
    liveSentFor = activeStroke;
    liveSentN = n;
    const page = pages[currentPage];
    ensureZ(page.shapes);
    const w = toWire(activeStroke);
    syncedMap(page.id).set(activeStroke.id, sig(w) + '~');
    w.by = CLIENT_TAG;
    w.live = 1;
    fb.update(room.ref, { [shapePath(page.id, activeStroke.id)]: w }).catch(onWriteError);
  }

  function onWriteError(err) {
    if (!room) return;
    console.warn('[live] write failed', err);
    if (String(err && err.code).toLowerCase().includes('permission')) {
      leave('This live session has expired');
    }
  }

  // ─── Room → local ───
  const touchedPages = new Set();   // pages changed by another device since the last batch
  const committedPages = new Set(); // …of which these got a finished (not in-progress) change
  let batchQueued = false;
  let thumbTimer = null;
  const thumbPages = new Set();
  let saveLaterTimer = null;

  function touched(page, inProgress) {
    touchedPages.add(page);
    if (!inProgress) committedPages.add(page);
    if (batchQueued) return;
    batchQueued = true;
    setTimeout(applyBatch, 0);
  }

  function applyBatch() {
    batchQueued = false;
    if (!room) { touchedPages.clear(); committedPages.clear(); return; }
    const cur = pages[currentPage];
    if (touchedPages.has(cur)) { invalidatePenLayer(); scheduleRender(); }
    for (const page of committedPages) {
      if (!pages.includes(page)) continue;
      pushRemoteUndo(page);
      thumbPages.add(page);
    }
    touchedPages.clear();
    committedPages.clear();
    if (thumbPages.size) {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(refreshThumbs, 500);
      clearTimeout(saveLaterTimer);
      saveLaterTimer = setTimeout(saveLater, 900);
    }
  }

  function stripZ(k, v) { return k === 'z' ? undefined : v; }
  function sameShapes(a, b) {
    if (a.length !== b.length) return false;
    return JSON.stringify(a, stripZ) === JSON.stringify(b, stripZ);
  }

  // Undo is shared: a change made on another device becomes a step in this
  // device's undo history too, so Ctrl+Z here takes back the last stroke drawn
  // on the iPad. If the change was itself an undo, step back instead.
  function pushRemoteUndo(page) {
    const st = page.undoStack;
    const now = page.shapes;
    // Until a page has finished downloading, what arrives is its starting
    // state, not something to undo back past.
    if (!page.liveLoaded) { page.undoStack = [{ ink: page.ink, shapes: cloneShapes(now) }]; return; }
    if (st.length >= 2 && sameShapes(st[st.length - 2].shapes, now)) { st.pop(); return; }
    if (st.length && sameShapes(st[st.length - 1].shapes, now)) return;
    if (st.length >= MAX_UNDO) st.shift();
    st.push({ ink: page.ink, shapes: cloneShapes(now) });
  }

  function refreshThumbs() {
    const imgs = pageStripInner.querySelectorAll('.page-thumb img');
    for (const page of thumbPages) {
      const i = pages.indexOf(page);
      if (i === -1) continue;
      if (i === currentPage) {
        page.data = flattenCurrentSync();
        if (imgs[i]) imgs[i].src = page.data;
        continue;
      }
      const img = new Image();
      img.onload = () => {
        page.data = flattenInkAndShapes(img, page.shapes);
        const el = pageStripInner.querySelectorAll('.page-thumb img')[pages.indexOf(page)];
        if (el) el.src = page.data;
      };
      img.src = page.ink;
    }
    thumbPages.clear();
  }

  // Keep the host's saved board in step with what other devices drew.
  function saveLater() {
    if (!room || !room.host) return;
    if (isDrawing || editing) { saveLaterTimer = setTimeout(saveLater, 900); return; }
    commitCurrentPage();
    persistState();
  }

  function remoteShape(pageId, key, val) {
    if (!room || !val || val.by === CLIENT_TAG) return; // our own write coming back
    const page = pageById(pageId);
    if (!page) return;
    const inProgress = !!val.live;
    const m = syncedMap(pageId);
    const g = sig(val);
    if (m.get(key) === g) { if (!inProgress) touched(page, false); return; }
    m.set(key, g);
    const s = fromWire(val, key);
    const arr = page.shapes;
    const i = arr.findIndex(x => x.id === key);
    if (i !== -1) {
      // Update in place: a drag or selection may be holding this object.
      const o = arr[i];
      for (const k of Object.keys(o)) delete o[k];
      Object.assign(o, s);
    } else {
      const j = arr.findIndex(x => typeof x.z !== 'number' || x.z > s.z);
      if (j === -1) arr.push(s); else arr.splice(j, 0, s);
    }
    touched(page, inProgress);
  }

  function remoteGone(pageId, key) {
    if (!room) return;
    const page = pageById(pageId);
    if (!page) return;
    syncedMap(pageId).delete(key);
    const arr = page.shapes;
    const i = arr.findIndex(x => x.id === key);
    if (i === -1 || arr[i] === activeStroke) return;
    arr.splice(i, 1);
    if (page === pages[currentPage] && isSelected(key)) selectedIds = selectedIds.filter(id => id !== key);
    touched(page, false);
  }

  function remoteInk(pageId, val) {
    if (!room || !val) return;
    const page = pageById(pageId);
    if (!page || val === page.inkSent) return;
    page.inkSent = val;
    page.ink = val;
    page.hasInk = true;
    page.inkDirty = false;
    if (page === pages[currentPage] && !isDrawing) {
      const img = new Image();
      img.onload = () => {
        inkCtx.clearRect(0, 0, W, H);
        inkCtx.drawImage(img, 0, 0, W, H);
        render();
      };
      img.src = val;
    }
    touched(page, false);
  }

  function blankPage(id) {
    const page = makeBlankPage();
    page.id = id;
    page.liveRef = page.shapes;
    return page;
  }

  function remoteOrder(str) {
    if (!room) return;
    if (str == null) { leave('The live session has ended'); return; }
    if (str === orderSynced) return;
    orderSynced = str;
    const ids = str.split(',').filter(Boolean);
    if (!ids.length) return;
    const curPage = pages[currentPage];
    if (editing) cancelTextEditor();
    const stays = ids.includes(curPage.id);
    if (isDrawing && !stays) abortDraw();
    if (!isDrawing) commitCurrentPage();
    const known = new Map(pages.map(p => [p.id, p]));
    for (const p of pages) {
      if (!ids.includes(p.id)) { unsubPage(p.id); synced.delete(p.id); }
    }
    pages = ids.map(id => known.get(id) || blankPage(id));
    if (stays) {
      currentPage = pages.indexOf(curPage);
    } else {
      currentPage = Math.min(currentPage, pages.length - 1);
      loadPage(currentPage);
    }
    ids.forEach(subPage);
    renderPageStrip();
    if (pendingCur !== null) followCur();
  }

  function remoteCur(val) {
    if (!room || !val || val === curSynced) return;
    curSynced = val;
    pendingCur = val;
    followCur();
  }

  // Show the page another device switched to, once the pen is up.
  function followCur() {
    if (pendingCur === null || isDrawing || editing) return;
    const i = pages.findIndex(p => p.id === pendingCur);
    if (i === -1) return; // the page itself has not arrived yet
    pendingCur = null;
    if (i === currentPage) return;
    commitCurrentPage();
    currentPage = i;
    loadPage(i);
    renderPageStrip();
  }

  function remoteSp(val) {
    if (!room || !val || val === spSynced) return;
    spSynced = val;
    const [sf, pt] = val.split('|');
    const prev = SURFACES[surface];
    const next = SURFACES[sf];
    if (next && sf !== surface) {
      if (prev.dark !== next.dark) {
        // The shapes arrive recoloured from the device that made the change;
        // only this device's pen colour and undo history need flipping.
        if (colorPicker.value.toLowerCase() === prev.ink.toLowerCase()) setColor(next.ink);
        for (const page of pages) {
          for (const snap of page.undoStack) snap.shapes.forEach(s => { s.color = invertHex(s.color); });
        }
      }
      surface = sf;
      applyCanvasBg();
    }
    if (PATTERNS.includes(pt)) pattern = pt;
    syncTemplateMenu();
    invalidatePenLayer();
    render();
    flattenAllThumbnails();
    renderPageStrip();
  }

  function subPage(id) {
    if (!room || room.subs.has(id)) return;
    const shapesRef = fb.child(room.ref, `pages/${id}/shapes`);
    const onErr = (err) => onListenError(err);
    room.subs.set(id, [
      fb.onChildAdded(shapesRef, snap => remoteShape(id, snap.key, snap.val()), onErr),
      fb.onChildChanged(shapesRef, snap => remoteShape(id, snap.key, snap.val()), onErr),
      fb.onChildRemoved(shapesRef, snap => remoteGone(id, snap.key), onErr),
      fb.onValue(fb.child(room.ref, `pages/${id}/ink`), snap => remoteInk(id, snap.val()), onErr),
    ]);
    // Fires once, after the page's existing records have all been delivered.
    const page = pageById(id);
    if (page && !page.liveLoaded) {
      fb.onValue(shapesRef, () => {
        page.liveLoaded = true;
        page.undoStack = [{ ink: page.ink, shapes: cloneShapes(page.shapes) }];
      }, onErr, { onlyOnce: true });
    }
  }

  function unsubPage(id) {
    if (!room) return;
    const un = room.subs.get(id);
    if (un) un.forEach(f => f());
    room.subs.delete(id);
  }

  function onListenError(err) {
    console.warn('[live] listener cancelled', err);
    if (room) leave('This live session has expired');
  }

  // ─── Starting, joining, leaving ───
  async function loadSdk() {
    if (fb) return;
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appMod, dbMod] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-database.js`),
    ]);
    db = dbMod.getDatabase(appMod.initializeApp(FIREBASE_CONFIG));
    fb = dbMod;
  }

  function makeCode() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  function isHostOf(code) {
    try { return localStorage.getItem(HOST_KEY) === code; } catch { return false; }
  }

  // Put this device's board online as a new room.
  async function start() {
    if (room) return;
    setBusy('Starting…');
    try {
      await loadSdk();
      if (editing) commitTextEditor();
      commitCurrentPage();
      const data = {
        meta: { created: fb.serverTimestamp(), v: 1 },
        order: pages.map(p => p.id).join(','),
        sp: surface + '|' + pattern,
        cur: pages[currentPage].id,
        pages: {},
      };
      const fresh = new Map();
      for (const page of pages) {
        ensureZ(page.shapes);
        const m = new Map();
        const shapesOut = {};
        for (const s of page.shapes) {
          const w = toWire(s);
          m.set(s.id, sig(w));
          w.by = CLIENT_TAG;
          shapesOut[s.id] = w;
        }
        fresh.set(page.id, m);
        const node = {};
        if (page.shapes.length) node.shapes = shapesOut;
        if (page.hasInk) { node.ink = page.ink; page.inkSent = page.ink; page.inkDirty = false; }
        if (Object.keys(node).length) data.pages[page.id] = node;
        page.liveRef = page.shapes;
        page.liveDirty = false;
        page.liveLoaded = true;
      }

      let code = null;
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = makeCode();
        try {
          await fb.set(fb.ref(db, `rooms/${candidate}`), data);
          code = candidate;
        } catch (err) {
          // A taken code is refused by the rules; anything else is a real failure.
          if (!String(err && err.code).toLowerCase().includes('permission') || attempt === 4) throw err;
        }
      }
      try { localStorage.setItem(HOST_KEY, code); } catch { /* storage unavailable */ }
      synced = fresh;
      orderSynced = data.order;
      spSynced = data.sp;
      curSynced = data.cur;
      enter(code, true);
      showToast('Live session started');
    } catch (err) {
      console.error('[live] start failed', err);
      showToast('Could not start a live session. Check the internet connection');
    }
    setBusy(null);
    renderPanel();
  }

  // Open an existing room and show its board in place of this device's own.
  async function join(rawCode) {
    if (room) return;
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!CODE_RE.test(code)) { showToast('Enter the 6-character session code'); return; }
    setBusy('Joining…');
    try {
      await loadSdk();
      const ref = fb.ref(db, `rooms/${code}`);
      let head;
      try {
        const [o, s, c] = await Promise.all([
          fb.get(fb.child(ref, 'order')), fb.get(fb.child(ref, 'sp')), fb.get(fb.child(ref, 'cur')),
        ]);
        head = { order: o.val(), sp: s.val(), cur: c.val() };
      } catch (err) {
        head = null; // unreadable: no such room, or it is past its 48 hours
      }
      if (!head || !head.order) {
        showToast('Session not found. It may have ended');
        setUrlCode(null);
        setBusy(null);
        renderPanel();
        return;
      }

      // Adopt the room's board. The pages start blank and fill in as the
      // records stream down.
      if (editing) cancelTextEditor();
      if (isDrawing) abortDraw();
      const host = isHostOf(code);
      synced = new Map();
      orderSynced = head.order;
      pages = head.order.split(',').filter(Boolean).map(blankPage);
      currentPage = Math.max(0, pages.findIndex(p => p.id === head.cur));
      curSynced = pages[currentPage].id;
      spSynced = '';
      loadPage(currentPage);
      renderPageStrip();
      enter(code, host);
      if (head.sp) remoteSp(head.sp);
      else spSynced = surface + '|' + pattern;
      showToast(`Joined live session ${code}`);
    } catch (err) {
      console.error('[live] join failed', err);
      showToast('Could not join. Check the internet connection');
    }
    setBusy(null);
    renderPanel();
  }

  function enter(code, host) {
    const ref = fb.ref(db, `rooms/${code}`);
    room = { code, host, ref, subs: new Map(), unsubs: [], ready: true };
    lastCurId = pages[currentPage].id;
    pendingCur = null;
    const onErr = (err) => onListenError(err);
    pages.forEach(p => subPage(p.id));
    room.unsubs.push(
      fb.onValue(fb.child(ref, 'order'), snap => remoteOrder(snap.val()), onErr),
      fb.onValue(fb.child(ref, 'sp'), snap => remoteSp(snap.val()), onErr),
      fb.onValue(fb.child(ref, 'cur'), snap => remoteCur(snap.val()), onErr),
      fb.onValue(fb.child(ref, 'presence'), snap => {
        const n = snap.exists() ? Object.keys(snap.val()).length : 0;
        if (n > deviceCount && deviceCount > 0) showToast(`Device joined: ${n} connected`);
        deviceCount = n;
        renderPanel();
      }, onErr),
      fb.onValue(fb.ref(db, '.info/connected'), snap => {
        online = snap.val() === true;
        if (online && room) {
          const me = fb.child(room.ref, `presence/${CLIENT_TAG}`);
          fb.onDisconnect(me).remove();
          fb.set(me, true).catch(() => {});
        }
        renderPanel();
      }),
    );
    tickTimer = setInterval(tick, LIVE_TICK_MS);
    setUrlCode(code);
    document.body.classList.add('live-on');
    renderPanel();
  }

  function teardown() {
    if (!room) return null;
    const old = room;
    room = null;
    clearInterval(tickTimer);
    old.unsubs.forEach(f => f());
    old.subs.forEach(un => un.forEach(f => f()));
    try { fb.remove(fb.child(old.ref, `presence/${CLIENT_TAG}`)).catch(() => {}); } catch { /* offline */ }
    deviceCount = 0;
    pendingCur = null;
    synced = new Map();
    document.body.classList.remove('live-on');
    setUrlCode(null);
    return old;
  }

  // Disconnect this device. A guest goes back to its own saved board.
  function leave(message) {
    const old = teardown();
    if (!old) return;
    if (message) showToast(message);
    if (old.host) {
      try { localStorage.removeItem(HOST_KEY); } catch { /* storage unavailable */ }
      commitCurrentPage();
      persistState();
      renderPanel();
    } else {
      setTimeout(() => location.reload(), message ? 1600 : 0);
    }
  }

  // Host only: close the room for everyone and delete it from the database.
  function end() {
    if (!room || !room.host) return;
    if (!confirm('End the live session for all devices? Your board stays on this device.')) return;
    const ref = room.ref;
    leave('Live session ended');
    fb.remove(ref).catch(err => console.warn('[live] could not delete the room', err));
  }

  function setUrlCode(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('join', code);
    else url.searchParams.delete('join');
    history.replaceState(null, '', url);
  }

  function joinUrl() {
    return `${location.origin}${location.pathname}?join=${room.code}`;
  }

  // ─── Panel ───
  const dd = document.getElementById('ddLive');
  const panel = document.getElementById('livePanel');
  const btnLive = document.getElementById('btnLive');
  const liveCount = document.getElementById('liveCount');
  let busy = null;

  function setBusy(label) { busy = label; renderPanel(); }

  function loadQrLib() {
    if (window.QRCode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = QR_LIB;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function renderPanel() {
    btnLive.classList.toggle('active', !!room);
    btnLive.title = room ? `Live session ${room.code}` : 'Live session: draw from an iPad or another device';
    liveCount.hidden = !room;
    liveCount.textContent = deviceCount > 1 ? String(deviceCount) : '';
    liveCount.classList.toggle('offline', !!room && !online);

    if (busy) {
      panel.innerHTML = `<div class="live-busy">${busy}</div>`;
      return;
    }
    if (!room) {
      panel.innerHTML = `
        <div class="palette-title">Live session</div>
        <p class="live-help">Show this board on the classroom screen and draw on it from an iPad with Apple Pencil, or from any other device.</p>
        <button class="btn btn-accent live-wide" id="liveStart">Start live session</button>
        <div class="live-or">or join one</div>
        <div class="live-row">
          <input class="live-input" id="liveCode" maxlength="6" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <button class="btn" id="liveJoin">Join</button>
        </div>`;
      panel.querySelector('#liveStart').addEventListener('click', start);
      const input = panel.querySelector('#liveCode');
      const go = () => join(input.value);
      panel.querySelector('#liveJoin').addEventListener('click', go);
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
      return;
    }

    const others = Math.max(0, deviceCount - 1);
    const status = !online ? 'Reconnecting…'
      : others === 0 ? 'Waiting for another device to join'
      : `${others} other device${others > 1 ? 's' : ''} connected`;
    panel.innerHTML = `
      <div class="palette-title">Live session</div>
      <div class="live-code">${room.code}</div>
      <div class="live-qr" id="liveQr" title="Click to enlarge"></div>
      <p class="live-help">Scan with the iPad camera (click the code to enlarge it), or open this board on the iPad and enter the code above.</p>
      <div class="live-row">
        <input class="live-input live-link" id="liveLink" readonly value="${joinUrl()}">
        <button class="btn" id="liveCopy">Copy</button>
      </div>
      <div class="live-status${online ? '' : ' offline'}"><span class="live-dot"></span>${status}</div>
      <button class="btn ${room.host ? 'btn-danger' : ''} live-wide" id="liveStop">${room.host ? 'End session' : 'Leave session'}</button>`;
    panel.querySelector('#liveCopy').addEventListener('click', () => {
      const link = panel.querySelector('#liveLink');
      const done = () => showToast('Link copied');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link.value).then(done, () => { link.select(); });
      else { link.select(); document.execCommand('copy'); done(); }
    });
    panel.querySelector('#liveLink').addEventListener('keydown', (e) => e.stopPropagation());
    panel.querySelector('#liveQr').addEventListener('click', showBigQr);
    panel.querySelector('#liveStop').addEventListener('click', () => { if (room.host) end(); else leave(); });
    const code = room.code;
    loadQrLib().then(() => {
      const el = panel.querySelector('#liveQr');
      if (!el || !room || room.code !== code || el.firstChild) return;
      new window.QRCode(el, {
        text: joinUrl(), width: 640, height: 640,
        colorDark: '#111111', colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
    }).catch(() => {
      const el = panel.querySelector('#liveQr');
      if (el) el.textContent = 'QR code unavailable';
    });
  }

  // Full-screen QR code, large enough to scan from across a room.
  function showBigQr() {
    const src = panel.querySelector('#liveQr img, #liveQr canvas');
    if (!room || !src) return;
    const overlay = document.createElement('div');
    overlay.className = 'live-overlay';
    overlay.innerHTML = `
      <div class="live-overlay-card">
        <img alt="QR code to join the live session">
        <div class="live-code">${room.code}</div>
        <p class="live-help">Scan to join, or open ${location.host}${location.pathname} and enter the code. Click anywhere to close.</p>
      </div>`;
    overlay.querySelector('img').src = src.tagName === 'CANVAS' ? src.toDataURL() : src.src;
    overlay.addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // Clicks inside the panel must not reach the document handler that closes dropdowns.
  panel.addEventListener('click', (e) => e.stopPropagation());

  window.Live = {
    localChanged,
    isGuest: () => !!room && !room.host,
    isLive: () => !!room,
    start, join, leave, end,
  };

  renderPanel();

  // A link with ?join=CODE (the QR code) goes straight into the session.
  const wanted = new URL(location.href).searchParams.get('join');
  if (wanted) join(wanted);
})();
