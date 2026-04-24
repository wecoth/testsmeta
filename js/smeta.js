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
  let hi = 0;
  for (let i = 0; i < Math.min(json.length, 10); i++) {
    if (json[i].filter(c => String(c || '').trim()).length >= 4) { hi = i; break; }
  }
  const h = json[hi].map(c => String(c || '').toLowerCase());
  const fi = (...kw) => { for (const k of kw) { const i = h.findIndex(x => x.includes(k)); if (i >= 0) return i; } return -1; };
  const cols = {
    name:  fi('наименование', 'работ', 'материал', 'name', 'смр', 'description'),
    unit:  fi('ед', 'unit', 'единиц'),
    qty:   fi('кол', 'qty', 'объём', 'объем', 'count'),
    price: fi('за ед', 'цена', 'price', 'стоимость за', 'rate'),
    total: fi('всего', 'итого', 'total', 'сумма', 'amount'),
  };
  const rows = [];
  for (let i = hi + 1; i < json.length; i++) {
    const row = json[i];
    const name = String(row[cols.name] || '').trim();
    if (!name || /^итого|^всего/i.test(name)) continue;
    const n = v => parseFloat(String(v || '').replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
    const qty = cols.qty >= 0 ? n(row[cols.qty]) : 0;
    const price = cols.price >= 0 ? n(row[cols.price]) : 0;
    let total = cols.total >= 0 ? n(row[cols.total]) : 0;
    if (!total && qty && price) total = qty * price;
    rows.push({ name, unit: cols.unit >= 0 ? String(row[cols.unit] || '').trim() : '', qty: qty || '', price: price || '', total: total || 0 });
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
    rows.forEach(r => addSmrRowData(r.name, r.unit, r.qty, r.price, r.total));
    recalcSmr();
  });
}

export function initSmrManual() {
  const mb = document.getElementById('smrManualBtn'); if (mb) mb.style.display = 'none';
  const wrap = document.getElementById('smrWrap'); if (wrap) wrap.style.display = 'block';
  addSmrRow();
}

export function addSmrRow() { addSmrRowData('', '', '', '', 0); recalcSmr(); }

function addSmrRowData(name, unit, qty, price, total) {
  const wrap = document.getElementById('smrBody'); if (!wrap) return;
  const idx = wrap.children.length + 1;
  const d = document.createElement('div'); d.className = 'work-row-item';
  d.innerHTML = `
    <span class="wn">${idx}</span>
    <input value="${esc(name)}" placeholder="Наименование" oninput="window._smetaModule.recalcSmr()">
    <input value="${esc(unit)}" placeholder="м2" style="text-align:center">
    <input value="${qty}" placeholder="0" style="text-align:center">
    <input value="${total || ''}" placeholder="0.00" style="text-align:right" oninput="window._smetaModule.recalcSmr()">
    <button class="btn-del-row" onclick="this.closest('.work-row-item').remove();window._smetaModule.renumRows('smrBody');window._smetaModule.recalcSmr()">×</button>`;
  wrap.appendChild(d);
}

export function recalcSmr() {
  let t = 0;
  document.querySelectorAll('#smrBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[3]?.value) || 0; });
  const el = document.getElementById('smrTotal'); if (el) el.textContent = fmt(t);
  updateSummary(); liveUpdate();
}

export function getSmrTotal() {
  let t = 0;
  document.querySelectorAll('#smrBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[3]?.value) || 0; });
  return t;
}

export function collectSmrRows() {
  return Array.from(document.querySelectorAll('#smrBody .work-row-item')).map(r => {
    const ins = r.querySelectorAll('input');
    return { name: ins[0]?.value || '', unit: ins[1]?.value || '', qty: ins[2]?.value || '', total: parseFloat(ins[3]?.value) || 0 };
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
    rows.forEach(r => addMatRowData(r.name, r.unit, r.qty, r.price, r.total));
    recalcMat();
  });
}

export function initMatManual() {
  const mb = document.getElementById('matManualBtn'); if (mb) mb.style.display = 'none';
  const wrap = document.getElementById('matWrap'); if (wrap) wrap.style.display = 'block';
  addMatRow();
}

export function addMatRow() { addMatRowData('', '', '', '', 0); recalcMat(); }

function addMatRowData(name, unit, qty, price, total) {
  const wrap = document.getElementById('matBody'); if (!wrap) return;
  const idx = wrap.children.length + 1;
  const d = document.createElement('div'); d.className = 'work-row-item';
  d.innerHTML = `
    <span class="wn">${idx}</span>
    <input value="${esc(name)}" placeholder="Материал" oninput="window._smetaModule.recalcMat()">
    <input value="${esc(unit)}" placeholder="шт" style="text-align:center">
    <input value="${qty}" placeholder="0" style="text-align:center">
    <input value="${total || ''}" placeholder="0.00" style="text-align:right" oninput="window._smetaModule.recalcMat()">
    <button class="btn-del-row" onclick="this.closest('.work-row-item').remove();window._smetaModule.renumRows('matBody');window._smetaModule.recalcMat()">×</button>`;
  wrap.appendChild(d);
}

export function recalcMat() {
  let t = 0;
  document.querySelectorAll('#matBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[3]?.value) || 0; });
  const el = document.getElementById('matTotal'); if (el) el.textContent = fmt(t);
  updateSummary(); liveUpdate();
}

export function getMatTotal() {
  let t = 0;
  document.querySelectorAll('#matBody .work-row-item').forEach(r => { t += parseFloat(r.querySelectorAll('input')[3]?.value) || 0; });
  return t;
}

export function collectMatRows() {
  return Array.from(document.querySelectorAll('#matBody .work-row-item')).map(r => {
    const ins = r.querySelectorAll('input');
    return { name: ins[0]?.value || '', unit: ins[1]?.value || '', qty: ins[2]?.value || '', total: parseFloat(ins[3]?.value) || 0 };
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

export function liveUpdate() {
  const cn = cName(), cl = cLetter();
  const sl = (document.getElementById('companySlogan')?.value || 'КАЧЕСТВО ПОД КЛЮЧ').toUpperCase();
  const on = document.getElementById('objectName')?.value || '—';
  const client = document.getElementById('clientName')?.value || '—';
  const ex = document.getElementById('executorName')?.value || '—';
  const dt = fmtDate(document.getElementById('inspDate')?.value);
  const rooms = getRooms();
  let tf = 0, tw = 0, tp = 0;
  rooms.forEach(r => { tf += parseFloat(r.floor)||0; tw += parseFloat(r.walls)||0; tp += parseFloat(r.perim)||0; });
  const smrRows = collectSmrRows(), smrTot = getSmrTotal();
  const matRows = collectMatRows(), matTot = getMatTotal();

  // Sync right panel preview
  _syncRightPanel({ cn, cl, sl, on, client, ex, dt, rooms, tf, tw, tp, smrRows, smrTot, matRows, matTot });
}

function _syncRightPanel({ cn, cl, sl, on, client, ex, dt, rooms, tf, tw, tp, smrRows, smrTot, matRows, matTot }) {
  // Cover
  const pli2 = document.getElementById('prevLogoImg2'), pc2 = document.getElementById('prevCircle2');
  if (appState.logoData) { if (pli2) { pli2.src = appState.logoData; pli2.style.display = 'block'; } if (pc2) pc2.style.display = 'none'; }
  else { if (pli2) pli2.style.display = 'none'; if (pc2) { pc2.style.display = 'flex'; pc2.textContent = cl; } }
  const pcn2 = document.getElementById('prevCovName2'); if (pcn2 && !pcn2.isContentEditable && !pcn2.dataset.userEdited) pcn2.textContent = cn.toUpperCase();
  const pcs2 = document.getElementById('prevCovSlogan2'); if (pcs2 && !pcs2.dataset.userEdited) pcs2.textContent = sl;
  const pfc2 = document.getElementById('prevFootCircle2'); if (pfc2 && !pfc2.dataset.userEdited) pfc2.textContent = cl;
  const pfn2 = document.getElementById('prevFootName2'); if (pfn2 && !pfn2.dataset.userEdited) pfn2.textContent = cn.toUpperCase();
  const pct2 = document.getElementById('prevCovType2'); // не трогаем если пользователь редактировал

  // Plan
  const ppi2 = document.getElementById('prevPlanImg2'), pph2 = document.getElementById('prevPlanPh2');
  if (appState.planData) { if (ppi2) { ppi2.src = appState.planData; ppi2.style.display = 'block'; } if (pph2) pph2.style.display = 'none'; }
  else { if (ppi2) ppi2.style.display = 'none'; if (pph2) pph2.style.display = 'block'; }
  const poi2 = document.getElementById('prevObjInfo2');
  if (poi2) poi2.innerHTML = `<strong>Объект:</strong> ${esc(on)}<br><strong>Дата осмотра:</strong> ${dt}<br><strong>Заказчик:</strong> ${esc(client)}<br><strong>Исполнитель:</strong> ${esc(ex)}`;

  // Blueprint page (Обмерный план)
  const bpImg2 = document.getElementById('prevBpImg2'), bpPh2 = document.getElementById('prevBpPh2');
  const bpImgSrc = appState.planDataFull || appState.planData || null;
  if (bpImgSrc) { if (bpImg2) { bpImg2.src = bpImgSrc; bpImg2.style.display = 'block'; } if (bpPh2) bpPh2.style.display = 'none'; }
  else { if (bpImg2) bpImg2.style.display = 'none'; if (bpPh2) bpPh2.style.display = 'flex'; }
  const bpAddr2 = document.getElementById('prevBpAddress2'); if (bpAddr2) bpAddr2.textContent = on !== '—' ? on : '';
  const bpFtC2 = document.getElementById('prevBpFtC2'); if (bpFtC2) bpFtC2.textContent = cl;
  const bpFtN2 = document.getElementById('prevBpFtN2'); if (bpFtN2) bpFtN2.textContent = cn.toUpperCase();

  // Rooms table in plan page
  const rb2 = document.getElementById('prevRoomsBody2');
  if (rb2) {
    rb2.innerHTML = '';
    rooms.forEach(r => { rb2.innerHTML += `<tr><td style="border:1px solid #e0e0e0;padding:5px 7px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${r.floor}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${r.walls}</td><td style="border:1px solid #e0e0e0;padding:5px 7px;text-align:center">${r.perim}</td></tr>`; });
  }

  // SMR
  const sb2 = document.getElementById('prevSmrBody2'), se2 = document.getElementById('prevSmrEmpty2');
  if (sb2) {
    if (smrRows.length > 0) {
      if (se2) se2.style.display = 'none';
      sb2.innerHTML = smrRows.slice(0,25).map((r, i) => `<tr><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:center;font-size:10px">${i+1}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;font-size:10px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:center;font-size:10px">${esc(r.unit)}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:center;font-size:10px">${r.qty}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:right;font-size:10px;font-weight:500">${fmt(r.total)}</td></tr>`).join('') +
        `<tr><td colspan="4" style="border:1px solid #ccc;padding:6px;text-align:right;font-weight:700;background:#f5f5f2;font-size:10px">Итого:</td><td style="border:1px solid #ccc;padding:6px;text-align:right;font-weight:700;background:#f5f5f2;font-size:11px">${fmt(smrTot)}</td></tr>`;
    } else { if (se2) se2.style.display = 'flex'; sb2.innerHTML = ''; }
  }

  // Mat
  const mb2 = document.getElementById('prevMatBody2'), me2 = document.getElementById('prevMatEmpty2');
  if (mb2) {
    if (matRows.length > 0) {
      if (me2) me2.style.display = 'none';
      mb2.innerHTML = matRows.slice(0,25).map((r, i) => `<tr><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:center;font-size:10px">${i+1}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;font-size:10px">${esc(r.name)}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:center;font-size:10px">${esc(r.unit)}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:center;font-size:10px">${r.qty}</td><td style="border:1px solid #e0e0e0;padding:5px 6px;text-align:right;font-size:10px;font-weight:500">${fmt(r.total)}</td></tr>`).join('') +
        `<tr><td colspan="4" style="border:1px solid #ccc;padding:6px;text-align:right;font-weight:700;background:#f5f5f2;font-size:10px">Итого:</td><td style="border:1px solid #ccc;padding:6px;text-align:right;font-weight:700;background:#f5f5f2;font-size:11px">${fmt(matTot)}</td></tr>`;
    } else { if (me2) me2.style.display = 'flex'; mb2.innerHTML = ''; }
  }

  // Final
  const smrV = getSmrTotal(), matV = getMatTotal();
  const pfb2 = document.getElementById('prevFinBody2'), pfv2 = document.getElementById('prevFinVal2');
  if (pfb2) {
    let rows2 = '', num2 = 0;
    if (smrV > 0) { num2++; rows2 += `<tr><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:center">${num2}</td><td style="border:1px solid #e0e0e0;padding:7px 10px">Строительно-монтажные работы</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:center">м²</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:center">${tf.toFixed(2)}</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:right">${tf>0?fmt(smrV/tf):'—'}</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:right;font-weight:600">${fmt(smrV)}</td><td style="border:1px solid #e0e0e0;padding:7px 10px"></td></tr>`; }
    if (matV > 0) { num2++; rows2 += `<tr><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:center">${num2}</td><td style="border:1px solid #e0e0e0;padding:7px 10px">Строительные и отделочные материалы</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:center">м²</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:center">${tf.toFixed(2)}</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:right">${tf>0?fmt(matV/tf):'—'}</td><td style="border:1px solid #e0e0e0;padding:7px 10px;text-align:right;font-weight:600">${fmt(matV)}</td><td style="border:1px solid #e0e0e0;padding:7px 10px"></td></tr>`; }
    pfb2.innerHTML = rows2;
  }
  if (pfv2) pfv2.textContent = fmt(smrV + matV);
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

  // Measure the real content width available inside .spp-body
  // (accounts for scrollbar, paddings). Fallback to clientWidth.
  const bodyRect = body.getBoundingClientRect();
  // If panel is hidden (display:none) or zero-width, defer:
  // applying scale now would lock page at minimum 0.25 forever.
  if (bodyRect.width < 50) return;

  const cs = getComputedStyle(body);
  const padL = parseFloat(cs.paddingLeft)  || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  // small horizontal margin so page doesn't kiss the panel edges
  const SIDE_MARGIN = 16;
  const availW = Math.max(100, bodyRect.width - padL - padR - SIDE_MARGIN * 2);

  const sc = Math.min(1, Math.max(0.25, availW / NATIVE_W));
  const scaledH = Math.round(NATIVE_H * sc);

  document.querySelectorAll('.spp-a4').forEach(page => {
    page.style.transform = `scale(${sc})`;
    page.style.transformOrigin = 'top center';
  });

  // .spp-page is the flex wrapper — set its height to the scaled A4 height
  // so the next page starts below, not under the scaled one.
  document.querySelectorAll('.spp-page').forEach(wrap => {
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
// BLOCK EDITOR v4 — Figma-style: drag body, corner resize, toolbar
// ══════════════════════════════════════════════════════════════════
//
// Controls per selected element:
//   • Body drag          → move freely inside page
//   • 4 corner handles   → resize (shift = free aspect, default = proportional)
//   • Double-click text  → inline contentEditable
//   • Toolbar: A− A+ | 👁/✕ (hide/show)
//
// A4 landscape: 297mm × 210mm at 96dpi = 1122.5 × 793.7px (native)
// Preview panel scales the .spp-a4 via CSS transform: scale(panelW/1123).
// transform-origin is 'top center' on .spp-a4.
// All internal coordinates are in native A4 pixels (1123×794).
//
// Key architectural fix vs v3:
// — snapshotToDom() теперь вызывается СРАЗУ в attach(), пока элемент
//   ещё в нормальном потоке (flow). Это решает «прыжок на первом клике»:
//   раньше элемент был position:absolute через CSS .be-block, без
//   left/top — из-за shrink-to-fit его ширина коллапсировала до ширины
//   контента и первый клик фиксировал неверные w/h.
// — handles и toolbar получают обратный scale (1/sc), чтобы на
//   любом зуме оставаться визуально одного экранного размера.

const BlockEditor = (() => {

  // ── Constants ────────────────────────────────────────────────
  const NATIVE_W = 1123;
  const NATIVE_H = 794;
  const MARGIN_PX = 76;       // 20mm guide
  const MIN_W = 40;
  const MIN_H = 24;

  // ── State ────────────────────────────────────────────────────
  let _sel = null;   // currently selected .be-block element

  // ── CSS ──────────────────────────────────────────────────────
  const CSS = `
    /* === .be-block wrapper ===
       Intentionally NOT position:absolute by default — snapshotToDom
       switches it to absolute once, after capturing flow geometry. */
    .be-block {
      box-sizing: border-box;
      cursor: default;
      user-select: none;
    }
    .be-block:not(.be-selected):hover::after {
      content: '';
      position: absolute; inset: -2px;
      border: 1.5px dashed rgba(74,159,255,0.4);
      border-radius: 2px;
      pointer-events: none;
    }
    .be-block.be-selected {
      outline: 2px solid #4a9eff;
      outline-offset: 1px;
    }
    .be-block.be-editing {
      outline: 2px solid #2171e0;
    }
    .be-block.be-hidden {
      opacity: 0.08;
      pointer-events: all;
    }
    .be-block.be-hidden:hover { opacity: 0.25; }

    /* === Corner resize handles ===
       Positioned in block-local coords (scaled with the page).
       Inverse-scaled via inline style so their ON-SCREEN size stays 10px. */
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

    /* === Toolbar ===
       Anchored above the block. Inverse-scaled so it stays readable
       regardless of page zoom. */
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
    if (document.getElementById('be-style-v4')) return;
    // Remove old v3 style if present (hot-reload safety)
    document.getElementById('be-style-v3')?.remove();
    const s = document.createElement('style');
    s.id = 'be-style-v4'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Helpers ──────────────────────────────────────────────────

  // Live CSS scale of the .spp-a4 page wrapper (screen px ↔ native page px).
  function getPageScale(page) {
    if (!page) return 1;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(page).transform);
    return matrix.m11 || 1;
  }

  // Read transform state from data attrs (set by snapshotToDom / applyState).
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
  }

  // Snapshot natural (pre-absolute) size+position from DOM.
  // Called ONCE per element, ideally in attach() while element is still in flow.
  // After this the element is position:absolute with frozen left/top/width/height
  // in native page coordinates.
  function snapshotToDom(el, page) {
    if (el.dataset.bePosInit) return;

    const sc = getPageScale(page);
    // Measure BEFORE any style mutation — element is in its natural flow/inline-style place.
    const pageR = page.getBoundingClientRect();
    const elR   = el.getBoundingClientRect();

    // pageR and elR are both post-transform (screen) rects, so dividing by sc
    // converts the delta back to native-page pixels. transform-origin of the
    // page doesn't matter here: both points share the same transform, so the
    // delta is preserved under scale around any origin.
    const x = (elR.left - pageR.left) / sc;
    const y = (elR.top  - pageR.top)  / sc;
    const w = elR.width  / sc;
    const h = elR.height / sc;

    // Now freeze geometry in absolute coordinates.
    el.style.position   = 'absolute';
    el.style.margin     = '0';
    el.style.inset      = '';
    el.style.flexShrink = '0';   // protect against flex parent squeezing
    // Strip any translate() on inline style (used for centering via left:50%; translate(-50%)).
    // We keep geometry purely via left/top/width/height now.
    const cur = el.style.transform || '';
    const cleaned = cur.replace(/translate[XY]?\([^)]*\)/g, '').trim();
    el.style.transform = cleaned || '';

    applyState(el, { x, y, w, h });
    el.dataset.bePosInit = '1';
  }

  // Update inverse-scale on handles/toolbar so they keep screen size constant.
  function updateHandleScale(el, page) {
    const sc = getPageScale(page);
    const inv = sc ? (1 / sc) : 1;
    el.querySelectorAll('.be-h-corner').forEach(h => {
      // Keep corner-specific transform-origin via CSS, just apply inverse scale here.
      h.style.transform = `scale(${inv})`;
    });
    const tb = el.querySelector(':scope > .be-toolbar');
    if (tb) {
      tb.style.transform = `translateX(-50%) scale(${inv})`;
    }
  }

  // Clamp block within page bounds (soft: only position, not size).
  function clampIntoPage(st) {
    const maxX = NATIVE_W - Math.min(st.w, NATIVE_W);
    const maxY = NATIVE_H - Math.min(st.h, NATIVE_H);
    return {
      x: Math.max(0, Math.min(maxX, st.x)),
      y: Math.max(0, Math.min(maxY, st.y)),
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
      page.style.overflow = 'visible'; // let handles/toolbar peek outside
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

  // Deselect on clicks outside any block (page bg, panel bg).
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
      // Clicks on a nested be-block belong to that nested block.
      const innerBlock = e.target.closest('.be-block');
      if (innerBlock && innerBlock !== el) return;

      e.preventDefault();
      e.stopPropagation();
      select(el);

      const sc = getPageScale(page);
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
  // Default: proportional (aspect-locked) resize along the drag diagonal.
  // Shift held: free resize (independent w/h).

  function setupCornerResize(corner, el, page) {
    corner.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      select(el);

      const sc  = getPageScale(page);
      const c   = corner.dataset.c;   // nw | ne | se | sw
      const st0 = { ...getState(el) };
      const ratio = st0.w / st0.h;    // aspect ratio
      const sx  = e.clientX, sy = e.clientY;

      // Diagonal sign relative to the moving corner:
      //   se:  +x/+y both grow,
      //   nw:  -x/-y both grow,
      //   ne:  +x/-y,
      //   sw:  -x/+y.
      const sgnX = (c === 'se' || c === 'ne') ? +1 : -1;
      const sgnY = (c === 'se' || c === 'sw') ? +1 : -1;

      const onMove = mv => {
        const dx = (mv.clientX - sx) / sc;
        const dy = (mv.clientY - sy) / sc;
        const free = mv.shiftKey;

        // Candidate new width/height driven by this corner's signs.
        let w = st0.w + sgnX * dx;
        let h = st0.h + sgnY * dy;
        w = Math.max(MIN_W, w);
        h = Math.max(MIN_H, h);

        if (!free) {
          // Proportional: use the axis that grew MORE (relative to original),
          // so diagonal drag feels natural.
          const rw = w / st0.w;
          const rh = h / st0.h;
          if (rw >= rh) { h = w / ratio; } else { w = h * ratio; }
          // Re-clamp after aspect coupling
          if (h < MIN_H) { h = MIN_H; w = h * ratio; }
          if (w < MIN_W) { w = MIN_W; h = w / ratio; }
        }

        // Compute new top-left so the OPPOSITE corner stays pinned.
        let x = st0.x, y = st0.y;
        if (c === 'nw') { x = st0.x + (st0.w - w); y = st0.y + (st0.h - h); }
        if (c === 'ne') {                         y = st0.y + (st0.h - h); }
        if (c === 'sw') { x = st0.x + (st0.w - w);                         }
        // 'se' keeps st0.x / st0.y.

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

  function attach(el, page) {
    if (!el || el.dataset.beInit) return;
    el.dataset.beInit = '1';
    el.classList.add('be-block');

    // Freeze flow geometry into absolute coords IMMEDIATELY.
    // This is the key fix: we capture real width/height while the element
    // is still laid out by its parent, BEFORE any handle/toolbar chrome
    // gets added (they'd distort measurements).
    snapshotToDom(el, page);

    // Toolbar (must be child so it's positioned relative to block).
    el.appendChild(mkToolbar(el));

    // Corner resize handles.
    ['nw','ne','se','sw'].forEach(c => {
      const h = document.createElement('div');
      h.className = 'be-h-corner';
      h.dataset.c = c;
      h.style.display = 'none';
      el.appendChild(h);
      setupCornerResize(h, el, page);
    });

    // Body drag — attached to element mousedown; the handler itself
    // filters out clicks on handles/toolbar/nested blocks.
    setupBodyDrag(el, page);

    // Double-click to edit text (skip if block contains table or img).
    if (!el.querySelector('table') && !el.querySelector('img')) {
      el.addEventListener('dblclick', e => {
        if (e.target.closest('.be-toolbar, .be-h-corner')) return;
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

    // Explicit allowlist per page. NEVER pick up layout wrappers
    // (.be-plan-grid, .be-plan-left, …) — they're containers, not blocks.
    const pageId = page.id || '';
    const commonSelectors = ['.be-editable-title'];
    const pageSelectors = {
      'prevCover2':    ['#prevCovType2', '#prevCovLogo2', '#prevCovName2', '#prevCovSlogan2'],
      'prevPlanning2': ['#prevPlanBox2', '#prevObjInfo2', '.be-plan-docs', '#prevExplBox2'],
      'prevBlueprint2':['#prevBpAddress2'],
      'prevSmr2':      [],
      'prevMat2':      [],
      'prevFinal2':    [],
    };

    const selectors = [
      ...commonSelectors,
      ...(pageSelectors[pageId] || []),
    ];

    // Collect first, attach second — avoids re-measuring elements whose
    // earlier siblings have already been absolute-ified.
    //
    // IMPORTANT ORDERING:
    // We attach elements in DOM order. When an earlier sibling becomes
    // position:absolute, it leaves the flex flow and later siblings shift.
    // That's fine: each later sibling is still measured in its OWN natural
    // flow position at the moment of its own snapshot. The block that
    // already snapshotted is anchored by explicit left/top and won't move.
    const targets = [];
    selectors.forEach(sel => {
      page.querySelectorAll(sel).forEach(el => targets.push(el));
    });
    // Dedupe (different selectors may match the same element).
    const seen = new Set();
    targets
      .filter(el => { if (seen.has(el)) return false; seen.add(el); return true; })
      .forEach(el => attach(el, page));
  }

  // Re-apply inverse scale to selected block's handles/toolbar on zoom.
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
    // Keep handle scale correct when panel resizes (setA4Scale rAFs often).
    window.addEventListener('resize', _onPageScaleChanged);
  }

  return { init, initPage, attach };

})();

function initRightPanelEditor() {
  BlockEditor.init();
  window.BlockEditor = BlockEditor;
}

export { BlockEditor };
