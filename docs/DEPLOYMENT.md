# Deploying to a cheap DigitalOcean droplet

## The direct answer (revised after actually measuring it)

**Building on a $4/512MB droplet is still a bad idea — never do that.** But *running* the
built image turns out to be much lighter than initial guidance here assumed: a real
Docker container, capped at a hard 512MB memory limit (`docker run --memory=512m`), 1
mediasoup worker, idled at **~46MB RSS** and stayed there after a full signaling-level load
pass (10 simulated clients — 1:1 call + an 8-person meeting exercising joins, chat,
reactions, moderation, mute, lock/unlock, kick). That's real measured data from this build,
not an estimate. So: **the $4 tier can comfortably *run* this for light MVP use** — the
constraint is entirely the build step, not the runtime. Still recommend $6/1GB as the floor
if you want headroom for real video load (this measurement is signaling-only — see the
caveat in "Realistic capacity" below) and don't want to think about it further.

Two specific problems, both addressed below:

1. **Building mediasoup's native worker needs more RAM than 512MB has.** The C++ worker
   (OpenSSL, libsrtp, usrsctp, abseil, all bundled and compiled from source at `npm install`
   time) took ~28 minutes and meaningfully more than 512MB of headroom to compile in this
   environment. On a 512MB droplet with no swap, that compile will very likely get
   OOM-killed partway through. **Fix: never `docker build` on the droplet.** Build the
   image somewhere with real RAM (your laptop, this sandbox, GitHub Actions/a CI runner),
   push it to a registry, and just `docker pull` on the droplet.
2. **A large mediasoup port range is unnecessary and heavy for a tiny box.** This service
   originally published `MEDIASOUP_MIN_PORT`–`MEDIASOUP_MAX_PORT` (a 5,000-port range) via
   Docker, which means thousands of iptables rules on container start — slow and wasteful
   for a droplet expecting a handful of concurrent participants. **Fixed**: the service now
   uses mediasoup's `WebRtcServer` API — every WebRTC transport on a worker shares one
   UDP+TCP port. With the default single worker (1 vCPU), that's **one port total**
   (`MEDIASOUP_WEBRTC_PORT`, default `44000`). `docker-compose.yml` also switched to
   `network_mode: host`, so there's no Docker port-publishing overhead at all.

## Build-off-box workflow

```bash
# On your laptop, or this sandbox, or CI — NOT the droplet:
docker build -t your-registry/call-service:latest .
docker push your-registry/call-service:latest

# On the droplet:
docker pull your-registry/call-service:latest
CALL_SERVICE_IMAGE=your-registry/call-service:latest docker compose up -d
```

No registry yet? `docker save call-service:latest | gzip > call-service.tar.gz`, `scp` it
to the droplet, `docker load < call-service.tar.gz` — works fine for a one-person MVP,
just more manual than a registry for repeat deploys.

## Droplet setup (one-time)

1. **Provision a swapfile before anything else.** Even the $6/1GB tier benefits — Node +
   mediasoup workers + coturn can spike transiently (a burst of simultaneous joins, GC
   pauses) and swap is the difference between a slow moment and an OOM kill:

   ```bash
   fallocate -l 1G /swapfile
   chmod 600 /swapfile
   mkswap /swapfile
   swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```

2. **Install Docker** (DigitalOcean's Docker marketplace image does this for you, or use
   Docker's official convenience script: `curl -fsSL https://get.docker.com | sh`).

3. **Open the firewall** — `ufw` or DO's Cloud Firewall, whichever you're using:

   | Port | Protocol | Purpose |
   |---|---|---|
   | 22 | TCP | SSH |
   | 443 (or your `PORT`) | TCP | Socket.IO / REST (put this behind TLS — see below) |
   | 44000 | UDP + TCP | mediasoup media (matches `MEDIASOUP_WEBRTC_PORT`; add one port per extra `MEDIASOUP_NUM_WORKERS`) |
   | 3478 | UDP + TCP | coturn STUN/TURN |
   | 5349 | TCP | coturn TURN-over-TLS |
   | 45000-45999 | UDP + TCP | coturn relay allocations (inherent to the TURN protocol — this range is coturn's, not mediasoup's, and can't be collapsed to one port the way mediasoup's could) |

4. **TLS**: put something in front of port 4000 that terminates TLS (Caddy or nginx with
   Let's Encrypt are the usual lightweight choices) — browsers require a secure context for
   `getUserMedia`, so plain `http://` from a real client won't work at all. This is outside
   `call-service` itself; add a `Caddyfile`/nginx config as a sibling to `docker-compose.yml`
   reverse-proxying `:4000` (WebSocket upgrade included) once you're ready — not included
   here since it depends on whether you're pointing a domain at the droplet yet.

5. **`.env`**: copy `.env.example`, fill in the vars that must not be left at their
   placeholder defaults (`SERVICE_CREDENTIALS` — one `apiKey:secretKey` pair per
   integrating service, `MEDIASOUP_ANNOUNCED_IP` — **the droplet's public IP**, `TURN_HOST`
   — same IP), and sync `TURN_SECRET` into `docker/coturn/turnserver.conf`'s
   `static-auth-secret` (see that file's own comments).

6. **On a $4/512MB droplet specifically**, also lower the Node heap cap in
   `Dockerfile`/`docker-compose.yml` — `NODE_OPTIONS=--max-old-space-size=192` instead of
   the default 256, and keep `MEDIASOUP_NUM_WORKERS=1` (it already defaults to `os.cpus()`,
   which is 1 on this tier, so no change needed there).

## Realistic capacity — what this actually buys you

Rough guidance, not a guarantee — actual limits depend on video resolution/bitrate more
than participant count:

| Droplet | RAM | Realistic MVP capacity |
|---|---|---|
| $4 (512MB, 1 vCPU) | measured ~46MB idle/signaling-load | Fine for demoing a 1:1 call or a small (2-5 person) meeting to real users, not just yourself — the process itself is lean. Where it'll actually struggle is CPU, not RAM: a shared 1 vCPU doing real SRTP encrypt/decrypt for several simultaneous video streams will bottleneck before memory does. Audio-only or a couple of video tiles is the realistic ceiling. |
| $6 (1GB, 1 vCPU) | comfortable | Same CPU ceiling as the $4 tier (still 1 shared vCPU) but with headroom to not think about memory at all; a handful of concurrent 1:1 calls or one ~5-8 person video meeting. |
| $12 (2GB, 2 vCPU) | real headroom | `MEDIASOUP_NUM_WORKERS` naturally becomes 2 (one per core) — this is the first tier where CPU, not just RAM, meaningfully improves; several concurrent meetings, or one meeting in the 10-20 person range. |

**The measured 46MB figure is signaling-only** — connections, joins, chat, reactions,
moderation, transport/producer/consumer *request* handling — not sustained real audio/video
RTP flow, which costs real CPU (SRTP crypto, RTP forwarding) that a signaling-level test
can't surface. Treat the RAM numbers above as solid; treat "how many simultaneous video
streams" as the thing to test with a real call before trusting it further.

None of these tiers get anywhere near the spec's "500+ participants in one room" — that
needs a proper multi-core (or multi-instance) box and is a different conversation from "cheap
MVP droplet." The architecture supports scaling up (more workers on a bigger box) and out
(more instances + Redis, see the README's horizontal-scaling section) — it just isn't
free, and a $4-6 droplet was never going to demonstrate it.

## What to actually run

```bash
cd /opt/call-service   # wherever you cloned/copied the repo
cp .env.example .env   # fill in the required vars
docker compose up -d
docker compose logs -f call-service   # confirm workers start, no crash loop
curl localhost:4000/health
```

Then do one real two-browser call before trusting it — see the main README's "What was and
wasn't tested" section. Nothing in this deployment guide changes that: it only makes the
box the service runs on affordable, not the media path itself proven.
