/** Importing cards, utterances, past choices and labels into the bench file. */
import type { Database } from "bun:sqlite";
import {
	cardDigest,
	cardPassages,
	parseCard,
	type Card,
} from "../../src/index.ts";
import { sha256Hex } from "../../src/digest.ts";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { packVector } from "../../src/index.ts";
import { readRecords } from "./io.ts";
import type { BenchHistory } from "./algorithms.ts";

/** Context hints a host may pass with an utterance. The baselines read only `availableToolchainIds`. */
export type ContextHints = {
	activeTopic?: string | null;
	activeToolchainId?: string | null;
	activeTaskId?: string | null;
	referencedResource?: { kind: string; ref?: string } | null;
	availableToolchainIds?: readonly string[] | null;
};

export type Utterance = {
	id: string;
	conversationId: string;
	seq: number;
	text: string;
	previousUser: string | null;
	previousAgent: string | null;
	hints: ContextHints;
};

export type Label = {
	id: string;
	/** The right toolchain id. With `none: true` it is the conversation. */
	gold: string | null;
	acceptable?: readonly string[];
	/** No toolchain fits: the conversation answers. */
	none?: boolean;
	/** `hold`(保留): not decided; left out of every score. */
	status: "reviewed" | "hold";
	/** The id that was chosen wrongly, when the label is a correction. */
	wrong?: string | null;
	note?: string;
};

export const CONVERSATION = "conversation.respond";
/** A past choice with no selected id (refused or left undecided). */
export const UNDECIDED = "(undecided)";

/** A card file row: a Card, with `digest` and `revision` optional. */
const IMPACTS = new Set(["none", "create", "modify_existing", "irreversible"]);

/**
 * Eumenes `router-export` kinds the router contract lacks (`conversation`, `memory`)
 * become `general`; the export's `name`/`description`/`minImpact`/`version` fill
 * `title`/`summary`/`impact`/`revision`.
 */
function cardOf(raw: Record<string, unknown>): Card {
	const kind = (raw["kind"] as string | undefined) ?? "dedicated";
	const impact = (raw["impact"] ?? raw["minImpact"]) as string | null;
	const body = {
		id: raw["id"],
		revision: String(raw["revision"] ?? raw["version"] ?? "1"),
		kind: kind === "conversation" || kind === "memory" ? "general" : kind,
		title: raw["title"] ?? raw["name"],
		summary: raw["summary"] ?? raw["description"] ?? "",
		useWhen: raw["useWhen"] ?? [],
		examples: raw["examples"] ?? [],
		impact: impact && IMPACTS.has(impact) ? impact : "none",
	} as Omit<Card, "digest">;
	return parseCard({
		...body,
		digest: (raw["digest"] as string | undefined) ?? cardDigest(body),
	});
}

export function importCards(db: Database, path: string): number {
	const raws = readRecords<Record<string, unknown>>(path);
	const cards = raws.map(cardOf);
	/** The export's own passages (the text the product embedded, item by item), else ours. */
	const passagesOf = (card: Card, i: number): string[] => {
		const own = raws[i]!["embeddingPassages"];
		if (Array.isArray(own) && own.length) return own as string[];
		const text = raws[i]!["routerText"];
		if (typeof text === "string" && text && !raws[i]!["useWhen"]) return [text];
		const fallback = cardPassages(card);
		return fallback.length ? fallback : typeof text === "string" ? [text] : [];
	};
	db.transaction(() => {
		db.exec(
			"DELETE FROM bench_cards; DELETE FROM bench_passages; DELETE FROM bench_fts;",
		);
		cards.forEach((card, i) => {
			db.query(
				"INSERT INTO bench_cards(id, kind, impact, card_json) VALUES (?,?,?,?)",
			).run(card.id, card.kind, card.impact, JSON.stringify(card));
			passagesOf(card, i).forEach((text, item) => {
				db.query(
					"INSERT INTO bench_passages(card_id, item, text) VALUES (?,?,?)",
				).run(card.id, item, text);
				db.query("INSERT INTO bench_fts(card_id, text) VALUES (?,?)").run(
					card.id,
					text,
				);
			});
		});
	})();
	return cards.length;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length ? value : null;
}

/** Export fields that are context hints; null ones are left out. */
function hintsOf(raw: Record<string, unknown>): ContextHints {
	const hints: ContextHints = {};
	const tool = str(raw["activeToolchainId"]);
	const task = str(raw["activeTaskId"]);
	const kinds = raw["resourceKinds"];
	if (tool) hints.activeToolchainId = tool;
	if (task) hints.activeTaskId = task;
	if (Array.isArray(kinds) && typeof kinds[0] === "string")
		hints.referencedResource = { kind: kinds[0] };
	return hints;
}

export function importUtterances(db: Database, path: string): number {
	const rows = readRecords<Record<string, unknown>>(path);
	/** Export rows have `turnId` and `timestamp`, no `seq`: order by time within a conversation. */
	const order = new Map(
		rows
			.map((raw, index) => ({ raw, index }))
			.sort(
				(a, b) =>
					String(a.raw["timestamp"] ?? "").localeCompare(
						String(b.raw["timestamp"] ?? ""),
					) || a.index - b.index,
			)
			.map(({ index }, rank) => [index, rank]),
	);
	db.transaction(() => {
		rows.forEach((raw, index) => {
			const id = str(raw["id"]) ?? str(raw["turnId"]);
			const text = typeof raw["text"] === "string" ? raw["text"] : null;
			const conversationId = str(raw["conversationId"]);
			if (!id || text === null || !conversationId)
				throw new Error(`utterance_invalid: ${path}:${index + 1}`);
			const utterance: Utterance = {
				id,
				conversationId,
				seq: typeof raw["seq"] === "number" ? raw["seq"] : order.get(index)!,
				text,
				previousUser: str(raw["previousUser"]),
				previousAgent: str(raw["previousAgent"]),
				hints: (raw["hints"] as ContextHints | undefined) ?? hintsOf(raw),
			};
			db.query(
				`INSERT INTO bench_utterances(id, conversation_id, seq, utterance_json) VALUES (?,?,?,?)
ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id, seq=excluded.seq, utterance_json=excluded.utterance_json`,
			).run(id, conversationId, utterance.seq, JSON.stringify(utterance));
		});
	})();
	return rows.length;
}

/** Past choices of the product: `{ utteranceId, chosenId, ... }`. Kept for reference; not a label. */
export function importChoices(db: Database, path: string): number {
	const rows = readRecords<Record<string, unknown>>(path);
	db.transaction(() => {
		rows.forEach((raw, index) => {
			const id = str(raw["utteranceId"]) ?? str(raw["turnId"]);
			// Export: `selectedId` "none" is the conversation; null is a refused/undecided choice.
			const selected =
				"selectedId" in raw
					? raw["selectedId"] === "none"
						? CONVERSATION
						: (str(raw["selectedId"]) ?? UNDECIDED)
					: null;
			const chosen = str(raw["chosenId"]) ?? selected;
			if (!id || !chosen)
				throw new Error(`choice_invalid: ${path}:${index + 1}`);
			db.query(
				`INSERT INTO bench_choices(utterance_id, chosen_id, choice_json) VALUES (?,?,?)
ON CONFLICT(utterance_id) DO UPDATE SET chosen_id=excluded.chosen_id, choice_json=excluded.choice_json`,
			).run(id, chosen, JSON.stringify(raw));
		});
	})();
	return rows.length;
}

/** The split of a conversation: every utterance of one conversation lands in the same split. */
export function splitOf(
	conversationId: string,
	testShare = 0.5,
): "dev" | "test" {
	const bucket =
		parseInt(sha256Hex(conversationId).slice(0, 8), 16) / 0x100000000;
	return bucket < testShare ? "test" : "dev";
}

/**
 * How labels are split. `sha`: whole conversations by hash. `time`: one conversation is
 * cut by time order — its first `devShare` of utterances go to dev, the rest to test —
 * and the other conversations keep the hash rule.
 */
export type SplitRule =
	| { kind: "sha" }
	| { kind: "time"; conversation: string; devShare: number };

export function parseSplitRule(text: string | undefined): SplitRule {
	if (!text) return { kind: "sha" };
	const [conversation, share] = text.split(":");
	const devShare = Number(share);
	if (!conversation || !(devShare > 0 && devShare < 1))
		throw new Error(`split_rule_invalid: ${text}`);
	return { kind: "time", conversation, devShare };
}

export function importLabels(
	db: Database,
	path: string,
	rule: SplitRule = { kind: "sha" },
): { reviewed: number; hold: number } {
	const rows = readRecords<Label>(path);
	const conversation = db.query(
		"SELECT conversation_id AS c FROM bench_utterances WHERE id=?",
	);
	const cut = new Map<string, "dev" | "test">();
	if (rule.kind === "time") {
		const ids = (
			db
				.query(
					"SELECT id FROM bench_utterances WHERE conversation_id=? ORDER BY seq, id",
				)
				.all(rule.conversation) as Array<{ id: string }>
		).map((r) => r.id);
		const labeled = new Set(rows.map((r) => r.id));
		const order = ids.filter((id) => labeled.has(id));
		const devCount = Math.round(order.length * rule.devShare);
		order.forEach((id, i) => cut.set(id, i < devCount ? "dev" : "test"));
	}
	const counts = { reviewed: 0, hold: 0 };
	db.transaction(() => {
		rows.forEach((label, index) => {
			const at = `${path}:${index + 1}`;
			const row = conversation.get(label.id) as { c: string } | null;
			if (!row) throw new Error(`label_unknown_utterance: ${at}`);
			if (label.status !== "reviewed" && label.status !== "hold")
				throw new Error(`label_invalid_status: ${at}`);
			if (label.status === "reviewed" && !label.none && !label.gold)
				throw new Error(`label_missing_gold: ${at}`);
			counts[label.status]++;
			db.query(
				`INSERT INTO bench_labels(utterance_id, split, status, label_json) VALUES (?,?,?,?)
ON CONFLICT(utterance_id) DO UPDATE SET split=excluded.split, status=excluded.status, label_json=excluded.label_json`,
			).run(label.id, cut.get(label.id) ?? splitOf(row.c), label.status, JSON.stringify(label));
		});
	})();
	return counts;
}

export function loadCards(db: Database): Card[] {
	return (
		db.query("SELECT card_json FROM bench_cards ORDER BY id").all() as Array<{
			card_json: string;
		}>
	).map((row) => JSON.parse(row.card_json) as Card);
}

export function loadUtterances(db: Database): Utterance[] {
	return (
		db
			.query(
				"SELECT utterance_json FROM bench_utterances ORDER BY conversation_id, seq, id",
			)
			.all() as Array<{ utterance_json: string }>
	).map((row) => JSON.parse(row.utterance_json) as Utterance);
}

export type StoredLabel = Label & { split: "dev" | "test" };

export function loadLabels(db: Database): Map<string, StoredLabel> {
	const rows = db
		.query("SELECT split, label_json FROM bench_labels")
		.all() as Array<{ split: "dev" | "test"; label_json: string }>;
	return new Map(
		rows.map((row) => {
			const label = JSON.parse(row.label_json) as Label;
			return [label.id, { ...label, split: row.split }];
		}),
	);
}

export function passagesByCard(db: Database): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const row of db
		.query("SELECT card_id, text FROM bench_passages ORDER BY card_id, item")
		.all() as Array<{ card_id: string; text: string }>) {
		const list = out.get(row.card_id) ?? [];
		list.push(row.text);
		out.set(row.card_id, list);
	}
	return out;
}

/**
 * Eumenes `router-export` vectors (`embeddings.jsonl.gz`): one row per card passage
 * (`cardId`, `item`). They go into the cache under `eumenes:<spaceId>` keyed by the
 * passage text, so `cachedVectors` finds them. Returns counts by owner kind.
 */
export function importExportEmbeddings(
	db: Database,
	path: string,
): { rows: number; cards: number; utterances: number; missingPassage: number; space: string } {
	const raw = readFileSync(path);
	const text = path.endsWith(".gz")
		? new TextDecoder().decode(gunzipSync(raw))
		: raw.toString("utf8");
	const passage = db.query(
		"SELECT text FROM bench_passages WHERE card_id=? AND item=?",
	);
	const counts = { rows: 0, cards: 0, utterances: 0, missingPassage: 0, space: "" };
	const owners = new Set<string>();
	db.transaction(() => {
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const row = JSON.parse(line) as {
				cardId?: string;
				turnId?: string;
				item?: number;
				spaceId: string;
				vector: number[];
			};
			counts.rows++;
			const model = `eumenes:${row.spaceId}`;
			counts.space = model;
			if (!row.cardId) {
				counts.utterances++;
				continue;
			}
			owners.add(row.cardId);
			const p = passage.get(row.cardId, row.item ?? 0) as { text: string } | null;
			if (!p) {
				counts.missingPassage++;
				continue;
			}
			const norm = Math.sqrt(row.vector.reduce((s, v) => s + v * v, 0)) || 1;
			db.query(
				"INSERT OR REPLACE INTO bench_embeddings(model, text_hash, dimension, vector) VALUES (?,?,?,?)",
			).run(
				model,
				sha256Hex(p.text),
				row.vector.length,
				packVector(row.vector.map((v) => v / norm)),
			);
		}
	})();
	counts.cards = owners.size;
	return counts;
}

/** Retired product ids and the current card that serves them (for the past-choice rows). */
export const RETIRED: Record<string, string> = {
	"web.research.codex": "web.search",
	"web.research.luna": "web.search",
	"steward.request": "memory.request",
};

/**
 * The product's own history from `bench_choices`: its choice, recorded similarities, the
 * previous routed turn's choice, and transition counts (leave-one-out: the utterance's own
 * pair is not counted). Uses only what the product knew at routing time, no labels.
 */
export function loadHistory(db: Database): BenchHistory {
	const rows = db
		.query("SELECT utterance_id AS id, chosen_id AS c, choice_json AS j FROM bench_choices")
		.all() as Array<{ id: string; c: string; j: string }>;
	const current = (id: string | null) =>
		id === null || id === UNDECIDED ? null : (RETIRED[id] ?? id);
	const chosen = new Map(rows.map((r) => [r.id, current(r.c)]));
	const recorded = new Map(
		rows.map((r) => {
			const raw = JSON.parse(r.j) as { candidates?: Array<{ id: string; similarity: number | null }> };
			return [
				r.id,
				(raw.candidates ?? [])
					.filter((c) => typeof c.similarity === "number")
					.map((c) => ({ id: current(c.id) ?? c.id, similarity: c.similarity as number })),
			];
		}),
	);
	const previous = new Map<string, string | null>();
	let lastConv: string | null = null;
	let last: string | null = null;
	for (const u of loadUtterances(db)) {
		if (u.conversationId !== lastConv) {
			lastConv = u.conversationId;
			last = null;
		}
		if (!chosen.has(u.id)) continue;
		previous.set(u.id, last);
		last = chosen.get(u.id) ?? last;
	}
	const pairs = new Map<string, number>();
	const froms = new Map<string, number>();
	for (const [id, prev] of previous) {
		const next = chosen.get(id);
		if (!prev || !next) continue;
		pairs.set(`${prev}\t${next}`, (pairs.get(`${prev}\t${next}`) ?? 0) + 1);
		froms.set(prev, (froms.get(prev) ?? 0) + 1);
	}
	return {
		past: (id) => chosen.get(id) ?? null,
		recorded: (id) => recorded.get(id) ?? [],
		previous: (id) => previous.get(id) ?? null,
		transition: (id, from, to) => {
			const own = previous.get(id) === from && chosen.get(id) ? 1 : 0;
			const ownPair = own && chosen.get(id) === to ? 1 : 0;
			return {
				pair: (pairs.get(`${from}\t${to}`) ?? 0) - ownPair,
				from: (froms.get(from) ?? 0) - own,
			};
		},
	};
}
