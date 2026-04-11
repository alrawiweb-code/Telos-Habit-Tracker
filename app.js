/* ═══════════════════════════════════
   TELOS — HABIT, JOURNAL & TO-DO
   app.js — Production-Grade Logic
═══════════════════════════════════ */

'use strict';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

const WidgetPlugin = registerPlugin('WidgetPlugin');

// ─── Constants ────────────────────────────────
const STORAGE_KEY_HABITS         = 'ee_habits_v2';
const STORAGE_KEY_LOGS           = 'ee_logs_v2';
const STORAGE_KEY_JOURNAL        = 'ee_journal_v2';
const STORAGE_KEY_HABIT_JOURNAL  = 'ee_habit_journal_v1';
const STORAGE_KEY_NOTIF          = 'ee_notif_v1';

const DAY_LABELS    = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES   = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];

const HABIT_ICONS = [
  'self_improvement', 'local_drink', 'auto_stories', 'directions_walk',
  'fitness_center', 'bedtime', 'lunch_dining', 'light_mode',
  'music_note', 'brush', 'code', 'favorite',
  'pets', 'spa', 'medication', 'nature',
  'laptop', 'calendar_today', 'coffee',
];

// ─── State ────────────────────────────────────
let habits       = [];   // [{ id, name, desc, icon, schedule, createdAt }]
let logs         = {};   // { "YYYY-MM-DD": { habitId: true } }
let journal      = {};   // { "YYYY-MM-DD": [{text, ts}] }
let habitJournal = {};   // { habitId: { "YYYY-MM-DD": [{text, ts}] } }

let notifSettings = {
  enabled: false,
  defaultTimes: { morning: '07:00', afternoon: '13:00', evening: '19:00' },
  habitReminders: {},   // { habitId: { enabled, time } }
  smart: { enabled: false, times: ['18:00', '21:00'] },
  streak: { enabled: false, time: '20:00' },
  snooze: { enabled: false, options: [30, 60] },
  hapticsEnabled: true,
  theme: 'dark',
};

let selectedDate    = todayKey();
let selectedIcon    = HABIT_ICONS[0];
let toastTimer      = null;
let undoTimer       = null;
let currentScreen   = 'today';
let activeHabitId   = null;
let editingHabitId  = null;
let confirmResolve  = null;
let historyEditContext = { key: null, habitId: null, index: null };
let stripCenterDate     = todayKey(); 
let modalViewingDate    = new Date();
let momentumState = { velocity: 0, offset: 0, frame: null, lastT: 0, isDragging: false };
const PIXELS_PER_DAY = 60; // Approximate width of a day cell + gap

// Schedule state for add modal
let selectedFreq        = 'daily';
let selectedCustomDays  = [];          // Array of 0-6 (Sun=0)
let selectedOneTimeDate = '';
let selectedMonthly     = '';

// ─── Stable Summary (no random flicker) ──────
function getSummary(done, total) {
  if (total === 0) return { main: 'A clear slate awaits.', sub: '' };
  if (done === 0)  return { main: 'A new day begins.', sub: `${total} intention${total > 1 ? 's' : ''} waiting.` };
  if (done === total) return { main: 'All done. Well earned.', sub: `All ${total} intentions complete.` };
  if (done <= total / 2) return { main: 'Moving steadily forward.', sub: `You've completed ${done} of ${total} intentions today.` };
  return { main: 'Good progress.', sub: `You've completed ${done} of ${total} intentions today.` };
}

// ─── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // ── Onboarding Sequence ──
  if (!localStorage.getItem('telos_onboarded')) {
    const obScreen = document.getElementById('screen-onboarding');
    const bottomNav = document.getElementById('bottom-nav');
    const todayScreen = document.getElementById('screen-today');
    
    if (obScreen && bottomNav && todayScreen) {
      obScreen.classList.add('active');
      bottomNav.style.display = 'none';
      todayScreen.classList.remove('active');
      
      // Auto-advance from Step 1 to Step 2 after 3.2s to let CSS animations bloom (+1s as requested)
      setTimeout(() => {
        document.getElementById('onboarding-step-1').classList.remove('active');
        document.getElementById('onboarding-step-2').classList.add('active');
      }, 3200);

      // Final Start button
      document.getElementById('btn-start-app').addEventListener('click', async () => {
        localStorage.setItem('telos_onboarded', 'true');
        // Run tutorial after onboarding concludes
        setTimeout(() => runTutorial(), 2000);

        obScreen.style.transition = 'opacity 1.2s cubic-bezier(0.22, 1, 0.36, 1)';
        obScreen.style.opacity = '0';
        obScreen.style.pointerEvents = 'none';
        
        setTimeout(() => {
          obScreen.classList.remove('active');
          bottomNav.style.display = 'flex';
          todayScreen.classList.add('active'); // show manually or via switchScreen
          // We must ensure the header is drawn right
          renderHabits();
          buildCalendar();
        }, 1200);
      });
    }
  } else if (!localStorage.getItem('telos_notif_prompted') && localStorage.getItem('telos_tutorial')) {
    // Graceful fallback for existing users who already finished the tutorial
    localStorage.setItem('telos_notif_prompted', 'true');
    setTimeout(() => {
      requestNotifPermission().then(granted => {
        if (granted) {
          notifSettings.enabled = true;
          try { localStorage.setItem('telos_notif', JSON.stringify(notifSettings)); } catch(e) {}
          renderNotifications();
          scheduleNotifications().catch(() => {});
        }
      }).catch(() => {});
    }, 1500);
  }

  loadData();
  startWidgetSync(); // Start live polling for widget toggles
  buildCalendar();
  renderHabits();
  setupScrollHeader();
  renderJournal();
  renderProfile();
  renderIconPicker('icon-picker');
  bindEventListeners();
  bindScheduleUI();
  bindEditScheduleUI();
  renderNotifications();
  bindNotifUI();
  applyTheme();

  // Set up native notification channel + tap handler
  setupNotifChannel();
  bindNotifTapHandler();

  // Re-schedule notifications if they were previously enabled
  // (runs silently on native; no-ops gracefully on web)
  if (notifSettings.enabled) {
    scheduleNotifications().catch(() => {});
  }

  // Configure native status bar
  try {
    StatusBar.setStyle({ style: notifSettings.theme === 'dark' ? Style.Dark : Style.Light });
  } catch(e) { /* not on native */ }

  // Listen for native widget intents (only add_intention and add_journal now)
  App.addListener('appUrlOpen', data => {
    try {
      const url = new URL(data.url);
      if (url.protocol === 'telos:') {
        const type = url.searchParams.get('type');
        if (type === 'add_intention') {
          switchScreen('today', document.querySelector('[data-screen="today"]'));
          setTimeout(() => openAddModal(), 150);
        } else if (type === 'add_journal') {
          switchScreen('journal', document.querySelector('[data-screen="journal"]'));
        }
      }
    } catch(e) {}
  });

  // Globally prevent context menu on long-press targets to ensure mobile clean UX
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.habit-card') || e.target.closest('.journal-entry-block') || e.target.closest('.tutorial-overlay')) {
      e.preventDefault();
      return false;
    }
  }, false);

  // Splash Screen Dismissal
  const splash = document.getElementById('splash-screen');
  if (splash) {
    if (!localStorage.getItem('telos_onboarded')) {
      // Skip splash on first install to jump straight into onboarding
      splash.remove();
    } else {
      setTimeout(() => {
        splash.classList.add('fade-out');
        // Remove from DOM after transition
        setTimeout(() => splash.remove(), 1000);
      }, 1800); // 1.8s feel-good brand presence
    }
  }
});


// ─── Event Binding (no inline onclick) ────────
function bindEventListeners() {
  // Native Android hardware back button handler
  try {
    App.addListener('backButton', () => {
      // 1. Closing Overlays
      if (document.getElementById('confirm-overlay') && !document.getElementById('confirm-overlay').classList.contains('hidden')) { closeConfirm(); return; }
      if (document.getElementById('history-modal-overlay') && !document.getElementById('history-modal-overlay').classList.contains('hidden')) { closeHistoryModal(); return; }
      if (document.getElementById('calendar-modal-overlay') && !document.getElementById('calendar-modal-overlay').classList.contains('hidden')) { closeCalendarModal(); return; }
      if (document.getElementById('edit-modal-overlay') && !document.getElementById('edit-modal-overlay').classList.contains('hidden')) { closeEditModal(); return; }
      if (document.getElementById('modal-overlay') && !document.getElementById('modal-overlay').classList.contains('hidden')) { closeAddModal(); return; }
      if (document.getElementById('journal-archive-modal') && !document.getElementById('journal-archive-modal').classList.contains('hidden')) { closeJournalArchive(); return; }

      // 2. Closing inner screens
      if (document.getElementById('screen-habit-detail') && document.getElementById('screen-habit-detail').classList.contains('active')) { closeHabitDetail(); return; }
      if (document.getElementById('screen-all-habits') && document.getElementById('screen-all-habits').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-notif-settings') && document.getElementById('screen-notif-settings').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-about') && document.getElementById('screen-about').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-privacy') && document.getElementById('screen-privacy').classList.contains('active')) { switchScreen('profile'); return; }

      // 3. Exit app if at top level
      App.exitApp();
    });
  } catch(e) {}

  // Bottom navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      if (notifSettings.hapticsEnabled) {
        try { Haptics.impact({ style: ImpactStyle.Light }); } catch(err) {}
      }
      switchScreen(item.dataset.screen, item);
    });
  });

  // FAB
  document.getElementById('fab-add').addEventListener('click', () => openAddModal());

  // Empty state add button
  document.getElementById('btn-add-first').addEventListener('click', () => openAddModal());

  // Add Modal
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeAddModal();
  });
  document.getElementById('modal-close-btn').addEventListener('click', () => closeAddModal());
  document.getElementById('btn-cancel-modal').addEventListener('click', () => closeAddModal());
  document.getElementById('btn-add-habit').addEventListener('click', () => addHabit());

  // Edit Modal
  document.getElementById('edit-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'edit-modal-overlay') closeEditModal();
  });
  document.getElementById('edit-modal-close-btn').addEventListener('click', () => closeEditModal());
  document.getElementById('btn-cancel-edit').addEventListener('click', () => closeEditModal());
  document.getElementById('btn-save-edit').addEventListener('click', () => saveEditHabit());

  // Confirm dialog
  document.getElementById('confirm-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-overlay') closeConfirm();
  });
  document.getElementById('confirm-cancel').addEventListener('click', () => closeConfirm());

  // Journal
  document.getElementById('btn-save-journal').addEventListener('click', () => saveJournal());
  document.getElementById('btn-browse-journal').addEventListener('click', () => {
    openJournalArchive();
  });

  // Habit Detail
  document.getElementById('btn-back').addEventListener('click', () => closeHabitDetail());
  document.getElementById('btn-save-entry').addEventListener('click', () => saveHabitJournalEntry());
  document.getElementById('btn-edit-detail').addEventListener('click', () => {
    if (activeHabitId) openEditModal(activeHabitId);
  });

  // Profile — clear data
  const btnClearMenu = document.getElementById('btn-clear-data-menu');
  if (btnClearMenu) {
    btnClearMenu.addEventListener('click', () => confirmClear());
  }
  // Legacy button (if still in DOM during transition)
  const btnClearLegacy = document.getElementById('btn-clear-data');
  if (btnClearLegacy) {
    btnClearLegacy.addEventListener('click', () => confirmClear());
  }

  // Profile Menu Navigation
  document.getElementById('menu-all-habits').addEventListener('click', () => switchScreen('all-habits'));
  document.getElementById('menu-notif-settings').addEventListener('click', () => switchScreen('notif-settings'));
  document.getElementById('menu-about').addEventListener('click', () => switchScreen('about'));
  document.getElementById('menu-privacy').addEventListener('click', () => {
    switchScreen('privacy');
    const iframe = document.getElementById('privacy-iframe');
    if (iframe && iframe.src === 'about:blank') {
      iframe.src = 'https://privacy-policy-umber-one.vercel.app/';
    }
  });

  // Sub-screen back buttons
  document.getElementById('btn-back-habits').addEventListener('click', () => switchScreen('profile'));
  document.getElementById('btn-back-notif').addEventListener('click', () => switchScreen('profile'));
  document.getElementById('btn-back-about').addEventListener('click', () => switchScreen('profile'));
  document.getElementById('btn-back-privacy').addEventListener('click', () => switchScreen('profile'));

  // Settings Toggles
  document.getElementById('toggle-theme').addEventListener('change', (e) => {
    notifSettings.theme = e.target.checked ? 'dark' : 'light';
    save();
    applyTheme();
  });

  document.getElementById('toggle-haptics').addEventListener('change', (e) => {
    notifSettings.hapticsEnabled = e.target.checked;
    save();
  });

  // Calendar navigation modal
  const btnOpenCal = document.getElementById('btn-open-calendar');
  if (btnOpenCal) {
    btnOpenCal.addEventListener('click', () => openCalendarModal());
  }
  document.getElementById('modal-cal-prev').addEventListener('click', () => navigateModalCalendar(-1));
  document.getElementById('modal-cal-next').addEventListener('click', () => navigateModalCalendar(1));
  
  document.getElementById('calendar-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'calendar-modal-overlay') closeCalendarModal();
  });

  document.getElementById('btn-jump-today').addEventListener('click', () => {
    selectDate(todayKey());
  });

  bindSwipeNavigation();

  // Keyboard in add modal
  document.getElementById('habit-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('habit-desc-input').focus();
  });
  document.getElementById('habit-desc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addHabit();
  });

  // Keyboard in edit modal
  document.getElementById('edit-habit-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('edit-habit-desc-input').focus();
  });
  document.getElementById('edit-habit-desc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEditHabit();
  });

  // History Modal
  document.getElementById('history-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'history-modal-overlay') closeHistoryModal();
  });
  document.getElementById('history-modal-close-btn').addEventListener('click', () => closeHistoryModal());
  document.getElementById('btn-cancel-history').addEventListener('click', () => closeHistoryModal());
  document.getElementById('btn-save-history').addEventListener('click', () => saveHistoryModal());

  // Global Escape key — closes topmost overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('confirm-overlay').classList.contains('hidden')) {
        closeConfirm();
      } else if (!document.getElementById('history-modal-overlay').classList.contains('hidden')) {
        closeHistoryModal();
      } else if (!document.getElementById('calendar-modal-overlay').classList.contains('hidden')) {
        closeCalendarModal();
      } else if (!document.getElementById('edit-modal-overlay').classList.contains('hidden')) {
        closeEditModal();
      } else if (!document.getElementById('modal-overlay').classList.contains('hidden')) {
        closeAddModal();
      } else if (activeHabitId) {
        closeHabitDetail();
      }
    }
  });
}

// ─── Storage (with error handling) ────────────
function loadData() {
  try {
    habits       = JSON.parse(localStorage.getItem(STORAGE_KEY_HABITS))        || [];
    logs         = JSON.parse(localStorage.getItem(STORAGE_KEY_LOGS))          || {};
    journal      = JSON.parse(localStorage.getItem(STORAGE_KEY_JOURNAL))       || {};
    habitJournal = JSON.parse(localStorage.getItem(STORAGE_KEY_HABIT_JOURNAL)) || {};
    const savedNotif = JSON.parse(localStorage.getItem(STORAGE_KEY_NOTIF));
    if (savedNotif) notifSettings = Object.assign(notifSettings, savedNotif);
  } catch(e) {
    habits = []; logs = {}; journal = {}; habitJournal = {};
  }

  // Migration: Ensure all entries are arrays of objects {text, ts}
  Object.keys(journal).forEach(k => {
    if (typeof journal[k] === 'string') journal[k] = [{ text: journal[k], ts: Date.now() }];
    if (Array.isArray(journal[k])) {
      journal[k] = journal[k].map(item => typeof item === 'string' ? { text: item, ts: Date.now() } : item);
    }
  });
  Object.keys(habitJournal).forEach(hId => {
    Object.keys(habitJournal[hId]).forEach(k => {
      if (typeof habitJournal[hId][k] === 'string') habitJournal[hId][k] = [{ text: habitJournal[hId][k], ts: Date.now() }];
      if (Array.isArray(habitJournal[hId][k])) {
        habitJournal[hId][k] = habitJournal[hId][k].map(item => typeof item === 'string' ? { text: item, ts: Date.now() } : item);
      }
    });
  });

  // Seed with example habits on first open
  if (habits.length === 0) {
    const t = todayKey();
    const y = dateKey(new Date(Date.now() - 86400000));
    const b = dateKey(new Date(Date.now() - 172800000));

    habits = [
      { id: uid(), name: 'Morning Meditation', desc: '15 minutes of silence',    icon: 'self_improvement', schedule: { type: 'daily' }, createdAt: b },
      { id: uid(), name: 'Hydration',          desc: 'Drink 1L before noon',     icon: 'local_drink',      schedule: { type: 'daily' }, createdAt: b },
      { id: uid(), name: 'Read 20 pages',      desc: 'Atomic Habits',            icon: 'auto_stories',     schedule: { type: 'daily' }, createdAt: b },
      { id: uid(), name: 'Evening Walk',       desc: '30 minutes to disconnect', icon: 'directions_walk',  schedule: { type: 'daily' }, createdAt: b },
    ];

    logs[t] = { [habits[0].id]: true, [habits[1].id]: true };
    // Removing logs for y (yesterday) and b (before) as per user request to limit initial checks
    logs[y] = {};
    logs[b] = {};

    journal[t] = [{ text: "Starting my journey with Telos today. The interface feels calm and focused.", ts: Date.now() }];

    habitJournal[habits[0].id] = {
      [y]: [{ text: "Focus was better today. Found a nice 15 min guided track.", ts: Date.now() - 15000 }],
      [b]: [{ text: "First day. Mind was wandering a lot but stuck through it.", ts: Date.now() - 20000 }]
    };

    save();
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY_HABITS,        JSON.stringify(habits));
    localStorage.setItem(STORAGE_KEY_LOGS,          JSON.stringify(logs));
    localStorage.setItem(STORAGE_KEY_JOURNAL,       JSON.stringify(journal));
    localStorage.setItem(STORAGE_KEY_HABIT_JOURNAL, JSON.stringify(habitJournal));
    localStorage.setItem(STORAGE_KEY_NOTIF,         JSON.stringify(notifSettings));
    
    // Sync to Android widget via high-priority synchronous bridge
    const todayStr = todayKey();
    const dayLogs = logs[todayStr] || {};
    const scheduledHabits = habits.filter(h => shouldShowHabit(h, todayStr)).map(h => ({
      id: h.id,
      name: h.name,
      icon: h.icon,
      completed: !!dayLogs[h.id]
    }));

    const dataStr = JSON.stringify(scheduledHabits);

    // 1. Instant Synchronous Native Update (Now truly instant)
    if (typeof WidgetPlugin !== 'undefined' && WidgetPlugin.update) {
      WidgetPlugin.update({ data: dataStr }).catch(err => console.error("Widget Sync Err:", err));
    }

    // 2. Parallel Capacitor Preference Update (Asynchronous)
    Preferences.set({ key: 'widget_data', value: dataStr }).catch(err => console.error("Pref Sync Err:", err));

  } catch (e) {
    showToast('⚠ Storage full — changes may not persist.');
  }
}

function saveNotif() {
  try { localStorage.setItem(STORAGE_KEY_NOTIF, JSON.stringify(notifSettings)); }
  catch(e) { /* silent */ }
}

// ─── Widget ↔ App Live Sync ──────────────────
// The native widget toggles habits directly in SharedPreferences
// and queues each toggle in 'widget_pending_toggles'.
// We poll this key every 2s while the app is active so changes
// appear instantly even when the app is already open.
let _widgetPollTimer = null;

function syncWidgetToggles() {
  Preferences.get({ key: 'widget_data' }).then(result => {
    if (!result.value) return;
    try {
      const widgetData = JSON.parse(result.value);
      if (!Array.isArray(widgetData) || widgetData.length === 0) return;

      const today = todayKey();
      let changed = false;

      widgetData.forEach(item => {
        const id = item.id;
        if (!id) return;

        if (!logs[today]) logs[today] = {};
        const isAppCompleted = !!logs[today][id];
        
        if (item.completed !== isAppCompleted) {
          if (item.completed) {
            logs[today][id] = true;
          } else {
            delete logs[today][id];
          }
          changed = true;
        }
      });

      if (changed) {
        // Persist to localStorage
        localStorage.setItem(STORAGE_KEY_LOGS, JSON.stringify(logs));

        // Re-render UI ONLY if there was an actual disparity
        buildCalendar();
        renderHabits();
        renderProfile();
      }
    } catch(e) {
      console.error('Widget sync error:', e);
    }
  }).catch(() => { /* not on native */ });
}

function startWidgetSync() {
  // Initial sync
  syncWidgetToggles();
  // Poll every 2 seconds for widget changes
  if (!_widgetPollTimer) {
    _widgetPollTimer = setInterval(syncWidgetToggles, 2000);
  }
}

function stopWidgetSync() {
  if (_widgetPollTimer) {
    clearInterval(_widgetPollTimer);
    _widgetPollTimer = null;
  }
}

// Start polling on load, also sync on app resume from background
try {
  App.addListener('appStateChange', (state) => {
    if (state.isActive) {
      syncWidgetToggles();
      startWidgetSync();
      // Refresh the 7-day notification window every time the app comes to foreground
      if (notifSettings.enabled) scheduleNotifications().catch(() => {});
    } else {
      stopWidgetSync();
    }
  });
} catch(e) { /* not on native */ }

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === 'visible') {
        syncWidgetToggles();
        startWidgetSync();
    } else {
        stopWidgetSync();
    }
});

// ─── Swipe Navigation ─────────────────────────
function bindSwipeNavigation() {
  // Disabled: Native horizontal scroll + scroll-snap used instead
}

function applyStripTranslation(tx) {}
function cancelMomentum() {}
function startMomentum(v) {}
function snapStrip() {}
function shiftStrip(delta) {}
function changeSelectedDate(delta) {}

// ─── Calendar Strip ───────────────────────────
function buildCalendar() {
  const strip = document.getElementById('calendar-strip');
  const label = document.getElementById('month-label');
  const jumpBtn = document.getElementById('btn-jump-today');

  const centerDate = parseDate(stripCenterDate);

  const days = [];
  for (let i = -15; i <= 15; i++) {
    const d = new Date(centerDate);
    d.setDate(centerDate.getDate() + i);
    days.push(d);
  }

  label.innerHTML = `${MONTH_NAMES[centerDate.getMonth()]} ${centerDate.getFullYear()} <span class="material-symbols-outlined" style="font-size: 16px;">expand_more</span>`;
  
  // Show "Today" button only when we are NOT looking at today on the Today Screen
  if (selectedDate === todayKey()) {
    jumpBtn.classList.add('hidden');
  } else {
    jumpBtn.classList.remove('hidden');
  }

  strip.innerHTML = '';

  days.forEach(d => {
    const key      = dateKey(d);
    const isToday    = key === todayKey();
    const isSelected = key === selectedDate;
    const isFuture   = key > todayKey();
    const hasDone    = logs[key] && Object.keys(logs[key]).length > 0;

    const el = document.createElement('div');
    el.className = 'cal-day'
      + (isToday    ? ' today'          : '')
      + (isSelected ? ' selected'       : '')
      + (hasDone    ? ' has-completion' : '')
      + (isFuture   ? ' future'         : '');

    el.setAttribute('aria-label', d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }));
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');

    el.innerHTML = `
      <span class="cal-letter">${DAY_LABELS[d.getDay()]}</span>
      <span class="cal-num">${d.getDate()}</span>
    `;

    el.addEventListener('click', () => selectDate(key));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDate(key); }
    });

    strip.appendChild(el);
  });
  
  // Center natively
  setTimeout(() => {
    const activeEl = strip.querySelector('.cal-day.selected');
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
    }
  }, 100);
}

// ─── Full Calendar Modal ──────────────────────
function openCalendarModal() {
  modalViewingDate = parseDate(selectedDate);
  document.getElementById('calendar-modal-overlay').classList.remove('hidden');
  renderModalCalendar();
}

function closeCalendarModal() {
  document.getElementById('calendar-modal-overlay').classList.add('hidden');
}

function navigateModalCalendar(delta) {
  modalViewingDate.setMonth(modalViewingDate.getMonth() + delta);
  renderModalCalendar();
}

function renderModalCalendar() {
  const label = document.getElementById('cal-month-label');
  const grid = document.getElementById('calendar-grid-days');

  const y = modalViewingDate.getFullYear();
  const m = modalViewingDate.getMonth();

  label.textContent = `${MONTH_NAMES[m]} ${y}`;

  grid.innerHTML = '';

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const totalCells = 42;

  for (let i = 0; i < totalCells; i++) {
    const dNum = i - firstDay + 1;
    const cell = document.createElement('div');

    if (dNum <= 0 || dNum > daysInMonth) {
      cell.className = 'cal-modal-cell empty';
    } else {
      const cellDate = new Date(y, m, dNum);
      const key = dateKey(cellDate);
      const isFuture = key > todayKey();
      const isSelected = key === selectedDate;
      const isToday = key === todayKey();

      cell.className = 'cal-modal-cell'
        + (isSelected ? ' selected' : '')
        + (isToday ? ' today' : '')
        + (isFuture ? ' future' : '');
      cell.textContent = dNum;

      cell.addEventListener('click', () => {
        closeCalendarModal();
        selectDate(key);
      });
      if (isFuture) cell.title = 'Future date — view only';
    }
    grid.appendChild(cell);
  }
}

function selectDate(key) {
  selectedDate = key;
  stripCenterDate = key;
  buildCalendar();
  renderHabits();
}

function updateSummary() {
  const isFuture = selectedDate > todayKey();
  const dayLogs = logs[selectedDate] || {};
  const visibleHabits = habits.filter(h => shouldShowHabit(h, selectedDate));
  const completedCount = visibleHabits.filter(h => dayLogs[h.id]).length;
  const total = visibleHabits.length;
  
  let main, sub;
  if (isFuture) {
    main = 'A future day.';
    sub = total > 0 ? `${total} intention${total > 1 ? 's' : ''} planned.` : '';
  } else {
    const s = getSummary(completedCount, total);
    main = s.main; sub = s.sub;
  }
  document.getElementById('summary-text').firstChild.textContent = main;
  document.getElementById('summary-sub').textContent = sub;
}

// ─── Habit Rendering ──────────────────────────
function shouldShowHabit(habit, dateStr) {
  if (!habit.schedule) return true;
  if (habit.createdAt && dateStr < habit.createdAt) return false;

  const d = parseDate(dateStr);
  const dayOfWeek = d.getDay(); // 0=Sun, 6=Sat
  const type = habit.schedule.type;

  if (type === 'daily') return true;
  if (type === 'weekdays') return dayOfWeek >= 1 && dayOfWeek <= 5;
  if (type === 'weekends') return dayOfWeek === 0 || dayOfWeek === 6;
  if (type === 'onetime') return habit.schedule.date === dateStr;

  if (type === 'custom') {
    // Check days of week if any selected
    if (habit.schedule.days && habit.schedule.days.length > 0) {
      if (!habit.schedule.days.includes(dayOfWeek)) return false;
    }
    // Check monthly pattern if selected
    if (habit.schedule.monthly) {
      const pattern = habit.schedule.monthly;
      const dateNum = d.getDate();
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (pattern === 'first' && dateNum !== 1) return false;
      if (pattern === 'last' && dateNum !== lastDay) return false;
      if (pattern === '15th' && dateNum !== 15) return false;
    }
    return true;
  }
  return true;
}

function renderHabits() {
  const list       = document.getElementById('habit-list');
  const emptyState = document.getElementById('empty-state');

  list.innerHTML = '';

  const dayLogs = logs[selectedDate] || {};
  
  // Filter habits for the currently selected date
  const visibleHabits = habits.filter(h => shouldShowHabit(h, selectedDate));
  
  updateSummary();

  if (visibleHabits.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  const isReadOnly = selectedDate > todayKey(); // Only future dates are read-only

  // Stable order — no sorting on completion to prevent layout shift
  visibleHabits.forEach((habit, idx) => {
    const done = !!dayLogs[habit.id];
    const card = document.createElement('div');
    card.className = 'habit-card' + (done ? ' completed' : '');
    card.style.animationDelay = `${idx * 40}ms`;
    card.setAttribute('data-id', habit.id);

    card.innerHTML = `
      <div class="habit-card-info" role="button" tabindex="0" aria-label="View details for ${escapeHtml(habit.name)}">
        <div class="habit-card-icon-row">
          <span class="material-symbols-outlined habit-card-icon" style="font-variation-settings:'FILL' ${done ? 1 : 0};">${habit.icon}</span>
          <span class="habit-name${done ? ' habit-name--done' : ''}">${escapeHtml(habit.name)}</span>
        </div>
        ${habit.desc ? `<p class="habit-desc">${escapeHtml(habit.desc)}</p>` : ''}
      </div>
      <button
        class="habit-toggle${done ? ' done' : ''}${isReadOnly ? ' disabled' : ''}"
        aria-label="${done ? 'Mark as incomplete' : 'Mark as complete'}: ${escapeHtml(habit.name)}"
        data-id="${habit.id}"
        id="toggle-${habit.id}"
        ${isReadOnly ? 'disabled' : ''}
      >
        <span class="material-symbols-outlined check-icon" style="font-variation-settings:'FILL' 1,'wght' 600;">check</span>
      </button>
    `;

    // Toggle click — does NOT propagate to info area
    card.querySelector('.habit-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isReadOnly) return;
      toggleHabit(habit.id, card);
    });

    // Only the info area (left side) opens the detail — not the toggle button
    const infoArea = card.querySelector('.habit-card-info');
    
    let pressTimer;
    let longPressTriggered = false;

    const startPress = (e) => {
      if (e.target.closest('.habit-toggle')) return;
      longPressTriggered = false;
      pressTimer = setTimeout(() => {
        longPressTriggered = true;
        if (notifSettings.hapticsEnabled) {
          try { Haptics.impact({ style: ImpactStyle.Heavy }); } catch(err) {}
        }
        deleteHabit(habit.id, habit.name);
      }, 600);
    };

    const cancelPress = () => {
      clearTimeout(pressTimer);
    };

    infoArea.addEventListener('mousedown', startPress);
    infoArea.addEventListener('touchstart', startPress, { passive: true });

    infoArea.addEventListener('mouseup', cancelPress);
    infoArea.addEventListener('mouseleave', cancelPress);
    infoArea.addEventListener('touchend', cancelPress);
    infoArea.addEventListener('touchmove', cancelPress, { passive: true });

    infoArea.addEventListener('click', (e) => {
      if (longPressTriggered) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      openHabitDetail(habit.id);
    });

    infoArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHabitDetail(habit.id); }
    });

    list.appendChild(card);
  });
}

function toggleHabit(id, cardEl) {
  if (!logs[selectedDate]) logs[selectedDate] = {};
  if (selectedDate > todayKey()) return; // Cannot toggle future dates

  const wasDone = !!logs[selectedDate][id];

  // Haptic feedback
  if (notifSettings.hapticsEnabled) {
    try { Haptics.impact({ style: ImpactStyle.Heavy }); } catch(e) { /* unsupported */ }
  }

  // Update state immediately
  if (wasDone) {
    delete logs[selectedDate][id];
  } else {
    logs[selectedDate][id] = true;
  }

  // ── In-place DOM update (no layout shift) ──
  const nowDone = !wasDone;
  const toggleBtn = cardEl.querySelector('.habit-toggle');
  const icon      = cardEl.querySelector('.habit-card-icon');
  const nameEl    = cardEl.querySelector('.habit-name');

  toggleBtn.classList.toggle('done', nowDone);

  if (nowDone) {
    cardEl.classList.add('completed');
    icon.style.fontVariationSettings = "'FILL' 1";
    nameEl.classList.add('habit-name--done');
  } else {
    cardEl.classList.remove('completed', 'completing');
    icon.style.fontVariationSettings = "'FILL' 0";
    nameEl.classList.remove('habit-name--done');
  }

  // Update summary text without rebuilding the entire list
  updateSummary();
  buildCalendar();
  renderProfile();

  if (nowDone) {
    const dayLogs = logs[selectedDate] || {};
    const visible = habits.filter(h => shouldShowHabit(h, selectedDate));
    const done = visible.filter(h => dayLogs[h.id]).length;
    if (visible.length > 0 && done === visible.length) showToast('✦ All intentions complete today!');
  }

  // Persist state after UI updates
  save();
}

// ─── Add Habit Modal ──────────────────────────
function renderIconPicker(containerId) {
  const picker = document.getElementById(containerId);
  picker.innerHTML = '';
  HABIT_ICONS.forEach(icon => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-option' + (icon === selectedIcon ? ' selected' : '');
    btn.setAttribute('aria-label', icon.replace(/_/g, ' '));
    btn.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
    btn.addEventListener('click', () => {
      selectedIcon = icon;
      picker.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    picker.appendChild(btn);
  });
}

function openAddModal() {
  // Reset schedule state
  selectedFreq        = 'daily';
  selectedCustomDays  = [];
  selectedOneTimeDate = '';
  selectedMonthly     = '';

  // Reset chip UI
  document.querySelectorAll('.freq-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.freq === 'daily');
    c.setAttribute('aria-pressed', c.dataset.freq === 'daily' ? 'true' : 'false');
  });

  // Reset panels
  document.getElementById('freq-onetime-panel').classList.add('hidden');
  document.getElementById('freq-custom-panel').classList.add('hidden');
  selectedOneTimeDate = todayKey();
  onetimeViewDate = parseDate(todayKey());

  // Reset monthly chips
  document.querySelectorAll('.monthly-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.val === '');
  });
  selectedMonthly = '';

  // Reset icon
  selectedIcon = HABIT_ICONS[0];
  renderIconPicker('icon-picker');

  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  trapFocus(document.getElementById('add-modal'));
  setTimeout(() => document.getElementById('habit-name-input').focus(), 100);
}

function closeAddModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('habit-name-input').value = '';
  document.getElementById('habit-desc-input').value = '';
  selectedIcon = HABIT_ICONS[0];
  selectedFreq = 'daily';
  selectedCustomDays = [];
  releaseFocus(document.getElementById('add-modal'));
}

// ─── Schedule UI Binding ──────────────────────
let onetimeViewDate = new Date();

function renderOnetimeCalendar() {
  const label = document.getElementById('onetime-month-label');
  const grid = document.getElementById('onetime-cal-grid');
  if (!label || !grid) return;

  const y = onetimeViewDate.getFullYear();
  const m = onetimeViewDate.getMonth();
  label.textContent = `${MONTH_NAMES[m]} ${y}`;

  grid.innerHTML = '';
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  // Leading blanks
  for (let i = 0; i < firstDay; i++) {
    const blank = document.createElement('div');
    blank.className = 'onetime-cal-cell empty';
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(y, m, d);
    const key = dateKey(cellDate);
    const isToday = key === todayKey();
    const isSelected = key === selectedOneTimeDate;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'onetime-cal-cell'
      + (isToday ? ' today' : '')
      + (isSelected ? ' selected' : '');
    cell.textContent = d;
    cell.addEventListener('click', () => {
      selectedOneTimeDate = key;
      document.getElementById('onetime-date-input').value = key;
      renderOnetimeCalendar();
    });
    grid.appendChild(cell);
  }
}

function bindScheduleUI() {
  // Frequency chip clicks
  document.getElementById('freq-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.freq-chip');
    if (!chip) return;

    selectedFreq = chip.dataset.freq;
    document.querySelectorAll('.freq-chip').forEach(c => {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
    });

    // Show/hide panels
    document.getElementById('freq-onetime-panel').classList.toggle('hidden', selectedFreq !== 'onetime');
    document.getElementById('freq-custom-panel').classList.toggle('hidden', selectedFreq !== 'custom');

    // Render the one-time calendar when shown
    if (selectedFreq === 'onetime') renderOnetimeCalendar();
  });

  // One-time calendar nav
  document.getElementById('onetime-prev-btn').addEventListener('click', () => {
    onetimeViewDate.setMonth(onetimeViewDate.getMonth() - 1);
    renderOnetimeCalendar();
  });
  document.getElementById('onetime-next-btn').addEventListener('click', () => {
    onetimeViewDate.setMonth(onetimeViewDate.getMonth() + 1);
    renderOnetimeCalendar();
  });

  // Day toggle clicks
  document.getElementById('day-toggles').addEventListener('click', (e) => {
    const btn = e.target.closest('.day-toggle');
    if (!btn) return;
    const day = parseInt(btn.dataset.day, 10);
    if (selectedCustomDays.includes(day)) {
      selectedCustomDays = selectedCustomDays.filter(d => d !== day);
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    } else {
      selectedCustomDays.push(day);
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  });

  // Monthly pattern chips
  document.getElementById('monthly-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.monthly-chip');
    if (!chip) return;
    selectedMonthly = chip.dataset.val;
    document.querySelectorAll('.monthly-chip').forEach(c => {
      c.classList.toggle('active', c === chip);
    });
  });
}

function addHabit() {
  const nameInput = document.getElementById('habit-name-input');
  const name = nameInput.value.trim().slice(0, 60);
  const desc = document.getElementById('habit-desc-input').value.trim().slice(0, 80);

  if (!name) {
    nameInput.focus();
    nameInput.style.borderColor = '#e53935';
    setTimeout(() => nameInput.style.borderColor = '', 1200);
    return;
  }

  // Build schedule object
  const schedule = { type: selectedFreq };
  if (selectedFreq === 'onetime') {
    schedule.date = selectedOneTimeDate || todayKey();
  } else if (selectedFreq === 'custom') {
    schedule.days = [...selectedCustomDays];
    if (selectedMonthly) schedule.monthly = selectedMonthly;
  }

  const newHabit = {
    id: uid(),
    name,
    desc,
    icon: selectedIcon,
    schedule,
    createdAt: todayKey(),
  };

  habits.push(newHabit);
  save();
  closeAddModal();
  renderHabits();
  renderProfile();
  showToast(`"${name}" added.`);
}

// ─── Edit Habit Modal ─────────────────────────
let editOnetimeViewDate = new Date();
let editSelectedFreq = 'daily';
let editSelectedCustomDays = [];
let editSelectedOneTimeDate = '';
let editSelectedMonthly = '';

function renderEditOnetimeCalendar() {
  const label = document.getElementById('edit-onetime-month-label');
  const grid = document.getElementById('edit-onetime-cal-grid');
  if (!label || !grid) return;

  const y = editOnetimeViewDate.getFullYear();
  const m = editOnetimeViewDate.getMonth();
  label.textContent = `${MONTH_NAMES[m]} ${y}`;

  grid.innerHTML = '';
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const blank = document.createElement('div');
    blank.className = 'onetime-cal-cell empty';
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(y, m, d);
    const key = dateKey(cellDate);
    const isToday = key === todayKey();
    const isSelected = key === editSelectedOneTimeDate;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'onetime-cal-cell'
      + (isToday ? ' today' : '')
      + (isSelected ? ' selected' : '');
    cell.textContent = d;
    cell.addEventListener('click', () => {
      editSelectedOneTimeDate = key;
      document.getElementById('edit-onetime-date-input').value = key;
      renderEditOnetimeCalendar();
    });
    grid.appendChild(cell);
  }
}

function bindEditScheduleUI() {
  // Frequency chip clicks
  document.getElementById('edit-freq-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.freq-chip');
    if (!chip) return;

    editSelectedFreq = chip.dataset.freq;
    document.querySelectorAll('#edit-freq-chips .freq-chip').forEach(c => {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
    });

    document.getElementById('edit-freq-onetime-panel').classList.toggle('hidden', editSelectedFreq !== 'onetime');
    document.getElementById('edit-freq-custom-panel').classList.toggle('hidden', editSelectedFreq !== 'custom');

    if (editSelectedFreq === 'onetime') renderEditOnetimeCalendar();
  });

  // One-time calendar nav
  document.getElementById('edit-onetime-prev-btn').addEventListener('click', () => {
    editOnetimeViewDate.setMonth(editOnetimeViewDate.getMonth() - 1);
    renderEditOnetimeCalendar();
  });
  document.getElementById('edit-onetime-next-btn').addEventListener('click', () => {
    editOnetimeViewDate.setMonth(editOnetimeViewDate.getMonth() + 1);
    renderEditOnetimeCalendar();
  });

  // Day toggle clicks
  document.getElementById('edit-day-toggles').addEventListener('click', (e) => {
    const btn = e.target.closest('.day-toggle');
    if (!btn) return;
    const day = parseInt(btn.dataset.day, 10);
    if (editSelectedCustomDays.includes(day)) {
      editSelectedCustomDays = editSelectedCustomDays.filter(d => d !== day);
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
    } else {
      editSelectedCustomDays.push(day);
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
  });

  // Monthly pattern chips
  document.getElementById('edit-monthly-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.monthly-chip');
    if (!chip) return;
    editSelectedMonthly = chip.dataset.val;
    document.querySelectorAll('#edit-monthly-chips .monthly-chip').forEach(c => {
      c.classList.toggle('active', c === chip);
    });
  });
}

function openEditModal(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;

  editingHabitId = habitId;
  document.getElementById('edit-habit-name-input').value = habit.name;
  document.getElementById('edit-habit-desc-input').value = habit.desc || '';
  selectedIcon = habit.icon;
  renderIconPicker('edit-icon-picker');

  // Populate schedule state from the habit
  const sched = habit.schedule || { type: 'daily' };
  editSelectedFreq = sched.type || 'daily';
  editSelectedOneTimeDate = sched.date || todayKey();
  editSelectedCustomDays = sched.days ? [...sched.days] : [];
  editSelectedMonthly = sched.monthly || '';

  // Update chip UI
  document.querySelectorAll('#edit-freq-chips .freq-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.freq === editSelectedFreq);
    c.setAttribute('aria-pressed', c.dataset.freq === editSelectedFreq ? 'true' : 'false');
  });

  // Show/hide panels
  document.getElementById('edit-freq-onetime-panel').classList.toggle('hidden', editSelectedFreq !== 'onetime');
  document.getElementById('edit-freq-custom-panel').classList.toggle('hidden', editSelectedFreq !== 'custom');

  // Populate one-time calendar
  if (editSelectedFreq === 'onetime') {
    editOnetimeViewDate = parseDate(editSelectedOneTimeDate);
    renderEditOnetimeCalendar();
  }

  // Populate custom day toggles
  document.querySelectorAll('#edit-day-toggles .day-toggle').forEach(btn => {
    const day = parseInt(btn.dataset.day, 10);
    const active = editSelectedCustomDays.includes(day);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // Populate monthly chips
  document.querySelectorAll('#edit-monthly-chips .monthly-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.val === editSelectedMonthly);
  });

  const overlay = document.getElementById('edit-modal-overlay');
  overlay.classList.remove('hidden');
  trapFocus(document.getElementById('edit-modal'));
  setTimeout(() => document.getElementById('edit-habit-name-input').focus(), 100);
}

function closeEditModal() {
  editingHabitId = null;
  document.getElementById('edit-modal-overlay').classList.add('hidden');
  releaseFocus(document.getElementById('edit-modal'));
}

function saveEditHabit() {
  if (!editingHabitId) return;

  const nameInput = document.getElementById('edit-habit-name-input');
  const name = nameInput.value.trim().slice(0, 60);
  const desc = document.getElementById('edit-habit-desc-input').value.trim().slice(0, 80);

  if (!name) {
    nameInput.focus();
    nameInput.style.borderColor = '#e53935';
    setTimeout(() => nameInput.style.borderColor = '', 1200);
    return;
  }

  // Build schedule object from edit state
  const schedule = { type: editSelectedFreq };
  if (editSelectedFreq === 'onetime') {
    schedule.date = editSelectedOneTimeDate || todayKey();
  } else if (editSelectedFreq === 'custom') {
    schedule.days = [...editSelectedCustomDays];
    if (editSelectedMonthly) schedule.monthly = editSelectedMonthly;
  }

  const habit = habits.find(h => h.id === editingHabitId);
  if (habit) {
    habit.name = name;
    habit.desc = desc;
    habit.icon = selectedIcon;
    habit.schedule = schedule;
    save();
    renderHabits();
    renderProfile();

    // Update detail screen if currently showing this habit
    if (activeHabitId === editingHabitId) {
      document.getElementById('detail-habit-name').textContent = habit.name;
      document.getElementById('detail-icon').textContent = habit.icon;
    }
  }

  closeEditModal();
  showToast('Habit updated.');
}

// ─── Journal ──────────────────────────────────
function renderJournal() {
  const label    = document.getElementById('journal-date-label');
  const textarea = document.getElementById('journal-textarea');
  const history  = document.getElementById('journal-history');
  history.innerHTML = '';

  const d = parseDate(selectedDate);
  label.textContent = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  textarea.value = ''; // Always empty for new entry
  textarea.placeholder = `Add a new entry for ${d.toLocaleDateString('en-US', { month:'short', day:'numeric' })}...`;

  // Flat list of Dates that have entries, sorted newest first
  const sortedDates = Object.entries(journal)
    .filter(([_, items]) => Array.isArray(items) && items.some(i => i.text && i.text.trim()))
    .map(([k]) => k)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 5);

  if (sortedDates.length === 0) {
    const msg = document.createElement('p');
    msg.style.cssText = 'font-family:var(--font-display);font-size:15px;color:var(--slate);padding:16px 0;font-style:italic;text-align:center;';
    msg.textContent = 'No past entries yet.';
    history.appendChild(msg);
    return;
  }

  const header = document.createElement('p');
  header.className = 'section-heading';
  header.style.marginBottom = '16px';
  header.textContent = 'Your Journal Feed';
  history.appendChild(header);

  sortedDates.forEach((key) => {
    const d = parseDate(key);
    const dayEntries = journal[key] || [];

    const card = document.createElement('div');
    card.className = 'journal-entry-card';
    card.style.cursor = 'default';
    card.style.padding = '0'; // We will pad the blocks instead



    // Important: We sort the day's entries NEWEST first inside the card
    const sortedDayItems = [...dayEntries]
      .map((item, originalIndex) => ({ ...item, originalIndex }))
      .filter(i => i.text && i.text.trim())
      .sort((a, b) => b.ts - a.ts);

    sortedDayItems.forEach((item, idx) => {
      const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
      const isLast = idx === sortedDayItems.length - 1;

      const block = document.createElement('div');
      block.className = 'journal-entry-block';
      block.setAttribute('role', 'button');
      block.setAttribute('tabindex', '0');
      block.style.padding = '12px 16px';
      if (!isLast) block.style.borderBottom = '1px solid rgba(0,0,0,0.05)';

      block.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
          <span style="font-size: 11px; font-weight: 700; color: var(--sage); text-transform:uppercase;">${timeStr}</span>
        </div>
        <div class="journal-entry-body">${escapeHtml(item.text)}</div>
      `;

      let journalPressTimer;
      let journalLongPressTriggered = false;

      const startJournalPress = () => {
        journalLongPressTriggered = false;
        journalPressTimer = setTimeout(() => {
          journalLongPressTriggered = true;
          if (notifSettings.hapticsEnabled) {
            try { Haptics.impact({ style: ImpactStyle.Heavy }); } catch(err) {}
          }
          deleteJournalEntry(key, item.originalIndex, 'journal');
        }, 600);
      };

      const cancelJournalPress = () => {
        clearTimeout(journalPressTimer);
      };

      block.addEventListener('mousedown', startJournalPress);
      block.addEventListener('touchstart', startJournalPress, { passive: true });
      block.addEventListener('mouseup', cancelJournalPress);
      block.addEventListener('mouseleave', cancelJournalPress);
      block.addEventListener('touchend', cancelJournalPress);
      block.addEventListener('touchmove', cancelJournalPress, { passive: true });

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        if (journalLongPressTriggered) return;
        openHistoryModal(key, item.text, null, item.originalIndex);
      });

      block.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); block.click(); }
      });

      card.appendChild(block);
    });

    // Handle initial card creation properly by re-prepending the date
    const dateHeader = document.createElement('div');
    dateHeader.className = 'journal-entry-date';
    dateHeader.style.cssText = 'padding: 12px 16px 4px; color: var(--slate); font-size: 11px; opacity: 0.7;';
    dateHeader.textContent = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }).toUpperCase();
    card.prepend(dateHeader);

    history.appendChild(card);
  });
}

async function deleteJournalEntry(key, index, type = 'journal', habitId = null) {
  const confirmed = await showConfirm(
    "Delete Entry?",
    `Are you sure you want to remove this memory? This action cannot be undone.`,
    "Delete",
    true
  );

  if (confirmed) {
    if (type === 'journal') {
      if (journal[key] && journal[key][index]) {
        journal[key].splice(index, 1);
        if (journal[key].length === 0) delete journal[key];
        save();
      }
    } else if (type === 'habit' && habitId) {
      if (habitJournal[habitId] && habitJournal[habitId][key] && habitJournal[habitId][key][index]) {
        habitJournal[habitId][key].splice(index, 1);
        if (habitJournal[habitId][key].length === 0) delete habitJournal[habitId][key];
        // If whole habit journal empty
        if (Object.keys(habitJournal[habitId]).length === 0) delete habitJournal[habitId];
        save();
      }
    }
    
    // Refresh whichever view is currently active
    if (currentScreen === 'journal') renderJournal();
    if (currentScreen === 'today') renderHabits(); // if detail is open, it might need refreshing
    
    // Specifically refresh archive if open
    const archiveOverlay = document.getElementById('archive-modal-overlay');
    if (archiveOverlay && !archiveOverlay.classList.contains('hidden')) {
      renderJournalArchive();
    }

    showToast("Entry removed");
    if (notifSettings.hapticsEnabled) {
      try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(err) {}
    }
  }
}

function saveJournal() {
  const text = document.getElementById('journal-textarea').value.trim();
  if (text) {
    if (!Array.isArray(journal[selectedDate])) journal[selectedDate] = [];
    journal[selectedDate].push({ text, ts: Date.now() });
    save();
    showToast('Entry added.');
    renderJournal();
  }
}

// ─── History Edit Modal ───────────────────────
function openHistoryModal(key, text, habitId = null, index = null) {
  historyEditContext = { key, habitId, index };
  const d = parseDate(key);

  document.getElementById('history-modal-title').textContent = index !== null ? 'Edit Entry' : 'New Entry';

  document.getElementById('history-modal-date').textContent = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const habitInfo = document.getElementById('history-habit-info');
  if (habitId) {
    const h = habits.find(x => x.id === habitId);
    habitInfo.textContent = h ? `Note for: ${h.name}` : 'Habit Note';
    habitInfo.style.display = 'block';
  } else {
    habitInfo.style.display = 'none';
  }

  document.getElementById('history-edit-textarea').value = text || '';
  document.getElementById('history-modal-overlay').classList.remove('hidden');

  trapFocus(document.getElementById('history-modal'));
  setTimeout(() => document.getElementById('history-edit-textarea').focus(), 100);
}

function closeHistoryModal() {
  historyEditContext = { key: null, habitId: null, index: null };
  document.getElementById('history-modal-overlay').classList.add('hidden');
  releaseFocus(document.getElementById('history-modal'));
}

function saveHistoryModal() {
  const { key, habitId, index } = historyEditContext;
  if (!key) return;

  const text = document.getElementById('history-edit-textarea').value.trim();

  const source = habitId ? habitJournal[habitId] : journal;
  if (!source[key]) source[key] = [];

  if (index !== null) {
    if (typeof source[key][index] === 'object') {
      source[key][index].text = text;
    } else {
      source[key][index] = { text, ts: Date.now() };
    }
  } else {
    source[key].push({ text, ts: Date.now() });
  }

  save();
  closeHistoryModal();
  showToast('Record updated.');

  // Refresh current view
  if (currentScreen === 'journal') renderJournal();
  if (activeHabitId) renderHabitEntries(activeHabitId);
}

// ─── Profile / Stats ──────────────────────────
function renderProfile() {
  document.getElementById('stat-total').textContent = habits.length;

  const todayStr = todayKey();
  const dayLogs = logs[todayStr] || {};
  const todayVisible = habits.filter(h => shouldShowHabit(h, todayStr));
  const doneToday = todayVisible.filter(h => dayLogs[h.id]).length;
  document.getElementById('stat-completed-today').textContent = doneToday;

  // Streak: consecutive days where all SCHEDULED habits are done
  let streak = 0;
  const d = new Date();
  while (true) {
    const k = dateKey(d);
    const dayLog = logs[k] || {};
    const scheduled = habits.filter(h => shouldShowHabit(h, k));
    if (scheduled.length === 0) {
      // No habits scheduled — skip this day, don't break streak
      d.setDate(d.getDate() - 1);
      // Safety: don't loop forever if no habits exist
      if (streak === 0 && d < new Date(Date.now() - 365 * 86400000)) break;
      continue;
    }
    const doneCount = scheduled.filter(h => dayLog[h.id]).length;
    if (doneCount > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  document.getElementById('stat-streak').textContent = streak;

  // Completion rate over last 7 days (schedule-aware)
  let totalPossible = 0;
  let totalDone = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    const k = dateKey(day);
    const dl = logs[k] || {};
    const scheduled = habits.filter(h => shouldShowHabit(h, k));
    totalPossible += scheduled.length;
    totalDone += scheduled.filter(h => dl[h.id]).length;
  }
  const rate = totalPossible > 0 ? Math.round((totalDone / totalPossible) * 100) : 0;
  document.getElementById('stat-rate').textContent = rate + '%';

  // Habit management lists (split into recurring and one-time)
  const listRecurring = document.getElementById('habit-management-list-recurring');
  const listOnetime = document.getElementById('habit-management-list-onetime');
  listRecurring.innerHTML = '';
  listOnetime.innerHTML = '';

  const recurringHabits = habits.filter(h => !h.schedule || h.schedule.type !== 'onetime');
  const onetimeHabits = habits.filter(h => h.schedule && h.schedule.type === 'onetime');

  function renderManageRow(h, container) {
    const sched = h.schedule || { type: 'daily' };
    const typeLabels = { daily: 'Daily', weekdays: 'Weekdays', weekends: 'Weekends', onetime: 'One-Time', custom: 'Custom' };
    const badge = typeLabels[sched.type] || 'Daily';

    const li = document.createElement('li');
    li.className = 'manage-habit-row';
    li.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px;color:var(--sage);flex-shrink:0;">${h.icon}</span>
      <div style="flex:1;min-width:0;">
        <span class="manage-habit-name">${escapeHtml(h.name)}</span>
        <span class="manage-habit-badge">${badge}${sched.type === 'onetime' && sched.date ? ' · ' + sched.date : ''}</span>
      </div>
      <button class="btn-edit-habit-inline" aria-label="Edit ${escapeHtml(h.name)}" data-id="${h.id}">
        <span class="material-symbols-outlined">edit</span>
      </button>
      <button class="btn-delete-habit" aria-label="Delete ${escapeHtml(h.name)}" data-id="${h.id}">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;
    li.querySelector('.btn-edit-habit-inline').addEventListener('click', () => openEditModal(h.id));
    li.querySelector('.btn-delete-habit').addEventListener('click', () => deleteHabit(h.id, h.name));
    container.appendChild(li);
  }

  if (recurringHabits.length === 0) {
    const empty = document.createElement('li');
    empty.style.cssText = 'font-family:var(--font-display);font-size:14px;color:var(--slate);padding:12px 0;font-style:italic;';
    empty.textContent = 'No recurring habits yet.';
    listRecurring.appendChild(empty);
  } else {
    recurringHabits.forEach(h => renderManageRow(h, listRecurring));
  }

  if (onetimeHabits.length === 0) {
    const empty = document.createElement('li');
    empty.style.cssText = 'font-family:var(--font-display);font-size:14px;color:var(--slate);padding:12px 0;font-style:italic;';
    empty.textContent = 'No one-time tasks yet.';
    listOnetime.appendChild(empty);
  } else {
    onetimeHabits.forEach(h => renderManageRow(h, listOnetime));
  }

  // Sync settings toggles
  document.getElementById('toggle-theme').checked = notifSettings.theme === 'dark';
  document.getElementById('toggle-haptics').checked = notifSettings.hapticsEnabled !== false;
}

function applyTheme() {
  const isDark = notifSettings.theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  
  // Update status bar color if possible (mobile)
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', isDark ? '#121212' : '#F9F8F6');

  try {
    StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
  } catch(e) {}
}

async function deleteHabit(id, name) {
  const confirmed = await showConfirm(
    'Remove Habit',
    `Remove "${name}" from all habits?`,
    'Remove',
    true
  );
  if (!confirmed) return;

  // Store for undo
  const deletedHabit = habits.find(h => h.id === id);
  const deletedLogs = {};
  Object.keys(logs).forEach(k => {
    if (logs[k] && logs[k][id]) deletedLogs[k] = true;
  });
  const deletedJournal = habitJournal[id] ? { ...habitJournal[id] } : null;

  // Perform delete
  habits = habits.filter(h => h.id !== id);
  Object.keys(logs).forEach(k => { if (logs[k]) delete logs[k][id]; });
  // Intentionally leaving habitJournal[id] so notes are preserved in the archive

  save();
  renderHabits();
  renderProfile();

  // Show undo toast (5 second window)
  showUndoToast(`"${name}" removed.`, () => {
    habits.push(deletedHabit);
    Object.keys(deletedLogs).forEach(k => {
      if (!logs[k]) logs[k] = {};
      logs[k][id] = true;
    });
    if (deletedJournal) habitJournal[id] = deletedJournal;
    save();
    renderHabits();
    renderProfile();
    showToast(`"${name}" restored.`);
  });
}

async function confirmClear() {
  const confirmed = await showConfirm(
    'Clear All Data',
    'This will permanently remove all habits, logs, and journal entries. This cannot be undone.',
    'Clear Everything',
    true
  );
  if (!confirmed) return;

  habits = []; logs = {}; journal = {}; habitJournal = {};
  save();
  renderHabits();
  renderProfile();
  renderJournal();
  showToast('All data cleared.');
}

// ─── Navigation (with transitions) ───────────
function switchScreen(name, linkEl) {
  if (currentScreen === name && !activeHabitId) return;

  currentScreen = name;
  activeHabitId = null;

  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.classList.remove('screen-entering');
  });

  const target = document.getElementById(`screen-${name}`);
  target.classList.add('active');
  // Force reflow then animate entry
  void target.offsetWidth;
  target.classList.add('screen-entering');

  // Update nav state
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
    n.setAttribute('aria-selected', 'false');
  });
  if (linkEl) {
    linkEl.classList.add('active');
    linkEl.setAttribute('aria-selected', 'true');
  }

  // FAB only on today screen
  document.getElementById('fab-add').style.display = name === 'today' ? '' : 'none';

  // Restore bottom nav
  document.getElementById('bottom-nav').classList.remove('nav-hidden');

  // Refresh screen content (deferred to ensure smooth CSS transition)
  setTimeout(() => {
    if (name === 'journal') renderJournal();
    if (name === 'profile') renderProfile();
  }, 30);
}

// ─── Habit Detail Screen ──────────────────────
function openHabitDetail(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;

  activeHabitId = habitId;

  // Screen transition
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.classList.remove('screen-entering');
  });
  const target = document.getElementById('screen-habit-detail');
  target.classList.add('active');
  void target.offsetWidth;
  target.classList.add('screen-entering');

  // Hide FAB and bottom nav
  document.getElementById('fab-add').style.display = 'none';
  document.getElementById('bottom-nav').classList.add('nav-hidden');

  // Deactivate nav items
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
    n.setAttribute('aria-selected', 'false');
  });

  // Populate detail screen
  document.getElementById('detail-habit-name').textContent = habit.name;
  document.getElementById('detail-icon').textContent = habit.icon;

  // Streaks
  const { current, best } = calcHabitStreaks(habitId);
  document.getElementById('detail-streak-current').textContent =
    current === 1 ? '1 day' : `${current} days`;
  document.getElementById('detail-streak-best').textContent =
    best === 1 ? '1 day' : `${best} days`;

  // Today's journal entries for this habit
  document.getElementById('detail-journal-textarea').value = '';
  document.getElementById('detail-journal-textarea').placeholder = 'Add a new note for today...';

  // Past entries
  renderHabitEntries(habitId);

  // Scroll to top
  target.scrollTop = 0;
  window.scrollTo(0, 0);
}

function closeHabitDetail() {
  activeHabitId = null;

  // Transition back to today
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.classList.remove('screen-entering');
  });
  const target = document.getElementById('screen-today');
  target.classList.add('active');
  void target.offsetWidth;
  target.classList.add('screen-entering');

  // Restore FAB and bottom nav
  document.getElementById('fab-add').style.display = '';
  document.getElementById('bottom-nav').classList.remove('nav-hidden');

  // Restore nav highlight
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
    n.setAttribute('aria-selected', 'false');
  });
  document.getElementById('nav-today').classList.add('active');
  document.getElementById('nav-today').setAttribute('aria-selected', 'true');

  renderHabits();
}

function renderHabitEntries(habitId) {
  const container = document.getElementById('detail-entries');
  container.innerHTML = '';

  const entriesObj = habitJournal[habitId] || {};
  const sortedDates = Object.keys(entriesObj)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 10);

  if (sortedDates.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'detail-no-entries';
    msg.textContent = 'No past entries yet.';
    container.appendChild(msg);
    return;
  }

  sortedDates.forEach((key) => {
    const d = parseDate(key);
    const dayEntries = entriesObj[key] || [];

    const card = document.createElement('div');
    card.className = 'journal-entry-card';
    card.style.padding = '0';
    card.style.marginBottom = '20px';

    const dateHeader = document.createElement('div');
    dateHeader.className = 'journal-entry-date';
    dateHeader.style.cssText = 'padding: 12px 16px 4px; color: var(--slate); font-size: 11px; opacity: 0.7;';
    dateHeader.textContent = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }).toUpperCase();
    card.appendChild(dateHeader);

    const sortedDayItems = [...dayEntries]
      .map((item, originalIndex) => ({ ...item, originalIndex }))
      .filter(i => i.text && i.text.trim())
      .sort((a, b) => b.ts - a.ts);

    sortedDayItems.forEach((item, idx) => {
      const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
      const isLast = idx === sortedDayItems.length - 1;

      const block = document.createElement('div');
      block.className = 'journal-entry-block';
      block.setAttribute('role', 'button');
      block.setAttribute('tabindex', '0');
      block.style.padding = '12px 16px';
      if (!isLast) block.style.borderBottom = '1px solid rgba(0,0,0,0.05)';

      block.innerHTML = `
        <div style="font-size: 10px; font-weight: 700; color: var(--sage); margin-bottom: 4px;">${timeStr}</div>
        <div class="journal-entry-body">${escapeHtml(item.text)}</div>
      `;

      block.addEventListener('click', () => {
        openHistoryModal(key, item.text, habitId, item.originalIndex);
      });

      block.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); block.click(); }
      });

      card.appendChild(block);
    });

    container.appendChild(card);
  });
}

function saveHabitJournalEntry() {
  if (!activeHabitId) return;
  const text = document.getElementById('detail-journal-textarea').value.trim();
  if (!text) {
    showToast('Write something first.');
    return;
  }
  const key = todayKey();
  if (!habitJournal[activeHabitId]) habitJournal[activeHabitId] = {};
  if (!Array.isArray(habitJournal[activeHabitId][key])) habitJournal[activeHabitId][key] = [];
  
  habitJournal[activeHabitId][key].push({ text, ts: Date.now() });
  save();
  renderHabitEntries(activeHabitId);
  document.getElementById('detail-journal-textarea').value = '';
  showToast('Entry added.');
}

// ─── Streak Calculations ───────────────────────
function calcHabitStreaks(habitId) {
  // Current streak: consecutive days ending today
  let current = 0;
  const habit = habits.find(h => h.id === habitId);
  const d = new Date();
  while (true) {
    const k = dateKey(d);
    const scheduled = habit ? shouldShowHabit(habit, k) : true;
    if (!scheduled) {
      // Skip unscheduled days — don't break streak
      d.setDate(d.getDate() - 1);
      if (d < new Date(Date.now() - 365 * 86400000)) break;
      continue;
    }
    if (logs[k] && logs[k][habitId]) {
      current++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }

  // Best streak: scan all log dates
  const allDates = Object.keys(logs)
    .filter(k => logs[k] && logs[k][habitId])
    .sort();

  let best = 0;
  let run  = 0;
  let prev = null;

  allDates.forEach(key => {
    if (!prev) {
      run = 1;
    } else {
      const prevD = parseDate(prev);
      const curD  = parseDate(key);
      const diff  = (curD - prevD) / 86400000;
      run = diff === 1 ? run + 1 : 1;
    }
    if (run > best) best = run;
    prev = key;
  });

  return { current, best: Math.max(best, current) };
}

// ─── Custom Confirm Dialog ────────────────────
function showConfirm(title, message, confirmText, destructive) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;

    const btn = document.getElementById('confirm-action');
    btn.textContent = confirmText || 'Confirm';
    btn.className = 'btn-confirm-action' + (destructive ? ' destructive' : '');
    btn.onclick = () => { resolve(true); closeConfirmSilent(); };

    document.getElementById('confirm-overlay').classList.remove('hidden');
    trapFocus(document.getElementById('confirm-dialog'));
    setTimeout(() => btn.focus(), 100);
  });
}

function closeConfirm() {
  if (confirmResolve) {
    confirmResolve(false);
    confirmResolve = null;
  }
  closeConfirmSilent();
}

function closeConfirmSilent() {
  confirmResolve = null;
  document.getElementById('confirm-overlay').classList.add('hidden');
  releaseFocus(document.getElementById('confirm-dialog'));
}

// ─── Toast (with undo support) ────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  clearTimeout(undoTimer);
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

function showUndoToast(msg, undoCallback) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  clearTimeout(undoTimer);

  toast.innerHTML = '';

  const span = document.createElement('span');
  span.textContent = msg;
  toast.appendChild(span);

  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => {
    clearTimeout(undoTimer);
    toast.classList.add('hidden');
    undoCallback();
  });
  toast.appendChild(btn);

  toast.classList.remove('hidden');
  undoTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
}

// ─── Scroll Header Shadow ─────────────────────
function setupScrollHeader() {
  const header = document.getElementById('main-header');
  if (header) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 10) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }
    }, { passive: true });
  }

  // Also handle habit detail screen scroll
  const detailScreen = document.getElementById('screen-habit-detail');
  const detailHeader = document.querySelector('.detail-header-actions');
  if (detailScreen && detailHeader) {
    detailScreen.addEventListener('scroll', () => {
      if (detailScreen.scrollTop > 10) {
        detailHeader.classList.add('scrolled');
      } else {
        detailHeader.classList.remove('scrolled');
      }
    }, { passive: true });
  }
}

// ─── Focus Trapping (modals) ──────────────────
function trapFocus(element) {
  const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  element._trapHandler = (e) => {
    if (e.key !== 'Tab') return;
    const focusableEls = element.querySelectorAll(sel);
    if (focusableEls.length === 0) return;

    const first = focusableEls[0];
    const last  = focusableEls[focusableEls.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  element.addEventListener('keydown', element._trapHandler);
}

function releaseFocus(element) {
  if (element._trapHandler) {
    element.removeEventListener('keydown', element._trapHandler);
    delete element._trapHandler;
  }
}

// \u2500\u2500\u2500 Notifications \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderNotifications() {
  const masterToggle = document.getElementById('notif-master-toggle');
  if (!masterToggle) return;
  masterToggle.checked = notifSettings.enabled;
  const body = document.getElementById('notif-body');
  body.classList.toggle('notif-disabled', !notifSettings.enabled);

  // Default times
  document.getElementById('default-time-morning').value   = notifSettings.defaultTimes.morning;
  document.getElementById('default-time-afternoon').value = notifSettings.defaultTimes.afternoon;
  document.getElementById('default-time-evening').value   = notifSettings.defaultTimes.evening;

  // Habit-level list
  const list = document.getElementById('notif-habit-list');
  list.innerHTML = '';
  habits.forEach(habit => {
    const config = notifSettings.habitReminders[habit.id] || { enabled: false, time: '08:00' };
    const li = document.createElement('li');
    li.className = 'notif-habit-row';
    li.dataset.id = habit.id;
    li.innerHTML = `
      <span class="material-symbols-outlined notif-habit-icon">${escapeHtml(habit.icon)}</span>
      <span class="notif-habit-name">${escapeHtml(habit.name)}</span>
      <input type="time" class="notif-time-input notif-habit-time" value="${config.time}"
        style="display:${config.enabled ? 'block' : 'none'};"
        aria-label="Reminder time for ${escapeHtml(habit.name)}" />
      <label class="toggle-switch toggle-sm" aria-label="Reminder for ${escapeHtml(habit.name)}">
        <input type="checkbox" class="notif-habit-toggle" ${config.enabled ? 'checked' : ''} />
        <span class="toggle-track"><span class="toggle-thumb"></span></span>
      </label>
    `;
    list.appendChild(li);
  });
  if (habits.length === 0) {
    list.innerHTML = '<li style="padding:12px 0;color:var(--slate);font-size:14px;opacity:0.6;">No habits yet.</li>';
  }

  // Smart
  document.getElementById('notif-smart-toggle').checked = notifSettings.smart.enabled;
  document.getElementById('smart-times-panel').classList.toggle('hidden', !notifSettings.smart.enabled);
  document.getElementById('smart-time-1').value = notifSettings.smart.times[0] || '18:00';
  document.getElementById('smart-time-2').value = notifSettings.smart.times[1] || '21:00';

  // Streak
  document.getElementById('notif-streak-toggle').checked = notifSettings.streak.enabled;
  document.getElementById('streak-time-panel').classList.toggle('hidden', !notifSettings.streak.enabled);
  document.getElementById('streak-time').value = notifSettings.streak.time;

  // Snooze
  document.getElementById('notif-snooze-toggle').checked = notifSettings.snooze.enabled;
  document.getElementById('snooze-panel').classList.toggle('hidden', !notifSettings.snooze.enabled);
  document.querySelectorAll('.snooze-chip input[type="checkbox"]').forEach(cb => {
    cb.checked = notifSettings.snooze.options.includes(parseInt(cb.value, 10));
  });
}

function bindNotifUI() {
  if (!document.getElementById('notif-master-toggle')) return;

  // Master toggle — request permission first when enabling
  document.getElementById('notif-master-toggle').addEventListener('change', async (e) => {
    notifSettings.enabled = e.target.checked;
    document.getElementById('notif-body').classList.toggle('notif-disabled', !notifSettings.enabled);
    saveNotif();
    await scheduleNotifications();   // cancel-all or full reschedule
  });

  // Default times
  ['morning', 'afternoon', 'evening'].forEach(period => {
    document.getElementById(`default-time-${period}`).addEventListener('change', async (e) => {
      notifSettings.defaultTimes[period] = e.target.value;
      saveNotif();
      await scheduleNotifications();
    });
  });

  // Habit rows (delegated)
  document.getElementById('notif-habit-list').addEventListener('change', async (e) => {
    const row = e.target.closest('.notif-habit-row');
    if (!row) return;
    const id = row.dataset.id;
    if (!notifSettings.habitReminders[id]) notifSettings.habitReminders[id] = { enabled: false, time: '08:00' };
    if (e.target.classList.contains('notif-habit-toggle')) {
      notifSettings.habitReminders[id].enabled = e.target.checked;
      row.querySelector('.notif-habit-time').style.display = e.target.checked ? 'block' : 'none';
    }
    if (e.target.classList.contains('notif-habit-time')) {
      notifSettings.habitReminders[id].time = e.target.value;
    }
    saveNotif();
    await scheduleNotifications();
  });

  // Smart
  document.getElementById('notif-smart-toggle').addEventListener('change', async (e) => {
    notifSettings.smart.enabled = e.target.checked;
    document.getElementById('smart-times-panel').classList.toggle('hidden', !e.target.checked);
    saveNotif();
    await scheduleNotifications();
  });
  document.getElementById('smart-time-1').addEventListener('change', async (e) => { notifSettings.smart.times[0] = e.target.value; saveNotif(); await scheduleNotifications(); });
  document.getElementById('smart-time-2').addEventListener('change', async (e) => { notifSettings.smart.times[1] = e.target.value; saveNotif(); await scheduleNotifications(); });

  // Streak
  document.getElementById('notif-streak-toggle').addEventListener('change', async (e) => {
    notifSettings.streak.enabled = e.target.checked;
    document.getElementById('streak-time-panel').classList.toggle('hidden', !e.target.checked);
    saveNotif();
    await scheduleNotifications();
  });
  document.getElementById('streak-time').addEventListener('change', async (e) => { notifSettings.streak.time = e.target.value; saveNotif(); await scheduleNotifications(); });

  // Snooze (UI only — local-notifications doesn't support native snooze, but we store the preference)
  document.getElementById('notif-snooze-toggle').addEventListener('change', (e) => {
    notifSettings.snooze.enabled = e.target.checked;
    document.getElementById('snooze-panel').classList.toggle('hidden', !e.target.checked);
    saveNotif();
  });
  document.querySelectorAll('.snooze-chip input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      notifSettings.snooze.options = Array.from(
        document.querySelectorAll('.snooze-chip input[type="checkbox"]:checked')
      ).map(c => parseInt(c.value, 10));
      saveNotif();
    });
  });
}

// ─── Notification Engine ───────────────────────────────────────────────────────

/** Register the Android notification channel (required on Android 8+). */
async function setupNotifChannel() {
  try {
    await LocalNotifications.createChannel({
      id: 'telos_reminders',
      name: 'Habit Reminders',
      description: 'Reminders for your daily habits and streaks',
      importance: 4,        // HIGH
      visibility: 1,        // PUBLIC
      sound: 'default',
      vibration: true,
      lights: true,
      lightColor: '#A8C5B5',
    });
  } catch (e) { /* not running on native platform */ }
}

/** Ask the OS for notification permission. Returns true if granted. */
async function requestNotifPermission() {
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === 'granted') return true;
    const result = await LocalNotifications.requestPermissions();
    return result.display === 'granted';
  } catch (e) {
    console.warn('[Telos] Notifications not supported on this platform:', e);
    return false;
  }
}

/** Cancel every pending notification we previously scheduled. */
async function cancelAllNotifications() {
  try {
    const { notifications } = await LocalNotifications.getPending();
    if (notifications.length > 0) {
      await LocalNotifications.cancel({ notifications });
    }
  } catch (e) { /* not on native */ }
}

/**
 * Main scheduling entry point.
 * Always cancels all pending notifications first, then rebuilds from current
 * notifSettings. Call this whenever any notification preference changes.
 */
async function scheduleNotifications() {
  // Always start clean
  await cancelAllNotifications();

  if (!notifSettings.enabled) return; // Nothing to do

  // Ensure we have OS permission
  const granted = await requestNotifPermission();
  if (!granted) {
    showToast('⚠ Notification permission denied.');
    notifSettings.enabled = false;
    const masterToggle = document.getElementById('notif-master-toggle');
    if (masterToggle) masterToggle.checked = false;
    const body = document.getElementById('notif-body');
    if (body) body.classList.add('notif-disabled');
    saveNotif();
    return;
  }

  const toSchedule = [];
  const now = new Date();

  // Build a Date object for "daysFromNow days from today at timeStr (HH:MM)"
  function dateAtTime(daysFromNow, timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(now);
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(h, m, 0, 0);
    return d;
  }

  // ── 1. Per-habit reminders (next 7 days) ─────────────────────────────────
  // FIX: Master toggle alone now schedules ALL habits at defaultTimes.morning.
  // The per-habit toggle only sets a CUSTOM override time for that specific habit.
  // This makes the master toggle immediately useful without per-habit config.
  habits.forEach((habit, hIdx) => {
    const cfg = notifSettings.habitReminders[habit.id];
    // Use custom per-habit time if configured; otherwise fall back to default morning.
    const timeStr = (cfg && cfg.enabled && cfg.time)
      ? cfg.time
      : notifSettings.defaultTimes.morning;

    for (let day = 0; day <= 6; day++) {
      const fireDate = dateAtTime(day, timeStr);
      if (fireDate <= now) continue; // skip times already passed today

      // Respect the habit's own schedule (daily/weekdays/weekends/custom/one-time)
      const checkDate = new Date(now);
      checkDate.setDate(checkDate.getDate() + day);
      const checkKey = dateKey(checkDate);
      if (!shouldShowHabit(habit, checkKey)) continue;

      const notifId = 1000 + hIdx * 7 + day; // unique per habit × day slot
      toSchedule.push({
        id: notifId,
        title: `⏰ ${habit.name}`,
        body: habit.desc ? habit.desc : "Don't forget your intention today.",
        // FIX: exact:true — forces Android to fire at precise time instead of
        // batching via Doze. allowWhileIdle ensures delivery with screen off.
        schedule: { at: fireDate, allowWhileIdle: true, exact: true },
        // FIX: removed smallIcon:'ic_stat_icon_config_sample' — that drawable
        // doesn't exist in this app and caused Android to silently drop the notif.
        channelId: 'telos_reminders',
        extra: { habitId: habit.id },
      });
    }
  });

  // ── 2. Smart check-in notifications (next 7 days) ────────────────────────
  if (notifSettings.smart.enabled) {
    notifSettings.smart.times.forEach((timeStr, ti) => {
      for (let day = 0; day <= 6; day++) {
        const fireDate = dateAtTime(day, timeStr);
        if (fireDate <= now) continue;

        const notifId = 2000 + ti * 7 + day;
        toSchedule.push({
          id: notifId,
          title: '🌙 Telos Check-in',
          body: 'How are your intentions going today?',
          schedule: { at: fireDate, allowWhileIdle: true, exact: true },
          channelId: 'telos_reminders',
        });
      }
    });
  }

  // ── 3. Streak protection reminder (next 7 days) ──────────────────────────
  if (notifSettings.streak.enabled) {
    const timeStr = notifSettings.streak.time || '20:00';
    for (let day = 0; day <= 6; day++) {
      const fireDate = dateAtTime(day, timeStr);
      if (fireDate <= now) continue;

      const notifId = 3000 + day;
      toSchedule.push({
        id: notifId,
        title: '🔥 Protect Your Streak!',
        body: "You still have habits to complete today. Keep your streak alive!",
        schedule: { at: fireDate, allowWhileIdle: true, exact: true },
        channelId: 'telos_reminders',
      });
    }
  }

  // Schedule everything in a single batch call
  if (toSchedule.length === 0) {
    console.log('[Telos] No future times to schedule (all may have already passed today).');
    return;
  }

  try {
    await LocalNotifications.schedule({ notifications: toSchedule });
    console.log(`[Telos] ✅ Scheduled ${toSchedule.length} notification(s).`);
    showToast(`✓ ${toSchedule.length} reminder${toSchedule.length > 1 ? 's' : ''} set.`);
  } catch (e) {
    console.error('[Telos] ❌ Notification scheduling failed:', e);
    showToast('⚠ Could not schedule notifications.');
  }
}

/** Listen for notification taps and navigate to the right screen. */
function bindNotifTapHandler() {
  try {
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const extra = action.notification.extra;
      if (extra && extra.habitId) {
        // Tapped a per-habit reminder — open the habit detail
        switchScreen('today', document.querySelector('[data-screen="today"]'));
        setTimeout(() => {
          const habit = habits.find(h => h.id === extra.habitId);
          if (habit) openHabitDetail(habit.id);
        }, 200);
      } else {
        // Tapped a smart or streak reminder — open Today screen
        switchScreen('today', document.querySelector('[data-screen="today"]'));
      }
    });
  } catch (e) { /* not on native */ }
}


// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function todayKey() {
  return dateKey(new Date());
}

function dateKey(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Journal Archive Modal ────────────────────
let archiveSearch = '';
let archiveTab = 'general';

function openJournalArchive() {
  document.getElementById('journal-archive-modal-overlay').classList.remove('hidden');
  document.getElementById('archive-search-input').value = archiveSearch;
  trapFocus(document.getElementById('journal-archive-modal'));
  renderJournalArchive();
}

function closeJournalArchive() {
  document.getElementById('journal-archive-modal-overlay').classList.add('hidden');
  releaseFocus(document.getElementById('journal-archive-modal'));
}

document.getElementById('journal-archive-close-btn').addEventListener('click', closeJournalArchive);

document.getElementById('archive-search-input').addEventListener('input', (e) => {
  archiveSearch = e.target.value.toLowerCase();
  renderJournalArchive();
});

document.querySelectorAll('.archive-tab').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const tab = e.target.closest('.archive-tab');
    if (!tab) return;
    archiveTab = tab.dataset.tab;
    document.querySelectorAll('.archive-tab').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    renderJournalArchive();
  });
});

function renderJournalArchive() {
  const feed = document.getElementById('journal-archive-feed');
  feed.innerHTML = '';

  let allEntries = [];

  if (archiveTab === 'general') {
    Object.keys(journal).forEach(dk => {
      const items = journal[dk];
      if (Array.isArray(items)) {
        items.forEach((item, index) => {
          if (item.text && item.text.trim()) {
            allEntries.push({ dateKey: dk, type: 'general', text: item.text, ts: item.ts, originalIndex: index });
          }
        });
      }
    });
  } else if (archiveTab === 'habits') {
    Object.keys(habitJournal).forEach(habitId => {
      const habitObj = habits.find(h => h.id === habitId);
      const habitName = habitObj ? habitObj.name : 'Deleted Habit';
      const habitIcon = habitObj ? habitObj.icon : '📝';

      const datesObj = habitJournal[habitId];
      Object.keys(datesObj).forEach(dk => {
        const items = datesObj[dk];
        if (Array.isArray(items)) {
          items.forEach((item, index) => {
            if (item.text && item.text.trim()) {
              allEntries.push({ dateKey: dk, type: 'habit', habitId, habitName, habitIcon, text: item.text, ts: item.ts, originalIndex: index });
            }
          });
        }
      });
    });
  }

  if (archiveSearch) {
    allEntries = allEntries.filter(e => e.text.toLowerCase().includes(archiveSearch));
  }

  if (allEntries.length === 0) {
    feed.innerHTML = `<p class="archive-no-results">No entries found.</p>`;
    return;
  }

  allEntries.sort((a, b) => {
    const tsDiff = (b.ts || 0) - (a.ts || 0);
    if (tsDiff !== 0) return tsDiff;
    return b.dateKey.localeCompare(a.dateKey);
  });

  const grouped = {};
  allEntries.forEach(entry => {
    const d = parseDate(entry.dateKey);
    const monthYear = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (!grouped[monthYear]) grouped[monthYear] = [];
    grouped[monthYear].push(entry);
  });

  Object.keys(grouped).forEach(monthYear => {
    const header = document.createElement('h3');
    header.className = 'archive-month-header';
    header.textContent = monthYear;
    feed.appendChild(header);

    const monthEntries = grouped[monthYear];
    const dailyGrouped = {};
    monthEntries.forEach(entry => {
      if (!dailyGrouped[entry.dateKey]) dailyGrouped[entry.dateKey] = [];
      dailyGrouped[entry.dateKey].push(entry);
    });

    const sortedDays = Object.keys(dailyGrouped).sort((a, b) => b.localeCompare(a));

    sortedDays.forEach(dateKey => {
      const d = parseDate(dateKey);
      const card = document.createElement('div');
      card.className = 'journal-entry-card';
      card.style.padding = '0';
      card.style.marginBottom = '16px';
      card.style.cursor = 'default';

      const dateHeader = document.createElement('div');
      dateHeader.className = 'journal-entry-date';
      dateHeader.style.cssText = 'padding: 12px 16px 4px; color: var(--slate); font-size: 11px; opacity: 0.7;';
      dateHeader.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
      card.appendChild(dateHeader);

      const items = dailyGrouped[dateKey];
      items.forEach((item, idx) => {
        const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
        const isLast = idx === items.length - 1;

        const block = document.createElement('div');
        block.className = 'journal-entry-block';
        block.setAttribute('role', 'button');
        block.setAttribute('tabindex', '0');
        block.style.padding = '12px 16px';
        if (!isLast) block.style.borderBottom = '1px solid rgba(0,0,0,0.05)';

        let headerMeta = '';
        if (item.type === 'habit') {
          headerMeta = `
            <div style="font-size: 12px; font-weight: 600; color: var(--charcoal); margin-bottom: 2px;">
              <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; margin-right:4px;">${item.habitIcon}</span><span style="vertical-align:middle;">${escapeHtml(item.habitName)}</span>
            </div>
          `;
        }

        block.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
            <span style="font-size: 11px; font-weight: 700; color: var(--sage); text-transform:uppercase;">${timeStr}</span>
          </div>
          ${headerMeta}
          <div class="journal-entry-body">${escapeHtml(item.text)}</div>
        `;

        let archPressTimer;
        let archLongPressTriggered = false;

        const startArchPress = () => {
          archLongPressTriggered = false;
          archPressTimer = setTimeout(() => {
            archLongPressTriggered = true;
            if (notifSettings.hapticsEnabled) {
              try { Haptics.impact({ style: ImpactStyle.Heavy }); } catch(err) {}
            }
            deleteJournalEntry(dateKey, item.originalIndex, item.type, item.habitId);
          }, 600);
        };

        const cancelArchPress = () => {
          clearTimeout(archPressTimer);
        };

        block.addEventListener('mousedown', startArchPress);
        block.addEventListener('touchstart', startArchPress, { passive: true });
        block.addEventListener('mouseup', cancelArchPress);
        block.addEventListener('mouseleave', cancelArchPress);
        block.addEventListener('touchend', cancelArchPress);
        block.addEventListener('touchmove', cancelArchPress, { passive: true });

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          if (archLongPressTriggered) return;
          const pKey = item.type === 'habit' ? item.habitId : null;
          openHistoryModal(dateKey, item.text, pKey, item.originalIndex);
        });

        block.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); block.click(); }
        });

        card.appendChild(block);
      });

      feed.appendChild(card);
    });
  });
}
// ─── Tutorial Logic ──────────────────────────────────────────────────────────
let tutorialCurrentStep = 0;
const tutorialSteps = [
  {
    target: '#fab-add',
    text: "Forge your path.\nTap the + to set your first intention.",
    type: 'circle',
    padding: 12
  },
  {
    target: '.habit-card',
    text: "A single tap to claim victory.\nA long press to let an intention go.",
    type: 'rect',
    padding: 12
  },
  {
    target: '[data-screen="journal"]',
    text: "Your quiet sanctuary.\nReflect on your days here.",
    type: 'circle',
    padding: 10
  },
  {
    target: '[data-screen="profile"]',
    text: "Witness your growth.\nTrack your consistency and whisper your own alarms.",
    type: 'circle',
    padding: 10
  }
];

function runTutorial() {
  if (localStorage.getItem('telos_tutorial')) return;
  
  const overlay = document.getElementById('tutorial-overlay');
  if (!overlay) return;
  
  overlay.classList.remove('hidden');
  tutorialCurrentStep = 0;
  showTutorialStep();
  
  overlay.onclick = (e) => {
    e.stopPropagation();
    tutorialCurrentStep++;
    if (tutorialCurrentStep < tutorialSteps.length) {
      showTutorialStep();
    } else {
      finishTutorial();
    }
  };
}

function showTutorialStep() {
  const step = tutorialSteps[tutorialCurrentStep];
  const targetEl = document.querySelector(step.target);
  const spotlight = document.getElementById('tutorial-spotlight');
  const textEl = document.getElementById('tutorial-text');
  const overlay = document.getElementById('tutorial-overlay');
  
  if (!targetEl || targetEl.offsetParent === null) {
    // skip if element is hidden or not in DOM
    tutorialCurrentStep++;
    if (tutorialCurrentStep < tutorialSteps.length) showTutorialStep();
    else finishTutorial();
    return;
  }
  
  const rect = targetEl.getBoundingClientRect();
  const pad = step.padding || 10;
  
  // Update spotlight position and size
  spotlight.style.width = `${rect.width + pad * 2}px`;
  spotlight.style.height = `${rect.height + pad * 2}px`;
  spotlight.style.left = `${rect.left - pad}px`;
  spotlight.style.top = `${rect.top - pad}px`;
  spotlight.style.borderRadius = step.type === 'circle' ? '50%' : '16px';
  
  // Transition text
  textEl.classList.remove('active');
  
  setTimeout(() => {
    textEl.innerText = step.text;
    textEl.classList.add('active');
    
    // Position text container relative to spotlight
    const textContainer = document.getElementById('tutorial-text-container');
    const screenHeight = window.innerHeight;
    const midPoint = rect.top + rect.height / 2;
    
    if (midPoint < screenHeight / 2) {
      // Spotlight is in top half, show text below it
      textContainer.style.top = `${rect.bottom + 60}px`;
      textContainer.style.bottom = 'auto';
    } else {
      // Spotlight is in bottom half, show text above it
      textContainer.style.top = 'auto';
      textContainer.style.bottom = `${screenHeight - rect.top + 60}px`;
    }
  }, 400);
}

function finishTutorial() {
  const overlay = document.getElementById('tutorial-overlay');
  if (!overlay) return;
  
  overlay.style.opacity = '0';
  setTimeout(() => {
    overlay.classList.add('hidden');
    localStorage.setItem('telos_tutorial', 'true');
    
    // Request notifications ONLY AFTER tutorial ends
    if (!localStorage.getItem('telos_notif_prompted')) {
      localStorage.setItem('telos_notif_prompted', 'true');
      setTimeout(async () => {
        try {
          const granted = await requestNotifPermission();
          if (granted) {
            notifSettings.enabled = true;
            try { localStorage.setItem('telos_notif', JSON.stringify(notifSettings)); } catch(e) {}
            renderNotifications();
            scheduleNotifications().catch(() => {});
          }
        } catch(e) {}
      }, 1000);
    }
  }, 800);
}

