// BoligEffekt – Backend
// Håndterer: Stripe-betaling, PDF-generering, e-postsending

require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const rateLimit   = require("express-rate-limit");
const { Resend }  = require("resend");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { lagPDF } = require("./pdf-generator");

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

// FREE_MODE: hopp over Stripe-verifisering og la rapporten genereres gratis.
// Brukes for feedback-runder før vi tar penger. Stripe-infrastrukturen blir værende.
const FREE_MODE = process.env.FREE_MODE === "true";
console.log("FREE_MODE:", FREE_MODE ? "PÅ (Stripe-gate bypasset)" : "av");

const ALLOWED_ORIGINS = [
  "https://boligeffekt.no",
  "https://www.boligeffekt.no",
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
];

const app = express();

// ── Proxy-tillit (Railway) ────────────────────────────────────
// Railway kjører bak en reverse proxy. Uten dette ser express-rate-limit
// proxyens IP for ALLE brukere – én felles kvote som sperrer ekte kunder,
// og req.ip blir feil. "1" = stol på første proxy-hopp.
app.set("trust proxy", 1);

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
  // kWh_pct er andel av OPPVARMINGSbehovet – bruk oppvarmingKwh når frontend sender det
  const oppvKwh = data.resultat.oppvarmingKwh ?? totalKwh;
  const kwhSpart = høy.reduce((s, t) => s + Math.round(oppvKwh * t.kWh_pct), 0);
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
          <p style="color:#0f2540;font-size:15px;margin-bottom:24px">Hei,<br><br>Takk for kjøpet av Oppgraderingsplan! Her er din komplette energianalyse med handlingsplan. Rapporten er vedlagt som PDF (${pdfDoc_pageCount(10)} sider).</p>

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

          <p style="color:#6b7a8d;font-size:13px;line-height:1.6">Full rapport (${pdfDoc_pageCount(10)} sider) er vedlagt som PDF.<br>Spørsmål? Svar på denne e-posten.</p>
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
    const erStripeSession = typeof session_id === "string" && /^cs_[a-zA-Z0-9_]{10,}$/.test(session_id);
    const erFreeSession   = FREE_MODE && typeof session_id === "string" && /^free_[a-zA-Z0-9_]{1,40}$/.test(session_id);
    if (!erStripeSession && !erFreeSession)
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

    let kundeEpost;
    let valgtPakke;

    if (erFreeSession) {
      console.log("[RAPPORT] FREE_MODE - hopper over Stripe-verifisering");
      if (!epost) return res.status(400).json({ feil: "Mangler e-postadresse" });
      kundeEpost = epost;
      valgtPakke = pakke || "oppgraderingsplan";
    } else {
      // Verifiser betaling
      console.log("[RAPPORT] Verifiserer betaling hos Stripe...");
      const session = await stripe.checkout.sessions.retrieve(session_id);
      console.log("[RAPPORT] Stripe payment_status:", session.payment_status);

      if (session.payment_status !== "paid") {
        console.error("[RAPPORT] Betaling ikke bekreftet!");
        return res.status(403).json({ feil: "Betaling ikke bekreftet" });
      }

      kundeEpost = epost || session.customer_email;
      valgtPakke = pakke || session.metadata?.pakke || "energirapport";
    }
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
  const { navn, telefon, epost, merke, tiltak, region, tidsramme, samtykke } = req.body;

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
  if (region && (typeof region !== "string" || region.length > 120))
    return res.status(400).json({ feil: "Ugyldig region" });
  if (tidsramme && (typeof tidsramme !== "string" || tidsramme.length > 40))
    return res.status(400).json({ feil: "Ugyldig tidsramme" });
  // Samtykke registreres (frontend krever avkrysning før innsending). Vi avviser
  // IKKE manglende samtykke her – det ville koblet deploy-rekkefølgen frontend/backend
  // og brutt det live lead-skjemaet i deploy-vinduet. Leads uten samtykke skal ikke formidles.
  if (samtykke != null && typeof samtykke !== "boolean")
    return res.status(400).json({ feil: "Ugyldig samtykke" });

  console.log("[LEAD] Ny lead mottatt");

  // Escape all user data before inserting into HTML
  const TID_LABEL = { snarest: "Snarest mulig", "0-3": "Innen 3 mnd", "3-12": "Om 3–12 mnd", orientering: "Bare orientering" };
  const sNavn    = escHtml(navn);
  const sTelefon = escHtml(telefon);
  const sEpost   = escHtml(epost || "–");
  const sMerke   = escHtml(merke || "–");
  const sTiltak  = escHtml(Array.isArray(tiltak) ? tiltak.map(t => String(t).slice(0, 80)).join(", ") : "–");
  const sRegion  = escHtml(region || "–");
  const sTid     = escHtml(TID_LABEL[tidsramme] || tidsramme || "–");

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
              ${[["Navn", sNavn], ["Telefon", sTelefon], ["E-post", sEpost], ["Region", sRegion], ["Energimerke", `Merke ${sMerke}`], ["Tidsramme", sTid], ["Tiltak (fag)", sTiltak], ["Samtykke deling", samtykke === true ? "Ja" : "NEI – ikke formidle"]]
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

// 5b. Feedback fra FREE_MODE
app.post("/api/feedback", async (req, res) => {
  const { betalingsvilje, kommentar, merke } = req.body || {};

  const GYLDIG_VALG = ["199", "399", "nei"];
  if (!betalingsvilje || !GYLDIG_VALG.includes(betalingsvilje))
    return res.status(400).json({ feil: "Ugyldig valg" });
  if (kommentar && (typeof kommentar !== "string" || kommentar.length > 1000))
    return res.status(400).json({ feil: "Ugyldig kommentar" });
  if (merke && (typeof merke !== "string" || !/^[A-G]?$/.test(merke)))
    return res.status(400).json({ feil: "Ugyldig merke" });

  const sValg     = escHtml(betalingsvilje);
  const sKomm     = escHtml(kommentar || "(ingen kommentar)");
  const sMerke    = escHtml(merke || "-");
  const sNår      = new Date().toLocaleString("nb-NO");

  console.log(`[FEEDBACK] valg=${sValg} merke=${sMerke} kommentar="${(kommentar||"").slice(0,120)}"`);

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: "andrislhelle@gmail.com",
      subject: `Feedback FREE_MODE: ${sValg}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f0ede8;padding:0 0 28px">
          <div style="background:#1b3a5c;padding:22px 28px"><h2 style="color:white;margin:0;font-size:18px">BoligEffekt - Feedback</h2></div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden">
              ${[["Ville du betalt?", sValg], ["Energimerke", sMerke], ["Tidspunkt", sNår], ["Kommentar", sKomm]]
                .map(([k, v]) => `<tr><td style="padding:11px 16px;color:#6b7a8d;font-size:13px;border-bottom:1px solid #f0ede8;width:38%">${k}</td><td style="padding:11px 16px;color:#0f2540;font-size:13px;border-bottom:1px solid #f0ede8;white-space:pre-wrap">${v}</td></tr>`).join("")}
            </table>
          </div>
        </div>`,
    });
  } catch (err) {
    console.error("[FEEDBACK] E-post feil:", err.message);
  }

  res.json({ ok: true });
});

// 5d. E-postfangst fra betalingsmuren – fanger leads som IKKE kjøper med en gang.
// Sender brukeren et kort sammendrag av energimerket (oppfyller løftet på muren)
// og varsler eier om lead-en for oppfølging. Beskyttet av global rate-limit.
app.post("/api/capture-lead", async (req, res) => {
  const { epost, merke, kwhPerM2, tiltak, kilde } = req.body || {};

  if (!epost || !erEpost(epost))
    return res.status(400).json({ feil: "Ugyldig e-post" });
  if (merke && (typeof merke !== "string" || !/^[A-G]?$/.test(merke)))
    return res.status(400).json({ feil: "Ugyldig merke" });
  if (kwhPerM2 != null && (typeof kwhPerM2 !== "number" || kwhPerM2 < 0 || kwhPerM2 > 2000))
    return res.status(400).json({ feil: "Ugyldig kWh" });
  if (tiltak && (!Array.isArray(tiltak) || tiltak.length > 20))
    return res.status(400).json({ feil: "Ugyldig tiltak" });

  const sEpost  = escHtml(epost);
  const sMerke  = escHtml(merke || "-");
  const sKwh    = Number.isFinite(kwhPerM2) ? Math.round(kwhPerM2) : null;
  const tListe  = Array.isArray(tiltak) ? tiltak.map(t => String(t).slice(0, 80)).filter(Boolean).slice(0, 3) : [];
  const sTiltak = tListe.map(escHtml);
  const sKilde  = escHtml((typeof kilde === "string" ? kilde : "betalingsmur").slice(0, 40));
  const sNår    = new Date().toLocaleString("nb-NO");
  const lenke   = process.env.FRONTEND_URL || "https://boligeffekt.no";

  console.log(`[CAPTURE] e-postfangst merke=${sMerke} kilde=${sKilde}`);

  // 1) Sammendrag til brukeren (det de ba om)
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: epost,
      subject: `Energimerket på boligen din: Merke ${sMerke}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f4f0e8;padding:0 0 28px">
          <div style="background:#1b3a5c;padding:22px 28px"><h2 style="color:white;margin:0;font-size:18px">BoligEffekt</h2></div>
          <div style="padding:26px 28px">
            <p style="color:#0f2540;font-size:15px;margin:0 0 14px">Hei, og takk for at du brukte BoligEffekt.</p>
            <p style="color:#0f2540;font-size:15px;margin:0 0 18px">Her er energiestimatet for boligen din:</p>
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;margin-bottom:18px">
              <tr><td style="padding:12px 16px;color:#6b7a8d;font-size:13px;border-bottom:1px solid #f0ede8;width:50%">Estimert energimerke</td><td style="padding:12px 16px;font-weight:700;color:#0f2540;font-size:13px;border-bottom:1px solid #f0ede8">Merke ${sMerke}</td></tr>
              ${sKwh != null ? `<tr><td style="padding:12px 16px;color:#6b7a8d;font-size:13px">Beregnet forbruk</td><td style="padding:12px 16px;font-weight:700;color:#0f2540;font-size:13px">${sKwh} kWh/m²/år</td></tr>` : ""}
            </table>
            ${sTiltak.length ? `<p style="color:#0f2540;font-size:14px;margin:0 0 6px"><strong>Tiltak vi vil prioritere for din bolig:</strong></p><ul style="color:#0f2540;font-size:14px;margin:0 0 18px;padding-left:20px">${sTiltak.map(t => `<li style="margin-bottom:4px">${t}</li>`).join("")}</ul>` : ""}
            <p style="color:#0f2540;font-size:14px;margin:0 0 18px;line-height:1.6">Hele tiltaksplanen – med Enova-støtte, tilbakebetalingstid og rekkefølge – ligger klar i rapporten din.</p>
            <a href="${lenke}" style="display:inline-block;background:#2AB55A;color:white;text-decoration:none;font-weight:700;font-size:14px;padding:13px 26px;border-radius:10px">Se hele rapporten →</a>
            <p style="color:#9aa7b4;font-size:11px;margin:22px 0 0;line-height:1.5">Estimat, ikke offisiell energiattest. Du fikk denne e-posten fordi du ba om et sammendrag på boligeffekt.no.</p>
          </div>
        </div>`,
    });
  } catch (err) {
    console.error("[CAPTURE] Bruker-e-post feil:", err.message);
  }

  // 2) Varsling til eier (lead for oppfølging)
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: "andrislhelle@gmail.com",
      subject: `Ny e-postfangst: Merke ${sMerke}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f0ede8;padding:0 0 28px">
          <div style="background:#1b3a5c;padding:22px 28px"><h2 style="color:white;margin:0;font-size:18px">BoligEffekt – E-postfangst</h2></div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden">
              ${[["E-post", sEpost], ["Energimerke", `Merke ${sMerke}`], ["Kilde", sKilde], ["Tidspunkt", sNår]]
                .map(([k, v]) => `<tr><td style="padding:11px 16px;color:#6b7a8d;font-size:13px;border-bottom:1px solid #f0ede8;width:38%">${k}</td><td style="padding:11px 16px;font-weight:700;color:#0f2540;font-size:13px;border-bottom:1px solid #f0ede8">${v}</td></tr>`).join("")}
            </table>
            <p style="color:#6b7a8d;font-size:12px;margin:16px 0 0">Lead fanget på betalingsmuren (kjøpte ikke umiddelbart). Følg opp med rapport/Enova-tips.</p>
          </div>
        </div>`,
    });
  } catch (err) {
    console.error("[CAPTURE] Eier-varsling feil:", err.message);
  }

  res.json({ ok: true });
});

// 5c. Benchmark mot Enova-data (energimerker per byggeår-bøtte)
// Statisk lest fra data/enova-stats.json, oppdateres via enova-import.js.
const path = require("path");
let enovaStats = null;
try {
  enovaStats = require(path.join(__dirname, "data", "enova-stats.json"));
} catch (_) {
  console.log("[BENCHMARK] data/enova-stats.json mangler - /api/benchmark returnerer tom respons");
}

function byggeårBøtte(år) {
  if (!år || isNaN(år)) return null;
  if (år < 1950) return "Før 1950";
  if (år < 1970) return "1950-1969";
  if (år < 1987) return "1970-1986";
  if (år < 1998) return "1987-1997";
  if (år < 2008) return "1998-2007";
  if (år < 2018) return "2008-2017";
  return "Etter 2017";
}

app.get("/api/benchmark", (req, res) => {
  const år = parseInt(req.query.byggeår, 10);
  const bøtte = byggeårBøtte(år);
  if (!bøtte) return res.status(400).json({ feil: "Ugyldig byggeår" });
  if (!enovaStats || !enovaStats.perByggeårBøtte || !enovaStats.perByggeårBøtte[bøtte] || enovaStats.totaltAttester === 0) {
    return res.json({ tilgjengelig: false, bøtte });
  }
  const a = enovaStats.perByggeårBøtte[bøtte];
  res.json({
    tilgjengelig:   true,
    bøtte,
    totalt:         a.totalt,
    medianMerke:    a.median,
    snittKwhPerM2:  a.snittKwhPerM2,
    perMerke:       a.perMerke,
    oppdatert:      enovaStats.generertNår,
  });
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
        content: `Lag 5 korte, faktabaserte oppsummeringer om norsk energimerking, Enova-støtteordninger, EPBD-direktivet, TEK17 og boligoppgradering i Norge. VIKTIG: Ikke finn på nyhetshendelser, datoer eller kilder – beskriv kun faktisk gjeldende regelverk og ordninger du er sikker på. Bruk "kilde" til å angi hvilket tema/regelverk det gjelder (f.eks. "Enova-ordningen", "EPBD 2024"), og sett "dato" til "${new Date().toLocaleDateString("nb-NO")}" (genereringsdato). Svar KUN med JSON-array uten annen tekst:\n[{"tittel":"...","sammendrag":"...","dato":"DD.MM.ÅÅÅÅ","kilde":"..."},...]`
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
