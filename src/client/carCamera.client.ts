import { Players, RunService, Workspace } from "@rbxts/services";
import { CAR_NAME, CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";

const localPlayer = Players.LocalPlayer;
const car = Workspace.WaitForChild(CAR_NAME) as Model;
const chassis = car.WaitForChild(CHASSIS_NAME) as BasePart;
const seat = car.WaitForChild(SEAT_NAME) as VehicleSeat;

// ---------------------------------------------------------------------------
// ARCADE CHASE CAMERA
// Keeps the camera planted behind the car so you always look where you're
// going. Swings in behind the heading, pulls back and widens the FOV with
// speed for that Need-for-Speed sense of velocity.
// ---------------------------------------------------------------------------
const baseDistance = 15; // how far behind the car the camera sits
const baseHeight = 6; // how high above the car
const lookHeight = 3; // aim point height above the car
const lookAhead = 6; // aim slightly ahead of the car
const followStiffness = 10; // how fast the camera swings behind the car (higher = snappier)
const distancePerSpeed = 0.035; // camera pulls back as you go faster
const maxExtraDistance = 8;
const baseFov = 70;
const fovPerSpeed = 0.12; // FOV widens with speed (sense of speed)
const maxExtraFov = 18;

let scriptableActive = false;
let lastFlatHeading = chassis.CFrame.LookVector;

function getHumanoid() {
	return localPlayer.Character?.FindFirstChildOfClass("Humanoid");
}

function isDriving() {
	const humanoid = getHumanoid();
	return humanoid !== undefined && seat.Occupant === humanoid;
}

RunService.RenderStepped.Connect((dt) => {
	const camera = Workspace.CurrentCamera;
	if (!camera) return;

	if (!isDriving()) {
		// Hand control back to the normal character camera when out of the car.
		if (scriptableActive) {
			camera.CameraType = Enum.CameraType.Custom;
			const humanoid = getHumanoid();
			if (humanoid) camera.CameraSubject = humanoid;
			camera.FieldOfView = baseFov;
			scriptableActive = false;
		}
		return;
	}

	if (!scriptableActive) {
		camera.CameraType = Enum.CameraType.Scriptable;
		scriptableActive = true;
	}

	const cf = chassis.CFrame;
	const carPos = cf.Position;

	// Flatten the car's heading so the camera stays level over bumps, ramps
	// and jumps instead of pitching/rolling with the chassis.
	const look = cf.LookVector;
	const flat = new Vector3(look.X, 0, look.Z);
	const heading = flat.Magnitude > 0.05 ? flat.Unit : lastFlatHeading;
	lastFlatHeading = heading;

	const speed = chassis.AssemblyLinearVelocity.Magnitude;
	const distance = baseDistance + math.min(speed * distancePerSpeed, maxExtraDistance);

	const desiredPos = carPos.sub(heading.mul(distance)).add(new Vector3(0, baseHeight, 0));
	const lookAt = carPos.add(heading.mul(lookAhead)).add(new Vector3(0, lookHeight, 0));
	const desiredCFrame = CFrame.lookAt(desiredPos, lookAt);

	// Framerate-independent smoothing so it feels the same at any FPS.
	const alpha = 1 - math.exp(-followStiffness * dt);
	camera.CFrame = camera.CFrame.Lerp(desiredCFrame, alpha);

	const desiredFov = baseFov + math.min(speed * fovPerSpeed, maxExtraFov);
	camera.FieldOfView = camera.FieldOfView + (desiredFov - camera.FieldOfView) * alpha;
});
