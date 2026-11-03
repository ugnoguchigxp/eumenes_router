# LARM の文脈判定を、本流とは別に検証する

LARM の通常 profile にある文脈判定の provider（`decision.context`）を、bench の正解付きデータで測る。本流の router（best-v2）とは混ぜない。パッケージ（`src/`・`dist/`）には入らない。標準ライブラリだけで動く。

## 設定

| どこ | 何 |
| --- | --- |
| 環境変数（なければリポジトリ直下の `.env`） | `LARM_API_TOKEN`（control の Bearer）。Eumenes の設定からは写さない |
| `examples/larm-context/config.json` | `config.example.json` を写して使う（Git 管理外）。`url`（control の origin）と `audience` は必ず入れる（`same-host` は LARM と同じ機械のときだけ） |

`candidates` は、各発話に渡す候補の数（本流の検索 sr の上位 k 件。`"all"` なら全カード）。説明文は本流が reranker に渡すものと同じ（カードの説明＋例5件）。会話（`conversation.respond`）は候補に入れない。provider は会話のクラスを返さないので、会話へ戻す条件は dev で決める。

## 手順

```bash
P=examples/larm-context/context.py; C=examples/larm-context/config.json
python3 $P selftest                                   # モックだけ。LARM は呼ばない
python3 $P probe --config $C [--text "明日の天気は？"]   # profile → 接続 → claim → api の内容（と1回の判定）→ 解放
python3 $P run   --config $C --corr data/variants-v2/corr --variants data/variants-v2/variants.final.jsonl --out data/larm-context/judged.jsonl
python3 $P fit   --judged data/larm-context/judged.jsonl --out data/larm-context/rule.json   # dev だけで会話へ戻す条件を決める
python3 $P eval  --judged data/larm-context/judged.jsonl --rule data/larm-context/rule.json  # test と言い換えで1回だけ測る
```

- 接続は `run` の間だけ1本作り、終わりに解放する。判定は1件ずつ順に呼ぶ。
- 503 は上限付きで待って再試行する。401 は claim をやり直し、だめなら同じ profile で接続し直す。400（入力・登録値の誤り）は再試行せず `rejected` として記録する。通信の失敗は止めて報告する。会話の判定にはしない。
- 400字を超える発話や、候補の上限を超えるものは切り詰めず、`not_sent` として記録する。
- 記録（`judged.jsonl`）は発話の本文と資格情報を含まない。id、候補、scores、probabilities、choice、confidence、routing、HTTP 全体の時間（`http_ms`）、試行回数を残す。推論の時間は `routing.inference_ms`。
- `rule.json` は、fit したときの scenario・network・precision・候補の数に結び付く。違う記録に対して `eval` は動かない。
- `run` は途中で止めても、同じコマンドで続きから再開できる。
- macOS では、ローカルネットワークの許可がない Python（Homebrew の版など）だと、LAN の LARM へ `No route to host` で届かない。そのときは `/usr/bin/python3`（3.9 以上で動く）で実行する。
