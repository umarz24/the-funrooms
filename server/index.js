/* ============================================================================
   THE FUNROOMS — co-op + store service
   One small Node process, deployed on Railway as a SECOND service alongside the
   static game. It does two unrelated jobs that happen to want the same box:

     1. A WebSocket relay for co-op rooms (2-4 players, 4-character room code).
        Authority model: every client simulates its own player; the HOST owns the
        floor number + seed and the creature positions. The server keeps no game
        state at all — it only tracks who is in which room and who the host is.

     2. Two HTTPS endpoints for Stripe coin purchases. The secret key lives here
        and never touches the browser. The webhook credits coins to the buyer's
        Supabase profile; the game picks them up on its next sync.

   Everything is optional and fails soft: with no Stripe keys the store endpoints
   return 503 and co-op still works; with no Supabase keys co-op still works.
   ========================================================================== */
"use strict";
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const STRIPE_SECRET   = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WH       = process.env.STRIPE_WEBHOOK_SECRET || "";
const SUPABASE_URL    = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const STORE_ON = !!(STRIPE_SECRET && SUPABASE_URL && SUPABASE_SERVICE);

let stripe = null, sb = null;
if (STORE_ON) {
  try {
    stripe = require("stripe")(STRIPE_SECRET);
    const { createClient } = require("@supabase/supabase-js");
    sb = createClient(SUPABASE_URL, SUPABASE_SERVICE, { auth: { persistSession: false } });
    console.log("store: enabled");
  } catch (e) {
    console.error("store: disabled —", e.message);
    stripe = null; sb = null;
  }
} else {
  console.log("store: disabled (set STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
}

/* ---------- coin packs. Prices in the smallest currency unit. ---------- */
const PACKS = {
  small:  { coins: 1000,  amount: 199,  name: "1,000 Funrooms coins"  },
  medium: { coins: 5500,  amount: 799,  name: "5,500 Funrooms coins"  },
  large:  { coins: 12000, amount: 1499, name: "12,000 Funrooms coins" },
};
const CURRENCY = process.env.CURRENCY || "usd";

/* ==========================================================================
   HTTP
   ========================================================================== */
function cors(res) {
  res.setHeader("access-control-allow-origin", process.env.ALLOW_ORIGIN || "*");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
  res.setHeader("access-control-allow-methods", "POST,OPTIONS");
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  if (url === "/health" || url === "/") {
    return json(res, 200, {
      ok: true, service: "funrooms", store: STORE_ON,
      rooms: rooms.size, players: totalPlayers()
    });
  }

  /* ---- start a Stripe Checkout session ---- */
  if (url === "/api/checkout" && req.method === "POST") {
    if (!STORE_ON) return json(res, 503, { error: "store not configured" });
    try {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) return json(res, 401, { error: "not signed in" });

      // Verify the Supabase JWT by asking Supabase who it belongs to.
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data || !data.user) return json(res, 401, { error: "invalid session" });
      const user = data.user;

      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const pack = PACKS[body.pack];
      if (!pack) return json(res, 400, { error: "unknown pack" });

      // Only ever return to a URL we were given by our own page, and only its origin.
      let back = "";
      try { const u = new URL(body.origin); back = u.origin + u.pathname; } catch (e) {}
      if (!back) return json(res, 400, { error: "bad origin" });

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: pack.amount,
            product_data: { name: pack.name },
          },
        }],
        client_reference_id: user.id,
        metadata: { user_id: user.id, coins: String(pack.coins), pack: body.pack },
        success_url: back + "?paid=1",
        cancel_url: back + "?paid=0",
      });
      return json(res, 200, { url: session.url });
    } catch (e) {
      console.error("checkout:", e.message);
      return json(res, 500, { error: "checkout failed" });
    }
  }

  /* ---- Stripe webhook: credit the coins ---- */
  if (url === "/api/stripe-webhook" && req.method === "POST") {
    if (!STORE_ON || !STRIPE_WH) { res.writeHead(503); res.end(); return; }
    let event;
    try {
      const raw = await readBody(req);
      event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], STRIPE_WH);
    } catch (e) {
      console.error("webhook signature:", e.message);
      res.writeHead(400); res.end("bad signature"); return;
    }
    // Ack immediately; Stripe retries on anything but a 2xx.
    res.writeHead(200); res.end("ok");

    if (event.type !== "checkout.session.completed") return;
    const s = event.data.object;
    const userId = (s.metadata && s.metadata.user_id) || s.client_reference_id;
    const coins = parseInt((s.metadata && s.metadata.coins) || "0", 10);
    if (!userId || !coins) return;

    try {
      // Idempotency: the same session id can arrive more than once.
      const { error: dup } = await sb.from("stripe_events")
        .insert({ id: s.id, user_id: userId, coins });
      if (dup) { console.log("webhook: already handled", s.id); return; }

      const { error } = await sb.rpc("add_credits", { uid: userId, n: coins });
      if (error) throw error;
      console.log("credited", coins, "to", userId);
    } catch (e) {
      console.error("credit failed:", e.message);
    }
    return;
  }

  cors(res);
  res.writeHead(404); res.end("not found");
});

/* ==========================================================================
   CO-OP WEBSOCKET RELAY
   ========================================================================== */
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const rooms = new Map();          // code -> { code, hostId, players: Map(id -> p) }
let nextId = 1;
const MAX_PLAYERS = 4;

function totalPlayers() { let n = 0; for (const r of rooms.values()) n += r.players.size; return n; }
function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(room, obj, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, obj);
}
function clean(s, n) { return String(s == null ? "" : s).slice(0, n); }

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  let me = null, room = null;

  ws.on("message", buf => {
    let m;
    try { m = JSON.parse(buf.toString("utf8")); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;

    /* ---- join / create ---- */
    if (m.t === "join") {
      if (me) return;
      const code = clean(m.code, 4).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 4) return send(ws, { t: "error", msg: "bad room code" });

      room = rooms.get(code);
      if (!room) {
        room = { code, hostId: null, players: new Map() };
        rooms.set(code, room);
      }
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "that room is full (4/4)" });

      me = {
        id: String(nextId++), ws,
        name: clean(m.name, 16) || "Player",
        cls: clean(m.cls, 20) || "explorer",
        floor: Math.max(1, Math.min(100, parseInt(m.floor, 10) || 1)),
      };
      room.players.set(me.id, me);

      // First one in owns the room. A later "host:true" doesn't steal it.
      const isFirst = room.hostId == null;
      if (isFirst) { room.hostId = me.id; room.seed = (m.seed >>> 0) || null; room.floor = me.floor; }

      send(ws, {
        t: "welcome", id: me.id, code, host: room.hostId === me.id,
        seed: room.seed, floor: room.floor,
        players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, cls: p.cls, floor: p.floor })),
      });
      broadcast(room, { t: "peer-join", id: me.id, name: me.name, cls: me.cls, floor: me.floor }, me.id);
      console.log("join", code, me.name, room.players.size + "/4");
      return;
    }

    if (!me || !room) return;

    /* ---- per-frame player state ---- */
    if (m.t === "state") {
      me.floor = parseInt(m.floor, 10) || me.floor;
      broadcast(room, {
        t: "peer-state", id: me.id,
        x: +m.x || 0, z: +m.z || 0, yaw: +m.yaw || 0,
        hp: +m.hp || 0, floor: me.floor,
      }, me.id);
      return;
    }

    /* ---- host-only: the floor everyone builds, and creature positions ---- */
    if (m.t === "floor" && room.hostId === me.id) {
      room.floor = Math.max(1, Math.min(100, parseInt(m.n, 10) || 1));
      room.seed = m.seed >>> 0;
      broadcast(room, { t: "floor", n: room.floor, seed: room.seed }, me.id);
      return;
    }
    if (m.t === "world" && room.hostId === me.id) {
      broadcast(room, m, me.id);
      return;
    }
    if (m.t === "event") {
      broadcast(room, { t: "event", kind: clean(m.kind, 20), text: clean(m.text, 120) }, me.id);
      return;
    }
  });

  ws.on("close", () => {
    if (!me || !room) return;
    room.players.delete(me.id);
    broadcast(room, { t: "peer-leave", id: me.id });
    if (room.players.size === 0) {
      rooms.delete(room.code);
      console.log("room closed", room.code);
      return;
    }
    if (room.hostId === me.id) {
      // Promote whoever has been in longest.
      room.hostId = room.players.keys().next().value;
      broadcast(room, { t: "host", id: room.hostId });
      console.log("host migrated in", room.code);
    }
  });
});

// Drop connections that stop answering, so rooms don't fill with ghosts.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

server.listen(PORT, () => console.log("funrooms service listening on " + PORT));
