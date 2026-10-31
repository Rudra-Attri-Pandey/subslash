document.addEventListener('DOMContentLoaded', () => {
  // XSS guard: escape user-supplied / AI-generated strings before innerHTML
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Only allow http(s) links into the modal action (blocks javascript: XSS).
  function safeUrl(raw, fallback) {
    try {
      const u = new URL(String(raw), window.location.origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch { /* fall through */ }
    return fallback;
  }

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const fileInfo = document.getElementById('file-info');
  const scannerLoader = document.getElementById('scanner-loader');
  const btnLoadSample = document.getElementById('btn-load-sample');
  const btnScanText = document.getElementById('btn-scan-text');
  const statementText = document.getElementById('statement-text');
  const scanError = document.getElementById('scan-error');
  const subsList = document.getElementById('subs-list');
  const dismissBanner = document.getElementById('dismiss-banner');

  // KPI elements
  const kpiTotalSpent = document.getElementById('kpi-total-spent');
  const kpiDetectedCount = document.getElementById('kpi-detected-count');
  const kpiSavings = document.getElementById('kpi-savings');

  // Modal elements
  const cancelModal = document.getElementById('cancel-modal');
  const modalClose = document.getElementById('modal-close');
  const modalSubName = document.getElementById('modal-sub-name');
  const modalSubCost = document.getElementById('modal-sub-cost');
  const modalStepsList = document.getElementById('modal-steps-list');
  const modalCancelLink = document.getElementById('modal-cancel-link');
  const modalMarkDone = document.getElementById('modal-mark-done');

  let activeSubs = [];
  let totalSavings = 0;
  let activeCancelIndex = null;

  // Cancel guides are served by the backend (GET /api/guides); this is only
  // a fallback so the modal still works if the backend is unreachable.
  let cancelGuides = {};
  const genericGuide = (name) => ({
    steps: [
      `Open your account settings for ${name}.`,
      'Look under Membership, Billing, or Subscriptions.',
      'Choose Cancel and confirm. Contact support if no cancel button exists.',
    ],
    link: `https://www.google.com/search?q=${encodeURIComponent(`cancel ${name} subscription`)}`,
  });

  fetch('/api/guides')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && j.guides) cancelGuides = j.guides; })
    .catch(() => { /* offline fallback below */ });

  // Explicitly labeled demo data — only used by the "Try sample data" button.
  // Real scans render server-detected subscriptions instead.
  const sampleSubscriptions = [
    { name: "Netflix", cost: 15.49, category: "Entertainment", logo: "🍿", status: "active" },
    { name: "Spotify Premium", cost: 10.99, category: "Music", logo: "🎵", status: "active" },
    { name: "Tinder Gold", cost: 24.99, category: "Social", logo: "💖", status: "active" },
    { name: "Claude Pro", cost: 20.00, category: "AI Tools", logo: "🤖", status: "active" }
  ];

  const CATEGORY_LOGOS = {
    entertainment: '🍿', music: '🎵', social: '💖', 'ai tools': '🤖', saas: '🧰',
    software: '🧰', gaming: '🎮', news: '📰', fitness: '💪', health: '💪',
    food: '🍔', shopping: '🛍️', travel: '✈️', finance: '🏦', utilities: '💡',
    storage: '☁️', cloud: '☁️', education: '🎓', dating: '💖',
  };
  const logoFor = (category) => CATEGORY_LOGOS[String(category || '').toLowerCase()] || '🧾';

  const updateDashboard = () => {
    const totalSpent = activeSubs
      .filter(s => s.status === 'active')
      .reduce((sum, s) => sum + s.cost, 0);

    const activeCount = activeSubs.filter(s => s.status === 'active').length;

    kpiTotalSpent.textContent = `$${totalSpent.toFixed(2)}`;
    kpiDetectedCount.textContent = activeCount;
    kpiSavings.textContent = `$${totalSavings.toFixed(2)}`;

    // Render list
    if (activeSubs.length === 0) {
      subsList.innerHTML = `
        <div class="empty-state">
          <p>Upload a statement to detect recurring subscriptions.</p>
        </div>
      `;
    } else {
      subsList.innerHTML = activeSubs.map((sub, index) => `
        <div class="sub-item">
          <div class="sub-details">
            <div class="sub-logo">${escapeHtml(sub.logo)}</div>
            <div class="sub-info">
              <h4>${escapeHtml(sub.name)}</h4>
              <p>${escapeHtml(sub.category)}</p>
            </div>
          </div>
          <div class="sub-action">
            <span class="sub-price">$${Number(sub.cost).toFixed(2)}/mo</span>
            ${sub.status === 'active'
              ? `<button class="btn-cancel" data-cancel-index="${index}">Cancel</button>`
              : `<span class="sub-status cancelled">Cancelled</span>`
            }
          </div>
        </div>
      `).join('');
    }
  };

  const showError = (msg) => {
    scanError.textContent = msg;
    scanError.classList.remove('hidden');
  };
  const clearError = () => {
    scanError.textContent = '';
    scanError.classList.add('hidden');
  };

  const setScanning = (on) => {
    scannerLoader.classList.toggle('hidden', !on);
    dropZone.classList.toggle('hidden', on);
  };

  // Map the server schema {name, amount, currency, cycle, category, confidence}
  // onto the dashboard's {name, cost, category, logo, status} rows.
  const toRow = (s) => {
    const monthly = s.cycle === 'yearly' ? s.amount / 12
      : s.cycle === 'quarterly' ? s.amount / 3
      : s.cycle === 'weekly' ? s.amount * 4.33 : s.amount;
    return {
      name: s.name,
      cost: Math.round(monthly * 100) / 100,
      category: `${s.category} · ${s.cycle} · ${s.confidence} confidence`,
      logo: logoFor(s.category),
      status: 'active',
    };
  };

  const applyScanResult = (payload, label) => {
    activeSubs = (payload.subscriptions || []).map(toRow);
    totalSavings = 0;
    setScanning(false);
    updateDashboard();
    if (fileInfo && label) fileInfo.textContent = label;
  };

  const failScan = (msg) => {
    setScanning(false);
    showError(msg);
  };

  const scanText = async (text) => {
    clearError();
    if (!text.trim()) {
      showError('Paste some statement text first, or upload a PDF/CSV/TXT file.');
      return;
    }
    setScanning(true);
    try {
      const r = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        failScan(j.error || `Scan failed (HTTP ${r.status}).`);
        return;
      }
      applyScanResult(j, `Scanned pasted text — ${j.subscriptions.length} subscription(s) detected.`);
      if (!j.subscriptions.length) showError('No recurring subscriptions detected in that text.');
    } catch (e) {
      failScan(`Could not reach the scan backend: ${e.message}. Is the server running?`);
    }
  };

  const scanFile = async (file) => {
    clearError();
    if (file.size > 5 * 1024 * 1024) {
      showError('File exceeds the 5MB limit.');
      return;
    }
    if (!/\.(pdf|csv|txt)$/i.test(file.name)) {
      showError('Only PDF, CSV, or TXT files are accepted.');
      return;
    }
    setScanning(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await fetch('/api/scan', { method: 'POST', body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        failScan(j.error || `Scan failed (HTTP ${r.status}).`);
        return;
      }
      applyScanResult(j, `Scanned ${file.name} — ${j.subscriptions.length} subscription(s) detected.`);
      if (!j.subscriptions.length) showError('No recurring subscriptions detected in that file.');
    } catch (e) {
      failScan(`Could not reach the scan backend: ${e.message}. Is the server running?`);
    }
  };

  const loadSampleData = () => {
    clearError();
    activeSubs = JSON.parse(JSON.stringify(sampleSubscriptions)); // Clone sample data
    totalSavings = 0;
    updateDashboard();
    if (fileInfo) fileInfo.textContent = 'Showing sample data — upload a statement for a real AI scan.';
  };

  // Drag & drop handlers
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--accent)';
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = 'var(--border)';
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) scanFile(file);
  });

  dropZone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      scanFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  btnLoadSample.addEventListener('click', loadSampleData);
  btnScanText.addEventListener('click', () => scanText(statementText.value || ''));

  if (dismissBanner) {
    dismissBanner.addEventListener('click', () => {
      dismissBanner.parentElement.style.display = 'none';
    });
  }

  // Event delegation for Cancel buttons (avoids inline onclick, CSP-safe).
  subsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cancel-index]');
    if (!btn) return;
    openCancelModal(Number(btn.getAttribute('data-cancel-index')));
  });

  // Modal actions
  const openCancelModal = (index) => {
    const sub = activeSubs[index];
    if (!sub) return;
    activeCancelIndex = index;

    modalSubName.textContent = `Cancel ${sub.name}`;
    modalSubCost.textContent = `$${sub.cost.toFixed(2)}/mo`;

    const guide = cancelGuides[sub.name] || cancelGuides[sub.name.split(' ')[0]] || genericGuide(sub.name);

    modalStepsList.innerHTML = (guide.steps || []).map(step => `<li>${escapeHtml(step)}</li>`).join('');
    modalCancelLink.href = safeUrl(guide.link, genericGuide(sub.name).link);

    cancelModal.classList.remove('hidden');
  };

  modalClose.addEventListener('click', () => {
    cancelModal.classList.add('hidden');
  });

  modalMarkDone.addEventListener('click', () => {
    if (activeCancelIndex !== null) {
      const sub = activeSubs[activeCancelIndex];
      sub.status = 'cancelled';
      totalSavings += sub.cost;
      cancelModal.classList.add('hidden');
      updateDashboard();
    }
  });

  updateDashboard();
});
