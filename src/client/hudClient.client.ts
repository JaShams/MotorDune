import { Players, RunService, TweenService, Workspace } from "@rbxts/services";
import { CAR_NAME, CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import {
	BOT_LABEL_ATTR,
	BOT_POINTS_ATTR,
	HEALTH_ATTR,
	healthColor,
	LEADERSTATS_NAME,
	MAX_HEALTH,
	POINTS_NAME,
} from "shared/healthConfig";
import { FX_FOLDER } from "shared/powerupConfig";

const localPlayer = Players.LocalPlayer;
const car = Workspace.WaitForChild(CAR_NAME) as Model;
const chassis = car.WaitForChild(CHASSIS_NAME) as BasePart;
const seat = car.WaitForChild(SEAT_NAME) as VehicleSeat;

const gui = new Instance("ScreenGui");
gui.Name = "GameHud";
gui.ResetOnSpawn = false;
gui.IgnoreGuiInset = true;
gui.Parent = localPlayer.WaitForChild("PlayerGui");

function isDriving() {
	const humanoid = localPlayer.Character?.FindFirstChildOfClass("Humanoid");
	return humanoid !== undefined && seat.Occupant === humanoid;
}

// ---------------------------------------------------------------------------
// HEALTH BAR — sits just above the powerup slots; reads the Health attribute
// the server keeps on the car model.
// ---------------------------------------------------------------------------
const healthFrame = new Instance("Frame");
healthFrame.AnchorPoint = new Vector2(0.5, 1);
healthFrame.Position = new UDim2(0.5, 0, 0.96, -102);
healthFrame.Size = UDim2.fromOffset(278, 16);
healthFrame.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
healthFrame.BackgroundTransparency = 0.35;
healthFrame.Parent = gui;

const healthCorner = new Instance("UICorner");
healthCorner.CornerRadius = new UDim(0, 8);
healthCorner.Parent = healthFrame;

const healthStroke = new Instance("UIStroke");
healthStroke.Thickness = 2;
healthStroke.Color = Color3.fromRGB(70, 80, 100);
healthStroke.Transparency = 0.4;
healthStroke.Parent = healthFrame;

const healthFill = new Instance("Frame");
healthFill.Position = UDim2.fromOffset(2, 2);
healthFill.Size = new UDim2(1, -4, 1, -4);
healthFill.BackgroundColor3 = Color3.fromRGB(90, 220, 90);
healthFill.BorderSizePixel = 0;
healthFill.Parent = healthFrame;

const fillCorner = new Instance("UICorner");
fillCorner.CornerRadius = new UDim(0, 6);
fillCorner.Parent = healthFill;

const healthText = new Instance("TextLabel");
healthText.BackgroundTransparency = 1;
healthText.Size = UDim2.fromScale(1, 1);
healthText.Font = Enum.Font.GothamBold;
healthText.TextSize = 12;
healthText.TextColor3 = new Color3(1, 1, 1);
healthText.TextStrokeTransparency = 0.6;
healthText.ZIndex = 2;
healthText.Parent = healthFrame;

let lastHealth = MAX_HEALTH;

function refreshHealth() {
	const health = (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? MAX_HEALTH;
	const frac = math.clamp(health / MAX_HEALTH, 0, 1);

	TweenService.Create(healthFill, new TweenInfo(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
		Size: new UDim2(frac, -4, 1, -4),
		BackgroundColor3: healthColor(frac),
	}).Play();
	healthText.Text = health <= 0 ? "WRECKED" : `${math.floor(health)} / ${MAX_HEALTH}`;

	// Flash the outline white when we take a hit.
	if (health < lastHealth) {
		healthStroke.Color = new Color3(1, 1, 1);
		healthStroke.Transparency = 0;
		TweenService.Create(healthStroke, new TweenInfo(0.35), {
			Color: Color3.fromRGB(70, 80, 100),
			Transparency: 0.4,
		}).Play();
	}
	lastHealth = health;
}

refreshHealth();
car.GetAttributeChangedSignal(HEALTH_ATTR).Connect(refreshHealth);

// ---------------------------------------------------------------------------
// POINTS LEADERBOARD — top-right list built from player leaderstats and the
// replicated score attributes on bot cars.
// ---------------------------------------------------------------------------
const board = new Instance("Frame");
board.AnchorPoint = new Vector2(1, 0);
board.Position = new UDim2(1, -12, 0, 12);
board.Size = UDim2.fromOffset(210, 30);
board.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
board.BackgroundTransparency = 0.35;
board.Parent = gui;

const boardCorner = new Instance("UICorner");
boardCorner.CornerRadius = new UDim(0, 10);
boardCorner.Parent = board;

const boardStroke = new Instance("UIStroke");
boardStroke.Thickness = 2;
boardStroke.Color = Color3.fromRGB(70, 80, 100);
boardStroke.Transparency = 0.4;
boardStroke.Parent = board;

const boardTitle = new Instance("TextLabel");
boardTitle.BackgroundTransparency = 1;
boardTitle.Position = UDim2.fromOffset(0, 4);
boardTitle.Size = new UDim2(1, 0, 0, 18);
boardTitle.Font = Enum.Font.GothamBold;
boardTitle.TextSize = 13;
boardTitle.TextColor3 = Color3.fromRGB(255, 220, 60);
boardTitle.Text = "POINTS";
boardTitle.Parent = board;

const rowsFrame = new Instance("Frame");
rowsFrame.BackgroundTransparency = 1;
rowsFrame.Position = UDim2.fromOffset(0, 24);
rowsFrame.Size = new UDim2(1, 0, 1, -24);
rowsFrame.Parent = board;

const rowLayout = new Instance("UIListLayout");
rowLayout.SortOrder = Enum.SortOrder.LayoutOrder;
rowLayout.Padding = new UDim(0, 2);
rowLayout.Parent = rowsFrame;

const ROW_HEIGHT = 20;

function getPoints(player: Player) {
	const points = player.FindFirstChild(LEADERSTATS_NAME)?.FindFirstChild(POINTS_NAME);
	return points?.IsA("IntValue") ? points.Value : 0;
}

interface BoardEntry {
	name: string;
	points: number;
	isMe: boolean;
}

function getBoardEntries() {
	const entries = new Array<BoardEntry>();
	for (const player of Players.GetPlayers()) {
		entries.push({ name: player.DisplayName, points: getPoints(player), isMe: player === localPlayer });
	}
	for (const child of Workspace.GetChildren()) {
		if (!child.IsA("Model") || child.GetAttribute("IsBot") !== true) continue;
		const name = (child.GetAttribute(BOT_LABEL_ATTR) as string | undefined) ?? child.Name;
		const points = (child.GetAttribute(BOT_POINTS_ATTR) as number | undefined) ?? 0;
		entries.push({ name, points, isMe: false });
	}
	entries.sort((a, b) => a.points > b.points);
	return entries;
}

function rebuildBoard() {
	for (const child of rowsFrame.GetChildren()) {
		if (child.IsA("Frame")) child.Destroy();
	}

	const entries = getBoardEntries();

	for (const [index, entry] of ipairs(entries)) {
		const row = new Instance("Frame");
		row.BackgroundTransparency = 1;
		row.Size = new UDim2(1, 0, 0, ROW_HEIGHT);
		row.LayoutOrder = index;
		row.Parent = rowsFrame;

		const isMe = entry.isMe;

		const name = new Instance("TextLabel");
		name.BackgroundTransparency = 1;
		name.Position = UDim2.fromOffset(10, 0);
		name.Size = new UDim2(1, -66, 1, 0);
		name.Font = isMe ? Enum.Font.GothamBold : Enum.Font.Gotham;
		name.TextSize = 13;
		name.TextXAlignment = Enum.TextXAlignment.Left;
		name.TextTruncate = Enum.TextTruncate.AtEnd;
		name.TextColor3 = isMe ? Color3.fromRGB(255, 220, 60) : new Color3(1, 1, 1);
		name.Text = `${index}. ${entry.name}`;
		name.Parent = row;

		const score = new Instance("TextLabel");
		score.BackgroundTransparency = 1;
		score.AnchorPoint = new Vector2(1, 0);
		score.Position = new UDim2(1, -10, 0, 0);
		score.Size = UDim2.fromOffset(50, ROW_HEIGHT);
		score.Font = Enum.Font.GothamBold;
		score.TextSize = 13;
		score.TextXAlignment = Enum.TextXAlignment.Right;
		score.TextColor3 = isMe ? Color3.fromRGB(255, 220, 60) : new Color3(1, 1, 1);
		score.Text = tostring(entry.points);
		score.Parent = row;
	}

	board.Size = UDim2.fromOffset(210, 30 + entries.size() * (ROW_HEIGHT + 2));
}

// Leaderstats replicate a beat after the player does; re-render once the
// Points value shows up, then on every change.
function watchPlayer(player: Player) {
	task.spawn(() => {
		const stats = player.WaitForChild(LEADERSTATS_NAME, 15);
		const points = stats?.WaitForChild(POINTS_NAME, 15);
		if (points?.IsA("IntValue")) points.Changed.Connect(rebuildBoard);
		rebuildBoard();
	});
}

for (const player of Players.GetPlayers()) watchPlayer(player);
Players.PlayerAdded.Connect((player) => {
	watchPlayer(player);
	rebuildBoard();
});
Players.PlayerRemoving.Connect(() => task.defer(rebuildBoard));

function watchBot(car: Model) {
	if (car.GetAttribute("IsBot") !== true) return;
	car.GetAttributeChangedSignal(BOT_POINTS_ATTR).Connect(rebuildBoard);
	car.GetAttributeChangedSignal(BOT_LABEL_ATTR).Connect(rebuildBoard);
	rebuildBoard();
}

for (const child of Workspace.GetChildren()) {
	if (child.IsA("Model")) watchBot(child);
}
Workspace.ChildAdded.Connect((child) => {
	if (child.IsA("Model")) task.defer(() => watchBot(child));
});
Workspace.ChildRemoved.Connect((child) => {
	if (child.IsA("Model") && child.GetAttribute("IsBot") === true) task.defer(rebuildBoard);
});
rebuildBoard();

// ---------------------------------------------------------------------------
// REAR THREAT INDICATOR — a pill above the health bar that lights up when a
// car is tailing you (white) or a projectile is homing in on you (flashing
// orange). Pairs with hold-C look-back in carCamera.
// ---------------------------------------------------------------------------
const CAR_BEHIND_RANGE = 70;
const CAR_BEHIND_DOT = 0.42; // ~65 degree rear cone
const MISSILE_RANGE = 140;
const MISSILE_AIM_DOT = 0.86; // projectile look vector must point at us

const INCOMING_COLOR = Color3.fromRGB(255, 160, 40);
const BEHIND_COLOR = new Color3(1, 1, 1);

const threatPill = new Instance("Frame");
threatPill.AnchorPoint = new Vector2(0.5, 1);
threatPill.Position = new UDim2(0.5, 0, 0.96, -126);
threatPill.Size = UDim2.fromOffset(150, 24);
threatPill.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
threatPill.BackgroundTransparency = 0.25;
threatPill.Visible = false;
threatPill.Parent = gui;

const pillCorner = new Instance("UICorner");
pillCorner.CornerRadius = new UDim(0, 12);
pillCorner.Parent = threatPill;

const pillStroke = new Instance("UIStroke");
pillStroke.Thickness = 2;
pillStroke.Parent = threatPill;

const pillText = new Instance("TextLabel");
pillText.BackgroundTransparency = 1;
pillText.Size = UDim2.fromScale(1, 1);
pillText.Font = Enum.Font.GothamBold;
pillText.TextSize = 13;
pillText.Parent = threatPill;

const fxFolder = Workspace.WaitForChild(FX_FOLDER);

function isProjectileName(name: string) {
	return name === "Shunt" || name === "Bolt";
}

// A projectile counts as incoming when it's close and its flight direction
// (the server keeps projectile CFrames looking along their velocity) points
// at us. Our own shots leave the muzzle facing away, so they never match.
function projectileIncoming(carPos: Vector3) {
	for (const child of fxFolder.GetChildren()) {
		if (!child.IsA("BasePart") || !isProjectileName(child.Name)) continue;
		const toUs = carPos.sub(child.Position);
		const distance = toUs.Magnitude;
		if (distance > MISSILE_RANGE || distance < 1) continue;
		if (toUs.Unit.Dot(child.CFrame.LookVector) > MISSILE_AIM_DOT) return true;
	}
	return false;
}

function carBehind(carPos: Vector3, heading: Vector3) {
	for (const child of Workspace.GetChildren()) {
		if (!child.IsA("Model") || child === car) continue;
		const otherChassis = child.FindFirstChild(CHASSIS_NAME);
		if (!otherChassis?.IsA("BasePart")) continue;
		const offset = otherChassis.Position.sub(carPos);
		const distance = offset.Magnitude;
		if (distance > CAR_BEHIND_RANGE || distance < 1) continue;
		if (offset.Unit.Dot(heading.mul(-1)) > CAR_BEHIND_DOT) return true;
	}
	return false;
}

let lastThreatHeading = chassis.CFrame.LookVector;

RunService.RenderStepped.Connect(() => {
	if (!isDriving()) {
		threatPill.Visible = false;
		return;
	}

	const look = chassis.CFrame.LookVector;
	const flat = new Vector3(look.X, 0, look.Z);
	const heading = flat.Magnitude > 0.05 ? flat.Unit : lastThreatHeading;
	lastThreatHeading = heading;
	const carPos = chassis.Position;

	if (projectileIncoming(carPos)) {
		// Flash so it reads as danger even in peripheral vision.
		const pulse = (math.sin(os.clock() * 12) + 1) / 2;
		threatPill.Visible = true;
		pillText.Text = "🚀 INCOMING — C to look back";
		pillText.TextColor3 = INCOMING_COLOR;
		pillStroke.Color = INCOMING_COLOR;
		pillStroke.Transparency = pulse * 0.7;
		threatPill.Size = UDim2.fromOffset(210, 24);
	} else if (carBehind(carPos, heading)) {
		threatPill.Visible = true;
		pillText.Text = "▼ CAR BEHIND";
		pillText.TextColor3 = BEHIND_COLOR;
		pillStroke.Color = BEHIND_COLOR;
		pillStroke.Transparency = 0.5;
		threatPill.Size = UDim2.fromOffset(150, 24);
	} else {
		threatPill.Visible = false;
	}
});

// ---------------------------------------------------------------------------
// Show the driving HUD only while in the car (the leaderboard stays up).
// ---------------------------------------------------------------------------
function refreshVisibility() {
	const driving = isDriving();
	healthFrame.Visible = driving;
	if (!driving) threatPill.Visible = false;
}

seat.GetPropertyChangedSignal("Occupant").Connect(refreshVisibility);
refreshVisibility();
