# The Funrooms

A first-person 3D maze game — *the backrooms, but fun*. Bright candy-party
aesthetic, 100 floors, and a Party Crasher who would very much like to reach you.

**The whole game is one HTML file.** `public/index.html` — WebGL + Canvas, zero
libraries, zero external assets, no build step. Open it in a browser and it runs.
That's deliberate: it loads instantly and deploys as a single file.

## What's in it

- **100 floors** across 5 colour zones, checkpoints every 10
- **8 classes** — Explorer, Cleaner, Ghost Buster, Potato, Magician, Hunter
  (pistol), Athlete (dash), Retired Veteran (bazooka)
- **~10 creatures** plus the Party Crasher; coins, Almond Water, flashlight + batteries
- **8 tameable companions** — Potato, Body, Agent Ax, Sir Reginald, Bitcrusher,
  Moth Larry, The Intern, Chonk
- **A coin Shop** — six permanent upgrades and three consumables, bought with
  coins earned in game. Works fully offline.
- **22 achievements**, local player name, everything saved to `localStorage`
- Party visuals: candy walls, bunting, balloons, falling confetti, disco lights,
  a slushie-splash exit beacon. Ambient music and SFX, all WebAudio-generated.

Optional, all dormant until you configure them (see `BACKEND.md`):
online leaderboard · accounts + cloud saves · 2–4 player co-op · Stripe coin store.

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move |
| `Shift` | sprint |
| drag, or `L` for shift-lock | look |
| `Space` / click | class ability |
| `F` | flashlight |
| `E` | take the exit |
| `Q` | Emergency Cake |
| `R` | Confetti Bomb |

## Run it locally

Just open `public/index.html` in a browser. Nothing to install.

Or serve it the way production does:

```bash
docker build -t funrooms .
docker run --rm -p 8080:8080 funrooms
# http://localhost:8080
```

## Deploy

Railway → **New Project** → **Deploy from GitHub repo** → it builds the root
`Dockerfile` (Caddy serving `public/`) → **Settings → Networking → Generate Domain**.

The co-op + store service in `server/` is a **separate** Railway service off the
same repo. Full walkthrough, in order, in **[BACKEND.md](BACKEND.md)**.

## Layout

```
public/index.html          the entire game
Caddyfile Dockerfile railway.json    static host (root service)
server/                    co-op WebSocket relay + Stripe endpoints (2nd service)
supabase/01_scores.sql     leaderboard table          — run first
supabase/02_accounts.sql   profiles, credits, auth-bound scores
BACKEND.md                 how to turn each online feature on
```

## First push

```powershell
cd <this folder>
& "C:\Program Files\Git\cmd\git.exe" init
& "C:\Program Files\Git\cmd\git.exe" add .
& "C:\Program Files\Git\cmd\git.exe" commit -m "The Funrooms"
& "C:\Program Files\Git\cmd\git.exe" branch -M main
& "C:\Program Files\GitHub CLI\gh.exe" repo create the-funrooms --public --source=. --remote=origin --push
```

Run `git init` **inside this folder** — never in `C:\Users\<you>`, or git will
try to publish your entire home directory.
