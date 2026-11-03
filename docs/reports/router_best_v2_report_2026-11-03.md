# router best-v2 最終評価レポート（2026-11-03）

**結論:** best-v2（E2特徴＋StandardScaler-LR＋gate）を推奨構成とする。dev のみで調整し、test 217 件で一度だけ評価した結果は top1 **92.2%** / defer 25.8%。baseline 比 **+10.6pt**（95%CI +6.0〜+15.7）、past-LLM 比 **+18.4pt**（+12.0〜+24.4）。表（読み/variant テーブル）特徴は test top1 を 1.4pt 下げるので既定では無効。ただし variant 入力には効く（9.3→62.1%）。

## 1. 手順（test を見ない調整）
- C は dev の grouped 5-fold LL で決定（グリッド 0.01〜3）→ C=0.03。defer 閾値は dev-CV の gate スコアの 20 パーセンタイル（th=0.2862）。
- test 217 件の評価は 1 回だけ実行（`best_v2.py eval`）。FT の 2 行（k10, conv20）は、最初の実行で rerank ファイル名のタグを取り違えて未計算になったため、正しいタグで `--skip-robust` を付けて同じ評価を再実行した。処理は決定的で、best-v2 は同値 92.2 を再現。FT 行を見て構成を選び直してはいない。

## 2. 主表（test n=217）
| 構成 | top1 | defer | front | none-acc | dedup-176 top1 | vs baseline (95%CI) |
|---|---|---|---|---|---|---|
| baseline (cascade) | 81.6 | 29.5 | 70.0 | 95.8 | 78.4 | — |
| past-LLM (全件LLM) | 73.7 | 100 | — | 96.9 | 71.0 | −7.8 (−14.3〜−1.4) |
| **best-v2** | **92.2** | 25.8 | 84.3 | 94.8 | **90.3** | **+10.6 (+6.0〜+15.7)** |
| best-v2+tbl | 90.8 | 26.3 | 85.7 | 95.8 | 88.6 | +9.2 (+4.6〜+13.8) |
| best-v2 −kNN | 81.1 | 28.6 | 68.7 | 80.2 | 78.4 | −0.5 (−6.0〜+4.6) |

- dedup-176（dev に同じ文が無い test）の vs baseline は +11.9（+6.2〜+17.6）。
- cand_recall は 93.1%（候補に正解が入っている割合 = 上限）。defer 20% 時の top1 は 90.8、29.5% 時は 91.2。
- C 感度（test 参考値）: 0.01→90.8, 0.03〜3→91.7〜92.2。inner seed を変えても 92.2/92.2。
- kNN メモリが最大の寄与（外すと −11.1pt）。

## 3. 頑健性（dev+test 合算、group 5-fold ×3 と時系列分割）
| 構成 | 5fold×3 平均±sd | min–max | 時系列 0.5 / 0.6 / 0.7 |
|---|---|---|---|
| baseline | 80.4 ± 5.9 | 70.2–91.7 | 77.1 / 78.4 / 80.5 |
| best-v2 | 86.4 ± 5.5 | 77.5–100 | 87.5 / 87.9 / 87.4 |
| best-v2+tbl | 88.1 ± 4.5 | 79.3–96.9 | 85.4 / 87.1 / 85.1 |

fold 平均では +tbl が僅差で上、時系列と test では best-v2 が上。差は sd の範囲内。

## 4. 補正・variant・コントロール（phaseB）
| 構成 | variant 前→後 | かな | controls 正解率 前→後 | controls の front 変化 | test(補正後) |
|---|---|---|---|---|---|
| best-v2 | 9.3→9.3 (n=43) | 0/5 | 82.5→82.5 | 2 | 92.6 |
| best-v2+tbl | 20.7→62.1 (n=58) | 3/7 | 82.5→80.0 | 1 | 97.7 |

表記ゆれ・かな入力が多い運用では +tbl に切り替える（`--cfg best-v2+tbl`）。この場合 controls の正解率が −2.5pt になるので監視する。

## 5. FT ruri 差し替え（`--rerank tag=dir`、held-dev = dev − 各モデルの train_ids の 72 件）
| tag | test top1 | defer | none-acc | held-dev: zs 73.7 との差 (95%CI) |
|---|---|---|---|---|
| zero-shot ruri（best-v2） | **92.2** | 25.8 | 94.8 | — |
| k10-convpos-s0 | 80.2 | 23.5 | 97.9 | +6.5 (+2.8〜+10.1) |
| k10-real-s0 | 81.6 | 19.4 | 99.0 | +7.8 (+4.1〜+11.5) |
| conv20-s0 | 84.3 | 25.8 | 97.9 | +10.6 (+6.0〜+15.2) |

FT 単体では held-dev 上で zs に勝つ。しかし best-v2 に組み込むと test で −8〜−12pt になる。FT が kNN と同じ dev 情報を学習して特徴が重複すること、ranker の学習に使う dev 部分で FT のスコアが過信になることが原因と推定。**FT は不採用。** AI MAX で大きなモデルを学習したときは、同じ `--rerank` 手順で再判定する。

## 6. レイテンシ（CPU、アイドル時、route バッチ 40 件、HF_HUB_CACHE=/tmp/lathub）
| 段 | p50 ms | p95 ms |
|---|---|---|
| e5 埋め込み（バッチ償却） | 0.1 | 0.1 |
| sr スコア | 0.6 | 2.2 |
| kNN | 0.3 | 0.3 |
| table | 0（無効）/ 2.9（+tbl） | — |
| ruri rerank | **495** | 740 |
| 特徴+LR+gate | 0.2 | 0.3 |
| 合計 | **497** | 742 |

- 起動コストは 1 プロセスあたり約 30 秒（40 件、モデルのロード込み）。ruri の初回呼び出しは 3.8 秒。
- defer になった 25.8% はローカル LLM 検証の対象で、そのレイテンシは**未測定**（AI MAX で測る）。
- route と bench の出力は 40/40 で一致（tool と defer）。

## 7. 未測定・リスク
- 未測定: deferred 56 件に対するローカル LLM 検証の精度、トークン数、レイテンシ。GPU でのレイテンシ。FT の大きなモデル。
- ラベルは同一モデル系の出力に由来するので、絶対精度には上振れの恐れがある。
- dev は 177 件と小さく、C と閾値の推定は不安定（C 感度 ±1.4pt）。
- test のうち 57 文は dev に同文がある。dedup-176 の数値（90.3）を保守的な推定として扱う。

## 8. 再現
```
PY=/tmp/cvenv/bin/python
$PY bench/router/experiments/best/best_v2.py eval --corr CORR --out OUT [--rerank TAG=FTDIR]
$PY bench/router/experiments/best/best_v2.py export --corr CORR --out ARTIFACT
bun run router run --algo best-v2 --db data/bench-r2.db --artifact ARTIFACT --in items.jsonl --python $PY
$PY bench/router/experiments/best/best_v2.py leak-check --corr CORR --ft FTDIR
```
結果 JSON: `bench/router/experiments/best/report-v2-final.json`, `report-v2-final-ft.json`。
