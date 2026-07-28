FROM node:22-bookworm-slim

WORKDIR /app
COPY app/ ./
COPY docker-entrypoint.sh /usr/local/bin/planweave-server-entrypoint
RUN mkdir -p /run/planweave/input/config /run/planweave/input/tls /run/planweave/runtime /var/lib/planweave/projects \
  && chmod 755 /usr/local/bin/planweave-server-entrypoint

ENV PLANWEAVE_SERVER_CONFIG=/run/planweave/runtime/server.json
EXPOSE 443
ENTRYPOINT ["/usr/local/bin/planweave-server-entrypoint"]
