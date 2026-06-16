import { Lighting, Workspace } from "@rbxts/services";
import { ARENA_NAME, CANYON_INNER_RADIUS, FLOOR_RADIUS } from "shared/arenaConfig";
import { SPAWN_CFRAME } from "shared/carConfig";

// Flat racing track ring around the circumference (~2-3 cars wide; a car is
// 6 studs wide), with the entire interior as one wide dry-lake-bed basin.
const TRACK_WIDTH = 24; // width of the flat outer track ring
const LAKEBED_DEPTH = 14; // how far the basin floor dips below the track
const LAKEBED_OUTER = FLOOR_RADIUS - TRACK_WIDTH; // bank starts at the track's inner edge
const LAKEBED_INNER = LAKEBED_OUTER - 76; // wide flat salt-pan bottom begins here
const GROUND_RADIUS = CANYON_INNER_RADIUS + 90; // terrain extends under the canyon

// ---------------------------------------------------------------------------
// Deterministic pseudo-random helpers (so the arena looks the same every run).
// ---------------------------------------------------------------------------
let seed = 1337;
function rand() {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
}
function range(min: number, max: number) {
	return min + (max - min) * rand();
}

const TWO_PI = math.pi * 2;

// ---------------------------------------------------------------------------
// Part helpers.
// ---------------------------------------------------------------------------
interface PartOptions {
	size: Vector3;
	cframe: CFrame;
	color: Color3;
	material: Enum.Material;
	shape?: Enum.PartType;
	transparency?: number;
	name?: string;
}

function makePart(parent: Instance, opts: PartOptions) {
	const part = new Instance("Part");
	part.Name = opts.name ?? "ArenaPart";
	part.Anchored = true;
	part.CanCollide = true;
	part.Size = opts.size;
	part.CFrame = opts.cframe;
	part.Color = opts.color;
	part.Material = opts.material;
	part.Transparency = opts.transparency ?? 0;
	if (opts.shape !== undefined) part.Shape = opts.shape;
	part.TopSurface = Enum.SurfaceType.Smooth;
	part.BottomSurface = Enum.SurfaceType.Smooth;
	part.Parent = parent;
	return part;
}

// ---------------------------------------------------------------------------
// Colour palette.
// ---------------------------------------------------------------------------
const DIRT = Color3.fromRGB(156, 113, 75);
const DIRT_DARK = Color3.fromRGB(120, 84, 53);
const ROCK = Color3.fromRGB(124, 66, 47);
const ROCK_DARK = Color3.fromRGB(96, 50, 38);
const METAL_DARK = Color3.fromRGB(48, 46, 52);
const DERRICK_RED = Color3.fromRGB(168, 52, 42);
const SIGN_BACK = Color3.fromRGB(28, 24, 22);

// ===========================================================================
// Lighting: dusk over the desert.
// ===========================================================================
function setupLighting() {
	Lighting.ClockTime = 18.1;
	Lighting.GeographicLatitude = 12;
	Lighting.Brightness = 2;
	Lighting.ExposureCompensation = 0.15;
	Lighting.OutdoorAmbient = Color3.fromRGB(82, 66, 70);
	Lighting.Ambient = Color3.fromRGB(40, 34, 38);
	Lighting.FogColor = Color3.fromRGB(72, 54, 58);
	Lighting.FogStart = 200;
	Lighting.FogEnd = 1600;

	const old = Lighting.FindFirstChild("ArenaAtmosphere");
	if (old) old.Destroy();
	const atmosphere = new Instance("Atmosphere");
	atmosphere.Name = "ArenaAtmosphere";
	atmosphere.Density = 0.38;
	atmosphere.Offset = 0.2;
	atmosphere.Color = Color3.fromRGB(199, 170, 140);
	atmosphere.Decay = Color3.fromRGB(106, 72, 64);
	atmosphere.Glare = 0.45;
	atmosphere.Haze = 2.4;
	atmosphere.Parent = Lighting;

	const oldCc = Lighting.FindFirstChild("ArenaColor");
	if (oldCc) oldCc.Destroy();
	const cc = new Instance("ColorCorrectionEffect");
	cc.Name = "ArenaColor";
	cc.Brightness = 0;
	cc.Contrast = 0.12;
	cc.Saturation = 0.1;
	cc.TintColor = Color3.fromRGB(255, 236, 214);
	cc.Parent = Lighting;

	const oldBloom = Lighting.FindFirstChild("ArenaBloom");
	if (oldBloom) oldBloom.Destroy();
	const bloom = new Instance("BloomEffect");
	bloom.Name = "ArenaBloom";
	bloom.Intensity = 0.9;
	bloom.Size = 24;
	bloom.Threshold = 1.1;
	bloom.Parent = Lighting;
}

// ===========================================================================
// Terrain ground: a flat dirt plateau with a gentle, smooth dry-lake-bed
// basin carved into the centre and a pale salt-pan floor at the bottom.
// ===========================================================================
function buildGround() {
	const terrain = Workspace.Terrain;

	// Tint the terrain materials to match the warm desert palette.
	terrain.SetMaterialColor(Enum.Material.Ground, Color3.fromRGB(150, 110, 72));
	terrain.SetMaterialColor(Enum.Material.Salt, Color3.fromRGB(208, 198, 172));

	// Reset the region so re-runs don't stack old terrain.
	terrain.FillCylinder(new CFrame(0, 0, 0), 90, GROUND_RADIUS + 10, Enum.Material.Air);

	// Flat dirt plateau, top surface at Y = 0.
	terrain.FillCylinder(new CFrame(0, -20, 0), 40, GROUND_RADIUS, Enum.Material.Ground);

	// Solid ground now exists everywhere the car could spawn — let it spawn.
	// (Done here, before the more failure-prone basin/recolour steps below, so
	// a later terrain error can never strand the car.)
	Workspace.SetAttribute("ArenaReady", true);

	// Carve the basin: a stack of shrinking Air cylinders forms a gentle cone
	// from the plateau (Y = 0 at LAKEBED_OUTER) down to a flat bottom
	// (Y = -LAKEBED_DEPTH inside LAKEBED_INNER). Terrain smoothing rounds it.
	const steps = 18;
	for (let i = 1; i <= steps; i++) {
		const f = i / steps;
		const radius = LAKEBED_OUTER - (LAKEBED_OUTER - LAKEBED_INNER) * f;
		const depth = LAKEBED_DEPTH * f;
		terrain.FillCylinder(new CFrame(0, -depth / 2, 0), depth, radius, Enum.Material.Air);
	}

	// Recolour the flat salt-pan bottom. ReplaceMaterial requires a region whose
	// min/max are multiples of 4, so expand it to the voxel grid; guard with
	// pcall so a bad region can never abort the rest of the arena build.
	const b = LAKEBED_INNER + 8;
	const region = new Region3(
		new Vector3(-b, -LAKEBED_DEPTH - 6, -b),
		new Vector3(b, -LAKEBED_DEPTH + 6, b),
	).ExpandToGrid(4);
	pcall(() => terrain.ReplaceMaterial(region, 4, Enum.Material.Ground, Enum.Material.Salt));
}

// ===========================================================================
// Raised dirt berm around the rim of the pit.
// ===========================================================================
function buildBerm(arena: Model) {
	// Raised dirt berm: a ring of tilted blocks hugging the rim.
	const bermCount = math.floor((TWO_PI * (FLOOR_RADIUS + 6)) / 22);
	for (let i = 0; i < bermCount; i++) {
		const a = (i / bermCount) * TWO_PI;
		const r = FLOOR_RADIUS + 6;
		const pos = new Vector3(math.cos(a) * r, range(3, 6), math.sin(a) * r);
		const cf = CFrame.lookAt(pos, new Vector3(0, pos.Y, 0)).mul(
			CFrame.Angles(math.rad(range(18, 30)), 0, 0),
		);
		makePart(arena, {
			name: "Berm",
			size: new Vector3(range(26, 34), range(8, 14), range(14, 22)),
			cframe: cf,
			color: i % 2 === 0 ? DIRT_DARK : DIRT,
			material: Enum.Material.Ground,
		});
	}
}

// ===========================================================================
// Red canyon walls ringing the whole arena.
// ===========================================================================
function buildCanyon(arena: Model) {
	const formations = math.floor((TWO_PI * CANYON_INNER_RADIUS) / 34);
	for (let i = 0; i < formations; i++) {
		const a = (i / formations) * TWO_PI + range(-0.03, 0.03);
		const r = CANYON_INNER_RADIUS + range(0, 70);
		const height = range(70, 170);
		const pos = new Vector3(math.cos(a) * r, height / 2 - 6, math.sin(a) * r);
		const cf = CFrame.lookAt(pos, new Vector3(0, pos.Y, 0)).mul(
			CFrame.Angles(range(-0.05, 0.05), 0, range(-0.08, 0.08)),
		);
		makePart(arena, {
			name: "Canyon",
			size: new Vector3(range(70, 130), height, range(60, 110)),
			cframe: cf,
			color: i % 3 === 0 ? ROCK_DARK : ROCK,
			material: Enum.Material.Rock,
		});

		// A few smaller boulders at the base for silhouette variety.
		if (i % 2 === 0) {
			const br = CANYON_INNER_RADIUS - range(6, 22);
			const bpos = new Vector3(math.cos(a) * br, range(4, 10), math.sin(a) * br);
			makePart(arena, {
				name: "Boulder",
				size: new Vector3(range(18, 34), range(14, 26), range(18, 34)),
				cframe: new CFrame(bpos).mul(CFrame.Angles(range(0, 1), range(0, 6), range(0, 1))),
				color: ROCK_DARK,
				material: Enum.Material.Rock,
			});
		}
	}
}

// ===========================================================================
// Inner retaining barrier (low concrete wall that keeps cars in the pit).
// ===========================================================================
function buildBarrier(arena: Model) {
	const segments = math.floor((TWO_PI * (FLOOR_RADIUS - 3)) / 17);
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * TWO_PI;
		const r = FLOOR_RADIUS - 3;
		const pos = new Vector3(math.cos(a) * r, 3, math.sin(a) * r);
		makePart(arena, {
			name: "Barrier",
			size: new Vector3(20, 6, 3),
			cframe: CFrame.lookAt(pos, new Vector3(0, pos.Y, 0)),
			color: i % 4 === 0 ? Color3.fromRGB(196, 158, 60) : METAL_DARK,
			material: Enum.Material.Metal,
		});
	}
}

// ===========================================================================
// Central derrick / tower (the red rig in the middle of the arena).
// ===========================================================================
function buildDerrick(arena: Model) {
	const base = 16;
	const height = 64;
	// Sits on the floor of the dry-lake-bed basin rather than the plateau.
	const baseY = -LAKEBED_DEPTH;

	// Concrete pad.
	makePart(arena, {
		name: "DerrickPad",
		size: new Vector3(40, 4, 40),
		cframe: new CFrame(0, baseY + 2, 0),
		color: Color3.fromRGB(70, 66, 62),
		material: Enum.Material.Concrete,
	});

	// Four legs leaning slightly inward.
	const half = base / 2;
	const legCorners = [
		new Vector3(-half, 0, -half),
		new Vector3(half, 0, -half),
		new Vector3(-half, 0, half),
		new Vector3(half, 0, half),
	];
	for (const c of legCorners) {
		const bottom = new Vector3(c.X, baseY + 4, c.Z);
		const top = new Vector3(c.X * 0.25, baseY + height, c.Z * 0.25);
		const mid = bottom.add(top).div(2);
		const dir = top.sub(bottom);
		const len = dir.Magnitude;
		makePart(arena, {
			name: "DerrickLeg",
			size: new Vector3(3, len, 3),
			cframe: CFrame.lookAt(mid, top).mul(CFrame.Angles(math.rad(90), 0, 0)),
			color: DERRICK_RED,
			material: Enum.Material.Metal,
		});
	}

	// Horizontal cross braces at a few heights.
	for (const y of [18, 34, 50]) {
		const shrink = 1 - y / (height * 1.6);
		const ringR = half * shrink + 1.5;
		for (let i = 0; i < 4; i++) {
			const a = (i / 4) * TWO_PI + math.rad(45);
			const pos = new Vector3(math.cos(a) * ringR, baseY + y, math.sin(a) * ringR);
			makePart(arena, {
				name: "DerrickBrace",
				size: new Vector3(ringR * 1.5, 1.4, 1.4),
				cframe: new CFrame(pos).mul(CFrame.Angles(0, a + math.rad(90), 0)),
				color: METAL_DARK,
				material: Enum.Material.Metal,
			});
		}
	}

	// Top platform.
	makePart(arena, {
		name: "DerrickTop",
		size: new Vector3(14, 3, 14),
		cframe: new CFrame(0, baseY + height + 1.5, 0),
		color: DERRICK_RED,
		material: Enum.Material.Metal,
	});

	// Glowing red beacon + light on top.
	const beacon = makePart(arena, {
		name: "Beacon",
		size: new Vector3(3, 6, 3),
		cframe: new CFrame(0, baseY + height + 6, 0),
		color: Color3.fromRGB(255, 64, 48),
		material: Enum.Material.Neon,
	});
	const beaconLight = new Instance("PointLight");
	beaconLight.Color = Color3.fromRGB(255, 70, 50);
	beaconLight.Brightness = 4;
	beaconLight.Range = 70;
	beaconLight.Parent = beacon;

	// Downlights on the platform corners to light the centre of the pit.
	for (const c of legCorners) {
		const lens = makePart(arena, {
			name: "DerrickLamp",
			size: new Vector3(2.4, 1, 2.4),
			cframe: new CFrame(c.X * 0.35, baseY + height, c.Z * 0.35),
			color: Color3.fromRGB(255, 244, 214),
			material: Enum.Material.Neon,
		});
		const light = new Instance("SpotLight");
		light.Face = Enum.NormalId.Bottom;
		light.Angle = 90;
		light.Range = 90;
		light.Brightness = 3;
		light.Color = Color3.fromRGB(255, 240, 210);
		light.Parent = lens;
	}
}

// ===========================================================================
// Floodlight towers around the rim, glowing and lighting the dirt.
// ===========================================================================
function buildFloodlights(arena: Model) {
	const count = math.floor((TWO_PI * (FLOOR_RADIUS - 12)) / 170);
	for (let i = 0; i < count; i++) {
		const a = (i / count) * TWO_PI + math.rad(18);
		const r = FLOOR_RADIUS - 12;
		const baseX = math.cos(a) * r;
		const baseZ = math.sin(a) * r;
		const poleH = range(54, 64);

		// Pole.
		makePart(arena, {
			name: "FloodPole",
			size: new Vector3(3, poleH, 3),
			cframe: new CFrame(baseX, poleH / 2, baseZ),
			color: METAL_DARK,
			material: Enum.Material.Metal,
		});

		// Cross bar of lamps at the top, angled in toward the arena centre.
		const headPos = new Vector3(baseX, poleH, baseZ);
		const headCf = CFrame.lookAt(headPos, new Vector3(0, poleH - 18, 0));
		makePart(arena, {
			name: "FloodRack",
			size: new Vector3(16, 4, 2),
			cframe: headCf,
			color: METAL_DARK,
			material: Enum.Material.Metal,
		});

		// Three glowing lamp lenses on the rack.
		for (const offset of [-5, 0, 5]) {
			const lensCf = headCf.mul(new CFrame(offset, 0, -1.2));
			const lens = makePart(arena, {
				name: "FloodLens",
				size: new Vector3(4, 3, 1),
				cframe: lensCf,
				color: Color3.fromRGB(255, 246, 220),
				material: Enum.Material.Neon,
			});
			if (offset === 0) {
				const spot = new Instance("SpotLight");
				spot.Face = Enum.NormalId.Front;
				spot.Angle = 75;
				spot.Range = 180;
				spot.Brightness = 2.5;
				spot.Color = Color3.fromRGB(255, 242, 212);
				spot.Parent = lens;
			}
		}

		// Warm glow point light so the base of each tower reads at night.
		const glow = new Instance("PointLight");
		glow.Color = Color3.fromRGB(255, 226, 180);
		glow.Brightness = 2;
		glow.Range = 60;
		const glowHost = makePart(arena, {
			name: "FloodGlow",
			size: new Vector3(1, 1, 1),
			cframe: headCf,
			color: Color3.fromRGB(255, 246, 220),
			material: Enum.Material.Neon,
			transparency: 1,
		});
		glow.Parent = glowHost;
	}
}

// ===========================================================================
// Billboards on the canyon wall.
// ===========================================================================
function makeBillboard(arena: Model, angleDeg: number, text: string, accent: Color3) {
	const a = math.rad(angleDeg);
	const r = CANYON_INNER_RADIUS - 8;
	const y = range(46, 60);
	const pos = new Vector3(math.cos(a) * r, y, math.sin(a) * r);
	const facing = CFrame.lookAt(pos, new Vector3(0, y, 0));

	// Support posts.
	for (const sx of [-22, 22]) {
		const postCf = facing.mul(new CFrame(sx, -y / 2 + 4, 1.5));
		makePart(arena, {
			name: "SignPost",
			size: new Vector3(3, y, 3),
			cframe: postCf,
			color: METAL_DARK,
			material: Enum.Material.Metal,
		});
	}

	// Sign panel.
	const panel = makePart(arena, {
		name: "Billboard",
		size: new Vector3(56, 20, 2),
		cframe: facing,
		color: SIGN_BACK,
		material: Enum.Material.Metal,
	});

	const gui = new Instance("SurfaceGui");
	gui.Name = "SignGui";
	gui.Face = Enum.NormalId.Front;
	gui.CanvasSize = new Vector2(896, 320);
	gui.LightInfluence = 0;
	gui.Parent = panel;

	const bg = new Instance("TextLabel");
	bg.Size = UDim2.fromScale(1, 1);
	bg.BackgroundColor3 = SIGN_BACK;
	bg.BackgroundTransparency = 0.1;
	bg.BorderSizePixel = 0;
	bg.Text = text;
	bg.Font = Enum.Font.GothamBlack;
	bg.TextScaled = true;
	bg.TextColor3 = accent;
	bg.Parent = gui;

	const stroke = new Instance("UIStroke");
	stroke.Color = Color3.fromRGB(0, 0, 0);
	stroke.Thickness = 4;
	stroke.Parent = bg;

	// Make the sign glow a little at dusk.
	const light = new Instance("SurfaceLight");
	light.Face = Enum.NormalId.Front;
	light.Angle = 90;
	light.Range = 60;
	light.Brightness = 1.4;
	light.Color = accent;
	light.Parent = panel;
}

function buildBillboards(arena: Model) {
	makeBillboard(arena, 35, "FUEL UP. FIGHT. WIN.", Color3.fromRGB(255, 196, 60));
	makeBillboard(arena, 125, "DEMOLITION DERBY", Color3.fromRGB(255, 96, 64));
	makeBillboard(arena, 215, "NO RULES", Color3.fromRGB(255, 222, 120));
	makeBillboard(arena, 305, "LAST CAR ROLLING", Color3.fromRGB(120, 220, 255));
}

// ===========================================================================
// Player spawn pad, placed on the track right behind the car so you start
// standing next to it.
// ===========================================================================
function buildSpawn(arena: Model) {
	const carPos = SPAWN_CFRAME.Position;
	const back = SPAWN_CFRAME.LookVector.mul(-16); // 16 studs behind the car
	const padPos = new Vector3(carPos.X + back.X, 0.5, carPos.Z + back.Z);
	// Face the pad toward the car so the player spawns looking right at it.
	const lookTarget = new Vector3(carPos.X, padPos.Y, carPos.Z);

	const pad = new Instance("SpawnLocation");
	pad.Name = "Spawn";
	pad.Anchored = true;
	pad.Neutral = true;
	pad.Enabled = true;
	pad.CanCollide = true;
	pad.Size = new Vector3(10, 1, 10);
	pad.CFrame = CFrame.lookAt(padPos, lookTarget);
	pad.Color = Color3.fromRGB(196, 158, 60);
	pad.Material = Enum.Material.Metal;
	pad.TopSurface = Enum.SurfaceType.Smooth;
	pad.Parent = arena;
}

// ===========================================================================
// Build (idempotent).
// ===========================================================================
function buildArena() {
	const existing = Workspace.FindFirstChild(ARENA_NAME);
	if (existing) existing.Destroy();

	// Remove the default flat baseplate if present.
	const baseplate = Workspace.FindFirstChild("Baseplate");
	if (baseplate) baseplate.Destroy();

	const arena = new Instance("Model");
	arena.Name = ARENA_NAME;
	arena.Parent = Workspace;

	setupLighting();
	buildGround();
	buildBerm(arena);
	buildCanyon(arena);
	buildBarrier(arena);
	buildDerrick(arena);
	buildFloodlights(arena);
	buildBillboards(arena);
	buildSpawn(arena);
}

buildArena();
