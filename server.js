// BoligEffekt – Backend
// Håndterer: Stripe-betaling, PDF-generering, e-postsending, AI-chat, nyheter

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const { Resend } = require("resend");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const Anthropic = require("@anthropic-ai/sdk");

// ── Startup-sjekk ─────────────────────────────────────────────
console.log("=== BoligEffekt backend starter ===");
console.log("RESEND_API_KEY:", process.env.RESEND_API_KEY
  ? `${process.env.RESEND_API_KEY.slice(0, 8)}... (OK)`
  : "MANGLER – e-post vil feile!");
console.log("RESEND_FROM_EMAIL:", process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev (standard test-avsender)");
console.log("STRIPE_SECRET_KEY:", process.env.STRIPE_SECRET_KEY ? "OK" : "MANGLER!");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "OK" : "MANGLER – chat og nyheter vil feile!");
console.log("FRONTEND_URL:", process.env.FRONTEND_URL || "(ikke satt)");
console.log("NODE_ENV:", process.env.NODE_ENV || "development");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
// onboarding@resend.dev er eneste avsender som fungerer uten domene-verifisering i Resend test-modus
const FROM_EMAIL = "onboarding@resend.dev";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors({ origin: "*" }));
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

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

  const navy   = rgb(0.067, 0.227, 0.361);
  const green  = rgb(0.165, 0.710, 0.353);
  const grå    = rgb(0.42, 0.48, 0.55);
  const lys    = rgb(0.96, 0.96, 0.95);
  const hvit   = rgb(1, 1, 1);
  const oransj = rgb(0.97, 0.58, 0.11);

  // ── Side 1: Standard energirapport ─────────────────────────
  const side1 = pdfDoc.addPage([595, 842]);
  const { width, height } = side1.getSize();

  // Header
  side1.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: navy });
  side1.drawText("BoligEffekt", { x: 40, y: height - 52, size: 22, font: fontBold, color: hvit });
  side1.drawText(pakke === "oppgraderingsplan" ? "Oppgraderingsplan" : "Energirapport",
    { x: 40, y: height - 72, size: 11, font: fontNormal, color: rgb(0.7, 0.9, 0.7) });

  const dato = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "long", year: "numeric" });
  side1.drawText(safePDF(dato), { x: width - 140, y: height - 55, size: 10, font: fontNormal, color: rgb(0.7, 0.7, 0.7) });

  // Energimerke-boks
  const merkeFarger = {
    A: rgb(0, 0.65, 0.32), B: rgb(0.34, 0.73, 0.28), C: rgb(0.71, 0.83, 0.2),
    D: rgb(1, 0.82, 0),    E: rgb(0.97, 0.58, 0.11), F: rgb(0.93, 0.11, 0.14),
    G: rgb(0.62, 0.10, 0.13),
  };
  const mFarge = merkeFarger[merke.merke] || navy;

  side1.drawRectangle({ x: 40, y: height - 200, width: 120, height: 90, color: mFarge, borderRadius: 8 });
  side1.drawText(merke.merke, { x: 75, y: height - 162, size: 48, font: fontBold, color: hvit });

  side1.drawText("Estimert energimerke",       { x: 175, y: height - 120, size: 10, font: fontBold,   color: grå });
  side1.drawText(safePDF(`Merke ${merke.merke} - ${merke.epbd}`),
                                                { x: 175, y: height - 140, size: 16, font: fontBold,   color: navy });
  side1.drawText(safePDF(bygData.label),        { x: 175, y: height - 160, size: 10, font: fontNormal, color: grå });
  side1.drawText(safePDF(`Klimasone: ${klima.label.split("(")[0].trim()}`),
                                                { x: 175, y: height - 178, size: 10, font: fontNormal, color: grå });

  // Nøkkeltall-bokser
  let y = height - 240;
  const colW = (width - 80) / 3;
  [0, 1, 2].forEach(i => side1.drawRectangle({ x: 40 + colW * i, y: y - 50, width: colW - 8, height: 60, color: lys, borderRadius: 6 }));

  [
    { lbl: "Levert energi",     val: `${kwhPerM2} kWh/m2/ar`,                   x: 50 },
    { lbl: "Totalt forbruk",    val: `${totalKwh.toLocaleString("no")} kWh/ar`,  x: 50 + colW },
    { lbl: "Est. stromkostnad", val: `${strømkostnad.toLocaleString("no")} kr/ar`, x: 50 + colW * 2 },
  ].forEach(c => {
    side1.drawText(safePDF(c.lbl), { x: c.x, y: y - 18, size: 8, font: fontBold,   color: grå });
    side1.drawText(safePDF(c.val), { x: c.x, y: y - 38, size: 11, font: fontBold,   color: navy });
  });

  // Tiltaksliste
  y = height - 340;
  side1.drawText("Anbefalte tiltak",               { x: 40, y,      size: 14, font: fontBold,   color: navy });
  side1.drawText("Sortert etter tilbakebetalingstid", { x: 40, y: y - 18, size: 9,  font: fontNormal, color: grå });

  y -= 40;
  const høyPrioritet = tiltak.filter(t => t.prioritet === "høy").slice(0, 6);
  høyPrioritet.forEach((t, i) => {
    if (y < 80) return;
    const erMørk = i % 2 === 0;
    side1.drawRectangle({ x: 40, y: y - 44, width: width - 80, height: 50, color: erMørk ? lys : hvit, borderRadius: 4 });
    side1.drawRectangle({ x: 40, y: y - 44, width: 4, height: 50, color: green });

    side1.drawText(safePDF(t.navn),                    { x: 52, y: y - 18, size: 10, font: fontBold,   color: navy });
    side1.drawText(safePDF(t.beskrivelse.slice(0, 70)), { x: 52, y: y - 32, size: 8,  font: fontNormal, color: grå });

    side1.drawText(safePDF(`Enova: ${t.støtte_min/1000}-${t.støtte_max/1000}k kr`),
      { x: width - 250, y: y - 18, size: 8, font: fontBold, color: green });
    side1.drawText(safePDF(`Sparer: ~${t.besparelse_kr.toLocaleString("no")} kr/ar`),
      { x: width - 250, y: y - 32, size: 8, font: fontNormal, color: grå });
    side1.drawText(safePDF(`${t.tilbakebetaling <= 30 ? t.tilbakebetaling + " ar" : ">30 ar"} tilbakebetaling`),
      { x: width - 130, y: y - 25, size: 8, font: fontBold, color: navy });

    y -= 58;
  });

  // EPBD-seksjon
  if (y > 160) {
    y -= 20;
    side1.drawText("EPBD 2024-status", { x: 40, y, size: 12, font: fontBold, color: navy });
    y -= 20;
    [
      { krav: "EU-krav 2030 (merke E)",   ok: merke.merke <= "E" },
      { krav: "EU-krav 2033 (merke D)",   ok: merke.merke <= "D" },
      { krav: "nZEB-standard (merke A/B)", ok: merke.merke <= "B" },
    ].forEach(p => {
      side1.drawText(p.ok ? "OK" : "!", { x: 42, y, size: 10, font: fontBold, color: p.ok ? green : oransj });
      side1.drawText(safePDF(p.krav),     { x: 58, y, size: 9,  font: fontNormal, color: navy });
      side1.drawText(p.ok ? "Oppfylt" : "Tiltak anbefales",
        { x: 280, y, size: 9, font: fontBold, color: p.ok ? green : oransj });
      y -= 18;
    });
  }

  // Footer side 1
  side1.drawRectangle({ x: 0, y: 0, width, height: 45, color: lys });
  side1.drawText("BoligEffekt - Estimat basert pa NS-EN ISO 52000 og TEK-historikk - Ikke offisielt energimerke",
    { x: 40, y: 16, size: 8, font: fontNormal, color: grå });
  side1.drawText("boligeffekt.no", { x: width - 100, y: 16, size: 8, font: fontBold, color: navy });

  // ── Side 2: Oppgraderingsplan-innhold ──────────────────────
  if (pakke === "oppgraderingsplan") {
    console.log("[PDF] Legger til side 2 (Oppgraderingsplan)");

    const side2 = pdfDoc.addPage([595, 842]);

    // Header side 2
    side2.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: navy });
    side2.drawText("BoligEffekt", { x: 40, y: height - 52, size: 22, font: fontBold, color: hvit });
    side2.drawText("Oppgraderingsplan – Side 2",
      { x: 40, y: height - 72, size: 11, font: fontNormal, color: rgb(0.7, 0.9, 0.7) });

    const høy = tiltak.filter(t => t.prioritet === "høy");
    const totInv    = høy.reduce((s, t) => s + t.kostnad_snitt, 0);
    const totStøtte = høy.reduce((s, t) => s + t.støtte_snitt, 0);
    const netto     = totInv - totStøtte;
    const totBes    = høy.reduce((s, t) => s + t.besparelse_kr, 0);
    const breakEven = totBes > 0 ? Math.round(netto / totBes) : 99;
    const bestTiltak = høy[0];
    const merkePotensial = data.resultat.merkePotensial;

    let y2 = height - 110;

    // ── A: Økonomianalyse ─────────────────────────
    side2.drawText("Okonomianalyse", { x: 40, y: y2, size: 13, font: fontBold, color: navy });
    y2 -= 6;
    side2.drawRectangle({ x: 40, y: y2 - 128, width: width - 80, height: 130, color: lys, borderRadius: 6 });
    y2 -= 14;

    const okoRader = [
      ["Total investering (alle tiltak):",       `${Math.round(totInv/1000)} 000 kr`],
      ["Total Enova-stotte:",                    `${Math.round(totStøtte/1000)} 000 kr`],
      ["Netto kostnad etter stotte:",            `${Math.round(netto/1000)} 000 kr`],
      ["Estimert arsbesparelse:",                `${totBes.toLocaleString("no")} kr`],
      ["Besparelse over 10 ar:",                 `${(totBes * 10).toLocaleString("no")} kr`],
      ["Besparelse over 20 ar:",                 `${(totBes * 20).toLocaleString("no")} kr`],
      ["Break-even:",                            `${breakEven} ar`],
    ];
    okoRader.forEach(([k, v]) => {
      side2.drawText(safePDF(k), { x: 52, y: y2, size: 9, font: fontNormal, color: grå });
      side2.drawText(safePDF(v), { x: 350, y: y2, size: 9, font: fontBold,   color: navy });
      y2 -= 17;
    });

    y2 -= 10;

    // ── B: Handlingsplan ─────────────────────────
    side2.drawText("Din handlingsplan – Start her", { x: 40, y: y2, size: 13, font: fontBold, color: navy });
    y2 -= 16;

    if (bestTiltak) {
      side2.drawRectangle({ x: 40, y: y2 - 54, width: width - 80, height: 58, color: rgb(0.90, 0.97, 0.92), borderRadius: 6 });
      side2.drawRectangle({ x: 40, y: y2 - 54, width: 4,          height: 58, color: green });
      side2.drawText("BESTE INVESTERING NA:", { x: 52, y: y2 - 10, size: 8, font: fontBold, color: green });
      side2.drawText(safePDF(bestTiltak.navn), { x: 52, y: y2 - 24, size: 11, font: fontBold, color: navy });
      side2.drawText(
        safePDF(`${bestTiltak.tilbakebetaling <= 30 ? bestTiltak.tilbakebetaling + " ars tilbakebetaling" : "Lang sikt"} - Enova inntil ${(bestTiltak.støtte_max/1000).toFixed(0)}k kr - Sparer ${bestTiltak.besparelse_kr.toLocaleString("no")} kr/ar`),
        { x: 52, y: y2 - 40, size: 8, font: fontNormal, color: grå });
      y2 -= 64;
    }

    høy.slice(1).forEach((t, i) => {
      if (y2 < 200) return;
      side2.drawText(safePDF(`${i + 2}. ${t.navn}`),
        { x: 52, y: y2, size: 9, font: fontBold, color: navy });
      side2.drawText(
        safePDF(`${t.tilbakebetaling <= 30 ? t.tilbakebetaling + " ar" : "Lang sikt"} tilbakebetaling - ~${t.besparelse_kr.toLocaleString("no")} kr/ar`),
        { x: 200, y: y2, size: 8, font: fontNormal, color: grå });
      y2 -= 16;
    });

    y2 -= 12;

    // ── C: Enova-søknadspakke (forkortet til én linje per tiltak) ──
    if (y2 > 200) {
      side2.drawText("Enova-soknadspakke", { x: 40, y: y2, size: 13, font: fontBold, color: navy });
      side2.drawText("enova.no/privat/alle-energitiltak/", { x: 300, y: y2, size: 8, font: fontNormal, color: grå });
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

      høy.forEach(t => {
        if (y2 < 200) return;
        side2.drawText(safePDF(`${t.navn} (inntil ${(t.støtte_max/1000).toFixed(0)}k kr):`),
          { x: 52, y: y2, size: 8.5, font: fontBold, color: navy });
        y2 -= 13;
        side2.drawText(safePDF(DOCS[t.id] || "Faktura fra godkjent fagperson, teknisk dokumentasjon"),
          { x: 60, y: y2, size: 8, font: fontNormal, color: grå });
        y2 -= 16;
      });
    }

    // ── Footer side 2 ─────────────────────────────
    side2.drawRectangle({ x: 0, y: 0, width, height: 45, color: lys });
    side2.drawText("BoligEffekt - Estimat basert pa NS-EN ISO 52000 og TEK-historikk - Ikke offisielt energimerke",
      { x: 40, y: 16, size: 8, font: fontNormal, color: grå });
    side2.drawText("boligeffekt.no", { x: width - 100, y: 16, size: 8, font: fontBold, color: navy });

    // ── Side 3: Søknadstekst + Finansieringstips ─
    const side3 = pdfDoc.addPage([595, 842]);

    side3.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: navy });
    side3.drawText("BoligEffekt", { x: 40, y: height - 52, size: 22, font: fontBold, color: hvit });
    side3.drawText("Oppgraderingsplan – Side 3",
      { x: 40, y: height - 72, size: 11, font: fontNormal, color: rgb(0.7, 0.9, 0.7) });

    let y3 = height - 110;

    // Søknadstekst
    side3.drawText("Ferdig soknadstekst for Enova (kopier og lim inn)", { x: 40, y: y3, size: 13, font: fontBold, color: navy });
    y3 -= 14;
    side3.drawRectangle({ x: 40, y: y3 - 120, width: width - 80, height: 122, color: lys, borderRadius: 6 });
    y3 -= 8;

    const kwhSpart = høy.reduce((s, t) => s + Math.round(totalKwh * t.kWh_pct), 0);
    const søknadstekst = `Jeg soker om stotte til energitiltak i min bolig. Boligen ble bygget i perioden ${bygData.label} og har i dag estimert energimerke ${merke.merke}. Tiltakene jeg planlegger er: ${høy.map(t => t.navn).join(", ")}. Forventet energibesparelse er ca. ${kwhSpart.toLocaleString("no")} kWh per ar, noe som tilsvarer ca. ${totBes.toLocaleString("no")} kroner i reduserte stromutgifter. Tiltakene vil forbedre boligens energimerke fra ${merke.merke} til estimert ${merkePotensial ? merkePotensial.merke : "B"}.`;

    const linjer = wrapText(søknadstekst, fontNormal, 9, width - 100);
    linjer.slice(0, 7).forEach(linje => {
      side3.drawText(safePDF(linje), { x: 52, y: y3, size: 9, font: fontNormal, color: navy });
      y3 -= 14;
    });

    y3 -= 20;

    // Finansieringstips
    side3.drawText("Finansieringstips", { x: 40, y: y3, size: 13, font: fontBold, color: navy });
    y3 -= 16;

    const tips = [
      ["Gront boliglan:", "Mange banker tilbyr lavere rente ved oppgradering til energimerke A eller B. Spar 0,2-0,5 % poeng i rente."],
      ["Husbanken gront lan:", "Gunstig finansiering for energioppgradering av eldre boliger. Se husbanken.no."],
      ["Kombiner tiltak:", "Bestill flere tiltak hos samme handverker – reduser riggkostnader og fa bedre totalpris."],
      ["Tips:", "Sok Enova-stotte for du bestiller handverkere. Enova krever at soknaden er godkjent pa forhand."],
    ];

    tips.forEach(([tittel, tekst]) => {
      if (y3 < 80) return;
      side3.drawRectangle({ x: 40, y: y3 - 36, width: width - 80, height: 40, color: lys, borderRadius: 4 });
      side3.drawText(safePDF(tittel), { x: 52, y: y3 - 10, size: 9, font: fontBold,   color: navy });
      const tipsLinjer = wrapText(tekst, fontNormal, 8.5, width - 140);
      tipsLinjer.slice(0, 2).forEach((l, li) => {
        side3.drawText(safePDF(l), { x: 52, y: y3 - 24 - li * 12, size: 8.5, font: fontNormal, color: grå });
      });
      y3 -= 50;
    });

    // Footer side 3
    side3.drawRectangle({ x: 0, y: 0, width, height: 45, color: lys });
    side3.drawText("BoligEffekt - Estimat basert pa NS-EN ISO 52000 og TEK-historikk - Ikke offisielt energimerke",
      { x: 40, y: 16, size: 8, font: fontNormal, color: grå });
    side3.drawText("boligeffekt.no", { x: width - 100, y: 16, size: 8, font: fontBold, color: navy });
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
  const totalStøtte = tiltak.filter(t => t.prioritet === "høy").reduce((s, t) => s + t.støtte_snitt, 0);

  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: epostAdresse,
    subject: `Din energirapport - Merke ${merke.merke} (${kwhPerM2} kWh/m2/ar)`,
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
  const høy       = tiltak.filter(t => t.prioritet === "høy");
  const totInv    = høy.reduce((s, t) => s + t.kostnad_snitt, 0);
  const totStøtte = høy.reduce((s, t) => s + t.støtte_snitt, 0);
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
    subject: `Din Oppgraderingsplan - Merke ${merke.merke} til ${merkePotensial ? merkePotensial.merke : "B"} (${kwhPerM2} kWh/m2/ar)`,
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
                ["Total investering",         `${Math.round(totInv/1000)} 000 kr`],
                ["Total Enova-støtte",         `${Math.round(totStøtte/1000)} 000 kr`],
                ["Netto kostnad etter støtte", `${Math.round(netto/1000)} 000 kr`],
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
    console.log("[CHECKOUT] Pakke:", pakke, "- E-post:", email);

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
    res.status(500).json({ feil: err.message });
  }
});

// 2. Verifiser betaling
app.get("/api/verifiser-betaling", async (req, res) => {
  try {
    const { session_id } = req.query;
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid") return res.json({ betalt: false });
    res.json({ betalt: true, epost: session.customer_email });
  } catch (err) {
    res.status(400).json({ feil: err.message });
  }
});

// 3. Generer og send PDF etter betaling
app.post("/api/send-rapport", async (req, res) => {
  console.log("[RAPPORT] Mottatt forespørsel");
  try {
    const { session_id, resultatData, epost, pakke } = req.body;

    console.log("[RAPPORT] session_id:", session_id);
    console.log("[RAPPORT] pakke:", pakke);
    console.log("[RAPPORT] epost:", epost);
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
    res.json({ ok: true, epost: kundeEpost });
  } catch (err) {
    console.error("[RAPPORT] FEIL:", err.message);
    console.error("[RAPPORT] Stack:", err.stack);
    res.status(500).json({ feil: err.message });
  }
});

// 4. Stripe webhook
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch (err) {
    return res.status(400).send(`Webhook feil: ${err.message}`);
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
  console.log("NY LEAD:", { navn, telefon, epost, merke, tiltak });

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: "andrislhelle@gmail.com",
      subject: `Ny lead: ${navn} – Merke ${merke}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f0ede8;padding:0 0 28px">
          <div style="background:#1b3a5c;padding:22px 28px"><h2 style="color:white;margin:0;font-size:18px">BoligEffekt – Ny lead</h2></div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden">
              ${[["Navn", navn], ["Telefon", telefon], ["E-post", epost || "–"], ["Energimerke", `Merke ${merke}`], ["Topp tiltak", (tiltak||[]).join(", ") || "–"]]
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
app.get("/", (req, res) => res.json({ status: "BoligEffekt backend kjører", resend: !!process.env.RESEND_API_KEY, stripe: !!process.env.STRIPE_SECRET_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY }));

// 7. AI-chat
app.post("/api/chat", async (req, res) => {
  const { melding, historikk = [] } = req.body;
  console.log("[CHAT] Ny melding:", melding?.slice(0, 80));
  if (!melding) return res.status(400).json({ feil: "Mangler melding" });

  try {
    const messages = [
      ...historikk.map(h => ({ role: h.rolle === "user" ? "user" : "assistant", content: h.innhold })),
      { role: "user", content: melding },
    ];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: "Du er en hjelpsom energirådgiver for BoligEffekt. Du hjelper norske boligeiere med spørsmål om energimerking (A-G skala), Enova-støtte, TEK17, EPBD 2024-direktivet og energioppgradering av boliger. Svar alltid på norsk. Vær konkret og hjelpsom. Hvis noen spør om priser på håndverkere eller spesifikke tekniske beregninger, anbefal dem å kjøpe en rapport fra BoligEffekt for nøyaktig analyse av deres bolig.",
      messages,
    });

    const svar = response.content[0]?.text || "Beklager, kunne ikke svare akkurat nå.";
    console.log("[CHAT] Svar generert, lengde:", svar.length);
    res.json({ svar });
  } catch (err) {
    console.error("[CHAT] Feil:", err.message);
    res.status(500).json({ feil: "Kunne ikke hente svar akkurat nå." });
  }
});

// 8. Nyheter (AI-generert, cachet 24 timer)
let nyheterCache = { data: null, ts: 0 };
const NYHETER_TTL = 24 * 60 * 60 * 1000; // 24 timer

async function hentNyheterFraAI() {
  console.log("[NYHETER] Henter ferske nyheter fra Claude...");
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1200,
    messages: [{
      role: "user",
      content: `Generer 5 relevante og realistiske nyhetsoverskrifter med sammendrag om norsk energimerking, Enova-støtte, EPBD-direktivet, TEK17 og boligoppgradering i Norge. Bruk dagens dato (${new Date().toLocaleDateString("nb-NO")}) og gjeldende regelverk. Svar KUN med JSON-array i dette formatet (ingen annen tekst):
[
  {"tittel":"...", "sammendrag":"...", "dato":"DD.MM.ÅÅÅÅ", "kilde":"Enova.no"},
  ...
]
Kildene skal variere mellom: Enova.no, Husbanken.no, Regjeringen.no, NVE.no, DIBK.no`
    }],
  });

  const tekst = response.content[0]?.text || "[]";
  // Finn JSON-array i svaret
  const match = tekst.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Ingen JSON-array i AI-svar");
  return JSON.parse(match[0]);
}

async function oppdaterNyheterCache() {
  try {
    const nyheter = await hentNyheterFraAI();
    nyheterCache = { data: nyheter, ts: Date.now() };
    console.log("[NYHETER] Cache oppdatert med", nyheter.length, "nyheter");
  } catch (err) {
    console.error("[NYHETER] Kunne ikke oppdatere cache:", err.message);
  }
}

app.post("/api/nyheter", async (req, res) => {
  const { tving } = req.body || {};
  console.log("[NYHETER] Forespørsel mottatt, tvunget refresh:", !!tving);

  const nå = Date.now();
  const cacheGyldig = nyheterCache.data && (nå - nyheterCache.ts < NYHETER_TTL) && !tving;

  if (cacheGyldig) {
    console.log("[NYHETER] Returnerer fra cache");
    return res.json({ nyheter: nyheterCache.data, fra_cache: true });
  }

  try {
    const nyheter = await hentNyheterFraAI();
    nyheterCache = { data: nyheter, ts: nå };
    res.json({ nyheter, fra_cache: false });
  } catch (err) {
    console.error("[NYHETER] Feil:", err.message);
    if (nyheterCache.data) {
      return res.json({ nyheter: nyheterCache.data, fra_cache: true, advarsel: "Bruker gammel cache" });
    }
    res.status(500).json({ feil: "Kunne ikke hente nyheter akkurat nå" });
  }
});

// Auto-refresh nyheter hvert 24. time
setInterval(oppdaterNyheterCache, NYHETER_TTL);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ BoligEffekt backend kjører på port ${PORT}`);
  console.log(`   Frontend URL: ${process.env.FRONTEND_URL}`);
});
