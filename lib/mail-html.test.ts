// The HTML part of every send. Outlook renders HTML with Word, which ignores
// CSS whitespace — these pin that line structure is real markup.

import { describe, it, expect } from "vitest";
import { textToEmailHtml } from "./mail-html";

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
});
