"use strict";

/* ================= CONFIG ================= */
const firebaseConfig = {
  apiKey: "AIzaSyDImAkFCOjxmOeSsKMEVVWjfmt1UmmIGVI",
  authDomain: "snake-open-draft-2026.firebaseapp.com",
  databaseURL: "https://snake-open-draft-2026-default-rtdb.firebaseio.com",
  projectId: "snake-open-draft-2026",
  storageBucket: "snake-open-draft-2026.firebasestorage.app",
  messagingSenderId: "338076424606",
  appId: "1:338076424606:web:41e55424157d0b5adc5e8f"
};

const DEFAULT_OWNERS = ["Ram", "Dragon", "Gary", "GF", "Ronnie", "Phillips", "Ace"];
const DEFAULT_ROUNDS = 7;
const CUT_SCORE = 80; // per round, applied to R3/R4 (and any unplayed round) for CUT/WD/DQ golfers

// ESPN public leaderboard for The Open 2026 (event 401811957, Jul 16-19).
// Verified shape: events[0].competitions[0].competitors[] with athlete.displayName,
// linescores[{period,value}], score{value,displayValue}, status.type.name, sortOrder.
const ESPN_EVENT_ID = "401811957"; // can be overridden via /state/espnEventId in the DB
const espnUrl = () => "https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=" + (S.state?.espnEventId || ESPN_EVENT_ID);
const POLL_MS = 3 * 60 * 1000;

// SHA-256 of the admin passphrase (client-side gate; DB rules enforce for real)
const ADMIN_HASH = "476bd2cff73bedea2bab7696c3e24f09a7fd075c163a4f42a80ee978d56b0300";

/* ================= STATE ================= */
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const S = { state: null, config: null, seats: {}, golfers: {}, picks: {}, pickedGolfers: {}, overrides: {}, loaded: false };
const espn = { competitors: [], byNorm: {}, eventStatus: null, eventName: null, fetchedAt: 0, error: null, par: 70 /* Royal Birkdale; real value read from feed */ };
const me = { identity: null, owner: null, admin: false };

/* ================= HELPERS ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function normName(s) {
  return String(s).toLowerCase()
    .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ß/g, "ss").replace(/ł/g, "l")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ").trim();
}
const golferId = (name) => "g_" + normName(name).replace(/ /g, "_");
const pickKey = (i) => "p" + String(i).padStart(3, "0");

function ownerForPick(i, order) {
  if (!order || order.length < 2) return null;
  const T = order.length;
  const r = Math.floor(i / T), p = i % T;
  return order[r % 2 === 0 ? p : T - 1 - p];
}
const fmtOdds = (o) => (o == null ? "" : (o > 0 ? "+" + o : String(o)));
const fmtToPar = (n) => (n == null ? "—" : n === 0 ? "E" : n > 0 ? "+" + n : String(n));
function parseToPar(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (/^e$/i.test(s)) return 0;
  const n = parseInt(s.replace("+", ""), 10);
  return Number.isFinite(n) ? n : null;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function deviceId() {
  let id = localStorage.getItem("op26_device");
  if (!id) { id = "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("op26_device", id); }
  return id;
}

/* ================= NOTIFICATION HOOK =================
   Called exactly once, by the client that submits the pick.
   To add notifications later (Slack webhook, SMS bridge, etc.)
   this is the only place that needs to change.
   pick = { idx, round, pickInRound, owner, golfer, odds, nextOwner } */
function notifyPickMade(pick) {
  // e.g. fetch("https://hooks.example.com/...", { method:"POST", body: JSON.stringify(pick) });
}

/* ================= FIREBASE WIRING ================= */
firebase.auth().signInAnonymously().catch(() => { /* anon auth not enabled yet — fall back to device id */ });
firebase.auth().onAuthStateChanged(u => {
  me.identity = u ? u.uid : deviceId();
  resolveMySeat();
  render();
});
if (!firebase.auth().currentUser) { me.identity = deviceId(); }

let connected = null;
db.ref(".info/connected").on("value", s => { connected = !!s.val(); renderConn(); });
// "● live" only while the draft is running; a reconnect warning shows in any phase
function renderConn() {
  const el = $("connStatus");
  if (connected === false && S.loaded) {
    el.textContent = "reconnecting…";
    el.classList.remove("on", "hidden");
  } else if (connected && phase() === "draft" && !draftDone()) {
    el.textContent = "● live";
    el.classList.add("on");
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

for (const node of ["state", "config", "seats", "golfers", "picks", "pickedGolfers", "overrides"]) {
  db.ref(node).on("value", snap => {
    S[node] = snap.val() || (node === "state" ? null : {});
    S.loaded = true;
    if (node === "seats") resolveMySeat();
    render();
    if (node === "state") maybeStartPolling();
  });
}

function resolveMySeat() {
  me.owner = null;
  for (const o of owners()) if (S.seats && S.seats[o] === me.identity) me.owner = o;
  // hint from a previous visit (identity may have changed if browser storage was cleared)
  if (!me.owner) {
    const hint = localStorage.getItem("op26_owner");
    if (hint && S.seats && !S.seats[hint]) localStorage.removeItem("op26_owner");
  }
}

/* ================= DERIVED ================= */
const phase = () => (S.state ? S.state.phase : null);
const currentPick = () => (S.state ? S.state.currentPick || 0 : 0);
const owners = () => (S.config && S.config.owners ? Object.keys(S.config.owners) : DEFAULT_OWNERS.slice()).sort((a, b) => a.localeCompare(b));
const numTeams = () => owners().length;
const numRounds = () => (S.config && S.config.rounds ? S.config.rounds : DEFAULT_ROUNDS);
const numTop = () => Math.max(1, Math.min(S.config && S.config.topCount ? S.config.topCount : numRounds(), numRounds()));
const totalPicks = () => numTeams() * numRounds();
const draftOrder = () => (S.state && Array.isArray(S.state.draftOrder) && S.state.draftOrder.length === numTeams() ? S.state.draftOrder : null);
const onClockOwner = () => (phase() === "draft" && currentPick() < totalPicks() ? ownerForPick(currentPick(), draftOrder()) : null);
const draftDone = () => phase() === "complete" || currentPick() >= totalPicks();

function teamRoster(owner) {
  return Object.values(S.picks || {}).filter(p => p.owner === owner).sort((a, b) => a.idx - b.idx);
}

/* ================= ACTIONS ================= */
async function claimSeat(owner) {
  if (!me.identity) return;
  try {
    const res = await db.ref("seats/" + owner).transaction(cur => (cur === null ? me.identity : undefined));
    if (res.committed) { localStorage.setItem("op26_owner", owner); }
    else alert("That seat was just claimed by someone else.");
  } catch (e) { alert("Could not claim seat: " + e.message); }
}

// best-available ordering: lowest odds first, ties alphabetical, no-odds golfers last alphabetical
function golferCompare(a, b) {
  if (a.odds != null && b.odds != null) return a.odds - b.odds || a.name.localeCompare(b.name);
  if (a.odds != null) return -1;
  if (b.odds != null) return 1;
  return a.name.localeCompare(b.name);
}

async function makePick(gid, auto = false) {
  const i = currentPick();
  const owner = onClockOwner();
  const g = S.golfers[gid];
  if (!g || !owner || S.pickedGolfers[gid] != null) return;
  if (!(me.admin || me.owner === owner)) return;
  if (!auto && !me.admin && !confirm(`Draft ${g.name}?`)) return;
  if (!auto && me.admin && me.owner !== owner && !confirm(`ADMIN: draft ${g.name} for ${owner}?`)) return;
  const updates = {};
  updates["picks/" + pickKey(i)] = { idx: i, owner, gid, name: g.name, odds: g.odds ?? null, ts: firebase.database.ServerValue.TIMESTAMP };
  updates["pickedGolfers/" + gid] = i;
  updates["state/currentPick"] = i + 1;
  if (i + 1 === totalPicks()) updates["state/phase"] = "complete";
  try {
    await db.ref().update(updates);
    notifyPickMade({
      idx: i, round: Math.floor(i / numTeams()) + 1, pickInRound: (i % numTeams()) + 1,
      owner, golfer: g.name, odds: g.odds ?? null,
      nextOwner: i + 1 < totalPicks() ? ownerForPick(i + 1, draftOrder()) : null
    });
  } catch (e) {
    if (auto) { console.warn("Autodraft pick failed:", e.message); autodraftArmedFor = -1; }
    else alert("Pick failed: " + e.message);
  }
}

/* ---- autodraft: picks best available automatically when this seat is on the clock.
   Local to this device (the seat's own browser makes the pick — keep the page open). */
const autodraftOn = () => localStorage.getItem("op26_autodraft") === "1";
let autodraftArmedFor = -1;
function scheduleAutodraft() {
  if (!(autodraftOn() && me.owner && phase() === "draft" && !draftDone() && onClockOwner() === me.owner)) return;
  const i = currentPick();
  if (autodraftArmedFor === i) return;
  autodraftArmedFor = i;
  setTimeout(() => {
    // re-verify at fire time — state may have moved, or the user may have picked/unchecked
    if (!(autodraftOn() && phase() === "draft" && onClockOwner() === me.owner && currentPick() === i)) return;
    const best = Object.entries(S.golfers)
      .filter(([gid]) => S.pickedGolfers[gid] == null)
      .map(([gid, g]) => ({ gid, ...g }))
      .sort(golferCompare)[0];
    if (best) makePick(best.gid, true);
  }, 2500);
}

/* ---- admin actions ---- */
async function adminUnlock() {
  const pass = $("adminPass").value;
  const hash = await sha256Hex(pass);
  if (hash !== ADMIN_HASH) { $("adminErr").textContent = "Wrong passphrase."; $("adminErr").classList.remove("hidden"); return; }
  me.admin = true;
  localStorage.setItem("op26_admin", pass);
  // Prove admin to the database (used by security rules once auth is enabled).
  const uid = firebase.auth().currentUser?.uid;
  if (uid) db.ref("admin/authorized/" + uid).set(hash).catch(() => {});
  db.ref("admin/passHash").set(hash).catch(() => {}); // seeds on first run; locked writes ignore
  render();
}

function buildSchedule(order) {
  const sched = {};
  for (let i = 0; i < totalPicks(); i++) sched[pickKey(i)] = { idx: i, owner: ownerForPick(i, order) };
  return sched;
}

async function saveConfig() {
  const topCount = parseInt($("topCountInput").value, 10);
  if (!Number.isFinite(topCount) || topCount < 1) { alert("Top golfers counted must be at least 1."); return; }
  if (phase() !== "setup") {
    // draft already running: teams/rounds are locked, but the scoring knob is safe to change
    if (topCount > numRounds()) { alert(`Top golfers counted can't exceed rounds (${numRounds()}).`); return; }
    await db.ref("config/topCount").set(topCount);
    alert(`Draft already started — teams/rounds unchanged, but "top golfers counted" is now ${topCount}.`);
    return;
  }
  const names = [...new Set($("teamNames").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  if (names.length < 2 || names.length > 20) { alert("Enter 2–20 team names, one per line."); return; }
  if (names.some(n => /[.#$/\[\]]/.test(n))) { alert("Team names cannot contain . # $ / [ ]"); return; }
  const rounds = parseInt($("roundsInput").value, 10);
  if (!Number.isFinite(rounds) || rounds < 1 || rounds > 30) { alert("Rounds must be 1–30."); return; }
  if (topCount > rounds) { alert(`Top golfers counted (${topCount}) can't exceed rounds per team (${rounds}).`); return; }
  if (!confirm(`Save league: ${names.length} teams × ${rounds} rounds = ${names.length * rounds} picks, best ${topCount} scores count?`)) return;
  const ownersMap = {};
  for (const n of names) ownersMap[n] = true;
  const updates = { config: { teams: names.length, rounds, topCount, owners: ownersMap } };
  const cur = S.state && Array.isArray(S.state.draftOrder) ? S.state.draftOrder : [];
  const sameSet = cur.length === names.length && cur.every(o => ownersMap[o]) && new Set(cur).size === cur.length;
  updates["state/draftOrder"] = sameSet ? cur : names.slice().sort((a, b) => a.localeCompare(b));
  for (const o of Object.keys(S.seats || {})) if (!ownersMap[o]) updates["seats/" + o] = null;
  await db.ref().update(updates);
  alert("League setup saved.");
}

async function saveOrder() {
  const sels = [...document.querySelectorAll("#orderSelects select")];
  const order = sels.map(s => s.value);
  if (new Set(order).size !== numTeams() || !order.every(o => owners().includes(o))) { alert("Each team must appear exactly once."); return; }
  await db.ref("state/draftOrder").set(order);
  alert("Draft order saved.");
}

function parseFieldText(text) {
  const golfers = {}, dupes = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    // accepts "Name, +450", "Name +450", "Name, 450", "Name +10,000", or just "Name"
    const m = line.match(/^(.+?)[,\s]+\+?(-?\d[\d,]*)\s*$/);
    const name = (m ? m[1] : line).replace(/,\s*$/, "").trim();
    const odds = m ? parseInt(m[2].replace(/,/g, ""), 10) : null;
    if (!name) continue;
    const gid = golferId(name);
    if (golfers[gid]) dupes.push(name); else golfers[gid] = { name, odds };
  }
  return { golfers, dupes };
}

async function saveField() {
  const { golfers, dupes } = parseFieldText($("fieldInput").value);
  const n = Object.keys(golfers).length;
  if (!n) { alert("No golfers parsed."); return; }
  if (dupes.length) alert("Skipped duplicate names: " + dupes.join(", "));
  if (!confirm(`Save field of ${n} golfers? This replaces the existing field.`)) return;
  await db.ref("golfers").set(golfers);
  $("fieldInfo").textContent = `Saved ${n} golfers.`;
}

async function startDraft() {
  if (!draftOrder()) { alert("Set the draft order first."); return; }
  if (!Object.keys(S.golfers).length) { alert("Paste the golfer field first."); return; }
  if (!confirm("Start the draft?")) return;
  await db.ref().update({
    schedule: buildSchedule(draftOrder()),
    "state/phase": "draft",
    "state/currentPick": 0
  });
}

async function undoPick() {
  const i = currentPick() - 1;
  if (i < 0) { alert("No picks to undo."); return; }
  const p = S.picks[pickKey(i)];
  if (!p) { alert("Pick record not found."); return; }
  if (!confirm(`Undo pick #${i + 1}: ${p.owner} — ${p.name}?`)) return;
  const updates = {};
  updates["picks/" + pickKey(i)] = null;
  updates["pickedGolfers/" + p.gid] = null;
  updates["state/currentPick"] = i;
  updates["state/phase"] = "draft";
  await db.ref().update(updates);
}

async function resetDraft() {
  if (!confirm("Reset the draft? All picks are erased (field & seats kept).")) return;
  if (!confirm("Are you sure? This cannot be undone.")) return;
  await db.ref().update({ picks: null, pickedGolfers: null, schedule: null, state: { phase: "setup", currentPick: 0, draftOrder: draftOrder() || owners() } });
}

async function fullReset() {
  if (!confirm("FULL reset? Erases picks, field, seats, overrides — everything.")) return;
  if (!confirm("Really erase everything?")) return;
  await db.ref().update({
    picks: null, pickedGolfers: null, schedule: null, golfers: null, seats: null, overrides: null,
    state: { phase: "setup", currentPick: 0, draftOrder: owners() }
  });
}

/* ================= ESPN SCORING ================= */
async function fetchScores(manual) {
  try {
    const res = await fetch(espnUrl());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const ev = data.events && data.events[0];
    const comp = ev && ev.competitions && ev.competitions[0];
    espn.eventName = ev ? ev.name : null;
    espn.eventStatus = ev?.status?.type?.name || null;
    espn.par = Number(ev?.courses?.[0]?.shotsToPar) || espn.par;
    espn.competitors = (comp?.competitors || []).map(c => {
      const rounds = {};
      for (const ls of c.linescores || []) {
        const v = Number(ls.value);
        if (Number.isFinite(v) && ls.period >= 1 && ls.period <= 4) rounds[ls.period] = v;
      }
      const statusName = c.status?.type?.name || "";
      return {
        name: c.athlete?.displayName || "?",
        norm: normName(c.athlete?.displayName || ""),
        rounds,
        totalStrokes: Number(c.score?.value),
        toPar: c.score?.displayValue ?? "",
        liveToPar: parseToPar(c.score?.displayValue), // overall to par, live mid-round; null before first tee shot
        statusName,
        state: c.status?.type?.state || "",
        thru: Number(c.status?.thru) || 0,
        out: /CUT|WITHDRAW|DISQUAL/i.test(statusName),
        pos: c.status?.position?.displayName || "",
        detail: (/^\d{4}-\d{2}-\d{2}T/.test(c.status?.displayValue || "") ? c.status?.detail : c.status?.displayValue) || c.status?.detail || "",
        sortOrder: Number(c.sortOrder) || 999
      };
    });
    espn.byNorm = {};
    for (const c of espn.competitors) espn.byNorm[c.norm] = c;
    espn.fetchedAt = Date.now();
    espn.error = null;
  } catch (e) {
    espn.error = e.message;
    if (manual) alert("Score fetch failed: " + e.message);
  }
  renderStandings();
}

let pollTimer = null;
function maybeStartPolling() {
  if (draftDone() && !pollTimer) {
    fetchScores(false);
    pollTimer = setInterval(() => fetchScores(false), POLL_MS);
  }
}

/* A golfer's total is expressed TO PAR (lower = better) and updates live mid-round:
   - active/finished golfers: ESPN's overall to-par, which includes holes of the round in progress
   - cut/WD/DQ golfers: completed rounds to par, plus (80 - par) for each unplayed round (pool rule: 80)
   - manual overrides are entered as to-par numbers (e.g. 19 for +19, -3)
   - golfers who haven't hit a shot yet are "pending" (total null) so they don't count as even par
   Returns {matched, manual, pending, total, out, pos, detail, thru, state, espnName} */
function golferScore(gid) {
  const g = S.golfers[gid];
  const ov = (S.overrides || {})[gid] || {};
  if (ov.score != null && ov.score !== "") return { matched: true, manual: true, total: Number(ov.score), out: false, pos: "", detail: "manual", espnName: "", state: "post", thru: 0 };
  if (!g) return { matched: false };
  const target = ov.espnName ? normName(ov.espnName) : normName(g.name);
  const c = espn.byNorm[target];
  if (!c) return { matched: false };
  const base = { matched: true, manual: false, out: c.out, pos: c.pos, detail: c.detail, espnName: c.name, state: c.state, thru: c.thru };
  if (c.out) {
    let total = 0;
    for (let r = 1; r <= 4; r++) {
      total += Number.isFinite(c.rounds[r]) ? c.rounds[r] - espn.par : CUT_SCORE - espn.par;
    }
    return { ...base, total, penalized: true };
  }
  if (c.liveToPar == null) return { ...base, pending: true, total: null };
  return { ...base, total: c.liveToPar };
}

function computeStandings() {
  const teams = [];
  const unmatched = [];
  for (const owner of owners()) {
    const roster = teamRoster(owner);
    const rows = roster.map(p => {
      const sc = golferScore(p.gid);
      if (!sc.matched && espn.competitors.length) unmatched.push({ owner, name: p.name, gid: p.gid });
      return { pick: p, sc };
    });
    const scored = rows.filter(r => r.sc.matched && r.sc.total != null);
    const best = scored.length ? scored.reduce((a, b) => (a.sc.total <= b.sc.total ? a : b)) : null;
    const countedRows = scored.slice().sort((a, b) => a.sc.total - b.sc.total).slice(0, numTop());
    const topSum = countedRows.length ? countedRows.reduce((s, r) => s + r.sc.total, 0) : null;
    teams.push({ owner, rows, best, topSum, counted: countedRows.length, countedGids: new Set(countedRows.map(r => r.pick.gid)), scoredCount: scored.length });
  }
  return { teams, unmatched };
}

/* ================= RENDER ================= */
function render() {
  renderConn();
  renderBanner();
  renderAutodraft();
  renderSeatBar();
  renderDraft();
  renderStandings();
  renderAdmin();
  scheduleAutodraft();
}

function renderAutodraft() {
  const wrap = $("autodraftWrap"), chk = $("autodraftChk"), ab = $("autodraftBanner");
  const eligible = me.owner && phase() === "draft" && !draftDone();
  wrap.classList.toggle("hidden", !eligible);
  chk.checked = autodraftOn();
  const show = eligible && autodraftOn();
  ab.classList.toggle("hidden", !show);
  if (show) ab.textContent = `🤖 AUTODRAFT ENABLED — ${me.owner}, your picks will be made automatically (best available odds). Uncheck "Autodraft my picks" to take back control. Keep this page open.`;
}

function renderBanner() {
  const b = $("banner");
  b.classList.remove("hidden", "me", "done");
  let title = "The Open - 2026 Snake Draft";
  if (!S.loaded) { b.classList.add("hidden"); }
  else if (!S.state) { b.textContent = "Not initialized — admin: unlock the Admin tab and press Full reset."; }
  else if (phase() === "setup") { b.textContent = "🏌️ Draft has not started yet"; }
  else if (draftDone()) { b.textContent = "✅ Draft complete — scores update during The Open"; b.classList.add("done"); title = "🏆 The Open - 2026 Snake Draft"; }
  else {
    const o = onClockOwner();
    const i = currentPick();
    b.textContent = `⏰ ON THE CLOCK: ${o} — Round ${Math.floor(i / numTeams()) + 1}, Pick ${i % numTeams() + 1} (#${i + 1} overall)`;
    if (o === me.owner) { b.classList.add("me"); b.textContent += "  — THAT'S YOU!"; }
    title = `⏰ ${o} is up — The Open - 2026 Snake Draft`;
  }
  document.title = title;
}

function renderSeatBar() {
  const info = $("seatInfo"), sel = $("seatSelect"), btn = $("claimBtn");
  if (me.owner) {
    info.innerHTML = `You are <b>${esc(me.owner)}</b>`;
    sel.classList.add("hidden"); btn.classList.add("hidden");
    return;
  }
  const open = owners().filter(o => !(S.seats || {})[o]);
  if (!open.length) { info.textContent = "All seats claimed — you are spectating."; sel.classList.add("hidden"); btn.classList.add("hidden"); return; }
  info.textContent = "Claim your seat:";
  const prev = sel.value;
  sel.innerHTML = open.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
  if (open.includes(prev)) sel.value = prev;
  sel.classList.remove("hidden"); btn.classList.remove("hidden");
}

function renderDraft() {
  // available golfers
  const q = normName($("golferSearch").value || "");
  const avail = Object.entries(S.golfers || {})
    .filter(([gid]) => S.pickedGolfers[gid] == null)
    .map(([gid, g]) => ({ gid, ...g }))
    .filter(g => !q || normName(g.name).includes(q))
    .sort(golferCompare);
  $("availCount").textContent = `(${avail.length})`;
  const canPick = phase() === "draft" && !draftDone() && (me.admin || me.owner === onClockOwner());
  $("golferList").innerHTML = avail.map(g =>
    `<div class="golfer-row"><span class="name">${esc(g.name)}</span><span class="odds">${esc(fmtOdds(g.odds))}</span>` +
    `<button data-gid="${esc(g.gid)}" ${canPick ? "" : "disabled"}>Draft</button></div>`
  ).join("") || `<p class="muted">No golfers${Object.keys(S.golfers || {}).length ? " match" : " loaded — admin pastes the field before the draft"}.</p>`;

  // board
  const order = draftOrder() || owners();
  const T = order.length;
  const cur = currentPick();
  let html = "<tr><th>Rd</th>" + order.map(o => `<th${o === me.owner ? ' class="mycol"' : ""}>${esc(o)}${o === me.owner ? " ⭐" : ""}</th>`).join("") + "</tr>";
  for (let r = 0; r < numRounds(); r++) {
    html += `<tr><th>${r + 1}</th>`;
    for (let c = 0; c < T; c++) {
      const idx = r * T + (r % 2 === 0 ? c : T - 1 - c);
      const p = S.picks[pickKey(idx)];
      const onclock = phase() === "draft" && idx === cur;
      html += `<td class="${p ? "filled" : ""}${onclock ? " onclock" : ""}">` +
        (p ? `${esc(p.name)}<span class="odds">${esc(fmtOdds(p.odds))}</span>` : (onclock ? "⏰" : `<span class="muted">#${idx + 1}</span>`)) + "</td>";
    }
    html += "</tr>";
  }
  $("board").innerHTML = html;

  // pick log
  const picks = Object.values(S.picks || {}).sort((a, b) => b.idx - a.idx);
  $("pickLog").innerHTML = picks.map(p =>
    `<div>#${p.idx + 1} (R${Math.floor(p.idx / numTeams()) + 1}.${p.idx % numTeams() + 1}) <b>${esc(p.owner)}</b> — ${esc(p.name)} ${esc(fmtOdds(p.odds))}</div>`
  ).join("") || `<div>No picks yet.</div>`;
}

function renderStandings() {
  const st = $("scoreStatus");
  if (espn.error) st.textContent = `⚠ last fetch failed (${espn.error})`;
  else if (!espn.fetchedAt) st.textContent = draftDone() ? "Loading scores…" : "Scores start once the draft is complete (or press Refresh).";
  else st.textContent = `${espn.eventName || "Tournament"} · ${espn.competitors.length} players · updated ${new Date(espn.fetchedAt).toLocaleTimeString()}${espn.eventStatus === "STATUS_SCHEDULED" ? " · tournament not started" : ""}`;

  const { teams, unmatched } = computeStandings();

  const warn = $("unmatchedWarn");
  if (unmatched.length) {
    warn.classList.remove("hidden");
    warn.innerHTML = "⚠ Unmatched golfers (fix in Admin → Scoring Fixes): " + unmatched.map(u => `<b>${esc(u.name)}</b> (${esc(u.owner)})`).join(", ");
  } else warn.classList.add("hidden");

  const X = numTop();

  $("topTitle").textContent = `📊 Top ${X} Combined`;
  $("topDesc").textContent = `Teams ranked by the combined to-par score of their best ${X} golfers — live during rounds, lower is better`;
  const topRows = teams.slice().sort((a, b) => (a.topSum ?? 1e9) - (b.topSum ?? 1e9));
  $("topTable").innerHTML = `<tr><th>#</th><th>Team</th><th class=num>Top ${X} To Par</th><th class=num>Counting</th></tr>` +
    topRows.map((t, i) =>
      `<tr class="rank-${i + 1}"><td>${i + 1}</td><td><b>${esc(t.owner)}</b></td><td class="num">${fmtToPar(t.topSum)}</td>` +
      `<td class="num">${t.counted}/${X}${t.rows.length >= X && t.counted < X ? " ⚠" : ""}</td></tr>`
    ).join("");

  const bestRows = teams.slice().sort((a, b) => (a.best ? a.best.sc.total : 1e9) - (b.best ? b.best.sc.total : 1e9));
  $("bestTable").innerHTML = "<tr><th>#</th><th>Team</th><th>Best Golfer</th><th class=num>To Par</th><th>Pos</th></tr>" +
    bestRows.map((t, i) =>
      `<tr class="rank-${i + 1}"><td>${i + 1}</td><td><b>${esc(t.owner)}</b></td><td>${t.best ? esc(t.best.pick.name) : "—"}</td>` +
      `<td class="num">${t.best ? fmtToPar(t.best.sc.total) : "—"}</td><td>${t.best ? esc(t.best.sc.pos || "") : ""}</td></tr>`
    ).join("");

  // roster cards (✓ marks the golfers currently counting toward the Top X total)
  $("rosterScores").innerHTML = teams.map(t => {
    const rows = t.rows.map(r => {
      const sc = r.sc;
      const cls = sc.manual ? "manual" : (sc.out ? "cut" : "");
      const isCounted = t.countedGids.has(r.pick.gid);
      const total = sc.matched ? fmtToPar(sc.total) : "—";
      const note = sc.manual ? "manual"
        : !sc.matched ? "no match"
        : sc.pending ? esc(sc.detail || "not started")
        : sc.out ? esc(sc.detail || "CUT")
        : `${esc(sc.pos || "")}${sc.state === "in" && sc.thru ? " · thru " + sc.thru : ""}`;
      return `<tr><td>${isCounted ? '<span class="counted">✓</span> ' : ""}${esc(r.pick.name)}</td><td class="num ${cls}${isCounted ? " counted" : ""}">${total}</td><td class="${cls}">${note}</td></tr>`;
    }).join("");
    return `<div class="roster-card"><h4>${esc(t.owner)}</h4><table><tr><th>Golfer</th><th class=num>To Par</th><th>Status</th></tr>${rows || "<tr><td colspan=3 class=muted>no picks</td></tr>"}</table></div>`;
  }).join("");

  // official leaderboard
  const lb = espn.competitors.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  $("leaderboard").innerHTML = lb.length
    ? "<tr><th>Pos</th><th>Player</th><th class=num>To Par</th><th class=num>R1</th><th class=num>R2</th><th class=num>R3</th><th class=num>R4</th><th class=num>Tot</th><th>Status</th></tr>" +
      lb.map(c =>
        `<tr><td>${esc(c.pos)}</td><td>${esc(c.name)}</td><td class="num">${esc(c.toPar)}</td>` +
        [1, 2, 3, 4].map(r => `<td class="num">${Number.isFinite(c.rounds[r]) ? c.rounds[r] : ""}</td>`).join("") +
        `<td class="num">${Number.isFinite(c.totalStrokes) ? c.totalStrokes : ""}</td><td class="${c.out ? "cut" : ""}">${esc(c.detail)}</td></tr>`
      ).join("")
    : `<tr><td class="muted">No leaderboard data yet${espn.eventStatus === "STATUS_SCHEDULED" ? " — field publishes closer to the first tee time" : ""}.</td></tr>`;
}

function renderAdmin() {
  $("adminLock").classList.toggle("hidden", me.admin);
  $("adminPanel").classList.toggle("hidden", !me.admin);
  if (!me.admin) return;

  // draft order selects (skip rebuild while user is choosing)
  const wrap = $("orderSelects");
  if (!wrap.contains(document.activeElement)) {
    const order = draftOrder() || owners();
    wrap.innerHTML = order.map((o, i) =>
      `<label>Pick ${i + 1}<select>${owners().map(n => `<option${n === o ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>`
    ).join("");
  }
  // prefill an input, and keep it in sync with the DB value until the user edits it
  const prefill = (el, val) => {
    if (document.activeElement === el) return;
    if (!el.value || el.value === el.dataset.prefill) { el.value = val; el.dataset.prefill = String(val); }
  };
  prefill($("teamNames"), owners().join("\n"));
  prefill($("roundsInput"), numRounds());
  prefill($("topCountInput"), numTop());

  const inDraft = phase() === "draft" || draftDone();
  $("teamNames").disabled = inDraft;
  $("roundsInput").disabled = inDraft;
  $("saveOrder").disabled = inDraft;
  $("saveField").disabled = inDraft;
  $("startDraft").disabled = phase() !== "setup";
  $("undoPick").disabled = currentPick() === 0;

  const ta = $("fieldInput");
  if (document.activeElement !== ta && !ta.value && Object.keys(S.golfers || {}).length) {
    ta.value = Object.values(S.golfers).map(g => g.odds != null ? `${g.name}, ${fmtOdds(g.odds)}` : g.name).join("\n");
  }
  $("fieldInfo").textContent = `${Object.keys(S.golfers || {}).length} golfers in field.`;

  // seats
  $("seatAdmin").innerHTML = owners().map(o => {
    const v = (S.seats || {})[o];
    return `<div>${esc(o)}: ${v ? `claimed <span class="muted small">(${esc(String(v).slice(0, 12))}…)</span> <button data-clearseat="${esc(o)}">clear</button>` : '<span class="muted">open</span>'}</div>`;
  }).join("");

  // scoring fixes table (skip rebuild while editing)
  const ft = $("fixTable");
  if (!ft.contains(document.activeElement)) {
    const picks = Object.values(S.picks || {}).sort((a, b) => a.idx - b.idx);
    ft.innerHTML = "<tr><th>Golfer</th><th>Team</th><th>Match</th><th>ESPN name map</th><th>Score override</th><th></th></tr>" +
      (picks.map(p => {
        const ov = (S.overrides || {})[p.gid] || {};
        const sc = golferScore(p.gid);
        const match = sc.manual ? "manual" : (sc.matched ? "✓ " + esc(sc.espnName || "") : (espn.competitors.length ? "✗ NO MATCH" : "?"));
        return `<tr><td>${esc(p.name)}</td><td>${esc(p.owner)}</td><td>${match}</td>` +
          `<td><input type="text" data-espnname="${esc(p.gid)}" value="${esc(ov.espnName || "")}" placeholder="exact ESPN name"></td>` +
          `<td><input type="number" data-score="${esc(p.gid)}" value="${esc(ov.score ?? "")}" placeholder="to par, e.g. -3 or 19"></td>` +
          `<td><button data-savefix="${esc(p.gid)}">Save</button></td></tr>`;
      }).join("") || `<tr><td class="muted" colspan="6">No picks yet.</td></tr>`);
  }
}

/* ================= EVENTS ================= */
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
  for (const t of ["draft", "standings", "admin"]) $("tab-" + t).classList.toggle("hidden", btn.dataset.tab !== t);
  if (btn.dataset.tab === "standings" && Date.now() - espn.fetchedAt > POLL_MS) fetchScores(false);
}));

$("claimBtn").addEventListener("click", () => claimSeat($("seatSelect").value));
$("autodraftChk").addEventListener("change", e => {
  if (e.target.checked && !confirm("Enable autodraft? When you're on the clock, the best available golfer (by odds) will be drafted for you automatically.")) {
    e.target.checked = false;
    return;
  }
  localStorage.setItem("op26_autodraft", e.target.checked ? "1" : "0");
  autodraftArmedFor = -1;
  render();
});
$("golferSearch").addEventListener("input", renderDraft);
$("golferList").addEventListener("click", e => { const gid = e.target.dataset?.gid; if (gid) makePick(gid); });
$("refreshScores").addEventListener("click", () => fetchScores(true));

$("adminUnlock").addEventListener("click", adminUnlock);
$("adminPass").addEventListener("keydown", e => { if (e.key === "Enter") adminUnlock(); });
$("saveConfig").addEventListener("click", saveConfig);
$("saveOrder").addEventListener("click", saveOrder);
$("saveField").addEventListener("click", saveField);
$("startDraft").addEventListener("click", startDraft);
$("undoPick").addEventListener("click", undoPick);
$("resetDraft").addEventListener("click", resetDraft);
$("fullReset").addEventListener("click", fullReset);
$("seatAdmin").addEventListener("click", e => {
  const o = e.target.dataset?.clearseat;
  if (o && confirm(`Clear ${o}'s seat claim?`)) db.ref("seats/" + o).remove();
});
$("fixTable").addEventListener("click", e => {
  const gid = e.target.dataset?.savefix;
  if (!gid) return;
  const nameIn = document.querySelector(`input[data-espnname="${gid}"]`).value.trim();
  const scoreIn = document.querySelector(`input[data-score="${gid}"]`).value.trim();
  db.ref("overrides/" + gid).set({
    espnName: nameIn || null,
    score: scoreIn === "" ? null : Number(scoreIn)
  }).then(() => renderStandings());
});

// restore admin session
(async () => {
  const saved = localStorage.getItem("op26_admin");
  if (saved && (await sha256Hex(saved)) === ADMIN_HASH) {
    me.admin = true;
    firebase.auth().onAuthStateChanged(u => { if (u) db.ref("admin/authorized/" + u.uid).set(ADMIN_HASH).catch(() => {}); });
    render();
  }
})();
