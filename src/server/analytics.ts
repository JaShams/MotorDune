import { AnalyticsService, HttpService, Players, RunService, Workspace } from "@rbxts/services";
import { OWNER_USER_ID_ATTR } from "shared/sessionConfig";

// ---------------------------------------------------------------------------
// RELEASE ANALYTICS
//
// The core-loop funnel is deliberately derived only from server-owned facts:
// joining, becoming the actual seat occupant, accepting a pickup into the
// replicated inventory, and dealing real (unshielded) damage. This keeps
// exploit traffic out of the release funnel and avoids adding an analytics
// RemoteEvent that clients could manufacture.
//
// Roblox analytics are accepted only from published servers. Studio prints
// the same transitions instead, which makes the hooks playtestable before a
// release without filling every caller with RunService checks.
// ---------------------------------------------------------------------------

const FUNNEL_NAME = "CoreLoopEntry";
const SESSION_DURATION_EVENT = "SessionDurationSeconds";

interface PlayerSession {
	funnelSessionId: string;
	startedAt: number;
	highestStep: number;
	finished: boolean;
}

const sessions = new Map<Player, PlayerSession>();

function serverType() {
	return game.PrivateServerId !== "" ? "reserved" : "public";
}

function stepName(step: number) {
	if (step === 1) return "Joined";
	if (step === 2) return "Seated";
	if (step === 3) return "FirstPickup";
	if (step === 4) return "FirstHit";
	return "None";
}

function runAnalytics(label: string, callback: () => void) {
	if (RunService.IsStudio()) {
		print(`[analytics] ${label}`);
		return;
	}
	const [ok, err] = pcall(callback);
	if (!ok) warn(`[analytics] ${label} failed: ${tostring(err)}`);
}

function ensureSession(player: Player) {
	const existing = sessions.get(player);
	if (existing) return existing;
	const state: PlayerSession = {
		funnelSessionId: HttpService.GenerateGUID(false),
		startedAt: Workspace.GetServerTimeNow(),
		highestStep: 0,
		finished: false,
	};
	sessions.set(player, state);
	return state;
}

function recordStep(player: Player, step: number) {
	const state = ensureSession(player);
	if (state.finished || step <= state.highestStep) return;
	state.highestStep = step;
	const name = stepName(step);
	runAnalytics(`${player.Name} ${step}:${name}`, () => {
		AnalyticsService.LogFunnelStepEvent(player, FUNNEL_NAME, state.funnelSessionId, step, name, {
			serverType: serverType(),
		});
	});
}

function playerForCar(car: Model) {
	const owner = car.GetAttribute(OWNER_USER_ID_ATTR);
	return typeIs(owner, "number") ? Players.GetPlayerByUserId(owner) : undefined;
}

function beginSession(player: Player) {
	ensureSession(player);
	recordStep(player, 1);
}

function finishSession(player: Player) {
	const state = sessions.get(player);
	if (!state || state.finished) return;
	state.finished = true;
	const duration = math.max(1, math.floor(Workspace.GetServerTimeNow() - state.startedAt));
	const highestStep = stepName(state.highestStep);
	runAnalytics(`${player.Name} duration=${duration}s highest=${highestStep}`, () => {
		AnalyticsService.LogCustomEvent(player, SESSION_DURATION_EVENT, duration, {
			highestStep,
			serverType: serverType(),
		});
	});
}

/** Record the first time this session's player becomes their car's driver. */
export function recordSeated(player: Player) {
	recordStep(player, 2);
}

/** Record a pickup only after the server has successfully put it in inventory. */
export function recordPickup(car: Model) {
	const player = playerForCar(car);
	if (player) recordStep(player, 3);
}

/** Record a hit only after the server has attributed real damage to its attacker. */
export function recordHit(attacker: Model) {
	const player = playerForCar(attacker);
	if (player) recordStep(player, 4);
}

Players.PlayerAdded.Connect(beginSession);
Players.PlayerRemoving.Connect(finishSession);
for (const player of Players.GetPlayers()) beginSession(player);

// PlayerRemoving normally completes first. The idempotent shutdown pass is a
// backstop for server termination paths where players remain while BindToClose
// callbacks start running.
game.BindToClose(() => {
	for (const player of Players.GetPlayers()) finishSession(player);
});

print(
	`[release] place=${game.PlaceId} version=${game.PlaceVersion} server=${serverType()} job=${game.JobId !== "" ? game.JobId : "studio"}`,
);
