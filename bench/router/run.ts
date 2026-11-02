/**
 * One run: every utterance through one algorithm, then the shared path — the offer
 * (best `offer` candidates, the conversation always among them), probabilities by a
 * softmax of the scores scaled to the best one, the correction by near labeled
 * corrections (`correctProbabilities`, as the product), and the product's decision
 * table through `bench/score.ts`.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { correctProbabilities, dot, routeSettings } from "../../src/index.ts";
import { sha256Hex } from "../../src/digest.ts";
import {
	reportOf,
	score,
	type CatalogEntry,
	type Item,
	type Prediction,
} from "../score.ts";
import {
	ALGORITHMS,
	ftsSearch,
	ranking,
	type AlgorithmEnv,
	type CandidateCard,
} from "./algorithms.ts";
import {
	CONVERSATION,
	loadCards,
	loadLabels,
	loadHistory,
	loadUtterances,
	passagesByCard,
	type StoredLabel,
} from "./data.ts";
import { cachedVectors } from "./embed.ts";
import { jsonl, stableJson } from "./io.ts";

export type RunOptions = {
	algo: string;
	split: string;
	/** Embedding model name in the cache; required by embedding algorithms and by `feedback`. */
	model: string | null;
	offer: number;
	temperature: number;
	/** Use reviewed corrections (labels with `wrong`) of the other split. */
	feedback: boolean;
	out: string;
};

export const RUN_DEFAULTS = { offer: 8, temperature: 0.1, split: "test" };

function softmax(values: readonly number[], t: number): number[] {
	const top = Math.max(...values);
	const exp = values.map((v) => Math.exp((v - top) / t));
	const total = exp.reduce((s, v) => s + v, 0);
	return exp.map((v) => v / total);
}

const round = (v: number) => Number(v.toFixed(6));

function itemOf(label: StoredLabel): Item {
	return {
		id: label.id,
		split: label.split,
		gold: {
			primary: label.none ? CONVERSATION : label.gold!,
			acceptable: [...(label.acceptable ?? [])],
		},
		review: { status: label.status },
	};
}

export function catalogOf(
	cards: ReturnType<typeof loadCards>,
): Record<string, CatalogEntry> {
	const out: Record<string, CatalogEntry> = {};
	for (const card of cards)
		out[card.id] = {
			...(card.kind === "read" ? { read: true } : {}),
			...(card.kind === "general" ? { general: true } : {}),
			...(card.kind === "pipeline" ? { execution: "pipeline" } : {}),
			minImpact: card.impact,
		};
	return out;
}

/** The measures minus wall-clock fields: equal inputs must give an equal digest. */
export function metricsDigest(
	summary: object,
	predictions: readonly Prediction[],
): string {
	const { latencyMs: _l, ...rest } = summary as { latencyMs: unknown };
	const stable = predictions.map(({ durationMs: _d, ...p }) => p);
	return sha256Hex(stableJson({ summary: rest, predictions: stable })).slice(
		0,
		16,
	);
}

export function run(db: Database, options: RunOptions) {
	const algo = ALGORITHMS[options.algo];
	if (!algo)
		throw new Error(
			`unknown_algo: ${options.algo} (${Object.keys(ALGORITHMS).join(", ")})`,
		);
	if ((algo.needsEmbeddings || options.feedback) && !options.model)
		throw new Error("model_required: --model <cached embedding model>");
	const settings = routeSettings({});
	const cards = loadCards(db);
	const passages = passagesByCard(db);
	const labels = loadLabels(db);
	const vector = options.model
		? cachedVectors(db, options.model)
		: () => {
				throw new Error("embedding_not_available");
			};
	const env: AlgorithmEnv = {
		fts: ftsSearch(db),
		vector,
		history: loadHistory(db),
		cardText: new Map(cards.map((c) => [c.id, { title: c.title, summary: c.summary }])),
	};
	const all: CandidateCard[] = cards.map((c) => ({
		id: c.id,
		kind: c.kind,
		passages: passages.get(c.id) ?? [],
	}));
	const utterances = loadUtterances(db).filter((u) => {
		const label = labels.get(u.id);
		return label && (options.split === "any" || label.split === options.split);
	});
	const corrections = options.feedback
		? [...labels.values()].filter(
				(l) => l.status === "reviewed" && l.wrong && l.split !== options.split,
			)
		: [];
	const textOf = new Map(loadUtterances(db).map((u) => [u.id, u.text]));
	const predictions: Prediction[] = [];
	for (const utterance of utterances) {
		const available = utterance.hints.availableToolchainIds;
		const candidates = available
			? all.filter((c) => c.id === CONVERSATION || available.includes(c.id))
			: all;
		const started = performance.now();
		const scores = algo.score({ utterance, candidates }, env);
		const order = ranking(scores).slice(0, options.offer);
		if (
			!order.includes(CONVERSATION) &&
			candidates.some((c) => c.id === CONVERSATION)
		) {
			if (order.length >= options.offer) order.pop();
			order.push(CONVERSATION);
		}
		const best = Math.max(0, ...order.map((id) => scores.get(id) ?? 0));
		const scaled = order.map((id) =>
			best > 0 ? Math.max(0, scores.get(id) ?? 0) / best : 0,
		);
		let p = softmax(scaled, options.temperature);
		if (corrections.length) {
			const q = vector(utterance.text);
			const near = corrections
				.map((l) => ({
					id: l.id,
					wrongId: l.wrong ?? null,
					rightId: l.none ? CONVERSATION : l.gold!,
					similarity: dot(q, vector(textOf.get(l.id)!)),
				}))
				.filter((n) => n.similarity >= settings.feedbackNear);
			p = correctProbabilities(
				order.map((id, i) => ({ id, p: p[i]! })),
				near,
				{ threshold: settings.feedbackNear, weight: settings.feedbackWeight },
			).p;
		}
		const durationMs = performance.now() - started;
		predictions.push({
			id: utterance.id,
			probabilities: Object.fromEntries(
				order.map((id, i) => [id, round(p[i]!)]),
			),
			scores: Object.fromEntries(order.map((id, i) => [id, round(scaled[i]!)])),
			durationMs: Number(durationMs.toFixed(3)),
		});
	}
	const items = [...labels.values()].map(itemOf);
	const thresholds = {
		accept: settings.accept,
		low: settings.low,
		margin: settings.margin,
		approve: settings.approve,
		multi: settings.multi,
	};
	const summary = score({
		items,
		predictions,
		split: options.split,
		thresholds,
		catalog: catalogOf(cards),
	});
	const top4 = predictions.filter((pr) => {
		const item = items.find((i) => i.id === pr.id)!;
		if (item.review?.status !== "reviewed") return false;
		const ids = Object.entries(pr.probabilities)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4)
			.map(([id]) => id);
		return ids.some(
			(id) => id === item.gold.primary || item.gold.acceptable.includes(id),
		);
	}).length;
	const extra = {
		algo: options.algo,
		model: options.model,
		offer: options.offer,
		temperature: options.temperature,
		feedback: options.feedback,
		corrections: corrections.length,
		cards: cards.length,
		recallAt4: summary.n ? top4 / summary.n : null,
		noneAccuracy:
			summary.falseDispatchRate.rate === null
				? null
				: 1 - summary.falseDispatchRate.rate,
	};
	const result = {
		...summary,
		...extra,
		digest: metricsDigest({ ...summary, ...extra }, predictions),
	};
	mkdirSync(options.out, { recursive: true });
	writeFileSync(
		join(options.out, "summary.json"),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	writeFileSync(join(options.out, "predictions.jsonl"), jsonl(predictions));
	writeFileSync(
		join(options.out, "report.md"),
		`${reportOf(summary)}\n## 実行条件\n\n| 項目 | 値 |\n| --- | --- |\n${Object.entries(
			extra,
		)
			.map(
				([k, v]) =>
					`| ${k} | ${v === null ? "なし" : typeof v === "number" ? Number(v.toFixed(4)) : v} |`,
			)
			.join("\n")}\n| digest | ${result.digest} |\n`,
	);
	return result;
}
