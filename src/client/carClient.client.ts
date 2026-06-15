import { Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { CAR_NAME, CHASSIS_NAME, SEAT_NAME, WHEEL_OFFSETS, WHEEL_RADIUS } from "shared/carConfig";

const localPlayer = Players.LocalPlayer;
const car = Workspace.WaitForChild(CAR_NAME) as Model;
const chassis = car.WaitForChild(CHASSIS_NAME) as BasePart;
const seat = car.WaitForChild(SEAT_NAME) as VehicleSeat;

const rayParams = new RaycastParams();
rayParams.FilterType = Enum.RaycastFilterType.Exclude;
rayParams.FilterDescendantsInstances = [car];
rayParams.IgnoreWater = true;

// ---------------------------------------------------------------------------
// SLIP-ANGLE TIRE MODEL (per-wheel physics)
//
// Instead of applying drive/grip/steer forces to the chassis centre of mass,
// every grounded wheel computes its own forces at its contact patch:
//
//   * Vertical load (Fz) comes straight from the suspension spring, so braking
//     dive and cornering roll automatically shift load between wheels - real
//     weight transfer, which changes how much grip each tyre has.
//   * Lateral force comes from a slip-angle curve (simplified Pacejka). The
//     tyre builds grip up to a peak, then breaks away progressively.
//   * Longitudinal force comes from throttle (driven wheels) and brakes.
//   * A friction circle caps the combined force at mu * Fz, so accelerating or
//     braking mid-corner costs you cornering grip.
//
// Steering rotates the front wheels; the car yaws because the front tyres
// generate lateral force ahead of the centre of mass. Drifting is no longer a
// scripted state - it emerges when a tyre's slip angle pushes past the peak.
// ---------------------------------------------------------------------------

// Suspension (raycast springs that hold the car off the ground).
const suspensionLength = 4;
const wheelCount = 4;
// NOTE: maxSuspensionAcceleration MUST exceed workspace.Gravity (default 196.2)
// or the springs can't hold the car up and the chassis drags on the ground.
const springStrength = 6000;
const damperStrength = 900;
const maxSuspensionAcceleration = 460;

// Which wheels receive engine power. Indices follow WHEEL_OFFSETS:
// 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
// Rear-wheel drive by default; set to [0,1,2,3] for AWD or [0,1] for FWD.
const drivenWheels = [2, 3];
const isDrivenWheel = (index: number) => drivenWheels.includes(index);
const isFrontWheel = (index: number) => index < 2;

// Engine / drivetrain (accelerations in studs/s^2; converted to force per wheel).
const maxForwardSpeed = 150;
const maxReverseSpeed = 65;
const driveAcceleration = 100;
const reverseAcceleration = 115;
const brakeAcceleration = 190;
const rollingResistance = 0.7;
const maxCoastDeceleration = 20;
const highSpeedPower = 0.45; // fraction of drive power kept at top speed
const reverseHighSpeedFalloff = 0.45;

// Tyre model. mu is the peak grip coefficient; B/C shape the slip-angle curve.
// Higher B = sharper turn-in; C near 1.6 gives a realistic peak-then-falloff.
const tireGrip = 1.7;
const pacejkaB = 9;
const pacejkaC = 1.6;
// Handbrake locks the rear wheels and slashes their grip so the back steps out.
const handbrakeRearGrip = 0.35;
const handbrakeBrakeAccel = 240;
// How much of a tyre's sideways slip it may cancel per physics step (0-1).
// 1 = deadbeat (kills all sideways motion in one frame - stable but the car
// can't rotate and feels dead). Lower lets yaw and slides decay over several
// frames, keeping rotational life, while staying below the overshoot threshold
// that caused the wobble. This is the single most important stability knob.
const lateralBite = 0.5;

// Steering. Front wheels turn up to maxSteerAngle, reduced at speed so the car
// stays stable flat-out instead of snapping into a spin.
const maxSteerAngle = math.rad(34);
const highSpeedSteerFrac = 0.28; // fraction of lock kept at top speed
const steerResponse = 8; // how fast the steering angle follows input

// Stability / feel.
const downforcePerSpeed = 0.5;
const maxDownforceAcceleration = 55;
const uprightStrength = 16;
const rollPitchDamping = 5;
const yawDamping = 2.5; // damping to take the edge off snap-oversteer

// Input smoothing.
const throttleResponse = 10;

let wDown = false;
let sDown = false;
let aDown = false;
let dDown = false;
let handbrakeDown = false;
let smoothedThrottle = 0;
let smoothedSteer = 0;
let drivingTime = 0;

UserInputService.InputBegan.Connect((input, gameProcessed) => {
	if (gameProcessed) return;

	if (input.KeyCode === Enum.KeyCode.W) wDown = true;
	if (input.KeyCode === Enum.KeyCode.S) sDown = true;
	if (input.KeyCode === Enum.KeyCode.A) aDown = true;
	if (input.KeyCode === Enum.KeyCode.D) dDown = true;
	if (input.KeyCode === Enum.KeyCode.LeftShift || input.KeyCode === Enum.KeyCode.RightShift) {
		handbrakeDown = true;
	}
});

UserInputService.InputEnded.Connect((input) => {
	if (input.KeyCode === Enum.KeyCode.W) wDown = false;
	if (input.KeyCode === Enum.KeyCode.S) sDown = false;
	if (input.KeyCode === Enum.KeyCode.A) aDown = false;
	if (input.KeyCode === Enum.KeyCode.D) dDown = false;
	if (input.KeyCode === Enum.KeyCode.LeftShift || input.KeyCode === Enum.KeyCode.RightShift) {
		handbrakeDown = false;
	}
});

function getThrottle() {
	return (wDown ? 1 : 0) + (sDown ? -1 : 0);
}

function getSteer() {
	return (aDown ? 1 : 0) + (dDown ? -1 : 0);
}

function getLocalHumanoid() {
	const character = localPlayer.Character;
	return character?.FindFirstChildOfClass("Humanoid");
}

function isLocalPlayerDriving() {
	const humanoid = getLocalHumanoid();
	return humanoid !== undefined && seat.Occupant === humanoid;
}

function moveTowards(current: number, target: number, maxDelta: number) {
	if (current < target) {
		return math.min(current + maxDelta, target);
	}

	return math.max(current - maxDelta, target);
}

// Per-wheel data captured during the suspension pass, reused for tyre forces.
interface WheelState {
	index: number;
	contactPoint: Vector3;
	load: number; // vertical force pressing the tyre onto the road (Fz)
	forward: Vector3; // wheel's rolling direction (steered for the fronts)
	right: Vector3; // wheel's lateral direction
	longVel: number; // velocity along forward
	latVel: number; // velocity along right
}

RunService.Heartbeat.Connect((dt) => {
	if (!isLocalPlayerDriving()) {
		smoothedThrottle = moveTowards(smoothedThrottle, 0, throttleResponse * dt);
		smoothedSteer = moveTowards(smoothedSteer, 0, steerResponse * dt);
		drivingTime = 0;
		return;
	}

	drivingTime += dt;
	smoothedThrottle = moveTowards(smoothedThrottle, getThrottle(), throttleResponse * dt);
	smoothedSteer = moveTowards(smoothedSteer, getSteer(), steerResponse * dt);

	const cf = chassis.CFrame;
	const mass = chassis.AssemblyMass;
	const velocity = chassis.AssemblyLinearVelocity;
	const forwardSpeed = velocity.Dot(cf.LookVector);
	const speed = velocity.Magnitude;
	const speedFactor = math.clamp(math.abs(forwardSpeed) / maxForwardSpeed, 0, 1);

	// Speed-sensitive steering. Positive steer = left (matches A).
	const steerAngle = smoothedSteer * maxSteerAngle * (1 - speedFactor * (1 - highSpeedSteerFrac));
	const sinS = math.sin(steerAngle);
	const cosS = math.cos(steerAngle);
	// Front wheel axes, rotated about the chassis up by the steer angle.
	const frontForward = cf.LookVector.mul(cosS).sub(cf.RightVector.mul(sinS));
	const frontRight = cf.RightVector.mul(cosS).add(cf.LookVector.mul(sinS));

	// --- Suspension pass: hold the car up and record each tyre's load ------
	const wheels = new Array<WheelState>();

	for (const [index, offset] of ipairs(WHEEL_OFFSETS)) {
		const i = index - 1;
		const origin = cf.PointToWorldSpace(offset);
		const direction = cf.UpVector.mul(-(suspensionLength + WHEEL_RADIUS));
		const result = Workspace.Raycast(origin, direction, rayParams);

		if (!result) continue;

		const distanceToGround = result.Distance;
		const currentSuspensionLength = math.clamp(distanceToGround - WHEEL_RADIUS, 0, suspensionLength);
		const compression = suspensionLength - currentSuspensionLength;

		const velocityAtWheel = chassis.GetVelocityAtPosition(origin);
		const verticalVelocity = velocityAtWheel.Dot(cf.UpVector);

		const springForce = springStrength * compression;
		const dampingForce = damperStrength * verticalVelocity;

		const suspensionRamp = math.clamp(drivingTime / 0.45, 0.25, 1);
		const maxWheelForce = (mass * maxSuspensionAcceleration) / wheelCount;
		const suspensionForceMagnitude =
			math.clamp(springForce - dampingForce, -maxWheelForce * 0.35, maxWheelForce) * suspensionRamp;

		chassis.ApplyImpulseAtPosition(cf.UpVector.mul(suspensionForceMagnitude * dt), origin);

		// The tyre load is the upward force the spring is pushing with. This is
		// what couples weight transfer into grip: a compressed corner grips more.
		const load = math.max(0, suspensionForceMagnitude);

		const isFront = isFrontWheel(i);
		const wheelForward = isFront ? frontForward : cf.LookVector;
		const wheelRight = isFront ? frontRight : cf.RightVector;

		const contactVel = chassis.GetVelocityAtPosition(result.Position);
		const planarVel = contactVel.sub(cf.UpVector.mul(contactVel.Dot(cf.UpVector)));

		wheels.push({
			index: i,
			contactPoint: result.Position,
			load,
			forward: wheelForward,
			right: wheelRight,
			longVel: planarVel.Dot(wheelForward),
			latVel: planarVel.Dot(wheelRight),
		});
	}

	const groundedCount = wheels.size();

	if (groundedCount > 0) {
		// --- Longitudinal command (shared across wheels) --------------------
		// propulsionAccel drives the powered wheels; brakeAccel opposes motion
		// on every wheel. Splitting them this way lets brakes load the fronts.
		let propulsionAccel = 0;
		let brakeAccel = 0;

		if (smoothedThrottle > 0.02) {
			if (forwardSpeed < -2) {
				brakeAccel = smoothedThrottle * brakeAcceleration;
			} else {
				const limiter = 1 - math.clamp(forwardSpeed / maxForwardSpeed, 0, 1) * (1 - highSpeedPower);
				propulsionAccel = smoothedThrottle * driveAcceleration * limiter;
			}
		} else if (smoothedThrottle < -0.02) {
			const reverseInput = -smoothedThrottle;

			if (forwardSpeed > 2) {
				brakeAccel = reverseInput * brakeAcceleration;
			} else {
				const limiter = 1 - math.clamp(-forwardSpeed / maxReverseSpeed, 0, 1) * reverseHighSpeedFalloff;
				propulsionAccel = -reverseInput * reverseAcceleration * limiter;
			}
		} else {
			brakeAccel = math.clamp(math.abs(forwardSpeed) * rollingResistance, 0, maxCoastDeceleration);
		}

		// Top-speed limiter folds into braking so the car can't run away.
		if (forwardSpeed > maxForwardSpeed) {
			brakeAccel += (forwardSpeed - maxForwardSpeed) * 4;
		} else if (forwardSpeed < -maxReverseSpeed) {
			brakeAccel += (-maxReverseSpeed - forwardSpeed) * 5;
		}

		let drivenGrounded = 0;
		for (const wheel of wheels) {
			if (isDrivenWheel(wheel.index)) drivenGrounded += 1;
		}

		const massPerWheel = mass / groundedCount;
		const propForcePerWheel = drivenGrounded > 0 ? (propulsionAccel * mass) / drivenGrounded : 0;

		// Horizontal tyre forces are applied at centre-of-mass height (but at
		// each wheel's horizontal position). The horizontal moment arm is kept,
		// so steering still yaws the car, but the vertical arm is removed so a
		// tyre force no longer torques the underdamped suspension roll mode into
		// a rocking oscillation. (Vertical suspension forces stay at the wheel.)
		const comHeight = chassis.AssemblyCenterOfMass.Y;

		// --- Per-wheel tyre forces ------------------------------------------
		for (const wheel of wheels) {
			const rearHandbrake = handbrakeDown && !isFrontWheel(wheel.index);
			const mu = tireGrip * (rearHandbrake ? handbrakeRearGrip : 1);

			// Lateral force from slip angle (simplified Pacejka). Opposes slip.
			const slipAngle = math.atan2(wheel.latVel, math.abs(wheel.longVel) + 0.5);
			let lateralForce = -wheel.load * mu * math.sin(pacejkaC * math.atan(pacejkaB * slipAngle));

			// Slip-cancel clamp: never push harder than what nulls this wheel's
			// sideways velocity this step. Near zero slip the tyre is extremely
			// stiff, so the raw force overshoots the actual sideways momentum and
			// reverses it every frame - that's the wobble. Capping the impulse to
			// the momentum it's cancelling removes the oscillation while staying
			// physical (at the grip limit the Pacejka force is the smaller term).
			const latCancelForce = (lateralBite * math.abs(wheel.latVel) * massPerWheel) / dt;
			if (math.abs(lateralForce) > latCancelForce) {
				lateralForce = math.sign(lateralForce) * latCancelForce;
			}

			// Longitudinal force: drive on powered wheels, braking on all.
			let longForce = isDrivenWheel(wheel.index) ? propForcePerWheel : 0;

			const wheelBrakeAccel = rearHandbrake ? brakeAccel + handbrakeBrakeAccel : brakeAccel;
			if (wheelBrakeAccel > 0 && math.abs(wheel.longVel) > 0.01) {
				// Clamp braking so it can't overshoot and reverse the wheel.
				const stoppingAccel = math.min(wheelBrakeAccel, math.abs(wheel.longVel) / dt);
				longForce -= math.sign(wheel.longVel) * stoppingAccel * massPerWheel;
			}

			// Friction circle: combined grip can't exceed mu * Fz.
			const maxForce = mu * wheel.load;
			const combined = math.sqrt(longForce * longForce + lateralForce * lateralForce);
			if (combined > maxForce && combined > 0) {
				const scale = maxForce / combined;
				longForce *= scale;
				lateralForce *= scale;
			}

			const tireForce = wheel.forward.mul(longForce).add(wheel.right.mul(lateralForce));
			const applyPoint = new Vector3(wheel.contactPoint.X, comHeight, wheel.contactPoint.Z);
			chassis.ApplyImpulseAtPosition(tireForce.mul(dt), applyPoint);
		}

		// --- Downforce ------------------------------------------------------
		// Pushes the car onto the road, which compresses the springs and so
		// raises tyre load (grip) at speed - handled through the suspension.
		const groundedRatio = groundedCount / wheelCount;
		const downforceAccel =
			math.clamp(speed * downforcePerSpeed, 0, maxDownforceAcceleration) * groundedRatio;
		chassis.ApplyImpulse(cf.UpVector.mul(-downforceAccel * mass * dt));

		// Light yaw damping to soften snap-oversteer without killing rotation.
		const yawRate = chassis.AssemblyAngularVelocity.Dot(cf.UpVector);
		chassis.ApplyAngularImpulse(cf.UpVector.mul(-yawRate * yawDamping * mass * dt));
	}

	// --- Anti-flip / leveling ----------------------------------------------
	const worldUp = new Vector3(0, 1, 0);
	const tiltAxis = cf.UpVector.Cross(worldUp);

	if (tiltAxis.Magnitude > 0.01) {
		chassis.ApplyAngularImpulse(tiltAxis.mul(uprightStrength * mass * dt));
	}

	const angularVelocity = chassis.AssemblyAngularVelocity;
	const yawVelocity = cf.UpVector.mul(angularVelocity.Dot(cf.UpVector));
	const rollPitchVelocity = angularVelocity.sub(yawVelocity);
	chassis.ApplyAngularImpulse(rollPitchVelocity.mul(-rollPitchDamping * mass * dt));
});
