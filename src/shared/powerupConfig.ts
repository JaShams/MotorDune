// Blur-style power-up system shared config (see concept/Blur video).
// Cars hold up to 3 power-ups, stored as string attributes on the car model
// ("Slot1".."Slot3"). Bolt slots carry charges, encoded as "bolt:3".

export type PowerupType = "shield" | "bolt" | "shunt" | "nitro" | "mine" | "barge";

export const POWERUP_TYPES: ReadonlyArray<PowerupType> = ["shield", "bolt", "shunt", "nitro", "mine", "barge"];

export interface PowerupInfo {
	color: Color3;
	emoji: string;
	label: string;
	/** Can the player choose to fire it backwards? */
	directional: boolean;
}

export const POWERUP_INFO: Record<PowerupType, PowerupInfo> = {
	shield: { color: Color3.fromRGB(80, 220, 255), emoji: "🛡️", label: "Shield", directional: false },
	bolt: { color: Color3.fromRGB(255, 70, 70), emoji: "⚡", label: "Bolt", directional: true },
	shunt: { color: Color3.fromRGB(255, 160, 40), emoji: "🚀", label: "Shunt", directional: true },
	nitro: { color: Color3.fromRGB(190, 90, 255), emoji: "🔥", label: "Nitro", directional: false },
	mine: { color: Color3.fromRGB(255, 220, 60), emoji: "💣", label: "Mine", directional: true },
	barge: { color: Color3.fromRGB(70, 120, 255), emoji: "💥", label: "Barge", directional: false },
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
export const PICKUPS_FOLDER = "Pickups"; // Workspace folder holding pickup pads
export const FX_FOLDER = "PowerupFx"; // Workspace folder for projectiles/explosions

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
