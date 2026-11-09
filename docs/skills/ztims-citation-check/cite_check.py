#!/usr/bin/env python3
"""Citation checker. Usage: cite_check.py manuscript.txt
Splits the text at the line 'REFERENCES' (last one), reads reference entries (one paragraph each)
and in-text author-year citations before it."""
import re, sys, unicodedata

def norm(s):
    s = unicodedata.normalize('NFKD', s.replace('’', "'")).encode('ascii', 'ignore').decode().lower()
    return re.sub(r"[^a-z ]", '', s).strip()

def main(path):
    text = open(path, encoding='utf-8').read()
    lines = text.split('\n')
    idx = [i for i, l in enumerate(lines) if l.strip().upper() == 'REFERENCES']
    if not idx: sys.exit('No REFERENCES heading found')
    start = idx[-1]
    end = next((i for i in range(start + 1, len(lines)) if re.match(r'\s*APPENDIX\s+[A-Z]\b', lines[i])), len(lines))
    body = '\n'.join(lines[:start])
    refs = [l.strip() for l in lines[start + 1:end] if len(l.strip()) > 30]
    entries = []
    for r in refs:
        m = re.match(r"(.+?)\((\d{4}[a-z]?)\)", r)
        if not m: entries.append((r, None, None)); continue
        first = re.split(r',|\.\s', m.group(1).strip())[0]
        entries.append((r, norm(first), m.group(2)))
    # in-text citations: (Name, 2020; Name & Name, 2021) and Name (2020) / Name et al. (2020)
    cites = set()
    for par in re.findall(r'\(([^()]*?\d{4}[a-z]?[^()]*?)\)', body):
        for part in par.split(';'):
            m = re.match(r"\s*(?:see |e\.g\., )?([A-Z][^,()]*?)(?: et al\.)?(?: (?:&|and) [^,()]+?)?,? (\d{4}[a-z]?)\s*$", part.strip())
            if m: cites.add((norm(m.group(1).split(' & ')[0].split(' and ')[0]), m.group(2)))
    for m in re.finditer(r"([A-Z][A-Za-z'’\-]+)(?: et al\.| and [A-Z][A-Za-z'’\-]+| & [A-Z][A-Za-z'’\-]+)? \((\d{4}[a-z]?)\)", body):
        cites.add((norm(m.group(1)), m.group(2)))
    keys = {(e[1], e[2]) for e in entries if e[1]}
    def has(c): return any(k[1] == c[1] and (c[0] in k[0] or k[0] in c[0]) for k in keys)
    missing = sorted(c for c in cites if not has(c))
    uncited = sorted((e[1], e[2]) for e in entries if e[1] and not any(c[1] == e[2] and (c[0] in e[1] or e[1] in c[0]) for c in cites))
    print(f'{len(entries)} reference entries, {len(cites)} distinct in-text citations')
    print('\nCITED BUT NOT IN THE REFERENCES:'); [print('  ', c) for c in missing] or None
    print('\nIN THE REFERENCES BUT NEVER CITED:'); [print('  ', c) for c in uncited] or None
    print('\nENTRY WARNINGS:')
    order = [e[1] for e in entries if e[1]]
    for e in entries:
        if e[2] is None: print('   no (year) found:', e[0][:70])
        elif not re.search(r'https?://|doi\.org', e[0]): print('   no DOI or URL:', e[0][:70])
    for a, b in zip(order, order[1:]):
        if a and b and b < a and not b.startswith('von '): print(f'   out of order: {a} before {b}')
    seen = {}
    for e in entries:
        if e[1]: seen.setdefault((norm(e[0].split('(')[0]), e[2]), []).append(e[0])
    for k, v in seen.items():
        if len(v) > 1 and not k[1][-1:].isalpha(): print('   same author and year, add a/b:', k)
    return 1 if missing or uncited else 0

if __name__ == '__main__':
    if len(sys.argv) != 2: sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
