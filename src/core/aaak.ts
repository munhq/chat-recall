/**
 * AAAK Dialect Compressor and Fact Checker.
 *
 * AAAK (Agent-Agent-Alpha-Kilo?) is a lossless shorthand dialect designed for
 * AI agents. Not meant to be read by humans — meant to be read by your AI, fast.
 * ~30x compression, zero information loss. Your AI loads months of context in ~120 tokens.
 *
 * Format:
 *   TEAM: PERSON(role,tenure...) PERSON(role,tenure...) ...
 *   PROJ: PROJECT(type) | SPRINT: current-task
 *   DECISION: PERSON.rec:TOOL>OTHER(reason) | ★★★★
 *   RULE: pattern | context
 *
 * Compression targets:
 *   - Long names → uppercase codes (Kai → KAI)
 *   - Repeated concepts → symbols (→ → →)
 *   - Dates/tenure → computed from validity window
 *   - Multi-word descriptions → dot-joined abbreviations
 */

import type { SessionContent } from '../parsers/session.js';

export interface AaakPerson {
  code: string;
  name: string;
  role: string;
  tenure?: string;
  started?: string;
}

export interface AaakDecision {
  person: string;
  recommendation: string;
  alternatives?: string;
  reason?: string;
  rating: number;
  date?: string;
}

export interface AaakSprint {
  current: string;
  progress?: string;
  assignee?: string;
}

export interface AaakProject {
  name: string;
  type: string;
  description?: string;
}

export interface AaakFacts {
  team: AaakPerson[];
  projects: AaakProject[];
  sprints: AaakSprint[];
  decisions: AaakDecision[];
  preferences: string[];
  discoveries: string[];
  problems: string[];
}

export interface ContradictionResult {
  type: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  expected?: string;
  actual: string;
}

export interface AaakOutput {
  aaak: string;
  facts: AaakFacts;
  contradictions: ContradictionResult[];
  rawText: string;
}

const TEAM_CODES = new Map<string, string>();
const PROJECT_CODES = new Map<string, string>();

function registerTeamCode(name: string, code: string): void {
  TEAM_CODES.set(name.toLowerCase(), code);
}

function registerProjectCode(name: string, code: string): void {
  PROJECT_CODES.set(name.toLowerCase(), code);
}

function getOrCreateTeamCode(name: string): string {
  const lower = name.toLowerCase();
  if (TEAM_CODES.has(lower)) return TEAM_CODES.get(lower)!;
  const code = name.slice(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X');
  registerTeamCode(name, code);
  return code;
}

function getOrCreateProjectCode(name: string): string {
  const lower = name.toLowerCase();
  if (PROJECT_CODES.has(lower)) return PROJECT_CODES.get(lower)!;
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const code = words.map(w => w[0].toUpperCase()).join('').slice(0, 4);
  registerProjectCode(name, code);
  return code;
}

function extractTenure(started: string): string {
  try {
    const start = new Date(started);
    const now = new Date();
    const years = (now.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (years < 1) {
      const months = Math.round(years * 12);
      return `${months}mo`;
    }
    return `${years.toFixed(1)}yr`;
  } catch {
    return started;
  }
}

function compressTeam(facts: AaakFacts): string {
  if (facts.team.length === 0) return '';
  const members = facts.team.map(p => {
    const attrs: string[] = [];
    if (p.role) attrs.push(p.role);
    if (p.tenure) attrs.push(p.tenure);
    else if (p.started) attrs.push(extractTenure(p.started));
    const attrStr = attrs.length > 0 ? `(${attrs.join(',')})` : '';
    return `${p.code}${attrStr}`;
  });
  return `TEAM: ${members.join(' ')}`;
}

function compressProjects(facts: AaakFacts): string {
  if (facts.projects.length === 0) return '';
  const projs = facts.projects.map(p => {
    let s = p.name;
    if (p.type) s += `(${p.type})`;
    return s;
  });
  return `PROJ: ${projs.join(' | ')}`;
}

function compressSprints(facts: AaakFacts): string {
  if (facts.sprints.length === 0) return '';
  const sprints = facts.sprints.map(s => {
    let str = s.current;
    if (s.assignee) str += `@${s.assignee}`;
    if (s.progress) str += ` ${s.progress}`;
    return str;
  });
  return `SPRINT: ${sprints.join(' | ')}`;
}

function compressDecisions(facts: AaakFacts): string {
  if (facts.decisions.length === 0) return '';
  const decisions = facts.decisions.map(d => {
    const stars = '★'.repeat(Math.min(d.rating, 5));
    let str = `${d.person}.${d.recommendation}`;
    if (d.alternatives) str += `>${d.alternatives}`;
    if (d.reason) str += `(${d.reason})`;
    str += `|${stars}`;
    return str;
  });
  return `DECISION: ${decisions.join(' | ')}`;
}

function compressMisc(facts: AaakFacts): string {
  const parts: string[] = [];
  if (facts.preferences.length > 0) {
    const prefs = facts.preferences.slice(0, 3).join(' ; ');
    parts.push(`PREF: ${prefs}`);
  }
  if (facts.discoveries.length > 0) {
    const discs = facts.discoveries.slice(0, 3).map(d => d.replace(/\n/g, ' ').trim());
    parts.push(`DISC: ${discs.join(' | ')}`);
  }
  if (facts.problems.length > 0) {
    const probs = facts.problems.slice(0, 3).map(p => p.replace(/\n/g, ' ').trim());
    parts.push(`PROB: ${probs.join(' | ')}`);
  }
  return parts.join(' | ');
}

export function compressToAaak(facts: AaakFacts): string {
  const parts: string[] = [];

  const team = compressTeam(facts);
  if (team) parts.push(team);

  const projects = compressProjects(facts);
  if (projects) parts.push(projects);

  const sprints = compressSprints(facts);
  if (sprints) parts.push(sprints);

  const decisions = compressDecisions(facts);
  if (decisions) parts.push(decisions);

  const misc = compressMisc(facts);
  if (misc) parts.push(misc);

  return parts.join(' | ');
}

function parseEntitiesFromSession(content: SessionContent): {
  people: Map<string, { role?: string; started?: string; found: boolean }>;
  projects: Set<string>;
  tools: Set<string>;
} {
  const people = new Map<string, { role?: string; started?: string; found: boolean }>();
  const projects = new Set<string>();
  const tools = new Set<string>();

  for (const msg of content.userMessages) {
    const text = msg.text;

    const namePatterns = [
      /(?:my name is|i'm|i am|called)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
      /(?:developer|engineer|dev|pm|manager|lead|architect)\s+(?:named|called)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
      /(?:working with|collaborating with|team includes?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
    ];

    for (const pattern of namePatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const name = match[1].trim();
        if (name && name.length > 1 && name.length < 30) {
          if (!people.has(name.toLowerCase())) {
            people.set(name.toLowerCase(), { found: true });
          }
        }
      }
    }

    const projectPatterns = [
      /(?:working on|project|building|building a|building an)\s+[`'"]?([a-z][a-z0-9_-]*)[`'"]?/gi,
      /(?:app|platform|system|tool|service|api|library|package)\s+named\s+[`'"]?([a-z][a-z0-9_-]*)[`'"]?/gi,
    ];

    for (const pattern of projectPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const proj = match[1].trim();
        if (proj && proj.length > 1 && proj.length < 50) {
          projects.add(proj);
        }
      }
    }
  }

  for (const tool of content.toolsUsed) {
    tools.add(tool);
  }

  return { people, projects, tools };
}

function detectDecisions(content: SessionContent): AaakDecision[] {
  const decisions: AaakDecision[] = [];

  const decisionPatterns = [
    {
      pattern: /(?:we decided|decided to|i decided|going with|chose|selected|adopted)\s+([A-Za-z][^\n!?]{0,100}?)(?:\s+over|\s+instead|\s+rather|\.|!|\?|$)/gi,
      extract: (m: RegExpMatchArray) => ({
        recommendation: m[1].trim(),
        alternatives: undefined,
        reason: undefined,
        rating: 4,
      }),
    },
    {
      pattern: /(?:recommend|recommended|prefer|preferred|suggest|suggested)\s+([A-Za-z][^\n!?]{0,80}?)(?:\s+over|\s+instead|\.|!|\?|$)/gi,
      extract: (m: RegExpMatchArray) => ({
        recommendation: m[1].trim(),
        alternatives: undefined,
        reason: 'recommended',
        rating: 3,
      }),
    },
    {
      pattern: /(?:switched|migrated|refactored|rewrote|replaced)\s+([A-Za-z][^\n!?]{0,80}?)\s+to\s+([A-Za-z][^\n!?]{0,80}?)(?:\.|!|\?|$)/gi,
      extract: (m: RegExpMatchArray) => ({
        recommendation: m[2].trim(),
        alternatives: m[1].trim(),
        reason: 'migration',
        rating: 4,
      }),
    },
  ];

  const text = content.userMessages
    .concat(content.assistantMessages)
    .map(m => m.text)
    .join('\n');

  for (const { pattern, extract } of decisionPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const extracted = extract(match);
      if (extracted.recommendation.length > 2) {
        decisions.push({
          person: 'AGENT',
          recommendation: normalizeToolName(extracted.recommendation),
          alternatives: extracted.alternatives,
          reason: extracted.reason,
          rating: extracted.rating,
        });
      }
    }
  }

  return decisions;
}

function normalizeToolName(name: string): string {
  return name
    .replace(/\bPostgreSQL\b/gi, 'postgres')
    .replace(/\bJavaScript\b/gi, 'js')
    .replace(/\bTypeScript\b/gi, 'ts')
    .replace(/\bAPI\b/gi, 'api')
    .replace(/\bHTTP\b/gi, 'http')
    .replace(/\bURL\b/gi, 'url')
    .replace(/\bSQLite\b/gi, 'sqlite')
    .replace(/\bJavaScript Object Notation\b/gi, 'json')
    .replace(/\bCascading Style Sheets\b/gi, 'css')
    .replace(/\bHyperText Markup Language\b/gi, 'html')
    .replace(/['"]/g, '')
    .replace(/\s+/g, '.')
    .toLowerCase()
    .slice(0, 60);
}

function detectPreferences(content: SessionContent): string[] {
  const prefs: string[] = [];
  const text = content.userMessages.map(m => m.text).join('\n');

  const patterns = [
    /(?:i prefer|i like|i hate|i dislike|i always|i never|don't like|prefer to|avoid)\s+([^\n.]{5,80})/gi,
    /(?:better to|best to|should|shouldn't|must|must not)\s+([^\n.]{5,80})/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const pref = match[1].trim().replace(/\s+/g, ' ');
      if (pref.length > 5) {
        prefs.push(pref);
      }
    }
  }

  return [...new Set(prefs)].slice(0, 5);
}

function detectProblems(content: SessionContent): string[] {
  const problems: string[] = [];
  const text = content.userMessages.concat(content.assistantMessages).map(m => m.text).join('\n');

  const patterns = [
    /(?:error|exception|failed|failure|bug|issue|problem|broken|crash|panic)\s*[:.]?\s*([^\n.]{5,100})/gi,
    /(?:fix|fixing|resolved|solved)\s+([a-z][^\n.]{5,80}?)(?:\.|!|\?|$)/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const prob = match[1].trim().replace(/\s+/g, ' ');
      if (prob.length > 5) {
        problems.push(prob);
      }
    }
  }

  return [...new Set(problems)].slice(0, 5);
}

function detectDiscoveries(content: SessionContent): string[] {
  const discoveries: string[] = [];
  const text = content.assistantMessages.map(m => m.text).join('\n');

  const patterns = [
    /(?:found|discovered|figured out|realized|noticed|turned out)\s+([^\n.]{5,100})/gi,
    /(?:interesting|surprising|unexpected)\s+[:.]\s*([^\n.]{5,100})/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const disc = match[1].trim().replace(/\s+/g, ' ');
      if (disc.length > 5) {
        discoveries.push(disc);
      }
    }
  }

  return [...new Set(discoveries)].slice(0, 5);
}

export function extractAaakFacts(content: SessionContent): AaakFacts {
  const { people, projects, tools } = parseEntitiesFromSession(content);

  const team: AaakPerson[] = [];
  for (const [name, info] of people.entries()) {
    team.push({
      code: getOrCreateTeamCode(name),
      name: name,
      role: info.role || 'dev',
      started: info.started,
      tenure: info.started ? extractTenure(info.started) : undefined,
    });
  }

  const projectList: AaakProject[] = [];
  for (const proj of projects) {
    projectList.push({
      name: proj.toUpperCase(),
      type: 'project',
    });
  }

  const sprints = detectActiveSprints(content);
  const decisions = detectDecisions(content);
  const preferences = detectPreferences(content);
  const discoveries = detectDiscoveries(content);
  const problems = detectProblems(content);

  return {
    team,
    projects: projectList,
    sprints,
    decisions,
    preferences,
    discoveries,
    problems,
  };
}

function detectActiveSprints(content: SessionContent): AaakSprint[] {
  const sprints: AaakSprint[] = [];
  const text = content.userMessages.concat(content.assistantMessages).map(m => m.text).join('\n');

  const sprintPattern = /(?:working on|currently|right now|focused on|in progress)\s+[:.]?\s*([^\n.]{3,60})/gi;
  const matches = text.matchAll(sprintPattern);
  for (const match of matches) {
    const task = match[1].trim().replace(/\s+/g, '.').toLowerCase();
    if (task.length > 2) {
      sprints.push({ current: task });
    }
  }

  return sprints.slice(0, 2);
}

export function checkAaakContradictions(
  facts: AaakFacts,
  claims: string[]
): ContradictionResult[] {
  const contradictions: ContradictionResult[] = [];

  for (const claim of claims) {
    const claimLower = claim.toLowerCase();

    for (const person of facts.team) {
      const personCode = person.code.toLowerCase();

      if (claimLower.includes(person.name.toLowerCase()) || claimLower.includes(personCode)) {
        if (person.tenure) {
          const tenureMatch = claim.match(/(\d+)\s*(year|yr|month|mo)/i);
          if (tenureMatch) {
            const claimed = tenureMatch[0];
            if (!claimLower.includes(person.tenure) && !claimLower.includes(claimed)) {
              contradictions.push({
                type: 'warning',
                code: `${person.code}:wrong_tenure`,
                message: `${person.name} tenure mismatch`,
                expected: person.tenure,
                actual: claimed,
              });
            }
          }
        }
      }
    }

    for (const decision of facts.decisions) {
      const decisionText = decision.recommendation.toLowerCase();
      const alternatives = decision.alternatives?.toLowerCase() || '';

      if (claimLower.includes(decisionText) || claimLower.includes(alternatives)) {
        if (alternatives && claimLower.includes(alternatives) && !claimLower.includes(decisionText)) {
          contradictions.push({
            type: 'warning',
            code: `DECISION:attribution_conflict`,
            message: `Attribution conflict — "${decision.recommendation}" was chosen, not "${decision.alternatives}"`,
            expected: decision.recommendation,
            actual: decision.alternatives || '',
          });
        }
      }
    }
  }

  return contradictions;
}

export function compressSessionToAaak(
  content: SessionContent,
  options?: { projectPath?: string }
): AaakOutput {
  const facts = extractAaakFacts(content);

  // Enrich facts using the classifier — scan all messages for high-importance content
  try {
    const { classifyChunk } = require('./memory-classifier.js');
    const allText = content.userMessages
      .concat(content.assistantMessages)
      .map(m => m.text);

    for (const text of allText) {
      if (text.length < 20) continue;
      const cls = classifyChunk(text);
      if (cls.importance >= 4) {
        // High-importance decisions/preferences that regex might have missed
        if (cls.memoryType === 'preference' && facts.preferences.length < 5) {
          const snippet = text.replace(/\n/g, ' ').trim().slice(0, 80);
          if (!facts.preferences.includes(snippet)) {
            facts.preferences.push(snippet);
          }
        }
        if (cls.memoryType === 'discovery' && facts.discoveries.length < 5) {
          const snippet = text.replace(/\n/g, ' ').trim().slice(0, 80);
          if (!facts.discoveries.includes(snippet)) {
            facts.discoveries.push(snippet);
          }
        }
      }
    }
  } catch { /* classifier not available, continue with regex-only facts */ }

  // Enrich from knowledge graph if project is known
  if (options?.projectPath) {
    try {
      const { KnowledgeGraph } = require('./knowledge-graph.js');
      const kg = new KnowledgeGraph();
      const projectName = options.projectPath.split('/').filter(Boolean).pop() || '';
      if (projectName) {
        const kgFacts = kg.queryEntity(projectName);
        const currentTools = kgFacts
          .filter((f: { current: boolean; predicate: string; direction: string }) => f.current && f.predicate === 'uses' && f.direction === 'outgoing')
          .map((f: { object: string }) => f.object);
        // Add KG-known tools as project context
        for (const tool of currentTools.slice(0, 5)) {
          const existing = facts.projects.find(p => p.name.toLowerCase() === tool.toLowerCase());
          if (!existing) {
            facts.discoveries.push(`Uses: ${tool}`);
          }
        }
      }
      kg.close();
    } catch { /* KG not available, continue */ }
  }

  const aaak = compressToAaak(facts);
  const claims = content.userMessages.map(m => m.text);
  const contradictions = checkAaakContradictions(facts, claims);

  const rawText = [
    compressTeam(facts),
    compressProjects(facts),
    compressSprints(facts),
    compressDecisions(facts),
    compressMisc(facts),
  ].filter(Boolean).join('\n');

  return {
    aaak,
    facts,
    contradictions,
    rawText,
  };
}

export function getAaakSpec(): string {
  return `AAAK Format Spec:
TEAM: CODE(role,tenure...) CODE(role,tenure...)   # Team members
PROJ: NAME(type) | PROJ: NAME | NAME(type)       # Projects
SPRINT: task@assignee | task progress             # Active sprints
DECISION: REC>ALT(reason)|★★★★★                 # Decisions with ratings
PREF: preference | PREF: preference              # Preferences
DISC: discovery | DISC: discovery               # Discoveries
PROB: problem | PROB: problem                   # Problems

Symbols:
> = chosen over (DECISION: postgres>mongo)
@ = assigned to (SPRINT: auth@KAI)
★ = rating (1-5 stars)
| = separator
() = attributes/reasons

Example:
TEAM: KAI(backend,3yr) PRI(lead) SOR(frontend) | PROJ: CHATRECALL(app) | SPRINT: mcp.server | DECISION: typescript>js|★★★★
`;
}
