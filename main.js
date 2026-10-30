// Evo game: creatures with tiny neural-network brains that evolve only by breeding.
// Open index.html in a browser. You can watch, or jump in as one creature.
// Keys: 1 = play a herbivore, 2 = play a carnivore (while watching or after you die)
//       W/Up forward, A/D or Left/Right turn, Shift sprint, mouse wheel or -/= cruise speed
//       E eat, Space attack, C mate (you glow), T fast-forward, P pause, F fullscreen on/off
// Click any creature (while not playing) to see its brain, what it sees and its stats; any key exits.
// URL options: ?embed (watch only: no keys, no controls bar, e.g. inside a web page)
//              ?server=http://host:8787 (don't simulate here: draw the world running on that server)
//              ?species=carnivore  ?seed=1  ?demo (fake keyboard input, for testing)

const CHOOSE = { Digit1: "herbivore", Digit2: "carnivore" };
const FONT = "ui-monospace, Menlo, Consolas, monospace";

const params = new URLSearchParams(location.search);
const embed = params.has("embed"); // watch only: nobody can play
// Remote mode: the world lives on a server, given in the address (?server=...) or by the page (watch.html).
const server = (params.get("server") || window.EVO_SERVER || "").replace(/\/+$/, "");
const SPEEDS = [1, 4, 16, 32, 64]; // fast-forward steps, cycled with T (or the page's button)
let world = server ? remoteView() : new World(params.has("seed") ? Number(params.get("seed")) : C.SEED);
let worldNo = 1, lastEnd = null, speedIdx = 0;
const score = { herbivore: 0, carnivore: 0 }; // worlds won: a species wins when the other dies out
const held = new Set(); // keys currently held (KeyboardEvent.code)
const demo = params.has("demo");
let player = !embed && !server && params.get("species") in C.SPECIES ? spawnPlayer(params.get("species")) : null;
let paused = false;

function spawnPlayer(species) {
  const ctl = new PlayerController();
  ctl.keys = held;
  // You don't think with it, but your children inherit from it: a copy of a random living brain of your species.
  const kin = world.creatures.filter((c) => c.species === species && !c.isPlayer);
  const brain = kin.length ? kin[Math.floor(Math.random() * kin.length)].brain.clone() : Brain.random(world.rng);
  return world.spawn(species, ctl, brain, { isPlayer: true });
}

function restartWorld(end) {
  // Nothing ever spawns mid-world. When a species dies out (end = its name), the whole world starts over,
  // bred from the hall of fame (the biggest families, survivors of the old world included). A tie (the
  // rivers keep the two species apart) gives each +0.5.
  for (const c of world.creatures) world.hall.consider(c);
  world.hall.rank();
  const winner = end === "tie" ? "tie" : end === "herbivore" ? "carnivore" : "herbivore";
  if (winner === "tie") score.herbivore += 0.5, score.carnivore += 0.5;
  else score[winner]++;
  lastEnd = { worldNo, winner, seconds: Math.floor(world.tick / C.FPS) };
  collectLocal();
  if (winner === "tie") localUnlock({ id: "stalemate", species: null, creature: null, mid: null });
  const last5 = achWinners.slice(-5), loser = winner === "herbivore" ? "carnivore" : "herbivore";
  if (winner !== "tie" && last5.length === 5 && last5.every((w) => w === loser)) {
    localUnlock({ id: "comeback", species: winner, creature: null, mid: null });
  }
  achWinners = [...achWinners, winner].slice(-10);
  worldNo++;
  world = new World(C.SEED, world.hall);
  world.locked = localLocked();
  world.walls = localWalls;
  player = null;
  stopInspect();
}

// ---------- remote mode: draw the world a server is running (server/server.js) ----------

function remoteView() {
  // Just enough of a World for drawing; it's refilled from every snapshot the server sends.
  const gcols = Math.floor(C.WORLD_W / C.GRASS_CELL), grows = Math.floor(C.WORLD_H / C.GRASS_CELL);
  return {
    w: C.WORLD_W, h: C.WORLD_H, gcols, grows, grass: new Float32Array(gcols * grows),
    creatures: [], corpses: [], history: [], tick: 0, counts: { herbivore: 0, carnivore: 0 },
    count(species) { return this.counts[species]; },
    offset(me, x, y) { const dx = wrapDelta(x - me.x, this.w), dy = y - me.y; return [dx, dy, Math.hypot(dx, dy)]; },
    readyToMate: () => false,
  };
}

let serverStatus = server ? "connecting…" : "";
if (server) {
  const stream = new EventSource(`${server}/stream`); // reconnects by itself if the server goes away
  stream.onopen = () => { serverStatus = ""; };
  stream.onerror = () => { serverStatus = "server offline, retrying…"; };
  stream.onmessage = (e) => applySnapshot(JSON.parse(e.data));
}

function applySnapshot(s) {
  world.tick = s.tick;
  worldNo = s.worldNo;
  Object.assign(score, s.score);
  lastEnd = s.lastEnd;
  world.lr = s.lr;
  currentRun = s.run || "";
  world.realSpeed = s.realSpeed;
  paused = !!s.paused;
  world.walls = !!s.walls;
  if (s.achN !== undefined && s.achN !== achSeenN) { // somebody won something: get the list (pop-ups after the first load)
    refreshAchievements(achSeenN >= 0);
    achSeenN = s.achN;
  }
  speedIdx = Math.max(0, SPEEDS.indexOf(s.speed));
  const raw = atob(s.grass);
  for (let i = 0; i < raw.length; i++) world.grass[i] = (raw.charCodeAt(i) / 255) * C.GRASS_MAX;
  if (inspect && s.worldNo !== inspect.worldNo) stopInspect(); // that world (and creature) is gone
  // Gliding: each creature moves smoothly from where it's drawn now (from*) to its new position (to*)
  // until the next snapshot is due, so motion looks fluid even with ~15 snapshots a second.
  const shown = new Map(world.creatures.map((c) => [c.id, c]));
  const now = performance.now();
  if (glide.at) glide.gap = 0.8 * glide.gap + 0.2 * Math.min(250, now - glide.at); // typical time between snapshots
  glide.at = now;
  const cr = s.cr, creatures = [], counts = { herbivore: 0, carnivore: 0 };
  for (let i = 0; i < cr.length; i += 9) { // species, x, y, angle*100, r, g, b, glow, id
    const species = cr[i] ? "carnivore" : "herbivore", id = cr[i + 8], old = shown.get(id);
    counts[species]++;
    const toX = cr[i + 1], toY = cr[i + 2], toA = cr[i + 3] / 100;
    creatures.push({ species, spec: C.SPECIES[species], x: old ? old.x : toX, y: old ? old.y : toY, angle: old ? old.angle : toA,
      fromX: old ? old.x : toX, fromY: old ? old.y : toY, fromA: old ? old.angle : toA, toX, toY, toA,
      color: [cr[i + 4], cr[i + 5], cr[i + 6]], glow: cr[i + 7], id, isPlayer: false });
  }
  world.creatures = creatures;
  world.counts = counts;
  world.corpses = [];
  for (let i = 0; i < s.co.length; i += 3) world.corpses.push({ x: s.co[i], y: s.co[i + 1], meat: s.co[i + 2] });
  world.history = s.hist;
}

const glide = { at: 0, gap: 50 }; // when the last snapshot came, and the usual gap between them (ms)

function glideCreatures() {
  const t = Math.min(1, (performance.now() - glide.at) / glide.gap);
  for (const c of world.creatures) {
    c.x = mod(c.fromX + wrapDelta(c.toX - c.fromX, world.w) * t, world.w); // the short way across the seam
    c.y = c.fromY + (c.toY - c.fromY) * t;
    c.angle = c.fromA + wrapAngle(c.toA - c.fromA) * t;
  }
}

let localWalls = false; // local game: walls stay for later worlds too
function toggleWalls() {
  // Walls down the middle of both rivers: nobody can cross, not even swimmers (each island on its own).
  if (server) fetch(`${server}/walls`, { method: "POST" }).catch(() => {}); // shared, like the speed
  else world.walls = localWalls = !localWalls;
}

function togglePause() {
  if (server) fetch(`${server}/pause`, { method: "POST" }).catch(() => {}); // shared, like the speed
  else paused = !paused;
}

function nextSpeed() {
  if (server) fetch(`${server}/speed`, { method: "POST" }).catch(() => {}); // shared by everyone watching
  else speedIdx = (speedIdx + 1) % SPEEDS.length;
}

// ---------- New run menu (remote mode): pick where each species' starting brains come from ----------

let runMenu = null; // the open menu's DOM element, or null
let currentRun = "";

function runLabel(id) {
  // "2026-10-29_14-02-20" -> "Oct 29, 14:02"
  const m = /^(\d+)-(\d+)-(\d+)_(\d+)-(\d+)/.exec(id);
  if (!m) return id;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  return `${month} ${Number(m[3])}, ${m[4]}:${m[5]}`;
}

function savedLabel(iso) {
  // "2026-10-29T20:44:29.000Z" -> "Oct 29, 23:44" in this computer's time zone
  const d = new Date(iso);
  if (isNaN(d)) return "?";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${month} ${d.getDate()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

async function openRunMenu() {
  if (!server || embed || runMenu) return;
  let runs = [];
  try {
    runs = await (await fetch(`${server}/runs`)).json();
  } catch {
    serverStatus = "server offline, can't load saved runs";
    return;
  }
  const el = document.createElement("div");
  el.className = "run-menu";
  // One picker per species and part of the map: the genome those creatures start from, and they're born there.
  const options = (sp) => ['<option value="starter">starter brains (hand-wired)</option>'].concat(runs.flatMap((r) => {
    const b = r[sp];
    if (b.brains === 0) return [];
    if (!b.fits) return [`<option disabled>${r.name ? "saved brain: " + escapeHtml(r.name) : "run " + runLabel(r.id)} · old brain shape</option>`];
    if (r.name) {
      const about = r.about && r.about !== r.name ? ` (${escapeHtml(r.about)})` : "";
      return [`<option value="${r.id}">saved brain: ${escapeHtml(r.name)}${about} · saved ${savedLabel(r.saved)}</option>`];
    }
    const head = `run ${runLabel(r.id)}${r.current ? " (current)" : ""} · ${r.worlds} worlds · score ${r.score.herbivore}:${r.score.carnivore}`;
    const opts = [];
    if (b.mid) opts.push(`<option value="${r.id}@mid">${head} · its ${b.mid} middle brains</option>`);
    if (b.sides) opts.push(`<option value="${r.id}@sides">${head} · its ${b.sides} side brains</option>`);
    if (b.brains > b.mid + b.sides) opts.push(`<option value="${r.id}">${head} · its ${b.brains} brains (from before the rivers)</option>`);
    return opts;
  })).join("");
  const pickers = [["herbivore", "mid", "herbivores · middle strip"], ["herbivore", "sides", "herbivores · sides"],
    ["carnivore", "mid", "carnivores · middle strip"], ["carnivore", "sides", "carnivores · sides"]]
    .map(([sp, part, label]) => `<label>${label}<select data-sp="${sp}" data-part="${part}">${options(sp)}</select></label>`).join("");
  el.innerHTML = `
    <h2>New run</h2>
    <p>Starts over at world 1, score 0:0. Pick the genome for each species and part of the map: those creatures
    start from it and are born there. The current run stays saved.</p>
    ${pickers}
    <div class="run-menu-buttons"><button data-act="start">Start</button><button data-act="cancel">Cancel</button></div>`;
  el.addEventListener("click", async (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === "cancel") closeRunMenu();
    if (act !== "start") return;
    const choice = { herbivore: {}, carnivore: {} };
    for (const sel of el.querySelectorAll("select")) choice[sel.dataset.sp][sel.dataset.part] = sel.value;
    try {
      await fetch(`${server}/newrun`, { method: "POST", body: JSON.stringify(choice) });
    } catch {
      serverStatus = "server offline, couldn't start a new run";
    }
    closeRunMenu();
  });
  document.body.appendChild(el);
  runMenu = el;
}

function closeRunMenu() {
  if (runMenu) runMenu.remove();
  runMenu = null;
}

let runButton = null;
if (server && !embed) {
  const btn = (runButton = document.createElement("button"));
  btn.className = "run-button";
  btn.textContent = "New run";
  btn.addEventListener("click", openRunMenu);
  document.body.appendChild(btn);
}

// Save brain (brain viewer): on a server it becomes an entry in the New run menu; locally it downloads a file.
let saveButton = null;
if (!embed) {
  const btn = (saveButton = document.createElement("button"));
  btn.className = "run-button save-button";
  btn.textContent = "Save brain";
  btn.style.display = "none";
  btn.addEventListener("click", openSaveForm);
  document.body.appendChild(btn);
}

// The name box under Save brain: type a name, Enter (or Save) saves, Esc (or Cancel) closes it.
let saveForm = null;
function openSaveForm() {
  if (!inspect || saveForm) return;
  const c = inspected();
  const el = (saveForm = document.createElement("div"));
  el.className = "save-form";
  el.innerHTML = `<input maxlength="60" placeholder="name this genome"><button data-act="save">Save</button><button data-act="cancel">Cancel</button>`;
  const input = el.querySelector("input");
  input.value = c ? `${c.spec.label} #${c.id}` : inspect.label;
  el.addEventListener("click", (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === "save") saveInspectedBrain(input.value);
    if (act === "cancel") closeSaveForm();
  });
  document.body.appendChild(el);
  input.focus();
  input.select();
}

function closeSaveForm() {
  if (saveForm) saveForm.remove();
  saveForm = null;
}

function flashSave(text) {
  saveButton.textContent = text;
  setTimeout(() => { saveButton.textContent = "Save brain"; }, 2000);
}

async function saveInspectedBrain(name) {
  closeSaveForm();
  if (!inspect) return;
  name = String(name || "").trim().slice(0, 60);
  if (server) {
    try {
      const r = await (await fetch(`${server}/savebrain/${inspect.id}`, { method: "POST", body: JSON.stringify({ name }) })).json();
      flashSave(r.saved ? "Saved ✓ (in New run)" : "It died, not saved");
    } catch {
      flashSave("Server offline");
    }
    return;
  }
  const c = inspected();
  if (!c) return flashSave("It died, not saved");
  const data = { name: name || `${c.spec.label} #${c.id} (world ${worldNo}, ${c.kids} kids)`, species: c.species,
    w: Array.from(c.brain.genes), lr: c.brain.learnRate, kids: c.kids, saved: new Date().toISOString() };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `brain_${(name || `${c.species}_${c.id}`).replace(/[^\w-]+/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  flashSave("Saved ✓ (downloaded)");
}

// ---------- achievements (achievements.js): each won once per run; the Achievements button lists them ----------
// On a server the server keeps them (snapshots say how many are won; then we fetch the list) and a New run
// starts them over. The local game is one run per page load, so they start over when you reload.

let achWon = {};      // id -> { species, creature, mid, at, run, world }
let achSeenN = -1;    // remote: how many were won at the last snapshot (-1 = not loaded yet)
let achWinners = [];  // local: the last worlds' winners, for Comeback
let achPanel = null;
const ACH_KEY = "evo-achievements";
if (!server) {
  try {
    localStorage.removeItem(ACH_KEY); // a new page = a new run: start over (also clears ones kept by older versions)
  } catch {
    // storage blocked: nothing to clear
  }
  world.locked = localLocked();
}

function localLocked() {
  return new Set(ACHIEVEMENTS.map((a) => a.id).filter((id) => !achWon[id]));
}

function localUnlock(e) {
  if (achWon[e.id]) return;
  achWon[e.id] = { ...e, at: new Date().toISOString(), run: "", world: worldNo };
  toastAchievement(e.id, achWon[e.id]);
  if (achPanel) renderAchPanel();
}

function collectLocal() {
  for (const e of world.won) localUnlock(e);
  world.won.length = 0;
}

async function refreshAchievements(toast) {
  try {
    const list = await (await fetch(`${server}/achievements`)).json(), before = achWon;
    achWon = {};
    for (const a of list) {
      if (!a.won) continue;
      achWon[a.id] = a.won;
      if (toast && !before[a.id]) toastAchievement(a.id, a.won);
    }
    if (achPanel) renderAchPanel();
  } catch {
    // server busy or gone: the next snapshot tries again
    achSeenN = -1;
  }
}

function achWho(won) {
  if (won.creature) return `${won.species} #${won.creature}`;
  return won.species ? `the ${won.species}s` : "the world";
}

function achWhere(won) {
  const part = won.mid === true ? " · middle strip" : won.mid === false ? " · sides" : "";
  return `${won.run ? `run ${runLabel(won.run)} · ` : ""}world ${won.world}${part}`;
}

let toastBox = null;
function toastAchievement(id, won) {
  // A pop-up at the bottom for 7 s; click it to look at that creature's brain (if it's still alive).
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a || embed) return;
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.className = "ach-toasts";
    document.body.appendChild(toastBox);
  }
  const el = document.createElement("div");
  el.className = "ach-toast";
  el.innerHTML = `<b>Achievement: ${escapeHtml(a.title)}</b> · ${escapeHtml(achWho(won))}<br><span>${escapeHtml(a.desc)}</span>`;
  el.addEventListener("click", () => {
    const c = won.creature && won.world === worldNo && world.creatures.find((o) => o.id === won.creature);
    if (c && (!player || !player.alive)) startInspect(c);
    el.remove();
  });
  toastBox.appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

function renderAchPanel() {
  const n = ACHIEVEMENTS.filter((a) => achWon[a.id]).length;
  const items = ACHIEVEMENTS.map((a) => {
    const won = achWon[a.id];
    const line = won ? `won by ${escapeHtml(achWho(won))} · ${savedLabel(won.at)} · ${escapeHtml(achWhere(won))}` : "not won yet";
    return `<div class="ach-item${won ? "" : " locked"}"><b>${escapeHtml(a.title)}</b> — ${escapeHtml(a.desc)}<br><span>${line}</span></div>`;
  }).join("");
  achPanel.innerHTML = `<h2>Achievements · ${n} / ${ACHIEVEMENTS.length} won</h2>
    <p>Each one can be won only once per run (a New run starts them over).</p>${items}
    <div class="run-menu-buttons"><button data-act="reset">Reset</button><button data-act="close">Close</button></div>`;
}

let resetArmed = 0; // Reset needs a second click within 3 s, so a misclick doesn't wipe them
async function resetAchievements(btn) {
  if (performance.now() - resetArmed > 3000) {
    resetArmed = performance.now();
    btn.textContent = "Click again to reset";
    setTimeout(() => { if (btn.isConnected) btn.textContent = "Reset"; }, 3000);
    return;
  }
  resetArmed = 0;
  if (server) {
    try {
      await fetch(`${server}/achievements/reset`, { method: "POST" });
    } catch {
      serverStatus = "server offline, couldn't reset the achievements";
    }
    await refreshAchievements(false);
  } else {
    achWon = {};
    world.locked = localLocked();
    world.won.length = 0;
  }
  if (achPanel) renderAchPanel();
}

function toggleAchPanel() {
  if (achPanel) return closeAchPanel();
  achPanel = document.createElement("div");
  achPanel.className = "run-menu ach-panel";
  achPanel.addEventListener("click", (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === "close") closeAchPanel();
    if (act === "reset") resetAchievements(e.target);
  });
  document.body.appendChild(achPanel);
  renderAchPanel();
  if (server) refreshAchievements(false);
}

function closeAchPanel() {
  if (achPanel) achPanel.remove();
  achPanel = null;
}

let wallsButton = null;
if (!embed) {
  const btn = (wallsButton = document.createElement("button"));
  btn.className = "run-button";
  btn.style.right = server ? "236px" : "138px"; // left of Achievements
  btn.addEventListener("click", toggleWalls);
  document.body.appendChild(btn);
}

let achButton = null;
if (!embed) {
  const btn = (achButton = document.createElement("button"));
  btn.className = "run-button";
  btn.style.right = server ? "110px" : "12px"; // left of New run
  btn.textContent = "Achievements";
  btn.addEventListener("click", toggleAchPanel);
  document.body.appendChild(btn);
}

// ---------- canvas & view ----------
// The canvas has devicePixelRatio x more pixels than CSS pixels, so on a Retina screen
// everything (text, circles) is drawn at full resolution instead of being upscaled.

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const view = { dpr: 1, w: 0, h: 0, s: 1, ox: 0, oy: 0, u: 1 };

function resize() {
  view.dpr = window.devicePixelRatio || 1;
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  canvas.style.width = `${view.w}px`;
  canvas.style.height = `${view.h}px`;
  view.s = Math.min(view.w / world.w, view.h / world.h); // world -> CSS px, letterboxed
  view.ox = (view.w - world.w * view.s) / 2;
  view.oy = (view.h - world.h * view.s) / 2;
  view.u = Math.max(0.8, Math.min(1.5, view.h / 900)); // UI scale for text and panels
}
addEventListener("resize", resize);
resize();

const toWorld = () => ctx.setTransform(view.dpr * view.s, 0, 0, view.dpr * view.s, view.dpr * view.ox, view.dpr * view.oy);
const toScreen = () => ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
const px = (n) => n / view.s; // n screen pixels, in world units
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ---------- input ----------

function toggleFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(el)).catch(() => {});
  }
}

addEventListener("keydown", (e) => {
  if (achPanel) { // the Achievements list is open: Esc closes it
    if (e.code === "Escape") closeAchPanel();
    return;
  }
  if (saveForm) { // typing a genome's name: keys go to the name box, Enter saves, Esc closes it
    if (e.code === "Enter") saveInspectedBrain(saveForm.querySelector("input").value);
    if (e.code === "Escape") closeSaveForm();
    return;
  }
  if (runMenu) { // the New run menu is open: Esc closes it, other keys go to the menu
    if (e.code === "Escape") closeRunMenu();
    return;
  }
  if (server && !embed && e.code === "KeyN" && !inspect) {
    openRunMenu();
    return;
  }
  if (inspect) { // any key leaves the brain viewer
    stopInspect();
    e.preventDefault();
    return;
  }
  if (embed) return;
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  held.add(e.code);
  if (e.repeat) return;
  if (e.code === "KeyP") togglePause();
  else if (e.code === "KeyW" && (!player || !player.alive)) toggleWalls(); // while playing, W walks
  else if (e.code === "KeyT") nextSpeed();
  else if (e.code === "KeyF") toggleFullscreen();
  else if (CHOOSE[e.code] && !server && (!player || !player.alive)) player = spawnPlayer(CHOOSE[e.code]);
  else if (player && (e.code === "Minus" || e.code === "Equal")) {
    player.controller.changeSpeed(e.code === "Equal" ? 0.1 : -0.1);
  }
});
addEventListener("keyup", (e) => held.delete(e.code));
addEventListener("blur", () => held.clear());

let wheelAcc = 0; // trackpads send many tiny wheel events; change speed once per "notch"
addEventListener("wheel", (e) => {
  if (embed || !player) return;
  e.preventDefault();
  wheelAcc += e.deltaY;
  while (Math.abs(wheelAcc) >= 60) {
    player.controller.changeSpeed(wheelAcc < 0 ? 0.1 : -0.1);
    wheelAcc -= Math.sign(wheelAcc) * 60;
  }
}, { passive: false });

// ---------- world drawing: black & white blueprint; only the creatures have color ----------

const INK = (a) => `rgba(255,255,255,${a})`;
const GRASS_LEVELS = 8; // grass is drawn as one of 8 hatching densities
let hatchTiles = [], hatchTilePx = 0, riverTile = null;
const WATER = (a) => `rgba(79, 155, 255, ${a})`; // river blue

function hatchTile(px, t, color) {
  // One hatched square (density t = 0..1) drawn in `color(alpha)`.
  const q = px / C.GRASS_CELL; // tile pixels per world unit
  const tile = document.createElement("canvas");
  tile.width = tile.height = px;
  const g = tile.getContext("2d");
  const inset = 2.5 * q, size = px - 2 * inset;
  g.fillStyle = color(0.02 + 0.06 * t);
  g.fillRect(inset, inset, size, size);
  g.save();
  g.beginPath();
  g.rect(inset, inset, size, size);
  g.clip();
  g.strokeStyle = color(0.18 + 0.55 * t);
  g.lineWidth = 1.2 * q;
  const step = (12 - 8 * t) * q;
  for (let d = -px; d < 2 * px; d += step) {
    g.beginPath();
    g.moveTo(d, 0);
    g.lineTo(d - px, px);
    g.stroke();
  }
  g.restore();
  return tile;
}

function buildHatchTiles() {
  // Pre-draw one hatched square per grass level (and the river square) at the current screen resolution,
  // so 1300 squares per frame are just image copies (and stay sharp on Retina).
  const px = Math.max(4, Math.ceil(C.GRASS_CELL * view.s * view.dpr));
  if (px === hatchTilePx) return;
  hatchTilePx = px;
  hatchTiles = [null];
  for (let k = 1; k <= GRASS_LEVELS; k++) hatchTiles.push(hatchTile(px, k / GRASS_LEVELS, INK));
  riverTile = hatchTile(px, 1, WATER); // water: hatched like the densest grass, in blue
}

function drawGrid() {
  ctx.strokeStyle = INK(0.07);
  ctx.lineWidth = px(1);
  ctx.beginPath();
  for (let x = 0; x <= world.w; x += C.GRASS_CELL) { ctx.moveTo(x, 0); ctx.lineTo(x, world.h); }
  for (let y = 0; y <= world.h; y += C.GRASS_CELL) { ctx.moveTo(0, y); ctx.lineTo(world.w, y); }
  ctx.stroke();
}

function drawGrass() {
  buildHatchTiles();
  const g = world.grass, cell = C.GRASS_CELL;
  for (let j = 0; j < world.grows; j++) {
    for (let i = 0; i < world.gcols; i++) {
      const level = Math.round((g[j * world.gcols + i] / C.GRASS_MAX) * GRASS_LEVELS);
      if (level > 0) ctx.drawImage(hatchTiles[level], i * cell, j * cell, cell, cell);
    }
  }
}

function drawRivers() {
  // Water squares: hatched like grass, but blue (the one colored thing besides the creatures).
  buildHatchTiles();
  const cell = C.GRASS_CELL;
  for (const [a, b] of riverBands()) {
    for (let x = a; x < b; x += cell) {
      for (let j = 0; j < world.grows; j++) ctx.drawImage(riverTile, x, j * cell, cell, cell);
    }
  }
  if (world.walls) { // W: a solid wall down the middle of each river, drawn like the top and bottom walls
    const t = C.RIVER_WALL;
    for (const [a, b] of riverBands()) {
      const wx = (a + b) / 2;
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(wx - t / 2, 0, t, world.h);
      ctx.strokeStyle = INK(0.85);
      ctx.lineWidth = px(1.5);
      ctx.strokeRect(wx - t / 2, 0, t, world.h);
    }
  }
}

function drawWalls() {
  const W = C.WALL;
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 0, world.w, W);
  ctx.fillRect(0, world.h - W, world.w, W);
  ctx.strokeStyle = INK(0.85);
  ctx.lineWidth = px(1.5);
  ctx.beginPath();
  ctx.moveTo(0, W); ctx.lineTo(world.w, W);
  ctx.moveTo(0, world.h - W); ctx.lineTo(world.w, world.h - W);
  ctx.stroke();
  // Left and right edges are open: a faint dashed seam marks where you wrap around.
  ctx.strokeStyle = INK(0.25);
  ctx.setLineDash([px(6), px(6)]);
  ctx.beginPath();
  ctx.moveTo(px(1), W); ctx.lineTo(px(1), world.h - W);
  ctx.moveTo(world.w - px(1), W); ctx.lineTo(world.w - px(1), world.h - W);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCorpse(k) {
  // A gray wreck: an "x" that shrinks as the meat runs out.
  const s = 3 + k.meat / 25;
  ctx.strokeStyle = INK(0.45);
  ctx.lineWidth = px(1.5);
  ctx.beginPath();
  ctx.moveTo(k.x - s, k.y - s); ctx.lineTo(k.x + s, k.y + s);
  ctx.moveTo(k.x + s, k.y - s); ctx.lineTo(k.x - s, k.y + s);
  ctx.stroke();
}

function drawGlow(c) {
  // Pulsing dashed rings that expand outward while a creature calls for a mate.
  const a = c.glow / C.GLOW_TICKS, r = c.spec.radius, phase = (world.tick % 15) / 15;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = px(1.4);
  for (let k = 0; k < 3; k++) {
    const f = (k + phase) / 3; // 0 = inner, 1 = outer
    ctx.strokeStyle = INK(a * (1 - f) * 0.9);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * (1.5 + 2.2 * f), 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawCreature(c) {
  const r = c.spec.radius;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.angle);
  ctx.lineWidth = Math.max(px(1.5), 1.8);
  ctx.strokeStyle = rgb(c.color);
  if (c.species === "herbivore") {
    // hexagon harvester drone
    ctx.beginPath();
    for (let k = 0; k < 6; k++) ctx.lineTo(Math.cos((k * Math.PI) / 3) * r, Math.sin((k * Math.PI) / 3) * r);
    ctx.closePath();
    ctx.fillStyle = rgb(c.color, 0.2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.3, 0, 2 * Math.PI);
    ctx.moveTo(r * 0.3, 0);
    ctx.lineTo(r * 1.35, 0);
    ctx.stroke();
  } else {
    // chevron hunter drone with a scan cone in front
    const cone = ctx.createRadialGradient(0, 0, r, 0, 0, r * 5);
    cone.addColorStop(0, rgb(c.color, 0.22));
    cone.addColorStop(1, rgb(c.color, 0));
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r * 5, -0.35, 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(r * 1.5, 0);
    ctx.lineTo(-r, -r);
    ctx.lineTo(-r * 0.4, 0);
    ctx.lineTo(-r, r);
    ctx.closePath();
    ctx.fillStyle = rgb(c.color, 0.2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgb(c.color);
    ctx.beginPath();
    ctx.arc(r * 0.35, 0, r * 0.15, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
  if (c === focus) {
    ctx.strokeStyle = INK(1);
    ctx.lineWidth = px(2);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r + 9, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.strokeStyle = INK(0.6);
    ctx.lineWidth = px(1.2);
    ctx.setLineDash([px(6), px(5)]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.spec.visionRange, 0, 2 * Math.PI);
    ctx.stroke();
    if (c !== player) { // brain viewer: also how far it sees glowing creatures
      ctx.strokeStyle = INK(0.3);
      ctx.setLineDash([px(2), px(6)]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, C.GLOW_RANGE, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function wrapped(thing, margin, draw) {
  // Draw something near the left/right edge on both sides of the seam, so it slides through smoothly.
  draw(thing);
  for (const dx of [-world.w, world.w]) {
    if ((dx > 0 && thing.x < margin) || (dx < 0 && thing.x > world.w - margin)) {
      ctx.save();
      ctx.translate(dx, 0);
      draw(thing);
      ctx.restore();
    }
  }
}

let focus = null; // the creature whose eyes we look through: you while playing, else the inspected one

function drawWorld() {
  focus = player && player.alive ? player : inspected();
  toWorld();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, world.w, world.h);
  ctx.clip(); // seam copies must not spill into the letterbox
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, world.w, world.h);
  drawGrid();
  drawGrass();
  drawRivers();
  drawWalls();
  for (const k of world.corpses) wrapped(k, 12, drawCorpse);
  for (const c of world.creatures) if (c.glow > 0) wrapped(c, c.spec.radius * 4, drawGlow);
  for (const c of world.creatures) if (!c.isPlayer && c !== focus) wrapped(c, c.spec.radius * 5, drawCreature);
  const playing = focus && player && focus === player;
  if (playing) {
    drawFog(focus); // only while you play: you see what your creature sees
    // Mating glows can be seen from GLOW_RANGE away, so those creatures shine through the dark.
    for (const c of world.creatures) {
      if (c === focus || c.glow <= 0) continue;
      const d = world.offset(focus, c.x, c.y)[2];
      if (d > focus.spec.visionRange && d <= C.GLOW_RANGE) {
        wrapped(c, c.spec.radius * 4, drawGlow);
        wrapped(c, c.spec.radius * 5, drawCreature);
      }
    }
  }
  if (focus) {
    // A creature picked in the brain viewer: no darkness, just its circles (see drawCreature).
    wrapped(focus, (playing ? focus.spec.visionRange : C.GLOW_RANGE) + 2, drawCreature);
    drawLockLines(focus);
  }
  ctx.restore();
}

function drawLockLines(me) {
  // Brain viewer: a dashed line from the inspected creature to whatever its brain is locked onto.
  const locked = inspect && inspect.info && inspect.info.locked;
  if (!locked || me.isPlayer) return;
  for (const id of [locked.herb, locked.pred]) {
    const t = id && world.creatures.find((c) => c.id === id);
    if (!t) continue;
    const tx = me.x + wrapDelta(t.x - me.x, world.w);
    ctx.strokeStyle = rgb(me.color, 0.9);
    ctx.lineWidth = px(1.5);
    ctx.setLineDash([px(4), px(4)]);
    ctx.beginPath();
    ctx.moveTo(me.x, me.y);
    ctx.lineTo(tx, t.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(tx, t.y, t.spec.radius + 6, 0, 2 * Math.PI);
    ctx.stroke();
  }
}

const FOG = "rgba(0,0,0,0.985)";

function drawFog(me) {
  // While playing, everything outside your vision radius is dark (also across the left-right seam).
  const R = me.spec.visionRange, centers = [me.x, me.x - world.w, me.x + world.w];
  ctx.beginPath();
  ctx.rect(0, 0, world.w, world.h);
  for (const x of centers) {
    ctx.moveTo(x + R, me.y);
    ctx.arc(x, me.y, R, 0, 2 * Math.PI);
  }
  ctx.fillStyle = FOG;
  ctx.fill("evenodd");
  for (const x of centers) { // soft edge just inside the circle
    const g = ctx.createRadialGradient(x, me.y, R * 0.82, x, me.y, R);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, FOG);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, me.y, R, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// ---------- HUD (screen pixels) ----------

function panel(x, y, w, h) {
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.strokeStyle = INK(0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4 * view.u);
  ctx.fill();
  ctx.stroke();
}

function text(str, x, y, size = 14, color = "#f0f0f0", align = "left") {
  ctx.font = `${size * view.u}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillText(str, x, y);
}

function bar(x, y, w, frac, color, label) {
  const u = view.u;
  ctx.strokeStyle = INK(0.5);
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 10 * u - 1);
  ctx.fillStyle = color;
  ctx.fillRect(x + 2, y + 2, (w - 4) * Math.max(0, Math.min(1, frac)), 10 * u - 4);
  text(label, x + w + 8 * u, y - 1 * u, 13);
}

function drawHud() {
  if (embed) return; // the page around the game shows the stats instead
  const u = view.u, x = 12 * u, alive = player && player.alive;
  panel(x, x, 560 * u, alive ? 194 * u : lastEnd ? 100 * u : 78 * u);
  text(`world ${worldNo}   ${clock(world.tick)}   herbivores ${world.count("herbivore")}   carnivores ${world.count("carnivore")}`,
    x + 10 * u, x + 9 * u);
  text(`${currentRun ? `run ${runLabel(currentRun)}   ·   ` : ""}score  herbivores ${score.herbivore} : ${score.carnivore} carnivores${embed ? "" : `   ·   speed ${speedText()}`}`,
    x + 10 * u, x + 31 * u);
  // The learning-rate gene evolves: watch whether learning pays off for each species.
  const lr = (sp) => (server ? (world.lr || {})[sp] || 0 : averageLearnRate(world, sp)).toPrecision(2);
  text(`learning gene  herbivores ${lr("herbivore")}   ·   carnivores ${lr("carnivore")}`, x + 10 * u, x + 53 * u);
  if (lastEnd && !alive) {
    text(`world ${lastEnd.worldNo}: ${lastEnd.winner === "tie" ? "a tie (the rivers kept them apart)" : `${lastEnd.winner}s won`} after ${clock(lastEnd.seconds * C.FPS)}`,
      x + 10 * u, x + 75 * u, 14, "#a8a8a8");
  }
  if (alive) {
    ctx.save();
    ctx.translate(0, 44 * u);
    const s = player.spec, ctl = player.controller;
    const mate = world.readyToMate(player) ? "ready"
      : player.mateCooldown ? `cooldown ${player.mateCooldown}` : `need ${s.mateEnergy} energy`;
    text(`you: ${s.label}  (gen ${player.generation}, age ${Math.floor(player.age / C.FPS)}s)`, x + 10 * u, x + 31 * u);
    text(`cruise speed ${(ctl.speedFrac * s.maxSpeed).toFixed(1)} / ${s.maxSpeed}   action: ${player.lastAction}`,
      x + 10 * u, x + 53 * u);
    text(`mate: ${mate}${player.glow > 0 ? "   (( glowing ))" : ""}`, x + 10 * u, x + 75 * u);
    bar(x + 10 * u, x + 103 * u, 180 * u, player.energy / s.maxEnergy, INK(0.95), `energy ${Math.round(player.energy)}`);
    bar(x + 10 * u, x + 125 * u, 180 * u, player.health / s.maxHealth, INK(0.55), `health ${Math.round(player.health)}`);
    ctx.restore();
  }
  if (embed) return; // nothing to press, so no controls bar
  const hh = 28 * u;
  panel(0, view.h - hh, view.w, hh);
  text(bottomLine(), view.w / 2, view.h - hh + 8 * u, 12, "#dcdcdc", "center");
}

function speedText() {
  // In remote mode the server may not manage the chosen speed; say how fast it really runs.
  const want = SPEEDS[speedIdx], real = server ? world.realSpeed : null;
  return real != null && real < want * 0.9 ? `${want}x (really ${real.toFixed(1)}x)` : `${want}x`;
}

function clock(ticks) {
  const sec = Math.floor(ticks / C.FPS);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function bottomLine() {
  // The bottom bar is the only place for messages, so the middle of the screen stays free to watch.
  let line;
  if (inspect) {
    line = `looking at ${inspect.label}   ·   press any key to exit`;
  } else if (server) {
    line = serverStatus || `watching the world on ${server.replace(/^https?:\/\//, "")}   ·   click a creature to see its brain   ·   N new run   ·   T speed   ·   W walls   ·   F fullscreen`;
  } else if (!player) {
    line = "watching   ·   click a creature to see its brain   ·   1 play as a herbivore   ·   2 as a carnivore   ·   T fast-forward   ·   P pause   ·   W walls   ·   F fullscreen";
  } else if (!player.alive) {
    line = `you died: ${player.deathCause} after ${Math.floor(player.age / C.FPS)}s   ·   ` +
      "1 = reborn as a herbivore   ·   2 = as a carnivore   ·   T fast-forward   ·   P pause   ·   F fullscreen";
  } else {
    line = "W forward   A/D turn   Shift sprint   wheel or -/= speed   E eat   Space attack   C mate (glow)   " +
      "T fast-forward   P pause   F fullscreen";
  }
  return paused ? `PAUSED (P to continue)   ·   ${line}` : line;
}

function drawGraph() {
  const u = view.u, w = 300 * u, h = 110 * u, x = view.w - w - 12 * u, y = view.h - h - (embed ? 12 : 40) * u;
  panel(x, y, w, h);
  text("population  — herbivores  ·· carnivores", x + 8 * u, y + 6 * u, 12, "#dcdcdc");
  const hist = world.history.slice(-Math.floor(w));
  if (hist.length < 2) return;
  for (const [idx, dash] of [[0, []], [1, [2, 3]]]) { // each line scaled to its own max
    const top = Math.max(1, ...hist.map((p) => p[idx]));
    ctx.strokeStyle = INK(idx ? 0.65 : 0.95);
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.beginPath();
    hist.forEach((p, i) => ctx.lineTo(x + (i * w) / hist.length, y + h - 8 * u - (p[idx] / top) * (h - 34 * u)));
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function render() {
  toScreen();
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, view.w, view.h);
  drawWorld();
  toScreen();
  drawHud();
  if (runButton) runButton.style.display = inspect ? "none" : ""; // the brain panel takes the right side
  if (achButton) achButton.style.display = inspect ? "none" : "";
  if (wallsButton) {
    wallsButton.style.display = inspect || !riverBands().length ? "none" : "";
    wallsButton.textContent = `Walls: ${world.walls ? "on" : "off"} (W)`;
  }
  if (saveButton) saveButton.style.display = inspect ? "" : "none"; // only while looking at a brain
  if (saveForm && !inspect) closeSaveForm();
  if (inspect) drawBrainPanel(); // it covers the right side, where the graph would be
  else drawGraph();
}

// ---------- main loop: fixed 30 ticks/s simulation (x fast-forward), drawing every animation frame ----------

let demoT = 0;
function demoKeys() {
  demoT++;
  held.add("KeyW");
  if (Math.floor(demoT / 40) % 3 === 0) held.add("KeyD");
  else held.delete("KeyD");
}

// ---------- brain viewer: click a creature to see its brain, what it sees and its stats ----------

let inspect = null; // { id, worldNo, label, info (see describeCreature), weights }

function creatureAt(x, y) {
  let best = null, bestD = 30; // world px around the click
  for (const c of world.creatures) {
    if (c.isPlayer) continue;
    const d = Math.hypot(wrapDelta(c.x - x, world.w), c.y - y);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function startInspect(c) {
  inspect = { id: c.id, worldNo, label: `${c.spec.label} #${c.id}`, info: null, weights: null, weightsAt: 0 };
  if (server) pollInspect();
}

function stopInspect() {
  inspect = null;
}

function inspected() {
  return (inspect && world.creatures.find((c) => c.id === inspect.id)) || null;
}

canvas.addEventListener("mousedown", (e) => {
  if (player && player.alive) return; // while playing you see through your own eyes
  const c = creatureAt((e.clientX - view.ox) / view.s, (e.clientY - view.oy) / view.s);
  if (c) startInspect(c);
});

let polling = false;
async function pollInspect() {
  // Remote mode: the brain lives on the server, so ask for it (weights only once; activity 10x a second).
  if (!inspect || polling) return;
  polling = true;
  const id = inspect.id;
  try {
    const wantWeights = !inspect.weights || performance.now() - inspect.weightsAt > 1000; // they change as it learns
    const info = await (await fetch(`${server}/creature/${id}${wantWeights ? "?w" : ""}`)).json();
    if (!inspect || inspect.id !== id) return;
    if (!info.found || info.worldNo !== inspect.worldNo) return stopInspect(); // it died, or the world restarted
    if (info.weights) {
      inspect.weights = info.weights;
      inspect.weightsAt = performance.now();
    }
    inspect.info = info;
  } catch {
    // server busy or gone: try again next time
  } finally {
    polling = false;
  }
}
if (server) setInterval(() => { if (inspect) pollInspect(); }, 100);

function refreshLocalInspect() {
  const c = inspected();
  if (!c) return stopInspect(); // it died
  inspect.info = describeCreature(c, world, false);
  inspect.weights = c.brain.w;
}

function drawBrainPanel() {
  if (!server) refreshLocalInspect();
  if (!inspect || !inspect.info) return;
  const info = inspect.info, c = inspected(), color = c ? c.color : [255, 255, 255];
  const u = view.u, W = Math.min(440 * u, view.w * 0.45), x0 = view.w - W - 12 * u, y0 = 12 * u;
  const H = view.h - y0 - (embed ? 12 : 40) * u;
  panel(x0, y0, W, H);
  let y = y0 + 12 * u;
  text(inspect.label, x0 + 14 * u, y, 17, rgb(color));
  y += 28 * u;
  text(`generation ${info.generation}   ·   kids ${info.kids} / ${info.grandkids ?? 0} / ${info.greatkids ?? 0}   ·   age ${info.age}s of ${info.lifespan}s`, x0 + 14 * u, y, 13);
  y += 22 * u;
  text(`action: ${info.action}${info.action === "forward" ? ` (${info.speed})` : ""}${info.ready ? "   ·   ready to mate" : ""}${info.glowing ? "   ·   glowing" : ""}`, x0 + 14 * u, y, 13);
  y += 22 * u;
  text(`learning gene ${info.learnRate}  ·  learned ${info.learned}  ·  rewards ${info.rewards > 0 ? "+" : ""}${info.rewards}`,
    x0 + 14 * u, y, 12);
  y += 24 * u;
  bar(x0 + 14 * u, y, 160 * u, info.energy / info.maxEnergy, INK(0.95), `energy ${info.energy}`);
  y += 20 * u;
  bar(x0 + 14 * u, y, 160 * u, info.health / info.maxHealth, INK(0.55), `health ${info.health}`);
  y += 30 * u;
  drawNetwork(info, inspect.weights, color, x0, y, W, y0 + H - 30 * u - y);
  text("press any key to exit", x0 + W / 2, y0 + H - 22 * u, 12, "#a8a8a8", "center");
}

function drawNetwork(info, w, color, x0, top, W, height) {
  // Three columns of neurons: senses -> hidden -> outputs. Brightness = how active a neuron is right now;
  // lines = weights (creature color = positive, gray = negative, thicker/brighter = stronger).
  const u = view.u, nH = C.BRAIN_HIDDEN;
  const cols = [x0 + W * 0.42, x0 + W * 0.62, x0 + W * 0.76];
  text("senses", cols[0], top, 11, "#a8a8a8", "center");
  text("hidden", cols[1], top, 11, "#a8a8a8", "center");
  text("actions", cols[2], top, 11, "#a8a8a8", "center");
  const netTop = top + 20 * u, netH = height - 20 * u;
  const rowY = (i, n) => netTop + ((i + 0.5) * netH) / n;
  const r = Math.max(2, Math.min(6 * u, (netH / SENSES) * 0.36));
  if (w) {
    ctx.lineWidth = 1;
    const line = (x1, y1, x2, y2, wt) => {
      const a = Math.min(0.6, Math.abs(wt) * 0.15);
      if (a < 0.03) return;
      ctx.strokeStyle = wt > 0 ? rgb(color, a) : `rgba(150,150,150,${a})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    for (let h = 0; h < nH; h++) {
      for (let k = 0; k < SENSES; k++) line(cols[0], rowY(k, SENSES), cols[1], rowY(h, nH), w[h * (SENSES + 1) + 1 + k]);
    }
    for (let o = 0; o < OUTPUTS; o++) {
      const base = nH * (SENSES + 1) + o * (nH + 1);
      for (let h = 0; h < nH; h++) line(cols[1], rowY(h, nH), cols[2], rowY(o, OUTPUTS), w[base + 1 + h]);
    }
  }
  const node = (x, y, v, highlight) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = highlight ? rgb(color) : v >= 0 ? INK(0.08 + 0.92 * Math.min(1, v)) : `rgba(120,120,120,${0.08 + 0.6 * Math.min(1, -v)})`;
    ctx.fill();
    ctx.strokeStyle = INK(0.45);
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  const fs = Math.max(8, Math.min(11, (netH / SENSES) * 0.8 / u));
  info.senses.forEach((v, k) => {
    node(cols[0], rowY(k, SENSES), v);
    text(SENSE_NAMES[k], cols[0] - r - 6 * u, rowY(k, SENSES) - fs * u * 0.55, fs, "#cfcfcf", "right");
  });
  info.hidden.forEach((v, h) => node(cols[1], rowY(h, nH), v));
  let best = 0;
  for (let k = 1; k < ACTIONS.length; k++) if (info.out[k] > info.out[best]) best = k;
  const scale = Math.max(1e-6, ...info.out.slice(0, ACTIONS.length).map(Math.abs));
  info.out.forEach((v, o) => {
    // Actions: highest score wins. Speed and the two locks are squashed to 0..1; a lock is on above 0.5.
    const extra = o >= ACTIONS.length, val = extra ? 1 / (1 + Math.exp(-v)) : v / scale;
    const lit = extra ? o > ACTIONS.length && val > 0.5 : o === best;
    node(cols[2], rowY(o, OUTPUTS), o > ACTIONS.length ? (lit ? 1 : 0) : val, lit); // a lock dot is dark unless on
    text(OUTPUT_NAMES[o], cols[2] + r + 6 * u, rowY(o, OUTPUTS) - 6 * u, 10, lit ? rgb(color) : "#cfcfcf");
  });
}

// ---------- embedded in a web page: stats go to the page, its button sets the speed ----------

let onScreen = true, reportIn = 0;
if (embed) {
  addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.evo === "speed") nextSpeed();
    if (e.data.evo === "visible") onScreen = !!e.data.on; // no drawing while scrolled away
    reportToPage();
  });
}

function reportToPage() {
  if (!embed || window.parent === window) return;
  const text = serverStatus || `world ${worldNo} · ${world.count("herbivore")} herbivores · ` +
    `${world.count("carnivore")} carnivores · score ${score.herbivore}:${score.carnivore}`;
  window.parent.postMessage({ evo: "stats", text, speed: SPEEDS[speedIdx] }, "*");
}

let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(now - last, 250);
  last = now;
  const dt = 1000 / C.FPS, start = performance.now();
  while (acc >= dt) {
    acc -= dt;
    if (paused || server) continue; // in remote mode the server simulates; we only draw
    for (let k = 0; k < SPEEDS[speedIdx]; k++) {
      if (demo && player && player.alive) demoKeys();
      world.step();
      if (world.won.length) collectLocal();
      const end = world.outcome();
      if (end) restartWorld(end);
    }
    if (performance.now() - start > 30) { // the computer can't keep up with this speed: skip ahead
      acc = 0;
      break;
    }
  }
  if (server) glideCreatures();
  if (onScreen) render();
  if (embed && --reportIn <= 0) {
    reportIn = 15;
    reportToPage();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.game = { get world() { return world; }, get player() { return player; } }; // for poking around in the browser console
