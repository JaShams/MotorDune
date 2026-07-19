import { Players, ReplicatedStorage, RunService, ServerStorage, TweenService, Workspace } from "@rbxts/services";
import { groundYAt, TRACK_CENTER_RADIUS } from "shared/arenaConfig";
import { CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import {
	BARGE_RADIUS,
	BOLT_CHARGES,
	BOLT_HIT_RADIUS,
	BOLT_TRAIL_WIDTH,
	BOLT_VISUAL_SIZE,
	BOT_USE_EVENT,
	decodeSlot,
	encodeSlot,
	FEEDBACK_REMOTE,
	FX_FOLDER,
	GUIDANCE_ACTIVE_ATTR,
	KNOCK_REMOTE,
	MAX_SLOTS,
	MINE_HOVER_HEIGHT,
	MINE_TRIGGER_RADIUS,
	MINE_VISUAL_DIAMETER,
	NITRO_DURATION,
	NITRO_UNTIL_ATTR,
	PAD_RESPAWN_SECONDS,
	PICKUPS_FOLDER,
	POWERUP_INFO,
	PowerupFeedback,
	POWERUP_SOUND_IDS,
	POWERUP_TYPES,
	PowerupType,
	REMOTES_FOLDER,
	SHUNT_ACQUIRE_HALF_ANGLE,
	SHUNT_BLAST_RADIUS,
	SHUNT_BREAK_ANGLE,
	SHUNT_BREAK_HOLD,
	SHUNT_GUIDANCE_DELAY,
	SHUNT_LIFETIME,
	SHUNT_PROXIMITY,
	SHUNT_SPEED,
	SHUNT_TRAIL_WIDTH,
	SHUNT_TURN_RATE,
	SHUNT_VISUAL_SIZE,
	SHIELD_DURATION,
	SHIELD_UNTIL_ATTR,
	SLOT_ATTRS,
	TARGET_OWNER_ATTR,
	USE_REMOTE,
} from "shared/powerupConfig";
import { MATCH_PHASE_ATTR, OWNER_USER_ID_ATTR, ROUND_ELIMINATED_ATTR } from "shared/sessionConfig";
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
import { recordHit, recordPickup } from "./analytics";

// ---------------------------------------------------------------------------
// Blur-style power-ups. Pads float above the track; driving through one adds
// it to the car's 3-slot inventory (attributes on the car model). Firing goes
// through a RemoteEvent; knockback on player-driven cars is routed to the
// driving client because it network-owns the chassis, so server impulses
// wouldn't replicate.
// ---------------------------------------------------------------------------

const COLLECT_RADIUS = 12; // scaled with the buggy-sized chassis (16 studs long)

const BOLT_SPEED = 380;
const BOLT_LIFETIME = 8.0;
const BOLT_KNOCK = 26; // delta-v (studs/s) given to a struck car

const SHUNT_KNOCK = 52;
const SHUNT_GROUND_CLEARANCE = 2.5;
const SHUNT_INTERCEPT_RADIUS = 2.4;

const MINE_ARM_DELAY = 1.2;
const MINE_LIFETIME = 60;
const MINE_KNOCK_UP = 42;
const MINE_KNOCK_AWAY = 28;

const BARGE_KNOCK = 46;

// --- Dynamic Rival System Data & Helpers --------------------------------------
interface Interaction {
	hits: number;
	lastDamageReceivedAt: number;
}

const mutualCombatScores = new Map<string, Map<string, Interaction>>();
const isRetributionRival = new Map<string, boolean>();

function recordMutualHit(victimName: string, attackerName: string) {
	const now = os.clock();

	// 1. Update victim's perspective (received damage from attacker)
	if (!mutualCombatScores.has(victimName)) {
		mutualCombatScores.set(victimName, new Map());
	}
	const victimMap = mutualCombatScores.get(victimName)!;
	if (!victimMap.has(attackerName)) {
		victimMap.set(attackerName, { hits: 0, lastDamageReceivedAt: 0 });
	}
	const victimData = victimMap.get(attackerName)!;
	victimData.hits += 1;
	victimData.lastDamageReceivedAt = now;

	// 2. Update attacker's perspective (traded hit with victim)
	if (!mutualCombatScores.has(attackerName)) {
		mutualCombatScores.set(attackerName, new Map());
	}
	const attackerMap = mutualCombatScores.get(attackerName)!;
	if (!attackerMap.has(victimName)) {
		attackerMap.set(victimName, { hits: 0, lastDamageReceivedAt: 0 });
	}
	const attackerData = attackerMap.get(victimName)!;
	attackerData.hits += 1;
}

function evaluateDamageRival(carName: string, car: Model) {
	if (isRetributionRival.get(carName) === true) return;

	const scores = mutualCombatScores.get(carName);
	if (!scores || scores.size() === 0) {
		car.SetAttribute("ActiveRival", undefined);
		return;
	}

	let bestRival: string | undefined = undefined;
	let maxHits = 0;
	let lastDamageTime = 0;

	for (const [opponentName, data] of scores) {
		if (data.hits > maxHits) {
			maxHits = data.hits;
			bestRival = opponentName;
			lastDamageTime = data.lastDamageReceivedAt;
		} else if (data.hits === maxHits && maxHits > 0) {
			if (data.lastDamageReceivedAt > lastDamageTime) {
				bestRival = opponentName;
				lastDamageTime = data.lastDamageReceivedAt;
			}
		}
	}

	if (bestRival !== undefined) {
		car.SetAttribute("ActiveRival", bestRival);
	} else {
		car.SetAttribute("ActiveRival", undefined);
	}
}

Workspace.GetAttributeChangedSignal(MATCH_PHASE_ATTR).Connect(() => {
	const phase = Workspace.GetAttribute(MATCH_PHASE_ATTR);
	if (phase === "intermission" || phase === "ended") {
		mutualCombatScores.clear();
		isRetributionRival.clear();
	}
});

// --- Remotes ----------------------------------------------------------------
const remotes = new Instance("Folder");
remotes.Name = REMOTES_FOLDER;
const useRemote = new Instance("RemoteEvent");
useRemote.Name = USE_REMOTE;
useRemote.Parent = remotes;
const knockRemote = new Instance("RemoteEvent");
knockRemote.Name = KNOCK_REMOTE;
knockRemote.Parent = remotes;
const feedbackRemote = new Instance("RemoteEvent");
feedbackRemote.Name = FEEDBACK_REMOTE;
feedbackRemote.Parent = remotes;
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

function getCarPlayer(car: Model) {
	const ownerId = car.GetAttribute(OWNER_USER_ID_ATTR);
	return typeIs(ownerId, "number") ? Players.GetPlayerByUserId(ownerId) : getDriver(car);
}

function getPlayerCar(player: Player): Model | undefined {
	for (const car of getCars()) {
		if (car.GetAttribute(OWNER_USER_ID_ATTR) === player.UserId) return car;
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
	const ownerId = car.GetAttribute(OWNER_USER_ID_ATTR);
	const driver = typeIs(ownerId, "number") ? Players.GetPlayerByUserId(ownerId) : getDriver(car);
	if (driver) {
		addPoints(driver, amount);
	} else if (car.GetAttribute("IsBot") === true) {
		const points = (car.GetAttribute(BOT_POINTS_ATTR) as number | undefined) ?? 0;
		car.SetAttribute(BOT_POINTS_ATTR, points + amount);
	}
}

function playSpatialSound(position: Vector3, soundId: string, volume: number, playbackSpeed = 1, duration = 5) {
	const anchor = new Instance("Part");
	anchor.Name = "PowerupSound";
	anchor.Anchored = true;
	anchor.CanCollide = false;
	anchor.CanQuery = false;
	anchor.CanTouch = false;
	anchor.Transparency = 1;
	anchor.Size = new Vector3(0.1, 0.1, 0.1);
	anchor.Position = position;
	anchor.Parent = fxFolder;

	const sound = new Instance("Sound");
	sound.SoundId = soundId;
	sound.Volume = volume;
	sound.PlaybackSpeed = playbackSpeed;
	sound.RollOffMinDistance = 18;
	sound.RollOffMaxDistance = 180;
	sound.Parent = anchor;
	sound.Play();
	task.delay(duration, () => anchor.Destroy());
}

// --- Health --------------------------------------------------------------------
function wreckCar(car: Model, attacker?: Model) {
	const chassis = getChassis(car);
	if (chassis) {
		explosionFx(chassis.Position, Color3.fromRGB(255, 120, 30), 18);
		playSpatialSound(chassis.Position, POWERUP_SOUND_IDS.debrisImpact, 0.9, 0.88, 2.5);
		applyKnock(car, new Vector3(0, 55, 0), new Vector3(2.5, 6, 2.5));
	}

	// A wreck dumps the car's held powerups.
	for (const attr of SLOT_ATTRS) car.SetAttribute(attr, "");

	if (attacker) {
		addCarPoints(attacker, WRECK_BONUS_POINTS);

		// Dynamic Rival System:
		// If the attacker wrecks their active Rival back, clear the status.
		const attackerRival = attacker.GetAttribute("ActiveRival") as string | undefined;
		if (attackerRival === car.Name) {
			attacker.SetAttribute("ActiveRival", undefined);
			isRetributionRival.set(attacker.Name, false);
			// Reset mutual hits with this opponent
			const scores = mutualCombatScores.get(attacker.Name);
			if (scores) {
				scores.delete(car.Name);
			}
		}

		// Retribution Rule: Flag the attacker as the victim's active Rival.
		car.SetAttribute("ActiveRival", attacker.Name);
		isRetributionRival.set(car.Name, true);
	}

	task.delay(WRECK_RESET_SECONDS, () => {
		if (car.IsDescendantOf(game)) {
			car.SetAttribute(HEALTH_ATTR, MAX_HEALTH);
			// Start new lifecycle: reset hit tracking and Retribution status
			mutualCombatScores.set(car.Name, new Map());
			isRetributionRival.set(car.Name, false);
		}
	});
}

function damageCar(car: Model, amount: number, attacker?: Model) {
	if (Workspace.GetAttribute(MATCH_PHASE_ATTR) !== "active") return false;
	if (car.GetAttribute(ROUND_ELIMINATED_ATTR) === true) return false;
	const health = (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? MAX_HEALTH;
	if (health <= 0) return false; // already wrecked, waiting to reset

	const newHealth = math.max(0, health - amount);
	car.SetAttribute(HEALTH_ATTR, newHealth);

	const scoringAttacker = attacker !== undefined && attacker !== car ? attacker : undefined;
	if (scoringAttacker) {
		addCarPoints(scoringAttacker, math.floor(amount));
		recordHit(scoringAttacker);

		// Record the mutual hit for dynamic Rival tracking
		recordMutualHit(car.Name, scoringAttacker.Name);
	}

	const wrecked = newHealth <= 0;
	if (wrecked) {
		wreckCar(car, scoringAttacker);
	} else if (scoringAttacker) {
		// Evaluate if we should update active Rival under the Damage Exchange Rule
		evaluateDamageRival(car.Name, car);
		evaluateDamageRival(scoringAttacker.Name, scoringAttacker);
	}
	return wrecked;
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

// Feedback is an action rather than durable state: the victim needs the exact
// impulse for camera inertia, while the attacker needs a positive confirmation
// even when the target is far off-screen.
function sendPowerupFeedback(car: Model, feedback: PowerupFeedback) {
	const player = getCarPlayer(car);
	if (player) feedbackRemote.FireClient(player, feedback);
}

// A powerup hit: shield blocks both the shove and the damage; otherwise the
// attacker (if any, and not the victim itself) earns points for the damage.
function knockCar(
	kind: PowerupType,
	car: Model,
	deltaV: Vector3,
	angularDeltaV = Vector3.zero,
	attacker?: Model,
	damage = 0,
) {
	const chassis = getChassis(car);
	if (!chassis) return;
	if (isShielded(car)) {
		sendPowerupFeedback(car, {
			type: "shieldBlock",
			role: "victim",
			kind,
			position: chassis.Position,
			deltaV: Vector3.zero,
			angularDeltaV: Vector3.zero,
			damage: 0,
			wrecked: false,
		});
		if (attacker && attacker !== car) {
			sendPowerupFeedback(attacker, {
				type: "shieldBlock",
				role: "attacker",
				kind,
				position: chassis.Position,
				deltaV: Vector3.zero,
				angularDeltaV: Vector3.zero,
				damage: 0,
				wrecked: false,
			});
		}
		return;
	}
	const wrecked = damage > 0 ? damageCar(car, damage, attacker) : false;
	sendPowerupFeedback(car, {
		type: "impact",
		role: "victim",
		kind,
		position: chassis.Position,
		deltaV,
		angularDeltaV,
		damage,
		wrecked,
	});
	if (attacker && attacker !== car) {
		sendPowerupFeedback(attacker, {
			type: "hitConfirm",
			kind,
			position: chassis.Position,
			damage,
			wrecked,
		});
	}
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
	isMystery?: boolean;
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

function createPad(position: Vector3, kind: PowerupType, isMystery = false) {
	const info = isMystery ? {
		color: Color3.fromRGB(255, 215, 0), // Gold
		glyph: "?",
		emoji: "❓",
		label: "Mystery",
		directional: false
	} : POWERUP_INFO[kind];

	const model = new Instance("Model");
	model.Name = "Pickup";
	model.SetAttribute("Kind", kind);
	model.SetAttribute("Active", true);
	model.SetAttribute("RespawnAt", 0);

	function visualPart(name: string, size: Vector3, cframe: CFrame, color: Color3, transparency: number) {
		const part = new Instance("Part");
		part.Name = name;
		part.Anchored = true;
		part.CanCollide = false;
		part.CanTouch = false;
		part.CanQuery = false;
		part.CastShadow = false;
		part.Material = Enum.Material.Neon;
		part.Color = color;
		part.Size = size;
		part.CFrame = cframe;
		part.Transparency = transparency;
		part.SetAttribute("HomeTransparency", transparency);
		part.Parent = model;
		return part;
	}

	// The cube remains the legible colour source at racing distance. Two dark
	// orbital cages make it feel manufactured instead of a generic Roblox gem;
	// clients animate every anchored piece locally, so these cost no transform
	// replication while idle.
	const core = visualPart(
		"Core",
		new Vector3(2.6, 2.6, 2.6),
		new CFrame(position).mul(CFrame.Angles(math.rad(45), 0, math.rad(45))),
		info.color,
		0,
	);

	const cageColor = Color3.fromRGB(28, 32, 42);
	const cageRadius = 2.75;
	for (let i = 0; i < 8; i++) {
		const angle = (i / 8) * math.pi * 2;
		const horizontalPos = position.add(new Vector3(math.cos(angle) * cageRadius, 0, math.sin(angle) * cageRadius));
		visualPart(
			"RingA",
			new Vector3(1.55, 0.22, 0.22),
			new CFrame(horizontalPos).mul(CFrame.Angles(0, -angle + math.pi / 2, 0)),
			cageColor,
			0.08,
		);

		const verticalPos = position.add(new Vector3(math.cos(angle) * cageRadius, math.sin(angle) * cageRadius, 0));
		visualPart(
			"RingB",
			new Vector3(1.55, 0.22, 0.22),
			new CFrame(verticalPos).mul(CFrame.Angles(0, 0, angle + math.pi / 2)),
			cageColor,
			0.08,
		);
	}

	// A segmented footprint communicates where collection happens and remains
	// behind as a respawn clock after the floating cell is taken.
	const groundY = position.Y - 3.25;
	for (let i = 0; i < 12; i++) {
		const angle = (i / 12) * math.pi * 2;
		const segmentPos = new Vector3(position.X + math.cos(angle) * 4.5, groundY, position.Z + math.sin(angle) * 4.5);
		const groundSegment = visualPart(
			"GroundSegment",
			new Vector3(2.15, 0.12, 0.3),
			new CFrame(segmentPos).mul(CFrame.Angles(0, -angle + math.pi / 2, 0)),
			info.color,
			0.32,
		);
		groundSegment.SetAttribute("SegmentIndex", i);
	}

	visualPart("Beacon", new Vector3(0.18, 10, 0.18), new CFrame(position.add(new Vector3(0, 6, 0))), info.color, 0.68);

	const light = new Instance("PointLight");
	light.Color = info.color;
	light.Brightness = 2;
	light.Range = 14;
	light.Parent = core;

	const burst = new Instance("ParticleEmitter");
	burst.Name = "CollectBurst";
	burst.Enabled = false;
	burst.Texture = "rbxasset://textures/particles/sparkles_main.dds";
	burst.Color = new ColorSequence(info.color);
	burst.LightEmission = 1;
	burst.Lifetime = new NumberRange(0.25, 0.55);
	burst.Speed = new NumberRange(10, 22);
	burst.SpreadAngle = new Vector2(180, 180);
	burst.Drag = 4;
	burst.Size = new NumberSequence([new NumberSequenceKeypoint(0, 0.65), new NumberSequenceKeypoint(1, 0)]);
	burst.Parent = core;

	const billboard = new Instance("BillboardGui");
	billboard.Size = UDim2.fromScale(3, 3);
	billboard.StudsOffset = new Vector3(0, 3, 0);
	billboard.AlwaysOnTop = false;
	billboard.MaxDistance = 220;
	billboard.Parent = core;

	const label = new Instance("TextLabel");
	label.BackgroundTransparency = 1;
	label.Size = UDim2.fromScale(1, 1);
	label.Font = Enum.Font.GothamBold;
	label.TextColor3 = info.color;
	label.TextStrokeColor3 = Color3.fromRGB(8, 10, 16);
	label.TextStrokeTransparency = 0.15;
	label.Text = info.glyph;
	label.TextScaled = true;
	label.Parent = billboard;

	model.Parent = pickupsFolder;

	pads.push({ model, core, light, kind, position, active: true, isMystery });
}

function setPadVisible(pad: Pad, visible: boolean) {
	pad.active = visible;
	pad.model.SetAttribute("Active", visible);
	const respawnTime = pad.isMystery ? 30 : PAD_RESPAWN_SECONDS;
	pad.model.SetAttribute("RespawnAt", visible ? 0 : Workspace.GetServerTimeNow() + respawnTime);
	if (!visible) pad.core.FindFirstChildOfClass("ParticleEmitter")?.Emit(18);
	for (const descendant of pad.model.GetDescendants()) {
		if (descendant.IsA("BasePart")) {
			const home = (descendant.GetAttribute("HomeTransparency") as number | undefined) ?? 0;
			descendant.Transparency = visible ? home : 1;
		}
	}
	pad.light.Enabled = visible;
	const billboard = pad.core.FindFirstChildOfClass("BillboardGui");
	if (billboard) billboard.Enabled = visible;
}

// Pad heights come from the same analytic surface sampled by the terrain
// builder, so ring undulation and bowl features cannot leave pads floating.
function spawnPads() {
	const float = 3.5; // gem height above the ground
	const minimumSpacing = COLLECT_RADIUS * 2 + 8;
	const positions = new Array<Vector3>();

	// Build a balanced deterministic bag before assigning locations. Complete
	// six-item rounds contain every kind exactly once; the final partial round
	// gives only two kinds a sixth pickup. Avoiding a repeated kind across round
	// boundaries also means neighbouring pads around each ring never match.
	const kinds = new Array<PowerupType>();
	let previousKind: PowerupType | undefined;
	while (kinds.size() < 32) {
		const round = [...POWERUP_TYPES];
		for (let i = round.size() - 1; i > 0; i--) {
			const j = math.floor(rand() * (i + 1));
			[round[i], round[j]] = [round[j], round[i]];
		}
		if (previousKind !== undefined && round[0] === previousKind) [round[0], round[1]] = [round[1], round[0]];
		for (const kind of round) {
			if (kinds.size() >= 32) break;
			kinds.push(kind);
			previousKind = kind;
		}
	}

	function addPad(x: number, z: number) {
		const position = new Vector3(x, groundYAt(x, z) + float, z);
		positions.push(position);
		createPad(position, kinds[positions.size() - 1]);
	}

	function isClear(x: number, z: number) {
		for (const position of positions) {
			const dx = position.X - x;
			const dz = position.Z - z;
			if (math.sqrt(dx * dx + dz * dz) < minimumSpacing) return false;
		}
		return true;
	}

	// Single pads around the track ring.
	const ringPads = 14;
	const ringRadius = TRACK_CENTER_RADIUS;
	for (let i = 0; i < ringPads; i++) {
		const angle = (i / ringPads) * math.pi * 2;
		const x = math.cos(angle) * ringRadius;
		const z = math.sin(angle) * ringRadius;
		addPad(x, z);
	}

	// Scatter the basin rings within bounded angular sectors. Rejection against
	// every previously accepted pad protects the collection zones even if the
	// counts or radii are tuned later; the sector centre is a deterministic
	// fallback that is comfortably clear with today's geometry.
	for (const [ringRadius, count] of [
		[150, 8],
		[280, 10],
	] as [number, number][]) {
		for (let i = 0; i < count; i++) {
			const sector = (math.pi * 2) / count;
			let angle = i * sector;
			for (let attempt = 0; attempt < 20; attempt++) {
				const candidate = i * sector + (rand() - 0.5) * sector * 0.65;
				const x = math.cos(candidate) * ringRadius;
				const z = math.sin(candidate) * ringRadius;
				if (isClear(x, z)) {
					angle = candidate;
					break;
				}
			}
			addPad(math.cos(angle) * ringRadius, math.sin(angle) * ringRadius);
		}
	}

	// Spawn a special mystery powerup pad at the center of the arena
	const centerY = groundYAt(0, 0);
	const centerPosition = new Vector3(0, centerY + float + 1.0, 0); // floats slightly higher
	createPad(centerPosition, "shield", true); // kind placeholder, isMystery = true
}

// Poll pad pickups (deterministic, immune to Touched flakiness at 150 studs/s).
function startPickupLoop() {
	task.spawn(() => {
		while (true) {
			task.wait(0.05);
			if (Workspace.GetAttribute(MATCH_PHASE_ATTR) !== "active") continue;
			const cars = getCars();
			for (const pad of pads) {
				if (!pad.active) continue;
				for (const car of cars) {
					const chassis = getChassis(car);
					if (!chassis) continue;
					if (chassis.Position.sub(pad.position).Magnitude > COLLECT_RADIUS) continue;
					const kindToGive = pad.isMystery 
						? POWERUP_TYPES[math.floor(math.random() * POWERUP_TYPES.size())] 
						: pad.kind;

					if (!addToInventory(car, kindToGive)) continue; // inventory full: leave the pad

					recordPickup(car);
					setPadVisible(pad, false);
					const respawnTime = pad.isMystery ? 30 : PAD_RESPAWN_SECONDS;
					task.delay(respawnTime, () => setPadVisible(pad, true));
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

	const attachment = new Instance("Attachment");
	attachment.Parent = blast;
	const sparks = new Instance("ParticleEmitter");
	sparks.Texture = "rbxasset://textures/particles/sparkles_main.dds";
	sparks.Color = new ColorSequence(color, Color3.fromRGB(255, 225, 175));
	sparks.LightEmission = 0.8;
	sparks.Lifetime = new NumberRange(0.18, 0.42);
	sparks.Speed = new NumberRange(radius * 1.6, radius * 3);
	sparks.Drag = 5;
	sparks.SpreadAngle = new Vector2(180, 180);
	sparks.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, math.clamp(radius * 0.07, 0.35, 1.2)),
		new NumberSequenceKeypoint(1, 0),
	]);
	sparks.Parent = attachment;
	sparks.Emit(math.floor(radius * 2.5));

	const tween = TweenService.Create(blast, new TweenInfo(0.35, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
		Size: new Vector3(radius * 2, radius * 2, radius * 2),
		Transparency: 1,
	});
	tween.Play();
	task.delay(0.5, () => blast.Destroy());
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
	guidanceStartsAt?: number;
	offAxisSince?: number;
	active: boolean;
	launchDirectionXZ?: Vector3;
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
	bolt.Size = BOLT_VISUAL_SIZE;
	bolt.CFrame = muzzle;
	attachTrail(bolt, POWERUP_INFO.bolt.color, BOLT_TRAIL_WIDTH);
	bolt.Parent = fxFolder;
	playSpatialSound(muzzle.Position, POWERUP_SOUND_IDS.boltElectric, 0.34, 1.1, 1.4);

	// Inherit the car's speed so bolts always outrun the shooter.
	const carSpeed = chassis.AssemblyLinearVelocity.Dot(muzzle.LookVector);
	const rawLook = muzzle.LookVector;
	let dirXZ = new Vector3(rawLook.X, 0, rawLook.Z);
	if (dirXZ.Magnitude < 0.001) dirXZ = new Vector3(muzzle.UpVector.X, 0, muzzle.UpVector.Z);
	if (dirXZ.Magnitude < 0.001) dirXZ = new Vector3(0, 0, -1);
	dirXZ = dirXZ.Unit;

	const speed = BOLT_SPEED + math.max(0, carSpeed);
	projectiles.push({
		part: bolt,
		velocity: new Vector3(dirXZ.X * speed, rawLook.Y * speed, dirXZ.Z * speed),
		firer: car,
		expiresAt: os.clock() + BOLT_LIFETIME,
		kind: "bolt",
		active: true,
		launchDirectionXZ: dirXZ,
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
		if (angle > SHUNT_ACQUIRE_HALF_ANGLE) continue;
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
	missile.Shape = Enum.PartType.Ball;
	missile.Material = Enum.Material.Neon;
	missile.Color = POWERUP_INFO.shunt.color;
	missile.Size = SHUNT_VISUAL_SIZE;
	missile.CFrame = muzzle;
	attachTrail(missile, POWERUP_INFO.shunt.color, SHUNT_TRAIL_WIDTH);
	const light = new Instance("PointLight");
	light.Color = POWERUP_INFO.shunt.color;
	light.Brightness = 3;
	light.Range = 20;
	light.Parent = missile;

	// The orb is the comet head; a short backward-emitting flame plume and the
	// persistent Trail turn its ground-hugging movement into a readable streak
	// without changing the thin collision sweep used for walls and cars.
	const comet = new Instance("ParticleEmitter");
	comet.Name = "CometTail";
	comet.Texture = "rbxasset://textures/particles/fire_main.dds";
	comet.Color = new ColorSequence(Color3.fromRGB(255, 235, 130), Color3.fromRGB(255, 90, 25));
	comet.LightEmission = 1;
	comet.Rate = 55;
	comet.Lifetime = new NumberRange(0.22, 0.42);
	comet.Speed = new NumberRange(9, 18);
	comet.Drag = 3;
	comet.SpreadAngle = new Vector2(14, 14);
	comet.EmissionDirection = Enum.NormalId.Back;
	comet.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, 2.2),
		new NumberSequenceKeypoint(0.45, 1.3),
		new NumberSequenceKeypoint(1, 0),
	]);
	comet.Parent = missile;
	missile.Parent = fxFolder;
	playSpatialSound(muzzle.Position, POWERUP_SOUND_IDS.shuntEnergy, 0.42, 1.08, 1.5);

	// A moving fly-by belongs to the comet head, not the launch position. It is
	// destroyed with the projectile, so a counter or successful dodge cuts the
	// tail naturally instead of leaving a detached sound in the arena.
	const flightSound = new Instance("Sound");
	flightSound.Name = "CometFlight";
	flightSound.SoundId = POWERUP_SOUND_IDS.shuntFlight;
	flightSound.Volume = 0.32;
	flightSound.PlaybackSpeed = 0.88;
	flightSound.RollOffMinDistance = 14;
	flightSound.RollOffMaxDistance = 150;
	flightSound.Parent = missile;
	flightSound.Play();

	const target = findShuntTarget(car, muzzle.Position, muzzle.LookVector);
	const targetOwner = target?.GetAttribute(OWNER_USER_ID_ATTR);
	missile.SetAttribute(TARGET_OWNER_ATTR, typeIs(targetOwner, "number") ? targetOwner : 0);
	missile.SetAttribute(GUIDANCE_ACTIVE_ATTR, false);

	projectiles.push({
		part: missile,
		velocity: launchDirection.mul(SHUNT_SPEED),
		firer: car,
		expiresAt: os.clock() + SHUNT_LIFETIME,
		kind: "shunt",
		target,
		guidanceStartsAt: os.clock() + SHUNT_GUIDANCE_DELAY,
		active: true,
	});
}

function explodeShunt(position: Vector3, firer?: Model) {
	explosionFx(position, POWERUP_INFO.shunt.color, SHUNT_BLAST_RADIUS);
	playSpatialSound(position, POWERUP_SOUND_IDS.shuntEnergy, 0.78, 0.86, 2.4);
	playSpatialSound(position, POWERUP_SOUND_IDS.debrisImpact, 0.28, 1.02, 2.2);
	for (const car of getCars()) {
		if (car === firer) continue; // your own missile can't blast you
		const chassis = getChassis(car);
		if (!chassis) continue;
		const offset = chassis.Position.sub(position);
		if (offset.Magnitude > SHUNT_BLAST_RADIUS) continue;
		const flat = new Vector3(offset.X, 0, offset.Z);
		const away = flat.Magnitude > 0.5 ? flat.Unit : new Vector3(0, 0, 1);
		knockCar(
			"shunt",
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
	if (projectile.kind === "shunt" && damagingShunt)
		explodeShunt(position, excludeFirer ? projectile.firer : undefined);
	projectile.part.Destroy();
}

function cancelShunt(projectile: Projectile, position = projectile.part.Position) {
	if (!projectile.active || projectile.kind !== "shunt") return;
	projectile.active = false;
	// A smaller, cooler pop distinguishes a successful counter from the orange
	// damaging blast without applying damage or knockback.
	explosionFx(position, Color3.fromRGB(150, 220, 255), 5);
	playSpatialSound(position, POWERUP_SOUND_IDS.boltElectric, 0.25, 1.35, 1.2);
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
	// Start the raycast origin higher to guarantee it starts above voxel corners and slopes.
	const rayTop = math.max(referenceY, fallbackY) + 120;
	const hit = Workspace.Raycast(new Vector3(x, rayTop, z), new Vector3(0, -250, 0), params);
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

function shuntTerrainBlocked(from: Vector3, to: Vector3) {
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Include;
	params.FilterDescendantsInstances = [Workspace.Terrain];
	params.IgnoreWater = true;
	const raisedFrom = from.add(new Vector3(0, 0.5, 0));
	const raisedTo = to.add(new Vector3(0, 1.5, 0));
	return Workspace.Raycast(raisedFrom, raisedTo.sub(raisedFrom), params) !== undefined;
}

function loseShuntLock(projectile: Projectile) {
	projectile.target = undefined;
	projectile.offAxisSince = undefined;
	projectile.part.SetAttribute(TARGET_OWNER_ATTR, 0);
	projectile.part.SetAttribute(GUIDANCE_ACTIVE_ATTR, false);
}

RunService.Heartbeat.Connect((dt) => {
	const now = os.clock();
	for (let i = projectiles.size() - 1; i >= 0; i--) {
		const projectile = projectiles[i];
		if (!projectile.active) continue;

		if (now >= projectile.expiresAt || !projectile.part.IsDescendantOf(game)) {
			// Running out the five-second lifetime is a miss, not an invisible
			// final blast at an arbitrary point near the former target.
			finishProjectile(projectile, false);
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

		// Homing starts after a readable straight-flight beat. A committed cut
		// beyond the missile's nose or solid terrain breaks the lock permanently;
		// there is deliberately no reacquisition after the player earns a miss.
		if (projectile.kind === "shunt" && projectile.target && !projectile.target.IsDescendantOf(game)) {
			loseShuntLock(projectile);
		}
		if (projectile.kind === "shunt" && projectile.target && projectile.target.IsDescendantOf(game)) {
			const targetChassis = getChassis(projectile.target);
			if (!targetChassis) {
				loseShuntLock(projectile);
			} else if (now >= (projectile.guidanceStartsAt ?? 0)) {
				projectile.part.SetAttribute(GUIDANCE_ACTIVE_ATTR, true);
				const offset = targetChassis.Position.sub(projectile.part.Position);
				const desired = new Vector3(offset.X, 0, offset.Z);
				if (desired.Magnitude > 0.5) {
					const flatVelocity = new Vector3(projectile.velocity.X, 0, projectile.velocity.Z);
					const currentDir = flatVelocity.Magnitude > 0.01 ? flatVelocity.Unit : desired.Unit;
					const desiredDir = desired.Unit;
					const angle = math.acos(math.clamp(currentDir.Dot(desiredDir), -1, 1));
					if (shuntTerrainBlocked(projectile.part.Position, targetChassis.Position)) {
						loseShuntLock(projectile);
					} else if (angle > SHUNT_BREAK_ANGLE) {
						projectile.offAxisSince ??= now;
						if (now - projectile.offAxisSince >= SHUNT_BREAK_HOLD) loseShuntLock(projectile);
					} else {
						projectile.offAxisSince = undefined;
					}
					if (!projectile.target) continue;
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
				if (segmentDistance(other.part.Position, projectile.part.Position, step) > SHUNT_INTERCEPT_RADIUS)
					continue;
				const popAt = other.part.Position;
				cancelShunt(other, popAt);
				finishProjectile(projectile, false);
				break;
			}
			if (!projectile.active) continue;
		} else {
			for (const mine of activeMines) {
				if (!mine.active || now < mine.armedAt) continue;
				if (segmentDistance(mine.part.Position, projectile.part.Position, step) > MINE_TRIGGER_RADIUS * 0.45)
					continue;
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
			// Smoothly interpolate the height to prevent sharp vertical snapping and clipping over voxel corners.
			const targetY = ground.y + SHUNT_GROUND_CLEARANCE;
			const currentY = projectile.part.Position.Y;
			const newY = currentY + (targetY - currentY) * math.min(1, 20 * dt);
			nextPosition = new Vector3(nextPosition.X, newY, nextPosition.Z);
			groundNormal = ground.normal;
		} else if (projectile.kind === "bolt") {
			const ground = sampleShuntGround(nextPosition.X, nextPosition.Z, projectile.part.Position.Y);
			// Bolts are fast and run close to the floor (clearance ~2.0 studs)
			const targetY = ground.y + 2.0;
			const currentY = projectile.part.Position.Y;
			const newY = currentY + (targetY - currentY) * math.min(1, 25 * dt); // fast lerp since bolts travel at 380 studs/s
			nextPosition = new Vector3(nextPosition.X, newY, nextPosition.Z);
			groundNormal = ground.normal;
		}
		const sweptStep = nextPosition.sub(projectile.part.Position);
		// Bolts sweep their own width (see BOLT_HIT_RADIUS); shunts keep the thin
		// ray for walls/terrain and rely on the proximity fuse for cars.
		const hit =
			projectile.kind === "bolt"
				? Workspace.Spherecast(
						projectile.part.Position,
						BOLT_HIT_RADIUS,
						sweptStep,
						shuntPathParams(projectile.firer),
					)
				: Workspace.Raycast(projectile.part.Position, sweptStep, shuntPathParams(projectile.firer));

		if (hit) {
			const struckCar = carFromHit(hit.Instance);
			if (projectile.kind === "bolt") {
				if (struckCar) {
					const dir = projectile.velocity.Unit;
					knockCar(
						"bolt",
						struckCar,
						dir.mul(BOLT_KNOCK).add(new Vector3(0, 9, 0)),
						new Vector3(0, dir.X > 0 ? 1.5 : -1.5, 0),
						projectile.firer,
						POWERUP_DAMAGE.bolt,
					);
				}
				explosionFx(hit.Position, POWERUP_INFO.bolt.color, 4);
				playSpatialSound(hit.Position, POWERUP_SOUND_IDS.boltElectric, 0.48, 1.08, 1.3);
			} else {
				// Preserve the prior wall-impact blast semantics; unlike expiry and
				// proximity hits, an immediate wall impact can catch the firer.
				finishProjectile(projectile, true, hit.Position, false);
			}
			if (projectile.kind === "bolt") finishProjectile(projectile, false);
			continue;
		}

		if (projectile.kind === "bolt" && projectile.launchDirectionXZ) {
			const flatDirection = projectile.launchDirectionXZ;
			const slopeDirection = flatDirection.sub(groundNormal.mul(flatDirection.Dot(groundNormal))).Unit;
			projectile.part.CFrame = CFrame.lookAt(nextPosition, nextPosition.add(slopeDirection), groundNormal);
			const speedXZ = new Vector3(projectile.velocity.X, 0, projectile.velocity.Z).Magnitude;
			projectile.velocity = flatDirection.mul(speedXZ);
		} else if (projectile.kind === "shunt") {
			const flatDirection = new Vector3(projectile.velocity.X, 0, projectile.velocity.Z).Unit;
			const slopeDirection = flatDirection.sub(groundNormal.mul(flatDirection.Dot(groundNormal))).Unit;
			projectile.part.CFrame = CFrame.lookAt(nextPosition, nextPosition.add(slopeDirection), groundNormal);
			projectile.velocity = slopeDirection.mul(projectile.velocity.Magnitude);
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
	mine.Shape = Enum.PartType.Ball;
	mine.Anchored = true;
	mine.CanCollide = false;
	mine.CanQuery = false;
	mine.CanTouch = false;
	mine.Material = Enum.Material.Neon;
	mine.Color = Color3.fromRGB(255, 100, 0);
	mine.Size = new Vector3(MINE_VISUAL_DIAMETER, MINE_VISUAL_DIAMETER, MINE_VISUAL_DIAMETER);
	mine.Position = new Vector3(dropAt.X, y + MINE_HOVER_HEIGHT, dropAt.Z);

	const smoke = new Instance("ParticleEmitter");
	smoke.Name = "DangerSmoke";
	smoke.Texture = "rbxasset://textures/particles/smoke_main.dds";
	smoke.Color = new ColorSequence(Color3.fromRGB(40, 40, 40));
	smoke.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 0.25),
		new NumberSequenceKeypoint(1, 1),
	]);
	smoke.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, 1.2),
		new NumberSequenceKeypoint(1, 4.5),
	]);
	smoke.Lifetime = new NumberRange(0.8, 1.4);
	smoke.Rate = 22;
	smoke.Speed = new NumberRange(4, 9);
	smoke.SpreadAngle = new Vector2(25, 25);
	smoke.EmissionDirection = Enum.NormalId.Top;
	smoke.Enabled = true;
	smoke.Parent = mine;

	const light = new Instance("PointLight");
	light.Color = POWERUP_INFO.mine.color;
	light.Brightness = 4;
	light.Range = 18;
	light.Parent = mine;
	mine.Parent = fxFolder;

	// A spherical halo reads cleanly on every slope. It pulses after arming,
	// replacing the flat trigger disc that visibly intersected angled terrain.
	const halo = new Instance("Part");
	halo.Name = "ArmedAura";
	halo.Shape = Enum.PartType.Ball;
	halo.Anchored = true;
	halo.CanCollide = false;
	halo.CanQuery = false;
	halo.CanTouch = false;
	halo.CastShadow = false;
	halo.Material = Enum.Material.Neon;
	halo.Color = POWERUP_INFO.mine.color;
	halo.Transparency = 1;
	halo.Size = new Vector3(7.4, 7.4, 7.4);
	halo.Position = mine.Position;
	halo.Parent = mine;

	const flame = new Instance("Fire");
	flame.Color = Color3.fromRGB(255, 215, 70);
	flame.SecondaryColor = Color3.fromRGB(255, 70, 20);
	flame.Heat = 5;
	flame.Size = 4.5;
	flame.Parent = mine;

	const beacon = new Instance("ParticleEmitter");
	beacon.Texture = "rbxasset://textures/particles/sparkles_main.dds";
	beacon.Color = new ColorSequence(POWERUP_INFO.mine.color);
	beacon.LightEmission = 1;
	beacon.Rate = 8;
	beacon.Lifetime = new NumberRange(0.3, 0.6);
	beacon.Speed = new NumberRange(3, 6);
	beacon.SpreadAngle = new Vector2(18, 18);
	beacon.Enabled = false;
	beacon.Parent = mine;

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
			const armed = now >= activeMine.armedAt;
			light.Enabled = armed ? math.floor(now * 6) % 2 === 0 : true;
			halo.Transparency = armed ? 0.52 + ((math.sin(now * 7) + 1) / 2) * 0.2 : 0.78;
			beacon.Enabled = armed;

			if (armed) {
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
	playSpatialSound(position, POWERUP_SOUND_IDS.mineFire, 0.78, 1, 2.5);
	playSpatialSound(position, POWERUP_SOUND_IDS.debrisImpact, 0.52, 0.86, 2.3);
	for (const target of getCars()) {
		const targetChassis = getChassis(target);
		if (!targetChassis) continue;
		const offset = targetChassis.Position.sub(position);
		if (offset.Magnitude > MINE_TRIGGER_RADIUS) continue;
		const flat = new Vector3(offset.X, 0, offset.Z);
		const away = flat.Magnitude > 0.5 ? flat.Unit : targetChassis.CFrame.LookVector;
		knockCar(
			"mine",
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

	const shieldSound = new Instance("Sound");
	shieldSound.Name = "ShieldHum";
	shieldSound.SoundId = POWERUP_SOUND_IDS.shieldLoop;
	shieldSound.Volume = 0.16;
	shieldSound.PlaybackSpeed = 1.05;
	shieldSound.Looped = true;
	shieldSound.RollOffMinDistance = 8;
	shieldSound.RollOffMaxDistance = 75;
	shieldSound.Parent = bubble;
	shieldSound.Play();

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
	playSpatialSound(chassis.Position, POWERUP_SOUND_IDS.bargeShockwave, 0.72, 0.94, 3.5);

	// Expanding shockwave sphere.
	const ring = new Instance("Part");
	ring.Shape = Enum.PartType.Ball;
	ring.Anchored = false;
	ring.CanCollide = false;
	ring.CanQuery = false;
	ring.CanTouch = false;
	ring.Massless = true;
	ring.Material = Enum.Material.Neon;
	ring.Color = POWERUP_INFO.barge.color;
	ring.Transparency = 0.42;
	ring.Size = new Vector3(6, 6, 6);
	ring.CFrame = chassis.CFrame;
	ring.Parent = fxFolder;

	const weld = new Instance("WeldConstraint");
	weld.Part0 = chassis;
	weld.Part1 = ring;
	weld.Parent = ring;

	const dust = new Instance("ParticleEmitter");
	dust.Texture = "rbxasset://textures/particles/smoke_main.dds";
	dust.Color = new ColorSequence(Color3.fromRGB(174, 132, 82));
	dust.Transparency = new NumberSequence(0.25, 1);
	dust.Lifetime = new NumberRange(0.35, 0.65);
	dust.Speed = new NumberRange(22, 42);
	dust.Drag = 8;
	dust.SpreadAngle = new Vector2(180, 180);
	dust.Size = new NumberSequence(2.5, 6);
	dust.Parent = ring;
	dust.Emit(32);

	TweenService.Create(ring, new TweenInfo(0.52, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
		Size: new Vector3(BARGE_RADIUS * 2, BARGE_RADIUS * 2, BARGE_RADIUS * 2),
		Transparency: 1,
	}).Play();
	task.delay(0.7, () => ring.Destroy());

	// Barge is an indiscriminate projectile counter: ownership is deliberately
	// ignored, matching the visible shockwave rather than car damage rules.
	for (const projectile of projectiles) {
		if (!projectile.active || projectile.kind !== "shunt") continue;
		if (projectile.part.Position.sub(chassis.Position).Magnitude <= BARGE_RADIUS) cancelShunt(projectile);
	}

	// 3D volumetric geometric scan using OverlapParams for elevation-tolerant targets
	const hitCars = new Set<Model>();
	const overlapParams = new OverlapParams();
	overlapParams.FilterType = Enum.RaycastFilterType.Exclude;
	overlapParams.FilterDescendantsInstances = [car];

	const hitParts = Workspace.GetPartBoundsInRadius(chassis.Position, BARGE_RADIUS, overlapParams);
	for (const part of hitParts) {
		const targetCar = carFromHit(part);
		if (targetCar && targetCar !== car) {
			hitCars.add(targetCar);
		}
	}

	for (const target of hitCars) {
		const targetChassis = getChassis(target);
		if (!targetChassis) continue;
		const offset = targetChassis.Position.sub(chassis.Position);
		const flat = new Vector3(offset.X, 0, offset.Z);
		const away = flat.Magnitude > 0.5 ? flat.Unit : chassis.CFrame.LookVector;
		// Closer cars get shoved harder.
		const falloff = 1 - (offset.Magnitude / BARGE_RADIUS) * 0.5;
		// Flash each car the wave reaches so hits read from the driver's seat.
		explosionFx(targetChassis.Position, POWERUP_INFO.barge.color, 6);
		knockCar(
			"barge",
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
	if (Workspace.GetAttribute(MATCH_PHASE_ATTR) !== "active") return;
	if (car.GetAttribute(ROUND_ELIMINATED_ATTR) === true) return;
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
	if (!child.IsA("Model")) return;
	// carFactory parents the model before inserting its chassis. Defer this
	// shape check so dynamically spawned and late-joining cars are not missed.
	task.defer(() => {
		if (child.IsDescendantOf(Workspace) && child.FindFirstChild(CHASSIS_NAME)) initCarSlots(child);
	});
});

print(`[powerups] ${pads.size()} pickup pads spawned`);
