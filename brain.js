// Tiny neural-network brains: SENSES inputs -> HIDDEN tanh neurons -> 6 action scores + 1 speed.
//
// Brains change in two ways:
// - Breeding: a child's genes are the mean of both parents' genes plus small random mutations.
// - Learning during life: rewards (food, babies) strengthen the connections that were just active, and
//   punishments (bites, wasted effort) weaken them. Learned changes are NOT passed on to children: they
//   inherit the genes their parents were born with, like real animals.
// Color comes from the genes, so similar brains look alike.

const SENSES = 32;
// One score per action (highest wins) + speed + lock herbivore + lock carnivore + swim.
const OUTPUTS = ACTIONS.length + 4;
const SPEED_OUT = ACTIONS.length;
const LOCKS = [ // > 0.5: that sense keeps pointing at the same creature instead of the closest one
  { slot: "herb", out: ACTIONS.length + 1 },
  { slot: "pred", out: ACTIONS.length + 2 },
];
const SWIM_OUT = ACTIONS.length + 3; // > 0.5: may step into a river (only matters at the water's edge)

function brainSize(hidden = C.BRAIN_HIDDEN, senses = SENSES, outputs = OUTPUTS) {
  return hidden * (senses + 1) + outputs * (hidden + 1); // +1 = bias
}

// Older brain shapes (before the river senses and swim): saved brains of that shape are upgraded by
// upgradeGenes() with the new connections at 0 and swim off, so they behave exactly as before.
const OLD_SHAPES = [{ senses: 28, outputs: 9 }];
const SWIM_OFF_BIAS = -3;

function upgradeGenes(w) {
  // Saved weights of any known shape -> the current shape (or null if the shape is unknown).
  const H = C.BRAIN_HIDDEN;
  if (w.length === brainSize()) return Float32Array.from(w);
  const old = OLD_SHAPES.find((o) => w.length === brainSize(H, o.senses, o.outputs));
  if (!old) return null;
  const out = new Float32Array(brainSize());
  for (let h = 0; h < H; h++) {
    for (let k = 0; k <= old.senses; k++) out[h * (SENSES + 1) + k] = w[h * (old.senses + 1) + k];
  }
  for (let o = 0; o < OUTPUTS; o++) {
    const to = H * (SENSES + 1) + o * (H + 1);
    if (o < old.outputs) {
      for (let k = 0; k <= H; k++) out[to + k] = w[H * (old.senses + 1) + o * (H + 1) + k];
    } else if (o === SWIM_OUT) {
      out[to] = SWIM_OFF_BIAS;
    }
  }
  return out;
}

class Brain {
  constructor(weights, learnRate = C.LEARN_RATE) {
    // Float32Array layout: [hidden layer (with bias)] then [output layer (with bias)]
    this.genes = weights;                    // what it was born with; never changes
    this.learnRate = learnRate; // a gene too: how fast it learns during life (fixed per species, see learnRate in config)
    this.w = Float32Array.from(weights);     // what it thinks with; changes as it learns
    this.trace = new Float32Array(weights.length); // recent activity of every connection (~1 s memory)
    this.hidden = new Float32Array(C.BRAIN_HIDDEN);
    this.out = new Float32Array(OUTPUTS);
  }

  static random(rng) {
    const H = C.BRAIN_HIDDEN, w = new Float32Array(brainSize());
    let i = 0;
    for (let h = 0; h < H; h++) for (let k = 0; k <= SENSES; k++) w[i++] = rng.gauss(0, 1 / Math.sqrt(SENSES + 1));
    for (let o = 0; o < OUTPUTS; o++) for (let k = 0; k <= H; k++) w[i++] = rng.gauss(0, 1 / Math.sqrt(H + 1));
    return new Brain(w);
  }

  static child(a, b, rng, scaled = 0) {
    // Mean of the parents + mutation: every weight wiggles a little, a few jump further, and big
    // weights also wiggle in proportion to their size (else a 200 never really changes).
    const w = new Float32Array(a.genes.length);
    for (let i = 0; i < w.length; i++) {
      const mean = (a.genes[i] + b.genes[i]) / 2;
      w[i] = mean + rng.gauss(0, C.MUTATION_SIGMA);
      if (scaled > 0) w[i] += rng.gauss(0, scaled * Math.abs(mean));
      if (rng.random() < C.MUTATION_BIG_RATE) w[i] += rng.gauss(0, C.MUTATION_BIG_SIGMA);
    }
    // Learning rate: geometric mean of the parents, nudged up or down by ~30% (it can evolve toward 0).
    const [lo, hi] = C.LR_RANGE;
    const lr = Math.sqrt(a.learnRate * b.learnRate) * Math.exp(rng.gauss(0, C.LR_MUTATION));
    return new Brain(w, Math.max(lo, Math.min(hi, lr)));
  }

  clone() {
    return new Brain(Float32Array.from(this.genes), this.learnRate);
  }

  remember(x, chosen, speedPost, lockPosts) {
    // Memory traces: each connection's trace fades a little every tick and grows while both of its ends are
    // active (pre x post). For the output layer, "active" means the action actually chosen (and the speed).
    const H = C.BRAIN_HIDDEN, e = this.trace, hid = this.hidden, fade = C.TRACE_FADE;
    let i = 0;
    for (let h = 0; h < H; h++) {
      const post = hid[h];
      e[i] = fade * e[i] + post; // bias
      i++;
      for (let k = 0; k < SENSES; k++, i++) e[i] = fade * e[i] + post * x[k];
    }
    for (let o = 0; o < OUTPUTS; o++) {
      const post = o === chosen ? 1 : o === SPEED_OUT ? speedPost : o > SPEED_OUT ? lockPosts[o - SPEED_OUT - 1] : 0;
      e[i] = fade * e[i] + post;
      i++;
      for (let k = 0; k < H; k++, i++) e[i] = fade * e[i] + post * hid[k];
    }
  }

  learn(reward) {
    // Reward > 0 strengthens whatever was recently active, reward < 0 weakens it.
    const step = this.learnRate * reward, w = this.w, e = this.trace, lim = C.WEIGHT_LIMIT;
    const from = C.LEARN_HIDDEN ? 0 : C.BRAIN_HIDDEN * (SENSES + 1); // output layer starts here
    for (let i = from; i < w.length; i++) {
      const v = w[i] + step * e[i];
      w[i] = v > lim ? lim : v < -lim ? -lim : v;
    }
  }

  learnedAmount() {
    // Average size of what life has changed so far (0 = still exactly as born).
    let s = 0;
    for (let i = 0; i < this.w.length; i++) s += Math.abs(this.w[i] - this.genes[i]);
    return s / this.w.length;
  }

  think(x) {
    const H = C.BRAIN_HIDDEN, w = this.w, hid = this.hidden, out = this.out;
    let i = 0;
    for (let h = 0; h < H; h++) {
      let s = w[i++]; // bias
      for (let k = 0; k < SENSES; k++) s += w[i++] * x[k];
      hid[h] = Math.tanh(s);
    }
    for (let o = 0; o < OUTPUTS; o++) {
      let s = w[i++];
      for (let k = 0; k < H; k++) s += w[i++] * hid[k];
      out[o] = s;
    }
    return out;
  }
}

// ---------- color from weights ----------
// Starter brains are pure green (herbivores) and pure red (carnivores). A fixed random projection of
// how far a brain's weights have drifted from its starter brain shifts that color, so close weights
// give close colors and a family keeps its look while slowly drifting away from the starting color.

const BASE_COLOR = { herbivore: [90, 220, 90], carnivore: [230, 70, 60] };
const colorProjection = {};
function brainColor(brain, species) {
  if (!colorProjection[species]) {
    const rng = makeRng(species === "herbivore" ? 101 : 202), n = brainSize();
    colorProjection[species] = {
      start: starterBrain(species).w,
      p: [0, 1, 2].map(() => Float32Array.from({ length: n }, () => rng.gauss(0, 1))),
    };
  }
  const { start, p } = colorProjection[species], n = brain.genes.length;
  return p.map((row, ch) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += row[i] * (brain.genes[i] - start[i]);
    // One generation of mutation moves s by about 1.2; tanh keeps far-drifted families in range.
    return clampChannel(BASE_COLOR[species][ch] + 110 * Math.tanh(s / 8));
  });
}

// ---------- senses ----------

const senses = new Float32Array(SENSES);
const looked = {};

function senseThing(x, i, me, world, thing, d) {
  // 4 numbers about one thing: is it there, how close, and which way (sin/cos of the angle
  // relative to where I'm facing: cos = 1 straight ahead, sin > 0 to my right).
  if (!thing) {
    x[i] = 0; x[i + 1] = 0; x[i + 2] = 0; x[i + 3] = 0;
    return;
  }
  const dx = wrapDelta(thing.x - me.x, world.w), dy = thing.y - me.y;
  const rel = wrapAngle(Math.atan2(dy, dx) - me.angle);
  x[i] = 1;
  x[i + 1] = Math.max(0, 1 - d / C.GLOW_RANGE);
  x[i + 2] = Math.sin(rel);
  x[i + 3] = Math.cos(rel);
}

function sense(me, world) {
  const s = me.spec, x = senses;
  x[0] = me.energy / s.maxEnergy;
  x[1] = me.health / s.maxHealth;
  x[2] = world.readyToMate(me) ? 1 : 0;
  x[3] = me.mateCooldown / s.mateCooldown;
  x[4] = world.grassAt(me.x, me.y) / C.GRASS_MAX;
  const [gx, gy, amount] = world.bestGrassNear(me.x, me.y, 3); // the 7x7 squares around me
  const [, , gd] = world.offset(me, gx, gy);
  const [gi, gj] = world.gcell(gx, gy), [mi, mj] = world.gcell(me.x, me.y);
  const mine = gi === mi && gj === mj;
  // No direction when there's no grass to go to, or the best grass is the square I'm standing on.
  senseThing(x, 5, me, world, amount > 0 && !mine ? { x: gx, y: gy } : null, gd);
  x[5] = amount / C.GRASS_MAX; // instead of "is it there": how much grass that best square has
  const v = world.look(me, looked);
  // Locks: while "lock herbivore" / "lock carnivore" is on, that sense keeps pointing at the same
  // creature as long as it's visible, instead of jumping to whichever is closest.
  for (const { slot } of LOCKS) {
    const id = me.locked[slot];
    if (!id) continue;
    const t = world.byId.get(id);
    const d = t && t.alive ? world.offset(me, t.x, t.y)[2] : Infinity;
    if (d <= s.visionRange || (t && t.glow > 0 && d <= C.GLOW_RANGE)) {
      v[slot] = t;
      v[slot + "D"] = d;
    } else {
      // It got away (or died). A herbivore a carnivore was locked on for 10 s that got away: Escape Artist.
      if (t && t.alive && slot === "herb" && me.species === "carnivore" && world.tick - me.lockSince.herb >= 10 * C.FPS) {
        world.achieve("escapeArtist", t);
      }
      me.locked[slot] = 0;
    }
  }
  me.targets.herb = v.herb;
  me.targets.pred = v.pred;
  senseThing(x, 9, me, world, v.herb, v.herbD);
  senseThing(x, 13, me, world, v.pred, v.predD);
  senseThing(x, 17, me, world, v.mate, v.mateD);
  const [corpse, cd] = world.nearestCorpse(me, s.visionRange);
  senseThing(x, 21, me, world, corpse, cd);
  x[25] = (me.y / world.h) * 2 - 1;     // -1 = at the top wall, 1 = at the bottom wall
  x[26] = Math.sin(me.angle);          // heading: -1 = facing up, 1 = facing down
  x[27] = me.lastSpeed / s.maxSpeed;
  // The nearest river (if I can see it): how close, which way (rivers run up-down, so it's straight
  // left or right of me), and whether I'm in the water now.
  const r = world.nearestWater(me);
  if (r && r.d <= s.visionRange) {
    const rel = wrapAngle((r.dx >= 0 ? 0 : Math.PI) - me.angle);
    x[28] = 1 - r.d / s.visionRange;
    x[29] = r.d > 0 ? Math.sin(rel) : 0;
    x[30] = r.d > 0 ? Math.cos(rel) : 0;
  } else {
    x[28] = x[29] = x[30] = 0;
  }
  x[31] = world.inWater(me.x, s.radius) ? 1 : 0;
  return x;
}

class BrainController {
  constructor(brain) {
    this.brain = brain;
    this.lastSenses = new Float32Array(SENSES); // kept for the brain viewer
  }

  act(me, world) {
    // What happened since last tick teaches the brain first: only the part that was better (or worse)
    // than this creature's usual reward, like dopamine reacting to surprises.
    const r = me.reward, surprise = C.USE_BASELINE ? r - me.rewardAvg : r;
    me.rewardAvg += (r - me.rewardAvg) * (1 - C.BASELINE_FADE);
    if (surprise !== 0) this.brain.learn(surprise);
    me.rewardSum += r;
    me.reward = 0;
    const x = sense(me, world);
    this.lastSenses.set(x);
    const out = this.brain.think(x);
    let best = 0;
    for (let k = 1; k < ACTIONS.length; k++) if (out[k] > out[best]) best = k;
    const go = 1 / (1 + Math.exp(-out[SPEED_OUT])); // sigmoid -> 0..1 of max speed
    const posts = LOCKS.map(({ slot, out: o }) => {
      const p = 1 / (1 + Math.exp(-out[o])); // > 0.5: keep sensing the current one
      if (p > 0.5) {
        if (!me.locked[slot] && me.targets[slot]) {
          me.locked[slot] = me.targets[slot].id;
          me.lockSince[slot] = world.tick;
        }
      } else {
        me.locked[slot] = 0;
      }
      return 2 * p - 1;
    });
    const swim = 1 / (1 + Math.exp(-out[SWIM_OUT]));
    me.swim = swim > 0.5;
    posts.push(2 * swim - 1); // the locks, then swim, in output order
    this.brain.remember(x, best, 2 * go - 1, posts);
    return [ACTIONS[best], me.spec.maxSpeed * go];
  }
}

// ---------- starter brains: hand-wired rules, so a new world doesn't die out at once ----------
// Each hidden neuron has one job. Outputs are action scores; the highest one wins.
// Sense numbers (see sense()): 0 energy, 2 ready to mate, 4 grass here, 7/8 best grass sin/cos,
// 9-12 nearest herbivore [seen, closeness, sin, cos], 13-16 nearest carnivore, 21-24 nearest corpse,
// 27 speed last tick.
// Closeness = 1 - distance / GLOW_RANGE, so "touching" is about 0.92-0.94.
// Nobody is taught to run away: that has to evolve.

const OUT = { left: 0, right: 1, forward: 2, eat: 3, attack: 4, mate: 5, speed: 6, lockHerbivore: 7, lockCarnivore: 8, swim: 9 };

function wire(hiddenRules, outputRules) {
  const H = C.BRAIN_HIDDEN, w = new Float32Array(brainSize());
  hiddenRules.forEach(([bias, inputs], h) => {
    const base = h * (SENSES + 1);
    w[base] = bias;
    for (const [k, v] of Object.entries(inputs)) w[base + 1 + Number(k)] = v;
  });
  for (const [name, [bias, hidden]] of Object.entries(outputRules)) {
    const base = H * (SENSES + 1) + OUT[name] * (H + 1);
    w[base] = bias;
    for (const [k, v] of Object.entries(hidden)) w[base + 1 + Number(k)] = v;
  }
  return new Brain(w);
}

const STARTERS = {
  // 1. go forward  2. see food -> turn to it  3. on food -> eat  4. herbivore near and can -> mate
  herbivore: () => wire([
    [-2, { 4: 20 }],               // h0 on grass (more than 10% of a full square)
    [-19, { 0: 20 }],              // h1 full (energy above 95%)
    [0, { 7: 4 }],                 // h2 best grass is to my right (+) or left (-)
    [-1.5, { 8: -5 }],             // h3 best grass is behind me
    [-59.1, { 2: 6, 10: 60 }],     // h4 ready to mate AND another herbivore touching me
    [-3, { 27: 30 }],              // h5 I moved last tick (so a failed try doesn't freeze me in place)
  ], {
    forward: [1, {}],                          // default: go forward
    left: [0, { 2: -3 }],                      // turn toward the grass
    right: [1.5, { 2: 3, 3: 1.5 }],            // (and turn around when it's behind)
    eat: [-1, { 0: 3, 1: -4 }],                // on grass and not full -> eat
    attack: [-5, {}],
    mate: [0.5, { 4: 4, 5: 4 }],               // beats everything when possible, right after a step
    speed: [0, {}],                            // half of max speed
    lockHerbivore: [-3, {}],                   // locks start off (evolution may change that)
    lockCarnivore: [-3, {}],
    swim: [SWIM_OFF_BIAS, {}],                 // nobody is taught to swim: that has to evolve
  }),
  // In priority order: 1. ready to mate and sees another carnivore -> walk to the nearest one, and mate
  //    once touching (right after a step, so a failed try doesn't freeze it)
  // 2. else corpse in sight -> go to the closest one, eat it when in reach
  // 3. else herbivore in sight -> chase the closest one, bite it when in reach
  // 4. else go forward
  // "x(h+1)" terms below: a neuron at -1 adds nothing, at +1 adds 2x. Rule 2 switches rule 3 off
  // through "corpse seen" (21). Rule 1 only wins right after a step, so food is never skipped.
  carnivore: () => wire([
    [-19, { 0: 20 }],                   // h0 full
    [-1.5, { 21: 3 }],                  // h1 corpse seen (unused by outputs; spare for evolution)
    [-2, { 23: 8 }],                    // h2 corpse to my right
    [-2, { 23: -8 }],                   // h3 corpse to my left
    [-3, { 24: -6 }],                   // h4 corpse behind me
    [-191.6, { 22: 200 }],              // h5 corpse within eating reach (<= 20 px; reach is 21)
    [-2, { 11: 8, 21: -8 }],            // h6 herbivore to my right (and no corpse seen)
    [-2, { 11: -8, 21: -8 }],           // h7 herbivore to my left
    [-3, { 12: -6, 21: -8 }],           // h8 herbivore behind me
    [-146.25, { 10: 150, 12: 5, 21: -10 }], // h9 herbivore in biting reach (<= ~28 px; reach is 29), in front, no corpse seen
    [-143.3, { 2: 6, 14: 150 }],        // h10 ready to mate AND another carnivore touching me (<= ~38 px)
    [-3, { 27: 30 }],                   // h11 I moved last tick
    [-1.5, { 9: 3, 21: -6 }],           // h12 chasing a herbivore (seen, no corpse)
    [-10, { 15: 8, 2: 8 }],             // h13 ready, and the nearest carnivore I see is to my right
    [-10, { 15: -8, 2: 8 }],            // h14 ready, and it's to my left
    [-11, { 16: -6, 2: 8 }],            // h15 ready, and it's behind me
  ], {
    forward: [1.5, {}],
    right: [14, { 2: 2, 4: 2, 6: 2, 8: 2, 13: 3, 15: 3 }], // 2*(h+1) per food reason, 3*(h+1) toward a mate
    left: [7, { 3: 2, 7: 2, 14: 3 }],
    eat: [0, { 5: 4, 0: -4 }],                 // corpse in reach and not full
    attack: [4, { 9: 4 }],
    mate: [0.3, { 10: 4.5, 11: 4.5 }],         // ready + just stepped: 9.3, beats everything; else below 1.5
    speed: [1, { 12: 1.5 }],                   // sprint while chasing, walk otherwise
    lockHerbivore: [0, { 12: 3 }],             // lock onto the victim while chasing it, so it doesn't swerve
    lockCarnivore: [-3, {}],
    swim: [SWIM_OFF_BIAS, {}],                 // nobody is taught to swim: that has to evolve
  }),
};

function starterBrain(species) {
  return STARTERS[species]();
}

// ---------- hall of fame: one world's top brains, used to start the next world ----------
// Every world keeps its own list of the HALL_SIZE brains with the most children (ties: the newest
// wins). Only creatures with at least one child count; survivors are added when the world ends.
// The next world breeds every starting creature from two random brains of that list (mean +
// mutation), then starts a fresh list of its own. Species not in HALL_SPECIES use the starter brain.

class Hall {
  constructor() {
    this.best = { herbivore: [], carnivore: [] };
    this.counter = 0; // order of arrival, newest = highest
    this.candidates = new Map(); // creature (with kids) -> arrival number; ranked by rank()
    this.seen = new Map(); // every creature (kids or not) -> arrival number, for the fallback in rank()
  }

  // Family score: kids + grandkids + great-grandkids. Grandkids can still be born after a creature dies,
  // so creatures are only collected here, and ranked by rank() once the world ends (or when asked).
  static family(c) {
    return c.kids + c.grandkids + c.greatkids;
  }

  consider(c) {
    if (c.isPlayer) return; // your brain didn't steer you, so it doesn't count
    if (!this.seen.has(c)) this.seen.set(c, this.counter++);
    if (c.kids > 0 && !this.candidates.has(c)) this.candidates.set(c, this.seen.get(c));
  }

  lastOnes(sp, mid) {
    // Fallback when nobody of this species in this part had a baby: its last creatures (the ones still alive
    // first, then the latest to die), so evolution goes on from them instead of from the starter brain.
    const list = [];
    for (const [c, n] of this.seen) {
      if (c.species === sp && (mid === undefined || c.drySide === mid)) list.push({ c, n });
    }
    list.sort((a, b) => (b.c.alive - a.c.alive) || ((b.c.diedAt || 0) - (a.c.diedAt || 0)) || b.n - a.n);
    return list.slice(0, C.HALL_SIZE).map(({ c, n }) => ({ brain: c.brain, kids: 0, score: 0, n, mid: c.drySide, last: true }));
  }

  survivors(sp, mid) {
    // The creatures of this species still alive at the end of the world (in this part of the map), best first:
    // half for food (energy eaten / the part's best eater's) + half for kids (kids / the part's most kids).
    // Herbivores that glow all the time are skipped, unless that leaves nobody.
    let alive = [];
    for (const [c, n] of this.seen) {
      if (c.alive && c.species === sp && (mid === undefined || c.drySide === mid)) alive.push({ c, n });
    }
    const calm = alive.filter(({ c }) => !(sp === "herbivore" && c.glowTicks > C.HALL_MAX_GLOW * c.age));
    if (calm.length) alive = calm;
    let maxEaten = 0, maxKids = 0;
    for (const { c } of alive) maxEaten = Math.max(maxEaten, c.eaten), maxKids = Math.max(maxKids, c.kids);
    const key = (c) => (maxEaten ? c.eaten / maxEaten : 0) + (maxKids ? c.kids / maxKids : 0);
    alive.sort((a, b) => key(b.c) - key(a.c) || b.n - a.n);
    return alive.slice(0, C.HALL_SIZE).map(({ c, n }) => ({ brain: c.brain, kids: c.kids, score: Hall.family(c), n, mid: c.drySide }));
  }

  rank() {
    // best[species] = the creatures still alive that ate and mated most (survivors). A species with nobody
    // alive (in a part) falls back to the top HALL_SIZE by family score (ties: more kids, then the newest).
    // With rivers: the middle strip and the sides each breed their own. A part where nobody is alive and
    // nobody had a baby takes its last creatures instead (lastOnes), never the other side's.
    if (this.seen.size === 0) return this;
    for (const sp of Object.keys(this.best)) {
      const list = [];
      for (const [c, n] of this.candidates) {
        if (c.species !== sp) continue;
        // Herbivores that glow all the time are beacons for carnivores; don't breed from them.
        if (c.species === "herbivore" && c.glowTicks > C.HALL_MAX_GLOW * c.age) continue;
        // Its part of the map: the side of the last dry land it stood on (being in a river doesn't count as crossing).
        list.push({ brain: c.brain, kids: c.kids, score: Hall.family(c), n, mid: c.drySide });
      }
      list.sort((a, b) => b.score - a.score || b.kids - a.kids || b.n - a.n);
      if (riverBands().length) {
        const N = C.HALL_SIZE, part = (mid) => {
          const alive = this.survivors(sp, mid);
          if (alive.length) return alive;
          const top = list.filter((e) => e.mid === mid).slice(0, N);
          return top.length ? top : this.lastOnes(sp, mid);
        };
        this.best[sp] = [...part(true), ...part(false)];
      } else {
        const alive = this.survivors(sp);
        this.best[sp] = alive.length ? alive : list.length ? list.slice(0, C.HALL_SIZE) : this.lastOnes(sp);
      }
    }
    return this;
  }

  newBrain(species, rng) {
    return this.newChild(species, rng).brain;
  }

  newChild(species, rng, mid) {
    // A child of two top brains from one part of the map: `mid` true = the middle strip, false = the sides,
    // undefined = anywhere. Genes never cross a river unless a creature swims across itself: if this species
    // has no top brains from that part, the child gets the starter brain instead (brains saved before rivers
    // existed have no part, so they fit anywhere).
    const list = this.best[species], scaled = C.SPECIES[species].mutationScaled;
    const pool = !C.HALL_SPECIES.includes(species) ? [] : mid === undefined ? list
      : list.filter((e) => e.mid === mid || e.mid === undefined);
    if (pool.length === 0) {
      const s = starterBrain(species);
      return { brain: Brain.child(s, s, rng, scaled) };
    }
    const a = pool[Math.floor(rng.random() * pool.length)], b = pool[Math.floor(rng.random() * pool.length)];
    return { brain: Brain.child(a.brain, b.brain, rng, scaled) };
  }
}

function averageLearnRate(world, species) {
  // Geometric mean of the learning-rate gene over living creatures of a species (for the HUD).
  let s = 0, n = 0;
  for (const c of world.creatures) {
    if (c.species !== species || !c.brain) continue;
    s += Math.log(c.brain.learnRate);
    n++;
  }
  return n ? Math.exp(s / n) : 0;
}

// ---------- brain viewer: everything about one creature, as plain numbers ----------
// Used by the page when you click a creature (directly, or through the server's /creature/<id>).

const SENSE_NAMES = [
  "energy", "health", "ready to mate", "mating cooldown", "grass here",
  "best grass: amount", "best grass: closeness", "best grass: side", "best grass: ahead",
  "herbivore: seen", "herbivore: closeness", "herbivore: side", "herbivore: ahead",
  "carnivore: seen", "carnivore: closeness", "carnivore: side", "carnivore: ahead",
  "glowing mate: seen", "glowing mate: closeness", "glowing mate: side", "glowing mate: ahead",
  "corpse: seen", "corpse: closeness", "corpse: side", "corpse: ahead",
  "up / down position", "facing up / down", "speed last tick",
  "river: closeness", "river: side", "river: ahead", "in water",
];
const OUTPUT_NAMES = [...ACTIONS, "speed", "lock herbivore", "lock carnivore", "swim"];

function describeCreature(c, world, withWeights) {
  const s = c.spec, ctl = c.controller;
  return {
    found: true, id: c.id, species: s.label, generation: c.generation, kids: c.kids,
    grandkids: c.grandkids, greatkids: c.greatkids,
    age: Math.floor(c.age / C.FPS), lifespan: Math.round(c.lifespan / C.FPS),
    energy: Math.round(c.energy), maxEnergy: s.maxEnergy, health: Math.round(c.health), maxHealth: s.maxHealth,
    ready: world.readyToMate(c), glowing: c.glow > 0, action: c.lastAction, speed: Number(c.lastSpeed.toFixed(2)),
    rewards: Number(c.rewardSum.toFixed(1)), learned: Number(c.brain.learnedAmount().toFixed(3)),
    learnRate: Number(c.brain.learnRate.toPrecision(2)), locked: { ...c.locked },
    senses: Array.from(ctl.lastSenses || []), hidden: Array.from(c.brain.hidden), out: Array.from(c.brain.out),
    weights: withWeights ? Array.from(c.brain.w) : undefined,
  };
}
