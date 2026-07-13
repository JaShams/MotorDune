import { Players, RunService, Workspace } from "@rbxts/services";
import { SPAWN_HEIGHT, SPAWN_RADIUS } from "shared/arenaConfig";
import { createCarSim } from "shared/carSim";
import { HEALTH_ATTR } from "shared/healthConfig";
import { MAX_PLAYERS, OWNER_USER_ID_ATTR, SKIN_ID_ATTR, skinColor } from "shared/sessionConfig";
import { recordSeated } from "./analytics";
import { buildCar, groundedSpawnCFrame, keepInWorld, waitForArenaReady } from "./carFactory";

interface PlayerCar {
	player: Player;
	car: Model;
	chassis: BasePart;
	seat: VehicleSeat;
	idleSim: ReturnType<typeof createCarSim>;
	spawn: CFrame;
}

const playerCars = new Map<Player, PlayerCar>();
const playerSlots = new Map<Player, number>();

function allocateSlot() {
	for (let slot = 0; slot < MAX_PLAYERS; slot++) {
		let used = false;
		for (const [, assigned] of playerSlots) if (assigned === slot) used = true;
		if (!used) return slot;
	}
	return 0;
}

function ringSpawn(index: number) {
	const angle = (index / MAX_PLAYERS) * math.pi * 2;
	const pos = new Vector3(math.sin(angle) * SPAWN_RADIUS, SPAWN_HEIGHT, math.cos(angle) * SPAWN_RADIUS);
	const tangent = new Vector3(math.cos(angle), 0, -math.sin(angle));
	return groundedSpawnCFrame(CFrame.lookAt(pos, pos.add(tangent)));
}

function setOwner(entry: PlayerCar) {
	// Occupant can change while Roblox tears the model down during a server
	// shutdown. Network-ownership APIs reject parts that have already left
	// Workspace, so the late signal has nothing left to normalise.
	if (!entry.chassis.IsDescendantOf(Workspace)) return;
	const character = entry.seat.Occupant?.Parent;
	const driver = character ? Players.GetPlayerFromCharacter(character) : undefined;
	entry.chassis.SetNetworkOwner(driver === entry.player ? entry.player : undefined);
	if (driver === entry.player) recordSeated(entry.player);
}

function seatPlayer(entry: PlayerCar) {
	if (entry.seat.Occupant !== undefined || entry.seat.Disabled) return;
	const character = entry.player.Character;
	const humanoid = character?.FindFirstChildOfClass("Humanoid");
	if (!character || !humanoid || humanoid.Health <= 0) return;
	character.PivotTo(entry.seat.CFrame.mul(new CFrame(0, 3, 0)));
	entry.seat.Sit(humanoid);
}

function selectedSkin(player: Player) {
	const data = player.GetJoinData().TeleportData;
	if (typeIs(data, "table")) {
		const id = (data as { skinId?: unknown }).skinId;
		if (typeIs(id, "string")) return id;
	}
	return "red";
}

function addPlayer(player: Player) {
	if (playerCars.has(player)) return;
	const slot = allocateSlot();
	playerSlots.set(player, slot);
	const spawn = ringSpawn(slot);
	const skinId = selectedSkin(player);
	const built = buildCar({ name: `Car_${player.UserId}`, spawnCFrame: spawn, color: skinColor(skinId) });
	built.car.SetAttribute(OWNER_USER_ID_ATTR, player.UserId);
	built.car.SetAttribute(SKIN_ID_ATTR, skinId);
	const entry: PlayerCar = { player, ...built, idleSim: createCarSim(built.car, built.chassis), spawn };
	playerCars.set(player, entry);
	keepInWorld(built.chassis, () => spawn);
	built.seat.GetPropertyChangedSignal("Occupant").Connect(() => {
		setOwner(entry);
		if (built.seat.Occupant === undefined) task.delay(0.5, () => seatPlayer(entry));
	});
	const onCharacter = () => task.delay(0.25, () => seatPlayer(entry));
	player.CharacterAdded.Connect(onCharacter);
	if (player.Character) onCharacter();
	print(`[car] spawned ${built.car.Name} for ${player.Name}`);
}

waitForArenaReady();
Players.PlayerAdded.Connect(addPlayer);
Players.PlayerRemoving.Connect((player) => {
	const entry = playerCars.get(player);
	if (entry) entry.car.Destroy();
	playerCars.delete(player);
	playerSlots.delete(player);
});
for (const player of Players.GetPlayers()) addPlayer(player);

const idleInput = { throttle: 0, steer: 0, handbrake: false };
RunService.PreSimulation.Connect((dt) => {
	for (const [, entry] of playerCars) {
		if (entry.seat.Occupant !== undefined) continue;
		const health = (entry.car.GetAttribute(HEALTH_ATTR) as number | undefined) ?? 1;
		entry.idleSim.step(dt, health > 0 ? idleInput : undefined);
	}
});
