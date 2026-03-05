require("dotenv").config();

const express = require("express");
const path = require("path");
const fetchImpl = global.fetch || require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

let spotifyToken = "";
let spotifyTokenExp = 0;
let tokenSource = "none";

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
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

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

app.use(express.static(path.join(__dirname)));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "happyHoli.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
