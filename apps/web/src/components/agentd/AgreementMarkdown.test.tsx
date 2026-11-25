import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgreementMarkdown } from "./AgreementMarkdown";

// Shaped like agentd's EULA.md: numbered headings, bold clause labels, lettered items, code spans.
const AGREEMENT = `# LibraOS End User Agreement

Version 3.5 of November 13, 2026.

## 1. Acceptance, Parties, and Authority

1.1. **Parties.** This End User Agreement (the "**Agreement**") is a contract between you and Nebula Nova Inc. ("**we**" or "**us**").

1.2. **Acceptance.** For LibraOS Engine, we ask when you set it up with \`libraos-engine init\`, before it runs any work (Section 5.3 & 13.4).

### 1.3. Authority

(a) You are at least 18; (b) you may bind your organization.

## 2. Licence

2.1. **Grant.** Subject to this Agreement, we grant you a licence < 2 years > 0.
`;

const render = (text: string) =>
  renderToStaticMarkup(<AgreementMarkdown text={text} />).replace(/^<div[^>]*>|<\/div>$/g, "");

const textOf = (html: string) =>
  html
    .replace(/<\/(h\d|p)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe("AgreementMarkdown", () => {
  it("renders headings at their levels and bold labels", () => {
    const html = render(AGREEMENT);
    expect(html).toContain("<h3");
    expect(html).toMatch(/<h3[^>]*>LibraOS End User Agreement<\/h3>/);
    expect(html).toMatch(/<h4[^>]*>1\. Acceptance, Parties, and Authority<\/h4>/);
    expect(html).toMatch(/<h5[^>]*>1\.3\. Authority<\/h5>/);
    expect(html).toContain("<strong>Parties.</strong>");
    expect(html).toContain("<strong>Agreement</strong>");
    expect(html).not.toMatch(/##|\*\*/);
  });

  it("keeps the wording, order and numbering of the source", () => {
    const sourceWithoutMarks = AGREEMENT.replace(/^#+ /gm, "").replace(/\*\*|`/g, "");
    expect(words(textOf(render(AGREEMENT)))).toEqual(words(sourceWithoutMarks));
  });

  it("renders no raw HTML from the agreement", () => {
    const html = render(
      [
        "## 1. Terms",
        "",
        '<script>alert("x")</script>',
        "",
        'Text <img src="x" onerror="alert(1)"> and <b onclick="alert(2)">bold</b>.',
        "",
        '<div><iframe src="https://example.com"></iframe></div>',
        "",
        "![tracker](https://example.com/p.png) [link](javascript:alert(3))",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(script|img|iframe|div|b)\b/i);
    expect(html).not.toMatch(/onerror|onclick|javascript:/i);
    expect(html).not.toContain("alert(");
  });
});
