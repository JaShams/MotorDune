import { Players, TweenService, Workspace } from "@rbxts/services";
import { CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import { HEALTH_ATTR, healthColor, MAX_HEALTH } from "shared/healthConfig";

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
	}

	refreshHealth();
	refreshOccupant();
	car.GetAttributeChangedSignal(HEALTH_ATTR).Connect(refreshHealth);
	seat.GetPropertyChangedSignal("Occupant").Connect(refreshOccupant);
}

// Same car shape test the server systems use: a workspace model holding a
// chassis and a seat. Non-car models just time out in the WaitForChild.
function tryAttach(child: Instance) {
	if (child.IsA("Model")) task.spawn(attachHealthBar, child);
}

for (const child of Workspace.GetChildren()) tryAttach(child);
Workspace.ChildAdded.Connect(tryAttach);
