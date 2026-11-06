import { Database } from "bun:sqlite";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { run } from "../../bench/router/run.ts";
import {
	registerSr,
	SR_DEFAULTS,
	type SrOptions,
} from "../../bench/router/algorithms.ts";
import {
	loadLabels,
	loadUtterances,
	CONVERSATION,
} from "../../bench/router/data.ts";
import { isContextual } from "../../bench/router/round2.ts";
export const MODEL = "local:e5-small";
let k = 0;
export function go(
	dbPath: string,
	algo: string,
	split: "dev" | "test",
	sr?: Partial<SrOptions>,
	extra: any = {},
) {
	const db = new Database(dbPath);
	let name = algo;
	if (sr) {
		name = `sr-x${k++}`;
		registerSr(
			name,
			{
				...SR_DEFAULTS,
				...sr,
				weights: { ...SR_DEFAULTS.weights, ...sr.weights },
			} as SrOptions,
			true,
		);
	}
	const out = `/tmp/r2/runs/${extra.tag ?? name}-${split}-${k++}`;
	if (existsSync(out)) rmSync(out, { recursive: true });
	const s: any = run(db, {
		algo: name,
		split,
		model: MODEL,
		offer: 8,
		temperature: 0.1,
		feedback: false,
		out,
		...extra,
	});
	const preds = readFileSync(`${out}/predictions.jsonl`, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	return {
		s,
		out,
		preds: Object.fromEntries(preds.map((p: any) => [p.id, p])),
	};
}
export function hits(
	dbPath: string,
	preds: Record<string, any>,
	split: string,
) {
	const db = new Database(dbPath);
	const labels = loadLabels(db);
	const text = new Map(loadUtterances(db).map((u) => [u.id, u.text]));
	const res: Record<
		string,
		{ hit: boolean; none: boolean; ctx: boolean; top: string; gold: string }
	> = {};
	for (const l of labels.values()) {
		if (l.status !== "reviewed" || l.split !== split) continue;
		const p = preds[l.id];
		if (!p) continue;
		const top = Object.entries(p.probabilities as Record<string, number>).sort(
			(a, b) => b[1] - a[1],
		)[0]![0];
		const gold = l.none ? CONVERSATION : l.gold!;
		const ok = top === gold || (l.acceptable ?? []).includes(top);
		res[l.id] = {
			hit: ok,
			none: !!l.none,
			ctx: isContextual(text.get(l.id)!) && !l.none,
			top,
			gold,
		};
	}
	return res;
}
export function agg(h: ReturnType<typeof hits>, only?: Set<string>) {
	const v = Object.entries(h)
		.filter(([id]) => !only || only.has(id))
		.map(([, x]) => x);
	const r = (xs: typeof v) =>
		xs.length ? xs.filter((x) => x.hit).length / xs.length : NaN;
	return {
		n: v.length,
		top1: r(v),
		ctx: r(v.filter((x) => x.ctx)),
		nCtx: v.filter((x) => x.ctx).length,
		none: r(v.filter((x) => x.none)),
		nNone: v.filter((x) => x.none).length,
	};
}
export function boot(
	a: ReturnType<typeof hits>,
	b: ReturnType<typeof hits>,
	filter: (x: any) => boolean = () => true,
	B = 10000,
) {
	const ids = Object.keys(a).filter((id) => b[id] && filter(a[id]));
	const d = ids.map((id) => (a[id]!.hit ? 1 : 0) - (b[id]!.hit ? 1 : 0));
	let seed = 12345;
	const rnd = () =>
		(seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const xs: number[] = [];
	for (let i = 0; i < B; i++) {
		let s = 0;
		for (let j = 0; j < d.length; j++) s += d[Math.floor(rnd() * d.length)]!;
		xs.push(s / d.length);
	}
	xs.sort((x, y) => x - y);
	return {
		diff: d.reduce((s, v) => s + v, 0) / d.length,
		lo: xs[Math.floor(B * 0.025)]!,
		hi: xs[Math.floor(B * 0.975)]!,
		n: d.length,
	};
}
