import { Players, RunService, Workspace } from "@rbxts/services";
import { CAR_NAME, SPAWN_CFRAME } from "shared/carConfig";
import { createCarSim } from "shared/carSim";
import { HEALTH_ATTR } from "shared/healthConfig";
import { buildCar, groundedSpawnCFrame, keepInWorld, waitForArenaReady } from "./carFactory";

// The player's car. The car assembly itself comes from the shared factory
// (carFactory, also used for bots); this script's own job is network
// ownership: the driver's client runs the simulation (shared/carSim), so the
// occupant must own the chassis assembly.

function setDriverOwner(seat: VehicleSeat, chassis: BasePart) {
	const humanoid = seat.Occupant;
	const character = humanoid?.Parent;
	const player = character ? Players.GetPlayerFromCharacter(character) : undefined;

	if (player) {
		chassis.SetNetworkOwner(player);
	} else {
		chassis.SetNetworkOwner(undefined);
	}
}

const waited = waitForArenaReady();
print(`[car] ArenaReady=${Workspace.GetAttribute("ArenaReady")} after ${"%.1f".format(waited)}s`);

const { car, chassis, seat } = buildCar({ name: CAR_NAME, spawnCFrame: groundedSpawnCFrame(SPAWN_CFRAME) });

print(`[car] spawned at ${chassis.Position}`);
chassis.AncestryChanged.Connect(() => {
	if (!chassis.IsDescendantOf(game)) {
		warn(`[car] chassis REMOVED from game (last position ${chassis.Position})`);
	}
});

keepInWorld(chassis, () => groundedSpawnCFrame(SPAWN_CFRAME));

// Keep the player behind the wheel at all times: seat them as soon as their
// character spawns and put them straight back if anything unseats them (the
// driver's client also disables jump-exits; this is the server backstop for
// flings, resets and respawns). Derby cars don't have doors.
function trySeatSomeone() {
	if (seat.Occupant !== undefined || seat.Disabled) return;
	for (const player of Players.GetPlayers()) {
		const character = player.Character;
		const humanoid = character?.FindFirstChildOfClass("Humanoid");
		if (!character || !humanoid || humanoid.Health <= 0) continue;
		if (humanoid.SeatPart !== undefined) continue;
		character.PivotTo(seat.CFrame.mul(new CFrame(0, 3, 0)));
		seat.Sit(humanoid);
		break;
	}
}

function watchPlayer(player: Player) {
	const onCharacter = (character: Model) => {
		task.spawn(() => {
			character.WaitForChild("Humanoid", 10);
			task.wait(0.2); // let the character finish assembling before the weld
			trySeatSomeone();
		});
	};
	if (player.Character !== undefined) onCharacter(player.Character);
	player.CharacterAdded.Connect(onCharacter);
}

Players.PlayerAdded.Connect(watchPlayer);
for (const player of Players.GetPlayers()) watchPlayer(player);

setDriverOwner(seat, chassis);
seat.GetPropertyChangedSignal("Occupant").Connect(() => {
	setDriverOwner(seat, chassis);
	if (seat.Occupant === undefined) {
		// Small delay: an instant re-sit can race the jump/exit that emptied
		// the seat and silently fail.
		task.delay(0.5, trySeatSomeone);
	}
});

// Idle suspension. The drive sim runs on the occupant's client, so an empty
// car applies no wheel forces and rests on its collider box - which buries
// the body shell (the shell is aligned to the suspension's rest stance, ~4.9
// studs above the box's resting height). While the seat is empty the server
// owns the chassis and steps the same sim with centred inputs so the car
// stands on its wheels; the moment someone sits, their client takes over the
// same force actuators. A wrecked car (health 0) gets no input on purpose so
// it flops, matching dead bots.
const idleSim = createCarSim(car, chassis);
const idleInput = { throttle: 0, steer: 0, handbrake: false };
RunService.PreSimulation.Connect((dt) => {
	if (seat.Occupant !== undefined) return;
	const health = (car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? 1;
	idleSim.step(dt, health > 0 ? idleInput : undefined);
});
