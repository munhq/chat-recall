import { describe, test, expect } from 'vitest';
import {
  parseFrontmatter, stringifyFrontmatter, parseScalarToml, stringifyScalarToml,
} from './toolkit-format.js';

describe('frontmatter', () => {
  test('splits scalars and body', () => {
    const { fm, body } = parseFrontmatter('---\nname: x\ndescription: hi there\n---\nthe body\nline 2');
    expect(fm.name).toBe('x');
    expect(fm.description).toBe('hi there');
    expect(body).toBe('the body\nline 2');
  });
  test('no frontmatter → whole text is body', () => {
    const { fm, body } = parseFrontmatter('just text');
    expect(Object.keys(fm)).toHaveLength(0);
    expect(body).toBe('just text');
  });
  test('round-trips through stringify', () => {
    const doc = stringifyFrontmatter({ name: 'a', description: 'b' }, 'body');
    const { fm, body } = parseFrontmatter(doc);
    expect(fm.name).toBe('a');
    expect(body.trim()).toBe('body');
  });
});

describe('scalar TOML', () => {
  test('parses single-line quoted scalars', () => {
    const t = parseScalarToml('name = "foo"\ndescription = "a desc"');
    expect(t.name).toBe('foo');
    expect(t.description).toBe('a desc');
  });
  test('parses multi-line triple-quoted prompt', () => {
    const t = parseScalarToml('description = "d"\nprompt = """\nline one\nline two\n"""\n');
    expect(t.description).toBe('d');
    expect(t.prompt).toBe('line one\nline two');
  });
  test('stops at first [table]', () => {
    const t = parseScalarToml('name = "x"\n[mcp_servers.foo]\ncommand = "bar"');
    expect(t.name).toBe('x');
    expect(t.command).toBeUndefined();
  });
  test('round-trips multi-line through stringify', () => {
    const src = { description: 'd', prompt: 'a\nb\nc' };
    const back = parseScalarToml(stringifyScalarToml(src));
    expect(back.prompt).toBe('a\nb\nc');
    expect(back.description).toBe('d');
  });
});
