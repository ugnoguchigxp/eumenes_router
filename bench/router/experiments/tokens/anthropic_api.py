"""Anthropic Messages API backend for tokens.py (`--provider anthropic`). Needs the `anthropic` package, e.g.
  uv run --no-project --with anthropic==2.4.0 python bench/router/experiments/tokens/tokens.py verify --provider anthropic ...
Settings come from the environment, else from the repo-root .env (already-set variables win):
  ANTHROPIC_API_KEY   required
  ROUTER_LLM_MODEL    model id (--model overrides)
  ROUTER_LLM_EFFORT   optional: low | medium | high | xhigh | max (--effort overrides; unset = the API default)
This sends the utterance text (and any --system-file) to the Anthropic API."""
import os, sys, time
from pathlib import Path
import anthropic

ENV = Path(__file__).resolve().parents[4] / ".env"


def load_env(path=ENV):
    try: lines = path.read_text().splitlines()
    except FileNotFoundError: return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1); k = k.removeprefix("export ").strip(); v = v.strip().strip("\"'")
        if k and v and k not in os.environ: os.environ[k] = v


class Backend:
    def __init__(self, model=None, effort=None):
        load_env()
        self.model = model or os.environ.get("ROUTER_LLM_MODEL")
        if not self.model: sys.exit("set ROUTER_LLM_MODEL in .env or pass --model")
        if not os.environ.get("ANTHROPIC_API_KEY"): sys.exit("set ANTHROPIC_API_KEY in .env")
        self.effort = effort or os.environ.get("ROUTER_LLM_EFFORT") or None
        self.client = anthropic.Anthropic(max_retries=5)

    def call(self, messages, max_tokens):
        """Same record shape as tokens.call(). System messages go to `system`; no sampling parameters are sent.
        API errors stop the run (nothing is written for the failed call), so rerunning the same command resumes."""
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        msgs = [m for m in messages if m["role"] != "system"]
        if not msgs or msgs[0]["role"] != "user": raise ValueError("the first non-system message must be a user turn")
        kw = {"model": self.model, "max_tokens": max_tokens, "messages": msgs}
        if system: kw["system"] = system
        if self.effort: kw["output_config"] = {"effort": self.effort}
        t0 = time.time()
        try: r = self.client.messages.create(**kw)
        except anthropic.AuthenticationError: sys.exit("Anthropic API: authentication failed (check ANTHROPIC_API_KEY)")
        except anthropic.PermissionDeniedError as e: sys.exit(f"Anthropic API: permission denied: {e.message}")
        except anthropic.NotFoundError as e: sys.exit(f"Anthropic API: not found (check ROUTER_LLM_MODEL): {e.message}")
        except anthropic.BadRequestError as e: sys.exit(f"Anthropic API: bad request: {e.message}")
        except anthropic.RateLimitError: sys.exit("Anthropic API: still rate limited after retries; rerun the same command to resume")
        except anthropic.APIStatusError as e: sys.exit(f"Anthropic API: HTTP {e.status_code}; rerun the same command to resume")
        except anthropic.APIConnectionError: sys.exit("Anthropic API: connection failed; rerun the same command to resume")
        dt = time.time() - t0
        u = r.usage; d = getattr(u, "output_tokens_details", None)
        rt = d.get("thinking_tokens") if isinstance(d, dict) else getattr(d, "thinking_tokens", None)
        prompt = (u.input_tokens or 0) + (u.cache_creation_input_tokens or 0) + (u.cache_read_input_tokens or 0)
        return {"prompt": prompt, "completion": u.output_tokens, "reasoning": rt, "reasoning_src": "usage" if rt is not None else "unreported",
                "finish": r.stop_reason, "seconds": round(dt, 3), "effort": self.effort or "default",
                "_content": "".join(b.text for b in r.content if b.type == "text").strip()}
