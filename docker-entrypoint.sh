#!/bin/sh
# Apply pending drizzle migrations, then exec the bot so it receives signals as PID 1.
set -e
node dist/migrate.js
exec node dist/index.js
