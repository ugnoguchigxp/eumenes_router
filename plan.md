# eumenes_router 計画（2026-11-02）

状態（2026-11-03）: M0 を実装し、M2（方式の比較）の途中。メインの判断の実装は best-v2（bench の Python。まだパッケージに入っていない）。検証して採らなかった実装は `archive/`（結論と実測は `docs/reports/router_verifications_2026-11-03.md`）。正解付け（M1）と出荷（M3）は未着手。Eumenes 側のカードと状態の書き出しはまだない。408件の決定の一致は未了。この文書が作業の入口。作業規則は同じ場所の `AGENTS.md`。

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

設計書 §11 の決定（このプロジェクトでも守る）:

| # | こと | 決め |
| --- | --- | --- |
| 1 | 検索 | 残す（`find_toolchain` の検索の段は消さない・迂回しない）。担当・パイプライン・汎用の担当は増える前提。種類ごとの枠（専用・パイプライン・汎用）も残す |
| 2 | 判断のモデル | 判断モデル（d1-2B）と CrossEncoder の両方を試す |
| 3 | 追加学習 | してよい |
| 4 | 即時の訂正 | 利用者の明示の訂正だけを「訂正の記憶」に残し、近い発言にだけ上限付きの補正をかける。重みは逐次更新しない。まとめて学習し、固定の評価で通ったときだけ版を切り替える |
| 5 | LLM の選ぶ呼出し | なくす。点数の低い回も LLM に選ばせない（ホストの聞き返しか会話の回） |
| 6 | 全体の形 | 発言 → 検索 → Router 1回 → 決定表 → 会話の回か、今の引き渡し |
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

形（M0 で確定。案からの差分は下の表）:

```ts
// ポート（ホストが渡す。ネットワークの呼出しは transaction の外で）
type Embed = (texts: readonly string[]) => Promise<{ space: VectorSpace; vectors: number[][] }>;
type Score = (input: RouteInput) => Promise<RouteAnswer>;

// eumenes_router/sqlite（ホストの transaction の中で）
migrateInTransaction(db): void
syncCardsInTransaction(db, cards, space): { pending: Passage[] } // その space で、文の digest が変わった分だけ
saveVectorsInTransaction(db, space, rows): void                  // rows は { id, revision, item, text, vector }
candidatesInTransaction(db, { vector, available, slots, fromHistory?, strict?, include? }): Candidate[]
// include は、近い訂正の正解。枠の外でも、枠の後ろに足す（枠を使わない）。有効で available なカードだけ
// slots は "router" | "choice"。ftsRank は null。fromHistory は順位も枠も変えない印。
// その space にベクトルが一件も無いとき、strict でなければ read 以外の有効なカードを id 順に返す（similarity は null）
nearFeedback(db, { vector, space, threshold, limit? }): NearFeedback[] // 既定 limit 5、新しい 500 件を走査
recordFeedbackInTransaction(db, feedback): void                  // id と at はホストが渡す
setFeedbackStateInTransaction(db, id, state, at): boolean
forgetInTransaction(db, messageIds): number

// eumenes_router（Eumenes と bench が同じ関数を使い、流れのずれを作らない）
const result = await route(
  { embed, score, read: { candidates, nearFeedback }, settings, log },
  { state: { text, previousAgent, previousUser }, dynamic, passages?: { conversation, memory }, fromHistory?, available, instructions, asked, signals: { intentChat: 0.12 } },
);
// passages を渡したとき、dynamic に無い conversation.respond と memory.request を、その文で足す。文はホストが書く
// result: { candidates（検索の枠）, answer, corrected, decision, explain }
// answer は、候補が無ければ null。そのときの決定は行 8（会話）で、採点は呼ばない
// explain.conflicts は、補正が衝突した訂正の id。パッケージは状態を書かない。ホストが setFeedbackStateInTransaction で conflict にする
// 説明が空白、または候補が 128 を超えるときは、採点の前に larm_invalid_route_request
checkReachability({ cards, eval, before? }): ReachabilityReport
// eval の1件は { cardId, offered, top1, set? }。ホストが検索まで済ませた結果。この関数は埋め込みもモデルも呼ばない
// set をそのカードの全件に渡したとき recallAtSet（予測集合に正解が入る割合）。一件でも省くと null
```

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
| 版 | `contractVersions`（cards・route・feedback）と `dbSchemaVersion` を manifest に出す（`eumenes-memory` と同じ） |
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
| M3 | 出荷する: `eumenes_router-0.0.1-<sha256の先頭12>.tgz`、`.sha256`、`manifest.json` を作る。Eumenes 側（Eumenes のセッション）で `vendor/router/` に置き、移した部品を Eumenes から消してパッケージ呼出しに置き換える | Eumenes で `bun run verify -- --domain capabilities --domain dialogue --domain toolchain-history --domain larm` が通る。shadow で製品の経路と比べる |

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
| 成果物（利用者の判断: A） | `best_v2.py export-package` が2つに分けて書く。学習済みの数値（係数・標準化・閾値・融合の定数・kNN の件数と次元）は `src/scoring/best-v2.params.ts`（`BEST_V2_PARAMS`）としてパッケージと Git に入れる。発話から作ったものは入らない。記憶（dev の発話のベクトル 177件と正解の id）は `BestV2Memory` としてホストが持ち、`loadBestV2(params, memory)` で渡す。リポジトリが公開なので、記憶はパッケージにも Git にも入れない（`data/` だけ）。記憶の `source` が数値の `source` と違えば拒む（kNN の特徴はその記憶で学習した）。今の版は LARM の ruri の点数で dev から学習したもの（source `40b7de92010fa24f`） |
| 公開済みのデータ | 以前のコミットの `bench/router/experiments/correction/variants.jsonl`・`controls.jsonl`・`round2/para.json`（test の発話を書き換えた文など）は、利用者の判断でそのまま残す |
| `route()` への組み込み（2026-11-03、利用者と合意） | 下の表の形で入れる。段階: ① SQLite（記憶の表・全文検索の索引）と sr-corr の移植 → ② `route()` を best-v2 にする → ③ 訂正の θ・β を best-v2 の上で dev から決め直す |

| 組み込みの決め | 中身 |
| --- | --- |
| 記憶 | SQLite の `router_examples`（正解の付いた例。ベクトル・正解の id・学習の版 `source`・空間）。ホストが `BestV2Memory` を1回取り込む。best-v2 は判定のたびに読む |
| 検索（sr-corr）をパッケージに移す | カードごとに、意味の近さ（発言とカードの文の内積の最大）・典型の近さ（0.7×最大＋0.3×上位3つの平均）・全文検索（3文字の重なりの bm25）・種類の手がかり（参照している物の種類の語をカードが含むか）の平均。意味と典型は候補の中で 0〜1 に伸ばし、全文検索は1位で割る。会話は 0.7 に固定。上位8件を1位の点数で割って softmax（温度 0.1）にし、確率と点数を小数6桁に丸める（学習時の値と同じにするため） |
| 全文検索の索引 | `router_passages_fts`（カードの文1つを1行、trigram）。`syncCardsInTransaction` で保つ。カードの文は bench と同じ `cardPassages`（34件で一致を確認） |
| 種類ごとの枠 | sr-corr は使える全カードに対して計算し（伸ばす計算が候補の集まりで変わるので、学習時と同じ集まりにする）、その順位に種類ごとの上限（専用10・パイプライン4・汎用4）をかけてから上位8件を取る。決定1の「種類ごとの枠」は残る |
| 会話と記憶 | bench と同じく `conversation.respond` と `memory.request` もカードとして同期する（sr-corr と全文検索の統計を学習時と同じにするため） |
| 回す | best-v2 の「自信あり」（1位と2位の差 ≥ 0.3222）を、決定表の「自信あり」に使う。自信なしでも1位を予告付きで実行（行3）、変更・取り消せない担当は確認（行4）、会話が1位なら会話。Router の段で LLM の確認はしない。最後は担当・会話の LLM が受け止める（利用者の判断） |
| reranker | ホストの `score` が LARM の文脈判定を API で呼び、候補ごとの点数（`scores`、0〜1）を返す（Eumenes 側の作業）。best-v2 の経路では `scores` を必須にする |
| ① の実施（2026-11-03） | 実装済み。`src/retrieval/sr.ts`（`srScores`・`srOffer`・`capByKind`・`trigramQuery`、純粋）、`src/db/retrieval.ts`（`lexicalInTransaction`・`srCardsInTransaction`・`importExamplesInTransaction`・`examplesInTransaction`）、表の版 2（`router_passages_fts`・`router_examples`）。bench の sr-corr と全 1,671 発言（dev・test・言い換え・対照）で、確率と点数が丸めた最後の桁まで一致（`test/sr.test.ts`、`data/` があるときだけ）。種類ごとの上限で上位8件が変わった発言は 0件。記憶は SQLite に入れて読むと元と同じ |
| 測り直しと見直し（2026-11-03） | パッケージだけの経路（同期 → 記憶の取り込み → 全文検索 → sr-corr → 種類の上限 → 上位8件 → LARM の点数 → best-v2）で、test＋言い換え 1,432件の並びが best_v2.py と全件一致し、test top1 86.6%・回す率 23.0%・言い換え 80.2% を再現（`test/best-v2-pipeline.test.ts`）。独立した見直しの指摘を直した: 記憶の表の主キーに空間を入れる／訂正が効かない（食い違い・β 0）ときは候補を足さない（bench も同じ条件に揃え、test の訂正の値を 76.2% / 68.2% に直した）／有限でない入力・重複した候補・壊れた base64 と正解の並びを拒み、NaN の差は回す側にする／全文検索の問い合わせから NUL を除く（bench も同じ関数を使う）／strict の空の索引は空のまま／変わっていないカードの全文検索の行は書き直さない |
| 埋め込み | 記憶は e5 small（`passage: ` を前に付ける、正規化）で作った。本番の発言とカードの文も同じ埋め込みでないと記憶と比べられない。LARM の埋め込みが同じかは M2 で確かめる |

## 11 確かめていないこと・決まっていないこと

| こと | 状態 |
| --- | --- |
| LARM の Router の profile（`system-one` の呼出しごとの criteria・`scores`・`extract`） | LARM 側で作業中。LARM 側の計測依頼は `/Users/y.noguchi/Code/eumenes/spec/larm-router-request-prompt-2026-11-01.md`。このプロジェクトでは同じ計測を重ねず、LARM が返した予測の JSONL を採点する |
| d1-2B の日本語の振り分けの精度・CPU の速さ・選択肢の上限 | 分からない（公開値は提供元の自社測定だけ） |
| 今の埋め込みのモデル・次元 | catalog の値を確認していない |
| 400件で L・E・C の学習が足りるか | 分からない。L は特徴の数を絞る |
| Eumenes 側の書き出し（カード・状態） | まだない（§7） |

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
