"use client";

import { useState } from "react";
import { countryIso2 } from "@/lib/country";

// Small country flag rendered as an image (flagcdn) rather than an emoji:
// regional-indicator flag emoji don't render as glyphs on Windows Chrome/Edge,
// so an image keeps the flag visible everywhere the app runs. Renders nothing
// when the country can't be mapped to an ISO code (e.g. blank/"-").

export function CountryFlag({
  country,
  size = 14,
  className = "",
  title,
}: {
  country: string | null | undefined;
  /** Flag height in px; width follows the flag's own aspect ratio. */
  size?: number;
  className?: string;
  title?: string;
}) {
  const iso = countryIso2(country);
  const [failed, setFailed] = useState(false);
  if (!iso || failed) return null;
  const code = iso.toLowerCase();
  return (
    <img
      src={`https://flagcdn.com/h40/${code}.png`}
      alt={country ?? ""}
      title={title ?? country ?? undefined}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={"inline-block shrink-0 rounded-[2px] ring-1 ring-black/20 " + className}
      style={{ height: size, width: "auto" }}
    />
  );
}
