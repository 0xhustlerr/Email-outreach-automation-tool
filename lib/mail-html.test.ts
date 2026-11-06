// The HTML part of every send. Outlook renders HTML with Word, which ignores
// CSS whitespace — these pin that line structure is real markup.

import { describe, it, expect } from "vitest";
import { htmlToText, isHtmlSignature, renderSignature, textToEmailHtml } from "./mail-html";

const ann = { name: "Ann Lee", email: "ann@example.com" };

const paragraphs = (html: string) => html.match(/<p [^>]*>[\s\S]*?<\/p>/g) ?? [];

describe("textToEmailHtml", () => {
  it("turns blank-line-separated blocks into separate paragraphs", () => {
    const html = textToEmailHtml("Hi Lamar,\n\nThis is Paolo.\n\nBest,\nPaolo");
    expect(paragraphs(html)).toHaveLength(3);
  });

  it("turns a single newline into <br>", () => {
    const html = textToEmailHtml("Best,\nPaolo Santos");
    expect(html).toContain("Best,<br>\nPaolo Santos");
  });

  it("gives the same output for CRLF and LF input", () => {
    expect(textToEmailHtml("a\r\n\r\nb\r\nc")).toBe(textToEmailHtml("a\n\nb\nc"));
  });

  it("treats whitespace-only lines as paragraph breaks", () => {
    expect(paragraphs(textToEmailHtml("a\n  \nb"))).toHaveLength(2);
  });

  it("escapes HTML and quotes", () => {
    const html = textToEmailHtml(`<b>"x" & 'y'</b>`);
    expect(html).toContain("&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  });

  it("links URLs and leaves trailing punctuation outside the link", () => {
    const html = textToEmailHtml("See https://github.com/0xhustlerr. Thanks");
    expect(html).toContain('<a href="https://github.com/0xhustlerr" ');
    expect(html).toContain(">https://github.com/0xhustlerr</a>. Thanks");
  });

  it("keeps runs of spaces", () => {
    expect(textToEmailHtml("a   b")).toContain("a &nbsp;&nbsp;b");
  });

  it("appends the tracking pixel only when a URL is given", () => {
    expect(textToEmailHtml("hi")).not.toContain("<img");
    const html = textToEmailHtml("hi", "https://t.example/p?id=1&x=2");
    expect(html).toContain('<img src="https://t.example/p?id=1&amp;x=2"');
  });

  it("never relies on CSS whitespace handling", () => {
    expect(textToEmailHtml("a\nb\n\nc")).not.toMatch(/white-space/);
  });

  it("puts the signature after the body and before the tracking pixel", () => {
    const html = textToEmailHtml("Body", "https://t.example/p", renderSignature("Ann", ann).html);
    const body = html.indexOf("Body");
    const sig = html.indexOf("gmail_signature");
    const pixel = html.indexOf("<img");
    expect(body).toBeLessThan(sig);
    expect(sig).toBeLessThan(pixel);
  });
});

describe("renderSignature", () => {
  it("tells markup from an address in angle brackets", () => {
    expect(isHtmlSignature("<div>Ann</div>")).toBe(true);
    expect(isHtmlSignature("Ann<br>Lee")).toBe(true);
    expect(isHtmlSignature("Ann Lee <ann@example.com>")).toBe(false);
    expect(isHtmlSignature("Ann Lee\nFounder")).toBe(false);
  });

  it("lays out a plain-text signature like the body, links included", () => {
    const { html, text } = renderSignature("{{sender}}\r\nhttps://acme.com", ann);
    expect(html).toContain("Ann Lee<br>\n");
    expect(html).toContain('<a href="https://acme.com"');
    expect(text).toBe("Ann Lee\nhttps://acme.com");
  });

  it("inserts an HTML signature untouched, with a readable text version", () => {
    const sig = '<div dir="ltr"><b>Ann</b> <img src="https://x/logo.png"></div>';
    const { html, text } = renderSignature(sig, ann);
    expect(html).toContain(sig);
    expect(text).toBe("Ann");
  });

  it("escapes the sender in an HTML signature", () => {
    const { html } = renderSignature("<p>{{sender}}</p>", { ...ann, name: "Ann & <Co>" });
    expect(html).toContain("<p>Ann &amp; &lt;Co&gt;</p>");
  });

  it("keeps a plain-text signature plain even when the sender name looks like a tag", () => {
    const { html, text } = renderSignature("{{sender}}", { ...ann, name: "Ann <b>" });
    expect(html).toContain("Ann &lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(text).toBe("Ann <b>");
  });

  it("is empty for a blank signature", () => {
    expect(renderSignature("  \n ", ann)).toEqual({ html: "", text: "" });
  });
});

describe("htmlToText", () => {
  it("turns block elements and <br> into line breaks", () => {
    expect(htmlToText("<div>Ann Lee</div><div>Founder<br>Acme</div>")).toBe(
      "Ann Lee\nFounder\nAcme",
    );
  });

  it("treats source newlines as spaces", () => {
    expect(htmlToText("<p>Ann\n  Lee</p>")).toBe("Ann Lee");
  });

  it("keeps link URLs, but not twice and not for mailto", () => {
    expect(htmlToText('<a href="https://acme.com">Acme</a>')).toBe("Acme <https://acme.com>");
    expect(htmlToText('<a href="https://acme.com">https://acme.com</a>')).toBe("https://acme.com");
    expect(htmlToText('<a href="mailto:ann@acme.com">ann@acme.com</a>')).toBe("ann@acme.com");
  });

  it("drops images, styles and comments", () => {
    expect(
      htmlToText('<style>p{color:red}</style><!-- x --><a href="https://acme.com"><img src="l.png"></a>Ann'),
    ).toBe("Ann");
  });

  it("decodes entities", () => {
    expect(htmlToText("Ann&nbsp;Lee &amp; Co &#8212; &#x2022; &lt;3")).toBe("Ann Lee & Co — • <3");
  });

  it("collapses runs of blank lines", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><div><br></div><p>b</p>")).toBe("a\n\nb");
  });
});
