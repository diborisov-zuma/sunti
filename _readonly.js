/*
 * _readonly.js — SITE-WIDE frontend freeze. The old cabinet is being retired;
 * this hides every create / edit / delete / save / upload control so nobody
 * hand-edits data that would desync from the new Postgres cabinet.
 *
 * Pure UI (browser-only): it hides/disables controls. It does NOT touch the
 * backend/API, so server-side and automated writes (e.g. the WhatsApp webhook)
 * keep working. Viewing, filtering, search, login and navigation are untouched.
 *
 * Re-applies on dynamic re-renders via a MutationObserver.
 */
(function () {
  'use strict';

  // ── Generic write-control selectors (this site's conventions) ──
  var GENERIC = [
    '[data-action*="add"]', '[data-action*="create"]', '[data-action*="new"]',
    '[data-action*="edit"]', '[data-action*="delete"]', '[data-action*="remove"]',
    '[data-action*="save"]', '[data-action*="upload"]', '[data-action*="import"]',
    '[id^="btn-add"]', '[id^="btn-new"]', '[id^="btn-create"]', '[id^="btn-save"]',
    '[id^="btn-del"]', '[id^="btn-edit"]', '[id^="btn-upload"]', '[id^="btn-import"]',
    '.icon-btn.del', '.btn-delete', '.delete-btn', '.add-btn', '.edit-btn',
  ];

  // ── Per-page extras (inline-edit inputs / drag reorder that generic can't cover) ──
  var PAGE = {
    categories: { disableInputsIn: ['body'], undrag: true },
    users: { disable: ['.folder-gantt-select', '.folder-access-select', '.folder-docs-select', '.folder-materials-select', '.folder-sales-select'] },
    missions: { disable: ['#sp-status', '#sp-priority', '#sp-due'] },
  };

  // onclick handlers that clearly perform a write (verb + capital → a function call)
  var WRITE_VERB = /\b(save|create|add|delete|remove|update|insert|upload|submit|approve|confirm|send|mark|assign|reorder)[A-Z_(]/;
  var SKIP_VERB = /\b(close|cancel|open|toggle|show|hide|load|filter|search|export|print|login|logout|nav|switch|select|expand|collapse|view|download|copy|refresh|back|next|prev|scroll|zoom|reload|logError|translate)/i;

  var page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/i, '');

  function hide(el) { if (el) el.style.display = 'none'; }
  function disableEl(el) {
    if (!el || el.dataset.roFrozen) return;
    el.dataset.roFrozen = '1';
    el.disabled = true;
    el.style.pointerEvents = 'none';
    el.style.opacity = '0.5';
    el.setAttribute('title', 'Только для чтения');
    el.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); }, true);
  }
  function hideAll(sel) { document.querySelectorAll(sel).forEach(hide); }
  function disableAll(sel) { document.querySelectorAll(sel).forEach(disableEl); }
  function disableInputsIn(sel) {
    document.querySelectorAll(sel).forEach(function (root) {
      root.querySelectorAll('input, select, textarea').forEach(function (el) {
        var type = (el.getAttribute('type') || '').toLowerCase();
        // keep search/filter controls usable
        if (type === 'search' || el.classList.contains('filter') || el.id.indexOf('search') > -1 || el.id.indexOf('filter') > -1) return;
        disableEl(el);
      });
    });
  }
  function undrag() { document.querySelectorAll('[draggable="true"]').forEach(function (el) { el.setAttribute('draggable', 'false'); }); }

  function freeze() {
    GENERIC.forEach(hideAll);
    // onclick write-verb heuristic (catches modal Save/Create buttons with inline handlers)
    document.querySelectorAll('[onclick]').forEach(function (el) {
      var oc = el.getAttribute('onclick') || '';
      if (WRITE_VERB.test(oc) && !SKIP_VERB.test(oc)) hide(el);
    });
    var cfg = PAGE[page];
    if (cfg) {
      (cfg.hide || []).forEach(hideAll);
      (cfg.disable || []).forEach(disableAll);
      (cfg.disableInputsIn || []).forEach(disableInputsIn);
      if (cfg.undrag) undrag();
    }
  }

  function start() {
    freeze();
    var mo = new MutationObserver(function () { freeze(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
