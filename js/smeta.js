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

export function openPreview() {
  liveUpdate();
  document.getElementById('modalOverlay')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(initEditor, 100);
}

export function closePreview() {
  document.getElementById('modalOverlay')?.classList.remove('open');
  document.body.style.overflow = '';
}

export function closePreviewOnBg(e) {
  if (e.target === document.getElementById('modalOverlay')) closePreview();
}

// ── PDF generation ────────────────────────────────────────────────

export function buildDocPages(rows, totalVal, titleText) {
  const PER = 26; let html = '';
  for (let s = 0; s < rows.length; s += PER) {
    const chunk = rows.slice(s, s + PER), isLast = s + PER >= rows.length;
    html += `<div class="a4"><div class="pg"><div class="smeta-ttl">${titleText}</div>
      <table class="sm-t"><thead><tr>
        <th style="width:24px">№<br>п/п</th><th>Наименование</th>
        <th style="width:46px">Ед.<br>изм.</th><th style="width:52px">Кол-во</th>
        <th style="width:90px">За ед. ₽</th><th style="width:100px">Всего ₽</th>
      </tr></thead><tbody>${chunk.map((r, i) => `<tr><td>${s + i + 1}</td><td>${esc(r.name)}</td>
        <td style="text-align:center">${esc(r.unit)}</td><td style="text-align:center">${r.qty}</td>
        <td style="text-align:right">—</td><td style="text-align:right;font-weight:500">${fmt(r.total)}</td></tr>`).join('')}
      </tbody>${isLast ? `<tfoot><tr class="tot-r"><td colspan="4" style="border:1px solid #e0e0e0"></td>
        <td style="text-align:right;font-weight:700;background:#f5f5f2;border:1px solid #ccc">Итого:</td>
        <td style="text-align:right;font-weight:700;background:#f5f5f2;border:1px solid #ccc">${fmt(totalVal)}</td></tr></tfoot>` : ''}
      </table><div class="pg-foot"><div class="pfc">${cLetter()}</div><div class="pfn">${esc(cName().toUpperCase())}</div></div>
    </div></div>`;
  }
  return html;
}

export async function generatePDF() {
  const cn = cName(), cl = cLetter();
  const sl = (document.getElementById('companySlogan')?.value || 'КАЧЕСТВО ПОД КЛЮЧ').toUpperCase();
  const on = document.getElementById('objectName')?.value || '—';
  const client = document.getElementById('clientName')?.value || '—';
  const ex = document.getElementById('executorName')?.value || '—';
  const dt = fmtDate(document.getElementById('inspDate')?.value);

  // Update print-doc elements
  const cli = document.getElementById('covLogoImg'), cc = document.getElementById('covCircle');
  if (appState.logoData) { if (cli) { cli.src = appState.logoData; cli.style.display = 'block'; } if (cc) cc.style.display = 'none'; }
  else { if (cli) cli.style.display = 'none'; if (cc) { cc.style.display = 'flex'; cc.textContent = cl; } }
  ['covName', 'covSlogan', 'covFtC', 'covFtN'].forEach((id, i) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = i === 0 ? cn.toUpperCase() : i === 1 ? sl : i === 2 ? cl : cn.toUpperCase();
  });

  const pi = document.getElementById('docPlanImg'), ph = document.getElementById('docPlanPh');
  if (appState.planData) { if (pi) { pi.src = appState.planData; pi.style.display = 'block'; } if (ph) ph.style.display = 'none'; }
  else { if (pi) pi.style.display = 'none'; if (ph) ph.style.display = 'block'; }

  const doi = document.getElementById('docObjInfo');
  if (doi) doi.innerHTML = `<strong>Объект:</strong> ${esc(on)}<br><strong>Дата осмотра:</strong> ${dt}<br><strong>Заказчик:</strong> ${esc(client)}<br><strong>Исполнитель:</strong> ${esc(ex)}`;

  const rooms = getRooms(); let tf = 0, tw = 0, tp = 0;
  const docRb = document.getElementById('docRoomsBody');
  if (docRb) {
    docRb.innerHTML = '';
    rooms.forEach(r => {
      tf += parseFloat(r.floor) || 0; tw += parseFloat(r.walls) || 0; tp += parseFloat(r.perim) || 0;
      docRb.innerHTML += `<tr><td>${esc(r.name)}</td><td>${r.floor}</td><td>${r.walls}</td><td>${r.perim}</td></tr>`;
    });
  }
  ['dTotF', 'dTotW', 'dTotP'].forEach((id, i) => { const el = document.getElementById(id); if (el) el.textContent = [tf, tw, tp][i].toFixed(2); });
  ['pfC1', 'pfC2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = cl; });
  ['pfN1', 'pfN2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = cn.toUpperCase(); });

  const smrRows = collectSmrRows(), smrTot = getSmrTotal();
  const smrDp = document.getElementById('smrDocPages');
  if (smrDp) smrDp.innerHTML = smrRows.length > 0 ? buildDocPages(smrRows, smrTot, 'Смета строительно-монтажных работ') : '';

  const matRows = collectMatRows(), matTot = getMatTotal();
  const matDp = document.getElementById('matDocPages');
  if (matDp) matDp.innerHTML = matRows.length > 0 ? buildDocPages(matRows, matTot, 'Смета на строительные и отделочные материалы') : '';

  const fb = document.getElementById('finBody'); let num = 0;
  if (fb) {
    fb.innerHTML = '';
    if (smrRows.length > 0) { num++; fb.innerHTML += `<tr><td>${num}</td><td>Строительно-монтажные работы</td><td>м²</td><td>${tf.toFixed(2)}</td><td>${tf > 0 ? fmt(smrTot / tf) : '—'}</td><td>${fmt(smrTot)}</td><td></td></tr>`; }
    if (matRows.length > 0) { num++; fb.innerHTML += `<tr><td>${num}</td><td>Строительные и отделочные материалы</td><td>м²</td><td>${tf.toFixed(2)}</td><td>${tf > 0 ? fmt(matTot / tf) : '—'}</td><td>${fmt(matTot)}</td><td></td></tr>`; }
  }
  const ft = document.getElementById('finTotal'); if (ft) ft.textContent = fmt(smrTot + matTot);
  syncEditorToDoc();

  // Собираем HTML превью-страниц (.spp-a4), которые не скрыты
  // Клонируем, убираем UI-контролы редактора, сбрасываем transform (scale)
  const pageHtmlArr = [];
  document.querySelectorAll('.spp-page:not(.spp-hidden) .spp-a4').forEach(page => {
    const clone = page.cloneNode(true);
    // Remove editor UI
    clone.querySelectorAll('.be-toolbar, .be-h-corner, .be-h-rot, .be-h-rot-line, .be-margin-guide').forEach(el => el.remove());
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

// ── Preview editor (stub — replaced by BlockEditor v3) ────────────
function initEditor() { /* replaced by BlockEditor.init() */ }

export function syncEditorToDoc() {
  [['prevCovLogo', ['covLogoImg', 'covCircle']], ['prevCovName', ['covName']], ['prevCovSlogan', ['covSlogan']], ['prevCovType', ['covDtype']], ['prevCovFoot', ['covFtC', 'covFtN']]].forEach(([prevId, docIds]) => {
    const prevEl = document.getElementById(prevId); if (!prevEl) return;
    const hidden = prevEl.style.display === 'none';
    docIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = hidden ? 'none' : ''; });
  });
  const logoEl = document.getElementById('prevCovLogo');
  if (logoEl?.dataset.scale) { const sc = logoEl.dataset.scale; ['covLogoImg', 'covCircle'].forEach(id => { const el = document.getElementById(id); if (el) el.style.transform = `scale(${sc})`; }); }
  const nameEl = document.getElementById('prevCovName');
  if (nameEl?.dataset.scale) { const sc = nameEl.dataset.scale; const el = document.getElementById('covName'); if (el) el.style.transform = `scale(${sc})`; }
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
// BLOCK EDITOR v3 — Figma-style: drag body, corner resize, free rotate
// ══════════════════════════════════════════════════════════════════
//
// Controls per selected element:
//   • Body drag          → move freely inside page
//   • 4 corner handles   → proportional resize (shift = free)
//   • Rotate handle (top-center circle) → free angle drag
//   • Double-click text  → inline contentEditable
//   • Toolbar: A− A+ | 👁/✕ (hide/show) | ⌫ (delete)
//
// A4 landscape: 297mm × 210mm at 96dpi = 1122.5 × 793.7px (native)
// Preview panel scales the .spp-a4 via CSS transform: scale(panelW/1123)
// All internal coordinates are in native A4 pixels (1123×794).
// Margin guide = 20mm = 75.6px native.

const BlockEditor = (() => {

  // ── State ────────────────────────────────────────────────────
  let _sel = null;   // currently selected .be-block element
  let _pageScale = 1; // live CSS scale of the page wrapper (for pointer→page coords)

  // ── CSS ──────────────────────────────────────────────────────
  const CSS = `
    /* === .be-block wrapper === */
    .be-block {
      position: absolute;
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
      pointer-events: all !important;
    }
    .be-block.be-hidden:hover { opacity: 0.25; }

    /* === Corner resize handles === */
    .be-h-corner {
      position: absolute;
      width: 10px; height: 10px;
      background: #fff;
      border: 2px solid #4a9eff;
      border-radius: 2px;
      z-index: 10001;
      pointer-events: all;
    }
    .be-h-corner[data-c="nw"] { top: -5px; left: -5px; cursor: nw-resize; }
    .be-h-corner[data-c="ne"] { top: -5px; right: -5px; cursor: ne-resize; }
    .be-h-corner[data-c="se"] { bottom: -5px; right: -5px; cursor: se-resize; }
    .be-h-corner[data-c="sw"] { bottom: -5px; left: -5px; cursor: sw-resize; }

    /* === Rotate handle === */
    .be-h-rot {
      position: absolute;
      top: -30px; left: 50%; transform: translateX(-50%);
      width: 16px; height: 16px;
      background: #fff;
      border: 2px solid #4a9eff;
      border-radius: 50%;
      cursor: grab;
      z-index: 10001;
      pointer-events: all;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: #4a9eff; line-height: 1;
    }
    .be-h-rot::after { content: '↻'; }
    .be-h-rot:active { cursor: grabbing; }
    /* Vertical line from rotate handle to element */
    .be-h-rot-line {
      position: absolute;
      top: -22px; left: 50%;
      width: 1px; height: 18px;
      background: rgba(74,159,255,0.5);
      pointer-events: none;
      z-index: 10000;
    }

    /* === Toolbar === */
    .be-toolbar {
      display: none;
      position: absolute;
      top: -52px; left: 50%; transform: translateX(-50%);
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

    /* === A4 margin guide === */
    .be-margin-guide {
      position: absolute;
      pointer-events: none; z-index: 1;
      border: 1px dashed rgba(160,160,160,.35);
      box-sizing: border-box;
    }
  `;

  function injectStyle() {
    if (document.getElementById('be-style-v3')) return;
    const s = document.createElement('style');
    s.id = 'be-style-v3'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Helpers ──────────────────────────────────────────────────

  // Get current CSS scale of a .spp-a4 page (so we can map screen px → page px)
  function getPageScale(page) {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(page).transform);
    return matrix.m11 || 1;
  }

  // Read/write transform state stored as data attrs
  function getState(el) {
    return {
      x:   parseFloat(el.dataset.beX   || el.style.left  || '0'),
      y:   parseFloat(el.dataset.beY   || el.style.top   || '0'),
      w:   parseFloat(el.dataset.beW   || el.getBoundingClientRect().width / getPageScale(el.closest('.spp-a4')) || '200'),
      h:   parseFloat(el.dataset.beH   || el.getBoundingClientRect().height / getPageScale(el.closest('.spp-a4')) || '60'),
      rot: parseFloat(el.dataset.beRot || '0'),
    };
  }

  function applyState(el, st) {
    el.dataset.beX = st.x; el.dataset.beY = st.y;
    el.dataset.beW = st.w; el.dataset.beH = st.h;
    el.dataset.beRot = st.rot;
    el.style.left   = st.x + 'px';
    el.style.top    = st.y + 'px';
    el.style.width  = st.w + 'px';
    el.style.height = st.h + 'px';
    el.style.transform = `rotate(${st.rot}deg)`;
    el.style.transformOrigin = 'top left';
  }

  // Snapshot natural (pre-absolute) size+position from DOM
  function snapshotToDom(el, page) {
    if (el.dataset.bePosInit) return;
    el.dataset.bePosInit = '1';
    const sc = getPageScale(page);
    const pageR = page.getBoundingClientRect();
    const elR   = el.getBoundingClientRect();
    const x = (elR.left - pageR.left) / sc;
    const y = (elR.top  - pageR.top)  / sc;
    const w = elR.width  / sc;
    const h = elR.height / sc;
    // clear previous layout
    el.style.position = 'absolute';
    el.style.margin   = '0';
    el.style.inset    = '';
    // strip translate() but keep rotate/scale already set
    const cur = el.style.transform || '';
    el.style.transform = cur.replace(/translate\([^)]*\)/g, '').trim();
    applyState(el, { x, y, w, h, rot: parseFloat(el.dataset.beRot || '0') });
  }

  // ── Selection ────────────────────────────────────────────────

  function select(el) {
    if (_sel && _sel !== el) deselect(_sel);
    _sel = el;
    el.classList.add('be-selected');
    // show handles
    el.querySelectorAll('.be-h-corner, .be-h-rot, .be-h-rot-line').forEach(h => h.style.display = '');
  }

  function deselect(el) {
    if (!el) return;
    el.classList.remove('be-selected', 'be-editing');
    if (el.contentEditable === 'true') el.contentEditable = 'false';
    el.querySelectorAll('.be-h-corner, .be-h-rot, .be-h-rot-line').forEach(h => h.style.display = 'none');
    _sel = null;
  }

  function setupPageDeselect(page) {
    if (page.dataset.beDesel) return;
    page.dataset.beDesel = '1';
    page.addEventListener('mousedown', e => {
      if (!e.target.closest('.be-block') && !e.target.closest('.be-toolbar')) {
        if (_sel) deselect(_sel);
      }
    });
  }

  // ── Margin guide ─────────────────────────────────────────────
  // 20mm on A4 @96dpi = 20/25.4*96 ≈ 75.6px native
  const MARGIN_PX = 76;

  function addMarginGuide(page) {
    if (page.querySelector('.be-margin-guide')) return;
    const g = document.createElement('div');
    g.className = 'be-margin-guide';
    g.style.cssText = `top:${MARGIN_PX}px;left:${MARGIN_PX}px;right:${MARGIN_PX}px;bottom:${MARGIN_PX}px;`;
    page.prepend(g);
  }

  // ── Drag (body) ──────────────────────────────────────────────

  function setupBodyDrag(el, page) {
    el.addEventListener('mousedown', e => {
      if (e.target.closest('.be-toolbar, .be-h-corner, .be-h-rot')) return;
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      select(el);
      snapshotToDom(el, page);

      const sc = getPageScale(page);
      const st = getState(el);
      const ox = st.x, oy = st.y;
      const sx = e.clientX, sy = e.clientY;

      const onMove = mv => {
        const dx = (mv.clientX - sx) / sc;
        const dy = (mv.clientY - sy) / sc;
        const ns = { ...getState(el), x: ox + dx, y: oy + dy };
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

  function setupCornerResize(corner, el, page) {
    corner.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      snapshotToDom(el, page);

      const sc  = getPageScale(page);
      const c   = corner.dataset.c;  // nw ne se sw
      const st0 = { ...getState(el) };
      const sx  = e.clientX, sy = e.clientY;

      const onMove = mv => {
        const dx = (mv.clientX - sx) / sc;
        const dy = (mv.clientY - sy) / sc;
        let { x, y, w, h } = st0;

        if (c === 'se') { w = Math.max(40, w + dx); h = Math.max(20, h + dy); }
        if (c === 'sw') { x += dx; w = Math.max(40, w - dx); h = Math.max(20, h + dy); }
        if (c === 'ne') { y += dy; w = Math.max(40, w + dx); h = Math.max(20, h - dy); }
        if (c === 'nw') { x += dx; y += dy; w = Math.max(40, w - dx); h = Math.max(20, h - dy); }

        applyState(el, { ...getState(el), x, y, w, h });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Rotate ───────────────────────────────────────────────────

  function setupRotate(rotHandle, el, page) {
    rotHandle.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      snapshotToDom(el, page);

      const sc = getPageScale(page);
      const pageR = page.getBoundingClientRect();
      const elR   = el.getBoundingClientRect();
      // Center of element in screen coords
      const cx = (elR.left + elR.right)  / 2;
      const cy = (elR.top  + elR.bottom) / 2;

      const onMove = mv => {
        const angle = Math.atan2(mv.clientY - cy, mv.clientX - cx) * 180 / Math.PI + 90;
        applyState(el, { ...getState(el), rot: Math.round(angle * 10) / 10 });
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
      <button class="be-tbtn be-tbtn-del" data-a="hide">✕</button>`;
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

  // ── Attach all controls to one element ───────────────────────

  function attach(el, page) {
    if (!el || el.dataset.beInit) return;
    el.dataset.beInit = '1';
    el.classList.add('be-block');

    // Toolbar
    el.appendChild(mkToolbar(el));

    // Corner resize handles
    ['nw','ne','se','sw'].forEach(c => {
      const h = document.createElement('div');
      h.className = 'be-h-corner'; h.dataset.c = c;
      h.style.display = 'none';
      el.appendChild(h);
      setupCornerResize(h, el, page);
    });

    // Rotate handle + line
    const rotLine = document.createElement('div');
    rotLine.className = 'be-h-rot-line'; rotLine.style.display = 'none';
    el.appendChild(rotLine);

    const rotH = document.createElement('div');
    rotH.className = 'be-h-rot'; rotH.style.display = 'none';
    el.appendChild(rotH);
    setupRotate(rotH, el, page);

    // Body drag
    setupBodyDrag(el, page);

    // Click → select
    el.addEventListener('mousedown', e => {
      if (e.target.closest('.be-toolbar, .be-h-corner, .be-h-rot')) return;
      e.stopPropagation();
      select(el);
    });

    // Double-click → edit text (if no table/img)
    if (!el.querySelector('table') && !el.querySelector('img')) {
      el.addEventListener('dblclick', e => {
        if (e.target.closest('.be-toolbar, .be-h-corner, .be-h-rot')) return;
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

    addMarginGuide(page);
    setupPageDeselect(page);

    // Selectors of individually editable elements inside pages
    const editSelectors = [
      '#prevCovLogo2', '#prevCovName2', '#prevCovSlogan2', '#prevCovType2',
      '#prevObjInfo2', '#prevPlanBox2', '#prevBpAddress2',
      '.be-editable-title', '.be-plan-docs',
    ];
    editSelectors.forEach(sel => {
      page.querySelectorAll(sel).forEach(el => attach(el, page));
    });

    // Also attach direct children that are sizeable layout blocks
    Array.from(page.children).forEach(child => {
      if (child.classList.contains('be-margin-guide')) return;
      if (!child.dataset.beInit) attach(child, page);
    });
  }

  // ── Public API ────────────────────────────────────────────────

  function init() {
    injectStyle();
    document.querySelectorAll('.spp-a4').forEach(initPage);
  }

  return { init, initPage };

})();

function initRightPanelEditor() {
  BlockEditor.init();
  window.BlockEditor = BlockEditor;
}

export { BlockEditor };
