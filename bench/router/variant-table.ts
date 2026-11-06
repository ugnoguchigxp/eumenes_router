/**
 * Variant-aware correction table ("this kind of sentence → this tool").
 *
 * A stored correction matches a new utterance when ANY of:
 *   1. exact normalized key (surface or reading) is equal,
 *   2. char-bigram Dice of the normalized readings ≥ τ (τ chosen on dev only),
 *   3. embedding cosine ≥ θ (the router's feedbackNear path, unchanged).
 * Normalization: NFKC (full/half width), lowercase, katakana → hiragana, loanword/romaji alias map,
 * punctuation/space removal, polite/sentence-final ending stripping. Kanji readings come from a
 * Python preprocessor (experiments/correction/reading.py, pykakasi) since no TS reader is available.
 */

/** Romaji / English spellings → hiragana. Generic tech & app vocabulary, written without looking at the test variants. */
export const ALIASES: Record<string, string> = {
	git: "ぎっと",
	github: "ぎっとはぶ",
	google: "ぐーぐる",
	youtube: "ゆーちゅーぶ",
	python: "ぱいそん",
	excel: "えくせる",
	word: "わーど",
	pdf: "ぴーでぃーえふ",
	ai: "えーあい",
	chatgpt: "ちゃっとじーぴーてぃー",
	gpt: "じーぴーてぃー",
	slack: "すらっく",
	zoom: "ずーむ",
	mail: "めーる",
	email: "いーめーる",
	gmail: "じーめーる",
	image: "いめーじ",
	music: "みゅーじっく",
	song: "そんぐ",
	timer: "たいまー",
	alarm: "あらーむ",
	weather: "うぇざー",
	news: "にゅーす",
	web: "うぇぶ",
	search: "さーち",
	app: "あぷり",
	ui: "ゆーあい",
	html: "えいちてぃーえむえる",
	css: "しーえすえす",
	api: "えーぴーあい",
	url: "ゆーあーるえる",
	browser: "ぶらうざ",
	chrome: "くろーむ",
	amazon: "あまぞん",
	spotify: "すぽてぃふぁい",
	x: "えっくす",
	twitter: "ついったー",
	line: "らいん",
	pc: "ぴーしー",
	iphone: "あいふぉん",
	android: "あんどろいど",
	model: "もでる",
	data: "でーた",
	memo: "めも",
	map: "まっぷ",
	"3d": "すりーでぃー",
	cg: "しーじー",
	bgm: "びーじーえむ",
	ok: "おーけー",
	note: "のーと",
};
// Polite / sentence-final endings, longest first (applied to the hiragana reading, repeatedly, at the end).
const ENDINGS = [
	"おねがいします",
	"おねがいいたします",
	"おねがい",
	"くださいませ",
	"ください",
	"くれませんか",
	"もらえますか",
	"もらえる",
	"ほしいです",
	"ほしい",
	"くれる",
	"ちょうだい",
	"ませんか",
	"ますか",
	"ます",
	"です",
	"でしょうか",
	"かな",
	"よね",
	"ね",
	"よ",
	"な",
	"か",
	"わ",
	"くれ",
	"て",
];
const PUNCT = /[\s\p{P}\p{S}ー〜]/gu;

export const kataToHira = (s: string) =>
	s.replace(/[\u30a1-\u30f6]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0x60),
	);
export function surfaceKey(text: string) {
	let s = text.normalize("NFKC").toLowerCase();
	s = s.replace(/[a-z0-9][a-z0-9.+#-]*/g, (w) => ALIASES[w] ?? w);
	return stripEndings(kataToHira(s).replace(PUNCT, ""));
}
export function readingKey(reading: string) {
	return surfaceKey(reading);
}
export function stripEndings(s: string) {
	for (let changed = true; changed;) {
		changed = false;
		for (const e of ENDINGS)
			if (s.length > e.length + 2 && s.endsWith(e)) {
				s = s.slice(0, -e.length);
				changed = true;
				break;
			}
	}
	return s;
}
const bigrams = (s: string) => {
	const m = new Map<string, number>();
	for (let i = 0; i < s.length - 1; i++) {
		const g = s.slice(i, i + 2);
		m.set(g, (m.get(g) ?? 0) + 1);
	}
	return m;
};
/** Multiset char-bigram Dice coefficient. */
export function dice(a: string, b: string) {
	if (a === b) return 1;
	const A = bigrams(a),
		B = bigrams(b);
	let inter = 0,
		na = 0,
		nb = 0;
	for (const v of A.values()) na += v;
	for (const v of B.values()) nb += v;
	for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
	return na + nb ? (2 * inter) / (na + nb) : 0;
}
export type Keyed = { surface: string; reading: string };
export const keyOf = (text: string, reading?: string): Keyed => ({
	surface: surfaceKey(text),
	reading: readingKey(reading ?? text),
});
/** Rule-table match score: 1 for an exact normalized key, else reading Dice (0..1). */
export function tableScore(a: Keyed, b: Keyed) {
	if (a.surface === b.surface || a.reading === b.reading) return 1;
	return dice(a.reading, b.reading);
}
/** Smallest τ in the grid whose false-match rate on dev (utterances with a different-gold dev neighbour ≥ τ) is ≤ maxFalse. */
export function tuneTau(
	dev: Array<{ key: Keyed; gold: string }>,
	maxFalse = 0.02,
	grid = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
) {
	const best = dev.map((x, i) =>
		Math.max(
			0,
			...dev
				.filter((y, j) => j !== i && y.gold !== x.gold)
				.map((y) => tableScore(x.key, y.key)),
		),
	);
	const curve = grid.map((t) => ({
		tau: t,
		falseRate: best.filter((b) => b >= t).length / Math.max(1, dev.length),
	}));
	return { tau: curve.find((c) => c.falseRate <= maxFalse)?.tau ?? 1, curve };
}
