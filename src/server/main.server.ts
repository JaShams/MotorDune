import { Players, Workspace } from "@rbxts/services";
import {
	CAR_NAME,
	CHASSIS_NAME,
	CHASSIS_SIZE,
	SEAT_NAME,
	SPAWN_CFRAME,
	WHEEL_NAMES,
	WHEEL_OFFSETS,
	WHEEL_RADIUS,
	WHEEL_WIDTH,
} from "shared/carConfig";

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

function getOrCreateCarModel() {
	const existing = Workspace.FindFirstChild(CAR_NAME);

	if (existing?.IsA("Model")) {
		return existing;
	}

	const model = new Instance("Model");
	model.Name = CAR_NAME;

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

function getOrCreateChassis(car: Model) {
	const existing = car.FindFirstChild(CHASSIS_NAME);
	const chassis = existing?.IsA("BasePart") ? existing : createPart(CHASSIS_NAME, car);

	chassis.Anchored = false;
	chassis.CanCollide = true;
	chassis.Massless = false;
	chassis.Size = CHASSIS_SIZE;
	chassis.CFrame = SPAWN_CFRAME;
	chassis.AssemblyLinearVelocity = Vector3.zero;
	chassis.AssemblyAngularVelocity = Vector3.zero;
	chassis.CustomPhysicalProperties = new PhysicalProperties(1, 0.9, 0.05, 1, 1);
	chassis.Parent = car;
	car.PrimaryPart = chassis;

	return chassis;
}

function getOrCreateSeat(car: Model, chassis: BasePart) {
	const existing = car.FindFirstChild(SEAT_NAME);
	const seat = existing?.IsA("VehicleSeat") ? existing : new Instance("VehicleSeat");

	seat.Name = SEAT_NAME;
	seat.Anchored = false;
	seat.CanCollide = false;
	seat.Massless = true;
	seat.Size = new Vector3(2.2, 0.45, 2.2);
	seat.CFrame = chassis.CFrame.mul(new CFrame(0, 1, -0.7));
	seat.Disabled = false;
	seat.MaxSpeed = 0;
	seat.Torque = 0;
	seat.TurnSpeed = 0;
	seat.Parent = car;

	if (!chassis.FindFirstChild(`${SEAT_NAME}Weld`)) {
		weldToChassis(chassis, seat);
	}

	return seat;
}

function getOrCreateWheel(car: Model, chassis: BasePart, name: string, offset: Vector3) {
	const existing = car.FindFirstChild(name);
	const wheel = existing?.IsA("Part") ? existing : createPart(name, car);

	wheel.Shape = Enum.PartType.Cylinder;
	wheel.Anchored = false;
	wheel.CanCollide = false;
	wheel.Massless = true;
	wheel.Size = new Vector3(WHEEL_WIDTH, WHEEL_RADIUS * 2, WHEEL_RADIUS * 2);
	wheel.CFrame = chassis.CFrame.mul(new CFrame(offset)).mul(CFrame.Angles(0, 0, math.rad(90)));
	wheel.Color = new Color3(0.05, 0.05, 0.05);
	wheel.Material = Enum.Material.Rubber;
	wheel.Parent = car;

	if (!chassis.FindFirstChild(`${name}Weld`)) {
		weldToChassis(chassis, wheel);
	}
}

function setDriverOwner(seat: VehicleSeat, chassis: BasePart) {
	const humanoid = seat.Occupant;
	const character = humanoid?.Parent;
	const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

	if (player) {
		chassis.SetNetworkOwner(player);
	} else {
		chassis.SetNetworkOwner(undefined);
	}
}

// Wait (briefly) for the arena terrain so the car spawns onto solid ground
// instead of falling through the void (its spawn is outside the baseplate).
// Bounded so the car always spawns even if the arena script never signals.
const waitStart = os.clock();
while (Workspace.GetAttribute("ArenaReady") !== true && os.clock() - waitStart < 10) {
	task.wait(0.05);
}

const car = getOrCreateCarModel();
const chassis = getOrCreateChassis(car);
const seat = getOrCreateSeat(car, chassis);

for (const [index, offset] of ipairs(WHEEL_OFFSETS)) {
	getOrCreateWheel(car, chassis, WHEEL_NAMES[index - 1], offset);
}

setDriverOwner(seat, chassis);
seat.GetPropertyChangedSignal("Occupant").Connect(() => setDriverOwner(seat, chassis));
