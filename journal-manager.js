/* ═══════════════════════════════════════════
   TELOS — Journal Book Manager
   journal-manager.js — Multi-Book System
═══════════════════════════════════════════ */

'use strict';

// ─── Book Cover Styles ───────────────────
// Each cover defines visual identity for the flipbook
export const BOOK_COVERS = {
  classic: {
    id: 'classic',
    name: 'Classic',
    accent: '#c9a84c',
    bgGradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    textColor: '#c9a84c',
    ornament: '◈',
  },
  ivory: {
    id: 'ivory',
    name: 'Ivory',
    accent: '#8b7355',
    bgGradient: 'linear-gradient(135deg, #f5f0e8 0%, #ece4d4 100%)',
    textColor: '#8b7355',
    ornament: '◇',
  },
  moonlit: {
    id: 'moonlit',
    name: 'Moonlit',
    accent: '#b39ddb',
    bgGradient: 'linear-gradient(135deg, #1a1530 0%, #251a3d 100%)',
    textColor: '#b39ddb',
    ornament: '☾',
  },
  verdant: {
    id: 'verdant',
    name: 'Verdant',
    accent: '#7bc67e',
    bgGradient: 'linear-gradient(135deg, #0f1f0f 0%, #162816 100%)',
    textColor: '#7bc67e',
    icon: 'eco',
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean',
    accent: '#64b5f6',
    bgGradient: 'linear-gradient(135deg, #0a1a2e 0%, #0d2240 100%)',
    textColor: '#64b5f6',
    icon: 'waves',
  },
  blossom: {
    id: 'blossom',
    name: 'Blossom',
    accent: '#e8a0bf',
    bgGradient: 'linear-gradient(135deg, #2d1a28 0%, #3a1f35 100%)',
    textColor: '#e8a0bf',
    ornament: '🎀',
  },
  amore: {
    id: 'amore',
    name: 'Amore',
    accent: '#f48fb1',
    bgGradient: 'linear-gradient(135deg, #2a1520 0%, #331a25 100%)',
    textColor: '#f48fb1',
    ornament: '♡',
  },
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian',
    accent: '#a0a0a0',
    bgGradient: 'linear-gradient(135deg, #141414 0%, #0a0a0a 100%)',
    textColor: '#a0a0a0',
    icon: 'skull',
  },
};

// ─── Helper: render cover symbol (icon or ornament) ─────
function renderSymbol(cover, sizePx, extraStyle = '') {
  if (cover.icon) {
    return `<span class="material-symbols-outlined" style="font-size:${sizePx}px; color:${cover.accent}; font-variation-settings: 'FILL' 0, 'wght' 200, 'GRAD' 0, 'opsz' ${sizePx}; ${extraStyle}">${cover.icon}</span>`;
  }
  return `<span style="font-size:${sizePx}px; color:${cover.accent}; line-height:1; ${extraStyle}">${cover.ornament}</span>`;
}

export const DEFAULT_BOOK_ID = 'default';

// ─── Create a Default Book ───────────────
export function createDefaultBook() {
  return {
    id: DEFAULT_BOOK_ID,
    name: 'Meditations & Reflections',
    cover: 'classic',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── Create a New Book ───────────────────
export function createBook(name, coverId = 'classic') {
  return {
    id: 'book_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim() || 'Untitled Journal',
    cover: coverId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── Migrate Flat Journal → Multi-Book ───
// Takes flat journal { dateKey: [entries] } and wraps it under defaultBook
export function migrateJournalToMultiBook(flatJournal) {
  if (!flatJournal || typeof flatJournal !== 'object') return {};
  
  // If it already has book IDs as keys (nested format), return as-is
  const firstKey = Object.keys(flatJournal)[0];
  if (firstKey && typeof flatJournal[firstKey] === 'object' && !Array.isArray(flatJournal[firstKey])) {
    // Could be a date key with object entries, or a bookId key with date map
    // Heuristic: date keys are YYYY-MM-DD format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(firstKey)) {
      return flatJournal; // Already migrated
    }
  }
  
  // Flat format — wrap under default book
  return { [DEFAULT_BOOK_ID]: flatJournal };
}

// ─── Get Active Book's Journal ───────────
export function getBookJournal(journal, bookId) {
  if (!journal[bookId]) journal[bookId] = {};
  return journal[bookId];
}

// ─── Render Book Cover HTML for Flipbook ─
export function renderCoverHTML(book) {
  const cover = BOOK_COVERS[book.cover] || BOOK_COVERS.classic;
  const year = new Date(book.createdAt).getFullYear();

  // Light-background covers should not have a dark text-shadow (it creates a muddy backlight effect)
  const LIGHT_COVERS = ['ivory'];
  const isLight = LIGHT_COVERS.includes(book.cover);
  const textShadow = isLight ? 'none' : '0 1px 3px rgba(0,0,0,0.5)';
  
  return `
    <div class="jbook-cover-inner-border" style="position: absolute; top: 12px; right: 12px; bottom: 12px; left: 18px; border: 1.5px solid ${cover.accent}; border-radius: 4px 10px 10px 4px; pointer-events: none; z-index: 5; opacity: 0.9;"></div>
    <div class="jbook-page-content" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; text-align:center; padding: 24px; position: relative; z-index: 10;">
      ${renderSymbol(cover, 24, 'margin-bottom:24px; opacity:0.7;')}
      <h2 style="font-family:'Cormorant Garamond', 'Newsreader', serif; font-size:20px; font-weight:500; color:${cover.accent}; margin-bottom:6px; letter-spacing:1.5px; text-shadow: ${textShadow};">${escapeHTML(book.name)}</h2>
      <div style="width:50px; height:1px; background:linear-gradient(90deg, transparent, ${cover.accent}80, transparent); margin:20px auto;"></div>
      <p style="font-family:'Cormorant Garamond', 'Newsreader', serif; font-size:11px; font-weight:400; color:${cover.accent}80; letter-spacing: 2.5px; font-style:italic; text-shadow: ${textShadow};">— est. ${year} —</p>
    </div>
  `;
}

// ─── Book Catalog Card ───────────────────
export function createBookCard(book, isActive, entryCount) {
  const cover = BOOK_COVERS[book.cover] || BOOK_COVERS.classic;
  const card = document.createElement('div');
  card.className = `book-card${isActive ? ' active' : ''}`;
  card.dataset.bookId = book.id;
  
  card.innerHTML = `
    <div class="book-card-spine" style="background:${cover.bgGradient};">
      <div class="book-card-cover" style="background:${cover.bgGradient}; border-color: ${cover.accent}30;">
        ${renderSymbol(cover, 18, 'opacity:0.85;')}
        <p class="book-card-title" style="color:${cover.accent};">${escapeHTML(book.name)}</p>
        <div class="book-card-divider" style="background:${cover.accent}40;"></div>
      </div>
    </div>
    <div class="book-card-info">
      <p class="book-card-name">${escapeHTML(book.name)}</p>
      <p class="book-card-meta">${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}</p>
    </div>
    ${isActive ? '<span class="book-card-active-badge">Active</span>' : ''}
  `;
  
  let pressTimer = null;
  const clearTimer = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; };
  
  const startPress = (e) => {
    if (e.type === 'pointerdown' && e.button !== 0 && e.pointerType === 'mouse') return; // Only left click or touch
    clearTimer();
    pressTimer = setTimeout(() => {
      if (window.Haptics && window.Haptics.impact) {
        window.Haptics.impact({ style: 'Heavy' }).catch(()=>console.log('Haptics failed'));
      } else if (navigator.vibrate) {
        navigator.vibrate(50);
      }
      document.dispatchEvent(new CustomEvent('openBookContextMenu', { detail: { book } }));
    }, 550); // 550ms long press threshold
  };

  card.addEventListener('pointerdown', startPress);
  card.addEventListener('touchstart', startPress, {passive: true});
  
  card.addEventListener('pointerup', clearTimer);
  card.addEventListener('pointercancel', clearTimer);
  card.addEventListener('pointerleave', clearTimer);
  card.addEventListener('touchend', clearTimer);
  card.addEventListener('touchcancel', clearTimer);
  card.addEventListener('contextmenu', e => e.preventDefault());
  
  return card;
}

// ─── Cover Picker Option ─────────────────
export function createCoverOption(coverId, isSelected) {
  const cover = BOOK_COVERS[coverId];
  const el = document.createElement('div');
  el.className = `cover-option${isSelected ? ' selected' : ''}`;
  el.dataset.coverId = coverId;
  
  el.innerHTML = `
    <div class="cover-option-preview" style="background:${cover.bgGradient}; border-color: ${isSelected ? cover.accent : 'transparent'};">
      ${renderSymbol(cover, 18, '')}
    </div>
    <p class="cover-option-name">${cover.name}</p>
  `;
  
  return el;
}

// ─── Count entries for a book ────────────
export function countBookEntries(journal, bookId) {
  const bookJournal = journal[bookId];
  if (!bookJournal) return 0;
  let count = 0;
  Object.values(bookJournal).forEach(entries => {
    if (Array.isArray(entries)) count += entries.length;
  });
  return count;
}

// ─── Utility ─────────────────────────────
function escapeHTML(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
