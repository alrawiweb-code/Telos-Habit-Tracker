// ═══════════════════════════════════════════
//  THEME ENGINE — Curated theme registry & application
//  Manages app-wide visual themes via CSS custom properties
// ═══════════════════════════════════════════

/**
 * Theme structure:
 * {
 *   id:            string  — Unique key (used in data-theme attribute & storage)
 *   name:          string  — Display name
 *   category:      string  — 'dark' | 'light'
 *   icon:          string  — Material Symbols icon name for picker
 *   preview:       { bg, accent, surface }  — Colors for the picker card preview
 *   metaThemeColor: string — Color for the <meta name="theme-color"> tag
 *   statusBarStyle: 'Dark' | 'Light' — Capacitor StatusBar style
 * }
 *
 * Actual CSS tokens are defined in styles.css via [data-theme="X"] selectors.
 * This module only stores metadata for the picker and applies the correct attribute.
 */

export const THEMES = {
  // ═══ DARK THEMES ═══════════════════════════
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    category: 'dark',
    icon: 'dark_mode',
    preview: { bg: '#121212', accent: '#4ade80', surface: '#1E1E1E', text: '#F1F1F1' },
    metaThemeColor: '#121212',
    statusBarStyle: 'Dark',
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    category: 'dark',
    icon: 'visibility_off',
    preview: { bg: '#000000', accent: '#4ade80', surface: '#0A0A0A', text: '#EAEAEA' },
    metaThemeColor: '#000000',
    statusBarStyle: 'Dark',
  },
  navy: {
    id: 'navy',
    name: 'Navy Elegance',
    category: 'dark',
    icon: 'anchor',
    preview: { bg: '#0A1628', accent: '#D4AF37', surface: '#0F1F3A', text: '#E8E4DC' },
    metaThemeColor: '#0A1628',
    statusBarStyle: 'Dark',
  },
  ember: {
    id: 'ember',
    name: 'Ember',
    category: 'dark',
    icon: 'local_fire_department',
    preview: { bg: '#1A0E0A', accent: '#FF6B35', surface: '#261712', text: '#F0E0D5' },
    metaThemeColor: '#1A0E0A',
    statusBarStyle: 'Dark',
  },
  twilight: {
    id: 'twilight',
    name: 'Twilight',
    category: 'dark',
    icon: 'nights_stay',
    preview: { bg: '#0F0B1A', accent: '#BB86FC', surface: '#1A1428', text: '#E8E0F0' },
    metaThemeColor: '#0F0B1A',
    statusBarStyle: 'Dark',
  },

  // ═══ LIGHT THEMES ══════════════════════════
  paper: {
    id: 'paper',
    name: 'Paper',
    category: 'light',
    icon: 'description',
    preview: { bg: '#F9F8F6', accent: '#3eec13', surface: '#FFFFFF', text: '#2A2A2A' },
    metaThemeColor: '#F9F8F6',
    statusBarStyle: 'Light',
  },
  blush: {
    id: 'blush',
    name: 'Soft Blush',
    category: 'light',
    icon: 'favorite',
    preview: { bg: '#FFF5F7', accent: '#E8879B', surface: '#FFFFFF', text: '#3A2F35' },
    metaThemeColor: '#FFF5F7',
    statusBarStyle: 'Light',
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean Breeze',
    category: 'light',
    icon: 'waves',
    preview: { bg: '#F0F9F8', accent: '#15A89E', surface: '#FFFFFF', text: '#1B3A4B' },
    metaThemeColor: '#F0F9F8',
    statusBarStyle: 'Light',
  },
  sage: {
    id: 'sage',
    name: 'Sage Garden',
    category: 'light',
    icon: 'eco',
    preview: { bg: '#F5F7F2', accent: '#7FB069', surface: '#FFFFFF', text: '#2D3A28' },
    metaThemeColor: '#F5F7F2',
    statusBarStyle: 'Light',
  },
  sand: {
    id: 'sand',
    name: 'Warm Sand',
    category: 'light',
    icon: 'landscape',
    preview: { bg: '#FBF6F0', accent: '#D4804E', surface: '#FFFFFF', text: '#3B2F24' },
    metaThemeColor: '#FBF6F0',
    statusBarStyle: 'Light',
  },
  lavender: {
    id: 'lavender',
    name: 'Lavender',
    category: 'light',
    icon: 'spa',
    preview: { bg: '#F8F5FF', accent: '#9B7FD4', surface: '#FFFFFF', text: '#2E2740' },
    metaThemeColor: '#F8F5FF',
    statusBarStyle: 'Light',
  },
  cherry: {
    id: 'cherry',
    name: 'Cherry Blossom',
    category: 'light',
    icon: 'filter_vintage',
    preview: { bg: '#FFF8FA', accent: '#F06292', surface: '#FFFFFF', text: '#3D2937' },
    metaThemeColor: '#FFF8FA',
    statusBarStyle: 'Light',
  },
  arctic: {
    id: 'arctic',
    name: 'Arctic',
    category: 'light',
    icon: 'ac_unit',
    preview: { bg: '#F5F9FC', accent: '#42A5F5', surface: '#FFFFFF', text: '#1B2D3E' },
    metaThemeColor: '#F5F9FC',
    statusBarStyle: 'Light',
  },
};

/** Ordered list of theme IDs for consistent rendering */
export const THEME_ORDER = [
  'midnight', 'obsidian', 'navy', 'ember', 'twilight',
  'paper', 'blush', 'ocean', 'sage', 'sand', 'lavender', 'cherry', 'arctic',
];

/**
 * Apply a theme to the DOM.
 * - Sets `data-theme` attribute on <html> (activates CSS token overrides)
 * - Toggles `.dark` class for component-level dark mode styles
 * - Updates <meta name="theme-color">
 *
 * @param {string} themeId — The theme ID to apply
 * @returns {object} The applied theme object
 */
export function applyTheme(themeId) {
  const theme = THEMES[themeId] || THEMES.midnight;
  const root = document.documentElement;

  // Set theme attribute — triggers [data-theme="X"] CSS selectors
  root.dataset.theme = theme.id;

  // Toggle dark class for all existing :root.dark / .dark component styles
  root.classList.toggle('dark', theme.category === 'dark');

  // Update meta theme-color for browser/OS chrome
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.metaThemeColor);

  return theme;
}

/**
 * Migrate legacy theme values to new theme IDs
 * @param {string} legacyValue — 'dark' or 'light'
 * @returns {string} — Valid theme ID
 */
export function migrateLegacyTheme(legacyValue) {
  if (legacyValue === 'dark') return 'midnight';
  if (legacyValue === 'light') return 'paper';
  // If it's already a valid theme ID, return as-is
  if (THEMES[legacyValue]) return legacyValue;
  // Default fallback
  return 'midnight';
}

/**
 * Get themes grouped by category for the picker UI
 * @returns {{ dark: object[], light: object[] }}
 */
export function getThemesByCategory() {
  const groups = { dark: [], light: [] };
  THEME_ORDER.forEach(id => {
    const theme = THEMES[id];
    if (theme) groups[theme.category].push(theme);
  });
  return groups;
}

/**
 * Render a single theme preview card (mini UI mockup)
 * @param {object} theme — Theme object from THEMES
 * @param {boolean} isActive — Whether this is the currently active theme
 * @returns {HTMLElement}
 */
export function createThemeCard(theme, isActive) {
  const card = document.createElement('div');
  card.className = `theme-card${isActive ? ' active' : ''}`;
  card.dataset.themeId = theme.id;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${theme.name} theme${isActive ? ' (active)' : ''}`);

  card.innerHTML = `
    <div class="theme-preview" style="background: ${theme.preview.bg}; border-color: ${isActive ? theme.preview.accent : 'transparent'};">
      <div class="tp-status-bar" style="background: ${theme.preview.surface};"></div>
      <div class="tp-header-bar" style="background: ${theme.preview.surface};">
        <div class="tp-header-dot" style="background: ${theme.preview.accent};"></div>
        <div class="tp-header-line" style="background: ${theme.preview.text}; opacity: 0.6;"></div>
      </div>
      <div class="tp-content">
        <div class="tp-line" style="background: ${theme.preview.text}; opacity: 0.5;"></div>
        <div class="tp-line short" style="background: ${theme.preview.text}; opacity: 0.3;"></div>
        <div class="tp-pill" style="background: ${theme.preview.accent}; opacity: 0.85;"></div>
      </div>
      ${isActive ? `<div class="tp-check" style="background: ${theme.preview.accent};"><span class="material-symbols-outlined" style="font-size: 14px; color: ${theme.category === 'dark' ? '#000' : '#fff'};">check</span></div>` : ''}
    </div>
    <span class="theme-name" style="color: var(--charcoal);">${theme.name}</span>
  `;

  return card;
}
