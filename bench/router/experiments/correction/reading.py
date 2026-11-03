#!/usr/bin/env python3
"""Hiragana reading of each text (pykakasi, pure local). Preprocessing for the variant-aware correction table
(bench/router/variant-table.ts): there is no Japanese reader in the TS router, so readings are computed here.
  python reading.py <in.json: [text, ...]> <out.json: {text: reading}>"""
import json, sys, unicodedata
import pykakasi
k = pykakasi.kakasi()
texts = json.load(open(sys.argv[1]))
out = {t: ''.join(x['hira'] for x in k.convert(unicodedata.normalize('NFKC', t))) for t in texts}
json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False)
