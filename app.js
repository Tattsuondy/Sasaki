/*
 * 家計簿（画面）
 * このファイルにはデータ・URL・キーを書きません。
 * 接続先とキーは、GASが発行する登録リンクを開いたときに、このiPhoneの中だけに保存されます。
 */
(() => {
  'use strict';

  const CFG_KEY = 'kakeibo.cfg';
  const PREF_KEY = 'kakeibo.pref';
  const $ = (s) => document.querySelector(s);
  const yen = (n) => Number(n || 0).toLocaleString('ja-JP') + '円';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(cls, text, onClick) { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick); return b; }

  /* ---------- 接続設定（登録リンク） ---------- */
  function readSetupFromHash(text) {
    const m = /#setup=([A-Za-z0-9_\-=]+)/.exec(text === undefined ? location.hash : text);
    if (!m) return null;
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const o = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(o.u) || typeof o.k !== 'string') return null;
      return { u: o.u, k: o.k, n: o.n || '' };
    } catch (e) { return null; }
  }
  let cfg = store.get(CFG_KEY, null);
  const fromHash = readSetupFromHash();
  if (fromHash) { cfg = fromHash; store.set(CFG_KEY, cfg); }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  /* ---------- API ---------- */
  // 画面を開いたときに待たないよう、読み込んだ内容をこの画面を開いている間だけ覚えておく。
  // 端末（localStorage など）には保存しない。アプリを閉じると消える。
  const MEM = {};
  const MEM_AT = {};           // 読み込んだ時刻。30秒以内なら読み直さない
  const FRESH_MS = 30000;
  const READS = ['init', 'getMonth', 'getFixed', 'getSchedule', 'getManage', 'listMasters', 'getMaster', 'bundle'];
  let busyN = 0;
  let writeSeq = 0;            // 書き込みの回数。読み込み中に書き込みがあったら、その読み込み結果は古いので使わない
  function busy(d) {
    busyN = Math.max(0, busyN + d);
    const b = $('#busy'); if (b) b.classList.toggle('on', busyN > 0);
  }
  const TIMES = [];             // 最近の通信にかかった時間（「この端末」に表示。遅いときの原因調べ用）
  async function api(action, ...args) {
    busy(1);
    const t0 = performance.now();
    try { return await apiRaw(action, args); }
    finally {
      busy(-1);
      TIMES.unshift({ a: action, ms: Math.round(performance.now() - t0), at: new Date().toLocaleTimeString('ja-JP') });
      TIMES.length = Math.min(TIMES.length, 10);
    }
  }
  async function apiRaw(action, args) {
    if (READS.indexOf(action) < 0) {
      writeSeq++;
      // 書き込んだら覚えていた内容は古くなるので捨てて、あとで読み直す
      Object.keys(MEM).forEach((k) => delete MEM[k]);
      clearTimeout(apiRaw.t); apiRaw.t = setTimeout(prefetch, 1500);
    }
    const res = await fetch(cfg.u, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: cfg.k, action: action, args: args })
    });
    const j = await res.json();
    if (!j.ok) {
      if (j.auth === false) { showSetup('この端末の登録が無効になっています。新しい登録リンクを開いてください。'); }
      throw new Error(j.error || 'エラーが発生しました');
    }
    if (READS.indexOf(action) >= 0 && action !== 'bundle') { MEM[action + '|' + JSON.stringify(args)] = j.data; MEM_AT[action + '|' + JSON.stringify(args)] = Date.now(); }
    return j.data;
  }

  /** 覚えている内容があればすぐ表示し、裏で最新を取りにいく。中身が変わっていたら描き直す */
  async function load(action, args, render, viewId) {
    const k = action + '|' + JSON.stringify(args);
    const had = MEM[k];
    if (had) render(had);
    if (had && Date.now() - (MEM_AT[k] || 0) < FRESH_MS) return;
    const seq = writeSeq;
    try {
      const d = await api(action, ...args);
      if (seq !== writeSeq) return;   // 途中で保存した。保存の結果のほうが新しい
      if (had && JSON.stringify(had) === JSON.stringify(d)) return;
      const v = viewId && document.getElementById(viewId);
      if (had && v && v.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;   // 入力中は邪魔しない
      render(d);
    } catch (e) { if (!had) fail(e); }
  }

  /** 起動後に、ほかの画面の内容をまとめて1回で読んでおく */
  async function prefetch() {
    if (!cfg || !curMonth) return;
    try {
      const d = await api('bundle', curMonth);
      MEM['getMonth|' + JSON.stringify([curMonth])] = d.month;
      MEM['getFixed|' + JSON.stringify([curMonth])] = d.fixed;
      MEM['getSchedule|[]'] = d.schedule;
      MEM['getManage|[]'] = d.manage;
      MEM['listMasters|[]'] = d.masters;
      MEM['getMaster|' + JSON.stringify(['fixed'])] = d.master;
      const now = Date.now();
      ['getMonth|' + JSON.stringify([curMonth]), 'getFixed|' + JSON.stringify([curMonth]), 'getSchedule|[]', 'getManage|[]']
        .forEach((k) => { MEM_AT[k] = now; });
    } catch (e) { /* 各画面を開いたときに読む */ }
  }

  /* ---------- トースト ---------- */
  let toastTimer = null;
  function toast(msg, actionText, action) {
    const t = $('#toast'); clear(t);
    t.appendChild(el('span', '', msg));
    if (actionText) t.appendChild(btn('', actionText, () => { t.classList.remove('show'); action(); }));
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), actionText ? 5000 : 2200);
  }
  const fail = (e) => toast(e && e.message ? e.message : String(e));

  /* ---------- 画面切り替え ---------- */
  const VIEWS = ['input', 'sum', 'plan', 'fixed', 'manage'];
  let INIT = null;
  let curMonth = null;
  function show(view) {
    VIEWS.forEach((v) => {
      $('#v-' + v).classList.toggle('hidden', v !== view);
      $('#t-' + v).classList.toggle('on', v === view);
    });
    if (view === 'sum') loadMonth(curMonth);
    if (view === 'plan') loadPlan();
    if (view === 'fixed') loadFixed(curMonth);
    if (view === 'manage') loadManage();
    window.scrollTo(0, 0);
  }
  VIEWS.forEach((v) => $('#t-' + v).addEventListener('click', () => show(v)));

  function showSetup(msg) {
    $('#app').classList.add('hidden');
    $('#setup').classList.remove('hidden');
    if (msg) $('#setup-msg').textContent = msg;
  }
  $('#setup-go').addEventListener('click', () => {
    const c = readSetupFromHash($('#setup-link').value.trim());
    if (!c) { $('#setup-msg').textContent = 'リンクの形が正しくありません。ログに出たリンクを、最初から最後まで貼り付けてください。'; return; }
    cfg = c; store.set(CFG_KEY, cfg);
    $('#setup-link').value = '';
    $('#setup').classList.add('hidden');
    boot();
  });

  /* ================= 入力 ================= */
  const pref = store.get(PREF_KEY, { methodByCat: {} });
  const st = { amount: '', cat: null, method: null, memo: '', date: null };

  function dateOffset(n) {
    const d = new Date(); d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function renderDates() {
    const box = clear($('#dates'));
    [['今日', 0], ['昨日', 1], ['おととい', 2]].forEach(([t, n]) => {
      const v = dateOffset(n);
      box.appendChild(btn(st.date === v ? 'on' : '', t, () => { st.date = v; renderDates(); }));
    });
    const other = [0, 1, 2].every((n) => dateOffset(n) !== st.date);
    const lab = el('label', other ? 'on' : '', other ? st.date.slice(5).replace('-', '/') : '📅 日付');
    const inp = el('input'); inp.type = 'date'; inp.value = st.date;
    inp.addEventListener('change', () => { if (inp.value) { st.date = inp.value; renderDates(); } });
    lab.appendChild(inp);
    box.appendChild(lab);
  }
  function renderAmount() {
    const n = $('#amount');
    n.textContent = st.amount ? Number(st.amount).toLocaleString('ja-JP') : '0';
    n.classList.toggle('zero', !st.amount);
  }
  function renderKeypad() {
    const box = clear($('#keypad'));
    ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'].forEach((k) => {
      box.appendChild(btn('', k, () => {
        if (k === '⌫') st.amount = st.amount.slice(0, -1);
        else if (st.amount.length < 8) st.amount = (st.amount + k).replace(/^0+/, '');
        renderAmount();
      }));
    });
  }
  function renderFreq() {
    const box = clear($('#freq'));
    const list = (INIT.frequent || []);
    $('#freq-card').classList.toggle('hidden', !list.length);
    list.forEach((f) => {
      const icon = (INIT.categories.find((c) => c.name === f.category) || {}).icon || '';
      box.appendChild(btn('chip freq', icon + ' ' + f.memo, () => {
        st.cat = f.category; st.method = f.method; st.memo = f.memo;
        $('#memo').value = f.memo; renderCats(); renderMethods(); renderMemoSuggest();
      }));
    });
  }
  function renderCats() {
    const box = clear($('#cats'));
    INIT.categories.forEach((c) => {
      const b = btn('cat' + (st.cat === c.name ? ' on' : ''), null, () => {
        st.cat = c.name;
        if (pref.methodByCat[c.name]) st.method = pref.methodByCat[c.name];
        renderCats(); renderMethods(); renderMemoSuggest();
      });
      b.appendChild(el('div', 'i', c.icon));
      b.appendChild(el('div', 't', c.name));
      box.appendChild(b);
    });
  }
  function renderMethods() {
    const box = clear($('#methods'));
    if (!st.method || INIT.methods.indexOf(st.method) < 0) st.method = INIT.methods[0];
    INIT.methods.forEach((m) => box.appendChild(btn('chip' + (st.method === m ? ' on' : ''), m, () => { st.method = m; renderMethods(); })));
  }
  function renderMemoSuggest() {
    const box = clear($('#memo-suggest'));
    const list = (st.cat && INIT.memos && INIT.memos[st.cat]) || [];
    list.slice(0, 8).forEach((m) => box.appendChild(btn('chip', m, () => { $('#memo').value = m; })));
  }
  function renderTodayStat(s) {
    if (s) INIT.todayStat = s;
    const t = INIT.todayStat || { count: 0, total: 0 };
    $('#today-stat').textContent = t.count ? '今日の入力 ' + t.count + '件・' + yen(t.total) : '今日はまだ入力がありません';
  }

  async function save() {
    const amount = Number(st.amount);
    if (!amount) return toast('金額を入れてください');
    if (!st.cat) return toast('分類を選んでください');
    const b = $('#save'); b.disabled = true; b.textContent = '登録中…';
    const payload = { amount: amount, category: st.cat, method: st.method, date: st.date, memo: $('#memo').value.trim() };
    try {
      const r = await api('addEntry', payload);
      pref.methodByCat[st.cat] = st.method; store.set(PREF_KEY, pref);
      renderTodayStat(r.todayStat);
      const label = st.cat + ' ' + yen(amount);
      st.amount = ''; st.cat = null; $('#memo').value = '';
      renderAmount(); renderCats(); renderMemoSuggest();
      toast(label + ' を登録しました', '取り消す', async () => {
        try { await api('deleteEntry', r.id, curMonth); toast('取り消しました'); refreshInit(); } catch (e) { fail(e); }
      });
    } catch (e) { fail(e); }
    finally { b.disabled = false; b.textContent = '登録する'; }
  }
  $('#save').addEventListener('click', save);

  async function refreshInit() {
    try { const d = await api('init'); INIT.frequent = d.frequent; INIT.memos = d.memos; renderFreq(); renderTodayStat(d.todayStat); }
    catch (e) { /* 次回に回す */ }
  }

  /* ================= 集計 ================= */
  function shiftMonth(ym, d) {
    const [y, m] = ym.split('-').map(Number);
    const dt = new Date(y, m - 1 + d, 1);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
  }
  const monthLabel = (ym) => Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5)) + '月';
  $('#sum-prev').addEventListener('click', () => loadMonth(shiftMonth(curMonth, -1)));
  $('#sum-next').addEventListener('click', () => loadMonth(shiftMonth(curMonth, 1)));

  async function loadMonth(ym) {
    curMonth = ym;
    $('#sum-label').textContent = monthLabel(ym);
    await load('getMonth', [ym], (d) => { if (curMonth === ym) renderMonth(d); }, 'v-sum');
  }

  function bar(name, total, budget, maxv) {
    const b = el('div', 'bar');
    const top = el('div', 'top');
    top.appendChild(el('span', '', name));
    top.appendChild(el('span', 'num', yen(total)));
    const p = el('div', 'progress'), f = el('div', 'f' + (budget && total > budget ? ' over' : ''));
    f.style.width = Math.min(100, total / (budget || maxv || 1) * 100) + '%';
    p.appendChild(f); b.appendChild(top); b.appendChild(p);
    if (budget) {
      const left = budget - total;
      b.appendChild(el('div', 'sub', '予算 ' + yen(budget) + '・' + (left >= 0 ? '残り ' + yen(left) : yen(-left) + ' オーバー')));
    }
    return b;
  }

  function renderMonth(d) {
    const o = d.overview;
    const ov = clear($('#overview'));
    ov.appendChild(el('span', 'label', 'この月に自由に使える残り'));
    ov.appendChild(el('div', 'big' + (o.left < 0 ? ' bad' : ''), yen(o.left)));
    const p = el('div', 'progress');
    const used = o.income ? Math.min(1, (o.fixed + o.variable) / o.income) : 0;
    const f = el('div', 'f' + (used > 1 ? ' over' : '')); f.style.width = (used * 100) + '%';
    const mk = el('div', 'mark'); mk.style.left = (o.dayRatio * 100) + '%';
    p.appendChild(f); p.appendChild(mk); ov.appendChild(p);
    ov.appendChild(el('p', 'note', '黒い線は月の経過。バーが線より左なら順調です。'));
    const g = el('div', 'grid2');
    [['収入（給与＋補填）', o.income], ['固定費（見込み）', o.fixed], ['変動費（立替を除く）', o.variable], ['固定費の支払い', o.fixedPaid + ' / ' + o.fixedCount + '件']]
      .forEach(([t, v]) => { const m = el('div', 'mini'); m.appendChild(el('div', 't', t)); m.appendChild(el('div', 'v', typeof v === 'number' ? yen(v) : v)); g.appendChild(m); });
    ov.appendChild(g);
    $('#tatekae').textContent = '会社立替の未精算：今月 ' + yen(d.tatekaeOpen) + '／全期間 ' + yen(d.tatekaeOpenAll);

    const bars = clear($('#bars'));
    if (!d.cats.length) bars.appendChild(el('div', 'empty', 'まだ記録がありません'));
    const maxv = Math.max(1, ...d.cats.map((c) => c.total));
    d.cats.forEach((c) => bars.appendChild(bar(c.icon + ' ' + c.name, c.total, c.budget, maxv)));

    const list = clear($('#list'));
    if (!d.entries.length) list.appendChild(el('div', 'empty', 'この月の記録はありません'));
    let lastDate = null, dayBox = null;
    const dayTotals = {};
    d.entries.forEach((r) => { if (r.category !== INIT.tatekae) dayTotals[r.date] = (dayTotals[r.date] || 0) + r.amount; });
    d.entries.forEach((r) => {
      if (r.date !== lastDate) {
        lastDate = r.date;
        const dt = new Date(r.date + 'T12:00:00');
        dayBox = el('div', 'day');
        dayBox.appendChild(el('span', '', (dt.getMonth() + 1) + '/' + dt.getDate() + '（' + '日月火水木金土'[dt.getDay()] + '）'));
        dayBox.appendChild(el('span', 'num', yen(dayTotals[r.date] || 0)));
        list.appendChild(dayBox);
      }
      list.appendChild(entryRow(r));
    });
  }

  function entryRow(r) {
    const row = el('div', 'row');
    const l = el('div', 'l');
    const icon = (INIT.categories.find((c) => c.name === r.category) || {}).icon || '';
    const t1 = el('div', 't1', icon + ' ' + r.category);
    if (r.category === INIT.tatekae) t1.appendChild(el('span', 'tag ' + (r.settle === '精算済' ? 'done' : 'open'), r.settle || '未精算'));
    l.appendChild(t1);
    l.appendChild(el('div', 't2', [r.memo, r.method, r.user].filter(Boolean).join('・')));
    const right = el('div', 'r');
    right.appendChild(el('div', 'a', yen(r.amount)));
    const acts = el('div', 'acts');
    if (r.category === INIT.tatekae) {
      acts.appendChild(btn('sbtn', r.settle === '精算済' ? '未精算に戻す' : '精算済にする', async () => {
        try { renderMonth(await api('toggleSettle', r.id, curMonth)); } catch (e) { fail(e); }
      }));
    }
    acts.appendChild(btn('sbtn', '削除', async () => {
      if (!confirm(r.category + ' ' + yen(r.amount) + ' を削除しますか？')) return;
      try { renderMonth(await api('deleteEntry', r.id, curMonth)); toast('削除しました'); } catch (e) { fail(e); }
    }));
    right.appendChild(acts);
    row.appendChild(l); row.appendChild(right);
    return row;
  }

  /* ================= 予定 ================= */
  const EV_ICON = { income: '💰', close: '✂️', debit: '💳', fixed: '🏠', annual: '🗓' };
  const LV = { '高': 'high', '中': 'mid', '低': 'low' };

  async function loadPlan() {
    await load('getSchedule', [], renderPlan, 'v-plan');
  }

  function renderPlan(d) {
    const al = clear($('#alerts'));
    if (!d.alerts.length) al.appendChild(el('div', 'empty', '気をつけることは今のところありません'));
    d.alerts.forEach((a) => {
      const box = el('div', 'alert ' + LV[a.level]);
      const t1 = el('div', 't1', a.title); t1.appendChild(el('span', 'tag ' + LV[a.level], a.level));
      box.appendChild(t1); box.appendChild(el('div', 't2', a.detail));
      al.appendChild(box);
    });

    const pj = clear($('#projections'));
    if (!d.projections.length) pj.appendChild(el('div', 'empty', '「管理 > 口座」で残高を入れると、見通しが出ます'));
    d.projections.forEach((p) => {
      const row = el('div', 'row');
      const l = el('div', 'l');
      l.appendChild(el('div', 't1', p.name));
      l.appendChild(el('div', 't2', '今 ' + yen(p.balance) + (p.minDate ? '・いちばん少ない ' + p.minDate.slice(5).replace('-', '/') : '') +
        (p.unknown ? '・請求額未入力 ' + p.unknown + '件' : '')));
      const r = el('div', 'r');
      r.appendChild(el('div', 'a' + (p.min < 0 ? ' bad' : ''), yen(p.min)));
      row.appendChild(l); row.appendChild(r); pj.appendChild(row);
    });

    const tl = clear($('#timeline'));
    let last = null;
    d.events.forEach((ev) => {
      if (ev.date !== last) {
        last = ev.date;
        const dt = new Date(ev.date + 'T12:00:00');
        tl.appendChild(el('div', 'day', ev.monthOnly ? (dt.getMonth() + 1) + '月中' : (dt.getMonth() + 1) + '/' + dt.getDate() + '（' + '日月火水木金土'[dt.getDay()] + '）'));
      }
      const row = el('div', 'row');
      row.appendChild(el('div', 'ev-icon', EV_ICON[ev.type] || '・'));
      const l = el('div', 'l');
      const t1 = el('div', 't1', ev.title);
      if (ev.paid) t1.appendChild(el('span', 'tag done', '支払済'));
      l.appendChild(t1);
      l.appendChild(el('div', 't2', [ev.account || ev.via, ev.memo].filter(Boolean).join('・')));
      row.appendChild(l);
      const r = el('div', 'r');
      if (ev.type === 'debit') {
        r.appendChild(btn('sbtn' + (ev.amount === null ? '' : ' on'), ev.amount === null ? '請求額を入れる' : yen(ev.amount), async () => {
          const v = prompt(ev.card + '（' + ev.billMonth.replace('-', '年') + '月）の請求額', ev.amount === null ? '' : ev.amount);
          if (v === null) return;
          try { renderPlan(await api('saveCardBill', ev.billMonth, ev.card, v.replace(/[^0-9]/g, ''))); } catch (e) { fail(e); }
        }));
      } else if (ev.type === 'annual' && !ev.amount) {
        r.appendChild(el('div', 't2', '金額未入力'));
      } else if (ev.amount !== null && ev.amount !== undefined) {
        r.appendChild(el('div', 'a ' + (ev.type === 'income' ? 'plus' : 'minus'), (ev.type === 'income' ? '+' : '') + yen(ev.amount)));
      }
      row.appendChild(r);
      tl.appendChild(row);
    });
  }

  /* ================= 固定費 ================= */
  $('#fx-prev').addEventListener('click', () => loadFixed(shiftMonth(curMonth, -1)));
  $('#fx-next').addEventListener('click', () => loadFixed(shiftMonth(curMonth, 1)));

  async function loadFixed(ym) {
    curMonth = ym;
    $('#fx-label').textContent = monthLabel(ym);
    await load('getFixed', [ym], (d) => { if (curMonth === ym) renderFixed(d); }, 'v-fixed');
  }

  function renderFixed(d) {
    const s = clear($('#fx-summary'));
    s.appendChild(el('span', 'label', '支払いの進み具合'));
    s.appendChild(el('div', 'big', d.paidCount + ' / ' + d.count + '件'));
    const p = el('div', 'progress'), f = el('div', 'f');
    f.style.width = (d.count ? d.paidCount / d.count * 100 : 0) + '%';
    p.appendChild(f); s.appendChild(p);
    const g = el('div', 'grid2');
    [['予定額の合計', d.planned], ['見込み（実費を反映）', d.expected]].forEach(([t, v]) => {
      const m = el('div', 'mini'); m.appendChild(el('div', 't', t)); m.appendChild(el('div', 'v', yen(v))); g.appendChild(m);
    });
    s.appendChild(g);

    const list = clear($('#fx-list'));
    d.items.forEach((it) => {
      const row = el('div', 'row');
      const l = el('div', 'l');
      const t1 = el('div', 't1', it.name);
      if (!it.inBudget) t1.appendChild(el('span', 'tag mid', '生活費の外'));
      l.appendChild(t1);
      l.appendChild(el('div', 't2', [it.day ? it.day + '日' : '', it.method, '予定 ' + yen(it.planned), it.memo].filter(Boolean).join('・')));
      const r = el('div', 'r');
      r.appendChild(btn('sbtn' + (it.actual !== null ? ' on' : ''), it.actual !== null ? '実費 ' + yen(it.actual) : '実費を入れる', async () => {
        const v = prompt(it.name + ' の実費（空欄で予定額に戻す）', it.actual !== null ? it.actual : it.planned);
        if (v === null) return;
        try { renderFixed(await api('saveFixed', d.month, it.name, v.replace(/[^0-9]/g, ''), it.paid)); } catch (e) { fail(e); }
      }));
      const acts = el('div', 'acts');
      const pb = btn('sbtn' + (it.paid ? ' on' : ''), it.paid ? '✓ 支払済' : '支払済にする', async () => {
        if (pb.disabled) return;
        // 押したらすぐ見た目を変える（通信の結果を待たない）
        const next = !it.paid;
        pb.disabled = true;
        pb.classList.toggle('on', next);
        pb.textContent = next ? '✓ 支払済' : '支払済にする';
        try {
          renderFixed(await api('saveFixed', d.month, it.name, it.actual === null ? '' : it.actual, next));
          toast(next ? '支払済にしました' : '未払いに戻しました');
        } catch (e) {
          pb.classList.toggle('on', it.paid); pb.textContent = it.paid ? '✓ 支払済' : '支払済にする'; pb.disabled = false;
          fail(e);
        }
      });
      acts.appendChild(pb);
      r.appendChild(acts);
      row.appendChild(l); row.appendChild(r);
      list.appendChild(row);
    });
  }

  /* ================= 管理 ================= */
  let mTab = 'accounts';
  let MDATA = null;
  document.querySelectorAll('#seg button').forEach((b) => b.addEventListener('click', () => {
    mTab = b.dataset.tab;
    document.querySelectorAll('#seg button').forEach((x) => x.classList.toggle('on', x === b));
    if (MDATA) renderManage(MDATA);
  }));

  async function loadManage() {
    await load('getManage', [], renderManage, 'v-manage');
  }

  const schedText = (a) => (a.every === 0 ? a.startYear + '年 ' : (a.every > 1 ? a.every + '年ごと・' : '毎年 ')) + a.months.join('・') + '月';

  function renderManage(d) {
    MDATA = d;
    const box = clear($('#m-body'));
    const card = (title) => { const c = el('div', 'card'); if (title) c.appendChild(el('span', 'label', title)); box.appendChild(c); return c; };

    if (mTab === 'accounts') {
      const c = card('口座ごとの残高（タップで更新）');
      c.appendChild(el('div', 'big', yen(d.accounts.total)));
      c.appendChild(el('p', 'note', '入力済みの口座の合計。残高を入れたあとに、その口座で払った支払いを引いています（カード払いは引き落とし日に予定画面で引きます）。'))
      const c2 = card();
      d.accounts.accounts.forEach((a) => {
        const row = el('div', 'row');
        const l = el('div', 'l');
        l.appendChild(el('div', 't1', a.name));
        l.appendChild(el('div', 't2', [a.role, a.updated ? a.updated + ' ' + a.user + ' に ' + yen(a.balance) : (a.balance === null ? '未入力' : '')].filter(Boolean).join('・')));
        if (a.spentCount) l.appendChild(el('div', 't2', 'そのあとの支払い ' + a.spentCount + '件 −' + yen(a.spent) + ' を引いた見込み'));
        if (a.noBase) l.appendChild(el('div', 't2', '※ 残高を入れた日時がないため、支払いを引いていません。ボタンから残高を入れ直してください'));
        const r = el('div', 'r');
        r.appendChild(btn('sbtn on', a.current === null ? '残高を入れる' : yen(a.current), async () => {
          const v = prompt(a.name + ' の今の残高（通帳やアプリの金額。入れると、ここから数え直します）', a.current === null ? '' : a.current);
          if (v === null || v.trim() === '') return;
          try { renderManage(await api('saveBalance', a.name, v.replace(/[^0-9-]/g, ''))); toast('更新しました'); } catch (e) { fail(e); }
        }));
        row.appendChild(l); row.appendChild(r); c2.appendChild(row);
      });
    }

    if (mTab === 'bonus') {
      if (!d.bonuses.length) card().appendChild(el('div', 'empty', '「ボーナス」シートに支給を入れてください'));
      d.bonuses.forEach((b) => {
        const c = card(b.name + '（' + b.date + '）');
        c.appendChild(el('div', 'big', yen(b.net)));
        const p = el('div', 'progress'), f = el('div', 'f');
        f.style.width = (b.items.length ? b.doneCount / b.items.length * 100 : 0) + '%';
        p.appendChild(f); c.appendChild(p);
        c.appendChild(el('p', 'note', '実行済 ' + b.doneCount + ' / ' + b.items.length + '件・配分 ' + yen(b.allocated) +
          (b.left !== 0 ? '・' + (b.left > 0 ? '未配分 ' + yen(b.left) : yen(-b.left) + ' 配分しすぎ') : '・ぴったり')));
        b.items.forEach((it) => {
          const row = el('div', 'row');
          const l = el('div', 'l');
          l.appendChild(el('div', 't1', it.item));
          l.appendChild(el('div', 't2', ['→ ' + it.dest, it.memo].filter(Boolean).join('・')));
          const r = el('div', 'r');
          r.appendChild(btn('sbtn', yen(it.amount), async () => {
            const v = prompt(it.item + ' の金額', it.amount);
            if (v === null) return;
            try { renderManage(await api('saveBonusAmount', b.name, it.item, v.replace(/[^0-9]/g, ''))); } catch (e) { fail(e); }
          }));
          const acts = el('div', 'acts');
          acts.appendChild(btn('sbtn' + (it.done ? ' on' : ''), it.done ? '✓ 移した' : '移したらタップ', async () => {
            try { renderManage(await api('toggleBonusDone', b.name, it.item)); } catch (e) { fail(e); }
          }));
          r.appendChild(acts);
          row.appendChild(l); row.appendChild(r); c.appendChild(row);
        });
      });
    }

    if (mTab === 'annual') {
      const c = card('年をまたぐ支払い');
      c.appendChild(el('div', 'big', yen(d.annual.monthlyReserve) + ' / 月'));
      c.appendChild(el('p', 'note', '「積み立て対象」の支払いを月にならした額。冬の賞与で取り分ける特別費の目安です。'));
      const c2 = card();
      d.annual.items.forEach((a) => {
        const row = el('div', 'row');
        const l = el('div', 'l');
        const t1 = el('div', 't1', a.name);
        if (!a.reserve) t1.appendChild(el('span', 'tag mid', '積み立て外'));
        l.appendChild(t1);
        l.appendChild(el('div', 't2', [schedText(a), a.from, a.next ? '次回 ' + a.next.ym.replace('-', '年') + '月' : '予定なし', a.memo].filter(Boolean).join('・')));
        const r = el('div', 'r');
        r.appendChild(el('div', 'a', a.amount ? yen(a.amount) : '金額未入力'));
        if (a.next) {
          const acts = el('div', 'acts');
          acts.appendChild(btn('sbtn' + (a.next.paid ? ' on' : ''), a.next.paid ? '✓ 支払済' : '支払済にする', async () => {
            let actual = a.next.actual;
            if (!a.next.paid) {
              const v = prompt(a.name + '（' + a.next.ym + '）の実費', a.next.actual !== null ? a.next.actual : a.amount);
              if (v === null) return;
              actual = v.replace(/[^0-9]/g, '');
            }
            try { renderManage(await api('saveAnnual', a.next.key, actual === null ? '' : actual, !a.next.paid)); } catch (e) { fail(e); }
          }));
          r.appendChild(acts);
        }
        row.appendChild(l); row.appendChild(r); c2.appendChild(row);
      });
    }

    if (mTab === 'cards') {
      const c = card('カードの締め日・引き落とし日・有効期限');
      d.cards.forEach((k) => {
        const row = el('div', 'row');
        const l = el('div', 'l');
        l.appendChild(el('div', 't1', k.name));
        l.appendChild(el('div', 't2', [k.close ? '締め ' + (k.close === '末' ? '月末' : k.close + '日') : '', k.debitDay ? '引き落とし ' + k.debitDay + '日' : '',
          k.account, k.use, k.memo].filter(Boolean).join('・')));
        const r = el('div', 'r');
        r.appendChild(el('div', 't2', k.expiry ? '期限 ' + k.expiry : '期限未入力'));
        row.appendChild(l); row.appendChild(r); c.appendChild(row);
      });
      c.appendChild(el('p', 'note', 'カード番号は保存しません。締め日・期限の変更はスプレッドシートの「カード」シートで。'));
    }

    if (mTab === 'deadlines') {
      const c = card('期限（免許証・車検・手続きなど）');
      d.deadlines.forEach((x) => {
        const row = el('div', 'row');
        const l = el('div', 'l');
        const t1 = el('div', 't1', x.name);
        if (!x.done && x.left !== null && x.left <= x.notice) t1.appendChild(el('span', 'tag ' + (x.left <= 7 ? 'high' : 'mid'), x.left < 0 ? '過ぎています' : 'あと' + x.left + '日'));
        l.appendChild(t1);
        l.appendChild(el('div', 't2', [x.date || '期限日未入力', x.who, x.memo].filter(Boolean).join('・')));
        const r = el('div', 'r');
        r.appendChild(btn('sbtn' + (x.done ? ' on' : ''), x.done ? '✓ 対応済' : '対応済にする', async () => {
          try { renderManage(await api('toggleDeadline', x.name)); } catch (e) { fail(e); }
        }));
        row.appendChild(l); row.appendChild(r); c.appendChild(row);
      });
    }

    if (mTab === 'incomes') {
      const c = card('収入と入金日');
      d.incomes.forEach((x) => {
        const row = el('div', 'row');
        const l = el('div', 'l');
        l.appendChild(el('div', 't1', x.name));
        l.appendChild(el('div', 't2', [(x.months.length ? x.months.join('・') + '月' : '毎月') + ' ' + x.day + '日', x.account, x.memo].filter(Boolean).join('・')));
        const r = el('div', 'r');
        r.appendChild(el('div', 'a plus', x.amount ? yen(x.amount) : '月による'));
        row.appendChild(l); row.appendChild(r); c.appendChild(row);
      });
    }

    if (mTab === 'edit') {
      renderEditor(box);
    }

    if (mTab === 'device') {
      const c = card('このiPhone');
      c.appendChild(el('p', 'note', 'この端末は「' + (cfg && cfg.n ? cfg.n : '') + '」として登録されています。データはGoogleスプレッドシートにあり、この端末とGitHubには保存されません。'));
      c.appendChild(btn('sbtn', 'このiPhoneの登録を解除する', () => {
        if (!confirm('このiPhoneの登録を解除しますか？もう一度使うには登録リンクが必要です。')) return;
        store.del(CFG_KEY); location.reload();
      }));
      const t = card('通信にかかった時間（最近10回）');
      if (!TIMES.length) t.appendChild(el('div', 'empty', 'まだありません'));
      TIMES.forEach((x) => {
        const row = el('div', 'row');
        row.appendChild(el('div', 'l', x.at + '　' + x.a));
        row.appendChild(el('div', 'r', (x.ms / 1000).toFixed(1) + '秒'));
        t.appendChild(row);
      });
    }
  }

  /* ================= 表の編集 ================= */
  let MASTERS = null;          // 編集できる表の一覧
  let edKey = 'fixed';         // 選んでいる表
  let edData = null;           // 選んでいる表の中身
  let edRow = undefined;       // 編集中の行（null=新規、undefined=一覧表示）

  async function renderEditor(box) {
    if (!MASTERS) {
      box.appendChild(el('div', 'loading', '読み込み中…'));
      try { MASTERS = MEM['listMasters|[]'] || await api('listMasters'); } catch (e) { return fail(e); }
    }
    if (!edData || edData.key !== edKey) {
      try { edData = MEM['getMaster|' + JSON.stringify([edKey])] || await api('getMaster', edKey); } catch (e) { return fail(e); }
    }
    if (mTab !== 'edit') return;
    clear(box);
    const card = el('div', 'card'); box.appendChild(card);

    const head = el('div', 'ed-head');
    const sel = el('select');
    MASTERS.forEach((m) => { const o = el('option', '', m.label); o.value = m.key; if (m.key === edKey) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', () => { edKey = sel.value; edData = null; edRow = undefined; renderEditor(clear(box)); });
    head.appendChild(sel);
    if (edData.canAdd && edRow === undefined) head.appendChild(btn('ed-add', '＋ 追加', () => { edRow = null; renderEditor(clear(box)); }));
    card.appendChild(head);
    card.appendChild(el('p', 'note', edData.desc));

    if (edRow !== undefined) return renderForm(box, card);

    const list = el('div'); card.appendChild(list);
    if (!edData.rows.length) list.appendChild(el('div', 'empty', 'まだありません'));
    edData.rows.forEach((r) => {
      const row = el('div', 'row');
      const l = el('div', 'l');
      const f0 = edData.fields[0];
      l.appendChild(el('div', 't1', String(r.values[f0.name])));
      const sub = edData.fields.slice(1).filter((f) => f.type !== 'textarea' || f.name === 'text')
        .map((f) => showValue(f, r.values[f.name])).filter(Boolean).slice(0, 5).join('・');
      l.appendChild(el('div', 't2', sub));
      const right = el('div', 'r');
      right.appendChild(btn('sbtn', '編集', () => { edRow = r.row; renderEditor(clear(box)); }));
      row.appendChild(l); row.appendChild(right);
      list.appendChild(row);
    });
  }

  function showValue(f, v) {
    if (f.type === 'bool') return v ? f.label.replace(/（.*）/, '') : '';
    if (v === '' || v === null || v === undefined) return '';
    if (f.type === 'int') return f.label.replace(/（円）/, '') + ' ' + Number(v).toLocaleString('ja-JP') + (f.label.indexOf('円') >= 0 ? '円' : '');
    const text = String(v).replace(/^'/, '');
    return text.length > 40 ? text.slice(0, 40) + '…' : text;
  }

  function renderForm(box, card) {
    const isNew = edRow === null;
    const cur = isNew ? {} : (edData.rows.find((r) => r.row === edRow) || {}).values || {};
    card.appendChild(el('span', 'label', isNew ? '新しく追加' : '編集'));
    const grid = el('div', 'form-grid'); card.appendChild(grid);
    const inputs = {};
    edData.fields.forEach((f) => {
      const wrap = el('div', 'field' + (f.type === 'textarea' ? ' wide' : ''));
      let v = cur[f.name]; if (v === undefined || v === null) v = '';
      if (typeof v === 'string') v = v.replace(/^'/, '');
      if (f.type === 'bool') {
        const lab = el('label', 'check');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = isNew ? ['inBudget', 'reserve', 'enabled'].indexOf(f.name) >= 0 : v === true;
        lab.appendChild(cb); lab.appendChild(document.createTextNode(f.label));
        wrap.appendChild(lab); inputs[f.name] = () => cb.checked;
      } else {
        wrap.appendChild(el('label', '', f.label + (f.required ? '（必須）' : '')));
        let inp;
        if (f.type === 'readonly') { inp = el('div', 'ro', String(v) || '—'); inputs[f.name] = () => null; }
        else if (f.type === 'textarea') { inp = el('textarea'); inp.value = v; }
        else if (f.type === 'select') {
          inp = el('select');
          ['', ...f.options].forEach((o) => { const op = el('option', '', o || '（選ぶ）'); op.value = o; if (o === v) op.selected = true; inp.appendChild(op); });
        } else {
          inp = el('input'); inp.type = f.type === 'date' ? 'date' : 'text'; inp.value = v; inp.autocomplete = 'off';
          if (f.type === 'int' || f.type === 'day') inp.inputMode = 'numeric';
          if (f.type === 'month') inp.placeholder = '2029/08';
          if (f.type === 'months') inp.placeholder = '6,12';
          if (f.type === 'close') inp.placeholder = '5 または 末';
        }
        wrap.appendChild(inp);
        if (!inputs[f.name]) inputs[f.name] = () => inp.value;
      }
      grid.appendChild(wrap);
    });
    const err = el('div', 'err'); card.appendChild(err);
    const acts = el('div', 'form-acts'); card.appendChild(acts);
    acts.appendChild(btn('', 'キャンセル', () => { edRow = undefined; renderEditor(clear(box)); }));
    if (!isNew && edData.canDelete) {
      acts.appendChild(btn('danger', '削除', async () => {
        const name = cur[edData.fields[0].name];
        if (!confirm('「' + name + '」を削除しますか？')) return;
        try { edData = await api('deleteMaster', edKey, edRow, name); edRow = undefined; renderEditor(clear(box)); toast('削除しました'); }
        catch (e) { err.textContent = e.message; }
      }));
    }
    acts.appendChild(btn('primary', '保存', async () => {
      const values = {};
      edData.fields.forEach((f) => { values[f.name] = inputs[f.name](); });
      try { edData = await api('saveMaster', edKey, isNew ? null : edRow, values); edRow = undefined; renderEditor(clear(box)); toast('保存しました'); }
      catch (e) { err.textContent = e.message; }
    }));
  }

  /* ================= 起動 ================= */
  async function boot() {
    if (!cfg) return showSetup();
    $('#app').classList.remove('hidden');
    // 入力画面の準備と、ほかの画面の先読みを同時に始める（順番に待たない）
    const now = new Date();
    curMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const pre = prefetch();
    try {
      INIT = await api('init');
      $('#who').textContent = INIT.user;
      curMonth = INIT.month;
      st.date = INIT.today;
      renderDates(); renderAmount(); renderKeypad(); renderFreq(); renderCats(); renderMethods(); renderMemoSuggest(); renderTodayStat();
      $('#loading').classList.add('hidden');
      show('input');
      if (INIT.month !== curMonth) { curMonth = INIT.month; prefetch(); } else { pre.catch(() => {}); }
    } catch (e) {
      $('#loading').textContent = '起動できませんでした：' + (e && e.message ? e.message : e);
    }
  }
  boot();
})();
