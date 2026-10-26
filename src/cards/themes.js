// Brand themes. Colours are "brand-leaning" approximations, not official palettes.
// `logo.tile` fills the rounded tile behind the official mark; `logo.inset` is the padding
// (fraction of tile size) around it — Grok's mark runs edge-to-edge, Claude's has its own margin.

export const THEMES = {
  grok: {
    wordmark: 'GROK BUILD',
    outer: '#08090a',
    panel: '#16171a',
    divider: '#2c2e33',
    text: '#f3f3f1',
    muted: '#8d9097',
    logo: { tile: '#ffffff', inset: 0.14 },
    pass: '#3ddc84',
    fail: '#ff5f56',
    timeout: '#ffb020',
    cancelled: '#a4a8b0', // grey: stopped, nothing to show for it
    blocked: '#ff8c42', // orange: needs a human (approval / permission)
    pillInk: '#0b0c0d',
  },
  claude: {
    wordmark: 'CLAUDE CODE',
    outer: '#efe4d3',
    panel: '#faf6ee',
    divider: '#e2d5c2',
    text: '#2a1f17',
    muted: '#7d6b5b',
    logo: { tile: '#da7453', inset: 0 }, // terracotta, matches the PNG's own background
    pass: '#2e7d4f',
    fail: '#b3261e',
    timeout: '#a85d00',
    cancelled: '#6f6257',
    blocked: '#c2410c',
    pillInk: '#ffffff',
  },
};

export function themeFor(tool) {
  return THEMES[tool] || THEMES.grok;
}
