# Evo game rules

The game is plain JavaScript in the browser: open [index.html](index.html) (double-click works, no server needed).
All numbers live in [config.js](config.js); change them there to rebalance the world.

## The world
- 1920 × 1080 px (Full HD).
- **Left and right wrap around:** walk off the left edge and you come back on the right (and the other way).
- **Water and land:** the **left half** of the world (x 0–960) is **water**, the **right half** (960–1920) is
  **land**. Grass grows in both (drawn hatched blue in the water, white on land). They meet twice: in the middle of
  the world, and at the left/right edge (through the wrap-around). From land you can't step into the water: you
  stop at the edge (a small bump punishment, like a wall), unless the brain's **swim** output is on (see Brains).
  In the water you move at **half speed**, and moving costs **twice the energy** of walking forward at the same
  speed; you can always climb out onto land. Everyone sees, bites, eats and mates across the edge.
- **Born in the water or on land:** every creature remembers where it was born, and that's its **part of the map**.
  Babies are born next to their parent, in the water if the parent is in the water, on land if not. In the next
  world, the kids of water-born creatures start in the water, and the kids of land-born creatures start on land.
- **Walls (W, or the Walls button):** puts walls where water meets land (in the middle and at the left/right edge),
  so nobody can go between them, not even swimmers. W again (or the button) takes them away. On the server the
  walls are shared by everyone watching and stay for the next worlds and runs until switched off. While you play,
  W walks, so it only switches the walls while you're watching. A world ends when a species is gone from
  everywhere, or in a **tie** (see Life and death).
  Distances and vision work across that seam too, so you can see and bite someone on the other side.
- **Top and bottom have solid walls** (10 px). Walking into one stops you; hitting it at an angle slides you along it.
- The game fills the browser window, and the world scales to fit it. F toggles fullscreen.
- Everything is drawn at the screen's real pixel density, so text and circles stay sharp on Retina screens.
- 30 ticks per second. Each tick, every creature acts once, in a random order.
- **Grass** grows on a grid of 40 px squares. Each square holds 0–40 food.
  - **Grass only grows from grass.** A square grows from its own grass and spreads into its 4 neighbors
    (across the left-right seam too). A bare square with no grassy neighbors stays bare, unless something dies there.
  - **Corpses fertilize the ground:** meat turns into grass **one for one**. The meat a corpse loses by rotting becomes
    grass on its square, and grass on that square grows faster the more meat lies there (growth × (1 + meat / 30),
    so a fresh herbivore corpse makes it grow about 4× faster). Every unit of grass grown there uses up one unit of
    the corpse's meat, so a corpse slowly turns into grass and disappears.
  - Growth is slow. Half-full squares grow fastest, and full squares stop.
  - At the start, about 35% of the squares have some grass. That's the herbivores' head start, because growth is so slow.

## Species
Two species, told apart by **shape** (⬡ herbivore = hexagon drone, ➤ carnivore = chevron drone with a scan cone).
The look is a black & white blueprint: everything is black/white/gray except the creatures. Every creature can tell
which species another creature belongs to.

**Vision has no angle:** everyone sees everything around them within their vision radius.

**Glow:** choosing *mate* with enough energy to mate makes a creature glow for 1.5 s (45 ticks). Every creature, of either species,
can see a glowing creature from up to **450 px** away, far beyond normal vision. It's a mating call,
and also a beacon for hungry carnivores. Glowing costs energy: 0.02% of max energy per tick, so one full
glow costs 0.9% (0.9 for a herbivore, 1.8 for a carnivore). You can only glow with enough energy to mate.

| | ⬡ Herbivore | ➤ Carnivore |
|---|---|---|
| Max speed (px/tick) | 2.5 | 3.5 |
| Max energy / start energy | 100 / 70 | 200 / 140 |
| Max health | 60 (3 carnivore bites) | 100 |
| Cost of being alive per tick | 0.015 | 0.05 |
| Body size (radius) | 10 px | 15 px |
| Vision radius (all around) | 150 px | 220 px |
| Bite / kick damage | 5 | 20 |
| Food | grass on its own cell, up to 2.5 per bite | corpses (any species), up to 6 per bite |
| Corpse meat when it dies | 90 | 120 |
| Mating: energy needed / cost / child's energy | 40 / 18 / 50 | 120 / 45 / 90 |
| Mating cooldown | 150 ticks | 300 ticks |
| Population at start | 100 | 12 |
| Lifespan | random 25–35 s | random 50–70 s |

**Population limit: 100 creatures in total** (herbivores + carnivores together). While the world holds 100, no baby is born.

## Actions: exactly one per tick, for everyone (player and brains)
1. **left** / **right**: turn by 10°. Costs 0.01 energy.
2. **forward(speed)**: move 0 … max_speed px in the facing direction. Costs `0.01 × speed²`, so sprinting is
   expensive and walking is cheap. Speed 0 = standing still / waiting.
3. **eat**
   - Herbivore: eats grass from the cell it stands on.
   - Carnivore: eats from a corpse within reach (its radius + 6 px). Corpses of either species count.
   - You can't eat past max energy.
4. **attack**: costs 0.6 energy, hit or miss. It hits the **closest allowed target in front** (inside a
   90° arc, bodies touching + 4 px), whether you meant that one or not. This front arc is about the mouth,
   not about vision.
   - Carnivores can bite **anyone**, other carnivores included (cannibalism).
   - Herbivores can only kick carnivores, never each other.
   - Health at 0 → dead.
5. **mate**: does nothing at all without enough energy to mate. With enough energy it starts the glow. The mating itself works if you have enough energy, no cooldown, the world has fewer than 100 creatures in total, and a
   same-species partner who is also ready is touching you (+8 px). Only one of the two has to choose mate.
   Both parents pay the cost and get the cooldown.

## Brains (neural networks)
Every creature except you is driven by its own tiny neural network ([brain.js](brain.js)):
**32 senses → 16 hidden neurons (tanh) → 6 action scores + speed + 2 locks + swim.** The highest action score wins, and the speed
output (squashed to 0 … max speed) is used when that action is *forward*. Brains have no memory: they react only to
what they sense right now.

**Locks:** two more outputs, **lock herbivore** and **lock carnivore**. While one is above 0.5, that sense keeps
pointing at the **same** creature (as long as it's still visible) instead of jumping to whichever is closest, so a
hunter can stay focused on one victim. When the target gets away or dies, the lock lets go. Starter carnivores lock
onto the herbivore they're chasing; all other locks start off, for evolution to discover. The brain viewer draws a
dashed line to whatever the creature is locked onto.

**Swim:** one more output. While it's above 0.5, you may step into the water from land (it does nothing away from
water); once in the water you can always climb out. Starter brains have swim off: swimming has to evolve. Saved
brains from before swimming existed still load, with the new connections at 0 and swim off.

**Senses** (all scaled to about −1 … 1):
- my energy, health, "ready to mate", mating cooldown, grass on my square
- the best grass square nearby (how much, how close, which way)
- the nearest herbivore, the nearest carnivore, the nearest glowing creature of my species, the nearest corpse:
  each as *seen?*, *how close*, and *which way* (sin/cos of the angle relative to where I face)
- where I am between the top and bottom walls, which way I face up/down, and my speed last tick
- the nearest edge between water and land, if I can see it: how close, *which way* (it's always straight left or right of me; in the water, the way to the nearer bank), and *am I in the water*

## Learning during life
Every creature also learns while it lives, from rewards (like dopamine):

| Reward | Amount |
|---|---|
| eating | + 10 × (energy gained / max energy) |
| having a baby | + 5 for each parent |
| getting bitten | − 10 × (health lost / max health) |
| a bite that hits nothing | − 0.05 |
| walking into the top/bottom wall | − 0.02 |

- Every connection keeps a **memory trace** of how active it was recently (it fades 3% per tick, about 1 s).
- Each tick the brain learns from **surprise**: this tick's reward minus the creature's usual reward (a running
  average). Better than usual strengthens the connections that were just active, worse weakens them:
  weight += learning rate × surprise × trace.
- **The learning rate is fixed per species: herbivores 0.01, carnivores 0.02** (`learnRate` in each species in
  config.js). Brains still carry it as a gene, but while it's set it doesn't evolve: every starter brain, baby and
  loaded saved brain of that species gets exactly that. Set it to 0 to let it evolve again (babies then get the
  geometric average of their parents' rates × about ±30%, kept between 0.00001 and 0.05). The HUD shows each
  species' average learning gene, and the brain viewer shows each creature's own.
- Only the **hidden → action** connections learn; the senses → hidden part stays as the genes built it.
  (In tests, letting every layer learn, or learning from raw rewards, made creatures clearly worse.)
- The brain viewer shows how much a creature has learned (average weight change) and its total rewards.

## Children
- A child spawns next to its parents, starts with the child energy, and its generation is the parents' max + 1.
- **Genes are passed on by breeding:** child genes = mean of both parents' genes + a small mutation on every weight
  (σ = 0.05), and 2% of weights jump further (σ = 0.4). What a parent learned during its life is **not** passed on.
- **Herbivores also mutate in proportion to weight size:** each weight gets an extra wiggle of σ = 2% of its own size,
  so their big hand-wired rule weights (up to 60) can really change. Carnivores don't: tested, their precise
  reach rules (mate / eat / bite) break and they die out within ~70 s.
- **Color = genes:** starter brains are pure green (herbivores) and pure red (carnivores). A fixed random projection
  of how far the weights have drifted from the starter brain shifts the color, so families keep their look and
  slowly drift away from pure green/red.

## Life and death
- Every tick costs the "alive" energy, plus the glow cost while glowing.
- Health regenerates 0.05 per tick while energy is above half.
- Every creature (you too) has a random **lifespan** (herbivores 25–35 s, carnivores 50–70 s), then dies of old age.
- Energy at 0 → starved. Health at 0 → killed. Either way the creature leaves a corpse.
- Corpses rot 0.03 meat per tick (into grass, see above) and disappear when empty: about 100 s for a lone herbivore corpse.
- **No creature ever spawns from nowhere.** After the starting population, every creature is born from two parents.
  The only exception is you: you choose when to enter the world (1 / 2).
- **When a species dies out, the whole world restarts** (world 2, 3, …), and the other species **wins that world**.
  The top-left panel keeps the score (herbivores : carnivores) and shows who won the last world and after how long.
- **Tie:** if the two species are apart (herbivores only in the water and carnivores only on land, or the other
  way round), the world ends as a tie and each species gets **+0.5**.

## Top brains (how a new world starts)
- **Survivors first:** a new world breeds from the creatures **still alive when the old world ended** that
  **ate and mated most**: up to 20 per species (and per part of the map), ranked half by food (energy eaten
  in their life, compared to the best eater among them) and half by kids (compared to whoever had the most).
  Herbivores that glow all the time are skipped unless nobody else is alive. A species with nobody alive in a
  part (it died out there) uses the family rule below for that part instead.
- Family rule: the **20 herbivore brains and 20 carnivore brains with the biggest family**:
  **kids + grandkids + great-grandkids** (ties: more kids, then the newest). A grandchild born after its
  grandparent died still counts for it, so the list is ranked when the world ends, survivors included.
  Each grandparent counts a baby once, even when the baby's two parents are related.
  Only creatures with at least one child count, and your own brain never counts.
  Herbivores that spent more than half their life glowing don't count either (they glow all the time).
- The brain viewer shows this as **kids k / g / gg** (kids / grandkids / great-grandkids).
- **Every world starts with 20 herbivores and 5 carnivores in the water, and 20 + 5 on land.**
- **Each part of the map breeds from its own top brains:** the list is kept per part (the top 20 born in the
  water and the top 20 born on land), and every starting creature is a child of two random top brains **of its
  own part** (mean + mutation), so water-born parents have kids that start in the water, land-born parents kids
  that start on land. If nobody of a species in a part is alive or had a baby, that part
  breeds from its **last creatures** instead (the ones still alive at the end first, then the latest to die), and
  only a part that never had that species at all starts from the starter brain. Then the new world starts fresh lists of its own.
- Both species evolve this way. Only the very first world (or a species whose list ended up empty, because
  nobody had a child) starts from the hand-wired starter brains.
- Reloading the page starts over from the starter brains. The server (server/server.js) saves the current
  world's parents, so it can rebuild that world after a restart.

## Starter brains (hand-wired, how the first world begins)
The first world starts with copies of a hand-wired starter brain per species, each copy slightly mutated. Each hidden
neuron has one job (like "grass is to my right" or "carnivore touching me and I'm ready"). Nobody is taught to run away;
that has to evolve.
- **Herbivore starter:**
  1. goes forward
  2. sees grass → turns toward it
  3. on grass (and not full) → eats
  4. another herbivore touching and ready to mate → mates (right after a step, so a failed try doesn't freeze it)
- **Carnivore starter**, in priority order:
  1. ready to mate and sees another carnivore → walks to it and mates once touching
  2. otherwise sees a corpse → goes to the closest one and eats it once in reach
  3. otherwise sees a herbivore → chases the closest one (sprinting) and bites it once in reach
  4. otherwise (no food, nobody to mate with) → goes forward

## Runs (server mode): saved brains and New run
- A **run** is everything from one New run to the next: many worlds, one score.
- Every run keeps its **20 best brains per species so far** (most children, over all its worlds, living creatures
  included) in its own file on the server, `server/brains/<date_time>.json`, saved every 20 s. Old runs are never
  deleted, so their brains stay available.
- **Stopping and starting the server continues the current run** (its current world is rebuilt from that world's
  parents; the score is kept).
- **The server runs on the Mac:** `server/mac.sh start | stop | status` (listens only on 127.0.0.1:8787).
- **Watching:** open [watch.html](watch.html) (it has the Mac's server built in; `watch-taylormomsen.html` has the old
  taylormomsen address; `index.html` alone is a separate local world in your browser).
- **New run:** press **N** (or the **New run** button, top right) in the watcher page. There are **four pickers**:
  herbivores · water, herbivores · land, carnivores · water, carnivores · land. For each one pick the
  genome those creatures start from: **starter brains** (hand-wired), a saved run's **water brains** or **land
  brains** (runs from before there were parts: all their brains), or a **saved brain**. Brains saved when the map
  had rivers count their middle-strip brains as water brains and their side brains as land brains. They're born in the part you
  picked it for. Then **Start**: the new run begins at world 1, score 0:0. Brains with an unknown shape can't be
  picked (older brains from before swimming are upgraded and work). Every run now saves its best 20 brains per
  species **per part of the map**, so later runs can pick them by part.
- While you're not playing, **click any creature** to look inside it:
  - a panel on the right shows its **brain live**: the 32 senses, 16 hidden neurons and 10 outputs. Brighter = more
    active right now; lines are its weights (its own color = positive, gray = negative, brighter = stronger), and
    the action it's choosing right now is lit in its color
  - its **stats**: generation, kids, age and lifespan, energy, health, current action, ready to mate / glowing
  - the world stays bright: you see **its circles**, a ring around it, its vision circle (dashed) and how far it
    sees glowing creatures (dotted). Only while you play is the world dark outside your own vision
- **Any key** exits. Clicking another creature switches to it. It also ends by itself if the creature dies or the
  world restarts.
- Works in server mode too: the page asks the server for that creature's brain about 10 times a second.
- **Save brain** (button, top right of the panel) opens a small box to **name the genome** (Enter or Save saves,
  Esc or Cancel closes it; while you type, keys don't leave the brain viewer). It saves that creature's genes, what its children would inherit (not
  what it learned during its life). On a server it's saved as `server/brains/<date_time>.json` and shows up in the
  **New run** menu as "saved brain: <name> (<creature>, world, kids) · saved <date, time>", for its own species only: a new run started from it breeds every starting
  creature of that species from this one brain (+ mutation). In the local game it downloads a `brain_….json` file.

## You (the player)
- Press **1** for a herbivore or **2** for a carnivore, in the menu or after you die.
- You follow the same one-action-per-tick rule. Holding turn + forward alternates between them.
- Your children get brains: a mix of your partner's brain and a copy of a random brain of your species.
- The white ring marks you, and the dashed circle is your vision radius.
- **While you play, everything outside your vision is dark**, just like for the other creatures. The one exception:
  glowing creatures up to 450 px away shine through the dark, because a mating glow is visible from that far.
- While you only watch (not playing), you see the whole world.

| Key | Action |
|---|---|
| W / ↑ | forward at cruise speed |
| A D / ← → | turn |
| Shift | sprint (max speed) |
| mouse wheel, - / = | change cruise speed |
| E | eat |
| Space | attack |
| C | mate (you glow) |
| T | fast-forward: 1× → 4× → 16× → 32× → 64× (the top-left panel shows the real speed when the computer can't keep up) |
| click a creature | brain viewer (any key exits) |
| N | New run menu (server mode; Esc closes it) |
| P | pause (in watch.html it pauses the server world for everyone watching) |
| W | (while watching) walls where water meets land on / off |
| F | fullscreen on/off (Esc also leaves fullscreen) |

## Achievements
- 22 achievements (see `achievements.js`), each won **only once per run** (over all its worlds); a **New run starts
  them over** (the ending run's are kept in `server/brains/<run id>.achievements.json`): water ones
  (First Swimmer, Carnivore Across, Herbivore Across, New Land, Round Trip, Strait Hunter), hunting (First Blood, Cannibal, Fighting
  Back, Close Call, Serial Hunter, Escape Artist), family (Big Family, Grandparent, Dynasty, Generation 50), life
  (Old Timer, Glutton, Gene Swap) and worlds (Stalemate, Endurance, Comeback).
- When one is won, a pop-up shows it at the bottom (click it to look at that creature's brain, if it's alive).
- **Reset** (at the bottom of the Achievements list, click it twice) starts the current run's achievements over
  in the middle of the run; the cleared ones are kept in `server/brains/` first, like at a New run.
- The **Achievements** button (top right, next to New run) lists them all: who won each one (creature, or
  species), when, and where (run, world, born in the water or on land). The server keeps the current run's in
  `server/achievements.json`; in the local game they start over when you reload the page.
