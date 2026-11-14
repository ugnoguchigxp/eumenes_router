import type {
	SearchPorts,
	SelectionSettings,
	SelectionTurn,
} from "../contracts/selection.ts";
import { routerErrors } from "../contracts/errors.ts";
import type { RouterCard } from "../db/retrieval.ts";
import {
	MEMORY_ID,
	type DecisionCard,
	type RouteCandidate,
} from "../decision/result.ts";
import { candidateDocument } from "./passages.ts";
import { capByKind, srScores } from "./sr.ts";
import { STRUCTURE_LIMITS } from "../structure.ts";
import { head } from "../text.ts";
import { assertVector } from "../vector.ts";

export function cardCandidate(
	card: RouterCard,
	rank: number,
	passages: SelectionTurn["passages"],
): RouteCandidate {
	const passage = head(candidateDocument(card), 4096);
	if (card.id === MEMORY_ID)
		return {
			id: card.id,
			kind: "memory",
			passage: passages?.memory ?? passage,
		};
	const decisionCard: DecisionCard = {
		id: card.id,
		title: card.title,
		...(card.kind === "general" ? { general: true as const } : {}),
		...(card.kind === "pipeline" ? { execution: "pipeline" } : {}),
		...(card.kind === "read" ? { execution: "read" } : {}),
		minImpact: card.impact,
		score: { rank, ftsRank: null, similarity: null, fromHistory: false },
	};
	const choice = { id: card.id, title: card.title };
	if (card.kind === "read")
		return { id: card.id, kind: "read", passage, card: decisionCard, choice };
	return {
		id: card.id,
		kind: "toolchain",
		passage,
		card: decisionCard,
		choice,
	};
}

export async function searchTurn(
	ports: SearchPorts,
	turn: Pick<SelectionTurn, "available" | "retained">,
	settings: SelectionSettings,
	text: string,
	options: {
		resource: string | null;
		filterCards?: (card: RouterCard) => boolean;
	},
) {
	const { resource, filterCards } = options;
	const embedText = head(text, STRUCTURE_LIMITS.text);
	const embedded = await ports.embed([embedText]);
	const vector = embedded.vectors[0];
	if (embedded.vectors.length !== 1 || !vector)
		throw new Error(routerErrors.invalidEmbedding);
	assertVector(embedded.space, vector);
	const near = ports.read.nearFeedback({
		vector,
		space: embedded.space,
		threshold: settings.feedbackNear,
	});
	// Offer the corrected destination when the active nearby corrections agree.
	const rights = [...new Set(near.map((row) => row.rightId))];
	const cards = ports.read.cards({
		space: embedded.space,
		available: turn.available,
	});
	const eligible = filterCards ? cards.filter(filterCards) : cards;
	const byId = new Map(eligible.map((card) => [card.id, card]));
	const include = [
		...new Set([
			...(settings.feedbackWeight > 0 && rights.length === 1 ? rights : []),
			...(turn.retained ?? []).filter((id) => byId.has(id)),
		]),
	];
	const cap = (ranked: readonly string[]) =>
		capByKind(ranked, (id: string) => byId.get(id)?.kind);
	const scores = srScores({
		vector,
		cards: eligible,
		lexical: ports.read.lexical(embedText),
		resource,
	});
	return { near, byId, include, scores, cap };
}
