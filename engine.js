/*
 * 家計簿の計算エンジン（画面とGASで同じものを使う）
 *
 * - このファイルは GitHub の web/engine.js と、GAS の Engine.gs に「まったく同じ中身」で置きます。
 * - データ（金額・口座名など）は持ちません。計算のしかたと、表の形だけです。
 *
 * お金の流れの考え方
 *   口座（銀行・現金・電子マネー）… 残高を持つ。「開始残高」＋開始後の記録で今の残高を計算する。
 *   カード … 使った分は「締め日」で区切られ、「引き落とし日」に引き落とし口座から自動で引かれる。
 *   記録の種類 … 支出 / 収入 / 振替（口座→口座、カード払い・チャージも）/ 残高合わせ（実際の残高との差）
 */
var Engine = (function () {
  'use strict';

  /* ================= 表の形 ================= */
  const WHO = ['夫', '妻'];
  const SCHEMA = {
    wallets: {
      sheet: '口座・カード', label: '口座・カード', prefix: 'w',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'name', label: '名前', type: 'text', req: true },
        { k: 'kind', label: '種類', type: 'select', opts: ['銀行', '現金', '電子マネー', 'カード', 'その他'], req: true, def: '銀行' },
        { k: 'role', label: '役割・用途', type: 'text' },
        { k: 'opening', label: '開始残高（円）', type: 'sint', only: 'account' },
        { k: 'openingAt', label: '開始残高を入れた日時', type: 'datetime', only: 'account', ro: true },
        { k: 'closeDay', label: '締め日（数字か「末」）', type: 'close', only: 'card' },
        { k: 'debitDay', label: '引き落とし日', type: 'day', only: 'card' },
        { k: 'debitOffset', label: '引き落とし月（締めの何か月後）', type: 'select', opts: ['1', '2'], def: '1', only: 'card' },
        { k: 'payFrom', label: '引き落とし口座', type: 'ref', ref: 'wallets', refKind: 'account', only: 'card' },
        { k: 'expiry', label: '有効期限（年/月）', type: 'month', only: 'card' },
        { k: 'order', label: '並び順', type: 'int', def: 50 },
        { k: 'active', label: '使っている', type: 'bool', def: true },
        { k: 'memo', label: 'メモ', type: 'longtext' }
      ]
    },
    categories: {
      sheet: '分類', label: '分類', prefix: 'c',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'name', label: '分類', type: 'text', req: true },
        { k: 'kind', label: '支出か収入か', type: 'select', opts: ['支出', '収入'], req: true, def: '支出' },
        { k: 'icon', label: 'アイコン（絵文字1つ）', type: 'text', def: '📦' },
        { k: 'group', label: '集計の扱い', type: 'select', opts: ['生活費', '生活費の外', '立替（あとで戻る）'], def: '生活費' },
        { k: 'budget', label: '月の予算（円）', type: 'int' },
        { k: 'order', label: '並び順', type: 'int', def: 50 },
        { k: 'active', label: '使っている', type: 'bool', def: true }
      ]
    },
    tx: {
      sheet: '記録', label: '記録', prefix: 't',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'date', label: '日付', type: 'date', req: true },
        { k: 'type', label: '種類', type: 'select', opts: ['支出', '収入', '振替', '残高合わせ'], req: true },
        { k: 'amount', label: '金額（円）', type: 'sint', req: true },
        { k: 'category', label: '分類', type: 'ref', ref: 'categories' },
        { k: 'from', label: '出どころ（口座・カード）', type: 'ref', ref: 'wallets' },
        { k: 'to', label: '入れ先（口座・カード）', type: 'ref', ref: 'wallets' },
        { k: 'memo', label: 'メモ', type: 'text' },
        { k: 'user', label: '入力者', type: 'select', opts: WHO },
        { k: 'settle', label: '精算', type: 'select', opts: ['', '未精算', '精算済'] },
        { k: 'ref', label: '予定との対応', type: 'text', ro: true },
        { k: 'created', label: '登録日時', type: 'datetime', ro: true }
      ]
    },
    bills: {
      sheet: 'カード請求', label: 'カード請求', prefix: 'b',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'card', label: 'カード', type: 'ref', ref: 'wallets', refKind: 'card', req: true },
        { k: 'ym', label: '引き落とし月', type: 'month', req: true },
        { k: 'amount', label: '確定した請求額（円）', type: 'int' },
        { k: 'status', label: '引き落とし', type: 'select', opts: ['自動', '引き落とし不可'], def: '自動' },
        { k: 'memo', label: 'メモ', type: 'text' }
      ]
    },
    plans: {
      sheet: '予定', label: '固定費・収入・年間の予定', prefix: 'p',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'kind', label: '種類', type: 'select', opts: ['固定費', '収入', '年間', '振替'], req: true, def: '固定費' },
        { k: 'name', label: '項目', type: 'text', req: true },
        { k: 'amount', label: '金額（円）', type: 'int' },
        { k: 'category', label: '分類', type: 'ref', ref: 'categories' },
        { k: 'wallet', label: '口座・カード（払う元／入る先）', type: 'ref', ref: 'wallets' },
        { k: 'day', label: '日（空欄なら月のどこか）', type: 'day' },
        { k: 'months', label: '月（空欄は毎月。例 6,12）', type: 'months' },
        { k: 'every', label: '何年ごと（0は1回だけ）', type: 'int', def: 1 },
        { k: 'start', label: '開始月', type: 'month' },
        { k: 'end', label: '終了月', type: 'month' },
        { k: 'inBudget', label: '生活費に含める', type: 'bool', def: true },
        { k: 'reserve', label: '特別費として積み立てる', type: 'bool', def: false },
        { k: 'active', label: '有効', type: 'bool', def: true },
        { k: 'memo', label: 'メモ', type: 'longtext' },
        { k: 'to', label: '移す先（振替のとき）', type: 'ref', ref: 'wallets' }
      ]
    },
    deadlines: {
      sheet: '期限', label: '期限', prefix: 'd',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'name', label: '項目', type: 'text', req: true },
        { k: 'date', label: '期限日', type: 'date' },
        { k: 'notice', label: '何日前から知らせる', type: 'int', def: 30 },
        { k: 'who', label: '対象', type: 'select', opts: ['夫', '妻', 'グループ'], def: 'グループ' },
        { k: 'done', label: '対応済', type: 'bool', def: false },
        { k: 'memo', label: 'メモ', type: 'longtext' }
      ]
    },
    bonuses: {
      sheet: 'ボーナス', label: 'ボーナス', prefix: 'n',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'name', label: '支給（例 2027年夏）', type: 'text', req: true },
        { k: 'date', label: '支給日', type: 'date' },
        { k: 'net', label: '手取り（円）', type: 'int' },
        { k: 'wallet', label: '入金口座', type: 'ref', ref: 'wallets', refKind: 'account' }
      ]
    },
    allocs: {
      sheet: 'ボーナス配分', label: 'ボーナスの配分', prefix: 'a',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'bonus', label: '支給', type: 'ref', ref: 'bonuses', req: true },
        { k: 'item', label: '項目', type: 'text', req: true },
        { k: 'amount', label: '金額（円）', type: 'int' },
        { k: 'to', label: '移し先（空欄は支払い）', type: 'ref', ref: 'wallets' },
        { k: 'category', label: '支払いの分類（移し先が空欄のとき）', type: 'ref', ref: 'categories' },
        { k: 'order', label: '並び順', type: 'int', def: 50 },
        { k: 'memo', label: 'メモ', type: 'longtext' }
      ]
    },
    notifyTpl: {
      sheet: '通知テンプレート', label: '通知の文面', fixedRows: true,
      fields: [
        { k: 'id', label: '番号', type: 'id', ro: true },
        { k: 'type', label: '種類', type: 'text', ro: true },
        { k: 'level', label: '重要度', type: 'select', opts: ['高', '中', '低'], def: '中' },
        { k: 'to', label: '送り先（夫・妻・グループ・対象者・本人をカンマで）', type: 'text' },
        { k: 'enabled', label: '有効', type: 'bool', def: true },
        { k: 'text', label: '文面（{ }は自動で差し込み）', type: 'longtext', req: true },
        { k: 'vars', label: '使える差し込み', type: 'text', ro: true }
      ]
    },
    notifyConf: {
      sheet: '通知設定', label: '通知の設定', fixedRows: true,
      fields: [
        { k: 'id', label: '項目', type: 'id', ro: true },
        { k: 'value', label: '値', type: 'text', req: true }
      ]
    },
    lineDest: {
      sheet: 'LINE宛先', label: 'LINEの送り先', fixedRows: true,
      fields: [
        { k: 'id', label: '名前', type: 'id', ro: true },
        { k: 'lineId', label: 'LINEのID', type: 'lineId' },
        { k: 'enabled', label: '有効', type: 'bool', def: true }
      ]
    },
    rules: {
      sheet: 'レシートの読み取りルール', label: 'レシートの読み取りルール', prefix: 'r',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'keyword', label: '品名に含まれる文字（カンマで複数）', type: 'text', req: true },
        { k: 'category', label: '分ける先の分類', type: 'ref', ref: 'categories', req: true },
        { k: 'order', label: '並び順（小さいほど先に当てる）', type: 'int', def: 50 },
        { k: 'active', label: '使う', type: 'bool', def: true }
      ]
    },
    todos: {
      sheet: 'やること', label: 'やることリスト', prefix: 'k',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'title', label: 'やること', type: 'text', req: true },
        { k: 'due', label: '期限', type: 'date' },
        { k: 'group', label: 'まとまり（例 12月4日まで・口座の設定）', type: 'text' },
        { k: 'who', label: '担当', type: 'select', opts: ['夫', '妻', '二人'] },
        { k: 'done', label: '済み', type: 'bool', def: false },
        { k: 'doneAt', label: '済ませた日時', type: 'datetime', ro: true },
        { k: 'order', label: '並び順', type: 'int', def: 50 },
        { k: 'memo', label: 'メモ', type: 'longtext' }
      ]
    }
  };
  const TABLES = Object.keys(SCHEMA);

  /* ================= 入力の確認（画面とGASの両方で使う） ================= */
  function clean(table, row) {
    const sc = SCHEMA[table];
    if (!sc) throw new Error('不明な表です。');
    if (!row || typeof row !== 'object') throw new Error('入力が正しくありません。');
    const out = {};
    sc.fields.forEach((f) => { out[f.k] = cleanField(f, row[f.k], row); });
    if (table === 'tx') checkTx(out);
    if (table === 'plans' && out.kind === '振替' && (!out.wallet || !out.to || out.wallet === out.to)) throw new Error('振替の予定は、移す元と移す先を別々に選んでください。');
    if (table === 'wallets' && out.kind === 'カード' && !out.payFrom) { /* 引き落とし口座は後から入れてもよい */ }
    return out;
  }

  function cleanField(f, raw, row) {
    const label = f.label || f.k;
    const bad = (m) => { throw new Error('「' + label + '」' + m); };
    let s = raw === null || raw === undefined ? '' : (typeof raw === 'string' ? raw : String(raw));
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (/^'/.test(s)) s = s.slice(1);
    if (s === '' && f.def !== undefined && f.type !== 'bool') s = String(f.def);
    if (f.req && s === '' && f.type !== 'bool') bad('を入れてください。');
    switch (f.type) {
      case 'id':
        if (!s || s.length > 80 || /[\r\n]/.test(s)) bad('が正しくありません。');
        return s;
      case 'bool':
        if (raw === true || raw === false) return raw;
        if (s === '') return f.def === undefined ? false : !!f.def;
        return /^(true|1|yes|はい|✓)$/i.test(s);
      case 'int': case 'sint': {
        if (s === '') return '';
        const n = Number(s.replace(/[,，円¥\s]/g, ''));
        if (!isFinite(n) || Math.abs(n) > 1e10) bad('は数字で入れてください。');
        if (f.type === 'int' && n < 0) bad('はマイナスにできません。');
        return Math.round(n);
      }
      case 'date': {
        if (s === '') return '';
        const d = toDateStr(s);
        if (!d) bad('は「2027-04-01」の形で入れてください。');
        return d;
      }
      case 'datetime':
        if (s === '') return '';
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) bad('の形が正しくありません。');
        return s;
      case 'month': {
        if (s === '') return '';
        const m = /^(\d{4})[\/\-年.](\d{1,2})月?$/.exec(s) || /^(\d{4})-(\d{2})-\d{2}/.exec(s);
        if (!m || +m[2] < 1 || +m[2] > 12) bad('は「2029-08」の形で入れてください。');
        return m[1] + '-' + pad(+m[2]);
      }
      case 'day': {
        if (s === '') return '';
        const n = Number(s.replace(/日$/, ''));
        if (!(n >= 1 && n <= 31) || n !== Math.floor(n)) bad('は1〜31で入れてください。');
        return n;
      }
      case 'close': {
        if (s === '' ) return '';
        if (s === '末' || s === '月末' || s === '31') return '末';
        const n = Number(s.replace(/日$/, ''));
        if (!(n >= 1 && n <= 30) || n !== Math.floor(n)) bad('は1〜30か「末」で入れてください。');
        return n;
      }
      case 'months': {
        if (s === '') return '';
        const list = s.split(/[,、\s・]+/).filter(Boolean).map((x) => Number(x.replace(/月$/, '')));
        if (list.some((n) => !(n >= 1 && n <= 12) || n !== Math.floor(n))) bad('は1〜12をカンマで区切って入れてください。');
        return list.filter((n, i) => list.indexOf(n) === i).sort((a, b) => a - b).join(',');
      }
      case 'select':
        if (s !== '' && f.opts.indexOf(s) < 0) bad('の選び方が正しくありません。');
        return s;
      case 'ref':
        if (s.length > 80) bad('が正しくありません。');
        return s;
      case 'lineId':
        if (s !== '' && !/^[UCR][0-9a-f]{32}$/.test(s)) bad('の形が正しくありません（U・C・Rで始まる33文字）。');
        return s;
      default: {
        const max = f.type === 'longtext' ? 1000 : 200;
        if (s.length > max) bad('が長すぎます（' + max + '文字まで）。');
        if (/\d{12,}/.test(s.replace(/[\s\-ー－]/g, ''))) bad('に、カード番号のような長い数字は保存できません。');
        return s;
      }
    }
  }

  function checkTx(t) {
    if (t.amount === '' || (t.type !== '残高合わせ' && t.amount <= 0)) throw new Error('金額を正しく入れてください。');
    if (t.type === '支出' && !t.from) throw new Error('支払い元（口座・カード）を選んでください。');
    if (t.type === '収入' && !t.to) throw new Error('入れ先（口座）を選んでください。');
    if (t.type === '振替' && (!t.from || !t.to || t.from === t.to)) throw new Error('振替は、移す元と先を別々に選んでください。');
    if (t.type === '残高合わせ' && !t.to) throw new Error('口座を選んでください。');
  }

  /* ================= 日付 ================= */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toDateStr(s) {
    const m = /^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})日?/.exec(String(s).trim());
    if (!m) return '';
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return '';
    return y + '-' + pad(mo) + '-' + pad(d);
  }
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function dimOf(ym) { return daysIn(+ym.slice(0, 4), +ym.slice(5, 7)); }
  function ms(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
  function fromMs(t) { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(s, n) { return fromMs(ms(s) + n * 86400000); }
  function diffDays(a, b) { return Math.round((ms(b) - ms(a)) / 86400000); }
  function ymOf(s) { return s.slice(0, 7); }
  function addMonths(ym, n) {
    let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + n;
    while (m > 12) { m -= 12; y++; }
    while (m < 1) { m += 12; y--; }
    return y + '-' + pad(m);
  }
  function dateIn(ym, day) { return ym + '-' + pad(Math.min(Math.max(1, day || 1), dimOf(ym))); }
  function weekday(s) { return '日月火水木金土'.charAt(new Date(ms(s)).getUTCDay()); }

  /* ================= データの組み立て ================= */
  function isAccount(w) { return !!w && w.kind !== 'カード'; }
  function isCard(w) { return !!w && w.kind === 'カード'; }
  const byOrder = (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name), 'ja');

  /**
   * data: { wallets:[], categories:[], tx:[], bills:[], plans:[], deadlines:[], bonuses:[], allocs:[] }
   * now:  'YYYY-MM-DD HH:mm:ss'（日本時間）
   */
  function build(data, now) {
    const m = { now: now, today: now.slice(0, 10), data: data };
    const all = (data.wallets || []).slice().sort(byOrder);
    m.w = {}; all.forEach((w) => { m.w[w.id] = w; });
    m.walletsAll = all;
    m.wallets = all.filter((w) => w.active !== false);
    m.accounts = m.wallets.filter(isAccount);
    m.cards = m.wallets.filter(isCard);
    const cats = (data.categories || []).slice().sort(byOrder);
    m.c = {}; cats.forEach((c) => { m.c[c.id] = c; });
    m.categoriesAll = cats;
    m.categories = cats.filter((c) => c.active !== false);
    m.tx = (data.tx || []).slice().sort((a, b) => (a.date + (a.created || '')).localeCompare(b.date + (b.created || '')));
    m.done = {}; m.tx.forEach((t) => { if (t.ref) m.done[t.ref] = t; });
    m.billRows = {}; (data.bills || []).forEach((b) => { m.billRows[b.card + '|' + b.ym] = b; });
    m.plans = (data.plans || []).filter((p) => p.active !== false);
    m.plansAll = data.plans || [];
    m.deadlines = data.deadlines || [];
    m.todos = (data.todos || []).slice().sort(todoOrder);
    m.bonuses = (data.bonuses || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    m.allocs = (data.allocs || []).slice().sort(byOrder);
    return m;
  }

  /* ================= レシートの読み取り ================= */
  // 全角を半角に、よくある読み違いを直す
  function normText(s) {
    return String(s || '').normalize('NFKC').replace(/[‐－―ー−]/g, (c) => (c === 'ー' ? c : '-')).replace(/[￥\\]/g, '¥').replace(/\r/g, '');
  }
  const SKIP = /(合計|小計|総計|お買上|お買い上げ|お預|預り|預かり|釣|おつり|お釣|税|対象|ポイント|点数|クレジット|カード|電子マネー|PayPay|残高|支払|現金|領収|レジ|担当|TEL|電話|No\.|伝票|会員|ありがとう|株式会社|〒|登録番号|値引前)/i;
  const PRICE = /[¥]?\s*(-?\d{1,3}(?:,\d{3})+|-?\d{1,6})\s*円?\s*([※*軽外内]|\(軽\)|\(8%\)|\(10%\))?\s*$/;

  /**
   * レシートの文字から、店名・日付・合計・品目を取り出す
   * 戻り値 { store, date, total, items:[{name, price, reduced}], hasReduced }
   */
  function parseReceipt(text, today) {
    const lines = normText(text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = { store: '', date: '', total: null, items: [], hasReduced: false };
    // 日付
    const y0 = +String(today).slice(0, 4);
    for (const l of lines) {
      let m = /(20\d{2})\s*[年\/.-]\s*(\d{1,2})\s*[月\/.-]\s*(\d{1,2})/.exec(l);
      let y = m ? +m[1] : null;
      if (!m) { m = /(?:令和|R)\s*(\d{1,2})\s*[年\/.]\s*(\d{1,2})\s*[月\/.]\s*(\d{1,2})/.exec(l); if (m) y = 2018 + +m[1]; }
      if (!m) { m = /(?:^|\D)(\d{2})\/(\d{1,2})\/(\d{1,2})(?:\D|$)/.exec(l); if (m) y = 2000 + +m[1]; }
      if (m && y >= y0 - 1 && y <= y0 + 1) {
        const d = toDateStr(y + '-' + m[m.length - 2] + '-' + m[m.length - 1]);
        if (d && (!today || d <= today)) { out.date = d; break; }
      }
    }
    // 合計（「小計」より「合計」を優先。お預り・お釣りは除く）
    const amountIn = (l) => { const m = /(-?\d{1,3}(?:,\d{3})+|-?\d{1,7})(?!.*\d)/.exec(l.replace(/[¥円\s]/g, (c) => (c === ' ' ? ' ' : ''))); return m ? Number(m[1].replace(/,/g, '')) : null; };
    const findTotal = (re) => {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]) || /(お預|預り|釣|対象|税額|内税|外税|消費税|点数)/.test(lines[i])) continue;
        let v = amountIn(lines[i].replace(re, ''));
        if ((v === null || v === 0) && lines[i + 1] && !/[ぁ-んァ-ン一-龥]/.test(lines[i + 1])) v = amountIn(lines[i + 1]);
        if (v !== null && v > 0) return v;
      }
      return null;
    };
    out.total = findTotal(/(合計|総合計|お買上げ?|お買い上げ|ご請求額?|お支払い?金額)/) || findTotal(/小計/);
    // 店名：最初の、数字だらけでない行
    for (const l of lines.slice(0, 6)) {
      if (/^(領収書|レシート|receipt)$/i.test(l) || /\d{2,}[-\d]{6,}/.test(l) || /(TEL|電話|〒|住所|登録番号)/i.test(l)) continue;
      const letters = l.replace(/[\d\s¥,.:\-\/()]/g, '');
      if (letters.length >= 2) { out.store = l.slice(0, 40); break; }
    }
    // 品目：「品名 … 金額」の行
    const names = [], prices = [];
    let afterTotal = false;
    lines.forEach((l) => {
      if (/(合計|小計|お買上)/.test(l)) afterTotal = true;
      if (afterTotal || SKIP.test(l)) return;
      if (/\d{1,2}:\d{2}/.test(l) || /(20\d{2}|令和|R\d)\s*[年\/.]/.test(l) || /^\d{2}\/\d{1,2}\/\d{1,2}/.test(l)) return;   // 日付・時刻の行
      const m = PRICE.exec(l);
      const reduced = /([※*軽]|\(軽\)|\(8%\))/.test(l);
      if (m) {
        const name = l.slice(0, m.index).replace(/[¥\s]+$/, '').replace(/^\d{4,}\s*/, '').replace(/\s*\d+\s*(個|点|コ)\s*[x×*@]?\s*\d*\s*$/, '').trim();
        const price = Number(m[1].replace(/,/g, ''));
        if (/(値引|割引|クーポン|OFF|引)/i.test(name) && out.items.length) { out.items[out.items.length - 1].price -= Math.abs(price); return; }
        if (name.replace(/[\d\s.,%-]/g, '').length >= 1 && price !== 0 && Math.abs(price) < 1000000) {
          out.items.push({ name: name.slice(0, 40), price: price, reduced: reduced });
          if (reduced) out.hasReduced = true;
          return;
        }
        if (!name && price > 0) { prices.push({ price: price, reduced: reduced }); return; }
      }
      if (/[ぁ-んァ-ン一-龥A-Za-z]{2,}/.test(l) && !/\d{3,}/.test(l)) names.push(l.slice(0, 40));
    });
    // 品名と金額が別々の行に分かれて読まれたとき：順番に組み合わせる
    if (out.items.length < 2 && names.length >= 2 && prices.length >= 2) {
      const n = Math.min(names.length, prices.length);
      const start = names.length - n;
      out.items = [];
      for (let i = 0; i < n; i++) { out.items.push({ name: names[start + i], price: prices[i].price, reduced: prices[i].reduced }); if (prices[i].reduced) out.hasReduced = true; }
    }
    return out;
  }

  /**
   * 品目を分類に振り分け、合計に合わせて分類ごとの金額を出す
   * rules: [{keyword, category, order, active}]、defaults: { food: 分類ID, other: 分類ID }
   */
  function classifyReceipt(parsed, rules, defaults) {
    const rs = (rules || []).filter((r) => r.active !== false && r.keyword && r.category).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const hit = (name) => {
      const n = normText(name).toLowerCase();
      for (const r of rs) {
        const keys = String(r.keyword).split(/[,、]/).map((k) => normText(k).trim().toLowerCase()).filter(Boolean);
        if (keys.some((k) => n.indexOf(k) >= 0)) return r.category;
      }
      return '';
    };
    const items = parsed.items.map((it) => {
      const byRule = hit(it.name);
      const cat = byRule || (parsed.hasReduced && !it.reduced ? defaults.other : defaults.food) || defaults.food;
      return Object.assign({}, it, { category: cat, byRule: !!byRule });
    });
    return Object.assign({}, parsed, { items: items });
  }

  /** 分類ごとに合計し、レシートの合計（税・値引き込み）に合わせて按分する */
  function splitByCategory(items, total) {
    const sums = {};
    items.forEach((it) => { if (it.category) sums[it.category] = (sums[it.category] || 0) + (Number(it.price) || 0); });
    const keys = Object.keys(sums).filter((k) => sums[k] !== 0);
    const S = keys.reduce((a, k) => a + sums[k], 0);
    const T = total && total > 0 ? total : S;
    if (!S) return [];
    let used = 0;
    const big = keys.slice().sort((a, b) => sums[b] - sums[a]);
    const out = big.map((k, i) => {
      const v = i === big.length - 1 ? T - used : Math.round(sums[k] * T / S);
      used += v;
      return { category: k, items: sums[k], amount: v };
    });
    return out.filter((x) => x.amount > 0);
  }

  /** やることの並び：済んでいないもの → 期限が近い順（期限なしは後ろ）→ 並び順 */
  function todoOrder(a, b) {
    return (a.done === true) - (b.done === true) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || (Number(a.order) || 0) - (Number(b.order) || 0);
  }

  /* ================= カード ================= */
  function closeDayOf(card, ym) {
    const c = card.closeDay;
    if (c === '' || c === '末' || c === undefined || c === null) return dimOf(ym);
    return Math.min(Number(c), dimOf(ym));
  }
  /** その日に使った分は、いつ締められ、いつ引き落とされるか */
  function cycleOf(card, date) {
    let ym = ymOf(date);
    if (+date.slice(8, 10) > closeDayOf(card, ym)) ym = addMonths(ym, 1);
    const debitYm = addMonths(ym, Number(card.debitOffset) || 1);
    return { closeDate: dateIn(ym, closeDayOf(card, ym)), debitYm: debitYm, debitDate: dateIn(debitYm, Number(card.debitDay) || 27) };
  }

  /**
   * カードの請求をまとめる。
   * opts.until … この日までの記録を数える（省略時は全部）
   * opts.planned … 予定（固定費など）のカード払い分を足す { key: 金額 }
   */
  function bills(m, opts) {
    opts = opts || {};
    const out = {};
    const get = (card, cyc) => {
      const key = card.id + '|' + cyc.debitYm;
      if (!out[key]) {
        const row = m.billRows[key];
        out[key] = { key: key, card: card.id, cardName: card.name, ym: cyc.debitYm, debitDate: cyc.debitDate, closeDate: cyc.closeDate,
          payFrom: card.payFrom, used: 0, count: 0, planned: 0, override: row && row.amount !== '' ? Number(row.amount) : null,
          status: (row && row.status) || '自動', memo: row ? row.memo : '' };
      }
      return out[key];
    };
    m.tx.forEach((t) => {
      if (opts.until && t.date > opts.until) return;
      const from = m.w[t.from], to = m.w[t.to];
      if (isCard(from) && (t.type === '支出' || t.type === '振替')) { const b = get(from, cycleOf(from, t.date)); b.used += t.amount; b.count++; }
      if (isCard(to) && t.type === '収入') { const b = get(to, cycleOf(to, t.date)); b.used -= t.amount; b.count++; }
    });
    // 引き落とし前の請求は、記録がなくても枠を出す（請求額を確定できるように）
    if (opts.withOpen !== false) {
      m.cards.forEach((card) => {
        [m.today, addDays(m.today, -31)].forEach((d) => {
          const cyc = cycleOf(card, d);
          if (cyc.debitDate > m.today) get(card, cyc);
        });
      });
    }
    Object.keys(m.billRows).forEach((key) => {
      const row = m.billRows[key], card = m.w[row.card];
      if (!isCard(card) || out[key]) return;
      const debitDate = dateIn(row.ym, Number(card.debitDay) || 27);
      get(card, { debitYm: row.ym, debitDate: debitDate, closeDate: '' });
    });
    if (opts.planned) {
      Object.keys(opts.planned).forEach((key) => {
        const p = opts.planned[key];
        const b = get(p.card, p.cyc);
        b.planned += p.amount;
      });
    }
    Object.keys(out).forEach((k) => {
      const b = out[k];
      b.confirmed = b.override !== null;
      b.amount = b.confirmed ? b.override : b.used + b.planned;
    });
    return out;
  }

  /** カードごとの「次に引き落とされる請求」と「いま使っている分」 */
  function cardStatus(m) {
    const all = bills(m);
    return m.cards.map((card) => {
      const list = Object.keys(all).map((k) => all[k]).filter((b) => b.card === card.id).sort((a, b) => a.debitDate.localeCompare(b.debitDate));
      const upcoming = list.filter((b) => b.debitDate > m.today && (b.amount !== 0 || !b.confirmed));
      const failed = list.filter((b) => b.status === '引き落とし不可');
      const paid = m.tx.filter((t) => t.type === '振替' && t.to === card.id).reduce((s, t) => s + t.amount, 0);
      const owed = upcoming.filter((b) => b.status !== '引き落とし不可').reduce((s, b) => s + b.amount, 0) +
        Math.max(0, failed.reduce((s, b) => s + b.amount, 0) - paid);
      const cur = cycleOf(card, m.today);
      return { card: card, bills: list, upcoming: upcoming, next: upcoming[0] || null, owed: owed, current: all[card.id + '|' + cur.debitYm] || null, cycle: cur };
    });
  }

  /* ================= 残高 ================= */
  function counts(t, w) {
    // 開始残高を入れたあとに起きたお金の動きだけ数える
    if (!w.openingAt) return false;
    const od = w.openingAt.slice(0, 10);
    if (t.date > od) return true;
    if (t.date < od) return false;
    return (t.created || '') > w.openingAt;
  }

  /** 口座ごとの、asOf の日の終わりの残高 */
  function balances(m, asOf) {
    asOf = asOf || m.today;
    const res = {};
    m.walletsAll.filter(isAccount).forEach((w) => {
      res[w.id] = { id: w.id, name: w.name, opening: w.opening === '' ? null : Number(w.opening), noOpening: !w.openingAt || w.opening === '',
        balance: Number(w.opening) || 0, inSum: 0, outSum: 0, debits: 0, adjust: 0, count: 0 };
    });
    m.tx.forEach((t) => {
      if (t.date > asOf) return;
      const from = m.w[t.from], to = m.w[t.to];
      if (isAccount(from) && (t.type === '支出' || t.type === '振替') && counts(t, from)) { const r = res[from.id]; r.balance -= t.amount; r.outSum += t.amount; r.count++; }
      if (isAccount(to) && (t.type === '収入' || t.type === '振替') && counts(t, to)) { const r = res[to.id]; r.balance += t.amount; r.inSum += t.amount; r.count++; }
      if (isAccount(to) && t.type === '残高合わせ' && counts(t, to)) { const r = res[to.id]; r.balance += t.amount; r.adjust += t.amount; r.count++; }
    });
    const all = bills(m, { until: asOf });
    Object.keys(all).forEach((k) => {
      const b = all[k], acc = m.w[b.payFrom];
      if (!isAccount(acc) || !res[acc.id] || b.status === '引き落とし不可' || b.debitDate > asOf || !acc.openingAt) return;
      if (b.debitDate <= acc.openingAt.slice(0, 10)) return;   // 開始残高に含まれている
      res[acc.id].balance -= b.amount; res[acc.id].debits += b.amount;
    });
    return res;
  }

  /* ================= 予定 ================= */
  function planOccurs(p, ym) {
    if (p.start && ym < p.start) return false;
    if (p.end && ym > p.end) return false;
    const mo = +ym.slice(5, 7), y = +ym.slice(0, 4);
    if (p.months) { if (String(p.months).split(',').map(Number).indexOf(mo) < 0) return false; }
    const every = p.every === '' || p.every === undefined ? 1 : Number(p.every);
    const sy = p.start ? +p.start.slice(0, 4) : null;
    if (every === 0) return sy === null ? true : y === sy && (!p.start || ym >= p.start);
    if (every > 1 && sy !== null && (y - sy) % every !== 0) return false;
    return true;
  }
  function planRef(p, ym) { return 'p:' + p.id + ':' + ym; }

  /** ym の月に起きる予定の一覧（記録済みかどうかも） */
  function occurrences(m, ym, kinds) {
    return m.plans.filter((p) => (!kinds || kinds.indexOf(p.kind) >= 0) && planOccurs(p, ym)).map((p) => {
      const ref = planRef(p, ym);
      const done = m.done[ref] || null;
      return { plan: p, ym: ym, ref: ref, date: dateIn(ym, Number(p.day) || 1), monthOnly: !p.day, done: done,
        planned: Number(p.amount) || 0, actual: done ? done.amount : null, wallet: m.w[p.wallet] || null, to: m.w[p.to] || null };
    }).sort((a, b) => a.date.localeCompare(b.date) || String(a.plan.name).localeCompare(String(b.plan.name), 'ja'));
  }

  /** 次の予定日（年間の支払い用） */
  function nextOccurrence(m, p, fromYm, maxMonths) {
    for (let i = 0; i < (maxMonths || 72); i++) {
      const ym = addMonths(fromYm, i);
      if (planOccurs(p, ym)) return ym;
    }
    return null;
  }

  /* ================= 見通し ================= */
  /**
   * 今日から days 日先までの、お金の出入りと口座ごとの残高の動き
   */
  function projection(m, days) {
    days = days || 62;
    const end = addDays(m.today, days);
    const bal = balances(m, m.today);
    const events = [];
    const planned = {};
    const curYm = ymOf(m.today);

    for (let ym = curYm; ym <= ymOf(end); ym = addMonths(ym, 1)) {
      occurrences(m, ym).forEach((o) => {
        if (o.done || !o.planned) return;   // 金額0の予定（金額未定）は見通しに入れない
        let date = o.date, overdue = false;
        const w = o.wallet;
        const isTr = o.plan.kind === '振替';
        // 開始残高を入れた日までの予定は、開始残高に含まれている扱い
        if (isAccount(w) && w.openingAt && o.date <= w.openingAt.slice(0, 10)) return;
        if (isTr && isAccount(o.to) && o.to.openingAt && o.date <= o.to.openingAt.slice(0, 10)) return;
        if (date <= m.today) {
          if (ym !== curYm) return;
          overdue = true; date = m.today;
        }
        if (date > end) return;
        const ev = { date: date, kind: 'plan', planKind: o.plan.kind, title: o.plan.name, amount: o.planned, wallet: w ? w.id : '', walletName: (w ? w.name : '') + (isTr ? ' → ' + (o.to ? o.to.name : '未設定') : ''),
          sign: o.plan.kind === '収入' ? 1 : -1, ref: o.ref, plan: o.plan.id, ym: ym, overdue: overdue, monthOnly: o.monthOnly, origDate: o.date, to: isTr && o.to ? o.to.id : '' };
        if (isCard(w) && ev.sign < 0) {
          const cyc = cycleOf(w, o.date);
          if (cyc.debitDate <= m.today) return;   // もう引き落とし済みの請求に入る分
          const key = w.id + '|' + cyc.debitYm;
          if (!planned[key]) planned[key] = { card: w, cyc: cyc, amount: 0 };
          planned[key].amount += o.planned;
          ev.viaCard = true; ev.debitDate = cyc.debitDate;
        }
        events.push(ev);
      });
    }

    const all = bills(m, { planned: planned });
    Object.keys(all).forEach((k) => {
      const b = all[k];
      if (b.debitDate <= m.today || b.debitDate > end || b.status === '引き落とし不可' || (!b.amount && b.confirmed)) return;
      const acc = m.w[b.payFrom];
      events.push({ date: b.debitDate, kind: 'debit', title: b.cardName + 'の引き落とし', amount: b.amount, wallet: acc ? acc.id : '', walletName: acc ? acc.name : '（引き落とし口座が未設定）',
        sign: -1, card: b.card, ym: b.ym, confirmed: b.confirmed, used: b.used, planned: b.planned, key: k });
    });

    m.deadlines.forEach((d) => {
      if (d.done || !d.date) return;
      const left = diffDays(m.today, d.date);
      if (d.date <= end && left >= 0) events.push({ date: d.date, kind: 'deadline', title: d.name, amount: null, sign: 0, who: d.who, memo: d.memo, left: left, id: d.id });
    });

    const order = { plan: 1, debit: 2, deadline: 3 };
    events.sort((a, b) => a.date.localeCompare(b.date) || (b.sign - a.sign) || (order[a.kind] - order[b.kind]) || String(a.title).localeCompare(String(b.title), 'ja'));

    const run = {};
    m.accounts.forEach((a) => { const r = bal[a.id]; run[a.id] = { id: a.id, name: a.name, now: r ? r.balance : 0, min: r ? r.balance : 0, minDate: m.today, end: r ? r.balance : 0, noOpening: r ? r.noOpening : true }; });
    events.forEach((ev) => {
      if (!ev.amount) return;
      const r = run[ev.wallet];
      if (r && !ev.viaCard) {
        r.end += ev.sign * ev.amount;
        ev.after = r.end;
        if (r.end < r.min) { r.min = r.end; r.minDate = ev.date; }
      }
      const t = run[ev.to];   // 振替の予定：移す先が増える
      if (t) { t.end += ev.amount; ev.toAfter = t.end; }
    });
    return { end: end, events: events, accounts: m.accounts.map((a) => run[a.id]), bills: all };
  }

  /* ================= 月の集計 ================= */
  function month(m, ym) {
    const txs = m.tx.filter((t) => ymOf(t.date) === ym);
    const cats = {};
    m.categoriesAll.forEach((c) => { cats[c.id] = { id: c.id, name: c.name, icon: c.icon, kind: c.kind, group: c.group, budget: c.budget === '' ? null : Number(c.budget), total: 0, count: 0 }; });
    const none = { id: '', name: '分類なし', icon: '・', kind: '支出', group: '生活費', budget: null, total: 0, count: 0 };
    let expense = 0, income = 0, household = 0, outside = 0, tatekae = 0;
    const byUser = {}, byWallet = {};
    txs.forEach((t) => {
      if (t.type !== '支出' && t.type !== '収入') return;
      const c = cats[t.category] || none;
      c.total += t.amount; c.count++;
      if (t.type === '支出') {
        expense += t.amount;
        if (c.group === '立替（あとで戻る）') tatekae += t.amount;
        else if (c.group === '生活費の外') outside += t.amount;
        else household += t.amount;
        byUser[t.user || '不明'] = (byUser[t.user || '不明'] || 0) + t.amount;
        byWallet[t.from] = (byWallet[t.from] || 0) + t.amount;
      } else income += t.amount;
    });
    const list = Object.keys(cats).map((k) => cats[k]).concat(none.count ? [none] : []);
    const expenseCats = list.filter((c) => c.kind === '支出' && (c.total || c.budget)).sort((a, b) => b.total - a.total);
    const incomeCats = list.filter((c) => c.kind === '収入' && c.total).sort((a, b) => b.total - a.total);
    const budget = list.filter((c) => c.kind === '支出' && c.group === '生活費' && c.budget).reduce((s, c) => s + c.budget, 0);
    const fixed = occurrences(m, ym, ['固定費']);
    const fx = { items: fixed, total: fixed.length, done: fixed.filter((o) => o.done).length,
      planned: fixed.filter((o) => o.plan.inBudget !== false).reduce((s, o) => s + o.planned, 0),
      expected: fixed.filter((o) => o.plan.inBudget !== false).reduce((s, o) => s + (o.done ? o.actual : o.planned), 0) };
    const incomePlans = occurrences(m, ym, ['収入']);
    const plannedIncome = incomePlans.reduce((s, o) => s + (o.done ? o.actual : o.planned), 0);
    const dim = dimOf(ym);
    const dayRatio = ym < ymOf(m.today) ? 1 : ym > ymOf(m.today) ? 0 : +m.today.slice(8, 10) / dim;
    return { ym: ym, tx: txs, expense: expense, income: income, household: household, outside: outside, tatekae: tatekae,
      budget: budget, expenseCats: expenseCats, incomeCats: incomeCats, byUser: byUser, byWallet: byWallet,
      fixed: fx, plannedIncome: plannedIncome, dayRatio: dayRatio };
  }

  function tatekaeOpen(m) {
    const list = m.tx.filter((t) => t.type === '支出' && t.settle === '未精算');
    return { count: list.length, total: list.reduce((s, t) => s + t.amount, 0), list: list };
  }

  /* ================= 年間・ボーナス ================= */
  function annual(m) {
    const curYm = ymOf(m.today);
    const items = m.plans.filter((p) => p.kind === '年間').map((p) => {
      const ym = nextOccurrence(m, p, curYm);
      const every = p.every === '' || p.every === undefined ? 1 : Number(p.every);
      const per = p.months ? String(p.months).split(',').length : 12;
      const yearly = every === 0 ? 0 : (Number(p.amount) || 0) * per / Math.max(1, every);
      return { plan: p, nextYm: ym, done: ym ? m.done[planRef(p, ym)] || null : null, yearly: yearly };
    }).sort((a, b) => String(a.nextYm || '9999').localeCompare(String(b.nextYm || '9999')));
    const reserve = items.filter((i) => i.plan.reserve).reduce((s, i) => s + i.yearly, 0) / 12;
    return { items: items, monthlyReserve: Math.round(reserve) };
  }

  function bonusView(m) {
    return m.bonuses.map((b) => {
      const items = m.allocs.filter((a) => a.bonus === b.id).map((a) => ({ alloc: a, done: m.done['a:' + a.id] || null, toName: m.w[a.to] ? m.w[a.to].name : '' }));
      const total = items.reduce((s, i) => s + (Number(i.alloc.amount) || 0), 0);
      return { bonus: b, items: items, total: total, rest: (Number(b.net) || 0) - total, doneCount: items.filter((i) => i.done).length,
        walletName: m.w[b.wallet] ? m.w[b.wallet].name : '' };
    });
  }

  /* ================= 注意 ================= */
  function alerts(m, proj) {
    proj = proj || projection(m, 62);
    const out = [];
    const add = (level, type, text, vars, extra) => out.push(Object.assign({ level: level, type: type, text: text, vars: vars || {} }, extra || {}));
    const noOpen = m.accounts.filter((a) => !a.openingAt || a.opening === '');
    if (noOpen.length) add('高', 'no_opening', (noOpen.length === 1 ? noOpen[0].name + 'の' : noOpen.length + 'つの口座の') + '開始残高がまだです。今の残高を入れると、残高と見通しを計算できます。', {}, { appOnly: true });
    proj.accounts.forEach((a) => {
      if (!a.noOpening && a.min < 0) add('高', 'shortfall', a.name + 'が' + md(a.minDate) + 'ごろ ' + yen(-a.min) + ' 足りなくなる見込みです。',
        { 口座: a.name, 日付: md(a.minDate), 不足額: yen(-a.min) }, { wallet: a.id });
    });
    proj.events.filter((e) => e.kind === 'debit').forEach((e) => {
      const left = diffDays(m.today, e.date);
      if (left <= 3 && e.amount > 0) add('高', 'debit_soon', e.title + 'が' + afterText(left) + '（' + md(e.date) + '）。' + yen(e.amount) + '／' + e.walletName,
        { カード: e.title.replace(/の引き落とし$/, ''), あと: afterText(left), 日付: md(e.date), 金額: yen(e.amount), 口座: e.walletName }, { card: e.card });
      if (!e.confirmed && left <= 12 && (e.amount > 0 || e.used !== 0)) add('中', 'bill_unconfirmed', e.title.replace(/の引き落とし$/, '') + 'の' + md(e.date) + '分の請求額が未確定です（見込み ' + yen(e.amount) + '）。明細を見て確定してください。',
        {}, { card: e.card, ym: e.ym, appOnly: true });
    });
    // 引き落とし日を過ぎたのに請求額を確定していない（記録もれがあると口座の残高がずれる）
    const allBills = bills(m);
    Object.keys(allBills).forEach((k) => {
      const b = allBills[k];
      const ago = diffDays(b.debitDate, m.today);
      if (b.confirmed || b.status !== '自動' || ago < 1 || ago > 10 || !b.used) return;
      const acc = m.w[b.payFrom];
      if (!acc || !acc.openingAt || b.debitDate <= acc.openingAt.slice(0, 10)) return;
      add('中', 'bill_passed', b.cardName + 'の' + md(b.debitDate) + '分は、記録から計算した ' + yen(b.amount) + ' で引いています。明細と違うときは確定してください。', {}, { card: b.card, appOnly: true });
    });
    proj.events.filter((e) => e.kind === 'plan' && e.overdue).forEach((e) => {
      add('中', 'plan_overdue', e.title + '（' + md(e.origDate) + (e.monthOnly ? 'の月' : '') + '）がまだ記録されていません。' + (e.planKind === '収入' ? '入金されたら' : '払ったら') + '「記録する」を押してください。', {}, { ref: e.ref, appOnly: true });
    });
    m.deadlines.forEach((d) => {
      if (d.done || !d.date) return;
      const left = diffDays(m.today, d.date);
      if (left <= (Number(d.notice) || 30)) add(left < 0 ? '高' : '中', 'deadline', d.name + (left < 0 ? 'の期限が過ぎています（' : 'の期限まであと' + left + '日（') + md(d.date) + '）。',
        { 項目: d.name, 期限日: md(d.date), 日数: String(left), メモ: d.memo || '' }, { who: d.who, deadline: d.id });
    });
    m.cards.forEach((c) => {
      if (!c.expiry) return;
      const lastDay = dateIn(c.expiry, 31);
      const left = diffDays(m.today, lastDay);
      if (left <= 60) add('中', 'card_expire', c.name + 'の有効期限が' + c.expiry.replace('-', '年') + '月で' + (left < 0 ? '切れています。' : '切れます。'), { カード: c.name, 期限: c.expiry.replace('-', '/') }, { card: c.id });
      if (!c.payFrom) add('中', 'card_nopay', c.name + 'の引き落とし口座が未設定です。', {}, { card: c.id, appOnly: true });
    });
    const s = month(m, ymOf(m.today));
    s.expenseCats.forEach((c) => {
      if (c.group !== '生活費' || !c.budget) return;
      if (c.total > c.budget) add('中', 'budget_over', c.name + 'が今月の予算を ' + yen(c.total - c.budget) + ' 超えています。', {}, { category: c.id, appOnly: true });
      else if (c.total >= c.budget * 0.9 && s.dayRatio < 0.9) add('低', 'budget_near', c.name + 'が予算の ' + Math.round(c.total / c.budget * 100) + '% に達しました（残り ' + yen(c.budget - c.total) + '）。', {}, { category: c.id, appOnly: true });
    });
    m.todos.forEach((t) => {
      if (t.done || !t.due) return;
      const left = diffDays(m.today, t.due);
      if (left <= 3) add(left < 0 ? '高' : '中', 'todo', 'やること：' + t.title + (left < 0 ? '（期限 ' + md(t.due) + ' を過ぎています）' : '（' + (left === 0 ? '今日' : 'あと' + left + '日') + '・' + md(t.due) + '）'),
        { 項目: t.title, 期限日: md(t.due), 日数: String(left), メモ: t.memo || '' }, { todo: t.id, who: t.who === '二人' ? 'グループ' : t.who, appOnly: true });
    });
    const order = { '高': 0, '中': 1, '低': 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  /* ================= 表示用 ================= */
  function yen(n) { return (n < 0 ? '−' : '') + Math.abs(Math.round(Number(n) || 0)).toLocaleString('ja-JP') + '円'; }
  function md(s) { return s ? (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) : ''; }
  function afterText(n) { return n <= 0 ? '今日' : n === 1 ? '明日' : 'あと' + n + '日'; }

  return {
    SCHEMA: SCHEMA, TABLES: TABLES, WHO: WHO, clean: clean,
    pad: pad, toDateStr: toDateStr, addDays: addDays, diffDays: diffDays, ymOf: ymOf, addMonths: addMonths, dateIn: dateIn, dimOf: dimOf, weekday: weekday,
    isAccount: isAccount, isCard: isCard, build: build, cycleOf: cycleOf, bills: bills, cardStatus: cardStatus, balances: balances,
    planOccurs: planOccurs, planRef: planRef, occurrences: occurrences, nextOccurrence: nextOccurrence, projection: projection,
    month: month, tatekaeOpen: tatekaeOpen, annual: annual, bonusView: bonusView, alerts: alerts,
    yen: yen, md: md, afterText: afterText, normText: normText, parseReceipt: parseReceipt, classifyReceipt: classifyReceipt, splitByCategory: splitByCategory
  };
})();
if (typeof module !== 'undefined') module.exports = Engine;
