// BoligEffekt – Komplett backend
// Håndterer: Stripe-betaling, PDF-generering, e-postsending
//
// Installer: npm install express stripe cors dotenv nodemailer @pdf-lib/fontkit pdf-lib

require("dotenv").config();
const express  = require("express");
const stripe   = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors     = require("cors");
const nodemailer = require("nodemailer");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const app = express();

app.use(cors({ origin: "*" }));

// Stripe webhook trenger raw body – må komme FØR express.json()
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── E-postkonfig (Gmail) ──────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,  // din@gmail.com
    pass: process.env.EMAIL_PASS,  // App-passord fra Google (ikke vanlig passord)
  },
});

// ── PDF-generator ─────────────────────────────────────────────
async function lagPDF(data) {
  const { merke, kwhPerM2, totalKwh, strømkostnad, bygData, klima, bolig,
          oppvData, primærPerM2, tiltak } = data.resultat;

  const pdfDoc = await PDFDocument.create();
  const side   = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = side.getSize();

  const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const navy  = rgb(0.067, 0.227, 0.361);
  const green = rgb(0.165, 0.710, 0.353);
  const grå   = rgb(0.42, 0.48, 0.55);
  const lys   = rgb(0.96, 0.96, 0.95);

  // Header-bakgrunn
  side.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: navy });

  // Logo-tekst
  side.drawText("BoligEffekt", { x: 40, y: height - 52, size: 22, font: fontBold, color: rgb(1,1,1) });
  side.drawText("Energirapport", { x: 40, y: height - 72, size: 11, font: fontNormal, color: rgb(0.7,0.9,0.7) });

  // Dato
  const dato = new Date().toLocaleDateString("nb-NO", { day:"2-digit", month:"long", year:"numeric" });
  side.drawText(dato, { x: width - 140, y: height - 55, size: 10, font: fontNormal, color: rgb(0.7,0.7,0.7) });

  // Energimerke-boks
  const merkeFarger = { A: rgb(0,0.65,0.32), B: rgb(0.34,0.73,0.28), C: rgb(0.71,0.83,0.2),
    D: rgb(1,0.82,0), E: rgb(0.97,0.58,0.11), F: rgb(0.93,0.11,0.14), G: rgb(0.62,0.10,0.13) };
  const mFarge = merkeFarger[merke.merke] || navy;

  side.drawRectangle({ x: 40, y: height - 200, width: 120, height: 90, color: mFarge, borderRadius: 8 });
  side.drawText(merke.merke, { x: 75, y: height - 162, size: 48, font: fontBold, color: rgb(1,1,1) });

  side.drawText("Estimert energimerke", { x: 175, y: height - 120, size: 10, font: fontBold, color: grå });
  side.drawText(`Merke ${merke.merke} – ${merke.epbd}`, { x: 175, y: height - 140, size: 16, font: fontBold, color: navy });
  side.drawText(bygData.label, { x: 175, y: height - 160, size: 10, font: fontNormal, color: grå });
  side.drawText(`Klimasone: ${klima.label.split("(")[0].trim()}`, { x: 175, y: height - 178, size: 10, font: fontNormal, color: grå });

  // Nøkkeltall
  let y = height - 240;
  side.drawRectangle({ x: 40, y: y - 50, width: (width - 80) / 3 - 8, height: 60, color: lys, borderRadius: 6 });
  side.drawRectangle({ x: 40 + (width-80)/3, y: y - 50, width: (width-80)/3 - 8, height: 60, color: lys, borderRadius: 6 });
  side.drawRectangle({ x: 40 + (width-80)/3*2, y: y - 50, width: (width-80)/3, height: 60, color: lys, borderRadius: 6 });

  const cols = [
    { lbl: "Levert energi", val: `${kwhPerM2} kWh/m²/år`, x: 50 },
    { lbl: "Totalt forbruk", val: `${totalKwh.toLocaleString("no")} kWh/år`, x: 50 + (width-80)/3 },
    { lbl: "Est. strømkostnad", val: `${strømkostnad.toLocaleString("no")} kr/år`, x: 50 + (width-80)/3*2 },
  ];
  cols.forEach(c => {
    side.drawText(c.lbl, { x: c.x, y: y - 18, size: 8, font: fontBold, color: grå });
    side.drawText(c.val, { x: c.x, y: y - 38, size: 11, font: fontBold, color: navy });
  });

  // Tiltaksliste
  y = height - 340;
  side.drawText("Anbefalte tiltak", { x: 40, y, size: 14, font: fontBold, color: navy });
  side.drawText("Sortert etter tilbakebetalingstid", { x: 40, y: y - 18, size: 9, font: fontNormal, color: grå });

  y -= 40;
  const høyPrioritet = tiltak.filter(t => t.prioritet === "høy").slice(0, 6);
  høyPrioritet.forEach((t, i) => {
    if (y < 80) return;
    const erMørk = i % 2 === 0;
    side.drawRectangle({ x: 40, y: y - 44, width: width - 80, height: 50, color: erMørk ? lys : rgb(1,1,1), borderRadius: 4 });

    // Grønn prioritets-indikator
    side.drawRectangle({ x: 40, y: y - 44, width: 4, height: 50, color: green });

    side.drawText(`${t.navn}`, { x: 52, y: y - 18, size: 10, font: fontBold, color: navy });
    side.drawText(t.beskrivelse.slice(0, 65), { x: 52, y: y - 32, size: 8, font: fontNormal, color: grå });

    // Tall
    side.drawText(`Enova: ${t.støtte_min/1000}–${t.støtte_max/1000}k kr`, { x: width - 250, y: y - 18, size: 8, font: fontBold, color: green });
    side.drawText(`Sparer: ~${t.besparelse_kr.toLocaleString("no")} kr/år`, { x: width - 250, y: y - 32, size: 8, font: fontNormal, color: grå });
    side.drawText(`${t.tilbakebetaling <= 30 ? t.tilbakebetaling + " år" : ">30 år"} tilbakebetaling`, { x: width - 130, y: y - 25, size: 8, font: fontBold, color: navy });

    y -= 58;
  });

  // EPBD-seksjon
  if (y > 160) {
    y -= 20;
    side.drawText("EPBD 2024-status", { x: 40, y, size: 12, font: fontBold, color: navy });
    y -= 20;
    const epbdPunkter = [
      { krav: "EU-krav 2030 (merke E)", ok: merke.merke <= "E" },
      { krav: "EU-krav 2033 (merke D)", ok: merke.merke <= "D" },
      { krav: "nZEB-standard (merke A/B)", ok: merke.merke <= "B" },
    ];
    epbdPunkter.forEach(p => {
      side.drawText(p.ok ? "✓" : "!", { x: 42, y, size: 10, font: fontBold, color: p.ok ? green : rgb(0.97,0.58,0.11) });
      side.drawText(p.krav, { x: 58, y, size: 9, font: fontNormal, color: navy });
      side.drawText(p.ok ? "Oppfylt" : "Tiltak anbefales", { x: 280, y, size: 9, font: fontBold, color: p.ok ? green : rgb(0.97,0.58,0.11) });
      y -= 18;
    });
  }

  // Footer
  side.drawRectangle({ x: 0, y: 0, width, height: 45, color: lys });
  side.drawText("BoligEffekt · Estimat basert på NS-EN ISO 52000 og TEK-historikk · Ikke offisielt energimerke", { x: 40, y: 16, size: 8, font: fontNormal, color: grå });
  side.drawText("boligeffekt.no", { x: width - 100, y: 16, size: 8, font: fontBold, color: navy });

  return await pdfDoc.save();
}

// ── Send e-post med PDF ───────────────────────────────────────
async function sendEpost(epost, pdfBytes, data) {
  const { merke, kwhPerM2 } = data.resultat;
  const totalStøtte = data.resultat.tiltak
    .filter(t => t.prioritet === "høy")
    .reduce((s, t) => s + t.støtte_snitt, 0);

  await mailer.sendMail({
    from: `"BoligEffekt" <${process.env.EMAIL_USER}>`,
    to: epost,
    subject: `Din energirapport – Merke ${merke.merke} (${kwhPerM2} kWh/m²/år)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f0ede8;padding:0 0 32px">
        <div style="background:#1b3a5c;padding:28px 32px">
          <h1 style="color:white;margin:0;font-size:22px">BoligEffekt</h1>
          <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:13px">Din energirapport er klar</p>
        </div>
        <div style="padding:32px">
          <p style="color:#0f2540;font-size:16px;margin-bottom:24px">Hei,<br><br>Takk for kjøpet! Her er din komplette energirapport.</p>

          <div style="background:white;border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid rgba(27,58,92,0.1)">
            <h2 style="color:#1b3a5c;margin:0 0 16px;font-size:18px">📊 Ditt resultat</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr>
                <td style="padding:8px 0;color:#6b7a8d;font-size:14px">Energimerke</td>
                <td style="padding:8px 0;font-weight:bold;color:#0f2540;text-align:right">Merke ${merke.merke} – ${merke.epbd}</td>
              </tr>
              <tr style="border-top:1px solid #f0ede8">
                <td style="padding:8px 0;color:#6b7a8d;font-size:14px">Energibruk</td>
                <td style="padding:8px 0;font-weight:bold;color:#0f2540;text-align:right">${kwhPerM2} kWh/m²/år</td>
              </tr>
              <tr style="border-top:1px solid #f0ede8">
                <td style="padding:8px 0;color:#6b7a8d;font-size:14px">Mulig Enova-støtte</td>
                <td style="padding:8px 0;font-weight:bold;color:#2ab55a;text-align:right">inntil ${totalStøtte.toLocaleString("no")} kr</td>
              </tr>
            </table>
          </div>

          <div style="background:#1b3a5c;border-radius:12px;padding:20px;margin-bottom:20px">
            <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:0 0 8px">Tips: Start med tiltakene markert "Anbefalt" i PDF-rapporten – de gir kortest tilbakebetalingstid.</p>
            <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:0">Søk Enova-støtte på <a href="https://www.enova.no" style="color:#3ecf6e">enova.no</a> før du bestiller håndverkere.</p>
          </div>

          <p style="color:#6b7a8d;font-size:13px;line-height:1.6">
            Full rapport er vedlagt som PDF.<br>
            Spørsmål? Svar på denne e-posten.
          </p>
        </div>
        <div style="padding:0 32px;border-top:1px solid rgba(27,58,92,0.1)">
          <p style="color:#bbb;font-size:11px;line-height:1.6;margin-top:20px">
            BoligEffekt · Estimat basert på NS-EN ISO 52000 og TEK-historikk.<br>
            For offisielt energimerke kreves godkjent energirådgiver.
          </p>
        </div>
      </div>
    `,
    attachments: [{
      filename: `BoligEffekt-rapport-merke-${merke.merke}.pdf`,
      content: Buffer.from(pdfBytes),
      contentType: "application/pdf",
    }],
  });
}

// ── API-endepunkter ───────────────────────────────────────────

// 1. Opprett Stripe betalingsøkt
app.post("/api/create-checkout", async (req, res) => {
  try {
    const { resultatId, email, resultatData } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "nok",
          product_data: {
            name: "BoligEffekt – Full energirapport",
            description: "Komplett tiltaksplan, Enova-støtteoversikt, EPBD-status og PDF-rapport",
          },
          unit_amount: 19900,
        },
        quantity: 1,
      }],
      mode: "payment",
      customer_email: email || undefined,
      success_url: `${process.env.FRONTEND_URL}?session_id={CHECKOUT_SESSION_ID}&resultat=${resultatId}`,
      cancel_url: `${process.env.FRONTEND_URL}?avbrutt=true`,
      metadata: {
        resultatId,
        // Lagrer data i metadata (maks 500 tegn per felt)
        resultat_json: JSON.stringify(resultatData).slice(0, 490),
      },
      locale: "nb",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe feil:", err.message);
    res.status(500).json({ feil: err.message });
  }
});

// 2. Verifiser betaling + send PDF
app.get("/api/verifiser-betaling", async (req, res) => {
  try {
    const { session_id } = req.query;
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res.json({ betalt: false });
    }

    res.json({ betalt: true, epost: session.customer_email });
  } catch (err) {
    res.status(400).json({ feil: err.message });
  }
});

// 3. Generer og send PDF (kalles fra frontend etter betaling bekreftet)
app.post("/api/send-rapport", async (req, res) => {
  try {
    const { session_id, resultatData, epost } = req.body;

    // Verifiser at betaling faktisk er gjort
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid") {
      return res.status(403).json({ feil: "Betaling ikke bekreftet" });
    }

    const kundeEpost = epost || session.customer_email;

    // Generer PDF
    const pdfBytes = await lagPDF(resultatData);

    // Send e-post
    await sendEpost(kundeEpost, pdfBytes, resultatData);

    res.json({ ok: true, epost: kundeEpost });
  } catch (err) {
    console.error("Rapport-feil:", err.message);
    res.status(500).json({ feil: err.message });
  }
});

// 4. Stripe webhook (valgfritt – for ekstra sikkerhet)
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
    console.log(`✅ Betaling mottatt: ${session.customer_email} – ${session.amount_total / 100} kr`);
  }

  res.json({ mottatt: true });
});

// 5. Helsesjekk
app.get("/", (req, res) => res.json({ status: "BoligEffekt backend kjører" }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ BoligEffekt backend kjører på port ${PORT}`);
  console.log(`   Frontend URL: ${process.env.FRONTEND_URL}`);
});
