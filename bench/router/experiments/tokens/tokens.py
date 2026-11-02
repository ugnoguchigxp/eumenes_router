#!/usr/bin/env python3
"""Per-call LLM token accounting against a LOCAL OpenAI-compatible endpoint (llama.cpp server / LM Studio / Ollama).
Stdlib only. Never calls external APIs: refuses non-local hosts unless --allow-remote.

  python tokens.py run   --report out/correct-x/report.json --export data/export/eumenes-... \
                         --url http://127.0.0.1:8080/v1 --model <name> [--system-file prompt.txt] [--limit N] --out tokens.jsonl
  python tokens.py stats --calls tokens.jsonl --report out/correct-x/report.json [--boot 4000]
  python tokens.py selftest            # mock server, checks usage / reasoning_tokens / <think> fallback parsing

Per call it logs prompt / completion / reasoning tokens. Reasoning source, in order:
  usage.completion_tokens_details.reasoning_tokens  (LM Studio, newer llama.cpp, OpenAI-style)
  -> message.reasoning_content / message.reasoning  (llama.cpp --reasoning-format, Ollama think)  tokenized via /tokenize or /api/tokenize
  -> <think>...</think> in content                   same tokenization
  falling back to a char-based estimate (reasoning_src ends with ':est') when no tokenizer endpoint exists.
Items = the test split (report.json perTest). Every item is called once; stats then compare
"old route: LLM on every item" vs "cascade: LLM only on deferred items" per config (deferBefore/deferAfter).
"""
import json, sys, time, re, random, argparse, urllib.request, urllib.parse, threading, statistics as st
from http.server import BaseHTTPRequestHandler, HTTPServer

DEFAULT_SYSTEM = "あなたは個人アシスタントです。ユーザーの依頼に日本語で答えてください。"
THINK = re.compile(r"<think>(.*?)(</think>|$)", re.S)

def post(url, body, timeout=600):
    r = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as f: return json.load(f)

def count_tokens(base, model, text):
    if not text: return 0, "none"
    root = re.sub(r"/v1/?$", "", base)
    for path, body, key in ((root + "/tokenize", {"content": text}, "tokens"), (root + "/api/tokenize", {"model": model, "text": text}, "tokens")):
        try:
            t = post(path, body, 30).get(key)
            if isinstance(t, list): return len(t), "tokenize"
        except Exception: pass
    return round(len(text) / 1.5), "est"  # ~1.5 chars/token for Japanese; flagged as estimate

def call(base, model, messages, max_tokens):
    t0 = time.time()
    r = post(base.rstrip("/") + "/chat/completions", {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0, "stream": False})
    dt = time.time() - t0
    u = r.get("usage") or {}; m = (r.get("choices") or [{}])[0].get("message") or {}
    content = m.get("content") or ""
    rt = (u.get("completion_tokens_details") or {}).get("reasoning_tokens")
    src = "usage"
    if not rt:
        rtext = m.get("reasoning_content") or m.get("reasoning") or ""
        src = "reasoning_field"
        if not rtext:
            mm = THINK.search(content); rtext = mm.group(1) if mm else ""; src = "think_tag"
        if rtext:
            rt, how = count_tokens(base, model, rtext); src += ":" + how
        else: rt, src = 0, "none"
    return {"prompt": u.get("prompt_tokens"), "completion": u.get("completion_tokens"), "reasoning": rt, "reasoning_src": src,
            "finish": (r.get("choices") or [{}])[0].get("finish_reason"), "seconds": round(dt, 3)}

def local(url):
    h = urllib.parse.urlparse(url).hostname or ""
    return h in ("localhost", "127.0.0.1", "::1") or h.startswith(("192.168.", "10.")) or h.endswith(".local") or re.match(r"172\.(1[6-9]|2\d|3[01])\.", h)

def run(a):
    if not local(a.url) and not a.allow_remote: sys.exit("refusing non-local endpoint (use --allow-remote for a LAN host name)")
    rep = json.load(open(a.report)); tests = {}
    for c in rep["configs"].values():
        for t in c.get("perTest", []): tests[t["id"]] = t["text"]
    ctx = {}
    if a.export:
        for l in open(a.export.rstrip("/") + "/utterances.jsonl"):
            d = json.loads(l); ctx[d["turnId"]] = d
    system = open(a.system_file).read() if a.system_file else DEFAULT_SYSTEM
    done = set()
    try: done = {json.loads(l)["id"] for l in open(a.out)}
    except FileNotFoundError: pass
    ids = [i for i in tests if i not in done][: a.limit or None]
    with open(a.out, "a") as f:
        for n, i in enumerate(ids):
            d = ctx.get(i, {}); msgs = [{"role": "system", "content": system}]
            if d.get("previousUser"): msgs.append({"role": "user", "content": d["previousUser"]})
            if d.get("previousAgent"): msgs.append({"role": "assistant", "content": d["previousAgent"]})
            msgs.append({"role": "user", "content": tests[i]})
            try: rec = call(a.url, a.model, msgs, a.max_tokens)
            except Exception as e: rec = {"error": str(e)[:200]}
            rec.update(id=i, model=a.model); f.write(json.dumps(rec, ensure_ascii=False) + "\n"); f.flush()
            print(n + 1, len(ids), rec.get("prompt"), rec.get("reasoning"), rec.get("completion"), rec.get("reasoning_src"), file=sys.stderr)

def pct(xs, q):
    xs = sorted(xs); k = (len(xs) - 1) * q; lo = int(k); hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)

def boot(vals, f, B, seed=7):
    rnd = random.Random(seed); n = len(vals); s = sorted(f([vals[rnd.randrange(n)] for _ in range(n)]) for _ in range(B))
    return [round(s[int(.025 * B)], 1), round(s[int(.975 * B) - 1], 1)]

def stats(a):
    calls = [json.loads(l) for l in open(a.calls)]; calls = [c for c in calls if "error" not in c and c.get("completion") is not None]
    by = {c["id"]: c for c in calls}
    for c in calls:
        c["total"] = (c["prompt"] or 0) + (c["completion"] or 0)
        c["answer"] = max((c["completion"] or 0) - (c["reasoning"] or 0), 0)  # reasoning is usually inside completion_tokens
    out = {"n_calls": len(calls), "reasoning_src": {s: sum(c["reasoning_src"] == s for c in calls) for s in {c["reasoning_src"] for c in calls}}, "per_call": {}}
    for k in ("prompt", "reasoning", "answer", "completion", "total", "seconds"):
        v = [float(c[k] or 0) for c in calls]
        out["per_call"][k] = {"mean": round(st.mean(v), 1), "mean_ci": boot(v, st.mean, a.boot), "p50": round(pct(v, .5), 1), "p50_ci": boot(v, lambda x: pct(x, .5), a.boot), "p95": round(pct(v, .95), 1), "p95_ci": boot(v, lambda x: pct(x, .95), a.boot)}
    rep = json.load(open(a.report)); out["configs"] = {}
    for name, c in rep["configs"].items():
        if "perTest" not in c or name == "sr" or "@" in name: continue
        for phase in ("deferBefore", "deferAfter"):
            rows = [(by[t["id"]], t[phase]) for t in c["perTest"] if t["id"] in by]
            if not rows: continue
            def red(rs, k):  # % of tokens saved vs calling the LLM on every item
                tot = sum(r[0][k] or 0 for r in rs); kept = sum((r[0][k] or 0) for r in rs if r[1]); return 100 * (1 - kept / tot) if tot else 0
            res = {"n": len(rows), "defer_rate": round(100 * sum(d for _, d in rows) / len(rows), 1)}
            for k in ("total", "completion", "reasoning"):
                res["saved_" + k] = round(red(rows, k), 1); res["saved_" + k + "_ci"] = boot(rows, lambda rs, k=k: red(rs, k), a.boot)
            res["deferred_mean_total"] = round(st.mean([r[0]["total"] for r in rows if r[1]] or [0]), 1)
            res["kept_mean_total"] = round(st.mean([r[0]["total"] for r in rows if not r[1]] or [0]), 1)
            out["configs"][f"{name}/{phase}"] = res
    print(json.dumps(out, ensure_ascii=False, indent=1))

def selftest():
    class H(BaseHTTPRequestHandler):
        mode = 0
        def log_message(self, *a): pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/tokenize": r = {"tokens": list(range(len(body["content"]) // 2))}
            else:
                H.mode += 1; m = H.mode % 3
                msg = {"content": "答え"} if m == 1 else ({"content": "答え", "reasoning_content": "x" * 40} if m == 2 else {"content": "<think>" + "y" * 20 + "</think>答え"})
                u = {"prompt_tokens": 10, "completion_tokens": 30}
                if m == 1: u["completion_tokens_details"] = {"reasoning_tokens": 25}
                r = {"choices": [{"message": msg, "finish_reason": "stop"}], "usage": u}
            b = json.dumps(r).encode(); self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    s = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=s.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{s.server_port}/v1"; msgs = [{"role": "user", "content": "hi"}]
    got = [call(base, "m", msgs, 16) for _ in range(3)]
    assert (got[0]["reasoning"], got[0]["reasoning_src"]) == (25, "usage"), got[0]
    assert (got[1]["reasoning"], got[1]["reasoning_src"]) == (20, "reasoning_field:tokenize"), got[1]
    assert (got[2]["reasoning"], got[2]["reasoning_src"]) == (10, "think_tag:tokenize"), got[2]
    assert local(base) and not local("https://api.openai.com/v1")
    print("selftest ok")

if __name__ == "__main__":
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest="cmd", required=True)
    r = sp.add_parser("run"); r.add_argument("--report", required=True); r.add_argument("--export"); r.add_argument("--url", default="http://127.0.0.1:8080/v1")
    r.add_argument("--model", default="local"); r.add_argument("--system-file"); r.add_argument("--limit", type=int); r.add_argument("--max-tokens", type=int, default=4096)
    r.add_argument("--out", default="tokens.jsonl"); r.add_argument("--allow-remote", action="store_true")
    s = sp.add_parser("stats"); s.add_argument("--calls", required=True); s.add_argument("--report", required=True); s.add_argument("--boot", type=int, default=4000)
    sp.add_parser("selftest"); a = p.parse_args()
    {"run": run, "stats": stats, "selftest": lambda _: selftest()}[a.cmd](a) if a.cmd != "selftest" else selftest()
