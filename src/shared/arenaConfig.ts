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
