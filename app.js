/*
 * 家計簿 v2（画面）
 * - このファイルにはデータ・URL・キーを書きません。
 * - 接続先とキーは、GASが出す登録リンクを開いたときに、この端末の中だけに保存されます。
 * - 家計のデータは、この端末の中に「暗号化して」保存し、開いた瞬間に表示します（登録解除で消えます）。
 */
(() => {
  'use strict';
  const E = window.Engine;
  const APP_VERSION = 'v3-2026-11-28g';
  const VERSION_LABEL = 'V.611280901';   // 画面の版（V.6 ＋ 月日時分）。更新するたびに書き換える

  /* ================= 小さな道具 ================= */
  const $ = (s) => document.querySelector(s);
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'style') Object.keys(v).forEach((p) => el.style.setProperty(p, v[p]));
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    kids.flat(3).forEach((c) => { if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); });
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const rid = (p) => { const a = new Uint8Array(5); crypto.getRandomValues(a); return p + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const fmtNow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const nowStr = () => fmtNow.format(new Date()).replace('T', ' ');
  const today = () => nowStr().slice(0, 10);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };

  /* ================= 表示の設定（端末ごと） ================= */
  const HOME_SECTIONS = [
    ['quick', '入力のショートカット'], ['alerts', 'お知らせ'], ['budget', '今月の予算の残り'], ['todos', 'やること'], ['assets', '資産のまとめ'], ['accounts', '口座'], ['cards', 'カード'],
    ['month', '今月の支出'], ['upcoming', '7日以内の予定'], ['fixed', '今月の固定費']
  ];
  // 入力のショートカット（ホームのいちばん上）
  const QUICK = [
    ['expense', '💸', '支出'], ['receipt', '📷', 'レシート'], ['fare', '🚃', '交通費'], ['income', '💰', '収入'], ['transfer', '⇄', '振替'], ['usd', '$', 'ドル'], ['charge', '⚡', 'チャージ払い']
  ];
  const UI_DEF = { scale: 100, theme: 'auto', accent: 'green', density: 'normal', yen: 'suffix', keypad: 'calc', start: 'home', afterSave: 'stay',
    home: HOME_SECTIONS.map((s) => s[0]), quick: QUICK.map((q) => q[0]), days: 62, mask: false, motion: true, listOrder: 'new' };
  let UI = Object.assign({}, UI_DEF, store.get('kakeibo.ui', {}));
  if (!Array.isArray(UI.home)) UI.home = UI_DEF.home.slice();
  if (!Array.isArray(UI.quick)) UI.quick = UI_DEF.quick.slice();
  // 前の版の設定を引き継ぐ：増えた項目を足す（消した項目はそのまま）
  if (!UI.homeV2) { if (UI.home.indexOf('todos') < 0) UI.home.splice(Math.min(1, UI.home.length), 0, 'todos'); UI.homeV2 = true; }
  if (!UI.homeV3) {
    if (UI.home.indexOf('quick') < 0) UI.home.unshift('quick');
    if (UI.home.indexOf('budget') < 0) { const i = UI.home.indexOf('alerts'); UI.home.splice(i >= 0 ? i + 1 : 1, 0, 'budget'); }
    UI.homeV3 = true;
  }
  store.set('kakeibo.ui', UI);
  function saveUI() { store.set('kakeibo.ui', UI); applyUI(); }
  function applyUI() {
    const r = document.documentElement;
    r.style.setProperty('--scale', String(UI.scale / 100));
    r.dataset.theme = UI.theme; r.dataset.accent = UI.accent; r.dataset.density = UI.density;
    r.dataset.motion = UI.motion ? 'on' : 'off';
  }
  applyUI();

  function yen(n, opt) {
    if (UI.mask && opt && opt.maskable) return '••••';
    const v = Math.round(Number(n) || 0);
    const s = Math.abs(v).toLocaleString('ja-JP');
    const sign = v < 0 ? '−' : (opt && opt.plus && v > 0 ? '+' : '');
    return UI.yen === 'prefix' ? sign + '¥' + s : sign + s + '円';
  }
  const md = (s) => E.md(s);
  const mdw = (s) => s ? md(s) + '（' + E.weekday(s) + '）' : '';

  /* ================= 接続設定（登録リンク） ================= */
  const CFG_KEY = 'kakeibo.cfg';
  function readSetup(text) {
    const m = /#setup=([A-Za-z0-9_\-=]+)/.exec(text === undefined ? location.hash : text);
    if (!m) return null;
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(o.u) || typeof o.k !== 'string') return null;
      return { u: o.u, k: o.k, n: o.n || '' };
    } catch (e) { return null; }
  }
  let cfg = store.get(CFG_KEY, null);
  const fromHash = readSetup();
  if (fromHash) { cfg = fromHash; store.set(CFG_KEY, cfg); }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  /* ================= 端末内の暗号化保存（IndexedDB + AES-GCM） ================= */
  const Vault = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('kakeibo-v2', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', mode);
        const req = fn(t.objectStore('kv'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    const get = (k) => tx('readonly', (s) => s.get(k));
    const set = (k, v) => tx('readwrite', (s) => s.put(v, k));
    let keyP = null;
    // 鍵は「取り出せない鍵」として端末に作る。データだけ盗まれても読めない
    const key = () => keyP || (keyP = (async () => {
      let k = await get('ck');
      if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await set('ck', k); }
      return k;
    })());
    return {
      async save(obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
        await set('state', { iv: iv, ct: ct });
      },
      async load() {
        const s = await get('state');
        if (!s) return null;
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: s.iv }, await key(), s.ct);
        return JSON.parse(new TextDecoder().decode(pt));
      },
      async wipe() { try { await tx('readwrite', (s) => s.clear()); } catch (e) { /* noop */ } keyP = null; }
    };
  })();

  /* ================= データと同期 ================= */
  const S = { rev: 0, base: null, ops: [], user: '', ver: 0, lastSync: 0, inflight: null, again: false, error: '', fails: 0, retryT: 0, flushT: 0, persistT: 0 };

  let memoData = null, memoDataVer = -1, memoModel = null, memoModelKey = '';
  function data() {
    if (memoDataVer === S.ver && memoData) return memoData;
    const d = {};
    E.TABLES.forEach((t) => { d[t] = ((S.base && S.base[t]) || []).slice(); });
    S.ops.forEach((op) => {
      const list = d[op.table];
      if (!list) return;
      const i = list.findIndex((r) => r.id === (op.t === 'del' ? op.rid : op.row.id));
      if (op.t === 'del') { if (i >= 0) list.splice(i, 1); }
      else { const row = Object.assign({}, op.row, { _pending: true }); if (i >= 0) list[i] = row; else list.push(row); }
    });
    memoData = d; memoDataVer = S.ver;
    return d;
  }
  function model() {
    const key = S.ver + '|' + nowStr().slice(0, 16);
    if (memoModel && memoModelKey === key) return memoModel;
    memoModel = E.build(data(), nowStr()); memoModelKey = key;
    return memoModel;
  }
  const rowOf = (table, id) => data()[table].find((r) => r.id === id) || null;

  function persist() {
    clearTimeout(S.persistT);
    S.persistT = setTimeout(() => {
      Vault.save({ v: 2, rev: S.rev, base: S.base, ops: S.ops, user: S.user, lastSync: S.lastSync }).catch(() => { /* 保存できない環境でも動く */ });
    }, 250);
  }

  // 同時編集の見張り：直し始めたときの版（スプレッドシートの更新日時）を一緒に送る。もう一人が先に直していたら、サーバーが上書きを止める
  function put(table, row, opt) {
    const op = { t: 'put', table: table, row: E.clean(table, row) };
    const baseRow = S.base && S.base[table] ? S.base[table].find((r) => r.id === op.row.id) : null;
    if (baseRow && baseRow._at) { op.base = baseRow._at; op.baseBy = baseRow._by || ''; }
    if (opt && opt.force) op.force = true;
    mutate(op);
  }
  function del(table, id) { mutate({ t: 'del', table: table, rid: id }); }
  function mutate(op) {
    op.id = rid('o');
    // 同じ行への、まだ送っていない変更はまとめる
    const target = (o) => o.t === 'del' ? o.rid : o.row.id;
    const same = S.ops.findIndex((o) => o.table === op.table && target(o) === target(op) && !(S.sendingIds || {})[o.id]);
    if (same >= 0) S.ops.splice(same, 1);
    S.ops.push(op);
    S.ver++;
    persist();
    setStatus();
    refresh();
    clearTimeout(S.flushT);
    S.flushT = setTimeout(flush, 300);
  }

  async function post(body, keepalive) {
    const res = await fetch(cfg.u, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ key: cfg.k }, body)), keepalive: !!keepalive });
    if (!res.ok) throw new Error('通信エラー（' + res.status + '）');
    const j = await res.json();
    if (!j.ok) {
      if (j.auth === false) { showSetup('この端末の登録が取り消されています。新しい登録リンクで登録してください。'); throw new Error('登録が無効です'); }
      throw new Error(j.error || 'エラーが発生しました');
    }
    return j;
  }

  function flush(keepalive) {
    if (!cfg) return Promise.resolve();
    if (S.inflight) { S.again = true; return S.inflight; }
    clearTimeout(S.flushT); clearTimeout(S.retryT);
    const sending = S.ops.slice(0, 150);
    S.sendingIds = {}; sending.forEach((o) => { S.sendingIds[o.id] = true; });
    S.mode = sending.length ? 'saving' : 'pulling';
    setStatus();
    S.inflight = (async () => {
      try {
        const res = await post({ action: 'sync', rev: S.forceFull ? 0 : S.rev, ops: sending }, keepalive);
        if (res.data) S.forceFull = false;
        S.user = res.user || S.user;
        S.book = res.book || null;
        S.code = res.code || '（古い版）';
        S.got = res.data ? Object.keys(res.data).map((k) => k + ':' + res.data[k].length).join(' ') : (res.same ? '変更なし' : '差分のみ');
        if (res.data) S.base = res.data;
        else if (res.applied && S.base) {
          res.applied.forEach((a) => {
            const list = S.base[a.table] || (S.base[a.table] = []);
            const i = list.findIndex((r) => r.id === a.rid);
            if (a.t === 'del') { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = a.row; else list.push(a.row);
          });
        }
        const changed = !res.same || sending.length;
        S.rev = res.rev;
        S.ops = S.ops.filter((o) => !S.sendingIds[o.id]);
        const conflicts = [];
        (res.rejected || []).forEach((r) => {
          if (r.conflict) {
            const mine = sending.find((o) => o.id === r.op);
            // 手元の写しを、もう一人が直した内容にする
            if (S.base && r.current) { const list = S.base[r.table] || (S.base[r.table] = []); const i = list.findIndex((x) => x.id === r.rid); if (i >= 0) list[i] = r.current; else list.push(r.current); }
            if (mine) conflicts.push({ r: r, mine: mine.row });
          } else toast('保存できませんでした：' + r.error, { error: true, long: true });
        });
        if (conflicts.length) setTimeout(() => resolveConflicts(conflicts), 0);
        S.lastSync = Date.now(); S.error = ''; S.fails = 0;
        if (changed) { S.ver++; persist(); refresh(true); } else persist();
      } catch (e) {
        S.error = e && e.message ? e.message : String(e);
        S.fails++;
        const wait = [2, 5, 15, 30, 60][Math.min(S.fails - 1, 4)] * 1000;
        S.retryT = setTimeout(flush, wait);
      } finally {
        S.inflight = null; S.mode = ''; S.sendingIds = {};
        setStatus();
        if (S.again) { S.again = false; setTimeout(flush, 0); }
        else if (S.ops.length && !S.error) S.flushT = setTimeout(flush, 300);
      }
    })();
    return S.inflight;
  }

  /** もう一人が先に直していた行：どちらの内容にするかを選んでもらう */
  async function resolveConflicts(list) {
    for (const c of list) {
      const sc = E.SCHEMA[c.r.table];
      const name = c.mine.name || c.mine.title || c.mine.item || c.mine.memo || (c.mine.date ? md(c.mine.date) : '') || c.r.rid;
      const diffs = sc.fields.filter((f) => !f.ro && f.type !== 'id' && String(c.mine[f.k] === undefined ? '' : c.mine[f.k]) !== String(c.r.current[f.k] === undefined ? '' : c.r.current[f.k]))
        .slice(0, 5).map((f) => (f.label || f.k).replace(/（.*?）/g, '') + '：相手「' + fmtVal(c.r.current[f.k]) + '」／自分「' + fmtVal(c.mine[f.k]) + '」').join('\n');
      const a = await ask('同じところを、' + c.r.by + 'が先に直していました', sc.label + '「' + name + '」を ' + c.r.at.slice(5, 16).replace('-', '/') + ' に' + c.r.by + 'が直しています。上書きせずに止めました。\n' + (diffs || ''),
        [{ v: 'theirs', label: c.r.by + 'の内容にする', primary: true }, { v: 'mine', label: '自分の内容で上書き', danger: true }]);
      if (a === 'mine') { put(c.r.table, Object.assign({}, c.mine), { force: true }); toast('自分の内容で上書きしました'); }
      else { S.ver++; persist(); refresh(); toast(c.r.by + 'の内容にしました'); }
    }
  }
  const fmtVal = (v) => v === true ? 'はい' : v === false ? 'いいえ' : v === '' || v === undefined || v === null ? '（空）' : String(v).slice(0, 20);

  function setStatus() {
    const el = $('#status'), tx = $('#status-text');
    if (!el) return;
    const n = S.ops.length;
    let cls = 'ok', text = '保存済み';
    if (S.mode === 'saving') { cls = 'busy'; text = '保存中…'; }
    else if (S.mode === 'pulling') { cls = 'busy'; text = '更新中…'; }
    else if (n && S.error) { cls = 'bad'; text = '未送信 ' + n + '件'; }
    else if (n) { cls = 'wait'; text = '保存待ち ' + n + '件'; }
    else if (S.error) { cls = 'bad'; text = 'オフライン'; }
    else if (S.lastSync) { text = '保存済み ' + new Date(S.lastSync).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }); }
    el.className = 'status ' + cls;
    tx.textContent = text;
  }

  /* ================= 画面の切り替え ================= */
  const TAB_TITLE = { home: 'ホーム', input: '入力', list: '履歴', analysis: '分析', plan: '予定', manage: '管理' };
  const R = { tab: UI.start === 'input' ? 'input' : 'home', stack: [], guard: null };
  // guard … 入力中・編集中の画面が登録する { dirty(), save() }

  async function leave() {
    const g = R.guard;
    if (!g || !g.dirty()) return true;
    const a = await ask(g.title || '保存していない変更があります', g.text || '移動する前に保存しますか？',
      [{ v: 'save', label: g.saveLabel || '保存する', primary: true }, { v: 'drop', label: '保存しない', danger: true }, { v: 'stay', label: '戻る' }]);
    if (a === 'save') { const ok = await g.save(); return ok !== false; }
    if (a === 'drop') { if (g.drop) g.drop(); return true; }
    return false;
  }
  async function go(tab) {
    if (!(await leave())) return;
    R.tab = tab; R.stack = []; R.guard = null;
    render(true);
    if (S.ops.length || Date.now() - S.lastSync > 30000) flush();
  }
  async function push(page, params) {
    if (!(await leave())) return;
    R.guard = null;
    R.stack.push({ page: page, params: params || {}, scroll: window.scrollY });
    render(true);
  }
  async function back() {
    if (!(await leave())) return;
    R.guard = null;
    const p = R.stack.pop();
    render(false);
    if (p) window.scrollTo(0, p.scroll || 0);
  }
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  // 管理（設定）は右上の歯車から。版の表示も歯車の下に
  $('#gear').addEventListener('click', () => go('manage'));
  $('#ver').textContent = VERSION_LABEL;

  // refresh() … 操作したときの描き直し。refresh(true) … 裏の同期による描き直し（入力中は待つ）
  let refreshQueued = false, refreshSoft = true;
  function refresh(soft) {
    if (!soft) refreshSoft = false;
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { const sf = refreshSoft; refreshQueued = false; refreshSoft = true; render(false, sf); });
  }
  document.addEventListener('focusout', () => { if (S.pendingSoft) { S.pendingSoft = false; setTimeout(() => refresh(true), 0); } });

  function render(toTop, soft) {
    if (!S.base) return;
    const cur = R.stack[R.stack.length - 1];
    // 編集中のフォームや、文字を入力している途中は、裏の更新で描き直さない
    if (soft && R.guard && R.guard.form) return;
    const ae = document.activeElement;
    if (soft && ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName) && $('#main').contains(ae)) { S.pendingSoft = true; return; }
    const main = $('#main');
    const y = window.scrollY;
    let page = cur ? PAGES[cur.page] : TABS[R.tab];
    // スプレッドシート側の初期設定がまだ（口座も分類もない）
    const d0 = data();
    if (!d0.wallets.length && !d0.categories.length && !(cur && ['display', 'sync', 'device'].indexOf(cur.page) >= 0) && R.tab !== 'manage') page = notReadyPage;
    clear(main);
    main.dataset.view = cur ? 'sub-' + cur.page : R.tab;
    const top = $('#top');
    const old = top.querySelector('.back'); if (old) old.remove();
    if (cur) top.insertBefore(h('button', { type: 'button', class: 'back', 'aria-label': '戻る', onclick: back }, '‹'), top.firstChild);
    $('#title').textContent = cur ? (cur.title || '') : TAB_TITLE[R.tab];
    try { page(main, cur ? cur.params : {}, cur); }
    catch (e) { main.appendChild(h('div', { class: 'card' }, h('p', { class: 'err' }, '表示できませんでした：' + e.message))); console.error(e); }
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === R.tab));
    $('#gear').classList.toggle('on', R.tab === 'manage');
    $('#nav').classList.remove('hidden');
    if (toTop) window.scrollTo(0, 0); else window.scrollTo(0, y);
  }
  function setTitle(t) { const cur = R.stack[R.stack.length - 1]; if (cur) cur.title = t; $('#title').textContent = t; }

  /* ================= 部品 ================= */
  let toastT = 0;
  function toast(msg, opt) {
    opt = opt || {};
    const t = $('#toast');
    clear(t);
    t.className = 'toast show' + (opt.error ? ' error' : '');
    t.appendChild(h('span', null, msg));
    if (opt.undo) t.appendChild(h('button', { type: 'button', onclick: () => { t.className = 'toast'; opt.undo(); } }, '取り消す'));
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = 'toast'; }, opt.long || opt.undo ? 6000 : 2200);
  }

  /** 選択肢つきのダイアログ。押したボタンの v を返す */
  function ask(title, text, buttons) {
    return new Promise((resolve) => {
      const layer = $('#layer');
      const close = (v) => { box.remove(); resolve(v); };
      const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'dialog' },
          h('h3', null, title), text ? h('p', null, text) : null,
          h('div', { class: 'dialog-acts' }, buttons.map((b) => h('button', { type: 'button', class: (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''), onclick: () => close(b.v) }, b.label)))));
      box.addEventListener('click', (e) => { if (e.target === box) close(buttons[buttons.length - 1].v); });
      layer.appendChild(box);
      const p = box.querySelector('.primary'); if (p) p.focus();
    });
  }
  const confirmDel = (what) => ask('削除しますか？', what, [{ v: true, label: '削除する', danger: true }, { v: false, label: 'やめる' }]);

  /** 下から出るシート。content は要素、onSave は値を検証して保存（エラーは throw） */
  function sheet(title, content, opt) {
    opt = opt || {};
    return new Promise((resolve) => {
      const layer = $('#layer');
      const err = h('p', { class: 'err' });
      let dirty = false;
      content.addEventListener('input', () => { dirty = true; });
      const close = async (v, force) => {
        if (!force && dirty && opt.onSave) {
          const a = await ask('保存していない変更があります', '閉じる前に保存しますか？', [{ v: 's', label: '保存する', primary: true }, { v: 'd', label: '保存しない', danger: true }, { v: 'k', label: '戻る' }]);
          if (a === 'k') return;
          if (a === 's') return doSave();
        }
        box.remove(); resolve(v);
      };
      const doSave = async () => {
        try { const r = await opt.onSave(); box.remove(); resolve(r === undefined ? true : r); }
        catch (e) { err.textContent = e.message; }
      };
      const acts = h('div', { class: 'sheet-acts' },
        h('button', { type: 'button', onclick: () => close(false) }, opt.cancelLabel || 'キャンセル'),
        (opt.extra || []).map((x) => h('button', { type: 'button', class: x.danger ? 'danger' : '', onclick: async () => { const r = await x.run(); if (r !== false) { box.remove(); resolve(x.v || true); } } }, x.label)),
        opt.onSave ? h('button', { type: 'button', class: 'primary', onclick: doSave }, opt.saveLabel || '保存') : null);
      const box = h('div', { class: 'modal sheet-wrap', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('h3', null, title)), content, err, acts));
      box.addEventListener('click', (e) => { if (e.target === box) close(false); });
      layer.appendChild(box);
      const f = content.querySelector('input:not([type=checkbox]),select,textarea');
      if (f && !opt.noFocus) setTimeout(() => f.focus(), 50);
    });
  }

  const card = (title, ...kids) => h('section', { class: 'card' }, title ? h('h2', { class: 'card-title' }, title) : null, kids);
  const empty = (t) => h('div', { class: 'empty' }, t);
  function row(opt) {
    return h(opt.onclick ? 'button' : 'div', { type: opt.onclick ? 'button' : null, class: 'row' + (opt.cls ? ' ' + opt.cls : '') + (opt.onclick ? ' tap' : ''), onclick: opt.onclick },
      opt.icon ? h('span', { class: 'ico' }, opt.icon) : null,
      h('span', { class: 'row-main' }, h('span', { class: 't1' }, opt.t1, opt.tag ? h('span', { class: 'tag ' + (opt.tagCls || '') }, opt.tag) : null), opt.t2 ? h('span', { class: 't2' }, opt.t2) : null),
      opt.right !== undefined ? h('span', { class: 'row-right' }, opt.right) : null,
      opt.after || null);
  }
  function amountEl(n, cls, opt) { return h('span', { class: 'amt ' + (cls || '') }, yen(n, opt)); }
  function bar(ratio, over) {
    const b = h('div', { class: 'bar' + (over ? ' over' : '') }, h('div', { class: 'fill' }));
    b.firstChild.style.setProperty('width', Math.max(0, Math.min(100, ratio * 100)) + '%');
    return b;
  }
  function seg(options, value, onChange, cls) {
    return h('div', { class: 'seg ' + (cls || ''), role: 'tablist' }, options.map((o) => {
      const v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return h('button', { type: 'button', role: 'tab', class: v === value ? 'on' : '', 'aria-selected': v === value ? 'true' : 'false', onclick: () => onChange(v) }, l);
    }));
  }
  const walletName = (id) => { const w = rowOf('wallets', id); return w ? w.name : (id ? '（削除された口座）' : ''); };
  const catOf = (id) => rowOf('categories', id);
  const levelCls = { '高': 'high', '中': 'mid', '低': 'low' };

  /* ================= ホーム ================= */
  const ALERT_GO = {
    no_opening: () => push('opening', {}),
    bill_unconfirmed: (a) => push('card', { id: a.card }),
    debit_soon: (a) => push('card', { id: a.card }),
    bill_passed: (a) => push('card', { id: a.card }),
    card_expire: (a) => push('edit', { table: 'wallets', id: a.card }),
    card_nopay: (a) => push('edit', { table: 'wallets', id: a.card }),
    plan_overdue: () => { planTab = 'outlook'; go('plan'); },
    shortfall: () => { planTab = 'outlook'; go('plan'); },
    deadline: (a) => push('edit', { table: 'deadlines', id: a.deadline }),
    todo: () => { planTab = 'todo'; go('plan'); },
    budget_over: () => { anaTab = 'budget'; go('analysis'); },
    budget_near: () => { anaTab = 'budget'; go('analysis'); }
  };
  let showAllAlerts = false;

  function homePage(main) {
    const m = model();
    const proj = E.projection(m, UI.days);
    const bal = E.balances(m);
    const cards = E.cardStatus(m);
    const sections = {
      quick() {
        const keys = UI.quick.filter((k) => QUICK.some((q) => q[0] === k));
        if (!keys.length) return null;
        const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) readReceipt(f); } });
        return h('section', { class: 'quick' }, file, keys.map((k) => {
          const q = QUICK.find((x) => x[0] === k);
          return h('button', { type: 'button', class: 'qbtn q-' + k, onclick: () => quickGo(k, file) }, h('span', { class: 'qi' }, q[1]), h('span', { class: 'ql' }, q[2]));
        }));
      },
      budget() {
        const bl = E.budgetLeft(m);
        if (!bl) return null;
        const over = bl.left < 0;
        return card('今月の予算の残り',
          h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, over ? 'オーバー' : '残り'), h('div', { class: 'big' + (over ? ' neg' : '') }, yen(Math.abs(bl.left)))),
            h('div', { class: 'r' }, h('div', { class: 'lbl' }, '1日あたり'), h('div', { class: 'v' }, over ? '—' : yen(bl.perDay)), h('div', { class: 'lbl' }, 'あと' + bl.daysLeft + '日'))),
          bar(bl.ratio, over), h('div', { class: 'sub-line' }, h('span', null, '生活費 ' + yen(bl.used) + ' ／ 予算 ' + yen(bl.budget)), h('span', null, '月の ' + Math.round(bl.dayRatio * 100) + '%')),
          h('button', { type: 'button', class: 'link', onclick: () => { anaTab = 'budget'; anaYm = ''; go('analysis'); } }, '分類ごとの残りを見る'));
      },
      alerts() {
        const list = E.alerts(m, proj);
        if (!list.length) return null;
        const shown = showAllAlerts ? list : list.slice(0, 3);
        return card(null, h('div', { class: 'alerts' }, shown.map((a) => h('button', { type: 'button', class: 'alert ' + levelCls[a.level], onclick: () => (ALERT_GO[a.type] || (() => {}))(a) },
          h('span', { class: 'lv' }, a.level), h('span', null, a.text)))),
        list.length > 3 ? h('button', { type: 'button', class: 'link', onclick: () => { showAllAlerts = !showAllAlerts; refresh(); } }, showAllAlerts ? '少なく表示' : 'ほか ' + (list.length - 3) + '件を表示') : null);
      },
      assets() {
        const total = m.accounts.reduce((s, a) => s + (bal[a.id] ? bal[a.id].balance : 0), 0);
        const owed = cards.reduce((s, c) => s + c.owed, 0);
        const missing = m.accounts.filter((a) => bal[a.id] && bal[a.id].noOpening).length;
        return card(null,
          h('div', { class: 'assets' },
            h('div', null, h('div', { class: 'lbl' }, '口座の合計'), h('div', { class: 'big' }, yen(total, { maskable: true }))),
            h('button', { type: 'button', class: 'eye', 'aria-label': '金額を隠す', onclick: () => { UI.mask = !UI.mask; saveUI(); refresh(); } }, UI.mask ? '表示' : '隠す')),
          h('div', { class: 'grid3' },
            h('div', { class: 'mini' }, h('div', { class: 'lbl' }, 'カードの未払い'), h('div', { class: 'v' }, yen(-owed, { maskable: true }))),
            h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '差し引き'), h('div', { class: 'v' }, yen(total - owed, { maskable: true }))),
            h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '立替（未精算）'), h('div', { class: 'v' }, yen(E.tatekaeOpen(m).total, { maskable: true })))),
          missing ? h('button', { type: 'button', class: 'link', onclick: () => push('opening') }, '開始残高が未入力の口座が ' + missing + ' 件あります → 入れる') : null);
      },
      accounts() {
        if (!m.accounts.length) return card('口座', empty('口座がありません'), h('button', { type: 'button', class: 'link', onclick: () => push('edit', { table: 'wallets', id: null, preset: { kind: '銀行' } }) }, '口座を追加'));
        return card('口座', m.accounts.map((a) => {
          const b = bal[a.id];
          const pj = proj.accounts.find((x) => x.id === a.id);
          return row({ icon: kindIcon(a.kind), t1: a.name, t2: b.noOpening ? '開始残高が未入力' : (pj && pj.min < b.balance ? 'いちばん少ない ' + md(pj.minDate) + ' ' + yen(pj.min, { maskable: true }) : a.role),
            right: b.noOpening ? h('span', { class: 'tag mid' }, '未入力') : amountEl(b.balance, pj && pj.min < 0 ? 'neg' : '', { maskable: true }), onclick: () => push('account', { id: a.id }) });
        }));
      },
      cards() {
        if (!cards.length) return null;
        return card('カード', cards.map((c) => row({ icon: '💳', t1: c.card.name,
          t2: c.next ? md(c.next.debitDate) + ' 引き落とし ' + (c.next.confirmed ? '（確定）' : '（見込み）') : '次の引き落としなし',
          right: c.next ? amountEl(c.next.amount, c.next.confirmed ? '' : 'est', { maskable: true }) : '', onclick: () => push('card', { id: c.card.id }) })));
      },
      month() {
        const s = E.month(m, E.ymOf(m.today));
        const over = s.budget && s.household > s.budget * s.dayRatio * 1.1;
        return card('今月の支出',
          h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '生活費'), h('div', { class: 'big' }, yen(s.household))),
            h('div', { class: 'r' }, h('div', { class: 'lbl' }, '予算'), h('div', { class: 'v' }, s.budget ? yen(s.budget) : '未設定'))),
          s.budget ? bar(s.household / s.budget, s.household > s.budget) : null,
          s.budget ? h('p', { class: 'note' + (over ? ' warn' : '') }, '月の ' + Math.round(s.dayRatio * 100) + '% が過ぎて、予算の ' + Math.round(s.household / s.budget * 100) + '% を使用') : null,
          h('div', { class: 'grid3' },
            h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '支出の合計'), h('div', { class: 'v' }, yen(s.expense))),
            h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '収入'), h('div', { class: 'v' }, yen(s.income))),
            h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '固定費'), h('div', { class: 'v' }, s.fixed.done + '/' + s.fixed.total + '件'))),
          h('button', { type: 'button', class: 'link', onclick: () => go('list') }, '入力履歴を見る'));
      },
      upcoming() {
        const end = E.addDays(m.today, 7);
        const ev = proj.events.filter((e) => e.date <= end);
        return card('7日以内の予定', ev.length ? ev.slice(0, 8).map((e) => eventRow(e, m)) : empty('7日以内の予定はありません'),
          h('button', { type: 'button', class: 'link', onclick: () => { planTab = 'outlook'; go('plan'); } }, '予定をすべて見る'));
      },
      todos() {
        const open = m.todos.filter((t) => !t.done);
        if (!open.length) return null;
        return card('やること（' + open.length + '件）', open.slice(0, 4).map((t) => todoRow(t, m)),
          h('button', { type: 'button', class: 'link', onclick: () => push('todos') }, 'やることリストを開く'));
      },
      fixed() {
        const s = E.month(m, E.ymOf(m.today));
        if (!s.fixed.total) return null;
        return card('今月の固定費', h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'big' }, s.fixed.done + ' / ' + s.fixed.total + '件')),
          h('div', { class: 'r' }, h('div', { class: 'lbl' }, '見込み'), h('div', { class: 'v' }, yen(s.fixed.expected)))), bar(s.fixed.done / s.fixed.total),
          h('button', { type: 'button', class: 'link', onclick: () => { planTab = 'fixed'; go('plan'); } }, '固定費を記録する'));
      }
    };
    UI.home.forEach((k) => { if (sections[k]) { const el = sections[k](); if (el) main.appendChild(el); } });
  }
  /** ホームのショートカットから入力を始める */
  function quickGo(k, file) {
    if (k === 'receipt') { st.type = '支出'; file.click(); return; }
    if (k === 'fare') { push('fare', {}); return; }
    if (k === 'charge') {
      // 前にチャージ払いした電子マネー（なければ最初の電子マネー）で、チャージして払うを入れておく
      const m = model(), me = S.user || (cfg && cfg.n) || '';
      const em = m.wallets.filter((w) => w.kind === '電子マネー');
      const used = Object.keys(prefs.charge).filter((x) => x.split('|')[1] === me && prefs.charge[x].on).map((x) => x.split('|')[0]);
      const w = em.find((x) => used.indexOf(x.id) >= 0) || em[0];
      if (!w) { toast('電子マネーが登録されていません（管理 > 口座・カード）', { error: true }); return; }
      st.type = '支出'; st.cur = 'JPY'; st.amount = ''; st.from = w.id; st.charge = true; st.chargeEdited = false; st.chargeFrom = ''; st._chargeFor = w.id;
      go('input'); return;
    }
    st.type = k === 'income' ? '収入' : k === 'transfer' ? '振替' : '支出';
    st.cur = k === 'usd' ? 'USD' : 'JPY';
    st.amount = ''; st.usd = ''; st.from = ''; st.to = '';
    if (k === 'usd') loadFx(false);
    go('input');
  }
  const kindIcon = (k) => ({ '銀行': '🏦', '現金': '👛', '電子マネー': '📲', 'カード': '💳' }[k] || '💼');

  function eventRow(e, m) {
    const icon = e.kind === 'debit' ? '💳' : e.kind === 'deadline' ? '📅' : e.planKind === '収入' ? '💰' : e.planKind === '年間' ? '🗓' : e.planKind === '振替' ? '⇄' : '🏠';
    const t2 = e.kind === 'deadline' ? (e.left === 0 ? '今日が期限' : 'あと' + e.left + '日') + (e.memo ? '・' + e.memo : '') :
      [e.walletName, e.viaCard ? md(e.debitDate) + 'に引き落とし' : '', e.kind === 'debit' ? (e.confirmed ? '確定' : '見込み') : '', e.overdue ? (e.planKind === '収入' ? '入金の記録がまだ' : '支払いの記録がまだ') : '', e.monthOnly ? '日にち未定' : ''].filter(Boolean).join('・');
    const right = e.amount === null ? '' : h('span', { class: 'col' }, amountEl(e.planKind === '振替' ? e.amount : e.sign * e.amount, e.planKind === '振替' ? 'mute' : e.sign > 0 ? 'pos' : e.kind === 'debit' && !e.confirmed ? 'est' : '', { plus: e.planKind !== '振替', maskable: true }),
      e.after !== undefined ? h('span', { class: 'after' + (e.after < 0 ? ' neg' : '') }, '残 ' + yen(e.after, { maskable: true })) : null);
    return row({ icon: icon, t1: (e.kind === 'deadline' ? '' : md(e.date) + ' ') + e.title, t2: t2, right: right, cls: e.overdue ? 'overdue' : '',
      onclick: e.kind === 'plan' ? () => recordPlan(e) : e.kind === 'debit' ? () => push('bill', { card: e.card, ym: e.ym }) : e.kind === 'deadline' ? () => push('edit', { table: 'deadlines', id: e.id }) : null });
  }

  /* ================= 入力 ================= */
  const st = { type: '支出', amount: '', cat: { '支出': '', '収入': '' }, from: '', to: '', date: '', memo: '', settle: false, cur: 'JPY', usd: '', fxManual: '', fxEdit: false,
    charge: false, chargeAmt: '', chargeEdited: false, chargeFrom: '' };

  // ドルのレート（GASが GOOGLEFINANCE で調べる。10分間は同じ値を使う。取れないときは前回の値か手入力）
  const FX = { usd: store.get('kakeibo.fx', null), busy: false, err: '' };
  let fxLineDraw = null;
  async function loadFx(force) {
    if (FX.busy || !cfg) return;
    if (!force && FX.usd && Date.now() - (FX.usd.got || 0) < 10 * 60 * 1000) return;
    FX.busy = true; FX.err = ''; if (fxLineDraw) fxLineDraw();
    try {
      const r = await post({ action: 'fx', cur: 'USD' });
      FX.usd = { rate: Number(r.rate), at: r.at, got: Date.now() };
      store.set('kakeibo.fx', FX.usd);
    } catch (e) { FX.err = e.message || '通信できませんでした'; }
    FX.busy = false;
    if (fxLineDraw) fxLineDraw();
  }
  const fxRate = () => Number(String(st.fxManual).replace(/[,\s円]/g, '')) > 0 ? Number(String(st.fxManual).replace(/[,\s円]/g, '')) : (FX.usd ? FX.usd.rate : 0);
  const usdText = (s2) => { const p2 = String(s2 || '').split('.'); return (p2[0] ? Number(p2[0]).toLocaleString('en-US') : '0') + (p2.length > 1 ? '.' + p2[1] : ''); };
  const mdhm = (s2) => s2 ? (+s2.slice(5, 7)) + '/' + (+s2.slice(8, 10)) + ' ' + s2.slice(11, 16) : '';
  // 前の版の設定が残っていても動くように、足りないものは補う
  const prefs = Object.assign({ walletByCat: {}, lastFrom: '', lastTo: '', lastIncomeTo: '', charge: {} }, store.get('kakeibo.pref', {}));
  if (!prefs.charge || typeof prefs.charge !== 'object') prefs.charge = {};
  if (!prefs.walletByCat || typeof prefs.walletByCat !== 'object') prefs.walletByCat = {};
  const savePrefs = () => store.set('kakeibo.pref', prefs);

  function inputDirty() { return !!st.amount || !!st.usd; }

  function inputPage(main) {
    const m = model();
    if (!st.date) st.date = m.today;
    R.guard = { dirty: inputDirty, title: '入力中の内容があります', text: '登録してから移動しますか？', saveLabel: '登録する',
      save: () => saveInput(true), drop: () => { st.amount = ''; st.usd = ''; st.memo = ''; } };

    const cats = m.categories.filter((c) => c.kind === (st.type === '収入' ? '収入' : '支出'));
    if (st.type !== '振替' && !cats.some((c) => c.id === st.cat[st.type]) && cats.length) st.cat[st.type] = cats[0].id;
    const catId = st.cat[st.type] || '';
    if (st.type === '支出' && !st.from) st.from = prefs.walletByCat[catId] || prefs.lastFrom || (m.wallets[0] && m.wallets[0].id) || '';
    if (st.type === '収入' && !st.to) st.to = prefs.lastIncomeTo || (m.accounts[0] && m.accounts[0].id) || '';
    if (st.type === '振替') { if (!st.from) st.from = (m.accounts[0] || {}).id || ''; if (!st.to) st.to = (m.accounts[1] || {}).id || ''; }

    const wrap = h('div', { class: 'input-page' });
    main.appendChild(wrap);
    wrap.appendChild(seg([['支出', '支出'], ['収入', '収入'], ['振替', '振替・チャージ']], st.type, (v) => { st.type = v; st.from = ''; st.to = ''; refresh(); }, 'type-seg ' + (st.type === '収入' ? 'is-income' : st.type === '振替' ? 'is-transfer' : '')));

    // レシートの読み取り
    if (st.type === '支出') {
      const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) readReceipt(f); } });
      wrap.appendChild(h('div', { class: 'receipt-bar' }, file,
        h('button', { type: 'button', class: 'receipt-btn', onclick: () => file.click() }, '📷 レシート'),
        h('button', { type: 'button', class: 'receipt-btn', onclick: () => push('fare', {}) }, '🚃 交通費'),
        h('span', { class: 'note' }, 'レシートは品目ごとに分類、交通費は乗換案内で運賃を調べて入力')));
    }

    // よく使う組み合わせ
    if (st.type === '支出') {
      const fq = frequent(m);
      if (fq.length) wrap.appendChild(h('div', { class: 'chips scroll' }, fq.map((f) => h('button', { type: 'button', class: 'chip', onclick: () => { st.cat['支出'] = f.cat; st.from = f.from; if (f.memo) st.memo = f.memo; refresh(); } },
        (catOf(f.cat) || {}).icon || '', ' ', (catOf(f.cat) || {}).name || '', '・', walletName(f.from), f.memo ? '・' + f.memo : ''))));
    }

    // 金額（円 か ドル）
    wrap.appendChild(seg([['JPY', '¥ 円'], ['USD', '$ ドル']], st.cur, (v) => { st.cur = v; st.amount = ''; st.usd = ''; st.fxEdit = false; if (v === 'USD') loadFx(false); refresh(); }, 'cur-seg'));
    if (st.cur === 'USD') {
      if (!FX.usd || Date.now() - (FX.usd.got || 0) > 10 * 60 * 1000) loadFx(false);
      const amt = h('div', { class: 'amount' + (st.usd ? '' : ' zero') }, h('span', { class: 'cur' }, '$'), h('span', { class: 'num' }, usdText(st.usd)));
      const line = h('div', { class: 'fx-line' });
      const draw = () => {
        clear(line);
        const r = fxRate();
        const yenV = E.fxYen(Number(st.usd), r);
        line.appendChild(h('div', { class: 'fx-yen' }, r ? '≈ ' + yen(yenV) : (FX.busy ? 'レートを調べています…' : 'レートがまだありません')));
        const info = r ? '1ドル ＝ ' + r.toLocaleString('ja-JP', { maximumFractionDigits: 4 }) + '円' + (st.fxManual ? '（手入力）' : FX.usd ? '（' + mdhm(FX.usd.at) + ' 時点' + (Date.now() - (FX.usd.got || 0) > 10 * 60 * 1000 ? '・前回取ったレート' : '') + '）' : '') : '';
        line.appendChild(h('div', { class: 'fx-info' }, info, FX.busy && r ? '　更新中…' : '', FX.err ? h('span', { class: 'neg' }, '　' + FX.err) : null));
        if (st.date && st.date !== model().today && !st.fxManual) line.appendChild(h('div', { class: 'note warn' }, '今のレートです（' + md(st.date) + ' のレートではありません）。その日のレートで記録したいときは「レートを変える」で入れてください。'));
        if (st.fxEdit) {
          const inp = h('input', { type: 'text', inputmode: 'decimal', class: 'fx-input', placeholder: '例：154.25', value: st.fxManual || (r ? String(r) : ''), 'aria-label': '1ドルの円', oninput: (e) => { st.fxManual = e.target.value; const r2 = fxRate(); line.querySelector('.fx-yen').textContent = r2 ? '≈ ' + yen(E.fxYen(Number(st.usd), r2)) : 'レートを入れてください'; } });
          line.appendChild(h('div', { class: 'fx-edit' }, h('span', null, '1ドル ＝'), inp, h('span', null, '円'),
            h('button', { type: 'button', class: 'chip', onclick: () => { st.fxEdit = false; draw(); } }, '決定')));
        }
        line.appendChild(h('div', { class: 'chips' },
          h('button', { type: 'button', class: 'chip', onclick: () => { st.fxEdit = !st.fxEdit; draw(); } }, st.fxEdit ? '閉じる' : 'レートを変える'),
          st.fxManual ? h('button', { type: 'button', class: 'chip', onclick: () => { st.fxManual = ''; st.fxEdit = false; draw(); } }, '今のレートに戻す') : null,
          h('button', { type: 'button', class: 'chip', disabled: FX.busy ? 'disabled' : null, onclick: () => { st.fxManual = ''; loadFx(true); } }, '最新のレートを取る')));
      };
      fxLineDraw = draw; draw();
      wrap.appendChild(h('div', { class: 'amount-box' }, amt, line));
      wrap.appendChild(keypad((k) => {
        let v = st.usd;
        if (k === 'del') v = v.slice(0, -1);
        else if (k === 'clr') v = '';
        else if (k === '.') { if (v.indexOf('.') < 0) v = (v || '0') + '.'; }
        else if (v.length < 10 && !(/\.\d\d$/.test(v))) v = (v === '0' ? '' : v) + k;
        if (v === '00' || v === '0') v = v === '0' ? '0' : '';
        st.usd = v;
        amt.querySelector('.num').textContent = usdText(st.usd);
        amt.classList.toggle('zero', !st.usd);
        const r = fxRate(); const y = line.querySelector('.fx-yen'); if (y && r) y.textContent = '≈ ' + yen(E.fxYen(Number(st.usd), r));
      }, true));
      const fw = m.w[st.from];
      if (st.type === '支出' && fw && E.isCard(fw)) wrap.appendChild(h('p', { class: 'note' }, 'カードの海外利用は、カード会社のレートと手数料で請求額が少し変わります。請求が確定したら、入力履歴でこの記録の「金額（円）」を直せます（ドルの金額はそのまま残ります）。'));
    } else {
      fxLineDraw = null;
      const amt = h('div', { class: 'amount' + (st.amount ? '' : ' zero') }, h('span', { class: 'cur' }, UI.yen === 'prefix' ? '¥' : ''), h('span', { class: 'num' }, st.amount ? Number(st.amount).toLocaleString('ja-JP') : '0'), h('span', { class: 'cur' }, UI.yen === 'prefix' ? '' : '円'));
      wrap.appendChild(h('div', { class: 'amount-box' }, amt));
      wrap.appendChild(keypad((k) => {
        if (k === 'del') st.amount = st.amount.slice(0, -1);
        else if (k === 'clr') st.amount = '';
        else if ((st.amount + k).length <= 9) st.amount = (st.amount === '' && (k === '0' || k === '00')) ? '' : st.amount + k;
        const n = amt.querySelector('.num');
        n.textContent = st.amount ? Number(st.amount).toLocaleString('ja-JP') : '0';
        amt.classList.toggle('zero', !st.amount);
        if (st._chargeDraw && document.querySelector('.charge-box')) st._chargeDraw();
      }));
    }

    // 日付
    const dates = [[m.today, '今日'], [E.addDays(m.today, -1), '昨日'], [E.addDays(m.today, -2), 'おととい']];
    const picker = h('input', { type: 'date', class: 'date-pick', value: st.date, max: E.addDays(m.today, 366), 'aria-label': '日付を選ぶ', onchange: (e) => { if (e.target.value) { st.date = e.target.value; refresh(); } } });
    wrap.appendChild(h('div', { class: 'chips' }, dates.map(([d, l]) => h('button', { type: 'button', class: 'chip' + (st.date === d ? ' on' : ''), onclick: () => { st.date = d; refresh(); } }, l)),
      h('label', { class: 'chip' + (dates.some(([d]) => d === st.date) ? '' : ' on') }, dates.some(([d]) => d === st.date) ? '📅 日付' : '📅 ' + mdw(st.date), picker)));

    // 分類（よく使う順。多いときは「ほか」でたたむ）
    if (st.type !== '振替') {
      const ranked = rankBy(cats, useCount(m, 'category'), 'categories');
      const shown = st.moreCats ? ranked : topWith(ranked, catId, 11, 'categories');
      wrap.appendChild(h('div', { class: 'cats' }, shown.map((c) => h('button', { type: 'button', class: 'cat' + (c.id === catId ? ' on' : ''), onclick: () => {
        st.cat[st.type] = c.id;
        if (st.type === '支出' && prefs.walletByCat[c.id]) st.from = prefs.walletByCat[c.id];
        refresh();
      } }, h('span', { class: 'ci' }, c.icon || '📦'), h('span', { class: 'cn' }, (pinsOf('categories')[c.id] ? '📌' : '') + c.name))),
      ranked.length > shown.length || st.moreCats ? h('button', { type: 'button', class: 'cat more', onclick: () => { st.moreCats = !st.moreCats; refresh(); } }, h('span', { class: 'ci' }, st.moreCats ? '−' : '＋'), h('span', { class: 'cn' }, st.moreCats ? 'たたむ' : 'ほか ' + (ranked.length - shown.length))) : null));
    }

    // 口座・カード（よく使う順）
    const wUse = useCount(m, 'wallet');
    const chooser = (label, value, list, set, key) => {
      const ranked = rankBy(list, wUse, 'wallets');
      const shown = st['more' + key] ? ranked : topWith(ranked, value, 6, 'wallets');
      return h('div', { class: 'field' }, h('div', { class: 'flabel' }, label),
        h('div', { class: 'chips wrap' }, shown.map((w) => h('button', { type: 'button', class: 'chip' + (w.id === value ? ' on' : ''), onclick: () => { set(w.id); refresh(); } }, kindIcon(w.kind), ' ', (pinsOf('wallets')[w.id] ? '📌' : '') + w.name)),
          ranked.length > shown.length || st['more' + key] ? h('button', { type: 'button', class: 'chip ghost', onclick: () => { st['more' + key] = !st['more' + key]; refresh(); } }, st['more' + key] ? 'たたむ' : 'ほか ' + (ranked.length - shown.length) + '件') : null));
    };
    if (st.type === '支出') wrap.appendChild(chooser('支払い', st.from, m.wallets, (v) => { st.from = v; }, 'F'));
    if (st.type === '支出' && st.cur !== 'USD' && m.w[st.from] && m.w[st.from].kind === '電子マネー') wrap.appendChild(chargeBlock(m));
    if (st.type === '収入') wrap.appendChild(chooser('入金先（カードへの返金はカードを選ぶ）', st.to, m.accounts.concat(m.cards), (v) => { st.to = v; }, 'T'));
    if (st.type === '振替') {
      wrap.appendChild(chooser('移す元（カードでのチャージもここ）', st.from, m.wallets, (v) => { st.from = v; }, 'F'));
      wrap.appendChild(chooser('移す先（カードの支払いもここ）', st.to, m.wallets.filter((w) => w.id !== st.from), (v) => { st.to = v; }, 'T'));
    }

    // 予算の残り（支出のとき）
    if (st.type === '支出') {
      const all = E.budgetLeft(m), one = catId ? E.budgetLeft(m, catId) : null, cc = catOf(catId);
      const parts = [];
      if (one) parts.push(h('span', { class: one.left < 0 ? 'neg' : '' }, (cc ? cc.name : '') + ' ' + (one.left < 0 ? yen(-one.left) + ' オーバー' : '残り ' + yen(one.left))));
      if (all) parts.push(h('span', { class: all.left < 0 ? 'neg' : '' }, '生活費 ' + (all.left < 0 ? yen(-all.left) + ' オーバー' : '残り ' + yen(all.left) + '（1日 ' + yen(all.perDay) + '）')));
      if (parts.length) wrap.appendChild(h('div', { class: 'budget-line' }, parts));
    }

    // メモ
    const memo = h('input', { type: 'text', class: 'memo', placeholder: 'メモ（店名・内容）', value: st.memo, maxlength: '200', enterkeyhint: 'done', oninput: (e) => { st.memo = e.target.value; showSug(); } });
    const sug = h('div', { class: 'chips scroll sug' });
    const showSug = () => {
      clear(sug);
      memoSuggest(m, st.type === '振替' ? '' : catId, st.memo).forEach((t) => sug.appendChild(h('button', { type: 'button', class: 'chip', onclick: () => { st.memo = t; memo.value = t; clear(sug); } }, t)));
    };
    showSug();
    wrap.appendChild(h('div', { class: 'field' }, memo, sug));
    const c = catOf(catId);
    if (st.type === '支出' && c && c.group === '立替（あとで戻る）') wrap.appendChild(h('p', { class: 'note' }, '会社などに立て替えた分は「未精算」として記録し、精算されたら入力履歴で「精算済」にします。生活費には入りません。'));

    wrap.appendChild(h('button', { type: 'button', class: 'save-btn', onclick: () => saveInput(false) }, '登録する'));
  }

  function keypad(onKey, decimal) {
    const z = decimal ? '.' : '00';   // ドルのときは「00」の代わりに小数点
    const rows = UI.keypad === 'phone' ? [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], [z, '0', 'del']] : [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], [z, '0', 'del']];
    return h('div', { class: 'keypad' }, rows.flat().map((k) => h('button', { type: 'button', class: 'key' + (k === 'del' ? ' fn' : ''), 'aria-label': k === 'del' ? '1文字消す' : k,
      onclick: () => onKey(k), oncontextmenu: (e) => { if (k === 'del') { e.preventDefault(); onKey('clr'); } } }, k === 'del' ? '⌫' : k)));
  }

  /* ---------- チャージして払う（ナナコなど電子マネー） ---------- */
  // 「チャージ元 → 電子マネー」の振替と「電子マネーからの支払い」を1回の入力で作る。電子マネーの残りも出す
  const chargeKey = (walletId) => walletId + '|' + (S.user || (cfg && cfg.n) || '');
  function chargeSource(m) {
    const k = chargeKey(st.from), me = S.user || (cfg && cfg.n) || '';
    const list = m.wallets.filter((w) => E.isAccount(w) && w.id !== st.from && w.kind !== '電子マネー');
    const saved = prefs.charge[k] && prefs.charge[k].from;
    if (st.chargeFrom && list.some((w) => w.id === st.chargeFrom)) return st.chargeFrom;
    if (saved && list.some((w) => w.id === saved)) return saved;
    const cash = list.filter((w) => w.kind === '現金');
    return ((cash.find((w) => me && w.name.indexOf(me) >= 0) || cash[0] || list[0]) || {}).id || '';
  }
  function chargeDefault(m) {
    const b = E.balances(m)[st.from];
    const have = b && !b.noOpening ? Math.max(0, b.balance) : 0;
    const need = Math.max(0, (Number(st.amount) || 0) - have);
    return need ? Math.ceil(need / 1000) * 1000 : 1000;
  }
  function chargeBlock(m) {
    const w = m.w[st.from];
    // 支払いの電子マネーが変わったら、その電子マネーで前に使った設定（チャージして払う・チャージ元）にする
    if (st._chargeFor !== st.from) { const pf = prefs.charge[chargeKey(st.from)]; st.charge = !!(pf && pf.on); st.chargeEdited = false; st.chargeFrom = ''; st._chargeFor = st.from; }
    const box = h('div', { class: 'charge-box' + (st.charge ? ' on' : '') });
    const line = h('div', { class: 'charge-line' });
    const draw = () => {
      clear(line);
      const b = E.balances(m)[st.from];
      const have = b && !b.noOpening ? b.balance : null;
      const c = st.charge ? (Number(String(st.chargeAmt).replace(/[,円\s]/g, '')) || 0) : 0, pay = Number(st.amount) || 0;
      if (have === null) { line.appendChild(h('span', { class: 'note warn' }, w.name + 'の残高が未入力です（管理 > 開始残高）。残りは計算できませんが、記録はできます。')); return; }
      const after = have + c - pay;
      line.appendChild(h('div', { class: 'charge-calc' + (after < 0 ? ' neg' : '') },
        h('span', null, w.name + ' ' + yen(have)), st.charge ? h('span', null, '＋チャージ ' + yen(c)) : null, h('span', null, '−支払い ' + yen(pay)), h('strong', null, '＝残り ' + yen(after))));
      if (after < 0) line.appendChild(h('div', { class: 'note warn' }, '残高が足りません。' + (st.charge ? 'チャージ額を増やしてください。' : '「チャージして払う」を使ってください。')));
    };
    st._chargeDraw = () => { if (st.charge && !st.chargeEdited && inp) { st.chargeAmt = String(chargeDefault(m)); inp.value = Number(st.chargeAmt).toLocaleString('ja-JP'); } draw(); };
    let inp = null;
    box.appendChild(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.charge, onchange: (e) => {
      st.charge = e.target.checked; st.chargeEdited = false;
      const k = chargeKey(st.from); prefs.charge[k] = Object.assign({}, prefs.charge[k], { on: st.charge }); savePrefs();
      refresh();
    } }), h('span', null, '⚡ チャージして払う（' + w.name + 'にチャージしてから支払い）')));
    if (st.charge) {
      if (!st.chargeEdited) st.chargeAmt = String(chargeDefault(m));
      const src = chargeSource(m);
      st.chargeFrom = src;
      const sel = walletSelect(m.wallets.filter((x) => E.isAccount(x) && x.id !== st.from && x.kind !== '電子マネー'), src);
      sel.addEventListener('change', (e) => { st.chargeFrom = e.target.value; const k = chargeKey(st.from); prefs.charge[k] = Object.assign({}, prefs.charge[k], { from: st.chargeFrom }); savePrefs(); });
      inp = h('input', { type: 'text', inputmode: 'numeric', class: 'mini-amt', value: Number(st.chargeAmt || 0).toLocaleString('ja-JP'), 'aria-label': 'チャージ額',
        oninput: (e) => { st.chargeAmt = e.target.value; st.chargeEdited = true; draw(); } });
      box.appendChild(h('div', { class: 'charge-row' }, h('span', { class: 'flabel inline' }, 'チャージ元'), sel));
      box.appendChild(h('div', { class: 'charge-row' }, h('span', { class: 'flabel inline' }, 'チャージ額'), inp, h('span', null, '円'),
        h('span', { class: 'chips' }, [1000, 3000, 5000, 10000].map((v) => h('button', { type: 'button', class: 'chip', onclick: () => { st.chargeAmt = String(v); st.chargeEdited = true; inp.value = v.toLocaleString('ja-JP'); draw(); } }, (v / 1000) + '千')))));
    }
    box.appendChild(line);
    draw();
    return box;
  }

  function saveInput(fromGuard) {
    const m = model();
    const isUsd = st.cur === 'USD';
    let amount = Number(st.amount);
    const famt = isUsd ? Number(st.usd) : 0, r = isUsd ? fxRate() : 0;
    if (isUsd) {
      if (!(famt > 0)) { toast('ドルの金額を入れてください', { error: true }); return false; }
      if (!(r > 0)) { toast('レートが取れていません。「レートを変える」で1ドルの円を入れてください', { error: true }); return false; }
      amount = E.fxYen(famt, r);
    }
    if (!amount) { toast('金額を入れてください', { error: true }); return false; }
    const t = { id: rid('t'), date: st.date || m.today, type: st.type, amount: amount, category: st.type === '振替' ? '' : st.cat[st.type],
      from: st.type === '収入' ? '' : st.from, to: st.type === '支出' ? '' : st.to, memo: st.memo.trim(), user: S.user || (cfg && cfg.n) || '', settle: '', ref: '', created: nowStr(),
      cur: isUsd ? 'USD' : '', famt: isUsd ? famt : '', fx: isUsd ? r : '', fxAt: isUsd ? (st.fxManual ? '手入力' : (FX.usd && FX.usd.at) || '') : '' };
    const c = catOf(t.category);
    if (st.type === '支出' && c && c.group === '立替（あとで戻る）') t.settle = '未精算';
    // チャージして払う：先にチャージ（振替）を作る
    let ch = null;
    const ew = m.w[t.from];
    if (st.type === '支出' && !isUsd && st.charge && ew && ew.kind === '電子マネー') {
      const ca = Number(String(st.chargeAmt).replace(/[,円\s]/g, '')) || 0;
      const src = chargeSource(m);
      if (!(ca > 0)) { toast('チャージ額を入れてください', { error: true }); return false; }
      if (!src) { toast('チャージ元を選んでください', { error: true }); return false; }
      ch = { id: rid('t'), date: t.date, type: '振替', amount: ca, category: '', from: src, to: ew.id, memo: 'チャージ（' + ew.name + '）', user: t.user, settle: '', ref: '', created: t.created };
      const k = chargeKey(ew.id); prefs.charge[k] = Object.assign({}, prefs.charge[k], { on: true, from: src });
    }
    try { if (ch) put('tx', ch); put('tx', t); } catch (e) { if (ch) del('tx', ch.id); toast(e.message, { error: true }); return false; }
    if (st.type === '支出') { prefs.walletByCat[t.category] = t.from; prefs.lastFrom = t.from; }
    if (st.type === '収入') prefs.lastIncomeTo = t.to;
    savePrefs();
    st.amount = ''; st.usd = ''; st.memo = ''; st.chargeEdited = false;
    let left = '';
    if (ch) { const b = E.balances(model())[ew.id]; if (b && !b.noOpening) left = '（' + ew.name + 'の残り ' + yen(b.balance) + '）'; }
    toast((ch ? ew.name + 'に' + yen(ch.amount) + 'チャージして、' : '') + (c ? c.name + ' ' : '') + (isUsd ? E.usd(famt) + '（' + yen(amount) + '）' : yen(amount)) + ' を登録しました' + left,
      { undo: () => { del('tx', t.id); if (ch) del('tx', ch.id); toast('取り消しました'); } });
    if (!fromGuard) {
      if (UI.afterSave === 'home') go('home'); else refresh();
    }
    return true;
  }

  // 直近90日の使われ方（よく使う順に並べるため）
  let usageMemo = { key: '', v: {} };
  function useCount(m, what) {
    const key = S.ver + '|' + what;
    if (usageMemo.key === key) return usageMemo.v;
    const since = E.addDays(m.today, -90), c = {};
    m.tx.forEach((t) => {
      if (t.date < since) return;
      if (what === 'category' && t.category) c[t.category] = (c[t.category] || 0) + 1;
      if (what === 'wallet') { if (t.from) c[t.from] = (c[t.from] || 0) + 1; if (t.to) c[t.to] = (c[t.to] || 0) + 1; }
    });
    usageMemo = { key: key, v: c };
    return c;
  }
  // 固定（いつも上に出す）：夫と妻で別々に持つ
  const pinsOf = (table) => {
    const me = S.user || (cfg && cfg.n) || '';
    const o = {};
    (data().pins || []).filter((p) => p.user === me && p.table === table).forEach((p) => { o[p.ref] = p; });
    return o;
  };
  function togglePin(table, id) {
    const pins = pinsOf(table);
    if (pins[id]) { del('pins', pins[id].id); toast('固定を外しました'); }
    else {
      const n = Object.keys(pins).length;
      put('pins', { id: rid('pn'), user: S.user || (cfg && cfg.n) || '', table: table, ref: id, order: n + 1 });
      toast('いつも上に出すようにしました（' + (S.user || '') + 'の設定）');
    }
  }
  // 並び：固定 → よく使う順（直近90日）→ もとの並び順
  const rankBy = (list, cnt, table) => {
    const pins = table ? pinsOf(table) : {};
    return list.map((x, i) => [x, i]).sort((a, b) => {
      const pa = pins[a[0].id], pb = pins[b[0].id];
      if (pa || pb) { if (!pa) return 1; if (!pb) return -1; return (pa.order || 0) - (pb.order || 0); }
      return ((cnt[b[0].id] || 0) - (cnt[a[0].id] || 0)) || a[1] - b[1];
    }).map((p) => p[0]);
  };
  // 上位n件だけ出す。固定したものと、いま選んでいるものは必ず出す
  const topWith = (list, id, n, table) => {
    const pins = table ? pinsOf(table) : {};
    const top = list.filter((x, i) => i < n || pins[x.id]);
    const sel = list.find((x) => x.id === id); if (sel && top.indexOf(sel) < 0) top.push(sel);
    return top;
  };

  function frequent(m) {
    const since = E.addDays(m.today, -60), count = {};
    m.tx.forEach((t) => {
      if (t.type !== '支出' || t.date < since || !m.c[t.category] || !m.w[t.from]) return;
      const k = t.category + '|' + t.from + '|' + (t.memo || '');
      count[k] = (count[k] || 0) + 1;
    });
    return Object.keys(count).filter((k) => count[k] >= 2).sort((a, b) => count[b] - count[a]).slice(0, 6)
      .map((k) => { const p = k.split('|'); return { cat: p[0], from: p[1], memo: p.slice(2).join('|') }; });
  }
  function memoSuggest(m, catId, typed) {
    const seen = {}, out = [];
    for (let i = m.tx.length - 1; i >= 0 && out.length < 8; i--) {
      const t = m.tx[i];
      if (!t.memo || seen[t.memo] || (catId && t.category !== catId)) continue;
      if (typed && (t.memo === typed || t.memo.indexOf(typed) < 0)) continue;
      seen[t.memo] = true; out.push(t.memo);
    }
    return out;
  }

  // レシートの品目（内訳）を記録IDごとに
  let itemsMemo = { key: '', v: {} };
  function itemsByTx() {
    if (itemsMemo.key === S.ver) return itemsMemo.v;
    const o = {};
    (data().items || []).forEach((it) => { if (it.tx) (o[it.tx] = o[it.tx] || []).push(it); });
    itemsMemo = { key: S.ver, v: o };
    return o;
  }

  /* ================= 明細 ================= */
  let listYm = '', listFilter = 'all', listQuery = '';
  const monthNav = (ym, set) => h('div', { class: 'month-nav' },
    h('button', { type: 'button', 'aria-label': '前の月', onclick: () => set(E.addMonths(ym, -1)) }, '‹'),
    h('strong', null, (+ym.slice(0, 4)) + '年' + (+ym.slice(5)) + '月'),
    h('button', { type: 'button', 'aria-label': '次の月', onclick: () => set(E.addMonths(ym, 1)) }, '›'));

  /* ================= 分析 ================= */
  let anaTab = 'sum', anaYm = '';
  function analysisPage(main) {
    const m = model();
    main.appendChild(seg([['sum', '期間集計'], ['budget', '予算と分類'], ['tatekae', '立替の精算']], anaTab, (v) => { anaTab = v; refresh(); }));
    if (anaTab === 'sum') { sumView(main, m); return; }
    if (anaTab === 'tatekae') { tatekaeView(main, m); return; }
    // 予算と分類（月ごと）
    if (!anaYm) anaYm = E.ymOf(m.today);
    const s = E.month(m, anaYm);
    main.appendChild(monthNav(anaYm, (v) => { anaYm = v; refresh(); }));
    const isNow = anaYm === E.ymOf(m.today);
    const bl = isNow ? E.budgetLeft(m) : null;
    main.appendChild(card(null,
      h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '生活費'), h('div', { class: 'big' }, yen(s.household))),
        h('div', { class: 'r' }, h('div', { class: 'lbl' }, '予算'), h('div', { class: 'v' }, s.budget ? yen(s.budget) : '未設定'),
          s.budget ? h('div', { class: 'lbl' + (s.household > s.budget ? ' neg' : '') }, s.household > s.budget ? yen(s.household - s.budget) + ' オーバー' : '残り ' + yen(s.budget - s.household)) : null)),
      s.budget ? bar(s.household / s.budget, s.household > s.budget) : null,
      bl ? h('p', { class: 'note' + (bl.left < 0 ? ' warn' : '') }, bl.left >= 0 ? '今月はあと ' + bl.daysLeft + '日。1日あたり ' + yen(bl.perDay) + ' まで使えます（月の ' + Math.round(bl.dayRatio * 100) + '% が過ぎて、予算の ' + Math.round(bl.ratio * 100) + '% を使用）。' : '今月の予算を ' + yen(-bl.left) + ' 超えています。') : null,
      !s.budget ? h('button', { type: 'button', class: 'link', onclick: () => push('table', { table: 'categories' }) }, '分類ごとに予算を入れる（管理 > 分類と予算）') : null));
    const max = Math.max(1, ...s.expenseCats.map((c) => Math.max(c.total, c.budget || 0)));
    main.appendChild(card('支出（分類ごと・押すと履歴）', s.expenseCats.length ? s.expenseCats.map((c) => h('button', { type: 'button', class: 'catbar tap', onclick: () => { listFilter = 'c:' + c.id; listYm = anaYm; go('list'); } },
      h('div', { class: 'top' }, h('span', null, (c.icon || '') + ' ' + c.name, c.group !== '生活費' ? h('span', { class: 'tag' }, c.group === '生活費の外' ? '生活費の外' : '立替') : null),
        h('span', { class: 'amt' + (c.budget && c.total > c.budget ? ' neg' : '') }, yen(c.total) + (c.budget ? ' / ' + yen(c.budget) : ''))),
      bar(c.budget ? c.total / c.budget : c.total / max, c.budget && c.total > c.budget),
      c.budget ? h('div', { class: 'sub' }, h('span', null, c.total > c.budget ? yen(c.total - c.budget) + ' オーバー' : '残り ' + yen(c.budget - c.total)), h('span', null, Math.round(c.total / c.budget * 100) + '%')) : null)) : empty('この月の支出はありません')));
    if (s.incomeCats.length) main.appendChild(card('収入（分類ごと）', s.incomeCats.map((c) => row({ icon: c.icon, t1: c.name, right: amountEl(c.total, 'pos') }))));
    const users = Object.keys(s.byUser);
    if (users.length > 1) main.appendChild(card('入力した人ごとの支出', users.map((u) => row({ t1: u, right: amountEl(s.byUser[u]) }))));
  }

  /* ---------- 立替の精算：会社からの精算金と、未精算の立替を突き合わせる ---------- */
  const TK = { sel: null, income: '', wallet: '' };
  function tatekaeView(main, m) {
    const open = m.tx.filter((t) => t.type === '支出' && t.settle === '未精算').sort((a, b) => a.date.localeCompare(b.date));
    if (!TK.sel) { TK.sel = {}; open.forEach((t) => { TK.sel[t.id] = true; }); }
    Object.keys(TK.sel).forEach((id) => { if (!open.some((t) => t.id === id)) delete TK.sel[id]; });
    const chosen = open.filter((t) => TK.sel[t.id]);
    const sum = chosen.reduce((a, t) => a + t.amount, 0);
    // 精算金の候補：最近90日の収入（会社立替の精算・給与以外も含めて、自分で選ぶ）
    const incomes = m.tx.filter((t) => t.type === '収入' && t.date >= E.addDays(m.today, -90)).sort((a, b) => b.date.localeCompare(a.date));
    const inc = incomes.find((t) => t.id === TK.income) || null;
    main.appendChild(card(null,
      h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '未精算の立替'), h('div', { class: 'big' }, yen(open.reduce((a, t) => a + t.amount, 0)))),
        h('div', { class: 'r' }, h('div', { class: 'lbl' }, '件数'), h('div', { class: 'v' }, open.length + '件'))),
      h('p', { class: 'note' }, '会社から精算金が入ったら、その入金と、精算された立替を選んで「精算済」にします。金額が合っているかをここで確かめられます。')));
    if (!open.length) { main.appendChild(card(null, empty('未精算の立替はありません'))); return; }
    main.appendChild(card('精算された立替を選ぶ（' + chosen.length + '／' + open.length + '件）',
      h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => { open.forEach((t) => { TK.sel[t.id] = true; }); refresh(); } }, 'すべて選ぶ'), h('button', { type: 'button', onclick: () => { TK.sel = {}; refresh(); } }, 'すべて外す')),
      open.map((t) => h('label', { class: 'check tk-row' }, h('input', { type: 'checkbox', checked: !!TK.sel[t.id], onchange: (e) => { TK.sel[t.id] = e.target.checked; refresh(); } }),
        h('span', { class: 'grow' }, md(t.date) + '　' + (t.memo || (catOf(t.category) || {}).name || '立替'), h('small', null, '　' + walletName(t.from))), h('span', { class: 'amt' }, yen(t.amount))))));
    const isel = h('select', { onchange: (e) => { TK.income = e.target.value; refresh(); } },
      h('option', { value: '' }, '（入金をまだ記録していない）'),
      incomes.map((t) => h('option', { value: t.id, selected: t.id === TK.income ? 'selected' : null }, md(t.date) + ' ' + (t.memo || (catOf(t.category) || {}).name || '収入') + ' ' + yen(t.amount) + '（' + walletName(t.to) + '）')));
    const diff = inc ? inc.amount - sum : null;
    const wsel = walletSelect(m.accounts, TK.wallet || (m.accounts.find((a) => /JRE|大分/.test(a.name)) || m.accounts[0] || {}).id); wsel.addEventListener('change', (e) => { TK.wallet = e.target.value; });
    main.appendChild(card('会社から入った精算金',
      fieldWrap('記録してある入金から選ぶ', isel),
      inc ? h('div', { class: 'check-box ' + (diff === 0 ? 'ok' : 'warn') }, h('strong', null, diff === 0 ? '✓ 金額が一致しました' : '⚠ 差があります'),
        h('span', null, '入金 ' + yen(inc.amount) + '／選んだ立替 ' + yen(sum) + (diff ? '（差 ' + yen(diff, { plus: true }) + '）' : ''))) :
        h('div', null, h('p', { class: 'note' }, '入金をまだ記録していなければ、ここで記録できます（選んだ立替の合計 ' + yen(sum) + '）。'), fieldWrap('入金先', wsel))));
    main.appendChild(h('div', { class: 'form-acts pad' },
      h('button', { type: 'button', class: 'primary', disabled: chosen.length ? null : 'disabled', onclick: async () => {
        if (!chosen.length) return;
        if (inc && diff !== 0) { const a = await ask('金額に差があります', '入金 ' + yen(inc.amount) + ' と、選んだ立替 ' + yen(sum) + ' が合いません。このまま精算済にしますか？', [{ v: true, label: '精算済にする', primary: true }, { v: false, label: 'やめる' }]); if (!a) return; }
        const before = chosen.map(stripMeta);
        let added = null;
        if (!inc) {
          const cat = m.categories.find((c) => c.kind === '収入' && /立替|精算|経費/.test(c.name)) || m.categories.find((c) => c.kind === '収入');
          added = { id: rid('t'), date: m.today, type: '収入', amount: sum, category: cat ? cat.id : '', from: '', to: wsel.value, memo: '立替の精算（' + chosen.length + '件）', user: S.user, settle: '', ref: '', created: nowStr() };
          try { put('tx', added); } catch (e) { toast(e.message, { error: true }); return; }
        }
        before.forEach((t) => put('tx', Object.assign({}, t, { settle: '精算済' })));
        TK.sel = null; TK.income = '';
        toast(chosen.length + '件を精算済にしました' + (added ? '（入金 ' + yen(sum) + ' も記録）' : ''), { undo: () => { before.forEach((t) => put('tx', t)); if (added) del('tx', added.id); toast('元に戻しました'); } });
      } }, inc ? '選んだ立替を精算済にする' : '入金を記録して、精算済にする')));
  }
  function listPage(main) {
    const m = model();
    if (!listYm) listYm = E.ymOf(m.today);
    const s = E.month(m, listYm);
    main.appendChild(monthNav(listYm, (v) => { listYm = v; refresh(); }));
    main.appendChild(card(null, h('div', { class: 'grid3' },
      h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '支出'), h('div', { class: 'v' }, yen(s.expense))),
      h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '収入'), h('div', { class: 'v pos' }, yen(s.income))),
      h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '生活費／予算'), h('div', { class: 'v' }, yen(s.household) + (s.budget ? ' / ' + yen(s.budget) : '')))),
      s.budget ? bar(s.household / s.budget, s.household > s.budget) : null));

    // 絞り込み
    const opts = [['all', 'すべて'], ['me', '自分の入力'], ['open', '立替（未精算）']]
      .concat(m.walletsAll.map((w) => ['w:' + w.id, kindIcon(w.kind) + ' ' + w.name]))
      .concat(m.categoriesAll.map((c) => ['c:' + c.id, (c.icon || '') + ' ' + c.name]));
    const sel = h('select', { class: 'filter', 'aria-label': '絞り込み', onchange: (e) => { listFilter = e.target.value; refresh(); } }, opts.map(([v, l]) => h('option', { value: v, selected: v === listFilter ? 'selected' : null }, l)));
    const q = h('input', { type: 'search', class: 'search', placeholder: 'メモで探す', value: listQuery, oninput: (e) => { listQuery = e.target.value; clearTimeout(q._t); q._t = setTimeout(refreshList, 150); } });
    main.appendChild(h('div', { class: 'filters' }, sel, q));
    main.appendChild(h('button', { type: 'button', class: 'link', onclick: () => exportCsv(shownList, listYm) }, '表示中の記録をCSVで書き出す'));
    const box = h('div');
    main.appendChild(box);
    const refreshList = () => {
      clear(box);
      const q2 = listQuery.trim();
      let list = listFilter === 'open' || q2 ? m.tx.slice() : s.tx.slice();   // 探すときと未精算は、すべての月から
      if (listFilter === 'open') list = list.filter((t) => t.settle === '未精算');
      if (listFilter === 'me') list = list.filter((t) => t.user === S.user);
      if (listFilter.indexOf('w:') === 0) { const id = listFilter.slice(2); list = list.filter((t) => t.from === id || t.to === id); }
      if (listFilter.indexOf('c:') === 0) { const id = listFilter.slice(2); list = list.filter((t) => t.category === id); }
      if (q2) list = list.filter((t) => (t.memo || '').indexOf(q2) >= 0 || ((catOf(t.category) || {}).name || '').indexOf(q2) >= 0 || String(t.amount) === q2.replace(/[,円]/g, ''));
      shownList = list;
      list.sort((a, b) => UI.listOrder === 'old' ? (a.date + a.created).localeCompare(b.date + b.created) : (b.date + b.created).localeCompare(a.date + a.created));
      if (!list.length) { box.appendChild(card(null, empty('記録はありません'))); return; }
      if (q2) box.appendChild(h('p', { class: 'note pad' }, 'すべての月から ' + list.length + ' 件見つかりました'));
      if (listFilter === 'open') {
        const total = list.reduce((a, t) => a + t.amount, 0);
        box.appendChild(card(null, h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '未精算の立替'), h('div', { class: 'big' }, yen(total))), h('div', { class: 'r' }, h('div', { class: 'v' }, list.length + '件'))),
          h('button', { type: 'button', class: 'wide primary', onclick: async () => {
            const a = await ask('まとめて精算済にしますか？', list.length + '件・' + yen(total) + ' を「精算済」にします。会社から精算金が入ったら押してください（入金は「収入」で記録）。', [{ v: true, label: '精算済にする', primary: true }, { v: false, label: 'やめる' }]);
            if (!a) return;
            const before = list.map(stripMeta);
            before.forEach((t) => put('tx', Object.assign({}, t, { settle: '精算済' })));
            toast(list.length + '件を精算済にしました', { undo: () => before.forEach((t) => put('tx', t)) });
          } }, 'まとめて精算済にする')));
      }
      let curDate = null, group = null;
      const doneR = {};
      list.forEach((t) => {
        // レシートを分けて登録した記録は、1回の入力として1行にまとめる
        if (t.rcpt) { if (doneR[t.rcpt]) return; doneR[t.rcpt] = true; }
        if (t.date !== curDate) {
          curDate = t.date;
          const dayTotal = list.filter((x) => x.date === t.date && x.type === '支出').reduce((a, x) => a + x.amount, 0);
          group = h('section', { class: 'card day' }, h('div', { class: 'day-head' }, h('span', null, mdw(t.date)), dayTotal ? h('span', { class: 'amt' }, yen(-dayTotal)) : null));
          box.appendChild(group);
        }
        group.appendChild(t.rcpt ? receiptRow(t.rcpt, list.filter((x) => x.rcpt === t.rcpt)) : txRow(t, { who: true }));
      });
    };
    refreshList();
  }

  /* ---------- 期間集計（好きな期間で、分類ごと・支払いごと・お店ごとに合計） ---------- */
  const SUM = { preset: 'thisMonth', from: '', to: '', user: '', open: '', more: false, byItems: store.get('kakeibo.sumByItems', true) !== false, itemsMore: false };
  function sumRange(m) {
    const t = m.today, ym = E.ymOf(t), y = +t.slice(0, 4);
    const endOf = (ym2) => ym2 + '-' + E.pad(E.dimOf(ym2));
    switch (SUM.preset) {
      case 'lastMonth': { const p = E.addMonths(ym, -1); return [p + '-01', endOf(p)]; }
      case '3m': return [E.addMonths(ym, -2) + '-01', t];
      case '6m': return [E.addMonths(ym, -5) + '-01', t];
      case 'thisYear': return [y + '-01-01', t];
      case 'lastYear': return [(y - 1) + '-01-01', (y - 1) + '-12-31'];
      case 'custom': return [SUM.from || ym + '-01', SUM.to || t];
      default: return [ym + '-01', t];
    }
  }
  // くらべる期間：同じ長さだけ前（「先月」なら先々月、「今年」なら去年の同じ時期）
  function sumPrev(from, to) {
    if (SUM.preset === 'thisYear' || SUM.preset === 'lastYear') return [(+from.slice(0, 4) - 1) + from.slice(4), (+to.slice(0, 4) - 1) + to.slice(4)];
    if (SUM.preset === 'thisMonth') { const p = E.addMonths(E.ymOf(from), -1); const d = Math.min(+to.slice(8, 10), E.dimOf(p)); return [p + '-01', p + '-' + E.pad(d)]; }
    if (SUM.preset === 'lastMonth') { const p = E.addMonths(E.ymOf(from), -1); return [p + '-01', p + '-' + E.pad(E.dimOf(p))]; }
    // 月の初日〜月末で区切った期間は、同じ月数だけ前の月とくらべる（10/1〜10/31 → 9/1〜9/30）
    const endOf = (ym2) => ym2 + '-' + E.pad(E.dimOf(ym2));
    if (from.slice(8) === '01' && to === endOf(E.ymOf(to))) {
      let n = 0; for (let ym = E.ymOf(from); ym <= E.ymOf(to); ym = E.addMonths(ym, 1)) n++;
      return [E.addMonths(E.ymOf(from), -n) + '-01', endOf(E.addMonths(E.ymOf(to), -n))];
    }
    const n = E.diffDays(from, to) + 1;
    return [E.addDays(from, -n), E.addDays(from, -1)];
  }
  function sumView(main, m) {
    const presets = [['thisMonth', '今月'], ['lastMonth', '先月'], ['3m', '3か月'], ['6m', '半年'], ['thisYear', '今年'], ['lastYear', '去年'], ['custom', '期間を指定']];
    main.appendChild(h('div', { class: 'chips scroll' }, presets.map(([v, l]) => h('button', { type: 'button', class: 'chip' + (SUM.preset === v ? ' on' : ''), onclick: () => {
      if (v === 'custom' && SUM.preset !== 'custom') { const r = sumRange(m); SUM.from = r[0]; SUM.to = r[1]; }
      SUM.preset = v; SUM.open = ''; refresh(); } }, l))));
    if (SUM.preset === 'custom') {
      const d1 = h('input', { type: 'date', value: SUM.from, onchange: (e) => { if (e.target.value) { SUM.from = e.target.value; refresh(); } } });
      const d2 = h('input', { type: 'date', value: SUM.to, onchange: (e) => { if (e.target.value) { SUM.to = e.target.value; refresh(); } } });
      main.appendChild(h('div', { class: 'sum-dates' }, d1, h('span', null, '〜'), d2));
    }
    main.appendChild(seg([['', '全員'], ['夫', '夫'], ['妻', '妻'], ['PC', 'PC']], SUM.user, (v) => { SUM.user = v; refresh(); }));
    let [from, to] = sumRange(m);
    if (from > to) { const x = from; from = to; to = x; }
    const s2 = E.summary(m, from, to, { user: SUM.user, byItems: SUM.byItems });
    const [pf, pt] = sumPrev(from, to);
    const prev = E.summary(m, pf, pt, { user: SUM.user, byItems: SUM.byItems });
    const prevCat = {}; prev.expenseCats.forEach((c) => { prevCat[c.id] = c.total; });
    const perMonth = (n) => s2.monthsLen >= 1.5 ? yen(Math.round(n / s2.monthsLen)) : null;
    const diff = (now, before) => {
      if (!before && !now) return null;
      const d = now - before;
      return h('span', { class: 'diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') }, d === 0 ? '前と同じ' : (d > 0 ? '▲' : '▼') + yen(Math.abs(d)).replace('-', ''));
    };
    const fmt = (d) => (+d.slice(0, 4) !== +m.today.slice(0, 4) ? d.slice(0, 4) + '/' : '') + md(d);

    main.appendChild(card(fmt(from) + ' 〜 ' + fmt(to) + '（' + s2.days + '日）',
      h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '支出の合計'), h('div', { class: 'big' }, yen(s2.expense))),
        h('div', { class: 'r' }, h('div', { class: 'lbl' }, '前の期間（' + fmt(pf) + '〜' + fmt(pt) + '）'), h('div', { class: 'v' }, yen(prev.expense)), diff(s2.expense, prev.expense))),
      h('div', { class: 'grid3' },
        h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '生活費'), h('div', { class: 'v' }, yen(s2.household))),
        h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '立替'), h('div', { class: 'v' }, yen(s2.tatekae))),
        h('div', { class: 'mini' }, h('div', { class: 'lbl' }, '収入'), h('div', { class: 'v pos' }, yen(s2.income)))),
      s2.monthsLen >= 1.5 ? h('p', { class: 'note' }, '月の平均：支出 ' + perMonth(s2.expense) + '・生活費 ' + perMonth(s2.household)) : null,
      s2.outside ? h('p', { class: 'note' }, '生活費の外（ボーナスからの支払いなど）：' + yen(s2.outside)) : null));

    // 分類ごと
    const max = Math.max(1, ...s2.expenseCats.map((c) => c.total));
    const catRows = s2.expenseCats.map((c) => {
      const key = c.id || 'none';
      const open = SUM.open === key;
      const pct = s2.expense ? Math.round(c.total / s2.expense * 1000) / 10 : 0;
      const head = h('button', { type: 'button', class: 'catbar tap' + (open ? ' open' : ''), onclick: () => { SUM.open = open ? '' : key; SUM.more = false; refresh(); } },
        h('div', { class: 'top' }, h('span', null, (c.icon || '') + ' ' + c.name, c.group !== '生活費' ? h('span', { class: 'tag' }, c.group === '生活費の外' ? '生活費の外' : '立替') : null),
          h('span', { class: 'amt' }, yen(c.total))),
        bar(c.total / max),
        h('div', { class: 'sub' }, h('span', null, pct + '%・' + c.count + '件' + (perMonth(c.total) ? '・月 ' + perMonth(c.total) : '')), diff(c.total, prevCat[c.id] || 0)));
      if (!open) return head;
      // 開いたとき：月ごとの金額と、記録の一覧
      const mm = s2.months.length > 1 ? h('div', { class: 'month-bars' }, s2.months.map((ym) => {
        const v = c.byMonth[ym] || 0, mx = Math.max(1, ...s2.months.map((x) => c.byMonth[x] || 0));
        return h('div', { class: 'mb' }, h('span', { class: 'ml' }, (+ym.slice(5)) + '月'), bar(v / mx), h('span', { class: 'mv' }, yen(v)));
      })) : null;
      const shown = SUM.more ? c.tx : c.tx.slice(0, 20);
      const its = s2.items.filter((it) => (it.category || '') === c.id).slice(0, 10);
      return h('div', { class: 'cat-open' }, head, mm,
        its.length ? h('div', { class: 'cat-items' }, h('div', { class: 'flabel' }, 'レシートの品目（多い順）'), its.map((it) => h('div', { class: 'ci-row' }, h('span', null, it.name + (it.count > 1 ? ' ×' + it.count : '')), h('span', null, yen(it.total))))) : null,
        h('div', { class: 'cat-tx' }, shown.map((t) => t._part ? h('div', { class: 'part-wrap' }, txRow(t), h('div', { class: 'part-note' }, 'このうち「' + c.name + '」の品目の分 ' + yen(t._part))) : txRow(t))),
        c.tx.length > shown.length ? h('button', { type: 'button', class: 'link', onclick: () => { SUM.more = true; refresh(); } }, 'ほか ' + (c.tx.length - shown.length) + '件を表示') : null);
    });
    if (s2.months.length > 1 && s2.expenseCats.length) {
      const ms = s2.months;
      const th = h('tr', null, h('th', { class: 'sticky' }, '分類'), ms.map((ym) => h('th', null, (ym.slice(5) === '01' || ym === ms[0] ? (+ym.slice(2, 4)) + '年' : '') + (+ym.slice(5)) + '月')), h('th', null, '合計'));
      const trs = s2.expenseCats.map((c) => h('tr', null, h('td', { class: 'sticky' }, (c.icon || '') + ' ' + c.name),
        ms.map((ym) => h('td', { class: c.byMonth[ym] ? '' : 'zero' }, c.byMonth[ym] ? (c.byMonth[ym]).toLocaleString('ja-JP') : '-')), h('td', { class: 'tot' }, c.total.toLocaleString('ja-JP'))));
      const ft = h('tr', { class: 'foot' }, h('td', { class: 'sticky' }, '支出の合計'), ms.map((ym) => h('td', null, ((s2.byMonth[ym] || {}).expense || 0).toLocaleString('ja-JP'))), h('td', { class: 'tot' }, s2.expense.toLocaleString('ja-JP')));
      main.appendChild(card('分類ごとの月別（円）', h('div', { class: 'mtable-wrap' }, h('table', { class: 'mtable' }, h('thead', null, th), h('tbody', null, trs, ft))),
        h('p', { class: 'note' }, '横にスクロールできます。月の途中の期間は、その月の分だけです。')));
    }
    main.appendChild(card('分類ごとの支出（押すと中身）', catRows.length ? catRows : empty('この期間の支出はありません'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: SUM.byItems, onchange: (e) => { SUM.byItems = e.target.checked; store.set('kakeibo.sumByItems', SUM.byItems); refresh(); } }),
        h('span', null, 'まとめて1件で登録したレシートも、品目の分類で分けて数える' + (s2.splitByItems ? '（この期間 ' + s2.splitByItems + '件）' : '')))));
    if (s2.items.length) {
      const list = SUM.itemsMore ? s2.items.slice(0, 100) : s2.items.slice(0, 15);
      main.appendChild(card('品目ごと（レシートの内訳・印字の金額）', list.map((it) => { const c = catOf(it.category); return row({ icon: c ? c.icon : '・', t1: it.name, t2: (c ? c.name : '分類なし') + '・' + it.count + '回', right: amountEl(it.total) }); }),
        s2.items.length > list.length ? h('button', { type: 'button', class: 'link', onclick: () => { SUM.itemsMore = true; refresh(); } }, 'もっと見る（全' + s2.items.length + '品目）') : null));
    }
    if (s2.incomeCats.length) main.appendChild(card('収入（分類ごと）', s2.incomeCats.map((c) => row({ icon: c.icon, t1: c.name, t2: c.count + '件', right: amountEl(c.total, 'pos') }))));

    // 支払いごと・入力者ごと・お店（メモ）ごと
    const wl = Object.keys(s2.byWallet).sort((a, b) => s2.byWallet[b] - s2.byWallet[a]);
    if (wl.length) main.appendChild(card('支払いごと', wl.map((id) => { const w = rowOf('wallets', id); return row({ icon: kindIcon(w && w.kind), t1: walletName(id) || '不明', right: amountEl(s2.byWallet[id]) }); })));
    const ul = Object.keys(s2.byUser);
    if (!SUM.user && ul.length > 1) main.appendChild(card('入力した人ごと', ul.map((u) => row({ t1: u, right: amountEl(s2.byUser[u]) }))));
    if (s2.byMemo.length) main.appendChild(card('お店・メモごと（上位10）', s2.byMemo.slice(0, 10).map((b) => row({ t1: b.memo, t2: b.count + '回', right: amountEl(b.total) }))));

    main.appendChild(h('div', { class: 'form-acts pad' },
      h('button', { type: 'button', onclick: () => exportSummary(s2, prev) }, '集計をCSVで書き出す'),
      h('button', { type: 'button', onclick: () => exportCsv(s2.tx, from + '_' + to) }, 'この期間の記録をCSV')));
  }
  function exportSummary(s2, prev) {
    const q = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const safe = (v) => /^[=+\-@]/.test(String(v)) ? "'" + v : v;
    const pc = {}; prev.expenseCats.forEach((c) => { pc[c.id] = c.total; });
    const lines = [['分類', 'グループ', '件数', '合計', '割合(%)', '前の期間', '差'].concat(s2.months).map(q).join(',')];
    s2.expenseCats.forEach((c) => lines.push([safe(c.name), c.group, c.count, c.total, s2.expense ? Math.round(c.total / s2.expense * 1000) / 10 : 0, pc[c.id] || 0, c.total - (pc[c.id] || 0)]
      .concat(s2.months.map((ym) => c.byMonth[ym] || 0)).map(q).join(',')));
    lines.push(['支出の合計', '', s2.count, s2.expense, 100, prev.expense, s2.expense - prev.expense].concat(s2.months.map((ym) => (s2.byMonth[ym] || {}).expense || 0)).map(q).join(','));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: '家計簿_集計_' + s2.from + '_' + s2.to + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  let shownList = [];
  function exportCsv(list, ym) {
    const q = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const lines = [['日付', '種類', '金額', '分類', '出どころ', '入れ先', 'メモ', '入力者', '精算', '登録日時', '通貨', 'ドルの金額', 'レート'].map(q).join(',')];
    list.slice().sort((a, b) => (a.date + a.created).localeCompare(b.date + b.created)).forEach((t) => {
      // 表計算ソフトで数式として動かないよう、= + - @ で始まる文字は ' を付ける
      const safe = (v) => /^[=+\-@]/.test(String(v)) && typeof v === 'string' ? "'" + v : v;
      lines.push([t.date, t.type, t.amount, safe((catOf(t.category) || {}).name || ''), safe(walletName(t.from)), safe(walletName(t.to)), safe(t.memo), t.user, t.settle, t.created, t.cur || '', t.famt === undefined ? '' : t.famt, t.fx === undefined ? '' : t.fx].map(q).join(','));
    });
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: '家計簿_' + ym + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /**
   * 入力者（夫・妻）の切り替え。押すたびに入れかわる。レシートは、そのレシートの記録をまとめて切り替える
   * list … 切り替える記録（レシートなら同じレシートIDの記録すべて）
   */
  function whoToggle(list) {
    const u = list[0].user || '';
    const mixed = list.some((t) => (t.user || '') !== u);
    return h('button', { type: 'button', class: 'who', 'aria-label': '入力者：' + (mixed ? '混在' : u || '未設定') + '（押すと切り替え）', onclick: (ev) => {
      ev.stopPropagation();
      const i = E.WHO.indexOf(u);
      const next = mixed ? (S.user || '夫') : E.WHO[(i + 1) % E.WHO.length];   // 夫 → 妻 → PC → 夫
      const before = list.map(stripMeta);
      try { before.forEach((t) => put('tx', Object.assign({}, t, { user: next }))); }
      catch (e) { toast(e.message, { error: true }); return; }
      toast('入力者を「' + next + '」にしました' + (before.length > 1 ? '（' + before.length + '件）' : ''), { undo: () => before.forEach((t) => put('tx', t)) });
    } }, E.WHO.map((w) => h('span', { class: !mixed && u === w ? 'on' : '' }, w)));
  }
  const rcptTx = (rcpt) => (data().tx || []).filter((t) => t.rcpt === rcpt);

  /** レシート1枚（1回の入力）を1行で。押すと分類ごとの記録と品目の内訳 */
  function receiptRow(rcpt, parts) {
    if (parts.length === 1 && !(itemsByTx()[parts[0].id] || []).length) return txRow(parts[0], { who: true });
    const t0 = parts[0];
    const total = parts.reduce((a, t) => a + t.amount, 0);
    const nIt = (data().items || []).filter((it) => it.rcpt === rcpt).length;
    const names = parts.slice().sort((a, b) => b.amount - a.amount).map((t) => { const c = catOf(t.category); return c ? c.name : '分類なし'; });
    const pend = parts.some((t) => t._pending), open = parts.some((t) => t.settle === '未精算');
    return row({ icon: '🧾', t1: t0.memo || 'レシート', t2: [names.join('・'), walletName(t0.from), nIt ? nIt + '品目' : ''].filter(Boolean).join('・'),
      tag: pend ? '未送信' : open ? '未精算' : null, tagCls: pend ? 'wait' : open ? 'mid' : '',
      right: amountEl(-total), after: whoToggle(rcptTx(rcpt)), onclick: () => push('receiptView', { rcpt: rcpt }) });
  }
  function receiptViewPage(main, p) {
    const m = model();
    setTitle('レシートの内容');
    const parts = (data().tx || []).filter((t) => t.rcpt === p.rcpt).sort((a, b) => b.amount - a.amount);
    const items = (data().items || []).filter((it) => it.rcpt === p.rcpt);
    if (!parts.length) { main.appendChild(card(null, empty('見つかりません（削除された可能性があります）'))); return; }
    const t0 = parts[0], total = parts.reduce((a, t) => a + t.amount, 0);
    main.appendChild(card(null,
      h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, mdw(t0.date) + '・' + (t0.memo || 'レシート')), h('div', { class: 'big' }, yen(total))),
        h('div', { class: 'r' }, h('div', { class: 'lbl' }, '支払い'), h('div', { class: 'v' }, walletName(t0.from)), h('div', { class: 'who-wrap' }, h('span', { class: 'lbl' }, '入力者 '), whoToggle(parts)))),
      h('p', { class: 'note' }, parts.length > 1 ? '分類ごとに ' + parts.length + '件の記録に分けて登録しています。' : '1件の記録で登録しています（集計では、品目の分類で分けて数えます）。')));
    main.appendChild(card('分類ごとの記録（押すと直せます）', parts.map((t) => txRow(t))));
    if (items.length) {
      const byCat = {};
      items.forEach((it) => { (byCat[it.category || ''] = byCat[it.category || ''] || []).push(it); });
      const keys = Object.keys(byCat).sort((a, b) => byCat[b].reduce((x, it) => x + (Number(it.price) || 0), 0) - byCat[a].reduce((x, it) => x + (Number(it.price) || 0), 0));
      const isum = items.reduce((a, it) => a + (Number(it.price) || 0), 0);
      main.appendChild(card('品目の内訳（' + items.length + '品目）', keys.map((k) => {
        const c = catOf(k), list = byCat[k];
        return h('div', { class: 'rv-group' }, h('div', { class: 'rv-head' }, h('span', null, (c ? c.icon + ' ' + c.name : '分類なし')), h('span', null, yen(list.reduce((a, it) => a + (Number(it.price) || 0), 0)))),
          list.map((it) => row({ t1: it.name, t2: it.reduced ? '8%' : '', right: amountEl(-(Number(it.price) || 0)), onclick: () => push('edit', { table: 'items', id: it.id }) })));
      }), h('p', { class: 'note' }, '品目の合計 ' + yen(isum) + '（レシートの印字の金額）／支払った額 ' + yen(total) + (isum !== total ? '。差 ' + yen(total - isum) + ' は税・値引きなどで、分類ごとの記録に割り振っています。' : '。')),
        h('p', { class: 'note' }, '品目を押すと分類を直せます。期間集計の「品目ごと」と、まとめて登録したレシートの分け方に反映されます。')));
    }
    main.appendChild(h('div', { class: 'form-acts pad' },
      h('button', { type: 'button', onclick: back }, '戻る'),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmDel('このレシートの記録 ' + parts.length + '件と品目 ' + items.length + '件を削除します。'))) return;
        const oldT = parts.map(stripMeta), oldI = items.map(stripMeta);
        const learned = learnItems(oldI);   // 振り分けた内容は、読み取りルールに残す
        oldT.forEach((t) => del('tx', t.id)); oldI.forEach((it) => del('items', it.id));
        toast('レシートを削除しました' + (learned ? '（品目の分類 ' + learned + '件は覚えています）' : ''), { undo: () => { oldT.forEach((t) => put('tx', t)); oldI.forEach((it) => put('items', it)); toast('元に戻しました'); } });
        back();
      } }, 'レシートごと削除')));
  }

  function txRow(t, opt) {
    opt = opt || {};
    const c = catOf(t.category);
    const sign = t.type === '収入' ? 1 : t.type === '支出' ? -1 : 0;
    const where = t.type === '振替' ? walletName(t.from) + ' → ' + walletName(t.to) : t.type === '収入' ? walletName(t.to) : t.type === '残高合わせ' ? walletName(t.to) : walletName(t.from);
    const title = t.type === '振替' ? (t.memo || '振替') : t.type === '残高合わせ' ? '残高合わせ' : (t.memo || (c ? c.name : '分類なし'));
    const nIt = (itemsByTx()[t.id] || []).length;
    const t2 = [t.type === '支出' || t.type === '収入' ? (c ? c.name : '分類なし') : t.type, where, opt.who ? '' : t.user, nIt ? '🧾' + nIt + '品目' : ''].filter(Boolean).join('・');
    return row({ icon: t.type === '振替' ? '⇄' : t.type === '残高合わせ' ? '⚖️' : (c ? c.icon : '・'), t1: title, t2: t2,
      tag: t._pending ? '未送信' : t.settle === '未精算' ? '未精算' : t.settle === '精算済' ? '精算済' : t.ref ? '予定' : null,
      tagCls: t._pending ? 'wait' : t.settle === '未精算' ? 'mid' : '',
      right: (() => {
        const a = amountEl(t.type === '残高合わせ' ? t.amount : t.type === '振替' ? t.amount : sign * t.amount, sign > 0 ? 'pos' : t.type === '振替' ? 'mute' : '', { plus: sign > 0 || t.type === '残高合わせ' });
        return t.cur === 'USD' && t.famt ? h('span', { class: 'col' }, a, h('span', { class: 'after' }, E.usd(t.famt) + '・' + Number(t.fx).toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + '円')) : a;
      })(),
      after: opt.who ? whoToggle(t.rcpt ? rcptTx(t.rcpt) : [t]) : null,
      onclick: () => push('edit', { table: 'tx', id: t.id }) });
  }

  /* ================= 予定 ================= */
  let planTab = 'outlook', planYm = '', planFilter = 'all';
  function planPage(main) {
    const m = model();
    main.appendChild(seg([['outlook', '見通し'], ['fixed', '毎月'], ['annual', '年間'], ['bonus', 'ボーナス'], ['todo', 'やること']], planTab, (v) => { planTab = v; refresh(); }, 'seg-5'));
    if (planTab === 'todo') { todoSection(main, m, true); return; }
    if (planTab === 'outlook') {
      const proj = E.projection(m, UI.days);
      const fsel = h('select', { class: 'filter', 'aria-label': '口座で絞り込む', onchange: (e) => { planFilter = e.target.value; refresh(); } },
        [['all', 'すべての予定'], ['money', 'お金の動きだけ']].concat(m.accounts.map((a) => ['w:' + a.id, '🏦 ' + a.name])).concat(m.cards.map((c) => ['c:' + c.id, '💳 ' + c.name]))
          .map(([v, l]) => h('option', { value: v, selected: v === planFilter ? 'selected' : null }, l)));
      main.appendChild(card('口座の見通し（' + UI.days + '日先まで）', proj.accounts.map((a) => row({ icon: '🏦', t1: a.name,
        t2: a.noOpening ? '開始残高が未入力' : '今 ' + yen(a.now, { maskable: true }) + '・いちばん少ない ' + md(a.minDate) + '・' + md(proj.end) + ' ' + yen(a.end, { maskable: true }),
        right: a.noOpening ? h('span', { class: 'tag mid' }, '未入力') : amountEl(a.min, a.min < 0 ? 'neg' : '', { maskable: true }), onclick: () => push('account', { id: a.id }) }))));
      main.appendChild(h('div', { class: 'filters' }, fsel));
      let evs = proj.events;
      if (planFilter === 'money') evs = evs.filter((e) => e.kind !== 'deadline');
      if (planFilter.indexOf('w:') === 0) { const id = planFilter.slice(2); evs = evs.filter((e) => e.wallet === id && !e.viaCard); }
      if (planFilter.indexOf('c:') === 0) { const id = planFilter.slice(2); evs = evs.filter((e) => e.card === id || (e.viaCard && e.wallet === id)); }
      let cur = null, sec = null;
      if (!evs.length) main.appendChild(card(null, empty('予定はありません')));
      evs.forEach((e) => {
        if (e.date !== cur) { cur = e.date; sec = h('section', { class: 'card day' }, h('div', { class: 'day-head' }, h('span', null, mdw(e.date) + (e.date === m.today ? '・今日' : '')))); main.appendChild(sec); }
        sec.appendChild(eventRow(e, m));
      });
      return;
    }
    if (planTab === 'fixed') {
      if (!planYm) planYm = E.ymOf(m.today);
      main.appendChild(h('div', { class: 'month-nav' },
        h('button', { type: 'button', 'aria-label': '前の月', onclick: () => { planYm = E.addMonths(planYm, -1); refresh(); } }, '‹'),
        h('strong', null, (+planYm.slice(5)) + '月の固定費・収入'),
        h('button', { type: 'button', 'aria-label': '次の月', onclick: () => { planYm = E.addMonths(planYm, 1); refresh(); } }, '›')));
      const s = E.month(m, planYm);
      main.appendChild(card(null, h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '支払い済み'), h('div', { class: 'big' }, s.fixed.done + ' / ' + s.fixed.total + '件')),
        h('div', { class: 'r' }, h('div', { class: 'lbl' }, '見込み（生活費分）'), h('div', { class: 'v' }, yen(s.fixed.expected)))), bar(s.fixed.total ? s.fixed.done / s.fixed.total : 0)));
      const occ = E.occurrences(m, planYm, ['固定費', '収入', '振替']);
      [['固定費', '固定費'], ['収入', '収入'], ['振替', '口座間の移動（振替）']].forEach(([kind, title]) => {
        const list = occ.filter((o) => o.plan.kind === kind);
        if (!list.length) return;
        main.appendChild(card(title, list.map((o) => occRow(o, m))));
      });
      main.appendChild(h('button', { type: 'button', class: 'link center', onclick: () => push('table', { table: 'plans' }) }, '固定費・収入・振替・年間の予定を編集する'));
      return;
    }
    if (planTab === 'annual') {
      const a = E.annual(m);
      main.appendChild(card(null, h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '特別費として毎月積み立てる目安'), h('div', { class: 'big' }, yen(a.monthlyReserve))))));
      main.appendChild(card('年をまたぐ支払い', a.items.length ? a.items.map((i) => {
        const p = i.plan, ym = i.nextYm;
        return row({ icon: '🗓', t1: p.name, tag: p.reserve ? '積立' : null,
          t2: [ym ? (+ym.slice(0, 4)) + '年' + (+ym.slice(5)) + '月' : '予定なし', p.every === 0 ? '1回だけ' : p.every > 1 ? p.every + '年ごと' : '毎年', walletName(p.wallet), i.done ? '記録済み' : ''].filter(Boolean).join('・'),
          right: h('span', { class: 'col' }, amountEl(p.amount || 0), ym && !i.done ? h('button', { type: 'button', class: 'sbtn', onclick: (ev) => { ev.stopPropagation(); recordPlan(occFromPlan(m, p, ym)); } }, '記録') : null),
          onclick: () => push('edit', { table: 'plans', id: p.id }) });
      }) : empty('年間の予定はありません')));
      main.appendChild(h('button', { type: 'button', class: 'link center', onclick: () => push('edit', { table: 'plans', id: null, preset: { kind: '年間' } }) }, '＋ 年間の支払いを追加'));
      return;
    }
    if (planTab === 'bonus') {
      const list = E.bonusView(m);
      if (!list.length) main.appendChild(card(null, empty('ボーナスが登録されていません')));
      list.forEach((b) => {
        main.appendChild(card(b.bonus.name + (b.bonus.date ? '（' + md(b.bonus.date) + '）' : ''),
          h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '手取り'), h('div', { class: 'big' }, yen(b.bonus.net || 0))),
            h('div', { class: 'r' }, h('div', { class: 'lbl' }, '配分の残り'), h('div', { class: 'v' + (b.rest < 0 ? ' neg' : '') }, yen(b.rest)))),
          bar(b.items.length ? b.doneCount / b.items.length : 0),
          h('p', { class: 'note' }, '入金口座：' + (b.walletName || '未設定') + '。「実行」を押すと、移し先への振替（または支払い）として記録します。'),
          b.items.map((i) => row({ icon: i.done ? '✅' : '⬜️', t1: i.alloc.item, t2: [i.toName ? '→ ' + i.toName : '支払い', i.alloc.memo].filter(Boolean).join('・'),
            right: h('span', { class: 'col' }, amountEl(i.alloc.amount || 0), h('button', { type: 'button', class: 'sbtn' + (i.done ? ' on' : ''), onclick: (ev) => { ev.stopPropagation(); toggleAlloc(b, i); } }, i.done ? '実行済' : '実行')),
            onclick: () => push('edit', { table: 'allocs', id: i.alloc.id }) })),
          h('button', { type: 'button', class: 'link', onclick: () => push('edit', { table: 'allocs', id: null, preset: { bonus: b.bonus.id } }) }, '＋ 配分を追加')));
      });
      main.appendChild(h('button', { type: 'button', class: 'link center', onclick: () => push('edit', { table: 'bonuses', id: null }) }, '＋ ボーナスを追加'));
    }
  }

  /**
   * カード払いの予定（固定費・年間）は、1件ずつ記録せず、カードの請求でまとめて消し込む。
   * どの請求（何日の引き落とし）に入るかを返す。カード払いでなければ null
   */
  function cardBillOf(m, p, date) {
    const w = m.w[p.wallet];
    if (!w || !E.isCard(w) || p.kind === '収入' || p.kind === '振替') return null;
    const cyc = E.cycleOf(w, date);
    return { card: w, ym: cyc.debitYm, debitDate: cyc.debitDate };
  }
  const openBill = (cb) => push('bill', { card: cb.card.id, ym: cb.ym });

  function occFromPlan(m, p, ym) { return E.occurrences(m, ym).find((o) => o.plan.id === p.id) || null; }
  function occRow(o, m) {
    const p = o.plan, w = o.wallet;
    const cb = !o.done ? cardBillOf(m, p, o.date) : null;
    if (cb) {
      return row({ icon: '💳', t1: p.name, tag: p.inBudget === false && p.kind === '固定費' ? '生活費の外' : null,
        t2: (o.monthOnly ? '日にち未定' : md(o.date)) + '・' + md(cb.debitDate) + ' ' + cb.card.name + 'でまとめて消し込み', cls: 't2wrap',
        right: h('span', { class: 'col' }, amountEl(o.planned, 'est'), h('button', { type: 'button', class: 'sbtn', onclick: (ev) => { ev.stopPropagation(); openBill(cb); } }, '消し込み')),
        onclick: () => openBill(cb) });
    }
    return row({ icon: o.done ? '✅' : p.kind === '収入' ? '💰' : '⬜️', t1: p.name, tag: p.inBudget === false && p.kind === '固定費' ? '生活費の外' : null,
      t2: [o.monthOnly ? '日にち未定' : md(o.date), (w ? w.name : '口座未設定') + (p.kind === '振替' ? ' → ' + (o.to ? o.to.name : '未設定') : ''), o.done ? (p.kind === '収入' ? '入金済み' : p.kind === '振替' ? '移動済み' : '支払い済み') : ''].filter(Boolean).join('・'),
      right: h('span', { class: 'col' }, amountEl(o.done ? o.actual : o.planned, o.done ? '' : 'est'),
        h('button', { type: 'button', class: 'sbtn' + (o.done ? ' on' : ''), onclick: (ev) => { ev.stopPropagation(); if (o.done) undoPlan(o); else quickRecord(o); } }, o.done ? '✓ 済' : '記録')),
      onclick: () => (o.done ? push('edit', { table: 'tx', id: o.done.id }) : recordPlan(Object.assign({ ref: o.ref, plan: p.id, ym: o.ym }, { title: p.name }))) });
  }

  /** 予定を記録に変える（金額を確かめるシート） */
  function recordPlan(ev) {
    const m = model();
    const p = m.plans.find((x) => x.id === ev.plan) || m.plansAll.find((x) => x.id === ev.plan);
    if (!p) return;
    const o = E.occurrences(m, ev.ym).find((x) => x.plan.id === p.id);
    if (!o) return;
    if (o.done) return push('edit', { table: 'tx', id: o.done.id });
    const cb = cardBillOf(m, p, o.date);
    if (cb) { toast(p.name + 'は' + cb.card.name + '払いです。' + md(cb.debitDate) + 'の請求でまとめて消し込みます'); return openBill(cb); }
    const isTr = p.kind === '振替';
    const amount = h('input', { type: 'text', inputmode: 'numeric', value: String(o.planned || ''), class: 'big-input' });
    const date = h('input', { type: 'date', value: o.date <= m.today ? o.date : m.today });
    const wsel = walletSelect(p.kind === '収入' ? m.accounts : m.wallets, p.wallet);
    const tsel = isTr ? walletSelect(m.wallets, p.to) : null;
    const body = h('div', { class: 'form' },
      fieldWrap('金額（円）', amount), fieldWrap('日付', date), fieldWrap(p.kind === '収入' ? '入金先' : isTr ? '移す元' : '支払い元', wsel), isTr ? fieldWrap('移す先', tsel) : null,
      h('p', { class: 'note' }, p.kind === '収入' ? '入金を記録します。口座の残高に足されます。' : isTr ? '口座から口座への移動を記録します。支出には数えません。' : '支払いを記録します。口座払いなら残高から引き、カード払いなら次の請求に入ります。'));
    sheet(p.name + ' を記録', body, { saveLabel: '記録する', onSave: () => {
      const tx = planTx(p, o, { date: date.value || m.today, amount: num(amount.value), from: wsel.value, to: isTr ? tsel.value : wsel.value });
      put('tx', tx);
      toast(p.name + ' を記録しました', { undo: () => del('tx', tx.id) });
    } });
  }
  function planTx(p, o, v) {
    const type = p.kind === '収入' ? '収入' : p.kind === '振替' ? '振替' : '支出';
    return { id: rid('t'), date: v.date, type: type, amount: v.amount, category: type === '振替' ? '' : p.category,
      from: type === '収入' ? '' : v.from, to: type === '支出' ? '' : v.to, memo: p.name, user: S.user, settle: '', ref: o.ref, created: nowStr() };
  }
  function quickRecord(o) {
    const m = model(), p = o.plan;
    const cb = cardBillOf(m, p, o.date);
    if (cb) return openBill(cb);
    if (!o.wallet || !o.planned || (p.kind === '振替' && !o.to)) { recordPlan({ plan: p.id, ym: o.ym }); return; }
    const tx = planTx(p, o, { date: o.date <= m.today ? o.date : m.today, amount: o.planned, from: p.wallet, to: p.kind === '振替' ? p.to : p.wallet });
    put('tx', tx);
    toast(p.name + ' を記録しました（' + yen(tx.amount) + '）', { undo: () => del('tx', tx.id) });
  }
  async function undoPlan(o) {
    const a = await ask(o.plan.name + ' の記録を取り消しますか？', yen(o.actual) + ' の記録を削除します。', [{ v: true, label: '取り消す', danger: true }, { v: false, label: 'やめる' }]);
    if (a) { del('tx', o.done.id); toast('取り消しました'); }
  }
  function toggleAlloc(b, i) {
    if (i.done) { undoAlloc(i); return; }
    const m = model();
    if (!b.bonus.wallet) { toast('ボーナスの入金口座を先に設定してください', { error: true }); push('edit', { table: 'bonuses', id: b.bonus.id }); return; }
    const a = i.alloc;
    const tx = a.to ? { id: rid('t'), date: m.today, type: '振替', amount: Number(a.amount) || 0, category: '', from: b.bonus.wallet, to: a.to, memo: b.bonus.name + '：' + a.item, user: S.user, settle: '', ref: 'a:' + a.id, created: nowStr() }
      : { id: rid('t'), date: m.today, type: '支出', amount: Number(a.amount) || 0, category: a.category, from: b.bonus.wallet, to: '', memo: b.bonus.name + '：' + a.item, user: S.user, settle: '', ref: 'a:' + a.id, created: nowStr() };
    try { put('tx', tx); toast(a.item + ' を記録しました', { undo: () => del('tx', tx.id) }); } catch (e) { toast(e.message, { error: true }); }
  }
  async function undoAlloc(i) {
    const a = await ask(i.alloc.item + ' の実行を取り消しますか？', '記録した振替（支払い）を削除します。', [{ v: true, label: '取り消す', danger: true }, { v: false, label: 'やめる' }]);
    if (a) del('tx', i.done.id);
  }

  /* ================= 口座・カードの詳細 ================= */
  function accountPage(main, p) {
    const m = model();
    const w = m.w[p.id];
    if (!w) { main.appendChild(card(null, empty('見つかりません'))); return; }
    setTitle(w.name);
    const b = E.balances(m)[w.id];
    main.appendChild(card(null,
      h('div', { class: 'assets' }, h('div', null, h('div', { class: 'lbl' }, '今の残高（計算）'), h('div', { class: 'big' }, b.noOpening ? '未入力' : yen(b.balance, { maskable: true })))),
      b.noOpening ? h('p', { class: 'note warn' }, '開始残高がまだです。通帳やアプリの今の残高を入れると、ここから計算を始めます。') :
        h('div', { class: 'breakdown' },
          bdRow('開始残高（' + w.openingAt.slice(5, 16).replace('-', '/') + '）', b.opening),
          bdRow('入金・振替で入った分', b.inSum, true), bdRow('支払い・振替で出た分', -b.outSum), bdRow('カードの引き落とし', -b.debits), b.adjust ? bdRow('残高合わせ（ずれの調整）', b.adjust, true) : null),
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'primary', onclick: () => b.noOpening ? setOpening(w) : adjustBalance(w, b.balance) }, b.noOpening ? '開始残高を入れる' : '実際の残高と合わせる'),
        h('button', { type: 'button', onclick: () => { st.type = '振替'; st.from = w.id; st.to = ''; go('input'); } }, 'ここから振替'),
        h('button', { type: 'button', onclick: () => push('edit', { table: 'wallets', id: w.id }) }, '設定'))));
    const cards = m.cards.filter((c) => c.payFrom === w.id);
    if (cards.length) {
      const st2 = E.cardStatus(m).filter((c) => c.card.payFrom === w.id);
      main.appendChild(card('この口座から引き落とされるカード', st2.map((c) => row({ icon: '💳', t1: c.card.name, t2: c.next ? md(c.next.debitDate) + (c.next.confirmed ? '（確定）' : '（見込み）') : '予定なし',
        right: c.next ? amountEl(c.next.amount, c.next.confirmed ? '' : 'est') : '', onclick: () => push('card', { id: c.card.id }) }))));
    }
    const list = m.tx.filter((t) => t.from === w.id || t.to === w.id).slice(-40).reverse();
    main.appendChild(card('最近の記録', list.length ? list.map(txRow) : empty('記録はありません')));
  }
  const bdRow = (label, v, plus) => h('div', { class: 'bd' }, h('span', null, label), h('span', { class: 'amt' + (v < 0 ? ' neg' : '') }, yen(v, { plus: plus, maskable: true })));

  function setOpening(w) {
    const amount = h('input', { type: 'text', inputmode: 'numeric', class: 'big-input', value: w.opening === '' ? '' : String(w.opening) });
    sheet(w.name + ' の開始残高', h('div', { class: 'form' }, fieldWrap('今の残高（円）', amount),
      h('p', { class: 'note' }, '通帳やアプリに出ている「今」の残高を入れます。入れた日時より後に登録した記録とカードの引き落としで、残高を計算します。')), {
      saveLabel: '保存', onSave: () => {
        const v = num(amount.value, true);
        put('wallets', Object.assign({}, stripMeta(w), { opening: v, openingAt: nowStr() }));
        toast(w.name + ' の開始残高を保存しました');
      } });
  }
  function adjustBalance(w, computed) {
    const amount = h('input', { type: 'text', inputmode: 'numeric', class: 'big-input', placeholder: String(computed) });
    const diff = h('p', { class: 'note' }, '計算上の残高：' + yen(computed));
    amount.addEventListener('input', () => { const v = num(amount.value, true, true); diff.textContent = v === null ? '計算上の残高：' + yen(computed) : 'ずれ：' + yen(v - computed, { plus: true }) + '（「残高合わせ」として記録します）'; });
    sheet(w.name + ' の残高を合わせる', h('div', { class: 'form' }, fieldWrap('実際の残高（円）', amount), diff,
      h('p', { class: 'note' }, '記録し忘れや手数料・利息などで、計算と実際がずれたときに使います。ずれの分だけを記録するので、これまでの記録は変わりません。')), {
      saveLabel: '合わせる', onSave: () => {
        const v = num(amount.value, true);
        const d = v - computed;
        if (!d) { toast('ずれはありません'); return; }
        put('tx', { id: rid('t'), date: model().today, type: '残高合わせ', amount: d, category: '', from: '', to: w.id, memo: '実際の残高 ' + yen(v) + ' に合わせた', user: S.user, settle: '', ref: '', created: nowStr() });
        toast('残高を合わせました（' + yen(d, { plus: true }) + '）');
      } });
  }

  function cardPage(main, p) {
    const m = model();
    const c = E.cardStatus(m).find((x) => x.card.id === p.id);
    if (!c) { main.appendChild(card(null, empty('見つかりません'))); return; }
    setTitle(c.card.name);
    const proj = E.projection(m, 100);
    main.appendChild(card(null,
      h('div', { class: 'assets' }, h('div', null, h('div', { class: 'lbl' }, '未払いの合計（見込み）'), h('div', { class: 'big' }, yen(c.owed, { maskable: true })))),
      h('p', { class: 'note' }, [c.card.closeDay ? (c.card.closeDay === '末' ? '月末' : c.card.closeDay + '日') + '締め' : '締め日未設定', c.card.debitDay ? (c.card.debitOffset === '2' ? '翌々月' : '翌月') + c.card.debitDay + '日払い' : '', '引き落とし：' + (walletName(c.card.payFrom) || '未設定')].join('・')),
      h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => push('edit', { table: 'wallets', id: c.card.id }) }, '設定'),
        h('button', { type: 'button', onclick: () => { st.type = '振替'; st.from = ''; st.to = c.card.id; go('input'); } }, '口座から支払う（振替）'))));
    const pbills = proj.bills;
    const bills = Object.keys(pbills).map((k) => pbills[k]).filter((b) => b.card === c.card.id).sort((a, b) => b.debitDate.localeCompare(a.debitDate)).slice(0, 8);
    main.appendChild(card('請求（引き落とし日ごと）', bills.length ? bills.map((b) => row({ icon: b.debitDate > m.today ? '🕒' : b.status === '引き落とし不可' ? '⚠️' : '✓',
      t1: md(b.debitDate) + ' 引き落とし', tag: b.status === '引き落とし不可' ? '引き落とし不可' : b.confirmed ? '確定' : '見込み', tagCls: b.status === '引き落とし不可' ? 'high' : b.confirmed ? '' : 'mid',
      t2: ['記録 ' + yen(b.used) + '（' + b.count + '件）', b.planned ? '予定 ' + yen(b.planned) : '', b.closeDate ? md(b.closeDate) + '締め' : ''].filter(Boolean).join('・'),
      right: amountEl(b.amount, b.confirmed ? '' : 'est'), onclick: () => push('bill', { card: c.card.id, ym: b.ym }) })) : empty('請求はまだありません')));
    const cyc = c.cycle;
    const using = m.tx.filter((t) => (t.from === c.card.id || t.to === c.card.id) && E.cycleOf(c.card, t.date).debitYm === cyc.debitYm).reverse();
    main.appendChild(card('いま使っている分（' + md(cyc.closeDate) + '締め・' + md(cyc.debitDate) + '払い）', using.length ? using.map(txRow) : empty('まだありません')));
  }

  /* ---------- カードの請求の消し込み（1回分まとめて） ---------- */
  function billPage(main, p) {
    const m = model();
    const d = E.billDetail(m, p.card, p.ym);
    if (!d) { main.appendChild(card(null, empty('見つかりません'))); return; }
    setTitle(d.card.name + '・' + md(d.debitDate) + 'の請求');
    if (!p.state) {
      p.state = { sel: {}, amt: {}, total: d.confirmed ? String(d.override) : '', status: d.status, memo: d.row ? d.row.memo || '' : '', dirty: false };
      d.plans.forEach((o) => { p.state.sel[o.ref] = !!o.planned; p.state.amt[o.ref] = o.planned ? String(o.planned) : ''; });   // 金額が未定の予定は、最初は外しておく
    }
    const F = p.state;
    const left = E.diffDays(m.today, d.debitDate);
    const allDone = d.confirmed && !d.plans.length;
    main.appendChild(card(null,
      h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, md(d.debitDate) + (left > 0 ? '（あと' + left + '日）' : left === 0 ? '（今日）' : '（済）') + 'に引き落とし'),
        h('div', { class: 'big' }, d.confirmed ? yen(d.override) : '未確定')),
        h('div', { class: 'r' }, h('div', { class: 'lbl' }, '引き落とし口座'), h('div', { class: 'v' }, walletName(d.payFrom) || '未設定'),
          h('span', { class: 'tag ' + (allDone ? 'low' : 'mid') }, allDone ? '消し込み済' : d.confirmed ? '確定（予定の記録が残っています）' : 'まだ消し込んでいません'))),
      h('p', { class: 'note' }, (d.closeDate ? md(d.closeDate) + '締め' : '') + '。この請求に入る利用と予定を確かめて、カード会社の明細の金額で「消し込み」をします。')));

    // まだ記録していない予定（固定費など）
    const sumBox = h('div');
    const selSum = () => d.plans.filter((o) => F.sel[o.ref]).reduce((a, o) => a + (num(F.amt[o.ref] || '0', false, true) || 0), 0);
    if (d.plans.length) main.appendChild(card('まだ記録していない予定（' + d.plans.length + '件）', d.plans.map((o) => {
      const amt = h('input', { type: 'text', inputmode: 'numeric', class: 'mini-amt', value: F.amt[o.ref], 'aria-label': o.plan.name + 'の金額', oninput: (e) => { F.amt[o.ref] = e.target.value; F.dirty = true; drawSum(); } });
      return h('div', { class: 'tk-row' }, h('input', { type: 'checkbox', checked: !!F.sel[o.ref], onchange: (e) => { F.sel[o.ref] = e.target.checked; F.dirty = true; drawSum(); } }),
        h('span', { class: 'grow' }, o.plan.name, h('small', null, '　' + (o.monthOnly ? (+o.ym.slice(5)) + '月' : md(o.date)))), amt, h('span', null, '円'));
    }), h('p', { class: 'note' }, 'チェックした予定を、このカードの利用として記録します（金額は明細に合わせて直せます）。')));

    // 記録済みの利用
    main.appendChild(card('記録済みの利用（' + d.txs.length + '件・' + yen(d.used) + '）', d.txs.length ? d.txs.map((t) => txRow(t)) : empty('この請求に入る記録はありません')));

    // 請求額
    const totalIn = h('input', { type: 'text', inputmode: 'numeric', class: 'big-input', value: F.total, placeholder: '明細の金額', oninput: (e) => { F.total = e.target.value; F.dirty = true; drawSum(); } });
    const status = h('select', { onchange: (e) => { F.status = e.target.value; F.dirty = true; } }, ['自動', '引き落とし不可'].map((v) => h('option', { value: v, selected: v === F.status ? 'selected' : null }, v === '自動' ? '口座から引き落とし' : '引き落とせなかった（あとで振込などで払う）')));
    const memo = h('input', { type: 'text', value: F.memo, oninput: (e) => { F.memo = e.target.value; F.dirty = true; } });
    const drawSum = () => {
      clear(sumBox);
      const calc = d.used + selSum();
      const t = num(F.total, false, true);
      sumBox.appendChild(h('div', { class: 'bd' }, h('span', null, '記録済み ' + yen(d.used) + ' ＋ 予定 ' + yen(selSum())), h('strong', null, '＝ ' + yen(calc))));
      if (t !== null && t !== calc) sumBox.appendChild(h('div', { class: 'check-box warn' }, h('strong', null, '差 ' + yen(t - calc, { plus: true })),
        h('span', null, '記録していない利用・年会費・手数料などの差です。消し込むと、明細の金額（' + yen(t) + '）を口座から引き落とします。')));
      else if (t !== null) sumBox.appendChild(h('div', { class: 'check-box ok' }, h('strong', null, '✓ 明細の金額と一致しています')));
    };
    drawSum();
    main.appendChild(card('請求額', sumBox, fieldWrap('カード会社の明細の金額（円）', totalIn), fieldWrap('引き落とし', status), fieldWrap('メモ', memo),
      h('p', { class: 'note' }, '空欄のまま消し込むと、記録と予定の合計（' + yen(d.used + selSum()) + '）で確定します。')));

    const save = () => {
      try {
        const chosen = d.plans.filter((o) => F.sel[o.ref]);
        const made = chosen.map((o) => {
          const a = num(F.amt[o.ref] || '', false, true);
          if (!(a > 0)) throw new Error('「' + o.plan.name + '」の金額を入れるか、チェックを外してください。');
          return planTx(o.plan, o, { date: o.date, amount: a, from: d.card.id, to: d.card.id });
        });
        const t = num(F.total, false, true);
        const total = t === null ? d.used + made.reduce((x, y) => x + y.amount, 0) : t;
        const oldRow = d.row ? stripMeta(d.row) : null;
        made.forEach((x) => put('tx', x));
        put('bills', { id: d.row ? d.row.id : rid('b'), card: d.card.id, ym: d.ym, amount: total, status: F.status, memo: F.memo });
        R.guard = null;
        toast(d.card.name + '・' + md(d.debitDate) + 'の請求を ' + yen(total) + ' で消し込みました' + (made.length ? '（予定 ' + made.length + '件を記録）' : ''),
          { undo: () => { made.forEach((x) => del('tx', x.id)); if (oldRow) put('bills', oldRow); else { const r = (data().bills || []).find((b) => b.card === d.card.id && b.ym === d.ym); if (r) del('bills', r.id); } toast('元に戻しました'); } });
        back();
        return true;
      } catch (e) { toast(e.message, { error: true }); return false; }
    };
    R.guard = { form: true, dirty: () => F.dirty, save: save, title: '消し込みをまだ保存していません', saveLabel: '消し込む' };
    main.appendChild(h('div', { class: 'form-acts pad' },
      h('button', { type: 'button', onclick: back }, 'やめる'),
      d.row ? h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await ask('確定を外しますか？', '明細の金額を消して、記録と予定から計算した見込みに戻します。記録した予定は消えません。', [{ v: true, label: '外す', danger: true }, { v: false, label: 'やめる' }]))) return;
        const old = stripMeta(d.row); del('bills', d.row.id); R.guard = null; toast('確定を外しました', { undo: () => put('bills', old) }); back();
      } }, '確定を外す') : null,
      h('button', { type: 'button', class: 'primary', onclick: save }, d.plans.length ? '消し込む（予定も記録）' : '消し込む')));
  }



  /* ================= 管理 ================= */
  function managePage(main) {
    const m = model();
    const d = data();
    const item = (icon, t1, t2, fn, tag) => row({ icon: icon, t1: t1, t2: t2, right: '›', onclick: fn, tag: tag || null, tagCls: tag ? 'mid' : '' });
    const issues = E.dataCheck(m);
    const hi = issues.filter((x) => x.level !== '低').length;
    const noOpen = m.accounts.filter((a) => !a.openingAt || a.opening === '').length;
    main.appendChild(card('お金の置き場所',
      item('🏦', '口座・カード・電子マネー', m.accounts.length + '口座・' + m.cards.length + '枚（支払い方法の一覧）', () => push('table', { table: 'wallets' })),
      item('💳', 'カードの締め日・引き落とし', m.cards.map((c) => c.name + ' ' + (c.closeDay === '末' ? '月末' : (c.closeDay || '?') + '日') + '締め' + (c.debitDay || '?') + '日払い').slice(0, 2).join('／') || 'カードがありません', () => push('cards')),
      item('🧮', '開始残高', noOpen ? '未入力 ' + noOpen + '口座' : 'すべて入力済み', () => push('opening'), noOpen ? '未入力' : null),
      item('🧾', 'カードの請求額の確定', '明細の金額を入れる・引き落とし不可', () => push('bills'))));
    main.appendChild(card('入力の決まり',
      item('🗂', '分類と予算', m.categories.length + '分類・予算 ' + yen(E.month(m, E.ymOf(m.today)).budget), () => push('table', { table: 'categories' })),
      item('📷', 'レシートの読み取りルール', (d.rules || []).length + '件（品名の文字で分類を決める）', () => push('table', { table: 'rules' })),
      item('🚃', '交通費の区間・定期券', (d.routes || []).length + '区間・定期 ' + (d.passes || []).length + '枚', () => push('fare', {}))));
    main.appendChild(card('予定・やること（予定のタブで使うもの）',
      item('🏠', '毎月の予定（固定費・収入・振替）と年間', m.plansAll.length + '件', () => push('table', { table: 'plans' })),
      item('📅', '期限とやること', m.deadlines.filter((x) => !x.done).length + '件の期限・' + m.todos.filter((t) => !t.done).length + '件のやること', () => { planTab = 'todo'; go('plan'); }),
      item('🎉', 'ボーナスと配分', m.bonuses.length + '回', () => { planTab = 'bonus'; go('plan'); })));
    main.appendChild(card('通知（LINE）',
      item('💬', '通知の文面と送り先', '番号ごとの文・重要度・オンオフ（10番が月初の振り返り）', () => push('table', { table: 'notifyTpl' })),
      item('⏰', '通知の設定', '時刻・重要度の下限・振り返りを送る日など', () => push('table', { table: 'notifyConf' })),
      item('👥', 'LINEの送り先', (d.lineDest || []).filter((x) => x.lineId && x.enabled).map((x) => x.id).join('・') || '未登録', () => push('table', { table: 'lineDest' }))));
    main.appendChild(card('この端末',
      item('🎨', '表示の設定', '文字の大きさ・色・密度・ホームの構成・入力ショートカット', () => push('display')),
      item('🔄', '保存と同期', syncSummary(), () => push('sync')),
      item('📱', 'この端末の登録', (S.user || (cfg && cfg.n) || '') + 'として登録', () => push('device'))));
    main.appendChild(card('データ',
      item('🩺', 'データの点検', issues.length ? (hi ? '確認したいもの ' + hi + '件・' : '') + '全部で ' + issues.length + '件' : 'おかしなところはありません', () => push('check'), hi ? hi + '件' : null)));
    main.appendChild(h('p', { class: 'note pad center' }, '家計簿 ' + VERSION_LABEL + '（' + APP_VERSION + '）'));
  }

  /* ---------- カードの締め日・引き落とし（一覧） ---------- */
  function cardsPage(main) {
    const m = model();
    setTitle('カードの締め日・引き落とし');
    main.appendChild(h('p', { class: 'note pad' }, '使った日によって、どの請求に入り、いつどの口座から引き落とされるかが決まります。押すと、請求ごとの金額と、いま使っている分が見られます。'));
    const st = E.cardStatus(m);
    main.appendChild(card(null, st.length ? st.map((c) => {
      const w = c.card;
      return row({ icon: '💳', t1: w.name, tag: !w.payFrom ? '口座未設定' : null, tagCls: 'high',
        t2: [(w.closeDay === '末' ? '月末' : w.closeDay ? w.closeDay + '日' : '締め日未設定') + '締め', (w.debitOffset === '2' ? '翌々月' : '翌月') + (w.debitDay || '?') + '日払い', '→ ' + (walletName(w.payFrom) || '引き落とし口座なし')].join('・'),
        right: c.next ? h('span', { class: 'col' }, amountEl(c.next.amount, c.next.confirmed ? '' : 'est', { maskable: true }), h('span', { class: 'after' }, md(c.next.debitDate) + (c.next.confirmed ? ' 確定' : ' 見込み'))) : '',
        onclick: () => push('card', { id: w.id }) });
    }) : empty('カードがありません'),
      h('button', { type: 'button', class: 'link', onclick: () => push('edit', { table: 'wallets', id: null, preset: { kind: 'カード' } }) }, '＋ カードを追加')));
  }

  /* ---------- データの点検 ---------- */
  function checkPage(main) {
    const m = model();
    setTitle('データの点検');
    const list = E.dataCheck(m);
    main.appendChild(h('p', { class: 'note pad' }, '記録や設定の、つながりが切れているところ・二重登録の疑い・入れ忘れを探します。自動では直しません。押すと、その行を開きます。'));
    if (!list.length) { main.appendChild(card(null, h('div', { class: 'check-box ok' }, h('strong', null, '✓ おかしなところはありません'), h('span', null, '記録 ' + m.tx.length + '件・口座とカード ' + m.walletsAll.length + '件・予定 ' + m.plansAll.length + '件を確かめました。')))); return; }
    const open = (x) => {
      if (x.table === 'bills') return push('card', { id: x.id });
      if (x.table === 'tx') { const t = rowOf('tx', x.id); if (t && t.rcpt) return push('receiptView', { rcpt: t.rcpt }); }
      if (x.table === 'wallets' && x.kind === 'no_opening') return push('opening');
      push('edit', { table: x.table, id: x.id });
    };
    [['高', 'すぐ直したいもの'], ['中', '確認したいもの'], ['低', '気になったら']].forEach(([lv, title]) => {
      const xs = list.filter((x) => x.level === lv);
      if (xs.length) main.appendChild(card(title + '（' + xs.length + '件）', xs.slice(0, 60).map((x) => row({ icon: lv === '高' ? '⛔' : lv === '中' ? '⚠️' : '・', t1: x.text, right: '›', cls: 'wrap', onclick: () => open(x) })),
        xs.length > 60 ? h('p', { class: 'note' }, 'ほか ' + (xs.length - 60) + '件') : null));
    });
  }
  function syncSummary() { return S.ops.length ? '未送信 ' + S.ops.length + '件' : S.lastSync ? '最終 ' + new Date(S.lastSync).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ'; }

  /* ---------- 表の一覧 ---------- */
  let tableSeg = {};
  function tablePage(main, p) {
    const m = model();
    const sc = E.SCHEMA[p.table];
    setTitle(sc.label);
    const d = data()[p.table].slice();
    const add = (preset) => push('edit', { table: p.table, id: null, preset: preset || {} });
    let list = d, groups = null;
    if (p.table === 'wallets' || p.table === 'categories') {
      // 固定（自分の設定）→ よく使う順。使っていないものは下に
      const cnt = useCount(m, p.table === 'wallets' ? 'wallet' : 'category');
      list = rankBy(d.slice().sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'ja')), cnt, p.table)
        .sort((a, b) => (a.active === false) - (b.active === false));
      groups = p.table === 'wallets'
        ? [['口座', (r) => r.kind !== 'カード', { kind: '銀行' }], ['カード', (r) => r.kind === 'カード', { kind: 'カード' }]]
        : [['支出', (r) => r.kind === '支出', { kind: '支出' }], ['収入', (r) => r.kind === '収入', { kind: '収入' }]];
      main.appendChild(h('p', { class: 'note pad' }, '📌を押すと、いつも上に出します（' + (S.user || '自分') + 'だけの設定。もう一人には影響しません）。ほかは最近90日でよく使う順です。'));
    }
    if (p.table === 'plans') {
      const k = tableSeg.plans || '固定費';
      main.appendChild(seg(['固定費', '収入', '振替', '年間'], k, (v) => { tableSeg.plans = v; refresh(); }));
      list = d.filter((r) => r.kind === k).sort((a, b) => (Number(a.day) || 99) - (Number(b.day) || 99));
      groups = [[k, () => true, { kind: k }]];
    }
    if (p.table === 'deadlines') list.sort((a, b) => (a.done - b.done) || String(a.date || '9').localeCompare(String(b.date || '9')));
    if (p.table === 'bonuses') list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!groups) groups = [[null, () => true, {}]];
    groups.forEach(([title, fn, preset]) => {
      const rows = list.filter(fn);
      main.appendChild(card(title, rows.length ? rows.map((r) => summaryRow(p.table, r, m)) : empty('まだありません'),
        sc.fixedRows ? null : h('button', { type: 'button', class: 'link', onclick: () => add(preset) }, '＋ ' + (title || sc.label) + 'を追加')));
    });
    if (p.table === 'notifyConf') main.appendChild(h('p', { class: 'note center' }, '時刻を変えたら、スプレッドシートのメニュー「家計簿 > LINE通知 > 通知の時刻を登録し直す」を実行してください。'));
    if (p.table === 'lineDest') main.appendChild(h('p', { class: 'note center' }, 'IDは、メニュー「宛先の受付を10分だけ開く」のあと「LINE宛先候補」シートに出たものを貼ります。'));
  }

  function pinBtn(table, id) {
    const on = !!pinsOf(table)[id];
    return h('button', { type: 'button', class: 'pin' + (on ? ' on' : ''), 'aria-label': on ? '固定を外す' : 'いつも上に出す', title: on ? '固定を外す' : 'いつも上に出す',
      onclick: (e) => { e.stopPropagation(); togglePin(table, id); } }, '📌');
  }
  function summaryRow(table, r, m) {
    const go2 = () => push('edit', { table: table, id: r.id });
    const off = r.active === false ? '使っていない' : null;
    switch (table) {
      case 'wallets': {
        const b = r.kind !== 'カード' ? E.balances(m)[r.id] : null;
        const used = useCount(m, 'wallet')[r.id] || 0;
        return row({ icon: kindIcon(r.kind), t1: r.name, tag: off || (r._pending ? '未送信' : used ? '90日で' + used + '回' : null), tagCls: r._pending ? 'wait' : '', after: pinBtn('wallets', r.id),
          t2: r.kind === 'カード' ? [(r.closeDay === '末' ? '月末' : r.closeDay ? r.closeDay + '日' : '?') + '締め', (r.debitDay || '?') + '日払い', walletName(r.payFrom) || '引き落とし口座未設定'].join('・') : [r.kind, r.role].filter(Boolean).join('・'),
          right: b ? (b.noOpening ? h('span', { class: 'tag mid' }, '残高未入力') : amountEl(b.balance, '', { maskable: true })) : '›', onclick: go2 });
      }
      case 'categories': { const used = useCount(m, 'category')[r.id] || 0;
        return row({ icon: r.icon, t1: r.name, tag: off || (r.group !== '生活費' ? r.group.replace('（あとで戻る）', '') : null), t2: [used ? '90日で' + used + '回' : '最近は使っていない', r.budget ? '予算 ' + yen(r.budget) : ''].filter(Boolean).join('・'), right: '›', onclick: go2, after: pinBtn('categories', r.id) }); }
      case 'plans': return row({ icon: r.kind === '収入' ? '💰' : r.kind === '年間' ? '🗓' : r.kind === '振替' ? '⇄' : '🏠', t1: r.name, tag: r.active === false ? '無効' : r.reserve ? '積立' : r.inBudget === false && r.kind === '固定費' ? '生活費の外' : null,
        t2: [r.months ? r.months.split(',').join('・') + '月' : '毎月', r.day ? r.day + '日' : '', r.kind === '年間' ? (r.every === 0 ? '1回だけ' : r.every > 1 ? r.every + '年ごと' : '') : '', (walletName(r.wallet) || '口座未設定') + (r.kind === '振替' ? ' → ' + (walletName(r.to) || '未設定') : ''), r.start || r.end ? (r.start || '') + '〜' + (r.end || '') : ''].filter(Boolean).join('・'),
        right: amountEl(r.amount || 0, r.kind === '収入' ? 'pos' : ''), onclick: go2 });
      case 'deadlines': return row({ icon: r.done ? '✅' : '📅', t1: r.name, t2: [r.date ? r.date.replace(/-/g, '/') : '期限日未入力', r.who, r.memo].filter(Boolean).join('・'),
        right: r.date && !r.done ? h('span', { class: 'tag ' + (E.diffDays(m.today, r.date) <= (r.notice || 30) ? 'mid' : '') }, 'あと' + E.diffDays(m.today, r.date) + '日') : '›', onclick: go2 });
      case 'bonuses': return row({ icon: '🎉', t1: r.name, t2: [r.date, walletName(r.wallet)].filter(Boolean).join('・'), right: amountEl(r.net || 0), onclick: go2 });
      case 'notifyTpl': return row({ icon: r.enabled ? '💬' : '🔕', t1: r.id + '. ' + r.text, tag: r.level, tagCls: levelCls[r.level], t2: '送り先：' + r.to + '・' + r.type, right: '›', onclick: go2 });
      case 'notifyConf': return row({ t1: r.id, right: h('span', { class: 'tag' }, r.value), onclick: go2 });
      case 'rules': { const c = catOf(r.category); return row({ icon: c ? c.icon : '・', t1: (c ? c.name : '分類なし') + '　←　' + r.keyword.slice(0, 40) + (r.keyword.length > 40 ? '…' : ''), tag: r.active === false ? '使わない' : null, right: '›', onclick: go2 }); }
      case 'passes': { const ex = r.end && r.end < m.today; return row({ icon: '🎫', t1: r.user + '：' + r.name, tag: ex ? '期限切れ' : null, tagCls: ex ? 'mid' : '', t2: r.route + (r.end ? '・期限 ' + r.end.replace(/-/g, '/') : ''), right: '›', onclick: go2 }); }
      case 'routes': return row({ icon: '🚃', t1: r.from + ' → ' + r.to, t2: [r.user, r.line, '片道 ' + yen(r.fare || 0)].filter(Boolean).join('・'), right: '›', onclick: go2 });
      case 'lineDest': return row({ icon: r.enabled && r.lineId ? '✅' : '⬜️', t1: r.id, t2: r.lineId ? r.lineId.slice(0, 6) + '…' : 'ID未設定', right: '›', onclick: go2 });
      default: return row({ t1: r.name || r.id, right: '›', onclick: go2 });
    }
  }

  /* ---------- 1行の編集（表の形から自動で作る） ---------- */
  const HIDE = {
    wallets: (f, v) => (f.only === 'card' && v.kind !== 'カード') || (f.only === 'account' && v.kind === 'カード') || f.k === 'openingAt',
    tx: (f, v) => (f.k === 'from' && (v.type === '収入' || v.type === '残高合わせ')) || (f.k === 'to' && v.type === '支出') || (f.k === 'category' && (v.type === '振替' || v.type === '残高合わせ')) || f.k === 'created' || f.k === 'ref' ||
      ((f.k === 'famt' || f.k === 'fx') && !v.cur) || f.k === 'fxAt' || f.k === 'rcpt' || (f.k === 'cur' && v.type === '残高合わせ'),
    allocs: (f, v) => f.k === 'category' && !!v.to,
    plans: (f, v) => (f.k === 'every' && v.kind !== '年間') || (f.k === 'reserve' && v.kind !== '年間') || (f.k === 'inBudget' && (v.kind === '収入' || v.kind === '振替')) ||
      (f.k === 'to' && v.kind !== '振替') || (f.k === 'category' && v.kind === '振替')
  };
  const FIELD_LABEL = {
    tx: { from: (v) => v.type === '振替' ? '移す元' : '支払い元', to: (v) => v.type === '振替' ? '移す先' : '入金先・口座', cur: () => '通貨（空＝円。ドルで払ったものは USD）' },
    plans: { wallet: (v) => v.kind === '収入' ? '入金先' : v.kind === '振替' ? '移す元' : '支払い元（口座・カード）', to: () => '移す先' }
  };

  function editPage(main, p) {
    const m = model();
    const sc = E.SCHEMA[p.table];
    const isNew = !p.id;
    const cur = isNew ? null : rowOf(p.table, p.id);
    if (!isNew && !cur) { main.appendChild(card(null, empty('見つかりません（削除された可能性があります）'))); return; }
    setTitle((isNew ? '追加：' : '編集：') + sc.label);
    const v = {};
    sc.fields.forEach((f) => { v[f.k] = cur ? cur[f.k] : (p.preset && p.preset[f.k] !== undefined ? p.preset[f.k] : (f.def !== undefined ? f.def : '')); });
    if (isNew) v.id = rid(sc.prefix || 'r');
    if (isNew && p.table === 'tx') { v.date = m.today; v.user = S.user; v.created = nowStr(); }
    const orig = JSON.stringify(v);
    const form = h('div', { class: 'form' });
    const err = h('p', { class: 'err' });
    const inputs = {};

    const draw = () => {
      clear(form);
      if (p.table === 'wallets' && v.kind !== 'カード') form.appendChild(h('p', { class: 'note' }, '開始残高は「今」の残高です。入れた日時より後の記録で、残高を計算します。'));
      if (p.table === 'tx' && v.ref) form.appendChild(h('p', { class: 'note' }, '予定（固定費・年間・ボーナス配分など）から記録したものです。削除すると、予定は「未記録」に戻ります。'));
      if (p.table === 'tx' && v.cur === 'USD') form.appendChild(h('p', { class: 'note' }, 'ドルで入れた記録です' + (v.fxAt ? '（レート：' + (v.fxAt === '手入力' ? '手入力' : v.fxAt + ' 時点') + '）' : '') + '。ドルの金額かレートを変えると、円の金額を計算し直します。カードの請求額に合わせたいときは、円の金額だけを直してください。'));
      // 振替の予定は「移す元」のすぐ下に「移す先」を出す
      const fields = sc.fields.slice();
      if (p.table === 'plans') { const ti = fields.findIndex((f) => f.k === 'to'); const tf = fields.splice(ti, 1)[0]; fields.splice(fields.findIndex((f) => f.k === 'wallet') + 1, 0, tf); }
      fields.forEach((f) => {
        if (f.type === 'id' && !f.ro) return;
        if (HIDE[p.table] && HIDE[p.table](f, v)) return;
        const lab = FIELD_LABEL[p.table] && FIELD_LABEL[p.table][f.k] ? FIELD_LABEL[p.table][f.k](v) : f.label;
        if (f.ro || (f.type === 'id')) { form.appendChild(fieldWrap(lab, h('div', { class: 'ro' }, String(v[f.k] === '' ? '—' : v[f.k])))); return; }
        const el = fieldInput(f, v[f.k], v, p.table, m);
        el.addEventListener('change', () => {
          v[f.k] = readInput(f, el);
          if (p.table === 'tx' && (f.k === 'famt' || f.k === 'fx') && v.cur) {
            const y = E.fxYen(v.famt, v.fx);
            if (y) { v.amount = y; if (inputs.amount) inputs.amount.value = y.toLocaleString('ja-JP'); }
            if (f.k === 'fx') v.fxAt = '手入力';
          }
          if (['kind', 'type', 'to', 'cur'].indexOf(f.k) >= 0) draw();
        });
        el.addEventListener('input', () => { v[f.k] = readInput(f, el); });
        inputs[f.k] = el;
        form.appendChild(f.type === 'bool' ? h('label', { class: 'check' }, el, h('span', null, lab)) : fieldWrap(lab + (f.req ? '（必須）' : ''), el));
      });
    };
    draw();

    const save = () => {
      err.textContent = '';
      try {
        const out = Object.assign({}, cur ? stripMeta(cur) : {}, v);
        if (p.table === 'wallets' && out.kind !== 'カード' && String(out.opening) !== String(cur ? cur.opening : '')) out.openingAt = out.opening === '' ? '' : nowStr();
        if (p.table === 'wallets' && out.kind === 'カード') { out.opening = ''; out.openingAt = ''; }
        if (p.table === 'tx') {
          if (out.type === '支出') out.to = ''; if (out.type === '収入') out.from = ''; if (out.type === '振替' || out.type === '残高合わせ') out.category = '';
          if (out.type === '残高合わせ') out.from = '';
        }
        if (p.table === 'allocs' && out.to) out.category = '';
        if (p.table === 'todos' && out.done !== (cur ? cur.done === true : false)) out.doneAt = out.done ? nowStr() : '';
        if (p.table === 'plans') { if (out.kind !== '振替') out.to = ''; else out.category = ''; }
        put(p.table, out);
        R.guard = null;
        toast(isNew ? '追加しました' : '保存しました');
        back();
        return true;
      } catch (e) { err.textContent = e.message; toast(e.message, { error: true }); return false; }
    };
    R.guard = { form: true, dirty: () => JSON.stringify(v) !== orig, save: save };

    const receiptCard = p.table === 'tx' && cur && cur.rcpt ? (() => {
      const all = (data().items || []).filter((it) => it.rcpt === cur.rcpt);
      if (!all.length) return null;
      const mine = all.filter((it) => it.tx === cur.id), other = all.filter((it) => it.tx !== cur.id);
      const sib = (data().tx || []).filter((t) => t.rcpt === cur.rcpt && t.id !== cur.id);
      const itRow = (it) => { const c = catOf(it.category); return row({ icon: c ? c.icon : '・', t1: it.name, t2: (c ? c.name : '分類なし') + (it.reduced ? '・8%' : ''), right: amountEl(-(Number(it.price) || 0)),
        onclick: () => push('edit', { table: 'items', id: it.id }) }); };
      return card('レシートの内訳（' + all.length + '品目）',
        mine.length ? mine.map(itRow) : null,
        h('p', { class: 'note' }, 'レシートに印字された金額です。合計との差（税・値引き）は、記録の金額に含めています。品目を押すと分類を直せます（期間集計の分け方に反映されます）。'),
        sib.length ? h('details', { class: 'raw' }, h('summary', null, '同じレシートのほかの記録（' + sib.length + '件）・品目（' + other.length + '件）'),
          sib.map((t) => txRow(t)), other.map(itRow)) : null);
    })() : null;
    main.appendChild(card(null, form, err,
      h('div', { class: 'form-acts' },
        h('button', { type: 'button', onclick: back }, 'キャンセル'),
        !isNew && !sc.fixedRows ? h('button', { type: 'button', class: 'danger', onclick: async () => {
          const why = deleteBlock(p.table, p.id);
          if (why) { await ask('削除できません', why, [{ v: 1, label: 'わかった' }]); return; }
          if (!(await confirmDel('「' + (cur.name || cur.item || cur.memo || md(cur.date) || '') + '」を削除します。'))) return;
          const old = stripMeta(cur);
          const oldItems = p.table === 'tx' ? (data().items || []).filter((it) => it.tx === p.id).map(stripMeta) : [];
          if (oldItems.length) learnItems(oldItems);   // 振り分けた内容は、読み取りルールに残す
          del(p.table, p.id); oldItems.forEach((it) => del('items', it.id));
          R.guard = null; toast('削除しました' + (oldItems.length ? '（品目 ' + oldItems.length + '件も）' : ''), { undo: () => { put(p.table, old); oldItems.forEach((it) => put('items', it)); toast('元に戻しました'); } }); back();
        } }, '削除') : null,
        h('button', { type: 'button', class: 'primary', onclick: save }, '保存'))));
    if (receiptCard) main.appendChild(receiptCard);
  }

  function deleteBlock(table, id) {
    const r = E.refsTo(data(), table, id);
    if (!r.count) return '';
    if (table === 'wallets' || table === 'categories') return 'ほかのデータで使われています（' + r.where.join('・') + '）。削除すると、それらのつながりが切れます。削除せず「使っている」のチェックを外してください（一覧や入力に出なくなります）。';
    if (table === 'bonuses') return '配分が ' + r.count + ' 件あります。先に配分を削除してください。';
    return '';
  }
  const stripMeta = (r) => { const o = Object.assign({}, r); delete o._at; delete o._by; delete o._pending; return o; };

  function fieldWrap(label, el) { return h('label', { class: 'field' }, h('span', { class: 'flabel' }, label), el); }
  function walletSelect(list, value) {
    return h('select', null, h('option', { value: '' }, '（選ぶ）'), list.map((w) => h('option', { value: w.id, selected: w.id === value ? 'selected' : null }, kindIcon(w.kind) + ' ' + w.name)));
  }
  function fieldInput(f, val, v, table, m) {
    const s = val === null || val === undefined ? '' : String(val);
    switch (f.type) {
      case 'bool': return h('input', { type: 'checkbox', checked: val === true });
      case 'select': return h('select', null, (f.req ? [] : [h('option', { value: '' }, '（なし）')]).concat(f.opts.filter((o) => o !== '' || !f.req).filter((o) => o !== '').map((o) => h('option', { value: o, selected: o === s ? 'selected' : null }, o))));
      case 'ref': {
        let list = [];
        if (f.ref === 'wallets') {
          list = m.walletsAll.filter((w) => (w.active !== false || w.id === s) && (f.refKind === 'account' ? E.isAccount(w) : f.refKind === 'card' ? E.isCard(w) : true));
          if (table === 'tx' && f.k === 'to' && v.type === '収入') list = list.filter(E.isAccount);
          if (table === 'tx' && f.k === 'to' && v.type === '残高合わせ') list = list.filter(E.isAccount);
          if (table === 'wallets') list = list.filter((w) => w.id !== v.id);
          return h('select', null, h('option', { value: '' }, '（なし）'), list.map((w) => h('option', { value: w.id, selected: w.id === s ? 'selected' : null }, kindIcon(w.kind) + ' ' + w.name + (w.active === false ? '（使っていない）' : ''))));
        }
        if (f.ref === 'categories') {
          const kind = table === 'tx' ? (v.type === '収入' ? '収入' : '支出') : table === 'plans' ? (v.kind === '収入' ? '収入' : '支出') : '支出';
          list = m.categoriesAll.filter((c) => c.kind === kind && (c.active !== false || c.id === s));
          return h('select', null, h('option', { value: '' }, '（なし）'), list.map((c) => h('option', { value: c.id, selected: c.id === s ? 'selected' : null }, (c.icon || '') + ' ' + c.name)));
        }
        if (f.ref === 'bonuses') return h('select', null, m.bonuses.map((b) => h('option', { value: b.id, selected: b.id === s ? 'selected' : null }, b.name)));
        return h('input', { type: 'text', value: s });
      }
      case 'date': return h('input', { type: 'date', value: s });
      case 'month': return h('input', { type: 'month', value: s, placeholder: '2029-08' });
      case 'longtext': return h('textarea', { rows: '3', maxlength: '1000' }, s);
      case 'int': case 'sint': return h('input', { type: 'text', inputmode: f.type === 'sint' ? 'text' : 'numeric', value: s === '' ? '' : Number(s).toLocaleString('ja-JP'), autocomplete: 'off' });
      case 'dec': return h('input', { type: 'text', inputmode: 'decimal', value: s, autocomplete: 'off' });
      case 'day': return h('input', { type: 'text', inputmode: 'numeric', value: s, placeholder: '1〜31' });
      case 'close': return h('input', { type: 'text', value: s, placeholder: '5 または 末' });
      case 'months': return h('input', { type: 'text', value: s, placeholder: '例 6,12（空欄は毎月）' });
      case 'lineId': return h('input', { type: 'text', value: s, placeholder: 'U… または C…', autocomplete: 'off', spellcheck: 'false' });
      default: return h('input', { type: 'text', value: s, maxlength: '200' });
    }
  }
  function readInput(f, el) {
    if (f.type === 'bool') return el.checked;
    if (f.type === 'int' || f.type === 'sint') { const t = el.value.replace(/[,，円¥\s]/g, '').replace(/^−/, '-'); return t === '' ? '' : (isFinite(Number(t)) ? Number(t) : el.value); }
    if (f.type === 'dec') { const t = el.value.replace(/[,，円¥$＄\s]/g, ''); return t === '' ? '' : (isFinite(Number(t)) ? Number(t) : el.value); }
    return el.value;
  }
  function num(s, signed, soft) {
    const t = String(s).replace(/[,，円¥\s]/g, '').replace(/^−/, '-');
    if (t === '' && soft) return null;
    const n = Number(t);
    if (t === '' || !isFinite(n) || (!signed && n < 0)) { if (soft) return null; throw new Error('金額を数字で入れてください。'); }
    return Math.round(n);
  }

  /* ---------- 開始残高（まとめて入れる） ---------- */
  function openingPage(main) {
    const m = model();
    setTitle('開始残高');
    main.appendChild(h('p', { class: 'note pad' }, '各口座の「今」の残高を入れます。通帳・銀行アプリ・財布の中身を見ながら入れてください。入れた日時より後の記録とカードの引き落としで、残高を自動で計算します。'));
    const inputs = {};
    const accts = m.walletsAll.filter((w) => E.isAccount(w) && w.active !== false);
    main.appendChild(card(null, accts.map((w) => {
      const el = h('input', { type: 'text', inputmode: 'numeric', value: w.opening === '' ? '' : Number(w.opening).toLocaleString('ja-JP'), placeholder: '未入力', class: 'num-input' });
      inputs[w.id] = el;
      return h('label', { class: 'field inline' }, h('span', { class: 'flabel' }, kindIcon(w.kind) + ' ' + w.name, w.openingAt ? h('small', null, '（' + w.openingAt.slice(5, 16).replace('-', '/') + ' 入力）') : null), el);
    })));
    const orig = {}; accts.forEach((w) => { orig[w.id] = inputs[w.id].value; });
    const save = () => {
      let n = 0;
      try {
        accts.forEach((w) => {
          const t = inputs[w.id].value;
          if (t === orig[w.id] || t.trim() === '') return;
          put('wallets', Object.assign({}, stripMeta(w), { opening: num(t, true), openingAt: nowStr() })); n++;
        });
      } catch (e) { toast(e.message, { error: true }); return false; }
      R.guard = null;
      toast(n ? n + '件の開始残高を保存しました' : '変更はありません');
      back();
      return true;
    };
    R.guard = { form: true, dirty: () => accts.some((w) => inputs[w.id].value !== orig[w.id]), save: save };
    main.appendChild(h('div', { class: 'form-acts pad' }, h('button', { type: 'button', onclick: back }, 'キャンセル'), h('button', { type: 'button', class: 'primary', onclick: save }, '保存')));
    main.appendChild(h('p', { class: 'note pad' }, '次に「管理 > カードの請求」で、これから引き落とされる請求額を確定してください（開始前に使った分は記録にないため）。'));
  }

  function billsPage(main) {
    const m = model();
    setTitle('カードの請求');
    const proj = E.projection(m, 100);
    // これからの請求と、引き落とし日が今日・最近（45日以内）で、まだ確定していない請求
    const all = Object.keys(proj.bills).map((k) => proj.bills[k]).filter((b) => b.debitDate >= m.today || b.status === '引き落とし不可' || (!b.confirmed && E.diffDays(b.debitDate, m.today) <= 45))
      .sort((a, b) => a.debitDate.localeCompare(b.debitDate));
    main.appendChild(h('p', { class: 'note pad' }, 'カード会社の明細で金額が決まったら、押して「消し込み」をします。その請求に入る固定費などの予定を、まとめて記録できます。'));
    main.appendChild(card(null, all.length ? all.map((b) => row({ icon: '💳', t1: b.cardName + '・' + md(b.debitDate), tag: b.status === '引き落とし不可' ? '引き落とし不可' : b.confirmed ? '確定' : '見込み', tagCls: b.status === '引き落とし不可' ? 'high' : b.confirmed ? '' : 'mid',
      t2: '記録 ' + yen(b.used) + (b.planned ? '・予定 ' + yen(b.planned) : '') + '・' + (walletName(b.payFrom) || '引き落とし口座未設定'), right: amountEl(b.amount, b.confirmed ? '' : 'est'),
      onclick: () => push('bill', { card: b.card, ym: b.ym }) })) : empty('これからの請求はありません')));
  }

  /* ---------- 表示の設定 ---------- */
  function displayPage(main) {
    setTitle('表示の設定');
    const set = (k, val) => { UI[k] = val; saveUI(); refresh(); };
    const slider = h('input', { type: 'range', min: '80', max: '160', step: '5', value: String(UI.scale), oninput: (e) => { UI.scale = Number(e.target.value); applyUI(); lbl.textContent = UI.scale + '%'; }, onchange: () => saveUI() });
    const lbl = h('span', { class: 'tag' }, UI.scale + '%');
    main.appendChild(card('文字の大きさ', h('div', { class: 'slider' }, h('span', { class: 'a-small' }, 'あ'), slider, h('span', { class: 'a-big' }, 'あ'), lbl),
      h('div', { class: 'chips' }, [90, 100, 115, 130, 150].map((v) => h('button', { type: 'button', class: 'chip' + (UI.scale === v ? ' on' : ''), onclick: () => set('scale', v) }, v + '%')))));
    main.appendChild(card('画面の色', seg([['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']], UI.theme, (v) => set('theme', v)),
      h('div', { class: 'swatches' }, [['pink', 'ピンク'], ['green', '緑'], ['blue', '青'], ['purple', '紫'], ['orange', '橙'], ['gray', '灰']].map(([k, l]) => h('button', { type: 'button', class: 'swatch sw-' + k + (UI.accent === k ? ' on' : ''), 'aria-label': l, onclick: () => set('accent', k) }, l)))));
    main.appendChild(card('表示の詰め具合', seg([['roomy', 'ゆったり'], ['normal', '標準'], ['compact', 'コンパクト']], UI.density, (v) => set('density', v))));
    main.appendChild(card('金額の書き方', seg([['suffix', '1,234円'], ['prefix', '¥1,234']], UI.yen, (v) => set('yen', v)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: UI.mask, onchange: (e) => set('mask', e.target.checked) }), h('span', null, '残高を隠す（人前で開くとき。ホームの「隠す」と同じ）'))));
    main.appendChild(card('入力', h('div', { class: 'flabel' }, '数字キーの並び'), seg([['calc', '電卓式（7 8 9 が上）'], ['phone', '電話式（1 2 3 が上）']], UI.keypad, (v) => set('keypad', v)),
      h('div', { class: 'flabel' }, '登録したあと'), seg([['stay', '入力画面のまま'], ['home', 'ホームに戻る']], UI.afterSave, (v) => set('afterSave', v))));
    main.appendChild(card('開いたとき', seg([['home', 'ホーム'], ['input', '入力']], UI.start, (v) => set('start', v)),
      h('div', { class: 'flabel' }, '予定の見通し'), seg([[31, '1か月'], [62, '2か月'], [93, '3か月']], UI.days, (v) => set('days', v)),
      h('div', { class: 'flabel' }, '入力履歴の並び'), seg([['new', '新しい順'], ['old', '古い順']], UI.listOrder, (v) => set('listOrder', v))));
    const homeBox = h('div');
    const drawHome = () => {
      clear(homeBox);
      const order = UI.home.concat(HOME_SECTIONS.map((s) => s[0]).filter((k) => UI.home.indexOf(k) < 0));
      order.forEach((k, i) => {
        const on = UI.home.indexOf(k) >= 0;
        const label = (HOME_SECTIONS.find((s) => s[0] === k) || [k, k])[1];
        const move = (d) => { const arr = UI.home.slice(); const j = arr.indexOf(k); if (j < 0) return; const t = j + d; if (t < 0 || t >= arr.length) return; arr.splice(j, 1); arr.splice(t, 0, k); UI.home = arr; saveUI(); drawHome(); };
        homeBox.appendChild(h('div', { class: 'row' }, h('label', { class: 'check grow' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => { UI.home = e.target.checked ? UI.home.concat([k]) : UI.home.filter((x) => x !== k); saveUI(); drawHome(); } }), h('span', null, label)),
          on ? h('span', { class: 'updown' }, h('button', { type: 'button', 'aria-label': '上へ', onclick: () => move(-1) }, '↑'), h('button', { type: 'button', 'aria-label': '下へ', onclick: () => move(1) }, '↓')) : null));
      });
    };
    drawHome();
    main.appendChild(card('ホームに出す項目と順番', homeBox));
    const qBox = h('div');
    const drawQ = () => {
      clear(qBox);
      const order = UI.quick.concat(QUICK.map((q) => q[0]).filter((k) => UI.quick.indexOf(k) < 0));
      order.forEach((k) => {
        const q = QUICK.find((x) => x[0] === k); if (!q) return;
        const on = UI.quick.indexOf(k) >= 0;
        const move = (d) => { const arr = UI.quick.slice(); const j = arr.indexOf(k); const t = j + d; if (j < 0 || t < 0 || t >= arr.length) return; arr.splice(j, 1); arr.splice(t, 0, k); UI.quick = arr; saveUI(); drawQ(); };
        qBox.appendChild(h('div', { class: 'row' }, h('label', { class: 'check grow' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => { UI.quick = e.target.checked ? UI.quick.concat([k]) : UI.quick.filter((x) => x !== k); saveUI(); drawQ(); } }), h('span', null, q[1] + ' ' + q[2])),
          on ? h('span', { class: 'updown' }, h('button', { type: 'button', 'aria-label': '上へ', onclick: () => move(-1) }, '↑'), h('button', { type: 'button', 'aria-label': '下へ', onclick: () => move(1) }, '↓')) : null));
      });
    };
    drawQ();
    main.appendChild(card('入力のショートカット（ホームのいちばん上）', qBox, h('p', { class: 'note' }, '押すと、その種類で入力画面が開きます。レシートはすぐにカメラ・写真が開きます。')));
    main.appendChild(card('動き', h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: UI.motion, onchange: (e) => set('motion', e.target.checked) }), h('span', null, '画面の動き（アニメーション）を使う'))));
    main.appendChild(h('button', { type: 'button', class: 'link center', onclick: () => { UI = Object.assign({}, UI_DEF); saveUI(); refresh(); toast('表示の設定を元に戻しました'); } }, '表示の設定を元に戻す'));
  }

  /* ---------- 保存と同期 ---------- */
  function syncPage(main) {
    setTitle('保存と同期');
    main.appendChild(card('状態',
      h('div', { class: 'bd' }, h('span', null, '最後に同期した時刻'), h('span', null, S.lastSync ? new Date(S.lastSync).toLocaleString('ja-JP') : 'まだ')),
      h('div', { class: 'bd' }, h('span', null, 'まだ送っていない変更'), h('span', null, S.ops.length + '件')),
      h('div', { class: 'bd' }, h('span', null, 'データの版'), h('span', null, String(S.rev))),
      S.error ? h('p', { class: 'err' }, '前回の通信：' + S.error) : null,
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'primary', onclick: async () => { await flush(); toast(S.error ? '送れませんでした：' + S.error : '最新にしました'); refresh(); } }, '今すぐ同期'),
        h('button', { type: 'button', onclick: async () => { S.forceFull = true; await flush(); if (S.inflight) await S.inflight; toast(S.error ? '読み直せませんでした' : 'スプレッドシートから読み直しました'); refresh(); } }, '全部読み直す'))));
    main.appendChild(card('しくみ', h('p', { class: 'note' },
      '入力・変更は、押した瞬間にこの端末に保存され（暗号化）、画面にすぐ出ます。同時に裏でスプレッドシートへ送ります。電波が悪くても失われず、つながったときに自動で送ります。右上の表示で状態がわかります：「保存済み」＝スプレッドシートまで保存済み、「保存待ち」「保存中」＝送信中、「未送信」＝送れていない（自動で再送します）。')));
    if (S.ops.length) main.appendChild(card('まだ送っていない変更', S.ops.map((o) => row({ t1: (o.t === 'del' ? '削除：' : '保存：') + E.SCHEMA[o.table].label, t2: o.t === 'del' ? o.rid : (o.row.name || o.row.memo || o.row.item || o.row.id) }))));
  }

  /* ---------- この端末 ---------- */
  function devicePage(main) {
    setTitle('この端末の登録');
    main.appendChild(card(null,
      h('p', null, 'この端末は「' + (S.user || (cfg && cfg.n) || '') + '」として登録されています。'),
      h('p', { class: 'note' }, '家計のデータはGoogleスプレッドシートが正本です。この端末には、すぐ開けるように暗号化した写しを置いています。GitHubにはデータを置きません。'),
      h('button', { type: 'button', class: 'danger wide', onclick: async () => {
        const a = await ask('この端末の登録を解除しますか？', 'この端末に置いた写しと鍵を消します。スプレッドシートのデータは消えません。もう一度使うには登録リンクが必要です。' + (S.ops.length ? '\n※ まだ送っていない変更が ' + S.ops.length + ' 件あります。解除すると失われます。' : ''),
          [{ v: true, label: '解除する', danger: true }, { v: false, label: 'やめる' }]);
        if (!a) return;
        await Vault.wipe(); store.del(CFG_KEY); store.del('kakeibo.pref');
        try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch (e) { /* noop */ }
        location.reload();
      } }, 'この端末の登録を解除する')));
  }

  function notReadyPage(main) {
    main.appendChild(card('スプレッドシートの初期設定がまだです',
      h('p', null, '口座や分類がまだ1件もありません。スプレッドシートを開いて、メニュー「家計簿 > 初期設定（旧データの引き継ぎ）」を実行してください。'),
      h('p', { class: 'note' }, 'メニューが出ないときは、スプレッドシートを開き直してください。実行が終わったら、下のボタンで読み直します。'),
      h('div', { class: 'diag' }, h('div', { class: 'flabel' }, '原因調べ用の情報'),
        h('div', { class: 'bd' }, h('span', null, '画面の版'), h('span', null, VERSION_LABEL + '（' + APP_VERSION + '）')),
        h('div', { class: 'bd' }, h('span', null, 'GASの版'), h('span', null, S.code || '—')),
        h('div', { class: 'bd' }, h('span', null, '受け取ったデータ'), h('span', null, S.got || '—')),
        h('div', { class: 'bd' }, h('span', null, '前回の通信'), h('span', null, S.error || '成功'))),
      S.book ? h('div', { class: 'diag' }, h('div', { class: 'flabel' }, 'このアプリがつながっているスプレッドシート'),
        S.book.error ? h('p', { class: 'err' }, S.book.error) : [
          h('div', { class: 'bd' }, h('span', null, '名前'), h('span', null, S.book.name + '（ID ' + S.book.id + '…）')),
          h('div', { class: 'bd' }, h('span', null, '「口座・カード」シート'), h('span', null, S.book.walletRows === null ? 'ありません' : S.book.walletRows + '行')),
          h('div', { class: 'bd' }, h('span', null, '初期設定'), h('span', null, S.book.setup === 'done' ? '済み' : 'まだ')),
          S.book.missing.length ? h('p', { class: 'note warn' }, 'ない表：' + S.book.missing.join('、')) : null,
          h('p', { class: 'note' }, '名前やIDが、初期設定を実行したスプレッドシートと違う場合は、ウェブアプリが別のスクリプトからデプロイされています。')]) : null,
      h('button', { type: 'button', class: 'save-btn', onclick: async () => { S.forceFull = true; await flush(); if (S.inflight) await S.inflight; toast(S.error ? '読み込めませんでした：' + S.error : '読み直しました'); render(true); } }, '読み直す')));
  }

  const TABS = { home: homePage, input: inputPage, list: listPage, analysis: analysisPage, plan: planPage, manage: managePage };
  /* ================= レシート ================= */
  function fileToJpeg(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          // 文字認識しやすいように：長い辺を最大3000pxにし、白黒にしてコントラストを上げる
          const max = 3000, w = img.naturalWidth, hh = img.naturalHeight, r = Math.min(1, max / Math.max(w, hh));
          const c = document.createElement('canvas');
          c.width = Math.round(w * r); c.height = Math.round(hh * r);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          try {
            const d = g.getImageData(0, 0, c.width, c.height), px = d.data, hist = new Uint32Array(256);
            for (let i = 0; i < px.length; i += 4) { const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; px[i] = y; hist[y]++; }
            const total = px.length / 4; let acc = 0, lo = 0, hi = 255;
            for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
            acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.10) { hi = v; break; } }
            const span = Math.max(1, hi - lo);
            for (let i = 0; i < px.length; i += 4) { const y = Math.max(0, Math.min(255, (px[i] - lo) * 255 / span)); px[i] = px[i + 1] = px[i + 2] = y; }
            g.putImageData(d, 0, 0);
          } catch (e) { /* 加工できなくても、そのまま送る */ }
          res(c.toDataURL('image/jpeg', 0.9).split(',')[1]);
        };
        img.onerror = () => rej(new Error('画像を開けませんでした。JPEGかPNGの写真を選んでください。'));
        img.src = fr.result;
      };
      fr.onerror = () => rej(new Error('画像を読み込めませんでした。'));
      fr.readAsDataURL(file);
    });
  }

  async function readReceipt(file) {
    if (!navigator.onLine) { toast('レシートの読み取りには通信が必要です', { error: true }); return; }
    toast('レシートを読み取っています…（10秒ほど）', { long: true });
    S.mode = 'ocr'; setStatus(); $('#status-text').textContent = '読み取り中…';
    try {
      const image = await fileToJpeg(file);
      const res = await post({ action: 'ocr', image: image });
      const m = model();
      const cats = m.categories.filter((c) => c.kind === '支出');
      const byName = (n) => (cats.find((c) => c.name === n) || {}).id || '';
      const defaults = { food: prefs.rcFood || byName('食費') || (cats[0] || {}).id || '', other: prefs.rcOther || byName('日用品') || byName('食費') || '' };
      const parsed = E.classifyReceipt(E.parseReceipt(res.text || '', m.today), m.data.rules || [], defaults, byName);
      if (!parsed.items.length && !parsed.total) { toast('文字を読み取れませんでした。明るい場所で、レシート全体がまっすぐ入るように撮ってください。', { error: true, long: true }); return; }
      push('receipt', { parsed: parsed, text: res.text || '', defaults: defaults, from: st.from, engine: res.engine || 'drive', used: res.used, limit: res.limit, note: res.note || '' });
      toast('読み取りました。分け方を確かめて登録してください');
    } catch (e) { toast('読み取れませんでした：' + e.message, { error: true, long: true }); }
    finally { S.mode = ''; setStatus(); }
  }

  /**
   * 品目の分類を「読み取りルール」に覚える。いまの自動の分け方と違う品目だけ（手で直した分）。
   * ルールは記録とは別の表なので、あとで記録やレシートを消しても、振り分けた内容は残る。
   * 同じ言葉のルールがあれば、分類を新しいほうに直す（古いルールが勝ってしまわないように）
   */
  function learnItems(items, defaults) {
    const m = model();
    const cats = m.categories.filter((c) => c.kind === '支出');
    const byName = (n) => (cats.find((c) => c.name === n) || {}).id || '';
    const def = defaults || { food: prefs.rcFood || byName('食費') || (cats[0] || {}).id || '', other: prefs.rcOther || byName('日用品') || byName('食費') || '' };
    const list = (items || []).filter((it) => it.category && String(it.name || '').trim());
    if (!list.length) return 0;
    const hasReduced = list.some((it) => it.reduced);
    let n = 0;
    list.forEach((it) => {
      const auto = E.classifyReceipt({ items: [{ name: it.name, price: it.price, reduced: !!it.reduced }], hasReduced: hasReduced }, data().rules || [], def, byName).items[0];
      if (auto.category === it.category) return;   // 自動でも同じ分類になる
      const key = E.normText(it.name).replace(/\d+(ml|mL|ML|g|kg|L|l|個|本|缶|入|枚|R|m)?/g, '').replace(/[\s()（）\[\]×x*]/g, '').slice(0, 15);
      if (key.length < 2) return;
      const same = (data().rules || []).find((r) => r.keyword === key);
      if (same) { if (same.category !== it.category || same.active === false) put('rules', Object.assign({}, stripMeta(same), { category: it.category, active: true })); }
      else put('rules', { id: rid('r'), keyword: key, category: it.category, order: 5, active: true });
      n++;
    });
    return n;
  }

  /* ================= 交通費（乗換案内で運賃を調べて入れる） ================= */
  // 運賃を自動で返す無料のAPIがないため、乗換案内を駅名入りで開き、見た運賃を入れる。区間ごとに覚えて次からは選ぶだけ。
  // 定期区間：定期の駅から外に出る駅（乗り換える駅）を出発駅にして調べれば、定期区間を引いた運賃になる
  const yahooUrl = (a, b) => 'https://transit.yahoo.co.jp/search/result?from=' + encodeURIComponent(a) + '&to=' + encodeURIComponent(b) + '&ticket=ic';
  const googleFareUrl = (a, b) => 'https://www.google.com/search?q=' + encodeURIComponent(a + 'から' + b + ' 運賃 IC');
  const fareMemo = (a, b, round) => '交通費 ' + a + '→' + b + (round ? '（往復）' : '');
  function farePage(main, p) {
    const m = model();
    setTitle('交通費（乗換案内）');
    const me = S.user || (cfg && cfg.n) || '';
    const passes = (data().passes || []).filter((x) => x.user === me);
    const K = E.stationKey;
    // よく使う区間（直近90日の記録の回数順）
    const since = E.addDays(m.today, -90), used = {};
    m.tx.forEach((t) => { if (t.date >= since && t.memo && t.memo.indexOf('交通費 ') === 0) { const k = t.memo.replace(/^交通費 /, '').replace(/（往復）$/, ''); used[k] = (used[k] || 0) + 1; } });
    const routes = (data().routes || []).filter((x) => x.user === me).sort((a, b) => (used[b.from + '→' + b.to] || 0) - (used[a.from + '→' + a.to] || 0));
    if (!p.state) {
      const tate = m.categories.find((c) => c.kind === '支出' && c.group === '立替（あとで戻る）' && /交通/.test(c.name)) || m.categories.find((c) => c.kind === '支出' && c.group === '立替（あとで戻る）');
      p.state = { from: '', to: '', fare: '', round: true, date: st.date || m.today, line: '',
        category: prefs.fareCat || (tate && tate.id) || '', wallet: prefs.fareFrom || prefs.lastFrom || (m.wallets[0] || {}).id || '', remember: true, dirty: false };
    }
    const F = p.state;
    const passSt = [];
    passes.forEach((ps) => E.passStations(ps.route).forEach((x) => { if (!passSt.some((y) => K(y) === K(x))) passSt.push(x); }));
    const inPass = (x) => !!x && passSt.some((y) => K(y) === K(x));

    // 定期券
    main.appendChild(card('定期券（' + me + '）',
      passes.length ? passes.map((ps) => summaryRow('passes', ps, m)) : h('p', { class: 'note' }, '定期券を登録すると、定期の駅がボタンで出ます。定期の外に出る駅から調べれば、定期区間を引いた運賃になります。'),
      h('button', { type: 'button', class: 'link', onclick: () => push('edit', { table: 'passes', id: null, preset: { user: me, name: '通勤定期' } }) }, '＋ 定期券を登録')));

    // よく使う区間
    if (routes.length) main.appendChild(card('よく使う区間（押すと下に入ります）', routes.slice(0, 12).map((r) => row({ icon: '🚃', t1: r.from + ' → ' + r.to,
      t2: [r.line, used[r.from + '→' + r.to] ? '90日で' + used[r.from + '→' + r.to] + '回' : ''].filter(Boolean).join('・'), right: h('span', { class: 'amt' }, '片道 ' + yen(r.fare || 0)),
      onclick: () => { Object.assign(F, { from: r.from, to: r.to, fare: String(r.fare || ''), line: r.line || '', category: r.category || F.category, wallet: r.wallet || F.wallet, dirty: true }); refresh(); } })),
      routes.length > 12 ? h('button', { type: 'button', class: 'link', onclick: () => push('table', { table: 'routes' }) }, 'すべての区間を見る（' + routes.length + '）') : null));

    // 入力
    const total = h('div', { class: 'fare-total' });
    const hint = h('div');
    const yBtn = h('a', { class: 'btn-link primary', target: '_blank', rel: 'noopener noreferrer' }, '🔎 Yahoo!乗換案内で調べる');
    const gBtn = h('a', { class: 'btn-link', target: '_blank', rel: 'noopener noreferrer' }, 'Googleで調べる');
    const upd = () => {
      const ok = F.from.trim() && F.to.trim();
      [yBtn, gBtn].forEach((a) => a.classList.toggle('off', !ok));
      if (ok) { yBtn.href = yahooUrl(F.from.trim(), F.to.trim()); gBtn.href = googleFareUrl(F.from.trim(), F.to.trim()); } else { yBtn.removeAttribute('href'); gBtn.removeAttribute('href'); }
      const f = Number(String(F.fare).replace(/[,円\s]/g, '')) || 0;
      total.textContent = f ? (F.round ? '往復 ' + yen(f * 2) + '（片道 ' + yen(f) + ' × 2）' : '片道 ' + yen(f)) : '';
      clear(hint);
      const a = inPass(F.from), b = inPass(F.to);
      if (a && b) hint.appendChild(h('p', { class: 'note warn' }, '出発駅も到着駅も定期の区間の駅です。定期区間の中だけの移動なら、運賃はかかりません。'));
      else if (a) hint.appendChild(h('p', { class: 'note' }, '🎫「' + F.from + '」は定期の区間の駅です。ここまで定期で来て、ここから先を払うなら、このまま調べてください。定期の途中の駅なら、定期の外に出る駅（乗り換える駅）に変えると、定期区間を引いた運賃になります。'));
      else if (b) hint.appendChild(h('p', { class: 'note' }, '🎫「' + F.to + '」は定期の区間の駅です。ここから先は定期で乗るなら、このまま調べてください。定期の途中の駅なら、定期の区間に入る駅（乗り換える駅）に変えると、定期区間を引いた運賃になります。'));
      const exp = passes.filter((ps) => (ps.end && F.date > ps.end) || (ps.start && F.date < ps.start));
      if (exp.length) hint.appendChild(h('p', { class: 'note warn' }, exp.map((ps) => ps.name).join('・') + ' は ' + md(F.date) + ' に使えない期間です（期限 ' + (exp[0].end || '?') + '）。定期を使わない運賃で調べてください。'));
    };
    const stInput = (key, ph) => h('input', { type: 'text', class: 'station', placeholder: ph, value: F[key], autocomplete: 'off', enterkeyhint: 'next',
      oninput: (e) => { F[key] = e.target.value; F.dirty = true; upd(); } });
    const fromI = stInput('from', '出発駅（例 横浜）'), toI = stInput('to', '到着駅（例 藤沢）');
    const passChips = (key, label) => passSt.length ? h('div', { class: 'chips scroll' }, h('span', { class: 'flabel inline' }, label),
      passSt.map((x) => h('button', { type: 'button', class: 'chip' + (K(F[key]) === K(x) ? ' on' : ''), onclick: () => { F[key] = x; F.dirty = true; refresh(); } }, '🎫 ' + x))) : null;
    const fareI = h('input', { type: 'text', inputmode: 'numeric', class: 'fare-input', placeholder: '例 410', value: F.fare, autocomplete: 'off',
      oninput: (e) => { F.fare = e.target.value; F.dirty = true; upd(); } });
    const dates = [[m.today, '今日'], [E.addDays(m.today, -1), '昨日'], [E.addDays(m.today, -2), 'おととい']];
    const picker = h('input', { type: 'date', class: 'date-pick', value: F.date, 'aria-label': '日付を選ぶ', onchange: (e) => { if (e.target.value) { F.date = e.target.value; refresh(); } } });
    const exCats = m.categories.filter((c) => c.kind === '支出');
    const catSel = h('select', { onchange: (e) => { F.category = e.target.value; } }, exCats.map((c) => h('option', { value: c.id, selected: c.id === F.category ? 'selected' : null }, (c.icon || '') + ' ' + c.name)));
    const walSel = walletSelect(m.wallets, F.wallet); walSel.addEventListener('change', (e) => { F.wallet = e.target.value; });

    main.appendChild(card('区間と運賃',
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, '出発駅'), fromI, passChips('from', '定期の駅から：')),
      h('div', { class: 'swap-row' }, h('button', { type: 'button', class: 'chip', onclick: () => { const x = F.from; F.from = F.to; F.to = x; refresh(); } }, '⇅ 入れかえ')),
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, '到着駅'), toI, passChips('to', '定期の駅まで：')),
      hint,
      h('div', { class: 'fare-links' }, yBtn, gBtn),
      h('p', { class: 'note' }, '乗換案内でIC運賃（片道）を見て、下に入れてください。Yahoo!乗換案内アプリに定期券を登録してあれば、定期区間を引いた運賃も出ます。'),
      h('div', { class: 'field' }, h('div', { class: 'flabel' }, '片道の運賃（円）'), fareI),
      seg([['one', '片道'], ['round', '往復']], F.round ? 'round' : 'one', (v) => { F.round = v === 'round'; upd(); refresh(); }),
      total,
      h('div', { class: 'chips' }, dates.map(([d, l]) => h('button', { type: 'button', class: 'chip' + (F.date === d ? ' on' : ''), onclick: () => { F.date = d; refresh(); } }, l)),
        h('label', { class: 'chip' + (dates.some(([d]) => d === F.date) ? '' : ' on') }, dates.some(([d]) => d === F.date) ? '📅 日付' : '📅 ' + mdw(F.date), picker)),
      fieldWrap('分類', catSel),
      fieldWrap('支払い', walSel),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: F.remember, onchange: (e) => { F.remember = e.target.checked; } }), h('span', null, 'この区間と運賃を覚える（次から上の一覧で選べます）'))));
    upd();

    const save = () => {
      try {
        const from = F.from.trim(), to = F.to.trim();
        const fare = Number(String(F.fare).replace(/[,円\s]/g, ''));
        if (!from || !to) throw new Error('出発駅と到着駅を入れてください。');
        if (!(fare > 0) || fare !== Math.floor(fare)) throw new Error('片道の運賃を入れてください。');
        if (!F.wallet) throw new Error('支払いを選んでください。');
        const c = catOf(F.category);
        const t = { id: rid('t'), date: F.date || m.today, type: '支出', amount: fare * (F.round ? 2 : 1), category: F.category, from: F.wallet, to: '', memo: fareMemo(from, to, F.round),
          user: me, settle: c && c.group === '立替（あとで戻る）' ? '未精算' : '', ref: '', created: nowStr() };
        put('tx', t);
        if (F.remember) {
          const old = (data().routes || []).find((r) => r.user === me && K(r.from) === K(from) && K(r.to) === K(to));
          put('routes', Object.assign({}, old ? stripMeta(old) : { id: rid('rt'), user: me, from: from, to: to }, { fare: fare, category: F.category, wallet: F.wallet, line: F.line || (old && old.line) || '' }));
        }
        prefs.fareCat = F.category; prefs.fareFrom = F.wallet; savePrefs();
        R.guard = null;
        toast(t.memo + ' ' + yen(t.amount) + ' を登録しました' + (t.settle ? '（未精算）' : ''), { undo: () => { del('tx', t.id); toast('取り消しました'); } });
        back();
        return true;
      } catch (e) { toast(e.message, { error: true }); return false; }
    };
    R.guard = { form: true, dirty: () => F.dirty && !!(F.fare || F.from || F.to), save: save, title: '交通費をまだ登録していません', saveLabel: '登録する' };
    main.appendChild(h('div', { class: 'form-acts pad' },
      h('button', { type: 'button', onclick: back }, 'やめる'),
      h('button', { type: 'button', onclick: () => push('table', { table: 'routes' }) }, '区間の一覧'),
      h('button', { type: 'button', class: 'primary', onclick: save }, '登録する')));
  }

  function receiptPage(main, p) {
    const m = model();
    setTitle('レシートの読み取り');
    const pr = p.parsed;
    if (!p.state) {
      p.state = { store: pr.store, date: pr.date || m.today, total: pr.total || '', from: p.from || prefs.lastFrom || (m.wallets[0] || {}).id || '', learn: true,
        items: pr.items.map((it) => ({ name: it.name, price: it.price, category: it.category, auto: it.category, reduced: it.reduced })), dirty: false };
    }
    const S2 = p.state;
    const cats = m.categories.filter((c) => c.kind === '支出');
    const catSel = (val, on) => h('select', { class: 'cat-sel', onchange: (e) => on(e.target.value) }, cats.map((c) => h('option', { value: c.id, selected: c.id === val ? 'selected' : null }, (c.icon || '') + ' ' + c.name)));
    const mark = () => { S2.dirty = true; drawSum(); };

    // 店・日付・合計・支払い
    const store = h('input', { type: 'text', value: S2.store, placeholder: '店名', oninput: (e) => { S2.store = e.target.value; S2.dirty = true; } });
    const date = h('input', { type: 'date', value: S2.date, onchange: (e) => { S2.date = e.target.value; S2.dirty = true; } });
    const total = h('input', { type: 'text', inputmode: 'numeric', class: 'num-input', value: S2.total === '' ? '' : Number(S2.total).toLocaleString('ja-JP'), oninput: (e) => { const v = e.target.value.replace(/[,円¥\s]/g, ''); S2.total = v === '' ? '' : Number(v) || ''; mark(); } });
    const wsel = walletSelect(m.wallets, S2.from); wsel.addEventListener('change', () => { S2.from = wsel.value; S2.dirty = true; });
    const cands = (pr.candidates || []).filter((c) => c.value !== pr.total || pr.candidates.length > 1);
    const candBox = cands.length > 1 ? h('div', null, h('div', { class: 'flabel' }, '合計の候補（違っていたら押して選ぶ）'),
      h('div', { class: 'chips' }, cands.map((c) => h('button', { type: 'button', class: 'chip' + (Number(S2.total) === c.value ? ' on' : ''), title: c.why.join('・'),
        onclick: (e) => { S2.total = c.value; total.value = c.value.toLocaleString('ja-JP'); candBox.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); mark(); } },
        yen(c.value) + '（' + c.why[0] + '）')))) : null;
    main.appendChild(card(null, fieldWrap('店名（メモになります）', store), h('div', { class: 'grid2' }, fieldWrap('日付', date), fieldWrap('レシートの合計（円）', total)), candBox, fieldWrap('支払い', wsel),
      !pr.total ? h('p', { class: 'note warn' }, '合計を読み取れませんでした。レシートの合計を入れてください（空欄なら品目の合計を使います）。') : null,
      h('p', { class: 'note' + (p.note ? ' warn' : '') }, p.engine === 'vision' ? '読み取り：Cloud Vision（今月 ' + p.used + '／上限 ' + p.limit + '回）' : (p.note || '読み取り：Googleドライブ'))));

    // 品目
    const list = h('div');
    const drawItems = () => {
      clear(list);
      S2.items.forEach((it, i) => {
        const name = h('input', { type: 'text', value: it.name, class: 'item-name', oninput: (e) => { it.name = e.target.value; S2.dirty = true; } });
        const price = h('input', { type: 'text', inputmode: 'numeric', class: 'item-price', value: String(it.price), oninput: (e) => { it.price = Number(e.target.value.replace(/[,円¥\s]/g, '').replace(/^−/, '-')) || 0; mark(); } });
        list.appendChild(h('div', { class: 'item-row' + (it.category !== it.auto ? ' changed' : '') },
          h('div', { class: 'item-top' }, name, price, h('button', { type: 'button', class: 'x', 'aria-label': 'この品目を消す', onclick: () => { S2.items.splice(i, 1); drawItems(); mark(); } }, '×')),
          h('div', { class: 'item-bot' }, catSel(it.category, (v) => { it.category = v; drawItems(); mark(); }), it.reduced ? h('span', { class: 'tag' }, '軽減税率') : null)));
      });
      if (!S2.items.length) list.appendChild(empty('品目を読み取れませんでした。下の「＋品目を足す」で入れるか、まとめて1件で登録してください。'));
    };
    drawItems();
    main.appendChild(card('品目（' + pr.items.length + '件を読み取り）', list,
      h('button', { type: 'button', class: 'link', onclick: () => { S2.items.push({ name: '', price: 0, category: p.defaults.food, auto: p.defaults.food }); drawItems(); mark(); } }, '＋ 品目を足す')));

    // 登録される内容
    const sum = h('div');
    const drawSum = () => {
      clear(sum);
      const parts = E.splitByCategory(S2.items, Number(S2.total) || 0, pr.taxExcluded, Number(S2.total) === pr.total ? pr.rates : null);
      const itemsTotal = S2.items.reduce((a, it) => a + (Number(it.price) || 0), 0);
      parts.forEach((x) => { const c = catOf(x.category); sum.appendChild(row({ icon: c ? c.icon : '・', t1: c ? c.name : '分類なし', t2: '品目の計 ' + yen(x.items), right: amountEl(-x.amount) })); });
      if (!parts.length) sum.appendChild(empty('品目がありません'));
      // 答え合わせ（品目の合計 ＝ 小計？）
      const chk = E.checkReceipt(S2.items, Number(S2.total) || 0, Number(S2.total) === pr.total ? pr.subtotal : null, pr.taxExcluded);
      S2.check = chk;
      sum.appendChild(h('div', { class: 'check-box ' + chk.level }, h('strong', null, chk.ok ? '✓ 答え合わせOK' : '⚠ 合計が合っていません'), h('span', null, chk.text)));
      const usedRates = Number(S2.total) === pr.total && pr.rates;
      sum.appendChild(h('p', { class: 'note' }, '品目の合計 ' + yen(itemsTotal) + (S2.total ? '／レシートの合計 ' + yen(S2.total) + '。' +
        (usedRates ? 'レシートの税率ごとの金額（8%：' + yen(pr.rates[8]) + '・10%：' + yen(pr.rates[10]) + '）に合わせて分けています。' : '差（税・値引きなど）は、分類ごとの金額の割合で分けています。') : '')));
    };
    drawSum();
    main.appendChild(card('登録される記録', sum,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S2.learn, onchange: (e) => { S2.learn = e.target.checked; } }), h('span', null, '変えた分類を覚えて、次から自動で分ける'))));

    const save = async (oneLine) => {
      if (!oneLine && S2.check && !S2.check.ok) {
        const a = await ask('合計が合っていません', S2.check.text + '\nこのまま登録すると、差の分は分類ごとの割合で振り分けられます。', [{ v: 'go', label: 'このまま登録する', primary: true }, { v: 'back', label: '戻って直す' }]);
        if (a !== 'go') return false;
      }
      try {
        const parts = oneLine ? [{ category: p.defaults.food, amount: Number(S2.total) || S2.items.reduce((a, it) => a + (Number(it.price) || 0), 0) }] : E.splitByCategory(S2.items, Number(S2.total) || 0, pr.taxExcluded, Number(S2.total) === pr.total ? pr.rates : null);
        if (!parts.length || parts.some((x) => !(x.amount > 0))) throw new Error('金額が正しくありません。合計か品目の金額を確かめてください。');
        if (!S2.from) throw new Error('支払い（口座・カード）を選んでください。');
        const rcpt = rid('rc');
        const memo = (S2.store || 'レシート').trim();
        const created = nowStr();
        const txOfCat = {};
        parts.forEach((x) => {
          const id = rid('t');
          txOfCat[x.category] = id;
          put('tx', { id: id, date: S2.date || m.today, type: '支出', amount: x.amount, category: x.category, from: S2.from, to: '', memo: memo,
            user: S.user, settle: (catOf(x.category) || {}).group === '立替（あとで戻る）' ? '未精算' : '', ref: '', created: created, rcpt: rcpt });
        });
        // 品目（内訳）を残す。分けたときは品目の分類の記録に、まとめたときはその1件の記録につなぐ
        const one = oneLine ? txOfCat[parts[0].category] : '';
        S2.items.filter((it) => String(it.name || '').trim()).forEach((it) => put('items', { id: rid('it'), rcpt: rcpt, tx: one || txOfCat[it.category] || '',
          date: S2.date || m.today, store: memo, name: String(it.name).trim().slice(0, 100), price: Math.round(Number(it.price) || 0), category: it.category || '', reduced: !!it.reduced }));
        if (S2.learn) learnItems(S2.items, p.defaults);   // 分けても、まとめても、変えた分類を覚える
        prefs.lastFrom = S2.from; savePrefs();
        R.guard = null;
        toast((oneLine ? '1件で登録しました（' : parts.length + '件に分けて登録しました（') + memo + '・品目 ' + S2.items.filter((it) => String(it.name || '').trim()).length + '件の内訳つき）');
        back();
        return true;
      } catch (e) { toast(e.message, { error: true }); return false; }
    };
    R.guard = { form: true, dirty: () => S2.dirty, save: () => save(false), title: 'レシートの内容をまだ登録していません', saveLabel: '分けて登録する' };
    main.appendChild(h('div', { class: 'form-acts pad' },
      h('button', { type: 'button', onclick: back }, 'やめる'),
      h('button', { type: 'button', onclick: () => save(true) }, 'まとめて1件で登録'),
      h('button', { type: 'button', class: 'primary', onclick: () => save(false) }, '分けて登録')));
    main.appendChild(h('details', { class: 'raw' }, h('summary', null, '読み取った文字を見る'),
      h('button', { type: 'button', class: 'sbtn', onclick: async () => { try { await navigator.clipboard.writeText(p.text || ''); toast('読み取った文字をコピーしました'); } catch (e) { toast('コピーできませんでした。文字を長押しして選んでください', { error: true }); } } }, '文字をコピー'),
      h('pre', null, p.text || '（なし）')));
  }

  /* ================= やることリスト ================= */
  let todoView = 'open';
  function todoRow(t, m) {
    const left = t.due ? E.diffDays(m.today, t.due) : null;
    const tag = t.done ? (t.doneAt ? md(t.doneAt.slice(0, 10)) + ' 済' : '済') : left === null ? null : left < 0 ? '期限切れ' : left === 0 ? '今日' : left <= 7 ? 'あと' + left + '日' : md(t.due);
    const tagCls = t.done ? '' : left !== null && left < 0 ? 'high' : left !== null && left <= 3 ? 'mid' : '';
    const check = h('button', { type: 'button', class: 'todo-check' + (t.done ? ' on' : ''), 'aria-label': t.done ? '未完了に戻す' : '済みにする',
      onclick: (ev) => { ev.stopPropagation(); toggleTodo(t); } }, t.done ? '✓' : '');
    return row({ icon: check, t1: t.title, cls: 'todo' + (t.done ? ' done' : ''),
      t2: [t.who, t.memo].filter(Boolean).join('・'), right: tag ? h('span', { class: 'tag ' + tagCls }, tag) : '',
      onclick: () => push('edit', { table: 'todos', id: t.id }) });
  }
  function toggleTodo(t) {
    const next = !t.done;
    put('todos', Object.assign({}, stripMeta(t), { done: next, doneAt: next ? nowStr() : '' }));
    toast(next ? '「' + t.title + '」を済みにしました' : '未完了に戻しました', next ? { undo: () => put('todos', Object.assign({}, stripMeta(t), { done: false, doneAt: '' })) } : {});
  }
  function todosPage(main) {
    setTitle('やること・期限');
    todoSection(main, model(), true);
  }
  function todoSection(main, m, withDeadlines) {
    // 期限（手続き・更新など。LINEで前もって知らせる）
    if (withDeadlines) {
      const dl = m.deadlines.slice().sort((a, b) => (a.done - b.done) || String(a.date || '9').localeCompare(String(b.date || '9')));
      const openDl = dl.filter((d) => !d.done);
      main.appendChild(card('期限（' + openDl.length + '件）', openDl.length ? openDl.slice(0, 8).map((r) => summaryRow('deadlines', r, m)) : empty('期限はありません'),
        h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => push('edit', { table: 'deadlines', id: null }) }, '＋ 期限を追加'),
          dl.length > openDl.slice(0, 8).length ? h('button', { type: 'button', onclick: () => push('table', { table: 'deadlines' }) }, 'すべての期限（' + dl.length + '）') : null)));
    }
    const open = m.todos.filter((t) => !t.done), done = m.todos.filter((t) => t.done);
    main.appendChild(card('やることリスト', h('div', { class: 'kpi' }, h('div', null, h('div', { class: 'lbl' }, '残り'), h('div', { class: 'big' }, open.length + '件')),
      h('div', { class: 'r' }, h('div', { class: 'lbl' }, '済み'), h('div', { class: 'v' }, done.length + '件'))), bar(m.todos.length ? done.length / m.todos.length : 0)));
    // すぐ追加
    const input = h('input', { type: 'text', placeholder: 'やることを入れて追加', maxlength: '200', enterkeyhint: 'done' });
    const add = () => {
      const v = input.value.trim(); if (!v) return;
      try { put('todos', { id: rid('k'), title: v, due: '', group: '', who: '', done: false, doneAt: '', order: 999, memo: '' }); input.value = ''; toast('追加しました'); }
      catch (e) { toast(e.message, { error: true }); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    main.appendChild(h('div', { class: 'quick-add' }, input, h('button', { type: 'button', class: 'primary', onclick: add }, '追加')));
    main.appendChild(seg([['open', '残り'], ['soon', '期限が近い'], ['done', '済み'], ['all', 'すべて']], todoView, (v) => { todoView = v; refresh(); }));
    let list = todoView === 'open' ? open : todoView === 'done' ? done.slice().reverse() : todoView === 'soon' ? open.filter((t) => t.due && E.diffDays(m.today, t.due) <= 14) : m.todos;
    if (!list.length) { main.appendChild(card(null, empty(todoView === 'done' ? '済んだものはまだありません' : 'やることはありません'))); return; }
    const groups = [];
    list.forEach((t) => { const g = t.group || 'そのほか'; let x = groups.find((y) => y[0] === g); if (!x) { x = [g, []]; groups.push(x); } x[1].push(t); });
    if (todoView === 'soon') groups.splice(0, groups.length, ['期限が2週間以内', list]);
    groups.forEach(([g, items]) => main.appendChild(card(g + '（' + items.length + '）', items.map((t) => todoRow(t, m)))));
    main.appendChild(h('button', { type: 'button', class: 'link center', onclick: () => push('edit', { table: 'todos', id: null }) }, '＋ 期限やメモをつけて追加'));
  }

  const PAGES = { bill: billPage, cards: cardsPage, check: checkPage, receiptView: receiptViewPage, fare: farePage, receipt: receiptPage, todos: todosPage, account: accountPage, card: cardPage, table: tablePage, edit: editPage, opening: openingPage, bills: billsPage, display: displayPage, sync: syncPage, device: devicePage };

  /* ================= 登録画面 ================= */
  function showSetup(msg) {
    $('#nav').classList.add('hidden');
    $('#title').textContent = '家計簿';
    const main = clear($('#main'));
    const input = h('input', { type: 'url', placeholder: 'https://…#setup=…', autocomplete: 'off', spellcheck: 'false' });
    const err = h('p', { class: 'err' });
    main.appendChild(card('この端末を登録します',
      h('p', null, msg || 'スプレッドシートのメニュー「家計簿 > 〇の端末を登録するリンクを出す」で出たリンクを開くか、下に貼り付けてください。'),
      h('p', { class: 'note' }, 'iPhoneでホーム画面に追加したアプリは、Safariとは別に登録が必要です。アプリを開いて、ここに貼り付けてください。'),
      fieldWrap('登録リンク', input), err,
      h('button', { type: 'button', class: 'save-btn', onclick: () => {
        const c = readSetup(input.value.trim());
        if (!c) { err.textContent = 'リンクの形が正しくありません。リンク全体をコピーして貼り付けてください。'; return; }
        cfg = c; store.set(CFG_KEY, cfg); location.reload();
      } }, '登録する')));
  }

  /* ================= キーボード（PC） ================= */
  document.addEventListener('keydown', (e) => {
    if (R.stack.length || R.tab !== 'input' || $('#layer').firstChild) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) { if (e.key === 'Enter' && e.target.classList.contains('memo')) saveInput(false); return; }
    if (st.cur === 'USD') {
      // ドル：数字と小数点（小数は2けたまで）
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); if (st.usd.length < 10 && !/\.\d\d$/.test(st.usd)) { st.usd = (st.usd === '0' ? '' : st.usd) + e.key; refresh(); } }
      else if (e.key === '.') { e.preventDefault(); if (st.usd.indexOf('.') < 0) { st.usd = (st.usd || '0') + '.'; refresh(); } }
      else if (e.key === 'Backspace') { e.preventDefault(); st.usd = st.usd.slice(0, -1); refresh(); }
      else if (e.key === 'Enter') { e.preventDefault(); saveInput(false); }
      return;
    }
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); if ((st.amount + e.key).length <= 9) { st.amount = st.amount === '' && e.key === '0' ? '' : st.amount + e.key; refresh(); } }
    else if (e.key === 'Backspace') { e.preventDefault(); st.amount = st.amount.slice(0, -1); refresh(); }
    else if (e.key === 'Enter') { e.preventDefault(); saveInput(false); }
  });

  /* ================= 起動 ================= */
  window.addEventListener('online', () => flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (S.ops.length) flush(true); }
    else if (cfg && Date.now() - S.lastSync > 20000) flush();
  });
  window.addEventListener('pagehide', () => { if (S.ops.length) flush(true); });
  window.addEventListener('beforeunload', (e) => { if (S.ops.length) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(() => { if (cfg && document.visibilityState === 'visible' && !S.inflight && Date.now() - S.lastSync > 60000) flush(); }, 15000);
  $('#status').addEventListener('click', () => { if (cfg && S.base) push('sync'); });
  setInterval(() => { if (S.base) refresh(true); }, 60000);   // 日付が変わったときなど

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('新しい版があります。開き直すと反映されます', { long: true });
        });
      });
    }).catch(() => { /* なくても動く */ });
  }

  async function boot() {
    if (!cfg) { showSetup(); return; }
    let cached = null;
    try { cached = await Vault.load(); } catch (e) { cached = null; }
    if (cached && cached.v === 2 && cached.base) {
      S.rev = cached.rev; S.base = cached.base; S.ops = cached.ops || []; S.user = cached.user || ''; S.lastSync = cached.lastSync || 0;
      S.ver++;
      render(true);
      setStatus();
    }
    await flush();
    if (!S.base) {
      const main = clear($('#main'));
      main.appendChild(card(null, h('p', { class: 'err' }, '読み込めませんでした：' + (S.error || '不明なエラー')), h('button', { type: 'button', class: 'save-btn', onclick: () => location.reload() }, 'もう一度')));
      return;
    }
    if (!cached) render(true);
  }
  boot();
})();
