/**
 * The one syntax highlighter this app uses.
 *
 * WHY THIS MODULE EXISTS: `import { Prism } from 'react-syntax-highlighter'` —
 * which ConversationViewer and MemoryExplorer each did — pulls the FULL refractor
 * bundle, every language Prism supports, into the main chunk. It was the single
 * largest thing in a 1.5MB bundle that a visitor downloaded before the sign-in
 * form could paint. `prism-light` ships the engine only, and each language is
 * registered by hand below.
 *
 * The list is not a guess. It is exactly what `getLanguage()` in
 * ConversationViewer can return, plus the fence languages a transcript actually
 * carries. An unregistered language is NOT an error: PrismLight renders it as
 * plain text, so a rare fence loses colour and nothing else.
 *
 * Both call sites import from here rather than from the package, so the
 * registration cannot drift between them.
 */
import { PrismLight } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import zig from 'react-syntax-highlighter/dist/esm/languages/prism/zig';

/* Canonical names, then the aliases the call sites actually pass. `getLanguage`
 * returns 'dockerfile' and 'html'; Prism calls those 'docker' and 'markup'. A
 * missing alias is a silently unhighlighted block, so both are registered. */
const LANGUAGES: Record<string, unknown> = {
  bash, c, cpp, css, diff, docker, go, javascript, json, jsx, markdown, markup,
  python, ruby, rust, sql, tsx, typescript, yaml, zig,
  dockerfile: docker,
  html: markup,
  sh: bash,
  shell: bash,
  js: javascript,
  ts: typescript,
  py: python,
  rs: rust,
  yml: yaml,
  md: markdown,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  PrismLight.registerLanguage(name, definition);
}

export { PrismLight as SyntaxHighlighter };
export { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
