# Architecture

Roblox demolition-derby game built with **roblox-ts 3.x**. TypeScript in
`src/` compiles to Luau in `out/`, which `default.project.json` (Rojo) maps
into the place:

| Source          | Destination                                | Runs on |
|-----------------|--------------------------------------------|---------|
| `src/server/`   | `ServerScriptService.TS`                   | server  |
| `src/client/`   | `StarterPlayer.StarterPlayerScripts.TS`    | each client |
| `src/shared/`   | `ReplicatedStorage.TS`                     | both    |

`*.server.ts` / `*.client.ts` are entry scripts; plain `.ts` files are
modules. `default.project.json` also pins place settings: Lighting
`Technology = Future`, `StreamingEnabled = false`, HttpService enabled.

## The one idea everything hangs off: network ownership

The full driving simulation (`shared/carSim.ts`) must run on whichever
machine **network-owns the chassis** — constraint forces applied anywhere
else don't stick. Concretely:

- **Player car**: the occupant's client owns the chassis
  (`main.server.ts` sets ownership on seat occupancy change) and
  `carClient.client.ts` steps the sim there.
- **Bot cars**: chassis stays server-owned; `bots.server.ts` steps the same
  sim server-side. Bots therefore obey *identical* physics to the player.
- **Empty player car**: server owns it and `main.server.ts` steps an "idle
  sim" with centred inputs so the car stands on its suspension instead of
  resting on its collider box. A wrecked car (Health 0) gets no input so it
  flops.
- **Knockback on player cars** can't be applied by the server; the server
  fires the `Knock` RemoteEvent at the driving client, which applies the
  delta-v locally (`powerupClient.client.ts`).

## Shared (`src/shared/`)

- **`carConfig.ts`** — car geometry constants: chassis size (9×1.5×16 box
  sized to the buggy shell), wheel radius/width/offsets/names, suspension
  length, steering geometry (`MAX_STEER_ANGLE`, lateral-g steering cap),
  spawn CFrame, per-wheel VectorForce actuator naming helpers. Physics
  (carSim) and visuals (wheelVisuals) both import these so they always agree.
- **`carSim.ts`** (~550 lines) — the entire per-wheel driving simulation:
  spherecast suspension springs, simplified-Pacejka slip-angle tyre model,
  friction circle, weight transfer via per-wheel loads, RWD drivetrain
  (`drivenWheels = [2,3]`), nitro boost read from the `NitroUntil` attribute.
  Forces delivered through per-wheel VectorForce constraints at a roll-centre
  point, updated in `RunService.PreSimulation`. Drifting is emergent, not
  scripted. Exposes `createCarSim(car, chassis)` → `{ step(dt, input?),
  wheelSpin }`. **Read the header comment block before tuning anything** —
  spring/damper values are mass-scaled and the damper has a documented
  stability ceiling.
- **`arenaConfig.ts`** — deterministic crater surface as pure math:
  `groundYAt(x, z)` combines the radial bowl with an undulating 31.5-stud outer
  loop, six descent saddles, broad rollers, swales, and jump ridges. Anything
  placed on the ground (pads, dressing, spawns) uses this same surface.
- **`healthConfig.ts`** — `MAX_HEALTH = 100`, health/bot-score attribute names,
  per-powerup damage table, wreck reset delay (3 s), scoring (1 pt/damage +
  50 wreck bonus into standard `leaderstats.Points`), shared `healthColor()`
  ramp used by HUD and overhead bars.
- **`powerupConfig.ts`** — powerup types + display info (colour/emoji/label/
  directional), 3-slot inventory encoded as string attributes `Slot1..Slot3`
  on the car model (`"bolt:3"` carries charges via `encodeSlot`/`decodeSlot`),
  effect tuning (shield 7 s, nitro 2.5 s ×1.4 speed, barge radius 30), and all
  remote/folder names (`PowerupRemotes.UsePowerup`, `.Knock`, `Pickups`,
  `PowerupFx`, ServerStorage bindable `BotUsePowerup`).

## Server (`src/server/`)

- **`main.server.ts`** — the player's car: builds it via the factory, manages
  network ownership on occupancy change, force-seats players (and re-seats
  after flings/respawns — derby cars have no exits), runs the idle sim for
  the empty car, `keepInWorld` respawn backstop.
- **`carFactory.ts`** — shared builder for every car (player + bots):
  chassis, VehicleSeat, anchored cosmetic wheels, per-wheel VectorForce
  actuators. getOrCreate throughout. Attaches the optional
  `ReplicatedStorage.CarBodyShell` cosmetic shell (see CLAUDE.md); cars must
  keep working without it. Also exports `waitForArenaReady` (waits on the
  `ArenaReady` Workspace attribute), `groundedSpawnCFrame`, `keepInWorld`.
- **`bots.server.ts`** — three bot rivals (`BOT_SPECS`: names/labels/colours)
  driving server-owned cars through the same carSim. Derby brain layered on
  top: velocity-led pure-pursuit ramming with sticky targets, separation
  steering, ram-cycle engage/disengage (peel away after a landed hit or a
  stale 6 s chase), escalating stuck recovery (reverse-out → scatter), flip
  reset, replicated `BotLabel`/`BotPoints` scoreboard state, and opportunistic
  powerup use via the `BotUsePowerup` bindable — the same server-side firing
  path player remotes hit.
- **`powerups.server.ts`** (~880 lines) — pickup pads floating over the
  track (collect radius 12, respawn 20 s), the slot inventory, and all effect
  execution: bolt/shunt projectiles, mines, barge AoE, shield/nitro timers
  (`ShieldUntil`/`NitroUntil` attributes stamped as
  `Workspace.GetServerTimeNow()` timestamps). Owns Health: applies damage
  (shield blocks), handles wreck → 3 s flop → reset, awards points to
  `leaderstats`. Knockback goes direct to server-owned chassis (bots) or via
  the `Knock` remote (player cars).
- **`arena.server.ts`** (~1360 lines) — builds the whole desert crater
  procedurally at boot with a **deterministic seeded PRNG** (seed 1337):
  chunked smooth-terrain voxels sampled from `groundYAt`, canyon rock rim, dressing,
  dust/smoke with a shared `WIND` vector, lighting. Sets
  `Workspace.ArenaReady = true` when the world is solid — car spawning waits
  on this (see the spawn-race known issue in CLAUDE.md).

## Client (`src/client/`)

- **`carClient.client.ts`** — hosts the sim for the local player's car:
  WASD + handbrake input, R = flip reset (3 s cooldown), publishes live sim
  state via `carState.localDrive`.
- **`carState.ts`** — `localDrive`: tiny mutable handoff object (driving,
  steerAngle, throttle, handbrake, wheelSpin) from the driving sim to
  same-client presentation scripts. Remote clients never see it — they
  reconstruct from replicated data (chassis velocity, mirrored seat Steer).
- **`carCamera.client.ts`** — arcade chase camera: swings behind the heading
  at fixed distance/FOV; smooths the *view direction*, not position, so speed
  doesn't read as zoom-out; occlusion raycast respects CanCollide.
- **`wheelVisuals.client.ts`** — wheels are anchored cosmetic parts, so every
  client poses all four wheels of **every** car each frame: suspension travel
  from the same spherecast the physics uses, steer on the fronts, roll from
  ground speed, wheelspin/lock-up from `localDrive` when driving.
- **`hudClient.client.ts`** — ScreenGui: health bar (reads the `Health`
  attribute), powerup slot display, points leaderboard combining player
  `leaderstats` with replicated bot scores.
- **`powerupClient.client.ts`** — fire input (slot keys, backward-fire for
  directional powerups) → `UsePowerup` remote; applies `Knock` impulses
  locally since this client owns the chassis.
- **`overheadHealth.client.ts`** — billboard health bar + driver name above
  every car (hidden on your own; bots keep their server-made BotTag).

## State & communication summary

| Channel | Used for |
|---------|----------|
| Attributes on car model/chassis (`Health`, `Slot1..3`, `NitroUntil`, `ShieldUntil`, `ArenaReady` on Workspace) | replicated state; clients read, server (or driving client for nitro physics) reacts |
| `PowerupRemotes.UsePowerup` (client→server) | fire slot N, optional backward |
| `PowerupRemotes.Knock` (server→driving client) | delta-v on player-owned chassis |
| `ServerStorage.BotUsePowerup` (bindable) | bots fire powerups through the same server path |
| `carState.localDrive` (same-client module) | sim → visuals/HUD handoff |
