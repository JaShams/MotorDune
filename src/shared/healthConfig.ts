// Car health + demolition scoring shared config.
// Health lives as a number attribute on the car model; the server owns it and
// the HUD just reads it. Points go into the standard leaderstats folder so the
// built-in Roblox player list shows them alongside the custom HUD leaderboard.

import { PowerupType } from "./powerupConfig";

export const MAX_HEALTH = 100;
export const HEALTH_ATTR = "Health";

// Seconds a wrecked car stays at zero health before it resets to full.
export const WRECK_RESET_SECONDS = 3;

// Damage dealt by each powerup hit (shield/nitro are defensive/boost only).
export const POWERUP_DAMAGE: Record<PowerupType, number> = {
	bolt: 20,
	shunt: 60,
	mine: 70,
	barge: 35,
	shield: 0,
	nitro: 0,
};

// Scoring: 1 point per damage dealt, plus a bonus for the wrecking blow.
export const WRECK_BONUS_POINTS = 50;

export const LEADERSTATS_NAME = "leaderstats";
export const POINTS_NAME = "Points";
// Bots are models rather than Players, so their scoreboard identity and score
// replicate as attributes on the car model.
export const BOT_LABEL_ATTR = "BotLabel";
export const BOT_POINTS_ATTR = "BotPoints";

// Shared health-bar colour ramp, used by both the driver's HUD bar and the
// overhead billboard bars so a given health reads the same everywhere.
const HEALTH_FULL = Color3.fromRGB(90, 220, 90);
const HEALTH_MID = Color3.fromRGB(250, 200, 60);
const HEALTH_LOW = Color3.fromRGB(240, 70, 50);

export function healthColor(frac: number) {
	// Green -> yellow over the top half, yellow -> red over the bottom half.
	return frac > 0.5 ? HEALTH_MID.Lerp(HEALTH_FULL, (frac - 0.5) * 2) : HEALTH_LOW.Lerp(HEALTH_MID, frac * 2);
}
