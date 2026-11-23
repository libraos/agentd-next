import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";

// The agreement comes from the agentd binary, not from us: raw HTML is dropped and only text
// elements render, so neither a script nor an image request can reach the dialog.
const ALLOWED_ELEMENTS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "strong",
  "em",
  "code",
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "br",
  "a",
];

// The dialog owns the page's top headings, so the agreement's `#` starts at h3.
const heading = (level: number, className: string) => {
  const Tag = `h${Math.min(level + 2, 6)}` as "h3";
  return ({ node: _node, ...props }: ComponentProps<"h1"> & ExtraProps) => (
    <Tag className={className} {...props} />
  );
};

const COMPONENTS: Components = {
  h1: heading(1, "mb-2 text-sm font-semibold"),
  h2: heading(2, "mt-3 mb-1.5 text-xs font-semibold"),
  h3: heading(3, "mt-2 mb-1 text-xs font-semibold"),
  h4: heading(4, "mt-2 mb-1 text-xs font-medium"),
  h5: heading(5, "mt-2 mb-1 text-xs font-medium"),
  h6: heading(6, "mt-2 mb-1 text-xs font-medium"),
  p: ({ node: _node, ...props }) => <p className="mb-2 wrap-anywhere" {...props} />,
  code: ({ node: _node, ...props }) => (
    <code className="rounded bg-muted px-1 font-mono" {...props} />
  ),
  ul: ({ node: _node, ...props }) => <ul className="mb-2 list-disc ps-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="mb-2 list-decimal ps-5" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="underline" target="_blank" rel="noopener noreferrer" {...props} />
  ),
};

export function AgreementMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="text-xs">
      <ReactMarkdown
        skipHtml
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
