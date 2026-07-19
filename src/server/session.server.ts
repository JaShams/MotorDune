import {
	HttpService,
	MemoryStoreService,
	Players,
	ReplicatedStorage,
	RunService,
	TeleportService,
	Workspace,
} from "@rbxts/services";
import {
	BOT_LABEL_ATTR,
	BOT_POINTS_ATTR,
	HEALTH_ATTR,
	LEADERSTATS_NAME,
	MAX_HEALTH,
	POINTS_NAME,
} from "shared/healthConfig";
import { FX_FOLDER, NITRO_UNTIL_ATTR, SHIELD_UNTIL_ATTR, SLOT_ATTRS } from "shared/powerupConfig";
import {
	DEFAULT_RULES,
	CONFIGURED_BOTS_ATTR,
	FIRST_ROUND_DELAY_SECONDS,
	MATCH_ENDS_AT_ATTR,
	MATCH_MODE_ATTR,
	MATCH_PHASE_ATTR,
	MATCH_TARGET_ATTR,
	MatchPayload,
	MatchPhase,
	MatchRules,
	OWNER_USER_ID_ATTR,
	PRIVATE_CODE_TTL_SECONDS,
	RESULTS_SECONDS,
	RESPAWNS_LEFT_ATTR,
	ROUND_ELIMINATED_ATTR,
	ROUND_NUMBER_ATTR,
	SESSION_REMOTES,
	SESSION_REQUEST,
	SESSION_UPDATE,
	validRules,
} from "shared/sessionConfig";

const folder = ReplicatedStorage.FindFirstChild(SESSION_REMOTES) ?? new Instance("Folder");
folder.Name = SESSION_REMOTES;
folder.Parent = ReplicatedStorage;
const request = (folder.FindFirstChild(SESSION_REQUEST) as RemoteEvent | undefined) ?? new Instance("RemoteEvent");
request.Name = SESSION_REQUEST;
request.Parent = folder;
const update = (folder.FindFirstChild(SESSION_UPDATE) as RemoteEvent | undefined) ?? new Instance("RemoteEvent");
update.Name = SESSION_UPDATE;
update.Parent = folder;

let sessions: MemoryStoreHashMap | undefined;
try {
	sessions = MemoryStoreService.GetHashMap("DDD_PrivateSessions_v2");
} catch (err) {
	warn(`[session] MemoryStoreService unavailable (unpublished place). Private matches will be disabled. Error: ${err}`);
}

function code() {
	const [compact] = string.gsub(HttpService.GenerateGUID(false), "-", "");
	return string.sub(compact, 1, 6).upper();
}

function payload(visibility: "public" | "private" | "studio", hostUserId: number, rules: MatchRules): MatchPayload {
	return { version: 1, visibility, hostUserId, rules };
}

function teleportReserved(player: Player, accessCode: string, data: MatchPayload & { skinId?: string }) {
	const options = new Instance("TeleportOptions");
	options.ReservedServerAccessCode = accessCode;
	options.SetTeleportData(data);
	TeleportService.TeleportAsync(game.PlaceId, [player], options);
}

let match: MatchPayload = payload(RunService.IsStudio() ? "studio" : "public", 0, DEFAULT_RULES);
let phase: MatchPhase = "waiting";
let hostUserId = 0;
let roundNumber = 0;
let roundToken = 0;
let configuredPrivateMatch = false;
const previousHealth = new Map<Model, number>();

function applyMatch(value: MatchPayload) {
	match = value;
	hostUserId = value.hostUserId;
	Workspace.SetAttribute(CONFIGURED_BOTS_ATTR, value.rules.botCount);
	Workspace.SetAttribute(MATCH_MODE_ATTR, value.rules.mode);
	Workspace.SetAttribute(
		MATCH_TARGET_ATTR,
		value.rules.mode === "score" ? value.rules.scoreTarget : value.rules.extraRespawns,
	);
}

function snapshot() {
	return {
		phase,
		roundNumber,
		hostUserId,
		visibility: match.visibility,
		rules: match.rules,
		joinCode: match.joinCode,
		players: Players.GetPlayers().map((p) => ({ userId: p.UserId, name: p.DisplayName })),
	};
}

function broadcast() {
	update.FireAllClients("snapshot", snapshot());
}

function pointsFor(car: Model) {
	if (car.GetAttribute("IsBot") === true) return (car.GetAttribute(BOT_POINTS_ATTR) as number | undefined) ?? 0;
	const owner = car.GetAttribute(OWNER_USER_ID_ATTR);
	const player = typeIs(owner, "number") ? Players.GetPlayerByUserId(owner) : undefined;
	const points = player?.FindFirstChild(LEADERSTATS_NAME)?.FindFirstChild(POINTS_NAME);
	return points?.IsA("IntValue") ? points.Value : 0;
}

function cars() {
	return Workspace.GetChildren().filter(
		(child): child is Model => child.IsA("Model") && child.GetAttribute(HEALTH_ATTR) !== undefined,
	);
}

function resetRoundState() {
	previousHealth.clear();
	const oldFx = Workspace.FindFirstChild(FX_FOLDER);
	if (oldFx) for (const child of oldFx.GetChildren()) child.Destroy();
	for (const player of Players.GetPlayers()) {
		const points = player.FindFirstChild(LEADERSTATS_NAME)?.FindFirstChild(POINTS_NAME);
		if (points?.IsA("IntValue")) points.Value = 0;
	}
	for (const car of cars()) {
		car.SetAttribute(HEALTH_ATTR, MAX_HEALTH);
		car.SetAttribute(BOT_POINTS_ATTR, 0);
		car.SetAttribute(RESPAWNS_LEFT_ATTR, match.rules.extraRespawns);
		car.SetAttribute(ROUND_ELIMINATED_ATTR, false);
		car.SetAttribute(NITRO_UNTIL_ATTR, 0);
		car.SetAttribute(SHIELD_UNTIL_ATTR, 0);
		for (const attr of SLOT_ATTRS) car.SetAttribute(attr, "");
	}
}

function sortedStandings() {
	const standings = cars().map((car) => ({
		name:
			car.GetAttribute("IsBot") === true
				? ((car.GetAttribute(BOT_LABEL_ATTR) as string | undefined) ?? car.Name)
				: (Players.GetPlayerByUserId((car.GetAttribute(OWNER_USER_ID_ATTR) as number | undefined) ?? 0)
						?.DisplayName ?? car.Name),
		points: pointsFor(car),
	}));
	standings.sort((a, b) => a.points > b.points);
	return standings;
}

function finishRound() {
	if (phase !== "active") return;
	roundToken += 1;
	phase = "results";
	const resultsEnd = Workspace.GetServerTimeNow() + RESULTS_SECONDS;
	Workspace.SetAttribute(MATCH_PHASE_ATTR, phase);
	Workspace.SetAttribute(MATCH_ENDS_AT_ATTR, resultsEnd);
	const standings = sortedStandings();
	broadcast();
	update.FireAllClients("results", { roundNumber, winner: standings[0]?.name ?? "—", standings });
	const token = roundToken;
	task.delay(RESULTS_SECONDS, () => {
		if (phase === "results" && roundToken === token) startRound();
	});
}

function startRound() {
	roundToken += 1;
	roundNumber += 1;
	resetRoundState();
	phase = "active";
	Workspace.SetAttribute(ROUND_NUMBER_ATTR, roundNumber);
	Workspace.SetAttribute(MATCH_PHASE_ATTR, phase);
	const token = roundToken;
	if (match.rules.mode === "timed") {
		const endAt = Workspace.GetServerTimeNow() + match.rules.durationSeconds;
		Workspace.SetAttribute(MATCH_ENDS_AT_ATTR, endAt);
		task.delay(match.rules.durationSeconds, () => {
			if (phase === "active" && roundToken === token) finishRound();
		});
	} else {
		Workspace.SetAttribute(MATCH_ENDS_AT_ATTR, 0);
	}
	broadcast();
}

function configureFromJoin(player: Player) {
	const data = player.GetJoinData().TeleportData;
	if (!configuredPrivateMatch && typeIs(data, "table")) {
		const candidate = data as { version?: unknown; visibility?: unknown; rules?: unknown };
		if (candidate.version === 1 && candidate.visibility === "private" && validRules(candidate.rules)) {
			applyMatch(data as unknown as MatchPayload);
			configuredPrivateMatch = true;
		}
	}
	if (hostUserId === 0 && match.visibility === "private") hostUserId = player.UserId;
}

Players.PlayerAdded.Connect((player) => {
	configureFromJoin(player);
	task.defer(broadcast);
});
Players.PlayerRemoving.Connect((player) => {
	if (player.UserId === hostUserId) hostUserId = Players.GetPlayers().find((p) => p !== player)?.UserId ?? 0;
	task.defer(broadcast);
});
for (const player of Players.GetPlayers()) configureFromJoin(player);

request.OnServerEvent.Connect((player, actionArg, bodyArg) => {
	const action = typeIs(actionArg, "string") ? actionArg : "";
	if (action === "snapshot") {
		update.FireClient(player, "snapshot", snapshot());
		return;
	}
	const body = typeIs(bodyArg, "table") ? (bodyArg as { rules?: unknown; code?: unknown; skinId?: unknown }) : {};
	const skinId = typeIs(body.skinId, "string") ? body.skinId : "red";
	task.spawn(() => {
		const [ok, err] = pcall(() => {
			if (RunService.IsStudio()) error("Private server teleports must be tested in the published Roblox app");
			if (action === "create") {
				if (!sessions) error("MemoryStoreService is not available in this environment");
				if (!validRules(body.rules)) error("Invalid match rules");
				const [accessCode] = TeleportService.ReserveServerAsync(game.PlaceId) as LuaTuple<[string, string]>;
				const joinCode = code();
				const privateMatch = { ...payload("private", player.UserId, body.rules), joinCode };
				sessions.SetAsync(`private_${joinCode}`, { accessCode, match: privateMatch }, PRIVATE_CODE_TTL_SECONDS);
				teleportReserved(player, accessCode, { ...privateMatch, skinId });
				return;
			}
			if (action === "join" && typeIs(body.code, "string")) {
				if (!sessions) error("MemoryStoreService is not available in this environment");
				const [joinCode] = string.gsub(body.code.upper(), "%s+", "");
				const found = sessions.GetAsync(`private_${joinCode}`) as
					| { accessCode: string; match: MatchPayload }
					| undefined;
				if (!found) error("Private game code was not found or has expired");
				teleportReserved(player, found.accessCode, { ...found.match, skinId });
				return;
			}
			if (action === "public" && match.visibility === "private") {
				TeleportService.TeleportAsync(game.PlaceId, [player]);
				return;
			}
			error("Unknown session request");
		});
		if (!ok) update.FireClient(player, "error", tostring(err));
	});
});

RunService.Heartbeat.Connect(() => {
	if (phase !== "active") return;
	const active = cars();
	if (match.rules.mode === "score") {
		for (const car of active) if (pointsFor(car) >= match.rules.scoreTarget) finishRound();
	} else if (match.rules.mode === "elimination") {
		for (const car of active) {
			if (car.GetAttribute(ROUND_ELIMINATED_ATTR) === true) continue;
			const health = (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? MAX_HEALTH;
			const before = previousHealth.get(car) ?? health;
			if (before > 0 && health <= 0) {
				const left = (car.GetAttribute(RESPAWNS_LEFT_ATTR) as number | undefined) ?? match.rules.extraRespawns;
				if (left <= 0) car.SetAttribute(ROUND_ELIMINATED_ATTR, true);
				else car.SetAttribute(RESPAWNS_LEFT_ATTR, left - 1);
			}
			previousHealth.set(car, health);
		}
		const contenders = active.filter((car) => car.GetAttribute(ROUND_ELIMINATED_ATTR) !== true);
		if (active.size() > 1 && contenders.size() <= 1) finishRound();
	}
});

Workspace.SetAttribute(MATCH_PHASE_ATTR, phase);
Workspace.SetAttribute(ROUND_NUMBER_ATTR, roundNumber);
applyMatch(match);
task.spawn(() => {
	if (Workspace.GetAttribute("ArenaReady") !== true) Workspace.GetAttributeChangedSignal("ArenaReady").Wait();
	const token = roundToken;
	const firstRoundAt = Workspace.GetServerTimeNow() + FIRST_ROUND_DELAY_SECONDS;
	Workspace.SetAttribute(MATCH_ENDS_AT_ATTR, firstRoundAt);
	broadcast();
	task.delay(FIRST_ROUND_DELAY_SECONDS, () => {
		if (phase === "waiting" && roundToken === token) startRound();
	});
});
