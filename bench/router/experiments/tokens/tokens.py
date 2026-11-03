#!/usr/bin/env python3
"""Per-call LLM token accounting. Two providers:
  --provider local      (default) OpenAI-compatible endpoint (llama.cpp server / LM Studio / Ollama). Stdlib only;
                        refuses non-local hosts unless --allow-remote.
  --provider anthropic  Anthropic Messages API via anthropic_api.py (needs the `anthropic` package; key and model from .env).
                        This sends the utterance text to the Anthropic API.

  python tokens.py run   --report out/correct-x/report.json --export data/export/eumenes-... \
                         --url http://127.0.0.1:8080/v1 --model <name> [--system-file prompt.txt] [--limit N] --out tokens.jsonl
  python tokens.py stats --calls tokens.jsonl --report out/correct-x/report.json [--boot 4000]
  python tokens.py verify --items verify-items.jsonl --url http://127.0.0.1:8080/v1 --model <name> [--max-cands 3] --out verify.jsonl
  python tokens.py verify --provider anthropic [--effort low] --items verify-items.jsonl --out verify.jsonl
  python tokens.py verify-stats --calls verify.jsonl [--boot 4000]
  python tokens.py selftest            # mock servers: usage / reasoning_tokens / <think> parsing; the anthropic backend if installed

Per call it logs prompt / completion / reasoning tokens. Reasoning source, in order:
  usage.completion_tokens_details.reasoning_tokens  (LM Studio, newer llama.cpp, OpenAI-style)
  -> message.reasoning_content / message.reasoning  (llama.cpp --reasoning-format, Ollama think)  tokenized via /tokenize or /api/tokenize
  -> <think>...</think> in content                   same tokenization
  falling back to a char-based estimate (reasoning_src ends with ':est') when no tokenizer endpoint exists.
Anthropic: usage.output_tokens_details.thinking_tokens; when absent, reasoning_src is 'unreported' (thinking stays inside completion).
Items = the test split (report.json perTest). Every item is called once; stats then compare
"old route: LLM on every item" vs "cascade: LLM only on deferred items" per config (deferBefore/deferAfter).
"""
import json, os, sys, time, re, random, argparse, urllib.request, urllib.parse, threading, statistics as st
from collections import Counter
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

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
            "finish": (r.get("choices") or [{}])[0].get("finish_reason"), "seconds": round(dt, 3), "_content": THINK.sub("", content).strip()}

def local(url):
    h = urllib.parse.urlparse(url).hostname or ""
    return h in ("localhost", "127.0.0.1", "::1") or h.startswith(("192.168.", "10.")) or h.endswith(".local") or re.match(r"172\.(1[6-9]|2\d|3[01])\.", h)

def backend(a):
    """(model name, llm(messages, max_tokens) -> call record) for --provider."""
    if a.provider == "anthropic":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        try: import anthropic_api
        except ModuleNotFoundError as e:
            if e.name != "anthropic": raise
            sys.exit("--provider anthropic needs the anthropic package: uv run --no-project --with anthropic==2.4.0 python tokens.py ...")
        b = anthropic_api.Backend(a.model, a.effort); return b.model, b.call
    if a.effort: sys.exit("--effort is only for --provider anthropic")
    if not local(a.url) and not a.allow_remote: sys.exit("refusing non-local endpoint (use --allow-remote for a LAN host name)")
    model = a.model or "local"; return model, lambda msgs, n: call(a.url, model, msgs, n)

def run(a):
    model, llm = backend(a)
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
            try: rec = llm(msgs, a.max_tokens); rec.pop("_content", None)
            except Exception as e: rec = {"error": str(e)[:200]}
            rec.update(id=i, model=model); f.write(json.dumps(rec, ensure_ascii=False) + "\n"); f.flush()
            print(n + 1, len(ids), rec.get("prompt"), rec.get("reasoning"), rec.get("completion"), rec.get("reasoning_src"), file=sys.stderr)

VERIFY_SYSTEM = ("あなたはツール選択の検証係です。ユーザーの発話と、候補ツールの説明が与えられます。"
                 "この発話にこのツールが適切なら「はい」、そうでなければ「いいえ」だけを答えてください。")
YES = re.compile(r"^\s*(はい|yes)", re.I)
LIST_SYSTEM = ("あなたはツール選択の係です。ユーザーの発話と、番号付きの候補ツールの説明が与えられます。"
               "発話に最も適切なツールの番号を1つだけ答えてください。どの候補も適切でなければ 0 と答えてください。番号以外は書かないでください。")
NUM = re.compile(r"\d+")

def verify(a):
    """LLM check of the deferred items over the top --max-cands candidates (ranked); the utterance is cut to --max-chars,
    as the router cuts its ruri input at 400 chars.
      --mode yesno: one call per candidate down the ranking, stop at the first yes. One line per call.
      --mode list:  one call with the numbered candidates; the answer is a number, 0 = none of them. One line per item.
    Line: id, mode, step, cand (asked about / chosen; None when none was chosen), yes (a tool was accepted), final,
    correct (cand is gold/acceptable; None without gold or cand), shown, tokens.
    Items JSONL: {id, text, cands:[tool,...] (ranked), docs:{tool: card text}, gold?, acceptable?}. An item's lines are
    written together once it ends, so a stopped run leaves no partial item; resumable (skips ids that have a final line)."""
    model, llm = backend(a)
    items = [json.loads(l) for l in open(a.items)]; done = set()
    try: done = {json.loads(l)["id"] for l in open(a.out) if json.loads(l).get("final")}
    except FileNotFoundError: pass
    def ask(msgs):
        try: rec = llm(msgs, a.max_tokens); return rec, rec.pop("_content", "")
        except Exception as e: return {"error": str(e)[:200]}, ""
    with open(a.out, "a") as f:
        for it in [i for i in items if i["id"] not in done][: a.limit or None]:
            text = it["text"][: a.max_chars]; cands = it["cands"][: a.max_cands]; docs = it.get("docs", {})
            ok = lambda c: (c == it.get("gold") or c in it.get("acceptable", [])) if "gold" in it and c is not None else None
            base = dict(id=it["id"], mode=a.mode, shown=len(cands), max_chars=a.max_chars, model=model); recs = []
            if a.mode == "list":
                body = "\n".join(f"{n}. {c}: {docs.get(c, c)}" for n, c in enumerate(cands, 1))
                rec, ans = ask([{"role": "system", "content": LIST_SYSTEM}, {"role": "user", "content": f"発話: {text}\n候補:\n{body}\n答え（番号）:"}])
                m = NUM.search(ans); k = int(m.group()) if m else -1; c = cands[k - 1] if 1 <= k <= len(cands) else None
                rec.update(base, step=0, cand=c, answer=k, yes=c is not None, final=True, correct=ok(c)); recs.append(rec)
            else:
                for step, c in enumerate(cands):
                    rec, ans = ask([{"role": "system", "content": VERIFY_SYSTEM}, {"role": "user", "content": f"発話: {text}\nツール: {c}\n説明: {docs.get(c, c)}\n答え（はい/いいえ）:"}])
                    yes = bool(YES.search(ans)); rec.update(base, step=step, cand=c, yes=yes, final=yes or step == len(cands) - 1, correct=ok(c)); recs.append(rec)
                    if yes: break
            f.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs)); f.flush()

def verify_stats(a):
    calls = [json.loads(l) for l in open(a.calls)]; ok_calls = [c for c in calls if "error" not in c]
    per = {}
    for c in ok_calls: per.setdefault(c["id"], []).append(c)
    tot = lambda c: (c.get("prompt") or 0) + (c.get("completion") or 0)
    items = list(per.values()); n_calls = [len(v) for v in items]; tok_item = [sum(tot(c) for c in v) for v in items]
    yn = [c for c in ok_calls if c.get("mode", "yesno") == "yesno"]  # per-call yes/no error rates only mean something there
    fy = [c for c in yn if c["yes"] and c.get("correct") is False]; fn = [c for c in yn if not c["yes"] and c.get("correct") is True]
    rate = lambda xs, n: round(100 * len(xs) / max(1, n), 1) if yn else None
    out = {"mode": dict(Counter(c.get("mode", "yesno") for c in ok_calls)), "items": len(items), "calls": len(ok_calls), "calls_per_item": round(st.mean(n_calls), 3) if items else None,
           "tokens_per_call": round(st.mean([tot(c) for c in ok_calls]), 1) if ok_calls else None, "tokens_per_item": round(st.mean(tok_item), 1) if items else None,
           "tokens_per_item_ci": boot(tok_item, st.mean, a.boot) if items else None,
           "false_yes_rate": rate(fy, sum(c.get("correct") is False for c in yn)), "false_no_rate": rate(fn, sum(c.get("correct") is True for c in yn)),
           "accepted_correct": sum(1 for v in items if v[-1]["yes"] and v[-1].get("correct")), "all_no": sum(1 for v in items if not v[-1]["yes"]),
           "invalid_answers": sum(1 for c in ok_calls if c.get("mode") == "list" and not 0 <= c.get("answer", -1) <= c["shown"]),
           "finish": dict(Counter(c.get("finish") for c in ok_calls))}
    if items:
        sec_item = [sum(c.get("seconds") or 0 for c in v) for v in items]
        out["totals"] = {k: sum(c.get(k) or 0 for c in ok_calls) for k in ("prompt", "completion", "reasoning")}
        out["reasoning_per_item"] = round(st.mean([sum(c.get("reasoning") or 0 for c in v) for v in items]), 1)
        out["tokens_per_item_p50_p95"] = [round(pct(tok_item, .5), 1), round(pct(tok_item, .95), 1)]
        out["seconds_per_item_p50_p95"] = [round(pct(sec_item, .5), 2), round(pct(sec_item, .95), 2)]
    if a.items and items:  # decisions after the yes/no chain, by what an all-no item falls back to; references on the same items
        its = {x["id"]: x for x in map(json.loads, open(a.items))}; ok = lambda x, c: c is not None and (c == x.get("gold") or c in x.get("acceptable", []))
        k = max(c.get("shown") or c["step"] + 1 for c in ok_calls); xs = [its[v[0]["id"]] for v in items]
        def final(v, fb):
            x = its[v[0]["id"]]; return v[-1]["cand"] if v[-1]["yes"] else {"ask": None, "top1": x["cands"][0], "past": x.get("past")}[fb]
        out["outcome"] = {"accepted_wrong": sum(1 for v in items if v[-1]["yes"] and v[-1].get("correct") is False),
                          "correct_if_all_no": {fb: sum(ok(its[v[0]["id"]], final(v, fb)) for v in items) for fb in ("ask", "top1", "past")},
                          "reference": {"ranker_top1": sum(ok(x, x["cands"][0]) for x in xs), "past": sum(ok(x, x.get("past")) for x in xs), f"gold_in_top{k}": sum(any(ok(x, c) for c in x["cands"][:k]) for x in xs)}}
    print(json.dumps(out, ensure_ascii=False, indent=1))

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
    out = {"n_calls": len(calls), "reasoning_src": dict(Counter(c["reasoning_src"] for c in calls)), "finish": dict(Counter(c.get("finish") for c in calls)), "per_call": {}}
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
            elif "候補:" in body["messages"][-1]["content"]:  # list mode: pick candidate 3
                H.last = body; r = {"choices": [{"message": {"content": "3"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 50, "completion_tokens": 2}}
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
    import tempfile
    d = tempfile.mkdtemp(); ip = os.path.join(d, "i.jsonl"); op = os.path.join(d, "v.jsonl")
    open(ip, "w").write(json.dumps({"id": "x", "text": "t", "cands": ["a", "b", "c", "d"], "gold": "c"}) + "\n")
    ns = argparse.Namespace(items=ip, url=base, model="m", provider="local", effort=None, mode="yesno", max_chars=400, max_cands=3, max_tokens=16, out=op, limit=None, allow_remote=False)
    verify(ns); v = [json.loads(l) for l in open(op)]
    assert len(v) == 3 and v[-1]["final"] and v[0]["step"] == 0, v  # mock never says yes -> stops at max 3 calls
    verify(ns); assert len(open(op).readlines()) == 3  # resumable
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): verify_stats(argparse.Namespace(calls=op, boot=50, items=ip))
    vs = json.loads(buf.getvalue())  # all three answers are no; gold "c" is the 3rd candidate
    assert vs["all_no"] == 1 and vs["outcome"]["correct_if_all_no"] == {"ask": 0, "top1": 0, "past": 0} and vs["outcome"]["reference"] == {"ranker_top1": 0, "past": 0, "gold_in_top3": 1}, vs
    ip2 = os.path.join(d, "i2.jsonl"); op3 = os.path.join(d, "vl.jsonl")  # list mode: one call, answer 3 -> "c"; utterance cut to 400 chars
    open(ip2, "w").write(json.dumps({"id": "y", "text": "あ" * 450, "cands": ["a", "b", "c", "d"], "gold": "c"}) + "\n")
    verify(argparse.Namespace(**{**vars(ns), "items": ip2, "out": op3, "mode": "list"})); v = [json.loads(l) for l in open(op3)]
    assert len(v) == 1 and (v[0]["cand"], v[0]["answer"], v[0]["yes"], v[0]["correct"], v[0]["shown"], v[0]["mode"]) == ("c", 3, True, True, 3, "list"), v
    u = H.last["messages"][-1]["content"]; assert "あ" * 400 in u and "あ" * 401 not in u and "3. c: c" in u and "4. d" not in u, u
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): verify_stats(argparse.Namespace(calls=op3, boot=50, items=ip2))
    vs = json.loads(buf.getvalue())
    assert vs["false_yes_rate"] is None and vs["invalid_answers"] == 0 and vs["outcome"]["correct_if_all_no"]["ask"] == 1 and vs["outcome"]["reference"]["gold_in_top3"] == 1, vs
    try: import anthropic  # noqa: F401
    except ImportError: print("selftest ok (anthropic backend skipped: package not installed)"); return
    class A(BaseHTTPRequestHandler):  # Messages API mock: 1st call "いいえ" with thinking_tokens, 2nd "はい" without
        seen = []
        def log_message(self, *a): pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"]))); A.seen.append((self.path, self.headers.get("x-api-key") or self.headers.get("authorization"), body)); n = len(A.seen)
            u = {"input_tokens": 7, "output_tokens": 30, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 3}
            if n == 1: u["output_tokens_details"] = {"thinking_tokens": 22}
            r = {"id": f"msg_{n}", "type": "message", "role": "assistant", "model": body["model"], "stop_reason": "end_turn", "stop_sequence": None, "usage": u,
                 "content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": "はい" if n > 1 else "いいえ"}]}
            b = json.dumps(r).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    sa = HTTPServer(("127.0.0.1", 0), A); threading.Thread(target=sa.serve_forever, daemon=True).start()
    os.environ.update(ANTHROPIC_BASE_URL=f"http://127.0.0.1:{sa.server_port}", ANTHROPIC_API_KEY="test-key", ROUTER_LLM_MODEL="m-env", ROUTER_LLM_EFFORT="low")
    op2 = os.path.join(d, "va.jsonl")
    verify(argparse.Namespace(**{**vars(ns), "url": None, "model": None, "provider": "anthropic", "max_tokens": 64, "out": op2}))
    v = [json.loads(l) for l in open(op2)]
    assert [c["yes"] for c in v] == [False, True] and v[-1]["final"] and v[-1]["model"] == "m-env", v  # stops at the first yes
    assert (v[0]["prompt"], v[0]["completion"], v[0]["reasoning"], v[0]["reasoning_src"]) == (10, 30, 22, "usage") and v[1]["reasoning_src"] == "unreported", v
    path, key, body = A.seen[0]  # the SDK sends the key as x-api-key or as a Bearer token depending on its version
    assert path == "/v1/messages" and key in ("test-key", "Bearer test-key") and body["system"] == VERIFY_SYSTEM and [m["role"] for m in body["messages"]] == ["user"], body
    assert "temperature" not in body and body["output_config"] == {"effort": "low"} and v[0]["effort"] == "low", body
    print("selftest ok (local + anthropic backends)")

if __name__ == "__main__":
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest="cmd", required=True)
    def llm_args(x):
        x.add_argument("--provider", choices=["local", "anthropic"], default="local"); x.add_argument("--url", default="http://127.0.0.1:8080/v1")
        x.add_argument("--model", help="local: name sent to the endpoint (default 'local'); anthropic: default ROUTER_LLM_MODEL")
        x.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"], help="anthropic only; default ROUTER_LLM_EFFORT, else the API default")
        x.add_argument("--allow-remote", action="store_true")
    r = sp.add_parser("run"); r.add_argument("--report", required=True); r.add_argument("--export"); llm_args(r)
    r.add_argument("--system-file"); r.add_argument("--limit", type=int); r.add_argument("--max-tokens", type=int, default=4096); r.add_argument("--out", default="tokens.jsonl")
    s = sp.add_parser("stats"); s.add_argument("--calls", required=True); s.add_argument("--report", required=True); s.add_argument("--boot", type=int, default=4000)
    v = sp.add_parser("verify"); v.add_argument("--items", required=True); llm_args(v)
    v.add_argument("--mode", choices=["yesno", "list"], default="yesno"); v.add_argument("--max-chars", type=int, default=400, help="cut the utterance (the router's ruri input is cut at 400)")
    v.add_argument("--max-cands", type=int, default=3); v.add_argument("--max-tokens", type=int, default=1024); v.add_argument("--limit", type=int); v.add_argument("--out", default="verify.jsonl")
    vs = sp.add_parser("verify-stats"); vs.add_argument("--calls", required=True); vs.add_argument("--boot", type=int, default=4000)
    vs.add_argument("--items", help="the verify items (gold/past): adds decision outcomes and same-item references")
    sp.add_parser("selftest"); a = p.parse_args()
    {"run": run, "stats": stats, "verify": verify, "verify-stats": verify_stats}[a.cmd](a) if a.cmd != "selftest" else selftest()
