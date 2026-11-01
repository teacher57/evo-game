// All tunable numbers in one place. Balance the world by editing this file.
const deg = (d) => (d * Math.PI) / 180;

const C = {
  WORLD_W: 1920, WORLD_H: 1080, // world size in world pixels (Full HD); the view scales it to fit
  WALL: 10,                     // solid walls on the top and bottom; left-right wraps around
  SWIM_SPEED: 0.5,              // speed factor in the water (you can only step in with the brain's swim output on)
  SWIM_COST: 2,                 // swimming costs this many times the energy of walking forward at the same speed
  WATER_WALL: 6,                // thickness of the walls W puts where water meets land
  WATER_HALF: true,             // the left half of the world is water (grass grows there too), the right half land
  FPS: 30,                      // simulation ticks per second
  SEED: null,                   // set a number for a repeatable world

  // Grass: a grid of squares, each holding 0..GRASS_MAX food. Grass only grows from grass:
  // a square grows from its own grass (logistic) and spreads into its 4 neighbors.
  // A square with no grass and no grassy neighbors stays bare forever.
  GRASS_CELL: 40,
  GRASS_MAX: 40,
  GRASS_REGROW: 0.0004,
  GRASS_SPREAD: 0.0001,         // growth pushed into a square per unit of its neighbors' average grass
  GRASS_START_FRACTION: 0.35,

  // Actions
  TURN_ANGLE: deg(10),          // "small angle" per left/right action
  TURN_COST: 0.01,
  MOVE_COST_K: 0.01,            // forward costs MOVE_COST_K * speed^2 energy
  ATTACK_COST: 0.6,
  ATTACK_REACH: 4,              // extra gap beyond touching bodies
  ATTACK_ARC: deg(90),          // target must be in front of the mouth, inside this arc
  EAT_REACH: 6,
  MATE_REACH: 8,
  HEALTH_REGEN: 0.05,           // per tick, while energy is above half
  CORPSE_DECAY: 0.03,           // meat lost per tick (rots into grass)
  // Corpses fertilize the ground: rotting meat turns into grass on its square (CORPSE_TO_GRASS per unit),
  // and grass there grows faster the more meat lies on it: growth x (1 + meat / FERTILE_MEAT).
  // Every unit of grass grown on a corpse's square uses up one unit of its meat.
  CORPSE_TO_GRASS: 1,
  FERTILE_MEAT: 30,

  MAX_CREATURES: 100,           // herbivores + carnivores together; no baby is born while the world is full
  HALL_SIZE: 20,                // best brains kept per species (most children); a restarted world breeds from them
  HALL_MAX_GLOW: 0.5,           // herbivores that glowed more than this share of their life don't count as top brains
  HALL_SPECIES: ["herbivore", "carnivore"], // species whose new worlds breed from the last world's top brains

  // Brains (brain.js): child weights = parents' mean + gauss(0, MUTATION_SIGMA) on every weight,
  // and with probability MUTATION_BIG_RATE an extra gauss(0, MUTATION_BIG_SIGMA) jump.
  BRAIN_HIDDEN: 16,

  // Learning during life (brain.js): every tick, weight += LEARN_RATE * reward * trace, where the trace is
  // how active that connection was recently (it fades by TRACE_FADE per tick, ~1 s memory).
  LEARN_RATE: 0.003,            // starting value of the learning-rate GENE (it evolves, see LR_MUTATION)
  LR_MUTATION: 0.3,             // child learning rate = parents' geometric mean x e^gauss(0, this), about +-30%
  LR_RANGE: [0.00001, 0.05],
  TRACE_FADE: 0.97,
  WEIGHT_LIMIT: 250,
  LEARN_HIDDEN: false,          // false: only the hidden -> action connections learn; senses stay as evolved (tested best)
  BASELINE_FADE: 0.99,          // learn from reward minus its running average ("better than usual"); 1 = no baseline
  USE_BASELINE: true,
  REWARD_FOOD: 10,              // x (energy gained / max energy)
  REWARD_BABY: 5,               // each parent, per baby
  REWARD_HURT: 10,              // x (health lost / max health), as a punishment
  REWARD_FAILED_BITE: 0.05,     // punishment for an attack that hit nothing
  REWARD_WALL: 0.02,            // punishment for walking into the top/bottom wall
  MUTATION_SIGMA: 0.05,
  MUTATION_BIG_RATE: 0.02,
  MUTATION_BIG_SIGMA: 0.4,

  // Choosing "mate" with at least mateEnergy makes a creature glow for GLOW_TICKS. Everyone, of either species,
  // can see a glowing creature from GLOW_RANGE away, much farther than normal vision.
  GLOW_TICKS: 45,
  GLOW_RANGE: 450,
  GLOW_COST: 0.0002,            // energy per glowing tick, as a fraction of maxEnergy (a full glow = 0.9%)

  BUCKET: 80,                   // spatial-grid cell size for neighbor search
  HISTORY_EVERY: 10,            // population graph sample rate (ticks)

  SPECIES: {
    herbivore: {
      label: "herbivore",
      radius: 10,
      maxSpeed: 2.5,
      maxEnergy: 100,
      maxHealth: 60,
      aliveCost: 0.015,
      visionRange: 150,
      bite: 5,
      eatRate: 2.5,
      corpseMeat: 90,
      mateEnergy: 40,
      mateCost: 18,
      childEnergy: 50,
      mateCooldown: 150,
      learnRate: 0.01, // fixed learning gene for every herbivore (0 = it evolves, see LR_MUTATION)
      mutationScaled: 0.02, // children's weights also get gauss(0, this x |weight|): big weights mutate in proportion
      startPerSide: 20, // born in the water, and again on land (no water: 2x anywhere)
      lifespan: [25, 35],        // seconds, random in this range; then it dies of old age
      fleeDist: 150,
    },
    carnivore: {
      label: "carnivore",
      radius: 15,
      maxSpeed: 3.5,
      maxEnergy: 200,
      maxHealth: 100,
      aliveCost: 0.05,
      visionRange: 220,
      bite: 20,
      eatRate: 6,
      corpseMeat: 120,
      mateEnergy: 120,
      mateCost: 45,
      childEnergy: 90,
      mateCooldown: 300,
      learnRate: 0.02, // fixed learning gene for every carnivore
      mutationScaled: 0, // (0 = off; carnivores' precise reach rules break with it)
      startPerSide: 5,
      lifespan: [50, 70],
    },
  },
};
