import { Players, RunService, ServerStorage, Workspace } from "@rbxts/services";
import { groundY, SPAWN_HEIGHT, SPAWN_RADIUS } from "shared/arenaConfig";
import { CHASSIS_NAME, MAX_STEER_ANGLE, SEAT_NAME } from "shared/carConfig";
import { CarDriveInput, CarSim, createCarSim } from "shared/carSim";
import { BOT_LABEL_ATTR, BOT_POINTS_ATTR, HEALTH_ATTR, MAX_HEALTH } from "shared/healthConfig";
import { BOT_USE_EVENT, decodeSlot, SLOT_ATTRS } from "shared/powerupConfig";
import {
	CONFIGURED_BOTS_ATTR,
	MATCH_PHASE_ATTR,
	MAX_BOTS,
	MAX_PLAYERS,
	ROUND_ELIMINATED_ATTR,
} from "shared/sessionConfig";
import { buildCar, groundedSpawnCFrame, keepInWorld, waitForArenaReady } from "./carFactory";

// ---------------------------------------------------------------------------
// BOT DRIVERS
// Each bot is a full car from the shared factory whose chassis stays
// server-owned, so the server runs the same simulation (shared/carSim) the
// driving client runs for the player's car - bots obey identical physics.
// On top of that sits a simple demolition-derby brain: pure-pursuit steering
// toward the nearest live car (led by its velocity for rams, sticky so packs
// don't retarget every frame), separation steering around non-target cars, an
// escalating reverse-out/scatter routine when beached, a flip reset, and
// opportunistic powerup use through the same server-side firing path players
// trigger via the remote.
// ---------------------------------------------------------------------------

const BOT_SPECS = [
	{ name: "BotCar1", label: "RIVAL 1", color: Color3.fromRGB(38, 128, 212) },
	{ name: "BotCar2", label: "RIVAL 2", color: Color3.fromRGB(236, 148, 32) },
	{ name: "BotCar3", label: "RIVAL 3", color: Color3.fromRGB(70, 190, 92) },
];

// Chase tuning.
const leadSecondsPerStud = 1 / 120; // aim ahead of the target by dist/120 seconds of its velocity
const maxLeadSeconds = 1;
const turnAroundAngle = math.rad(95); // target further off the nose than this
const turnAroundSpeed = 30; // ... while faster than this: lift to tighten the turn
const turnAroundThrottle = 0.45;

// Ram cycle: a landed hit (close and slow) ends the engagement - the bot
// peels away to a breakaway point and loops back in, instead of pushing into
// its victim and knotting the pack up. A chase that drags on too long without
// connecting (two bots orbiting each other) is broken off the same way.
const contactDistance = 22; // 16-stud cars touch nose-to-nose at 16; keep the old ~6 stud slack
const contactSpeed = 14; // this slow while that close counts as a landed ram / grind
const engageMaxSeconds = 6;
const disengageSeconds = 2.4;

// Stuck recovery: beached against a wall or another wreck. Repeat wedges in
// the same spot escalate: longer jittered back-outs, then a scatter run.
const stuckSpeed = 4;
const stuckAfterSeconds = 1.6;
const reverseSeconds = 1.3;
const stuckStreakWindow = 10; // a new stuck within this many seconds keeps the streak alive
const scatterSeconds = 2.2;
const scatterTurn = math.rad(110); // how far around the ring the breakaway point sits

// Driving can't free a car that's high-centred on another chassis - the
// wheels hang at full droop with no load. When reversing keeps failing, put
// it back on its wheels where it stands; if even that doesn't take, respawn.
const uprightResetStreak = 3;
const respawnStreak = 5;

// Progress watchdog: two bots in a pushing match hold each other above
// stuckSpeed while going nowhere, so being stuck is also judged on actual
// displacement, not just instantaneous speed.
const progressWindowSeconds = 2.5;
const progressMinStuds = 8;

// Separation: steer around cars that aren't the current ram target, so bots
// hunting the same victim fan out instead of piling into one another.
const separationRadius = 24;
const separationMaxAngle = math.rad(50);
const separationAheadAngle = math.rad(100); // cars further off the nose than this are ignored

// Sticky targeting: hold the current target unless a rival is decisively
// closer, so packs of bots don't retarget every frame and orbit one another.
const retargetDistanceRatio = 0.6;
// Player cars look this much closer when picking targets - bots would rather
// hunt people than each other, which also keeps bot-vs-bot knots rarer.
const playerDistanceBias = 0.55;

// Flip recovery: the sim's upright assist has a dead zone when fully
// inverted (same reason the player gets the R key).
const flippedUpDot = 0.25;
const flippedAfterSeconds = 1.5;
const flipResetHeight = 3;

// Powerup usage cadence (per-bot decision tick, jittered so they don't volley).
const useCheckSeconds = 1.2;

// Mirror each bot's steering into the seat so wheelVisuals on every client
// can pose the front wheels; quantised so idle wiggle doesn't spam replication.
const steerReplicationStep = 1 / 32;

interface Bot {
	spec: (typeof BOT_SPECS)[number];
	car: Model;
	chassis: BasePart;
	seat: VehicleSeat;
	sim: CarSim;
	spawnCFrame: CFrame;
	stuckTime: number;
	reverseUntil: number;
	reverseSteer: number;
	lastStuckAt: number;
	stuckStreak: number;
	scatterUntil: number;
	scatterAim?: Vector3;
	targetChassis?: BasePart;
	engagedAt: number;
	progressPos: Vector3;
	progressAt: number;
	flipTime: number;
	nextUseAt: number;
}

function nameTag(chassis: BasePart, label: string, color: Color3) {
	const billboard = new Instance("BillboardGui");
	billboard.Name = "BotTag";
	billboard.Size = UDim2.fromScale(8, 1.2);
	billboard.StudsOffset = new Vector3(0, 4.5, 0);
	billboard.AlwaysOnTop = false;
	billboard.MaxDistance = 300;
	billboard.Parent = chassis;

	const text = new Instance("TextLabel");
	text.BackgroundTransparency = 1;
	text.Size = UDim2.fromScale(1, 1);
	text.Text = label;
	text.TextScaled = true;
	text.Font = Enum.Font.GothamBold;
	text.TextColor3 = color;
	text.TextStrokeTransparency = 0.4;
	text.Parent = billboard;
}

// All car models in the workspace (same shape test the powerup system uses).
function getCars(): Model[] {
	const cars = new Array<Model>();
	for (const child of Workspace.GetChildren()) {
		if (child.IsA("Model") && child.FindFirstChild(CHASSIS_NAME) && child.FindFirstChild(SEAT_NAME)) {
			cars.push(child);
		}
	}
	return cars;
}

function carHealth(car: Model) {
	return (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? MAX_HEALTH;
}

// Bots spawn spaced around the track ring between the player's spawn (which
// sits at ring angle 0: position (0, SPAWN_RADIUS), facing the +X tangent).
function ringSpawnCFrame(angle: number) {
	const pos = new Vector3(math.sin(angle) * SPAWN_RADIUS, SPAWN_HEIGHT, math.cos(angle) * SPAWN_RADIUS);
	const tangent = new Vector3(math.cos(angle), 0, -math.sin(angle));
	return CFrame.lookAt(pos, pos.add(tangent));
}

// Set a flipped/lost bot back on its wheels where it stands, keeping its
// heading - the analytic crater profile gives the ground height without
// having to raycast around its own chassis.
function resetUpright(bot: Bot) {
	const chassis = bot.chassis;
	const cf = chassis.CFrame;
	let forward = new Vector3(cf.LookVector.X, 0, cf.LookVector.Z);
	if (forward.Magnitude < 0.05) forward = new Vector3(cf.UpVector.X, 0, cf.UpVector.Z);
	if (forward.Magnitude < 0.05) forward = new Vector3(0, 0, -1);
	forward = forward.Unit;

	const pos = chassis.Position;
	const r = math.sqrt(pos.X * pos.X + pos.Z * pos.Z);
	const target = new Vector3(pos.X, groundY(r) + flipResetHeight, pos.Z);

	chassis.AssemblyLinearVelocity = Vector3.zero;
	chassis.AssemblyAngularVelocity = Vector3.zero;
	chassis.CFrame = CFrame.lookAt(target, target.add(forward));
}

// Nearest other car that isn't wrecked, with hysteresis: the bot keeps its
// current target unless a rival is decisively closer. Without this, bots in a
// pack retarget every frame and grind against each other in a standing scrum.
function pickTarget(bot: Bot, cars: Model[]) {
	let best: BasePart | undefined;
	let bestScore = math.huge;
	let bestDistance = math.huge;
	let current: BasePart | undefined;
	let currentScore = math.huge;
	let currentDistance = math.huge;
	for (const other of cars) {
		if (other === bot.car) continue;
		if (carHealth(other) <= 0) continue;
		const chassis = other.FindFirstChild(CHASSIS_NAME);
		if (!chassis?.IsA("BasePart")) continue;
		const distance = chassis.Position.sub(bot.chassis.Position).Magnitude;
		const score = other.GetAttribute("IsBot") === true ? distance : distance * playerDistanceBias;
		if (chassis === bot.targetChassis) {
			current = chassis;
			currentScore = score;
			currentDistance = distance;
		}
		if (score < bestScore) {
			best = chassis;
			bestScore = score;
			bestDistance = distance;
		}
	}
	if (current !== undefined && best !== current && bestScore > currentScore * retargetDistanceRatio) {
		best = current;
		bestDistance = currentDistance;
	}
	if (best !== bot.targetChassis) bot.engagedAt = os.clock(); // fresh chase clock
	bot.targetChassis = best;
	return best !== undefined ? { chassis: best, distance: bestDistance } : undefined;
}

// Break away: drive toward a point around the track ring for a moment before
// rejoining the fight. Used both after a landed ram and to escape a scrum.
function startBreakaway(bot: Bot, from: number, seconds: number, direction: number) {
	const pos = bot.chassis.Position;
	const ringAngle = math.atan2(pos.X, pos.Z) + (direction >= 0 ? scatterTurn : -scatterTurn);
	bot.scatterAim = new Vector3(math.sin(ringAngle) * SPAWN_RADIUS, pos.Y, math.cos(ringAngle) * SPAWN_RADIUS);
	bot.scatterUntil = from + seconds;
	bot.engagedAt = bot.scatterUntil;
}

// Signed steering nudge (radians, positive = left) away from other cars near
// the bot's nose - the target itself is exempt so rams still land.
function separationNudge(bot: Bot, cars: Model[], ramTarget: BasePart | undefined) {
	const cf = bot.chassis.CFrame;
	let nudge = 0;
	for (const other of cars) {
		if (other === bot.car) continue;
		const chassis = other.FindFirstChild(CHASSIS_NAME);
		if (!chassis?.IsA("BasePart")) continue;
		if (chassis === ramTarget) continue;
		const localPos = cf.PointToObjectSpace(chassis.Position);
		const distance = localPos.Magnitude;
		if (distance >= separationRadius) continue;
		const bearing = math.atan2(-localPos.X, -localPos.Z);
		if (math.abs(bearing) > separationAheadAngle) continue; // behind us: ignore
		const falloff = 1 - distance / separationRadius;
		nudge += (bearing >= 0 ? -1 : 1) * separationMaxAngle * falloff;
	}
	return math.clamp(nudge, -separationMaxAngle, separationMaxAngle);
}

// Fire at most one held powerup if the situation calls for it. angle is the
// signed bearing to the target (radians, positive = left), dist in studs.
function tryUsePowerups(bot: Bot, botUse: BindableEvent, angle: number, dist: number, health: number) {
	const absAngle = math.abs(angle);
	const targetAhead = absAngle < math.rad(20);
	const targetBehind = absAngle > math.rad(150);

	for (let slotIndex = 1; slotIndex <= SLOT_ATTRS.size(); slotIndex++) {
		const slot = decodeSlot((bot.car.GetAttribute(SLOT_ATTRS[slotIndex - 1]) as string | undefined) ?? "");
		if (!slot) continue;

		let backward = false;
		let fire = false;
		switch (slot.kind) {
			case "shield":
				fire = health <= 40;
				break;
			case "nitro":
				fire = targetAhead && dist > 40;
				break;
			case "barge":
				fire = dist < 24;
				break;
			case "bolt":
				if (targetAhead && dist < 150) fire = true;
				else if (targetBehind && dist < 70) {
					fire = true;
					backward = true;
				}
				break;
			case "shunt":
				if (absAngle < math.rad(40) && dist < 200) fire = true;
				else if (targetBehind && dist < 120) {
					fire = true;
					backward = true;
				}
				break;
			case "mine":
				// Default drop is out the back - lay it when being chased.
				fire = targetBehind && dist < 60;
				break;
		}

		if (fire) {
			botUse.Fire(bot.car, slotIndex, backward);
			return;
		}
	}
}

waitForArenaReady();
const botUse = ServerStorage.WaitForChild(BOT_USE_EVENT) as BindableEvent;

const bots = new Array<Bot>();
const requestedBots = math.clamp(
	(Workspace.GetAttribute(CONFIGURED_BOTS_ATTR) as number | undefined) ?? MAX_BOTS,
	0,
	MAX_BOTS,
);
const botCount = math.min(requestedBots, math.max(0, MAX_PLAYERS - Players.GetPlayers().size()));
for (let i = 0; i < botCount; i++) {
	const spec = BOT_SPECS[i];
	const angle = ((i + 1) / (BOT_SPECS.size() + 1)) * math.pi * 2;
	const spawnCFrame = groundedSpawnCFrame(ringSpawnCFrame(angle));

	const { car, chassis, seat } = buildCar({
		name: spec.name,
		spawnCFrame,
		color: spec.color,
		seatDisabled: true, // players can't hop into a bot's seat and fight its driver
	});
	car.SetAttribute("IsBot", true);
	car.SetAttribute(BOT_LABEL_ATTR, spec.label);
	if (car.GetAttribute(BOT_POINTS_ATTR) === undefined) car.SetAttribute(BOT_POINTS_ATTR, 0);
	chassis.SetNetworkOwner(undefined); // stays server-simulated; the sim runs here
	if (!chassis.FindFirstChild("BotTag")) nameTag(chassis, spec.label, spec.color);
	keepInWorld(chassis, () => groundedSpawnCFrame(ringSpawnCFrame(angle)));

	bots.push({
		spec,
		car,
		chassis,
		seat,
		sim: createCarSim(car, chassis),
		spawnCFrame,
		stuckTime: 0,
		reverseUntil: 0,
		reverseSteer: 1,
		lastStuckAt: -math.huge,
		stuckStreak: 0,
		scatterUntil: 0,
		engagedAt: os.clock(),
		progressPos: chassis.Position,
		progressAt: os.clock(),
		flipTime: 0,
		nextUseAt: os.clock() + 2 + math.random() * 2,
	});
}

print(`[bots] ${bots.size()} bot cars spawned`);

// Public/private lobbies can receive more humans after this script initially
// builds the requested rivals. Retire bots from the end of the roster so an
// arriving player can never push the active-car count above eight.
Players.PlayerAdded.Connect(() => {
	task.defer(() => {
		const allowed = math.max(0, MAX_PLAYERS - Players.GetPlayers().size());
		let alive = bots.filter((bot) => bot.car.IsDescendantOf(game));
		while (alive.size() > allowed) {
			alive.pop()!.car.Destroy();
		}
	});
});

RunService.PreSimulation.Connect((dt) => {
	const now = os.clock();
	const cars = getCars();

	for (const bot of bots) {
		const chassis = bot.chassis;
		if (!chassis.IsDescendantOf(game)) continue;

		const cf = chassis.CFrame;
		const speed = chassis.AssemblyLinearVelocity.Magnitude;
		const health = carHealth(bot.car);
		const wrecked = health <= 0;
		if (
			(Workspace.GetAttribute(MATCH_PHASE_ATTR) !== undefined &&
				Workspace.GetAttribute(MATCH_PHASE_ATTR) !== "active") ||
			bot.car.GetAttribute(ROUND_ELIMINATED_ATTR) === true
		) {
			bot.sim.step(dt, { throttle: 0, steer: 0, handbrake: true });
			continue;
		}

		// Flip recovery: inverted and not sliding anywhere -> set it upright.
		if (cf.UpVector.Y < flippedUpDot && speed < 10) {
			bot.flipTime += dt;
			if (bot.flipTime >= flippedAfterSeconds) {
				resetUpright(bot);
				bot.flipTime = 0;
			}
		} else {
			bot.flipTime = 0;
		}

		let input: CarDriveInput | undefined;

		if (wrecked) {
			// Sit dead until the health reset; keeping the sim stepping (with no
			// throttle) keeps the suspension alive so the wreck still rolls and
			// gets shoved around believably.
			input = { throttle: 0, steer: 0, handbrake: false };
			bot.stuckTime = 0;
		} else {
			const target = pickTarget(bot, cars);
			let scattering = now < bot.scatterUntil && bot.scatterAim !== undefined;

			// Ram cycle: a landed hit, or a chase that's dragged on without
			// connecting (two bots orbiting each other), ends the engagement -
			// peel off and come back around rather than push into a scrum.
			if (!scattering && target && now >= bot.reverseUntil) {
				const contact = target.distance < contactDistance && speed < contactSpeed;
				if (contact || now - bot.engagedAt > engageMaxSeconds) {
					startBreakaway(bot, now, disengageSeconds, math.random() < 0.5 ? 1 : -1);
					scattering = true;
				}
			}

			// Aim point: mid-scatter, the breakaway point; otherwise the target
			// led by its velocity, or - with nothing left to hunt - a point a
			// little way around the track ring, so idle bots lap the circuit
			// instead of parking.
			let aim: Vector3;
			if (scattering) {
				aim = bot.scatterAim!;
			} else if (target) {
				const lead = math.min(target.distance * leadSecondsPerStud, maxLeadSeconds);
				aim = target.chassis.Position.add(target.chassis.AssemblyLinearVelocity.mul(lead));
			} else {
				const pos = chassis.Position;
				const ringAngle = math.atan2(pos.X, pos.Z) + 0.25;
				aim = new Vector3(math.sin(ringAngle) * SPAWN_RADIUS, pos.Y, math.cos(ringAngle) * SPAWN_RADIUS);
			}

			// Pure pursuit: bearing to the aim point in chassis space. Forward is
			// -Z and the sim treats positive steer as left, so a target off the
			// left bow (negative local X) must come out positive.
			const localAim = cf.PointToObjectSpace(aim);
			const angle = math.atan2(-localAim.X, -localAim.Z);

			// Fan out around cars that aren't the ram target (all of them, while
			// scattering) instead of wedging into a pile.
			const ramTarget = scattering ? undefined : target?.chassis;
			const steerAngle = angle + separationNudge(bot, cars, ramTarget);

			let steer = math.clamp(steerAngle / MAX_STEER_ANGLE, -1, 1);
			let throttle = 1;
			if (math.abs(angle) > turnAroundAngle && speed > turnAroundSpeed) {
				// Target is way off the nose at speed: lift so the turn tightens.
				throttle = turnAroundThrottle;
			}

			// Stuck against something: back out with opposite lock for a moment.
			// Each repeat within the streak window backs out longer (with jitter,
			// so two bots wedged nose-to-nose don't mirror each other's recovery
			// forever), and from the second repeat the bot scatters afterwards.
			if (speed < stuckSpeed) {
				bot.stuckTime += dt;
			} else {
				bot.stuckTime = 0;
			}

			// Progress watchdog: barely displaced over the window while trying
			// to drive counts as stuck even if wheelspin or a pushing match is
			// holding the speedometer above stuckSpeed.
			if (now - bot.progressAt >= progressWindowSeconds) {
				const moved = chassis.Position.sub(bot.progressPos).Magnitude;
				bot.progressPos = chassis.Position;
				bot.progressAt = now;
				if (moved < progressMinStuds && now >= bot.reverseUntil) {
					bot.stuckTime = stuckAfterSeconds;
				}
			}

			if (now < bot.reverseUntil) {
				throttle = -1;
				steer = bot.reverseSteer;
			} else if (bot.stuckTime >= stuckAfterSeconds) {
				bot.stuckStreak = now - bot.lastStuckAt < stuckStreakWindow ? bot.stuckStreak + 1 : 1;
				bot.lastStuckAt = now;
				bot.stuckTime = 0;
				if (bot.stuckStreak >= respawnStreak) {
					// Wedged beyond saving in place: start over from the ring spawn.
					chassis.AssemblyLinearVelocity = Vector3.zero;
					chassis.AssemblyAngularVelocity = Vector3.zero;
					chassis.CFrame = bot.spawnCFrame;
					bot.stuckStreak = 0;
				} else if (bot.stuckStreak >= uprightResetStreak) {
					// High-centred (typically on another car): no wheel load, so
					// driving can't free it - set it down on the ground it's over.
					resetUpright(bot);
				} else {
					const escalation = math.min(bot.stuckStreak, 3);
					bot.reverseUntil = now + reverseSeconds * escalation * (0.8 + math.random() * 0.6);
					bot.reverseSteer = steer >= 0 ? -1 : 1;
					if (bot.stuckStreak >= 2) {
						startBreakaway(bot, bot.reverseUntil, scatterSeconds, bot.reverseSteer);
					}
				}
			}

			if (target && !scattering && now >= bot.nextUseAt) {
				bot.nextUseAt = now + useCheckSeconds * (0.75 + math.random() * 0.5);
				tryUsePowerups(bot, botUse, angle, target.distance, health);
			}

			input = { throttle, steer, handbrake: false };
		}

		bot.sim.step(dt, input);

		// Replicate steering for the wheel visuals (their remote-viewer path
		// reads seat.SteerFloat; +1 there means right, the sim's +1 means left).
		const replicatedSteer = math.floor(-input.steer / steerReplicationStep + 0.5) * steerReplicationStep;
		if (bot.seat.SteerFloat !== replicatedSteer) bot.seat.SteerFloat = replicatedSteer;
	}
});
