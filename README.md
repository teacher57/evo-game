# Evo game

Carnivores and herbivores with tiny neural-network brains that evolve only by breeding (plus a little
learning during life). Two rivers split the world into islands; creatures can learn to swim across.
Plain JavaScript, no build step. AI friendly.

## Run it
- **In the browser:** open [index.html](index.html). Watch, or press 1 / 2 to play a herbivore / carnivore.
- **As a server** (keeps evolving with nobody watching): `node server/server.js 8787 127.0.0.1`, then open
  [watch.html](watch.html). On a Mac, `server/mac.sh start|stop|status` does the same in the background.

## Files
- [RULES.md](RULES.md): every rule of the world, the brains, breeding, rivers and achievements.
- [config.js](config.js): all the numbers. [world.js](world.js): the simulation. [brain.js](brain.js): brains,
  breeding and the top-brains hall. [achievements.js](achievements.js): the achievements list.
- [main.js](main.js), [player.js](player.js), [index.html](index.html): the page and the keyboard player.
- [server/server.js](server/server.js): runs worlds forever and streams them to watch pages.
- `server/brains/`, `server/state.json`: saved runs and brains; `server/taylormomsen-final/`: an older
  snapshot from a second machine.

## License
MIT, see [LICENSE](LICENSE).
