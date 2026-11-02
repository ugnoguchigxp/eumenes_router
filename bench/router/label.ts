/**
 * The review sheet for labeling. Labels are written by a reviewer reading the sheet
 * (no model is called here). Unlabeled utterances come out closest-call first: a
 * small gap between the two best candidates, or a short text that leans on context.
 */
import type { Database } from "bun:sqlite";
import { ALGORITHMS, ftsSearch, ranking } from "./algorithms.ts";
import {
	loadCards,
	loadLabels,
	loadUtterances,
	passagesByCard,
} from "./data.ts";
import { cachedVectors } from "./embed.ts";

export type SheetRow = {
	id: string;
	conversationId: string;
	previousUser: string | null;
	previousAgent: string | null;
	text: string;
	hints: unknown;
	pastChoice: string | null;
	candidates: Array<{ id: string; title: string; score: number }>;
	/** Fill in and pass the line to `label import` (status `reviewed` or `hold`). */
	label: {
		id: string;
		gold: null;
		acceptable: string[];
		none: false;
		status: "hold";
		note: string;
	};
	priority: number;
};

export function reviewSheet(
	db: Database,
	options: { model: string | null; limit: number; top: number },
): SheetRow[] {
	const algo = ALGORITHMS[options.model ? "hybrid" : "fts"]!;
	const cards = loadCards(db);
	const title = new Map(cards.map((c) => [c.id, c.title]));
	const passages = passagesByCard(db);
	const candidates = cards.map((c) => ({
		id: c.id,
		kind: c.kind,
		passages: passages.get(c.id) ?? [],
	}));
	const labels = loadLabels(db);
	const choice = db.query(
		"SELECT chosen_id AS c FROM bench_choices WHERE utterance_id=?",
	);
	const env = {
		fts: ftsSearch(db),
		vector: options.model
			? cachedVectors(db, options.model)
			: () => {
					throw new Error("embedding_not_available");
				},
	};
	const rows: SheetRow[] = [];
	for (const u of loadUtterances(db)) {
		if (labels.has(u.id)) continue;
		const scores = algo.score({ utterance: u, candidates }, env);
		const order = ranking(scores).slice(0, options.top);
		const best = scores.get(order[0] ?? "") ?? 0;
		const second = scores.get(order[1] ?? "") ?? 0;
		const gap = best > 0 ? (best - second) / best : 0;
		const short = [...u.text].length <= 8 ? 1 : 0;
		rows.push({
			id: u.id,
			conversationId: u.conversationId,
			previousUser: u.previousUser,
			previousAgent: u.previousAgent,
			text: u.text,
			hints: u.hints,
			pastChoice: (choice.get(u.id) as { c: string } | null)?.c ?? null,
			candidates: order.map((id) => ({
				id,
				title: title.get(id) ?? id,
				score: Number((scores.get(id) ?? 0).toFixed(4)),
			})),
			label: {
				id: u.id,
				gold: null,
				acceptable: [],
				none: false,
				status: "hold",
				note: "",
			},
			priority: Number((short + (1 - gap)).toFixed(4)),
		});
	}
	rows.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
	return rows.slice(0, options.limit);
}

export function sheetMarkdown(rows: readonly SheetRow[]): string {
	const out = [
		"# 正解付けシート",
		"",
		"候補は検索の参考で、正解ではない。各行の `label` を埋めて `router label import` に渡す（`status` は `reviewed` か `hold`＝保留、該当なしは `none: true`）。",
		"",
	];
	for (const r of rows) {
		out.push(
			`## ${r.id}（会話 ${r.conversationId}、優先度 ${r.priority}）`,
			"",
			`- 直前のユーザー: ${r.previousUser ?? "なし"}`,
			`- 直前のエージェント: ${r.previousAgent ?? "なし"}`,
			`- 発言: **${r.text}**`,
			`- 文脈ヒント: \`${JSON.stringify(r.hints)}\``,
			`- 過去の選択: ${r.pastChoice ?? "なし"}`,
			`- 候補: ${r.candidates.map((c) => `\`${c.id}\`(${c.score})`).join(", ") || "なし"}`,
			"",
		);
	}
	return out.join("\n");
}
