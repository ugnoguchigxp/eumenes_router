/**
 * The structure evaluation set (plan §7, §10 M3b): which part of an utterance is the request, which parts are
 * references, how many requests there are, and where the turn should go.
 *
 *   bun bench/router/structure.ts build --src <pairs.src.txt> [--real <real.src.txt>] --db <corr.db> --out <items.jsonl>
 *        [--rows <route rows.jsonl>] [--rows-hints <route rows.jsonl>]
 *   bun bench/router/structure.ts requests --items <items.jsonl> [--structures <tag>=<file>,…] --out <rows.jsonl>
 *   bun bench/router/structure.ts score --items <items.jsonl> --routes <route out.jsonl>,… [--hinted <route out.jsonl>]
 *        [--structures <tag>=<file>,…] --out <report.json>
 *   bun bench/router/structure.ts test-parts --rows <route rows.jsonl> --structures <tag>=<file> --out <rows.jsonl>
 *   bun bench/router/structure.ts test-score --db <bench.db> --rows <route rows.jsonl> --structures <tag>=<file>
 *        --routes <route out.jsonl>,… --out <report.json>   today's test top-1 with and without the structure stage
 *
 * Source lines: `family pair text => tool[request|target|inputs|after] ; …` (the file's own header explains them).
 * The destination follows from the requests: none → conversation, two or more different tools → the pipeline stage,
 * otherwise that one tool (several requests to the same tool stay inside it). `build` refuses a line whose spans are
 * not in the text, whose tools are not in the catalog, or whose shape does not fit its family. `--rows` writes the
 * input of `router route`; `--rows-hints` the same with the referenced resource's kind as the host would pass it.
 * `requests` lists the request parts the router must route for the gold structures (S*) and the analyzers' ones;
 * `score` decides every item per method (S0 = today's whole-utterance routing; S* and analyzers = decideStructure on
 * the routed parts) and writes counts only, no text.
 */
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CONVERSATION_ID } from "../../src/index.ts";
import { sha256Hex } from "../../src/digest.ts";
import type { Utterance } from "./data.ts";

export type Request = {
	text: string;
	target: string | null;
	inputs: string[];
	after: number[];
	tool: string;
};
export type Kind =
	| "single-ref"
	| "single-embedded"
	| "single"
	| "single-modifier"
	| "single-same-tool"
	| "multi-seq"
	| "multi-par"
	| "none";
export type StructureItem = {
	id: string;
	source: "pairs" | "real";
	split: string | null;
	family: string;
	pair: string | null;
	kind: Kind;
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
	/** The real utterance's hints (the written pairs have none). */
	hints: Record<string, unknown> | null;
	gold: {
		route: "tool" | "pipeline" | "conversation";
		tool: string | null;
		/** The tool of what the request refers to, when that is another tool's domain (single-ref only). */
		referenceTool: string | null;
		requests: Request[];
	};
};

const KINDS: ReadonlyArray<[RegExp, Kind]> = [
	[/^A\d$/, "single-ref"],
	[/^K$/, "single-embedded"],
	[/^B$/, "single"],
	[/^B2$/, "single-modifier"],
	[/^S$/, "single-same-tool"],
	[/^C\d$/, "multi-seq"],
	[/^D\d$/, "multi-par"],
	[/^E\d$/, "none"],
];

/** The domain of a referenced thing: the tool that makes it, the previous agent turn, the resource kind. */
const DOMAINS: ReadonlyArray<{
	words: RegExp;
	tool: string;
	previous: string;
	resource: string | null;
}> = [
	{
		words: /3D|立体/,
		tool: "model3d.studio",
		previous: "3Dモデルを作りました。",
		resource: null,
	},
	{
		words: /スクリーンショット/,
		tool: "browser.capture",
		previous: "画面を撮影しました。",
		resource: "image",
	},
	{
		words: /写真/,
		tool: "image.create",
		previous: "写真を受け取りました。",
		resource: "image",
	},
	{
		words: /画像|イラスト|絵|イメージ|ビジュアル|サムネ/,
		tool: "image.create",
		previous: "画像を作りました。",
		resource: "image",
	},
	{
		words: /曲|音楽|BGM|効果音|音/,
		tool: "music.create",
		previous: "曲を作りました。",
		resource: "audio",
	},
	{
		words: /画面|UI/,
		tool: "ui.compose",
		previous: "画面を作りました。",
		resource: null,
	},
	{
		words: /図/,
		tool: "excalidraw.edit",
		previous: "図を描きました。",
		resource: null,
	},
];
const domainOf = (phrase: string) =>
	DOMAINS.find((d) => d.words.test(phrase)) ?? null;
/** A reference to something the conversation already has (not to another request of the same utterance). */
const earlier = (phrase: string) => /^(この|さっき)/.test(phrase);

function parseRequest(raw: string, line: number): Request {
	const m = /^([\w.-]+)\[(.*)\]$/.exec(raw.trim());
	if (!m) throw new Error(`line ${line}: bad request "${raw}"`);
	const [text = "", target = "", inputs = "", after = ""] = m[2]!.split("|");
	return {
		tool: m[1]!,
		text,
		target: target || null,
		inputs: inputs ? inputs.split(",") : [],
		after: after ? after.split(",").map(Number) : [],
	};
}

/** A real utterance of the bench database, found by the start of its id. */
export type Resolved = {
	id: string;
	split: string;
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
	hints: Record<string, unknown>;
	/** The bench label's answer (conversation.respond when none). */
	label: string;
};

/**
 * Items from source lines. Without `resolve` a line carries its text (the written pairs); with it a line starts with
 * the start of a real utterance's id instead, and the text, the context and the label come from the bench database.
 */
export function parseSource(
	source: string,
	tools: ReadonlySet<string>,
	resolve?: (key: string) => Resolved,
): StructureItem[] {
	const items: StructureItem[] = [];
	const seen = new Set<string>();
	source.split("\n").forEach((raw, index) => {
		const line = index + 1;
		if (!raw.trim() || raw.startsWith("#")) return;
		const [left = "", right = ""] = raw.split(/ =>(?: |$)/);
		const m = resolve
			? /^(\S+) (\S+) (\S+)$/.exec(left.trim())
			: /^(\S+) (\S+) (.+)$/.exec(left.trim());
		if (!m) throw new Error(`line ${line}: bad item`);
		const real = resolve ? resolve(m[1]!) : null;
		const [family = "", pair = ""] = real ? [m[2], m[3]] : [m[1], m[2]];
		const text = real ? real.text : (m[3] ?? "");
		const kind = KINDS.find(([re]) => re.test(family))?.[1];
		if (!kind) throw new Error(`line ${line}: unknown family ${family}`);
		if (seen.has(text)) throw new Error(`line ${line}: duplicate text`);
		seen.add(text);
		const requests = right.trim()
			? right.split(" ; ").map((r) => parseRequest(r, line))
			: [];
		requests.forEach((r, i) => {
			if (!tools.has(r.tool))
				throw new Error(`line ${line}: unknown tool ${r.tool}`);
			for (const span of [r.text, r.target ?? "", ...r.inputs])
				if (span && !text.includes(span))
					throw new Error(`line ${line}: "${span}" is not in the text`);
			if (r.after.some((a) => !Number.isInteger(a) || a < 0 || a >= i))
				throw new Error(`line ${line}: after must name earlier requests`);
		});
		const distinct = new Set(requests.map((r) => r.tool));
		const route =
			requests.length === 0
				? "conversation"
				: distinct.size >= 2
					? "pipeline"
					: "tool";
		const fits: Record<Kind, boolean> = {
			"single-ref": requests.length === 1 && requests[0]!.inputs.length > 0,
			"single-embedded": requests.length === 1,
			single: requests.length === 1 && !requests[0]!.inputs.length,
			"single-modifier": requests.length === 1 && !requests[0]!.inputs.length,
			"single-same-tool": requests.length >= 2 && distinct.size === 1,
			"multi-seq":
				route === "pipeline" && requests.some((r) => r.after.length > 0),
			"multi-par":
				route === "pipeline" && requests.every((r) => !r.after.length),
			none: requests.length === 0,
		};
		if (!fits[kind])
			throw new Error(`line ${line}: the requests do not fit ${family}`);
		const input = requests[0]?.inputs[0] ?? null;
		const ref =
			kind === "single-ref" && input ? domainOf(input.slice(2)) : null;
		// The thing the turn refers to: the request's first input, or the utterance's opening phrase ("この曲、…").
		const opening = text.split(/[、。]/)[0] ?? "";
		const said =
			input && earlier(input) ? input : earlier(opening) ? opening : null;
		const answer =
			route === "conversation"
				? CONVERSATION_ID
				: route === "tool"
					? requests[0]!.tool
					: null;
		if (real && answer !== real.label)
			throw new Error(`line ${line}: ${answer} is not the label ${real.label}`);
		items.push({
			id: real ? real.id : `st-${String(items.length + 1).padStart(3, "0")}`,
			source: real ? "real" : "pairs",
			split: real ? real.split : null,
			family,
			pair: pair === "-" ? null : pair,
			kind,
			text,
			previousAgent: real
				? real.previousAgent
				: said
					? (domainOf(said)?.previous ?? null)
					: null,
			previousUser: real ? real.previousUser : null,
			hints: real ? real.hints : null,
			gold: {
				route,
				tool: route === "tool" ? requests[0]!.tool : null,
				referenceTool: ref && ref.tool !== requests[0]!.tool ? ref.tool : null,
				requests,
			},
		});
	});
	return items;
}

/** The kind of the referenced resource the host would pass (`hints.referencedResource`), when it is one. */
export function referencedResource(item: StructureItem): string | null {
	const input = item.gold.requests[0]?.inputs.find(earlier);
	return input ? (domainOf(input.slice(2))?.resource ?? null) : null;
}

function row<T>(map: Map<string, T>, key: string, blank: () => T): T {
	const found = map.get(key);
	if (found) return found;
	const made = blank();
	map.set(key, made);
	return made;
}

type Prediction = { id: string; text: string; tool: string; defer: boolean };

/** A structure as the analyzer returns it (plan §10 M3b); null when it broke the contract. */
export type Structure = {
	requests: ReadonlyArray<{
		text: string;
		target?: string | null;
		inputs?: readonly string[];
		after?: readonly number[];
	}>;
} | null;

export type Decision = {
	route: "tool" | "pipeline" | "conversation";
	tool: string | null;
	/** The tools of the routed parts, conversation left out. */
	tools: string[];
	/** The structure broke the contract: the whole utterance was routed as today. */
	fallback: boolean;
};

/**
 * How a request part is routed. span: the part as cut out. borrow: also, a part that is only its object borrows the
 * next part's predicate. mask: also, one request with references routes the whole utterance with them masked.
 */
export type PartMode = "span" | "borrow" | "mask";
export const PART_MODES: readonly PartMode[] = ["span", "borrow", "mask"];

/** The texts the router routes for a structure: the whole utterance, or the request parts. */
export function routedTexts(
	text: string,
	s: Structure,
	mode: PartMode = "span",
): string[] {
	if (!s) return [text];
	const [first, ...rest] = s.requests;
	if (!first) return [];
	if (!rest.length) {
		if (!first.inputs?.length) return [text];
		if (mode !== "mask") return [first.text];
		// The whole utterance with its references masked: the request's wording stays, the referenced domain goes.
		return [
			[...first.inputs]
				.sort((a, b) => b.length - a.length)
				.reduce((t, input) => t.split(input).join("これ"), text),
		];
	}
	if (mode === "span") return s.requests.map((r) => r.text);
	// A request that is only its object ("曲" in "曲と画像を作って") borrows the predicate of the next one that has one.
	return s.requests.map((r, i) => {
		if (!r.target || r.text !== r.target) return r.text;
		const next = s.requests
			.slice(i + 1)
			.find(
				(n) => n.target && n.text.startsWith(n.target) && n.text !== n.target,
			);
		return next ? r.text + next.text.slice(next.target!.length) : r.text;
	});
}

/**
 * Where the turn goes with a structure (plan §10 M3b): no request → conversation; one request → that part routed (the
 * whole utterance when it refers to nothing); requests of two or more tools → the pipeline stage; requests of one tool
 * stay with it. A broken structure routes the whole utterance, as today.
 */
export function decideStructure(
	text: string,
	s: Structure,
	routeOf: (text: string) => string,
	mode: PartMode = "span",
): Decision {
	const tools = [
		...new Set(
			routedTexts(text, s, mode)
				.map(routeOf)
				.filter((t) => t !== CONVERSATION_ID),
		),
	];
	const fallback = !s;
	if (tools.length >= 2)
		return { route: "pipeline", tool: null, tools, fallback };
	if (tools.length === 1)
		return { route: "tool", tool: tools[0]!, tools, fallback };
	return { route: "conversation", tool: CONVERSATION_ID, tools, fallback };
}

/** Whether a decision is the gold one: the tool, the conversation, or the pipeline stage with the same tools. */
export function rightDecision(item: StructureItem, d: Decision): boolean {
	if (d.route !== item.gold.route) return false;
	if (d.route === "tool") return d.tool === item.gold.tool;
	if (d.route === "conversation") return true;
	const gold = new Set(item.gold.requests.map((r) => r.tool));
	return gold.size === d.tools.length && d.tools.every((t) => gold.has(t));
}

type Tally = {
	n: number;
	right: number;
	routeRight: number;
	countRight: number;
	referenceSide: number;
	toPipeline: number;
	fallback: number;
};
const blank = (): Tally => ({
	n: 0,
	right: 0,
	routeRight: 0,
	countRight: 0,
	referenceSide: 0,
	toPipeline: 0,
	fallback: 0,
});

/** Counts only (no text): by source and kind, by family, the written pairs both right, the wrong ids. */
export function scoreDecisions(
	items: readonly StructureItem[],
	decide: (item: StructureItem) => { decision: Decision; count: number | null },
) {
	const byKind = new Map<string, Tally>();
	const byFamily = new Map<string, Tally>();
	const pairs = new Map<string, boolean[]>();
	const wrong: Array<{ id: string; gold: string; got: string }> = [];
	for (const item of items) {
		const { decision: d, count } = decide(item);
		const right = rightDecision(item, d);
		for (const t of [
			row(byKind, `${item.source}:${item.kind}`, blank),
			row(byFamily, `${item.source}:${item.family}`, blank),
		]) {
			t.n++;
			if (right) t.right++;
			if (d.route === item.gold.route) t.routeRight++;
			if (count === item.gold.requests.length) t.countRight++;
			if (item.gold.referenceTool && d.tool === item.gold.referenceTool)
				t.referenceSide++;
			if (d.route === "pipeline") t.toPipeline++;
			if (d.fallback) t.fallback++;
		}
		if (item.pair)
			pairs.set(item.pair, [...(pairs.get(item.pair) ?? []), right]);
		if (!right)
			wrong.push({
				id: item.id,
				gold:
					item.gold.route === "pipeline"
						? `pipeline:${item.gold.requests.map((r) => r.tool).join("+")}`
						: (item.gold.tool ?? CONVERSATION_ID),
				got: d.route === "pipeline" ? `pipeline:${d.tools.join("+")}` : d.tool!,
			});
	}
	const both = [...pairs.values()].filter((v) => v.length === 2);
	return {
		byKind: Object.fromEntries(byKind),
		byFamily: Object.fromEntries(byFamily),
		pairsBothRight: {
			pairs: both.length,
			right: both.filter((v) => v.every(Boolean)).length,
		},
		wrong,
	};
}

if (import.meta.main) {
	const { values: v, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			src: { type: "string" },
			real: { type: "string" },
			db: { type: "string" },
			out: { type: "string" },
			rows: { type: "string" },
			"rows-hints": { type: "string" },
			items: { type: "string" },
			routes: { type: "string" },
			hinted: { type: "string" },
			structures: { type: "string" },
		},
	});
	const need = (x: string | undefined, name: string) => {
		if (!x) throw new Error(`--${name} is required`);
		return x;
	};
	const jsonl = (rows: readonly unknown[]) =>
		rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
	if (positionals[0] === "build") {
		// Only read; not opened read-only, which cannot open a WAL database without its shared-memory file.
		const db = new Database(need(v.db, "db"));
		const tools = new Set(
			(
				db.query("SELECT id FROM bench_cards").all() as Array<{ id: string }>
			).map((r) => r.id),
		);
		const utterances = (
			db
				.query("SELECT id, utterance_json FROM bench_utterances")
				.all() as Array<{
				id: string;
				utterance_json: string;
			}>
		).map((r) => ({ id: r.id, u: JSON.parse(r.utterance_json) as Utterance }));
		const labels = new Map(
			(
				db
					.query(
						"SELECT utterance_id AS id, split, label_json FROM bench_labels",
					)
					.all() as Array<{ id: string; split: string; label_json: string }>
			).map((r) => {
				const l = JSON.parse(r.label_json) as {
					gold: string | null;
					none?: boolean;
				};
				return [
					r.id,
					{ split: r.split, label: l.none ? CONVERSATION_ID : (l.gold ?? "") },
				];
			}),
		);
		db.close();
		const resolve = (key: string): Resolved => {
			const found = utterances.filter((r) => r.id.startsWith(key));
			const label = found.length === 1 ? labels.get(found[0]!.id) : undefined;
			if (!label) throw new Error(`${key}: not one labeled utterance`);
			const { u } = found[0]!;
			return {
				id: found[0]!.id,
				split: label.split,
				text: u.text,
				previousAgent: u.previousAgent,
				previousUser: u.previousUser,
				hints: u.hints as Record<string, unknown>,
				label: label.label,
			};
		};
		const items = [
			...parseSource(readFileSync(need(v.src, "src"), "utf8"), tools),
			...(v.real
				? parseSource(readFileSync(v.real, "utf8"), tools, resolve)
				: []),
		];
		writeFileSync(need(v.out, "out"), jsonl(items));
		// A real utterance keeps its own context; a written one gets the resource kind only in the hinted rows.
		const row = (item: StructureItem, hinted: boolean) => {
			const kind = hinted ? referencedResource(item) : null;
			const hints =
				item.hints ?? (kind ? { referencedResource: { kind } } : null);
			return {
				id: item.id,
				text: item.text,
				...(item.previousUser ? { prev: item.previousUser } : {}),
				...(hints ? { hints } : {}),
			};
		};
		if (v.rows) writeFileSync(v.rows, jsonl(items.map((i) => row(i, false))));
		if (v["rows-hints"])
			writeFileSync(v["rows-hints"], jsonl(items.map((i) => row(i, true))));
		const count = (key: (i: StructureItem) => string) =>
			items.reduce<Record<string, number>>(
				(acc, i) => ({ ...acc, [key(i)]: (acc[key(i)] ?? 0) + 1 }),
				{},
			);
		console.log(
			JSON.stringify({
				items: items.length,
				kind: count((i) => i.kind),
				route: count((i) => i.gold.route),
				withPrevious: items.filter((i) => i.previousAgent).length,
				withResource: items.filter((i) => referencedResource(i)).length,
			}),
		);
	} else if (positionals[0] === "requests" || positionals[0] === "score") {
		const lines = (file: string) =>
			readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
		const items = lines(need(v.items, "items")) as unknown as StructureItem[];
		// Structures by method: the gold one (S*) and each analyzer's file ({id, structure, prompt, completion}).
		const methods = new Map<
			string,
			Map<string, { s: Structure; tokens: number }>
		>();
		methods.set(
			"S*",
			new Map(
				items.map((i) => [
					i.id,
					{ s: { requests: i.gold.requests }, tokens: 0 },
				]),
			),
		);
		for (const spec of (v.structures ?? "").split(",").filter(Boolean)) {
			const [tag = "", file = ""] = spec.split("=");
			methods.set(
				tag,
				new Map(
					lines(file).map((r) => [
						r["id"] as string,
						{
							s: (r["structure"] ?? null) as Structure,
							tokens: Number(r["prompt"] ?? 0) + Number(r["completion"] ?? 0),
						},
					]),
				),
			);
		}
		if (positionals[0] === "requests") {
			// The request parts to route besides the whole utterances (today's rows already route those).
			const whole = new Set(items.map((i) => i.text));
			const texts = new Set<string>();
			for (const structures of methods.values())
				for (const item of items) {
					const got = structures.get(item.id);
					if (!got) throw new Error(`no structure for ${item.id}`);
					for (const mode of PART_MODES)
						for (const t of routedTexts(item.text, got.s, mode))
							if (!whole.has(t)) texts.add(t);
				}
			writeFileSync(
				need(v.out, "out"),
				jsonl(
					[...texts].map((text) => ({
						id: `rq-${sha256Hex(text).slice(0, 12)}`,
						text,
					})),
				),
			);
			console.log(JSON.stringify({ requests: texts.size }));
		} else {
			const routed = new Map<string, string>();
			for (const file of need(v.routes, "routes").split(","))
				for (const p of lines(file) as unknown as Prediction[])
					routed.set(p.text, p.tool);
			const routeOf = (text: string) => {
				const tool = routed.get(text);
				if (!tool) throw new Error("a routed text has no routing");
				return tool;
			};
			const today = (tool: string): Decision =>
				tool === CONVERSATION_ID
					? { route: "conversation", tool, tools: [], fallback: false }
					: { route: "tool", tool, tools: [tool], fallback: false };
			const report: Record<string, unknown> = {
				S0: scoreDecisions(items, (i) => ({
					decision: today(routeOf(i.text)),
					count: null,
				})),
			};
			if (v.hinted) {
				const hinted = new Map(
					(lines(v.hinted) as unknown as Prediction[]).map((p) => [
						p.id,
						p.tool,
					]),
				);
				report["S0+hints"] = scoreDecisions(items, (i) => ({
					decision: today(hinted.get(i.id)!),
					count: null,
				}));
			}
			for (const [tag, structures] of methods)
				for (const mode of PART_MODES) {
					const got = (i: StructureItem) => structures.get(i.id)!;
					report[`${tag}/${mode}`] = {
						...scoreDecisions(items, (i) => ({
							decision: decideStructure(i.text, got(i).s, routeOf, mode),
							count: got(i).s?.requests.length ?? null,
						})),
						tokens: items.reduce((sum, i) => sum + got(i).tokens, 0),
					};
				}
			writeFileSync(need(v.out, "out"), JSON.stringify(report, null, 2) + "\n");
		}
	} else if (
		positionals[0] === "test-parts" ||
		positionals[0] === "test-score"
	) {
		// Today's test utterances with an analyzer's structures: the parts to route, then top-1 against today's.
		const lines = (file: string) =>
			readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as Record<string, unknown>);
		const rows = lines(need(v.rows, "rows")) as Array<{
			id: string;
			text: string;
		}>;
		const [tag = "", file = ""] = need(v.structures, "structures").split("=");
		const structures = new Map(
			lines(file).map((r) => [
				r["id"] as string,
				{
					s: (r["structure"] ?? null) as Structure,
					tokens: Number(r["prompt"] ?? 0) + Number(r["completion"] ?? 0),
				},
			]),
		);
		const got = (id: string) => {
			const found = structures.get(id);
			if (!found) throw new Error(`no structure for ${id}`);
			return found;
		};
		if (positionals[0] === "test-parts") {
			const whole = new Set(rows.map((r) => r.text));
			const texts = new Set(
				rows.flatMap((r) =>
					routedTexts(r.text, got(r.id).s, "mask").filter((t) => !whole.has(t)),
				),
			);
			writeFileSync(
				need(v.out, "out"),
				jsonl(
					[...texts].map((text) => ({
						id: `rq-${sha256Hex(text).slice(0, 12)}`,
						text,
					})),
				),
			);
			console.log(JSON.stringify({ requests: texts.size }));
		} else {
			const db = new Database(need(v.db, "db"));
			const labels = new Map(
				(
					db
						.query("SELECT utterance_id AS id, label_json FROM bench_labels")
						.all() as Array<{ id: string; label_json: string }>
				).map((r) => {
					const l = JSON.parse(r.label_json) as {
						gold: string | null;
						acceptable?: string[];
						none?: boolean;
					};
					return [
						r.id,
						new Set([
							l.none ? CONVERSATION_ID : (l.gold ?? ""),
							...(l.acceptable ?? []),
						]),
					];
				}),
			);
			db.close();
			const routed = new Map<string, string>();
			for (const f of need(v.routes, "routes").split(","))
				for (const p of lines(f) as unknown as Prediction[])
					routed.set(p.text, p.tool);
			const routeOf = (text: string) => {
				const tool = routed.get(text);
				if (!tool) throw new Error("a routed text has no routing");
				return tool;
			};
			let today = 0;
			let structured = 0;
			const changed = { better: 0, worse: 0, toPipeline: 0, fallback: 0 };
			const moved: Array<{
				id: string;
				today: string;
				now: string;
				right: boolean;
			}> = [];
			for (const r of rows) {
				const ok = labels.get(r.id)!;
				const before = routeOf(r.text);
				const d = decideStructure(r.text, got(r.id).s, routeOf, "mask");
				const after =
					d.route === "pipeline" ? `pipeline:${d.tools.join("+")}` : d.tool!;
				const a = ok.has(before);
				const b = d.route !== "pipeline" && ok.has(after);
				if (a) today++;
				if (b) structured++;
				if (d.route === "pipeline") changed.toPipeline++;
				if (d.fallback) changed.fallback++;
				if (b && !a) changed.better++;
				if (a && !b) changed.worse++;
				if (after !== before)
					moved.push({ id: r.id, today: before, now: after, right: b });
			}
			writeFileSync(
				need(v.out, "out"),
				JSON.stringify(
					{
						method: tag,
						n: rows.length,
						todayTop1: today,
						structuredTop1: structured,
						...changed,
						tokens: rows.reduce((sum, r) => sum + got(r.id).tokens, 0),
						moved,
					},
					null,
					2,
				) + "\n",
			);
		}
	} else {
		throw new Error(
			"usage: structure.ts build|requests|score|test-parts|test-score …",
		);
	}
}
