/* The whole ZTIMS API, served as one Vercel Function.
 *
 * Vercel runs any file under /api as a function, and an Express app is
 * already the (req, res) handler a function needs, so this is the entire
 * entry point. vercel.json rewrites every /api/* path here; Express then sees
 * the original path (/api/spots, /api/login, ...) and routes it exactly as it
 * did on Render.
 *
 * The server itself stays in zamboanguita-backend/, unchanged in shape and
 * still runnable on its own with `npm start` — see the note at the bottom of
 * server.js for how it tells the two apart. Vercel traces this require and
 * ships server.js, db.js, models.js, rate-limit-store.js and the backend's
 * node_modules with the function.
 */
module.exports = require('../zamboanguita-backend/server');
