import { Workspace } from "@rbxts/services";
import {
	MAX_STEER_ANGLE,
	STEER_MAX_LAT_ACCEL,
	SUSPENSION_LENGTH,
	WHEELBASE,
	WHEEL_NAMES,
	WHEEL_OFFSETS,
	WHEEL_RADIUS,
	wheelForceAttachmentName,
	wheelForceName,
	DRIFT_GRIP_FACTOR,
	DRIFT_MIN_DURATION_BOOST,
	DRIFT_BOOST_DURATION,
	DRIFT_BOOST_MULTIPLIER,
} from "./carConfig";
import { NITRO_BOOST_ACCEL, NITRO_SPEED_MULT, NITRO_UNTIL_ATTR } from "./powerupConfig";

// ---------------------------------------------------------------------------
// SLIP-ANGLE TIRE MODEL (per-wheel physics)
//
// The full driving simulation for one car, shared between the driving client
// (carClient runs it for the local player's car, which that client
// network-owns) and the server (bots.server runs it for bot cars, which stay
// server-owned). It must run on whichever machine owns the chassis assembly -
// forces applied anywhere else don't stick.
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
// generate lateral force ahead of the centre of mass. Drifting is not a
// scripted state - it emerges when a tyre's slip angle pushes past the peak.
//
// Forces are delivered through per-wheel VectorForce constraints applied at a
// roll-centre point below the centre of mass (see rollCenterFraction), updated
// in PreSimulation (before the physics step). A constraint force is integrated
// by every internal solver substep, which keeps the stiff spring/tyre forces
// stable where once-a-frame Heartbeat impulses oscillated. The vertical arm
// between that point and the centre of mass is what produces body roll, brake
// dive and the resulting load transfer between tyres.
// ---------------------------------------------------------------------------

// Suspension (spherecast springs that hold the car off the ground).
const suspensionLength = SUSPENSION_LENGTH;
const wheelCount = 4;
// NOTE: maxSuspensionAcceleration MUST exceed workspace.Gravity (default 196.2)
// or the springs can't hold the car up and the chassis drags on the ground.
// Spring and damper are absolute forces, not accelerations, so they must scale
// with chassis MASS (volume x density, both set in carConfig/carFactory) or
// the car sags and the damping ratio drifts. Current mass factor vs the
// original density-1 6x1x10 box: density 2 x volume ratio 3.6 = 7.2x, which
// keeps ride height, bounce frequency and damping ratio identical.
const springStrength = 43200;
// Kept moderate on purpose: the damper force is recomputed once per frame and
// held constant across the solver substeps, so too high a coefficient makes
// the roll mode's velocity term overshoot and flip sign every frame (visible
// as a standstill shudder). The stability limit scales with mass, so ~3240 at
// the current 7.2x mass factor sits where ~450 did at density-1 box scale:
// comfortably inside the stable region at 60 Hz and still ~0.7 of critical
// damping for the quarter-car bounce.
const damperStrength = 3240;
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
// Throttle traction loss (wheelspin). A driven wheel whose demand - drive
// force plus the lateral force the slip-angle curve is asking for - exceeds
// its grip budget mu*Fz starts to spin. A spinning contact patch slides mostly
// along the wheel's rolling direction, so lateral grip collapses (power
// oversteer) and total friction drops to a kinetic fraction. Straight-line
// throttle alone (~0.6 of the static budget) never breaks the tyre; throttle
// stacked on cornering load, an unloaded inside wheel, or a handbrake-slashed
// budget is what lights them up.
const wheelspinAttack = 8; // spin build rate while demand exceeds budget (1/s)
const wheelspinDecay = 3; // hook-up rate once demand fits again (1/s)
const wheelspinOverloadRange = 0.5; // overload fraction that maps to full spin
const wheelspinLatGripLoss = 0.8; // lateral grip lost at full spin
const wheelspinMuKinetic = 0.85; // fraction of mu a fully spinning tyre keeps
// Roll-centre height for horizontal tyre forces, as a fraction of the way
// from the centre-of-mass plane (0) down to the contact patch (1). The car
// rides ~4.7 studs above its contact patches, so applying lateral force at the
// patch itself gives a moment arm far longer than any real car's and the roll
// mode diverges (lean -> slip velocity at the patch -> tyre force -> more
// lean). Sizing: at full lateral saturation the roll torque is
// mu * weight * (comHeight * fraction); the springs can restore at most
// (maxWheelForce - staticLoad) * track before the inside wheels lift and the
// car can trip over. 0.15 keeps that torque at ~75% of the limit - visible
// body roll in hard corners (part of the car's sense of weight) with margin
// left before a full-lock snap at speed (mu 1.7, tall narrow chassis) can
// roll the car. Raise for drama, lower if it ever tips. Slip velocity is
// measured at this same point so the tyre force damps exactly the motion it
// excites.
const rollCenterFraction = 0.15;
// How much of a tyre's sideways slip it may cancel per physics step (0-1).
// 1 = deadbeat (kills all sideways motion in one frame - stable but the car
// can't rotate and feels dead). Lower lets yaw and slides decay over several
// frames, keeping rotational life, while staying below the overshoot threshold
// that caused the wobble. This is the single most important stability knob,
// and also the main weight-feel knob: lower values let the car carry sideways
// momentum into direction changes, so it leans into corners instead of
// darting. 0.35 trades some of 0.5's crispness for that planted, massy feel.
const lateralBite = 0.35;

// Steering. Front wheels turn up to maxSteerAngle. Rather than a blanket lock
// reduction with speed (which left ~7 degrees above half of top speed and made
// mid-speed corners numb), lock is capped by the lateral acceleration a
// kinematic turn would demand at the current speed: a = v^2 * tan(steer) /
// wheelbase, so cap = atan(steerMaxLatAccel * wheelbase / v^2). Full lock
// stays available below ~50 studs/s, and above that the cap gives exactly the
// lock the tyres can use instead of a fixed numb fraction.
const maxSteerAngle = MAX_STEER_ANGLE;
const wheelbase = WHEELBASE;
// Just below the tyres' peak lateral acceleration (tireGrip * gravity ~ 333):
// a held key asks the fronts for nearly everything they have, but can't push
// them far past the Pacejka peak into a plow (or the rollover margin the
// roll-centre sizing assumes) at speed. Value lives in carConfig because the
// wheel visuals reconstruct the same lock for remote viewers.
const steerMaxLatAccel = STEER_MAX_LAT_ACCEL;
// Kept moderate so binary keyboard input can't step-function the front tyres
// into full lateral saturation - the roll/yaw modes get a few frames to react.
const steerResponse = 4;
// Extra turn-in slowdown with speed (fraction of steerResponse removed at top
// speed), since the g-cap now allows real lock at mid speeds. Centring and
// counter-steer always run at the full rate so recovery stays crisp.
const steerRateSpeedFalloff = 0.5;

// Stability / feel.
const downforcePerSpeed = 0.5;
const maxDownforceAcceleration = 55;
// Eased (from 40/5) so the nose dives under braking and squats under
// throttle - pitch motion is one of the strongest weight cues a player reads.
// uprightStrength is also the anti-flip recovery; don't drop it much further.
const uprightStrength = 28;
const rollPitchDamping = 4;
const yawDamping = 2.5; // damping to take the edge off snap-oversteer

// Input smoothing. Throttle deliberately slow-ish: power builds (and releases)
// over ~0.2s like a drivetrain with flywheel inertia, rather than snapping on.
const throttleResponse = 5;

function moveTowards(current: number, target: number, maxDelta: number) {
	if (current < target) {
		return math.min(current + maxDelta, target);
	}

	return math.max(current - maxDelta, target);
}

// Per-wheel data captured during the suspension pass, reused for tyre forces.
interface WheelState {
	index: number;
	applyPoint: Vector3; // roll-centre point where the wheel's force acts
	load: number; // vertical force pressing the tyre onto the road (Fz)
	suspensionForce: number; // signed spring+damper force along chassis up
	forward: Vector3; // wheel's rolling direction (steered for the fronts)
	right: Vector3; // wheel's lateral direction
	longVel: number; // velocity along forward
	latVel: number; // velocity along right
}

// Raw driver command for one step, from keyboard (carClient) or AI (bots).
export interface CarDriveInput {
	throttle: number; // -1..1
	steer: number; // -1..1, positive = left (matches the A key)
	handbrake: boolean;
}

export interface CarSim {
	readonly car: Model;
	readonly chassis: BasePart;
	/**
	 * Advance one physics step; call from RunService.PreSimulation on the
	 * machine that owns the chassis assembly. Pass undefined while nobody is
	 * driving: inputs decay, the wheel forces zero out and the car settles.
	 */
	step: (dt: number, input?: CarDriveInput) => void;
	// Live outputs for presentation scripts (HUD, wheel visuals).
	steerAngle: number; // radians, positive = left
	throttle: number; // smoothed, -1..1
	handbrake: boolean;
	wheelSpin: number[]; // per-wheel 0..1, indices per WHEEL_OFFSETS
}

export function createCarSim(car: Model, chassis: BasePart): CarSim {
	// Per-wheel force actuators (created by the server). Each wheel's suspension
	// + tyre force goes through a VectorForce acting at an attachment moved to
	// the wheel's roll-centre point each step, so the solver integrates it
	// through all of its internal substeps instead of receiving one big
	// once-a-frame impulse.
	const wheelForces = WHEEL_NAMES.map((name) => chassis.WaitForChild(wheelForceName(name)) as VectorForce);
	const wheelForceAttachments = WHEEL_NAMES.map(
		(name) => chassis.WaitForChild(wheelForceAttachmentName(name)) as Attachment,
	);

	function zeroWheelForces() {
		for (const vectorForce of wheelForces) {
			vectorForce.Force = Vector3.zero;
		}
	}

	const rayParams = new RaycastParams();
	rayParams.FilterType = Enum.RaycastFilterType.Exclude;
	rayParams.FilterDescendantsInstances = [car];
	rayParams.IgnoreWater = true;
	// Suspension rays must only see drivable surfaces. Raycasts hit CanCollide=false
	// parts by default, so without this the floating pickup cores read as 3-stud
	// steps in the road and catapult the car at speed.
	rayParams.RespectCanCollide = true;

	let smoothedThrottle = 0;
	let smoothedSteer = 0;
	let isDrifting = false;
	let driftDirection = 0; // 1 = left, -1 = right
	let driftDuration = 0;
	let boostUntil = 0;

	// Built without `step`, which is attached below: Luau locals don't hoist
	// the way TS function declarations do, so referencing the function inside
	// this literal would compile to nil.
	const sim = {
		car,
		chassis,
		steerAngle: 0,
		throttle: 0,
		handbrake: false,
		wheelSpin: [0, 0, 0, 0],
	} as CarSim;
	const wheelSpin = sim.wheelSpin;

	function step(dt: number, input?: CarDriveInput) {
		if (input === undefined) {
			smoothedThrottle = moveTowards(smoothedThrottle, 0, throttleResponse * dt);
			smoothedSteer = moveTowards(smoothedSteer, 0, steerResponse * dt);
			zeroWheelForces();
			sim.throttle = smoothedThrottle;
			sim.handbrake = false;
			return;
		}

		const throttleTarget = math.clamp(input.throttle, -1, 1);
		const handbrakeDown = input.handbrake;
		smoothedThrottle = moveTowards(smoothedThrottle, throttleTarget, throttleResponse * dt);

		const cf = chassis.CFrame;
		const mass = chassis.AssemblyMass;
		const com = chassis.AssemblyCenterOfMass;
		const velocity = chassis.AssemblyLinearVelocity;
		const forwardSpeed = velocity.Dot(cf.LookVector);
		const speed = velocity.Magnitude;

		// --- Dynamic Drift State Activation/Deactivation -----------------------
		if (isDrifting) {
			if (!handbrakeDown || speed < 5) {
				isDrifting = false;
				
				// Award speed boost if drift lasted longer than threshold
				if (driftDuration >= DRIFT_MIN_DURATION_BOOST) {
					boostUntil = Workspace.GetServerTimeNow() + DRIFT_BOOST_DURATION;
				}
				
				driftDuration = 0;
				driftDirection = 0;
			} else {
				driftDuration += dt;
			}
		} else {
			if (handbrakeDown && math.abs(input.steer) > 0.1 && speed > 10) {
				isDrifting = true;
				driftDirection = math.sign(input.steer); // 1 = left, -1 = right
				driftDuration = 0;
				
				// Outward visual hop: brief upward/outward impulse
				const hopDir = Vector3.yAxis.mul(12).add(cf.RightVector.mul(driftDirection * 8));
				chassis.AssemblyLinearVelocity = chassis.AssemblyLinearVelocity.add(hopDir);
			}
		}

		const boostActive = Workspace.GetServerTimeNow() < boostUntil;
		if (boostActive) {
			const boostForce = cf.LookVector.mul(driveAcceleration * DRIFT_BOOST_MULTIPLIER * mass * dt);
			chassis.ApplyImpulse(boostForce);
		}

		// Steering input ramp: turn-in slows with speed, centring/counter-steer
		// (target at zero or across it) does not.
		const steerTarget = math.clamp(input.steer, -1, 1);
		const turningIn = math.abs(steerTarget) > math.abs(smoothedSteer) && steerTarget * smoothedSteer >= 0;
		const speedFrac = math.clamp(math.abs(forwardSpeed) / maxForwardSpeed, 0, 1);
		const steerRate = steerResponse * (turningIn ? 1 - steerRateSpeedFalloff * speedFrac : 1);
		smoothedSteer = moveTowards(smoothedSteer, steerTarget, steerRate * dt);

		// Nitro power-up: the server stamps a boost window on the chassis; while
		// it's open the speed cap rises and the car gets straight-line thrust.
		const nitroUntil = (chassis.GetAttribute(NITRO_UNTIL_ATTR) as number | undefined) ?? 0;
		const nitroActive = Workspace.GetServerTimeNow() < nitroUntil;
		const speedCap = nitroActive || boostActive ? maxForwardSpeed * NITRO_SPEED_MULT : maxForwardSpeed;

		// Speed-sensitive steering lock via the lateral-g cap (see steerMaxLatAccel).
		// Positive steer = left (matches A).
		const steerLock = math.min(
			maxSteerAngle,
			math.atan((steerMaxLatAccel * wheelbase) / math.max(forwardSpeed * forwardSpeed, 1)),
		);
		const steerAngle = smoothedSteer * steerLock;

		// Publish the live sim state for presentation scripts.
		sim.steerAngle = steerAngle;
		sim.throttle = smoothedThrottle;
		sim.handbrake = handbrakeDown;
		const sinS = math.sin(steerAngle);
		const cosS = math.cos(steerAngle);
		// Front wheel axes, rotated about the chassis up by the steer angle.
		const frontForward = cf.LookVector.mul(cosS).sub(cf.RightVector.mul(sinS));
		const frontRight = cf.RightVector.mul(cosS).add(cf.LookVector.mul(sinS));

		// --- Suspension pass: measure each tyre's spring force and load --------
		// Nothing is applied here; the spring force joins the tyre force below and
		// both go out through the wheel's VectorForce in a single update.
		const wheels = new Array<WheelState>();
		const grounded = [false, false, false, false];

		for (const [index, offset] of ipairs(WHEEL_OFFSETS)) {
			const i = index - 1;
			const origin = cf.PointToWorldSpace(offset);

			// Spherecast with the wheel's radius instead of a thin ray: a ray reads
			// a kerb lip, road seam or stray debris part as a step-function in ride
			// height (one frame of huge compression = catapult), while a sphere
			// rides over anything smaller than the wheel the way a round tyre does.
			// The cast starts a radius above the wheel origin: shapecasts ignore
			// parts they already overlap at the start, so casting from the origin
			// itself goes blind exactly when the car is beached or bottomed out and
			// needs the spring most. Distance (centre travel) minus that lift is
			// then directly the current suspension length.
			const castLift = WHEEL_RADIUS + 0.1;
			const castOrigin = origin.add(cf.UpVector.mul(castLift));
			const direction = cf.UpVector.mul(-(suspensionLength + castLift));
			const result = Workspace.Spherecast(castOrigin, WHEEL_RADIUS, direction, rayParams);

			if (!result) continue;

			// A wheel-fat sphere can graze near-vertical faces (walls, kerb sides)
			// beside the car. Treating those as suspension contact would fire the
			// spring along chassis-up off a sideways surface; skip them instead.
			if (result.Normal.Dot(cf.UpVector) < 0.2) continue;

			const currentSuspensionLength = math.clamp(result.Distance - castLift, 0, suspensionLength);
			const compression = suspensionLength - currentSuspensionLength;

			const velocityAtWheel = chassis.GetVelocityAtPosition(origin);
			const verticalVelocity = velocityAtWheel.Dot(cf.UpVector);

			const springForce = springStrength * compression;
			const dampingForce = damperStrength * verticalVelocity;

			const maxWheelForce = (mass * maxSuspensionAcceleration) / wheelCount;
			const suspensionForceMagnitude = math.clamp(
				springForce - dampingForce,
				-maxWheelForce * 0.35,
				maxWheelForce,
			);

			// The tyre load is the upward force the spring is pushing with. This is
			// what couples weight transfer into grip: a compressed corner grips more.
			const load = math.max(0, suspensionForceMagnitude);

			const isFront = isFrontWheel(i);
			const wheelForward = isFront ? frontForward : cf.LookVector;
			const wheelRight = isFront ? frontRight : cf.RightVector;

			// Lift the force application point from the contact patch toward the
			// centre-of-mass plane (see rollCenterFraction). Slip velocity is read
			// at the same point so the force opposes the exact motion it creates.
			const contactToCom = com.sub(result.Position).Dot(cf.UpVector);
			const applyPoint = result.Position.add(cf.UpVector.mul(contactToCom * (1 - rollCenterFraction)));

			const pointVel = chassis.GetVelocityAtPosition(applyPoint);
			const planarVel = pointVel.sub(cf.UpVector.mul(pointVel.Dot(cf.UpVector)));

			grounded[i] = true;
			wheels.push({
				index: i,
				applyPoint,
				load,
				suspensionForce: suspensionForceMagnitude,
				forward: wheelForward,
				right: wheelRight,
				longVel: planarVel.Dot(wheelForward),
				latVel: planarVel.Dot(wheelRight),
			});
		}

		// Airborne wheels must not keep pushing with last frame's force, and their
		// spin winds down while they're off the ground.
		for (let i = 0; i < wheelCount; i++) {
			if (!grounded[i]) {
				wheelForces[i].Force = Vector3.zero;
				wheelSpin[i] = moveTowards(wheelSpin[i], 0, wheelspinDecay * dt);
			}
		}

		const groundedCount = wheels.size();

		if (groundedCount > 0) {
			// --- Longitudinal command (shared across wheels) --------------------
			// propulsionAccel drives the powered wheels; brakeAccel opposes motion
			// on every wheel. Splitting them this way lets brakes load the fronts.
			let propulsionAccel = 0;
			let brakeAccel = 0;

			const lateralSpeed = math.abs(velocity.Dot(cf.RightVector));
			const isSliding = lateralSpeed > 15;

			if (smoothedThrottle > 0.02) {
				if (forwardSpeed < -2 && !isSliding) {
					brakeAccel = smoothedThrottle * brakeAcceleration;
				} else {
					const limiter = 1 - math.clamp(forwardSpeed / maxForwardSpeed, 0, 1) * (1 - highSpeedPower);
					propulsionAccel = smoothedThrottle * driveAcceleration * limiter;
				}
			} else if (smoothedThrottle < -0.02) {
				const reverseInput = -smoothedThrottle;

				if (forwardSpeed > 2 && !isSliding) {
					brakeAccel = reverseInput * brakeAcceleration;
				} else {
					const limiter = 1 - math.clamp(-forwardSpeed / maxReverseSpeed, 0, 1) * reverseHighSpeedFalloff;
					propulsionAccel = -reverseInput * reverseAcceleration * limiter;
				}
			} else {
				brakeAccel = math.clamp(math.abs(forwardSpeed) * rollingResistance, 0, maxCoastDeceleration);
			}

			// Top-speed limiter folds into braking so the car can't run away.
			// (speedCap rises while nitro is active so the boost isn't braked off.)
			if (forwardSpeed > speedCap) {
				brakeAccel += (forwardSpeed - speedCap) * 4;
			} else if (forwardSpeed < -maxReverseSpeed) {
				brakeAccel += (-maxReverseSpeed - forwardSpeed) * 5;
			}

			// Nitro thrust: straight-line shove independent of the tyre model, so it
			// works even with spinning/limited wheels — like a rocket strapped on.
			if (nitroActive) {
				chassis.ApplyImpulse(cf.LookVector.mul(NITRO_BOOST_ACCEL * mass * dt));
			}

			let drivenGrounded = 0;
			for (const wheel of wheels) {
				if (isDrivenWheel(wheel.index)) drivenGrounded += 1;
			}

			const massPerWheel = mass / groundedCount;
			const propForcePerWheel = drivenGrounded > 0 ? (propulsionAccel * mass) / drivenGrounded : 0;

			// --- Per-wheel tyre forces ------------------------------------------
			for (const wheel of wheels) {
				const rearHandbrake = handbrakeDown && !isFrontWheel(wheel.index);
				const mu = tireGrip * (rearHandbrake ? handbrakeRearGrip : 1);
				let lateralForce = 0;
				let longForce = 0;

				if (isDrifting) {
					lateralForce = 0;
					longForce = 0;
				} else {
					// Lateral force from slip angle (simplified Pacejka). Opposes slip.
					const slipAngle = math.atan2(wheel.latVel, math.abs(wheel.longVel) + 0.5);
					lateralForce = -wheel.load * mu * math.sin(pacejkaC * math.atan(pacejkaB * slipAngle));

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

					const driveForce = isDrivenWheel(wheel.index) ? propForcePerWheel : 0;

					// Wheelspin state: compare the tyre's demand (drive + the lateral
					// force it's being asked for, pre-penalty) against its budget, then
					// build or decay the spin level (see wheelspinAttack/Decay). Braking
					// demand is excluded - lockup is the handbrake's job.
					if (isDrivenWheel(wheel.index)) {
						const budget = mu * wheel.load;
						const demand = math.sqrt(driveForce * driveForce + lateralForce * lateralForce);
						const overload = (demand - budget) / math.max(budget * wheelspinOverloadRange, 1);
						const target = math.clamp(overload, 0, 1);
						const rate = target > wheelSpin[wheel.index] ? wheelspinAttack : wheelspinDecay;
						wheelSpin[wheel.index] = moveTowards(wheelSpin[wheel.index], target, rate * dt);
					}

					// A spinning tyre keeps only kinetic friction, and what's left acts
					// mostly along its rolling direction - lateral grip collapses.
					const spin = wheelSpin[wheel.index];
					const muEff = mu * (1 - spin * (1 - wheelspinMuKinetic));
					lateralForce *= 1 - spin * wheelspinLatGripLoss;

					// Longitudinal force: drive on powered wheels, braking on all.
					longForce = driveForce;

					const isPowerSliding = input !== undefined && handbrakeDown && math.abs(input.steer) > 0.1;
					const activeHandbrakeBrakeAccel = isPowerSliding ? 90 : handbrakeBrakeAccel;
					const wheelBrakeAccel = rearHandbrake ? brakeAccel + activeHandbrakeBrakeAccel : brakeAccel;
					if (wheelBrakeAccel > 0 && math.abs(wheel.longVel) > 0.01) {
						// Clamp braking so it can't overshoot and reverse the wheel.
						const stoppingAccel = math.min(wheelBrakeAccel, math.abs(wheel.longVel) / dt);
						longForce -= math.sign(wheel.longVel) * stoppingAccel * massPerWheel;
					}

					// Friction circle: combined grip can't exceed (effective) mu * Fz.
					const maxForce = muEff * wheel.load;
					const combined = math.sqrt(longForce * longForce + lateralForce * lateralForce);
					if (combined > maxForce && combined > 0) {
						const scale = maxForce / combined;
						
						// For driven wheels, prevent the engine drive force from dropping to zero during hard slides
						if (isDrivenWheel(wheel.index) && driveForce !== 0) {
							const isPowerSliding = input !== undefined && handbrakeDown && math.abs(input.steer) > 0.1;
							const minDriveScale = isPowerSliding ? 0.75 : 0.45; // Preserve at least 75% engine power during power slides
							const driveScale = math.max(scale, minDriveScale);
							longForce *= driveScale;
							
							// Allocate the remaining grip budget to the lateral force
							const remainingGripSq = math.max(0, maxForce * maxForce - longForce * longForce);
							lateralForce = math.sign(lateralForce) * math.sqrt(remainingGripSq);
						} else {
							longForce *= scale;
							lateralForce *= scale;
						}
					}
				}

				// Suspension + tyre force through this wheel's VectorForce, acting at
				// the roll-centre point below the centre of mass. The remaining
				// vertical arm gives the horizontal forces their roll/pitch moments -
				// that is the weight transfer the tyre loads respond to next frame.
				// (The suspension component is along chassis up, so lifting the point
				// off the contact patch does not change its torque.)
				const totalForce = wheel.forward
					.mul(longForce)
					.add(wheel.right.mul(lateralForce))
					.add(cf.UpVector.mul(wheel.suspensionForce));
				wheelForceAttachments[wheel.index].Position = cf.PointToObjectSpace(wheel.applyPoint);
				wheelForces[wheel.index].Force = totalForce;
			}

			// --- Downforce ------------------------------------------------------
			// Pushes the car onto the road, which compresses the springs and so
			// raises tyre load (grip) at speed - handled through the suspension.
			const groundedRatio = groundedCount / wheelCount;
			const downforceAccel =
				math.clamp(speed * downforcePerSpeed, 0, maxDownforceAcceleration) * groundedRatio;
			chassis.ApplyImpulse(cf.UpVector.mul(-downforceAccel * mass * dt));

			// If drifting, apply velocity redirection constraint and counter-steering yaw rotation
			if (isDrifting) {
				// 1. Velocity Redirection Lerp Math:
				// Decouple vertical and planar velocity to avoid messing with gravity/suspension
				const planarVelocity = velocity.sub(cf.UpVector.mul(velocity.Dot(cf.UpVector)));
				const currentMagnitude = planarVelocity.Magnitude;
				
				// Projected target forward direction along the terrain surface
				const targetPlanarDir = cf.LookVector.sub(cf.UpVector.mul(cf.LookVector.Dot(cf.UpVector))).Unit;
				const targetPlanarVelocity = targetPlanarDir.mul(currentMagnitude);
				
				// Lerp velocity direction towards LookVector
				let newPlanarVelocity = planarVelocity.Lerp(targetPlanarVelocity, DRIFT_GRIP_FACTOR * dt);
				
				// Preserve momentum (at least 90% of forward speed or planarMagnitude to prevent stalling)
				let targetSpeed = currentMagnitude;
				if (smoothedThrottle > 0) {
					targetSpeed = math.min(speedCap, targetSpeed + driveAcceleration * dt);
				} else if (smoothedThrottle < 0) {
					targetSpeed = math.max(0, targetSpeed - brakeAcceleration * dt);
				}
				
				// Ensure at least 90% of forwardSpeed momentum is preserved
				const minSpeed = math.max(currentMagnitude * 0.9, forwardSpeed * 0.9);
				const speedToUse = math.max(targetSpeed, minSpeed);
				
				if (newPlanarVelocity.Magnitude > 0.01) {
					newPlanarVelocity = newPlanarVelocity.Unit.mul(speedToUse);
				} else {
					newPlanarVelocity = targetPlanarDir.mul(speedToUse);
				}
				
				// Combine planar and vertical velocities
				chassis.AssemblyLinearVelocity = newPlanarVelocity.add(cf.UpVector.mul(velocity.Dot(cf.UpVector)));

				// 2. Custom Drift Yaw Rotation with Counter-Steering Control:
				// If player steers into drift direction: sharpen turn.
				// If player counter-steers away: widen turn.
				const steerCompat = input.steer * driftDirection;
				const baseDriftTurnRate = math.rad(52); // turn rate for smooth drifts
				let activeTurnRate = baseDriftTurnRate;
				if (steerCompat > 0) {
					// Steering into turn: sharpen turning radius
					activeTurnRate *= 1 + steerCompat * 0.6;
				} else {
					// Counter-steering: widen turning radius (slip outward)
					activeTurnRate *= 1 + steerCompat * 0.75;
				}
				
				// Apply rotation torque around the ground normal
				chassis.ApplyAngularImpulse(cf.UpVector.mul(driftDirection * activeTurnRate * mass * dt));
			} else {
				// Light yaw damping to soften snap-oversteer without killing rotation.
				const yawRate = chassis.AssemblyAngularVelocity.Dot(cf.UpVector);
				chassis.ApplyAngularImpulse(cf.UpVector.mul(-yawRate * yawDamping * mass * dt));
			}
		}

		// --- Anti-flip / leveling & Ground Normal Alignment --------------------
		const groundRayParams = new RaycastParams();
		groundRayParams.FilterType = Enum.RaycastFilterType.Include;
		groundRayParams.FilterDescendantsInstances = [Workspace.Terrain];
		groundRayParams.IgnoreWater = true;

		// Raycast down from the chassis center to find the ground normal under the vehicle.
		const groundCast = Workspace.Raycast(chassis.Position, new Vector3(0, -35, 0), groundRayParams);
		let targetUp = groundCast ? groundCast.Normal : new Vector3(0, 1, 0);

		if (isDrifting) {
			const driftTilt = cf.RightVector.mul(-driftDirection * 0.18);
			targetUp = targetUp.add(driftTilt).Unit;
		}

		const tiltAxis = cf.UpVector.Cross(targetUp);

		// Significantly increased alignment torque (from 28 to 95) for rapid upright realignment.
		const activeUprightStrength = 95;
		if (tiltAxis.Magnitude > 0.01) {
			chassis.ApplyAngularImpulse(tiltAxis.mul(activeUprightStrength * mass * dt));
		}

		// --- Arcade Grounding Force ("Glue") -----------------------------------
		// If the car is airborne (no wheels grounded) but the ground is close,
		// apply a strong downward force to pull it back to the terrain normal.
		if (groundedCount === 0 && groundCast) {
			const dist = groundCast.Distance;
			if (dist < 20) {
				const glueAcceleration = 130; // studs/s^2 downward acceleration
				chassis.ApplyImpulse(targetUp.mul(-glueAcceleration * mass * dt));
			}
		}

		// --- Hard Flip Constraint & AngularVelocity Clamp --------------------
		// Calculate deviation angle from the ground normal. If it exceeds a critical threshold
		// (e.g. 40 degrees), manually rotate the CFrame back and cancel the flip momentum.
		const dot = cf.UpVector.Dot(targetUp);
		const tiltAngle = math.acos(math.clamp(dot, -1, 1));
		const maxTilt = math.rad(40); // 40 degrees maximum deviation from ground normal

		if (tiltAngle > maxTilt) {
			const axis = cf.UpVector.Cross(targetUp);
			if (axis.Magnitude > 1e-4) {
				const normAxis = axis.Unit;
				// 1. Force the CFrame to snap back to the maxTilt boundary
				const correctiveAngle = tiltAngle - maxTilt;
				chassis.CFrame = CFrame.fromAxisAngle(normAxis, correctiveAngle).mul(cf.Rotation).add(cf.Position);

				// 2. Kill the angular velocity component rotating the car further into the flip
				const angVel = chassis.AssemblyAngularVelocity;
				chassis.AssemblyAngularVelocity = angVel.sub(normAxis.mul(angVel.Dot(normAxis)));
			}
		}

		// --- Dynamic Landing / Impact Damping ----------------------------------
		const angularVelocity = chassis.AssemblyAngularVelocity;
		const yawVelocity = cf.UpVector.mul(angularVelocity.Dot(cf.UpVector));
		const rollPitchVelocity = angularVelocity.sub(yawVelocity);

		let activeRollPitchDamping = rollPitchDamping;
		const verticalSpeed = math.abs(chassis.AssemblyLinearVelocity.Dot(cf.UpVector));
		if (verticalSpeed > 8) {
			// Absorb high vertical landing energy into the suspension damping dynamically
			// instead of converting it into rotational roll/pitch torque.
			activeRollPitchDamping += verticalSpeed * 1.5;
		}
		chassis.ApplyAngularImpulse(rollPitchVelocity.mul(-activeRollPitchDamping * mass * dt));

		// Set the IsDrifting attribute so clients can sync drift visual effects (sparks/smoke/trails)
		car.SetAttribute("IsDrifting", isDrifting);
	}

	sim.step = step;
	return sim;
}
