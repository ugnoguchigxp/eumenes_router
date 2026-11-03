#!/usr/bin/env python3
"""Second-opinion check that each hand-written variant keeps its source's meaning: the same request (same target and
conditions), or still chit-chat / a reply. One LLM call per variant, through tokens.py's providers. Resumable; one line
per variant: {i (line index in --variants), source, type, same (True / False / None = unparsed), tokens...}.

  uv run --no-project --with anthropic==2.4.0 python archive/variants-check/check.py run --provider anthropic --effort low \
      --sources data/variants-v2/sources.jsonl --variants data/variants-v2/variants.jsonl --out data/variants-v2/check.jsonl
  python archive/variants-check/check.py stats --check data/variants-v2/check.jsonl
"""
import argparse, json, sys, threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "llm-verify"))
import tokens  # noqa: E402

SYSTEM = ("あなたは言い換えの検査係です。会話の直前のやりとり、元の発話、その言い換えが与えられます。"
          "言い換えが元の発話と同じことを求めているか（同じ依頼・同じ対象・同じ条件か、または同じく雑談・相づち・返事か）を判定し、"
          "「同じ」か「違う」だけを答えてください。言い方・丁寧さ・長さ・誤字・聞き取り違いの違いは問いません。")


def run(a):
    model, llm = tokens.backend(a)
    src = {s["source"]: s for s in map(json.loads, open(a.sources))}
    var = [json.loads(l) for l in open(a.variants)]
    try: done = {json.loads(l)["i"] for l in open(a.out)}
    except FileNotFoundError: done = set()
    lock = threading.Lock()
    def one(i, f):
        v = var[i]; s = src[v["source"]]
        user = (f"直前の利用者: {s.get('previousUser') or 'なし'}\n直前のエージェント: {s.get('previousAgent') or 'なし'}\n"
                f"元の発話: {s['text']}\n言い換え: {v['text']}\n答え（同じ/違う）:")
        rec = llm([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], a.max_tokens); ans = rec.pop("_content", "").strip()
        same = True if ans.startswith("同じ") else False if ans.startswith("違う") else None
        rec.update(i=i, source=v["source"], type=v["type"], same=same, answer=ans[:20], model=model)
        with lock: f.write(json.dumps(rec, ensure_ascii=False) + "\n"); f.flush()
    todo = [i for i in range(len(var)) if i not in done][: a.limit or None]
    with open(a.out, "a") as f, ThreadPoolExecutor(a.workers) as ex:
        for fut in [ex.submit(one, i, f) for i in todo]: fut.result()
    print(json.dumps({"checked": len(todo), "total": len(var)}))


def stats(a):
    rows = [json.loads(l) for l in open(a.check)]
    by = {}
    for r in rows: by.setdefault(r["type"], Counter())[str(r["same"])] += 1
    print(json.dumps({"n": len(rows), "same": dict(Counter(str(r["same"]) for r in rows)), "by_type": {t: dict(c) for t, c in sorted(by.items())},
                      "tokens": sum((r.get("prompt") or 0) + (r.get("completion") or 0) for r in rows),
                      "not_same": sorted(r["i"] for r in rows if r["same"] is not True)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest="cmd", required=True)
    r = sp.add_parser("run"); r.add_argument("--sources", required=True); r.add_argument("--variants", required=True); r.add_argument("--out", required=True)
    r.add_argument("--provider", choices=["local", "anthropic"], default="local"); r.add_argument("--url", default="http://127.0.0.1:8080/v1"); r.add_argument("--model")
    r.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"]); r.add_argument("--allow-remote", action="store_true")
    r.add_argument("--max-tokens", type=int, default=256); r.add_argument("--workers", type=int, default=4); r.add_argument("--limit", type=int)
    s = sp.add_parser("stats"); s.add_argument("--check", required=True)
    a = p.parse_args(); {"run": run, "stats": stats}[a.cmd](a)
