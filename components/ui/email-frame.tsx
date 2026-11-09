"use client";

import { useRef, useState } from "react";

/** A finished email's HTML, shown the way a mail client would. Sandboxed:
 *  pasted signature HTML can't run scripts in the app, and its styles stay
 *  inside the frame. Same-origin (still without scripts) only so the frame can
 *  be sized to its content. Always white, like an email client. */
export function EmailFrame({
  html,
  title,
  minHeight = 24,
  maxHeight = 400,
  className = "",
}: {
  html: string;
  title: string;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(Math.max(minHeight, 48));
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(Math.max(doc.body.scrollHeight, minHeight), maxHeight));
  };
  return (
    // The padding sits on the frame element, outside the rendered email.
    // Literal white, not `bg-white`: the light theme mirrors the palette, which
    // turns Tailwind's `white` into ink. Light color-scheme so a dark app theme
    // can't paint a dark canvas behind the email either.
    <div
      className={"rounded-lg border border-white/10 px-3.5 py-3 " + className}
      style={{ background: "#ffffff", colorScheme: "light" }}
    >
      <iframe
        ref={ref}
        title={title}
        sandbox="allow-same-origin"
        srcDoc={html}
        onLoad={fit}
        style={{ height, background: "#ffffff", colorScheme: "light" }}
        className="block w-full border-0"
      />
    </div>
  );
}
