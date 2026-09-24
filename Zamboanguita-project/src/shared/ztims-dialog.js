/* ==========================================================================
   Dialogs — the questions a page asks before it acts
   --------------------------------------------------------------------------
   These used to be the browser's own confirm() and prompt(): a grey system box
   with the site's name in the title bar and buttons that ignore the theme. It
   is also modal for the whole tab, cannot be styled, cannot carry a help line
   under an input, and on a phone Chrome renders it as a sheet that looks like
   nothing else on the site.

   This is the same three questions drawn in ZTIMS's own surface, border,
   type and buttons — the .ztims-modal shell and .btn system from theme.css —
   so a "Delete this listing?" looks like it belongs to the page that asked.

   One copy, loaded on the pages that ask questions, as a plain global rather
   than an ES export because those pages are standalone HTML with inline
   scripts (see spot-form.js for the same decision).

       ztimsDialog.confirm({ title, message, confirmLabel, cancelLabel, tone })
           -> Promise<boolean>        true on confirm, false on cancel/Escape

       ztimsDialog.prompt({ title, message, label, value, placeholder, type,
                            help, confirmLabel, cancelLabel, validate })
           -> Promise<string | null>  the text on submit (possibly ''), null
                                      when dismissed — the two are different
                                      answers, exactly as with prompt()

       ztimsDialog.form({ title, message, fields: [{ name, label, value,
                          placeholder, type, help, required, minlength }],
                          confirmLabel, cancelLabel, validate })
           -> Promise<object | null>  { name: value } on submit, null when
                                      dismissed

   tone       'default' | 'danger'. Danger draws the confirming button in the
              error colour and starts focus on Cancel, so Enter cannot delete.
   validate   (value | values) => string | ''. A returned string is shown in
              the dialog and keeps it open.

   Every string is set with textContent, never innerHTML: these messages carry
   listing titles, manager names and server text, none of which may ever
   become markup.

   Escape is handled in the capture phase and stopped there, only while a
   dialog is open, because two of the callers already sit inside a page modal
   (the listing editor) that also closes on Escape. Stacking is above those
   modals' z-[200] and below the toast host, so an error toast raised after a
   dialog closes is still readable over it.
   ========================================================================== */

(function () {
    'use strict';

    // Above every page modal (z-[200]); below #toastHost (2147483000).
    const Z_INDEX = 2147482000;

    const ICONS = {
        default: 'help',
        danger: 'warning',
        prompt: 'edit',
        form: 'edit_note'
    };

    let styleInjected = false;
    function injectStyles() {
        if (styleInjected || document.getElementById('ztims-dialog-styles')) return;
        styleInjected = true;

        const style = document.createElement('style');
        style.id = 'ztims-dialog-styles';
        style.textContent = `
        .ztims-dialog-scrim {
            position: fixed; inset: 0; z-index: ${Z_INDEX};
            display: flex; align-items: center; justify-content: center;
            padding: 1rem;
            animation: ztimsDialogScrimIn var(--motion-fast, 150ms) var(--ease-standard, ease) both;
        }
        .ztims-dialog-scrim.is-closing {
            animation: ztimsDialogScrimOut var(--motion-fast, 150ms) var(--ease-standard, ease) forwards;
        }
        .ztims-dialog {
            width: 100%; max-width: 26rem;
            padding: 1.5rem;
            overflow-y: auto;
            animation: ztimsDialogIn var(--motion-base, 300ms) var(--ease-entrance, ease) both;
        }
        .ztims-dialog--wide { max-width: 32rem; }
        .ztims-dialog-scrim.is-closing .ztims-dialog {
            animation: ztimsDialogOut var(--motion-fast, 150ms) var(--ease-standard, ease) forwards;
        }
        @media (min-width: 640px) { .ztims-dialog { padding: 2rem; } }

        .ztims-dialog__lead { display: flex; align-items: flex-start; gap: 1rem; }
        .ztims-dialog__icon {
            flex-shrink: 0;
            width: 2.75rem; height: 2.75rem; border-radius: 0;
            display: flex; align-items: center; justify-content: center;
            background: rgb(var(--ztims-primary-container));
        }
        .ztims-dialog__icon .material-symbols-outlined {
            color: rgb(var(--ztims-primary-text)) !important;
            font-size: 1.5rem;
        }
        .ztims-dialog--danger .ztims-dialog__icon { background: rgb(var(--ztims-error) / 0.12); }
        .ztims-dialog--danger .ztims-dialog__icon .material-symbols-outlined { color: rgb(var(--ztims-error)) !important; }

        .ztims-dialog__title {
            font-family: var(--ztims-font-display);
            font-size: 1.25rem; font-weight: 800; line-height: 1.25;
            letter-spacing: -0.01em;
            color: rgb(var(--ztims-on-surface));
            margin: 0.35rem 0 0;
            overflow-wrap: anywhere;
        }
        .ztims-dialog__message {
            font-size: 0.875rem; line-height: 1.55;
            color: rgb(var(--ztims-on-surface-variant));
            margin: 0.5rem 0 0;
            white-space: pre-line;
            overflow-wrap: anywhere;
        }

        .ztims-dialog__fields { display: flex; flex-direction: column; gap: 1rem; margin-top: 1.25rem; }
        .ztims-dialog__field label {
            display: block;
            font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
            color: rgb(var(--ztims-on-surface-variant));
            margin-bottom: 0.35rem;
        }
        .ztims-dialog__field label .ztims-dialog__optional { text-transform: none; font-weight: 400; letter-spacing: 0; }
        .ztims-dialog__help {
            font-size: 0.8125rem; line-height: 1.5;
            color: rgb(var(--ztims-on-surface-variant));
            margin: 0.35rem 0 0;
        }

        /* !important on the colour: the portal pages force every <p> to the
           on-surface colour in light mode, which would turn this red back to
           slate and leave only the tint saying something is wrong. */
        .ztims-dialog__error {
            display: none;
            font-size: 0.8125rem; line-height: 1.5;
            color: rgb(var(--ztims-error)) !important;
            background: rgb(var(--ztims-error) / 0.10);
            border: 1px solid rgb(var(--ztims-error) / 0.25);
            border-radius: 0;
            padding: 0.7rem 0.9rem;
            margin: 1rem 0 0;
            white-space: pre-line;
        }
        .ztims-dialog__error.is-visible { display: block; }

        .ztims-dialog__actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
        .ztims-dialog__actions .btn { flex: 1 1 0; min-width: 0; }

        @keyframes ztimsDialogScrimIn  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ztimsDialogScrimOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes ztimsDialogIn {
            from { opacity: 0; transform: translateY(0.6rem) scale(0.98); }
            to   { opacity: 1; transform: none; }
        }
        @keyframes ztimsDialogOut {
            from { opacity: 1; transform: none; }
            to   { opacity: 0; transform: translateY(0.4rem) scale(0.98); }
        }`;
        document.head.appendChild(style);
    }

    /* ---------------------------------------------------------- stacking
       Only the topmost dialog answers to Escape and traps Tab. The listener is
       attached while the first dialog opens and removed when the last closes,
       so with nothing open the page's own Escape handlers see every keypress
       exactly as before. */
    const stack = [];
    let idCounter = 0;

    function focusables(root) {
        return Array.from(root.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
            'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )).filter(node => node.offsetParent !== null);
    }

    function onKeydown(event) {
        const top = stack[stack.length - 1];
        if (!top) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            top.dismiss();
            return;
        }

        if (event.key === 'Tab') {
            const nodes = focusables(top.panel);
            if (!nodes.length) { event.preventDefault(); return; }
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !top.panel.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !top.panel.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    function push(entry) {
        if (!stack.length) document.addEventListener('keydown', onKeydown, true);
        stack.push(entry);
    }

    function remove(entry) {
        const index = stack.indexOf(entry);
        if (index !== -1) stack.splice(index, 1);
        if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
    }

    /* -------------------------------------------------------------- build */

    function makeButton(label, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn ' + className;
        button.textContent = label;
        return button;
    }

    function makeField(spec, index, dialogId) {
        const wrap = document.createElement('div');
        wrap.className = 'ztims-dialog__field';

        const inputId = dialogId + '-field-' + index;
        let label = null;
        if (spec.label) {
            label = document.createElement('label');
            label.setAttribute('for', inputId);
            label.textContent = spec.label;
            if (spec.optional) {
                const optional = document.createElement('span');
                optional.className = 'ztims-dialog__optional';
                optional.textContent = ' (optional)';
                label.appendChild(optional);
            }
        }

        const input = document.createElement('input');
        input.id = inputId;
        input.className = 'field';
        input.type = spec.type || 'text';
        input.name = spec.name || ('field' + index);
        input.value = spec.value === undefined || spec.value === null ? '' : String(spec.value);
        if (spec.placeholder) input.placeholder = spec.placeholder;
        if (spec.required) input.required = true;
        if (spec.minlength) input.minLength = spec.minlength;
        if (spec.maxlength) input.maxLength = spec.maxlength;
        input.autocomplete = spec.autocomplete || 'off';
        input.spellcheck = false;

        // A single unlabelled field (a prompt) is named by the dialog's title.
        if (label) wrap.appendChild(label);
        else input.setAttribute('aria-labelledby', dialogId + '-title');
        wrap.appendChild(input);

        if (spec.help) {
            const help = document.createElement('p');
            help.className = 'ztims-dialog__help';
            help.id = inputId + '-help';
            help.textContent = spec.help;
            input.setAttribute('aria-describedby', help.id);
            wrap.appendChild(help);
        }
        return { wrap, input };
    }

    /* The one builder behind all three. `kind` decides the icon and whether a
       form is drawn; `fields` (possibly empty) is what the form carries. */
    function open(options, kind) {
        injectStyles();

        const settings = options || {};
        const tone = settings.tone === 'danger' ? 'danger' : 'default';
        const fields = Array.isArray(settings.fields) ? settings.fields : [];
        const dialogId = 'ztims-dialog-' + (++idCounter);
        const opener = document.activeElement;

        return new Promise(resolve => {
            const scrim = document.createElement('div');
            scrim.className = 'ztims-dialog-scrim ztims-scrim';

            const panel = document.createElement('div');
            panel.className = 'ztims-modal ztims-dialog'
                + (tone === 'danger' ? ' ztims-dialog--danger' : '')
                + (fields.length > 1 ? ' ztims-dialog--wide' : '');
            panel.setAttribute('role', kind === 'confirm' ? 'alertdialog' : 'dialog');
            panel.setAttribute('aria-modal', 'true');
            panel.id = dialogId;

            // Icon, title, message
            const lead = document.createElement('div');
            lead.className = 'ztims-dialog__lead';

            const iconWrap = document.createElement('div');
            iconWrap.className = 'ztims-dialog__icon';
            iconWrap.setAttribute('aria-hidden', 'true');
            const icon = document.createElement('span');
            icon.className = 'material-symbols-outlined';
            icon.textContent = settings.icon || (tone === 'danger' ? ICONS.danger : ICONS[kind] || ICONS.default);
            iconWrap.appendChild(icon);

            const text = document.createElement('div');
            text.style.cssText = 'flex:1;min-width:0';

            const title = document.createElement('h2');
            title.className = 'ztims-dialog__title';
            title.id = dialogId + '-title';
            title.textContent = settings.title || (kind === 'confirm' ? 'Are you sure?' : 'Enter a value');
            text.appendChild(title);
            panel.setAttribute('aria-labelledby', title.id);

            if (settings.message) {
                const message = document.createElement('p');
                message.className = 'ztims-dialog__message';
                message.id = dialogId + '-message';
                message.textContent = settings.message;
                text.appendChild(message);
                panel.setAttribute('aria-describedby', message.id);
            }

            lead.appendChild(iconWrap);
            lead.appendChild(text);
            panel.appendChild(lead);

            // Fields, inside a form so Enter submits from any input
            const form = document.createElement('form');
            form.noValidate = true;
            const inputs = [];
            if (fields.length) {
                const list = document.createElement('div');
                list.className = 'ztims-dialog__fields';
                fields.forEach((spec, index) => {
                    const built = makeField(spec, index, dialogId);
                    inputs.push({ spec, input: built.input });
                    list.appendChild(built.wrap);
                });
                form.appendChild(list);
            }

            const error = document.createElement('p');
            error.className = 'ztims-dialog__error';
            error.setAttribute('role', 'alert');
            form.appendChild(error);

            // Actions
            const actions = document.createElement('div');
            actions.className = 'ztims-dialog__actions';
            // Not named `confirm`/`cancel`: check-undefined.cjs treats every
            // declared name as page-wide, and a local called `confirm` would
            // excuse the very browser call this file exists to replace.
            const cancelButton = makeButton(settings.cancelLabel || 'Cancel', 'btn-secondary');
            const confirmButton = makeButton(
                settings.confirmLabel || (kind === 'confirm' ? 'Confirm' : 'Save'),
                tone === 'danger' ? 'btn-danger' : 'btn-primary'
            );
            confirmButton.type = 'submit';
            actions.appendChild(cancelButton);
            actions.appendChild(confirmButton);
            form.appendChild(actions);
            panel.appendChild(form);

            scrim.appendChild(panel);

            let settled = false;
            const dismissed = kind === 'confirm' ? false : null;
            const entry = { panel, dismiss: () => finish(dismissed) };

            function showError(message) {
                error.textContent = message;
                error.classList.add('is-visible');
            }

            function close() {
                remove(entry);
                scrim.classList.add('is-closing');
                // Matches the exit animation; long enough for reduced-motion's
                // near-zero durations too, which only make it look instant.
                setTimeout(() => scrim.remove(), 160);
                if (opener && typeof opener.focus === 'function' && opener.isConnected) {
                    opener.focus();
                }
            }

            function finish(value) {
                if (settled) return;
                settled = true;
                close();
                resolve(value);
            }

            function collect() {
                if (kind === 'prompt') return inputs.length ? inputs[0].input.value : '';
                const values = {};
                inputs.forEach(item => { values[item.input.name] = item.input.value; });
                return values;
            }

            function submit(event) {
                if (event) event.preventDefault();
                if (settled) return;

                if (kind === 'confirm') { finish(true); return; }

                // Required and minimum length are checked here rather than by
                // the browser, so the message lands in the dialog's own error
                // box instead of a bubble drawn in the system style.
                for (const item of inputs) {
                    const value = item.input.value;
                    const trimmed = value.trim();
                    if (item.spec.required && !trimmed) {
                        showError((item.spec.label || 'This field') + ' is required.');
                        item.input.focus();
                        return;
                    }
                    if (item.spec.minlength && trimmed && trimmed.length < item.spec.minlength) {
                        showError((item.spec.label || 'This field') + ' must be at least ' + item.spec.minlength + ' characters.');
                        item.input.focus();
                        return;
                    }
                }

                const value = collect();
                if (typeof settings.validate === 'function') {
                    const problem = settings.validate(value);
                    if (problem) {
                        showError(String(problem));
                        if (inputs.length) inputs[0].input.focus();
                        return;
                    }
                }
                finish(value);
            }

            form.addEventListener('submit', submit);
            cancelButton.addEventListener('click', () => finish(dismissed));
            scrim.addEventListener('click', event => {
                if (event.target === scrim) finish(dismissed);
            });
            inputs.forEach(item => item.input.addEventListener('input', () => error.classList.remove('is-visible')));

            document.body.appendChild(scrim);
            push(entry);

            // Start on the input where there is one. Otherwise the confirming
            // button, except when it destroys something — then Cancel, so a
            // reflex Enter is the safe answer.
            const first = inputs.length ? inputs[0].input : (tone === 'danger' ? cancelButton : confirmButton);
            first.focus();
            if (inputs.length && first.value) first.select();
        });
    }

    function normalize(options, fallbackKey) {
        if (typeof options === 'string') {
            const out = {};
            out[fallbackKey] = options;
            return out;
        }
        return options || {};
    }

    window.ztimsDialog = {
        confirm(options) {
            return open(normalize(options, 'message'), 'confirm');
        },

        prompt(options) {
            const settings = normalize(options, 'title');
            const field = {
                name: 'value',
                label: settings.label || '',
                value: settings.value,
                placeholder: settings.placeholder,
                type: settings.type,
                help: settings.help,
                optional: settings.optional,
                required: settings.required,
                minlength: settings.minlength,
                maxlength: settings.maxlength,
                autocomplete: settings.autocomplete
            };
            return open(Object.assign({}, settings, { fields: [field] }), 'prompt');
        },

        form(options) {
            return open(options || {}, 'form');
        }
    };
})();
