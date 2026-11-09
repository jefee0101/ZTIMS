"""Helpers for editing the ZTIMS manuscript with python-docx. Import with:
   import sys; sys.path.insert(0, 'docs/skills/ztims-docx-revision'); from docx_tools import *"""
import re, copy
from docx.oxml.ns import qn
from lxml import etree

XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'
A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

def ptext(p): return ''.join(t.text or '' for t in p.iter(qn('w:t')))
def _tnodes(p): return list(p.iter(qn('w:t')))

def replace_text(p, old, new, count=1):
    """Replace old with new across runs (keeps formatting). Asserts the number of replacements."""
    n = 0
    while True:
        ts = _tnodes(p); full = ''.join(t.text or '' for t in ts); i = full.find(old)
        if i < 0: break
        j = i + len(old); pos = 0; first = True
        for t in ts:
            s = t.text or ''; a, b = pos, pos + len(s); pos = b
            if b <= i or a >= j: continue
            lo, hi = max(i, a) - a, min(j, b) - a
            t.text = (s[:lo] + new + s[hi:]) if first else (s[:lo] + s[hi:]); first = False
            t.set(XML_SPACE, 'preserve')
        n += 1
        if old in new: break
    assert n == count, f'{old!r}: replaced {n}, expected {count} in {ptext(p)[:60]!r}'
    return n

def _base_rpr(p):
    for r in p.iter(qn('w:r')):
        rp = r.find(qn('w:rPr'))
        if rp is not None and r.find(qn('w:t')) is not None:
            rp = copy.deepcopy(rp)
            for tag in ('w:b', 'w:bCs', 'w:i', 'w:iCs'):
                for x in rp.findall(qn(tag)): rp.remove(x)
            return rp

def _run(rpr, text, bold=False, italic=False):
    r = etree.Element(qn('w:r')); rp = copy.deepcopy(rpr) if rpr is not None else etree.Element(qn('w:rPr'))
    at = 1 if rp.find(qn('w:rFonts')) is not None else 0
    extra = ([etree.Element(qn('w:b')), etree.Element(qn('w:bCs'))] if bold else []) + ([etree.Element(qn('w:i')), etree.Element(qn('w:iCs'))] if italic else [])
    for k, x in enumerate(extra): rp.insert(at + k, x)
    r.append(rp)
    for k, part in enumerate(text.split('\n')):
        if k: etree.SubElement(r, qn('w:br'))
        t = etree.SubElement(r, qn('w:t')); t.text = part; t.set(XML_SPACE, 'preserve')
    return r

def _lead_len(p):
    n = 0
    for r in p.findall(qn('w:r')):
        rp = r.find(qn('w:rPr'))
        if rp is not None and rp.find(qn('w:b')) is not None and r.find(qn('w:t')) is not None:
            n += len(''.join(t.text or '' for t in r.iter(qn('w:t'))))
        else: break
    return n

def set_text(p, new, keep_lead=True):
    """Rewrite a paragraph. If it starts with a bold lead-in, the new text's lead-in (same words, or the
    first sentence) stays bold. Use '\\n' for a line break."""
    rpr = _base_rpr(p); old = ptext(p); ll = _lead_len(p) if keep_lead else 0
    for r in list(p.findall(qn('w:r'))): p.remove(r)
    for h in list(p.findall(qn('w:hyperlink'))): p.remove(h)
    if ll:
        lead = old[:ll]
        i = len(lead) if new.startswith(lead) else new.index('.') + 1
        p.append(_run(rpr, new[:i], True)); p.append(_run(rpr, new[i:]))
    else: p.append(_run(rpr, new))

def segments_from_markdown(text, bold=False):
    out = []
    for part in re.split(r'(\*[^*]+\*)', text):
        if part: out.append((part[1:-1], bold, True) if part.startswith('*') else (part, bold, False))
    return out

def clone_paragraph(template, segments):
    """New paragraph with the template's paragraph properties and run style; segments = [(text, bold, italic)]."""
    p = copy.deepcopy(template); rpr = _base_rpr(template)
    for x in list(p):
        if x.tag != qn('w:pPr'): p.remove(x)
    for text, b, i in segments: p.append(_run(rpr, text, b, i))
    return p

def swap_image(doc, drawing_paragraph, png_path, ratio=None):
    """Replace the picture in a paragraph that holds one drawing. ratio = width / height of the new picture."""
    blip = drawing_paragraph.find('.//' + qn('a:blip')); part = doc.part.rels[blip.get(qn('r:embed'))].target_part
    part._blob = open(png_path, 'rb').read()
    if ratio:
        for ext in drawing_paragraph.iter('{%s}extent' % WP_NS, '{%s}ext' % A_NS):
            ext.set('cy', str(round(int(ext.get('cx')) / ratio)))
    for sr in list(drawing_paragraph.iter('{%s}srcRect' % A_NS)): sr.getparent().remove(sr)
