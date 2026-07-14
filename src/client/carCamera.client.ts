import { Players, RunService, Workspace } from "@rbxts/services";
import { waitForLocalCar } from "./localCar";
import { isLookBackHeld } from "./controlInput";
import { stepCameraImpact } from "./impactFeedback";

const localPlayer = Players.LocalPlayer;
const { car, chassis, seat } = waitForLocalCar();

// ---------------------------------------------------------------------------
// ARCADE CHASE CAMERA
// Keeps the camera planted behind the car so you always look where you're
// going. Swings in behind the heading at a fixed distance and FOV.
// ---------------------------------------------------------------------------
const baseDistance = 21; // how far behind the car the camera sits (scaled ~1.4x with the buggy-sized car)
const baseHeight = 8; // how high above the car
const lookHeight = 4; // aim point height above the car
const lookAhead = 8; // aim slightly ahead of the car
const followStiffness = 10; // how fast the camera swings behind the car (higher = snappier)
const baseFov = 70;

const occlusionParams = new RaycastParams();
occlusionParams.FilterType = Enum.RaycastFilterType.Exclude;
occlusionParams.RespectCanCollide = true; // pickups and FX don't block the view

let scriptableActive = false;
let lastFlatHeading = chassis.CFrame.LookVector;
// Direction the camera currently views the car from. Smoothing this (rather
// than the camera position) keeps the follow swing soft while the distance to
// the car stays exactly baseDistance — a position lerp lags a moving target by
// ~speed/stiffness studs, which reads as zooming out at speed.
let smoothedViewHeading = lastFlatHeading;

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
		// Start directly behind the car so entry doesn't swing from a stale angle.
		const entryLook = chassis.CFrame.LookVector;
		const entryFlat = new Vector3(entryLook.X, 0, entryLook.Z);
		if (entryFlat.Magnitude > 0.05) smoothedViewHeading = entryFlat.Unit;
	}

	const cf = chassis.CFrame;
	const carPos = cf.Position;

	// Flatten the car's heading so the camera stays level over bumps, ramps
	// and jumps instead of pitching/rolling with the chassis.
	const look = cf.LookVector;
	const flat = new Vector3(look.X, 0, look.Z);
	const heading = flat.Magnitude > 0.05 ? flat.Unit : lastFlatHeading;
	lastFlatHeading = heading;

	// Looking back mirrors the whole rig through the car: camera out front,
	// aimed behind — same distances, so releasing C swings straight home.
	const lookBack = isLookBackHeld();
	const targetHeading = lookBack ? heading.mul(-1) : heading;

	// Framerate-independent smoothing of the view direction so it feels the
	// same at any FPS. The look-back flip doubles the stiffness so the 180°
	// swing reads as a glance (~0.15s) rather than a lazy orbit.
	const alpha = 1 - math.exp(-followStiffness * (lookBack ? 2 : 1) * dt);
	let blended = smoothedViewHeading.Lerp(targetHeading, alpha);
	blended = new Vector3(blended.X, 0, blended.Z);
	// Opposite headings (the look-back flip) can lerp through zero; snap past.
	smoothedViewHeading = blended.Magnitude > 0.05 ? blended.Unit : targetHeading;

	const camPos = carPos.sub(smoothedViewHeading.mul(baseDistance)).add(new Vector3(0, baseHeight, 0));
	const lookAt = carPos.add(smoothedViewHeading.mul(lookAhead)).add(new Vector3(0, lookHeight, 0));

	// Occlusion: the ring spawn sits close to the canyon wall, so the full
	// follow distance can put the camera inside rock. Cast from just above the
	// car to the wanted position and pull in to the first collidable hit.
	const character = localPlayer.Character;
	occlusionParams.FilterDescendantsInstances = character ? [car, character] : [car];
	const anchor = carPos.add(new Vector3(0, lookHeight, 0));
	const hit = Workspace.Raycast(anchor, camPos.sub(anchor), occlusionParams);
	const finalCamPos = hit ? hit.Position.add(hit.Normal.mul(0.5)) : camPos;
	const baseCamera = CFrame.lookAt(finalCamPos, lookAt);
	const impact = stepCameraImpact(dt, baseCamera);
	camera.CFrame = CFrame.lookAt(finalCamPos.add(impact.worldOffset), lookAt).mul(impact.rotation);

	camera.FieldOfView = baseFov + impact.fov;
});
