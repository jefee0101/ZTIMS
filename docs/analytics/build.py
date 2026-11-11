# Builds mockup.html and 02-analytics-inventory.md from inventory.json, gaps.json and mockup.template.html.
import json
inv = json.load(open('inventory.json')); gaps = json.load(open('gaps.json'))
tpl = open('mockup.template.html').read()
dump = lambda o: json.dumps(o, ensure_ascii=False).replace('</', '<\\/')
open('mockup.html', 'w').write(tpl.replace('/*INVENTORY_JSON*/', dump(inv)).replace('/*GAPS_JSON*/', dump(gaps)))
ST = {k: v.split(':')[0] for k, v in inv['statuses'].items()}
ROLE = {'officer': 'Officer', 'manager': 'Manager', 'staff': 'Support Staff'}
out = ['# Analytics inventory', '',
 'Proposal, 12 November 2026. Nothing here is built. Each analytic names its data source, calculation, user value, best visualization and limitations. G-numbers refer to `03-dashboards-data-flow-gaps.md`.', '',
 '**Status.** ' + ' '.join(f'**{ST[k]}**: {v.split(": ",1)[1]}' for k, v in inv['statuses'].items()), '',
 '**Build order.** 1 = first, 2 = second, 3 = third; 0 = not proposed.', '']
for d, name in inv['domains'].items():
    rows = [a for a in inv['analytics'] if a['domain'] == d]
    if not rows: continue
    out += [f'## {name}', '']
    for a in rows:
        aud = ', '.join(ROLE[x] for x in a['audience']) or '—'
        out += [f'### {a["id"]} · {a["name"]}', '', f'*For:* {aud} · *Status:* {ST[a["status"]]} · *Build order:* {a["priority"]}', '',
                f'- **Data source:** {a["source"]}', f'- **Calculation:** {a["calc"]}', f'- **User value:** {a["value"]}',
                f'- **Best visualization:** {a["viz"]}', f'- **Limitations:** {a["limits"]}', '']
open('02-analytics-inventory.md', 'w').write('\n'.join(out))
print(len(inv['analytics']), 'analytics;', len(gaps['gaps']), 'gaps')

# 04-prioritized-gaps.md
g = ['# Prioritized gaps', '',
 'Proposal, 12 November 2026. What cannot be shown honestly yet, in the order it blocks the analytics. **P0** stops the core picture, **P1** limits it, **P2** is a known limit. Evidence comes from the repository and a read-only check of the live project.', '',
 '| ID | Priority | Gap | Affects |', '|---|---|---|---|']
for x in gaps['gaps']:
    g.append(f'| {x["id"]} | {x["priority"]} | {x["title"]} | {x["affects"]} |')
g += ['']
for x in gaps['gaps']:
    g += [f'## {x["id"]} · {x["title"]} ({x["priority"]})', '', f'- **Evidence:** {x["evidence"]}', f'- **What closes it:** {x["closes"]}', f'- **Owner:** {x["owner"]}', f'- **Affects:** {x["affects"]}', '']
g += ['## Decisions needed to move on', ''] + [f'- **{d["id"]}** {d["text"]}' for d in gaps['decisions']] + ['']
open('04-prioritized-gaps.md', 'w').write('\n'.join(g))
