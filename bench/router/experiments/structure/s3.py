"""S3 of plan §8: a cloud LLM returns the structure of an utterance (requests, targets, inputs, order). It does not
choose tools: the router routes each request part afterwards (structure.ts). Needs the `anthropic` package:
  uv run --no-project --with anthropic==2.4.0 python bench/router/experiments/structure/s3.py <items.jsonl> <out.jsonl>
Settings come from the environment, else from the repo-root .env (already-set variables win): ANTHROPIC_API_KEY,
ROUTER_LLM_MODEL, ROUTER_LLM_EFFORT (optional). The utterance text (and the previous agent turn) is sent to the API.
Rerunning the same command resumes: items already in <out.jsonl> are skipped. No sampling parameters are sent."""
import json, os, re, sys, time
from pathlib import Path
import anthropic

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").exists())
SYSTEM = """あなたは利用者の発言の構造を判断する。担当（ツール）は選ばない。JSON だけを返す（説明や前置きは書かない）。

形: {"requests":[{"text":"…","target":"…","inputs":["…"],"after":[0]}]}
- requests: 利用者がこの発言で、エージェントに今してほしいこと（依頼）。依頼1つに要素1つ。
- text: 依頼の部分。発言の文字列からそのまま抜き出す（言い換えない、足さない）。
- target: その依頼で作る・操作する物。発言の文字列から抜き出す。なければ null。
- inputs: その依頼が参照・材料として使う物（「この写真」「さっきの表」「それ」など）。作る物ではない。発言の文字列から抜き出す。なければ []。
- after: 先に済ませる依頼の番号（0 から）。前の依頼の結果を使うときや、順番を指定されたとき。そうでなければ []。
- 依頼の中身として出てくるだけの動作は、別の依頼にしない（「動画を撮る予定をメモして」はメモする依頼1つ）。
- 感想・雑談・エージェントへの質問だけの発言は、依頼がない（requests は []）。
- 種類が同じ物を2つ頼まれたら、2つの依頼にする。

例:
発言: さっきの表をグラフにして
{"requests":[{"text":"グラフにして","target":"グラフ","inputs":["さっきの表"],"after":[]}]}
発言: レシピを検索して、材料を買い物リストに追加して
{"requests":[{"text":"レシピを検索して","target":"レシピ","inputs":[],"after":[]},{"text":"材料を買い物リストに追加して","target":"買い物リスト","inputs":["材料"],"after":[0]}]}
発言: 今日はいい天気だね
{"requests":[]}"""


def load_env(path=ROOT / ".env"):
    try: lines = path.read_text().splitlines()
    except FileNotFoundError: return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1); k = k.removeprefix("export ").strip(); v = v.strip().strip("\"'")
        if k and v and k not in os.environ: os.environ[k] = v


def valid(text, s):
    """The structure contract (plan §10 M3b): spans are parts of the utterance, after names earlier requests, ≤ 8 requests."""
    rs = s.get("requests") if isinstance(s, dict) else None
    if not isinstance(rs, list) or len(rs) > 8: return False
    for i, r in enumerate(rs):
        if not isinstance(r, dict) or not isinstance(r.get("text"), str) or not r["text"] or r["text"] not in text: return False
        t = r.get("target")
        if t is not None and (not isinstance(t, str) or (t and t not in text)): return False
        ins = r.get("inputs", [])
        if not isinstance(ins, list) or any(not isinstance(x, str) or x not in text for x in ins): return False
        af = r.get("after", [])
        if not isinstance(af, list) or any(not isinstance(a, int) or a < 0 or a >= i for a in af): return False
    return True


def main(inp, outp):
    load_env()
    model = os.environ.get("ROUTER_LLM_MODEL") or sys.exit("set ROUTER_LLM_MODEL in .env")
    if not os.environ.get("ANTHROPIC_API_KEY"): sys.exit("set ANTHROPIC_API_KEY in .env")
    effort = os.environ.get("ROUTER_LLM_EFFORT") or None
    client = anthropic.Anthropic(max_retries=5)
    done = set()
    if os.path.exists(outp): done = {json.loads(l)["id"] for l in open(outp) if l.strip()}
    items = [json.loads(l) for l in open(inp) if l.strip()]
    with open(outp, "a") as out:
        for it in items:
            if it["id"] in done: continue
            # The utterance up to the router's embedding head (2000 chars); the previous agent turn up to 400 chars.
            user = (f"直前のエージェントの発言: {it['previousAgent'][:400]}\n" if it.get("previousAgent") else "") + f"発言: {it['text'][:2000]}"
            kw = dict(model=model, max_tokens=2048, system=SYSTEM, messages=[{"role": "user", "content": user}])
            if effort: kw["output_config"] = {"effort": effort}
            t0 = time.time()
            try: r = client.messages.create(**kw)
            except anthropic.AuthenticationError: sys.exit("Anthropic API: authentication failed (check ANTHROPIC_API_KEY)")
            except anthropic.NotFoundError as e: sys.exit(f"Anthropic API: not found (check ROUTER_LLM_MODEL): {e.message}")
            except anthropic.BadRequestError as e: sys.exit(f"Anthropic API: bad request: {e.message}")
            except (anthropic.RateLimitError, anthropic.APIStatusError, anthropic.APIConnectionError) as e:
                sys.exit(f"Anthropic API: {type(e).__name__}; rerun the same command to resume")
            content = "".join(b.text for b in r.content if b.type == "text").strip()
            m = re.search(r"\{.*\}", content, re.S)
            try: s = json.loads(m.group(0)) if m else None
            except json.JSONDecodeError: s = None
            u = r.usage
            prompt = (u.input_tokens or 0) + (u.cache_creation_input_tokens or 0) + (u.cache_read_input_tokens or 0)
            out.write(json.dumps(dict(id=it["id"], structure=s if s is not None and valid(it["text"], s) else None,
                                      parsed=s is not None, prompt=prompt, completion=u.output_tokens, finish=r.stop_reason,
                                      seconds=round(time.time() - t0, 3), model=model, effort=effort or "default"), ensure_ascii=False) + "\n")
            out.flush()
    print(json.dumps(dict(out=outp, items=len(items))))


if __name__ == "__main__": main(*sys.argv[1:3])
