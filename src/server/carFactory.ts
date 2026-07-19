import { CollectionService, ReplicatedStorage, Workspace } from "@rbxts/services";
import {
	CHASSIS_NAME,
	CHASSIS_SIZE,
	SEAT_NAME,
	WHEEL_NAMES,
	WHEEL_OFFSETS,
	WHEEL_RADIUS,
	WHEEL_WIDTH,
	wheelForceAttachmentName,
	wheelForceName,
} from "shared/carConfig";

// ---------------------------------------------------------------------------
// CAR FACTORY
// Builds one complete car assembly (chassis, seat, cosmetic wheels, per-wheel
// force actuators). Used by main.server for the player's car and by
// bots.server for each bot. Everything is getOrCreate so a car left in the
// place file is adopted and normalised instead of duplicated.
// ---------------------------------------------------------------------------

const DEFAULT_CHASSIS_COLOR = Color3.fromRGB(212, 48, 38); // bright rally red so the car reads against the dusk desert

// Cosmetic buggy shell (prepared once in Studio, stored in ReplicatedStorage:
// scripts stripped, parts massless/non-colliding/non-raycastable, pivot at the
// wheel midpoint so PivotTo(chassis.CFrame) drops it into alignment, paintable
// hull tagged "BodyPanel", bucket-seat position stored as a SeatOffset
// attribute). Cars work without it - the chassis box stays visible as the
// body, which also keeps Studio test places built before the shell working.
const SHELL_NAME = "BodyShell";
const SHELL_TEMPLATE_NAME = "CarBodyShell";
const DEFAULT_SEAT_OFFSET = new Vector3(0, 1.25, -0.7);

function getShellTemplate() {
	const template = ReplicatedStorage.FindFirstChild(SHELL_TEMPLATE_NAME);
	return template?.IsA("Model") ? template : undefined;
}

export interface CarBuildOptions {
	name: string;
	spawnCFrame: CFrame;
	color?: Color3;
	/** Disable the seat so players can't sit in it (bot cars). */
	seatDisabled?: boolean;
}

export interface BuiltCar {
	car: Model;
	chassis: BasePart;
	seat: VehicleSeat;
}

function createPart(name: string, parent: Instance) {
	const part = new Instance("Part");
	part.Name = name;
	part.Parent = parent;
	return part;
}

function weldToChassis(chassis: BasePart, part: BasePart) {
	const weld = new Instance("WeldConstraint");
	weld.Name = `${part.Name}Weld`;
	weld.Part0 = chassis;
	weld.Part1 = part;
	weld.Parent = chassis;
}

function getOrCreateCarModel(name: string) {
	const existing = Workspace.FindFirstChild(name);

	if (existing?.IsA("Model")) {
		return existing;
	}

	const model = new Instance("Model");
	model.Name = name;

	if (existing) {
		model.Parent = Workspace;
		for (const child of existing.GetChildren()) {
			child.Parent = model;
		}
		existing.Destroy();
	} else {
		model.Parent = Workspace;
	}

	return model;
}

function getOrCreateChassis(car: Model, spawnCFrame: CFrame, color: Color3) {
	const existing = car.FindFirstChild(CHASSIS_NAME);
	const chassis = existing?.IsA("BasePart") ? existing : createPart(CHASSIS_NAME, car);

	chassis.Anchored = false;
	chassis.CanCollide = true;
	chassis.Massless = false;
	chassis.Color = color;
	chassis.Material = Enum.Material.Metal;
	// Normalise adopted chassis too: the transparent collider still supplies a
	// useful fallback shadow if the cosmetic shell is absent or incomplete.
	chassis.CastShadow = true;
	chassis.Size = CHASSIS_SIZE;
	chassis.CFrame = spawnCFrame;
	chassis.AssemblyLinearVelocity = Vector3.zero;
	chassis.AssemblyAngularVelocity = Vector3.zero;
	// Density 2: handling is unaffected (the sim works in accelerations and
	// scales every force by mass) but collisions are not - a heavier car shoves
	// bots and props harder and gets deflected less when ramming. The absolute
	// spring/damper constants in carSim are sized for this density; change them
	// together.
	chassis.CustomPhysicalProperties = new PhysicalProperties(2, 0.9, 0.05, 1, 1);
	chassis.Parent = car;
	car.PrimaryPart = chassis;

	// Create a query-only taller vertical hitbox to prevent projectiles (like Bolts) from slipping underneath the chassis
	const hitboxName = "CombatHitbox";
	const existingHitbox = car.FindFirstChild(hitboxName);
	const hitbox = existingHitbox?.IsA("BasePart") ? existingHitbox : createPart(hitboxName, car);
	hitbox.Size = new Vector3(CHASSIS_SIZE.X, 5.8, CHASSIS_SIZE.Z);
	hitbox.CFrame = chassis.CFrame.mul(new CFrame(0, -1.8, 0));
	hitbox.Transparency = 1;
	hitbox.CanCollide = false; // No physical collision, so no scraping
	hitbox.CanQuery = true; // Query-enabled for spherecasts/raycasts
	hitbox.CanTouch = false;
	hitbox.Massless = true;
	hitbox.Parent = car;

	chassis.FindFirstChild(`${hitboxName}Weld`)?.Destroy();
	const weld = new Instance("WeldConstraint");
	weld.Name = `${hitboxName}Weld`;
	weld.Part0 = chassis;
	weld.Part1 = hitbox;
	weld.Parent = chassis;

	return chassis;
}

function getOrCreateSeat(car: Model, chassis: BasePart, disabled: boolean, offset: Vector3, hidden: boolean) {
	const existing = car.FindFirstChild(SEAT_NAME);
	const seat = existing?.IsA("VehicleSeat") ? existing : new Instance("VehicleSeat");

	seat.Name = SEAT_NAME;
	seat.Anchored = false;
	seat.CanCollide = false;
	seat.Massless = true;
	seat.Size = new Vector3(2.2, 0.45, 2.2);
	seat.CFrame = chassis.CFrame.mul(new CFrame(offset));
	// Invisible when the shell provides the visible bucket seat.
	seat.Transparency = hidden ? 1 : 0;
	seat.Disabled = disabled;
	seat.MaxSpeed = 0;
	seat.Torque = 0;
	seat.TurnSpeed = 0;
	seat.HeadsUpDisplay = false; // default speed gauge clashes with the HUD
	seat.Parent = car;

	// Re-weld every boot: a weld from an earlier place save captured the old
	// seat offset and would drag the seat back to it after the CFrame set above.
	chassis.FindFirstChild(`${SEAT_NAME}Weld`)?.Destroy();
	weldToChassis(chassis, seat);

	return seat;
}

// Clone the shell over the chassis and weld every part to it. The shell is
// pure dressing: the invisible chassis box remains the sole collider, so
// handling and ram physics are identical with or without it.
function getOrCreateBodyShell(car: Model, chassis: BasePart, template: Model, color: Color3) {
	const existing = car.FindFirstChild(SHELL_NAME);
	let shell = existing?.IsA("Model") ? existing : undefined;

	if (!shell) {
		shell = template.Clone();
		shell.Name = SHELL_NAME;
		shell.PivotTo(chassis.CFrame);
		shell.Parent = car;
		for (const part of shell.GetDescendants()) {
			if (part.IsA("BasePart")) {
				const weld = new Instance("WeldConstraint");
				weld.Part0 = chassis;
				weld.Part1 = part;
				weld.Parent = part;
			}
		}
	}

	// Normalise shadow casting on both cloned and adopted shell parts. Templates
	// are Studio-authored assets, so this must not depend on their saved flags.
	// Paint tagged hull panels in the same pass so bot colour changes also show
	// up without deleting a saved car.
	for (const part of shell.GetDescendants()) {
		if (part.IsA("BasePart")) {
			part.CastShadow = true;
			if (CollectionService.HasTag(part, "BodyPanel")) {
				part.Color = color;
			}
		}
	}

	return shell;
}

function getOrCreateWheel(car: Model, chassis: BasePart, name: string, offset: Vector3) {
	const existing = car.FindFirstChild(name);
	const wheel = existing?.IsA("Part") ? existing : createPart(name, car);

	wheel.Shape = Enum.PartType.Cylinder;
	// Wheels are pure cosmetics: anchored, no weld, posed every frame by each
	// client's wheelVisuals script (suspension travel, steer, roll). A welded
	// wheel is rigid in the assembly and can't animate.
	wheel.Anchored = true;
	wheel.CanCollide = false;
	wheel.Massless = true;
	wheel.Size = new Vector3(WHEEL_WIDTH, WHEEL_RADIUS * 2, WHEEL_RADIUS * 2);
	// A Roblox cylinder's axis runs along its X size, which already points
	// along the chassis' right vector - that IS the axle orientation. (The old
	// 90-degree Z rotation stood the axle upright, rendering the wheels as
	// ground-parallel pucks.)
	wheel.CFrame = chassis.CFrame.mul(new CFrame(offset));
	wheel.Color = new Color3(0.05, 0.05, 0.05);
	wheel.Material = Enum.Material.Rubber;
	wheel.CastShadow = true;
	wheel.Parent = car;

	// Clean up welds left in the place file by the previous rigid-wheel setup.
	chassis.FindFirstChild(`${name}Weld`)?.Destroy();
}

// One world-relative VectorForce per wheel, acting through an attachment the
// simulating machine repositions to the tyre contact point each physics step.
// The solver integrates a constraint force through all of its internal
// substeps, so the stiff suspension/tyre forces stay stable (unlike
// once-a-frame impulses).
function getOrCreateWheelForce(chassis: BasePart, wheelName: string, offset: Vector3) {
	const attName = wheelForceAttachmentName(wheelName);
	const existingAtt = chassis.FindFirstChild(attName);
	const attachment = existingAtt?.IsA("Attachment") ? existingAtt : new Instance("Attachment");
	attachment.Name = attName;
	attachment.Position = offset;
	attachment.Parent = chassis;

	const forceName = wheelForceName(wheelName);
	const existingForce = chassis.FindFirstChild(forceName);
	const vectorForce = existingForce?.IsA("VectorForce") ? existingForce : new Instance("VectorForce");
	vectorForce.Name = forceName;
	vectorForce.Attachment0 = attachment;
	vectorForce.RelativeTo = Enum.ActuatorRelativeTo.World;
	vectorForce.ApplyAtCenterOfMass = false;
	vectorForce.Force = Vector3.zero;
	vectorForce.Enabled = true;
	vectorForce.Parent = chassis;
}

export function buildCar(options: CarBuildOptions): BuiltCar {
	const car = getOrCreateCarModel(options.name);
	const color = options.color ?? DEFAULT_CHASSIS_COLOR;
	const chassis = getOrCreateChassis(car, options.spawnCFrame, color);

	const shellTemplate = getShellTemplate();
	if (shellTemplate) {
		getOrCreateBodyShell(car, chassis, shellTemplate, color);
	}
	// Shelled cars hide the collider box; without a template the box is the body.
	chassis.Transparency = shellTemplate ? 1 : 0;

	const seatOffset = (shellTemplate?.GetAttribute("SeatOffset") as Vector3 | undefined) ?? DEFAULT_SEAT_OFFSET;
	const seat = getOrCreateSeat(car, chassis, options.seatDisabled === true, seatOffset, shellTemplate !== undefined);

	for (const [index, offset] of ipairs(WHEEL_OFFSETS)) {
		getOrCreateWheel(car, chassis, WHEEL_NAMES[index - 1], offset);
		getOrCreateWheelForce(chassis, WHEEL_NAMES[index - 1], offset);
	}

	return { car, chassis, seat };
}

// Wait for the arena terrain so cars spawn onto solid ground instead of
// falling through the void (their spawns are outside the baseplate). Bounded
// so the cars always spawn even if the arena script never signals. Returns
// the seconds waited, for boot logging.
export function waitForArenaReady(timeoutSeconds = 30) {
	const waitStart = os.clock();
	while (Workspace.GetAttribute("ArenaReady") !== true && os.clock() - waitStart < timeoutSeconds) {
		task.wait(0.05);
	}
	return os.clock() - waitStart;
}

// Belt and braces: spawn on the actual terrain surface, wherever it is. If
// the arena build is slow, failed, or reshaped the ground, a raycast keeps
// a car from materialising inside solid terrain (physics silently flings
// and destroys buried parts) or above a hole.
export function groundedSpawnCFrame(spawnCFrame: CFrame) {
	const origin = spawnCFrame.Position;
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Include;
	params.FilterDescendantsInstances = [Workspace.Terrain];
	// 5.5 above the surface is just under the suspension's rest ride height
	// (0.25 offset + ~3.5 rest gap + 1.85 wheel radius), so the car settles
	// instead of dropping or spawning compressed.
	const hit = Workspace.Raycast(new Vector3(origin.X, 200, origin.Z), new Vector3(0, -500, 0), params);
	if (hit) {
		return spawnCFrame.add(new Vector3(0, hit.Position.Y + 5.5 - origin.Y, 0));
	}
	return spawnCFrame;
}

// Safety net: if a chassis falls out of the world (spawn racing the arena
// terrain rebuild, or driving off the map), put it back before Roblox
// silently destroys it at FallenPartsDestroyHeight. The basin floor is
// around Y -10, so anything below -60 is definitely the void.
export function keepInWorld(chassis: BasePart, getRespawnCFrame: () => CFrame) {
	task.spawn(() => {
		while (chassis.IsDescendantOf(game)) {
			if (chassis.Position.Y < -60) {
				warn(`[car] ${chassis.GetFullName()} fell out of the world at ${chassis.Position}; respawning`);
				chassis.AssemblyLinearVelocity = Vector3.zero;
				chassis.AssemblyAngularVelocity = Vector3.zero;
				chassis.CFrame = getRespawnCFrame();
			}
			task.wait(0.5);
		}
	});
}
