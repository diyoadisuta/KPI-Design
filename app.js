/* ========================================
   KPI Dashboard — Divisi Design
   Application Logic
   ======================================== */

// ===== Global State =====
let rawData = [];
let filteredData = [];
let currentPage = 1;
const pageSize = 20;
let sortCol = null;
let sortDir = 'none';
let charts = {};
let inactiveDesigners = new Set(); // Stores lowercase names of inactive designers
let dataSource = 'loading'; // 'supabase', 'json', 'error'
let skipReview = false; // When true, speed = File In → CTP only (no Review fallback)

// ===== KPI Standard Targets =====
const KPI_TARGETS = {
  speedDays: 12,       // Standard on target: ≤ 12 hari
  projectsPerMonth: 16 // Standard on target: ≥ 16 project per bulan
};

// Designer color map
const designerColors = {
  'dio': { bg: 'rgba(6, 182, 212, 0.8)', border: '#06b6d4' },
  'dina': { bg: 'rgba(139, 92, 246, 0.8)', border: '#8b5cf6' },
  'rizky': { bg: 'rgba(16, 185, 129, 0.8)', border: '#10b981' },
  'galang': { bg: 'rgba(236, 72, 153, 0.8)', border: '#ec4899' },
  'rizky mahendra': { bg: 'rgba(245, 158, 11, 0.8)', border: '#f59e0b' },
  'effendy': { bg: 'rgba(99, 102, 241, 0.8)', border: '#6366f1' },
  'naufal': { bg: 'rgba(244, 63, 94, 0.8)', border: '#f43f5e' },
};

const defaultColor = { bg: 'rgba(148, 163, 184, 0.8)', border: '#94a3b8' };

function getDesignerColor(name) {
  return designerColors[name?.toLowerCase()] || defaultColor;
}

// ===== Initialization =====
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved update timestamp & inactive designers
  loadUpdateTimestamp();
  loadInactiveDesigners();
  loadSkipReviewSetting();
  loadOdooMetadata();

  // Try loading from Supabase first, fallback to data.json
  let loadedFromSupabase = false;

  if (supabaseClient) {
    try {
      updateDbStatus('connecting');
      let allData = [];
      let page = 0;
      const pageSize = 1000;

      while (true) {
        const { data, error } = await supabaseClient
          .from('kpi_projects')
          .select('*')
          .order('order_date', { ascending: false })
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;
        allData.push(...data);
        if (data.length < pageSize) break; // Reached last page
        page++;
      }

      if (allData.length > 0) {
        rawData = allData.map(mapDbToJs);
        dataSource = 'supabase';
        loadedFromSupabase = true;
        processAndRender(rawData);
        updateDataTimestamp(`Supabase Database (${rawData.length} records)`);
        updateDbStatus('connected');
        console.log(`✅ Loaded ${rawData.length} records from Supabase`);
      } else {
        console.log('ℹ️ Supabase table is empty, will try data.json fallback');
        updateDbStatus('connected');
      }
    } catch (e) {
      console.warn('⚠️ Supabase load failed:', e.message);
      updateDbStatus('error');
    }
  } else {
    updateDbStatus('disconnected');
  }

  // Fallback to data.json if Supabase didn't load
  if (!loadedFromSupabase) {
    try {
      const resp = await fetch('data.json');
      if (!resp.ok) throw new Error('data.json not found');
      rawData = await resp.json();
      dataSource = 'json';
      processAndRender(rawData);

      if (!localStorage.getItem('kpi_update_time')) {
        updateDataTimestamp('data.json (lokal)');
      }

      // Show sync button if Supabase is available but data came from JSON
      if (supabaseClient) {
        showSyncButton();
        showToast('📂 Data dimuat dari file lokal. Klik "Sync ke DB" untuk migrasi ke database.', 'info');
      }
    } catch (e) {
      console.error('Error loading data:', e);
      dataSource = 'error';
      showToast('Gagal memuat data. Silakan upload file Excel.', 'error');
    }
  }

  setTimeout(() => {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }, 600);

  setupEventListeners();
});

// ===== Event Listeners =====
function setupEventListeners() {
  // Upload
  document.getElementById('openUploadBtn').addEventListener('click', () => {
    document.getElementById('uploadOverlay').classList.add('active');
  });
  document.getElementById('uploadClose').addEventListener('click', () => {
    document.getElementById('uploadOverlay').classList.remove('active');
  });
  document.getElementById('uploadOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('uploadOverlay')) {
      document.getElementById('uploadOverlay').classList.remove('active');
    }
  });
  document.getElementById('uploadFileBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', handleFileUpload);

  // Export
  document.getElementById('exportBtn').addEventListener('click', exportToExcel);

  // Drag & drop
  const modal = document.getElementById('uploadModal');
  modal.addEventListener('dragover', (e) => {
    e.preventDefault();
    modal.classList.add('drag-over');
  });
  modal.addEventListener('dragleave', () => {
    modal.classList.remove('drag-over');
  });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    modal.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) parseExcelFile(file);
  });

  // Filters
  document.getElementById('filterDesigner').addEventListener('change', applyFilters);
  document.getElementById('filterProduct').addEventListener('change', applyFilters);
  document.getElementById('filterMonth').addEventListener('change', applyFilters);
  document.getElementById('filterStatus').addEventListener('change', applyFilters);
  document.getElementById('filterDateStart').addEventListener('change', applyFilters);
  document.getElementById('filterDateEnd').addEventListener('change', applyFilters);
  document.getElementById('filterReset').addEventListener('click', resetFilters);

  // Sync to DB button
  const syncBtn = document.getElementById('syncDbBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', migrateToSupabase);
  }

  // Odoo Sync button
  const odooSyncBtn = document.getElementById('odooSyncBtn');
  if (odooSyncBtn) {
    odooSyncBtn.addEventListener('click', syncFromOdoo);
  }

  // Kanban search
  let kanbanSearchTimeout;
  const kanbanSearchInput = document.getElementById('kanbanSearch');
  if (kanbanSearchInput) {
    kanbanSearchInput.addEventListener('input', (e) => {
      clearTimeout(kanbanSearchTimeout);
      kanbanSearchTimeout = setTimeout(() => {
        renderKanbanBoard(e.target.value);
      }, 300);
    });
  }

  // Task Edit Modal
  const taskEditClose = document.getElementById('taskEditClose');
  const taskEditCancel = document.getElementById('taskEditCancel');
  const taskEditSave = document.getElementById('taskEditSave');
  const taskEditOverlay = document.getElementById('taskEditOverlay');

  if (taskEditClose) taskEditClose.addEventListener('click', closeTaskEditModal);
  if (taskEditCancel) taskEditCancel.addEventListener('click', closeTaskEditModal);
  if (taskEditSave) taskEditSave.addEventListener('click', saveTaskToOdoo);
  if (taskEditOverlay) {
    taskEditOverlay.addEventListener('click', (e) => {
      if (e.target === taskEditOverlay) closeTaskEditModal();
    });
  }

  // Table search
  let searchTimeout;
  document.getElementById('tableSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentPage = 1;
      applyFilters();
    }, 300);
  });

  // Table sort
  document.querySelectorAll('.data-table th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : sortDir === 'desc' ? 'none' : 'asc';
      } else {
        sortCol = col;
        sortDir = 'asc';
      }
      document.querySelectorAll('.data-table th').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      if (sortDir === 'asc') th.classList.add('sort-asc');
      else if (sortDir === 'desc') th.classList.add('sort-desc');
      renderTable();
    });
  });

  // Designer Manager Panel
  const manageBtn = document.getElementById('manageDesignerBtn');
  const panelOverlay = document.getElementById('designerPanelOverlay');
  const panelClose = document.getElementById('designerPanelClose');

  if (manageBtn && panelOverlay) {
    manageBtn.addEventListener('click', () => {
      renderDesignerPanel();
      panelOverlay.classList.add('active');
    });
  }

  if (panelClose && panelOverlay) {
    panelClose.addEventListener('click', () => {
      panelOverlay.classList.remove('active');
    });
  }

  if (panelOverlay) {
    panelOverlay.addEventListener('click', (e) => {
      if (e.target === panelOverlay) {
        panelOverlay.classList.remove('active');
      }
    });
  }

  // Skip Review Toggle
  const skipReviewToggle = document.getElementById('skipReviewToggle');
  if (skipReviewToggle) {
    skipReviewToggle.addEventListener('change', (e) => {
      skipReview = e.target.checked;
      saveSkipReviewSetting();
      // Recompute speed for all records
      rawData.forEach(r => {
        r.speed = computeSpeed(r);
        r.speedStatus = getSpeedStatus(r.speed, r);
      });
      applyFilters();
      const modeText = skipReview ? 'Hanya CTP (tanpa Review)' : 'CTP + Review fallback';
      showToast(`⚡ Mode perhitungan: ${modeText}`, 'info');
    });
  }

  // Mass Actions for Designer Panel
  const selectAllBtn = document.getElementById('designerSelectAll');
  const deselectAllBtn = document.getElementById('designerDeselectAll');

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      inactiveDesigners.clear();
      saveInactiveDesigners();
      renderDesignerPanel();
      populateFilters(rawData);
      applyFilters();
    });
  }

  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      const designers = [...new Set(rawData.map(r => r.design).filter(d => d && d !== 'False'))];
      designers.forEach(name => inactiveDesigners.add(name.toLowerCase()));
      saveInactiveDesigners();
      renderDesignerPanel();
      populateFilters(rawData);
      applyFilters();
    });
  }

  // Navigation Tabs
  setupTabNavigation();
}

// ===== Navigation Tabs =====
function setupTabNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      switchTab(tabId);
    });
  });

  // Restore saved tab or default to 'overview'
  const savedTab = localStorage.getItem('kpi_active_tab') || 'overview';
  switchTab(savedTab);
}

function switchTab(tabId) {
  const tabs = document.querySelectorAll('.nav-tab');
  const contents = document.querySelectorAll('.tab-content');

  let activeFound = false;
  tabs.forEach(tab => {
    if (tab.dataset.tab === tabId) {
      tab.classList.add('active');
      activeFound = true;
    } else {
      tab.classList.remove('active');
    }
  });

  if (!activeFound && tabs.length > 0) {
    tabId = 'overview';
    tabs[0].classList.add('active');
  }

  const targetViewId = 'tab' + tabId.charAt(0).toUpperCase() + tabId.slice(1);
  contents.forEach(content => {
    if (content.id === targetViewId) {
      content.classList.add('active');
    } else {
      content.classList.remove('active');
    }
  });

  localStorage.setItem('kpi_active_tab', tabId);

  // Resize charts to fit new container dimensions
  setTimeout(() => {
    Object.values(charts).forEach(chart => {
      if (chart && typeof chart.resize === 'function') {
        chart.resize();
      }
    });
  }, 50);
}

// ===== File Upload Handler =====
function handleFileUpload(e) {
  const file = e.target.files[0];
  if (file) parseExcelFile(file);
}

function parseExcelFile(file) {
  if (!file.name.match(/\.xlsx?$/i)) {
    showToast('Format file tidak valid. Gunakan .xlsx atau .xls', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const workbook = XLSX.read(e.target.result, { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: null });

      // Map Excel columns to our format
      rawData = jsonData.map(row => ({
        title: row['Title'] || '',
        customer: row['Customer'] || '',
        productDescription: row['Product Description'] || '',
        orderedQty: row['Ordered Qty'] || 0,
        deliveredQty: row['Delivered Qty'] || 0,
        assignedTo: row['Assigned to'] || '',
        sales: row['Sales'] || '',
        design: (row['Design'] !== false && row['Design']) ? String(row['Design']) : '',
        tags: row['Tags'] || '',
        stage: row['Stage'] || '',
        orderDate: toISO(row['Order Date']),
        deadline: toISO(row['Deadline']),
        fileIn: toISO(row['File In']),
        progressAW: toISO(row['Progress AW']),
        sendAWkeCust: toISO(row['Send AW ke Cust']),
        accAWdariCust: toISO(row['ACC AW dari Cust']),
        sendKeDigitalPrint: toISO(row['Send ke Digital Print']),
        receiveDigital: toISO(row['Receive Digital']),
        sendDigitalKeCust: toISO(row['Send Digital ke Cust']),
        accDigitalDariCust: toISO(row['ACC Digital dari Cust']),
        progressDummy: toISO(row['Progress Dummy']),
        sendDummy: toISO(row['Send Dummy']),
        accDummyDariCust: toISO(row['ACC Dummy dari Cust']),
        progressLayout: toISO(row['Progress Layout']),
        lemparFileKeCTP: toISO(row['Lempar file ke CTP']),
        progressLayoutCTP: toISO(row['Progress Layout CTP']),
        doneLayoutCTP: toISO(row['Done Layout CTP']),
        review: toISO(row['Review']),
        keluarPlat: toISO(row['Keluar Plat']),
        progressRevisiAW: toISO(row['Progress Revisi AW']),
        progressRevisiDummy: toISO(row['Progress Revisi Dummy']),
        manufactureBaru: !!row['Manufacture/cetak baru'],
        manufactureRepeat: !!row['Manufacture/Repeat'],
        manufactureRepeatPerubahan: !!row['Manufacture/Repeat Perubahan'],
      }));

      document.getElementById('uploadOverlay').classList.remove('active');
      processAndRender(rawData);

      // Upload to Supabase if available
      if (supabaseClient) {
        try {
          showToast(`⏳ Menyimpan ${rawData.length} data ke database...`, 'info');
          await uploadToSupabase(rawData);
          dataSource = 'supabase';
          updateDataTimestamp(file.name);
          updateDbStatus('connected');
          hideSyncButton();
          showToast(`✅ ${rawData.length} data dari ${file.name} berhasil disimpan ke database`, 'success');
        } catch (dbErr) {
          console.error('Supabase upload error:', dbErr);
          updateDataTimestamp(file.name);
          showToast(`✅ ${rawData.length} data dimuat lokal dari ${file.name}. ⚠️ Gagal sync ke database: ${dbErr.message}`, 'warning');
        }
      } else {
        updateDataTimestamp(file.name);
        showToast(`✅ Berhasil memuat ${rawData.length} data dari ${file.name}`, 'success');
      }
    } catch (err) {
      console.error('Parse error:', err);
      showToast('Gagal memproses file Excel. Pastikan format sesuai.', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function toISO(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string' && !isNaN(Date.parse(val))) return new Date(val).toISOString();
  return null;
}

// ===== Data Processing =====
function processAndRender(data) {
  // Compute speed for each record
  data.forEach(r => {
    r.speed = computeSpeed(r);
    r.speedStatus = getSpeedStatus(r.speed, r);
  });

  populateFilters(data);
  applyFilters();

  // Enable export button
  document.getElementById('exportBtn').disabled = data.length === 0;
}

function computeSpeed(record) {
  const fileIn = record.fileIn ? new Date(record.fileIn) : null;
  const ctp = record.lemparFileKeCTP ? new Date(record.lemparFileKeCTP) : null;
  const review = record.review ? new Date(record.review) : null;

  if (!fileIn) return null;

  // When skipReview is ON, only use CTP date (no Review fallback)
  const endDate = skipReview ? ctp : (ctp || review);
  if (!endDate) return null;

  const diffMs = endDate - fileIn;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return Math.round(diffDays * 10) / 10;
}

function getSpeedStatus(speed, record) {
  if (speed === null) {
    if (record && record.fileIn) {
      return 'progress';
    }
    return 'no-data';
  }
  if (speed < 0) return 'anomaly';
  if (speed <= 3) return 'fast';
  if (speed > 14) return 'slow';
  return 'normal';
}

// ===== Filters =====
function populateFilters(data) {
  // Designers
  const designers = [...new Set(data.map(r => r.design).filter(d => d && d !== 'False'))].sort();
  const designerSelect = document.getElementById('filterDesigner');
  designerSelect.innerHTML = '<option value="">Semua Designer</option>';
  designers.forEach(d => {
    const isInactive = inactiveDesigners.has(d.toLowerCase());
    const label = d.charAt(0).toUpperCase() + d.slice(1) + (isInactive ? ' (Nonaktif)' : '');
    designerSelect.innerHTML += `<option value="${d}">${label}</option>`;
  });

  // Products
  const products = [...new Set(data.map(r => r.title).filter(Boolean))].sort();
  const productSelect = document.getElementById('filterProduct');
  productSelect.innerHTML = '<option value="">Semua Produk</option>';
  products.forEach(p => {
    productSelect.innerHTML += `<option value="${p}">${p}</option>`;
  });

  // Months
  const months = new Set();
  data.forEach(r => {
    const d = r.orderDate ? new Date(r.orderDate) : null;
    if (d) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.add(key);
    }
  });
  const monthsSorted = [...months].sort().reverse();
  const monthSelect = document.getElementById('filterMonth');
  monthSelect.innerHTML = '<option value="">Semua Bulan</option>';
  monthsSorted.forEach(m => {
    const [y, mo] = m.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    monthSelect.innerHTML += `<option value="${m}">${monthNames[parseInt(mo) - 1]} ${y}</option>`;
  });
}

function applyFilters() {
  const designer = document.getElementById('filterDesigner').value;
  const product = document.getElementById('filterProduct').value;
  const month = document.getElementById('filterMonth').value;
  const status = document.getElementById('filterStatus').value;
  const dateStart = document.getElementById('filterDateStart').value;
  const dateEnd = document.getElementById('filterDateEnd').value;
  const search = document.getElementById('tableSearch').value.toLowerCase().trim();

  filteredData = rawData.filter(r => {
    // Exclude inactive designers unless that specific designer is selected in the filter
    if (!designer && r.design && inactiveDesigners.has(r.design.toLowerCase())) return false;
    if (designer && r.design !== designer) return false;
    if (product && r.title !== product) return false;
    if (month) {
      const d = r.orderDate ? new Date(r.orderDate) : null;
      if (!d) return false;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (key !== month) return false;
    }
    // Date range filter (based on Order Date)
    if (dateStart || dateEnd) {
      const orderDate = r.orderDate ? new Date(r.orderDate) : null;
      if (!orderDate) return false;
      if (dateStart) {
        const start = new Date(dateStart);
        start.setHours(0, 0, 0, 0);
        if (orderDate < start) return false;
      }
      if (dateEnd) {
        const end = new Date(dateEnd);
        end.setHours(23, 59, 59, 999);
        if (orderDate > end) return false;
      }
    }
    if (status) {
      if (status === 'no-data' && r.speedStatus !== 'no-data') return false;
      if (status === 'anomaly' && r.speedStatus !== 'anomaly') return false;
      if (status === 'anomaly' && r.speedStatus !== 'anomaly') return false;
      if (status === 'fast' && r.speedStatus !== 'fast') return false;
      if (status === 'slow' && r.speedStatus !== 'slow') return false;
      if (status === 'normal' && r.speedStatus !== 'normal') return false;
      if (status === 'progress' && r.speedStatus !== 'progress') return false;
    }
    if (search) {
      const haystack = `${r.title} ${r.customer} ${r.productDescription} ${r.design} ${r.stage}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  updateSummaryCards(filteredData);
  updateKPIScorecard(filteredData);
  updateWorkloadAndBottlenecks(filteredData);
  updateCharts(filteredData);
  currentPage = 1;
  renderTable();
  renderKanbanBoard();
  updatePeriodBadge(filteredData);
}

function resetFilters() {
  document.getElementById('filterDesigner').value = '';
  document.getElementById('filterProduct').value = '';
  document.getElementById('filterMonth').value = '';
  document.getElementById('filterStatus').value = '';
  document.getElementById('filterDateStart').value = '';
  document.getElementById('filterDateEnd').value = '';
  document.getElementById('tableSearch').value = '';
  applyFilters();
}

// ===== Summary Cards =====
function updateSummaryCards(data) {
  const totalProjects = data.length;
  const speeds = data.filter(r => r.speed !== null && r.speed >= 0).map(r => r.speed);
  const avgSpeed = speeds.length > 0 ? (speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0;
  const activeDesigners = new Set(data.filter(r => r.design && r.design !== 'False').map(r => r.design)).size;
  const anomalies = data.filter(r => r.speedStatus === 'anomaly').length;

  animateCounter('totalProjects', totalProjects, '');
  animateCounter('avgSpeed', avgSpeed, ' hari', 1);
  animateCounter('activeDesigners', activeDesigners, '');
  animateCounter('anomalyCount', anomalies, '');

  document.getElementById('totalProjectsSub').textContent =
    data.length === rawData.length ? 'dari semua data' : `dari ${rawData.length} total data`;
  const modeLabel = skipReview ? 'File In → CTP only' : 'File In → CTP/Review';
  document.getElementById('avgSpeedSub').textContent =
    `${modeLabel} • ${speeds.length} data valid`;
}

function animateCounter(id, target, suffix = '', decimals = 0) {
  const el = document.getElementById(id);
  const start = parseFloat(el.textContent) || 0;
  const duration = 800;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (target - start) * eased;
    el.textContent = current.toFixed(decimals) + suffix;
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

function updatePeriodBadge(data) {
  const dates = data
    .map(r => r.orderDate ? new Date(r.orderDate) : null)
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (dates.length > 0) {
    const fmt = (d) => {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      return `${months[d.getMonth()]} ${d.getFullYear()}`;
    };
    document.getElementById('periodText').textContent = `${fmt(dates[0])} — ${fmt(dates[dates.length - 1])}`;
  }
}

// ===== Charts =====
function updateCharts(data) {
  updateSpeedPerDesignerChart(data);
  updateProjectPerDesignerChart(data);
  updateMonthlyTrendChart(data);
  updateProductTypeChart(data);
  updateWorkflowAnalysis(data);
}

// Chart.js global config
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';
Chart.defaults.font.family = "'Inter', sans-serif";

function updateSpeedPerDesignerChart(data) {
  const ctx = document.getElementById('chartSpeedDesigner');
  if (charts.speedDesigner) charts.speedDesigner.destroy();

  // Group by designer
  const groups = {};
  data.forEach(r => {
    if (!r.design || r.design === 'False' || r.speed === null || r.speed < 0) return;
    if (!groups[r.design]) groups[r.design] = [];
    groups[r.design].push(r.speed);
  });

  const labels = Object.keys(groups).sort();
  const avgSpeeds = labels.map(d => {
    const arr = groups[d];
    return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
  });
  const colors = labels.map(d => getDesignerColor(d));

  charts.speedDesigner = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
      datasets: [{
        label: 'Rata-rata Hari',
        data: avgSpeeds,
        backgroundColor: colors.map(c => c.bg),
        borderColor: colors.map(c => c.border),
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
        maxBarThickness: 56,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => `Rata-rata: ${ctx.raw} hari`,
            afterLabel: (ctx) => {
              const designer = labels[ctx.dataIndex];
              return `Total: ${groups[designer].length} project`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { weight: 600, size: 12 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            callback: (v) => v + ' hari',
            font: { size: 11 }
          }
        }
      }
    }
  });
}

function updateProjectPerDesignerChart(data) {
  const ctx = document.getElementById('chartProjectDesigner');
  if (charts.projectDesigner) charts.projectDesigner.destroy();

  const counts = {};
  data.forEach(r => {
    const d = r.design && r.design !== 'False' ? r.design : 'Belum Ditugaskan';
    counts[d] = (counts[d] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(s => s[0]);
  const values = sorted.map(s => s[1]);
  const colors = labels.map(l => getDesignerColor(l));

  charts.projectDesigner = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
      datasets: [{
        data: values,
        backgroundColor: colors.map(c => c.bg),
        borderColor: 'rgba(10, 14, 26, 0.8)',
        borderWidth: 3,
        hoverBorderColor: colors.map(c => c.border),
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart', animateRotate: true },
      cutout: '62%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            padding: 16,
            usePointStyle: true,
            pointStyle: 'circle',
            color: '#ffffff',
            font: { size: 12, weight: 500 },
            generateLabels: function (chart) {
              const data = chart.data;
              return data.labels.map((label, i) => ({
                text: `${label} (${data.datasets[0].data[i]})`,
                fillStyle: data.datasets[0].backgroundColor[i],
                fontColor: '#ffffff',
                strokeStyle: 'transparent',
                lineWidth: 0,
                pointStyle: 'circle',
                index: i,
              }));
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.raw / total) * 100).toFixed(1);
              return `${ctx.raw} project (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function updateMonthlyTrendChart(data) {
  const ctx = document.getElementById('chartMonthlyTrend');
  if (charts.monthlyTrend) charts.monthlyTrend.destroy();

  // Group by month
  const monthlyProjects = {};
  const monthlySpeeds = {};

  data.forEach(r => {
    const d = r.orderDate ? new Date(r.orderDate) : null;
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlyProjects[key] = (monthlyProjects[key] || 0) + 1;
    if (r.speed !== null && r.speed >= 0) {
      if (!monthlySpeeds[key]) monthlySpeeds[key] = [];
      monthlySpeeds[key].push(r.speed);
    }
  });

  const months = Object.keys(monthlyProjects).sort();
  const projectCounts = months.map(m => monthlyProjects[m]);
  const avgSpeedsArr = months.map(m => {
    const arr = monthlySpeeds[m];
    return arr && arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0;
  });

  const monthLabels = months.map(m => {
    const [y, mo] = m.split('-');
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return `${names[parseInt(mo) - 1]} ${y.slice(2)}`;
  });

  charts.monthlyTrend = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: monthLabels,
      datasets: [
        {
          label: 'Jumlah Project',
          data: projectCounts,
          backgroundColor: 'rgba(6, 182, 212, 0.5)',
          borderColor: '#06b6d4',
          borderWidth: 2,
          borderRadius: 6,
          borderSkipped: false,
          yAxisID: 'y',
          order: 2,
          maxBarThickness: 40,
        },
        {
          label: 'Avg Kecepatan (hari)',
          data: avgSpeedsArr,
          type: 'line',
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.1)',
          pointBackgroundColor: '#8b5cf6',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          yAxisID: 'y1',
          order: 1,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1000, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            padding: 20,
            usePointStyle: true,
            font: { size: 12, weight: 500 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 } }
        },
        y: {
          beginAtZero: true,
          position: 'left',
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            callback: (v) => v + ' prj',
            font: { size: 11 }
          },
          title: {
            display: true,
            text: 'Jumlah Project',
            color: '#06b6d4',
            font: { size: 12, weight: 600 }
          }
        },
        y1: {
          beginAtZero: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (v) => v + ' hr',
            font: { size: 11 }
          },
          title: {
            display: true,
            text: 'Avg Kecepatan (hari)',
            color: '#8b5cf6',
            font: { size: 12, weight: 600 }
          }
        }
      }
    }
  });
}

function updateProductTypeChart(data) {
  const ctx = document.getElementById('chartProductType');
  if (charts.productType) charts.productType.destroy();

  const counts = {};
  data.forEach(r => {
    if (r.title) counts[r.title] = (counts[r.title] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const labels = sorted.map(s => s[0]);
  const values = sorted.map(s => s[1]);

  // Generate gradient-like colors
  const hues = labels.map((_, i) => 180 + (i * 12)); // cyan to blue spectrum
  const bgColors = hues.map(h => `hsla(${h}, 70%, 55%, 0.7)`);
  const borderColors = hues.map(h => `hsl(${h}, 70%, 55%)`);

  charts.productType = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Jumlah Project',
        data: values,
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 2,
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 36,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            font: { size: 11 },
            callback: (v) => v + ' project'
          }
        },
        y: {
          grid: { display: false },
          ticks: {
            font: { size: 11, weight: 500 },
            autoSkip: false,
          }
        }
      }
    }
  });
}

function updateWorkflowAnalysis(data) {
  // Returns { avg, count, records[] } for each stage transition
  const getStageStats = (startKey, endKey) => {
    const records = [];
    data.forEach(r => {
      const start = r[startKey] ? new Date(r[startKey]) : null;
      const end = r[endKey] ? new Date(r[endKey]) : null;
      if (!start || !end) return;
      const diff = (end - start) / (1000 * 60 * 60 * 24);
      if (diff < 0) return;
      records.push({
        r,
        durasi: Math.round(diff * 10) / 10,
        startDate: start,
        endDate: end,
        startKey,
        endKey,
      });
    });

    if (records.length === 0) return { avg: null, count: 0, records: [] };
    const avg = records.reduce((a, b) => a + b.durasi, 0) / records.length;
    return { avg: Math.round(avg * 10) / 10, count: records.length, records };
  };

  // 1. AW Process
  const fileInToAW = getStageStats('fileIn', 'progressAW');
  const awToSendAW = getStageStats('progressAW', 'sendAWkeCust');
  const sendAWToACC = getStageStats('sendAWkeCust', 'accAWdariCust');

  // 2. Digital Process
  const sendDigToReceive = getStageStats('sendKeDigitalPrint', 'receiveDigital');
  const receiveToSendCust = getStageStats('receiveDigital', 'sendDigitalKeCust');
  const sendDigCustToACC = getStageStats('sendDigitalKeCust', 'accDigitalDariCust');

  // 3. Dummy Process
  const dummyToSend = getStageStats('progressDummy', 'sendDummy');
  const sendDummyToACC = getStageStats('sendDummy', 'accDummyDariCust');

  // 4. Layout, CTP & Review
  const layoutToReview = getStageStats('progressLayout', 'review');
  const reviewToCTP = getStageStats('review', 'lemparFileKeCTP');

  // Map: stageId -> { stats, label }
  const stageMap = {
    stageFileInToAW:     { stats: fileInToAW,       label: 'File In → Progress AW',       startKey: 'fileIn',              endKey: 'progressAW' },
    stageAWToSendAW:     { stats: awToSendAW,        label: 'Progress AW → Send AW',        startKey: 'progressAW',          endKey: 'sendAWkeCust' },
    stageSendAWToACC:    { stats: sendAWToACC,        label: 'Send AW → ACC AW',             startKey: 'sendAWkeCust',        endKey: 'accAWdariCust' },
    stageSendDigToReceive:  { stats: sendDigToReceive,  label: 'Send Digital → Receive',      startKey: 'sendKeDigitalPrint',  endKey: 'receiveDigital' },
    stageReceiveToSendCust: { stats: receiveToSendCust, label: 'Receive → Send ke Cust',      startKey: 'receiveDigital',      endKey: 'sendDigitalKeCust' },
    stageSendDigCustToACC:  { stats: sendDigCustToACC,  label: 'Send Digital → ACC Cust',     startKey: 'sendDigitalKeCust',   endKey: 'accDigitalDariCust' },
    stageDummyToSend:    { stats: dummyToSend,       label: 'Progress → Send Dummy',        startKey: 'progressDummy',       endKey: 'sendDummy' },
    stageSendDummyToACC: { stats: sendDummyToACC,    label: 'Send Dummy → ACC Cust',        startKey: 'sendDummy',           endKey: 'accDummyDariCust' },
    stageLayoutToReview: { stats: layoutToReview,    label: 'Layout → Review',              startKey: 'progressLayout',      endKey: 'review' },
    stageReviewToCTP:    { stats: reviewToCTP,        label: 'Review → Lempar File ke CTP', startKey: 'review',              endKey: 'lemparFileKeCTP' },
  };

  // Helper to update HTML card and attach click
  const updateUI = (id, maxVal = 10) => {
    const el = document.getElementById(id);
    if (!el) return;
    const info = stageMap[id];
    const stats = info.stats;
    const valEl = el.querySelector('.stage-value');
    const metaEl = el.querySelector('.stage-meta');
    const barFillEl = el.querySelector('.stage-bar-fill');

    if (stats.count > 0 && stats.avg !== null) {
      valEl.textContent = `${stats.avg} hari`;
      metaEl.textContent = `${stats.count} data`;
      const pct = Math.min(100, (stats.avg / maxVal) * 100);
      barFillEl.style.width = `${pct}%`;
    } else {
      valEl.textContent = '—';
      metaEl.textContent = '0 data';
      barFillEl.style.width = '0%';
    }

    // Clickable: attach onclick
    el.style.cursor = stats.count > 0 ? 'pointer' : 'default';
    el.onclick = stats.count > 0
      ? () => openWorkflowDetailModal(id, info.label, stats)
      : null;
  };

  updateUI('stageFileInToAW', 5);
  updateUI('stageAWToSendAW', 5);
  updateUI('stageSendAWToACC', 10);

  updateUI('stageSendDigToReceive', 5);
  updateUI('stageReceiveToSendCust', 5);
  updateUI('stageSendDigCustToACC', 10);

  updateUI('stageDummyToSend', 5);
  updateUI('stageSendDummyToACC', 10);

  updateUI('stageLayoutToReview', 5);
  updateUI('stageReviewToCTP', 10);

  // Update comparison chart
  const ctx = document.getElementById('chartWorkflow');
  if (!ctx) return;
  if (charts.workflow) charts.workflow.destroy();

  const labels = [
    'File In -> AW',
    'AW -> Send AW',
    'Send AW -> ACC',
    'Send Dig -> Recv',
    'Recv -> Send Cust',
    'Send Dig -> ACC',
    'Dummy -> Send',
    'Send Dum -> ACC',
    'Layout -> Review',
    'Review -> Lempar File ke CTP'
  ];

  const values = [
    fileInToAW.avg,
    awToSendAW.avg,
    sendAWToACC.avg,
    sendDigToReceive.avg,
    receiveToSendCust.avg,
    sendDigCustToACC.avg,
    dummyToSend.avg,
    sendDummyToACC.avg,
    layoutToReview.avg,
    reviewToCTP.avg
  ];

  const counts = [
    fileInToAW.count,
    awToSendAW.count,
    sendAWToACC.count,
    sendDigToReceive.count,
    receiveToSendCust.count,
    sendDigCustToACC.count,
    dummyToSend.count,
    sendDummyToACC.count,
    layoutToReview.count,
    reviewToCTP.count
  ];

  // Filter out stages with no data
  const activeData = labels.map((label, idx) => ({
    label,
    value: values[idx],
    count: counts[idx]
  })).filter(item => item.value !== null);

  const finalLabels = activeData.map(item => item.label);
  const finalValues = activeData.map(item => item.value);
  const finalCounts = activeData.map(item => item.count);

  const hues = finalLabels.map((_, i) => (i * 360) / finalLabels.length);
  const bgColors = hues.map(h => `hsla(${h}, 70%, 55%, 0.6)`);
  const borderColors = hues.map(h => `hsl(${h}, 70%, 55%)`);

  charts.workflow = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: finalLabels,
      datasets: [{
        label: 'Rata-rata Hari',
        data: finalValues,
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 2,
        borderRadius: 6,
        maxBarThickness: 45
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => `Rata-rata: ${ctx.raw} hari`,
            afterLabel: (ctx) => `Total: ${finalCounts[ctx.dataIndex]} data`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10, weight: 600 }, autoSkip: false }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            callback: (v) => v + ' hari',
            font: { size: 11 }
          }
        }
      }
    }
  });
}

// ===== Workflow Detail Modal =====
let _wfCurrentRecords = [];   // full list for current modal
let _wfFilteredRecords = [];  // after search/sort

function openWorkflowDetailModal(stageId, label, stats) {
  _wfCurrentRecords = stats.records.slice();
  _wfFilteredRecords = _wfCurrentRecords.slice();

  // Set header info
  document.getElementById('wfDetailStageLabel').textContent = 'Tahapan Workflow';
  document.getElementById('wfDetailTitle').textContent = label;

  // Stats badges
  const avgColor = stats.avg <= 3 ? '#10b981' : stats.avg <= 7 ? '#f59e0b' : '#ef4444';
  document.getElementById('wfDetailStats').innerHTML = `
    <span class="wf-stat-badge" style="background:${avgColor}22;color:${avgColor};border-color:${avgColor}44">
      ⏱ Avg: <strong>${stats.avg} hari</strong>
    </span>
    <span class="wf-stat-badge">
      📋 Total: <strong>${stats.count} data</strong>
    </span>
  `;

  // Reset search & sort
  document.getElementById('wfDetailSearch').value = '';
  document.getElementById('wfDetailSort').value = 'durasi-desc';

  renderWfDetailTable();

  // Show overlay
  const overlay = document.getElementById('wfDetailOverlay');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeWorkflowDetailModal() {
  document.getElementById('wfDetailOverlay').classList.remove('active');
  document.body.style.overflow = '';
}

function renderWfDetailTable() {
  const search = (document.getElementById('wfDetailSearch').value || '').toLowerCase();
  const sort = document.getElementById('wfDetailSort').value;

  let rows = _wfCurrentRecords.filter(item => {
    const r = item.r;
    const haystack = [
      r.title, r.customer, r.design, r.stage, r.productDescription
    ].join(' ').toLowerCase();
    return !search || haystack.includes(search);
  });

  // Sort
  rows.sort((a, b) => {
    if (sort === 'durasi-desc') return b.durasi - a.durasi;
    if (sort === 'durasi-asc')  return a.durasi - b.durasi;
    if (sort === 'tgl-desc')    return b.startDate - a.startDate;
    if (sort === 'tgl-asc')     return a.startDate - b.startDate;
    return 0;
  });

  const fmt = (d) => d ? new Date(d).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' }) : '—';

  const rowsHtml = rows.map((item, idx) => {
    const r = item.r;
    const speedClass = item.durasi <= 3 ? 'fast' : item.durasi <= 7 ? 'ok' : 'slow';
    const designer = r.design || '-';
    const stage = r.stage || '-';
    // Product subtitle: show productDescription if available, else customer
    const subtitle = r.productDescription || r.customer || '-';
    return `
      <tr>
        <td class="wf-td-no">${idx + 1}</td>
        <td class="wf-td-product">
          <div class="wf-product-name">${r.title || '-'}</div>
          <div class="wf-customer-name">${subtitle}</div>
        </td>
        <td class="wf-td-designer">
          <span class="wf-designer-chip">${designer}</span>
        </td>
        <td class="wf-td-stage">${stage}</td>
        <td class="wf-td-start">${fmt(item.startDate)}</td>
        <td class="wf-td-end">${fmt(item.endDate)}</td>
        <td class="wf-td-durasi">
          <span class="wf-durasi-badge wf-speed-${speedClass}">${item.durasi} hari</span>
        </td>
      </tr>`;
  }).join('');

  const tableHtml = rows.length === 0
    ? `<div class="wf-empty-state">Tidak ada data ditemukan</div>`
    : `<table class="wf-detail-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Produk / Customer</th>
            <th>Designer</th>
            <th>Stage</th>
            <th>Mulai</th>
            <th>Selesai</th>
            <th>Durasi</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;

  document.getElementById('wfDetailTableWrap').innerHTML = tableHtml;
}

// Event listeners for Workflow Detail Modal
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('wfDetailClose').addEventListener('click', closeWorkflowDetailModal);
  document.getElementById('wfDetailOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeWorkflowDetailModal();
  });
  document.getElementById('wfDetailSearch').addEventListener('input', renderWfDetailTable);
  document.getElementById('wfDetailSort').addEventListener('change', renderWfDetailTable);
});

// ===== Data Table =====
function renderTable() {
  let data = [...filteredData];

  // Sort
  if (sortCol && sortDir !== 'none') {
    data.sort((a, b) => {
      let va, vb;
      if (sortCol === 'speed') {
        va = a.speed !== null ? a.speed : (sortDir === 'asc' ? Infinity : -Infinity);
        vb = b.speed !== null ? b.speed : (sortDir === 'asc' ? Infinity : -Infinity);
      } else if (['fileIn', 'lemparFileKeCTP', 'review'].includes(sortCol)) {
        va = a[sortCol] ? new Date(a[sortCol]).getTime() : (sortDir === 'asc' ? Infinity : -Infinity);
        vb = b[sortCol] ? new Date(b[sortCol]).getTime() : (sortDir === 'asc' ? Infinity : -Infinity);
      } else if (sortCol === 'status') {
        const order = { 'anomaly': 0, 'slow': 1, 'normal': 2, 'fast': 3, 'progress': 4, 'no-data': 5 };
        va = order[a.speedStatus] ?? 6;
        vb = order[b.speedStatus] ?? 6;
      } else {
        va = (a[sortCol] || '').toString().toLowerCase();
        vb = (b[sortCol] || '').toString().toLowerCase();
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  // Pagination
  const totalPages = Math.max(1, Math.ceil(data.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  const pageData = data.slice(start, start + pageSize);

  // Render rows
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';

  if (pageData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted);">Tidak ada data ditemukan</td></tr>`;
  } else {
    pageData.forEach(r => {
      const tr = document.createElement('tr');
      if (r.speedStatus === 'anomaly') tr.classList.add('anomaly');

      const designerDot = r.design ? getDesignerColor(r.design) : defaultColor;

      tr.innerHTML = `
        <td>${escHtml(r.title)}</td>
        <td>${escHtml(r.customer)}</td>
        <td title="${escHtml(r.productDescription)}">${truncate(r.productDescription, 30)}</td>
        <td>
          ${r.design && r.design !== 'False' ? `
            <span class="designer-badge">
              <span class="designer-dot" style="background:${designerDot.border}"></span>
              ${capitalize(r.design)}
            </span>
          ` : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td>${formatDate(r.fileIn)}</td>
        <td>${formatDate(r.lemparFileKeCTP)}</td>
        <td>${formatDate(r.review)}</td>
        <td>${r.speed !== null ? `<strong>${r.speed}</strong> hari` : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td>${renderStatusBadge(r.speedStatus)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Update count
  document.getElementById('tableCount').textContent =
    `Menampilkan ${start + 1}–${Math.min(start + pageSize, data.length)} dari ${data.length} data`;

  // Pagination
  renderPagination(totalPages);
  document.getElementById('pageInfo').textContent = `Halaman ${currentPage} dari ${totalPages}`;
}

function renderPagination(totalPages) {
  const pag = document.getElementById('pagination');
  pag.innerHTML = '';

  // Prev
  const prevBtn = document.createElement('button');
  prevBtn.className = 'page-btn';
  prevBtn.textContent = '‹';
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener('click', () => { currentPage--; renderTable(); });
  pag.appendChild(prevBtn);

  // Page numbers
  const maxVisible = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

  if (startPage > 1) {
    pag.appendChild(createPageBtn(1));
    if (startPage > 2) {
      const dots = document.createElement('span');
      dots.textContent = '…';
      dots.style.cssText = 'color:var(--text-muted);padding:0 4px;';
      pag.appendChild(dots);
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    pag.appendChild(createPageBtn(i));
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      const dots = document.createElement('span');
      dots.textContent = '…';
      dots.style.cssText = 'color:var(--text-muted);padding:0 4px;';
      pag.appendChild(dots);
    }
    pag.appendChild(createPageBtn(totalPages));
  }

  // Next
  const nextBtn = document.createElement('button');
  nextBtn.className = 'page-btn';
  nextBtn.textContent = '›';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener('click', () => { currentPage++; renderTable(); });
  pag.appendChild(nextBtn);
}

function createPageBtn(page) {
  const btn = document.createElement('button');
  btn.className = `page-btn${page === currentPage ? ' active' : ''}`;
  btn.textContent = page;
  btn.addEventListener('click', () => { currentPage = page; renderTable(); });
  return btn;
}

function getReferenceToday() {
  return new Date();
}

function getLatestStageInfo(r) {
  const stages = [
    { name: 'Keluar Plat', date: r.keluarPlat },
    { name: 'Review', date: r.review },
    { name: 'Done Layout CTP', date: r.doneLayoutCTP },
    { name: 'Progress Layout CTP', date: r.progressLayoutCTP },
    { name: 'Lempar CTP', date: r.lemparFileKeCTP },
    { name: 'Progress Layout', date: r.progressLayout },
    { name: 'ACC Dummy', date: r.accDummyDariCust },
    { name: 'Send Dummy', date: r.sendDummy },
    { name: 'Progress Dummy', date: r.progressDummy },
    { name: 'ACC Digital', date: r.accDigitalDariCust },
    { name: 'Send Digital Ke Cust', date: r.sendDigitalKeCust },
    { name: 'Receive Digital', date: r.receiveDigital },
    { name: 'Send Ke Digital Print', date: r.sendKeDigitalPrint },
    { name: 'ACC AW', date: r.accAWdariCust },
    { name: 'Send AW', date: r.sendAWkeCust },
    { name: 'Progress AW', date: r.progressAW },
    { name: 'File In', date: r.fileIn },
    { name: 'Order Date', date: r.orderDate }
  ];

  // Find the stage with the chronologically latest (most recent) date
  let latest = { name: 'Belum Mulai', date: null };
  let latestTime = 0;

  for (const s of stages) {
    if (s.date) {
      const t = new Date(s.date).getTime();
      if (t > latestTime) {
        latestTime = t;
        latest = { name: s.name, date: new Date(s.date) };
      }
    }
  }
  return latest;
}

// ===== Utilities =====
function formatDate(iso) {
  if (!iso) return '<span style="color:var(--text-muted)">—</span>';
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function renderStatusBadge(status) {
  const map = {
    'normal': { cls: 'status-normal', icon: '✓', text: 'Normal' },
    'fast': { cls: 'status-fast', icon: '⚡', text: 'Cepat' },
    'slow': { cls: 'status-slow', icon: '🐢', text: 'Lambat' },
    'anomaly': { cls: 'status-anomaly', icon: '⚠️', text: 'Anomali' },
    'bottleneck': { cls: 'status-bottleneck', icon: '🚨', text: 'Bottleneck' },
    'progress': { cls: 'status-progress', icon: '🔄', text: 'Progress' },
    'no-data': { cls: 'status-na', icon: '—', text: 'N/A' },
  };
  const s = map[status] || map['no-data'];
  return `<span class="status-badge ${s.cls}">${s.icon} ${s.text}</span>`;
}

function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? escHtml(str.slice(0, max)) + '…' : escHtml(str);
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.classList.remove('show'); }, 4000);
}

// ===== KPI Scorecard per Designer =====
function updateKPIScorecard(data) {
  const section = document.getElementById('kpiScorecardSection');
  const grid = document.getElementById('scorecardGrid');

  // Group by designer
  const designerGroups = {};
  data.forEach(r => {
    if (!r.design || r.design === 'False') return;
    if (!designerGroups[r.design]) designerGroups[r.design] = [];
    designerGroups[r.design].push(r);
  });

  const designers = Object.keys(designerGroups).sort();

  if (designers.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  grid.innerHTML = '';

  // Determine the month range in filtered data for project/month calculation
  const getActiveMonths = (records) => {
    const months = new Set();
    records.forEach(r => {
      const d = r.orderDate ? new Date(r.orderDate) : (r.fileIn ? new Date(r.fileIn) : null);
      if (d) {
        months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
    });
    return Math.max(1, months.size);
  };

  designers.forEach(name => {
    const records = designerGroups[name];
    const totalProjects = records.length;
    const speeds = records.filter(r => r.speed !== null && r.speed >= 0).map(r => r.speed);
    const avgSpeed = speeds.length > 0 ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10 : null;

    const activeMonths = getActiveMonths(records);
    const projectsPerMonth = Math.round((totalProjects / activeMonths) * 10) / 10;

    const speedPass = avgSpeed !== null && avgSpeed <= KPI_TARGETS.speedDays;
    const projectPass = projectsPerMonth >= KPI_TARGETS.projectsPerMonth;
    const overallPass = speedPass && projectPass;

    // Compute KPI score (0-100%)
    const speedScore = avgSpeed !== null ? Math.min(100, Math.max(0, (1 - (avgSpeed - KPI_TARGETS.speedDays) / KPI_TARGETS.speedDays) * 100)) : 0;
    const projectScore = Math.min(100, (projectsPerMonth / KPI_TARGETS.projectsPerMonth) * 100);
    const kpiScore = Math.round((speedScore + projectScore) / 2);

    const color = getDesignerColor(name);
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    const card = document.createElement('div');
    card.className = `scorecard-card ${overallPass ? 'on-target' : 'off-target'}`;
    card.innerHTML = `
      <div class="scorecard-header">
        <div class="scorecard-designer">
          <div class="scorecard-avatar" style="background:${color.bg}">${initials}</div>
          <div>
            <div class="scorecard-name">${capitalize(name)}</div>
            <div class="scorecard-role">Designer • ${totalProjects} project</div>
          </div>
        </div>
        <span class="scorecard-status-badge ${overallPass ? 'on-target' : 'off-target'}">
          ${overallPass ? '✓ On Target' : '⚠ Off Target'}
        </span>
      </div>
      <div class="scorecard-metrics">
        <div class="scorecard-metric">
          <div class="metric-label">⚡ Kecepatan</div>
          <div class="metric-value ${speedPass ? 'pass' : 'fail'}">
            ${avgSpeed !== null ? avgSpeed + ' hari' : '— hari'}
          </div>
          <div class="metric-target">
            <span class="target-icon">${speedPass ? '✅' : '❌'}</span>
            Target: ≤ ${KPI_TARGETS.speedDays} hari
          </div>
        </div>
        <div class="scorecard-metric">
          <div class="metric-label">📊 Project/Bulan</div>
          <div class="metric-value ${projectPass ? 'pass' : 'fail'}">
            ${projectsPerMonth} prj
          </div>
          <div class="metric-target">
            <span class="target-icon">${projectPass ? '✅' : '❌'}</span>
            Target: ≥ ${KPI_TARGETS.projectsPerMonth} prj/bln
          </div>
        </div>
      </div>
      <div class="scorecard-progress-bar">
        <div class="progress-label">
          <span class="progress-label-text">KPI Score</span>
          <span class="progress-label-value ${kpiScore >= 75 ? 'pass' : 'fail'}">${kpiScore}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${kpiScore >= 75 ? 'pass' : 'fail'}" data-width="${kpiScore}"></div>
        </div>
      </div>
    `;

    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openDesignerDetail(name));
    grid.appendChild(card);
  });

  // Animate progress bars after a tick
  requestAnimationFrame(() => {
    grid.querySelectorAll('.progress-fill').forEach(el => {
      el.style.width = el.dataset.width + '%';
    });
  });
}

// ===== Live Workload Queue Renderer =====
function updateWorkloadAndBottlenecks(data) {
  const section = document.getElementById('workloadBottleneckSection');
  const workloadGrid = document.getElementById('workloadGrid');

  if (!section || !workloadGrid) return;

  if (rawData.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const activeProjects = data.filter(r => r.speedStatus === 'progress');

  // Get active designers (excluding nonaktif set)
  const designers = [...new Set(rawData.map(r => r.design).filter(d => d && d !== 'False'))].sort();
  const activeDesignersList = designers.filter(d => !inactiveDesigners.has(d.toLowerCase()));

  workloadGrid.innerHTML = '';

  if (activeDesignersList.length === 0) {
    workloadGrid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; color:var(--text-muted); padding:20px;">Tidak ada desainer aktif</div>';
  } else {
    activeDesignersList.forEach(name => {
      const lowerName = name.toLowerCase();
      const designerProjects = activeProjects.filter(r => r.design && r.design.toLowerCase() === lowerName);
      const projectCount = designerProjects.length;

      let workloadClass = 'low';
      let workloadBadgeText = 'Rendah';
      if (projectCount > 6) {
        workloadClass = 'high';
        workloadBadgeText = 'Tinggi';
      } else if (projectCount > 3) {
        workloadClass = 'medium';
        workloadBadgeText = 'Sedang';
      }

      const maxCapacity = 10;
      const progressPercent = Math.min(100, (projectCount / maxCapacity) * 100);

      const color = getDesignerColor(name);
      const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

      const card = document.createElement('div');
      card.className = 'workload-designer-card';

      let projectListHTML = '';
      if (projectCount === 0) {
        projectListHTML = '<div style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding: 10px 0;">Tidak ada antrean</div>';
      } else {
        projectListHTML = designerProjects.map(r => {
          const latestStage = getLatestStageInfo(r);
          return `
            <div class="workload-project-item">
              <div class="workload-project-info">
                <div class="workload-project-title" title="${escHtml(r.title)}">${escHtml(r.title)}</div>
                <div class="workload-project-cust" title="${escHtml(r.customer)}">${escHtml(r.customer)}</div>
              </div>
              <span class="workload-project-badge progress" title="Tahap: ${escHtml(latestStage.name)}">${escHtml(latestStage.name)}</span>
            </div>
          `;
        }).join('');
      }

      card.innerHTML = `
        <div class="workload-card-header">
          <div class="workload-designer-info">
            <div class="workload-avatar" style="background:${color.bg}">${initials}</div>
            <div>
              <div class="workload-name">${capitalize(name)}</div>
            </div>
          </div>
          <span class="workload-count-badge ${workloadClass}">${projectCount} Project (${workloadBadgeText})</span>
        </div>
        <div class="workload-progress">
          <div class="workload-progress-fill ${workloadClass}" style="width: ${progressPercent}%"></div>
        </div>
        <div class="workload-project-list">
          ${projectListHTML}
        </div>
      `;
      workloadGrid.appendChild(card);
    });
  }
}

// ===== Export to Excel =====
function exportToExcel() {
  if (filteredData.length === 0) {
    showToast('Tidak ada data untuk di-export.', 'error');
    return;
  }

  try {
    const wb = XLSX.utils.book_new();

    // --- Sheet 1: KPI Summary per Designer ---
    const designerGroups = {};
    filteredData.forEach(r => {
      if (!r.design || r.design === 'False') return;
      if (!designerGroups[r.design]) designerGroups[r.design] = [];
      designerGroups[r.design].push(r);
    });

    const getActiveMonths = (records) => {
      const months = new Set();
      records.forEach(r => {
        const d = r.orderDate ? new Date(r.orderDate) : (r.fileIn ? new Date(r.fileIn) : null);
        if (d) months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      });
      return Math.max(1, months.size);
    };

    const kpiRows = Object.keys(designerGroups).sort().map(name => {
      const records = designerGroups[name];
      const speeds = records.filter(r => r.speed !== null && r.speed >= 0).map(r => r.speed);
      const avgSpeed = speeds.length > 0 ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10 : null;
      const activeMonths = getActiveMonths(records);
      const projectsPerMonth = Math.round((records.length / activeMonths) * 10) / 10;

      const speedPass = avgSpeed !== null && avgSpeed <= KPI_TARGETS.speedDays;
      const projectPass = projectsPerMonth >= KPI_TARGETS.projectsPerMonth;

      return {
        'Designer': capitalize(name),
        'Total Project': records.length,
        'Rata-rata Kecepatan (hari)': avgSpeed !== null ? avgSpeed : '-',
        'Target Kecepatan (hari)': '≤ ' + KPI_TARGETS.speedDays,
        'Status Kecepatan': speedPass ? '✓ On Target' : '✗ Off Target',
        'Project/Bulan': projectsPerMonth,
        'Target Project/Bulan': '≥ ' + KPI_TARGETS.projectsPerMonth,
        'Status Project': projectPass ? '✓ On Target' : '✗ Off Target',
        'Bulan Aktif': activeMonths,
        'Overall Status': (speedPass && projectPass) ? '✓ ON TARGET' : '⚠ OFF TARGET',
        'Project Cepat (≤3 hari)': records.filter(r => r.speedStatus === 'fast').length,
        'Project Lambat (>14 hari)': records.filter(r => r.speedStatus === 'slow').length,
        'Anomali': records.filter(r => r.speedStatus === 'anomaly').length,
      };
    });

    const wsKPI = XLSX.utils.json_to_sheet(kpiRows);

    // Set column widths
    wsKPI['!cols'] = [
      { wch: 20 }, { wch: 14 }, { wch: 24 }, { wch: 22 },
      { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 18 },
      { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 22 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, wsKPI, 'KPI Summary');

    // --- Sheet 2: Detail Data ---
    const detailRows = filteredData.map(r => ({
      'Title': r.title || '',
      'Customer': r.customer || '',
      'Produk': r.productDescription || '',
      'Designer': r.design || '',
      'Stage': r.stage || '',
      'Order Date': r.orderDate ? new Date(r.orderDate).toLocaleDateString('id-ID') : '',
      'File In': r.fileIn ? new Date(r.fileIn).toLocaleDateString('id-ID') : '',
      'Progress AW': r.progressAW ? new Date(r.progressAW).toLocaleDateString('id-ID') : '',
      'Send AW ke Cust': r.sendAWkeCust ? new Date(r.sendAWkeCust).toLocaleDateString('id-ID') : '',
      'ACC AW dari Cust': r.accAWdariCust ? new Date(r.accAWdariCust).toLocaleDateString('id-ID') : '',
      'Progress Layout': r.progressLayout ? new Date(r.progressLayout).toLocaleDateString('id-ID') : '',
      'Review': r.review ? new Date(r.review).toLocaleDateString('id-ID') : '',
      'Lempar ke CTP': r.lemparFileKeCTP ? new Date(r.lemparFileKeCTP).toLocaleDateString('id-ID') : '',
      'Keluar Plat': r.keluarPlat ? new Date(r.keluarPlat).toLocaleDateString('id-ID') : '',
      'Kecepatan (hari)': r.speed !== null ? r.speed : '',
      'Status': r.speedStatus === 'normal' ? 'Normal' :
        r.speedStatus === 'fast' ? 'Cepat' :
          r.speedStatus === 'slow' ? 'Lambat' :
            r.speedStatus === 'anomaly' ? 'Anomali' :
              r.speedStatus === 'progress' ? 'Progress' : 'N/A',
    }));

    const wsDetail = XLSX.utils.json_to_sheet(detailRows);
    wsDetail['!cols'] = [
      { wch: 25 }, { wch: 20 }, { wch: 25 }, { wch: 18 },
      { wch: 15 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 14 },
      { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(wb, wsDetail, 'Detail Data');

    // --- Sheet 3: Workflow Analysis ---
    const getStageStats = (startKey, endKey) => {
      const diffs = filteredData.map(r => {
        const start = r[startKey] ? new Date(r[startKey]) : null;
        const end = r[endKey] ? new Date(r[endKey]) : null;
        if (!start || !end) return null;
        return (end - start) / (1000 * 60 * 60 * 24);
      }).filter(v => v !== null && v >= 0);
      if (diffs.length === 0) return { avg: '-', count: 0 };
      const avg = Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10;
      return { avg, count: diffs.length };
    };

    const workflowRows = [
      { 'Tahapan': 'File In → Progress AW', ...getStageStats('fileIn', 'progressAW') },
      { 'Tahapan': 'Progress AW → Send AW', ...getStageStats('progressAW', 'sendAWkeCust') },
      { 'Tahapan': 'Send AW → ACC AW', ...getStageStats('sendAWkeCust', 'accAWdariCust') },
      { 'Tahapan': 'Total AW Process', ...getStageStats('progressAW', 'accAWdariCust') },
      { 'Tahapan': '', avg: '', count: '' },
      { 'Tahapan': 'Send Digital → Receive', ...getStageStats('sendKeDigitalPrint', 'receiveDigital') },
      { 'Tahapan': 'Receive → Send ke Cust', ...getStageStats('receiveDigital', 'sendDigitalKeCust') },
      { 'Tahapan': 'Send Digital → ACC Cust', ...getStageStats('sendDigitalKeCust', 'accDigitalDariCust') },
      { 'Tahapan': 'Total Digital Process', ...getStageStats('sendKeDigitalPrint', 'accDigitalDariCust') },
      { 'Tahapan': '', avg: '', count: '' },
      { 'Tahapan': 'Progress → Send Dummy', ...getStageStats('progressDummy', 'sendDummy') },
      { 'Tahapan': 'Send Dummy → ACC Cust', ...getStageStats('sendDummy', 'accDummyDariCust') },
      { 'Tahapan': 'Total Dummy Process', ...getStageStats('progressDummy', 'accDummyDariCust') },
      { 'Tahapan': '', avg: '', count: '' },
      { 'Tahapan': 'Layout → Review', ...getStageStats('progressLayout', 'review') },
      { 'Tahapan': 'Review → Lempar CTP', ...getStageStats('review', 'lemparFileKeCTP') },
    ].map(row => ({
      'Tahapan': row['Tahapan'],
      'Rata-rata (hari)': row.avg,
      'Jumlah Data': row.count
    }));

    const wsWorkflow = XLSX.utils.json_to_sheet(workflowRows);
    wsWorkflow['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsWorkflow, 'Workflow Analysis');

    // Generate filename with date
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const filename = `KPI_Design_Report_${dateStr}.xlsx`;

    // Write to binary and download using FileSaver.js
    const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/octet-stream' });
    saveAs(blob, filename);

    showToast(`✅ Export berhasil! File: ${filename}`, 'success');
  } catch (err) {
    console.error('Export error:', err);
    showToast('Gagal export data. Silakan coba lagi.', 'error');
  }
}

// ===== Data Update Timestamp =====
function updateDataTimestamp(source) {
  const now = new Date();
  const timeStr = formatUpdateTimestamp(now);

  // Save to localStorage
  localStorage.setItem('kpi_update_time', now.toISOString());
  localStorage.setItem('kpi_update_source', source || 'Unknown');

  // Update UI
  document.getElementById('updateTimestamp').innerHTML =
    `Data terakhir diupdate: <strong>${timeStr}</strong>`;
  document.getElementById('updateSource').innerHTML =
    `<span class="update-dot"></span> Sumber: ${escHtml(source)}`;
}

function loadUpdateTimestamp() {
  const savedTime = localStorage.getItem('kpi_update_time');
  const savedSource = localStorage.getItem('kpi_update_source');

  if (savedTime) {
    const date = new Date(savedTime);
    const timeStr = formatUpdateTimestamp(date);
    document.getElementById('updateTimestamp').innerHTML =
      `Data terakhir diupdate: <strong>${timeStr}</strong>`;
    document.getElementById('updateSource').innerHTML =
      `<span class="update-dot"></span> Sumber: ${escHtml(savedSource || 'data.json')}`;
  }
}

function formatUpdateTimestamp(date) {
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  const dayName = days[date.getDay()];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${dayName}, ${day} ${month} ${year} — ${hours}:${minutes} WIB`;
}

// ===== Manage Designers: Active/Inactive Toggles =====
function loadInactiveDesigners() {
  try {
    const saved = localStorage.getItem('kpi_inactive_designers');
    if (saved) {
      inactiveDesigners = new Set(JSON.parse(saved).map(name => name.toLowerCase()));
    }
  } catch (e) {
    console.error('Failed to load inactive designers:', e);
  }
}

function saveInactiveDesigners() {
  localStorage.setItem('kpi_inactive_designers', JSON.stringify([...inactiveDesigners]));
}

// ===== Skip Review Setting =====
function loadSkipReviewSetting() {
  const saved = localStorage.getItem('kpi_skip_review');
  skipReview = saved === 'true';
  const toggle = document.getElementById('skipReviewToggle');
  if (toggle) toggle.checked = skipReview;
  // Update the indicator badge
  updateSkipReviewBadge();
}

function saveSkipReviewSetting() {
  localStorage.setItem('kpi_skip_review', skipReview.toString());
  updateSkipReviewBadge();
}

function updateSkipReviewBadge() {
  const badge = document.getElementById('skipReviewBadge');
  if (badge) {
    badge.textContent = skipReview ? 'CTP Only' : 'CTP + Review';
    badge.className = `skip-review-badge ${skipReview ? 'ctp-only' : 'ctp-review'}`;
  }
}

function renderDesignerPanel() {
  const listContainer = document.getElementById('designerPanelList');
  if (!listContainer) return;

  // Get all unique designers from rawData
  const designers = [...new Set(rawData.map(r => r.design).filter(d => d && d !== 'False'))].sort();

  listContainer.innerHTML = '';

  if (designers.length === 0) {
    listContainer.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">Tidak ada data designer</div>';
    return;
  }

  designers.forEach(name => {
    const lowerName = name.toLowerCase();
    const isInactive = inactiveDesigners.has(lowerName);
    const color = getDesignerColor(name);
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const projectCount = rawData.filter(r => r.design === name).length;

    const item = document.createElement('div');
    item.className = `designer-toggle-item ${isInactive ? 'inactive' : ''}`;
    item.innerHTML = `
      <div class="designer-toggle-info">
        <div class="designer-toggle-avatar" style="background:${color.bg}">${initials}</div>
        <div>
          <div class="designer-toggle-name">${capitalize(name)}</div>
          <div class="designer-toggle-count">${projectCount} project</div>
        </div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" data-designer="${escHtml(lowerName)}" ${!isInactive ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    `;

    // Listen to checkbox change
    item.querySelector('input').addEventListener('change', (e) => {
      const dName = e.target.dataset.designer;
      if (e.target.checked) {
        inactiveDesigners.delete(dName);
        item.classList.remove('inactive');
      } else {
        inactiveDesigners.add(dName);
        item.classList.add('inactive');
      }
      saveInactiveDesigners();
      populateFilters(rawData);
      applyFilters();
    });

    listContainer.appendChild(item);
  });
}

// ===== Supabase Integration =====

// Map database row (snake_case) to JS object (camelCase)
function mapDbToJs(row) {
  return {
    id: row.id,
    title: row.title || '',
    customer: row.customer || '',
    productDescription: row.product_description || '',
    orderedQty: row.ordered_qty || 0,
    deliveredQty: row.delivered_qty || 0,
    assignedTo: row.assigned_to || '',
    sales: row.sales || '',
    design: row.design || '',
    tags: row.tags || '',
    stage: row.stage || '',
    orderDate: row.order_date,
    deadline: row.deadline,
    fileIn: row.file_in,
    progressAW: row.progress_aw,
    sendAWkeCust: row.send_aw_ke_cust,
    accAWdariCust: row.acc_aw_dari_cust,
    sendKeDigitalPrint: row.send_ke_digital_print,
    receiveDigital: row.receive_digital,
    sendDigitalKeCust: row.send_digital_ke_cust,
    accDigitalDariCust: row.acc_digital_dari_cust,
    progressDummy: row.progress_dummy,
    sendDummy: row.send_dummy,
    accDummyDariCust: row.acc_dummy_dari_cust,
    progressLayout: row.progress_layout,
    lemparFileKeCTP: row.lempar_file_ke_ctp,
    progressLayoutCTP: row.progress_layout_ctp,
    doneLayoutCTP: row.done_layout_ctp,
    review: row.review,
    keluarPlat: row.keluar_plat,
    progressRevisiAW: row.progress_revisi_aw,
    progressRevisiDummy: row.progress_revisi_dummy,
    manufactureBaru: !!row.manufacture_baru,
    manufactureRepeat: !!row.manufacture_repeat,
    manufactureRepeatPerubahan: !!row.manufacture_repeat_perubahan,
  };
}

// Map JS object (camelCase) to database row (snake_case)
function mapJsToDb(record) {
  return {
    title: record.title || null,
    customer: record.customer || null,
    product_description: record.productDescription || null,
    ordered_qty: record.orderedQty || 0,
    delivered_qty: record.deliveredQty || 0,
    assigned_to: record.assignedTo || null,
    sales: record.sales || null,
    design: record.design || null,
    tags: record.tags || null,
    stage: record.stage || null,
    order_date: record.orderDate || null,
    deadline: record.deadline || null,
    file_in: record.fileIn || null,
    progress_aw: record.progressAW || null,
    send_aw_ke_cust: record.sendAWkeCust || null,
    acc_aw_dari_cust: record.accAWdariCust || null,
    send_ke_digital_print: record.sendKeDigitalPrint || null,
    receive_digital: record.receiveDigital || null,
    send_digital_ke_cust: record.sendDigitalKeCust || null,
    acc_digital_dari_cust: record.accDigitalDariCust || null,
    progress_dummy: record.progressDummy || null,
    send_dummy: record.sendDummy || null,
    acc_dummy_dari_cust: record.accDummyDariCust || null,
    progress_layout: record.progressLayout || null,
    lempar_file_ke_ctp: record.lemparFileKeCTP || null,
    progress_layout_ctp: record.progressLayoutCTP || null,
    done_layout_ctp: record.doneLayoutCTP || null,
    review: record.review || null,
    keluar_plat: record.keluarPlat || null,
    progress_revisi_aw: record.progressRevisiAW || null,
    progress_revisi_dummy: record.progressRevisiDummy || null,
    manufacture_baru: !!record.manufactureBaru,
    manufacture_repeat: !!record.manufactureRepeat,
    manufacture_repeat_perubahan: !!record.manufactureRepeatPerubahan,
  };
}

// Upload records to Supabase (replace all)
async function uploadToSupabase(records) {
  if (!supabaseClient) throw new Error('Supabase client not initialized');

  // Delete all existing data
  const { error: deleteError } = await supabaseClient
    .from('kpi_projects')
    .delete()
    .not('id', 'is', null);

  if (deleteError) throw deleteError;

  // Batch insert (Supabase has limits per request)
  const batchSize = 100;
  const dbRecords = records.map(mapJsToDb);

  for (let i = 0; i < dbRecords.length; i += batchSize) {
    const batch = dbRecords.slice(i, i + batchSize);
    const { error } = await supabaseClient
      .from('kpi_projects')
      .insert(batch);

    if (error) throw error;
    console.log(`✅ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(dbRecords.length / batchSize)} inserted`);
  }

  return dbRecords.length;
}

// Migrate data.json data to Supabase
async function migrateToSupabase() {
  if (!supabaseClient) {
    showToast('❌ Supabase belum terhubung. Periksa konfigurasi.', 'error');
    return;
  }

  if (rawData.length === 0) {
    showToast('⚠️ Tidak ada data untuk dimigrasi.', 'warning');
    return;
  }

  const syncBtn = document.getElementById('syncDbBtn');
  const originalText = syncBtn.innerHTML;
  syncBtn.disabled = true;
  syncBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin-icon">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
    Menyinkronkan...
  `;

  try {
    showToast(`⏳ Migrasi ${rawData.length} data ke database...`, 'info');
    const count = await uploadToSupabase(rawData);
    dataSource = 'supabase';
    updateDbStatus('connected');
    updateDataTimestamp(`Supabase Database (migrasi ${count} records)`);
    hideSyncButton();
    showToast(`✅ Berhasil migrasi ${count} data ke Supabase Database!`, 'success');
  } catch (err) {
    console.error('Migration error:', err);
    syncBtn.disabled = false;
    syncBtn.innerHTML = originalText;
    showToast(`❌ Gagal migrasi: ${err.message}`, 'error');
  }
}

// Update database status indicator
function updateDbStatus(status) {
  const dot = document.getElementById('dbDot');
  const text = document.getElementById('dbStatusText');
  if (!dot || !text) return;

  dot.className = 'db-dot';

  switch (status) {
    case 'connected':
      dot.classList.add('connected');
      text.textContent = '● Supabase Terhubung';
      break;
    case 'connecting':
      dot.classList.add('connecting');
      text.textContent = '◌ Menghubungkan...';
      break;
    case 'error':
      dot.classList.add('error');
      text.textContent = '● Koneksi Gagal';
      break;
    case 'disconnected':
      dot.classList.add('disconnected');
      text.textContent = '● Offline (lokal)';
      break;
  }
}

// Show/hide sync button
function showSyncButton() {
  const btn = document.getElementById('syncDbBtn');
  if (btn) btn.style.display = '';
}

function hideSyncButton() {
  const btn = document.getElementById('syncDbBtn');
  if (btn) btn.style.display = 'none';
}

// ===== Designer Detail Modal & Workflow Drilldown =====
let currentDesignerRecords = [];
let currentDesignerStageMap = {};
let currentDesignerFilterCallback = null;

function setupDesignerDetailListeners() {
  const overlay = document.getElementById('designerDetailOverlay');
  const closeBtn = document.getElementById('designerDetailClose');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      overlay.classList.remove('active');
    });
  }

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
      }
    });
  }
}

function setupWorkflowDrilldownListeners() {
  const overlay = document.getElementById('workflowDrilldownOverlay');
  const closeBtn = document.getElementById('wfDrilldownClose');
  const closeBtn2 = document.getElementById('wfDrilldownCloseBtn');

  const close = () => {
    if (overlay) overlay.classList.remove('active');
  };

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (closeBtn2) closeBtn2.addEventListener('click', close);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (overlay && overlay.classList.contains('active')) {
        close();
      }
    }
  });
}

// Initialize modal listeners after DOM load
document.addEventListener('DOMContentLoaded', () => {
  setupDesignerDetailListeners();
  setupWorkflowDrilldownListeners();
});

// Open dedicated Workflow Drilldown Modal
function openWorkflowDrilldown(stage, records) {
  const overlay = document.getElementById('workflowDrilldownOverlay');
  if (!overlay) return;

  const titleEl = document.getElementById('wfDrilldownTitle');
  const subtitleEl = document.getElementById('wfDrilldownSubtitle');
  const bodyEl = document.getElementById('wfDrilldownBody');
  const searchEl = document.getElementById('wfDrilldownSearch');
  const countEl = document.getElementById('wfDrilldownCount');
  const statsEl = document.getElementById('wfDrilldownStats');

  const { startKey, endKey, label, avg } = stage;

  // Filter matching records with duration
  const stageRecords = records.map(r => {
    const s = r[startKey] ? new Date(r[startKey]) : null;
    const e = r[endKey] ? new Date(r[endKey]) : null;
    if (!s || !e || isNaN(s) || isNaN(e)) return null;
    const diff = (e - s) / (1000 * 60 * 60 * 24);
    if (diff < 0) return null;
    return {
      record: r,
      stepDuration: Math.round(diff * 10) / 10,
      startDate: r[startKey],
      endDate: r[endKey]
    };
  }).filter(Boolean);

  // Sort descending by step duration (longest first)
  stageRecords.sort((a, b) => b.stepDuration - a.stepDuration);

  const durations = stageRecords.map(item => item.stepDuration);
  const minDur = durations.length > 0 ? Math.min(...durations) : 0;
  const maxDur = durations.length > 0 ? Math.max(...durations) : 0;

  titleEl.innerHTML = `<span>📋 Detail Project: <strong>${escHtml(label)}</strong></span>`;
  subtitleEl.textContent = `${stageRecords.length} project • Rata-rata durasi: ${avg} hari`;

  if (statsEl) {
    statsEl.innerHTML = `
      <span>Tercepat: <strong style="color:var(--accent-emerald)">${minDur} hari</strong></span>
      <span style="opacity:0.4">•</span>
      <span>Terlama: <strong style="color:var(--accent-red)">${maxDur} hari</strong></span>
    `;
  }

  let searchQuery = '';

  function renderList() {
    let filtered = stageRecords;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      filtered = stageRecords.filter(item => {
        const r = item.record;
        return (r.title && r.title.toLowerCase().includes(q)) ||
          (r.customer && r.customer.toLowerCase().includes(q)) ||
          (r.productDescription && r.productDescription.toLowerCase().includes(q));
      });
    }

    if (countEl) {
      countEl.textContent = `Menampilkan ${filtered.length} dari ${stageRecords.length} project`;
    }

    if (filtered.length === 0) {
      bodyEl.innerHTML = `
        <div style="text-align: center; padding: 48px 20px; color: var(--text-muted);">
          🔍 Tidak ada project yang cocok dengan pencarian "<strong>${escHtml(searchQuery)}</strong>".
        </div>
      `;
      return;
    }

    const rows = filtered.map((item, idx) => {
      const r = item.record;
      const dur = item.stepDuration;
      let durBadgeClass = 'cyan';
      if (dur > 7) durBadgeClass = 'red';
      else if (dur > 3) durBadgeClass = 'amber';
      else durBadgeClass = 'emerald';

      return `
        <tr>
          <td style="color:var(--text-muted); font-size:0.75rem; text-align:center;">${idx + 1}</td>
          <td><strong>${escHtml(r.title)}</strong></td>
          <td>${escHtml(r.customer || '—')}</td>
          <td title="${escHtml(r.productDescription || '')}">${truncate(r.productDescription || '—', 28)}</td>
          <td>${formatDate(item.startDate)}</td>
          <td>${formatDate(item.endDate)}</td>
          <td>
            <span class="dd-step-duration-pill ${durBadgeClass}">
              ${dur} hari
            </span>
          </td>
          <td>${renderStatusBadge(r.speedStatus)}</td>
        </tr>
      `;
    }).join('');

    bodyEl.innerHTML = `
      <table class="wf-drilldown-table">
        <thead>
          <tr>
            <th style="width:40px; text-align:center;">No</th>
            <th>Project Title</th>
            <th>Customer</th>
            <th>Produk</th>
            <th>Tanggal Mulai</th>
            <th>Tanggal Selesai</th>
            <th>Durasi Step</th>
            <th>Status Speed</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  if (searchEl) {
    searchEl.value = '';
    searchEl.oninput = (e) => {
      searchQuery = e.target.value;
      renderList();
    };
  }

  renderList();
  overlay.classList.add('active');
}

// Global handler for inline onclick on workflow rows
window.handleWfStageClick = function(stageId) {
  if (currentDesignerFilterCallback) {
    currentDesignerFilterCallback(stageId);
  }
};

// Global handler for inline onclick on designer stat cards
window.handleDesignerStatCardClick = function(status) {
  if (window._handleDesignerStatCard) {
    window._handleDesignerStatCard(status);
  }
};

function openDesignerDetail(designerName) {
  const overlay = document.getElementById('designerDetailOverlay');
  const headerEl = document.getElementById('designerDetailHeader');
  const bodyEl = document.getElementById('designerDetailBody');
  if (!overlay || !headerEl || !bodyEl) return;

  // Get this designer's records from filteredData
  const records = filteredData.filter(r => r.design && r.design.toLowerCase() === designerName.toLowerCase());
  if (records.length === 0) {
    showToast('Tidak ada data untuk designer ini.', 'error');
    return;
  }

  const color = getDesignerColor(designerName);
  const initials = designerName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  // Compute stats
  const totalProjects = records.length;
  const speeds = records.filter(r => r.speed !== null && r.speed >= 0).map(r => r.speed);
  const avgSpeed = speeds.length > 0 ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10 : null;
  const fastCount = records.filter(r => r.speedStatus === 'fast').length;
  const normalCount = records.filter(r => r.speedStatus === 'normal').length;
  const slowCount = records.filter(r => r.speedStatus === 'slow').length;
  const bottleneckCount = records.filter(r => r.speedStatus === 'bottleneck').length;

  // Active months
  const monthsSet = new Set();
  records.forEach(r => {
    const d = r.orderDate ? new Date(r.orderDate) : (r.fileIn ? new Date(r.fileIn) : null);
    if (d) monthsSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  });
  const activeMonths = Math.max(1, monthsSet.size);
  const projectsPerMonth = Math.round((totalProjects / activeMonths) * 10) / 10;

  // Filter state for modal
  let currentFilter = null; // null | { type: 'stage', id, label, startKey, endKey, avg, count } | { type: 'status', status, label }
  let searchQuery = '';

  // Render header
  headerEl.innerHTML = `
    <div class="dd-header-top">
      <div class="dd-avatar" style="background:${color.bg}">${initials}</div>
      <div class="dd-header-info">
        <h2>${capitalize(designerName)}</h2>
        <p>Designer • ${totalProjects} project • ${activeMonths} bulan aktif • ${projectsPerMonth} project/bulan</p>
      </div>
    </div>
    <div class="dd-stats-grid">
      <div class="dd-stat-card active" data-status="all" onclick="handleDesignerStatCardClick('all')" role="button" tabindex="0" title="Klik untuk menampilkan semua project (${totalProjects})">
        <div class="dd-stat-label">Total Project</div>
        <div class="dd-stat-value cyan">${totalProjects}</div>
      </div>
      <div class="dd-stat-card non-interactive">
        <div class="dd-stat-label">Rata-rata Speed</div>
        <div class="dd-stat-value ${avgSpeed !== null && avgSpeed <= KPI_TARGETS.speedDays ? 'emerald' : 'amber'}">${avgSpeed !== null ? avgSpeed + ' hr' : '—'}</div>
        <div class="dd-stat-sub">Target: ≤ ${KPI_TARGETS.speedDays} hari</div>
      </div>
      <div class="dd-stat-card" data-status="fast" onclick="handleDesignerStatCardClick('fast')" role="button" tabindex="0" title="Klik untuk filter project Cepat (≤ 3 hari)">
        <div class="dd-stat-label">⚡ Cepat</div>
        <div class="dd-stat-value cyan">${fastCount}</div>
        <div class="dd-stat-sub">≤ 3 hari</div>
      </div>
      <div class="dd-stat-card" data-status="normal" onclick="handleDesignerStatCardClick('normal')" role="button" tabindex="0" title="Klik untuk filter project Normal (4–14 hari)">
        <div class="dd-stat-label">✓ Normal</div>
        <div class="dd-stat-value emerald">${normalCount}</div>
        <div class="dd-stat-sub">4–14 hari</div>
      </div>
      <div class="dd-stat-card" data-status="slow" onclick="handleDesignerStatCardClick('slow')" role="button" tabindex="0" title="Klik untuk filter project Lambat (> 14 hari)">
        <div class="dd-stat-label">🐢 Lambat</div>
        <div class="dd-stat-value amber">${slowCount}</div>
        <div class="dd-stat-sub">> 14 hari</div>
      </div>
      <div class="dd-stat-card" data-status="bottleneck" onclick="handleDesignerStatCardClick('bottleneck')" role="button" tabindex="0" title="Klik untuk filter project Bottleneck (> 7 hari)">
        <div class="dd-stat-label">🚨 Bottleneck</div>
        <div class="dd-stat-value red">${bottleneckCount}</div>
        <div class="dd-stat-sub">Stuck > 7 hari</div>
      </div>
    </div>
  `;

  // Workflow stats for this designer
  const getDesignerStageStats = (startKey, endKey) => {
    const diffs = records.map(r => {
      const s = r[startKey] ? new Date(r[startKey]) : null;
      const e = r[endKey] ? new Date(r[endKey]) : null;
      if (!s || !e || isNaN(s) || isNaN(e)) return null;
      return (e - s) / (1000 * 60 * 60 * 24);
    }).filter(v => v !== null && v >= 0);
    if (diffs.length === 0) return { avg: null, count: 0 };
    return { avg: Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10, count: diffs.length };
  };

  // All workflow groups
  const wfGroups = [
    {
      title: '🎨 Proses Artwork (AW)',
      stages: [
        { id: 'stage_fileIn_progressAW', label: 'File In → Progress AW', startKey: 'fileIn', endKey: 'progressAW', ...getDesignerStageStats('fileIn', 'progressAW') },
        { id: 'stage_progressAW_sendAWkeCust', label: 'Progress AW → Send AW', startKey: 'progressAW', endKey: 'sendAWkeCust', ...getDesignerStageStats('progressAW', 'sendAWkeCust') },
        { id: 'stage_sendAWkeCust_accAWdariCust', label: 'Send AW → ACC AW', startKey: 'sendAWkeCust', endKey: 'accAWdariCust', ...getDesignerStageStats('sendAWkeCust', 'accAWdariCust') },
        { id: 'stage_totalAW', label: 'Total AW Process', startKey: 'progressAW', endKey: 'accAWdariCust', ...getDesignerStageStats('progressAW', 'accAWdariCust'), isTotal: true },
      ]
    },
    {
      title: '🖨️ Proses Digital Proof',
      stages: [
        { id: 'stage_sendKeDigitalPrint_receiveDigital', label: 'Send Digital → Receive', startKey: 'sendKeDigitalPrint', endKey: 'receiveDigital', ...getDesignerStageStats('sendKeDigitalPrint', 'receiveDigital') },
        { id: 'stage_receiveDigital_sendDigitalKeCust', label: 'Receive → Send ke Cust', startKey: 'receiveDigital', endKey: 'sendDigitalKeCust', ...getDesignerStageStats('receiveDigital', 'sendDigitalKeCust') },
        { id: 'stage_sendDigitalKeCust_accDigitalDariCust', label: 'Send Digital → ACC Cust', startKey: 'sendDigitalKeCust', endKey: 'accDigitalDariCust', ...getDesignerStageStats('sendDigitalKeCust', 'accDigitalDariCust') },
        { id: 'stage_totalDigital', label: 'Total Digital Process', startKey: 'sendKeDigitalPrint', endKey: 'accDigitalDariCust', ...getDesignerStageStats('sendKeDigitalPrint', 'accDigitalDariCust'), isTotal: true },
      ]
    },
    {
      title: '📦 Proses Dummy',
      stages: [
        { id: 'stage_progressDummy_sendDummy', label: 'Progress → Send Dummy', startKey: 'progressDummy', endKey: 'sendDummy', ...getDesignerStageStats('progressDummy', 'sendDummy') },
        { id: 'stage_sendDummy_accDummyDariCust', label: 'Send Dummy → ACC Cust', startKey: 'sendDummy', endKey: 'accDummyDariCust', ...getDesignerStageStats('sendDummy', 'accDummyDariCust') },
        { id: 'stage_totalDummy', label: 'Total Dummy Process', startKey: 'progressDummy', endKey: 'accDummyDariCust', ...getDesignerStageStats('progressDummy', 'accDummyDariCust'), isTotal: true },
      ]
    },
    {
      title: '📐 Layout, CTP & Review',
      stages: [
        { id: 'stage_progressLayout_review', label: 'Layout → Review', startKey: 'progressLayout', endKey: 'review', ...getDesignerStageStats('progressLayout', 'review') },
        { id: 'stage_review_lemparFileKeCTP', label: 'Review → Lempar CTP', startKey: 'review', endKey: 'lemparFileKeCTP', ...getDesignerStageStats('review', 'lemparFileKeCTP') },
      ]
    },
  ];

  // Map for fast lookup
  const stageMap = {};
  wfGroups.forEach(g => g.stages.forEach(s => { stageMap[s.id] = s; }));

  // Store globally for inline callbacks
  currentDesignerRecords = records;
  currentDesignerStageMap = stageMap;

  // Filter groups that have at least one stage with data
  const activeGroups = wfGroups.map(g => ({
    ...g,
    stages: g.stages.filter(s => s.count > 0)
  })).filter(g => g.stages.length > 0);

  // Build workflow HTML
  let workflowHTML = '';
  if (activeGroups.length > 0) {
    const groupsHTML = activeGroups.map(g => `
      <div class="dd-wf-group">
        <div class="dd-wf-group-title">${g.title}</div>
        <div class="dd-wf-group-stages">
          ${g.stages.map(s => `
            <div class="dd-wf-stage-row ${s.isTotal ? 'total' : ''}" 
                 data-stage-id="${s.id}" 
                 onclick="handleWfStageClick('${s.id}')"
                 role="button" 
                 tabindex="0" 
                 title="Klik untuk melihat ${s.count} project: ${escHtml(s.label)}">
              <div class="dd-wf-stage-label">${escHtml(s.label)}</div>
              <div class="dd-wf-stage-val">${s.avg} hari</div>
              <div class="dd-wf-stage-count">
                <span>${s.count} data</span>
                <span class="dd-wf-click-hint">Lihat ↗</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    workflowHTML = `
      <div class="dd-workflow-section">
        <div class="dd-workflow-title">
          <span>🔄 Rata-rata Durasi Workflow</span>
          <span class="dd-workflow-hint">💡 Klik salah satu stage untuk melihat detail projectnya</span>
        </div>
        <div class="dd-wf-groups-grid">
          ${groupsHTML}
        </div>
      </div>
    `;
  }

  // Insert base layout into modal body
  bodyEl.innerHTML = `
    ${workflowHTML}
    <div class="dd-table-section" id="ddTableSection">
      <!-- Injected by renderTableContent -->
    </div>
  `;

  function renderTableContent() {
    const tableSection = document.getElementById('ddTableSection');
    if (!tableSection) return;

    let displayRecords = [];
    const isStageFilter = currentFilter && currentFilter.type === 'stage';
    const isStatusFilter = currentFilter && currentFilter.type === 'status';

    if (isStageFilter) {
      const { startKey, endKey } = currentFilter;
      displayRecords = records.map(r => {
        const s = r[startKey] ? new Date(r[startKey]) : null;
        const e = r[endKey] ? new Date(r[endKey]) : null;
        if (!s || !e || isNaN(s) || isNaN(e)) return null;
        const diff = (e - s) / (1000 * 60 * 60 * 24);
        if (diff < 0) return null;
        return {
          ...r,
          _stepDuration: Math.round(diff * 10) / 10
        };
      }).filter(Boolean);
      // Sort by step duration descending (longest first)
      displayRecords.sort((a, b) => b._stepDuration - a._stepDuration);
    } else if (isStatusFilter) {
      displayRecords = records.filter(r => r.speedStatus === currentFilter.status);
    } else {
      displayRecords = [...records];
    }

    // Apply search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      displayRecords = displayRecords.filter(r =>
        (r.title && r.title.toLowerCase().includes(q)) ||
        (r.customer && r.customer.toLowerCase().includes(q)) ||
        (r.productDescription && r.productDescription.toLowerCase().includes(q))
      );
    }

    const tableRows = displayRecords.map(r => {
      const isStartKey = (k) => isStageFilter && currentFilter.startKey === k ? 'class="highlight-step-col"' : '';
      const isEndKey = (k) => isStageFilter && currentFilter.endKey === k ? 'class="highlight-step-col"' : '';

      const stepDurationCol = isStageFilter ? `
        <td class="highlight-step-col">
          <span class="dd-step-duration-pill">${r._stepDuration !== undefined ? r._stepDuration + ' hari' : '—'}</span>
        </td>
      ` : '';

      return `
        <tr>
          <td><strong>${escHtml(r.title)}</strong></td>
          <td>${escHtml(r.customer)}</td>
          <td title="${escHtml(r.productDescription)}">${truncate(r.productDescription, 20)}</td>
          ${stepDurationCol}
          <td>${formatDate(r.orderDate)}</td>
          <td ${isStartKey('fileIn') || isEndKey('fileIn')}>${formatDate(r.fileIn)}</td>
          <td ${isStartKey('progressAW') || isEndKey('progressAW')}>${formatDate(r.progressAW)}</td>
          <td ${isStartKey('sendAWkeCust') || isEndKey('sendAWkeCust')}>${formatDate(r.sendAWkeCust)}</td>
          <td ${isStartKey('accAWdariCust') || isEndKey('accAWdariCust')}>${formatDate(r.accAWdariCust)}</td>
          <td ${isStartKey('sendKeDigitalPrint') || isEndKey('sendKeDigitalPrint')}>${formatDate(r.sendKeDigitalPrint)}</td>
          <td ${isStartKey('receiveDigital') || isEndKey('receiveDigital')}>${formatDate(r.receiveDigital)}</td>
          <td ${isStartKey('sendDigitalKeCust') || isEndKey('sendDigitalKeCust')}>${formatDate(r.sendDigitalKeCust)}</td>
          <td ${isStartKey('accDigitalDariCust') || isEndKey('accDigitalDariCust')}>${formatDate(r.accDigitalDariCust)}</td>
          <td ${isStartKey('progressDummy') || isEndKey('progressDummy')}>${formatDate(r.progressDummy)}</td>
          <td ${isStartKey('sendDummy') || isEndKey('sendDummy')}>${formatDate(r.sendDummy)}</td>
          <td ${isStartKey('accDummyDariCust') || isEndKey('accDummyDariCust')}>${formatDate(r.accDummyDariCust)}</td>
          <td ${isStartKey('progressLayout') || isEndKey('progressLayout')}>${formatDate(r.progressLayout)}</td>
          <td ${isStartKey('lemparFileKeCTP') || isEndKey('lemparFileKeCTP')}>${formatDate(r.lemparFileKeCTP)}</td>
          <td ${isStartKey('review') || isEndKey('review')}>${formatDate(r.review)}</td>
          <td ${isStartKey('keluarPlat') || isEndKey('keluarPlat')}>${formatDate(r.keluarPlat)}</td>
          <td>${r.speed !== null ? '<strong>' + r.speed + '</strong> hari' : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td>${renderStatusBadge(r.speedStatus)}</td>
        </tr>
      `;
    }).join('');

    const emptyRow = `
      <tr>
        <td colspan="25" style="text-align: center; padding: 36px 20px; color: var(--text-muted);">
          🔍 Tidak ada data project yang sesuai filter.
        </td>
      </tr>
    `;

    const isStartHeader = (k) => isStageFilter && currentFilter.startKey === k ? 'class="highlight-step-col"' : '';
    const isEndHeader = (k) => isStageFilter && currentFilter.endKey === k ? 'class="highlight-step-col"' : '';

    tableSection.innerHTML = `
      <div class="dd-table-header">
        <div class="dd-table-header-left">
          <div class="dd-table-title">📋 Daftar Project</div>
          ${currentFilter ? `
            <div class="dd-active-filter-badge">
              <span>🔍 Filter: <strong>${escHtml(currentFilter.label)}</strong> (${displayRecords.length} data)</span>
              <button class="dd-reset-filter-btn" id="ddResetFilterBtn" title="Tampilkan semua project">✕ Tampilkan Semua (${totalProjects})</button>
            </div>
          ` : `
            <div class="dd-table-count">${displayRecords.length} project</div>
          `}
        </div>
        <div class="dd-table-header-right">
          <input type="text" id="ddTableSearch" class="dd-table-search" placeholder="Cari title / customer..." value="${escHtml(searchQuery)}" />
        </div>
      </div>
      <div class="dd-table-wrapper">
        <table class="dd-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Customer</th>
              <th>Produk</th>
              ${isStageFilter ? `<th class="highlight-step-col">Durasi Step (${escHtml(currentFilter.label)})</th>` : ''}
              <th>Order Date</th>
              <th ${isStartHeader('fileIn') || isEndHeader('fileIn')}>File In</th>
              <th ${isStartHeader('progressAW') || isEndHeader('progressAW')}>Progress AW</th>
              <th ${isStartHeader('sendAWkeCust') || isEndHeader('sendAWkeCust')}>Send AW</th>
              <th ${isStartHeader('accAWdariCust') || isEndHeader('accAWdariCust')}>ACC AW</th>
              <th ${isStartHeader('sendKeDigitalPrint') || isEndHeader('sendKeDigitalPrint')}>Send Digital</th>
              <th ${isStartHeader('receiveDigital') || isEndHeader('receiveDigital')}>Receive Digital</th>
              <th ${isStartHeader('sendDigitalKeCust') || isEndHeader('sendDigitalKeCust')}>Send ke Cust</th>
              <th ${isStartHeader('accDigitalDariCust') || isEndHeader('accDigitalDariCust')}>ACC Digital</th>
              <th ${isStartHeader('progressDummy') || isEndHeader('progressDummy')}>Progress Dummy</th>
              <th ${isStartHeader('sendDummy') || isEndHeader('sendDummy')}>Send Dummy</th>
              <th ${isStartHeader('accDummyDariCust') || isEndHeader('accDummyDariCust')}>ACC Dummy</th>
              <th ${isStartHeader('progressLayout') || isEndHeader('progressLayout')}>Progress Layout</th>
              <th ${isStartHeader('lemparFileKeCTP') || isEndHeader('lemparFileKeCTP')}>Lempar CTP</th>
              <th ${isStartHeader('review') || isEndHeader('review')}>Review</th>
              <th ${isStartHeader('keluarPlat') || isEndHeader('keluarPlat')}>Keluar Plat</th>
              <th>Kecepatan</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || emptyRow}
          </tbody>
        </table>
      </div>
    `;

    // Bind search input
    const searchInput = document.getElementById('ddTableSearch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderTableContent();
        const newSearch = document.getElementById('ddTableSearch');
        if (newSearch) {
          newSearch.focus();
          newSearch.setSelectionRange(newSearch.value.length, newSearch.value.length);
        }
      });
    }

    // Bind reset button
    const resetBtn = document.getElementById('ddResetFilterBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        currentFilter = null;
        updateVisualActiveStates();
        renderTableContent();
      });
    }
  }

  function updateVisualActiveStates() {
    // Stage rows
    bodyEl.querySelectorAll('.dd-wf-stage-row').forEach(row => {
      const sId = row.dataset.stageId;
      if (currentFilter && currentFilter.type === 'stage' && currentFilter.id === sId) {
        row.classList.add('active');
      } else {
        row.classList.remove('active');
      }
    });

    // Stat cards in header
    headerEl.querySelectorAll('.dd-stat-card[data-status]').forEach(card => {
      const st = card.dataset.status;
      if (!currentFilter && st === 'all') {
        card.classList.add('active');
      } else if (currentFilter && currentFilter.type === 'status' && currentFilter.status === st) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  }

  // Connect callback for stage click
  currentDesignerFilterCallback = function(stageId) {
    const s = stageMap[stageId];
    if (!s) return;

    // Open dedicated drilldown modal immediately
    openWorkflowDrilldown(s, records);

    // Also sync the table filter below
    currentFilter = {
      type: 'stage',
      id: s.id,
      label: s.label,
      startKey: s.startKey,
      endKey: s.endKey,
      avg: s.avg,
      count: s.count
    };
    updateVisualActiveStates();
    renderTableContent();
  };

  // Connect callback for stat card click
  window._handleDesignerStatCard = function(st) {
    if (st === 'all' || (currentFilter && currentFilter.type === 'status' && currentFilter.status === st)) {
      currentFilter = null;
    } else {
      const labels = {
        fast: '⚡ Cepat (≤ 3 hari)',
        normal: '✓ Normal (4–14 hari)',
        slow: '🐢 Lambat (> 14 hari)',
        bottleneck: '🚨 Bottleneck (Stuck > 7 hari)'
      };
      currentFilter = {
        type: 'status',
        status: st,
        label: labels[st] || st
      };
    }
    updateVisualActiveStates();
    renderTableContent();
    const tbl = document.getElementById('ddTableSection');
    if (tbl) tbl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Initial table render
  renderTableContent();

  overlay.classList.add('active');
}

// =============================================
// ===== ODOO INTEGRATION =====
// =============================================

// Cached Odoo metadata
let odooStages = [];
let odooDesigners = [];

// ===== Sync from Odoo =====
async function syncFromOdoo() {
  const btn = document.getElementById('odooSyncBtn');
  const spinner = document.getElementById('odooSyncSpinner');
  const label = btn.querySelector('.odoo-sync-label');

  btn.classList.add('syncing');
  if (spinner) spinner.style.display = '';
  if (label) label.textContent = 'Syncing...';

  try {
    const resp = await fetch('/api/odoo/sync', { method: 'POST' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    const result = await resp.json();

    if (result.success) {
      // Update cached metadata
      if (result.stages) odooStages = result.stages;
      if (result.designers) odooDesigners = result.designers;

      // Save metadata to localStorage
      localStorage.setItem('odoo_stages', JSON.stringify(odooStages));
      localStorage.setItem('odoo_designers', JSON.stringify(odooDesigners));

      // Re-fetch updated data.json
      const dataResp = await fetch('data.json?v=' + Date.now());
      rawData = await dataResp.json();

      const now = new Date().toLocaleString('id-ID');

      // If Supabase is available, clear Supabase DB and upload new Odoo data
      if (supabaseClient) {
        try {
          if (label) label.textContent = 'Updating Supabase...';
          showToast(`⏳ Mengosongkan Supabase & mengimpor ${rawData.length} data baru dari Odoo...`, 'info');
          const importedCount = await uploadToSupabase(rawData);
          dataSource = 'supabase';
          updateDbStatus('connected');
          hideSyncButton();
          updateDataTimestamp(`Supabase Database (Sync Odoo ${importedCount} records) — ${now}`);
          showToast(`✅ Berhasil sync Odoo & mengimpor ${importedCount} data ke Supabase Database!`, 'success');
        } catch (dbErr) {
          console.error('Supabase update error after Odoo sync:', dbErr);
          dataSource = 'json';
          updateDbStatus('disconnected');
          showSyncButton();
          updateDataTimestamp(`Odoo Sync (${result.total} records) — ${now}`);
          showToast(`⚠️ Sync Odoo berhasil, tapi gagal update Supabase: ${dbErr.message}`, 'warning');
        }
      } else {
        dataSource = 'json';
        updateDataTimestamp(`Odoo Sync (${result.total} records — ${result.active} aktif, ${result.archived} arsip) — ${now}`);
        showToast(`✅ Berhasil sync ${result.total} task dari Odoo`, 'success');
      }

      processAndRender(rawData);
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('Odoo sync error:', e);
    showToast(`❌ Gagal sync dari Odoo: ${e.message}`, 'error');
  } finally {
    btn.classList.remove('syncing');
    if (spinner) spinner.style.display = 'none';
    if (label) label.textContent = 'Sync Odoo';
  }
}

// Load cached Odoo metadata on startup
function loadOdooMetadata() {
  try {
    const stages = localStorage.getItem('odoo_stages');
    if (stages) odooStages = JSON.parse(stages);

    const designers = localStorage.getItem('odoo_designers');
    if (designers) odooDesigners = JSON.parse(designers);
  } catch (e) {
    console.warn('Failed to load Odoo metadata cache:', e);
  }
}


// =============================================
// ===== KANBAN BOARD =====
// =============================================

// Stage order for "All Project" kanban (from Odoo stages with project-relevant IDs)
const KANBAN_STAGE_ORDER = [
  'PO', 'PO Repeat/Perubahan', 'SPK', 'Beli Kertas', 'Tunggu File',
  'Baru - Review', 'Desain', 'Send AW', 'ACC AW', 'Digital',
  'Send Dummy', 'ACC Dummy', 'Layout', 'Review FINAL', 'CR', 'CTP',
  'Pra Cetak', 'Antri Cetak', 'Cetak',
  'Finishing - Coating', 'Finishing - Laminasi', 'Finishing HP/Emboss',
  'Finishing Plong', 'Finishing Plong (Luar)', 'Finishing Protol',
  'Finishing Lem Mesin', 'Finishing Lem Manual', 'Finishing Potong',
  'Finishing Lain-lain', 'Finishing Packing',
  'Antri Kirim', 'Kurang Kirim', 'Complain'
];

function renderKanbanBoard(searchQuery = '') {
  const board = document.getElementById('kanbanBoard');
  if (!board) return;

  // Use filteredData (respects global filters)
  let data = filteredData || rawData;

  // Apply kanban search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    data = data.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.customer || '').toLowerCase().includes(q) ||
      (r.productDescription || '').toLowerCase().includes(q) ||
      (r.design || '').toLowerCase().includes(q)
    );
  }

  // Group by stage
  const groups = {};
  data.forEach((r, idx) => {
    const stage = r.stage || 'Lainnya';
    if (!groups[stage]) groups[stage] = [];
    groups[stage].push({ ...r, _index: rawData.indexOf(r) });
  });

  // Order stages
  const orderedStages = [];
  KANBAN_STAGE_ORDER.forEach(s => {
    if (groups[s]) orderedStages.push(s);
  });
  // Add any remaining stages not in the predefined order
  Object.keys(groups).forEach(s => {
    if (!orderedStages.includes(s)) orderedStages.push(s);
  });

  const refToday = getReferenceToday();

  board.innerHTML = orderedStages.map(stage => {
    const tasks = groups[stage];
    const cardsHtml = tasks.map(task => {
      const product = task.productDescription || task.title || '—';
      const customer = task.customer || '—';
      const designer = task.design || '';
      const designerColor = getDesignerColor(designer);

      // Days calculation
      let daysText = '';
      let daysClass = 'recent';
      const latestDate = getLatestDateFromTask(task);
      if (latestDate) {
        const diffDays = Math.floor((refToday - latestDate) / (1000 * 60 * 60 * 24));
        if (diffDays <= 0) {
          daysText = 'Hari ini';
        } else if (diffDays === 1) {
          daysText = '1 hari lalu';
        } else {
          daysText = `${diffDays} hari lalu`;
        }
        if (diffDays > 7) daysClass = 'old';
        else if (diffDays > 3) daysClass = 'medium';
      }

      // Tag
      let tagHtml = '';
      if (task.manufactureBaru) tagHtml = '<span class="kanban-card-tag baru">Baru</span>';
      else if (task.manufactureRepeat) tagHtml = '<span class="kanban-card-tag repeat">Repeat</span>';

      // Designer avatar
      let designerHtml = '';
      if (designer) {
        const initials = designer.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        designerHtml = `
          <div class="kanban-card-designer">
            <div class="kanban-designer-avatar" style="background:${designerColor.bg}">${initials}</div>
            <span class="kanban-designer-name">${designer}</span>
          </div>`;
      }

      return `
        <div class="kanban-card" data-task-index="${task._index}" onclick="openTaskEditModal(${task._index})">
          ${tagHtml}
          <div class="kanban-card-product">${escapeHtml(product)}</div>
          <div class="kanban-card-customer">${escapeHtml(customer)}</div>
          <div class="kanban-card-footer">
            ${daysText ? `<span class="kanban-card-days ${daysClass}">${daysText}</span>` : '<span></span>'}
            ${designerHtml}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="kanban-column">
        <div class="kanban-column-header">
          <span class="kanban-column-title" title="${escapeHtml(stage)}">${escapeHtml(stage)}</span>
          <span class="kanban-column-count">${tasks.length}</span>
        </div>
        <div class="kanban-column-cards">
          ${cardsHtml || '<div class="kanban-empty">Tidak ada task</div>'}
        </div>
      </div>`;
  }).join('');

  // Show empty message if no stages
  if (orderedStages.length === 0) {
    board.innerHTML = '<div class="kanban-empty" style="width:100%;padding:60px;">Tidak ada data untuk ditampilkan</div>';
  }
}

function getLatestDateFromTask(task) {
  // Get the most recent timestamp from the task
  const dateFields = [
    'keluarPlat', 'review', 'doneLayoutCTP', 'progressLayoutCTP',
    'lemparFileKeCTP', 'progressLayout', 'accDummyDariCust',
    'sendDummy', 'progressDummy', 'accDigitalDariCust',
    'sendDigitalKeCust', 'receiveDigital', 'sendKeDigitalPrint',
    'accAWdariCust', 'sendAWkeCust', 'progressAW', 'fileIn',
    'progressRevisiAW', 'progressRevisiDummy'
  ];
  for (const field of dateFields) {
    if (task[field]) {
      try { return new Date(task[field]); } catch (e) {}
    }
  }
  if (task.orderDate) {
    try { return new Date(task.orderDate); } catch (e) {}
  }
  return null;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


// =============================================
// ===== TASK EDIT MODAL =====
// =============================================

let editingTaskIndex = null;

function openTaskEditModal(taskIndex) {
  editingTaskIndex = taskIndex;
  const task = rawData[taskIndex];
  if (!task) return;

  const overlay = document.getElementById('taskEditOverlay');
  const title = document.getElementById('taskEditTitle');
  const body = document.getElementById('taskEditBody');

  title.textContent = task.productDescription || task.title || 'Edit Task';

  // Build stage options
  const stages = getAvailableStages();
  const stageOptions = stages.map(s =>
    `<option value="${s.id}" ${s.name === task.stage ? 'selected' : ''}>${s.name}</option>`
  ).join('');

  // Build designer options
  const designers = getAvailableDesigners();
  const designerOptions = `<option value="">— Tidak ada —</option>` +
    designers.map(d =>
      `<option value="${d.id}" ${d.name.toLowerCase() === (task.design || '').toLowerCase() ? 'selected' : ''}>${d.name}</option>`
    ).join('');

  // Timestamp fields
  const timestampFields = [
    { key: 'fileIn', label: 'File In' },
    { key: 'progressAW', label: 'Progress AW' },
    { key: 'sendAWkeCust', label: 'Send AW ke Cust' },
    { key: 'accAWdariCust', label: 'ACC AW dari Cust' },
    { key: 'sendKeDigitalPrint', label: 'Send ke Digital Print' },
    { key: 'receiveDigital', label: 'Receive Digital' },
    { key: 'sendDigitalKeCust', label: 'Send Digital ke Cust' },
    { key: 'accDigitalDariCust', label: 'ACC Digital dari Cust' },
    { key: 'progressDummy', label: 'Progress Dummy' },
    { key: 'sendDummy', label: 'Send Dummy' },
    { key: 'accDummyDariCust', label: 'ACC Dummy dari Cust' },
    { key: 'progressLayout', label: 'Progress Layout' },
    { key: 'lemparFileKeCTP', label: 'Lempar File ke CTP' },
    { key: 'progressLayoutCTP', label: 'Progress Layout CTP' },
    { key: 'doneLayoutCTP', label: 'Done Layout CTP' },
    { key: 'review', label: 'Review' },
    { key: 'keluarPlat', label: 'Keluar Plat' },
    { key: 'progressRevisiAW', label: 'Progress Revisi AW' },
    { key: 'progressRevisiDummy', label: 'Progress Revisi Dummy' },
  ];

  const timestampsHtml = timestampFields.map(f => {
    const val = task[f.key] || '';
    // Convert ISO to datetime-local format
    let localVal = '';
    if (val) {
      try {
        const dt = new Date(val);
        localVal = dt.toISOString().slice(0, 16);
      } catch (e) { localVal = val; }
    }
    return `
      <div class="edit-timestamp-item">
        <label>${f.label}</label>
        <input type="datetime-local" name="ts_${f.key}" value="${localVal}" data-field="${f.key}">
      </div>`;
  }).join('');

  body.innerHTML = `
    <!-- Task Info (read-only) -->
    <div class="edit-section">
      <div class="edit-section-title">📋 Informasi Task</div>
      <div class="edit-info-grid">
        <div class="edit-info-item">
          <div class="edit-info-label">Title</div>
          <div class="edit-info-value">${escapeHtml(task.title || '—')}</div>
        </div>
        <div class="edit-info-item">
          <div class="edit-info-label">Customer</div>
          <div class="edit-info-value">${escapeHtml(task.customer || '—')}</div>
        </div>
        <div class="edit-info-item">
          <div class="edit-info-label">Produk</div>
          <div class="edit-info-value">${escapeHtml(task.productDescription || '—')}</div>
        </div>
        <div class="edit-info-item">
          <div class="edit-info-label">Qty Order</div>
          <div class="edit-info-value">${(task.orderedQty || 0).toLocaleString('id-ID')}</div>
        </div>
        <div class="edit-info-item">
          <div class="edit-info-label">Sales</div>
          <div class="edit-info-value">${escapeHtml(task.sales || '—')}</div>
        </div>
        <div class="edit-info-item">
          <div class="edit-info-label">Order Date</div>
          <div class="edit-info-value">${task.orderDate ? new Date(task.orderDate).toLocaleDateString('id-ID') : '—'}</div>
        </div>
      </div>
    </div>

    <!-- Editable Fields -->
    <div class="edit-section">
      <div class="edit-section-title">✏️ Edit Field</div>
      <div class="edit-field-group">
        <label class="edit-field-label">Stage</label>
        <select class="edit-field-select" id="editStage">
          ${stageOptions}
        </select>
      </div>
      <div class="edit-field-group">
        <label class="edit-field-label">Designer</label>
        <select class="edit-field-select" id="editDesigner">
          ${designerOptions}
        </select>
      </div>
    </div>

    <!-- Timestamps -->
    <div class="edit-section">
      <div class="edit-section-title">🕐 Workflow Timestamps</div>
      <div class="edit-timestamps-grid">
        ${timestampsHtml}
      </div>
    </div>
  `;

  overlay.classList.add('active');
}

function closeTaskEditModal() {
  const overlay = document.getElementById('taskEditOverlay');
  overlay.classList.remove('active');
  editingTaskIndex = null;
}

async function saveTaskToOdoo() {
  if (editingTaskIndex === null) return;
  const task = rawData[editingTaskIndex];
  if (!task || !task.odooId) {
    showToast('❌ Task ini tidak memiliki Odoo ID. Sync data dulu.', 'error');
    return;
  }

  const saveBtn = document.getElementById('taskEditSave');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Menyimpan...';

  try {
    // 1. Save stage & designer
    const stageSelect = document.getElementById('editStage');
    const designerSelect = document.getElementById('editDesigner');

    const newStageId = stageSelect ? parseInt(stageSelect.value) : null;
    const newDesignId = designerSelect ? (designerSelect.value ? parseInt(designerSelect.value) : null) : null;

    // Check if stage or designer changed
    const stageChanged = newStageId && newStageId !== task.odooStageId;
    const designChanged = newDesignId !== task.odooDesignId;

    if (stageChanged || designChanged) {
      const updateBody = { taskId: task.odooId };
      if (stageChanged) updateBody.stageId = newStageId;
      if (designChanged) updateBody.designId = newDesignId === null ? false : newDesignId;

      const resp = await fetch('/api/odoo/update-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      // Update local data
      if (stageChanged) {
        const stageOpt = stageSelect.options[stageSelect.selectedIndex];
        task.stage = stageOpt ? stageOpt.textContent : task.stage;
        task.odooStageId = newStageId;
      }
      if (designChanged) {
        const designOpt = designerSelect.options[designerSelect.selectedIndex];
        task.design = designOpt && designOpt.value ? designOpt.textContent.toLowerCase() : '';
        task.odooDesignId = newDesignId;
      }
    }

    // 2. Save timestamps
    const timestampInputs = document.querySelectorAll('.edit-timestamps-grid input[type="datetime-local"]');
    let tsUpdated = 0;

    for (const input of timestampInputs) {
      const fieldName = input.dataset.field;
      const newVal = input.value;
      const oldVal = task[fieldName] || '';

      // Convert oldVal to datetime-local format for comparison
      let oldLocalVal = '';
      if (oldVal) {
        try {
          oldLocalVal = new Date(oldVal).toISOString().slice(0, 16);
        } catch (e) { oldLocalVal = oldVal; }
      }

      if (newVal !== oldLocalVal) {
        const dojobId = task.dojobIds ? task.dojobIds[fieldName] : null;
        const isoDate = newVal ? new Date(newVal).toISOString() : null;

        const resp = await fetch('/api/odoo/update-dojob', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: task.odooId,
            fieldName: fieldName,
            doDate: isoDate,
            dojobId: dojobId,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          console.error(`Failed to update ${fieldName}:`, err);
          continue;
        }

        const result = await resp.json();

        // Update local data
        task[fieldName] = isoDate ? new Date(newVal).toISOString().replace('Z', '').split('.')[0] : null;
        if (result.dojobId && task.dojobIds) {
          if (result.action === 'deleted') {
            delete task.dojobIds[fieldName];
          } else {
            task.dojobIds[fieldName] = result.dojobId;
          }
        }
        tsUpdated++;
      }
    }

    // Recompute speed
    task.speed = computeSpeed(task);
    task.speedStatus = getSpeedStatus(task.speed, task);

    // Re-render
    applyFilters();

    showToast(`✅ Task berhasil disimpan ke Odoo${tsUpdated > 0 ? ` (${tsUpdated} timestamp diupdate)` : ''}`, 'success');
    closeTaskEditModal();

  } catch (e) {
    console.error('Save to Odoo error:', e);
    showToast(`❌ Gagal menyimpan: ${e.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1-2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
      </svg>
      Simpan ke Odoo`;
  }
}
function getAvailableStages() {
  // Use cached Odoo stages, or build from data
  if (odooStages.length > 0) {
    // Filter to only stages from "All Project" (unique names from data)
    const stagesInData = new Set(rawData.map(r => r.stage).filter(Boolean));
    return odooStages
      .filter(s => stagesInData.has(s.name))
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  }
  // Fallback: build from raw data stages
  const stages = [...new Set(rawData.map(r => r.stage).filter(Boolean))];
  return stages.map((name, i) => ({ id: i, name }));
}

function getAvailableDesigners() {
  if (odooDesigners.length > 0) return odooDesigners;
  // Fallback: build from raw data
  const designers = [...new Set(rawData.map(r => r.design).filter(d => d && d !== 'False'))];
  return designers.map((name, i) => ({ id: i, name: name.charAt(0).toUpperCase() + name.slice(1) }));
}


/* ========================================
   AI ASSISTANT MODULE
   ======================================== */

// ===== AI State =====
let aiPanelOpen = false;
let aiIsLoading = false;
const aiMessageHistory = [];  // { role: 'user'|'assistant', text }

// ===== Build KPI Context for AI =====
function buildKpiContext() {
  const data = filteredData.length > 0 ? filteredData : rawData;
  if (!data || data.length === 0) return {};

  // Total tasks
  const totalTasks = data.length;

  // Average speed
  const speeds = data.filter(r => r.speed !== null && r.speed >= 0).map(r => r.speed);
  const avgSpeed = speeds.length > 0
    ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10
    : null;

  // Designer breakdown
  const designerMap = {};
  data.forEach(r => {
    const d = (r.design || '').trim();
    if (!d || d === 'False') return;
    if (!designerMap[d]) designerMap[d] = { count: 0, speeds: [] };
    designerMap[d].count++;
    if (r.speed !== null && r.speed >= 0) designerMap[d].speeds.push(r.speed);
  });
  const designers = Object.entries(designerMap).map(([name, info]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    count: info.count,
    avgSpeed: info.speeds.length > 0
      ? Math.round((info.speeds.reduce((a, b) => a + b, 0) / info.speeds.length) * 10) / 10
      : null,
  })).sort((a, b) => b.count - a.count);

  // Stage distribution
  const stageMap = {};
  data.forEach(r => {
    const s = r.stage || 'Unknown';
    stageMap[s] = (stageMap[s] || 0) + 1;
  });
  const stageDistribution = Object.entries(stageMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Bottlenecks (stuck > 7 hari)
  const today = new Date();
  const bottlenecks = data.filter(r => r.speedStatus === 'bottleneck' || r.speedStatus === 'slow').map(r => {
    const latestDate = getLatestStageDate(r);
    const stuckDays = latestDate ? Math.round((today - latestDate) / (1000 * 60 * 60 * 24)) : null;
    return {
      title: r.title || '-',
      designer: r.design || '-',
      stage: r.stage || '-',
      days: stuckDays,
      speed: r.speed,
    };
  }).filter(b => b.days !== null).sort((a, b) => b.days - a.days).slice(0, 10);

  // Workflow averages
  const getWfAvg = (startKey, endKey) => {
    const diffs = data.map(r => {
      const s = r[startKey] ? new Date(r[startKey]) : null;
      const e = r[endKey] ? new Date(r[endKey]) : null;
      if (!s || !e) return null;
      const d = (e - s) / (1000 * 60 * 60 * 24);
      return d >= 0 ? d : null;
    }).filter(v => v !== null);
    if (!diffs.length) return null;
    return { avg: Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10, count: diffs.length };
  };

  const workflowAvg = [
    { label: 'File In → Progress AW', ...getWfAvg('fileIn', 'progressAW') },
    { label: 'Progress AW → Send AW', ...getWfAvg('progressAW', 'sendAWkeCust') },
    { label: 'Send AW → ACC AW', ...getWfAvg('sendAWkeCust', 'accAWdariCust') },
    { label: 'Send Digital → Receive', ...getWfAvg('sendKeDigitalPrint', 'receiveDigital') },
    { label: 'Layout → Review', ...getWfAvg('progressLayout', 'review') },
    { label: 'Review → CTP', ...getWfAvg('review', 'lemparFileKeCTP') },
  ].filter(w => w.avg !== undefined);

  // KPI status counts
  const kpiCounts = {
    fast: data.filter(r => r.speedStatus === 'fast').length,
    normal: data.filter(r => r.speedStatus === 'normal').length,
    slow: data.filter(r => r.speedStatus === 'slow').length,
    bottleneck: data.filter(r => r.speedStatus === 'bottleneck').length,
    progress: data.filter(r => r.speedStatus === 'progress').length,
    noData: data.filter(r => r.speedStatus === 'no-data').length,
  };

  return { totalTasks, avgSpeed, designers, stageDistribution, bottlenecks, workflowAvg, kpiCounts };
}

function getLatestStageDate(r) {
  const fields = ['lemparFileKeCTP', 'review', 'accAWdariCust', 'sendAWkeCust', 'progressAW', 'fileIn'];
  for (const f of fields) {
    if (r[f]) return new Date(r[f]);
  }
  return null;
}

// ===== UI Toggle =====
function toggleAiPanel() {
  aiPanelOpen = !aiPanelOpen;
  const panel = document.getElementById('aiChatPanel');
  const fabIcon = document.getElementById('aiFabIcon');
  const fabClose = document.getElementById('aiFabClose');
  const fab = document.getElementById('aiChatFab');

  if (aiPanelOpen) {
    panel.classList.add('open');
    fab.classList.add('active');
    fabIcon.style.display = 'none';
    fabClose.style.display = 'flex';
    // Auto-focus input
    setTimeout(() => document.getElementById('aiChatInput')?.focus(), 300);
  } else {
    panel.classList.remove('open');
    fab.classList.remove('active');
    fabIcon.style.display = 'flex';
    fabClose.style.display = 'none';
  }
}

// ===== Render Message =====
function renderAiMessage(role, text, isTyping = false) {
  const messages = document.getElementById('aiChatMessages');
  const div = document.createElement('div');
  div.className = `ai-msg ai-msg-${role}`;

  if (isTyping) {
    div.id = 'aiTypingMsg';
    div.innerHTML = `
      <div class="ai-msg-bubble">
        <div class="ai-typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>`;
  } else {
    let formattedText = text || '';
    
    // Strip <think>...</think> reasoning blocks if model produced them
    formattedText = formattedText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Headings
    formattedText = formattedText.replace(/^### (.*$)/gm, '<h4>$1</h4>');
    formattedText = formattedText.replace(/^## (.*$)/gm, '<h4>$1</h4>');
    formattedText = formattedText.replace(/^# (.*$)/gm, '<h4>$1</h4>');

    // Bold **text**
    formattedText = formattedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Bullet items (* item or - item at line start)
    formattedText = formattedText.replace(/^[\*\-] (.*$)/gm, '<li>$1</li>');

    // Group adjacent <li> items into <ul>...</ul>
    formattedText = formattedText.replace(/(<li>[\s\S]*?<\/li>)/g, (match) => {
      return '<ul>' + match + '</ul>';
    });
    formattedText = formattedText.replace(/<\/ul>\s*<ul>/g, '');

    // Line breaks
    formattedText = formattedText.replace(/\n\n/g, '</p><p>');
    formattedText = formattedText.replace(/\n/g, '<br>');

    div.innerHTML = `
      <div class="ai-msg-bubble">
        ${role === 'assistant' ? '<div class="ai-msg-avatar">🤖</div>' : ''}
        <div class="ai-msg-text"><p>${formattedText}</p></div>
      </div>`;
  }

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

// Direct local Ollama API fallback
async function callOllamaDirectly(message, context, history = []) {
  const ollamaUrl = 'http://192.168.1.9:11434/api/chat';
  const systemPrompt = `Kamu adalah AI Assistant KPI untuk Divisi Design di sebuah perusahaan percetakan.
Tugas kamu:
1. Menganalisis data KPI (kecepatan kerja, beban kerja designer)
2. Mengidentifikasi masalah dalam alur kerja (workflow)
3. Memberikan rekomendasi konkret dan actionable untuk meningkatkan efisiensi
4. Menjawab pertanyaan spesifik tentang performa designer atau tahapan produksi

Gunakan bahasa Indonesia yang natural dan profesional. Jawaban singkat tapi informatif (max 300 kata per jawaban).`;

  const ctxParts = [];
  if (context.totalTasks !== undefined) ctxParts.push(`Total task aktif: ${context.totalTasks}`);
  if (context.avgSpeed !== undefined) ctxParts.push(`Rata-rata kecepatan: ${context.avgSpeed} hari`);
  if (context.designers) {
    const dList = context.designers.map(d => `  - ${d.name}: ${d.count} task, avg ${d.avgSpeed || '-'} hari`).join('\n');
    ctxParts.push(`Beban kerja designer:\n${dList}`);
  }
  if (context.stageDistribution) {
    const sList = context.stageDistribution.map(s => `  - ${s.name}: ${s.count} task`).join('\n');
    ctxParts.push(`Distribusi stage:\n${sList}`);
  }
  if (context.workflowAvg) {
    const wfList = context.workflowAvg.filter(w => w.avg !== null).map(w => `  - ${w.label}: ${w.avg} hari avg (${w.count} data)`).join('\n');
    ctxParts.push(`Rata-rata durasi workflow:\n${wfList}`);
  }

  const promptText = `=== DATA KPI SAAT INI ===\n${ctxParts.join('\n\n')}\n\n=== PERTANYAAN USER ===\n${message}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-4).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: promptText }
  ];

  const models = ['qwen2.5:14b', 'gemma4:12b'];
  let lastErr = null;

  for (const model of models) {
    try {
      const resp = await fetch(ollamaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: false,
          options: {
            temperature: 0.7
          }
        })
      });

      if (resp.ok) {
        const resJson = await resp.json();
        let text = resJson.message?.content;
        if (text) {
          text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          return { reply: text, success: true, model: model };
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr ? lastErr.message : 'Gagal menghubungi local Ollama API (192.168.1.9:11434)');
}

// ===== Send Message =====
async function sendAiMessage(message) {
  if (!message.trim() || aiIsLoading) return;

  // Hide quick actions after first message
  const quickActions = document.getElementById('aiQuickActions');
  if (quickActions) quickActions.style.display = 'none';

  // Render user message
  renderAiMessage('user', message);
  aiMessageHistory.push({ role: 'user', text: message });

  // Clear input
  const input = document.getElementById('aiChatInput');
  if (input) { input.value = ''; input.style.height = 'auto'; }

  // Show loading
  aiIsLoading = true;
  updateAiStatus('thinking');
  const typingEl = renderAiMessage('assistant', '', true);

  try {
    const context = buildKpiContext();
    let data;

    try {
      const resp = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          context,
          history: aiMessageHistory.slice(0, -1).slice(-4)
        }),
      });

      if (resp.ok) {
        data = await resp.json();
        if (data.error && !data.reply) {
          throw new Error(data.error);
        }
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (localApiErr) {
      // Fallback: direct local Ollama API call
      console.log('Server /api/ai/chat unavailable or errored, falling back to direct Ollama call...', localApiErr);
      data = await callOllamaDirectly(message, context, aiMessageHistory.slice(0, -1));
    }

    // Remove typing indicator
    typingEl.remove();

    if (data.reply) {
      renderAiMessage('assistant', data.reply);
      aiMessageHistory.push({ role: 'assistant', text: data.reply });
    } else {
      renderAiMessage('assistant', `❌ Gagal mendapatkan respons: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    typingEl.remove();
    renderAiMessage('assistant', `❌ Gagal menghubungi AI Assistant (Ollama): ${err.message}`);
  } finally {
    aiIsLoading = false;
    updateAiStatus('ready');
  }
}

function updateAiStatus(state) {
  const statusEl = document.getElementById('aiStatus');
  if (!statusEl) return;
  if (state === 'thinking') {
    statusEl.innerHTML = '<span class="ai-status-dot thinking"></span> Sedang berpikir...';
  } else {
    statusEl.innerHTML = '<span class="ai-status-dot"></span> Siap membantu';
  }
}

function clearAiChat() {
  aiMessageHistory.length = 0;
  const messages = document.getElementById('aiChatMessages');
  messages.innerHTML = `
    <div class="ai-welcome">
      <div class="ai-welcome-icon">✨</div>
      <div class="ai-welcome-text">Chat dibersihkan. Ada yang bisa saya bantu?</div>
    </div>`;
  const qa = document.getElementById('aiQuickActions');
  if (qa) qa.style.display = '';
}

// ===== Event Listeners for AI =====
document.addEventListener('DOMContentLoaded', () => {
  // FAB button
  const fab = document.getElementById('aiChatFab');
  if (fab) fab.addEventListener('click', toggleAiPanel);

  // Send button
  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) sendBtn.addEventListener('click', () => {
    const input = document.getElementById('aiChatInput');
    sendAiMessage(input?.value || '');
  });

  // Enter key (Shift+Enter = new line)
  const inputEl = document.getElementById('aiChatInput');
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiMessage(inputEl.value);
      }
    });
    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
    });
  }

  // Quick action chips
  document.querySelectorAll('.ai-quick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) sendAiMessage(prompt);
    });
  });

  // Clear chat
  const clearBtn = document.getElementById('aiClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearAiChat);

  // Initialize AI PPTX Report Module
  initPptxReportModule();
});


/* ========================================
   AI PPTX REPORT GENERATOR MODULE
   ======================================== */

// ===== Initialization & Modal Handlers =====
function initPptxReportModule() {
  const pptxBtn = document.getElementById('aiPptxBtn');
  const pptxChip = document.getElementById('aiPptxChip');
  const closeBtn = document.getElementById('pptxClose');
  const cancelBtn = document.getElementById('pptxCancel');
  const generateBtn = document.getElementById('pptxGenerate');
  const overlay = document.getElementById('pptxOverlay');

  if (pptxBtn) pptxBtn.addEventListener('click', openPptxModal);
  if (pptxChip) pptxChip.addEventListener('click', openPptxModal);
  if (closeBtn) closeBtn.addEventListener('click', closePptxModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closePptxModal);

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePptxModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) {
      closePptxModal();
    }
  });

  // Preset buttons
  document.querySelectorAll('.pptx-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      applyPptxPreset(btn.getAttribute('data-preset'));
      updatePptxPreview();
    });
  });

  // Inputs live preview
  const inputsToListen = ['pptxDateFrom', 'pptxDateTo', 'pptxTitle'];
  inputsToListen.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updatePptxPreview);
  });

  const sectionsContainer = document.getElementById('pptxSections');
  if (sectionsContainer) {
    sectionsContainer.addEventListener('change', updatePptxPreview);
  }

  // Generate button
  if (generateBtn) {
    generateBtn.addEventListener('click', handleGeneratePptx);
  }
}

function openPptxModal() {
  const overlay = document.getElementById('pptxOverlay');
  if (!overlay) return;

  populatePptxDesigners();

  // If dates are empty, default to 'all' or last 3 months
  const dateFromEl = document.getElementById('pptxDateFrom');
  const dateToEl = document.getElementById('pptxDateTo');
  if (!dateFromEl.value && !dateToEl.value) {
    applyPptxPreset('last3');
  }

  const progressEl = document.getElementById('pptxProgress');
  if (progressEl) progressEl.hidden = true;

  const generateBtn = document.getElementById('pptxGenerate');
  if (generateBtn) {
    generateBtn.disabled = false;
    generateBtn.textContent = '✨ Generate PPTX';
  }

  updatePptxPreview();
  overlay.classList.add('active');
}

function closePptxModal() {
  const overlay = document.getElementById('pptxOverlay');
  if (overlay) overlay.classList.remove('active');
}

function applyPptxPreset(preset) {
  const dateFromEl = document.getElementById('pptxDateFrom');
  const dateToEl = document.getElementById('pptxDateTo');
  if (!dateFromEl || !dateToEl) return;

  const now = new Date();
  const formatYMD = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  if (preset === 'thisMonth') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    dateFromEl.value = formatYMD(start);
    dateToEl.value = formatYMD(now);
  } else if (preset === 'lastMonth') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    dateFromEl.value = formatYMD(start);
    dateToEl.value = formatYMD(end);
  } else if (preset === 'last3') {
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    dateFromEl.value = formatYMD(start);
    dateToEl.value = formatYMD(now);
  } else if (preset === 'all') {
    dateFromEl.value = '';
    dateToEl.value = '';
  }
}

function populatePptxDesigners() {
  const container = document.getElementById('pptxDesigners');
  if (!container) return;

  const designers = [...new Set(rawData.map(r => r.design).filter(d => d && d !== 'False'))].sort();
  container.innerHTML = designers.map(d => {
    const label = d.charAt(0).toUpperCase() + d.slice(1);
    return `<button type="button" class="pptx-chip" data-designer="${escHtml(d)}">${escHtml(label)}</button>`;
  }).join('');

  container.querySelectorAll('.pptx-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
      updatePptxPreview();
    });
  });
}

function getPptxCriteria() {
  const title = document.getElementById('pptxTitle')?.value.trim() || 'Laporan Analisis KPI Divisi Design';
  const dateFrom = document.getElementById('pptxDateFrom')?.value || '';
  const dateTo = document.getElementById('pptxDateTo')?.value || '';
  const instruction = document.getElementById('pptxInstruction')?.value.trim() || '';
  const tone = document.getElementById('pptxTone')?.value || 'manajemen';
  const useAi = document.getElementById('pptxUseAi')?.checked !== false;

  const selectedChips = document.querySelectorAll('#pptxDesigners .pptx-chip.selected');
  const designers = Array.from(selectedChips).map(c => c.getAttribute('data-designer')).filter(Boolean);

  const checkedSections = Array.from(
    document.querySelectorAll('#pptxSections input[type="checkbox"]:checked')
  ).map(cb => cb.value);

  return { title, dateFrom, dateTo, designers, sections: checkedSections, instruction, tone, useAi };
}

function filterProjectsForReport(criteria) {
  let list = rawData.slice();

  // Filter by Designer
  if (criteria.designers && criteria.designers.length > 0) {
    const dSet = new Set(criteria.designers.map(d => d.toLowerCase()));
    list = list.filter(r => r.design && dSet.has(r.design.toLowerCase()));
  }

  // Filter by Date (using orderDate or fileIn)
  if (criteria.dateFrom || criteria.dateTo) {
    const from = criteria.dateFrom ? new Date(criteria.dateFrom + 'T00:00:00') : null;
    const to = criteria.dateTo ? new Date(criteria.dateTo + 'T23:59:59') : null;

    list = list.filter(r => {
      const dStr = r.orderDate || r.fileIn;
      if (!dStr) return false;
      const d = new Date(dStr);
      if (isNaN(d)) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  return list;
}

function updatePptxPreview() {
  const preview = document.getElementById('pptxPreview');
  if (!preview) return;

  const criteria = getPptxCriteria();
  const matched = filterProjectsForReport(criteria);
  const total = rawData.length;

  const designerText = criteria.designers.length > 0
    ? `Designer: <strong>${criteria.designers.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')}</strong>`
    : 'Semua designer';

  const periodText = (criteria.dateFrom || criteria.dateTo)
    ? `Periode: <strong>${criteria.dateFrom || 'Awal'} s/d ${criteria.dateTo || 'Sekarang'}</strong>`
    : 'Seluruh periode data';

  const slideEstimate = 2 + criteria.sections.length;

  preview.innerHTML = `
    <div>🎯 <strong>${matched.length}</strong> dari <strong>${total}</strong> project memenuhi kriteria ini (${periodText} • ${designerText}).</div>
    <div style="margin-top: 4px; font-size: 0.73rem; opacity: 0.85;">Estimasi presentasi: <strong>${slideEstimate} slide</strong> (Format Widescreen 16:9, Dark Theme).</div>
  `;
}


// ===== Statistical Engine for Report =====
function computeReportStats(records) {
  const total = records.length;
  const completed = records.filter(r => r.speed !== null && r.speed >= 0);

  const speeds = completed.map(r => r.speed);
  const avgSpeed = speeds.length > 0
    ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10
    : 0;

  const fastCount = records.filter(r => r.speedStatus === 'fast').length;
  const normalCount = records.filter(r => r.speedStatus === 'normal').length;
  const slowCount = records.filter(r => r.speedStatus === 'slow').length;
  const bottleneckCount = records.filter(r => r.speedStatus === 'bottleneck').length;
  const progressCount = records.filter(r => r.speedStatus === 'progress').length;

  const onTargetCount = fastCount + normalCount;
  const onTargetPct = total > 0 ? Math.round((onTargetCount / total) * 100) : 0;
  const fastPct = total > 0 ? Math.round((fastCount / total) * 100) : 0;

  // Designer Breakdown
  const designerMap = {};
  records.forEach(r => {
    const d = (r.design || '').trim();
    if (!d || d === 'False') return;
    if (!designerMap[d]) {
      designerMap[d] = { name: d, count: 0, speeds: [], fast: 0, slow: 0, bottleneck: 0 };
    }
    designerMap[d].count++;
    if (r.speed !== null && r.speed >= 0) designerMap[d].speeds.push(r.speed);
    if (r.speedStatus === 'fast') designerMap[d].fast++;
    if (r.speedStatus === 'slow') designerMap[d].slow++;
    if (r.speedStatus === 'bottleneck') designerMap[d].bottleneck++;
  });

  const designers = Object.values(designerMap).map(d => {
    const dAvg = d.speeds.length > 0
      ? Math.round((d.speeds.reduce((a, b) => a + b, 0) / d.speeds.length) * 10) / 10
      : 0;
    const dOnTarget = d.count > 0 ? Math.round(((d.fast + (d.count - d.slow - d.bottleneck)) / d.count) * 100) : 0;
    return {
      name: d.name.charAt(0).toUpperCase() + d.name.slice(1),
      count: d.count,
      avgSpeed: dAvg,
      fast: d.fast,
      slow: d.slow,
      bottleneck: d.bottleneck,
      onTargetPct: Math.min(100, Math.max(0, dOnTarget))
    };
  }).sort((a, b) => b.count - a.count);

  // Workflow Stages Breakdown
  const calcWfStage = (startKey, endKey, label) => {
    const diffs = records.map(r => {
      const s = r[startKey] ? new Date(r[startKey]) : null;
      const e = r[endKey] ? new Date(r[endKey]) : null;
      if (!s || !e || isNaN(s) || isNaN(e)) return null;
      const d = (e - s) / (1000 * 60 * 60 * 24);
      return d >= 0 ? d : null;
    }).filter(v => v !== null);

    const count = diffs.length;
    const avg = count > 0 ? Math.round((diffs.reduce((a, b) => a + b, 0) / count) * 10) / 10 : 0;
    return { label, count, avg };
  };

  const workflow = [
    calcWfStage('fileIn', 'progressAW', 'File In → Progress AW'),
    calcWfStage('progressAW', 'sendAWkeCust', 'Progress AW → Send AW'),
    calcWfStage('sendAWkeCust', 'accAWdariCust', 'Send AW → ACC AW (Customer)'),
    calcWfStage('sendKeDigitalPrint', 'receiveDigital', 'Send Digital → Receive'),
    calcWfStage('progressLayout', 'review', 'Progress Layout → Review'),
    calcWfStage('review', 'lemparFileKeCTP', 'Review → Lempar ke CTP')
  ];

  // Monthly Throughput Trend
  const monthMap = {};
  records.forEach(r => {
    const dStr = r.orderDate || r.fileIn;
    if (!dStr) return;
    const d = new Date(dStr);
    if (isNaN(d)) return;
    const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap[mKey]) monthMap[mKey] = { month: mKey, count: 0, speeds: [] };
    monthMap[mKey].count++;
    if (r.speed !== null && r.speed >= 0) monthMap[mKey].speeds.push(r.speed);
  });

  const monthlyTrend = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
    month: m.month,
    count: m.count,
    avgSpeed: m.speeds.length > 0 ? Math.round((m.speeds.reduce((a, b) => a + b, 0) / m.speeds.length) * 10) / 10 : 0
  })).slice(-12);

  // Top Delayed / Bottleneck Projects
  const today = new Date();
  const delayedProjects = records
    .filter(r => r.speedStatus === 'slow' || r.speedStatus === 'bottleneck' || (r.speed !== null && r.speed > 12))
    .map(r => {
      const dur = r.speed !== null ? r.speed : 0;
      return {
        title: r.title || 'Tanpa Judul',
        customer: r.customer || '—',
        designer: r.design || '—',
        stage: r.stage || 'In Progress',
        duration: dur,
        speedStatus: r.speedStatus
      };
    })
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 8);

  return {
    total,
    completed: completed.length,
    avgSpeed,
    fastCount,
    normalCount,
    slowCount,
    bottleneckCount,
    progressCount,
    onTargetPct,
    fastPct,
    designers,
    workflow,
    monthlyTrend,
    delayedProjects
  };
}


// ===== AI Insight Engine (Ollama + Fallback) =====
async function fetchAiReportInsights(criteria, stats) {
  if (!criteria.useAi) {
    return buildFallbackInsights(criteria, stats);
  }

  const promptText = `
Anda adalah Lead Business Analyst & KPI Expert untuk Divisi Design percetakan.
Buatkan analisis eksekutif komprehensif berdasarkan data KPI berikut untuk bahan presentasi PowerPoint.

KRITERIA LAPORAN:
- Judul: ${criteria.title}
- Periode: ${criteria.dateFrom || 'Awal'} s/d ${criteria.dateTo || 'Sekarang'}
- Designer Terpilih: ${criteria.designers.length > 0 ? criteria.designers.join(', ') : 'Semua Designer'}
- Gaya Bahasa / Tone: ${criteria.tone}
- Instruksi Khusus: ${criteria.instruction || 'Analisis objektif performa divisi dan temukan potensi efisiensi.'}

RINGKASAN DATA STATISTIK:
- Total Project: ${stats.total}
- Rata-rata Durasi Pengerjaan: ${stats.avgSpeed} hari (Target standar: ≤ 12 hari)
- Status Kecepatan: Cepat (≤3 hr): ${stats.fastCount}, Normal (4-14 hr): ${stats.normalCount}, Lambat (>14 hr): ${stats.slowCount}, Bottleneck: ${stats.bottleneckCount}, In Progress: ${stats.progressCount}
- Tingkat On-Target / Kecepatan Baik: ${stats.onTargetPct}%

PERFORMA DESIGNER:
${stats.designers.map(d => `- ${d.name}: ${d.count} project, rata-rata ${d.avgSpeed} hari, ${d.fast} cepat, ${d.slow} lambat`).join('\n')}

DURASI TAHAPAN WORKFLOW:
${stats.workflow.map(w => `- ${w.label}: rata-rata ${w.avg} hari (${w.count} project)`).join('\n')}

BOTTLENECK UTAMA:
${stats.delayedProjects.slice(0, 5).map(p => `- ${p.title} (${p.designer}): ${p.duration} hari di stage ${p.stage}`).join('\n')}

FORMAT OUTPUT WAJIB JSON DENGAN STRUKTUR:
{
  "executive_summary": "1-2 paragraf ringkasan eksekutif padat tentang performa divisi design...",
  "key_findings": [
    "Poin temuan kunci 1...",
    "Poin temuan kunci 2...",
    "Poin temuan kunci 3...",
    "Poin temuan kunci 4..."
  ],
  "designer_analysis": [
    { "name": "Nama Designer", "highlight": "Sorotan performa & beban kerja...", "recommendation": "Saran perbaikan..." }
  ],
  "workflow_bottleneck": "Analisis tahapan yang paling memakan waktu dan penyebab utamanya...",
  "recommendations": [
    "Rekomendasi strategis 1...",
    "Rekomendasi strategis 2...",
    "Rekomendasi strategis 3...",
    "Rekomendasi strategis 4..."
  ]
}
`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

    const res = await fetch('/api/ai/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptText,
        system: 'Anda adalah Lead Business Analyst profesional yang menyusun analisis KPI divisi design ke dalam format JSON terstruktur.'
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const json = await res.json();
      if (json && json.insights && typeof json.insights === 'object') {
        return json.insights;
      }
    }
  } catch (err) {
    console.warn('Ollama AI report fetch failed or timed out, using analytical fallback:', err);
  }

  // Graceful fallback to rule-based insights
  return buildFallbackInsights(criteria, stats);
}

function buildFallbackInsights(criteria, stats) {
  const topDesigner = stats.designers[0] || { name: 'Designer', count: 0, avgSpeed: 0 };
  const fastestDesigner = stats.designers.filter(d => d.count >= 3).sort((a, b) => a.avgSpeed - b.avgSpeed)[0] || topDesigner;

  const slowestWorkflow = stats.workflow.slice().sort((a, b) => b.avg - a.avg)[0] || { label: 'Send AW → ACC AW', avg: 0 };

  const execSummary = `Divisi Design menangani total ${stats.total} project dengan rata-rata durasi penyelesaian ${stats.avgSpeed} hari. Sebanyak ${stats.onTargetPct}% project berada dalam kategori on-target / kecepatan baik, dengan ${stats.fastCount} project berhasil diselesaikan dalam kategori cepat (≤ 3 hari). Analisis menunjukkan kapasitas tim secara umum produktif, namun terdapat variasi durasi signifikan pada tahapan tertentu yang memerlukan standardisasi alur kerja.`;

  const keyFindings = [
    `Volume kerja total mencapai ${stats.total} project, dengan kontribusi terbesar dari ${topDesigner.name} (${topDesigner.count} project).`,
    `Tingkat efisiensi pengerjaan tercepat dicapai oleh ${fastestDesigner.name} dengan rata-rata durasi ${fastestDesigner.avgSpeed} hari.`,
    `Tahapan "${slowestWorkflow.label}" menjadi area dengan durasi terpanjang (rata-rata ${slowestWorkflow.avg} hari), mayoritas dipengaruhi siklus revisi dan waktu respon customer.`,
    `Terdeteksi ${stats.bottleneckCount + stats.slowCount} project dengan durasi di atas standar (>14 hari), memerlukan mitigasi proaktif pada tahap approval.`
  ];

  const designerAnalysis = stats.designers.map(d => ({
    name: d.name,
    highlight: `Menangani ${d.count} project dengan rata-rata durasi ${d.avgSpeed} hari (${d.fast} cepat, ${d.slow} lambat).`,
    recommendation: d.avgSpeed > 10 ? 'Perlu pendampingan pada manajemen antrean dan prioritas revisi.' : 'Performa stabil, pertahankan ritme dan dokumentasi workflow.'
  }));

  const workflowBottleneck = `Tahapan yang paling membutuhkan optimasi adalah "${slowestWorkflow.label}" dengan rata-rata ${slowestWorkflow.avg} hari. Keterlambatan pada fase ini umumnya disebabkan oleh jeda menunggu konfirmasi ACC artwork dari pihak customer serta proses revisi berulang sebelum masuk ke tahapan CTP.`;

  const recommendations = [
    'Terapkan SLA konfirmasi ACC AW dengan customer maksimal 2x24 jam untuk mencegah project tertahan di tahapan approval.',
    'Standarisasi template artwork dan checklist pre-flight sebelum pengiriman AW guna meminimalisir revisi berulang.',
    'Lakukan penyeimbangan beban kerja (workload balancing) berkala antar designer agar tidak terjadi penumpukan project pada individu tertentu.',
    'Gunakan dashboard KPI harian untuk memantau status project yang mendekati batas 7 hari tanpa pembaruan stage.'
  ];

  return {
    executive_summary: execSummary,
    key_findings: keyFindings,
    designer_analysis: designerAnalysis,
    workflow_bottleneck: workflowBottleneck,
    recommendations: recommendations
  };
}


// ===== PptxGenJS Slide Builder =====
async function buildPptxPresentation(criteria, stats, insights) {
  if (typeof window.PptxGenJS === 'undefined') {
    throw new Error('Library PptxGenJS tidak tersedia. Pastikan terhubung dengan internet untuk memuat modul.');
  }

  const pres = new window.PptxGenJS();
  pres.layout = 'LAYOUT_16x9'; // 10 x 5.625 inches
  pres.author = 'AI KPI Assistant';
  pres.company = 'Divisi Design';
  pres.title = criteria.title;

  // Modern Color Palette
  const C = {
    BG: '0B0F19',
    CARD_BG: '161E2E',
    CARD_BORDER: '253248',
    HEADER_BG: '1E293B',
    AMBER: 'F59E0B',
    CYAN: '06B6D4',
    EMERALD: '10B981',
    RED: 'EF4444',
    PURPLE: '8B5CF6',
    WHITE: 'FFFFFF',
    LIGHT: 'E2E8F0',
    MUTED: '94A3B8',
    DARK_TEXT: '0F172A'
  };

  // PptxGenJS Shape & Chart Enums (with string fallbacks)
  const Shapes = {
    RECTANGLE: (pres.shapes && pres.shapes.RECTANGLE) || 'rect',
    ROUNDED_RECTANGLE: (pres.shapes && pres.shapes.ROUNDED_RECTANGLE) || 'roundRect',
    OVAL: (pres.shapes && pres.shapes.OVAL) || 'ellipse',
    LINE: (pres.shapes && pres.shapes.LINE) || 'line'
  };

  const Charts = {
    DOUGHNUT: (pres.charts && pres.charts.DOUGHNUT) || 'doughnut',
    BAR: (pres.charts && pres.charts.BAR) || 'bar',
    LINE: (pres.charts && pres.charts.LINE) || 'line',
    PIE: (pres.charts && pres.charts.PIE) || 'pie'
  };

  let currentSlideIndex = 0;

  // Slide Helper Functions
  const addHeader = (slide, category, title, subtitle) => {
    slide.background = { color: C.BG };

    // Accent line at top
    slide.addShape(Shapes.RECTANGLE, {
      x: 0, y: 0, w: 10, h: 0.08,
      fill: { color: C.AMBER }, line: { color: C.AMBER }
    });

    // Category / Tag
    slide.addText(category.toUpperCase(), {
      x: 0.6, y: 0.35, w: 8.8, h: 0.25,
      fontSize: 9, bold: true, color: C.AMBER, fontFace: 'Calibri'
    });

    // Title
    slide.addText(title, {
      x: 0.6, y: 0.62, w: 8.8, h: 0.45,
      fontSize: 20, bold: true, color: C.WHITE, fontFace: 'Calibri'
    });

    // Subtitle
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.6, y: 1.08, w: 8.8, h: 0.25,
        fontSize: 10, color: C.MUTED, fontFace: 'Calibri'
      });
    }
  };

  const addFooter = (slide, pageNum) => {
    slide.addText('Divisi Design & Pre-Press • KPI Executive Report', {
      x: 0.6, y: 5.25, w: 6.5, h: 0.25,
      fontSize: 8, color: C.MUTED, fontFace: 'Calibri'
    });
    if (pageNum) {
      slide.addText(`Slide ${pageNum}`, {
        x: 8.6, y: 5.25, w: 0.8, h: 0.25,
        fontSize: 8, color: C.MUTED, align: 'right', fontFace: 'Calibri'
      });
    }
  };

  const addCard = (slide, x, y, w, h, bgColor = C.CARD_BG, borderColor = C.CARD_BORDER) => {
    slide.addShape(Shapes.ROUNDED_RECTANGLE, {
      x, y, w, h,
      fill: { color: bgColor },
      line: { color: borderColor, width: 1 },
      rectRadius: 0.08
    });
  };

  // ----------------------------------------------------
  // SLIDE 1: COVER SLIDE
  // ----------------------------------------------------
  currentSlideIndex++;
  const coverSlide = pres.addSlide();
  coverSlide.background = { color: C.BG };

  // Decorative top accent banner
  coverSlide.addShape(Shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.1,
    fill: { color: C.AMBER }, line: { color: C.AMBER }
  });

  // Category Pill
  coverSlide.addShape(Shapes.ROUNDED_RECTANGLE, {
    x: 0.8, y: 0.9, w: 2.8, h: 0.35,
    fill: { color: '241802' },
    line: { color: C.AMBER, width: 1 },
    rectRadius: 0.1
  });
  coverSlide.addText('DIVISI DESIGN & PRE-PRESS', {
    x: 0.8, y: 0.9, w: 2.8, h: 0.35,
    fontSize: 9, bold: true, color: C.AMBER, align: 'center', fontFace: 'Calibri'
  });

  // Main Title
  coverSlide.addText(criteria.title, {
    x: 0.8, y: 1.45, w: 8.4, h: 1.1,
    fontSize: 28, bold: true, color: C.WHITE, fontFace: 'Calibri'
  });

  // Subtitle / Scope
  const designerScope = criteria.designers.length > 0
    ? criteria.designers.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
    : 'Semua Designer';
  const periodScope = (criteria.dateFrom || criteria.dateTo)
    ? `${criteria.dateFrom || 'Awal'} s/d ${criteria.dateTo || 'Sekarang'}`
    : 'Seluruh Periode Data';

  coverSlide.addText(`Analisis Kinerja Operasional & Evaluasi Metrik Kecepatan Kerja\nPeriode: ${periodScope} • Scope: ${designerScope}`, {
    x: 0.8, y: 2.6, w: 8.4, h: 0.7,
    fontSize: 12, color: C.MUTED, fontFace: 'Calibri'
  });

  // 3 Info Cards at Bottom
  const coverCards = [
    { title: 'DATA DIANALISIS', val: `${stats.total} Project`, sub: `${stats.completed} project selesai`, color: C.CYAN },
    { title: 'RATA-RATA DURASI', val: `${stats.avgSpeed} Hari`, sub: `Target KPI: ≤ ${KPI_TARGETS.speedDays} Hari`, color: C.AMBER },
    { title: 'AI ANALYTICS', val: criteria.useAi ? 'Ollama AI Active' : 'Statistical Model', sub: `Tone: ${criteria.tone}`, color: C.EMERALD }
  ];

  coverCards.forEach((c, idx) => {
    const x = 0.8 + idx * 2.9;
    addCard(coverSlide, x, 3.65, 2.65, 1.25);
    coverSlide.addText(c.title, {
      x: x + 0.2, y: 3.8, w: 2.25, h: 0.25,
      fontSize: 8, bold: true, color: C.MUTED, fontFace: 'Calibri'
    });
    coverSlide.addText(c.val, {
      x: x + 0.2, y: 4.05, w: 2.25, h: 0.45,
      fontSize: 18, bold: true, color: c.color, fontFace: 'Calibri'
    });
    coverSlide.addText(c.sub, {
      x: x + 0.2, y: 4.5, w: 2.25, h: 0.25,
      fontSize: 8, color: C.LIGHT, fontFace: 'Calibri'
    });
  });

  addFooter(coverSlide, currentSlideIndex);

  // ----------------------------------------------------
  // SLIDE 2: EXECUTIVE SUMMARY & SCORECARD
  // ----------------------------------------------------
  if (criteria.sections.includes('summary')) {
    currentSlideIndex++;
    const s2 = pres.addSlide();
    addHeader(s2, 'Executive Overview', 'Ringkasan Eksekutif & KPI Scorecard', 'Sorotan menyeluruh performa divisi design berdasarkan target kecepatan dan volume.');

    // 4 KPI Metric Cards across the top
    const kpiMetrics = [
      { label: 'TOTAL PROJECT', val: `${stats.total}`, sub: 'Volume dianalisis', color: C.CYAN },
      { label: 'RATA-RATA DURASI', val: `${stats.avgSpeed} Hari`, sub: `Target: ≤ ${KPI_TARGETS.speedDays} hari`, color: C.AMBER },
      { label: 'ON-TARGET / CEPAT', val: `${stats.onTargetPct}%`, sub: `${stats.fastCount} project ≤ 3 hari`, color: C.EMERALD },
      { label: 'BOTTLENECK', val: `${stats.bottleneckCount + stats.slowCount}`, sub: 'Project > 14 hari', color: C.RED }
    ];

    kpiMetrics.forEach((m, idx) => {
      const x = 0.6 + idx * 2.25;
      addCard(s2, x, 1.45, 2.1, 0.95);
      s2.addText(m.label, {
        x: x + 0.15, y: 1.55, w: 1.8, h: 0.2,
        fontSize: 7.5, bold: true, color: C.MUTED, fontFace: 'Calibri'
      });
      s2.addText(m.val, {
        x: x + 0.15, y: 1.75, w: 1.8, h: 0.35,
        fontSize: 16, bold: true, color: m.color, fontFace: 'Calibri'
      });
      s2.addText(m.sub, {
        x: x + 0.15, y: 2.1, w: 1.8, h: 0.2,
        fontSize: 7.5, color: C.LIGHT, fontFace: 'Calibri'
      });
    });

    // Executive Summary Card (Left)
    addCard(s2, 0.6, 2.55, 4.25, 2.5);
    s2.addText('RINGKASAN PERFORMA EKSEKUTIF', {
      x: 0.8, y: 2.7, w: 3.85, h: 0.25,
      fontSize: 9, bold: true, color: C.AMBER, fontFace: 'Calibri'
    });
    s2.addText(insights.executive_summary || 'Performa divisi design menunjukkan kinerja yang memadai dengan tingkat penyelesaian on-target yang stabil.', {
      x: 0.8, y: 3.0, w: 3.85, h: 1.9,
      fontSize: 9.5, color: C.LIGHT, fontFace: 'Calibri', lineSpacingMultiple: 1.15
    });

    // Key Findings Card (Right)
    addCard(s2, 5.0, 2.55, 4.4, 2.5);
    s2.addText('TEMUAN KUNCI & HIGHLIGHTS', {
      x: 5.2, y: 2.7, w: 4.0, h: 0.25,
      fontSize: 9, bold: true, color: C.CYAN, fontFace: 'Calibri'
    });

    const findingsText = (insights.key_findings || []).map((f, i) => `${i + 1}. ${f}`).join('\n\n');
    s2.addText(findingsText || 'Data menunjukkan distribusi pengerjaan yang aktif di semua designer.', {
      x: 5.2, y: 3.0, w: 4.0, h: 1.9,
      fontSize: 9, color: C.LIGHT, fontFace: 'Calibri', lineSpacingMultiple: 1.1
    });

    addFooter(s2, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 3: SPEED DISTRIBUTION & PROJECT HEALTH
  // ----------------------------------------------------
  if (criteria.sections.includes('speed')) {
    currentSlideIndex++;
    const s3 = pres.addSlide();
    addHeader(s3, 'Speed Analytics', 'Distribusi Status Kecepatan Pengerjaan', 'Klasifikasi project berdasarkan durasi dari File In hingga Lempar ke CTP.');

    // Doughnut Chart (Left)
    try {
      s3.addChart(Charts.DOUGHNUT, [
        {
          name: 'Project Status',
          labels: ['Cepat (≤3 hr)', 'Normal (4-14 hr)', 'Lambat (>14 hr)', 'Bottleneck', 'In Progress'],
          values: [stats.fastCount, stats.normalCount, stats.slowCount, stats.bottleneckCount, stats.progressCount]
        }
      ], {
        x: 0.6, y: 1.5, w: 4.3, h: 3.4,
        showLegend: true, legendPos: 'b',
        chartColors: [C.EMERALD, C.CYAN, C.RED, C.AMBER, C.PURPLE],
        holeSize: 55
      });
    } catch (e) {
      console.warn('Chart error, fallback to visual table:', e);
      addCard(s3, 0.6, 1.5, 4.3, 3.4);
      s3.addText('Grafik Distribusi Kecepatan', { x: 0.8, y: 1.7, w: 3.9, h: 0.3, fontSize: 11, bold: true, color: C.WHITE });
    }

    // Breakdown Table & Insights (Right)
    const speedRows = [
      [
        { text: 'Kategori Status', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5 } },
        { text: 'Kriteria', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5 } },
        { text: 'Project', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5, align: 'center' } },
        { text: 'Rasio', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5, align: 'center' } }
      ],
      [
        { text: '🚀 Cepat (Fast)', options: { color: C.EMERALD, bold: true, fontSize: 8 } },
        { text: '≤ 3 Hari', options: { color: C.LIGHT, fontSize: 8 } },
        { text: `${stats.fastCount}`, options: { color: C.WHITE, align: 'center', fontSize: 8 } },
        { text: `${stats.total > 0 ? Math.round((stats.fastCount / stats.total) * 100) : 0}%`, options: { color: C.LIGHT, align: 'center', fontSize: 8 } }
      ],
      [
        { text: '✅ Normal', options: { color: C.CYAN, bold: true, fontSize: 8 } },
        { text: '4 - 14 Hari', options: { color: C.LIGHT, fontSize: 8 } },
        { text: `${stats.normalCount}`, options: { color: C.WHITE, align: 'center', fontSize: 8 } },
        { text: `${stats.total > 0 ? Math.round((stats.normalCount / stats.total) * 100) : 0}%`, options: { color: C.LIGHT, align: 'center', fontSize: 8 } }
      ],
      [
        { text: '⚠️ Lambat', options: { color: C.RED, bold: true, fontSize: 8 } },
        { text: '> 14 Hari', options: { color: C.LIGHT, fontSize: 8 } },
        { text: `${stats.slowCount}`, options: { color: C.WHITE, align: 'center', fontSize: 8 } },
        { text: `${stats.total > 0 ? Math.round((stats.slowCount / stats.total) * 100) : 0}%`, options: { color: C.LIGHT, align: 'center', fontSize: 8 } }
      ],
      [
        { text: '⛔ Bottleneck', options: { color: C.AMBER, bold: true, fontSize: 8 } },
        { text: 'Tertahan > 7 hr', options: { color: C.LIGHT, fontSize: 8 } },
        { text: `${stats.bottleneckCount}`, options: { color: C.WHITE, align: 'center', fontSize: 8 } },
        { text: `${stats.total > 0 ? Math.round((stats.bottleneckCount / stats.total) * 100) : 0}%`, options: { color: C.LIGHT, align: 'center', fontSize: 8 } }
      ],
      [
        { text: '⏳ In Progress', options: { color: C.PURPLE, bold: true, fontSize: 8 } },
        { text: 'Sedang berjalan', options: { color: C.LIGHT, fontSize: 8 } },
        { text: `${stats.progressCount}`, options: { color: C.WHITE, align: 'center', fontSize: 8 } },
        { text: `${stats.total > 0 ? Math.round((stats.progressCount / stats.total) * 100) : 0}%`, options: { color: C.LIGHT, align: 'center', fontSize: 8 } }
      ]
    ];

    s3.addTable(speedRows, {
      x: 5.1, y: 1.5, w: 4.3,
      colW: [1.4, 1.1, 0.9, 0.9],
      border: { pt: 0.5, color: C.CARD_BORDER },
      fill: C.CARD_BG
    });

    // Diagnostic card below table
    addCard(s3, 5.1, 3.75, 4.3, 1.25);
    s3.addText('DIAGNOSIS KESEHATAN PROSES:', {
      x: 5.3, y: 3.85, w: 3.9, h: 0.2,
      fontSize: 8, bold: true, color: C.AMBER, fontFace: 'Calibri'
    });
    s3.addText(`Mayoritas project (${stats.onTargetPct}%) berhasil dikerjakan sesuai target. Fokus optimasi perlu diarahkan pada ${stats.slowCount + stats.bottleneckCount} project yang mengalami perlambatan agar siklus produksi tidak menghambat jadwal cetak.`, {
      x: 5.3, y: 4.1, w: 3.9, h: 0.8,
      fontSize: 8.5, color: C.LIGHT, fontFace: 'Calibri'
    });

    addFooter(s3, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 4: DESIGNER PERFORMANCE MATRIX
  // ----------------------------------------------------
  if (criteria.sections.includes('designer')) {
    currentSlideIndex++;
    const s4 = pres.addSlide();
    addHeader(s4, 'Team Performance', 'Matriks Produktivitas & Beban Kerja Designer', 'Perbandingan output volume, kecepatan rata-rata, dan rasio on-target tiap designer.');

    const tableRows = [
      [
        { text: 'No', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } },
        { text: 'Designer', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8 } },
        { text: 'Total Project', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } },
        { text: 'Rata-rata Durasi', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } },
        { text: 'Cepat (≤3 hr)', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } },
        { text: 'Lambat (>14 hr)', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } },
        { text: 'On-Target %', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } }
      ]
    ];

    stats.designers.slice(0, 8).forEach((d, idx) => {
      const isFast = d.avgSpeed <= 5 && d.count >= 2;
      tableRows.push([
        { text: `${idx + 1}`, options: { color: C.MUTED, align: 'center', fontSize: 8 } },
        { text: d.name, options: { bold: true, color: isFast ? C.EMERALD : C.WHITE, fontSize: 8 } },
        { text: `${d.count}`, options: { color: C.CYAN, align: 'center', fontSize: 8, bold: true } },
        { text: `${d.avgSpeed} hari`, options: { color: d.avgSpeed > 12 ? C.RED : C.LIGHT, align: 'center', fontSize: 8 } },
        { text: `${d.fast}`, options: { color: C.EMERALD, align: 'center', fontSize: 8 } },
        { text: `${d.slow}`, options: { color: d.slow > 0 ? C.RED : C.MUTED, align: 'center', fontSize: 8 } },
        { text: `${d.onTargetPct}%`, options: { color: d.onTargetPct >= 75 ? C.EMERALD : C.AMBER, align: 'center', fontSize: 8, bold: true } }
      ]);
    });

    s4.addTable(tableRows, {
      x: 0.6, y: 1.5, w: 8.8,
      colW: [0.5, 2.0, 1.2, 1.3, 1.2, 1.3, 1.3],
      border: { pt: 0.5, color: C.CARD_BORDER },
      fill: C.CARD_BG
    });

    // Designer Analysis Insights below table
    addCard(s4, 0.6, 4.05, 8.8, 1.05);
    s4.addText('ANALISIS INSIGHT PERFORMA TIM:', {
      x: 0.8, y: 4.15, w: 8.4, h: 0.2,
      fontSize: 8, bold: true, color: C.AMBER, fontFace: 'Calibri'
    });

    const dHighlights = (insights.designer_analysis || []).slice(0, 3).map(da => `• ${da.name}: ${da.highlight}`).join('   ');
    s4.addText(dHighlights || 'Beban kerja terdistribusi dengan variasi durasi dipengaruhi oleh jenis produk dan tingkat revisi artwork dari customer.', {
      x: 0.8, y: 4.4, w: 8.4, h: 0.6,
      fontSize: 8.5, color: C.LIGHT, fontFace: 'Calibri'
    });

    addFooter(s4, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 5: MONTHLY PRODUCTION TREND
  // ----------------------------------------------------
  if (criteria.sections.includes('trend') && stats.monthlyTrend.length > 0) {
    currentSlideIndex++;
    const s5 = pres.addSlide();
    addHeader(s5, 'Throughput Trend', 'Tren Volume & Kecepatan Bulanan', 'Pergerakan jumlah project masuk dan rata-rata waktu pengerjaan per bulan.');

    const labels = stats.monthlyTrend.map(m => m.month);
    const counts = stats.monthlyTrend.map(m => m.count);

    try {
      s5.addChart(Charts.BAR, [
        {
          name: 'Jumlah Project',
          labels: labels,
          values: counts
        }
      ], {
        x: 0.6, y: 1.5, w: 5.6, h: 3.4,
        barDir: 'col',
        chartColors: [C.CYAN],
        showLegend: false
      });
    } catch (e) {
      console.warn('Bar chart error:', e);
      addCard(s5, 0.6, 1.5, 5.6, 3.4);
      s5.addText('Data Tren Bulanan', { x: 0.8, y: 1.7, w: 5.2, h: 0.3, fontSize: 11, bold: true, color: C.WHITE });
    }

    // Trend Summary Cards (Right)
    const peakMonth = stats.monthlyTrend.slice().sort((a, b) => b.count - a.count)[0];
    addCard(s5, 6.4, 1.5, 3.0, 1.55);
    s5.addText('BULAN TERSIBUK (PEAK)', { x: 6.6, y: 1.7, w: 2.6, h: 0.2, fontSize: 7.5, bold: true, color: C.AMBER });
    s5.addText(peakMonth ? peakMonth.month : '—', { x: 6.6, y: 1.95, w: 2.6, h: 0.4, fontSize: 18, bold: true, color: C.WHITE });
    s5.addText(`${peakMonth ? peakMonth.count : 0} project tercatat\nRata-rata: ${peakMonth ? peakMonth.avgSpeed : 0} hari`, { x: 6.6, y: 2.4, w: 2.6, h: 0.5, fontSize: 8.5, color: C.LIGHT });

    addCard(s5, 6.4, 3.2, 3.0, 1.7);
    s5.addText('ANALISIS KAPASITAS BULANAN', { x: 6.6, y: 3.35, w: 2.6, h: 0.2, fontSize: 7.5, bold: true, color: C.CYAN });
    s5.addText('Fluktuasi volume project dipengaruhi oleh siklus pemesanan berulang customer. Pada saat lonjakan pesanan, koordinasi penugasan awal sangat menentukan kestabilan durasi pengerjaan.', {
      x: 6.6, y: 3.65, w: 2.6, h: 1.15,
      fontSize: 8, color: C.LIGHT, fontFace: 'Calibri'
    });

    addFooter(s5, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 6: WORKFLOW STAGES DURATION ANALYSIS
  // ----------------------------------------------------
  if (criteria.sections.includes('workflow')) {
    currentSlideIndex++;
    const s6 = pres.addSlide();
    addHeader(s6, 'Workflow Efficiency', 'Analisis Durasi Tiap Tahapan Workflow', 'Identifikasi latency pada alur kerja dari File In, Desain, Approval Customer, hingga CTP.');

    const wfRows = [
      [
        { text: 'Tahapan Alur Kerja (Workflow Step)', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5 } },
        { text: 'Project Terdata', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5, align: 'center' } },
        { text: 'Rata-rata Durasi', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5, align: 'center' } },
        { text: 'Evaluasi Latency', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8.5, align: 'center' } }
      ]
    ];

    stats.workflow.forEach(w => {
      let statusColor = C.EMERALD;
      let statusLabel = 'Efisien (≤2 hr)';
      if (w.avg > 5) {
        statusColor = C.RED;
        statusLabel = 'Bottleneck (>5 hr)';
      } else if (w.avg > 2) {
        statusColor = C.AMBER;
        statusLabel = 'Moderat (2-5 hr)';
      }

      wfRows.push([
        { text: w.label, options: { color: C.WHITE, bold: true, fontSize: 8.5 } },
        { text: `${w.count}`, options: { color: C.LIGHT, align: 'center', fontSize: 8.5 } },
        { text: `${w.avg} hari`, options: { color: statusColor, align: 'center', fontSize: 8.5, bold: true } },
        { text: statusLabel, options: { color: statusColor, align: 'center', fontSize: 8 } }
      ]);
    });

    s6.addTable(wfRows, {
      x: 0.6, y: 1.5, w: 8.8,
      colW: [4.0, 1.4, 1.6, 1.8],
      border: { pt: 0.5, color: C.CARD_BORDER },
      fill: C.CARD_BG
    });

    // Workflow Bottleneck Diagnosis Card below table
    addCard(s6, 0.6, 3.8, 8.8, 1.3);
    s6.addText('DIAGNOSIS TAHAPAN KRITIS & BOTTLENECK:', {
      x: 0.8, y: 3.92, w: 8.4, h: 0.2,
      fontSize: 8, bold: true, color: C.AMBER, fontFace: 'Calibri'
    });
    s6.addText(insights.workflow_bottleneck || 'Tahapan Send AW → ACC AW memiliki durasi paling lama karena ketergantungan pada respon approval customer. Sementara proses internal File In → Progress AW berjalan relatif efisien.', {
      x: 0.8, y: 4.18, w: 8.4, h: 0.8,
      fontSize: 9, color: C.LIGHT, fontFace: 'Calibri'
    });

    addFooter(s6, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 7: TOP BOTTLENECKS & DELAYED PROJECTS
  // ----------------------------------------------------
  if (criteria.sections.includes('bottleneck') && stats.delayedProjects.length > 0) {
    currentSlideIndex++;
    const s7 = pres.addSlide();
    addHeader(s7, 'Actionable Bottlenecks', 'Daftar Proyek Bottleneck & Terlambat', 'Project yang memiliki durasi pengerjaan tertinggi atau tertahan lama di tahapan aktif.');

    const delayRows = [
      [
        { text: 'No', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } },
        { text: 'Judul Project', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8 } },
        { text: 'Customer', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8 } },
        { text: 'Designer', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8 } },
        { text: 'Stage Terakhir', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8 } },
        { text: 'Durasi', options: { bold: true, fill: C.HEADER_BG, color: C.WHITE, fontSize: 8, align: 'center' } }
      ]
    ];

    stats.delayedProjects.slice(0, 6).forEach((p, idx) => {
      delayRows.push([
        { text: `${idx + 1}`, options: { color: C.MUTED, align: 'center', fontSize: 8 } },
        { text: p.title.length > 28 ? p.title.substring(0, 26) + '...' : p.title, options: { bold: true, color: C.WHITE, fontSize: 8 } },
        { text: p.customer.length > 22 ? p.customer.substring(0, 20) + '...' : p.customer, options: { color: C.LIGHT, fontSize: 8 } },
        { text: p.designer, options: { color: C.CYAN, fontSize: 8 } },
        { text: p.stage, options: { color: C.AMBER, fontSize: 8 } },
        { text: `${p.duration} hari`, options: { color: C.RED, bold: true, align: 'center', fontSize: 8 } }
      ]);
    });

    s7.addTable(delayRows, {
      x: 0.6, y: 1.5, w: 8.8,
      colW: [0.5, 2.7, 2.0, 1.2, 1.4, 1.0],
      border: { pt: 0.5, color: C.CARD_BORDER },
      fill: C.CARD_BG
    });

    // Mitigation Box
    addCard(s7, 0.6, 3.85, 8.8, 1.25);
    s7.addText('TINDAKAN MITIGASI YANG DIREKOMENDASIKAN:', {
      x: 0.8, y: 3.98, w: 8.4, h: 0.2,
      fontSize: 8, bold: true, color: C.RED, fontFace: 'Calibri'
    });
    s7.addText('1. Lakukan eskalasi ke Account Executive / Sales untuk menindaklanjuti customer yang belum memberikan feedback artwork.\n2. Jika terdapat kendala teknis spesifikasi file, jadwalkan review bersama Pre-Press & Designer dalam waktu 24 jam.', {
      x: 0.8, y: 4.22, w: 8.4, h: 0.75,
      fontSize: 8.5, color: C.LIGHT, fontFace: 'Calibri', lineSpacingMultiple: 1.15
    });

    addFooter(s7, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 8: DESIGNER SPOTLIGHT / INDIVIDUAL DETAIL
  // ----------------------------------------------------
  if (criteria.sections.includes('designerDetail') && stats.designers.length > 0) {
    currentSlideIndex++;
    const s8 = pres.addSlide();
    addHeader(s8, 'Individual Spotlight', 'Sorotan Individual Kinerja Designer', 'Profil detail per designer: volume pengerjaan, kecepatan rata-rata, dan rekomendasi fokus.');

    const top3 = stats.designers.slice(0, 3);
    top3.forEach((d, idx) => {
      const x = 0.6 + idx * 3.0;
      addCard(s8, x, 1.5, 2.8, 3.55);

      // Avatar badge
      s8.addShape(Shapes.OVAL, {
        x: x + 0.2, y: 1.7, w: 0.45, h: 0.45,
        fill: { color: C.HEADER_BG }, line: { color: C.CYAN, width: 1 }
      });
      s8.addText(d.name.charAt(0), {
        x: x + 0.2, y: 1.7, w: 0.45, h: 0.45,
        fontSize: 14, bold: true, color: C.CYAN, align: 'center', fontFace: 'Calibri'
      });

      // Name & role
      s8.addText(d.name, {
        x: x + 0.75, y: 1.7, w: 1.85, h: 0.25,
        fontSize: 14, bold: true, color: C.WHITE, fontFace: 'Calibri'
      });
      s8.addText('Graphic Designer', {
        x: x + 0.75, y: 1.95, w: 1.85, h: 0.2,
        fontSize: 8, color: C.MUTED, fontFace: 'Calibri'
      });

      // Stats
      s8.addText('TOTAL PROJECT', { x: x + 0.2, y: 2.3, w: 2.4, h: 0.2, fontSize: 7, color: C.MUTED, bold: true });
      s8.addText(`${d.count} Project`, { x: x + 0.2, y: 2.48, w: 2.4, h: 0.3, fontSize: 13, bold: true, color: C.CYAN });

      s8.addText('RATA-RATA DURASI', { x: x + 0.2, y: 2.85, w: 2.4, h: 0.2, fontSize: 7, color: C.MUTED, bold: true });
      s8.addText(`${d.avgSpeed} Hari`, { x: x + 0.2, y: 3.03, w: 2.4, h: 0.3, fontSize: 13, bold: true, color: d.avgSpeed > 10 ? C.RED : C.EMERALD });

      s8.addText('RASIO ON-TARGET', { x: x + 0.2, y: 3.4, w: 2.4, h: 0.2, fontSize: 7, color: C.MUTED, bold: true });
      s8.addText(`${d.onTargetPct}%`, { x: x + 0.2, y: 3.58, w: 2.4, h: 0.3, fontSize: 13, bold: true, color: C.AMBER });

      // Action note
      const rec = (insights.designer_analysis || []).find(da => da.name.toLowerCase() === d.name.toLowerCase());
      s8.addText(rec ? rec.recommendation : 'Pertahankan kecepatan dan tingkat ketelitian file cetak.', {
        x: x + 0.2, y: 3.95, w: 2.4, h: 0.95,
        fontSize: 7.5, color: C.LIGHT, fontFace: 'Calibri', lineSpacingMultiple: 1.1
      });
    });

    addFooter(s8, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 9: AI STRATEGIC RECOMMENDATIONS
  // ----------------------------------------------------
  if (criteria.sections.includes('recommendation')) {
    currentSlideIndex++;
    const s9 = pres.addSlide();
    addHeader(s9, 'Strategic Action Plan', 'Rekomendasi Strategis & Solusi Efisiensi', 'Langkah konkret berbasis data untuk mempercepat alur kerja dan meningkatkan KPI divisi.');

    const recPillars = [
      {
        icon: '⚡',
        title: 'Optimasi Workflow Internal',
        color: C.AMBER,
        body: (insights.recommendations && insights.recommendations[0]) || 'Standarisasi checklist file masuk untuk memangkas waktu pengerjaan tahapan awal desain.'
      },
      {
        icon: '💬',
        title: 'Manajemen SLA Customer',
        color: C.CYAN,
        body: (insights.recommendations && insights.recommendations[1]) || 'Terapkan SLA approval 48 jam dengan reminder otomatis kepada customer sebelum artwork dicetak.'
      },
      {
        icon: '⚖️',
        title: 'Penyeimbangan Beban Kerja',
        color: C.EMERALD,
        body: (insights.recommendations && insights.recommendations[2]) || 'Rotasi penugasan berkala dan redistribusi project complex agar kapasitas tim terpakai maksimal.'
      },
      {
        icon: '🎯',
        title: 'Monitoring KPI & Automasi',
        color: C.PURPLE,
        body: (insights.recommendations && insights.recommendations[3]) || 'Implementasikan evaluasi mingguan pada project macet dan integrasikan sinkronisasi Odoo otomatis.'
      }
    ];

    recPillars.forEach((p, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const x = 0.6 + col * 4.45;
      const y = 1.5 + row * 1.75;

      addCard(s9, x, y, 4.3, 1.6);

      s9.addText(`${p.icon}  ${p.title.toUpperCase()}`, {
        x: x + 0.25, y: y + 0.18, w: 3.8, h: 0.25,
        fontSize: 9, bold: true, color: p.color, fontFace: 'Calibri'
      });

      s9.addText(p.body, {
        x: x + 0.25, y: y + 0.5, w: 3.8, h: 0.95,
        fontSize: 9, color: C.LIGHT, fontFace: 'Calibri', lineSpacingMultiple: 1.15
      });
    });

    addFooter(s9, currentSlideIndex);
  }

  // ----------------------------------------------------
  // SLIDE 10: CLOSING SLIDE
  // ----------------------------------------------------
  currentSlideIndex++;
  const closeSlide = pres.addSlide();
  closeSlide.background = { color: C.BG };

  closeSlide.addShape(Shapes.RECTANGLE, {
    x: 0, y: 0, w: 10, h: 0.1,
    fill: { color: C.AMBER }, line: { color: C.AMBER }
  });

  closeSlide.addText('DIVISI DESIGN & PRE-PRESS', {
    x: 1.0, y: 1.6, w: 8.0, h: 0.3,
    fontSize: 10, bold: true, color: C.AMBER, align: 'center', fontFace: 'Calibri'
  });

  closeSlide.addText('Terima Kasih', {
    x: 1.0, y: 2.0, w: 8.0, h: 0.9,
    fontSize: 34, bold: true, color: C.WHITE, align: 'center', fontFace: 'Calibri'
  });

  closeSlide.addText('Laporan disusun otomatis oleh AI KPI Assistant berbasis data operasional riil.\nDiskusi & implementasi rekomendasi dapat dijadwalkan pada sesi evaluasi mingguan.', {
    x: 1.0, y: 3.0, w: 8.0, h: 0.6,
    fontSize: 11, color: C.MUTED, align: 'center', fontFace: 'Calibri'
  });

  addCard(closeSlide, 2.5, 3.8, 5.0, 0.8, C.CARD_BG, C.CARD_BORDER);
  closeSlide.addText(`KPI Dashboard Divisi Design • Generated on ${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`, {
    x: 2.5, y: 3.8, w: 5.0, h: 0.8,
    fontSize: 9, color: C.LIGHT, align: 'center', fontFace: 'Calibri'
  });

  addFooter(closeSlide, currentSlideIndex);

  // Generate & Save file
  const dateSafe = new Date().toISOString().slice(0, 10);
  const cleanTitle = criteria.title.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const filename = `${cleanTitle}_${dateSafe}.pptx`;

  await pres.writeFile({ fileName: filename });
  return filename;
}


// ===== Main Generate Flow =====
async function handleGeneratePptx() {
  const generateBtn = document.getElementById('pptxGenerate');
  const progressEl = document.getElementById('pptxProgress');
  const progressFill = document.getElementById('pptxProgressFill');
  const progressText = document.getElementById('pptxProgressText');

  const updateProgress = (pct, text) => {
    if (progressEl) progressEl.hidden = false;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = text;
  };

  try {
    if (generateBtn) {
      generateBtn.disabled = true;
      generateBtn.textContent = '⏳ Memproses...';
    }

    const criteria = getPptxCriteria();

    // Step 1: Filter data
    updateProgress(20, 'Menyaring data sesuai kriteria periode dan designer...');
    await new Promise(r => setTimeout(r, 200));
    const records = filterProjectsForReport(criteria);

    if (records.length === 0) {
      alert('Tidak ada project yang cocok dengan kriteria filter yang Anda pilih.');
      if (progressEl) progressEl.hidden = true;
      if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.textContent = '✨ Generate PPTX';
      }
      return;
    }

    // Step 2: Compute Statistics
    updateProgress(40, `Menghitung metrik & agregasi KPI untuk ${records.length} project...`);
    await new Promise(r => setTimeout(r, 250));
    const stats = computeReportStats(records);

    // Step 3: Fetch AI Insights
    updateProgress(65, criteria.useAi ? 'Meminta analisis mendalam dari AI Assistant (Ollama)...' : 'Menyusun narasi analisis berbasis data...');
    const insights = await fetchAiReportInsights(criteria, stats);

    // Step 4: Build Presentation Slides
    updateProgress(85, 'Menyusun slide presentasi PowerPoint (widescreen 16:9)...');
    await new Promise(r => setTimeout(r, 300));
    const filename = await buildPptxPresentation(criteria, stats, insights);

    // Step 5: Completed
    updateProgress(100, `Selesai! File ${filename} berhasil diunduh.`);
    await new Promise(r => setTimeout(r, 600));

    closePptxModal();

    // Notify user in AI Chat
    const designerInfo = criteria.designers.length > 0 ? criteria.designers.join(', ') : 'Semua Designer';
    const periodInfo = (criteria.dateFrom || criteria.dateTo) ? `${criteria.dateFrom || 'Awal'} s/d ${criteria.dateTo || 'Sekarang'}` : 'Semua Periode';

    const completionMsg = `✅ **Laporan PPTX Berhasil Dibuat & Diunduh!**

📄 **File:** \`${filename}\`
🎯 **Judul:** ${criteria.title}
📊 **Volume Data:** ${records.length} project (${periodInfo} • Designer: ${designerInfo})
💡 **Rata-rata Durasi:** ${stats.avgSpeed} hari (${stats.onTargetPct}% on-target)

Presentasi PowerPoint 16:9 siap dipresentasikan ke tim atau manajemen. Anda dapat membuka atau mengedit file tersebut kapan saja.`;

    appendAiMessage('assistant', completionMsg);

    // Ensure AI Chat panel is visible so user sees the message
    const panel = document.getElementById('aiChatPanel');
    if (panel && !panel.classList.contains('active')) {
      toggleAiPanel();
    }

  } catch (err) {
    console.error('Failed to generate PPTX report:', err);
    alert('Terjadi kesalahan saat membuat laporan PPTX:\n' + err.message);
  } finally {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.textContent = '✨ Generate PPTX';
    }
    if (progressEl) progressEl.hidden = true;
  }
}

