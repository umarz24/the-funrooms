# Static host for the game: Caddy serving public/ as one file.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY public/ /srv/

EXPOSE 8080
# The base image's default CMD already runs:
#   caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
