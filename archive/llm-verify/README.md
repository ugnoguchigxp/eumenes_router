# LLM token accounting (local endpoint or Anthropic API)

> **ARCHIVED (2026-11-03).** Verified and not adopted: LLM verification of best-v2's deferred turns. Conclusion and numbers: `archive/README.md`, `docs/reports/router_verifications_2026-11-03.md`. Measured data (no utterance text): `results/2026-11-03/`. Moved from `bench/router/experiments/tokens/`.

The export `eumenes-20261102-2f8b03c7` has no token usage, and there are no LARM logs: choices only carry `route: "llm"`. This tool measures token use per call on the user's machine instead.

```bash
# 1. On the AI MAX 395+ PC, start an OpenAI-compatible server
#    (e.g. llama-server -m <gguf> --port 8080 --reasoning-format deepseek / LM Studio :1234 / Ollama :11434)
# 2. Cascade report with perTest (the deferBefore/deferAfter flags)
bench/router/experiments/correction/run.sh          # -> out/correct-*/report.json
# 3. Call the LLM on every test item (resumable; only calls localhost / LAN)
python3 archive/llm-verify/tokens.py run --report out/correct-X/report.json \
  --export data/export/eumenes-20261102-2f8b03c7 --url http://127.0.0.1:8080/v1 --model <name> \
  [--system-file eumenes-system-prompt.txt] --out out/tokens-<model>.jsonl
# 4. Aggregate: per-call p50/p95/mean with CIs, plus % saved for each cascade config (all items vs deferred only)
python3 archive/llm-verify/tokens.py stats --calls out/tokens-<model>.jsonl --report out/correct-X/report.json
python3 archive/llm-verify/tokens.py selftest
```

Where the reasoning-token count comes from, in priority order:
1. `usage.completion_tokens_details.reasoning_tokens`
2. `reasoning_content` / `reasoning`, tokenized with `/tokenize`
3. `<think>` content in the reply
4. A character-count estimate (marked with `:est`)

## Anthropic API (`--provider anthropic`)

Copy `.env.example` to `.env` at the repo root and fill in `ANTHROPIC_API_KEY` and `ROUTER_LLM_MODEL` (`ROUTER_LLM_EFFORT` is optional). The `anthropic` package is only needed for this provider:

```bash
uv run --no-project --with anthropic==2.4.0 python archive/llm-verify/tokens.py verify --provider anthropic \
  --items <verify-items.jsonl> [--effort low] --out out/verify-<model>.jsonl
uv run --no-project --with anthropic==2.4.0 python archive/llm-verify/tokens.py selftest   # mock only, no API call
```

`verify` has two protocols over the top `--max-cands` candidates. `--mode yesno` (default) makes one call per candidate down the ranking and stops at the first yes. `--mode list` makes one call with the numbered candidates, and the answer `0` means none of them. The utterance is cut to `--max-chars` (default 400, the same cut as the router's ruri input). `verify-stats --items <verify-items.jsonl>` adds the decisions by what an all-no item falls back to (ask / ranker top-1 / recorded past LLM) and same-item references.

This sends the utterance text to the Anthropic API. No sampling parameters are sent; thinking uses the model default, and `--effort` sets `output_config.effort`. Thinking tokens come from `usage.output_tokens_details.thinking_tokens`. When the response has no such field, `reasoning_src` is `unreported` and the thinking stays counted inside `completion`. An API error stops the run without writing the failed call, so rerunning the same command resumes.

The default system prompt is a minimal stand-in. For tokens comparable to the real old LLM route, pass the Eumenes system prompt and tool definitions with `--system-file`.
