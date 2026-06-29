/*
 * _readonly.js — frontend freeze of edit controls for modules already
 * migrated to the new cabinet (Postgres). Hides "add / edit / delete /
 * upload / inline-save" controls so users don't create or hand-edit data
 * that would desync from the new system. Does NOT touch the backend / API —
 * programmatic and automated writes keep working.
 *
 * Pure UI: hides buttons and disables inline inputs. Re-applies on dynamic
 * re-renders via a MutationObserver.
 */
(function () {
  'use strict';

  // Per-page write-control selectors. Keys = page (file name without .html).
  var CFG = {
    documentation: {
      hide: ['#btn-add-doc', '#cat-add-btns', '#cat-admin-btns', '.cat-actions',
        '[data-action="edit-doc"]', '[data-action="delete-doc"]', '[data-action="upload-ver"]',
        '[data-action="add-ver-files"]', '[data-action="delete-ver-file"]'],
    },
    missions: {
      hide: ['#btn-new-mission', '#sp-actions', '.comment-form'],
      disable: ['#sp-status', '#sp-priority', '#sp-due'],
    },
    contractors: { hide: ['#btn-add', '[data-action="edit"]', '[data-action="delete"]', '.icon-btn.del'] },
    buyers: { hide: ['#btn-add', '[data-action="edit"]', '[data-action="delete"]'] },
    companies: {
      hide: ['#btn-add', '[data-action="edit"]', '[data-action="delete"]',
        '[data-action="edit-company"]', '[data-action="add-account"]', '[data-action="edit-account"]'],
    },
    categories: {
      hide: ['#btn-add-type', '#btn-add-cat', '#btn-save-all',
        '[data-action="save"]', '[data-action="save-type"]'],
      // Whole page is inline-edit tables → freeze inputs + drag-reorder.
      disableInputsIn: ['body'],
      undrag: true,
    },
    folders: { hide: ['#btn-add', '[data-action="edit"]', '[data-action="delete"]', '.icon-btn.del'] },
    // users.html is NOT fully frozen — only the folder-access matrix (доступы).
    users: {
      disable: ['.folder-gantt-select', '.folder-access-select', '.folder-docs-select',
        '.folder-materials-select', '.folder-sales-select'],
    },
  };

  var page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/i, '');
  var cfg = CFG[page];
  if (!cfg) return;

  function hideAll(sel) {
    document.querySelectorAll(sel).forEach(function (el) { el.style.display = 'none'; });
  }
  function disableAll(sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.disabled = true;
      el.style.pointerEvents = 'none';
      el.style.opacity = '0.55';
    });
  }

  function sweep() {
    (cfg.hide || []).forEach(hideAll);
    (cfg.disable || []).forEach(disableAll);
    if (cfg.disableInputsIn) {
      cfg.disableInputsIn.forEach(function (scope) {
        document.querySelectorAll(scope + ' input, ' + scope + ' select, ' + scope + ' textarea').forEach(function (el) {
          if (el.id && el.id.indexOf('filter') !== -1) return; // keep search/filter usable
          el.disabled = true;
        });
      });
    }
    if (cfg.undrag) {
      document.querySelectorAll('[draggable="true"]').forEach(function (el) { el.setAttribute('draggable', 'false'); });
    }
  }

  function addBadge() {
    if (document.getElementById('ro-badge')) return;
    var b = document.createElement('div');
    b.id = 'ro-badge';
    b.textContent = '🔒 Только просмотр — раздел перенесён в новый кабинет';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;background:#eef1f8;color:#2b3a55;' +
      'border:1px solid #c9d2e3;border-radius:8px;padding:6px 12px;font-size:0.78rem;font-family:sans-serif;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.08);pointer-events:none';
    document.body.appendChild(b);
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; sweep(); });
  }

  function init() {
    sweep();
    addBadge();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
