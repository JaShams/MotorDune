import { Players, ReplicatedStorage, RunService, UserInputService, Workspace } from "@rbxts/services";
import { CAR_NAME, CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import {
	decodeSlot,
	KNOCK_REMOTE,
	MAX_SLOTS,
	PICKUPS_FOLDER,
	POWERUP_INFO,
	REMOTES_FOLDER,
	SLOT_ATTRS,
	USE_REMOTE,
} from "shared/powerupConfig";

const localPlayer = Players.LocalPlayer;
const car = Workspace.WaitForChild(CAR_NAME) as Model;
const chassis = car.WaitForChild(CHASSIS_NAME) as BasePart;
const seat = car.WaitForChild(SEAT_NAME) as VehicleSeat;

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
// HUD: Blur-style 3 slots along the bottom of the screen.
// ---------------------------------------------------------------------------
const gui = new Instance("ScreenGui");
gui.Name = "PowerupHud";
gui.ResetOnSpawn = false;
gui.IgnoreGuiInset = true;
gui.Parent = localPlayer.WaitForChild("PlayerGui");

const bar = new Instance("Frame");
bar.AnchorPoint = new Vector2(0.5, 1);
bar.Position = UDim2.fromScale(0.5, 0.96);
bar.Size = UDim2.fromOffset(3 * 86 + 2 * 10, 96);
bar.BackgroundTransparency = 1;
bar.Parent = gui;

const layout = new Instance("UIListLayout");
layout.FillDirection = Enum.FillDirection.Horizontal;
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center;
layout.VerticalAlignment = Enum.VerticalAlignment.Bottom;
layout.Padding = new UDim(0, 10);
layout.Parent = bar;

const hint = new Instance("TextLabel");
hint.AnchorPoint = new Vector2(0.5, 1);
hint.Position = UDim2.fromScale(0.5, 1);
hint.Size = UDim2.fromOffset(420, 18);
hint.BackgroundTransparency = 1;
hint.Font = Enum.Font.Gotham;
hint.TextSize = 13;
hint.TextColor3 = new Color3(1, 1, 1);
hint.TextTransparency = 0.35;
hint.Text = "1 / 2 / 3 to fire — Ctrl fires behind — hold C to look back";
hint.Parent = gui;

interface SlotUi {
	frame: Frame;
	stroke: UIStroke;
	icon: TextLabel;
	name: TextLabel;
	charges: TextLabel;
}

const slotUis = new Array<SlotUi>();

for (let i = 0; i < MAX_SLOTS; i++) {
	const frame = new Instance("Frame");
	frame.Size = UDim2.fromOffset(86, 78);
	frame.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
	frame.BackgroundTransparency = 0.35;
	frame.LayoutOrder = i;
	frame.Parent = bar;

	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, 10);
	corner.Parent = frame;

	const stroke = new Instance("UIStroke");
	stroke.Thickness = 2;
	stroke.Color = Color3.fromRGB(70, 80, 100);
	stroke.Transparency = 0.4;
	stroke.Parent = frame;

	const key = new Instance("TextLabel");
	key.BackgroundTransparency = 1;
	key.Position = UDim2.fromOffset(6, 2);
	key.Size = UDim2.fromOffset(16, 16);
	key.Font = Enum.Font.GothamBold;
	key.TextSize = 13;
	key.TextColor3 = Color3.fromRGB(160, 170, 190);
	key.Text = tostring(i + 1);
	key.Parent = frame;

	const icon = new Instance("TextLabel");
	icon.BackgroundTransparency = 1;
	icon.AnchorPoint = new Vector2(0.5, 0);
	icon.Position = new UDim2(0.5, 0, 0, 8);
	icon.Size = UDim2.fromOffset(40, 40);
	icon.Font = Enum.Font.GothamBold;
	icon.TextScaled = true;
	icon.Text = "";
	icon.Parent = frame;

	const name = new Instance("TextLabel");
	name.BackgroundTransparency = 1;
	name.AnchorPoint = new Vector2(0.5, 1);
	name.Position = new UDim2(0.5, 0, 1, -6);
	name.Size = UDim2.fromOffset(80, 14);
	name.Font = Enum.Font.GothamBold;
	name.TextSize = 12;
	name.TextColor3 = new Color3(1, 1, 1);
	name.Text = "";
	name.Parent = frame;

	const charges = new Instance("TextLabel");
	charges.BackgroundTransparency = 1;
	charges.AnchorPoint = new Vector2(1, 0);
	charges.Position = new UDim2(1, -6, 0, 2);
	charges.Size = UDim2.fromOffset(20, 16);
	charges.Font = Enum.Font.GothamBold;
	charges.TextSize = 14;
	charges.TextColor3 = Color3.fromRGB(255, 220, 60);
	charges.Text = "";
	charges.Parent = frame;

	slotUis.push({ frame, stroke, icon, name, charges });
}

function refreshSlot(index: number) {
	const ui = slotUis[index];
	const value = (car.GetAttribute(SLOT_ATTRS[index]) as string | undefined) ?? "";
	const slot = decodeSlot(value);

	if (!slot) {
		ui.icon.Text = "";
		ui.name.Text = "";
		ui.charges.Text = "";
		ui.stroke.Color = Color3.fromRGB(70, 80, 100);
		ui.frame.BackgroundTransparency = 0.55;
		return;
	}

	const info = POWERUP_INFO[slot.kind];
	ui.icon.Text = info.emoji;
	ui.name.Text = info.label;
	ui.charges.Text = slot.charges !== undefined ? `x${slot.charges}` : "";
	ui.stroke.Color = info.color;
	ui.frame.BackgroundTransparency = 0.2;
}

for (let i = 0; i < MAX_SLOTS; i++) {
	refreshSlot(i);
	car.GetAttributeChangedSignal(SLOT_ATTRS[i]).Connect(() => refreshSlot(i));
}

// ---------------------------------------------------------------------------
// Pickup gems spin and bob locally (the server leaves them static so idle
// pads cost no replication).
// ---------------------------------------------------------------------------
const pickupsFolder = Workspace.WaitForChild(PICKUPS_FOLDER);
const baseCFrames = new Map<BasePart, CFrame>();

RunService.Heartbeat.Connect(() => {
	const t = os.clock();
	for (const model of pickupsFolder.GetChildren()) {
		const core = model.FindFirstChild("Core");
		if (!core?.IsA("BasePart")) continue;

		let base = baseCFrames.get(core);
		if (base === undefined) {
			base = core.CFrame;
			baseCFrames.set(core, base);
		}

		if (core.Transparency > 0.9) continue; // collected, waiting to respawn
		const bob = math.sin(t * 2.2 + base.Position.X * 0.1) * 0.6;
		core.CFrame = base.mul(new CFrame(0, bob, 0)).mul(CFrame.Angles(0, t * 1.8, 0));
	}
});

pickupsFolder.ChildRemoved.Connect((child) => {
	const core = child.FindFirstChild("Core");
	if (core?.IsA("BasePart")) baseCFrames.delete(core);
});

// Fade the HUD when not driving.
seat.GetPropertyChangedSignal("Occupant").Connect(() => {
	bar.Visible = isDriving();
	hint.Visible = isDriving();
});
bar.Visible = isDriving();
hint.Visible = isDriving();
