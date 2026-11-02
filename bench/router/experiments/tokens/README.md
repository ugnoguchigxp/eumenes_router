# LLM token accounting (local endpoint only)

The export `eumenes-20261102-2f8b03c7` has no token usage, and there are no LARM logs: choices only carry `route: "llm"`. This tool measures token use per call on the user's machine instead.

```bash
# 1. On the AI MAX 395+ PC, start an OpenAI-compatible server
#    (e.g. llama-server -m <gguf> --port 8080 --reasoning-format deepseek / LM Studio :1234 / Ollama :11434)
# 2. Cascade report with perTest (the deferBefore/deferAfter flags)
bench/router/experiments/correction/run.sh          # -> out/correct-*/report.json
# 3. Call the LLM on every test item (resumable; only calls localhost / LAN)
python3 bench/router/experiments/tokens/tokens.py run --report out/correct-X/report.json \
  --export data/export/eumenes-20261102-2f8b03c7 --url http://127.0.0.1:8080/v1 --model <name> \
  [--system-file eumenes-system-prompt.txt] --out out/tokens-<model>.jsonl
# 4. Aggregate: per-call p50/p95/mean with CIs, plus % saved for each cascade config (all items vs deferred only)
python3 bench/router/experiments/tokens/tokens.py stats --calls out/tokens-<model>.jsonl --report out/correct-X/report.json
python3 bench/router/experiments/tokens/tokens.py selftest
```

Where the reasoning-token count comes from, in priority order:
1. `usage.completion_tokens_details.reasoning_tokens`
2. `reasoning_content` / `reasoning`, tokenized with `/tokenize`
3. `<think>` content in the reply
4. A character-count estimate (marked with `:est`)

The default system prompt is a minimal stand-in. For tokens comparable to the real old LLM route, pass the Eumenes system prompt and tool definitions with `--system-file`.
