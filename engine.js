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
  const WHO = ['夫', '妻', 'PC'];   // 入力者：夫・妻・PC（家のPCで入れた記録）
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
        { k: 'created', label: '登録日時', type: 'datetime', ro: true },
        // 外貨（ドル）で入れた記録。計算は「金額（円）」で行い、ドルの金額とレートは記録として残す
        { k: 'cur', label: '通貨', type: 'select', opts: ['', 'USD'] },
        { k: 'famt', label: '外貨の金額（ドル）', type: 'dec', dp: 2, fmt: '#,##0.00' },
        { k: 'fx', label: 'レート（1ドル＝円）', type: 'dec', dp: 4, fmt: '0.00##' },
        { k: 'fxAt', label: 'レートの時点', type: 'text' },
        // レシートから登録した記録：同じレシートの記録（分けて登録したもの）と品目をつなぐ
        { k: 'rcpt', label: 'レシートID', type: 'text' }
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
    pins: {
      sheet: '固定表示', label: 'いつも上に出す（夫・妻それぞれ）', prefix: 'pn',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'user', label: 'だれの設定か', type: 'select', opts: WHO, req: true },
        { k: 'table', label: '対象', type: 'select', opts: ['wallets', 'categories'], req: true },
        { k: 'ref', label: '口座・カード／分類', type: 'text', req: true },
        { k: 'order', label: '並び順', type: 'int', def: 0 }
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
    },
    items: {
      sheet: 'レシートの品目', label: 'レシートの品目（内訳）', prefix: 'it',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'rcpt', label: 'レシートID', type: 'text', req: true },
        { k: 'tx', label: '記録ID', type: 'text' },
        { k: 'date', label: '日付', type: 'date' },
        { k: 'store', label: 'お店', type: 'text' },
        { k: 'name', label: '品名', type: 'text', req: true },
        { k: 'price', label: '金額（レシートの表示）', type: 'sint' },
        { k: 'category', label: '分類', type: 'ref', ref: 'categories' },
        { k: 'reduced', label: '軽減税率（8%）', type: 'bool', def: false }
      ]
    },
    passes: {
      sheet: '定期券', label: '定期券（交通費の計算用）', prefix: 'ps',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'user', label: 'だれの定期か', type: 'select', opts: WHO, req: true },
        { k: 'name', label: '名前（例 通勤定期）', type: 'text', req: true },
        { k: 'route', label: '定期の区間（乗り換える駅を「〜」でつなぐ。例 鎌ケ谷大仏〜新津田沼〜津田沼〜横浜〜戸部）', type: 'text', req: true },
        { k: 'start', label: '使い始め', type: 'date' },
        { k: 'end', label: '有効期限', type: 'date' },
        { k: 'memo', label: 'メモ', type: 'text' }
      ]
    },
    routes: {
      sheet: '交通費の区間', label: '交通費の区間', prefix: 'rt',
      fields: [
        { k: 'id', type: 'id' },
        { k: 'user', label: 'だれの区間か', type: 'select', opts: WHO, req: true },
        { k: 'from', label: '出発駅（定期の外に出る駅）', type: 'text', req: true },
        { k: 'to', label: '到着駅', type: 'text', req: true },
        { k: 'fare', label: '片道の運賃（定期区間を除く・IC）', type: 'int', req: true },
        { k: 'line', label: '経路のメモ（例 JR東海道線）', type: 'text' },
        { k: 'category', label: 'いつもの分類', type: 'ref', ref: 'categories' },
        { k: 'wallet', label: 'いつもの支払い', type: 'ref', ref: 'wallets' },
        { k: 'memo', label: 'メモ', type: 'text' }
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
    if (table === 'tx') {
      if (!out.cur) { out.famt = ''; out.fx = ''; out.fxAt = ''; }
      checkTx(out);
    }
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
      case 'dec': {   // 小数（ドルの金額・レート）
        if (s === '') return '';
        const n = Number(s.replace(/[,，$＄円¥\s]/g, ''));
        if (!isFinite(n) || n < 0 || n > 1e9) bad('は0以上の数字で入れてください。');
        const k = Math.pow(10, f.dp === undefined ? 2 : f.dp);
        return Math.round(n * k) / k;
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
    if (t.cur) {
      if (t.type === '残高合わせ') throw new Error('残高合わせは円で入れてください。');
      if (!(t.famt > 0)) throw new Error('ドルの金額を入れてください。');
      if (!(t.fx > 0)) throw new Error('ドルのレートを入れてください。');
    }
  }
  /** 定期の区間「A〜B〜C」→ 駅の一覧 */
  function passStations(route) {
    return String(route || '').split(/[〜～~→⇔↔、,・\/／\s\-－]+/).map((x) => x.replace(/駅$/, '').trim()).filter(Boolean);
  }
  /** 駅名をくらべるための形（「駅」・空白・ケ/ヶの違いをそろえる） */
  function stationKey(s) { return String(s || '').replace(/\s/g, '').replace(/駅$/, '').replace(/[ヶケが]/g, 'ケ'); }
  /** 外貨の金額 × レート → 円（1円未満は四捨五入） */
  function fxYen(famt, fx) {
    const a = Number(famt), r = Number(fx);
    if (!(a > 0) || !(r > 0)) return 0;
    return Math.round(Math.round(a * 100) * r / 100 + 1e-9);
  }
  function usd(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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
    return String(s || '').normalize('NFKC').replace(/[‐－―ー−]/g, (c) => (c === 'ー' ? c : '-')).replace(/[￥\\]/g, '¥').replace(/\r/g, '')
      // 文字認識のよくある読み違い：「¥」→「半・Y・羊」、「2,715」→「2.715」「2, 715」、数字の中の O・l
      .replace(/(^|[\s:：])[半羊Y](?=\s*\d)/g, '$1¥')
      .replace(/(\d)\s*[.,]\s*(\d{3})(?!\d)/g, '$1,$2')
      .replace(/(\d)[Oo](?=\d)/g, '$10').replace(/(\d)[lI|](?=\d)/g, '$11');
  }

  /** 合計の候補を集めて、根拠の強さで点数を付ける。いちばん点の高いものを合計とする */
  function totalCandidates(lines, itemsSum) {
    const num = (str) => { const m = /(-?\d{1,3}(?:,\d{3})+|-?\d{1,7})(?!.*\d)/.exec(String(str).replace(/\d+\s*点/g, '').replace(/[¥円]/g, '')); return m ? Number(m[1].replace(/,/g, '')) : null; };
    const onlyNum = (l) => /^[¥\s]*-?[\d,]+\s*円?\s*[※*軽]?$/.test(l);
    const cands = {};
    const add = (v, pts, why) => {
      if (v === null || !(v > 0) || v > 1000000) return;
      const c = cands[v] || (cands[v] = { value: v, score: 0, why: [] });
      c.score += pts; if (c.why.indexOf(why) < 0) c.why.push(why);
    };
    const KW = [[/(総合計|合\s*計|お買上げ?(金額|計)?|お買い上げ|ご請求額?|お会計)/, 6, '合計'], [/(お支払い?(金額|額)?|支払金額)/, 5, 'お支払'], [/小\s*計/, 2, '小計']];
    const PAY = /(クレジット|カード|電子マネー|PayPay|paypay|QUICPay|iD|Suica|PASMO|WAON|nanaco|楽天ペイ|d払い|au ?PAY|交通系)/i;
    const NOT = /(お預|預り|預かり|釣|対象|税額|内税|外税|消費税|点数|ポイント|残高|値引前)/;
    let dep = null, chg = null;
    lines.forEach((l, i) => {
      const v = onlyNum(l) ? null : num(l);
      if (/(お預|預り|預かり)/.test(l) && v !== null) dep = v;
      if (/(お釣|釣り|おつり|釣銭)/.test(l) && v !== null) chg = v;
      if (NOT.test(l)) return;
      KW.forEach(([re, pts, why]) => {
        if (!re.test(l)) return;
        let x = num(l.replace(re, ''));
        if ((x === null || x === 0) && lines[i + 1] && onlyNum(lines[i + 1])) x = num(lines[i + 1]);
        add(x, pts, why);
      });
      if (PAY.test(l) && v !== null) add(v, 3, '支払い方法の行');
    });
    // 項目名だけが並び、そのあと金額だけが同じ順に並ぶ形（表の2列が別々に読まれたとき）
    for (let i = 0; i < lines.length; i++) {
      const labels = [];
      let j = i;
      while (j < lines.length && !onlyNum(lines[j]) && /[ぁ-んァ-ン一-龥]/.test(lines[j]) && num(lines[j]) === null) { labels.push(lines[j]); j++; }
      const vals = [];
      while (j < lines.length && onlyNum(lines[j])) { vals.push(num(lines[j])); j++; }
      if (labels.length >= 2 && vals.length >= 2) {
        const n = Math.min(labels.length, vals.length);
        for (let k = 0; k < n; k++) {
          const lab = labels[labels.length - n + k], v = vals[k];
          if (/(お預|預り|預かり)/.test(lab)) dep = v;
          else if (/(お釣|釣り|おつり)/.test(lab)) chg = v;
          else if (!NOT.test(lab)) KW.forEach(([re, pts, why]) => { if (re.test(lab)) add(v, pts, why + '（列）'); });
        }
        i = j - 1;
      }
    }
    if (dep !== null && chg !== null && dep - chg > 0) add(dep - chg, 8, 'お預り−お釣り');
    // 数字どうしの関係で裏付ける（列が別々に読まれて、項目名と金額の対応がわからないときに効く）
    const all = [];
    lines.forEach((l) => {
      if (/(残高|ポイント|会員|No[.\-:：]|TEL|電話|登録番号|レジ|取引|\d{1,2}:\d{2}|20\d{2}\s*[年\/])/.test(l)) return;
      (l.replace(/\d+\s*点/g, '').replace(/[¥円()]/g, ' ').match(/-?\d{1,3}(?:,\d{3})+|-?\d{1,7}/g) || []).forEach((x) => { const v = Number(x.replace(/,/g, '')); if (Math.abs(v) <= 1000000 && v !== 0) all.push(v); });
    });
    const pos = all.filter((v) => v > 0), neg = all.filter((v) => v < 0);
    const count = {}; pos.forEach((v) => { count[v] = (count[v] || 0) + 1; });
    const pset = {}; pos.forEach((v) => { pset[v] = true; });
    Object.keys(count).map(Number).filter((v) => v >= 50).forEach((v) => {
      if (count[v] >= 2) add(v, count[v] >= 3 ? 3 : 2, '同じ金額が' + count[v] + '回');
      if (itemsSum > 0 && neg.some((n) => itemsSum + n === v)) add(v, 4, '小計−割引');
      for (const a of pos) { if (a < v && a !== v - a && pset[v - a] && a >= v * 0.01) { add(v, 4, '税率ごとの額の合計'); break; } }
    });
    if (itemsSum > 0) Object.keys(cands).forEach((k) => {
      const c = cands[k];
      if (c.value === itemsSum) { c.score += 2; c.why.push('品目の合計と一致'); }
      else if (c.value > itemsSum && c.value <= Math.ceil(itemsSum * 1.105)) { c.score += 3; c.why.push('品目の合計＋税と合う'); }
    });
    if (itemsSum > 0 && !Object.keys(cands).length) add(itemsSum, 1, '品目の合計');
    return Object.keys(cands).map((k) => cands[k]).sort((a, b) => b.score - a.score || b.value - a.value).slice(0, 6);
  }
  // 品目の行ではないもの（店の案内・支払い・税の内訳など）
  const SKIP = /(まとめ売り\s*\d+\s*個以上|\d+\s*個以上\s*1\s*個|合計|小計|総計|お買上|お買い上げ|お預|預り|預かり|釣|おつり|お釣|消費税|税額|税抜|税込|内税|外税|課税|税率\s*\d|\d+(?:\.\d)?%\s*対象|対象額|対象割引|[都道府県].*[市区町村郡]|[市区町村].*\d+-\d+|ポイント|点数|クレジット|電子マネー|PayPay|nanaco|WAON|Suica|残高|支払|現金|領収|レジ(?!袋)|担当|TEL|電話|☎|No[.\-:：]|伝票|会員|ありがとう|株式会社|〒|登録番号|値引前|お取替|返品|保管|募集|アプリ|検索|通販|ご案内|発行者|取引|店内|持帰|テイクアウト|^[-=*_~\s]+$)/i;
  // 「品名 … 金額」の金額の部分。金額の前の「*」「※」（軽減税率の印）や、後ろの「※」「外」「J」などの印も受け付ける
  const PRICE = /[*※＊]?\s*(-?\s*¥?\s*\d{1,3}(?:,\d{3})+|-?\s*¥?\s*\d{1,6})\s*円?\s*([※*＊軽外内JＪ]|\(軽\)|\(8%\)|\(10%\))?\s*$/;
  // 数量の行：「(¥154 X 3個)」「(@100 × 2個)」「(2個¥100 × 1組)」「¥130 2個 ¥260」
  const QTY = /^[(（]?\s*(?:\d+\s*個\s*)?[¥@]?\s*[\d,]+\s*(?:[xX×*]\s*\d+\s*(?:個|点|コ|本|組|袋|枚)?|\s+\d+\s*(?:個|点|コ|本|組|袋|枚))\s*[)）]?(?:\s*¥?\s*([\d,]+))?\s*$/;
  // 数量が先に来る行：「2コX単118 ¥236」「2個×@118 236」「3点 x 単価100 ¥300」
  const QTY2 = /^[(（]?\s*\d+\s*(?:個|コ|ｺ|点|本|袋|枚|ケ|組)\s*[xX×*]\s*(?:単価?|@|¥)?\s*[\d,]+\s*円?\s*[)）]?(?:\s*¥?\s*([\d,]+))?\s*$/;
  // 売り場・部門の番号（「551+」「#010」「100E」など）
  const DEPT = /^([#＃])?\s*\d{2,4}(?:[+＋]\s*|[EＥ]\s+|[※*＊]\s*|\s+)/;
  const REDUCED = /([※*＊]|\(軽|（軽|\(8%\)|軽減)/;
  // 品目ではない行：電話番号・店名・住所・登録番号・レシート番号など（読み違いも含めて広く見る）
  const PHONE = /(?:^|[^\d])\(?0\d{1,4}\)?\s*[-‐ー－−~〜.\s]\s*\d{1,4}\s*[-‐ー－−~〜.\s]\s*\d{3,4}(?!\d)/;
  const NOT_ITEM = /(TEL|Te[l1]|ＴＥＬ|℡|☎|☏|電話|FAX|ファックス|フリーダイヤル|お問い?合わせ|店\s*$|店\s*[:：(（No№#]|店舗|本店|支店|営業所|〒|丁目|\d+-\d+-\d+|番地|[都道府県].*[市区町村]|[市区町村郡].*\d|T\d{13}|登録番号|事業者|No[.\-:：]|№|レシート|伝票|取引|担当|責[:：]|レジ(?!袋)|POS|会員|カード番号|残高|ポイント|有効期限|URL|www\.|https?:|\.co|\.jp|@)/i;
  const notItem = (l, store) => PHONE.test(l) || NOT_ITEM.test(l) || /\d{7,}/.test(l.replace(/[,\s]/g, '')) ||
    (store && store.split(/\s+/).some((w) => w.length >= 3 && l.indexOf(w) >= 0));

  /**
   * レシートの文字から、店名・日付・合計・品目を取り出す
   * 戻り値 { store, date, total, items:[{name, price, reduced}], hasReduced, candidates, itemsSum }
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
    // 店名：上のほうの「ブランド名」と「〇〇店」を組み合わせる（案内文・電話・住所は飛ばす）
    const NOISE = /(お取替|返品|保管|領\s*収|レシート|receipt|公式|アプリ|募集|検索|通販|〒|登録番号|ありがとう|いらっしゃい|ご来店|担当|レジ|\*{2,}|[都道府県].*[市区町村]|[市区町村].*\d+-\d+|^[\s\-=*_~<>()（）【】#]+$|^#?\d)/i;
    const head = lines.slice(0, 12).map((l) => l.replace(/\s*(☎|TEL|Tel|電話)\s*[:：]?\s*[\d-]{8,}.*$/, '').replace(/\s*\d{2,4}-\d{2,4}-\d{3,4}\s*$/, '')
      .replace(/\s*[^\s\d]?\s*[:：]?\s*\(?0\d{1,4}\)?\s*[-‐ー－−~〜.\s]\s*\d{1,4}\s*[-‐ー－−~〜.\s]\s*\d{3,4}.*$/, '').replace(/\s+[^\s店]$/, '').trim())
      .filter((l) => l && !NOISE.test(l) && !/(20\d{2}|令和)\s*[年\/]/.test(l) && l.replace(/[\d\s¥,.:\-\/()]/g, '').length >= 2);
    let bi = head.findIndex((l) => /店\s*$|店\s|店舗/.test(l));
    let branch = bi >= 0 ? head[bi] : '';
    if (branch && bi > 0 && /^.{1,3}店$/.test(branch)) { branch = head[bi - 1] + branch; bi--; }   // 「…鎌ケ」「谷店」と2行に分かれたとき
    const brand = head.find((l, i) => i !== bi && i < (bi < 0 ? 99 : bi) + 1 && !/店\s*$/.test(l) && !/\d{4}/.test(l)) || '';
    out.store = (branch && branch.length >= 9 ? branch : brand && branch && branch.indexOf(brand) < 0 ? brand + ' ' + branch : (branch || brand)).slice(0, 40);

    // 品目
    // 品目は、日付の行より下・小計より上にある。文字認識が「品名の列」と「金額の列」を別々に読むことがあるので、
    // 金額だけの行は小計より下も含めて順番に集めておき、余った品名と順番に組み合わせる
    const unpaired = [], priceOnly = [];
    let afterTotal = false, pending = null, nameRun = 0, nextReduced = false, body = !out.date;
    const push = (name, price, reduced) => {
      name = name.replace(/\s*[*※＊]?\s*[@¥]?\d[\d,]*\s*[(（]\s*\d+\s*(?:コ|個|点|本)\s*[)）]\s*$/, '')   // 「* 570 (2コ)」単価と個数
        .replace(/\s*[(（]\s*\d+\s*(?:コ|個|点|本)\s*[)）]\s*$/, '')                                     // 「(2コ)」
        .replace(/\s+特$/, '')                                                                              // ドラッグストアの「特」（特価）の印
        .replace(/[¥*※＊\s]+$/, '').replace(/^[*※＊☆★\s]+/, '').trim();
      if (/^[(（][^)）]*$/.test(name)) name = name.slice(1);                       // 閉じかっこのない「(」
      else if (/^[(（].*[)）]$/.test(name) && !/[(（]/.test(name.slice(1, -1))) name = name.slice(1, -1);   // 全体を囲む「( )」
      name = name.trim().slice(0, 40);
      if (!name || name.replace(/[\d\s.,%¥()（）@×xX-]/g, '').length < 1 || !price || Math.abs(price) >= 1000000) return false;
      // 品名の頭の英字1文字（「Aにんじん」の A）は、まとめ買い・ミックスマッチの組の印かもしれないので覚えておく
      const gm = /^([A-ZＡ-Ｚ])\s*(?=[ぁ-んァ-ヶ一-龥ｦ-ﾟ])/.exec(name);
      const grp = gm ? gm[1].replace(/[Ａ-Ｚ]/, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) : '';
      // （名前から外すのは、同じ印の「まとめ値引」が見つかったときだけ。「Pキュア…」のような品名はそのまま）
      out.items.push({ name: name, price: price, reduced: !!reduced, grp: grp || undefined });
      if (reduced) out.hasReduced = true;
      return true;
    };
    // 値引き・割引・ミックスマッチ（まとめ買い・セット割）の行
    const isDisc = (n, price) => /(値引|割引|引き|クーポン|OFF|▲|ﾈﾋﾞｷ)/i.test(n) || (price < 0 && /(ミックスマッチ|ﾐｯｸｽ|MM|まとめ|セット|よりどり|お得|サービス)/i.test(n));
    // 金額のない「20%」だけの値引き行は、直前の品目の値段から計算する
    const applyDisc = (list, n, price) => {
      if (!list.length) return;
      // 「Aまとめ値引」：同じ印（A）の品目に、値段の割合で分けて引く（1円未満は大きい品目に寄せる）
      const gm = /^\s*([A-ZＡ-Ｚ])\s*(?:まとめ|ミックス|ﾐｯｸｽ|MM|セット|よりどり|組)/i.exec(n);
      if (gm && price) {
        const g = gm[1].replace(/[Ａ-Ｚ]/, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toUpperCase();
        const grp = list.filter((it) => it.grp === g && it.price > 0);
        const sum = grp.reduce((a, it) => a + it.price, 0);
        if (grp.length && sum > 0) {
          const d = Math.abs(price);
          let used = 0;
          grp.slice().sort((a, b) => b.price - a.price).forEach((it, i, arr) => {
            const part = i === arr.length - 1 ? d - used : Math.round(d * it.price / sum);
            it.price -= part; used += part;
            it.name = it.name.replace(/^[A-ZＡ-Ｚ]\s*/, '');   // 組の印だとわかったので、名前から外す
          });
          return;
        }
      }
      const last = list[list.length - 1];
      let d = Math.abs(price || 0);
      const pct = /(\d{1,2})\s*%/.exec(n);
      if (!d && pct) d = Math.round(last.price * Number(pct[1]) / 100);
      last.price -= d;
    };
    lines.forEach((raw) => {
      raw = raw.replace(/^[·・･.]\s*(?=\d)/, '');   // 「·731 レジ袋L」の行頭の点
      if (/\d{1,2}:\d{2}/.test(raw) || /(20\d{2}|令和|R\d)\s*[年\/.]/.test(raw)) { pending = null; body = true; return; }   // 日付・時刻（ここから下が本文）
      if (!body) return;
      // 金額だけの行（小計より下も集める）
      const po = /^[*※＊]?\s*(-?\s*¥?\s*\d{1,3}(?:,\d{3})+|-?\s*¥?\s*\d{1,6})\s*円?\s*([※*＊軽外内JＪ])?\s*\)?$/.exec(raw);
      if (po && !/^[#＃]?\s*\d{2,4}[+＋EＥ]?$/.test(raw) && !PHONE.test(raw)) {
        const v = Number(po[1].replace(/[\s¥,]/g, ''));
        if (!afterTotal && pending && v > 0) { push(pending.name, v, pending.reduced || REDUCED.test(raw)); pending = null; nameRun = 0; return; }
        priceOnly.push({ price: v, reduced: REDUCED.test(raw) });
        return;
      }
      if (/(^|\s|\/)(小\s*計|合\s*計|お買上|お買い上げ|お会計)/.test(raw)) afterTotal = true;
      if (afterTotal) return;
      // 売り場の番号だけの行（「#030」「551+」）。「#」は軽減税率の印なので、次の品名に引き継ぐ
      const dOnly = /^([#＃])?\s*\d{2,4}[+＋EＥ]?$/.exec(raw);
      if (dOnly) { nextReduced = !!dOnly[1]; return; }
      // 数量の行
      const q = QTY.exec(raw) || QTY2.exec(raw);
      if (q) {
        if (pending && q[1]) { push(pending.name, Number(q[1].replace(/,/g, '')), pending.reduced); pending = null; nameRun = 0; }
        return;
      }
      if (SKIP.test(raw) || notItem(raw, out.store)) { pending = null; return; }
      const dept = DEPT.exec(raw);
      const reduced = nextReduced || !!(dept && dept[1]) || REDUCED.test(raw);
      nextReduced = false;
      const l = dept ? raw.slice(dept[0].length) : raw;
      const m = PRICE.exec(l);
      // 数字・¥・個などだけの行は、品名ではなく数量の行（「¥282個 ¥56」のように空白が消えて読まれても）
      if (m && !l.slice(0, m.index).replace(/[¥@\d,.\s個コｺ点本袋枚組xX×*()（）円単価]/g, '')) {
        const v = Number(m[1].replace(/[\s¥,]/g, ''));
        if (pending && v > 0) { push(pending.name, v, pending.reduced || reduced); pending = null; nameRun = 0; }
        return;
      }
      if (m) {
        let name = l.slice(0, m.index).trim();
        let price = Number(m[1].replace(/[\s¥,]/g, ''));
        // 「スタイルフリ-- ¥1,238」のように、品名の最後の「-」が金額の前にくっついているときは、マイナスではない
        if (price < 0 && m.index > 0 && /[^\s▲△]$/.test(l.slice(0, m.index + m[0].indexOf('-')))) { price = -price; name = (name + '-').trim(); }
        if (isDisc(name, price)) { applyDisc(out.items, name, price); pending = null; return; }   // 値引きは直前の品目から引く
        if (name && push(name, price, reduced)) { pending = null; nameRun = 0; return; }
      }
      if (/[ぁ-んァ-ン一-龥A-Za-z]{2,}/.test(l) && !/\d{5,}/.test(l)) {
        const nm = l.replace(/\s+[JＪ]$/, '');
        nameRun++;
        pending = nameRun === 1 ? { name: nm, reduced: reduced } : null;
        if (isDisc(nm, 0) && !priceOnly.length && out.items.length && !unpaired.length && /%/.test(nm)) { applyDisc(out.items, nm, 0); return; }   // 「▲値引 20%」だけで金額が読めなかった
        unpaired.push({ name: nm, reduced: reduced, disc: isDisc(nm, 0), after: out.items.length });
        return;
      }
      nameRun = 0;
    });
    // 品名の列と金額の列が別々に読まれたとき：組み合わせ直す
    const realUnpaired = unpaired.filter((u) => !out.items.some((it) => it.name === u.name.replace(/^[*※＊☆★\s]+/, '').trim()));
    if (realUnpaired.length >= 1 && priceOnly.length >= 1) {
      const rebuilt = [];
      // 名前の列：インラインで読めた品目と、余った品名を元の順に並べる
      const seq = [];
      let k = 0;
      realUnpaired.forEach((u) => { while (k < u.after && k < out.items.length) { seq.push({ item: out.items[k] }); k++; } seq.push({ u: u }); });
      while (k < out.items.length) { seq.push({ item: out.items[k] }); k++; }
      let pi = 0;
      seq.forEach((x) => {
        if (x.item) { rebuilt.push(Object.assign({}, x.item)); return; }
        const pr = priceOnly[pi++];
        if (!pr) return;
        if (x.u.disc || pr.price < 0) { applyDisc(rebuilt, x.u.name, pr.price); return; }
        if (pr.price > 0) rebuilt.push({ name: x.u.name, price: pr.price, reduced: x.u.reduced || pr.reduced });
      });
      if (rebuilt.length > out.items.length) {
        out.items = []; out.hasReduced = false;
        rebuilt.forEach((r) => push(r.name, r.price, r.reduced));
      }
    }
    const itemsSum = out.items.reduce((a, it) => a + it.price, 0);
    out.candidates = totalCandidates(lines, itemsSum);
    out.total = out.candidates.length ? out.candidates[0].value : (itemsSum || null);
    out.itemsSum = itemsSum;
    // 小計（品目の合計の答え合わせに使う）
    out.subtotal = null;
    for (let i = 0; i < lines.length && out.subtotal === null; i++) {
      if (!/小\s*計/.test(lines[i]) || /(税|対象)/.test(lines[i])) continue;
      const t = lines[i].replace(/\d+\s*点/g, '').replace(/^.*小\s*計/, '');
      let m = /(\d{1,3}(?:,\d{3})+|\d{1,7})(?!.*\d)/.exec(t.replace(/[¥円]/g, ''));
      if (!m && lines[i + 1] && /^[¥\s]*[\d,]+\s*円?$/.test(lines[i + 1])) m = /([\d,]+)/.exec(lines[i + 1]);
      if (m) out.subtotal = Number(m[1].replace(/,/g, ''));
    }
    if (out.subtotal === null) { const sc = out.candidates.find((c) => c.why.some((w) => /^小計(（列）)?$/.test(w))); out.subtotal = sc ? sc.value : null; }
    // 税率ごとの金額（「8%対象額」「10%対象」など）。合計と合えば、分類の分け方にそのまま使う
    const rate = { 8: null, 10: null }, base = { 8: null, 10: null }, tax = { 8: null, 10: null };
    const lastNum = (l) => { const m = /(-?\d{1,3}(?:,\d{3})+|-?\d{1,7})\s*\)?\s*$/.exec(l.replace(/[¥円]/g, '')); return m ? Number(m[1].replace(/,/g, '')) : null; };
    lines.forEach((l) => {
      const r = /(?:^|\D)(8|10)(?:\.0)?\s*%/.exec(l) ? (/(?:^|\D)8(?:\.0)?\s*%/.test(l) ? 8 : 10) : (/標準税率/.test(l) ? 10 : /軽減/.test(l) ? 8 : null);
      if (!r || /割引/.test(l)) return;
      const v = lastNum(l);
      if (v === null) return;
      if (/(税抜|外税)/.test(l) && /対象/.test(l)) base[r] = v;
      else if (/(税額|消費税|外税)/.test(l) && !/対象/.test(l)) tax[r] = v;
      else if (/対象/.test(l)) rate[r] = v;
    });
    [8, 10].forEach((r) => { if (base[r] !== null) rate[r] = base[r] + (tax[r] || 0); });
    const rs = (rate[8] || 0) + (rate[10] || 0);
    out.rates = out.total && rs && Math.abs(rs - out.total) <= 2 ? { 8: rate[8] || 0, 10: rate[10] || 0 } : null;
    // 税抜きの値段が並ぶレシート（小計＋税＝合計）かどうか
    const w = out.items.reduce((a, it) => a + it.price * (it.reduced ? 1.08 : 1.1), 0);
    out.taxExcluded = out.total && itemsSum && Math.abs(w - out.total) < Math.abs(itemsSum - out.total) && out.total > itemsSum;
    return out;
  }

  // ルールに当たらないときに使う、よくある品名（ユーザーのルールが先に当たる）
  const BUILTIN = [
    ['お酒', 'ビール,発泡酒,チューハイ,酎ハイ,ハイボール,サワー,ワイン,焼酎,日本酒,清酒,ウイスキー,ウィスキー,梅酒,リキュール,スーパードライ,一番搾り,黒ラベル,プレミアムモルツ,プレモル,金麦,のどごし,本麒麟,クリアアサヒ,淡麗,スタイルフリー,麦とホップ,ホワイトベルグ,ストロング,氷結,ほろよい,本搾り,こだわり酒場,角瓶,角ハイ,ブラックニッカ,トリス,鏡月,いいちこ,黒霧島,檸檬堂,ジムビーム,翠,レモンサワー,GFサワー,ハイネケン,コロナ,ヱビス,エビス,マッコリ,紹興酒'],
    ['日用品', 'トイレット,ティッシュ,洗剤,柔軟剤,漂白,シャンプー,リンス,コンディショナー,ボディソープ,ハンドソープ,歯磨,ハミガキ,歯ブラシ,ラップ,アルミホイル,ゴミ袋,ポリ袋,キッチンペーパー,スポンジ,電池,マスク,綿棒,おむつ,オムツ,生理,消臭,芳香,殺虫,入浴剤,カミソリ,ウェット,除菌,ハンガー,収納,フック,テープ']
  ];

  /**
   * 品目を分類に振り分ける
   * rules: [{keyword, category, order, active}]、defaults: { food: 分類ID, other: 分類ID }、catIdByName: 名前→分類ID
   */
  function classifyReceipt(parsed, rules, defaults, catIdByName) {
    const toKeys = (kw) => String(kw).split(/[,、]/).map((k) => normText(k).trim().toLowerCase()).filter(Boolean);
    const rs = (rules || []).filter((r) => r.active !== false && r.keyword && r.category).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .map((r) => ({ keys: toKeys(r.keyword), category: r.category }));
    if (catIdByName) BUILTIN.forEach(([name, kw]) => { const id = catIdByName(name); if (id) rs.push({ keys: toKeys(kw), category: id }); });
    const hit = (name) => {
      const n = normText(name).toLowerCase();
      for (const r of rs) if (r.keys.some((k) => n.indexOf(k) >= 0)) return r.category;
      return '';
    };
    const items = parsed.items.map((it) => {
      const byRule = hit(it.name);
      const cat = byRule || (parsed.hasReduced && !it.reduced ? defaults.other : defaults.food) || defaults.food;
      return Object.assign({}, it, { category: cat, byRule: !!byRule });
    });
    return Object.assign({}, parsed, { items: items });
  }

  /**
   * 分類ごとに合計し、レシートの合計（税・値引き込み）に合わせて分ける。
   * 税抜きの値段のレシートでは、軽減税率（8%）と標準（10%）の違いも考えて分ける。
   */
  function splitByCategory(items, total, taxExcluded, rates) {
    // 税率ごとの金額がわかるとき：8%の品目と10%の品目に分けて、それぞれの金額を分類で分ける（いちばん正確）
    if (rates && items.length) {
      const g8 = items.filter((it) => it.reduced), g10 = items.filter((it) => !it.reduced);
      const okG = (g, v) => (v > 0 ? g.reduce((a, it) => a + (Number(it.price) || 0), 0) > 0 : true);
      if (okG(g8, rates[8]) && okG(g10, rates[10])) {
        const parts = {};
        [[g8, rates[8]], [g10, rates[10]]].forEach(([g, v]) => { if (v > 0 && g.length) splitByCategory(g, v, false).forEach((x) => { parts[x.category] = parts[x.category] || { category: x.category, items: 0, amount: 0 }; parts[x.category].items += x.items; parts[x.category].amount += x.amount; }); });
        return Object.keys(parts).map((k) => parts[k]).sort((a, b) => b.amount - a.amount);
      }
    }
    const sums = {}, weights = {};
    items.forEach((it) => {
      if (!it.category) return;
      const p = Number(it.price) || 0;
      sums[it.category] = (sums[it.category] || 0) + p;
      weights[it.category] = (weights[it.category] || 0) + (taxExcluded ? p * (it.reduced ? 1.08 : 1.1) : p);
    });
    const keys = Object.keys(sums).filter((k) => sums[k] !== 0);
    const W = keys.reduce((a, k) => a + weights[k], 0);
    const S = keys.reduce((a, k) => a + sums[k], 0);
    const T = total && total > 0 ? total : Math.round(taxExcluded ? W : S);
    if (!W) return [];
    let used = 0;
    const big = keys.slice().sort((a, b) => weights[b] - weights[a]);
    const out = big.map((k, i) => {
      const v = i === big.length - 1 ? T - used : Math.round(weights[k] * T / W);
      used += v;
      return { category: k, items: sums[k], amount: v };
    });
    return out.filter((x) => x.amount > 0);
  }

  /**
   * 答え合わせ：読み取った品目の合計が、レシートの小計・合計と合っているか
   * 戻り値 { ok, level:'ok'|'warn', diff, text }
   */
  function checkReceipt(items, total, subtotal, taxExcluded) {
    const sum = items.reduce((a, it) => a + (Number(it.price) || 0), 0);
    const yenS = (n) => Math.abs(Math.round(n)).toLocaleString('ja-JP') + '円';
    if (subtotal) {
      const d = subtotal - sum;
      if (Math.abs(d) <= 1) return { ok: true, level: 'ok', diff: 0, text: '品目の合計 ' + yenS(sum) + ' が、レシートの小計 ' + yenS(subtotal) + ' と一致しました。' };
      return { ok: false, level: 'warn', diff: d, text: '品目の合計 ' + yenS(sum) + ' が、レシートの小計 ' + yenS(subtotal) + ' より ' + yenS(d) + (d > 0 ? ' 少ないです。読み落とした品目がないか確かめてください。' : ' 多いです。品目でない行や、二重に読んだ品目がないか確かめてください。') };
    }
    if (total) {
      const est = taxExcluded ? items.reduce((a, it) => a + (Number(it.price) || 0) * (it.reduced ? 1.08 : 1.1), 0) : sum;
      const d = total - est;
      if (Math.abs(d) <= Math.max(2, total * 0.005)) return { ok: true, level: 'ok', diff: 0, text: '品目の合計' + (taxExcluded ? '（税込みに直した額）' : '') + 'が、レシートの合計 ' + yenS(total) + ' と合いました。' };
      return { ok: false, level: 'warn', diff: Math.round(d), text: '品目の合計' + (taxExcluded ? '（税込みに直した額）' : '') + ' ' + yenS(est) + ' と、レシートの合計 ' + yenS(total) + ' が ' + yenS(d) + ' 違います。' +
        (d > 0 ? '読み落とした品目か、税・手数料があるかもしれません。' : '割引の読み落としか、品目でない行が入っているかもしれません。') };
    }
    return { ok: false, level: 'warn', diff: null, text: '合計が読み取れなかったので、答え合わせができません。合計を入れてください。' };
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

  /**
   * カードの請求1回分の中身（消し込み用）
   * - txs … この請求に入る、記録済みの利用
   * - plans … この請求に入るはずの予定（固定費など）で、まだ記録していないもの
   * - bill … 請求（確定額・状態）。記録も確定もない請求でも枠を返す
   */
  function billDetail(m, cardId, debitYm) {
    const card = m.w[cardId];
    if (!isCard(card)) return null;
    const all = bills(m, { withOpen: true });
    const key = card.id + '|' + debitYm;
    const cyc = { debitYm: debitYm, debitDate: dateIn(debitYm, Number(card.debitDay) || 27), closeDate: '' };
    const off = Number(card.debitOffset) || 1;
    const closeYm = addMonths(debitYm, -off);
    cyc.closeDate = dateIn(closeYm, closeDayOf(card, closeYm));
    const b = all[key] || { key: key, card: card.id, cardName: card.name, ym: debitYm, debitDate: cyc.debitDate, closeDate: cyc.closeDate, payFrom: card.payFrom,
      used: 0, count: 0, planned: 0, override: null, status: '自動', memo: '', confirmed: false, amount: 0 };
    const row = m.billRows[key] || null;
    const txs = m.tx.filter((t) => (t.from === card.id && (t.type === '支出' || t.type === '振替')) || (t.to === card.id && t.type === '収入'))
      .filter((t) => cycleOf(card, t.date).debitYm === debitYm).sort((a, c) => a.date.localeCompare(c.date));
    const plans = [];
    for (let i = -4; i <= 0; i++) {
      const ym = addMonths(debitYm, i);
      occurrences(m, ym).forEach((o) => {
        if (o.done || !o.wallet || o.wallet.id !== card.id || o.plan.kind === '収入' || o.plan.kind === '振替') return;
        if (cycleOf(card, o.date).debitYm !== debitYm) return;
        plans.push(o);
      });
    }
    const used = txs.reduce((a, t) => a + (t.to === card.id && t.type === '収入' ? -t.amount : t.amount), 0);
    const plannedSum = plans.reduce((a, o) => a + (o.planned || 0), 0);
    return { card: card, key: key, ym: debitYm, debitDate: b.debitDate || cyc.debitDate, closeDate: b.closeDate || cyc.closeDate, payFrom: card.payFrom,
      row: row, confirmed: !!(row && row.amount !== ''), override: row && row.amount !== '' ? Number(row.amount) : null, status: (row && row.status) || '自動',
      txs: txs, used: used, plans: plans, plannedSum: plannedSum };
  }

  /** カードごとの「次に引き落とされる請求」と「いま使っている分」 */
  function cardStatus(m) {
    const all = bills(m);
    return m.cards.map((card) => {
      const list = Object.keys(all).map((k) => all[k]).filter((b) => b.card === card.id).sort((a, b) => a.debitDate.localeCompare(b.debitDate));
      const upcoming = list.filter((b) => b.debitDate > m.today && (b.amount !== 0 || !b.confirmed));
      const failed = list.filter((b) => b.status === '引き落とし不可');
      // 引き落とせなかった請求を払った分：いちばん古い「引き落とし不可」の引き落とし日より後の、このカードへの振替だけ
      const firstFail = failed.length ? failed.map((b) => b.debitDate).sort()[0] : null;
      const paid = firstFail ? m.tx.filter((t) => t.type === '振替' && t.to === card.id && t.date >= firstFail).reduce((s, t) => s + t.amount, 0) : 0;
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
    // 分類の合計は期間集計（summary）と同じ計算にそろえる（まとめて登録したレシートも品目の分類で分ける）
    const sm = summary(m, ym + '-01', ym + '-' + pad(dimOf(ym)), { byItems: true });
    const txs = m.tx.filter((t) => ymOf(t.date) === ym);   // 一覧用：振替・残高合わせも含めた、その月のすべての記録
    const cats = {};
    m.categoriesAll.forEach((c) => { cats[c.id] = { id: c.id, name: c.name, icon: c.icon, kind: c.kind, group: c.group, budget: c.budget === '' ? null : Number(c.budget), total: 0, count: 0 }; });
    const none = { id: '', name: '分類なし', icon: '・', kind: '支出', group: '生活費', budget: null, total: 0, count: 0 };
    sm.expenseCats.concat(sm.incomeCats).forEach((x) => { const c = cats[x.id] || none; c.total += x.total; c.count += x.count; });
    const expense = sm.expense, income = sm.income, household = sm.household, outside = sm.outside, tatekae = sm.tatekae;
    const byUser = sm.byUser, byWallet = sm.byWallet;
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

  /**
   * 期間集計：from〜to（両端を含む）の支出・収入を、分類・月・支払い・入力者・メモごとにまとめる
   * opt.user … '夫'／'妻' で入力者を絞る（空ならみんな）
   * 振替・残高合わせはお金の移動なので数えない
   */
  function summary(m, from, to, opt) {
    opt = opt || {};
    const txs = m.tx.filter((t) => t.date >= from && t.date <= to && (t.type === '支出' || t.type === '収入') && (!opt.user || t.user === opt.user));
    // レシートの品目（内訳）を記録ごとに
    const itemsOf = {};
    (m.data.items || []).forEach((it) => { if (it.tx) (itemsOf[it.tx] = itemsOf[it.tx] || []).push(it); });
    const itemNames = {};
    let splitByItems = 0;
    const cats = {};
    const none = { id: '', name: '分類なし', icon: '・', kind: '支出', group: '生活費' };
    const catOf = (t) => {
      const c = m.c[t.category] || none;
      const k = c.id + '|' + t.type;
      return cats[k] || (cats[k] = { id: c.id, name: c.name, icon: c.icon, kind: t.type, group: c.group || '生活費', total: 0, count: 0, byMonth: {}, tx: [] });
    };
    const byMonth = {}, byUser = {}, byWallet = {}, byMemo = {};
    let expense = 0, income = 0, household = 0, outside = 0, tatekae = 0, count = 0;
    txs.forEach((t) => {
      const ym = ymOf(t.date);
      const its = itemsOf[t.id] || [];
      // 品目の名前ごとの合計（レシートに印字された金額）
      if (t.type === '支出') its.forEach((it) => {
        const nm = String(it.name || '').trim(); if (!nm) return;
        const b = itemNames[nm] || (itemNames[nm] = { name: nm, category: it.category, total: 0, count: 0 });
        b.total += Number(it.price) || 0; b.count++;
      });
      // まとめて1件で登録したレシートでも、品目の分類で分けて数える（opt.byItems が false でなければ）
      let shares = [{ category: t.category, amount: t.amount }];
      if (opt.byItems !== false && t.type === '支出' && its.length && its.some((it) => it.category && it.category !== t.category)) {
        const list = its.map((it) => ({ price: Number(it.price) || 0, category: it.category || t.category, reduced: it.reduced === true }));
        const sum = list.reduce((a, it) => a + it.price, 0);
        const taxEx = sum > 0 && sum < t.amount * 0.97;   // 品目の合計が支払額より少ない＝税抜きの表示とみなし、8%・10%で重みを付ける
        const sp = splitByCategory(list, t.amount, taxEx, null);
        if (sp.length && sp.reduce((a, x) => a + x.amount, 0) === t.amount) { shares = sp; splitByItems++; }
      }
      shares.forEach((sh) => {
        const c = catOf({ category: sh.category, type: t.type });
        c.total += sh.amount; c.count++; c.byMonth[ym] = (c.byMonth[ym] || 0) + sh.amount;
        c.tx.push(shares.length > 1 ? Object.assign({}, t, { _part: sh.amount }) : t);
        if (t.type === '支出') {
          if (c.group === '立替（あとで戻る）') tatekae += sh.amount;
          else if (c.group === '生活費の外') outside += sh.amount;
          else { household += sh.amount; (byMonth[ym] = byMonth[ym] || { expense: 0, income: 0, household: 0 }).household += sh.amount; }
        }
      });
      const bm = byMonth[ym] || (byMonth[ym] = { expense: 0, income: 0, household: 0 });
      if (t.type === '支出') {
        count++; expense += t.amount; bm.expense += t.amount;
        byUser[t.user || '不明'] = (byUser[t.user || '不明'] || 0) + t.amount;
        byWallet[t.from || ''] = (byWallet[t.from || ''] || 0) + t.amount;
        const memo = String(t.memo || '').replace(/（.*?）|\(.*?\)/g, '').trim().slice(0, 24);
        if (memo) {
          // レシートを分類ごとに分けた記録は、同じ日・同じ登録日時なので「1回の買い物」として数える
          const b = byMemo[memo] || (byMemo[memo] = { memo: memo, total: 0, count: 0, seen: {} });
          const visit = t.rcpt || (t.date + '|' + (t.created || t.id));
          b.total += t.amount; if (!b.seen[visit]) { b.seen[visit] = true; b.count++; }
        }
      } else { income += t.amount; bm.income += t.amount; }
    });
    const list = Object.keys(cats).map((k) => cats[k]);
    list.forEach((c) => c.tx.sort((a, b) => (b.date + (b.created || '')).localeCompare(a.date + (a.created || ''))));
    // 期間の長さ（月平均を出すため。日数 ÷ 30.4）
    const days = Math.max(1, diffDays(from, to) + 1);
    const months = [];
    for (let ym = ymOf(from); ym <= ymOf(to); ym = addMonths(ym, 1)) { months.push(ym); if (months.length > 240) break; }
    return {
      from: from, to: to, days: days, months: months, monthsLen: days / 30.4,
      expense: expense, income: income, household: household, outside: outside, tatekae: tatekae, count: count,
      expenseCats: list.filter((c) => c.kind === '支出').sort((a, b) => b.total - a.total),
      incomeCats: list.filter((c) => c.kind === '収入').sort((a, b) => b.total - a.total),
      byMonth: byMonth, byUser: byUser, byWallet: byWallet,
      byMemo: Object.keys(byMemo).map((k) => byMemo[k]).sort((a, b) => b.total - a.total),
      items: Object.keys(itemNames).map((k) => itemNames[k]).sort((a, b) => b.total - a.total),
      splitByItems: splitByItems,
      tx: txs
    };
  }

  /** 今月の予算の残り（生活費の分類の予算の合計から）。catId を渡すと、その分類だけ */
  function budgetLeft(m, catId) {
    const ym = ymOf(m.today), s = month(m, ym);
    const dim = dimOf(ym), daysLeft = dim - (+m.today.slice(8, 10)) + 1;   // 今日を含む
    let budget, used;
    if (catId) { const c = s.expenseCats.find((x) => x.id === catId) || (m.c[catId] ? { budget: m.c[catId].budget === '' ? null : Number(m.c[catId].budget), total: 0 } : null); if (!c || !c.budget) return null; budget = c.budget; used = c.total; }
    else { budget = s.budget; used = s.household; if (!budget) return null; }
    const left = budget - used;
    return { budget: budget, used: used, left: left, daysLeft: daysLeft, perDay: left > 0 ? Math.floor(left / daysLeft) : 0, ratio: budget ? used / budget : 0, dayRatio: s.dayRatio };
  }

  /** この行を使っているところ（削除してよいかの確認用）。{ count, where:[] } */
  function refsTo(data, table, id) {
    const where = [];
    const n = (label, list) => { if (list.length) where.push(label + ' ' + list.length + '件'); return list.length; };
    let c = 0;
    const d = (t) => data[t] || [];
    if (table === 'wallets') {
      c += n('記録', d('tx').filter((t) => t.from === id || t.to === id));
      c += n('予定', d('plans').filter((p) => p.wallet === id || p.to === id));
      c += n('カードの引き落とし口座', d('wallets').filter((w) => w.payFrom === id));
      c += n('ボーナスの入金口座', d('bonuses').filter((b) => b.wallet === id));
      c += n('ボーナスの配分', d('allocs').filter((a) => a.to === id));
      c += n('交通費の区間', d('routes').filter((r) => r.wallet === id));
      c += n('カードの請求', d('bills').filter((b) => b.card === id));
    }
    if (table === 'categories') {
      c += n('記録', d('tx').filter((t) => t.category === id));
      c += n('予定', d('plans').filter((p) => p.category === id));
      c += n('ボーナスの配分', d('allocs').filter((a) => a.category === id));
      c += n('レシートの品目', d('items').filter((i) => i.category === id));
      c += n('読み取りルール', d('rules').filter((r) => r.category === id));
      c += n('交通費の区間', d('routes').filter((r) => r.category === id));
    }
    if (table === 'bonuses') c += n('配分', d('allocs').filter((a) => a.bonus === id));
    return { count: c, where: where };
  }

  /**
   * データの点検：おかしなところを見つけて一覧にする（直すのは人）
   * 戻り値：[{ level:'高'|'中'|'低', kind, text, table, id }]
   */
  function dataCheck(m) {
    const data = m.data, out = [];
    const add = (level, kind, text, table, id) => out.push({ level: level, kind: kind, text: text, table: table, id: id });
    const W = {}, C = {}, T = {};
    (data.wallets || []).forEach((w) => { W[w.id] = w; });
    (data.categories || []).forEach((c) => { C[c.id] = c; });
    (data.tx || []).forEach((t) => { T[t.id] = t; });
    const label = (t) => md(t.date) + ' ' + (t.memo || t.type) + ' ' + yen(t.amount);
    (data.tx || []).forEach((t) => {
      if (t.from && !W[t.from]) add('高', 'missing_wallet', '記録「' + label(t) + '」の支払い元の口座・カードが見つかりません。', 'tx', t.id);
      if (t.to && !W[t.to]) add('高', 'missing_wallet', '記録「' + label(t) + '」の入れ先の口座・カードが見つかりません。', 'tx', t.id);
      if (t.category && !C[t.category]) add('中', 'missing_cat', '記録「' + label(t) + '」の分類が見つかりません。', 'tx', t.id);
      if ((t.type === '支出' || t.type === '収入') && !t.category) add('低', 'no_cat', '記録「' + label(t) + '」に分類がありません（集計で「分類なし」になります）。', 'tx', t.id);
    });
    // 同じ日・同じ金額・同じ支払い元・同じメモの記録が、数分以内に2回登録されている（二重登録の疑い）
    const seen = {};
    (data.tx || []).slice().sort((a, b) => String(a.created).localeCompare(String(b.created))).forEach((t) => {
      if (t.rcpt || t.ref) return;
      const k = [t.date, t.type, t.amount, t.from, t.to, t.memo].join('|');
      const prev = seen[k];
      if (prev && t.created && prev.created && Math.abs(Date.parse(t.created.replace(' ', 'T')) - Date.parse(prev.created.replace(' ', 'T'))) < 10 * 60 * 1000)
        add('中', 'dup', '「' + label(t) + '」が2回登録されているかもしれません（' + String(prev.created).slice(11, 16) + ' と ' + String(t.created).slice(11, 16) + '）。', 'tx', t.id);
      seen[k] = t;
    });
    // カード払いの予定を、口座から直接払った記録にしている（カードの引き落としと二重になる）
    const P = {}; (data.plans || []).forEach((p) => { P[p.id] = p; });
    (data.tx || []).forEach((t) => {
      const mm = /^p:(.+):(\d{4}-\d{2})$/.exec(t.ref || ''); if (!mm || !P[mm[1]]) return;
      const pw = W[P[mm[1]].wallet], tw = W[t.from];
      if (pw && pw.kind === 'カード' && tw && tw.kind !== 'カード' && t.type === '支出')
        add('高', 'card_plan_direct', '「' + label(t) + '」は' + pw.name + '払いの予定ですが、' + tw.name + 'から払った記録になっています。カードの引き落としと二重に引かれている可能性があります。', 'tx', t.id);
    });
    (data.plans || []).forEach((p) => {
      if (p.active === false) return;
      if (p.wallet && !W[p.wallet]) add('高', 'missing_wallet', '予定「' + p.name + '」の口座・カードが見つかりません。', 'plans', p.id);
      if (!p.wallet) add('中', 'plan_nowallet', '予定「' + p.name + '」の支払い元（入金先）が未設定です（見通しに入りません）。', 'plans', p.id);
      if (p.kind === '振替' && p.to && !W[p.to]) add('高', 'missing_wallet', '予定「' + p.name + '」の移す先が見つかりません。', 'plans', p.id);
    });
    (data.wallets || []).forEach((w) => {
      if (w.active === false) return;
      if (w.kind === 'カード') {
        if (!w.payFrom) add('中', 'card_nopay', w.name + 'の引き落とし口座が未設定です。', 'wallets', w.id);
        else if (!W[w.payFrom]) add('高', 'missing_wallet', w.name + 'の引き落とし口座が見つかりません。', 'wallets', w.id);
        if (!w.debitDay) add('低', 'card_noday', w.name + 'の引き落とし日が未設定です（27日として計算しています）。', 'wallets', w.id);
      } else if (!w.openingAt || w.opening === '') add('中', 'no_opening', w.name + 'の開始残高がまだです（残高を計算できません）。', 'wallets', w.id);
    });
    (data.items || []).forEach((it) => { if (it.tx && !T[it.tx]) add('低', 'orphan_item', 'レシートの品目「' + it.name + '」の記録が削除されています（品目だけ残っています）。', 'items', it.id); });
    (data.allocs || []).forEach((a) => { if (a.to && !W[a.to]) add('中', 'missing_wallet', 'ボーナスの配分「' + a.item + '」の移し先が見つかりません。', 'allocs', a.id); });
    (data.routes || []).forEach((r) => { if (r.wallet && !W[r.wallet]) add('低', 'missing_wallet', '交通費の区間「' + r.from + '→' + r.to + '」のいつもの支払いが見つかりません。', 'routes', r.id); });
    const all = bills(m);
    Object.keys(all).forEach((k) => {
      const b = all[k], ago = diffDays(b.debitDate, m.today);
      if (!b.confirmed && b.status === '自動' && ago >= 1 && ago <= 45 && b.used) add('低', 'bill_unconfirmed', b.cardName + 'の' + md(b.debitDate) + '分の請求額が未確定です（記録から ' + yen(b.amount) + ' で計算）。', 'bills', b.card);
    });
    const order = { '高': 0, '中': 1, '低': 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
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
    proj.events.filter((e) => e.kind === 'plan' && e.overdue && !e.viaCard).forEach((e) => {   // カード払いの予定は、カードの請求で消し込む
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
    isAccount: isAccount, isCard: isCard, build: build, cycleOf: cycleOf, bills: bills, cardStatus: cardStatus, billDetail: billDetail, balances: balances,
    planOccurs: planOccurs, planRef: planRef, occurrences: occurrences, nextOccurrence: nextOccurrence, projection: projection,
    month: month, summary: summary, budgetLeft: budgetLeft, refsTo: refsTo, dataCheck: dataCheck, tatekaeOpen: tatekaeOpen, annual: annual, bonusView: bonusView, alerts: alerts,
    yen: yen, md: md, afterText: afterText, normText: normText, parseReceipt: parseReceipt, classifyReceipt: classifyReceipt, checkReceipt: checkReceipt, splitByCategory: splitByCategory,
    fxYen: fxYen, usd: usd, passStations: passStations, stationKey: stationKey
  };
})();
if (typeof module !== 'undefined') module.exports = Engine;
