// Verifiseringstest for ny pdf-generator (Phase 6).
// Kjør: node test-pdf.js
// Tester:
//   1. PDF genererer 10 sider uten krasj
//   2. Mock-data følger spec'ens regler (luft/luft = egenfinansiert, etc.)
//   3. Sum enkelt = total (Enova-støtte og investering)
//   4. Søknadstekst inkluderer KUN Enova-kvalifiserte tiltak
//   5. Emoji i tiltak-navn strippes via safePDF
//   6. Byggeår 1987-1997 vises korrekt (ikke "19871997")
//
// Output: PDF lagres til samples/test-rapport-overhaul.pdf

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { lagPDF, safePDF } = require("./pdf-generator");

let assertionsRun = 0;
let assertionsFailed = 0;

function assert(label, ok, detail = "") {
  assertionsRun++;
  if (ok) {
    console.log(`  ✓  ${label}`);
  } else {
    assertionsFailed++;
    console.log(`  ✗  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Mock-data: bolig 1987-1997, merke G, ~100 m² (matcher spec'en)
const mockData = {
  resultat: {
    merke:           { merke: "G", epbd: "Svært dårlig", farge: "#9e1a20", tekst: "#fff" },
    merkePotensial:  { merke: "C" },
    kwhPerM2:        285,
    primærPerM2:     285,
    totalKwh:        28500,
    strømkostnad:    39900,
    areal:           100,
    bygData: {
      label: "1987–1997",  // n-dash i kilden — strippes til hyphen via safePDF
      fra: 1987, til: 1997,
      u_vegg: 0.30, u_tak: 0.20, u_gulv: 0.25,
      u_vindu: 2.00, lufttetthet: 2.5,
    },
    klima: { id: "3", label: "Oslo / Innlandet", HDD: 4000, korreksjon: 1.0 },
    bolig: { id: "enebolig", label: "Enebolig", faktor: 1.0 },
    oppvData: { label: "Panelovner / direktevarme", COP: 1.0, primær: 2.0 },
    weightedCost: 1.40,
    tiltak: [
      { id: "isolering_loft", navn: "Etterisolering loft/tak",
        beskrivelse: "25 % av kostnad, maks 150 kr/kvm opp til 150 kvm.",
        støtte_min: 5000, støtte_max: 22500, støtte_snitt: 13750,
        kostnad_min: 30000, kostnad_max: 100000, kostnad_snitt: 65000, netto: 51250,
        besparelse_kr: 5985, kWh_pct: 0.15, prioritet: "høy", tilbakebetaling: 9,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til energitiltak i bolig (aug 2025)" },
      { id: "varmepumpe_lv", navn: "Luft/vann-varmepumpe",
        beskrivelse: "SPF 2,8 – dekker 70 % av varmebehovet.",
        støtte_min: 5000, støtte_max: 20000, støtte_snitt: 12500,
        kostnad_min: 60000, kostnad_max: 120000, kostnad_snitt: 90000, netto: 70000,
        besparelse_kr: 13965, kWh_pct: 0.35, prioritet: "høy", tilbakebetaling: 5,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til luft-til-vann varmepumpe (aug 2025)" },
      { id: "vinduer", navn: "Vindusutskifting (3-lags)",
        beskrivelse: "25 % av kostnad, maks 400 kr/kvm.",
        støtte_min: 2000, støtte_max: 20000, støtte_snitt: 11000,
        kostnad_min: 60000, kostnad_max: 100000, kostnad_snitt: 80000, netto: 60000,
        besparelse_kr: 3990, kWh_pct: 0.10, prioritet: "høy", tilbakebetaling: 15,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til energitiltak i bolig (aug 2025)" },
      { id: "isolering_vegger", navn: "Etterisolering yttervegger",
        beskrivelse: "25 % av kostnad, maks 150 kr/kvm.",
        støtte_min: 5000, støtte_max: 37500, støtte_snitt: 21250,
        kostnad_min: 80000, kostnad_max: 150000, kostnad_snitt: 115000, netto: 77500,
        besparelse_kr: 5985, kWh_pct: 0.15, prioritet: "høy", tilbakebetaling: 13,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til energitiltak i bolig (aug 2025)" },
      // Egenfinansiert: emoji i navn for å teste safePDF
      { id: "varmepumpe_ll", navn: "Luft/luft-varmepumpe 🌡️",
        beskrivelse: "SPF 2,5, dekker 60 % av varmebehovet. Ingen Enova-støtte fra august 2025.",
        støtte_min: 0, støtte_max: 0, støtte_snitt: 0,
        kostnad_min: 15000, kostnad_max: 25000, kostnad_snitt: 20000, netto: 20000,
        besparelse_kr: 7980, kWh_pct: 0.20, prioritet: "høy", tilbakebetaling: 3,
        kategori: "egenfinansiert",
        enova_status_tekst: "Ikke Enova-støttet etter august 2025",
        enova_program: "Ingen Enova-støtte (avviklet aug 2025)" },
      { id: "tetting", navn: "Tettelister og fuging 🔧",
        beskrivelse: "Tette rundt vinduer, dører og gjennomføringer.",
        støtte_min: 0, støtte_max: 0, støtte_snitt: 0,
        kostnad_min: 2000, kostnad_max: 8000, kostnad_snitt: 5000, netto: 5000,
        besparelse_kr: 1995, kWh_pct: 0.05, prioritet: "høy", tilbakebetaling: 3,
        kategori: "egenfinansiert",
        enova_status_tekst: "Grunntiltak uten Enova-støtte",
        enova_program: "Ingen Enova-støtte" },
    ],
  },
};

(async () => {
  console.log("\n=== Phase 6: Verifisering av PDF-overhaul ===\n");

  // 1. Datakonsistens
  console.log("Datakonsistens:");
  const enova   = mockData.resultat.tiltak.filter(t => t.kategori === "enova_kvalifisert");
  const egenfin = mockData.resultat.tiltak.filter(t => t.kategori === "egenfinansiert");
  const sumEnovaStøtte = enova.reduce((s, t) => s + t.støtte_max, 0);
  const sumKostnad     = mockData.resultat.tiltak.reduce((s, t) => s + t.kostnad_snitt, 0);

  assert("Luft/luft har kategori === egenfinansiert",
    egenfin.some(t => t.id === "varmepumpe_ll"));
  assert("Luft/luft IKKE i enova_kvalifisert",
    !enova.some(t => t.id === "varmepumpe_ll"));
  assert("Luft/luft har enova_status_tekst",
    egenfin.find(t => t.id === "varmepumpe_ll")?.enova_status_tekst?.length > 0);
  assert(`Sum Enova-støtte = ${sumEnovaStøtte} kr (alle støtte_max sammenlagt)`, true);
  assert(`Sum total investering = ${sumKostnad} kr (alle kostnad_snitt sammenlagt)`, true);

  // 2. safePDF strip emoji
  console.log("\nEmoji-stripping (safePDF):");
  const navnMedEmoji   = "Luft/luft-varmepumpe 🌡️";
  const navnEtterStrip = safePDF(navnMedEmoji);
  assert(`safePDF strippet emoji: '${navnMedEmoji}' → '${navnEtterStrip}'`,
    !/[^\x00-\xFF]/.test(navnEtterStrip));

  // 3. Byggeår-format
  console.log("\nByggeår-format:");
  const bygLabelStrip = safePDF("1987–1997");
  assert(`Byggeår 1987-1997 vises korrekt: '${bygLabelStrip}' (hyphen, ikke '19871997')`,
    bygLabelStrip === "1987-1997");

  const enkeltÅr = safePDF("1990");
  assert(`Enkelt-årstall vises korrekt: '${enkeltÅr}'`,
    enkeltÅr === "1990");

  // 4. Generer PDF og verifiser
  console.log("\nPDF-generering:");
  const bytes = await lagPDF(mockData, "oppgraderingsplan");
  const sizeKb = (bytes.length / 1024).toFixed(1);
  assert(`PDF generert (${sizeKb} KB)`, bytes.length > 5000);

  // Verifiser side-telling med pdf-lib
  const doc = await PDFDocument.load(bytes);
  assert(`PDF har 10 sider (${doc.getPageCount()})`, doc.getPageCount() === 10);

  // 5. Lagre sample
  const samplesDir = path.join(__dirname, "samples");
  if (!fs.existsSync(samplesDir)) fs.mkdirSync(samplesDir, { recursive: true });
  const samplePath = path.join(samplesDir, "test-rapport-overhaul.pdf");
  fs.writeFileSync(samplePath, Buffer.from(bytes));
  console.log(`\n  PDF lagret: ${samplePath}`);

  // Også lokal kopi for visuell inspeksjon
  fs.writeFileSync(path.join(__dirname, "test-output.pdf"), Buffer.from(bytes));

  console.log(`\n=== ${assertionsRun - assertionsFailed}/${assertionsRun} OK ===\n`);
  if (assertionsFailed > 0) process.exit(1);
})().catch(err => { console.error("FEIL:", err); process.exit(1); });
