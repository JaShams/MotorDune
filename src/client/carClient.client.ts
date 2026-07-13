import { Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { createCarSim } from "shared/carSim";
import { MATCH_PHASE_ATTR, ROUND_ELIMINATED_ATTR } from "shared/sessionConfig";
import { localDrive } from "./carState";
import { waitForLocalCar } from "./localCar";

// ---------------------------------------------------------------------------
// DRIVER CLIENT
// Hosts the shared car simulation (shared/carSim) for the local player's car.
// The driver network-owns the chassis, so the physics must run here; this
// script's own job is just keyboard input, the flip reset, and publishing the
// live sim state to the other presentation scripts via localDrive.
// ---------------------------------------------------------------------------

const localPlayer = Players.LocalPlayer;
const { car, chassis, seat } = waitForLocalCar();

const sim = createCarSim(car, chassis);
// The visuals read wheelspin through localDrive; hand them the sim's array.
localDrive.wheelSpin = sim.wheelSpin;

const rayParams = new RaycastParams();
rayParams.FilterType = Enum.RaycastFilterType.Exclude;
rayParams.FilterDescendantsInstances = [car];
rayParams.IgnoreWater = true;
rayParams.RespectCanCollide = true;

// Flip recovery. The upright assist has a dead zone when the car is fully
// inverted (the tilt axis vanishes at 180 degrees), so a rolled car would be
// stranded; R sets it back on its wheels in place, keeping its heading.
const flipResetCooldown = 3;
const flipResetHeight = 3; // studs above the ground to re-drop from
let lastFlipReset = -math.huge;

let wDown = false;
let sDown = false;
let aDown = false;
let dDown = false;
let handbrakeDown = false;

UserInputService.InputBegan.Connect((input, gameProcessed) => {
	if (gameProcessed) return;

	if (input.KeyCode === Enum.KeyCode.W) wDown = true;
	if (input.KeyCode === Enum.KeyCode.S) sDown = true;
	if (input.KeyCode === Enum.KeyCode.A) aDown = true;
	if (input.KeyCode === Enum.KeyCode.D) dDown = true;
	if (input.KeyCode === Enum.KeyCode.LeftShift || input.KeyCode === Enum.KeyCode.RightShift) {
		handbrakeDown = true;
	}
	if (input.KeyCode === Enum.KeyCode.R) tryFlipReset();
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

function tryFlipReset() {
	if (!isLocalPlayerDriving()) return;
	if (os.clock() - lastFlipReset < flipResetCooldown) return;
	lastFlipReset = os.clock();

	// Keep the car's heading: project its look vector onto the ground plane.
	// Fall back to the up vector's horizontal part (nose pointing straight
	// up/down), then to world -Z, so the result is never degenerate.
	const cf = chassis.CFrame;
	let forward = new Vector3(cf.LookVector.X, 0, cf.LookVector.Z);
	if (forward.Magnitude < 0.05) forward = new Vector3(cf.UpVector.X, 0, cf.UpVector.Z);
	if (forward.Magnitude < 0.05) forward = new Vector3(0, 0, -1);
	forward = forward.Unit;

	const pos = chassis.Position;
	const ground = Workspace.Raycast(pos.add(new Vector3(0, 50, 0)), new Vector3(0, -150, 0), rayParams);
	const targetY = (ground ? ground.Position.Y : pos.Y) + flipResetHeight;
	const target = new Vector3(pos.X, targetY, pos.Z);

	// The driving client owns the assembly, so setting the CFrame replicates.
	chassis.AssemblyLinearVelocity = Vector3.zero;
	chassis.AssemblyAngularVelocity = Vector3.zero;
	chassis.CFrame = CFrame.lookAt(target, target.add(forward));
}

// Lock the driver in: a seat exit is jump-triggered, and humanoid state
// changes only stick on the machine simulating the character, so the driver's
// own client turns jumping off while seated (the server re-seats as a
// backstop if something else unseats us). Space simply does nothing seated.
seat.GetPropertyChangedSignal("Occupant").Connect(() => {
	const humanoid = getLocalHumanoid();
	if (humanoid !== undefined && seat.Occupant === humanoid) {
		humanoid.SetStateEnabled(Enum.HumanoidStateType.Jumping, false);
	}
});

RunService.PreSimulation.Connect((dt) => {
	const phase = Workspace.GetAttribute(MATCH_PHASE_ATTR);
	if ((phase !== undefined && phase !== "active") || car.GetAttribute(ROUND_ELIMINATED_ATTR) === true) {
		sim.step(dt, { throttle: 0, steer: 0, handbrake: true });
		localDrive.driving = false;
		return;
	}
	if (!isLocalPlayerDriving()) {
		sim.step(dt, undefined);
		localDrive.driving = false;
		return;
	}

	sim.step(dt, { throttle: getThrottle(), steer: getSteer(), handbrake: handbrakeDown });

	// Publish the live sim state for this client's presentation scripts.
	localDrive.driving = true;
	localDrive.steerAngle = sim.steerAngle;
	localDrive.throttle = sim.throttle;
	localDrive.handbrake = sim.handbrake;
});
