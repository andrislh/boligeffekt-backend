// BoligEffekt – PDF-generator (Phase 4 overhaul)
// 10-siders rapport: forside, nåtilstand, tidslinje, Enova-tiltak,
// detaljert analyse, egenfinansierte tiltak, Enova-pakke, finansiering,
// forutsetninger.
//
// VIKTIG: pdf-lib krasjer på emoji. All tekst som tegnes til PDF
// må gå gjennom safePDF() for å fjerne tegn utenfor Latin-1.

const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

// ─────────────────────────────────────────────────────────────
// DESIGNSYSTEM (juster fritt — ikke låst inn)
// ─────────────────────────────────────────────────────────────
const COLORS = {
  primary:       rgb(0.067, 0.227, 0.361),  // navy (BoligEffekt brand)
  primaryDark:   rgb(0.039, 0.133, 0.220),
  enova:         rgb(0.165, 0.710, 0.353),  // grønn for Enova-kvalifiserte
  enovaLight:    rgb(0.882, 0.969, 0.914),
  egenfin:       rgb(0.40,  0.42,  0.46),   // nøytral grå for egenfinansiert
  egenfinLight:  rgb(0.93,  0.93,  0.94),
  accent:        rgb(0.95,  0.65,  0.15),   // amber for highlights
  accentLight:   rgb(0.99,  0.95,  0.85),
  textPrimary:   rgb(0.10,  0.12,  0.15),
  textSecondary: rgb(0.42,  0.48,  0.55),
  textMuted:     rgb(0.62,  0.67,  0.73),
  background:    rgb(0.965, 0.961, 0.953),  // cream / off-white
  card:          rgb(1, 1, 1),
  border:        rgb(0.94,  0.94,  0.94),
  // Energimerke-skala (offisielle Enova-farger)
  gradeA: rgb(0,    0.65, 0.32),
  gradeB: rgb(0.34, 0.73, 0.28),
  gradeC: rgb(0.71, 0.83, 0.20),
  gradeD: rgb(1,    0.82, 0),
  gradeE: rgb(0.97, 0.58, 0.11),
  gradeF: rgb(0.93, 0.11, 0.14),
  gradeG: rgb(0.62, 0.10, 0.13),
};

const TYPO = {
  h1: 24, h2: 14, h3: 11, body: 10, small: 8.5, caption: 7.5,
  lineHeight: 1.4,
};

const LAYOUT = {
  marginX: 40, marginY: 60,
  pageWidth: 595, pageHeight: 842,
  contentWidth: 595 - 80,
};

const GRADE_COLORS = {
  A: COLORS.gradeA, B: COLORS.gradeB, C: COLORS.gradeC,
  D: COLORS.gradeD, E: COLORS.gradeE, F: COLORS.gradeF, G: COLORS.gradeG,
};

// ─────────────────────────────────────────────────────────────
// TEKSTHJELPERE
// ─────────────────────────────────────────────────────────────

// Strip tegn utenfor WinAnsi (Latin-1). Helvetica støtter ikke emoji.
function safePDF(str) {
  return (str || "")
    .replace(/[\u2713\u2714\u2705]/g, "OK")
    .replace(/[\u2715-\u2718\u274C]/g, "Nei")
    .replace(/\u2192/g, "->")
    .replace(/\u2190/g, "<-")
    .replace(/\u2022/g, "-")
    .replace(/\u2264/g, "<=")
    .replace(/\u2265/g, ">=")
    .replace(/\u2013/g, "-")     // en-dash → hyphen (Helvetica StdEnc har ikke en-dash)
    .replace(/\u2014/g, "-")     // em-dash → hyphen
    // Alle emoji er > U+00FF, så Latin-1-filteret dekker dem:
    .replace(/[^\x00-\xFF]/g, "");
}

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
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fmtKr(n) { return Math.round(n).toLocaleString("no") + " kr"; }
function fmtKrÅr(n) { return Math.round(n).toLocaleString("no") + " kr/år"; }

// ─────────────────────────────────────────────────────────────
// VISUELLE ELEMENTER
// ─────────────────────────────────────────────────────────────

// Energimerke-skala A→G med markør for dagens og ev. fremtidig merke.
// Større segmenter (32px høy, ikke 22) — gir mer visuell vekt på forsiden,
// støtter pdf-skalaens rolle som hovud-visualisering (UI/UX visual hierarchy).
const ENERGIMERKE_SKALA_HØYDE = 32;

function drawEnergimerkeSkala(side, x, y, width, fraMerke, tilMerke, fontBold) {
  const segW = width / 7;
  const segH = ENERGIMERKE_SKALA_HØYDE;
  const merker = ["A","B","C","D","E","F","G"];

  merker.forEach((m, i) => {
    side.drawRectangle({
      x: x + i * segW, y, width: segW - 1.5, height: segH,
      color: GRADE_COLORS[m],
    });
    // Større, sentrert bokstav (15pt vs 11pt)
    const txtW = fontBold.widthOfTextAtSize(m, 15);
    side.drawText(m, {
      x: x + i * segW + (segW - txtW) / 2, y: y + segH / 2 - 5,
      size: 15, font: fontBold, color: COLORS.card,
    });
  });

  // Markører (trekant peker ned på "I dag", opp på "Etter tiltak")
  const fraIdx = merker.indexOf(fraMerke);
  const tilIdx = tilMerke ? merker.indexOf(tilMerke) : -1;

  if (fraIdx >= 0) {
    const cx = x + fraIdx * segW + segW / 2;
    drawTriangleDown(side, cx, y + segH + 10, 7, COLORS.primaryDark);
    const lbl = safePDF("I dag: " + fraMerke);
    const lblW = fontBold.widthOfTextAtSize(lbl, 9);
    side.drawText(lbl, {
      x: cx - lblW / 2, y: y + segH + 22,
      size: 9, font: fontBold, color: COLORS.primaryDark,
    });
  }
  if (tilIdx >= 0 && tilIdx !== fraIdx) {
    const cx = x + tilIdx * segW + segW / 2;
    drawTriangleUp(side, cx, y - 10, 7, COLORS.enova);
    const lbl = safePDF("Etter tiltak: " + tilMerke);
    const lblW = fontBold.widthOfTextAtSize(lbl, 9);
    side.drawText(lbl, {
      x: cx - lblW / 2, y: y - 24,
      size: 9, font: fontBold, color: COLORS.enova,
    });
  }
}

// Trekant-markører via SVG-path (presis, ikke pikselert som rektangel-stack)
function drawTriangleDown(side, cx, cy, size, color) {
  const path = `M ${cx - size} ${cy + size} L ${cx + size} ${cy + size} L ${cx} ${cy - size} Z`;
  side.drawSvgPath(path, { color, borderColor: color, borderWidth: 0 });
}

function drawTriangleUp(side, cx, cy, size, color) {
  const path = `M ${cx - size} ${cy - size} L ${cx + size} ${cy - size} L ${cx} ${cy + size} Z`;
  side.drawSvgPath(path, { color, borderColor: color, borderWidth: 0 });
}

// Stablet horisontal stolpe — varmetapsfordeling
function drawVarmetapsfordeling(side, x, y, width, segments, fontNormal, fontBold) {
  const total = segments.reduce((s, seg) => s + seg.pct, 0) || 1;
  const barH = 20;
  let cursorX = x;

  segments.forEach((seg, i) => {
    const w = (seg.pct / total) * width;
    side.drawRectangle({
      x: cursorX, y, width: w - 0.5, height: barH,
      color: seg.color || COLORS.primary,
    });
    if (w > 35) {
      side.drawText(safePDF(`${Math.round(seg.pct)}%`), {
        x: cursorX + w / 2 - 8, y: y + barH / 2 - 3,
        size: 8, font: fontBold, color: COLORS.card,
      });
    }
    cursorX += w;
  });

  // Legende under stolpen — wrap til ny linje hvis bredden overskrides
  // (skill §10: legend-visible — sørger for at alle labels vises uten avkutting)
  const legendItemGap = 18;   // ekstra gap mellom items
  const swatchW = 9;
  const legendY0 = y - 18;
  let legX = x;
  let legY = legendY0;
  segments.forEach((seg) => {
    const labelW = fontNormal.widthOfTextAtSize(safePDF(seg.label), 8);
    const itemW  = swatchW + 5 + labelW + legendItemGap;
    if (legX + itemW > x + width) {
      legX = x;
      legY -= 14;
    }
    side.drawRectangle({
      x: legX, y: legY, width: swatchW, height: 9,
      color: seg.color || COLORS.primary,
    });
    side.drawText(safePDF(seg.label), {
      x: legX + swatchW + 5, y: legY + 1,
      size: 8, font: fontNormal, color: COLORS.textSecondary,
    });
    legX += itemW;
  });
}

// Tidslinje — år 0-10 med tiltak markert
// Tidslinje-arealets dimensjoner
const TIDSLINJE_RADER = 4;
const TIDSLINJE_RAD_H = 16;
const TIDSLINJE_HØYDE = TIDSLINJE_RADER * TIDSLINJE_RAD_H + 30;  // ~94px (tiltak + akse + labels)

// Tegner tidslinje. yTopp = ØVERSTE punkt for arealet — funksjonen tegner 100px nedover.
// Tiltak plasseres i 4 rader OVER aksen, aksen + årmerker nederst.
function drawTidslinje(side, x, yTopp, width, tiltakMedTidspunkt, fontNormal, fontBold) {
  const blokkH = 12;
  const akseY  = yTopp - TIDSLINJE_RADER * TIDSLINJE_RAD_H - 6;

  // Tiltak-blokker (rad 0 øverst, rad 3 rett over aksen)
  tiltakMedTidspunkt.forEach((t, i) => {
    const px = x + (t.startÅr / 10) * width;
    const w  = Math.max(((t.varighet || 0.3) / 10) * width, 4);
    const rad = i % TIDSLINJE_RADER;
    const blockY = yTopp - rad * TIDSLINJE_RAD_H - blokkH - 2;
    const c = t.kategori === "egenfinansiert" ? COLORS.egenfin : COLORS.enova;
    side.drawRectangle({
      x: px, y: blockY, width: w, height: blokkH,
      color: c, borderRadius: 2,
    });
    side.drawText(safePDF(t.navn.slice(0, 26)), {
      x: px + w + 4, y: blockY + 3,
      size: 7, font: fontBold, color: COLORS.textPrimary,
    });
  });

  // Akse nederst
  side.drawRectangle({ x, y: akseY, width, height: 1.5, color: COLORS.textSecondary });

  // Årmerker (tick + label under aksen)
  for (let år = 0; år <= 10; år++) {
    const px = x + (år / 10) * width;
    side.drawRectangle({ x: px - 0.5, y: akseY - 4, width: 1, height: 8, color: COLORS.textSecondary });
    if (år % 2 === 0) {
      side.drawText(`År ${år}`, {
        x: px - 10, y: akseY - 16,
        size: 7, font: fontNormal, color: COLORS.textSecondary,
      });
    }
  }
}

// Liten payback-graf — kumulativ besparelse vs investering.
// (skill §10: chart axis-labels + direct-labeling — krysspunktet markeres
// tydelig og hovedlinjene har tekstetiketter direkte ved linjen)
function drawPaybackGraf(side, x, y, w, h, kostnad, besparelseÅrlig, fontNormal, fontBold) {
  if (besparelseÅrlig <= 0) return;
  const år = 10;
  const maxVerdi = Math.max(kostnad, besparelseÅrlig * år) * 1.05;  // headroom over linjen
  const yScale = h / maxVerdi;
  const xScale = w / år;

  // Bakgrunn med subtil bunnramme (rolig "card"-følelse for grafen)
  side.drawRectangle({ x: x - 2, y: y - 2, width: w + 4, height: h + 4, color: COLORS.background, borderRadius: 2 });

  // Akser
  side.drawRectangle({ x, y, width: 0.8, height: h, color: COLORS.textMuted });
  side.drawRectangle({ x, y, width: w, height: 0.8, color: COLORS.textMuted });

  // Investeringslinje (stiplet horisontal)
  const invY = y + kostnad * yScale;
  for (let i = 0; i < w; i += 4) {
    side.drawRectangle({ x: x + i, y: invY, width: 2, height: 0.8, color: COLORS.egenfin });
  }
  side.drawText(`Investering ${fmtKr(kostnad)}`, {
    x: x + 4, y: invY + 3, size: 6.5, font: fontBold, color: COLORS.egenfin,
  });

  // Besparelseskurve (kumulativ, lineær)
  for (let år1 = 1; år1 <= år; år1++) {
    const px1 = x + (år1 - 1) * xScale;
    const py1 = y + (besparelseÅrlig * (år1 - 1)) * yScale;
    const px2 = x + år1 * xScale;
    const py2 = y + (besparelseÅrlig * år1) * yScale;
    const dx = px2 - px1, dy = py2 - py1;
    const steg = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    for (let s = 0; s < steg; s++) {
      side.drawRectangle({
        x: px1 + (dx * s / steg), y: py1 + (dy * s / steg),
        width: 1.4, height: 1.4, color: COLORS.enova,
      });
    }
  }

  // Krysspunkt-marker (payback-tidspunkt)
  const paybackÅr = kostnad / besparelseÅrlig;
  if (paybackÅr <= år) {
    const cx = x + paybackÅr * xScale;
    const cy = y + kostnad * yScale;
    // Outer ring + inner dot for tydelighet
    side.drawRectangle({ x: cx - 4, y: cy - 4, width: 8, height: 8, color: COLORS.accent, borderRadius: 4 });
    side.drawRectangle({ x: cx - 1.5, y: cy - 1.5, width: 3, height: 3, color: COLORS.card, borderRadius: 1.5 });
    // Etikett under krysspunktet
    const lbl = `Payback: ${paybackÅr.toFixed(1)} år`;
    side.drawText(lbl, {
      x: cx - fontBold.widthOfTextAtSize(lbl, 7) / 2,
      y: y - 10,
      size: 7, font: fontBold, color: COLORS.accent,
    });
  }

  // Akse-endepunkts-etikett (10 år)
  side.drawText(`${år} år`, {
    x: x + w - 12, y: y - 10, size: 6.5, font: fontNormal, color: COLORS.textMuted,
  });
}

// ─────────────────────────────────────────────────────────────
// SIDE-LAYOUT-HJELPERE
// ─────────────────────────────────────────────────────────────

function sideHeader(side, undertittel, sidenr, totalt, fontNormal, fontBold) {
  side.drawRectangle({ x: 0, y: LAYOUT.pageHeight - 72, width: LAYOUT.pageWidth, height: 72, color: COLORS.primary });
  side.drawRectangle({ x: 0, y: LAYOUT.pageHeight - 74, width: LAYOUT.pageWidth, height: 2, color: COLORS.enova });
  side.drawText("BoligEffekt", { x: 40, y: LAYOUT.pageHeight - 44, size: 20, font: fontBold, color: COLORS.card });
  side.drawText(safePDF(undertittel), {
    x: 40, y: LAYOUT.pageHeight - 62,
    size: 9.5, font: fontNormal, color: rgb(0.65, 0.85, 0.65),
  });
  side.drawText(`Side ${sidenr} av ${totalt}`, {
    x: LAYOUT.pageWidth - 80, y: LAYOUT.pageHeight - 52,
    size: 8, font: fontNormal, color: rgb(0.55, 0.65, 0.75),
  });
}

function footer(side, fontNormal, fontBold) {
  side.drawRectangle({ x: 0, y: 0, width: LAYOUT.pageWidth, height: 40, color: COLORS.background });
  side.drawRectangle({ x: 0, y: 40, width: LAYOUT.pageWidth, height: 1, color: COLORS.border });
  side.drawText(safePDF("BoligEffekt - Estimat basert på NS-EN ISO 52000 og TEK-historikk - Ikke offisielt energimerke"), {
    x: 40, y: 14, size: 7, font: fontNormal, color: COLORS.textSecondary,
  });
  side.drawText("boligeffekt.no", {
    x: LAYOUT.pageWidth - 100, y: 14,
    size: 7, font: fontBold, color: COLORS.primary,
  });
}

function seksjonHeader(side, tekst, x, y, fontBold) {
  side.drawRectangle({ x, y: y - 2, width: 3, height: 16, color: COLORS.enova });
  side.drawText(safePDF(tekst), { x: x + 10, y, size: 11, font: fontBold, color: COLORS.primary });
}

// ─────────────────────────────────────────────────────────────
// FORSIDE (cover page)
// ─────────────────────────────────────────────────────────────
// Ren, profesjonell forside. Logo som tekst-wordmark (pdf-lib krasjer
// på emoji, og vi vil ikke embedde PNG fra disk for å holde det lett).
function tegnForside(pdfDoc, data, fontNormal, fontBold) {
  const side = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  const adresse = (data && data.input && typeof data.input.adresse === "string")
    ? data.input.adresse.trim()
    : "";
  const dato = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "long", year: "numeric" });

  // Navy hero-bånd øverst (samme palette som rapportsidene)
  side.drawRectangle({
    x: 0, y: LAYOUT.pageHeight - 180,
    width: LAYOUT.pageWidth, height: 180,
    color: COLORS.primary,
  });
  // Tynn grønn aksent-strek under båndet
  side.drawRectangle({
    x: 0, y: LAYOUT.pageHeight - 184,
    width: LAYOUT.pageWidth, height: 4,
    color: COLORS.enova,
  });

  // Logo som wordmark
  side.drawText("BoligEffekt", {
    x: LAYOUT.marginX, y: LAYOUT.pageHeight - 110,
    size: 36, font: fontBold, color: COLORS.card,
  });
  side.drawText(safePDF("Estimat basert pa NS-EN ISO 52000 og TEK-historikk"), {
    x: LAYOUT.marginX, y: LAYOUT.pageHeight - 135,
    size: 10, font: fontNormal, color: rgb(0.78, 0.88, 0.78),
  });

  // Tittel
  const titteY = LAYOUT.pageHeight - 280;
  side.drawText(safePDF("Energivurdering"), {
    x: LAYOUT.marginX, y: titteY,
    size: 40, font: fontBold, color: COLORS.primaryDark,
  });
  // Aksent-linje under tittel
  side.drawRectangle({
    x: LAYOUT.marginX, y: titteY - 14,
    width: 80, height: 3, color: COLORS.enova,
  });

  // Adresse (utelat hvis tom)
  let metaY = titteY - 70;
  if (adresse) {
    const adresseLinjer = wrapText(adresse, fontBold, 16, LAYOUT.contentWidth);
    side.drawText(safePDF("Bolig"), {
      x: LAYOUT.marginX, y: metaY,
      size: 8.5, font: fontBold, color: COLORS.textMuted,
    });
    metaY -= 18;
    adresseLinjer.slice(0, 2).forEach(linje => {
      side.drawText(safePDF(linje), {
        x: LAYOUT.marginX, y: metaY,
        size: 16, font: fontBold, color: COLORS.textPrimary,
      });
      metaY -= 22;
    });
    metaY -= 12;
  }

  // Dato
  side.drawText(safePDF("Rapportdato"), {
    x: LAYOUT.marginX, y: metaY,
    size: 8.5, font: fontBold, color: COLORS.textMuted,
  });
  metaY -= 18;
  side.drawText(safePDF(dato), {
    x: LAYOUT.marginX, y: metaY,
    size: 14, font: fontNormal, color: COLORS.textPrimary,
  });

  // Bunntekst
  side.drawRectangle({
    x: 0, y: 0, width: LAYOUT.pageWidth, height: 1,
    color: COLORS.border,
  });
  side.drawText(safePDF("Utarbeidet av BoligEffekt"), {
    x: LAYOUT.marginX, y: 50,
    size: 11, font: fontBold, color: COLORS.primary,
  });
  side.drawText(safePDF("boligeffekt.no"), {
    x: LAYOUT.pageWidth - LAYOUT.marginX - fontNormal.widthOfTextAtSize("boligeffekt.no", 10), y: 50,
    size: 10, font: fontNormal, color: COLORS.textSecondary,
  });
}

// ─────────────────────────────────────────────────────────────
// HOVED-FUNKSJON
// ─────────────────────────────────────────────────────────────

async function lagPDF(data, pakke) {
  console.log("[PDF] Starter generering, pakke:", pakke);

  const { merke, kwhPerM2, totalKwh, strømkostnad, bygData, klima, bolig,
          oppvData, primærPerM2, tiltak, merkePotensial, areal } = data.resultat;

  // Splitt tiltak på kategori
  const enovaTiltak     = (tiltak || []).filter(t => t.kategori === "enova_kvalifisert");
  const egenfinTiltak   = (tiltak || []).filter(t => t.kategori === "egenfinansiert");

  // Totaler — bruker støtte_max for konsistens med "inntil X"-visning per tiltak
  const totInv          = (tiltak || []).reduce((s, t) => s + (t.kostnad_snitt || 0), 0);
  const totEnovaStøtte  = enovaTiltak.reduce((s, t) => s + (t.støtte_max || 0), 0);
  const totBes          = (tiltak || []).reduce((s, t) => s + (t.besparelse_kr || 0), 0);
  const totBes20        = totBes * 20;
  // CO2: estimert basert på nordisk strømmiks 17 g CO2/kWh + fossil andel
  const kwhSpart        = (tiltak || []).reduce((s, t) => s + Math.round(totalKwh * (t.kWh_pct || 0)), 0);
  const totCO2KgÅr      = Math.round(kwhSpart * 0.017);

  const pdfDoc     = await PDFDocument.create();
  const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const totSider = pakke === "oppgraderingsplan" ? 10 : 1;

  // ═══════════════════════════════════════════════════════════
  // FORSIDE (cover) — ren, ingen tunge elementer, ingen emoji
  // ═══════════════════════════════════════════════════════════
  tegnForside(pdfDoc, data, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 1 — SAMMENDRAG
  // ═══════════════════════════════════════════════════════════
  const side1 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side1, pakke === "oppgraderingsplan" ? "Oppgraderingsplan" : "Energirapport", 1, totSider, fontNormal, fontBold);

  const dato = new Date().toLocaleDateString("nb-NO", { day: "2-digit", month: "long", year: "numeric" });
  side1.drawText(safePDF(dato), {
    x: LAYOUT.pageWidth - 140, y: LAYOUT.pageHeight - 44,
    size: 9, font: fontNormal, color: rgb(0.6, 0.72, 0.85),
  });

  let y = LAYOUT.pageHeight - 100;

  // Bolig-info
  side1.drawText(safePDF("Boligdata"), { x: 40, y, size: 8, font: fontBold, color: COLORS.textMuted });
  y -= 14;
  const boligInfo = [
    ["Byggeår:",        bygData?.label || "-"],
    ["Klimasone:",      klima?.label?.split("(")[0]?.trim() || "-"],
    ["Boligtype:",      bolig?.label || "-"],
    ["Oppvarmet areal:", areal ? `${areal} m²` : "-"],
  ];
  boligInfo.forEach(([k, v]) => {
    side1.drawText(safePDF(k), { x: 40, y, size: 9, font: fontNormal, color: COLORS.textSecondary });
    side1.drawText(safePDF(v), { x: 130, y, size: 9, font: fontBold, color: COLORS.textPrimary });
    y -= 14;
  });
  y -= 16;

  // Energimerke-skala (dagens → fremtidig)
  seksjonHeader(side1, "Estimert energimerke", 40, y, fontBold);
  y -= 44;  // ekstra rom for "Etter tiltak"-label over skalaen
  drawEnergimerkeSkala(
    side1, 40, y, LAYOUT.contentWidth,
    merke?.merke, merkePotensial?.merke,
    fontBold,
  );
  y -= ENERGIMERKE_SKALA_HØYDE + 38;  // skala + plass til "I dag"-label under

  // Tre nøkkeltall
  seksjonHeader(side1, "Potensial", 40, y, fontBold);
  y -= 18;
  const kpiW = LAYOUT.contentWidth / 3 - 8;
  const kpis = [
    { lbl: "Mulig årlig besparelse",  val: fmtKrÅr(totBes),                farge: COLORS.enova },
    { lbl: "CO2-reduksjon (estimert)", val: `${totCO2KgÅr.toLocaleString("no")} kg/år`, farge: COLORS.primary },
    { lbl: "Potensial over 20 år",     val: fmtKr(totBes20),                farge: COLORS.accent },
  ];
  kpis.forEach((k, i) => {
    const bx = 40 + (kpiW + 12) * i;
    side1.drawRectangle({ x: bx, y: y - 60, width: kpiW, height: 64, color: COLORS.card, borderRadius: 6 });
    side1.drawRectangle({ x: bx, y: y - 60, width: kpiW, height: 3, color: k.farge, borderRadius: 2 });
    side1.drawText(safePDF(k.lbl), { x: bx + 8, y: y - 18, size: 7.5, font: fontNormal, color: COLORS.textMuted });
    side1.drawText(safePDF(k.val), { x: bx + 8, y: y - 40, size: 13, font: fontBold, color: k.farge });
  });
  y -= 80;

  // Sammendragslinje
  side1.drawRectangle({ x: 40, y: y - 36, width: LAYOUT.contentWidth, height: 40, color: COLORS.enovaLight, borderRadius: 4 });
  side1.drawRectangle({ x: 40, y: y - 36, width: 3, height: 40, color: COLORS.enova });
  side1.drawText(safePDF(
    `Du har ${enovaTiltak.length} tiltak som kvalifiserer for Enova-støtte og ${egenfinTiltak.length} lønnsomme egenfinansierte tiltak.`
  ), { x: 52, y: y - 16, size: 9.5, font: fontBold, color: COLORS.primary });
  side1.drawText(safePDF(
    `Estimert Enova-støtte: inntil ${fmtKr(totEnovaStøtte)}.`
  ), { x: 52, y: y - 28, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
  y -= 56;

  // Disclaimer på forsiden
  side1.drawText(safePDF("Dette er et estimat basert på byggeår, areal og oppvarmingstype - ikke et offisielt energimerke."), {
    x: 40, y: 60, size: 7, font: fontNormal, color: COLORS.textMuted,
  });

  footer(side1, fontNormal, fontBold);

  // Tidlig retur for små pakker
  if (pakke !== "oppgraderingsplan") {
    const bytes = await pdfDoc.save();
    console.log(`[PDF] Ferdig - ${pdfDoc.getPageCount()} side(r), ${bytes.length} bytes`);
    return bytes;
  }

  // ═══════════════════════════════════════════════════════════
  // SIDE 2 — BOLIGENS NÅTILSTAND
  // ═══════════════════════════════════════════════════════════
  const side2 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side2, "Boligens nåtilstand", 2, totSider, fontNormal, fontBold);

  let y2 = LAYOUT.pageHeight - 100;

  seksjonHeader(side2, "Estimerte U-verdier (basert på byggeår)", 40, y2, fontBold);
  y2 -= 18;
  side2.drawText(safePDF(
    "U-verdiene er typiske for boliger fra perioden " + (bygData?.label || "") + ". Lav U-verdi = bedre isolasjon."
  ), { x: 40, y: y2, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
  y2 -= 22;

  const uVerdier = [
    ["Yttervegger",   bygData?.u_vegg],
    ["Tak / loft",    bygData?.u_tak],
    ["Gulv mot grunn", bygData?.u_gulv],
    ["Vinduer",       bygData?.u_vindu],
    ["Lufttetthet (n50)", bygData?.lufttetthet],
  ];
  uVerdier.forEach(([k, v], i) => {
    const rowY = y2 - i * 18;
    side2.drawRectangle({ x: 40, y: rowY - 4, width: LAYOUT.contentWidth, height: 16, color: i % 2 === 0 ? COLORS.background : COLORS.card });
    side2.drawText(safePDF(k), { x: 50, y: rowY, size: 9, font: fontNormal, color: COLORS.textSecondary });
    side2.drawText(safePDF(v != null ? `${v} W/m²K` : "-"), {
      x: 360, y: rowY, size: 9, font: fontBold, color: COLORS.textPrimary,
    });
  });
  y2 -= uVerdier.length * 18 + 10;

  // Varmetapsfordeling
  seksjonHeader(side2, "Hvor varmen forsvinner", 40, y2, fontBold);
  y2 -= 24;
  // Estimert fordeling basert på typiske U-verdi-vekter
  const segments = [
    { label: "Yttervegger",  pct: 28, color: COLORS.primary },
    { label: "Tak/loft",     pct: 20, color: COLORS.accent },
    { label: "Vinduer/dører",pct: 22, color: COLORS.gradeF },
    { label: "Gulv",         pct: 12, color: COLORS.egenfin },
    { label: "Luftlekkasje", pct: 18, color: COLORS.gradeE },
  ];
  drawVarmetapsfordeling(side2, 40, y2, LAYOUT.contentWidth, segments, fontNormal, fontBold);
  y2 -= 58;

  // Sammenligning
  seksjonHeader(side2, "Hva betyr karakteren din?", 40, y2, fontBold);
  y2 -= 18;
  const sammenlignTekst = `Tilsvarende boliger fra ${bygData?.label || "denne perioden"} ligger typisk på merke F-G uten oppgraderinger. Med tiltakene i denne rapporten kan din nå merke ${merkePotensial?.merke || "C"}.`;
  wrapText(sammenlignTekst, fontNormal, 9, LAYOUT.contentWidth - 20).slice(0, 4).forEach((l, i) => {
    side2.drawText(safePDF(l), { x: 40, y: y2 - i * 14, size: 9, font: fontNormal, color: COLORS.textPrimary });
  });
  y2 -= 60;

  // EPBD-kobling - forventede EU-krav (ikke vedtatt)
  seksjonHeader(side2, "EU-direktivet (EPBD 2024) - forventede krav", 40, y2, fontBold);
  y2 -= 18;
  side2.drawText(safePDF("Norsk implementering er ikke endelig vedtatt. Tallene under er forventet retning."), {
    x: 40, y: y2, size: 8, font: fontNormal, color: COLORS.textMuted,
  });
  y2 -= 18;

  const epbdMerker = ["A","B","C","D","E","F","G"];
  const idxDagens  = epbdMerker.indexOf(merke?.merke || "G");
  const idxNytt    = epbdMerker.indexOf(merkePotensial?.merke || "C");
  const grense2030 = epbdMerker.indexOf("E");
  const grense2033 = epbdMerker.indexOf("D");

  const epbdRader = [
    { år: "2025", lbl: "I dag",                kravMerke: merke?.merke || "-", status: "Naverende",
      farge: COLORS.textSecondary },
    { år: "2030", lbl: "Forventet EU-krav",    kravMerke: "E",
      status: idxDagens <= grense2030 ? "Oppfyller" : "Ma oppgraderes",
      farge:  idxDagens <= grense2030 ? COLORS.enova : COLORS.accent },
    { år: "2033", lbl: "Forventet skjerping",  kravMerke: "D",
      status: idxDagens <= grense2033 ? "Oppfyller" : "Ma oppgraderes",
      farge:  idxDagens <= grense2033 ? COLORS.enova : COLORS.accent },
  ];

  epbdRader.forEach((r, i) => {
    const rowY = y2 - i * 22;
    side2.drawRectangle({
      x: 40, y: rowY - 6, width: LAYOUT.contentWidth, height: 20,
      color: i % 2 === 0 ? COLORS.background : COLORS.card,
    });
    side2.drawText(safePDF(r.år), { x: 50, y: rowY, size: 9, font: fontBold, color: COLORS.primary });
    side2.drawText(safePDF(r.lbl), { x: 100, y: rowY, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
    side2.drawText(safePDF(`Merke ${r.kravMerke}`), { x: 270, y: rowY, size: 9, font: fontBold, color: COLORS.textPrimary });
    side2.drawText(safePDF(r.status), { x: 420, y: rowY, size: 9, font: fontBold, color: r.farge });
  });
  y2 -= epbdRader.length * 22 + 6;

  // Etter-tiltak-konklusjon
  if (idxNytt < idxDagens) {
    const oppfyller2030 = idxNytt <= grense2030;
    const oppfyller2033 = idxNytt <= grense2033;
    const konklusjon = oppfyller2030 && oppfyller2033
      ? `Med anbefalte tiltak (nytt merke ${merkePotensial?.merke}): oppfyller bade 2030- og 2033-kravene.`
      : oppfyller2030
        ? `Med anbefalte tiltak (nytt merke ${merkePotensial?.merke}): oppfyller 2030-kravet, ligger naer 2033-grensen.`
        : `Med anbefalte tiltak (nytt merke ${merkePotensial?.merke}): oppfyller ikke fullt ut 2030-kravet - vurder flere tiltak.`;
    side2.drawRectangle({
      x: 40, y: y2 - 22, width: LAYOUT.contentWidth, height: 22,
      color: COLORS.enovaLight,
    });
    side2.drawRectangle({ x: 40, y: y2 - 22, width: 3, height: 22, color: COLORS.enova });
    wrapText(konklusjon, fontNormal, 8.5, LAYOUT.contentWidth - 20).slice(0, 2).forEach((l, li) => {
      side2.drawText(safePDF(l), { x: 50, y: y2 - 8 - li * 11, size: 8.5, font: fontBold, color: COLORS.primary });
    });
  }

  footer(side2, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 3 — ANBEFALT REKKEFØLGE / TIDSLINJE
  // ═══════════════════════════════════════════════════════════
  const side3 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side3, "Anbefalt rekkefølge - 10-årsplan", 3, totSider, fontNormal, fontBold);

  let y3 = LAYOUT.pageHeight - 100;

  seksjonHeader(side3, "Riktig sekvens for tiltakene", 40, y3, fontBold);
  y3 -= 18;
  side3.drawText(safePDF("Klimaskjerm før varmesystem. Tett bygningskroppen, så dimensjoner varmen riktig."), {
    x: 40, y: y3, size: 9, font: fontNormal, color: COLORS.textSecondary,
  });
  y3 -= 22;

  // Sorter tiltak i logiske faser (klimaskjerm → varme → komfort/produksjon)
  const klimaskjerm = ["tetting","isolering_loft","isolering_vegger","vinduer","ytterdører"];
  const varme       = ["varmepumpe_lv","bergvarme","varmepumpe_ll","ventilasjon"];
  const annet       = ["solceller","smart_styring"];

  function fase(tIds) {
    return (tiltak || []).filter(t => tIds.includes(t.id));
  }
  const fase1 = fase(klimaskjerm);
  const fase2 = fase(varme);
  const fase3 = fase(annet);

  const tidslinjeTiltak = [
    ...fase1.map((t, i) => ({ navn: t.navn, startÅr: 0 + i * 0.6, varighet: 0.5, kategori: t.kategori })),
    ...fase2.map((t, i) => ({ navn: t.navn, startÅr: 3 + i * 0.7, varighet: 0.6, kategori: t.kategori })),
    ...fase3.map((t, i) => ({ navn: t.navn, startÅr: 5 + i * 0.7, varighet: 0.6, kategori: t.kategori })),
  ];
  drawTidslinje(side3, 40, y3, LAYOUT.contentWidth, tidslinjeTiltak, fontNormal, fontBold);
  y3 -= TIDSLINJE_HØYDE + 16;

  // Forklaring per fase
  const fasebeskrivelser = [
    { tittel: "Fase 1 - År 0-3: Klimaskjerm",  tekst: "Reduser varmetap først. Tetting, isolering og vinduer. Slik unngår du å overdimensjonere varmesystemet.", farge: COLORS.enova },
    { tittel: "Fase 2 - År 3-5: Varmesystem",  tekst: "Med tett klimaskjerm kan du dimensjonere varmepumpe eller andre varmekilder riktig.", farge: COLORS.primary },
    { tittel: "Fase 3 - År 5-10: Komfort/produksjon", tekst: "Solceller, smart styring og finjustering. Bygger på den oppgraderte klimaskjermen.", farge: COLORS.accent },
  ];
  fasebeskrivelser.forEach((f, i) => {
    const bxY = y3 - i * 50;
    side3.drawRectangle({ x: 40, y: bxY - 38, width: LAYOUT.contentWidth, height: 42, color: COLORS.background, borderRadius: 4 });
    side3.drawRectangle({ x: 40, y: bxY - 38, width: 3, height: 42, color: f.farge });
    side3.drawText(safePDF(f.tittel), { x: 52, y: bxY - 12, size: 9.5, font: fontBold, color: COLORS.primary });
    wrapText(f.tekst, fontNormal, 8.5, LAYOUT.contentWidth - 30).slice(0, 2).forEach((l, li) => {
      side3.drawText(safePDF(l), { x: 52, y: bxY - 26 - li * 11, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
    });
  });

  footer(side3, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 4 — ENOVA-KVALIFISERTE TILTAK (OVERSIKT)
  // ═══════════════════════════════════════════════════════════
  const side4 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side4, "Enova-kvalifiserte tiltak", 4, totSider, fontNormal, fontBold);

  let y4 = LAYOUT.pageHeight - 100;
  seksjonHeader(side4, `${enovaTiltak.length} tiltak gir Enova-støtte`, 40, y4, fontBold);
  y4 -= 18;
  side4.drawText(safePDF("Tabellen viser estimerte tall. Søk Enova-støtte FØR du bestiller installatør."), {
    x: 40, y: y4, size: 8.5, font: fontNormal, color: COLORS.textSecondary,
  });
  y4 -= 22;

  // Tabellheader
  const colsX = [50, 220, 290, 360, 425, 500];
  const colsHeader = ["Tiltak", "Kostnad", "Enova", "Netto", "Spar/år", "Payback"];
  side4.drawRectangle({ x: 40, y: y4 - 4, width: LAYOUT.contentWidth, height: 18, color: COLORS.primary });
  colsHeader.forEach((h, i) => {
    side4.drawText(safePDF(h), { x: colsX[i], y: y4 + 1, size: 8, font: fontBold, color: COLORS.card });
  });
  y4 -= 22;

  enovaTiltak.forEach((t, i) => {
    const rowY = y4 - i * 22;
    if (rowY < 80) return;
    side4.drawRectangle({ x: 40, y: rowY - 4, width: LAYOUT.contentWidth, height: 20, color: i % 2 === 0 ? COLORS.background : COLORS.card });
    const netto = (t.kostnad_snitt || 0) - (t.støtte_max || 0);
    const tb    = t.tilbakebetaling <= 30 ? `${t.tilbakebetaling} år` : ">30 år";
    const cells = [
      t.navn?.slice(0, 28) || "-",
      `${Math.round((t.kostnad_snitt||0)/1000)}k kr`,
      `inntil ${Math.round((t.støtte_max||0)/1000)}k kr`,
      `${Math.round(netto/1000)}k kr`,
      `${(t.besparelse_kr||0).toLocaleString("no")} kr`,
      tb,
    ];
    cells.forEach((c, ci) => {
      side4.drawText(safePDF(c), {
        x: colsX[ci], y: rowY,
        size: 8, font: ci === 0 ? fontBold : fontNormal,
        color: ci === 2 ? COLORS.enova : COLORS.textPrimary,
      });
    });
  });
  y4 -= enovaTiltak.length * 22 + 14;

  // Total
  if (y4 > 80) {
    side4.drawRectangle({ x: 40, y: y4 - 18, width: LAYOUT.contentWidth, height: 22, color: COLORS.enovaLight, borderRadius: 3 });
    side4.drawText(safePDF("Total Enova-støtte (inntil):"), {
      x: 50, y: y4 - 12, size: 10, font: fontBold, color: COLORS.primary,
    });
    side4.drawText(safePDF(fmtKr(totEnovaStøtte)), {
      x: 425, y: y4 - 12, size: 11, font: fontBold, color: COLORS.enova,
    });
  }

  footer(side4, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 5-6 — DETALJERT TILTAKSANALYSE (TOPP 4 ENOVA-TILTAK)
  // ═══════════════════════════════════════════════════════════
  const detaljerteTiltak = enovaTiltak.slice(0, 4);
  const tiltakPerSide = 2;
  const detaljSider = Math.ceil(detaljerteTiltak.length / tiltakPerSide);

  for (let pIdx = 0; pIdx < detaljSider; pIdx++) {
    const sd = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
    sideHeader(sd, "Detaljert tiltaksanalyse", 5 + pIdx, totSider, fontNormal, fontBold);

    let yd = LAYOUT.pageHeight - 100;
    const tiltakHere = detaljerteTiltak.slice(pIdx * tiltakPerSide, (pIdx + 1) * tiltakPerSide);

    tiltakHere.forEach((t) => {
      // Tittel-blokk
      seksjonHeader(sd, t.navn || "-", 40, yd, fontBold);
      yd -= 22;

      // Beskrivelse
      wrapText(t.beskrivelse || "", fontNormal, 9, LAYOUT.contentWidth - 20).slice(0, 4).forEach((l, li) => {
        sd.drawText(safePDF(l), { x: 40, y: yd - li * 12, size: 9, font: fontNormal, color: COLORS.textPrimary });
      });
      yd -= 56;

      // Tall-rad
      const netto = (t.kostnad_snitt || 0) - (t.støtte_max || 0);
      const fakta = [
        ["Kostnad",     `${fmtKr(t.kostnad_min || 0)} - ${fmtKr(t.kostnad_max || 0)}`],
        ["Enova-støtte (inntil)", fmtKr(t.støtte_max || 0)],
        ["Netto kostnad", fmtKr(netto)],
        ["Årlig besparelse", fmtKrÅr(t.besparelse_kr || 0)],
        ["Tilbakebetaling", t.tilbakebetaling <= 30 ? `${t.tilbakebetaling} år` : "Lang sikt"],
      ];
      fakta.forEach(([k, v], fi) => {
        const fy = yd - fi * 14;
        sd.drawText(safePDF(k), { x: 50, y: fy, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
        sd.drawText(safePDF(v), { x: 220, y: fy, size: 8.5, font: fontBold, color: COLORS.textPrimary });
      });

      // Liten payback-graf til høyre
      drawPaybackGraf(sd, 380, yd - 60, 165, 60, t.kostnad_snitt || 0, t.besparelse_kr || 0, fontNormal, fontBold);

      yd -= 96;

      // Enova-program-referanse
      if (t.enova_program) {
        sd.drawRectangle({ x: 40, y: yd - 22, width: LAYOUT.contentWidth, height: 26, color: COLORS.enovaLight, borderRadius: 3 });
        sd.drawText(safePDF("Enova-program:"), {
          x: 52, y: yd - 14, size: 8, font: fontBold, color: COLORS.primary,
        });
        sd.drawText(safePDF(t.enova_program), {
          x: 130, y: yd - 14, size: 8, font: fontNormal, color: COLORS.textPrimary,
        });
      }
      yd -= 44;
    });

    footer(sd, fontNormal, fontBold);
  }

  // ═══════════════════════════════════════════════════════════
  // SIDE 7 — EGENFINANSIERTE LØNNSOMME TILTAK
  // ═══════════════════════════════════════════════════════════
  const side7 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side7, "Lønnsomme tiltak uten Enova-støtte", 7, totSider, fontNormal, fontBold);

  let y7 = LAYOUT.pageHeight - 100;
  seksjonHeader(side7, "Egenfinansierte tiltak", 40, y7, fontBold);
  y7 -= 18;
  side7.drawText(safePDF("Disse tiltakene gir kort tilbakebetalingstid, men kvalifiserer ikke for Enova-støtte."), {
    x: 40, y: y7, size: 9, font: fontNormal, color: COLORS.textSecondary,
  });
  y7 -= 14;
  side7.drawText(safePDF("Luft/luft-varmepumpe ble fjernet fra Enova-ordningen i august 2025."), {
    x: 40, y: y7, size: 8.5, font: fontNormal, color: COLORS.textSecondary,
  });
  y7 -= 22;

  if (egenfinTiltak.length === 0) {
    side7.drawText(safePDF("Ingen aktuelle egenfinansierte tiltak for denne boligen."), {
      x: 40, y: y7, size: 9, font: fontNormal, color: COLORS.textMuted,
    });
  } else {
    egenfinTiltak.forEach((t, i) => {
      const ry = y7 - i * 92;
      if (ry < 80) return;
      side7.drawRectangle({ x: 40, y: ry - 80, width: LAYOUT.contentWidth, height: 84, color: COLORS.egenfinLight, borderRadius: 4 });
      side7.drawRectangle({ x: 40, y: ry - 80, width: 3, height: 84, color: COLORS.egenfin });
      side7.drawText(safePDF(t.navn || "-"), {
        x: 52, y: ry - 12, size: 11, font: fontBold, color: COLORS.primary,
      });
      // Status-tag
      if (t.enova_status_tekst) {
        side7.drawText(safePDF(t.enova_status_tekst), {
          x: 52, y: ry - 24, size: 7.5, font: fontBold, color: COLORS.egenfin,
        });
      }
      // Beskrivelse
      wrapText(t.beskrivelse || "", fontNormal, 8.5, LAYOUT.contentWidth - 30).slice(0, 2).forEach((l, li) => {
        side7.drawText(safePDF(l), { x: 52, y: ry - 38 - li * 11, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
      });
      // Tall
      const tb = t.tilbakebetaling <= 30 ? `${t.tilbakebetaling} år` : "Lang sikt";
      side7.drawText(safePDF(`Kostnad: ${fmtKr(t.kostnad_min || 0)} - ${fmtKr(t.kostnad_max || 0)}`), {
        x: 52, y: ry - 64, size: 8, font: fontBold, color: COLORS.textPrimary,
      });
      side7.drawText(safePDF(`Sparer: ${fmtKrÅr(t.besparelse_kr || 0)}  -  Payback: ${tb}`), {
        x: 52, y: ry - 76, size: 8, font: fontNormal, color: COLORS.textPrimary,
      });
    });
  }

  footer(side7, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 8 — ENOVA-SØKNADSPAKKE (KUN Enova-kvalifiserte)
  // ═══════════════════════════════════════════════════════════
  const side8 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side8, "Enova-søknadspakke", 8, totSider, fontNormal, fontBold);

  let y8 = LAYOUT.pageHeight - 100;
  seksjonHeader(side8, "Slik søker du Enova-støtte", 40, y8, fontBold);
  y8 -= 16;
  side8.drawText(safePDF("Søk Enova-støtte FØR du bestiller installatør. Søknaden må være godkjent på forhånd."), {
    x: 40, y: y8, size: 8.5, font: fontBold, color: COLORS.accent,
  });
  y8 -= 20;

  // Søknadssteg
  const steg = [
    ["1", "Logg inn på enova.no/privat med BankID"],
    ["2", "Velg riktig støtteordning per tiltak (se tabellen under)"],
    ["3", "Last opp tilbud fra godkjent installatør"],
    ["4", "Vent på godkjenning (typisk 1-2 uker)"],
    ["5", "Gjennomfør tiltaket og last opp faktura + dokumentasjon"],
  ];
  steg.forEach(([n, t], i) => {
    const sy = y8 - i * 18;
    side8.drawRectangle({ x: 40, y: sy - 4, width: 18, height: 18, color: COLORS.enova, borderRadius: 9 });
    side8.drawText(n, { x: 47, y: sy, size: 9, font: fontBold, color: COLORS.card });
    side8.drawText(safePDF(t), { x: 64, y: sy, size: 9, font: fontNormal, color: COLORS.textPrimary });
  });
  y8 -= steg.length * 18 + 12;

  // Dokumentasjonskrav per tiltak
  seksjonHeader(side8, "Dokumentasjon Enova krever", 40, y8, fontBold);
  y8 -= 18;

  const DOKS = {
    isolering_loft:   "Faktura + dokumentasjon på isolasjonstykkelse",
    isolering_vegger: "Faktura + dokumentasjon på isolasjonstykkelse",
    varmepumpe_lv:    "Faktura fra godkjent installatør + COP/SPF-spesifikasjon",
    bergvarme:        "Faktura fra godkjent installatør + boredokumentasjon + SPF",
    vinduer:          "Faktura + U-verdi-dokumentasjon (maks 0,8 W/m²K)",
    ytterdører:       "Faktura + U-verdi-dokumentasjon",
    ventilasjon:      "Faktura fra godkjent installatør + SFP-verdi",
    solceller:        "Faktura + nettilknytningsavtale + tekniske spesifikasjoner",
  };

  // KUN Enova-kvalifiserte
  enovaTiltak.forEach((t, i) => {
    const ry = y8 - i * 26;
    if (ry < 200) return;
    side8.drawRectangle({ x: 40, y: ry - 22, width: LAYOUT.contentWidth, height: 26, color: i % 2 === 0 ? COLORS.background : COLORS.card });
    side8.drawText(safePDF(`${t.navn} (inntil ${fmtKr(t.støtte_max || 0)})`), {
      x: 50, y: ry - 8, size: 9, font: fontBold, color: COLORS.primary,
    });
    side8.drawText(safePDF(DOKS[t.id] || "Faktura fra godkjent fagperson + tekniske spesifikasjoner"), {
      x: 50, y: ry - 20, size: 8, font: fontNormal, color: COLORS.textSecondary,
    });
  });
  const docBlokkH = enovaTiltak.length * 26 + 12;
  y8 -= docBlokkH;

  // Ferdig søknadstekst (KUN Enova-tiltak)
  if (y8 > 140 && enovaTiltak.length > 0) {
    seksjonHeader(side8, "Ferdig søknadstekst (kopier og lim inn)", 40, y8, fontBold);
    y8 -= 14;
    const enovaKwhSpart = enovaTiltak.reduce((s, t) => s + Math.round(totalKwh * (t.kWh_pct || 0)), 0);
    const enovaBes = enovaTiltak.reduce((s, t) => s + (t.besparelse_kr || 0), 0);
    const sokTekst = `Jeg søker om støtte til energitiltak i min bolig. Boligen ble bygget i perioden ${bygData?.label || "-"} og har i dag estimert energimerke ${merke?.merke || "-"}. Tiltakene jeg planlegger er: ${enovaTiltak.map(t => t.navn).join(", ")}. Forventet energibesparelse er ca. ${enovaKwhSpart.toLocaleString("no")} kWh/år, tilsvarende ca. ${fmtKrÅr(enovaBes)} i reduserte strømutgifter. Tiltakene vil forbedre boligens energimerke fra ${merke?.merke || "-"} til estimert ${merkePotensial?.merke || "-"}.`;
    const sokLinjer = wrapText(sokTekst, fontNormal, 8.5, LAYOUT.contentWidth - 20);
    const sokH = Math.min(sokLinjer.length, 8) * 12 + 16;
    side8.drawRectangle({ x: 40, y: y8 - sokH, width: LAYOUT.contentWidth, height: sokH, color: COLORS.background, borderRadius: 4 });
    side8.drawRectangle({ x: 40, y: y8 - sokH, width: 3, height: sokH, color: COLORS.primary });
    sokLinjer.slice(0, 8).forEach((l, i) => {
      side8.drawText(safePDF(l), { x: 52, y: y8 - 12 - i * 12, size: 8.5, font: fontNormal, color: COLORS.textPrimary });
    });
  }

  footer(side8, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 9 — FINANSIERING OG VERDIØKNING
  // ═══════════════════════════════════════════════════════════
  const side9 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side9, "Finansiering og verdiøkning", 9, totSider, fontNormal, fontBold);

  let y9 = LAYOUT.pageHeight - 100;
  seksjonHeader(side9, "Finansieringsalternativer", 40, y9, fontBold);
  y9 -= 18;

  const finans = [
    ["Grønt boliglån", "Mange banker tilbyr 0,2-0,5 prosentpoeng lavere rente når boligen er oppgradert til merke A eller B. Spør banken din.", COLORS.enova],
    ["Husbanken grønt lån", "Gunstig finansiering for energioppgradering av eldre boliger. Se husbanken.no for vilkår.", COLORS.primary],
    ["Kombiner tiltak", "Bestill flere tiltak hos samme håndverker - reduser riggkostnader og få bedre totalpris.", COLORS.accent],
  ];
  finans.forEach((f, i) => {
    const fy = y9 - i * 64;
    side9.drawRectangle({ x: 40, y: fy - 56, width: LAYOUT.contentWidth, height: 60, color: COLORS.background, borderRadius: 4 });
    side9.drawRectangle({ x: 40, y: fy - 56, width: 3, height: 60, color: f[2] });
    side9.drawText(safePDF(f[0]), { x: 52, y: fy - 14, size: 10, font: fontBold, color: COLORS.primary });
    wrapText(f[1], fontNormal, 8.5, LAYOUT.contentWidth - 30).slice(0, 3).forEach((l, li) => {
      side9.drawText(safePDF(l), { x: 52, y: fy - 28 - li * 11, size: 8.5, font: fontNormal, color: COLORS.textSecondary });
    });
  });
  y9 -= finans.length * 64 + 12;

  // Verdiøkning
  seksjonHeader(side9, "Verdiøkning ved energimerke-løft", 40, y9, fontBold);
  y9 -= 18;
  side9.drawText(safePDF(
    `Boligen din kan gå fra ${merke?.merke || "-"} til ${merkePotensial?.merke || "-"} med tiltakene i denne rapporten.`
  ), { x: 40, y: y9, size: 9, font: fontBold, color: COLORS.textPrimary });
  y9 -= 14;
  const verdiTekst = "Boliger med bedre energimerke selges ofte raskere og til høyere pris. Effekten varierer med marked og område, men kjøpere ser positivt på lavere strømkostnader og mindre behov for oppgradering. Ved salg er energimerke ofte en del av prisvurderingen.";
  wrapText(verdiTekst, fontNormal, 9, LAYOUT.contentWidth - 20).slice(0, 6).forEach((l, i) => {
    side9.drawText(safePDF(l), { x: 40, y: y9 - i * 13, size: 9, font: fontNormal, color: COLORS.textSecondary });
  });

  footer(side9, fontNormal, fontBold);

  // ═══════════════════════════════════════════════════════════
  // SIDE 10 — FORUTSETNINGER OG BEGRENSNINGER
  // ═══════════════════════════════════════════════════════════
  const side10 = pdfDoc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  sideHeader(side10, "Forutsetninger og begrensninger", 10, totSider, fontNormal, fontBold);

  let y10 = LAYOUT.pageHeight - 100;

  seksjonHeader(side10, "Antakelser bak tallene", 40, y10, fontBold);
  y10 -= 18;
  const ant = [
    `Strømpris brukt i beregning: ${oppvData ? "vektet ut fra valgt oppvarming" : "1,40 kr/kWh basert på SSB Q3 2025"}.`,
    `Klimasone: ${klima?.label || "-"}.`,
    `U-verdier: estimert fra byggeår (${bygData?.label || "-"}) basert på TEK-historikk - ikke målt.`,
    `Enova-satser: gjeldende fra august 2025 (kan endres).`,
    `Levetid: tiltakene antas å ha 15-30 års levetid.`,
  ];
  ant.forEach((a, i) => {
    side10.drawText(safePDF("- " + a), {
      x: 40, y: y10 - i * 14, size: 8.5, font: fontNormal, color: COLORS.textPrimary,
    });
  });
  y10 -= ant.length * 14 + 16;

  seksjonHeader(side10, "Usikkerhet", 40, y10, fontBold);
  y10 -= 18;
  const usikkerhetTekst = "Disse tallene er estimater, ikke målte verdier. Faktisk besparelse avhenger av blant annet kvaliteten på utførelsen, brukervaner, prisutvikling på strøm, og hvilke tiltak som faktisk kombineres. Påliteligheten øker betydelig når en energirådgiver utfører fysisk befaring.";
  wrapText(usikkerhetTekst, fontNormal, 9, LAYOUT.contentWidth - 20).slice(0, 5).forEach((l, i) => {
    side10.drawText(safePDF(l), { x: 40, y: y10 - i * 13, size: 9, font: fontNormal, color: COLORS.textSecondary });
  });
  y10 -= 80;

  // Tydelig grenseoppgang
  side10.drawRectangle({ x: 40, y: y10 - 80, width: LAYOUT.contentWidth, height: 84, color: COLORS.accentLight, borderRadius: 4 });
  side10.drawRectangle({ x: 40, y: y10 - 80, width: 3, height: 84, color: COLORS.accent });
  side10.drawText(safePDF("Hva en energirådgiver tilfører som BoligEffekt ikke gjør"), {
    x: 52, y: y10 - 14, size: 10, font: fontBold, color: COLORS.primary,
  });
  const ergTekst = "BoligEffekt erstatter ikke en fysisk befaring fra energirådgiver. En rådgiver vil måle faktiske U-verdier, gjøre lufttetthetstest, og kan utstede offisielt energimerke. Vår rapport er steget før du eventuelt kontakter rådgiver eller søker Enova.";
  wrapText(ergTekst, fontNormal, 8.5, LAYOUT.contentWidth - 30).slice(0, 5).forEach((l, i) => {
    side10.drawText(safePDF(l), { x: 52, y: y10 - 30 - i * 11, size: 8.5, font: fontNormal, color: COLORS.textPrimary });
  });
  y10 -= 100;

  // Final disclaimer
  side10.drawRectangle({ x: 40, y: y10 - 24, width: LAYOUT.contentWidth, height: 28, color: COLORS.primaryDark, borderRadius: 4 });
  side10.drawText(safePDF("Dette er ikke et offisielt energimerke og kan ikke brukes ved boligsalg."), {
    x: 52, y: y10 - 16, size: 9, font: fontBold, color: COLORS.card,
  });

  footer(side10, fontNormal, fontBold);

  // ─────────────────────────────────────────────────────────────
  const bytes = await pdfDoc.save();
  console.log(`[PDF] Ferdig - ${pdfDoc.getPageCount()} side(r), ${bytes.length} bytes`);
  return bytes;
}

module.exports = { lagPDF, safePDF, wrapText, COLORS, TYPO, LAYOUT };
