#!/usr/bin/env node
/* The country list exists twice: with names in src/shared/countries.js for the
   browser, and as codes alone in the backend's server.js, which validates what
   the browser sends. They deploy to different hosts and cannot share a file.

   If they drift, the failure is quiet and nasty: the booking form offers a
   country, the visitor picks it, and the API answers "that is not a country
   ZTIMS recognises" — with nothing on either side to say which list is wrong.

   This compares them. Run by `npm run check`. */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.join(ROOT, 'src/shared/countries.js');
const BACKEND = path.resolve(ROOT, '../zamboanguita-backend/server.js');

function fail(message) {
    console.error('✗ ' + message);
    process.exit(1);
}

if (!fs.existsSync(BACKEND)) {
    // The frontend is deployable on its own, so a missing backend checkout is
    // not an error here — there is simply nothing to compare against.
    console.log('· backend not in this checkout, skipping the country cross-check');
    process.exit(0);
}

/* Both sides are read by evaluating just the string literal that holds the list,
   never the file. Nothing else in either file runs. */
function literalAfter(source, marker, label) {
    const at = source.indexOf(marker);
    if (at === -1) fail(`could not find ${label} — has ${marker} been renamed?`);
    const rest = source.slice(at + marker.length);
    const end = rest.indexOf(';');
    if (end === -1) fail(`could not read ${label}`);
    const expression = rest.slice(0, end).replace(/\)\s*\.trim\(\)[\s\S]*$/, ')');
    try {
        // eslint-disable-next-line no-eval
        return String(eval(expression));
    } catch (error) {
        fail(`could not parse ${label}: ${error.message}`);
    }
}

const frontSource = fs.readFileSync(FRONTEND, 'utf8');
const backSource = fs.readFileSync(BACKEND, 'utf8');

const packed = literalAfter(frontSource, 'var PACKED =', 'the frontend country list');
const frontCodes = packed.split('|').map(entry => entry.slice(0, entry.indexOf(':')));
const frontNames = packed.split('|').map(entry => entry.slice(entry.indexOf(':') + 1));

const backCodes = literalAfter(backSource, 'const COUNTRY_CODES = new Set(', 'the backend country codes')
    .trim().split(/\s+/);

let problems = 0;
function check(ok, message) {
    if (!ok) { console.error('  ✗ ' + message); problems++; }
}

check(frontCodes.length > 200, `the frontend list looks truncated (${frontCodes.length} entries)`);
check(new Set(frontCodes).size === frontCodes.length, 'the frontend list has a duplicate code');
check(new Set(backCodes).size === backCodes.length, 'the backend list has a duplicate code');
check(frontCodes.every(code => /^[A-Z]{2}$/.test(code)), 'a frontend code is not two capitals');
check(backCodes.every(code => /^[A-Z]{2}$/.test(code)), 'a backend code is not two capitals');
check(frontNames.every(name => name.length > 0), 'a frontend entry has no name');

const backSet = new Set(backCodes);
const frontSet = new Set(frontCodes);
const offeredButRejected = frontCodes.filter(code => !backSet.has(code));
const acceptedButUnlisted = backCodes.filter(code => !frontSet.has(code));

check(offeredButRejected.length === 0,
    `the form offers codes the API would reject: ${offeredButRejected.join(', ')}`);
check(acceptedButUnlisted.length === 0,
    `the API accepts codes the form never offers: ${acceptedButUnlisted.join(', ')}`);

// The one code that must be there, in a system for a Philippine municipality.
check(frontSet.has('PH') && backSet.has('PH'), 'PH is missing from one of the lists');

if (problems) {
    console.error(`\n✗ the two country lists disagree (${problems} problem${problems === 1 ? '' : 's'})`);
    process.exit(1);
}
console.log(`✓ country lists agree — ${frontCodes.length} countries, both sides`);
