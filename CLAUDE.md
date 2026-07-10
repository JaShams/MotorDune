# Desert Demolition Derby (roblox-ts)

A Blur-inspired demolition-derby arcade game: one player car plus three bot
rivals in a procedurally built desert crater arena, with slot-based powerups
(bolt, shunt, mine, barge, shield, nitro), health, wrecks, and points.
Reference footage lives in `concept/` (Blur gameplay video).

See `docs/ARCHITECTURE.md` for the full system map before touching physics,
powerups, or the arena.

## Build & test workflow

- `npm run build` (`rbxtsc`) compiles TypeScript → Luau into `out/`.
  `npm run watch` for continuous builds.
- Rojo (`rojo serve` with `default.project.json`) syncs `out/` into a running
  Roblox Studio session. Assume the user has `rojo serve` running; after a
  build the code is already synced.
- Playtesting is done through the Roblox Studio MCP tools:
  `start_stop_play` to enter/exit play mode, `execute_luau` (server or client
  context) to poke at live state, `get_console_output` for prints/warns,
  `screen_capture` to see the game. Check `get_studio_state` /
  `list_roblox_studios` if the connection seems dead.
- There are no unit tests; verification = build cleanly, then playtest in
  Studio and watch the console for the `[car]` / bot / powerup log lines.

## Hard-won rules (do not rediscover these)

- **roblox-ts / Luau**: function *declarations* do not hoist — calling one
  before its definition compiles fine but is `nil` at runtime. Define before
  use or use `const fn = () => {}`. Watch Luau reserved words in identifiers,
  and the interface-method vs callback-property distinction (`method(this: ...)`).
- **Lighting**: `Light.Range` silently clamps at 60 studs. `Lighting.Technology`
  can only be set via `default.project.json`, not at runtime. Workflow for
  lighting work: live-tune via MCP `execute_luau`, then bake the final values
  back into code.
- **Network ownership is the core design constraint.** Forces only stick on
  the machine that owns the chassis assembly. The driver's client owns and
  simulates the player car; the server owns and simulates bot cars and the
  empty/idle player car. Anything that pushes a player car (knockback etc.)
  must be routed to the driving client via the `Knock` remote, never applied
  server-side.
- **Physics tuning lives in `shared/carSim.ts` and is delicate.** Read its
  header comment first. Spring/damper are absolute forces and must scale with
  chassis mass; `maxSuspensionAcceleration` must exceed `Workspace.Gravity`;
  the damper has a per-frame stability limit (standstill shudder if too high).
  Forces are applied via per-wheel VectorForce constraints updated in
  `PreSimulation` — do not convert these to Heartbeat impulses (oscillates).
- **Known issue (pre-existing, not tuning-related)**: the car can
  intermittently spawn before terrain is solid and fall through.
  `waitForArenaReady` + `keepInWorld` in `carFactory.ts` are the mitigations.
- **Body shell**: cosmetic buggy shell (PUBG buggy, asset 15449163942) is
  prepared in Studio as `ReplicatedStorage.CarBodyShell` — scripts stripped,
  parts massless/non-colliding/non-raycastable, pivot at wheel midpoint,
  paintable hull tagged `BodyPanel`, `SeatOffset` attribute. Everything must
  keep working when the shell is absent (the chassis box is the fallback body).

## Conventions

- All numbers/names two scripts must agree on live in `src/shared/*Config.ts`
  (wheel geometry, arena height profile `groundY()`, attribute/remote names,
  damage tables). Never duplicate a constant into a script — import it.
- Cross-machine state travels as **attributes on the car model/chassis**
  (`Health`, `Slot1..Slot3`, `NitroUntil`, `ShieldUntil`) so it replicates for
  free; clients just read attributes. RemoteEvents only for actions
  (`UsePowerup`, `Knock`).
- Comment style: block comments explain *why* and record tuning rationale —
  keep that density when editing; those comments are the project's memory.
- The arena is deterministic (seeded PRNG in `arena.server.ts`) — keep it
  reproducible.
- Server-side builders use a getOrCreate/adopt pattern so instances left in
  the place file are normalised instead of duplicated.
