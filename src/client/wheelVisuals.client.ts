import { RunService, Workspace } from "@rbxts/services";
import {
	CAR_NAME,
	CHASSIS_NAME,
	MAX_STEER_ANGLE,
	SEAT_NAME,
	STEER_MAX_LAT_ACCEL,
	SUSPENSION_LENGTH,
	WHEELBASE,
	WHEEL_NAMES,
	WHEEL_OFFSETS,
	WHEEL_RADIUS,
	WHEEL_WIDTH,
} from "shared/carConfig";
import { localDrive } from "./carState";

// ---------------------------------------------------------------------------
// WHEEL VISUALS
// The wheels are anchored cosmetic parts (the physics is raycast suspension on
// the chassis alone), so every client poses all four wheels of EVERY car -
// the player's and each bot's - each frame: suspension travel from the same
// spherecast the physics uses, steer angle on the fronts, roll from ground
// speed, plus wheelspin over-spin and handbrake lock-up from the local sim
// when we're the driver. Cars we aren't driving (bots, and the player's car
// seen by other clients) reconstruct steering from the replicated
// VehicleSeat.SteerFloat input instead - the driving client's seat mirrors
// the occupant's keys, and the bot driver writes it explicitly.
// ---------------------------------------------------------------------------

const wheelspinExtraRate = 45; // rad/s of visual over-spin at full wheelspin
const remoteSteerResponse = 8; // smoothing stand-in for the driver's input ramp

interface CarVisual {
	car: Model;
	chassis: BasePart;
	seat: VehicleSeat;
	wheels: BasePart[];
	rims: BasePart[];
	rayParams: RaycastParams;
	rollAngles: number[]; // forward-positive roll distance, radians
	visualSteer: number;
}

const visuals = new Map<Model, CarVisual>();

// A spinning uniform black cylinder looks stationary, so give each wheel a
// contrasting rim bar that shares its CFrame and makes the roll readable.
// Local-only parts: every client builds its own set.
function getOrCreateRim(car: Model, wheel: BasePart) {
	const name = `${wheel.Name}Rim`;
	const existing = car.FindFirstChild(name);
	if (existing?.IsA("BasePart")) return existing;

	const rim = new Instance("Part");
	rim.Name = name;
	rim.Anchored = true;
	rim.CanCollide = false;
	rim.CanQuery = false;
	rim.CanTouch = false;
	rim.Size = new Vector3(WHEEL_WIDTH + 0.06, WHEEL_RADIUS * 1.4, 0.3);
	rim.Color = new Color3(0.75, 0.75, 0.72);
	rim.Material = Enum.Material.SmoothPlastic;
	rim.Parent = car;
	return rim;
}

// Adopt any car model that shows up in the workspace (the player's car and
// the bots replicate from the server at boot; the timeouts skip over
// non-car models like the arena and player characters).
function tryRegister(child: Instance) {
	if (!child.IsA("Model")) return;

	task.spawn(() => {
		const chassis = child.WaitForChild(CHASSIS_NAME, 10);
		if (!chassis?.IsA("BasePart")) return;
		const seat = child.WaitForChild(SEAT_NAME, 10);
		if (!seat?.IsA("VehicleSeat")) return;

		const wheels = new Array<BasePart>();
		for (const name of WHEEL_NAMES) {
			const wheel = child.WaitForChild(name, 10);
			if (!wheel?.IsA("BasePart")) return;
			wheels.push(wheel);
		}

		if (visuals.has(child)) return;

		const rayParams = new RaycastParams();
		rayParams.FilterType = Enum.RaycastFilterType.Exclude;
		rayParams.FilterDescendantsInstances = [child];
		rayParams.IgnoreWater = true;
		rayParams.RespectCanCollide = true; // match the physics: skip pickup cores etc.

		visuals.set(child, {
			car: child,
			chassis,
			seat,
			wheels,
			rims: wheels.map((wheel) => getOrCreateRim(child, wheel)),
			rayParams,
			rollAngles: [0, 0, 0, 0],
			visualSteer: 0,
		});
	});
}

for (const child of Workspace.GetChildren()) tryRegister(child);
Workspace.ChildAdded.Connect(tryRegister);
Workspace.ChildRemoved.Connect((child) => {
	if (child.IsA("Model")) visuals.delete(child);
});

RunService.RenderStepped.Connect((dt) => {
	for (const [car, visual] of visuals) {
		const chassis = visual.chassis;
		const cf = chassis.CFrame;

		// Steer angle: exact from the local simulation when this client is
		// driving this car. Otherwise rebuild it from the replicated SteerFloat
		// (+1 = right, so negate for the physics' positive-is-left convention)
		// and the same lateral-g lock the physics computes, smoothed to stand
		// in for the driver's input ramp.
		const isLocalDriven = localDrive.driving && car.Name === CAR_NAME;
		if (isLocalDriven) {
			visual.visualSteer = localDrive.steerAngle;
		} else {
			const forwardSpeed = chassis.AssemblyLinearVelocity.Dot(cf.LookVector);
			const lock = math.min(
				MAX_STEER_ANGLE,
				math.atan((STEER_MAX_LAT_ACCEL * WHEELBASE) / math.max(forwardSpeed * forwardSpeed, 1)),
			);
			const target = -visual.seat.SteerFloat * lock;
			visual.visualSteer += (target - visual.visualSteer) * (1 - math.exp(-remoteSteerResponse * dt));
		}

		for (let i = 0; i < WHEEL_OFFSETS.size(); i++) {
			const origin = cf.PointToWorldSpace(WHEEL_OFFSETS[i]);

			// Same contact rules as the physics (wheel-radius spherecast lifted a
			// radius clear of initial overlaps, wall grazes rejected); airborne
			// wheels hang at full droop.
			const castLift = WHEEL_RADIUS + 0.1;
			const result = Workspace.Spherecast(
				origin.add(cf.UpVector.mul(castLift)),
				WHEEL_RADIUS,
				cf.UpVector.mul(-(SUSPENSION_LENGTH + castLift)),
				visual.rayParams,
			);
			let travel = SUSPENSION_LENGTH;
			if (result && result.Normal.Dot(cf.UpVector) >= 0.2) {
				travel = math.clamp(result.Distance - castLift, 0, SUSPENSION_LENGTH);
			}
			const center = origin.sub(cf.UpVector.mul(travel));

			const steer = i < 2 ? visual.visualSteer : 0;
			const orientation = cf.Rotation.mul(CFrame.Angles(0, steer, 0));

			// Roll from ground speed along the wheel's (steered) rolling direction,
			// with the driver-only flourishes: rears frozen under handbrake, lit
			// tyres over-spinning by up to wheelspinExtraRate.
			let rollRate = chassis.GetVelocityAtPosition(center).Dot(orientation.LookVector) / WHEEL_RADIUS;
			if (isLocalDriven) {
				if (localDrive.handbrake && i >= 2) rollRate = 0;
				const spinDirection = localDrive.throttle < 0 ? -1 : 1;
				rollRate += localDrive.wheelSpin[i] * wheelspinExtraRate * spinDirection;
			}
			visual.rollAngles[i] = (visual.rollAngles[i] + rollRate * dt) % (2 * math.pi);

			// Rolling forward is a NEGATIVE rotation about the +X axle (right-hand
			// rule with the look vector along -Z), hence the sign flip.
			const wheelCFrame = new CFrame(center)
				.mul(orientation)
				.mul(CFrame.Angles(-visual.rollAngles[i], 0, 0));
			visual.wheels[i].CFrame = wheelCFrame;
			visual.rims[i].CFrame = wheelCFrame;
		}
	}
});
