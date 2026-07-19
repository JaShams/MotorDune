import { Players, RunService, Workspace } from "@rbxts/services";
import {
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
import { OWNER_USER_ID_ATTR } from "shared/sessionConfig";
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
const dustStartSpeed = 5; // no dust while idling, but ordinary driving leaves a readable trace
const dustFullSpeed = 60;
const dustMaxRate = 20; // particles/s per rear tyre, emitted as deterministic individual puffs

interface CarVisual {
	car: Model;
	chassis: BasePart;
	seat: VehicleSeat;
	wheels: BasePart[];
	rims: BasePart[];
	dust: Array<ParticleEmitter | undefined>;
	sparks: Array<ParticleEmitter | undefined>;
	trails: Array<Trail | undefined>;
	dustAccumulator: number[];
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

// Local-only dust avoids replicating cosmetic state or asking the server to
// track wheel contacts. The attachment is re-oriented to the terrain normal
// each frame, so the plume rises away from slopes instead of through them.
function getOrCreateDust(wheel: BasePart) {
	const existingAttachment = wheel.FindFirstChild("DustAttachment");
	const attachment = existingAttachment?.IsA("Attachment") ? existingAttachment : new Instance("Attachment");
	attachment.Name = "DustAttachment";
	attachment.Parent = wheel;

	const existingDust = attachment.FindFirstChild("WheelDust");
	if (existingDust?.IsA("ParticleEmitter")) return existingDust;

	const dust = new Instance("ParticleEmitter");
	dust.Name = "WheelDust";
	dust.Texture = "rbxasset://textures/particles/smoke_main.dds";
	dust.Enabled = false;
	dust.Rate = 0;
	dust.Lifetime = new NumberRange(0.75, 1.15);
	dust.Speed = new NumberRange(2.5, 5);
	dust.Drag = 2.5;
	dust.EmissionDirection = Enum.NormalId.Top;
	dust.SpreadAngle = new Vector2(40, 40);
	dust.Acceleration = new Vector3(0, 4.5, 0);
	dust.Rotation = new NumberRange(0, 360);
	dust.RotSpeed = new NumberRange(-18, 18);
	dust.Color = new ColorSequence(Color3.fromRGB(169, 129, 86), Color3.fromRGB(205, 167, 122));
	dust.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, 1.4),
		new NumberSequenceKeypoint(0.55, 3),
		new NumberSequenceKeypoint(1, 4.8),
	]);
	dust.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 0.38),
		new NumberSequenceKeypoint(0.45, 0.66),
		new NumberSequenceKeypoint(1, 1),
	]);
	dust.LightEmission = 0;
	dust.LightInfluence = 1;
	dust.Parent = attachment;
	return dust;
}

function getOrCreateDriftSparks(wheel: BasePart) {
	const existingAttachment = wheel.FindFirstChild("DustAttachment");
	const attachment = existingAttachment?.IsA("Attachment") ? existingAttachment : new Instance("Attachment");
	attachment.Name = "DustAttachment";
	attachment.Parent = wheel;

	const existingSparks = attachment.FindFirstChild("DriftSparks");
	if (existingSparks?.IsA("ParticleEmitter")) return existingSparks;

	const sparks = new Instance("ParticleEmitter");
	sparks.Name = "DriftSparks";
	sparks.Texture = "rbxasset://textures/particles/sparkles_main.dds";
	sparks.Enabled = false;
	sparks.Rate = 0;
	sparks.Lifetime = new NumberRange(0.2, 0.45);
	sparks.Speed = new NumberRange(14, 25);
	sparks.Drag = 5;
	sparks.SpreadAngle = new Vector2(35, 35);
	sparks.EmissionDirection = Enum.NormalId.Back;
	sparks.Acceleration = new Vector3(0, -8, 0);
	sparks.Color = new ColorSequence([
		new ColorSequenceKeypoint(0, Color3.fromRGB(0, 180, 255)), // blue
		new ColorSequenceKeypoint(0.5, Color3.fromRGB(255, 0, 255)), // magenta/purple
		new ColorSequenceKeypoint(1, Color3.fromRGB(255, 220, 0)), // gold/yellow
	]);
	sparks.Size = new NumberSequence([
		new NumberSequenceKeypoint(0, 0.8),
		new NumberSequenceKeypoint(1, 0.15),
	]);
	sparks.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 0),
		new NumberSequenceKeypoint(1, 1),
	]);
	sparks.Parent = attachment;
	return sparks;
}

function getOrCreateSkidTrail(wheel: BasePart) {
	const existingTrail = wheel.FindFirstChild("SkidTrail");
	if (existingTrail?.IsA("Trail")) return existingTrail;

	const att0 = new Instance("Attachment");
	att0.Name = "SkidAtt0";
	att0.Position = new Vector3(-0.55, -WHEEL_RADIUS, 0); // bottom left of wheel
	att0.Parent = wheel;

	const att1 = new Instance("Attachment");
	att1.Name = "SkidAtt1";
	att1.Position = new Vector3(0.55, -WHEEL_RADIUS, 0); // bottom right of wheel
	att1.Parent = wheel;

	const trail = new Instance("Trail");
	trail.Name = "SkidTrail";
	trail.Attachment0 = att0;
	trail.Attachment1 = att1;
	trail.FaceCamera = true;
	trail.Color = new ColorSequence(Color3.fromRGB(25, 25, 25));
	trail.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 0.35),
		new NumberSequenceKeypoint(1, 1),
	]);
	trail.Lifetime = 2.0;
	trail.Enabled = false;
	trail.Parent = wheel;
	return trail;
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
			dust: wheels.map((wheel, index) => (index >= 2 ? getOrCreateDust(wheel) : undefined)),
			sparks: wheels.map((wheel, index) => (index >= 2 ? getOrCreateDriftSparks(wheel) : undefined)),
			trails: wheels.map((wheel, index) => (index >= 2 ? getOrCreateSkidTrail(wheel) : undefined)),
			dustAccumulator: [0, 0, 0, 0],
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
		const isLocalDriven = localDrive.driving && car.GetAttribute(OWNER_USER_ID_ATTR) === Players.LocalPlayer.UserId;
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
			const grounded = result !== undefined && result.Normal.Dot(cf.UpVector) >= 0.2;
			if (grounded) {
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

			const dust = visual.dust[i];
			if (dust) {
				const velocity = chassis.AssemblyLinearVelocity;
				const planarSpeed = velocity.sub(cf.UpVector.mul(velocity.Dot(cf.UpVector))).Magnitude;
				const speedAlpha = math.clamp(
					(planarSpeed - dustStartSpeed) / (dustFullSpeed - dustStartSpeed),
					0,
					1,
				);
				if (grounded) {
					const attachment = dust.Parent as Attachment;
					const contact = result.Position.add(result.Normal.mul(0.08));
					attachment.WorldCFrame = CFrame.lookAt(contact, contact.add(orientation.LookVector), result.Normal);

					// Explicit emissions are stable at low rates: the fractional budget
					// survives between frames instead of producing long invisible gaps.
					visual.dustAccumulator[i] += speedAlpha * dustMaxRate * dt;
					const emitCount = math.floor(visual.dustAccumulator[i]);
					if (emitCount > 0) {
						dust.Emit(emitCount);
						visual.dustAccumulator[i] -= emitCount;
					}
				} else {
					visual.dustAccumulator[i] = 0;
				}
			}

			const drifting = car.GetAttribute("IsDrifting") === true;
			const sparks = visual.sparks[i];
			const trail = visual.trails[i];

			if (sparks) {
				if (drifting) {
					sparks.Enabled = true;
					sparks.Rate = 55;
				} else {
					sparks.Enabled = false;
					sparks.Rate = 0;
				}
			}

			if (trail) {
				trail.Enabled = drifting && grounded;
			}
		}
	}
});
