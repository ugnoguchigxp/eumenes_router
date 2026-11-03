#!/usr/bin/env python3
"""LARM's context judgment (one provider of a normal profile) checked on the bench's labeled data, apart from the main
router (best-v2). Stdlib only and not part of the package. The control Bearer is LARM_API_TOKEN (environment, else the
repo-root .env); everything else, including the control origin `url`, comes from --config (copy config.example.json to config.json).
Calls run one at a time; credentials are never written to records or logs.

  python archive/larm-context/context.py probe --config archive/larm-context/config.json [--text "明日の天気は？"]
  python archive/larm-context/context.py run   --config archive/larm-context/config.json --corr data/variants-v2/corr \
      [--variants data/variants-v2/variants.final.jsonl] --out data/larm-context/judged.jsonl
  python archive/larm-context/context.py swap  --config ... --corr data/variants-v2/corr --variants ... --judged data/larm-context/judged.jsonl \
      --out data/larm-context/corr-larm      # best-v2 with this provider's scores in place of its reranker: then best_v2.py eval --corr <out>
  python archive/larm-context/context.py fit   --judged data/larm-context/judged.jsonl --out data/larm-context/rule.json   # dev only
  python archive/larm-context/context.py eval  --judged data/larm-context/judged.jsonl --rule data/larm-context/rule.json  # test + variants
  python archive/larm-context/context.py selftest

The provider returns per-candidate scores but no conversation class, so `fit` learns on dev when to fall back to
conversation (top score and top-1/top-2 margin), bound to the scenario/network it was fitted on; `eval` refuses records
judged under another scenario/network.
"""
import argparse, json, os, random, re, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request, uuid
from collections import Counter
from pathlib import Path

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").exists())  # the repo root
CONV = "conversation.respond"
ID_RE = re.compile(r"^[A-Za-z0-9.:_-]{1,96}$")
LIMITS = {"text_chars": 400, "candidates": 128, "description_chars": 4096, "request_bytes": 2 * 1024 * 1024}
DONE = ("failed", "expired", "released")


class LarmError(Exception): pass
class Rejected(Exception): pass  # HTTP 400: the input or the registered values must be fixed, never retried


def load_env(path=ROOT / ".env"):
    try: lines = path.read_text().splitlines()
    except FileNotFoundError: return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1); k = k.removeprefix("export ").strip(); v = v.strip().strip("\"'")
        if k and v and k not in os.environ: os.environ[k] = v


def http(method, url, token, body=None, headers=None, timeout=120):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    h = {"Authorization": f"Bearer {token}", "Accept": "application/json", **({"Content-Type": "application/json"} if data is not None else {}), **(headers or {})}
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data, h, method=method), timeout=timeout) as r: st, raw = r.status, r.read()
    except urllib.error.HTTPError as e: st, raw = e.code, e.read()
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e: raise LarmError(f"network: {type(e).__name__}") from None  # never a conversation
    try: js = json.loads(raw) if raw else None
    except ValueError: js = None
    return st, js, (time.perf_counter() - t0) * 1000


def expiry(s):
    """Epoch seconds of an ISO-8601 time (claim.expiresAt), or None."""
    if not isinstance(s, str): return None
    try:
        import datetime
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError: return None


def err_code(js):
    e = js.get("error") if isinstance(js, dict) else None
    return (e.get("code") or e.get("type")) if isinstance(e, dict) else e if isinstance(e, str) else None


class Larm:
    """Control plane (profile catalog, connection, readiness, claim, release) and the claimed provider's own endpoint."""
    def __init__(self, cfg):
        load_env()
        self.base, self.ctl = cfg.get("url"), os.environ.get("LARM_API_TOKEN")
        if not self.ctl: sys.exit("set LARM_API_TOKEN (environment or .env)")
        for k in ("url", "profile", "provider", "capability", "audience", "client"):
            if not cfg.get(k): sys.exit(f"config: {k} is required")
        self.cfg, self.name, self.conn, self.p, self.declared = cfg, cfg["provider"], None, None, None
        self.hosts = {urllib.parse.urlparse(self.base).hostname, *cfg.get("extraHosts", [])}

    def control(self, method, path, body=None, headers=None, ok=(200,)):
        st, js, _ = http(method, urllib.parse.urljoin(self.base, path), self.ctl, body, headers)
        if st not in ok: raise LarmError(f"control {method} {path.split('?')[0]}: HTTP {st} {err_code(js) or ''}".strip())
        return js or {}

    def connect(self):
        prof = self.cfg["profile"]
        cat = self.control("GET", f"/v3/agent-profiles?profile={urllib.parse.quote(prof)}")
        if cat.get("contractVersion") != "agent-connection.v3" or cat.get("requestedProfile") != prof or len(cat.get("profiles") or []) != 1:
            raise LarmError("catalog: unexpected shape")
        self.declared = next((p for p in cat["profiles"][0].get("providers", []) if p.get("name") == self.name), None)
        if not self.declared or self.declared.get("capability") != self.cfg["capability"] or not self.declared.get("model"):
            raise LarmError(f"catalog: provider {self.name} with {self.cfg['capability']} not in the profile")
        created = self.control("POST", "/v1/agent-connections", {"profile": prof, "client": self.cfg["client"], "audience": self.cfg["audience"],
                               "ttlSeconds": self.cfg.get("ttlSeconds", 600), "allowFallback": False, "deploymentPolicy": "existing-only",
                               "providers": [self.name], "expectedCatalogRevision": cat.get("catalogRevision")},
                               {"Idempotency-Key": str(uuid.uuid4())}, ok=(201, 202))
        self.conn = created.get("id")
        if not isinstance(self.conn, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", self.conn): raise LarmError("connection: invalid id")
        deadline, rec = time.time() + self.cfg.get("readyTimeoutSeconds", 120), created
        while True:
            p = next((x for x in rec.get("providers", []) if x.get("name") == self.name), None)
            if p is None: raise LarmError("connection: provider missing")
            if rec.get("status") in DONE or p.get("readiness") in DONE: raise LarmError(f"connection: {rec.get('status')}/{p.get('readiness')}")
            if rec.get("status") == "ready" and p.get("readiness") == "ready" and p.get("claimable", True) is not False: break
            if time.time() > deadline: raise LarmError("connection: not ready in time")
            time.sleep(0.5); rec = self.control("GET", f"/v1/agent-connections/{self.conn}")
        self.claim()

    def claim(self):  # no Idempotency-Key on claim
        c = self.control("POST", f"/v1/agent-connections/{self.conn}/claim", {"format": "openai-provider-v1", "providers": [self.name]})
        if c.get("id") != self.conn or c.get("status") != "ready": raise LarmError("claim: not ready")
        info = next((p for p in c.get("providers", []) if p.get("name") == self.name), None)  # by name, never by position
        if not info: raise LarmError("claim: provider missing")
        ep = urllib.parse.urlparse(str(info.get("endpoint") or ""))
        if ep.scheme not in ("http", "https") or ep.hostname not in self.hosts: raise LarmError("claim: endpoint host is not the LARM host (add it to extraHosts if intended)")
        token = (info.get("credential") or {}).get("token")
        if not token or info.get("model") != self.declared.get("model"): raise LarmError("claim: credential or model mismatch")
        self.p = {"endpoint": ep.geturl(), "model": info["model"], "token": token, "api": info.get("api") or self.declared.get("api") or {},
                  "expires": expiry(c.get("expiresAt"))}

    def reconnect(self):
        try: self.release()
        except LarmError: self.conn = self.p = None
        self.connect()

    def release(self):
        if self.conn:
            try: self.control("DELETE", f"/v1/agent-connections/{self.conn}", ok=(200, 202, 204, 404))
            finally: self.conn = self.p = None

    def judge(self, text, criteria):
        """One choice question over the candidates. 503 waits with a bound. 401 re-claims, then reconnects with the same
        profile; a connection about to expire is replaced before the call."""
        if self.p.get("expires") and time.time() > self.p["expires"] - 60: self.reconnect()
        api, r = self.p["api"], self.cfg.get("retry", {}); reclaimed = reconnected = False
        body = {"model": self.p["model"], "state": {"text": text}, "questions": {"route": {"type": "choice", "instructions": "候補ツールとの関連度を評価する", "criteria": criteria}},
                **({"scenario": api["scenario"]} if api.get("scenario") else {}), **({"network": api["network"]} if api.get("network") else {})}
        for attempt in range(1, r.get("maxAttempts", 6) + 1):
            body["model"] = self.p["model"]
            st, js, ms = http("POST", self.p["endpoint"], self.p["token"], body)
            if st == 200: return js, ms, attempt
            if st == 400: raise Rejected(err_code(js) or "bad_request")
            if st == 401 and not reconnected:
                if not reclaimed:
                    reclaimed = True
                    try: self.claim(); continue
                    except LarmError: pass
                reconnected = True; self.reconnect(); continue
            if st == 503:
                time.sleep(min(r.get("baseMs", 500) * 2 ** (attempt - 1), r.get("maxMs", 8000)) / 1000); continue
            raise LarmError(f"judge: HTTP {st} {err_code(js) or ''}".strip())
        raise LarmError("judge: still busy (503) after retries")


def limit_issue(text, criteria):
    """Over-limit inputs are reported, never cut to fit."""
    if len(text) > LIMITS["text_chars"]: return "text_over_limit"
    if not criteria: return "no_candidates"
    if len(criteria) > LIMITS["candidates"]: return "too_many_candidates"
    if any(not ID_RE.match(k) or k == "__proto__" for k in criteria): return "bad_candidate_id"
    if any(len(v) > LIMITS["description_chars"] for v in criteria.values()): return "description_over_limit"
    if len(json.dumps({"state": {"text": text}, "criteria": criteria}, ensure_ascii=False).encode()) > LIMITS["request_bytes"]: return "request_over_limit"
    return None


def card_doc(cards, c):
    p = cards.get(c, {}).get("passages") or [c]; return p[0] + " 例: " + " / ".join(p[1:6])


def swap(a):
    """Copy a corr dir with the main router's reranker scores replaced by this provider's: rerank-ruri.json from the judged
    records, and the kNN/table extra candidates (rerank-extra-in.json rows) scored now, so best_v2.py eval runs unchanged on
    the copy. Pairs the provider cannot take (text over the limit, controls) keep the original scores and are counted."""
    import shutil
    src, dst = Path(a.corr), Path(a.out)
    if dst.exists(): sys.exit(f"{dst} exists")
    cfg = json.load(open(a.config)); items = load_items(src, a.variants, cfg.get("candidates", 8))
    judged = {r["id"]: r for r in map(json.loads, open(a.judged))}
    by = {(x["text"], frozenset(judged[x["id"]]["scores"])): judged[x["id"]]["scores"] for x in items if judged.get(x["id"], {}).get("status") == "ok"}
    rr = json.load(open(src / "rerank-ruri.json")); kept = 0
    for k, v in rr.items():
        s = by.get((k.split("\x00")[0], frozenset(v)))
        if s: rr[k] = {c: s[c] for c in v}
        else: kept += 1
    cards = json.load(open(src / "rerank-in.json"))["cards"]; rows = json.load(open(src / "rerank-extra-in.json"))["rows"]
    ex, over = {}, 0; larm = Larm(cfg); larm.connect()
    try:
        for r in rows:
            key = r["text"] + "\x00" + "|".join(r["cands"])
            if key in ex: continue
            crit = {c: card_doc(cards, c) for c in r["cands"]}
            if limit_issue(r["text"], crit): over += 1; continue
            js, _, _ = larm.judge(r["text"], crit); ex[key] = js["answers"]["route"]["scores"]
    finally: larm.release()
    orig = json.load(open(src / "rerank-ruri-extra.json")); scored = len(ex)
    for k, v in orig.items(): ex.setdefault(k, v)
    shutil.copytree(src, dst)
    json.dump(rr, open(dst / "rerank-ruri.json", "w"), ensure_ascii=False); json.dump(ex, open(dst / "rerank-ruri-extra.json", "w"), ensure_ascii=False)
    meta = {"source": str(src), **binding(list(judged.values())),
            "rerank_keys_replaced": len(rr) - kept, "rerank_keys_kept_original": kept, "extra_rows_scored": scored, "extra_rows_kept_original": over}
    json.dump(meta, open(dst / "swap.json", "w"), ensure_ascii=False, indent=1); print(json.dumps(meta, ensure_ascii=False, indent=1))


def score_all(a):
    """This provider's score for every (text, card) of a corr dir (rerank-in.json rows, conversation excluded), so the bench
    can offer any card, e.g. a correction's right answer outside the frame. Texts over the limit are skipped. Resumable."""
    cfg = json.load(open(a.config)); rin = json.load(open(Path(a.corr) / "rerank-in.json")); cards = rin["cards"]
    texts = sorted({r["text"] for r in rin["rows"]}); crit = {c: card_doc(cards, c) for c in sorted(cards) if c != CONV}
    out = Path(a.out); done = json.load(open(out)) if out.exists() else {}; over = 0
    larm = Larm(cfg); larm.connect()
    try:
        for n, t in enumerate(texts, 1):
            if t in done: continue
            if limit_issue(t, crit): over += 1; continue
            js, _, _ = larm.judge(t, crit); done[t] = js["answers"]["route"]["scores"]
            if n % 100 == 0: json.dump(done, open(out, "w"), ensure_ascii=False); print(n, len(texts), file=sys.stderr)
    finally:
        larm.release(); json.dump(done, open(out, "w"), ensure_ascii=False)
    print(json.dumps({"texts": len(texts), "scored": len(done), "over_limit": over, "cards": len(crit)}))


def load_items(corr, variants=None, k=8):
    """dev/test items as best-v2 sees them (real items need a recorded past choice), plus variants; candidates = sr top-k
    tools (or every card with k='all'), described as the main router describes them to its reranker."""
    corr = Path(corr); db = sqlite3.connect(corr / "corr.db")
    utt = {i: json.loads(j) for i, j in db.execute("select id, utterance_json from bench_utterances")}
    lab = {i: (sp, json.loads(j)) for i, sp, st, j in db.execute("select utterance_id, split, status, label_json from bench_labels") if st == "reviewed"}
    def preds(name):
        out = {}
        for sp in ("dev", "test"):
            f = corr / "runs" / f"{name}-{sp}" / "predictions.jsonl"
            if f.exists():
                for l in open(f): d = json.loads(l); out[d["id"]] = sorted(d["probabilities"], key=lambda c: -d["probabilities"][c])
        return out
    sr, past = preds("sr-corr"), preds("past")
    cards = json.load(open(corr / "rerank-in.json"))["cards"]; doc = lambda c: card_doc(cards, c)
    vmeta = [json.loads(l) for l in open(variants)] if variants else []
    items = []
    for i, (sp, l) in lab.items():
        if i not in sr or i not in utt: continue
        kind = "variant" if i.startswith("var-") else "control" if i.startswith("ctl-") else "real"
        if kind == "control" or (kind == "real" and i not in past) or (kind == "variant" and not vmeta): continue
        cands = [c for c in (sr[i] if k != "all" else sorted(cards)) if c != CONV][: None if k == "all" else int(k)]
        it = dict(id=i, split=sp, kind=kind, text=utt[i]["text"], gold=CONV if l.get("none") else l["gold"], acc=sorted(l.get("acceptable") or []), cands=cands, criteria={c: doc(c) for c in cands})
        if kind == "variant":
            m = vmeta[int(i.split("-")[1])]; it["vtype"] = m["type"]
            it["src"] = next((x for x, (s, _) in lab.items() if x.startswith(m["source"]) and s == "test" and not x.startswith(("var-", "ctl-"))), None)
        items.append(it)
    return items


def run(a):
    cfg = json.load(open(a.config)); items = load_items(a.corr, a.variants, cfg.get("candidates", 8))
    try: done = {json.loads(l)["id"] for l in open(a.out)}
    except FileNotFoundError: done = set()
    todo = [x for x in items if x["id"] not in done][: a.limit or None]
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    larm = Larm(cfg); larm.connect()
    try:
        with open(a.out, "a") as f:
            for n, x in enumerate(todo, 1):
                api = larm.p["api"]
                rec = {k: x[k] for k in ("id", "split", "kind", "gold", "acc", "cands") if k in x} | {k: x[k] for k in ("vtype", "src") if k in x}
                rec |= {"scenario": api.get("scenario"), "network": api.get("network"), "precision": api.get("precision"), "candidates": cfg.get("candidates", 8)}
                issue = limit_issue(x["text"], x["criteria"])
                if issue: rec |= {"status": "not_sent", "reason": issue}
                else:
                    try:
                        js, ms, att = larm.judge(x["text"], x["criteria"]); ans = (js.get("answers") or {}).get("route") or {}
                        if not isinstance(ans.get("scores"), dict) or set(ans["scores"]) - set(x["criteria"]): raise LarmError("judge: response without per-candidate scores")
                        rec |= {"status": "ok", "choice": ans.get("choice"), "scores": ans["scores"], "probabilities": ans.get("probabilities"), "confidence": ans.get("confidence", js.get("confidence")),
                                "routing": js.get("routing"), "http_ms": round(ms, 1), "attempts": att}
                    except Rejected as e: rec |= {"status": "rejected", "reason": str(e)}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n"); f.flush()
                if n % 50 == 0: print(n, len(todo), file=sys.stderr)
    finally: larm.release()
    print(json.dumps({"judged": len(todo), "total": len(items)}))


def decide(r, rule):
    top = sorted(r["scores"].items(), key=lambda kv: -kv[1]); s2 = top[1][1] if len(top) > 1 else 0.0
    return top[0][0] if top[0][1] >= rule["minScore"] and top[0][1] - s2 >= rule["minMargin"] else CONV

ok = lambda r, d: d == r["gold"] or d in r["acc"]
pct = lambda xs: round(100 * sum(xs) / len(xs), 1) if xs else None

def q(xs, p):
    xs = sorted(xs); return round(xs[min(len(xs) - 1, int(p * (len(xs) - 1) + 0.5))], 1) if xs else None

def boot(xs, B=2000, seed=7):
    if not xs: return None
    rnd = random.Random(seed); s = sorted(sum(rnd.choice(xs) for _ in xs) / len(xs) for _ in range(B)); return [round(100 * s[int(.025 * B)], 1), round(100 * s[int(.975 * B) - 1], 1)]

def summary(rs, rule):
    j = [r for r in rs if r["status"] == "ok"]; d = {r["id"]: decide(r, rule) for r in j}
    conv = [r for r in j if r["gold"] == CONV]; tool = [r for r in j if r["gold"] != CONV]; hits = [ok(r, d[r["id"]]) for r in j]
    inf = [r["routing"].get("inference_ms") for r in j if isinstance(r.get("routing"), dict) and isinstance(r["routing"].get("inference_ms"), (int, float))]
    return {"n": len(rs), "judged": len(j), "not_judged": dict(Counter(r.get("reason") for r in rs if r["status"] != "ok")), "top1": pct(hits), "top1_ci": boot(hits),
            "misfire": pct([d[r["id"]] != CONV for r in conv]), "miss": pct([d[r["id"]] == CONV for r in tool]),
            "wrong_tool": pct([d[r["id"]] != CONV and not ok(r, d[r["id"]]) for r in tool]),
            "choice_top1_tools": pct([ok(r, r["choice"]) for r in tool]), "cand_recall_tools": pct([any(ok(r, c) for c in r["cands"]) for r in tool]),
            "http_ms_p50_p95": [q([r["http_ms"] for r in j], .5), q([r["http_ms"] for r in j], .95)], "inference_ms_p50_p95": [q(inf, .5), q(inf, .95)]}


def binding(rs):
    keys = {(r.get("scenario"), r.get("network"), r.get("precision"), r.get("candidates")) for r in rs if r["status"] == "ok"}
    if len(keys) != 1: sys.exit(f"records mix scenario/network/precision/candidates: {sorted(map(str, keys))}")
    return dict(zip(("scenario", "network", "precision", "candidates"), keys.pop()))


def fit(a):
    rs = [json.loads(l) for l in open(a.judged)]; dev = [r for r in rs if r["split"] == "dev" and r["kind"] == "real"]
    ok_dev = [r for r in dev if r["status"] == "ok"]
    if not ok_dev: sys.exit("no judged dev items")
    tops = sorted({max(r["scores"].values()) for r in ok_dev}); grid_s = [0.0] + tops + [tops[-1] + 1e-9]  # the last = always conversation
    best = None
    for s in grid_s:
        for m in (0.0, 0.02, 0.05, 0.1, 0.2, 0.3):
            rule = {"minScore": s, "minMargin": m}; sm = summary(dev, rule)
            key = (sm["top1"], -(sm["misfire"] or 0), s)
            if best is None or key > best[0]: best = (key, rule, sm)
    out = {**binding(dev), "fitted_on": "dev", **best[1], "dev": best[2], "note": "provider calibration is not fitted; this rule is the bench's dev-fitted fallback to conversation"}
    json.dump(out, open(a.out, "w"), ensure_ascii=False, indent=1); print(json.dumps(out, ensure_ascii=False, indent=1))


def evaluate(a):
    rs = [json.loads(l) for l in open(a.judged)]; rule = json.load(open(a.rule))
    test = [r for r in rs if r["split"] == "test" and r["kind"] == "real"]; var = [r for r in rs if r["kind"] == "variant"]
    b = binding(test + var)
    if any(rule.get(k) != v for k, v in b.items()): sys.exit(f"rule was fitted for {[rule.get(k) for k in b]}, records are {list(b.values())}")
    out = {**b, "rule": {k: rule[k] for k in ("minScore", "minMargin")}, "test": summary(test, rule)}
    src = {r["id"]: r for r in test if r["status"] == "ok"}
    def vstat(xs):
        xs = [x for x in xs if x["status"] == "ok" and x.get("src") in src]; so = [ok(src[x["src"]], decide(src[x["src"]], rule)) for x in xs]
        return {"n": len(xs), "top1": pct([ok(x, decide(x, rule)) for x in xs]), "source_top1": pct(so), "broke": pct([not ok(x, decide(x, rule)) for x, s in zip(xs, so) if s]),
                "to_conversation": pct([decide(x, rule) == CONV for x in xs])}
    if var: out["variants"] = {"all": vstat(var), **{t: vstat([x for x in var if x.get("vtype") == t]) for t in sorted({x.get("vtype") for x in var})}}
    print(json.dumps(out, ensure_ascii=False, indent=1))


def probe(a):
    larm = Larm(json.load(open(a.config))); larm.connect()
    try:
        info = {"model": larm.p["model"], "api": larm.p["api"], "declared_capability": larm.declared.get("capability")}
        if a.text:
            js, ms, att = larm.judge(a.text, {"weather.forecast": "今日・明日・明後日の天気を調べる", "music.create": "音楽や効果音を新しく作る"})
            info["sample"] = {"http_ms": round(ms, 1), "attempts": att, "answers": js.get("answers"), "confidence": js.get("confidence"), "routing": js.get("routing")}
        print(json.dumps(info, ensure_ascii=False, indent=1))
    finally: larm.release()


def selftest():
    import tempfile, threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    S = {"gets": 0, "claims": 0, "judge": 0, "deleted": 0, "log": [], "deny": {"Bearer pt1"}}
    API = {"scenario": "sc-1", "network": "net-1", "precision": "fp32", "limits": {}}
    class H(BaseHTTPRequestHandler):
        def log_message(self, *x): pass
        def send(self, st, js):
            b = json.dumps(js).encode(); self.send_response(st); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def auth(self): return self.headers.get("Authorization")
        def do_GET(self):
            assert self.auth() == "Bearer ctl"
            if self.path.startswith("/v3/agent-profiles?profile=p1"):
                return self.send(200, {"contractVersion": "agent-connection.v3", "requestedProfile": "p1", "catalogRevision": "r1",
                                       "profiles": [{"providers": [{"name": "llm", "model": "x"}, {"name": "ctx", "capability": "decision.ctx", "model": "m", "api": API}]}]})
            S["gets"] += 1; ready = S["gets"] >= 2
            self.send(200, {"id": "c1", "status": "ready" if ready else "pending", "providers": [{"name": "ctx", "readiness": "ready" if ready else "starting", "claimable": ready}]})
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/v1/agent-connections":
                assert self.auth() == "Bearer ctl" and self.headers.get("Idempotency-Key") and body["providers"] == ["ctx"] and body["expectedCatalogRevision"] == "r1", body
                return self.send(202, {"id": "c1", "status": "pending", "providers": [{"name": "ctx", "readiness": "starting"}]})
            if self.path == "/v1/agent-connections/c1/claim":
                assert self.auth() == "Bearer ctl" and not self.headers.get("Idempotency-Key") and body == {"format": "openai-provider-v1", "providers": ["ctx"]}, body
                S["claims"] += 1
                return self.send(200, {"id": "c1", "status": "ready", "providers": [{"name": "other", "endpoint": "http://evil.example/x", "model": "m", "credential": {"token": "no"}},
                                       {"name": "ctx", "endpoint": f"http://127.0.0.1:{self.server.server_port}/v1/decisions", "model": "m", "credential": {"token": f"pt{S['claims']}"}, "api": API}]})
            if self.path == "/v1/decisions":
                S["judge"] += 1; S["log"].append(self.auth()); assert self.auth() != "Bearer ctl"
                assert body["scenario"] == "sc-1" and body["network"] == "net-1" and set(body["state"]) == {"text"}, body
                if S["judge"] == 1: return self.send(503, {"error": {"code": "resource_exhausted"}})
                if self.auth() in S["deny"]: return self.send(401, {"error": {"code": "credential_expired"}})
                if body["state"]["text"] == "bad": return self.send(400, {"error": {"code": "pair_over_tokens"}})
                sc = {c: (0.9 if c == "weather.forecast" else 0.1) for c in body["questions"]["route"]["criteria"]}
                return self.send(200, {"answers": {"route": {"choice": max(sc, key=sc.get), "scores": sc, "probabilities": sc}}, "confidence": 0.8, "routing": {"inference_ms": 12, "calibration_status": "provisional-unfitted"}})
        def do_DELETE(self):
            assert self.auth() == "Bearer ctl" and self.path == "/v1/agent-connections/c1"; S["deleted"] += 1; self.send_response(204); self.end_headers()
    srv = HTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ["LARM_API_TOKEN"] = "ctl"  # this process only
    cfg = {"url": f"http://127.0.0.1:{srv.server_port}", "profile": "p1", "provider": "ctx", "capability": "decision.ctx", "audience": "aud", "client": "bench", "retry": {"baseMs": 1, "maxAttempts": 4}}
    larm = Larm(cfg); larm.connect(); assert larm.p["token"] == "pt1" and S["gets"] == 2
    js, ms, att = larm.judge("明日の天気は？", {"weather.forecast": "天気", "music.create": "音楽"})  # 503 -> wait, 401 -> re-claim, then 200
    assert att == 3 and js["answers"]["route"]["choice"] == "weather.forecast" and S["claims"] == 2 and S["log"] == ["Bearer pt1", "Bearer pt1", "Bearer pt2"], (att, S)
    try: larm.judge("bad", {"weather.forecast": "天気"}); raise AssertionError("400 must raise")
    except Rejected as e: assert str(e) == "pair_over_tokens"
    S["deny"] = {"Bearer pt2", "Bearer pt3"}  # re-claim does not help -> release and connect again with the same profile
    js, ms, att = larm.judge("明日の天気は？", {"weather.forecast": "天気"})
    assert att == 3 and S["deleted"] == 1 and larm.p["token"] == "pt4" and S["log"][-3:] == ["Bearer pt2", "Bearer pt3", "Bearer pt4"], (att, S)
    larm.p["expires"] = time.time() + 30  # about to expire -> replaced before the call
    larm.judge("明日の天気は？", {"weather.forecast": "天気"}); assert S["deleted"] == 2 and larm.p["token"] == "pt5", S
    larm.release(); assert S["deleted"] == 3 and larm.conn is None
    assert limit_issue("あ" * 401, {"a": "b"}) == "text_over_limit" and limit_issue("x", {"__proto__": "b"}) == "bad_candidate_id" and limit_issue("x", {}) == "no_candidates"
    assert limit_issue("x", {f"t{i}": "d" for i in range(129)}) == "too_many_candidates" and limit_issue("x", {"a": "d" * 4097}) == "description_over_limit" and limit_issue("x", {"a": "d"}) is None
    mk = lambda i, sp, gold, sc, **k: {"id": i, "split": sp, "kind": "real", "gold": gold, "acc": [], "cands": list(sc), "status": "ok", "scores": sc, "choice": max(sc, key=sc.get),
                                       "scenario": "sc-1", "network": "net-1", "precision": "fp32", "candidates": 8, "http_ms": 20.0, "routing": {"inference_ms": 10}, **k}
    rows = [mk("d1", "dev", "w", {"w": .9, "m": .1}), mk("d2", "dev", CONV, {"w": .3, "m": .2}), mk("d3", "dev", "m", {"w": .2, "m": .8}),
            mk("t1", "test", "w", {"w": .95, "m": .1}), mk("t2", "test", CONV, {"w": .25, "m": .1}),
            mk("var-0", "test", "w", {"w": .4, "m": .1}, kind="variant", vtype="casual", src="t1"),
            {"id": "t3", "split": "test", "kind": "real", "gold": "w", "acc": [], "cands": ["w"], "status": "not_sent", "reason": "text_over_limit", "scenario": "sc-1", "network": "net-1", "precision": "fp32", "candidates": 8}]
    d = tempfile.mkdtemp(); jp, rp = os.path.join(d, "j.jsonl"), os.path.join(d, "rule.json")
    open(jp, "w").write("".join(json.dumps(r) + "\n" for r in rows))
    import io, contextlib
    with contextlib.redirect_stdout(io.StringIO()): fit(argparse.Namespace(judged=jp, out=rp))
    rule = json.load(open(rp)); assert rule["dev"]["top1"] == 100.0 and rule["network"] == "net-1" and 0.3 < rule["minScore"] <= 0.8, rule
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): evaluate(argparse.Namespace(judged=jp, rule=rp))
    ev = json.loads(buf.getvalue()); t = ev["test"]
    assert (t["n"], t["judged"], t["not_judged"], t["top1"], t["misfire"], t["miss"]) == (3, 2, {"text_over_limit": 1}, 100.0, 0.0, 0.0), t
    assert ev["variants"]["casual"]["broke"] == 100.0 and ev["variants"]["all"]["to_conversation"] == 100.0, ev["variants"]
    rule["network"] = "net-2"; json.dump(rule, open(rp, "w"))
    try:
        with contextlib.redirect_stdout(io.StringIO()): evaluate(argparse.Namespace(judged=jp, rule=rp))
        raise AssertionError("a rule for another network must be refused")
    except SystemExit: pass
    print("selftest ok")


if __name__ == "__main__":
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest="cmd", required=True)
    x = sp.add_parser("probe"); x.add_argument("--config", required=True); x.add_argument("--text")
    x = sp.add_parser("run"); x.add_argument("--config", required=True); x.add_argument("--corr", required=True); x.add_argument("--variants"); x.add_argument("--out", required=True); x.add_argument("--limit", type=int)
    x = sp.add_parser("swap"); x.add_argument("--config", required=True); x.add_argument("--corr", required=True); x.add_argument("--variants"); x.add_argument("--judged", required=True); x.add_argument("--out", required=True)
    x = sp.add_parser("score-all"); x.add_argument("--config", required=True); x.add_argument("--corr", required=True); x.add_argument("--out", required=True)
    x = sp.add_parser("fit"); x.add_argument("--judged", required=True); x.add_argument("--out", required=True)
    x = sp.add_parser("eval"); x.add_argument("--judged", required=True); x.add_argument("--rule", required=True)
    sp.add_parser("selftest"); a = p.parse_args()
    {"probe": probe, "run": run, "swap": swap, "score-all": score_all, "fit": fit, "eval": evaluate, "selftest": lambda _: selftest()}[a.cmd](a)
