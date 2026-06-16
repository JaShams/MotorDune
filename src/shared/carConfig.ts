import { SPAWN_HEIGHT, SPAWN_RADIUS } from "shared/arenaConfig";

export const CAR_NAME = "Car";
export const CHASSIS_NAME = "Chassis";
export const SEAT_NAME = "Seat";

export const CHASSIS_SIZE = new Vector3(6, 1, 10);

// Spawn on the flat outer track ring, nose pointed along the track (tangent).
const SPAWN_POS = new Vector3(0, SPAWN_HEIGHT, SPAWN_RADIUS);
export const SPAWN_CFRAME = CFrame.lookAt(SPAWN_POS, SPAWN_POS.add(new Vector3(1, 0, 0)));

export const WHEEL_RADIUS = 1;
export const WHEEL_WIDTH = 0.65;

export const WHEEL_OFFSETS = [
	new Vector3(-2.6, -0.25, -3.35),
	new Vector3(2.6, -0.25, -3.35),
	new Vector3(-2.6, -0.25, 3.35),
	new Vector3(2.6, -0.25, 3.35),
];

export const WHEEL_NAMES = ["WheelFL", "WheelFR", "WheelRL", "WheelRR"];
