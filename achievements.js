// Achievements: each one can be won only once per run (over all its worlds); a New run starts them over.
// The world reports them (World.achieve in world.js, plus the world-end ones in main.js / server.js); the
// server keeps the current run's in server/achievements.json (an ended run's in brains/<run id>.achievements.json).

const ACHIEVEMENTS = [
  // rivers and swimming
  { id: "swimmer", title: "First Swimmer", desc: "the first creature to step into a river" },
  { id: "crossedCarnivore", title: "Carnivore Across", desc: "the first carnivore to cross a river all the way" },
  { id: "crossedHerbivore", title: "Herbivore Across", desc: "the first herbivore to cross a river all the way" },
  { id: "newLand", title: "New Land", desc: "the first creature to have a baby on the other side of the river from where it was born" },
  { id: "roundTrip", title: "Round Trip", desc: "the first creature to cross a river and come back" },
  { id: "straitHunter", title: "Strait Hunter", desc: "the first carnivore to kill a herbivore that's in the water" },
  // hunting and survival
  { id: "firstBlood", title: "First Blood", desc: "the first herbivore killed by a carnivore" },
  { id: "cannibal", title: "Cannibal", desc: "the first carnivore to kill another carnivore" },
  { id: "fightingBack", title: "Fighting Back", desc: "the first herbivore to kill a carnivore" },
  { id: "closeCall", title: "Close Call", desc: "the first herbivore to get bitten and still be alive 10 s later" },
  { id: "serialHunter", title: "Serial Hunter", desc: "the first carnivore to kill 5 herbivores in one life" },
  { id: "escapeArtist", title: "Escape Artist", desc: "the first herbivore to get away after a carnivore was locked on it for 10 s" },
  // family
  { id: "bigFamily", title: "Big Family", desc: "the first creature with 10 kids" },
  { id: "grandparent", title: "Grandparent", desc: "the first creature to have a great-grandchild" },
  { id: "dynasty", title: "Dynasty", desc: "the first creature with a family score of 50 (kids + grandkids + great-grandkids)" },
  { id: "gen50", title: "Generation 50", desc: "the first creature of generation 50" },
  // life
  { id: "oldTimer", title: "Old Timer", desc: "the first creature to die of old age with (almost) full energy" },
  { id: "glutton", title: "Glutton", desc: "the first herbivore to eat itself to full energy" },
  { id: "geneSwap", title: "Gene Swap", desc: "the first baby whose parents were born on different sides of the river" },
  // worlds and runs
  { id: "stalemate", title: "Stalemate", desc: "the first world to end in a tie" },
  { id: "endurance", title: "Endurance", desc: "the first world to last 10 minutes" },
  { id: "comeback", title: "Comeback", desc: "a species wins a world right after losing the last 5" },
];
