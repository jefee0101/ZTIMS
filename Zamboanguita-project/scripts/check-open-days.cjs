// The opening-days reader exists twice (the halves share no code): the server's
// decides what is sold, the pages' greys out days in the forms. This runs both on
// the same inputs and fails if they ever disagree. Skips without the backend.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backendFile = path.join(__dirname, '../../zamboanguita-backend/open-days.js');
if (!fs.existsSync(backendFile)) {
    console.log('– open days: no sibling backend checkout, skipped');
    process.exit(0);
}
const server = require(backendFile);
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/shared/open-days.js'), 'utf8'), sandbox);
const page = sandbox.window.ZTIMS_OPEN_DAYS;

const texts = ['', 'Everyday', 'Daily', 'Monday to Friday', 'Monday to Saturday', 'Weekends only', 'Wednesdays only',
    'Tuesday to Sunday', 'Mon–Fri', 'mon, wed & fri', 'Tues and Thurs', 'Fri to Mon', 'weekdays', 'Closed Mondays',
    'Open daily except Mondays', 'Monday to Saturday, closed Sundays', 'By appointment', 'Sunrise to sunset'];
for (let m = 1; m < 128; m++) texts.push(server.formatOpenDays(server.WEEK.filter((d, i) => m & (1 << i))));

let problems = 0;
for (const text of texts) {
    const a = JSON.stringify(server.parseOpenDays(text));
    const b = JSON.stringify(page.parseOpenDays(text));
    if (a !== b) { problems++; console.log(`✗ "${text}": server ${a}, page ${b}`); }
}
for (let m = 1; m < 128; m++) {
    const days = server.WEEK.filter((d, i) => m & (1 << i));
    if (server.formatOpenDays(days) !== page.formatOpenDays(days)) { problems++; console.log(`✗ format ${days}`); }
}
if (problems) { console.log(`✗ open days: the page and the server disagree ${problems} time(s)`); process.exit(1); }
console.log(`✓ open days agree — ${texts.length} texts, both sides`);
