import { groundYAt, SPAWN_RADIUS } from "shared/arenaConfig";

export const CAR_NAME = "Car";
export const CHASSIS_NAME = "Chassis";
export const SEAT_NAME = "Seat";

// Sized to the buggy body shell at its native scale (the model was authored
// for Roblox avatars, so the driver sits in proportion): box a touch inside
// the visual hull so rams connect where the bodywork appears to.
export const CHASSIS_SIZE = new Vector3(9, 1.5, 16);

// Spawn on the outer loop, nose pointed tangentially. The analytic height
// matches the voxel surface; groundedSpawnCFrame performs the final raycast.
const SPAWN_POS = new Vector3(0, groundYAt(0, SPAWN_RADIUS) + 5.5, SPAWN_RADIUS);
export const SPAWN_CFRAME = CFrame.lookAt(SPAWN_POS, SPAWN_POS.add(new Vector3(1, 0, 0)));

// Match the shell's tyres (native diameter 3.72) and its axle positions, so
// the cosmetic wheels fill the fender openings.
export const WHEEL_RADIUS = 1.85;
export const WHEEL_WIDTH = 1.4;

export const WHEEL_OFFSETS = [
	new Vector3(-4.52, -0.25, -5.55),
	new Vector3(4.52, -0.25, -5.55),
	new Vector3(-4.52, -0.25, 5.55),
	new Vector3(4.52, -0.25, 5.55),
];

export const WHEEL_NAMES = ["WheelFL", "WheelFR", "WheelRL", "WheelRR"];

// Suspension travel. Shared by the physics (carClient) and the wheel visuals
// (wheelVisuals), which re-runs the same spherecast to place each wheel.
export const SUSPENSION_LENGTH = 4;

// Steering geometry, shared the same way so the visible front wheels turn by
// exactly the angle the physics is using.
export const MAX_STEER_ANGLE = math.rad(34);
// Lateral-g steering cap (see carClient): lock = atan(cap * wheelbase / v^2).
export const STEER_MAX_LAT_ACCEL = 290;
export const WHEELBASE = WHEEL_OFFSETS[2].Z - WHEEL_OFFSETS[0].Z;

// Per-wheel force actuator names (VectorForce + its attachment, parented to the
// chassis). The server creates them; the client drives them every physics step.
export const wheelForceName = (wheelName: string) => `${wheelName}Force`;
export const wheelForceAttachmentName = (wheelName: string) => `${wheelName}ForceAtt`;
