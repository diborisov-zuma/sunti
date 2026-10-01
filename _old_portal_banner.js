/*
 * _old_portal_banner.js — крупная плашка «это СТАРЫЙ кабинет» на страницах старого клиентского
 * портала (portal.html, portal_documentation.html, portal_gantt.html).
 *
 * Зачем (01.10.2026): старый портал читает старую базу, которая больше не обновляется. Клиенты
 * Виллы 2 видели здесь 2 контракта Prompt Team из 7 и принимали это за актуальную картину.
 * Живые данные — в новом портале (portal.suntiresidence.com). Плашку нельзя закрыть, она
 * закреплена сверху и говорит на языке, выбранном в кабинете (RU / EN / TH).
 */
(function () {
  'use strict';

  var NEW_URL = 'https://portal.suntiresidence.com';
  var TEXT = {
    ru: { main: 'Это СТАРЫЙ кабинет. Данные здесь больше не обновляются и могут быть неактуальными.',
          link: 'Актуальные данные — в новом портале:' },
    en: { main: 'This is the OLD customer portal. Data here is no longer updated and may be outdated.',
          link: 'The current data is in the new portal:' },
    th: { main: 'นี่คือพอร์ทัลลูกค้าแบบเก่า ข้อมูลในนี้ไม่มีการอัปเดตอีกต่อไปแล้ว และอาจไม่ตรงกับความเป็นจริง',
          link: 'ข้อมูลล่าสุดอยู่ในพอร์ทัลใหม่:' },
  };

  function lang() {
    var l;
    try { l = (typeof currentLang !== 'undefined' && currentLang) || localStorage.getItem('lang'); } catch (e) { l = null; }
    return TEXT[l] ? l : 'en';
  }

  var bar = document.createElement('div');
  bar.id = 'old-portal-banner';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = [
    'position:sticky', 'top:0', 'z-index:1000', 'background:#b91c1c', 'color:#fff',
    'text-align:center', 'font-weight:700', 'line-height:1.35', 'padding:14px 18px',
    'box-shadow:0 2px 10px rgba(0,0,0,0.25)', 'font-family:inherit',
  ].join(';');

  function render() {
    var t = TEXT[lang()];
    var narrow = window.innerWidth < 640;
    bar.style.fontSize = narrow ? '1.05rem' : '1.3rem';
    bar.innerHTML =
      '<div>&#9888;&#65039; ' + t.main + '</div>' +
      '<div style="margin-top:6px;font-size:' + (narrow ? '0.95rem' : '1.1rem') + '">' + t.link +
      ' <a href="' + NEW_URL + '" style="color:#fff;text-decoration:underline;white-space:nowrap">portal.suntiresidence.com</a></div>';
    // Шапка портала тоже «липкая» — сдвигаем её под плашку, иначе плашка её перекроет.
    var h = document.querySelector('.portal-header, .header');
    if (h && getComputedStyle(h).position === 'sticky') h.style.top = bar.offsetHeight + 'px';
  }

  function mount() {
    if (!document.body || document.getElementById('old-portal-banner')) return;
    document.body.insertBefore(bar, document.body.firstChild);
    render();
    window.addEventListener('resize', render);
    // Язык меняется кнопками RU/EN/TH через setLang (_i18n.js) — перерисовываемся вместе с ним.
    if (typeof window.setLang === 'function' && !window.setLang.__banner) {
      var orig = window.setLang;
      window.setLang = function (l) { var r = orig.apply(this, arguments); render(); return r; };
      window.setLang.__banner = true;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
