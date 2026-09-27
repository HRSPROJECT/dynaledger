/* CashBook v2 — transaction-based cash accounting with a dynamic rule engine.
   Money is stored as INTEGER paise (no floats). Balances are always derived:
   balance(account, date) = opening + Σ posted transactions. */
'use strict';
const LS = 'cashbookV2', LS1 = 'dynaLedgerV1';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- money (integer paise) ---------- */
const toPaise = v => { const n = Number(String(v).replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const fmtP = p => { const neg = (p | 0) < 0 || Object.is(p, -0); const a = Math.abs(Math.round(p || 0)); const r = a % 100, w = (a - r) / 100;
  const s = w.toLocaleString('en-IN'); return (neg ? '-₹' : '₹') + s + '.' + String(r).padStart(2, '0'); };
const fmtSign = p => ((p || 0) >= 0 ? '+' : '') + fmtP(p);
const CUR = () => DB.settings.currency || '₹';

/* ---------- dates (local calendar days) ---------- */
const pad2 = n => String(n).padStart(2, '0');
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayKey() { return dayKey(Date.now()); }
function parseDay(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }
function addDays(k, n) { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); }
function prettyDay(k) { try { return parseDay(k).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return k; } }
function prettyMonth(k) { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); }
function isoWeek(k) { const d = new Date(parseDay(k).getTime()); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4); return d.getFullYear() + '-W' + pad2(1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7)); }

/* ---------- store ---------- */
let DB = null;
function defaultDB() {
  const t = Date.now();
  const mk = (name, open, kind) => ({ id: uid(), name, opening: open, currency: '₹', kind: kind || 'cash', status: 'active', createdAt: t, updatedAt: t });
  const back = mk('Back Drawer', 0), bank = mk('Bank', 0), upi = mk('UPI', 0), cash = mk('Cash', 0), petty = mk('Petty Cash', 500000);
  const heads = ['Electricity', 'Salary', 'Transport', 'Maintenance', 'Stationery', 'Food', 'Repairs', 'Miscellaneous'].map(n => mk(n, 0, 'expense'));
  return {
    v: 3, seq: 0, accounts: [back, bank, upi, cash, petty, ...heads],
    incomeCats: [{ id: uid(), name: 'Cash Sale', active: true }, { id: uid(), name: 'Other Income', active: true }],
    rules: [], transactions: [], closings: {}, audit: [],
    settings: { user: 'Owner', currency: '₹', primaryAccountId: back.id, preventNegative: true }
  };
}
function save() { DB.savedAt = Date.now(); try { localStorage.setItem(LS, JSON.stringify(DB)); } catch (e) { toast('Storage full — export a backup!', 'err'); } }
function load() {
  try { const r = localStorage.getItem(LS); if (r) { DB = Object.assign(defaultDB(), JSON.parse(r)); if (migrateV3()) save(); return; } } catch (e) {}
  DB = defaultDB();
  if (migrateV1()) save();
}
/* v2 → v3: expense categories become expense accounts; every expense gains its receiving leg */
function migrateV3() {
  if ((DB.v || 2) >= 3 && !DB.expenseCats) return false;
  const t = Date.now(), byName = {};
  const head = n => {
    const k = n.toLowerCase();
    if (byName[k]) return byName[k];
    const ex = DB.accounts.find(a => a.kind === 'expense' && a.name.toLowerCase() === k);
    if (ex) { byName[k] = ex.id; return ex.id; }
    const a = { id: uid(), name: n.slice(0, 60), opening: 0, currency: '₹', kind: 'expense', status: 'active', createdAt: t, updatedAt: t };
    DB.accounts.push(a); byName[k] = a.id; return a.id;
  };
  (DB.expenseCats || []).forEach(c => head(c.name));
  DB.transactions.forEach(x => {
    if (x.exp) return;
    if (x.type === 'expense' || (x.type === 'reversal' && x.catKind === 'expense')) {
      const hid = head(x.catName || 'Miscellaneous');
      const g = x.group || uid(); x.group = g;
      x.expAcct = hid;
      DB.transactions.push({ id: uid(), txn: txnId(), ts: x.ts, bizDate: x.bizDate, type: 'transfer', accountId: hid,
        catId: null, catKind: 'expense', catName: x.catName, ruleId: null, ruleName: '', amount: -x.amount,
        note: `Expense ← ${acctName(x.accountId)}${x.note ? ' · ' + x.note : ''}`, method: x.method || '', by: x.by || 'Owner',
        status: x.status, revOf: null, reversedBy: null, group: g, exp: true, expAcct: hid });
    }
  });
  delete DB.expenseCats;
  DB.v = 3;
  audit('migrate', 'Expense categories converted to expense accounts (v3)', '', '');
  return true;
}
/* best-effort import from the old single-file app */
function migrateV1() {
  let raw = null; try { raw = localStorage.getItem(LS1); } catch (e) {}
  if (!raw) return false;
  try {
    const o = JSON.parse(raw), t = Date.now(), amap = {};
    (o.categories || []).forEach(c => {
      const a = { id: uid(), name: String(c.name).slice(0, 60), opening: Math.round((+c.openingBalance || 0) * 100), currency: '₹', kind: 'cash', status: 'active', createdAt: t, updatedAt: t };
      DB.accounts.push(a); amap[c.id] = a.id;
      if (a.opening) DB.transactions.push(mkTxn({ bizDate: dayKey(c.createdAt || t), ts: c.createdAt || t, type: 'opening', accountId: a.id, amount: a.opening, note: 'Opening balance (imported)' }));
    });
    (o.relations || []).forEach(r => {
      if (!amap[r.sourceId] || !amap[r.targetId]) return;
      DB.rules.push({ id: uid(), name: 'Imported rule', type: r.mode === 'percent' ? 'percent' : (r.mode === 'sweep' ? 'sweep' : 'fixed'),
        value: r.mode === 'percent' ? Math.round(r.value * 100) : Math.round((+r.value || 0) * 100),
        basis: 'trigger', freq: 'per_income', src: amap[r.sourceId], dst: r.deductFromSource ? amap[r.targetId] : null,
        mirror: !r.deductFromSource, priority: 100, active: !!r.active, start: null, end: null, conds: [], els: null, desc: 'Imported', createdAt: t, updatedAt: t });
    });
    audit('import', 'Migrated data from previous version', '', '');
    return true;
  } catch (e) { return false; }
}

/* ---------- lookups ---------- */
const acct = id => DB.accounts.find(a => a.id === id);
const acctName = id => (acct(id) || {}).name || '—';
const ruleById = id => DB.rules.find(r => r.id === id);
const ruleName = id => (ruleById(id) || {}).name || '';
const catNameOf = t => t.catName || (t.catKind === 'income' ? (DB.incomeCats.find(c => c.id === t.catId) || {}).name : '') || '—';
const expHeads = () => DB.accounts.filter(a => a.kind === 'expense');
const cashAccts = () => DB.accounts.filter(a => (a.kind || 'cash') !== 'expense');

/* ---------- audit ---------- */
function audit(action, details, oldV, newV) {
  DB.audit.unshift({ id: uid(), ts: Date.now(), user: DB.settings.user || 'Owner', action, details: String(details || ''), oldV: oldV ?? '', newV: newV ?? '' });
  if (DB.audit.length > 800) DB.audit.length = 800;
}

/* ---------- derived balances (never stored) ---------- */
function balanceOn(accountId, beforeDay /*exclusive, YYYY-MM-DD or null=all*/) {
  const a = acct(accountId); if (!a) return 0;
  let b = a.opening || 0;
  for (const t of DB.transactions) {
    if (t.accountId !== accountId) continue;
    if (t.status === 'void') continue;
    if (beforeDay && t.bizDate >= beforeDay) continue;
    b += t.amount || 0;
  }
  return b;
}
const balanceNow = id => balanceOn(id, null);

/*@@P2*/

/* ================= P2: transactions, rule engine, actions ================= */
function nextSeq() { DB.seq = (DB.seq || 0) + 1; return DB.seq; }
function txnId() { return 'TXN-' + String(nextSeq()).padStart(4, '0'); }
function mkTxn(o) {
  return { id: uid(), txn: o.txn || txnId(), ts: o.ts || Date.now(), bizDate: o.bizDate, type: o.type,
    accountId: o.accountId, catId: o.catId || null, catKind: o.catKind || null, catName: o.catName || '',
    ruleId: o.ruleId || null, ruleName: o.ruleName || '', amount: o.amount | 0, note: o.note || '',
    method: o.method || '', by: o.by || DB.settings.user || 'Owner', status: 'posted',
    revOf: o.revOf || null, reversedBy: null, group: o.group || null };
}
const isLocked = d => !!DB.closings[d];
function needUnlocked(d) { if (isLocked(d)) { toast(`Day ${prettyDay(d)} is CLOSED — reopen it to make changes.`,'err'); return false; } return true; }

/* ---------- rule engine ---------- */
function ruleActiveOn(r, bizDate) {
  if (!r.active) return { ok: false, why: 'inactive' };
  if (r.start && bizDate < r.start) return { ok: false, why: 'starts ' + r.start };
  if (r.end && bizDate > r.end) return { ok: false, why: 'ended ' + r.end };
  return { ok: true };
}
function freqKey(r, bizDate) {
  if (r.freq === 'daily') return bizDate;
  if (r.freq === 'weekly') return isoWeek(bizDate);
  if (r.freq === 'monthly') return bizDate.slice(0, 7);
  if (r.freq === 'once') return 'ever';
  return null; // per_income
}
function freqFired(r, bizDate, pending) {
  const k = freqKey(r, bizDate); if (!k) return false;
  const hit = t => t.ruleId === r.id && t.status !== 'void' && t.type !== 'reversal' && (k === 'ever' || (r.freq === 'daily' ? t.bizDate === k : r.freq === 'weekly' ? isoWeek(t.bizDate) === k : t.bizDate.slice(0, 7) === k));
  return DB.transactions.some(hit) || (pending || []).some(hit);
}
function cmpPaise(l, op, r) { return op === '>' ? l > r : op === '>=' ? l >= r : op === '<' ? l < r : op === '<=' ? l <= r : op === '==' ? l === r : op === '!=' ? l !== r : false; }
function condsPass(r, ctx) {
  return (r.conds || []).every(c => {
    const l = c.left === 'day_total' ? ctx.dayTotal : ctx.trigger;
    return cmpPaise(l, c.op, c.right | 0);
  });
}
function pctOf(base, pct) { return Math.round(base * (+pct || 0) / 100); }
/* ctx: {trigger, dayTotal} in paise. Returns {deduct>=0, explain} */
function computeRule(r, ctx) {
  const base = r.basis === 'day_total' ? ctx.dayTotal : ctx.trigger;
  if (r.type === 'fixed') return { deduct: Math.max(0, r.value | 0), explain: `${fmtP(r.value)} fixed` };
  if (r.type === 'percent') { const d = Math.max(0, pctOf(base, r.value)); return { deduct: d, explain: `${r.value}% of ${fmtP(base)}` }; }
  if (r.type === 'conditional') {
    const hit = condsPass(r, ctx);
    const k = hit ? { kind: r.thenKind || 'fixed', val: r.value } : (r.els || { kind: 'fixed', val: 0 });
    const d = k.kind === 'percent' ? Math.max(0, pctOf(base, k.val)) : Math.max(0, k.val | 0);
    return { deduct: d, explain: `condition ${hit ? 'met' : 'not met'} → ${k.kind === 'percent' ? k.val + '% of ' + fmtP(base) : fmtP(k.val)}` };
  }
  return { deduct: 0, explain: 'sweep handled after other rules' }; // sweep
}
function sortedRules() { return [...DB.rules].sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt)); }
/* dry-run AND live firing share this: pass commit=false for simulation */
function planFiring({ trigger, dayTotal, bizDate, srcAcct, incCatId, pending }) {
  const out = [];
  let running = balanceNow(srcAcct) + trigger;
  const dayTot = dayTotal;
  for (const r of sortedRules()) {
    if (r.src !== srcAcct) continue;
    if (r.incCat && r.incCat !== incCatId) continue;
    const gate = ruleActiveOn(r, bizDate); if (!gate.ok) { out.push({ rule: r, skip: gate.why }); continue; }
    if (freqFired(r, bizDate, pending)) { out.push({ rule: r, skip: 'already applied (' + (r.freq || 'per_income') + ')' }); continue; }
    if (r.type === 'sweep') {
      const rest = running;
      if (rest === 0) { out.push({ rule: r, skip: 'remainder is zero' }); continue; }
      out.push({ rule: r, deduct: rest, sweep: true, explain: `remainder ${fmtSign(rest)} → zeroed` });
      running = 0; continue;
    }
    const c = computeRule(r, { trigger, dayTotal: dayTot });
    if (!c.deduct) { out.push({ rule: r, skip: 'computes to zero' }); continue; }
    out.push({ rule: r, deduct: c.deduct, explain: c.explain });
    running -= c.deduct;
  }
  return { plan: out, running };
}
function fireTxns(incomeTxn, plan) {
  const txns = [incomeTxn];
  for (const p of plan) {
    if (p.skip || !p.deduct) continue;
    const r = p.rule, amt = p.deduct | 0;
    txns.push(mkTxn({ bizDate: incomeTxn.bizDate, type: 'deduction', accountId: incomeTxn.accountId, ruleId: r.id, ruleName: r.name, amount: -amt, note: `${r.name}: ${p.explain || ''}`.slice(0, 140) }));
    if (r.dst) txns.push(mkTxn({ bizDate: incomeTxn.bizDate, type: 'transfer', accountId: r.dst, ruleId: r.id, ruleName: r.name, amount: amt, note: `From ${acctName(incomeTxn.accountId)} via ${r.name}`, group: null }));
  }
  return txns;
}

/* ---------- actions (validate fully, then commit atomically) ---------- */
function addIncome({ catId, amount, accountId, bizDate, note }) {
  const cat = catId ? DB.incomeCats.find(c => c.id === catId && c.active) : null;
  if (catId && !cat) return { err: 'Pick an active income category.' };
  const catName = cat ? cat.name : 'General Income';
  const ac = acct(accountId);
  if (!ac || ac.status !== 'active') return { err: 'Pick an active account.' };
  if (!(amount > 0)) return { err: 'Amount must be greater than 0.' };
  if (!needUnlocked(bizDate)) return { err: 'locked' };
  const dayTotal = DB.transactions.filter(t => t.accountId === accountId && t.bizDate === bizDate && t.type === 'income' && t.status !== 'void').reduce((s, t) => s + t.amount, 0) + amount;
  const incomeTxn = mkTxn({ bizDate, type: 'income', accountId, catId: catId || null, catKind: 'income', catName, amount, note });
  const { plan } = planFiring({ trigger: amount, dayTotal, bizDate, srcAcct: accountId, incCatId: catId, pending: [incomeTxn] });
  const batch = fireTxns(incomeTxn, plan);
  batch.forEach(t => DB.transactions.push(t));
  const fired = plan.filter(p => !p.skip && p.deduct);
  audit('income', `${catName} ${fmtP(amount)} → ${ac.name} (${fired.length} rule${fired.length === 1 ? '' : 's'} fired)`, '', incomeTxn.txn);
  save();
  if (DB.settings.preventNegative) {
    const b = balanceNow(accountId);
    if (b < 0) toast(`Note: ${esc(ac.name)} is now negative (${fmtP(b)}) after automatic deductions.`, 'err');
  }
  return { txns: batch, fired };
}
/* An expense IS an account: booking moves money source → expense head.
   Out-leg type 'expense', in-leg type 'transfer' flagged exp:true (mirror, excluded from flow buckets). */
function addExpense({ headId, newHead, amount, accountId, bizDate, method, note, allowNegative }) {
  const ac = acct(accountId);
  let head = headId ? acct(headId) : null;
  if (newHead && newHead.trim()) {
    const n = newHead.trim().slice(0, 60);
    head = DB.accounts.find(a => a.kind === 'expense' && a.name.toLowerCase() === n.toLowerCase());
    if (!head) {
      const t = Date.now();
      head = { id: uid(), name: n, opening: 0, currency: '₹', kind: 'expense', status: 'active', createdAt: t, updatedAt: t };
      DB.accounts.push(head);
      audit('account', 'Created expense head ' + n, '', '');
    }
  }
  if (!head || head.kind !== 'expense' || head.status !== 'active') return { err: 'Pick an active expense head (or type a new one).' };
  if (!ac || ac.status !== 'active') return { err: 'Pick an active source account.' };
  if (ac.id === head.id) return { err: 'Source and expense head must differ.' };
  if (!(amount > 0)) return { err: 'Amount must be greater than 0.' };
  if (!needUnlocked(bizDate)) return { err: 'locked' };
  const avail = balanceNow(accountId);
  if (DB.settings.preventNegative && !allowNegative && amount > avail)
    return { blocked: true, available: avail, shortfall: amount - avail };
  const g = uid();
  const out = mkTxn({ bizDate, type: 'expense', accountId, catId: null, catKind: 'expense', catName: head.name, amount: -amount, note, method, group: g });
  out.expAcct = head.id;
  const inn = mkTxn({ bizDate, type: 'transfer', accountId: head.id, catId: null, catKind: 'expense', catName: head.name, amount, note: `Expense ← ${ac.name}${note ? ' · ' + note : ''}`, method, group: g });
  inn.exp = true; inn.expAcct = head.id;
  DB.transactions.push(out, inn);
  audit('expense', `${head.name} ${fmtP(amount)} from ${ac.name}`, '', out.txn);
  save();
  return { txn: out, inn };
}
function addTransfer({ fromId, toId, amount, bizDate, note }) {
  const A = acct(fromId), B = acct(toId);
  if (!A || !B || A.status !== 'active' || B.status !== 'active') return { err: 'Pick two active accounts.' };
  if (fromId === toId) return { err: 'Accounts must differ.' };
  if (!(amount > 0)) return { err: 'Amount must be greater than 0.' };
  if (!needUnlocked(bizDate)) return { err: 'locked' };
  const avail = balanceNow(fromId);
  if (DB.settings.preventNegative && amount > avail) return { blocked: true, available: avail, shortfall: amount - avail };
  const g = uid();
  const out = mkTxn({ bizDate, type: 'transfer', accountId: fromId, amount: -amount, note: `Transfer → ${B.name}${note ? ' · ' + note : ''}`, group: g });
  const inn = mkTxn({ bizDate, type: 'transfer', accountId: toId, amount, note: `Transfer ← ${A.name}${note ? ' · ' + note : ''}`, group: g });
  DB.transactions.push(out, inn);
  audit('transfer', `${fmtP(amount)} ${A.name} → ${B.name}`, '', out.txn);
  save();
  return { out, inn };
}
function reverseTxn(id, reason) {
  const t = DB.transactions.find(x => x.id === id);
  if (!t) return { err: 'Not found.' };
  if (t.status === 'reversed') return { err: 'Already reversed.' };
  if (t.type === 'reversal') return { err: 'Cannot reverse a reversal.' };
  if (!needUnlocked(t.bizDate)) return { err: 'locked' };
  const legs = t.group ? DB.transactions.filter(x => x.group === t.group && x.status === 'posted') : [t];
  const made = legs.map(l => {
    const r = mkTxn({ bizDate: l.bizDate, type: 'reversal', accountId: l.accountId, catId: l.catId, catKind: l.catKind, catName: l.catName, ruleId: l.ruleId, ruleName: l.ruleName, amount: -l.amount, note: `Reversal of ${l.txn}${reason ? ' · ' + reason : ''}`, revOf: l.id, group: l.group });
    if (l.exp) r.exp = true;
    if (l.expAcct) r.expAcct = l.expAcct;
    l.status = 'reversed'; l.reversedBy = r.id; return r;
  });
  made.forEach(m => DB.transactions.push(m));
  audit('reverse', `Reversed ${t.txn} (${catNameOf(t)} ${fmtP(t.amount)})`, t.txn, made.map(m => m.txn).join(','));
  save();
  return { made };
}
function dayFigures(accountId, bizDate) {
  const opening = balanceOn(accountId, bizDate);
  let income = 0, auto = 0, exp = 0, tin = 0, tout = 0;
  for (const t of DB.transactions) {
    if (t.accountId !== accountId || t.bizDate !== bizDate || t.status === 'void') continue;
    const a = t.amount || 0;
    if (t.exp) { if (a >= 0) tin += a; else tout += a; continue; } // expense mirror leg — shown as transfer in/out of the head
    if (t.type === 'income') income += a;
    else if (t.type === 'deduction' || (t.type === 'reversal' && t.ruleId)) auto += a;
    else if (t.type === 'expense' || (t.type === 'reversal' && !t.ruleId)) exp += a;
    else if (t.type === 'transfer') { if (a >= 0) tin += a; else tout += a; }
    else if (t.type === 'opening' || t.type === 'adjust') exp += a;
  }
  return { opening, income, auto, exp, tin, tout, closing: opening + income + auto + exp + tin + tout };
}
function closeDay(bizDate) {
  if (isLocked(bizDate)) return { err: 'Day already closed.' };
  const snap = { date: bizDate, by: DB.settings.user || 'Owner', at: Date.now(), accounts: {} };
  DB.accounts.forEach(a => { snap.accounts[a.id] = Object.assign({ name: a.name }, dayFigures(a.id, bizDate)); });
  DB.closings[bizDate] = snap;
  audit('close-day', `Closed ${prettyDay(bizDate)}`, '', '');
  save(); return { snap };
}
function reopenDay(bizDate) {
  if (!isLocked(bizDate)) return { err: 'Day is not closed.' };
  delete DB.closings[bizDate];
  audit('reopen-day', `Reopened ${prettyDay(bizDate)} (admin override)`, '', '');
  save(); return { ok: true };
}
/* simulation — never writes */
function simulate({ amount, accountId, bizDate, incCatId }) {
  const dayTotal = DB.transactions.filter(t => t.accountId === accountId && t.bizDate === bizDate && t.type === 'income' && t.status !== 'void').reduce((s, t) => s + t.amount, 0) + amount;
  const { plan, running } = planFiring({ trigger: amount, dayTotal, bizDate, srcAcct: accountId, incCatId, pending: [] });
  return { plan, closing: running };
}

/*@@P3*/
/* ================= P3: shell, dashboard, daily ================= */
let UI = { tab: 'dashboard', dailyDate: todayKey(), dailyAcct: null, txnTab: 'list', repTab: 'reports',
  f: { q: '', from: '', to: '', acct: '', cat: '', type: '', rule: '' }, rep: { preset: 'month', from: '', to: '', group: 'day' } };
function toast(msg, kind) {
  const box = document.getElementById('toasts'); const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : ''); el.innerHTML = msg;
  box.appendChild(el); setTimeout(() => el.remove(), kind === 'err' ? 5200 : 3200);
}
function openModal(html) {
  document.getElementById('modalCard').innerHTML = html;
  document.getElementById('modalWrap').classList.remove('hidden');
}
function closeModal() { document.getElementById('modalWrap').classList.add('hidden'); document.getElementById('modalCard').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.getElementById('modalWrap').addEventListener('click', e => { if (e.target.id === 'modalWrap') closeModal(); });
let _confirmFn = null;
function confirmDlg(title, body, okLabel, fn) {
  _confirmFn = fn;
  openModal(`<p class="eyebrow">Please confirm</p><h3>${esc(title)}</h3><p class="muted">${body}</p>
    <div class="rowbtns end"><button class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" onclick="_confirmFn();closeModal()">${esc(okLabel || 'Confirm')}</button></div>`);
}
function go(tab) {
  UI.tab = tab;
  ['dashboard', 'daily', 'transactions', 'income', 'expenses', 'accounts', 'rules', 'reports', 'settings'].forEach(t => {
    document.getElementById('view-' + t).classList.add('hidden');
    document.querySelectorAll(`[data-tab="${t}"]`).forEach(b => b.classList.remove('on'));
    document.querySelectorAll(`[data-m="${t}"]`).forEach(b => b.classList.remove('on'));
  });
  document.getElementById('view-' + tab).classList.remove('hidden');
  document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('on'));
  document.querySelectorAll(`[data-m="${tab}"]`).forEach(b => b.classList.add('on'));
  ({ dashboard: R_dashboard, daily: R_daily, transactions: R_txn, income: R_income, expenses: R_exp, accounts: R_acct, rules: R_rules, reports: R_rep, settings: R_set })[tab]();
  window.scrollTo({ top: 0 });
}
function quickAdd() {
  openModal(`<p class="eyebrow">Quick entry</p><h3>What are you recording?</h3>
    <div class="grid g2"><button class="btn" onclick="openIncome()">+ Add Income</button><button class="btn" onclick="openExpense()">+ Add Expense</button></div>
    <div class="rowbtns end"><button class="btn-g" onclick="closeModal()">Cancel</button></div>`);
}
function openMore() {
  const l = (t, n) => `<button class="btn-g" onclick="closeModal();go('${t}')">${n}</button>`;
  openModal(`<p class="eyebrow">More</p><h3>All sections</h3><div class="grid g2">${l('income', 'Income')}${l('expenses', 'Expenses')}${l('accounts', 'Accounts')}${l('rules', 'Rules')}${l('reports', 'Reports')}${l('settings', 'Settings')}</div>`);
}
function globalSearch() {
  UI.f.q = document.getElementById('gSearch').value.trim();
  go('transactions');
}
function primaryAcct() { return acct(DB.settings.primaryAccountId) || DB.accounts[0]; }
function svgBars(series, labels) {
  const max = Math.max(1, ...series.flatMap(s => s.v));
  const W = 560, H = 190, n = series[0].v.length, gw = W / n, bw = Math.min(34, gw / 3.4);
  const lbl = labels || series[0].v.map((_, i) => 'D' + (i + 1));
  let r = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img">`;
  series[0].v.forEach((_, i) => {
    const x = gw * i + gw / 2;
    series.forEach((s, j) => {
      const h = Math.max(2, (s.v[i] / max) * (H - 34));
      r += `<rect x="${(x + (j - 0.5) * bw - bw / 2).toFixed(1)}" y="${(H - 20 - h).toFixed(1)}" width="${bw - 3}" height="${h.toFixed(1)}" rx="3" fill="${s.c}"><title>${esc(s.l)} ${esc(lbl[i])}: ${fmtP(s.v[i])}</title></rect>`;
    });
    r += `<text x="${x.toFixed(1)}" y="${H - 5}" font-size="10" text-anchor="middle" fill="#8A857A">${esc(lbl[i])}</text>`;
  });
  return r + '</svg>';
}
function svgDonut(segs) {
  const tot = segs.reduce((s, x) => s + x.v, 0) || 1; let a0 = -Math.PI / 2, paths = '';
  segs.forEach(s => { const a1 = a0 + (s.v / tot) * Math.PI * 2;
    const x0 = 60 + 44 * Math.cos(a0), y0 = 60 + 44 * Math.sin(a0), x1 = 60 + 44 * Math.cos(a1), y1 = 60 + 44 * Math.sin(a1);
    if (s.v > 0) paths += `<path d="M60 60 L${x0.toFixed(1)} ${y0.toFixed(1)} A44 44 0 ${(a1 - a0) > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${s.c}"><title>${esc(s.l)}: ${fmtP(s.v)}</title></path>`;
    a0 = a1; });
  return `<div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 120 120" style="width:130px" role="img"><circle cx="60" cy="60" r="44" fill="#F1EADB"/>${paths}<circle cx="60" cy="60" r="26" fill="#FDFCF9"/></svg>
    <div style="font-size:.85rem">${segs.map(s => `<div>● <span style="color:${s.c}">■</span> ${esc(s.l)} — <b>${fmtP(s.v)}</b></div>`).join('') || '<span class="faint">No data</span>'}</div></div>`;
}
const PAL = ['#C15F3C', '#5B7A5A', '#A07C2C', '#7A6A53', '#8C4A3C', '#6B7F6E', '#B98A2F', '#4F5B66'];

/* ---------- dashboard ---------- */
function monthRange() { const t = todayKey().slice(0, 7); return [t + '-01', addDays(t + '-01', 32).slice(0, 7) + '-01']; }
function sumTxns(filter) { return DB.transactions.filter(t => t.status !== 'void' && filter(t)).reduce((s, t) => s + t.amount, 0); }
function R_dashboard() {
  const el = document.getElementById('view-dashboard');
  const P = primaryAcct(), today = todayKey(), F = dayFigures(P.id, today);
  const cashSaleToday = sumTxns(t => t.type === 'income' && t.catName === 'Cash Sale' && t.bizDate === today);
  const wkStart = addDays(today, -6);
  const isOut = t => t.type === 'expense' || t.type === 'deduction' || (t.type === 'reversal' && !t.ruleId && t.catKind === 'expense');
  const wkExp = -sumTxns(t => t.bizDate >= wkStart && isOut(t));
  const [m0] = monthRange();
  const mExp = -sumTxns(t => t.bizDate >= m0 && isOut(t));
  const mAuto = -sumTxns(t => t.bizDate >= m0 && t.ruleId && (t.type === 'deduction' || t.type === 'transfer') && t.amount < 0);
  const mNet = sumTxns(t => t.bizDate >= m0);
  const days = [], lbl = [], inc = [], out = [];
  for (let i = 6; i >= 0; i--) { const d = addDays(today, -i); days.push(d); lbl.push(parseDay(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })); }
  days.forEach(d => {
    inc.push(sumTxns(t => t.bizDate === d && t.type === 'income'));
    out.push(-sumTxns(t => t.bizDate === d && (t.type === 'expense' || t.type === 'deduction' || (t.type === 'reversal' && !t.ruleId && t.catKind === 'expense'))));
  });
  const byCat = {};
  DB.transactions.forEach(t => { if (t.bizDate >= m0 && t.status !== 'void' && (t.type === 'expense' || t.type === 'deduction' || (t.type === 'reversal' && !t.ruleId && t.catKind === 'expense'))) byCat[catNameOf(t) || ruleName(t.ruleId) || 'Other'] = (byCat[catNameOf(t) || ruleName(t.ruleId) || 'Other'] || 0) - t.amount; });
  const segs = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([l, v], i) => ({ l, v, c: PAL[i % PAL.length] }));
  el.innerHTML = `
    <p class="eyebrow">Dashboard · ${prettyDay(today)}</p><h2 class="vtitle">${esc(P.name)} today</h2>
    <p class="vsub">Opening ${fmtP(F.opening)} → Closing <b class="${F.closing < 0 ? 'neg' : ''}">${fmtP(F.closing)}</b>${isLocked(today) ? ' <span class="tag closed">CLOSED</span>' : ''}</p>
    <div class="grid g4">
      ${[['Opening', F.opening, ''], ['Income', F.income, 'pos'], ['Auto deductions', F.auto, F.auto ? 'neg' : ''], ['Expenses', F.exp + F.tout + F.tin, (F.exp + F.tout + F.tin) ? 'neg' : '']].map(([l, v, c]) => `<div class="card pad"><p class="eyebrow">${l}</p><p class="bignum ${c}">${fmtP(v)}</p></div>`).join('')}
    </div>
    <div class="grid g4" style="margin-top:1.1rem">
      ${DB.accounts.filter(a => a.status === 'active').map(a => `<div class="card pad"><p class="eyebrow">${esc(a.name)}</p><p class="bignum ${balanceNow(a.id) < 0 ? 'neg' : ''}" style="font-size:1.6rem">${fmtP(balanceNow(a.id))}</p><button class="link" onclick="go('daily');UI.dailyAcct='${a.id}';R_daily()">open →</button></div>`).join('')}
    </div>
    <div class="grid g2" style="margin-top:1.1rem">
      <div class="card pad"><p class="eyebrow">This week · income vs outgo</p>${svgBars([{ l: 'In', v: inc, c: '#5B7A5A' }, { l: 'Out', v: out, c: '#C15F3C' }], lbl)}</div>
      <div class="card pad"><p class="eyebrow">This month · outgo by category</p><div style="margin-top:.6rem">${svgDonut(segs)}</div></div>
    </div>
    <div class="card pad" style="margin-top:1.1rem"><p class="eyebrow">Statistics</p>
      <div class="kv"><span>Today's Cash Sale</span><b>${fmtP(cashSaleToday)}</b></div>
      <div class="kv"><span>This week's expenses</span><b class="neg">${fmtP(-wkExp)}</b></div>
      <div class="kv"><span>This month's outgo</span><b class="neg">${fmtP(-mExp)}</b></div>
      <div class="kv"><span>This month's automatic deductions</span><b class="neg">${fmtP(-mAuto)}</b></div>
      <div class="kv total"><span>Month net cash flow</span><b class="${mNet < 0 ? 'neg' : 'pos'}">${fmtSign(mNet)}</b></div>
    </div>`;
}

/* ---------- daily accounting ---------- */
function R_daily() {
  const el = document.getElementById('view-daily');
  if (!UI.dailyAcct || !acct(UI.dailyAcct)) UI.dailyAcct = primaryAcct().id;
  const d = UI.dailyDate, A = acct(UI.dailyAcct), F = dayFigures(A.id, d), locked = isLocked(d);
  const list = (rows, empty) => rows.length ? `<div class="tblwrap"><table class="tbl"><tbody>${rows}</tbody></table></div>` : `<div class="empty">${empty}</div>`;
  const row = t => `<tr><td>${esc(catNameOf(t) || ruleName(t.ruleId) || t.type)}${t.ruleId ? ' <span class="tag auto">auto</span>' : ''}<br><span class="faint" style="font-size:.75rem">${esc(t.note || '')} · ${t.txn}</span></td>
    <td class="r"><b class="${t.amount < 0 ? 'neg' : 'pos'}">${fmtSign(t.amount)}</b><br>${locked ? '' : `<button class="link" onclick="askReverse('${t.id}')">reverse</button>`}</td></tr>`;
  const inc = DB.transactions.filter(t => t.accountId === A.id && t.bizDate === d && t.type === 'income' && t.status !== 'void').sort((a, b) => a.ts - b.ts);
  const auto = DB.transactions.filter(t => t.accountId === A.id && t.bizDate === d && (t.type === 'deduction' || (t.type === 'reversal' && t.ruleId)) && t.status !== 'void').sort((a, b) => a.ts - b.ts);
  const exp = DB.transactions.filter(t => t.accountId === A.id && t.bizDate === d && (t.type === 'expense' || t.type === 'transfer' || (t.type === 'reversal' && !t.ruleId)) && t.status !== 'void').sort((a, b) => a.ts - b.ts);
  el.innerHTML = `
    <p class="eyebrow">Daily accounting</p>
    <div class="dayhead"><h2>${prettyDay(d)}</h2>
      ${locked ? '<span class="tag closed">CLOSED</span>' : '<span class="tag open">open</span>'}
      <span style="flex:1"></span>
      <input type="date" class="inp" style="width:auto" value="${d}" max="${todayKey()}" onchange="UI.dailyDate=this.value;R_daily()">
      <button class="btn-g" onclick="UI.dailyDate=addDays(UI.dailyDate,-1);R_daily()">←</button>
      <button class="btn-g" onclick="UI.dailyDate=todayKey();R_daily()">Today</button>
      <button class="btn-g" onclick="UI.dailyDate=addDays(UI.dailyDate,1);R_daily()">→</button>
    </div>
    <div class="card pad" style="margin-bottom:1.1rem"><label class="f" style="margin:0;max-width:22rem"><span>Account</span>
      <select class="inp" onchange="UI.dailyAcct=this.value;R_daily()">${DB.accounts.filter(a => a.status === 'active').map(a => `<option value="${a.id}" ${a.id === A.id ? 'selected' : ''}>${esc(a.name)} — ${fmtP(balanceNow(a.id))}</option>`).join('')}</select></label></div>
    ${locked ? `<div class="lockbar" style="margin-bottom:1.1rem">This day is closed. Figures are frozen — reopen (with confirmation) to change anything.</div>` : ''}
    <div class="card pad"><p class="eyebrow">Opening balance · ${esc(A.name)}</p><p class="bignum">${fmtP(F.opening)}</p></div>
    <div class="grid g2" style="margin-top:1.1rem">
      <div class="card pad"><p class="eyebrow">Income (${inc.length})</p>${list(inc.map(row), 'No income recorded this day yet.')}
        <div class="kv total"><span>Total income</span><b class="pos">${fmtP(F.income)}</b></div></div>
      <div class="card pad"><p class="eyebrow">Automatic deductions (${auto.length})</p>${list(auto.map(row), 'No automatic deductions fired this day.')}
        <div class="kv total"><span>Total auto</span><b class="${F.auto ? 'neg' : ''}">${fmtP(F.auto)}</b></div></div>
    </div>
    <div class="card pad" style="margin-top:1.1rem"><p class="eyebrow">Expenses &amp; transfers (${exp.length})</p>${list(exp.map(row), 'No expenses this day yet.')}
      <div class="kv total"><span>Total out</span><b class="${(F.exp + F.tout) ? 'neg' : ''}">${fmtP(F.exp + F.tout)}</b></div>
      ${F.tin ? `<div class="kv"><span>Transfers in</span><b class="pos">${fmtP(F.tin)}</b></div>` : ''}</div>
    <div class="card pad" style="margin-top:1.1rem"><div class="kv grand"><span>Closing balance</span><b class="${F.closing < 0 ? 'neg' : ''}">${fmtP(F.closing)}</b></div>
      <div class="rowbtns">
        ${locked ? '' : `<button class="btn" onclick="openIncome('${d}','${A.id}')">+ Add Income</button><button class="btn" onclick="openExpense('${d}','${A.id}')">+ Add Expense</button>`}
        <button class="btn-g" onclick="go('transactions')">View Transactions</button>
        ${locked ? `<button class="btn-danger-g" onclick="askReopen('${d}')">Reopen Day</button>` : `<button class="btn-g" onclick="askClose('${d}')">Close Day</button>`}
      </div></div>`;
}
function askClose(d) {
  const F = dayFigures(UI.dailyAcct, d);
  confirmDlg('Close ' + prettyDay(d) + '?', `Closing saves a snapshot and freezes the day.<br>Closing balance: <b>${fmtP(F.closing)}</b>`, 'Close Day', () => {
    const r = closeDay(d); if (r.err) return toast(r.err, 'err'); toast(`Day closed at ${fmtP(F.closing)}. Tomorrow opens from this figure.`); R_daily();
  });
}
function askReopen(d) {
  confirmDlg('Reopen ' + prettyDay(d) + '?', 'Reopening allows edits again. This override is written to the audit log.', 'Reopen', () => {
    const r = reopenDay(d); if (r.err) return toast(r.err, 'err'); toast('Day reopened.'); R_daily();
  });
}
function askReverse(id) {
  openModal(`<p class="eyebrow">Reverse — never delete</p><h3>Reverse transaction?</h3>
    <p class="muted">A reversal creates an offsetting entry, preserving the audit trail. Original stays visible as <i>reversed</i>.</p>
    <label class="f"><span>Reason (optional)</span><input id="revReason" class="inp" placeholder="e.g. entered twice"></label>
    <div class="rowbtns end"><button class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" onclick="doReverse('${id}')">Reverse</button></div>`);
}
function doReverse(id) {
  const r = reverseTxn(id, (document.getElementById('revReason') || {}).value || '');
  if (r.err) return toast(r.err, 'err');
  closeModal(); toast('Reversed with an offsetting entry.'); go(UI.tab);
}

/*@@P4*/
/* ================= P4: ledger, masters, rules, reports, settings ================= */
function download(name, content, mime) {
  const b = new Blob([content], { type: mime || 'text/csv' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const csvQ = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
function txnMatches(t, f) {
  if (f.acct && t.accountId !== f.acct) return false;
  if (f.type && t.type !== f.type) return false;
  if (f.rule && t.ruleId !== f.rule) return false;
  if (f.from && t.bizDate < f.from) return false;
  if (f.to && t.bizDate > f.to) return false;
  if (f.cat) { const c = (t.catId || '') + ' ' + (t.expAcct || '') + ' ' + (t.catName || '') + ' ' + (t.ruleName || ''); if (!c.toLowerCase().includes(f.cat.toLowerCase()) && t.catId !== f.cat && t.ruleId !== f.cat && t.expAcct !== f.cat) return false; }
  if (f.q) {
    const q = f.q.toLowerCase(), dig = f.q.replace(/[^\d]/g, '');
    const hay = [t.txn, t.note, t.catName, t.ruleName, acctName(t.accountId), t.type, t.by, fmtP(t.amount)].join(' ').toLowerCase();
    if (!hay.includes(q) && !(dig && String(Math.abs(Math.round(t.amount))).includes(dig))) return false;
  }
  return true;
}
function typeTag(t) {
  const m = { income: ['inc', 'Income'], deduction: ['auto', 'Auto'], expense: ['exp', 'Expense'], transfer: ['auto', 'Transfer'], reversal: ['exp', 'Reversal'], opening: ['open', 'Opening'], adjust: ['auto', 'Adjust'] };
  const [c, l] = m[t.type] || ['open', t.type]; return `<span class="tag ${c}">${l}</span>`;
}
/* ---------- transactions + audit ---------- */
function R_txn() {
  const el = document.getElementById('view-transactions'), f = UI.f;
  if (UI.txnTab === 'audit') return R_audit(el);
  const cats = [...DB.incomeCats.map(c => ({ id: c.id, n: c.name + ' (in)' })), ...expHeads().map(c => ({ id: c.id, n: c.name + ' (head)' }))];
  const rows = DB.transactions.filter(t => t.status !== 'void' && txnMatches(t, f)).sort((a, b) => b.ts - a.ts).slice(0, 400);
  el.innerHTML = `
    <p class="eyebrow">Ledger</p><h2 class="vtitle">Transactions</h2>
    <p class="vsub">Every change is a posted entry. Corrections happen via <b>reversal</b> — history is never edited or deleted.</p>
    <div class="seg"><button class="btn-g on" onclick="UI.txnTab='list';R_txn()">Entries</button><button class="btn-g" onclick="UI.txnTab='audit';R_txn()">Audit log</button>
      <span style="flex:1"></span><button class="btn-g" onclick="exportTxnCSV()">Export CSV</button><button class="btn-g" onclick="window.print()">Print / PDF</button></div>
    <div class="card pad" style="margin-bottom:1.1rem"><div class="grid g4">
      <label class="f"><span>Search</span><input id="fQ" class="inp" value="${esc(f.q)}" placeholder="text, ₹ amount, TXN-id…" oninput="UI.f.q=this.value;R_txnBody()"></label>
      <label class="f"><span>From</span><input type="date" class="inp" value="${f.from}" onchange="UI.f.from=this.value;R_txnBody()"></label>
      <label class="f"><span>To</span><input type="date" class="inp" value="${f.to}" onchange="UI.f.to=this.value;R_txnBody()"></label>
      <label class="f"><span>Account</span><select class="inp" onchange="UI.f.acct=this.value;R_txnBody()"><option value="">All accounts</option>${DB.accounts.map(a => `<option value="${a.id}" ${f.acct === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="f"><span>Category / rule</span><select class="inp" onchange="UI.f.cat=this.value;R_txnBody()"><option value="">All</option>${cats.map(c => `<option value="${c.id}" ${f.cat === c.id ? 'selected' : ''}>${esc(c.n)}</option>`).join('')}${DB.rules.map(r => `<option value="${r.id}" ${f.cat === r.id ? 'selected' : ''}>${esc(r.name)} (rule)</option>`).join('')}</select></label>
      <label class="f"><span>Type</span><select class="inp" onchange="UI.f.type=this.value;R_txnBody()"><option value="">All types</option>${['income', 'deduction', 'expense', 'transfer', 'reversal', 'opening', 'adjust'].map(t => `<option ${f.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="f"><span>Rule</span><select class="inp" onchange="UI.f.rule=this.value;R_txnBody()"><option value="">All rules</option>${DB.rules.map(r => `<option value="${r.id}" ${f.rule === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <div style="display:flex;align-items:end"><button class="btn-g" onclick="UI.f={q:'',from:'',to:'',acct:'',cat:'',type:'',rule:''};R_txn()">Clear</button></div>
    </div></div>
    <div class="card pad"><div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th>ID</th><th>Type</th><th>Category / Rule</th><th>Account</th><th style="text-align:right">Amount</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody id="txnBody"></tbody></table></div>
    <p class="faint" style="font-size:.8rem">Showing ${rows.length} of ${DB.transactions.length} entries.</p></div>`;
  R_txnBody();
}
function R_txnBody() {
  const f = UI.f, tb = document.getElementById('txnBody'); if (!tb) return;
  const rows = DB.transactions.filter(t => t.status !== 'void' && txnMatches(t, f)).sort((a, b) => b.ts - a.ts).slice(0, 400);
  tb.innerHTML = rows.map(t => `<tr><td style="white-space:nowrap;font-size:.78rem">${prettyDay(t.bizDate)}<br><span class="faint">${new Date(t.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span></td>
    <td style="font-size:.78rem">${t.txn}</td><td>${typeTag(t)}</td>
    <td>${esc(catNameOf(t) || ruleName(t.ruleId) || '—')}${t.ruleId ? `<br><span class="faint" style="font-size:.75rem">via ${esc(ruleName(t.ruleId))}</span>` : ''}</td>
    <td>${esc(acctName(t.accountId))}</td><td class="r"><b class="${t.amount < 0 ? 'neg' : 'pos'}">${fmtSign(t.amount)}</b></td>
    <td style="font-size:.8rem" class="muted">${esc(t.note || '')}<br><span class="faint">${esc(t.by || '')}${t.method ? ' · ' + esc(t.method) : ''}</span></td>
    <td style="font-size:.78rem">${t.status === 'reversed' ? '<span class="tag">reversed</span>' : '<span class="tag open">posted</span>'}</td>
    <td>${(t.status === 'posted' && !isLocked(t.bizDate)) ? `<button class="link" onclick="askReverse('${t.id}')">reverse</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9"><div class="empty">No entries match.</div></td></tr>';
}
function exportTxnCSV() {
  const rows = DB.transactions.filter(t => t.status !== 'void' && txnMatches(t, UI.f)).sort((a, b) => a.ts - b.ts);
  const head = ['date', 'time', 'txn_id', 'type', 'category', 'rule', 'account', 'amount_paise', 'amount', 'note', 'method', 'by', 'status'];
  download('cashbook-transactions.csv', [head.join(',')].concat(rows.map(t => [t.bizDate, new Date(t.ts).toLocaleTimeString('en-IN'), t.txn, t.type, csvQ(catNameOf(t)), csvQ(ruleName(t.ruleId)), csvQ(acctName(t.accountId)), t.amount, (t.amount / 100).toFixed(2), csvQ(t.note), csvQ(t.method), csvQ(t.by), t.status].join(','))).join('\n'));
  toast('CSV downloaded (opens in Excel).');
}
function R_audit(el) {
  el.innerHTML = `<p class="eyebrow">Ledger</p><h2 class="vtitle">Audit log</h2><p class="vsub">Who did what, when — newest first.</p>
    <div class="seg"><button class="btn-g" onclick="UI.txnTab='list';R_txn()">Entries</button><button class="btn-g on" onclick="UI.txnTab='audit';R_txn()">Audit log</button></div>
    <div class="card pad"><div class="tblwrap"><table class="tbl"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${DB.audit.map(a => `<tr><td style="white-space:nowrap;font-size:.78rem">${new Date(a.ts).toLocaleString('en-IN')}</td><td>${esc(a.user)}</td><td><span class="tag">${esc(a.action)}</span></td><td style="font-size:.85rem">${esc(a.details)}${a.newV ? `<br><span class="faint">${esc(String(a.newV))}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="4"><div class="empty">No audit entries yet.</div></td></tr>'}
    </tbody></table></div></div>`;
}
/* ---------- income ---------- */
function openIncome(d, a) {
  const cats = DB.incomeCats.filter(c => c.active);
  if (!cats.length) return toast('Create an income category first.', 'err');
  openModal(`<p class="eyebrow">Income</p><h3>Add income</h3>
    <form onsubmit="return doIncome()"><div class="grid g2">
    <label class="f"><span>Category (optional — why this money came)</span><select id="inCat" class="inp"><option value="">General (no category)</option>${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Amount ₹</span><input id="inAmt" class="inp" inputmode="decimal" placeholder="0.00" required></label>
    <label class="f"><span>Destination account</span><select id="inAcct" class="inp">${DB.accounts.filter(x => x.status === 'active').map(x => `<option value="${x.id}" ${(a || primaryAcct().id) === x.id ? 'selected' : ''}>${esc(x.name)} — ${fmtP(balanceNow(x.id))}</option>`).join('')}</select></label>
    <label class="f"><span>Date</span><input id="inDate" type="date" class="inp" value="${d || todayKey()}" max="${todayKey()}"></label></div>
    <label class="f"><span>Note</span><input id="inNote" class="inp" placeholder="optional"></label>
    <div id="inPreview" class="faint" style="font-size:.82rem"></div>
    <div class="rowbtns end"><button type="button" class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" type="submit">Save income</button></div></form>`);
  const upd = () => {
    const r = previewFor(document.getElementById('inAcct').value, document.getElementById('inCat').value, toPaise(document.getElementById('inAmt').value || 0) || 0, document.getElementById('inDate').value || todayKey());
    document.getElementById('inPreview').innerHTML = r;
  };
  ['inAcct', 'inCat', 'inAmt', 'inDate'].forEach(id => document.getElementById(id).addEventListener('input', upd)); upd();
  setTimeout(() => document.getElementById('inAmt').focus(), 60);
}
function previewFor(acctId, catId, amt, bizDate) {
  if (!(amt > 0)) return 'Enter an amount to preview automatic deductions.';
  const dayTotal = DB.transactions.filter(t => t.accountId === acctId && t.bizDate === bizDate && t.type === 'income' && t.status !== 'void').reduce((s, t) => s + t.amount, 0) + amt;
  const { plan } = planFiring({ trigger: amt, dayTotal, bizDate, srcAcct: acctId, incCatId: catId, pending: [] });
  const fire = plan.filter(p => !p.skip && p.deduct);
  if (!fire.length) return 'No automatic rules will fire on this entry.';
  return '<b>Will deduct instantly:</b><br>' + fire.map(p => `• ${esc(p.rule.name)} — <b>${fmtP(p.deduct)}</b> <span class="faint">(${esc(p.explain)})</span>`).join('<br>');
}
function doIncome() {
  const amt = toPaise(document.getElementById('inAmt').value);
  const r = addIncome({ catId: document.getElementById('inCat').value, amount: amt, accountId: document.getElementById('inAcct').value, bizDate: document.getElementById('inDate').value || todayKey(), note: document.getElementById('inNote').value.trim() });
  if (r.err) { if (r.err !== 'locked') toast(r.err, 'err'); return false; }
  closeModal(); toast(`Income saved. ${r.fired.length ? r.fired.length + ' automatic deduction' + (r.fired.length > 1 ? 's' : '') + ' applied.' : 'No rules fired.'}`); go(UI.tab);
  return false;
}
function R_income() {
  const el = document.getElementById('view-income');
  const rows = DB.transactions.filter(t => t.type === 'income' && t.status !== 'void').sort((a, b) => b.ts - a.ts).slice(0, 150);
  el.innerHTML = `<p class="eyebrow">Income</p><h2 class="vtitle">Income entries</h2><p class="vsub">Recording income instantly fires matching rules.</p>
    <div class="rowbtns" style="margin:0 0 1.1rem"><button class="btn" onclick="openIncome()">+ Add Income</button></div>
    <div class="grid g2">
    <div class="card pad"><div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th>Category</th><th>Account</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody>
    ${rows.map(t => `<tr><td style="font-size:.8rem">${prettyDay(t.bizDate)}</td><td>${esc(catNameOf(t))}<br><span class="faint" style="font-size:.75rem">${esc(t.note || '')}</span></td><td>${esc(acctName(t.accountId))}</td><td class="r pos"><b>${fmtP(t.amount)}</b></td><td>${!isLocked(t.bizDate) ? `<button class="link" onclick="askReverse('${t.id}')">reverse</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No income yet.</div></td></tr>'}
    </tbody></table></div></div>
    <div class="card pad"><p class="eyebrow">Income categories</p>
    ${DB.incomeCats.map(c => `<div class="kv"><span>${esc(c.name)} ${c.active ? '' : '<span class="tag">off</span>'}</span><span><button class="link" onclick="toggleCat('${c.id}')">${c.active ? 'disable' : 'enable'}</button></span></div>`).join('')}
    <form onsubmit="return addCatUI()" style="display:flex;gap:.5rem;margin-top:.8rem"><input id="newInCat" class="inp" placeholder="New category name"><button class="btn-g" type="submit">Add</button></form></div></div>`;
}
function toggleCat(id) {
  const c = DB.incomeCats.find(x => x.id === id); if (!c) return;
  c.active = !c.active; audit('category', `income category ${c.name} ${c.active ? 'enabled' : 'disabled'}`, '', ''); save(); go(UI.tab);
}
function addCatUI() {
  const inp = document.getElementById('newInCat');
  const n = inp.value.trim(); if (!n) return false;
  if (DB.incomeCats.some(c => c.name.toLowerCase() === n.toLowerCase())) { toast('That category already exists.', 'err'); return false; }
  DB.incomeCats.push({ id: uid(), name: n.slice(0, 60), active: true });
  audit('category', 'income category created: ' + n, '', ''); save(); go(UI.tab); return false;
}
/* ---------- expenses (expense = account) ---------- */
let _allowOnce = null;
function openExpense(d, a, preset) {
  const heads = expHeads().filter(h => h.status === 'active');
  openModal(`<p class="eyebrow">Expense</p><h3>Add expense</h3>
    <p class="muted" style="font-size:.85rem;margin-top:-.6rem">Money moves from the source account into the expense head — the head's balance is its total spend.</p>
    <form onsubmit="return doExpense(false)"><div class="grid g2">
    <label class="f"><span>Expense head (account)</span><select id="exHead" class="inp">${heads.map(h => `<option value="${h.id}" ${preset === h.id ? 'selected' : ''}>${esc(h.name)} — spent ${fmtP(balanceNow(h.id))}</option>`).join('')}</select></label>
    <label class="f"><span>Or create new head</span><input id="exNewHead" class="inp" placeholder="e.g. Diwali gifts"></label>
    <label class="f"><span>Amount ₹</span><input id="exAmt" class="inp" inputmode="decimal" placeholder="0.00" required></label>
    <label class="f"><span>Source account</span><select id="exAcct" class="inp">${cashAccts().filter(x => x.status === 'active').map(x => `<option value="${x.id}" ${(a || primaryAcct().id) === x.id ? 'selected' : ''}>${esc(x.name)} — ${fmtP(balanceNow(x.id))}</option>`).join('')}</select></label>
    <label class="f"><span>Date</span><input id="exDate" type="date" class="inp" value="${d || todayKey()}" max="${todayKey()}"></label>
    <label class="f"><span>Payment method</span><select id="exMethod" class="inp"><option>Cash</option><option>UPI</option><option>Bank transfer</option><option>Card</option><option>Other</option></select></label></div>
    <label class="f"><span>Description / notes</span><input id="exNote" class="inp" placeholder="optional"></label>
    <div class="rowbtns end"><button type="button" class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" type="submit">Save expense</button></div></form>`);
  setTimeout(() => document.getElementById('exAmt').focus(), 60);
}
function doExpense(allow) {
  const amt = toPaise(document.getElementById('exAmt').value);
  const args = { headId: document.getElementById('exHead').value || null, newHead: document.getElementById('exNewHead').value, amount: amt, accountId: document.getElementById('exAcct').value, bizDate: document.getElementById('exDate').value || todayKey(), method: document.getElementById('exMethod').value, note: document.getElementById('exNote').value.trim(), allowNegative: !!allow };
  const r = addExpense(args);
  if (r.blocked) {
    _allowOnce = () => doExpense(true);
    openModal(`<p class="eyebrow" style="color:var(--red)">Insufficient balance</p><h3>Not enough in ${esc(acct(args.accountId).name)}</h3>
      <div class="kv"><span>Available</span><b>${fmtP(r.available)}</b></div>
      <div class="kv"><span>Requested</span><b>${fmtP(amt)}</b></div>
      <div class="kv total"><span>Shortfall</span><b class="neg">${fmtP(r.shortfall)}</b></div>
      <div class="rowbtns end"><button class="btn-g" onclick="closeModal();openExpense()">Cancel</button><button class="btn" onclick="_allowOnce()">Allow Negative Balance</button></div>`);
    return false;
  }
  if (r.err) { if (r.err !== 'locked') toast(r.err, 'err'); return false; }
  closeModal(); toast('Expense saved.'); go(UI.tab); return false;
}
function R_exp() {
  const el = document.getElementById('view-expenses');
  const rows = DB.transactions.filter(t => t.type === 'expense' && t.status !== 'void').sort((a, b) => b.ts - a.ts).slice(0, 150);
  const spent = id => DB.transactions.filter(t => t.expAcct === id && t.type === 'expense' && t.status !== 'void').reduce((s, t) => s - t.amount, 0);
  el.innerHTML = `<p class="eyebrow">Expenses</p><h2 class="vtitle">Expenses</h2><p class="vsub">Each expense moves money into its head account below. Defaults to ${esc(primaryAcct().name)}.</p>
    <div class="rowbtns" style="margin:0 0 1.1rem"><button class="btn" onclick="openExpense()">+ Add Expense</button><button class="btn-g" onclick="go('accounts')">Manage heads</button></div>
    <div class="grid g2"><div class="card pad"><div class="tblwrap"><table class="tbl"><thead><tr><th>Date</th><th>Head</th><th>From</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody>
    ${rows.map(t => `<tr><td style="font-size:.8rem">${prettyDay(t.bizDate)}</td><td>${esc(catNameOf(t))}<br><span class="faint" style="font-size:.75rem">${esc(t.note || '')}${t.method ? ' · ' + esc(t.method) : ''}</span></td><td>${esc(acctName(t.accountId))}</td><td class="r neg"><b>${fmtP(t.amount)}</b></td><td>${!isLocked(t.bizDate) ? `<button class="link" onclick="askReverse('${t.id}')">reverse</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No expenses yet.</div></td></tr>'}
    </tbody></table></div></div>
    <div class="card pad"><p class="eyebrow">Expense heads · total spend</p>
    ${expHeads().filter(h => h.status === 'active').map(h => `<div class="kv"><span>${esc(h.name)}</span><b class="neg">${fmtP(spent(h.id))}</b></div>`).join('') || '<div class="empty">No heads yet — one is created with your first expense.</div>'}
    <p class="faint" style="font-size:.78rem">Rename, deactivate or delete heads under Accounts. Heads with entries cannot be deleted.</p></div></div>`;
}
/* ---------- accounts (cash accounts + expense heads — everything is an account) ---------- */
function R_acct() {
  const el = document.getElementById('view-accounts');
  const card = a => { const b = balanceNow(a.id); const used = DB.transactions.some(t => t.accountId === a.id);
    const isExp = (a.kind || 'cash') === 'expense';
    return `<div class="card pad"><p class="eyebrow">${isExp ? 'Expense head' : 'Account'}${a.status === 'active' ? '' : ' · inactive'}</p><h3 style="font-size:1.4rem">${esc(a.name)}</h3>
      <p class="bignum ${b < 0 || isExp ? 'neg' : ''}" style="font-size:1.7rem">${fmtP(isExp ? b : b)}</p>
      <p class="faint" style="font-size:.78rem">${isExp ? 'Total spend' : 'Opening ' + fmtP(a.opening)} · ${DB.transactions.filter(t => t.accountId === a.id && t.status !== 'void').length} entries</p>
      <div class="rowbtns"><button class="btn-g" onclick="acctStatement('${a.id}')">Statement</button><button class="btn-g" onclick="openAccount('${a.id}')">Edit</button>
      ${used ? `<button class="btn-g" onclick="toggleAcct('${a.id}')">${a.status === 'active' ? 'Deactivate' : 'Activate'}</button>` : `<button class="btn-danger-g" onclick="delAcct('${a.id}')">Delete</button>`}</div></div>`; };
  el.innerHTML = `<p class="eyebrow">Accounts</p><h2 class="vtitle">Accounts</h2><p class="vsub">Everything is an account — cash accounts hold money, expense heads collect spend. Balances derive from the ledger.</p>
    <div class="rowbtns" style="margin:0 0 1.1rem"><button class="btn" onclick="openAccount()">+ Add Account</button><button class="btn-g" onclick="openTransfer()">Transfer Between Accounts</button></div>
    <p class="eyebrow" style="margin-bottom:.6rem">Cash accounts</p>
    <div class="grid g3" style="margin-bottom:1.4rem">${cashAccts().map(card).join('') || '<div class="empty">None.</div>'}</div>
    <p class="eyebrow" style="margin-bottom:.6rem">Expense heads</p>
    <div class="grid g3">${expHeads().map(card).join('') || '<div class="empty">None yet — created automatically with your first expense.</div>'}</div>`;
}
function acctStatement(id) { UI.f = { q: '', from: '', to: '', acct: id, cat: '', type: '', rule: '' }; UI.txnTab = 'list'; go('transactions'); }
function openAccount(id, kind) {
  const a = id ? acct(id) : null;
  const k = a ? (a.kind || 'cash') : (kind || 'cash');
  openModal(`<p class="eyebrow">${k === 'expense' ? 'Expense head' : 'Account'}</p><h3>${a ? 'Edit' : 'Add'} ${k === 'expense' ? 'expense head' : 'account'}</h3>
    <form onsubmit="return doAccount('${id || ''}')">
    <label class="f"><span>Name</span><input id="acName" class="inp" value="${esc(a ? a.name : '')}" required maxlength="60"></label>
    <div class="grid g2"><label class="f"><span>Kind</span><select id="acKind" class="inp" ${a ? 'disabled' : ''} onchange="document.getElementById('acOpen').disabled=this.value==='expense'||!!'${id || ''}'"><option value="cash" ${k === 'cash' ? 'selected' : ''}>Cash account (holds money)</option><option value="expense" ${k === 'expense' ? 'selected' : ''}>Expense head (collects spend)</option></select></label>
    <label class="f"><span>Opening balance ₹ ${a ? '(locked — history safe)' : ''}</span><input id="acOpen" class="inp" inputmode="decimal" value="${a ? (a.opening / 100).toFixed(2) : '0'}" ${(a || k === 'expense') ? 'disabled' : ''}></label>
    <label class="f"><span>Status</span><select id="acStatus" class="inp"><option ${!a || a.status === 'active' ? 'selected' : ''}>active</option><option ${a && a.status !== 'active' ? 'selected' : ''}>inactive</option></select></label></div>
    <div class="rowbtns end"><button type="button" class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" type="submit">Save</button></div></form>`);
}
function doAccount(id) {
  const n = document.getElementById('acName').value.trim(); if (!n) { toast('Name required.', 'err'); return false; }
  if (id) {
    const a = acct(id); const old = a.name + '/' + a.status;
    a.name = n.slice(0, 60); a.status = document.getElementById('acStatus').value; a.updatedAt = Date.now();
    audit('account', 'Edited account ' + n, old, a.name + '/' + a.status);
  } else {
    const kind = document.getElementById('acKind').value || 'cash';
    const o = kind === 'expense' ? 0 : (toPaise(document.getElementById('acOpen').value || 0) || 0); if (o === null || o < 0) { toast('Opening must be 0 or more.', 'err'); return false; }
    const t = Date.now();
    const a = { id: uid(), name: n.slice(0, 60), opening: o, currency: DB.settings.currency, kind, status: document.getElementById('acStatus').value, createdAt: t, updatedAt: t };
    DB.accounts.push(a);
    if (o) DB.transactions.push(mkTxn({ bizDate: todayKey(), type: 'opening', accountId: a.id, amount: o, note: 'Opening balance' }));
    audit('account', 'Created account ' + a.name + ' opening ' + fmtP(o), '', '');
  }
  save(); closeModal(); toast('Account saved.'); go(UI.tab); return false;
}
function toggleAcct(id) { const a = acct(id); a.status = a.status === 'active' ? 'inactive' : 'active'; a.updatedAt = Date.now(); audit('account', (a.status === 'active' ? 'Activated ' : 'Deactivated ') + a.name, '', ''); save(); go(UI.tab); }
function delAcct(id) {
  if (DB.transactions.some(t => t.accountId === id)) return toast('Has entries — deactivate instead.', 'err');
  confirmDlg('Delete account?', `“${esc(acct(id).name)}” has no entries and will be removed.`, 'Delete', () => {
    audit('account', 'Deleted account ' + acct(id).name, '', ''); DB.accounts = DB.accounts.filter(a => a.id !== id); save(); go(UI.tab);
  });
}
function openTransfer() {
  const opts = DB.accounts.filter(a => a.status === 'active').map(a => `<option value="${a.id}">${esc(a.name)} — ${fmtP(balanceNow(a.id))}</option>`).join('');
  openModal(`<p class="eyebrow">Transfer</p><h3>Move between accounts</h3>
    <form onsubmit="return doTransfer()"><div class="grid g2">
    <label class="f"><span>From</span><select id="trFrom" class="inp">${opts}</select></label>
    <label class="f"><span>To</span><select id="trTo" class="inp">${opts}</select></label>
    <label class="f"><span>Amount ₹</span><input id="trAmt" class="inp" inputmode="decimal" required></label>
    <label class="f"><span>Date</span><input id="trDate" type="date" class="inp" value="${todayKey()}" max="${todayKey()}"></label></div>
    <label class="f"><span>Note</span><input id="trNote" class="inp"></label>
    <div class="rowbtns end"><button type="button" class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" type="submit">Transfer</button></div></form>`);
}
function doTransfer() {
  const r = addTransfer({ fromId: document.getElementById('trFrom').value, toId: document.getElementById('trTo').value, amount: toPaise(document.getElementById('trAmt').value), bizDate: document.getElementById('trDate').value || todayKey(), note: document.getElementById('trNote').value.trim() });
  if (r.blocked) { toast(`Insufficient: available ${fmtP(r.available)}, short ${fmtP(r.shortfall)}.`, 'err'); return false; }
  if (r.err) { if (r.err !== 'locked') toast(r.err, 'err'); return false; }
  closeModal(); toast('Transferred.'); go(UI.tab); return false;
}
/*@@P5*/
/* ================= P5: rules studio, reports, settings, init ================= */
function R_rules() {
  const el = document.getElementById('view-rules');
  const rs = sortedRules();
  el.innerHTML = `<p class="eyebrow">Rule engine</p><h2 class="vtitle">Accounting rules</h2>
    <p class="vsub">Rules fire <b>in priority order</b> when income is recorded. They only read income figures — never each other's outputs — so circular calculations are impossible by construction.</p>
    <div class="rowbtns" style="margin:0 0 1.1rem"><button class="btn" onclick="openRule()">+ Add Rule</button><button class="btn-g" onclick="openSim()">Test / Simulate (no real entries)</button></div>
    ${rs.map((r, i) => `<div class="card pad" style="margin-bottom:.9rem;${r.active ? '' : 'opacity:.55'}">
      <div style="display:flex;gap:.7rem;align-items:baseline;flex-wrap:wrap"><span class="tag">#${r.priority}</span><h3 style="font-size:1.25rem">${esc(r.name)}</h3>
      <span class="tag ${r.active ? 'auto' : ''}">${r.active ? 'active' : 'paused'}</span><span class="tag">${r.type}</span><span class="tag">${r.freq}</span></div>
      <p class="muted" style="font-size:.88rem;margin:.4rem 0">${esc(ruleDesc(r))}</p>
      <p class="faint" style="font-size:.78rem">From <b>${esc(acctName(r.src))}</b>${r.dst ? ` → to <b>${esc(acctName(r.dst))}</b>` : ' → <b>deducted (leaves books)</b>'}${r.incCat ? ` · only on <b>${esc((DB.incomeCats.find(c => c.id === r.incCat) || {}).name || '')}</b>` : ' · on any income'}${r.start ? ` · from ${r.start}` : ''}${r.end ? ` · until ${r.end}` : ''}</p>
      <div class="rowbtns">
        <button class="btn-g" onclick="moveRule('${r.id}',-1)" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn-g" onclick="moveRule('${r.id}',1)" ${i === rs.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn-g" onclick="toggleRule('${r.id}')">${r.active ? 'Pause' : 'Resume'}</button>
        <button class="btn-g" onclick="openRule('${r.id}')">Edit</button>
        <button class="btn-g" onclick="openSim('${r.id}')">Test</button>
        <button class="btn-danger-g" onclick="delRule('${r.id}')">Delete</button>
      </div></div>`).join('') || '<div class="card pad"><div class="empty">No rules yet. Add your first — e.g. STD ₹100 daily, or Insurance 10% of Cash Sale.</div></div>'}`;
}
function ruleDesc(r) {
  const amt = r.type === 'percent' ? r.value + '%' : r.type === 'conditional' ? `if…then ${r.thenKind === 'percent' ? r.value + '%' : fmtP(r.value)} else ${(r.els || {}).kind === 'percent' ? (r.els || {}).val + '%' : fmtP((r.els || {}).val || 0)}` : r.type === 'sweep' ? 'remainder' : fmtP(r.value);
  return `${r.type} · ${amt}${r.type === 'percent' || (r.type === 'conditional') ? ` of ${r.basis === 'day_total' ? "day's income" : 'each income'}` : ''} · ${r.freq}`;
}
function moveRule(id, dir) {
  const rs = sortedRules(); const i = rs.findIndex(r => r.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= rs.length) return;
  const a = rs[i], b = rs[j]; const t = a.priority; a.priority = b.priority; b.priority = t;
  a.updatedAt = b.updatedAt = Date.now();
  audit('rule', `Priority: ${a.name} ↔ ${b.name}`, '', ''); save(); R_rules(); toast('Priority updated.');
}
function toggleRule(id) { const r = ruleById(id); r.active = !r.active; r.updatedAt = Date.now(); audit('rule', `${r.active ? 'Enabled' : 'Disabled'} rule ${r.name}`, '', ''); save(); R_rules(); }
function delRule(id) {
  const r = ruleById(id); const used = DB.transactions.some(t => t.ruleId === id);
  confirmDlg('Delete rule?', used ? `“${esc(r.name)}” has posted entries — it will be <b>deactivated</b>, history kept.` : `“${esc(r.name)}” will be permanently removed.`, used ? 'Deactivate' : 'Delete', () => {
    if (used) { r.active = false; audit('rule', 'Deactivated rule (has history): ' + r.name, '', ''); }
    else { DB.rules = DB.rules.filter(x => x.id !== id); audit('rule', 'Deleted rule: ' + r.name, '', ''); }
    r.updatedAt = Date.now(); save(); R_rules();
  });
}
let _conds = [];
function openRule(id) {
  const r = id ? ruleById(id) : { name: '', type: 'fixed', value: 0, thenKind: 'fixed', els: { kind: 'fixed', val: 0 }, basis: 'trigger', freq: 'daily', src: primaryAcct().id, dst: '', incCat: '', priority: (Math.max(0, ...DB.rules.map(x => x.priority || 0))) + 1, active: true, start: '', end: '', conds: [], desc: '' };
  _conds = JSON.parse(JSON.stringify(r.conds || []));
  const acctOpts = sel => DB.accounts.filter(a => a.status === 'active').map(a => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  openModal(`<p class="eyebrow">Rule</p><h3>${id ? 'Edit' : 'Add'} rule</h3>
    <form onsubmit="return doRule('${id || ''}')">
    <label class="f"><span>Rule name</span><input id="rName" class="inp" value="${esc(r.name)}" required maxlength="60" placeholder="e.g. STD, Insurance"></label>
    <div class="grid g2">
    <label class="f"><span>Type</span><select id="rType" class="inp" onchange="ruleTypeUI()"><option ${r.type === 'fixed' ? 'selected' : ''}>fixed</option><option ${r.type === 'percent' ? 'selected' : ''}>percent</option><option ${r.type === 'conditional' ? 'selected' : ''}>conditional</option><option ${r.type === 'sweep' ? 'selected' : ''}>sweep</option></select></label>
    <label class="f"><span>Frequency</span><select id="rFreq" class="inp"><option ${r.freq === 'per_income' ? 'selected' : ''}>per_income</option><option ${r.freq === 'daily' ? 'selected' : ''}>daily</option><option ${r.freq === 'weekly' ? 'selected' : ''}>weekly</option><option ${r.freq === 'monthly' ? 'selected' : ''}>monthly</option><option ${r.freq === 'once' ? 'selected' : ''}>once</option></select></label>
    <label class="f"><span>Source account (deduct from)</span><select id="rSrc" class="inp">${acctOpts(r.src)}</select></label>
    <label class="f"><span>Destination (empty = leaves books)</span><select id="rDst" class="inp"><option value="">— deducted, no destination —</option>${acctOpts(r.dst)}</select></label>
    <label class="f"><span>Only on income category (empty = any)</span><select id="rIncCat" class="inp"><option value="">Any income</option>${DB.incomeCats.filter(c => c.active).map(c => `<option value="${c.id}" ${r.incCat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Priority (lower runs first)</span><input id="rPriority" type="number" class="inp" value="${r.priority}"></label>
    <div id="rValWrap"><label class="f"><span id="rValLbl">Amount ₹</span><input id="rVal" class="inp" inputmode="decimal" value="${r.type === 'percent' ? r.value : ((r.value || 0) / 100)}"></label></div>
    <div id="rThenWrap" class="hidden"><label class="f"><span>IF-met value (₹ or %)</span><div style="display:flex;gap:.4rem"><select id="rThenKind" class="inp" style="max-width:7rem"><option ${r.thenKind === 'fixed' ? 'selected' : ''}>fixed</option><option ${r.thenKind === 'percent' ? 'selected' : ''}>percent</option></select><input id="rThenVal" class="inp" inputmode="decimal" value="${r.thenKind === 'percent' ? r.value : ((r.value || 0) / 100)}"></div></label></div>
    <div id="rElseWrap" class="hidden"><label class="f"><span>ELSE value (₹ or %)</span><div style="display:flex;gap:.4rem"><select id="rElseKind" class="inp" style="max-width:7rem"><option ${((r.els || {}).kind || 'fixed') === 'fixed' ? 'selected' : ''}>fixed</option><option ${((r.els || {}).kind) === 'percent' ? 'selected' : ''}>percent</option></select><input id="rElseVal" class="inp" inputmode="decimal" value="${((r.els || {}).kind) === 'percent' ? ((r.els || {}).val || 0) : (((r.els || {}).val || 0) / 100)}"></div></label></div>
    <label class="f"><span>Percent base</span><select id="rBasis" class="inp"><option value="trigger" ${r.basis === 'trigger' ? 'selected' : ''}>this income entry</option><option value="day_total" ${r.basis === 'day_total' ? 'selected' : ''}>day's income total</option></select></label>
    </div>
    <div id="rCondWrap" class="hidden"><p class="eyebrow">Conditions (ALL must pass)</p><div id="rConds"></div><button type="button" class="btn-g" onclick="_conds.push({left:'trigger',op:'>',right:500000});renderConds()">+ Condition</button></div>
    <div class="grid g2">
    <label class="f"><span>Start date (optional)</span><input id="rStart" type="date" class="inp" value="${r.start || ''}"></label>
    <label class="f"><span>End date (optional)</span><input id="rEnd" type="date" class="inp" value="${r.end || ''}"></label></div>
    <label class="f"><span>Description</span><input id="rDesc" class="inp" value="${esc(r.desc || '')}" placeholder="what is this rule for?"></label>
    <label style="display:flex;gap:.5rem;align-items:center;margin:.4rem 0"><input id="rActive" type="checkbox" ${r.active ? 'checked' : ''} style="width:1.1rem;height:1.1rem"> Active</label>
    <div id="rPreview" class="card pad" style="background:var(--soft);font-size:.85rem"></div>
    <div class="rowbtns end"><button type="button" class="btn-g" onclick="closeModal()">Cancel</button><button class="btn" type="submit">Save rule</button></div></form>`);
  renderConds(); ruleTypeUI();
  document.getElementById('modalCard').addEventListener('input', updateRulePreview);
  updateRulePreview();
}
function renderConds() {
  const box = document.getElementById('rConds'); if (!box) return;
  box.innerHTML = _conds.map((c, i) => `<div style="display:flex;gap:.4rem;margin-bottom:.4rem">
    <select class="inp" onchange="_conds[${i}].left=this.value;updateRulePreview()"><option value="trigger" ${c.left === 'trigger' ? 'selected' : ''}>this income ₹</option><option value="day_total" ${c.left === 'day_total' ? 'selected' : ''}>day total ₹</option></select>
    <select class="inp" style="max-width:4.5rem" onchange="_conds[${i}].op=this.value;updateRulePreview()">${['>', '>=', '<', '<=', '==', '!='].map(o => `<option ${c.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
    <input class="inp" inputmode="decimal" value="${(c.right / 100)}" onchange="_conds[${i}].right=toPaise(this.value)||0;updateRulePreview()">
    <button type="button" class="btn-g" onclick="_conds.splice(${i},1);renderConds();updateRulePreview()">✕</button></div>`).join('') || '<p class="faint" style="font-size:.8rem">No conditions — rule always fires (when active &amp; in date).</p>';
}
function ruleTypeUI() {
  const t = document.getElementById('rType').value;
  document.getElementById('rValWrap').classList.toggle('hidden', t === 'conditional' || t === 'sweep');
  document.getElementById('rThenWrap').classList.toggle('hidden', t !== 'conditional');
  document.getElementById('rElseWrap').classList.toggle('hidden', t !== 'conditional');
  document.getElementById('rCondWrap').classList.toggle('hidden', t !== 'conditional');
  document.getElementById('rValLbl').innerText = t === 'percent' ? 'Percent %' : 'Amount ₹';
  updateRulePreview();
}
function readRuleForm(id) {
  const g = x => document.getElementById(x).value;
  const t = g('rType');
  const r = { name: g('rName').trim().slice(0, 60), type: t, freq: g('rFreq'), src: g('rSrc'), dst: g('rDst') || null, incCat: g('rIncCat') || null,
    priority: +g('rPriority') || 10, active: document.getElementById('rActive').checked, start: g('rStart') || null, end: g('rEnd') || null,
    basis: g('rBasis'), conds: JSON.parse(JSON.stringify(_conds)), desc: g('rDesc').trim().slice(0, 140), updatedAt: Date.now() };
  if (t === 'percent') r.value = Math.max(0, +g('rVal') || 0);
  else if (t === 'fixed') r.value = toPaise(g('rVal')) || 0;
  else if (t === 'conditional') {
    r.thenKind = g('rThenKind');
    r.value = r.thenKind === 'percent' ? Math.max(0, +g('rThenVal') || 0) : (toPaise(g('rThenVal')) || 0);
    const ek = g('rElseKind');
    r.els = { kind: ek, val: ek === 'percent' ? Math.max(0, +g('rElseVal') || 0) : (toPaise(g('rElseVal')) || 0) };
    if (!r.conds.length) { toast('Conditional rules need at least one condition.', 'err'); return null; }
  } else r.value = 0;
  if (!r.name) { toast('Rule name required.', 'err'); return null; }
  if ((r.type === 'fixed') && !(r.value > 0)) { toast('Fixed rules need an amount > 0.', 'err'); return null; }
  if ((r.type === 'percent') && !(r.value > 0)) { toast('Percent must be > 0.', 'err'); return null; }
  if (r.type === 'sweep' && !r.dst) { toast('Sweep needs a destination account.', 'err'); return null; }
  if (r.type === 'sweep' && DB.rules.some(x => x.id !== id && x.active && x.type === 'sweep' && x.src === r.src)) { toast('This account already has an active sweep.', 'err'); return null; }
  if (r.start && r.end && r.end < r.start) { toast('End date is before start date.', 'err'); return null; }
  return r;
}
function updateRulePreview() {
  const box = document.getElementById('rPreview'); if (!box) return;
  const tmp = readRulePreviewOnly(); if (!tmp) { box.innerHTML = '<span class="faint">Fill the form to see a live preview.</span>'; return; }
  const sample = 1000000; // ₹10,000 sample? use ₹5,000 for readability
  const trig = 500000, dayT = 500000;
  const gate = ruleActiveOn(Object.assign({ active: document.getElementById('rActive').checked }, tmp), todayKey());
  const c = tmp.type === 'sweep' ? { deduct: 0, explain: 'remainder at fire time' } : computeRule(tmp, { trigger: trig, dayTotal: dayT });
  box.innerHTML = `<b>Preview</b> — sample income <b>${fmtP(trig)}</b> today:<br>` +
    (gate.ok ? `Would deduct <b>${tmp.type === 'sweep' ? 'the full remainder' : fmtP(c.deduct)}</b> <span class="faint">(${esc(c.explain)})</span>` : `<span class="faint">Would NOT fire: ${esc(gate.why)}.</span>`);
}
function readRulePreviewOnly() {
  try {
    const g = x => (document.getElementById(x) || {}).value;
    const t = g('rType');
    return { type: t, value: t === 'percent' ? (+g('rVal') || 0) : (toPaise(g('rVal') || 0) || 0), thenKind: (document.getElementById('rThenKind') || {}).value || 'fixed',
      basis: g('rBasis'), conds: _conds, els: { kind: ((document.getElementById('rElseKind') || {}).value || 'fixed'), val: (() => { const k = ((document.getElementById('rElseKind') || {}).value || 'fixed'); return k === 'percent' ? (+((document.getElementById('rElseVal') || {}).value) || 0) : (toPaise(((document.getElementById('rElseVal') || {}).value) || 0) || 0); })() } };
  } catch (e) { return null; }
}
function doRule(id) {
  const r = readRuleForm(id); if (!r) return false;
  if (id) { const ex = ruleById(id); const old = JSON.stringify(ex); Object.assign(ex, r); audit('rule', 'Edited rule ' + r.name, old.slice(0, 200), ''); }
  else { r.id = uid(); r.createdAt = Date.now(); DB.rules.push(r); audit('rule', 'Created rule ' + r.name + ' (' + r.type + ')', '', ''); }
  save(); closeModal(); toast('Rule saved — past entries untouched, future income uses it.'); R_rules(); return false;
}
function openSim(focusRule) {
  const accts = DB.accounts.filter(a => a.status === 'active');
  openModal(`<p class="eyebrow">Simulation — nothing is saved</p><h3>Test rules</h3>
    <form onsubmit="return doSim()"><div class="grid g2">
    <label class="f"><span>Hypothetical income ₹</span><input id="sAmt" class="inp" inputmode="decimal" value="10000"></label>
    <label class="f"><span>Income category</span><select id="sCat" class="inp"><option value="">Any</option>${DB.incomeCats.filter(c => c.active).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Destination account</span><select id="sAcct" class="inp">${accts.map(a => `<option value="${a.id}" ${a.id === (UI.dailyAcct || primaryAcct().id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
    <label class="f"><span>Business date</span><input id="sDate" type="date" class="inp" value="${todayKey()}"></label></div>
    <div class="rowbtns"><button class="btn" type="submit">Run simulation</button><button type="button" class="btn-g" onclick="closeModal()">Close</button></div></form>
    <div id="simOut" style="margin-top:1rem"></div>`);
  if (focusRule) setTimeout(doSim, 80);
}
function doSim() {
  const amt = toPaise(document.getElementById('sAmt').value);
  const ac = document.getElementById('sAcct').value, cat = document.getElementById('sCat').value || null, d = document.getElementById('sDate').value || todayKey();
  if (!(amt > 0)) { toast('Enter an income > 0.', 'err'); return false; }
  const { plan, closing } = simulate({ amount: amt, accountId: ac, bizDate: d, incCatId: cat });
  document.getElementById('simOut').innerHTML = `<div class="card pad" style="background:var(--soft)">
    ${plan.map(p => `<div class="kv"><span>${esc(p.rule.name)} <span class="faint">(${p.rule.type}${p.skip ? ' — skipped: ' + esc(p.skip) : ''})</span></span><b class="${p.skip ? 'faint' : 'neg'}">${p.skip ? '—' : '−' + fmtP(p.deduct)}</b></div>`).join('')}
    <div class="kv total"><span>Expected closing (${esc(acctName(ac))})</span><b class="${closing < 0 ? 'neg' : ''}">${fmtP(closing)}</b></div></div>`;
  return false;
}
/* ---------- reports ---------- */
function rangeFor(p, f, t) {
  const today = todayKey();
  if (p === 'today') return [today, today];
  if (p === 'yesterday') { const y = addDays(today, -1); return [y, y]; }
  if (p === 'week') return [addDays(today, -6), today];
  if (p === 'month') return [today.slice(0, 7) + '-01', today];
  return [f || today, t || today];
}
function R_rep() {
  const el = document.getElementById('view-reports');
  if (UI.repTab === 'monthly') return R_monthly(el);
  const R = UI.rep, [d0, d1] = rangeFor(R.preset, R.from, R.to);
  const tx = DB.transactions.filter(t => t.status !== 'void' && t.bizDate >= d0 && t.bizDate <= d1);
  const groups = {};
  const keyOf = t => R.group === 'day' ? t.bizDate : R.group === 'category' ? (catNameOf(t) || ruleName(t.ruleId) || t.type) : R.group === 'account' ? acctName(t.accountId) : R.group === 'rule' ? (ruleName(t.ruleId) || '(manual)') : t.type;
  tx.forEach(t => { const k = keyOf(t); groups[k] = groups[k] || { in: 0, out: 0, n: 0 }; if (t.amount >= 0) groups[k].in += t.amount; else groups[k].out += t.amount; groups[k].n++; });
  const keys = Object.keys(groups).sort();
  const tin = tx.filter(t => t.amount >= 0).reduce((s, t) => s + t.amount, 0), tout = tx.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  el.innerHTML = `<p class="eyebrow">Reports</p><h2 class="vtitle">Reports</h2>
    <div class="seg"><button class="btn-g on">Reports</button><button class="btn-g" onclick="UI.repTab='monthly';R_rep()">Monthly summary</button>
    <span style="flex:1"></span><button class="btn-g" onclick="exportRepCSV()">Export CSV</button><button class="btn-g" onclick="window.print()">Print / PDF</button></div>
    <div class="card pad" style="margin-bottom:1.1rem"><div class="grid g4">
      <label class="f"><span>Preset</span><select class="inp" onchange="UI.rep.preset=this.value;R_rep()">${['today', 'yesterday', 'week', 'month', 'custom'].map(p => `<option ${R.preset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label class="f"><span>From</span><input type="date" class="inp" value="${R.from}" onchange="UI.rep.from=this.value;UI.rep.preset='custom';R_rep()"></label>
      <label class="f"><span>To</span><input type="date" class="inp" value="${R.to}" onchange="UI.rep.to=this.value;UI.rep.preset='custom';R_rep()"></label>
      <label class="f"><span>Group by</span><select class="inp" onchange="UI.rep.group=this.value;R_rep()">${['day', 'category', 'account', 'rule', 'type'].map(p => `<option ${R.group === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    </div><p class="faint" style="font-size:.82rem">Range: ${prettyDay(d0)} → ${prettyDay(d1)} · ${tx.length} entries</p></div>
    <div class="grid g3" style="margin-bottom:1.1rem">
      <div class="card pad"><p class="eyebrow">Total in</p><p class="bignum pos">${fmtP(tin)}</p></div>
      <div class="card pad"><p class="eyebrow">Total out</p><p class="bignum neg">${fmtP(tout)}</p></div>
      <div class="card pad"><p class="eyebrow">Net</p><p class="bignum ${(tin + tout) < 0 ? 'neg' : ''}">${fmtSign(tin + tout)}</p></div></div>
    <div class="card pad"><div class="tblwrap"><table class="tbl"><thead><tr><th>${R.group}</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Net</th><th style="text-align:right">Entries</th></tr></thead><tbody>
    ${keys.map(k => `<tr><td>${esc(R.group === 'day' ? prettyDay(k) : k)}</td><td class="r pos">${fmtP(groups[k].in)}</td><td class="r neg">${fmtP(groups[k].out)}</td><td class="r"><b>${fmtSign(groups[k].in + groups[k].out)}</b></td><td class="r">${groups[k].n}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">Nothing in this range.</div></td></tr>'}
    </tbody></table></div></div>`;
}
function exportRepCSV() {
  const R = UI.rep, [d0, d1] = rangeFor(R.preset, R.from, R.to);
  const rows = DB.transactions.filter(t => t.status !== 'void' && t.bizDate >= d0 && t.bizDate <= d1).sort((a, b) => a.ts - b.ts);
  download(`cashbook-report-${d0}_${d1}.csv`, ['date,txn_id,type,category,rule,account,amount,' + 'note'].concat(rows.map(t => [t.bizDate, t.txn, t.type, csvQ(catNameOf(t)), csvQ(ruleName(t.ruleId)), csvQ(acctName(t.accountId)), (t.amount / 100).toFixed(2), csvQ(t.note)].join(','))).join('\n'));
  toast('Report CSV downloaded.');
}
function R_monthly(el) {
  const m = UI.rep.month || todayKey().slice(0, 7);
  if (!UI.rep.acct || !acct(UI.rep.acct)) UI.rep.acct = primaryAcct().id;
  const d0 = m + '-01', d1 = addDays(m + '-01', 32).slice(0, 7) + '-01';
  const A = acct(UI.rep.acct);
  const F = { opening: balanceOn(A.id, d0), income: 0, auto: 0, exp: 0 };
  DB.transactions.forEach(t => {
    if (t.accountId !== A.id || t.bizDate < d0 || t.bizDate >= d1 || t.status === 'void') return;
    if (t.type === 'income' || (t.exp && t.amount > 0)) F.income += t.amount;
    else if (t.type === 'deduction' || (t.type === 'reversal' && t.ruleId)) F.auto += t.amount;
    else F.exp += t.amount;
  });
  const closing = F.opening + F.income + F.auto + F.exp;
  const byCat = {};
  DB.transactions.forEach(t => { if (t.accountId === A.id && t.bizDate >= d0 && t.bizDate < d1 && t.status !== 'void' && (t.type === 'expense' || t.type === 'deduction' || (t.type === 'reversal' && !t.ruleId && t.catKind === 'expense'))) { const k = catNameOf(t) || ruleName(t.ruleId) || 'Other'; byCat[k] = (byCat[k] || 0) - t.amount; } });
  const segs = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([l, v], i) => ({ l, v, c: PAL[i % PAL.length] }));
  el.innerHTML = `<p class="eyebrow">Reports</p><h2 class="vtitle">${prettyMonth(m)}</h2>
    <div class="seg"><button class="btn-g" onclick="UI.repTab='reports';R_rep()">Reports</button><button class="btn-g on">Monthly summary</button>
    <span style="flex:1"></span><button class="btn-g" onclick="window.print()">Print / PDF</button></div>
    <div class="card pad" style="margin-bottom:1.1rem"><div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:end">
      <label class="f" style="margin:0"><span>Month</span><input type="month" class="inp" value="${m}" onchange="UI.rep.month=this.value;R_rep()"></label>
      <label class="f" style="margin:0"><span>Account</span><select class="inp" onchange="UI.rep.acct=this.value;R_rep()">${DB.accounts.filter(a => a.status === 'active').map(a => `<option value="${a.id}" ${a.id === A.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label></div>
      <p class="faint" style="font-size:.8rem">Figures for <b>${esc(A.name)}</b> — opening is the previous month's close, carried automatically.</p></div>
    <div class="grid g2"><div class="card pad">
      <div class="kv"><span>Opening balance</span><b>${fmtP(F.opening)}</b></div>
      <div class="kv"><span>Total income</span><b class="pos">${fmtP(F.income)}</b></div>
      <div class="kv"><span>Automatic deductions</span><b class="neg">${fmtP(F.auto)}</b></div>
      <div class="kv"><span>Manual expenses &amp; transfers</span><b class="neg">${fmtP(F.exp)}</b></div>
      <div class="kv total grand"><span>Closing balance</span><b class="${closing < 0 ? 'neg' : ''}">${fmtP(closing)}</b></div></div>
      <div class="card pad"><p class="eyebrow">Category-wise outgo</p>${svgDonut(segs)}</div></div>`;
}
/* ---------- settings ---------- */
function R_set() {
  const el = document.getElementById('view-settings'), S = DB.settings;
  const nTx = DB.transactions.length, kb = Math.round((localStorage.getItem(LS) || '').length / 102.4) / 10;
  el.innerHTML = `<p class="eyebrow">Settings</p><h2 class="vtitle">Settings</h2><p class="vsub">Preferences, safety and data.</p>
    <div class="grid g2">
    <div class="card pad"><p class="eyebrow">Profile &amp; defaults</p>
      <label class="f"><span>Your name (recorded as “created by”)</span><input id="sUser" class="inp" value="${esc(S.user)}"></label>
      <label class="f"><span>Primary account (daily focus)</span><select id="sPrimary" class="inp">${DB.accounts.filter(a => a.status === 'active').map(a => `<option value="${a.id}" ${S.primaryAccountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label style="display:flex;gap:.5rem;align-items:center;margin:.6rem 0"><input id="sNeg" type="checkbox" ${S.preventNegative ? 'checked' : ''} style="width:1.1rem;height:1.1rem"> Prevent negative balance (expenses &amp; transfers ask first)</label>
      <div class="rowbtns"><button class="btn" onclick="saveSettings()">Save settings</button></div></div>
    <div class="card pad"><p class="eyebrow">Backup &amp; data safety</p>
      <p class="muted" style="font-size:.88rem">${nTx} entries · ${DB.accounts.length} accounts · ${DB.rules.length} rules · ~${kb} KB stored locally. Saved automatically after every action.</p>
      <div class="rowbtns"><button class="btn-g" onclick="exportBackup()">Export backup</button>
      <label class="btn-g">Import backup<input type="file" accept=".json" class="hidden" onchange="importBackup(event)"></label>
      <button class="btn-danger-g" onclick="askWipe()">Erase everything</button></div>
      <p class="faint" style="font-size:.8rem">Tip: install this app to your home screen for an app-like feel. Sync between devices via Export → Import.</p></div></div>`;
}
function saveSettings() {
  DB.settings.user = document.getElementById('sUser').value.trim().slice(0, 40) || 'Owner';
  DB.settings.primaryAccountId = document.getElementById('sPrimary').value;
  DB.settings.preventNegative = document.getElementById('sNeg').checked;
  audit('settings', 'Settings updated', '', ''); save(); toast('Settings saved.'); R_set();
}
function exportBackup() { download(`cashbook-backup-${todayKey()}.json`, JSON.stringify(DB, null, 1), 'application/json'); toast('Backup downloaded.'); }
function importBackup(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || d.v !== 2 || !Array.isArray(d.accounts) || !Array.isArray(d.transactions)) throw 0;
      try { localStorage.setItem(LS + '.backup-' + Date.now(), JSON.stringify(DB)); } catch (x) {}
      DB = Object.assign(defaultDB(), d);
      audit('import', 'Backup imported (' + d.transactions.length + ' entries)', '', '');
      save(); UI.dailyAcct = primaryAcct().id; toast('Backup imported.'); go('dashboard');
    } catch (x) { toast('Not a valid CashBook backup.', 'err'); }
  };
  r.readAsText(f); e.target.value = '';
}
function askWipe() {
  confirmDlg('Erase everything?', 'All accounts, transactions, rules and history on <b>this device</b> will be deleted. Export a backup first!', 'Erase', () => {
    localStorage.removeItem(LS); DB = defaultDB(); save(); UI.dailyAcct = primaryAcct().id; toast('Cleared. Fresh start.'); go('dashboard');
  });
}
/* ---------- net / pwa / init ---------- */
function netState() {
  const on = navigator.onLine, d = document.getElementById('netDot'), t = document.getElementById('netTxt');
  if (d) d.className = 'netdot ' + (on ? 'on' : 'off');
  if (t) t.innerText = on ? 'online' : 'offline · works fully';
  document.getElementById('bizBadge').innerText = prettyDay(todayKey());
}
window.addEventListener('online', netState); window.addEventListener('offline', netState);
if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
document.getElementById('gSearch').addEventListener('keydown', e => { if (e.key === 'Enter') globalSearch(); });
load();
UI.dailyAcct = primaryAcct().id;
netState(); go('dashboard');
setInterval(() => { document.getElementById('bizBadge').innerText = prettyDay(todayKey()); }, 60000);
