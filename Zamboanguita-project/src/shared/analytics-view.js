/* Analytics pages: the officer's (admin/admin_insights.html) and the
 * manager's (resort/resort_analytics.html). Plain global (window.ztimsAnalytics),
 * like the other shared scripts. Needs acc-common.js (api, download, esc).
 *
 * Everything shown comes from /api/analytics/* (analytics.js), which decides
 * what the signed-in account may read. Hiding a part of this page is never a
 * control. The page only draws what the server worked out:
 *  - accommodation arrivals, attraction visits and room requests in separate
 *    tabs and charts, never added together, never called unique visitors;
 *  - a month nobody reported is drawn as a gap with "Not reported", never 0;
 *    a period with only part of its reports is hatched and named "partial";
 *  - every chart has a "Show as a table" with the same numbers;
 *  - the Excel file is the server's, from the same functions.
 * Colours: one hue (the burnt-orange text token, tangerine in dark mode);
 * last year a dashed grey line; partial hatched; unknown hatched grey.
 */
(function () {
    const CAT = { BEACH: 'Beach & Sea', DIVING: 'Diving & Snorkeling', NATURE: 'Nature', ADVENTURE: 'Adventure', CULTURE: 'Culture & Heritage', FAITH: 'Faith', LEISURE: 'Leisure & Recreation' };
    const SECTIONS = [['philippine', 'Philippine residents'], ['foreign', 'Non-Philippine residents'], ['overseas_filipino', 'Overseas Filipinos'], ['unspecified', 'Residence unspecified']];
    const CLASSES = [['zamboanguita', 'Zamboanguita'], ['negrosOriental', 'Rest of Negros Oriental'], ['otherProvince', 'Other Philippine provinces'], ['foreign', 'Foreign countries']];
    const STATUS = [['requested', 'Waiting for an answer'], ['confirmed', 'Confirmed'], ['checked_in', 'Checked in'], ['completed', 'Stayed'], ['no_show', 'No-show'], ['declined', 'Declined'], ['expired', 'Expired'], ['cancelled', 'Cancelled']];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let uid = 0, GEO = { l: 52 / 720, r: 10 / 720 };

    const A = () => window.ztimsAcc;
    const esc = v => A().esc(v);
    const nf = v => (v == null ? '–' : Number(v).toLocaleString('en-US'));
    const dec = (v, d = 1) => (v == null ? '–' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
    const pctOf = v => (v == null ? '–' : `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`);
    const plural = (k, one, many) => `${nf(k)} ${k === 1 ? one : (many || one + 's')}`;
    const manilaToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const shiftMonth = (key, n) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
    const lastDayOf = key => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
    const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const catName = c => CAT[c] || c;

    /* ---- small parts ---------------------------------------------------------- */
    const loading = text => `<div class="ax-state" role="status"><span class="ax-spin" aria-hidden="true"></span>${esc(text || 'Loading…')}</div>`;
    const failed = (message, retry) => `<div class="ztims-empty tone-danger ax-state--error" role="alert"><span class="material-symbols-outlined" aria-hidden="true">error</span><span>${esc(message)}</span>${retry ? '<button type="button" class="pg-btn pg-btn--plain" data-retry>Try again</button>' : ''}</div>`;
    const empty = (text, icon = 'info') => `<div class="ztims-empty"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><span>${text}</span></div>`;
    const pill = (tone, text) => `<span class="tone-pill ${tone} rounded-pill">${text}</span>`;
    const card = (title, body, opts = {}) => `<section class="ax-card${opts.wide ? ' ax-card--wide' : ''}"${opts.id ? ` id="${opts.id}"` : ''} aria-labelledby="ax-h-${++uid}">
        <header class="ax-card__head"><h3 id="ax-h-${uid}">${title}</h3>${opts.badge || ''}</header>${body}${opts.foot ? `<p class="ax-note">${opts.foot}</p>` : ''}</section>`;
    const table = (head, rows, caption) => `<details class="ax-table"><summary>Show as a table</summary><div class="ax-scroll"><table class="ztims-table"><caption class="sr-only">${esc(caption || '')}</caption><thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => (i ? `<td class="num">${c}</td>` : `<th scope="row">${c}</th>`)).join('')}</tr>`).join('')}</tbody></table></div></details>`;
    const tile = (label, value, note, tone) => `<div class="stat-tile ax-tile${tone ? ' ' + tone : ''}"><p>${label}</p><p>${value}</p>${note ? `<p class="text-support">${note}</p>` : ''}</div>`;

    function shortLabel(p, multiYear) {
        if (/^\d{4}-\d{2}$/.test(p.key)) { const [y, m] = p.key.split('-'); return multiYear ? `${MON[+m - 1]} ’${y.slice(2)}` : MON[+m - 1]; }
        if (/Q\d$/.test(p.key)) return p.label.replace(' ', ' ');
        return p.label;
    }
    const periodState = p => (p.future ? 'future' : p.municipalTotal && !p.figures ? 'paper' : !p.figures ? 'none' : p.complete ? 'complete' : 'partial');
    const STATE_TEXT = { complete: 'Complete', partial: 'Partial: not every place reported', none: 'Not reported', future: 'Not yet', paper: 'Kept only as a 2025 municipal paper total (no figures per place)' };

    /* A column chart over periods. values[i] null = nothing reported (a gap with a mark, never a 0 bar). */
    function columns(periods, value, opts = {}) {
        const narrow = window.innerWidth < 640, W = narrow ? 380 : 720, H = narrow ? 230 : 250, m = { l: narrow ? 38 : 52, r: narrow ? 6 : 10, t: 14, b: 34 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
        GEO = { l: m.l / W, r: m.r / W };
        const vals = periods.map(value), cmp = opts.compare || null;
        const max = Math.max(1, ...vals.filter(v => v != null), ...(cmp || []).filter(v => v != null));
        const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
        const y = v => m.t + ih - (v / top) * ih, bw = iw / periods.length, gap = Math.min(10, bw * 0.22);
        const multi = new Set(periods.map(p => p.key.slice(0, 4))).size > 1, every = Math.ceil(periods.length / (narrow ? 6 : (opts.maxLabels || 12)));
        const pid = 'axh' + (++uid);
        let s = `<svg class="ax-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}"><defs><pattern id="${pid}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="ax-hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" class="ax-hatch-line"/></pattern></defs>`;
        for (let t = 0; t <= top + 1e-9; t += step) s += `<line class="ax-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax-axis" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
        periods.forEach((p, i) => {
            const v = vals[i], w = Math.min(bw - gap, 72), x = m.l + bw * i + (bw - w) / 2, st = periodState(p);
            const words = `${p.label}: ${v == null ? STATE_TEXT[st === 'complete' || st === 'partial' ? 'none' : st] : nf(v) + ' ' + opts.unit + (st === 'partial' ? ' (partial)' : '')}${cmp && cmp[i] != null ? `; a year earlier ${nf(cmp[i])}` : ''}`;
            s += `<g class="ax-col" tabindex="0" aria-label="${esc(words)}"><title>${esc(words)}</title>`;
            if (v != null) s += `<rect class="ax-bar${st === 'partial' ? ' ax-bar--partial' : ''}" x="${x}" y="${y(v)}" width="${w}" height="${Math.max(v > 0 ? 1.5 : 0, m.t + ih - y(v))}" ${st === 'partial' ? `fill="url(#${pid})"` : ''}/>`;
            if (v === 0) s += `<line class="ax-zero" x1="${x}" x2="${x + w}" y1="${m.t + ih - 1}" y2="${m.t + ih - 1}"/>`;
            if (v == null && st === 'paper') s += `<rect class="ax-paper" x="${x}" y="${m.t + ih - 6}" width="${w}" height="6"/>`;
            if (v == null && st === 'none') s += `<rect class="ax-gap" x="${x}" y="${m.t + ih - 14}" width="${w}" height="14"/>`;
            s += `<rect x="${m.l + bw * i}" y="${m.t}" width="${bw}" height="${ih}" fill="transparent"/></g>`;
            if (i % every === 0) s += `<text class="ax-axis" x="${m.l + bw * (i + 0.5)}" y="${H - 12}" text-anchor="middle">${esc(shortLabel(p, multi))}</text>`;
        });
        if (cmp && cmp.some(v => v != null)) {
            let d = '', pen = false;
            cmp.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${m.l + bw * (i + 0.5)} ${y(v)}`; pen = true; });
            s += `<path class="ax-cmp" d="${d}"/>`;
            cmp.forEach((v, i) => { if (v != null) s += `<circle class="ax-cmp-pt" cx="${m.l + bw * (i + 0.5)}" cy="${y(v)}" r="3.5"/>`; });
        }
        s += `<line class="ax-base" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/></svg>`;
        const legend = [`<span><i class="ax-key ax-key--solid"></i>${esc(opts.unitLabel || opts.unit)}, complete</span>`];
        if (periods.some(p => periodState(p) === 'partial')) legend.push('<span><i class="ax-key ax-key--hatch"></i>Partial: not every place reported</span>');
        if (periods.some(p => periodState(p) === 'none')) legend.push('<span><i class="ax-key ax-key--gap"></i>Not reported (not 0)</span>');
        if (periods.some(p => periodState(p) === 'paper')) legend.push('<span><i class="ax-key ax-key--paper"></i>Kept only as a 2025 municipal paper total</span>');
        if (cmp && cmp.some(v => v != null)) legend.push('<span><i class="ax-key ax-key--cmp"></i>A year earlier, comparable periods only</span>');
        return `<figure class="ax-figure">${s}<figcaption class="ax-legend">${legend.join('')}</figcaption></figure>`;
    }
    function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x || 1))); const f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
    function compact(v) { return v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : nf(Math.round(v * 100) / 100); }

    /* The coverage band under a monthly chart: how many places reported each period. */
    function coverageBand(periods, finalizedKey, expectedKey, extraKeys) {
        return `<div class="ax-cov" style="grid-template-columns:repeat(${periods.length}, minmax(0,1fr));margin-left:${(GEO.l * 100).toFixed(2)}%;margin-right:${(GEO.r * 100).toFixed(2)}%" aria-label="Reports in each period">${periods.map(p => {
            const c = p.coverage || {}, exp = c[expectedKey] || 0, fin = c[finalizedKey] || 0, extra = (extraKeys || []).reduce((a, k) => a + (c[k] || 0), 0);
            const st = p.future ? 'future' : !exp ? 'future' : fin === exp ? 'full' : fin + extra > 0 ? 'part' : 'none';
            const words = p.future ? `${p.label}: not yet` : !exp ? `${p.label}: no place expected` : `${p.label}: ${fin} of ${exp} finalized${extra ? `, ${extra} more submitted or in draft` : ''}`;
            return `<span class="ax-cov__cell ax-cov--${st}" title="${esc(words)}"><span class="sr-only">${esc(words)}</span><b aria-hidden="true">${p.future || !exp ? '' : `${fin}/${exp}`}</b></span>`;
        }).join('')}</div>`;
    }

    /* Horizontal bars, HTML. value null = shown as "Not reported", never as an empty bar of 0. */
    function hbars(items, unit) {
        const max = Math.max(1, ...items.map(i => i.value || 0));
        return `<ul class="ax-hbars">${items.map(i => `<li><span class="ax-hbars__label">${esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</span>
            <span class="ax-hbars__track">${i.value == null ? `<em>${esc(i.na || 'Not reported')}</em>` : `<span class="ax-hbars__bar${i.hatch ? ' ax-hatch' : ''}" style="width:${Math.max(i.value > 0 ? 1 : 0, (i.value / max) * 100)}%"></span>`}</span>
            <span class="ax-hbars__value">${i.value == null ? '–' : nf(i.value)}<span class="sr-only"> ${esc(unit)}</span></span></li>`).join('')}</ul>`;
    }
    /* One stacked bar for a whole (residence, sex). Unknown parts are hatched and named. */
    function stacked(parts, unit) {
        const total = parts.reduce((a, p) => a + (p.value || 0), 0);
        if (!total) return empty('Nothing recorded in these periods.');
        const shades = [1, 0.72, 0.5, 0.32];
        let k = 0;
        return `<div class="ax-stack" role="img" aria-label="${esc(parts.map(p => `${p.label} ${nf(p.value)}`).join(', '))} ${esc(unit)}">${parts.filter(p => p.value > 0).map(p => `<span class="${p.unknown ? 'ax-hatch ax-unknown' : 'ax-seg'}" style="width:${(p.value / total) * 100}%;${p.unknown ? '' : `opacity:${shades[Math.min(k++, 3)]}`}" title="${esc(p.label)}: ${nf(p.value)}"></span>`).join('')}</div>
            <ul class="ax-stack__legend">${(() => { let j = 0; return parts.map(p => `<li><i class="${p.unknown ? 'ax-key ax-key--unknown' : 'ax-key ax-key--solid'}" style="${p.unknown ? '' : `opacity:${shades[Math.min(j++, 3)]}`}"></i>${esc(p.label)} <b>${nf(p.value)}</b></li>`).join(''); })()}</ul>`;
    }
    /* Daily values with the 7-day average. */
    function daily(days, avg, unit) {
        const narrow = window.innerWidth < 640, W = narrow ? 380 : 720, H = narrow ? 210 : 200, m = { l: narrow ? 32 : 44, r: 8, t: 12, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
        const max = Math.max(1, ...days.map(d => d.value || 0)), step = niceStep(max / 4), top = Math.ceil(max / step) * step;
        const y = v => m.t + ih - (v / top) * ih, bw = iw / days.length;
        let s = `<svg class="ax-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)} per day with the 7-day average">`;
        for (let t = 0; t <= top + 1e-9; t += step) s += `<line class="ax-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="ax-axis" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
        days.forEach((d, i) => {
            const words = `${d.date}: ${d.value == null ? (d.state === 'closed' ? 'closed' : d.state === 'future' || d.state === 'today' ? 'not yet' : d.state === 'before' ? 'before reporting started' : 'not recorded') : nf(d.value)}`;
            s += `<g><title>${esc(words)}</title>${d.value != null ? `<rect class="ax-bar ax-bar--day" x="${m.l + bw * i + bw * 0.15}" y="${y(d.value)}" width="${bw * 0.7}" height="${Math.max(d.value > 0 ? 1 : 0, m.t + ih - y(d.value))}"/>` : (d.state === 'missing' || d.state === 'scheduled') ? `<rect class="ax-gap" x="${m.l + bw * i + bw * 0.15}" y="${m.t + ih - 8}" width="${bw * 0.7}" height="8"/>` : ''}</g>`;
        });
        let dpath = '', pen = false;
        (avg || []).forEach((v, i) => { if (v == null) { pen = false; return; } dpath += `${pen ? 'L' : 'M'}${m.l + bw * (i + 0.5)} ${y(v)}`; pen = true; });
        if (dpath) s += `<path class="ax-avg" d="${dpath}"/>`;
        /* Labels are kept at least minGap apart, so a long range shows fewer of them
           (months only) instead of printing them over one another. */
        const minGap = narrow ? 42 : 46, candidates = days.map((d, i) => [d, i]).filter(([d]) => d.date.endsWith('-01') || (!narrow && d.date.endsWith('-15')));
        const ticks = []; let lastX = -Infinity;
        candidates.forEach(([d, i]) => {
            const x = m.l + bw * (i + 0.5);
            if (x - lastX >= minGap && x >= m.l + 14 && x <= W - m.r - 14) { ticks.push([d, i]); lastX = x; }
        });
        ticks.forEach(([d, i]) => { s += `<text class="ax-axis" x="${m.l + bw * (i + 0.5)}" y="${H - 8}" text-anchor="middle">${MON[+d.date.slice(5, 7) - 1]} ${+d.date.slice(8)}</text>`; });
        s += `<line class="ax-base" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/></svg>`;
        return `<figure class="ax-figure">${s}<figcaption class="ax-legend"><span><i class="ax-key ax-key--solid"></i>${esc(unit)} that day</span><span><i class="ax-key ax-key--avg"></i>7-day average (recorded days)</span><span><i class="ax-key ax-key--gap"></i>Not recorded</span></figcaption></figure>`;
    }

    const peakLine = (pl, unit) => {
        if (!pl || !pl.peak) return `<p class="ax-peak ax-peak--none"><span class="material-symbols-outlined" aria-hidden="true">info</span>No peak or low yet: no period in this range is complete.${pl && pl.excluded && pl.excluded.length ? ` ${plural(pl.excluded.length, 'period')} left out because not every place reported.` : ''}</p>`;
        const lbl = k => periodLabel(k);
        return `<div class="ax-peak"><p><span class="material-symbols-outlined" aria-hidden="true">trending_up</span><span>Peak</span><b>${esc(lbl(pl.peak.key))}</b> ${nf(pl.peak.value)} ${esc(unit)}</p>${pl.low ? `<p><span class="material-symbols-outlined" aria-hidden="true">trending_down</span><span>Low</span><b>${esc(lbl(pl.low.key))}</b> ${nf(pl.low.value)} ${esc(unit)}</p>` : ''}<p class="ax-note">Among ${plural(pl.ranked, 'complete period')}${pl.excluded.length ? `; ${plural(pl.excluded.length, 'partial or unreported period')} left out` : ''}.</p></div>`;
    };
    function periodLabel(key) {
        if (/^\d{4}-\d{2}$/.test(key)) { const [y, m] = key.split('-'); return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+m - 1]} ${y}`; }
        if (/Q\d$/.test(key)) return `Q${key.slice(-1)} ${key.slice(0, 4)}`;
        return key;
    }
    function totalNote(total, unitPlaces) {
        if (!total) return '';
        if (total.future) return 'Not yet';
        if (total.complete) return 'Every place reported';
        return `Partial: ${unitPlaces}`;
    }

    /* ---- the page ----------------------------------------------------------------- */
    function mount(root, opts) {
        const role = opts.role;                       // 'officer' | 'manager'
        const thisMonth = manilaToday().slice(0, 7);
        const S = { from: shiftMonth(thisMonth, -11), to: thisMonth, granularity: 'month', mode: 'official', compare: false, barangay: '', category: '', place: '', accMeasure: 'arrivals' };
        const cache = { places: null };
        const officer = role === 'officer';
        const spotId = () => (officer ? S.place : opts.spotId());

        const TABS = officer
            ? [['accommodation', 'Places to stay', 'hotel'], ['attractions', 'Attractions', 'attractions'], ['requests', 'Room requests', 'bed'], ['coverage', 'Reporting coverage', 'fact_check']]
            : [['accommodation', 'Arrivals and nights', 'hotel'], ['guests', 'Guests and stays', 'groups'], ['requests', 'Room requests', 'bed']];
        const tabFromHash = () => { const h = location.hash.slice(1); return TABS.some(t => t[0] === h) ? h : TABS[0][0]; };

        root.innerHTML = `
            <div class="ax-filters glass-panel" role="group" aria-label="Filters">
                <label><span class="field-label">From</span><input type="month" id="axFrom" class="field" value="${S.from}" max="${thisMonth}"/></label>
                <label><span class="field-label">To</span><input type="month" id="axTo" class="field" value="${S.to}" max="${thisMonth}"/></label>
                <label><span class="field-label">Group by</span><select id="axGran" class="field"><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></select></label>
                <div><span class="field-label" id="axModeLbl">Figures</span><div class="pg-seg" role="group" aria-labelledby="axModeLbl">
                    <button type="button" data-mode="official" aria-pressed="true">Finalized</button><button type="button" data-mode="operational" aria-pressed="false">Include submitted and draft</button></div></div>
                ${officer ? `<label><span class="field-label">Barangay</span><select id="axBrgy" class="field"><option value="">All barangays</option></select></label>
                <label><span class="field-label">Category</span><select id="axCat" class="field"><option value="">All categories</option>${Object.entries(CAT).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
                <label><span class="field-label">Place</span><select id="axPlace" class="field"><option value="">All places</option></select></label>` : ''}
                <label class="ax-check"><input type="checkbox" id="axCmp"/> <span>Compare with a year earlier</span></label>
            </div>
            <p id="axSource" class="ax-source" aria-live="polite"></p>
            <div class="flex flex-wrap gap-1 border-b border-outline-variant/40" role="tablist" aria-label="Analytics">${TABS.map(t => `<button type="button" role="tab" class="settings-tab" id="axTab-${t[0]}" aria-controls="axPanel-${t[0]}" aria-selected="false" data-tab="${t[0]}"><span class="material-symbols-outlined" aria-hidden="true">${t[2]}</span>${t[1]}</button>`).join('')}</div>
            ${TABS.map(t => `<div role="tabpanel" id="axPanel-${t[0]}" aria-labelledby="axTab-${t[0]}" class="ax-panel" hidden></div>`).join('')}`;

        const $ = id => root.querySelector('#' + id);
        let tab = tabFromHash(), seq = 0;

        function params(extra) {
            const q = new URLSearchParams({ from: S.from, to: S.to, granularity: S.granularity, mode: S.mode });
            if (S.compare) q.set('compare', 'previous-year');
            if (officer) { if (S.barangay) q.set('barangay', S.barangay); if (S.category) q.set('category', S.category); }
            if (spotId()) q.set('spotId', spotId());
            Object.entries(extra || {}).forEach(([k, v]) => (v == null ? q.delete(k) : q.set(k, v)));
            return q.toString();
        }
        function sourceLine() {
            $('axSource').innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${S.mode === 'official' ? 'verified' : 'pending'}</span>${S.mode === 'official'
                ? '<b>Finalized reports only.</b> Months still waiting for the Tourism Office are left out and shown as partial.'
                : '<b>Includes reports not yet finalized</b> (submitted, and attraction drafts from the daily record). These can still change.'}`;
        }

        function selectTab(name, focus) {
            tab = name;
            TABS.forEach(([t]) => { const on = t === name; $('axTab-' + t).setAttribute('aria-selected', String(on)); $('axTab-' + t).tabIndex = on ? 0 : -1; $('axPanel-' + t).hidden = !on; });
            if (focus) $('axTab-' + name).focus();
            if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
            draw();
        }
        root.querySelector('[role=tablist]').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
        root.querySelector('[role=tablist]').addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            const i = TABS.findIndex(t => t[0] === tab), n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
            e.preventDefault(); selectTab(TABS[n][0], true);
        });
        window.addEventListener('hashchange', () => { const t = tabFromHash(); if (t !== tab) selectTab(t); });

        function onFilters() {
            let f = $('axFrom').value, t = $('axTo').value;
            if (!f || !t) return;
            if (f > t) { [f, t] = [t, f]; $('axFrom').value = f; $('axTo').value = t; }
            S.from = f; S.to = t; S.granularity = $('axGran').value; S.compare = $('axCmp').checked;
            if (officer) { S.barangay = $('axBrgy').value; S.category = $('axCat').value; S.place = $('axPlace').value; }
            draw();
        }
        ['axFrom', 'axTo', 'axGran', 'axCmp', 'axBrgy', 'axCat', 'axPlace'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', onFilters); });
        root.querySelector('.pg-seg').addEventListener('click', e => {
            const b = e.target.closest('[data-mode]'); if (!b) return;
            S.mode = b.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw();
        });

        /* The place, barangay lists (officer): from the places the server lets this account read. */
        async function loadPlaceLists() {
            if (!officer || cache.places) return;
            const q = `from=${S.to}&to=${S.to}`;
            const [acc, att] = await Promise.all([A().api(`/analytics/accommodation/places?${q}`), A().api(`/analytics/attractions/places?${q}`)]);
            cache.places = { acc: acc.byPlace.map(x => x.place), att: att.byPlace.map(x => x.place) };
            const brgys = [...new Set([...cache.places.acc, ...cache.places.att].map(p => p.barangay).filter(Boolean))].sort();
            brgys.forEach(b => $('axBrgy').add(new Option(b, b)));
            const sel = $('axPlace');
            [['Places to stay', cache.places.acc], ['Attractions', cache.places.att]].forEach(([label, list]) => {
                if (!list.length) return;
                const g = document.createElement('optgroup'); g.label = label;
                list.forEach(p => g.appendChild(new Option(p.name, p._id)));
                sel.appendChild(g);
            });
        }
        const placeKind = id => (!cache.places || !id ? null : cache.places.acc.some(p => p._id === id) ? 'acc' : cache.places.att.some(p => p._id === id) ? 'att' : null);

        async function draw() {
            const my = ++seq, panel = $('axPanel-' + tab);
            sourceLine();
            panel.innerHTML = loading();
            try {
                await loadPlaceLists();
                const html = await (VIEWS[tab])();
                if (my !== seq) return;
                panel.innerHTML = html;
                panel.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => exportXlsx(b)));
                panel.querySelectorAll('[data-measure]').forEach(b => b.addEventListener('click', () => { S.accMeasure = b.dataset.measure; draw(); }));
            } catch (e) {
                if (my !== seq || e.status === 401) return;
                panel.innerHTML = failed(e.status === 0 ? e.message : e.status === 403 ? 'This account cannot read these figures.' : e.message || 'The figures could not be loaded.', true);
                const r = panel.querySelector('[data-retry]'); if (r) r.addEventListener('click', draw);
            }
        }
        async function exportXlsx(btn) {
            btn.disabled = true;
            try { await A().download(`/analytics/${btn.dataset.export}/export.xlsx?${params()}`, `analytics_${btn.dataset.export}.xlsx`); }
            catch (e) { if (window.showToast) showToast(e.message, 'error'); }
            finally { btn.disabled = false; }
        }
        const exportBtn = domain => `<button type="button" class="pg-btn pg-btn--plain ax-export" data-export="${domain}"><span class="material-symbols-outlined" aria-hidden="true">download</span>Excel</button>`;

        /* ---- accommodation --------------------------------------------------------- */
        const ACC_MEASURES = [['arrivals', 'Arrivals', 'arrivals'], ['guestNights', 'Guest nights', 'guest nights'], ['roomNightsOccupied', 'Room-nights occupied', 'room-nights']];
        async function viewAccommodation() {
            if (officer && placeKind(S.place) === 'att') return empty('The place chosen is an attraction. Choose a place to stay, or All places.');
            const d = await A().api(`/analytics/accommodation?${params()}`);
            if (!d.places && !d.baseline) return empty(officer ? 'No private place to stay matches these filters.' : 'This enterprise is not a private place to stay.');
            const t = d.total, f = t.figures, measure = ACC_MEASURES.find(x => x[0] === S.accMeasure) || ACC_MEASURES[0];
            const unreported = d.periods.filter(p => !p.future && !p.figures).length;
            const partialNote = t.complete ? 'every place reported' : `${unreported ? plural(unreported, 'period') + ' not reported; ' : ''}not every place reported`;
            const tiles = `<div class="stat-tiles ax-tiles">
                ${tile('Guest arrivals', f ? nf(f.arrivals) : '–', f ? (t.complete ? 'All periods complete' : `Partial: ${partialNote}`) : 'Nothing reported in this range', !f || !t.complete ? 'ax-tile--partial' : '')}
                ${tile('Guest nights', f ? nf(f.guestNights) : '–', f ? 'every guest × every night' : '')}
                ${tile('Occupancy rate', f ? pctOf(t.rates.occupancyRate) : '–', f ? `${nf(f.roomNightsOccupied)} of ${nf(f.roomNightsAvailable)} room-nights` : '')}
                ${tile('Average length of stay', f && t.rates.averageLengthOfStay != null ? `${dec(t.rates.averageLengthOfStay)} nights` : '–', f ? 'guest nights ÷ arrivals' : '')}
            </div>`;
            const cmp = d.comparison && d.comparison.find(c => c.measure === measure[0]);
            const chart = columns(d.periods, p => (p.figures ? p.figures[measure[0]] : null), { unit: measure[2], unitLabel: measure[1], label: `${measure[1]} per ${S.granularity} at private places to stay`, compare: cmp ? cmp.periods.map(c => (c.comparable ? c.previous : null)) : null });
            const switcher = `<div class="pg-seg ax-measure" role="group" aria-label="Measure">${ACC_MEASURES.map(x => `<button type="button" data-measure="${x[0]}" aria-pressed="${x[0] === measure[0]}">${x[1]}</button>`).join('')}</div>`;
            const rows = d.periods.map(p => [esc(p.label), p.figures ? nf(p.figures.arrivals) : '–', p.figures ? nf(p.figures.guestNights) : '–', p.figures ? nf(p.figures.roomNightsOccupied) : '–', p.figures ? nf(p.figures.roomNightsAvailable) : '–', p.rates ? pctOf(p.rates.occupancyRate) : '–', `${nf(p.coverage.finalized || 0)} of ${nf(p.coverage.expected || 0)}`, STATE_TEXT[periodState(p)]]);
            const trend = card(`${measure[1]} by ${S.granularity}`, switcher + chart + coverageBand(d.periods, 'finalized', 'expected', S.mode === 'operational' ? ['submitted'] : []) +
                `<p class="ax-note">Under each period: places that finalized, of the places expected to report.</p>` +
                table(['Period', 'Arrivals', 'Guest nights', 'Room-nights occupied', 'Room-nights available', 'Occupancy', 'Finalized', 'State'], rows, 'Accommodation by period'),
                { wide: true, badge: exportBtn('accommodation') });
            const peak = card('Peak and low', peakLine(d.peakLow.arrivals, 'arrivals') + (cmp ? compareSummary(cmp) : ''), {});
            const res = f ? stacked(SECTIONS.map(([k, label]) => ({ label, value: f.residence[k] || 0, unknown: k === 'unspecified' })), 'arrivals') : empty('Nothing reported in this range.');
            const sex = f ? stacked([{ label: 'Male', value: f.sex.male }, { label: 'Female', value: f.sex.female }], 'arrivals') : empty('Nothing reported in this range.');
            const demo = card('Where guests live', res + (f ? table(['Residence', 'Arrivals'], SECTIONS.map(([k, l]) => [l, nf(f.residence[k] || 0)]), 'Arrivals by residence') : ''), { foot: f && !t.complete ? 'Counts from the reports included above only.' : '' }) +
                card('Guests by sex', sex + (f ? table(['Sex', 'Arrivals'], [['Male', nf(f.sex.male)], ['Female', nf(f.sex.female)]], 'Arrivals by sex') : ''), { foot: 'Recorded per guest in each stay register.' });
            let base = '';
            if (d.baseline) {
                const bp = d.baseline.periods.filter(p => p.figures);   // only the months the paper totals hold
                base = card('2025 paper totals (Form A4)', columns(bp.map(p => ({ ...p, coverage: {}, future: false })), p => (p.figures ? p.figures.arrivals : null), { unit: 'arrivals', unitLabel: 'Arrivals, paper totals', label: 'Arrivals in the 2025 paper totals' }) +
                    table(['Period', 'Arrivals', 'Guest nights', 'Room-nights occupied'], bp.map(p => [esc(p.label), p.figures ? nf(p.figures.arrivals) : '–', p.figures ? nf(p.figures.guestNights) : '–', p.figures ? nf(p.figures.roomNightsOccupied) : '–']), '2025 paper totals'),
                    { wide: true, badge: pill('tone-neutral', 'Separate source'), foot: 'The municipality’s whole-month totals kept on paper before ZTIMS. They have no place, barangay or sex split, and whether they cover the same places is not confirmed, so they are never added to the reports above.' });
            }
            let breakdown = '';
            if (officer && !S.place) {
                const b = await A().api(`/analytics/accommodation/places?${params({ granularity: null, compare: null })}`);
                breakdown = card('Arrivals by place', hbars(b.byPlace.map(x => ({ label: x.place.name, sub: x.place.barangay, value: x.value }))
                    .sort((x, y) => (y.value ?? -1) - (x.value ?? -1)), 'arrivals'), { foot: 'A place with no report in the range shows “Not reported”, not 0.' }) +
                    card('By barangay', hbars(b.byBarangay.map(x => ({ label: x.key, sub: `${plural(x.placesWithFigures, 'place')} reported of ${x.places}`, value: x.value })), 'arrivals'), { foot: 'The barangay where the place is, not where guests live.' });
            }
            return tiles + `<div class="ax-grid">${trend}${peak}${demo}${breakdown}${base}</div>`;
        }
        function compareSummary(cmp) {
            const ok = cmp.periods.filter(c => c.comparable);
            if (!ok.length) return `<p class="ax-note ax-cmp-note">No period can be compared with a year earlier yet: ${esc((cmp.periods.find(c => c.reason) || {}).reason || 'both periods must be complete.')}</p>`;
            return `<ul class="ax-cmp-list">${ok.map(c => `<li><span>${esc(periodLabel(c.key))}</span><b>${c.difference > 0 ? '+' : ''}${nf(c.difference)}</b><span class="text-support">${nf(c.current)} against ${nf(c.previous)}${c.scopeUnconfirmed ? ' (paper total)' : ''}</span></li>`).join('')}</ul>`;
        }

        /* ---- attractions (officer) ------------------------------------------------- */
        async function viewAttractions() {
            if (placeKind(S.place) === 'acc') return empty('The place chosen is a place to stay. Choose an attraction, or All places.');
            const d = await A().api(`/analytics/attractions?${params()}`);
            if (!d.places) return empty('No office attraction in reporting matches these filters.');
            const t = d.total, f = t.figures;
            const resKnown = f && f.residence ? CLASSES.reduce((a, [k]) => a + (f.residence[k] || 0), 0) : 0;
            const tiles = `<div class="stat-tiles ax-tiles">
                ${tile('Visits', f ? nf(f.visits) : '–', f ? (t.complete ? 'All periods complete' : 'Partial: not every attraction reported') : 'Nothing reported in this range', !f || !t.complete ? 'ax-tile--partial' : '')}
                ${tile('Dates counted', f ? nf(f.datesCounted) : '–', f ? `${plural(f.zeroDays, 'day')} with nobody, ${plural(f.closedDays, 'closed day')}` : '')}
                ${tile('Residence recorded', f ? `${nf(resKnown)}` : '–', f ? `of ${nf(f.visits)} visits; ${nf(f.residenceUnrecorded)} not recorded` : '')}
                ${tile('Sex recorded', f && f.sex ? nf(f.sex.male + f.sex.female) : '–', f ? `of ${nf(f.visits)} visits; ${nf(f.sexUnrecorded)} not recorded` : '')}
            </div>`;
            const cmp = d.comparison && d.comparison[0];
            const chart = columns(d.periods, p => (p.figures ? p.figures.visits : null), { unit: 'visits', unitLabel: 'Visits', label: `Visits per ${S.granularity} at office attractions`, compare: cmp ? cmp.periods.map(c => (c.comparable ? c.previous : null)) : null });
            const rows = d.periods.map(p => [esc(p.label), p.figures ? nf(p.figures.visits) : '–', `${nf(p.coverage.finalized || 0)} of ${nf(p.coverage.expected || 0)}`, STATE_TEXT[periodState(p)]]);
            const trend = card(`Visits by ${S.granularity}`, chart + coverageBand(d.periods, 'finalized', 'expected', S.mode === 'operational' ? ['submitted', 'draft'] : []) +
                `<p class="ax-note">Under each period: attractions that finalized, of the attractions expected to report. Visits are not people: one person visiting two attractions counts twice.</p>` +
                table(['Period', 'Visits', 'Finalized', 'State'], rows, 'Attraction visits by period'), { wide: true, badge: exportBtn('attractions') });
            const peak = card('Peak and low', peakLine(d.peakLow.visits, 'visits') + (cmp ? compareSummary(cmp) : ''));
            const res = f ? (f.residence ? stacked(CLASSES.map(([k, l]) => ({ label: l, value: f.residence[k] || 0 })).concat([{ label: 'Residence not recorded', value: f.residenceUnrecorded, unknown: true }]), 'visits')
                : empty('No residence was recorded in these periods.')) : empty('Nothing reported in this range.');
            const sex = f ? (f.sex ? stacked([{ label: 'Male', value: f.sex.male }, { label: 'Female', value: f.sex.female }, { label: 'Sex not recorded', value: f.sexUnrecorded, unknown: true }], 'visits')
                : empty('Sex was not recorded in these periods.')) : empty('Nothing reported in this range.');
            const demo = card('Where visitors live', res + (f && f.residence ? table(['Residence', 'Visits'], CLASSES.map(([k, l]) => [l, nf(f.residence[k])]).concat([['Not recorded', nf(f.residenceUnrecorded)]]), 'Visits by residence') : ''), { foot: 'Unrecorded visits stay in the total and are never placed in a class.' }) +
                card('Visitors by sex', sex, { foot: 'Sex by residence is not recorded, so the two are never combined.' });
            let more = '';
            if (S.place) more = await dailyCard(S.place);
            else {
                const b = await A().api(`/analytics/attractions/places?${params({ granularity: null, compare: null })}`);
                more = card('Visits by attraction', hbars(b.byPlace.map(x => ({ label: x.place.name, sub: x.place.barangay, value: x.value })).sort((x, y) => (y.value ?? -1) - (x.value ?? -1)), 'visits'), { foot: 'Choose an attraction under Place to see it day by day.' }) +
                    card('By category', hbars(b.byCategory.map(x => ({ label: catName(x.key), sub: `${plural(x.placesWithFigures, 'attraction')} reported of ${x.places}`, value: x.value })), 'visits'), { foot: 'An attraction with several categories counts under each, so these are never added together.' }) +
                    card('By barangay', hbars(b.byBarangay.map(x => ({ label: x.key, sub: `${plural(x.placesWithFigures, 'attraction')} reported of ${x.places}`, value: x.value })), 'visits'), { foot: 'The barangay where the attraction is, not where visitors live.' });
            }
            return tiles + `<div class="ax-grid">${trend}${peak}${demo}${more}</div>`;
        }
        async function dailyCard(id) {
            const today = manilaToday(), end = lastDayOf(S.to) < today ? lastDayOf(S.to) : today;
            let start = S.from + '-01';
            if (start < addDays(end, -89)) start = addDays(end, -89);
            const d = await A().api(`/analytics/attractions/daily?from=${start}&to=${end}&spotId=${encodeURIComponent(id)}`);
            const s = d.summary;
            const wk = d.weekdays.map(w => ({ label: w.weekday, sub: plural(w.days, 'day'), value: w.mean == null ? null : Math.round(w.mean * 10) / 10, na: 'No day recorded' }));
            return card(`${esc(d.place.name)} day by day`, `<p class="text-support">${esc(periodLabel(start.slice(0, 7)))} ${+start.slice(8)} to ${esc(periodLabel(end.slice(0, 7)))} ${+end.slice(8)} · ${nf(s.visits)} visits on ${plural(s.recordedDays, 'recorded day')} · ${plural(s.missing, 'day')} not recorded · ${plural(s.closed, 'closed day')}</p>` +
                daily(d.days, d.rolling7, 'Visits') + (d.peakLow.peak ? `<p class="ax-note">Busiest day ${esc(d.peakLow.peak.date)} (${nf(d.peakLow.peak.value)}); quietest ${esc(d.peakLow.low ? d.peakLow.low.date : '–')} (${nf(d.peakLow.low ? d.peakLow.low.value : null)}). Counts as recorded, before or after the month is submitted.</p>` : ''), { wide: true }) +
                card('Average visits by weekday', hbars(wk, 'visits on average'), { foot: 'Averages over recorded days only; a day not recorded is left out, not counted as 0.' });
        }

        /* ---- the manager's guests and stays ---------------------------------------- */
        async function viewGuests() {
            const today = manilaToday(), end = lastDayOf(S.to) < today ? lastDayOf(S.to) : today;
            let start = S.from + '-01'; if (start < addDays(end, -365)) start = addDays(end, -365);
            if (start > end) return empty('Choose months that have started.');
            const [st, bm] = await Promise.all([
                A().api(`/analytics/accommodation/stays?from=${start}&to=${end}&spotId=${encodeURIComponent(spotId())}`),
                A().api(`/analytics/accommodation/benchmark?from=${S.from}&to=${S.to}&spotId=${encodeURIComponent(spotId())}`)
            ]);
            const a = st.arrivals, ls = st.lengthOfStay;
            const tiles = `<div class="stat-tiles ax-tiles">${tile('Guests arrived', nf(a.total), 'from your stay register, as recorded now')}${tile('Stays started', nf(ls.stays), '')}${tile('Typical stay', ls.median == null ? '–' : `${dec(ls.median, ls.median % 1 ? 1 : 0)} nights`, 'median of stays')}${tile('Busiest day', a.peakLow.peak ? nf(a.peakLow.peak.value) : '–', a.peakLow.peak ? esc(a.peakLow.peak.date) : '')}</div>`;
            const wk = a.weekdays.map(w => ({ label: w.weekday, sub: plural(w.days, 'day'), value: w.mean == null ? null : Math.round(w.mean * 10) / 10, na: 'No day yet' }));
            const ben = bm.months.map(m => [esc(periodLabel(m.key)), nf(m.own), m.barangay.suppressed ? `Hidden (${m.barangay.placesReported} reported)` : nf(m.barangay.arrivals), m.municipal.suppressed ? `Hidden (${m.municipal.placesReported} reported)` : nf(m.municipal.arrivals)]);
            return (!st.reportingFrom ? `<div class="ztims-empty tone-warning ax-inline"><span class="material-symbols-outlined" aria-hidden="true">warning</span><span>Your reporting start month is not set (Enterprise → Reporting), so days are not counted yet.</span></div>` : '') + tiles + `<div class="ax-grid">` +
                card('Arrivals day by day', daily(a.days, a.rolling7, 'Guests arriving'), { wide: true, foot: 'Live from the stay register: it can change until a month is submitted. Days before reporting started are left out.' }) +
                card('Arrivals by weekday', hbars(wk, 'guests on average'), { foot: 'Average guests arriving on that weekday, over the days in the range.' }) +
                card('Length of stay', hbars(ls.buckets.map(b => ({ label: `${b.nights} night${b.nights === '1' ? '' : 's'}`, value: b.stays })), 'stays'), { foot: 'Counts stays, not guests.' }) +
                card('Compared with other places to stay', table(['Month', 'Your arrivals', 'Your barangay', 'All places to stay'], ben, 'Comparison').replace('<details class="ax-table">', '<details class="ax-table" open>'),
                    { wide: true, foot: `Finalized reports only. A group is shown only when at least ${bm.minimumGroup} places finalized that month, so no other enterprise’s figures can be read from it.` }) + `</div>`;
        }

        /* ---- room requests --------------------------------------------------------- */
        let countries = null;
        async function viewRequests() {
            if (officer && placeKind(S.place) === 'att') return empty('Room requests are for places to stay.');
            if (!countries) countries = await fetch('/api/rooms/countries').then(r => (r.ok ? r.json() : [])).catch(() => []);
            const d = await A().api(`/analytics/reservations?${params({ granularity: null, compare: null, mode: null })}`);
            if (!d.places) return empty('No private place to stay matches these filters.');
            const t = d.total, by = t.byStatus || {};
            const kept = ['confirmed', 'checked_in', 'completed', 'no_show'].reduce((a, k) => a + (by[k] || 0), 0);
            const name = code => (countries.find(c => c.code === code) || {}).name || code;
            const tiles = `<div class="stat-tiles ax-tiles">${tile('Room requests', nf(t.requests), 'made through ZTIMS')}${tile('Accepted', nf(kept), 'confirmed, checked in, stayed or no-show')}${tile('Room-nights reserved', nf(t.roomNightsReserved), 'rooms × nights, accepted requests')}${tile('Answered within', d.answerTimeHours.median == null ? '–' : `${dec(d.answerTimeHours.median)} hours`, `median, ${plural(d.answerTimeHours.requests, 'answered request')}`)}</div>`;
            const months = d.months.map(m => ({ key: m.key, label: periodLabel(m.key), figures: { n: m.requests }, complete: true, future: m.key > manilaToday().slice(0, 7), coverage: {} }));
            return `<div class="ztims-empty ax-inline"><span class="material-symbols-outlined" aria-hidden="true">info</span><span>A room request is not an arrival. Arrivals come only from the stay register. Requests made by phone or elsewhere are not here.</span></div>` + tiles + `<div class="ax-grid">` +
                card('Requests by the month they were made', columns(months, p => p.figures.n, { unit: 'requests', unitLabel: 'Requests', label: 'Room requests per month' }) + table(['Month', 'Requests'], d.months.map(m => [esc(periodLabel(m.key)), nf(m.requests)]), 'Requests by month'), { wide: true }) +
                card('What happened to them', hbars(STATUS.map(([k, l]) => ({ label: l, value: by[k] || 0 })), 'requests')) +
                card('Where the guests live', d.byCountry.length ? hbars(d.byCountry.slice(0, 10).map(c => ({ label: name(c.code), value: c.requests })), 'requests') : empty('No requests in this range.'), { foot: `Lead time from request to check-in: ${d.leadTimeDays.median == null ? '–' : dec(d.leadTimeDays.median, 0) + ' days (median)'}. No prices are shown: statistics hold counts only.` }) + `</div>`;
        }

        /* ---- reporting coverage (officer) ------------------------------------------ */
        async function viewCoverage() {
            const [gaps, acc, att] = await Promise.all([
                A().api('/analytics/coverage'),
                A().api(`/analytics/accommodation?${params({ compare: null, granularity: 'month' })}`),
                A().api(`/analytics/attractions?${params({ compare: null, granularity: 'month' })}`)
            ]);
            const cell = (p, extra) => { const c = p.coverage || {}; if (p.future) return 'Not yet'; if (!c.expected) return '–'; const more = extra.reduce((a, k) => a + (c[k] || 0), 0); return `${nf(c.finalized || 0)} of ${nf(c.expected)}${more ? ` (+${more} not finalized)` : ''}${c.missing ? ` · ${c.missing} missing` : ''}`; };
            const rows = acc.periods.map((p, i) => [esc(p.label), p.municipalTotal ? 'Paper total' : cell(p, ['submitted']), att.periods[i] ? cell(att.periods[i], ['submitted', 'draft']) : '–']);
            const open = acc.periods.filter(p => !p.future && !p.complete && !p.municipalTotal).length + att.periods.filter(p => !p.future && !p.complete && (p.coverage.expected || 0) > 0).length;
            return `<div class="stat-tiles ax-tiles">${gaps.gaps.map(g => tile(esc(g.label), nf(g.count), '', g.count ? 'ax-tile--partial' : '')).join('')}${tile('Incomplete months in this range', nf(open), 'places to stay and attractions together')}</div><div class="ax-grid">` +
                card('Reports finalized each month', `<div class="ax-scroll"><table class="ztims-table"><caption class="sr-only">Reports finalized each month</caption><thead><tr><th scope="col">Month</th><th scope="col">Places to stay</th><th scope="col">Attractions</th></tr></thead><tbody>${rows.map(r => `<tr><th scope="row">${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table></div>`,
                    { wide: true, foot: 'Finalized of expected. A missing report is never counted as 0. Open Statistics → Tracker to follow one up.' }) + `</div>`;
        }

        const VIEWS = { accommodation: viewAccommodation, attractions: viewAttractions, requests: viewRequests, coverage: viewCoverage, guests: viewGuests };
        selectTab(tab);
        return { refresh: draw };
    }

    window.ztimsAnalytics = { mount };
})();
