import { Lighting, Workspace } from "@rbxts/services";
import {
	ARENA_NAME,
	ARENA_BOUNDARY_RADIUS,
	BOWL_RIM_HEIGHT,
	BOWL_RIM_RADIUS,
	CANYON_INNER_RADIUS,
	FLAT_OUTER,
	FLOOR_RADIUS,
	groundYAt,
	LAKEBED_DEPTH,
	LAKEBED_INNER,
	LAKEBED_OUTER,
} from "shared/arenaConfig";
import { SPAWN_CFRAME } from "shared/carConfig";

// Flat racing track ring around the circumference (~2-3 cars wide; a car is
// 6 studs wide), with the entire interior as one wide dry-lake-bed basin.
// The whole arena sits at the bottom of a crater: outside the track the
// terrain itself climbs continuously up to a high rim (like the reference),
// and the canyon rocks crown that rim rather than standing on flat ground.
// The crater height profile (groundY and its constants) lives in
// shared/arenaConfig so pad placement can use the same maths.
const GROUND_RADIUS = 1000; // terrain extends well past the canyon so distant landmarks sit on dirt

// Wind shared by every smoke/dust emitter so the whole scene drifts together.
const WIND = new Vector3(9, 1.5, 4);

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
function pick<T>(items: ReadonlyArray<T>): T {
	return items[math.floor(rand() * items.size()) % items.size()];
}

const TWO_PI = math.pi * 2;

function surfacePosition(angle: number, radius: number, yOffset = 0) {
	const x = math.cos(angle) * radius;
	const z = math.sin(angle) * radius;
	return new Vector3(x, groundYAt(x, z) + yOffset, z);
}

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
	canCollide?: boolean;
	canQuery?: boolean;
	canTouch?: boolean;
	castShadow?: boolean;
}

function makePart(parent: Instance, opts: PartOptions) {
	const part = new Instance("Part");
	part.Name = opts.name ?? "ArenaPart";
	part.Anchored = true;
	part.CanCollide = opts.canCollide ?? true;
	part.CanQuery = opts.canQuery ?? true;
	part.CanTouch = opts.canTouch ?? true;
	part.CastShadow = opts.castShadow ?? true;
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

// Vertical cylinder (PartType.Cylinder's axis is X, so roll it upright).
function makeCylinder(
	parent: Instance,
	opts: Omit<PartOptions, "shape" | "size"> & { height: number; diameter: number },
) {
	return makePart(parent, {
		...opts,
		shape: Enum.PartType.Cylinder,
		size: new Vector3(opts.height, opts.diameter, opts.diameter),
		cframe: opts.cframe.mul(CFrame.Angles(0, 0, math.rad(90))),
	});
}

// Thin beam between two world points (used for pylon wires, tower legs, branches).
function makeBeam(
	parent: Instance,
	from: Vector3,
	to: Vector3,
	thickness: number,
	color: Color3,
	material: Enum.Material,
	name?: string,
) {
	const mid = from.add(to).div(2);
	const len = to.sub(from).Magnitude;
	return makePart(parent, {
		name: name ?? "Beam",
		size: new Vector3(thickness, thickness, len),
		cframe: CFrame.lookAt(mid, to),
		color,
		material,
		canCollide: false,
	});
}

// ---------------------------------------------------------------------------
// Colour palette (sampled from the Blur desert reference).
// ---------------------------------------------------------------------------
const DIRT = Color3.fromRGB(156, 113, 75);
const DIRT_DARK = Color3.fromRGB(120, 84, 53);
const ROCK = Color3.fromRGB(124, 66, 47);
const ROCK_DARK = Color3.fromRGB(96, 50, 38);
const ROCK_CAP = Color3.fromRGB(178, 128, 92); // pale sandstone band on top of formations
const METAL_DARK = Color3.fromRGB(48, 46, 52);
const GALVANIZED = Color3.fromRGB(108, 110, 116); // transmission pylons
const RUST = Color3.fromRGB(112, 72, 48);
const WOOD = Color3.fromRGB(94, 74, 54);
const WOOD_DARK = Color3.fromRGB(70, 56, 42);
const DERRICK_RED = Color3.fromRGB(168, 52, 42);
const SIGN_BACK = Color3.fromRGB(28, 24, 22);
const TANK_GREY = Color3.fromRGB(164, 158, 148);
const SCRUB_COLORS: ReadonlyArray<Color3> = [
	Color3.fromRGB(86, 84, 52),
	Color3.fromRGB(108, 92, 56),
	Color3.fromRGB(66, 68, 46),
	Color3.fromRGB(122, 102, 62),
];

// ===========================================================================
// Lighting: readable desert dusk — the sun has just dipped behind the rim,
// leaving a warm horizon and steel-blue sky. The ambient fill deliberately
// preserves car/prop silhouettes in the crater's broad shadows; contrast is
// kept in the local floodlight pools instead of crushed into the colour grade.
// Assumes Lighting.Technology=Future (not scriptable at runtime; set once on
// the place file via Studio).
// ===========================================================================
function setupLighting() {
	Lighting.ClockTime = 17.95; // sun dipping behind the crater rim — dusk band in the sky, no blown-out disk
	Lighting.GeographicLatitude = 18;
	Lighting.Brightness = 2.25;
	Lighting.ExposureCompensation = 0.3;
	// Warm ambient fakes the floodlight bounce filling the bowl (the concept's
	// whole arena glows); shadows still cool off toward blue via Ambient.
	Lighting.OutdoorAmbient = Color3.fromRGB(148, 132, 120);
	Lighting.Ambient = Color3.fromRGB(96, 86, 88);
	Lighting.EnvironmentDiffuseScale = 0.6;
	Lighting.EnvironmentSpecularScale = 0.55;
	Lighting.ShadowSoftness = 0.25;

	// Broken night cloud, dark with a faint mauve underside from the dusk glow.
	const terrain = Workspace.Terrain;
	let clouds = terrain.FindFirstChildOfClass("Clouds");
	if (!clouds) {
		clouds = new Instance("Clouds");
		clouds.Parent = terrain;
	}
	clouds.Enabled = true;
	clouds.Cover = 0.68;
	clouds.Density = 0.55;
	clouds.Color = Color3.fromRGB(118, 112, 130);

	const old = Lighting.FindFirstChild("ArenaAtmosphere");
	if (old) old.Destroy();
	const atmosphere = new Instance("Atmosphere");
	atmosphere.Name = "ArenaAtmosphere";
	// Density/haze tuned so the far crater rim (~1000 studs) still silhouettes
	// against the dusk sky instead of vanishing entirely — the bowl should
	// always read as enclosed from anywhere on the floor.
	atmosphere.Density = 0.28;
	atmosphere.Offset = 0.25;
	atmosphere.Color = Color3.fromRGB(150, 132, 128);
	atmosphere.Decay = Color3.fromRGB(62, 62, 86);
	atmosphere.Glare = 0.1;
	atmosphere.Haze = 2.1;
	atmosphere.Parent = Lighting;

	const oldCc = Lighting.FindFirstChild("ArenaColor");
	if (oldCc) oldCc.Destroy();
	const cc = new Instance("ColorCorrectionEffect");
	cc.Name = "ArenaColor";
	cc.Brightness = 0.04;
	cc.Contrast = 0.08;
	cc.Saturation = 0.02;
	cc.TintColor = Color3.fromRGB(255, 246, 240);
	cc.Parent = Lighting;

	const oldBloom = Lighting.FindFirstChild("ArenaBloom");
	if (oldBloom) oldBloom.Destroy();
	const bloom = new Instance("BloomEffect");
	bloom.Name = "ArenaBloom";
	// Threshold below 1 so the neon lamp lenses and signs halo at night.
	bloom.Intensity = 0.65;
	bloom.Size = 24;
	bloom.Threshold = 1.1;
	bloom.Parent = Lighting;

	const oldRays = Lighting.FindFirstChild("ArenaSunRays");
	if (oldRays) oldRays.Destroy();
	const rays = new Instance("SunRaysEffect");
	rays.Name = "ArenaSunRays";
	rays.Intensity = 0.04;
	rays.Spread = 0.6;
	rays.Parent = Lighting;

	// Studio place files may retain the default post effects even though the
	// arena owns its tuned variants. Remove the known defaults so bloom and sun
	// rays do not stack differently between a clean Rojo place and this place.
	for (const defaultEffectName of ["Bloom", "SunRays"]) {
		const defaultEffect = Lighting.FindFirstChild(defaultEffectName);
		if (defaultEffect) defaultEffect.Destroy();
	}
}

// ===========================================================================
// Terrain ground: a sampled continuous height field. Terrain's four-stud
// voxels interpolate the fractional occupancy at the surface, avoiding the
// concentric ledges produced by stacked FillCylinder cuts.
// ===========================================================================
function buildGround() {
	const terrain = Workspace.Terrain;

	// Tint the terrain materials to match the warm desert palette.
	terrain.SetMaterialColor(Enum.Material.Ground, Color3.fromRGB(150, 110, 72));
	terrain.SetMaterialColor(Enum.Material.Salt, Color3.fromRGB(208, 198, 172));
	terrain.SetMaterialColor(Enum.Material.Sandstone, Color3.fromRGB(172, 122, 80));

	// Reset and establish the solid distant plateau. The playable square is
	// replaced below in small chunks to avoid one enormous nested allocation.
	terrain.FillCylinder(
		new CFrame(0, BOWL_RIM_HEIGHT / 2, 0),
		200 + BOWL_RIM_HEIGHT,
		GROUND_RADIUS + 10,
		Enum.Material.Air,
	);

	// Solid dirt slab up to rim height everywhere.
	terrain.FillCylinder(
		new CFrame(0, (BOWL_RIM_HEIGHT - 60) / 2, 0),
		BOWL_RIM_HEIGHT + 60,
		GROUND_RADIUS,
		Enum.Material.Ground,
	);

	const resolution = 4;
	const extent = 660;
	const chunkSize = 64;
	const minY = -72;
	const maxY = 84;

	for (let chunkX = -extent; chunkX < extent; chunkX += chunkSize) {
		for (let chunkZ = -extent; chunkZ < extent; chunkZ += chunkSize) {
			const endX = math.min(chunkX + chunkSize, extent);
			const endZ = math.min(chunkZ + chunkSize, extent);
			const xCells = (endX - chunkX) / resolution;
			const zCells = (endZ - chunkZ) / resolution;
			const yCells = (maxY - minY) / resolution;
			const materials = new Array<Array<Array<Enum.Material>>>();
			const occupancy = new Array<Array<Array<number>>>();

			for (let ix = 0; ix < xCells; ix++) {
				const materialColumn = new Array<Array<Enum.Material>>();
				const occupancyColumn = new Array<Array<number>>();
				const x = chunkX + (ix + 0.5) * resolution;
				for (let iy = 0; iy < yCells; iy++) {
					const materialRow = new Array<Enum.Material>();
					const occupancyRow = new Array<number>();
					const cellBottom = minY + iy * resolution;
					for (let iz = 0; iz < zCells; iz++) {
						const z = chunkZ + (iz + 0.5) * resolution;
						// Smooth terrain's rendered/collision iso-surface sits about half a
						// voxel above the raw occupancy height. Compensate so raycasts and
						// the shared analytic placement function agree in world space.
						const surface = groundYAt(x, z) - resolution / 2;
						const fill = math.clamp((surface - cellBottom) / resolution, 0, 1);
						const r = math.sqrt(x * x + z * z);
						materialRow.push(fill > 0 ? (r < LAKEBED_INNER ? Enum.Material.Salt : Enum.Material.Ground) : Enum.Material.Air);
						occupancyRow.push(fill);
					}
					materialColumn.push(materialRow);
					occupancyColumn.push(occupancyRow);
				}
				materials.push(materialColumn);
				occupancy.push(occupancyColumn);
			}

			terrain.WriteVoxels(
				new Region3(new Vector3(chunkX, minY, chunkZ), new Vector3(endX, maxY, endZ)),
				resolution,
				materials,
				occupancy,
			);
		}
	}

	// ArenaReady is raised after the dedicated outer collision ring is built.
	// Ground alone is no longer the complete containment surface.
}

// ===========================================================================
// Layered outer boundary. Collision, the readable foreground edge, and the
// skyline are deliberately separate systems: cars always meet one smooth
// circular surface, while the visible canyon can use broken, overlapping
// silhouettes without introducing seams, snag points, or accidental ramps.
// ===========================================================================
const BOUNDARY_SEGMENT_COUNT = 96;

type CanyonTheme = "terraced" | "saddle" | "fractured" | "industrial" | "collapsed" | "hero";

interface CanyonSector {
	theme: CanyonTheme;
	clusterCount: number;
	minHeight: number;
	maxHeight: number;
	industrialFooting: boolean;
}

// Eight authored sectors make the ring navigable: high landmark faces are
// separated by lower windows framing the refinery, windmill, pylons, and
// water tower. Randomness only varies each theme within these fixed beats.
const CANYON_SECTORS: ReadonlyArray<CanyonSector> = [
	{ theme: "terraced", clusterCount: 6, minHeight: 105, maxHeight: 160, industrialFooting: true },
	{ theme: "saddle", clusterCount: 5, minHeight: 58, maxHeight: 92, industrialFooting: true },
	{ theme: "fractured", clusterCount: 6, minHeight: 88, maxHeight: 145, industrialFooting: false },
	{ theme: "industrial", clusterCount: 6, minHeight: 74, maxHeight: 124, industrialFooting: true },
	{ theme: "collapsed", clusterCount: 7, minHeight: 64, maxHeight: 116, industrialFooting: true },
	{ theme: "saddle", clusterCount: 5, minHeight: 56, maxHeight: 96, industrialFooting: true },
	{ theme: "hero", clusterCount: 6, minHeight: 128, maxHeight: 184, industrialFooting: true },
	{ theme: "fractured", clusterCount: 5, minHeight: 62, maxHeight: 108, industrialFooting: false },
];

function buildBoundaryCollision(arena: Model) {
	const spacing = (TWO_PI * ARENA_BOUNDARY_RADIUS) / BOUNDARY_SEGMENT_COUNT;
	for (let i = 0; i < BOUNDARY_SEGMENT_COUNT; i++) {
		const a = (i / BOUNDARY_SEGMENT_COUNT) * TWO_PI;
		const ground = surfacePosition(a, ARENA_BOUNDARY_RADIUS);
		const pos = ground.add(new Vector3(0, 24, 0));
		makePart(arena, {
			name: "ArenaBoundary",
			size: new Vector3(spacing + 4, 64, 10),
			cframe: CFrame.lookAt(pos, new Vector3(0, pos.Y, 0)),
			color: Color3.fromRGB(0, 0, 0),
			material: Enum.Material.SmoothPlastic,
			transparency: 1,
			canTouch: false,
			castShadow: false,
		});
	}
}

function makeBoundaryRail(arena: Model, cf: CFrame, index: number) {
	const railColor = index % 3 === 0 ? Color3.fromRGB(196, 158, 60) : RUST;
	for (const x of [-15, 15]) {
		makePart(arena, {
			name: "BoundaryPost",
			size: new Vector3(2.2, 11, 2.2),
			cframe: cf.mul(new CFrame(x, 5.5, -1.9)),
			color: METAL_DARK,
			material: Enum.Material.CorrodedMetal,
			canCollide: false,
			canQuery: false,
			canTouch: false,
		});
	}
	for (const y of [4, 9]) {
		makePart(arena, {
			name: "BoundaryRail",
			size: new Vector3(38, 2.2, 2.4),
			cframe: cf.mul(new CFrame(0, y, -1.8)).mul(CFrame.Angles(0, 0, range(-0.025, 0.025))),
			color: railColor,
			material: Enum.Material.CorrodedMetal,
			canCollide: false,
			canQuery: false,
			canTouch: false,
		});
	}
}

function makeBoundaryWreck(arena: Model, cf: CFrame) {
	makePart(arena, {
		name: "BoundaryWreck",
		size: new Vector3(7, 2.8, 11),
		cframe: cf.mul(new CFrame(0, 3, 3.5)).mul(CFrame.Angles(0, range(-0.35, 0.35), range(-0.14, 0.14))),
		color: pick([RUST, Color3.fromRGB(88, 82, 76), Color3.fromRGB(70, 78, 88)]),
		material: Enum.Material.CorrodedMetal,
		canCollide: false,
		canQuery: false,
		canTouch: false,
	});
	for (const x of [-8, 8]) {
		makeCylinder(arena, {
			name: "BoundaryTire",
			height: 1.6,
			diameter: 4.6,
			cframe: cf.mul(new CFrame(x, 2.3, -0.7)).mul(CFrame.Angles(range(-0.2, 0.2), 0, range(-0.2, 0.2))),
			color: Color3.fromRGB(30, 30, 32),
			material: Enum.Material.SmoothPlastic,
			canCollide: false,
			canQuery: false,
			canTouch: false,
		});
	}
}

function buildBoundaryFooting(arena: Model) {
	const perSector = BOUNDARY_SEGMENT_COUNT / CANYON_SECTORS.size();
	for (let i = 0; i < BOUNDARY_SEGMENT_COUNT; i++) {
		const a = (i / BOUNDARY_SEGMENT_COUNT) * TWO_PI;
		const sector = CANYON_SECTORS[math.floor(i / perSector)];
		const footingHeight = range(14, sector.theme === "hero" ? 25 : 21);
		const footingDepth = range(20, 28);
		const footingWidth = range(39, 47);
		const pos = surfacePosition(a, ARENA_BOUNDARY_RADIUS, footingHeight / 2 - 3);
		const cf = CFrame.lookAt(pos, new Vector3(0, pos.Y, 0));

		// Put the visible inner face two studs behind the physical plane. That gap
		// is filled by the cosmetic shell's small overhang beyond the chassis, so
		// bodywork meets the rock instead of sinking halfway through it.
		const footingOffset = footingDepth / 2 - 3;
		makePart(arena, {
			name: "BoundaryFooting",
			size: new Vector3(footingWidth, footingHeight, footingDepth),
			cframe: cf
				.mul(new CFrame(0, 0, footingOffset))
				.mul(CFrame.Angles(range(-0.035, 0.035), 0, range(-0.055, 0.055))),
			color: i % 4 === 0 ? ROCK_DARK : i % 3 === 0 ? DIRT_DARK : ROCK,
			material: i % 5 === 0 ? Enum.Material.Ground : Enum.Material.Rock,
			canCollide: false,
			canQuery: false,
			canTouch: false,
		});

		// Occasional steel plates make the industrial arcs feel repaired rather
		// than uniformly fenced. Their front face shares the shell-contact plane.
		if (sector.industrialFooting && i % 4 === 1) {
			makePart(arena, {
				name: "BoundaryPlate",
				size: new Vector3(footingWidth * 0.78, footingHeight * 0.58, 1.2),
				cframe: cf
					.mul(new CFrame(0, 0, -2.4))
					.mul(CFrame.Angles(0, 0, range(-0.018, 0.018))),
				color: i % 8 === 1 ? RUST : METAL_DARK,
				material: Enum.Material.CorrodedMetal,
				canCollide: false,
				canQuery: false,
				canTouch: false,
			});
		}

		if (sector.industrialFooting && i % 2 === 0) makeBoundaryRail(arena, cf, i);
		if ((sector.theme === "collapsed" || sector.theme === "industrial") && i % 6 === 0) {
			makeBoundaryWreck(arena, cf);
		}
	}
}

function makeCliffCluster(arena: Model, sector: CanyonSector, angle: number, clusterIndex: number) {
	const height = range(sector.minHeight, sector.maxHeight);
	const width = range(sector.theme === "fractured" ? 54 : 72, sector.theme === "hero" ? 138 : 116);
	const depth = range(58, 104);
	// Keep even the deepest, slightly tilted mass behind the readable boundary
	// face. Previously a 100-stud-deep decorative block could begin near radius
	// 530, letting a car visibly enter it before reaching the collider at 557.
	const preferredRadius = CANYON_INNER_RADIUS + range(10, 64);
	const radius = math.max(preferredRadius, ARENA_BOUNDARY_RADIUS + 5 + depth / 2);
	const pos = surfacePosition(angle, radius, height / 2 - 18);
	const cf = CFrame.lookAt(pos, new Vector3(0, pos.Y, 0)).mul(
		CFrame.Angles(range(-0.045, 0.045), 0, range(-0.07, 0.07)),
	);
	const rockColor = clusterIndex % 3 === 0 ? ROCK_DARK : ROCK;
	const visualOnly = { canCollide: false, canQuery: false, canTouch: false };

	makePart(arena, {
		name: "CanyonMass",
		size: new Vector3(width, height, depth),
		cframe: cf,
		color: rockColor,
		material: Enum.Material.Rock,
		...visualOnly,
	});

	// Shorter side masses destroy the single-box silhouette and read as eroded
	// buttresses. Collapsed sectors lean them farther and lower into talus.
	for (const side of [-1, 1]) {
		const buttressHeight = height * range(sector.theme === "collapsed" ? 0.35 : 0.48, 0.7);
		const buttressDepth = depth * range(0.55, 0.82);
		makePart(arena, {
			name: "CanyonButtress",
			size: new Vector3(width * range(0.22, 0.34), buttressHeight, buttressDepth),
			cframe: cf
				.mul(new CFrame(side * width * range(0.36, 0.48), -height * 0.18, range(0, 12)))
				.mul(CFrame.Angles(0, 0, side * range(0.04, 0.13))),
			color: side === 1 ? ROCK_DARK : rockColor,
			material: Enum.Material.Rock,
			...visualOnly,
		});
	}

	// Narrow crowns break the last broad, flat top surfaces without restoring
	// the old full-width cap bands. Saddles deliberately remain low and quiet.
	const crownCount = sector.theme === "hero" || sector.theme === "terraced" ? 2 : sector.theme === "saddle" ? 0 : 1;
	for (let crown = 0; crown < crownCount; crown++) {
		const crownHeight = range(12, math.max(12, math.min(28, height * 0.2)));
		makePart(arena, {
			name: "CanyonCrown",
			size: new Vector3(width * range(0.24, 0.46), crownHeight, depth * range(0.5, 0.72)),
			cframe: cf
				.mul(
					new CFrame(
						range(-width * 0.28, width * 0.28),
						height / 2 + crownHeight / 2 - 5,
						range(5, 14),
					),
				)
				.mul(CFrame.Angles(range(-0.025, 0.025), 0, range(-0.045, 0.045))),
			color: crown % 2 === 0 ? rockColor : ROCK_DARK,
			material: Enum.Material.Rock,
			...visualOnly,
		});
	}

	// Partial, offset ledges replace the old full-width cap bands that exposed
	// the rectangular construction. Hero and terraced faces receive a second
	// ledge; saddles stay visually quiet so the horizon remains open.
	const ledgeCount = sector.theme === "hero" || sector.theme === "terraced" ? 2 : sector.theme === "saddle" ? 0 : 1;
	for (let ledge = 0; ledge < ledgeCount; ledge++) {
		const ledgeWidth = width * range(0.38, 0.68);
		makePart(arena, {
			name: "CanyonLedge",
			size: new Vector3(ledgeWidth, range(7, 13), depth * range(0.78, 1.02)),
			cframe: cf.mul(
				new CFrame(
					range(-width * 0.18, width * 0.18),
					height * (ledge === 0 ? 0.28 : 0.06),
					range(-4, 5),
				),
			),
			color: ROCK_CAP,
			material: Enum.Material.Rock,
			...visualOnly,
		});
	}

	if (sector.theme === "fractured") {
		const pillarHeight = height * range(0.72, 1.05);
		makePart(arena, {
			name: "CanyonPillar",
			size: new Vector3(width * range(0.18, 0.28), pillarHeight, depth * range(0.42, 0.6)),
			cframe: cf
				.mul(new CFrame(range(-width * 0.55, width * 0.55), height * 0.06, range(-12, 8)))
				.mul(CFrame.Angles(0, 0, range(-0.09, 0.09))),
			color: ROCK_DARK,
			material: Enum.Material.Rock,
			...visualOnly,
		});
	}

	for (const side of [-1, 1]) {
		const boulderSize = range(18, 34);
		const boulderHeight = boulderSize * range(0.55, 0.9);
		const boulderDepth = boulderSize * range(0.8, 1.2);
		// The full half-diagonal is conservative under the random rotations below
		// and guarantees the talus never protrudes through the contact surface.
		const radialHalf = math.sqrt(boulderSize * boulderSize + boulderHeight * boulderHeight + boulderDepth * boulderDepth) / 2;
		const talusCentreRadius = ARENA_BOUNDARY_RADIUS + 1 + radialHalf;
		const talusYOffset = boulderHeight / 2 + 16 - height / 2;
		makePart(arena, {
			name: "BoundaryTalus",
			size: new Vector3(boulderSize, boulderHeight, boulderDepth),
			cframe: cf
				.mul(new CFrame(side * width * range(0.25, 0.48), talusYOffset, talusCentreRadius - radius))
				.mul(CFrame.Angles(range(-0.35, 0.35), range(0, TWO_PI), range(-0.35, 0.35))),
			color: side === 1 ? DIRT_DARK : ROCK_DARK,
			material: Enum.Material.Rock,
			...visualOnly,
		});
	}
}

function buildCanyon(arena: Model) {
	const sectorAngle = TWO_PI / CANYON_SECTORS.size();
	for (let sectorIndex = 0; sectorIndex < CANYON_SECTORS.size(); sectorIndex++) {
		const sector = CANYON_SECTORS[sectorIndex];
		for (let cluster = 0; cluster < sector.clusterCount; cluster++) {
			const t = (cluster + 0.5) / sector.clusterCount;
			const angle = sectorIndex * sectorAngle + t * sectorAngle + range(-0.035, 0.035);
			makeCliffCluster(arena, sector, angle, cluster);
		}
	}
}

// ===========================================================================
// Distant horizon: flat-topped mesas and narrow buttes beyond the canyon,
// fading into the haze exactly like the reference's far rock formations.
// ===========================================================================
function buildMesas(arena: Model) {
	for (let i = 0; i < 11; i++) {
		const a = rand() * TWO_PI;
		const r = range(740, 960);
		const w = range(180, 360);
		const h = range(90, 200);
		const d = range(120, 240);
		const pos = surfacePosition(a, r, h / 2 - 12);
		const cf = CFrame.lookAt(pos, new Vector3(0, pos.Y, 0)).mul(CFrame.Angles(0, range(-0.3, 0.3), 0));
		makePart(arena, {
			name: "Mesa",
			size: new Vector3(w, h, d),
			cframe: cf,
			color: i % 2 === 0 ? ROCK : ROCK_DARK,
			material: Enum.Material.Rock,
			castShadow: false,
		});
		makePart(arena, {
			name: "MesaCap",
			size: new Vector3(w * 1.04, h * 0.12, d * 1.04),
			cframe: cf.mul(new CFrame(0, h * 0.44, 0)),
			color: ROCK_CAP,
			material: Enum.Material.Rock,
			canCollide: false,
			castShadow: false,
		});
	}

	// Narrow buttes — tall lone spires breaking the skyline.
	for (let i = 0; i < 5; i++) {
		const a = rand() * TWO_PI;
		const r = range(700, 900);
		const h = range(120, 190);
		const pos = surfacePosition(a, r, h / 2 - 10);
		makePart(arena, {
			name: "Butte",
			size: new Vector3(range(38, 66), h, range(34, 60)),
			cframe: new CFrame(pos).mul(CFrame.Angles(0, rand() * TWO_PI, range(-0.04, 0.04))),
			color: ROCK,
			material: Enum.Material.Rock,
			castShadow: false,
		});
	}
}

// ===========================================================================
// Industrial skyline: refinery tanks, flare stacks burning off gas, smoke
// chimneys and a pair of cooling towers — the reference's most distinctive
// horizon feature. Placed in one sector beyond the canyon, tall enough to
// read over the walls.
// ===========================================================================
function smokeEmitter(parent: BasePart, color: Color3, rate: number, sizeStart: number, sizeEnd: number) {
	const smoke = new Instance("ParticleEmitter");
	smoke.Texture = "rbxasset://textures/particles/smoke_main.dds";
	smoke.Rate = rate;
	smoke.Lifetime = new NumberRange(7, 12);
	smoke.Speed = new NumberRange(10, 16);
	smoke.EmissionDirection = Enum.NormalId.Top;
	smoke.SpreadAngle = new Vector2(8, 8);
	smoke.Acceleration = WIND;
	smoke.Rotation = new NumberRange(0, 360);
	smoke.RotSpeed = new NumberRange(-12, 12);
	smoke.Color = new ColorSequence(color);
	smoke.Size = new NumberSequence([new NumberSequenceKeypoint(0, sizeStart), new NumberSequenceKeypoint(1, sizeEnd)]);
	smoke.Transparency = new NumberSequence([
		new NumberSequenceKeypoint(0, 0.45),
		new NumberSequenceKeypoint(0.7, 0.75),
		new NumberSequenceKeypoint(1, 1),
	]);
	smoke.LightEmission = 0.02;
	smoke.LightInfluence = 1; // darken at night, brighten where lights hit
	smoke.Parent = parent;
	return smoke;
}

function buildRefinery(arena: Model) {
	const sectorA = math.rad(52); // which direction the industrial skyline sits in
	const baseR = 730;
	const centre = surfacePosition(sectorA, baseR);
	const right = new Vector3(-math.sin(sectorA), 0, math.cos(sectorA)); // tangent, for spreading the cluster

	// Storage tanks.
	for (let i = 0; i < 5; i++) {
		const offset = right.mul(range(-160, 160)).add(new Vector3(range(-40, 40), 0, range(-40, 40)));
		const d = range(44, 64);
		const h = range(28, 40);
		makeCylinder(arena, {
			name: "RefineryTank",
			height: h,
			diameter: d,
			cframe: new CFrame(centre.add(offset).add(new Vector3(0, h / 2 - 4, 0))),
			color: TANK_GREY,
			material: Enum.Material.Metal,
			castShadow: false,
		});
	}

	// Boxy processing buildings.
	for (let i = 0; i < 3; i++) {
		const offset = right.mul(range(-140, 140)).add(new Vector3(range(-30, 30), 0, range(-30, 30)));
		const h = range(22, 36);
		makePart(arena, {
			name: "RefineryBlock",
			size: new Vector3(range(30, 54), h, range(24, 40)),
			cframe: new CFrame(centre.add(offset).add(new Vector3(0, h / 2 - 4, 0))).mul(
				CFrame.Angles(0, rand() * TWO_PI, 0),
			),
			color: Color3.fromRGB(122, 116, 108),
			material: Enum.Material.Concrete,
			castShadow: false,
		});
	}

	// Flare stacks: tall thin chimneys topped with live flame and black smoke.
	for (const spread of [-120, -10, 95]) {
		const stackPos = centre.add(right.mul(spread)).add(new Vector3(range(-20, 20), 0, range(-20, 20)));
		const h = range(170, 215);
		makeCylinder(arena, {
			name: "FlareStack",
			height: h,
			diameter: 6,
			cframe: new CFrame(stackPos.add(new Vector3(0, h / 2 - 4, 0))),
			color: METAL_DARK,
			material: Enum.Material.Metal,
			castShadow: false,
		});
		const tip = makePart(arena, {
			name: "FlareTip",
			size: new Vector3(5, 4, 5),
			cframe: new CFrame(stackPos.add(new Vector3(0, h - 4, 0))),
			color: Color3.fromRGB(255, 120, 40),
			material: Enum.Material.Neon,
			canCollide: false,
			castShadow: false,
		});
		const fire = new Instance("Fire");
		fire.Size = 22;
		fire.Heat = 18;
		fire.Color = Color3.fromRGB(255, 140, 40);
		fire.SecondaryColor = Color3.fromRGB(120, 40, 20);
		fire.Parent = tip;
		const glow = new Instance("PointLight");
		glow.Color = Color3.fromRGB(255, 130, 50);
		glow.Brightness = 10;
		glow.Range = 150;
		glow.Parent = tip;
		smokeEmitter(tip, Color3.fromRGB(52, 46, 44), 4, 10, 34);
	}

	// A pair of big cooling towers with white steam, further back.
	for (const spread of [-220, 200]) {
		const pos = centre.add(right.mul(spread)).add(new Vector3(range(-20, 20), 0, range(30, 80)));
		const h = 140;
		makeCylinder(arena, {
			name: "CoolingTower",
			height: h,
			diameter: 88,
			cframe: new CFrame(pos.add(new Vector3(0, h / 2 - 6, 0))),
			color: Color3.fromRGB(150, 142, 138),
			material: Enum.Material.Concrete,
			castShadow: false,
		});
		makeCylinder(arena, {
			name: "CoolingTowerNeck",
			height: 26,
			diameter: 64,
			cframe: new CFrame(pos.add(new Vector3(0, h + 6, 0))),
			color: Color3.fromRGB(158, 150, 146),
			material: Enum.Material.Concrete,
			castShadow: false,
		});
		const steamHost = makePart(arena, {
			name: "SteamHost",
			size: new Vector3(30, 1, 30),
			cframe: new CFrame(pos.add(new Vector3(0, h + 20, 0))),
			color: TANK_GREY,
			material: Enum.Material.Metal,
			transparency: 1,
			canCollide: false,
			castShadow: false,
		});
		smokeEmitter(steamHost, Color3.fromRGB(214, 208, 206), 3, 22, 52);
	}
}

// ===========================================================================
// Transmission pylons marching in an arc around the rim, strung with sagging
// wires — the reference's signature mid-ground element.
// ===========================================================================
function buildPylon(arena: Model, pos: Vector3, radialDir: Vector3, height: number) {
	const halfBase = 7;
	const halfTop = 2.2;
	const tangent = new Vector3(-radialDir.Z, 0, radialDir.X);

	// Four legs tapering inward.
	for (const [sx, sz] of [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	] as const) {
		const bottom = pos.add(radialDir.mul(sx * halfBase)).add(tangent.mul(sz * halfBase));
		const top = pos
			.add(radialDir.mul(sx * halfTop))
			.add(tangent.mul(sz * halfTop))
			.add(new Vector3(0, height, 0));
		makeBeam(arena, bottom, top, 1.6, GALVANIZED, Enum.Material.DiamondPlate, "PylonLeg");
	}

	// Horizontal lattice rings.
	for (const y of [height * 0.3, height * 0.6]) {
		const shrink = halfBase + (halfTop - halfBase) * (y / height);
		for (let i = 0; i < 4; i++) {
			const a = (i / 4) * TWO_PI;
			const dir = radialDir.mul(math.cos(a)).add(tangent.mul(math.sin(a)));
			const p1 = pos.add(dir.mul(shrink)).add(new Vector3(0, y, 0));
			const a2 = ((i + 1) / 4) * TWO_PI;
			const dir2 = radialDir.mul(math.cos(a2)).add(tangent.mul(math.sin(a2)));
			const p2 = pos.add(dir2.mul(shrink)).add(new Vector3(0, y, 0));
			makeBeam(arena, p1, p2, 0.9, GALVANIZED, Enum.Material.DiamondPlate, "PylonBrace");
		}
	}

	// Two cross-arms (radial, so the wires run tangentially along the ring).
	const arms: Vector3[] = [];
	for (const [armY, armLen] of [
		[height * 0.82, 13],
		[height * 0.95, 9],
	] as const) {
		makePart(arena, {
			name: "PylonArm",
			size: new Vector3(1.4, 1.4, armLen * 2),
			cframe: CFrame.lookAt(pos.add(new Vector3(0, armY, 0)), pos.add(radialDir).add(new Vector3(0, armY, 0))),
			color: GALVANIZED,
			material: Enum.Material.DiamondPlate,
			canCollide: false,
		});
		arms.push(pos.add(radialDir.mul(armLen)).add(new Vector3(0, armY - 1.5, 0)));
		arms.push(pos.add(radialDir.mul(-armLen)).add(new Vector3(0, armY - 1.5, 0)));
	}
	return arms; // four wire attachment points
}

function buildPylons(arena: Model) {
	const r = 516;
	const startDeg = 140;
	const stepDeg = 24;
	const count = 6;
	let prevArms: Vector3[] | undefined;
	for (let i = 0; i < count; i++) {
		const a = math.rad(startDeg + stepDeg * i);
		const radial = new Vector3(math.cos(a), 0, math.sin(a));
		const pos = surfacePosition(a, r);
		const arms = buildPylon(arena, pos, radial, range(58, 66));

		if (prevArms) {
			for (let w = 0; w < 4; w++) {
				const p1 = prevArms[w];
				const p2 = arms[w];
				const mid = p1
					.add(p2)
					.div(2)
					.sub(new Vector3(0, 7, 0)); // catenary sag
				makeBeam(arena, p1, mid, 0.5, Color3.fromRGB(30, 30, 32), Enum.Material.Metal, "PowerLine");
				makeBeam(arena, mid, p2, 0.5, Color3.fromRGB(30, 30, 32), Enum.Material.Metal, "PowerLine");
			}
		}
		prevArms = arms;
	}
}

// ===========================================================================
// Ranch landmarks: rusty water tower on stilts and a windpump, both straight
// out of the reference's mid-ground.
// ===========================================================================
function buildWaterTower(arena: Model) {
	const a = math.rad(330);
	const pos = surfacePosition(a, 520);
	const legTop = 34;
	const half = 9;

	for (const [sx, sz] of [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	] as const) {
		const bottom = pos.add(new Vector3(sx * half, 0, sz * half));
		const top = pos.add(new Vector3(sx * half * 0.5, legTop, sz * half * 0.5));
		makeBeam(arena, bottom, top, 1.8, WOOD_DARK, Enum.Material.WoodPlanks, "TowerLeg");
		makeBeam(
			arena,
			pos.add(new Vector3(sx * half * 0.85, legTop * 0.35, sz * half * 0.85)),
			pos.add(new Vector3(-sx * half * 0.85, legTop * 0.35, sz * half * 0.85)),
			1,
			WOOD_DARK,
			Enum.Material.WoodPlanks,
			"TowerBrace",
		);
	}

	makeCylinder(arena, {
		name: "WaterTank",
		height: 18,
		diameter: 24,
		cframe: new CFrame(pos.add(new Vector3(0, legTop + 9, 0))),
		color: RUST,
		material: Enum.Material.CorrodedMetal,
	});
	makeCylinder(arena, {
		name: "WaterTankRoof",
		height: 4,
		diameter: 26,
		cframe: new CFrame(pos.add(new Vector3(0, legTop + 20, 0))),
		color: Color3.fromRGB(88, 58, 40),
		material: Enum.Material.CorrodedMetal,
	});
}

function buildWindmill(arena: Model) {
	const a = math.rad(100);
	const pos = surfacePosition(a, 512);
	const height = 38;
	const half = 5;

	for (const [sx, sz] of [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	] as const) {
		const bottom = pos.add(new Vector3(sx * half, 0, sz * half));
		const top = pos.add(new Vector3(sx * 0.8, height, sz * 0.8));
		makeBeam(arena, bottom, top, 1, GALVANIZED, Enum.Material.Metal, "WindmillLeg");
	}

	// Rotor: hub plus a fan of blades facing tangentially.
	const facing = new Vector3(-math.sin(a), 0, math.cos(a));
	const hubPos = pos.add(new Vector3(0, height + 2, 0)).add(facing.mul(2));
	const hub = makePart(arena, {
		name: "WindmillHub",
		size: new Vector3(1.6, 1.6, 1.6),
		cframe: CFrame.lookAt(hubPos, hubPos.add(facing)),
		color: METAL_DARK,
		material: Enum.Material.Metal,
		canCollide: false,
	});
	for (let i = 0; i < 8; i++) {
		const bladeA = (i / 8) * TWO_PI;
		makePart(arena, {
			name: "WindmillBlade",
			size: new Vector3(1.8, 7, 0.2),
			cframe: hub.CFrame.mul(CFrame.Angles(0, 0, bladeA)).mul(new CFrame(0, 4.4, 0)),
			color: Color3.fromRGB(150, 148, 142),
			material: Enum.Material.Metal,
			canCollide: false,
		});
	}
	// Tail vane.
	makePart(arena, {
		name: "WindmillTail",
		size: new Vector3(0.2, 4, 7),
		cframe: CFrame.lookAt(hubPos.sub(facing.mul(6)), hubPos).mul(new CFrame(0, 0, -2)),
		color: Color3.fromRGB(150, 148, 142),
		material: Enum.Material.Metal,
		canCollide: false,
	});
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

	// A broad lighting crown makes the derrick part of the arena illumination,
	// not just a dark landmark with a beacon. Two crossed outriggers carry the
	// fixtures beyond the tower legs so the structure does not block its own
	// downlight.
	const crownY = baseY + height + 4;
	for (const yaw of [0, math.rad(90)]) {
		makePart(arena, {
			name: "DerrickLightRack",
			size: new Vector3(38, 2, 2),
			cframe: new CFrame(0, crownY, 0).mul(CFrame.Angles(0, yaw, 0)),
			color: METAL_DARK,
			material: Enum.Material.Metal,
		});
	}

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

	// Cant the crown lights outward into the rising bowl rather than pointing
	// straight down at the derrick pad. The hidden fill below follows the same
	// four directions so the visible fixture aim matches the illuminated dirt.
	const derrickLightDirections = [
		new Vector3(-1, 0, 0),
		new Vector3(1, 0, 0),
		new Vector3(0, 0, -1),
		new Vector3(0, 0, 1),
	];
	for (const direction of derrickLightDirections) {
		const lensPos = direction.mul(17).add(new Vector3(0, crownY - 1.5, 0));
		const slopePos = direction.mul(190);
		const slopeTarget = new Vector3(slopePos.X, groundYAt(slopePos.X, slopePos.Z), slopePos.Z);
		const lens = makePart(arena, {
			name: "DerrickLamp",
			size: new Vector3(4, 1.4, 4),
			cframe: CFrame.lookAt(lensPos, slopeTarget),
			color: Color3.fromRGB(255, 244, 214),
			material: Enum.Material.Neon,
		});
		const light = new Instance("SpotLight");
		light.Face = Enum.NormalId.Front;
		light.Angle = 90;
		light.Range = 60; // engine max
		light.Brightness = 7;
		light.Color = Color3.fromRGB(255, 240, 210);
		light.Parent = lens;
	}

	// The slopes are beyond the 60-stud engine light-range limit. Hidden low
	// fill lights at the four aim areas continue each beam onto the terrain;
	// a subdued centre fill prevents the derrick pad becoming a black island.
	for (const offset of [new Vector3(0, 0, 0), ...derrickLightDirections.map((direction) => direction.mul(165))]) {
		const hostY = groundYAt(offset.X, offset.Z) + 8;
		const host = makePart(arena, {
			name: "DerrickPool",
			size: new Vector3(1, 1, 1),
			cframe: new CFrame(offset.X, hostY, offset.Z),
			color: Color3.fromRGB(255, 232, 195),
			material: Enum.Material.Neon,
			transparency: 1,
			canCollide: false,
			castShadow: false,
		});
		const fill = new Instance("PointLight");
		fill.Color = Color3.fromRGB(255, 232, 195);
		fill.Brightness = offset.Magnitude === 0 ? 2 : 3;
		fill.Range = 60;
		fill.Parent = host;
	}
}

// ===========================================================================
// Floodlight towers around the rim, glowing and lighting the dirt. They sit
// OUTSIDE the barrier and berm (previously they stood in the racing line).
// ===========================================================================
function buildFloodlights(arena: Model) {
	const r = FLOOR_RADIUS + 28;
	const count = 12;
	for (let i = 0; i < count; i++) {
		const a = (i / count) * TWO_PI + math.rad(18);
		const baseX = math.cos(a) * r;
		const baseZ = math.sin(a) * r;
		const gy = groundYAt(baseX, baseZ);
		// Tall stadium-scale masts keep the fixtures above the canyon silhouette
		// and make the pools read as arena fill rather than searchlights.
		const poleH = range(118, 136);

		// Pole.
		makePart(arena, {
			name: "FloodPole",
			size: new Vector3(3, poleH, 3),
			cframe: new CFrame(baseX, gy + poleH / 2, baseZ),
			color: METAL_DARK,
			material: Enum.Material.Metal,
		});

		// Wide lamp rack aimed down at the track ring. Its individual fixtures
		// overlap into a broad wash instead of resolving as one narrow beam.
		const headPos = new Vector3(baseX, gy + poleH, baseZ);
		const aimR = r - 105;
		const aimPoint = surfacePosition(a, aimR);
		const headCf = CFrame.lookAt(headPos, aimPoint);
		makePart(arena, {
			name: "FloodRack",
			size: new Vector3(36, 4.5, 2.5),
			cframe: headCf,
			color: METAL_DARK,
			material: Enum.Material.Metal,
		});

		// Six glowing lamp lenses, each with a real spotlight — these towers
		// are the arena's primary light source at night. Only one inner lamp per
		// rack casts shadows (shadowed lights are expensive; 12 is plenty).
		for (const offset of [-15, -9, -3, 3, 9, 15]) {
			const lensCf = headCf.mul(new CFrame(offset, 0, -1.2));
			const lens = makePart(arena, {
				name: "FloodLens",
				size: new Vector3(4, 3, 1),
				cframe: lensCf,
				color: Color3.fromRGB(255, 246, 220),
				material: Enum.Material.Neon,
			});
			const spot = new Instance("SpotLight");
			spot.Face = Enum.NormalId.Front;
			spot.Angle = 78;
			spot.Range = 60; // engine clamps Light.Range to 60 — the pool light below covers the rest
			spot.Brightness = 7;
			spot.Shadows = offset === -3;
			spot.Color = Color3.fromRGB(255, 236, 198);
			spot.Parent = lens;
		}

		// Faint visible light shaft from the rack down toward the pool. The wide,
		// very soft volume suggests dusty stadium light without a hard-edged
		// prison-searchlight beam.
		// Cylinder axis is X, so yaw the look-CFrame 90° to lay it along the beam.
		const shaftVec = aimPoint.sub(headPos);
		const shaftLen = shaftVec.Magnitude * 0.9;
		const shaftMid = headPos.add(shaftVec.Unit.mul(shaftLen / 2));
		makePart(arena, {
			name: "FloodShaft",
			shape: Enum.PartType.Cylinder,
			size: new Vector3(shaftLen, 11, 11),
			cframe: CFrame.lookAt(shaftMid, aimPoint).mul(CFrame.Angles(0, math.rad(90), 0)),
			color: Color3.fromRGB(255, 234, 190),
			material: Enum.Material.Neon,
			transparency: 0.988,
			canCollide: false,
			castShadow: false,
		});

		// 60 studs of range, so the spotlight cone alone never reaches the dirt.
		// The lamp head sits well beyond its ground pool but lights clamp at 60
		// studs of range, so the spotlight cone alone never reaches the dirt.
		// 60 studs of range, so the spotlight cone alone never reaches the dirt.
		// Roblox clamps every light to 60 studs, so three lower-intensity point
		// lights are spread tangentially across the track. Their overlap produces
		// one wide, soft pool without an overexposed hot spot in the centre.
		const tangent = new Vector3(-math.sin(a), 0, math.cos(a));
		for (const poolOffset of [-58, 0, 58]) {
			const poolHost = makePart(arena, {
				name: "FloodPool",
				size: new Vector3(1, 1, 1),
				cframe: new CFrame(aimPoint.add(tangent.mul(poolOffset)).add(new Vector3(0, 8, 0))),
				color: Color3.fromRGB(255, 232, 190),
				material: Enum.Material.Neon,
				transparency: 1,
				canCollide: false,
				castShadow: false,
			});
			const pool = new Instance("PointLight");
			pool.Color = Color3.fromRGB(255, 232, 190);
			pool.Brightness = poolOffset === 0 ? 4.5 : 3.5;
			pool.Range = 60;
			pool.Parent = poolHost;
		}

		// Warm glow point light so the tower head itself halos at night.
		const glow = new Instance("PointLight");
		glow.Color = Color3.fromRGB(255, 226, 180);
		glow.Brightness = 1.5;
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
	const y = groundYAt(math.cos(a) * r, math.sin(a) * r) + range(40, 52);
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

	// Signs are self-lit at night and spill their accent colour onto the rock.
	const light = new Instance("SurfaceLight");
	light.Face = Enum.NormalId.Front;
	light.Angle = 90;
	light.Range = 90;
	light.Brightness = 3;
	light.Color = accent;
	light.Parent = panel;
}

function buildBillboards(arena: Model) {
	// These angles sit on the four solid authored faces rather than across the
	// refinery, pylon, and water-tower skyline windows.
	makeBillboard(arena, 18, "FUEL UP. FIGHT. WIN.", Color3.fromRGB(255, 196, 60));
	makeBillboard(arena, 112, "DEMOLITION DERBY", Color3.fromRGB(255, 96, 64));
	makeBillboard(arena, 202, "NO RULES", Color3.fromRGB(255, 222, 120));
	makeBillboard(arena, 292, "LAST CAR ROLLING", Color3.fromRGB(120, 220, 255));
}

// ===========================================================================
// Desert vegetation: hundreds of dry scrub bushes, tumbleweeds and dead
// trees. All non-colliding, shadowless and cheap — pure dressing.
// ===========================================================================
function scrubBush(arena: Model, pos: Vector3) {
	const color = pick(SCRUB_COLORS);
	const clumps = rand() < 0.35 ? 2 : 1;
	for (let i = 0; i < clumps; i++) {
		const s = range(2.2, 5.5);
		makePart(arena, {
			name: "Scrub",
			size: new Vector3(s, s * range(0.5, 0.8), s * range(0.8, 1.2)),
			cframe: new CFrame(pos.add(new Vector3(range(-1.5, 1.5), s * 0.2, range(-1.5, 1.5)))).mul(
				CFrame.Angles(range(-0.2, 0.2), rand() * TWO_PI, range(-0.2, 0.2)),
			),
			color,
			material: Enum.Material.Grass,
			canCollide: false,
			castShadow: false,
		});
	}
}

function buildScrub(arena: Model) {
	for (let i = 0; i < 340; i++) {
		const a = rand() * TWO_PI;
		// Bias density outward: sparse on the salt pan, dense on the shoulder.
		const r = math.sqrt(rand()) * (CANYON_INNER_RADIUS - 20);
		if (r < 44) continue; // keep the derrick pad clear
		if (r < LAKEBED_INNER && rand() < 0.7) continue; // salt pan mostly bare
		if (r > LAKEBED_OUTER - 6 && r < FLOOR_RADIUS + 4 && rand() < 0.8) continue; // keep the track clean
		scrubBush(arena, surfacePosition(a, r));
	}

	// Tumbleweeds resting against berms and barriers.
	for (let i = 0; i < 22; i++) {
		const a = rand() * TWO_PI;
		const r = range(LAKEBED_INNER * 0.4, FLOOR_RADIUS + 30);
		const s = range(2.5, 4.5);
		makePart(arena, {
			name: "Tumbleweed",
			size: new Vector3(s, s, s),
			cframe: new CFrame(surfacePosition(a, r, s / 2)).mul(
				CFrame.Angles(rand() * TWO_PI, rand() * TWO_PI, 0),
			),
			color: Color3.fromRGB(142, 120, 80),
			material: Enum.Material.Grass,
			canCollide: false,
			castShadow: false,
		});
	}
}

function deadTree(arena: Model, pos: Vector3) {
	const h = range(11, 17);
	const lean = range(-0.12, 0.12);
	const trunkCf = new CFrame(pos.add(new Vector3(0, h / 2, 0))).mul(CFrame.Angles(lean, rand() * TWO_PI, lean));
	makeCylinder(arena, {
		name: "DeadTreeTrunk",
		height: h,
		diameter: range(1.4, 2.2),
		cframe: trunkCf,
		color: WOOD_DARK,
		material: Enum.Material.Wood,
		canCollide: false,
		castShadow: false,
	});
	const branches = 3 + math.floor(rand() * 3);
	for (let i = 0; i < branches; i++) {
		const startY = h * range(0.45, 0.9);
		const start = pos.add(new Vector3(0, startY, 0));
		const dir = new Vector3(math.cos(rand() * TWO_PI), range(0.7, 1.6), math.sin(rand() * TWO_PI));
		const tip = start.add(dir.Unit.mul(range(4, 8)));
		makeBeam(arena, start, tip, 0.7, WOOD_DARK, Enum.Material.Wood, "DeadTreeBranch");
	}
}

function buildDeadTrees(arena: Model) {
	for (let i = 0; i < 16; i++) {
		const a = rand() * TWO_PI;
		const r = range(FLOOR_RADIUS + 14, CANYON_INNER_RADIUS - 26);
		deadTree(arena, surfacePosition(a, r));
	}
	for (let i = 0; i < 5; i++) {
		const a = rand() * TWO_PI;
		const r = range(LAKEBED_INNER + 8, LAKEBED_OUTER - 12);
		deadTree(arena, surfacePosition(a, r));
	}
}

// ===========================================================================
// Demolition-arena dressing (from the concept art): tire stacks, junk piles,
// wrecked car shells and a couple of rusty shacks scattered across the pit.
// ===========================================================================
function tireStack(arena: Model, pos: Vector3) {
	const layers = 3 + math.floor(rand() * 3);
	for (let i = 0; i < layers; i++) {
		makeCylinder(arena, {
			name: "Tire",
			height: 1.6,
			diameter: 4.6,
			cframe: new CFrame(pos.add(new Vector3(range(-0.4, 0.4), 0.8 + i * 1.6, range(-0.4, 0.4)))),
			color: Color3.fromRGB(32, 32, 34),
			material: Enum.Material.SmoothPlastic,
		});
	}
}

function junkPile(arena: Model, pos: Vector3) {
	// Dirt mound with rusted scrap half-buried in it.
	makePart(arena, {
		name: "JunkMound",
		size: new Vector3(range(14, 22), range(4, 7), range(12, 18)),
		cframe: new CFrame(pos).mul(CFrame.Angles(range(-0.1, 0.1), rand() * TWO_PI, range(-0.1, 0.1))),
		color: DIRT_DARK,
		material: Enum.Material.Ground,
	});
	for (let i = 0; i < 2 + math.floor(rand() * 2); i++) {
		makePart(arena, {
			name: "Scrap",
			size: new Vector3(range(3, 8), range(1, 3), range(3, 7)),
			cframe: new CFrame(pos.add(new Vector3(range(-6, 6), range(2, 5), range(-5, 5)))).mul(
				CFrame.Angles(rand(), rand() * TWO_PI, rand()),
			),
			color: RUST,
			material: Enum.Material.CorrodedMetal,
		});
	}
}

function carWreck(arena: Model, pos: Vector3, yaw: number) {
	const cf = new CFrame(pos).mul(CFrame.Angles(range(-0.08, 0.08), yaw, range(-0.15, 0.15)));
	makePart(arena, {
		name: "WreckBody",
		size: new Vector3(6, 2.4, 10),
		cframe: cf.mul(new CFrame(0, 1, 0)),
		color: pick([RUST, Color3.fromRGB(96, 88, 78), Color3.fromRGB(80, 90, 100)]),
		material: Enum.Material.CorrodedMetal,
	});
	makePart(arena, {
		name: "WreckCabin",
		size: new Vector3(5, 1.8, 5),
		cframe: cf.mul(new CFrame(0, 3.1, 0.5)),
		color: Color3.fromRGB(50, 46, 44),
		material: Enum.Material.CorrodedMetal,
	});
}

function shack(arena: Model, pos: Vector3, yaw: number) {
	const cf = new CFrame(pos).mul(CFrame.Angles(0, yaw, 0));
	makePart(arena, {
		name: "ShackWalls",
		size: new Vector3(14, 8, 10),
		cframe: cf.mul(new CFrame(0, 4, 0)),
		color: WOOD,
		material: Enum.Material.WoodPlanks,
	});
	makePart(arena, {
		name: "ShackRoof",
		size: new Vector3(16, 0.8, 12),
		cframe: cf.mul(new CFrame(0, 8.6, 0)).mul(CFrame.Angles(0, 0, math.rad(4))),
		color: RUST,
		material: Enum.Material.CorrodedMetal,
	});
	makePart(arena, {
		name: "ShackDoor",
		size: new Vector3(3, 5.5, 0.3),
		cframe: cf.mul(new CFrame(2, 2.75, 5)),
		color: Color3.fromRGB(20, 18, 16),
		material: Enum.Material.SmoothPlastic,
		canCollide: false,
	});
}

function buildJunk(arena: Model) {
	for (let i = 0; i < 9; i++) {
		const a = rand() * TWO_PI;
		const r = range(60, LAKEBED_OUTER - 16);
		tireStack(arena, surfacePosition(a, r));
	}
	for (let i = 0; i < 6; i++) {
		const a = rand() * TWO_PI;
		const r = range(70, LAKEBED_OUTER - 24);
		junkPile(arena, surfacePosition(a, r, 1));
	}
	for (let i = 0; i < 4; i++) {
		const a = rand() * TWO_PI;
		const r = range(90, LAKEBED_INNER + 40);
		carWreck(arena, surfacePosition(a, r), rand() * TWO_PI);
	}
	shack(arena, surfacePosition(math.rad(200), 400), 0.6);
	shack(arena, surfacePosition(math.rad(20), 420), 3.5);
}

// ===========================================================================
// Ambient dust: soft tan plumes drifting across the pit on the wind.
// ===========================================================================
function buildDust(arena: Model) {
	for (let i = 0; i < 5; i++) {
		const a = (i / 5) * TWO_PI + 0.4;
		const r = range(120, FLOOR_RADIUS - 40);
		const host = makePart(arena, {
			name: "DustHost",
			size: new Vector3(60, 1, 60),
			cframe: new CFrame(surfacePosition(a, r, 3)),
			color: DIRT,
			material: Enum.Material.Plastic,
			transparency: 1,
			canCollide: false,
			castShadow: false,
		});
		const dust = new Instance("ParticleEmitter");
		dust.Texture = "rbxasset://textures/particles/smoke_main.dds";
		dust.Rate = 1.5;
		dust.Lifetime = new NumberRange(9, 15);
		dust.Speed = new NumberRange(3, 6);
		dust.EmissionDirection = Enum.NormalId.Top;
		dust.SpreadAngle = new Vector2(40, 40);
		dust.Acceleration = WIND;
		dust.Rotation = new NumberRange(0, 360);
		dust.RotSpeed = new NumberRange(-6, 6);
		dust.Color = new ColorSequence(Color3.fromRGB(172, 142, 108));
		dust.Size = new NumberSequence([new NumberSequenceKeypoint(0, 18), new NumberSequenceKeypoint(1, 46)]);
		dust.Transparency = new NumberSequence([
			new NumberSequenceKeypoint(0, 0.82),
			new NumberSequenceKeypoint(0.5, 0.9),
			new NumberSequenceKeypoint(1, 1),
		]);
		dust.LightEmission = 0.05;
		dust.LightInfluence = 1; // dust goes dark in shadow and glows inside the floodlight pools
		dust.Parent = host;
	}
}

// ===========================================================================
// Player spawn pad, placed on the track right behind the car so you start
// standing next to it.
// ===========================================================================
function buildSpawn(arena: Model) {
	const carPos = SPAWN_CFRAME.Position;
	const back = SPAWN_CFRAME.LookVector.mul(-16); // 16 studs behind the car
	const padX = carPos.X + back.X;
	const padZ = carPos.Z + back.Z;
	const padPos = new Vector3(padX, groundYAt(padX, padZ) + 0.5, padZ);
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
	// A previous session can leave ArenaReady=true persisted in the place file;
	// clear it so nothing waiting on the attribute races the rebuild.
	Workspace.SetAttribute("ArenaReady", false);

	const existing = Workspace.FindFirstChild(ARENA_NAME);
	if (existing) existing.Destroy();

	// Remove the default flat baseplate if present.
	const baseplate = Workspace.FindFirstChild("Baseplate");
	if (baseplate) baseplate.Destroy();

	// Remove stray spawn points from the baseplate template — otherwise players
	// can spawn at them (centre of the basin) instead of the arena's pad by the car.
	for (const child of Workspace.GetChildren()) {
		if (child.IsA("SpawnLocation")) child.Destroy();
	}

	const arena = new Instance("Model");
	arena.Name = ARENA_NAME;
	arena.Parent = Workspace;

	setupLighting();
	buildGround();
	buildBoundaryCollision(arena);
	// Cars may spawn once both terrain and the simple containment surface are
	// complete; all remaining builders are cosmetic or existing landmarks.
	Workspace.SetAttribute("ArenaReady", true);
	buildBoundaryFooting(arena);
	buildCanyon(arena);
	buildMesas(arena);
	buildRefinery(arena);
	buildPylons(arena);
	buildWaterTower(arena);
	buildWindmill(arena);
	buildDerrick(arena);
	buildFloodlights(arena);
	buildBillboards(arena);
	buildScrub(arena);
	buildDeadTrees(arena);
	buildJunk(arena);
	buildDust(arena);
	buildSpawn(arena);
}

buildArena();
