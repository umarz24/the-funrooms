# The Funrooms — backend

The game is still one self-contained HTML file with zero libraries and zero
external assets. Everything below is **dormant** until you paste keys into the
`NET` block at the top of `public/index.html`. With all four values blank the
game runs exactly as it always has, fully offline, saving to `localStorage`.

```js
const NET = {
  SUPABASE_URL:      "",   // https://xxxx.supabase.co
  SUPABASE_ANON_KEY: "",   // the anon / publishable key (safe to ship)
  WS_URL:            "",   // wss://funrooms-server.up.railway.app   (co-op)
  API_URL:           ""    // https://funrooms-server.up.railway.app (coin store)
};
```

> **None of this works inside the claude.ai artifact.** That sandbox blocks
> network calls to `supabase.co` and blocks WebSockets outright. Test every
> online feature on the Railway copy. The artifact stays the offline preview.

---

## 0. Ship it (do this first)

Run these **from inside this folder** — never from `C:\Users\<you>`, or git
will try to publish your entire home directory.

```powershell
cd <the folder this file is in>

& "C:\Program Files\Git\cmd\git.exe" init
& "C:\Program Files\Git\cmd\git.exe" add .
& "C:\Program Files\Git\cmd\git.exe" commit -m "The Funrooms"
& "C:\Program Files\Git\cmd\git.exe" branch -M main

# interactive — pick GitHub.com / HTTPS / Yes / Login with a web browser
& "C:\Program Files\GitHub CLI\gh.exe" auth login

& "C:\Program Files\GitHub CLI\gh.exe" repo create the-funrooms --public --source=. --remote=origin --push
```

`git` and `gh` are called by full path because neither is on PATH on this
machine. Check you're in the right place first: `git status` should list
`public/index.html`, not files from your Desktop.

Then Railway → **New Project** → **Deploy from GitHub repo** → pick
`the-funrooms`. It builds the root `Dockerfile` (Caddy serving `public/`).
→ **Settings → Networking → Generate Domain**. That URL is the game.

---

## 1. Leaderboard

1. Supabase → new project.
2. SQL editor → run `supabase/01_scores.sql`.
3. Paste `SUPABASE_URL` + `SUPABASE_ANON_KEY` into the `NET` block.
4. Commit, push. Railway redeploys.

Open **Top Runs** on the menu to confirm.

---

## 2. Accounts + cloud saves

1. SQL editor → run `supabase/02_accounts.sql`. (Run `01` first.)
2. Supabase → **Authentication → URL Configuration** → set **Site URL** to your
   Railway domain, and add it under **Redirect URLs** too. Magic links bounce
   off this — get it wrong and the link 404s.
3. Nothing else to paste. The same anon key drives it.

**How it behaves.** Sign-in is passwordless: the player types an email on the
class-select screen, gets a link, clicks it, and lands back in the game signed
in. Their save (best floor, coins, achievements, companions, Shop upgrades)
syncs to a `profiles` row as jsonb.

Signing in **merges** rather than overwrites — it takes the better of each
value and the union of the sets. So playing logged-out on a laptop and then
signing in never throws that progress away.

`02_accounts.sql` also makes leaderboard inserts auth-bound: a signed-in player
can only post rows as themselves. Anonymous runs still post with a null
`user_id`. If you'd rather require an account to appear on the leaderboard at
all, delete the `insert anonymous score` policy at the bottom of that file.

---

## 3. Co-op (2–4 players, room code)

This is a **second Railway service** off the same repo — the `server/` folder.

1. Railway → same project → **New** → **GitHub Repo** → `the-funrooms`.
2. That service's **Settings → Build**: set **Dockerfile Path** to
   `server/Dockerfile` and **Root Directory** to `server`.
3. **Settings → Networking → Generate Domain**.
4. Put that domain in the `NET` block twice — once as `wss://` for `WS_URL`,
   once as `https://` for `API_URL`. Commit, push.

Co-op needs **no** environment variables. It works the moment it's deployed.
Check `https://<that-domain>/health` — it should return JSON.

**How it works.** Everyone simulates their own player. The host is
authoritative for exactly two things: the floor number + seed, and creature
positions (broadcast 8× a second). Floors are generated from a seed rather than
`Math.random`, so every player builds a byte-identical maze. Damage stays local
— nobody dies to someone else's lag. If the host leaves, the longest-connected
player is promoted automatically.

Rooms are 4 characters, max 4 players, and vanish when the last player leaves.

**Known limits (v1):** no name tags floating over remote players, and creature
*state* (a sock mid-lunge, a mimic mid-chomp) isn't replicated — only positions
and deaths. Non-hosts see creatures glide rather than animate through phases.

---

## 4. Stripe coin purchases

Coins bought with money land in `profiles.credits`, which the game applies to
the player's balance as a **difference** on the next sync — so spending coins
between the purchase and the sync is never undone.

1. Create the Stripe account. Get the secret key
   (**Developers → API keys**).
2. Supabase → **Settings → API** → copy the **service role** key.
   *This key bypasses row-level security. It goes in Railway's environment
   only — never in `index.html`, never in the repo.*
3. On the **server** service in Railway → **Variables**:
   ```
   STRIPE_SECRET_KEY=sk_...
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
4. Stripe → **Developers → Webhooks → Add endpoint**:
   - URL: `https://<server-domain>/api/stripe-webhook`
   - Event: `checkout.session.completed`
   - Copy the signing secret → add `STRIPE_WEBHOOK_SECRET=whsec_...` to Railway.
5. Redeploy the server service.

The **Shop** screen then shows a coin top-up row to signed-in players. Packs
and prices live in `PACKS` at the top of `server/index.js` (defaults: 1,000 for
$1.99 / 5,500 for $7.99 / 12,000 for $14.99, in `CURRENCY`, default `usd`).

Purchases are idempotent — every handled checkout session id is recorded in
`stripe_events`, so a Stripe retry can't credit twice.

Test with Stripe in test mode and card `4242 4242 4242 4242` before flipping to
live keys.

---

## 5. The Shop (no backend needed)

Works offline, out of the box, on coins earned in game. Nine items:

| | item | effect |
|---|---|---|
| upgrade | Comfy Boots (×3) | +4% move speed per level |
| upgrade | Party Vest (×3) | +15 max HP per level |
| upgrade | Big Battery (×2) | flashlight drains 20% slower per level |
| upgrade | Coin Magnet (×2) | +1.2 m pickup reach per level |
| upgrade | Lucky Streak (×2) | +1 extra coin per coin |
| upgrade | Party Animal | a third companion slot |
| consumable | Emergency Cake | **Q** — heal 45 HP |
| consumable | Confetti Bomb | **R** — freeze everything within 6 m for 4s |
| consumable | Balloon Shield | auto-equips at run start, absorbs 3 hits |

Reachable from the menu and from the win/lose screens. Saved under
`funrooms_shop` in `localStorage` and carried in the cloud save.

---

## Files

```
public/index.html          the whole game
Caddyfile  Dockerfile  railway.json     static host (root service)
server/index.js           co-op WebSocket relay + Stripe endpoints
server/Dockerfile  server/package.json  server/railway.json
server/.env.example       what to put in Railway's Variables
supabase/01_scores.sql    leaderboard table
supabase/02_accounts.sql  profiles, credits, auth-bound scores
```

## Deploy order, short version

1. Push → Railway static service → domain. Game is live, offline-only.
2. `01_scores.sql` → paste 2 keys → leaderboard.
3. `02_accounts.sql` + auth redirect URLs → accounts and cloud saves.
4. Deploy `server/` → paste `WS_URL` + `API_URL` → co-op.
5. Stripe keys into the server's Variables → coin store.

Each step is independent. Stop at any point and everything before it keeps working.
