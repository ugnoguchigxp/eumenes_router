# 補正 → 表記揺れ 実験

`run.sh`（または `bun run router correct ...`）で再現します。

- `variants.jsonl` — `{source: <テスト発話IDの先頭8文字>, type, text[, gold]}`。gold を省くと元発話の正解を継ぐ。
- `controls.jsonl` — `{id, text, gold}`。補正と無関係な発話（誤爆の測定用）。
- `--corrections <jsonl>` — `{text, right, wrong?}`。自分の補正を登録する。省くと「各構成がテストで外した発話」をすべて補正する。
- 補正は `recordFeedbackInTransaction` → `nearFeedback`(θ) → `correctProbabilities`(β) の本番経路を通る。
- `--theta 0.9,0.95` で θ を振れる（事後の感度分析）。
- 出力: `<out>/report.json`（構成ごとの前後、種類別、変種ごと・対照ごとの判定）。
