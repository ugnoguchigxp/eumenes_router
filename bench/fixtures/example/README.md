# 例のデータ（合成）

**これは CLI と採点の配線を確かめるための合成データで、実際の発言ではない。** ここで出る Top-1 などの値は精度ではない（AGENTS.md: 合成カタログでの精度は精度として報告しない）。

- `cards.json`: 担当カード 10 枚（`conversation.respond` を含む）
- `utterances.jsonl`: 8 会話・26 発言。文脈ヒント（`referencedResource`・`activeToolchainId`）付きの「これを見て」「続きをやって」を含む
- `labels.jsonl`: 正解。保留（`hold`）2 件、該当なし（`none`）4 件、訂正（`wrong`）2 件。2 件はわざと未ラベルにして、正解付けシートの出力を確かめる
- `choices.jsonl`: 過去の選択（訂正の元になった誤選択）

実データ（Mac の `data/`）は同じ形で `router import` に渡す。
