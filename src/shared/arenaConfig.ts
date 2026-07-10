// Shared dimensions for the desert demolition arena.
// The dirt floor's TOP surface sits at Y = 0, so things resting on the
// ground use positive Y. Everything is centered on the world origin.

export const ARENA_NAME = "Arena";

// Radius of the flat, driveable dirt pit.
export const FLOOR_RADIUS = 480;
export const FLOOR_THICKNESS = 8;

// Where the canyon rock formations begin (outside the pit).
export const CANYON_INNER_RADIUS = 540;

// Car spawn: on the flat outer track ring (track is 24 studs wide, so the
// middle of it sits ~12 studs in from the rim), facing along the track.
export const SPAWN_RADIUS = FLOOR_RADIUS - 12;
export const SPAWN_HEIGHT = 4.25;

// Crater profile: flat racing track ring around the circumference with the
// interior dipping into a dry-lake-bed basin, and the terrain outside the
// track climbing to a high rim. Shared so anything placed on the ground
// (arena dressing, powerup pads) agrees on heights without having to raycast
// terrain that may still be mid-carve.
export const TRACK_WIDTH = 24; // width of the flat outer track ring
export const LAKEBED_DEPTH = 14; // how far the basin floor dips below the track
export const LAKEBED_OUTER = FLOOR_RADIUS - TRACK_WIDTH; // bank starts at the track's inner edge
export const LAKEBED_INNER = LAKEBED_OUTER - 76; // wide flat salt-pan bottom begins here
export const FLAT_OUTER = FLOOR_RADIUS + 20; // the flat shelf around the track ends here
export const BOWL_RIM_RADIUS = CANYON_INNER_RADIUS + 80; // the bowl slope tops out here
export const BOWL_RIM_HEIGHT = 58; // how high the crater sides climb above the track

// Ground height at a given distance from the centre — the full crater
// profile: salt pan (lowest) → basin slope → flat track shelf → bowl sides
// sweeping up to the rim.
export function groundY(r: number) {
	if (r <= LAKEBED_INNER) return -LAKEBED_DEPTH;
	if (r < LAKEBED_OUTER) {
		const f = (LAKEBED_OUTER - r) / (LAKEBED_OUTER - LAKEBED_INNER);
		return -LAKEBED_DEPTH * f;
	}
	if (r <= FLAT_OUTER) return 0;
	if (r < BOWL_RIM_RADIUS) {
		const t = (r - FLAT_OUTER) / (BOWL_RIM_RADIUS - FLAT_OUTER);
		const s = t * t * (3 - 2 * t); // smoothstep, so the bowl curves instead of coning
		return BOWL_RIM_HEIGHT * s;
	}
	return BOWL_RIM_HEIGHT;
}
