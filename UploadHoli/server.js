require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fetchImpl = global.fetch || require("node-fetch");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const WISHES_FILE = path.resolve(process.env.WISHES_FILE || path.join(__dirname, "wishes.json"));
const wishesStore = new Map();
const ADMIN_PIN = (process.env.ADMIN_PIN || "19102006").trim();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 80);
const MAX_WISHES_PER_HOUR_PER_IP = Number(process.env.MAX_WISHES_PER_HOUR_PER_IP || 30);
const requestRateStore = new Map();
const wishCreateRateStore = new Map();

let spotifyToken = "";
let spotifyTokenExp = 0;
let tokenSource = "none";

const ALLOWED_MOODS = new Set([
  "Romantic",
  "Sorry",
  "Friendship",
  "Crush",
  "Funny",
  "Breakup",
  "Celebration"
]);
const ALLOWED_FESTIVALS = new Set([
  "Holi",
  "Diwali",
  "Christmas",
  "New Year",
  "Eid",
  "Raksha Bandhan"
]);
const ALLOWED_THEMES = new Set([
  "holi",
  "sunset",
  "emerald",
  "royal",
  "neon-love",
  "dark-romance",
  "cute-pastel",
  "minimal"
]);
const ALLOWED_AUDIENCES = new Set([
  "friend",
  "crush",
  "partner",
  "sibling",
  "family",
  "colleague",
  "classmate",
  "community"
]);
const ALLOWED_VISIBILITY = new Set(["public", "private"]);
const AUDIENCE_LABELS = {
  friend: "best friend",
  crush: "crush",
  partner: "partner",
  sibling: "sibling",
  family: "family member",
  colleague: "colleague",
  classmate: "classmate",
  community: "community"
};
const ALLOWED_REACTIONS = new Set(["love", "funny", "emotional", "romantic"]);
const REACTION_LABELS = {
  love: "Loved it",
  funny: "Funny",
  emotional: "Emotional",
  romantic: "Romantic"
};
const DAILY_MOOD_PROMPTS = [
  { mood: "Friendship", prompt: "Send a card to your best friend today." },
  { mood: "Romantic", prompt: "Tell someone special how much they matter." },
  { mood: "Funny", prompt: "Send one joke-style wish to make someone laugh." },
  { mood: "Sorry", prompt: "Patch up a bond with a sincere apology card." },
  { mood: "Celebration", prompt: "Celebrate a small win with your circle." },
  { mood: "Crush", prompt: "Drop a subtle, sweet message to your crush." },
  { mood: "Breakup", prompt: "Send a healing message to someone moving on." }
];
const RANDOM_CONFESSIONS = [
  "I still check their last seen even after saying I moved on.",
  "I sent a meme instead of saying sorry. It worked somehow.",
  "I like someone from my class but never said it.",
  "I pretend to be chill, but I replay old chats at night.",
  "I keep screenshots of conversations that made me feel seen.",
  "I wrote a long apology and deleted it five times before sending.",
  "I laugh in group chats, but most days I feel invisible.",
  "I said I was busy, but I was just scared to reply."
];
const ANON_PREFIXES = ["Hidden", "Silent", "Midnight", "Velvet", "Mystic", "Secret", "Neon", "Cosmic"];
const ANON_SUFFIXES = ["Rang", "Splash", "Spark", "Echo", "Whisper", "Glow", "Mask", "Note"];

function sanitizeBrokenProxyEnv() {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  keys.forEach((k) => {
    const v = (process.env[k] || "").trim();
    if (v.includes("127.0.0.1:9")) {
      delete process.env[k];
    }
  });
}

sanitizeBrokenProxyEnv();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Pin");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "holihub",
    now: new Date().toISOString()
  });
});

function clientKey(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || "unknown";
}

function bumpRateWindow(store, key, now, windowMs) {
  const current = store.get(key);
  if (!current || now - current.windowStart > windowMs) {
    const next = { windowStart: now, count: 1 };
    store.set(key, next);
    return next;
  }
  current.count += 1;
  store.set(key, current);
  return current;
}

app.use((req, res, next) => {
  const now = Date.now();
  const ip = clientKey(req);
  const key = `${ip}:${req.method}:${req.path}`;
  const data = bumpRateWindow(requestRateStore, key, now, RATE_LIMIT_WINDOW_MS);
  if (data.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: "rate_limited",
      message: "Too many requests. Please retry shortly."
    });
  }
  next();
});

function makeWishId() {
  return Math.random().toString(36).slice(2, 10);
}

function trimText(value, maxLen) {
  return String(value || "").trim().slice(0, maxLen);
}

function getProvidedAdminPin(req) {
  const fromHeader = trimText(req.get("x-admin-pin") || "", 64);
  const fromQuery = trimText(req.query.pin || "", 64);
  if (fromHeader) return fromHeader;
  if (fromQuery) return fromQuery;
  return "";
}

function isSpamText(value) {
  const v = String(value || "");
  if (!v) return false;
  if (/(https?:\/\/|www\.)/i.test(v)) return true;
  if (/([!?.,])\1{5,}/.test(v)) return true;
  if (/(.)\1{14,}/.test(v)) return true;
  return false;
}

function safePick(value, allowed, fallback) {
  const v = trimText(value, 60);
  if (allowed.has(v)) return v;
  return fallback;
}

function normalizeReactions(raw) {
  const base = { love: 0, funny: 0, emotional: 0, romantic: 0 };
  if (!raw || typeof raw !== "object") return base;
  for (const k of Object.keys(base)) {
    base[k] = Math.max(0, Number(raw[k] || 0));
  }
  return base;
}

function wishReactionTotal(wish) {
  return Object.values(normalizeReactions(wish?.reactions)).reduce((sum, value) => sum + Number(value || 0), 0);
}

function wishEngagementScore(wish) {
  return Number(wish?.views || 0) * 1.7 + wishReactionTotal(wish) * 4;
}

function topCountEntry(mapLike) {
  const entries = Object.entries(mapLike || {});
  if (!entries.length) return { key: "", count: 0 };
  const [key, count] = entries.sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0];
  return { key, count: Number(count || 0) };
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function buildAnonymousAlias(rawAlias) {
  const alias = trimText(rawAlias || "", 40).replace(/\s+/g, " ");
  if (alias) return alias;
  return `${randomFrom(ANON_PREFIXES)} ${randomFrom(ANON_SUFFIXES)}`;
}

function hashAccessCode(value) {
  const normalized = trimText(value || "", 64);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function getProvidedAccessCode(req) {
  const fromHeader = trimText(req.get("x-wish-code") || "", 64);
  const fromQuery = trimText(req.query.access || "", 64);
  if (fromHeader) return fromHeader;
  if (fromQuery) return fromQuery;
  return "";
}

function isWishExpired(wish) {
  if (!wish?.expiresAt) return false;
  const ts = Date.parse(wish.expiresAt);
  return Number.isFinite(ts) && Date.now() > ts;
}

function isWishPubliclyListed(wish) {
  return (wish?.visibility || "public") === "public" && !isWishExpired(wish);
}

function wishRequiresAccessCode(wish) {
  return !!(wish?.accessCodeHash && String(wish.accessCodeHash).trim());
}

function validateWishAccess(req, wish) {
  if (!wish) {
    return { ok: false, status: 404, body: { error: "wish_not_found" } };
  }
  if (isWishExpired(wish)) {
    return { ok: false, status: 410, body: { error: "wish_expired", message: "This greeting link has expired." } };
  }
  if ((wish.visibility || "public") === "private" && wishRequiresAccessCode(wish)) {
    const providedCode = getProvidedAccessCode(req);
    if (!providedCode || hashAccessCode(providedCode) !== wish.accessCodeHash) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "wish_access_code_required",
          message: "This private greeting requires an access code.",
          accessCodeRequired: true,
          visibility: "private"
        }
      };
    }
  }
  return { ok: true };
}

function toPublicWish(wish) {
  const anonymous = !!wish?.anonymous;
  return {
    ...wish,
    senderName: anonymous ? "" : (wish?.senderName || ""),
    senderDisplayName: anonymous
      ? buildAnonymousAlias(wish?.anonymousAlias || wish?.senderDisplayName || "")
      : (wish?.senderName || "Friend"),
    anonymousAlias: anonymous ? buildAnonymousAlias(wish?.anonymousAlias || wish?.senderDisplayName || "") : "",
    anonymous,
    accessCodeHash: undefined,
    accessCodeRequired: wishRequiresAccessCode(wish),
    expired: isWishExpired(wish)
  };
}

function loadWishesFromDisk() {
  try {
    if (!fs.existsSync(WISHES_FILE)) return;
    const raw = fs.readFileSync(WISHES_FILE, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    for (const wish of list) {
      if (!wish || !wish.id) continue;
      const normalized = {
        ...wish,
        category: safePick(wish.category, new Set(["Mood", "Festival"]), "Festival"),
        mood: safePick(wish.mood, ALLOWED_MOODS, "Celebration"),
        festival: safePick(wish.festival, ALLOWED_FESTIVALS, "Holi"),
        audience: safePick(wish.audience, ALLOWED_AUDIENCES, "friend"),
        visibility: safePick(wish.visibility, ALLOWED_VISIBILITY, "public"),
        theme: safePick(wish.theme, ALLOWED_THEMES, "holi"),
        anonymous: !!wish.anonymous,
        anonymousAlias: wish.anonymous ? buildAnonymousAlias(wish.anonymousAlias || wish.senderDisplayName || "") : "",
        accessCodeHash: trimText(wish.accessCodeHash || "", 128),
        expiresAt: trimText(wish.expiresAt || "", 40),
        views: Number(wish.views || 0),
        reactions: normalizeReactions(wish.reactions)
      };
      normalized.senderDisplayName = normalized.anonymous
        ? buildAnonymousAlias(normalized.anonymousAlias || normalized.senderDisplayName || "")
        : (normalized.senderName || "");
      wishesStore.set(String(normalized.id), normalized);
    }
  } catch (_) {}
}

function persistWishesToDisk() {
  try {
    fs.mkdirSync(path.dirname(WISHES_FILE), { recursive: true });
    const data = JSON.stringify(Array.from(wishesStore.values()), null, 2);
    fs.writeFileSync(WISHES_FILE, data, "utf8");
  } catch (_) {}
}

loadWishesFromDisk();

function isRealSpotifyCredential(value) {
  const v = (value || "").trim();
  if (!v) return false;
  if (v === "your_spotify_client_id") return false;
  if (v === "your_spotify_client_secret") return false;
  return true;
}

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExp - 10_000) {
    return spotifyToken;
  }

  // Preferred: official client credentials flow
  const clientId = process.env.SPOTIFY_CLIENT_ID || "";
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || "";
  let clientCredError = "";
  if (isRealSpotifyCredential(clientId) && isRealSpotifyCredential(clientSecret)) {
    try {
      const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const response = await fetchImpl("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${encoded}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Spotify token failed: ${response.status} ${body}`);
      }

      const json = await response.json();
      spotifyToken = json.access_token;
      spotifyTokenExp = Date.now() + (json.expires_in || 3600) * 1000;
      tokenSource = "client_credentials";
      return spotifyToken;
    } catch (err) {
      clientCredError = err.message || "client_credentials_failed";
    }
  }

  // Fallback: best-effort public web token endpoint (can be blocked by Spotify)
  const fallback = await fetchImpl("https://open.spotify.com/get_access_token?reason=transport&productType=web_player");
  if (!fallback.ok) {
    const prefix = clientCredError ? `Client credentials failed: ${clientCredError}. ` : "";
    throw new Error(`${prefix}Spotify token unavailable. Add valid SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET in .env. Fallback failed: HTTP ${fallback.status}`);
  }
  const fjson = await fallback.json();
  if (!fjson.accessToken) {
    const prefix = clientCredError ? `Client credentials failed: ${clientCredError}. ` : "";
    throw new Error(`${prefix}Spotify fallback token missing. Add valid SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET in .env.`);
  }
  spotifyToken = fjson.accessToken;
  spotifyTokenExp = Number(fjson.accessTokenExpirationTimestampMs || Date.now() + 10 * 60 * 1000);
  tokenSource = "web_fallback";
  return spotifyToken;
}

app.get("/api/spotify/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const marketRaw = (req.query.market || "").toString().trim().toUpperCase();
  const market = /^[A-Z]{2}$/.test(marketRaw) ? marketRaw : "IN";
  const limitRaw = Number(req.query.limit || 12);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, limitRaw)) : 12;
  if (!q) {
    return res.status(400).json({ error: "q is required", items: [] });
  }

  try {
    const token = await getSpotifyToken();
    const searchRes = await fetchImpl(
      `https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}&market=${market}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!searchRes.ok) {
      const body = await searchRes.text();
      throw new Error(`Spotify search failed: ${searchRes.status} ${body}`);
    }

    const data = await searchRes.json();
    const items = (data.tracks?.items || []).map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artists?.map((a) => a.name).join(", ") || "Unknown artist",
      uri: track.uri,
      url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
      image: track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || ""
    }));

    return res.json({ items, market, limit });
  } catch (err) {
    const msg = err.message || "spotify_search_failed";
    const code = msg.includes("required") ? 400 : 500;
    return res.status(code).json({
      error: "spotify_search_failed",
      message: msg,
      items: []
    });
  }
});

app.get("/api/spotify/recommendations", async (req, res) => {
  const seed = (req.query.seed || "").toString().trim();
  const marketRaw = (req.query.market || "").toString().trim().toUpperCase();
  const market = /^[A-Z]{2}$/.test(marketRaw) ? marketRaw : "IN";
  const limitRaw = Number(req.query.limit || 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, limitRaw)) : 10;

  if (!seed || !/^[A-Za-z0-9]+$/.test(seed)) {
    return res.status(400).json({ error: "seed is required", items: [] });
  }

  try {
    const token = await getSpotifyToken();
    const recRes = await fetchImpl(
      `https://api.spotify.com/v1/recommendations?seed_tracks=${encodeURIComponent(seed)}&market=${market}&limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!recRes.ok) {
      const body = await recRes.text();
      throw new Error(`Spotify recommendations failed: ${recRes.status} ${body}`);
    }

    const data = await recRes.json();
    const items = (data.tracks || []).map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artists?.map((a) => a.name).join(", ") || "Unknown artist",
      uri: track.uri,
      url: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
      image: track.album?.images?.[2]?.url || track.album?.images?.[1]?.url || ""
    }));

    return res.json({ items, market, limit });
  } catch (err) {
    const msg = err.message || "spotify_recommendations_failed";
    return res.status(500).json({
      error: "spotify_recommendations_failed",
      message: msg,
      items: []
    });
  }
});

app.get("/api/music/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const limitRaw = Number(req.query.limit || 12);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(25, limitRaw)) : 12;

  if (!q) {
    return res.status(400).json({ error: "q is required", items: [] });
  }

  try {
    let items = [];
    let source = "deezer";

    try {
      const dzUrl = `https://api.deezer.com/search/track?q=${encodeURIComponent(q)}&limit=${limit}`;
      const dzRes = await fetchImpl(dzUrl);
      if (dzRes.ok) {
        const dzJson = await dzRes.json();
        if (!dzJson.error) {
          items = (dzJson.data || []).map((track) => ({
            id: `dz:${String(track.id || "")}`,
            name: track.title || "Unknown title",
            artist: track.artist?.name || "Unknown artist",
            preview: track.preview || "",
            url: track.link || "",
            image: track.album?.cover_small || track.album?.cover_medium || "",
            duration: Number(track.duration || 30)
          }));
        }
      }
    } catch (_) {}

    if (!items.length) {
      source = "itunes";
      const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=${limit}`;
      const itRes = await fetchImpl(itUrl);
      if (!itRes.ok) {
        const body = await itRes.text();
        throw new Error(`iTunes search failed: ${itRes.status} ${body}`);
      }
      const itJson = await itRes.json();
      items = (itJson.results || []).map((track) => ({
        id: `it:${String(track.trackId || "")}`,
        name: track.trackName || "Unknown title",
        artist: track.artistName || "Unknown artist",
        preview: track.previewUrl || "",
        url: track.trackViewUrl || "",
        image: track.artworkUrl60 || track.artworkUrl100 || "",
        duration: Number((track.trackTimeMillis || 30_000) / 1000)
      }));
    }

    return res.json({ items, source });
  } catch (err) {
    return res.status(500).json({
      error: "music_search_failed",
      message: err.message || "music_search_failed",
      items: []
    });
  }
});

app.get("/api/music/recommendations", async (req, res) => {
  const trackId = (req.query.trackId || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();
  const q = (req.query.q || "").toString().trim();
  const limitRaw = Number(req.query.limit || 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(25, limitRaw)) : 10;

  if (!trackId) {
    return res.status(400).json({ error: "trackId is required", items: [] });
  }

  try {
    let items = [];
    let source = "deezer";
    const [provider, rawId] = trackId.split(":");

    if (provider === "dz" && rawId) {
      try {
        const url = `https://api.deezer.com/track/${encodeURIComponent(rawId)}/related?limit=${limit}`;
        const response = await fetchImpl(url);
        if (response.ok) {
          const json = await response.json();
          if (!json.error) {
            items = (json.data || []).map((track) => ({
              id: `dz:${String(track.id || "")}`,
              name: track.title || "Unknown title",
              artist: track.artist?.name || "Unknown artist",
              preview: track.preview || "",
              url: track.link || "",
              image: track.album?.cover_small || track.album?.cover_medium || "",
              duration: Number(track.duration || 30)
            }));
          }
        }
      } catch (_) {}
    }

    if (!items.length) {
      source = "itunes";
      const term = artist || q;
      if (!term) {
        return res.json({ items: [], source });
      }
      const itUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`;
      const itRes = await fetchImpl(itUrl);
      if (!itRes.ok) {
        const body = await itRes.text();
        throw new Error(`iTunes recommendations failed: ${itRes.status} ${body}`);
      }
      const itJson = await itRes.json();
      items = (itJson.results || []).map((track) => ({
        id: `it:${String(track.trackId || "")}`,
        name: track.trackName || "Unknown title",
        artist: track.artistName || "Unknown artist",
        preview: track.previewUrl || "",
        url: track.trackViewUrl || "",
        image: track.artworkUrl60 || track.artworkUrl100 || "",
        duration: Number((track.trackTimeMillis || 30_000) / 1000)
      }));
    }

    return res.json({ items, source });
  } catch (err) {
    return res.status(500).json({
      error: "music_recommendations_failed",
      message: err.message || "music_recommendations_failed",
      items: []
    });
  }
});

app.get("/api/spotify/health", async (req, res) => {
  const hasClientId = isRealSpotifyCredential(process.env.SPOTIFY_CLIENT_ID || "");
  const hasClientSecret = isRealSpotifyCredential(process.env.SPOTIFY_CLIENT_SECRET || "");
  let tokenReady = false;
  let message = "Spotify backend is ready.";
  let tokenError = "";

  try {
    await getSpotifyToken();
    tokenReady = true;
    if (!hasClientId || !hasClientSecret) {
      message = "Using Spotify web fallback token. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET for a more reliable setup.";
    }
  } catch (err) {
    tokenReady = false;
    tokenError = err.message || "token_unavailable";
    message = "Spotify token unavailable. Configure SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.";
  }

  res.json({
    ok: tokenReady,
    hasClientId,
    hasClientSecret,
    message,
    tokenSource,
    tokenError,
    node: process.version
  });
});

app.post("/api/wishes", (req, res) => {
  const now = Date.now();
  const ip = clientKey(req);
  const ipBucket = bumpRateWindow(wishCreateRateStore, ip, now, 60 * 60 * 1000);
  if (ipBucket.count > MAX_WISHES_PER_HOUR_PER_IP) {
    return res.status(429).json({
      error: "wish_limit_reached",
      message: "Wish creation limit reached for this hour."
    });
  }

  const body = req.body || {};
  let id = makeWishId();
  while (wishesStore.has(id)) id = makeWishId();
  const category = safePick(body.category, new Set(["Mood", "Festival"]), "Festival");
  const mood = safePick(body.mood || "Celebration", ALLOWED_MOODS, "Celebration");
  const festival = safePick(body.festival || "Holi", ALLOWED_FESTIVALS, "Holi");
  const audience = safePick(body.audience || "friend", ALLOWED_AUDIENCES, "friend");
  const visibility = safePick(body.visibility || "public", ALLOWED_VISIBILITY, "public");
  const anonymous = !!body.anonymous;
  const senderName = trimText(body.senderName || "", 80);
  const anonymousAlias = anonymous ? buildAnonymousAlias(body.anonymousAlias || "") : "";
  const friendName = trimText(body.friendName, 80);
  const accessCode = trimText(body.accessCode || "", 64);
  const expiresInDaysRaw = Number(body.expiresInDays || 0);
  const expiresInDays = Number.isFinite(expiresInDaysRaw) ? Math.max(0, Math.min(30, Math.floor(expiresInDaysRaw))) : 0;
  const contextWord = category === "Mood" ? mood : festival;
  const defaultMessage = `Wishing you joy and positivity. ${contextWord} vibes${friendName ? " for " + friendName : ""}!`;
  const message = trimText(body.message || defaultMessage, 400);
  if (isSpamText(message) || isSpamText(senderName) || isSpamText(friendName) || isSpamText(anonymousAlias) || isSpamText(accessCode)) {
    return res.status(400).json({
      error: "spam_detected",
      message: "Input looks spammy. Remove links or repeated characters."
    });
  }
  if (accessCode && accessCode.length < 4) {
    return res.status(400).json({
      error: "access_code_too_short",
      message: "Access code must be at least 4 characters."
    });
  }
  const expiresAt = expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : "";

  const wish = {
    id,
    category,
    mood,
    festival,
    audience,
    visibility,
    senderName,
    senderDisplayName: anonymous ? anonymousAlias : senderName,
    anonymous,
    anonymousAlias,
    friendName,
    message,
    aiTone: trimText(body.aiTone || "", 30),
    music: trimText(body.music, 200),
    musicStyle: trimText(body.musicStyle || "", 40),
    theme: safePick(body.theme || "holi", ALLOWED_THEMES, "holi"),
    accessCodeHash: accessCode ? hashAccessCode(accessCode) : "",
    expiresAt,
    views: 0,
    lastViewedAt: "",
    reactions: { love: 0, funny: 0, emotional: 0, romantic: 0 },
    createdAt: new Date().toISOString()
  };
  wishesStore.set(id, wish);
  persistWishesToDisk();
  res.status(201).json({ id, wish: toPublicWish(wish) });
});

app.get("/api/wishes/trending", (req, res) => {
  const limitRaw = Number(req.query.limit || 8);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(30, limitRaw)) : 8;
  const mood = trimText(req.query.mood || "", 40);
  const festival = trimText(req.query.festival || "", 40);
  const audience = trimText(req.query.audience || "", 40);
  const category = trimText(req.query.category || "", 20);
  const items = Array.from(wishesStore.values())
    .filter((wish) => {
      if (!isWishPubliclyListed(wish)) return false;
      if (category && wish.category !== category) return false;
      if (mood && wish.mood !== mood) return false;
      if (festival && wish.festival !== festival) return false;
      if (audience && wish.audience !== audience) return false;
      return true;
    })
    .sort((a, b) => {
      return wishEngagementScore(b) - wishEngagementScore(a);
    })
    .slice(0, limit)
    .map((wish) => ({
      id: wish.id,
      category: wish.category,
      mood: wish.mood,
      festival: wish.festival,
      audience: wish.audience || "friend",
      friendName: wish.friendName,
      theme: wish.theme,
      views: Number(wish.views || 0),
      reactions: normalizeReactions(wish.reactions),
      createdAt: wish.createdAt
    }));
  return res.json({ items, limit, category, mood, festival, audience });
});

app.get("/api/wishes/:id", (req, res) => {
  const id = trimText(req.params.id, 40);
  const wish = wishesStore.get(id);
  const access = validateWishAccess(req, wish);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  wish.views = Number(wish.views || 0) + 1;
  wish.lastViewedAt = new Date().toISOString();
  wishesStore.set(id, wish);
  persistWishesToDisk();
  return res.json(toPublicWish(wish));
});

app.post("/api/wishes/:id/reactions", (req, res) => {
  const id = trimText(req.params.id, 40);
  const wish = wishesStore.get(id);
  const access = validateWishAccess(req, wish);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  const reaction = trimText(req.body?.reaction || "", 20).toLowerCase();
  if (!ALLOWED_REACTIONS.has(reaction)) {
    return res.status(400).json({ error: "invalid_reaction" });
  }
  const reactions = normalizeReactions(wish.reactions);
  reactions[reaction] = Number(reactions[reaction] || 0) + 1;
  wish.reactions = reactions;
  wishesStore.set(id, wish);
  persistWishesToDisk();
  return res.json({
    ok: true,
    id,
    reaction,
    reactions,
    labels: REACTION_LABELS
  });
});

app.get("/api/wishes", (req, res) => {
  const limitRaw = Number(req.query.limit || 5);
  const offsetRaw = Number(req.query.offset || 0);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, limitRaw)) : 5;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
  const festivalFilter = trimText(req.query.festival || "", 40);
  const moodFilter = trimText(req.query.mood || "", 40);
  const categoryFilter = trimText(req.query.category || "", 20);
  const audienceFilter = trimText(req.query.audience || "", 40);
  const sort = trimText(req.query.sort || "recent", 20);
  const q = trimText(req.query.q || "", 80).toLowerCase();
  const filtered = Array.from(wishesStore.values())
    .filter((wish) => {
      if (!isWishPubliclyListed(wish)) return false;
      if (festivalFilter && wish.festival !== festivalFilter) return false;
      if (moodFilter && wish.mood !== moodFilter) return false;
      if (categoryFilter && wish.category !== categoryFilter) return false;
      if (audienceFilter && wish.audience !== audienceFilter) return false;
      if (!q) return true;
      const text = `${wish.friendName || ""} ${wish.message || ""} ${wish.festival || ""} ${wish.mood || ""} ${wish.audience || ""}`.toLowerCase();
      return text.includes(q);
    });
  filtered.sort((a, b) => {
    if (sort === "popular") {
      const scoreGap = wishEngagementScore(b) - wishEngagementScore(a);
      if (scoreGap !== 0) return scoreGap;
    } else if (sort === "views") {
      const viewGap = Number(b.views || 0) - Number(a.views || 0);
      if (viewGap !== 0) return viewGap;
    }
    return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
  });
  const total = filtered.length;
  const items = filtered
    .slice(offset, offset + limit)
    .map((wish) => ({
      id: wish.id,
      category: wish.category || "Festival",
      mood: wish.mood || "Celebration",
      festival: wish.festival,
      audience: wish.audience || "friend",
      senderName: wish.anonymous ? "" : (wish.senderName || ""),
      senderDisplayName: wish.anonymous ? buildAnonymousAlias(wish.anonymousAlias || wish.senderDisplayName || "") : (wish.senderName || ""),
      anonymousAlias: wish.anonymous ? buildAnonymousAlias(wish.anonymousAlias || wish.senderDisplayName || "") : "",
      friendName: wish.friendName,
      message: wish.message,
      theme: wish.theme,
      views: Number(wish.views || 0),
      reactions: normalizeReactions(wish.reactions),
      anonymous: !!wish.anonymous,
      lastViewedAt: wish.lastViewedAt || "",
      createdAt: wish.createdAt
    }));
  return res.json({
    items,
    limit,
    offset,
    total,
    hasMore: offset + items.length < total,
    festival: festivalFilter || "",
    mood: moodFilter || "",
    category: categoryFilter || "",
    audience: audienceFilter || "",
    sort: sort || "recent",
    q
  });
});

app.delete("/api/wishes/:id", (req, res) => {
  const id = trimText(req.params.id, 40);
  const providedPin = getProvidedAdminPin(req);
  if (!ADMIN_PIN || providedPin !== ADMIN_PIN) {
    return res.status(401).json({ error: "invalid_admin_pin" });
  }
  if (!wishesStore.has(id)) {
    return res.status(404).json({ error: "wish_not_found" });
  }
  wishesStore.delete(id);
  persistWishesToDisk();
  return res.json({ ok: true, id });
});

app.post("/api/ai/greeting", async (req, res) => {
  const body = req.body || {};
  const festival = safePick(body.festival || "Holi", ALLOWED_FESTIVALS, "Holi");
  const mood = safePick(body.mood || "Celebration", ALLOWED_MOODS, "Celebration");
  const category = safePick(body.category, new Set(["Mood", "Festival"]), "Festival");
  const audience = safePick(body.audience || "friend", ALLOWED_AUDIENCES, "friend");
  const tone = trimText(body.tone || "Warm", 24) || "Warm";
  const friendName = trimText(body.friendName, 80);
  const contextWord = category === "Mood" ? mood : festival;
  const audienceLabel = AUDIENCE_LABELS[audience] || "friend";
  const prompt = trimText(body.prompt || `Generate a short ${tone} message for my ${audienceLabel} about ${contextWord}`, 220);
  const fallbackMessage = `Sending ${tone.toLowerCase()} ${contextWord.toLowerCase()} vibes to my ${audienceLabel}${friendName ? ", " + friendName : ""}.`;
  const hfToken = (process.env.HF_API_TOKEN || "").trim();

  try {
    const model = "google/flan-t5-base";
    const response = await fetchImpl(`https://api-inference.huggingface.co/models/${model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(hfToken ? { Authorization: `Bearer ${hfToken}` } : {})
      },
      body: JSON.stringify({
        inputs: `${prompt}. Keep it concise and respectful. Tone: ${tone}.`,
        parameters: { max_new_tokens: 60, temperature: 0.9 }
      })
    });

    if (!response.ok) {
      return res.json({ message: fallbackMessage, source: "template_fallback" });
    }

    const data = await response.json();
    let text = "";
    if (Array.isArray(data) && data[0] && data[0].generated_text) {
      text = String(data[0].generated_text || "").trim();
    } else if (data && typeof data.generated_text === "string") {
      text = data.generated_text.trim();
    }
    if (!text) text = fallbackMessage;
    return res.json({ message: text, source: "huggingface" });
  } catch (_) {
    return res.json({ message: fallbackMessage, source: "template_fallback" });
  }
});

app.get("/api/confessions/random", (req, res) => {
  const idx = Math.floor(Math.random() * RANDOM_CONFESSIONS.length);
  res.json({
    confession: RANDOM_CONFESSIONS[idx],
    source: "curated_pool"
  });
});

app.get("/api/prompts/daily", (req, res) => {
  const now = new Date();
  const seed = Number(
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`
  );
  const item = DAILY_MOOD_PROMPTS[seed % DAILY_MOOD_PROMPTS.length];
  res.json({
    date: now.toISOString().slice(0, 10),
    mood: item.mood,
    prompt: item.prompt
  });
});

app.get("/api/stats", (req, res) => {
  const byFestival = {};
  const byMood = {};
  const byAudience = {};
  const byTheme = {};
  let totalViews = 0;
  let totalReactions = 0;
  let recentWishes24h = 0;
  let lastCreatedAt = "";
  let totalPublicWishes = 0;
  let totalPrivateWishes = 0;
  const now = Date.now();
  for (const wish of wishesStore.values()) {
    if (isWishExpired(wish)) continue;
    const f = wish.festival || "Festival";
    const m = wish.mood || "Celebration";
    const a = wish.audience || "friend";
    const t = wish.theme || "holi";
    const visibility = wish.visibility || "public";
    if (visibility === "public") {
      totalPublicWishes += 1;
      byFestival[f] = Number(byFestival[f] || 0) + 1;
      byMood[m] = Number(byMood[m] || 0) + 1;
      byAudience[a] = Number(byAudience[a] || 0) + 1;
      byTheme[t] = Number(byTheme[t] || 0) + 1;
      totalViews += Number(wish.views || 0);
      totalReactions += wishReactionTotal(wish);
    } else {
      totalPrivateWishes += 1;
    }
    const createdTs = Date.parse(wish.createdAt || "");
    if (Number.isFinite(createdTs)) {
      if (!lastCreatedAt || createdTs > Date.parse(lastCreatedAt)) {
        lastCreatedAt = new Date(createdTs).toISOString();
      }
      if (now - createdTs <= 24 * 60 * 60 * 1000) {
        recentWishes24h += 1;
      }
    }
  }
  const topFestival = topCountEntry(byFestival);
  const topMood = topCountEntry(byMood);
  const topAudience = topCountEntry(byAudience);
  const topTheme = topCountEntry(byTheme);
  res.json({
    totalWishes: wishesStore.size,
    totalPublicWishes,
    totalPrivateWishes,
    totalViews,
    totalReactions,
    recentWishes24h,
    lastCreatedAt,
    byFestival,
    byMood,
    byAudience,
    byTheme,
    topFestival: topFestival.key,
    topFestivalCount: topFestival.count,
    topMood: topMood.key,
    topMoodCount: topMood.count,
    topAudience: topAudience.key,
    topAudienceCount: topAudience.count,
    topTheme: topTheme.key,
    topThemeCount: topTheme.count
  });
});

// Force legacy search pages to main UI page.
app.get(["/spot_search.html", "/spot_search2.html", "/spot_tracks.html"], (req, res) => {
  res.redirect(302, "/happyHoli.html");
});

app.get("/wish/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "happyHoli.html"));
});

app.get(
  [
    "/romantic-message-generator",
    "/sorry-message-generator",
    "/friendship-message-generator",
    "/holi-wishes",
    "/diwali-wishes"
  ],
  (req, res) => {
    res.sendFile(path.join(__dirname, "happyHoli.html"));
  }
);

app.use(express.static(path.join(__dirname)));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "happyHoli.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
