"""S1 of plan §8 (M3c candidate 4): the structure of an utterance from a Japanese dependency parse plus rules.
  python s1.py <spacy model> <items.jsonl> <out.jsonl> [--half dev] [--show]
The parser runs in this process (no server). Output rows as s3.py's: {id, structure | null, ms}. A structure is
{"requests": [{text, target, inputs, after}]}: spans are parts of the utterance. null = no structure found (route the
whole utterance as today); requests [] = a plain comment or question (the conversation).
Rules (made on the dev half only):
- A request is a predicate in the main clause chain (the sentence root, or a te-form / -tara verb followed by a comma,
  the sentence end or から) whose sentence ends in a request form (て, てください, てほしい, お願い, たい, ほしい, れる？, …),
  and that has an object (を, も, が) or is an action verb. Verbs inside a noun phrase (画像を作るタスク) are not requests.
- A clause without such a predicate (「さっきの曲に合わせて」, 「この画像の感じで」) adds its references to the last request.
- Objects joined by と or も…も before one predicate are separate requests (the first borrows the predicate later).
- References: demonstrative noun phrases (この・その・あの・さっきの + noun, それ・これ・そこ) that are not the request's
  object, the arguments of 合う・合わせる・似合う・ぴったり・ふさわしい, Xの雰囲気・イメージ・世界観・テイスト・感じ, Xをもとに.
- A later sentence starts requests of its own only after a connector (あと・それと・ついでに・次に…); otherwise its
  predicates are details of the request before it.
- No request form and a comment/question ending (ね, よね, かな, の？, だった, ありがとう, と思う) → requests []."""
import json, re, sys, time

DEM_DET = {'この', 'その', 'あの'}
DEM_PRON = {'それ', 'これ', 'そこ', 'あれ'}
EARLIER = {'さっき', '先ほど', '先程', '前'}
FIT = {'合う', '合わせる', '似合う', '沿う', 'ぴったり', 'ふさわしい'}
LIKE = {'雰囲気', 'イメージ', '世界観', 'テイスト', '感じ', '調子'}
MEANS = {'使う', '用いる', '参考'}  # 「Xを使って、」 is the means of the request, not a request
ACTION = {'再生', '流す', '開く', '調べる', '教える', '見せる', 'スクリーンショット', '計算', '撮影', '読む', '読み取る', '登録', 'まとめる', '覚える', '頼む', '探す'}
REQ_TAIL = re.compile(r'^(て|で)?(ください|下さい|ほしい|欲しい|もらえ|くれ|おいて|みて|ちょうだい|ね)?.{0,12}$')
CONNECT = re.compile(r'^(あと|それと|それから|ついでに|次に|最後に|別件|それとは|また|さらに|あわせて|併せて)')
COMMENT = re.compile(r'(ね|よね|かな|だった|ありがとう|と思う|の[？?]|のか)[。！？!?\s]*$')


def span(doc, a, b):
    return doc.text[doc[a].idx: doc[b].idx + len(doc[b].text)]


def np_span(n, keep=lambda t: True):
    """The noun phrase ending at n: n and the tokens of its left subtree (not crossing case markers before them)."""
    left = [t for t in n.subtree if t.i <= n.i and t.dep_ not in ('case', 'punct') and keep(t)]
    start = min([t.i for t in left] + [n.i])
    # do not start on a dangling particle
    return start, n.i


def target_span(n):
    """The object's own words: compounds and short noun modifiers, not clauses or demonstratives."""
    toks = [t for t in n.lefts if t.dep_ == 'compound']
    start = min([t.i for t in toks] + [n.i])
    return start, n.i


def chunk_end(doc, v):
    """The predicate with its following auxiliaries and particles, up to punctuation."""
    j = v.i
    while j + 1 < len(doc) and doc[j + 1].text not in ('、', '。') and (
            doc[j + 1].pos_ in ('AUX', 'SCONJ', 'PART', 'ADP') and doc[j + 1].dep_ in ('aux', 'mark', 'fixed', 'cop', 'case')
            or doc[j + 1].pos_ == 'VERB' and doc[j + 1].dep_ == 'fixed'):  # 〜てもらう・〜ておく・〜てみる
        j += 1
    return j


def is_te(doc, v):
    nxt = [t for t in doc[v.i + 1: v.i + 4]]
    while nxt and nxt[0].text in ('し', 'さ') and nxt[0].pos_ == 'AUX':  # 計算して・再生して
        nxt = nxt[1:]
    return bool(nxt) and (nxt[0].text in ('て', 'で') and nxt[0].pos_ == 'SCONJ' or nxt[0].text in ('たら', 'てから'))


def boundary_after(doc, v):
    """A te/tara form ends a clause when a comma, the sentence end or から(、) follows its auxiliaries."""
    j = chunk_end(doc, v)
    return j + 1 >= len(doc) or doc[j + 1].text in ('、', '。', '！', '？', '!', '?') or doc[j].text == 'から'


def in_noun_phrase(v):
    """A verb inside a noun phrase (relative clause) unless it is a clause-final te-form."""
    t = v
    while t.head.i != t.i:
        if t.dep_ in ('acl', 'nmod', 'obj', 'nsubj', 'obl') and t.head.pos_ in ('NOUN', 'PROPN', 'PRON'):
            return True
        t = t.head
    return False


def predicates(doc):
    out = []
    for s in doc.sents:
        for v in s:
            if v.pos_ not in ('VERB', 'ADJ', 'NOUN', 'AUX'):
                continue
            verbal = v.pos_ == 'VERB' or v.lemma_ in ('お願い', 'ほしい', '欲しい') or (v.pos_ == 'ADJ' and v.lemma_ in ('ほしい', '欲しい'))
            if not verbal:
                continue
            # a te-form with its own object ends a clause even without a comma (調べてタイマーをかけて), unless inside a noun phrase
            te_clause = is_te(doc, v) and (boundary_after(doc, v) or (objects(v) and not in_noun_phrase(v)))
            if v.dep_ == 'ROOT' or te_clause:
                if v.dep_ != 'ROOT' and in_noun_phrase(v) and not te_clause:
                    continue
                if v.dep_ != 'ROOT' and in_noun_phrase(v) and v.dep_ == 'acl' and not is_te(doc, v):
                    continue
                out.append((s, v))
    return out


def objects(v):
    obs = [c for c in v.children if c.dep_ == 'obj']
    obs += [c for c in v.children if c.dep_ in ('nsubj', 'obl') and any(k.text in ('も', 'が') and k.dep_ == 'case' for k in c.children) and c.pos_ in ('NOUN', 'PROPN')]
    return sorted(obs, key=lambda t: t.i)


def coordinated(o):
    """Nouns joined to the object by と (X と Y を) or by も (X も Y も)."""
    return [c for c in o.children if c.pos_ in ('NOUN', 'PROPN') and c.i < o.i and any(k.text in ('と', 'も') and k.dep_ == 'case' for k in c.children) and c.dep_ in ('nmod', 'conj', 'nsubj', 'obl')]


def references(doc, scope, exclude):
    """Demonstrative noun phrases and fit/like/basis arguments inside scope (token set), not in exclude."""
    refs = []
    for t in scope:
        if t.i in exclude:
            continue
        if t.pos_ == 'PRON' and t.text in DEM_PRON:
            refs.append((t.i, t.i))
        elif t.pos_ in ('NOUN', 'PROPN'):
            dets = [c for c in t.lefts if (c.dep_ == 'det' and c.text in DEM_DET) or (c.text in EARLIER)]
            # さっき inside a relative clause on the noun (さっき作った曲), not through an inner noun (さっきの画像に…のBGM)
            sub_earlier = any(x.text in EARLIER for c in t.lefts if c.dep_ == 'acl' for x in c.subtree)
            fit_arg = t.head.lemma_ in FIT and t.dep_ in ('obl', 'nmod', 'iobj', 'obj') and any(k.text == 'に' for k in t.children)
            like_arg = t.head.text in LIKE and t.dep_ == 'nmod'
            basis = any(c.text == 'もと' for c in t.head.children) if t.dep_ == 'obj' else False
            if dets or sub_earlier or fit_arg or like_arg:
                a, b = np_span(t)
                refs.append((a, b))
    # keep the outermost spans
    refs = sorted(set(refs))
    out = []
    for a, b in refs:
        if any(a >= x and b <= y and (a, b) != (x, y) for x, y in refs):
            continue
        out.append((a, b))
    return out


def request_form(doc, s, v):
    tail = re.sub(r'^(し|さ)', '', doc.text[doc[v.i].idx + len(doc[v.i].text): s.end_char].strip())
    if COMMENT.search(s.text) and not re.match(r'^(て|で)(ください|ほしい|もらえ|くれ)', tail):
        return False
    if v.lemma_ in ('お願い', 'ほしい', '欲しい') or v.text.startswith('願い'):
        return True
    if re.match(r'^(て|で)', tail) or re.match(r'^(たい|ます|たら|てから)', tail):
        return True
    if re.match(r'^(れる|える|せる|ける)?[？?]', tail) or re.search(r'(れる|える|ける|せる)$', v.text) and re.match(r'^[？?]', tail):
        return True
    if re.match(r'^たり', tail):
        return True
    if v.lemma_ == 'ある' and re.match(r'^と(いい|良い)', tail):
        return True
    return False


def analyze(doc):
    preds = predicates(doc)
    reqs = []  # (verb, object or None)
    loose = []  # predicates that are not requests (their references go to the last request)
    for s, v in preds:
        obs = objects(v)
        last_in_sentence = v.dep_ == 'ROOT'
        form = request_form(doc, s, v) if last_in_sentence else True
        if not form:
            loose.append(v); continue
        if (not obs and v.lemma_ in FIT) or v.lemma_ in MEANS or any(c.text == '参考' for c in v.children):
            loose.append(v); continue
        if not obs and v.lemma_ not in ACTION and not (v.lemma_ in ('お願い',) ):
            # a te-chain verb without an object that is not an action: a modifier clause
            if v.dep_ != 'ROOT':
                loose.append(v); continue
        reqs.append((s, v, obs))
    sentences = list(doc.sents)
    # a later sentence starts requests of its own only after a connector (あと・それと・ついでに・次に…); otherwise it gives
    # details of the request before it (「新しい図を作りたいです。図の名前は…にして、…画面を開いてください」)
    first = min((sentences.index(s) for s, _, _ in reqs), default=None)
    if first is not None:
        keep = []
        for s, v, obs in reqs:
            k = sentences.index(s)
            if k > first and not CONNECT.match(s.text.strip()):
                loose.append(v)
            else:
                keep.append((s, v, obs))
        reqs = keep
    for s in sentences:
        r = s.root
        if r.pos_ in ('NOUN', 'PROPN') and any(c.text == 'も' and c.dep_ == 'case' for c in r.children) and re.search(r'(あと|ついでに|それと)', s.text):
            reqs.append((s, r, [r]))
    reqs.sort(key=lambda x: x[1].i)
    if not reqs:
        whole = doc.text.strip()
        return {'requests': []} if COMMENT.search(whole) or whole.endswith(('ありがとう', 'ね', 'な')) else None
    out = []
    for s, v, obs in reqs:
        end = chunk_end(doc, v)
        main = obs[-1] if obs else None
        heads = [main] if main is not None else [None]
        if main is not None:
            heads = coordinated(main) + [main]
        for h in heads:
            if h is None:
                a, b = v.i, end
                target = None
            elif h.i == v.i:
                ta, tb = target_span(h)
                a, b, target = ta, chunk_end(doc, h), span(doc, ta, tb)
            else:
                ta, tb = target_span(h)
                a, b = ta, end if h is main else tb
                target = span(doc, ta, tb)
            if h is not None and h.i == v.i:
                pass
            scope = [t for t in v.subtree] if v.dep_ == 'ROOT' or h is None else [t for t in v.subtree]
            exclude = set()
            if h is not None:
                exclude |= {t.i for t in h.subtree if t.dep_ == 'compound' or t.i == h.i}
            refs = references(doc, [t for t in scope if t.i < v.i], exclude)
            # the request's own object is not a reference when it is the demonstrative noun phrase itself
            refs = [(x, y) for x, y in refs if h is None or y != h.i]
            out.append(dict(text=span(doc, a, b), target=target, inputs=[span(doc, x, y) for x, y in refs], after=[], _v=v.i))
    # one request: every reference of the utterance is its own (a reference may sit after it: 「…描いてほしいな、この音楽に合うやつ」)
    if len(out) == 1 and reqs:
        _, v1, obs1 = reqs[0]
        own = {t.i for o in obs1 for t in o.subtree if t.dep_ == 'compound' or t.i == o.i}
        refs = [(x, y) for x, y in references(doc, list(doc), own) if not any(y == o.i for o in obs1)]
        out[0]['inputs'] = list(dict.fromkeys(out[0]['inputs'] + [span(doc, x, y) for x, y in refs]))
    # clauses that are not requests: their references go to the last request before or after them
    for lv in loose:
        refs = references(doc, list(lv.subtree), set())
        if refs and out:
            k = max([i for i, r in enumerate(out) if r['_v'] < lv.i] or [len(out) - 1])
            out[k]['inputs'] += [span(doc, x, y) for x, y in refs if span(doc, x, y) not in out[k]['inputs']]
    # fragments: sentences with no predicate (「この画像の感じで」) add their references to the last request
    for s in sentences:
        if not any(r['_v'] >= s.start and r['_v'] < s.end for r in out) and not any(lv.i >= s.start and lv.i < s.end for lv in loose):
            refs = references(doc, list(s), set())
            if refs and out:
                out[-1]['inputs'] += [span(doc, x, y) for x, y in refs]
    # order: a later request that refers back (それ・その・そこ) or follows a たら/てから clause comes after the previous one
    for k in range(1, len(out)):
        prev_v = doc[out[k - 1]['_v']]
        tail = doc.text[prev_v.idx: doc[chunk_end(doc, prev_v)].idx + len(doc[chunk_end(doc, prev_v)].text)]
        if any(re.match(r'^(それ|その|そこ)', x) for x in out[k]['inputs']) or 'たら' in tail or tail.endswith('から'):
            out[k]['after'] = [k - 1]
    for r in out:
        r.pop('_v', None)
    return {'requests': out[:8]}


def valid(text, s):
    if s is None: return True
    for i, r in enumerate(s['requests']):
        if not r['text'] or r['text'] not in text: return False
        if r['target'] and r['target'] not in text: return False
        if any(x not in text for x in r['inputs']): return False
        if any(a >= i for a in r['after']): return False
    return True


def main():
    import spacy
    model, inp, outp = sys.argv[1:4]; half = sys.argv[sys.argv.index('--half') + 1] if '--half' in sys.argv else None
    nlp = spacy.load(model); nlp('準備')
    items = [json.loads(l) for l in open(inp) if l.strip()]
    if half: items = [i for i in items if i.get('half') == half]
    with open(outp, 'w') as o:
        for it in items:
            t0 = time.perf_counter(); doc = nlp(it['text'][:2000]); s = analyze(doc); ms = 1000 * (time.perf_counter() - t0)
            if not valid(it['text'], s): s = None
            o.write(json.dumps(dict(id=it['id'], structure=s, ms=round(ms, 2)), ensure_ascii=False) + '\n')
            if '--show' in sys.argv:
                g = it['gold']['requests']
                n = None if s is None else len(s['requests'])
                mark = 'OK ' if n == len(g) else 'NG '
                print(mark, it['kind'][:10], len(g), '→', n, '|', it['text'][:40], '|', None if s is None else [(r['text'], r['inputs'], r['after']) for r in s['requests']])


if __name__ == '__main__': main()
