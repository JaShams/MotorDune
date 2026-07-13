export const OWNER_USER_ID_ATTR = "OwnerUserId";
export const SKIN_ID_ATTR = "SkinId";
export const MATCH_PHASE_ATTR = "MatchPhase";
export const MATCH_MODE_ATTR = "MatchMode";
export const MATCH_ENDS_AT_ATTR = "MatchEndsAt";
export const MATCH_TARGET_ATTR = "MatchTarget";
export const RESPAWNS_LEFT_ATTR = "RespawnsLeft";
export const ROUND_NUMBER_ATTR = "RoundNumber";
export const ROUND_ELIMINATED_ATTR = "RoundEliminated";
export const CONFIGURED_BOTS_ATTR = "ConfiguredBots";

export const SESSION_REMOTES = "SessionRemotes";
export const SESSION_REQUEST = "Request";
export const SESSION_UPDATE = "Update";

export const MAX_PLAYERS = 8;
export const MAX_BOTS = 3;
export const RESULTS_SECONDS = 10;
export const FIRST_ROUND_DELAY_SECONDS = 5;
export const PRIVATE_CODE_TTL_SECONDS = 6 * 60 * 60;

export type MatchMode = "timed" | "score" | "elimination";
export type MatchPhase = "waiting" | "active" | "results";

export interface MatchRules {
	mode: MatchMode;
	durationSeconds: number;
	scoreTarget: number;
	extraRespawns: number;
	botCount: number;
}

export interface MatchPayload {
	version: 1;
	visibility: "public" | "private" | "studio";
	hostUserId: number;
	rules: MatchRules;
	joinCode?: string;
}

export const DEFAULT_RULES: MatchRules = {
	mode: "timed",
	durationSeconds: 180,
	scoreTarget: 500,
	extraRespawns: 3,
	botCount: 3,
};

export const SKINS = [
	{ id: "red", color: Color3.fromRGB(205, 52, 52) },
	{ id: "blue", color: Color3.fromRGB(38, 128, 212) },
	{ id: "orange", color: Color3.fromRGB(236, 148, 32) },
	{ id: "green", color: Color3.fromRGB(70, 190, 92) },
	{ id: "yellow", color: Color3.fromRGB(235, 205, 55) },
	{ id: "purple", color: Color3.fromRGB(145, 80, 200) },
	{ id: "white", color: Color3.fromRGB(225, 225, 225) },
	{ id: "black", color: Color3.fromRGB(35, 38, 45) },
] as const;

export function validRules(value: unknown): value is MatchRules {
	if (!typeIs(value, "table")) return false;
	const rules = value as unknown as MatchRules;
	return (
		(rules.mode === "timed" || rules.mode === "score" || rules.mode === "elimination") &&
		(rules.durationSeconds === 180 || rules.durationSeconds === 300 || rules.durationSeconds === 600) &&
		(rules.scoreTarget === 250 || rules.scoreTarget === 500 || rules.scoreTarget === 1000) &&
		(rules.extraRespawns === 1 || rules.extraRespawns === 3 || rules.extraRespawns === 5) &&
		typeIs(rules.botCount, "number") &&
		rules.botCount >= 0 &&
		rules.botCount <= MAX_BOTS
	);
}

export function skinColor(id: string) {
	for (const skin of SKINS) if (skin.id === id) return skin.color;
	return SKINS[0].color;
}
