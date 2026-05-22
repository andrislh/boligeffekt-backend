// Enova-import: henter siste 12 måneder med energiattester fra Enovas
// offentlige API (Energimerkesystemet v2), aggregerer per byggeår-bøtte
// og skriver til data/enova-stats.json. Backend leser den filen
// i /api/benchmark.
//
// Kjør lokalt eller på Railway:
//   ENOVA_API_KEY=... node enova-import.js
//
// Resultat: data/enova-stats.json overskrives.

require("dotenv").config();
const fs   = require("fs");
const path = require("path");

const API_KEY = process.env.ENOVA_API_KEY;
if (!API_KEY) {
  console.error("ENOVA_API_KEY mangler. Sett env-var og prøv igjen.");
  process.exit(1);
}

const BASE = "https://data.enova.no/energimerkesystemet/v2";
const UT_FIL = path.join(__dirname, "data", "enova-stats.json");

// Byggeår-bøtter matcher BYGGEÅR_DATA i frontend
function bøtte(år) {
  if (!år || isNaN(år)) return null;
  if (år < 1950) return "Før 1950";
  if (år < 1970) return "1950-1969";
  if (år < 1987) return "1970-1986";
  if (år < 1998) return "1987-1997";
  if (år < 2008) return "1998-2007";
  if (år < 2018) return "2008-2017";
  return "Etter 2017";
}

// Heuristisk CSV-parsing - Enova bruker semikolon iht. nordisk standard
function parseCSV(tekst) {
  const linjer = tekst.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (linjer.length === 0) return { header: [], rader: [] };
  const sep = linjer[0].includes(";") ? ";" : ",";
  const header = linjer[0].split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
  const rader  = linjer.slice(1).map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, "")));
  return { header, rader };
}

function finnKolonne(header, kandidater) {
  for (const k of kandidater) {
    const i = header.findIndex(h => h.toLowerCase().includes(k.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}

async function hentMåned(år, måned) {
  // Endepunkt for år før 2026: /bank/v1/{year}/{month}
  // For 2026+ kan endepunktet ha endret seg - vi prøver begge.
  const måMM = String(måned).padStart(2, "0");
  const urler = [
    `${BASE}/bank/v1/${år}/${måMM}`,
    `${BASE}/bank/v2/${år}/${måMM}`,
    `${BASE}/${år}/${måMM}`,
  ];
  for (const url of urler) {
    try {
      const res = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": API_KEY, "Accept": "text/csv" },
        redirect: "follow",
      });
      if (res.ok) {
        const tekst = await res.text();
        if (tekst.length > 100) {
          console.log(`  [${år}-${måMM}] OK ${url} - ${(tekst.length / 1024).toFixed(0)} kB`);
          return tekst;
        }
      } else if (res.status !== 404) {
        console.log(`  [${år}-${måMM}] HTTP ${res.status} ${url}`);
      }
    } catch (e) {
      console.log(`  [${år}-${måMM}] feil ${url}: ${e.message}`);
    }
  }
  console.log(`  [${år}-${måMM}] ingen treff på noe endepunkt - hopper over`);
  return null;
}

async function main() {
  console.log("=== Enova-import starter ===");

  const nå = new Date();
  const måneder = [];
  for (let i = 1; i <= 12; i++) {
    const d = new Date(nå.getFullYear(), nå.getMonth() - i, 1);
    måneder.push({ år: d.getFullYear(), måned: d.getMonth() + 1 });
  }

  // Aggregat: { "1970-1986": { totalt: 0, perMerke: { A: 0, B: 0, ... }, kwhSum: 0, kwhAntall: 0 } }
  const aggregat = {};
  let totaltRader = 0;
  let header = null;
  let merkeCol = -1, byggearCol = -1, kwhCol = -1;

  for (const m of måneder) {
    const csv = await hentMåned(m.år, m.måned);
    if (!csv) continue;
    const { header: h, rader } = parseCSV(csv);
    if (!header) {
      header     = h;
      merkeCol   = finnKolonne(h, ["energikarakter", "energimerke", "karakter"]);
      byggearCol = finnKolonne(h, ["byggeaar", "byggear", "byggeår"]);
      kwhCol     = finnKolonne(h, ["levertenergi", "beregnetlevertenergi", "kwhprm2", "kwh"]);
      console.log(`  Kolonner: merke=${h[merkeCol]} byggeår=${h[byggearCol]} kwh=${h[kwhCol] || "(ikke funnet)"}`);
      if (merkeCol < 0 || byggearCol < 0) {
        console.error("  Klarer ikke finne merke/byggeår-kolonner. Header:");
        console.error("  " + h.join(" | "));
        process.exit(1);
      }
    }
    for (const r of rader) {
      const merke   = (r[merkeCol] || "").trim().toUpperCase();
      const byggeår = parseInt(r[byggearCol], 10);
      if (!/^[A-G]$/.test(merke)) continue;
      const b = bøtte(byggeår);
      if (!b) continue;
      if (!aggregat[b]) aggregat[b] = { totalt: 0, perMerke: { A:0,B:0,C:0,D:0,E:0,F:0,G:0 }, kwhSum: 0, kwhAntall: 0 };
      aggregat[b].totalt++;
      aggregat[b].perMerke[merke]++;
      if (kwhCol >= 0) {
        const kwh = parseFloat((r[kwhCol] || "").replace(",", "."));
        if (kwh > 0 && kwh < 1000) {
          aggregat[b].kwhSum    += kwh;
          aggregat[b].kwhAntall++;
        }
      }
      totaltRader++;
    }
  }

  // Beregn median-merke og snitt-kWh per bøtte
  const merker = ["A","B","C","D","E","F","G"];
  for (const b of Object.keys(aggregat)) {
    const a = aggregat[b];
    let kumulativ = 0;
    const halv = a.totalt / 2;
    for (const m of merker) {
      kumulativ += a.perMerke[m];
      if (kumulativ >= halv) { a.median = m; break; }
    }
    a.snittKwhPerM2 = a.kwhAntall > 0 ? Math.round(a.kwhSum / a.kwhAntall) : null;
    delete a.kwhSum;
    delete a.kwhAntall;
  }

  const ut = {
    generertNår:     new Date().toISOString(),
    totaltAttester:  totaltRader,
    perByggeårBøtte: aggregat,
  };

  if (!fs.existsSync(path.dirname(UT_FIL))) fs.mkdirSync(path.dirname(UT_FIL), { recursive: true });
  fs.writeFileSync(UT_FIL, JSON.stringify(ut, null, 2));
  console.log(`\n=== Ferdig: ${totaltRader} attester aggregert til ${Object.keys(aggregat).length} byggeår-bøtter ===`);
  console.log(`Skrev til ${UT_FIL}`);
}

main().catch(e => { console.error("FEIL:", e); process.exit(1); });
