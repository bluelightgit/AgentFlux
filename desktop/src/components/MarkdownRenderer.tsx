/**
 * MarkdownRenderer — wraps `react-markdown` with the `remark-gfm` plugin.
 *
 * Renders GFM-flavoured markdown (tables, strikethrough, task lists, autolinks)
 * with Tailwind styles that work in both light and dark mode.
 *
 * Props:
 *   - content:  markdown source string
 *   - className: optional extra classes applied to the wrapper
 *
 * Empty / blank content returns null — safe to render unconditionally.
 */
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps): React.ReactElement | null {
  if (!content || !content.trim()) return null;

  return (
    <div
      className={
        "text-sm leading-relaxed text-slate-700 dark:text-slate-200 " +
        (className ?? "")
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node, ...props }) => (
            <h1
              className="mt-4 mb-2 text-xl font-bold text-slate-800 dark:text-slate-100"
              {...props}
            />
          ),
          h2: ({ node, ...props }) => (
            <h2
              className="mt-3 mb-2 text-lg font-bold text-slate-800 dark:text-slate-100"
              {...props}
            />
          ),
          h3: ({ node, ...props }) => (
            <h3
              className="mt-3 mb-1 text-base font-semibold text-slate-800 dark:text-slate-100"
              {...props}
            />
          ),
          h4: ({ node, ...props }) => (
            <h4
              className="mt-2 mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100"
              {...props}
            />
          ),
          h5: ({ node, ...props }) => (
            <h5
              className="mt-2 mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200"
              {...props}
            />
          ),
          h6: ({ node, ...props }) => (
            <h6
              className="mt-2 mb-1 text-xs font-semibold uppercase text-slate-600 dark:text-slate-300"
              {...props}
            />
          ),
          p: ({ node, ...props }) => (
            <p className="my-2 first:mt-0 last:mb-0" {...props} />
          ),
          a: ({ node, ...props }) => (
            <a
              className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            />
          ),
          ul: ({ node, ...props }) => (
            <ul
              className="my-2 ml-5 list-disc space-y-1"
              {...props}
            />
          ),
          ol: ({ node, ...props }) => (
            <ol
              className="my-2 ml-5 list-decimal space-y-1"
              {...props}
            />
          ),
          li: ({ node, ...props }) => <li {...props} />,
          blockquote: ({ node, ...props }) => (
            <blockquote
              className="my-2 border-l-4 border-slate-200 bg-slate-50 px-3 py-1 text-slate-600 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300"
              {...props}
            />
          ),
          hr: ({ node, ...props }) => (
            <hr
              className="my-4 border-t border-slate-200 dark:border-slate-700"
              {...props}
            />
          ),
          table: ({ node, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table
                className="w-full border-collapse text-sm"
                {...props}
              />
            </div>
          ),
          thead: ({ node, ...props }) => <thead {...props} />,
          tbody: ({ node, ...props }) => <tbody {...props} />,
          tr: ({ node, ...props }) => (
            <tr
              className="border-t border-slate-200 dark:border-slate-700"
              {...props}
            />
          ),
          th: ({ node, ...props }) => (
            <th
              className="border border-slate-200 bg-slate-100 px-2 py-1 text-left font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              {...props}
            />
          ),
          td: ({ node, ...props }) => (
            <td
              className="border border-slate-200 px-2 py-1 text-slate-700 dark:border-slate-700 dark:text-slate-300"
              {...props}
            />
          ),
          code: ({ node, className: codeClass, children, ...props }: any) => {
            // Block code: react-markdown wraps in <pre><code class="language-x">.
            // Inline code: no language class & not inside a <pre>.
            const isBlock =
              typeof codeClass === "string" && codeClass.startsWith("language-");
            if (isBlock) {
              return (
                <code
                  className={`block rounded-md bg-slate-100 px-3 py-2 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200 ${codeClass ?? ""}`}
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ node, ...props }) => (
            <pre
              className="my-2 overflow-x-auto rounded-md bg-slate-100 p-3 dark:bg-slate-800"
              {...props}
            />
          ),
          strong: ({ node, ...props }) => (
            <strong
              className="font-semibold text-slate-800 dark:text-slate-100"
              {...props}
            />
          ),
          em: ({ node, ...props }) => (
            <em className="italic text-slate-700 dark:text-slate-200" {...props} />
          ),
          del: ({ node, ...props }) => (
            <del className="text-slate-500 line-through dark:text-slate-400" {...props} />
          ),
          input: ({ node, ...props }) => (
            <input
              className="mr-1 align-middle"
              type="checkbox"
              disabled
              {...props}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownRenderer;
