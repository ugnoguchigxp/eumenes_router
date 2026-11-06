import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
const SRC = "/workspace/eumenes_router/data/bench-r2.db",
	DST = "/tmp/r2/scale2000.db";
copyFileSync(SRC, DST);
const db = new Database(DST);
const real = db.query("select id, card_json from bench_cards").all() as any[];
const objs = [
	"請求書",
	"経費",
	"在庫",
	"会議室",
	"出張",
	"勤怠",
	"顧客名簿",
	"議事録",
	"契約書",
	"配送",
	"問い合わせ",
	"社内wiki",
	"給与明細",
	"発注",
	"予算",
	"アンケート",
	"採用候補",
	"備品",
	"駐車場",
	"研修",
	"日報",
	"見積",
	"ポイント",
	"クーポン",
	"天気通知",
	"家計簿",
	"レシピ",
	"植物の水やり",
	"ペットの記録",
	"読書メモ",
];
const acts = [
	"登録",
	"検索",
	"集計",
	"削除",
	"共有",
	"承認",
	"印刷",
	"翻訳",
	"要約",
	"変換",
	"予約",
	"通知",
	"分析",
	"バックアップ",
	"比較",
	"並べ替え",
	"グラフ化",
	"エクスポート",
	"監視",
	"整理",
	"下書き",
	"校正",
	"アーカイブ",
	"復元",
	"同期",
	"点検",
	"見直し",
	"評価",
	"割り当て",
	"照合",
	"予測",
	"記録",
	"確認",
	"作成",
	"更新",
	"取り消し",
	"転送",
	"分類",
	"抽出",
	"可視化",
	"計画",
	"棚卸",
	"精算",
	"督促",
	"配布",
	"回収",
	"採点",
	"引き継ぎ",
	"整形",
	"暗号化",
	"署名",
	"照会",
	"調整",
	"登録解除",
	"受付",
	"手配",
	"集約",
	"監査",
	"移行",
	"点呼",
	"予告",
	"周知",
	"掲示",
	"保管",
	"廃棄",
	"申請",
	"審査",
];
let n = 0;
const want = 2000 - real.length;
const ins = (id: string, card: any, passages: string[]) => {
	db.query(
		"INSERT INTO bench_cards(id,kind,impact,card_json) VALUES (?,?,?,?)",
	).run(id, "dedicated", "none", JSON.stringify(card));
	passages.forEach((t, i) => {
		db.query(
			"INSERT INTO bench_passages(card_id,item,text) VALUES (?,?,?)",
		).run(id, i, t);
		db.query("INSERT INTO bench_fts(card_id,text) VALUES (?,?)").run(id, t);
	});
};
db.transaction(() => {
	const nearDup = Math.round(want * 0.1);
	for (let i = 0; i < nearDup; i++) {
		const r = JSON.parse(real[i % real.length].card_json);
		const id = `syn.dup${i}`;
		const c = {
			...r,
			id,
			title: r.title + "（別系統）",
			summary: r.summary + "（別系統）",
		};
		ins(id, c, [c.title + "：" + c.summary, ...(r.examples ?? []).slice(0, 3)]);
		n++;
	}
	outer: for (const o of objs)
		for (const a of acts) {
			if (n >= want) break outer;
			const id = `syn.${n}`;
			const c = {
				id,
				kind: "dedicated",
				title: `${o}の${a}`,
				summary: `${o}を${a}する専用の道具`,
				useWhen: [`${o}を${a}したい`],
				examples: [`${o}を${a}して`, `${o}の${a}をお願い`],
				impact: "none",
			};
			ins(id, c, [`${c.title}：${c.summary}`, ...c.useWhen, ...c.examples]);
			n++;
		}
})();
console.log(
	"cards",
	(db.query("select count(*) n from bench_cards").get() as any).n,
);
