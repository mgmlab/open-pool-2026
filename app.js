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

const S = { state: null, config: null, seats: {}, golfers: {}, picks: {}, pickedGolfers: {}, overrides: {}, autodraft: {}, myQueue: [], loaded: false };
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
  logVisit();
  setupPresence();
  render();
});

/* ---- usage stats (admin-only visibility): one view log per page load + live presence ---- */
let viewLogged = false;
function logVisit() {
  if (viewLogged || !me.identity) return;
  viewLogged = true;
  db.ref("views/" + me.identity).update({
    count: firebase.database.ServerValue.increment(1),
    last: firebase.database.ServerValue.TIMESTAMP
  }).catch(() => {});
}

let presenceFor = null;
function setupPresence() {
  if (!me.identity || presenceFor === me.identity || !firebase.auth().currentUser) return;
  presenceFor = me.identity;
  const ref = db.ref("presence/" + me.identity);
  db.ref(".info/connected").on("value", s => {
    if (s.val()) {
      ref.onDisconnect().remove().catch(() => {});
      ref.set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
    }
  });
}

let statsSubscribed = false;
function subscribeAdminStats() {
  if (statsSubscribed || !me.admin) return;
  statsSubscribed = true;
  db.ref("views").on("value", s => { S.views = s.val() || {}; renderAdmin(); }, () => {});
  db.ref("presence").on("value", s => { S.presence = s.val() || {}; renderAdmin(); }, () => {});
}

function ago(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
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

for (const node of ["state", "config", "seats", "golfers", "picks", "pickedGolfers", "overrides", "autodraft"]) {
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
  subscribeQueue();
}

/* ---- pick queue: private per owner (/queues/{owner}, readable by that seat + admin).
   Autodraft picks from the queue in order, then falls back to best available odds. */
let queueRef = null, queueOwner = null;
function subscribeQueue() {
  if (queueOwner === me.owner) return;
  if (queueRef) { queueRef.off(); queueRef = null; }
  queueOwner = me.owner;
  S.myQueue = [];
  if (me.owner) {
    queueRef = db.ref("queues/" + me.owner);
    queueRef.on("value", s => { S.myQueue = s.val() || []; render(); }, () => { S.myQueue = []; });
  }
}

// current queue with drafted/unknown golfers pruned
const liveQueue = () => (S.myQueue || []).filter(g => S.golfers[g] && S.pickedGolfers[g] == null);

async function writeQueue(arr) {
  if (!me.owner) return;
  try { await db.ref("queues/" + me.owner).set(arr.length ? arr : null); }
  catch (e) { alert("Couldn't save queue — admin may still need to update the database rules. (" + e.message + ")"); }
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

/* ---- autodraft: the flag lives in the shared DB (/autodraft/{owner}), so ANY open page
   that is allowed to submit the on-clock pick executes it — the seat owner's own browser
   or the admin's. That way a flagged owner's picks still fire while their phone is locked,
   as long as someone (in practice the admin) has the site open. Duplicate timers are
   harmless: the rules reject the second write. */
const autodraftOn = (owner) => !!(S.autodraft || {})[owner];
let autodraftArmedFor = -1;
function scheduleAutodraft() {
  if (!(phase() === "draft" && !draftDone())) return;
  const clockOwner = onClockOwner();
  if (!clockOwner || !autodraftOn(clockOwner)) return;
  if (!(me.admin || me.owner === clockOwner)) return; // this client may submit that pick
  const i = currentPick();
  if (autodraftArmedFor === i) return;
  autodraftArmedFor = i;
  setTimeout(async () => {
    // re-verify at fire time — state may have moved, or the flag may have been turned off
    if (!(phase() === "draft" && onClockOwner() === clockOwner && autodraftOn(clockOwner) && currentPick() === i)) return;
    // queued golfers first (their own page has it cached; the admin's page reads it on demand)
    let gid = null;
    try {
      const q = me.owner === clockOwner ? (S.myQueue || []) : ((await db.ref("queues/" + clockOwner).once("value")).val() || []);
      gid = q.find(g => S.golfers[g] && S.pickedGolfers[g] == null) || null;
    } catch (e) { /* queue unreadable — fall back to best odds */ }
    if (!(phase() === "draft" && onClockOwner() === clockOwner && autodraftOn(clockOwner) && currentPick() === i)) return;
    if (!gid) {
      const best = Object.entries(S.golfers)
        .filter(([g]) => S.pickedGolfers[g] == null)
        .map(([g, v]) => ({ gid: g, ...v }))
        .sort(golferCompare)[0];
      gid = best ? best.gid : null;
    }
    if (gid) makePick(gid, true);
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
  subscribeAdminStats();
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
  await db.ref().update({ picks: null, pickedGolfers: null, schedule: null, "config/recap": null, state: { phase: "setup", currentPick: 0, draftOrder: draftOrder() || owners() } });
}

async function fullReset() {
  if (!confirm("FULL reset? Erases picks, field, seats, overrides — everything.")) return;
  if (!confirm("Really erase everything?")) return;
  await db.ref().update({
    picks: null, pickedGolfers: null, schedule: null, golfers: null, seats: null, overrides: null,
    "config/recap": null,
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
      const state = c.status?.type?.state || "";
      const thru = Number(c.status?.thru) || 0;
      const curPeriod = Number(c.status?.period) || 0;
      // linescores[period].value is a RUNNING stroke count while that round is in
      // progress — only record it as a round once the round is actually finished,
      // otherwise partial strokes leak into round math (and the R2 payout freeze)
      const rounds = {};
      let today = null; // in-progress round to par, ESPN's "Today" column (e.g. "-1")
      for (const ls of c.linescores || []) {
        const v = Number(ls.value);
        if (!Number.isFinite(v) || ls.period < 1 || ls.period > 4) continue;
        if (ls.period < curPeriod || (ls.period === curPeriod && (thru >= 18 || state === "post"))) rounds[ls.period] = v;
        else if (ls.period === curPeriod) today = ls.displayValue ?? null;
      }
      const statusName = c.status?.type?.name || "";
      // mid-round, score.displayValue lags — the live overall to-par is the scoreToPar statistic
      const stat = (c.statistics || []).find(s => s.name === "scoreToPar");
      const started = state === "in" || state === "post" || thru > 0 || Object.keys(rounds).length > 0;
      const statVal = Number(stat?.value);
      const liveToPar = !started ? null
        : Number.isFinite(statVal) ? statVal
        : parseToPar(stat?.displayValue ?? c.score?.displayValue);
      return {
        name: c.athlete?.displayName || "?",
        norm: normName(c.athlete?.displayName || ""),
        espnId: c.athlete?.id != null ? String(c.athlete.id) : null,
        rounds,
        today,
        totalStrokes: Number(c.score?.value),
        toPar: started ? (stat?.displayValue ?? c.score?.displayValue ?? "") : "-",
        liveToPar, // overall to par, live mid-round; null before first tee shot
        statusName,
        state,
        thru,
        displayThru: started ? (c.status?.displayThru || (thru ? String(thru) : "")) : "",
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
  renderAdmin();
}

/* ---- hole-by-hole scorecard modal (display-only, fetched on demand) ---- */
const scCache = {};
const scUrl = id => "https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard/" +
  (S.state?.espnEventId || ESPN_EVENT_ID) + "/playersummary?region=us&lang=en&player=" + id;

function openScorecard(id, name) {
  $("scModal").classList.remove("hidden");
  $("scTitle").textContent = name;
  $("scTabs").innerHTML = "";
  $("scBody").innerHTML = '<p class="muted">Loading scorecard&hellip;</p>';
  const cached = scCache[id];
  if (cached && Date.now() - cached.at < 120000) { renderScorecard(id); return; }
  fetch(scUrl(id))
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(d => { scCache[id] = { at: Date.now(), rounds: d.rounds || [] }; renderScorecard(id); })
    .catch(e => { $("scBody").innerHTML = `<p class="muted">Couldn't load scorecard (${esc(e.message)}).</p>`; });
}

function renderScorecard(id, sel) {
  const data = scCache[id];
  if (!data) return;
  const rounds = data.rounds
    .map((r, i) => ({ num: r.period || i + 1, holes: (r.linescores || []).filter(h => Number.isFinite(Number(h.value))) }))
    .filter(r => r.holes.length);
  if (!rounds.length) { $("scTabs").innerHTML = ""; $("scBody").innerHTML = '<p class="muted">No holes played yet.</p>'; return; }
  const cur = (sel != null && rounds.find(r => r.num === sel)) || rounds[rounds.length - 1];
  $("scTabs").innerHTML = rounds.map(r =>
    `<button class="sc-tab${r.num === cur.num ? " active" : ""}" data-scround="${r.num}" data-scid="${esc(id)}">R${r.num}</button>`).join("");
  const cls = h => {
    const t = h?.scoreType?.name || "";
    return /EAGLE|ALBATROSS/i.test(t) ? "sc-eagle"
      : t === "BIRDIE" ? "sc-birdie"
      : t === "BOGEY" ? "sc-bogey"
      : /DOUBLE|TRIPLE|OTHER/i.test(t) ? "sc-double" : "";
  };
  const half = (from, label) => {
    const cells = [];
    for (let hole = from; hole < from + 9; hole++) cells.push(cur.holes.find(x => x.period === hole) || null);
    if (!cells.some(Boolean)) return "";
    const sum = k => cells.reduce((s, h) => s + (h ? Number(h[k]) || 0 : 0), 0);
    return `<div class="table-wrap"><table class="sc-grid">` +
      `<tr><th>Hole</th>${cells.map((_, i) => `<th class=num>${from + i}</th>`).join("")}<th class=num>${label}</th></tr>` +
      `<tr><td class=muted>Par</td>${cells.map(h => `<td class=num>${h ? (h.par ?? "") : ""}</td>`).join("")}<td class=num>${sum("par") || ""}</td></tr>` +
      `<tr><td class=muted>Score</td>${cells.map(h => `<td class="num ${cls(h)}">${h ? esc(h.displayValue ?? "") : ""}</td>`).join("")}<td class=num><b>${sum("value") || ""}</b></td></tr>` +
      `</table></div>`;
  };
  $("scBody").innerHTML = half(1, "OUT") + half(10, "IN") +
    `<p class="small sc-legend"><span class="sc-eagle">eagle</span><span class="sc-birdie">birdie</span><span class="sc-bogey">bogey</span><span class="sc-double">double+</span></p>`;
}

document.addEventListener("click", e => {
  const el = e.target.closest?.(".golfer-link");
  if (el) openScorecard(el.dataset.espnid, el.dataset.gname);
});
$("scClose").addEventListener("click", () => $("scModal").classList.add("hidden"));
$("scModal").addEventListener("click", e => { if (e.target === $("scModal")) $("scModal").classList.add("hidden"); });
$("scTabs").addEventListener("click", e => {
  const r = e.target.dataset?.scround;
  if (r) renderScorecard(e.target.dataset.scid, Number(r));
});

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
  const base = { matched: true, manual: false, out: c.out, pos: c.pos, detail: c.detail, espnName: c.name, espnId: c.espnId, state: c.state, thru: c.thru };
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

/* ---- payout helpers (display-only) ---- */
// true once every still-active competitor has posted rounds 1..r
function roundComplete(r) {
  const active = espn.competitors.filter(c => !c.out);
  if (!active.length) return false;
  return active.every(c => {
    for (let k = 1; k <= r; k++) if (!Number.isFinite(c.rounds[k])) return false;
    return true;
  });
}

// golfer to-par using only rounds 1..thru (retroactively stable once those rounds are posted)
function golferScoreAt(gid, thru) {
  const ov = (S.overrides || {})[gid] || {};
  if (ov.score != null && ov.score !== "") return Number(ov.score);
  const g = S.golfers[gid];
  if (!g) return null;
  const c = espn.byNorm[ov.espnName ? normName(ov.espnName) : normName(g.name)];
  if (!c) return null;
  let total = 0, played = 0;
  for (let r = 1; r <= thru; r++) {
    if (Number.isFinite(c.rounds[r])) { total += c.rounds[r] - espn.par; played++; }
    else if (c.out) { total += CUT_SCORE - espn.par; }
  }
  return played === 0 && !c.out ? null : total;
}

// Top X Combined standings using only rounds 1..thru
function topAt(thru) {
  return owners().map(o => {
    const totals = teamRoster(o).map(p => golferScoreAt(p.gid, thru)).filter(v => v != null).sort((a, b) => a - b).slice(0, numTop());
    return { owner: o, sum: totals.length ? totals.reduce((s, v) => s + v, 0) : null };
  }).sort((a, b) => (a.sum ?? 1e9) - (b.sum ?? 1e9));
}

// all teams tied for the lead of a sorted standings list
function leadersOf(rows, key) {
  const first = rows[0];
  if (!first || first[key] == null) return null;
  const names = rows.filter(r => r[key] === first[key]).map(r => r.owner);
  return { names: names.join(" & "), value: first[key], tie: names.length > 1 };
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
  chk.checked = !!(me.owner && autodraftOn(me.owner));
  const show = eligible && autodraftOn(me.owner);
  ab.classList.toggle("hidden", !show);
  if (show) ab.textContent = `🤖 AUTODRAFT ENABLED — ${me.owner}, your picks will be made automatically (your queue first, then best available odds), even if your screen locks. Uncheck "Autodraft my picks" to take back control.`;
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

function renderRecap(recap) {
  $("recapIntro").textContent = recap.intro || "";
  $("recapBody").innerHTML = (recap.teams || []).map((t, i) =>
    `<div class="recap-card">` +
    `<div class="recap-head"><span class="rank">${i + 1}.</span><span class="team">${esc(t.owner)}</span><span class="grade">${esc(t.grade || "")}</span></div>` +
    (t.tagline ? `<div class="tagline">${esc(t.tagline)}</div>` : "") +
    `<p class="blurb">${esc(t.blurb || "")}</p>` +
    `<div class="chips">${(t.chips || []).map(c => `<span class="chip ${c.kind === "steal" ? "steal" : (c.kind === "reach" ? "reach" : "")}">${esc(c.text)}</span>`).join("")}</div>` +
    `</div>`
  ).join("");
}

function renderDraft() {
  // once the draft is complete and a recap has been published, it replaces the pick panel
  const recap = S.config && S.config.recap;
  const showRecap = draftDone() && recap && recap.teams;
  $("recapPanel").classList.toggle("hidden", !showRecap);
  $("pickPanel").classList.toggle("hidden", !!showRecap);
  if (showRecap) renderRecap(recap);

  // available golfers
  const q = normName($("golferSearch").value || "");
  const avail = Object.entries(S.golfers || {})
    .filter(([gid]) => S.pickedGolfers[gid] == null)
    .map(([gid, g]) => ({ gid, ...g }))
    .filter(g => !q || normName(g.name).includes(q))
    .sort(golferCompare);
  $("availCount").textContent = `(${avail.length})`;
  const canPick = phase() === "draft" && !draftDone() && (me.admin || me.owner === onClockOwner());
  const canQueue = me.owner && phase() === "draft" && !draftDone();
  const queued = new Set(liveQueue());
  $("golferList").innerHTML = avail.map(g =>
    `<div class="golfer-row"><span class="name">${esc(g.name)}</span><span class="odds">${esc(fmtOdds(g.odds))}</span>` +
    (canQueue ? `<button data-qadd="${esc(g.gid)}" title="add to my queue" ${queued.has(g.gid) ? "disabled" : ""}>➕</button>` : "") +
    `<button data-gid="${esc(g.gid)}" ${canPick ? "" : "disabled"}>Draft</button></div>`
  ).join("") || `<p class="muted">No golfers${Object.keys(S.golfers || {}).length ? " match" : " loaded — admin pastes the field before the draft"}.</p>`;

  renderQueue();

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

function renderQueue() {
  const box = $("queueBox");
  const q = liveQueue();
  const show = me.owner && phase() === "draft" && !draftDone() && q.length > 0;
  box.classList.toggle("hidden", !show);
  if (!show) return;
  $("queueList").innerHTML = q.map((gid, i) =>
      `<div class="queue-row"><span class="qnum">${i + 1}.</span><span class="name">${esc(S.golfers[gid].name)}</span><span class="odds">${esc(fmtOdds(S.golfers[gid].odds))}</span>` +
      `<button data-qup="${i}" ${i === 0 ? "disabled" : ""}>↑</button><button data-qdel="${i}">✕</button></div>`
    ).join("") +
    (autodraftOn(me.owner) ? "" : `<div class="muted small" style="padding-top:6px">⚠ Turn on "Autodraft my picks" for the queue to draft automatically.</div>`);
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

  // payouts (display-only): R2 prize freezes from per-round data once R2 is complete
  const r2done = espn.eventStatus === "STATUS_FINAL" || roundComplete(2);
  const finalDone = espn.eventStatus === "STATUS_FINAL";
  const liveTop = topRows.map(t => ({ owner: t.owner, sum: t.topSum }));
  const r2Lead = r2done ? leadersOf(topAt(2), "sum") : leadersOf(liveTop, "sum");
  const ovLead = leadersOf(liveTop, "sum");
  const bgFirst = bestRows[0] && bestRows[0].best ? bestRows.filter(t => t.best && t.best.sc.total === bestRows[0].best.sc.total) : [];
  const bgLead = bgFirst.length ? { names: bgFirst.map(t => `${t.owner} (${t.best.pick.name})`).join(" & "), value: bestRows[0].best.sc.total, tie: bgFirst.length > 1 } : null;
  const payCell = (lead, done) => lead
    ? `<td><b>${esc(lead.names)}</b> ${fmtToPar(lead.value)}${lead.tie ? " — tie" : ""}</td><td>${done ? '<span class="counted">🏆 WINNER — pays out</span>' : '<span class="muted">current leader</span>'}</td>`
    : `<td class="muted">—</td><td class="muted">waiting on scores</td>`;
  $("payoutTable").innerHTML =
    `<tr><th>Prize</th><th>Leader</th><th>Status</th><th>How it's won</th></tr>` +
    `<tr><td><b>🥈 Round 2 Payout</b></td>${payCell(r2Lead, r2done)}<td class="muted">Top ${X} Combined leader at the end of Round 2</td></tr>` +
    `<tr><td><b>🏆 Overall Winner</b></td>${payCell(ovLead, finalDone)}<td class="muted">Top ${X} Combined at the end of the tournament</td></tr>` +
    `<tr><td><b>⭐ Best Golfer</b></td>${payCell(bgLead, finalDone)}<td class="muted">Lowest single golfer score at the end of the tournament</td></tr>`;

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
      const nameCell = sc.espnId ? `<span class="golfer-link" data-espnid="${esc(sc.espnId)}" data-gname="${esc(r.pick.name)}">${esc(r.pick.name)}</span>` : esc(r.pick.name);
      return `<tr><td>${isCounted ? '<span class="counted">✓</span> ' : ""}${nameCell}</td><td class="num ${cls}${isCounted ? " counted" : ""}">${total}</td><td class="${cls}">${note}</td></tr>`;
    }).join("");
    return `<div class="roster-card"><h4>${esc(t.owner)}</h4><table><tr><th>Golfer</th><th class=num>To Par</th><th>Status</th></tr>${rows || "<tr><td colspan=3 class=muted>no picks</td></tr>"}</table></div>`;
  }).join("");

  // official leaderboard
  const lb = espn.competitors.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  $("leaderboard").innerHTML = lb.length
    ? "<tr><th>Pos</th><th>Player</th><th class=num>To Par</th><th class=num>Today</th><th class=num>Thru</th><th class=num>R1</th><th class=num>R2</th><th class=num>R3</th><th class=num>R4</th><th class=num>Tot</th><th>Status</th></tr>" +
      lb.map(c =>
        `<tr><td>${esc(c.pos)}</td><td>${c.espnId ? `<span class="golfer-link" data-espnid="${esc(c.espnId)}" data-gname="${esc(c.name)}">${esc(c.name)}</span>` : esc(c.name)}</td><td class="num">${esc(c.toPar)}</td><td class="num">${esc(c.today ?? "")}</td><td class="num">${esc(c.displayThru)}</td>` +
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
    const on = autodraftOn(o);
    const state = on ? ' <span class="counted">🤖 autodraft is ON</span>' : "";
    return `<div>${esc(o)}:${state} ${v ? `claimed <span class="muted small">(${esc(String(v).slice(0, 12))}…)</span> <button data-clearseat="${esc(o)}">clear</button>` : '<span class="muted">open</span>'} <button data-autodraft="${esc(o)}">turn autodraft ${on ? "OFF" : "ON"}</button></div>`;
  }).join("");

  // usage stats (populated only after subscribeAdminStats)
  if (S.views || S.presence) {
    const views = S.views || {}, pres = S.presence || {};
    const seatIds = {};
    for (const o of owners()) if ((S.seats || {})[o]) seatIds[S.seats[o]] = o;
    let rows = "";
    for (const o of owners()) {
      const id = (S.seats || {})[o];
      const v = id ? views[id] : null;
      rows += `<tr><td>${id && pres[id] ? "🟢 " : ""}<b>${esc(o)}</b>${id ? "" : ' <span class="muted small">(no seat claimed)</span>'}</td><td class="num">${v ? v.count || 0 : 0}</td><td>${v ? ago(v.last) : "never"}</td></tr>`;
    }
    const specIds = Object.keys(views).filter(id => !seatIds[id]);
    const specViews = specIds.reduce((s, id) => s + (views[id].count || 0), 0);
    const specLast = specIds.reduce((m, id) => Math.max(m, views[id].last || 0), 0);
    const specOnline = Object.keys(pres).filter(id => !seatIds[id]).length;
    rows += `<tr><td>${specOnline ? "🟢 " : ""}Spectators (${specIds.length} device${specIds.length === 1 ? "" : "s"})</td><td class="num">${specViews}</td><td>${specLast ? ago(specLast) : "never"}</td></tr>`;
    $("usageBox").innerHTML = `<div class="table-wrap"><table><tr><th>Who</th><th class=num>Views</th><th>Last seen</th></tr>${rows}</table></div>` +
      `<p class="muted small" style="margin-top:6px">🟢 = on the site right now &middot; views are page loads since this feature went live</p>`;
  }

  // scoring fixes table (skip rebuild while editing)
  const ft = $("fixTable");
  if (!ft.contains(document.activeElement)) {
    const picks = Object.values(S.picks || {}).sort((a, b) => a.idx - b.idx);
    ft.innerHTML = "<tr><th>Golfer</th><th>Team</th><th>Match</th><th>ESPN name map</th><th>Score override</th><th></th></tr>" +
      (picks.map(p => {
        const ov = (S.overrides || {})[p.gid] || {};
        const sc = golferScore(p.gid);
        const match = sc.manual ? "manual" : (sc.matched ? "✓ " + esc(sc.espnName || "") : (espn.competitors.length ? "✗ NO MATCH" : "loading…"));
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
  if ((btn.dataset.tab === "standings" || btn.dataset.tab === "admin") && Date.now() - espn.fetchedAt > POLL_MS) fetchScores(false);
}));

$("claimBtn").addEventListener("click", () => claimSeat($("seatSelect").value));
$("autodraftChk").addEventListener("change", async e => {
  if (!me.owner) return;
  if (e.target.checked && !confirm("Enable autodraft? When you're on the clock, your pick will be made automatically — from your queue first (in order), otherwise the best available golfer by odds — even if you put your phone away.")) {
    e.target.checked = false;
    return;
  }
  autodraftArmedFor = -1;
  try { await db.ref("autodraft/" + me.owner).set(e.target.checked ? true : null); }
  catch (err) { alert("Could not update autodraft: " + err.message); }
  render();
});
$("golferSearch").addEventListener("input", renderDraft);
$("golferList").addEventListener("click", e => {
  const qadd = e.target.dataset?.qadd;
  if (qadd) { writeQueue([...liveQueue(), qadd]); return; }
  const gid = e.target.dataset?.gid;
  if (gid) makePick(gid);
});
$("queueList").addEventListener("click", e => {
  const q = liveQueue();
  const up = e.target.dataset?.qup, del = e.target.dataset?.qdel;
  if (up != null) { const i = +up; if (i > 0) { [q[i - 1], q[i]] = [q[i], q[i - 1]]; writeQueue(q); } }
  else if (del != null) { q.splice(+del, 1); writeQueue(q); }
});
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
  const a = e.target.dataset?.autodraft;
  if (a && confirm(`Turn autodraft ${autodraftOn(a) ? "OFF" : "ON"} for ${a}?${autodraftOn(a) ? "" : " Their picks will be made automatically (best available odds)."}`)) {
    autodraftArmedFor = -1;
    db.ref("autodraft/" + a).set(autodraftOn(a) ? null : true);
  }
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
    firebase.auth().onAuthStateChanged(u => { if (u) { db.ref("admin/authorized/" + u.uid).set(ADMIN_HASH).catch(() => {}); subscribeAdminStats(); } });
    subscribeAdminStats();
    render();
  }
})();
