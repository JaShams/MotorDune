import { Players, ReplicatedStorage, RunService, TweenService, UserInputService, Workspace } from "@rbxts/services";
import {
	decodeSlot,
	KNOCK_REMOTE,
	MAX_SLOTS,
	PAD_RESPAWN_SECONDS,
	PICKUPS_FOLDER,
	POWERUP_INFO,
	REMOTES_FOLDER,
	SLOT_ATTRS,
	USE_REMOTE,
} from "shared/powerupConfig";
import { waitForLocalCar } from "./localCar";

const localPlayer = Players.LocalPlayer;
const { car, chassis, seat } = waitForLocalCar();

const remotes = ReplicatedStorage.WaitForChild(REMOTES_FOLDER);
const useRemote = remotes.WaitForChild(USE_REMOTE) as RemoteEvent;
const knockRemote = remotes.WaitForChild(KNOCK_REMOTE) as RemoteEvent;

// ---------------------------------------------------------------------------
// Knockback. The driver network-owns the chassis, so the server routes hits
// here and we apply the impulse locally where it actually simulates.
// ---------------------------------------------------------------------------
knockRemote.OnClientEvent.Connect((chassisArg, deltaVArg, angularArg) => {
	const target = chassisArg as BasePart;
	const deltaV = deltaVArg as Vector3;
	const angularDeltaV = angularArg as Vector3;
	if (!target.IsDescendantOf(game)) return;

	target.ApplyImpulse(deltaV.mul(target.AssemblyMass));
	if (angularDeltaV.Magnitude > 0) {
		target.ApplyAngularImpulse(angularDeltaV.mul(target.AssemblyMass));
	}
});

// ---------------------------------------------------------------------------
// Firing input. 1/2/3 fires that slot forward; hold LeftControl to fire
// bolt/shunt/mine backwards instead.
// ---------------------------------------------------------------------------
const SLOT_KEYS: ReadonlyArray<Enum.KeyCode> = [Enum.KeyCode.One, Enum.KeyCode.Two, Enum.KeyCode.Three];

function isDriving() {
	const humanoid = localPlayer.Character?.FindFirstChildOfClass("Humanoid");
	return humanoid !== undefined && seat.Occupant === humanoid;
}

UserInputService.InputBegan.Connect((input, gameProcessed) => {
	if (gameProcessed) return;
	if (!isDriving()) return;

	for (let i = 0; i < MAX_SLOTS; i++) {
		if (input.KeyCode === SLOT_KEYS[i]) {
			const backward =
				UserInputService.IsKeyDown(Enum.KeyCode.LeftControl) ||
				UserInputService.IsKeyDown(Enum.KeyCode.RightControl);
			useRemote.FireServer(i + 1, backward);
		}
	}
});

// ---------------------------------------------------------------------------
// HUD: a compact desert-tech weapon rack. It deliberately uses native UI
// geometry instead of uploaded images so the silhouettes stay crisp at every
// resolution and the game still works in a fresh place.
// ---------------------------------------------------------------------------
const gui = new Instance("ScreenGui");
gui.Name = "PowerupHud";
gui.ResetOnSpawn = false;
gui.IgnoreGuiInset = true;
gui.Parent = localPlayer.WaitForChild("PlayerGui");

const bar = new Instance("Frame");
bar.AnchorPoint = new Vector2(0.5, 1);
bar.Position = UDim2.fromScale(0.5, 0.96);
bar.Size = UDim2.fromOffset(292, 92);
bar.BackgroundTransparency = 1;
bar.Parent = gui;

const layout = new Instance("UIListLayout");
layout.FillDirection = Enum.FillDirection.Horizontal;
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
layout.VerticalAlignment = Enum.VerticalAlignment.Bottom;
layout.Padding = new UDim(0, 8);
layout.Parent = bar;

const hint = new Instance("TextLabel");
hint.AnchorPoint = new Vector2(0.5, 1);
hint.Position = new UDim2(0.5, 0, 0.96, 22);
hint.Size = UDim2.fromOffset(170, 22);
hint.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
hint.BackgroundTransparency = 0.32;
hint.Font = Enum.Font.GothamBold;
hint.TextSize = 11;
hint.TextColor3 = Color3.fromRGB(180, 190, 205);
hint.Text = "CTRL   ◀  REAR FIRE";
hint.Visible = false;
hint.Parent = gui;

const hintCorner = new Instance("UICorner");
hintCorner.CornerRadius = new UDim(0, 4);
hintCorner.Parent = hint;

interface SlotUi {
	frame: Frame;
	stroke: UIStroke;
	icon: TextLabel;
	name: TextLabel;
	accent: Frame;
	pips: ReadonlyArray<Frame>;
	direction: TextLabel;
	baseSize: UDim2;
}

const slotUis = new Array<SlotUi>();

for (let i = 0; i < MAX_SLOTS; i++) {
	const isPrimary = i === 1;
	const baseSize = UDim2.fromOffset(isPrimary ? 98 : 82, isPrimary ? 88 : 76);
	const frame = new Instance("Frame");
	frame.Size = baseSize;
	frame.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
	frame.BackgroundTransparency = 0.22;
	frame.BorderSizePixel = 0;
	frame.LayoutOrder = i;
	frame.Parent = bar;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, 5);
	corner.Parent = frame;

	const shade = new Instance("UIGradient");
	shade.Rotation = 90;
	shade.Color = new ColorSequence(Color3.fromRGB(30, 34, 45), Color3.fromRGB(8, 10, 16));
	shade.Parent = frame;

	const stroke = new Instance("UIStroke");
	stroke.Thickness = isPrimary ? 2.5 : 2;
	stroke.Color = Color3.fromRGB(70, 80, 100);
	stroke.Transparency = 0.28;
	stroke.Parent = frame;

	const accent = new Instance("Frame");
	accent.AnchorPoint = new Vector2(0.5, 1);
	accent.Position = UDim2.fromScale(0.5, 1);
	accent.Size = new UDim2(1, -8, 0, 4);
	accent.BackgroundColor3 = Color3.fromRGB(70, 80, 100);
	accent.BackgroundTransparency = 0.2;
	accent.BorderSizePixel = 0;
	accent.Parent = frame;

	const accentCorner = new Instance("UICorner");
	accentCorner.CornerRadius = new UDim(0, 2);
	accentCorner.Parent = accent;

	const key = new Instance("TextLabel");
	key.Position = UDim2.fromOffset(-4, -5);
	key.Size = UDim2.fromOffset(23, 23);
	key.BackgroundColor3 = Color3.fromRGB(34, 39, 51);
	key.BackgroundTransparency = 0.05;
	key.Font = Enum.Font.GothamBold;
	key.TextSize = 12;
	key.TextColor3 = Color3.fromRGB(225, 230, 240);
	key.Text = tostring(i + 1);
	key.ZIndex = 4;
	key.Parent = frame;

	const keyCorner = new Instance("UICorner");
	keyCorner.CornerRadius = new UDim(0, 4);
	keyCorner.Parent = key;

	const keyStroke = new Instance("UIStroke");
	keyStroke.Color = Color3.fromRGB(95, 105, 125);
	keyStroke.Thickness = 1;
	keyStroke.Parent = key;

	const icon = new Instance("TextLabel");
	icon.BackgroundTransparency = 1;
	icon.AnchorPoint = new Vector2(0.5, 0);
	icon.Position = new UDim2(0.5, 0, 0, isPrimary ? 7 : 5);
	icon.Size = UDim2.fromOffset(isPrimary ? 48 : 40, isPrimary ? 48 : 40);
	icon.Font = Enum.Font.GothamBold;
	icon.TextSize = isPrimary ? 40 : 33;
	icon.Text = "";
	icon.TextStrokeTransparency = 0.65;
	icon.Parent = frame;

	const name = new Instance("TextLabel");
	name.BackgroundTransparency = 1;
	name.AnchorPoint = new Vector2(0.5, 1);
	name.Position = new UDim2(0.5, 0, 1, -9);
	name.Size = UDim2.fromOffset(76, 16);
	name.Font = Enum.Font.GothamBold;
	name.TextSize = isPrimary ? 12 : 11;
	name.TextColor3 = new Color3(1, 1, 1);
	name.Text = "";
	name.Parent = frame;

	const pipRack = new Instance("Frame");
	pipRack.AnchorPoint = new Vector2(1, 0);
	pipRack.Position = new UDim2(1, -5, 0, 5);
	pipRack.Size = UDim2.fromOffset(29, 7);
	pipRack.BackgroundTransparency = 1;
	pipRack.Parent = frame;
	const pipLayout = new Instance("UIListLayout");
	pipLayout.FillDirection = Enum.FillDirection.Horizontal;
	pipLayout.HorizontalAlignment = Enum.HorizontalAlignment.Right;
	pipLayout.Padding = new UDim(0, 3);
	pipLayout.Parent = pipRack;
	const pips = new Array<Frame>();
	for (let charge = 0; charge < 3; charge++) {
		const pip = new Instance("Frame");
		pip.Size = UDim2.fromOffset(7, 7);
		pip.BackgroundColor3 = Color3.fromRGB(255, 220, 60);
		pip.BorderSizePixel = 0;
		pip.Visible = false;
		pip.Parent = pipRack;
		const pipCorner = new Instance("UICorner");
		pipCorner.CornerRadius = new UDim(1, 0);
		pipCorner.Parent = pip;
		pips.push(pip);
	}

	const direction = new Instance("TextLabel");
	direction.AnchorPoint = new Vector2(1, 0.5);
	direction.Position = new UDim2(1, -5, 0.5, 0);
	direction.Size = UDim2.fromOffset(16, 28);
	direction.BackgroundTransparency = 1;
	direction.Font = Enum.Font.GothamBold;
	direction.TextSize = 14;
	direction.TextColor3 = Color3.fromRGB(150, 160, 180);
	direction.Text = "↕";
	direction.Visible = false;
	direction.Parent = frame;

	slotUis.push({ frame, stroke, icon, name, accent, pips, direction, baseSize });
}

function refreshSlot(index: number, animate = false) {
	const ui = slotUis[index];
	const value = (car.GetAttribute(SLOT_ATTRS[index]) as string | undefined) ?? "";
	const slot = decodeSlot(value);

	if (!slot) {
		ui.icon.Text = "+";
		ui.icon.TextColor3 = Color3.fromRGB(75, 84, 102);
		ui.name.Text = "EMPTY";
		ui.name.TextColor3 = Color3.fromRGB(95, 105, 125);
		for (const pip of ui.pips) pip.Visible = false;
		ui.direction.Visible = false;
		ui.stroke.Color = Color3.fromRGB(70, 80, 100);
		ui.stroke.Transparency = 0.62;
		ui.accent.BackgroundColor3 = Color3.fromRGB(70, 80, 100);
		ui.accent.BackgroundTransparency = 0.72;
		ui.frame.BackgroundTransparency = 0.5;
		return;
	}

	const info = POWERUP_INFO[slot.kind];
	ui.icon.Text = info.glyph;
	ui.icon.TextColor3 = info.color;
	ui.name.Text = string.upper(info.label);
	ui.name.TextColor3 = new Color3(1, 1, 1);
	for (let charge = 0; charge < ui.pips.size(); charge++) {
		ui.pips[charge].Visible = slot.charges !== undefined;
		ui.pips[charge].BackgroundColor3 = info.color;
		ui.pips[charge].BackgroundTransparency = charge < (slot.charges ?? 0) ? 0 : 0.8;
	}
	ui.direction.Visible = info.directional;
	ui.stroke.Color = info.color;
	ui.stroke.Transparency = 0.08;
	ui.accent.BackgroundColor3 = info.color;
	ui.accent.BackgroundTransparency = 0;
	ui.frame.BackgroundTransparency = 0.15;

	if (animate) {
		ui.frame.Size = new UDim2(ui.baseSize.X.Scale, ui.baseSize.X.Offset - 10, ui.baseSize.Y.Scale, ui.baseSize.Y.Offset - 10);
		ui.icon.TextTransparency = 1;
		TweenService.Create(ui.frame, new TweenInfo(0.22, Enum.EasingStyle.Back, Enum.EasingDirection.Out), {
			Size: ui.baseSize,
		}).Play();
		TweenService.Create(ui.icon, new TweenInfo(0.12), { TextTransparency: 0 }).Play();
	}
}

for (let i = 0; i < MAX_SLOTS; i++) {
	refreshSlot(i);
	let previous = (car.GetAttribute(SLOT_ATTRS[i]) as string | undefined) ?? "";
	car.GetAttributeChangedSignal(SLOT_ATTRS[i]).Connect(() => {
		const nextValue = (car.GetAttribute(SLOT_ATTRS[i]) as string | undefined) ?? "";
		const acquired = previous === "" && nextValue !== "";
		refreshSlot(i, acquired);
		if (!acquired && previous !== nextValue) {
			const ui = slotUis[i];
			TweenService.Create(ui.frame, new TweenInfo(0.06), {
				Size: new UDim2(ui.baseSize.X.Scale, ui.baseSize.X.Offset - 6, ui.baseSize.Y.Scale, ui.baseSize.Y.Offset - 6),
			}).Play();
			task.delay(0.065, () =>
				TweenService.Create(ui.frame, new TweenInfo(0.14, Enum.EasingStyle.Back, Enum.EasingDirection.Out), {
					Size: ui.baseSize,
				}).Play(),
			);
		}
		previous = nextValue;
	});
}

// Directional affordances only appear when relevant. Holding Ctrl turns the
// subdued rear arrow into an amber confirmation before the player fires.
RunService.RenderStepped.Connect(() => {
	const rearHeld =
		UserInputService.IsKeyDown(Enum.KeyCode.LeftControl) || UserInputService.IsKeyDown(Enum.KeyCode.RightControl);
	let hasDirectional = false;
	for (let i = 0; i < MAX_SLOTS; i++) {
		const slot = decodeSlot((car.GetAttribute(SLOT_ATTRS[i]) as string | undefined) ?? "");
		const directional = slot !== undefined && POWERUP_INFO[slot.kind].directional;
		slotUis[i].direction.Visible = directional;
		if (directional) {
			hasDirectional = true;
			slotUis[i].direction.Text = rearHeld ? "◀" : "↕";
			slotUis[i].direction.TextColor3 = rearHeld
				? Color3.fromRGB(255, 175, 55)
				: Color3.fromRGB(150, 160, 180);
		}
	}
	hint.Visible = isDriving() && hasDirectional;
	hint.TextColor3 = rearHeld ? Color3.fromRGB(255, 175, 55) : Color3.fromRGB(180, 190, 205);
});

// ---------------------------------------------------------------------------
// Pickup cells animate locally (the server leaves every piece anchored and
// static, so even the orbit cages cost no transform replication). Ground
// segments become a local respawn clock while the floating cell is absent.
// ---------------------------------------------------------------------------
const pickupsFolder = Workspace.WaitForChild(PICKUPS_FOLDER);
const baseCFrames = new Map<BasePart, CFrame>();

RunService.Heartbeat.Connect(() => {
	const t = os.clock();
	for (const model of pickupsFolder.GetChildren()) {
		const core = model.FindFirstChild("Core");
		if (!core?.IsA("BasePart")) continue;

		for (const descendant of model.GetChildren()) {
			if (descendant.IsA("BasePart") && !baseCFrames.has(descendant)) baseCFrames.set(descendant, descendant.CFrame);
		}

		const coreBase = baseCFrames.get(core);
		if (coreBase === undefined) continue;
		const phase = coreBase.Position.X * 0.1 + coreBase.Position.Z * 0.04;
		const bob = math.sin(t * 2.2 + phase) * 0.55;
		const active = model.GetAttribute("Active") === true;

		if (active) {
			core.CFrame = new CFrame(0, bob, 0).mul(coreBase).mul(CFrame.Angles(0, t * 1.35, 0));
			const pulse = (math.sin(t * 3.5 + phase) + 1) / 2;
			const light = core.FindFirstChildOfClass("PointLight");
			if (light) light.Brightness = 1.7 + pulse * 1.3;

			for (const piece of model.GetChildren()) {
				if (!piece.IsA("BasePart")) continue;
				const base = baseCFrames.get(piece);
				if (base === undefined) continue;
				if (piece.Name === "RingA") {
					const pivot = new CFrame(coreBase.Position);
					piece.CFrame = new CFrame(0, bob, 0)
						.mul(pivot)
						.mul(CFrame.Angles(0, t * 0.75, 0))
						.mul(pivot.Inverse())
						.mul(base);
				} else if (piece.Name === "RingB") {
					const pivot = new CFrame(coreBase.Position);
					piece.CFrame = new CFrame(0, bob, 0)
						.mul(pivot)
						.mul(CFrame.Angles(0, 0, -t * 0.95))
						.mul(pivot.Inverse())
						.mul(base);
				} else if (piece.Name === "Beacon") {
					piece.Transparency = 0.58 + pulse * 0.22;
				}
			}
		} else {
			const respawnAt = (model.GetAttribute("RespawnAt") as number | undefined) ?? 0;
			const progress = math.clamp(1 - (respawnAt - Workspace.GetServerTimeNow()) / PAD_RESPAWN_SECONDS, 0, 1);
			for (const piece of model.GetChildren()) {
				if (!piece.IsA("BasePart") || piece.Name !== "GroundSegment") continue;
				const segmentIndex = (piece.GetAttribute("SegmentIndex") as number | undefined) ?? 0;
				piece.Transparency = segmentIndex / 12 <= progress ? 0.42 : 0.88;
			}
		}
	}
});

pickupsFolder.ChildRemoved.Connect((child) => {
	for (const descendant of child.GetDescendants()) {
		if (descendant.IsA("BasePart")) baseCFrames.delete(descendant);
	}
});

// Fade the HUD when not driving.
seat.GetPropertyChangedSignal("Occupant").Connect(() => {
	bar.Visible = isDriving();
	if (!isDriving()) hint.Visible = false;
});
bar.Visible = isDriving();
hint.Visible = false;
