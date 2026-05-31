const WHOLE_FENCE_RE = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/;
const USER_COMMAND_FENCE_RE = /#\s*User Command\s*\n+\s*```[\w-]*\n([\s\S]*?)\n```/i;
const OPERATOR_PREFIX_RE = /^(?:전달|추가\s*전달|치즈\s*(?:전달|질문|요청|지시)|사용자\s*(?:요청|질문|지시)|User\s+says|follow[- ]?up)\s*[:：-]?\s*/iu;
const LEADING_FRAME_PATTERNS = [
  /^치즈가\s*(?:방금\s*)?(?:네\s*)?(?:답변에\s*이어\s*)?이렇게\s*(?:말했어|물었어|전달하래|요청했어)\s*[:：.]?\s*/iu,
  /^사용자가\s*(?:방금\s*)?(?:이렇게\s*)?(?:말했어|물었어|전달하래|요청했어)\s*[:：.]?\s*/iu,
  /^방금\s*네\s*(?:Final\s*Answer|답변)에\s*대해\s*이렇게\s*(?:물었어|말했어|요청했어)\s*[:：.]?\s*/iu,
  /^(?:the\s+user\s+asked|the\s+user\s+said)\s*[:：.]?\s*/iu,
];
const ROUTING_LINE_RE = /^(?:bridge[_ -]?session[_ -]?id|bridge session id|tmux id|세션명|세션\s*id|대상\s*세션)\s*[:：=].*$/iu;
const BOUNDARY_ONLY_RULES = new Set(['normalize-line-endings', 'trim-wrapper-whitespace', 'collapse-blank-lines']);

function pushRule(rules, rule) {
  if (!rules.includes(rule)) rules.push(rule);
}

function trimIfChanged(before, after, rules, rule) {
  if (after !== before) pushRule(rules, rule);
  return after;
}

function unwrapWholeFence(value, rules) {
  const match = WHOLE_FENCE_RE.exec(value);
  if (!match) return value;
  pushRule(rules, 'unwrap-whole-code-fence');
  return match[1];
}

function unwrapUserCommandFence(value, rules) {
  const match = USER_COMMAND_FENCE_RE.exec(value);
  if (!match) return value;
  pushRule(rules, 'extract-user-command-fence');
  return match[1];
}

function stripOperatorPrefixes(value, rules) {
  let next = value;
  for (let index = 0; index < 6; index += 1) {
    const before = next;
    next = next.replace(OPERATOR_PREFIX_RE, '');
    if (next === before) break;
    pushRule(rules, 'strip-operator-prefix');
  }
  return next;
}

function stripLeadingFrames(value, rules) {
  let next = value;
  for (let index = 0; index < 4; index += 1) {
    const before = next;
    for (const pattern of LEADING_FRAME_PATTERNS) next = next.replace(pattern, '');
    if (next === before) break;
    pushRule(rules, 'strip-leading-frame');
  }
  return next;
}

function stripRoutingLines(value, rules) {
  const lines = value.split('\n');
  const kept = lines.filter((line) => !ROUTING_LINE_RE.test(line.trim()));
  if (kept.length === lines.length) return value;
  pushRule(rules, 'strip-routing-lines');
  return kept.join('\n');
}

function stripMarkdownQuoteShell(value, rules) {
  const lines = value.split('\n');
  if (lines.length === 0 || !lines.every((line) => !line.trim() || line.trimStart().startsWith('>'))) return value;
  pushRule(rules, 'strip-markdown-quote-shell');
  return lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
}

function stripCommonHermesBoilerplate(value, rules) {
  let next = value;
  const before = next;
  next = next
    .replace(/^추가\s*확인\s*요청이야[.。!！]?\s*/iu, '')
    .replace(/^추가\s*요청이야[.。!！]?\s*/iu, '')
    .replace(/^사용자는\s+([\s\S]+?)\s+라고\s+(?:해|말했어|물었어)[.。]?\s*(?:그러면\s*)?/iu, '$1 ')
    .replace(/^사용자는\s+/iu, '')
    .replace(/\s*라고\s*(?:물어봤는데|말했는데|했는데)\s*$/iu, '');
  if (next !== before) pushRule(rules, 'strip-hermes-boilerplate');
  return next;
}

function normalizeBoundaries(value, rules) {
  let next = value.replace(/\r\n?/g, '\n');
  next = trimIfChanged(value, next, rules, 'normalize-line-endings');

  const beforeTrim = next;
  next = next.trim();
  if (next !== beforeTrim) pushRule(rules, 'trim-wrapper-whitespace');

  const beforeBlank = next;
  next = next.replace(/\n{3,}/g, '\n\n');
  if (next !== beforeBlank) pushRule(rules, 'collapse-blank-lines');

  return next;
}

function normalizeCommandTextForDispatch(commandText, options = {}) {
  const raw = typeof commandText === 'string' ? commandText : String(commandText || '');
  if (options.raw === true || options.normalize === false) {
    return {
      text: raw,
      changed: false,
      rules: ['raw-preserve-requested'],
      rawText: raw,
    };
  }

  const rules = [];
  let next = raw;
  const starting = next;

  next = unwrapUserCommandFence(next, rules);
  next = unwrapWholeFence(next, rules);
  next = stripMarkdownQuoteShell(next, rules);
  next = normalizeBoundaries(next, rules);
  next = stripRoutingLines(next, rules);
  next = stripLeadingFrames(next, rules);
  next = stripOperatorPrefixes(next, rules);
  next = stripCommonHermesBoilerplate(next, rules);
  next = unwrapWholeFence(next, rules);
  next = normalizeBoundaries(next, rules);

  if (!next.trim()) {
    return {
      text: raw,
      changed: false,
      rules: ['normalization-empty-preserve-raw'],
      rawText: raw,
    };
  }

  if (rules.length > 0 && rules.every((rule) => BOUNDARY_ONLY_RULES.has(rule))) {
    return {
      text: raw,
      changed: false,
      rules: [],
      rawText: raw,
    };
  }

  return {
    text: next,
    changed: next !== starting,
    rules,
    rawText: raw,
  };
}

export { normalizeCommandTextForDispatch };
