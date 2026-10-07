/* What makes a staff password acceptable, and how ZTIMS makes one up.
 *
 * Every place a password is set — chosen by its owner, issued by an officer,
 * or set through a reset link — asks passwordProblem() first, so the rule is
 * the same everywhere. Passwords already in use are not affected: the rule is
 * checked when a password is set, never at sign-in.
 *
 * The rule follows current guidance (NIST SP 800-63B): length, and not one of
 * the passwords people guess first. No forced mix of symbols and no expiry,
 * which only push people towards "Password1!" and sticky notes.
 */
const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 10;
// bcrypt reads only the first 72 bytes; anything after would be ignored silently.
const MAX_PASSWORD_BYTES = 72;

// The most-guessed passwords that are 10 characters or longer.
const COMMON = new Set([
    '1234567890', '0987654321', '12345678910', '123456789a', 'a123456789', '1q2w3e4r5t', 'q1w2e3r4t5',
    '1qaz2wsx3edc', 'qwertyuiop', 'asdfghjkl;', 'zxcvbnm123', 'iloveyou12', 'iloveyou123', 'password12',
    'password123', 'password1234', 'password01', 'passw0rd123', 'p@ssw0rd123', 'qwerty1234', 'qwerty12345',
    'qwerty123456', 'abcdefghij', 'abcd123456', 'abc1234567', 'abcdef1234', 'welcome123', 'welcome1234',
    'letmein123', 'changeme123', 'admin12345', 'admin123456', 'administrator', 'superadmin', 'qazwsxedc123',
    'football123', 'baseball123', 'sunshine123', 'princess123', 'iloveyou!!', 'trustno1234', 'starwars123',
    'pokemon1234', 'basketball', 'basketball1', 'basketball123', 'philippines', 'philippines1', 'pilipinas123',
    'mabuhay123', 'mahalkita123', 'iloveyou143', '143iloveyou', 'tourism123', 'tourism2026', 'tourism2025'
]);

// Words that, with only digits and symbols added, make a password anyone would
// try first against this site: its own names, the place, and the usual suspects.
const GUESSABLE_WORDS = new Set([
    'password', 'passw', 'pass', 'zamboanguita', 'zamboangita', 'ztims', 'tourism', 'tourist', 'tourismoffice',
    'admin', 'administrator', 'officer', 'manager', 'guide', 'touristguide', 'municipal', 'municipality',
    'negros', 'negrosoriental', 'oriental', 'dumaguete', 'philippines', 'pilipinas', 'mabuhay', 'welcome',
    'qwerty', 'qwertyuiop', 'asdf', 'asdfghjkl', 'zxcvbnm', 'letmein', 'iloveyou', 'mahalkita', 'changeme',
    'secret', 'abc', 'abcd', 'abcdef', 'abcdefgh', 'abcdefghij', 'login', 'user', 'test', 'default'
]);

/* Why this password will not do, or null when it is acceptable. `email` is the
   account's sign-in, which a password should not simply repeat. */
function passwordProblem(password, { email } = {}) {
    const value = typeof password === 'string' ? password : '';
    if (value.length < MIN_PASSWORD_LENGTH) {
        return `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
        return `A password can be at most ${MAX_PASSWORD_BYTES} characters.`;
    }
    const lower = value.toLowerCase();
    const letters = lower.replace(/[^a-z]/g, '');
    const local = String(email || '').toLowerCase().split('@')[0].replace(/[^a-z0-9]/g, '');
    const tooEasy = COMMON.has(lower)
        || GUESSABLE_WORDS.has(letters)
        || /^(.{1,4})\1+$/.test(value)                       // aaaaaaaaaa, 1212121212, abcabcabca
        || '01234567890123456789'.includes(value)            // a run of digits
        || '98765432109876543210'.includes(value)
        || (local.length >= 4 && lower.replace(/[^a-z0-9]/g, '').includes(local));
    return tooEasy
        ? 'That password is too easy to guess. Avoid common words, the site\'s or the town\'s name, your email, and number sequences.'
        : null;
}

// No 0/O, 1/l/I: these passwords are read off a screen and typed in by someone else.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/* A random 12-character password for an account someone else is setting up.
   55^12 ≈ 7 × 10^20 possibilities; its owner replaces it at first sign-in. */
function generatePassword(length = 12) {
    let password = '';
    for (let i = 0; i < length; i += 1) password += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return passwordProblem(password) ? generatePassword(length) : password;
}

module.exports = { passwordProblem, generatePassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES };
