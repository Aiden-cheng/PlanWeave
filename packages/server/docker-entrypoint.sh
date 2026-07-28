#!/bin/sh
set -eu

node /app/dist/containerPrepare.js

exec /usr/bin/setpriv \
  --reuid=node \
  --regid=node \
  --init-groups \
  --inh-caps +net_bind_service \
  --ambient-caps +net_bind_service \
  node /app/dist/bin.js serve
