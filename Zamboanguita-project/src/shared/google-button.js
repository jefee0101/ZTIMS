/* Google owns the button markup. Keep only its supported theme/width in sync. */
(function () {
const mounted = new WeakMap();

function renderGoogleButton(container) {
    mounted.get(container)?.();
    container.classList.add('ztims-google-button');
    let previous = '', frame = 0, disposed = false;
    function dispose() {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(frame);
        resize?.disconnect();
        theme.disconnect();
        mounted.delete(container);
    }
    function draw() {
        frame = 0;
        if (!container.isConnected) return dispose();
        const available = Math.floor(container.getBoundingClientRect().width);
        if (!available || !window.google?.accounts?.id) return;
        const width = Math.min(400, available);
        const buttonTheme = document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline';
        const key = buttonTheme + ':' + width;
        if (key === previous) return;
        previous = key;
        container.replaceChildren();
        window.google.accounts.id.renderButton(container, {
            type:'standard', theme:buttonTheme, size:'large', shape:'pill',
            text:'continue_with', logo_alignment:'center', width
        });
    }
    function schedule() {
        if (!disposed && !frame) frame = requestAnimationFrame(draw);
    }
    const resize = window.ResizeObserver ? new ResizeObserver(schedule) : null;
    const theme = new MutationObserver(schedule);
    resize?.observe(container);
    theme.observe(document.documentElement, {attributes:true,attributeFilter:['class']});
    mounted.set(container, dispose);
    schedule();
    return dispose;
}
window.ztimsGoogleButton = { render: renderGoogleButton };
})();
