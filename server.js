// BoligEffekt – Backend
// Håndterer: Stripe-betaling, PDF-generering, e-postsending

require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const rateLimit   = require("express-rate-limit");
const { Resend }  = require("resend");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

// ── Startup-sjekk ─────────────────────────────────────────────
console.log("=== BoligEffekt backend starter ===");
console.log("RESEND_API_KEY:", process.env.RESEND_API_KEY ? "OK" : "MANGLER – e-post vil feile!");
console.log("STRIPE_SECRET_KEY:", process.env.STRIPE_SECRET_KEY ? "OK" : "MANGLER!");
console.log("STRIPE_WEBHOOK_SECRET:", process.env.STRIPE_WEBHOOK_SECRET ? "OK" : "MANGLER – webhook vil feile!");
console.log("NODE_ENV:", process.env.NODE_ENV || "development");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
// onboarding@resend.dev er eneste avsender som fungerer uten domene-verifisering i Resend test-modus
const FROM_EMAIL = "rapport@boligeffekt.no";

const ALLOWED_ORIGINS = [
  "https://boligeffekt.no",
  "https://www.boligeffekt.no",
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
];

const app = express();

// ── Sikkerhetsheadere ─────────────────────────────────────────
app.use(helmet());

// ── CORS: kun tillatte domener ────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Tillat forespørsler uten origin (server-til-server, Stripe webhook)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("CORS: ikke tillatt"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// ── Body-størrelse: maks 50 kb (hindrer store payload-angrep) ─
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50kb" }));

// ── Rate limiting ─────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutter
  max: 60,                   // maks 60 kall per IP per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { feil: "For mange forespørsler – prøv igjen om litt." },
});
// Chat: maks 3 meldinger per minutt og 30 per dag per IP
const chatMinuttLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { feil: "For mange meldinger – vent litt før du sender neste." },
});
const chatDagLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  message: { feil: "Du har nådd dagens grense for chat. Prøv igjen i morgen." },
});

// Nyheter: maks 2 oppdateringer per time per IP (resten serveres fra cache)
const nyheterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 2,
  message: { feil: "For mange nyheterforespørsler – prøv igjen om litt." },
});

app.use("/api/", apiLimiter);
app.use("/api/chat",    chatMinuttLimiter, chatDagLimiter);
app.use("/api/nyheter", nyheterLimiter);

// ── Validering og sanitering ──────────────────────────────────

const GYLDIGE_PAKKER = ["energirapport", "oppgraderingsplan"];

function erEpost(s) {
  return typeof s === "string" && /^[^@\s]{1,64}@[^@\s]{1,200}\.[^@\s]{2,}$/.test(s) && s.length < 200;
}

// Unngår XSS i HTML-e-poster ved å escape brukerdata
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Hjelpefunksjoner ──────────────────────────────────────────

// Fjerner tegn utenfor WinAnsi (Latin-1) som Helvetica ikke støtter.
// æøå ÆØÅ er i Latin-1 og fungerer fint. Emoji og spesialtegn fjernes.
function safePDF(str) {
  return (str || "")
    .replace(/[\u2713\u2714\u2705]/g, "OK")    // ✓ ✔ ✅ -> OK
    .replace(/[\u2715-\u2718\u274C]/g, "Nei")  // ✗ -> Nei
    .replace(/\u2192/g, "->")                  // → -> ->
    .replace(/\u2190/g, "<-")                  // ← -> <-
    .replace(/\u2022/g, "-")                   // • -> -
    .replace(/\u2264/g, "<=")                  // ≤ -> <=
    .replace(/\u2265/g, ">=")                  // ≥ -> >=
    .replace(/\u2013/g, "-")                   // – (en-dash) -> -
    .replace(/\u2014/g, "-")                   // — (em-dash) -> -
    .replace(/[^\x00-\xFF]/g, "");             // Alt utenfor Latin-1 fjernes
}

// Enkel tekstbrytning basert på skriftbredde
function wrapText(text, font, size, maxWidth) {
  const words = safePDF(String(text)).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    try {
      if (font.widthOfTextAtSize(test, size) > maxWidth) {
        if (current) lines.push(current);
        current = word;
      } else {
        current = test;
      }
    } catch (_) {
      current = test; // fallback ved encoding-feil
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Tegner en rad i en tabell
function tabelRad(side, k, v, x, y, fontNormal, fontBold, grå, navy, sectionFarge) {
  side.drawRectangle({ x, y: y - 2, width: 515 - x, height: 18, color: sectionFarge });
  side.drawText(safePDF(k), { x: x + 4, y: y + 2, size: 8, font: fontNormal, color: grå });
  side.drawText(safePDF(v), { x: 320, y: y + 2, size: 8, font: fontBold, color: navy });
}

// ── PDF-generator ─────────────────────────────────────────────
async function lagPDF(data, pakke) {
  console.log("[PDF] Starter generering, pakke:", pakke);

  const { merke, kwhPerM2, totalKwh, strømkostnad, bygData, klima, bolig,
          oppvData, primærPerM2, tiltak } = data.resultat;

  const pdfDoc   = await PDFDocument.create();
  const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const navy    = rgb(0.067, 0.227, 0.361);
  const navyDk  = rgb(0.039, 0.133, 0.220);
  const green   = rgb(0.165, 0.710, 0.353);
  const greenLt = rgb(0.882, 0.969, 0.914);
  const grå     = rgb(0.42, 0.48, 0.55);
  const gråLt   = rgb(0.62, 0.67, 0.73);
  const lys     = rgb(0.965, 0.961, 0.953);
  const lysGrå  = rgb(0.94, 0.94, 0.94);
  const hvit    = rgb(1, 1, 1);
  const oransj  = rgb(0.97, 0.58, 0.11);
  const oransjLt = rgb(0.99, 0.95, 0.88);

  // Helper: tegn seksjonsheader med grønn venstre-aksent
  function seksjonHeader(side, tekst, x, y) {
    side.drawRectangle({ x, y: y - 2, width: 3, height: 16, color: green });
    side.drawText(tekst, { x: x + 10, y, size: 11, font: fontBold, color: navy });
  }

  // Helper: tegn footer
  function footer(side) {
    side.drawRectangle({ x: 0, y: 0, width: 595, height: 40, color: lys });
    side.drawRectangle({ x: 0, y: 40, width: 595, height: 1, color: lysGrå });
    side.drawText("BoligEffekt – Estimat basert på NS-EN ISO 52000 og TEK-historikk – Ikke offisielt energimerke",
      { x: 40, y: 14, size: 7.5, font: fontNormal, color: grå });
    side.drawText("boligeffekt.no", { x: 595 - 100, y: 14, size: 7.5, font: fontBold, color: navy });
  }

  // Helper: tegn sideheader
  function sideHeader(side, undertittel, sidenr, totalt) {
    side.drawRectangle({ x: 0, y: 842 - 72, width: 595, height: 72, color: navy });
    side.drawRectangle({ x: 0, y: 842 - 74, width: 595, height: 2, color: green });
    side.drawText("BoligEffekt", { x: 40, y: 842 - 44, size: 20, font: fontBold, color: hvit });
    side.drawText(undertittel, { x: 40, y: 842 - 62, size: 9.5, font: fontNormal, color: rgb(0.65, 0.85, 0.65) });
    side.drawText(`Side ${sidenr} av ${totalt}`, { x: 595 - 80, y: 842 - 52, size: 8, font: fontNormal, color: rgb(0.55, 0.65, 0.75) });
  }

  const merkeFarger = {
    A: rgb(0, 0.65, 0.32), B: rgb(0.34, 0.73, 0.28), C: rgb(0.71, 0.83, 0.2),
    D: rgb(1, 0.82, 0),    E: rgb(0.97, 0.58, 0.11), F: rgb(0.93, 0.11, 0.14),
    G: rgb(0.62, 0.10, 0.13),
  };
  const mFarge = merkeFarger[merke.merke] || navy;

  const totSider = pakke === "oppgraderingsplan" ? 3 : 1;

  // ── Side 1: Standard energirapport ─────────────────────────
  const side1 = pdfDoc.addPage([595, 842]);

  sideHeader(side1, pakke === "oppgraderingsplan" ? "Oppgraderingsplan" : "Energirapport", 1, totSider);

  const dato = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "long", year: "numeric" });
  side1.drawText(safePDF(dato), { x: 595 - 140, y: 842 - 44, size: 9, font: fontNormal, color: rgb(0.6, 0.72, 0.85) });

  // ── Energimerke-seksjon ─────────────────────────────────────
  let y = 842 - 90;

  // Merke-boks (stor)
  side1.drawRectangle({ x: 40, y: y - 88, width: 100, height: 92, color: mFarge, borderRadius: 6 });
  // Merke-bokstav sentrert
  const merkeBokstavX = merke.merke === "W" ? 60 : 61;
  side1.drawText(merke.merke, { x: merkeBokstavX, y: y - 58, size: 52, font: fontBold, color: hvit });
  // Label under merke
  side1.drawRectangle({ x: 40, y: y - 88, width: 100, height: 18, color: navyDk, borderRadius: 0 });
  side1.drawText("ENERGIMERKE", { x: 44, y: y - 83, size: 6.5, font: fontBold, color: rgb(0.7, 0.85, 0.7) });

  // Merke-info til høyre
  side1.drawText("Estimert energimerke", { x: 155, y: y - 10, size: 8, font: fontNormal, color: grå });
  side1.drawText(safePDF(`Merke ${merke.merke} – ${merke.epbd}`), { x: 155, y: y - 30, size: 15, font: fontBold, color: navy });
  side1.drawRectangle({ x: 155, y: y - 44, width: 200, height: 1, color: lysGrå });
  side1.drawText(safePDF(bygData.label), { x: 155, y: y - 56, size: 9, font: fontNormal, color: grå });
  side1.drawText(safePDF(`Klimasone: ${klima.label.split("(")[0].trim()}`), { x: 155, y: y - 70, size: 9, font: fontNormal, color: grå });

  // Energiskala A–G
  const skalaX = 380;
  const skalaY = y - 10;
  ["A","B","C","D","E","F","G"].forEach((bkst, i) => {
    const erAktiv = bkst === merke.merke;
    const farge = merkeFarger[bkst];
    const bW = erAktiv ? 28 : 22;
    side1.drawRectangle({ x: skalaX + i * 25, y: skalaY - 16, width: bW, height: 18,
      color: erAktiv ? farge : rgb(0.88, 0.88, 0.88), borderRadius: 2 });
    side1.drawText(bkst, { x: skalaX + i * 25 + (erAktiv ? 8 : 6), y: skalaY - 10,
      size: erAktiv ? 9 : 7.5, font: fontBold, color: erAktiv ? hvit : rgb(0.7, 0.7, 0.7) });
  });
  side1.drawText("Energiskala", { x: skalaX, y: skalaY - 26, size: 7, font: fontNormal, color: gråLt });

  y -= 108;

  // ── Nøkkeltall-bokser ───────────────────────────────────────
  const colW = (595 - 80) / 3;
  const metrikker = [
    { lbl: "Levert energi",      val: `${kwhPerM2} kWh/m²/år`,                      ikon: "~" },
    { lbl: "Totalt forbruk",     val: `${totalKwh.toLocaleString("no")} kWh/år`,     ikon: "~" },
    { lbl: "Est. strømkostnad",  val: `${strømkostnad.toLocaleString("no")} kr/år`,  ikon: "~" },
  ];
  metrikker.forEach((m, i) => {
    const bx = 40 + colW * i;
    side1.drawRectangle({ x: bx, y: y - 52, width: colW - 8, height: 56, color: hvit, borderRadius: 5 });
    side1.drawRectangle({ x: bx, y: y - 52, width: colW - 8, height: 3, color: green, borderRadius: 2 });
    side1.drawRectangle({ x: bx, y: y - 52, width: colW - 8, height: 56,
      color: rgb(0, 0, 0), opacity: 0 }); // shadow trick
    side1.drawText(m.lbl, { x: bx + 8, y: y - 20, size: 7.5, font: fontNormal, color: grå });
    side1.drawText(safePDF(m.val), { x: bx + 8, y: y - 38, size: 10.5, font: fontBold, color: navy });
  });

  y -= 70;

  // ── Anbefalte tiltak ────────────────────────────────────────
  seksjonHeader(side1, "Anbefalte tiltak", 40, y);
  side1.drawText("Sortert etter tilbakebetalingstid", { x: 40, y: y - 15, size: 8, font: fontNormal, color: gråLt });
  y -= 32;

  const høyPrioritet = (pakke === "oppgraderingsplan" ? tiltak : tiltak.filter(t => t.prioritet === "høy")).slice(0, 6);
  høyPrioritet.forEach((t, i) => {
    if (y < 80) return;
    const erMørk = i % 2 === 0;
    side1.drawRectangle({ x: 40, y: y - 42, width: 595 - 80, height: 46, color: erMørk ? lys : hvit, borderRadius: 4 });
    side1.drawRectangle({ x: 40, y: y - 42, width: 3, height: 46, color: green });

    side1.drawText(safePDF(t.navn), { x: 52, y: y - 14, size: 9.5, font: fontBold, color: navy });
    side1.drawText(safePDF(t.beskrivelse.slice(0, 75)), { x: 52, y: y - 28, size: 7.5, font: fontNormal, color: grå });

    side1.drawText(safePDF(`Enova: ${t.støtte_min/1000}–${t.støtte_max/1000}k kr`),
      { x: 595 - 255, y: y - 14, size: 8, font: fontBold, color: green });
    side1.drawText(safePDF(`Sparer: ~${t.besparelse_kr.toLocaleString("no")} kr/år`),
      { x: 595 - 255, y: y - 28, size: 7.5, font: fontNormal, color: grå });

    const tbTekst = t.tilbakebetaling <= 30 ? `${t.tilbakebetaling} år` : ">30 år";
    side1.drawText(safePDF(`${tbTekst}`), { x: 595 - 110, y: y - 14, size: 8, font: fontBold, color: navy });
    side1.drawText("tilbakebetaling", { x: 595 - 110, y: y - 27, size: 7, font: fontNormal, color: gråLt });

    y -= 52;
  });

  // ── EPBD-seksjon ────────────────────────────────────────────
  if (y > 160) {
    y -= 14;
    seksjonHeader(side1, "EPBD 2024-status", 40, y);
    y -= 22;
    [
      { krav: "EU-krav 2030 (merke E)",    ok: merke.merke <= "E" },
      { krav: "EU-krav 2033 (merke D)",    ok: merke.merke <= "D" },
      { krav: "nZEB-standard (merke A/B)", ok: merke.merke <= "B" },
    ].forEach(p => {
      const bgFarge = p.ok ? greenLt : oransjLt;
      side1.drawRectangle({ x: 40, y: y - 16, width: 595 - 80, height: 20, color: bgFarge, borderRadius: 3 });
      side1.drawText(p.ok ? "OK" : "!", { x: 48, y: y - 10, size: 9, font: fontBold, color: p.ok ? green : oransj });
      side1.drawText(safePDF(p.krav), { x: 64, y: y - 10, size: 8.5, font: fontNormal, color: navy });
      side1.drawText(p.ok ? "Oppfylt" : "Tiltak anbefales",
        { x: 595 - 160, y: y - 10, size: 8.5, font: fontBold, color: p.ok ? green : oransj });
      y -= 24;
    });
  }

  footer(side1);

  // ── Side 2 + 3: Oppgraderingsplan ───────────────────────────
  if (pakke === "oppgraderingsplan") {
    console.log("[PDF] Legger til side 2 (Oppgraderingsplan)");

    const side2 = pdfDoc.addPage([595, 842]);
    sideHeader(side2, "Økonomianalyse og handlingsplan", 2, totSider);

    const høy = tiltak;
    // Konsistent med enkelt-rader som viser "inntil støtte_max":
    // bruker støtte_max på totalen slik at sum av enkelt-tiltak matcher total.
    const totInv    = høy.reduce((s, t) => s + t.kostnad_snitt, 0);
    const totStøtte = høy.reduce((s, t) => s + t.støtte_max, 0);
    const netto     = totInv - totStøtte;
    const totBes    = høy.reduce((s, t) => s + t.besparelse_kr, 0);
    const breakEven = totBes > 0 ? Math.round(netto / totBes) : 99;
    const bestTiltak = høy[0];
    const merkePotensial = data.resultat.merkePotensial;

    let y2 = 842 - 86;

    // ── A: Økonomianalyse ──────────────────────────────────────
    seksjonHeader(side2, "Økonomianalyse", 40, y2);
    y2 -= 8;

    const okoRader = [
      ["Total investering (alle tiltak):",   `${totInv.toLocaleString("no")} kr`,          false],
      ["Mulig Enova-støtte (inntil):",       `- ${totStøtte.toLocaleString("no")} kr`,     true ],
      ["Netto kostnad etter støtte:",        `${netto.toLocaleString("no")} kr`,           false],
      ["Estimert årsbesparelse:",            `${totBes.toLocaleString("no")} kr/år`,       false],
      ["Besparelse over 10 år:",             `${(totBes * 10).toLocaleString("no")} kr`,   false],
      ["Besparelse over 20 år:",             `${(totBes * 20).toLocaleString("no")} kr`,   false],
      ["Break-even:",                        `${breakEven} år`,                             false],
    ];

    const okoH = okoRader.length * 19 + 16;
    side2.drawRectangle({ x: 40, y: y2 - okoH, width: 595 - 80, height: okoH + 4, color: lys, borderRadius: 5 });
    y2 -= 6;
    okoRader.forEach(([k, v, isGreen], idx) => {
      const rowBg = idx % 2 === 0 ? hvit : lys;
      side2.drawRectangle({ x: 42, y: y2 - 14, width: 595 - 84, height: 18, color: rowBg });
      side2.drawText(safePDF(k), { x: 52, y: y2 - 8, size: 8.5, font: fontNormal, color: grå });
      side2.drawText(safePDF(v), { x: 360, y: y2 - 8, size: 9, font: fontBold,
        color: isGreen ? green : navy });
      y2 -= 19;
    });
    y2 -= 16;

    // ── B: Handlingsplan ───────────────────────────────────────
    seksjonHeader(side2, "Din handlingsplan – Start her", 40, y2);
    y2 -= 16;

    if (bestTiltak) {
      side2.drawRectangle({ x: 40, y: y2 - 52, width: 595 - 80, height: 56, color: greenLt, borderRadius: 5 });
      side2.drawRectangle({ x: 40, y: y2 - 52, width: 3, height: 56, color: green });
      side2.drawText("BESTE INVESTERING NÅ", { x: 52, y: y2 - 10, size: 7.5, font: fontBold, color: green });
      side2.drawText(safePDF(bestTiltak.navn), { x: 52, y: y2 - 24, size: 11, font: fontBold, color: navy });
      const tbStr = bestTiltak.tilbakebetaling <= 30
        ? `${bestTiltak.tilbakebetaling} års tilbakebetaling`
        : "Lang sikt";
      side2.drawText(
        safePDF(`${tbStr} – Enova inntil ${(bestTiltak.støtte_max/1000).toFixed(0)}k kr – Sparer ${bestTiltak.besparelse_kr.toLocaleString("no")} kr/år`),
        { x: 52, y: y2 - 40, size: 8, font: fontNormal, color: grå });
      y2 -= 64;
    }

    høy.slice(1).forEach((t, i) => {
      if (y2 < 180) return;
      side2.drawRectangle({ x: 40, y: y2 - 20, width: 595 - 80, height: 24, color: i % 2 === 0 ? lys : hvit, borderRadius: 3 });
      side2.drawText(safePDF(`${i + 2}. ${t.navn}`),
        { x: 52, y: y2 - 13, size: 9, font: fontBold, color: navy });
      const tbStr2 = t.tilbakebetaling <= 30 ? `${t.tilbakebetaling} år` : "Lang sikt";
      side2.drawText(
        safePDF(`${tbStr2} tilbakebetaling – ~${t.besparelse_kr.toLocaleString("no")} kr/år`),
        { x: 240, y: y2 - 13, size: 8, font: fontNormal, color: grå });
      y2 -= 26;
    });

    y2 -= 14;

    // ── C: Enova-søknadspakke ──────────────────────────────────
    if (y2 > 180) {
      seksjonHeader(side2, "Enova-søknadspakke", 40, y2);
      side2.drawText("enova.no/privat/alle-energitiltak/", { x: 310, y: y2, size: 8, font: fontNormal, color: grå });
      y2 -= 16;

      const DOCS = {
        tetting:          "Faktura + trykktest-rapport",
        isolering_loft:   "Faktura + isolasjonstykkelse dokumentasjon",
        isolering_vegger: "Faktura + isolasjonstykkelse dokumentasjon",
        varmepumpe_ll:    "Faktura fra godkjent installator + teknisk spesifikasjon",
        varmepumpe_lv:    "Faktura fra godkjent installator + teknisk spesifikasjon",
        vinduer:          "Faktura + U-verdi dokumentasjon",
        ventilasjon:      "Faktura fra godkjent installator + SFP-verdi",
        solceller:        "Faktura + teknisk dok. + nettilknytningsavtale",
      };

      høy.forEach((t, idx) => {
        if (y2 < 180) return;
        side2.drawRectangle({ x: 40, y: y2 - 28, width: 595 - 80, height: 32,
          color: idx % 2 === 0 ? lys : hvit, borderRadius: 3 });
        side2.drawText(safePDF(`${t.navn} (inntil ${(t.støtte_max/1000).toFixed(0)}k kr):`),
          { x: 52, y: y2 - 10, size: 8.5, font: fontBold, color: navy });
        side2.drawText(safePDF(DOCS[t.id] || "Faktura fra godkjent fagperson, teknisk dokumentasjon"),
          { x: 52, y: y2 - 22, size: 8, font: fontNormal, color: grå });
        y2 -= 34;
      });
    }

    footer(side2);

    // ── Side 3: Søknadstekst + Finansieringstips ──────────────
    const side3 = pdfDoc.addPage([595, 842]);
    sideHeader(side3, "Søknadstekst og finansieringstips", 3, totSider);

    let y3 = 842 - 86;

    // Søknadstekst
    seksjonHeader(side3, "Ferdig søknadstekst for Enova (kopier og lim inn)", 40, y3);
    y3 -= 14;

    const kwhSpart = høy.reduce((s, t) => s + Math.round(totalKwh * t.kWh_pct), 0);
    const søknadstekst = `Jeg søker om støtte til energitiltak i min bolig. Boligen ble bygget i perioden ${bygData.label} og har i dag estimert energimerke ${merke.merke}. Tiltakene jeg planlegger å gjennomføre er: ${høy.map(t => t.navn).join(", ")}. Forventet energibesparelse er ca. ${kwhSpart.toLocaleString("no")} kWh per år, noe som tilsvarer ca. ${totBes.toLocaleString("no")} kroner i reduserte strømutgifter. Tiltakene vil forbedre boligens energimerke fra ${merke.merke} til estimert ${merkePotensial ? merkePotensial.merke : "B"}.`;

    const linjer = wrapText(søknadstekst, fontNormal, 9, 595 - 100);
    const søkH = linjer.slice(0, 8).length * 15 + 20;
    side3.drawRectangle({ x: 40, y: y3 - søkH, width: 595 - 80, height: søkH + 4, color: lys, borderRadius: 5 });
    side3.drawRectangle({ x: 40, y: y3 - søkH, width: 3, height: søkH + 4, color: navy });
    y3 -= 8;
    linjer.slice(0, 8).forEach(linje => {
      side3.drawText(safePDF(linje), { x: 52, y: y3, size: 9, font: fontNormal, color: navy });
      y3 -= 15;
    });

    y3 -= 24;

    // Finansieringstips
    seksjonHeader(side3, "Finansieringstips", 40, y3);
    y3 -= 18;

    const tips = [
      ["Grønt boliglån", "Mange banker tilbyr lavere rente ved oppgradering til energimerke A eller B. Spar 0,2–0,5 prosentpoeng."],
      ["Husbanken grønt lån", "Gunstig finansiering for energioppgradering av eldre boliger. Se husbanken.no."],
      ["Kombiner tiltak", "Bestill flere tiltak hos samme håndverker – reduser riggkostnader og få bedre totalpris."],
      ["Viktig", "Søk Enova-støtte før du bestiller håndverkere. Enova krever at søknaden er godkjent på forhånd."],
    ];

    tips.forEach(([tittel, tekst], idx) => {
      if (y3 < 60) return;
      const tipH = 44;
      side3.drawRectangle({ x: 40, y: y3 - tipH, width: 595 - 80, height: tipH + 4,
        color: idx % 2 === 0 ? lys : hvit, borderRadius: 4 });
      side3.drawRectangle({ x: 40, y: y3 - tipH, width: 3, height: tipH + 4,
        color: idx === 3 ? oransj : green });
      side3.drawText(safePDF(tittel), { x: 52, y: y3 - 10, size: 9.5, font: fontBold,
        color: idx === 3 ? oransj : navy });
      const tipsLinjer = wrapText(tekst, fontNormal, 8.5, 595 - 130);
      tipsLinjer.slice(0, 2).forEach((l, li) => {
        side3.drawText(safePDF(l), { x: 52, y: y3 - 24 - li * 13, size: 8.5, font: fontNormal, color: grå });
      });
      y3 -= tipH + 10;
    });

    footer(side3);
  }

  const bytes = await pdfDoc.save();
  console.log(`[PDF] Ferdig – ${pdfDoc.getPageCount()} side(r), ${bytes.length} bytes`);
  return bytes;
}

// ── Send e-post: Energirapport ────────────────────────────────
async function sendEpost(epostAdresse, pdfBytes, data) {
  console.log("[E-POST] Sender Energirapport til:", epostAdresse);
  console.log("[E-POST] Fra:", FROM_EMAIL);
  const { merke, kwhPerM2, tiltak } = data.resultat;
  // Bruker støtte_max for konsistens med "inntil X kr"-visning per tiltak
  const totalStøtte = tiltak.filter(t => t.prioritet === "høy").reduce((s, t) => s + t.støtte_max, 0);

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: epostAdresse,
    subject: `Din energirapport - Merke ${merke.merke} (${kwhPerM2} kWh/m²/år)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0ede8;padding:0 0 32px">
        <div style="background:#1b3a5c;padding:28px 32px">
          <h1 style="color:white;margin:0;font-size:22px">BoligEffekt</h1>
          <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:13px">Din energirapport er klar</p>
        </div>
        <div style="padding:32px">
          <p style="color:#0f2540;font-size:16px;margin-bottom:24px">Hei,<br><br>Takk for kjøpet! Her er din komplette energirapport.</p>
          <div style="background:white;border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid rgba(27,58,92,0.1)">
            <h2 style="color:#1b3a5c;margin:0 0 16px;font-size:18px">Ditt resultat</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#6b7a8d;font-size:14px">Energimerke</td><td style="padding:8px 0;font-weight:bold;color:#0f2540;text-align:right">Merke ${merke.merke} – ${merke.epbd}</td></tr>
              <tr style="border-top:1px solid #f0ede8"><td style="padding:8px 0;color:#6b7a8d;font-size:14px">Energibruk</td><td style="padding:8px 0;font-weight:bold;color:#0f2540;text-align:right">${kwhPerM2} kWh/m²/år</td></tr>
              <tr style="border-top:1px solid #f0ede8"><td style="padding:8px 0;color:#6b7a8d;font-size:14px">Mulig Enova-støtte</td><td style="padding:8px 0;font-weight:bold;color:#2ab55a;text-align:right">inntil ${totalStøtte.toLocaleString("no")} kr</td></tr>
            </table>
          </div>
          <div style="background:#1b3a5c;border-radius:12px;padding:20px;margin-bottom:20px">
            <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:0 0 8px">Tips: Start med tiltakene markert "Anbefalt" i PDF-rapporten – de gir kortest tilbakebetalingstid.</p>
            <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:0">Søk Enova-støtte på <a href="https://www.enova.no" style="color:#3ecf6e">enova.no</a> før du bestiller håndverkere.</p>
          </div>
          <p style="color:#6b7a8d;font-size:13px;line-height:1.6">Full rapport er vedlagt som PDF.<br>Spørsmål? Svar på denne e-posten.</p>
        </div>
        <div style="padding:0 32px;border-top:1px solid rgba(27,58,92,0.1)">
          <p style="color:#bbb;font-size:11px;line-height:1.6;margin-top:20px">BoligEffekt · Estimat basert på NS-EN ISO 52000 og TEK-historikk.<br>For offisielt energimerke kreves godkjent energirådgiver.</p>
        </div>
      </div>`,
    attachments: [{ filename: `BoligEffekt-rapport-merke-${merke.merke}.pdf`, content: Buffer.from(pdfBytes).toString("base64") }],
  });

  console.log("[E-POST] Resend respons (Energirapport):", JSON.stringify(result));
  if (result.error) {
    throw new Error(`Resend feil: ${result.error.message || JSON.stringify(result.error)}`);
  }
  return result;
}

// ── Send e-post: Oppgraderingsplan ────────────────────────────
async function sendEpostOppgradering(epostAdresse, pdfBytes, data) {
  console.log("[E-POST] Sender Oppgraderingsplan til:", epostAdresse);
  console.log("[E-POST] Fra:", FROM_EMAIL);
  const { merke, kwhPerM2, tiltak, bygData, merkePotensial, totalKwh } = data.resultat;
  // tiltak er allerede brukervalgte tiltak fra den interaktive flyten – ikke filtrer på prioritet
  const høy       = tiltak;
  const totInv    = høy.reduce((s, t) => s + t.kostnad_snitt, 0);
  // Bruker støtte_max for konsistens med "inntil X kr"-visning per tiltak
  const totStøtte = høy.reduce((s, t) => s + t.støtte_max, 0);
  const netto     = totInv - totStøtte;
  const totBes    = høy.reduce((s, t) => s + t.besparelse_kr, 0);
  const breakEven = totBes > 0 ? Math.round(netto / totBes) : "–";
  const bestTiltak = høy[0];
  const top3 = høy.slice(0, 3);
  const kwhSpart = høy.reduce((s, t) => s + Math.round(totalKwh * t.kWh_pct), 0);
  const søknadstekst = `Jeg søker om støtte til energitiltak i min bolig. Boligen ble bygget i perioden ${bygData.label} og har i dag estimert energimerke ${merke.merke}. Tiltakene jeg planlegger å gjennomføre er: ${høy.map(t => t.navn).join(", ")}. Forventet energibesparelse er ca. ${kwhSpart.toLocaleString("no")} kWh per år, noe som tilsvarer ca. ${totBes.toLocaleString("no")} kroner i reduserte strømutgifter. Tiltakene vil forbedre boligens energimerke fra ${merke.merke} til estimert ${merkePotensial ? merkePotensial.merke : "B"}.`;

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: epostAdresse,
    subject: `Din Oppgraderingsplan - Merke ${merke.merke} til ${merkePotensial ? merkePotensial.merke : "B"} (${kwhPerM2} kWh/m²/år)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0ede8;padding:0 0 32px">
        <div style="background:#1b3a5c;padding:28px 32px">
          <h1 style="color:white;margin:0;font-size:22px">BoligEffekt</h1>
          <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:13px">Din Oppgraderingsplan er klar</p>
        </div>
        <div style="padding:32px">
          <p style="color:#0f2540;font-size:15px;margin-bottom:24px">Hei,<br><br>Takk for kjøpet av Oppgraderingsplan! Her er din komplette energianalyse med handlingsplan. Rapporten er vedlagt som PDF (${pdfDoc_pageCount(3)} sider).</p>

          <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid rgba(27,58,92,0.1)">
            <h2 style="color:#1b3a5c;margin:0 0 12px;font-size:16px">Energistatus</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:7px 0;color:#6b7a8d;font-size:13px">Nåværende merke</td><td style="padding:7px 0;font-weight:bold;color:#0f2540;text-align:right">Merke ${merke.merke} – ${kwhPerM2} kWh/m²/år</td></tr>
              <tr style="border-top:1px solid #f0ede8"><td style="padding:7px 0;color:#6b7a8d;font-size:13px">Potensielt merke</td><td style="padding:7px 0;font-weight:bold;color:#2ab55a;text-align:right">Merke ${merkePotensial ? merkePotensial.merke : "B"} med anbefalte tiltak</td></tr>
            </table>
          </div>

          <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid rgba(27,58,92,0.1)">
            <h2 style="color:#1b3a5c;margin:0 0 12px;font-size:16px">Økonomianalyse</h2>
            <table style="width:100%;border-collapse:collapse">
              ${[
                ["Total investering",          `${totInv.toLocaleString("no")} kr`],
                ["Mulig Enova-støtte (inntil)", `${totStøtte.toLocaleString("no")} kr`],
                ["Netto kostnad etter støtte", `${netto.toLocaleString("no")} kr`],
                ["Estimert årsbesparelse",    `${totBes.toLocaleString("no")} kr`],
                ["Besparelse over 10 år",     `${(totBes*10).toLocaleString("no")} kr`],
                ["Break-even",                `${breakEven} år`],
              ].map(([k, v]) => `<tr style="border-top:1px solid #f0ede8"><td style="padding:7px 0;color:#6b7a8d;font-size:13px">${k}</td><td style="padding:7px 0;font-weight:bold;color:#0f2540;text-align:right">${v}</td></tr>`).join("")}
            </table>
          </div>

          ${bestTiltak ? `
          <div style="background:#1b3a5c;border-radius:12px;padding:18px;margin-bottom:16px">
            <p style="color:#3ecf6e;font-size:11px;font-weight:800;letter-spacing:0.08em;margin:0 0 6px;text-transform:uppercase">Beste investering nå</p>
            <p style="color:white;font-weight:bold;font-size:15px;margin:0 0 6px">${bestTiltak.navn}</p>
            <p style="color:rgba(255,255,255,0.65);font-size:12px;margin:0">${bestTiltak.tilbakebetaling <= 30 ? bestTiltak.tilbakebetaling + " års tilbakebetaling" : "Lang sikt"} · Enova inntil ${(bestTiltak.støtte_max/1000).toFixed(0)}k kr · ~${bestTiltak.besparelse_kr.toLocaleString("no")} kr/år besparelse</p>
          </div>` : ""}

          <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid rgba(27,58,92,0.1)">
            <h2 style="color:#1b3a5c;margin:0 0 12px;font-size:16px">Topp tiltak med Enova-søknad</h2>
            ${top3.map(t => `
              <div style="border-top:1px solid #f0ede8;padding:10px 0">
                <p style="margin:0 0 3px;font-weight:700;color:#0f2540;font-size:13px">${t.navn}</p>
                <p style="margin:0 0 6px;color:#6b7a8d;font-size:12px">Støtte inntil ${(t.støtte_max/1000).toFixed(0)}k kr · ~${t.besparelse_kr.toLocaleString("no")} kr/år</p>
                <a href="https://www.enova.no/privat/alle-energitiltak/" style="color:#1b3a5c;font-size:12px;font-weight:700">Søk Enova-støtte →</a>
              </div>`).join("")}
          </div>

          <div style="background:#f7f5f2;border-radius:12px;padding:18px;margin-bottom:16px;border:1px solid rgba(27,58,92,0.08)">
            <h2 style="color:#1b3a5c;margin:0 0 10px;font-size:15px">Ferdig søknadstekst for Enova</h2>
            <p style="color:#6b7a8d;font-size:12px;margin:0 0 10px;font-style:italic">${søknadstekst}</p>
            <p style="color:#6b7a8d;font-size:11px;margin:0">Kopier teksten og lim inn i Enova-søknaden din på enova.no</p>
          </div>

          <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid rgba(27,58,92,0.1)">
            <h2 style="color:#1b3a5c;margin:0 0 12px;font-size:16px">Finansieringstips</h2>
            <p style="color:#6b7a8d;font-size:13px;margin:0 0 8px"><strong style="color:#0f2540">Grønt boliglån:</strong> Mange banker tilbyr lavere rente ved energioppgradering til A eller B-merke. Sjekk med din bank.</p>
            <p style="color:#6b7a8d;font-size:13px;margin:0 0 8px"><strong style="color:#0f2540">Husbanken grønt lån:</strong> Gunstig finansiering for energioppgradering. <a href="https://www.husbanken.no" style="color:#1b3a5c;font-weight:700">husbanken.no →</a></p>
            <p style="color:#6b7a8d;font-size:13px;margin:0"><strong style="color:#0f2540">Tips:</strong> Bestill flere tiltak hos samme håndverker for å redusere riggkostnader og få bedre totalpris.</p>
          </div>

          <p style="color:#6b7a8d;font-size:13px;line-height:1.6">Full rapport (${pdfDoc_pageCount(3)} sider) er vedlagt som PDF.<br>Spørsmål? Svar på denne e-posten.</p>
        </div>
        <div style="padding:0 32px;border-top:1px solid rgba(27,58,92,0.1)">
          <p style="color:#bbb;font-size:11px;line-height:1.6;margin-top:20px">BoligEffekt · Estimat basert på NS-EN ISO 52000 og TEK-historikk.<br>For offisielt energimerke kreves godkjent energirådgiver.</p>
        </div>
      </div>`,
    attachments: [{ filename: `BoligEffekt-oppgraderingsplan-merke-${merke.merke}.pdf`, content: Buffer.from(pdfBytes).toString("base64") }],
  });

  console.log("[E-POST] Resend respons (Oppgraderingsplan):", JSON.stringify(result));
  if (result.error) {
    throw new Error(`Resend feil: ${result.error.message || JSON.stringify(result.error)}`);
  }
  return result;
}

// Hjelpefunksjon brukt i e-post-HTML (returnerer statisk tall)
function pdfDoc_pageCount(n) { return n; }

// ── API-endepunkter ───────────────────────────────────────────

// 1. Opprett Stripe betalingsøkt
app.post("/api/create-checkout", async (req, res) => {
  try {
    const { resultatId, email, resultatData, pakke } = req.body;

    // Validering
    if (!resultatId || typeof resultatId !== "string" || resultatId.length > 200)
      return res.status(400).json({ feil: "Ugyldig resultatId" });
    if (email && !erEpost(email))
      return res.status(400).json({ feil: "Ugyldig e-postadresse" });
    if (pakke && !GYLDIGE_PAKKER.includes(pakke))
      return res.status(400).json({ feil: "Ugyldig pakke" });
    if (!resultatData || typeof resultatData !== "object" || Array.isArray(resultatData))
      return res.status(400).json({ feil: "Mangler resultatData" });

    console.log("[CHECKOUT] Pakke:", pakke);

    const PAKKER = {
      energirapport:     { navn: "BoligEffekt – Energirapport",     beskrivelse: "Energimerke, tiltaksplan, Enova-støtteoversikt, EPBD-status og PDF-rapport", beløp: 19900 },
      oppgraderingsplan: { navn: "BoligEffekt – Oppgraderingsplan", beskrivelse: "Alt i Energirapport + økonomianalyse, handlingsplan, Enova-søknadspakke, søknadstekst og finansieringstips", beløp: 39900 },
    };
    const valgtPakke = PAKKER[pakke] || PAKKER.energirapport;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: { currency: "nok", product_data: { name: valgtPakke.navn, description: valgtPakke.beskrivelse }, unit_amount: valgtPakke.beløp }, quantity: 1 }],
      mode: "payment",
      customer_email: email || undefined,
      success_url: `${process.env.FRONTEND_URL}?session_id={CHECKOUT_SESSION_ID}&resultat=${resultatId}`,
      cancel_url: `${process.env.FRONTEND_URL}?avbrutt=true`,
      metadata: { resultatId, pakke: pakke || "energirapport", resultat_json: JSON.stringify(resultatData).slice(0, 490) },
      locale: "nb",
    });

    console.log("[CHECKOUT] Stripe session opprettet:", session.id);
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[CHECKOUT] Feil:", err.message);
    res.status(500).json({ feil: "Kunne ikke opprette betalingsøkt. Prøv igjen." });
  }
});

// 2. Verifiser betaling
app.get("/api/verifiser-betaling", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id || typeof session_id !== "string" || !/^cs_[a-zA-Z0-9_]{10,}$/.test(session_id))
      return res.status(400).json({ feil: "Ugyldig session_id" });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid") return res.json({ betalt: false });
    res.json({ betalt: true, epost: session.customer_email });
  } catch (err) {
    console.error("[VERIFISER] Feil:", err.message);
    res.status(400).json({ feil: "Kunne ikke verifisere betaling" });
  }
});

// 3. Generer og send PDF etter betaling
app.post("/api/send-rapport", async (req, res) => {
  console.log("[RAPPORT] Mottatt forespørsel");
  try {
    const { session_id, resultatData, epost, pakke } = req.body;

    // Validering
    if (!session_id || typeof session_id !== "string" || !/^cs_[a-zA-Z0-9_]{10,}$/.test(session_id))
      return res.status(400).json({ feil: "Ugyldig session_id" });
    if (epost && !erEpost(epost))
      return res.status(400).json({ feil: "Ugyldig e-postadresse" });
    if (pakke && !GYLDIGE_PAKKER.includes(pakke))
      return res.status(400).json({ feil: "Ugyldig pakke" });
    if (!resultatData || typeof resultatData !== "object" || Array.isArray(resultatData))
      return res.status(400).json({ feil: "Mangler resultatData" });

    console.log("[RAPPORT] pakke:", pakke);
    console.log("[RAPPORT] resultatData nøkler:", resultatData ? Object.keys(resultatData) : "MANGLER");
    if (resultatData && resultatData.resultat) {
      console.log("[RAPPORT] resultat.tiltak antall:", resultatData.resultat.tiltak ? resultatData.resultat.tiltak.length : "MANGLER");
    }

    // Verifiser betaling
    console.log("[RAPPORT] Verifiserer betaling hos Stripe...");
    const session = await stripe.checkout.sessions.retrieve(session_id);
    console.log("[RAPPORT] Stripe payment_status:", session.payment_status);

    if (session.payment_status !== "paid") {
      console.error("[RAPPORT] Betaling ikke bekreftet!");
      return res.status(403).json({ feil: "Betaling ikke bekreftet" });
    }

    const kundeEpost  = epost || session.customer_email;
    const valgtPakke  = pakke || session.metadata?.pakke || "energirapport";
    console.log("[RAPPORT] Kunde e-post:", kundeEpost, "| Pakke:", valgtPakke);

    // Generer PDF
    console.log("[RAPPORT] Genererer PDF...");
    const pdfBytes = await lagPDF(resultatData, valgtPakke);
    console.log("[RAPPORT] PDF generert:", pdfBytes.length, "bytes");

    // Send e-post
    console.log("[RAPPORT] Sender e-post via Resend...");
    if (valgtPakke === "oppgraderingsplan") {
      await sendEpostOppgradering(kundeEpost, pdfBytes, resultatData);
    } else {
      await sendEpost(kundeEpost, pdfBytes, resultatData);
    }

    console.log("[RAPPORT] E-post sendt OK til:", kundeEpost);
    res.json({ ok: true });
  } catch (err) {
    console.error("[RAPPORT] FEIL:", err.message);
    console.error("[RAPPORT] Stack:", err.stack);
    res.status(500).json({ feil: "Kunne ikke generere eller sende rapport. Kontakt support." });
  }
});

// 4. Stripe webhook
app.post("/webhook", async (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("[WEBHOOK] STRIPE_WEBHOOK_SECRET mangler – alle webhooks avvises");
    return res.status(500).end();
  }
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[WEBHOOK] Signatursjekk feilet:", err.message);
    return res.status(400).end();
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log(`[WEBHOOK] Betaling mottatt: ${session.customer_email} – ${session.amount_total / 100} kr – pakke: ${session.metadata?.pakke}`);
  }
  res.json({ mottatt: true });
});

// 5. Lead-registrering
app.post("/api/lead", async (req, res) => {
  const { navn, telefon, epost, merke, tiltak } = req.body;

  // Validering
  if (!navn || typeof navn !== "string" || navn.length > 100)
    return res.status(400).json({ feil: "Ugyldig navn" });
  if (!telefon || typeof telefon !== "string" || telefon.length > 20)
    return res.status(400).json({ feil: "Ugyldig telefon" });
  if (epost && !erEpost(epost))
    return res.status(400).json({ feil: "Ugyldig e-post" });
  if (merke && (typeof merke !== "string" || !/^[A-G]$/.test(merke)))
    return res.status(400).json({ feil: "Ugyldig merke" });
  if (tiltak && (!Array.isArray(tiltak) || tiltak.length > 20))
    return res.status(400).json({ feil: "Ugyldig tiltak" });

  console.log("[LEAD] Ny lead mottatt");

  // Escape all user data before inserting into HTML
  const sNavn    = escHtml(navn);
  const sTelefon = escHtml(telefon);
  const sEpost   = escHtml(epost || "–");
  const sMerke   = escHtml(merke || "–");
  const sTiltak  = escHtml(Array.isArray(tiltak) ? tiltak.map(t => String(t).slice(0, 80)).join(", ") : "–");

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: "andrislhelle@gmail.com",
      subject: `Ny lead: ${sNavn} – Merke ${sMerke}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f0ede8;padding:0 0 28px">
          <div style="background:#1b3a5c;padding:22px 28px"><h2 style="color:white;margin:0;font-size:18px">BoligEffekt – Ny lead</h2></div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden">
              ${[["Navn", sNavn], ["Telefon", sTelefon], ["E-post", sEpost], ["Energimerke", `Merke ${sMerke}`], ["Topp tiltak", sTiltak]]
                .map(([k, v]) => `<tr><td style="padding:11px 16px;color:#6b7a8d;font-size:13px;border-bottom:1px solid #f0ede8;width:38%">${k}</td><td style="padding:11px 16px;font-weight:700;color:#0f2540;font-size:13px;border-bottom:1px solid #f0ede8">${v}</td></tr>`).join("")}
            </table>
          </div>
        </div>`,
    });
  } catch (err) {
    console.error("[LEAD] E-post feil:", err.message);
  }

  res.json({ ok: true });
});

// 6. Helsesjekk
app.get("/", (req, res) => res.json({ status: "ok" }));

// ── Claude API via fetch (ingen SDK) ──────────────────────────
// Støtter flere mulige navn på API-nøkkelen i Railway/miljøvariabler
const CLAUDE_API_KEY =
  process.env.CLAUDE_TOKEN ||
  process.env.CLAUDE_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  "";

async function callClaude({ system, messages, max_tokens = 600 }) {
  if (!CLAUDE_API_KEY) throw new Error("Claude API-nøkkel mangler (sett CLAUDE_API_KEY i Railway)");
  const body = { model: "claude-sonnet-4-20250514", max_tokens, messages };
  if (system) body.system = system;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  return res.json();
}

// 7. Chat
app.post("/api/chat", async (req, res) => {
  const { melding, historikk = [] } = req.body;
  if (!melding || typeof melding !== "string")
    return res.status(400).json({ feil: "Mangler melding" });
  if (melding.length > 2000)
    return res.status(400).json({ feil: "Melding for lang (maks 2000 tegn)" });
  if (!Array.isArray(historikk) || historikk.length > 30)
    return res.status(400).json({ feil: "Ugyldig historikk" });
  console.log("[CHAT] Melding mottatt");
  try {
    const messages = [
      ...historikk.map(h => ({ role: h.rolle === "user" ? "user" : "assistant", content: h.innhold })),
      { role: "user", content: melding },
    ];
    const response = await callClaude({
      system: "Du er en hjelpsom energirådgiver for BoligEffekt. Du hjelper norske boligeiere med generelle spørsmål om energimerking (A-G skala), Enova-støtte, TEK17, EPBD 2024 og energioppgradering av boliger. Svar alltid på norsk. Vær konkret og hjelpsom. VIKTIG: Du skal IKKE gi spesifikke beregninger, tiltaksplaner, prioriteringer, Enova-søknadsveiledning eller detaljerte anbefalinger for enkeltboliger - dette er premiuminnhold som kun er tilgjengelig i en BoligEffekt-rapport. Hvis noen ber om slike detaljer, svar at dette får de i en rapport fra BoligEffekt. Du kan snakke generelt om temaene, men ikke erstatte rapporten.",
      messages,
    });
    const svar = response.content[0]?.text || "Beklager, prøv igjen.";
    console.log("[CHAT] Svar lengde:", svar.length);
    res.json({ svar });
  } catch (err) {
    console.error("[CHAT] Feil:", err.message);
    res.status(500).json({ feil: "Kunne ikke hente svar akkurat nå." });
  }
});

// 8. Nyheter (cachet 24 timer)
let nyheterCache = { data: null, ts: 0 };
const NYHETER_TTL = 24 * 60 * 60 * 1000;

app.post("/api/nyheter", async (req, res) => {
  const tving = req.body?.tving === true;
  const nå = Date.now();
  if (!tving && nyheterCache.data && (nå - nyheterCache.ts < NYHETER_TTL)) {
    console.log("[NYHETER] Returnerer fra cache");
    return res.json({ nyheter: nyheterCache.data, fra_cache: true });
  }
  console.log("[NYHETER] Henter ferske nyheter fra Claude...");
  try {
    const response = await callClaude({
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: `Generer 5 relevante og realistiske nyhetsoverskrifter med sammendrag om norsk energimerking, Enova-støtte, EPBD-direktivet, TEK17 og boligoppgradering i Norge. Bruk dagens dato (${new Date().toLocaleDateString("nb-NO")}) og gjeldende regelverk. Svar KUN med JSON-array uten annen tekst:\n[{"tittel":"...","sammendrag":"...","dato":"DD.MM.ÅÅÅÅ","kilde":"Enova.no"},...]`
      }],
    });
    const tekst = response.content[0]?.text || "[]";
    const match = tekst.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Ingen JSON i svar");
    const nyheter = JSON.parse(match[0]);
    nyheterCache = { data: nyheter, ts: nå };
    console.log("[NYHETER] Hentet", nyheter.length, "nyheter");
    res.json({ nyheter, fra_cache: false });
  } catch (err) {
    console.error("[NYHETER] Feil:", err.message);
    if (nyheterCache.data) return res.json({ nyheter: nyheterCache.data, fra_cache: true });
    res.status(500).json({ feil: "Kunne ikke hente nyheter akkurat nå" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ BoligEffekt backend kjører på port ${PORT}`);
  console.log(`   CLAUDE_API_KEY: ${CLAUDE_API_KEY ? "OK" : "MANGLER – chat og nyheter vil feile!"}`);
  console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? "OK" : "MANGLER – e-post vil feile!"}`);
  console.log(`   FRONTEND_URL:   ${process.env.FRONTEND_URL || "ikke satt"}`);
});
