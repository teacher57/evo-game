// Evo game server: runs the world nonstop and streams it to web pages watching it.
//
// Run:   node server.js [port] [address]   e.g. node server.js 8787 100.83.245.27
//        Port defaults to 8787 (or EVO_PORT). With an address (or EVO_HOST) it listens only there,
//        e.g. the machine's Tailscale IP, so other networks can't reach it; without one, everywhere.
// Needs: only Node.js, no npm packages.
//
// It loads the same simulation files the browser uses (../config.js, ../world.js, ../brain.js),
// so the rules are identical. Pages connect with ?server=http://<this machine>:8787 and get:
//   GET  /stream  live world snapshots (Server-Sent Events, about 20 per second)
//   POST /speed   cycle the speed 1x -> 4x -> 16x -> 32x -> 64x (shared by everyone watching)
//   POST /pause   pause or continue the world (shared too; P in the page)
//   POST /walls   walls down the middle of the rivers on or off (shared, kept for later worlds; W in the page)
//   GET  /creature/<id>[?w]  one creature's stats, senses and brain activity (?w: also its weights)
//   POST /savebrain/<id>  save one creature's brain (its genes) as its own entry in the New run menu;
//                 optional body {"name": "..."} (up to 60 characters)
//   GET  /achievements  every achievement, and who won it in this run, when and where (null = not won yet)
//   POST /achievements/reset  start this run's achievements over (the won ones are kept in brains/)
//   GET  /runs    the saved runs (and saved brains) whose brains a new run can start from
//   POST /newrun  start a new run: body {"herbivore": {"mid": source, "sides": source}, "carnivore": ...},
//                 source = "starter" | <run id> | <run id>@mid | <run id>@sides
//   GET  /        a one-line status, handy to check that it's up
//
// A "run" is everything from one New run to the next: many worlds, one score. Each run keeps its
// 20 best brains per species so far (most children, over all its worlds) in brains/<run id>.json,
// saved every 20 s, so a stopped run's brains can start a later run. state.json remembers the
// current run, so restarting the server continues it (rebuilding the current world from its parents).

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");

const PORT = Number(process.argv[2] || process.env.EVO_PORT || 8787);
const HOST = process.argv[3] || process.env.EVO_HOST || undefined;
const GAME = path.join(__dirname, "..");
const STATE_FILE = path.join(__dirname, "state.json");
const ACH_FILE = path.join(__dirname, "achievements.json"); // this run's won achievements (a New run starts them over)
const BRAINS_DIR = path.join(__dirname, "brains");
const SPEEDS = [1, 4, 16, 32, 64];
const SEND_EVERY_MS = 50;     // snapshot rate for watching pages
const SAVE_EVERY_MS = 20_000; // how often the run's best brains and the state are written to disk

// ---------- load the simulation (same files as the browser) ----------

// Don't pass Math in: the sandbox has its own, and calling the outside one from inside is ~60x slower.
const sandbox = vm.createContext({ console });
for (const f of ["config.js", "achievements.js", "world.js", "brain.js"]) {
  vm.runInContext(fs.readFileSync(path.join(GAME, f), "utf8"), sandbox, { filename: f });
}
const [C, World, Hall, Brain, describeCreature, averageLearnRate, upgradeGenes, ACHIEVEMENTS] =
  vm.runInContext("[C, World, Hall, Brain, describeCreature, averageLearnRate, upgradeGenes, ACHIEVEMENTS]", sandbox);
const SPECIES = Object.keys(C.SPECIES);

// ---------- brains on disk ----------

const toJson = (list) => list.map((b) => ({ w: Array.from(b.brain.genes), lr: b.brain.learnRate, kids: b.kids, score: b.score ?? b.kids, mid: b.mid }));

function fromJson(list) {
  // Saved brains -> hall entries (older brain shapes upgraded, see upgradeGenes in brain.js), or null if
  // there are none or a shape is unknown.
  if (!list || !list.length) return null;
  const genes = list.map((b) => upgradeGenes(b.w));
  if (genes.some((g) => !g)) return null;
  return list.map((b, n) => ({ brain: new Brain(genes[n], b.lr), kids: b.kids, score: b.score ?? b.kids, mid: b.mid, n }));
}

function writeJson(file, data) {
  const tmp = file + ".tmp"; // write then rename, so a crash never leaves a half-written file
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const runFile = (id) => path.join(BRAINS_DIR, `${id}.json`);
const validRunId = (id) => typeof id === "string" && /^[0-9_-]+$/.test(id) && fs.existsSync(runFile(id));

// Files saved before "predator" was renamed to "carnivore" still say predator (in keys, sources, names):
// read them with the new word. Only words change; numbers (the weights) can't contain it.
const readSaved = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/predator/g, "carnivore").replace(/Predator/g, "Carnivore"));

function readRun(id) {
  try {
    return readSaved(runFile(id));
  } catch {
    return null;
  }
}

function newRunId() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// ---------- runs and worlds ----------

let run = null;            // { id, started, sources: { herbivore, carnivore } }
let runBest = new Hall();  // the run's best brains from its finished worlds
let world = null, worldNo = 1, speedIdx = 0, lastEnd = null;
let walls = false;  // W in a page: walls down the middle of the rivers, for every world until switched off
let winners = []; // the last few worlds' winners ("herbivore", "carnivore", "tie"), for Comeback

// ---------- achievements: each won once per run (achievements.js), kept in achievements.json ----------
// A New run starts them over; the ending run's are kept in brains/<run id>.achievements.json.

let achieved = {};
try {
  achieved = JSON.parse(fs.readFileSync(ACH_FILE, "utf8"));
} catch {
  // none won yet
}

function makeWorld(parents) {
  const w = new World(C.SEED, parents);
  w.walls = walls;
  w.locked = new Set(ACHIEVEMENTS.map((a) => a.id).filter((id) => !achieved[id])); // still to win
  return w;
}

function unlock(e) {
  if (achieved[e.id]) return;
  achieved[e.id] = { ...e, at: new Date().toISOString(), run: run.id, world: worldNo };
  writeJson(ACH_FILE, achieved);
  const a = ACHIEVEMENTS.find((x) => x.id === e.id);
  console.log(`achievement: ${a ? a.title : e.id}${e.creature ? ` by ${e.species} #${e.creature}` : ""} (world ${worldNo})`);
}

function collectAchievements() {
  for (const e of world.won) unlock(e);
  world.won.length = 0;
}
const score = { herbivore: 0, carnivore: 0 };

function bestSoFar() {
  // The run's best brains including the world running now (living creatures too): highest family
  // score (kids + grandkids + great-grandkids) wins.
  const byBrain = new Map();
  const add = (species, b) => {
    if (b.kids < 1) return;
    const e = byBrain.get(b.brain);
    const score = b.score ?? b.kids;
    if (!e || score > e.score) byBrain.set(b.brain, { species, brain: b.brain, kids: b.kids, score, mid: b.mid });
  };
  for (const c of world.creatures) if (c.alive) world.hall.consider(c);
  world.hall.rank();
  for (const sp of SPECIES) {
    for (const b of runBest.best[sp]) add(sp, b);
    for (const b of world.hall.best[sp]) add(sp, b);
  }
  // Kept per part of the map (middle strip / sides / no part, for brains from before the rivers), so a later
  // run can start each part from that part's brains.
  const h = new Hall();
  for (const sp of SPECIES) {
    const all = [...byBrain.values()].filter((e) => e.species === sp).sort((a, b) => b.score - a.score || b.kids - a.kids);
    h.best[sp] = [true, false, undefined].flatMap((part) => all.filter((e) => e.mid === part).slice(0, C.HALL_SIZE))
      .map((e, n) => ({ brain: e.brain, kids: e.kids, score: e.score, mid: e.mid, n }));
  }
  return h;
}

// Where a part of the map gets its starting brains: "starter", "<run id>" (all that run's brains of the
// species), or "<run id>@mid" / "<run id>@sides" (only the ones from that part of its map).
const PARTS = { mid: true, sides: false };

function validSource(src) {
  if (src === "starter") return true;
  const [id, part] = String(src).split("@");
  return validRunId(id) && (part === undefined || part in PARTS);
}

function loadSource(src, sp) {
  if (src === "starter") return [];
  const [id, part] = src.split("@"), saved = readRun(id), list = (saved && fromJson(saved[sp])) || [];
  return part === undefined ? list : list.filter((e) => e.mid === PARTS[part]);
}

function resetAchievements(why) {
  // Keep the won ones in brains/<run id>.achievements[-<time>].json, then start them over (also in the
  // world running now, so they can be won again right away).
  if (run && Object.keys(achieved).length) {
    fs.mkdirSync(BRAINS_DIR, { recursive: true });
    let file = path.join(BRAINS_DIR, `${run.id}.achievements.json`);
    if (fs.existsSync(file)) file = path.join(BRAINS_DIR, `${run.id}.achievements-${newRunId()}.json`);
    writeJson(file, achieved);
  }
  achieved = {};
  writeJson(ACH_FILE, achieved);
  if (world) world.locked = new Set(ACHIEVEMENTS.map((a) => a.id));
  console.log(`achievements reset (${why})`);
}

function startRun(sources) {
  resetAchievements("new run");
  // A fresh run: world 1, score 0:0. sources[species] = { mid: source, sides: source } (or one source for
  // both): each part of the map starts from the brains you picked for it, and they're born there.
  const parents = new Hall();
  for (const sp of SPECIES) {
    const pick = typeof sources[sp] === "string" ? { mid: sources[sp], sides: sources[sp] } : sources[sp];
    sources[sp] = pick;
    parents.best[sp] = Object.entries(PARTS).flatMap(([part, mid]) =>
      loadSource(pick[part], sp).map((e) => ({ ...e, mid }))); // born in the part you picked for them
    parents.best[sp].forEach((e, n) => { e.n = n; });
  }
  run = { id: newRunId(), started: new Date().toISOString(), sources };
  runBest = new Hall();
  worldNo = 1;
  score.herbivore = score.carnivore = 0;
  winners = [];
  lastEnd = null;
  world = makeWorld(parents);
  saveState();
  console.log(`new run ${run.id}: ${SPECIES.map((sp) => `${sp}s middle from ${sources[sp].mid}, sides from ${sources[sp].sides}`).join("; ")}`);
}

function resume() {
  // Continue the run from state.json (rebuilding its current world from that world's parents).
  let s = null;
  try {
    s = readSaved(STATE_FILE);
  } catch {
    return startRun({ herbivore: "starter", carnivore: "starter" });
  }
  worldNo = s.worldNo || 1;
  Object.assign(score, s.score);
  lastEnd = s.lastEnd || null;
  winners = s.winners || [];
  walls = !!s.walls;
  run = s.run || { id: newRunId(), started: new Date().toISOString(), sources: { herbivore: "starter", carnivore: "starter" } };
  const parents = new Hall(), saved = readRun(run.id);
  for (const sp of SPECIES) {
    const list = fromJson((s.parents || s.hall || {})[sp]); // (s.hall: state files from before runs existed)
    if (list) parents.best[sp] = list;
    const best = saved && fromJson(saved[sp]);
    if (best) runBest.best[sp] = best;
  }
  world = makeWorld(parents);
  console.log(`continuing run ${run.id}: world ${worldNo}, score ${score.herbivore}:${score.carnivore}`);
}

function saveState() {
  fs.mkdirSync(BRAINS_DIR, { recursive: true });
  const best = bestSoFar();
  writeJson(runFile(run.id), {
    id: run.id, started: run.started, saved: new Date().toISOString(), sources: run.sources, worlds: worldNo, score,
    herbivore: toJson(best.best.herbivore), carnivore: toJson(best.best.carnivore),
  });
  writeJson(STATE_FILE, {
    run, worldNo, score, lastEnd, winners, walls,
    parents: { herbivore: toJson(world.parents.best.herbivore), carnivore: toJson(world.parents.best.carnivore) },
  });
}

function restartWorld(end) {
  // Same rule as the browser: the other species wins (or a tie: +0.5 each), and the new world breeds from
  // the last world's top brains, each part of the map from its own.
  for (const c of world.creatures) world.hall.consider(c);
  world.hall.rank();
  runBest = bestSoFar(); // keep this world's best for the run before it's gone
  const winner = end === "tie" ? "tie" : end === "herbivore" ? "carnivore" : "herbivore";
  if (winner === "tie") score.herbivore += 0.5, score.carnivore += 0.5;
  else score[winner]++;
  lastEnd = { worldNo, winner, seconds: Math.floor(world.tick / C.FPS) };
  collectAchievements();
  if (winner === "tie") unlock({ id: "stalemate", species: null, creature: null, mid: null });
  const last5 = winners.slice(-5), loser = winner === "herbivore" ? "carnivore" : "herbivore";
  if (winner !== "tie" && last5.length === 5 && last5.every((w) => w === loser)) {
    unlock({ id: "comeback", species: winner, creature: null, mid: null });
  }
  winners = [...winners, winner].slice(-10);
  console.log(`world ${worldNo}: ${winner === "tie" ? "a tie" : winner + "s won"} after ${lastEnd.seconds}s, score ${score.herbivore}:${score.carnivore}`);
  worldNo++;
  world = makeWorld(world.hall);
  saveState();
}

resume();

// ---------- simulation loop: 30 ticks/s x speed, in short slices ----------
// Each slice simulates for at most SLICE_MS and then gives the server time to send snapshots and answer
// pages. If the machine can't keep up with the chosen speed, it runs as fast as it can (realSpeed says how
// fast that is) instead of starving everything else.

const SLICE_MS = 10; // short slices keep snapshots flowing evenly (~20/s) even when the CPU is slow
let lastLoop = Date.now(), owed = 0, ticksThisSecond = 0, realSpeed = 1;
let paused = false; // P in any watching page pauses the world for everyone
function simulate() {
  const start = Date.now(), speed = SPEEDS[speedIdx];
  owed = paused ? 0 : owed + ((start - lastLoop) / 1000) * C.FPS * speed;
  lastLoop = start;
  while (owed >= 1 && Date.now() - start < SLICE_MS) {
    world.step();
    if (world.won.length) collectAchievements();
    owed--;
    ticksThisSecond++;
    const end = world.outcome();
    if (end) restartWorld(end);
  }
  owed = Math.min(owed, C.FPS * speed); // never pile up more than a second of catching up
  // Behind: continue right after pending I/O (setImmediate; on Windows even setTimeout(1) waits ~15 ms).
  if (owed >= 1) setImmediate(simulate);
  else setTimeout(simulate, 5);
}
simulate();
setInterval(() => {
  realSpeed = ticksThisSecond / C.FPS;
  ticksThisSecond = 0;
}, 1000);

setInterval(saveState, SAVE_EVERY_MS);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    saveState();
    process.exit(0);
  });
}

// ---------- snapshots: compact numbers, so 20 per second stay small ----------

function snapshot() {
  const cr = []; // per creature: species (0 herbivore, 1 carnivore), x, y, angle*100, r, g, b, glow, id
  for (const c of world.creatures) {
    cr.push(c.species === "herbivore" ? 0 : 1, Math.round(c.x), Math.round(c.y), Math.round(c.angle * 100),
      c.color[0], c.color[1], c.color[2], c.glow, c.id);
  }
  const co = []; // per corpse: x, y, meat
  for (const k of world.corpses) co.push(Math.round(k.x), Math.round(k.y), Math.round(k.meat));
  const grass = Buffer.from(Uint8Array.from(world.grass, (g) => Math.round((g / C.GRASS_MAX) * 255))).toString("base64");
  return JSON.stringify({
    tick: world.tick, worldNo, score, lastEnd, speed: SPEEDS[speedIdx], realSpeed, paused, run: run.id,
    achN: Object.keys(achieved).length, walls,
    cols: world.gcols, rows: world.grows, grass, cr, co, hist: world.history.slice(-400),
    lr: { herbivore: averageLearnRate(world, "herbivore"), carnivore: averageLearnRate(world, "carnivore") },
  });
}

function listRuns() {
  // Saved runs, newest first, with what a New run menu needs to show and whether their brains still fit.
  let files = [];
  try {
    files = fs.readdirSync(BRAINS_DIR).filter((f) => /^[0-9_-]+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => readRun(f.slice(0, -5))).filter(Boolean).map((r) => {
    const info = { id: r.id, name: r.name, about: r.about, started: r.started, saved: r.saved, worlds: r.worlds, score: r.score, current: r.id === run.id };
    for (const sp of SPECIES) {
      const list = r[sp] || [];
      info[sp] = { brains: list.length, bestKids: list.length ? (list[0].score ?? list[0].kids) : 0, fits: list.every((b) => upgradeGenes(b.w) !== null),
        mid: list.filter((b) => b.mid === true).length, sides: list.filter((b) => b.mid === false).length };
    }
    return info;
  }).sort((a, b) => (a.id < b.id ? 1 : -1));
}

// ---------- HTTP: live stream, speed button, brains, runs, status ----------

const watchers = new Set();
setInterval(() => {
  if (watchers.size === 0) return;
  const msg = `data: ${snapshot()}\n\n`;
  for (const res of watchers) res.write(msg);
}, SEND_EVERY_MS);

function json(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // pages may be opened from a file or another site
  if (req.method === "GET" && req.url === "/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${snapshot()}\n\n`);
    watchers.add(res);
    req.on("close", () => watchers.delete(res));
  } else if (req.method === "GET" && req.url.startsWith("/creature/")) {
    const url = new URL(req.url, "http://server");
    const id = Number(url.pathname.split("/")[2]);
    const c = world.creatures.find((o) => o.id === id && o.alive && !o.isPlayer);
    json(res, c ? { ...describeCreature(c, world, url.searchParams.has("w")), worldNo } : { found: false, worldNo });
  } else if (req.method === "POST" && req.url.startsWith("/savebrain/")) {
    // The focused creature's brain, saved like a run with one brain for its species, so New run can
    // start that species from it. Saves the genes (what children inherit), not what it learned in life.
    const id = Number(req.url.split("/")[2]);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2000) req.destroy(); // a name is tiny
    });
    req.on("end", () => {
      const c = world.creatures.find((o) => o.id === id && o.alive && !o.isPlayer);
      if (!c) return json(res, { saved: false });
      let given = "";
      try {
        given = String(JSON.parse(body || "{}").name || "");
      } catch {
        // no name: use the default below
      }
      given = given.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60); // your name for it, plain text
      const about = `${c.spec.label} #${c.id}, world ${worldNo}, ${c.kids} kids`;
      const name = given || about;
      let file = newRunId();
      for (let n = 2; fs.existsSync(runFile(file)); n++) file = `${newRunId()}-${n}`;
      fs.mkdirSync(BRAINS_DIR, { recursive: true });
      writeJson(runFile(file), {
        id: file, name, about, saved: new Date().toISOString(), sources: { [c.species]: `creature #${c.id} of run ${run.id}` },
        worlds: 0, score: { herbivore: 0, carnivore: 0 },
        herbivore: [], carnivore: [],
        [c.species]: toJson([{ brain: c.brain, kids: c.kids, mid: world.rivers.length ? c.x > world.midL && c.x < world.midR : undefined }]),
      });
      console.log(`saved brain: ${name} (${about}) -> brains/${file}.json`);
      json(res, { saved: true, id: file, name });
    });
  } else if (req.method === "POST" && req.url === "/speed") {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    json(res, { speed: SPEEDS[speedIdx] });
  } else if (req.method === "POST" && req.url === "/walls") {
    walls = !walls;
    world.walls = walls;
    saveState();
    json(res, { walls });
  } else if (req.method === "POST" && req.url === "/pause") {
    paused = !paused;
    json(res, { paused });
  } else if (req.method === "POST" && req.url === "/achievements/reset") {
    resetAchievements("reset button");
    json(res, { ok: true });
  } else if (req.method === "GET" && req.url === "/achievements") {
    json(res, ACHIEVEMENTS.map((a) => ({ ...a, won: achieved[a.id] || null })));
  } else if (req.method === "GET" && req.url === "/runs") {
    saveState(); // so the current run in the list is up to date
    json(res, listRuns());
  } else if (req.method === "POST" && req.url === "/newrun") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy(); // a choice is tiny; refuse anything big
    });
    req.on("end", () => {
      let choice = null;
      try {
        choice = JSON.parse(body);
      } catch {
        // falls through to the check below
      }
      // Per species either one source, or { mid, sides }: one source for each part of the map.
      const okPick = (p) => (typeof p === "string" ? validSource(p) : p && validSource(p.mid) && validSource(p.sides));
      const ok = choice && SPECIES.every((sp) => okPick(choice[sp]));
      if (!ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "pick \"starter\" or a saved run (id, id@mid, id@sides) per species and part" }));
      }
      saveState(); // the run that's ending keeps its final brains
      const copy = (p) => (typeof p === "string" ? p : { mid: p.mid, sides: p.sides });
      startRun({ herbivore: copy(choice.herbivore), carnivore: copy(choice.carnivore) });
      json(res, { ok: true, run: run.id });
    });
  } else if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`evo game server: run ${run.id}, world ${worldNo}, tick ${world.tick}, ${world.count("herbivore")} herbivores, ` +
      `${world.count("carnivore")} carnivores, score ${score.herbivore}:${score.carnivore}, ` +
      `${paused ? "PAUSED, " : ""}speed ${SPEEDS[speedIdx]}x (really ${realSpeed.toFixed(1)}x), ${watchers.size} watching\n`);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// At boot the Tailscale address may not exist yet: keep retrying instead of crashing.
httpServer.on("error", (err) => {
  if (err.code !== "EADDRNOTAVAIL" && err.code !== "EADDRINUSE") throw err;
  console.log(`can't listen on ${HOST || "*"}:${PORT} yet (${err.code}), retrying in 10 s`);
  setTimeout(listen, 10_000);
});
function listen() {
  httpServer.listen(PORT, HOST, () => console.log(`evo game server on ${HOST || "all addresses"}, port ${PORT}`));
}
listen();
