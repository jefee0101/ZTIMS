import sys
from PIL import Image, ImageOps
def load(p): return Image.open(p).convert("RGB")
def bbox(im, thr=245):
    g = ImageOps.invert(im.convert("L")).point(lambda v: 255 if v > 255 - thr else 0)
    return g.getbbox()
def run(px, c, y, step):
    # length of the dark run met first when walking from column c in direction step (a ruled line is long, a letter stroke short)
    n, x = 0, c + step
    while 0 <= x < 99999:
        try: v = px[x, y]
        except IndexError: break
        if min(v) > 200 and n == 0: x += step; continue
        if max(v) < 90: n += 1; x += step
        else: break
        if n > 40: break
    return n
def mend(out, j, band=80, reach=12):
    """Close the thin white gap a page edge leaves where two pieces meet at x=j."""
    px = out.load(); W, H = out.size
    white = lambda c: min(c) > 200
    for y in range(H):
        for c in range(max(1, j - band), min(W - 1, j + band)):
            if not white(px[c, y]): continue
            l = next((px[c - k, y] for k in range(1, reach) if c - k >= 0 and not white(px[c - k, y])), None)
            r = next((px[c + k, y] for k in range(1, reach) if c + k < W and not white(px[c + k, y])), None)
            if l and r and max(abs(a - b) for a, b in zip(l, r)) < 40 and not (max(l) < 90):
                px[c, y] = l
            elif l and r and max(l) < 90 and max(r) < 90 and run(px, c, y, -1) >= 15 and run(px, c, y, 1) >= 15:
                px[c, y] = l
    return out
def hcat(pages, cuts=None):
    """Pages that continue a table to the right: same rows, same y. Crop each to its content's x range."""
    parts = []
    for i, im in enumerate(pages):
        b = bbox(im); x0 = 0 if i == 0 else b[0]; x1 = im.width if i == len(pages) - 1 else b[2]
        if cuts and cuts[i]: x0, x1 = cuts[i][0] if cuts[i][0] is not None else x0, cuts[i][1] if cuts[i][1] is not None else x1
        parts.append(im.crop((x0, 0, x1, im.height)))
    out = Image.new("RGB", (sum(p.width for p in parts), max(p.height for p in parts)), "white")
    x, joins = 0, []
    for p in parts:
        out.paste(p, (x, 0)); x += p.width; joins.append(x)
    for j in joins[:-1]: mend(out, j)
    return out
def vcat(blocks):
    parts = []
    for i, im in enumerate(blocks):
        b = bbox(im); y0 = 0 if i == 0 else b[1]; y1 = im.height if i == len(blocks) - 1 else b[3] + 1
        parts.append(im.crop((0, y0, im.width, y1)))
    out = Image.new("RGB", (max(p.width for p in parts), sum(p.height for p in parts)), "white")
    y = 0
    for p in parts: out.paste(p, (0, y)); y += p.height
    return out
def trim(im, pad=40):
    b = bbox(im); return ImageOps.expand(im.crop(b), border=pad, fill="white")
def save(im, name): trim(im).save(name, optimize=True); print(name, trim(im).size)
L = load
# VAR 1: left part rows 1-28 (p1) | right part (p3); then rows 29-30 + total: p2 | p4.
# The left/right split must use the same x for both row blocks.
p1, p2, p3, p4 = L("var-01.png"), L("var-02.png"), L("var-03.png"), L("var-04.png")
r = max(bbox(p1)[2], bbox(p2)[2]); l = min(bbox(p3)[0], bbox(p4)[0])
top = Image.new("RGB", (r + p3.width - l, p1.height), "white"); top.paste(p1.crop((0, 0, r, p1.height)), (0, 0)); top.paste(p3.crop((l, 0, p3.width, p3.height)), (r, 0))
bot = Image.new("RGB", (r + p4.width - l, p2.height), "white"); bot.paste(p2.crop((0, 0, r, p2.height)), (0, 0)); bot.paste(p4.crop((l, 0, p4.width, p4.height)), (r, 0))
mend(top, r); mend(bot, r)
save(vcat([top, bot]), "../out/attr-var1.png")
save(hcat([L("var-07.png"), L("var-08.png")]), "../out/attr-var2.png")
save(hcat([L("var-10.png"), L("var-11.png"), L("var-12.png")]), "../out/attr-var3m.png")
from PIL import ImageDraw, ImageFont
d = hcat([L("dta-1.png"), L("dta-2.png")], cuts=[(None, 2085), (217, None)])
# The merged heading "Foreign Country Residence" was cut by the page edge: paint the cell again and centre its words.
x0, x1, y0, y1 = 1831, 2085 + (345 - 217) - 2, 453, 551
dr = ImageDraw.Draw(d); dr.rectangle((x0, y0, x1, y1), fill=(255, 255, 0))
f = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", 30)
t = "Foreign Country Residence"; tw = dr.textlength(t, font=f)
tmp = Image.new("RGB", (int(tw) + 4, 40), (255, 255, 0)); ImageDraw.Draw(tmp).text((2, 2), t, font=f, fill="black")
tmp = tmp.resize((int(tmp.width * 0.8), tmp.height))
d.paste(tmp, (int((x0 + x1 - tmp.width) / 2), int((y0 + y1 - tmp.height) / 2)))
save(d, "../out/attr-dta2m.png")
save(L("dae1a-1.png"), "../out/acc-dae1a.png")
for i in (1, 2, 3):
    save(L(f"dae1bd-0{i}.png"), f"../out/acc-dae1b-daily-{i}.png")
    save(L(f"dae1bm-{i}.png"), f"../out/acc-dae1b-monthly-{i}.png")
    save(L(f"forma-{i}.png"), f"../out/acc-forma-{i}.png")
# VAR 2 as published carries one sample entry (period, municipality, attraction name); make it blank like the other forms.
v = Image.open("../out/attr-var2.png").convert("RGB"); dr = ImageDraw.Draw(v)
for box in [(1020, 180, 1340, 214), (1020, 226, 1340, 259), (50, 506, 325, 545), (2570, 1310, v.width, 1400)]:
    dr.rectangle(box, fill="white")
f = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", 28)
t = "Attraction 1"; tw = dr.textlength(t, font=f); dr.text(((25 + 332 - tw) / 2, 512), t, font=f, fill="black")
v.save("../out/attr-var2.png", optimize=True)
