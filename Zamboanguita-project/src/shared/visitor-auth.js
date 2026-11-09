/* The visitor's sign-in pages (src/user/sign_in, sign_up, verify_email,
   forgot_password, new_password), one script for all five: each page says
   which it is on <body data-auth-page>. The API is visitors.js.

   After signing in the visitor goes back where they were (?next=, an address
   on this site only); an emailed link carries only its token, so the address
   to return to is kept for the visit in sessionStorage.ztimsNext.

   "Continue with Google" uses Google Identity Services; the client id comes
   from GET /api/visitors/config, never typed into a page, and the server
   checks Google's token itself. Without a client id the button is not shown. */
(function () {
    'use strict';

    const page = document.body.dataset.authPage;
    const $ = id => document.getElementById(id);
    const params = new URLSearchParams(location.search);
    const NEXT_KEY = 'ztimsNext';
    const TOKEN = 'ztimsVisitorToken', NAME = 'ztimsVisitorName';

    const safeNext = value => (String(value || '').startsWith('/') && !String(value).startsWith('//') && !String(value).includes('\\') ? String(value) : '');
    const session = (key, value) => { try { if (value === undefined) return sessionStorage.getItem(key) || ''; value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch { return ''; } return ''; };
    const nextPlace = () => safeNext(params.get('next')) || safeNext(session(NEXT_KEY)) || '/src/user/account.html#tickets';
    if (safeNext(params.get('next'))) session(NEXT_KEY, params.get('next'));
    // Links between the sign-in pages keep where to go back to.
    document.querySelectorAll('a[data-keep-next]').forEach(a => {
        const next = safeNext(params.get('next')) || safeNext(session(NEXT_KEY));
        if (next) a.href += (a.href.includes('?') ? '&' : '?') + 'next=' + encodeURIComponent(next);
    });

    function signedIn(data) {
        try {
            localStorage.setItem(TOKEN, data.token);
            localStorage.setItem(NAME, (data.visitor && (data.visitor.fullName || data.visitor.email)) || '');
        } catch { /* private browsing: this visit only */ }
        const next = nextPlace();
        session(NEXT_KEY, '');
        location.assign(next);
    }

    async function post(path, body) {
        try {
            const response = await fetch('/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await response.json().catch(() => ({}));
            return { ok: response.ok, status: response.status, data };
        } catch {
            return { ok: false, status: 0, data: { message: 'No connection. Check your signal and try again.' } };
        }
    }

    /* A message in the card: tone 'error' or 'success'. */
    function say(id, message, tone = 'error') {
        const el = $(id);
        if (!el) return;
        el.textContent = message || '';
        el.hidden = !message;
        el.className = `va-msg va-msg--${tone}`;
    }
    function busy(button, label) {
        const original = button.innerHTML;
        button.disabled = true;
        button.textContent = label;
        return () => { button.disabled = false; button.innerHTML = original; };
    }

    // Show / hide a password (every eye button names its field).
    document.querySelectorAll('[data-eye]').forEach(btn => btn.addEventListener('click', () => {
        const field = $(btn.dataset.eye);
        const show = field.type === 'password';
        field.type = show ? 'text' : 'password';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.querySelector('.material-symbols-outlined').textContent = show ? 'visibility_off' : 'visibility';
    }));

    /* ---- Google ------------------------------------------------------- */

    let pendingCredential = '';
    async function google(onCredential) {
        const box = $('googleBox');
        if (!box) return;
        let clientId = null;
        try { clientId = (await (await fetch('/api/visitors/config')).json()).googleClientId; } catch { /* stays hidden */ }
        if (!clientId) return;
        await new Promise((resolve, reject) => {
            if (window.google && window.google.accounts) return resolve();
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        }).catch(() => null);
        if (!window.google || !window.google.accounts) return;
        window.google.accounts.id.initialize({ client_id: clientId, callback: r => onCredential(r.credential), ux_mode: 'popup' });
        const dark = document.documentElement.classList.contains('dark');
        window.google.accounts.id.renderButton($('googleButton'), {
            type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill',
            text: 'continue_with', logo_alignment: 'center', width: Math.min(400, $('googleButton').clientWidth || 320)
        });
        box.hidden = false;
    }

    async function googleSignIn(credential, password) {
        say('formMessage', '');
        const result = await post('/visitors/google', password ? { credential, password } : { credential });
        if (result.ok) return signedIn(result.data);
        if (result.data.code === 'LINK_NEEDS_PASSWORD' && $('linkBox')) {
            // An account with this email already has a password: it is asked
            // once, to join Google to it.
            pendingCredential = credential;
            $('linkBox').hidden = false;
            $('linkPassword').focus();
        }
        say('formMessage', result.data.message || 'Google sign-in did not work. Please try again.');
    }

    /* ---- the pages ---------------------------------------------------- */

    if (page === 'sign-in') {
        google(credential => googleSignIn(credential));
        $('linkForm') && $('linkForm').addEventListener('submit', event => {
            event.preventDefault();
            if (pendingCredential) googleSignIn(pendingCredential, $('linkPassword').value);
        });
        $('signInForm').addEventListener('submit', async event => {
            event.preventDefault();
            say('formMessage', '');
            const done = busy($('signInBtn'), 'Signing in…');
            const result = await post('/visitors/sign-in', { email: $('email').value.trim(), password: $('password').value });
            done();
            if (result.ok) return signedIn(result.data);
            say('formMessage', result.data.message || 'Could not sign in just now.', result.data.code === 'EMAIL_NOT_VERIFIED' ? 'success' : 'error');
        });
    }

    if (page === 'sign-up') {
        google(credential => googleSignIn(credential));
        $('signUpForm').addEventListener('submit', async event => {
            event.preventDefault();
            say('formMessage', '');
            if ($('password').value !== $('passwordAgain').value) return say('formMessage', 'The two passwords are not the same.');
            if (!$('consent').checked) return say('formMessage', 'Agree to the Terms and the Privacy Policy to create an account.');
            const done = busy($('signUpBtn'), 'Creating your account…');
            const email = $('email').value.trim();
            const result = await post('/visitors/sign-up', {
                fullName: $('fullName').value.trim(), email, password: $('password').value, consent: true
            });
            done();
            if (!result.ok) return say('formMessage', result.data.message || 'The account could not be created just now.');
            $('signUpForm').hidden = true;
            $('googleBox') && ($('googleBox').hidden = true);
            $('sentBox').hidden = false;
            $('sentEmail').textContent = email;
            $('resendBtn').dataset.email = email;
        });
    }

    // "Send it again", on Sign up's sent box and on Verify email.
    $('resendBtn') && $('resendBtn').addEventListener('click', async () => {
        const email = $('resendBtn').dataset.email || ($('resendEmail') && $('resendEmail').value.trim());
        if (!email) return say('resendMessage', 'Give the email address of your account.');
        const done = busy($('resendBtn'), 'Sending…');
        const result = await post('/visitors/verify/resend', { email });
        done();
        say('resendMessage', result.data.message || 'Could not send it just now.', result.ok ? 'success' : 'error');
    });

    if (page === 'verify') {
        const token = params.get('token');
        if (!token) {
            $('waitBox').hidden = false;
        } else {
            $('checkingBox').hidden = false;
            post('/visitors/verify', { token }).then(result => {
                $('checkingBox').hidden = true;
                if (result.ok) {
                    try {
                        localStorage.setItem(TOKEN, result.data.token);
                        localStorage.setItem(NAME, result.data.visitor.fullName || result.data.visitor.email || '');
                    } catch { /* this visit only */ }
                    $('doneBox').hidden = false;
                    $('continueLink').href = nextPlace();
                    session(NEXT_KEY, '');
                } else {
                    $('waitBox').hidden = false;
                    say('resendMessage', result.data.message || 'This link does not work any more.');
                }
            });
        }
    }

    if (page === 'forgot') {
        $('forgotForm').addEventListener('submit', async event => {
            event.preventDefault();
            const done = busy($('forgotBtn'), 'Sending…');
            const result = await post('/visitors/forgot', { email: $('email').value.trim() });
            done();
            say('formMessage', result.data.message || 'Could not send it just now.', result.ok ? 'success' : 'error');
        });
    }

    if (page === 'reset') {
        const token = params.get('token');
        if (!token) say('formMessage', 'This link is not complete. Ask for a new one.');
        $('resetForm').addEventListener('submit', async event => {
            event.preventDefault();
            if ($('password').value !== $('passwordAgain').value) return say('formMessage', 'The two passwords are not the same.');
            const done = busy($('resetBtn'), 'Saving…');
            const result = await post('/visitors/reset', { token, password: $('password').value });
            done();
            if (result.ok) return signedIn(result.data);
            say('formMessage', result.data.message || 'The password could not be saved just now.');
        });
    }
})();
