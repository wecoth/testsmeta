// ─── SMETA.JS ─────────────────────────────────────────────────────
import { appState } from './state.js';
import { renderToImage } from './render.js';

// ── Utils ─────────────────────────────────────────────────────────

export function fmt(v) {
  return (+v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}
export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v); return isNaN(d) ? v : d.toLocaleDateString('ru-RU');
}
export function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cName() { return document.getElementById('companyName')?.value.trim() || 'КОМПАНИЯ'; }
function cLetter() { return cName().charAt(0).toUpperCase(); }

// ── Logo ──────────────────────────────────────────────────────────

export function handleLogo(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    appState.logoData = ev.target.result;
    document.getElementById('logoPreview').src = appState.logoData;
    document.getElementById('logoPreview').style.display = 'block';
    document.getElementById('logoPlaceholder').style.display = 'none';
    liveUpdate();
  };
  r.readAsDataURL(f);
}

// ── Plan ──────────────────────────────────────────────────────────

export function handlePlan(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    appState.planData = ev.target.result;
    document.getElementById('planPreview').src = appState.planData;
    document.getElementById('planPreview').style.display = 'block';
    document.getElementById('planPlaceholder').style.display = 'none';
    liveUpdate();
  };
  r.readAsDataURL(f);
}

// ── Capture canvas as plan image ─────────────────────────────────
// Берёт текущий canvas чертежа, вычисляет bbox всех стен в экранных
// координатах, кропает и масштабирует на offscreen canvas.
// Результат: PNG dataURL сохраняется как planData.
export function captureCanvas() {
  const walls = window._appState?.walls ?? appState?.walls ?? [];
  if (!walls.length) { alert('Нарисуйте план перед захватом'); return; }

  // planData — чистый чертёж (без сетки и размеров) для страницы "Планирование работ"
  const cleanImg = renderToImage(800, 600, false);
  // planDataFull — полный обмерный план (со всеми размерами) для отдельной страницы
  const fullImg  = renderToImage(2480, 1754, true); // A4 landscape @300dpi

  if (!cleanImg) { alert('Не удалось захватить чертёж'); return; }

  appState.planData     = cleanImg;
  appState.planDataFull = fullImg;
  if (window._appState) {
    window._appState.planData     = cleanImg;
    window._appState.planDataFull = fullImg;
  }

  // Обновляем превью в форме
  const planPreview = document.getElementById('planPreview');
  const planPlaceholder = document.getElementById('planPlaceholder');
  if (planPreview) { planPreview.src = cleanImg; planPreview.style.display = 'block'; }
  if (planPlaceholder) planPlaceholder.style.display = 'none';

  liveUpdate();
  alert('Чертёж захвачен ✓');
}

// ── Rooms (smeta side) ────────────────────────────────────────────

let roomCnt = 0;

export function addRoom(n = '', f = '', w = '', p = '') {
  roomCnt++;
  const id = 'rm' + roomCnt;
  const d = document.createElement('div');
  d.className = 'room-item'; d.id = id;
  d.innerHTML = `
    <div class="room-item-head">
      <input class="room-name-inp" placeholder="Название помещения" value="${esc(n)}" oninput="window._smetaModule.recalcRooms()">
      <button class="btn-del-room" onclick="document.getElementById('${id}').remove();window._smetaModule.recalcRooms()">×</button>
    </div>
    <div class="room-fields">
      <div class="room-field"><label>Пол м²</label><input placeholder="0.00" value="${f}" oninput="window._smetaModule.recalcRooms()"></div>
      <div class="room-field"><label>Стены м²</label><input placeholder="0.00" value="${w}" oninput="window._smetaModule.recalcRooms()"></div>
      <div class="room-field"><label>Периметр м</label><input placeholder="0.00" value="${p}" oninput="window._smetaModule.recalcRooms()"></div>
    </div>`;
  document.getElementById('roomsList')?.appendChild(d);
  recalcRooms();
}

export function recalcRooms() {
  let tf = 0, tw = 0, tp = 0;
  document.querySelectorAll('.room-item').forEach(ri => {
    const ins = ri.querySelectorAll('.room-fields input');
    tf += parseFloat(ins[0]?.value) || 0;
    tw += parseFloat(ins[1]?.value) || 0;
    tp += parseFloat(ins[2]?.value) || 0;
  });
  const has = document.querySelectorAll('.room-item').length > 0;
  const strip = document.getElementById('totalsStrip');
  if (strip) strip.style.display = has ? 'grid' : 'none';
  const tf2 = document.getElementById('totalFloor'), tw2 = document.getElementById('totalWalls'), tp2 = document.getElementById('totalPerim');
  if (tf2) tf2.textContent = tf.toFixed(2);
  if (tw2) tw2.textContent = tw.toFixed(2);
  if (tp2) tp2.textContent = tp.toFixed(2);
  updateSummary(); liveUpdate();
}

export function getRooms() {
  return Array.from(document.querySelectorAll('.room-item')).map(ri => {
    const nm = ri.querySelector('.room-name-inp')?.value || '—';
    const ins = ri.querySelectorAll('.room-fields input');
    return { name: nm, floor: ins[0]?.value || '0', walls: ins[1]?.value || '0', perim: ins[2]?.value || '0' };
  });
}

/** Import computed rooms from 2D planner into smeta rooms list */
export function importRoomsFromPlanner(rooms) {
  document.getElementById('roomsList').innerHTML = '';
  roomCnt = 0;
  rooms.forEach(r => addRoom(r.name, r.floorArea, r.wallsArea, r.perimeter));
  recalcRooms();
}

// ── Excel parse ───────────────────────────────────────────────────

function parseFile(file, cb) {
  const r = new FileReader();
  r.onload = e => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const sh = wb.Sheets[wb.SheetNames[0]];
      cb(XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' }), null);
    } catch (err) { cb(null, err); }
  };
  r.readAsArrayBuffer(file);
}

function smartParse(json) {
  if (!json || json.length < 2) return [];

  // Find header row — first row with 3+ non-empty cells
  let hi = 0;
  for (let i = 0; i < Math.min(json.length, 15); i++) {
    if (json[i].filter(c => String(c || '').trim()).length >= 3) { hi = i; break; }
  }

  // Merge up to 2 header rows to handle multi-row headers (e.g. "Стоимость" / "За ед. | Всего")
  const mergeRows = Math.min(hi + 2, json.length);
  const h = json[hi].map((c, ci) => {
    let val = String(c || '').toLowerCase().trim();
    for (let r = hi + 1; r < mergeRows; r++) {
      const sub = String(json[r][ci] || '').toLowerCase().trim();
      if (sub) val = val ? val + ' ' + sub : sub;
    }
    return val;
  });

  const fi = (...kw) => { for (const k of kw) { const i = h.findIndex(x => x.includes(k)); if (i >= 0) return i; } return -1; };
  const cols = {
    num:   fi('№', 'п/п', 'n/n', 'номер', 'num'),
    name:  fi('наименование', 'вид работ', 'позиция', 'работ', 'материал', 'смр', 'name', 'description'),
    unit:  fi('ед. изм', 'ед.изм', 'единиц', 'ед ', 'unit', 'измер'),
    qty:   fi('кол-во', 'количество', 'объём', 'объем', 'кол ', 'qty', 'count'),
    price: fi('за ед', 'за единиц', 'цена за', 'расценка', 'тариф', 'rate', 'price'),
    total: fi('всего', 'итого', 'сумма', 'стоимость работ', 'amount', 'total'),
    note:  fi('примечание', 'коммент', 'note', 'comment', 'remarks'),
  };

  // Positional fallback if name not found
  if (cols.name < 0) {
    const nonEmpty = h.map((_, i) => i).filter(i => h[i]);
    if (nonEmpty.length >= 2) {
      cols.name  = nonEmpty[1] ?? nonEmpty[0];
      cols.unit  = cols.unit  >= 0 ? cols.unit  : (nonEmpty[2] ?? -1);
      cols.qty   = cols.qty   >= 0 ? cols.qty   : (nonEmpty[3] ?? -1);
      cols.price = cols.price >= 0 ? cols.price : (nonEmpty[4] ?? -1);
      cols.total = cols.total >= 0 ? cols.total : (nonEmpty[5] ?? -1);
    }
  }

  // Data starts after merged header rows
  const dataStart = mergeRows;
  const rows = [];
  const n = v => parseFloat(String(v || '').replace(/[^0-9.,\-]/g, '').replace(',', '.')) || 0;

  for (let i = dataStart; i < json.length; i++) {
    const row = json[i];
    const name = String(row[cols.name] || '').trim();
    if (!name) continue;
    if (/^итого|^всего|^total/i.test(name)) continue;
    const qty   = cols.qty   >= 0 ? n(row[cols.qty])   : 0;
    const price = cols.price >= 0 ? n(row[cols.price]) : 0;
    let   total = cols.total >= 0 ? n(row[cols.total]) : 0;
    if (!total && qty && price) total = qty * price;
    const note  = cols.note  >= 0 ? String(row[cols.note] || '').trim() : '';
    const unit  = cols.unit  >= 0 ? String(row[cols.unit]  || '').trim() : '';
    // Detect section header: name present but no unit, qty, price, total
    const isSection = !unit && !qty && !price && !total;
    rows.push({ name, unit, qty: qty || '', price: price || '', total: total || 0, note, isSection });
  }
  return rows;
}

// ── SMR table ─────────────────────────────────────────────────────

export function handleSmr(e) {
  const f = e.target.files[0]; if (!f) return;
  parseFile(f, (json, err) => {
    if (err) return;
    const rows = smartParse(json);
    const st = document.getElementById('smrSt');
    if (st) st.innerHTML = `<span class="smeta-ok">✓ Загружено ${rows.length} позиций</span>`;
    document.getElementById('smrZone')?.classList.add('has-data');
    const wrap = document.getElementById('smrWrap'); if (wrap) wrap.style.display = 'block';
    const mb = document.getElementById('smrManualBtn'); if (mb) mb.style.display = 'none';
    document.getElementById('smrBody').innerHTML = '';
    rows.forEach(r => addSmrRowData(r.name, r.unit, r.qty, r.price, r.total, r.isSection));
    recalcSmr();
  });
}

export function initSmrManual() {
  const mb = document.getElementById('smrManualBtn'); if (mb) mb.style.display = 'none';
  const wrap = document.getElementById('smrWrap'); if (wrap) wrap.style.display = 'block';
  addSmrRow();
}

export function addSmrRow() { addSmrRowData('', '', '', '', 0); recalcSmr(); }

function addSmrRowData(name, unit, qty, price, total, isSection) {
  const wrap = document.getElementById('smrBody'); if (!wrap) return;
  const d = document.createElement('div');
  if (isSection) {
    d.className = 'work-row-item work-row-section';
    d.innerHTML = `<span class="wn"></span><span style="font-weight:600;font-size:12px;color:#2a2a2a;grid-column:2/-1">${esc(name)}</span>`;
  } else {
    const idx = Array.from(wrap.children).filter(c => !c.classList.contains('work-row-section')).length + 1;
    d.className = 'work-row-item';
    d.innerHTML = `
    <span class="wn">${idx}</span>
    <input value="${esc(name)}" placeholder="Наименование" oninput="window._smetaModule.recalcSmr()">
    <input value="${esc(unit)}" placeholder="м2" style="text-align:center">
    <input value="${qty}" placeholder="0" style="text-align:center">
    <input value="${price || ''}" placeholder="0.00" style="text-align:right">
    <input value="${total || ''}" placeholder="0.00" style="text-align:right" oninput="window._smetaModule.recalcSmr()">
    <button class="btn-del-row" onclick="this.closest('.work-row-item').remove();window._smetaModule.renumRows('smrBody');window._smetaModule.recalcSmr()">×</button>`;
  }
  wrap.appendChild(d);
}

export function recalcSmr() {
  let t = 0;
  document.querySelectorAll('#smrBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[4]?.value) || 0; });
  const el = document.getElementById('smrTotal'); if (el) el.textContent = fmt(t);
  updateSummary(); liveUpdate();
}

export function getSmrTotal() {
  let t = 0;
  document.querySelectorAll('#smrBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[4]?.value) || 0; });
  return t;
}

export function collectSmrRows() {
  return Array.from(document.querySelectorAll('#smrBody .work-row-item')).map(r => {
    if (r.classList.contains('work-row-section')) {
      const span = r.querySelector('span:last-child');
      return { name: span?.textContent || '', unit: '', qty: '', price: '', total: 0, isSection: true };
    }
    const ins = r.querySelectorAll('input');
    return { name: ins[0]?.value || '', unit: ins[1]?.value || '', qty: ins[2]?.value || '', price: ins[3]?.value || '', total: parseFloat(ins[4]?.value) || 0, isSection: false };
  });
}

// ── Materials table ───────────────────────────────────────────────

export function handleMat(e) {
  const f = e.target.files[0]; if (!f) return;
  parseFile(f, (json, err) => {
    if (err) return;
    const rows = smartParse(json);
    const st = document.getElementById('matSt');
    if (st) st.innerHTML = `<span class="smeta-ok">✓ Загружено ${rows.length} позиций</span>`;
    document.getElementById('matZone')?.classList.add('has-data');
    const wrap = document.getElementById('matWrap'); if (wrap) wrap.style.display = 'block';
    const mb = document.getElementById('matManualBtn'); if (mb) mb.style.display = 'none';
    document.getElementById('matBody').innerHTML = '';
    rows.forEach(r => addMatRowData(r.name, r.unit, r.qty, r.price, r.total, r.isSection));
    recalcMat();
  });
}

export function initMatManual() {
  const mb = document.getElementById('matManualBtn'); if (mb) mb.style.display = 'none';
  const wrap = document.getElementById('matWrap'); if (wrap) wrap.style.display = 'block';
  addMatRow();
}

export function addMatRow() { addMatRowData('', '', '', '', 0); recalcMat(); }

function addMatRowData(name, unit, qty, price, total, isSection) {
  const wrap = document.getElementById('matBody'); if (!wrap) return;
  const d = document.createElement('div');
  if (isSection) {
    d.className = 'work-row-item work-row-section';
    d.innerHTML = `<span class="wn"></span><span style="font-weight:600;font-size:12px;color:#2a2a2a;grid-column:2/-1">${esc(name)}</span>`;
  } else {
    const idx = Array.from(wrap.children).filter(c => !c.classList.contains('work-row-section')).length + 1;
    d.className = 'work-row-item';
    d.innerHTML = `
    <span class="wn">${idx}</span>
    <input value="${esc(name)}" placeholder="Материал" oninput="window._smetaModule.recalcMat()">
    <input value="${esc(unit)}" placeholder="шт" style="text-align:center">
    <input value="${qty}" placeholder="0" style="text-align:center">
    <input value="${price || ''}" placeholder="0.00" style="text-align:right">
    <input value="${total || ''}" placeholder="0.00" style="text-align:right" oninput="window._smetaModule.recalcMat()">
    <button class="btn-del-row" onclick="this.closest('.work-row-item').remove();window._smetaModule.renumRows('matBody');window._smetaModule.recalcMat()">×</button>`;
  }
  wrap.appendChild(d);
}

export function recalcMat() {
  let t = 0;
  document.querySelectorAll('#matBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[4]?.value) || 0; });
  const el = document.getElementById('matTotal'); if (el) el.textContent = fmt(t);
  updateSummary(); liveUpdate();
}

export function getMatTotal() {
  let t = 0;
  document.querySelectorAll('#matBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[4]?.value) || 0; });
  return t;
}

export function collectMatRows() {
  return Array.from(document.querySelectorAll('#matBody .work-row-item')).map(r => {
    if (r.classList.contains('work-row-section')) {
      const span = r.querySelector('span:last-child');
      return { name: span?.textContent || '', unit: '', qty: '', price: '', total: 0, isSection: true };
    }
    const ins = r.querySelectorAll('input');
    return { name: ins[0]?.value || '', unit: ins[1]?.value || '', qty: ins[2]?.value || '', price: ins[3]?.value || '', total: parseFloat(ins[4]?.value) || 0, isSection: false };
  });
}

export function renumRows(id) {
  document.querySelectorAll(`#${id} .work-row-item .wn`).forEach((s, i) => s.textContent = i + 1);
}

// ── Summary ───────────────────────────────────────────────────────

export function updateSummary() {
  const s = getSmrTotal(), m = getMatTotal();
  const scSmr = document.getElementById('scSmr'), scMat = document.getElementById('scMat');
  const scTotal = document.getElementById('scTotal'), scMatRow = document.getElementById('scMatRow');
  if (scSmr) scSmr.textContent = fmt(s);
  if (scMat) scMat.textContent = fmt(m);
  if (scTotal) scTotal.textContent = fmt(s + m);
  if (scMatRow) scMatRow.style.display = m > 0 ? 'flex' : 'none';
}

// ── Live preview update ───────────────────────────────────────────

// ── Page overflow: split rows across multiple A4 pages ────────────
const ROW_H = 28;        // px per data row at native A4 scale
const HEADER_H = 90;     // padding-top (title area)
const FOOTER_H = 60;     // bottom padding (50px margin + footer logo area)
const A4_H = 794;        // native A4 landscape height in px (297×210mm at 96dpi)
const USABLE_H = A4_H - HEADER_H - FOOTER_H; // ~972px usable per page
const THEAD_H = 40;      // table header row

function paginateRows(rows, bodyId, pageContainerId, makePageFn) {
  const container = document.getElementById(pageContainerId);
  if (!container) return;

  // Remove previously generated overflow pages
  container.querySelectorAll('.spp-page[data-overflow="1"]').forEach(p => p.remove());

  if (!rows || rows.length === 0) return;

  const rowsPerPage = Math.floor((USABLE_H - THEAD_H) / ROW_H);
  if (rows.length <= rowsPerPage) return; // fits on one page — nothing to do

  // Chunks after the first page
  for (let start = rowsPerPage; start < rows.length; start += rowsPerPage) {
    const chunk = rows.slice(start, start + rowsPerPage);
    const isLast = (start + rowsPerPage) >= rows.length;
    const pageEl = makePageFn(chunk, isLast);
    pageEl.dataset.overflow = '1';
    container.after(pageEl);
    // move container ref so next overflow page inserts after this one
    container.parentNode.insertBefore(pageEl, container.nextSibling);
  }
}

function makeSmrOverflowPage(rows, isLast, grandTotal) {
  const page = document.createElement('div');
  page.className = 'spp-page';
  page.dataset.page = 'smr';
  page.dataset.overflow = '1';
  const tbody = rows.map(r => {
    if (r.isSection) return `<tr><td colspan="7" style="padding:6px 8px;font-size:15px;font-weight:700;color:#1a1a1a;border-bottom:1px solid #e0e0e0">${esc(r.name)}</td></tr>`;
    return `<tr><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${r._idx}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${esc(r.unit)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${r.qty}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px">${r.price ? fmt(r.price) : ''}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px;font-weight:500">${fmt(r.total)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px"></td></tr>`;
  }).join('');
  const foot = '';
  page.innerHTML = `<div class="preview-page spp-a4"><div style="padding:50px;max-height:794px;box-sizing:border-box;overflow:hidden"><table style="width:100%;border-collapse:collapse;font-size:15px;color:#2a2a2a"><thead><tr><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0;width:50px">№<br>п/п</th><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0">СМР</th><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0;width:66px">Ед. изм.</th><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0;width:66px">Кол-во</th><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0;width:108px">За ед. ₽</th><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0;width:120px">Всего ₽</th><th style="border:1px solid #c9b86a;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#fcebb0;width:100px">Примечание</th></tr></thead><tbody>${tbody}${foot}</tbody></table></div></div>`;
  return page;
}

function makeMatOverflowPage(rows, isLast, grandTotal) {
  const page = document.createElement('div');
  page.className = 'spp-page';
  page.dataset.page = 'mat';
  page.dataset.overflow = '1';
  const tbody = rows.map(r => {
    if (r.isSection) return `<tr><td colspan="7" style="padding:6px 8px;font-size:15px;font-weight:700;color:#1a1a1a;border-bottom:1px solid #e0e0e0">${esc(r.name)}</td></tr>`;
    return `<tr><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${r._idx}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${esc(r.unit)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${r.qty}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px">${r.price ? fmt(r.price) : ''}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px;font-weight:500">${fmt(r.total)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px"></td></tr>`;
  }).join('');
  const foot = '';
  page.innerHTML = `<div class="preview-page spp-a4"><div style="padding:50px;max-height:794px;box-sizing:border-box;overflow:hidden"><table style="width:100%;border-collapse:collapse;font-size:15px;color:#2a2a2a"><thead><tr><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2;width:50px">№<br>п/п</th><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2">Строительные материалы</th><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2;width:66px">Ед. изм.</th><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2;width:66px">Кол-во</th><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2;width:108px">За ед. ₽</th><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2;width:120px">Всего ₽</th><th style="border:1px solid #9fb8d9;padding:2px 8px;text-align:center;font-weight:400;font-size:15px;background:#d8e4f2;width:100px">Примечание</th></tr></thead><tbody>${tbody}${foot}</tbody></table></div></div>`;
  return page;
}

export function liveUpdate() {
  const cn = cName(), cl = cLetter();
  const sl = (document.getElementById('companySlogan')?.value || 'КАЧЕСТВО ПОД КЛЮЧ').toUpperCase();
  const on = document.getElementById('objectName')?.value || '—';
  const ex = document.getElementById('executorName')?.value || '';
  const phone = document.getElementById('companyPhone')?.value || '';
  const ogrn = document.getElementById('companyOgrn')?.value || '';
  const dt = fmtDate(document.getElementById('inspDate')?.value);
  const rooms = getRooms();
  let tf = 0, tw = 0, tp = 0;
  rooms.forEach(r => { tf += parseFloat(r.floor)||0; tw += parseFloat(r.walls)||0; tp += parseFloat(r.perim)||0; });
  const smrRows = collectSmrRows(), smrTot = getSmrTotal();
  const matRows = collectMatRows(), matTot = getMatTotal();

  // Sync right panel preview
  _syncRightPanel({ cn, cl, sl, on, ex, phone, ogrn, dt, rooms, tf, tw, tp, smrRows, smrTot, matRows, matTot });
}

function _syncRightPanel({ cn, cl, sl, on, ex, phone, ogrn, dt, rooms, tf, tw, tp, smrRows, smrTot, matRows, matTot }) {
  const hasLogo = !!appState.logoData;

  // ── Cover ──────────────────────────────────────────────────────
  const pli2 = document.getElementById('prevLogoImg2');
  const pc2  = document.getElementById('prevCircle2');
  if (hasLogo) {
    if (pli2) { pli2.src = appState.logoData; pli2.style.display = 'block'; }
    if (pc2)  pc2.style.display = 'none';
  } else {
    if (pli2) pli2.style.display = 'none';
    if (pc2)  { pc2.style.display = 'flex'; pc2.textContent = cl; }
  }

  const pcn2 = document.getElementById('prevCovName2');
  if (pcn2 && !pcn2.dataset.userEdited) pcn2.textContent = cn.toUpperCase();

  const pcs2 = document.getElementById('prevCovSlogan2');
  if (pcs2 && !pcs2.dataset.userEdited) {
    pcs2.textContent = sl;
    pcs2.style.display = sl.trim() ? '' : 'none';
  }

  // Cover footer
  const footLogo   = document.getElementById('prevFootLogoImg2');
  const footCircle = document.getElementById('prevFootCircle2');
  const footName   = document.getElementById('prevFootName2');
  if (hasLogo) {
    if (footLogo)   { footLogo.src = appState.logoData; footLogo.style.display = 'block'; }
    if (footCircle) footCircle.style.display = 'none';
    if (footName)   footName.style.display = 'none';
  } else {
    if (footLogo)   footLogo.style.display = 'none';
    if (footCircle) { footCircle.style.display = 'flex'; footCircle.textContent = cl; }
    if (footName)   { footName.style.display = ''; footName.textContent = cn.toUpperCase(); }
  }

  // ── Helper: update any footer (logo img + circle fallback) ──
  function syncFooter(imgId, circleId, nameId) {
    const img = document.getElementById(imgId);
    const cir = document.getElementById(circleId);
    const nm  = document.getElementById(nameId);
    if (hasLogo) {
      if (img) { img.src = appState.logoData; img.style.display = 'block'; }
      if (cir) cir.style.display = 'none';
      if (nm)  nm.style.display = 'none';
    } else {
      if (img) img.style.display = 'none';
      if (cir) { cir.style.display = 'flex'; cir.textContent = cl; }
      if (nm)  { nm.style.display = ''; nm.textContent = cn.toUpperCase(); }
    }
  }

  syncFooter('prevPlanFootLogoImg2', 'prevPlanFootCircle2', 'prevPlanFootName2');
  syncFooter('prevBpFtLogoImg2',     'prevBpFtC2',          'prevBpFtN2');
  syncFooter('prevSmrFtLogoImg2',    'prevSmrFtC2',         'prevSmrFtN2');
  syncFooter('prevMatFtLogoImg2',    'prevMatFtC2',         'prevMatFtN2');

  // ── Plan page ──────────────────────────────────────────────────
  const ppi2 = document.getElementById('prevPlanImg2'), pph2 = document.getElementById('prevPlanPh2');
  if (appState.planData) {
    if (ppi2) { ppi2.src = appState.planData; ppi2.style.display = 'block'; }
    if (pph2) pph2.style.display = 'none';
  } else {
    if (ppi2) ppi2.style.display = 'none';
    if (pph2) pph2.style.display = 'block';
  }

  // Object info block — new structure: Объект / Дата / Исполнитель / Телефон / ОГРН
  const poi2 = document.getElementById('prevObjInfo2');
  if (poi2) {
    const lines = [];
    if (on && on !== '—') lines.push(`<strong>Объект:</strong> ${esc(on)}`);
    if (dt && dt !== '—') lines.push(`<strong>Дата осмотра:</strong> ${dt}`);
    if (ex)               lines.push(`<strong>Исполнитель:</strong> ${esc(ex)}`);
    if (phone)            lines.push(`<strong>Телефон:</strong> ${esc(phone)}`);
    if (ogrn)             lines.push(`<strong>${esc(ogrn)}`);
    poi2.innerHTML = lines.join('<br>');
  }

  // Blueprint page
  const bpImg2 = document.getElementById('prevBpImg2'), bpPh2 = document.getElementById('prevBpPh2');
  const bpImgSrc = appState.planDataFull || appState.planData || null;
  if (bpImgSrc) {
    if (bpImg2) { bpImg2.src = bpImgSrc; bpImg2.style.display = 'block'; }
    if (bpPh2)  bpPh2.style.display = 'none';
  } else {
    if (bpImg2) bpImg2.style.display = 'none';
    if (bpPh2)  bpPh2.style.display = 'flex';
  }

  // Rooms table
  const rb2 = document.getElementById('prevRoomsBody2');
  const rf2 = document.getElementById('prevRoomsFoot2');
  if (rb2) {
    rb2.innerHTML = '';
    rooms.forEach(r => {
      rb2.innerHTML += `<tr><td style="border:1px solid #e0e0e0;padding:5px 7px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${r.floor}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${r.walls}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${r.perim}</td></tr>`;
    });
  }
  if (rf2 && rooms.length > 0) {
    rf2.innerHTML = `<tr style="font-weight:600;border-top:1px solid #bbb"><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:right">ИТОГО:</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${tf.toFixed(2)}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${tw.toFixed(2)}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${tp.toFixed(2)}</td></tr>`;
  } else if (rf2) {
    rf2.innerHTML = '';
  }

  // ── SMR table ──────────────────────────────────────────────────
  const sb2 = document.getElementById('prevSmrBody2'), se2 = document.getElementById('prevSmrEmpty2');
  if (sb2) {
    if (smrRows.length > 0) {
      if (se2) se2.style.display = 'none';
      let smrIdx = 0;
      sb2.innerHTML = smrRows.map(r => {
        if (r.isSection) {
          return `<tr><td colspan="7" style="padding:6px 8px;font-size:15px;font-weight:700;color:#1a1a1a;border-bottom:1px solid #e0e0e0">${esc(r.name)}</td></tr>`;
        }
        smrIdx++;
        return `<tr><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${smrIdx}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${esc(r.unit)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${r.qty}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px">${r.price ? fmt(r.price) : ''}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px;font-weight:500">${fmt(r.total)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px"></td></tr>`;
      }).join('');
    } else {
      if (se2) se2.style.display = 'flex';
      sb2.innerHTML = '';
    }
  }

  // ── Mat table + итоговый блок ─────────────────────────────────
  const mb2 = document.getElementById('prevMatBody2'), me2 = document.getElementById('prevMatEmpty2');
  if (mb2) {
    if (matRows.length > 0) {
      if (me2) me2.style.display = 'none';
      let matIdx = 0;
      mb2.innerHTML = matRows.map(r => {
        if (r.isSection) {
          return `<tr><td colspan="7" style="padding:6px 8px;font-size:15px;font-weight:700;color:#1a1a1a;border-bottom:1px solid #e0e0e0">${esc(r.name)}</td></tr>`;
        }
        matIdx++;
        return `<tr><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${matIdx}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${esc(r.unit)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:center;font-size:15px">${r.qty}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px">${r.price ? fmt(r.price) : ''}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;text-align:right;font-size:15px;font-weight:500">${fmt(r.total)}</td><td style="border:1px solid #e0e0e0;padding:2px 6px;font-size:15px"></td></tr>`;
      }).join('');
    } else {
      if (me2) me2.style.display = 'flex';
      mb2.innerHTML = '';
    }
  }



  // ── Paginate SMR rows onto overflow pages ──────────────────────
  const SECTION_H = 34;
  const USABLE_PX_FIRST = A4_H - HEADER_H - FOOTER_H - THEAD_H - 10; // first page: 90+60 padding
  const USABLE_PX_OVF   = A4_H - 50 - 50 - THEAD_H - 10;             // overflow pages: 50+50 padding
  function splitByHeight(rows) {
    const pages = []; let cur = [], used = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const h = r.isSection ? SECTION_H : ROW_H;
      const limit = pages.length === 0 ? USABLE_PX_FIRST : USABLE_PX_OVF;
      const nextH = (i + 1 < rows.length) ? (rows[i+1].isSection ? SECTION_H : ROW_H) : 0;
      if (used + h > limit && cur.length > 0) {
        pages.push(cur); cur = []; used = 0;
      }
      const nextLimit = pages.length === 0 ? USABLE_PX_FIRST : USABLE_PX_OVF;
      if (r.isSection && used + h + nextH > nextLimit && cur.length > 0) {
        pages.push(cur); cur = []; used = 0;
      }
      cur.push(r); used += h;
    }
    if (cur.length > 0) pages.push(cur);
    return pages;
  }

  const smrPageContainer = document.querySelector('.spp-page[data-page="smr"]:not([data-overflow])');
  if (smrPageContainer) {
    document.querySelectorAll('.spp-page[data-page="smr"][data-overflow="1"]').forEach(p => p.remove());
    let smrNum = 0;
    const smrIndexed = smrRows.map(r => { if (!r.isSection) smrNum++; return { ...r, _idx: smrNum }; });
    const smrPages = splitByHeight(smrIndexed);
    let prev = smrPageContainer;
    for (let pi = 1; pi < smrPages.length; pi++) {
      const pageEl = makeSmrOverflowPage(smrPages[pi], pi === smrPages.length - 1, smrTot);
      prev.after(pageEl); prev = pageEl;
    }
  }

  // ── Paginate MAT rows onto overflow pages ──────────────────────
  const matPageContainer = document.querySelector('.spp-page[data-page="mat"]:not([data-overflow])');
  if (matPageContainer) {
    document.querySelectorAll('.spp-page[data-page="mat"][data-overflow="1"]').forEach(p => p.remove());
    let matNum = 0;
    const matIndexed = matRows.map(r => { if (!r.isSection) matNum++; return { ...r, _idx: matNum }; });
    const matPages = splitByHeight(matIndexed);
    let prev = matPageContainer;
    for (let pi = 1; pi < matPages.length; pi++) {
      const pageEl = makeMatOverflowPage(matPages[pi], pi === matPages.length - 1, matTot);
      prev.after(pageEl); prev = pageEl;
    }
  }

  // Recalculate A4 scale after pagination (new pages may have appeared)
  if (typeof setA4Scale === 'function') setA4Scale();
}

// ── Preview modal ─────────────────────────────────────────────────

// ── PDF generation ────────────────────────────────────────────────


export async function generatePDF() {
  liveUpdate(); // Ensure spp-a4 pages are up to date before PDF capture
  const on = document.getElementById('objectName')?.value || '—';

  // Собираем HTML превью-страниц (.spp-a4), которые не скрыты
  // Клонируем, убираем UI-контролы редактора, сбрасываем transform (scale)
  const pageHtmlArr = [];
  document.querySelectorAll('.spp-page:not(.spp-hidden) .spp-a4').forEach(page => {
    const clone = page.cloneNode(true);
    // Remove editor UI
    clone.querySelectorAll('.be-toolbar, .be-h-corner, .be-h-rot, .be-margin-guide').forEach(el => el.remove());
    // Remove editor classes/styles that affect appearance
    clone.querySelectorAll('.be-block').forEach(el => {
      el.classList.remove('be-selected', 'be-editing');
    });
    // Hide elements marked as hidden
    clone.querySelectorAll('.be-hidden').forEach(el => {
      el.style.display = 'none';
    });
    // Reset page scale transform — PDF renderer gets native size
    clone.style.transform = 'none';
    clone.style.width  = '1123px';
    clone.style.height = '794px';
    pageHtmlArr.push(`<div class="pdf-a4-page">${clone.outerHTML}</div>`);
  });

  const pdfHtml = pageHtmlArr.join('\n');

  // Build CSS: include all stylesheets + GOST font + PDF page rules
  const sheetCss = Array.from(document.styleSheets).map(s => {
    try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch { return ''; }
  }).join('\n');

  const pdfCss = `
    @import url('https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600&display=swap');
    @font-face {
      font-family: 'Merriweather';
      src: url('https://raw.githubusercontent.com/MishkinIN/Font_GOST_2.304/master/gost_2.304.ttf') format('truetype');
      font-weight: normal; font-style: normal;
    }
    @page { size: 297mm 210mm; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #fff; font-family: 'Merriweather', serif; font-size: 11px; }
    .pdf-a4-page {
      width: 297mm; height: 210mm;
      page-break-after: always;
      overflow: hidden;
      position: relative;
    }
    .pdf-a4-page:last-child { page-break-after: auto; }
    .spp-a4 {
      width: 1123px; height: 794px;
      transform-origin: top left;
      transform: scale(0.2646); /* 1px = 0.2646mm, so 1123px = 297mm */
      font-family: 'Merriweather', serif !important;
      font-size: 11px;
    }
    /* GOST font everywhere */
    .spp-a4 * { font-family: 'Merriweather', serif !important; }
    /* Hide margin guide pseudo-element in PDF */
    .spp-a4::before { display: none !important; }
    .be-margin-guide { display: none !important; }
    ${sheetCss}
  `;

  const btns = document.querySelectorAll('.btn-generate');
  btns.forEach(b => { b.textContent = 'Генерация...'; b.disabled = true; });
  try {
    const resp = await fetch('https://assistcloudai.xyz/webhook/generate-pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: pdfHtml, css: pdfCss }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `Смета_${on}.pdf`; a.click();
  } catch (e2) { alert('Ошибка генерации PDF: ' + e2.message); }
  finally { btns.forEach(b => { b.textContent = 'Сформировать PDF →'; b.disabled = false; }); }
}


// ── A4 scale: fit pages to panel width ───────────────────────────
// Native A4 landscape = 1123 × 794px at 96dpi.
// We measure the real available width inside .spp-body and scale
// each page with CSS transform to fit it. Height of the .spp-page
// wrapper is set to scaledH so neighbouring pages don't overlap
// (scale() doesn't affect layout box).

const NATIVE_W = 1123;
const NATIVE_H = 794;

let _scaleRafId = 0;

export function setA4Scale() {
  if (_scaleRafId) cancelAnimationFrame(_scaleRafId);
  _scaleRafId = requestAnimationFrame(_applyA4Scale);
}

function _applyA4Scale() {
  _scaleRafId = 0;
  const body = document.querySelector('.spp-body');
  if (!body) return;

  const bodyRect = body.getBoundingClientRect();
  if (bodyRect.width < 50) return;

  const cs = getComputedStyle(body);
  const padL = parseFloat(cs.paddingLeft)  || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const SIDE_MARGIN = 16;
  const availW = Math.max(100, bodyRect.width - padL - padR - SIDE_MARGIN * 2);

  const sc = Math.min(1, Math.max(0.25, availW / NATIVE_W));
  const scaledH = Math.round(NATIVE_H * sc);

  document.querySelectorAll('.spp-a4').forEach(page => {
    page.style.transform = `scale(${sc})`;
    page.style.transformOrigin = 'top center';
  });

  // При transform:scale layout-box не меняется — .spp-a4 остаётся 794px высотой.
  // Чтобы следующая страница начиналась ПОСЛЕ визуального конца текущей,
  // задаём высоту .spp-page = scaledH (визуальная высота после scale).
  // display:block на .spp-page — страницы всегда стакаются вертикально.
  document.querySelectorAll('.spp-page:not(.spp-hidden)').forEach(wrap => {
    wrap.style.height = scaledH + 'px';
  });
}
// Also expose globally for inline scripts
window.setA4Scale = setA4Scale;

// ── Init smeta ────────────────────────────────────────────────────

export function initSmeta() {
  addRoom('Спальня', '12.92', '36.92', '14.13');
  addRoom('Кухня - гостиная', '14.69', '42.21', '14.72');
  addRoom('Прихожая', '3.30', '15.82', '5.03');
  addRoom('Сан. узел', '3.57', '19.86', '6.92');
  liveUpdate();

  // Scale A4 pages to panel width on init and resize
  setTimeout(() => {
    setA4Scale();
    setTimeout(initRightPanelEditor, 50);
  }, 100);

  // Watch panel resize
  const body = document.querySelector('.spp-body');
  if (body && window.ResizeObserver) {
    new ResizeObserver(() => setA4Scale()).observe(body);
  } else {
    window.addEventListener('resize', setA4Scale);
  }

  // Re-scale when fonts finish loading (GOST font changes metrics)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => setA4Scale());
  }
}


// ══════════════════════════════════════════════════════════════════
// BLOCK EDITOR v5 — Figma-style: drag body, corner resize, toolbar
// ══════════════════════════════════════════════════════════════════
//
// Controls per selected element:
//   • Body drag          → move freely inside page
//   • 4 corner handles   → resize (shift = free aspect, default = proportional)
//   • Double-click text  → inline contentEditable
//   • Toolbar: A− A+ | 👁/✕ (hide/show)
//
// A4 landscape: 297mm × 210mm at 96dpi = 1122.5 × 793.7px (native)
// Preview panel scales the .spp-a4 via CSS transform: scale(panelW/1123);
// transform-origin is 'top center' on .spp-a4.
// All internal coordinates are in native A4 pixels (1123×794).
//
// Why v5 exists (vs v3/v4):
// v3 made .be-block { position:absolute } in CSS from the start. Without
//   explicit width, absolute elements shrink-to-fit — flow elements that
//   were 1123px wide collapsed to their text width. First click snapshotted
//   these collapsed dimensions → big jump + broken aspect ratio.
// v4 tried to fix this by calling snapshotToDom() eagerly in attach().
//   But attach() runs at page init time, when:
//     (a) the preview panel may still be display:none (wrong tab)  → rect 0×0
//     (b) .spp-body width may not yet be measured  → wrong page scale
//     (c) web fonts (Merriweather) may not be loaded  → wrong text heights
//   Any of these fossilises elements in garbage positions — the "flying off
//   the page" bug in the exported PDF.
// v5: snapshot is LAZY. Elements stay in their natural flow (or inline
//   position:absolute for cover page) until the user actually interacts
//   with one. At first mousedown/click we capture geometry from the LIVE
//   DOM — which is guaranteed visible (user can see it), guaranteed sized
//   correctly (it's being rendered), and guaranteed post-font-load.
//   .be-block carries NO layout-breaking styles of its own.

const BlockEditor = (() => {

  // ── Constants ────────────────────────────────────────────────
  const NATIVE_W = 1123;
  const NATIVE_H = 794;
  const MIN_W = 40;
  const MIN_H = 24;

  // ── State ────────────────────────────────────────────────────
  let _sel = null;   // currently selected .be-block element

  // ── CSS ──────────────────────────────────────────────────────
  const CSS = `
    /* === .be-block wrapper ===
       Deliberately layout-neutral. Becomes position:absolute lazily,
       inside snapshotToDom(), only after the first user interaction. */
    .be-block {
      box-sizing: border-box;
      cursor: default;
      user-select: none;
      overflow: visible;
    }
    /* Content wrapper — scales on resize, toolbar/handles stay outside */
    .be-content-wrap {
      position: absolute;
      top: 0; left: 0;
      overflow: hidden;
      transform-origin: top left;
      box-sizing: border-box;
      pointer-events: auto;
    }
    /* Hover/selected borders sit on the block box — always 1:1 size, never scaled */
    .be-block:not(.be-selected):hover {
      outline: 1.5px dashed rgba(74,159,255,0.5);
      outline-offset: 0;
    }
    .be-block.be-selected {
      outline: 2px solid #4a9eff;
      outline-offset: 0px;
    }
    .be-block.be-editing {
      outline: 2px solid #2171e0;
      outline-offset: 0px;
    }
    .be-block.be-hidden {
      opacity: 0.08;
      pointer-events: all;
    }
    .be-block.be-hidden:hover { opacity: 0.25; }

    /* === Corner resize handles ===
       Pinned to block corners in block-local coords. Inverse-scaled at
       select() time so the visible square stays ~10px on screen at any zoom. */
    .be-h-corner {
      position: absolute;
      width: 10px; height: 10px;
      background: #fff;
      border: 2px solid #4a9eff;
      border-radius: 2px;
      z-index: 10001;
      pointer-events: all;
      box-sizing: border-box;
    }
    .be-h-corner[data-c="nw"] { top: 0; left: 0; transform-origin: top left;      cursor: nw-resize; }
    .be-h-corner[data-c="ne"] { top: 0; right: 0; transform-origin: top right;    cursor: ne-resize; }
    .be-h-corner[data-c="se"] { bottom: 0; right: 0; transform-origin: bottom right; cursor: se-resize; }
    .be-h-corner[data-c="sw"] { bottom: 0; left: 0; transform-origin: bottom left;   cursor: sw-resize; }

    /* === Toolbar === */
    .be-toolbar {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 50%;
      margin-bottom: 6px;
      transform-origin: bottom center;
      z-index: 10002;
      background: #1a1a2e;
      border-radius: 8px;
      padding: 5px 8px;
      gap: 4px;
      align-items: center;
      box-shadow: 0 4px 20px rgba(0,0,0,.4);
      white-space: nowrap;
      pointer-events: all;
    }
    .be-block.be-selected .be-toolbar { display: flex; }
    .be-toolbar-sep {
      width: 1px; height: 14px;
      background: rgba(255,255,255,.18);
      display: inline-block; flex-shrink: 0;
    }
    .be-tbtn {
      background: rgba(255,255,255,.1);
      border: none; border-radius: 5px;
      color: #fff; font-size: 11px; font-weight: 500;
      padding: 3px 8px; cursor: pointer;
      font-family: 'Onest', sans-serif; line-height: 1.3;
      transition: background .12s;
    }
    .be-tbtn:hover { background: rgba(255,255,255,.28); }
    .be-tbtn.be-tbtn-del { background: rgba(180,40,30,.55); }
    .be-tbtn.be-tbtn-del:hover { background: rgba(220,60,45,.85); }
  `;

  function injectStyle() {
    if (document.getElementById('be-style-v5')) return;
    // Clean up older versions on hot-reload.
    document.getElementById('be-style-v3')?.remove();
    document.getElementById('be-style-v4')?.remove();
    const s = document.createElement('style');
    s.id = 'be-style-v5'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Helpers ──────────────────────────────────────────────────

  // Live CSS scale of the .spp-a4 page wrapper.
  // Returns 0 when the page is invisible/untransformed-yet; callers must
  // bail out on 0 rather than snapshot with garbage coordinates.
  function getPageScale(page) {
    if (!page) return 0;
    const rect = page.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return 0; // display:none or detached
    const matrix = new DOMMatrixReadOnly(getComputedStyle(page).transform);
    const m = matrix.m11;
    return (m && m > 0) ? m : 1; // matrix might be 'none' → 1:1
  }

  function isSnapshotted(el) { return el.dataset.bePosInit === '1'; }

  function getState(el) {
    return {
      x: parseFloat(el.dataset.beX || '0'),
      y: parseFloat(el.dataset.beY || '0'),
      w: parseFloat(el.dataset.beW || '200'),
      h: parseFloat(el.dataset.beH || '60'),
    };
  }

  function applyState(el, st) {
    el.dataset.beX = st.x;
    el.dataset.beY = st.y;
    el.dataset.beW = st.w;
    el.dataset.beH = st.h;
    el.style.left   = st.x + 'px';
    el.style.top    = st.y + 'px';
    el.style.width  = st.w + 'px';
    el.style.height = st.h + 'px';

    // Scale content wrapper (not toolbar/handles) to fill new dimensions.
    const cw = el.querySelector(':scope > .be-content-wrap');
    if (cw) {
      const ow = parseFloat(el.dataset.beOrigW) || st.w;
      const oh = parseFloat(el.dataset.beOrigH) || st.h;
      const sc = Math.min(st.w / ow, st.h / oh);
      cw.style.width  = ow + 'px';
      cw.style.height = oh + 'px';
      cw.style.transform = `scale(${sc})`;
      cw.style.transformOrigin = 'top left';
    }
  }

  // Lazy snapshot — convert an element to frozen position:absolute in
  // NATIVE page coordinates (1123×794 pre-transform space).
  //
  // Measurement uses offsetLeft/offsetTop chain up to .spp-a4, NOT
  // getBoundingClientRect(). Reason:
  //   - offsetLeft/offsetTop report LAYOUT coords, unaffected by CSS
  //     transform on ancestors.
  //   - getBoundingClientRect() gives screen coords after every ancestor's
  //     transform. Dividing the delta by scale is mathematically correct
  //     in theory, but in practice fragile: transform-origin, stacked
  //     scales, subpixel rounding, and reading getComputedStyle() mid-
  //     layout-thrash all contribute to drift. v4 chased this for a week.
  //
  // Since .spp-a4 is position:relative (set in initPage) and all our
  // target ancestors (.be-plan-grid, .be-plan-left/right, etc.) have no
  // position, the offsetParent chain terminates at .spp-a4 — giving us
  // native-page coords directly, scale-free.
  //
  // Returns true on success, false if the page isn't ready yet.
  function snapshotToDom(el, page) {
    if (isSnapshotted(el)) return true;

    // Walk offsetParent chain to sum up coords relative to .spp-a4.
    // If the chain exits the page (or hits <body>) before reaching .spp-a4,
    // something weird is going on — bail out rather than fossilise.
    let x = 0, y = 0;
    let node = el;
    let guard = 0;
    while (node && node !== page) {
      x += node.offsetLeft || 0;
      y += node.offsetTop  || 0;
      node = node.offsetParent;
      if (++guard > 20) return false; // runaway
    }
    if (node !== page) return false;   // never reached the page

    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w < 1 || h < 1) return false;  // not laid out yet (display:none?)

    // Account for inline transform:translate used on cover-page elements
    // (left:50%; transform:translate(-50%,-50%)). offsetLeft doesn't see
    // that — translate is a paint-time shift, not a layout one. Read it
    // once from computed transform, apply, then strip.
    const cs = getComputedStyle(el);
    const mtx = new DOMMatrixReadOnly(cs.transform);
    // mtx.e = translate X (px), mtx.f = translate Y (px). For a plain
    // translate(-50%,-50%) on a 200×80 element, these will be -100 and -40.
    if (mtx.e) x += mtx.e;
    if (mtx.f) y += mtx.f;

    // Freeze geometry in native coords.
    el.style.position   = 'absolute';
    el.style.margin     = '0';
    el.style.inset      = '';
    // Belt-and-suspenders: explicitly clear right/bottom. Some elements
    // carry inline right/bottom from the original template (cover-page
    // footers) and `inset=''` doesn't always wipe those in every browser.
    el.style.right      = 'auto';
    el.style.bottom     = 'auto';
    el.style.flexShrink = '0';
    // Remove any translate() from inline transform — we've folded it into x/y.
    const cur = el.style.transform || '';
    const cleaned = cur.replace(/translate[XY]?\([^)]*\)/g, '').trim();
    el.style.transform = cleaned || '';

    // CRITICAL: reparent to the page itself.
    //
    // Our x/y are in .spp-a4's native coordinate system. But position:absolute
    // positions against the NEAREST positioned ancestor — which, for elements
    // inside .be-plan-right (position:relative) or similar wrappers, is NOT
    // .spp-a4. Writing left:578 to an element whose containing block starts
    // at offsetLeft=577 shoves it another 577px to the right — off the page.
    //
    // Moving the element to be a direct child of .spp-a4 makes the page the
    // containing block, so our native-coord x/y land exactly where we measured.
    // Elements stay identified by id/class, so any code that queries them
    // (liveUpdate, etc.) keeps working.
    if (el.parentNode !== page) {
      page.appendChild(el);
    }

    applyState(el, { x, y, w, h });
    el.dataset.bePosInit = '1';
    el.dataset.beOrigW   = w;
    el.dataset.beOrigH   = h;

    // Wrap all real content (not toolbar/handles) in .be-content-wrap
    // so applyState can scale only content, leaving UI chrome unaffected.
    if (!el.querySelector(':scope > .be-content-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'be-content-wrap';
      wrap.style.cssText = `position:absolute;top:0;left:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;`;
      // Move all children except toolbar and handles into the wrap.
      Array.from(el.childNodes).forEach(child => {
        if (child.classList && (child.classList.contains('be-toolbar') || child.classList.contains('be-h-corner'))) return;
        wrap.appendChild(child);
      });
      // Re-enable pointer events on content so clicks still work.
      wrap.style.pointerEvents = 'auto';
      el.insertBefore(wrap, el.firstChild);
    }
    return true;
  }

  function updateHandleScale(el, page) {
    const sc = getPageScale(page) || 1;
    const inv = 1 / sc;
    el.querySelectorAll('.be-h-corner').forEach(h => {
      h.style.transform = `scale(${inv})`;
    });
    const tb = el.querySelector(':scope > .be-toolbar');
    if (tb) tb.style.transform = `translateX(-50%) scale(${inv})`;
  }

  function clampIntoPage(st) {
    // Разрешаем выходить за границы страницы (нужно для футера-логотипа).
    // Ограничиваем только снизу и слева с большим запасом чтобы элемент
    // не улетал совсем за пределы досягаемости.
    const MARGIN = 200; // px в нативных координатах — можно уйти за край на 200px
    return {
      x: Math.max(-MARGIN, Math.min(NATIVE_W + MARGIN - 10, st.x)),
      y: Math.max(-MARGIN, Math.min(NATIVE_H + MARGIN - 10, st.y)),
      w: st.w,
      h: st.h,
    };
  }

  // ── Selection ────────────────────────────────────────────────

  function select(el) {
    if (_sel && _sel !== el) deselect(_sel);
    _sel = el;
    el.classList.add('be-selected');
    const page = el.closest('.spp-a4');
    if (page) {
      page.style.overflow = 'visible';
      updateHandleScale(el, page);
    }
    el.querySelectorAll('.be-h-corner').forEach(h => h.style.display = '');
  }

  function deselect(el) {
    if (!el) return;
    el.classList.remove('be-selected', 'be-editing');
    if (el.contentEditable === 'true') el.contentEditable = 'false';
    el.querySelectorAll('.be-h-corner').forEach(h => h.style.display = 'none');
    const page = el.closest('.spp-a4');
    if (page) page.style.overflow = 'hidden';
    _sel = null;
  }

  function setupGlobalDeselect() {
    if (document.body.dataset.beGlobalDesel) return;
    document.body.dataset.beGlobalDesel = '1';
    document.addEventListener('mousedown', e => {
      if (!_sel) return;
      if (e.target.closest('.be-block, .be-toolbar, .be-h-corner')) return;
      deselect(_sel);
    }, true);
  }

  // ── Drag (body) ──────────────────────────────────────────────

  function setupBodyDrag(el, page) {
    el.addEventListener('mousedown', e => {
      if (e.target.closest('.be-toolbar, .be-h-corner')) return;
      if (e.button !== 0) return;
      // Clicks on nested be-blocks belong to them.
      const innerBlock = e.target.closest('.be-block');
      if (innerBlock && innerBlock !== el) return;

      e.preventDefault();
      e.stopPropagation();

      // LAZY SNAPSHOT — the page is definitely visible now (user clicked on
      // something inside it), so measurements are trustworthy.
      if (!snapshotToDom(el, page)) {
        // Very unlikely: page reports 0 size right when user clicked.
        // Just select without dragging.
        select(el);
        return;
      }
      select(el);

      const sc = getPageScale(page) || 1;
      const st = getState(el);
      const ox = st.x, oy = st.y;
      const sx = e.clientX, sy = e.clientY;

      const onMove = mv => {
        const dx = (mv.clientX - sx) / sc;
        const dy = (mv.clientY - sy) / sc;
        const ns = clampIntoPage({ ...getState(el), x: ox + dx, y: oy + dy });
        applyState(el, ns);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Corner resize ────────────────────────────────────────────
  // Default = proportional (aspect-locked). Shift = free.

  function setupCornerResize(corner, el, page) {
    corner.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();

      if (!snapshotToDom(el, page)) return; // no-op if page invisible
      select(el);

      const sc  = getPageScale(page) || 1;
      const c   = corner.dataset.c;   // nw | ne | se | sw
      const st0 = { ...getState(el) };
      const ratio = st0.w / Math.max(1, st0.h);
      const sx  = e.clientX, sy = e.clientY;

      // Per-corner growth signs along x/y.
      const sgnX = (c === 'se' || c === 'ne') ? +1 : -1;
      const sgnY = (c === 'se' || c === 'sw') ? +1 : -1;

      const onMove = mv => {
        const dx = (mv.clientX - sx) / sc;
        const dy = (mv.clientY - sy) / sc;
        const free = mv.shiftKey;

        let w = Math.max(MIN_W, st0.w + sgnX * dx);
        let h = Math.max(MIN_H, st0.h + sgnY * dy);

        if (!free) {
          // Lock aspect ratio — pick the axis that grew more proportionally.
          const rw = w / st0.w;
          const rh = h / st0.h;
          if (rw >= rh) h = w / ratio; else w = h * ratio;
          if (h < MIN_H) { h = MIN_H; w = h * ratio; }
          if (w < MIN_W) { w = MIN_W; h = w / ratio; }
        }

        // Pin the OPPOSITE corner by adjusting x/y.
        let x = st0.x, y = st0.y;
        if (c === 'nw') { x = st0.x + (st0.w - w); y = st0.y + (st0.h - h); }
        if (c === 'ne') {                         y = st0.y + (st0.h - h); }
        if (c === 'sw') { x = st0.x + (st0.w - w);                         }
        // 'se' anchored at its top-left by definition.

        applyState(el, { x, y, w, h });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Font size helpers ────────────────────────────────────────

  function getFontSize(el) { return parseFloat(getComputedStyle(el).fontSize) || 11; }
  function setFontSize(el, sz) { el.style.fontSize = Math.min(80, Math.max(6, sz)) + 'px'; }

  // ── Toolbar ──────────────────────────────────────────────────

  function mkToolbar(el) {
    const t = document.createElement('div');
    t.className = 'be-toolbar';
    t.innerHTML = `
      <button class="be-tbtn" data-a="fs-">A−</button>
      <button class="be-tbtn" data-a="fs+">A+</button>
      <span class="be-toolbar-sep"></span>
      <button class="be-tbtn be-tbtn-del" data-a="hide" title="Скрыть">✕</button>`;
    t.addEventListener('mousedown', e => e.stopPropagation());
    t.addEventListener('click', e => {
      const btn = e.target.closest('[data-a]'); if (!btn) return;
      e.stopPropagation();
      const a = btn.dataset.a;
      if (a === 'fs-') setFontSize(el, getFontSize(el) - 1);
      if (a === 'fs+') setFontSize(el, getFontSize(el) + 1);
      if (a === 'hide') {
        const hidden = el.classList.toggle('be-hidden');
        el.dataset.beHidden = hidden ? '1' : '0';
        btn.textContent = hidden ? '👁' : '✕';
        btn.title = hidden ? 'Показать' : 'Скрыть';
      }
    });
    return t;
  }

  // ── Attach controls to one element ───────────────────────────
  // No geometry mutation here — element keeps its natural position until
  // the user actually interacts with it (lazy snapshot inside the handlers).

  function attach(el, page) {
    if (!el || el.dataset.beInit) return;
    el.dataset.beInit = '1';
    el.classList.add('be-block');

    // Attach toolbar + handles as children (positioned relative to element
    // once element becomes position:absolute on first interaction).
    // Before snapshot, element is position:static — absolute children would
    // escape to the nearest positioned ancestor (.spp-a4). That's fine:
    // they're display:none until the element is selected anyway, so they're
    // invisible during the pre-snapshot phase.
    el.appendChild(mkToolbar(el));

    ['nw','ne','se','sw'].forEach(c => {
      const h = document.createElement('div');
      h.className = 'be-h-corner';
      h.dataset.c = c;
      h.style.display = 'none';
      el.appendChild(h);
      setupCornerResize(h, el, page);
    });

    setupBodyDrag(el, page);

    // Inline text edit (only for leaf text blocks).
    if (!el.querySelector('table') && !el.querySelector('img')) {
      el.addEventListener('dblclick', e => {
        if (e.target.closest('.be-toolbar, .be-h-corner')) return;
        // Snapshot first (same reason as drag/resize).
        snapshotToDom(el, page);
        select(el);
        el.contentEditable = 'true';
        el.spellcheck = false;
        el.classList.add('be-editing');
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el); range.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      });
      el.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          el.contentEditable = 'false';
          el.classList.remove('be-editing');
          el.blur();
        }
      });
      el.addEventListener('blur', () => {
        el.contentEditable = 'false';
        el.classList.remove('be-editing');
      }, true);
    }
  }

  // ── Init one .spp-a4 page ────────────────────────────────────

  function initPage(page) {
    if (!page || page.dataset.bePageInit) return;
    page.dataset.bePageInit = '1';
    page.style.position = 'relative';

    // Explicit allowlist per page. No layout wrappers (.be-plan-grid etc.)
    // — they're containers, not editable blocks.
    const pageId = page.id || '';
    const commonSelectors = ['.be-editable-title'];
    const pageSelectors = {
      'prevCover2':    [
        '#prevCovLogo2',
        '#prevCovName2',
        '#prevCovSlogan2',
        '#prevCovFoot2',
      ],
      'prevPlanning2': [
        '#prevPlanBox2',
        '#prevObjInfo2',
        '#prevExplBox2',
        '#prevPlanFoot2',
      ],
      'prevBlueprint2':[ ],
      'prevSmr2':      [
        '#prevSmrTableWrap',
        '#prevSmrFoot2',
      ],
      'prevMat2':      [
        '#prevMatTableWrap',
        '#prevMatFoot2',
      ],
    };

    const selectors = [
      ...commonSelectors,
      ...(pageSelectors[pageId] || []),
    ];

    const targets = [];
    selectors.forEach(sel => {
      page.querySelectorAll(sel).forEach(el => targets.push(el));
    });
    const seen = new Set();
    targets
      .filter(el => { if (seen.has(el)) return false; seen.add(el); return true; })
      .forEach(el => attach(el, page));
  }

  // Re-apply inverse scale to current selection's handles on zoom change.
  function _onPageScaleChanged() {
    if (!_sel) return;
    const page = _sel.closest('.spp-a4');
    if (page) updateHandleScale(_sel, page);
  }

  // ── Public API ────────────────────────────────────────────────

  function init() {
    injectStyle();
    setupGlobalDeselect();
    document.querySelectorAll('.spp-a4').forEach(initPage);
    window.addEventListener('resize', _onPageScaleChanged);
  }

  return { init, initPage, attach };

})();

function initRightPanelEditor() {
  BlockEditor.init();
  window.BlockEditor = BlockEditor;
}

export { BlockEditor };
