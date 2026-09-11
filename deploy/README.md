# Deploying dispatcher-api on the OzServer VPS

Runs as a **separate** stack alongside OzServer-API. It shares only the host and Caddy;
its containers, network, deploy timer and lock file are all its own, so it cannot collide
with `ozserver-api`.

| | ozserver-api | dispatcher-api |
| --- | --- | --- |
| Dir | `/opt/ozserver-api` | `/opt/aed-dispatcher` |
| Compose project | `ozserver-api` | `aed-dispatcher` |
| Host bind | `127.0.0.1:3000` | `127.0.0.1:3100` |
| Caddy site | `api.ozserver.org` | `dispatcher.actuallyleviticus.xyz` |
| Deploy unit | `ozserver-deploy` | `aed-dispatcher-deploy` |
| Deploy lock | its own | `/tmp/aed-dispatcher-deploy.lock` |

## Quick setup — bare IP (what the app defaults to)

The desktop app v0.4.0+ defaults its sync server to **`ws://139.99.195.169:3100/ws`**, so
you just need the container reachable on port 3100.

```bash
# 1. Code
sudo mkdir -p /opt/aed-dispatcher && sudo chown "$USER" /opt/aed-dispatcher
git clone <repo-url> /opt/aed-dispatcher        # repo whose root is this API/ tree
cd /opt/aed-dispatcher

# 2. Secrets (outside git, preserved across deploys)
umask 077
cp .env.example .env
# leave API_TOKENS blank for now, ALLOWED_ORIGINS=*
chmod 600 .env

# 3. Run (compose.yaml already publishes 3100 on all interfaces)
docker compose up -d --build
curl -fsS http://127.0.0.1:3100/health          # -> {"status":"ok",...}

# 4. Open the firewall
sudo ufw allow 3100/tcp        # or: OVH firewall / iptables

# 5. From another machine:  curl http://139.99.195.169:3100/health
```

No DNS or Caddy needed for the IP form. Downsides: plain `ws://` (unencrypted) and
anyone who finds the port can connect — fine for testing, add a token + TLS before real use.

### Later: proper hostname + TLS (`wss://`)

1. **Cloudflare DNS**: add an **A record** — name `dispatcher`, content `139.99.195.169`,
   **Proxy status: DNS only (grey cloud)**. (Orange-cloud proxying only forwards
   80/443/2053/2083/2087/2096/8443 and needs origin TLS, so grey cloud + Caddy is simplest.)
2. In `compose.yaml` change the port back to `"127.0.0.1:3100:3100"`.
3. Append `Caddyfile.snippet` (hostname `dispatcher.actuallyleviticus.xyz`) to the VPS
   Caddyfile and `sudo systemctl reload caddy` — Caddy gets the cert automatically.
4. Set the app's Sync server to `wss://dispatcher.actuallyleviticus.xyz/ws`.

## Desktop app update feed

The desktop app auto-updates from a static folder on this host, served by Caddy at
`https://dispatcher.actuallyleviticus.xyz/updates`. It is just files — no service, no
container — but it **requires the hostname above**, because the feed url is compiled into
every build at package time and cannot be changed afterwards from the server side.

```bash
sudo mkdir -p /opt/aed-dispatcher/updates
sudo chown "$USER" /opt/aed-dispatcher/updates
```

Then take the "proper hostname + TLS" steps below (Cloudflare A record, grey cloud, plus
`Caddyfile.snippet`) — the snippet now carries both the `/updates/*` file server and the
`reverse_proxy` to the API in one site block.

Releases are pushed from a developer machine with `npm run release` in `Desktop App/`,
which scp's the installer, its blockmap and `latest.yml` into that folder in that order.
Full loop: [`RELEASING.md`](https://github.com/RealLeviticus/Aus-Emergency-Dispatcher/blob/main/RELEASING.md).

```bash
curl -s https://dispatcher.actuallyleviticus.xyz/updates/latest.yml    # what installs see
du -sh /opt/aed-dispatcher/updates                                     # ~80 MB per release
```

Nothing prunes old releases; delete stale `.exe`s by hand, but never the one named by the
current `latest.yml`.

## Pull-based auto-deploy

Installed and running since 2026-09-12: the timer checks `origin/main` every two minutes and
redeploys only when it has moved.

```bash
sudo install -m 644 deploy/aed-dispatcher-deploy.service /etc/systemd/system/
sudo install -m 644 deploy/aed-dispatcher-deploy.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aed-dispatcher-deploy.timer

# The service runs as root, but the clone is owned by the login user. git refuses to
# touch a repo owned by someone else, so without this every timed run dies with
# "detected dubious ownership" and exit 128 — while the same script run by hand under
# sudo works fine, because sudo leaves HOME pointing at the owning user's gitconfig.
sudo git config --system --add safe.directory /opt/aed-dispatcher
```

Do not `chmod +x deploy/deploy.sh` on the server: the mode is committed (100755), and
`deploy.sh` git-resets the worktree, so a local-only chmod is undone by the first
successful deploy and the next run breaks again.

Check it works — the run should end `deploy ok: <sha>`, or exit silently when there is
nothing new:

```bash
sudo systemctl start aed-dispatcher-deploy.service
systemctl show aed-dispatcher-deploy.service -p Result -p ExecMainStatus
systemctl list-timers aed-dispatcher-deploy.timer
```

## Operating

```bash
sudo systemctl start aed-dispatcher-deploy      # deploy now instead of waiting
journalctl -u aed-dispatcher-deploy -n 50       # what recent deploys did
docker compose -p aed-dispatcher logs api --tail 100
```

A push to `main` is picked up within ~2 min: `git fetch → reset → up -d --build →
/health check`. If `/health` is not `"status":"ok"` within ~60 s the script resets to the
previous commit and rebuilds, so a bad push leaves the previous version serving.

## Resource note

One extra Node/Fastify container, no database yet — roughly 80–150 MB RAM on top of
OzServer. Adding the Postgres service later adds ~150–250 MB; check `free -m` before
enabling it. If the VPS is at 1 GB, run dispatcher-api against a new database *inside the
existing Postgres* instead of a second container.
