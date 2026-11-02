# Eumenes の参照コピー（parity 用）

`bench/parity.test.ts` が Eumenes の checkout なしで走るように、比較相手の 2 ファイルを写したもの。

| ファイル | 元 | 変更 |
| --- | --- | --- |
| `score.ts` | `ugnoguchigxp/eumenes` `scripts/router-bench/score.ts` | 先頭に `// @ts-nocheck`、import 先だけ `./shim.ts` / `./routed-route.ts` に置換 |
| `routed-route.ts` | 同 `api/domains/dialogue/service/routed-route.ts` | 先頭に `// @ts-nocheck`、import 先だけ `./shim.ts` に置換 |
| `shim.ts` | 新規 | parity が呼ばない依存の stand-in |

取得元コミット: `98b188d2c61352d2278b1912a78e8cd465d37671`（main, 2026-11-02 取得）。
Eumenes 側が変わったら、同じ手順で写し直して parity を再実行する。
