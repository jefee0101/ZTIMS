/* Staff invitations on the officer's pages (staff-invitations.js on the server).
   Used by admin_managers.html (New manager account) and admin_profile.html
   (Tourism Office Accounts, Support Staff). Global, like the other shared parts.

   window.ztimsInvite:
   - wire(form): shows the form's [data-invite-password] block only while its
     method radio says "password"; method(form) reads the choice.
   - showLink({ title, email, inviteLink, emailSent, emailMessage, expiresAt }):
     the window with the link and Copy invitation link.
   - pill(row): the "Waiting for the person to accept" pill for a list row.
   - resend({ kind, id, name, send }): asks the officer's password, asks the
     server for a new link (the old one stops working) and shows it. `send`
     is the page's own (path, body) → result call. */
(function () {
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function method(form) {
        const picked = form.querySelector('input[data-invite-method]:checked');
        return picked ? picked.value : 'invite';
    }

    function wire(form) {
        const sync = () => {
            const block = form.querySelector('[data-invite-password]');
            if (block) block.hidden = method(form) !== 'password';
        };
        form.addEventListener('change', event => { if (event.target.matches('input[data-invite-method]')) sync(); });
        form.addEventListener('reset', () => setTimeout(sync, 0));
        sync();
    }

    const until = date => date ? new Date(date).toLocaleString('en-PH', {
        timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : '';

    function showLink({ title, email, inviteLink, emailSent, emailMessage, expiresAt }) {
        const scrim = document.createElement('div');
        scrim.className = 'ztims-scrim inv-scrim';
        scrim.innerHTML = `
            <div class="ztims-modal inv-modal" role="dialog" aria-modal="true" aria-labelledby="invTitle">
                <h2 id="invTitle" class="inv-title">${esc(title || 'Invitation ready')}</h2>
                <p class="inv-note ${emailSent ? 'tone-success' : 'tone-warning'}">
                    <span class="material-symbols-outlined" aria-hidden="true">${emailSent ? 'mark_email_read' : 'warning'}</span>
                    <span>${esc(emailMessage || (emailSent ? `An invitation was emailed to ${email}.` : 'Email could not be sent. Copy the link instead.'))}</span>
                </p>
                <label class="inv-label" for="invLink">Invitation link${expiresAt ? ` · works until ${esc(until(expiresAt))}` : ''}</label>
                <input id="invLink" class="field inv-link" type="text" readonly value="${esc(inviteLink)}"/>
                <div class="inv-actions">
                    <button type="button" class="btn btn-primary" data-inv-copy>
                        <span class="material-symbols-outlined !text-base" aria-hidden="true">content_copy</span><span>Copy invitation link</span></button>
                    <button type="button" class="btn btn-ghost" data-inv-close>Done</button>
                </div>
            </div>`;
        document.body.appendChild(scrim);
        const input = scrim.querySelector('#invLink');
        const copy = scrim.querySelector('[data-inv-copy]');
        const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = event => { if (event.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        scrim.querySelector('[data-inv-close]').addEventListener('click', close);
        copy.addEventListener('click', async () => {
            const label = copy.querySelector('span:last-child');
            try {
                await navigator.clipboard.writeText(input.value);
                label.textContent = 'Link copied';
            } catch {
                input.focus(); input.select();
                label.textContent = 'Press Ctrl+C to copy';
            }
        });
        copy.focus();
    }

    function pill(row) {
        if (!row || !row.invitePending) return '';
        return `<span class="tone-warning tone-pill inv-pill">Waiting for the person to accept</span>`
            + (row.inviteExpired ? ` <span class="tone-danger tone-pill inv-pill">Link expired</span>` : '');
    }

    async function resend({ kind, id, name, send }) {
        const values = await window.ztimsDialog.form({
            title: `Resend the invitation to ${name}?`,
            message: 'A new link is made and emailed. The earlier link stops working.',
            confirmLabel: 'Resend invitation', icon: 'forward_to_inbox',
            fields: [{ name: 'confirmPassword', label: 'Your password', type: 'password', required: true, autocomplete: 'current-password' }],
            validate: v => (v.confirmPassword ? '' : 'Enter your password to confirm.')
        });
        if (values === null) return null;
        const result = await send(`/invitations/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/resend`, { confirmPassword: values.confirmPassword });
        showLink({ title: `New invitation for ${name}`, ...result });
        return result;
    }

    window.ztimsInvite = { wire, method, showLink, pill, resend };
})();
