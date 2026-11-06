/** Exact data relationships, not semantic similarity or automatic labeling. Output contains counts only. */
import { sha256Hex } from "../../src/digest.ts";
import type { StoredLabel, Utterance } from "./data.ts";

export type Lineage = { id: string; sourceId: string };

export function auditDataset(
	utterances: readonly Utterance[],
	labels: ReadonlyMap<string, StoredLabel>,
	lineage: readonly Lineage[] = [],
) {
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.get(root) !== root) root = parent.get(root)!;
		let at = id;
		while (parent.get(at) !== root) {
			const next = parent.get(at)!;
			parent.set(at, root);
			at = next;
		}
		return root;
	};
	const union = (a: string, b: string) => {
		parent.set(find(a), find(b));
	};
	for (const u of utterances) {
		if (parent.has(u.id)) throw new Error("audit_duplicate_id");
		parent.set(u.id, u.id);
	}
	const conversations = new Map<string, string[]>();
	const texts = new Map<string, string[]>();
	for (const u of utterances) {
		for (const [map, key] of [
			[conversations, u.conversationId],
			[texts, sha256Hex(u.text.normalize("NFKC").replace(/\s+/gu, " ").trim())],
		] as const) {
			const group = map.get(key) ?? [];
			if (group.length) union(u.id, group[0]!);
			group.push(u.id);
			map.set(key, group);
		}
	}
	let unknownLineage = 0;
	for (const link of lineage) {
		if (!parent.has(link.id) || !parent.has(link.sourceId)) {
			unknownLineage++;
			continue;
		}
		union(link.id, link.sourceId);
	}
	const splitsOf = (ids: readonly string[]) =>
		new Set(
			ids.map((id) => labels.get(id)?.split).filter((s) => s !== undefined),
		);
	const components = new Map<string, string[]>();
	for (const id of parent.keys()) {
		const key = find(id);
		const group = components.get(key) ?? [];
		group.push(id);
		components.set(key, group);
	}
	const crossing = (groups: Iterable<string[]>) =>
		[...groups].filter((ids) => splitsOf(ids).size > 1).length;
	const rows = [...labels.values()];
	const missingUtterances = [...labels.keys()].filter(
		(id) => !parent.has(id),
	).length;
	const crossSplitComponents = crossing(components.values());
	return {
		utterances: utterances.length,
		labeled: labels.size,
		reviewed: rows.filter((r) => r.status === "reviewed").length,
		hold: rows.filter((r) => r.status === "hold").length,
		unlabeled: utterances.filter((u) => !labels.has(u.id)).length,
		bySplit: Object.fromEntries(
			["dev", "test"].map((split) => [
				split,
				rows.filter((r) => r.split === split).length,
			]),
		),
		crossSplitConversations: crossing(conversations.values()),
		crossSplitTexts: crossing(texts.values()),
		crossSplitComponents,
		lineageLinks: lineage.length,
		unknownLineage,
		missingUtterances,
		humanReviewProvenance: "not_verified",
		ok:
			crossSplitComponents === 0 &&
			unknownLineage === 0 &&
			missingUtterances === 0,
	};
}
