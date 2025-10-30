/* =========================================================
   Lollo Bet — Server ottimizzato per Render.com
   =========================================================
   ⚙️ Configurazione:
   - Porta automatica (Render gestisce PORT)
   - CORS consentito solo da dominio Netlify
   - Chiave API letta da variabile AF_API_KEY
     (fallback alla chiave personale di Vitaliano)
   ========================================================= */

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// =========================================================
// 🔧 CONFIGURAZIONE BASE
// =========================================================
const PORT = process.env.PORT || 3001;

// CORS: permetti solo dal dominio PWA su Netlify
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://lollobet.netlify.app";
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Chiave API (prima da Render, se non presente usa fallback)
const KEY = (process.env.AF_API_KEY || "f8d5348ece58b307f69e96f58ea1c1c6").trim();
const BASE = "https://v3.football.api-sports.io";
const HEADERS = { "x-apisports-key": KEY };

const log = (...a) => console.log("[LolloBet]", ...a);
const warn = (...a) => console.warn("[WARN]", ...a);
const isoDay = (d) => d.toISOString().slice(0, 10);

const cache = { day: new Map(), leagues: new Map(), injuries: new Map(), lineups: new Map(), stats: new Map() };
const getCache = (m, k, ttl) => {
  const h = m.get(k);
  if (!h) return null;
  if (Date.now() - h.ts > ttl) {
    m.delete(k);
    return null;
  }
  return h.data;
};
const setCache = (m, k, d) => m.set(k, { ts: Date.now(), data: d });

// =========================================================
// 🧩 DIAGNOSTICA
// =========================================================
app.get("/api/diag", async (req, res) => {
  try {
    let ok = false, code = null, body = null;
    try {
      const r = await axios.get(BASE + "/status", { headers: HEADERS });
      ok = true;
    } catch (e) {
      code = e?.response?.status || 0;
      body = e?.response?.data || e?.message;
    }
    res.json({
      provider: "API-Sports (direct)",
      base: BASE,
      ok,
      status_http: ok ? 200 : code,
      error_detail: ok ? null : body,
      allowed_origin: ALLOWED_ORIGIN,
    });
  } catch (e) {
    res.status(500).json({ error: "diag-failed", detail: e.message });
  }
});

// =========================================================
// 📅 FIXTURES (partite del giorno)
// =========================================================
async function fetchFixturesForDay(day) {
  let fixtures = [];
  try {
    const fx = await axios.get(BASE + "/fixtures", { headers: HEADERS, params: { date: day } });
    fixtures = fx?.data?.response || [];
    log("fixtures(date)", day, "=", fixtures.length);
  } catch (e) {
    warn("fixtures(date) err", e?.response?.status);
  }

  if (fixtures.length === 0) {
    const d = new Date(day + "T00:00:00Z");
    try {
      const fx2 = await axios.get(BASE + "/fixtures", {
        headers: HEADERS,
        params: { from: isoDay(new Date(d.getTime() - 86400000)), to: isoDay(new Date(d.getTime() + 86400000)) },
      });
      fixtures = fx2?.data?.response || [];
      log("fixtures(from/to)", day, "±1 =", fixtures.length);
    } catch (e) {
      warn("fixtures(from/to) err", e?.response?.status);
    }
  }
  return fixtures;
}

// =========================================================
// 🏆 CAMPIONATI DEL GIORNO
// =========================================================
app.get("/api/leagues/:date", async (req, res) => {
  const day = req.params.date;
  const key = "L_" + day;
  const hit = getCache(cache.leagues, key, 15 * 60 * 1000);
  if (hit) return res.json(hit);

  try {
    const fixtures = await fetchFixturesForDay(day);
    const m = new Map();
    for (const f of fixtures) {
      const lid = f?.league?.id,
        name = f?.league?.name,
        country = f?.league?.country,
        season = f?.league?.season;
      if (!lid) continue;
      const k = lid + "_" + season;
      if (!m.has(k)) m.set(k, { id: lid, name, country, season });
    }
    const leagues = Array.from(m.values()).sort(
      (a, b) =>
        String(a.country || "").localeCompare(b.country || "") ||
        String(a.name || "").localeCompare(b.name || "")
    );
    const payload = { date: day, count: leagues.length, leagues };
    setCache(cache.leagues, key, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "leagues-failed", detail: e?.message });
  }
});

// =========================================================
// ⚽ PARTITE DEL GIORNO
// =========================================================
app.get("/api/day/:date", async (req, res) => {
  const day = req.params.date;
  const leagueId = req.query.league ? Number(req.query.league) : null;
  const key = "D_" + day + (leagueId ? "_L" + leagueId : "");
  const hit = getCache(cache.day, key, 10 * 60 * 1000);
  if (hit) return res.json(hit);

  try {
    let fixtures = await fetchFixturesForDay(day);
    if (leagueId) fixtures = fixtures.filter((f) => Number(f?.league?.id) === leagueId);

    const out = fixtures.map((f) => ({
      match: {
        id: String(f?.fixture?.id),
        home: f?.teams?.home?.name,
        away: f?.teams?.away?.name,
        homeId: f?.teams?.home?.id,
        awayId: f?.teams?.away?.id,
        league: f?.league?.name,
        leagueId: f?.league?.id,
        season: f?.league?.season,
        country: f?.league?.country || null,
        time: f?.fixture?.date,
        dateISO: f?.fixture?.date,
      },
      lineupsConfirmed: false,
      availability: [],
    }));

    const payload = { date: day, matches: out, meta: { leagueFilter: leagueId || null } };
    setCache(cache.day, key, payload);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "day-failed", detail: e?.message });
  }
});

// =========================================================
// 🧑‍⚕️ INFORTUNI + FORMAZIONI
// =========================================================
app.get("/api/fixture/:id/details", async (req, res) => {
  const id = String(req.params.id);
  try {
    const cInj = getCache(cache.injuries, id, 30 * 60 * 1000);
    const cLin = getCache(cache.lineups, id, 30 * 60 * 1000);
    if (cInj && cLin !== undefined) return res.json({ injuries: cInj, lineupsConfirmed: cLin });

    let injuries = [],
      lineupsConfirmed = false;
    try {
      const r1 = await axios.get(BASE + "/injuries", { headers: HEADERS, params: { fixture: id } });
      injuries = r1?.data?.response || [];
    } catch (e) {
      warn("injuries err", e?.response?.status);
    }

    try {
      const r2 = await axios.get(BASE + "/fixtures/lineups", { headers: HEADERS, params: { fixture: id } });
      const arr = r2?.data?.response || [];
      lineupsConfirmed = Array.isArray(arr) && arr.length > 0;
    } catch (e) {
      warn("lineups err", e?.response?.status);
    }

    setCache(cache.injuries, id, injuries);
    setCache(cache.lineups, id, lineupsConfirmed);
    res.json({ injuries, lineupsConfirmed });
  } catch (e) {
    res.status(500).json({ error: "details-failed", detail: e?.message });
  }
});

// =========================================================
// 📊 PRONOSTICO (Poisson + AIS)
// =========================================================
app.get("/api/predict/:fixtureId", async (req, res) => {
  const fixtureId = req.params.fixtureId;
  try {
    const fx = await axios.get(BASE + "/fixtures", { headers: HEADERS, params: { id: fixtureId } });
    const f = fx?.data?.response?.[0];
    if (!f) return res.status(404).json({ error: "Fixture non trovata" });

    const leagueId = f.league?.id,
      season = f.league?.season,
      homeId = f.teams?.home?.id,
      awayId = f.teams?.away?.id;

    const keyH = `${homeId}_${leagueId}_${season}`,
      keyA = `${awayId}_${leagueId}_${season}`;
    let H = getCache(cache.stats, keyH, 24 * 60 * 60 * 1000),
      A = getCache(cache.stats, keyA, 24 * 60 * 60 * 1000);
    if (!H) {
      const r = await axios.get(BASE + "/teams/statistics", { headers: HEADERS, params: { team: homeId, league: leagueId, season } });
      H = r.data?.response;
      setCache(cache.stats, keyH, H);
    }
    if (!A) {
      const r = await axios.get(BASE + "/teams/statistics", { headers: HEADERS, params: { team: awayId, league: leagueId, season } });
      A = r.data?.response;
      setCache(cache.stats, keyA, A);
    }

    const hGF = Number(H?.goals?.for?.average?.home) || 1.2,
      hGA = Number(H?.goals?.against?.average?.home) || 1.0;
    const aGF = Number(A?.goals?.for?.average?.away) || 1.1,
      aGA = Number(A?.goals?.against?.average?.away) || 1.1;
    let lambdaHome = (hGF + aGA) / 2,
      lambdaAway = (aGF + hGA) / 2;

    let aisHome = 0,
      aisAway = 0;
    try {
      const injRes = await axios.get(BASE + "/injuries", { headers: HEADERS, params: { fixture: f.fixture.id } });
      const resp = injRes?.data?.response || [];
      const by = {};
      for (const it of resp) {
        const tid = it?.team?.id;
        if (!tid) continue;
        if (!by[tid]) by[tid] = [];
        by[tid].push(it);
      }
      const imp = (arr) => ((arr && arr.length) ? arr.length : 0) * 0.08;
      aisHome = imp(by[homeId]);
      aisAway = imp(by[awayId]);
    } catch (e) {}

    lambdaHome = Math.max(0.1, lambdaHome * (1 - aisHome));
    lambdaAway = Math.max(0.1, lambdaAway * (1 - aisAway));

    const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
    const pois = (l, k) => Math.exp(-l) * Math.pow(l, k) / fact(k);

    let pH = 0, pD = 0, pA = 0;
    for (let gh = 0; gh <= 10; gh++) {
      const ph = pois(lambdaHome, gh);
      for (let ga = 0; ga <= 10; ga++) {
        const pa = pois(lambdaAway, ga);
        if (gh > ga) pH += ph * pa;
        else if (gh === ga) pD += ph * pa;
        else pA += ph * pa;
      }
    }
    const tot = pH + pD + pA || 1;
    const prob = {
      home: +(pH / tot * 100).toFixed(1),
      draw: +(pD / tot * 100).toFixed(1),
      away: +(pA / tot * 100).toFixed(1),
      lambdaHome: +lambdaHome.toFixed(2),
      lambdaAway: +lambdaAway.toFixed(2),
      ais: { home: +aisHome.toFixed(2), away: +aisAway.toFixed(2) },
    };

    let pick = "DRAW";
    const conf = Math.max(prob.home, prob.draw, prob.away);
    if (prob.home === conf) pick = "HOME";
    if (prob.away === conf) pick = "AWAY";

    res.json({ fixtureId: String(f.fixture.id), leagueId, season, prob, pick, note: "Poisson + AIS" });
  } catch (e) {
    res.status(500).json({ error: "predict-failed", detail: e?.message });
  }
});

// =========================================================
// 🚀 AVVIO SERVER
// =========================================================
app.listen(PORT, () => {
  console.log("✅ Lollo Bet server online (Render)");
  console.log("🌍 Porta:", PORT);
  console.log("🔑 API-Sports Key:", KEY ? "Attiva ✅" : "Mancante ❌");
  console.log("🔗 CORS permesso da:", ALLOWED_ORIGIN);
});
