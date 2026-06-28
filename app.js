/**
 * Sadewa Sprite Builder — app.js
 * Main application logic: sprite building, camera preview, export
 * ────────────────────────────────────────────────────────────────
 * Modules:
 *   FileManager    — handles drag & drop, file reading, sorting
 *   SpriteBuilder  — canvas-based sprite sheet composer
 *   CameraPreview  — real-time isometric RTS camera simulator
 *   ExportManager  — PNG + JSON export/download
 *   UIController   — DOM interactions, panels, settings
 *   AnimPlayer     — frame animation playback
 *   ToastManager   — notification system
 *   PWAManager     — install prompt, service worker
 */

'use strict';

/* ════════════════════════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════════════════════════ */
const FRAME_SIZES   = [64, 128, 256, 512];
const COLUMN_OPTS   = [4, 8, 16];
const DIRECTIONS    = [
  { deg: 0,   label: 'N',  arrow: '↑' },
  { deg: 45,  label: 'NE', arrow: '↗' },
  { deg: 90,  label: 'E',  arrow: '→' },
  { deg: 135, label: 'SE', arrow: '↘' },
  { deg: 180, label: 'S',  arrow: '↓' },
  { deg: 225, label: 'SW', arrow: '↙' },
  { deg: 270, label: 'W',  arrow: '←' },
  { deg: 315, label: 'NW', arrow: '↖' },
];

const CAMERA_PRESETS = {
  rts: {
    name: 'Classic RTS',
    height: 60,
    rotation: 45,
    projection: 'isometric',
    zoom: 100,
  },
  topdown: {
    name: 'Top Down',
    height: 90,
    rotation: 0,
    projection: 'orthographic',
    zoom: 100,
  },
  moba: {
    name: 'MOBA',
    height: 50,
    rotation: 45,
    projection: 'isometric',
    zoom: 100,
  },
};

/* ════════════════════════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════════════════════════ */
const state = {
  // Files & Groups
  groups: {},          // { groupName: [{ name, file, img, dataUrl }] }
  activeGroup: null,

  // Sprite Settings
  frameSize:    128,
  columns:      8,
  padding:      2,
  autoCrop:     true,
  autoCenter:   true,
  autoPadding:  true,
  transparentBg: true,
  bgColor:      '#000000',

  // Export
  fps: 12,
  projectName: 'sprite',

  // Sprite Sheet
  spriteSheet:  null,  // ImageData or canvas
  spriteCanvas: null,

  // Camera Settings
  camera: {
    height:        60,
    rotation:      45,
    projection:    'isometric',
    zoom:          100,
    charRotation:  0,
    lighting:      'topLeft',
    shadow:        true,
    background:    'checker',
    bgColor:       '#1a2035',
    showGrid:      true,
    showSafeArea:  true,
    preset:        'rts',
  },

  // Animation Player
  player: {
    playing:      false,
    currentFrame: 0,
    fps:          12,
    timer:        null,
  },

  // UI
  activePanel: 'builder',
  rightTab:    'frames',

  // Drag & drop
  isDragging:   false,
};

/* ════════════════════════════════════════════════════════════════
   TOAST MANAGER
   ════════════════════════════════════════════════════════════════ */
const ToastManager = (() => {
  const container = document.getElementById('toast-container');

  function show(message, type = 'info', duration = 3000) {
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return { show };
})();

/* ════════════════════════════════════════════════════════════════
   FILE MANAGER
   ════════════════════════════════════════════════════════════════ */
const FileManager = (() => {

  /**
   * Natural sort for filenames (handles _01, _02, etc.)
   */
  function naturalSort(a, b) {
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  /**
   * Load a File as an HTMLImageElement (async)
   */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ name: file.name, file, img, dataUrl: url, width: img.width, height: img.height });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load: ${file.name}`));
      };
      img.src = url;
    });
  }

  /**
   * Extract group name from file path or folder structure
   * e.g. "Barbarian/idle/idle_01.png" → group "idle", sub "Barbarian"
   */
  function extractGroupName(file) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split('/');

    if (parts.length >= 3) {
      // e.g. Barbarian/idle/frame.png → "idle"
      return parts[parts.length - 2];
    } else if (parts.length === 2) {
      // e.g. idle/frame.png → "idle"
      return parts[0];
    }
    // Single file — guess from filename
    const base = file.name.replace(/\.[^.]+$/, '');
    const match = base.match(/^([a-zA-Z_]+)/);
    return match ? match[1] : 'default';
  }

  /**
   * Process a list of File objects (from drop or input)
   */
  async function processFiles(files) {
    const pngFiles = Array.from(files).filter(f =>
      f.type === 'image/png' || f.name.toLowerCase().endsWith('.png')
    );

    if (!pngFiles.length) {
      ToastManager.show('No PNG files found. Please drop PNG images.', 'warn');
      return;
    }

    LoadingOverlay.show(`Loading ${pngFiles.length} file(s)...`);

    const batchSize = 20;
    const newGroups = {};

    for (let i = 0; i < pngFiles.length; i += batchSize) {
      const batch = pngFiles.slice(i, i + batchSize);
      const loaded = await Promise.allSettled(batch.map(f => loadImage(f)));

      loaded.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          const fileData = result.value;
          const group = extractGroupName(batch[idx]);
          if (!newGroups[group]) newGroups[group] = [];
          newGroups[group].push(fileData);
        }
      });

      LoadingOverlay.setProgress(Math.round(((i + batchSize) / pngFiles.length) * 100));
      await nextFrame();
    }

    // Sort each group naturally
    Object.keys(newGroups).forEach(g => {
      newGroups[g].sort(naturalSort);
    });

    // Merge with existing state
    Object.keys(newGroups).forEach(g => {
      if (state.groups[g]) {
        state.groups[g] = [...state.groups[g], ...newGroups[g]];
        state.groups[g].sort(naturalSort);
      } else {
        state.groups[g] = newGroups[g];
      }
    });

    // Activate first group if none active
    if (!state.activeGroup) {
      state.activeGroup = Object.keys(state.groups)[0];
    }

    LoadingOverlay.hide();

    const total = Object.values(state.groups).reduce((a, b) => a + b.length, 0);
    ToastManager.show(`Loaded ${total} frame(s) across ${Object.keys(state.groups).length} group(s)`, 'success');

    UIController.renderGroupList();
    UIController.renderFrameGrid();
    SpriteBuilder.build();
    UIController.updateStats();
  }

  /**
   * Clear all loaded files
   */
  function clearAll() {
    // Revoke all object URLs
    Object.values(state.groups).forEach(group => {
      group.forEach(f => URL.revokeObjectURL(f.dataUrl));
    });
    state.groups = {};
    state.activeGroup = null;
    state.spriteSheet = null;
    state.spriteCanvas = null;
    UIController.renderGroupList();
    UIController.renderFrameGrid();
    UIController.clearSpriteCanvas();
    UIController.updateStats();
    ToastManager.show('All files cleared', 'info');
  }

  return { processFiles, clearAll, naturalSort };
})();

/* ════════════════════════════════════════════════════════════════
   SPRITE BUILDER
   ════════════════════════════════════════════════════════════════ */
const SpriteBuilder = (() => {

  /**
   * Auto-crop: find bounding box of non-transparent pixels
   */
  function autoCropBounds(img) {
    const { frameSize } = state;
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = img.width;
    tmpCanvas.height = img.height;
    const ctx = tmpCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
    let hasContent = false;

    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const alpha = data[(y * img.width + x) * 4 + 3];
        if (alpha > 8) {
          hasContent = true;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!hasContent) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /**
   * Draw a single frame onto the sprite sheet at (col, row)
   */
  function drawFrame(ctx, frameData, col, row, frameSize, padding) {
    const { img } = frameData;
    const destX = col * frameSize;
    const destY = row * frameSize;
    const innerSize = frameSize - padding * 2;

    if (state.autoCrop) {
      const bounds = autoCropBounds(img);
      if (!bounds) return;

      let scale = 1;
      if (state.autoCenter) {
        const scaleX = innerSize / bounds.w;
        const scaleY = innerSize / bounds.h;
        scale = Math.min(scaleX, scaleY, 1); // Never upscale beyond original
      }

      const drawW = bounds.w * scale;
      const drawH = bounds.h * scale;
      const offsetX = state.autoCenter ? (innerSize - drawW) / 2 : 0;
      const offsetY = state.autoCenter ? (innerSize - drawH) / 2 : 0;

      ctx.drawImage(
        img,
        bounds.x, bounds.y, bounds.w, bounds.h,
        destX + padding + offsetX, destY + padding + offsetY,
        drawW, drawH
      );
    } else {
      // Draw full image scaled to frame
      const scale = Math.min(innerSize / img.width, innerSize / img.height, 1);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const offsetX = state.autoCenter ? (innerSize - drawW) / 2 : 0;
      const offsetY = state.autoCenter ? (innerSize - drawH) / 2 : 0;

      ctx.drawImage(
        img,
        destX + padding + offsetX, destY + padding + offsetY,
        drawW, drawH
      );
    }
  }

  /**
   * Build the sprite sheet from the active group
   */
  async function build() {
    const group = state.groups[state.activeGroup];
    if (!group || group.length === 0) {
      UIController.clearSpriteCanvas();
      return;
    }

    const { frameSize, columns } = state;
    const padding = state.autoPadding ? state.padding : 0;
    const rows = Math.ceil(group.length / columns);
    const sheetW = frameSize * columns;
    const sheetH = frameSize * rows;

    const canvas = document.createElement('canvas');
    canvas.width  = sheetW;
    canvas.height = sheetH;
    const ctx = canvas.getContext('2d');

    // Background
    if (!state.transparentBg) {
      ctx.fillStyle = state.bgColor;
      ctx.fillRect(0, 0, sheetW, sheetH);
    }

    // Draw all frames
    for (let i = 0; i < group.length; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      drawFrame(ctx, group[i], col, row, frameSize, padding);
      if (i % 10 === 0) await nextFrame();
    }

    state.spriteCanvas = canvas;
    UIController.renderSpriteSheet(canvas);
    CameraPreview.updateSprite(canvas, group);
    UIController.updateStats();
  }

  return { build, autoCropBounds };
})();

/* ════════════════════════════════════════════════════════════════
   CAMERA PREVIEW
   ════════════════════════════════════════════════════════════════ */
const CameraPreview = (() => {
  let canvas = null;
  let ctx    = null;
  let spriteFrames = [];
  let spriteSheet  = null;
  let rafId  = null;
  let currentFrameIdx = 0;
  let lastFrameTime   = 0;
  let gridCanvas = null;
  let gridCtx    = null;

  function init() {
    canvas = document.getElementById('camera-canvas');
    ctx    = canvas.getContext('2d');
    gridCanvas = document.getElementById('camera-grid-canvas');
    gridCtx    = gridCanvas.getContext('2d');
    resize();
  }

  function resize() {
    const vp = document.getElementById('camera-viewport');
    if (!vp || !canvas) return;
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    canvas.width  = w;
    canvas.height = h;
    if (gridCanvas) { gridCanvas.width = w; gridCanvas.height = h; }
    render();
  }

  /**
   * Update sprite source from sprite builder
   */
  function updateSprite(sheet, frames) {
    spriteSheet  = sheet;
    spriteFrames = frames || [];
    render();
  }

  /**
   * Extract a single frame from the sprite sheet
   */
  function getFrameCanvas(frameIdx) {
    if (!spriteSheet || !spriteFrames.length) return null;
    const { frameSize, columns } = state;
    const col = frameIdx % columns;
    const row = Math.floor(frameIdx / columns);

    const fc = document.createElement('canvas');
    fc.width  = frameSize;
    fc.height = frameSize;
    const fctx = fc.getContext('2d');
    fctx.drawImage(spriteSheet, col * frameSize, row * frameSize, frameSize, frameSize, 0, 0, frameSize, frameSize);
    return fc;
  }

  /**
   * Apply isometric camera transform and draw sprite
   */
  function render() {
    if (!canvas || !ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const cam = state.camera;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Background
    drawBackground(ctx, W, H, cam);

    // Ground grid
    if (cam.showGrid) drawGrid(ctx, W, H, cam);

    // Sprite
    if (spriteSheet && spriteFrames.length > 0) {
      const frameCanvas = getFrameCanvas(state.player.currentFrame % spriteFrames.length);
      if (frameCanvas) drawSprite(ctx, frameCanvas, W, H, cam);
    } else {
      drawPlaceholder(ctx, W, H, cam);
    }

    // Safe area
    if (cam.showSafeArea) drawSafeArea(ctx, W, H);

    // Overlay info
    updateOverlayInfo();
  }

  function drawBackground(ctx, W, H, cam) {
    if (cam.background === 'transparent') {
      return;
    } else if (cam.background === 'checker') {
      const size = 20;
      for (let y = 0; y < H; y += size) {
        for (let x = 0; x < W; x += size) {
          ctx.fillStyle = ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0)
            ? '#111827' : '#0d1321';
          ctx.fillRect(x, y, size, size);
        }
      }
    } else {
      ctx.fillStyle = cam.bgColor;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawGrid(ctx, W, H, cam) {
    const cx = W / 2;
    const cy = H / 2 + 60;
    const zoom = cam.zoom / 100;
    const heightFactor = Math.cos(cam.height * Math.PI / 180);
    const rotRad = cam.rotation * Math.PI / 180;
    const tileSize = 40 * zoom;
    const gridCount = 8;

    ctx.save();
    ctx.translate(cx, cy);

    // Draw iso grid
    ctx.strokeStyle = 'rgba(124,58,237,0.2)';
    ctx.lineWidth = 0.8;

    for (let i = -gridCount; i <= gridCount; i++) {
      ctx.beginPath();
      for (let j = -gridCount; j <= gridCount; j++) {
        const worldX = (i - j) * tileSize * 0.5;
        const worldY = (i + j) * tileSize * 0.5 * heightFactor;
        const cosR = Math.cos(rotRad);
        const sinR = Math.sin(rotRad);
        const rx = worldX * cosR - worldY * sinR;
        const ry = worldX * sinR + worldY * cosR;

        if (j === -gridCount) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      }
      ctx.stroke();
    }

    for (let j = -gridCount; j <= gridCount; j++) {
      ctx.beginPath();
      for (let i = -gridCount; i <= gridCount; i++) {
        const worldX = (i - j) * tileSize * 0.5;
        const worldY = (i + j) * tileSize * 0.5 * heightFactor;
        const cosR = Math.cos(rotRad);
        const sinR = Math.sin(rotRad);
        const rx = worldX * cosR - worldY * sinR;
        const ry = worldX * sinR + worldY * cosR;

        if (i === -gridCount) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawSprite(ctx, frameCanvas, W, H, cam) {
    const zoom = cam.zoom / 100;
    const heightFactor = Math.cos(cam.height * Math.PI / 180);
    const { frameSize } = state;

    const cx = W / 2;
    const cy = H / 2;

    ctx.save();
    ctx.translate(cx, cy);

    const rotRad = cam.rotation * Math.PI / 180;
    if (cam.projection === 'isometric') {
      ctx.transform(1, 0, 0, heightFactor, 0, 0);
    }
    ctx.rotate(rotRad);

    // Char rotation
    const charRot = cam.charRotation * Math.PI / 180;
    ctx.rotate(charRot);

    const scaledSize = frameSize * zoom;

    // Shadow
    if (cam.shadow) {
      ctx.save();
      ctx.scale(1, 0.3);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(0, scaledSize * 0.4, scaledSize * 0.3, scaledSize * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Lighting overlay
    const lightAlpha = 0.15;
    let lightGrad = null;
    if (cam.lighting !== 'none') {
      const lightDirs = {
        topLeft:     { x: -scaledSize * 0.5, y: -scaledSize * 0.5 },
        topRight:    { x:  scaledSize * 0.5, y: -scaledSize * 0.5 },
        bottomLeft:  { x: -scaledSize * 0.5, y:  scaledSize * 0.5 },
        bottomRight: { x:  scaledSize * 0.5, y:  scaledSize * 0.5 },
      };
      const ld = lightDirs[cam.lighting];
      if (ld) {
        lightGrad = ctx.createRadialGradient(
          ld.x, ld.y, 0,
          -ld.x * 0.5, -ld.y * 0.5, scaledSize
        );
        lightGrad.addColorStop(0, `rgba(255,240,200,${lightAlpha})`);
        lightGrad.addColorStop(1, `rgba(20,30,60,${lightAlpha * 0.5})`);
      }
    }

    // Draw sprite
    ctx.drawImage(frameCanvas, -scaledSize / 2, -scaledSize / 2, scaledSize, scaledSize);

    // Apply lighting
    if (lightGrad) {
      ctx.fillStyle = lightGrad;
      ctx.fillRect(-scaledSize / 2, -scaledSize / 2, scaledSize, scaledSize);
    }

    ctx.restore();
  }

  function drawPlaceholder(ctx, W, H, cam) {
    const cx = W / 2;
    const cy = H / 2;
    const zoom = cam.zoom / 100;
    const size = 80 * zoom;

    ctx.save();
    ctx.translate(cx, cy);

    // Dashed border
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(124,58,237,0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-size / 2, -size / 2, size, size);
    ctx.setLineDash([]);

    // Icon
    ctx.fillStyle = 'rgba(124,58,237,0.3)';
    ctx.font = `${size * 0.4}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎮', 0, 0);

    ctx.restore();
  }

  function drawSafeArea(ctx, W, H) {
    const margin = 20;
    const x = margin;
    const y = margin;
    const w = W - margin * 2;
    const h = H - margin * 2;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(245,158,11,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = 'rgba(245,158,11,0.6)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('SAFE AREA', x + 4, y + 4);
    ctx.restore();
  }

  function updateOverlayInfo() {
    const cam = state.camera;
    const el  = document.getElementById('camera-info');
    if (!el) return;
    el.innerHTML = `
      <div>Preset <span class="info-val">${cam.preset?.toUpperCase() || 'CUSTOM'}</span></div>
      <div>Height <span class="info-val">${cam.height}°</span></div>
      <div>Rotation <span class="info-val">${cam.rotation}°</span></div>
      <div>Zoom <span class="info-val">${cam.zoom}%</span></div>
      <div>Proj. <span class="info-val">${cam.projection}</span></div>
      <div>Frame <span class="info-val">${state.player.currentFrame + 1}/${Math.max(1, spriteFrames.length)}</span></div>
    `;
  }

  /**
   * Animation loop for live preview
   */
  function startAnimLoop() {
    if (rafId) cancelAnimationFrame(rafId);

    function loop(ts) {
      if (state.player.playing && spriteFrames.length > 1) {
        const interval = 1000 / state.player.fps;
        if (ts - lastFrameTime > interval) {
          state.player.currentFrame = (state.player.currentFrame + 1) % spriteFrames.length;
          lastFrameTime = ts;
          UIController.updateScrubber();
        }
      }
      render();
      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);
  }

  function stopAnimLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  return { init, resize, render, updateSprite, startAnimLoop, stopAnimLoop };
})();

/* ════════════════════════════════════════════════════════════════
   EXPORT MANAGER
   ════════════════════════════════════════════════════════════════ */
const ExportManager = (() => {

  /**
   * Generate JSON metadata
   */
  function buildJSON() {
    const group = state.groups[state.activeGroup] || [];
    return {
      name:        state.projectName || state.activeGroup || 'sprite',
      group:       state.activeGroup || 'default',
      frameWidth:  state.frameSize,
      frameHeight: state.frameSize,
      columns:     state.columns,
      rows:        Math.ceil(group.length / state.columns),
      frames:      group.length,
      fps:         state.fps,
      padding:     state.autoPadding ? state.padding : 0,
      autoCrop:    state.autoCrop,
      autoCenter:  state.autoCenter,
      files:       group.map((f, i) => ({
        index: i,
        name:  f.name,
        col:   i % state.columns,
        row:   Math.floor(i / state.columns),
        x:     (i % state.columns) * state.frameSize,
        y:     Math.floor(i / state.columns) * state.frameSize,
        width: state.frameSize,
        height: state.frameSize,
      })),
    };
  }

  /**
   * Download a blob as a file
   */
  function downloadBlob(blob, filename) {
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href     = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Export sprite sheet PNG
   */
  function exportPNG() {
    if (!state.spriteCanvas) {
      ToastManager.show('No sprite sheet to export. Load some PNG files first.', 'warn');
      return;
    }
    state.spriteCanvas.toBlob((blob) => {
      const name = `${state.projectName || state.activeGroup || 'sprite'}.png`;
      downloadBlob(blob, name);
      ToastManager.show(`Exported: ${name}`, 'success');
    }, 'image/png');
  }

  /**
   * Export individual frames
   */
  async function exportIndividual() {
    const group = state.groups[state.activeGroup];
    if (!group || !group.length) {
      ToastManager.show('No frames to export.', 'warn');
      return;
    }
    if (!state.spriteCanvas) {
      ToastManager.show('Build sprite sheet first.', 'warn');
      return;
    }

    // Export each frame as individual PNG
    for (let i = 0; i < group.length; i++) {
      const col = i % state.columns;
      const row = Math.floor(i / state.columns);
      const fc = document.createElement('canvas');
      fc.width = fc.height = state.frameSize;
      const fctx = fc.getContext('2d');
      fctx.drawImage(
        state.spriteCanvas,
        col * state.frameSize, row * state.frameSize,
        state.frameSize, state.frameSize,
        0, 0, state.frameSize, state.frameSize
      );
      await new Promise((res) => {
        fc.toBlob((blob) => {
          const name = `${state.activeGroup}_${String(i).padStart(3, '0')}.png`;
          downloadBlob(blob, name);
          setTimeout(res, 100);
        }, 'image/png');
      });
    }

    ToastManager.show(`Exported ${group.length} individual frames!`, 'success');
  }

  /**
   * Export JSON metadata
   */
  function exportJSON() {
    const data = buildJSON();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const name = `${state.projectName || state.activeGroup || 'sprite'}.json`;
    downloadBlob(blob, name);
    ToastManager.show(`Exported: ${name}`, 'success');
  }

  /**
   * Export both PNG + JSON
   */
  function exportAll() {
    if (!state.spriteCanvas) {
      ToastManager.show('Build sprite sheet first.', 'warn');
      return;
    }
    exportPNG();
    setTimeout(() => exportJSON(), 500);
  }

  return { exportPNG, exportJSON, exportAll, exportIndividual, buildJSON };
})();

/* ════════════════════════════════════════════════════════════════
   LOADING OVERLAY
   ════════════════════════════════════════════════════════════════ */
const LoadingOverlay = (() => {
  let el = null;
  let textEl = null;
  let barEl  = null;

  function init() {
    el     = document.getElementById('loading-overlay');
    textEl = document.getElementById('loading-text');
    barEl  = document.getElementById('loading-bar-fill');
  }

  function show(msg = 'Processing...') {
    if (!el) return;
    if (textEl) textEl.textContent = msg;
    if (barEl)  barEl.style.width = '0%';
    el.classList.add('visible');
  }

  function setProgress(pct) {
    if (barEl) barEl.style.width = `${pct}%`;
  }

  function hide() {
    if (!el) return;
    if (barEl) barEl.style.width = '100%';
    setTimeout(() => el.classList.remove('visible'), 300);
  }

  return { init, show, setProgress, hide };
})();

/* ════════════════════════════════════════════════════════════════
   UI CONTROLLER
   ════════════════════════════════════════════════════════════════ */
const UIController = (() => {

  /* ── Panel switching ───────────────────────────────────────── */
  function switchPanel(name) {
    state.activePanel = name;
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.header-tab').forEach(t => t.classList.remove('active'));

    const panel = document.getElementById(`panel-${name}`);
    if (panel) panel.classList.add('active');

    const tab = document.querySelector(`[data-tab="${name}"]`);
    if (tab) tab.classList.add('active');

    if (name === 'camera') {
      CameraPreview.resize();
      CameraPreview.startAnimLoop();
    } else {
      CameraPreview.stopAnimLoop();
    }
  }

  /* ── Right Panel Tab switching ─────────────────────────────── */
  function switchRightTab(name) {
    state.rightTab = name;
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.right-panel-section').forEach(s => s.classList.add('hidden'));

    const tab = document.querySelector(`[data-rtab="${name}"]`);
    if (tab) tab.classList.add('active');

    const sec = document.getElementById(`rt-${name}`);
    if (sec) sec.classList.remove('hidden');
  }

  /* ── Group List ─────────────────────────────────────────────── */
  function renderGroupList() {
    const container = document.getElementById('group-list');
    if (!container) return;

    if (!Object.keys(state.groups).length) {
      container.innerHTML = `
        <div class="empty-state" style="padding:20px">
          <div class="empty-icon">📂</div>
          <div class="empty-sub">Drop PNG files to start</div>
        </div>`;
      return;
    }

    container.innerHTML = '';
    Object.keys(state.groups).forEach(groupName => {
      const frames = state.groups[groupName];
      const isActive = groupName === state.activeGroup;

      const group = document.createElement('div');
      group.className = 'anim-group';

      group.innerHTML = `
        <div class="anim-group-header ${isActive ? 'open' : ''}" data-group="${groupName}">
          <div class="anim-group-name">
            <span>🎬</span>
            <span>${groupName}</span>
            <span class="anim-group-count">${frames.length}</span>
          </div>
          <div class="anim-group-actions">
            <button class="btn btn-sm btn-secondary btn-icon" onclick="activateGroup('${groupName}')" title="Load group">▶</button>
            <button class="btn btn-sm btn-secondary btn-icon" onclick="removeGroup('${groupName}')" title="Remove group">✕</button>
          </div>
        </div>
        ${isActive ? `
        <ul class="file-list">
          ${frames.map((f, i) => `
            <li class="file-item" data-idx="${i}" onclick="previewFrame(${i})">
              <span class="file-icon">🖼</span>
              <span class="file-name">${f.name}</span>
              <span class="file-size">${f.width}×${f.height}</span>
            </li>`).join('')}
        </ul>` : ''}
      `;

      container.appendChild(group);
    });
  }

  /* ── Frame Grid ─────────────────────────────────────────────── */
  function renderFrameGrid() {
    const grid = document.getElementById('frames-grid');
    if (!grid) return;

    const group = state.groups[state.activeGroup];
    if (!group || !group.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon" style="font-size:32px">🎞</div>
        <div class="empty-sub">No frames loaded</div>
      </div>`;
      return;
    }

    grid.innerHTML = '';
    group.forEach((f, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'frame-thumb' + (i === state.player.currentFrame ? ' selected' : '');
      thumb.title = f.name;
      thumb.dataset.idx = i;

      const img = document.createElement('img');
      img.src = f.dataUrl;
      img.loading = 'lazy';

      const num = document.createElement('span');
      num.className = 'frame-number';
      num.textContent = i + 1;

      thumb.appendChild(img);
      thumb.appendChild(num);
      thumb.addEventListener('click', () => previewFrame(i));
      grid.appendChild(thumb);
    });
  }

  /* ── Sprite Sheet ───────────────────────────────────────────── */
  function renderSpriteSheet(canvas) {
    const container = document.getElementById('sprite-canvas-container');
    if (!container) return;

    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'sprite-canvas-container';
    wrapper.style.cssText = `
      display:inline-block;
      background-image: linear-gradient(45deg,#1a1d26 25%,transparent 25%),
        linear-gradient(-45deg,#1a1d26 25%,transparent 25%),
        linear-gradient(45deg,transparent 75%,#1a1d26 75%),
        linear-gradient(-45deg,transparent 75%,#1a1d26 75%);
      background-size: 12px 12px;
      background-position: 0 0, 0 6px, 6px -6px, -6px 0;
      background-color: #141720;
      border-radius: 8px;
      overflow: hidden;
    `;

    const c = canvas.cloneNode(true);
    const cloneCtx = c.getContext('2d');
    cloneCtx.drawImage(canvas, 0, 0);

    // Apply zoom (default 1:1)
    c.style.maxWidth = '100%';
    wrapper.appendChild(c);

    // Grid overlay
    const zoom = parseInt(document.getElementById('preview-zoom')?.value || 100) / 100;
    c.style.width  = `${canvas.width  * zoom}px`;
    c.style.height = `${canvas.height * zoom}px`;

    container.appendChild(wrapper);

    // Draw grid lines if enabled
    const showGrid = document.getElementById('toggle-grid')?.checked;
    if (showGrid) {
      overlayGrid(c, canvas.width, canvas.height);
    }

    updateStats();
  }

  function overlayGrid(canvas, sheetW, sheetH) {
    const { frameSize, columns } = state;
    const rows = Math.ceil((state.groups[state.activeGroup]?.length || 0) / columns);

    const gc = document.createElement('canvas');
    gc.width  = sheetW;
    gc.height = sheetH;
    gc.style.cssText = canvas.style.cssText;
    gc.style.position = 'absolute';
    gc.style.top = '0';
    gc.style.left = '0';
    gc.style.opacity = '0.5';
    gc.style.pointerEvents = 'none';

    const gctx = gc.getContext('2d');
    gctx.strokeStyle = 'rgba(124,58,237,0.6)';
    gctx.lineWidth = 1;

    for (let c = 1; c < columns; c++) {
      gctx.beginPath();
      gctx.moveTo(c * frameSize, 0);
      gctx.lineTo(c * frameSize, sheetH);
      gctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      gctx.beginPath();
      gctx.moveTo(0, r * frameSize);
      gctx.lineTo(sheetW, r * frameSize);
      gctx.stroke();
    }

    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(gc);
  }

  function clearSpriteCanvas() {
    const container = document.getElementById('sprite-canvas-container');
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎨</div>
          <div class="empty-title">No Sprite Sheet</div>
          <div class="empty-sub">Drop PNG files into the builder to generate a sprite sheet</div>
        </div>`;
    }
  }

  /* ── Stats ──────────────────────────────────────────────────── */
  function updateStats() {
    const group = state.groups[state.activeGroup];
    const frameCount = group?.length || 0;
    const cols = state.columns;
    const rows = frameCount ? Math.ceil(frameCount / cols) : 0;
    const sheetW = cols * state.frameSize;
    const sheetH = rows * state.frameSize;

    setText('stat-frames',     frameCount);
    setText('stat-cols',       cols);
    setText('stat-rows',       rows);
    setText('stat-sheet-size', frameCount ? `${sheetW}×${sheetH}` : '—');
    setText('stat-frame-size', `${state.frameSize}×${state.frameSize}`);
    setText('stat-groups',     Object.keys(state.groups).length);
    setText('stat-fps',        state.fps);

    // JSON preview
    updateJSONPreview();
  }

  function updateJSONPreview() {
    const el = document.getElementById('json-preview');
    if (!el) return;
    if (!state.activeGroup) { el.textContent = '// No data yet'; return; }
    const data = ExportManager.buildJSON();
    el.textContent = JSON.stringify(data, null, 2);
  }

  /* ── Scrubber ───────────────────────────────────────────────── */
  function updateScrubber() {
    const group = state.groups[state.activeGroup];
    const total = group?.length || 1;
    const pct = (state.player.currentFrame / Math.max(total - 1, 1)) * 100;

    // Update both scrubber bars (builder + camera)
    ['scrubber-fill', 'cam-scrubber-fill'].forEach(id => {
      const fill = document.getElementById(id);
      if (fill) fill.style.width = `${pct}%`;
    });

    ['frame-label', 'cam-frame-label'].forEach(id => {
      const label = document.getElementById(id);
      if (label) label.textContent = `${state.player.currentFrame + 1} / ${total}`;
    });

    // Highlight selected thumb
    document.querySelectorAll('.frame-thumb').forEach((t, i) => {
      t.classList.toggle('selected', i === state.player.currentFrame);
    });
  }

  /* ── Collapse sections ─────────────────────────────────────── */
  function initCollapsibles() {
    document.querySelectorAll('.section-header').forEach(header => {
      const body = header.nextElementSibling;
      header.classList.add('open');

      header.addEventListener('click', () => {
        const isOpen = header.classList.toggle('open');
        body.style.display = isOpen ? '' : 'none';
      });
    });
  }

  /* ── Helper ─────────────────────────────────────────────────── */
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  return {
    switchPanel, switchRightTab,
    renderGroupList, renderFrameGrid,
    renderSpriteSheet, clearSpriteCanvas,
    updateStats, updateScrubber,
    initCollapsibles,
  };
})();

/* ════════════════════════════════════════════════════════════════
   PWA MANAGER
   ════════════════════════════════════════════════════════════════ */
const PWAManager = (() => {
  let deferredPrompt = null;

  function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('[PWA] SW registered:', reg.scope))
        .catch(err => console.warn('[PWA] SW failed:', err));
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      document.getElementById('install-banner')?.classList.add('visible');
    });

    window.addEventListener('appinstalled', () => {
      document.getElementById('install-banner')?.classList.remove('visible');
      ToastManager.show('Sadewa Sprite Builder installed! 🎉', 'success', 5000);
    });

    document.getElementById('btn-install')?.addEventListener('click', () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(res => {
          deferredPrompt = null;
          if (res.outcome === 'accepted') {
            ToastManager.show('Installing...', 'info');
          }
        });
      }
    });

    document.getElementById('btn-dismiss-install')?.addEventListener('click', () => {
      document.getElementById('install-banner')?.classList.remove('visible');
    });
  }

  return { init };
})();

/* ════════════════════════════════════════════════════════════════
   GLOBAL HELPERS
   ════════════════════════════════════════════════════════════════ */
function nextFrame() {
  return new Promise(r => requestAnimationFrame(r));
}

function activateGroup(name) {
  state.activeGroup = name;
  state.player.currentFrame = 0;
  UIController.renderGroupList();
  UIController.renderFrameGrid();
  SpriteBuilder.build();
  UIController.updateStats();
}

function removeGroup(name) {
  state.groups[name]?.forEach(f => URL.revokeObjectURL(f.dataUrl));
  delete state.groups[name];
  if (state.activeGroup === name) {
    state.activeGroup = Object.keys(state.groups)[0] || null;
  }
  UIController.renderGroupList();
  UIController.renderFrameGrid();
  SpriteBuilder.build();
  UIController.updateStats();
  ToastManager.show(`Removed group: ${name}`, 'info');
}

function previewFrame(idx) {
  state.player.currentFrame = idx;
  UIController.updateScrubber();
  CameraPreview.render();
}

/* ════════════════════════════════════════════════════════════════
   APP INIT
   ════════════════════════════════════════════════════════════════ */
function initApp() {
  LoadingOverlay.init();
  CameraPreview.init();
  UIController.initCollapsibles();
  PWAManager.init();
  setupDropZone();
  setupControls();
  UIController.clearSpriteCanvas();
  UIController.updateStats();
  UIController.switchPanel('builder');

  // Listen for resize
  window.addEventListener('resize', () => {
    if (state.activePanel === 'camera') CameraPreview.resize();
  });

  ToastManager.show('Sadewa Sprite Builder ready! 🎮', 'info', 3000);
}

/* ─── Drop Zone Setup ──────────────────────────────────────────── */
function setupDropZone() {
  const zone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');

  if (!zone) return;

  ['dragenter', 'dragover'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
    });
  });

  zone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length) FileManager.processFiles(files);
  });

  zone.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', (e) => {
    if (e.target.files.length) FileManager.processFiles(e.target.files);
    e.target.value = '';
  });

  folderInput?.addEventListener('change', (e) => {
    if (e.target.files.length) FileManager.processFiles(e.target.files);
    e.target.value = '';
  });

  // Global drag and drop
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length) FileManager.processFiles(files);
  });
}

/* ─── Controls Setup ────────────────────────────────────────────── */
function setupControls() {

  /* ── Header Tabs ─────────────────────────────────────────────── */
  document.querySelectorAll('.header-tab').forEach(tab => {
    tab.addEventListener('click', () => UIController.switchPanel(tab.dataset.tab));
  });

  /* ── Right Panel Tabs ────────────────────────────────────────── */
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => UIController.switchRightTab(tab.dataset.rtab));
  });

  /* ── Frame Size ──────────────────────────────────────────────── */
  document.querySelectorAll('[data-framesize]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.frameSize = parseInt(btn.dataset.framesize);
      document.querySelectorAll('[data-framesize]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      SpriteBuilder.build();
      UIController.updateStats();
    });
  });

  /* ── Columns ─────────────────────────────────────────────────── */
  document.querySelectorAll('[data-columns]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.columns = parseInt(btn.dataset.columns);
      document.querySelectorAll('[data-columns]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      SpriteBuilder.build();
      UIController.updateStats();
    });
  });

  /* ── Toggle Options ──────────────────────────────────────────── */
  const toggleMap = {
    'toggle-autocrop':    () => { state.autoCrop    = !state.autoCrop;    SpriteBuilder.build(); },
    'toggle-autocenter':  () => { state.autoCenter  = !state.autoCenter;  SpriteBuilder.build(); },
    'toggle-autopadding': () => { state.autoPadding = !state.autoPadding; SpriteBuilder.build(); },
    'toggle-transparent': () => {
      state.transparentBg = !state.transparentBg;
      const row = document.getElementById('bg-color-row');
      if (row) row.style.display = state.transparentBg ? 'none' : 'flex';
      SpriteBuilder.build();
    },
    'toggle-grid': () => { SpriteBuilder.build(); },
  };

  Object.keys(toggleMap).forEach(id => {
    document.getElementById(id)?.addEventListener('change', toggleMap[id]);
  });

  /* ── Padding ─────────────────────────────────────────────────── */
  const paddingInput = document.getElementById('padding-input');
  paddingInput?.addEventListener('input', (e) => {
    state.padding = Math.max(0, Math.min(32, parseInt(e.target.value) || 0));
    SpriteBuilder.build();
  });

  /* ── FPS ─────────────────────────────────────────────────────── */
  const fpsInput = document.getElementById('fps-input');
  fpsInput?.addEventListener('input', (e) => {
    state.fps = Math.max(1, Math.min(60, parseInt(e.target.value) || 12));
    state.player.fps = state.fps;
    UIController.updateStats();
  });

  /* ── Project Name ────────────────────────────────────────────── */
  const nameInput = document.getElementById('project-name');
  nameInput?.addEventListener('input', (e) => {
    state.projectName = e.target.value.trim();
  });

  /* ── BG Color ────────────────────────────────────────────────── */
  document.getElementById('bg-color')?.addEventListener('input', (e) => {
    state.bgColor = e.target.value;
    SpriteBuilder.build();
  });

  /* ── Preview Zoom ────────────────────────────────────────────── */
  const previewZoom = document.getElementById('preview-zoom');
  const previewZoomVal = document.getElementById('preview-zoom-val');
  previewZoom?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    if (previewZoomVal) previewZoomVal.textContent = `${val}%`;
    if (state.spriteCanvas) UIController.renderSpriteSheet(state.spriteCanvas);
  });

  /* ── Export Buttons ──────────────────────────────────────────── */
  document.getElementById('btn-export-png')?.addEventListener('click', ExportManager.exportPNG);
  document.getElementById('btn-export-json')?.addEventListener('click', ExportManager.exportJSON);
  document.getElementById('btn-export-all')?.addEventListener('click', ExportManager.exportAll);
  document.getElementById('btn-export-individual')?.addEventListener('click', ExportManager.exportIndividual);

  /* ── Clear button ────────────────────────────────────────────── */
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (confirm('Clear all loaded files?')) FileManager.clearAll();
  });

  /* ── Build button ────────────────────────────────────────────── */
  document.getElementById('btn-build')?.addEventListener('click', SpriteBuilder.build);

  /* ── Folder open button ──────────────────────────────────────── */
  document.getElementById('btn-open-folder')?.addEventListener('click', () => {
    document.getElementById('folder-input')?.click();
  });

  document.getElementById('btn-open-files')?.addEventListener('click', () => {
    document.getElementById('file-input')?.click();
  });

  /* ── Camera Controls ─────────────────────────────────────────── */
  setupCameraControls();

  /* ── Animation Player ────────────────────────────────────────── */
  setupAnimPlayer();
}

/* ─── Camera Controls ─────────────────────────────────────────── */
function setupCameraControls() {
  // Height slider
  const heightSlider = document.getElementById('cam-height');
  const heightVal    = document.getElementById('cam-height-val');
  heightSlider?.addEventListener('input', (e) => {
    state.camera.height = parseInt(e.target.value);
    if (heightVal) heightVal.textContent = `${state.camera.height}°`;
    state.camera.preset = 'custom';
    updatePresetButtons();
  });

  // Zoom slider
  const zoomSlider = document.getElementById('cam-zoom');
  const zoomVal    = document.getElementById('cam-zoom-val');
  zoomSlider?.addEventListener('input', (e) => {
    state.camera.zoom = parseInt(e.target.value);
    if (zoomVal) zoomVal.textContent = `${state.camera.zoom}%`;
    state.camera.preset = 'custom';
    updatePresetButtons();
  });

  // Projection
  document.querySelectorAll('[data-projection]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.camera.projection = btn.dataset.projection;
      document.querySelectorAll('[data-projection]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.camera.preset = 'custom';
      updatePresetButtons();
    });
  });

  // Camera Rotation (direction buttons)
  document.querySelectorAll('[data-camrot]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.camera.rotation = parseInt(btn.dataset.camrot);
      document.querySelectorAll('[data-camrot]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.camera.preset = 'custom';
      updatePresetButtons();
    });
  });

  // Char Rotation (direction buttons)
  document.querySelectorAll('[data-charrot]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.camera.charRotation = parseInt(btn.dataset.charrot);
      document.querySelectorAll('[data-charrot]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Lighting
  document.querySelectorAll('[data-lighting]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.camera.lighting = btn.dataset.lighting;
      document.querySelectorAll('[data-lighting]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Shadow toggle
  document.getElementById('toggle-shadow')?.addEventListener('change', (e) => {
    state.camera.shadow = e.target.checked;
  });

  // Background
  document.querySelectorAll('[data-cambg]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.camera.background = btn.dataset.cambg;
      document.querySelectorAll('[data-cambg]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bgColorRow = document.getElementById('cam-bg-color-row');
      if (bgColorRow) bgColorRow.style.display = (state.camera.background === 'solid') ? 'flex' : 'none';
    });
  });

  // BG solid color
  document.getElementById('cam-bg-color')?.addEventListener('input', (e) => {
    state.camera.bgColor = e.target.value;
  });

  // Grid toggle
  document.getElementById('toggle-cam-grid')?.addEventListener('change', (e) => {
    state.camera.showGrid = e.target.checked;
  });

  // Safe area toggle
  document.getElementById('toggle-safe-area')?.addEventListener('change', (e) => {
    state.camera.showSafeArea = e.target.checked;
  });

  // Presets
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = CAMERA_PRESETS[btn.dataset.preset];
      if (!preset) return;

      state.camera.height     = preset.height;
      state.camera.rotation   = preset.rotation;
      state.camera.projection = preset.projection;
      state.camera.zoom       = preset.zoom;
      state.camera.preset     = btn.dataset.preset;

      // Update slider values
      const hs = document.getElementById('cam-height');
      const hv = document.getElementById('cam-height-val');
      if (hs) hs.value = preset.height;
      if (hv) hv.textContent = `${preset.height}°`;

      const zs = document.getElementById('cam-zoom');
      const zv = document.getElementById('cam-zoom-val');
      if (zs) zs.value = preset.zoom;
      if (zv) zv.textContent = `${preset.zoom}%`;

      // Update projection buttons
      document.querySelectorAll('[data-projection]').forEach(b => {
        b.classList.toggle('active', b.dataset.projection === preset.projection);
      });

      // Update rotation buttons
      document.querySelectorAll('[data-camrot]').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.camrot) === preset.rotation);
      });

      updatePresetButtons();
      ToastManager.show(`Preset: ${preset.name}`, 'info', 1500);
    });
  });

  // Export camera view
  document.getElementById('btn-export-camera')?.addEventListener('click', () => {
    const canvas = document.getElementById('camera-canvas');
    if (!canvas) return;
    canvas.toBlob(blob => {
      const url  = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `camera_preview_${state.camera.preset || 'custom'}.png`;
      link.click();
      URL.revokeObjectURL(url);
      ToastManager.show('Camera view exported!', 'success');
    }, 'image/png');
  });
}

function updatePresetButtons() {
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === state.camera.preset);
  });
}

/* ─── Animation Player ─────────────────────────────────────────── */
function setupAnimPlayer() {
  // Setup player for both builder and camera panels
  const playerIds = [
    { play: 'btn-play', prev: 'btn-prev-frame', next: 'btn-next-frame',
      first: 'btn-first-frame', last: 'btn-last-frame',
      scrubber: 'anim-scrubber', fill: 'scrubber-fill',
      label: 'frame-label', fps: 'player-fps', fpsVal: 'player-fps-val' },
    { play: 'cam-btn-play', prev: 'cam-btn-prev-frame', next: 'cam-btn-next-frame',
      first: 'cam-btn-first-frame', last: 'cam-btn-last-frame',
      scrubber: 'cam-anim-scrubber', fill: 'cam-scrubber-fill',
      label: 'cam-frame-label', fps: 'cam-player-fps', fpsVal: 'cam-player-fps-val' },
  ];

  playerIds.forEach(ids => {
    document.getElementById(ids.play)?.addEventListener('click', () => {
      state.player.playing = !state.player.playing;
      // Update both play buttons
      playerIds.forEach(p => {
        const b = document.getElementById(p.play);
        if (b) b.textContent = state.player.playing ? '⏸' : '▶';
      });
    });

    document.getElementById(ids.prev)?.addEventListener('click', () => {
      const group = state.groups[state.activeGroup];
      if (!group) return;
      state.player.currentFrame = (state.player.currentFrame - 1 + group.length) % group.length;
      UIController.updateScrubber();
    });

    document.getElementById(ids.next)?.addEventListener('click', () => {
      const group = state.groups[state.activeGroup];
      if (!group) return;
      state.player.currentFrame = (state.player.currentFrame + 1) % group.length;
      UIController.updateScrubber();
    });

    document.getElementById(ids.first)?.addEventListener('click', () => {
      state.player.currentFrame = 0;
      UIController.updateScrubber();
    });

    document.getElementById(ids.last)?.addEventListener('click', () => {
      const group = state.groups[state.activeGroup];
      if (!group) return;
      state.player.currentFrame = group.length - 1;
      UIController.updateScrubber();
    });

    document.getElementById(ids.scrubber)?.addEventListener('click', (e) => {
      const group = state.groups[state.activeGroup];
      if (!group || !group.length) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct  = (e.clientX - rect.left) / rect.width;
      state.player.currentFrame = Math.floor(pct * group.length);
      UIController.updateScrubber();
    });

    const fpsSlider  = document.getElementById(ids.fps);
    const fpsDisplay = document.getElementById(ids.fpsVal);
    fpsSlider?.addEventListener('input', (e) => {
      state.player.fps = parseInt(e.target.value);
      if (fpsDisplay) fpsDisplay.textContent = `${state.player.fps} fps`;
      // Sync both sliders
      playerIds.forEach(p => {
        const s = document.getElementById(p.fps);
        const d = document.getElementById(p.fpsVal);
        if (s) s.value = state.player.fps;
        if (d) d.textContent = `${state.player.fps} fps`;
      });
    });
  });
}

/* ════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', initApp);
