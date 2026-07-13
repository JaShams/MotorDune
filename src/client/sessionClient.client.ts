import { GuiService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import {
	DEFAULT_RULES,
	MATCH_ENDS_AT_ATTR,
	MATCH_PHASE_ATTR,
	MAX_PLAYERS,
	MatchMode,
	MatchRules,
	SESSION_REMOTES,
	SESSION_REQUEST,
	SESSION_UPDATE,
	SKINS,
} from "shared/sessionConfig";
import {
	getInputScheme,
	onInputSchemeChanged,
	onMenuCancelRequested,
	onMenuToggleRequested,
	setGameplayInputBlocked,
} from "./controlInput";

const player = Players.LocalPlayer;
const folder = ReplicatedStorage.WaitForChild(SESSION_REMOTES);
const request = folder.WaitForChild(SESSION_REQUEST) as RemoteEvent;
const update = folder.WaitForChild(SESSION_UPDATE) as RemoteEvent;

const gui = new Instance("ScreenGui");
gui.Name = "SessionGui";
gui.ResetOnSpawn = false;
gui.IgnoreGuiInset = true;
gui.DisplayOrder = 100;
gui.Parent = player.WaitForChild("PlayerGui");

function label(parent: Instance, text: string, size: UDim2, position = UDim2.fromScale(0, 0)) {
	const item = new Instance("TextLabel");
	item.BackgroundTransparency = 1;
	item.Size = size;
	item.Position = position;
	item.Font = Enum.Font.GothamBold;
	item.TextColor3 = Color3.fromRGB(240, 235, 220);
	item.TextScaled = true;
	item.Text = text;
	item.Parent = parent;
	return item;
}

function button(parent: Instance, text: string, position: UDim2, activated: () => void) {
	const item = new Instance("TextButton");
	item.Size = UDim2.fromOffset(310, 48);
	item.Position = position;
	item.AnchorPoint = new Vector2(0.5, 0);
	item.BackgroundColor3 = Color3.fromRGB(190, 93, 38);
	item.Font = Enum.Font.GothamBold;
	item.TextColor3 = new Color3(1, 1, 1);
	item.TextSize = 17;
	item.Text = text;
	item.Parent = parent;
	const corner = new Instance("UICorner");
	corner.CornerRadius = new UDim(0, 8);
	corner.Parent = item;
	item.Activated.Connect(activated);
	return item;
}

const shade = new Instance("Frame");
shade.Size = UDim2.fromScale(1, 1);
shade.BackgroundColor3 = Color3.fromRGB(12, 10, 9);
shade.BackgroundTransparency = 0.12;
shade.Visible = false;
shade.Parent = gui;

const panel = new Instance("Frame");
panel.AnchorPoint = new Vector2(0.5, 0.5);
panel.Position = UDim2.fromScale(0.5, 0.5);
panel.Size = UDim2.fromOffset(430, 720);
panel.BackgroundColor3 = Color3.fromRGB(28, 25, 24);
panel.BackgroundTransparency = 0.08;
panel.Parent = shade;
const panelCorner = new Instance("UICorner");
panelCorner.CornerRadius = new UDim(0, 16);
panelCorner.Parent = panel;

const title = label(panel, "DESERT DEMOLITION", new UDim2(1, -32, 0, 54), UDim2.fromOffset(16, 20));
title.TextColor3 = Color3.fromRGB(255, 191, 75);
const status = label(panel, "", new UDim2(1, -40, 0, 110), UDim2.fromOffset(20, 590));
status.TextColor3 = Color3.fromRGB(210, 205, 195);
status.TextSize = 14;
status.TextScaled = false;
status.TextWrapped = true;

const timer = label(gui, "", UDim2.fromOffset(300, 42), new UDim2(0.5, -150, 0, 12));
timer.TextSize = 22;
timer.TextScaled = false;
timer.TextStrokeTransparency = 0.45;

let manualOpen = false;
const togglePrivateMatch = () => {
	manualOpen = !shade.Visible;
	shade.Visible = manualOpen;
	title.Text = "PRIVATE MATCH";
};
const menuToggle = button(gui, "PRIVATE MATCH", UDim2.fromOffset(170, 14), togglePrivateMatch);
menuToggle.Size = UDim2.fromOffset(180, 40);
menuToggle.AnchorPoint = Vector2.zero;
menuToggle.Position = UDim2.fromOffset(14, 14);

let skinIndex = 0;
let rules: MatchRules = { ...DEFAULT_RULES };

function cycle<T extends defined>(values: ReadonlyArray<T>, current: T) {
	const index = values.indexOf(current);
	return values[(index + 1) % values.size()];
}

const close = button(panel, "CLOSE / KEEP PLAYING", UDim2.fromOffset(215, 82), () => {
	manualOpen = false;
	shade.Visible = false;
});

const skin = button(panel, "PRIVATE CAR: RED", UDim2.fromOffset(215, 142), () => {
	skinIndex = (skinIndex + 1) % SKINS.size();
	skin.Text = `PRIVATE CAR: ${SKINS[skinIndex].id.upper()}`;
	skin.BackgroundColor3 = SKINS[skinIndex].color;
});

const modes: MatchMode[] = ["timed", "score", "elimination"];
const mode = button(panel, "MODE: TIMED", UDim2.fromOffset(215, 202), () => {
	rules.mode = cycle(modes, rules.mode);
	mode.Text = `MODE: ${rules.mode.upper()}`;
});
const values = button(panel, "DURATION: 3 MIN", UDim2.fromOffset(215, 262), () => {
	if (rules.mode === "timed") {
		rules.durationSeconds = cycle([180, 300, 600], rules.durationSeconds);
		values.Text = `DURATION: ${rules.durationSeconds / 60} MIN`;
	} else if (rules.mode === "score") {
		rules.scoreTarget = cycle([250, 500, 1000], rules.scoreTarget);
		values.Text = `TARGET: ${rules.scoreTarget}`;
	} else {
		rules.extraRespawns = cycle([1, 3, 5], rules.extraRespawns);
		values.Text = `EXTRA RESPAWNS: ${rules.extraRespawns}`;
	}
});
const bots = button(panel, "BOTS: 3", UDim2.fromOffset(215, 322), () => {
	rules.botCount = (rules.botCount + 1) % 4;
	bots.Text = `BOTS: ${rules.botCount}`;
});
const create = button(panel, "CREATE PRIVATE GAME", UDim2.fromOffset(215, 382), () => {
	status.Text = "Creating private game…";
	request.FireServer("create", { rules, skinId: SKINS[skinIndex].id });
});

const codeBox = new Instance("TextBox");
codeBox.AnchorPoint = new Vector2(0.5, 0);
codeBox.Position = UDim2.fromOffset(135, 450);
codeBox.Size = UDim2.fromOffset(150, 48);
codeBox.BackgroundColor3 = Color3.fromRGB(50, 47, 45);
codeBox.PlaceholderText = "JOIN CODE";
codeBox.Text = "";
codeBox.Font = Enum.Font.GothamBold;
codeBox.TextColor3 = new Color3(1, 1, 1);
codeBox.TextSize = 18;
codeBox.Parent = panel;
const join = button(panel, "JOIN", UDim2.fromOffset(305, 450), () => {
	status.Text = "Joining private game…";
	request.FireServer("join", { code: codeBox.Text, skinId: SKINS[skinIndex].id });
});
join.Size = UDim2.fromOffset(130, 48);

const returnPublic = button(panel, "RETURN TO PUBLIC", UDim2.fromOffset(215, 510), () => {
	status.Text = "Finding a public server…";
	request.FireServer("public");
});
returnPublic.Visible = false;

// Explicit navigation keeps the two-column join row deterministic on console;
// automatic nearest-neighbour navigation can otherwise jump to the HUD behind
// the modal when the return button is hidden.
close.SelectionOrder = 1;
skin.SelectionOrder = 2;
mode.SelectionOrder = 3;
values.SelectionOrder = 4;
bots.SelectionOrder = 5;
create.SelectionOrder = 6;
codeBox.SelectionOrder = 7;
join.SelectionOrder = 8;
returnPublic.SelectionOrder = 9;

close.NextSelectionDown = skin;
skin.NextSelectionUp = close;
skin.NextSelectionDown = mode;
mode.NextSelectionUp = skin;
mode.NextSelectionDown = values;
values.NextSelectionUp = mode;
values.NextSelectionDown = bots;
bots.NextSelectionUp = values;
bots.NextSelectionDown = create;
create.NextSelectionUp = bots;
create.NextSelectionDown = codeBox;
codeBox.NextSelectionUp = create;
codeBox.NextSelectionRight = join;
join.NextSelectionUp = create;
join.NextSelectionLeft = codeBox;

function refreshLowerNavigation() {
	const lowerControl: GuiObject = returnPublic.Visible ? returnPublic : close;
	codeBox.NextSelectionDown = lowerControl;
	join.NextSelectionDown = lowerControl;
	if (returnPublic.Visible) {
		returnPublic.NextSelectionUp = codeBox;
		returnPublic.NextSelectionDown = close;
		close.NextSelectionUp = returnPublic;
	} else {
		close.NextSelectionUp = join;
	}
}

returnPublic.GetPropertyChangedSignal("Visible").Connect(refreshLowerNavigation);
refreshLowerNavigation();

function refreshModalInput() {
	setGameplayInputBlocked(shade.Visible);
	if (!shade.Visible) {
		if (GuiService.SelectedObject?.IsDescendantOf(panel)) GuiService.SelectedObject = undefined;
		return;
	}
	if (getInputScheme() === "gamepad") {
		const selected = GuiService.SelectedObject;
		if (selected === undefined || !selected.IsDescendantOf(panel) || !selected.Visible) GuiService.SelectedObject = close;
	}
}

shade.GetPropertyChangedSignal("Visible").Connect(refreshModalInput);
onInputSchemeChanged(refreshModalInput);
onMenuToggleRequested(togglePrivateMatch);
onMenuCancelRequested(() => {
	if (!shade.Visible) return;
	manualOpen = false;
	shade.Visible = false;
});
codeBox.FocusLost.Connect(() => {
	if (shade.Visible && getInputScheme() === "gamepad") GuiService.SelectedObject = join;
});
refreshModalInput();

update.OnClientEvent.Connect((kindArg, bodyArg) => {
	const kind = tostring(kindArg);
	if (kind === "error") status.Text = tostring(bodyArg);
	if (kind === "snapshot" && typeIs(bodyArg, "table")) {
		const body = bodyArg as {
			phase?: string;
			roundNumber?: number;
			players?: unknown[];
			joinCode?: string;
			visibility?: string;
		};
		const codeText = body.joinCode ? ` • CODE ${body.joinCode}` : "";
		status.Text = `${body.visibility === "private" ? "PRIVATE" : "PUBLIC"} • ${body.players?.size() ?? 0}/${MAX_PLAYERS} players${codeText}`;
		returnPublic.Visible = body.visibility === "private";
		menuToggle.Text = body.visibility === "private" ? `PRIVATE • ${body.joinCode ?? ""}` : "PRIVATE MATCH";
		if (body.phase === "waiting") {
			title.Text = "GET READY";
			shade.Visible = true;
		} else if (body.phase === "active" && !manualOpen) {
			shade.Visible = false;
		}
	}
	if (kind === "results" && typeIs(bodyArg, "table")) {
		const body = bodyArg as {
			roundNumber?: number;
			winner?: string;
			standings?: Array<{ name: string; points: number }>;
		};
		manualOpen = false;
		shade.Visible = true;
		title.Text = `ROUND ${body.roundNumber ?? ""} COMPLETE`;
		const rows = body.standings?.map((entry, index) => `${index + 1}. ${entry.name}  —  ${entry.points}`) ?? [];
		status.Text = `Winner: ${body.winner ?? "—"}\n${rows.join("\n")}`;
	}
});

Workspace.GetAttributeChangedSignal(MATCH_PHASE_ATTR).Connect(() => {
	if (Workspace.GetAttribute(MATCH_PHASE_ATTR) === "active" && !manualOpen) shade.Visible = false;
});

RunService.RenderStepped.Connect(() => {
	const phase = Workspace.GetAttribute(MATCH_PHASE_ATTR);
	const endAt = (Workspace.GetAttribute(MATCH_ENDS_AT_ATTR) as number | undefined) ?? 0;
	const remaining = math.max(0, math.ceil(endAt - Workspace.GetServerTimeNow()));
	const minutes = math.floor(remaining / 60);
	const seconds = remaining % 60;
	if (phase === "active") timer.Text = `ROUND  ${minutes}:${string.format("%02d", seconds)}`;
	else if (phase === "results") timer.Text = `NEXT ROUND  ${remaining}`;
	else timer.Text = `STARTING  ${remaining}`;
});

// RemoteEvents do not queue messages sent before this LocalScript connects.
// Ask for the current server state so late joiners always learn the private
// code and current phase even if PlayerAdded's broadcast raced client boot.
request.FireServer("snapshot");
