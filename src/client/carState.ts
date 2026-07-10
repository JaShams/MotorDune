// Live handoff from the driving simulation (carClient) to presentation
// scripts on the same client (wheel visuals, HUD). Remote clients - everyone
// who isn't driving this car - never see this state; they rebuild
// approximations from replicated data instead (chassis velocity, the
// VehicleSeat's mirrored Steer input).
export const localDrive = {
	driving: false,
	steerAngle: 0, // radians, positive = left (matches the physics convention)
	throttle: 0, // smoothed throttle, -1..1
	handbrake: false,
	// Per-wheel wheelspin 0..1, indices per WHEEL_OFFSETS. carClient replaces
	// this with its sim's live array at boot; visuals only read it.
	wheelSpin: [0, 0, 0, 0],
};
