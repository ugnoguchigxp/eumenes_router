# eumenes_router 計画（2026-11-02）

状態（2026-11-09）: 判断一式、best-v2、構造判断とA/Bの入口、SQLiteと出荷機構を実装済み。現行候補はroute7 / structure6 / 指示v8。構造応答の受信・容量とREADMEの3件を修正し、出荷検査116件に成功した。同じ技術品質基準で77.0→80.5点。結果と対象digestは§13.13。既存の構造判断の遅延目標未達、実モデルの再測定、人の正解確認と新規holdoutは残る。過去の実測・採否と将来性の採点は履歴として残す。

一言で: Eumenes の「担当の振り分け（Toolchain Router）」を研究用の独立プロジェクトに切り出す。正解付きの評価データで方式を実測して決め、勝った方式を tarball で Eumenes に戻す。Router の完成品は目指さない。

## 0 経緯と、決まっていること

| 日付 | こと |
| --- | --- |
| 2026-11-01 | Eumenes の設計書 `/Users/y.noguchi/Code/eumenes/spec/toolchain-router-redesign-2026-11-01.md`（以下「設計書」）で、統合 Router を設計し合意（設計書 §11）。R1〜R3 を Eumenes に実装済み。fixture 検証だけで、既定は `router.mode: off`（設計書 §12） |
| 2026-11-02 | 利用者の判断: 試行錯誤が要る domain は、memory（`../eumenes_memory`）・world model（`../eumenes_world_model`）と同じく外に出して、検証しやすい単位にする。Reranker・Transformer・LtR のどれが正しいか分からないので、実測で決める。切り出す粒度は §3（「判断一式」）。名前は `eumenes_router` |
| 2026-11-03 | 利用者の判断: LLM に回した回は、LLM が判断に要したトークン消費を見るために測る（§9「LLM の判断トークン」、少ないほど良い）。計測にはクラウドの API（現行で最も弱いモデル、`.env` で指定）を使ってよい。評価データの外部への送信を禁じる規則は削除した |
| 2026-11-03 | 利用者の判断: LARM に配備された文脈判定（通常 profile の `decision.context`）は試す。本流（best-v2）とは別に、`archive/larm-context/`（旧 `examples/larm-context/`。パッケージに入れない、設定ファイルで動かす）で bench の正解付きデータに当てて測る。会話へ戻す条件は dev で決め、scenario・network に結び付ける。Eumenes への組み込みは Eumenes のセッションで行う |
| 2026-11-03 | 利用者の説明: 配備済みの `ruri-conv20-s0-fp32-v1` は、bench の FT と同じ学習セット（dev split だけ）を少し改良し、AI MAX 395 で学習したもの。ツールごとに10件、会話は20件だけ。test と、test から作った言い換え（`data/variants-v2/`）は学習に使わない。学習に使った id の一覧はまだ受け取っていない |
| 2026-11-03 | 利用者の判断: すぐ効く訂正（訂正の記憶）は bench で測って θ・β を決める。近い訂正の正解を候補に足す（上の契約）。reranker の学習し直し（月1回程度）は、学習なしで回るならしない。効くと見込めるときだけ行う（§9「学習し直しの判断」） |
| 2026-11-03 | 訂正の記憶の設定を決めた（bench、e5 small の空間、LARM の文脈判定の点数を検索と融合した Router）。θ = 0.9177（dev の意図の違う組の 1% 以下しか超えない値）、β = 1.5（dev で訂正を入れ、関係ない dev 発話の崩れの 95% 上限が 1% 以下の最大。dev は LARM の学習に一部使われ崩れにくく出るので上限で決めた）、正解を候補に足す。test で1回: 訂正した発話 76.2%、その言い換え 68.2% が直る、関係ない発話の崩れ 0%（166件）、ほかの言い換え 0.7%、対照 1/40（見直しの後の値。正解が食い違うときにも候補を足していた前の測定では 85.7% / 70.9%。dev の β の選び方は変わらない）。回復率 ≥ 90% は未達。ホストはこの空間で `feedbackNear` 0.9177・`feedbackWeight` 1.5 を渡す（パッケージの既定値は変えない） |
| 2026-11-03 | 利用者の判断: best-v2 をメインの判断の実装にする。劣る方式はパッケージ（tarball）に入れない。今回検証した実装（LLM による確認、LARM の文脈判定の単体利用、言い換えの意味の Haiku 判定）は `archive/` に移して ARCHIVED と明示し、本文を含まない実測データをリポジトリに残す（同じ改善をやり直さないための証跡） |
| 2026-11-03 | 利用者の判断: 文の構造の判断を Router に入れる。起きる頻度ではなく、これから複合になる依頼に備えるため。依頼が2件以上なら、並列でも多段でもパイプラインへ送り、登録済みのパイプラインから近いものを選ぶ。参照つきの単一の依頼（「この音楽にぴったりな画像も作って」）は、依頼と参照を分けて Router で処理する（§10 M3b）。設計書 §11 #6 の全体の形が「発言 → 構造の判断 → 検索 → Router → 決定表」に変わる。パイプラインは Eumenes に仕組みがあるが、別のプロジェクトとしてやり直す予定（利用者）。Router との境目は契約で持ち、今の Eumenes の定義の形には結び付けない。設計書の直しと Eumenes への組み込みは Eumenes のセッションで行う |
| 2026-11-03 | 利用者の判断: ブラウザ操作は多段でも browser.operate で閉じる。複数の担当を使うシナリオがパイプライン。`BEST_V2_PARAMS` を、LARM で学習し直した ruri（`ruri-conv20-structure-v1-s0-fp32-v1`）の点数で dev から学習した版に差し替える |
| 2026-11-04 | 利用者の判断: これまでで成績の一番良い組み合わせを本流にし、それ以外は `archive/` に移す。本流は best-v2（ツールの候補 10件）＋ LARM の学習し直した ruri（`ruri-conv20-structure-v1-s0-fp32-v1`）の点数＋ sr-corr ＋ 訂正の記憶（θ 0.9177・β 1.5・正解を候補に足す）。test 1位 87.1%・回す率 18.0%・言い換え 81.6%。構造の判断（S1・S3）、ruri の学習データの道具、round2・round3・algo4 は archive。LLM の構造の判断（S3）を重ねると test 88.5% だが、1発言 約 900 トークン・p95 2.9 s で、トークンを減らす方針に反するので本流にしない |
| 2026-11-04 | 利用者の判断: 本流は **構造の判断（LLM、S3）→ 参照を伏せる振り分け（mask）→ 依頼の部分ごとに best-v2（ツールの候補 10件）** とする。トークンよりこの判定（参照と依頼・複数の依頼）を優先する。上の行で S3 を外したのは費用を理由にした Claude の判断で、成績の一番良い組み合わせという指示に反していた。本流の値: 作った対 186件で 90.3%（今の経路＋手がかり 47.3%）、参照の側 1.3%、複数 → パイプライン 84.5%、単一 → パイプライン 0.9%、感想・質問 → 会話 100%、test 217件 88.5%（今の経路 87.1%）。1発言 約 900 トークン・p95 2.9 s。S1・候補 5 は archive のまま |
| 2026-11-04 | 利用者の判断: 本流は2つとも採る。A（direct）: best-v2 だけ（ツールの候補 10件）。B（structured）: 構造の判断（LLM）→ 参照を伏せる振り分け → 依頼の部分ごとに best-v2。Eumenes 側がどちらを使うかを選べるようにする。1つの tarball に両方を入れ、Eumenes 側は呼び方（呼ぶ関数）で選ぶ。Router の中で発言ごとに切り替えるのではなく、どちらが良いかを試すための構成。最終的には1つに絞るかもしれない（§10 M3d） |

設計書 §11 の決定（このプロジェクトでも守る）:

| # | こと | 決め |
| --- | --- | --- |
| 1 | 検索 | 残す（`find_toolchain` の検索の段は消さない・迂回しない）。担当・パイプライン・汎用の担当は増える前提。種類ごとの枠（専用・パイプライン・汎用）も残す |
| 2 | 判断のモデル | 判断モデル（d1-2B）と CrossEncoder の両方を試す |
| 3 | 追加学習 | してよい |
| 4 | 即時の訂正 | 利用者の明示の訂正だけを「訂正の記憶」に残し、近い発言にだけ上限付きの補正をかける。重みは逐次更新しない。まとめて学習し、固定の評価で通ったときだけ版を切り替える |
| 5 | LLM の選ぶ呼出し | なくす。点数の低い回も LLM に選ばせない（ホストの聞き返しか会話の回） |
| 6 | 全体の形 | 発言 → 検索 → Router 1回 → 決定表 → 会話の回か、今の引き渡し。2026-11-03 に、検索の前に構造の判断を足すと決めた（§10 M3b）。2026-11-04 から、構造の判断は LLM（担当は選ばせず、構造だけを返させる）で、本流 |
| 8 | モデルの実行場所（本番） | LARM。Eumenes はモデル・ONNX Runtime・学習の仕組みを持たない |

このプロジェクトで新しく確かめる仮説: 「候補ごとの Transformer 推論を足さない方式（Embedding＋語彙・構造の特徴＋軽量 LtR、または埋め込みの微調整）でも、判断モデルや CrossEncoder と同等になるか」。設計書 §7.3 の比較にはこの枠がない。

## 1 目的と成果物

| 項目 | 中身 |
| --- | --- |
| 問い | 生成 LLM を使わずに、今の Embedding 検索より明確に賢い振り分けができるか。どの採点方式が、精度・遅延・資源・会話 LLM への干渉で勝つか |
| 成果物 1 | 正解付きの評価データ（400件以上） |
| 成果物 2 | 方式ごとの実測の比較（精度・遅延・資源を、同じデータ・同じ判定で） |
| 成果物 3 | 勝った方式を含む出荷パッケージ `eumenes_router`（tarball） |
| しないこと | Eumenes の実行・TODO・画面・bundle 登録の作り直し。勝たなかった方式の出荷 |

## 2 Eumenes の現状（事実。設計書 §1・§12 から）

| 項目 | 値 |
| --- | --- |
| 有効な担当 / 読む道具 / 担当ごとの文の数 | 26 / 5 / 平均9.2（6〜21） |
| Router の入力の候補数 | 20〜33件（検索の枠 最大18＋会話・記憶・使っている担当・仕事・訂正・確認）。担当の総数に比例しない |
| 今の既定の経路（`router.mode: off`） | Ruri の意図判定（5分類の `request` 確率を閾値0.6で2択）→ Embedding 検索 → 会話 LLM の選ぶ呼出し |
| 選ぶ呼出しの時間 | LARM: 中央値45.3s、p90 68.0s、26回中9回が出力の上限で切断。クラウド: 中央値5.3s |
| Ruri / 検索の時間 | Ruri p50 30ms・p95 125ms（LAN 往復込み）/ 検索 p50 89ms・p90 1.29s |
| 選ばれた担当の検索順位（171回） | 1位62%、2位22%、3位9%、4位6%、候補になかった1% |
| 1位と2位の類似度の差（平均） | 1位が選ばれた回0.025 / 2位以下が選ばれた回0.008。1位の類似度は0.776〜0.943に詰まっている |
| 検索の採点 | 発言の先頭2000字の埋め込みと、担当ごとの文（「名前: 説明」・`useWhen`・`examples`）の内積の最大値。FTS は使っていない（`ftsRank` は常に null） |
| 埋め込み | LARM の embedding。10-12 の記録では384次元の多言語 e5（small）。今の catalog の値は確認していない |
| 新しい経路（R1〜R3、既定 off） | 検索（Router 用の枠）→ LARM の `system-one` の choice（呼出しごとの criteria）→ 訂正の補正 → 決定表 → 引き渡し。欄は2回目の呼出し（choice・抽出）。訂正の記憶 `router_feedback`、記録 `router_traces`、shadow |
| LARM の Router の profile | LARM 側で作業中（未完成） |
| 評価データ | 408件・58会話を書き出し済み。正解は0件 |
| 機械 | 本番の LARM は AI MAX+ 395。開発は MacBook |

診断（設計書 §1.4）: 内積の最大値は「作る」と「流す」のような動詞の違いをほとんど区別しない。判断の場所が3つ（Ruri の閾値・検索の枠・LLM）に分かれていて、誤りの原因が追えない。

## 3 切り出す範囲（判断一式）

### 3.1 粒度の判断

| 粒度 | 判断 | 理由 |
| --- | --- | --- |
| 判断器だけ（`state + criteria → 確率`） | 採らない | どのモデルが良いかは測れる。ただし LtR（検索の特徴を使う）、訂正の効果、担当を足したときの回帰、1,000件規模は測れない。LARM 側の計測とほぼ同じになる |
| **判断一式（索引・採点・訂正・決定表・評価）** | **採る** | 研究したい問いがすべて測れる。決定表を含めるのは、評価の数字を製品と同じ判定で出すため（判定が製品とずれると数字が甘くなる） |
| bundle 登録まで | 採らない | Router が読むのは振り分け用のカードだけ。実行の種類・schema・画面・artifact は研究の対象ではない |

### 3.2 持ってくる部品（コピー元。Eumenes は参照専用で、書き換えない）

| 部品 | コピー元（`/Users/y.noguchi/Code/eumenes/` 以下） | シンボル |
| --- | --- | --- |
| 担当の文・埋め込みの索引・文が変わった分だけの作り直し・類似度・枠 | `api/domains/capabilities/service/toolchains.ts` | `toolchainPassages`、`pendingVectorsInTransaction`、`saveVectorsInTransaction`、`similaritiesOf`、`rankBy`、`slotted`、`kindOf`、`CANDIDATE_SLOTS`、`ROUTER_SLOTS`、`candidatesInTransaction` |
| 採点の契約 | `api/domains/larm/contracts/route.ts` | `RouteInput`、`RouteAnswer`、`RouteCriterion`、`ROUTE_LIMITS`、`routeCriterionName`、`routeErrors` |
| 候補の並べ方・訂正による補正・決定表・予測集合 | `api/domains/dialogue/service/routed-route.ts` | `correctProbabilities`、`decide`、`predictionSet`、`several`、関連する型と定数（`RouteCandidate`、`Ranked`、`RouterSettings`、`RouteDecision`、`CONVERSATION_ID`、`MEMORY_ID` など） |
| 訂正の記憶 | `api/domains/toolchain-history/service/router.ts` と同 domain の repository | `feedback` 部分と近傍の読取り（`router_traces` の部分は持ってこない） |
| 評価の採点 | `scripts/router-bench/score.ts`、`score.test.ts` | 予測を製品の `decide` に通して採点する |
| Router の振る舞いの参考（コピーしない） | `api/domains/dialogue/service/routed-router.ts`、`api/domains/dialogue/service/intent-gate.ts` | 全体の流れ（`routerTurn`・`consult`・`rank`）と Ruri の意図判定 |

### 3.3 Eumenes に残すもの

| 部品 | 理由 |
| --- | --- |
| 動的な候補を作る（`routed-route.ts` の `routeCandidates`: 会話・記憶・`t<n>.check/amend/cancel`・`t<n>.redirect:<id>`・`c<n>.approve/decline`・`t<n>.answer`・`switch.discard`） | TODO・確認待ちの状態に依存する。パッケージには criteria（データ）として渡す |
| 決定の後の動作（予告・確認の文・TODO・Queue・やり直し。`routed-router.ts` の `carryOut`・`redirect`・`askAgain`） | Eumenes の実行の意味 |
| 欄埋め（`routeFields`：choice と抽出） | 引数を作るのは別の研究 |
| Ruri の意図判定（`intent-gate.ts`） | 確率は `signals` でパッケージに渡す。消すかどうかは研究の結果で決める（設計書 §3.6） |
| 記録 `router_traces` と、忘れる処理の起点 | 発言を忘れたら、その id をパッケージの `forget` に渡す |
| bundle 登録・実行・LARM の接続・設定（SQLite が正本）・資格情報 | Eumenes の責務。LARM の資格情報は Eumenes の backend の中に留める |

## 4 パッケージの契約（M0 で確定）

| 公開口 | 中身 | 依存してよいもの |
| --- | --- | --- |
| `eumenes_router` | 契約の型、候補の融合と枠、訂正の補正、決定表、予測集合、全体の流れ `route()` | なし（DB・時計・乱数・ネットワーク・モデルに直接依存しない。必要なものは引数で受ける） |
| `eumenes_router/sqlite` | 表・migration・読み書きの関数 | ホストから借りた同期接続だけ。open/close・transaction・PRAGMA・独自 writer を持たない。書込みは `*InTransaction` で、ホストの transaction の中で呼ばれる |

形（2026-11-04、本流の2つの入口。M0 の形からの差分は下の表と §10 M3d）:

```ts
// ポート（ホストが渡す。ネットワークの呼出しは transaction の外で）
type Embed = (texts: readonly string[]) => Promise<{ space: VectorSpace; vectors: number[][] }>;
type Score = (input: RouteInput) => Promise<RouteAnswer>;   // reranker（LARM の文脈判定）。scores が必須
type Analyze = (prompt: { version; system; user }) => Promise<string>; // 構造の判断（routeStructured だけ）

// eumenes_router/sqlite（ホストの transaction の中で）
migrations: readonly string[]                                    // 表の SQL。ホストが自分の migration の仕組みで順に1回ずつ当てる（eumenes-memory・eumenes-world-model と同じ。2026-11-04）
syncCardsInTransaction(db, cards, space): { pending: Passage[] } // その space で、文の digest が変わった分だけ。全文検索の索引も保つ
saveVectorsInTransaction(db, space, rows): void                  // rows は { id, revision, item, text, vector }
srCardsInTransaction(db, { space, available }): RouterCard[]     // 有効で available なカードと、その space の文のベクトル
lexicalInTransaction(db, text): Map<string, number>              // 全文検索（trigram）のカードごとの −bm25 の最大
importExamplesInTransaction(db, memory, space) / examplesInTransaction(db, { source, space }) // best-v2 の記憶
nearFeedback(db, { vector, space, threshold, limit? }): NearFeedback[] // 既定 limit 5、新しい 500 件を走査
recordFeedbackInTransaction(db, feedback) / setFeedbackStateInTransaction(db, id, state, at) / forgetInTransaction(db, messageIds)

// eumenes_router（Eumenes と bench が同じ関数を使い、流れのずれを作らない）
const ports = { embed, rerank, read: { cards, lexical, nearFeedback }, model: loadBestV2(BEST_V2_PARAMS, memory), settings, log };
const turn = { state: { text, previousAgent, previousUser }, dynamic, passages?, retained?, available, instructions, resource?, asked?, signals? };
// retained: 進行中の仕事の担当（同期済みのカードの id）。検索で見つからなくても offer に入れ、訂正の正解と同じく best-v2 で採点する（2026-11-04、Eumenes への組み込みで追加）
const a = await route(ports, turn);                         // A: direct
const b = await routeStructured({ ...ports, analyze }, turn); // B: structured
// a: { answer, corrected, decision, explain: { retrieval, offered, skipped, gate, defer, conflict, conflicts, intentChat } }
// b: { structure, parts: [{ text, result }], decision }。decision は行 9 の { to: "pipeline", steps: [{ text, candidate, after }] } もありうる
// ツールの候補が無ければ reranker を呼ばず行 8（会話）。説明が空白、名前が不正、候補が 128 を超えるときは larm_invalid_route_request
// explain.conflicts は、補正が衝突した訂正の id。パッケージは状態を書かない。ホストが setFeedbackStateInTransaction で conflict にする
checkReachability({ cards, eval, before? }): ReachabilityReport
```

| 2026-11-04 の差分（M3d） | 中身 |
| --- | --- |
| 検索 | `candidatesInTransaction`（埋め込みの最大内積の枠）は消し、sr-corr（`srCardsInTransaction`・`lexicalInTransaction`・`srScores`・`srOffer`・`srRanking`、種類ごとの枠 `capByKind`）にした |
| 採点 | 選ぶ呼出し（`probabilities` で1つを選ぶ）は消し、reranker の `scores` を best-v2 に渡す。基準の説明はカードの reranker の文（`rerankDocument`、上限 4096字）、本文は先頭 400字 |
| 決定表 | best-v2 が回さないときが「自信あり」（`decide` の `confident`）。`low` は 0（聞き返しの行 8 にしない）。訂正で1位が変わったときは自信なし |
| 版 | `contractVersions.route` 2、`structure` 1。`BEST_V2_PARAMS` の形式 `best-v2.v2` |

案からの差分（M0）:

| 点 | 確定 |
| --- | --- |
| `syncCardsInTransaction` の空間 | 引数に `space` を足した。その空間でベクトルが無い、または文が変わった passage だけを返す |
| 検索の `text` | 受け取らない。FTS（基準0）は M2。`ftsRank` は製品と同じく null |
| `nearFeedback` の θ | 呼び出し側が `threshold` を渡す。`route()` は設定の `feedbackNear`（既定 0.95）を渡す。値は embedding の空間ごとに dev だけで決める（意図の違う dev の組の 1% 以下しか超えない値。bench の `correct --theta dev`） |
| 訂正の正解を候補に足す（2026-11-03） | `route()` は採点の前に `nearFeedback` を読み、その正解（`rightId`）を `read.candidates` の `include` に渡す。補正は候補の中でしか効かないので、検索の枠が正解を落としても採点させる |
| 時計・乱数 | 訂正の `id` と `at` はホストが渡す。状態変更も `at` を受け取る |
| 忘却 | 消した行数を返す。対象は `router_feedback` だけ（`router_traces` は持ってこない） |
| 到達性 | Recall@枠と Recall@1。`set` を全件渡したカードは Recall@集合。`before` の Recall@1 から 0.02 以上下がったカードを `regressions` に入れる。`refused` はその有無 |
| passage の主キー | `(card_id, item, space)`。`revision` 列は残す。カード id が安定で、版が変わっても行を取り違えないため |
| 衝突 | `explain.conflicts` は、補正が衝突したときに読んだ訂正の id。行の状態はホストが `conflict` にする |
| 会話と記憶 | 文はホストが `passages` か `dynamic` で渡す。`passages` のとき、足りない二つを足す。空の offer は行 8 で、採点しない |
| 索引が空 | ベクトルが無いとき、read 以外の有効なカードを id 順に返す。`strict` なら空。`fromHistory` は印だけで順位も枠も変えない |
| 候補の上限 | 安定した候補は 128 で切らない。超えた、または説明が空白なら採点の前に `larm_invalid_route_request`。動的な候補は枠が足りないとき pending を残して落とす |
| カードの形 | id、空でない revision と title、kind、impact、digest。useWhen と examples の件数と文字数では拒まない |

Eumenes からパッケージに渡す、振り分け用のカード（bundle から作る）:

```json
{"id":"music.create","revision":"r-41c2","kind":"dedicated","title":"作曲","summary":"場面や気分に合う曲・BGM・歌を新しく作る","useWhen":["…"],"examples":["…"],"impact":"none","digest":"sha256:…"}
```

`kind` は `dedicated`・`pipeline`・`general`・`read`。`impact` は担当の `minImpact` で、実際の影響はホストがもう一度決める（Router の点数で影響を下げない）。

| 規則 | 中身 |
| --- | --- |
| ログ | logger は外から渡す。id と数値だけを渡し、発言の本文・埋め込み・Provider の生の応答は渡さない |
| 名前 | コード（定数・分岐・既定値・エラーメッセージ）とファイル名に、モデル名・profile 名を書かない。bench の設定ファイルと実行結果の記録にだけ書く |
| 版 | `contractVersions`（cards・route・feedback・structure）と `dbSchemaVersion`（`migrations` の数）を manifest に出す（`eumenes-memory` と同じ） |
| 忘却 | 訂正は、文を作ったすべての発言の id を持つ。どれかを忘れたら消える |

## 5 パッケージが持つ表

| 表 | 中身 | 今の Eumenes からの引き継ぎ |
| --- | --- | --- |
| `router_cards` | カードの版・digest・有効かどうか | 正本は Eumenes の公開済みの定義で、同期のたびに作り直す |
| `router_passages` | card_id・revision・item・space・text_digest・vector。主キーは `(card_id, item, space)` | 列の意味は `capability_toolchain_vectors` と同じ。移さずに作り直す。主キーに card_id を入れた理由は §4 |
| `router_feedback` | 訂正（source の発言 id・状態・ベクトル・誤り・正解・衝突） | migration `toolchain-history/0005-router` の表を、今の列のまま引き継ぐ |
| `router_weights` | LtR の重みの版・評価結果・有効かどうか | LtR が勝った場合だけ足す |

## 6 リポの構成

```text
eumenes_router/
  LICENSE
  README.md
  AGENTS.md
  plan.md
  src/            出荷する（contracts / retrieval / decision / db。公開口は index.ts と sqlite.ts）
  src/scorers/    本番で使う採点器だけを出荷する（例: LtR が勝ったら純 TS の線形モデル）
  bench/          研究専用・出荷しない: 評価データの読込み、指標、合成カタログ、leave-one-out、速度計測、
                  比較用アダプタ（llama.cpp の rerank / embedding、Ollama、OpenAI 互換、LARM の直呼び）、学習の道具
  inspector/      研究専用・出荷しない: 正解付けと誤りの閲覧（Hono と小さな画面）
  test/           bun test
  data/           Git 管理外: 評価データ、カードの写し、埋め込みのキャッシュ、実行結果
```

| 道具 | 決め |
| --- | --- |
| 言語・実行 | TypeScript、Bun、`bun:sqlite`（FTS5 trigram は Eumenes の `capability_search` で使っている） |
| HTTP | Hono（inspector だけ） |
| 整形・lint | Eumenes と同じ oxfmt / oxlint の設定（タブ、80桁、deny-warnings） |
| 配布の形 | `eumenes_memory/package.json` と同じ: `exports`（`.` と `./sqlite`）、`files: ["dist", …]`、`prepack` で build |
| 入れない依存 | Transformers.js・onnxruntime などのモデル実行環境（モデルは HTTP で呼ぶ）。ベクトル DB（2,000件×9文×384次元は約700万 float で、総当たりで足りる） |
| 学習の道具 | 埋め込みの微調整・CrossEncoder の学習に Python 等が要る場合は `bench/` に閉じる。出荷物と Eumenes には入れない。学習したモデルは HTTP の推論サーバーで動かし、本番では LARM に置く |

## 7 評価データ

| 項目 | 中身 |
| --- | --- |
| 元 | `/Users/y.noguchi/Code/eumenes/data/router-eval/2026-11-01-snapshot/`（`items.jsonl` 408件、`predictions.jsonl`、`README.md`）。`data/` に写して使う |
| 扱い | 会話の本文を含む。Git・ログに出さない |
| 1件の形 | `{id, group, split, state:{previous_agent, previous_user, text}, gold:{primary, acceptable[]}, tags[], review:{status, note}}` |
| 正解の id | `conversation.respond`、担当の id、`read_memory` などの読む道具、`memory.request`、`work.check/amend/cancel`（番号なし）、`redirect:<担当 id>`、`pending.approve/decline/answer`、`ask`。詳細は元の `README.md` |
| 予測（当時） | `predictions.jsonl`: 当時の検索の候補・順位・類似度、選ばれた担当、`outcome`、Ruri の判定。正解を付けるときは見ない（引っ張られる） |
| カードの元 | `/Users/y.noguchi/Code/eumenes/spec/assets/router-criteria-2026-11-01.json`（`stable` 33件: id・kind・説明。`dynamicExamples`: 動的な候補の形）。検索に要る全文（`useWhen`・`examples` の全部）は入っていない |
| 正解付け | 利用者が付ける（モデルの選択を正解にしない）。付け終えたら、会話（`group`）の単位で train・calibration・test に分け、test は固定する |
| 言い換えの評価セット（2026-11-03） | 表現の揺らぎへの強さを測る。元は test のうち dev と同文でない発話（200字以下、同文はまとめる）155件。8種（`paraphrase`・`casual`・`keigo`・`indirect`・`fragment`・`verbose`・`asr`・`mixed`）を人手（Claude のセッション）で書き、正解のツールと説明文は書き手に見せない。正解は元の発話から継ぎ、文脈（直前の発言・hints）も元と同じにする。意味が変わっていないかを Haiku に別に判定させ、「違う」とされたものは見直して直すか捨てる。置き場所は `data/variants-v2/`。値は「言い換えでの値」として test の精度と分けて報告し、これを見て構成を選び直さない |
| 構造の評価セット（2026-11-03、計画） | 構造の判断（§10 M3b）を測る。① 作った対: 型（参照つきの単一・多段・並列・依頼なし）× 作る系の担当の組 × 言い回しで 200文前後。参照と依頼を入れ替えた対（「この音楽に合う画像」と「この画像に合う音楽」）を必ず入れる。Claude のセッションが書き、正解は作り方で決まる。② 実際の発話: dev・test から作る系の名詞が2つ以上、または述語が2つ以上の発言を拾い、構造の正解を下書きして M1 で人が確かめる。学習に使う対と評価の対は型ごとに分ける。置き場所は `data/structure/`。作った対の値は「作った対での値」として、実際の発話の精度と分けて報告する |

目標の件数（設計書 §7.1。足りない区分は人が書く。担当の `examples` の写しは入れない）:

| 区分（tag） | 件数 |
| --- | --- |
| 雑談 `chat` | 80 |
| 単独の依頼 `single`（担当ごとに6件以上） | 190 |
| 紛らわしい組 `confusable:<a>/<b>`（作曲／再生、画像／3D、Web検索／天気・株価 など） | 60 |
| 指示語・前の仕事の続き `reference` | 40 |
| 仕事への返答 `work-reply` | 40 |
| 訂正 `correction` | 30 |
| 複数工程 `multi` | 30 |
| 確認・質問への答え `pending-answer` | 30 |
| 担当のない依頼 `out-of-scope` | 20 |

足りないもの（M0 で解く）:

| 不足 | 対処 |
| --- | --- |
| 担当の全文（`useWhen`・`examples`）のカード | Eumenes 側に、公開済みの定義からカードを JSON で書き出す口を足す（Eumenes のセッションで行う） |
| その回の仕事・確認待ちの状態（設計書 §7.1 の `state.todos`・`pending`）と、当時の動的な候補 | Eumenes 側の書き出しに足す（同上）。それまでは、正解が `work.*`・`pending.*`・`redirect:*` の行だけ、bench が汎用の動的な候補を出す |

## 8 比べる方式

| 記号 | 方式 | 実行 |
| --- | --- | --- |
| 基準0 | FTS（trigram）の1位 | パッケージ内 |
| 基準1 | 今の検索の1位（埋め込みの最大内積） | パッケージ内（埋め込みはキャッシュ） |
| L | Embedding＋語彙・構造の特徴＋pairwise logistic（純 TS、依存なし）。特徴: 類似度（最大・平均）、FTS/BM25、使っている担当との一致、仕事・資源の種類との一致、Ruri の `chat` の確率、訂正の近傍。木系は線形との差が出たときだけ試す | パッケージ内 |
| E | 埋め込みの微調整（紛らわしい組を難しい負例にした対照学習）＋基準1の採点。実行時の費用は今と同じ。モデルを替えたら埋め込みを作り直す | 学習は bench、推論は HTTP |
| C | CrossEncoder（日本語の小型と310M級の2種。具体名は設計書 §4.1）、学習なし／あり | HTTP（llama.cpp の rerank か LARM） |
| D | 判断モデル（d1-2B）、学習なしで会話・担当・仕事・確認を1回で選ぶ | LARM の `system-one` choice |
| R | Ruri の2択＋Router と、Router だけの会話の判定 | 記録の Ruri の判定を使う |
| A | 今の選ぶ呼出し | 参考。`predictions.jsonl` の当時の選択だけ（新しく呼ばない） |
| S0 | 構造の判断なし（今の best-v2、文全体で振り分ける） | パッケージ内。M3b の基準 |
| S1 | 係り受け解析器 ＋ パッケージの規則（最後の述語の対象を依頼に、「〜に合う」「〜をもとに」などの修飾を参照に、「〜て、それに」を順に） | 解析器は HTTP（サーバーは利用者が立てる）。規則は純 TS |
| S2 | LARM のモデルに構造を返させる（判断モデルの抽出か、ruri に部分ごとの分類を学習させる） | LARM（LARM 側の作業） |
| S3 | クラウドの LLM（`.env` のモデル）に構造を返させる | 精度の上限の参考。LLM の判断トークンを測る |
| P1 / P2 | 登録済みのパイプラインから近いものを選ぶ。P1 は文の近さ（sr-corr ＋ reranker をパイプラインのカードだけにかける）、P2 は手順の一致（依頼ごとに振り分けた担当が、パイプラインの手順の担当に入るか・順が依存に合うか）＋ 文の近さ。P2 の手順は、やり直すパイプラインのプロジェクトとの契約（カードの `steps`）で受け取る | パッケージ内。reranker は HTTP |

すべての方式を、同じ評価データ・同じ `route()`・同じ決定表で採点する。

## 9 指標と合否

| 指標 | 定義 |
| --- | --- |
| Top-1 | 決定が `primary` か `acceptable` に入る割合。担当ごとの Top-1 の最小値も出す |
| 検索の Recall@枠 | 正解が Router の候補に入る割合（種類ごとにも）。「候補に出なかった誤り」と「誤った候補を選んだ誤り」を分ける |
| 誤起動率 | 正解が会話の発言のうち、担当・操作に渡した割合 |
| 見逃し率 | 正解が担当・操作の発言のうち、会話の回にした割合 |
| 不要な聞き返しの率 | 聞き返した回のうち、1位が正解だった割合 |
| 訂正からの回復率 / 副作用 | 訂正を1件入れた後、同じ発言・言い換えが正しくなる割合 / test の無関係な発言の決定が変わった割合 |
| 担当の追加の回帰 | leave-one-toolchain-out: 1担当を学習から外して登録し直したときの、その担当の Recall@1（cold start）と、ほかの担当の Recall@1 の変化 |
| 速度・資源 | 採点の P50・P95（warmup 10回の後、各100回以上、候補数20・40・64・128）、ロード時間、RSS、CPU 時間、会話 LLM を動かしたままの token/s の低下 |
| LLM の判断トークン | LLM に回した回で、LLM が判断に使った総トークン（入力＋思考＋出力）。思考を分けて取れないときは消費トークンから見積もる。少ないほど良い |

| 合否（測る前に決めておく） | 基準 |
| --- | --- |
| 判断モデル・CrossEncoder を残す | Top-1 が基準1より10ポイント以上高い |
| 速度（本番機） | 候補40件の採点の P95 ≤ 1.5s、会話 LLM の token/s の低下 ≤ 5% |
| 会話の判定 | 誤起動率・見逃し率が R 以下 |
| 訂正 | 回復率 ≥ 90%、副作用 ≤ 1% |
| 新しい担当 | cold start の Recall@1 ≥ 70%。ほかの担当の Recall@1 が2ポイント以上下がる登録は断る |
| Transformer を足さない方式（L・E）を採る | 最良の方式との Top-1 の差が3ポイント以内、かつ誤起動率・見逃し率が劣らない |
| 構造の判断（M3b） | 依頼の数と中心の依頼の担当が合う ≥ 90%（作った対と実際の発話を分けて出す）。参照の側の担当に送る誤り ≤ 5%。複数の依頼をパイプラインの段に送る ≥ 90%、単一の依頼をパイプラインの段に送る ≤ 2%。単純な発話（今の test 217件）の top1 を1ポイント以上下げない。判断の遅延 p95 ≤ 200 ms（LAN 込み）。LLM の方式はトークンを出し、ほかの方式と比べて決める |

| 記録の区分 | 中身 |
| --- | --- |
| オフライン | MacBook、埋め込みと予測はキャッシュ、ネットワークなし |
| live | LARM や推論サーバーを呼ぶ（利用者の合図の後だけ） |
| 本番機 | AI MAX+ 395、会話 LLM を動かしたまま（利用者の合図の後だけ） |

精度の最終値は、本番と同じ埋め込み（LARM）で取る。MacBook の別の埋め込みでの値は、方式の比較の目安にとどめる。

学習し直しの判断（2026-11-03、利用者の判断）: reranker の学習し直しは、学習なし（訂正の記憶）で回るならしない。量を増やすこと自体を目的にしない。

| 項目 | 決め |
| --- | --- |
| 学習を検討する合図 | 訂正の記憶で直らない誤りがたまる（同じ誤りの組の訂正が、θ より遠い発言どうしで繰り返される）／訂正の記憶が `nearFeedback` の走査（新しい 500 件）からあふれる／新しい担当の cold start の Recall@1 が 70% 未満／定期の評価で担当ごとの Recall・誤起動率が基準を割る。件数が増えただけでは学習しない |
| 正解の出どころ | 利用者の訂正（redirect・聞き返しへの答え・画面での選び直し）と人のレビューだけ。Router 自身の選択は使わない。訂正なしの完了は弱い正例（重み 0.3、割合に上限） |
| 偏りを抑える | 担当ごとに上限・下限の件数（学習曲線 3・5・10・20 件で伸びが止まる所）。正規化した文と埋め込みの近さ（θ 以上）で重複をまとめ、1つの会話から取る数に上限。動作確認・CLI の発言は出どころの印で分ける |
| 学習に入れないもの | test と、test から作った言い換え（`data/variants-v2/`）。test と θ 以上に近い発言。正解が動的な候補（仕事・確認・redirect）か指示語だけの短い発言（文だけでは学べない）。食い違う訂正（保留）。消えた担当のラベル |
| 足りない言い方 | 音声入力風・遠回し・省略は、dev から作った言い換えで補う（全体に占める割合に上限） |
| 効くと見込めるとき | 候補の版を作り、「今の版＋訂正の記憶」と同じ固定の評価（test・言い換え・対照・担当ごとの最小 Recall・leave-one-toolchain-out）で比べる。CI の下限が 0 を超えて良くなり、どの担当も下がらないときだけ LARM の版を切り替える。届かなければ捨てる |
| 毎回の報告 | 担当ごとの件数と利用の割合、正解の出どころの内訳、重複の割合、会話と担当の比、点数の分布の変化 |

合成のカタログ（100・500・1,000・2,000件）: 速度・メモリ・検索の Recall@枠の下がり方と、紛らわしい担当を足したときの回帰だけを測る。合成した発言は説明文と語彙が重なって精度が良く見えるので、精度としては報告しない。

## 10 段階

| 段 | すること | 終わりの条件 |
| --- | --- | --- |
| M0 | `git init`、`.gitignore`（`data/`・`node_modules/`・`dist/`）、Bun の雛形。§3.2 の部品をコピーし、§4 の形に分ける。`score.ts` を移す。Eumenes 側のカードと状態の書き出しを利用者に依頼する | 同じ評価データ・同じ予測で、パッケージの決定が Eumenes の `score.ts` の決定と100%一致する（parity）。`bun test` が通る |
| M1 | inspector（正解付けの画面）を作る。正解付けは利用者が行う | §7 の区分の件数を満たし、split を固定する |
| M2 | §8 の方式を比べる。オフラインで精度、合図の後に live と本番機で速度・資源 | §9 の合否で採る方式を決め、結果を記録する |
| M3 | 出荷する: `eumenes_router-0.0.1-<sha256の先頭12>.tgz`（本流の2つの構成を両方含む、§10 M3d）、`.sha256`、`manifest.json` を作る。Eumenes 側（Eumenes のセッション）で `vendor/router/` に置き、移した部品を Eumenes から消してパッケージ呼出しに置き換える | Eumenes で `bun run verify -- --domain capabilities --domain dialogue --domain toolchain-history --domain larm` が通る。shadow で製品の経路と比べる |

版: 0.0.1 から始め、Eumenes に取り込むたびにパッチ番号だけを上げる。bun は tgz の中身をパスでキャッシュするので、取り込むたびに新しい名前にする。

### M0 の実施（2026-11-02）

| 項目 | 状態 |
| --- | --- |
| `git init`（main）、`.gitignore`、Bun の雛形、`src/` と `eumenes_router/sqlite` | 実装済み |
| 決定表・訂正・予測集合・採点（`bench/score.ts`） | 実装済み。Eumenes の `score.ts` と同じ予測（確率の形）202件で `decisionOf` が一致。`correctProbabilities`・`decide`・`predictionSet` も同じ入力で一致 |
| 評価スナップショット | `data/router-eval/2026-11-01-snapshot/` に写した（Git 管理外）。408件はすべて `review.status` が `unreviewed`、`gold.primary` は空、予測に確率が無い。採点の一致の入力ではない |
| カードと、その回の仕事・確認待ち | 未了。Eumenes のセッションで書き出しを足す（§7） |
| レビューで揃えた契約 | 実装済み。衝突した訂正の id、空の offer は行 8、`passages`、索引が空のときの全カード、`fromHistory`、Recall@集合、空白と 128 超は採点前に拒否、カードの件数上限は外した（§4） |
| inspector、方式の比較、出荷 | 未着手（M1 以降） |
| 408件の決定の一致 | 未了。スナップショットに確率が無く、`route()` と Eumenes の `routerTurn` も比べていない |

`bun test` は 45件成功（2026-11-02）。live と本番機の計測は始めていない。

### M3a best-v2 をパッケージに入れる（2026-11-03、利用者の判断）

| 項目 | 状態 |
| --- | --- |
| 判定（融合・特徴・標準化＋LR・回す判定・記憶の kNN） | 実装済み `src/scoring/best-v2.ts`（`loadBestV2`・`scoreBestV2`、純粋）。`best_v2.py` の predict と test 217件＋言い換え 1,215件で一致（並びと回す判定が全件一致、確率の差 ≤ 3.6×10⁻⁸）。1件 0.094 ms。`test/best-v2.test.ts`（一致の確認は `data/best-v2-parity/` があるときだけ） |
| 成果物（利用者の判断: A） | `best_v2.py export-package` が2つに分けて書く。学習済みの数値（係数・標準化・閾値・融合の定数・kNN の件数と次元）は `src/scoring/best-v2.params.ts`（`BEST_V2_PARAMS`）としてパッケージと Git に入れる。発話から作ったものは入らない。記憶（dev の発話のベクトル 177件と正解の id）は `BestV2Memory` としてホストが持ち、`loadBestV2(params, memory)` で渡す。リポジトリが公開なので、記憶はパッケージにも Git にも入れない（`data/` だけ）。記憶の `source` が数値の `source` と違えば拒む（kNN の特徴はその記憶で学習した）。今の版は LARM の ruri（network `ruri-conv20-structure-v1-s0-fp32-v1`）の点数で、ツールの候補 10件（M3c の候補 2）として dev から学習したもの（source `4442fe7939835c60`、2026-11-04。それ以前は `ed4bad51102ea8ae`、旧 network の版は `40b7de92010fa24f`） |
| 公開済みのデータ | 以前のコミットの `bench/router/experiments/correction/variants.jsonl`・`controls.jsonl`・`round2/para.json`（test の発話を書き換えた文など）は、利用者の判断でそのまま残す |
| `route()` への組み込み（2026-11-03、利用者と合意） | 下の表の形で入れる。段階: ① SQLite（記憶の表・全文検索の索引）と sr-corr の移植 → ② `route()` を best-v2 にする（2026-11-04 に実装、§10 M3d）→ ③ 訂正の θ・β を best-v2 の上で dev から決め直す（未着手） |

| 組み込みの決め | 中身 |
| --- | --- |
| 記憶 | SQLite の `router_examples`（正解の付いた例。ベクトル・正解の id・学習の版 `source`・空間）。ホストが `BestV2Memory` を1回取り込む。best-v2 は判定のたびに読む |
| 検索（sr-corr）をパッケージに移す | カードごとに、意味の近さ（発言とカードの文の内積の最大）・典型の近さ（0.7×最大＋0.3×上位3つの平均）・全文検索（3文字の重なりの bm25）・種類の手がかり（参照している物の種類の語をカードが含むか）の平均。意味と典型は候補の中で 0〜1 に伸ばし、全文検索は1位で割る。会話は 0.7 に固定。上位8件を1位の点数で割って softmax（温度 0.1）にし、確率と点数を小数6桁に丸める（学習時の値と同じにするため） |
| 全文検索の索引 | `router_passages_fts`（カードの文1つを1行、trigram）。`syncCardsInTransaction` で保つ。カードの文は bench と同じ `cardPassages`（34件で一致を確認） |
| 種類ごとの枠 | sr-corr は使える全カードに対して計算し（伸ばす計算が候補の集まりで変わるので、学習時と同じ集まりにする）、その順位に種類ごとの上限（専用10・パイプライン4・汎用4）をかけてから上位8件を取る。決定1の「種類ごとの枠」は残る |
| 会話と記憶 | bench と同じく `conversation.respond` と `memory.request` もカードとして同期する（sr-corr と全文検索の統計を学習時と同じにするため） |
| 回す | best-v2 の「自信あり」（1位と2位の差 ≥ 回す閾値。今の版は 0.2933）を、決定表の「自信あり」に使う。自信なしでも1位を予告付きで実行（行3）、変更・取り消せない担当は確認（行4）、会話が1位なら会話。Router の段で LLM の確認はしない。最後は担当・会話の LLM が受け止める（利用者の判断） |
| reranker | ホストの `score` が LARM の文脈判定を API で呼び、候補ごとの点数（`scores`、0〜1）を返す（Eumenes 側の作業）。best-v2 の経路では `scores` を必須にする。2026-11-04 から、採点するのは検索の上位8件のツールに加えて、全カードの順位（`srRanking`）の上位 10件のツール（改善の候補 2） |
| ① の実施（2026-11-03） | 実装済み。`src/retrieval/sr.ts`（`srScores`・`srOffer`・`capByKind`・`trigramQuery`、純粋）、`src/db/retrieval.ts`（`lexicalInTransaction`・`srCardsInTransaction`・`importExamplesInTransaction`・`examplesInTransaction`）、表の版 2（`router_passages_fts`・`router_examples`）。bench の sr-corr と全 1,671 発言（dev・test・言い換え・対照）で、確率と点数が丸めた最後の桁まで一致（`test/sr.test.ts`、`data/` があるときだけ）。種類ごとの上限で上位8件が変わった発言は 0件。記憶は SQLite に入れて読むと元と同じ |
| 測り直しと見直し（2026-11-03） | パッケージだけの経路（同期 → 記憶の取り込み → 全文検索 → sr-corr → 種類の上限 → 上位8件 → LARM の点数 → best-v2）で、test＋言い換え 1,432件の並びが best_v2.py と全件一致し、test top1 86.6%・回す率 23.0%・言い換え 80.2% を再現（`test/best-v2-pipeline.test.ts`）。独立した見直しの指摘を直した: 記憶の表の主キーに空間を入れる／訂正が効かない（食い違い・β 0）ときは候補を足さない（bench も同じ条件に揃え、test の訂正の値を 76.2% / 68.2% に直した）／有限でない入力・重複した候補・壊れた base64 と正解の並びを拒み、NaN の差は回す側にする／全文検索の問い合わせから NUL を除く（bench も同じ関数を使う）／strict の空の索引は空のまま／変わっていないカードの全文検索の行は書き直さない |
| 埋め込み | 記憶は e5 small（`passage: ` を前に付ける、正規化）で作った。本番の発言とカードの文も同じ埋め込みでないと記憶と比べられない。LARM の埋め込みが同じかは M2 で確かめる |

### M3b 構造の判断（2026-11-03開始。実施と採用は下記、パッケージ実装はM3d）

文全体のベクトルは、依頼でない語に引かれる。2026-11-03 の分析: test の1件（音楽に合わせた画像を頼む発話、正解 image.create。本文は `data/` だけに置く）は、e5 で音楽の訂正と 0.958（画像と音楽の組 1,638組の最大）、作る物を「画像」に変えても 0.953。ruri でも画像 0.822・音楽 0.797、best-v2 は音楽を1位にして回していた。文全体の近さでは「何を作るか」と「何に合わせるか」を分けられない。

| 文の型 | 例 | 送り先 |
| --- | --- | --- |
| 依頼1件・参照なし | 画像を作って | 今の経路のまま（文全体）。単純な発話の結果を変えない |
| 依頼1件・参照あり | この音楽にぴったりな画像も作って／この画像をもとに3Dを作って | Router で処理する。依頼の部分の文で検索 → reranker → best-v2。参照は `inputs` として担当に渡す（何を指すかの解決はホスト） |
| 依頼2件以上・多段 | 音楽を作って、それに合う画像も作って | パイプラインの段 |
| 依頼2件以上・並列 | 音楽と画像を作って | パイプラインの段 |
| 依頼なし | この音楽いいね | 今の経路（会話の判定） |

| 決め | 中身 |
| --- | --- |
| 構造の形（案） | `{ requests: [{ text, target, inputs, after }] }`。`text` は依頼の部分、`target` は作る・操作する物、`inputs` は参照・材料、`after` は先に済ませる依頼の番号（前の依頼だけを指す）。`text` と `inputs` は原文の一部。依頼は 8件まで。形が壊れていれば採点の前に拒む（今の応答の検査と同じ） |
| 判断の口（案） | ホストの `analyze`（HTTP）。パッケージはモデルを持たない。どの方式で作るかは §8 の S1〜S3 を測って決める |
| パイプラインの段 | 依頼が2件以上なら、並列でも多段でもパイプラインへ送る。候補を登録済みのパイプラインのカード（`kind: pipeline`）に絞り、近いものを選ぶ（§8 の P1・P2）。近いかどうかの閾値は dev で決める。Router が返すのは「パイプラインの段へ、近いパイプラインの id か、なし、構造」。なしのときの扱い（その場で組む・作る）はパイプラインの側が決める |
| パイプラインとの境目 | パイプラインは別のプロジェクトとしてやり直す予定（利用者）。Router が受け取るのは、カードの同期の契約（§4）と同じ形のパイプラインのカード（依頼全体を表す文、P2 では手順の担当の id の並び `steps`）だけ。今の Eumenes の `pipeline.json` の形には結び付けない |
| 1つの担当の中の多段（2026-11-03、利用者の判断） | ブラウザの中で続けて行う操作（開く・検索する・選ぶ・再生する）は、多段でも browser.operate の依頼1つ。複数の担当を使うものだけをパイプラインへ送る。構造の判断は「担当1つの仕事」を依頼1つとして返す |
| 決定表 | 行 9（今は「2つの担当の点数がどちらも `multi` 以上」で推測）を、構造の判断で依頼が2件以上のときに変え、送り先をパイプラインの段にする |
| 訂正の記憶 | 近さを文全体ではなく依頼の部分で比べる。θ はその空間で dev から決め直す |
| 評価 | 構造の評価セット（§7）。合否は §9。今の catalog に公開済みのパイプラインがないので、パイプラインを選ぶ測定は手で書いたパイプラインのカードで行い、「手で書いたカードでの一致」として精度と分けて報告する |

| 段 | すること |
| --- | --- |
| ① | 構造の評価セットを作る（作った対、実際の発話の下書き）。手で書くパイプラインのカード |
| ② | S0 で今の弱点を数値にする（参照の側に送る誤り、複数の依頼を1つの担当に送る率） |
| ③ | S3 で上限とトークンを測る（`.env` のモデル） |
| ④ | S1（解析器のサーバーは利用者が立てる）・S2（LARM）を、利用者の合図の後に測る |
| ⑤ | 勝った方式で `route()` に入れる（`analyze`、構造の型、パイプラインの段、行 9）。Eumenes とパイプラインのプロジェクトの側は、それぞれのセッションで行う |

実施（2026-11-03、オフライン＋S3 は live の API）:

| 項目 | 状態 |
| --- | --- |
| ① 評価セット | 作った対 186件（参照つきの単一 77、依頼が中身に入った単一 6、参照なし 15、修飾にほかの担当の語 7、同じ担当の複数 6、多段 38、並列 20、依頼なし 17）と、実際の発話 15件（dev・test、構造は下書き）。`bench/router/structure.ts build` が、抜き出しが原文の一部か・担当がカタログにあるか・型に合うか・実際の発話の担当が bench の正解と同じかを検査する。同じ担当への複数の依頼は単一の担当とした（担当の中で済む） |
| 経路 | S0 は記録の best-v2（学習なしの ruri）と同じ経路（`router route`）。test 217件で記録と1位・並びが全件一致。構造のある方式は `decideStructure`（依頼なし → 会話、1件 → その部分、担当が2つ以上 → パイプラインの段）で、部分は同じ経路で振り分ける |
| 部分の振り分け方 | span（切り出したまま）、borrow（物だけの部分は次の部分の述語を借りる: 「曲と画像を作って」の「曲」→「曲を作って」）、mask（参照つきの単一の依頼は、元の文の参照を「これ」に伏せて振り分ける）。borrow と mask は正しい構造（S*）の誤りを全件で見て作った |
| S2 の学習データ | `data/structure/train/`（63文・290対、キットと同じ `{q, doc, label}`）。評価の対と言い回しの型を分け、評価の文と同じか e5 で 0.97 以上近い 8文を外した。利用者が AI MAX 395 で学習する |

| 方式（作った対 186件） | 送り先と担当が合う | 参照の側に送る | 複数 → パイプライン | 単一 → パイプライン | 依頼なし → 会話 | 壊れた構造 | LLM のトークン |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | 44.1% | 28.6%（22/77） | 0% | 0% | 23.5% | — | 0 |
| S0、参照の種類の手がかりあり | 33.9% | 53.2%（41/77） | 0% | 0% | 23.5% | — | 0 |
| S*（正しい構造）・mask | 90.3% | 1.3% | 98.3% | 0.9% | 100% | — | 0 |
| S3（`.env` のモデル、effort low、最初の指示文）・mask | 84.9% | 1.3% | 79.3%（46/58） | 0.9% | 100% | 12 | 161,676（1件 804） |

| 同じ方式で | 値 |
| --- | --- |
| 実際の発話 15件 | S0 73.3%、S*・mask 80.0%、S3・mask 80.0%。S3 はブラウザの中の多段（2件）を部分に分けてパイプラインに送った。利用者の判断（browser.operate の依頼1つ）に合わせて、この2件の正解の構造を依頼1つに直した（S* の単一 → パイプラインは 0/15） |
| test 217件の top1（S0 との差） | S0 84.3% → S3・mask 85.7%。良くなった 10（9件は感想・雑談を会話に戻した）、悪くなった 7、パイプラインへ 3、壊れた構造 10（今の経路のまま）。194,516 トークン（1件 896）、1回 p50 0.96 s・p95 2.86 s |
| S3 の壊れた構造 | 述語を共有する並列の依頼で原文にない文（「曲を作って」）を書いたもの、長い発言 |
| S3 で外れた主な理由 | 部分に参照の語が残る（「その曲に合う画面も作って」→ 音楽）、参照でない語を inputs に入れる、情報を求める質問を依頼なしにする、答え方の指定（「出典を添えて」）を別の依頼にする |

| 合否（§9） | S3 の最初の版 |
| --- | --- |
| 依頼の数と中心の担当 ≥ 90% | 未達（84.9%）。正しい構造なら 90.3% |
| 参照の側 ≤ 5%・単一 → パイプライン ≤ 2% | 達（1.3%・0.9%）。実際の発話では単一 → パイプラインが 2/15 |
| 複数 → パイプライン ≥ 90% | 未達（79.3%） |
| 今の test の top1 を下げない | 達（+1.4 ポイント） |
| 遅延 p95 ≤ 200 ms | 未達（2.86 s）。全発言に LLM を通すので、トークンも 1件 約 900 かかる。S3 は上限の参考で、本番の候補は S1・S2 |

本流の決定（2026-11-04、利用者の判断）:

| 項目 | 中身 |
| --- | --- |
| 本流 | 構造の判断（S3: LLM、`bench/router/experiments/structure/s3.py` の指示文、`.env` のモデル）→ 送り先の規則（`decideStructure`: 依頼なし → 会話、依頼1つ → 参照があれば元の文の参照を「これ」に伏せて振り分ける、なければ文全体、担当が2つ以上 → パイプラインの段。物だけの部分は次の部分の述語を借りる）→ 依頼の部分ごとに best-v2（ツールの候補 10件）。参照の種類の手がかりは文全体を振り分けるときだけ使う。壊れた構造（抜き出しが原文の一部でない）は今の経路のまま |
| 値（本番と同じく手がかりを渡す） | 作った対 186件: 90.3%、参照の側 1.3%、複数 → パイプライン 84.5%、単一 → パイプライン 0.9%、感想・質問 → 会話 100%、壊れた構造 12。実際の発話 15件: 73.3%（ブラウザの中の多段を部分に分ける 3件）。test 217件: 88.5%（今の経路 87.1%、差の 95%CI −1.4〜+4.1。良くなった 7・悪くなった 4・パイプラインへ 3）。記録は `docs/reports/data/2026-11-03/structure/report-mainline*.json` |
| 費用 | 全発言に LLM を1回。test 217件で 194,516 トークン（1件 896）、1回 p50 0.96 s・p95 2.86 s（`claude-haiku-5-5`、effort low） |
| §9 の基準に届かない所 | 複数 → パイプライン 84.5%（≥ 90%）。壊れた構造（述語を共有する並列「曲と画像を作って」で原文にない文を書く）。ブラウザの中の多段を分ける（利用者の判断では browser.operate の依頼1つ）。情報を求める質問を依頼なしにする、答え方の指定を別の依頼にする |
| 次 | ① 指示文の次の版（上の4つを直す。構造の評価セットの新しい文で選び、test は1回）。② LLM を呼ぶ発言を絞る（解析で複合の可能性があるときだけ呼ぶ）。③ `route()` に入れる: 構造の型と検査・`decideStructure`・`routedTexts` をパッケージの純 TS に移し、ホストの口 `analyze`（LLM を呼ぶ）を足す。指示文はホストが持つ（§4: 指示文はホストのもの）。bench の `s3.py` の指示文がその元 |

次: 構造の評価セットを dev・test に分け（対は同じ側）、指示文と部分の振り分け方の手直しは dev で選び、test で1回測る。最初の版の test 217件の誤りは見たので、その旨を記録に書く。

S2 の学習と配備（2026-11-03、利用者が LARM 側で実施）:

| 項目 | 中身 |
| --- | --- |
| 学習 | `ruri-conv20-s0-fp32-v1` と同じ学習セット（seed 0 の 811組）に、渡した 290組を足して 1,101組。元モデルから同じ設定で作り直した（上位6層＋分類ヘッド、2 epoch） |
| 配備 | network `ruri-conv20-structure-v1-s0-fp32-v1`。scenario・公開のモデル名・Provider 名は同じ。network を省くと新版、旧 network を明示すると 400。旧版の snapshot は LARM 側に残っている |
| LARM 側の確認（学習文での一致。精度ではない） | 追加した 63文で正解を1位にした数: 旧 46 → 新 52。会話を正解とする 8文は 0/8 のまま。best-v2 は reranker の会話の点数を使わない（会話は融合の 0.18 で入る）ので、この 8文で効くのは参照の側の担当を下げる負例のほう |
| manifest の誤り | 評価の文との近さの最大 0.9804 は、外した 8文を含めた値だった（集計の誤り）。入れた 63文は最大 0.9683 で、規則（0.97 未満）どおり。対のファイルは同じ |
| 起きること | パッケージの `BEST_V2_PARAMS` は旧 network の点数で dev から学習した数値なので、新 network の点数とは組にならない。新 network の点数で dev から学習し直して書き出す必要がある（Eumenes に組み込む前に） |
| 測り方（準備済み、合図の後に行う） | ① `context.py score-all` で bench の 1,547文と構造の 504文の全カードの点数（採点した network を `<out>.binding.json` に書き、別の network での再開は止める）。② `rescore.py` で bench の入力を新しい点数に差し替え、`best_v2.py eval`・`export` で学習し直し、旧 network の版（86.6 / 23.0 / 80.2）と比べる。③ 構造の評価セットを `router route --rr-all` で測る（S0・S*・S3）。`--rr-all` は旧 network の全カードの点数で、記録の LARM 版と test 217件の並びが全件一致することを確かめた。旧 network は API で選べないので、構造の評価セットでの旧 network との比較はできない（学習なしの ruri と比べる） |

S2 の実測（2026-11-03、live。利用者の合図の後）:

| 項目 | 中身 |
| --- | --- |
| 採点 | 新 network で bench の 1,543文・構造の 502文を全カード（33件）について採点（400字超えの 6文は採点されず、学習なしの ruri のまま）。23分。全カードと候補8件で採点した点数の差は ≤ 1.4×10⁻⁷（5件・35組） |
| 環境 | Python の環境を前と同じ版（torch 2.15.0、transformers 4.57.6、scikit-learn 1.9.1、numpy 2.5.4）で作り直し、旧 network の版の評価（test 86.6 / 23.0）が同じ値になることを確かめた |
| 成果物 | `data/best-v2-artifact-larm2`（新 network の点数で dev から学習し直した best-v2。C 0.03、回す閾値 0.2933）。パッケージの `BEST_V2_PARAMS` をこの版に差し替えた（利用者の判断、source `ed4bad51102ea8ae`）。一致の検査（`data/best-v2-parity/`、1,432件）とパッケージだけの経路の検査（`corr-larm2`、test 85.7 / 20.7・言い換え 81.0）を新しい版に直した |

| best-v2（LLM なし） | 旧 network | 新 network |
| --- | --- | --- |
| test 217件: 1位を採る / 回す率 | 86.6 / 23.0% | 85.7 / 20.7% |
| 回した件に旧 LLM の答えを当てた top1 ／ 重複を除いた 176件 | 91.2 / 89.2 | 90.8 / 88.6 |
| 言い換え 1,215件: 1位 / 回す率 / 崩れた率 | 80.2 / 29.1% / 9.7% | 81.0 / 25.5% / 8.1% |

| 構造の評価（作った対 186件） | 学習なしの ruri | 新 network |
| --- | --- | --- |
| S0: 送り先と担当が合う / 参照の側に送る | 44.1% / 28.6% | 51.1% / 15.6% |
| S0、参照の種類の手がかりあり: 参照の側に送る | 53.2% | 28.6% |
| S*・mask: 合う | 90.3% | 94.6% |
| S3・mask: 合う / 参照の側 / 複数 → パイプライン | 84.9% / 1.3% / 79.3% | 90.3% / 1.3% / 84.5% |
| S3・mask、実際の発話 15件: 合う | 80.0% | 73.3% |
| test 217件: S0 → S3・mask | 84.3 → 85.7% | 85.7 → 87.6%（良くなった 8、悪くなった 4） |

読み方: 作った対での改善は、学習の文も同じ書き手が別の型で書いたものなので、良く出やすい（評価の文との e5 の近さの中央値 0.95）。実際の発話の test 217件では、新 network の best-v2 は旧版と2件差（1位）で、回す率は 5件減った。構造の判断（S3）と組み合わせると test で +1.9 ポイント。複数 → パイプライン（84.5%）と遅延は §9 の基準に届かない。

### M3d 本流の2つの構成と出荷（2026-11-04、利用者の判断、実装済み）

1つの tarball に2つの構成を両方入れる。Eumenes 側は呼ぶ関数で選んで試す（Eumenes 側の設定で決める。Router の中で発言ごとに切り替えない）。最終的に1つに絞るかもしれない。

| 項目 | A: direct | B: structured |
| --- | --- | --- |
| 入口 | `route()` | `routeStructured()`（名前は実装のときに決める） |
| 流れ | 発言 → 検索（sr-corr、上位8件と全カードの順位）→ reranker（ホスト、LARM）→ best-v2 → 訂正 → 決定表 | 発言 → 構造の判断（ホストの口 `analyze`、LLM）→ 構造の検査 → 送り先の規則（依頼なし → 会話、依頼1つ → 参照を伏せた文、担当が2つ以上 → パイプラインの段）→ 依頼の部分ごとに A と同じ流れ → 決定表 |
| ホストの口 | `embed`・`score`（上位8件と全カードの順位の上位 10件のツールの LARM の点数）・`read` | A の口 ＋ `analyze`（指示文を LLM に送り、構造を返す） |
| 結果 | 今の `decision`（担当1つか会話か聞き返し） | A の結果に加えて、パイプラインの段（依頼の部分ごとの担当・先に済ませる依頼・構造）。行 9 を「構造の判断で担当が2つ以上」に変える |
| 参照の種類の手がかり | そのまま使う | 文全体を振り分けるときだけ使う |
| 訂正の記憶 | 文全体の近さ | 振り分ける文（伏せた文・依頼の部分）の近さ |
| 値（2026-11-04） | test 217件 87.1%・回す率 18.0%、作った対 47.3% | test 217件 88.5%、作った対 90.3%（参照の側 1.3%、複数 → パイプライン 84.5%） |
| 費用 | LLM 0 | 1発言 LLM 1回（約 900 トークン、p95 2.9 s） |

| 作り | 決め（案） |
| --- | --- |
| 共通の部品 | 検索・best-v2・訂正・決定表は2つで同じものを使う。B は依頼の部分ごとに A の部品を呼ぶ |
| 構造の判断の指示文 | B のために、測った指示文を版付きの定数としてパッケージに入れ、ホストはそれを LLM に送る（測ったものと出荷するものを同じにするため）。§4 の「指示文はホストが持つ」の例外になるので、利用者の合意が要る |
| パッケージに移すもの | 構造の型と検査、`decideStructure`・`routedTexts`（今は `bench/router/structure.ts`）を純 TS で `src/` に。`analyze` の口と、パイプラインの段の結果の型を契約に足す |
| manifest | 2つの入口と、それぞれの契約の版を書く |
| 検査 | A・B それぞれで、パッケージだけの経路が bench の値（A: test 87.1 / 18.0・言い換え 81.6、B: 作った対 90.3%・test 88.5%）を再現することを確かめる |
| パイプラインの段の受け手 | B がパイプラインの段を返したときの扱いは、やり直すパイプラインのプロジェクトが決める。それまで Eumenes 側は、構造を添えて今の扱い（`task.execute` など）にしてよい |

実施（2026-11-04）:

| 項目 | 状態 |
| --- | --- |
| 入口 | `route()`（A）、`routeStructured()`（B）。構造の部品は `src/structure.ts`（`STRUCTURE_PROMPT` は `s3.py` の指示文と1字も違わないことを検査で確かめる）。`scoreBestV2` に `include`（訂正の正解・動的な候補）、`decide` に `confident` を足した |
| 消したもの | 埋め込みの最大内積の枠（`candidatesInTransaction`・`closestSimilarities`・`rankBy`・`slotted`・`CANDIDATE_SLOTS`）、選ぶ呼出しの短い説明文（`routerPassage`） |
| 検査 | `bun test` 85 件成功。製品の入口から: A は test 217件のうち reranker が採点した文の全件で、記録の best-v2 の1位と回す判定に一致。B は test 217件と構造の評価セットの比べられる全件で、bench の送り先（担当・パイプラインの段・会話）に一致（`test/route-mainline.test.ts`、`data/` があるときだけ） |
| 出荷物 | `bun run release`（`scripts/pack.ts`）。型・lint・検査が通ったときだけ作る。`release/eumenes_router-0.0.1-<sha>.tgz`・`.sha256`・`manifest.json`（入口・契約の版・best-v2 の数値の版・記憶の条件）。中身は `dist/`・`package.json`・`README.md`・`LICENSE` だけ。展開した `dist/` から2つの入口が動くことを確かめた |
| 独立した見直し（1回） | 製品の流れの誤りはなかった。直したもの: 全文検索は埋め込みと同じ先頭 2000字で引く（巨大な貼り付けで重くならない）、構造の答えの空・空白だけの依頼の部分と参照は無効、カードの reranker の文は上限（4096字）で切って候補に残す、tarball の作りはリポの場所を固定し commit と未コミットの変更の有無を manifest に書き、本流の一致の検査が流れなければ止める、検査のコードの埋め込みのキャッシュ名は DB から読む。足した検査: 動的な候補が reranker と best-v2 を通る、説明が空白なら reranker の前に拒む、長いカードの文を切る、空の参照を拒む。直さなかったもの: `DecisionCard.score`（順位・類似度など）はどこからも読まれないが、Eumenes の決定表の形と同じにしておくため残す |
| 行 9（依頼が複数） | A でも今の決定表のまま、2つの専用の担当の reranker の点数がどちらも `multi`（0.5）以上なら行 9（1位を予告「partial」で実行）。test 217件（reranker が採点した 214件）で 6件、そのうち best-v2 が自信ありの 5件は行 2 の代わりに行 9 になった。送り先は変わらず、予告の言い方だけが変わる |
| 未検証 | 動的な候補（仕事・確認待ち・redirect）を best-v2 に追加の候補として渡す扱い（学習にない）。本番の LARM の遅延（1発言 最大 10件のツールの組）。400字を超える文は reranker に先頭 400字を渡す（bench では学習なしの ruri の点数だった） |

Eumenes への組み込み（2026-11-04、利用者の指示「eumenesへの移植していいです。現在eumenesのroutingをしている箇所の実装は削除して構いません。このtarballが使われて、然るべき動きになっているか確認してください」。Eumenes 側の設計は `/Users/y.noguchi/Code/eumenes/spec/router-package-integration-2026-11-04.md`）:

| 項目 | 決め・結果 |
| --- | --- |
| パッケージの変更 | 表は `migrations`（SQL の列。ホストが自分の migration で当てる。`eumenes-memory`・`eumenes-world-model` と同じ）にし、`migrateInTransaction` と `router_schema` をなくした（`dbSchemaVersion` は migration の数で 1）。`RouteTurn.retained`（進行中の仕事の担当。検索で見つからなくても offer に入れ、best-v2 で採点する）を足した |
| 埋め込み | Eumenes の LARM の embedding は `intfloat/multilingual-e5-small`（catalog の `embeddingSpace`）。LARM が保存したカードの文の埋め込みと、bench のローカル e5 small（`passage: `）を同じ文 281件で比べると cos 0.991〜0.998（最小〜最大、中央 0.997）。同じモデルとみて、記憶（ローカル e5 で作った）を LARM の空間に取り込む。発言も `passage` で埋め込む（bench と同じ） |
| reranker | LARM の catalog（読み取りだけで確かめた）に `decision.context` の provider（protocol `larm.system-one.v1`、endpoint `/v1/systemone`、network `ruri-conv20-structure-v1-s0-fp32-v1`、`state` は最新の文だけ、instructions はモデルの入力に入らない）。bench の点数を取ったものと同じ |
| 構造の判断（B） | Eumenes の保存済みのクラウド LLM 資源に background control で1回（`reasoningEffort: "low"`）。失敗・時間切れは構造なしとして全体を振り分ける |
| パイプラインの段（B の行 9） | Eumenes ではパイプラインを作り直すまで、最初の担当に頼み、残りはまだ頼んでいないと伝える |

### 改善の候補（2026-11-03考案時点。実施と採否はM3c）

今の実測と、近い分野の手法（Web で調べた）から。上ほど、効く見込みに対して費用が小さい。どれも dev で選び、test は1回だけ測る。

| # | 候補 | 根拠 | 費用 |
| --- | --- | --- | --- |
| 1 | best-v2 の候補に `memory.request` を必ず入れる（製品の `route()` は会話と記憶を必ず入れるが、best-v2 は会話だけ） | test の正解がツールの 121件のうち 5件は memory.request で、検索の上位にないので候補に入らない（上限 +2.3 ポイント） | オフライン。候補の作りを変えて dev で学習し直す。LARM の全カードの点数は記録済み |
| 2 | ツールの候補を 7 → 12件（または点数の落ち込みで切る、MagicSelector の Dynamic Top-K） | 全カードの sr-corr の順位で、正解が候補に入る率は 7件 87.6% → 10件 90.1% → 12件 91.7% → 16件 93.4%。外れの web.search 4件は 8〜13位 | オフラインで測れる。本番は reranker の組が増える（LARM の推論は候補の数に比例） |
| 3 | 参照の種類の手がかり（`referencedResource`）を、参照を材料に使う担当にだけ効かせる | 手がかりを渡すと参照の側に送る誤りが増える（学習なし 28.6 → 53.2%、新 network 15.6 → 28.6%）。今の sr の手がかりは、その物の語をカードが含むだけで上げる（作る担当も上がる） | カードに「受け取る物・作る物」を足す（Eumenes の書き出し）か、構造の判断で参照が材料のときは手がかりを使わない |
| 4 | S1: 係り受け解析で構造を取る。GiNZA（spaCy、文節と主辞の API、節の認識は実験的）か KWJA（係り受けと述語項構造。ヲ格・ニ格が直接取れるが重い） | S3 の誤りは、述語を共有する並列（「曲と画像を作って」）、参照の語が部分に残る、などの形の上の誤りが多い。正しい構造なら 94.6% | 解析器のサーバー（Mac か LARM、利用者が立てる）と、パッケージの規則（純 TS） |
| 5 | 分けたほうが良いときだけ分ける（反実仮想の確認: 分けない場合と分けた場合の best-v2 の自信を比べる。MagicSelector の counterfactual decomposition の考え方を LLM なしで） | 構造の誤りで今より悪くなる件（test で S3 の悪化 4件）を減らせる見込み | パッケージの規則だけ。dev で測る |
| 6 | ruri の次の学習に、今のモデルが高い点数を付けた誤りの担当を難しい負例として足す（self-distillation の hard negative） | 学習で参照の側の誤りが半分になった。残りの誤りは似た担当どうし | 月1回の学習し直しの枠（§9 の決め）で、dev と作った対から作る |
| 7 | 記憶・訂正の近さを e5 small より強い日本語の埋め込み（ruri-v3 の 30m〜310m）で測る | e5 small は近さの幅が狭く（関係ない文どうしでも 0.87）、訂正の θ で意図の違う組を分けにくい。JMTEB の平均は e5 small 69.5、ruri-v3 74.5〜77.2（提供元の値） | 本番の埋め込みを LARM で替えることになる。先にオフラインで記憶と訂正だけ比べる |
| 8 | パイプラインの選び方は、パイプラインを束としても手順の担当としても引けるようにする（Tool-to-Agent Retrieval の考え方。§8 の P2） | 束の説明だけで引くと、手順の細かい担当が見えなくなる | パイプラインのプロジェクトとの契約（`steps`） |

### M3c 改善の試行（2026-11-03、利用者の判断）

上の候補を1つずつ試す。明確に良くなったものだけを採る（利用者の判断）。

| 手順 | 中身 |
| --- | --- |
| ① 計画 | 変える所・測る物・採用の条件を、測る前にこの表の下に書く |
| ② 設定を選ぶ | 設定の値があるものは dev だけで選ぶ。test は見ない |
| ③ 測る | test 217件と言い換え 1,215件で1回だけ測る。比べる相手は、その時点で採用している構成 |
| ④ 判定 | 採用・不採用と根拠（数値）を下の結果の表と `docs/reports/router_improvements_2026-11-03.md` に書く。採用したものは次の候補の比べる相手になる。不採用のコードは消し、数値だけ残す |

採用の条件（best-v2 の候補 1・2・5。測る前に決めた）:

| 条件 | 中身 |
| --- | --- |
| 明確な改善 | test の「LLM なしで1位」の差（同じ件どうしの対応のあるブートストラップ 2,000回）の 95%CI の下限 > 0。または、1位の差の点推定 ≥ 0 で、LLM に回す率の差の 95%CI の上限 < 0（回す件が減ればトークンが減る） |
| 悪くしない | 言い換えの1位が 1ポイント以上下がらない。test の回す率が 2ポイント以上上がらない |
| 製品に入れられる | 純粋層の制約を守れる。LARM の呼び出しの増え方（採点する組の数）を書く |

構造の判断の候補（3・4）は、§9 の構造の判断の合否と、test 217件の1位で判定する。

比べる相手（2026-11-03 時点で採用）: best-v2、LARM の学習し直した ruri の点数、`BEST_V2_PARAMS` source `ed4bad51102ea8ae`。test 1位 85.7%・回す率 20.7%、言い換え 81.0%。候補 2 を採用した後（2026-11-04）は、ツールの候補 10件の版（source `4442fe7939835c60`、回す閾値 0.2989）。test 1位 87.1%・回す率 18.0%、言い換え 81.6%。

| # | 候補 | 計画 | dev で選んだ設定 | test 1位（差、95%CI） | 回す率（差、95%CI） | 言い換え 1位 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 記憶（`memory.request`）を必ず候補に入れる | 検索の上位8件に無いとき、追加の候補として足す（検索の特徴は「なし」、reranker は LARM の全カードの点数）。dev で学習し直す。LARM の採点の組は 1件あたり最大 +1 | なし（入れるか入れないか） | 86.2%（+0.5、−0.9〜+2.3） | 19.8%（−0.9、−4.6〜+2.8） | 81.6% | **不採用**。直ったのは記憶の5件のうち1件。残りは LARM の ruri の記憶の点数が低く（0.06〜0.08）、候補に入っても1位にならない（`docs/reports/router_improvements_2026-11-03.md` §1） |
| 2 | ツールの候補を 7件から増やす | 検索（sr-corr）の全カードの順位で、上位 7件の外の担当を k 件まで追加の候補として足す（検索の確率は「なし」、順位と点数は全カードの順位から、reranker は LARM の全カードの点数）。k は 10・12・16 から dev の交差検証の1位の正解率で選ぶ（同じなら小さい k）。LARM の採点の組は 1件あたり 7 → k | k = 10（dev の交差検証の1位: 今の構成 85.3%、10 85.3%、12 85.3%、16 83.6%。同じなので小さい k） | 87.1%（+1.4、0.0〜+3.2） | 18.0%（−2.7、−5.1〜−0.9） | 81.6% | **採用**。2つ目の条件（1位が下がらず、回す率の差の CI の上限 < 0）を満たす。良くなった 3・悪くなった 0。dev では差が出なかった。LARM の採点の組は 1件あたり 7 → 10（推論の時間は組の数にほぼ比例、未測定）。パッケージに入れた（`BEST_V2_PARAMS` 形式 v2、source `4442fe7939835c60`） |
| 5 | 分けたほうが良いときだけ分ける（構造の判断に重ねる規則） | 構造の判断（今は S3）の結果を、best-v2 の自信（1位と2位の差）で確かめる。参照つきの単一の依頼: 伏せた文の自信が元の文以上のときだけ伏せた文の担当を採る。依頼なし: 元の文が自信のある担当（会話以外、回さない）なら担当を残す。複数の依頼: 部分がどれも回さない自信のときだけパイプラインへ、そうでなければ元の文で振り分ける。設定の値はない（回す閾値は best-v2 のもの）。比べる相手は k=10 の版での S3・mask。採用の条件: 作った対 186件の「送り先と担当が合う」の差（対応のあるブートストラップ）の 95%CI の下限 > 0 で test 217件の1位が下がらない、または test 217件の1位の差の CI の下限 > 0 で作った対が1ポイント以上下がらない | なし | 作った対 90.3 → 83.9%（−6.5、−10.2〜−2.7）。test 217件 88.5 → 88.5%（0、−2.3〜+2.8） | — | — | **不採用**。作った対で良くなった 1・悪くなった 13。best-v2 の自信は参照の語に引かれた誤りでも高く、感想の文も自信を持って担当に送るので、自信で分ける・分けないを決めると正しい構造の判断を文全体の誤りに戻す（`docs/reports/router_improvements_2026-11-03.md` §5） |
| 4＋3 | S1: 係り受け解析で構造を取る。あわせて候補 3（参照の種類の手がかりは、参照を伏せずに文全体を振り分けるときだけ使う）（2026-11-04、利用者の判断で同時に試す） | GiNZA（`ja_ginza` 5.3.0、spaCy の係り受け）の出力に規則をかけて構造を作る。依頼は依頼の形（〜て・〜てください・〜てほしい・お願い・〜たい・〜れる？ など）で終わる述語と、そのヲ格・モ格の名詞句。参照は「〜に合う」「〜をもとに」「〜の雰囲気で」など依頼の名詞か述語に係る句と、指示語（この・その・さっきの・それ）。並列は「と・も〜も」で並ぶ目的語と、文や「あと」で並ぶ述語。多段は「〜て（から）、それ〜」。依頼の形が見つからない文は、はっきりした感想の形でなければ構造なし（今の経路のまま）。候補 3: 構造の判断で参照を伏せた文や部分には手がかりを渡さず、文全体を振り分けるときだけ渡す。bench は Python の中で GiNZA を読み（サーバーなし）、規則を作る。製品では解析器を HTTP の口にし、規則はパッケージの純 TS に移す。規則は構造の評価セットの dev 半分（対の id のハッシュで分ける、対は同じ側）だけを見て作り、test 半分と test 217件で1回測る。比べる相手は、本番と同じく手がかりを渡す今の経路（S0＋手がかり、採用した版）。参考に S3。採用の条件: §9 の構造の判断の合否（依頼の数と中心の担当 ≥ 90%、参照の側 ≤ 5%、複数 → パイプライン ≥ 90%、単一 → パイプライン ≤ 2%、解析の遅延 p95 ≤ 200 ms）を構造の評価セットの test 半分で満たし、test 217件の1位が下がらない（差の点推定 ≥ 0） | 規則は dev 半分だけで作った | 作った対 test 103件: 今の経路＋手がかり 45.6% → S1 85.4%（参照の側 16.2 → 8.1%、複数 → パイプライン 0 → 89.5%、単一 → パイプライン 3.6%、依頼なし → 会話 70.0%）。test 217件: 189 → 186件（−1.4、−3.7〜+0.9） | — | — | **不採用（条件未達）**。今の経路よりは大きく良いが、参照の側 ≤ 5%・複数 ≥ 90%・単一 ≤ 2%・test の1位を下げない、を満たさない。解析は p95 6.4 ms で速い。test 217件で下げたのは、説明の「〜ていて」を依頼に数えた、答え方の指定（「出典を添えて」）を分けた、言い直し（「…と言ったよね？」）を感想と見た、など。候補 3 は単独では採らない（実際の発話の手がかりのある 13件では、手がかりを外しても結果が変わらない。参考値）。S1 は利用者の判断で `archive/structure-judgment/` に移した（2026-11-04）。作り直すときは、新しい評価用の文（今の test 半分は見た）で測る（`docs/reports/router_improvements_2026-11-03.md` §4） |

## 11 確かめていないこと・決まっていないこと

| こと | 状態 |
| --- | --- |
| LARM の Router の profile（`system-one` の呼出しごとの criteria・`scores`・`extract`） | LARM 側で作業中。LARM 側の計測依頼は `/Users/y.noguchi/Code/eumenes/spec/larm-router-request-prompt-2026-11-01.md`。このプロジェクトでは同じ計測を重ねず、LARM が返した予測の JSONL を採点する |
| d1-2B の日本語の振り分けの精度・CPU の速さ・選択肢の上限 | 分からない（公開値は提供元の自社測定だけ） |
| 今の埋め込みのモデル・次元 | catalog の値を確認していない |
| 400件で L・E・C の学習が足りるか | 分からない。L は特徴の数を絞る |
| Eumenes 側の書き出し（カード・状態） | まだない（§7） |
| 公開済みのパイプライン | 0本（Eumenes の catalog）。パイプラインは別のプロジェクトとしてやり直す予定。カードの契約（文と `steps`）はそのプロジェクトと決める |
| 構造の判断の方式 | LLM（S3）を採用し、A/Bを実装済み（M3d）。指示文の次版と新規評価は§13の残作業 |

## 12 参照

| 文書 | 読むところ |
| --- | --- |
| `/Users/y.noguchi/Code/eumenes/spec/toolchain-router-redesign-2026-11-01.md` | §1 診断、§3 統合 Router（§3.3 決定表、§3.5 選択と許可を分ける、§3.8 到達できない担当を作らない）、§4 モデルの候補、§5 訂正、§7 PoC、§11 決定、§12 実施記録 |
| `/Users/y.noguchi/Code/eumenes/spec/larm-router-request-prompt-2026-11-01.md` | LARM の Router の口と計測の依頼 |
| `/Users/y.noguchi/Code/eumenes/spec/toolchain-search-choice-design-2026-10-30.md` | 検索と枠の設計 |
| `/Users/y.noguchi/Code/eumenes/spec/intent-gate-design-2026-10-29.md` | Ruri の意図判定 |
| `/Users/y.noguchi/Code/eumenes/spec/decision-model-benchmark-design.md` | モデルを呼ばずに再集計できる評価の形 |
| `/Users/y.noguchi/Code/eumenes/docs/toolchain-extension.md` | bundle（カードの元）の理解だけに使う |
| `/Users/y.noguchi/Code/eumenes_world_model/AGENTS.md` | 純粋層と sqlite 層の分け方の規則（同じ形にする） |
| `/Users/y.noguchi/Code/eumenes_memory/package.json`、`/Users/y.noguchi/Code/eumenes/vendor/eumenes-memory/manifest.json` | 配布の形と manifest |

## 13 80点水準への改善計画（2026-11-06、利用者合意・着手）

利用者の依頼: 「80点の水準にしたいので、指摘事項とは別に80点までの改善計画を作ってください」。この節は、個別の欠陥修正とは分けた、能力と実証の計画である。計画を作ったこと、作業を終えたこと、再評価で80点になったことを区別する。新しい設計や合否の変更は、この提案への合意後に実装する。既存の A/B の採用判断と §9 の合否は変更しない。

### 13.1 目的・範囲・完了条件

| 項目 | 内容 |
| --- | --- |
| 現在の基準 | commit `070b00ce5393048a015c40c073cccd41a69d85c0`。技術品質 59.1/100（確認範囲 94.0%）、将来性 56.0/100（83.3%）。どちらも暫定点。2026-11-06 の評価台帳を保存し、書き換えない |
| 目標 | 同じ採点基準 v1.1.0・library 配点・同じ適用範囲で、技術品質と将来性をそれぞれ80点以上にする。80点は振り分けの正解率80%という意味ではない |
| 完了 | 全適用項目の証拠を揃え、新しい commit と実行条件で再評価する。未検証項目を除外して分母を減らさない。採用・出荷には §9 と個別の受入条件も適用し、総合点で未達を隠さない |
| 主な変更範囲 | 既存の `src/` の契約・共通経路、`test/`、`bench/`、`scripts/pack.ts`、検査設定、状態・導入・実測の文書。契約やスキーマの変更は、失敗の証拠と影響範囲を先にこの plan に記録する |
| 維持する設計 | 純粋層、借用する SQLite 接続、HTTP のモデル呼出し、A/B の共通経路、製品と同じ採点、構造判断の版付き指示文、明示的な訂正だけの記憶 |
| 先に再利用するもの | `STRUCTURE_PROMPT`、`routeText`、`decide`、`srScores`、`scoreBestV2`、`nearFeedback`、`checkReachability`、既存のラベル入出力・一致試験・出荷スクリプト。新しい判断器を先に作らない |
| 対象外 | Eumenes・LARM・memory・world model の書換え、パイプライン実行機構の作り直し、一般向け製品化、独創性の点を上げるための新手法。実行時依存や抽象層を増やすこと自体は成果にしない |
| 権限 | この計画は live/本番機の測定やサーバー操作の許可ではない。準備後も、測定は利用者の明示の合図を待つ。Eumenes 側の実装・統合試験は Eumenes のセッションで行う。別チャットへ依頼を送らない |

### 13.2 個別指摘の修正は別枠の前提作業 R0

R0 は前回の F01〜F05（交差検証の分離、複合時の再確認保持、参照置換、状態文書、整形検査）の修正と回帰確認である。本節の改善施策の成果と二重に数えない。修正方法と受入条件は前回の台帳に従う。

R0 完了前でもデータ整理・評価仕様・環境の準備は進められる。新しい精度の確定は F01 の修正後、状態を伴う通し検証は F02/F03 の契約合意と修正後、出荷候補の確定は R0 全体の確認後とする。欠陥を直しただけで、80点に達したとは扱わない。

### 13.3 改善の順序・成果物・受入条件

工数 S/M/L は相対的な目安で、日数の約束ではない。S は既存文書・手順の整理、M は既存の複数モジュールや検証の接続、L は人の正解付け・実環境・継続観測への依存を含む。担当欄は必要な役割であり、担当者や工数を確保済みという意味ではない。

| 段階 | 強化する能力と作業 | 成果物・受入条件 | 依存・担当・目安 |
| --- | --- | --- | --- |
| Q0 評価条件を固定 | 比べる基準の構成、対象の利用場面、担当範囲、実行環境、費用上限、失敗時の扱いを測定前に固定する。80点向けの評価と出荷の合否を分ける | 本節の実施範囲と担当・作業枠、A/B 各入口の評価条件、採用判断表。§9 の数値を転記し、未決事項を明示。B の構造判断 p95 200 ms と品質優先の採用判断の関係は、未達として残したうえで利用者が整理する。測定後に都合のよい基準へ変えない | 最初に実施。利用者＋Router 担当。S。未合意の速度・費用条件を必要とする合格判断は保留 |
| Q1 正解と実験の信頼性 | 既存のラベル入出力を使って人が正解を確認する。会話・原文・言い換えの系列を同じ側へまとめ、学習・設定選択・最終評価を分離する。学習 id、カード、埋め込み空間、モデル/指示文/記憶の版を追跡する | §7 の400件以上と区分を満たす人確認済みデータ。既存 test とその系列を使わない新規 holdout 200件以上を別に用意。件数は着手の下限であり十分性の証明ではない。出所・重複・保留・分割の件数を本文なしで報告。最終 test は開く前に固定し、開いた後は次の調整に使わない | Q0、学習評価は R0/F01。人の判断は利用者、準備は Router 担当。L。本文・ベクトル・id 一覧は `data/` のみ |
| Q2 意味判断と汎化 | 誤りを「構造」「候補不足」「候補内の選択」「訂正」「動的な状態」に分ける。正しい構造を渡す試験で原因を切り分け、まず LLM の指示・渡す文脈・カード情報を見直す。次に既存の検索・記憶・学習判定を dev 内で調整する | 版付きの指示文と採用/却下記録。通常・参照・複合・質問・同一担当内の多段・400字超・動的候補で §9 の合否を判定。訂正は最終 best-v2 の経路で θ/β を dev から選び直し、回復 ≥90%・副作用 ≤1% を評価。担当別の値と母数も出す | Q1 の dev、R0/F02/F03。Router 担当。M/L。モデル呼出し・再学習は既存の許可境界に従う |
| Q3 契約・失敗・状態遷移 | 欠陥の再現例を超えて、複数依頼×確認/取消/redirect/会話、依存順、利用可能性の変化、索引更新、訂正の撤回/忘却を組合せで検証する。埋め込み/採点/構造の不正応答・例外・時間切れを注入する | 部分→SQLite/port 結合→出荷物/ホスト契約の通し試験。古い revision の保存拒否、ホスト transaction の rollback、再実行後の同値性、実行直前の権限/利用可能性の再確認、確認要否の保持を確認。実外部操作は行わず、使い捨て DB と模擬 port で異常を再現する | R0 の契約確定。Router 担当、ホスト側試験は Eumenes 担当。M |
| Q4 再現できる配布・保守 | 公開してよい合成 fixture の検査と、非公開データによる必須の一致/学習検査を分ける。既存 release に整形・必須 Python 検査・生成物の読込みを接続する。依存の版/出所/通知と更新時の検証手順を揃える | クリーンな環境で固定依存からビルドし、tarball だけを入れた別の利用側で A/B と SQLite を通す。主要検査の skip・成果物の改変・記憶 source 不一致で出荷が止まる。意図的な欠陥を混ぜる負の検査で検出力を示す。本文・秘密を公開 CI に置かない。必要な履歴を残した更新・復元・忘却を手順どおり試す | R0、Q3。Router 担当。M。権利/依存台帳の責任者と更新窓口も必要 |
| Q5 同条件の効果・性能比較 | 製品の `route`/`routeStructured` と決定表で、基準構成・A・Bを同じ新規データと実モデルで比較する。生成 LLM を含む全費用、段別と全体の遅延、同居負荷を測る | 正解率だけでなく誤起動・見逃し・担当別最小値・候補再現率・再確認・訂正副作用を報告。§9 の warmup/回数/候補数20・40・64・128と、40件 p95 ≤1.5秒・会話 token/s 低下 ≤5% を検証。B の構造判断は別計測し、200 ms 未達なら未達のまま。費用に基づく採用理由と、負ける条件も示す | Q0/Q1、凍結した Q2/Q4 の候補。利用者の測定開始合図と、LARM・Eumenes 担当。L |
| Q6 新担当・継続利用・引継ぎ | 実際に追加する担当を学習から外して登録し、汎化と既存担当の回帰を測る。Eumenes の複数の実業務で導入・反復利用を観測し、準備と保守の負担も記録する | cold start Recall@1 ≥70%、既存担当の低下2pt以上を拒否する §9 の検証。新しい実担当で同じ手順を再利用した証拠。利用開始後の週次4回以上を観測計画の下限とし、再確認/訂正/やり直し/待ち時間/成功・保守工数を基準と比較。利用者が実益と継続理由を確認。別の保守担当または利用者が文書から導入・更新・回復できる | Q4/Q5 の合格、利用者の本番/試行利用の許可、Eumenes 側での実施。L。週数・件数だけで合格しない。業務の実発生と人の協力に依存 |
| Q7 再評価 | 修正、新規検証、実益、未達と未検証を別々に集計する。現在と目標で同じ項目を比較する | 新しい snapshot、実行記録、全60項目の根拠付き台帳。現在と共通の確認済み項目でも比較し、確認範囲が増えただけの上昇を区別。技術・将来性を別々に再採点し、80未満なら未達の項目と続行条件を示す | 技術は Q1〜Q5、将来性は Q6 の成果を含む。Router 担当＋利用者の結果確認。S/M |

依存順は `Q0 → Q1 → Q2 → Q5 → Q6 → Q7`。Q3 と Q4 の準備は Q1 と独立して進められるが、最終の通し試験と出荷は R0 の契約・候補の凍結後に行う。検証中に対象を変更した場合は影響する結果を無効と記録し、その範囲だけ測り直す。

### 13.4 合否を支える証拠

| 証拠 | 必須の内容 |
| --- | --- |
| 正解と統計 | 利用者がモデルの予測を見ずに正解を確認。曖昧なものは保留し、受理可能な候補を記録する。会話/系列を単位に差の信頼区間を出す。低頻度区分は点推定だけで合格させず、母数不足は保留にする |
| 学習の分離 | 各 fold の学習側だけで memory/特徴を作る。検証側の gold を変えても、検証側の入力特徴が変わらない検査を持つ。reranker 自体の学習由来の影響も id と版で監査し、分離できない dev 値は学習済み領域と明示する |
| テストの検出力 | 通常の成功件数に加え、確認判断の欠落、古いベクトル保存、分割越しの正解参照、応答の欠落/異常値、出荷物の改変を検出して止まることを示す。実装自身から作った期待値だけに依存しない |
| 実際の価値 | 誤った担当への依頼、やり直し、待ち時間と費用を、同条件の基準と比較する。最低2つの実業務で繰り返し確かめる。利用者の確認と本文を含まない計数/時間記録を併用する。単なる利用回数を成功に数えない |
| 保守と継続 | 導入・更新・復元・削除/忘却の手順と所要負担、担当役割、次の評価時期、利用できる作業枠を明示。実際の引継ぎ/更新で使われた記録を残す。作業枠が未確保なら将来性の該当項目は未検証のまま |
| 拡張 | 合成カタログ100・500・1,000・2,000件は速度・メモリ・候補再現率・回帰だけに使う。精度や導入需要の証拠は、新しい実担当と実発話で別に取る。件数上限や適用しない条件も文書化する |

### 13.5 80点に必要な到達水準

以下は達成時の条件付き配点であり、改善効果の予測・実測・現在点の更新ではない。0〜4 の採点基準で、基本要件を2、代表的な例外まで良好なら3、重要な境界と反証まで強く実証した場合だけ4とする。項目を除外せず、現状と同じ重みを使う。

この節の「現在」は計画作成時の基準点を指す。継続改善後の実際の再評価は§13.11と別の根拠台帳に記録し、この条件付き配点の数字は変更しない。

| 技術品質の観点（重み） | 現在 /10 | 到達水準 /10 | 必要な証拠 |
| --- | --- | --- | --- |
| 設計（12%） | 8.3 | 8.3 | 純粋層/SQLite/ホスト境界の4を保ち、Q3/Q4の変更でも局所性を維持 |
| 正しさ（20%） | 4.2 | 8.3 | 契約4、境界条件3、順序/原子性3。正常・不正・状態遷移を製品の全経路で検証 |
| セキュリティ（10%） | 5.8 | 7.5 | 3項目とも3。ホスト境界、入力/秘密、資源上限を異常条件でも確認 |
| 障害対応（8%） | 5.8 | 7.5 | 3項目とも3。依存失敗・再実行・回復の結果を保持 |
| 保守性（12%） | 6.7 | 7.5 | 3項目とも3。正しい入口、変更ごとの確認方法、実際の更新/引継ぎ |
| 共通化（5%） | 7.5 | 7.5 | 3項目とも3を維持。A/B/bench/hostで同じ契約を利用 |
| テスト（15%） | 5.8 | 10.0 | 3項目とも4。重要な異常/相互作用、独立した期待値と負の検査、クリーン環境から実際に止まる出荷検査 |
| 依存・配布（10%） | 5.0・部分 | 7.5 | 3項目とも3。更新管理、別環境のtarball検証、出所/通知/責任の記録 |
| 性能（5%） | 5.0・部分 | 7.5 | 3項目とも3。合意済み予算を代表的な例外・本番同居負荷で満たす |
| 運用（3%） | 6.3・部分 | 7.5 | 3項目とも3。障害診断と導入・更新・回復を実際に確認 |

この配点がすべて証拠で認められた場合の技術品質は **81.4/100**。テストの10.0は目標であって予約された点ではなく、通常のテスト全成功だけでは認めない。R0だけではこの水準に届かない。

| 将来性の観点（重み） | 現在 /10 | 到達水準 /10 | 必要な証拠 |
| --- | --- | --- | --- |
| 課題の価値（15%） | 6.7 | 10.0 | 3項目とも4。独立した実業務/期間で課題が繰り返され、失敗・時間・費用の実害と改善余地を直接確認 |
| 解決策の適合（15%） | 5.8 | 10.0 | 3項目とも4。実制約/異常下でも機能し、導入負担を含めて利用者が反復して実益を確認。基準との改善を帰属できる |
| 差別化（10%） | 5.8 | 7.5 | 3項目とも3。現行基準と単純な検索/再順位付けで十分な条件も比較し、採る理由を実測で示す |
| 新規性（5%） | 3.3 | 3.3 | 現状の1・2・1を据え置く。新しいアルゴリズムの発明は要求しない |
| 導入・定着（15%） | 5.0・部分 | 7.5 | 3項目とも3。導入負担、内部展開、継続利用の実益を別々に確認 |
| 持続性（5%） | 6.3・部分 | 7.5 | 3項目とも3。評価資産の維持、代替が進歩しても残る価値、実際の保守作業枠 |
| 実行力（10%） | 5.8 | 7.5 | 3項目とも3。必要成果物を届け、実利用の誤り→改善→回帰確認の履歴を複数回残す |
| 時機（5%） | 5.0・部分 | 7.5 | 3項目とも3。使う側と環境が揃い、利用開始・更新の作業枠が実際に確保される |
| 保守体制（10%） | 5.8 | 7.5 | 3項目とも3。責任者、引継ぎ、更新への対応、意思決定と作業枠が運用で確認される |
| 拡張性（10%） | 3.8・部分 | 7.5 | 3項目とも3。新しい実担当への適用、負担の測定、段階的な追加と回帰拒否を実施 |

この配点がすべて証拠で認められた場合の将来性は **80.4/100**。Q6の観測を欠く場合、この数字は使わない。課題の価値と解決策が「良好」の3にとどまるなら、ほかを同じだけ満たしても **72.9/100** である。将来性80点には、実装に加えて強い実益の証拠が要る。二つの総合点は合算しない。

### 13.6 計画作成時の実施状況と停止条件

| 作業 | 2026-11-06 計画作成時点（最新は§13.11） |
| --- | --- |
| 既存の採点・未検証・LLMへの指示・共通機構の確認 | この計画作成のために実施 |
| R0、Q1/Q3/Q4のオフライン部分 | 利用者の実施依頼により着手。今回の範囲は§13.7 |
| 人確認・live/本番機・実ホスト・継続利用 | 未実施。利用者の確認、測定開始の合図、ホスト側作業を要する |
| 技術81.4/将来性80.4の計算 | 到達条件の仮定として算出。実測ではない |
| 新たなモデル呼出し・live/本番機計測・Eumenes変更 | 実施していない |
| 再評価 | 未実施。現在の59.1/56.0は変わらない |

同じ目的の試行は「仮説・実施・結果確認」の3ラウンドで俯瞰し、新しい証拠と減った残作業を報告する。正常に進行している長時間処理は止めない。改善が再現しない、データ/許可/作業枠が不足する、必要な基準に達しない場合は、要件や採点を緩めず、未達・原因・次に必要な条件を報告する。新しい検証証拠なしに同じ試行を繰り返さない。

### 13.7 初回の実施範囲（2026-11-06）

利用者が本計画に合意し、R0の修正とオフラインで進められる改善の実施を依頼した。まず既存の指示・型・共通機構を確認した。意味判断はLLM/学習判定に残し、次の契約検証と情報保持を実装する。サーバー、実モデル、本番、隣接リポジトリは操作しない。

| 対象 | 既存機構を使う実装と完了条件 |
| --- | --- |
| R0/F01 | foldの学習側だけから学習/検証の特徴を作る。foldごとの表記照合閾値も学習側から取る。最終fitは全devで行う。合成データのgold非干渉・sklearnとの一致・export再読込で確認。既存の学習値と過去成績は変更せず、再選択前の値と明記する |
| R0/F02 | 各partの決定表の結果を集約の正本にする。again/askは先に返し、それ以外の複数操作のpipeline stepsにも各decisionを保持する（route契約3）。順位1位を実行可否へ読み替えない。ホスト側は新しい契約の取り込みが必要で、このリポからは変更しない |
| R0/F03 | LLMが返したrequest.textとtargetの一致位置を使って作成対象を保護し、参照の位置だけを同時に置換する。位置を一意に特定できないときは元文を残す。新しい意味規則・語彙辞書・モデル出力形式は追加しない。benchのmaskも同じ関数を使う。重複語・包含・重なり・Unicodeの合成試験と記録再生で確認 |
| R0/F04/F05 | README/planの現在状態と過去記録を分ける。コードと検査対象のJSONを既存oxfmt設定で整形する。未追跡の個人用設定だけを検査対象から外し、追跡コードや実験結果を除外して成功させない |
| Q1準備 | 既存のラベル入出力に、予測を見せないレビュー出力と、会話/同文/明示した派生元系列が分割をまたがない監査を加える。監査は件数だけを出し、モデルによる意味判定や自動正解付けはしない。既存の私的データの監査・レビュー素材はdata/に保存。新規holdoutの捏造や人確認済みへの変更はしない |
| Q3 | 模擬portと使い捨てSQLiteで、モデル失敗、不正応答、再確認の集約、古いrevision、rollback、再実行・忘却の回帰を検証する。ホスト本体の権限再確認の通し試験はEumenes側の残作業 |
| Q4 | Pythonの固定依存・専用環境を用意し、必須回帰をskipさせず、既存releaseへ整形検査とtarball単独の利用側試験を接続する。公開してよい合成入力だけで動作する検査と、非公開データを要する一致検査を分ける |
| 検証の順 | 指摘ごとの部分試験 → SQLite/port/benchの結合試験 → 全テスト・型・lint・整形 → 出荷物の展開/別利用側の通し検査。文書のみの更新は差分照合。失敗したら原因と変更条件を記録してから再実行する |
| 残す作業 | 人の正解確認、新しい実発話と担当の収集、LLM指示文の新しい版のlive比較、本番性能/干渉/費用、実ホストの統合と継続利用。今回の検査成功で80点達成とはしない |

### 13.8 オフライン実施記録（2026-11-06）

| 対象 | 実装・検証済み | 残作業・適用限界 |
| --- | --- | --- |
| R0/F01 交差検証 | `fold_features`でfoldの学習側だけを記憶・照合閾値に使用。合成データで検証側goldの非干渉と実際のfitからの呼出しを確認。旧方式を模した負の対照ではgold変更が特徴に混入することも確認 | 配布する`BEST_V2_PARAMS`と記憶は以前の版を維持。新しい手順でのdev再選択と新規評価は未実施。過去の92.2等を固定の成功条件にする試験は、変更後の手順の正しさを確かめる合成試験とartifact往復へ置換し、過去値は報告に保持した。期待精度を緩めて通したものではない |
| R0/F02 集約 | `DirectDecision`と集約を分離し、again/askを優先。pipeline stepsは各partのdecisionとafterを保持。承認・取消・redirect、会話に戻す記憶候補を合成試験で確認。契約版はroute=3 | Eumenesは変更していない。契約3を取り込み、確認待ち・各stepのdecisionをホスト側でも保持する統合試験が必要 |
| R0/F03 参照置換 | 同語の対象保護、包含/重なる参照、挿入文字列を再置換しない処理、曖昧時の元文保持、Unicodeを検証。LLMの意味判断や指示文は変更せず、benchのmaskも同じ関数を利用 | 参照/対象の位置が曖昧な応答では全文の振分けへ戻る。新しい精度を測ったとはしない |
| R0/F04/F05 文書・整形 | README/planの入口を現行実装へ更新し、過去の状態を履歴として区別。既存oxfmtで追跡対象を整形し、format:check成功。追加除外は専用Python環境と未追跡の個人設定のみ | 整形で差分が大きい。変更JSON42件のうち3件は意図した設定変更、保存済み結果39件はJSON値の一致を確認。担当外のTypeScript16件はスタイル情報/冗長な括弧を除いて構文一致を照合 |
| Q1 準備 | `label export`は予測/過去選択/予測由来の優先度を表示しない。`--recheck`で既存ラベルのgoldも見ずに再確認でき、元DBは変更しない。診断出力は`--diagnostic`を明示。`label audit`は会話・同文・明示された派生元を推移的にまとめ、分割越えなら失敗 | 人の確認を代行しない。近い意味の言い換えの自動認定はしない。lineage未入力ならその出所は監査できない。新規holdoutの収集/固定は未実施 |
| Q1 手元データの監査 | `data/structure/s0.db`をreadonlyで監査。1,839発言、ラベル1,671（reviewed 1,649 / hold 22）、未ラベル168。会話の分割越え1、同文19群、推移的にまとめた単位で5群。lineage入力0件。監査結果は不合格のまま`data/offline-improvement-2026-11-06/dataset-audit.json`へ保存 | reviewedという状態は人確認の証明ではなく、出所は未確認。過去の意図的な時系列分割を含み、新しい会話単位の最終評価とは区別する。ラベル/分割の自動変更や再学習は行わない |
| Q1 人確認用の素材 | 同じDBの全1,839件を、既存gold/予測を隠した再確認素材として`data/offline-improvement-2026-11-06/blind-review.jsonl`と`.md`へ保存 | 言い換え等を含む既存データの素材。新規1,839件を集めた意味でも、人確認済みでもない。利用者が確認し、旧test/派生系列と新規holdoutを分ける必要がある |
| Q3 異常/状態の検証 | 模擬portの失敗・再実行と本文を出さないログ、古いrevisionの結果拒否、部分書込み後のホストrollback、pendingの再列挙と再保存、無効な利用可能性を検査 | 実LARM停止、本番ホストの権限/利用可能性再確認、継続利用の試験はしていない |
| Q4 出荷の検証 | `.venv`と固定した`bench/python-requirements.txt`を用意。releaseに整形・必須Python回帰を追加。tarballのハッシュと内容を確かめ、別の利用側に配布物だけを展開してA/B・複合のdecision/after・SQLite・記憶不一致拒否・失敗伝播を検査。ハッシュ不一致を拒否する負の検査も成功 | 一般のbun testはPython環境なしならskipするがreleaseは失敗する。外部の依存脆弱性調査、別保守者による実引継ぎ、実ホスト更新/復元は未実施 |

| 検証段階 | 実行と結果 |
| --- | --- |
| 変更前の部分基準 | `bun test test/structure.test.ts test/route.test.ts`：16成功 |
| 指摘ごとの部分・SQLite結合 | 追加後の3ファイル：24成功。Pythonの数値/sklearn一致、分割隔離、gate、artifact往復も成功（評価データ・モデル呼出しなし） |
| データ入出力・監査の結合 | `bun test bench/router/router.test.ts bench/router/audit.test.ts`：13成功。不整合を入れたauditは想定どおり失敗し、本文/idを出さない |
| 主要経路 | `test/route-mainline.test.ts`：A/Bの2件成功。製品経路とbenchの記録再生の一致であり、人確認済みの精度検証ではない |
| 全体/出荷 | 最終`bun scripts/pack.ts --out release/offline-2026-11-06`成功。型・lint・整形・必須Python・`bun test`98成功/0skip/0fail、主要一致試験の非skip、ビルド、tarball単独の利用側、ハッシュ不一致拒否を確認 |
| 出力 | `release/offline-2026-11-06/eumenes_router-0.0.1-5d8ce21193c6.tgz`、sha256=`5d8ce21193c6106924a62382662eabab7894dd50e5d2c1a1cb64fc01291ce641`、`.sha256`、`manifest.json`。契約route=3、source commitは基準と同じでdirty=true。コミット/配備はしていない |
| 差分の点検 | 意図した修正以外の追跡ファイルは整形だけであることを上記の値/構文比較で確認。新しい製品コードに、語句・モデル名・シナリオごとの分岐は追加していない。追加した分岐は型付きdecisionの保持、文字位置/重なりの検証、foldのデータ分離という契約のため |

途中の型検査でDirectDecisionには到達しないpipeline分岐がbench採点器に残っていることが分かり削除した。その後の型検査と出荷検査は成功。文書更新用の一時処理は文字コードエラーで変更前に止まったため、別の編集手段で反映した。正常に進行した検査を経過時間だけで止めたり、実行中に対象コードを編集したりはしていない。

今回完了したのはR0のコード/文書修正・オフライン回帰とQ1/Q3/Q4の上記範囲である。Q1全体、学習値の再選択、Q2の実モデル比較、Q3/Q4の実ホスト/引継ぎ、Q5/Q6、Q7は未完了。既存の精度や59.1/56.0の暫定評点を更新する証拠はまだない。次は人確認と分割/系列の確定を受けてdev再選択を行い、契約3のホスト取り込みと、許可後の実環境計測へ進む。

### 13.9 Eumenes側で合意した継続先・依頼全体の構造契約（2026-11-06）

Eumenesの全体課題EUM001〜006の修正として、利用者は「案Aを比較し、基準を満たさなければ案Bを実装」「全部やりきって良い」と合意した。設計正本は `/Users/y.noguchi/Code/eumenes/spec/project-issues-first-batch-2026-11-06.md`。案Aは採用版のrouteと実LARMによる20件×2条件で既知6件を解消しなかったため不採用。直前のR0/Q3/Q4完了差分を保持し、重複修正しない。

今回の追加範囲は、既存の一回の構造解析へ保留質問の有限参照と仕事・質問を渡し、answer/requests/conversation/clarifyを返す契約（structure=2、route=4）。構造モデルは担当を選ばない。answerの実在参照と原文部分、requestsの部分・対象・依存、clarifyの質問と未実施部分を検査する。不正/失敗を直接routeへ戻さず、先頭作業を実行しない。複数実作業は同じ担当でもPipelineへ渡し、各partの決定を保持する。again/askの確認保持は維持する。単一成果物の相談・下書きはLLMの構造判断に残す。

Eumenesのsessionからpackageを実装・検証し採用tarballを更新する。保存設定の一括変更、サーバー操作、別チャットへの送信、既存学習値の再選択はしない。固定fixture→package→host→実モデル判定の順で結果を記録する。実モデル判定は利用者が依頼した上記比較・検証の範囲に限り、個人の過去会話を新たに評価送信しない。既存benchの過去記録再生は過去の構造形式として扱い、新しい意味品質の成績へ流用しない。

### 13.10 80点超えまでの継続実施（2026-11-06）

利用者が「初回だけではなく80点超えまで継続改善、検証」と依頼した。§13.9の別作業による構造契約4を保持し、契約の意味を変えずに残るQ3/Q4の異常・復元・配布検証を進める。採点は同じ基準と配点で実測から再評価し、目標値の転記はしない。

Eumenes側の同日続行で、通常の複数操作が構造段で一つになった実測と、保留質問に命令形で回答すると新規依頼になる実測が得られた。§13.9の受入内で、既存の構造指示だけを改訂して比較する。共有された動詞でも操作の対象・引数ごとの別操作を保持し、質問が求めた作業内容の指定は文末の命令形だけで新規依頼としない。取消の述語を参照材料として隠さないことも明示する。4種の出力、有限参照、容量、採点、失敗時停止は変えない。実測後に採用版を固定し、旧20件と追加の再現例で比較する。人確認済み精度とは呼ばない。

続いて、v3でも取消が計算へ誤配した実測を受け、Eumenes側で `spec/router-cancellation-structure-design-2026-11-06.md` を先に作成し、利用者が「案どおり実装してよい」と合意した。既存仕事の有限取消参照を構造入力に渡し、追加の排他的出力 `control:{ref,text}` でLLMが選ぶ。取消だけは採点せず、現在有効なwork/cancel候補へのrow6を返す。曖昧・混在はclarify、不正・失効・時間切れは未実施。hostの会話/revision/状態/所有者のcontrolと取消後の結果拒否を維持する。承認・破棄・変更を追加出力に含めない。route=5 / structure=3、DB schemaは不変。旧直接routeの閾値も変えない。

v4の固定20件では下書きだけを求める例がタイマーへ振り分けられた。既存の「引用内の行動は今の実作業にしない」を、利用者が今求める出力が文章だけの場合にも明確化する。現在の語句ではなく、求めた成果が文章か実操作かをLLMが判断する。新しい出力・閾値・固定語句分岐は追加せず、prompt版を上げて元の20件と取消9件を比較する。

v5の比較でanswer/controlが現在発言の冒頭だけを採用し残りを落とした。Eumenes側の上記設計に根拠と検査を先に追記した。既存の全体保持・混在時未実施を強制する契約の強化として、answer/control.textは現在発言全文との文字列一致を要求する。意味や語句をコードで分類せず、部分採用を拒否する。指示では全体の意図の確認、話題の延期と仕事の取消の区別を明示する。route=6 / structure=4、5種の出力と直接routeは維持する。

輸送の切分けで、同じ保存接続はschemaを一形に固定しても非JSONを返し、hostのcaptureに `structuredOutput:true` がないためschema自体がproviderへ届いていないことを確認した。有効化後は固定形を遵守した。rootのanyOfは実接続で拒否され、`{decision: <既存の5種のいずれか>}` の一つの外枠に入れたschemaは成功した。意味契約は5種のまま、packageが厳密schemaをpromptと一緒に返し、hostが既存の厳密出力機構へそのまま渡す。回答/取消は提示refと全文をenumで制約する。モデル応答はdecision外枠を必須にし、旧wireへのfallbackは設けない。route=7 / structure=5、prompt=v7。canonicalな構造の検査は同じ有限参照・全文・DAG・容量の検査を再利用する。

| 継続する作業 | 既存機構との接続・受入条件 |
| --- | --- |
| Q4 検証対象の固定 | 既存packのcommit/dirty記録へ、検査対象のファイル内容のdigestを足す。検査開始から出力までに変更されたら出荷しない。無関係な個人設定・data・生成物は含めない。模擬ファイルの変更で差異を検出する |
| Q4 配布の境界 | checksumと許可パスに加え、tarのsymbolic/hard link等を展開前に拒否する。使い捨ての不正archiveと正常tarballで拒否/成功を確認。依存の固定版を監査し、変更が必要なら根拠と到達範囲を記録する |
| Q4 最終差分点検での追加 | packの全体検査は一部でもskip/todoなら失敗させる。Gitの除外対象でもビルド・試験対象のソースは内容digestに含める。実Bunの省略/空の検査結果と、使い捨てGitリポジトリの除外対象ソースで負の検査を行う |
| Q4 別環境での再現 | 元リポジトリの除外規則を引き継がない一時ディレクトリへ公開可能なソースだけを複製し、固定lockからJS依存を新規インストールして型/lint/整形/build/全検査を行う。元の評価dataは複製せず参照だけ、Pythonはhash付きlockで同期済みの専用環境を指定する |
| Q3 再起動・回復 | 借用SQLiteの試験で、永続化した記憶/訂正/索引をclose/reopen後にも読み出せること、撤回・忘却・失敗した更新のrollback・再実行の同値を確認。接続作成とtransactionはtest/benchに閉じる |
| Q5 オフライン準備 | 既存routeを使い、合成カタログでCPU/SQLiteの規模と候補数の影響を測る。模擬モデルの遅延を実LARMの性能や精度としない。結果は本文のない計数だけ保存する |
| Q7 再評価 | 現作業ツリーを内容digestで識別し、前回台帳を保持して別台帳で再採点。全項目の根拠・反証・未検証を更新する。人確認・live/本番機・継続利用を未観測のまま加点しない |

部分試験→結合→全体と出荷の順に検証する。検査中に別作業の変更を検出したら、その結果を最新の根拠に使わず対象を確認してから再実行する。実サーバーの開始/停止、別チャットへの送信、隣接リポジトリの変更は行わない。

### 13.11 継続改善・再評価の記録（2026-11-06）

利用者は、人が確認した正解データと継続利用の記録はないと回答した。これらを作成済みと扱わず、独立して進められる実装・状態・配布・CPU計測を継続した。§13.9で別作業が加えた構造契約4を保持し、このセッションから隣接リポジトリやサーバーを変更していない。

| 対象 | 実装・検証済み | 残作業・限界 |
| --- | --- | --- |
| 応答の契約 | null/配列、不足/余分な候補、継承された候補値、非有限数、範囲外の確率を拒否。0〜1の101組の境界を受理。旧版が継承値を受理する負の対照と現行の拒否を確認 | 意味の正解率を新しく測ったものではない |
| SQLiteの回復 | ホストによるclose/reopen、カード/ベクトル/FTS/記憶/訂正の永続性、更新失敗時のrollback、backup復元後の忘却再適用、再実行の同値を確認 | 実ホストの権限/世代再確認、本番DBの更新・復元、物理クラッシュは未検証 |
| 出荷の固定と負の検査 | ソースの内容digestを検査前後で照合。Git除外対象のソース変更も検出。全体検査にskip/todo/空の結果があれば拒否。checksum、不許可ファイル、.env、linkを含むarchiveを展開前に拒否 | trusted checksumの出所・本番配備の認証はホスト責務。別OS・別保守担当の実引継ぎは未検証 |
| 依存 | JSのlockと固定Python5依存を監査し、既知脆弱性の検出なし。Pythonはhash付きlockで同期成功。直接JS開発依存の宣言licenseを記録、runtime依存なし | 既知advisoryの照会結果。未知の脆弱性や全権利の包括的レビューを保証しない |
| 別環境の再現 | 新規ディレクトリで固定JS依存をインストールし型/lint/整形/build/必須Python/全検査に成功。109pass/0skip/0todo/0fail、生成JS/型56ファイルが出荷前distとSHA256一致 | 私的評価データは原本参照だけ、Pythonはhash同期済みの専用環境を指定。一時ソース/依存を削除し記録をdata/に保持 |
| CPU/SQLite計測 | 実routeとSQLiteで100/500/1000/2000カード×候補20/40/64/128の16条件、warmup10＋各100回。384次元、合成memory177件。p95は約1.37〜46.96ms、最大条件RSS約88.7MB | 模擬modelなのでmodelCalls=0、accuracy/liveLatency=null。実LARMの速度・費用・同居負荷ではない |
| 差分点検 | LLMの構造/意味判断と既存portを維持。追加は応答shape/所有プロパティ・配布境界・検査の完全性・内容同一性の強制。語句/発話/モデル名の専用分岐なし | R0で既に点検した保存済みJSON39件の値一致、担当外TS16件の構文一致も保持。大量の整形差分は実装変更として数えない |

| 最終検証/出力 | 結果 |
| --- | --- |
| 全体と配布物 | `bun scripts/pack.ts --out release/continued-2026-11-06` exit0。109pass/0skip/0todo/0fail、必須Python、主要経路一致、型/lint/整形、tarball単独のA/B・SQLiteが成功 |
| パッケージ | `release/continued-2026-11-06/eumenes_router-0.0.2-a0c63e587701.tgz`、sha256=`a0c63e5877014ec68dadb63a6721ec8f647a2ff93bc0eb78b2ab4e8cf047164f` |
| 対象 | commit=`070b00ce5393048a015c40c073cccd41a69d85c0`、dirty=true、検査対象treeDigest=`0c67cd0d7183f61a79222eb0da61bfce5c51ada5b64b3e0e76c222c548a58aa6`。計画と私的data/生成物はdigestの対象外 |
| 再評価 | 元台帳を保持し、同じfull/deep/library・配点・適用項目で全60項目を再点検。技術は暫定81.4（範囲80.1〜81.8、確認率98.3%）、将来性は暫定56.6（範囲50.0〜61.7、確認率88.3%）。confidenceは両方Medium。正式点はnull、除外0%、数値上のcapなし |
| 共通の確認済み項目だけ | 技術は同じ94.0%分で59.1→81.7、将来性は同じ83.3%分で56.0→57.0。確認範囲が増えた効果と改善を分ける。条件付きの目標値81.4/80.4を転記したものではない |
| 根拠台帳 | `/Users/y.noguchi/.codex/visualizations/2026/11/06/01a1afda-eccc-7f62-a370-73bfa162e0d0/project-review/continued-2026-11-06/` の `review.json`、`score-summary.json`、`common-assessed.json`、`report.md` |

途中の失敗も区別して記録する。最初のPython監査は監査ツールの隔離Python3.14作成で停止し、完全固定リストをpipなしで照会する方式へ変更して成功した。別環境の初回はdata/配下のため親の除外規則でlint対象0件となり中止し、独立した一時ディレクトリへ移した。初回コピーの二重探索は削除して109件で再確定した。結果集計用の一時処理の構文誤りは、sourceや結果を書き換える前に修正した。正常な長時間処理を時間だけで止めたり、検証中に対象ソースを編集したりしていない。

| 残作業 | 続行に必要な条件 |
| --- | --- |
| Q0/Q1 | Bの構造200ms予算と品質優先の扱いの整理、人確認済み400件以上・学習id/系列の確定、既存test/派生を含まない新規holdout200件以上の固定。既存監査は不合格のまま、goldを自動作成/人確認済み扱いにしない |
| Q2 | 確定devで修正済みの交差検証を使って係数・θ/βを再選択。配布中の旧係数を変更していない。新しい構造指示文と意味判断を実モデルで比較し、訂正回復90%/副作用1%等の基準を満たす |
| Q3/Q4 | Eumenes側で契約4の統合、実行直前の権限/利用可能性、更新/復元/忘却を検証。別担当が文書から実施できることを確認 |
| Q5 | 開始合図と稼働中のLARM/ホストを得て、同じ新規データで基準/A/Bの精度・遅延・費用・同居負荷を測る。CPUの合成測定を代用しない |
| Q6 | 新しい実担当の追加、最低2つの実業務の反復利用、週次4回以上を下限とする観測と利用者の実益確認。実際の利用発生と保守作業枠が必要 |
| Q7 | 上記証拠が増えた時点で同じ基準で再評価する。技術の未確認は実予算、将来性にはretention/resources/timing/scalability等が残る。現段階を「両方80点超えまで完了」としない |

オフラインの仮説・実施・結果確認を3ラウンドごとに俯瞰し、出荷境界の不足と別環境検証の条件を更新した。新しい根拠のない再試行や点数のための追加実装は行わず、実装で進められる残作業と外部の事実を要する残作業を分けて記録した。コミット・push・配備、別チャットへの送信はしていない。

### 13.12 利用者による今回の区切り（2026-11-06）

利用者が「将来性はどうでもいいかな。一旦commit,push」と指示した。将来性80点を今回の継続条件から外し、検証済みの実装・試験・文書をmainへコミットしてoriginへpushする。§13.11の実測・暫定点・未検証の事実は変更せず、将来性の点だけを理由に追加作業を続けない。私的な評価data、配布物、既存の個人設定はコミット対象に含めない。

Eumenes採用検証の追加: v7の厳密送信で既知6件は期待経路に進んだが、話題延期の回答扱いと同じ質問2件への根拠のない割当てが残った。既存のLLM構造指示に、不足情報の具体的指定と対象一意性の必要条件、原文部分と依存番号の整合確認を加えてv8とする。5種の判断、route7/structure5、厳密送受信、権限とstateの検査を維持する。評価期待値は変更しない。

### 13.13 構造応答の受信と配布手順の修正（2026-11-09）

利用者がR09-F01/F02/F03の実装、オフライン検証、同じ技術品質基準で80点超えまでの再評価を依頼した。比較基準はroute7 / structure5 / 指示v8の77.0点。既存の構造指示・送信schema・LLMの意味判断を使い、コードは受信した型・原文・順序と容量を検査する。Eumenesの変更や実環境での再計測はこの作業の対象外。

| 対象 | 実施する変更 | 完了条件 |
| --- | --- | --- |
| R09-F01 | 既存schemaと同じ必須キーを依頼の各要素で強制し、原文・順序検査を再利用。現行wireは一度だけJSONを読む。過去記録の読込みは既存の入口に残す | 欠落・追加・型違いを検索/採点前に拒否。正常な依存と、回答・取消・確認・会話を維持 |
| R09-F02 | 生応答65,536 UTF-16コード単位、1依頼の参照32件を受信上限にし、同じ参照は一度だけ位置を列挙する。2,000字・8依頼に対して、UnicodeやJSONエスケープの余裕を持つ総量上限と、探索の反復回数を制御する個別上限を併用する。送信形式・指示v8は維持し、受信制約をstructure6として記録する | 8依頼と32参照の上限内、応答長の境界、上限超過時の早期拒否を検証。256参照の再現例を拒否し、上限内の同じ参照では探索回数が増えない |
| R09-F03 | READMEの公開口をroute7 / structure6 / 指示v8に揃え、既存のtarball利用側試験で配布物のREADMEに入っている接続例を実行する | 例のschema転送から正規の応答まで通る。旧外枠と不完全な依頼を拒否する |
| 再評価 | 変更前の再現 → 部分 → 結合 → 型・lint・整形・必須Python・全試験・配布物。実測結果に基づき同じ配点で再採点 | 該当3件を受入根拠とともに閉じ、配布物とソースdigestを特定。遅延目標の既存未達を維持し、実モデルの新しい成績とは区別 |

| 検証済みの結果 | 観測 |
| --- | --- |
| 受信の回帰 | 新しい2試験は修正前に検索へ到達して失敗。修正後は検索・採点0で拒否し、正規の依存を保持。部分33件、保存済み経路の一致とSQLiteを含む結合8件が成功 |
| 容量と置換 | 上限内8依頼×32参照と65,536 UTF-16単位を受理。応答長・参照数の上限超過と256参照の再現を拒否。上限内の同じ参照32件では、2,000字で位置列挙が64,000→2,000件、出力は同じ |
| 配布 | `bun scripts/pack.ts --out release/r09-2026-11-09`成功。型・lint・整形・必須Python・116pass/0skip/0todo/0fail・配布物のみのA/B/SQLiteとREADME例、改変hash拒否。README例は旧外枠とafter欠落も拒否 |
| 対象の照合 | 旧採用物と4合成条件の指示文・送信schemaがバイト一致。配布物59ファイル中、差分はREADMEと構造/版のJS・型7件。残る52件は内容一致 |
| 成果物 | `release/r09-2026-11-09/eumenes_router-0.0.2-0a11065df426.tgz`、sha256=`0a11065df4264acd7aeb226fae036f2ca13ea135eded43da3d4bbdf469e946c0`。commit=`f89b1326d85b9fb370896f3ddd8992e340751128`、dirty=true、treeDigest=`98f30d397371fadb2f6b42a7f3154708fe38ffd8dad9279953bfa557bb63793a` |
| 採点 | 前回と同じ技術品質30項目で80.5点、確認率100%、確信度中。3件をオフライン検証済みとして閉じた。構造判断の遅延予算は同じ指示・schemaを用いた既存記録に基づき未達の1/4を維持。最新候補の実モデル時間・本番同居負荷は未測定 |

再評価の根拠台帳と試験記録は `/Users/y.noguchi/.codex/visualizations/2026/11/06/01a1afda-eccc-7f62-a370-73bfa162e0d0/project-review/r09-fixed-2026-11-09/` に保存した。差分は既存の構造指示、意味分類、担当選択の仕組みを使い、型・容量・文字列と順序の契約を強制する。検証対象の編集は出荷検査開始前に終え、検査前後と最終差分点検でソース内容を照合した。

### 13.14 Aが迷った回だけBへ（2026-11-09）

前回の合成21件の実モデル比較では、Aの `explain.defer === true` で選んだ9件中、Bで正しく引き継げたのが5件、誤選択0件、時間切れ等で判断を得られなかったのが4件だった。利用者はこの比較を受け、Aが迷った回だけBへ回し、Bが決められなければ実行せずに候補なしの案内または聞き返しをするよう依頼した。この経路をホストが採用する入口を追加する。A/B単独は再現・比較用にも使うため、入口と結果は維持する。

| 作業 | 方針と完了条件 |
| --- | --- |
| 条件付きの入口 | `routeWithFallback` が既存のAを1回呼ぶ。`defer === true` のときだけB用のポートと期限を作り、既存のBを1回呼ぶ。通常のAは同じ判定・同じ呼出し回数で、B用の準備や待ちが0回。最初から候補がなければBを待たず案内に進む。 |
| 未決定時 | Bの期限切れ・応答拒否・採点失敗ではAの暫定選択を実行に使わない。構造が依頼を返しても、各部分が `defer`・予告つきの暫定選択・部分選択・会話等で未決定なら全体を保留する。有効な回答・取消とBが明示した会話・聞き返しは既存の結果を使う。候補は既存の順位と `low` から取り、候補のない部分と聞き返す部分を `unresolved.requests` でホストへ渡す。発話の語句による分岐は加えない。 |
| 期限と接続 | B全体の期限はホストがB開始時に `AbortSignal` で渡す。期限後の応答で採点や実行に進まない。ホストによるターンの取消は期限切れと区別し、呼び元へ伝える。ホストは `unresolved` を会話エージェントへの入力にし、候補なしの案内または聞き返しを行う。公開契約route8、構造指示と受信schemaは現行のまま。Eumenes側の採用・会話処理はEumenesのセッションで行う。 |
| 検証 | 変更前の既存試験と配布物を基準に、部分（通常A、Bで解決、時間切れ・異常・候補なし・絞れない場合）→結合（保存済みA/B一致、SQLite）→`bun scripts/pack.ts`（型・lint・整形・必須Python・全試験・tarball単独）を確認する。旧配布物のAと新入口の通常Aを同一のオフライン入力・ポートで比較し、判定・呼出しと時間を記録する。異なる判定や余分なポート呼出しは差分を調べ、時間は実環境の値と分ける。 |

| 確認済み | 結果 |
| --- | --- |
| 部分・結合 | 変更前の関連28件が成功。変更後は部分39件と結合8件が成功。Bでの取消、明示的な会話・質問、構造判断中と採点中の期限、遅着した結果の拒否、ターン取消の伝播、複数作業を一部だけ実行しないことを確認した。 |
| 通常A | 保存済み埋め込み・採点結果のうちAが迷わなかった176件で、旧配布物のAと新配布物の条件付き入口の判定・採点結果が一致。ウォームアップ後、同じ入力を交互に各5,632回実行し、どちらも1回の埋め込みと1回の採点。新入口のB準備・呼出しは0回。中央値は旧0.674ms・新0.675ms、p95は旧1.847ms・新1.872ms。オフライン再生の値であり、通信や本番の待ち時間を含まない。数値と手順は `data/conditional-structure-2026-11-09/`。 |
| 配布 | `bun scripts/pack.ts --out release/conditional-structure-2026-11-09` で129件成功、失敗・省略0。型・lint・整形・必須Python・保存済みデータとの一致・独立した利用側でのtarball検証も成功。route8 / structure6 / 指示v8。`release/conditional-structure-2026-11-09/manifest.json` にSHA256と対象ソースのdigestを記録。 |

残作業はEumenesセッションでの配布物採用と会話エージェントへの接続。READMEにポートと期限の作り方、`unresolved` の扱い、既存の聞き返し経路への接続を記載した。意味判断の指示・採点は再利用し、差分は呼出し条件・期限・実行を許す条件・未決定の受渡しに限定した。
