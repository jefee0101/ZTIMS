# The API image, for a container host (Northflank, Cloud Run, Fly, anything).
#
# Build context is this directory, NOT the repository root. The root carries a
# leftover package.json from an abandoned Supabase prototype, and a build that
# picks that one up installs the wrong dependencies and starts nothing. Any
# host running this must be pointed at `zamboanguita-backend` as its context.

FROM node:22-alpine

WORKDIR /app

# The manifest and lockfile on their own first, so this layer — the slow one —
# is reused on every deploy that does not change a dependency. Copying the
# whole tree first would reinstall from scratch on every source edit.
COPY package.json package-lock.json ./

# `ci` rather than `install`: it installs exactly the lockfile and fails if the
# two disagree, so a deploy can never quietly resolve a different version than
# the one that was tested. `--omit=dev` leaves nodemon out of the image.
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

# server.js reads process.env.PORT and falls back to 5000. Pinning it here means
# the host's port setting and the app's bind cannot drift apart — set the
# service's port to 8080 to match.
ENV PORT=8080
EXPOSE 8080

# Nothing here writes to disk (photos go browser → Cloudinary, never through
# this API), so the process has no reason to run as root.
USER node

CMD ["node", "server.js"]
