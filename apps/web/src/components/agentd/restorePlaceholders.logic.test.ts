import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { toHtml } from "hast-util-to-html";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { expect, it } from "vite-plus/test";

import {
  hasPlaceholders,
  restorePlaceholderPlugins,
  restorePlaceholders,
} from "./restorePlaceholders.logic";

const MAP = { "[PERSON_1]": "Maren Holloway", "[PERSON_10]": "Jonas Brekke", "[ORG_1]": "A&B Ltd" };

it("copies a reply with the originals in place of the placeholders", () => {
  expect(restorePlaceholders("[PERSON_10] pays [PERSON_1] for [ORG_1].", MAP)).toBe(
    "Jonas Brekke pays Maren Holloway for A&B Ltd.",
  );
  expect(restorePlaceholders("[PERSON_2] is unknown", MAP)).toBe("[PERSON_2] is unknown");
  expect(restorePlaceholders("[PERSON_1]", null)).toBe("[PERSON_1]");
  expect(hasPlaceholders("plain", MAP)).toBe(false);
  expect(hasPlaceholders("ask [ORG_1]", MAP)).toBe(true);
});

it("renders prose placeholders as marked originals through the chat sanitizer, and leaves code", async () => {
  const processor = unified()
    .use(remarkParse)
    .use(restorePlaceholderPlugins(MAP))
    .use(remarkRehype)
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = await processor.run(
    processor.parse("**[PERSON_1]** owes [ORG_1]; see `[PERSON_1]`."),
  );
  expect(toHtml(tree)).toBe(
    '<p><strong><span data-agentd-restored="[PERSON_1]">Maren Holloway</span></strong> owes ' +
      '<span data-agentd-restored="[ORG_1]">A&#x26;B Ltd</span>; see <code>[PERSON_1]</code>.</p>',
  );
  expect(restorePlaceholderPlugins(MAP)).toBe(restorePlaceholderPlugins(MAP));
});
