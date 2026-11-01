// World simulation: grass, creatures, corpses and the rules of every action.
//
// Every creature has a `controller` with `act(me, world) -> [action, speed]`, where action is one
// of ACTIONS and speed only matters for "forward". Neural-network brains (brain.js) and the keyboard
// player both plug in through that same interface and follow the same rules.
// Every creature also carries a `brain` (the player's is only used for breeding).

const ACTIONS = ["left", "right", "forward", "eat", "attack", "mate"];

function makeRng(seed) {
  // mulberry32: small seeded PRNG, so a world can be replayed with the same seed
  let a = (seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random,
    uniform: (lo, hi) => lo + (hi - lo) * random(),
    randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    gauss: (mu, sigma) => {
      let u = 0;
      while (u === 0) u = random();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
    },
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

const mod = (v, n) => ((v % n) + n) % n;

function riverBands() {
  // Two vertical rivers, each RIVER_TILES grass tiles wide and on the tile grid, splitting the world into
  // 3 strips: the middle strip has as many tiles as the two side strips together (the sides also meet
  // through the left-right wrap-around). With 48 tiles and 4-tile rivers: sides 10 + 10, middle 20.
  // Returns [[from, to], [from, to]] in x, or [] without rivers.
  const t = C.RIVER_TILES, T = C.GRASS_CELL, cols = Math.floor(C.WORLD_W / T);
  if (!t) return [];
  const land = cols - 2 * t, middle = Math.floor(land / 2), left = Math.floor((land - middle) / 2);
  const a = left * T, b = (left + t + middle) * T;
  return [[a, a + t * T], [b, b + t * T]];
}

function inMiddle(x) {
  // Whether x is in the middle strip (between the rivers); always false without rivers.
  const r = riverBands();
  return r.length > 0 && x > r[0][1] && x < r[1][0];
}

function wrapDelta(d, size) {
  // Shortest signed distance along the wrap-around (left-right) axis (d is within one world width).
  const half = size / 2;
  return d > half ? d - size : d < -half ? d + size : d;
}

function wrapAngle(a) {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

const clampChannel = (v) => Math.max(0, Math.min(255, Math.round(v)));

class Creature {
  constructor(fields) {
    Object.assign(this, {
      isPlayer: false, generation: 0, mateCooldown: 0, age: 0, glowTicks: 0, alive: true, deathCause: "", kids: 0,
      grandkids: 0, greatkids: 0, parents: [], // family, for ranking the top brains (see Hall in brain.js)
      eaten: 0, // energy it got from eating in its life (grass or meat), also for ranking the top brains
      // for achievements (achievements.js): where it was born / last stood on dry land, rivers crossed,
      // herbivores killed, when it was last bitten, since when each lock is on
      bornMid: false, drySide: false, crossings: 0, herbKills: 0, bittenAt: 0, lockSince: { herb: 0, pred: 0 },
      lastAction: "forward", lastSpeed: 0, glow: 0, swim: false, // swim: the brain's swim output is on
      reward: 0, rewardSum: 0, rewardAvg: 0, // collected during a tick, learned from at the creature's next think
      locked: { herb: 0, pred: 0 }, targets: { herb: null, pred: null }, // see the locks in sense(), brain.js
    }, fields);
  }

  get spec() {
    return C.SPECIES[this.species];
  }
}

class World {
  constructor(seed = C.SEED, parents = new Hall()) {
    // `parents`: the top brains of the previous world, which this world's creatures are bred from.
    // `hall`: this world's own top brains, collected as it runs, for the next world.
    this.hall = new Hall();
    this.parents = parents;
    this.rng = makeRng(seed);
    this.w = C.WORLD_W;
    this.h = C.WORLD_H;
    this.gcols = Math.floor(this.w / C.GRASS_CELL);
    this.grows = Math.floor(this.h / C.GRASS_CELL);
    this.bcols = Math.ceil(this.w / C.BUCKET);
    this.brows = Math.ceil(this.h / C.BUCKET);
    this.grass = new Float32Array(this.gcols * this.grows); // index = row * gcols + col
    for (let i = 0; i < this.grass.length; i++) {
      this.grass[i] = this.rng.random() < C.GRASS_START_FRACTION ? this.rng.random() * C.GRASS_MAX : 0;
    }
    // Rivers: nobody can cross them, nothing grows in them, and nobody senses anything on the other side
    // (it's out of reach anyway). midL..midR is the middle strip.
    this.walls = false; // W: a wall down the middle of each river, so nobody can cross at all (set by the runner)
    this.locked = new Set(); // achievements still to win (set by the runner), and the ones just won
    this.won = [];
    this.rivers = riverBands();
    this.midL = this.rivers.length ? this.rivers[0][1] : -1;
    this.midR = this.rivers.length ? this.rivers[1][0] : -1;
    this.water = new Uint8Array(this.grass.length); // 1 = grass square in a river
    for (const [a, b] of this.rivers) {
      for (let i = 0; i < this.gcols; i++) {
        const cx = (i + 0.5) * C.GRASS_CELL;
        if (cx > a && cx < b) for (let j = 0; j < this.grows; j++) this.water[j * this.gcols + i] = 1;
      }
    }
    for (let i = 0; i < this.grass.length; i++) if (this.water[i]) this.grass[i] = 0;
    // Per grass column: 1 = in the middle strip, 2 = river, 0 = a side strip (for bestGrassNear).
    this.colSide = Uint8Array.from({ length: this.gcols }, (_, i) => {
      const cx = (i + 0.5) * C.GRASS_CELL;
      return this.water[i] ? 2 : cx > this.midL && cx < this.midR ? 1 : 0;
    });
    this.creatures = [];
    this.lastId = 0; // every creature gets an id (per world), so a page can follow one
    this.corpses = [];
    this.tick = 0;
    this.history = []; // [herbivores, carnivores] every HISTORY_EVERY ticks
    this.stats = {};
    // Spatial grids: one array of things per BUCKET square (index = row * bcols + col), reused every tick.
    this.grid = Array.from({ length: this.bcols * this.brows }, () => []);
    this.corpseGrid = Array.from({ length: this.bcols * this.brows }, () => []);
    this.glowGrid = Array.from({ length: this.bcols * this.brows }, () => []); // creatures glowing at tick start
    this.glowing = [];
    this.grassPrev = new Float32Array(this.grass.length);
    this.byId = new Map(); // id -> living creature (rebuilt every tick)
    this.meatOnSquare = new Float32Array(this.grass.length);
    this.corpsesOnSquare = new Map(); // grass square -> corpses lying on it (rebuilt every tick)
    for (const [species, s] of Object.entries(C.SPECIES)) {
      // The first world starts from the hand-wired starter brain; later ones from the last world's top brains.
      // With rivers, startPerSide are born in the middle strip and startPerSide on the sides, each bred from
      // the top brains of that same part of the map (where they were when they died, or when the world ended).
      if (this.rivers.length) {
        for (const mid of [true, false]) {
          for (let i = 0; i < s.startPerSide; i++) {
            this.spawnWithBrain(species, parents.newChild(species, this.rng, mid).brain, { x: this.xIn(mid, s.radius) });
          }
        }
      } else {
        for (let i = 0; i < 2 * s.startPerSide; i++) this.spawnWithBrain(species, parents.newBrain(species, this.rng));
      }
    }
  }

  stat(key) {
    this.stats[key] = (this.stats[key] || 0) + 1;
  }

  // ---------- spawning ----------

  spawn(species, controller, brain, { x, y, energy, isPlayer = false, generation = 0 } = {}) {
    const s = C.SPECIES[species];
    const c = new Creature({
      id: ++this.lastId,
      species,
      x: this.outOfRiver(mod(x ?? this.rng.uniform(0, this.w), this.w), s.radius, x),
      y: World.inside(y ?? this.rng.uniform(0, this.h), s.radius, this.h),
      angle: this.rng.uniform(-Math.PI, Math.PI),
      energy: energy ?? s.maxEnergy * 0.7,
      health: s.maxHealth,
      color: brainColor(brain, species),
      controller,
      brain,
      isPlayer,
      generation,
      mateCooldown: Math.floor(s.mateCooldown / 2),
      lifespan: Math.round(this.rng.uniform(s.lifespan[0], s.lifespan[1]) * C.FPS), // ticks until old age
    });
    c.bornMid = c.drySide = inMiddle(c.x);
    this.creatures.push(c);
    if (c.generation >= 50) this.achieve("gen50", c);
    return c;
  }

  spawnWithBrain(species, brain, opts) {
    // A species with a fixed learnRate (config) gets exactly that, whatever its parents had: it doesn't evolve.
    const fixed = C.SPECIES[species].learnRate;
    if (fixed > 0) brain.learnRate = fixed;
    return this.spawn(species, new BrainController(brain), brain, opts);
  }

  outcome() {
    // How the world stands: null while it goes on, the name of a species that died out everywhere, or
    // "tie" when the rivers keep them apart for good: herbivores only on one side, carnivores only on the other.
    let hm = 0, hs = 0, pm = 0, ps = 0;
    for (const c of this.creatures) {
      if (!c.alive) continue;
      const mid = c.x > this.midL && c.x < this.midR;
      if (c.species === "herbivore") mid ? hm++ : hs++;
      else mid ? pm++ : ps++;
    }
    if (hm + hs === 0) return "herbivore";
    if (pm + ps === 0) return "carnivore";
    if (this.rivers.length && ((hm && !hs && ps && !pm) || (hs && !hm && pm && !ps))) return "tie";
    return null;
  }

  count(species) {
    let n = 0;
    for (const c of this.creatures) if (c.alive && c.species === species) n++;
    return n;
  }

  // ---------- geometry & queries ----------

  // The world wraps left-right (leave on the left, come back on the right); walls are only top and bottom.

  static inside(v, radius, size) {
    // Clamp a y coordinate so a body of `radius` stays between the top and bottom walls.
    return Math.min(Math.max(v, C.WALL + radius), size - C.WALL - radius);
  }

  offset(me, x, y) {
    const dx = wrapDelta(x - me.x, this.w), dy = y - me.y;
    return [dx, dy, Math.hypot(dx, dy)];
  }

  bucket(x, y) {
    const bx = mod(Math.floor(x / C.BUCKET), this.bcols);
    const by = Math.min(Math.floor(y / C.BUCKET), this.brows - 1);
    return [bx, by];
  }

  xIn(mid, radius) {
    // A random x in the middle strip, or in the side strips (which meet through the wrap-around).
    if (mid) return this.rng.uniform(this.midL + radius, this.midR - radius);
    // sides: from the right river's far bank, around the wrap, to the left river's near bank
    return mod(this.rng.uniform(this.rivers[1][1] + radius, this.rivers[0][0] + this.w - radius), this.w);
  }

  stopAtWall(x, fromX, radius) {
    // A wall (RIVER_WALL px thick) runs down the middle of each river: a body moving from fromX to x stops at it.
    const half = C.RIVER_WALL / 2;
    for (const [a, b] of this.rivers) {
      const wx = (a + b) / 2;
      if (fromX <= wx && x + radius > wx - half) return wx - half - radius;
      if (fromX > wx && x - radius < wx + half) return wx + half + radius;
    }
    return x;
  }

  onSide(x, radius, mid) {
    // Keep a body at x out of the water, on the bank of its own side (`mid`: middle strip or sides), e.g. for
    // a baby whose parent is swimming: it's born on the parent's side, never on the far bank.
    if (!this.rivers.length) return x;
    const [left, right] = this.rivers;
    if (x + radius > left[0] && x - radius < left[1]) return mid ? left[1] + radius : left[0] - radius;
    if (x + radius > right[0] && x - radius < right[1]) return mid ? right[0] - radius : right[1] + radius;
    return x;
  }

  outOfRiver(x, radius, fromX = x) {
    // A body of `radius` at x may not overlap a river: push it out to the side `fromX` is on.
    for (const [a, b] of this.rivers) {
      if (x + radius > a && x - radius < b) return fromX < (a + b) / 2 ? a - radius : b + radius;
    }
    return x;
  }

  achieve(id, c = null) {
    // Report an achievement (each id at most once per world; whoever runs the world keeps them forever and
    // sets `locked` to the ones nobody has won yet). The runner reads and empties `won` after each step.
    if (!this.locked.has(id)) return;
    this.locked.delete(id);
    this.won.push({ id, species: c ? c.species : null, creature: c ? c.id : null, mid: c ? c.drySide : null });
  }

  inWater(x, radius) {
    // Whether a body of `radius` at x overlaps a river.
    for (const [a, b] of this.rivers) if (x + radius > a && x - radius < b) return true;
    return false;
  }

  nearestWater(me) {
    // The nearest river: { d: distance from my body's edge to the water (0 = touching or in it),
    // dx: which way it is (+ right, - left) }, or null without rivers.
    let best = null;
    for (const [a, b] of this.rivers) {
      const toA = wrapDelta(a - me.x, this.w), toB = wrapDelta(b - me.x, this.w);
      let d, dx;
      if (toA <= 0 && toB >= 0) { d = 0; dx = Math.abs(toA) < Math.abs(toB) ? toA : toB; } // in it
      else if (toA > 0) { d = toA; dx = toA; }
      else { d = -toB; dx = toB; }
      d = Math.max(0, d - me.spec.radius);
      if (!best || d < best.d) best = { d, dx };
    }
    return best;
  }

  waterAchievements(c, wasWet) {
    // After a step: into the water (swimmer), or out of it on the other bank (crossed, round trip).
    const wet = this.inWater(c.x, c.spec.radius);
    if (wet && !wasWet) this.achieve("swimmer", c);
    if (!wet && wasWet) {
      const side = inMiddle(c.x);
      if (side !== c.drySide) {
        c.crossings++;
        this.achieve(c.species === "carnivore" ? "crossedCarnivore" : "crossedHerbivore", c);
        if (c.crossings >= 2 && side === c.bornMid) this.achieve("roundTrip", c);
      }
      c.drySide = side;
    }
  }

  sameSide(x1, x2) {
    // Whether two x positions are on the same side of the rivers (always true without rivers).
    const L = this.midL, R = this.midR;
    return (x1 > L && x1 < R) === (x2 > L && x2 < R);
  }

  bucketIndex(x, y) {
    const bx = mod(Math.floor(x / C.BUCKET), this.bcols);
    const by = Math.min(Math.floor(y / C.BUCKET), this.brows - 1);
    return by * this.bcols + bx;
  }

  rebuildGrid() {
    for (const list of this.grid) list.length = 0;
    for (const list of this.glowGrid) list.length = 0;
    this.glowing = [];
    this.byId.clear();
    for (const c of this.creatures) {
      if (!c.alive) continue;
      this.byId.set(c.id, c);
      const b = this.bucketIndex(c.x, c.y);
      this.grid[b].push(c);
      if (c.glow > 0) {
        this.glowing.push(c);
        this.glowGrid[b].push(c);
      }
    }
    for (const list of this.corpseGrid) list.length = 0;
    for (const k of this.corpses) this.corpseGrid[this.bucketIndex(k.x, k.y)].push(k);
  }

  nearbyBuckets(x, y, radius) {
    // Bucket indexes within `radius` of [x, y], in a fixed order (rows top to bottom, columns
    // left to right). Columns wrap around; a column is never visited twice. Reuses one array.
    const r = Math.floor(radius / C.BUCKET) + 1, cols = this.bcols;
    const bx = mod(Math.floor(x / C.BUCKET), cols);
    const by = Math.min(Math.floor(y / C.BUCKET), this.brows - 1);
    const span = Math.min(cols, 2 * r + 1);
    const out = this.bucketList || (this.bucketList = []);
    out.length = 0;
    const j1 = Math.min(this.brows, by + r + 1);
    for (let j = Math.max(0, by - r); j < j1; j++) {
      let i = mod(bx - r, cols);
      for (let k = 0; k < span; k++) {
        out.push(j * cols + i);
        if (++i === cols) i = 0;
      }
    }
    return out;
  }

  forEachNearby(x, y, radius, fn, grid = this.grid) {
    for (const b of this.nearbyBuckets(x, y, radius)) for (const o of grid[b]) fn(o);
  }

  nearest(me, radius, fov = null, filt = null) {
    // Closest living creature within radius (all-around vision; `fov` is only used for the attack arc).
    let best = null, bestD = radius;
    this.forEachNearby(me.x, me.y, radius, (o) => {
      if (o === me || !o.alive || (filt && !filt(o))) return;
      const [dx, dy, d] = this.offset(me, o.x, o.y);
      if (d > bestD) return;
      if (fov !== null && d > 1e-6 && Math.abs(wrapAngle(Math.atan2(dy, dx) - me.angle)) > fov / 2) return;
      best = o;
      bestD = d;
    });
    return [best, bestD];
  }

  seen(me, filt) {
    // Closest creature `me` can see: anything inside its vision radius, plus glowing creatures
    // up to GLOW_RANGE away.
    let [best, bestD] = this.nearest(me, me.spec.visionRange, null, filt);
    if (!best) bestD = Infinity;
    for (const o of this.glowing) {
      if (o === me || !o.alive || !filt(o)) continue;
      const d = this.offset(me, o.x, o.y)[2];
      if (d < bestD && d <= C.GLOW_RANGE) {
        best = o;
        bestD = d;
      }
    }
    return [best, bestD];
  }

  nearestCorpse(me, radius) {
    // Corpses are bucketed once per tick; ones created during this tick are found from the next tick.
    let best = null, bestD = radius;
    const W = this.w, grid = this.corpseGrid;
    for (const b of this.nearbyBuckets(me.x, me.y, radius)) {
      for (const k of grid[b]) {
        if (k.meat <= 0 || !this.sameSide(k.x, me.x)) continue;
        const d = Math.hypot(wrapDelta(k.x - me.x, W), k.y - me.y);
        if (d <= bestD) {
          best = k;
          bestD = d;
        }
      }
    }
    return [best, bestD];
  }

  look(me, out) {
    // One pass over everything `me` can see (vision radius + far glows): nearest herbivore,
    // nearest carnivore, and nearest glowing creature of its own species. Same rules as seen().
    out.herb = out.pred = out.mate = null;
    out.herbD = out.predD = out.mateD = Infinity;
    // Plain loops and local variables, no callbacks: this runs for every pair of creatures that
    // can see each other, and it was most of the time of a tick.
    const vision = me.spec.visionRange, W = this.w, half = W / 2, mx = me.x, my = me.y, mine = me.species;
    let herb = null, herbD = Infinity, pred = null, predD = Infinity, mate = null, mateD = Infinity;
    const grid = this.grid, L = this.midL, R = this.midR, myMid = mx > L && mx < R;
    for (const b of this.nearbyBuckets(mx, my, vision)) {
      for (const o of grid[b]) {
        if (o === me || !o.alive || (o.x > L && o.x < R) !== myMid) continue; // nothing across a river
        let dx = o.x - mx;
        dx = dx > half ? dx - W : dx < -half ? dx + W : dx; // wrapDelta, inlined
        const dy = o.y - my, d = Math.sqrt(dx * dx + dy * dy);
        if (d > vision) continue;
        if (o.species === "herbivore") { if (d < herbD) { herb = o; herbD = d; } }
        else if (d < predD) { pred = o; predD = d; }
        if (o.glow > 0 && o.species === mine && d < mateD) { mate = o; mateD = d; }
      }
    }
    // Far glows: only the glow-grid buckets within GLOW_RANGE (the bucket search keeps one bucket
    // of margin, more than anyone moves in a tick, so nobody in range is missed).
    const G = C.GLOW_RANGE, G2 = G * G, V2 = vision * vision, glowGrid = this.glowGrid;
    for (const b of this.nearbyBuckets(mx, my, G)) for (const o of glowGrid[b]) {
      if (o === me || !o.alive || (o.x > L && o.x < R) !== myMid) continue;
      const dy = o.y - my;
      if (dy > G || dy < -G) continue; // cheap reject before any multiplication
      let dx = o.x - mx;
      dx = dx > half ? dx - W : dx < -half ? dx + W : dx;
      if (dx > G || dx < -G) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 <= V2 || d2 > G2) continue;
      const d = Math.sqrt(d2);
      if (o.species === "herbivore") { if (d < herbD) { herb = o; herbD = d; } }
      else if (d < predD) { pred = o; predD = d; }
      if (o.glow > 0 && o.species === mine && d < mateD) { mate = o; mateD = d; }
    }
    out.herb = herb; out.herbD = herbD;
    out.pred = pred; out.predD = predD;
    out.mate = mate; out.mateD = mateD;
    return out;
  }

  inFront(me, o, arc = C.ATTACK_ARC) {
    const [dx, dy, d] = this.offset(me, o.x, o.y);
    return d < 1e-6 || Math.abs(wrapAngle(Math.atan2(dy, dx) - me.angle)) <= arc / 2;
  }

  attackReach(a, b) { return a.spec.radius + b.spec.radius + C.ATTACK_REACH; }
  mateReach(a, b) { return a.spec.radius + b.spec.radius + C.MATE_REACH; }
  eatReach(me) { return me.spec.radius + C.EAT_REACH; }

  readyToMate(c) {
    return c.alive && c.mateCooldown === 0 && c.energy >= c.spec.mateEnergy;
  }

  gcell(x, y) {
    const i = mod(Math.floor(x / C.GRASS_CELL), this.gcols);
    const j = Math.min(Math.floor(y / C.GRASS_CELL), this.grows - 1);
    return [i, j];
  }

  grassAt(x, y) {
    const [i, j] = this.gcell(x, y);
    return this.grass[j * this.gcols + i];
  }

  bestGrassNear(x, y, k = 3) {
    // Center [x, y] and amount of the best grass square within k squares.
    // "Best" = grass minus distance, so a near good patch beats a far perfect one
    // (plain argmax picks far corners, and the target keeps moving as the window shifts).
    const [i, j] = this.gcell(x, y), cols = this.gcols, n = 2 * k + 1;
    if (!this.distPenalty || this.distPenalty.k !== k) { // distance cost per offset, computed once
      this.distPenalty = { k, t: Float32Array.from({ length: n * n }, (_, q) => Math.hypot((q % n) - k, Math.floor(q / n) - k) * C.GRASS_MAX / 10) };
    }
    const pen = this.distPenalty.t, side = this.colSide, mine = x > this.midL && x < this.midR ? 1 : 0;
    let bi = i, bj = j, bestScore = -Infinity;
    for (let jj = Math.max(0, j - k); jj < Math.min(this.grows, j + k + 1); jj++) {
      const row = jj * cols, prow = (jj - j + k) * n;
      for (let di = -k; di <= k; di++) {
        let ii = i + di;
        if (ii < 0) ii += cols; else if (ii >= cols) ii -= cols;
        if (side[ii] !== mine) continue; // river, or across it
        const score = this.grass[row + ii] - pen[prow + di + k];
        if (score > bestScore) {
          bestScore = score;
          bi = ii;
          bj = jj;
        }
      }
    }
    return [(bi + 0.5) * C.GRASS_CELL, (bj + 0.5) * C.GRASS_CELL, this.grass[bj * cols + bi]];
  }

  // ---------- simulation ----------

  step() {
    this.tick++;
    if (this.tick === 10 * 60 * C.FPS) this.achieve("endurance");
    this.rebuildGrid();
    const order = this.rng.shuffle(this.creatures.filter((c) => c.alive));
    for (const c of order) {
      if (!c.alive) continue;
      const [action, speed] = c.controller.act(c, this);
      this.apply(c, action, speed);
    }
    for (const c of order) if (c.alive) this.upkeep(c);
    this.cleanup();
    this.growGrass();
    this.meatOnSquare.fill(0);
    this.corpsesOnSquare.clear();
    for (const k of this.corpses) {
      // Rotting meat fertilizes its square: it becomes grass there (1 meat -> CORPSE_TO_GRASS grass),
      // and the meat speeds up growth on that square (paid for with more meat in growGrass()).
      const [i, j] = this.gcell(k.x, k.y), idx = j * this.gcols + i;
      const rot = Math.min(C.CORPSE_DECAY, k.meat);
      k.meat -= rot;
      if (!this.water[idx]) this.grass[idx] = Math.min(C.GRASS_MAX, this.grass[idx] + rot * C.CORPSE_TO_GRASS);
      if (k.meat > 0) {
        this.meatOnSquare[idx] += k.meat;
        if (!this.corpsesOnSquare.has(idx)) this.corpsesOnSquare.set(idx, []);
        this.corpsesOnSquare.get(idx).push(k);
      }
    }
    this.corpses = this.corpses.filter((k) => k.meat > 0);
    // No respawning: creatures only come from parents, so a species can die out for good.
    if (this.tick % C.HISTORY_EVERY === 0) {
      this.history.push([this.count("herbivore"), this.count("carnivore")]);
      if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    }
  }

  growGrass() {
    // Grass only grows from grass: each square grows from its own grass and from its 4 neighbors
    // (left-right wraps around; top/bottom rows have no neighbor past the wall). Corpse meat on a
    // square makes it grow faster, and every unit of grass grown there uses up one unit of that meat.
    const g = this.grass, prev = this.grassPrev, cols = this.gcols, rows = this.grows;
    prev.set(g);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i, v = prev[idx];
        if (this.water[idx]) continue; // nothing grows in a river
        let sum = prev[j * cols + mod(i - 1, cols)] + prev[j * cols + mod(i + 1, cols)], n = 2;
        if (j > 0) { sum += prev[idx - cols]; n++; }
        if (j < rows - 1) { sum += prev[idx + cols]; n++; }
        const room = 1 - v / C.GRASS_MAX;
        const meat = this.meatOnSquare[idx];
        let grow = (C.GRASS_REGROW * v + C.GRASS_SPREAD * (sum / n)) * room * (1 + meat / C.FERTILE_MEAT);
        if (meat > 0) {
          grow = Math.min(grow, meat); // one meat per one grass
          let pay = grow;
          for (const k of this.corpsesOnSquare.get(idx)) {
            const take = Math.min(pay, k.meat);
            k.meat -= take;
            pay -= take;
            if (pay <= 0) break;
          }
        }
        g[idx] = Math.min(C.GRASS_MAX, v + grow);
      }
    }
  }

  apply(c, action, speed = 0) {
    const s = c.spec;
    c.lastAction = action;
    c.lastSpeed = 0;
    if (action === "left" || action === "right") {
      c.angle = wrapAngle(c.angle + (action === "left" ? -C.TURN_ANGLE : C.TURN_ANGLE));
      c.energy -= C.TURN_COST;
    } else if (action === "forward") {
      speed = Math.max(0, Math.min(Number(speed) || 0, s.maxSpeed));
      // Left-right wraps around. Top/bottom walls stop you; hitting one at an angle slides you along it.
      // Rivers stop you, unless your swim output is on: then you can step in at the edge and swim across.
      // In the water you move at SWIM_SPEED and pay SWIM_COST x the normal moving cost; once in, you can always get out.
      const wet = this.rivers.length > 0 && this.inWater(c.x, s.radius);
      const v = wet ? speed * C.SWIM_SPEED : speed;
      const wantX = c.x + Math.cos(c.angle) * v;
      let x = this.rivers.length && !c.swim && !wet ? this.outOfRiver(wantX, s.radius, c.x) : wantX;
      if (this.walls) x = this.stopAtWall(x, c.x, s.radius); // walls in the rivers stop swimmers too
      c.x = mod(x, this.w);
      if (this.rivers.length) this.waterAchievements(c, wet);
      const wantY = c.y + Math.sin(c.angle) * v;
      c.y = World.inside(wantY, s.radius, this.h);
      if (Math.abs(c.y - wantY) > 0.01 || x !== wantX) c.reward -= C.REWARD_WALL; // bumped into a wall or river
      c.energy -= C.MOVE_COST_K * speed * speed * (wet ? C.SWIM_COST : 1);
      c.lastSpeed = speed;
    } else if (action === "eat") {
      this.eat(c);
    } else if (action === "attack") {
      this.attack(c);
    } else if (action === "mate") {
      // Too little energy to mate: choosing mate does nothing at all (no glow either).
      if (c.energy < c.spec.mateEnergy) return;
      c.glow = C.GLOW_TICKS; // glows even if no partner is in reach
      this.mate(c);
    } else {
      throw new Error(`unknown action ${action}`);
    }
  }

  eat(c) {
    const s = c.spec;
    const room = s.maxEnergy - c.energy;
    if (room <= 0) return;
    let got;
    if (c.species === "herbivore") {
      const [i, j] = this.gcell(c.x, c.y);
      const idx = j * this.gcols + i;
      got = Math.min(s.eatRate, this.grass[idx], room);
      this.grass[idx] -= got;
    } else {
      const [corpse] = this.nearestCorpse(c, this.eatReach(c));
      if (!corpse) return;
      got = Math.min(s.eatRate, corpse.meat, room);
      corpse.meat -= got;
    }
    c.energy += got;
    c.eaten += got;
    c.reward +=(got / s.maxEnergy) * C.REWARD_FOOD;
    if (c.species === "herbivore" && got > 0 && c.energy >= s.maxEnergy - 1e-6) this.achieve("glutton", c);
  }

  canAttack(attacker, target) {
    // Carnivores may bite anyone (even each other); herbivores only kick carnivores.
    return attacker.species === "carnivore" || target.species !== attacker.species;
  }

  attack(c) {
    c.energy -= C.ATTACK_COST;
    const maxRadius = Math.max(...Object.values(C.SPECIES).map((s) => s.radius));
    const maxReach = c.spec.radius + maxRadius + C.ATTACK_REACH;
    // The bite lands on whatever allowed target is closest in front, intended or not.
    const [target, d] = this.nearest(c, maxReach, C.ATTACK_ARC, (o) => this.canAttack(c, o));
    if (!target || d > this.attackReach(c, target)) {
      c.reward -= C.REWARD_FAILED_BITE;
      return;
    }
    target.health -= c.spec.bite;
    target.reward -= (c.spec.bite / target.spec.maxHealth) * C.REWARD_HURT;
    if (target.health <= 0 && target.alive) {
      this.die(target, `killed by a ${c.spec.label}`);
      this.stat(`${target.species}_killed`);
      if (c.species === "carnivore" && target.species === "herbivore") {
        this.achieve("firstBlood", c);
        if (++c.herbKills >= 5) this.achieve("serialHunter", c);
        if (this.rivers.length && this.inWater(target.x, target.spec.radius)) this.achieve("straitHunter", c);
      } else if (c.species === "carnivore") {
        this.achieve("cannibal", c);
      } else {
        this.achieve("fightingBack", c);
      }
    } else if (target.species === "herbivore") {
      target.bittenAt = target.age || 1; // still alive: Close Call if it lasts 10 more seconds
    }
  }

  mate(c) {
    const s = c.spec;
    if (!this.readyToMate(c) || this.count("herbivore") + this.count("carnivore") >= C.MAX_CREATURES) return;
    // Partners must be from the same side of the rivers (the last dry land each stood on): genes only cross
    // a river when a creature swims all the way across, never by mating from the water with the far bank.
    const [partner] = this.nearest(c, s.radius * 2 + C.MATE_REACH, null,
      (o) => o.species === c.species && this.readyToMate(o) && o.drySide === c.drySide);
    if (!partner) return;
    for (const p of [c, partner]) {
      p.energy -= s.mateCost;
      p.mateCooldown = s.mateCooldown;
      p.kids++;
      p.reward += C.REWARD_BABY;
    }
    // The baby also counts for its grandparents and great-grandparents (each one once, even when
    // the two parents are related), dead or alive.
    const grand = new Set([...c.parents, ...partner.parents]);
    for (const g of grand) g.grandkids++;
    const great = new Set([...grand].flatMap((g) => g.parents));
    for (const g of great) g.greatkids++;
    for (const p of [c, partner]) if (p.kids >= 10) this.achieve("bigFamily", p);
    for (const g of great) this.achieve("grandparent", g);
    for (const p of [c, partner, ...grand, ...great]) if (Hall.family(p) >= 50) this.achieve("dynasty", p);
    if (this.rivers.length && c.drySide !== c.bornMid) this.achieve("newLand", c);
    // The only way brains learn: the child's brain is the mean of its parents' brains + mutation.
    const child = this.spawnWithBrain(c.species, Brain.child(c.brain, partner.brain, this.rng, s.mutationScaled), {
      x: this.onSide(c.x + this.rng.uniform(-8, 8), s.radius, c.drySide), y: c.y + this.rng.uniform(-8, 8),
      energy: s.childEnergy, generation: Math.max(c.generation, partner.generation) + 1,
    });
    child.parents = [c, partner];
    if (this.rivers.length && c.bornMid !== partner.bornMid) this.achieve("geneSwap", child);
    this.stat(`${c.species}_born`);
  }

  upkeep(c) {
    const s = c.spec;
    c.age++;
    if (c.age >= c.lifespan) {
      if (c.energy >= s.maxEnergy * 0.95) this.achieve("oldTimer", c);
      this.die(c, "died of old age");
      this.stat(`${c.species}_old`);
      return;
    }
    if (c.bittenAt && c.age - c.bittenAt >= 10 * C.FPS) { // bitten 10 s ago and still here
      this.achieve("closeCall", c);
      c.bittenAt = 0;
    }
    if (c.mateCooldown > 0) c.mateCooldown--;
    if (c.glow > 0) {
      c.glow--;
      c.glowTicks++; // how much of its life it spent glowing (for picking top brains)
      c.energy -= s.maxEnergy * C.GLOW_COST; // shining costs energy
    }
    c.energy -= s.aliveCost;
    if (c.energy > s.maxEnergy * 0.5) c.health = Math.min(s.maxHealth, c.health + C.HEALTH_REGEN);
    if (c.energy <= 0) {
      this.die(c, "starved");
      this.stat(`${c.species}_starved`);
    }
  }

  die(c, cause) {
    if (c.alive) {
      c.alive = false;
      c.diedAt = this.tick;
      c.deathCause = cause;
      this.hall.consider(c);
    }
  }

  cleanup() {
    for (const c of this.creatures) {
      if (!c.alive) this.corpses.push({ x: c.x, y: c.y, meat: c.spec.corpseMeat, species: c.species });
    }
    this.creatures = this.creatures.filter((c) => c.alive);
  }
}
