// Test-runner for ny pdf-generator. Kjør: node test-pdf.js
const fs = require("fs");
const { lagPDF } = require("./pdf-generator");

// Mock-resultat: bolig 1987-1997, merke G, ~100 m²
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
      label: "1987–1997",
      fra: 1987, til: 1997,
      u_vegg: 0.30, u_tak: 0.20, u_gulv: 0.25,
      u_vindu: 2.00, lufttetthet: 2.5,
    },
    klima: { id: "3", label: "Oslo / Innlandet", HDD: 4000, korreksjon: 1.0 },
    bolig: { id: "enebolig", label: "Enebolig", faktor: 1.0 },
    oppvData: { label: "Panelovner / direktevarme", COP: 1.0, primær: 2.0 },
    weightedCost: 1.40,
    tiltak: [
      // Enova-kvalifiserte
      { id: "isolering_loft", navn: "Etterisolering loft/tak",
        beskrivelse: "25 % av kostnad, maks 150 kr/kvm opp til 150 kvm. Varme stiger – loft er ofte det mest kostnadseffektive tiltaket. Kun boliger bygget før 1997.",
        støtte_min: 5000, støtte_max: 22500, støtte_snitt: 13750,
        kostnad_min: 30000, kostnad_max: 100000, kostnad_snitt: 65000, netto: 51250,
        besparelse_kr: 5985, kWh_pct: 0.15, prioritet: "høy", tilbakebetaling: 9,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til energitiltak i bolig (aug 2025)",
      },
      { id: "varmepumpe_lv", navn: "Luft/vann-varmepumpe",
        beskrivelse: "SPF 2,8 – dekker 70 % av varmebehovet. 25 % av kostnad, maks 20 000 kr. Krever vannbåren distribusjon.",
        støtte_min: 5000, støtte_max: 20000, støtte_snitt: 12500,
        kostnad_min: 60000, kostnad_max: 120000, kostnad_snitt: 90000, netto: 70000,
        besparelse_kr: 13965, kWh_pct: 0.35, prioritet: "høy", tilbakebetaling: 5,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til luft-til-vann varmepumpe (aug 2025)",
      },
      { id: "vinduer", navn: "Vindusutskifting (3-lags)",
        beskrivelse: "25 % av kostnad, maks 400 kr/kvm opp til 50 kvm (maks 20 000 kr). U-verdi ned til 0,7 W/m²K. Kun boliger bygget før 1997.",
        støtte_min: 2000, støtte_max: 20000, støtte_snitt: 11000,
        kostnad_min: 60000, kostnad_max: 100000, kostnad_snitt: 80000, netto: 60000,
        besparelse_kr: 3990, kWh_pct: 0.10, prioritet: "høy", tilbakebetaling: 15,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til energitiltak i bolig (aug 2025)",
      },
      { id: "isolering_vegger", navn: "Etterisolering yttervegger",
        beskrivelse: "25 % av kostnad, maks 150 kr/kvm opp til 250 kvm (maks 37 500 kr). Best ved fasaderehab. Kun boliger bygget før 1997.",
        støtte_min: 5000, støtte_max: 37500, støtte_snitt: 21250,
        kostnad_min: 80000, kostnad_max: 150000, kostnad_snitt: 115000, netto: 77500,
        besparelse_kr: 5985, kWh_pct: 0.15, prioritet: "høy", tilbakebetaling: 13,
        kategori: "enova_kvalifisert",
        enova_program: "Tilskudd til energitiltak i bolig (aug 2025)",
      },
      // Egenfinansiert (luft/luft)
      { id: "varmepumpe_ll", navn: "Luft/luft-varmepumpe 🌡️",
        beskrivelse: "SPF 2,5, dekker 60 % av varmebehovet. Ingen Enova-støtte fra august 2025. Rask tilbakebetaling pga lav kostnad.",
        støtte_min: 0, støtte_max: 0, støtte_snitt: 0,
        kostnad_min: 15000, kostnad_max: 25000, kostnad_snitt: 20000, netto: 20000,
        besparelse_kr: 7980, kWh_pct: 0.20, prioritet: "høy", tilbakebetaling: 3,
        kategori: "egenfinansiert",
        enova_status_tekst: "Ikke Enova-støttet etter august 2025",
        enova_program: "Ingen Enova-støtte (avviklet aug 2025)",
      },
      // Egenfinansiert (tetting) — har emoji 🔧 i navn for å teste strip
      { id: "tetting", navn: "Tettelister og fuging 🔧",
        beskrivelse: "Tette rundt vinduer, dører og gjennomføringer med tettelister, bunnsverd og fugemasse. Billigste tiltak med raskest tilbakebetaling. Anbefales alltid som første steg.",
        støtte_min: 0, støtte_max: 0, støtte_snitt: 0,
        kostnad_min: 2000, kostnad_max: 8000, kostnad_snitt: 5000, netto: 5000,
        besparelse_kr: 1995, kWh_pct: 0.05, prioritet: "høy", tilbakebetaling: 3,
        kategori: "egenfinansiert",
        enova_status_tekst: "Grunntiltak uten Enova-støtte",
        enova_program: "Ingen Enova-støtte",
      },
    ],
  },
};

(async () => {
  try {
    const bytes = await lagPDF(mockData, "oppgraderingsplan");
    const out = "C:/Users/andri/boligeffekt-backend/test-output.pdf";
    fs.writeFileSync(out, Buffer.from(bytes));
    console.log(`OK - PDF generert: ${out} (${bytes.length} bytes)`);
  } catch (err) {
    console.error("FEIL:", err);
    process.exit(1);
  }
})();
