// Blur-style power-up system shared config (see concept/Blur video).
// Cars hold up to 3 power-ups, stored as string attributes on the car model
// ("Slot1".."Slot3"). Bolt slots carry charges, encoded as "bolt:3".

export type PowerupType = "shield" | "bolt" | "shunt" | "nitro" | "mine" | "barge";

export const POWERUP_TYPES: ReadonlyArray<PowerupType> = ["shield", "bolt", "shunt", "nitro", "mine", "barge"];

export interface PowerupInfo {
	color: Color3;
	emoji: string;
	/** Sharp, single-colour mark shared by world pickups and the weapon rack. */
	glyph: string;
	label: string;
	/** Can the player choose to fire it backwards? */
	directional: boolean;
}

export const POWERUP_INFO: Record<PowerupType, PowerupInfo> = {
	shield: { color: Color3.fromRGB(80, 220, 255), emoji: "🛡️", glyph: "⬡", label: "Shield", directional: false },
	bolt: { color: Color3.fromRGB(255, 70, 70), emoji: "⚡", glyph: "ϟ", label: "Bolt", directional: true },
	shunt: { color: Color3.fromRGB(255, 160, 40), emoji: "🚀", glyph: "➤", label: "Shunt", directional: true },
	nitro: { color: Color3.fromRGB(190, 90, 255), emoji: "🔥", glyph: "▲", label: "Nitro", directional: false },
	mine: { color: Color3.fromRGB(255, 220, 60), emoji: "💣", glyph: "✹", label: "Mine", directional: true },
	barge: { color: Color3.fromRGB(70, 120, 255), emoji: "💥", glyph: "◎", label: "Barge", directional: false },
};

export const MAX_SLOTS = 3;
export const SLOT_ATTRS = ["Slot1", "Slot2", "Slot3"];

// Effect tuning.
export const BOLT_CHARGES = 3;
export const SHIELD_DURATION = 7;
export const NITRO_DURATION = 2.5;
// Nitro is read by the client physics loop (the driver owns the chassis).
export const NITRO_SPEED_MULT = 1.4;
export const NITRO_BOOST_ACCEL = 90; // extra forward accel (studs/s^2) while boosting
export const BARGE_RADIUS = 30;
export const PAD_RESPAWN_SECONDS = 20;

// Combat presentation is deliberately larger than combat collision. These
// dimensions make fast threats legible at chase-camera distance without
// silently making them easier to land.
export const BOLT_VISUAL_SIZE = new Vector3(1.4, 1.4, 5);
export const BOLT_TRAIL_WIDTH = 1.4;
export const BOLT_HIT_RADIUS = 1.2;
export const SHUNT_VISUAL_SIZE = new Vector3(3.6, 3.6, 3.6);
export const SHUNT_TRAIL_WIDTH = 3.2;
export const MINE_VISUAL_DIAMETER = 5.5;
export const MINE_HOVER_HEIGHT = 3.2;

// Shunts open with a readable straight-flight beat, then track strongly
// enough to punish a gentle weave but loosely enough for a committed drift,
// terrain break, or hard perpendicular cut to shed the lock.
export const SHUNT_SPEED = 170;
export const SHUNT_LIFETIME = 5;
export const SHUNT_ACQUIRE_HALF_ANGLE = math.rad(55);
export const SHUNT_GUIDANCE_DELAY = 0.35;
export const SHUNT_TURN_RATE = math.rad(125);
export const SHUNT_BREAK_ANGLE = math.rad(100);
export const SHUNT_BREAK_HOLD = 0.25;
export const SHUNT_PROXIMITY = 9;
export const SHUNT_BLAST_RADIUS = 13;
export const MINE_TRIGGER_RADIUS = 9;

// Projectile attributes let every client draw an exact warning without a
// per-frame remote. Zero means dumbfire/no player target.
export const TARGET_OWNER_ATTR = "TargetOwnerUserId";
export const GUIDANCE_ACTIVE_ATTR = "GuidanceActive";

// Creator Store sound effects. Keeping IDs here makes replacement and volume
// review a single edit instead of burying asset dependencies in FX code.
export const POWERUP_SOUND_IDS = {
	// Pro Sound Effects assets selected for rounded whooshes, electrical texture
	// and debris weight rather than the sharp transient of a firearm recording.
	boltElectric: "rbxassetid://9114247939", // Electricity Static 28
	shuntEnergy: "rbxassetid://9114315242", // Energy Burst Growl 6
	shuntFlight: "rbxassetid://9114428740", // Fireball Pass By 1
	mineFire: "rbxassetid://9114432358", // Fire Burst 11
	debrisImpact: "rbxassetid://9118612665", // Rock Impact 7
	bargeShockwave: "rbxassetid://9120725798", // Whoosh Giant Swish By 8
	shieldLoop: "rbxassetid://9116386389", // Magic Force Field Constant 1
	uiConfirm: "rbxasset://sounds/electronicpingshort.wav",
	warning: "rbxasset://sounds/electronicpingshort.wav",
} as const;

// Attributes stamped on the chassis / car model.
export const NITRO_UNTIL_ATTR = "NitroUntil"; // Workspace.GetServerTimeNow() timestamp
export const SHIELD_UNTIL_ATTR = "ShieldUntil";

// Replication plumbing.
export const REMOTES_FOLDER = "PowerupRemotes";
export const USE_REMOTE = "UsePowerup"; // client -> server: (slotIndex: 1..3, backward: boolean)
// Server-side BindableEvent (in ServerStorage) so bot drivers, which have no
// client, can fire their collected powerups: (car: Model, slotIndex, backward).
export const BOT_USE_EVENT = "BotUsePowerup";
export const KNOCK_REMOTE = "Knock"; // server -> driving client: (chassis, deltaV, angularDeltaV)
export const FEEDBACK_REMOTE = "PowerupFeedback";
export const PICKUPS_FOLDER = "Pickups"; // Workspace folder holding pickup pads
export const FX_FOLDER = "PowerupFx"; // Workspace folder for projectiles/explosions

export interface PowerupImpactFeedback {
	type: "impact" | "shieldBlock";
	role: "victim" | "attacker";
	kind: PowerupType;
	position: Vector3;
	deltaV: Vector3;
	angularDeltaV: Vector3;
	damage: number;
	wrecked: boolean;
}

export interface PowerupHitConfirmFeedback {
	type: "hitConfirm";
	kind: PowerupType;
	position: Vector3;
	damage: number;
	wrecked: boolean;
}

export type PowerupFeedback = PowerupImpactFeedback | PowerupHitConfirmFeedback;

// Encode/decode slot attribute values ("bolt:2" carries remaining charges).
export function encodeSlot(kind: PowerupType, charges?: number) {
	return charges !== undefined ? `${kind}:${charges}` : kind;
}

export function decodeSlot(value: string): { kind: PowerupType; charges?: number } | undefined {
	if (value === "") return undefined;
	const [kind, charges] = value.match("^(%a+):?(%d*)$") as LuaTuple<[string?, string?]>;
	if (kind === undefined) return undefined;
	if (!POWERUP_TYPES.includes(kind as PowerupType)) return undefined;
	const n = charges !== undefined && charges !== "" ? tonumber(charges) : undefined;
	return { kind: kind as PowerupType, charges: n };
}
