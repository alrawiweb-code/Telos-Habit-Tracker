/* ═══════════════════════════════════════════
   TELOS — PDF Export Module
   pdf-export.js — Journal to PDF
═══════════════════════════════════════════ */

'use strict';

import { jsPDF } from 'jspdf';
import { BOOK_COVERS } from './journal-manager.js';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// ─── Color Utilities ─────────────────────
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function parseDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ─── PDF Constants ───────────────────────
const PAGE_W = 148; // A5 width mm
const PAGE_H = 210; // A5 height mm
const MARGIN = 16;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LINE_H = 5.5; // Line height in mm
const MAX_Y = PAGE_H - MARGIN - 10; // Leave room for page number

// ─── Generate PDF for a Journal Book ─────
export async function exportBookToPDF(book, bookJournal, onProgress) {
  const cover = BOOK_COVERS[book.cover] || BOOK_COVERS.classic;
  const accent = hexToRgb(cover.accent);
  
  // Create A5-size PDF
  const doc = new jsPDF({ unit: 'mm', format: [PAGE_W, PAGE_H] });
  
  if (onProgress) onProgress(0, 'Preparing...');
  
  // ── Cover Page ──
  renderCoverPage(doc, book, cover, accent);
  
  // ── Content Pages ──
  const sortedDates = Object.keys(bookJournal)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort((a, b) => a.localeCompare(b));
  
  if (sortedDates.length === 0) {
    doc.addPage();
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(12);
    doc.setTextColor(150, 150, 150);
    doc.text('This journal is empty.', PAGE_W / 2, PAGE_H / 2, { align: 'center' });
  } else {
    let pageNum = 1;
    const total = sortedDates.length;
    
    for (let i = 0; i < sortedDates.length; i++) {
      const dateKey = sortedDates[i];
      const entries = bookJournal[dateKey];
      if (!Array.isArray(entries) || entries.length === 0) continue;
      
      if (onProgress) onProgress(Math.round((i / total) * 100), `Page ${i + 1} of ${total}...`);
      
      doc.addPage();
      pageNum++;
      
      let y = MARGIN;
      
      // Date header
      const dateObj = parseDate(dateKey);
      const dateStr = dateObj.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
      });
      
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(accent.r, accent.g, accent.b);
      doc.text(dateStr, MARGIN, y);
      y += 3;
      
      // Accent line
      doc.setDrawColor(accent.r, accent.g, accent.b);
      doc.setLineWidth(0.3);
      doc.line(MARGIN, y, MARGIN + 40, y);
      y += 6;
      
      // Entries
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(60, 60, 60);
      
      for (const entry of entries) {
        if (!entry.text || !entry.text.trim()) continue;
        
        // Time stamp
        if (entry.ts && entry.ts > 1) {
          const time = new Date(entry.ts).toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true
          });
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(8);
          doc.setTextColor(150, 150, 150);
          doc.text(time, MARGIN, y);
          y += 4;
        }
        
        // Entry text — word wrap
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(60, 60, 60);
        
        const lines = doc.splitTextToSize(entry.text, CONTENT_W);
        
        for (const line of lines) {
          if (y > MAX_Y) {
            // Footer on current page
            renderPageFooter(doc, pageNum, accent);
            doc.addPage();
            pageNum++;
            y = MARGIN;
          }
          doc.text(line, MARGIN, y);
          y += LINE_H;
        }
        
        // Media indicators
        if (entry.images && entry.images.length > 0) {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(8);
          doc.setTextColor(accent.r, accent.g, accent.b);
          doc.text(`📷 ${entry.images.length} photo${entry.images.length > 1 ? 's' : ''} attached`, MARGIN, y);
          y += 4;
        }
        
        if (entry.audio) {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(8);
          doc.setTextColor(accent.r, accent.g, accent.b);
          doc.text('🎵 Audio recording attached', MARGIN, y);
          y += 4;
        }
        
        y += 3; // Gap between entries
      }
      
      // Footer
      renderPageFooter(doc, pageNum, accent);
    }
  }
  
  if (onProgress) onProgress(100, 'Done!');
  
  // Return as blob
  return doc.output('blob');
}

// ─── Cover Page Rendering ────────────────
function renderCoverPage(doc, book, cover, accent) {
  // Background
  doc.setFillColor(20, 20, 35);
  doc.rect(0, 0, PAGE_W, PAGE_H, 'F');
  
  // Ornament
  doc.setFontSize(24);
  doc.setTextColor(accent.r, accent.g, accent.b);
  doc.text(cover.ornament || '◈', PAGE_W / 2, PAGE_H / 2 - 25, { align: 'center' });
  
  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(accent.r, accent.g, accent.b);
  
  const titleLines = doc.splitTextToSize(book.name, CONTENT_W);
  let titleY = PAGE_H / 2 - 5;
  for (const line of titleLines) {
    doc.text(line, PAGE_W / 2, titleY, { align: 'center' });
    titleY += 8;
  }
  
  // Divider line
  doc.setDrawColor(accent.r, accent.g, accent.b);
  doc.setLineWidth(0.2);
  const divY = titleY + 5;
  doc.line(PAGE_W / 2 - 20, divY, PAGE_W / 2 + 20, divY);
  
  // Year
  const year = new Date(book.createdAt).getFullYear();
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(10);
  doc.text(`— est. ${year} —`, PAGE_W / 2, divY + 10, { align: 'center' });
  
  // App branding
  doc.setFontSize(7);
  doc.setTextColor(accent.r, accent.g, accent.b);
  doc.text('Exported from Telos', PAGE_W / 2, PAGE_H - 12, { align: 'center' });
}

// ─── Page Footer ─────────────────────────
function renderPageFooter(doc, pageNum, accent) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(180, 180, 180);
  doc.text(`${pageNum}`, PAGE_W / 2, PAGE_H - 10, { align: 'center' });
}

// ─── Save/Share PDF ──────────────────────
export function downloadPDF(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function sharePDF(blob, filename) {
  if (Capacitor.isNativePlatform()) {
    try {
      // 1. Convert Blob to Base64
      const reader = new FileReader();
      const base64Data = await new Promise((resolve, reject) => {
        reader.onloadend = () => {
          const result = reader.result;
          const base64 = result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      // 2. Write to cache directory
      const writeFileResult = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Cache,
      });

      // 3. Share the local file URI
      await Share.share({
        title: filename,
        url: writeFileResult.uri,
        dialogTitle: 'Share PDF'
      });
      return true;
    } catch (e) {
      console.error('Native share failed:', e);
      return false;
    }
  }

  // Web fallback
  if (navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return true;
      } catch (e) {
        if (e.name !== 'AbortError') console.error('Share failed:', e);
        return false;
      }
    }
  }
  
  // Fallback to download
  downloadPDF(blob, filename);
  return true;
}
