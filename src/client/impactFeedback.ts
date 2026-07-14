import { HapticService, Players, ReplicatedStorage, RunService, SoundService, UserInputService } from "@rbxts/services";
import {
	FEEDBACK_REMOTE,
	POWERUP_INFO,
	PowerupFeedback,
	POWERUP_SOUND_IDS,
	PowerupType,
	REMOTES_FOLDER,
} from "shared/powerupConfig";

// Impact feedback is local presentation. The server supplies the authoritative
// kind, damage and exact delta-v; this module turns that into weight without
// delaying physics or taking steering away from the driver.
const localPlayer = Players.LocalPlayer;
const feedbackRemote = ReplicatedStorage.WaitForChild(REMOTES_FOLDER).WaitForChild(FEEDBACK_REMOTE) as RemoteEvent;

let cameraOffset = Vector3.zero;
let cameraVelocity = Vector3.zero;
let cameraDirection = Vector3.zAxis;
let rotationKick = 0;
let fovKick = 0;
let kickPhase = 0;

function clamped(vector: Vector3, maximum: number) {
	return vector.Magnitude > maximum ? vector.Unit.mul(maximum) : vector;
}

function impactScale(kind: PowerupType) {
	switch (kind) {
		case "bolt":
			return { rotation: 3, fov: 4, rumble: 0.42 };
		case "barge":
			return { rotation: 6, fov: 7, rumble: 0.7 };
		case "mine":
			return { rotation: 7, fov: 8, rumble: 0.82 };
		case "shunt":
			return { rotation: 8, fov: 10, rumble: 1 };
		default:
			return { rotation: 4, fov: 5, rumble: 0.5 };
	}
}

function pushCameraImpact(kind: PowerupType, deltaV: Vector3, wrecked: boolean) {
	const scale = impactScale(kind);
	// The chassis changes velocity instantly, but the eye lags in the opposite
	// direction and springs home. This is isolated from ordinary chase-camera
	// following, which must remain exact to avoid speed-dependent zoom-out.
	cameraOffset = clamped(cameraOffset.sub(deltaV.mul(0.035)), 2.5);
	cameraDirection = deltaV.Magnitude > 0.1 ? deltaV.Unit : Vector3.zAxis;
	rotationKick = math.max(rotationKick, math.rad(scale.rotation + (wrecked ? 3 : 0)));
	fovKick = math.max(fovKick, scale.fov + (wrecked ? 3 : 0));
	kickPhase = 0;
}

export function stepCameraImpact(dt: number, cameraCFrame: CFrame) {
	const step = math.min(dt, 1 / 30);
	const acceleration = cameraOffset.mul(-72).add(cameraVelocity.mul(-17));
	cameraVelocity = cameraVelocity.add(acceleration.mul(step));
	cameraOffset = cameraOffset.add(cameraVelocity.mul(step));
	if (cameraOffset.Magnitude < 0.002 && cameraVelocity.Magnitude < 0.01) {
		cameraOffset = Vector3.zero;
		cameraVelocity = Vector3.zero;
	}

	kickPhase += step * 34;
	rotationKick *= math.exp(-7.5 * step);
	fovKick *= math.exp(-6 * step);
	const localDirection = cameraCFrame.VectorToObjectSpace(cameraDirection);
	const wave = math.sin(kickPhase) * rotationKick;
	const rotation = CFrame.Angles(
		-localDirection.Y * wave + math.sin(kickPhase * 0.73) * rotationKick * 0.22,
		-localDirection.X * wave,
		-localDirection.X * wave * 0.7,
	);
	return { worldOffset: cameraOffset, rotation, fov: fovKick };
}

function playLocalSound(soundId: string, volume: number, playbackSpeed = 1, duration = 5) {
	const sound = new Instance("Sound");
	sound.SoundId = soundId;
	sound.Volume = volume;
	sound.PlaybackSpeed = playbackSpeed;
	sound.Parent = SoundService;
	sound.Play();
	task.delay(duration, () => sound.Destroy());
}

const gui = new Instance("ScreenGui");
gui.Name = "ImpactFeedback";
gui.ResetOnSpawn = false;
gui.IgnoreGuiInset = true;
gui.DisplayOrder = 30;
gui.Parent = localPlayer.WaitForChild("PlayerGui");

const flash = new Instance("Frame");
flash.Size = UDim2.fromScale(1, 1);
flash.BackgroundTransparency = 1;
flash.BorderSizePixel = 0;
flash.Parent = gui;

const marker = new Instance("TextLabel");
marker.AnchorPoint = new Vector2(0.5, 0.5);
marker.Position = UDim2.fromScale(0.5, 0.43);
marker.Size = UDim2.fromOffset(220, 58);
marker.BackgroundTransparency = 1;
marker.Font = Enum.Font.GothamBold;
marker.TextSize = 21;
marker.TextStrokeColor3 = Color3.fromRGB(8, 10, 16);
marker.TextStrokeTransparency = 0.25;
marker.TextTransparency = 1;
marker.Parent = gui;

let flashStrength = 0;
let markerStrength = 0;
let flashHoldUntil = 0;
let markerHoldUntil = 0;
let rumbleToken = 0;

function rumble(strength: number, duration: number) {
	if (!UserInputService.GamepadEnabled) return;
	rumbleToken++;
	const token = rumbleToken;
	pcall(() => {
		HapticService.SetMotor(Enum.UserInputType.Gamepad1, Enum.VibrationMotor.Large, strength);
		HapticService.SetMotor(Enum.UserInputType.Gamepad1, Enum.VibrationMotor.Small, math.min(1, strength * 1.15));
	});
	task.delay(duration, () => {
		if (token !== rumbleToken) return;
		pcall(() => {
			HapticService.SetMotor(Enum.UserInputType.Gamepad1, Enum.VibrationMotor.Large, 0);
			HapticService.SetMotor(Enum.UserInputType.Gamepad1, Enum.VibrationMotor.Small, 0);
		});
	});
}

feedbackRemote.OnClientEvent.Connect((rawFeedback) => {
	const feedback = rawFeedback as PowerupFeedback;
	const color = POWERUP_INFO[feedback.kind].color;

	if (feedback.type === "hitConfirm") {
		marker.Text = feedback.wrecked ? `✦ WRECKED  +${feedback.damage}` : `✦ HIT  +${feedback.damage}`;
		marker.TextColor3 = color;
		markerStrength = 1;
		markerHoldUntil = os.clock() + 0.18;
		marker.TextTransparency = 0;
		marker.TextStrokeTransparency = 0.25;
		playLocalSound(POWERUP_SOUND_IDS.uiConfirm, 0.24, 1.15, 0.7);
		return;
	}

	if (feedback.type === "shieldBlock") {
		marker.Text = feedback.role === "victim" ? "⬡ SHIELD HELD" : "⬡ BLOCKED";
		marker.TextColor3 = POWERUP_INFO.shield.color;
		markerStrength = 1;
		markerHoldUntil = os.clock() + 0.18;
		marker.TextTransparency = 0;
		marker.TextStrokeTransparency = 0.25;
		flash.BackgroundColor3 = POWERUP_INFO.shield.color;
		flashStrength = math.max(flashStrength, feedback.role === "victim" ? 0.16 : 0.08);
		flashHoldUntil = os.clock() + 0.06;
		flash.BackgroundTransparency = 1 - flashStrength;
		playLocalSound(POWERUP_SOUND_IDS.shieldLoop, 0.3, feedback.role === "victim" ? 1.18 : 1.3, 0.75);
		if (feedback.role === "victim") rumble(0.25, 0.14);
		return;
	}

	if (feedback.role !== "victim") return;
	pushCameraImpact(feedback.kind, feedback.deltaV, feedback.wrecked);
	flash.BackgroundColor3 = color;
	flashStrength = math.max(flashStrength, feedback.wrecked ? 0.28 : 0.22);
	flashHoldUntil = os.clock() + 0.06;
	flash.BackgroundTransparency = 1 - flashStrength;
	playLocalSound(POWERUP_SOUND_IDS.debrisImpact, feedback.wrecked ? 0.72 : 0.52, math.random(84, 100) / 100, 2.4);
	const scale = impactScale(feedback.kind);
	rumble(scale.rumble, feedback.wrecked ? 0.48 : 0.32);
});

RunService.RenderStepped.Connect((dt) => {
	const now = os.clock();
	if (now > flashHoldUntil) flashStrength *= math.exp(-10 * dt);
	if (now > markerHoldUntil) markerStrength *= math.exp(-4.5 * dt);
	flash.BackgroundTransparency = 1 - flashStrength;
	marker.TextTransparency = 1 - markerStrength;
	marker.TextStrokeTransparency = 0.25 + (1 - markerStrength) * 0.75;
});
