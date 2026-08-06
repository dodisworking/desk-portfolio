// Tiny vanilla DOM UI: scenery picker + camera buttons.
import { SCENERY } from './scenery.js';

let activeId = SCENERY[0].id;
let onPickRef = null;

const panelStyle = `
  position: absolute; bottom: 24px; left: 50%;
  transform: translateX(-50%);
  display: flex; gap: 8px;
  background: rgba(0,0,0,0.55);
  padding: 10px 14px;
  border-radius: 999px;
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.08);
  font-family: system-ui, sans-serif;
  z-index: 10;
`;

const buttonStyle = `
  background: transparent;
  color: #fff;
  border: 1px solid rgba(255,255,255,0.15);
  padding: 8px 14px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.2s;
`;

function makeButton(label, onClick, activeColor = null, isActive = false) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = buttonStyle + (isActive && activeColor ? `background: ${activeColor};` : '');
  b.addEventListener('click', onClick);
  return b;
}

let panel;
let sceneryButtons = [];

export function mountUI({ onPickScenery, onSitDown, onLookAround, onUseComputer, onShelfView, onRightShelfView, onFlyToggle, getFlyActive, getCurrentMode }) {
  onPickRef = onPickScenery;

  panel = document.createElement('div');
  panel.style.cssText = panelStyle;

  // Scenery picker buttons removed (user request) — Luca is the locked
  // backdrop and the only HDRI is sunset, applied via the single
  // SCENERY[0] entry in scenery.js. Keep sceneryButtons empty so the
  // existing setActiveSceneryId / paint-active code in this file is a no-op.
  sceneryButtons = [];

  panel.appendChild(makeButton('Sit at desk', onSitDown));
  // Use computer = up close to Mac Plus screen with depth-of-field blur behind.
  // Button toggles label between "Use computer" / "Leave computer" so the
  // visitor knows the same button takes them in AND back out.
  const useBtn = makeButton('Use computer', () => onUseComputer?.());
  useBtn.style.cssText += 'background: rgba(255,200,80,0.15); border-color: rgba(255,200,80,0.5);';
  function paintUseBtn() {
    const inComputer = (typeof getCurrentMode === 'function' && getCurrentMode() === 'computer');
    useBtn.textContent = inComputer ? '← Leave computer' : 'Use computer';
    useBtn.style.background = inComputer ? 'rgba(125,255,160,0.20)' : 'rgba(255,200,80,0.15)';
    useBtn.style.borderColor = inComputer ? 'rgba(125,255,160,0.55)' : 'rgba(255,200,80,0.5)';
  }
  paintUseBtn();
  // Re-poll every 250ms so the label flips even when other code (Esc key,
  // another camera-mode click, etc.) changes the mode without going through
  // this button.
  setInterval(paintUseBtn, 250);
  window.__paintUseComputerBtn = paintUseBtn;
  panel.appendChild(useBtn);
  panel.appendChild(makeButton('Look around', onLookAround));
  // Left shelf view = head-on framing of the bookshelf alcove for editing.
  if (typeof onShelfView === 'function') {
    const shelfBtn = makeButton('Left shelf view', onShelfView);
    shelfBtn.style.cssText += 'background: rgba(125,160,255,0.15); border-color: rgba(125,160,255,0.5);';
    panel.appendChild(shelfBtn);
  }
  // Right shelf view = same head-on framing for the mirrored shelf on
  // the room's right side.
  if (typeof onRightShelfView === 'function') {
    const rBtn = makeButton('Right shelf view', onRightShelfView);
    rBtn.style.cssText += 'background: rgba(255,160,125,0.15); border-color: rgba(255,160,125,0.5);';
    panel.appendChild(rBtn);
  }
  // Fly mode toggle — re-paints with the current state on click.
  if (typeof onFlyToggle === 'function') {
    const flyBtn = makeButton('Fly mode', onFlyToggle);
    function paintFly(active) {
      flyBtn.textContent = active ? 'Fly mode: ON' : 'Fly mode';
      flyBtn.style.cssText = active
        ? flyBtn.style.cssText + 'background: rgba(125,255,160,0.18); border-color: rgba(125,255,160,0.55);'
        : flyBtn.style.cssText + 'background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.18);';
    }
    paintFly(typeof getFlyActive === 'function' ? getFlyActive() : false);
    // Re-poll once a second so the button reflects double-tap-space toggles
    // even when the user didn't click the button itself.
    setInterval(() => {
      if (typeof getFlyActive === 'function') paintFly(getFlyActive());
    }, 500);
    panel.appendChild(flyBtn);
  }

  document.body.appendChild(panel);

  // Rio backdrop slider panel removed — values are baked in. The runtime
  // helpers below are kept as no-ops so main.jsx doesn't need to change.
  window.__updateRioSliders = () => {};

  // ---- Leaf placement tool panel removed ------------------------------
  // (kept the leafTool API in main.jsx in case we need it again, but the
  // user is using the auto-placed surface-attached leaves now.)
  /* eslint-disable no-unused-vars */
  const _unusedLeafPanel = null;
  if (false) { const leafPanel = document.createElement('div');
  leafPanel.style.cssText = `
    position: absolute; top: 280px; right: 16px;
    background: rgba(0,0,0,0.6); color: #fff;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px; padding: 12px 14px;
    font: 12px system-ui, sans-serif;
    backdrop-filter: blur(10px);
    z-index: 10; min-width: 240px;
  `;
  leafPanel.innerHTML = `
    <div style="font-weight:600; margin-bottom:8px; opacity:0.9;">🍃 Leaf placer</div>
    <div style="display:flex; gap:6px; align-items:center; margin-bottom:8px;">
      <button id="leaf-toggle" style="flex:1; padding:6px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:#fff; cursor:pointer;">Off — click to enable</button>
    </div>
    <div style="font-size:10px; opacity:0.7; margin-bottom:6px;">When ON, click on the bonsai trunk/desk to drop a leaf.</div>
    <label style="display:block; margin:6px 0;">
      <div style="display:flex; justify-content:space-between;"><span>Color</span><span id="leaf-count">0 leaves</span></div>
      <input id="leaf-color" type="color" value="#e23a8e" style="width:100%; height:28px; border:none; background:transparent; cursor:pointer;">
    </label>
    <label style="display:block; margin:6px 0;">
      <div style="display:flex; justify-content:space-between;"><span>Size</span><span id="leaf-size-val">0.06</span></div>
      <input id="leaf-size" type="range" min="0.01" max="0.2" step="0.005" value="0.06" style="width:100%;">
    </label>
    <div style="border-top:1px solid rgba(255,255,255,0.1); margin:8px 0; padding-top:8px;">
      <div style="font-size:10px; opacity:0.7; margin-bottom:4px;">Selected leaf rotation</div>
      <label style="display:flex; align-items:center; gap:6px; margin:4px 0;">
        <span style="width:14px;">X</span>
        <input id="leaf-rx" type="range" min="-3.14" max="3.14" step="0.05" value="0" style="flex:1;">
      </label>
      <label style="display:flex; align-items:center; gap:6px; margin:4px 0;">
        <span style="width:14px;">Y</span>
        <input id="leaf-ry" type="range" min="-3.14" max="3.14" step="0.05" value="0" style="flex:1;">
      </label>
      <label style="display:flex; align-items:center; gap:6px; margin:4px 0;">
        <span style="width:14px;">Z</span>
        <input id="leaf-rz" type="range" min="-3.14" max="3.14" step="0.05" value="0" style="flex:1;">
      </label>
    </div>
    <div style="display:flex; gap:6px; margin-top:8px;">
      <button id="leaf-color-all" style="flex:1; padding:6px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:#fff; cursor:pointer; font-size:11px;">Color ALL</button>
      <button id="leaf-delete" style="flex:1; padding:6px; border-radius:8px; border:1px solid rgba(255,80,80,0.4); background:rgba(255,80,80,0.1); color:#fff; cursor:pointer; font-size:11px;">Delete</button>
      <button id="leaf-clear" style="flex:1; padding:6px; border-radius:8px; border:1px solid rgba(255,255,255,0.2); background:transparent; color:#fff; cursor:pointer; font-size:11px;">Clear</button>
    </div>
    <button id="leaf-export" style="width:100%; margin-top:8px; padding:8px; border-radius:8px; border:1px solid rgba(120,200,255,0.5); background:rgba(120,200,255,0.15); color:#fff; cursor:pointer; font-size:11px; font-weight:600;">📋 Copy Blender script</button>
  `;
  document.body.appendChild(leafPanel);

  // Wire leaf-tool controls
  const lq = (id) => document.getElementById(id);
  let leafEnabled = false;
  lq('leaf-toggle').addEventListener('click', () => {
    leafEnabled = !leafEnabled;
    window.__leafTool?.setEnabled(leafEnabled);
    lq('leaf-toggle').textContent = leafEnabled ? '● ON — click bonsai to place' : 'Off — click to enable';
    lq('leaf-toggle').style.background = leafEnabled ? 'rgba(80,255,120,0.18)' : 'transparent';
    lq('leaf-toggle').style.borderColor = leafEnabled ? 'rgba(80,255,120,0.55)' : 'rgba(255,255,255,0.2)';
  });
  lq('leaf-color').addEventListener('input', (e) => window.__leafTool?.setColor(e.target.value));
  lq('leaf-color-all').addEventListener('click', () => window.__leafTool?.setColorAll(lq('leaf-color').value));
  lq('leaf-size').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    lq('leaf-size-val').textContent = v.toFixed(3);
    window.__leafTool?.setScale(v);
  });
  ['rx', 'ry', 'rz'].forEach((axisKey) => {
    const sl = lq('leaf-' + axisKey);
    sl.addEventListener('input', () => {
      const axis = axisKey.slice(1);  // "x" | "y" | "z"
      window.__leafTool?.setRotation(axis, parseFloat(sl.value));
    });
  });
  lq('leaf-delete').addEventListener('click', () => window.__leafTool?.deleteSelected());
  lq('leaf-clear').addEventListener('click', () => {
    if (confirm('Remove ALL placed leaves?')) window.__leafTool?.clear();
  });
  lq('leaf-export').addEventListener('click', async () => {
    const script = window.__leafTool?.exportBlenderScript() || '';
    try {
      await navigator.clipboard.writeText(script);
      lq('leaf-export').textContent = '✓ Copied! Paste it back to Claude';
      setTimeout(() => { lq('leaf-export').textContent = '📋 Copy Blender script'; }, 2500);
    } catch (e) {
      // Clipboard blocked — show in a textarea
      const ta = document.createElement('textarea');
      ta.value = script;
      ta.style.cssText = 'position:fixed; inset:5%; z-index:100; padding:10px; background:#000; color:#0f0; font:11px monospace;';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
    }
  });
  window.__updateLeafCount = (n) => { lq('leaf-count').textContent = `${n} leaf${n === 1 ? '' : 's'}`; };
  window.__updateLeafSelection = (i, rot, color) => {
    if (i < 0 || !rot) return;
    lq('leaf-rx').value = rot.x;
    lq('leaf-ry').value = rot.y;
    lq('leaf-rz').value = rot.z;
    if (color) lq('leaf-color').value = color;
  };
  } // end of removed leaf panel block

  // Required attribution for the Macintosh Plus model (CC BY-SA from Deutsches Museum | Digital)
  const credit = document.createElement('div');
  credit.style.cssText = `
    position: absolute; bottom: 4px; right: 8px;
    color: rgba(255,255,255,0.45); font: 10px system-ui, sans-serif;
    z-index: 5; pointer-events: auto;
  `;
  credit.innerHTML = `Macintosh Plus 3D scan ©
    <a href="https://sketchfab.com/3d-models/personal-computer-macintosh-plus-3-teilig-64319e3fd7dd44acb7d6d72cd8c395db"
       target="_blank" rel="noopener" style="color:rgba(255,255,255,0.7);">Deutsches Museum | Digital</a> ·
    <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener" style="color:rgba(255,255,255,0.7);">CC BY-SA 4.0</a>`;
  document.body.appendChild(credit);
}

// ---- consolidated control panel (top-left): wall picker + light + desk ---
export function mountControls({ wallOptions, onPickWall, onLightToggle, onLuxoBrightness, onLuxoWarmth, onEnvWarmth, onEnvBrightness, onHdrAffectsCluster, onDeskSlide }) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: absolute; top: 16px; left: 16px;
    background: rgba(0,0,0,0.6);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 12px 14px;
    backdrop-filter: blur(12px);
    font: 12px system-ui, sans-serif;
    color: #fff;
    z-index: 10;
    display: flex; flex-direction: column; gap: 14px;
    min-width: 280px; max-height: 88vh; overflow-y: auto;
  `;
  // Inject a slightly larger thumb + taller track style so sliders are easier
  // to drag precisely. Scoped via a unique class on this panel.
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .__ctrl input[type=range] { height: 22px; }
    .__ctrl input[type=range]::-webkit-slider-runnable-track {
      height: 6px; border-radius: 3px; background: rgba(255,255,255,0.12);
    }
    .__ctrl input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 18px; height: 18px; border-radius: 50%;
      background: #e0a36a; border: 2px solid rgba(0,0,0,0.55);
      margin-top: -6px; cursor: pointer;
    }
  `;
  document.head.appendChild(styleEl);
  wrap.classList.add('__ctrl');

  // ---- Left-wall texture picker ----------------------------------------
  const wallSection = document.createElement('div');
  wallSection.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  const wallTitle = document.createElement('div');
  wallTitle.textContent = 'Left wall';
  wallTitle.style.cssText = 'font-weight:600; opacity:0.9; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;';
  wallSection.appendChild(wallTitle);

  let activeWall = wallOptions[0].id;
  const wallButtons = [];
  wallOptions.forEach((opt) => {
    const row = document.createElement('button');
    const isActive = opt.id === activeWall;
    row.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      background: ${isActive ? 'rgba(255,200,80,0.18)' : 'transparent'};
      border: 1px solid ${isActive ? 'rgba(255,200,80,0.5)' : 'rgba(255,255,255,0.12)'};
      color: #fff; cursor: pointer;
      padding: 6px 10px; border-radius: 8px;
      font: 12px system-ui, sans-serif; text-align: left;
    `;
    const swatch = document.createElement('span');
    swatch.style.cssText = `
      width: 26px; height: 26px; border-radius: 4px;
      background-image: url(/textures/wall/${opt.id}/diff.jpg);
      background-size: cover; background-position: center;
      flex-shrink: 0;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
    `;
    const label = document.createElement('span');
    label.textContent = opt.label;
    row.appendChild(swatch);
    row.appendChild(label);
    row.addEventListener('click', () => {
      onPickWall(opt.id);
      activeWall = opt.id;
      wallButtons.forEach(({ id, btn }) => {
        const on = id === activeWall;
        btn.style.background = on ? 'rgba(255,200,80,0.18)' : 'transparent';
        btn.style.borderColor = on ? 'rgba(255,200,80,0.5)' : 'rgba(255,255,255,0.12)';
      });
    });
    wallSection.appendChild(row);
    wallButtons.push({ id: opt.id, btn: row });
  });
  wrap.appendChild(wallSection);

  // ---- Prop sliders (lamp, bonsai, bookshelf) --------------------------
  function addPropSection(propKey, title, axes, defaults = {}) {
    const sec = document.createElement('div');
    sec.style.cssText = `
      display:flex; flex-direction:column; gap:6px;
      padding-top:10px; border-top: 1px solid rgba(255,255,255,0.12);
    `;
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'font-weight:600; opacity:0.9; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;';
    sec.appendChild(t);
    const state = { x: 0, y: 0, z: 0, scale: 1, rotY: 0, ...defaults };
    // Push the locked-in defaults to the scene once on mount
    setTimeout(() => onPropChange(propKey, { ...state }), 600);
    axes.forEach(({ key, label, min, max, step }) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex; flex-direction:column; gap:2px; font-size:11px;';
      const top = document.createElement('div');
      top.style.cssText = 'display:flex; justify-content:space-between; opacity:0.85;';
      const lab = document.createElement('span'); lab.textContent = label;
      const val = document.createElement('span'); val.textContent = state[key].toFixed(2);
      top.appendChild(lab); top.appendChild(val);
      row.appendChild(top);
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step ?? 0.01;
      sl.value = state[key];
      sl.style.cssText = 'width:100%; accent-color:#e0a36a;';
      sl.addEventListener('input', (e) => {
        state[key] = parseFloat(e.target.value);
        val.textContent = state[key].toFixed(2);
        onPropChange(propKey, { ...state });
      });
      row.appendChild(sl);
      sec.appendChild(row);
    });
    wrap.appendChild(sec);
  }

  // ---- Lights toggles + Luxo brightness --------------------------------
  const lightsSec = document.createElement('div');
  lightsSec.style.cssText = `
    display:flex; flex-direction:column; gap:6px;
    padding-top:10px; border-top: 1px solid rgba(255,255,255,0.12);
  `;
  const lightsTitle = document.createElement('div');
  lightsTitle.textContent = 'Lights';
  lightsTitle.style.cssText = 'font-weight:600; opacity:0.9; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;';
  lightsSec.appendChild(lightsTitle);

  const LIGHT_ENTRIES = [
    { key: 'bulbPoint', label: 'Lamp bulb glow' },
    { key: 'bulbSpot',  label: 'Lamp spot (desk pool)' },
    { key: 'window',    label: 'Window (sunset)' },
    { key: 'env',       label: 'HDRI environment (indirect)' },
  ];
  LIGHT_ENTRIES.forEach(({ key, label }) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; user-select:none;';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.style.cssText = 'accent-color:#e0a36a;';
    cb.addEventListener('change', (e) => onLightToggle(key, e.target.checked));
    const lab = document.createElement('span'); lab.textContent = label;
    row.appendChild(cb); row.appendChild(lab);
    lightsSec.appendChild(row);
  });

  // Toggle: HDR affects desk + Mac + lamp + bonsai (the "focal cluster")
  const clusterRow = document.createElement('label');
  clusterRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; user-select:none; margin-top:2px;';
  const clusterCb = document.createElement('input');
  clusterCb.type = 'checkbox'; clusterCb.checked = true;
  clusterCb.style.cssText = 'accent-color:#e0a36a;';
  clusterCb.addEventListener('change', (e) => onHdrAffectsCluster?.(e.target.checked));
  const clusterLab = document.createElement('span');
  clusterLab.textContent = 'HDR affects desk + props';
  clusterRow.appendChild(clusterCb); clusterRow.appendChild(clusterLab);
  lightsSec.appendChild(clusterRow);

  wrap.appendChild(lightsSec);

  document.body.appendChild(wrap);
}

// ---- desk-wood picker (LEGACY — replaced by mountControls) ---------------
export function mountWoodPicker({ options, onPick, initial }) {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    position: absolute; top: 16px; left: 16px;
    background: rgba(0,0,0,0.55);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 10px 12px;
    backdrop-filter: blur(12px);
    font: 12px system-ui, sans-serif;
    color: #fff;
    z-index: 10;
    display: flex; flex-direction: column; gap: 8px;
    min-width: 170px;
  `;
  const title = document.createElement('div');
  title.textContent = 'Desk wood';
  title.style.cssText = 'font-weight: 600; opacity: 0.9; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;';
  wrap.appendChild(title);

  const buttons = [];
  let activeId = initial;
  options.forEach((opt) => {
    const row = document.createElement('button');
    row.style.cssText = `
      display: flex; align-items: center; gap: 10px;
      background: ${opt.id === initial ? 'rgba(255,200,80,0.18)' : 'transparent'};
      border: 1px solid ${opt.id === initial ? 'rgba(255,200,80,0.5)' : 'rgba(255,255,255,0.12)'};
      color: #fff; cursor: pointer;
      padding: 6px 10px; border-radius: 8px;
      font: 12px system-ui, sans-serif; text-align: left;
    `;
    const swatch = document.createElement('span');
    swatch.style.cssText = `
      width: 26px; height: 26px; border-radius: 4px;
      background-image: url(/textures/wood/${opt.id}/diff.jpg);
      background-size: cover; background-position: center;
      flex-shrink: 0;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
    `;
    const label = document.createElement('span');
    label.textContent = opt.label;
    row.appendChild(swatch);
    row.appendChild(label);
    row.addEventListener('click', () => {
      onPick(opt.id);
      activeId = opt.id;
      buttons.forEach(({ id, btn }) => {
        const on = id === activeId;
        btn.style.background = on ? 'rgba(255,200,80,0.18)' : 'transparent';
        btn.style.borderColor = on ? 'rgba(255,200,80,0.5)' : 'rgba(255,255,255,0.12)';
      });
    });
    wrap.appendChild(row);
    buttons.push({ id: opt.id, btn: row });
  });

  // ---- live tweak sliders for the dark wood ----------------------------
  const sliders = document.createElement('div');
  sliders.style.cssText = `
    margin-top: 6px; padding-top: 8px;
    border-top: 1px solid rgba(255,255,255,0.12);
    display: flex; flex-direction: column; gap: 6px;
  `;
  const slidersTitle = document.createElement('div');
  slidersTitle.textContent = 'Tweaks';
  slidersTitle.style.cssText = 'font-weight: 600; opacity: 0.9; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;';
  sliders.appendChild(slidersTitle);

  // initial values match the dark_wood preset above
  const state = { red: 0.55, darkness: 0.62, polish: 0.68, reflection: 0.65 };

  function makeSlider(key, label, min, max) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; flex-direction:column; gap:2px; font-size:11px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex; justify-content:space-between; opacity:0.85;';
    const labelEl = document.createElement('span'); labelEl.textContent = label;
    const valEl = document.createElement('span'); valEl.textContent = state[key].toFixed(2);
    top.appendChild(labelEl); top.appendChild(valEl);
    row.appendChild(top);
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = min; slider.max = max; slider.step = 0.01;
    slider.value = state[key];
    slider.style.cssText = 'width:100%; accent-color: #e0a36a;';
    slider.addEventListener('input', (e) => {
      state[key] = parseFloat(e.target.value);
      valEl.textContent = state[key].toFixed(2);
      window.__updateDeskWoodTweaks?.(state);
    });
    row.appendChild(slider);
    return row;
  }
  sliders.appendChild(makeSlider('red',        'Red',        0, 1));
  sliders.appendChild(makeSlider('darkness',   'Darkness',   0.2, 1.2));
  sliders.appendChild(makeSlider('polish',     'Polish',     0, 1));
  sliders.appendChild(makeSlider('reflection', 'Reflection', 0, 1.5));
  wrap.appendChild(sliders);

  document.body.appendChild(wrap);

  // Push initial state to the scene once on mount, after a tick so the room
  // GLB has had a chance to load.
  setTimeout(() => window.__updateDeskWoodTweaks?.(state), 800);
}

export function setActiveSceneryId(id) {
  activeId = id;
  sceneryButtons.forEach(({ id: bId, btn, tint }) => {
    btn.style.background = bId === id ? tint : 'transparent';
  });
}
