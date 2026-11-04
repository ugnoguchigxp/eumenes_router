# ruri-v3-reranker-310m 少数例ファインチューニング・キット v2（AI MAX 395+ 用）

v2 では convpos arm を追加しました。会話（ツールなし）を明示的な正例クラスとして学習させるものです。
convpos のモデルは会話カードも採点し、融合では会話の値を conv + 2·rr(会話) として扱います。

Box 上の実験と同じ設定で `cl-nagoya/ruri-v3-reranker-310m` を追加学習し、テスト入力に対するスコア（`scores.json`）を出すキットです。

- **学習データ:** dev split だけから作っています。テスト217件の発話も正解も、学習データには一切入っていません。
- **テストの正解ラベル:** キットには含めていません。評価（Top-1、先送り率、CI など）は、返送いただいた `scores.json` を使って Box 側で計算します。
- **モデルの重み:** キットに含めていません。初回の実行時に Hugging Face から自動でダウンロードされます。

## 中身

| パス | 内容 |
|---|---|
| `pairs/k{3,5,10}-real-s{0,1,2}.jsonl` | 学習ペア `{"q","doc","label"}` です。ツール（正解ラベル）ごとに最大 k 件の dev 発話を使います。正例は（発話, 正解カード）、負例は sr 上位8件のうち正解でない候補（hard negatives）です。conversation.respond の発話は負例だけになります。 |
| `pairs/k{3,5,10}-convpos-s{0,1,2}.jsonl` | **v2 で追加。** conversation.respond を明示的な正例クラスとして学習するペアです。会話の発話には（発話, 会話カード）を正例、sr 候補のツールカードを負例として付けます。ツールの発話には、会話カードを負例として足しています。そのほかは real と同じです。 |
| `pairs/k10-cardx-s{0,1,2}.jsonl` | 合成データの比較用です。k10 にカード作者の例文（`passages[6:]`）を正例として足し、ランダムな3ツールを負例にしています。 |
| `pairs/manifest.json` | 各ファイルのペア数、ツールごとの件数、使った dev 発話の ID |
| `data/rows.jsonl` | 評価の入力です（dev 177件 + test 217件の発話と、sr の候補カード ID）。**ラベルは含みません。** |
| `data/docs.json` | カードの文書（Box と同じ形式: 1つ目の passage と「例:」に続く5件） |
| `train.py` / `score.py` / `run_all.sh` | 学習 / スコア付け / 一括実行（再開できます） |

## 1. 環境構築（Linux・Strix Halo gfx1151）

```bash
python3.12 -m venv ~/ruri-ft && source ~/ruri-ft/bin/activate
pip install -U pip
# ROCm 版 PyTorch（gfx1151 は AMD の TheRock ビルドを使ってください。PyTorch.org の rocm7.1 ホイールは gfx1151 でクラッシュが報告されています）
pip install --index-url https://rocm.nightlies.amd.com/v2/gfx1151/ "rocm[libraries,devel]" torch
pip install -r requirements.txt
python -c "import torch; x=torch.ones(1,device='cuda'); print(torch.__version__, x)"   # GPU が使えるかの確認
```

- GPU が使えない場合は、CPU 版で動かせます。PyTorch を `pip install torch --index-url https://download.pytorch.org/whl/cpu` で入れれば、スクリプトはそのままで構いません（自動で CPU を使います）。
- Windows では、AMD の ROCm for Windows の手順に従って PyTorch を入れてください。以降の手順は同じです。Windows で `run_all.sh` を使う場合は Git Bash などで実行してください。

## 2. 実行

```bash
cd ruri_finetune_kit
# ① 最優先（v2）: 会話を正例にした版と、従来版（real）を、ツールごとに10件 × seed 3本
KS=10 ARMS="convpos real" SEEDS="0 1 2" ./run_all.sh
# ② 学習曲線: 3件 / 5件（seed 3本。時間がなければ SEEDS=0）
KS="5 3" SEEDS="0 1 2" ./run_all.sh
# ③ 任意: 合成データ arm
KS=10 ARMS=cardx SEEDS="0 1 2" ./run_all.sh
# 参考（GPU 向け）: 全層を学習する（Box では未実施。結果は別のものとして扱います）
FULL=1 KS=10 SEEDS=0 ./run_all.sh
```

途中で止めても、もう一度同じコマンドを実行すれば続きから始まります（`scores.json` があるランは飛ばします）。1本ずつ実行する場合は次のとおりです。

```bash
python train.py --pairs pairs/k10-real-s0.jsonl --seed 0 --out runs/k10-real-s0
python score.py runs/k10-real-s0 runs/k10-real-s0/scores.json
python train.py --pairs pairs/k10-convpos-s0.jsonl --seed 0 --out runs/k10-convpos-s0
python score.py runs/k10-convpos-s0 runs/k10-convpos-s0/scores.json --with-conv   # convpos では会話カードも採点します
python score.py cl-nagoya/ruri-v3-reranker-310m runs/zs.json   # 同じ機械での zero-shot（遅延の比較用）
```

学習の設定は Box と同じです: 上位6層 + final_norm + 分類ヘッドだけを学習、AdamW（lr 2e-5、wd 0.01）、バッチ16、2 epoch、BCE、学習時の最大長256、スコア付け時の最大長512。

## 3. 返送してほしいもの

`run_all.sh` を実行すると、最後に `results.tgz` ができます（中身は `runs/zs.json`、`runs/*/scores.json`、`runs/*/meta.json` で、数 MB です）。これを送ってください。重みは不要です。

Box 側では次のコマンドで評価します（テストの正解は Box にだけあります）。

```bash
python3 archive/ruri-training/finetune/finetune.py eval --zs runs/zs.json --ft runs/k10-real-s*/scores.json --meta runs/k10-real-s*/meta.json
```

表記揺れ・対照・補正の評価は、`router correct --rerank ft=<モデルディレクトリ>` で行うため、モデルディレクトリそのものが必要です。こちらも測る場合は、`runs/k10-real-s0/` を丸ごと（約1.2GB）送ってください。
