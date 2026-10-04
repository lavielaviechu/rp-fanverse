// ==UserScript==
// @name         RP Fanverse
// @namespace    https://crack.wrtn.ai/
// @version      0.12.1
// @description  Treats a Crack RP episode as canon and grows a persistent virtual Pixiv/Reddit fandom around it.
// @author       Personal userscript
// @match        https://crack.wrtn.ai/stories/*/episodes/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @require      https://accounts.google.com/gsi/client
// @connect      crack-api.wrtn.ai
// @connect      generativelanguage.googleapis.com
// @connect      aiplatform.googleapis.com
// @connect      oauth2.googleapis.com
// @connect      googleapis.com
// ==/UserScript==

(function () {
  'use strict';

  const APP_VERSION = '0.12.0';
  const DB_NAME = 'rp-fanverse';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'rp-fanverse:settings:v1';
  const PROMPTS_KEY = 'rp-fanverse:prompt-overrides:v1';
  const VERTEX_TOKEN_KEY = 'rp-fanverse:vertex-token:v1';
  const SETTINGS_VERSION = 2;
  const WORLD_RE = /^\/stories\/([^/]+)\/episodes\/([^/?#]+)/;
  const API_BASE = 'https://crack-api.wrtn.ai/crack-gen/v3';
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
  const DEFAULT_SETTINGS = Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    apiKey: '',
    provider: 'developer',
    model: 'gemini-3.8-flash',
    modelPreset: 'gemini-3.8-flash',
    customModelId: '',
    vertexProjectId: '',
    vertexLocation: 'global',
    vertexApiVersion: 'v1',
    vertexOAuthClientId: '',
    turnsPerUpdate: 5,
    activity: 'Normal',
    fanworkLanguage: '日本語',
    fanworkTargetLength: 4000,
    streaming: true,
    autoUpdate: true,
    pollSeconds: 30,
    uiScale: 1,
    pixivReader: Object.freeze({ size: 'm', font: 'gothic', theme: 'light' }),
  });

  const MODEL_PRESETS = Object.freeze([
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  ]);
  // Model strings earlier versions wrote as their *default*. A saved value equal to one of these
  // was never a deliberate choice, so migration moves it to the new default preset instead of
  // preserving it as a Custom model ID.
  const LEGACY_DEFAULT_MODELS = Object.freeze(['', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest']);

  function resolveModelId(settings) {
    if (settings.modelPreset === 'custom') return String(settings.customModelId || '').trim() || DEFAULT_SETTINGS.model;
    return MODEL_PRESETS.some((preset) => preset.id === settings.modelPreset) ? settings.modelPreset : DEFAULT_SETTINGS.model;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function normalizeSettings(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const result = { ...DEFAULT_SETTINGS, ...source };
    result.provider = result.provider === 'vertex' ? 'vertex' : 'developer';
    if (!source.modelPreset) {
      const legacyModel = String(source.model || '').trim();
      if (MODEL_PRESETS.some((preset) => preset.id === legacyModel)) result.modelPreset = legacyModel;
      else if (LEGACY_DEFAULT_MODELS.includes(legacyModel)) result.modelPreset = DEFAULT_SETTINGS.modelPreset;
      else { result.modelPreset = 'custom'; result.customModelId = legacyModel; }
    }
    if (!['custom', ...MODEL_PRESETS.map((preset) => preset.id)].includes(result.modelPreset)) result.modelPreset = DEFAULT_SETTINGS.modelPreset;
    result.customModelId = String(result.customModelId || '').trim();
    result.vertexProjectId = String(result.vertexProjectId || '').trim();
    result.vertexLocation = String(result.vertexLocation || 'global').trim().toLowerCase() || 'global';
    result.vertexApiVersion = ['v1', 'v1beta1'].includes(result.vertexApiVersion) ? result.vertexApiVersion : 'v1';
    result.vertexOAuthClientId = String(result.vertexOAuthClientId || '').trim();
    result.turnsPerUpdate = Math.round(clampNumber(result.turnsPerUpdate, 1, 100, DEFAULT_SETTINGS.turnsPerUpdate));
    result.fanworkTargetLength = Math.round(clampNumber(result.fanworkTargetLength, 500, 30000, DEFAULT_SETTINGS.fanworkTargetLength));
    result.uiScale = clampNumber(result.uiScale, 0.75, 1.25, 1);
    const reader = result.pixivReader && typeof result.pixivReader === 'object' ? result.pixivReader : {};
    result.pixivReader = {
      size: ['s', 'm', 'l'].includes(reader.size) ? reader.size : 'm',
      font: ['gothic', 'mincho'].includes(reader.font) ? reader.font : 'gothic',
      theme: ['light', 'sepia', 'dark'].includes(reader.theme) ? reader.theme : 'light',
    };
    // 0.11.0 kept prompt overrides inside settings. They now live under PROMPTS_KEY; App.init
    // migrates the legacy field once and the next save drops it.
    if (!source.promptOverrides) delete result.promptOverrides;
    result.settingsVersion = SETTINGS_VERSION;
    result.model = resolveModelId(result);
    return result;
  }

  // Vertex AI host per location: `global` uses the global endpoint, the `us`/`eu` multi-regions
  // use the regional-endpoint (REP) hosts, and anything else is treated as a region name.
  function vertexHost(location) {
    if (location === 'global') return 'aiplatform.googleapis.com';
    if (location === 'us' || location === 'eu') return `aiplatform.${location}.rep.googleapis.com`;
    return `${location}-aiplatform.googleapis.com`;
  }

  function buildVertexEndpoint(settings, stream = false) {
    const location = String(settings.vertexLocation || 'global').trim().toLowerCase() || 'global';
    const version = settings.vertexApiVersion === 'v1beta1' ? 'v1beta1' : 'v1';
    const project = encodeURIComponent(String(settings.vertexProjectId || '').trim());
    const model = encodeURIComponent(resolveModelId(settings));
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `https://${vertexHost(location)}/${version}/projects/${project}/locations/${encodeURIComponent(location)}/publishers/google/models/${model}:${method}`;
  }

  const STORES = Object.freeze({
    worlds: 'worlds',
    messages: 'messages',
    canonEvents: 'canonEvents',
    redditPosts: 'redditPosts',
    pixivWorks: 'pixivWorks',
    pendingEvents: 'pendingEvents',
    fanworks: 'fanworks',
  });

  const Utils = {
    clone(value) {
      return value == null ? value : JSON.parse(JSON.stringify(value));
    },
    uid(prefix = 'id') {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    },
    hash(input) {
      let hash = 2166136261;
      const text = String(input ?? '');
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    },
    clamp(value, min, max) {
      return Math.min(max, Math.max(min, Number(value) || 0));
    },
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
      }[ch]));
    },
    nl2br(value) {
      return Utils.escapeHtml(value).replace(/\n/g, '<br>');
    },
    parseJson(text) {
      const source = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      return JSON.parse(source);
    },
    validateSchema(value, schema, path = '$') {
      const allowedTypes = Array.isArray(schema?.type) ? schema.type : [schema?.type].filter(Boolean);
      const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
      if (allowedTypes.length && !allowedTypes.includes(actualType) && !(actualType === 'integer' && allowedTypes.includes('number'))) throw new Error(`${path} must be ${allowedTypes.join('|')}`);
      if (schema?.enum && !schema.enum.includes(value)) throw new Error(`${path} is outside enum`);
      if (actualType === 'object') {
        for (const key of schema.required || []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
        for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) Utils.validateSchema(value[key], child, `${path}.${key}`);
      }
      if (actualType === 'array' && schema?.items) value.forEach((item, index) => Utils.validateSchema(item, schema.items, `${path}[${index}]`));
      return true;
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    debounce(fn, wait = 250) {
      let timer;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
      };
    },
    cookieMap(cookieString) {
      const result = {};
      String(cookieString || '').split(';').forEach((part) => {
        const at = part.indexOf('=');
        if (at < 0) return;
        const key = part.slice(0, at).trim();
        const value = part.slice(at + 1);
        if (key) result[key] = decodeURIComponent(value);
      });
      return result;
    },
    download(name, data, mime = 'application/json') {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    commonAncestor(nodes) {
      if (!nodes.length) return null;
      let current = nodes[0].parentElement;
      while (current && !nodes.every((node) => current.contains(node))) current = current.parentElement;
      return current;
    },
  };

  // Every runtime value a prompt template can receive. Strings and numbers are inserted as-is;
  // objects and arrays are inserted as pretty-printed JSON.
  const PLACEHOLDER_DOCS = Object.freeze({
    CANON: '현재 Canon 스냅샷 또는 작품/댓글과 관련된 Canon 문맥 (facts, characters, relationships, events) · JSON',
    NEW_TURNS: '이번에 분석할 RP turn 목록 (turnId, messageIds, user, assistant) · JSON',
    CANON_UPDATE: '이번 update에서 새로 추출된 Canon facts/events/character·relationship 변화 · JSON',
    FANDOM_STATE: '누적 팬덤 상태 (해석, CP/태그 momentum, 최근 플랫폼 화제) · JSON',
    CURRENT_TURN: '현재 처리된 RP turn 번호 · 숫자',
    ACTIVITY: '팬덤 활동량 설정 (Quiet / Normal / Active / Chaos) · 문자열',
    PERSONAS: '영구 페르소나 목록 (Reddit 사용자 또는 Pixiv 작가; id, name, 성향) · JSON',
    REACTIONS: '이번에 실행할 반응 입력 (due pending events, 즉시 반응, 새 Canon events, 해석, cross-post 문맥) · JSON',
    POST: '댓글을 이어 붙일 Reddit 게시물 (id, title, body, category) · JSON',
    EXISTING_COMMENTS: '이미 저장된 댓글 목록 (id, parentId, personaId, body, score) · JSON',
    CONTINUATION_TOPICS: '아직 다루지 않은 토론 주제 목록 · JSON',
    WORK_METADATA: 'Pixiv 작품 metadata (title, tags, caption, summary, ship, workType, tone, series) · JSON',
    AUTHOR: '작품을 쓴 Pixiv 작가 페르소나 · JSON',
    LANGUAGE: '팬픽 언어 설정 · 문자열',
    TARGET_LENGTH: '목표 글자 수 · 숫자',
    OUTLINE: '장편 개요 (title, premise, continuityConstraints, sections) · JSON',
    FANWORK: '검사/수정할 팬픽 전문 · 문자열',
    ISSUES: 'Continuity Check가 찾은 문제 목록 · JSON',
    CONTINUITY_NOTES: 'Continuity Check의 메모 목록 · JSON',
    FANWORK_PROMPT: 'Pixiv Full Fanwork Generator 프롬프트를 렌더링한 전체 텍스트 · 문자열',
    SECTION_NUMBER: '지금 쓸 섹션 번호 (1부터) · 숫자',
    SECTION_TOTAL: '전체 섹션 수 · 숫자',
    PREVIOUS_TEXT: '이미 작성된 앞 섹션의 마지막 부분 (최대 12,000자) · 문자열',
  });

  // `required` placeholders must stay in the template (removing them would silently drop the data
  // the call depends on). `optional` ones may be removed; the editor only warns.
  const PROMPT_DEFINITIONS = Object.freeze({
    redditGenerator: { label: 'Reddit Post Generator', group: 'reddit', description: '팬덤 반응을 Reddit 게시물 + 초기 댓글 샘플로 만듭니다.', output: 'JSON (Reddit posts schema)', required: ['PERSONAS', 'REACTIONS'], optional: ['ACTIVITY'] },
    redditMoreComments: { label: 'Reddit Comment Expansion', group: 'reddit', description: '"more comments"를 누를 때 다음 댓글 batch를 생성합니다.', output: 'JSON (Reddit comments schema)', required: ['POST', 'EXISTING_COMMENTS', 'PERSONAS'], optional: ['CONTINUATION_TOPICS', 'CANON', 'FANDOM_STATE'] },
    pixivMetadataGenerator: { label: 'Pixiv Metadata Generator', group: 'pixiv', description: '팬덤 반응을 Pixiv 소설 metadata(제목·태그·캡션)로 만듭니다. 본문은 쓰지 않습니다.', output: 'JSON (Pixiv works schema)', required: ['PERSONAS', 'REACTIONS'], optional: ['ACTIVITY'] },
    fanwork: { label: 'Pixiv Full Fanwork Generator', group: 'pixiv', description: '작품을 열었을 때 팬픽 전문을 생성합니다 (목표 8,000자 이하).', output: 'Text (본문)', required: ['WORK_METADATA'], optional: ['LANGUAGE', 'TARGET_LENGTH', 'AUTHOR', 'CANON', 'FANDOM_STATE'] },
    fanworkOutline: { label: 'Long Fanwork Outline', group: 'pixiv', description: '목표 8,000자 초과 장편의 개요(3개 섹션)를 만듭니다.', output: 'JSON (outline schema)', required: ['WORK_METADATA'], optional: ['LANGUAGE', 'TARGET_LENGTH', 'AUTHOR', 'CANON', 'FANDOM_STATE'] },
    fanworkSection: { label: 'Long Fanwork Section Writer', group: 'pixiv', description: '장편을 섹션 단위로 이어 씁니다. 위 Full Fanwork 프롬프트가 FANWORK_PROMPT로 들어옵니다.', output: 'Text (섹션 본문)', required: ['FANWORK_PROMPT', 'OUTLINE', 'SECTION_NUMBER'], optional: ['SECTION_TOTAL', 'PREVIOUS_TEXT'] },
    canonExtractor: { label: 'Canon Extractor', group: 'canon', description: 'RP turn에서 명시적 사실만 Canon으로 추출합니다.', output: 'JSON (canon schema)', required: ['NEW_TURNS'], optional: ['CANON'] },
    fandomUpdate: { label: 'Fandom Update', group: 'canon', description: 'Canon 변화에 대한 팬덤 해석·CP momentum·pending event를 계산합니다.', output: 'JSON (fandom schema)', required: ['CANON_UPDATE', 'FANDOM_STATE', 'CURRENT_TURN'], optional: ['ACTIVITY'] },
    continuity: { label: 'Continuity Check', group: 'continuity', description: '장편 전문을 개요·Canon과 대조해 의도치 않은 모순을 찾습니다.', output: 'JSON (continuity schema)', required: ['FANWORK'], optional: ['OUTLINE', 'CANON'] },
    fanworkRevision: { label: 'Continuity Rewrite / Fix', group: 'continuity', description: 'Continuity Check 결과로 전문을 수정합니다.', output: 'Text (수정된 전문)', required: ['FANWORK', 'ISSUES'], optional: ['LANGUAGE', 'OUTLINE', 'CANON', 'CONTINUITY_NOTES'] },
  });

  const PROMPT_GROUPS = Object.freeze([
    { id: 'reddit', label: 'Reddit 팬덤 글', hint: '게시물 · 댓글 생성' },
    { id: 'pixiv', label: 'Pixiv 팬픽', hint: 'metadata · 전문 · 장편' },
    { id: 'canon', label: 'Canon · Fandom 분석', hint: '원작 추출 · 팬덤 진화' },
    { id: 'continuity', label: 'Continuity', hint: '장편 검사 · 수정' },
  ]);

  const DEFAULT_PROMPT_TEMPLATES = Object.freeze({
    canonExtractor: `You are the Canon Extractor for RP Fanverse. The RP log is the only canon. Extract only explicit facts, events, knowledge states, spoken claims (without assuming they are true), and confirmed feelings. Never turn inference into canon. Preserve uncertainty. Return Korean descriptions while retaining proper names in their source language when useful.

CURRENT CANON:
{{CANON}}

NEW RP TURNS:
{{NEW_TURNS}}

Every item must cite sourceMessageIds and sourceTurnIds from the input.`,
    fandomUpdate: `You simulate a persistent fandom reacting to an ongoing official RP canon. Keep CANON separate from FAN INTERPRETATION. Decide what fans would ship, debate, meme, or create now. One-to-one ships, triangles, poly relationships, and character-centric devotion tags are equally valid. Momentum is not romance-game affection. Schedule reactions to mature over later RP turns: quick reactions soon, essays/theories later, short canon-axis works after that, IF/AU and long works later. Activity level is {{ACTIVITY}}.

CANON UPDATE:
{{CANON_UPDATE}}

CURRENT FANDOM STATE:
{{FANDOM_STATE}}

CURRENT TURN: {{CURRENT_TURN}}
Return interpretation updates, ship/tag deltas, reaction points, and pending events with dueTurn and expiryTurn.`,
    redditGenerator: `Create virtual Reddit-like fandom posts reacting to the supplied canon and fan interpretations. Use only the persistent persona IDs provided. Users share canon facts but disagree in interpretation. Include analysis, theories, episode discussion, CP discussion, unpopular opinions, and occasional text memes. The category field is shown as the post flair, so keep it short (e.g. Discussion, Theory, Analysis, Shipping, Meme, Unpopular Opinion, Episode Discussion). Generate only a small initial comment sample per post; the rest will be generated on demand. Comments are a flat list with id and parentId for nested rendering. Supply estimatedCommentCount, hasMoreComments, and continuationTopics so later batches can continue naturally. Do not claim fan theories are canon. Language: Korean, with natural fandom jargon.

PERSONAS:
{{PERSONAS}}

REACTION INPUT:
{{REACTIONS}}

ACTIVITY: {{ACTIVITY}}`,
    redditMoreComments: `Continue a persistent virtual Reddit discussion. Generate only the next comment batch, not the post again. Reuse only the supplied persona IDs. Comments may reply to an existing comment ID or another new temporary ID from this batch. Preserve disagreements and persona biases, avoid repeating existing comments, and ground all claims in the supplied canon/fandom context. Return hasMoreComments based on whether the discussion still has worthwhile unexplored threads. Language: Korean.

POST:
{{POST}}

EXISTING COMMENTS:
{{EXISTING_COMMENTS}}

CONTINUATION TOPICS:
{{CONTINUATION_TOPICS}}

PERSONAS:
{{PERSONAS}}

CANON:
{{CANON}}

FANDOM STATE:
{{FANDOM_STATE}}`,
    pixivMetadataGenerator: `Create metadata only for virtual Japanese Pixiv-like fanworks based on the supplied fandom reaction input. Do NOT write the full work. Use only persistent author persona IDs provided. Mix 原作軸, 幕間, IF, AU, future fabrication, multi-person relationships, and character-centric works as appropriate. Titles/captions/tags should feel natural in Japanese. Source canon IDs must be retained.

AUTHORS:
{{PERSONAS}}

REACTION INPUT:
{{REACTIONS}}

ACTIVITY: {{ACTIVITY}}`,
    fanwork: `You are writing a virtual fanwork based on an RP treated as official canon. This is FANWORK, not canon. Respect the metadata, author persona, relevant canon facts, and chosen divergence type. Write naturally in {{LANGUAGE}}. Target approximately {{TARGET_LENGTH}} characters. Do not add meta commentary before or after the work.

WORK METADATA:
{{WORK_METADATA}}

AUTHOR:
{{AUTHOR}}

RELEVANT CANON:
{{CANON}}

FANDOM CONTEXT:
{{FANDOM_STATE}}`,
    fanworkOutline: `Plan a coherent long fanwork in {{LANGUAGE}}, around {{TARGET_LENGTH}} characters. Return a title, premise, continuity constraints, and exactly three section plans.

WORK METADATA:
{{WORK_METADATA}}

AUTHOR:
{{AUTHOR}}

CANON:
{{CANON}}

FANDOM STATE:
{{FANDOM_STATE}}`,
    fanworkSection: `{{FANWORK_PROMPT}}

OUTLINE:
{{OUTLINE}}

Write section {{SECTION_NUMBER}} of {{SECTION_TOTAL}} only. Maintain continuity with previous text:
{{PREVIOUS_TEXT}}`,
    continuity: `Check this virtual fanwork against its own outline and supplied canon. Fanwork divergence is allowed when labeled; identify only accidental contradictions, name drift, timeline breaks, and unresolved continuity problems. Return concise issues and continuityNotes.

OUTLINE:
{{OUTLINE}}

CANON:
{{CANON}}

FANWORK:
{{FANWORK}}`,
    fanworkRevision: `Revise the complete virtual fanwork to fix every accidental continuity issue listed below. Preserve the work's title, voice, emotional arc, approximate length, deliberate IF/AU divergences, and all passages that do not need changes. Return only the full corrected fanwork with no preface or commentary. Language: {{LANGUAGE}}.

OUTLINE:
{{OUTLINE}}

CANON CONTEXT:
{{CANON}}

ISSUES TO FIX:
{{ISSUES}}

CONTINUITY NOTES:
{{CONTINUITY_NOTES}}

ORIGINAL FANWORK:
{{FANWORK}}`,
  });

  const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

  // Returns { errors, warnings, placeholders } without throwing, for live editor feedback.
  function inspectPromptTemplate(promptId, template) {
    const definition = PROMPT_DEFINITIONS[promptId];
    const errors = []; const warnings = [];
    if (!definition) return { errors: [`Unknown prompt: ${promptId}`], warnings, placeholders: [] };
    const source = String(template ?? '');
    if (!source.trim()) errors.push('Prompt cannot be empty (프롬프트가 비어 있습니다)');
    const allowed = [...definition.required, ...definition.optional];
    // Anything that looks like {{ ... }} but is not a well-formed UPPER_CASE name.
    for (const match of source.matchAll(/\{\{([^{}]*)\}\}/g)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(match[1])) errors.push(`Malformed placeholder ${match[0]} — 이름은 공백 없는 대문자여야 합니다 (예: {{${match[1].trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'NAME'}}})`);
    }
    const stripped = source.replace(/\{\{[^{}]*\}\}/g, '');
    if (stripped.includes('{{') || stripped.includes('}}')) errors.push('Malformed placeholder braces — 짝이 맞지 않는 {{ 또는 }} 가 있습니다');
    const found = [...source.matchAll(PLACEHOLDER_RE)].map((match) => match[1]);
    const unknown = [...new Set(found.filter((name) => !allowed.includes(name)))];
    if (unknown.length) errors.push(`Unknown placeholder: ${unknown.map((name) => `{{${name}}}`).join(', ')} — 이 프롬프트에서 사용할 수 없습니다`);
    const missing = definition.required.filter((name) => !found.includes(name));
    if (missing.length) errors.push(`Required placeholder missing: ${missing.map((name) => `{{${name}}}`).join(', ')}`);
    const optionalMissing = definition.optional.filter((name) => !found.includes(name));
    if (optionalMissing.length) warnings.push(`선택 placeholder 미사용: ${optionalMissing.map((name) => `{{${name}}}`).join(', ')} — 해당 데이터는 모델에 전달되지 않습니다`);
    const counts = found.reduce((map, name) => map.set(name, (map.get(name) || 0) + 1), new Map());
    const repeated = [...counts].filter(([name, count]) => count > 1 && ['CANON', 'FANDOM_STATE', 'NEW_TURNS', 'FANWORK', 'FANWORK_PROMPT', 'EXISTING_COMMENTS'].includes(name)).map(([name]) => `{{${name}}}`);
    if (repeated.length) warnings.push(`큰 데이터 placeholder가 여러 번 들어갑니다: ${repeated.join(', ')} — 토큰 사용량이 늘어납니다`);
    return { errors, warnings, placeholders: [...new Set(found)] };
  }

  function validatePromptTemplate(promptId, template) {
    const { errors } = inspectPromptTemplate(promptId, template);
    if (errors.length) throw new Error(errors.join('\n'));
    return true;
  }

  function overrideTemplate(overrides, promptId) {
    const entry = overrides?.[promptId];
    if (typeof entry === 'string') return entry;
    return typeof entry?.template === 'string' ? entry.template : null;
  }

  // Resolves the template actually used for a call. An override that no longer validates (for
  // example after a placeholder rename in a newer version) falls back to the code default rather
  // than breaking generation; `source` tells the caller which one was used.
  function resolvePromptTemplate(promptId, overrides = {}) {
    const custom = overrideTemplate(overrides, promptId);
    if (custom == null) return { template: DEFAULT_PROMPT_TEMPLATES[promptId], source: 'default', error: null };
    const { errors } = inspectPromptTemplate(promptId, custom);
    if (errors.length) return { template: DEFAULT_PROMPT_TEMPLATES[promptId], source: 'fallback', error: errors.join(' / ') };
    return { template: custom, source: 'override', error: null };
  }

  function renderPromptTemplate(promptId, values, overrides = {}) {
    const { template } = resolvePromptTemplate(promptId, overrides);
    return template.replace(PLACEHOLDER_RE, (_, name) => {
      const value = values[name];
      return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value ?? null, null, 2);
    });
  }

  // GM storage layout under PROMPTS_KEY. Only edited prompts are stored; defaultHash records which
  // code default the edit was based on so the editor can flag defaults that changed since.
  function normalizePromptStore(raw) {
    const overrides = {};
    const source = raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
    for (const [id, entry] of Object.entries(source)) {
      if (!PROMPT_DEFINITIONS[id]) continue;
      const template = overrideTemplate(source, id);
      if (template == null) continue;
      overrides[id] = { template, updatedAt: entry?.updatedAt || new Date().toISOString(), defaultHash: entry?.defaultHash || '' };
    }
    return { schemaVersion: 1, overrides };
  }

  function parseWorldFromUrl(url) {
    const parsed = new URL(url, 'https://crack.wrtn.ai');
    const match = parsed.pathname.match(WORLD_RE);
    if (!match) return null;
    return {
      storyId: match[1],
      episodeId: match[2],
      id: `rfw:${match[1]}:${match[2]}`,
    };
  }

  function resolveActiveBranch(messagesNewestFirst) {
    const valid = (messagesNewestFirst || []).filter((message) => message && message.turnId);
    if (!valid.length) return [];
    const byTurnId = new Map(valid.map((message) => [message.turnId, message]));
    const branch = [];
    const visited = new Set();
    let current = valid[0];
    while (current && !visited.has(current.turnId)) {
      branch.push(current);
      visited.add(current.turnId);
      current = current.parentTurnId ? byTurnId.get(current.parentTurnId) : null;
    }
    return branch.reverse();
  }

  function buildTurns(activeMessagesChronological) {
    const turns = [];
    const byTurnId = new Map((activeMessagesChronological || []).map((message) => [message.turnId, message]));
    for (const assistant of activeMessagesChronological || []) {
      if (assistant.role !== 'assistant' || assistant.status && assistant.status !== 'end') continue;
      const user = byTurnId.get(assistant.parentTurnId);
      if (!user || user.role !== 'user' || user.status && user.status !== 'end') continue;
      turns.push({
        id: `${user._id}::${assistant._id}`,
        userMessageId: user._id,
        assistantMessageId: assistant._id,
        userTurnId: user.turnId,
        assistantTurnId: assistant.turnId,
        user: user.content || '',
        assistant: assistant.content || '',
      });
    }
    return turns;
  }

  function normalizeDomMessageOrder(messages, flexDirection) {
    const list = [...(messages || [])];
    return flexDirection === 'column-reverse' ? list.reverse() : list;
  }

  function planPendingExecution(events, currentTurn, canonRevision = 1) {
    const plan = { reddit: [], pixiv: [], expired: [], waiting: [], skipped: [] };
    for (const event of events || []) {
      const kind = ['reddit', 'pixiv', 'cross'].includes(event.kind) ? event.kind : null;
      const generated = event.generatedPlatforms || { reddit: false, pixiv: false };
      if (!kind || event.status === 'generated' || event.status === 'expired' || event.status === 'superseded' || event.status === 'suspended') {
        plan.skipped.push(event); continue;
      }
      if (event.branchRevision != null && event.branchRevision !== canonRevision) {
        plan.skipped.push(event); continue;
      }
      if (Number(event.expiryTurn) < currentTurn) { plan.expired.push(event); continue; }
      if (Number(event.dueTurn) > currentTurn) { plan.waiting.push(event); continue; }
      if ((kind === 'reddit' || kind === 'cross') && !generated.reddit) plan.reddit.push(event);
      if ((kind === 'pixiv' || kind === 'cross') && !generated.pixiv) plan.pixiv.push(event);
    }
    return plan;
  }

  // Structured output uses `responseJsonSchema` (standard JSON Schema), which both the Gemini
  // Developer API and Vertex AI accept. The older `responseSchema` is an OpenAPI subset whose
  // `type` is a single enum, so nullable fields written as ["string", "null"] would be rejected.
  function buildJsonGenerationConfig(schema, temperature) {
    return { temperature, responseMimeType: 'application/json', responseJsonSchema: schema };
  }

  function candidateText(json) {
    return json?.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('') || '';
  }

  // Parses a complete `alt=sse` body (same framing on both providers: `data: {GenerateContentResponse}`).
  function parseSseText(body) {
    let text = '';
    for (const line of String(body || '').split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const json = JSON.parse(payload);
      if (json.error) throw new Error(json.error.message || 'Stream returned an error');
      text += candidateText(json);
    }
    return text;
  }

  function readingMinutes(characters) {
    return Math.max(1, Math.round((Number(characters) || 0) / 550));
  }

  if (typeof window === 'undefined' || !window.document) {
    globalThis.__RP_FANVERSE_TEST_HOOKS__ = {
      parseWorldFromUrl,
      resolveActiveBranch,
      buildTurns,
      normalizeDomMessageOrder,
      planPendingExecution,
      hash: Utils.hash,
      validateSchema: Utils.validateSchema,
      normalizeSettings,
      resolveModelId,
      buildVertexEndpoint,
      validatePromptTemplate,
      inspectPromptTemplate,
      resolvePromptTemplate,
      renderPromptTemplate,
      normalizePromptStore,
      buildJsonGenerationConfig,
      parseSseText,
      readingMinutes,
      promptDefinitions: PROMPT_DEFINITIONS,
      defaultPromptTemplates: DEFAULT_PROMPT_TEMPLATES,
    };
    return;
  }

  const GMStore = {
    async get(key, fallback) {
      const value = await Promise.resolve(GM_getValue(key, fallback));
      return value == null ? fallback : value;
    },
    async set(key, value) {
      return Promise.resolve(GM_setValue(key, value));
    },
    async remove(key) {
      return Promise.resolve(GM_deleteValue(key));
    },
  };

  class Database {
    constructor() {
      this.db = null;
    }

    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORES.worlds)) db.createObjectStore(STORES.worlds, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(STORES.messages)) {
            const store = db.createObjectStore(STORES.messages, { keyPath: 'pk' });
            store.createIndex('worldId', 'worldId', { unique: false });
            store.createIndex('turnId', ['worldId', 'turnId'], { unique: false });
          }
          for (const name of [STORES.canonEvents, STORES.redditPosts, STORES.pixivWorks, STORES.pendingEvents, STORES.fanworks]) {
            if (!db.objectStoreNames.contains(name)) {
              const store = db.createObjectStore(name, { keyPath: 'id' });
              store.createIndex('worldId', 'worldId', { unique: false });
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
      });
      return this.db;
    }

    async transaction(storeNames, mode, action) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        try {
          result = action(tx);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    }

    async get(storeName, key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    async put(storeName, value) {
      return this.transaction([storeName], 'readwrite', (tx) => tx.objectStore(storeName).put(value));
    }

    async bulkPut(storeName, values) {
      if (!values?.length) return;
      return this.transaction([storeName], 'readwrite', (tx) => {
        const store = tx.objectStore(storeName);
        values.forEach((value) => store.put(value));
      });
    }

    async getAll(storeName) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }

    async getAllByWorld(storeName, worldId) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).index('worldId').getAll(worldId);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }

    async deleteWhereWorld(storeName, worldId, predicate) {
      const rows = await this.getAllByWorld(storeName, worldId);
      const doomed = rows.filter(predicate);
      if (!doomed.length) return;
      await this.transaction([storeName], 'readwrite', (tx) => {
        const store = tx.objectStore(storeName);
        doomed.forEach((row) => store.delete(row.pk || row.id));
      });
    }

    async deleteWorld(worldId, { preserveFandom = false } = {}) {
      const stores = preserveFandom
        ? [STORES.canonEvents]
        : [STORES.messages, STORES.canonEvents, STORES.redditPosts, STORES.pixivWorks, STORES.pendingEvents, STORES.fanworks];
      const db = await this.open();
      await Promise.all(stores.map(async (name) => {
        const rows = await this.getAllByWorld(name, worldId);
        await this.transaction([name], 'readwrite', (tx) => {
          const store = tx.objectStore(name);
          rows.forEach((row) => store.delete(row.pk || row.id));
        });
      }));
      if (!preserveFandom) await this.transaction([STORES.worlds], 'readwrite', (tx) => tx.objectStore(STORES.worlds).delete(worldId));
    }

    async dump(worldId = null) {
      const result = { schemaVersion: DB_VERSION, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), stores: {} };
      for (const name of Object.values(STORES)) {
        result.stores[name] = worldId
          ? (name === STORES.worlds ? (await this.get(name, worldId) ? [await this.get(name, worldId)] : []) : await this.getAllByWorld(name, worldId))
          : await this.getAll(name);
      }
      return result;
    }

    async restore(payload) {
      if (!payload || !payload.stores || Number(payload.schemaVersion) > DB_VERSION) throw new Error('Unsupported Fanverse backup schema');
      for (const name of Object.values(STORES)) {
        const rows = payload.stores[name];
        if (Array.isArray(rows)) await this.bulkPut(name, rows);
      }
    }
  }

  class CrackApiAdapter {
    constructor() {
      this.name = 'Crack API';
    }

    headers() {
      const cookies = Utils.cookieMap(document.cookie);
      if (!cookies.access_token) throw new Error('Crack access_token cookie is unavailable');
      return {
        Accept: 'application/json, text/plain, */*',
        Authorization: `Bearer ${cookies.access_token}`,
        'Customer-Id': cookies.wrtn_customer_id || '',
        'Device-Id': cookies['ch-veil-id'] || '',
        'Mixpanel-Distinct-Id': cookies['Mixpanel-Distinct-Id'] || '',
        platform: 'web',
        'wrtn-locale': document.documentElement.lang || 'ko-KR',
      };
    }

    request(url) {
      const headers = this.headers();
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, headers, anonymous: false, timeout: 30000,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) return reject(new Error(`Crack API HTTP ${response.status}`));
            try { resolve(JSON.parse(response.responseText)); } catch (error) { reject(new Error(`Crack API returned invalid JSON: ${error.message}`)); }
          },
          onerror: () => reject(new Error('Crack API network error')),
          ontimeout: () => reject(new Error('Crack API timed out')),
        });
      });
    }

    async fetchMessages(episodeId, { full = false, onProgress = null } = {}) {
      const all = [];
      let cursor = '';
      let page = 0;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const json = await this.request(`${API_BASE}/chats/${encodeURIComponent(episodeId)}/messages?${query}`);
        if (json.result !== 'SUCCESS' || !json.data || !Array.isArray(json.data.messages)) throw new Error('Unexpected Crack messages response');
        all.push(...json.data.messages);
        page += 1;
        onProgress?.({ page, messages: all.length, hasNext: Boolean(json.data.hasNext) });
        cursor = json.data.hasNext ? json.data.nextCursor || '' : '';
      } while (full && cursor && page < 100);
      return all;
    }
  }

  class CrackDomFallbackAdapter {
    constructor() {
      this.name = 'DOM fallback';
    }

    findMessageContainers() {
      const optionButtons = [...document.querySelectorAll('button')].filter((button) => {
        const label = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''} ${button.title || ''}`;
        return label.includes('메시지 옵션');
      });
      const containers = [];
      for (const button of optionButtons) {
        let node = button.parentElement;
        while (node?.parentElement) {
          const count = [...node.querySelectorAll('button')].filter((child) => {
            const label = `${child.textContent || ''} ${child.getAttribute('aria-label') || ''} ${child.title || ''}`;
            return label.includes('메시지 옵션');
          }).length;
          if (count === 1 && (node.innerText || '').trim().length > 0) break;
          node = node.parentElement;
        }
        if (node && !containers.includes(node)) containers.push(node);
      }
      return containers;
    }

    async fetchMessages() {
      const containers = this.findMessageContainers();
      if (!containers.length) throw new Error('No message containers found in DOM');
      const ancestor = Utils.commonAncestor(containers);
      let flexDirection = ancestor ? getComputedStyle(ancestor).flexDirection : 'column';
      if (flexDirection !== 'column-reverse') {
        let cursor = ancestor;
        while (cursor && cursor !== document.body) {
          if (getComputedStyle(cursor).flexDirection === 'column-reverse') { flexDirection = 'column-reverse'; break; }
          cursor = cursor.parentElement;
        }
      }
      const ordered = normalizeDomMessageOrder(containers, flexDirection);
      const messages = ordered.map((container) => {
        const text = (container.innerText || '').replace(/메시지 옵션\s*$/u, '').trim();
        const labels = [...container.querySelectorAll('button')].map((button) => `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`).join(' ');
        const role = /(전체 재생|AI 삽화|출력 교정)/.test(labels) ? 'assistant' : 'user';
        const dataId = container.dataset.messageId || container.querySelector('[data-message-id]')?.dataset.messageId;
        const id = dataId || `dom_${Utils.hash(`${role}:${text}`)}`;
        return {
          _id: id,
          role,
          content: text,
          turnId: `dom_turn_${id}`,
          parentTurnId: '',
          status: 'end',
          reroll: false,
          source: 'dom',
        };
      });
      for (let i = 1; i < messages.length; i += 1) messages[i].parentTurnId = messages[i - 1].turnId;
      return messages.reverse();
    }
  }

  const PromptLibrary = {
    overridesProvider: () => ({}),
    onFallback: null,
    warned: new Set(),
    configure(overridesProvider, onFallback = null) { this.overridesProvider = overridesProvider; this.onFallback = onFallback; },
    render(id, values) {
      const overrides = this.overridesProvider();
      const resolved = resolvePromptTemplate(id, overrides);
      if (resolved.source === 'fallback' && !this.warned.has(id)) {
        this.warned.add(id);
        this.onFallback?.(id, resolved.error);
      }
      return renderPromptTemplate(id, values, overrides);
    },
    canonExtractor(input) { return this.render('canonExtractor', { CANON: input.canon, NEW_TURNS: input.turns }); },
    fandomUpdate(input) { return this.render('fandomUpdate', { CANON_UPDATE: input.canonUpdate, FANDOM_STATE: input.fandom, CURRENT_TURN: input.currentTurn, ACTIVITY: input.activity }); },
    redditGenerator(input) { return this.render('redditGenerator', { PERSONAS: input.personas, REACTIONS: input.reactions, ACTIVITY: input.activity }); },
    redditMoreComments(input) { return this.render('redditMoreComments', { POST: input.post, EXISTING_COMMENTS: input.existingComments, CONTINUATION_TOPICS: input.continuationTopics, PERSONAS: input.personas, CANON: input.context?.canon, FANDOM_STATE: input.context?.fandom }); },
    pixivMetadataGenerator(input) { return this.render('pixivMetadataGenerator', { PERSONAS: input.personas, REACTIONS: input.reactions, ACTIVITY: input.activity }); },
    fanwork(input) { return this.render('fanwork', { LANGUAGE: input.language, TARGET_LENGTH: input.targetLength, WORK_METADATA: input.work, AUTHOR: input.author, CANON: input.canon, FANDOM_STATE: input.fandom }); },
    fanworkOutline(input) { return this.render('fanworkOutline', { LANGUAGE: input.language, TARGET_LENGTH: input.targetLength, WORK_METADATA: input.work, AUTHOR: input.author, CANON: input.canon, FANDOM_STATE: input.fandom }); },
    fanworkSection(input) { return this.render('fanworkSection', { FANWORK_PROMPT: this.fanwork(input), OUTLINE: input.outline, SECTION_NUMBER: input.sectionNumber, SECTION_TOTAL: input.sectionTotal, PREVIOUS_TEXT: input.previousText }); },
    continuity(input) { return this.render('continuity', { OUTLINE: input.outline, FANWORK: input.text, CANON: input.canon }); },
    fanworkRevision(input) { return this.render('fanworkRevision', { LANGUAGE: input.language, OUTLINE: input.outline, CANON: input.canon, ISSUES: input.issues, CONTINUITY_NOTES: input.continuityNotes, FANWORK: input.text }); },
  };

  const Schemas = {
    canon: {
      type: 'object', properties: {
        newCanonFacts: { type: 'array', items: { type: 'object', properties: {
          text: { type: 'string' }, category: { type: 'string', enum: ['character', 'relationship', 'event', 'setting', 'knowledge', 'dialogue', 'feeling', 'other'] },
          subject: { type: 'string' }, sourceMessageIds: { type: 'array', items: { type: 'string' } }, sourceTurnIds: { type: 'array', items: { type: 'string' } },
        }, required: ['text', 'category', 'subject', 'sourceMessageIds', 'sourceTurnIds'] } },
        newCanonEvents: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, summary: { type: 'string' }, importance: { type: 'integer' }, characters: { type: 'array', items: { type: 'string' } }, sourceMessageIds: { type: 'array', items: { type: 'string' } }, sourceTurnIds: { type: 'array', items: { type: 'string' } },
        }, required: ['title', 'summary', 'importance', 'characters', 'sourceMessageIds', 'sourceTurnIds'] } },
        characterUpdates: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, update: { type: 'string' }, sourceTurnIds: { type: 'array', items: { type: 'string' } } }, required: ['name', 'update', 'sourceTurnIds'] } },
        relationshipUpdates: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, update: { type: 'string' }, sourceTurnIds: { type: 'array', items: { type: 'string' } } }, required: ['from', 'to', 'update', 'sourceTurnIds'] } },
      }, required: ['newCanonFacts', 'newCanonEvents', 'characterUpdates', 'relationshipUpdates'],
    },
    fandom: {
      type: 'object', properties: {
        interpretations: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, stance: { type: 'string' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } } }, required: ['text', 'stance', 'sourceCanonEventIds'] } },
        shipDeltas: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, momentumDelta: { type: 'number' }, reason: { type: 'string' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } } }, required: ['tag', 'momentumDelta', 'reason', 'sourceCanonEventIds'] } },
        tagDeltas: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, momentumDelta: { type: 'number' }, reason: { type: 'string' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } } }, required: ['tag', 'momentumDelta', 'reason', 'sourceCanonEventIds'] } },
        reactionPoints: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, summary: { type: 'string' }, heat: { type: 'integer' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'summary', 'heat', 'sourceCanonEventIds'] } },
        pendingEvents: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['reddit', 'pixiv', 'cross'] }, dueTurn: { type: 'integer' }, expiryTurn: { type: 'integer' }, payload: { type: 'string' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'dueTurn', 'expiryTurn', 'payload', 'sourceCanonEventIds'] } },
      }, required: ['interpretations', 'shipDeltas', 'tagDeltas', 'reactionPoints', 'pendingEvents'],
    },
    reddit: {
      type: 'object', properties: { posts: { type: 'array', items: { type: 'object', properties: {
        personaId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, category: { type: 'string' }, spoiler: { type: 'boolean' }, score: { type: 'integer' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } }, estimatedCommentCount: { type: 'integer' }, hasMoreComments: { type: 'boolean' }, continuationTopics: { type: 'array', items: { type: 'string' } }, comments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, parentId: { type: ['string', 'null'] }, personaId: { type: 'string' }, body: { type: 'string' }, score: { type: 'integer' } }, required: ['id', 'parentId', 'personaId', 'body', 'score'] } },
      }, required: ['personaId', 'title', 'body', 'category', 'spoiler', 'score', 'sourceCanonEventIds', 'estimatedCommentCount', 'hasMoreComments', 'continuationTopics', 'comments'] } } }, required: ['posts'],
    },
    redditComments: { type: 'object', properties: { hasMoreComments: { type: 'boolean' }, continuationTopics: { type: 'array', items: { type: 'string' } }, comments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, parentId: { type: ['string', 'null'] }, personaId: { type: 'string' }, body: { type: 'string' }, score: { type: 'integer' } }, required: ['id', 'parentId', 'personaId', 'body', 'score'] } } }, required: ['hasMoreComments', 'continuationTopics', 'comments'] },
    pixiv: {
      type: 'object', properties: { works: { type: 'array', items: { type: 'object', properties: {
        authorId: { type: 'string' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ship: { type: 'string' }, caption: { type: 'string' }, summary: { type: 'string' }, fictionalCharacterCount: { type: 'integer' }, views: { type: 'integer' }, bookmarks: { type: 'integer' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } }, workType: { type: 'string' }, tone: { type: 'string' }, seriesTitle: { type: 'string' },
      }, required: ['authorId', 'title', 'tags', 'ship', 'caption', 'summary', 'fictionalCharacterCount', 'views', 'bookmarks', 'sourceCanonEventIds', 'workType', 'tone', 'seriesTitle'] } } }, required: ['works'],
    },
    outline: { type: 'object', properties: { title: { type: 'string' }, premise: { type: 'string' }, continuityConstraints: { type: 'array', items: { type: 'string' } }, sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, plan: { type: 'string' } }, required: ['title', 'plan'] } } }, required: ['title', 'premise', 'continuityConstraints', 'sections'] },
    continuity: { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, continuityNotes: { type: 'array', items: { type: 'string' } } }, required: ['issues', 'continuityNotes'] },
  };

  // Shared request/stream/JSON logic. Provider subclasses only supply `request(payload, options)`
  // (endpoint + auth headers), so FanverseEngine never depends on which backend is active.
  class BaseGenerationClient {
    constructor(getSettings) {
      this.getSettings = getSettings;
    }

    describeHttpError(providerName, status, body) {
      let message = '';
      try { message = JSON.parse(body)?.error?.message || ''; } catch (_) { /* non-JSON error body */ }
      if (!message) {
        try { message = JSON.parse(body)?.[0]?.error?.message || ''; } catch (_) { /* noop */ }
      }
      const hints = {
        400: '요청 형식 또는 model ID를 확인하세요.',
        401: '인증이 만료되었거나 잘못되었습니다.',
        403: '권한이 없거나 API가 사용 설정되지 않았습니다.',
        404: 'model ID, project, location 조합을 확인하세요.',
        429: '할당량/요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.',
      };
      return `${providerName} HTTP ${status}${message ? `: ${message}` : ''}${hints[status] ? ` (${hints[status]})` : ''}`;
    }

    send(url, headers, payload, { stream = false, onChunk = null, providerName = 'Gemini' } = {}) {
      return new Promise((resolve, reject) => {
        let consumed = 0;
        let accumulated = '';
        let sseBuffer = '';
        GM_xmlhttpRequest({
          method: 'POST', url,
          headers,
          data: JSON.stringify(payload), timeout: 180000,
          onprogress: stream ? (response) => {
            const fresh = String(response.responseText || '').slice(consumed);
            consumed += fresh.length;
            sseBuffer += fresh;
            const lines = sseBuffer.split(/\r?\n/);
            sseBuffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              try {
                const text = candidateText(JSON.parse(line.slice(5).trim()));
                if (text) { accumulated += text; onChunk?.(accumulated); }
              } catch (_) { /* partial SSE line; the full body is re-parsed on load */ }
            }
          } : undefined,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(Object.assign(new Error(this.describeHttpError(providerName, response.status, response.responseText)), { status: response.status }));
              return;
            }
            try {
              if (stream) {
                const full = parseSseText(response.responseText);
                if (!full && !accumulated) throw new Error(`${providerName} stream returned no text`);
                resolve(full || accumulated);
                return;
              }
              const json = JSON.parse(response.responseText);
              const text = candidateText(json);
              if (!text) {
                const reason = json.promptFeedback?.blockReason || json.candidates?.[0]?.finishReason;
                throw new Error(`${providerName} returned no text candidate${reason ? ` (${reason})` : ''}`);
              }
              resolve(text);
            } catch (error) { reject(error); }
          },
          onerror: () => reject(new Error(`${providerName} network error`)),
          ontimeout: () => reject(new Error(`${providerName} request timed out`)),
        });
      });
    }

    async generateJson(prompt, schema, { retries = 1, temperature = 0.5 } = {}) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const text = await this.request({
            contents: [{ role: 'user', parts: [{ text: attempt ? `${prompt}\n\nPrevious output failed validation. Return complete valid JSON only.` : prompt }] }],
            generationConfig: buildJsonGenerationConfig(schema, temperature),
          });
          const parsed = Utils.parseJson(text);
          if (!parsed || typeof parsed !== 'object') throw new Error('Structured response is not an object');
          Utils.validateSchema(parsed, schema);
          return parsed;
        } catch (error) {
          lastError = error;
          if (error.status && error.status !== 429 && error.status < 500) break; // auth/config errors won't fix themselves
        }
      }
      throw lastError;
    }

    async generateText(prompt, { stream = false, onChunk = null, temperature = 0.85 } = {}) {
      return this.request({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } }, { stream, onChunk });
    }

    async testConnection() {
      const text = await this.request({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK.' }] }], generationConfig: { temperature: 0 } });
      return text.trim().slice(0, 40);
    }
  }

  class GeminiDeveloperClient extends BaseGenerationClient {
    endpoint(stream = false) {
      const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      return `${GEMINI_BASE}/${encodeURIComponent(resolveModelId(this.getSettings()))}:${method}`;
    }

    ready() { return Boolean(this.getSettings().apiKey); }

    request(payload, options = {}) {
      const settings = this.getSettings();
      if (!settings.apiKey) return Promise.reject(new Error('Gemini Developer API key is not configured'));
      return this.send(this.endpoint(Boolean(options.stream)), { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey }, payload, { ...options, providerName: 'Gemini Developer API' });
    }
  }

  // Vertex AI with a user OAuth access token. Tokens come from Google Identity Services' token
  // model (the documented browser flow for apps without a backend) or are pasted from
  // `gcloud auth print-access-token`. Only the short-lived access token and its expiry are kept
  // (GM storage, never exported); no service-account key, refresh token or client secret is stored.
  class VertexGeminiClient extends BaseGenerationClient {
    constructor(getSettings) {
      super(getSettings);
      this.accessToken = '';
      this.expiresAt = 0;
      this.tokenSource = '';
      this.tokenClient = null;
      this.tokenClientId = '';
    }

    async restore() {
      const saved = await GMStore.get(VERTEX_TOKEN_KEY, null);
      if (saved?.accessToken && Number(saved.expiresAt) > Date.now() + 60000) {
        this.accessToken = saved.accessToken; this.expiresAt = Number(saved.expiresAt); this.tokenSource = saved.source || 'oauth';
      } else if (saved) {
        await GMStore.remove(VERTEX_TOKEN_KEY);
      }
    }

    async persist() {
      if (this.accessToken) await GMStore.set(VERTEX_TOKEN_KEY, { accessToken: this.accessToken, expiresAt: this.expiresAt, source: this.tokenSource });
      else await GMStore.remove(VERTEX_TOKEN_KEY);
    }

    status() {
      const seconds = Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
      return { authenticated: Boolean(this.accessToken && seconds > 30), expiresInSeconds: seconds, source: this.tokenSource, hasToken: Boolean(this.accessToken) };
    }

    ready() { return Boolean(this.getSettings().vertexProjectId && this.status().authenticated); }

    async clearAccessToken() {
      this.accessToken = ''; this.expiresAt = 0; this.tokenSource = '';
      await this.persist();
    }

    async setToken(accessToken, expiresInSeconds, source) {
      this.accessToken = accessToken;
      this.expiresAt = Date.now() + Math.max(60, Number(expiresInSeconds) || 3600) * 1000;
      this.tokenSource = source;
      await this.persist();
      return this.status();
    }

    // Must run inside the click handler: GIS opens its consent popup from requestAccessToken().
    authorize() {
      const settings = this.getSettings();
      if (!settings.vertexOAuthClientId) return Promise.reject(new Error('Vertex OAuth Client ID is not configured'));
      const oauth = globalThis.google?.accounts?.oauth2;
      if (!oauth) return Promise.reject(new Error('Google Identity Services 라이브러리를 불러오지 못했습니다. Tampermonkey @require 로딩을 확인하거나 수동 token을 사용하세요.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Google OAuth window timed out or was closed')), 180000);
        const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
        const onToken = settle(async (response) => {
          if (response?.error || !response?.access_token) { reject(new Error(response?.error_description || response?.error || 'Google OAuth returned no access token')); return; }
          if (typeof oauth.hasGrantedAllScopes === 'function' && !oauth.hasGrantedAllScopes(response, VERTEX_SCOPE)) { reject(new Error('cloud-platform scope가 승인되지 않았습니다. 동의 화면에서 권한을 허용하세요.')); return; }
          resolve(await this.setToken(response.access_token, response.expires_in, 'oauth'));
        });
        const onError = settle((error) => reject(new Error(error?.type === 'popup_closed' ? 'Google 로그인 창이 닫혔습니다.' : error?.type === 'popup_failed_to_open' ? '팝업이 차단되었습니다. 이 사이트의 팝업을 허용하세요.' : error?.message || error?.type || 'Google OAuth popup failed')));
        if (!this.tokenClient || this.tokenClientId !== settings.vertexOAuthClientId) {
          // The token client lives across requests; its callbacks dispatch to whichever request is
          // pending, so an abandoned popup's late response cannot settle a newer request.
          this.tokenClient = oauth.initTokenClient({
            client_id: settings.vertexOAuthClientId,
            scope: VERTEX_SCOPE,
            callback: (response) => this.pendingAuth?.onToken(response),
            error_callback: (error) => this.pendingAuth?.onError(error),
          });
          this.tokenClientId = settings.vertexOAuthClientId;
        }
        this.pendingAuth?.onError({ type: 'superseded', message: '새 로그인 요청으로 대체되었습니다.' });
        const pending = {
          onToken: (response) => { if (this.pendingAuth === pending) { this.pendingAuth = null; onToken(response); } },
          onError: (error) => { if (this.pendingAuth === pending) { this.pendingAuth = null; onError(error); } },
        };
        this.pendingAuth = pending;
        this.tokenClient.requestAccessToken({ prompt: this.accessToken ? '' : 'consent' });
      });
    }

    // Validates a pasted token with Google's tokeninfo endpoint (POST body, so the token never
    // appears in a URL) and records its real expiry.
    async useManualToken(token) {
      const accessToken = String(token || '').trim().replace(/^Bearer\s+/i, '');
      if (!accessToken) throw new Error('access token을 입력하세요.');
      const info = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url: 'https://oauth2.googleapis.com/tokeninfo', timeout: 20000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: `access_token=${encodeURIComponent(accessToken)}`,
          onload: (response) => {
            if (response.status !== 200) { reject(new Error('유효하지 않거나 만료된 access token입니다.')); return; }
            try { resolve(JSON.parse(response.responseText)); } catch (error) { reject(error); }
          },
          onerror: () => reject(new Error('tokeninfo network error')),
          ontimeout: () => reject(new Error('tokeninfo timed out')),
        });
      });
      if (!String(info.scope || '').split(' ').includes(VERTEX_SCOPE)) throw new Error('이 token에는 cloud-platform scope가 없습니다.');
      return this.setToken(accessToken, info.expires_in, 'manual');
    }

    async revoke() {
      const token = this.accessToken;
      await this.clearAccessToken();
      if (!token) return;
      const oauth = globalThis.google?.accounts?.oauth2;
      if (oauth?.revoke) { oauth.revoke(token, () => {}); return; }
      GM_xmlhttpRequest({ method: 'POST', url: 'https://oauth2.googleapis.com/revoke', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: `token=${encodeURIComponent(token)}` });
    }

    request(payload, options = {}) {
      const settings = this.getSettings();
      if (!settings.vertexProjectId) return Promise.reject(new Error('Vertex Google Cloud Project ID is not configured'));
      if (!this.status().authenticated) return Promise.reject(new Error('Vertex access token이 없거나 만료되었습니다. Settings에서 Google 로그인/재인증을 하세요.'));
      return this.send(buildVertexEndpoint(settings, Boolean(options.stream)), { 'Content-Type': 'application/json', Authorization: `Bearer ${this.accessToken}` }, payload, { ...options, providerName: 'Vertex AI' }).catch(async (error) => {
        if (error.status === 401) await this.clearAccessToken();
        throw error;
      });
    }
  }

  // Provider-neutral facade used by FanverseEngine and the UI.
  class GeminiClient {
    constructor(getSettings) {
      this.getSettings = getSettings;
      this.developer = new GeminiDeveloperClient(getSettings);
      this.vertex = new VertexGeminiClient(getSettings);
    }

    client(provider = this.getSettings().provider) { return provider === 'vertex' ? this.vertex : this.developer; }
    providerReady() { return this.client().ready(); }
    generateJson(...args) { return this.client().generateJson(...args); }
    generateText(...args) { return this.client().generateText(...args); }
    testConnection(provider) { return this.client(provider).testConnection(); }
    authorizeVertex() { return this.vertex.authorize(); }
    useManualVertexToken(token) { return this.vertex.useManualToken(token); }
    revokeVertex() { return this.vertex.revoke(); }
    vertexStatus() { return this.vertex.status(); }
    clearVertexToken() { return this.vertex.clearAccessToken(); }
  }

  function seedPersonas() {
    return {
      reddit: [
        { id: 'r_archivist', name: 'canon_archivist', archetype: '설정·근거 분석러', bias: '근거 없는 단정에 엄격함' },
        { id: 'r_shipper', name: 'allroutesopen', archetype: '다CP 팬', bias: '삼각관계와 다인 관계를 즐김' },
        { id: 'r_noromance', name: 'platonic_reading', archetype: '노맨스 해석파', bias: '우정과 계급 서사를 강조' },
        { id: 'r_longform', name: 'paragraph_person', archetype: '장문 분석러', bias: '상징과 반복 대사를 추적' },
        { id: 'r_meme', name: 'loweffortcanon', archetype: '밈 계정', bias: '진지한 장면도 밈으로 소비' },
        { id: 'r_veteran', name: 'since_episode_one', archetype: '고인물', bias: '초기 장면과 현재를 비교' },
        { id: 'r_newbie', name: 'binged_it_today', archetype: '뉴비', bias: '감정적이고 솔직한 반응' },
        { id: 'r_debater', name: 'citation_needed', archetype: '논쟁러', bias: '과대해석에 시비를 검' },
      ],
      pixiv: [
        { id: 'p_psych', name: '薄明のノート', specialty: '원작 분위기·심리묘사 장편', style: '여백이 많은 문장과 내면 독백' },
        { id: 'p_sweet', name: '砂糖雨', specialty: '달달한 단편', style: '짧고 부드러운 일상물' },
        { id: 'p_canon', name: '余白観測所', specialty: '原作軸·幕間', style: '원작 대사와 장면 사이를 정교하게 메움' },
        { id: 'p_au', name: 'もしもの窓', specialty: 'IF/AU', style: '과감한 분기와 세계관 치환' },
        { id: 'p_multi', name: '交差点クラブ', specialty: '삼각·다인 관계', style: '관계 균형과 질투의 군상극' },
        { id: 'p_comedy', name: '放課後バグ', specialty: '개그·밈 연성', style: '빠른 대화와 과장된 오해' },
      ],
    };
  }

  function createWorld(info) {
    return {
      id: info.id, storyId: info.storyId, episodeId: info.episodeId,
      schemaVersion: DB_VERSION, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sync: { adapter: 'none', status: 'new', lastAt: null, error: null },
      activeMessageIds: [], processedTurnIds: [], turnCount: 0, lastProcessedTurn: 0,
      canonRevision: 1,
      canon: { facts: [], characters: [], relationships: [], recentEventIds: [] },
      fandom: { interpretations: [], ships: [], tags: [], history: [], recentPlatformSignals: [] },
      personas: seedPersonas(),
      badges: { phone: 0, reddit: 0, pixiv: 0 },
      importJob: null,
    };
  }

  class FanverseEngine {
    constructor(db, api, dom, gemini, getSettings, notify) {
      this.db = db; this.api = api; this.dom = dom; this.gemini = gemini;
      this.getSettings = getSettings; this.notify = notify;
      this.worldInfo = null; this.world = null; this.syncing = false; this.updating = false;
    }

    async attach(info) {
      this.worldInfo = info;
      this.world = await this.db.get(STORES.worlds, info.id) || createWorld(info);
      this.world.canonRevision = Number(this.world.canonRevision) || 1;
      this.world.fandom ||= { interpretations: [], ships: [], tags: [], history: [] };
      this.world.fandom.recentPlatformSignals ||= [];
      this.world.fandom.history ||= [];
      this.world.badges ||= { phone: 0, reddit: 0, pixiv: 0 };
      await this.db.put(STORES.worlds, this.world);
      return this.world;
    }

    async saveWorld() {
      this.world.updatedAt = new Date().toISOString();
      await this.db.put(STORES.worlds, this.world);
    }

    async sync({ full = false, onProgress = null, allowUpdate = true } = {}) {
      if (this.syncing || !this.worldInfo) return null;
      this.syncing = true;
      const wasNeverSynced = this.world.sync.status === 'new';
      this.notify('sync', '원작 로그 동기화 중…');
      let messages;
      try {
        try {
          messages = await this.api.fetchMessages(this.worldInfo.episodeId, { full, onProgress });
          this.world.sync = { adapter: 'api', status: 'ok', lastAt: new Date().toISOString(), error: null };
        } catch (apiError) {
          messages = await this.dom.fetchMessages();
          this.world.sync = { adapter: 'dom', status: 'fallback', lastAt: new Date().toISOString(), error: apiError.message };
        }
        const records = messages.map((message) => ({ ...message, pk: `${this.world.id}:${message._id}`, worldId: this.world.id, contentHash: Utils.hash(message.content || '') }));
        if (full && this.world.sync.adapter === 'api') {
          const receivedIds = new Set(records.map((message) => message._id));
          await this.db.deleteWhereWorld(STORES.messages, this.world.id, (message) => !receivedIds.has(message._id));
        }
        await this.db.bulkPut(STORES.messages, records);
        const all = await this.db.getAllByWorld(STORES.messages, this.world.id);
        const newest = records[0];
        const active = resolveActiveBranch(newest ? [newest, ...all.filter((message) => message._id !== newest._id)] : all);
        const turns = buildTurns(active);
        const activeTurnIds = new Set(turns.map((turn) => turn.id));
        const branchChanged = this.world.processedTurnIds.some((id) => !activeTurnIds.has(id));
        if (branchChanged && !this.world.needsCanonRebuild) {
          this.world.needsCanonRebuild = true;
          await this.suspendPendingForBranchChange();
        }
        this.world.activeMessageIds = active.map((message) => message._id);
        this.world.turnCount = turns.length;
        await this.saveWorld();
        this.notify('sync', this.world.sync.adapter === 'api' ? `API 동기화 완료 · ${turns.length} turns` : `Crack API sync failed — DOM fallback active · ${turns.length} turns`);
        if (wasNeverSynced && turns.length > this.getSettings().turnsPerUpdate * 2) this.world.needsImport = true;
        await this.saveWorld();
        if (allowUpdate && !this.world.needsImport && !this.world.needsCanonRebuild) await this.maybeUpdate(turns);
        return { messages: active, turns };
      } finally {
        this.syncing = false;
      }
    }

    async allActiveTurns() {
      const all = await this.db.getAllByWorld(STORES.messages, this.world.id);
      const activeSet = new Set(this.world.activeMessageIds);
      const active = all.filter((message) => activeSet.has(message._id));
      const position = new Map(this.world.activeMessageIds.map((id, index) => [id, index]));
      active.sort((a, b) => position.get(a._id) - position.get(b._id));
      return buildTurns(active);
    }

    async maybeUpdate(turns = null) {
      const settings = this.getSettings();
      if (!settings.autoUpdate || this.updating) return;
      const activeTurns = turns || await this.allActiveTurns();
      const processed = new Set(this.world.processedTurnIds);
      const unprocessed = activeTurns.filter((turn) => !processed.has(turn.id));
      if (unprocessed.length < settings.turnsPerUpdate) return;
      if (!this.gemini.providerReady()) {
        // Turns are kept unprocessed, so the update simply runs once the provider is usable again.
        if (settings.provider === 'vertex' && this.gemini.vertexStatus().hasToken === false && !this.warnedProviderUnready) {
          this.warnedProviderUnready = true;
          this.notify('error', 'Vertex access token이 없거나 만료되어 자동 갱신을 보류했습니다. Settings에서 재인증하세요.');
        }
        return;
      }
      this.warnedProviderUnready = false;
      await this.runFandomUpdate(unprocessed.slice(0, settings.turnsPerUpdate));
    }

    canonSnapshot() {
      return {
        facts: this.world.canon.facts.slice(-120),
        characters: this.world.canon.characters.slice(-40),
        relationships: this.world.canon.relationships.slice(-60),
      };
    }

    fandomSnapshot() {
      return {
        interpretations: this.world.fandom.interpretations.slice(-80),
        ships: this.world.fandom.ships.slice(-40), tags: this.world.fandom.tags.slice(-80),
        recentPlatformSignals: (this.world.fandom.recentPlatformSignals || []).slice(-20),
      };
    }

    async buildCanonContext(sourceCanonEventIds = [], hints = []) {
      const allEvents = (await this.db.getAllByWorld(STORES.canonEvents, this.world.id)).sort((a, b) => a.turn - b.turn);
      const sourceIds = new Set(sourceCanonEventIds || []);
      const sourceEvents = allEvents.filter((event) => sourceIds.has(event.id));
      const characterNames = new Set(sourceEvents.flatMap((event) => event.characters || []));
      const hintText = (hints || []).join(' ').toLowerCase();
      for (const state of [...this.world.canon.characters, ...this.world.canon.relationships]) {
        const names = [state.name, state.from, state.to].filter(Boolean);
        if (names.some((name) => hintText.includes(String(name).toLowerCase()))) names.forEach((name) => characterNames.add(name));
      }
      const relatedPastEvents = allEvents.filter((event) => !sourceIds.has(event.id) && ((event.characters || []).some((name) => characterNames.has(name)) || (event.title && hintText.includes(event.title.toLowerCase())))).slice(-50);
      const facts = this.world.canon.facts.slice(-180);
      const characterState = this.world.canon.characters.slice(-100);
      const relationshipState = this.world.canon.relationships.slice(-120);
      const focus = {
        characterNames: [...characterNames],
        facts: facts.filter((fact) => !characterNames.size || characterNames.has(fact.subject) || [...characterNames].some((name) => fact.text?.includes(name))),
        characterState: characterState.filter((state) => !characterNames.size || characterNames.has(state.name)),
        relationshipState: relationshipState.filter((state) => !characterNames.size || characterNames.has(state.from) || characterNames.has(state.to)),
      };
      return { facts, characterState, relationshipState, sourceEvents, relatedPastEvents, recentEvents: allEvents.slice(-30), focus };
    }

    prepareTurns(turns) {
      return turns.map((turn) => ({
        turnId: turn.id, messageIds: [turn.userMessageId, turn.assistantMessageId],
        user: turn.user.slice(0, 16000), assistant: turn.assistant.slice(0, 24000),
      }));
    }

    validateSources(items, turns) {
      const messageIds = new Set(turns.flatMap((turn) => [turn.userMessageId, turn.assistantMessageId]));
      const turnIds = new Set(turns.map((turn) => turn.id));
      return (items || []).filter((item) => {
        const messagesOk = (item.sourceMessageIds || []).every((id) => messageIds.has(id));
        const turnsOk = (item.sourceTurnIds || []).every((id) => turnIds.has(id));
        return messagesOk && turnsOk;
      });
    }

    async extractCanon(turns) {
      const result = await this.gemini.generateJson(PromptLibrary.canonExtractor({ canon: this.canonSnapshot(), turns: this.prepareTurns(turns) }), Schemas.canon, { retries: 1, temperature: 0.2 });
      result.newCanonFacts = this.validateSources(result.newCanonFacts, turns);
      result.newCanonEvents = this.validateSources(result.newCanonEvents, turns);
      result.characterUpdates = this.validateSources(result.characterUpdates, turns);
      result.relationshipUpdates = this.validateSources(result.relationshipUpdates, turns);
      return result;
    }

    mergeMomentum(target, deltas, currentTurn) {
      const map = new Map(target.map((item) => [item.tag, item]));
      for (const delta of deltas || []) {
        const current = map.get(delta.tag) || { tag: delta.tag, worksCount: 0, bookmarks: 0, redditMentions: 0, momentum: 0, recentGrowth: 0, relatedCanonEventIds: [] };
        current.recentGrowth = Number(delta.momentumDelta) || 0;
        current.momentum = Utils.clamp(current.momentum + current.recentGrowth, -100, 100);
        current.reason = delta.reason;
        current.lastTurn = currentTurn;
        current.relatedCanonEventIds = [...new Set([...current.relatedCanonEventIds, ...(delta.sourceCanonEventIds || [])])].slice(-30);
        map.set(delta.tag, current);
      }
      return [...map.values()].sort((a, b) => b.momentum - a.momentum);
    }

    async applyCanon(result, currentTurn) {
      const facts = (result.newCanonFacts || []).map((item) => ({ ...item, id: `fact_${Utils.hash(`${item.text}:${item.sourceTurnIds?.join(',')}`)}`, worldId: this.world.id, addedTurn: currentTurn }));
      const known = new Set(this.world.canon.facts.map((item) => item.id));
      this.world.canon.facts.push(...facts.filter((item) => !known.has(item.id)));
      for (const update of result.characterUpdates || []) this.world.canon.characters.push({ ...update, id: Utils.uid('character'), addedTurn: currentTurn });
      for (const update of result.relationshipUpdates || []) this.world.canon.relationships.push({ ...update, id: Utils.uid('relationship'), addedTurn: currentTurn });
      const events = (result.newCanonEvents || []).map((event) => ({ ...event, id: `canon_${Utils.hash(`${event.title}:${event.sourceTurnIds?.join(',')}`)}`, worldId: this.world.id, turn: currentTurn, createdAt: new Date().toISOString() }));
      await this.db.bulkPut(STORES.canonEvents, events);
      this.world.canon.recentEventIds = [...this.world.canon.recentEventIds, ...events.map((event) => event.id)].slice(-80);
      return events;
    }

    async evolveFandom(canonUpdate, canonEvents, currentTurn) {
      const fandomResult = await this.gemini.generateJson(PromptLibrary.fandomUpdate({
        canonUpdate: { ...canonUpdate, newCanonEvents: canonEvents }, fandom: this.fandomSnapshot(),
        currentTurn, activity: this.getSettings().activity,
      }), Schemas.fandom, { retries: 1, temperature: 0.65 });
      const interpretations = (fandomResult.interpretations || []).map((item) => ({ ...item, id: Utils.uid('interpretation'), addedTurn: currentTurn }));
      this.world.fandom.interpretations.push(...interpretations);
      this.world.fandom.ships = this.mergeMomentum(this.world.fandom.ships, fandomResult.shipDeltas, currentTurn);
      this.world.fandom.tags = this.mergeMomentum(this.world.fandom.tags, fandomResult.tagDeltas, currentTurn);
      const pending = (fandomResult.pendingEvents || []).map((event) => {
        const kind = ['reddit', 'pixiv', 'cross'].includes(event.kind) ? event.kind : 'reddit';
        const dueTurn = Math.max(currentTurn, Number(event.dueTurn) || currentTurn);
        const expiryTurn = Math.max(dueTurn, Number(event.expiryTurn) || dueTurn + 20);
        const sourceCanonEventIds = [...new Set(event.sourceCanonEventIds || [])];
        const id = `pending_${Utils.hash(`${this.world.id}:${this.world.canonRevision}:${kind}:${dueTurn}:${event.payload}:${sourceCanonEventIds.sort().join(',')}`)}`;
        return { ...event, id, kind, dueTurn, expiryTurn, sourceCanonEventIds, worldId: this.world.id, createdTurn: currentTurn, branchRevision: this.world.canonRevision, status: 'pending', generated: false, generatedPlatforms: { reddit: false, pixiv: false } };
      });
      const existingPending = new Map((await this.db.getAllByWorld(STORES.pendingEvents, this.world.id)).map((event) => [event.id, event]));
      const dedupedPending = pending.map((event) => {
        const existing = existingPending.get(event.id);
        if (!existing) return event;
        return { ...event, ...existing, expiryTurn: Math.max(event.expiryTurn, existing.expiryTurn || 0), sourceCanonEventIds: [...new Set([...(existing.sourceCanonEventIds || []), ...(event.sourceCanonEventIds || [])])] };
      });
      await this.db.bulkPut(STORES.pendingEvents, dedupedPending);
      await this.executePendingEvents(currentTurn, { immediate: fandomResult.reactionPoints || [], canonEvents, interpretations });
      this.world.fandom.history.push({ turn: currentTurn, at: new Date().toISOString(), canonEventIds: canonEvents.map((event) => event.id), interpretationIds: interpretations.map((item) => item.id) });
      return { fandomResult, interpretations };
    }

    async suspendPendingForBranchChange() {
      const pending = await this.db.getAllByWorld(STORES.pendingEvents, this.world.id);
      for (const event of pending) {
        if (!['generated', 'expired', 'superseded'].includes(event.status)) {
          event.status = 'suspended';
          event.suspendedReason = 'canon-branch-changed';
          await this.db.put(STORES.pendingEvents, event);
        }
      }
    }

    async executePendingEvents(currentTurn, context = {}) {
      const allPending = await this.db.getAllByWorld(STORES.pendingEvents, this.world.id);
      const plan = planPendingExecution(allPending, currentTurn, this.world.canonRevision);
      for (const event of plan.expired) {
        event.status = 'expired'; event.expiredAtTurn = currentTurn;
        await this.db.put(STORES.pendingEvents, event);
      }
      const redditOnly = plan.reddit.filter((event) => event.kind === 'reddit');
      const redditCross = plan.reddit.filter((event) => event.kind === 'cross');
      const pixivOnly = plan.pixiv.filter((event) => event.kind === 'pixiv');
      const pixivCross = plan.pixiv.filter((event) => event.kind === 'cross');
      let crossRedditPosts = [];
      const runRedditGroup = async (events, isCross) => {
        if (!events.length) return [];
        try {
          const posts = await this.generateReddit({ ...context, due: events, crossLink: isCross }, currentTurn, events.map((event) => event.id));
          for (const event of events) {
            event.generatedPlatforms ||= { reddit: false, pixiv: false };
            event.generatedPlatforms.reddit = true;
            event.redditGeneratedTurn = currentTurn;
            event.lastError = null;
            await this.db.put(STORES.pendingEvents, event);
          }
          return posts;
        } catch (error) {
          for (const event of events) { event.status = 'failed'; event.lastError = `reddit: ${error.message}`; await this.db.put(STORES.pendingEvents, event); }
          this.notify('error', `Reddit pending event retry scheduled: ${error.message}`);
          return [];
        }
      };
      await runRedditGroup(redditOnly, false);
      crossRedditPosts = await runRedditGroup(redditCross, true);
      const runPixivGroup = async (events, crossPosts = []) => {
        if (!events.length) return [];
        try {
          const works = await this.generatePixiv({ ...context, due: events, crossRedditPosts: crossPosts.map((post) => ({ id: post.id, title: post.title, body: post.body, score: post.score })), crossLink: Boolean(crossPosts.length) }, currentTurn, events.map((event) => event.id));
          for (const event of events) {
            event.generatedPlatforms ||= { reddit: false, pixiv: false };
            event.generatedPlatforms.pixiv = true;
            event.pixivGeneratedTurn = currentTurn;
            event.lastError = null;
            await this.db.put(STORES.pendingEvents, event);
          }
          return works;
        } catch (error) {
          for (const event of events) { event.status = 'failed'; event.lastError = `pixiv: ${error.message}`; await this.db.put(STORES.pendingEvents, event); }
          this.notify('error', `Pixiv pending event retry scheduled: ${error.message}`);
          return [];
        }
      };
      await runPixivGroup(pixivOnly);
      if (pixivCross.length && !crossRedditPosts.length) {
        const crossIds = new Set(pixivCross.map((event) => event.id));
        crossRedditPosts = (await this.db.getAllByWorld(STORES.redditPosts, this.world.id)).filter((post) => post.sourcePendingEventIds?.some((id) => crossIds.has(id)));
      }
      await runPixivGroup(pixivCross, crossRedditPosts);
      const touched = new Set([...plan.reddit, ...plan.pixiv].map((event) => event.id));
      for (const event of allPending.filter((item) => touched.has(item.id))) {
        const latest = await this.db.get(STORES.pendingEvents, event.id) || event;
        const generated = latest.generatedPlatforms || {};
        const complete = latest.kind === 'reddit' ? generated.reddit : latest.kind === 'pixiv' ? generated.pixiv : generated.reddit && generated.pixiv;
        latest.generated = Boolean(complete);
        latest.status = complete ? 'generated' : (latest.lastError ? 'failed' : 'pending');
        if (complete) latest.generatedTurn = currentTurn;
        await this.db.put(STORES.pendingEvents, latest);
      }
      return plan;
    }

    async runFandomUpdate(turns) {
      if (this.updating) return;
      this.updating = true;
      const currentTurn = this.world.lastProcessedTurn + turns.length;
      const worldBeforeUpdate = Utils.clone(this.world);
      try {
        this.notify('update', `Canon 분석 중 · ${turns.length} turns`);
        const canonResult = await this.extractCanon(turns);
        const canonEvents = await this.applyCanon(canonResult, currentTurn);
        this.notify('update', '팬덤 반응 숙성 중…');
        await this.evolveFandom(canonResult, canonEvents, currentTurn);
        this.world.processedTurnIds = [...new Set([...this.world.processedTurnIds, ...turns.map((turn) => turn.id)])];
        this.world.lastProcessedTurn = currentTurn;
        await this.saveWorld();
        this.notify('update', `Fanverse 갱신 완료 · turn ${currentTurn}`);
      } catch (error) {
        await Promise.all([
          this.db.deleteWhereWorld(STORES.canonEvents, this.world.id, (row) => row.turn === currentTurn),
          this.db.deleteWhereWorld(STORES.redditPosts, this.world.id, (row) => row.turn === currentTurn),
          this.db.deleteWhereWorld(STORES.pixivWorks, this.world.id, (row) => row.turn === currentTurn),
          this.db.deleteWhereWorld(STORES.pendingEvents, this.world.id, (row) => row.createdTurn === currentTurn),
        ]);
        this.world = worldBeforeUpdate;
        await this.saveWorld();
        this.notify('error', `Fanverse update failed: ${error.message}`);
        throw error;
      } finally { this.updating = false; }
    }

    activityLimit(kind) {
      const table = { Quiet: { reddit: 1, pixiv: 1 }, Normal: { reddit: 2, pixiv: 2 }, Active: { reddit: 4, pixiv: 3 }, Chaos: { reddit: 6, pixiv: 5 } };
      return table[this.getSettings().activity]?.[kind] || 2;
    }

    initialCommentLimit() {
      return { Quiet: 2, Normal: 3, Active: 4, Chaos: 5 }[this.getSettings().activity] || 3;
    }

    normalizeComments(comments, postId, existingComments = []) {
      const personaIds = new Set(this.world.personas.reddit.map((persona) => persona.id));
      const existingIds = new Set(existingComments.map((comment) => comment.id));
      const idMap = new Map();
      (comments || []).forEach((comment, index) => idMap.set(comment.id, `comment_${Utils.hash(`${postId}:${existingComments.length + index}:${comment.personaId}:${comment.body}`)}`));
      return (comments || []).map((comment, index) => {
        const mappedParent = comment.parentId ? (idMap.get(comment.parentId) || (existingIds.has(comment.parentId) ? comment.parentId : null)) : null;
        return { ...comment, id: idMap.get(comment.id) || `comment_${Utils.hash(`${postId}:${existingComments.length + index}`)}`, parentId: mappedParent, personaId: personaIds.has(comment.personaId) ? comment.personaId : this.world.personas.reddit[0].id, createdAt: new Date(Date.now() - ((comments || []).length - index) * 47000).toISOString() };
      });
    }

    async generateReddit(reactions, currentTurn, sourcePendingEventIds = []) {
      const result = await this.gemini.generateJson(PromptLibrary.redditGenerator({ personas: this.world.personas.reddit, reactions, activity: this.getSettings().activity }), Schemas.reddit, { retries: 1, temperature: 0.85 });
      const personaIds = new Set(this.world.personas.reddit.map((persona) => persona.id));
      const eventKey = [...sourcePendingEventIds].sort().join(',');
      const posts = (result.posts || []).slice(0, this.activityLimit('reddit')).map((post, index) => {
        const id = `reddit_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`;
        const comments = this.normalizeComments((post.comments || []).slice(0, this.initialCommentLimit()), id);
        const estimatedCommentCount = Math.max(comments.length, Number(post.estimatedCommentCount) || comments.length);
        return { ...post, id, worldId: this.world.id, turn: currentTurn, createdAt: new Date().toISOString(), sourcePendingEventIds: [...sourcePendingEventIds], personaId: personaIds.has(post.personaId) ? post.personaId : this.world.personas.reddit[0].id, comments, estimatedCommentCount, hasMoreComments: Boolean(post.hasMoreComments || estimatedCommentCount > comments.length), continuationTopics: post.continuationTopics || [], commentBatchesGenerated: 0 };
      });
      if (!posts.length) throw new Error('Gemini returned no Reddit posts for due events');
      await this.db.bulkPut(STORES.redditPosts, posts);
      const redditText = posts.map((post) => `${post.title} ${post.body} ${post.comments.map((comment) => comment.body).join(' ')}`).join(' ');
      for (const collection of [this.world.fandom.ships, this.world.fandom.tags]) {
        for (const item of collection) if (redditText.includes(item.tag)) item.redditMentions = (item.redditMentions || 0) + 1;
      }
      this.world.fandom.recentPlatformSignals = [...(this.world.fandom.recentPlatformSignals || []), ...posts.filter((post) => post.score >= 100).map((post) => ({ kind: 'reddit', turn: currentTurn, summary: `Reddit 화제: ${post.title}`, score: post.score, sourceCanonEventIds: post.sourceCanonEventIds }))].slice(-30);
      this.world.badges.reddit += posts.length; this.world.badges.phone += posts.length;
      return posts;
    }

    async loadMoreRedditComments(post) {
      if (!post?.hasMoreComments) return post;
      const context = await this.buildCanonContext(post.sourceCanonEventIds || [], [post.title, post.body, ...(post.continuationTopics || [])]);
      const result = await this.gemini.generateJson(PromptLibrary.redditMoreComments({
        post: { id: post.id, title: post.title, body: post.body, category: post.category, sourceCanonEventIds: post.sourceCanonEventIds },
        existingComments: post.comments,
        continuationTopics: post.continuationTopics || [],
        personas: this.world.personas.reddit,
        context: { canon: context, fandom: this.fandomSnapshot() },
      }), Schemas.redditComments, { retries: 1, temperature: 0.85 });
      const batch = this.normalizeComments((result.comments || []).slice(0, 12), post.id, post.comments || []);
      if (!batch.length) throw new Error('Gemini returned no additional comments');
      const known = new Set((post.comments || []).map((comment) => comment.id));
      post.comments = [...(post.comments || []), ...batch.filter((comment) => !known.has(comment.id))];
      post.commentBatchesGenerated = (post.commentBatchesGenerated || 0) + 1;
      post.continuationTopics = result.continuationTopics || post.continuationTopics || [];
      post.estimatedCommentCount = Math.max(post.estimatedCommentCount || 0, post.comments.length + (result.hasMoreComments ? 6 : 0));
      post.hasMoreComments = Boolean(result.hasMoreComments);
      post.lastCommentBatchAt = new Date().toISOString();
      await this.db.put(STORES.redditPosts, post);
      return post;
    }

    async voteRedditPost(postId, requestedVote) {
      const post = await this.db.get(STORES.redditPosts, postId);
      if (!post) throw new Error('게시물을 찾을 수 없습니다.');
      const previous = Number(post.userVote) || 0;
      const next = previous === requestedVote ? 0 : requestedVote;
      post.score = (Number(post.score) || 0) + next - previous;
      post.userVote = next;
      await this.db.put(STORES.redditPosts, post);
      return post;
    }

    async voteRedditComment(postId, commentId, requestedVote) {
      const post = await this.db.get(STORES.redditPosts, postId);
      const comment = post?.comments?.find((item) => item.id === commentId);
      if (!comment) throw new Error('댓글을 찾을 수 없습니다.');
      const previous = Number(comment.userVote) || 0;
      const next = previous === requestedVote ? 0 : requestedVote;
      comment.score = (Number(comment.score) || 0) + next - previous;
      comment.userVote = next;
      await this.db.put(STORES.redditPosts, post);
      return post;
    }

    async toggleRedditJoin() {
      this.world.redditJoined = !this.world.redditJoined;
      await this.saveWorld();
      return this.world.redditJoined;
    }

    async togglePixivBookmark(workId) {
      const work = await this.db.get(STORES.pixivWorks, workId);
      if (!work) throw new Error('작품을 찾을 수 없습니다.');
      work.userBookmarked = !work.userBookmarked;
      work.bookmarks = Math.max(0, (Number(work.bookmarks) || 0) + (work.userBookmarked ? 1 : -1));
      await this.db.put(STORES.pixivWorks, work);
      return work;
    }

    async togglePixivLike(workId) {
      const work = await this.db.get(STORES.pixivWorks, workId);
      if (!work) throw new Error('작품을 찾을 수 없습니다.');
      work.userLiked = !work.userLiked;
      await this.db.put(STORES.pixivWorks, work);
      return work;
    }

    async togglePixivFollow(authorId) {
      const follows = new Set(this.world.pixivFollows || []);
      if (follows.has(authorId)) follows.delete(authorId); else follows.add(authorId);
      this.world.pixivFollows = [...follows];
      await this.saveWorld();
      return follows.has(authorId);
    }

    async generatePixiv(reactions, currentTurn, sourcePendingEventIds = []) {
      const result = await this.gemini.generateJson(PromptLibrary.pixivMetadataGenerator({ personas: this.world.personas.pixiv, reactions, activity: this.getSettings().activity }), Schemas.pixiv, { retries: 1, temperature: 0.9 });
      const personaIds = new Set(this.world.personas.pixiv.map((persona) => persona.id));
      const eventKey = [...sourcePendingEventIds].sort().join(',');
      const existing = await this.db.getAllByWorld(STORES.pixivWorks, this.world.id);
      const existingById = new Map(existing.map((work) => [work.id, work]));
      const works = (result.works || []).slice(0, this.activityLimit('pixiv')).map((work, index) => ({
        ...work, id: `pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`, worldId: this.world.id, turn: currentTurn, publishOrder: Date.now() + index,
        createdAt: existingById.get(`pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`)?.createdAt || new Date().toISOString(),
        hasFullText: existingById.get(`pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`)?.hasFullText || false,
        userBookmarked: existingById.get(`pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`)?.userBookmarked || false,
        sourcePendingEventIds: [...sourcePendingEventIds],
        authorId: personaIds.has(work.authorId) ? work.authorId : this.world.personas.pixiv[0].id,
      }));
      if (!works.length) throw new Error('Gemini returned no Pixiv works for due events');
      await this.db.bulkPut(STORES.pixivWorks, works);
      for (const work of works) {
        for (const collection of [this.world.fandom.ships, this.world.fandom.tags]) {
          for (const item of collection) {
            if (work.ship === item.tag || work.tags.includes(item.tag)) {
              item.worksCount = (item.worksCount || 0) + 1;
              item.bookmarks = (item.bookmarks || 0) + work.bookmarks;
            }
          }
        }
      }
      this.world.fandom.recentPlatformSignals = [...(this.world.fandom.recentPlatformSignals || []), ...works.filter((work) => work.bookmarks >= 500).map((work) => ({ kind: 'pixiv', turn: currentTurn, summary: `Pixiv 인기작: ${work.title}`, bookmarks: work.bookmarks, tags: work.tags, sourceCanonEventIds: work.sourceCanonEventIds }))].slice(-30);
      this.world.badges.pixiv += works.length; this.world.badges.phone += works.length;
      return works;
    }

    async generateFanwork(work, onChunk) {
      const cached = await this.db.get(STORES.fanworks, work.id);
      if (cached) return cached;
      const settings = this.getSettings();
      const author = this.world.personas.pixiv.find((persona) => persona.id === work.authorId);
      const canonContext = await this.buildCanonContext(work.sourceCanonEventIds || [], [work.title, work.ship, work.summary, ...(work.tags || [])]);
      let text; let outline = null; let continuity = null; let initialContinuity = null; let revisionApplied = false;
      const input = { work, author, canon: canonContext, fandom: this.fandomSnapshot(), language: settings.fanworkLanguage, targetLength: settings.fanworkTargetLength };
      if (settings.fanworkTargetLength > 8000) {
        outline = await this.gemini.generateJson(PromptLibrary.fanworkOutline(input), Schemas.outline, { retries: 1, temperature: 0.65 });
        const sections = [];
        for (let i = 0; i < outline.sections.slice(0, 3).length; i += 1) {
          const sectionPrompt = PromptLibrary.fanworkSection({ ...input, outline, sectionNumber: i + 1, sectionTotal: 3, previousText: sections.join('\n\n').slice(-12000) });
          const section = await this.gemini.generateText(sectionPrompt, { stream: settings.streaming, onChunk: (chunk) => onChunk?.([...sections, chunk].join('\n\n')) });
          sections.push(section);
        }
        text = sections.join('\n\n');
        initialContinuity = await this.gemini.generateJson(PromptLibrary.continuity({ outline, text, canon: canonContext }), Schemas.continuity, { retries: 1, temperature: 0.2 });
        continuity = initialContinuity;
        if (initialContinuity.issues?.length) {
          onChunk?.(`${text}\n\n[continuity revision in progress…]`);
          text = await this.gemini.generateText(PromptLibrary.fanworkRevision({ outline, text, canon: canonContext, issues: initialContinuity.issues, continuityNotes: initialContinuity.continuityNotes, language: settings.fanworkLanguage }), { stream: false, temperature: 0.55 });
          revisionApplied = true;
          continuity = await this.gemini.generateJson(PromptLibrary.continuity({ outline, text, canon: canonContext }), Schemas.continuity, { retries: 1, temperature: 0.15 });
          onChunk?.(text);
        }
      } else {
        text = await this.gemini.generateText(PromptLibrary.fanwork(input), { stream: settings.streaming, onChunk });
      }
      const record = { id: work.id, worldId: this.world.id, text, outline, continuity, initialContinuity, revisionApplied, generatedAt: new Date().toISOString(), language: settings.fanworkLanguage };
      await this.db.put(STORES.fanworks, record);
      work.hasFullText = true;
      await this.db.put(STORES.pixivWorks, work);
      return record;
    }

    async importHistory(onProgress) {
      if (this.world.needsCanonRebuild) throw new Error('재생성/삭제된 원작 분기가 있습니다. Canon rebuild를 먼저 실행하세요.');
      if (!this.world.importJob || this.world.importJob.mode !== 'history') this.world.importJob = { mode: 'history', status: 'fetching', nextIndex: 0, total: 0, fandomMilestone: 0 };
      await this.saveWorld();
      const synced = await this.sync({ full: true, allowUpdate: false, onProgress: (info) => onProgress?.(`원작 불러오는 중 · ${info.messages} messages`) });
      const turns = synced.turns;
      this.world.importJob.total = turns.length;
      this.world.importJob.status = 'analyzing';
      await this.saveWorld();
      const chunkSize = 10;
      for (let index = this.world.importJob.nextIndex || 0; index < turns.length; index += chunkSize) {
        const chunk = turns.slice(index, index + chunkSize);
        const canonResult = await this.extractCanon(chunk);
        const currentTurn = index + chunk.length;
        await this.applyCanon(canonResult, currentTurn);
        await this.executePendingEvents(currentTurn, { canonEvents: [], interpretations: [], immediate: [] });
        this.world.importJob.nextIndex = index + chunk.length;
        await this.saveWorld();
        onProgress?.(`원작 분석 중 · ${Math.min(index + chunk.length, turns.length)} / ${turns.length} turns`);
        const milestoneDue = currentTurn - (this.world.importJob.fandomMilestone || 0) >= 30 || currentTurn >= turns.length;
        if (milestoneDue) {
          const allCanonEvents = await this.db.getAllByWorld(STORES.canonEvents, this.world.id);
          const milestoneEvents = allCanonEvents.filter((event) => event.turn > (this.world.importJob.fandomMilestone || 0) && event.turn <= currentTurn);
          if (!milestoneEvents.length) continue;
          onProgress?.(`과거 팬덤 형성 중 · ${currentTurn} / ${turns.length} turns`);
          await this.evolveFandom({ newCanonEvents: milestoneEvents, backfill: true }, milestoneEvents, currentTurn);
          this.world.importJob.fandomMilestone = currentTurn;
          await this.saveWorld();
        }
      }
      this.world.processedTurnIds = turns.map((turn) => turn.id);
      this.world.lastProcessedTurn = turns.length;
      this.world.needsImport = false;
      this.world.importJob = { mode: 'history', status: 'complete', nextIndex: turns.length, total: turns.length };
      await this.saveWorld();
      return turns.length;
    }

    async rebuildCanon(onProgress) {
      const oldPending = await this.db.getAllByWorld(STORES.pendingEvents, this.world.id);
      for (const event of oldPending) {
        if (!['generated', 'expired', 'superseded'].includes(event.status)) {
          event.status = 'superseded'; event.supersededReason = 'canon-rebuild';
          await this.db.put(STORES.pendingEvents, event);
        }
      }
      this.world.canonRevision = (Number(this.world.canonRevision) || 1) + 1;
      await this.db.deleteWorld(this.world.id, { preserveFandom: true });
      this.world.canon = { facts: [], characters: [], relationships: [], recentEventIds: [] };
      this.world.importJob = { mode: 'rebuild', status: 'analyzing', nextIndex: 0, total: this.world.turnCount };
      await this.saveWorld();
      const turns = await this.allActiveTurns();
      const chunkSize = 10;
      for (let index = 0; index < turns.length; index += chunkSize) {
        const chunk = turns.slice(index, index + chunkSize);
        const result = await this.extractCanon(chunk);
        await this.applyCanon(result, index + chunk.length);
        this.world.importJob.nextIndex = index + chunk.length;
        await this.saveWorld();
        onProgress?.(`Canon 재구축 중 · ${Math.min(index + chunk.length, turns.length)} / ${turns.length}`);
      }
      this.world.importJob.status = 'complete';
      this.world.processedTurnIds = turns.map((turn) => turn.id);
      this.world.lastProcessedTurn = turns.length;
      this.world.needsCanonRebuild = false;
      await this.saveWorld();
    }
  }

  // Inline SVG icons (own drawings; no external assets are loaded or hotlinked).
  const ICON_PATHS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    back: '<path d="M15 5 8 12l7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    more: '<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    up: '<path d="M12 4.5 4.8 12.2h4.6v7.3h5.2v-7.3h4.6z" stroke-linejoin="round"/>',
    down: '<path d="m12 19.5 7.2-7.7h-4.6V4.5H9.4v7.3H4.8z" stroke-linejoin="round"/>',
    comment: '<path d="M12 4.5c4.4 0 8 2.9 8 6.6s-3.6 6.6-8 6.6c-1 0-2-.1-2.9-.4L5 19.5l1.1-3.5C4.8 14.8 4 13.4 4 11.1c0-3.7 3.6-6.6 8-6.6z" stroke-linejoin="round"/>',
    share: '<path d="M13 5.5 19.5 11 13 16.5v-3.2c-4.4 0-7.1 1.3-9 4.2.6-4.6 3.1-8.1 9-8.8z" stroke-linejoin="round"/>',
    heart: '<path d="M12 19.6s-7.6-4.6-7.6-10.1A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.6 2.5c0 5.5-7.6 10.1-7.6 10.1z" stroke-linejoin="round"/>',
    eye: '<path d="M2.8 12S6 6 12 6s9.2 6 9.2 6-3.2 6-9.2 6-9.2-6-9.2-6z"/><circle cx="12" cy="12" r="2.6"/>',
    smile: '<circle cx="12" cy="12" r="8.2"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M8.5 14c1.9 2.2 5.1 2.2 7 0"/>',
    bookmark: '<path d="M7 4.5h10v15l-5-3.6-5 3.6z" stroke-linejoin="round"/>',
    plusCircle: '<circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/>',
    minusCircle: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="5" cy="7" r=".9" fill="currentColor"/><circle cx="5" cy="12" r=".9" fill="currentColor"/><circle cx="5" cy="17" r=".9" fill="currentColor"/>',
    textSize: '<path d="M3.5 18 8 6l4.5 12M5.2 13.6h5.6M14 18l3-7.5 3 7.5M15 15.6h4"/>',
    pen: '<path d="m5 19 1-4L16 5l3 3L9 18z" stroke-linejoin="round"/>',
    rocket: '<path d="M12 3.5c3 2 4.5 5.2 4.5 8.8l-2 3h-5l-2-3c0-3.6 1.5-6.8 4.5-8.8z" stroke-linejoin="round"/><circle cx="12" cy="10" r="1.6"/><path d="M9.5 15.3 8 19.5l2.5-1.5M14.5 15.3l1.5 4.2-2.5-1.5"/>',
    flame: '<path d="M12 20c-3.6 0-6-2.4-6-5.6 0-3.4 2.6-5 3.5-8.4 1.9 1.3 2.4 3.2 2.3 4.6 1-.8 1.6-2 1.8-3.3 2.4 1.9 4.4 4.4 4.4 7.1 0 3.2-2.4 5.6-6 5.6z" stroke-linejoin="round"/>',
    sparkle: '<path d="M12 3.5 13.9 10 20.5 12l-6.6 2L12 20.5 10.1 14 3.5 12l6.6-2z" stroke-linejoin="round"/>',
    top: '<path d="M5 19.5h14M7.5 16v-5M12 16V6.5M16.5 16v-7.5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    cards: '<rect x="4.5" y="4.5" width="15" height="6" rx="1.5"/><rect x="4.5" y="13.5" width="15" height="6" rx="1.5"/>',
    shield: '<path d="M12 3.8 18.5 6v5.3c0 4.2-2.8 7.3-6.5 8.9-3.7-1.6-6.5-4.7-6.5-8.9V6z" stroke-linejoin="round"/>',
    pin: '<path d="m14.5 4.5 5 5-3 1-3.5 3.5.5 4-1.5 1.5-3-3-4 4M9 12l3 3M14.5 4.5l-1 3-3.5 3.5-4-.5L4.5 12"/>',
    filter: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    home: '<path d="M4.5 11 12 4.5l7.5 6.5v8.5h-5v-5h-5v5h-5z" stroke-linejoin="round"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4M6.2 6.2l1.7 1.7M16.1 16.1l1.7 1.7M6.2 17.8l1.7-1.7M16.1 7.9l1.7-1.7"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    warning: '<path d="M12 4.5 20.5 19h-17z" stroke-linejoin="round"/><path d="M12 10v4M12 16.6v.2"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 5 6v8a1.5 1.5 0 0 0 1.5 1.5H8"/>',
  };

  function icon(name, size = 20, extraClass = '') {
    return `<svg class="ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  }

  const Fmt = {
    int(value) { return (Number(value) || 0).toLocaleString('ko-KR'); },
    // Reddit-style compact counts: 987, 1.2K, 12K.
    compact(value) {
      const n = Number(value) || 0;
      if (Math.abs(n) < 1000) return String(n);
      const k = n / 1000;
      return `${Math.abs(k) < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}K`;
    },
    ago(iso) {
      const at = Date.parse(iso || '');
      if (!at) return '방금';
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
      if (minutes < 1) return '방금';
      if (minutes < 60) return `${minutes}분 전`;
      if (minutes < 1440) return `${Math.round(minutes / 60)}시간 전`;
      if (minutes < 43200) return `${Math.round(minutes / 1440)}일 전`;
      return new Date(at).toLocaleDateString('ko-KR');
    },
    pixivDate(iso) {
      const at = Date.parse(iso || '') || Date.now();
      return new Date(at).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    seed(text, mod) { return parseInt(Utils.hash(text), 36) % mod; },
  };

  const PX_COVERS = [['#86a8e7', '#5d7fd1'], ['#f4a4b8', '#d9708f'], ['#8fcfb9', '#4e9188'], ['#f3c07c', '#d98a52'], ['#b6a1de', '#7d5cc4'], ['#9fb3bf', '#5b7280'], ['#e9a2d2', '#a868b8']];
  const RD_AVATARS = ['#ff4500', '#0079d3', '#46d160', '#ffb000', '#7193ff', '#ff66ac', '#00a6a5', '#ea0027', '#94e044'];
  const RD_FLAIRS = [['#0079d3', '#fff'], ['#ffd635', '#1a1a1b'], ['#46d160', '#fff'], ['#ff585b', '#fff'], ['#7193ff', '#fff'], ['#ff66ac', '#fff'], ['#dadada', '#1a1a1b'], ['#cc5289', '#fff'], ['#00a6a5', '#fff']];

  // Shell + home + settings + prompt editor.
  const SHELL_CSS = `
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR","Noto Sans JP",sans-serif;color:#1f1f1f}
*{box-sizing:border-box}[hidden]{display:none!important}
button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent}
.ic{display:block;flex:none}
.launcher{position:fixed;right:18px;bottom:96px;z-index:2147483000;width:48px;height:48px;border:0;border-radius:16px;background:#17151c;color:#fff;display:grid;place-items:center;box-shadow:0 6px 20px #0004;cursor:pointer;transition:transform .15s}
.launcher:hover{transform:translateY(-2px)}
.launcher-badge,.app-badge{position:absolute;right:-6px;top:-6px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ff3b30;color:#fff;font:700 11px/20px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff}
.veil[hidden]{display:none!important}
.veil{position:fixed;inset:0;z-index:2147483001;background:#0d0b1299;display:grid;place-items:center;padding:16px}
.phone{position:relative;width:min(392px,calc(100vw - 20px));height:min(820px,calc(100vh - 24px));background:#fff;border:9px solid #0e0e10;border-radius:46px;overflow:hidden;box-shadow:0 0 0 1.5px #3a3a40,0 30px 80px #000a;display:grid;grid-template-rows:38px minmax(0,1fr) 54px;transform:scale(var(--ui-scale,1))}
.statusbar{position:relative;z-index:6;display:grid;grid-template-columns:40px 1fr 40px;align-items:center;padding:0 8px;background:#fff;color:#111}
.statusbar button{width:32px;height:32px;border:0;border-radius:50%;background:transparent;display:grid;place-items:center;cursor:pointer;color:#111}
.statusbar button:hover{background:#0000000d}
.brand{display:flex;align-items:center;justify-content:center;gap:6px;font:600 13px/1 -apple-system,system-ui,sans-serif;letter-spacing:.01em}
.brand small{color:#8e8e93;font:500 10px/1 -apple-system,system-ui,sans-serif}
.phone.dark-bar .statusbar{background:transparent;color:#fff;position:absolute;left:0;right:0;top:0;height:38px}
.phone.dark-bar .statusbar button{color:#fff}
.phone.dark-bar main.screen{grid-row:1/3}
main.screen{position:relative;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;background:#fff;min-height:0}
main.screen::-webkit-scrollbar{width:0;height:0}
.phone nav{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid #0000001a;background:#fbfbfdf2;z-index:5}
.phone nav button{position:relative;border:0;background:transparent;color:#8e8e93;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer;font-size:10px}
.phone nav button.active{color:#111}
.phone nav .app-badge{right:calc(50% - 22px);top:4px;min-width:16px;height:16px;line-height:16px;font-size:9px;padding:0 4px}
.toast{position:absolute;left:16px;right:16px;bottom:66px;z-index:20;background:#1c1c1eeb;color:#fff;padding:11px 14px;border-radius:14px;font:12px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px #0005;white-space:pre-line}
.toast[data-kind="error"]{background:#3a1416f0}
.empty{text-align:center;color:#858585;padding:48px 16px;font-size:13px;line-height:1.6}
@media(max-width:500px){.launcher{right:12px;bottom:80px}.veil{padding:0}.phone{width:100vw;height:100vh;height:100dvh;border:0;border-radius:0;box-shadow:none;transform:none}}

.screen-home{background:radial-gradient(120% 70% at 20% 0%,#7b6cf0 0%,#3c3a8f 45%,#141428 100%)!important;color:#fff;padding:52px 18px 24px}
.home-time{text-align:center;font:200 58px/1 -apple-system,system-ui,sans-serif;letter-spacing:-1px}
.home-date{text-align:center;font:500 13px/1.4 -apple-system,system-ui,sans-serif;opacity:.85;margin:6px 0 22px}
.home-widget{border-radius:22px;padding:14px 16px;background:#ffffff26;border:1px solid #ffffff22;backdrop-filter:blur(18px);font-size:12px;line-height:1.55;margin-bottom:18px}
.home-widget b{font-size:13px}
.home-widget .warn{color:#ffd60a}
.home-apps{display:grid;grid-template-columns:repeat(4,1fr);gap:16px 10px;margin:4px 0 22px}
.home-app{position:relative;border:0;background:transparent;color:#fff;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:11px;cursor:pointer}
.home-icon{width:58px;height:58px;border-radius:15px;display:grid;place-items:center;box-shadow:0 6px 16px #0003}
.home-icon.pixiv{background:#0096fa;color:#fff;font:900 30px/1 "Helvetica Neue",Arial,sans-serif}
.home-icon.reddit{background:#ff4500}
.home-icon.settings{background:linear-gradient(#8e8e93,#636366);color:#fff}
.home-icon.prompts{background:linear-gradient(#5e5ce6,#3634a3);color:#fff}
.home-app .app-badge{right:4px;top:-4px}
.home-section{font:600 12px/1 -apple-system,system-ui,sans-serif;opacity:.75;margin:0 2px 10px}
.home-chips{display:flex;flex-wrap:wrap;gap:6px}
.home-chip{border:0;border-radius:999px;padding:7px 11px;background:#ffffff26;color:#fff;font-size:11px;cursor:pointer}

.screen-settings{background:#f2f2f7!important;padding-bottom:28px}
.st-title{padding:14px 18px 2px;font:700 26px/1.2 -apple-system,system-ui,sans-serif}
.st-section{margin:22px 18px 7px;color:#6d6d72;font:500 12px/1.2 -apple-system,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.02em}
.st-card{margin:0 14px;background:#fff;border-radius:12px;overflow:hidden}
.st-field{display:block;padding:10px 14px;border-bottom:1px solid #e5e5ea}
.st-field:last-child{border-bottom:0}
.st-field>span{display:block;margin-bottom:6px;color:#6d6d72;font-size:11px;font-weight:600}
.st-field input,.st-field select,.st-field textarea{width:100%;border:0;border-radius:8px;padding:9px 10px;background:#f2f2f7;color:#111;font:13px/1.35 -apple-system,system-ui,sans-serif;outline:none}
.st-field input:focus,.st-field select:focus,.st-field textarea:focus{box-shadow:0 0 0 2px #007aff55}
.st-inline{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #e5e5ea;font-size:14px}
.st-inline:last-child{border-bottom:0}
.st-inline input[type=checkbox]{width:20px;height:20px;accent-color:#34c759}
.st-btn{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:12px 14px;border:0;border-bottom:1px solid #e5e5ea;background:#fff;color:#007aff;text-align:left;font-size:14px;cursor:pointer}
.st-btn:last-child{border-bottom:0}
.st-btn:hover{background:#f7f7fa}
.st-btn.danger{color:#ff3b30}
.st-btn:disabled{color:#c7c7cc;cursor:default}
.st-btn .ic{color:#c7c7cc}
.st-note{padding:8px 18px 0;color:#6d6d72;font-size:11px;line-height:1.55}
.st-note code,.st-code{font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;background:#e9e9ee;border-radius:5px;padding:1px 4px;word-break:break-all}
.st-status{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e5e5ea;font-size:12px;color:#3a3a3c}
.st-dot{width:8px;height:8px;border-radius:50%;background:#c7c7cc;flex:none}
.st-dot.ok{background:#34c759}.st-dot.bad{background:#ff3b30}
.st-badge{margin-left:auto;padding:2px 7px;border-radius:999px;background:#e9e9ee;color:#3a3a3c;font-size:10px;font-weight:700}
.st-badge.on{background:#007aff;color:#fff}
details.st-details{margin:0 14px;background:#fff;border-radius:12px;overflow:hidden}
details.st-details>summary{padding:12px 14px;cursor:pointer;font-size:14px;list-style:none;display:flex;justify-content:space-between}
details.st-details>summary::-webkit-details-marker{display:none}
details.st-details[open]>summary{border-bottom:1px solid #e5e5ea}
.st-steps{margin:0;padding:10px 14px 12px 30px;font-size:11.5px;line-height:1.6;color:#3a3a3c}

.pe-head{padding:14px 18px 4px}
.pe-head h2{margin:0;font:700 22px/1.25 -apple-system,system-ui,sans-serif}
.pe-head p{margin:6px 0 0;color:#6d6d72;font-size:12px;line-height:1.5}
.pe-item{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;width:100%;padding:11px 14px;border:0;border-bottom:1px solid #e5e5ea;background:#fff;text-align:left;cursor:pointer}
.pe-item:last-child{border-bottom:0}
.pe-item:hover{background:#f7f7fa}
.pe-item b{font-size:14px;font-weight:600}
.pe-item small{grid-column:1;color:#6d6d72;font-size:11px;line-height:1.4}
.pe-item .st-badge{grid-row:1/3;grid-column:2;margin:0}
.pe-item .st-badge.warn{background:#ff9500;color:#fff}
.pe-group-head{display:flex;align-items:baseline;gap:8px}
.pe-group-head small{text-transform:none;letter-spacing:0;color:#8e8e93}
.pe-meta{margin:10px 14px 0;padding:10px 12px;border-radius:10px;background:#fff;font-size:11.5px;line-height:1.55;color:#3a3a3c}
.pe-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 14px 0}
.pe-chip{border:1px solid #d1d1d6;border-radius:8px;background:#fff;padding:5px 8px;font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;color:#3634a3;cursor:pointer;text-align:left}
.pe-chip.req{border-color:#5e5ce6;background:#efeffd}
.pe-chip:hover{background:#e5e5fb}
.pe-doc{margin:8px 14px 0;font-size:11px;line-height:1.55;color:#6d6d72}
.pe-doc div{padding:2px 0}
.pe-doc code{font:600 10.5px ui-monospace,SFMono-Regular,Consolas,monospace;color:#3634a3}
.pe-textarea{display:block;width:calc(100% - 28px);margin:10px 14px 0;min-height:340px;resize:vertical;border:0;border-radius:12px;padding:12px;background:#1c1c1e;color:#f2f2f7;font:11.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none;tab-size:2}
.pe-textarea:focus{box-shadow:0 0 0 2px #5e5ce6}
.pe-validation{margin:10px 14px 0;font-size:11.5px;line-height:1.5}
.pe-validation .ok{color:#248a3d}
.pe-validation .err{color:#d70015;white-space:pre-wrap}
.pe-validation .warn{color:#b25000}
.pe-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 14px 0}
.pe-actions button{border:0;border-radius:10px;padding:11px 8px;background:#fff;color:#007aff;font-size:13px;cursor:pointer}
.pe-actions button.primary{background:#007aff;color:#fff;font-weight:600}
.pe-actions button.primary:disabled{background:#a7c8f5;cursor:not-allowed}
.pe-actions button.danger{color:#ff3b30}
`;

  // Pixiv (mobile web, measured from pixiv.net novel tag/detail/user pages).
  const PIXIV_CSS = `
.screen-pixiv{--px-t1:#1f1f1f;--px-t2:#474747;--px-t3:#858585;--px-link:#3d7699;--px-brand:#0096fa;--px-bg2:#f5f5f5;--px-fill:rgba(0,0,0,.04);font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Noto Sans JP","Noto Sans KR",sans-serif;color:var(--px-t1);font-size:14px;line-height:1.15}
.px-header{position:sticky;top:0;z-index:5;display:grid;grid-template-columns:48px 1fr 48px 40px;align-items:center;height:48px;background:#fff}
.px-header button{border:0;background:transparent;height:48px;display:grid;place-items:center;color:var(--px-t3);cursor:pointer}
.px-header .px-logo{justify-self:center;border:0;background:transparent;color:var(--px-brand);font:700 27px/1 "Helvetica Neue",Arial,sans-serif;letter-spacing:-1.2px;cursor:pointer;padding:0 0 3px}
.px-me{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#9ad0ff,#0096fa)}
.px-searchbar{display:flex;align-items:center;gap:8px;padding:8px 16px;background:#fff}
.px-searchbar label{flex:1;display:flex;align-items:center;gap:6px;height:40px;padding:0 12px;border-radius:4px;background:var(--px-bg2);color:var(--px-t3)}
.px-searchbar input{flex:1;min-width:0;border:0;background:transparent;outline:0;color:var(--px-t1);font:14px/22px inherit;font-family:inherit}
.px-searchbar button{border:0;background:transparent;color:var(--px-t2);font-size:14px;cursor:pointer}
.px-notice{padding:12px 16px;background:var(--px-bg2);color:var(--px-t2);font-size:12px;line-height:20px;text-align:center}
.px-hero{display:flex;gap:16px;padding:24px 16px 16px}
.px-hero-thumb{flex:none;width:112px;height:112px;border-radius:8px;display:grid;place-items:center;color:#fff;font:700 40px/1 "Helvetica Neue",Arial,sans-serif;background:linear-gradient(145deg,var(--c1),var(--c2))}
.px-hero h1{margin:6px 0 8px;font-size:20px;line-height:28px;font-weight:700;word-break:break-all}
.px-hero-count{color:var(--px-t3);font-size:14px;line-height:22px}
.px-hero-count b{color:var(--px-t2)}
.px-pill{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 16px;border:0;border-radius:999px;background:var(--px-brand);color:#fff;font-size:14px;font-weight:700;line-height:22px;cursor:pointer;white-space:nowrap}
.px-pill.gray{background:var(--px-fill);color:var(--px-t2)}
.px-pill.wide{height:40px;width:min(100%,288px)}
.px-pill.black{background:rgba(0,0,0,.88);color:#fff;height:40px;width:100%}
.px-pill:disabled{cursor:default;opacity:1}
.px-reltags{display:flex;gap:8px;overflow-x:auto;padding:8px 16px 16px;scrollbar-width:none}
.px-reltags::-webkit-scrollbar{display:none}
.px-reltag{flex:none;display:flex;flex-direction:column;justify-content:center;min-width:72px;height:40px;padding:0 14px;border:0;border-radius:4px;color:#fff;font-weight:700;font-size:14px;line-height:18px;cursor:pointer;background:var(--c)}
.px-reltag small{font-size:10px;font-weight:400;opacity:.85;line-height:12px}
.px-tabs{display:flex;align-items:center;border-bottom:1px solid #0000000f}
.px-tabs button{height:48px;padding:0 16px;border:0;background:transparent;color:var(--px-t3);font-size:14px;font-weight:700;line-height:22px;cursor:pointer}
.px-tabs button.active{color:var(--px-t1);box-shadow:inset 0 2px 0 0 var(--px-brand)}
.px-tabs button:disabled{cursor:default}
.px-tabs .px-tab-filter{margin-left:auto;color:var(--px-t2)}
.px-sortrow{display:flex;align-items:center;gap:4px;height:48px;padding:0 8px;overflow-x:auto;scrollbar-width:none}
.px-sortrow::-webkit-scrollbar{display:none}
.px-sortrow button{flex:none;display:flex;align-items:center;gap:4px;height:32px;padding:4px 8px;border:0;border-radius:4px;background:transparent;color:var(--px-t3);font-size:14px;font-weight:700;line-height:22px;cursor:pointer}
.px-sortrow button.active{color:var(--px-t2)}
.px-sortrow .sep{flex:none;width:1px;height:20px;margin:0 6px;background:#0000001f}
.px-count{padding:8px 16px 20px}
.px-count span{display:inline-block;padding:0 8px;border-radius:999px;background:#8f8f8f;color:#fff;font-size:12px;font-weight:700;line-height:20px}
.px-list{display:grid;row-gap:40px;padding:0 16px 32px}
.px-item{position:relative;display:flex;cursor:pointer}
.px-item-cover{flex:none;width:64px}
.px-item-body{flex:1;min-width:0;padding-left:16px;display:flex;flex-direction:column}
.px-item-series{display:block;max-width:100%;padding:0;border:0;background:transparent;color:var(--px-t3);font-size:12px;line-height:20px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.px-item-title{font-weight:700;font-size:14px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.px-item:hover .px-item-title{text-decoration:underline}
.px-author{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0;border:0;background:transparent;color:var(--px-t2);font-size:12px;line-height:20px;cursor:pointer;text-align:left}
.px-author span:last-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.px-av{flex:none;display:grid;place-items:center;border-radius:50%;color:#fff;font-weight:700;background:linear-gradient(145deg,var(--c1),var(--c2));overflow:hidden}
.px-item-tags{padding-right:40px;color:var(--px-link);font-size:12px;line-height:20px;word-break:break-all}
.px-tagb,.px-tag{display:inline;padding:0;border:0;background:transparent;color:var(--px-link);font:inherit;cursor:pointer}
.px-tagb{font-weight:700;margin-right:8px}
.px-tag{margin-right:4px}
.px-tag:before{content:"#"}
.px-tagb:hover,.px-tag:hover{text-decoration:underline}
.px-item-stats{display:flex;align-items:center;gap:8px;padding-right:40px;color:var(--px-t3);font-size:12px;line-height:20px}
.px-item-stats .ic{display:inline-block;vertical-align:-3px}
.px-item-caption{display:none;margin-top:8px;color:var(--px-t2);font-size:12px;line-height:20px;white-space:pre-wrap}
.px-item.open .px-item-caption{display:block}
.px-item-more{align-self:flex-start;margin-top:8px;padding:0;border:0;background:transparent;color:var(--px-t3);font-size:12px;line-height:20px;cursor:pointer}
.px-heart{position:absolute;right:0;bottom:0;width:32px;height:32px;padding:4px;border:0;background:transparent;color:var(--px-t1);cursor:pointer}
.px-heart.on{color:#ff4060}
.px-heart.on path{fill:#ff4060}
.px-cover{position:relative;display:flex;flex-direction:column;justify-content:space-between;width:100%;border-radius:4px;overflow:hidden;color:#fff;background:linear-gradient(160deg,var(--c1),var(--c2))}
.px-cover:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,#ffffff14 0 6px,transparent 6px 12px)}
.px-cover-t{position:relative;font-weight:700;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;word-break:break-all}
.px-cover-a{position:relative;opacity:.9;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.px-cover.s{height:90px;padding:7px 6px}
.px-cover.s .px-cover-t{font-size:9px;line-height:12px;-webkit-line-clamp:4}
.px-cover.s .px-cover-a{font-size:7px}
.px-cover.l{width:152px;height:214px;padding:18px 14px;border-radius:8px;box-shadow:0 4px 16px #0003}
.px-cover.l .px-cover-t{font-size:16px;line-height:23px;-webkit-line-clamp:6}
.px-cover.l .px-cover-a{font-size:11px}
.px-cover.m{width:104px;height:146px;padding:12px 10px}
.px-cover.m .px-cover-t{font-size:12px;line-height:17px;-webkit-line-clamp:5}
.px-cover.m .px-cover-a{font-size:9px}
.px-authorbar{display:flex;align-items:center;gap:8px;padding:12px 16px}
.px-authorbar .px-author{flex:1;font-size:14px;font-weight:700;color:var(--px-t1);line-height:22px}
.px-detail-head{position:relative;padding:4px 0 24px;background:var(--px-bg2)}
.px-detail-title{padding:0 40px;text-align:center;font-size:14px;font-weight:700;line-height:32px}
.px-detail-series{display:block;margin:0 auto;max-width:80%;padding:0;border:0;background:transparent;color:#999;font-size:10px;line-height:14px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.px-detail-next{position:absolute;right:8px;top:8px;width:32px;height:32px;border:0;background:transparent;color:#b5b5b5;display:grid;place-items:center;cursor:pointer}
.px-detail-cover{position:relative;display:flex;justify-content:center;margin-top:14px}
.px-charbadge{position:absolute;right:16px;top:0;padding:0 8px;border-radius:999px;background:rgba(0,0,0,.32);color:#fff;font-size:10px;font-weight:700;line-height:16px}
.px-likebar{display:flex;align-items:center;gap:4px;padding:12px 12px 4px}
.px-like{display:flex;align-items:center;gap:4px;padding:4px;border:0;background:transparent;color:var(--px-t1);font-size:14px;font-weight:700;line-height:22px;cursor:pointer}
.px-like.on{color:var(--px-brand)}
.px-likebar .grow{flex:1}
.px-iconbtn{width:40px;height:40px;border:0;background:transparent;color:var(--px-t1);display:grid;place-items:center;cursor:pointer}
.px-iconbtn.on{color:#ff4060}
.px-iconbtn.on path{fill:#ff4060}
.px-caption{margin:8px 16px 0;color:var(--px-t3);font-size:14px;line-height:22px;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.px-caption.open{display:block}
.px-detail-name{margin:12px 16px 0;font-size:14px;font-weight:700;line-height:22px}
.px-detail-tags{margin:12px 16px 0;color:var(--px-link);font-size:12px;line-height:16px;word-break:break-all}
.px-detail-tags .px-tag{margin-right:8px}
.px-detail-stats{display:flex;gap:12px;margin:10px 16px 0;color:var(--px-t3);font-size:12px;line-height:16px}
.px-detail-stats span{display:flex;align-items:center;gap:3px}
.px-date{margin:12px 16px 0;color:var(--px-t3);font-size:10px;line-height:14px}
.px-readerbar{position:sticky;top:48px;z-index:4;display:grid;grid-template-columns:repeat(4,1fr);height:48px;margin-top:20px;background:var(--rd-bg,#fff);border-top:1px solid #0000000f;border-bottom:1px solid #0000000f}
.px-readerbar button{border:0;background:transparent;color:var(--px-t2);display:grid;place-items:center;cursor:pointer}
.px-readerbar button.on{color:var(--px-brand)}
.px-readerpanel{padding:12px 16px;border-bottom:1px solid #0000000f;background:#fff;font-size:12px;color:var(--px-t2)}
.px-readerpanel div{display:flex;align-items:center;gap:6px;margin:4px 0}
.px-readerpanel span{width:56px;color:var(--px-t3)}
.px-readerpanel button{height:30px;padding:0 12px;border:0;border-radius:999px;background:var(--px-fill);color:var(--px-t2);font-size:12px;font-weight:700;cursor:pointer}
.px-readerpanel button.on{background:var(--px-brand);color:#fff}
.px-reader{padding:28px 0 8px;background:var(--rd-bg,#fff);color:var(--rd-fg,#1f1f1f);font-size:var(--rd-size,16px);line-height:1.8;font-family:var(--rd-font)}
.px-reader .px-p{margin:0 0 24px;padding:0 16px;word-break:break-word}
.px-reader .px-chapter{margin:8px 16px 24px;font-size:1.15em;line-height:1.5;font-weight:700}
.px-reader .px-pagebreak{margin:8px 0 32px;color:var(--px-t3);font-size:12px;text-align:center}
.px-reader .px-cursor{display:inline-block;width:.5em;height:1em;margin-left:2px;vertical-align:-2px;background:var(--px-brand);animation:pxblink 1s steps(2) infinite}
@keyframes pxblink{50%{opacity:0}}
.px-reader.theme-sepia{--rd-bg:#f3ecdc;--rd-fg:#4b3b28}
.px-reader.theme-dark{--rd-bg:#1f1f1f;--rd-fg:#d6d6d6}
.px-generate{padding:28px 16px 36px;text-align:center;background:#fff}
.px-generate p{margin:12px 0 0;color:var(--px-t3);font-size:12px;line-height:20px}
.px-pagecount{padding:4px 0 16px;color:inherit;opacity:.6;font-size:12px;line-height:20px;text-align:center}
.px-seriesbox{margin:16px 16px 0;padding:4px 16px 24px;border-radius:8px;background:var(--px-fill)}
.px-seriesbox-label{margin-top:4px;color:var(--px-t3);font-size:12px;line-height:20px;text-align:center}
.px-seriesbox-title{display:block;width:100%;padding:0;border:0;background:transparent;font-size:14px;font-weight:700;line-height:22px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.px-seriesbox .px-nav{display:flex;flex-direction:column;gap:8px;margin-top:20px}
.px-seriesbox .px-nav button{height:40px;border:0;border-radius:100px;background:var(--px-fill);color:var(--px-t2);font-size:14px;font-weight:700;cursor:pointer}
.px-seriesbox .px-nav button:disabled{cursor:default;color:#adadad}
.px-continuity{margin:16px 16px 0;padding:10px 12px;border-radius:8px;background:#fff8e1;color:#6d5300;font-size:12px;line-height:18px}
.px-section-title{margin:32px 16px 12px;font-size:16px;font-weight:700;line-height:24px}
.px-graylist{display:grid;gap:8px;padding:0 16px 16px}
.px-graycard{display:flex;gap:16px;padding:16px 16px 22px;border-radius:4px;background:var(--px-fill);cursor:pointer}
.px-graycard .px-item-body{padding-left:0}
.px-profile-banner{height:96px;background:linear-gradient(135deg,var(--c1),var(--c2));opacity:.55}
.px-profile{position:relative;padding:0 16px 8px;text-align:center}
.px-profile-av{width:84px;height:84px;margin:-42px auto 0;border:3px solid #fff;font-size:34px}
.px-profile h1{margin:12px 0 0;font-size:16px;line-height:24px;font-weight:700}
.px-profile .px-pill{margin-top:16px}
.px-profile-follow{margin-top:12px;color:var(--px-t3);font-size:12px;line-height:20px}
.px-profile-follow b{color:var(--px-t1)}
.px-profile-bio{margin:14px 0 0;color:var(--px-t1);font-size:12px;line-height:20px;text-align:left;white-space:pre-wrap}
.px-profile-share{position:absolute;right:8px;top:4px}
.px-utabs{display:flex;justify-content:center;margin-top:16px;border-bottom:1px solid #0000000f}
.px-utabs button{min-width:80px;height:44px;border:0;background:transparent;color:var(--px-t3);font-size:14px;font-weight:700;cursor:pointer}
.px-utabs button.active{color:var(--px-t1);box-shadow:inset 0 2px 0 0 var(--px-brand)}
.px-seriescard{display:flex;gap:16px;padding:16px;background:var(--px-bg2);cursor:pointer}
.px-seriescard .px-item-body{padding-left:0;gap:4px}
.px-genres{display:flex;gap:4px;flex-wrap:wrap}
.px-genre{padding:0 6px;border-radius:4px;color:#fff;font-size:12px;font-weight:700;line-height:20px;background:var(--c,#8f8f8f)}
.px-seriescard h3{margin:2px 0 0;font-size:16px;line-height:22px;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.px-seriescard p{margin:0;color:var(--px-t2);font-size:12px;line-height:20px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.px-seriescard .meta{color:var(--px-t3);font-size:12px;line-height:20px}
.px-subtitle{padding:16px 16px 8px;color:var(--px-t3);font-size:12px;line-height:20px}
`;

  // Reddit (Shreddit mobile web, tokens and metrics measured from reddit.com, 2026-10).
  const REDDIT_CSS = `
.screen-reddit{--rd-strong:#181c1f;--rd-text:#333d42;--rd-weak:#5c6c74;--rd-border:#00000033;--rd-border-weak:#00000019;--rd-secondary:#e5ebee;--rd-secondary-hover:#d2dadd;--rd-hover:#f6f8f9;--rd-up:#d93900;--rd-down:#6a5cff;--rd-primary:#115bca;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"Noto Sans KR",sans-serif;color:var(--rd-text);font-size:14px;line-height:21px;background:#fff}
.rd-header{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:8px;height:56px;padding:0 12px;background:#fff;border-bottom:1px solid var(--rd-border)}
.rd-iconbtn{flex:none;width:40px;height:40px;border:0;border-radius:999px;background:transparent;color:var(--rd-strong);display:grid;place-items:center;cursor:pointer}
.rd-iconbtn:hover{background:var(--rd-secondary)}
.rd-iconbtn.filled{background:var(--rd-secondary)}
.rd-iconbtn.filled:hover{background:var(--rd-secondary-hover)}
.rd-search{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:40px;padding:0 6px 0 12px;border-radius:999px;background:var(--rd-secondary);color:var(--rd-weak)}
.rd-search-chip{flex:none;display:flex;align-items:center;gap:4px;height:28px;padding:0 8px 0 4px;border:1px solid var(--rd-border);border-radius:999px;color:var(--rd-strong);font-size:12px;font-weight:600}
.rd-search input{flex:1;min-width:0;border:0;background:transparent;outline:0;color:var(--rd-strong);font:14px/20px inherit;font-family:inherit}
.rd-logo{flex:none;width:32px;height:32px;border-radius:50%;background:#ff4500;display:grid;place-items:center}
.rd-me{width:32px;height:32px;border-radius:50%}
.rd-av{flex:none;display:grid;place-items:center;border-radius:50%;color:#fff;font-weight:700;overflow:hidden}
.rd-banner{height:64px;background:linear-gradient(110deg,var(--c1),var(--c2))}
.rd-comm{display:flex;align-items:flex-end;gap:8px;padding:0 16px}
.rd-comm-icon{width:48px;height:48px;margin-top:-16px;border:4px solid #fff;border-radius:50%;background:#ff4500;display:grid;place-items:center;box-sizing:content-box}
.rd-comm h1{margin:0 0 4px;color:var(--rd-strong);font-size:18px;font-weight:700;line-height:24px}
.rd-comm-meta{padding:4px 16px 0;color:var(--rd-weak);font-size:12px;line-height:16px}
.rd-comm-meta b{color:var(--rd-strong)}
.rd-comm-actions{display:flex;gap:8px;padding:12px 16px 4px}
.rd-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;padding:0 16px;border:1px solid transparent;border-radius:999px;background:var(--rd-secondary);color:var(--rd-strong);font-size:14px;font-weight:600;line-height:20px;cursor:pointer;white-space:nowrap}
.rd-btn:hover{background:var(--rd-secondary-hover)}
.rd-btn.outline{background:transparent;border-color:#0000007e}
.rd-btn.outline:hover{background:var(--rd-hover)}
.rd-btn.black{background:#000;color:#fff}
.rd-btn.black:hover{background:#222}
.rd-btn.sm{height:32px;padding:0 12px;font-size:12px}
.rd-tabs{display:flex;align-items:center;gap:4px;padding:8px 16px}
.rd-tab{height:40px;padding:0 16px;border:0;border-radius:9999px;background:transparent;color:var(--rd-weak);font-size:14px;line-height:20px;cursor:pointer}
.rd-tab:hover{background:var(--rd-hover)}
.rd-tab.active{background:#c9d7de;color:var(--rd-strong)}
.rd-tabs .grow{flex:1}
.rd-sortbtn{display:flex;align-items:center;gap:2px;height:32px;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--rd-weak);font-size:12px;font-weight:600;cursor:pointer}
.rd-sortbtn:hover{background:var(--rd-hover)}
.rd-menu{position:absolute;z-index:8;min-width:180px;padding:8px 0;border-radius:8px;background:#fff;box-shadow:0 8px 24px #0000002e,0 0 0 1px var(--rd-border-weak)}
.rd-menu-title{padding:4px 16px 8px;color:var(--rd-weak);font-size:12px;font-weight:600}
.rd-menu button{display:flex;align-items:center;gap:12px;width:100%;height:44px;padding:0 16px;border:0;background:transparent;color:var(--rd-strong);font-size:14px;text-align:left;cursor:pointer}
.rd-menu button:hover{background:var(--rd-hover)}
.rd-menu button.active{background:var(--rd-hover);font-weight:600}
.rd-highlights{padding:4px 0 8px}
.rd-highlights h3{display:flex;align-items:center;gap:8px;height:32px;margin:0;padding:0 16px;color:var(--rd-strong);font-size:14px;font-weight:400}
.rd-hl-row{display:flex;gap:8px;overflow-x:auto;padding:4px 16px 8px;scrollbar-width:none}
.rd-hl-row::-webkit-scrollbar{display:none}
.rd-hl{flex:none;display:flex;flex-direction:column;justify-content:space-between;width:224px;height:152px;padding:16px;border:1px solid var(--rd-border);border-radius:16px;background:#fff;color:var(--rd-strong);font-size:16px;line-height:24px;text-align:left;cursor:pointer}
.rd-hl:hover{background:var(--rd-hover)}
.rd-hl span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.rd-hl small{display:flex;align-items:center;gap:6px;color:var(--rd-weak);font-size:12px;line-height:16px}
.rd-hr{margin:0 16px;border:0;border-top:1px solid var(--rd-border-weak)}
.rd-post{position:relative;display:block;margin:4px 0;padding:4px 16px;cursor:pointer;border-radius:16px}
.rd-post:hover{background:var(--rd-hover)}
.rd-credit{display:flex;align-items:center;gap:4px;min-height:32px;margin:-4px 0 4px;color:var(--rd-text);font-size:12px;line-height:16px}
.rd-credit .who{display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:transparent;color:var(--rd-text);font-size:12px;cursor:pointer}
.rd-credit .who b{color:var(--rd-strong);font-weight:700}
.rd-credit .dot,.rd-credit time{color:var(--rd-weak)}
.rd-credit .rd-iconbtn{margin-left:auto;width:32px;height:32px;color:var(--rd-weak)}
.rd-title{margin:0 0 4px;color:var(--rd-strong);font-size:16px;font-weight:600;line-height:20px;word-break:break-word}
.rd-post:visited .rd-title{color:#5c6c74}
.rd-flairs{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 6px}
.rd-flair{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;line-height:16px;background:var(--fb);color:var(--fc)}
.rd-spoiler-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;background:var(--rd-strong);color:#fff;font-size:12px;font-weight:700}
.rd-body{margin:0 0 8px;color:var(--rd-text);font-size:14px;line-height:20px;word-break:break-word}
.rd-body.clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.rd-body p{margin:0 0 12px}.rd-body p:last-child{margin-bottom:0}
.rd-spoiler{position:relative;margin:0 0 8px;border-radius:16px;overflow:hidden}
.rd-spoiler .rd-body{margin:0;padding:12px;filter:blur(7px);user-select:none;background:var(--rd-hover)}
.rd-spoiler button{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);height:32px;padding:0 14px;border:0;border-radius:999px;background:#000000b3;color:#fff;font-size:12px;font-weight:600;cursor:pointer}
.rd-actions{display:flex;align-items:center;gap:12px;margin:8px 0 4px}
.rd-vote{display:inline-flex;align-items:center;height:32px;border-radius:999px;background:var(--rd-secondary);color:#000;font-size:12px;font-weight:600;line-height:16px}
.rd-vote button{width:32px;height:32px;border:0;border-radius:999px;background:transparent;color:inherit;display:grid;place-items:center;cursor:pointer}
.rd-vote button.up:hover{background:var(--rd-secondary-hover);color:var(--rd-up)}
.rd-vote button.down:hover{background:var(--rd-secondary-hover);color:var(--rd-down)}
.rd-vote .n{min-width:14px;text-align:center}
.rd-vote.up{background:var(--rd-up);color:#fff}
.rd-vote.down{background:var(--rd-down);color:#fff}
.rd-vote.up button:hover,.rd-vote.down button:hover{background:#0000001f;color:#fff}
.rd-vote.up .up path,.rd-vote.down .down path{fill:#fff}
.rd-pill{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:0;border-radius:999px;background:var(--rd-secondary);color:#000;font-size:12px;font-weight:600;cursor:pointer}
.rd-pill:hover{background:var(--rd-secondary-hover)}
.rd-detail-head{display:flex;align-items:center;gap:8px;padding:16px 16px 4px}
.rd-detail-head .rd-iconbtn{width:32px;height:32px}
.rd-detail-head .col{min-width:0;display:flex;flex-direction:column;font-size:12px;line-height:16px}
.rd-detail-head .col b{color:var(--rd-text);font-weight:700}
.rd-detail-head time,.rd-detail-head .dot{color:var(--rd-weak);font-weight:400}
.rd-detail-head .grow{flex:1}
.rd-detail-title{margin:8px 16px;color:var(--rd-strong);font-size:18px;font-weight:600;line-height:24px;word-break:break-word}
.rd-detail-body{padding:0 16px}
.rd-detail-body .rd-flairs{margin-top:0}
.rd-canon-note{margin:4px 0 0;color:var(--rd-weak);font-size:12px;line-height:16px}
.rd-detail-actions{padding:4px 16px 8px}
.rd-composer{display:flex;align-items:center;height:40px;margin:8px 16px 16px;padding:0 16px;border:1px solid var(--rd-border);border-radius:20px;color:var(--rd-weak);font-size:14px;cursor:text}
.rd-composer:hover{border-color:#0000007e}
.rd-csort{display:flex;align-items:center;gap:4px;padding:0 16px 8px;position:relative;color:var(--rd-weak);font-size:12px}
.rd-comments{padding:0 16px 12px}
.rd-c{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr);padding-top:8px}
.rd-c-gutter{position:relative}
.rd-c-gutter .rd-av{position:absolute;left:-4px;top:2px;width:32px;height:32px;font-size:13px}
.rd-c-line{position:absolute;left:12px;top:40px;bottom:0;width:1px;background:var(--rd-border-weak)}
.rd-c-kids>.rd-c:before{content:"";position:absolute;left:-12px;top:0;width:8px;height:18px;border-left:1px solid var(--rd-border-weak);border-bottom:1px solid var(--rd-border-weak);border-bottom-left-radius:10px}
.rd-c-kids>.rd-c:last-child:after{content:"";position:absolute;left:-14px;top:18px;bottom:0;width:4px;background:#fff}
.rd-c-meta{display:flex;align-items:center;gap:4px;min-height:36px;padding:2px 0 2px 8px;font-size:12px;line-height:16px;cursor:pointer}
.rd-c-meta b{color:var(--rd-strong);font-weight:700;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.rd-c-meta .op{color:var(--rd-primary);font-weight:700}
.rd-c-meta .dot,.rd-c-meta time,.rd-c-meta .hidden-n{color:var(--rd-weak)}
.rd-c-body{padding:0 0 4px 8px;color:var(--rd-text);font-size:14px;line-height:20px;word-break:break-word}
.rd-c-body p{margin:0 0 8px}.rd-c-body p:last-child{margin:0}
.rd-c-actions{position:relative;display:flex;align-items:center;gap:2px;margin-left:2px;color:var(--rd-weak);font-size:12px;font-weight:600}
.rd-c-actions button{display:inline-flex;align-items:center;gap:4px;height:32px;min-width:32px;justify-content:center;padding:0 8px;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer}
.rd-c-actions button:hover{background:var(--rd-secondary)}
.rd-c-actions .cv{display:inline-flex;align-items:center}
.rd-c-actions .cv button{padding:0;width:32px}
.rd-c-actions .cv.up{color:var(--rd-up)}.rd-c-actions .cv.up .up path{fill:var(--rd-up)}
.rd-c-actions .cv.down{color:var(--rd-down)}.rd-c-actions .cv.down .down path{fill:var(--rd-down)}
.rd-c-toggle{position:absolute;left:-23px;top:6px;width:20px!important;min-width:20px!important;height:20px!important;padding:0!important;background:#fff!important;color:var(--rd-strong)!important}
.rd-c.collapsed>.rd-c-main>.rd-c-body,.rd-c.collapsed>.rd-c-main>.rd-c-actions,.rd-c.collapsed>.rd-c-main>.rd-c-kids,.rd-c.collapsed>.rd-c-gutter>.rd-c-line{display:none}
.rd-c .hidden-n{display:none}
.rd-c.collapsed>.rd-c-main>.rd-c-meta .hidden-n{display:inline}
.rd-morec{display:flex;align-items:center;gap:8px;margin:16px 0 4px;padding:0 12px;height:32px;border:0;border-radius:999px;background:transparent;color:var(--rd-weak);font-size:12px;font-weight:600;cursor:pointer}
.rd-morec:hover{background:var(--rd-secondary)}
.rd-about{padding:8px 16px 24px}
.rd-about-card{padding:16px;border-radius:16px;background:var(--rd-hover);margin-bottom:12px}
.rd-about-card h2{margin:0 0 6px;color:var(--rd-strong);font-size:16px;font-weight:700;line-height:20px}
.rd-about-card p{margin:0 0 10px;font-size:14px;line-height:20px}
.rd-about-stats{display:flex;gap:24px;margin-top:10px}
.rd-about-stats div{display:flex;flex-direction:column;font-size:12px;color:var(--rd-weak)}
.rd-about-stats b{color:var(--rd-strong);font-size:16px}
.rd-about-card h3{margin:0 0 8px;color:var(--rd-weak);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.rd-rule{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--rd-border-weak);font-size:14px;color:var(--rd-strong)}
.rd-rule:first-of-type{border-top:0}
.rd-rule span{color:var(--rd-weak)}
.rd-member{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:14px}
.rd-member small{display:block;color:var(--rd-weak);font-size:12px;line-height:16px}
`;

  class PhoneUI {
    constructor(engine, db, getSettings, saveSettings, prompts) {
      this.engine = engine; this.db = db; this.getSettings = getSettings; this.saveSettings = saveSettings; this.prompts = prompts;
      this.host = null; this.root = null; this.open = false; this.view = 'home'; this.route = null; this.toastTimer = null;
      this.history = []; this.renderToken = 0; this.promptDraft = null; this.validateTimer = null; this.searchTimer = null;
    }

    mount() {
      if (this.host?.isConnected) return;
      this.host = document.createElement('div');
      this.host.id = 'rp-fanverse-host';
      this.root = this.host.attachShadow({ mode: 'open' });
      const navButton = (view, iconName, label) => `<button data-view="${view}" aria-label="${label}">${icon(iconName, 22)}<span>${label}</span></button>`;
      this.root.innerHTML = `<style>${SHELL_CSS}${PIXIV_CSS}${REDDIT_CSS}</style><button class="launcher" aria-label="RP Fanverse 열기" aria-expanded="false"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6"/><path d="M10.5 5.6h3"/></svg><span class="launcher-badge" hidden></span></button><div class="veil" hidden aria-hidden="true"><section class="phone" role="dialog" aria-modal="true" aria-label="RP Fanverse"><header class="statusbar"><button data-action="back" aria-label="뒤로">${icon('back', 20)}</button><div class="brand"><span class="clock"></span><small></small></div><button data-action="close" aria-label="닫기">${icon('close', 20)}</button></header><main class="screen screen-home"></main><nav>${navButton('home', 'home', 'Home')}${navButton('pixiv', 'pen', 'Pixiv')}${navButton('reddit', 'comment', 'Reddit')}${navButton('settings', 'gear', 'Settings')}</nav><div class="toast" hidden></div></section></div>`;
      document.documentElement.appendChild(this.host);
      this.host.style.setProperty('--ui-scale', String(this.getSettings().uiScale || 1));
      this.bind(); this.refreshBadges();
    }

    bind() {
      this.root.querySelector('.launcher').addEventListener('click', () => this.show());
      this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.hide());
      this.root.querySelector('[data-action="back"]').addEventListener('click', () => this.back());
      this.root.querySelectorAll('nav [data-view]').forEach((button) => button.addEventListener('click', () => this.go(button.dataset.view)));
      this.root.querySelector('.veil').addEventListener('click', (event) => { if (event.target.classList.contains('veil')) this.hide(); });
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && this.open) this.hide(); });
      const main = this.root.querySelector('main');
      main.addEventListener('click', (event) => this.handleClick(event));
      main.addEventListener('change', (event) => this.handleChange(event));
      main.addEventListener('input', (event) => this.handleInput(event));
      main.addEventListener('keydown', (event) => this.handleKeydown(event));
    }

    show() {
      this.open = true;
      const veil = this.root.querySelector('.veil');
      veil.hidden = false; veil.setAttribute('aria-hidden', 'false');
      this.root.querySelector('.launcher').setAttribute('aria-expanded', 'true');
      this.render({ keepScroll: true });
    }

    hide() {
      this.open = false;
      const veil = this.root.querySelector('.veil');
      veil.hidden = true; veil.setAttribute('aria-hidden', 'true');
      this.root.querySelector('.launcher').setAttribute('aria-expanded', 'false');
    }

    confirmDiscardPrompt() {
      if (!this.promptDraft?.dirty) return true;
      if (!confirm('저장하지 않은 프롬프트 변경 사항이 있습니다. 버릴까요?')) return false;
      this.promptDraft = null;
      return true;
    }

    // Bottom-nav switch: a fresh stack per app.
    go(view, route = null) {
      if (!this.confirmDiscardPrompt()) return;
      this.view = view; this.route = route; this.history = [];
      this.render();
    }

    // In-app navigation: remembers where the user was (including scroll) for back().
    push(route, view = this.view) {
      if (!this.confirmDiscardPrompt()) return;
      this.history.push({ view: this.view, route: this.route, scroll: this.root.querySelector('main').scrollTop });
      this.view = view; this.route = route;
      this.render();
    }

    // Same screen, different parameters (sort, tab, search): no history entry.
    replace(route, options = { keepScroll: false }) {
      this.route = route;
      this.render(options);
    }

    back() {
      if (!this.confirmDiscardPrompt()) return;
      const previous = this.history.pop();
      if (previous) { this.view = previous.view; this.route = previous.route; this.render({ restoreScroll: previous.scroll }); return; }
      if (this.route) { this.route = null; this.render(); return; }
      if (this.view !== 'home') this.go('home');
    }

    notify(kind, message) {
      const toast = this.root?.querySelector('.toast');
      if (!toast) return;
      toast.textContent = message; toast.hidden = false; toast.dataset.kind = kind;
      clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { toast.hidden = true; }, kind === 'error' ? 7000 : 3200);
      if (this.open) this.renderHeader();
    }

    renderHeader() {
      const now = new Date();
      const clock = this.root.querySelector('.brand .clock');
      if (clock) clock.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
      const small = this.root.querySelector('.brand small');
      if (small) small.textContent = this.engine.world ? `${this.engine.world.turnCount} turns · ${this.engine.world.sync.adapter}` : 'connecting…';
    }

    refreshBadges() {
      if (!this.root || !this.engine.world) return;
      const badges = this.engine.world.badges;
      const count = badges.phone || 0;
      const badge = this.root.querySelector('.launcher-badge');
      badge.textContent = count > 99 ? '99+' : String(count || '');
      badge.hidden = !count;
      for (const kind of ['pixiv', 'reddit']) {
        const button = this.root.querySelector(`nav [data-view="${kind}"]`);
        let dot = button?.querySelector('.app-badge');
        if (badges[kind] && !dot) { dot = document.createElement('span'); dot.className = 'app-badge'; button.appendChild(dot); }
        if (dot) { dot.textContent = badges[kind] > 99 ? '99+' : String(badges[kind] || ''); dot.hidden = !badges[kind]; }
      }
    }

    async render({ keepScroll = false, restoreScroll = null } = {}) {
      if (!this.open || !this.engine.world) { this.refreshBadges(); return; }
      const token = ++this.renderToken;
      const main = this.root.querySelector('main');
      const previousScroll = main.scrollTop;
      this.renderHeader();
      this.root.querySelectorAll('nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === this.view));
      this.root.querySelector('.phone').classList.toggle('dark-bar', this.view === 'home');
      let html;
      try {
        if (this.view === 'home') html = this.homeHtml();
        else if (this.view === 'reddit') html = await this.redditHtml();
        else if (this.view === 'pixiv') html = await this.pixivHtml();
        else if (this.route?.type === 'prompt-list') html = this.promptListHtml();
        else if (this.route?.type === 'prompt-editor') html = this.promptEditorHtml();
        else html = this.settingsHtml();
      } catch (error) {
        html = `<div class="empty">${Utils.escapeHtml(error.message)}</div>`;
      }
      if (token !== this.renderToken) return; // a newer render started while this one awaited IndexedDB
      main.className = `screen screen-${this.view}`;
      main.innerHTML = html;
      main.scrollTop = restoreScroll ?? (keepScroll ? previousScroll : 0);
      if (this.route?.type === 'prompt-editor') this.updatePromptValidation();
      this.refreshBadges();
    }

    // ---------- shared fragments ----------

    esc(value) { return Utils.escapeHtml(value); }

    paragraphs(text) {
      return String(text || '').split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => `<p>${Utils.nl2br(block)}</p>`).join('');
    }

    redditPersona(id) { return this.engine.world.personas.reddit.find((item) => item.id === id); }
    pixivAuthor(id) { return this.engine.world.personas.pixiv.find((item) => item.id === id); }

    rdAvatar(name, size = 24) {
      const color = RD_AVATARS[Fmt.seed(name || '?', RD_AVATARS.length)];
      return `<span class="rd-av" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.42)}px">${this.esc(String(name || '?').slice(0, 1).toUpperCase())}</span>`;
    }

    rdLogo(size = 32, bare = false) {
      return `<span class="rd-logo" style="width:${size}px;height:${size}px${bare ? ";background:transparent" : ""}"><svg width="${Math.round(size * 0.66)}" height="${Math.round(size * 0.66)}" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="14" rx="8" ry="5.6" fill="#fff"/><circle cx="9" cy="13.4" r="1.3" fill="#ff4500"/><circle cx="15" cy="13.4" r="1.3" fill="#ff4500"/><path d="M9.2 16.2c1.6 1 4 1 5.6 0" stroke="#ff4500" stroke-width="1.1" fill="none" stroke-linecap="round"/><circle cx="17.2" cy="5.6" r="1.6" fill="#fff"/><path d="M12 8.4 13 4.6l4.1.9" stroke="#fff" stroke-width="1.1" fill="none"/></svg></span>`;
    }

    pxAvatar(name, size = 16) {
      const [c1, c2] = PX_COVERS[Fmt.seed(`a:${name}`, PX_COVERS.length)];
      return `<span class="px-av" style="width:${size}px;height:${size}px;--c1:${c1};--c2:${c2};font-size:${Math.round(size * 0.45)}px">${size >= 24 ? this.esc(String(name || '?').slice(0, 1)) : ''}</span>`;
    }

    pxCover(work, size = 's') {
      const [c1, c2] = PX_COVERS[Fmt.seed(work.seriesTitle || work.title || work.id, PX_COVERS.length)];
      const author = this.pixivAuthor(work.authorId);
      return `<div class="px-cover ${size}" style="--c1:${c1};--c2:${c2}"><span class="px-cover-t">${this.esc(work.seriesTitle || work.title)}</span><span class="px-cover-a">${this.esc(author?.name || '')}</span></div>`;
    }

    // ---------- home ----------

    homeHtml() {
      const world = this.engine.world;
      const settings = this.getSettings();
      const now = new Date();
      const pending = Math.max(0, settings.turnsPerUpdate - ((world.turnCount - world.lastProcessedTurn) % settings.turnsPerUpdate));
      const sync = world.sync.status === 'fallback' ? `<span class="warn">⚠ Crack API 실패 — DOM fallback · ${this.esc(world.sync.error)}</span>` : `✓ ${world.sync.adapter === 'api' ? 'Crack API 동기화됨' : '동기화 대기'}`;
      const notice = world.needsCanonRebuild ? '<br><span class="warn">재생성/삭제로 활성 원작 분기가 바뀌었습니다. Settings에서 Canon rebuild가 필요합니다.</span>'
        : world.needsImport ? '<br><span class="warn">기존 장기 로그가 감지되었습니다. Settings에서 원작 가져오기를 실행하세요.</span>'
          : `<br>다음 자동 갱신까지 ${pending} turns`;
      const providerOk = this.engine.gemini.providerReady();
      const app = (go, cls, glyph, label, badge) => `<button class="home-app" data-go="${go}"><span class="home-icon ${cls}">${glyph}</span><span>${label}</span>${badge ? `<span class="app-badge">${badge > 99 ? '99+' : badge}</span>` : ''}</button>`;
      const chips = [...world.fandom.ships.slice(0, 6), ...world.fandom.tags.slice(0, 4)].map((item) => `<button class="home-chip" data-act="px-tag" data-tag="${this.esc(item.tag)}">#${this.esc(item.tag)} · ${Math.round(item.momentum)}</button>`).join('');
      return `<div class="home-time">${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}</div><div class="home-date">${now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })}</div><div class="home-widget"><b>RP is CANON · ${world.turnCount} turns</b><br>${sync}${notice}${providerOk ? '' : '<br><span class="warn">AI provider 미설정 또는 인증 만료 — Settings 확인</span>'}</div><div class="home-apps">${app('pixiv', 'pixiv', 'P', 'pixiv', world.badges.pixiv)}${app('reddit', 'reddit', this.rdLogo(44, true), 'Reddit', world.badges.reddit)}<button class="home-app" data-action="open-prompt-editor"><span class="home-icon prompts">${icon('pen', 26)}</span><span>Prompts</span></button>${app('settings', 'settings', icon('gear', 28), 'Settings', 0)}</div><div class="home-section">Trending in fandom</div><div class="home-chips">${chips || '<span style="opacity:.7;font-size:12px">아직 팬덤 데이터가 없습니다.</span>'}</div>`;
    }

    // ---------- pixiv ----------

    async pixivHtml() {
      const world = this.engine.world;
      const all = await this.db.getAllByWorld(STORES.pixivWorks, world.id);
      all.sort((a, b) => (b.publishOrder || 0) - (a.publishOrder || 0));
      this.pxSeriesMap = new Map();
      for (const work of [...all].reverse()) {
        if (!work.seriesTitle) continue;
        if (!this.pxSeriesMap.has(work.seriesTitle)) this.pxSeriesMap.set(work.seriesTitle, []);
        this.pxSeriesMap.get(work.seriesTitle).push(work);
      }
      const route = this.route || {};
      let body;
      if (route.type === 'pixiv-work') body = await this.pxDetailHtml(all, route.id);
      else if (route.type === 'author') body = this.pxAuthorHtml(all, route.id);
      else if (route.type === 'series') body = this.pxSeriesHtml(route.title);
      else {
        body = this.pxListHtml(all, route);
        if (world.badges.pixiv) {
          world.badges.pixiv = 0; world.badges.phone = world.badges.reddit || 0;
          this.engine.saveWorld();
        }
      }
      return `${this.pxHeaderHtml(route)}${body}`;
    }

    pxHeaderHtml(route) {
      const searchOpen = route.searchOpen || route.type === 'tag';
      return `<div class="px-header"><button data-act="px-home" aria-label="메뉴">${icon('menu', 24)}</button><button class="px-logo" data-act="px-home" aria-label="pixiv 홈">pixiv</button><button data-act="px-search-toggle" aria-label="검색">${icon('search', 24)}</button><span class="px-me" aria-hidden="true"></span></div>${searchOpen ? `<div class="px-searchbar"><label>${icon('search', 18)}<input data-px-search placeholder="소설 검색" value="${this.esc(route.tag || '')}" enterkeyhint="search"></label><button data-act="px-search-cancel">취소</button></div>` : ''}`;
    }

    pxSeriesPosition(work) {
      const list = work.seriesTitle ? this.pxSeriesMap.get(work.seriesTitle) || [] : [];
      const index = list.findIndex((item) => item.id === work.id);
      return { list, index, number: index + 1 };
    }

    pxTagLine(work, { bold = true } = {}) {
      const strong = bold ? [work.workType, work.ship].filter(Boolean).map((tag) => `<button class="px-tagb" data-act="px-tag" data-tag="${this.esc(tag)}">${this.esc(tag)}</button>`).join('') : '';
      return strong + (work.tags || []).filter((tag) => tag !== work.ship).map((tag) => `<button class="px-tag" data-act="px-tag" data-tag="${this.esc(tag)}">${this.esc(tag)}</button>`).join('');
    }

    pxItemHtml(work) {
      const author = this.pixivAuthor(work.authorId);
      const series = this.pxSeriesPosition(work);
      const chars = Number(work.fictionalCharacterCount) || 0;
      return `<div class="px-item" data-act="px-work" data-id="${work.id}"><div class="px-item-cover">${this.pxCover(work, 's')}</div><div class="px-item-body">${work.seriesTitle ? `<button class="px-item-series" data-act="px-series" data-title="${this.esc(work.seriesTitle)}">${this.esc(work.seriesTitle)}</button>` : ''}<div class="px-item-title">${series.number > 0 ? `#${series.number} ` : ''}${this.esc(work.title)}</div><div><button class="px-author" data-act="px-author" data-id="${this.esc(work.authorId)}">${this.pxAvatar(author?.name || work.authorId, 16)}<span>${this.esc(author?.name || work.authorId)}</span></button></div><div class="px-item-tags">${this.pxTagLine(work)}</div><div class="px-item-stats"><span>${Fmt.int(chars)}글자</span><span>${readingMinutes(chars)}분</span>${work.bookmarks ? `<span>${icon('heart', 14)}</span><span style="margin-left:-6px">${Fmt.int(work.bookmarks)}</span>` : ''}${work.hasFullText ? '<span>· 본문 저장됨</span>' : ''}</div><div class="px-item-caption">${this.esc(work.caption || work.summary || '')}</div><button class="px-item-more" data-act="px-caption">더보기</button></div><button class="px-heart ${work.userBookmarked ? 'on' : ''}" data-act="px-bookmark" data-id="${work.id}" aria-label="${work.userBookmarked ? '북마크 해제' : '북마크'}" aria-pressed="${work.userBookmarked ? 'true' : 'false'}">${icon('heart', 24)}</button></div>`;
    }

    pxSeriesCardHtml(title, { link = true } = {}) {
      const list = this.pxSeriesMap.get(title) || [];
      const first = list[0];
      if (!first) return '';
      const chars = list.reduce((sum, work) => sum + (Number(work.fictionalCharacterCount) || 0), 0);
      const genres = [first.workType, first.tone].filter(Boolean).map((genre, index) => `<span class="px-genre" style="--c:${index ? '#8f8f8f' : '#76c3b8'}">${this.esc(genre)}</span>`).join('');
      return `<div class="px-seriescard" ${link ? `data-act="px-series" data-title="${this.esc(title)}"` : ''}>${this.pxCover(first, 'm')}<div class="px-item-body"><div class="px-genres">${genres}</div><h3>${this.esc(title)}</h3><p>${this.esc(first.caption || first.summary || '')}</p><div class="meta">${list.length}화 ${Fmt.int(chars)}글자 ${readingMinutes(chars)}분</div></div></div>`;
    }

    pxListHtml(all, route) {
      const world = this.engine.world;
      const tag = route.type === 'tag' ? route.tag : '';
      const sort = route.sort || 'new';
      let works = tag ? all.filter((work) => (work.tags || []).includes(tag) || work.ship === tag || work.workType === tag || String(work.title).includes(tag) || String(work.seriesTitle || '').includes(tag)) : all.slice();
      if (sort === 'popular') works.sort((a, b) => (b.bookmarks || 0) - (a.bookmarks || 0));
      if (sort === 'bookmarked') works = works.filter((work) => work.userBookmarked);
      const favTags = new Set(world.pixivFavTags || []);
      const tagCounts = new Map();
      for (const work of (tag ? works : all)) for (const item of [...(work.tags || []), work.ship].filter(Boolean)) if (item !== tag) tagCounts.set(item, (tagCounts.get(item) || 0) + 1);
      for (const item of [...world.fandom.ships, ...world.fandom.tags]) if (item.tag !== tag && !tagCounts.has(item.tag)) tagCounts.set(item.tag, 0);
      const palette = ['#7cc5c0', '#c9887e', '#97c97e', '#8ea6d6', '#d9a066', '#b393c9', '#d98fa6'];
      const related = [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name], index) => `<button class="px-reltag" style="--c:${palette[index % palette.length]}" data-act="px-tag" data-tag="${this.esc(name)}">#${this.esc(name)}</button>`).join('');
      const [c1, c2] = PX_COVERS[Fmt.seed(tag || 'fanverse', PX_COVERS.length)];
      const hero = `<div class="px-hero"><div class="px-hero-thumb" style="--c1:${c1};--c2:${c2}">${tag ? '#' : '小'}</div><div><h1>${tag ? `#${this.esc(tag)}` : '小説'}</h1><div class="px-hero-count"><b>${Fmt.int(works.length)}</b> 작품</div>${tag ? `<div style="margin-top:12px"><button class="px-pill ${favTags.has(tag) ? 'gray' : ''}" data-act="px-fav-tag" data-tag="${this.esc(tag)}">${favTags.has(tag) ? '즐겨찾기 해제' : '즐겨찾기에 등록'}</button></div>` : '<div class="px-hero-count" style="margin-top:6px">Fanverse 팬덤의 소설·SS</div>'}</div></div>`;
      const sortButton = (value, label, extra = '') => `<button data-act="px-sort" data-sort="${value}" class="${sort === value ? 'active' : ''}">${label}${extra}</button>`;
      const sortRow = `<div class="px-sortrow">${sortButton('new', '최신순', icon('chevronDown', 16))}<span class="sep"></span>${sortButton('popular', '인기순')}${sortButton('series', '시리즈로 모으기')}${sortButton('bookmarked', '북마크')}</div>`;
      let list;
      if (sort === 'series') {
        const titles = [...new Set(works.map((work) => work.seriesTitle).filter(Boolean))];
        list = titles.length ? `<div style="display:grid;gap:8px;padding:0 0 32px">${titles.map((title) => this.pxSeriesCardHtml(title)).join('')}</div>` : '<div class="empty">시리즈 작품이 아직 없습니다.</div>';
      } else {
        list = works.length ? `<div class="px-list">${works.slice(0, 60).map((work) => this.pxItemHtml(work)).join('')}</div>` : `<div class="empty">${sort === 'bookmarked' ? '북마크한 작품이 없습니다.' : tag ? '해당 태그의 작품이 없습니다.' : '다음 Fanverse update에서 작품이 추가됩니다.'}</div>`;
      }
      return `${hero}${related ? `<div class="px-reltags">${related}</div>` : ''}<div class="px-tabs"><button disabled>메인</button><button disabled>일러스트</button><button disabled>만화</button><button class="active">소설</button><button class="px-tab-filter" data-act="px-sort" data-sort="${sort}" aria-label="검색 옵션">${icon('filter', 22)}</button></div>${sortRow}<div class="px-count"><span>${Fmt.int(sort === 'series' ? new Set(works.map((work) => work.seriesTitle).filter(Boolean)).size : works.length)}</span></div>${list}`;
    }

    pxReaderStyle() {
      const reader = this.getSettings().pixivReader;
      const size = { s: '14px', m: '16px', l: '18px' }[reader.size];
      // Single quotes only: this value is placed inside a double-quoted style attribute.
      const font = reader.font === 'mincho' ? "'Hiragino Mincho ProN','Yu Mincho',YuMincho,'Noto Serif JP','Noto Serif KR',serif" : "YuGothic,'Yu Gothic','Hiragino Kaku Gothic ProN','Noto Sans JP','Noto Sans KR',sans-serif";
      return { reader, attr: `class="px-reader theme-${reader.theme}" style="--rd-size:${size};--rd-font:${font}"` };
    }

    // Pixiv novel markup: blank lines separate paragraphs, [newpage] splits pages, [chapter:…] is a heading.
    pxReaderBody(text, { cursor = false } = {}) {
      const pages = String(text || '').split(/\[newpage\]/i);
      const html = pages.map((page, index) => `${index ? `<div class="px-pagebreak">${index + 1} / ${pages.length}</div>` : ''}${page.split(/\n{2,}/).map((block) => block.replace(/^\n+|\n+$/g, '')).filter((block) => block.trim()).map((block) => {
        const chapter = block.trim().match(/^\[chapter:(.+?)\]$/i);
        return chapter ? `<h2 class="px-chapter">${this.esc(chapter[1])}</h2>` : `<p class="px-p">${Utils.nl2br(block)}</p>`;
      }).join('')}`).join('');
      return { html: html + (cursor ? '<p class="px-p"><span class="px-cursor"></span></p>' : ''), pages: pages.length };
    }

    pxLikeCount(work) {
      return Math.round((Number(work.bookmarks) || 0) * 0.85) + Fmt.seed(work.id, 40) + (work.userLiked ? 1 : 0);
    }

    async pxDetailHtml(all, id) {
      const work = all.find((item) => item.id === id);
      if (!work) return '<div class="empty">작품을 찾을 수 없습니다.</div>';
      const world = this.engine.world;
      const author = this.pixivAuthor(work.authorId);
      const authorName = author?.name || work.authorId;
      const following = (world.pixivFollows || []).includes(work.authorId);
      const cached = await this.db.get(STORES.fanworks, work.id);
      const series = this.pxSeriesPosition(work);
      const chars = Number(work.fictionalCharacterCount) || 0;
      const { reader, attr } = this.pxReaderStyle();
      const authorBar = `<div class="px-authorbar"><button class="px-author" data-act="px-author" data-id="${this.esc(work.authorId)}">${this.pxAvatar(authorName, 40)}<span>${this.esc(authorName)}</span></button><button class="px-pill ${following ? 'gray' : ''}" data-act="px-follow" data-id="${this.esc(work.authorId)}">${following ? '팔로우 중' : '팔로우하기'}</button></div>`;
      const likeBar = `<div class="px-likebar"><button class="px-like ${work.userLiked ? 'on' : ''}" data-act="px-like" data-id="${work.id}">${icon('smile', 20)}<span>좋아요!</span></button><span class="grow"></span><button class="px-iconbtn ${work.userBookmarked ? 'on' : ''}" data-act="px-bookmark" data-id="${work.id}" aria-label="북마크">${icon('heart', 28)}</button><button class="px-iconbtn" data-act="px-share" data-id="${work.id}" aria-label="공유">${icon('share', 24)}</button></div>`;
      const next = series.index >= 0 ? series.list[series.index + 1] : null;
      const prev = series.index > 0 ? series.list[series.index - 1] : null;
      let readerHtml;
      let pageCount = 1;
      if (cached) {
        const body = this.pxReaderBody(cached.text);
        pageCount = body.pages;
        readerHtml = `<div ${attr}>${body.html}<div class="px-pagecount">${pageCount} / ${pageCount} 페이지</div></div>`;
      } else {
        readerHtml = `<div class="px-generate"><button class="px-pill wide" data-act="px-generate" data-id="${work.id}">본문 생성하여 읽기</button><p>목표 ${Fmt.int(this.getSettings().fanworkTargetLength)}자 · ${this.esc(this.getSettings().fanworkLanguage)}<br>생성한 전문은 IndexedDB에 저장되어 다음부터 바로 열립니다.</p></div><div id="fanwork-stream" ${attr}></div>`;
      }
      const panel = this.route?.readerPanel ? `<div class="px-readerpanel"><div><span>글자 크기</span>${[['s', '작게'], ['m', '보통'], ['l', '크게']].map(([value, label]) => `<button class="${reader.size === value ? 'on' : ''}" data-act="px-reader-set" data-key="size" data-value="${value}">${label}</button>`).join('')}</div><div><span>글꼴</span>${[['gothic', '고딕'], ['mincho', '명조']].map(([value, label]) => `<button class="${reader.font === value ? 'on' : ''}" data-act="px-reader-set" data-key="font" data-value="${value}">${label}</button>`).join('')}</div><div><span>배경</span>${[['light', '화이트'], ['sepia', '세피아'], ['dark', '다크']].map(([value, label]) => `<button class="${reader.theme === value ? 'on' : ''}" data-act="px-reader-set" data-key="theme" data-value="${value}">${label}</button>`).join('')}</div></div>` : '';
      const seriesBox = work.seriesTitle ? `<div class="px-seriesbox"><div class="px-seriesbox-label">시리즈</div><button class="px-seriesbox-title" data-act="px-series" data-title="${this.esc(work.seriesTitle)}">${this.esc(work.seriesTitle)}</button><div class="px-nav">${next ? `<button data-act="px-work" data-id="${next.id}" data-replace="1">다음 화 #${series.number + 1}</button>` : '<button disabled>최신화입니다</button>'}${prev ? `<button data-act="px-work" data-id="${prev.id}" data-replace="1">이전 화 #${series.number - 1}</button>` : ''}</div></div>` : '';
      const continuity = cached?.continuity?.issues?.length ? `<div class="px-continuity">Fanverse continuity check${cached.revisionApplied ? ' · 수정 pass 적용됨' : ''}<br>${cached.continuity.issues.map((issue) => `· ${this.esc(issue)}`).join('<br>')}</div>` : '';
      const others = all.filter((item) => item.authorId === work.authorId && item.id !== work.id).slice(0, 3);
      const related = all.filter((item) => item.id !== work.id && item.authorId !== work.authorId).map((item) => ({ item, score: (item.ship && item.ship === work.ship ? 3 : 0) + (item.tags || []).filter((tag) => (work.tags || []).includes(tag)).length })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((entry) => entry.item);
      return `${authorBar}<div class="px-detail-head"><div class="px-detail-title">${this.esc(work.title)}</div>${work.seriesTitle ? `<button class="px-detail-series" data-act="px-series" data-title="${this.esc(work.seriesTitle)}">${this.esc(work.seriesTitle)} #${series.number}</button>` : ''}${next ? `<button class="px-detail-next" data-act="px-work" data-id="${next.id}" data-replace="1" aria-label="다음 화">${icon('chevronRight', 24)}</button>` : ''}<div class="px-detail-cover"><span class="px-charbadge">${Fmt.int(chars)}글자</span>${this.pxCover(work, 'l')}</div></div>${likeBar}<div class="px-caption" data-act="px-caption-detail">${this.esc(work.caption || work.summary || '')}</div><div class="px-detail-name">${this.esc(work.title)}</div><div class="px-detail-tags">${this.pxTagLine(work)}</div><div class="px-detail-stats"><span>${icon('smile', 14)}${Fmt.int(this.pxLikeCount(work))}</span><span>${icon('heart', 14)}${Fmt.int(work.bookmarks)}</span><span>${icon('eye', 14)}${Fmt.int(work.views)}</span><span>${readingMinutes(chars)}분</span></div><div class="px-date">${this.esc(Fmt.pixivDate(work.createdAt))} · RP turn ${work.turn}</div><div class="px-readerbar"><button data-act="px-reader-top" aria-label="본문 처음으로">${icon('list', 22)}</button><button class="${this.route?.readerPanel ? 'on' : ''}" data-act="px-reader-panel" aria-label="표시 설정">${icon('textSize', 22)}</button><button class="${work.userBookmarked ? 'on' : ''}" data-act="px-bookmark" data-id="${work.id}" aria-label="북마크">${icon('bookmark', 22)}</button><button data-act="px-copy-text" data-id="${work.id}" aria-label="본문 복사">${icon('more', 22)}</button></div>${panel}${readerHtml}${cached ? likeBar : ''}${seriesBox}${continuity}<div style="margin-top:24px;border-top:8px solid var(--px-bg2)"></div>${authorBar}${others.length ? `<div class="px-graylist">${others.map((item) => `<div class="px-graycard" data-act="px-work" data-id="${item.id}" data-replace="1"><div class="px-item-body">${item.seriesTitle ? `<div class="px-item-series">${this.esc(item.seriesTitle)}</div>` : ''}<div class="px-item-title">${this.esc(item.title)}</div><div class="px-item-stats" style="padding:0">${Fmt.int(item.fictionalCharacterCount)}글자</div><div class="px-item-tags" style="padding:0">${this.pxTagLine(item)}</div></div></div>`).join('')}</div><div style="padding:0 16px 8px"><button class="px-pill black" data-act="px-author" data-id="${this.esc(work.authorId)}">모두 보기</button></div>` : ''}<div class="px-section-title">이쪽도 추천드려요</div>${related.length ? `<div class="px-list">${related.map((item) => this.pxItemHtml(item)).join('')}</div>` : '<div class="empty" style="padding-top:8px">아직 추천할 작품이 없습니다.</div>'}`;
    }

    pxAuthorHtml(all, id) {
      const world = this.engine.world;
      const author = this.pixivAuthor(id);
      const name = author?.name || id;
      const works = all.filter((work) => work.authorId === id);
      const following = (world.pixivFollows || []).includes(id);
      const followers = 40 + Fmt.seed(`followers:${id}`, 2400) + works.reduce((sum, work) => sum + Math.round((work.bookmarks || 0) / 40), 0) + (following ? 1 : 0);
      const [c1, c2] = PX_COVERS[Fmt.seed(`a:${name}`, PX_COVERS.length)];
      const seriesTitles = [...new Set(works.map((work) => work.seriesTitle).filter(Boolean))];
      return `<div class="px-profile-banner" style="--c1:${c1};--c2:${c2}"></div><div class="px-profile"><button class="px-iconbtn px-profile-share" data-act="px-share-author" aria-label="공유">${icon('share', 22)}</button>${this.pxAvatar(name, 84).replace('class="px-av"', 'class="px-av px-profile-av"')}<h1>${this.esc(name)}</h1><button class="px-pill wide ${following ? 'gray' : ''}" data-act="px-follow" data-id="${this.esc(id)}">${following ? '팔로우 중' : '팔로우하기'}</button><div class="px-profile-follow"><b>${Fmt.int(Fmt.seed(`following:${id}`, 180) + 3)}</b> 팔로우 중 · <b>${Fmt.int(followers)}</b> 팔로워</div><div class="px-profile-bio">${this.esc([author?.specialty, author?.style].filter(Boolean).join('\n'))}</div></div><div class="px-utabs"><button disabled>홈</button><button disabled>일러스트</button><button class="active">소설</button></div>${seriesTitles.length ? `<div class="px-subtitle">소설 시리즈</div><div style="display:grid;gap:8px">${seriesTitles.map((title) => this.pxSeriesCardHtml(title)).join('')}</div>` : ''}<div class="px-count" style="padding-top:20px"><span>${works.length}</span></div>${works.length ? `<div class="px-list">${works.map((work) => this.pxItemHtml(work)).join('')}</div>` : '<div class="empty">작품이 없습니다.</div>'}`;
    }

    pxSeriesHtml(title) {
      const list = this.pxSeriesMap.get(title) || [];
      if (!list.length) return '<div class="empty">시리즈 작품이 없습니다.</div>';
      const author = this.pixivAuthor(list[0].authorId);
      const following = (this.engine.world.pixivFollows || []).includes(list[0].authorId);
      return `${this.pxSeriesCardHtml(title, { link: false })}<div class="px-authorbar"><button class="px-author" data-act="px-author" data-id="${this.esc(list[0].authorId)}">${this.pxAvatar(author?.name || list[0].authorId, 32)}<span>${this.esc(author?.name || list[0].authorId)}</span></button><button class="px-pill ${following ? 'gray' : ''}" data-act="px-follow" data-id="${this.esc(list[0].authorId)}">${following ? '팔로우 중' : '팔로우하기'}</button></div><div class="px-subtitle">${list.length}화</div><div class="px-list">${list.map((work) => this.pxItemHtml(work)).join('')}</div>`;
    }

    // ---------- reddit ----------

    rdSorters() {
      const age = (post) => Math.max(0, (Date.now() - (Date.parse(post.createdAt || '') || Date.now())) / 3600000);
      return {
        best: (a, b) => ((b.score || 0) + (b.comments?.length || 0) * 3) / Math.pow(age(b) + 2, 0.35) - ((a.score || 0) + (a.comments?.length || 0) * 3) / Math.pow(age(a) + 2, 0.35),
        hot: (a, b) => ((b.score || 0) + (b.comments?.length || 0) * 4 + (b.turn || 0) * 2) / Math.pow(age(b) + 2, 0.8) - ((a.score || 0) + (a.comments?.length || 0) * 4 + (a.turn || 0) * 2) / Math.pow(age(a) + 2, 0.8),
        new: (a, b) => (Date.parse(b.createdAt || '') || b.turn || 0) - (Date.parse(a.createdAt || '') || a.turn || 0),
        top: (a, b) => (b.score || 0) - (a.score || 0),
      };
    }

    rdStats(posts) {
      const world = this.engine.world;
      return { members: 1200 + Fmt.seed(world.id, 30000) + posts.length * 37 + (world.redditJoined ? 1 : 0), online: 12 + Fmt.seed(`${world.id}:${new Date().getHours()}`, 280) };
    }

    rdFlair(category) {
      const [bg, fg] = RD_FLAIRS[Fmt.seed(String(category || '').toLowerCase(), RD_FLAIRS.length)];
      return `<span class="rd-flair" style="--fb:${bg};--fc:${fg}">${this.esc(category)}</span>`;
    }

    rdVote(target, vote, score, { comment = false, postId = '' } = {}) {
      const state = vote === 1 ? 'up' : vote === -1 ? 'down' : '';
      const act = comment ? `data-act="rd-cvote" data-post="${postId}"` : 'data-act="rd-vote"';
      const size = comment ? 16 : 18;
      return `<span class="${comment ? 'cv' : 'rd-vote'} ${state}"><button class="up" ${act} data-id="${target}" data-value="1" aria-label="Upvote" aria-pressed="${vote === 1}">${icon('up', size)}</button><span class="n">${Fmt.compact(score)}</span><button class="down" ${act} data-id="${target}" data-value="-1" aria-label="Downvote" aria-pressed="${vote === -1}">${icon('down', size)}</button></span>`;
    }

    rdBody(post, { clamp = false } = {}) {
      const body = `<div class="rd-body ${clamp ? 'clamp' : ''}">${this.paragraphs(post.body)}</div>`;
      if (!post.spoiler || this.rdRevealed?.has(post.id)) return body;
      return `<div class="rd-spoiler">${body}<button data-act="rd-spoiler" data-id="${post.id}">스포일러 보기</button></div>`;
    }

    rdPostHtml(post) {
      const persona = this.redditPersona(post.personaId);
      const name = persona?.name || post.personaId;
      return `<article class="rd-post" data-act="rd-post" data-id="${post.id}"><div class="rd-credit"><button class="who" data-act="rd-post" data-id="${post.id}">${this.rdAvatar(name, 24)}<b>u/${this.esc(name)}</b></button><span class="dot">•</span><time>${Fmt.ago(post.createdAt)}</time><button class="rd-iconbtn" data-act="rd-noop" aria-label="더보기">${icon('more', 18)}</button></div><h2 class="rd-title">${this.esc(post.title)}</h2><div class="rd-flairs">${this.rdFlair(post.category)}${post.spoiler ? `<span class="rd-spoiler-badge">${icon('warning', 12)}스포일러</span>` : ''}</div>${this.rdBody(post, { clamp: true })}<div class="rd-actions">${this.rdVote(post.id, post.userVote, post.score)}<button class="rd-pill" data-act="rd-post" data-id="${post.id}" aria-label="댓글로 이동">${icon('comment', 18)}${Fmt.compact(Math.max(post.comments?.length || 0, post.estimatedCommentCount || 0))}</button><button class="rd-pill" data-act="rd-share" data-id="${post.id}">${icon('share', 18)}공유</button></div></article>`;
    }

    rdHeaderHtml(q = '') {
      return `<div class="rd-header"><button class="rd-iconbtn" data-act="rd-home" aria-label="r/Fanverse 홈">${icon('menu', 22)}</button><label class="rd-search">${icon('search', 18)}<span class="rd-search-chip">${this.rdLogo(20)}r/Fanverse</span><input data-rd-search placeholder="검색" value="${this.esc(q)}" enterkeyhint="search"></label>${this.rdAvatar('you', 32)}</div>`;
    }

    async redditHtml() {
      const world = this.engine.world;
      const posts = await this.db.getAllByWorld(STORES.redditPosts, world.id);
      this.rdRevealed ||= new Set();
      this.rdCollapsed ||= new Set();
      const route = this.route || {};
      if (route.type === 'reddit-post') return this.rdDetailHtml(posts, route);
      if (world.badges.reddit) {
        world.badges.reddit = 0; world.badges.phone = world.badges.pixiv || 0;
        this.engine.saveWorld();
      }
      const sort = route.sort || 'best';
      const tab = route.tab || 'feed';
      const q = String(route.q || '').trim().toLowerCase();
      const stats = this.rdStats(posts);
      const sortLabels = { best: ['베스트', 'rocket'], hot: ['인기', 'flame'], new: ['신규', 'sparkle'], top: ['톱', 'top'] };
      const sortMenu = route.sortMenu ? `<div class="rd-menu" style="right:16px;top:44px"><div class="rd-menu-title">정렬 기준</div>${Object.entries(sortLabels).map(([value, [label, iconName]]) => `<button class="${sort === value ? 'active' : ''}" data-act="rd-sort" data-sort="${value}">${icon(iconName, 20)}${label}</button>`).join('')}</div>` : '';
      const [c1, c2] = [RD_AVATARS[Fmt.seed(world.id, RD_AVATARS.length)], '#e5ebee'];
      const top = `${this.rdHeaderHtml(route.q || '')}<div class="rd-banner" style="--c1:${c1};--c2:${c2}"></div><div class="rd-comm"><span class="rd-comm-icon">${this.rdLogo(48)}</span><h1>r/Fanverse</h1></div><div class="rd-comm-meta"><b>${Fmt.compact(stats.members)}</b> 멤버 · <span style="color:#46d160">●</span> <b>${stats.online}</b> 온라인</div><div class="rd-comm-actions"><button class="rd-btn outline" data-act="rd-compose">${icon('plus', 18)}게시물 만들기</button><button class="rd-btn ${world.redditJoined ? 'outline' : 'black'}" data-act="rd-join">${world.redditJoined ? '가입됨' : '가입하기'}</button></div><div class="rd-tabs" style="position:relative"><button class="rd-tab ${tab === 'feed' ? 'active' : ''}" data-act="rd-tab" data-tab="feed">피드</button><button class="rd-tab ${tab === 'about' ? 'active' : ''}" data-act="rd-tab" data-tab="about">정보</button><span class="grow"></span>${tab === 'feed' ? `<button class="rd-sortbtn" data-act="rd-sort-menu" aria-haspopup="menu" aria-expanded="${Boolean(route.sortMenu)}">${sortLabels[sort][0]}${icon('chevronDown', 16)}</button><button class="rd-sortbtn" data-act="rd-noop" aria-label="보기 방식">${icon('cards', 18)}${icon('chevronDown', 16)}</button>` : ''}${sortMenu}</div>`;
      if (tab === 'about') return `<div class="reddit-shell">${top}${this.rdAboutHtml(posts, stats)}</div>`;
      let feed = posts.slice();
      if (q) feed = feed.filter((post) => `${post.title}\n${post.body}\n${post.category}`.toLowerCase().includes(q));
      feed.sort(this.rdSorters()[sort] || this.rdSorters().best);
      const highlights = !q && posts.length >= 3 ? [...posts].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 2) : [];
      const highlightHtml = highlights.length ? `<div class="rd-highlights"><h3>${icon('pin', 18)}커뮤니티 하이라이트</h3><div class="rd-hl-row">${highlights.map((post) => `<button class="rd-hl" data-act="rd-post" data-id="${post.id}"><span>${this.esc(post.title)}</span><small>${icon('shield', 16)}${icon('up', 14)} ${Fmt.compact(post.score)} · ${icon('comment', 14)} ${Fmt.compact(post.comments?.length || 0)}</small></button>`).join('')}</div></div>` : '';
      const list = feed.slice(0, 60).map((post) => this.rdPostHtml(post)).join('<hr class="rd-hr">');
      return `<div class="reddit-shell">${top}${highlightHtml}<hr class="rd-hr">${list || `<div class="empty">${q ? `"${this.esc(route.q)}" 검색 결과가 없습니다.` : '다음 Fanverse update 뒤 토론이 생깁니다.'}</div>`}</div>`;
    }

    rdAboutHtml(posts, stats) {
      const world = this.engine.world;
      const flairs = posts.reduce((map, post) => map.set(post.category, (map.get(post.category) || 0) + 1), new Map());
      const rules = ['Canon과 팬 해석을 구분해서 쓰기', '최신 회차 내용은 스포일러 태그 필수', 'CP·캐릭터 비하 금지 — 해석은 자유, 공격은 금지', '밈은 밈 플레어로', '근거 없는 "공식 확정" 단정 금지'];
      return `<div class="rd-about"><div class="rd-about-card"><h2>r/Fanverse</h2><p>공식 RP를 원작(Canon)으로 실시간 읽는 가상 팬 커뮤니티입니다. 같은 Canon을 공유하지만 해석은 저마다 다릅니다.</p><div style="font-size:12px;color:var(--rd-weak)">${icon('clock', 14).replace('class="ic ', 'style="display:inline;vertical-align:-2px" class="ic ')} 생성일 ${new Date(world.createdAt || Date.now()).toLocaleDateString('ko-KR')}</div><div class="rd-about-stats"><div><b>${Fmt.compact(stats.members)}</b>멤버</div><div><b>${stats.online}</b>온라인</div><div><b>${posts.length}</b>게시물</div></div></div><div class="rd-about-card"><h3>r/Fanverse 규칙</h3>${rules.map((rule, index) => `<div class="rd-rule"><span>${index + 1}</span>${this.esc(rule)}</div>`).join('')}</div>${flairs.size ? `<div class="rd-about-card"><h3>플레어</h3><div class="rd-flairs">${[...flairs].map(([name, count]) => `${this.rdFlair(name)}<span style="font-size:12px;color:var(--rd-weak);margin-right:6px">${count}</span>`).join('')}</div></div>` : ''}<div class="rd-about-card"><h3>활동 중인 멤버</h3>${world.personas.reddit.map((persona) => `<div class="rd-member">${this.rdAvatar(persona.name, 32)}<div>u/${this.esc(persona.name)}<small>${this.esc(persona.archetype)} · ${this.esc(persona.bias)}</small></div></div>`).join('')}</div></div>`;
    }

    rdCommentTime(post, comment, index) {
      if (comment.createdAt) return comment.createdAt;
      const base = Date.parse(post.createdAt || '') || Date.now();
      return new Date(Math.min(Date.now(), base + (index + 1) * (6 + Fmt.seed(comment.id, 50)) * 60000)).toISOString();
    }

    rdCommentsSorted(post, list) {
      const sort = this.route?.csort || 'best';
      const order = new Map((post.comments || []).map((comment, index) => [comment.id, index]));
      const time = (comment) => Date.parse(this.rdCommentTime(post, comment, order.get(comment.id) || 0)) || 0;
      const sorters = {
        best: (a, b) => ((b.score || 0) + this.rdDescendants(post, b.id) * 3) - ((a.score || 0) + this.rdDescendants(post, a.id) * 3),
        top: (a, b) => (b.score || 0) - (a.score || 0),
        new: (a, b) => time(b) - time(a),
        old: (a, b) => time(a) - time(b),
      };
      return list.slice().sort(sorters[sort] || sorters.best);
    }

    rdDescendants(post, id) {
      const kids = (post.comments || []).filter((comment) => comment.parentId === id);
      return kids.reduce((sum, kid) => sum + 1 + this.rdDescendants(post, kid.id), 0);
    }

    rdCommentHtml(post, comment, depth) {
      const persona = this.redditPersona(comment.personaId);
      const name = persona?.name || comment.personaId;
      const index = (post.comments || []).findIndex((item) => item.id === comment.id);
      const children = this.rdCommentsSorted(post, (post.comments || []).filter((item) => item.parentId === comment.id));
      const hiddenCount = this.rdDescendants(post, comment.id);
      const collapsed = this.rdCollapsed.has(comment.id);
      let kids = '';
      if (children.length && depth >= 7) kids = `<button class="rd-morec" data-act="rd-thread" data-post="${post.id}" data-id="${comment.id}">${icon('chevronRight', 18)}스레드 계속 보기 (${hiddenCount})</button>`;
      else if (children.length) kids = children.map((child) => this.rdCommentHtml(post, child, depth + 1)).join('');
      return `<div class="rd-c ${collapsed ? 'collapsed' : ''}" data-comment-id="${comment.id}"><div class="rd-c-gutter">${this.rdAvatar(name, 32)}${children.length ? '<span class="rd-c-line"></span>' : ''}</div><div class="rd-c-main"><div class="rd-c-meta" data-act="rd-collapse" data-id="${comment.id}"><b>${this.esc(name)}</b>${comment.personaId === post.personaId ? '<span class="op">OP</span>' : ''}<span class="dot">•</span><time>${Fmt.ago(this.rdCommentTime(post, comment, index))}</time>${hiddenCount ? `<span class="hidden-n">· 답글 ${hiddenCount}개</span>` : ''}</div><div class="rd-c-body">${this.paragraphs(comment.body)}</div><div class="rd-c-actions">${children.length ? `<button class="rd-c-toggle" data-act="rd-collapse" data-id="${comment.id}" aria-label="스레드 접기">${icon('minusCircle', 20)}</button>` : ''}${this.rdVote(comment.id, comment.userVote, comment.score, { comment: true, postId: post.id })}<button data-act="rd-compose">${icon('comment', 16)}답글</button><button data-act="rd-share" data-id="${post.id}">공유</button><button data-act="rd-noop" aria-label="더보기">${icon('more', 16)}</button></div>${kids ? `<div class="rd-c-kids">${kids}</div>` : ''}</div></div>`;
    }

    rdDetailHtml(posts, route) {
      const post = posts.find((item) => item.id === route.id);
      if (!post) return `${this.rdHeaderHtml()}<div class="empty">게시물을 찾을 수 없습니다.</div>`;
      const persona = this.redditPersona(post.personaId);
      const name = persona?.name || post.personaId;
      const csort = route.csort || 'best';
      const csortLabels = { best: '베스트', top: '톱', new: '신규', old: '오래된 순' };
      const comments = post.comments || [];
      const roots = route.focus ? comments.filter((comment) => comment.id === route.focus) : comments.filter((comment) => !comment.parentId || !comments.some((item) => item.id === comment.parentId));
      const tree = this.rdCommentsSorted(post, roots).map((comment) => this.rdCommentHtml(post, comment, 0)).join('');
      const remaining = Math.max(0, (post.estimatedCommentCount || 0) - comments.length);
      const menu = route.csortMenu ? `<div class="rd-menu" style="left:16px;top:30px"><div class="rd-menu-title">댓글 정렬</div>${Object.entries(csortLabels).map(([value, label]) => `<button class="${csort === value ? 'active' : ''}" data-act="rd-csort" data-sort="${value}">${label}</button>`).join('')}</div>` : '';
      return `<div class="reddit-shell">${this.rdHeaderHtml()}<div class="rd-detail-head"><button class="rd-iconbtn filled" data-act="rd-back" aria-label="뒤로">${icon('back', 18)}</button>${this.rdLogo(32)}<div class="col"><span><b>r/Fanverse</b> <span class="dot">•</span> <time>${Fmt.ago(post.createdAt)}</time></span><span>${this.esc(name)}</span></div><span class="grow"></span><button class="rd-iconbtn" data-act="rd-noop" aria-label="더보기">${icon('more', 18)}</button></div><h1 class="rd-detail-title">${this.esc(post.title)}</h1><div class="rd-detail-body"><div class="rd-flairs">${this.rdFlair(post.category)}${post.spoiler ? `<span class="rd-spoiler-badge">${icon('warning', 12)}스포일러</span>` : ''}</div>${this.rdBody(post)}<p class="rd-canon-note">RP canon turn ${post.turn} 시점의 반응${post.sourceCanonEventIds?.length ? ` · 관련 Canon event ${post.sourceCanonEventIds.length}개` : ''}</p></div><div class="rd-detail-actions"><div class="rd-actions">${this.rdVote(post.id, post.userVote, post.score)}<button class="rd-pill" data-act="rd-noop">${icon('comment', 18)}${Fmt.compact(Math.max(comments.length, post.estimatedCommentCount || 0))}</button><button class="rd-pill" data-act="rd-share" data-id="${post.id}">${icon('share', 18)}공유</button></div></div><div class="rd-composer" data-act="rd-compose">대화 참여하기</div><div class="rd-csort"><span>정렬 기준:</span><button class="rd-sortbtn" data-act="rd-csort-menu" aria-haspopup="menu">${csortLabels[csort]}${icon('chevronDown', 16)}</button>${menu}</div>${route.focus ? `<div style="padding:0 16px"><button class="rd-morec" style="margin:0" data-act="rd-unfocus">${icon('back', 16)}전체 댓글 보기</button></div>` : ''}<div class="rd-comments">${tree || '<div class="empty" style="padding:24px 0">아직 댓글이 없습니다.</div>'}${!route.focus && post.hasMoreComments ? `<button class="rd-morec" data-act="rd-more" data-id="${post.id}">${icon('plusCircle', 20)}댓글 더 보기${remaining ? ` (약 ${remaining}개)` : ''}</button>` : ''}</div></div>`;
    }

    // ---------- settings ----------

    developerPanelHtml(s) {
      return `<div class="st-card"><label class="st-field"><span>Gemini Developer API key · GM storage에만 저장, export 제외</span><input type="password" data-setting="apiKey" value="${this.esc(s.apiKey)}" autocomplete="off" placeholder="AIza…"></label><div class="st-status"><span class="st-dot ${s.apiKey ? 'ok' : ''}"></span>${s.apiKey ? 'API key 설정됨' : 'API key 없음'}</div><button class="st-btn" data-action="test-developer">Gemini API 연결 테스트${icon('chevronRight', 18)}</button></div><div class="st-note">Endpoint: <code>${this.esc(`${GEMINI_BASE}/${resolveModelId(s)}:generateContent`)}</code></div>`;
    }

    vertexPanelHtml(s) {
      const vertex = this.engine.gemini.vertexStatus();
      const minutes = Math.ceil(vertex.expiresInSeconds / 60);
      const tokenLine = vertex.authenticated ? `access token 유효 · 약 ${minutes}분 남음 (${vertex.source === 'manual' ? '수동 입력' : 'Google 로그인'})` : vertex.hasToken ? 'access token 만료 — 재인증 필요' : 'access token 없음';
      const endpoint = s.vertexProjectId ? buildVertexEndpoint(s, false) : '(Project ID를 입력하면 표시됩니다)';
      return `<div class="st-card"><label class="st-field"><span>Google Cloud Project ID</span><input data-setting="vertexProjectId" value="${this.esc(s.vertexProjectId)}" placeholder="my-gcp-project" autocomplete="off"></label><label class="st-field"><span>Location · global 권장 (us / eu 멀티 리전 또는 us-central1 같은 리전도 가능)</span><input data-setting="vertexLocation" value="${this.esc(s.vertexLocation)}" list="rpf-vertex-locations" placeholder="global"><datalist id="rpf-vertex-locations"><option value="global"><option value="us"><option value="eu"><option value="us-central1"><option value="asia-northeast3"><option value="asia-northeast1"></datalist></label><label class="st-field"><span>API version</span><select data-setting="vertexApiVersion"><option value="v1" ${s.vertexApiVersion === 'v1' ? 'selected' : ''}>v1 (권장)</option><option value="v1beta1" ${s.vertexApiVersion === 'v1beta1' ? 'selected' : ''}>v1beta1</option></select></label><label class="st-field"><span>OAuth 2.0 Client ID (웹 애플리케이션)</span><input data-setting="vertexOAuthClientId" value="${this.esc(s.vertexOAuthClientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off"></label><div class="st-status"><span class="st-dot ${vertex.authenticated ? 'ok' : vertex.hasToken ? 'bad' : ''}"></span>${tokenLine}</div><button class="st-btn" data-action="vertex-auth">${vertex.hasToken ? 'Google 재인증' : 'Google 로그인'}${icon('chevronRight', 18)}</button><button class="st-btn" data-action="test-vertex">Vertex AI 연결 테스트${icon('chevronRight', 18)}</button><button class="st-btn danger" data-action="vertex-revoke" ${vertex.hasToken ? '' : 'disabled'}>토큰 폐기 (로그아웃)</button></div><div class="st-note">Endpoint: <code>${this.esc(endpoint)}</code></div><div class="st-section">수동 access token (선택)</div><div class="st-card"><label class="st-field"><span><code class="st-code">gcloud auth print-access-token</code> 결과를 붙여넣기 · 약 1시간 유효</span><input type="password" data-vertex-manual-token autocomplete="off" placeholder="ya29.…"></label><button class="st-btn" data-action="vertex-manual-token">토큰 확인 후 적용${icon('chevronRight', 18)}</button></div><div class="st-section">Vertex AI 준비 순서</div><details class="st-details"><summary>설정 방법 보기 ${icon('chevronDown', 18)}</summary><ol class="st-steps"><li>Google Cloud 프로젝트에 결제 계정을 연결합니다. 신규 가입 무료 체험 크레딧은 일반 Vertex AI 사용량에도 적용됩니다.</li><li>프로젝트에서 <b>Vertex AI API</b>(aiplatform.googleapis.com)를 사용 설정합니다.</li><li>IAM에서 로그인할 Google 계정에 <b>Vertex AI User</b>(roles/aiplatform.user) 역할을 부여합니다.</li><li>OAuth 동의 화면을 구성하고(테스트 모드면 본인을 테스트 사용자로 추가), <b>사용자 인증 정보 → OAuth 클라이언트 ID → 웹 애플리케이션</b>을 만듭니다.</li><li>승인된 JavaScript 원본에 <code>https://crack.wrtn.ai</code>를 추가하고 Client ID를 위에 붙여넣습니다.</li><li>Google 로그인 → Vertex AI 연결 테스트. 토큰은 약 1시간 뒤 만료되며 그때 재인증합니다.</li></ol><div class="st-note" style="padding:0 14px 12px">서비스 계정 JSON key, refresh token, client secret은 사용·저장하지 않습니다. 로그인은 Google Identity Services 토큰 모델(브라우저 전용 앱용 공식 흐름)을 사용합니다.</div></details>`;
    }

    settingsHtml() {
      const s = this.getSettings();
      const world = this.engine.world;
      const presets = [...MODEL_PRESETS.map((preset) => `<option value="${preset.id}" ${s.modelPreset === preset.id ? 'selected' : ''}>${preset.label} — ${preset.id}</option>`), `<option value="custom" ${s.modelPreset === 'custom' ? 'selected' : ''}>Custom model ID…</option>`].join('');
      const otherProvider = s.provider === 'vertex' ? 'developer' : 'vertex';
      const overrides = Object.keys(this.prompts.get().overrides).length;
      return `<div class="st-title">Settings</div>
<div class="st-section">AI Provider</div><div class="st-card"><label class="st-field"><span>Provider</span><select data-setting="provider"><option value="developer" ${s.provider === 'developer' ? 'selected' : ''}>Gemini Developer API</option><option value="vertex" ${s.provider === 'vertex' ? 'selected' : ''}>Vertex AI (Google Cloud)</option></select></label><label class="st-field"><span>Model preset</span><select data-setting="modelPreset">${presets}</select></label>${s.modelPreset === 'custom' ? `<label class="st-field"><span>Custom model ID</span><input data-setting="customModelId" value="${this.esc(s.customModelId)}" placeholder="예: gemini-3.7-flash" autocomplete="off"></label>` : ''}<div class="st-status"><span class="st-dot ${this.engine.gemini.providerReady() ? 'ok' : 'bad'}"></span>사용 중: <b>${s.provider === 'vertex' ? 'Vertex AI' : 'Gemini Developer API'}</b> · <code class="st-code">${this.esc(resolveModelId(s))}</code></div></div>
<div class="st-section">${s.provider === 'vertex' ? 'Vertex AI' : 'Gemini Developer API'} (사용 중)</div>${s.provider === 'vertex' ? this.vertexPanelHtml(s) : this.developerPanelHtml(s)}
<div class="st-section">다른 provider</div><details class="st-details"><summary>${otherProvider === 'vertex' ? 'Vertex AI 설정 · 연결 테스트' : 'Gemini Developer API 설정 · 연결 테스트'} ${icon('chevronDown', 18)}</summary><div style="padding:10px 0 12px;background:#f2f2f7">${otherProvider === 'vertex' ? this.vertexPanelHtml(s) : this.developerPanelHtml(s)}</div></details>
<div class="st-section">Prompt Editor</div><div class="st-card"><button class="st-btn" data-action="open-prompt-editor">팬덤 생성 프롬프트 편집<span class="st-badge ${overrides ? 'on' : ''}">${overrides ? `${overrides}개 수정됨` : '기본값'}</span></button></div>
<div class="st-section">Update</div><div class="st-card"><label class="st-field"><span>Turns per update</span><input type="number" min="1" max="100" data-setting="turnsPerUpdate" value="${s.turnsPerUpdate}"></label><label class="st-field"><span>Fandom activity</span><select data-setting="activity">${['Quiet', 'Normal', 'Active', 'Chaos'].map((value) => `<option ${s.activity === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="st-inline"><span>Automatic fandom updates</span><input type="checkbox" data-setting="autoUpdate" ${s.autoUpdate ? 'checked' : ''}></label><button class="st-btn" data-action="update-now">처리 대기 turns 지금 갱신${icon('chevronRight', 18)}</button></div>
<div class="st-section">Fanwork</div><div class="st-card"><label class="st-field"><span>Language</span><input data-setting="fanworkLanguage" value="${this.esc(s.fanworkLanguage)}"></label><label class="st-field"><span>Target length (characters) · 8,000 초과 시 개요 → 3섹션 → continuity check</span><input type="number" min="500" max="30000" data-setting="fanworkTargetLength" value="${s.fanworkTargetLength}"></label><label class="st-inline"><span>Streaming</span><input type="checkbox" data-setting="streaming" ${s.streaming ? 'checked' : ''}></label><label class="st-field"><span>UI scale</span><input type="number" min="0.75" max="1.25" step="0.05" data-setting="uiScale" value="${s.uiScale}"></label></div>
<div class="st-section">World data</div><div class="st-card"><button class="st-btn" data-action="sync-now">지금 API 동기화${icon('chevronRight', 18)}</button><button class="st-btn" data-action="import-history">현재 RP를 원작으로 가져오기${icon('chevronRight', 18)}</button><button class="st-btn" data-action="rebuild-canon">Canon rebuild (팬덤 보존)${icon('chevronRight', 18)}</button><button class="st-btn" data-action="export-world">현재 world 내보내기${icon('chevronRight', 18)}</button><button class="st-btn" data-action="export-all">모든 worlds 내보내기${icon('chevronRight', 18)}</button><button class="st-btn" data-action="import-data">데이터 가져오기${icon('chevronRight', 18)}</button><input type="file" accept="application/json" data-import-file hidden><button class="st-btn danger" data-action="reset-world">현재 Fanverse 전체 초기화</button></div>
<div class="st-note">world: ${this.esc(world.id)}<br>schema ${DB_VERSION} · app ${APP_VERSION} · sync ${this.esc(world.sync.status)}${world.sync.error ? ` · ${this.esc(world.sync.error)}` : ''}</div>`;
    }

    // ---------- prompt editor ----------

    promptState(id) {
      const store = this.prompts.get();
      const entry = store.overrides[id];
      const resolved = resolvePromptTemplate(id, store.overrides);
      return {
        overridden: Boolean(entry),
        fallback: resolved.source === 'fallback',
        error: resolved.error,
        defaultChanged: Boolean(entry && entry.defaultHash && entry.defaultHash !== Utils.hash(DEFAULT_PROMPT_TEMPLATES[id])),
        template: entry ? entry.template : DEFAULT_PROMPT_TEMPLATES[id],
        updatedAt: entry?.updatedAt,
      };
    }

    promptListHtml() {
      const groups = PROMPT_GROUPS.map((group) => {
        const items = Object.entries(PROMPT_DEFINITIONS).filter(([, def]) => def.group === group.id).map(([id, def]) => {
          const state = this.promptState(id);
          const badge = state.fallback ? '<span class="st-badge warn">오류 · 기본값 사용</span>' : state.defaultChanged ? '<span class="st-badge warn">수정됨 · 기본값 갱신</span>' : state.overridden ? '<span class="st-badge on">수정됨</span>' : '<span class="st-badge">기본값</span>';
          return `<button class="pe-item" data-act="open-prompt" data-prompt-id="${id}"><b>${this.esc(def.label)}</b>${badge}<small>${this.esc(def.description)}</small></button>`;
        }).join('');
        return `<div class="st-section pe-group-head">${this.esc(group.label)}<small>${this.esc(group.hint)}</small></div><div class="st-card">${items}</div>`;
      }).join('');
      return `<div class="pe-head"><h2>Prompt Editor</h2><p>팬덤 생성에 쓰이는 프롬프트를 직접 보고 고칩니다. 수정본은 GM storage에 override로 저장되고, 코드 기본값은 그대로 남아 언제든 복원할 수 있습니다. <code class="st-code">{{PLACEHOLDER}}</code> 자리에 호출 시점의 실제 데이터가 들어갑니다.</p></div>${groups}<div class="st-section">전체 prompts</div><div class="st-card"><button class="st-btn" data-action="export-prompts">전체 prompts JSON export${icon('chevronRight', 18)}</button><button class="st-btn" data-action="import-prompts">전체 prompts JSON import${icon('chevronRight', 18)}</button><button class="st-btn danger" data-action="reset-all-prompts">모든 프롬프트 기본값으로 복원</button></div><input type="file" accept="application/json" data-prompts-import-file hidden>`;
    }

    promptEditorHtml() {
      const promptId = PROMPT_DEFINITIONS[this.route?.promptId] ? this.route.promptId : 'redditGenerator';
      const def = PROMPT_DEFINITIONS[promptId];
      const state = this.promptState(promptId);
      const text = this.promptDraft?.id === promptId ? this.promptDraft.text : state.template;
      const chips = [...def.required.map((name) => [name, true]), ...def.optional.map((name) => [name, false])];
      const status = state.fallback ? `저장된 override가 유효하지 않아 <b>코드 기본값</b>으로 호출 중입니다: ${this.esc(state.error)}` : state.overridden ? `GM storage override 적용 중 · ${this.esc(new Date(state.updatedAt).toLocaleString('ko-KR'))} 저장${state.defaultChanged ? '<br><b>이 수정본을 만든 뒤 코드 기본값이 바뀌었습니다.</b> "기본값 불러오기"로 새 기본값을 확인하세요.' : ''}` : '코드 기본 프롬프트 적용 중';
      return `<div class="pe-head"><h2>${this.esc(def.label)}</h2><p>${this.esc(def.description)}<br>출력: ${this.esc(def.output)}${def.output.startsWith('JSON') ? ' — 응답 구조는 코드의 JSON schema가 강제하므로 프롬프트에서 형식을 바꿀 필요는 없습니다.' : ''}</p></div><div class="pe-meta">${status}</div><div class="st-section">Placeholders · 눌러서 커서 위치에 삽입</div><div class="pe-chips">${chips.map(([name, required]) => `<button class="pe-chip ${required ? 'req' : ''}" data-act="insert-placeholder" data-name="${name}" title="${this.esc(PLACEHOLDER_DOCS[name])}">{{${name}}}${required ? ' *' : ''}</button>`).join('')}</div><div class="pe-doc">${chips.map(([name, required]) => `<div><code>{{${name}}}</code>${required ? ' (필수)' : ' (선택)'} — ${this.esc(PLACEHOLDER_DOCS[name])}</div>`).join('')}</div><textarea class="pe-textarea" data-prompt-text data-prompt-id="${promptId}" spellcheck="false">${this.esc(text)}</textarea><div class="pe-validation" data-prompt-validation></div><div class="pe-actions"><button class="primary" data-action="save-prompt" data-prompt-id="${promptId}">저장</button><button data-action="reset-prompt" data-prompt-id="${promptId}">기본값으로 복원</button><button data-action="load-default-prompt" data-prompt-id="${promptId}">기본값 불러오기 (편집기)</button><button data-action="copy-prompt">복사</button><button data-action="export-prompt" data-prompt-id="${promptId}">이 prompt export</button><button data-action="import-prompt">이 prompt import</button></div><div class="pe-actions" style="grid-template-columns:1fr"><button data-act="prompt-list">← 프롬프트 목록</button></div><input type="file" accept="application/json" data-prompt-import-file hidden><div style="height:24px"></div>`;
    }

    updatePromptValidation() {
      const textarea = this.root.querySelector('[data-prompt-text]');
      const target = this.root.querySelector('[data-prompt-validation]');
      if (!textarea || !target) return;
      const { errors, warnings } = inspectPromptTemplate(textarea.dataset.promptId, textarea.value);
      const dirty = this.promptDraft?.dirty;
      target.innerHTML = `${errors.length ? errors.map((error) => `<div class="err">✕ ${this.esc(error)}</div>`).join('') : `<div class="ok">✓ placeholder 검증 통과${dirty ? ' · 저장되지 않은 변경 있음' : ''}</div>`}${warnings.map((warning) => `<div class="warn">! ${this.esc(warning)}</div>`).join('')}`;
      const save = this.root.querySelector('[data-action="save-prompt"]');
      if (save) save.disabled = errors.length > 0;
    }

    async savePromptOverride(promptId, template) {
      validatePromptTemplate(promptId, template);
      const store = this.prompts.get();
      const overrides = { ...store.overrides };
      if (template === DEFAULT_PROMPT_TEMPLATES[promptId]) delete overrides[promptId];
      else overrides[promptId] = { template, updatedAt: new Date().toISOString(), defaultHash: Utils.hash(DEFAULT_PROMPT_TEMPLATES[promptId]) };
      await this.prompts.save({ schemaVersion: 1, overrides });
      PromptLibrary.warned.delete(promptId);
    }

    // ---------- events ----------

    async withButton(button, busyText, task) {
      const label = button?.innerHTML;
      if (button) { button.disabled = true; if (busyText) button.textContent = busyText; }
      try { return await task(); } finally { if (button?.isConnected) { button.disabled = false; button.innerHTML = label; } }
    }

    async handleClick(event) {
      const target = event.target.closest('[data-act],[data-action],[data-go]');
      if (!target || !this.root.querySelector('main').contains(target)) return;
      if (target.dataset.go) { if (target.dataset.go === this.view && !this.route) return; this.go(target.dataset.go); return; }
      const act = target.dataset.act;
      if (act) { event.preventDefault(); await this.handleAct(act, target); return; }
      await this.handleAction(target.dataset.action, target);
    }

    async handleAct(act, target) {
      const route = this.route || {};
      const id = target.dataset.id;
      try {
        switch (act) {
          // pixiv
          case 'px-home': return this.go('pixiv');
          case 'px-search-toggle': return this.replace({ ...route, searchOpen: !route.searchOpen }, { keepScroll: true });
          case 'px-search-cancel': return route.type === 'tag' ? this.back() : this.replace({ ...route, searchOpen: false }, { keepScroll: true });
          case 'px-tag': return this.push({ type: 'tag', tag: target.dataset.tag }, 'pixiv');
          case 'px-work': return target.dataset.replace ? this.replace({ type: 'pixiv-work', id }) : this.push({ type: 'pixiv-work', id });
          case 'px-author': return this.push({ type: 'author', id });
          case 'px-series': return this.push({ type: 'series', title: target.dataset.title });
          case 'px-sort': return this.replace({ ...route, sort: target.dataset.sort }, { keepScroll: true });
          case 'px-caption': { const item = target.closest('.px-item'); item?.classList.toggle('open'); target.textContent = item?.classList.contains('open') ? '접기' : '더보기'; return; }
          case 'px-caption-detail': target.classList.toggle('open'); return;
          case 'px-bookmark': await this.engine.togglePixivBookmark(id); return this.render({ keepScroll: true });
          case 'px-like': await this.engine.togglePixivLike(id); return this.render({ keepScroll: true });
          case 'px-follow': await this.engine.togglePixivFollow(id); return this.render({ keepScroll: true });
          case 'px-fav-tag': {
            const world = this.engine.world; const favs = new Set(world.pixivFavTags || []);
            if (favs.has(target.dataset.tag)) favs.delete(target.dataset.tag); else favs.add(target.dataset.tag);
            world.pixivFavTags = [...favs]; await this.engine.saveWorld(); return this.render({ keepScroll: true });
          }
          case 'px-share': case 'px-share-author': {
            const work = id ? await this.db.get(STORES.pixivWorks, id) : null;
            GM_setClipboard(work ? `${work.title}\n${(work.tags || []).map((tag) => `#${tag}`).join(' ')}\n${work.caption || ''}` : document.title, 'text');
            this.notify('success', '가상 작품 정보를 클립보드에 복사했습니다.'); return;
          }
          case 'px-reader-panel': return this.replace({ ...route, readerPanel: !route.readerPanel }, { keepScroll: true });
          case 'px-reader-set': {
            const settings = this.getSettings();
            settings.pixivReader = { ...settings.pixivReader, [target.dataset.key]: target.dataset.value };
            await this.saveSettings(settings); return this.render({ keepScroll: true });
          }
          case 'px-reader-top': this.root.querySelector('.px-readerbar')?.scrollIntoView({ block: 'start' }); return;
          case 'px-copy-text': {
            const cached = await this.db.get(STORES.fanworks, id);
            if (!cached) { this.notify('error', '아직 본문이 생성되지 않았습니다.'); return; }
            GM_setClipboard(cached.text, 'text'); this.notify('success', '본문을 복사했습니다.'); return;
          }
          case 'px-generate': {
            const work = await this.db.get(STORES.pixivWorks, id);
            if (!work) return;
            const stream = this.root.querySelector('#fanwork-stream');
            await this.withButton(target, '본문 생성 중…', async () => {
              await this.engine.generateFanwork(work, (text) => { if (stream?.isConnected) stream.innerHTML = this.pxReaderBody(text, { cursor: true }).html; });
            });
            this.notify('success', '전문을 생성하고 저장했습니다.');
            return this.render({ keepScroll: true });
          }
          // reddit
          case 'rd-home': return this.go('reddit');
          case 'rd-back': return this.back();
          case 'rd-post': return this.push({ type: 'reddit-post', id });
          case 'rd-thread': return this.push({ type: 'reddit-post', id: target.dataset.post, focus: id });
          case 'rd-unfocus': return this.replace({ ...route, focus: null });
          case 'rd-tab': return this.replace({ ...route, tab: target.dataset.tab, sortMenu: false }, { keepScroll: true });
          case 'rd-sort-menu': return this.replace({ ...route, sortMenu: !route.sortMenu }, { keepScroll: true });
          case 'rd-sort': return this.replace({ ...route, sort: target.dataset.sort, sortMenu: false }, { keepScroll: true });
          case 'rd-csort-menu': return this.replace({ ...route, csortMenu: !route.csortMenu }, { keepScroll: true });
          case 'rd-csort': return this.replace({ ...route, csort: target.dataset.sort, csortMenu: false }, { keepScroll: true });
          case 'rd-join': { const joined = await this.engine.toggleRedditJoin(); this.notify('success', joined ? 'r/Fanverse에 가입했습니다.' : '가입을 취소했습니다.'); return this.render({ keepScroll: true }); }
          case 'rd-vote': await this.engine.voteRedditPost(id, Number(target.dataset.value)); return this.render({ keepScroll: true });
          case 'rd-cvote': await this.engine.voteRedditComment(target.dataset.post, id, Number(target.dataset.value)); return this.render({ keepScroll: true });
          case 'rd-spoiler': this.rdRevealed.add(id); return this.render({ keepScroll: true });
          case 'rd-collapse': {
            const node = this.root.querySelector(`.rd-c[data-comment-id="${CSS.escape(id)}"]`);
            if (this.rdCollapsed.has(id)) this.rdCollapsed.delete(id); else this.rdCollapsed.add(id);
            node?.classList.toggle('collapsed', this.rdCollapsed.has(id));
            return;
          }
          case 'rd-share': {
            const post = await this.db.get(STORES.redditPosts, id);
            if (post) GM_setClipboard(`${post.title}\n\n${post.body}`, 'text');
            this.notify('success', '게시물 내용을 클립보드에 복사했습니다.'); return;
          }
          case 'rd-compose': this.notify('sync', 'r/Fanverse의 글과 댓글은 영구 페르소나들이 씁니다. 더 많은 반응은 "댓글 더 보기"로 불러오세요.'); return;
          case 'rd-more': {
            const post = await this.db.get(STORES.redditPosts, id);
            if (!post) return;
            await this.withButton(target, '댓글 생성 중…', () => this.engine.loadMoreRedditComments(post));
            this.notify('success', '새 댓글을 저장했습니다.');
            return this.render({ keepScroll: true });
          }
          case 'rd-noop': return;
          // prompt editor
          case 'prompt-list': return this.back();
          case 'open-prompt': return this.push({ type: 'prompt-editor', promptId: target.dataset.promptId }, 'settings');
          case 'insert-placeholder': {
            const textarea = this.root.querySelector('[data-prompt-text]');
            if (!textarea) return;
            const start = textarea.selectionStart ?? textarea.value.length;
            textarea.setRangeText(`{{${target.dataset.name}}}`, start, textarea.selectionEnd ?? start, 'end');
            textarea.focus();
            this.promptDraft = { id: textarea.dataset.promptId, text: textarea.value, dirty: true };
            this.updatePromptValidation();
            return;
          }
          default: return;
        }
      } catch (error) {
        this.notify('error', error.message);
      }
    }

    async handleAction(action, target) {
      if (!action) return;
      try {
        if (action === 'open-prompt-editor') { this.push({ type: 'prompt-list' }, 'settings'); return; }
        if (action === 'save-prompt') {
          const promptId = target.dataset.promptId;
          await this.savePromptOverride(promptId, this.root.querySelector('[data-prompt-text]').value);
          this.promptDraft = null;
          this.notify('success', 'Prompt를 저장했습니다. 다음 호출부터 적용됩니다.');
          await this.render({ keepScroll: true });
          return;
        }
        if (action === 'reset-prompt') {
          const promptId = target.dataset.promptId;
          if (this.promptState(promptId).overridden && !confirm(`${PROMPT_DEFINITIONS[promptId].label} 수정본을 삭제하고 코드 기본값으로 되돌릴까요?`)) return;
          const store = this.prompts.get(); const overrides = { ...store.overrides };
          delete overrides[promptId];
          await this.prompts.save({ schemaVersion: 1, overrides });
          this.promptDraft = null;
          this.notify('success', '코드 기본 프롬프트로 복원했습니다.'); await this.render({ keepScroll: true });
          return;
        }
        if (action === 'load-default-prompt') {
          const textarea = this.root.querySelector('[data-prompt-text]');
          textarea.value = DEFAULT_PROMPT_TEMPLATES[target.dataset.promptId];
          this.promptDraft = { id: target.dataset.promptId, text: textarea.value, dirty: true };
          this.updatePromptValidation();
          this.notify('sync', '편집기에 코드 기본값을 불러왔습니다. 저장해야 적용됩니다.');
          return;
        }
        if (action === 'copy-prompt') { GM_setClipboard(this.root.querySelector('[data-prompt-text]').value, 'text'); this.notify('success', 'Prompt를 복사했습니다.'); return; }
        if (action === 'export-prompt') {
          const promptId = target.dataset.promptId;
          Utils.download(`rp-fanverse-prompt-${promptId}.json`, JSON.stringify({ schemaVersion: 1, appVersion: APP_VERSION, promptId, template: this.root.querySelector('[data-prompt-text]').value }, null, 2));
          return;
        }
        if (action === 'export-prompts') {
          const store = this.prompts.get();
          const prompts = Object.fromEntries(Object.keys(PROMPT_DEFINITIONS).map((id) => [id, this.promptState(id).template]));
          Utils.download('rp-fanverse-prompts.json', JSON.stringify({ schemaVersion: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(), overriddenIds: Object.keys(store.overrides), prompts }, null, 2));
          return;
        }
        if (action === 'import-prompt') { this.root.querySelector('[data-prompt-import-file]').click(); return; }
        if (action === 'import-prompts') { this.root.querySelector('[data-prompts-import-file]').click(); return; }
        if (action === 'reset-all-prompts') {
          if (!confirm('모든 프롬프트 수정본을 삭제하고 코드 기본값으로 되돌릴까요?')) return;
          await this.prompts.save({ schemaVersion: 1, overrides: {} });
          PromptLibrary.warned.clear();
          this.notify('success', '모든 프롬프트를 기본값으로 복원했습니다.'); await this.render({ keepScroll: true });
          return;
        }
        if (action === 'vertex-auth') {
          this.notify('sync', 'Google 로그인 창을 여는 중…');
          await this.engine.gemini.authorizeVertex();
          this.engine.warnedProviderUnready = false;
          this.notify('success', 'Vertex AI access token을 받았습니다.'); await this.render({ keepScroll: true });
          this.engine.maybeUpdate().catch((error) => this.notify('error', error.message));
          return;
        }
        if (action === 'vertex-manual-token') {
          const input = target.closest('.st-card')?.querySelector('[data-vertex-manual-token]');
          await this.withButton(target, '확인 중…', () => this.engine.gemini.useManualVertexToken(input?.value));
          if (input) input.value = '';
          this.notify('success', '수동 access token을 확인하고 적용했습니다.'); await this.render({ keepScroll: true });
          return;
        }
        if (action === 'vertex-revoke') {
          await this.engine.gemini.revokeVertex();
          this.notify('success', 'Vertex access token을 폐기했습니다.'); await this.render({ keepScroll: true });
          return;
        }
        if (action === 'test-developer' || action === 'test-vertex') {
          const provider = action === 'test-vertex' ? 'vertex' : 'developer';
          const label = provider === 'vertex' ? 'Vertex AI' : 'Gemini Developer API';
          this.notify('sync', `${label} 연결 테스트 중… (${resolveModelId(this.getSettings())})`);
          const reply = await this.withButton(target, '테스트 중…', () => this.engine.gemini.testConnection(provider));
          this.notify('success', `${label} 연결 성공 · 모델 응답: ${reply}`);
          return;
        }
        if (action === 'sync-now') { await this.engine.sync(); await this.render({ keepScroll: true }); return; }
        if (action === 'update-now') {
          if (this.engine.world.needsCanonRebuild) throw new Error('활성 원작 분기가 변경되었습니다. 먼저 Canon rebuild를 실행하세요.');
          const turns = await this.engine.allActiveTurns();
          const processed = new Set(this.engine.world.processedTurnIds);
          const pending = turns.filter((turn) => !processed.has(turn.id));
          if (!pending.length) this.notify('success', '처리 대기 중인 turn이 없습니다.');
          else await this.engine.runFandomUpdate(pending.slice(0, this.getSettings().turnsPerUpdate));
          await this.render({ keepScroll: true });
          return;
        }
        if (action === 'import-history') { await this.engine.importHistory((message) => this.notify('sync', message)); await this.render({ keepScroll: true }); return; }
        if (action === 'rebuild-canon') { await this.engine.rebuildCanon((message) => this.notify('sync', message)); await this.render({ keepScroll: true }); return; }
        if (action === 'export-world') { const dump = await this.db.dump(this.engine.world.id); Utils.download(`rp-fanverse-${this.engine.world.episodeId}.json`, JSON.stringify(dump, null, 2)); return; }
        if (action === 'export-all') { const dump = await this.db.dump(); Utils.download('rp-fanverse-all-worlds.json', JSON.stringify(dump, null, 2)); return; }
        if (action === 'import-data') { this.root.querySelector('[data-import-file]').click(); return; }
        if (action === 'reset-world') {
          if (!confirm('현재 RP world의 Canon, Fandom, Pixiv, Reddit 데이터를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
          await this.db.deleteWorld(this.engine.world.id);
          await this.engine.attach(this.engine.worldInfo);
          this.notify('success', '현재 Fanverse world를 초기화했습니다.'); await this.render();
        }
      } catch (error) {
        this.notify('error', error.message);
      }
    }

    handleInput(event) {
      const input = event.target;
      if (input.matches('[data-prompt-text]')) {
        this.promptDraft = { id: input.dataset.promptId, text: input.value, dirty: true };
        clearTimeout(this.validateTimer);
        this.validateTimer = setTimeout(() => this.updatePromptValidation(), 120);
        return;
      }
      if (input.matches('[data-rd-search]')) {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(async () => {
          const value = input.value;
          const caret = input.selectionStart;
          if (this.route?.type === 'reddit-post') { this.push({ q: value }, 'reddit'); } else { this.route = { ...(this.route || {}), q: value, tab: 'feed' }; await this.render({ keepScroll: true }); }
          const fresh = this.root.querySelector('[data-rd-search]');
          if (fresh) { fresh.focus(); fresh.setSelectionRange(caret, caret); }
        }, 250);
      }
    }

    handleKeydown(event) {
      if (event.key === 'Enter' && event.target.matches('[data-px-search]')) {
        const value = event.target.value.trim();
        if (value) this.push({ type: 'tag', tag: value }, 'pixiv');
      }
      if (event.key === 'Tab' && event.target.matches('[data-prompt-text]')) {
        event.preventDefault();
        event.target.setRangeText('  ', event.target.selectionStart, event.target.selectionEnd, 'end');
        this.handleInput(event);
      }
    }

    async handleChange(event) {
      const input = event.target;
      try {
        if (input.dataset.setting) {
          const settings = this.getSettings();
          let value = input.type === 'checkbox' ? input.checked : input.value;
          if (input.type === 'number') value = Number(value);
          settings[input.dataset.setting] = value;
          if (input.dataset.setting === 'vertexOAuthClientId') await this.engine.gemini.clearVertexToken();
          await this.saveSettings(settings);
          if (input.dataset.setting === 'uiScale') this.host.style.setProperty('--ui-scale', String(this.getSettings().uiScale));
          this.notify('success', '설정을 저장했습니다.');
          if (['provider', 'modelPreset', 'customModelId', 'vertexApiVersion', 'vertexLocation', 'vertexProjectId', 'apiKey', 'vertexOAuthClientId'].includes(input.dataset.setting)) await this.render({ keepScroll: true });
          return;
        }
        if (input.matches('[data-import-file]') && input.files?.[0]) {
          const payload = JSON.parse(await input.files[0].text());
          await this.db.restore(payload); await this.engine.attach(this.engine.worldInfo);
          this.notify('success', 'Fanverse 데이터를 가져왔습니다.'); await this.render();
          return;
        }
        if (input.matches('[data-prompt-import-file]') && input.files?.[0]) {
          const payload = JSON.parse(await input.files[0].text());
          if (!PROMPT_DEFINITIONS[payload.promptId] || typeof payload.template !== 'string') throw new Error('개별 prompt JSON 형식이 올바르지 않습니다. (promptId, template 필요)');
          await this.savePromptOverride(payload.promptId, payload.template);
          this.promptDraft = null;
          this.route = { type: 'prompt-editor', promptId: payload.promptId };
          this.notify('success', `${PROMPT_DEFINITIONS[payload.promptId].label} prompt를 가져왔습니다.`); await this.render();
          return;
        }
        if (input.matches('[data-prompts-import-file]') && input.files?.[0]) {
          const payload = JSON.parse(await input.files[0].text());
          // Accepts this script's export ({prompts:{id:template}}) and the raw storage layout ({overrides:{id:{template}}}).
          const source = payload?.prompts && typeof payload.prompts === 'object' ? payload.prompts : payload?.overrides && typeof payload.overrides === 'object' ? Object.fromEntries(Object.entries(payload.overrides).map(([id, entry]) => [id, typeof entry === 'string' ? entry : entry?.template])) : null;
          if (!source) throw new Error('전체 prompts JSON 형식이 올바르지 않습니다.');
          const unknown = Object.keys(source).filter((id) => !PROMPT_DEFINITIONS[id]);
          if (unknown.length) throw new Error(`알 수 없는 prompt ID: ${unknown.join(', ')}`);
          const problems = [];
          for (const [id, template] of Object.entries(source)) {
            if (typeof template !== 'string') { problems.push(`${id}: template이 문자열이 아닙니다`); continue; }
            const { errors } = inspectPromptTemplate(id, template);
            if (errors.length) problems.push(`${PROMPT_DEFINITIONS[id].label}: ${errors.join(' / ')}`);
          }
          if (problems.length) throw new Error(`가져오기를 취소했습니다 (아무것도 변경되지 않음)\n${problems.join('\n')}`);
          const overrides = { ...this.prompts.get().overrides };
          for (const [id, template] of Object.entries(source)) {
            if (template === DEFAULT_PROMPT_TEMPLATES[id]) delete overrides[id];
            else overrides[id] = { template, updatedAt: new Date().toISOString(), defaultHash: Utils.hash(DEFAULT_PROMPT_TEMPLATES[id]) };
          }
          await this.prompts.save({ schemaVersion: 1, overrides });
          PromptLibrary.warned.clear();
          this.notify('success', `${Object.keys(source).length}개 prompt를 가져왔습니다.`); await this.render({ keepScroll: true });
        }
      } catch (error) {
        this.notify('error', error.message);
      } finally {
        if (input.type === 'file') input.value = '';
      }
    }
  }

  class App {
    constructor() {
      this.db = new Database(); this.api = new CrackApiAdapter(); this.dom = new CrackDomFallbackAdapter();
      this.settings = normalizeSettings(); this.gemini = new GeminiClient(() => this.settings);
      this.prompts = normalizePromptStore(null);
      PromptLibrary.configure(() => this.prompts.overrides, (id, error) => this.ui?.notify('error', `${PROMPT_DEFINITIONS[id].label} 수정본이 유효하지 않아 기본 프롬프트로 호출했습니다: ${error}`));
      this.engine = new FanverseEngine(this.db, this.api, this.dom, this.gemini, () => this.settings, (kind, message) => this.ui?.notify(kind, message));
      this.ui = new PhoneUI(this.engine, this.db, () => this.settings, (settings) => this.persistSettings(settings), {
        get: () => this.prompts,
        save: (store) => this.persistPrompts(store),
      });
      this.lastUrl = '';
    }

    async persistSettings(settings) {
      const next = { ...settings };
      delete next.promptOverrides;
      this.settings = normalizeSettings(next);
      await GMStore.set(SETTINGS_KEY, this.settings);
    }

    async persistPrompts(store) {
      this.prompts = normalizePromptStore(store);
      await GMStore.set(PROMPTS_KEY, this.prompts);
    }

    async init() {
      const rawSettings = await GMStore.get(SETTINGS_KEY, {});
      const rawPrompts = await GMStore.get(PROMPTS_KEY, null);
      if (!rawPrompts && rawSettings?.promptOverrides && Object.keys(rawSettings.promptOverrides).length) {
        // 0.11.0 → 0.12.0: overrides moved out of settings into their own key (with metadata).
        await this.persistPrompts({ overrides: rawSettings.promptOverrides });
      } else {
        this.prompts = normalizePromptStore(rawPrompts);
      }
      await this.persistSettings(rawSettings || {});
      await this.gemini.vertex.restore();
      await this.db.open(); this.ui.mount();
      await this.routeChanged();
      setInterval(() => this.routeChanged(), 2000);
      setInterval(() => { if (this.engine.worldInfo && !document.hidden) this.engine.sync().catch((error) => this.ui.notify('error', error.message)); }, Math.max(15, this.settings.pollSeconds) * 1000);
    }

    async routeChanged() {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      const info = parseWorldFromUrl(location.href);
      if (!info) { this.ui.hide(); this.ui.host.hidden = true; this.ui.host.style.display = 'none'; return; }
      this.ui.host.hidden = false; this.ui.host.style.display = '';
      await this.engine.attach(info);
      this.ui.history = []; this.ui.route = null;
      this.ui.refreshBadges();
      await this.engine.sync().catch((error) => this.ui.notify('error', error.message));
      if (this.ui.open) await this.ui.render();
    }
  }

  const app = new App();
  app.init().catch((error) => console.error('[RP Fanverse]', error));
})();
