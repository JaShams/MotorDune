import { Players, ReplicatedStorage, RunService, ServerStorage, TweenService, Workspace } from "@rbxts/services";
import { groundYAt, TRACK_CENTER_RADIUS } from "shared/arenaConfig";
import { CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import {
	BARGE_RADIUS,
	BOLT_CHARGES,
	BOT_USE_EVENT,
	decodeSlot,
	encodeSlot,
	FX_FOLDER,
	KNOCK_REMOTE,
	MAX_SLOTS,
	NITRO_DURATION,
	NITRO_UNTIL_ATTR,
	PICKUPS_FOLDER,
	POWERUP_INFO,
	POWERUP_TYPES,
	PowerupType,
	REMOTES_FOLDER,
	SHIELD_DURATION,
	SHIELD_UNTIL_ATTR,
	SLOT_ATTRS,
	USE_REMOTE,
} from "shared/powerupConfig";
import {
	BOT_POINTS_ATTR,
	HEALTH_ATTR,
	LEADERSTATS_NAME,
	MAX_HEALTH,
	POINTS_NAME,
	POWERUP_DAMAGE,
	WRECK_BONUS_POINTS,
	WRECK_RESET_SECONDS,
} from "shared/healthConfig";

// ---------------------------------------------------------------------------
// Blur-style power-ups. Pads float above the track; driving through one adds
// it to the car's 3-slot inventory (attributes on the car model). Firing goes
// through a RemoteEvent; knockback on player-driven cars is routed to the
// driving client because it network-owns the chassis, so server impulses
// wouldn't replicate.
// ---------------------------------------------------------------------------

const COLLECT_RADIUS = 12; // scaled with the buggy-sized chassis (16 studs long)
const PAD_RESPAWN_SECONDS = 20;

const BOLT_SPEED = 380;
const BOLT_LIFETIME = 1.6;
const BOLT_KNOCK = 26; // delta-v (studs/s) given to a struck car

const SHUNT_SPEED = 170;
const SHUNT_LIFETIME = 5;
// Tight enough to stay locked through a target's evasive arc: the turn radius
// is speed/rate ~ 40 studs. (140 deg/s gave a 70-stud radius - one overshoot
// and the missile could only orbit its target, never re-converge.)
const SHUNT_TURN_RATE = math.rad(240); // per second
const SHUNT_CONE = math.rad(75); // targets must be within this half-angle of fire direction
const SHUNT_BLAST_RADIUS = 16;
// Proximity fuse: homing converges to "almost touching" a moving car, where a
// thin per-frame raycast can slip past the 1-stud chassis slab without ever
// registering. Passing within this range of any car it can hurt detonates the
// missile; the blast radius comfortably covers the near-missed victim.
const SHUNT_PROXIMITY = 11; // ~chassis half-diagonal (9.2) + the old 1.2 margin
const SHUNT_KNOCK = 52;
const SHUNT_GROUND_CLEARANCE = 2.5;
const SHUNT_INTERCEPT_RADIUS = 2.4;
// Bolts stay dumbfire, but sweep a bolt-sized sphere instead of a zero-width
// ray so grazing a moving car counts as the hit it looks like.
const BOLT_HIT_RADIUS = 1.2;

const MINE_ARM_DELAY = 1.2;
const MINE_LIFETIME = 60;
const MINE_TRIGGER_RADIUS = 11; // trips ~3 studs before the 8-stud nose touches
const MINE_KNOCK_UP = 42;
const MINE_KNOCK_AWAY = 28;

const BARGE_KNOCK = 46;

// --- Remotes ----------------------------------------------------------------
const remotes = new Instance("Folder");
remotes.Name = REMOTES_FOLDER;
const useRemote = new Instance("RemoteEvent");
useRemote.Name = USE_REMOTE;
useRemote.Parent = remotes;
const knockRemote = new Instance("RemoteEvent");
knockRemote.Name = KNOCK_REMOTE;
knockRemote.Parent = remotes;
remotes.Parent = ReplicatedStorage;

const fxFolder = new Instance("Folder");
fxFolder.Name = FX_FOLDER;
fxFolder.Parent = Workspace;

const pickupsFolder = new Instance("Folder");
pickupsFolder.Name = PICKUPS_FOLDER;
pickupsFolder.Parent = Workspace;

// --- Car helpers -------------------------------------------------------------
function getCars(): Model[] {
	const cars = new Array<Model>();
	for (const child of Workspace.GetChildren()) {
		if (child.IsA("Model") && child.FindFirstChild(CHASSIS_NAME) && child.FindFirstChild(SEAT_NAME)) {
			cars.push(child);
		}
	}
	return cars;
}

function getChassis(car: Model) {
	const chassis = car.FindFirstChild(CHASSIS_NAME);
	return chassis?.IsA("BasePart") ? chassis : undefined;
}

function getDriver(car: Model): Player | undefined {
	const seat = car.FindFirstChild(SEAT_NAME);
	if (!seat?.IsA("VehicleSeat")) return undefined;
	const character = seat.Occupant?.Parent;
	return character ? Players.GetPlayerFromCharacter(character) : undefined;
}

function getPlayerCar(player: Player): Model | undefined {
	for (const car of getCars()) {
		if (getDriver(car) === player) return car;
	}
	return undefined;
}

function isShielded(car: Model) {
	const shieldUntil = (car.GetAttribute(SHIELD_UNTIL_ATTR) as number | undefined) ?? 0;
	return Workspace.GetServerTimeNow() < shieldUntil;
}

// --- Scoring -------------------------------------------------------------------
// Points live in leaderstats so the built-in player list shows them; the HUD
// leaderboard reads the same values.
function initLeaderstats(player: Player) {
	if (player.FindFirstChild(LEADERSTATS_NAME)) return;
	const stats = new Instance("Folder");
	stats.Name = LEADERSTATS_NAME;
	const points = new Instance("IntValue");
	points.Name = POINTS_NAME;
	points.Value = 0;
	points.Parent = stats;
	stats.Parent = player;
}

Players.PlayerAdded.Connect(initLeaderstats);
for (const player of Players.GetPlayers()) initLeaderstats(player);

function addPoints(player: Player, amount: number) {
	const points = player.FindFirstChild(LEADERSTATS_NAME)?.FindFirstChild(POINTS_NAME);
	if (points?.IsA("IntValue")) points.Value += amount;
}

function addCarPoints(car: Model, amount: number) {
	const driver = getDriver(car);
	if (driver) {
		addPoints(driver, amount);
	} else if (car.GetAttribute("IsBot") === true) {
		const points = (car.GetAttribute(BOT_POINTS_ATTR) as number | undefined) ?? 0;
		car.SetAttribute(BOT_POINTS_ATTR, points + amount);
	}
}

// --- Health --------------------------------------------------------------------
function wreckCar(car: Model, attacker?: Model) {
	const chassis = getChassis(car);
	if (chassis) {
		explosionFx(chassis.Position, Color3.fromRGB(255, 120, 30), 18);
		applyKnock(car, new Vector3(0, 55, 0), new Vector3(2.5, 6, 2.5));
	}

	// A wreck dumps the car's held powerups.
	for (const attr of SLOT_ATTRS) car.SetAttribute(attr, "");

	if (attacker) addCarPoints(attacker, WRECK_BONUS_POINTS);

	task.delay(WRECK_RESET_SECONDS, () => {
		if (car.IsDescendantOf(game)) car.SetAttribute(HEALTH_ATTR, MAX_HEALTH);
	});
}

function damageCar(car: Model, amount: number, attacker?: Model) {
	const health = (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? MAX_HEALTH;
	if (health <= 0) return; // already wrecked, waiting to reset

	const newHealth = math.max(0, health - amount);
	car.SetAttribute(HEALTH_ATTR, newHealth);

	const scoringAttacker = attacker !== undefined && attacker !== car ? attacker : undefined;
	if (scoringAttacker) addCarPoints(scoringAttacker, math.floor(amount));

	if (newHealth <= 0) wreckCar(car, scoringAttacker);
}

// Physically shove a car. Player-driven chassis are simulated on the driver's
// machine, so the impulse is sent there; idle cars are server-owned.
function applyKnock(car: Model, deltaV: Vector3, angularDeltaV = Vector3.zero) {
	const chassis = getChassis(car);
	if (!chassis) return;

	const driver = getDriver(car);
	if (driver) {
		knockRemote.FireClient(driver, chassis, deltaV, angularDeltaV);
	} else {
		chassis.ApplyImpulse(deltaV.mul(chassis.AssemblyMass));
		if (angularDeltaV.Magnitude > 0) {
			chassis.ApplyAngularImpulse(angularDeltaV.mul(chassis.AssemblyMass));
		}
	}
}

// A powerup hit: shield blocks both the shove and the damage; otherwise the
// attacker (if any, and not the victim itself) earns points for the damage.
function knockCar(car: Model, deltaV: Vector3, angularDeltaV = Vector3.zero, attacker?: Model, damage = 0) {
	if (isShielded(car)) return;
	if (damage > 0) damageCar(car, damage, attacker);
	applyKnock(car, deltaV, angularDeltaV);
}

// --- Inventory ---------------------------------------------------------------
function addToInventory(car: Model, kind: PowerupType) {
	for (const attr of SLOT_ATTRS) {
		const current = (car.GetAttribute(attr) as string | undefined) ?? "";
		if (current === "") {
			car.SetAttribute(attr, kind === "bolt" ? encodeSlot("bolt", BOLT_CHARGES) : encodeSlot(kind));
			return true;
		}
	}
	return false; // all 3 slots full
}

// --- Pickup pads ---------------------------------------------------------------
interface Pad {
	model: Model;
	core: BasePart;
	light: PointLight;
	kind: PowerupType;
	position: Vector3;
	active: boolean;
}

const pads = new Array<Pad>();

// Deterministic RNG so the pad layout is identical every run.
let seed = 9021;
function rand() {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
}

function groundHeight(x: number, z: number) {
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Include;
	params.FilterDescendantsInstances = [Workspace.Terrain];
	const hit = Workspace.Raycast(new Vector3(x, 200, z), new Vector3(0, -400, 0), params);
	return hit ? hit.Position.Y : 0;
}

function createPad(position: Vector3, kind: PowerupType) {
	const info = POWERUP_INFO[kind];

	const model = new Instance("Model");
	model.Name = "Pickup";
	model.SetAttribute("Kind", kind);

	// Neon gem the client spins/bobs locally (server never moves it, so the
	// idle pads cost no replication bandwidth).
	const core = new Instance("Part");
	core.Name = "Core";
	core.Anchored = true;
	core.CanCollide = false;
	core.CanTouch = false;
	core.CanQuery = false;
	core.Material = Enum.Material.Neon;
	core.Color = info.color;
	core.Size = new Vector3(2.6, 2.6, 2.6);
	core.CFrame = new CFrame(position).mul(CFrame.Angles(math.rad(45), 0, math.rad(45)));
	core.Parent = model;

	const light = new Instance("PointLight");
	light.Color = info.color;
	light.Brightness = 2;
	light.Range = 14;
	light.Parent = core;

	const billboard = new Instance("BillboardGui");
	billboard.Size = UDim2.fromScale(3, 3);
	billboard.StudsOffset = new Vector3(0, 3, 0);
	billboard.AlwaysOnTop = false;
	billboard.MaxDistance = 220;
	billboard.Parent = core;

	const label = new Instance("TextLabel");
	label.BackgroundTransparency = 1;
	label.Size = UDim2.fromScale(1, 1);
	label.Text = info.emoji;
	label.TextScaled = true;
	label.Parent = billboard;

	model.Parent = pickupsFolder;

	pads.push({ model, core, light, kind, position, active: true });
}

function setPadVisible(pad: Pad, visible: boolean) {
	pad.active = visible;
	pad.core.Transparency = visible ? 0 : 1;
	pad.light.Enabled = visible;
	const billboard = pad.core.FindFirstChildOfClass("BillboardGui");
	if (billboard) billboard.Enabled = visible;
}

// Pad heights come from the same analytic surface sampled by the terrain
// builder, so ring undulation and bowl features cannot leave pads floating.
function spawnPads() {
	const float = 3.5; // gem height above the ground

	// Single pads around the track ring.
	const ringPads = 14;
	const ringRadius = TRACK_CENTER_RADIUS;
	for (let i = 0; i < ringPads; i++) {
		const angle = (i / ringPads) * math.pi * 2;
		const x = math.cos(angle) * ringRadius;
		const z = math.sin(angle) * ringRadius;
		const kind = POWERUP_TYPES[math.floor(rand() * POWERUP_TYPES.size()) % POWERUP_TYPES.size()];
		createPad(new Vector3(x, groundYAt(x, z) + float, z), kind);
	}

	// A scattering inside the basin for demolition brawls.
	for (const [ringRadius, count] of [
		[150, 8],
		[280, 10],
	] as [number, number][]) {
		for (let i = 0; i < count; i++) {
			const angle = (i / count) * math.pi * 2 + rand();
			const x = math.cos(angle) * ringRadius;
			const z = math.sin(angle) * ringRadius;
			const kind = POWERUP_TYPES[math.floor(rand() * POWERUP_TYPES.size()) % POWERUP_TYPES.size()];
			createPad(new Vector3(x, groundYAt(x, z) + float, z), kind);
		}
	}
}

// Poll pad pickups (deterministic, immune to Touched flakiness at 150 studs/s).
function startPickupLoop() {
	task.spawn(() => {
		while (true) {
			task.wait(0.05);
			const cars = getCars();
			for (const pad of pads) {
				if (!pad.active) continue;
				for (const car of cars) {
					const chassis = getChassis(car);
					if (!chassis) continue;
					if (chassis.Position.sub(pad.position).Magnitude > COLLECT_RADIUS) continue;
					if (!addToInventory(car, pad.kind)) continue; // inventory full: leave the pad

					setPadVisible(pad, false);
					task.delay(PAD_RESPAWN_SECONDS, () => setPadVisible(pad, true));
					break;
				}
			}
		}
	});
}

// --- FX helpers ----------------------------------------------------------------
function explosionFx(position: Vector3, color: Color3, radius: number) {
	const blast = new Instance("Part");
	blast.Shape = Enum.PartType.Ball;
	blast.Anchored = true;
	blast.CanCollide = false;
	blast.CanQuery = false;
	blast.CanTouch = false;
	blast.Material = Enum.Material.Neon;
	blast.Color = color;
	blast.Transparency = 0.2;
	blast.Size = new Vector3(2, 2, 2);
	blast.Position = position;
	blast.Parent = fxFolder;

	const tween = TweenService.Create(blast, new TweenInfo(0.35, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
		Size: new Vector3(radius * 2, radius * 2, radius * 2),
		Transparency: 1,
	});
	tween.Play();
	task.delay(0.4, () => blast.Destroy());
}

function attachTrail(part: BasePart, color: Color3, width: number) {
	const a0 = new Instance("Attachment");
	a0.Position = new Vector3(0, width / 2, 0);
	a0.Parent = part;
	const a1 = new Instance("Attachment");
	a1.Position = new Vector3(0, -width / 2, 0);
	a1.Parent = part;
	const trail = new Instance("Trail");
	trail.Attachment0 = a0;
	trail.Attachment1 = a1;
	trail.Color = new ColorSequence(color);
	trail.LightEmission = 1;
	trail.Lifetime = 0.25;
	trail.WidthScale = new NumberSequence(1, 0);
	trail.Parent = part;
}

// --- Projectiles (bolts + shunt missiles) ----------------------------------------
interface Projectile {
	part: BasePart;
	velocity: Vector3;
	firer: Model;
	expiresAt: number;
	kind: "bolt" | "shunt";
	target?: Model;
	active: boolean;
}

const projectiles = new Array<Projectile>();

interface ActiveMine {
	part: BasePart;
	owner: Model;
	armedAt: number;
	diesAt: number;
	active: boolean;
}

const activeMines = new Array<ActiveMine>();

function projectileRayParams(firer: Model) {
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Exclude;
	params.FilterDescendantsInstances = [firer, fxFolder, pickupsFolder];
	params.IgnoreWater = true;
	return params;
}

function carFromHit(instance: Instance): Model | undefined {
	for (const car of getCars()) {
		if (instance.IsDescendantOf(car)) return car;
	}
	return undefined;
}

function muzzleCFrame(car: Model, backward: boolean) {
	const chassis = getChassis(car);
	if (!chassis) return undefined;
	const direction = backward ? chassis.CFrame.LookVector.mul(-1) : chassis.CFrame.LookVector;
	const origin = chassis.Position.add(direction.mul(10)).add(new Vector3(0, 1, 0)); // clear of the 8-stud nose
	return CFrame.lookAt(origin, origin.add(direction));
}

function fireBolt(car: Model, backward: boolean) {
	const muzzle = muzzleCFrame(car, backward);
	const chassis = getChassis(car);
	if (!muzzle || !chassis) return;

	const bolt = new Instance("Part");
	bolt.Name = "Bolt";
	bolt.Anchored = true;
	bolt.CanCollide = false;
	bolt.CanQuery = false;
	bolt.CanTouch = false;
	bolt.Material = Enum.Material.Neon;
	bolt.Color = POWERUP_INFO.bolt.color;
	bolt.Size = new Vector3(0.7, 0.7, 3.2);
	bolt.CFrame = muzzle;
	attachTrail(bolt, POWERUP_INFO.bolt.color, 0.7);
	bolt.Parent = fxFolder;

	// Inherit the car's speed so bolts always outrun the shooter.
	const carSpeed = chassis.AssemblyLinearVelocity.Dot(muzzle.LookVector);
	projectiles.push({
		part: bolt,
		velocity: muzzle.LookVector.mul(BOLT_SPEED + math.max(0, carSpeed)),
		firer: car,
		expiresAt: os.clock() + BOLT_LIFETIME,
		kind: "bolt",
		active: true,
	});
}

// Nearest car inside the aiming cone of the fired direction ("closest on
// screen"). Fired backwards, it looks for cars behind instead.
function findShuntTarget(firer: Model, origin: Vector3, direction: Vector3): Model | undefined {
	let best: Model | undefined;
	let bestDistance = math.huge;
	for (const car of getCars()) {
		if (car === firer) continue;
		const chassis = getChassis(car);
		if (!chassis) continue;
		const offset = chassis.Position.sub(origin);
		const distance = offset.Magnitude;
		if (distance < 1 || distance >= bestDistance) continue;
		const angle = math.acos(math.clamp(offset.Unit.Dot(direction), -1, 1));
		if (angle > SHUNT_CONE) continue;
		best = car;
		bestDistance = distance;
	}
	return best;
}

function fireShunt(car: Model, backward: boolean) {
	const muzzle = muzzleCFrame(car, backward);
	if (!muzzle) return;
	const flatLook = new Vector3(muzzle.LookVector.X, 0, muzzle.LookVector.Z);
	const launchDirection = flatLook.Magnitude > 0.01 ? flatLook.Unit : new Vector3(0, 0, -1);

	const missile = new Instance("Part");
	missile.Name = "Shunt";
	missile.Anchored = true;
	missile.CanCollide = false;
	missile.CanQuery = false;
	missile.CanTouch = false;
	missile.Material = Enum.Material.Neon;
	missile.Color = POWERUP_INFO.shunt.color;
	missile.Size = new Vector3(1.2, 1.2, 4.5);
	missile.CFrame = muzzle;
	attachTrail(missile, POWERUP_INFO.shunt.color, 1.2);
	const light = new Instance("PointLight");
	light.Color = POWERUP_INFO.shunt.color;
	light.Brightness = 3;
	light.Range = 16;
	light.Parent = missile;
	missile.Parent = fxFolder;

	projectiles.push({
		part: missile,
		velocity: launchDirection.mul(SHUNT_SPEED),
		firer: car,
		expiresAt: os.clock() + SHUNT_LIFETIME,
		kind: "shunt",
		target: findShuntTarget(car, muzzle.Position, muzzle.LookVector),
		active: true,
	});
}

function explodeShunt(position: Vector3, firer?: Model) {
	explosionFx(position, POWERUP_INFO.shunt.color, SHUNT_BLAST_RADIUS);
	for (const car of getCars()) {
		if (car === firer) continue; // your own missile can't blast you
		const chassis = getChassis(car);
		if (!chassis) continue;
		const offset = chassis.Position.sub(position);
		if (offset.Magnitude > SHUNT_BLAST_RADIUS) continue;
		const flat = new Vector3(offset.X, 0, offset.Z);
		const away = flat.Magnitude > 0.5 ? flat.Unit : new Vector3(0, 0, 1);
		knockCar(
			car,
			away.mul(SHUNT_KNOCK).add(new Vector3(0, SHUNT_KNOCK * 0.55, 0)),
			new Vector3(0, 3, 0),
			firer,
			POWERUP_DAMAGE.shunt,
		);
	}
}

// Lifecycle changes funnel through these helpers. Interceptors and the normal
// simulation can notice the same object in one frame, so the active flag must
// be cleared before any FX or damage is produced.
function finishProjectile(
	projectile: Projectile,
	damagingShunt: boolean,
	position = projectile.part.Position,
	excludeFirer = true,
) {
	if (!projectile.active) return;
	projectile.active = false;
	if (projectile.kind === "shunt" && damagingShunt) explodeShunt(position, excludeFirer ? projectile.firer : undefined);
	projectile.part.Destroy();
}

function cancelShunt(projectile: Projectile, position = projectile.part.Position) {
	if (!projectile.active || projectile.kind !== "shunt") return;
	projectile.active = false;
	// A smaller, cooler pop distinguishes a successful counter from the orange
	// damaging blast without applying damage or knockback.
	explosionFx(position, Color3.fromRGB(150, 220, 255), 5);
	projectile.part.Destroy();
}

function segmentDistance(point: Vector3, start: Vector3, step: Vector3) {
	const lengthSquared = step.Dot(step);
	if (lengthSquared < 1e-6) return point.sub(start).Magnitude;
	const t = math.clamp(point.sub(start).Dot(step) / lengthSquared, 0, 1);
	return point.sub(start.add(step.mul(t))).Magnitude;
}

function sampleShuntGround(x: number, z: number, referenceY: number) {
	const fallbackY = groundYAt(x, z);
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Include;
	params.FilterDescendantsInstances = [Workspace.Terrain];
	params.IgnoreWater = true;
	const rayTop = math.max(referenceY, fallbackY) + 80;
	const hit = Workspace.Raycast(new Vector3(x, rayTop, z), new Vector3(0, -200, 0), params);
	if (hit) return { y: hit.Position.Y, normal: hit.Normal };

	// Terrain can briefly be unavailable during streaming/build transitions.
	// Derive a stable slope normal from the same deterministic height function
	// used to build the arena rather than letting the missile fly vertically.
	const sample = 2;
	const dx = groundYAt(x + sample, z) - groundYAt(x - sample, z);
	const dz = groundYAt(x, z + sample) - groundYAt(x, z - sample);
	return { y: fallbackY, normal: new Vector3(-dx, sample * 2, -dz).Unit };
}

function shuntPathParams(firer: Model) {
	const params = projectileRayParams(firer);
	params.FilterDescendantsInstances = [firer, fxFolder, pickupsFolder, Workspace.Terrain];
	return params;
}

RunService.Heartbeat.Connect((dt) => {
	const now = os.clock();
	for (let i = projectiles.size() - 1; i >= 0; i--) {
		const projectile = projectiles[i];
		if (!projectile.active) continue;

		if (now >= projectile.expiresAt || !projectile.part.IsDescendantOf(game)) {
			finishProjectile(projectile, projectile.kind === "shunt" && projectile.part.IsDescendantOf(game));
			continue;
		}

		// Proximity fuse (see SHUNT_PROXIMITY): detonate on any car close to the
		// flight path, not just the locked target - whoever it grazes.
		if (projectile.kind === "shunt") {
			let fused = false;
			for (const car of getCars()) {
				if (car === projectile.firer) continue;
				const chassis = getChassis(car);
				if (!chassis) continue;
				if (chassis.Position.sub(projectile.part.Position).Magnitude <= SHUNT_PROXIMITY) {
					fused = true;
					break;
				}
			}
			if (fused) {
				finishProjectile(projectile, true);
				continue;
			}
		}

		// Homing: bend the velocity toward the target, capped by turn rate.
		if (projectile.kind === "shunt" && projectile.target && projectile.target.IsDescendantOf(game)) {
			const targetChassis = getChassis(projectile.target);
			if (targetChassis) {
				const offset = targetChassis.Position.sub(projectile.part.Position);
				const desired = new Vector3(offset.X, 0, offset.Z);
				if (desired.Magnitude > 0.5) {
					const flatVelocity = new Vector3(projectile.velocity.X, 0, projectile.velocity.Z);
					const currentDir = flatVelocity.Magnitude > 0.01 ? flatVelocity.Unit : desired.Unit;
					const desiredDir = desired.Unit;
					const angle = math.acos(math.clamp(currentDir.Dot(desiredDir), -1, 1));
					const maxStep = SHUNT_TURN_RATE * dt;
					const t = angle > 1e-3 ? math.min(1, maxStep / angle) : 1;
					const newDir = currentDir.Lerp(desiredDir, t).Unit;
					projectile.velocity = newDir.mul(SHUNT_SPEED);
				}
			}
		}

		const step = projectile.velocity.mul(dt);

		if (projectile.kind === "bolt") {
			for (const other of projectiles) {
				if (!other.active || other.kind !== "shunt") continue;
				if (segmentDistance(other.part.Position, projectile.part.Position, step) > SHUNT_INTERCEPT_RADIUS) continue;
				const popAt = other.part.Position;
				cancelShunt(other, popAt);
				finishProjectile(projectile, false);
				break;
			}
			if (!projectile.active) continue;
		} else {
			for (const mine of activeMines) {
				if (!mine.active || now < mine.armedAt) continue;
				if (segmentDistance(mine.part.Position, projectile.part.Position, step) > MINE_TRIGGER_RADIUS * 0.45) continue;
				cancelShunt(projectile, mine.part.Position);
				detonateMine(mine);
				break;
			}
			if (!projectile.active) continue;
		}

		let nextPosition = projectile.part.Position.add(step);
		let groundNormal = Vector3.yAxis;
		if (projectile.kind === "shunt") {
			const ground = sampleShuntGround(nextPosition.X, nextPosition.Z, projectile.part.Position.Y);
			nextPosition = new Vector3(nextPosition.X, ground.y + SHUNT_GROUND_CLEARANCE, nextPosition.Z);
			groundNormal = ground.normal;
		}
		const sweptStep = nextPosition.sub(projectile.part.Position);
		// Bolts sweep their own width (see BOLT_HIT_RADIUS); shunts keep the thin
		// ray for walls/terrain and rely on the proximity fuse for cars.
		const hit =
			projectile.kind === "bolt"
				? Workspace.Spherecast(projectile.part.Position, BOLT_HIT_RADIUS, sweptStep, projectileRayParams(projectile.firer))
				: Workspace.Raycast(projectile.part.Position, sweptStep, shuntPathParams(projectile.firer));

		if (hit) {
			const struckCar = carFromHit(hit.Instance);
			if (projectile.kind === "bolt") {
				if (struckCar) {
					const dir = projectile.velocity.Unit;
					knockCar(
						struckCar,
						dir.mul(BOLT_KNOCK).add(new Vector3(0, 9, 0)),
						new Vector3(0, dir.X > 0 ? 1.5 : -1.5, 0),
						projectile.firer,
						POWERUP_DAMAGE.bolt,
					);
				}
				explosionFx(hit.Position, POWERUP_INFO.bolt.color, 4);
			} else {
				// Preserve the prior wall-impact blast semantics; unlike expiry and
				// proximity hits, an immediate wall impact can catch the firer.
				finishProjectile(projectile, true, hit.Position, false);
			}
			if (projectile.kind === "bolt") finishProjectile(projectile, false);
			continue;
		}

		if (projectile.kind === "shunt") {
			const flatDirection = new Vector3(projectile.velocity.X, 0, projectile.velocity.Z).Unit;
			const slopeDirection = flatDirection.sub(groundNormal.mul(flatDirection.Dot(groundNormal))).Unit;
			projectile.part.CFrame = CFrame.lookAt(nextPosition, nextPosition.add(slopeDirection), groundNormal);
		} else {
			projectile.part.CFrame = CFrame.lookAt(nextPosition, nextPosition.add(projectile.velocity));
		}
	}
	for (let i = projectiles.size() - 1; i >= 0; i--) if (!projectiles[i].active) projectiles.remove(i);
});

// --- Mines -----------------------------------------------------------------------
function dropMine(car: Model, backward: boolean) {
	const chassis = getChassis(car);
	if (!chassis) return;

	// "Behind" is the default; firing the other way tosses it out the front.
	const direction = backward ? chassis.CFrame.LookVector : chassis.CFrame.LookVector.mul(-1);
	// Drop just outside MINE_TRIGGER_RADIUS so the dropper isn't standing in
	// its own mine's trigger zone when the arm delay expires.
	const dropAt = chassis.Position.add(direction.mul(13));
	const y = groundHeight(dropAt.X, dropAt.Z);

	const mine = new Instance("Part");
	mine.Name = "Mine";
	mine.Shape = Enum.PartType.Cylinder;
	mine.Anchored = true;
	mine.CanCollide = false;
	mine.CanQuery = false;
	mine.CanTouch = false;
	mine.Material = Enum.Material.Metal;
	mine.Color = Color3.fromRGB(40, 40, 40);
	mine.Size = new Vector3(0.9, 4, 4);
	mine.CFrame = new CFrame(dropAt.X, y + 0.45, dropAt.Z).mul(CFrame.Angles(0, 0, math.rad(90)));
	const light = new Instance("PointLight");
	light.Color = POWERUP_INFO.mine.color;
	light.Brightness = 4;
	light.Range = 10;
	light.Parent = mine;
	mine.Parent = fxFolder;

	const activeMine: ActiveMine = {
		part: mine,
		owner: car,
		armedAt: os.clock() + MINE_ARM_DELAY,
		diesAt: os.clock() + MINE_LIFETIME,
		active: true,
	};
	activeMines.push(activeMine);

	task.spawn(() => {
		while (activeMine.active && mine.IsDescendantOf(game)) {
			const now = os.clock();
			if (now >= activeMine.diesAt) break;

			// Blink faster once armed.
			light.Enabled = now >= activeMine.armedAt ? math.floor(now * 4) % 2 === 0 : true;

			if (now >= activeMine.armedAt) {
				for (const target of getCars()) {
					const targetChassis = getChassis(target);
					if (!targetChassis) continue;
					if (targetChassis.Position.sub(mine.Position).Magnitude > MINE_TRIGGER_RADIUS) continue;

					detonateMine(activeMine);
					break;
				}
			}

			task.wait(0.1);
		}
		finishMine(activeMine);
	});
}

function finishMine(mine: ActiveMine) {
	if (!mine.active) return;
	mine.active = false;
	mine.part.Destroy();
	const index = activeMines.indexOf(mine);
	if (index >= 0) activeMines.remove(index);
}

function detonateMine(mine: ActiveMine) {
	if (!mine.active) return;
	const position = mine.part.Position;
	// Clear active first because a shunt and car can enter the trigger volume in
	// the same simulation slice. The mine blast still affects every nearby car.
	mine.active = false;
	explosionFx(position, POWERUP_INFO.mine.color, 12);
	for (const target of getCars()) {
		const targetChassis = getChassis(target);
		if (!targetChassis) continue;
		const offset = targetChassis.Position.sub(position);
		if (offset.Magnitude > MINE_TRIGGER_RADIUS) continue;
		const flat = new Vector3(offset.X, 0, offset.Z);
		const away = flat.Magnitude > 0.5 ? flat.Unit : targetChassis.CFrame.LookVector;
		knockCar(
			target,
			away.mul(MINE_KNOCK_AWAY).add(new Vector3(0, MINE_KNOCK_UP, 0)),
			new Vector3(0, 4, 0),
			mine.owner,
			POWERUP_DAMAGE.mine,
		);
	}
	mine.part.Destroy();
	const index = activeMines.indexOf(mine);
	if (index >= 0) activeMines.remove(index);
}

// --- Shield ------------------------------------------------------------------------
function activateShield(car: Model) {
	const chassis = getChassis(car);
	if (!chassis) return;

	car.SetAttribute(SHIELD_UNTIL_ATTR, Workspace.GetServerTimeNow() + SHIELD_DURATION);

	const existing = car.FindFirstChild("ShieldBubble");
	if (existing) existing.Destroy();

	const bubble = new Instance("Part");
	bubble.Name = "ShieldBubble";
	bubble.Shape = Enum.PartType.Ball;
	bubble.CanCollide = false;
	bubble.CanQuery = false;
	bubble.CanTouch = false;
	bubble.Massless = true;
	bubble.Material = Enum.Material.ForceField;
	bubble.Color = POWERUP_INFO.shield.color;
	bubble.Transparency = 0.25;
	bubble.Size = new Vector3(16, 16, 16);
	bubble.CFrame = chassis.CFrame;
	bubble.Parent = car;

	const weld = new Instance("WeldConstraint");
	weld.Part0 = chassis;
	weld.Part1 = bubble;
	weld.Parent = bubble;

	task.delay(SHIELD_DURATION, () => {
		if (bubble.IsDescendantOf(game)) bubble.Destroy();
	});
}

// --- Nitro ---------------------------------------------------------------------------
// The driving client owns the physics, so the boost itself lives in
// carClient.client.ts; the server just stamps the window and adds flames.
function activateNitro(car: Model) {
	const chassis = getChassis(car);
	if (!chassis) return;

	chassis.SetAttribute(NITRO_UNTIL_ATTR, Workspace.GetServerTimeNow() + NITRO_DURATION);

	const attachment = new Instance("Attachment");
	attachment.Position = new Vector3(0, 0.2, chassis.Size.Z / 2 + 0.4);
	attachment.Parent = chassis;

	const flames = new Instance("ParticleEmitter");
	flames.Color = new ColorSequence(POWERUP_INFO.nitro.color, Color3.fromRGB(255, 170, 60));
	flames.LightEmission = 1;
	flames.Size = new NumberSequence(1.6, 0.2);
	flames.Transparency = new NumberSequence(0.1, 1);
	flames.Lifetime = new NumberRange(0.25, 0.4);
	flames.Rate = 120;
	flames.Speed = new NumberRange(25, 35);
	flames.SpreadAngle = new Vector2(8, 8);
	flames.EmissionDirection = Enum.NormalId.Back; // +Z = out the back of the car
	flames.Parent = attachment;

	task.delay(NITRO_DURATION, () => {
		flames.Enabled = false;
		task.delay(0.5, () => attachment.Destroy());
	});
}

// --- Barge ---------------------------------------------------------------------------
function activateBarge(car: Model) {
	const chassis = getChassis(car);
	if (!chassis) return;

	// Expanding shockwave ring.
	const ring = new Instance("Part");
	ring.Shape = Enum.PartType.Cylinder;
	ring.Anchored = true;
	ring.CanCollide = false;
	ring.CanQuery = false;
	ring.CanTouch = false;
	ring.Material = Enum.Material.Neon;
	ring.Color = POWERUP_INFO.barge.color;
	ring.Transparency = 0.3;
	ring.Size = new Vector3(0.6, 4, 4);
	ring.CFrame = new CFrame(chassis.Position).mul(CFrame.Angles(0, 0, math.rad(90)));
	ring.Parent = fxFolder;
	TweenService.Create(ring, new TweenInfo(0.4, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
		Size: new Vector3(0.6, BARGE_RADIUS * 2, BARGE_RADIUS * 2),
		Transparency: 1,
	}).Play();
	task.delay(0.45, () => ring.Destroy());

	// Barge is an indiscriminate projectile counter: ownership is deliberately
	// ignored, matching the visible shockwave rather than car damage rules.
	for (const projectile of projectiles) {
		if (!projectile.active || projectile.kind !== "shunt") continue;
		if (projectile.part.Position.sub(chassis.Position).Magnitude <= BARGE_RADIUS) cancelShunt(projectile);
	}

	for (const target of getCars()) {
		if (target === car) continue;
		const targetChassis = getChassis(target);
		if (!targetChassis) continue;
		const offset = targetChassis.Position.sub(chassis.Position);
		if (offset.Magnitude > BARGE_RADIUS) continue;
		const flat = new Vector3(offset.X, 0, offset.Z);
		const away = flat.Magnitude > 0.5 ? flat.Unit : chassis.CFrame.LookVector;
		// Closer cars get shoved harder.
		const falloff = 1 - (offset.Magnitude / BARGE_RADIUS) * 0.5;
		// Flash each car the wave reaches so hits read from the driver's seat.
		explosionFx(targetChassis.Position, POWERUP_INFO.barge.color, 6);
		knockCar(
			target,
			away.mul(BARGE_KNOCK * falloff).add(new Vector3(0, 16, 0)),
			new Vector3(0, 2, 0),
			car,
			POWERUP_DAMAGE.barge,
		);
	}
}

// --- Firing --------------------------------------------------------------------------
function useSlot(car: Model, slotIndex: number, backward: boolean) {
	const attr = SLOT_ATTRS[slotIndex - 1];
	const slot = decodeSlot((car.GetAttribute(attr) as string | undefined) ?? "");
	if (!slot) return;

	switch (slot.kind) {
		case "shield":
			activateShield(car);
			car.SetAttribute(attr, "");
			break;
		case "nitro":
			activateNitro(car);
			car.SetAttribute(attr, "");
			break;
		case "barge":
			activateBarge(car);
			car.SetAttribute(attr, "");
			break;
		case "mine":
			dropMine(car, backward);
			car.SetAttribute(attr, "");
			break;
		case "shunt":
			fireShunt(car, backward);
			car.SetAttribute(attr, "");
			break;
		case "bolt": {
			// 3 bullets per pickup, fired one keypress at a time.
			fireBolt(car, backward);
			const remaining = (slot.charges ?? BOLT_CHARGES) - 1;
			car.SetAttribute(attr, remaining > 0 ? encodeSlot("bolt", remaining) : "");
			break;
		}
	}
}

useRemote.OnServerEvent.Connect((player, slotArg, backwardArg) => {
	const slotIndex = slotArg as number;
	if (!typeIs(slotIndex, "number") || slotIndex < 1 || slotIndex > MAX_SLOTS) return;

	const car = getPlayerCar(player);
	if (!car) return;

	useSlot(car, slotIndex, backwardArg === true);
});

// Bot drivers have no client, so their firing arrives on a server-side
// bindable instead of the remote.
const botUse = new Instance("BindableEvent");
botUse.Name = BOT_USE_EVENT;
botUse.Parent = ServerStorage;
botUse.Event.Connect((carArg: unknown, slotArg: unknown, backwardArg: unknown) => {
	const car = carArg as Model;
	const slotIndex = slotArg as number;
	if (!typeIs(slotIndex, "number") || slotIndex < 1 || slotIndex > MAX_SLOTS) return;
	if (!typeIs(car, "Instance") || !car.IsA("Model") || !car.IsDescendantOf(Workspace)) return;
	useSlot(car, slotIndex, backwardArg === true);
});

// Initialise empty inventory attributes + full health on cars as they appear.
function initCarSlots(car: Model) {
	for (const attr of SLOT_ATTRS) {
		if (car.GetAttribute(attr) === undefined) car.SetAttribute(attr, "");
	}
	if (car.GetAttribute(HEALTH_ATTR) === undefined) car.SetAttribute(HEALTH_ATTR, MAX_HEALTH);
}

// --- Boot ----------------------------------------------------------------------------
// Pad placement is analytic, so it can run alongside cosmetic arena dressing.
spawnPads();
startPickupLoop();

for (const car of getCars()) initCarSlots(car);
Workspace.ChildAdded.Connect((child) => {
	if (child.IsA("Model") && child.FindFirstChild(CHASSIS_NAME)) initCarSlots(child);
});

print(`[powerups] ${pads.size()} pickup pads spawned`);
