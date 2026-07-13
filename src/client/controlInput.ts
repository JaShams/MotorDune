import { GuiService, UserInputService } from "@rbxts/services";
import {
	CONTROLLER_BINDINGS,
	CONTROLLER_REAR_FIRE_THRESHOLD,
	CONTROLLER_STICK_DEADZONE,
} from "shared/inputConfig";
import { CarDriveInput } from "shared/carSim";

// One client-local input source feeds driving, weapons, camera and menus. Raw
// gamepad events are deliberately centralised: two ContextActionService binds
// for Thumbstick1 would replace each other, while independent UIS listeners
// tend to disagree about modal blocking and device changes.

export type InputScheme = "keyboard" | "gamepad";
export type DirectSlot = 1 | 2 | 3;

type Listener<T extends unknown[] = []> = (...args: T) => void;

const fireListeners = new Set<Listener<[DirectSlot | undefined]>>();
const cycleListeners = new Set<Listener>();
const resetListeners = new Set<Listener>();
const menuToggleListeners = new Set<Listener>();
const menuCancelListeners = new Set<Listener>();
const schemeListeners = new Set<Listener<[InputScheme]>>();

function subscribe<T extends unknown[]>(listeners: Set<Listener<T>>, listener: Listener<T>) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function emit<T extends unknown[]>(listeners: Set<Listener<T>>, ...args: T) {
	for (const listener of listeners) listener(...args);
}

let gameplayBlocked = false;
let wDown = false;
let sDown = false;
let aDown = false;
let dDown = false;
let cDown = false;
let shiftDown = false;
let controlDown = false;
let controllerThrottle = 0;
let controllerBrake = 0;
let controllerStick = Vector2.zero;
let controllerHandbrake = false;
let controllerLookBack = false;

function preferredScheme(): InputScheme {
	return UserInputService.PreferredInput === Enum.PreferredInput.Gamepad ? "gamepad" : "keyboard";
}

let currentScheme = preferredScheme();

function rescaleDeadzone(value: number) {
	const magnitude = math.abs(value);
	if (magnitude <= CONTROLLER_STICK_DEADZONE) return 0;
	return math.sign(value) * ((magnitude - CONTROLLER_STICK_DEADZONE) / (1 - CONTROLLER_STICK_DEADZONE));
}

function setKeyboardHeld(key: Enum.KeyCode, held: boolean) {
	if (key === Enum.KeyCode.W) wDown = held;
	if (key === Enum.KeyCode.S) sDown = held;
	if (key === Enum.KeyCode.A) aDown = held;
	if (key === Enum.KeyCode.D) dDown = held;
	if (key === Enum.KeyCode.C) cDown = held;
	if (key === Enum.KeyCode.LeftShift || key === Enum.KeyCode.RightShift) shiftDown = held;
	if (key === Enum.KeyCode.LeftControl || key === Enum.KeyCode.RightControl) controlDown = held;
}

function isGamepadInput(input: InputObject) {
	return string.sub(input.UserInputType.Name, 1, 7) === "Gamepad";
}

UserInputService.InputBegan.Connect((input) => {
	const key = input.KeyCode;
	const gamepadInput = isGamepadInput(input);
	const gameplayAvailable =
		!gameplayBlocked && !GuiService.MenuIsOpen && UserInputService.GetFocusedTextBox() === undefined;
	// Roblox's default character/seat controls can mark both WASD and gamepad
	// face buttons processed before this custom vehicle sees them. Modal and
	// text focus are the real boundary, so gameplay input is accepted whenever
	// those explicit blockers are absent.
	if (gameplayAvailable) {
		if (!gamepadInput) setKeyboardHeld(key, true);
		if (key === Enum.KeyCode.One) emit(fireListeners, 1);
		if (key === Enum.KeyCode.Two) emit(fireListeners, 2);
		if (key === Enum.KeyCode.Three) emit(fireListeners, 3);
		if (key === Enum.KeyCode.R) emit(resetListeners);

		if (gamepadInput) {
			if (key === CONTROLLER_BINDINGS.handbrake) controllerHandbrake = true;
			if (key === CONTROLLER_BINDINGS.lookBack) controllerLookBack = true;
			if (key === CONTROLLER_BINDINGS.fire) emit(fireListeners, undefined);
			if (key === CONTROLLER_BINDINGS.cyclePrimary || key === CONTROLLER_BINDINGS.cycleAlternate) {
				emit(cycleListeners);
			}
			if (key === CONTROLLER_BINDINGS.flipReset) emit(resetListeners);
		}
	}

	// Menu actions remain available while gameplay is blocked. Session UI
	// decides whether B has anything to cancel.
	if (gamepadInput && !GuiService.MenuIsOpen) {
		if (key === CONTROLLER_BINDINGS.menuToggle) emit(menuToggleListeners);
		if (key === CONTROLLER_BINDINGS.handbrake) emit(menuCancelListeners);
	}
});

UserInputService.InputChanged.Connect((input) => {
	if (!isGamepadInput(input)) return;
	if (input.KeyCode === CONTROLLER_BINDINGS.steer) {
		controllerStick = new Vector2(input.Position.X, input.Position.Y);
	}
	if (input.KeyCode === CONTROLLER_BINDINGS.accelerate) controllerThrottle = math.clamp(input.Position.Z, 0, 1);
	if (input.KeyCode === CONTROLLER_BINDINGS.brakeReverse) controllerBrake = math.clamp(input.Position.Z, 0, 1);
});

UserInputService.InputEnded.Connect((input) => {
	const key = input.KeyCode;
	setKeyboardHeld(key, false);
	if (!isGamepadInput(input)) return;
	if (key === CONTROLLER_BINDINGS.handbrake) controllerHandbrake = false;
	if (key === CONTROLLER_BINDINGS.lookBack) controllerLookBack = false;
	if (key === CONTROLLER_BINDINGS.accelerate) controllerThrottle = 0;
	if (key === CONTROLLER_BINDINGS.brakeReverse) controllerBrake = 0;
});

UserInputService.GamepadDisconnected.Connect(() => {
	controllerThrottle = 0;
	controllerBrake = 0;
	controllerStick = Vector2.zero;
	controllerHandbrake = false;
	controllerLookBack = false;
});

UserInputService.GetPropertyChangedSignal("PreferredInput").Connect(() => {
	const nextScheme = preferredScheme();
	if (nextScheme === currentScheme) return;
	currentScheme = nextScheme;
	emit(schemeListeners, nextScheme);
});

export function getInputScheme() {
	return currentScheme;
}

export function isGameplayInputBlocked() {
	return gameplayBlocked || GuiService.MenuIsOpen || UserInputService.GetFocusedTextBox() !== undefined;
}

export function getDriveInput(): CarDriveInput {
	if (isGameplayInputBlocked()) {
		return { throttle: 0, steer: 0, handbrake: false };
	}
	if (currentScheme === "gamepad") {
		return {
			throttle: controllerThrottle - controllerBrake,
			// Roblox stick X is positive right; carSim is positive left.
			steer: -rescaleDeadzone(controllerStick.X),
			handbrake: controllerHandbrake,
		};
	}
	return {
		throttle: (wDown ? 1 : 0) + (sDown ? -1 : 0),
		steer: (aDown ? 1 : 0) + (dDown ? -1 : 0),
		handbrake: shiftDown,
	};
}

export function isLookBackHeld() {
	if (isGameplayInputBlocked()) return false;
	return currentScheme === "gamepad" ? controllerLookBack : cDown;
}

export function isRearFireHeld() {
	if (isGameplayInputBlocked()) return false;
	// Thumbstick Position.Y is positive up and negative down.
	return currentScheme === "gamepad" ? controllerStick.Y <= -CONTROLLER_REAR_FIRE_THRESHOLD : controlDown;
}

export function setGameplayInputBlocked(blocked: boolean) {
	gameplayBlocked = blocked;
	if (blocked) {
		controllerHandbrake = false;
		controllerLookBack = false;
		shiftDown = false;
		controlDown = false;
	}
}

export function onFireRequested(listener: Listener<[DirectSlot | undefined]>) {
	return subscribe(fireListeners, listener);
}

export function onCyclePowerupRequested(listener: Listener) {
	return subscribe(cycleListeners, listener);
}

export function onFlipResetRequested(listener: Listener) {
	return subscribe(resetListeners, listener);
}

export function onMenuToggleRequested(listener: Listener) {
	return subscribe(menuToggleListeners, listener);
}

export function onMenuCancelRequested(listener: Listener) {
	return subscribe(menuCancelListeners, listener);
}

export function onInputSchemeChanged(listener: Listener<[InputScheme]>) {
	return subscribe(schemeListeners, listener);
}

export function controllerButtonLabel(key: Enum.KeyCode) {
	const platformLabel = UserInputService.GetStringForKeyCode(key);
	const label = platformLabel !== "" ? platformLabel : key.Name;
	return label.gsub("Button", "")[0];
}

export function controllerButtonImage(key: Enum.KeyCode) {
	return UserInputService.GetImageForKeyCode(key);
}
