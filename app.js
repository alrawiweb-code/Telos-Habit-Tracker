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

// Firebase & Cloud Sync
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { auth, db, signInWithCredential, GoogleAuthProvider } from './firebaseConfig.js';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { PageFlip } from 'page-flip';
import { THEMES, applyTheme as applyThemeEngine, migrateLegacyTheme, getThemesByCategory, createThemeCard } from './theme-engine.js';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';

/**
 * Global helper for Capacitor Haptics
 * @param {string} style - 'Heavy' | 'Medium' | 'Light'
 */
window.triggerHaptic = function(style = 'Light') {
  if (window.Capacitor && window.Capacitor.Plugins.Haptics) {
    window.Capacitor.Plugins.Haptics.impact({ 
      style: style.charAt(0).toUpperCase() + style.slice(1) 
    }).catch(()=>{});
  }
};

import { BOOK_COVERS, DEFAULT_BOOK_ID, createDefaultBook, createBook, migrateJournalToMultiBook, getBookJournal, renderCoverHTML, createBookCard, createCoverOption, countBookEntries } from './journal-manager.js';
import { exportBookToPDF, sharePDF } from './pdf-export.js';
import './monetization-manager.js';


const WidgetPlugin = registerPlugin('WidgetPlugin');

// ─── Constants ────────────────────────────────
const STORAGE_KEY_HABITS         = 'ee_habits_v2';
const STORAGE_KEY_LOGS           = 'ee_logs_v2';
const STORAGE_KEY_JOURNAL        = 'ee_journal_v2';
const STORAGE_KEY_HABIT_JOURNAL  = 'ee_habit_journal_v1';
const STORAGE_KEY_NOTIF          = 'ee_notif_v1';
const STORAGE_KEY_BOOKS          = 'ee_journal_books_v1';
const SYSTEM_INTRO_ENTRY = {
  text: "Welcome to your personal sanctuary. This is a space for your thoughts, reflections, and growth.",
  ts: 1, // Ensure it's the absolute first
  images: ["/9c7abbb33e2e3c415d3ba97fe8ff186b.jpg"],
  audio: { data: "/audio.mp3" },
  isSystem: true
};

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
// ─── Media Services ───────────────────────────
const ImageCompressor = {
  async compress(file, maxWidth = 1200, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          if (width > maxWidth) {
            height = (maxWidth / width) * height;
            width = maxWidth;
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
};

// ─── Microphone Permission Service ────────────
// Handles permission check + request across Web & Android Capacitor WebView.
// States: 'granted' | 'prompt' | 'denied' | 'unavailable'
const MicPermissionService = {
  // Cached state — reset to null when we want a fresh check
  _cachedState: null,

  /**
   * Returns current mic permission state without triggering a OS prompt.
   * Uses Permissions API where available; falls back to 'prompt' (unknown).
   */
  async getState() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return 'unavailable';
    }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const result = await navigator.permissions.query({ name: 'microphone' });
        this._cachedState = result.state; // 'granted' | 'prompt' | 'denied'
        // Live-update our cache if permission changes while app is open
        result.onchange = () => {
          this._cachedState = result.state;
          this._onPermissionChange(result.state);
        };
        return result.state;
      }
    } catch (e) {
      // Permissions API not supported (some Android WebViews) — fall through
      console.warn('Permissions API unavailable, will probe via getUserMedia:', e.message);
    }
    // Return cached state if we have one, otherwise unknown
    return this._cachedState || 'prompt';
  },

  /**
   * Actually requests microphone access by calling getUserMedia.
   * Returns { granted: bool, stream } — caller must stop the stream tracks.
   */
  async request() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._cachedState = 'granted';
      return { granted: true, stream };
    } catch (err) {
      // NotAllowedError → user denied; NotFoundError → no mic hardware
      const denied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      this._cachedState = denied ? 'denied' : 'unavailable';
      console.warn('getUserMedia failed:', err.name, err.message);
      return { granted: false, stream: null, error: err };
    }
  },

  /** Called when the Permissions API fires an onchange event */
  _onPermissionChange(newState) {
    const btns = [
      document.getElementById('journal-mic-btn'),
      document.getElementById('detail-mic-btn')
    ];
    btns.forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('perm-denied', newState === 'denied');
      btn.title = newState === 'denied'
        ? 'Microphone access denied — tap to learn more'
        : 'Record Voice';
    });
  }
};

// ─── Mic Permission Modal ─────────────────────
// Shows a bottom-sheet explaining why mic is needed.
// Resolves true (user wants to try) or false (dismissed).
function showMicPermissionModal({ isDenied = false } = {}) {
  return new Promise(resolve => {
    const overlay  = document.getElementById('mic-permission-overlay');
    const hint     = document.getElementById('mic-perm-denied-hint');
    const allowBtn = document.getElementById('mic-perm-allow');
    const cancelBtn= document.getElementById('mic-perm-cancel');
    const settingsBtn = document.getElementById('mic-perm-settings');
    const body     = document.getElementById('mic-perm-body');
    if (!overlay) { resolve(false); return; }

    // Adapt text + buttons for each state
    if (isDenied) {
      body.textContent = 'Microphone access is currently blocked. Enable it in your device settings to record voice notes.';
      hint.classList.remove('hidden');
      allowBtn.classList.add('hidden');   // Can't prompt again if permanently denied
      settingsBtn.classList.remove('hidden');
    } else {
      body.textContent = 'To record voice notes for your journal, Telos needs access to your microphone. Your recordings are stored only on your device.';
      hint.classList.add('hidden');
      allowBtn.classList.remove('hidden');
      settingsBtn.classList.add('hidden');
    }

    overlay.classList.remove('hidden');
    // Trap focus on the primary button
    setTimeout(() => (isDenied ? cancelBtn : allowBtn).focus(), 80);

    const close = (result) => {
      overlay.classList.add('hidden');
      allowBtn.onclick = null;
      cancelBtn.onclick = null;
      settingsBtn.onclick = null;
      overlay.removeEventListener('click', onBackdrop);
      resolve(result);
    };

    const onBackdrop = (e) => { if (e.target === overlay) close(false); };

    allowBtn.onclick  = () => close(true);
    cancelBtn.onclick = () => close(false);
    settingsBtn.onclick = () => {
      // Deep-link to Android app settings — works in Capacitor WebView.
      // On plain browser this is a no-op but won't throw.
      try {
        window.location.href = 'app-settings:';
      } catch(e) {
        // Fallback for older Android intents
        try { window.open('package:com.alrawi.telos'); } catch(ex) {}
      }
      close(false);
    };
    overlay.addEventListener('click', onBackdrop);
  });
}

// ─── Voice Service ─────────────────────────────
const VoiceService = {
  recognition: null,
  mediaRecorder: null,
  audioChunks: [],
  isRecording: false,

  init() {
    try {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
      }
    } catch (e) {
      console.warn('SpeechRecognition init skipped:', e);
      this.recognition = null;
    }
  },

  start(stream, onResult, onStop) {
    // stream is pre-obtained by handleMicClick after permission was confirmed
    if (this.isRecording) return;
    this.isRecording = true;
    this.audioChunks = [];

    // Speech-to-text — optional, skip if unavailable
    if (this.recognition) {
      try {
        this.recognition.onresult = (event) => {
          let transcript = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            transcript += event.results[i][0].transcript;
          }
          onResult(transcript);
        };
        this.recognition.onerror = (err) => console.warn('Speech Recognition Error:', err);
        this.recognition.start();
      } catch (e) {
        console.warn('Speech recognition start failed:', e);
      }
    }

    try {
      this.mediaRecorder = new MediaRecorder(stream);
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => {
        try {
          const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
          const reader = new FileReader();
          reader.onloadend = () => onStop(reader.result, blob.type);
          reader.onerror = () => { console.error('FileReader error'); onStop(null, null); };
          reader.readAsDataURL(blob);
        } catch (e) {
          console.error('Audio blob processing failed:', e);
          onStop(null, null);
        }
        stream.getTracks().forEach(t => t.stop());
      };
      this.mediaRecorder.onerror = (e) => {
        console.error('MediaRecorder error:', e);
        this.isRecording = false;
        stream.getTracks().forEach(t => t.stop());
      };
      this.mediaRecorder.start();
    } catch (e) {
      console.error('MediaRecorder init failed:', e);
      stream.getTracks().forEach(t => t.stop());
      this.isRecording = false;
      if (this.recognition) try { this.recognition.stop(); } catch(ex) {}
      showToast('⚠ Audio recording failed to start.');
    }
  },

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.recognition) try { this.recognition.stop(); } catch(e) {}
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    } catch (e) {
      console.warn('MediaRecorder stop failed:', e);
    }
  }
};

// ─── Native Dictation Service ────────────────
const DictationService = {
  isListening: false,
  
  async start(prefix) {
    if (this.isListening) {
      this.stop();
      return;
    }

    try {
      // Check plugin availability
      const available = await SpeechRecognition.available();
      if (!available.available) {
        showToast('⚠ Native speech recognition not supported on this device.');
        return;
      }

      // Check / Request Permissions
      let permStatus = await SpeechRecognition.checkPermissions();
      if (permStatus.speechRecognition !== 'granted') {
        permStatus = await SpeechRecognition.requestPermissions();
        if (permStatus.speechRecognition !== 'granted') {
          showToast('⚠ Microphone permission required for voice typing.');
          return;
        }
      }

      this.isListening = true;
      const btn = document.getElementById(`${prefix}-dictate-btn`);
      if (btn) btn.classList.add('pulse'); // Add visual feedback

      // Start listening (pops up native Android overlay)
      const result = await SpeechRecognition.start({
        language: navigator.language || 'en-US',
        maxResults: 1,
        prompt: 'Dictate journal entry...',
        partialResults: false,
        popup: true // Shows the native Google Voice typing dialog
      });

      if (result && result.matches && result.matches.length > 0) {
        this.insertText(prefix, result.matches[0]);
      }
      
      this.stop(prefix);

    } catch (e) {
      console.error('Dictation error:', e);
      this.stop(prefix);
      showToast('⚠ Voice typing failed.');
    }
  },

  stop(prefix) {
    if (!this.isListening) return;
    this.isListening = false;
    try {
      SpeechRecognition.stop();
    } catch (e) {}
    
    // Remove all partialResults listeners
    SpeechRecognition.removeAllListeners();
    
    const btn = document.getElementById(`${prefix}-dictate-btn`);
    if (btn) btn.classList.remove('pulse');
  },

  insertText(prefix, text) {
    if (!text) return;
    const textarea = document.getElementById(`${prefix}-textarea`);
    if (!textarea) return;

    try {
      // Append with a space if there's already text
      const s = textarea.selectionStart;
      const e = textarea.selectionEnd;
      const t = textarea.value;
      const prefixText = (s > 0 && t[s-1] !== ' ' && t[s-1] !== '\n') ? ' ' : '';
      const insertedText = prefixText + text + ' ';
      
      textarea.value = t.slice(0, s) + insertedText + t.slice(e);
      textarea.selectionStart = textarea.selectionEnd = s + insertedText.length;
    } catch(e) {
      console.warn('Dictation insertion failed:', e);
      textarea.value += ' ' + text;
    }
  }
};

// ─── Sketchpad Service ────────────────────────
const SketchpadService = {
  canvas: null,
  ctx: null,
  isDrawing: false,
  lastX: 0,
  lastY: 0,
  currentContext: null,
  strokeColor: '#2a2a2a',
  strokeWidth: 3,
  isEraser: false,
  history: [],
  historyIndex: -1,
  currentBackground: 'blank',

  init() {
    this.canvas = document.getElementById('sketch-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    
    this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
    this.canvas.addEventListener('mousemove', this.draw.bind(this));
    this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
    this.canvas.addEventListener('mouseout', this.stopDrawing.bind(this));

    this.canvas.addEventListener('touchstart', this.startDrawingTouch.bind(this), {passive: false});
    this.canvas.addEventListener('touchmove', this.drawTouch.bind(this), {passive: false});
    this.canvas.addEventListener('touchend', this.stopDrawing.bind(this));
    this.canvas.addEventListener('touchcancel', this.stopDrawing.bind(this));

    document.getElementById('btn-cancel-sketch').addEventListener('click', this.close.bind(this));
    document.getElementById('btn-save-sketch').addEventListener('click', this.save.bind(this));
    document.getElementById('btn-clear-sketch').addEventListener('click', () => {
      this.clearCanvas();
      this.saveState();
    });
    
    document.getElementById('btn-undo-sketch').addEventListener('click', this.undo.bind(this));
    document.getElementById('btn-redo-sketch').addEventListener('click', this.redo.bind(this));

    document.querySelectorAll('.sketch-bg-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.setBackground(e.currentTarget.dataset.bg));
    });
    
    const colorPicker = document.getElementById('sketch-color-picker');
    const colorWrapper = document.getElementById('sketch-color-wrapper');
    if(colorPicker) {
      colorPicker.addEventListener('input', (e) => {
        this.isEraser = false;
        this.strokeColor = e.target.value;
        if(colorWrapper) colorWrapper.style.backgroundColor = e.target.value;
        // Re-activate pen tool
        const penBtn = document.querySelector('.sketch-tool-btn[data-action="pen"]');
        document.querySelectorAll('.sketch-tool-btn').forEach(b => b.classList.remove('active'));
        if(penBtn) penBtn.classList.add('active');
      });
    }

    document.querySelectorAll('.sketch-tool-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.selectTool(e.currentTarget));
    });

    document.querySelectorAll('.sketch-size-btn').forEach(btn => {
      btn.addEventListener('click', (e) => this.selectSize(e.currentTarget));
    });

    document.getElementById('sketch-modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'sketch-modal-overlay') this.close();
    });
  },

  open(prefix) {
    this.currentContext = prefix;
    document.getElementById('sketch-modal-overlay').classList.remove('hidden');
    setTimeout(() => {
      this.resize();
      this.setBackground('blank');
      this.history = [];
      this.historyIndex = -1;
      this.saveState();
      this.updateHistoryButtons();
      // Reset to pen tool
      document.querySelectorAll('.sketch-tool-btn').forEach(b => b.classList.remove('active'));
      const penBtn = document.querySelector('.sketch-tool-btn[data-action="pen"]');
      if (penBtn) penBtn.classList.add('active');
      this.isEraser = false;
    }, 50);
  },

  close() {
    document.getElementById('sketch-modal-overlay').classList.add('hidden');
    this.currentContext = null;
  },

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    // Note: assigning canvas.width/height automatically clears it — no explicit clearCanvas() needed
  },

  getCoordinates(e) {
    const rect = this.canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  },

  startDrawing(e) {
    this.isDrawing = true;
    const { x, y } = this.getCoordinates(e);
    this.lastX = x;
    this.lastY = y;
    this.ctx.beginPath();
    this.ctx.arc(this.lastX, this.lastY, (this.isEraser ? this.strokeWidth * 3 : this.strokeWidth) / 2, 0, Math.PI * 2);
    this.ctx.globalCompositeOperation = this.isEraser ? 'destination-out' : 'source-over';
    this.ctx.fillStyle = this.isEraser ? 'rgba(0,0,0,1)' : this.strokeColor;
    this.ctx.fill();
    this.ctx.globalCompositeOperation = 'source-over'; // reset
  },

  startDrawingTouch(e) {
    if (e.cancelable) e.preventDefault();
    this.startDrawing(e);
  },

  draw(e) {
    if (!this.isDrawing) return;
    const { x, y } = this.getCoordinates(e);
    
    this.ctx.beginPath();
    this.ctx.moveTo(this.lastX, this.lastY);
    this.ctx.lineTo(x, y);
    this.ctx.globalCompositeOperation = this.isEraser ? 'destination-out' : 'source-over';
    this.ctx.strokeStyle = this.isEraser ? 'rgba(0,0,0,1)' : this.strokeColor;
    this.ctx.lineWidth = this.isEraser ? this.strokeWidth * 3 : this.strokeWidth;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.stroke();
    this.ctx.globalCompositeOperation = 'source-over'; // reset

    this.lastX = x;
    this.lastY = y;
  },

  drawTouch(e) {
    if (e.cancelable) e.preventDefault();
    this.draw(e);
  },

  stopDrawing() {
    if (this.isDrawing) {
      this.isDrawing = false;
      this.saveState();
    }
  },

  selectTool(btnElement) {
    if (!btnElement) return;
    document.querySelectorAll('.sketch-tool-btn').forEach(btn => btn.classList.remove('active'));
    btnElement.classList.add('active');

    const action = btnElement.dataset.action;
    this.isEraser = (action === 'eraser');
  },

  selectSize(btnElement) {
    if (!btnElement) return;
    document.querySelectorAll('.sketch-size-btn').forEach(btn => btn.classList.remove('active'));
    btnElement.classList.add('active');
    this.strokeWidth = parseInt(btnElement.dataset.size) || 3;
  },

  clearCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
  },

  setBackground(type) {
    if (!type) return;
    this.currentBackground = type;

    // Update toggle button states
    document.querySelectorAll('.sketch-bg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.bg === type);
    });

    const container = this.canvas.parentElement;
    container.className = 'sketch-canvas-container';
    if (type !== 'blank') {
      container.classList.add(`bg-${type}`);
    }
  },

  toggleBackground() {
    const types = ['blank', 'lined', 'grid'];
    let idx = types.indexOf(this.currentBackground);
    this.setBackground(types[(idx + 1) % types.length]);
  },

  saveState() {
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }
    this.history.push(this.canvas.toDataURL('image/png'));
    this.historyIndex++;
    if (this.history.length > 20) {
      this.history.shift();
      this.historyIndex--;
    }
    this.updateHistoryButtons();
  },

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.restoreState();
    }
  },

  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.restoreState();
    }
  },

  restoreState() {
    const imgData = this.history[this.historyIndex];
    const img = new Image();
    img.onload = () => {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      this.ctx.clearRect(0, 0, rect.width, rect.height);
      this.ctx.drawImage(img, 0, 0, rect.width, rect.height);
      this.updateHistoryButtons();
    };
    img.src = imgData;
  },

  updateHistoryButtons() {
    const undoBtn = document.getElementById('btn-undo-sketch');
    const redoBtn = document.getElementById('btn-redo-sketch');
    if (undoBtn) undoBtn.disabled = this.historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = this.historyIndex >= this.history.length - 1;
  },

  async save() {
    if (!this.currentContext) return;
    
    // Create composite canvas for saving
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    
    // Fill white background
    tempCtx.fillStyle = '#ffffff';
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    
    // Draw background grid/lines if active
    if (this.currentBackground !== 'blank') {
      const dpr = window.devicePixelRatio || 1;
      tempCtx.lineWidth = 1 * dpr;
      tempCtx.strokeStyle = '#e0e0e0';
      tempCtx.beginPath();
      
      if (this.currentBackground === 'lined') {
        const lineSpacing = 30 * dpr;
        for (let y = lineSpacing; y < tempCanvas.height; y += lineSpacing) {
          tempCtx.moveTo(0, y);
          tempCtx.lineTo(tempCanvas.width, y);
        }
      } else if (this.currentBackground === 'grid') {
        const gridSize = 20 * dpr;
        for (let x = gridSize; x < tempCanvas.width; x += gridSize) {
          tempCtx.moveTo(x, 0);
          tempCtx.lineTo(x, tempCanvas.height);
        }
        for (let y = gridSize; y < tempCanvas.height; y += gridSize) {
          tempCtx.moveTo(0, y);
          tempCtx.lineTo(tempCanvas.width, y);
        }
      }
      tempCtx.stroke();
    }
    
    // Draw the actual drawing
    tempCtx.drawImage(this.canvas, 0, 0);
    
    const dataUrl = tempCanvas.toDataURL('image/jpeg', 0.8);
    
    if (currentAttachments[this.currentContext]) {
        currentAttachments[this.currentContext].images.push(dataUrl);
        updateMediaPreview(this.currentContext);
    }

    this.close();
  }
};

// ─── Media Handlers ───────────────────────────
function bindMediaEvents() {
  // Journal Screen
  const journalMicBtn = document.getElementById('journal-mic-btn');
  const journalDictateBtn = document.getElementById('journal-dictate-btn');
  const journalPhotoBtn = document.getElementById('journal-photo-btn');
  const journalPhotoInput = document.getElementById('journal-photo-input');
  const journalSketchBtn = document.getElementById('journal-sketch-btn');

  if (journalMicBtn) journalMicBtn.addEventListener('click', () => handleMicClick('journal'));
  if (journalDictateBtn) journalDictateBtn.addEventListener('click', () => DictationService.start('journal'));
  if (journalPhotoBtn) journalPhotoBtn.addEventListener('click', () => journalPhotoInput.click());
  if (journalPhotoInput) journalPhotoInput.addEventListener('change', (e) => handleFileChange('journal', e.target.files));
  if (journalSketchBtn) journalSketchBtn.addEventListener('click', () => SketchpadService.open('journal'));

  // Habit Detail Screen
  const detailMicBtn = document.getElementById('detail-mic-btn');
  const detailPhotoBtn = document.getElementById('detail-photo-btn');
  const detailPhotoInput = document.getElementById('detail-photo-input');
  const detailSketchBtn = document.getElementById('detail-sketch-btn');

  if (detailMicBtn) detailMicBtn.addEventListener('click', () => handleMicClick('detail'));
  if (detailPhotoBtn) detailPhotoBtn.addEventListener('click', () => detailPhotoInput.click());
  if (detailPhotoInput) detailPhotoInput.addEventListener('change', (e) => handleFileChange('detail', e.target.files));
  if (detailSketchBtn) detailSketchBtn.addEventListener('click', () => SketchpadService.open('detail'));
}

async function handleMicClick(prefix) {
  // ── Stop if already recording ──
  if (VoiceService.isRecording) {
    VoiceService.stop();
    stopRecordingUI(prefix);
    return;
  }

  // ── Check current permission state without prompting ──
  let permState;
  try {
    permState = await MicPermissionService.getState();
  } catch(e) {
    permState = 'prompt'; // Assume unknown → will try getUserMedia
  }

  if (permState === 'unavailable') {
    showToast('⚠ Audio recording is not supported on this device.');
    return;
  }

  if (permState === 'denied') {
    // Already permanently denied — show modal with settings hint
    await showMicPermissionModal({ isDenied: true });
    return;
  }

  // We directly request the mic (triggers OS dialog if state was 'prompt')
  // bypassing the custom explanation modal for a smoother UX.


  // ── Actually request the mic (triggers OS dialog if state was 'prompt') ──
  const { granted, stream } = await MicPermissionService.request();

  if (!granted) {
    // User denied the OS dialog — update button + show modal with settings hint
    MicPermissionService._onPermissionChange('denied');
    await showMicPermissionModal({ isDenied: true });
    return;
  }

  // ── Permission granted — start recording ──
  if (currentAttachments[prefix]) {
    currentAttachments[prefix].audio = null;
  }
  startRecordingUI(prefix);

  try {
    VoiceService.start(
      stream,
      (transcript) => {
        try {
          const ta = document.getElementById(
            prefix === 'journal' ? 'journal-textarea' : 'detail-journal-textarea'
          );
          if (ta && transcript.trim()) {
            const s = ta.selectionStart, e = ta.selectionEnd, t = ta.value;
            ta.value = t.slice(0, s) + transcript + t.slice(e);
            ta.selectionStart = ta.selectionEnd = s + transcript.length;
          }
        } catch(e) { console.warn('Transcript insertion failed:', e); }
      },
      (audioData, type) => {
        try {
          if (audioData && currentAttachments[prefix]) {
            currentAttachments[prefix].audio = { data: audioData, type: type };
            updateMediaPreview(prefix);
          }
        } catch(e) { console.warn('Audio save failed:', e); }
        stopRecordingUI(prefix);
      }
    );
  } catch(e) {
    console.error('Mic handler error:', e);
    VoiceService.isRecording = false;
    stopRecordingUI(prefix);
    showToast('⚠ Recording error. Please try again.');
  }
}

async function handleFileChange(prefix, files) {
  if (!files || files.length === 0) return;
  if (!currentAttachments[prefix]) return;

  for (let file of files) {
    try {
      const compressed = await ImageCompressor.compress(file);
      currentAttachments[prefix].images.push(compressed);
    } catch (err) {
      console.error("Compression failed:", err);
    }
  }
  updateMediaPreview(prefix);
  const input = document.getElementById(`${prefix}-photo-input`);
  if (input) input.value = ''; // Reset for same file re-selection
}

function updateMediaPreview(prefix) {
  const container = document.getElementById(`${prefix}-attachments-preview`);
  if (!container || !currentAttachments[prefix]) return;
  container.innerHTML = '';

  const media = currentAttachments[prefix];
  const hasMedia = media.images.length > 0 || !!media.audio;

  // Show/hide the container
  container.classList.toggle('hidden', !hasMedia);

  // Render Images
  media.images.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    const imgEl = document.createElement('img');
    imgEl.src = img;
    imgEl.alt = 'Attachment';
    imgEl.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;cursor:pointer;';
    imgEl.addEventListener('click', () => expandJournalImage(img));
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1;z-index:2;';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeAttachmentByUI(prefix, idx, 'image');
    });
    item.appendChild(imgEl);
    item.appendChild(removeBtn);
    container.appendChild(item);
  });

  // Render Audio
  if (media.audio) {
    const item = document.createElement('div');
    item.className = 'attachment-item audio';
    item.style.cssText = 'display:flex;align-items:center;justify-content:center;background:var(--greige);';
    item.innerHTML = `<div class="audio-icon" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;"><span class="material-symbols-outlined" style="font-size:28px;color:var(--sage);">mic</span></div>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1;z-index:2;';
    removeBtn.addEventListener('click', () => removeAttachmentByUI(prefix, 0, 'audio'));
    item.appendChild(removeBtn);
    container.appendChild(item);
  }
}

function removeAttachmentByUI(prefix, index, type) {
  if (!currentAttachments[prefix]) return;
  if (type === 'image') {
    currentAttachments[prefix].images.splice(index, 1);
  } else {
    currentAttachments[prefix].audio = null;
  }
  updateMediaPreview(prefix);
}
window.removeAttachmentByUI = removeAttachmentByUI;

function startRecordingUI(prefix) {
  const btn = document.getElementById(`${prefix}-mic-btn`);
  const indicator = document.getElementById(`${prefix}-rec-indicator`);
  const timer = document.getElementById(`${prefix}-rec-timer`);

  if (btn) btn.classList.add('recording');
  if (indicator) indicator.classList.remove('hidden');
  if (timer) {
    timer.classList.remove('hidden');
    timer.textContent = '0:00';
  }

  recordingStartTime = Date.now();
  if (recordingTimerInterval) clearInterval(recordingTimerInterval);
  recordingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    if (timer) timer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

function stopRecordingUI(prefix) {
  const btn = document.getElementById(`${prefix}-mic-btn`);
  const indicator = document.getElementById(`${prefix}-rec-indicator`);
  const timer = document.getElementById(`${prefix}-rec-timer`);

  if (btn) btn.classList.remove('recording');
  if (indicator) indicator.classList.add('hidden');
  if (timer) timer.classList.add('hidden');
  if (recordingTimerInterval) clearInterval(recordingTimerInterval);
}

function resetMediaAttachments(prefix) {
  if (currentAttachments[prefix]) {
    currentAttachments[prefix] = { images: [], audio: null };
  }
  const container = document.getElementById(`${prefix}-attachments-preview`);
  if (container) container.innerHTML = '';
  stopRecordingUI(prefix);
}

// ─── State ────────────────────────────────────
let habits       = [];   // [{ id, name, desc, icon, schedule, createdAt }]
let logs         = {};   // { "YYYY-MM-DD": { habitId: true } }
let journal      = {};   // { "YYYY-MM-DD": [{text, ts, images, audio}] }
let habitJournal = {};   // { habitId: { "YYYY-MM-DD": [{text, ts, images, audio}] } }
let journalPageFlip = null; // StPageFlip instance
let isJournalFlipping = false; // Prevents re-renders during active animations
let pendingJournalRender = false; // Queues a re-render when flip finishes

// Media selection state (split by context)
let currentAttachments = {
  journal: { images: [], audio: null },
  detail: { images: [], audio: null }
};
let recordingStartTime = 0;
let recordingTimerInterval = null;

let notifSettings = {
  morning: { enabled: true, time: '08:00' },
  evening: { enabled: true, time: '20:00' },
  streak: true,
  hapticsEnabled: true,
  theme: 'dark',
  showJournalHint: true,
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
let journalBooks    = [];
let activeBookId    = DEFAULT_BOOK_ID;
let isSecretsUnlocked = false;
let passcodeEntry     = '';
let passcodeMode      = 'verify';  // 'verify' | 'setup' | 'confirm' | 'change_verify'
let passcodeTempCode  = '';        // holds first entry during setup→confirm flow
let stripCenterDate     = todayKey(); 
let modalViewingDate    = new Date();


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
  // ── Stable Viewport Height for Capacitor WebView ──
  // Android WebView has inconsistent 100dvh behavior — URL bar and system
  // nav bar cause recalculations. Set a CSS custom property from JS.
  function setAppHeight() {
    const h = window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
  }
  setAppHeight();
  window.addEventListener('resize', setAppHeight);

  // ── Ad Loading Overlay Listener ──
  let _adLoadingTimeout = null;
  document.addEventListener('showAdLoading', (e) => {
    const overlay = document.getElementById('ad-loading-overlay');
    if (!overlay) return;

    if (e.detail.loading) {
      overlay.classList.remove('hidden');
      // Safety timeout — auto-dismiss after 15s if ad never responds
      clearTimeout(_adLoadingTimeout);
      _adLoadingTimeout = setTimeout(() => {
        overlay.classList.add('hidden');
        console.warn('[AdLoading] Timeout — overlay auto-dismissed after 15s');
      }, 15000);
    } else {
      clearTimeout(_adLoadingTimeout);
      overlay.classList.add('hidden');
    }
  });

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
  bindStripTouch();
  renderHabits();
  setupScrollHeader();
  renderProfile();
  renderIconPicker('icon-picker');
  bindEventListeners();
  bindJournalSlider();
  bindScheduleUI();
  bindEditScheduleUI();
  renderNotifications();
  bindNotifUI();
  applyTheme();
  applyBookColors();

  // Initialize Media Services
  VoiceService.init();
  SketchpadService.init();
  bindMediaEvents();

  // Set up native notification channel + tap handler
  setupNotifChannel();
  bindNotifTapHandler();

  // Re-schedule notifications only for returning users who have already granted permission.
  // New users will be prompted AFTER the tutorial ends via finishTutorial().
  if (localStorage.getItem('telos_notif_prompted')) {
    scheduleNotifications(true).catch(() => {});
  }

  // Configure native status bar
  // StatusBar style is handled by applyTheme() above

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

  // Splash Screen Dismissal — waits for icon font readiness
  const splash = document.getElementById('splash-screen');
  if (splash) {
    if (!localStorage.getItem('telos_onboarded')) {
      splash.remove();
    } else {
      let splashTimeout;

      const dismissSplash = () => {
        if (splashTimeout) clearTimeout(splashTimeout);
        if (!splash.classList.contains('fade-out')) {
          splash.classList.add('fade-out');
          setTimeout(() => splash.remove(), 800); // Wait for transition
        }
      };

      // Wait for icon font to be ready BEFORE dismissing splash.
      // This eliminates the ligature-text flash on cold starts.
      const fontReady = document.fonts && document.fonts.ready
        ? document.fonts.ready
        : Promise.resolve();
      const safetyTimeout = new Promise(r => setTimeout(r, 3000));

      Promise.race([fontReady, safetyTimeout]).then(() => {
        // Ensure fonts-loaded class is set (belt-and-suspenders with head script)
        document.documentElement.classList.add('fonts-loaded');
        // Small delay to let the first paint with real icons settle
        setTimeout(dismissSplash, 400);
      });

      // If fonts load super fast, still show splash for minimum 1.2s for branding
      splashTimeout = setTimeout(dismissSplash, 1800);

      // Skip on double-tap
      let lastTap = 0;
      splash.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap < 300) {
          dismissSplash();
        }
        lastTap = now;
      });
    }
  }
});


// ─── Event Binding (no inline onclick) ────────
function bindEventListeners() {
  // Native Android hardware back button handler
  try {
    App.addListener('backButton', () => {
      // 1. Closing Overlays
      if (document.getElementById('tutorial-overlay') && !document.getElementById('tutorial-overlay').classList.contains('hidden')) { finishTutorial(); return; }
      if (document.getElementById('mic-permission-overlay') && !document.getElementById('mic-permission-overlay').classList.contains('hidden')) { document.getElementById('mic-perm-cancel').click(); return; }
      if (document.getElementById('conflict-modal-overlay') && !document.getElementById('conflict-modal-overlay').classList.contains('hidden')) { document.getElementById('btn-conflict-cancel').click(); return; }
      if (document.getElementById('clear-data-modal-overlay') && !document.getElementById('clear-data-modal-overlay').classList.contains('hidden')) { document.getElementById('btn-close-clear-data').click(); return; }
      if (document.getElementById('confirm-overlay') && !document.getElementById('confirm-overlay').classList.contains('hidden')) { closeConfirm(); return; }
      if (document.getElementById('history-modal-overlay') && !document.getElementById('history-modal-overlay').classList.contains('hidden')) { closeHistoryModal(); return; }
      if (document.getElementById('calendar-modal-overlay') && !document.getElementById('calendar-modal-overlay').classList.contains('hidden')) { closeCalendarModal(); return; }
      if (document.getElementById('edit-modal-overlay') && !document.getElementById('edit-modal-overlay').classList.contains('hidden')) { closeEditModal(); return; }
      if (document.getElementById('modal-overlay') && !document.getElementById('modal-overlay').classList.contains('hidden')) { closeAddModal(); return; }
      if (document.getElementById('journal-expanded-modal') && !document.getElementById('journal-expanded-modal').classList.contains('hidden')) { closeExpandedJournal(); return; }
      if (document.getElementById('journal-archive-modal-overlay') && !document.getElementById('journal-archive-modal-overlay').classList.contains('hidden')) { closeJournalArchive(); return; }
      if (document.getElementById('book-catalog-overlay') && !document.getElementById('book-catalog-overlay').classList.contains('hidden')) { closeBookCatalog(); return; }
      if (document.getElementById('new-book-overlay') && !document.getElementById('new-book-overlay').classList.contains('hidden')) { closeCreateBookModal(); return; }
      if (document.getElementById('sketch-modal-overlay') && !document.getElementById('sketch-modal-overlay').classList.contains('hidden')) { SketchpadService.close(); return; }

      // 2. Closing inner screens
      if (document.getElementById('screen-habit-detail') && document.getElementById('screen-habit-detail').classList.contains('active')) { closeHabitDetail(); return; }
      if (document.getElementById('screen-all-habits') && document.getElementById('screen-all-habits').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-notif-settings') && document.getElementById('screen-notif-settings').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-about') && document.getElementById('screen-about').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-cloud-sync') && document.getElementById('screen-cloud-sync').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-privacy') && document.getElementById('screen-privacy').classList.contains('active')) { switchScreen('profile'); return; }
      if (document.getElementById('screen-themes') && document.getElementById('screen-themes').classList.contains('active')) { switchScreen('profile'); return; }

      // 3. Onboarding navigation
      if (currentScreen === 'onboarding') {
        const step2 = document.getElementById('onboarding-step-2');
        if (step2 && step2.classList.contains('active')) {
          step2.classList.remove('active');
          document.getElementById('onboarding-step-1').classList.add('active');
          return;
        }
        App.exitApp();
        return;
      }

      // 4. Navigate to Today screen from other top-level tabs before exiting
      if (currentScreen !== 'today') {
        const todayNav = document.querySelector('.nav-item[data-screen="today"]');
        if (todayNav) { switchScreen('today', todayNav); return; }
      }

      // 5. Exit app if already at top level (today)
      App.exitApp();
    });
  } catch(e) {}

  // Long-press state flags (must be declared before click handler)
  let navJournalTimer = null;
  let navJournalLongPressActive = false;
  let navJournalLongPressFired = false;

  // Bottom navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      // If Journal long-press just opened the catalog, block this click
      if (navJournalLongPressFired) {
        navJournalLongPressFired = false;
        return;
      }
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

  // Premium upsell modal listeners
  initPremiumUpsellListeners();

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

  const jTextarea = document.getElementById('journal-textarea');
  const jScreen = document.getElementById('screen-journal');
  // Keyboard tracking is handled globally via body.keyboard-visible listener later in this file
  
  document.getElementById('btn-browse-journal').addEventListener('click', () => {
    openJournalArchive();
  });


  // Book catalog / switcher (Long press on bottom nav)
  const navJournalBtn = document.getElementById('nav-journal');
  if (navJournalBtn) {
    const startNavPress = (e) => {
      if (navJournalLongPressActive) return;
      navJournalLongPressActive = true;
      navJournalLongPressFired = false;

      navJournalTimer = setTimeout(() => {
        navJournalTimer = null;
        navJournalLongPressFired = true;
        // Trigger double haptic for successful long-press activation
        if (notifSettings.hapticsEnabled) {
          try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(err) {}
          setTimeout(() => {
            try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(err) {}
          }, 120);
        }
        
        // Dismiss hint bubble permanently if they discovered it
        markJournalHintSeen();
        
        openBookCatalog();
      }, 500); 
    };
    const endNavPress = () => {
      navJournalLongPressActive = false;
      if (navJournalTimer) {
        clearTimeout(navJournalTimer);
        navJournalTimer = null;
      }
      // Clear the block flag shortly after touch ends so it doesn't trap unrelated future clicks
      setTimeout(() => {
        navJournalLongPressFired = false;
      }, 300);
    };

    navJournalBtn.addEventListener('touchstart', startNavPress, {passive: true});
    navJournalBtn.addEventListener('pointerdown', startNavPress);
    
    navJournalBtn.addEventListener('touchend', endNavPress);
    navJournalBtn.addEventListener('touchcancel', endNavPress);
    navJournalBtn.addEventListener('pointerup', endNavPress);
    navJournalBtn.addEventListener('pointercancel', endNavPress);
    
    navJournalBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  document.getElementById('btn-close-catalog').addEventListener('click', () => closeBookCatalog());
  document.getElementById('btn-create-book').addEventListener('click', () => {
    // closeBookCatalog(); // Wait, let's keep it open or close it? The original closed it. 
    // Actually keep original behavior
    closeBookCatalog();
    openCreateBookModal();
  });
  document.getElementById('btn-cancel-new-book').addEventListener('click', () => closeCreateBookModal());
  document.getElementById('btn-confirm-new-book').addEventListener('click', () => confirmCreateBook());
  document.getElementById('book-catalog-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'book-catalog-overlay') closeBookCatalog();
  });
  document.getElementById('new-book-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'new-book-overlay') closeCreateBookModal();
  });
  // Premium Upsell Modal (fallback from MonetizationManager when Adapty paywall fails)
  document.addEventListener('showPremiumUpsell', (e) => {
    // Delegate to the unified modal function — no callback needed for fallback path
    // (Adapty's own purchase success handler covers the upgrade flow)
    showPremiumUpsellModal(e.detail.triggerId, null);
  });

  document.getElementById('btn-upsell-close')?.addEventListener('click', () => {
    document.getElementById('premium-upsell-overlay').classList.add('hidden');
  });
  
  document.getElementById('premium-upsell-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'premium-upsell-overlay') {
      document.getElementById('premium-upsell-overlay').classList.add('hidden');
    }
  });
  // Adapty Premium Logic
  document.getElementById('btn-upsell-upgrade')?.addEventListener('click', async () => {
    if (window.MonetizationManager) {
      console.log('Initiating Adapty purchase flow via fallback modal...');
      // Instead of instant upgrade, try to launch the paywall again. 
      // If it failed before, it might fail again, but we shouldn't just give it away for free.
      const launched = await window.MonetizationManager.launchAdaptyPaywall('paywall');
      if (!launched) {
          showToast('Store connection failed. Please try again later.');
      } else {
          document.getElementById('premium-upsell-overlay').classList.add('hidden');
      }
    }
  });

  document.getElementById('btn-upsell-restore')?.addEventListener('click', async () => {
    showToast('Restoring purchases...');
    if (window.MonetizationManager) {
      const isSubscribed = await window.MonetizationManager.restorePurchases();
      if (isSubscribed) {
        document.getElementById('premium-upsell-overlay').classList.add('hidden');
        showToast('Purchases restored successfully!');
        renderBookCatalog();
      } else {
        showToast('No active subscription found.', 3000);
      }
    }
  });

  // Book Context Menu (Long Press)
  document.addEventListener('openBookContextMenu', (e) => {
    contextMenuBookId = e.detail.book.id;
    document.getElementById('context-menu-book-title').textContent = e.detail.book.name;
    const hideBtnIcon = document.getElementById('context-icon-hide');
    const hideBtnText = document.getElementById('context-text-hide');
    if (hideBtnIcon && hideBtnText) {
      if (e.detail.book.isHidden) {
        hideBtnIcon.textContent = 'lock_open';
        hideBtnText.textContent = 'Remove from Secrets';
      } else {
        hideBtnIcon.textContent = 'lock';
        hideBtnText.textContent = 'Hide Journal';
      }
    }
    document.getElementById('book-context-menu-overlay').classList.remove('hidden');
    triggerHaptic('Medium');
  });

  // Reward forfeit dialog — shown when user closes a rewarded ad early
  document.addEventListener('showRewardForfeitDialog', () => {
    const overlay = document.getElementById('reward-forfeit-overlay');
    if (overlay) overlay.classList.remove('hidden');
  });

  // Handle banner ad layout shifts
  document.addEventListener('bannerAdLoaded', () => {
    console.log('[UI] Banner ad loaded, refreshing journal layout...');
    if (currentScreen === 'journal' && pageFlip) {
      setTimeout(() => {
        pageFlip.update();
      }, 300); // Small delay for DOM to settle
    }
  });

  document.getElementById('btn-forfeit-skip')?.addEventListener('click', () => {
    // User chooses to forfeit the reward — clear pending state
    if (window.MonetizationManager) {
      window.MonetizationManager._pendingRewardCallback = null;
      window.MonetizationManager._pendingActionContext = null;
      window.MonetizationManager._runRewardedLogic = null;
    }
    document.getElementById('reward-forfeit-overlay').classList.add('hidden');
    showToast('Reward skipped.');
  });

  document.getElementById('btn-forfeit-retry')?.addEventListener('click', async () => {
    document.getElementById('reward-forfeit-overlay').classList.add('hidden');
    // Replay only the ad, not the paywall
    if (window.MonetizationManager) {
      await window.MonetizationManager.replayRewardedAd();
    }
  });

  document.getElementById('book-context-menu-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'book-context-menu-overlay') closeBookContextMenu();
  });
  
  document.getElementById('btn-context-edit')?.addEventListener('click', () => {
    const bookId = contextMenuBookId;
    closeBookContextMenu();
    closeBookCatalog();
    openCreateBookModal(bookId);
  });
  
  document.getElementById('btn-context-hide')?.addEventListener('click', () => {
    const book = journalBooks.find(b => b.id === contextMenuBookId);
    if(book) {
      if (!book.isHidden && window.MonetizationManager) {
        const currentSecretsCount = journalBooks.filter(b => b.isHidden).length;
        if (!window.MonetizationManager.canMoveToSecrets(currentSecretsCount)) {
          closeBookContextMenu();
          window.MonetizationManager.showUpsellModal('secrets_locked');
          return;
        }
      }
      
      if (journalBooks.filter(b => !b.isHidden).length === 1 && !book.isHidden) {
        showToast("Cannot hide your only visible journal.");
      } else {
        book.isHidden = !book.isHidden;
        save();
        closeBookContextMenu();
        renderBookCatalog();
        showToast(book.isHidden ? 'Moved to Secrets' : 'Removed from Secrets');
        triggerHaptic();
      }
    }
  });
  
  document.getElementById('btn-context-export')?.addEventListener('click', async () => {
    const book = journalBooks.find(b => b.id === contextMenuBookId);
    closeBookContextMenu();
    if(book) {
      const doExport = async () => {
        const bookJournal = getBookJournal(journal, book.id);
        
        const entryCount = countBookEntries(journal, book.id);
        if (entryCount === 0) {
          showToast('This journal has no entries to export.');
          return;
        }
        
        showToast('Generating PDF...', 2000);
        try {
          const blob = await exportBookToPDF(book, bookJournal);
          const safeName = book.name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
          const filename = `Telos_${safeName}_${new Date().toISOString().slice(0,10)}.pdf`;
          await sharePDF(blob, filename);
          triggerHaptic();
        } catch (e) {
          console.error('PDF export error:', e);
          showToast('Export failed. Please try again.');
        }
      };

      if (window.MonetizationManager && !window.MonetizationManager.canExportPDF()) {
        showPremiumUpsellModal('pdf_export', doExport);
        return;
      }
      
      doExport();
    }
  });
  
  document.getElementById('btn-context-delete')?.addEventListener('click', () => {
    const book = journalBooks.find(b => b.id === contextMenuBookId);
    const bookId = contextMenuBookId;
    closeBookContextMenu();
    if(book) deleteBookPrompt(bookId, book.name);
  });
  document.getElementById('btn-expand-journal')?.addEventListener('click', () => openExpandedJournal());
  document.getElementById('btn-save-expanded-journal')?.addEventListener('click', () => saveExpandedJournal());

  document.getElementById('journal-expanded-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'journal-expanded-modal') closeExpandedJournal();
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
  // Legacy button removed


  document.getElementById('menu-all-habits').addEventListener('click', () => switchScreen('all-habits'));
  document.getElementById('menu-notif-settings').addEventListener('click', () => switchScreen('notif-settings'));
  document.getElementById('menu-cloud-sync').addEventListener('click', () => {
    if (window.MonetizationManager && !window.MonetizationManager.isPremiumUser()) {
      window.MonetizationManager.showUpsellModal('cloud_sync');
      return;
    }
    switchScreen('cloud-sync');
  });
  document.getElementById('menu-about').addEventListener('click', () => switchScreen('about'));
  document.getElementById('menu-change-passcode')?.addEventListener('click', () => {
    openPasscodeModal(getStoredPasscode() ? 'change_verify' : 'setup');
  });
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
  document.getElementById('btn-back-cloud').addEventListener('click', () => switchScreen('profile'));
  document.getElementById('btn-back-about').addEventListener('click', () => switchScreen('profile'));
  document.getElementById('btn-back-privacy').addEventListener('click', () => switchScreen('profile'));

  // --- About Us Easter Egg (20 taps to unlock Premium) ---
  let logoTapCount = 0;
  let logoTapTimer = null;
  document.getElementById('about-logo-tap')?.addEventListener('click', () => {
    logoTapCount++;
    window.triggerHaptic('Light');
    
    // Bounce animation feedback
    const container = document.getElementById('about-logo-container');
    if (container) {
      container.style.transform = 'scale(0.9)';
      setTimeout(() => container.style.transform = 'scale(1)', 100);
    }

    if (logoTapTimer) clearTimeout(logoTapTimer);
    
    if (logoTapCount >= 20) {
      logoTapCount = 0;
      if (window.MonetizationManager) {
        window.MonetizationManager.setPremiumState(true);
        window.triggerHaptic('Heavy');
        alert('Congratulations! Telos Premium has been unlocked. Thank you for your support!');
      }
    } else {
      // Reset counter if no tap for 2 seconds
      logoTapTimer = setTimeout(() => {
        logoTapCount = 0;
      }, 2000);
    }
  });

  // Themes screen navigation
  document.getElementById('menu-themes').addEventListener('click', () => {
    switchScreen('themes');
    renderThemePicker();
  });
  document.getElementById('btn-back-themes').addEventListener('click', () => switchScreen('profile'));

  document.getElementById('toggle-haptics').addEventListener('change', (e) => {
    notifSettings.hapticsEnabled = e.target.checked;
    save();
  });

  document.getElementById('toggle-journal-hint').addEventListener('change', (e) => {
    // HARD PAYWALL: Only premium users can change this setting
    if (window.MonetizationManager && !window.MonetizationManager.isPremiumUser()) {
      e.preventDefault();
      // Revert visually immediately
      e.target.checked = !e.target.checked;
      window.MonetizationManager.showUpsellModal('journal_hint_toggle');
      return;
    }
    
    notifSettings.showJournalHint = e.target.checked;
    applyJournalHintVisibility();
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
      } else if (!document.getElementById('journal-expanded-modal').classList.contains('hidden')) {
        closeExpandedJournal();
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

function applyJournalHintVisibility() {
  const sublabel = document.getElementById('nav-journal-sublabel');
  if (sublabel) {
    sublabel.style.display = notifSettings.showJournalHint !== false ? '' : 'none';
  }
}

// ─── Storage (with error handling) ────────────
function loadData() {
  try {
    habits       = JSON.parse(localStorage.getItem(STORAGE_KEY_HABITS))        || [];
    logs         = JSON.parse(localStorage.getItem(STORAGE_KEY_LOGS))          || {};
    journal      = JSON.parse(localStorage.getItem(STORAGE_KEY_JOURNAL))       || {};
    habitJournal = JSON.parse(localStorage.getItem(STORAGE_KEY_HABIT_JOURNAL)) || {};
    journalBooks = JSON.parse(localStorage.getItem(STORAGE_KEY_BOOKS))         || [];
    const savedNotif = JSON.parse(localStorage.getItem(STORAGE_KEY_NOTIF));
    if (savedNotif) {
      notifSettings = Object.assign(notifSettings, savedNotif);
      // Migration to minimalist schema
      if (typeof notifSettings.morning !== 'object') notifSettings.morning = { enabled: true, time: '08:00' };
      if (typeof notifSettings.evening !== 'object') notifSettings.evening = { enabled: true, time: '20:00' };
      if (typeof notifSettings.streak === 'object' || typeof notifSettings.streak === 'undefined') notifSettings.streak = true;
      if (typeof notifSettings.showJournalHint === 'undefined') notifSettings.showJournalHint = true;
      delete notifSettings.enabled;
      delete notifSettings.defaultTimes;
      delete notifSettings.habitReminders;
      delete notifSettings.smart;
      delete notifSettings.snooze;
    }
  } catch(e) {
    habits = []; logs = {}; journal = {}; habitJournal = {}; journalBooks = [];
  }

  applyJournalHintVisibility();

  // ── Multi-Book Migration ──
  // If journalBooks is empty but journal has data, migrate from flat to multi-book
  if (journalBooks.length === 0) {
    journalBooks = [createDefaultBook()];
  }
  // Migrate flat journal { dateKey: [entries] } → { bookId: { dateKey: [entries] } }
  journal = migrateJournalToMultiBook(journal);

  // ── Cover ID Migration (v1.5) ──
  // Remap old cover IDs to new premium IDs
  const COVER_ID_MAP = {
    forest: 'verdant', pink: 'blossom', goth: 'obsidian',
    red: 'obsidian', playful: 'moonlit', rose: 'blossom',
    midnight: 'moonlit', prism: 'moonlit', amour: 'amore',
    ember: 'classic', pride: 'moonlit'
  };
  journalBooks.forEach(book => {
    if (COVER_ID_MAP[book.cover]) book.cover = COVER_ID_MAP[book.cover];
  });
  
  // Restore active book (default to first book)
  activeBookId = notifSettings.activeBookId || journalBooks[0].id;
  // Validate activeBookId still exists
  if (!journalBooks.find(b => b.id === activeBookId)) activeBookId = journalBooks[0].id;

  // Secrets safeguard on startup: if active is hidden but secrets locked
  const activeBook = journalBooks.find(b => b.id === activeBookId);
  if (activeBook && activeBook.isHidden && !isSecretsUnlocked) {
    const firstVisible = journalBooks.find(b => !b.isHidden);
    activeBookId = firstVisible ? firstVisible.id : journalBooks[0].id;
    notifSettings.activeBookId = activeBookId;
  }

  // Migration: Ensure all entries are arrays of objects {text, ts}
  // Now operates on each book's journal data
  Object.keys(journal).forEach(bookId => {
    const bookData = journal[bookId];
    if (typeof bookData !== 'object' || Array.isArray(bookData)) return;
    Object.keys(bookData).forEach(k => {
      if (typeof bookData[k] === 'string') bookData[k] = [{ text: bookData[k], ts: Date.now() }];
      if (Array.isArray(bookData[k])) {
        bookData[k] = bookData[k].map(item => typeof item === 'string' ? { text: item, ts: Date.now() } : item);
      }
    });
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
    ];

    logs[t] = { [habits[0].id]: true, [habits[1].id]: true };
    // Removing logs for y (yesterday) and b (before) as per user request to limit initial checks
    logs[y] = {};
    logs[b] = {};

    journal[DEFAULT_BOOK_ID] = journal[DEFAULT_BOOK_ID] || {};
    journal[DEFAULT_BOOK_ID][t] = [{ text: "Starting my journey with Telos today. The interface feels calm and focused.", ts: Date.now() }];

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
    localStorage.setItem(STORAGE_KEY_BOOKS,          JSON.stringify(journalBooks));
    // Persist active book choice in notifSettings for quick restore
    notifSettings.activeBookId = activeBookId;
    localStorage.setItem(STORAGE_KEY_NOTIF,         JSON.stringify(notifSettings));

    // Track local modification time for cloud sync dirty-checking
    cloudSyncState.localLastModified = Date.now();
    saveCloudSyncState();
    
    // Sync to Android widget via high-priority synchronous bridge
    const todayStr = todayKey();
    const dayLogs = logs[todayStr] || {};
    const scheduledHabits = habits.filter(h => shouldShowHabit(h, todayStr)).map(h => {
      let displayName = h.name;
      if (h.schedule && h.schedule.type === 'onetime' && todayStr > h.schedule.date && !dayLogs[h.id]) {
        const scheduledD = parseDate(h.schedule.date);
        const todayD = parseDate(todayStr);
        const diffTime = Math.abs(todayD - scheduledD);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        displayName += ` (${diffDays} day${diffDays > 1 ? 's' : ''} overdue)`;
      }
      return {
        id: h.id,
        name: displayName,
        icon: h.icon,
        completed: !!dayLogs[h.id]
      };
    });

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

// ─── Active Book Journal Accessor ─────────
function getActiveJournal() {
  return getBookJournal(journal, activeBookId);
}

// ─── Apply Book Colors to CSS Custom Properties ─────────
// Separates book-contextual colors from global app theme
function applyBookColors() {
  const book = journalBooks.find(b => b.id === activeBookId) || journalBooks[0];
  if (!book) return;
  const cover = BOOK_COVERS[book.cover] || BOOK_COVERS.classic;
  const root = document.documentElement;
  root.style.setProperty('--book-accent', cover.accent);
  root.style.setProperty('--book-text', cover.textColor);
  root.style.setProperty('--book-bg', cover.bgGradient);
  // Parse a darker version for button backgrounds
  // Extract the first color stop from the gradient for solid bg use
  const bgMatch = cover.bgGradient.match(/#[0-9a-fA-F]{6}/);
  const solidBg = bgMatch ? bgMatch[0] : '#1a1a2e';
  root.style.setProperty('--book-bg-solid', solidBg);
  root.style.setProperty('--book-accent-15', cover.accent + '26'); // 15% opacity
  root.style.setProperty('--book-accent-30', cover.accent + '4d'); // 30% opacity
  root.style.setProperty('--book-accent-50', cover.accent + '80'); // 50% opacity

  // Flag light-background covers so CSS can suppress dark overlay effects
  const LIGHT_COVERS = ['ivory'];
  const isLight = LIGHT_COVERS.includes(book.cover);
  root.setAttribute('data-book-light', isLight ? 'true' : 'false');
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
      scheduleNotifications().catch(() => {});
    } else {
      stopWidgetSync();
      // Stop all playing journal audio when app goes to background
      stopAllJBookAudio(null);
    }
  });
} catch(e) { /* not on native */ }

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === 'visible') {
        syncWidgetToggles();
        startWidgetSync();
    } else {
        stopWidgetSync();
        // Stop all playing journal audio when visibility is lost
        stopAllJBookAudio(null);
    }
});


// ─── Journal Navigation Slider ───
function bindJournalSlider() {
  const thumb = document.getElementById('journal-nav-thumb');
  const track = document.getElementById('journal-nav-track');
  if (!thumb || !track) return;

  let isDragging = false;
  let trackWidth = 0;
  let trackLeft = 0;
  let flipInterval = null;
  let lastFlipTime = 0;
  let currentRatio = 0; // Cached drag ratio — avoids getBoundingClientRect per-frame

  const startDrag = (clientX) => {
    isDragging = true;
    thumb.classList.add('dragging');
    const rect = track.getBoundingClientRect();
    trackWidth = rect.width;
    trackLeft = rect.left;
    currentRatio = 0;
    updateThumbPosition(clientX);
    loop();
  };

  const moveDrag = (clientX) => {
    if (!isDragging) return;
    updateThumbPosition(clientX);
  };

  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    thumb.classList.remove('dragging');
    thumb.style.left = '50%'; // Snap back to center via CSS transition
    currentRatio = 0;
    if (flipInterval) {
      cancelAnimationFrame(flipInterval);
      flipInterval = null;
    }
  };

  const updateThumbPosition = (clientX) => {
    let x = clientX - trackLeft;
    if (x < 0) x = 0;
    if (x > trackWidth) x = trackWidth;
    thumb.style.left = `${x}px`;
    // Compute ratio from cached track dimensions — zero layout thrash
    const center = trackWidth / 2;
    currentRatio = center > 0 ? (x - center) / center : 0;
    if (currentRatio < -1) currentRatio = -1;
    if (currentRatio > 1) currentRatio = 1;
  };

  const loop = () => {
    if (!isDragging) return;

    // Use cached currentRatio — no getBoundingClientRect calls per frame
    if (Math.abs(currentRatio) > 0.15) {
      const minSpeed = 1200;
      const maxSpeed = 500;
      const currentSpeed = minSpeed - ((Math.abs(currentRatio) - 0.15) / 0.85) * (minSpeed - maxSpeed);

      const now = performance.now();
      if (now - lastFlipTime > currentSpeed) {
        lastFlipTime = now;
        
        if (journalPageFlip) {
          if (currentRatio > 0) {
            journalPageFlip.flipNext();
          } else {
            journalPageFlip.flipPrev();
          }
        }
      }
    }
    
    flipInterval = requestAnimationFrame(loop);
  }

  // Mouse events
  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startDrag(e.clientX);
  });
  window.addEventListener('mousemove', (e) => {
    if (isDragging) moveDrag(e.clientX);
  });
  window.addEventListener('mouseup', () => {
    endDrag();
  });

  // Touch events
  thumb.addEventListener('touchstart', (e) => {
    startDrag(e.touches[0].clientX);
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (isDragging) {
      moveDrag(e.touches[0].clientX);
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  window.addEventListener('touchend', () => {
    endDrag();
  });
}

// ─── Swipe Navigation ─────────────────────────
function bindSwipeNavigation() {
  // Replaced by bindStripTouch() — tactile date strip
}

// ─── Tactile Date Strip ──────────────────────
// Custom touch-driven scrolling with momentum, snapping, and haptic ticks
const STRIP_DAY_WIDTH = 44; // Must match CSS .cal-day width
const STRIP_FRICTION  = 0.94; // Momentum decay per frame (lower = more friction)
const STRIP_MIN_VEL   = 0.3;  // Stop momentum below this px/frame
const STRIP_SNAP_MS   = 280;  // Snap animation duration
let stripTrack = null;
let stripOffset = 0; // Current translateX offset (negative = scrolled right)
let stripDayCount = 0;
let stripMomentumRAF = null;
let stripLastTickIndex = -1; // Track which day was last "ticked" for haptic
let stripTouchState = {
  startX: 0, startOffset: 0, lastX: 0, lastT: 0, velocity: 0, isDragging: false
};
let stripIsSnapping = false;

function applyStripTranslation(tx) {
  if (stripTrack) {
    stripTrack.style.transform = `translateX(${tx}px)`;
  }
}

function cancelMomentum() {
  if (stripMomentumRAF) {
    cancelAnimationFrame(stripMomentumRAF);
    stripMomentumRAF = null;
  }
  stripIsSnapping = false;
}

/** Fire haptic tick when crossing a day boundary */
function checkStripTick(offset) {
  const strip = document.getElementById('calendar-strip');
  if (!strip) return;
  const stripW = strip.offsetWidth;
  const centerOffset = -offset + stripW / 2;
  const dayIndex = Math.round(centerOffset / STRIP_DAY_WIDTH - 0.5);
  const clampedIndex = Math.max(0, Math.min(stripDayCount - 1, dayIndex));
  
  const days = stripTrack?.querySelectorAll('.cal-day');
  if (!days) return;

  // Update focused class for the day in the center
  if (clampedIndex !== stripLastTickIndex) {
    days.forEach(d => d.classList.remove('focused'));
    if (days[clampedIndex]) {
      days[clampedIndex].classList.add('focused');
      
      // Haptic tick
      try { Haptics.impact({ style: ImpactStyle.Light }); } catch(e) {}
      
      // Visual tick pulse
      const el = days[clampedIndex];
      el.classList.remove('tick-anim');
      void el.offsetWidth;
      el.classList.add('tick-anim');
    }
  }
  stripLastTickIndex = clampedIndex;

  // Infinite Scroll: Check if we are near the boundaries
  if (clampedIndex < 5) {
    shiftStripWindow(-10);
  } else if (clampedIndex > 25) {
    shiftStripWindow(10);
  }
}

/**
 * Shifts the 31-day window by deltaDays and adjusts the offset to be seamless.
 */
function shiftStripWindow(deltaDays) {
  const centerDate = parseDate(stripCenterDate);
  centerDate.setDate(centerDate.getDate() + deltaDays);
  stripCenterDate = dateKey(centerDate);

  // Before building, we need to adjust the current offset so the shift is invisible.
  // New window is shifted by deltaDays, so to keep the same content in place,
  // we must move the track in the OPPOSITE direction of the window shift.
  // If we shift window 10 days forward (+10), the indices decrease by 10.
  // To keep pos, new_offset = old_offset + (10 * width).
  const shiftPx = deltaDays * STRIP_DAY_WIDTH;
  stripOffset += shiftPx;

  // If we are currently dragging, we must adjust the startOffset too
  if (stripTouchState.isDragging) {
    stripTouchState.startOffset += shiftPx;
  }

  // Rebuild the calendar without the auto-recenter that would break our manual offset
  buildCalendar({ skipRecenter: true });

  // Apply the new offset immediately
  applyStripTranslation(stripOffset);
}

/** Momentum physics loop — friction-based deceleration */
function startMomentum(velocity) {
  cancelMomentum();
  
  let vel = velocity;
  
  function tick() {
    vel *= STRIP_FRICTION;
    
    if (Math.abs(vel) < STRIP_MIN_VEL) {
      // Velocity exhausted — snap to nearest date
      snapStrip();
      return;
    }
    
    stripOffset += vel;
    clampStripOffset();
    applyStripTranslation(stripOffset);
    checkStripTick(stripOffset);
    
    stripMomentumRAF = requestAnimationFrame(tick);
  }
  
  stripMomentumRAF = requestAnimationFrame(tick);
}

/** Clamp offset so the strip doesn't scroll past its bounds */
function clampStripOffset() {
  const strip = document.getElementById('calendar-strip');
  if (!strip || !stripTrack) return;
  const stripW = strip.offsetWidth;
  const trackW = stripDayCount * STRIP_DAY_WIDTH;
  const minOffset = -(trackW - stripW);
  const maxOffset = 0;
  stripOffset = Math.max(minOffset, Math.min(maxOffset, stripOffset));
}

/** Snap to nearest day cell center with a spring-like animation */
function snapStrip() {
  cancelMomentum();
  stripIsSnapping = true;
  
  const strip = document.getElementById('calendar-strip');
  if (!strip || !stripTrack) return;
  const stripW = strip.offsetWidth;
  
  // Find the day closest to center
  const centerOffset = -stripOffset + stripW / 2;
  const nearestIndex = Math.round(centerOffset / STRIP_DAY_WIDTH - 0.5);
  const clampedIndex = Math.max(0, Math.min(stripDayCount - 1, nearestIndex));
  
  // Target offset: position this day at center
  const targetOffset = -(clampedIndex * STRIP_DAY_WIDTH + STRIP_DAY_WIDTH / 2 - stripW / 2);
  
  // Clamp target
  const trackW = stripDayCount * STRIP_DAY_WIDTH;
  const minOffset = -(trackW - stripW);
  const finalTarget = Math.max(minOffset, Math.min(0, targetOffset));
  
  // Animate with CSS transition
  stripTrack.style.transition = `transform ${STRIP_SNAP_MS}ms cubic-bezier(.25,.8,.25,1)`;
  stripTrack.style.transform = `translateX(${finalTarget}px)`;
  
  stripOffset = finalTarget;
  
  // After snap completes, select the date and remove transition
  setTimeout(() => {
    if (stripTrack) stripTrack.style.transition = 'none';
    stripIsSnapping = false;
    
    // Determine which date was snapped to and select it
    const days = stripTrack?.querySelectorAll('.cal-day');
    if (days && days[clampedIndex]) {
      const key = days[clampedIndex].dataset.dateKey;
      if (key && key !== selectedDate) {
        // Haptic feedback for final selection
        try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(e) {}
        selectedDate = key;
        stripCenterDate = key;
        // Rebuild habits display without rebuilding the strip
        renderHabits();
        // Update strip visual selection
        days.forEach(d => {
          d.classList.remove('selected');
          d.classList.remove('focused');
        });
        days[clampedIndex].classList.add('selected');
        days[clampedIndex].classList.add('focused');
        // Update month label & jump button
        updateStripHeader();
      }
    }
  }, STRIP_SNAP_MS + 10);
}

/** Update the month label and Today jump button without rebuilding the strip */
function updateStripHeader() {
  const label = document.getElementById('month-label');
  const jumpBtn = document.getElementById('btn-jump-today');
  const d = parseDate(selectedDate);
  
  label.innerHTML = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()} <span class="material-symbols-outlined" style="font-size: 16px;">expand_more</span>`;
  
  if (selectedDate === todayKey()) {
    jumpBtn.classList.add('hidden');
  } else {
    jumpBtn.classList.remove('hidden');
  }
}

function shiftStrip(delta) {
  changeSelectedDate(delta);
}

function changeSelectedDate(delta) {
  const d = parseDate(selectedDate);
  d.setDate(d.getDate() + delta);
  selectDate(dateKey(d));
}

/** Bind touch handlers for the calendar strip */
function bindStripTouch() {
  const strip = document.getElementById('calendar-strip');
  if (!strip) return;
  
  strip.addEventListener('touchstart', (e) => {
    cancelMomentum();
    const touch = e.touches[0];
    stripTouchState.startX = touch.clientX;
    stripTouchState.startOffset = stripOffset;
    stripTouchState.lastX = touch.clientX;
    stripTouchState.lastT = performance.now();
    stripTouchState.velocity = 0;
    stripTouchState.isDragging = true;
    
    if (stripTrack) stripTrack.style.transition = 'none';
  }, { passive: true });
  
  strip.addEventListener('touchmove', (e) => {
    if (!stripTouchState.isDragging) return;
    
    const touch = e.touches[0];
    const now = performance.now();
    const dx = touch.clientX - stripTouchState.lastX;
    const dt = Math.max(1, now - stripTouchState.lastT);
    
    // Exponential smoothing for velocity
    const instantVel = dx / dt * 16; // Normalize to ~60fps frame time
    stripTouchState.velocity = 0.7 * instantVel + 0.3 * stripTouchState.velocity;
    
    stripTouchState.lastX = touch.clientX;
    stripTouchState.lastT = now;
    
    stripOffset = stripTouchState.startOffset + (touch.clientX - stripTouchState.startX);
    clampStripOffset();
    applyStripTranslation(stripOffset);
    checkStripTick(stripOffset);
  }, { passive: true });
  
  strip.addEventListener('touchend', () => {
    if (!stripTouchState.isDragging) return;
    stripTouchState.isDragging = false;
    
    const vel = stripTouchState.velocity;
    
    if (Math.abs(vel) > 1.5) {
      // Has momentum — start physics loop
      startMomentum(vel);
    } else {
      // Low velocity — just snap
      snapStrip();
    }
  }, { passive: true });
  
  // Also handle mouse for desktop testing
  strip.addEventListener('mousedown', (e) => {
    cancelMomentum();
    stripTouchState.startX = e.clientX;
    stripTouchState.startOffset = stripOffset;
    stripTouchState.lastX = e.clientX;
    stripTouchState.lastT = performance.now();
    stripTouchState.velocity = 0;
    stripTouchState.isDragging = true;
    if (stripTrack) stripTrack.style.transition = 'none';
    e.preventDefault();
  });
  
  window.addEventListener('mousemove', (e) => {
    if (!stripTouchState.isDragging) return;
    const now = performance.now();
    const dx = e.clientX - stripTouchState.lastX;
    const dt = Math.max(1, now - stripTouchState.lastT);
    const instantVel = dx / dt * 16;
    stripTouchState.velocity = 0.7 * instantVel + 0.3 * stripTouchState.velocity;
    stripTouchState.lastX = e.clientX;
    stripTouchState.lastT = now;
    stripOffset = stripTouchState.startOffset + (e.clientX - stripTouchState.startX);
    clampStripOffset();
    applyStripTranslation(stripOffset);
    checkStripTick(stripOffset);
  });
  
  window.addEventListener('mouseup', () => {
    if (!stripTouchState.isDragging) return;
    stripTouchState.isDragging = false;
    const vel = stripTouchState.velocity;
    if (Math.abs(vel) > 1.5) {
      startMomentum(vel);
    } else {
      snapStrip();
    }
  });
  // Setup observer for initial layout and responsiveness
  if (!window.calendarResizeObserver) {
    window.calendarResizeObserver = new ResizeObserver(() => {
      // Small debounce/raf to ensure layout is ready
      requestAnimationFrame(() => recenterStrip());
    });
    window.calendarResizeObserver.observe(strip);
  }
}

/**
 * Aligns the calendar strip so that the currently selectedDate is centered.
 * Uses ResizeObserver to handle layout/visibility delays.
 */
function recenterStrip() {
  const strip = document.getElementById('calendar-strip');
  const track = document.querySelector('.cal-strip-track');
  if (!strip || !track) return;

  const stripW = strip.offsetWidth;
  if (stripW === 0) return; // Hidden or not yet rendered

  const allDays = Array.from(track.querySelectorAll('.cal-day'));
  let selectedIndex = -1;
  allDays.forEach((el, i) => {
    if (el.dataset.dateKey === selectedDate) selectedIndex = i;
  });

  if (selectedIndex === -1) {
    // If exact date not in current strip, find the closest or default to center
    selectedIndex = 15;
  }

  stripOffset = -(selectedIndex * STRIP_DAY_WIDTH + STRIP_DAY_WIDTH / 2 - stripW / 2);
  clampStripOffset();
  
  track.style.transition = 'none';
  applyStripTranslation(stripOffset);
  stripLastTickIndex = selectedIndex;
  
  // Update visual focus state
  checkStripTick(stripOffset);
}

// ─── Calendar Strip ───────────────────────────
function buildCalendar(opts = {}) {
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

  // Create or reuse the track element
  let track = strip.querySelector('.cal-strip-track');
  if (!track) {
    track = document.createElement('div');
    track.className = 'cal-strip-track';
    strip.innerHTML = '';
    strip.appendChild(track);
  } else {
    track.innerHTML = '';
  }
  stripTrack = track;
  stripDayCount = days.length;

  let selectedIndex = 15; // Default to center (today)

  days.forEach((d, i) => {
    const key      = dateKey(d);
    const isToday    = key === todayKey();
    const isSelected = key === selectedDate;
    const isFuture   = key > todayKey();
    const hasDone    = logs[key] && Object.keys(logs[key]).length > 0;

    if (isSelected) selectedIndex = i;

    const el = document.createElement('div');
    el.className = 'cal-day'
      + (isToday    ? ' today'          : '')
      + (isSelected ? ' selected'       : '')
      + (hasDone    ? ' has-completion' : '')
      + (isFuture   ? ' future'         : '');

    el.setAttribute('aria-label', d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' }));
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.dataset.dateKey = key;

    el.innerHTML = `
      <span class="cal-letter">${DAY_LABELS[d.getDay()]}</span>
      <span class="cal-num">${d.getDate()}</span>
    `;

    // Tap to select (only if not dragging)
    el.addEventListener('click', (e) => {
      // Don't select if user was dragging (moved > 5px)
      if (Math.abs(stripTouchState.startOffset - stripOffset) > 5) return;
      selectDate(key);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDate(key); }
    });

    track.appendChild(el);
  });
  
  // Position the strip so the selected day is centered
  if (!opts.skipRecenter) {
    recenterStrip();
  }
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
function wasCompletedBefore(habitId, targetDateStr) {
  for (const date in logs) {
    if (date < targetDateStr && logs[date][habitId]) {
      return true;
    }
  }
  return false;
}

function shouldShowHabit(habit, dateStr) {
  if (!habit.schedule) return true;
  if (habit.createdAt && dateStr < habit.createdAt) return false;

  const d = parseDate(dateStr);
  const dayOfWeek = d.getDay(); // 0=Sun, 6=Sat
  const type = habit.schedule.type;

  if (type === 'daily') return true;
  if (type === 'weekdays') return dayOfWeek >= 1 && dayOfWeek <= 5;
  if (type === 'weekends') return dayOfWeek === 0 || dayOfWeek === 6;
  if (type === 'onetime') {
    if (dateStr === habit.schedule.date) return true;
    if (dateStr > habit.schedule.date) {
      return !wasCompletedBefore(habit.id, dateStr);
    }
    return false;
  }

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

    let overdueBadge = '';
    if (habit.schedule && habit.schedule.type === 'onetime' && selectedDate > habit.schedule.date && !done) {
      const scheduledD = parseDate(habit.schedule.date);
      const selectedD = parseDate(selectedDate);
      const diffTime = Math.abs(selectedD - scheduledD);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      overdueBadge = `<span class="overdue-badge">${diffDays} day${diffDays > 1 ? 's' : ''} overdue</span>`;
    }

    card.innerHTML = `
      <div class="habit-card-info" role="button" tabindex="0" aria-label="View details for ${escapeHtml(habit.name)}">
        <div class="habit-card-icon-row">
          <span class="material-symbols-outlined habit-card-icon" style="font-variation-settings:'FILL' ${done ? 1 : 0};">${habit.icon}</span>
          <span class="habit-name${done ? ' habit-name--done' : ''}">${escapeHtml(habit.name)}</span>
          ${overdueBadge}
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
    if (window.MonetizationManager) {
      window.MonetizationManager.onFirstHabitChecked();
    }
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
  // Always open the modal — the gate is checked at save time (in addHabit)
  proceedOpenAddModal();
}

// ─── Premium Upsell Modal ─────────────────────────
let _premiumUpsellOnSuccess = null;
let _premiumUpsellActionType = null;

function showPremiumUpsellModal(actionType, onSuccess) {
  _premiumUpsellOnSuccess = onSuccess;
  _premiumUpsellActionType = actionType;

  const titleEl = document.getElementById('upsell-title');
  const subtitleEl = document.getElementById('upsell-subtitle');
  const adBtn = document.getElementById('btn-upsell-watch-ad');
  let isHardPaywall = false;

  // Map action types to appropriate copy & paywall type
  if (actionType === 'library_full') {
    titleEl.textContent = 'Library Full';
    subtitleEl.textContent = 'Upgrade to Premium to create unlimited journals.';
    isHardPaywall = true;
  } else if (actionType === 'secrets_locked') {
    titleEl.textContent = 'Secure Your Secrets';
    subtitleEl.textContent = 'Upgrade to Premium to lock journals away in your Secrets.';
    isHardPaywall = true;
  } else if (actionType === 'cloud_sync') {
    titleEl.textContent = 'Cloud Backup';
    subtitleEl.textContent = 'Upgrade to Premium to securely backup your data to the cloud.';
    isHardPaywall = true;
  } else if (actionType === 'pdf_export') {
    titleEl.textContent = 'High-Quality Exports';
    subtitleEl.textContent = 'Upgrade to Premium to export your journals as beautiful PDFs.';
  } else if (actionType === 'add_habit') {
    titleEl.textContent = 'Unlock More Intentions';
    subtitleEl.textContent = 'Upgrade to Premium for unlimited intentions, or watch an ad to continue.';
  } else if (actionType === 'profile_banner') {
    titleEl.textContent = 'Unlock Premium';
    subtitleEl.textContent = 'Elevate your journaling experience.';
    isHardPaywall = true;
  } else if (actionType === 'journal_hint_toggle') {
    titleEl.textContent = 'Premium Interface';
    subtitleEl.textContent = 'Upgrade to Premium to customize your workspace and hide hints.';
    isHardPaywall = true;
  } else {
    titleEl.textContent = 'Unlock Premium';
    subtitleEl.textContent = 'Elevate your journaling experience.';
  }

  // Hard paywall: HIDE the "Watch Ad" button entirely — no ad bypass allowed
  if (isHardPaywall && adBtn) {
    adBtn.style.display = 'none';
  } else if (adBtn) {
    adBtn.style.display = 'block';
  }

  document.getElementById('premium-upsell-overlay').classList.remove('hidden');
  triggerHaptic('Medium');
}

function closePremiumUpsellModal() {
  document.getElementById('premium-upsell-overlay').classList.add('hidden');
  _premiumUpsellOnSuccess = null;
  _premiumUpsellActionType = null;
}

// Wire premium upsell buttons (called once during init)
function initPremiumUpsellListeners() {
  // Close button
  document.getElementById('btn-upsell-close')?.addEventListener('click', () => {
    closePremiumUpsellModal();
  });

  // Overlay click to close
  document.getElementById('premium-upsell-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'premium-upsell-overlay') closePremiumUpsellModal();
  });

  // Upgrade to Premium → launch Adapty paywall
  document.getElementById('btn-upsell-upgrade')?.addEventListener('click', async () => {
    const onSuccess = _premiumUpsellOnSuccess;
    const actionType = _premiumUpsellActionType;
    closePremiumUpsellModal();

    if (window.MonetizationManager) {
      const placementId = 'paywall';
      await window.MonetizationManager.launchAdaptyPaywall(
        'paywall',
        null,  // onClose — do nothing, user already saw our modal
        () => { if (onSuccess) onSuccess(); } // onPurchaseSuccess
      );
    }
  });

  // Watch Ad to Continue → play rewarded ad directly (no paywall)
  document.getElementById('btn-upsell-watch-ad')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-loading');

    const onSuccess = _premiumUpsellOnSuccess;
    const actionType = _premiumUpsellActionType;

    if (window.MonetizationManager) {
      await window.MonetizationManager.showRewardedAd(actionType || 'add_habit', () => {
        if (onSuccess) onSuccess();
      });
    }
    
    // Close modal and remove loading state after ad has launched or failed
    closePremiumUpsellModal();
    btn.classList.remove('is-loading');
  });
}

function proceedOpenAddModal() {
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


/**
 * Expands a journal image into a full-screen overlay
 */
function expandJournalImage(src) {
  // Remove any existing overlay first
  const existing = document.getElementById('media-expand-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'media-expand-overlay';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-expand';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => overlay.remove());

  const img = document.createElement('img');
  img.alt = 'Expanded Image';
  img.src = src;   // Safe: set via JS property, not HTML attribute

  overlay.appendChild(closeBtn);
  overlay.appendChild(img);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

/**
 * Smoothly fades out and stops a journal audio element.
 */
function fadeAndStopJournalAudio(playerEl, duration = 400) {
  const audio = playerEl.querySelector('audio');
  if (!audio || audio.paused) return;

  const btn = playerEl.querySelector('.audio-play-btn');
  const icon = btn ? btn.querySelector('.material-symbols-outlined') : null;
  const bar = playerEl.querySelector('.audio-progress-bar');

  // Instant UI feedback for responsiveness
  playerEl.classList.remove('audio-playing');
  if (icon) icon.textContent = 'play_arrow';
  if (bar) bar.style.width = '0%';

  const startVolume = audio.volume;
  const startTime = performance.now();

  function fade() {
    const now = performance.now();
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);

    audio.volume = startVolume * (1 - progress);

    if (progress < 1 && !audio.paused) {
      requestAnimationFrame(fade);
    } else {
      audio.pause();
      audio.currentTime = 0;
      audio.volume = startVolume; // Reset volume for next time it's played
    }
  }

  requestAnimationFrame(fade);
}

/**
 * Stops all playing audio elements and resets their UI with a fade-out.
 */
function formatAudioTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function stopAllJBookAudio(exceptId) {
  document.querySelectorAll('.jbook-audio-player').forEach(player => {
    const audio = player.querySelector('audio');
    if (audio && audio.id !== exceptId && !audio.paused) {
      fadeAndStopJournalAudio(player);
    }
  });
}

/**
 * Toggles audio playback for a jbook audio player.
 */
function toggleJBookAudioPlayer(playerEl) {
  const audio = playerEl.querySelector('audio');
  if (!audio) return;

  const btn = playerEl.querySelector('.audio-play-btn');
  const icon = btn ? btn.querySelector('.material-symbols-outlined') : null;
  const bar = playerEl.querySelector('.audio-progress-bar');

  if (audio.paused) {
    stopAllJBookAudio(audio.id);
    audio.play().catch(err => console.warn('Audio play failed:', err));
    playerEl.classList.add('audio-playing');
    if (icon) icon.textContent = 'pause';

    const scrubber = playerEl.querySelector('.audio-scrubber');
    const curTimeLabel = playerEl.querySelector('.audio-current-time');

    audio.ontimeupdate = () => {
      if (audio.duration && bar) {
        bar.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        if (curTimeLabel) curTimeLabel.textContent = formatAudioTime(audio.currentTime);
      }
    };
    audio.onended = () => {
      playerEl.classList.remove('audio-playing');
      if (icon) icon.textContent = 'play_arrow';
      if (bar) bar.style.width = '0%';
    };
  } else {
    fadeAndStopJournalAudio(playerEl);
  }
}

/**
 * Renders media attachments (images/audio) as a DOM element.
 * Returns null if there is no media to render.
 */
function renderMediaToBlock(item) {
  const hasImages = item.images && item.images.length > 0;
  const hasAudio  = item.audio  && item.audio.data;
  if (!hasImages && !hasAudio) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'jbook-media-section';

  // ── Image Gallery ──
  if (hasImages) {
    const grid = document.createElement('div');
    grid.className = 'jbook-image-grid';
    // Adjust grid for narrow book pages
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:8px;';
    item.images.forEach((imgSrc, idx) => {
      const frame = document.createElement('div');
      frame.className = 'jbook-photo-frame';
      frame.title = `Photo ${idx + 1} — tap to expand`;

      const img = document.createElement('img');
      img.alt = `Attachment ${idx + 1}`;
      img.src = imgSrc;  // Safe JS property assignment
      img.decoding = 'async'; // Offload decoding to background thread for smoothness
      // Do NOT use loading='lazy' — PageFlip renders pages off-screen
      // and lazy loading prevents images from ever appearing

      frame.appendChild(img);
      // Event listener — no inline handler, no base64 in HTML
      frame.addEventListener('click', (e) => { e.stopPropagation(); expandJournalImage(imgSrc); });
      grid.appendChild(frame);
    });
    wrapper.appendChild(grid);
  }

  // ── Audio Player ──
  if (hasAudio) {
    const player = document.createElement('div');
    player.className = 'jbook-audio-player';

    const playBtn = document.createElement('button');
    playBtn.className = 'audio-play-btn';
    playBtn.setAttribute('aria-label', 'Play voice note');
    playBtn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span>';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'audio-info';
    infoDiv.innerHTML = `
      <div class="audio-progress-container" title="Tap to seek">
        <div class="audio-progress-bar"></div>
      </div>
      <div class="audio-time-row">
        <span class="audio-current-time">0:00</span>
        <span class="audio-duration">0:00</span>
      </div>`;

    const audioEl = document.createElement('audio');
    audioEl.src = item.audio.data;  // Safe JS property — no HTML attribute
    audioEl.preload = 'metadata';   // Load metadata so duration is available

    player.appendChild(playBtn);
    player.appendChild(infoDiv);
    player.appendChild(audioEl);

    // Setup scrubber & time listeners
    const container = player.querySelector('.audio-progress-container');
    const curTimeLabel = player.querySelector('.audio-current-time');
    const durLabel = player.querySelector('.audio-duration');
    const bar = player.querySelector('.audio-progress-bar');

    audioEl.onloadedmetadata = () => {
      durLabel.textContent = formatAudioTime(audioEl.duration);
    };

    if (audioEl.readyState >= 1) {
      durLabel.textContent = formatAudioTime(audioEl.duration);
    }

    container.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!audioEl.duration) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      audioEl.currentTime = percent * audioEl.duration;
      if (bar) bar.style.width = `${percent * 100}%`;
      curTimeLabel.textContent = formatAudioTime(audioEl.currentTime);
    });

    // Wire the play button to the player-level toggle
    playBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleJBookAudioPlayer(player); });

    wrapper.appendChild(player);
  }

  return wrapper;
}


// Saves the new habit directly (called after gate check passes)
function saveNewHabit(name, desc, icon, schedule) {
  const newHabit = {
    id: uid(),
    name,
    desc,
    icon,
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

  // Premium users always save directly — no gates
  if (window.MonetizationManager && window.MonetizationManager.isPremiumUser()) {
    saveNewHabit(name, desc, selectedIcon, schedule);
    return;
  }

  // One-time intentions are always free — no gate applied
  if (schedule.type === 'onetime') {
    saveNewHabit(name, desc, selectedIcon, schedule);
    return;
  }

  // Count only recurring (non-onetime) habits against the free limit
  const recurringCount = habits.filter(h => !h.schedule || h.schedule.type !== 'onetime').length;

  // Free users: allow up to 10 recurring intentions, then soft-paywall (ads allowed)
  if (!window.MonetizationManager || window.MonetizationManager.canAddHabit(recurringCount)) {
    saveNewHabit(name, desc, selectedIcon, schedule);
    return;
  }

  // Over the limit — show upsell with "Watch Ad" option (soft paywall)
  showPremiumUpsellModal('add_habit', () => {
    saveNewHabit(name, desc, selectedIcon, schedule);
  });
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
  // --- Performance Guard ---
  // If the book is currently flipping, queue a re-render for after it finishes
  if (isJournalFlipping) {
    pendingJournalRender = true;
    return;
  }
  pendingJournalRender = false;

  const label    = document.getElementById('journal-date-label');
  const textarea = document.getElementById('journal-textarea');
  let bookWrapper = document.getElementById('journal-book-wrapper');
  if (!bookWrapper) {
    const section = document.getElementById('journal-book-section');
    if (section) {
      bookWrapper = document.createElement('div');
      bookWrapper.className = 'journal-book-wrapper';
      bookWrapper.id = 'journal-book-wrapper';
      section.appendChild(bookWrapper);
    }
  }
  
  const d = parseDate(selectedDate);
  label.textContent = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  textarea.value = ''; // Always empty for new entry
  textarea.placeholder = `Begin writing...`;

  // Collect all journal dates that have content
  const activeJournal = getActiveJournal();
  const allSortedDates = Object.entries(activeJournal)
    .filter(([_, items]) => Array.isArray(items) && items.some(i => (i.text && i.text.trim()) || (i.images && i.images.length > 0) || i.audio))
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));

  // --- Windowed Rendering Logic (15-day window) ---
  // This prevents DOM bloat and keeps the app lightweight.
  const selectedIndex = allSortedDates.indexOf(selectedDate);
  const windowRange   = 7; // Current date + 7 before + 7 after = 15 dates total
  
  let windowStart = 0;
  let windowEnd   = allSortedDates.length - 1;

  if (selectedIndex !== -1) {
    windowStart = Math.max(0, selectedIndex - windowRange);
    windowEnd   = Math.min(allSortedDates.length - 1, selectedIndex + windowRange);
  } else if (allSortedDates.length > 0) {
    // If selectedDate has no entry, show the last page
    windowStart = Math.max(0, allSortedDates.length - (windowRange * 2));
    windowEnd = allSortedDates.length - 1;
  }

  const windowedDates = allSortedDates.slice(windowStart, windowEnd + 1);
  const relativeSelectedIndex = windowedDates.indexOf(selectedDate);
    
  const pagesArray = [];
  
  
  // Cover Page — Dynamic from active book
  const activeBook = journalBooks.find(b => b.id === activeBookId) || journalBooks[0];
  const coverPage = document.createElement('div');
  coverPage.className = 'jbook-page jbook-page-cover';
  coverPage.setAttribute('data-density', 'hard');
  coverPage.innerHTML = renderCoverHTML(activeBook);
  pagesArray.push(coverPage);

  if (windowedDates.length === 0) {
    const blankBackside = document.createElement('div');
    blankBackside.className = 'jbook-page jbook-empty-page';
    blankBackside.innerHTML = `<div class="jbook-page-content" style="height:100%;"></div>`;
    pagesArray.push(blankBackside);

    const introPage = document.createElement('div');
    introPage.className = 'jbook-page';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'jbook-page-content';
    
    const dateHeader = document.createElement('div');
    dateHeader.className = 'journal-entry-date';
    dateHeader.textContent = d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
    contentDiv.appendChild(dateHeader);

    if (activeBookId === DEFAULT_BOOK_ID) {
      const block = document.createElement('div');
      block.className = 'journal-entry-block system-entry';
      block.style.padding = '10px 16px 10px 48px';
      block.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
          <span style="font-family: var(--font-display); font-size: 11px; font-style: italic; color: #7a6852; opacity: 0.6;">— entry i</span>
        </div>
        <div class="journal-entry-body">${SYSTEM_INTRO_ENTRY.text}</div>
      `;
      const mediaEl = renderMediaToBlock(SYSTEM_INTRO_ENTRY);
      if (mediaEl) block.appendChild(mediaEl);
      contentDiv.appendChild(block);
      
      const endMark = document.createElement('div');
      endMark.className = 'journal-end-mark';
      endMark.innerHTML = '·&nbsp;&nbsp;·&nbsp;&nbsp;·';
      contentDiv.appendChild(endMark);
    } else {
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'padding: 40px 20px; text-align: center; opacity: 0.4; font-style: italic; font-size: 13px;';
      placeholder.textContent = 'Your story begins here...';
      contentDiv.appendChild(placeholder);
    }

    introPage.appendChild(contentDiv);
    
    const pageNum = document.createElement('div');
    pageNum.className = 'jbook-page-number';
    pageNum.textContent = "1";
    introPage.appendChild(pageNum);
    
    pagesArray.push(introPage);
  } else {
    windowedDates.forEach((key) => {
      // Blank left side (backside of previous leaf)
      const blankBackside = document.createElement('div');
      blankBackside.className = 'jbook-page jbook-empty-page';
      blankBackside.innerHTML = `<div class="jbook-page-content" style="height:100%;"></div>`;
      pagesArray.push(blankBackside);

      const pageDate = parseDate(key);
      const dayEntries = activeJournal[key] || [];

      const pageDiv = document.createElement('div');
      pageDiv.className = 'jbook-page';

      const contentDiv = document.createElement('div');
      contentDiv.className = 'jbook-page-content';

      const dateHeader = document.createElement('div');
      dateHeader.className = 'journal-entry-date';
      dateHeader.textContent = pageDate.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
      contentDiv.appendChild(dateHeader);

      const sortedDayItems = [...dayEntries]
        .map((item, originalIndex) => ({ ...item, originalIndex }))
        .filter(i => (i.text && i.text.trim()) || (i.images && i.images.length > 0) || i.audio);

      // Prepend system intro only on the first ever page of the INITIAL book
      if (activeBookId === DEFAULT_BOOK_ID && allSortedDates.indexOf(key) === 0) {
        sortedDayItems.unshift({ ...SYSTEM_INTRO_ENTRY, originalIndex: -1 });
      }

      sortedDayItems.sort((a, b) => a.ts - b.ts);

      sortedDayItems.forEach((item, idx) => {
        const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase() : '';
        const isLast = idx === sortedDayItems.length - 1;

        const block = document.createElement('div');
        block.className = 'journal-entry-block';
        block.setAttribute('role', 'button');
        block.setAttribute('tabindex', '0');
        block.style.padding = '10px 16px 10px 48px';
        if (!isLast) block.style.borderBottom = '1px solid rgba(139,119,92,0.06)';

        block.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
            <span style="font-family: var(--font-display); font-size: 11px; font-style: italic; color: #7a6852; opacity: 0.6;">— ${timeStr}</span>
          </div>
          ${item.text && item.text.trim() ? `<div class="journal-entry-body">${escapeHtml(item.text)}</div>` : ''}
        `;
        const mediaEl = renderMediaToBlock(item);
        if (mediaEl) block.appendChild(mediaEl);

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
          if (journalLongPressTriggered || item.isSystem) return;
          openHistoryModal(key, item.text, null, item.originalIndex);
        });

        block.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); block.click(); }
        });

        contentDiv.appendChild(block);
      });

      const endMark = document.createElement('div');
      endMark.className = 'journal-end-mark';
      endMark.innerHTML = '·&nbsp;&nbsp;·&nbsp;&nbsp;·';
      contentDiv.appendChild(endMark);

      contentDiv.addEventListener('touchmove', (e) => {
        const isVertical = Math.abs(e.touches[0].clientY - (this._lastTouchY || 0)) > Math.abs(e.touches[0].clientX - (this._lastTouchX || 0));
        if (isVertical) e.stopPropagation();
      }, { passive: true });
      contentDiv.addEventListener('touchstart', (e) => {
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;
      }, { passive: true });
      contentDiv.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });

      pageDiv.appendChild(contentDiv);

      const pageNum = document.createElement('div');
      pageNum.className = 'jbook-page-number';
      // Use global index for page numbers to keep history consistent
      pageNum.textContent = allSortedDates.indexOf(key) + 1;
      pageDiv.appendChild(pageNum);

      pagesArray.push(pageDiv);
    });
  }

  // --- Append 3 Quote Pages ---
  const quotes = [
    { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Aristotle" },
    { text: "The unexamined life is not worth living.", author: "Socrates" },
    { text: "Every action you take is a vote for the type of person you wish to become.", author: "James Clear" }
  ];

  quotes.forEach(quote => {
    const blankBackside = document.createElement('div');
    blankBackside.className = 'jbook-page jbook-empty-page';
    blankBackside.innerHTML = `<div class="jbook-page-content" style="height:100%;"></div>`;
    pagesArray.push(blankBackside);

    const quotePage = document.createElement('div');
    quotePage.className = 'jbook-page quotes-page';
    quotePage.innerHTML = `
      <div class="jbook-page-content" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; text-align:center; padding: 0 40px; box-sizing: border-box; background-image: none !important;">
        <div style="font-family:'Cormorant Garamond', 'Newsreader', serif; font-size: 18px; font-style: italic; color: #5a4a38; line-height: 1.6; margin-bottom: 16px;">
          "${quote.text}"
        </div>
        <div style="font-family:'Cormorant Garamond', 'Newsreader', serif; font-size: 14px; font-weight: 500; color: #8a7862; letter-spacing: 1px; text-transform: uppercase;">
          — ${quote.author}
        </div>
      </div>
    `;
    pagesArray.push(quotePage);
  });

  if (pagesArray.length % 2 !== 0) {
    const fillerPage = document.createElement('div');
    fillerPage.className = 'jbook-page jbook-empty-page';
    fillerPage.innerHTML = `<div class="jbook-page-content" style="display:flex; justify-content:center; align-items:center; height:100%;"></div>`;
    pagesArray.push(fillerPage);
  }

  // Back Cover
  const backCover = document.createElement('div');
  backCover.className = 'jbook-page jbook-page-cover';
  backCover.setAttribute('data-density', 'hard');
  backCover.innerHTML = `
    <div class="jbook-page-content" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; text-align:center;">
      <div style="font-family:'Cormorant Garamond', 'Newsreader', serif; font-size:12px; color:rgba(201,168,76,0.4); letter-spacing: 3px;">✦</div>
      <p style="font-family:'Cormorant Garamond', 'Newsreader', serif; font-size:9px; font-weight:400; color:rgba(201,168,76,0.3); letter-spacing: 3px; text-transform:uppercase; margin-top:8px;">A.V.</p>
    </div>
  `;
  pagesArray.push(backCover);

  if (bookWrapper) {
    // Helper to flip to the correct date
    const flipToTarget = () => {
      if (!journalPageFlip) return;
      try {
        const finalFlipTarget = relativeSelectedIndex >= 0 ? (relativeSelectedIndex * 2) + 2 : 2;
        journalPageFlip.flip(finalFlipTarget);
      } catch(e) {}
    };

    if (journalPageFlip && document.getElementById('screen-journal').classList.contains('active')) {
      try {
        // Recalculate dimensions
        let bookWidth = window.innerWidth - 48;
        if (bookWidth > 340) bookWidth = 340;
        let bookHeight = 420;

        bookWrapper.style.minHeight = bookHeight + 'px';
        bookWrapper.style.minWidth = (bookWidth * 2) + 'px';
        bookWrapper.style.transform = `translateX(-${bookWidth / 2}px)`;

        journalPageFlip.updateFromHtml(pagesArray);
        
        // Force PageFlip to recalculate its internal layout
        if (typeof journalPageFlip.update === 'function') {
          journalPageFlip.update();
        }

        // Sync with next frame for buttery transition
        requestAnimationFrame(flipToTarget);
        return; 
      } catch(err) {
        console.error("journalPageFlip update failed, falling back to full initialization", err);
        try { journalPageFlip.destroy(); } catch(e) {}
        journalPageFlip = null;
      }
    }

    // Double-rAF guarantees the browser has completed one full layout + paint
    // cycle before we proceed. This replaces the fragile rAF + setTimeout(50ms)
    // approach which could lose the race on slower devices.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!document.getElementById('screen-journal').classList.contains('active')) return;

        // Calculate dimensions
        let bookWidth, bookHeight;
        bookWidth = window.innerWidth - 48;
        if (bookWidth > 340) bookWidth = 340;
        bookHeight = 420;

        try {
          if (!journalPageFlip) {
            const parent = bookWrapper.parentNode;
            const newWrapper = document.createElement('div');
            newWrapper.className = 'journal-book-wrapper';
            newWrapper.id = 'journal-book-wrapper';
            parent.replaceChild(newWrapper, bookWrapper);
            bookWrapper = newWrapper;
            
            // Set dimensions BEFORE creating PageFlip (prevents layout shift)
            bookWrapper.style.minHeight = bookHeight + 'px';
            bookWrapper.style.minWidth = (bookWidth * 2) + 'px';
            bookWrapper.style.transform = `translateX(-${bookWidth / 2}px)`;

            journalPageFlip = new PageFlip(bookWrapper, {
              width: bookWidth, 
              height: bookHeight,
              size: 'fixed',
              minWidth: 50,
              maxWidth: 1200,
              minHeight: 100,
              maxHeight: 2000,
              usePortrait: false, 
              maxShadowOpacity: 0.15,
              showCover: true,
              mobileScrollSupport: true,
              disableFlipByClick: true,
              flippingTime: 600,
              drawShadow: true
            });

            // Bind high-FPS event guards + animation-state CSS class
            journalPageFlip.on('flip', (e) => {
              isJournalFlipping = true;
              bookWrapper.classList.add('jbook-flipping');
              // Stop all audio on page flip
              stopAllJBookAudio(null);
            });
            journalPageFlip.on('finishFlip', (e) => {
              isJournalFlipping = false;
              // Defer class removal to next frame to avoid mid-composite reflow
              requestAnimationFrame(() => {
                bookWrapper.classList.remove('jbook-flipping');
              });
              // If a render was queued during the flip, execute it now
              if (pendingJournalRender) {
                pendingJournalRender = false;
                renderJournal();
              }
            });

            journalPageFlip.loadFromHTML(pagesArray);
            
            // Set up ResizeObserver to handle layout shifts robustly
            if (!window.journalResizeObserver) {
              window.journalResizeObserver = new ResizeObserver(() => {
                if (currentScreen !== 'journal' || !journalPageFlip) return;
                try {
                  const bw = document.getElementById('journal-book-wrapper');
                  if (bw) {
                    let w;
                    let sX = 0;
                    w = window.innerWidth - 48;
                    if (w > 340) w = 340;
                    sX = -w / 2;
                    bw.style.minWidth = (w * 2) + 'px';
                    bw.style.transform = sX !== 0 ? `translateX(${sX}px)` : 'none';
                    if (typeof journalPageFlip.update === 'function') {
                      journalPageFlip.update();
                    }
                  }
                } catch(e) {}
              });
              const section = document.getElementById('journal-book-section');
              if (section) window.journalResizeObserver.observe(section);
            }
            
            // Reveal only AFTER PageFlip has measured and painted
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                bookWrapper.classList.add('ready');
              });
            });
          }
          
          // Final sync flip
          setTimeout(flipToTarget, 500); 
        } catch(err) {
          console.error("PageFlip init error:", err);
        }
      });
    });
  }
}

async function deleteJournalEntry(key, index, type = 'journal', habitId = null) {
  if (index === -1) return; // Protect system entries
  const confirmed = await showConfirm(
    "Erase this passage?",
    `Once erased, these words cannot be recovered.`,
    "Erase",
    true
  );

  if (confirmed) {
    if (type === 'journal') {
      const activeJournal = getActiveJournal();
      if (activeJournal[key] && activeJournal[key][index]) {
        activeJournal[key].splice(index, 1);
        if (activeJournal[key].length === 0) delete activeJournal[key];
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
    
    // Refresh whichever view is currently active — force-reset flip state so render goes through
    if (currentScreen === 'journal') {
      isJournalFlipping = false;
      pendingJournalRender = false;
      const bw = document.getElementById('journal-book-wrapper');
      if (bw) bw.classList.remove('jbook-flipping');
      renderJournal();
    }
    if (currentScreen === 'today') renderHabits(); // if detail is open, it might need refreshing
    
    // Specifically refresh archive if open
    const archiveOverlay = document.getElementById('archive-modal-overlay');
    if (archiveOverlay && !archiveOverlay.classList.contains('hidden')) {
      renderJournalArchive();
    }

    showToast("Passage erased.");
    if (notifSettings.hapticsEnabled) {
      try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(err) {}
    }
  }
}

function saveJournal() {
  const textarea = document.getElementById('journal-textarea');
  const text = textarea.value.trim();
  const media = currentAttachments.journal;

  if (text || (media && (media.images.length > 0 || media.audio))) {
    const activeJournal = getActiveJournal();
    if (!Array.isArray(activeJournal[selectedDate])) activeJournal[selectedDate] = [];
    
    activeJournal[selectedDate].push({ 
      text, 
      ts: Date.now(),
      images: media.images.length > 0 ? [...media.images] : undefined,
      audio: media.audio ? { ...media.audio } : undefined
    });

    save();
    showToast('Commitment made.');
    resetMediaAttachments('journal');
    textarea.value = '';
    // Force-reset flip state so the render always goes through with fresh content
    isJournalFlipping = false;
    pendingJournalRender = false;
    const bw = document.getElementById('journal-book-wrapper');
    if (bw) bw.classList.remove('jbook-flipping');
    renderJournal();
  }
}

// Add global keyboard tracking via Visual Viewport API
document.addEventListener('DOMContentLoaded', () => {
  if (window.visualViewport) {
    let originalHeight = window.innerHeight;
    
    window.visualViewport.addEventListener('resize', () => {
      const currentHeight = window.visualViewport.height;
      // Detect keyboard if viewport height drops significantly (e.g. > 15%)
      const isKeyboardVisible = currentHeight < originalHeight * 0.85;
      
      if (isKeyboardVisible) {
        document.body.classList.add('keyboard-visible');
      } else {
        document.body.classList.remove('keyboard-visible');
        // Reset scroll positions
        const jMain = document.querySelector('.journal-main');
        if (jMain) jMain.scrollTop = 0;
        window.scrollTo(0, 0);
      }
    });

    // Handle orientation changes or other height updates
    window.addEventListener('resize', () => {
      // Small delay to let the innerHeight stabilize after rotation
      setTimeout(() => {
        if (window.visualViewport.height > window.innerHeight * 0.9) {
          originalHeight = window.innerHeight;
        }
      }, 100);
    });
  }
});

// ─── Expanded Journal Modal ──────────────────────
function openExpandedJournal() {
  const textarea = document.getElementById('journal-textarea');
  const expandedTextarea = document.getElementById('journal-expanded-textarea');
  if (textarea && expandedTextarea) {
    expandedTextarea.value = textarea.value;
    document.getElementById('journal-expanded-modal').classList.remove('hidden');
    setTimeout(() => expandedTextarea.focus(), 100);
  }
}

function closeExpandedJournal() {
  const modal = document.getElementById('journal-expanded-modal');
  if (modal) modal.classList.add('hidden');
}

function saveExpandedJournal() {
  const textarea = document.getElementById('journal-textarea');
  const expandedTextarea = document.getElementById('journal-expanded-textarea');
  if (textarea && expandedTextarea) {
    textarea.value = expandedTextarea.value;
    closeExpandedJournal();
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

  const source = habitId ? habitJournal[habitId] : getActiveJournal();
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
window.updateProfilePremiumBanner = function() {
  const banner = document.getElementById('profile-premium-banner');
  const title = document.getElementById('profile-banner-title');
  const desc = document.getElementById('profile-banner-desc');
  
  if (!banner) return;

  const isPremium = window.MonetizationManager ? window.MonetizationManager.isPremiumUser() : false;

  if (isPremium) {
    banner.classList.add('is-premium');
    title.textContent = 'Telos Premium Active';
    desc.textContent = 'Thank you for supporting Telos.';
  } else {
    banner.classList.remove('is-premium');
    title.textContent = 'Unlock Telos Premium';
    desc.textContent = 'Unlimited intentions, ad-free experience, & secret journals.';
  }
};

// Initialize Profile Premium Banner Click Handler
window.handleProfileBannerClick = function() {
  console.log('[Monetization] Profile Banner Clicked!');
  const isPremium = window.MonetizationManager ? window.MonetizationManager.isPremiumUser() : false;
  if (!isPremium && window.MonetizationManager) {
    // Try to show the Adapty paywall first, which falls back to HTML modal
    window.MonetizationManager.showUpsellModal('profile_banner');
  } else if (!isPremium && typeof showPremiumUpsellModal === 'function') {
    showPremiumUpsellModal('profile_banner');
  } else if (isPremium && window.Capacitor && window.Capacitor.Plugins.Haptics) {
    // Just a little bump if they click it while already premium
    window.Capacitor.Plugins.Haptics.impact({ style: 'light' }).catch(()=>{});
  }
};

// Listen for premium state changes (from purchases or restores)
document.addEventListener('premiumStateChanged', () => {
  if (window.updateProfilePremiumBanner) {
    window.updateProfilePremiumBanner();
  }
});
function renderProfile() {
  if (window.updateProfilePremiumBanner) window.updateProfilePremiumBanner();
  
  document.getElementById('stat-total').textContent = habits.length;

  const todayStr = todayKey();
  const dayLogs = logs[todayStr] || {};
  const todayVisible = habits.filter(h => shouldShowHabit(h, todayStr));
  const doneToday = todayVisible.filter(h => dayLogs[h.id]).length;
  document.getElementById('stat-completed-today').textContent = doneToday;

  // Streak: consecutive days where all SCHEDULED habits are done
  let streak = 0;
  const d = new Date();
  const earliestDate = habits.reduce((min, h) => (h.createdAt && h.createdAt < min ? h.createdAt : min), todayStr);
  let lookbackLimit = 365; // Don't go back more than a year

  while (lookbackLimit > 0) {
    const k = dateKey(d);
    if (k < earliestDate) break;

    const dayLog = logs[k] || {};
    const scheduled = habits.filter(h => shouldShowHabit(h, k));
    
    if (scheduled.length === 0) {
      // No habits scheduled — skip this day, don't break streak
      d.setDate(d.getDate() - 1);
      lookbackLimit--;
      continue;
    }

    const doneCount = scheduled.filter(h => dayLog[h.id]).length;
    if (doneCount > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
      lookbackLimit--;
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
  // Update current theme label
  const currentTheme = THEMES[notifSettings.theme] || THEMES.midnight;
  const themeLabel = document.getElementById('current-theme-label');
  if (themeLabel) themeLabel.textContent = currentTheme.name;
  document.getElementById('toggle-haptics').checked = notifSettings.hapticsEnabled !== false;
  document.getElementById('toggle-journal-hint').checked = notifSettings.showJournalHint !== false;
}

function applyTheme() {
  // Migrate legacy 'dark'/'light' values to new theme IDs
  notifSettings.theme = migrateLegacyTheme(notifSettings.theme);
  
  const theme = applyThemeEngine(notifSettings.theme);
  
  // Update Capacitor status bar
  try {
    StatusBar.setStyle({ style: theme.statusBarStyle === 'Dark' ? Style.Dark : Style.Light });
  } catch(e) {}
  
  // Update current theme label in profile menu
  const themeLabel = document.getElementById('current-theme-label');
  if (themeLabel) themeLabel.textContent = theme.name;
}

function renderThemePicker() {
  const groups = getThemesByCategory();
  const darkGrid = document.getElementById('theme-grid-dark');
  const lightGrid = document.getElementById('theme-grid-light');
  if (!darkGrid || !lightGrid) return;
  
  const currentThemeId = notifSettings.theme;
  
  darkGrid.innerHTML = '';
  lightGrid.innerHTML = '';
  
  groups.dark.forEach(theme => {
    const card = createThemeCard(theme, theme.id === currentThemeId);
    card.addEventListener('click', () => selectTheme(theme.id));
    darkGrid.appendChild(card);
  });
  
  groups.light.forEach(theme => {
    const card = createThemeCard(theme, theme.id === currentThemeId);
    card.addEventListener('click', () => selectTheme(theme.id));
    lightGrid.appendChild(card);
  });
}

function selectTheme(themeId) {
  notifSettings.theme = themeId;
  save();
  applyTheme();
  renderThemePicker(); // Re-render to update active state
  try { Haptics.impact({ style: ImpactStyle.Light }); } catch(err) {}
}

// ─── Book Catalog / Switcher ───────────────
function openBookCatalog() {
  renderBookCatalog();
  document.getElementById('book-catalog-overlay').classList.remove('hidden');
}

function closeBookCatalog() {
  const overlay = document.getElementById('book-catalog-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;

  // Add closing state to trigger CSS animations
  overlay.classList.add('closing');

  // Wait for the animation to finish (matching the 0.3s CSS duration)
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('closing');
  }, 250); 
}

function renderBookCatalog() {
  const grid = document.getElementById('book-catalog-grid');
  if (!grid) return;
  grid.innerHTML = '';
  
  const visibleBooks = journalBooks.filter(b => !b.isHidden);
  const hiddenBooks = journalBooks.filter(b => b.isHidden);
  
  // 1. Render Visible Books
  visibleBooks.forEach(book => {
    const count = countBookEntries(journal, book.id);
    const card = createBookCard(book, book.id === activeBookId, count);
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      switchBook(book.id);
    });
    grid.appendChild(card);
  });
  
  // 2. Render Secrets Card vs Hidden Journals
  if (!isSecretsUnlocked) {
    const secretsCard = document.createElement('div');
    secretsCard.className = 'book-card secrets-card';
    secretsCard.innerHTML = `
      <div class="book-card-spine" style="background:var(--card-bg);">
        <div class="book-card-cover">
          <span class="material-symbols-outlined">lock</span>
          <p class="book-card-title">Secrets</p>
        </div>
      </div>
      <div class="book-card-info">
        <p class="book-card-name">Secrets</p>
        <p class="book-card-meta">${hiddenBooks.length} hidden</p>
      </div>
    `;
    secretsCard.addEventListener('click', (e) => {
      e.stopPropagation();
      openPasscodeModal(getStoredPasscode() ? 'verify' : 'setup');
    });
    grid.appendChild(secretsCard);
  } else {
    const divider = document.createElement('div');
    divider.className = 'hidden-journals-divider';
    divider.style.display = 'flex';
    divider.style.justifyContent = 'space-between';
    divider.style.alignItems = 'center';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Hidden Journals';

    const lockBtn = document.createElement('button');
    lockBtn.className = 'btn-lock-secrets';
    lockBtn.style.cssText = 'background: var(--pure-white, #fff); border: 1px solid var(--greige, #e5e3df); color: var(--charcoal, #2a2a2a); display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; cursor: pointer; padding: 6px 12px; border-radius: 16px; box-shadow: var(--shadow-subtle); transition: transform 0.1s; outline: none;';
    
    // Add touch feedback
    lockBtn.addEventListener('mousedown', () => lockBtn.style.transform = 'scale(0.95)');
    lockBtn.addEventListener('mouseup', () => lockBtn.style.transform = 'scale(1)');
    lockBtn.addEventListener('mouseleave', () => lockBtn.style.transform = 'scale(1)');
    lockBtn.addEventListener('touchstart', () => lockBtn.style.transform = 'scale(0.95)');
    lockBtn.addEventListener('touchend', () => lockBtn.style.transform = 'scale(1)');
    
    const lockIcon = document.createElement('div');
    lockIcon.style.display = 'flex';
    lockIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
    
    const lockText = document.createElement('span');
    lockText.textContent = 'Lock Secrets';
    
    lockBtn.appendChild(lockIcon);
    lockBtn.appendChild(lockText);
    
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isSecretsUnlocked = false;
      
      // If the active book is hidden, switch to the first visible book
      const activeBookObj = journalBooks.find(b => b.id === activeBookId);
      if (activeBookObj && activeBookObj.isHidden) {
        const firstVisible = journalBooks.find(b => !b.isHidden);
        if (firstVisible) {
          activeBookId = firstVisible.id;
          save();
          applyBookColors();
          isJournalFlipping = false;
          pendingJournalRender = false;
          const bw = document.getElementById('journal-book-wrapper');
          if (bw) bw.classList.remove('jbook-flipping');
          renderJournal();
        }
      }
      
      renderBookCatalog();
      showToast('Secrets locked.');
      try { Haptics.impact({ style: ImpactStyle.Light }); } catch(err) {}
    });

    divider.appendChild(titleSpan);
    divider.appendChild(lockBtn);
    grid.appendChild(divider);
    
    if (hiddenBooks.length > 0) {
      hiddenBooks.forEach(book => {
        const count = countBookEntries(journal, book.id);
        const card = createBookCard(book, book.id === activeBookId, count);
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          switchBook(book.id);
        });
        grid.appendChild(card);
      });
    } else {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'empty-secrets-message';
      emptyMsg.innerHTML = 'Your secrets are safe here.<br>Move a journal to Secrets to keep it private.';
      grid.appendChild(emptyMsg);
    }
  }
}

// ─── Passcode Modal Logic ───────────────
function getStoredPasscode() {
  return localStorage.getItem('telos_passcode'); // null if never set
}

function openPasscodeModal(mode = 'verify') {
  passcodeMode = mode;
  passcodeEntry = '';
  passcodeTempCode = (mode === 'confirm') ? passcodeTempCode : '';
  updatePasscodeDots();

  const titleEl = document.querySelector('.passcode-title');
  const subtitleEl = document.querySelector('.passcode-subtitle');

  switch (mode) {
    case 'setup':
      titleEl.textContent = 'Create Your Passcode';
      subtitleEl.textContent = 'Choose a 4-digit code';
      break;
    case 'confirm':
      titleEl.textContent = 'Confirm Your Passcode';
      subtitleEl.textContent = 'Re-enter to verify';
      break;
    case 'change_verify':
      titleEl.textContent = 'Enter Current Passcode';
      subtitleEl.textContent = 'Verify to change';
      break;
    default: // 'verify'
      titleEl.textContent = 'Enter Passcode';
      subtitleEl.textContent = 'Unlock your secrets';
  }

  document.getElementById('passcode-overlay').classList.remove('hidden');
}

function closePasscodeModal() {
  document.getElementById('passcode-overlay').classList.add('hidden');
  passcodeEntry = '';
  passcodeMode = 'verify';
  passcodeTempCode = '';
}

function updatePasscodeDots() {
  const dots = document.querySelectorAll('.passcode-dot');
  dots.forEach((dot, index) => {
    dot.classList.remove('error');
    if (index < passcodeEntry.length) dot.classList.add('filled');
    else dot.classList.remove('filled');
  });
}

function handlePasscodeError() {
  try { Haptics.impact({ style: ImpactStyle.Heavy }); } catch(e) {}
  const dots = document.querySelectorAll('.passcode-dot');
  dots.forEach(dot => {
    if (dot.classList.contains('filled')) dot.classList.add('error');
  });
  const keypad = document.querySelector('.passcode-modal');
  if (keypad) {
    keypad.classList.add('shake');
    setTimeout(() => {
      keypad.classList.remove('shake');
      passcodeEntry = '';
      updatePasscodeDots();
    }, 400);
  }
}

function handlePasscodeComplete() {
  switch (passcodeMode) {
    case 'setup':
      // Store temporarily and ask to confirm
      passcodeTempCode = passcodeEntry;
      passcodeEntry = '';
      updatePasscodeDots();
      // Brief delay so the user sees all dots filled
      setTimeout(() => openPasscodeModal('confirm'), 200);
      break;

    case 'confirm':
      if (passcodeEntry === passcodeTempCode) {
        // Match — save and unlock
        localStorage.setItem('telos_passcode', passcodeEntry);
        try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(e) {}
        showToast('Passcode set successfully ✓');
        isSecretsUnlocked = true;
        closePasscodeModal();
        renderBookCatalog();
      } else {
        // Mismatch — restart setup
        handlePasscodeError();
        setTimeout(() => {
          showToast('Codes didn\'t match — try again');
          openPasscodeModal('setup');
        }, 500);
      }
      break;

    case 'change_verify':
      if (passcodeEntry === getStoredPasscode()) {
        // Current passcode correct — proceed to setup new one
        try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(e) {}
        passcodeEntry = '';
        updatePasscodeDots();
        setTimeout(() => openPasscodeModal('setup'), 200);
      } else {
        handlePasscodeError();
      }
      break;

    default: // 'verify'
      if (passcodeEntry === getStoredPasscode()) {
        isSecretsUnlocked = true;
        try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(e) {}
        closePasscodeModal();
        renderBookCatalog();
      } else {
        handlePasscodeError();
      }
  }
}

document.querySelectorAll('.keypad-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (e.currentTarget.classList.contains('keypad-action')) return;
    try { Haptics.impact({ style: ImpactStyle.Light }); } catch(e) {}
    
    const val = e.currentTarget.dataset.val;
    if (val !== undefined && passcodeEntry.length < 4) {
      passcodeEntry += val;
      updatePasscodeDots();
      
      if (passcodeEntry.length === 4) {
        handlePasscodeComplete();
      }
    }
  });
});

document.getElementById('btn-passcode-delete')?.addEventListener('click', () => {
  if (passcodeEntry.length > 0) {
    try { Haptics.impact({ style: ImpactStyle.Light }); } catch(e) {}
    passcodeEntry = passcodeEntry.slice(0, -1);
    updatePasscodeDots();
  }
});

document.getElementById('btn-passcode-cancel')?.addEventListener('click', () => {
  closePasscodeModal();
});

function switchBook(bookId) {
  if (bookId === activeBookId) return;
  activeBookId = bookId;
  save();
  applyBookColors();
  // Close catalog FIRST so UI is responsive, then render async
  closeBookCatalog();
  requestAnimationFrame(() => {
    // Force-reset flip state so the render always goes through with fresh content
    isJournalFlipping = false;
    pendingJournalRender = false;
    const bw = document.getElementById('journal-book-wrapper');
    if (bw) bw.classList.remove('jbook-flipping');
    renderJournal();
  });
  try { Haptics.impact({ style: ImpactStyle.Medium }); } catch(e) {}
  const book = journalBooks.find(b => b.id === bookId);
  if (book) showToast(`Switched to "${book.name}"`);
}

let editingBookId = null;
let contextMenuBookId = null;

function closeBookContextMenu() {
  document.getElementById('book-context-menu-overlay').classList.add('hidden');
  contextMenuBookId = null;
}

function deleteBookPrompt(bookId, bookName) {
  if (journalBooks.length <= 1) {
    showToast("Cannot delete your only journal.");
    return;
  }
  
  const bookToDelete = journalBooks.find(b => b.id === bookId);
  const visibleBooks = journalBooks.filter(b => !b.isHidden);
  
  if (bookToDelete && !bookToDelete.isHidden && visibleBooks.length <= 1) {
    showToast("Cannot delete your only public journal.");
    return;
  }
  document.getElementById('confirm-title').textContent = 'Delete Journal';
  document.getElementById('confirm-message').textContent = `Are you sure you want to delete "${bookName}" and all its pages? This cannot be undone.`;
  document.getElementById('confirm-cancel').onclick = () => {
    document.getElementById('confirm-dialog').parentElement.classList.add('hidden');
  };
  document.getElementById('confirm-action').onclick = () => {
    document.getElementById('confirm-dialog').parentElement.classList.add('hidden');
    
    // Add visual deletion animation
    const card = document.querySelector(`.book-card[data-book-id="${bookId}"]`);
    if (card) {
      card.classList.add('ashes-delete');
      
      setTimeout(() => {
        executeDeleteBook(bookId);
      }, 700);
    } else {
      executeDeleteBook(bookId);
    }
  };
  document.getElementById('confirm-dialog').parentElement.classList.remove('hidden');
}

function executeDeleteBook(bookId) {
  // 1. Remove entries
  if (journal[bookId]) {
    delete journal[bookId];
  }
  // 2. Remove book
  journalBooks = journalBooks.filter(b => b.id !== bookId);
  // 3. Fallback activeBookId
  if (activeBookId === bookId) {
      const firstVisible = journalBooks.find(b => !b.isHidden);
      activeBookId = firstVisible ? firstVisible.id : journalBooks[0].id;
  }
  save();
  applyBookColors();
  
  // Re-render components
  const bw = document.getElementById('journal-book-wrapper');
  if (bw) bw.classList.remove('jbook-flipping');
  renderJournal();
  
  // If catalog is open, re-render it
  if (!document.getElementById('book-catalog-overlay').classList.contains('hidden')) {
      renderBookCatalog();
  }
  
  showToast('Journal deleted.');
  triggerHaptic();
}

function openCreateBookModal(editBookId = null) {
  if (!editBookId && window.MonetizationManager) {
    if (!window.MonetizationManager.canCreateNewJournal(journalBooks.length)) {
      window.MonetizationManager.showUpsellModal('library_full');
      return;
    }
  }
  
  editingBookId = editBookId;
  const overlay = document.getElementById('new-book-overlay');
  const title = overlay.querySelector('.new-book-title');
  const btn = document.getElementById('btn-confirm-new-book');
  const nameInput = document.getElementById('new-book-name');
  
  if (editBookId) {
    const book = journalBooks.find(b => b.id === editBookId);
    title.textContent = 'Edit Journal';
    btn.textContent = 'Save Changes';
    nameInput.value = book.name;
    selectedNewCover = book.cover || 'classic';
  } else {
    title.textContent = 'Create Journal';
    btn.textContent = 'Create';
    nameInput.value = '';
    selectedNewCover = 'classic';
  }
  
  overlay.classList.remove('hidden');
  renderCoverPicker();
  setTimeout(() => nameInput.focus(), 100);
}

function closeCreateBookModal() {
  document.getElementById('new-book-overlay').classList.add('hidden');
  editingBookId = null;
}

let selectedNewCover = 'classic';

function renderCoverPicker() {
  const container = document.getElementById('cover-picker-grid');
  if (!container) return;
  container.innerHTML = '';
  
  Object.keys(BOOK_COVERS).forEach(coverId => {
    const opt = createCoverOption(coverId, coverId === selectedNewCover);
    opt.addEventListener('click', () => {
      selectedNewCover = coverId;
      renderCoverPicker();
      triggerHaptic();
    });
    container.appendChild(opt);
  });
}

function confirmCreateBook() {
  const name = document.getElementById('new-book-name').value.trim();
  if (!name) {
    showToast('Please enter a name for your journal.');
    return;
  }
  
  if (editingBookId) {
    const book = journalBooks.find(b => b.id === editingBookId);
    if (book) {
      book.name = name;
      book.cover = selectedNewCover;
      book.updatedAt = Date.now();
      showToast(`"${name}" updated.`);
    }
  } else {
    const newBook = createBook(name, selectedNewCover);
    journalBooks.push(newBook);
    activeBookId = newBook.id;
    showToast(`"${name}" created.`);
  }
  
  save();
  applyBookColors();
  closeCreateBookModal();
  
  // Force-reset flip state and re-render
  isJournalFlipping = false;
  pendingJournalRender = false;
  const bw = document.getElementById('journal-book-wrapper');
  if (bw) bw.classList.remove('jbook-flipping');
  renderJournal();
  
  // Re-render catalog if it's open
  if (!document.getElementById('book-catalog-overlay').classList.contains('hidden')) {
     renderBookCatalog();
  }
  
  triggerHaptic();
}

async function exportActiveBookPDF() {
  const book = journalBooks.find(b => b.id === activeBookId);
  if (!book) return;
  
  const bookJournal = getActiveJournal();
  const entryCount = countBookEntries(journal, activeBookId);
  
  if (entryCount === 0) {
    showToast('This journal has no entries to export.');
    return;
  }
  
  showToast('Generating PDF...', 2000);
  
  try {
    const blob = await exportBookToPDF(book, bookJournal);
    const safeName = book.name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
    const filename = `Telos_${safeName}_${new Date().toISOString().slice(0,10)}.pdf`;
    await sharePDF(blob, filename);
    triggerHaptic();
  } catch (e) {
    console.error('PDF export error:', e);
    showToast('Export failed. Please try again.');
  }
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

function confirmClear() {
  const overlay = document.getElementById('clear-data-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');

  // Reset to local by default
  const localRadio = document.querySelector('input[name="clear-target"][value="local"]');
  if (localRadio) localRadio.checked = true;

  const closeBtn = document.getElementById('btn-close-clear-data');
  const confirmBtn = document.getElementById('btn-execute-clear');

  const cleanup = () => {
    overlay.classList.add('hidden');
    closeBtn.removeEventListener('click', handleClose);
    confirmBtn.removeEventListener('click', handleConfirm);
  };

  const handleClose = () => cleanup();

  const handleConfirm = async () => {
    cleanup();
    const targetEl = document.querySelector('input[name="clear-target"]:checked');
    if (!targetEl) return;
    const target = targetEl.value;

    let clearedMessages = [];

    // Local Data
    if (target === 'local' || target === 'both') {
      habits = []; logs = {}; journal = {}; habitJournal = {}; journalBooks = [createDefaultBook()]; activeBookId = DEFAULT_BOOK_ID;
      save();
      clearedMessages.push('Local data');
    }

    // Cloud Data
    if (target === 'cloud' || target === 'both') {
      if (cloudUser) {
        try {
          const docRef = doc(db, 'users', cloudUser.uid);
          await deleteDoc(docRef);
          cloudSyncState.lastSyncTime = 0;
          cloudSyncState.cloudLastModified = 0;
          saveCloudSyncState();
          clearedMessages.push('Cloud backup');
        } catch (e) {
          console.error("Failed to delete cloud backup:", e);
          showToast("Failed to delete cloud backup.");
        }
      } else if (target === 'cloud') {
        showToast("Not signed in. No cloud data to delete.");
        return;
      }
    }

    if (clearedMessages.length > 0) {
      showToast(`${clearedMessages.join(' & ')} cleared.`);
    }

    renderHabits();
    renderProfile();
    renderJournal();
  };

  closeBtn.addEventListener('click', handleClose);
  confirmBtn.addEventListener('click', handleConfirm);
}

// ─── Navigation (with transitions) ───────────
function switchScreen(name, linkEl) {


  // Clear any keyboard states immediately when switching screens
  document.body.classList.remove('keyboard-visible');
  window.scrollTo(0, 0);

  if (currentScreen === name && !activeHabitId) return;

  currentScreen = name;
  activeHabitId = null;

  // Handle banner ad visibility based on screen
  if (window.MonetizationManager) {
    if (name === 'journal' || name === 'profile' || name === 'today') {
      window.MonetizationManager.showBanner();
    } else {
      window.MonetizationManager.hideBanner();
    }
  }

  // Handle Journal long-press hint bubble
  const journalBubble = document.getElementById('journal-hint-bubble');
  if (journalBubble) {
    if (name === 'journal') {
      showJournalHint();
    } else {
      journalBubble.classList.remove('visible');
      if (journalHintTimer) {
        clearTimeout(journalHintTimer);
        journalHintTimer = null;
      }
    }
  }

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

  // Refresh screen content — use a single reliable delay that exceeds the
  // 200ms screen-enter animation AND any async banner ad layout shift.
  // This replaces the old animationend + 300ms safety timeout approach that
  // was prone to race conditions causing the flipbook to render off-screen.
  if (name === 'journal') {
    setTimeout(() => {
      if (currentScreen !== 'journal') return; // User switched away already
      renderJournal();
      
      // Run journal tutorial if first time
      setTimeout(() => runTutorial('journal'), 800);
    }, 350);
  } else if (name === 'profile') {
    setTimeout(() => {
      if (currentScreen !== 'profile') return;
      renderProfile();
    }, 250);
  }
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
    dateHeader.textContent = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }).toUpperCase();
    card.appendChild(dateHeader);

    const sortedDayItems = [...dayEntries]
      .map((item, originalIndex) => ({ ...item, originalIndex }))
      .filter(i => (i.text && i.text.trim()) || (i.images && i.images.length > 0) || i.audio)
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
        ${item.text && item.text.trim() ? `<div class="journal-entry-body">${escapeHtml(item.text)}</div>` : ''}
      `;
      const mediaEl = renderMediaToBlock(item);
      if (mediaEl) block.appendChild(mediaEl);

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
  
  // Collect media from currentAttachments
  const attachments = currentAttachments['detail'];
  const images = attachments ? (attachments.images || []) : [];
  const audio = attachments ? attachments.audio : null;

  if (!text && images.length === 0 && !audio) {
    showToast('Write something or add media first.');
    return;
  }

  const key = todayKey();
  if (!habitJournal[activeHabitId]) habitJournal[activeHabitId] = {};
  if (!Array.isArray(habitJournal[activeHabitId][key])) habitJournal[activeHabitId][key] = [];
  
  const entry = { text, ts: Date.now() };
  if (images.length > 0) entry.images = images;
  if (audio) entry.audio = { data: audio.data, type: audio.type || 'audio/webm' };

  habitJournal[activeHabitId][key].push(entry);
  save();
  renderHabitEntries(activeHabitId);
  
  // Reset UI
  document.getElementById('detail-journal-textarea').value = '';
  resetMediaAttachments('detail');
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
  // Morning Briefing
  document.getElementById('notif-morning-toggle').checked = notifSettings.morning.enabled;
  document.getElementById('morning-time-panel').classList.toggle('hidden', !notifSettings.morning.enabled);
  document.getElementById('morning-time-input').value = notifSettings.morning.time;

  // Evening Review
  document.getElementById('notif-evening-toggle').checked = notifSettings.evening.enabled;
  document.getElementById('evening-time-panel').classList.toggle('hidden', !notifSettings.evening.enabled);
  document.getElementById('evening-time-input').value = notifSettings.evening.time;

  // Streak Saver
  document.getElementById('notif-streak-toggle').checked = notifSettings.streak;
}

function bindNotifUI() {
  // Morning
  document.getElementById('notif-morning-toggle').addEventListener('change', async (e) => {
    notifSettings.morning.enabled = e.target.checked;
    document.getElementById('morning-time-panel').classList.toggle('hidden', !e.target.checked);
    saveNotif();
    await scheduleNotifications();
  });
  document.getElementById('morning-time-input').addEventListener('change', async (e) => {
    notifSettings.morning.time = e.target.value;
    saveNotif();
    await scheduleNotifications();
  });

  // Evening
  document.getElementById('notif-evening-toggle').addEventListener('change', async (e) => {
    notifSettings.evening.enabled = e.target.checked;
    document.getElementById('evening-time-panel').classList.toggle('hidden', !e.target.checked);
    saveNotif();
    await scheduleNotifications();
  });
  document.getElementById('evening-time-input').addEventListener('change', async (e) => {
    notifSettings.evening.time = e.target.value;
    saveNotif();
    await scheduleNotifications();
  });

  // Streak Saver
  document.getElementById('notif-streak-toggle').addEventListener('change', async (e) => {
    notifSettings.streak = e.target.checked;
    saveNotif();
    await scheduleNotifications();
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
async function scheduleNotifications(silent = false) {
  // Always start clean
  await cancelAllNotifications();

  // Ensure we have OS permission.
  // If called silently (startup re-schedule), only check — do NOT prompt the OS dialog.
  // The OS dialog is only shown via requestNotifPermission() from finishTutorial() or user settings.
  const { display } = await LocalNotifications.checkPermissions().catch(() => ({ display: 'denied' }));
  if (silent) {
    // Silent mode: skip scheduling if not already granted — never show OS dialog here
    if (display !== 'granted') return;
  } else {
    // Interactive mode: ask for permission if needed
    const granted = await requestNotifPermission();
    if (!granted) {
      showToast('⚠ Notification permission denied.');
      saveNotif();
      return;
    }
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




  // ── 1. Morning Briefing (next 7 days) ────────────────────────
  if (notifSettings.morning.enabled && notifSettings.morning.time) {
    for (let day = 0; day <= 6; day++) {
      const fireDate = dateAtTime(day, notifSettings.morning.time);
      if (fireDate <= now) continue;

      toSchedule.push({
        id: 1000 + day,
        title: '🌅 Good Morning',
        body: 'Set your intentions for today. Tap to view your habits.',
        schedule: { at: fireDate, allowWhileIdle: true, exact: true },
        channelId: 'telos_reminders',
      });
    }
  }

  // ── 2. Evening Review (next 7 days) ──────────────────────────
  if (notifSettings.evening.enabled && notifSettings.evening.time) {
    for (let day = 0; day <= 6; day++) {
      const fireDate = dateAtTime(day, notifSettings.evening.time);
      if (fireDate <= now) continue;

      toSchedule.push({
        id: 2000 + day,
        title: '🌙 Evening Review',
        body: 'Ready to wrap up? Let\'s see how you did today.',
        schedule: { at: fireDate, allowWhileIdle: true, exact: true },
        channelId: 'telos_reminders',
      });
    }
  }

  // ── 3. Streak Saver (next 7 days) ────────────────────────────
  if (notifSettings.streak) {
    for (let day = 0; day <= 6; day++) {
      const fireDate = dateAtTime(day, '21:00');
      if (fireDate <= now) continue;

      toSchedule.push({
        id: 3000 + day,
        title: '🔥 Protect Your Streaks!',
        body: 'You still have active habits today. Don\'t lose your momentum!',
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
  } catch (e) {
    console.error('[Telos] ❌ Notification scheduling failed:', e);
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
    const activeJournal = getActiveJournal();
    const allJournalDates = Object.keys(activeJournal).sort((a,b) => a.localeCompare(b));
    const firstDate = allJournalDates[0] || todayKey();
    
    // Inject standard intro only for default book
    if (activeBookId === DEFAULT_BOOK_ID) {
      allEntries.push({ 
        dateKey: firstDate, 
        type: 'general', 
        text: SYSTEM_INTRO_ENTRY.text, 
        ts: 1, // Absolute beginning
        images: SYSTEM_INTRO_ENTRY.images, 
        audio: SYSTEM_INTRO_ENTRY.audio, 
        originalIndex: -1,
        isSystem: true
      });
    }

    Object.keys(activeJournal).forEach(dk => {
      const items = activeJournal[dk];
      if (Array.isArray(items)) {
        items.forEach((item, index) => {
          if ((item.text && item.text.trim()) || (item.images && item.images.length > 0) || item.audio) {
            allEntries.push({ dateKey: dk, type: 'general', text: item.text, ts: item.ts, images: item.images, audio: item.audio, originalIndex: index });
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
            if ((item.text && item.text.trim()) || (item.images && item.images.length > 0) || item.audio) {
              allEntries.push({ dateKey: dk, type: 'habit', habitId, habitName, habitIcon, text: item.text, ts: item.ts, images: item.images, audio: item.audio, originalIndex: index });
            }
          });
        }
      });
    });
  }

  if (archiveSearch) {
    allEntries = allEntries.filter(e => (e.text || '').toLowerCase().includes(archiveSearch));
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

      const dateHeader = document.createElement('div');
      dateHeader.className = 'journal-entry-date';
      dateHeader.textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
      card.appendChild(dateHeader);

      const items = dailyGrouped[dateKey];
      items.forEach((item, idx) => {
        const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
        const isLast = idx === items.length - 1;

        const block = document.createElement('div');
        block.className = 'journal-entry-block';
        block.setAttribute('role', 'button');
        block.setAttribute('tabindex', '0');
        block.style.padding = '10px 16px 14px';
        if (!isLast) block.style.borderBottom = '1px solid rgba(0,0,0,0.03)';

        let headerMeta = '';
        if (item.type === 'habit') {
          headerMeta = `
            <div style="font-size: 12px; font-weight: 600; color: var(--charcoal); margin-bottom: 2px; opacity: 0.8;">
              <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; margin-right:4px;">${item.habitIcon}</span><span style="vertical-align:middle;">${escapeHtml(item.habitName)}</span>
            </div>
          `;
        }

        block.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:2px;">
            <span style="font-size: 10px; font-weight: 700; color: var(--slate); opacity: 0.6; text-transform:uppercase;">${timeStr}</span>
          </div>
          ${headerMeta}
          ${item.text && item.text.trim() ? `<div class="journal-entry-body">${escapeHtml(item.text)}</div>` : ''}
        `;
        const mediaEl = renderMediaToBlock(item);
        if (mediaEl) block.appendChild(mediaEl);

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

  // Final scroll isolation to prevent background flips/scrolling
  feed.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  feed.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
  feed.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
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

const journalTutorialSteps = [
  {
    target: '#journal-textarea',
    text: "Capture the soul of the moment.\nSpill your thoughts into the void and anchor them in time.",
    type: 'rect',
    padding: 12
  },
  {
    target: '#nav-journal',
    text: "Touch and hold to reveal its secrets.\nLong press the journal tab to manage your chronicles or archive your path.",
    type: 'circle',
    padding: 10
  },
  {
    target: '#btn-browse-journal',
    text: "Walk through the halls of memory.\nBrowse your catalog of journals and revisit who you were.",
    type: 'circle',
    padding: 10
  }
];

let activeTutorialType = 'main'; // 'main' or 'journal'
let journalHintTimer = null;

function showJournalHint() {
  const bubble = document.getElementById('journal-hint-bubble');
  const navBtn = document.getElementById('nav-journal');
  if (!bubble || !navBtn) return;

  if (localStorage.getItem('telos_journal_hint_seen') === 'true') {
    bubble.classList.remove('visible');
    return;
  }

  // Position bubble above the nav button
  const updatePosition = () => {
    const rect = navBtn.getBoundingClientRect();
    bubble.style.left = `${rect.left + rect.width / 2}px`;
  };

  updatePosition();
  window.addEventListener('resize', updatePosition);
  
  // Clear any existing timer to avoid overlaps
  if (journalHintTimer) clearTimeout(journalHintTimer);
  
  // Show after a short delay once on the screen
  journalHintTimer = setTimeout(() => {
    // Re-check current screen to ensure we're still in journal
    const currentScreen = document.querySelector('.screen.active');
    if (currentScreen && currentScreen.id === 'journal') {
      bubble.classList.add('visible');
    }
  }, 1000);
}

function markJournalHintSeen() {
  if (journalHintTimer) {
    clearTimeout(journalHintTimer);
    journalHintTimer = null;
  }
  const bubble = document.getElementById('journal-hint-bubble');
  if (bubble) bubble.classList.remove('visible');
  localStorage.setItem('telos_journal_hint_seen', 'true');
}
function runTutorial(type = 'main') {
  if (type === 'main' && localStorage.getItem('telos_tutorial')) return;
  if (type === 'journal' && localStorage.getItem('telos_journal_tutorial')) return;
  
  const overlay = document.getElementById('tutorial-overlay');
  if (!overlay) return;
  
  activeTutorialType = type;
  overlay.classList.remove('hidden');
  overlay.style.opacity = '1';
  tutorialCurrentStep = 0;
  showTutorialStep();
  
  overlay.onclick = (e) => {
    e.stopPropagation();
    tutorialCurrentStep++;
    const steps = activeTutorialType === 'main' ? tutorialSteps : journalTutorialSteps;
    if (tutorialCurrentStep < steps.length) {
      showTutorialStep();
    } else {
      finishTutorial();
    }
  };
}

function showTutorialStep() {
  const steps = activeTutorialType === 'main' ? tutorialSteps : journalTutorialSteps;
  const step = steps[tutorialCurrentStep];
  const targetEl = document.querySelector(step.target);
  const spotlight = document.getElementById('tutorial-spotlight');
  const textEl = document.getElementById('tutorial-text');
  const overlay = document.getElementById('tutorial-overlay');
  
  if (!targetEl || targetEl.offsetParent === null) {
    // skip if element is hidden or not in DOM
    tutorialCurrentStep++;
    const steps = activeTutorialType === 'main' ? tutorialSteps : journalTutorialSteps;
    if (tutorialCurrentStep < steps.length) showTutorialStep();
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
    
    if (activeTutorialType === 'main') {
      localStorage.setItem('telos_tutorial', 'true');
      
      // Request notifications ONLY AFTER main tutorial ends
      if (!localStorage.getItem('telos_notif_prompted')) {
        localStorage.setItem('telos_notif_prompted', 'true');
        setTimeout(async () => {
          try {
            const granted = await requestNotifPermission();
            if (granted) {
              try { localStorage.setItem('telos_notif', JSON.stringify(notifSettings)); } catch(e) {}
              renderNotifications();
              scheduleNotifications().catch(() => {});
            }
          } catch(e) {}
        }, 1000);
      }
    } else {
      localStorage.setItem('telos_journal_tutorial', 'true');
    }
  }, 800);
}

/* ═══════════════════════════════════════════
   CLOUD SYNC & BACKUP LOGIC
═══════════════════════════════════════════ */
const SYNC_TIMEOUT = 30000; // 30 seconds — generous for slow connections

async function withTimeout(promise, ms = SYNC_TIMEOUT) {
  const timeout = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Sync timed out. Please check your connection.')), ms)
  );
  return Promise.race([promise, timeout]);
}

// Retry wrapper for Firestore overwrites — exponential backoff
async function retryableSetDoc(ref, data, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(setDoc(ref, data));
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

// Retry wrapper for Firestore merge writes (metadata only)
async function retryableMergeDoc(ref, data, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(setDoc(ref, data, { merge: true }));
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

let cloudUser = null;
let cloudSyncState = {
  autoSync: false,
  frequency: 'daily',
  syncIntentions: true,
  syncJournals: true,
  lastSyncTime: 0,
  localLastModified: 0,
  cloudLastModified: 0
};

// Load Sync State
try {
  const savedState = localStorage.getItem('telos_cloud_sync');
  if (savedState) Object.assign(cloudSyncState, JSON.parse(savedState));
} catch(e) {}

function saveCloudSyncState() {
  localStorage.setItem('telos_cloud_sync', JSON.stringify(cloudSyncState));
}

function formatSyncDate(ts) {
  if (!ts) return "Never";
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today, ${timeStr}`;
  
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${timeStr}`;
}

/**
 * Updates the visual state of a sync button
 * @param {string} btnId - ID of the button
 * @param {boolean} isLoading - Is it currently working?
 * @param {boolean} isSuccess - Should it show success briefly?
 */
function setLoadingState(btnId, isLoading, isSuccess = false) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  const icon = btn.querySelector('.material-symbols-outlined');
  const textNode = Array.from(btn.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  
  if (isLoading) {
    btn.classList.add('loading');
    btn.disabled = true;
    if (icon) icon.textContent = 'sync';
    if (textNode) {
      if (btnId === 'btn-backup-now') textNode.textContent = ' Backing up...';
      if (btnId === 'btn-restore-now') textNode.textContent = ' Synchronizing...';
    }
  } else if (isSuccess) {
    btn.classList.remove('loading');
    btn.classList.add('success');
    if (icon) icon.textContent = 'done_all';
    if (textNode) textNode.textContent = ' Done';
    
    setTimeout(() => {
      btn.classList.remove('success');
      btn.disabled = false;
      if (icon) icon.textContent = btnId === 'btn-backup-now' ? 'cloud_upload' : 'cloud_download';
      if (textNode) textNode.textContent = btnId === 'btn-backup-now' ? ' Backup Now' : ' Restore from Cloud';
    }, 2000);
  } else {
    btn.classList.remove('loading');
    btn.classList.remove('success');
    btn.disabled = false;
    if (icon) icon.textContent = btnId === 'btn-backup-now' ? 'cloud_upload' : 'cloud_download';
    if (textNode) textNode.textContent = btnId === 'btn-backup-now' ? ' Backup Now' : ' Restore from Cloud';
  }
}


function updateCloudUI() {
  const loggedOutPanel = document.getElementById('cloud-logged-out');
  const loggedInPanel = document.getElementById('cloud-logged-in');
  if (!loggedOutPanel || !loggedInPanel) return;

  if (cloudUser) {
    loggedOutPanel.classList.add('hidden');
    loggedInPanel.classList.remove('hidden');
    document.getElementById('profile-email').textContent = cloudUser.email || 'Google User';

    // Update settings
    document.getElementById('sync-intentions').checked = cloudSyncState.syncIntentions;
    document.getElementById('sync-journals').checked = cloudSyncState.syncJournals;
    document.getElementById('sync-auto-toggle').checked = cloudSyncState.autoSync;
    
    const freqPanel = document.getElementById('sync-frequency-panel');
    if (cloudSyncState.autoSync) {
      freqPanel.classList.remove('hidden');
      document.getElementById('sync-frequency').value = cloudSyncState.frequency;
    } else {
      freqPanel.classList.add('hidden');
    }

    // Update Timestamps
    const localSyncEl = document.getElementById('local-sync-date');
    const cloudSyncEl = document.getElementById('cloud-sync-date');
    if (localSyncEl) localSyncEl.textContent = formatSyncDate(cloudSyncState.localLastModified);
    if (cloudSyncEl) cloudSyncEl.textContent = formatSyncDate(cloudSyncState.cloudLastModified);

  } else {
    loggedOutPanel.classList.remove('hidden');
    loggedInPanel.classList.add('hidden');
  }
}

async function handleGoogleSignIn() {
  try {
    const result = await FirebaseAuthentication.signInWithGoogle({
      webClientId: '586803424168-5ncvtuiithal5372l5f9hg8jgdn4239f.apps.googleusercontent.com',
    });
    if (result.credential?.idToken) {
      const credential = GoogleAuthProvider.credential(result.credential.idToken);
      await signInWithCredential(auth, credential);
    }
  } catch (err) {
    console.error("Google Auth Error:", err);
    // Display the specific error message to help diagnose the issue (e.g. Code 10, 12500, etc.)
    const detailedError = err.message || JSON.stringify(err);
    showToast(`Sign in failed. Error: ${detailedError}`);
  }
}

async function handleSignOut() {
  try {
    await FirebaseAuthentication.signOut();
    await signOut(auth);
    cloudUser = null;
    updateCloudUI();
    showToast("Signed out successfully.");
  } catch (err) {
    console.error("Sign Out Error:", err);
  }
}

async function backupToCloud(silent = false) {
  if (!cloudUser) return;
  const uid = cloudUser.uid;

  try {
    if (!silent) setLoadingState('btn-backup-now', true);

    // O(1) dirty-check: compare local modification time vs last successful sync
    const isDataDirty = cloudSyncState.localLastModified > cloudSyncState.lastSyncTime;

    if (!isDataDirty) {
      if (!silent) {
        showToast("Cloud is already up to date.");
        setLoadingState('btn-backup-now', false, true);
      }
      return;
    }

    const timestamp = Date.now();
    const promises = [];

    // Core data — plain overwrite (no merge) for maximum speed
    if (cloudSyncState.syncIntentions) {
      const coreRef = doc(db, 'users', uid, 'sync', 'core');
      promises.push(retryableSetDoc(coreRef, {
        habits, logs, notifSettings, lastModified: timestamp
      }));
    }

    // Journal data — plain overwrite (no merge) for maximum speed
    if (cloudSyncState.syncJournals) {
      const journalRef = doc(db, 'users', uid, 'sync', 'journals');
      promises.push(retryableSetDoc(journalRef, {
        journal, habitJournal, journalBooks, lastModified: timestamp
      }));
    }

    // Metadata — merge is fine here (tiny doc, preserves other fields)
    const baseRef = doc(db, 'users', uid);
    promises.push(retryableMergeDoc(baseRef, {
      lastModified: timestamp,
      updatedAt: serverTimestamp(),
      platform: 'android'
    }));

    await Promise.all(promises);

    // Use the backup timestamp (not Date.now()) so changes made DURING
    // the upload are correctly detected as dirty on the next sync
    cloudSyncState.lastSyncTime = timestamp;
    cloudSyncState.cloudLastModified = timestamp;
    saveCloudSyncState();

    if (!silent) {
      setLoadingState('btn-backup-now', false, true);
      updateCloudUI();
    }
  } catch (err) {
    console.error("Backup Error:", err);
    if (!silent) {
      showToast(err.message || "Backup failed.");
      setLoadingState('btn-backup-now', false);
    }
  }
}

async function restoreFromCloud() {
  if (!cloudUser) return;
  const uid = cloudUser.uid;

  try {
    setLoadingState('btn-restore-now', true);

    const coreRef = doc(db, 'users', uid, 'sync', 'core');
    const journalRef = doc(db, 'users', uid, 'sync', 'journals');
    const baseRef = doc(db, 'users', uid);

    const [baseSnap, coreSnap, journalSnap] = await withTimeout(Promise.all([
      getDoc(baseRef),
      getDoc(coreRef),
      getDoc(journalRef)
    ]));

    let cloudData = {};
    let cloudTS = 0;

    if (coreSnap.exists()) {
      cloudData = { ...coreSnap.data() };
      if (journalSnap.exists()) {
        const jData = journalSnap.data();
        cloudData.journal = jData.journal;
        cloudData.habitJournal = jData.habitJournal;
        cloudData.journalBooks = jData.journalBooks;
      }
      cloudTS = cloudData.lastModified || 0;
    } else if (baseSnap.exists() && baseSnap.data().habits) {
      // Legacy single-doc fallback
      cloudData = baseSnap.data();
      cloudTS = cloudData.lastModified || 0;
    } else {
      showToast("No backup found in cloud.");
      setLoadingState('btn-restore-now', false);
      return;
    }

    const localTS = cloudSyncState.localLastModified || 0;

    // Only show conflict if BOTH timestamps exist and diverge
    if (localTS > 0 && cloudTS > 0 && Math.abs(cloudTS - localTS) > 5000) {
      showConflictModal(localTS, cloudTS, cloudData);
      setLoadingState('btn-restore-now', false);
      return;
    }

    await applyCloudData(cloudData);
    setLoadingState('btn-restore-now', false, true);

  } catch (err) {
    console.error("Restore Error:", err);
    showToast(err.message || "Restore failed.");
    setLoadingState('btn-restore-now', false);
  }
}

async function applyCloudData(data) {
  if (data.habits && cloudSyncState.syncIntentions) {
    habits = data.habits;
    logs = data.logs || {};
    if (data.notifSettings) Object.assign(notifSettings, data.notifSettings);
  }
  
  if (data.journal && cloudSyncState.syncJournals) {
    journal = data.journal;
    habitJournal = data.habitJournal || {};
    if (data.journalBooks && data.journalBooks.length > 0) {
      journalBooks = data.journalBooks;
    }
    // Re-run multi-book migration in case cloud data is in flat format
    journal = migrateJournalToMultiBook(journal);
    activeBookId = notifSettings.activeBookId || journalBooks[0].id;
    if (!journalBooks.find(b => b.id === activeBookId)) activeBookId = journalBooks[0].id;
  }

  save(); // This updates local timestamp & UI
  
  cloudSyncState.lastSyncTime = Date.now();
  cloudSyncState.cloudLastModified = data.lastModified || Date.now();
  saveCloudSyncState();
  
  renderHabits();
  renderJournal();
  showToast("Cloud data applied.");
}

/* Conflict Resolution UI Helpers */
let pendingCloudData = null;

function showConflictModal(localTS, cloudTS, cloudData) {
  pendingCloudData = cloudData;
  const overlay = document.getElementById('conflict-modal-overlay');
  if (!overlay) return;

  document.getElementById('conflict-local-date').textContent = `Modified: ${formatSyncDate(localTS)}`;
  document.getElementById('conflict-cloud-date').textContent = `Modified: ${formatSyncDate(cloudTS)}`;
  
  // Visual emphasis on newer (recommended) version
  const localBtn = document.getElementById('btn-keep-local');
  const cloudBtn = document.getElementById('btn-keep-cloud');
  
  localBtn.classList.remove('recommended');
  cloudBtn.classList.remove('recommended');

  if (localTS >= cloudTS) localBtn.classList.add('recommended');
  else cloudBtn.classList.add('recommended');

  overlay.classList.remove('hidden');

  // Setup Button Handlers — capture data reference BEFORE closeConflictModal clears it
  localBtn.onclick = () => {
    closeConflictModal();
    backupToCloud();
  };

  cloudBtn.onclick = () => {
    const data = pendingCloudData; // Capture ref before close nullifies it
    closeConflictModal();
    if (data) applyCloudData(data);
  };

  // Close/Cancel buttons
  const closeBtn = document.getElementById('btn-conflict-close');
  const cancelBtn = document.getElementById('btn-conflict-cancel');
  
  if (closeBtn) closeBtn.onclick = () => closeConflictModal();
  if (cancelBtn) cancelBtn.onclick = () => closeConflictModal();
}

function closeConflictModal() {
  const overlay = document.getElementById('conflict-modal-overlay');
  if (overlay) overlay.classList.add('hidden');
  pendingCloudData = null;
}


async function checkAutoSync() {
  if (!cloudUser || !cloudSyncState.autoSync) return;
  
  const now = Date.now();
  const diff = now - (cloudSyncState.lastSyncTime || 0);
  
  const dailyMs = 24 * 60 * 60 * 1000;
  const weeklyMs = 7 * dailyMs;
  
  const threshold = cloudSyncState.frequency === 'weekly' ? weeklyMs : dailyMs;
  
  if (diff > threshold) {
    await backupToCloud(true);
  }
}

async function syncRemoteMetadata() {
  if (!cloudUser) return;
  try {
    const docRef = doc(db, 'users', cloudUser.uid);
    // Lightweight fetch for metadata
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      if (data.lastModified) {
        cloudSyncState.cloudLastModified = data.lastModified;
        saveCloudSyncState();
        updateCloudUI();
      }
    }
  } catch (e) {
    console.warn("Metadata sync failed:", e);
  }
}

onAuthStateChanged(auth, (user) => {
  cloudUser = user;
  updateCloudUI();
  if (user) {
    syncRemoteMetadata();
    checkAutoSync();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-google-sign-in')?.addEventListener('click', handleGoogleSignIn);
  document.getElementById('btn-sign-out')?.addEventListener('click', handleSignOut);
  document.getElementById('btn-backup-now')?.addEventListener('click', () => backupToCloud(false));
  document.getElementById('btn-restore-now')?.addEventListener('click', restoreFromCloud);

  const intentionsCb = document.getElementById('sync-intentions');
  if (intentionsCb) intentionsCb.addEventListener('change', (e) => {
    cloudSyncState.syncIntentions = e.target.checked;
    saveCloudSyncState();
  });

  const journalsCb = document.getElementById('sync-journals');
  if (journalsCb) journalsCb.addEventListener('change', (e) => {
    cloudSyncState.syncJournals = e.target.checked;
    saveCloudSyncState();
  });

  const autoToggle = document.getElementById('sync-auto-toggle');
  const freqPanel = document.getElementById('sync-frequency-panel');
  if (autoToggle) autoToggle.addEventListener('change', (e) => {
    cloudSyncState.autoSync = e.target.checked;
    if (e.target.checked) freqPanel.classList.remove('hidden');
    else freqPanel.classList.add('hidden');
    saveCloudSyncState();
  });

  const freqSelect = document.getElementById('sync-frequency');
  if (freqSelect) freqSelect.addEventListener('change', (e) => {
    cloudSyncState.frequency = e.target.value;
    saveCloudSyncState();
  });
});


// ─── Overflow Debugging Utility ───────────────
// Run `window.__debugOverflow()` in Chrome DevTools remote inspector
// to identify elements that render offscreen or cause overflow.
window.__debugOverflow = function() {
  const docWidth = document.documentElement.clientWidth;
  const docHeight = document.documentElement.clientHeight;
  const offenders = [];
  document.querySelectorAll('*').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.right > docWidth + 1 || rect.left < -1 ||
        rect.bottom > docHeight + 1 || rect.top < -1) {
      if (rect.width > 0 && rect.height > 0) {
        el.style.outline = '2px solid red';
        offenders.push({
          el, tag: el.tagName, id: el.id, class: el.className,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        });
      }
    }
  });
  console.table(offenders.map(o => ({
    tag: o.tag, id: o.id, class: String(o.class).slice(0, 40),
    left: Math.round(o.rect.left), top: Math.round(o.rect.top),
    right: Math.round(o.rect.right), bottom: Math.round(o.rect.bottom)
  })));
  console.log(`Found ${offenders.length} offscreen elements (outlined in red).`);
  console.log('Run window.__debugOverflowClear() to remove outlines.');
  return offenders;
};

window.__debugOverflowClear = function() {
  document.querySelectorAll('*').forEach(el => { el.style.outline = ''; });
  console.log('Overflow outlines cleared.');
};

