/* One show / hide eye for every password field on the site, the same
   everywhere. It finds each <input type="password"> (those on the page and
   any a dialog adds later), wraps it and puts the eye at its right. Pages
   draw no eye of their own. Styles: .pw-eye* in theme.css. */
(function () {
    if (window.__ztimsPasswordEye) return;
    window.__ztimsPasswordEye = true;

    var SHOW = 'visibility', HIDE = 'visibility_off';

    function dress(input) {
        if (input.dataset.pwEye) return;
        input.dataset.pwEye = '1';
        var wrap = document.createElement('span');
        wrap.className = 'pw-eye';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        input.classList.add('pw-eye__input');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pw-eye__btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">' + SHOW + '</span>';
        btn.addEventListener('click', function () {
            var show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            btn.setAttribute('aria-pressed', show ? 'true' : 'false');
            btn.firstChild.textContent = show ? HIDE : SHOW;
            input.focus();
        });
        wrap.appendChild(btn);
    }

    function scan(root) {
        if (root.nodeType !== 1) return;
        if (root.matches && root.matches('input[type="password"]')) dress(root);
        var found = root.querySelectorAll ? root.querySelectorAll('input[type="password"]') : [];
        for (var i = 0; i < found.length; i++) dress(found[i]);
    }

    function start() {
        scan(document.body);
        new MutationObserver(function (list) {
            list.forEach(function (m) { m.addedNodes.forEach(scan); });
        }).observe(document.body, { childList: true, subtree: true });
    }
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
