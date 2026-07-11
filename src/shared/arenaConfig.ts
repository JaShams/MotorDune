// Shared dimensions and deterministic surface profile for the desert arena.
// The playable ground is sampled from groundYAt() by the terrain builder and
// by every system that places objects on it. Keep the profile broad: the car
// suspension should read the landscape, not chatter over high-frequency noise.

export const ARENA_NAME = "Arena";

export const FLOOR_RADIUS = 515;
export const FLOOR_THICKNESS = 8;
export const CANYON_INNER_RADIUS = 570;

export const TRACK_WIDTH = 31.5;
export const TRACK_CENTER_RADIUS = 475;
export const LAKEBED_DEPTH = 52;
// The flat floor begins exactly where the visible salt pan begins. Everything
// outside this radius remains part of the continuous dirt slope into it.
export const LAKEBED_INNER = 130;
export const LAKEBED_OUTER = TRACK_CENTER_RADIUS - TRACK_WIDTH / 2;
export const FLAT_OUTER = TRACK_CENTER_RADIUS + TRACK_WIDTH / 2;
export const BOWL_RIM_RADIUS = 650;
export const BOWL_RIM_HEIGHT = 58;

export const SPAWN_RADIUS = TRACK_CENTER_RADIUS;
export const SPAWN_HEIGHT = 13.5;

const TWO_PI = math.pi * 2;

function smoothstep(t: number) {
	const clamped = math.clamp(t, 0, 1);
	return clamped * clamped * (3 - 2 * clamped);
}

function angleDistance(a: number, b: number) {
	return math.abs(((a - b + math.pi) % TWO_PI) - math.pi);
}

function bell(value: number, radius: number) {
	const n = value / radius;
	return math.exp(-n * n * 2.2);
}

function rotatedBell(x: number, z: number, cx: number, cz: number, angle: number, length: number, width: number) {
	const dx = x - cx;
	const dz = z - cz;
	const along = dx * math.cos(angle) + dz * math.sin(angle);
	const across = -dx * math.sin(angle) + dz * math.cos(angle);
	return bell(along, length) * bell(across, width);
}

// The macro radial crater remains useful for distant scenery where local
// driving features are intentionally absent.
export function groundY(r: number) {
	if (r <= LAKEBED_INNER) return -LAKEBED_DEPTH;
	if (r < LAKEBED_OUTER) {
		return -LAKEBED_DEPTH + 59 * smoothstep((r - LAKEBED_INNER) / (LAKEBED_OUTER - LAKEBED_INNER));
	}
	if (r <= FLAT_OUTER) return 7;
	if (r < BOWL_RIM_RADIUS) {
		return 7 + (BOWL_RIM_HEIGHT - 7) * smoothstep((r - FLAT_OUTER) / (BOWL_RIM_RADIUS - FLAT_OUTER));
	}
	return BOWL_RIM_HEIGHT;
}

// Authoritative driveable surface. Long angular waves give the outer loop
// elevation change; six low saddles make inviting routes into the bowl. The
// fixed bells below form broad rollers, swales, and rounded jump ridges while
// preserving a readable combat area around the derrick.
export function groundYAt(x: number, z: number) {
	const r = math.sqrt(x * x + z * z);
	const angle = math.atan2(z, x);
	let y = groundY(r);

	if (r >= LAKEBED_OUTER - 12 && r <= FLAT_OUTER + 4) {
		const ringBlend = smoothstep((r - (LAKEBED_OUTER - 12)) / 24) * smoothstep((FLAT_OUTER + 4 - r) / 18);
		y += (math.sin(angle * 3 + 0.65) * 2.4 + math.sin(angle * 5 - 1.1) * 1.4) * ringBlend;

		for (const saddleAngle of [0.18, 1.22, 2.18, 3.08, 4.16, 5.25]) {
			const angular = bell(angleDistance(angle, saddleAngle), 0.16);
			const radial = bell(r - (LAKEBED_OUTER + 8), 52);
			y -= angular * radial * 5.5;
		}
	}

	// Bowl rollers and shallow swales: large footprints, modest slopes.
	y += rotatedBell(x, z, -150, 86, 0.35, 92, 46) * 6.5;
	y += rotatedBell(x, z, 170, -72, -0.55, 105, 50) * 5.5;
	y += rotatedBell(x, z, 62, 205, 1.05, 82, 42) * 4.5;
	y -= rotatedBell(x, z, -78, -198, -0.25, 100, 55) * 4;
	y -= rotatedBell(x, z, 230, 120, 0.7, 85, 48) * 3.5;

	// Rounded transverse ridges. Their long axis is perpendicular to the main
	// approach, so the centre can launch a fast car while either end is a bypass.
	y += rotatedBell(x, z, -285, 25, 1.42, 75, 18) * 9;
	y += rotatedBell(x, z, 265, -42, 1.72, 72, 19) * 8.5;
	y += rotatedBell(x, z, 38, 326, 0.08, 68, 18) * 8;
	y += rotatedBell(x, z, -38, -336, -0.12, 70, 18) * 8.5;

	// Keep the derrick pad and immediate brawl focus level and predictable.
	const centreBlend = smoothstep((r - 34) / 42);
	y = -LAKEBED_DEPTH + (y + LAKEBED_DEPTH) * centreBlend;
	return y;
}
