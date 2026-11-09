#!/usr/bin/env python3
"""Check a .drawio file for common drawing mistakes. Usage: check_drawio.py file.drawio
Reports: duplicate ids, edges without source/target, vertices outside the page,
overlapping vertices (siblings only), mixed font families. Exit 1 if any problem."""
import sys, re, xml.etree.ElementTree as ET, itertools

def num(v, d=0.0):
    try: return float(v)
    except (TypeError, ValueError): return d

def main(path):
    tree = ET.parse(path); root = tree.getroot()
    problems = []
    for diagram in root.iter('diagram'):
        g = diagram.find('mxGraphModel')
        if g is None:
            problems.append(f"[{diagram.get('name')}] compressed diagram: export as uncompressed XML first"); continue
        pw, ph = num(g.get('pageWidth'), 1e9), num(g.get('pageHeight'), 1e9)
        cells = list(g.iter('mxCell'))
        ids = [c.get('id') for c in cells]
        for i in {i for i in ids if ids.count(i) > 1}: problems.append(f"duplicate id {i}")
        idset = set(ids)
        verts = []; fonts = set()
        for c in cells:
            style = c.get('style') or ''
            m = re.search(r'fontFamily=([^;]+)', style)
            if m: fonts.add(m.group(1))
            if c.get('edge') == '1':
                for end in ('source', 'target'):
                    if not c.get(end): problems.append(f"edge {c.get('id')} has no {end} (loose end)")
                    elif c.get(end) not in idset: problems.append(f"edge {c.get('id')} {end} points to missing id")
            elif c.get('vertex') == '1':
                geo = c.find('mxGeometry')
                if geo is None: continue
                x, y, w, h = (num(geo.get(k)) for k in ('x', 'y', 'width', 'height'))
                label = re.sub(r'<[^>]+>', ' ', c.get('value') or '').strip()
                if x < 0 or y < 0 or x + w > pw + 1 or y + h > ph + 1:
                    problems.append(f"vertex {c.get('id')} '{label[:30]}' is outside the page")
                if c.get('parent') == '1' and 'dashed=1' not in style and 'fillColor=none' not in style and 'text;' not in style[:6] and w and h:
                    verts.append((c.get('id'), label, x, y, w, h))
        for (a, la, ax, ay, aw, ah), (b, lb, bx, by, bw, bh) in itertools.combinations(verts, 2):
            ox = min(ax + aw, bx + bw) - max(ax, bx); oy = min(ay + ah, by + bh) - max(ay, by)
            if ox > 2 and oy > 2: problems.append(f"{a} '{la[:25]}' overlaps {b} '{lb[:25]}'")
        if len(fonts) > 1: problems.append(f"mixed fonts: {sorted(fonts)}")
        print(f"[{diagram.get('name')}] {len(cells)} cells, {sum(1 for c in cells if c.get('edge') == '1')} edges")
    for p in problems: print('PROBLEM:', p)
    print('OK' if not problems else f'{len(problems)} problem(s)')
    return 1 if problems else 0

if __name__ == '__main__':
    if len(sys.argv) != 2: sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
