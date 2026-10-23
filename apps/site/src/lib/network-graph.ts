// The Solus Cloud drawing, in two zones on one floor. On the left, your own
// network: a fleet of your machines that a laptop on the same network reaches
// directly, offline and with no account. On the right, everything else: each
// device links up to Solus Cloud, and Solus Cloud links out to every host.
// The laptop in your network links to Solus Cloud too, so it reaches both.
// Far rows draw smaller and fainter, which gives the floor its depth.

export interface Place {
	/** A mark from `tool-marks.ts`, or "Solus" for a host Solus runs. */
	mark: string;
	label: string;
	detail: string;
}

export interface Row {
	kind: "device" | "host";
	/** "local" rows sit in your network and link directly; "cloud" rows link through Solus Cloud. */
	via: "local" | "cloud";
	y: number;
	/** 0 for the farthest row, 1 for the nearest. */
	nearness: number;
	/** The x of the first and last node; one node sits at their middle. */
	from: number;
	to: number;
	places: Place[];
}

export interface Zone {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Stage {
	width: number;
	height: number;
	cloud: { x: number; y: number; r: number };
	/** Your network, drawn as a dashed region of the floor. */
	zone: Zone;
	rows: Row[];
}

export interface Node extends Place {
	kind: Row["kind"];
	via: Row["via"];
	x: number;
	y: number;
	nearness: number;
	scale: number;
}

const office = { mark: "Apple", label: "Maya's MacBook Pro", detail: "Mac app" };

const fleet: Place[] = [
	{ mark: "Linux", label: "rack-01", detail: "Linux, on-prem" },
	{ mark: "Linux", label: "rack-02", detail: "Linux, on-prem" },
	{ mark: "Apple", label: "mac-studio", detail: "Mac Studio" },
	{ mark: "Ubuntu", label: "gpu-box", detail: "Ubuntu, 2× A100" },
	{ mark: "Apple", label: "ci-mini", detail: "Mac mini" },
	{ mark: "Raspberry Pi", label: "lab-pi", detail: "Raspberry Pi" },
];

const remoteDevices: Place[] = [
	{ mark: "Apple", label: "Sam's iPhone", detail: "iOS" },
	{ mark: "Chrome", label: "Ada in Chrome", detail: "Web" },
	{ mark: "Android", label: "Priya's Pixel", detail: "Android" },
	{ mark: "Apple", label: "Jo's iPad", detail: "iPadOS" },
];

const cloudHosts: Place[] = [
	{ mark: "AWS", label: "build-01", detail: "AWS, us-east-1" },
	{ mark: "Solus", label: "agents-01", detail: "Run by Solus" },
	{ mark: "Google Cloud", label: "staging", detail: "Google Cloud" },
	{ mark: "Azure", label: "dev-vm", detail: "Azure, westeurope" },
	{ mark: "Solus", label: "agents-02", detail: "Run by Solus" },
	{ mark: "DigitalOcean", label: "edge-02", detail: "DigitalOcean" },
];

export const wideStage: Stage = {
	width: 1200,
	height: 640,
	cloud: { x: 840, y: 340, r: 34 },
	zone: { x: 16, y: 44, width: 452, height: 580 },
	rows: [
		{ kind: "host", via: "local", y: 160, nearness: 0.15, from: 110, to: 374, places: fleet.slice(0, 3) },
		{ kind: "host", via: "local", y: 262, nearness: 0.45, from: 100, to: 384, places: fleet.slice(3) },
		{ kind: "device", via: "local", y: 552, nearness: 1, from: 242, to: 242, places: [office] },
		{ kind: "host", via: "cloud", y: 78, nearness: 0, from: 610, to: 1070, places: cloudHosts.slice(3) },
		{ kind: "host", via: "cloud", y: 176, nearness: 0.35, from: 580, to: 1100, places: cloudHosts.slice(0, 3) },
		{ kind: "device", via: "cloud", y: 552, nearness: 1, from: 600, to: 1090, places: remoteDevices },
	],
};

export const narrowStage: Stage = {
	width: 360,
	height: 700,
	cloud: { x: 180, y: 196, r: 24 },
	zone: { x: 8, y: 404, width: 344, height: 290 },
	rows: [
		{ kind: "host", via: "cloud", y: 50, nearness: 0.2, from: 70, to: 290, places: [cloudHosts[0], cloudHosts[1], cloudHosts[2]] },
		{ kind: "device", via: "cloud", y: 318, nearness: 1, from: 110, to: 250, places: [remoteDevices[0], remoteDevices[1]] },
		{ kind: "host", via: "local", y: 486, nearness: 0.5, from: 70, to: 290, places: [fleet[0], fleet[3], fleet[4]] },
		{ kind: "device", via: "local", y: 620, nearness: 1, from: 180, to: 180, places: [office] },
	],
};

/** Every node on a stage, row by row in the order the stage lists them. */
export function stageNodes(stage: Stage): Node[] {
	return stage.rows.flatMap((row) =>
		row.places.map((place, index) => {
			const step = row.places.length > 1 ? (row.to - row.from) / (row.places.length - 1) : 0;
			return {
				...place,
				kind: row.kind,
				via: row.via,
				x: row.places.length > 1 ? row.from + step * index : (row.from + row.to) / 2,
				y: row.y,
				nearness: row.nearness,
				scale: 0.72 + 0.28 * row.nearness,
			};
		}),
	);
}

/** How far above a node's centre its top edge sits: half a chip, or half a disc. */
function topEdge(node: Node, wide: boolean) {
	return (wide ? 23 : 21) * node.scale;
}

/** How far below a node's centre its bottom edge sits; a disc's name sits under it. */
function bottomEdge(node: Node, wide: boolean) {
	return (wide ? 23 : 44) * node.scale;
}

/**
 * A link through Solus Cloud: from the top of a device up into the cloud, or
 * from the cloud out to the bottom of a host.
 */
export function cloudPath(stage: Stage, node: Node, wide: boolean) {
	const { x, y, r } = stage.cloud;
	if (node.kind === "device") {
		const fromY = node.y - topEdge(node, wide);
		const bend = Math.min(90, (fromY - y - r) / 2);
		return `M${node.x} ${fromY} C ${node.x} ${fromY - bend}, ${x} ${y + r + bend}, ${x} ${y + r}`;
	}
	const toY = node.y + bottomEdge(node, wide);
	const bend = Math.min(70, (y - r - toY) / 2);
	return `M${x} ${y - r} C ${x} ${y - r - bend}, ${node.x} ${toY + bend}, ${node.x} ${toY}`;
}

/** A direct link inside your network: from the top of the laptop to the bottom of a host. */
export function localPath(device: Node, host: Node, wide: boolean) {
	const fromY = device.y - topEdge(device, wide);
	const toY = host.y + bottomEdge(host, wide);
	const bend = (fromY - toY) / 2;
	return `M${device.x} ${fromY} C ${device.x} ${fromY - bend}, ${host.x} ${toY + bend}, ${host.x} ${toY}`;
}

/** The floor: lines that run to a vanishing point far behind the hosts. */
export function floorLines(stage: Stage) {
	const vanish = { x: stage.width / 2, y: -stage.height * 0.9 };
	const count = 14;
	const rays = Array.from({ length: count + 1 }, (_, index) => {
		const x = (stage.width * 1.5 * index) / count - stage.width * 0.25;
		return `M${vanish.x} ${vanish.y} L${x} ${stage.height}`;
	});
	// Rows of the floor get closer together toward the back.
	const rungs = Array.from({ length: 9 }, (_, index) => {
		const depth = (index + 1) / 9;
		const y = stage.height * depth * depth;
		return `M0 ${y} H${stage.width}`;
	});
	return [...rays, ...rungs];
}

/** A chip's width: its mark, then the longer of its two lines of text. */
export function chipWidth(node: Place) {
	return 44 + Math.max(node.label.length * 7.3, node.detail.length * 6.3) + 14;
}
