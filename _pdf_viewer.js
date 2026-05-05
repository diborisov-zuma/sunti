/**
 * Shared PDF Viewer using PDF.js
 * Usage:
 *   1. Include this script + PDF.js CDN in your HTML
 *   2. Add <div id="modal-pdf-viewer"></div> anywhere in body
 *   3. Call openPdfViewer(url, fileName) to open
 *   4. Call closePdfViewer() to close
 */

(function () {
  // PDF.js worker
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  let _pdfDoc = null;
  let _currentPage = 1;
  let _totalPages = 0;
  let _rendering = false;
  let _scale = 1.5;

  // Inject modal HTML on load
  function injectModal() {
    if (document.getElementById('modal-pdf-viewer')) return;
    const div = document.createElement('div');
    div.id = 'modal-pdf-viewer';
    div.className = 'modal-overlay';
    div.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:300;align-items:center;justify-content:center';
    div.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:90vw;height:90vh;max-width:1200px;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:10px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e8e8e8">
          <span id="pdfv-title" style="font-size:0.9rem;font-weight:500;color:#222"></span>
          <div style="display:flex;align-items:center;gap:8px">
            <a id="pdfv-newtab" href="#" target="_blank" style="font-size:0.78rem;color:#1a73e8;text-decoration:none" title="Open in new tab">↗</a>
            <button class="btn btn-outline" id="pdfv-close" style="padding:2px 10px">✕</button>
          </div>
        </div>
        <div id="pdfv-loading" style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px">
          <div style="width:32px;height:32px;border:3px solid #e8e8e8;border-top-color:#1a73e8;border-radius:50%;animation:spin 0.8s linear infinite"></div>
          <span id="pdfv-progress" style="font-size:0.85rem;color:#888">0%</span>
        </div>
        <div id="pdfv-content" style="flex:1;overflow:auto;display:none;background:#f4f4f4;text-align:center;padding:8px 0">
          <canvas id="pdfv-canvas" style="max-width:100%;box-shadow:0 2px 8px rgba(0,0,0,0.15)"></canvas>
        </div>
        <div id="pdfv-nav" style="display:none;padding:8px 16px;border-top:1px solid #e8e8e8;display:flex;align-items:center;justify-content:center;gap:16px;background:#fff">
          <button class="btn btn-outline" id="pdfv-prev" style="padding:4px 12px;font-size:0.85rem">◀</button>
          <span id="pdfv-page-info" style="font-size:0.85rem;color:#555"></span>
          <button class="btn btn-outline" id="pdfv-next" style="padding:4px 12px;font-size:0.85rem">▶</button>
          <button class="btn btn-outline" id="pdfv-zoom-out" style="padding:4px 8px;font-size:0.85rem">−</button>
          <span id="pdfv-zoom-level" style="font-size:0.78rem;color:#888;min-width:40px;text-align:center">150%</span>
          <button class="btn btn-outline" id="pdfv-zoom-in" style="padding:4px 8px;font-size:0.85rem">+</button>
        </div>
      </div>
    `;
    document.body.appendChild(div);

    // Event listeners
    document.getElementById('pdfv-close').addEventListener('click', closePdfViewer);
    document.getElementById('pdfv-prev').addEventListener('click', () => goToPage(_currentPage - 1));
    document.getElementById('pdfv-next').addEventListener('click', () => goToPage(_currentPage + 1));
    document.getElementById('pdfv-zoom-in').addEventListener('click', () => setZoom(_scale + 0.25));
    document.getElementById('pdfv-zoom-out').addEventListener('click', () => setZoom(_scale - 0.25));

    // Close on overlay click
    div.addEventListener('click', (e) => {
      if (e.target === div) closePdfViewer();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && div.style.display === 'flex') closePdfViewer();
    });
  }

  async function openPdfViewer(url, fileName) {
    injectModal();

    const modal = document.getElementById('modal-pdf-viewer');
    const loading = document.getElementById('pdfv-loading');
    const content = document.getElementById('pdfv-content');
    const nav = document.getElementById('pdfv-nav');
    const progress = document.getElementById('pdfv-progress');
    const newtab = document.getElementById('pdfv-newtab');

    // Reset state
    document.getElementById('pdfv-title').textContent = fileName || 'PDF';
    newtab.href = url;
    loading.style.display = 'flex';
    content.style.display = 'none';
    nav.style.display = 'none';
    progress.textContent = '0%';
    _pdfDoc = null;
    _currentPage = 1;
    _scale = 1.5;

    // Show modal
    modal.style.display = 'flex';

    try {
      // Fetch with progress
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to load PDF');

      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      const reader = response.body.getReader();
      const chunks = [];
      let loaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total > 0) {
          const pct = Math.round((loaded / total) * 100);
          progress.textContent = pct + '%';
        } else {
          progress.textContent = formatBytes(loaded);
        }
      }

      // Combine chunks
      const pdfData = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        pdfData.set(chunk, offset);
        offset += chunk.length;
      }

      progress.textContent = '100%';

      // Load PDF.js document
      _pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
      _totalPages = _pdfDoc.numPages;

      // Show content
      loading.style.display = 'none';
      content.style.display = 'block';
      nav.style.display = _totalPages > 0 ? 'flex' : 'none';

      updateZoomLabel();
      renderPage(_currentPage);

    } catch (err) {
      console.error('PDF load error:', err);
      progress.textContent = 'Error loading PDF';
      setTimeout(() => closePdfViewer(), 2000);
    }
  }

  async function renderPage(num) {
    if (!_pdfDoc || _rendering) return;
    _rendering = true;

    const page = await _pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale: _scale });
    const canvas = document.getElementById('pdfv-canvas');
    const ctx = canvas.getContext('2d');

    // Handle high-DPI
    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Update nav
    _currentPage = num;
    document.getElementById('pdfv-page-info').textContent = num + ' / ' + _totalPages;
    document.getElementById('pdfv-prev').disabled = num <= 1;
    document.getElementById('pdfv-next').disabled = num >= _totalPages;

    _rendering = false;
  }

  function goToPage(num) {
    if (num < 1 || num > _totalPages) return;
    renderPage(num);
    // Scroll to top of content
    document.getElementById('pdfv-content').scrollTop = 0;
  }

  function setZoom(newScale) {
    if (newScale < 0.5 || newScale > 4) return;
    _scale = newScale;
    updateZoomLabel();
    renderPage(_currentPage);
  }

  function updateZoomLabel() {
    const el = document.getElementById('pdfv-zoom-level');
    if (el) el.textContent = Math.round(_scale * 100) + '%';
  }

  function closePdfViewer() {
    const modal = document.getElementById('modal-pdf-viewer');
    if (modal) modal.style.display = 'none';
    _pdfDoc = null;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // Expose globally
  window.openPdfViewer = openPdfViewer;
  window.closePdfViewer = closePdfViewer;
})();
