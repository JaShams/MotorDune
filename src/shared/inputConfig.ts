// Input bindings and analogue thresholds are shared by every client script
// that presents or consumes controls. Keeping them here prevents the camera,
// weapon rack and driving simulation from quietly disagreeing about a button.
export const CONTROLLER_BINDINGS = {
	accelerate: Enum.KeyCode.ButtonR2,
	brakeReverse: Enum.KeyCode.ButtonL2,
	steer: Enum.KeyCode.Thumbstick1,
	cyclePrimary: Enum.KeyCode.ButtonL1,
	cycleAlternate: Enum.KeyCode.ButtonX,
	fire: Enum.KeyCode.ButtonA,
	handbrake: Enum.KeyCode.ButtonB,
	lookBack: Enum.KeyCode.ButtonR1,
	flipReset: Enum.KeyCode.ButtonY,
	menuToggle: Enum.KeyCode.ButtonSelect,
} as const;

export const CONTROLLER_STICK_DEADZONE = 0.12;
export const CONTROLLER_REAR_FIRE_THRESHOLD = 0.55;

