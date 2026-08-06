// Each entry = one swappable "world." Swapping changes the HDRI used to light the room
// AND the same HDRI shows through the window as the sky.
//
// Single-entry array on purpose: the Rio / Costa Rica / NYC picker buttons
// were removed. Luca is the locked default backdrop, applied in main.jsx
// after setScenery runs. This entry exists only so loadHDRI gets called
// for environment lighting at startup.
export const SCENERY = [
  { id: 'luca', label: 'Luca', hdri: '/hdri/sunset.hdr', tint: '#ff8a3d', backdrop: { type: 'video', src: '/videos/luca.mp4' } },
];
