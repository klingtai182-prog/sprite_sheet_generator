/**
 * ════════════════════════════════════════════════════════════
 * SADEWA SPRITE BUILDER — app.js
 * Sprite sheet builder + isometric RTS camera preview
 * ════════════════════════════════════════════════════════════
 *
 * Modules:
 *  1. ServiceWorker Registration
 *  2. State Management
 *  3. File Loader (drag-drop, folder traversal, sorting)
 *  4. Sprite Builder (canvas-based sheet assembly)
 *  5. Camera Preview (isometric projection, lighting, shadow)
 *  6. UI Controller (tabs, controls, options)
 *  7. Export (PNG download, JSON download)
 *  8. Toast / Loading / Utilities
 */

'use strict';

/* ════════════════════════════════════════
   1. SERVICE WORKER REGISTRATION
════════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('[SW] Registration failed:', err);
    });
  });
}

/* PWA Install prompt */
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  document.getElementById('btn-install').style.display = 'flex';
});

document.getElementById('btn-install').addEventListener('click', async () => {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
  const { outcome } = await _deferredInstall.userChoice;
  if (outcome === 'accepted') {
    document.getElementById('btn-install').style.display = 'none';
    _deferredInstall = null;
  }
});

/* ════════════════════════════════════════
   2. STATE MANAGEMENT
════════════════════════════════════════ */
const State = {
  /** @type {Map<string, Animation>} Map of animName -> Animation */
  animations: new Map(),

  /** Currently active animation name */
  activeAnimation: null,

  /** Sprite settings */
  sprite: {
    frameSize: 256,
    columns: 8,
    fps: 12,
    autoCrop: true,
    autoCenter: true,
    autoPadding: true,
    transparent: true,
  },

  /** Camera settings */
  camera: {
    height: 60,       // 0–90 degrees
    rotation: 0,      // 0–315 in 45° steps
    projection: 'orthographic',
    zoom: 100,        // 25–300%
    charRotation: 0,  // character facing direction
    preset: 'classic',
  },

  /** Lighting settings */
  lighting: {
    direction: 'top-left',
    intensity: 60,
    shadow: true,
  },

  /** Scene / background */
  scene: {
    background: 'checkerboard',
    bgColor: '#1a1a2e',
    showGrid: true,
    showSafeArea: true,
  },

  /** Playback */
  playback: {
    playing: false,
    currentFrame: 0,
    lastTick: 0,
    rafId: null,
  },

  /** Sprite sheet canvas zoom */
  previewZoom: 1,
};

/**
 * @typedef {Object} Animation
 * @property {string} name
 * @property {HTMLImageElement[]} frames
 * @property {HTMLCanvasElement|null} sheetCanvas  - compiled sprite sheet
 * @property {Object|null} meta                    - JSON metadata
 */

/* ════════════════════════════════════════
   3. FILE LOADER
════════════════════════════════════════ */

const FileLoader = (() => {

  /** Entry point: accepts FileList or DataTransferItemList */
  async function load(source) {
    UI.showLoading('Reading files…', 0);
    const rawFiles = [];

    try {
      if (source instanceof DataTransferItemList) {
        await _traverseItems(source, rawFiles);
      } else {
        for (const f of source) rawFiles.push(f);
      }

      const pngs = rawFiles.filter(f => f.type === 'image/png' || f.name.toLowerCase().endsWith('.png'));

      if (!pngs.length) {
        Toast.show('No PNG files found', 'error');
        return;
      }

      await _processFiles(pngs);
    } catch (err) {
      console.error(err);
      Toast.show('Error loading files: ' + err.message, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  /**
   * Traverse DataTransferItemList recursively for folder support
   */
  async function _traverseItems(itemList, out) {
    const promises = [];
    for (let i = 0; i < itemList.length; i++) {
      const item = itemList[i];
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        promises.push(_readEntry(entry, out));
      } else {
        out.push(item.getAsFile());
      }
    }
    await Promise.all(promises);
  }

  async function _readEntry(entry, out) {
    if (entry.isFile) {
      const file = await _entryToFile(entry);
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await _readAllEntries(reader);
      await Promise.all(entries.map(e => _readEntry(e, out)));
    }
  }

  function _entryToFile(entry) {
    return new Promise((res, rej) => entry.file(res, rej));
  }

  function _readAllEntries(reader) {
    return new Promise((resolve) => {
      const result = [];
      function read() {
        reader.readEntries((entries) => {
          if (!entries.length) return resolve(result);
          result.push(...entries);
          read();
        }, () => resolve(result));
      }
      read();
    });
  }

  /**
   * Group files by animation folder or treat root PNGs as one group
   */
  async function _processFiles(files) {
    // Group by folder path
    const groups = new Map(); // folderName -> File[]

    for (const file of files) {
      // file.webkitRelativePath: "Barbarian/idle/idle_01.png"
      // or just "idle_01.png" for flat drops
      const relPath = file.webkitRelativePath || file.name;
      const parts = relPath.replace(/\\/g, '/').split('/');

      let groupName;
      if (parts.length >= 3) {
        // Deep: root/animation/file.png → use animation name
        groupName = parts[parts.length - 2];
      } else if (parts.length === 2) {
        // root/file.png → use root as group
        groupName = parts[0];
      } else {
        // flat file — infer animation from filename prefix
        groupName = _inferGroupName(file.name);
      }

      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(file);
    }

    // Sort files within each group by filename
    for (const [, groupFiles] of groups) {
      groupFiles.sort((a, b) => _naturalSort(a.name, b.name));
    }

    // Load images async
    const total = files.length;
    let loaded = 0;

    for (const [groupName, groupFiles] of groups) {
      const frames = [];
      for (const file of groupFiles) {
        const img = await _loadImage(file);
        frames.push(img);
        loaded++;
        UI.updateProgress(Math.round((loaded / total) * 90), `Loading ${file.name}…`);
      }

      const animName = groupName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

      if (!State.animations.has(animName)) {
        State.animations.set(animName, { name: animName, frames, sheetCanvas: null, meta: null });
      } else {
        // Merge frames
        State.animations.get(animName).frames.push(...frames);
        State.animations.get(animName).sheetCanvas = null;
      }
    }

    UI.updateProgress(95, 'Building sprite sheets…');
    await SpriteBuilder.buildAll();
    UI.renderAnimationList();

    // Auto-select first animation
    if (!State.activeAnimation && State.animations.size > 0) {
      AnimController.setActive([...State.animations.keys()][0]);
    }

    UI.hideLoading();
    Toast.show(`Loaded ${files.length} frames in ${groups.size} animation(s)`, 'success');
  }

  function _inferGroupName(filename) {
    // idle_north_01.png → idle
    const base = filename.replace(/\.png$/i, '');
    return base.split(/[_\-\s]/)[0] || 'frames';
  }

  function _loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  /** Natural sort: frame_01 < frame_02 < frame_10 */
  function _naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  return { load };
})();

/* ════════════════════════════════════════
   4. SPRITE BUILDER
════════════════════════════════════════ */

const SpriteBuilder = (() => {

  /** Build sprite sheet for every animation */
  async function buildAll() {
    for (const [name, anim] of State.animations) {
      await build(name);
    }
  }

  /** Build sprite sheet for one animation */
  async function build(animName) {
    const anim = State.animations.get(animName);
    if (!anim || !anim.frames.length) return;

    const { frameSize, columns, autoCrop, autoCenter, autoPadding, transparent } = State.sprite;
    const padding = autoPadding ? Math.floor(frameSize * 0.04) : 0;
    const cellSize = frameSize;
    const cols = Math.min(columns, anim.frames.length);
    const rows = Math.ceil(anim.frames.length / cols);

    const canvas = document.createElement('canvas');
    canvas.width  = cols * cellSize;
    canvas.height = rows * cellSize;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Background
    if (!transparent) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Draw each frame
    for (let i = 0; i < anim.frames.length; i++) {
      const img = anim.frames[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const destX = col * cellSize;
      const destY = row * cellSize;

      let srcImg = img;
      let srcX = 0, srcY = 0, srcW = img.width, srcH = img.height;

      // Auto-crop transparent area
      if (autoCrop) {
        const bounds = _getOpaqueBounds(img);
        if (bounds) { srcX = bounds.x; srcY = bounds.y; srcW = bounds.w; srcH = bounds.h; }
      }

      // Scale to fit cellSize with padding
      const drawSize = cellSize - padding * 2;
      const scale = Math.min(drawSize / srcW, drawSize / srcH);
      const dw = Math.floor(srcW * scale);
      const dh = Math.floor(srcH * scale);

      // Auto-center within cell
      const dx = autoCenter ? destX + Math.floor((cellSize - dw) / 2) : destX + padding;
      const dy = autoCenter ? destY + Math.floor((cellSize - dh) / 2) : destY + padding;

      ctx.drawImage(img, srcX, srcY, srcW, srcH, dx, dy, dw, dh);
    }

    // Store result
    anim.sheetCanvas = canvas;
    anim.meta = {
      name: animName,
      frameWidth: cellSize,
      frameHeight: cellSize,
      columns: cols,
      rows,
      frames: anim.frames.length,
      fps: State.sprite.fps,
    };
  }

  /**
   * Returns the tight bounding box of non-transparent pixels in an image.
   * @returns {{x,y,w,h}|null}
   */
  function _getOpaqueBounds(img) {
    const offscreen = document.createElement('canvas');
    offscreen.width = img.width;
    offscreen.height = img.height;
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;

    let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
    let found = false;

    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const alpha = data[(y * img.width + x) * 4 + 3];
        if (alpha > 8) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!found) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  return { build, buildAll };
})();

/* ════════════════════════════════════════
   5. CAMERA PREVIEW
════════════════════════════════════════ */

const CameraPreview = (() => {
  const canvas = document.getElementById('camera-canvas');
  const ctx = canvas.getContext('2d');

  const CAMERA_SIZE = 512;

  function init() {
    canvas.width  = CAMERA_SIZE;
    canvas.height = CAMERA_SIZE;
    render();
  }

  function render() {
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const { scene, camera, lighting } = State;

    // Background
    _drawBackground(ctx, width, height, scene);

    // Grid
    if (scene.showGrid) _drawGrid(ctx, width, height, camera);

    // Safe area
    if (scene.showSafeArea) _drawSafeArea(ctx, width, height);

    // Get current frame
    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
    const frame = anim ? anim.frames[State.playback.currentFrame] : null;

    if (frame) {
      _drawSprite(ctx, frame, width, height, camera, lighting, scene);
    } else {
      _drawPlaceholder(ctx, width, height);
    }
  }

  /* ── Background ── */
  function _drawBackground(ctx, w, h, scene) {
    if (scene.background === 'transparent') {
      return; // canvas is already cleared
    }
    if (scene.background === 'solid') {
      ctx.fillStyle = scene.bgColor;
      ctx.fillRect(0, 0, w, h);
    } else {
      // Checkerboard
      const sz = 16;
      for (let y = 0; y < h; y += sz) {
        for (let x = 0; x < w; x += sz) {
          ctx.fillStyle = ((x + y) / sz) % 2 === 0 ? '#1a1e2a' : '#222736';
          ctx.fillRect(x, y, sz, sz);
        }
      }
    }
  }

  /* ── Grid (isometric diamond tiles) ── */
  function _drawGrid(ctx, w, h, camera) {
    const heightAngle = camera.height; // 0–90
    const tileW = 48;
    const tileH = tileW * Math.sin((heightAngle * Math.PI) / 180) * 0.5;
    const cols = Math.ceil(w / tileW) + 2;
    const rows = Math.ceil(h / (tileH || 1)) + 2;
    const offX = w / 2;
    const offY = h / 2;
    const rotRad = (camera.rotation * Math.PI) / 180;

    ctx.strokeStyle = 'rgba(124,107,255,0.12)';
    ctx.lineWidth = 0.5;

    for (let row = -rows; row < rows; row++) {
      for (let col = -cols; col < cols; col++) {
        // Flat-top isometric tile
        const cartX = col * tileW;
        const cartY = row * tileH * 2;

        // Apply camera rotation
        const isoX = (cartX - cartY) * Math.cos(rotRad) - (cartX + cartY) * 0.5 * Math.sin(rotRad);
        const isoY = (cartX - cartY) * Math.sin(rotRad) + (cartX + cartY) * 0.5 * Math.cos(rotRad);

        const sx = offX + isoX;
        const sy = offY + isoY;

        if (sx < -tileW || sx > w + tileW || sy < -tileH * 2 || sy > h + tileH * 2) continue;

        ctx.beginPath();
        ctx.moveTo(sx,           sy - tileH);
        ctx.lineTo(sx + tileW/2, sy);
        ctx.lineTo(sx,           sy + tileH);
        ctx.lineTo(sx - tileW/2, sy);
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  /* ── Safe area indicator ── */
  function _drawSafeArea(ctx, w, h) {
    const margin = w * 0.06;
    ctx.strokeStyle = 'rgba(255,179,71,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(margin, margin, w - margin * 2, h - margin * 2);
    ctx.setLineDash([]);
  }

  /* ── Sprite rendering with camera transform ── */
  function _drawSprite(ctx, img, w, h, camera, lighting, scene) {
    const zoom = camera.zoom / 100;
    const heightAngle = camera.height;  // degrees 0–90
    const rotDeg = camera.rotation;
    const charRotDeg = camera.charRotation;

    // Center of canvas
    const cx = w / 2;
    const cy = h / 2;

    ctx.save();
    ctx.translate(cx, cy);

    // Apply camera zoom
    ctx.scale(zoom, zoom);

    // Camera rotation (Y-axis)
    ctx.rotate((rotDeg * Math.PI) / 180);

    // Camera height: compress Y (isometric skew)
    const yScale = Math.sin((heightAngle * Math.PI) / 180);
    const xScale = camera.projection === 'isometric'
      ? Math.cos(Math.PI / 6)  // 30° classic isometric
      : 1.0;

    ctx.scale(xScale, yScale);

    // Shadow (drawn before sprite)
    if (lighting.shadow) {
      const shadowOffset = 20 * (1 - yScale + 0.1);
      ctx.save();
      ctx.globalAlpha = 0.25 * (lighting.intensity / 100);
      const lightAngle = _lightAngle(lighting.direction);
      ctx.translate(
        Math.cos(lightAngle) * shadowOffset,
        Math.sin(lightAngle) * shadowOffset * yScale
      );
      ctx.scale(1, 0.25);
      const sw = img.width  / (img.width > img.height ? img.width  : img.height) * 200;
      const sh = img.height / (img.width > img.height ? img.width  : img.height) * 200;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(0, sh * 0.6, sw * 0.4, sh * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Character rotation around its own axis
    ctx.rotate((charRotDeg * Math.PI) / 180);

    // Draw sprite centered
    const maxDim = Math.max(img.width, img.height);
    const scale  = 220 / maxDim;
    const dw = img.width  * scale;
    const dh = img.height * scale;

    // Lighting overlay
    const alpha = (lighting.intensity / 100) * 0.35;
    const lightAngle = _lightAngle(lighting.direction);
    const grad = ctx.createLinearGradient(
      Math.cos(lightAngle) * -dw, Math.sin(lightAngle) * -dh,
      Math.cos(lightAngle + Math.PI) * dw, Math.sin(lightAngle + Math.PI) * dh
    );
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, `rgba(0,0,0,${alpha})`);

    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);

    // Apply lighting as an overlay
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = grad;
    ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.restore();

    // Check safe area
    _checkSafeArea(w, h);
  }

  function _lightAngle(dir) {
    const angles = {
      'top-left': -Math.PI * 0.75,
      'top-right': -Math.PI * 0.25,
      'bottom-left': Math.PI * 0.75,
      'bottom-right': Math.PI * 0.25,
    };
    return angles[dir] ?? -Math.PI * 0.75;
  }

  function _drawPlaceholder(ctx, w, h) {
    ctx.fillStyle = 'rgba(124,107,255,0.06)';
    const sz = 80;
    ctx.fillRect(w/2 - sz/2, h/2 - sz/2, sz, sz);
    ctx.strokeStyle = 'rgba(124,107,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(w/2 - sz/2, h/2 - sz/2, sz, sz);
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(124,107,255,0.3)';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Load frames to preview', w/2, h/2 + sz * 0.8);
  }

  function _checkSafeArea(w, h) {
    // This is a simplified check; in production you'd pixel-test sprite bounds
    const warn = document.getElementById('safe-area-warn');
    // Show warning if zoom is very high (sprite would likely overflow)
    const overflows = State.camera.zoom > 200 && State.camera.height < 20;
    warn.classList.toggle('hidden', !overflows);
  }

  return { init, render };
})();

/* ════════════════════════════════════════
   6. ANIMATION CONTROLLER
════════════════════════════════════════ */

const AnimController = (() => {

  function setActive(name) {
    State.activeAnimation = name;
    State.playback.currentFrame = 0;
    UI.renderAnimationList();
    renderSprite();
    CameraPreview.render();
    updateFrameStrip();
    updateFrameCounter();
    updateSpriteInfo();
  }

  function renderSprite() {
    const empty = document.getElementById('sprite-empty');
    const exportBar = document.getElementById('export-bar');
    const frameStrip = document.getElementById('frame-strip');

    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;

    if (!anim || !anim.sheetCanvas) {
      empty.style.display = 'flex';
      exportBar.style.display = 'none';
      frameStrip.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    exportBar.style.display = 'flex';
    frameStrip.style.display = 'block';

    const canvas = document.getElementById('sprite-canvas');
    canvas.width  = anim.sheetCanvas.width;
    canvas.height = anim.sheetCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw checkerboard behind transparent sheet
    const sz = 8;
    for (let y = 0; y < canvas.height; y += sz) {
      for (let x = 0; x < canvas.width; x += sz) {
        ctx.fillStyle = ((x + y) / sz) % 2 === 0 ? '#1a1e2a' : '#222736';
        ctx.fillRect(x, y, sz, sz);
      }
    }

    ctx.drawImage(anim.sheetCanvas, 0, 0);

    applyZoom();
    updateExportInfo(anim);
  }

  function applyZoom() {
    const container = document.getElementById('sprite-canvas-container');
    container.style.transform = `scale(${State.previewZoom})`;
    container.style.transformOrigin = 'center center';
    document.getElementById('zoom-level').textContent = Math.round(State.previewZoom * 100) + '%';
  }

  function updateFrameStrip() {
    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
    const stripInner = document.getElementById('frame-strip-inner');
    stripInner.innerHTML = '';

    if (!anim) return;

    anim.frames.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'frame-thumb' + (i === State.playback.currentFrame ? ' active' : '');
      thumb.title = `Frame ${i + 1}`;

      const imgEl = document.createElement('img');
      imgEl.src = img.src;

      const idx = document.createElement('span');
      idx.className = 'frame-index';
      idx.textContent = i + 1;

      thumb.append(imgEl, idx);
      thumb.addEventListener('click', () => {
        State.playback.currentFrame = i;
        updateActiveThumb();
        updateFrameCounter();
        CameraPreview.render();
      });

      stripInner.appendChild(thumb);
    });
  }

  function updateActiveThumb() {
    document.querySelectorAll('.frame-thumb').forEach((el, i) => {
      el.classList.toggle('active', i === State.playback.currentFrame);
    });
  }

  function updateFrameCounter() {
    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
    const total = anim ? anim.frames.length : 0;
    document.getElementById('frame-counter').textContent =
      `${State.playback.currentFrame + 1} / ${total}`;
  }

  function updateSpriteInfo() {
    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
    if (!anim) {
      document.getElementById('sprite-info').textContent = 'No frames loaded';
      return;
    }
    const cols = Math.min(State.sprite.columns, anim.frames.length);
    const rows = Math.ceil(anim.frames.length / cols);
    document.getElementById('sprite-info').textContent =
      `${anim.name} · ${anim.frames.length} frames · ${cols}×${rows} · ${anim.sheetCanvas?.width}×${anim.sheetCanvas?.height}px`;
  }

  function updateExportInfo(anim) {
    document.getElementById('export-info').textContent =
      `${anim.name}.png · ${anim.sheetCanvas.width}×${anim.sheetCanvas.height}px · ${anim.frames.length} frames @ ${State.sprite.fps}fps`;
  }

  /* Playback loop */
  function startPlayback() {
    State.playback.playing = true;
    document.getElementById('btn-play-pause').textContent = '⏸';
    _tick();
  }

  function stopPlayback() {
    State.playback.playing = false;
    document.getElementById('btn-play-pause').textContent = '▶';
    cancelAnimationFrame(State.playback.rafId);
  }

  function _tick(timestamp = 0) {
    if (!State.playback.playing) return;
    const delay = 1000 / State.sprite.fps;

    if (timestamp - State.playback.lastTick >= delay) {
      State.playback.lastTick = timestamp;
      const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
      if (anim && anim.frames.length) {
        State.playback.currentFrame = (State.playback.currentFrame + 1) % anim.frames.length;
        updateActiveThumb();
        updateFrameCounter();
        CameraPreview.render();
      }
    }

    State.playback.rafId = requestAnimationFrame(_tick);
  }

  function nextFrame() {
    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
    if (!anim) return;
    State.playback.currentFrame = (State.playback.currentFrame + 1) % anim.frames.length;
    updateActiveThumb();
    updateFrameCounter();
    CameraPreview.render();
  }

  function prevFrame() {
    const anim = State.activeAnimation ? State.animations.get(State.activeAnimation) : null;
    if (!anim) return;
    State.playback.currentFrame = (State.playback.currentFrame - 1 + anim.frames.length) % anim.frames.length;
    updateActiveThumb();
    updateFrameCounter();
    CameraPreview.render();
  }

  return { setActive, renderSprite, applyZoom, updateFrameStrip, updateFrameCounter, startPlayback, stopPlayback, nextFrame, prevFrame, updateSpriteInfo };
})();

/* ════════════════════════════════════════
   7. EXPORT
════════════════════════════════════════ */

const Exporter = (() => {

  /** Export sprite sheet PNG for active animation */
  function exportPNG(animName) {
    const anim = State.animations.get(animName || State.activeAnimation);
    if (!anim || !anim.sheetCanvas) { Toast.show('No sprite sheet to export', 'error'); return; }

    const link = document.createElement('a');
    link.download = `${anim.name}.png`;
    link.href = anim.sheetCanvas.toDataURL('image/png');
    link.click();
    Toast.show(`Exported ${anim.name}.png`, 'success');
  }

  /** Export JSON metadata for active animation */
  function exportJSON(animName) {
    const anim = State.animations.get(animName || State.activeAnimation);
    if (!anim || !anim.meta) { Toast.show('No metadata to export', 'error'); return; }

    const json = JSON.stringify(anim.meta, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const link = document.createElement('a');
    link.download = `${anim.name}.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
    Toast.show(`Exported ${anim.name}.json`, 'success');
  }

  /** Export all animations */
  async function exportAll() {
    if (!State.animations.size) { Toast.show('No animations to export', 'error'); return; }
    for (const [name] of State.animations) {
      exportPNG(name);
      await _sleep(150);
      exportJSON(name);
      await _sleep(150);
    }
    Toast.show(`Exported ${State.animations.size} animations`, 'success');
  }

  /** Export camera preview canvas */
  function exportCamera() {
    const canvas = document.getElementById('camera-canvas');
    const link = document.createElement('a');
    const name = State.activeAnimation || 'preview';
    link.download = `${name}_camera.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    Toast.show('Camera preview exported', 'success');
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { exportPNG, exportJSON, exportAll, exportCamera };
})();

/* ════════════════════════════════════════
   8. UI CONTROLLER
════════════════════════════════════════ */

const UI = (() => {

  /* ── Animations List ── */
  function renderAnimationList() {
    const section = document.getElementById('section-animations');
    const list    = document.getElementById('animation-list');

    if (!State.animations.size) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'flex';
    list.innerHTML = '';

    for (const [name, anim] of State.animations) {
      const li = document.createElement('li');
      li.className = 'anim-item' + (name === State.activeAnimation ? ' active' : '');
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      li.setAttribute('aria-pressed', name === State.activeAnimation ? 'true' : 'false');

      // Thumbnail: first frame
      const thumb = document.createElement('div');
      thumb.className = 'anim-thumb';
      if (anim.frames.length) {
        const img = document.createElement('img');
        img.src = anim.frames[0].src;
        img.alt = '';
        thumb.appendChild(img);
      }

      const info = document.createElement('div');
      info.className = 'anim-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'anim-name';
      nameEl.textContent = name;

      const meta = document.createElement('div');
      meta.className = 'anim-meta';
      meta.textContent = `${anim.frames.length} frames`;

      info.append(nameEl, meta);

      const del = document.createElement('button');
      del.className = 'anim-del';
      del.title = 'Remove animation';
      del.innerHTML = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        State.animations.delete(name);
        if (State.activeAnimation === name) {
          State.activeAnimation = State.animations.size
            ? [...State.animations.keys()][0]
            : null;
        }
        renderAnimationList();
        AnimController.renderSprite();
        CameraPreview.render();
      });

      li.append(thumb, info, del);
      li.addEventListener('click', () => AnimController.setActive(name));
      li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') AnimController.setActive(name); });

      list.appendChild(li);
    }
  }

  /* ── Loading overlay ── */
  function showLoading(text = 'Processing…', progress = 0) {
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-text').textContent = text;
    document.getElementById('progress-fill').style.width = progress + '%';
  }

  function updateProgress(pct, text) {
    document.getElementById('progress-fill').style.width = pct + '%';
    if (text) document.getElementById('loading-text').textContent = text;
  }

  function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  /* ── Camera Preset application ── */
  function applyPreset(preset) {
    const presets = {
      classic: { height: 60, rotation: 45,  projection: 'orthographic', zoom: 100 },
      topdown:  { height: 90, rotation: 0,   projection: 'orthographic', zoom: 100 },
      moba:     { height: 50, rotation: 45,  projection: 'orthographic', zoom: 100 },
      custom:   null,
    };

    const p = presets[preset];
    if (!p) return;

    State.camera.height     = p.height;
    State.camera.rotation   = p.rotation;
    State.camera.projection = p.projection;
    State.camera.zoom       = p.zoom;

    // Sync UI
    document.getElementById('cam-height').value = p.height;
    document.getElementById('cam-height-val').textContent = p.height + '°';
    document.getElementById('cam-zoom').value = p.zoom;
    document.getElementById('cam-zoom-val').textContent = p.zoom + '%';
    document.getElementById('cam-rot-display').textContent = p.rotation + '°';

    // Sync direction pad
    document.querySelectorAll('#cam-rotation-pad .dir-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.value) === p.rotation);
    });

    // Sync projection buttons
    document.querySelectorAll('[data-group="projection"]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === p.projection);
    });

    CameraPreview.render();
  }

  return { renderAnimationList, showLoading, updateProgress, hideLoading, applyPreset };
})();

/* ════════════════════════════════════════
   TOAST SYSTEM
════════════════════════════════════════ */

const Toast = (() => {
  function show(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const dot = document.createElement('span');
    dot.className = 'toast-dot';

    const text = document.createElement('span');
    text.textContent = message;

    toast.append(dot, text);
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return { show };
})();

/* ════════════════════════════════════════
   EVENT BINDING — DOM READY
════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  CameraPreview.init();

  /* ── Drop Zone ── */
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    await FileLoader.load(e.dataTransfer.items);
  });

  document.getElementById('btn-browse').addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => FileLoader.load(fileInput.files));

  /* Allow clicking drop zone to also open files */
  dropZone.addEventListener('click', (e) => {
    if (e.target.closest('#btn-browse')) return;
    fileInput.click();
  });

  /* ── Sprite Settings ── */

  // Option button groups (frame size, columns, projection, bg, presets)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-option');
    if (!btn) return;
    const group = btn.dataset.group;
    const value = btn.dataset.value;
    if (!group) return;

    // Toggle active within group
    document.querySelectorAll(`[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Map group → state
    const actions = {
      'frame-size':  async () => {
        State.sprite.frameSize = parseInt(value);
        await SpriteBuilder.buildAll();
        AnimController.renderSprite();
        AnimController.updateSpriteInfo();
      },
      'columns': async () => {
        State.sprite.columns = parseInt(value);
        await SpriteBuilder.buildAll();
        AnimController.renderSprite();
        AnimController.updateSpriteInfo();
      },
      'projection': () => {
        State.camera.projection = value;
        CameraPreview.render();
      },
      'bg': () => {
        State.scene.background = value;
        document.getElementById('bg-color-group').style.display = value === 'solid' ? 'flex' : 'none';
        CameraPreview.render();
      },
      'cam-preset': () => {
        State.camera.preset = value;
        UI.applyPreset(value);
      },
    };

    if (actions[group]) await actions[group]();
  });

  // FPS slider
  const fpsSlider = document.getElementById('fps-slider');
  fpsSlider.addEventListener('input', () => {
    State.sprite.fps = parseInt(fpsSlider.value);
    document.getElementById('fps-value').textContent = fpsSlider.value;
    if (State.activeAnimation) {
      const anim = State.animations.get(State.activeAnimation);
      if (anim && anim.meta) anim.meta.fps = State.sprite.fps;
    }
  });

  // Toggles
  const toggles = {
    'toggle-autocrop':    () => { State.sprite.autoCrop    = !State.sprite.autoCrop;    rebuildAll(); },
    'toggle-autocenter':  () => { State.sprite.autoCenter  = !State.sprite.autoCenter;  rebuildAll(); },
    'toggle-autopadding': () => { State.sprite.autoPadding = !State.sprite.autoPadding; rebuildAll(); },
    'toggle-transparent': () => { State.sprite.transparent = !State.sprite.transparent; rebuildAll(); },
    'toggle-shadow':      () => { State.lighting.shadow    = !State.lighting.shadow;    CameraPreview.render(); },
    'toggle-grid':        () => { State.scene.showGrid     = !State.scene.showGrid;     CameraPreview.render(); },
    'toggle-safe-area':   () => { State.scene.showSafeArea = !State.scene.showSafeArea; CameraPreview.render(); },
  };

  async function rebuildAll() {
    UI.showLoading('Rebuilding…', 10);
    await SpriteBuilder.buildAll();
    AnimController.renderSprite();
    UI.hideLoading();
  }

  for (const [id, fn] of Object.entries(toggles)) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', fn);
  }

  // BG color
  document.getElementById('bg-color').addEventListener('input', (e) => {
    State.scene.bgColor = e.target.value;
    CameraPreview.render();
  });

  /* ── Camera Controls ── */

  const camHeight = document.getElementById('cam-height');
  camHeight.addEventListener('input', () => {
    State.camera.height = parseInt(camHeight.value);
    document.getElementById('cam-height-val').textContent = camHeight.value + '°';
    State.camera.preset = 'custom';
    document.querySelectorAll('[data-group="cam-preset"]').forEach(b =>
      b.classList.toggle('active', b.dataset.value === 'custom')
    );
    CameraPreview.render();
  });

  const camZoom = document.getElementById('cam-zoom');
  camZoom.addEventListener('input', () => {
    State.camera.zoom = parseInt(camZoom.value);
    document.getElementById('cam-zoom-val').textContent = camZoom.value + '%';
    CameraPreview.render();
  });

  // Camera rotation pad
  document.querySelectorAll('#cam-rotation-pad .dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#cam-rotation-pad .dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.camera.rotation = parseInt(btn.dataset.value);
      document.getElementById('cam-rot-display').textContent = btn.dataset.value + '°';
      State.camera.preset = 'custom';
      document.querySelectorAll('[data-group="cam-preset"]').forEach(b =>
        b.classList.toggle('active', b.dataset.value === 'custom')
      );
      CameraPreview.render();
    });
  });

  // Character rotation pad
  document.querySelectorAll('#char-rotation-pad .dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#char-rotation-pad .dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.camera.charRotation = parseInt(btn.dataset.value);
      document.getElementById('char-rot-display').textContent = btn.dataset.value + '°';
      CameraPreview.render();
    });
  });

  // Lighting direction
  document.querySelectorAll('.light-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.light-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.lighting.direction = btn.dataset.value;
      CameraPreview.render();
    });
  });

  // Light intensity
  const lightIntensity = document.getElementById('light-intensity');
  lightIntensity.addEventListener('input', () => {
    State.lighting.intensity = parseInt(lightIntensity.value);
    document.getElementById('light-intensity-val').textContent = lightIntensity.value + '%';
    CameraPreview.render();
  });

  /* ── Tabs ── */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('hidden', !c.id.endsWith(target));
      });
      if (target === 'camera') CameraPreview.render();
    });
  });

  /* ── Sprite preview zoom ── */
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    State.previewZoom = Math.min(State.previewZoom * 1.25, 8);
    AnimController.applyZoom();
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    State.previewZoom = Math.max(State.previewZoom / 1.25, 0.1);
    AnimController.applyZoom();
  });

  document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    State.previewZoom = 1;
    AnimController.applyZoom();
  });

  /* ── Export buttons ── */
  document.getElementById('btn-export-png').addEventListener('click', () => Exporter.exportPNG());
  document.getElementById('btn-export-json').addEventListener('click', () => Exporter.exportJSON());
  document.getElementById('btn-export-all').addEventListener('click', () => Exporter.exportAll());
  document.getElementById('btn-export-camera').addEventListener('click', () => Exporter.exportCamera());

  /* ── Clear All ── */
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (!confirm('Remove all animations?')) return;
    State.animations.clear();
    State.activeAnimation = null;
    UI.renderAnimationList();
    AnimController.renderSprite();
    CameraPreview.render();
    AnimController.updateFrameStrip();
    AnimController.updateFrameCounter();
    Toast.show('Cleared all animations', 'info');
  });

  /* ── Playback ── */
  document.getElementById('btn-play-pause').addEventListener('click', () => {
    if (State.playback.playing) AnimController.stopPlayback();
    else AnimController.startPlayback();
  });

  document.getElementById('btn-next-frame').addEventListener('click', () => {
    AnimController.stopPlayback();
    AnimController.nextFrame();
  });

  document.getElementById('btn-prev-frame').addEventListener('click', () => {
    AnimController.stopPlayback();
    AnimController.prevFrame();
  });

  /* ── Global drag-over on body (prevent navigation) ── */
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', (e) => e.preventDefault());

  /* ── Keyboard shortcuts ── */
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === '.') { AnimController.stopPlayback(); AnimController.nextFrame(); }
    if (e.key === 'ArrowLeft'  || e.key === ',') { AnimController.stopPlayback(); AnimController.prevFrame(); }
    if (e.key === ' ') {
      e.preventDefault();
      if (State.playback.playing) AnimController.stopPlayback();
      else AnimController.startPlayback();
    }
  });

  /* ── Initial render ── */
  AnimController.renderSprite();
  AnimController.updateFrameCounter();
});
