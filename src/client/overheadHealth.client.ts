import { Players, RunService, TweenService, Workspace } from "@rbxts/services";
import { CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import { HEALTH_ATTR, healthColor, MAX_HEALTH } from "shared/healthConfig";
import { waitForLocalCar } from "./localCar";

// ---------------------------------------------------------------------------
// OVERHEAD HEALTH BARS
// A billboard bar above every car so everyone can read everyone else's health,
// not just their own HUD. Runs entirely client-side off the replicated Health
// attribute (the server owns it; see healthConfig). The bar over the car you
// are currently driving is hidden - the HUD bar already covers it.
// A name label above the bar shows the driver's DisplayName; bots have no
// occupant so it stays empty and their existing BotTag does the naming.
// ---------------------------------------------------------------------------

const localPlayer = Players.LocalPlayer;

// Bot name tags sit at 4.5 studs (bots.server nameTag); the bar tucks under.
const BAR_STUDS_OFFSET = new Vector3(0, 3.4, 0);
const MAX_DISTANCE = 300; // match the bot name tags

interface TrackerElements {
	billboard: BillboardGui;
	trackerBillboard: BillboardGui;
	arrowLabel: TextLabel;
	rivalLabel?: TextLabel;
}

const activeTrackers = new Map<Model, TrackerElements>();
let localCar: Model | undefined = undefined;
let updateRivalIndicators: (() => void) | undefined = undefined;

function attachHealthBar(car: Model) {
	const chassisChild = car.WaitForChild(CHASSIS_NAME, 10);
	const seatChild = car.WaitForChild(SEAT_NAME, 10);
	if (!chassisChild?.IsA("BasePart") || !seatChild?.IsA("VehicleSeat")) return;
	const chassis = chassisChild;
	const seat = seatChild;
	if (chassis.FindFirstChild("OverheadHealth")) return;

	const billboard = new Instance("BillboardGui");
	billboard.Name = "OverheadHealth";
	billboard.Size = UDim2.fromScale(5.5, 1.4);
	billboard.StudsOffset = BAR_STUDS_OFFSET;
	billboard.AlwaysOnTop = false;
	billboard.MaxDistance = MAX_DISTANCE;
	billboard.Parent = chassis;

	const trackerBillboard = new Instance("BillboardGui");
	trackerBillboard.Name = "TrackerIndicator";
	trackerBillboard.Size = UDim2.fromOffset(24, 24);
	trackerBillboard.StudsOffset = new Vector3(0, 4.8, 0); // Position it cleanly above the health bar
	trackerBillboard.AlwaysOnTop = true; // Stay visible behind walls/obstacles
	trackerBillboard.MaxDistance = 500; // Visible across the map
	trackerBillboard.Parent = chassis;

	const arrowLabel = new Instance("TextLabel");
	arrowLabel.Size = UDim2.fromScale(1, 1);
	arrowLabel.BackgroundTransparency = 1;
	arrowLabel.Font = Enum.Font.GothamBold;
	arrowLabel.Text = "▼";
	arrowLabel.TextScaled = true;
	arrowLabel.TextColor3 = chassis.Color; // Match respective bot or player skin color
	arrowLabel.TextTransparency = 0.25; // Semi-transparent
	arrowLabel.TextStrokeTransparency = 0.4;
	arrowLabel.TextStrokeColor3 = Color3.fromRGB(0, 0, 0);
	arrowLabel.Parent = trackerBillboard;

	const driverName = new Instance("TextLabel");
	driverName.BackgroundTransparency = 1;
	driverName.Size = new UDim2(1, 0, 0.55, 0);
	driverName.Font = Enum.Font.GothamBold;
	driverName.TextScaled = true;
	driverName.TextColor3 = new Color3(1, 1, 1);
	driverName.TextStrokeTransparency = 0.4;
	driverName.Text = "";
	driverName.Parent = billboard;

	const barBack = new Instance("Frame");
	barBack.AnchorPoint = new Vector2(0.5, 1);
	barBack.Position = UDim2.fromScale(0.5, 1);
	barBack.Size = new UDim2(0.8, 0, 0.32, 0);
	barBack.BackgroundColor3 = Color3.fromRGB(12, 14, 22);
	barBack.BackgroundTransparency = 0.35;
	barBack.Parent = billboard;

	const backCorner = new Instance("UICorner");
	backCorner.CornerRadius = new UDim(0.5, 0);
	backCorner.Parent = barBack;

	const backStroke = new Instance("UIStroke");
	backStroke.Thickness = 1.5;
	backStroke.Color = Color3.fromRGB(70, 80, 100);
	backStroke.Transparency = 0.4;
	backStroke.Parent = barBack;

	const fill = new Instance("Frame");
	fill.Position = UDim2.fromScale(0.02, 0.15);
	fill.Size = UDim2.fromScale(0.96, 0.7);
	fill.BackgroundColor3 = healthColor(1);
	fill.BorderSizePixel = 0;
	fill.Parent = barBack;

	const fillCorner = new Instance("UICorner");
	fillCorner.CornerRadius = new UDim(0.5, 0);
	fillCorner.Parent = fill;

	const wreckedText = new Instance("TextLabel");
	wreckedText.BackgroundTransparency = 1;
	wreckedText.Size = UDim2.fromScale(1, 1);
	wreckedText.Font = Enum.Font.GothamBold;
	wreckedText.TextScaled = true;
	wreckedText.TextColor3 = Color3.fromRGB(240, 70, 50);
	wreckedText.TextStrokeTransparency = 0.2;
	wreckedText.Text = "WRECKED";
	wreckedText.Visible = false;
	wreckedText.ZIndex = 2;
	wreckedText.Parent = barBack;

	function refreshHealth() {
		const health = (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? MAX_HEALTH;
		const frac = math.clamp(health / MAX_HEALTH, 0, 1);
		TweenService.Create(fill, new TweenInfo(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
			Size: UDim2.fromScale(0.96 * frac, 0.7),
			BackgroundColor3: healthColor(frac),
		}).Play();
		fill.Visible = frac > 0;
		wreckedText.Visible = health <= 0;
	}

	// Hide our own bar while we're the one driving; show the driver's name to
	// everyone else. Occupant flips on enter/exit and on respawn re-seats.
	function refreshOccupant() {
		const occupant = seat.Occupant;
		const character = occupant?.Parent;
		const driver = character ? Players.GetPlayerFromCharacter(character) : undefined;
		driverName.Text = driver ? driver.DisplayName : "";
		billboard.Enabled = driver === undefined || driver !== localPlayer;
		trackerBillboard.Enabled = driver === undefined || driver !== localPlayer;
	}

	refreshHealth();
	refreshOccupant();
	car.GetAttributeChangedSignal(HEALTH_ATTR).Connect(refreshHealth);
	seat.GetPropertyChangedSignal("Occupant").Connect(refreshOccupant);

	activeTrackers.set(car, {
		billboard,
		trackerBillboard,
		arrowLabel,
	});

	if (updateRivalIndicators) {
		updateRivalIndicators();
	}
}

// Same car shape test the server systems use: a workspace model holding a
// chassis and a seat. Non-car models just time out in the WaitForChild.
function tryAttach(child: Instance) {
	if (child.IsA("Model")) task.spawn(attachHealthBar, child);
}

for (const child of Workspace.GetChildren()) tryAttach(child);
Workspace.ChildAdded.Connect(tryAttach);

// Clean up trackers when a car model leaves Workspace
Workspace.ChildRemoved.Connect((child) => {
	if (child.IsA("Model")) {
		activeTrackers.delete(child);
	}
});

// Dynamic local player Rival tracking HUD synchronization
task.spawn(() => {
	const result = waitForLocalCar();
	localCar = result.car;

	// Populate updateRivalIndicators
	updateRivalIndicators = () => {
		if (!localCar) return;
		const activeRivalName = localCar.GetAttribute("ActiveRival") as string | undefined;

		for (const [otherCar, elements] of activeTrackers) {
			const isRival = activeRivalName !== undefined && activeRivalName !== "" && otherCar.Name === activeRivalName;

			if (isRival) {
				// Style as active Rival
				elements.trackerBillboard.Size = UDim2.fromOffset(45, 45); // Scale up significantly
				elements.trackerBillboard.StudsOffset = new Vector3(0, 5.6, 0); // Position it higher
				elements.arrowLabel.TextColor3 = Color3.fromRGB(255, 40, 40); // Red target tint

				if (!elements.rivalLabel) {
					const label = new Instance("TextLabel");
					label.Size = new UDim2(1, 0, 0.4, 0);
					label.Position = new UDim2(0, 0, -0.45, 0); // Above the arrow
					label.BackgroundTransparency = 1;
					label.Font = Enum.Font.GothamBold;
					label.Text = "RIVAL";
					label.TextScaled = true;
					label.TextColor3 = Color3.fromRGB(255, 40, 40);
					label.TextStrokeTransparency = 0.2;
					label.TextStrokeColor3 = Color3.fromRGB(0, 0, 0);
					label.Parent = elements.trackerBillboard;
					elements.rivalLabel = label;
				} else {
					elements.rivalLabel.Visible = true;
				}
			} else {
				// Restore original styling
				elements.trackerBillboard.Size = UDim2.fromOffset(24, 24);
				elements.trackerBillboard.StudsOffset = new Vector3(0, 4.8, 0);
				const chassis = otherCar.FindFirstChild(CHASSIS_NAME);
				if (chassis?.IsA("BasePart")) {
					elements.arrowLabel.TextColor3 = chassis.Color;
				}
				if (elements.rivalLabel) {
					elements.rivalLabel.Visible = false;
				}
			}
		}
	};

	localCar.GetAttributeChangedSignal("ActiveRival").Connect(updateRivalIndicators);
	updateRivalIndicators();
});

// RenderStepped pulse animation loop for the active Rival indicator
RunService.RenderStepped.Connect(() => {
	if (!localCar) return;
	const activeRivalName = localCar.GetAttribute("ActiveRival") as string | undefined;
	if (activeRivalName === undefined || activeRivalName === "") return;

	for (const [otherCar, elements] of activeTrackers) {
		if (otherCar.Name === activeRivalName) {
			const pulse = (math.sin(os.clock() * 12) + 1) / 2; // pulse rate
			elements.arrowLabel.TextTransparency = 0.1 + pulse * 0.35;
			elements.arrowLabel.TextStrokeTransparency = 0.3 + pulse * 0.35;
			if (elements.rivalLabel) {
				elements.rivalLabel.TextTransparency = 0.1 + pulse * 0.35;
				elements.rivalLabel.TextStrokeTransparency = 0.3 + pulse * 0.35;
			}
		}
	}
});
