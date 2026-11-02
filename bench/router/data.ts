/** Importing cards, utterances, past choices and labels into the bench file. */
import type { Database } from "bun:sqlite";
import {
	cardDigest,
	cardPassages,
	parseCard,
	type Card,
} from "../../src/index.ts";
import { sha256Hex } from "../../src/digest.ts";
import { readRecords } from "./io.ts";

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

/** A card file row: a Card, with `digest` and `revision` optional. */
function cardOf(raw: Record<string, unknown>): Card {
	const body = {
		id: raw["id"],
		revision: raw["revision"] ?? "1",
		kind: raw["kind"] ?? "dedicated",
		title: raw["title"],
		summary: raw["summary"] ?? "",
		useWhen: raw["useWhen"] ?? [],
		examples: raw["examples"] ?? [],
		impact: raw["impact"] ?? "none",
	} as Omit<Card, "digest">;
	return parseCard({
		...body,
		digest: (raw["digest"] as string | undefined) ?? cardDigest(body),
	});
}

export function importCards(db: Database, path: string): number {
	const cards = readRecords<Record<string, unknown>>(path).map(cardOf);
	db.transaction(() => {
		db.exec(
			"DELETE FROM bench_cards; DELETE FROM bench_passages; DELETE FROM bench_fts;",
		);
		for (const card of cards) {
			db.query(
				"INSERT INTO bench_cards(id, kind, impact, card_json) VALUES (?,?,?,?)",
			).run(card.id, card.kind, card.impact, JSON.stringify(card));
			cardPassages(card).forEach((text, item) => {
				db.query(
					"INSERT INTO bench_passages(card_id, item, text) VALUES (?,?,?)",
				).run(card.id, item, text);
				db.query("INSERT INTO bench_fts(card_id, text) VALUES (?,?)").run(
					card.id,
					text,
				);
			});
		}
	})();
	return cards.length;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length ? value : null;
}

export function importUtterances(db: Database, path: string): number {
	const rows = readRecords<Record<string, unknown>>(path);
	db.transaction(() => {
		rows.forEach((raw, index) => {
			const id = str(raw["id"]);
			const text = typeof raw["text"] === "string" ? raw["text"] : null;
			const conversationId = str(raw["conversationId"]);
			if (!id || text === null || !conversationId)
				throw new Error(`utterance_invalid: ${path}:${index + 1}`);
			const utterance: Utterance = {
				id,
				conversationId,
				seq: typeof raw["seq"] === "number" ? raw["seq"] : index,
				text,
				previousUser: str(raw["previousUser"]),
				previousAgent: str(raw["previousAgent"]),
				hints: (raw["hints"] as ContextHints | undefined) ?? {},
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
			const id = str(raw["utteranceId"]);
			const chosen = str(raw["chosenId"]);
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

export function importLabels(
	db: Database,
	path: string,
): { reviewed: number; hold: number } {
	const rows = readRecords<Label>(path);
	const conversation = db.query(
		"SELECT conversation_id AS c FROM bench_utterances WHERE id=?",
	);
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
			).run(label.id, splitOf(row.c), label.status, JSON.stringify(label));
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
