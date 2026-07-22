// Location intelligence: turn the messy signals we collect about a contact
// (a free-form GitHub location, discovered phone numbers, and the UTC offset
// baked into their commits) into a best-guess country + timezone for
// local-time send scheduling.
//
// resolveLocation() combines all three and returns the most reliable answer,
// preferring the strongest signal:
//   1. commit UTC offset  -> exact working timezone (+ best-guess country if
//                            the profile/phone gave none)
//   2. phone dial code    -> exact country -> timezone
//   3. GitHub location     -> standardized country -> timezone

export type ResolvedLocation = {
  /** Standardized country name, or "" if unknown. */
  country: string;
  /** IANA zone ("Europe/Kyiv") OR fixed "UTC-04:00" from a commit offset. */
  timezone: string;
  /** Where the timezone came from. */
  source: "commit" | "phone" | "location" | "none";
  /** Rough confidence for display/debug. */
  confidence: "high" | "medium" | "low" | "none";
};

// --- country normalization -------------------------------------------------

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "United States", us: "United States", "u.s.": "United States",
  "u.s.a.": "United States", america: "United States",
  "united states": "United States", "united states of america": "United States",
  uk: "United Kingdom", "u.k.": "United Kingdom", england: "United Kingdom",
  britain: "United Kingdom", "great britain": "United Kingdom",
  scotland: "United Kingdom", wales: "United Kingdom",
  "united kingdom": "United Kingdom",
  brasil: "Brazil", br: "Brazil",
  turkiye: "Turkey", "türkiye": "Turkey", tr: "Turkey",
  deutschland: "Germany", de: "Germany",
  czechia: "Czech Republic", "czech republic": "Czech Republic",
  "perú": "Peru",
  "north marcedonia": "North Macedonia", marcedonia: "North Macedonia",
  macedonia: "North Macedonia",
  bih: "Bosnia and Herzegovina", bosnia: "Bosnia and Herzegovina",
  "bosnia & herzegovina": "Bosnia and Herzegovina",
  "the bahamas": "Bahamas",
  uae: "United Arab Emirates", "united arab emirates": "United Arab Emirates",
  nl: "Netherlands", mex: "Mexico",
};

const KNOWN_COUNTRIES = new Set<string>([
  "United States","Ukraine","Canada","Germany","Turkey","United Kingdom",
  "Poland","Brazil","Pakistan","Argentina","Spain","Serbia","Portugal",
  "Netherlands","Mexico","Greece","Australia","Finland","Croatia","Sweden",
  "North Macedonia","Romania","France","Ecuador","Costa Rica","Colombia",
  "Bulgaria","New Zealand","Montenegro","Italy","Ireland","Denmark",
  "Venezuela","Albania","Sri Lanka","Slovenia","Peru","Panama","Estonia",
  "Bosnia and Herzegovina","Hungary","Czech Republic","Egypt","Belgium",
  "Austria","Lithuania","Kosovo","Moldova","Belarus","Uzbekistan","Taiwan",
  "Singapore","Tunisia","Rwanda","Jamaica","Nicaragua","Bolivia","Guatemala",
  "Philippines","United Arab Emirates","Iran","Bahamas","Switzerland",
  "Slovakia","Georgia","Vietnam","India","Norway","Malaysia",
  // European countries added for the CSV-import region filter.
  "Latvia","Luxembourg","Malta","Cyprus","Iceland","Monaco","Andorra",
  "Liechtenstein","San Marino","Armenia",
]);

const US_STATES = new Set<string>([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
  "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy",
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut",
  "delaware","florida","hawaii","idaho","illinois","indiana","iowa","kansas",
  "kentucky","louisiana","maine","maryland","massachusetts","michigan",
  "minnesota","mississippi","missouri","montana","nebraska","nevada",
  "new hampshire","new jersey","new mexico","new york","north carolina",
  "north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island",
  "south carolina","south dakota","tennessee","texas","utah","vermont",
  "virginia","washington","west virginia","wisconsin","wyoming","nyc",
]);

const CITY_COUNTRY: Record<string, string> = {
  kyiv: "Ukraine", kiev: "Ukraine", lviv: "Ukraine", dnipro: "Ukraine",
  odesa: "Ukraine", kharkiv: "Ukraine", sumy: "Ukraine", vinnytsia: "Ukraine",
  zaporizhzhya: "Ukraine",
  istanbul: "Turkey", "i̇stanbul": "Turkey", ankara: "Turkey", izmir: "Turkey",
  bursa: "Turkey", hatay: "Turkey", mersin: "Turkey", "muğla": "Turkey",
  gaziantep: "Turkey", siirt: "Turkey",
  london: "United Kingdom", chester: "United Kingdom", swansea: "United Kingdom",
  slough: "United Kingdom", brighton: "United Kingdom",
  bournemouth: "United Kingdom",
  warsaw: "Poland", warszawa: "Poland", krakow: "Poland", "kraków": "Poland",
  "białystok": "Poland", "łódź": "Poland", "łagów": "Poland",
  toronto: "Canada", winnipeg: "Canada", calgary: "Canada",
  mississauga: "Canada", waterloo: "Canada", fredericton: "Canada",
  guelph: "Canada", bc: "Canada",
  berlin: "Germany", hamburg: "Germany", dresden: "Germany",
  hannover: "Germany",
  paris: "France", amsterdam: "Netherlands", barcelona: "Spain",
  budapest: "Hungary",
  sydney: "Australia", melbourne: "Australia", adelaide: "Australia",
  vic: "Australia", nsw: "Australia", act: "Australia",
  islamabad: "Pakistan", lahore: "Pakistan", peshawar: "Pakistan",
  burewala: "Pakistan",
  lisbon: "Portugal", "santarém": "Portugal",
  belgrade: "Serbia", "novi sad": "Serbia",
  sarajevo: "Bosnia and Herzegovina", mostar: "Bosnia and Herzegovina",
  skopje: "North Macedonia", tirana: "Albania", ljubljana: "Slovenia",
  "cluj-napoca": "Romania", minsk: "Belarus", vilnius: "Lithuania",
  kaunas: "Lithuania", tbilisi: "Georgia", kosice: "Slovakia",
  osijek: "Croatia", corfu: "Greece", tartu: "Estonia",
  bari: "Italy", turin: "Italy", torino: "Italy", rome: "Italy",
  "medellín": "Colombia", cali: "Colombia", bogota: "Colombia",
  pereira: "Colombia", caracas: "Venezuela", barinas: "Venezuela",
  "ciudad bolivar": "Venezuela",
  "sao paulo": "Brazil", "são paulo": "Brazil", curitiba: "Brazil",
  "brasília": "Brazil", salvador: "Brazil", "buenos aires": "Argentina",
  tampico: "Mexico", sonora: "Mexico",
  dubai: "United Arab Emirates", tehran: "Iran", "ocho rios": "Jamaica",
  gothenburg: "Sweden", kl: "Malaysia",
  nyc: "United States", "new york": "United States", chicago: "United States",
  houston: "United States", dallas: "United States", seattle: "United States",
  portland: "United States", denver: "United States", boulder: "United States",
  atlanta: "United States", miami: "United States", tampa: "United States",
  oakland: "United States", "palo alto": "United States",
  "los angeles": "United States", "san francisco": "United States",
  "citrus heights": "United States", milwaukee: "United States",
  indianapolis: "United States", torrance: "United States",
  newington: "United States",
};

// Country -> representative IANA timezone (primary for multi-zone countries).
const COUNTRY_TZ: Record<string, string> = {
  "United States": "America/New_York", Canada: "America/Toronto",
  Ukraine: "Europe/Kyiv", "United Kingdom": "Europe/London",
  Turkey: "Europe/Istanbul", Germany: "Europe/Berlin", Poland: "Europe/Warsaw",
  Brazil: "America/Sao_Paulo", Pakistan: "Asia/Karachi",
  Argentina: "America/Argentina/Buenos_Aires", Spain: "Europe/Madrid",
  Serbia: "Europe/Belgrade", Portugal: "Europe/Lisbon",
  Netherlands: "Europe/Amsterdam", Mexico: "America/Mexico_City",
  Greece: "Europe/Athens", Australia: "Australia/Sydney",
  Finland: "Europe/Helsinki", Croatia: "Europe/Zagreb",
  Sweden: "Europe/Stockholm", "North Macedonia": "Europe/Skopje",
  Romania: "Europe/Bucharest", France: "Europe/Paris",
  Ecuador: "America/Guayaquil", "Costa Rica": "America/Costa_Rica",
  Colombia: "America/Bogota", Bulgaria: "Europe/Sofia",
  "New Zealand": "Pacific/Auckland", Montenegro: "Europe/Podgorica",
  Italy: "Europe/Rome", Ireland: "Europe/Dublin",
  Denmark: "Europe/Copenhagen", Venezuela: "America/Caracas",
  Albania: "Europe/Tirane", "Sri Lanka": "Asia/Colombo",
  Slovenia: "Europe/Ljubljana", Peru: "America/Lima",
  Panama: "America/Panama", Estonia: "Europe/Tallinn",
  "Bosnia and Herzegovina": "Europe/Sarajevo", Hungary: "Europe/Budapest",
  "Czech Republic": "Europe/Prague", Egypt: "Africa/Cairo",
  Belgium: "Europe/Brussels", Austria: "Europe/Vienna",
  Lithuania: "Europe/Vilnius", Kosovo: "Europe/Belgrade",
  Moldova: "Europe/Chisinau", Belarus: "Europe/Minsk",
  Uzbekistan: "Asia/Tashkent", Taiwan: "Asia/Taipei",
  Singapore: "Asia/Singapore", Tunisia: "Africa/Tunis",
  Rwanda: "Africa/Kigali", Jamaica: "America/Jamaica",
  Nicaragua: "America/Managua", Bolivia: "America/La_Paz",
  Guatemala: "America/Guatemala", Philippines: "Asia/Manila",
  "United Arab Emirates": "Asia/Dubai", Iran: "Asia/Tehran",
  Bahamas: "America/Nassau", Switzerland: "Europe/Zurich",
  Slovakia: "Europe/Bratislava", Georgia: "Asia/Tbilisi",
  Vietnam: "Asia/Ho_Chi_Minh", India: "Asia/Kolkata", Norway: "Europe/Oslo",
  Malaysia: "Asia/Kuala_Lumpur",
  Latvia: "Europe/Riga", Luxembourg: "Europe/Luxembourg",
  Malta: "Europe/Malta", Cyprus: "Asia/Nicosia",
  Iceland: "Atlantic/Reykjavik", Monaco: "Europe/Monaco",
  Andorra: "Europe/Andorra", Liechtenstein: "Europe/Vaduz",
  "San Marino": "Europe/San_Marino", Armenia: "Asia/Yerevan",
};

// Canonical country name -> ISO 3166-1 alpha-2 (for flag lookup).
const COUNTRY_ISO2: Record<string, string> = {
  "United States": "US", Ukraine: "UA", Canada: "CA", Germany: "DE",
  Turkey: "TR", "United Kingdom": "GB", Poland: "PL", Brazil: "BR",
  Pakistan: "PK", Argentina: "AR", Spain: "ES", Serbia: "RS", Portugal: "PT",
  Netherlands: "NL", Mexico: "MX", Greece: "GR", Australia: "AU",
  Finland: "FI", Croatia: "HR", Sweden: "SE", "North Macedonia": "MK",
  Romania: "RO", France: "FR", Ecuador: "EC", "Costa Rica": "CR",
  Colombia: "CO", Bulgaria: "BG", "New Zealand": "NZ", Montenegro: "ME",
  Italy: "IT", Ireland: "IE", Denmark: "DK", Venezuela: "VE", Albania: "AL",
  "Sri Lanka": "LK", Slovenia: "SI", Peru: "PE", Panama: "PA", Estonia: "EE",
  "Bosnia and Herzegovina": "BA", Hungary: "HU", "Czech Republic": "CZ",
  Egypt: "EG", Belgium: "BE", Austria: "AT", Lithuania: "LT", Kosovo: "XK",
  Moldova: "MD", Belarus: "BY", Uzbekistan: "UZ", Taiwan: "TW",
  Singapore: "SG", Tunisia: "TN", Rwanda: "RW", Jamaica: "JM",
  Nicaragua: "NI", Bolivia: "BO", Guatemala: "GT", Philippines: "PH",
  "United Arab Emirates": "AE", Iran: "IR", Bahamas: "BS", Switzerland: "CH",
  Slovakia: "SK", Georgia: "GE", Vietnam: "VN", India: "IN", Norway: "NO",
  Malaysia: "MY",
  // Common extras beyond the outreach set, in case they appear.
  China: "CN", Japan: "JP", "South Korea": "KR", Russia: "RU",
  Indonesia: "ID", Thailand: "TH", Nigeria: "NG", Kenya: "KE",
  "South Africa": "ZA", Israel: "IL", "Saudi Arabia": "SA", Bangladesh: "BD",
  Nepal: "NP", Chile: "CL", Uruguay: "UY", Paraguay: "PY",
  "Dominican Republic": "DO", Honduras: "HN", "El Salvador": "SV",
  Morocco: "MA", Algeria: "DZ", Ghana: "GH", Latvia: "LV", Iceland: "IS",
  Luxembourg: "LU", Cyprus: "CY", Armenia: "AM", Azerbaijan: "AZ",
  Kazakhstan: "KZ", Malta: "MT", Monaco: "MC", Andorra: "AD",
  Liechtenstein: "LI", "San Marino": "SM",
};

/** Canonical country name (or free-form) -> ISO 3166-1 alpha-2, or null. */
export function countryIso2(country: string | null | undefined): string | null {
  if (!country || !country.trim()) return null;
  const exact = COUNTRY_ISO2[country.trim()];
  if (exact) return exact;
  const canon = normalizeCountry(country);
  return canon ? (COUNTRY_ISO2[canon] ?? null) : null;
}

/** Regional-indicator flag emoji for a country (best-effort; renders as the
 *  ISO letters on platforms without flag-emoji support, e.g. Windows Chrome). */
export function countryFlag(country: string | null | undefined): string {
  const iso = countryIso2(country);
  if (!iso) return "";
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + iso.charCodeAt(0) - 65,
    base + iso.charCodeAt(1) - 65,
  );
}

const titleCase = (s: string) =>
  s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

function classifyToken(tok: string): string | null {
  const t = tok.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower];
  const tc = titleCase(lower);
  if (KNOWN_COUNTRIES.has(tc)) return tc;
  if (US_STATES.has(lower)) return "United States";
  if (CITY_COUNTRY[lower]) return CITY_COUNTRY[lower];
  return null;
}

/** Standardize a free-form GitHub location string to a canonical country. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tokens = raw.split(/[,/|]|\s-\s/).map((s) => s.trim()).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const c = classifyToken(tokens[i]);
    if (c) return c;
  }
  for (const tok of tokens) {
    for (const w of tok.split(/\s+/)) {
      const c = classifyToken(w);
      if (c) return c;
    }
  }
  const joined = raw.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const key of Object.keys(CITY_COUNTRY)) {
    if (joined.includes(key)) return CITY_COUNTRY[key];
  }
  return null;
}

// --- phone dial codes ------------------------------------------------------

// Longest-prefix match wins, so multi-digit codes are listed and checked by
// descending length.
const DIAL_CODES: Record<string, string> = {
  "1": "United States", "44": "United Kingdom", "49": "Germany",
  "33": "France", "34": "Spain", "39": "Italy", "31": "Netherlands",
  "351": "Portugal", "48": "Poland", "380": "Ukraine", "90": "Turkey",
  "55": "Brazil", "54": "Argentina", "52": "Mexico", "57": "Colombia",
  "58": "Venezuela", "593": "Ecuador", "51": "Peru", "591": "Bolivia",
  "506": "Costa Rica", "507": "Panama", "502": "Guatemala",
  "505": "Nicaragua", "92": "Pakistan", "91": "India", "98": "Iran",
  "971": "United Arab Emirates", "20": "Egypt", "216": "Tunisia",
  "250": "Rwanda", "1876": "Jamaica", "63": "Philippines", "65": "Singapore",
  "60": "Malaysia", "84": "Vietnam", "886": "Taiwan", "998": "Uzbekistan",
  "61": "Australia", "64": "New Zealand", "30": "Greece", "40": "Romania",
  "359": "Bulgaria", "381": "Serbia", "382": "Montenegro", "383": "Kosovo",
  "385": "Croatia", "386": "Slovenia", "387": "Bosnia and Herzegovina",
  "389": "North Macedonia", "355": "Albania", "36": "Hungary",
  "420": "Czech Republic", "421": "Slovakia", "370": "Lithuania",
  "372": "Estonia", "373": "Moldova", "375": "Belarus", "358": "Finland",
  "46": "Sweden", "47": "Norway", "45": "Denmark", "353": "Ireland",
  "41": "Switzerland", "43": "Austria", "32": "Belgium", "94": "Sri Lanka",
  "995": "Georgia", "371": "Latvia", "352": "Luxembourg", "356": "Malta",
  "357": "Cyprus", "354": "Iceland", "374": "Armenia", "377": "Monaco",
  "376": "Andorra", "423": "Liechtenstein", "378": "San Marino",
};

/** Country from a phone number's international dial code (longest-prefix). */
export function countryFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (!digits.startsWith("+")) return null; // need explicit country code
  const num = digits.slice(1);
  for (let len = 4; len >= 1; len--) {
    const prefix = num.slice(0, len);
    if (DIAL_CODES[prefix]) return DIAL_CODES[prefix];
  }
  return null;
}

// --- commit offset ---------------------------------------------------------

/** "UTC-04:00"-style label from an offset in minutes. */
export function offsetToTz(offsetMin: number): string {
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

/** Current local time (minutes since midnight) in a resolved timezone, which
 *  is either an IANA name ("Europe/Kyiv") or a fixed "UTC±HH:MM". Returns null
 *  when the timezone is empty or unparseable (caller should fall back). */
export function localNowMinutes(
  timezone: string,
  at: Date = new Date(),
): number | null {
  if (!timezone) return null;
  if (timezone.startsWith("UTC")) {
    const m = /UTC([+-])(\d{2}):(\d{2})/.exec(timezone);
    if (!m) return null;
    const offMin = (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    const utcMin = at.getUTCHours() * 60 + at.getUTCMinutes();
    return ((utcMin + offMin) % 1440 + 1440) % 1440;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const mm = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    return (h % 24) * 60 + mm;
  } catch {
    return null;
  }
}

/** Is it currently within [startMin, endMin) in the given timezone? Returns
 *  true when the timezone is unknown, so unresolved contacts fall through to
 *  the sender's global window instead of being stranded. */
export function withinLocalWindow(
  timezone: string,
  startMin: number,
  endMin: number,
  at: Date = new Date(),
): boolean {
  const local = localNowMinutes(timezone, at);
  if (local == null) return true; // unknown tz -> caller's fallback governs
  if (startMin === endMin) return true;
  if (startMin < endMin) return local >= startMin && local < endMin;
  return local >= startMin || local < endMin; // window wraps midnight
}

// --- the combined resolver -------------------------------------------------

export function timezoneForCountry(country: string | null): string | null {
  return country ? (COUNTRY_TZ[country] ?? null) : null;
}

// Representative country for a UTC offset (minutes), used only as a last resort
// when a contact has no location/phone — a commit offset pins a timezone, not a
// country, so this picks the most likely developer-heavy country for that
// offset. Best-effort by design (an offset spans many countries).
const OFFSET_COUNTRY: Record<number, string> = {
  [-600]: "United States", // Hawaii
  [-540]: "United States", // Alaska
  [-480]: "United States", // Pacific
  [-420]: "United States", // Mountain
  [-360]: "United States", // Central
  [-300]: "United States", // Eastern
  [-240]: "United States", // Eastern (DST) / Atlantic
  [-180]: "Brazil", // Argentina/Brazil
  [0]: "United Kingdom",
  [60]: "Germany", // Central Europe
  [120]: "Ukraine", // Eastern Europe
  [180]: "Turkey", // also Moscow
  [210]: "Iran", // +3:30
  [240]: "United Arab Emirates",
  [300]: "Pakistan", // +5
  [330]: "India", // +5:30
  [345]: "Nepal", // +5:45
  [360]: "Bangladesh", // +6
  [420]: "Vietnam", // +7
  [480]: "China", // +8
  [540]: "Japan", // +9
  [600]: "Australia", // +10
  [720]: "New Zealand", // +12
};

/** Best-guess representative country for a commit UTC offset (minutes). Snaps
 *  to the nearest mapped offset within 45 minutes; null if nothing is close. */
export function countryFromUtcOffset(
  offsetMin: number | null | undefined,
): string | null {
  if (offsetMin == null || !Number.isFinite(offsetMin)) return null;
  if (OFFSET_COUNTRY[offsetMin]) return OFFSET_COUNTRY[offsetMin];
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const key of Object.keys(OFFSET_COUNTRY)) {
    const km = Number(key);
    const d = Math.abs(km - offsetMin);
    if (d < bestDiff) {
      bestDiff = d;
      best = OFFSET_COUNTRY[km];
    }
  }
  return bestDiff <= 45 ? best : null;
}

// --- target region (CSV import filter) -------------------------------------

// "All of Europe" for the CSV-import region filter: the EU-27 plus the rest of
// the continent we actually do outreach in. Deliberately excludes Russia and
// Belarus. Edit this one set to change who passes the filter.
export const EUROPE_COUNTRIES = new Set<string>([
  "Albania","Andorra","Austria","Belgium","Bosnia and Herzegovina","Bulgaria",
  "Croatia","Cyprus","Czech Republic","Denmark","Estonia","Finland","France",
  "Germany","Greece","Hungary","Iceland","Ireland","Italy","Kosovo","Latvia",
  "Liechtenstein","Lithuania","Luxembourg","Malta","Moldova","Monaco",
  "Montenegro","Netherlands","North Macedonia","Norway","Poland","Portugal",
  "Romania","San Marino","Serbia","Slovakia","Slovenia","Spain","Sweden",
  "Switzerland","Turkey","Ukraine","United Kingdom",
]);

/** Does this (canonical) country pass the outreach region filter — the US,
 *  Canada, or anywhere in Europe? */
export function isTargetRegion(country: string | null | undefined): boolean {
  if (!country) return false;
  const canon = KNOWN_COUNTRIES.has(country)
    ? country
    : (normalizeCountry(country) ?? "");
  if (!canon) return false;
  return (
    canon === "United States" || canon === "Canada" || EUROPE_COUNTRIES.has(canon)
  );
}

export type CountryDecision = {
  country: string;
  source: "csv" | "github" | "phone";
};

/** Decide a contact's country for the region filter, strongest signal first:
 *  the CSV column, then the GitHub profile location, then a phone dial code.
 *  Returns null when nothing resolves — a commit UTC offset is deliberately
 *  NOT accepted here (an offset spans many countries, so it's too weak to
 *  filter on; it still feeds timezone scheduling via resolveLocation). */
export function decideCountry(input: {
  csvCountry?: string | null;
  githubLocation?: string | null;
  phones?: string[];
}): CountryDecision | null {
  const fromCsv = normalizeCountry(input.csvCountry);
  if (fromCsv) return { country: fromCsv, source: "csv" };
  const fromGithub = normalizeCountry(input.githubLocation);
  if (fromGithub) return { country: fromGithub, source: "github" };
  for (const p of input.phones ?? []) {
    const c = countryFromPhone(p);
    if (c) return { country: c, source: "phone" };
  }
  return null;
}

export function resolveLocation(input: {
  commitOffsetMin?: number | null;
  phones?: string[];
  location?: string | null;
}): ResolvedLocation {
  // Country: phone dial code first (exact), then the GitHub location.
  let country = "";
  for (const p of input.phones ?? []) {
    const c = countryFromPhone(p);
    if (c) {
      country = c;
      break;
    }
  }
  if (!country) country = normalizeCountry(input.location) ?? "";

  // Timezone: the commit offset is the strongest signal (their real working
  // hours), then country -> representative zone. When the profile gave us no
  // country, fall back to a best-guess country from that same offset so blank
  // profiles still get a flag/label (timezone stays the exact offset).
  if (input.commitOffsetMin != null && Number.isFinite(input.commitOffsetMin)) {
    const hadCountry = country !== "";
    if (!hadCountry) country = countryFromUtcOffset(input.commitOffsetMin) ?? "";
    return {
      country,
      timezone: offsetToTz(input.commitOffsetMin),
      source: "commit",
      // Exact when country came from phone/location; a guess when derived from
      // the offset alone.
      confidence: hadCountry ? "high" : "low",
    };
  }
  const tz = timezoneForCountry(country);
  if (tz) {
    // A phone-derived country is exact; a location-derived one is heuristic.
    const fromPhone = (input.phones ?? []).some((p) => countryFromPhone(p));
    return {
      country,
      timezone: tz,
      source: fromPhone ? "phone" : "location",
      confidence: fromPhone ? "high" : "medium",
    };
  }
  return { country, timezone: "", source: "none", confidence: "none" };
}
