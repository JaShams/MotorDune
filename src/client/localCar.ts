import { Players, Workspace } from "@rbxts/services";
import { CHASSIS_NAME, SEAT_NAME } from "shared/carConfig";
import { OWNER_USER_ID_ATTR } from "shared/sessionConfig";

export interface LocalCar {
	car: Model;
	chassis: BasePart;
	seat: VehicleSeat;
}

function findLocalCar() {
	const userId = Players.LocalPlayer.UserId;
	for (const child of Workspace.GetChildren()) {
		if (!child.IsA("Model") || child.GetAttribute(OWNER_USER_ID_ATTR) !== userId) continue;
		const chassis = child.FindFirstChild(CHASSIS_NAME);
		const seat = child.FindFirstChild(SEAT_NAME);
		if (chassis?.IsA("BasePart") && seat?.IsA("VehicleSeat")) return { car: child, chassis, seat };
	}
}

export function waitForLocalCar(): LocalCar {
	const existing = findLocalCar();
	if (existing) return existing;
	while (true) {
		Workspace.ChildAdded.Wait();
		const found = findLocalCar();
		if (found) return found;
	}
}
