/* Finds identifiers a page uses but never defines.
 *
 * Twice now a cleanup commit has removed a helper that sat in the same block as
 * the code being deleted, leaving the calls behind: completenessIssues and
 * photoCount on the Destinations page (which reported itself as a database
 * outage), and widthStep on Analytics (which silently broke the chart). Nothing
 * caught either, because these pages carry their JavaScript inline and no
 * linter ever sees it.
 *
 * Run it with:  npm run check
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const ROOT = path.resolve(__dirname, '..');

// alert, confirm and prompt are deliberately NOT here. The browser's own boxes
// were replaced by src/shared/ztims-dialog.js, so a bare call to one of them
// is a regression this check should report, not a global it should excuse.
const BUILTINS = new Set([
    'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
    'encodeURI', 'decodeURI', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math',
    'JSON', 'Promise', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'RegExp', 'Symbol', 'BigInt', 'Function', 'Proxy', 'Reflect', 'require', 'import',
    'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone',
    'btoa', 'atob', 'FormData', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
    'Headers', 'Request', 'Response', 'AbortController', 'Intl', 'console', 'document',
    'window', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'screen',
    'CustomEvent', 'Event', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
    'getComputedStyle', 'matchMedia', 'Image', 'Audio', 'Option', 'Node', 'Element',
    'HTMLElement', 'DOMParser', 'TextEncoder', 'TextDecoder', 'Notification', 'L', 'tailwind',
    'google', 'Chart', 'eval', 'undefined', 'NaN', 'Infinity', 'globalThis', 'self', 'top',
    'parent', 'frames', 'performance', 'crypto', 'indexedDB', 'AbortSignal'
]);

// Binding patterns introduce names in five shapes; missing any of them turns a
// perfectly-declared variable into a false "undefined" report.
function collectPattern(node, into) {
    if (!node) return;
    switch (node.type) {
        case 'Identifier': into.add(node.name); break;
        case 'ObjectPattern':
            node.properties.forEach(prop => {
                if (prop.type === 'RestElement') collectPattern(prop.argument, into);
                else collectPattern(prop.value, into);
            });
            break;
        case 'ArrayPattern':
            node.elements.forEach(element => collectPattern(element, into));
            break;
        case 'AssignmentPattern': collectPattern(node.left, into); break;
        case 'RestElement': collectPattern(node.argument, into); break;
        default: break;
    }
}

function collectScripts(html) {
    const out = [];
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) {
        if (/type\s*=\s*["']?(application\/json|text\/template)/i.test(m[1])) continue;
        out.push(m[2]);
    }
    return out;
}

// A page's own <script src="..."> files count as part of its scope: they run in
// the same window and register globals the inline scripts call.
function localScriptSources(file, html) {
    const out = [];
    const re = /<script[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
        const href = m[1];
        if (/^(https?:)?\/\//.test(href)) continue;          // CDN, not ours
        const resolved = path.resolve(path.dirname(file), href.split('?')[0]);
        if (fs.existsSync(resolved)) out.push(fs.readFileSync(resolved, 'utf8'));
    }
    return out;
}

function analyse(file) {
    const html = fs.readFileSync(file, 'utf8');
    const scripts = collectScripts(html).concat(localScriptSources(file, html));
    const defined = new Set();
    const called = new Map(); // name -> count
    const trees = [];

    for (const src of scripts) {
        let tree;
        try {
            tree = acorn.parse(src, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
        } catch (e) {
            return { file, parseError: e.message };
        }
        trees.push(tree);

        // Any binding introduced anywhere in the page counts as defined: these are
        // inline scripts sharing one global scope, plus locals inside closures.
        walk.full(tree, node => {
            if (node.type === 'FunctionDeclaration' && node.id) defined.add(node.id.name);
            if (node.type === 'VariableDeclarator') collectPattern(node.id, defined);
            if (node.type === 'ClassDeclaration' && node.id) defined.add(node.id.name);
            if (node.type === 'FunctionExpression' && node.id) defined.add(node.id.name);
            if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
                 node.type === 'ArrowFunctionExpression')) {
                node.params.forEach(param => collectPattern(param, defined));
            }
            // window.foo = ... and var foo = window.foo = ...
            if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
                node.left.object.type === 'Identifier' &&
                (node.left.object.name === 'window' || node.left.object.name === 'globalThis') &&
                node.left.property.type === 'Identifier') {
                defined.add(node.left.property.name);
            }
            if (node.type === 'CatchClause') collectPattern(node.param, defined);
            if (node.type === 'ImportDeclaration') {
                node.specifiers.forEach(spec => collectPattern(spec.local, defined));
            }
        });
    }

    // Identifiers only ever read, never declared. This is what catches a lost
    // `const widthStep = ...` — a call-only check walks straight past it.
    const read = new Map();

    for (const tree of trees) {
        walk.full(tree, node => {
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
                called.set(node.callee.name, (called.get(node.callee.name) || 0) + 1);
            }
            if (node.type === 'Identifier') return;   // handled via the parents below
        });

        // ancestor-aware pass: skip property names, labels and declaration targets
        walk.ancestor(tree, {
            Identifier(node, _state, ancestors) {
                const parent = ancestors[ancestors.length - 2];
                if (!parent) return;
                if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
                if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
                if (parent.type === 'VariableDeclarator' && parent.id === node) return;
                if (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
                    parent.type === 'ArrowFunctionExpression' || parent.type === 'ClassDeclaration') return;
                if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
                    parent.type === 'ContinueStatement') return;
                if (parent.type === 'MethodDefinition' && parent.key === node) return;
                read.set(node.name, (read.get(node.name) || 0) + 1);
            }
        });
    }

    const missing = [];
    for (const [name, count] of called) {
        if (defined.has(name) || BUILTINS.has(name)) continue;
        missing.push({ name, count, kind: 'call' });
    }
    for (const [name, count] of read) {
        if (defined.has(name) || BUILTINS.has(name) || called.has(name)) continue;
        missing.push({ name, count, kind: 'read' });
    }
    return { file, missing };
}

const files = [];
(function sweep(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sweep(full);
        else if (entry.name.endsWith('.html')) files.push(full);
    }
})(ROOT);

let bad = 0;
for (const file of files.sort()) {
    const result = analyse(file);
    const rel = path.relative(ROOT, file);
    if (result.parseError) {
        console.log(`PARSE FAIL  ${rel}: ${result.parseError}`);
        bad++;
        continue;
    }
    if (result.missing.length) {
        bad++;
        console.log(`MISSING     ${rel}`);
        for (const m of result.missing) {
            console.log(`              ${m.name}${m.kind === 'call' ? '()' : ''}  ×${m.count}  [${m.kind}]`);
        }
    }
}
console.log(`\n${files.length} pages scanned, ${bad} with problems`);
process.exit(bad ? 1 : 0);
