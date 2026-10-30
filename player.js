// Keyboard brain for the creature you play.
//
// It obeys the same rule as every bot: exactly one action per tick. Holding turn + forward
// alternates between them, so you can't out-move the other creatures by pressing two keys.

class PlayerController {
  constructor() {
    this.keys = new Set(); // KeyboardEvent.code values currently held, set by main.js
    this.speedFrac = 0.5;  // cruise speed as a fraction of maxSpeed
    this.tick = 0;
  }

  changeSpeed(delta) {
    this.speedFrac = Math.round(Math.max(0, Math.min(1, this.speedFrac + delta)) * 100) / 100;
  }

  act(me, world) {
    this.tick++;
    const k = this.keys;
    if (k.has("Space")) return ["attack", 0];
    if (k.has("KeyE")) return ["eat", 0];
    if (k.has("KeyC")) return ["mate", 0];
    let turn = null;
    if (k.has("KeyA") || k.has("ArrowLeft")) turn = "left";
    else if (k.has("KeyD") || k.has("ArrowRight")) turn = "right";
    const forward = k.has("KeyW") || k.has("ArrowUp");
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    const speed = me.spec.maxSpeed * (sprint ? 1 : this.speedFrac);
    if (turn && forward) return this.tick % 2 ? [turn, 0] : ["forward", speed];
    if (turn) return [turn, 0];
    if (forward) return ["forward", speed];
    return ["forward", 0]; // standing still = forward at speed 0
  }
}
