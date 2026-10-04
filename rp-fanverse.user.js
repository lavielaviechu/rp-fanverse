// ==UserScript==
// @name         RP Fanverse
// @namespace    https://crack.wrtn.ai/
// @version      0.12.8
// @description  Treats a Crack RP episode as canon and grows a persistent virtual Pixiv/Reddit fandom around it.
// @author       Personal userscript
// @match        https://crack.wrtn.ai/stories/*/episodes/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      crack-api.wrtn.ai
// @connect      generativelanguage.googleapis.com
// @connect      aiplatform.googleapis.com
// @connect      oauth2.googleapis.com
// @connect      firebasevertexai.googleapis.com
// @connect      content-firebaseappcheck.googleapis.com
// @connect      googleapis.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const APP_VERSION = '0.12.8';
  const DB_NAME = 'rp-fanverse';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'rp-fanverse:settings:v1';
  // 0.12.0–0.12.2 per-prompt overrides. Kept as-is in GM storage (never deleted) but no longer read:
  // the internal prompts are code, and the only user-editable text is globalGeminiInstruction.
  const LEGACY_PROMPTS_KEY = 'rp-fanverse:prompt-overrides:v1';
  const VERTEX_TOKEN_KEY = 'rp-fanverse:vertex-token:v1';
  const SETTINGS_VERSION = 6;
  const WORLD_RE = /^\/stories\/([^/]+)\/episodes\/([^/?#]+)/;
  const API_BASE = 'https://crack-api.wrtn.ai/crack-gen/v3';
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

  const DEFAULT_GLOBAL_INSTRUCTION = `- 원작(RP 로그)에 없는 사실을 Canon처럼 단정하지 않는다. 팬 해석과 Canon을 구분한다.
- 캐릭터의 말투와 성격을 원작에 맞게 유지하고 OOC를 피한다.
- CP를 승패나 경쟁처럼 다루지 않는다. 1:1, 삼각, 다인 관계, 캐릭터 중심 취향을 모두 자연스러운 팬덤 취향으로 다룬다.
- Reddit은 실제 커뮤니티처럼 의견이 갈리고, 사람마다 근거와 말투가 다르게 쓴다.
- Pixiv 제목·캡션·태그는 실제 일본 팬덤에서 볼 법한 자연스러운 표현을 쓴다.`;

  // Firebase Web App config fields. Nothing project-specific is shipped: the user pastes their own
  // config in Settings and it is stored (GM storage) as settings.firebaseConfig.
  const FIREBASE_CONFIG_FIELDS = Object.freeze(['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId']);
  const FIREBASE_REQUIRED_FIELDS = Object.freeze(['apiKey', 'projectId', 'appId']);
  const EMPTY_FIREBASE_CONFIG = Object.freeze(Object.fromEntries(FIREBASE_CONFIG_FIELDS.map((key) => [key, ''])));

  const PROVIDERS = Object.freeze([
    { id: 'developer', label: 'Gemini Developer API' },
    { id: 'vertex', label: 'Vertex AI' },
    { id: 'firebase', label: 'Firebase AI' },
  ]);

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
    firebaseConfig: EMPTY_FIREBASE_CONFIG,
    firebaseLocation: 'global',
    appCheckMode: 'off',
    appCheckSiteKey: '',
    appCheckDebugToken: '',
    globalGeminiInstruction: DEFAULT_GLOBAL_INSTRUCTION,
    // 0.12.8: the fandom updates after every completed RP turn.
    turnsPerUpdate: 1,
    activity: 'Normal',
    fanworkLanguage: '日本語',
    fanworkTargetLength: 2000,
    // 'auto': each Pixiv work uses the length its metadata planned (mostly short one-shots);
    // 'custom': every work uses fanworkTargetLength, as set by the user.
    fanworkLengthMode: 'auto',
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

  function modelLabel(settings) {
    return settings.modelPreset === 'custom' ? resolveModelId(settings) : (MODEL_PRESETS.find((preset) => preset.id === settings.modelPreset)?.label || resolveModelId(settings));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  // Keeps exactly the six Firebase Web App fields as trimmed strings ('' when absent).
  function normalizeFirebaseConfig(config) {
    const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    return Object.fromEntries(FIREBASE_CONFIG_FIELDS.map((key) => [key, typeof source[key] === 'string' ? source[key].trim() : '']));
  }

  function validateFirebaseConfig(config) {
    const normalized = normalizeFirebaseConfig(config);
    const missingRequired = FIREBASE_REQUIRED_FIELDS.filter((key) => !normalized[key]);
    const missingRecommended = FIREBASE_CONFIG_FIELDS.filter((key) => !FIREBASE_REQUIRED_FIELDS.includes(key) && !normalized[key]);
    const empty = FIREBASE_CONFIG_FIELDS.every((key) => !normalized[key]);
    return { ok: missingRequired.length === 0, empty, missingRequired, missingRecommended, config: normalized };
  }

  // Accepts the JSON object, or the JavaScript snippet the Firebase console shows
  // (`const firebaseConfig = { apiKey: "…", … };` with unquoted keys). Never evaluates code.
  function parseFirebaseConfigInput(text) {
    const source = String(text || '').trim();
    if (!source) throw new Error('Firebase Web Config를 붙여넣으세요.');
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('JSON 객체({ … })를 찾을 수 없습니다.');
    const body = source.slice(start, end + 1);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      const jsonish = body
        .replace(/\/\/[^\n]*/g, '')
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/'([^'\\]*)'/g, '"$1"')
        .replace(/,\s*([}\]])/g, '$1');
      // The parser's own message quotes part of the input (which may include the key), so it is not shown.
      try { parsed = JSON.parse(jsonish); } catch (_) { throw new Error('JSON 형식이 올바르지 않습니다. 쉼표·따옴표·중괄호를 확인하세요.'); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Firebase Web Config는 객체여야 합니다.');
    return normalizeFirebaseConfig(parsed);
  }

  function normalizeSettings(saved = {}) {
    const source = saved && typeof saved === 'object' ? saved : {};
    // Unknown/legacy fields (e.g. 0.11 `promptOverrides`) are carried along untouched.
    const result = { ...DEFAULT_SETTINGS, ...source };
    result.provider = PROVIDERS.some((provider) => provider.id === result.provider) ? result.provider : 'developer';
    if (!source.modelPreset) {
      const legacyModel = String(source.model || '').trim();
      if (MODEL_PRESETS.some((preset) => preset.id === legacyModel)) result.modelPreset = legacyModel;
      else if (LEGACY_DEFAULT_MODELS.includes(legacyModel)) result.modelPreset = DEFAULT_SETTINGS.modelPreset;
      else { result.modelPreset = 'custom'; result.customModelId = legacyModel; }
    }
    if (!['custom', ...MODEL_PRESETS.map((preset) => preset.id)].includes(result.modelPreset)) result.modelPreset = DEFAULT_SETTINGS.modelPreset;
    result.customModelId = String(result.customModelId || '').trim();
    result.apiKey = String(result.apiKey || '').trim();
    result.vertexProjectId = String(result.vertexProjectId || '').trim();
    result.vertexLocation = String(result.vertexLocation || 'global').trim().toLowerCase() || 'global';
    result.vertexApiVersion = ['v1', 'v1beta1'].includes(result.vertexApiVersion) ? result.vertexApiVersion : 'v1';
    result.vertexOAuthClientId = String(result.vertexOAuthClientId || '').trim();
    // 0.12.3 stored a user-entered Firebase config as `firebaseConfigOverride`; adopt it once.
    if (source.firebaseConfigOverride && !source.firebaseConfig) result.firebaseConfig = source.firebaseConfigOverride;
    delete result.firebaseConfigOverride;
    result.firebaseConfig = normalizeFirebaseConfig(result.firebaseConfig);
    result.firebaseLocation = String(result.firebaseLocation || 'global').trim().toLowerCase() || 'global';
    result.appCheckMode = ['off', 'recaptcha-enterprise', 'debug'].includes(result.appCheckMode) ? result.appCheckMode : 'off';
    result.appCheckSiteKey = String(result.appCheckSiteKey || '').trim();
    result.appCheckDebugToken = String(result.appCheckDebugToken || '').trim();
    // An empty string is a deliberate "no common instruction"; only a missing value gets the default.
    result.globalGeminiInstruction = typeof source.globalGeminiInstruction === 'string' ? source.globalGeminiInstruction : DEFAULT_GLOBAL_INSTRUCTION;
    // 0.12.8: per-turn updates. Settings saved before version 6 that still hold the old default (5)
    // follow the new default; any other saved value was chosen by the user and is kept.
    if ((Number(source.settingsVersion) || 0) < 6 && Number(source.turnsPerUpdate) === 5) result.turnsPerUpdate = DEFAULT_SETTINGS.turnsPerUpdate;
    result.turnsPerUpdate = Math.round(clampNumber(result.turnsPerUpdate, 1, 100, DEFAULT_SETTINGS.turnsPerUpdate));
    // 0.12.7: fanworks are short by default. A saved length equal to the old default (4000) was never
    // chosen by the user, so it follows the new default; any other saved length is kept as the user's choice.
    if (!['auto', 'custom'].includes(source.fanworkLengthMode)) {
      const saved = Number(source.fanworkTargetLength);
      result.fanworkLengthMode = source.fanworkTargetLength != null && Number.isFinite(saved) && saved !== 4000 ? 'custom' : 'auto';
      if (result.fanworkLengthMode === 'auto') result.fanworkTargetLength = DEFAULT_SETTINGS.fanworkTargetLength;
    }
    result.fanworkTargetLength = Math.round(clampNumber(result.fanworkTargetLength, 500, 30000, DEFAULT_SETTINGS.fanworkTargetLength));
    result.uiScale = clampNumber(result.uiScale, 0.75, 1.25, 1);
    const reader = result.pixivReader && typeof result.pixivReader === 'object' ? result.pixivReader : {};
    result.pixivReader = {
      size: ['s', 'm', 'l'].includes(reader.size) ? reader.size : 'm',
      font: ['gothic', 'mincho'].includes(reader.font) ? reader.font : 'gothic',
      theme: ['light', 'sepia', 'dark'].includes(reader.theme) ? reader.theme : 'light',
    };
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

  // The user's common Gemini instruction travels as systemInstruction, separate from the internal
  // task prompt (user content) and the runtime data inside it. The preamble keeps task rules (JSON
  // shape, canon/fan-interpretation split, source IDs) authoritative over style preferences.
  function buildSystemInstruction(instruction) {
    const text = String(instruction || '').trim();
    if (!text) return null;
    return `다음은 사용자가 지정한 RP Fanverse 공통 작성 지침이다. 모든 작업에서 취향·문체·관점 지침으로 반영하라. 단, 각 요청에 포함된 작업 지시(출력 JSON 구조, Canon과 팬 해석의 구분, 근거 ID 규칙)와 충돌하면 작업 지시를 우선한다.\n\n[Gemini 공통 지침]\n${text}`;
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

  // Internal task prompts. They are code, not user settings: `required` placeholders are checked by
  // the unit tests so a template edit cannot silently drop the data a call depends on.
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

  // Shared by every prompt whose output fans see. Internal IDs stay in the JSON fields that ask for
  // them; episodeLabel/sceneLabel/episodePart/fanReferences/fandomTimeline in the input are display
  // aliases computed by RP Fanverse (virtual episodes, never Canon event numbers).
  const FAN_REFERENCE_RULES = `FAN-FACING REFERENCE RULES:
- canonEventId values, sourceCanonEventIds, sourceTurnIds, sourceMessageIds, pending/event IDs and tokens such as "canon_…" or "fact_…" are internal tracking metadata. Put them only in the JSON ID fields that ask for them. Never write them, or database-style numbering such as "Canon #12", "Canon Event 4", "event ID", "Canon 번호", in any text fans can see (titles, bodies, comments, captions, tags, summaries, continuationTopics, payload text, fanwork prose).
- Refer to story events the way a real fandom does: by episode (episodeLabel such as "12화"; "이번 화" for fandomTimeline.latestEpisodeLabel, "저번 화" for previousEpisodeLabel), part of the episode (episodePart: 초반부/중반부/후반부/마지막), place, action and dialogue (sceneLabel), e.g. "12화 음악실 씬", "저번 화 마지막에 둘이 옥상에 남았던 장면", "원작에서", "본편에서", "작중에서". In Japanese text use 「12話」「今回」「前回」「本編」「原作」 the same way.
- Do not keep repeating the system words "Canon", "Canon에서", "Canon상". Say 원작/본편/작중 (原作/本編). The canon-versus-fan-interpretation distinction still applies: confirmed story events are 원작 facts, theories stay interpretations.`;

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
Return interpretation updates, ship/tag deltas, reaction points, and pending events with dueTurn and expiryTurn. Keep the IDs in sourceCanonEventIds; in free text (text, reason, summary, payload) refer to events by episodeLabel/sceneLabel, never by ID.

${FAN_REFERENCE_RULES}`,
    redditGenerator: `Create virtual Reddit-like fandom posts reacting to the supplied canon and fan interpretations. Use only the persistent persona IDs provided. Users share canon facts but disagree in interpretation. Include analysis, theories, episode discussion, CP discussion, unpopular opinions, and occasional text memes. The category field is shown as the post flair, so keep it short (e.g. Discussion, Theory, Analysis, Shipping, Meme, Unpopular Opinion, Episode Discussion). Generate only a small initial comment sample per post; the rest will be generated on demand. Comments are a flat list with id and parentId for nested rendering. Supply estimatedCommentCount, hasMoreComments, and continuationTopics so later batches can continue naturally. Do not claim fan theories are canon. Language: Korean, with natural fandom jargon.

${FAN_REFERENCE_RULES}

PERSONAS:
{{PERSONAS}}

REACTION INPUT:
{{REACTIONS}}

ACTIVITY: {{ACTIVITY}}`,
    redditMoreComments: `Continue a persistent virtual Reddit discussion. Generate only the next comment batch, not the post again. Reuse only the supplied persona IDs. Comments may reply to an existing comment ID or another new temporary ID from this batch. Preserve disagreements and persona biases, avoid repeating existing comments, and ground all claims in the supplied canon/fandom context. Return hasMoreComments based on whether the discussion still has worthwhile unexplored threads. Language: Korean.

${FAN_REFERENCE_RULES}

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
    pixivMetadataGenerator: `Create metadata only for virtual Japanese Pixiv-like fanworks based on the supplied fandom reaction input. Do NOT write the full work. Use only persistent author persona IDs provided. Titles/captions/tags should feel natural in Japanese. Source canon IDs must be retained in sourceCanonEventIds only.

LENGTH (fictionalCharacterCount is the planned length of the work and is used when it is written):
- Most works are complete one-shot short pieces of about 800–2500 characters; shorter drabbles (300–800) are welcome.
- 3000–5000 characters only occasionally.
- Above 8000 characters (a long work) only rarely, and only when the premise is a big fandom trend, the author persona leans toward long works, the premise is strong enough to carry a long story, or the work continues a series (seriesTitle).
- Prefer several short works with clearly different premises and moods over one long work.

VARIETY:
- A short work shows one scene, one feeling or one idea well (a single scene, a dialogue piece, a missing scene, a short IF, one AU scene, a character study, one relationship moment, a gag piece, an alternate or bad ending fragment, a small future fabrication, slice of life). It is never a plot summary and does not force a full arc.
- Mix sources and settings across the batch: 原作軸, 幕間, missing scene, canon divergence, IF, future fabrication, modern AU, school AU, workplace/profession AU, fantasy, magic/superpowers, SF, space, zombie apocalypse, post-apocalypse, cyberpunk, steampunk, historical, myth/fairy-tale motifs, time loop, amnesia, role reversal, fake relationship, roommates, crack, character study, rare pairings, multi-person relationships.
- An AU is not just a new backdrop: reinterpret the characters' personalities and relationships under that world's rules.
- Do not repeat an AU, premise or emotional pattern already used in REACTION INPUT.recentPixivWorks or elsewhere in the same batch; vary tone (sweet, painful, funny, eerie, quiet) and workType.

${FAN_REFERENCE_RULES}

AUTHORS:
{{PERSONAS}}

REACTION INPUT:
{{REACTIONS}}

ACTIVITY: {{ACTIVITY}}`,
    fanwork: `You are writing a virtual fanwork based on an RP treated as official canon. This is FANWORK, not canon. Respect the metadata, author persona, relevant canon facts, and chosen divergence type. Write naturally in {{LANGUAGE}}. Target approximately {{TARGET_LENGTH}} characters. A short target means a complete one-shot that shows one scene, one feeling or one idea fully (not a summary, no forced full arc). Do not add meta commentary before or after the work. The prose never contains internal IDs or "Canon" labels; use the episode/scene aliases only to locate the moment in the story.

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
    fanworkRevision: `Revise the complete virtual fanwork to fix every accidental continuity issue listed below. Preserve the work's title, voice, emotional arc, approximate length, deliberate IF/AU divergences, and all passages that do not need changes. Return only the full corrected fanwork with no preface or commentary, and never include internal IDs or "Canon" labels in the prose. Language: {{LANGUAGE}}.

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

  function renderPromptTemplate(promptId, values) {
    return DEFAULT_PROMPT_TEMPLATES[promptId].replace(PLACEHOLDER_RE, (_, name) => {
      const value = values[name];
      return typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value ?? null, null, 2);
    });
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
  // Developer API and Firebase AI Logic (GenerationConfig.responseJsonSchema) accept. The older
  // `responseSchema` is an OpenAPI subset whose `type` is a single enum, so nullable fields written
  // as ["string", "null"] would be rejected.
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

  // ---------- chat room title (world.chatTitle) ----------
  // world.chatTitle is the title of the Crack character-chat room the user has open, read from Crack
  // itself (never generated, never an ID). It is the shared work title for Reddit's community name and
  // later RIDI/EPUB (dc:title, cover/TOC, file name). Only surrounding whitespace is removed.
  const GENERIC_TITLES = new Set(['크랙', 'crack', 'wrtn', 'fanverse', 'rp fanverse', 'untitled', 'story', 'chat', 'undefined', 'null', '새 채팅', '채팅']);

  function isValidChatTitle(value, ids = []) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text || text.length > 100) return false;
    if (GENERIC_TITLES.has(text.toLowerCase())) return false;
    if (ids.filter(Boolean).includes(text)) return false;
    if (/^[0-9a-f]{24}$/i.test(text) || /^[0-9a-f-]{32,36}$/i.test(text)) return false; // Mongo/UUID-style IDs
    return true;
  }

  // GET /v3/chats/{chatId} → data. Crack's room object carries its own room title; `story.name` is the
  // original work's name, which Crack also uses as the default name of a new room, so it is only used
  // when the room has no title of its own. Returns { title, source } or null.
  function extractChatRoomTitle(chat, ids = []) {
    if (!chat || typeof chat !== 'object') return null;
    for (const [source, value] of [['api:title', chat.title], ['api:name', chat.name], ['api:story.name', chat.story?.name]]) {
      if (isValidChatTitle(value, ids)) return { title: value.trim(), source };
    }
    return null;
  }

  // ---------- RP log cleaning (Books/EPUB + fan-facing scene references) ----------
  // Deterministic, no AI. The RP text itself is never rewritten: only chat-UI wrappers are removed
  // (OOC lore context, shortcut directives, HUD/status lines, code fences, role labels) and the
  // time/place HUD is turned into scene metadata.
  const HUD_TIME_KEY_RE = /^(?:시간|시각|일시|날짜|일자|time|date|📅|🗓️?|🕐|🕑|🕒|⏰|⌚)$/iu;
  const HUD_PLACE_KEY_RE = /^(?:장소|위치|place|location|📍|🏠|🗺️?)$/iu;
  const HUD_MARKER_RE = /^(?:턴|turn|hud|상태|status|날씨|weather|d\+?\d*|day\s*\d*|\d+\s*일차)$/iu;
  const TIME_LIKE_RE = /(\d{1,4}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*일|요일|\d{1,2}:\d{2}|오전|오후|아침|점심|저녁|새벽|정오|자정|\b(?:AM|PM)\b|day\s*\d+|\d{4}[./-]\d{1,2}[./-]\d{1,2})/i;
  const CLOCK_RE = /(\d{1,2}:\d{2}(?::\d{2})?|\b(?:AM|PM)\b|오전|오후|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?)/gi;
  const EPUB_IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' });

  function hudField(segment) {
    const text = String(segment || '').trim();
    let match = text.match(/^([^:：=]{1,12}?)\s*[:：=]\s*(.+)$/u);
    // A key never contains digits (so "14:05" or "6월 5일 14:30" is a value), unless it is a HUD marker like "D+3".
    if (match && (!/\d/.test(match[1]) || HUD_MARKER_RE.test(match[1].trim()))) return { key: match[1].trim(), value: match[2].trim() };
    match = text.match(/^(\p{Extended_Pictographic}️?)\s*(.+)$/u);
    if (match) return { key: match[1], value: match[2].trim() };
    return { key: '', value: text };
  }

  function hudKind(field) {
    if (field.key) {
      if (HUD_TIME_KEY_RE.test(field.key)) return 'time';
      if (HUD_PLACE_KEY_RE.test(field.key)) return 'place';
      if (HUD_MARKER_RE.test(field.key)) return 'marker';
      return 'other';
    }
    if (HUD_MARKER_RE.test(field.value)) return 'marker';
    if (/^#?\d+$/.test(field.value)) return 'number';
    if (TIME_LIKE_RE.test(field.value)) return 'time';
    return 'text';
  }

  // One line → { time, place } when it is a HUD/status line, else null. Only these shapes count:
  //   [턴|12|2026년 6월 5일 14:05|음악실]   [시간: 오후 3시 | 장소: 음악실]   [장소: 음악실]
  //   시간: 오후 3시 | 장소: 음악실          📅 6월 5일 | 📍 음악실
  // and, inside a message's leading header block only (loose), a single "장소: 음악실" line.
  // Ordinary bracketed text such as [띵동] or [시스템 메시지] is not a HUD.
  function parseHudLine(line, { loose = false } = {}) {
    let text = String(line || '').trim();
    if (!text || text.length > 300) return null;
    const bracketed = /^\[[^[\]]+\]$/.test(text) || /^【[^【】]+】$/.test(text);
    if (bracketed) text = text.slice(1, -1).trim();
    const segments = text.split(/\s*[|｜]\s*/).filter(Boolean);
    if (!segments.length) return null;
    const fields = segments.map(hudField);
    const kinds = fields.map(hudKind);
    const labeled = fields.some((field, index) => field.key && (kinds[index] === 'time' || kinds[index] === 'place'));
    const markerFirst = kinds[0] === 'marker';
    const allKeyed = fields.every((field) => field.key);
    let hud = false;
    if (bracketed && segments.length >= 2) hud = markerFirst || labeled;
    else if (bracketed) hud = labeled || markerFirst;
    else if (segments.length >= 2) hud = allKeyed && labeled;
    else hud = labeled && (loose || /\p{Extended_Pictographic}/u.test(fields[0].key));
    if (!hud) return null;
    let time = null; let place = null;
    fields.forEach((field, index) => {
      if (kinds[index] === 'time' && !time) time = field.value;
      if (kinds[index] === 'place' && field.key && !place) place = field.value;
    });
    if (!place) {
      // Unlabeled HUD ([턴|12|날짜|장소]): the first plain text field after the time is the place.
      const timeIndex = kinds.indexOf('time');
      const candidate = fields.find((field, index) => !field.key && kinds[index] === 'text' && index > timeIndex && field.value.length <= 40);
      if (candidate && (timeIndex >= 0 || markerFirst)) place = candidate.value;
    }
    return { time: time || null, place: place || null };
  }

  function sceneDayKey(time) {
    return String(time || '').replace(CLOCK_RE, '').replace(/[\s,·~-]+/g, ' ').trim();
  }

  function decodeHtmlEntities(text) {
    return String(text).replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
      const lower = code.toLowerCase();
      if (lower === 'amp') return '&'; if (lower === 'lt') return '<'; if (lower === 'gt') return '>';
      if (lower === 'quot') return '"'; if (lower === 'apos') return "'"; if (lower === 'nbsp') return ' ';
      const point = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      try { return String.fromCodePoint(point); } catch (_) { return match; }
    });
  }

  // Removes "(shortcut: …)" / "(ooc: …)" directives with balanced parentheses (the directive may
  // itself contain parentheses). Anything else in parentheses is RP text and stays.
  function removeParenDirectives(text, names = ['shortcut', 'ooc']) {
    const opener = new RegExp(`[(（]\\s*(?:${names.join('|')})\\s*[:：]`, 'iu');
    let source = String(text);
    for (let guard = 0; guard < 200; guard += 1) {
      const match = opener.exec(source);
      if (!match) break;
      let depth = 0; let end = -1;
      for (let i = match.index; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(' || ch === '（') depth += 1;
        else if (ch === ')' || ch === '）') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      source = end < 0 ? source.slice(0, match.index) : source.slice(0, match.index) + source.slice(end + 1);
    }
    return source;
  }

  const IMAGE_URL_LINE_RE = /^\s*<?((?:https?:\/\/|data:image\/)[^\s<>]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s<>]*)?)>?\s*$/i;

  // Image references inside one message: markdown ![](…), <img src="…">, a bare image URL line, and
  // image-like URL fields on the message object itself (e.g. an attached illustration).
  function messageImageFields(message) {
    const urls = [];
    const visit = (value, key, depth) => {
      if (depth > 3 || value == null) return;
      if (typeof value === 'string') {
        if (/^(?:https?:\/\/|data:image\/)/i.test(value) && (/image|img|illust|picture|photo|thumbnail|media|asset|file/i.test(key) || /\.(?:png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(value))) urls.push(value);
        return;
      }
      if (Array.isArray(value)) { value.forEach((item) => visit(item, key, depth + 1)); return; }
      if (typeof value === 'object') for (const [childKey, child] of Object.entries(value)) if (!['content', '_id', 'turnId', 'parentTurnId'].includes(childKey)) visit(child, childKey, depth + 1);
    };
    visit(message, '', 0);
    return urls;
  }

  // Cleans one RP message into ordered blocks: { type: 'p', text } | { type: 'img', url } | { type: 'break' }.
  // Returns { blocks, time, place } where time/place come from the message's HUD (first values found).
  function cleanRpMessage(message, { role = message?.role } = {}) {
    let text = String(message?.content ?? '').replace(/\r\n?/g, '\n');
    text = text.replace(/<ooc_[\w-]*>[\s\S]*?<\/ooc_[\w-]*>/gi, '\n');
    text = text.replace(/<\/?ooc_[\w-]*>/gi, '');
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    if (role === 'user') {
      text = removeParenDirectives(text);
      text = text.split('\n').filter((line) => !/^\s*\/[\p{L}\p{N}_-]{1,20}\s*$/u.test(line)).join('\n');
    }
    const images = [];
    const placeholder = (url) => { images.push(decodeHtmlEntities(url.trim())); return `\n\u0001IMG${images.length - 1}\u0001\n`; };
    text = text.replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g, (_, url) => placeholder(url));
    text = text.replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, url) => placeholder(url));
    text = text.split('\n').map((line) => { const match = line.match(IMAGE_URL_LINE_RE); return match ? placeholder(match[1]) : line; }).join('\n');
    text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n').replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '');
    text = decodeHtmlEntities(text);
    for (const url of messageImageFields(message)) if (!images.includes(url)) { images.push(url); text += `\n\u0001IMG${images.length - 1}\u0001\n`; }

    const blocks = [];
    let time = null; let place = null; let seenProse = false;
    const takeScene = (scene) => { if (scene.time && !time) time = scene.time; if (scene.place && !place) place = scene.place; };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (/^\s*(```|~~~)/.test(raw)) {
        // Code fence: a status window made of "key: value" lines is a HUD; anything else is unwrapped.
        const fence = []; let j = i + 1;
        while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) { fence.push(lines[j]); j += 1; }
        i = j;
        const filled = fence.map((line) => line.trim()).filter(Boolean);
        const fields = filled.map((line) => parseHudLine(line, { loose: true }) || (hudField(line).key && !/\d/.test(hudField(line).key) ? {} : null));
        if (filled.length && fields.every(Boolean) && fields.some((scene) => scene.time || scene.place)) { fields.forEach(takeScene); continue; }
        for (const line of fence) if (line.trim()) { blocks.push({ type: 'p', text: line.trim() }); seenProse = true; }
        continue;
      }
      let line = raw.trim();
      if (!line) continue;
      const image = line.match(/^\u0001IMG(\d+)\u0001$/);
      if (image) { blocks.push({ type: 'img', url: images[Number(image[1])] }); continue; }
      if (/^(?:-{3,}|\*{3,}|_{3,}|={3,}|[*＊]\s*[*＊]\s*[*＊])$/.test(line)) { blocks.push({ type: 'break' }); continue; }
      const scene = parseHudLine(line, { loose: !seenProse });
      if (scene) { takeScene(scene); continue; }
      line = line.replace(/^(?:USER|ASSISTANT|AI|사용자|어시스턴트)\s*[:：]\s*/i, '').replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '');
      if (!line) continue;
      blocks.push({ type: 'p', text: line });
      seenProse = true;
    }
    while (blocks.length && blocks[0].type === 'break') blocks.shift();
    while (blocks.length && blocks[blocks.length - 1].type === 'break') blocks.pop();
    return { blocks, time, place };
  }

  // "이름 | "대사"" dialogue format used by the assistant side of the log (null when not used).
  const PIPE_DIALOGUE_RE = /^([^|"“「『\n]{1,24}?)\s*[|｜]\s*(["“「『].*)$/u;
  function detectDialogueStyle(assistantBlockLists) {
    let pipe = 0; let quoted = 0;
    for (const blocks of assistantBlockLists) {
      for (const block of blocks) {
        if (block.type !== 'p') continue;
        if (PIPE_DIALOGUE_RE.test(block.text)) pipe += 1;
        else if (/^["“「『]/.test(block.text)) quoted += 1;
      }
    }
    return pipe >= 2 && pipe >= quoted ? 'pipe' : null;
  }

  // Formats a bare quoted user line like the other characters' lines. Only with a known name.
  function unifyUserDialogue(blocks, style, name) {
    const speaker = String(name || '').trim();
    if (style !== 'pipe' || !speaker) return blocks;
    return blocks.map((block) => (block.type === 'p' && /^["“「『]/.test(block.text) && !PIPE_DIALOGUE_RE.test(block.text) ? { ...block, text: `${speaker} | ${block.text}` } : block));
  }

  // Scene of a turn: the assistant's HUD, else the user's.
  function turnScene(turn) {
    const assistant = cleanRpMessage({ role: 'assistant', content: turn?.assistant || '' });
    const user = cleanRpMessage({ role: 'user', content: turn?.user || '' });
    return { time: assistant.time || user.time || null, place: assistant.place || user.place || null };
  }

  // Virtual episodes ("N화") for fan-facing references and EPUB chapters. A new episode starts after
  // `maxTurns` turns, or after `minTurns` when the place or the day changes. Each decision only looks
  // at earlier turns, so adding turns never renumbers existing episodes. Not related to Canon IDs.
  const EPISODE_MIN_TURNS = 4;
  const EPISODE_MAX_TURNS = 10;
  function segmentEpisodes(scenes, { minTurns = EPISODE_MIN_TURNS, maxTurns = EPISODE_MAX_TURNS } = {}) {
    const numbers = [];
    let episode = 1; let start = 0; let lastPlace = null; let lastDay = null;
    (scenes || []).forEach((scene, index) => {
      const place = scene?.place || null;
      const day = scene?.time ? sceneDayKey(scene.time) || null : null;
      const changed = Boolean((place && lastPlace && place !== lastPlace) || (day && lastDay && day !== lastDay));
      const length = index - start;
      if (index > 0 && (length >= maxTurns || (length >= minTurns && changed))) { episode += 1; start = index; }
      numbers.push(episode);
      if (place) lastPlace = place;
      if (day) lastDay = day;
    });
    return numbers;
  }

  function episodeLabel(number) { return Number(number) > 0 ? `${number}화` : null; }

  // eventId → { episodeLabel, sceneLabel, episodePart, scenePlace, sceneTime }: display aliases for
  // prompts and UI. The Canon event (and its source IDs) is not modified.
  function buildFanReferenceIndex(turns, events, scenes = null) {
    const turnScenes = scenes || (turns || []).map(turnScene);
    const episodes = segmentEpisodes(turnScenes);
    const turnIndex = new Map((turns || []).map((turn, index) => [turn.id, index]));
    const lastIndexOf = new Map();
    episodes.forEach((episode, index) => lastIndexOf.set(episode, index));
    const firstIndexOf = new Map();
    episodes.forEach((episode, index) => { if (!firstIndexOf.has(episode)) firstIndexOf.set(episode, index); });
    const placeAt = (index) => { for (let i = index; i >= 0; i -= 1) if (turnScenes[i]?.place) return turnScenes[i].place; return null; };
    const timeAt = (index) => { for (let i = index; i >= 0; i -= 1) if (turnScenes[i]?.time) return turnScenes[i].time; return null; };
    const latest = episodes.length ? episodes[episodes.length - 1] : 0;
    const byEvent = new Map();
    for (const event of events || []) {
      const indices = (event.sourceTurnIds || []).map((id) => turnIndex.get(id)).filter((index) => index != null);
      let index = indices.length ? Math.min(...indices) : Math.min(episodes.length, Math.max(1, Number(event.turn) || 1)) - 1;
      if (index < 0 || !episodes.length) continue;
      index = Math.min(index, episodes.length - 1);
      const episode = episodes[index];
      const first = firstIndexOf.get(episode); const last = lastIndexOf.get(episode);
      const span = Math.max(1, last - first + 1);
      const ratio = (index - first) / span;
      const part = episode === latest && index === last ? '마지막' : ratio < 0.34 ? '초반부' : ratio < 0.67 ? '중반부' : index === last ? '마지막' : '후반부';
      const place = placeAt(index);
      const title = String(event.title || event.summary || '').trim();
      const base = [place ? `${place}에서` : '', title].filter(Boolean).join(' ');
      byEvent.set(event.id, { episodeLabel: episodeLabel(episode), sceneLabel: base && !/(장면|씬)$/.test(base) ? `${base} 장면` : base || null, episodePart: part, scenePlace: place, sceneTime: timeAt(index) });
    }
    return {
      episodes,
      byEvent,
      timeline: { latestEpisodeLabel: episodeLabel(latest), previousEpisodeLabel: latest > 1 ? episodeLabel(latest - 1) : null, episodeCount: latest },
      episodeLabelForTurnCount(count) { const n = Math.max(1, Math.min(episodes.length, Number(count) || 0)); return episodes.length ? episodeLabel(episodes[n - 1]) : null; },
    };
  }

  // Deep copy of a prompt payload with fan-facing aliases added next to the internal IDs (which stay).
  function annotateFanReferences(value, index, depth = 0) {
    if (depth > 8 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => annotateFanReferences(item, index, depth + 1));
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = annotateFanReferences(child, index, depth + 1);
    const own = typeof value.id === 'string' ? index?.byEvent?.get(value.id) : null;
    if (own) Object.assign(copy, { episodeLabel: own.episodeLabel, sceneLabel: own.sceneLabel, episodePart: own.episodePart, scenePlace: own.scenePlace });
    if (Array.isArray(value.sourceCanonEventIds) && value.sourceCanonEventIds.length) {
      const refs = [];
      for (const id of value.sourceCanonEventIds) {
        const ref = index?.byEvent?.get(id);
        if (ref && !refs.some((item) => item.sceneLabel === ref.sceneLabel && item.episodeLabel === ref.episodeLabel)) refs.push({ episodeLabel: ref.episodeLabel, episodePart: ref.episodePart, sceneLabel: ref.sceneLabel });
      }
      if (refs.length) copy.fanReferences = refs;
    }
    return copy;
  }

  // Removes internal tracking IDs and database-style "Canon #12" references from fan-visible text.
  // Applied to generated text before saving and again when rendering (older saved posts).
  function scrubFanText(text, knownIds = null) {
    if (typeof text !== 'string' || !text) return text;
    const japanese = /[぀-ヿ]/.test(text);
    const origin = japanese ? '原作' : '원작';
    let result = text;
    if (knownIds) for (const id of knownIds) if (id && id.length >= 6 && result.includes(id)) result = result.split(id).join('');
    result = result
      .replace(/\b(?:source_?)?(?:canon_?event|turn|message|pending_?event)_?ids?\b/gi, '')
      .replace(/\b(?:sourceCanonEventIds|sourceTurnIds|sourceMessageIds|canonEventIds?|pendingEventIds?)\b/g, '')
      .replace(/\b(?:canon|fact|pending|interpretation|reddit|pixiv|comment)_(?=[0-9a-z]*\d)[0-9a-z]{3,10}\b/gi, '')
      .replace(/\b(?:internal\s+)?(?:source|event)\s+IDs?\b\s*[:#]?\s*(?:[\w-]*\d[\w-]*)?/gi, '')
      .replace(/\bcanon\s*(?:event|이벤트|사건|イベント)?\s*(?:#|no\.?|번호)\s*\d+(?:\s*번)?/gi, origin)
      .replace(/\bcanon\s+(?:event|이벤트|사건|イベント)\s*\d+(?:\s*번)?/gi, origin)
      .replace(/\bcanon\s*번호/gi, origin)
      .replace(/\bcanon(?=에서|상(?![가-힣]))/gi, origin);
    if (result === text) return text;
    // Tidy only what a removal left behind (empty brackets, doubled spaces); untouched text keeps its spacing.
    return result.replace(/[(（[]\s*[,、·]?\s*[)）\]]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?、。])/g, '$1').trim();
  }

  // ---------- EPUB 3 writer (no dependency) ----------
  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  // Escaped text with **strong** and *em* (Crack narration markdown). Tags never nest across each
  // other because neither pattern may contain markup, so the result is always well-formed XHTML.
  function epubInline(text) {
    return xmlEscape(text)
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*<>\s](?:[^*<>]*?[^*<>\s])?)\*/g, '<em>$1</em>');
  }

  // Windows-forbidden characters only; the title itself is kept (no slug, no translation).
  function epubFileName(title, fallback = 'RP Fanverse') {
    let name = String(title || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!name) name = fallback;
    if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `${name}_`;
    return `${Array.from(name).slice(0, 120).join('')}.epub`;
  }

  function stableUuid(text) {
    const fnv = (input, seed) => { let hash = seed >>> 0; for (let i = 0; i < input.length; i += 1) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; } return hash.toString(16).padStart(8, '0'); };
    const hex = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => fnv(String(text), seed)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  function sniffImageType(bytes) {
    const b = bytes || [];
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif';
    const head = String.fromCharCode(...Array.from(b.slice ? b.slice(0, 256) : []).filter((c) => c < 128));
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
    return null;
  }

  // Groups cleaned messages into chapters (one per virtual episode) and lays out the scene markers:
  // a time/place marker appears only where the day or the place changes.
  // messages: chronological active-branch messages; turns: buildTurns(messages).
  function buildBookChapters(messages, turns, { userName = '', unifyDialogue = true, sceneMarkers = true, includeImages = true } = {}) {
    const cleaned = (messages || []).map((message) => ({ message, ...cleanRpMessage(message) }));
    const style = detectDialogueStyle(cleaned.filter((item) => item.message.role === 'assistant').map((item) => item.blocks));
    const scenes = (turns || []).map(turnScene);
    const episodes = segmentEpisodes(scenes);
    const turnOfMessage = new Map();
    (turns || []).forEach((turn, index) => { turnOfMessage.set(turn.userMessageId, index); turnOfMessage.set(turn.assistantMessageId, index); });
    const chapters = [];
    let current = null; let lastTurn = 0; let lastDay = null; let lastPlace = null; let lastTime = null;
    for (const item of cleaned) {
      const turn = turnOfMessage.has(item.message._id) ? turnOfMessage.get(item.message._id) : lastTurn;
      lastTurn = turn;
      const number = episodes.length ? episodes[Math.min(turn, episodes.length - 1)] : 1;
      if (!current || current.number !== number) {
        current = { number, title: episodeLabel(number), place: null, blocks: [] };
        chapters.push(current);
      }
      let blocks = item.blocks;
      if (item.message.role === 'user' && unifyDialogue) blocks = unifyUserDialogue(blocks, style, userName);
      if (!includeImages) blocks = blocks.filter((block) => block.type !== 'img');
      // A turn's scene is its reply's HUD, so the marker lands before the user's line of that turn.
      const turnSceneOf = turnOfMessage.has(item.message._id) ? scenes[turn] : null;
      const time = turnSceneOf?.time || item.time;
      const place = turnSceneOf?.place || item.place;
      const day = time ? sceneDayKey(time) || time : null;
      if (sceneMarkers && (time || place)) {
        const dayChanged = Boolean(day && day !== lastDay);
        const placeChanged = Boolean(place && place !== lastPlace);
        if (dayChanged || placeChanged) current.blocks.push({ type: 'scene', time: time || lastTime, place: place || lastPlace });
      }
      if (place && !current.place) current.place = place;
      if (day) lastDay = day;
      if (time) lastTime = time;
      if (place) lastPlace = place;
      if (blocks.length) current.blocks.push(...blocks);
    }
    return { chapters: chapters.filter((chapter) => chapter.blocks.length), dialogueStyle: style };
  }

  const EPUB_CSS = `body{margin:0 5%;font-family:serif;line-height:1.85;word-break:keep-all;overflow-wrap:break-word}
h1.ep-title{margin:2.5em 0 2em;font-size:1.35em;font-weight:bold;text-align:center}
p{margin:0 0 .9em;text-indent:0}
.scene{margin:2.4em 0 1.6em;text-align:center;color:#555}
.scene p{margin:0;font-size:.88em;line-height:1.6}
.scene .scene-place{font-weight:bold}
hr.scene-mark{width:20%;margin:2em auto;border:0;border-top:1px solid #999}
figure.illust{margin:1.5em 0;text-align:center}
figure.illust img{max-width:100%;max-height:95vh}
.cover{margin:0;padding:0;text-align:center}
.cover img{max-width:100%;max-height:100vh}
nav ol{list-style:none;padding-left:0}
nav li{margin:.4em 0}`;

  function xhtmlDocument(title, body, { css = 'styles/book.css', bodyClass = '' } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko">
<head>
<meta charset="UTF-8"/>
<title>${xmlEscape(title)}</title>
<link rel="stylesheet" type="text/css" href="${css}"/>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
</body>
</html>
`;
  }

  // book: { title, language, identifier, modified (Date), description, source, chapters, cover: { data, mediaType } }
  // images: Map(url → { data, mediaType }) of downloaded images; references to missing ones are dropped.
  // Returns [{ name, data }] in EPUB order (mimetype first). Every referenced file is in the manifest.
  function buildEpubFiles(book, images = new Map()) {
    const encoder = new TextEncoder();
    const files = [];
    const add = (name, data) => files.push({ name, data: typeof data === 'string' ? encoder.encode(data) : data });
    const modified = new Date(book.modified || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const identifier = book.identifier || `urn:uuid:${stableUuid(book.title || 'book')}`;
    const imageItems = []; const imageHref = new Map();
    for (const chapter of book.chapters) {
      for (const block of chapter.blocks) {
        if (block.type !== 'img' || imageHref.has(block.url)) continue;
        const image = images.get(block.url);
        const ext = image && EPUB_IMAGE_TYPES[image.mediaType];
        if (!ext) continue;
        const id = `img${String(imageItems.length + 1).padStart(3, '0')}`;
        imageHref.set(block.url, `images/${id}.${ext}`);
        imageItems.push({ id, href: `images/${id}.${ext}`, mediaType: image.mediaType, data: image.data });
      }
    }
    const coverExt = book.cover && EPUB_IMAGE_TYPES[book.cover.mediaType];
    const coverHref = coverExt ? `images/cover.${coverExt}` : null;
    const chapterItems = book.chapters.map((chapter, index) => {
      const id = `ep${String(index + 1).padStart(3, '0')}`;
      const body = chapter.blocks.map((block) => {
        if (block.type === 'p') return `<p>${epubInline(block.text)}</p>`;
        if (block.type === 'break') return '<hr class="scene-mark"/>';
        if (block.type === 'scene') return `<div class="scene">${block.time ? `<p class="scene-time">${xmlEscape(block.time)}</p>` : ''}${block.place ? `<p class="scene-place">${xmlEscape(block.place)}</p>` : ''}</div>`;
        if (block.type === 'img' && imageHref.has(block.url)) return `<figure class="illust"><img src="../${imageHref.get(block.url)}" alt=""/></figure>`;
        return '';
      }).filter(Boolean).join('\n');
      const heading = chapter.title || `${index + 1}`;
      return { id, href: `text/${id}.xhtml`, label: chapter.place ? `${heading} · ${chapter.place}` : heading, xhtml: xhtmlDocument(heading, `<section epub:type="chapter" id="${id}">\n<h1 class="ep-title">${xmlEscape(heading)}</h1>\n${body}\n</section>`, { css: '../styles/book.css' }) };
    });
    const title = xmlEscape(book.title);
    const language = xmlEscape(book.language || 'ko');
    add('mimetype', 'application/epub+zip');
    add('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`);
    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '<item id="css" href="styles/book.css" media-type="text/css"/>',
      ...(coverHref ? [`<item id="cover-image" href="${coverHref}" media-type="${book.cover.mediaType}" properties="cover-image"/>`, '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>'] : []),
      ...chapterItems.map((item) => `<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`),
      ...imageItems.map((item) => `<item id="${item.id}" href="${item.href}" media-type="${item.mediaType}"/>`),
    ];
    const spine = [...(coverHref ? ['<itemref idref="cover" linear="yes"/>'] : []), ...chapterItems.map((item) => `<itemref idref="${item.id}"/>`)];
    add('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${xmlEscape(identifier)}</dc:identifier>
<dc:title>${title}</dc:title>
<dc:language>${language}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
${book.description ? `<dc:description>${xmlEscape(book.description)}</dc:description>\n` : ''}${book.source ? `<dc:source>${xmlEscape(book.source)}</dc:source>\n` : ''}<dc:publisher>RP Fanverse</dc:publisher>
${coverHref ? '<meta name="cover" content="cover-image"/>\n' : ''}</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
</package>
`);
    const tocList = chapterItems.map((item) => `<li><a href="${item.href}">${xmlEscape(item.label)}</a></li>`).join('\n');
    add('OEBPS/nav.xhtml', xhtmlDocument(book.title, `<nav epub:type="toc" id="toc">
<h1>목차</h1>
<ol>
${tocList}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<ol>
${coverHref ? '<li><a epub:type="cover" href="cover.xhtml">표지</a></li>\n' : ''}${chapterItems.length ? `<li><a epub:type="bodymatter" href="${chapterItems[0].href}">본문</a></li>\n` : ''}</ol>
</nav>`));
    add('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${language}">
<head>
<meta name="dtb:uid" content="${xmlEscape(identifier)}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${title}</text></docTitle>
<navMap>
${chapterItems.map((item, index) => `<navPoint id="np${index + 1}" playOrder="${index + 1}"><navLabel><text>${xmlEscape(item.label)}</text></navLabel><content src="${item.href}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`);
    add('OEBPS/styles/book.css', EPUB_CSS);
    if (coverHref) {
      add('OEBPS/cover.xhtml', xhtmlDocument(book.title, `<section epub:type="cover" class="cover"><img src="${coverHref}" alt="${title}"/></section>`, { bodyClass: 'cover' }));
      add(`OEBPS/${coverHref}`, book.cover.data);
    }
    for (const item of chapterItems) add(`OEBPS/${item.href}`, item.xhtml);
    for (const item of imageItems) add(`OEBPS/${item.href}`, item.data);
    return files;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    return table;
  })();
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) { return null; }
  }

  // Minimal ZIP (PKWARE APPNOTE): local headers + central directory, no ZIP64. The first entry
  // (mimetype) is always stored uncompressed with no extra field, as EPUB requires; text entries are
  // deflated when CompressionStream exists, images are stored. Returns Uint8Array parts for a Blob.
  async function createZip(files, { date = new Date(), compress = true, onEntry = null } = {}) {
    const encoder = new TextEncoder();
    const d = new Date(date);
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = []; const central = []; let offset = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const name = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const crc = crc32(data);
      const first = index === 0;
      let method = 0; let stored = data;
      if (compress && !first && !/\.(?:png|jpe?g|gif|webp)$/i.test(file.name)) {
        const deflated = await deflateRaw(data);
        if (deflated && deflated.length < data.length) { method = 8; stored = deflated; }
      }
      const flags = first ? 0 : 0x0800;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, flags, true); local.setUint16(8, method, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
      local.setUint32(18, stored.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, stored);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, flags, true); entry.setUint16(10, method, true);
      entry.setUint16(12, dosTime, true); entry.setUint16(14, dosDate, true); entry.setUint32(16, crc, true); entry.setUint32(20, stored.length, true); entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), name);
      offset += 30 + name.length + stored.length;
      await onEntry?.(index + 1, files.length);
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return [...parts, ...central, new Uint8Array(end.buffer)];
  }

  // Neutral fallback cover (SVG), used only when neither the room thumbnail nor a canvas cover is available.
  function coverSvg(title, subtitle = 'Crack 캐릭터채팅') {
    const chars = Array.from(String(title || ''));
    const lines = []; for (let i = 0; i < chars.length && lines.length < 6; i += 9) lines.push(chars.slice(i, i + 9).join(''));
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">
<rect width="1200" height="1800" fill="#f2f2f2"/>
<rect x="90" y="90" width="1020" height="1620" fill="none" stroke="#dddddd" stroke-width="4"/>
${lines.map((line, index) => `<text x="600" y="${620 + index * 130}" font-family="sans-serif" font-size="96" font-weight="700" fill="#333333" text-anchor="middle">${xmlEscape(line)}</text>`).join('\n')}
<text x="600" y="1560" font-family="sans-serif" font-size="44" fill="#999999" text-anchor="middle">${xmlEscape(subtitle)}</text>
</svg>
`;
  }

  // ---------- chat room thumbnail (world.chatCover) ----------
  // Crack image objects are { origin, w600, w200, gif? } (sometimes a plain URL). The static image is used.
  function crackImageUrl(image) {
    const ok = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
    if (ok(image)) return image.trim();
    if (!image || typeof image !== 'object') return null;
    for (const key of ['origin', 'w600', 'w200', 'url']) if (ok(image[key])) return image[key].trim();
    return null;
  }

  // The room thumbnail exactly as Crack's own chat list draws it next to the room title:
  // story.portraitImage (2:3 cover) || story.profileImage. Same GET /v3/chats/{chatId} object as the title.
  function extractChatRoomCover(chat) {
    if (!chat || typeof chat !== 'object') return null;
    const candidates = [['api:story.portraitImage', chat.story?.portraitImage], ['api:story.profileImage', chat.story?.profileImage], ['api:character.portraitImage', chat.character?.portraitImage], ['api:character.profileImage', chat.character?.profileImage]];
    for (const [source, image] of candidates) {
      const url = crackImageUrl(image);
      if (url) return { url, source };
    }
    return null;
  }

  // Room metadata Books shows next to the cover: original story name, its description, the user's chat profile name.
  function extractChatRoomMeta(chat) {
    const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
    return {
      cover: extractChatRoomCover(chat),
      storyName: text(chat?.story?.name, 100),
      description: text(chat?.story?.simpleDescription, 2000) || text(chat?.story?.description, 2000),
      profileName: text(chat?.chatProfile?.name, 30),
    };
  }

  // <img> src as rendered by Next.js (/_next/image?url=…) → the original image URL.
  function unwrapImageSource(src, base = 'https://crack.wrtn.ai') {
    try {
      const url = new URL(src, base);
      if (url.protocol === 'data:') return null;
      if (url.pathname.endsWith('/_next/image') && url.searchParams.get('url')) return new URL(url.searchParams.get('url'), url.origin).href;
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch (_) { return null; }
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
      modelLabel,
      buildVertexEndpoint,
      normalizeFirebaseConfig,
      validateFirebaseConfig,
      parseFirebaseConfigInput,
      buildSystemInstruction,
      defaultGlobalInstruction: DEFAULT_GLOBAL_INSTRUCTION,
      emptyFirebaseConfig: EMPTY_FIREBASE_CONFIG,
      validatePromptTemplate,
      inspectPromptTemplate,
      renderPromptTemplate,
      buildJsonGenerationConfig,
      parseSseText,
      readingMinutes,
      isValidChatTitle,
      extractChatRoomTitle,
      crackImageUrl,
      extractChatRoomCover,
      extractChatRoomMeta,
      unwrapImageSource,
      parseHudLine,
      cleanRpMessage,
      removeParenDirectives,
      detectDialogueStyle,
      unifyUserDialogue,
      turnScene,
      segmentEpisodes,
      buildFanReferenceIndex,
      annotateFanReferences,
      scrubFanText,
      buildBookChapters,
      buildEpubFiles,
      createZip,
      crc32,
      epubFileName,
      epubInline,
      stableUuid,
      sniffImageType,
      coverSvg,
      xmlEscape,
      promptDefinitions: PROMPT_DEFINITIONS,
      defaultPromptTemplates: DEFAULT_PROMPT_TEMPLATES,
    };
  }
  const NODE_TEST_MODE = typeof window === 'undefined' || !window.document;

  // GM storage that never takes startup down. If the GM_* grants are unavailable (for example a
  // damaged metadata block), values live in memory for this page view only; they are deliberately
  // not written to page-readable localStorage because settings include the API key.
  const gmMemory = new Map();
  const gmAvailable = () => typeof GM_getValue === 'function' && typeof GM_setValue === 'function' && typeof GM_deleteValue === 'function';
  const GMStore = {
    available: gmAvailable,
    async get(key, fallback) {
      try {
        const value = gmAvailable() ? await Promise.resolve(GM_getValue(key, fallback)) : gmMemory.get(key);
        return value == null ? fallback : value;
      } catch (error) {
        console.warn(`[RP Fanverse] GM_getValue(${key}) failed`, error);
        return fallback;
      }
    },
    async set(key, value) {
      if (!gmAvailable()) { gmMemory.set(key, value); return; }
      return Promise.resolve(GM_setValue(key, value));
    },
    async remove(key) {
      if (!gmAvailable()) { gmMemory.delete(key); return; }
      return Promise.resolve(GM_deleteValue(key));
    },
  };

  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
  }

  function pageWindow() {
    try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow; } catch (_) { /* no unsafeWindow grant */ }
    return window;
  }

  function parseRawHeaders(raw) {
    const headers = new Headers();
    for (const line of String(raw || '').split(/\r?\n/)) {
      const at = line.indexOf(':');
      if (at > 0) { try { headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim()); } catch (_) { /* forbidden header name */ } }
    }
    return headers;
  }

  function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
  }

  // fetch() for the bundled Firebase SDK, routed through GM_xmlhttpRequest so requests are not
  // subject to the host page's CSP/CORS. The body is exposed as a ReadableStream fed from
  // onprogress, so SSE streaming (generateContentStream) still arrives incrementally; if a userscript
  // manager does not report partial text, the stream simply delivers everything on load.
  function gmFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (typeof GM_xmlhttpRequest !== 'function') return fetch(input, init);
    const signal = init.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const headers = {};
      new Headers(init.headers || {}).forEach((value, key) => { headers[key] = value; });
      const encoder = new TextEncoder();
      let controller = null;
      let consumed = 0;
      let responded = false;
      let finished = false;
      let request = null;
      const body = new ReadableStream({ start(c) { controller = c; }, cancel() { try { request?.abort?.(); } catch (_) { /* already done */ } } });
      const push = (text) => {
        const fresh = String(text ?? '').slice(consumed);
        if (!fresh) return;
        consumed += fresh.length;
        controller.enqueue(encoder.encode(fresh));
      };
      const respond = (response) => {
        if (responded || !response?.status) return;
        responded = true;
        resolve(new Response(body, { status: response.status, statusText: response.statusText || '', headers: parseRawHeaders(response.responseHeaders) }));
      };
      const fail = (error) => {
        if (finished) return;
        finished = true;
        if (!responded) { responded = true; reject(error); return; }
        try { controller.error(error); } catch (_) { /* stream already closed */ }
      };
      request = GM_xmlhttpRequest({
        method: init.method || 'GET', url, headers, data: init.body,
        onreadystatechange: (response) => { if (response.readyState >= 2) respond(response); },
        onprogress: (response) => { respond(response); if (responded && !finished) push(response.responseText); },
        onload: (response) => {
          respond(response);
          if (finished) return;
          finished = true;
          push(response.responseText);
          try { controller.close(); } catch (_) { /* cancelled by the reader */ }
        },
        onerror: () => fail(new TypeError(`Failed to fetch ${new URL(url).host} (network error)`)),
        ontimeout: () => fail(new TypeError(`Failed to fetch ${new URL(url).host} (timeout)`)),
        onabort: () => fail(abortError(signal)),
      });
      signal?.addEventListener('abort', () => { try { request?.abort?.(); } catch (_) { /* noop */ } fail(abortError(signal)); }, { once: true });
    });
  }

  // Loads a third-party script into the page on demand (deduplicated, with timeout and cleanup so a
  // failed load can be retried). Used only for reCAPTCHA Enterprise when App Check is configured.
  const pageScriptLoads = new Map();
  function loadPageScript(src, isReady, label, timeoutMs = 15000) {
    if (isReady()) return Promise.resolve();
    if (pageScriptLoads.has(src)) return pageScriptLoads.get(src);
    let script = null;
    const loading = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 로딩 시간 초과 (${Math.round(timeoutMs / 1000)}초)`)), timeoutMs);
      script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.rpFanverse = label;
      script.onload = () => { clearTimeout(timer); isReady() ? resolve() : reject(new Error(`${label}를 불러왔지만 초기화되지 않았습니다`)); };
      script.onerror = () => { clearTimeout(timer); reject(new Error(`${label}를 불러오지 못했습니다 (네트워크 또는 차단)`)); };
      (document.head || document.documentElement).appendChild(script);
    }).catch((error) => {
      pageScriptLoads.delete(src);
      script?.remove();
      throw error;
    });
    pageScriptLoads.set(src, loading);
    return loading;
  }

  // App Check through the SDK's CustomProvider. The token is obtained here and exchanged with the
  // documented App Check REST methods (projects.apps.exchangeRecaptchaEnterpriseToken /
  // exchangeDebugToken) — the same calls the SDK's own providers make — because the built-in
  // reCAPTCHA provider reads `self.grecaptcha`, which lives on the page window and is not reliably
  // visible from a userscript sandbox.
  async function exchangeAppCheckToken(config, method, body) {
    const url = `https://content-firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/apps/${config.appId}:${method}?key=${encodeURIComponent(config.apiKey)}`;
    const response = await gmFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json())?.error?.message || ''; } catch (_) { /* non-JSON error */ }
      throw new Error(`App Check 토큰 교환 실패 (HTTP ${response.status})${message ? `: ${message}` : ''}`);
    }
    const json = await response.json();
    const seconds = parseFloat(String(json.ttl || '3600s'));
    if (!json.token) throw new Error('App Check 응답에 token이 없습니다');
    return { token: json.token, expireTimeMillis: Date.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000 };
  }

  // Google Identity Services (Vertex "Google 로그인") — loaded only when that button is pressed.
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  function googleOAuth() {
    return pageWindow().google?.accounts?.oauth2 || globalThis.google?.accounts?.oauth2 || null;
  }
  async function loadGoogleIdentityServices() {
    await loadPageScript(GIS_SRC, () => Boolean(googleOAuth()), 'Google 로그인 라이브러리');
    return googleOAuth();
  }

  async function recaptchaEnterpriseToken(siteKey) {
    const enterprise = () => pageWindow().grecaptcha?.enterprise;
    await loadPageScript(`https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`, () => typeof enterprise()?.ready === 'function', 'reCAPTCHA Enterprise');
    await withTimeout(new Promise((resolve) => enterprise().ready(resolve)), 15000, 'reCAPTCHA Enterprise 준비 시간 초과');
    return withTimeout(Promise.resolve(enterprise().execute(siteKey, { action: 'fire_app_check' })), 15000, 'reCAPTCHA Enterprise 토큰 발급 시간 초과');
  }

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

    // The room object Crack's chat page itself loads (GET /v3/chats/{chatId}, same API and auth as messages).
    async fetchChatRoomTitle(info) {
      const json = await this.request(`${API_BASE}/chats/${encodeURIComponent(info.episodeId)}`);
      return extractChatRoomTitle(json?.data, [info.storyId, info.episodeId]);
    }

    // Same room object, for Books: thumbnail, original story name/description, chat profile name.
    async fetchChatRoomMeta(info) {
      const json = await this.request(`${API_BASE}/chats/${encodeURIComponent(info.episodeId)}`);
      return extractChatRoomMeta(json?.data);
    }

    async fetchChatProfileName(info) {
      return (await this.fetchChatRoomMeta(info)).profileName;
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

    // DOM fallback for the room title: only links that point at exactly this room
    // (/stories/{storyId}/episodes/{episodeId}, e.g. the chat-list entry for the open room) are trusted —
    // never page-wide headings or CSS classes. Uses the link's title/aria-label, else its first text line.
    readChatRoomTitle(info) {
      const path = `/stories/${info.storyId}/episodes/${info.episodeId}`;
      const ids = [info.storyId, info.episodeId];
      for (const link of document.querySelectorAll('a[href]')) {
        let pathname = '';
        try { pathname = new URL(link.getAttribute('href'), location.origin).pathname.replace(/\/$/, ''); } catch (_) { continue; }
        if (pathname !== path || link.closest('#rp-fanverse-host')) continue;
        // Text nodes, not innerText: innerText of a collapsed/hidden list glues title and preview together.
        const texts = [];
        const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) texts.push(walker.currentNode.nodeValue);
        const candidates = [link.getAttribute('title'), link.getAttribute('aria-label'), ...texts];
        const title = candidates.find((value) => isValidChatTitle(value, ids));
        if (title) return { title: title.trim(), source: 'dom:room-link' };
      }
      return null;
    }

    // DOM fallback for the room thumbnail: the image inside a link to exactly this room (Crack's chat
    // list entry), never a page-wide image or a CSS class. srcset/Next.js image URLs are unwrapped.
    readChatRoomCover(info) {
      const path = `/stories/${info.storyId}/episodes/${info.episodeId}`;
      for (const link of document.querySelectorAll('a[href]')) {
        let pathname = '';
        try { pathname = new URL(link.getAttribute('href'), location.origin).pathname.replace(/\/$/, ''); } catch (_) { continue; }
        if (pathname !== path || link.closest('#rp-fanverse-host')) continue;
        for (const img of link.querySelectorAll('img')) {
          const raw = img.currentSrc || img.getAttribute('src') || (img.getAttribute('srcset') || '').split(/\s+/)[0];
          const url = raw && unwrapImageSource(raw, location.origin);
          if (url) return { url, source: 'dom:room-link' };
        }
      }
      return null;
    }
  }

  // Builds the internal task prompt (the user prompt of each call). The user's common Gemini
  // instruction is not mixed in here; it is sent separately as systemInstruction by GeminiClient.
  const PromptLibrary = {
    render(id, values) { return renderPromptTemplate(id, values); },
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
  // ---------- generation clients ----------
  // GenerationClient interface (all three providers): generateJson(prompt, schema, options),
  // generateText(prompt, options), generateTextStream(prompt, options), testConnection(), ready().
  // `options.systemInstruction` carries the user's common Gemini instruction. FanverseEngine only
  // talks to the GeminiClient facade at the end of this section.

  function isRetryableStatus(status) {
    return !status || status === 429 || status >= 500;
  }

  // Shared REST client for the Gemini Developer API and Vertex AI (same request/response shape).
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

    payload(prompt, generationConfig, systemInstruction) {
      return {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      };
    }

    async generateJson(prompt, schema, { retries = 1, temperature = 0.5, systemInstruction = null } = {}) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const text = await this.request(this.payload(attempt ? `${prompt}\n\nPrevious output failed validation. Return complete valid JSON only.` : prompt, buildJsonGenerationConfig(schema, temperature), systemInstruction));
          const parsed = Utils.parseJson(text);
          if (!parsed || typeof parsed !== 'object') throw new Error('Structured response is not an object');
          Utils.validateSchema(parsed, schema);
          return parsed;
        } catch (error) {
          lastError = error;
          if (!isRetryableStatus(error.status)) break; // auth/config errors won't fix themselves
        }
      }
      throw lastError;
    }

    async generateText(prompt, { stream = false, onChunk = null, temperature = 0.85, systemInstruction = null } = {}) {
      return this.request(this.payload(prompt, { temperature }, systemInstruction), { stream, onChunk });
    }

    generateTextStream(prompt, options = {}) { return this.generateText(prompt, { ...options, stream: true }); }

    async testConnection() {
      const text = await this.request(this.payload('Reply with exactly OK.', { temperature: 0 }, null));
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

    // Called from the "Google 로그인" click: GIS is lazy-loaded here, then opens its consent popup
    // from requestAccessToken(). If loading took long enough for the click's user activation to
    // lapse, the browser may block the popup; the library is cached by then, so a second click works.
    async authorize() {
      const settings = this.getSettings();
      if (!settings.vertexOAuthClientId) throw new Error('Vertex OAuth Client ID가 없습니다. 연결 설정에 OAuth Client ID를 먼저 입력하세요.');
      const loadStarted = Date.now();
      let oauth;
      try {
        oauth = await loadGoogleIdentityServices();
      } catch (error) {
        throw new Error(`${error.message}. 잠시 후 다시 시도하거나 Advanced의 수동 access token을 사용하세요.`);
      }
      const slowLoad = Date.now() - loadStarted > 3000;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Google OAuth window timed out or was closed')), 180000);
        const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
        const onToken = settle(async (response) => {
          if (response?.error || !response?.access_token) { reject(new Error(response?.error_description || response?.error || 'Google OAuth returned no access token')); return; }
          if (typeof oauth.hasGrantedAllScopes === 'function' && !oauth.hasGrantedAllScopes(response, VERTEX_SCOPE)) { reject(new Error('cloud-platform scope가 승인되지 않았습니다. 동의 화면에서 권한을 허용하세요.')); return; }
          resolve(await this.setToken(response.access_token, response.expires_in, 'oauth'));
        });
        const onError = settle((error) => reject(new Error(error?.type === 'popup_closed' ? 'Google 로그인 창이 닫혔습니다.' : error?.type === 'popup_failed_to_open' ? (slowLoad ? '라이브러리 로딩이 끝났습니다. "Google 로그인"을 한 번 더 눌러 주세요.' : '팝업이 차단되었습니다. 이 사이트의 팝업을 허용하세요.') : error?.message || error?.type || 'Google OAuth popup failed')));
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
      const oauth = googleOAuth(); // never loads GIS just to log out
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

  // Firebase AI (firebase/ai, AgentPlatformBackend) with the Firebase Web config the user saved in
  // Settings (settings.firebaseConfig). Nothing is initialised until this provider is actually used
  // — a generation request or "연결 테스트" — and only after the config validates. The SDK is bundled
  // into this file (createFirebaseSdk at the end). Failures stay in `state` and only affect AI calls.
  class FirebaseAIClient {
    constructor(getSettings) {
      this.getSettings = getSettings;
      this.instance = null;
      this.instanceKey = '';
      this.state = { phase: 'idle', error: null, appCheck: 'off', appCheckError: null, appCheckAt: null, lastTest: null };
    }

    configCheck() { return validateFirebaseConfig(this.getSettings().firebaseConfig); }

    configKey(settings) {
      return JSON.stringify([normalizeFirebaseConfig(settings.firebaseConfig), settings.firebaseLocation, settings.appCheckMode, settings.appCheckSiteKey, settings.appCheckDebugToken]);
    }

    async appCheckToken(config, settings) {
      try {
        let result;
        if (settings.appCheckMode === 'recaptcha-enterprise') {
          if (!settings.appCheckSiteKey) throw new Error('reCAPTCHA Enterprise site key가 없습니다');
          result = await exchangeAppCheckToken(config, 'exchangeRecaptchaEnterpriseToken', { recaptcha_enterprise_token: await recaptchaEnterpriseToken(settings.appCheckSiteKey) });
        } else {
          if (!settings.appCheckDebugToken) throw new Error('App Check 디버그 토큰이 없습니다');
          result = await exchangeAppCheckToken(config, 'exchangeDebugToken', { debug_token: settings.appCheckDebugToken });
        }
        this.state.appCheck = 'ok'; this.state.appCheckError = null; this.state.appCheckAt = Date.now();
        return result;
      } catch (error) {
        this.state.appCheck = 'error'; this.state.appCheckError = error.message;
        throw error;
      }
    }

    // Lazily initialises (or re-initialises after a config change) Firebase app, App Check and AI.
    ensure() {
      const settings = this.getSettings();
      const check = validateFirebaseConfig(settings.firebaseConfig);
      if (!check.ok) {
        throw Object.assign(new Error(check.empty ? 'Firebase Web Config가 설정되지 않았습니다. Settings > AI > 연결 설정에서 입력하세요.' : `Firebase Web Config에 ${check.missingRequired.join(', ')} 값이 없습니다.`), { status: 'config' });
      }
      const key = this.configKey(settings);
      if (this.instance && this.instanceKey === key) return this.instance;
      try {
        const sdk = getFirebaseSdk();
        const config = check.config;
        // A named app per configuration: no clash with any Firebase app the host page may run, and a
        // changed config gets a fresh app instead of a duplicate-app error.
        const app = sdk.initializeApp(config, `rp-fanverse-${Utils.hash(key)}`);
        this.state.appCheck = 'off'; this.state.appCheckError = null;
        if (settings.appCheckMode !== 'off') {
          try {
            sdk.initializeAppCheck(app, { provider: new sdk.CustomProvider({ getToken: () => this.appCheckToken(config, this.getSettings()) }), isTokenAutoRefreshEnabled: true });
            this.state.appCheck = 'pending';
          } catch (error) {
            if (!/already-initialized/.test(error?.code || error?.message || '')) throw error;
          }
        }
        const ai = sdk.getAI(app, { backend: new sdk.AgentPlatformBackend(settings.firebaseLocation || 'global') });
        this.instance = { sdk, app, ai, config };
        this.instanceKey = key;
        this.state.phase = 'ready'; this.state.error = null;
        return this.instance;
      } catch (error) {
        this.instance = null;
        this.state.phase = 'error'; this.state.error = error?.message || String(error);
        throw new Error(`Firebase 초기화 실패: ${this.state.error}`);
      }
    }

    ready() { return this.configCheck().ok && this.state.phase !== 'error'; }

    model(generationConfig, systemInstruction) {
      const { sdk, ai } = this.ensure();
      return sdk.getGenerativeModel(ai, {
        model: resolveModelId(this.getSettings()),
        generationConfig,
        ...(systemInstruction ? { systemInstruction } : {}),
      }, { timeout: 300000 });
    }

    describeError(error) {
      const status = error?.customErrorData?.status || error?.status;
      // The SDK prefixes server errors with "Error fetching from <url>: [403 Forbidden]"; keep the server message.
      const raw = String(error?.message || error).replace(/^AI: /, '').replace(/^Error fetching from \S+:\s+(\[[^\]]*\]\s*)?/, '').replace(/\s*\(AI\/[\w-]+\)\.?$/, '');
      let hint = '';
      if (!status && /Failed to fetch|network error|timeout/i.test(raw)) hint = '네트워크 연결을 확인하세요. Tampermonkey가 googleapis.com 도메인 접근 허용을 물으면 “항상 허용”을 선택하세요.';
      else if (/App Check/i.test(raw)) hint = '이 모델/프로젝트는 Firebase App Check가 필요합니다. 연결 설정의 App Check를 설정하고 Firebase 콘솔에서 Firebase AI Logic의 App Check enforcement를 켜세요.';
      else if (error?.code === 'api-not-enabled' || /SERVICE_DISABLED|firebasevertexai.googleapis.com\W+to be enabled/i.test(raw)) hint = 'Firebase 콘솔의 AI Logic에서 Agent Platform Gemini API 설정(Get started)을 완료하세요.';
      else if (status === 429) hint = '요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.';
      else if (status === 404) hint = 'model ID 또는 location을 확인하세요.';
      else if ((status === 400 || status === 403) && /API key/i.test(raw)) hint = 'Firebase Web Config의 apiKey와 API key 제한(허용 API·HTTP referrer)을 확인하세요.';
      const message = `Firebase AI${status ? ` HTTP ${status}` : ''}: ${raw.slice(0, 400)}${hint ? `\n→ ${hint}` : ''}`;
      return Object.assign(new Error(message), { status });
    }

    responseText(response) {
      try { return response.text(); } catch (error) { throw new Error(`응답에 텍스트가 없습니다: ${error.message}`); }
    }

    async generateJson(prompt, schema, { retries = 1, temperature = 0.5, systemInstruction = null } = {}) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const model = this.model(buildJsonGenerationConfig(schema, temperature), systemInstruction);
          let result;
          try { result = await model.generateContent(attempt ? `${prompt}\n\nPrevious output failed validation. Return complete valid JSON only.` : prompt); } catch (error) { throw this.describeError(error); }
          const parsed = Utils.parseJson(this.responseText(result.response));
          if (!parsed || typeof parsed !== 'object') throw new Error('Structured response is not an object');
          Utils.validateSchema(parsed, schema);
          return parsed;
        } catch (error) {
          lastError = error;
          if (error.status === 'config' || !isRetryableStatus(error.status) || /Firebase 초기화 실패/.test(error.message)) break;
        }
      }
      throw lastError;
    }

    async generateText(prompt, { stream = false, onChunk = null, temperature = 0.85, systemInstruction = null } = {}) {
      const model = this.model({ temperature }, systemInstruction);
      try {
        if (!stream) return this.responseText((await model.generateContent(prompt)).response);
        const result = await model.generateContentStream(prompt);
        let accumulated = '';
        for await (const chunk of result.stream) {
          let text = '';
          try { text = chunk.text(); } catch (_) { /* chunk without text (e.g. thought-only) */ }
          if (text) { accumulated += text; onChunk?.(accumulated); }
        }
        if (!accumulated) accumulated = this.responseText(await result.response);
        return accumulated;
      } catch (error) {
        throw error?.customErrorData || /^AI: /.test(error?.message || '') ? this.describeError(error) : error;
      }
    }

    generateTextStream(prompt, options = {}) { return this.generateText(prompt, { ...options, stream: true }); }

    async testConnection() {
      const model = resolveModelId(this.getSettings());
      try {
        const text = (await this.generateText('Reply with exactly OK.', { temperature: 0 })).trim().slice(0, 40);
        this.state.lastTest = { ok: true, at: Date.now(), model, message: text };
        return text;
      } catch (error) {
        this.state.lastTest = { ok: false, at: Date.now(), model, message: error.message };
        throw error;
      }
    }

    status() {
      const settings = this.getSettings();
      const check = validateFirebaseConfig(settings.firebaseConfig);
      return { ...this.state, configured: check.ok, empty: check.empty, missingRequired: check.missingRequired, missingRecommended: check.missingRecommended, projectId: check.config.projectId, location: settings.firebaseLocation, appCheckMode: settings.appCheckMode };
    }
  }

  // Provider-neutral facade used by FanverseEngine and the UI. It adds the user's common Gemini
  // instruction as systemInstruction to every call except those made with `useInstruction: false`
  // (the mechanical continuity check).
  class GeminiClient {
    constructor(getSettings) {
      this.getSettings = getSettings;
      this.developer = new GeminiDeveloperClient(getSettings);
      this.vertex = new VertexGeminiClient(getSettings);
      this.firebase = new FirebaseAIClient(getSettings);
    }

    client(provider = this.getSettings().provider) { return provider === 'vertex' ? this.vertex : provider === 'firebase' ? this.firebase : this.developer; }
    providerReady() { return this.client().ready(); }
    systemInstruction(useInstruction = true) { return useInstruction === false ? null : buildSystemInstruction(this.getSettings().globalGeminiInstruction); }
    generateJson(prompt, schema, options = {}) { return this.client().generateJson(prompt, schema, { ...options, systemInstruction: this.systemInstruction(options.useInstruction) }); }
    generateText(prompt, options = {}) { return this.client().generateText(prompt, { ...options, systemInstruction: this.systemInstruction(options.useInstruction) }); }
    generateTextStream(prompt, options = {}) { return this.generateText(prompt, { ...options, stream: true }); }
    testConnection(provider) { return this.client(provider).testConnection(); }
    authorizeVertex() { return this.vertex.authorize(); }
    useManualVertexToken(token) { return this.vertex.useManualToken(token); }
    revokeVertex() { return this.vertex.revoke(); }
    vertexStatus() { return this.vertex.status(); }
    clearVertexToken() { return this.vertex.clearAccessToken(); }
    firebaseStatus() { return this.firebase.status(); }
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

  // ---------- world-scoped async operations (0.12.8) ----------
  // FanverseEngine is one object whose `world`/`worldInfo` are replaced when the user opens another
  // room, while syncs and Gemini calls for the previous room may still be awaiting. Each async world
  // operation therefore captures its world when it starts (worldId, storyId, episodeId, the attach
  // generation and the world object) and runs on a scoped view of the engine in which `world`,
  // `worldInfo`, `db` and `notify` are bound to that capture. Every write through the scoped db first
  // checks that the capture is still the attached world (else StaleWorldError: the result is dropped)
  // and that each row belongs to the captured world (else the write is refused and logged).
  class StaleWorldError extends Error {
    constructor(context, detail = '') {
      super(`Fanverse operation for ${context?.worldId || 'an earlier room'} is stale${detail ? ` (${detail})` : ''}`);
      this.name = 'StaleWorldError'; this.stale = true; this.worldId = context?.worldId || null;
    }
  }
  const isStaleWorldError = (error) => Boolean(error && (error.stale === true || error.name === 'StaleWorldError'));

  // Turns processed per sync call at most; a longer backlog continues on the next poll.
  const MAX_TURN_UPDATES_PER_SYNC = 3;
  // A first sync with more turns than this asks for a history import instead of per-turn updates
  // (the 0.12.7 threshold was turnsPerUpdate × 2 with the old default 5).
  const IMPORT_PROMPT_TURNS = 10;
  const SHIP_HISTORY_LIMIT = 300;
  const SHIP_HISTORY_TAGS = 40;

  function scopedDatabase(db, engine, context) {
    const owner = (storeName, row) => (storeName === STORES.worlds ? row?.id : row?.worldId);
    const assertWritable = (storeName, rows, action) => {
      if (!engine.isCurrentWorld(context)) throw new StaleWorldError(context, `${action} ${storeName}`);
      for (const row of rows) {
        const rowWorld = owner(storeName, row);
        if (rowWorld !== context.worldId) {
          console.error('[RP Fanverse] refused cross-world write', { store: storeName, action, expectedWorldId: context.worldId, rowWorldId: rowWorld ?? null });
          throw new Error(`다른 방의 ${storeName} 기록 저장을 거부했습니다 (Fanverse world 불일치).`);
        }
      }
    };
    // Store keys are global, so a row whose key already belongs to another room would replace it.
    // Message keys contain the worldId; every other world-scoped store is checked row by row.
    const assertNoForeignKey = async (storeName, rows, action) => {
      assertWritable(storeName, rows, action);
      if (storeName === STORES.worlds || storeName === STORES.messages) return;
      for (const row of rows) {
        const existing = await db.get(storeName, row.id);
        if (existing && existing.worldId !== context.worldId) {
          console.error('[RP Fanverse] refused overwrite of another room\'s row', { store: storeName, action, key: row.id, expectedWorldId: context.worldId, existingWorldId: existing.worldId ?? null });
          throw new Error(`다른 방의 ${storeName} 기록을 덮어쓰지 않았습니다 (Fanverse key 충돌).`);
        }
      }
      assertWritable(storeName, rows, action); // the reads above awaited: check the room again
    };
    const assertWorldId = (worldId, action) => {
      if (worldId === context.worldId) return;
      console.error('[RP Fanverse] refused cross-world access', { action, expectedWorldId: context.worldId, worldId });
      throw new Error('다른 방의 Fanverse 데이터 접근을 거부했습니다.');
    };
    return {
      open: () => db.open(),
      get: (storeName, key) => db.get(storeName, key),
      getAll: (storeName) => db.getAll(storeName),
      async getAllByWorld(storeName, worldId) { assertWorldId(worldId, `read ${storeName}`); return db.getAllByWorld(storeName, worldId); },
      async put(storeName, value) { await assertNoForeignKey(storeName, [value], 'put'); return db.put(storeName, value); },
      async bulkPut(storeName, values) { await assertNoForeignKey(storeName, values || [], 'bulkPut'); return db.bulkPut(storeName, values); },
      async deleteWhereWorld(storeName, worldId, predicate) { assertWorldId(worldId, `delete ${storeName}`); assertWritable(storeName, [], 'delete'); return db.deleteWhereWorld(storeName, worldId, predicate); },
      async deleteWorld(worldId, options) { assertWorldId(worldId, 'delete world'); assertWritable(STORES.worlds, [], 'delete world'); return db.deleteWorld(worldId, options); },
    };
  }

  // Rollback without replacing the object, so the attached world keeps its identity.
  function restoreWorldInPlace(target, snapshot) {
    for (const key of Object.keys(target)) if (!(key in snapshot)) delete target[key];
    Object.assign(target, snapshot);
  }

  class FanverseEngine {
    constructor(db, api, dom, gemini, getSettings, notify) {
      this.db = db; this.api = api; this.dom = dom; this.gemini = gemini;
      this.getSettings = getSettings; this.notify = notify;
      this.worldInfo = null; this.world = null;
      this.generation = 0; // bumped by attach(): operations captured before it are stale
      this.locks = { sync: new Map(), update: new Map() }; // worldId -> { generation }
      this.checkedAt = { title: new Map(), meta: new Map() }; // worldId -> last check (ms)
      this.onFanContent = null; // (summary) => void · only for the attached world
    }

    // True while the attached world has a sync of the current attach running. A sync left over from an
    // earlier visit does not count (and does not block a new one).
    get syncing() { const root = this.__engine || this; const holder = this.world && root.locks.sync.get(this.world.id); return Boolean(holder && holder.generation === root.generation); }
    // True while any fandom update for this world runs (including one being dropped as stale).
    get updating() { const root = this.__engine || this; return Boolean(this.world && root.locks.update.get(this.world.id)); }

    captureWorld() {
      if (!this.world || !this.worldInfo || this.world.id !== this.worldInfo.id) return null;
      return Object.freeze({ worldId: this.world.id, storyId: this.worldInfo.storyId, episodeId: this.worldInfo.episodeId, generation: this.generation, world: this.world, info: this.worldInfo, produced: { reddit: 0, pixiv: 0, trends: 0 } });
    }

    isCurrentWorld(context) {
      const root = this.__engine || this;
      return Boolean(context) && context.generation === root.generation && root.world === context.world && root.worldInfo === context.info && root.world?.id === context.worldId;
    }

    scoped(context) {
      const view = Object.create(this);
      Object.defineProperties(view, {
        __engine: { value: this }, __context: { value: context },
        world: { value: context.world }, worldInfo: { value: context.info },
        db: { value: scopedDatabase(this.db, this, context) },
        notify: { value: (kind, message) => { if (this.isCurrentWorld(context)) this.notify(kind, message); } },
      });
      return view;
    }

    // Runs task(view) for the attached world. Nested calls reuse the caller's capture. A stale
    // operation resolves to null (its result is not applied); other errors propagate.
    async inWorld(name, task) {
      if (this.__context) return task(this);
      const context = this.captureWorld();
      if (!context) return null;
      try {
        return await task(this.scoped(context));
      } catch (error) {
        if (!isStaleWorldError(error)) throw error;
        console.info(`[RP Fanverse] ${name}: result for ${context.worldId} discarded (room changed)`);
        return null;
      }
    }

    acquire(kind, context) {
      const root = this.__engine || this;
      const holder = root.locks[kind].get(context.worldId);
      // A sync from an earlier attach no longer blocks; an update of this world always finishes (or is dropped) first.
      if (holder && (kind === 'update' || holder.generation === root.generation)) return null;
      const token = { generation: context.generation };
      root.locks[kind].set(context.worldId, token);
      return token;
    }

    release(kind, context, token) {
      const root = this.__engine || this;
      if (root.locks[kind].get(context.worldId) === token) root.locks[kind].delete(context.worldId);
    }

    // Unread markers of the attached world (opening Reddit/Pixiv/CP Trends clears its own one only).
    clearUnread(kind) {
      const badges = this.world?.badges;
      if (!badges || !badges[kind]) return false;
      badges[kind] = 0;
      badges.phone = (badges.reddit || 0) + (badges.pixiv || 0);
      this.saveWorld().catch((error) => console.warn('[RP Fanverse] unread state not saved', error));
      return true;
    }

    announceFanContent(context, before) {
      const root = this.__engine || this;
      const summary = { reddit: context.produced.reddit - before.reddit, pixiv: context.produced.pixiv - before.pixiv, trends: context.produced.trends - before.trends };
      if (!summary.reddit && !summary.pixiv && !summary.trends) return;
      if (!root.isCurrentWorld(context)) return; // stale: never touch the current room's UI
      try { root.onFanContent?.({ ...summary, worldId: context.worldId }); } catch (error) { console.warn('[RP Fanverse] fan content refresh failed', error); }
    }

    async attach(info) {
      const generation = ++this.generation; // every operation captured before this point is now stale
      const world = await this.db.get(STORES.worlds, info.id) || createWorld(info);
      if (generation !== this.generation) return this.world; // a newer attach() superseded this one
      world.canonRevision = Number(world.canonRevision) || 1;
      world.fandom ||= { interpretations: [], ships: [], tags: [], history: [] };
      world.fandom.recentPlatformSignals ||= [];
      world.fandom.history ||= [];
      world.fandom.shipHistory ||= [];
      world.badges ||= { phone: 0, reddit: 0, pixiv: 0 };
      world.badges.trends ||= 0;
      // Worlds saved before 0.12.5 have no chatTitle; it is filled in by the next refreshChatTitle().
      if (world.chatTitle === undefined) world.chatTitle = null;
      this.worldInfo = info; this.world = world;
      this.checkedAt.title.delete(info.id);
      this.checkedAt.meta.delete(info.id);
      await this.db.put(STORES.worlds, world);
      return world;
    }

    // Reads the open room's title from Crack (API first, then the room-link DOM fallback) and stores it
    // as world.chatTitle when it is new or changed. Never throws: a missing title must not affect sync.
    refreshChatTitle(options = {}) { return this.inWorld('chat title', (engine) => engine.refreshChatTitleInWorld(options)); }

    async refreshChatTitleInWorld({ force = false } = {}) {
      if (!this.world || !this.worldInfo) return false;
      const checked = (this.__engine || this).checkedAt.title;
      if (!force && this.world.chatTitle && Date.now() - (checked.get(this.world.id) || 0) < 5 * 60 * 1000) return false;
      checked.set(this.world.id, Date.now());
      let found = null;
      try { found = await this.api.fetchChatRoomTitle(this.worldInfo); } catch (error) { console.warn('[RP Fanverse] chat title via API unavailable:', error.message); }
      if (!found) {
        try { found = this.dom.readChatRoomTitle(this.worldInfo); } catch (error) { console.warn('[RP Fanverse] chat title via DOM unavailable:', error.message); }
      }
      if (!found || (found.title === this.world.chatTitle && found.source === this.world.chatTitleSource)) return false;
      this.world.chatTitle = found.title;
      this.world.chatTitleSource = found.source;
      this.world.chatTitleUpdatedAt = new Date().toISOString();
      await this.saveWorld();
      return true;
    }

    // Books metadata of the open room, from the same Crack room object as the title: world.chatCover
    // ({ url, source, updatedAt }), world.storyName, world.storyDescription. API first, then the
    // room-link image in the DOM. Throttled; never throws (Books then shows a neutral placeholder).
    refreshRoomMeta(options = {}) { return this.inWorld('room meta', (engine) => engine.refreshRoomMetaInWorld(options)); }

    async refreshRoomMetaInWorld({ force = false } = {}) {
      if (!this.world || !this.worldInfo) return false;
      const checked = (this.__engine || this).checkedAt.meta;
      if (!force && checked.get(this.world.id) && Date.now() - checked.get(this.world.id) < 5 * 60 * 1000) return false;
      checked.set(this.world.id, Date.now());
      let meta = null;
      try { meta = await this.api.fetchChatRoomMeta(this.worldInfo); } catch (error) { console.warn('[RP Fanverse] room metadata via API unavailable:', error.message); }
      let cover = meta?.cover || null;
      if (!cover) { try { cover = this.dom.readChatRoomCover(this.worldInfo); } catch (error) { console.warn('[RP Fanverse] room thumbnail via DOM unavailable:', error.message); } }
      let changed = false;
      if (cover && (cover.url !== this.world.chatCover?.url || cover.source !== this.world.chatCover?.source)) {
        this.world.chatCover = { url: cover.url, source: cover.source, updatedAt: new Date().toISOString() };
        changed = true;
      }
      for (const [key, value] of [['storyName', meta?.storyName], ['storyDescription', meta?.description]]) {
        if (value && value !== this.world[key]) { this.world[key] = value; changed = true; }
      }
      if (changed) await this.saveWorld();
      return changed;
    }

    async saveWorld() {
      this.world.updatedAt = new Date().toISOString();
      await this.db.put(STORES.worlds, this.world);
    }

    // ---------- fan-facing references ----------
    // Display aliases (virtual episode "N화", scene label) for Canon events, derived from the active
    // turns. Canon events and their source IDs are read, never changed. Turn scenes are cached until
    // the active branch changes.
    async fanReferenceIndex() {
      const turns = await this.allActiveTurns();
      const key = `${this.world.id}:${this.world.canonRevision}:${turns.length}:${turns[turns.length - 1]?.id || ''}`;
      if (this.fanScenes?.key !== key) this.fanScenes = { key, scenes: turns.map(turnScene) };
      const events = await this.db.getAllByWorld(STORES.canonEvents, this.world.id);
      const index = buildFanReferenceIndex(turns, events, this.fanScenes.scenes);
      index.knownIds = new Set([...events.map((event) => event.id), ...(this.world.canon.facts || []).map((fact) => fact.id)].filter(Boolean));
      this.fanKnownIds = index.knownIds;
      return index;
    }

    // Prompt input with episodeLabel/sceneLabel/fanReferences next to the internal IDs, plus fandomTimeline.
    withFanReferences(value, index) {
      if (!index || !value || typeof value !== 'object' || Array.isArray(value)) return value;
      return { ...annotateFanReferences(value, index), fandomTimeline: index.timeline };
    }

    fanText(text) { return scrubFanText(text, this.fanKnownIds); }

    // silent: automatic/background syncs (polling, page entry). They show no progress/success toast;
    // abnormal states (DOM fallback, branch change) and errors are still reported.
    sync(options = {}) { return this.inWorld('sync', (engine) => engine.syncInWorld(options)); }

    // Runs on the scoped view: this.worldInfo/this.world are the room the sync started in, so the
    // request (episodeId) and every stored row (worldId, pk) refer to that same room.
    async syncInWorld({ full = false, onProgress = null, allowUpdate = true, silent = false } = {}) {
      const context = this.__context;
      if (!this.worldInfo) return null;
      const lock = this.acquire('sync', context);
      if (!lock) return null;
      const wasNeverSynced = this.world.sync.status === 'new';
      const previousAdapter = this.world.sync.adapter;
      if (!silent) this.notify('sync', '원작 로그 동기화 중…');
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
          this.notify('error', '재생성/삭제로 활성 원작 분기가 바뀌었습니다. Settings > Data에서 Canon rebuild가 필요합니다.');
        }
        this.world.activeMessageIds = active.map((message) => message._id);
        this.world.turnCount = turns.length;
        await this.saveWorld();
        if (this.world.sync.adapter === 'dom') {
          // Background syncs report the fallback once when it starts, not on every poll.
          if (!silent || previousAdapter !== 'dom') this.notify('error', `Crack API sync failed — DOM fallback active · ${turns.length} turns
${this.world.sync.error}`);
        } else if (!silent) {
          this.notify('sync', `API 동기화 완료 · ${turns.length} turns`);
        }
        await this.refreshChatTitle();
        if (wasNeverSynced && turns.length > Math.max(IMPORT_PROMPT_TURNS, this.getSettings().turnsPerUpdate * 2)) this.world.needsImport = true;
        await this.saveWorld();
        if (allowUpdate && !this.world.needsImport && !this.world.needsCanonRebuild) await this.maybeUpdate(turns);
        return { messages: active, turns };
      } finally {
        this.release('sync', context, lock);
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

    maybeUpdate(turns = null) { return this.inWorld('auto update', (engine) => engine.maybeUpdateInWorld(turns)); }

    // Each completed turn gets its own update (turnsPerUpdate, default 1), oldest first. A backlog is
    // worked off MAX_TURN_UPDATES_PER_SYNC updates per call; the next sync continues it.
    async maybeUpdateInWorld(turns = null) {
      const settings = this.getSettings();
      if (!settings.autoUpdate || this.updating) return;
      const root = this.__engine || this;
      const activeTurns = turns || await this.allActiveTurns();
      for (let round = 0; round < MAX_TURN_UPDATES_PER_SYNC; round += 1) {
        const processed = new Set(this.world.processedTurnIds);
        const unprocessed = activeTurns.filter((turn) => !processed.has(turn.id));
        if (unprocessed.length < settings.turnsPerUpdate) return;
        if (!this.gemini.providerReady()) {
          // Turns are kept unprocessed, so the update simply runs once the provider is usable again.
          if (!root.warnedProviderUnready) {
            root.warnedProviderUnready = true;
            const reason = { developer: 'Gemini Developer API key가 없어', vertex: 'Vertex access token이 없거나 만료되어', firebase: 'Firebase AI 설정이 없거나 초기화에 실패해' }[settings.provider] || 'AI 연결을 사용할 수 없어';
            this.notify('error', `${reason} 자동 갱신을 보류했습니다. Settings > AI에서 확인하세요.`);
          }
          return;
        }
        root.warnedProviderUnready = false;
        const done = await this.runFandomUpdate(unprocessed.slice(0, settings.turnsPerUpdate));
        if (done !== true) return;
      }
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
      const events = (result.newCanonEvents || []).map((event) => ({ ...event, id: `canon_${Utils.hash(`${this.world.id}:${event.title}:${event.sourceTurnIds?.join(',')}`)}`, worldId: this.world.id, turn: currentTurn, createdAt: new Date().toISOString() }));
      await this.db.bulkPut(STORES.canonEvents, events);
      this.world.canon.recentEventIds = [...this.world.canon.recentEventIds, ...events.map((event) => event.id)].slice(-80);
      return events;
    }

    async evolveFandom(canonUpdate, canonEvents, currentTurn) {
      const fan = await this.fanReferenceIndex().catch(() => null);
      const fandomResult = await this.gemini.generateJson(PromptLibrary.fandomUpdate({
        canonUpdate: this.withFanReferences({ ...canonUpdate, newCanonEvents: canonEvents }, fan), fandom: this.fandomSnapshot(),
        currentTurn, activity: this.getSettings().activity,
      }), Schemas.fandom, { retries: 1, temperature: 0.65 });
      const interpretations = (fandomResult.interpretations || []).map((item) => ({ ...item, id: Utils.uid('interpretation'), addedTurn: currentTurn }));
      this.world.fandom.interpretations.push(...interpretations);
      const shipsBefore = new Map(this.world.fandom.ships.map((ship) => [ship.tag, Number(ship.momentum) || 0]));
      this.world.fandom.ships = this.mergeMomentum(this.world.fandom.ships, fandomResult.shipDeltas, currentTurn);
      if (this.recordShipHistory(shipsBefore, fandomResult.shipDeltas, currentTurn, fan)) {
        this.world.badges.trends = (Number(this.world.badges.trends) || 0) + 1;
        if (this.__context) this.__context.produced.trends += 1;
      }
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
      // A new RP turn always gets fresh Reddit and Pixiv content: when nothing (this update's events or
      // older delayed ones) is due for a platform now, one immediate event for that platform is added.
      // Its id is fixed per world/revision/platform/turn, so a retried turn never doubles it.
      if (!canonUpdate?.backfill) {
        const merged = new Map(existingPending);
        for (const event of pending) merged.set(event.id, merged.get(event.id) || event);
        const due = planPendingExecution([...merged.values()], currentTurn, this.world.canonRevision);
        for (const kind of ['reddit', 'pixiv']) {
          if (due[kind].length) continue;
          const immediate = this.immediateTurnEvent(kind, currentTurn, fandomResult.reactionPoints, canonEvents);
          if (!existingPending.has(immediate.id) && !pending.some((event) => event.id === immediate.id)) pending.push(immediate);
        }
      }
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

    // Same shape as a Gemini pendingEvent, due now, from this turn's reaction points (or its new scenes).
    immediateTurnEvent(kind, currentTurn, reactionPoints = [], canonEvents = []) {
      const points = (reactionPoints || []).slice().sort((a, b) => (Number(b.heat) || 0) - (Number(a.heat) || 0));
      const sourceCanonEventIds = [...new Set([...points.flatMap((point) => point.sourceCanonEventIds || []), ...canonEvents.map((event) => event.id)])].filter(Boolean).slice(0, 12);
      const summary = points.slice(0, 3).map((point) => point.summary).filter(Boolean).join(' / ')
        || canonEvents.map((event) => event.title || event.summary).filter(Boolean).slice(0, 3).join(' / ')
        || '이번 RP 장면';
      return {
        kind, dueTurn: currentTurn, expiryTurn: currentTurn + 20, payload: `즉각 반응: ${summary}`, sourceCanonEventIds,
        id: `pending_${Utils.hash(`${this.world.id}:${this.world.canonRevision}:immediate:${kind}:${currentTurn}`)}`,
        worldId: this.world.id, createdTurn: currentTurn, branchRevision: this.world.canonRevision, status: 'pending', generated: false,
        generatedPlatforms: { reddit: false, pixiv: false }, immediate: true,
      };
    }

    // One CP Trends point per fandom update: the merged momentum of the tracked ships plus this
    // update's shipDeltas (value, reason, fan-facing scene). Only Gemini's existing output is stored.
    // Returns true when a ship's momentum actually changed.
    recordShipHistory(before, deltas, currentTurn, fan) {
      const history = (this.world.fandom.shipHistory ||= []);
      const ships = {}; const details = {}; const deltaMap = {};
      for (const ship of this.world.fandom.ships.slice(0, SHIP_HISTORY_TAGS)) ships[ship.tag] = Number(ship.momentum) || 0;
      let changed = false;
      for (const delta of deltas || []) {
        if (!delta?.tag) continue;
        const after = Number(this.world.fandom.ships.find((ship) => ship.tag === delta.tag)?.momentum) || 0;
        const ref = (delta.sourceCanonEventIds || []).map((id) => fan?.byEvent?.get(id)).find(Boolean);
        ships[delta.tag] = after;
        deltaMap[delta.tag] = Number(delta.momentumDelta) || 0;
        details[delta.tag] = { change: after - (before.get(delta.tag) || 0), reason: this.fanText(String(delta.reason || '')).slice(0, 240), sceneLabel: ref?.sceneLabel || null, sceneEpisodeLabel: ref?.episodeLabel || null };
        if (after !== (before.get(delta.tag) || 0)) changed = true;
      }
      history.push({ turn: currentTurn, episodeLabel: fan?.episodeLabelForTurnCount?.(currentTurn) || null, at: new Date().toISOString(), ships, deltas: deltaMap, details });
      if (history.length > SHIP_HISTORY_LIMIT) history.splice(0, history.length - SHIP_HISTORY_LIMIT);
      return changed;
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
          if (isStaleWorldError(error)) throw error;
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
          if (isStaleWorldError(error)) throw error;
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

    runFandomUpdate(turns) { return this.inWorld('fandom update', (engine) => engine.runFandomUpdateInWorld(turns)); }

    // Resolves true when the update was applied, false when another update of this world is running.
    async runFandomUpdateInWorld(turns) {
      const context = this.__context;
      const active = new Set(this.world.activeMessageIds || []);
      if (!turns?.length || turns.some((turn) => !active.has(turn.userMessageId) || !active.has(turn.assistantMessageId))) throw new StaleWorldError(context, 'turns are not part of this room');
      const lock = this.acquire('update', context);
      if (!lock) return false;
      const currentTurn = this.world.lastProcessedTurn + turns.length;
      const worldBeforeUpdate = Utils.clone(this.world);
      const producedBefore = { ...context.produced };
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
        this.announceFanContent(context, producedBefore);
        return true;
      } catch (error) {
        // Rows of this turn are removed from the room the update started in (context.worldId), never
        // from whichever room is attached now. A stale update uses the raw store for that; the update
        // lock of that room is still held, so no newer update of it can be affected.
        const rollbackDb = isStaleWorldError(error) ? (this.__engine || this).db : this.db;
        try {
          await Promise.all([
            rollbackDb.deleteWhereWorld(STORES.canonEvents, context.worldId, (row) => row.turn === currentTurn),
            rollbackDb.deleteWhereWorld(STORES.redditPosts, context.worldId, (row) => row.turn === currentTurn),
            rollbackDb.deleteWhereWorld(STORES.pixivWorks, context.worldId, (row) => row.turn === currentTurn),
            rollbackDb.deleteWhereWorld(STORES.pendingEvents, context.worldId, (row) => row.createdTurn === currentTurn),
          ]);
          if (!isStaleWorldError(error)) {
            restoreWorldInPlace(this.world, worldBeforeUpdate);
            await this.saveWorld();
          }
        } catch (rollbackError) {
          if (!isStaleWorldError(rollbackError)) console.warn('[RP Fanverse] update rollback incomplete', rollbackError);
        }
        if (!isStaleWorldError(error)) this.notify('error', `Fanverse update failed: ${error.message}`);
        throw error;
      } finally { this.release('update', context, lock); }
    }

    activityLimit(kind) {
      const table = { Quiet: { reddit: 1, pixiv: 2 }, Normal: { reddit: 2, pixiv: 3 }, Active: { reddit: 4, pixiv: 5 }, Chaos: { reddit: 6, pixiv: 7 } };
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
        return { ...comment, body: this.fanText(comment.body), id: idMap.get(comment.id) || `comment_${Utils.hash(`${postId}:${existingComments.length + index}`)}`, parentId: mappedParent, personaId: personaIds.has(comment.personaId) ? comment.personaId : this.world.personas.reddit[0].id, createdAt: new Date(Date.now() - ((comments || []).length - index) * 47000).toISOString() };
      });
    }

    async generateReddit(reactions, currentTurn, sourcePendingEventIds = []) {
      const fan = await this.fanReferenceIndex().catch(() => null);
      const result = await this.gemini.generateJson(PromptLibrary.redditGenerator({ personas: this.world.personas.reddit, reactions: this.withFanReferences(reactions, fan), activity: this.getSettings().activity }), Schemas.reddit, { retries: 1, temperature: 0.85 });
      // Fan-visible text never carries internal IDs; sourceCanonEventIds keeps them.
      for (const post of result.posts || []) {
        post.title = this.fanText(post.title); post.body = this.fanText(post.body);
        post.continuationTopics = (post.continuationTopics || []).map((topic) => this.fanText(topic));
      }
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
      if (this.__context) this.__context.produced.reddit += posts.length;
      return posts;
    }

    loadMoreRedditComments(post) { return this.inWorld('more comments', (engine) => engine.loadMoreRedditCommentsInWorld(post)); }

    async loadMoreRedditCommentsInWorld(post) {
      if (!post?.hasMoreComments) return post;
      if (post.worldId !== this.world.id) throw new StaleWorldError(this.__context, 'post is from another room');
      const context = await this.buildCanonContext(post.sourceCanonEventIds || [], [post.title, post.body, ...(post.continuationTopics || [])]);
      const fan = await this.fanReferenceIndex().catch(() => null);
      const result = await this.gemini.generateJson(PromptLibrary.redditMoreComments({
        post: this.withFanReferences({ id: post.id, title: post.title, body: post.body, category: post.category, sourceCanonEventIds: post.sourceCanonEventIds }, fan),
        existingComments: post.comments,
        continuationTopics: post.continuationTopics || [],
        personas: this.world.personas.reddit,
        context: { canon: this.withFanReferences(context, fan), fandom: this.fandomSnapshot() },
      }), Schemas.redditComments, { retries: 1, temperature: 0.85 });
      result.continuationTopics = (result.continuationTopics || []).map((topic) => this.fanText(topic));
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
      const fan = await this.fanReferenceIndex().catch(() => null);
      const existing = await this.db.getAllByWorld(STORES.pixivWorks, this.world.id);
      // What is already on the list, so new works pick different premises, settings and moods.
      const recentPixivWorks = existing.slice().sort((a, b) => (b.publishOrder || 0) - (a.publishOrder || 0)).slice(0, 12).map((work) => ({ title: work.title, workType: work.workType, tone: work.tone, ship: work.ship, tags: (work.tags || []).slice(0, 6), length: work.fictionalCharacterCount }));
      const result = await this.gemini.generateJson(PromptLibrary.pixivMetadataGenerator({ personas: this.world.personas.pixiv, reactions: this.withFanReferences({ ...reactions, recentPixivWorks }, fan), activity: this.getSettings().activity }), Schemas.pixiv, { retries: 1, temperature: 0.95 });
      for (const work of result.works || []) {
        for (const key of ['title', 'caption', 'summary', 'seriesTitle']) work[key] = this.fanText(work[key]);
        work.tags = (work.tags || []).map((tag) => this.fanText(tag)).filter(Boolean);
      }
      const personaIds = new Set(this.world.personas.pixiv.map((persona) => persona.id));
      const eventKey = [...sourcePendingEventIds].sort().join(',');
      const existingById = new Map(existing.map((work) => [work.id, work]));
      const works = (result.works || []).slice(0, this.activityLimit('pixiv')).map((work, index) => ({
        ...work, id: `pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`, worldId: this.world.id, turn: currentTurn, publishOrder: Date.now() + index,
        createdAt: existingById.get(`pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`)?.createdAt || new Date().toISOString(),
        hasFullText: existingById.get(`pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`)?.hasFullText || false,
        userBookmarked: existingById.get(`pixiv_${Utils.hash(`${this.world.id}:${eventKey}:${index}`)}`)?.userBookmarked || false,
        sourcePendingEventIds: [...sourcePendingEventIds],
        authorId: personaIds.has(work.authorId) ? work.authorId : this.world.personas.pixiv[0].id,
        lengthPlanned: true, // fictionalCharacterCount is this work's planned length (fanworkTarget)
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
      if (this.__context) this.__context.produced.pixiv += works.length;
      return works;
    }

    // Length of one fanwork. 'custom' mode: the user's fixed length. 'auto': the length the work's own
    // metadata planned (works from 0.12.7 on; mostly short one-shots), else the default. Above 8,000
    // characters the long pipeline (outline → sections → continuity → revision) still runs.
    fanworkTarget(work, settings = this.getSettings()) {
      if (settings.fanworkLengthMode === 'custom') return settings.fanworkTargetLength;
      const planned = Number(work?.fictionalCharacterCount);
      return work?.lengthPlanned && Number.isFinite(planned) && planned > 0 ? Math.round(clampNumber(planned, 300, 30000, settings.fanworkTargetLength)) : settings.fanworkTargetLength;
    }

    generateFanwork(work, onChunk) { return this.inWorld('fanwork', (engine) => engine.generateFanworkInWorld(work, onChunk)); }

    async generateFanworkInWorld(work, onChunk) {
      if (work?.worldId !== this.world.id) throw new StaleWorldError(this.__context, 'work is from another room');
      const cached = await this.db.get(STORES.fanworks, work.id);
      if (cached) return cached;
      const settings = this.getSettings();
      const author = this.world.personas.pixiv.find((persona) => persona.id === work.authorId);
      const canonContext = await this.buildCanonContext(work.sourceCanonEventIds || [], [work.title, work.ship, work.summary, ...(work.tags || [])]);
      let text; let outline = null; let continuity = null; let initialContinuity = null; let revisionApplied = false;
      const fan = await this.fanReferenceIndex().catch(() => null);
      const input = { work: this.withFanReferences(work, fan), author, canon: this.withFanReferences(canonContext, fan), fandom: this.fandomSnapshot(), language: settings.fanworkLanguage, targetLength: this.fanworkTarget(work, settings) };
      if (input.targetLength > 8000) {
        outline = await this.gemini.generateJson(PromptLibrary.fanworkOutline(input), Schemas.outline, { retries: 1, temperature: 0.65 });
        const sections = [];
        for (let i = 0; i < outline.sections.slice(0, 3).length; i += 1) {
          const sectionPrompt = PromptLibrary.fanworkSection({ ...input, outline, sectionNumber: i + 1, sectionTotal: 3, previousText: sections.join('\n\n').slice(-12000) });
          const section = await this.gemini.generateText(sectionPrompt, { stream: settings.streaming, onChunk: (chunk) => onChunk?.([...sections, chunk].join('\n\n')) });
          sections.push(section);
        }
        text = sections.join('\n\n');
        initialContinuity = await this.gemini.generateJson(PromptLibrary.continuity({ outline, text, canon: canonContext }), Schemas.continuity, { retries: 1, temperature: 0.2, useInstruction: false });
        continuity = initialContinuity;
        if (initialContinuity.issues?.length) {
          onChunk?.(`${text}\n\n[continuity revision in progress…]`);
          text = await this.gemini.generateText(PromptLibrary.fanworkRevision({ outline, text, canon: canonContext, issues: initialContinuity.issues, continuityNotes: initialContinuity.continuityNotes, language: settings.fanworkLanguage }), { stream: false, temperature: 0.55 });
          revisionApplied = true;
          continuity = await this.gemini.generateJson(PromptLibrary.continuity({ outline, text, canon: canonContext }), Schemas.continuity, { retries: 1, temperature: 0.15, useInstruction: false });
          onChunk?.(text);
        }
      } else {
        text = await this.gemini.generateText(PromptLibrary.fanwork(input), { stream: settings.streaming, onChunk });
      }
      text = this.fanText(text);
      const record = { id: work.id, worldId: this.world.id, text, outline, continuity, initialContinuity, revisionApplied, generatedAt: new Date().toISOString(), language: settings.fanworkLanguage };
      await this.db.put(STORES.fanworks, record);
      work.hasFullText = true;
      await this.db.put(STORES.pixivWorks, work);
      return record;
    }

    importHistory(onProgress) { return this.inWorld('history import', (engine) => engine.importHistoryInWorld(onProgress)); }

    async importHistoryInWorld(onProgress) {
      if (this.world.needsCanonRebuild) throw new Error('재생성/삭제된 원작 분기가 있습니다. Canon rebuild를 먼저 실행하세요.');
      if (!this.world.importJob || this.world.importJob.mode !== 'history') this.world.importJob = { mode: 'history', status: 'fetching', nextIndex: 0, total: 0, fandomMilestone: 0 };
      await this.saveWorld();
      const synced = await this.sync({ full: true, allowUpdate: false, onProgress: (info) => onProgress?.(`원작 불러오는 중 · ${info.messages} messages`) });
      if (!synced) throw new Error('원작 로그 동기화가 이미 진행 중입니다. 잠시 후 다시 시도하세요.');
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

    rebuildCanon(onProgress) { return this.inWorld('canon rebuild', (engine) => engine.rebuildCanonInWorld(onProgress)); }

    async rebuildCanonInWorld(onProgress) {
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

  // ---------- Books: EPUB export ----------
  // Runs only when "EPUB 다운로드" is pressed (nothing here runs at startup). Pipeline: full active-branch
  // log from the Crack API (stored log as fallback) → deterministic cleaning into chapters → images
  // downloaded and embedded (each failure is skipped) → EPUB 3 package → download.
  const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

  function fetchBinary(url, timeoutMs = 30000) {
    const data = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(url);
    if (data) {
      const text = data[2] ? atob(data[3]) : decodeURIComponent(data[3]);
      return Promise.resolve({ bytes: Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff), type: data[1] || '' });
    }
    if (typeof GM_xmlhttpRequest !== 'function') {
      return fetch(url, { credentials: 'include' }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get('content-type') || '' };
      });
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: timeoutMs, anonymous: false,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300 || !response.response) return reject(new Error(`HTTP ${response.status}`));
          const type = /content-type:\s*([^;\r\n]+)/i.exec(response.responseHeaders || '')?.[1]?.trim() || '';
          resolve({ bytes: new Uint8Array(response.response), type });
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // EPUB core image types are kept; WEBP (core only since EPUB 3.3) and other decodable images (AVIF,
  // BMP, …) are re-encoded so older readers can show them: JPEG on white for WEBP, PNG otherwise.
  // When re-encoding is impossible, WEBP is kept and other types are skipped.
  async function toEpubImage(bytes, headerType) {
    if (!bytes?.length || bytes.length > 25 * 1024 * 1024) return null;
    const type = sniffImageType(bytes) || String(headerType || '').toLowerCase();
    if (EPUB_IMAGE_TYPES[type] && type !== 'image/webp') return { data: bytes, mediaType: type };
    const keep = type === 'image/webp' ? { data: bytes, mediaType: type } : null;
    if (!/^image\//.test(type) || typeof createImageBitmap !== 'function') return keep;
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      const jpeg = type === 'image/webp';
      if (jpeg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, jpeg ? 'image/jpeg' : 'image/png', 0.92));
      return blob ? { data: new Uint8Array(await blob.arrayBuffer()), mediaType: jpeg ? 'image/jpeg' : 'image/png' } : keep;
    } catch (_) { return keep; }
  }

  // Neutral placeholder cover (no AI, no artwork): the room title on light gray. Used only when the
  // room thumbnail cannot be fetched. JPEG via canvas, SVG if canvas is unavailable.
  async function drawCover(title) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1200; canvas.height = 1800;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, 1200, 1800);
      ctx.strokeStyle = '#dddddd'; ctx.lineWidth = 4; ctx.strokeRect(90, 90, 1020, 1620);
      ctx.fillStyle = '#333333'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 92px "Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif';
      const lines = []; let line = '';
      for (const ch of Array.from(title)) {
        if (ctx.measureText(line + ch).width > 880 && line) { lines.push(line); line = ''; }
        line += ch;
      }
      if (line) lines.push(line);
      const shown = lines.slice(0, 6);
      shown.forEach((text, index) => ctx.fillText(text, 600, 760 - (shown.length - 1) * 62 + index * 124));
      ctx.font = '400 42px "Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif'; ctx.fillStyle = '#999999';
      ctx.fillText('Crack 캐릭터채팅', 600, 1560);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (blob) return { data: new Uint8Array(await blob.arrayBuffer()), mediaType: 'image/jpeg' };
    } catch (_) { /* canvas unavailable: SVG below */ }
    return { data: new TextEncoder().encode(coverSvg(title)), mediaType: 'image/svg+xml' };
  }

  // EPUB cover = the same room thumbnail the Books page shows (world.chatCover), downloaded and
  // embedded; the neutral placeholder only when it cannot be fetched or decoded.
  async function epubCover(world, title) {
    const url = world?.chatCover?.url;
    if (url) {
      try {
        const { bytes, type } = await fetchBinary(url);
        const image = await toEpubImage(bytes, type);
        if (image) return { ...image, fromThumbnail: true };
      } catch (error) { console.warn('[RP Fanverse] room thumbnail could not be embedded:', error.message); }
    }
    return { ...(await drawCover(title)), fromThumbnail: false };
  }

  class BookExporter {
    constructor(engine) { this.engine = engine; }

    // Full active branch, chronological. API first (all pages), then the stored log as a fallback.
    async loadActiveMessages(onStep) {
      const { api, db, world, worldInfo } = this.engine;
      try {
        const all = await api.fetchMessages(worldInfo.episodeId, { full: true, onProgress: (info) => onStep('fetch', `${Fmt.int(info.messages)}개`) });
        const active = resolveActiveBranch(all).filter((message) => !message.status || message.status === 'end');
        if (!active.length) throw new Error('메시지가 없습니다');
        return { messages: active, warning: null };
      } catch (error) {
        const stored = await db.getAllByWorld(STORES.messages, world.id);
        const position = new Map((world.activeMessageIds || []).map((id, index) => [id, index]));
        const active = stored.filter((message) => position.has(message._id)).sort((a, b) => position.get(a._id) - position.get(b._id));
        if (!active.length) throw new Error(`전체 로그를 불러오지 못했습니다: ${error.message}`);
        return { messages: active, warning: `Crack API에서 전체 로그를 받지 못해(${error.message}) 저장된 로그 ${active.length}개로 만들었습니다.` };
      }
    }

    async export(options, onStep = () => {}) {
      const { world, worldInfo, api } = this.engine;
      if (!world || !worldInfo) throw new Error('RP world가 아직 연결되지 않았습니다.');
      if (!world.chatTitle) await this.engine.refreshChatTitle({ force: true });
      const title = world.chatTitle;
      if (!title) throw new Error('현재 채팅방 제목을 확인하지 못했습니다. 잠시 후 다시 시도하세요.');

      onStep('fetch', '');
      await this.engine.refreshRoomMeta({ force: true });
      const { messages, warning } = await this.loadActiveMessages(onStep);
      let userName = String(options.userName || '').trim();
      if (!userName && options.unifyDialogue) userName = await api.fetchChatProfileName(worldInfo).catch(() => null) || '';

      onStep('clean', '');
      await yieldToUi();
      const turns = buildTurns(messages);
      const { chapters } = buildBookChapters(messages, turns, { userName, unifyDialogue: options.unifyDialogue !== false, sceneMarkers: options.sceneMarkers !== false, includeImages: options.includeImages !== false });
      if (!chapters.length) throw new Error('정리한 본문이 비어 있습니다.');
      onStep('clean', `${chapters.length}화`);

      const urls = [...new Set(chapters.flatMap((chapter) => chapter.blocks.filter((block) => block.type === 'img').map((block) => block.url)))];
      const images = new Map(); let failed = 0; let done = 0;
      onStep('images', urls.length ? `0 / ${urls.length}` : '없음');
      const queue = [...urls];
      const worker = async () => {
        while (queue.length) {
          const url = queue.shift();
          try {
            const { bytes, type } = await fetchBinary(url);
            const image = await toEpubImage(bytes, type);
            if (image) images.set(url, image); else failed += 1;
          } catch (error) {
            failed += 1;
            console.warn('[RP Fanverse] EPUB image skipped:', error.message);
          }
          done += 1;
          onStep('images', `${done} / ${urls.length}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));

      onStep('package', '');
      await yieldToUi();
      const cover = await epubCover(world, title);
      const modified = new Date();
      const files = buildEpubFiles({
        title, language: 'ko', identifier: `urn:uuid:${stableUuid(`rp-fanverse:${world.id}`)}`, modified,
        description: `「${title}」 Crack 캐릭터채팅 로그를 웹소설 형식으로 정리한 개인 소장용 EPUB (RP Fanverse ${APP_VERSION}).`,
        source: `https://crack.wrtn.ai/stories/${worldInfo.storyId}/episodes/${worldInfo.episodeId}`,
        chapters, cover,
      }, images);
      const parts = await createZip(files, { date: modified, onEntry: (index, total) => { onStep('package', `${index} / ${total}`); return index % 8 ? null : yieldToUi(); } });
      const fileName = epubFileName(title);
      Utils.download(fileName, new Blob(parts, { type: 'application/epub+zip' }), 'application/epub+zip');
      return { fileName, chapters: chapters.length, messages: messages.length, images: { embedded: images.size, failed }, coverFromThumbnail: cover.fromThumbnail, warning };
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
    book: '<path d="M4.5 5h5.2a2.3 2.3 0 0 1 2.3 2.3v12.2a1.8 1.8 0 0 0-1.8-1.8H4.5z" stroke-linejoin="round"/><path d="M19.5 5h-5.2A2.3 2.3 0 0 0 12 7.3v12.2a1.8 1.8 0 0 1 1.8-1.8h5.7z" stroke-linejoin="round"/>',
    download: '<path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
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
:host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Noto Sans KR","Noto Sans JP",sans-serif;color:#1f1f1f}
*{box-sizing:border-box}[hidden]{display:none!important}
button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent}
.ic{display:block;flex:none}
.launcher{position:fixed;right:18px;bottom:96px;z-index:2147483000;width:48px;height:48px;border:0;border-radius:16px;background:#17151c;color:#fff;display:grid;place-items:center;box-shadow:0 6px 20px #0004;cursor:pointer;transition:transform .15s}
.launcher:hover{transform:translateY(-2px)}
.launcher-badge,.app-badge{position:absolute;right:-6px;top:-6px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ff3b30;color:#fff;font:700 11px/20px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff}
.veil[hidden]{display:none!important}
.veil{position:fixed;inset:0;z-index:2147483001;background:#0d0b1299;display:grid;place-items:center;padding:16px}
.phone{position:relative;width:min(392px,calc(100vw - 20px));height:min(820px,calc(100vh - 24px));background:#fff;border:9px solid #0e0e10;border-radius:46px;overflow:hidden;box-shadow:0 0 0 1.5px #3a3a40,0 30px 80px #000a;display:grid;grid-template-rows:40px minmax(0,1fr) 54px;transform:scale(var(--ui-scale,1))}
.statusbar{position:relative;z-index:6;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 10px 0 14px;background:var(--sb-bg,#fff);color:#000}
.sb-left,.sb-right{display:flex;align-items:center;gap:4px;min-width:0}
.sb-right{justify-content:flex-end;gap:6px}
.statusbar .clock{font:600 15px/1 -apple-system,"SF Pro Text",system-ui,sans-serif;letter-spacing:-.2px;padding-left:4px}
.statusbar button{width:28px;height:28px;border:0;border-radius:50%;background:transparent;display:grid;place-items:center;cursor:pointer;color:#000;padding:0}
.statusbar button:hover{background:#0000000d}
.statusbar [data-action="back"]{margin-left:-8px}
.sb-icons{display:flex;align-items:center;gap:5px;color:#000}
.brand small{color:#8e8e93;font:500 10px/1 -apple-system,system-ui,sans-serif;white-space:nowrap}
main.screen{position:relative;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;background:#fff;min-height:0}
main.screen::-webkit-scrollbar{width:0;height:0}
.phone nav{display:grid;grid-template-columns:repeat(5,1fr);border-top:.5px solid #0000002e;background:#f9f9f9;z-index:5}
.phone nav button{position:relative;border:0;background:transparent;color:#8e8e93;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;cursor:pointer;font-size:10px}
.phone nav button.active{color:#007aff}
.phone nav .app-badge{right:calc(50% - 22px);top:4px;min-width:16px;height:16px;line-height:16px;font-size:9px;padding:0 4px}
.toast{position:absolute;left:16px;right:16px;bottom:66px;z-index:20;background:#1c1c1eeb;color:#fff;padding:11px 14px;border-radius:14px;font:12px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px #0005;white-space:pre-line}
.toast[data-kind="error"]{background:#3a1416f0}
.empty{text-align:center;color:#858585;padding:48px 16px;font-size:13px;line-height:1.6}
@media(max-width:500px){.launcher{right:12px;bottom:80px}.veil{padding:0}.phone{width:100vw;height:100vh;height:100dvh;border:0;border-radius:0;box-shadow:none;transform:none}}

.screen-home{background:#f2f2f7!important;color:#000;padding-bottom:28px}
.sf-searchwrap{position:sticky;top:0;z-index:4;padding:6px 16px 10px;background:#f2f2f7}
.sf-search{display:flex;align-items:center;gap:8px;height:44px;padding:0 8px 0 14px;border-radius:22px;background:#fff;color:#8a8a8e;box-shadow:0 0 0 .5px #0000001a,0 1px 3px #0000000f}
.sf-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#000;font:16px/22px -apple-system,"SF Pro Text",system-ui,sans-serif}
.sf-search input::placeholder{color:#8a8a8e}
.sf-search button{width:28px;height:28px;border:0;border-radius:50%;background:transparent;color:#8a8a8e;display:grid;place-items:center;cursor:pointer}
.sf-h{display:flex;align-items:baseline;justify-content:space-between;margin:22px 16px 10px}
.sf-h h2{margin:0;font:700 20px/24px -apple-system,"SF Pro Display",system-ui,sans-serif;letter-spacing:-.3px;color:#000}
.sf-h button{border:0;background:transparent;padding:0;color:#8a8a8e;font-size:15px;display:flex;align-items:center;gap:2px;cursor:pointer}
.sf-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px 6px;padding:0 12px}
.sf-fav{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;border:0;background:transparent;padding:0;cursor:pointer;min-width:0}
.sf-tile{width:64px;height:64px;border-radius:16px;display:grid;place-items:center;background:#fff;box-shadow:0 0 0 .5px #0000001a;overflow:hidden}
.sf-fav:active .sf-tile{transform:scale(.96)}
.sf-tile.pixiv{background:#0096fa;color:#fff;font:800 34px/1 "Helvetica Neue",Arial,sans-serif}
.sf-tile.reddit{background:#fff}
.sf-tile.guide{background:#fff;color:#5e5ce6}
.sf-tile.books{background:#1f8ce6;color:#fff}
.sf-tile.settings{background:#8e8e93;color:#fff}
.sf-tile.letter{background:var(--t,#e5e5ea);color:#fff;font:600 24px/1 -apple-system,system-ui,sans-serif}
.sf-label{width:100%;color:#3c3c43;font-size:12px;line-height:15px;text-align:center;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}
.sf-fav .app-badge{right:6px;top:-6px}
.launcher-badge.dot{min-width:0;width:12px;height:12px;padding:0;right:-1px;top:-1px;border-radius:6px}
.phone nav .app-badge.dot{min-width:0;width:8px;height:8px;padding:0;right:calc(50% - 16px);top:6px;border-radius:4px}
.cp-new{display:inline-block;width:8px;height:8px;margin-left:6px;border-radius:4px;background:#ff3b30;vertical-align:middle}
.cp-rank{flex:none;width:24px;color:#8a8a8e;font:600 15px/20px -apple-system,system-ui,sans-serif;text-align:center}
.cp-delta{flex:none;min-width:44px;font:600 13px/18px -apple-system,system-ui,sans-serif;text-align:right;color:#8a8a8e}
.cp-delta.up{color:#34c759}.cp-delta.down{color:#ff3b30}
.cp-riser{margin:8px 16px 0;padding:10px 14px;border-radius:12px;background:#fff;color:#3a3a3c;font-size:13px;line-height:18px;box-shadow:0 0 0 .5px #0000000f}
.cp-chart{margin:0 16px;padding:12px 8px 6px;border-radius:14px;background:#fff;box-shadow:0 0 0 .5px #0000000f}
.cp-chart svg{display:block;width:100%;height:auto;overflow:visible}
.cp-chart text{font:10px -apple-system,system-ui,sans-serif;fill:#8a8a8e}
.cp-legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin:10px 8px 4px;font-size:12px;color:#3a3a3c}
.cp-legend i{display:inline-block;width:10px;height:3px;margin-right:5px;border-radius:2px;vertical-align:middle;background:var(--c)}
.cp-point{margin:10px 16px 0;padding:12px 14px;border-radius:12px;background:#fff;font-size:13px;line-height:19px;color:#3a3a3c;box-shadow:0 0 0 .5px #0000000f}
.cp-point b{color:#000}.cp-point small{display:block;color:#8a8a8e;font-size:12px}
.sf-pages{display:grid;grid-auto-flow:column;grid-auto-columns:calc(100% - 44px);gap:10px;overflow-x:auto;padding:0 16px 2px;scroll-snap-type:x mandatory;scroll-padding:0 16px;scrollbar-width:none}
.sf-pages::-webkit-scrollbar{display:none}
.sf-page{display:grid;gap:10px;align-content:start;scroll-snap-align:start}
.sf-card{display:flex;gap:12px;width:100%;min-height:96px;padding:12px;border:0;border-radius:18px;background:#fff;text-align:left;cursor:pointer;box-shadow:0 0 0 .5px #0000000f}
.sf-card:active{background:#f7f7f7}
.sf-thumb{flex:none;width:72px;height:72px;border-radius:10px;display:grid;place-items:center;overflow:hidden;color:#fff;font:700 13px/1.25 -apple-system,system-ui,sans-serif;text-align:center;padding:6px;background:var(--t,#c7c7cc)}
.sf-thumb.reddit{background:#fff4ef;color:#d93900;font-size:15px;display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center}
.sf-thumb.reddit small{font-size:10px;font-weight:600;color:#8a8a8e}
.sf-card-body{flex:1;min-width:0;display:flex;flex-direction:column}
.sf-card-title{color:#000;font:600 15px/20px -apple-system,system-ui,sans-serif;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sf-card-desc{margin-top:2px;color:#8a8a8e;font-size:13px;line-height:17px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.sf-card-site{margin-top:auto;padding-top:6px;color:#8a8a8e;font-size:12px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sf-list{margin:0 16px;border-radius:14px;background:#fff;overflow:hidden;box-shadow:0 0 0 .5px #0000000f}
.sf-row{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:8px 14px;border:0;background:transparent;text-align:left;cursor:pointer;position:relative}
.sf-row+.sf-row:before{content:"";position:absolute;left:58px;right:0;top:0;height:.5px;background:#3c3c4329}
.sf-row:active{background:#f2f2f7}
.sf-dot{flex:none;width:32px;height:32px;border-radius:9px;display:grid;place-items:center;color:#fff;background:var(--t,#8e8e93)}
.sf-row-body{flex:1;min-width:0}
.sf-row-title{display:block;color:#000;font-size:15px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sf-row-sub{display:block;color:#8a8a8e;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sf-row time{flex:none;color:#8a8a8e;font-size:12px}
.sf-note{margin:10px 20px 0;color:#8a8a8e;font-size:12px;line-height:17px}
.sf-note.warn{color:#c93400}
.sf-empty{margin:0 16px;padding:18px;border-radius:14px;background:#fff;color:#8a8a8e;font-size:13px;line-height:18px;text-align:center}
.sf-foot{margin:26px 16px 0;color:#8a8a8e;font-size:11px;line-height:16px;text-align:center}

.screen-settings{background:#f2f2f7!important;padding-bottom:28px}
.st-title{padding:14px 18px 2px;font:700 26px/1.2 -apple-system,system-ui,sans-serif}
.st-section{margin:22px 18px 7px;color:#6d6d72;font:500 12px/1.2 -apple-system,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.02em}
.st-card{margin:0 14px;background:#fff;border-radius:12px;overflow:hidden}
.st-field{display:block;padding:10px 14px;border-bottom:1px solid #e5e5ea}
.st-field:last-child{border-bottom:0}
.st-field>span{display:block;margin-bottom:6px;color:#6d6d72;font-size:11px;font-weight:600}
.st-field input,.st-field select,.st-field textarea{width:100%;border:0;border-radius:8px;padding:9px 10px;background:#f2f2f7;color:#111;font:13px/1.35 -apple-system,system-ui,sans-serif;outline:none}
.st-field textarea{font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;min-height:150px;resize:vertical}
.st-field input:focus,.st-field select:focus,.st-field textarea:focus{box-shadow:0 0 0 2px #007aff55}
.st-inline{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #e5e5ea;font-size:14px}
.st-inline:last-child{border-bottom:0}
.st-inline input[type=checkbox]{width:20px;height:20px;accent-color:#34c759}
.st-kv{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #e5e5ea;font-size:14px}
.st-kv span:last-child{color:#8a8a8e;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st-btn{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:12px 14px;border:0;border-bottom:1px solid #e5e5ea;background:#fff;color:#007aff;text-align:left;font-size:14px;cursor:pointer}
.st-btn:last-child{border-bottom:0}
.st-btn:hover{background:#f7f7fa}
.st-btn.danger{color:#ff3b30}
.st-btn:disabled{color:#c7c7cc;cursor:default}
.st-btn .ic{color:#c7c7cc}
.st-note{padding:8px 18px 0;color:#6d6d72;font-size:11px;line-height:1.55}
.st-note.warn{color:#c93400}
.st-note code,.st-code{font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;background:#e9e9ee;border-radius:5px;padding:1px 4px;word-break:break-all}
.st-status{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-bottom:1px solid #e5e5ea;font-size:12px;line-height:1.45;color:#3a3a3c;white-space:pre-line;word-break:break-word}
.st-status .st-dot{margin-top:4px}
.st-dot{width:8px;height:8px;border-radius:50%;background:#c7c7cc;flex:none}
.st-dot.ok{background:#34c759}.st-dot.bad{background:#ff3b30}.st-dot.warn{background:#ff9500}
.st-badge{margin-left:auto;padding:2px 7px;border-radius:999px;background:#e9e9ee;color:#3a3a3c;font-size:10px;font-weight:700}
.st-badge.on{background:#007aff;color:#fff}
details.st-details{margin:0 14px;background:#fff;border-radius:12px;overflow:hidden}
details.st-details>summary{padding:12px 14px;cursor:pointer;font-size:14px;list-style:none;display:flex;justify-content:space-between}
details.st-details>summary::-webkit-details-marker{display:none}
details.st-details[open]>summary{border-bottom:1px solid #e5e5ea}
.st-sub{padding:0 18px;color:#6d6d72;font-size:13px}
.st-foot{margin:22px 18px 0;color:#8e8e93;font-size:12px;text-align:center}
.st-section.danger{color:#ff3b30}
.st-row{position:relative;display:flex;align-items:center;gap:12px;width:100%;min-height:46px;padding:8px 14px;border:0;background:#fff;color:#000;text-align:left;font-size:15px;cursor:pointer}
.st-row+.st-row:before,.st-status+.st-row:before{content:"";position:absolute;left:14px;right:0;top:0;height:1px;background:#e5e5ea}
.st-row:has(.st-ico)+.st-row:before{left:55px}
.st-row:hover{background:#f7f7fa}
.st-ico{flex:none;width:29px;height:29px;border-radius:7px;display:grid;place-items:center;color:#fff;background:var(--t,#8e8e93)}
.st-row-label{flex:1;min-width:0;display:flex;flex-direction:column}
.st-row-label small{color:#8e8e93;font-size:12px;line-height:16px}
.st-row-value{display:flex;align-items:center;gap:6px;max-width:55%;color:#8a8a8e;font-size:15px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.st-chev{color:#c4c4c7}
.st-check{color:#007aff}
.st-mono{padding:10px 14px;border-bottom:1px solid #e5e5ea;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:#3a3a3c;word-break:break-all}
.st-mono:last-child{border-bottom:0}
.st-result{margin:0 14px 10px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.45;white-space:pre-line}
.st-result[data-kind="error"]{background:#ffecec;color:#c41d1d}
.st-steps{margin:0;padding:10px 14px 12px 30px;font-size:11.5px;line-height:1.6;color:#3a3a3c}

.gi-text{display:block;width:calc(100% - 28px);min-height:240px;margin:0 14px;padding:14px;border:0;border-radius:14px;background:#fff;color:#000;font:15px/1.6 -apple-system,"SF Pro Text",system-ui,"Noto Sans KR",sans-serif;resize:vertical;outline:none;box-shadow:0 0 0 .5px #0000001a}
.gi-text:focus{box-shadow:0 0 0 2px #007aff66}
.gi-meta{display:flex;justify-content:space-between;margin:8px 20px 0;color:#8a8a8e;font-size:12px}
.gi-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 14px 0}
.gi-actions button{height:46px;border:0;border-radius:12px;background:#fff;color:#007aff;font-size:15px;cursor:pointer}
.gi-actions button.primary{background:#007aff;color:#fff;font-weight:600}
.gi-actions button:disabled{opacity:.45;cursor:default}

.nav-layer{position:absolute;left:0;right:0;z-index:1;overflow:hidden;pointer-events:none;contain:strict}
.nav-ghost{position:absolute;inset:0;overflow:hidden;background:#fff}
.nav-dim{position:absolute;inset:0;background:#000;opacity:0}
main.screen.nav-front{box-shadow:-10px 0 28px #0000001f}
.sheet-layer{position:absolute;inset:0;z-index:30}
.sheet-dim{position:absolute;inset:0;background:#0000004d}
.sheet{position:absolute;left:0;right:0;bottom:0;max-height:82%;overflow:auto;padding:8px 20px 22px;border-radius:14px 14px 0 0;background:#fff;box-shadow:0 -6px 24px #00000024;font-family:-apple-system,"SF Pro Text",system-ui,"Noto Sans KR",sans-serif;color:#000}
.sh-grab{width:36px;height:5px;margin:0 auto 12px;border-radius:3px;background:#d1d1d6}
.sh-title{margin:0;font:700 18px/24px -apple-system,system-ui,sans-serif}
.sh-sub{margin-top:2px;color:#8a8a8e;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-steps{list-style:none;margin:14px 0 0;padding:0}
.sh-steps li{display:flex;align-items:center;gap:10px;padding:9px 0;color:#8a8a8e;font-size:14px}
.sh-steps .sh-detail{margin-left:auto;color:#8a8a8e;font-size:12px}
.sh-dot{flex:none;width:18px;height:18px;border:2px solid #d1d1d6;border-radius:50%;display:grid;place-items:center}
.sh-steps li.active{color:#000}
.sh-steps li.active .sh-dot{border-color:#007aff;border-right-color:transparent;animation:shspin .8s linear infinite}
.sh-steps li.done{color:#000}
.sh-steps li.done .sh-dot{border-color:#34c759;background:#34c759}
.sh-steps li.done .sh-dot:after{content:"";width:7px;height:3px;border:2px solid #fff;border-top:0;border-right:0;transform:translateY(-1px) rotate(-45deg)}
.sh-steps li.error{color:#ff3b30}
.sh-steps li.error .sh-dot{border-color:#ff3b30;background:#ff3b30}
@keyframes shspin{to{transform:rotate(360deg)}}
.sh-result{margin-top:10px;padding:10px 12px;border-radius:10px;background:#f2f2f7;color:#3a3a3c;font-size:12px;line-height:18px;white-space:pre-line;word-break:break-word}
.sh-result[data-kind="error"]{background:#ffecec;color:#c41d1d}
.sh-btn{width:100%;height:46px;margin-top:14px;border:0;border-radius:12px;background:#007aff;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
@media (prefers-reduced-motion:reduce){.sh-steps li.active .sh-dot{animation:none}.launcher{transition:none}}
`;

  // Books: modeled on the current RIDI mobile e-book detail page (ridibooks.com/books/…, measured
  // 2026-10 at 375px): 110px cover left with the info column at x=142, 13px/600 #555 breadcrumb,
  // 22px/700 title on 26px lines, 13px #555 meta lines, a gray-label table in place of the price table,
  // 4px #e6e8eb section divider, 18px/700 section heading, two tabs under a 2px #787878 rule, 15px/23px
  // #555 intro text, and the fixed dark bottom bar (rgba(62,62,62,.9)) with 40×42 gray-blue icon
  // squares and the #1e9eff 42px main button. Store-only parts (price, cash/points, rating, reviews,
  // events, recommendations, wishlist/cart/gift, DRM) are left out. No brand assets.
  const BOOKS_CSS = `
.screen-books{--bk-blue:#1e9eff;--bk-t1:#141414;--bk-t2:#555;--bk-t3:#a5a5a5;--bk-line:#e6e6e6;background:#fff;color:var(--bk-t1);font-family:"Pretendard Variable",Pretendard,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:14px;line-height:1.4}
.bk-page{display:flex;flex-direction:column;min-height:100%}
.bk-grow{flex:1}
.bk-top{display:flex;align-items:center;height:47px;padding:0 4px;background:#fff}
.bk-top h1{margin:0 0 0 12px;font-size:18px;font-weight:700}
.bk-iconbtn{width:40px;height:40px;border:0;background:transparent;color:var(--bk-t1);display:grid;place-items:center;cursor:pointer}
.bk-head{display:flex;gap:16px;padding:17px 16px 24px}
.bk-cover{position:relative;flex:none;width:110px;align-self:flex-start;border-radius:4px;overflow:hidden;background:#f5f5f5;box-shadow:0 0 0 1px #0000000d}
.bk-cover img{display:block;width:100%;height:auto}
.bk-ph{display:flex;align-items:center;justify-content:center;aspect-ratio:2/3;padding:10px;background:#f2f2f2;color:var(--bk-t2,#555);font-size:12px;font-weight:600;line-height:1.35;text-align:center;word-break:keep-all;overflow:hidden}
.bk-info{flex:1;min-width:0}
.bk-crumb{color:var(--bk-t2);font-size:13px;font-weight:600;line-height:16px}
.bk-crumb span{margin:0 3px;color:#bbb;font-weight:400}
.bk-title{margin:10px 0 4px;font-size:22px;font-weight:700;line-height:26px;letter-spacing:-.3px;word-break:keep-all;overflow-wrap:anywhere}
.bk-line{margin-top:8px;color:var(--bk-t2);font-size:13px;line-height:17px}
.bk-line b{font-weight:600}
.bk-line i{font-style:normal;color:var(--bk-t3)}
.bk-table{display:grid;grid-template-columns:68px 1fr;margin:0 16px;border-top:1px solid var(--bk-line);border-bottom:1px solid var(--bk-line)}
.bk-table-k{display:flex;align-items:center;justify-content:center;background:#fafafa;border-right:1px solid var(--bk-line);font-size:14px;font-weight:600}
.bk-table-rows>div{display:flex;align-items:center;justify-content:space-between;min-height:44px;padding-left:14px;color:var(--bk-t2);font-size:13px}
.bk-table-rows>div+div{border-top:1px solid var(--bk-line)}
.bk-table-rows b{color:var(--bk-t1);font-size:14px;font-weight:600}
.bk-sep{margin-top:24px;border-top:4px solid #e6e8eb}
.bk-sec{padding:20px 16px 28px}
.bk-sec h2{margin:0;padding:4px 0 10px;font-size:18px;font-weight:700;line-height:22px}
.bk-tabs{display:flex;border-top:2px solid #787878}
.bk-tabs button{flex:1;padding:11px 0 13px;border:0;background:#fff;color:var(--bk-t3);font-family:inherit;font-size:15px;font-weight:700;line-height:18px;cursor:pointer}
.bk-tabs button.on{color:var(--bk-t1)}
.bk-intro{margin:14px 0 0;color:var(--bk-t2);font-size:15px;line-height:23px;white-space:pre-line;word-break:keep-all;overflow-wrap:anywhere}
.bk-intro.clamp{display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
.bk-more{display:block;width:100%;margin-top:14px;padding:10px 0;border:1px solid var(--bk-line);border-radius:4px;background:#fff;color:var(--bk-t2);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}
.bk-toc{list-style:none;margin:6px 0 0;padding:0}
.bk-toc li{display:flex;align-items:baseline;gap:10px;padding:13px 0;border-bottom:1px solid #f0f0f0;font-size:14px;line-height:18px}
.bk-toc b{flex:none;width:40px;font-weight:600}
.bk-toc span{flex:1;min-width:0;color:var(--bk-t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bk-toc i{flex:none;color:var(--bk-t3);font-size:12px;font-style:normal}
.bk-empty{margin:14px 0 0;color:var(--bk-t3);font-size:14px}
.bk-bar{position:sticky;bottom:0;z-index:5;display:flex;gap:3px;padding:5px;background:#3e3e3ee6}
.bk-barbtn{flex:none;width:40px;height:42px;border:0;border-radius:4px;background:#7d8e9e;color:#fff;display:grid;place-items:center;cursor:pointer}
.bk-buy{flex:1;height:42px;border:0;border-radius:4px;background:var(--bk-blue);color:#fff;font-family:inherit;font-size:16px;font-weight:700;cursor:pointer;transition:filter .12s,transform .12s}
.bk-buy:active,.bk-buy.pressed{filter:brightness(.9);transform:scale(.98)}
.bk-buy:disabled{background:#a5a5a5;cursor:default;transform:none}
.bk-shelf{display:grid;grid-template-columns:repeat(3,1fr);gap:22px 12px;padding:8px 16px 24px}
.bk-book{display:flex;flex-direction:column;gap:7px;min-width:0;padding:0;border:0;background:transparent;color:var(--bk-t1);font-family:inherit;text-align:left;cursor:pointer}
.bk-book .bk-cover{width:100%}
.bk-book:active .bk-cover{opacity:.85}
.bk-book b{font-size:13px;font-weight:600;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:keep-all}
.bk-book small{color:var(--bk-t3);font-size:12px}
.bk-sfield{display:block;margin:16px 0 4px}
.bk-sfield span{display:block;margin-bottom:6px;color:#555;font-size:13px;font-weight:600}
.bk-sfield input{width:100%;height:42px;padding:0 12px;border:1px solid #e6e6e6;border-radius:4px;color:#141414;font:15px -apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;outline:0}
.bk-sfield input:focus{border-color:#1e9eff}
.bk-stoggle{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
.bk-stoggle input{flex:none;width:20px;height:20px;accent-color:#1e9eff}
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

  const STATUS_ICONS = '<svg width="17" height="11" viewBox="0 0 17 11" aria-hidden="true"><rect x="0" y="7" width="3" height="4" rx="1" fill="currentColor"/><rect x="4.5" y="5" width="3" height="6" rx="1" fill="currentColor"/><rect x="9" y="2.5" width="3" height="8.5" rx="1" fill="currentColor"/><rect x="13.5" y="0" width="3" height="11" rx="1" fill="currentColor"/></svg><svg width="15" height="11" viewBox="0 0 15 11" aria-hidden="true"><path d="M7.5 2.2c2.2 0 4.2.8 5.7 2.2l1.1-1.1A9.6 9.6 0 0 0 7.5.6 9.6 9.6 0 0 0 .7 3.3l1.1 1.1a8 8 0 0 1 5.7-2.2zm0 3.1c1.3 0 2.5.5 3.5 1.3l1.1-1.1a6.6 6.6 0 0 0-9.2 0L4 6.6a5 5 0 0 1 3.5-1.3zm0 3c-.5 0-.9.2-1.3.5L7.5 10l1.3-1.2c-.4-.3-.8-.5-1.3-.5z" fill="currentColor"/></svg><svg width="25" height="12" viewBox="0 0 25 12" aria-hidden="true"><rect x=".5" y=".5" width="21" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor"/><path d="M23 4v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="currentColor" opacity=".4"/></svg>';

  class PhoneUI {
    constructor(engine, db, getSettings, saveSettings) {
      this.engine = engine; this.db = db; this.getSettings = getSettings; this.saveSettings = saveSettings;
      this.host = null; this.root = null; this.open = false; this.view = 'home'; this.route = null; this.toastTimer = null;
      this.history = []; this.renderToken = 0; this.instructionDraft = null; this.searchTimer = null;
    }

    mount() {
      if (this.host?.isConnected) return;
      this.host = document.createElement('div');
      this.host.id = 'rp-fanverse-host';
      this.root = this.host.attachShadow({ mode: 'open' });
      const navButton = (view, iconName, label) => `<button data-view="${view}" aria-label="${label}">${icon(iconName, 22)}<span>${label}</span></button>`;
      this.root.innerHTML = `<style>${SHELL_CSS}${PIXIV_CSS}${REDDIT_CSS}${BOOKS_CSS}</style><button class="launcher" aria-label="RP Fanverse 열기" aria-expanded="false"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6"/><path d="M10.5 5.6h3"/></svg><span class="launcher-badge" hidden></span></button><div class="veil" hidden aria-hidden="true"><section class="phone" role="dialog" aria-modal="true" aria-label="RP Fanverse"><header class="statusbar"><div class="sb-left"><button data-action="back" aria-label="뒤로">${icon('back', 18)}</button><span class="clock"></span></div><div class="brand"><small></small></div><div class="sb-right"><span class="sb-icons">${STATUS_ICONS}</span><button data-action="close" aria-label="닫기">${icon('close', 16)}</button></div></header><main class="screen screen-home"></main><nav>${navButton('home', 'home', 'Home')}${navButton('pixiv', 'pen', 'Pixiv')}${navButton('reddit', 'comment', 'Reddit')}${navButton('books', 'book', 'Books')}${navButton('settings', 'gear', 'Settings')}</nav><div class="toast" hidden></div></section></div>`;
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
      // A room thumbnail that fails to load becomes the neutral title placeholder ('error' does not bubble).
      this.root.addEventListener('error', (event) => {
        const img = event.target;
        if (!img?.matches?.('img[data-cover-fallback]')) return;
        const placeholder = document.createElement('div');
        placeholder.className = 'bk-ph';
        placeholder.textContent = img.dataset.coverFallback;
        img.replaceWith(placeholder);
      }, true);
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

    // Unsaved edits on the Gemini 공통 지침 screen survive accidental navigation only by consent.
    confirmDiscardDraft() {
      if (!this.instructionDraft?.dirty) return true;
      if (!confirm('저장하지 않은 Gemini 공통 지침 변경 사항이 있습니다. 버릴까요?')) return false;
      this.instructionDraft = null;
      return true;
    }

    // Bottom-nav switch: a fresh stack per app (short crossfade, never a slide).
    go(view, route = null) {
      if (!this.confirmDiscardDraft()) return;
      this.view = view; this.route = route; this.history = [];
      this.render({ transition: 'tab' });
    }

    // In-app navigation: remembers where the user was (including scroll) for back(). Slides in from the right.
    push(route, view = this.view) {
      if (!this.confirmDiscardDraft()) return;
      this.history.push({ view: this.view, route: this.route, scroll: this.root.querySelector('main').scrollTop });
      this.view = view; this.route = route;
      this.render({ transition: 'push' });
    }

    // Same screen, different parameters (sort, tab, search): no history entry, no transition.
    replace(route, options = { keepScroll: false }) {
      this.route = route;
      this.render(options);
    }

    // Exact reverse of push().
    back() {
      if (!this.confirmDiscardDraft()) return;
      const previous = this.history.pop();
      if (previous) { this.view = previous.view; this.route = previous.route; this.render({ restoreScroll: previous.scroll, transition: 'pop' }); return; }
      if (this.route) { this.route = null; this.render({ transition: 'pop' }); return; }
      if (this.view !== 'home') this.go('home');
    }

    reducedMotion() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
    }

    // ---------- navigation transitions ----------
    // render() replaces main's content. Only for the duration of a transition, the old content is moved
    // (not cloned) into an absolutely positioned layer over main and animated with transform/opacity;
    // the layer is removed when the animation ends. push: new screen from the right, old one shifts
    // 28% left under a light dim. pop: the reverse. tab: the new screen fades in over the old one.
    beginTransition(main) {
      this.finishTransition();
      const phone = this.root.querySelector('.phone');
      const layer = document.createElement('div');
      layer.className = 'nav-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.style.top = `${main.offsetTop}px`;
      layer.style.height = `${main.offsetHeight}px`;
      const ghost = document.createElement('div');
      ghost.className = `${main.className} nav-ghost`;
      ghost.inert = true;
      const scroll = main.scrollTop;
      ghost.append(...main.childNodes);
      const dim = document.createElement('div');
      dim.className = 'nav-dim';
      layer.append(ghost, dim);
      phone.insertBefore(layer, this.root.querySelector('.phone nav'));
      ghost.scrollTop = scroll;
      return { layer, ghost, dim };
    }

    runTransition(kind, main, parts) {
      const { layer, ghost, dim } = parts;
      const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
      const duration = kind === 'tab' ? 180 : 320;
      const timing = { duration, easing: kind === 'tab' ? 'ease-out' : ease, fill: 'both' };
      const animations = [];
      if (kind === 'push') {
        layer.style.zIndex = '1'; main.style.zIndex = '2'; main.classList.add('nav-front');
        animations.push(main.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], timing));
        animations.push(ghost.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-28%)' }], timing));
        animations.push(dim.animate([{ opacity: 0 }, { opacity: 0.1 }], timing));
      } else if (kind === 'pop') {
        layer.style.zIndex = '3'; ghost.style.boxShadow = '-10px 0 28px #0000001f';
        layer.insertBefore(dim, ghost); // dim covers the returning screen, under the leaving one
        animations.push(ghost.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], timing));
        animations.push(main.animate([{ transform: 'translateX(-28%)' }, { transform: 'translateX(0)' }], timing));
        animations.push(dim.animate([{ opacity: 0.1 }, { opacity: 0 }], timing));
      } else {
        layer.style.zIndex = '1'; main.style.zIndex = '2';
        animations.push(main.animate([{ opacity: 0 }, { opacity: 1 }], timing));
      }
      const state = { layer, main, animations };
      this.navTransition = state;
      const fallback = setTimeout(() => this.finishTransition(state), duration + 150);
      Promise.all(animations.map((animation) => animation.finished)).catch(() => {}).then(() => { clearTimeout(fallback); this.finishTransition(state); });
    }

    // Ends the running transition (or the given one) at once and removes its temporary layer.
    finishTransition(state = this.navTransition) {
      if (!state || state.done) return;
      state.done = true;
      for (const animation of state.animations || []) { try { animation.cancel(); } catch (_) { /* already finished */ } }
      state.layer?.remove();
      if (state.main) { state.main.style.zIndex = ''; state.main.classList.remove('nav-front'); }
      if (this.navTransition === state) this.navTransition = null;
    }

    // Toast: short fade + small vertical slide.
    notify(kind, message) {
      const toast = this.root?.querySelector('.toast');
      if (!toast) return;
      const wasHidden = toast.hidden;
      toast.textContent = message; toast.hidden = false; toast.dataset.kind = kind;
      const animate = !this.reducedMotion() && typeof toast.animate === 'function';
      this.toastAnimation?.cancel();
      if (wasHidden && animate) this.toastAnimation = toast.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' });
      const serial = (this.toastSerial || 0) + 1;
      this.toastSerial = serial;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        if (!animate) { toast.hidden = true; return; }
        this.toastAnimation = toast.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
        const hideNow = () => { if (this.toastSerial === serial && !toast.hidden) { toast.hidden = true; this.toastAnimation?.cancel(); } };
        this.toastAnimation.finished.then(hideNow, () => {});
        setTimeout(hideNow, 320); // animations do not advance in a hidden tab
      }, kind === 'error' ? 7000 : 3200);
      if (this.open) this.renderHeader();
    }

    // Bottom sheet over the phone: slides up from translateY(100%) over a light dim.
    openSheet(html, { dismissible = false } = {}) {
      this.closeSheet(true);
      const layer = document.createElement('div');
      layer.className = 'sheet-layer';
      layer.dataset.dismissible = dismissible ? '1' : '0';
      layer.innerHTML = `<div class="sheet-dim"></div><section class="sheet" role="dialog" aria-modal="true">${html}</section>`;
      this.root.querySelector('.phone').appendChild(layer);
      if (!this.reducedMotion() && typeof layer.animate === 'function') {
        layer.querySelector('.sheet-dim').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
        layer.querySelector('.sheet').animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 340, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      }
      layer.addEventListener('change', (event) => this.handleChange(event));
      layer.addEventListener('click', (event) => {
        if (event.target.closest('[data-sheet-close]') || (layer.dataset.dismissible === '1' && event.target.classList.contains('sheet-dim'))) this.closeSheet();
      });
      this.sheet = layer;
      return layer;
    }

    closeSheet(immediate = false) {
      const layer = this.sheet;
      if (!layer) return;
      this.sheet = null;
      if (immediate || this.reducedMotion() || typeof layer.animate !== 'function') { layer.remove(); return; }
      const timing = { duration: 240, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' };
      layer.style.pointerEvents = 'none';
      layer.querySelector('.sheet-dim').animate([{ opacity: 1 }, { opacity: 0 }], timing);
      layer.querySelector('.sheet').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }], timing).finished.then(() => layer.remove(), () => layer.remove());
      setTimeout(() => layer.remove(), 400); // animations do not advance in a hidden tab
    }

    renderHeader() {
      const now = new Date();
      const clock = this.root.querySelector('.statusbar .clock');
      if (clock) clock.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
      const small = this.root.querySelector('.brand small');
      if (small) small.textContent = this.engine.world ? `${this.engine.world.turnCount} turns · ${this.engine.world.sync.adapter}` : 'connecting…';
      const back = this.root.querySelector('[data-action="back"]');
      if (back) back.hidden = this.view === 'home' && !this.route && !this.history.length;
    }

    // Launcher: a small red dot while Reddit, Pixiv or CP Trends of the open room has anything unread.
    // Inside the phone, Pixiv/Reddit keep their counts and Home shows a dot for CP Trends.
    refreshBadges() {
      if (!this.root || !this.engine.world) return;
      const badges = this.engine.world.badges;
      const unread = ['reddit', 'pixiv', 'trends'].some((kind) => (Number(badges[kind]) || 0) > 0);
      const badge = this.root.querySelector('.launcher-badge');
      badge.textContent = '';
      badge.classList.add('dot');
      badge.hidden = !unread;
      badge.setAttribute('aria-label', unread ? '새 Fanverse 소식' : '');
      for (const kind of ['pixiv', 'reddit']) {
        const button = this.root.querySelector(`nav [data-view="${kind}"]`);
        let dot = button?.querySelector('.app-badge');
        if (badges[kind] && !dot) { dot = document.createElement('span'); dot.className = 'app-badge'; button.appendChild(dot); }
        if (dot) { dot.textContent = badges[kind] > 99 ? '99+' : String(badges[kind] || ''); dot.hidden = !badges[kind]; }
      }
      const home = this.root.querySelector('nav [data-view="home"]');
      let homeDot = home?.querySelector('.app-badge');
      if (badges.trends && !homeDot && home) { homeDot = document.createElement('span'); homeDot.className = 'app-badge dot'; home.appendChild(homeDot); }
      if (homeDot) homeDot.hidden = !badges.trends;
    }

    // Fan content generated in the background for the open room (never called for a stale room):
    // unread markers update; a list screen re-renders in place (scroll kept). Detail pages, Books,
    // Settings, open sheets, running transitions and focused inputs are left untouched.
    fanContentArrived() {
      this.refreshBadges();
      if (!this.open || this.sheet || this.navTransition) return;
      const active = this.root.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      const route = this.route || {};
      const list = (this.view === 'home' && (!route.type || route.type === 'cp-trends') && !String(route.q || '').trim())
        || (this.view === 'reddit' && route.type !== 'reddit-post')
        || (this.view === 'pixiv' && !['pixiv-work', 'author', 'series'].includes(route.type));
      if (list) this.render({ keepScroll: true }).catch((error) => console.warn('[RP Fanverse] live refresh failed', error));
    }

    async render({ keepScroll = false, restoreScroll = null, transition = null } = {}) {
      if (!this.open) { this.refreshBadges(); return; }
      const token = ++this.renderToken;
      const main = this.root.querySelector('main');
      const previousScroll = main.scrollTop;
      this.renderHeader();
      this.root.querySelectorAll('nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === this.view));
      // Without a world (still starting, or IndexedDB/route attach failed) only Settings and the
      // status screen are available, so opening the phone can never show a blank page.
      const startup = !this.engine.world && this.view !== 'settings';
      let html;
      try {
        if (startup) html = this.startupHtml();
        else if (this.view === 'home') html = await this.homeHtml();
        else if (this.view === 'reddit') html = await this.redditHtml();
        else if (this.view === 'pixiv') html = await this.pixivHtml();
        else if (this.view === 'books') html = await this.booksHtml();
        else html = this.settingsHtml();
      } catch (error) {
        html = `<div class="empty">${Utils.escapeHtml(error.message)}</div>`;
      }
      if (token !== this.renderToken) return; // a newer render started while this one awaited IndexedDB
      const screen = startup ? 'settings' : this.view;
      // A transition needs something on screen to move away; reduced motion swaps instantly.
      const animate = Boolean(transition) && main.childNodes.length > 0 && typeof main.animate === 'function' && !this.reducedMotion();
      if (!animate) this.finishTransition();
      const parts = animate ? this.beginTransition(main) : null;
      main.className = `screen screen-${screen}`;
      this.root.querySelector('.statusbar').style.setProperty('--sb-bg', screen === 'home' || screen === 'settings' ? '#f2f2f7' : '#fff');
      main.innerHTML = html;
      main.scrollTop = restoreScroll ?? (keepScroll ? previousScroll : 0);
      if (parts) this.runTransition(transition, main, parts);
      this.refreshBadges();
    }

    // ---------- shared fragments ----------

    esc(value) { return Utils.escapeHtml(value); }

    // Work title shared by Reddit (and later RIDI/EPUB): the open Crack room's title (world.chatTitle).
    storyTitle() { return this.engine.world?.chatTitle || null; }
    communityTitle() { return this.storyTitle() || '채팅방 제목 확인 중'; }
    communityName() { return `r/${this.communityTitle()}`; }

    // Fan-visible copies of stored posts/works: internal IDs and "Canon #N" are scrubbed for display
    // (older saved text); the stored records and their source ID fields are not changed.
    fanPost(post) { const t = (text) => this.engine.fanText(text); return { ...post, title: t(post.title), body: t(post.body), comments: (post.comments || []).map((comment) => ({ ...comment, body: t(comment.body) })) }; }
    fanWork(work) { const t = (text) => this.engine.fanText(text); return { ...work, title: t(work.title), caption: t(work.caption), summary: t(work.summary), seriesTitle: t(work.seriesTitle), tags: (work.tags || []).map(t) }; }
    async loadFanIndex() { this.fanIndex = await this.engine.fanReferenceIndex().catch(() => null); return this.fanIndex; }
    episodeAt(turn) { return this.fanIndex?.episodeLabelForTurnCount(turn) || null; }

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

    // ---------- startup / degraded ----------

    startupHtml() {
      const issues = this.startupIssues || [];
      return `<div class="st-title">Fanverse</div><div class="st-section">상태</div><div class="st-card"><div class="st-status"><span class="st-dot ${issues.length ? 'bad' : ''}"></span>${issues.length ? '일부 초기화 단계가 실패했습니다' : 'RP world 연결 중…'}</div>${issues.map((issue) => `<div class="st-status">${this.esc(issue)}</div>`).join('')}<button class="st-btn" data-go="settings">Settings 열기${icon('chevronRight', 18)}</button></div><div class="st-note">launcher와 Settings는 AI provider 설정이나 Vertex 인증 상태와 관계없이 항상 사용할 수 있습니다.</div>`;
    }

    // ---------- home (Safari start page) ----------
    // Modeled on the iOS 26/27 Safari start page (Apple iPhone User Guide screenshot): rounded search
    // capsule, "Favorites" 4-column tile grid with two-line labels, "Show All" section headers and
    // Reading-List style cards paged horizontally. Uses the "Top" address-bar layout and the plain
    // light background (no wallpaper/blur).

    sfTileColor(text) {
      return ['#5ac8fa', '#ff9f0a', '#34c759', '#af52de', '#ff375f', '#5e5ce6', '#64d2ff', '#ffcc00'][Fmt.seed(String(text), 8)];
    }

    sfHeader(title, act = '', attrs = '') {
      return `<div class="sf-h"><h2>${this.esc(title)}</h2>${act ? `<button data-act="${act}" ${attrs}>모두 보기${icon('chevronRight', 14)}</button>` : ''}</div>`;
    }

    sfPages(cards, perPage = 2) {
      const pages = [];
      for (let i = 0; i < cards.length; i += perPage) pages.push(`<div class="sf-page">${cards.slice(i, i + perPage).join('')}</div>`);
      return `<div class="sf-pages">${pages.join('')}</div>`;
    }

    sfPixivCard(work) {
      const author = this.pixivAuthor(work.authorId);
      return `<button class="sf-card" data-act="sf-pixiv" data-id="${work.id}"><span class="sf-thumb" style="--t:${PX_COVERS[Fmt.seed(work.seriesTitle || work.title || work.id, PX_COVERS.length)][1]}">${this.esc(String(work.title).slice(0, 14))}</span><span class="sf-card-body"><span class="sf-card-title">${this.esc(work.title)}</span><span class="sf-card-desc">${this.esc(work.caption || work.summary || '')}</span><span class="sf-card-site">pixiv.net · ${this.esc(author?.name || work.authorId)} · ♡ ${Fmt.int(work.bookmarks)}</span></span></button>`;
    }

    sfRedditCard(post) {
      const persona = this.redditPersona(post.personaId);
      return `<button class="sf-card" data-act="sf-reddit" data-id="${post.id}"><span class="sf-thumb reddit">${icon('up', 18)}<b>${Fmt.compact(post.score)}</b><small>댓글 ${Fmt.compact(Math.max(post.comments?.length || 0, post.estimatedCommentCount || 0))}</small></span><span class="sf-card-body"><span class="sf-card-title">${this.esc(post.title)}</span><span class="sf-card-desc">${this.esc(String(post.spoiler ? '(스포일러)' : post.body || '').replace(/\s+/g, ' '))}</span><span class="sf-card-site">reddit.com/${this.esc(this.communityName())} · u/${this.esc(persona?.name || post.personaId)} · ${Fmt.ago(post.createdAt)}</span></span></button>`;
    }

    sfRow({ act, attrs = '', color, glyph, title, sub = '', time = '' }) {
      return `<button class="sf-row" data-act="${act}" ${attrs}><span class="sf-dot" style="--t:${color}">${glyph}</span><span class="sf-row-body"><span class="sf-row-title">${title}</span>${sub ? `<span class="sf-row-sub">${sub}</span>` : ''}</span>${time ? `<time>${this.esc(time)}</time>` : ''}</button>`;
    }

    async homeHtml() {
      if (this.route?.type === 'cp-trends') return this.cpTrendsHtml();
      const world = this.engine.world;
      const settings = this.getSettings();
      const q = String(this.route?.q || '');
      const [rawWorks, rawPosts] = await Promise.all([
        this.db.getAllByWorld(STORES.pixivWorks, world.id).catch(() => []),
        this.db.getAllByWorld(STORES.redditPosts, world.id).catch(() => []),
      ]);
      await this.loadFanIndex();
      const works = rawWorks.map((work) => this.fanWork(work));
      const posts = rawPosts.map((post) => this.fanPost(post));
      const search = `<div class="sf-searchwrap"><label class="sf-search">${icon('search', 18)}<input data-sf-search placeholder="Fanverse 검색 또는 fandom://current" value="${this.esc(q)}" enterkeyhint="search" autocomplete="off" spellcheck="false">${q ? `<button data-act="sf-clear" aria-label="검색어 지우기">${icon('close', 14)}</button>` : ''}</label></div>`;
      if (q.trim() && !/^fandom:\/\/current\/?$/i.test(q.trim())) return search + this.sfSearchHtml(q.trim(), works, posts);

      const fav = (attrs, cls, glyph, label, badge = 0) => `<button class="sf-fav" ${attrs}><span class="sf-tile ${cls}">${glyph}</span><span class="sf-label">${label}</span>${badge ? `<span class="app-badge">${badge > 99 ? '99+' : badge}</span>` : ''}</button>`;
      const favorites = `<div class="sf-grid">${fav('data-act="sf-open" data-view="pixiv"', 'pixiv', 'P', 'Pixiv', world.badges.pixiv)}${fav('data-act="sf-open" data-view="reddit"', 'reddit', this.rdLogo(44), 'Reddit', world.badges.reddit)}${fav('data-act="sf-open" data-view="books"', 'books', icon('book', 32), 'Books')}${fav('data-act="open-instruction"', 'guide', icon('pen', 30), 'Gemini 지침')}${fav('data-act="sf-open" data-view="settings"', 'settings', icon('gear', 32), '설정')}</div>`;

      const ships = [...world.fandom.ships, ...world.fandom.tags].filter((item, index, list) => list.findIndex((other) => other.tag === item.tag) === index).slice(0, 8);
      const shipsHtml = ships.length ? `<div class="sf-grid">${ships.map((item) => fav(`data-act="px-tag" data-tag="${this.esc(item.tag)}"`, 'letter', this.esc(Array.from(item.tag)[0] || '#'), `#${this.esc(item.tag)}`).replace('class="sf-tile letter"', `class="sf-tile letter" style="--t:${this.sfTileColor(item.tag)}"`)).join('')}</div>` : '<div class="sf-empty">아직 팬덤 데이터가 없습니다. RP가 진행되면 CP와 태그가 쌓입니다.</div>';

      const recentWorks = works.slice().sort((a, b) => (b.publishOrder || 0) - (a.publishOrder || 0)).slice(0, 4);
      const hotPosts = posts.slice().sort(this.rdSorters().hot).slice(0, 4);

      const activity = [];
      const syncOk = world.sync.status !== 'fallback';
      activity.push(this.sfRow({ act: 'sf-open', attrs: 'data-view="settings"', color: syncOk ? '#34c759' : '#ff9500', glyph: icon(syncOk ? 'check' : 'warning', 18), title: syncOk ? `Crack 원작 동기화 · ${world.turnCount} turns` : 'Crack API 실패 — DOM fallback', sub: syncOk ? `${world.sync.adapter === 'api' ? 'Crack API' : '대기 중'} · 다음 자동 갱신까지 ${Math.max(0, settings.turnsPerUpdate - ((world.turnCount - world.lastProcessedTurn) % settings.turnsPerUpdate))} turns` : this.esc(world.sync.error || ''), time: world.sync.lastAt ? Fmt.ago(world.sync.lastAt) : '' }));
      if (world.needsCanonRebuild) activity.push(this.sfRow({ act: 'sf-open', attrs: 'data-view="settings"', color: '#ff3b30', glyph: icon('warning', 18), title: '원작 분기가 바뀌었습니다', sub: 'Settings에서 Canon rebuild를 실행하세요' }));
      else if (world.needsImport) activity.push(this.sfRow({ act: 'sf-open', attrs: 'data-view="settings"', color: '#ff9500', glyph: icon('warning', 18), title: '기존 장기 로그가 있습니다', sub: 'Settings에서 현재 RP를 원작으로 가져오기' }));
      if (!this.engine.gemini.providerReady()) activity.push(this.sfRow({ act: 'sf-open', attrs: 'data-view="settings"', color: '#ff3b30', glyph: icon('warning', 18), title: 'AI 생성 사용 불가', sub: 'Settings에서 AI Backend 상태를 확인하세요' }));
      for (const entry of (world.fandom.history || []).slice(-3).reverse()) {
        activity.push(this.sfRow({ act: 'sf-open', attrs: 'data-view="reddit"', color: '#5e5ce6', glyph: icon('sparkle', 18), title: `${this.episodeAt(entry.turn) || '본편'} · 팬덤 갱신`, sub: `새 장면 ${(entry.canonEventIds || []).length} · 새 해석 ${(entry.interpretationIds || []).length}`, time: Fmt.ago(entry.at) }));
      }

      return `${search}${this.sfHeader('즐겨찾기')}${favorites}${this.cpHomeHtml(world)}${this.sfHeader('Trending Ships', ships.length ? 'sf-open' : '', 'data-view="pixiv"')}${shipsHtml}${this.sfHeader('최근 Pixiv', recentWorks.length ? 'sf-open' : '', 'data-view="pixiv"')}${recentWorks.length ? this.sfPages(recentWorks.map((work) => this.sfPixivCard(work))) : '<div class="sf-empty">다음 Fanverse 갱신에서 작품이 올라옵니다.</div>'}${this.sfHeader('Reddit에서 화제', hotPosts.length ? 'sf-open' : '', 'data-view="reddit"')}${hotPosts.length ? this.sfPages(hotPosts.map((post) => this.sfRedditCard(post))) : '<div class="sf-empty">다음 Fanverse 갱신 뒤 토론이 생깁니다.</div>'}${this.sfHeader('최근 Fanverse 활동')}<div class="sf-list">${activity.join('')}</div><div class="sf-foot">fandom://current · ${this.esc(this.communityTitle())} · Fanverse ${APP_VERSION}</div>`;
    }

    // ---------- CP Trends (world.fandom.shipHistory; no extra Gemini calls) ----------

    cpStats(world) {
      const history = world.fandom.shipHistory || [];
      const previous = history.length > 1 ? history[history.length - 2] : null;
      const ranks = (snapshot) => new Map(Object.entries(snapshot?.ships || {}).sort((a, b) => b[1] - a[1]).map(([tag], index) => [tag, index + 1]));
      const before = ranks(previous);
      const ships = (world.fandom.ships || []).slice().sort((a, b) => (Number(b.momentum) || 0) - (Number(a.momentum) || 0));
      const rows = ships.slice(0, 5).map((ship, index) => ({ tag: ship.tag, momentum: Number(ship.momentum) || 0, recentGrowth: Number(ship.recentGrowth) || 0, lastTurn: ship.lastTurn, rank: index + 1, rankChange: before.has(ship.tag) ? before.get(ship.tag) - (index + 1) : null }));
      const gains = new Map();
      for (const entry of history.slice(-3)) for (const [tag, delta] of Object.entries(entry.deltas || {})) gains.set(tag, (gains.get(tag) || 0) + (Number(delta) || 0));
      const riser = [...gains].filter(([, gain]) => gain > 0).sort((a, b) => b[1] - a[1])[0] || null;
      return { history, rows, riser };
    }

    cpDeltaHtml(value) {
      const n = Number(value) || 0;
      return `<span class="cp-delta ${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '▲' : n < 0 ? '▼' : ''}${n ? Math.abs(n) : '–'}</span>`;
    }

    cpRankText(change) {
      if (change == null) return '신규';
      return change > 0 ? `순위 ▲${change}` : change < 0 ? `순위 ▼${-change}` : '순위 유지';
    }

    cpHomeHtml(world) {
      const { rows, riser } = this.cpStats(world);
      const unread = Number(world.badges.trends) > 0;
      const head = `<div class="sf-h"><h2>CP Trends${unread ? '<span class="cp-new" aria-label="새 변화"></span>' : ''}</h2>${rows.length ? `<button data-act="cp-trends">그래프${icon('chevronRight', 14)}</button>` : ''}</div>`;
      if (!rows.length) return `${head}<div class="sf-empty">CP가 생기면 순위와 변화가 여기에 표시됩니다.</div>`;
      const list = rows.map((row) => `<button class="sf-row" data-act="cp-trends"><span class="cp-rank">${row.rank}</span><span class="sf-row-body"><span class="sf-row-title">#${this.esc(row.tag)}</span><span class="sf-row-sub">momentum ${row.momentum} · ${this.cpRankText(row.rankChange)}${row.lastTurn ? ` · ${this.esc(this.episodeAt(row.lastTurn) || `turn ${row.lastTurn}`)}` : ''}</span></span>${this.cpDeltaHtml(row.recentGrowth)}</button>`).join('');
      return `${head}<div class="sf-list">${list}</div>${riser ? `<div class="cp-riser">급상승 · <b>#${this.esc(riser[0])}</b> 최근 3회 갱신 +${riser[1]}</div>` : ''}`;
    }

    async cpTrendsHtml() {
      const world = this.engine.world;
      await this.loadFanIndex();
      if (world === this.engine.world) this.engine.clearUnread('trends');
      const { history, rows } = this.cpStats(world);
      const points = history.slice(-40);
      const colors = ['#ff2d55', '#007aff', '#34c759', '#ff9500', '#af52de'];
      const tags = rows.map((row) => row.tag).filter((tag) => points.some((entry) => tag in (entry.ships || {}))).slice(0, 5);
      const header = `<div class="sf-h"><h2>CP Trends</h2></div>`;
      const table = rows.length ? `<div class="sf-h"><h2>현재 순위</h2></div><div class="sf-list">${rows.map((row) => `<div class="sf-row"><span class="cp-rank">${row.rank}</span><span class="sf-row-body"><span class="sf-row-title">#${this.esc(row.tag)}</span><span class="sf-row-sub">momentum ${row.momentum} · ${this.cpRankText(row.rankChange)}</span></span>${this.cpDeltaHtml(row.recentGrowth)}</div>`).join('')}</div>` : '';
      if (points.length < 1 || !tags.length) return `${header}<div class="sf-empty">아직 CP 변화 기록이 없습니다. 다음 팬덤 갱신부터 쌓입니다.</div>${table}`;
      const W = 340; const H = 210; const left = 30; const right = 12; const top = 10; const bottom = 30;
      const x = (index) => left + (points.length === 1 ? (W - left - right) / 2 : (index * (W - left - right)) / (points.length - 1));
      const y = (value) => top + ((100 - Utils.clamp(Number(value) || 0, -100, 100)) * (H - top - bottom)) / 200;
      // Fan-facing N화; turn only as a fallback or to tell apart several updates within one 화.
      const perEpisode = new Map();
      for (const entry of points) if (entry.episodeLabel) perEpisode.set(entry.episodeLabel, (perEpisode.get(entry.episodeLabel) || 0) + 1);
      const label = (entry) => (!entry.episodeLabel ? `T${entry.turn}` : perEpisode.get(entry.episodeLabel) > 1 ? `${entry.episodeLabel}·T${entry.turn}` : entry.episodeLabel);
      const grid = [-100, -50, 0, 50, 100].map((v) => `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#c7c7cc' : '#efeff4'}" stroke-width="1"/><text x="${left - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join('');
      const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
      const xLabels = labelIndexes.map((index) => `<text x="${x(index)}" y="${H - 10}" text-anchor="middle">${this.esc(label(points[index]))}</text>`).join('');
      const route = this.route || {};
      const selectedTag = tags.includes(route.tag) ? route.tag : tags[0];
      const selectedIndex = Number.isInteger(route.point) && route.point >= 0 && route.point < points.length ? route.point : points.length - 1;
      const series = tags.map((tag, n) => {
        const coords = points.map((entry, index) => (tag in (entry.ships || {}) ? [index, entry.ships[tag]] : null)).filter(Boolean);
        const line = coords.length > 1 ? `<polyline fill="none" stroke="${colors[n]}" stroke-width="${tag === selectedTag ? 2.5 : 1.6}" stroke-linejoin="round" points="${coords.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>` : '';
        const dots = coords.map(([i, v]) => `<g data-act="cp-point" data-i="${i}" data-tag="${this.esc(tag)}" style="cursor:pointer"><circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="9" fill="transparent"/><circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${tag === selectedTag && i === selectedIndex ? 4.5 : 2.6}" fill="${tag === selectedTag && i === selectedIndex ? '#fff' : colors[n]}" stroke="${colors[n]}" stroke-width="${tag === selectedTag && i === selectedIndex ? 2.5 : 0}"/></g>`).join('');
        return line + dots;
      }).join('');
      const legend = tags.map((tag, n) => `<span style="--c:${colors[n]}"><i></i>#${this.esc(tag)}</span>`).join('');
      const entry = points[selectedIndex];
      const detail = entry?.details?.[selectedTag];
      const value = entry?.ships?.[selectedTag];
      const delta = entry?.deltas?.[selectedTag];
      const info = `<div class="cp-point"><b>#${this.esc(selectedTag)}</b> · ${this.esc(label(entry))}<small>momentum ${value ?? '–'}${delta != null ? ` · 이번 갱신 ${delta > 0 ? '+' : ''}${delta}` : ' · 이번 갱신에서 변화 없음'}</small>${detail?.sceneLabel ? `<small>${this.esc(detail.sceneEpisodeLabel ? `${detail.sceneEpisodeLabel} · ` : '')}${this.esc(detail.sceneLabel)}</small>` : ''}${detail?.reason ? `<div>${this.esc(this.engine.fanText(detail.reason))}</div>` : ''}</div>`;
      return `${header}<div class="cp-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="상위 CP momentum 추이">${grid}${series}${xLabels}</svg><div class="cp-legend">${legend}</div></div>${info}${table}`;
    }

    sfSearchHtml(q, works, posts) {
      const needle = q.toLowerCase().replace(/^#/, '');
      const has = (...values) => values.some((value) => String(value || '').toLowerCase().includes(needle));
      const world = this.engine.world;
      const tags = [...new Set([...world.fandom.ships, ...world.fandom.tags].map((item) => item.tag).concat(works.flatMap((work) => [...(work.tags || []), work.ship].filter(Boolean))))].filter((tag) => has(tag)).slice(0, 6);
      const workHits = works.filter((work) => has(work.title, work.ship, work.caption, work.summary, work.seriesTitle, ...(work.tags || []))).slice(0, 8);
      const postHits = posts.filter((post) => has(post.title, post.body, post.category)).slice(0, 8);
      const tagRows = [this.sfRow({ act: 'px-tag', attrs: `data-tag="${this.esc(q.replace(/^#/, ''))}"`, color: '#0096fa', glyph: icon('search', 18), title: `Pixiv에서 “${this.esc(q)}” 검색` })]
        .concat(tags.map((tag) => this.sfRow({ act: 'px-tag', attrs: `data-tag="${this.esc(tag)}"`, color: this.sfTileColor(tag), glyph: this.esc(Array.from(tag)[0] || '#'), title: `#${this.esc(tag)}`, sub: 'CP · 태그' })));
      const workRows = workHits.map((work) => this.sfRow({ act: 'sf-pixiv', attrs: `data-id="${work.id}"`, color: '#0096fa', glyph: 'P', title: this.esc(work.title), sub: `pixiv · ${this.esc(this.pixivAuthor(work.authorId)?.name || work.authorId)} · ${(work.tags || []).slice(0, 3).map((tag) => `#${this.esc(tag)}`).join(' ')}` }));
      const postRows = postHits.map((post) => this.sfRow({ act: 'sf-reddit', attrs: `data-id="${post.id}"`, color: '#ff4500', glyph: icon('comment', 16), title: this.esc(post.title), sub: `${this.esc(this.communityName())} · ${this.esc(post.category)} · ▲ ${Fmt.compact(post.score)}`, time: Fmt.ago(post.createdAt) }));
      return `${this.sfHeader('CP · 태그')}<div class="sf-list">${tagRows.join('')}</div>${this.sfHeader(`Pixiv · ${workRows.length}`)}${workRows.length ? `<div class="sf-list">${workRows.join('')}</div>` : '<div class="sf-empty">일치하는 작품이 없습니다.</div>'}${this.sfHeader(`Reddit · ${postRows.length}`)}${postRows.length ? `<div class="sf-list">${postRows.join('')}</div>` : '<div class="sf-empty">일치하는 게시물이 없습니다.</div>'}`;
    }

    // ---------- pixiv ----------

    async pixivHtml() {
      const world = this.engine.world;
      await this.loadFanIndex();
      const all = (await this.db.getAllByWorld(STORES.pixivWorks, world.id)).map((work) => this.fanWork(work));
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
        if (world === this.engine.world) this.engine.clearUnread('pixiv');
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
        const body = this.pxReaderBody(this.engine.fanText(cached.text));
        pageCount = body.pages;
        readerHtml = `<div ${attr}>${body.html}<div class="px-pagecount">${pageCount} / ${pageCount} 페이지</div></div>`;
      } else {
        readerHtml = `<div class="px-generate"><button class="px-pill wide" data-act="px-generate" data-id="${work.id}">본문 생성하여 읽기</button><p>목표 ${Fmt.int(this.engine.fanworkTarget(work))}자 · ${this.esc(this.getSettings().fanworkLanguage)}<br>생성한 전문은 IndexedDB에 저장되어 다음부터 바로 열립니다.</p></div><div id="fanwork-stream" ${attr}></div>`;
      }
      const panel = this.route?.readerPanel ? `<div class="px-readerpanel"><div><span>글자 크기</span>${[['s', '작게'], ['m', '보통'], ['l', '크게']].map(([value, label]) => `<button class="${reader.size === value ? 'on' : ''}" data-act="px-reader-set" data-key="size" data-value="${value}">${label}</button>`).join('')}</div><div><span>글꼴</span>${[['gothic', '고딕'], ['mincho', '명조']].map(([value, label]) => `<button class="${reader.font === value ? 'on' : ''}" data-act="px-reader-set" data-key="font" data-value="${value}">${label}</button>`).join('')}</div><div><span>배경</span>${[['light', '화이트'], ['sepia', '세피아'], ['dark', '다크']].map(([value, label]) => `<button class="${reader.theme === value ? 'on' : ''}" data-act="px-reader-set" data-key="theme" data-value="${value}">${label}</button>`).join('')}</div></div>` : '';
      const seriesBox = work.seriesTitle ? `<div class="px-seriesbox"><div class="px-seriesbox-label">시리즈</div><button class="px-seriesbox-title" data-act="px-series" data-title="${this.esc(work.seriesTitle)}">${this.esc(work.seriesTitle)}</button><div class="px-nav">${next ? `<button data-act="px-work" data-id="${next.id}" data-replace="1">다음 화 #${series.number + 1}</button>` : '<button disabled>최신화입니다</button>'}${prev ? `<button data-act="px-work" data-id="${prev.id}" data-replace="1">이전 화 #${series.number - 1}</button>` : ''}</div></div>` : '';
      const continuity = cached?.continuity?.issues?.length ? `<div class="px-continuity">Fanverse continuity check${cached.revisionApplied ? ' · 수정 pass 적용됨' : ''}<br>${cached.continuity.issues.map((issue) => `· ${this.esc(issue)}`).join('<br>')}</div>` : '';
      const others = all.filter((item) => item.authorId === work.authorId && item.id !== work.id).slice(0, 3);
      const related = all.filter((item) => item.id !== work.id && item.authorId !== work.authorId).map((item) => ({ item, score: (item.ship && item.ship === work.ship ? 3 : 0) + (item.tags || []).filter((tag) => (work.tags || []).includes(tag)).length })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((entry) => entry.item);
      return `${authorBar}<div class="px-detail-head"><div class="px-detail-title">${this.esc(work.title)}</div>${work.seriesTitle ? `<button class="px-detail-series" data-act="px-series" data-title="${this.esc(work.seriesTitle)}">${this.esc(work.seriesTitle)} #${series.number}</button>` : ''}${next ? `<button class="px-detail-next" data-act="px-work" data-id="${next.id}" data-replace="1" aria-label="다음 화">${icon('chevronRight', 24)}</button>` : ''}<div class="px-detail-cover"><span class="px-charbadge">${Fmt.int(chars)}글자</span>${this.pxCover(work, 'l')}</div></div>${likeBar}<div class="px-caption" data-act="px-caption-detail">${this.esc(work.caption || work.summary || '')}</div><div class="px-detail-name">${this.esc(work.title)}</div><div class="px-detail-tags">${this.pxTagLine(work)}</div><div class="px-detail-stats"><span>${icon('smile', 14)}${Fmt.int(this.pxLikeCount(work))}</span><span>${icon('heart', 14)}${Fmt.int(work.bookmarks)}</span><span>${icon('eye', 14)}${Fmt.int(work.views)}</span><span>${readingMinutes(chars)}분</span></div><div class="px-date">${this.esc(Fmt.pixivDate(work.createdAt))}${this.episodeAt(work.turn) ? ` · 본편 ${this.esc(this.episodeAt(work.turn))} 시점` : ''}</div><div class="px-readerbar"><button data-act="px-reader-top" aria-label="본문 처음으로">${icon('list', 22)}</button><button class="${this.route?.readerPanel ? 'on' : ''}" data-act="px-reader-panel" aria-label="표시 설정">${icon('textSize', 22)}</button><button class="${work.userBookmarked ? 'on' : ''}" data-act="px-bookmark" data-id="${work.id}" aria-label="북마크">${icon('bookmark', 22)}</button><button data-act="px-copy-text" data-id="${work.id}" aria-label="본문 복사">${icon('more', 22)}</button></div>${panel}${readerHtml}${cached ? likeBar : ''}${seriesBox}${continuity}<div style="margin-top:24px;border-top:8px solid var(--px-bg2)"></div>${authorBar}${others.length ? `<div class="px-graylist">${others.map((item) => `<div class="px-graycard" data-act="px-work" data-id="${item.id}" data-replace="1"><div class="px-item-body">${item.seriesTitle ? `<div class="px-item-series">${this.esc(item.seriesTitle)}</div>` : ''}<div class="px-item-title">${this.esc(item.title)}</div><div class="px-item-stats" style="padding:0">${Fmt.int(item.fictionalCharacterCount)}글자</div><div class="px-item-tags" style="padding:0">${this.pxTagLine(item)}</div></div></div>`).join('')}</div><div style="padding:0 16px 8px"><button class="px-pill black" data-act="px-author" data-id="${this.esc(work.authorId)}">모두 보기</button></div>` : ''}<div class="px-section-title">이쪽도 추천드려요</div>${related.length ? `<div class="px-list">${related.map((item) => this.pxItemHtml(item)).join('')}</div>` : '<div class="empty" style="padding-top:8px">아직 추천할 작품이 없습니다.</div>'}`;
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
      return `<div class="rd-header"><button class="rd-iconbtn" data-act="rd-home" aria-label="${this.esc(this.communityName())} 홈">${icon('menu', 22)}</button><label class="rd-search">${icon('search', 18)}<span class="rd-search-chip">${this.rdLogo(20)}${this.esc(this.communityName())}</span><input data-rd-search placeholder="검색" value="${this.esc(q)}" enterkeyhint="search"></label>${this.rdAvatar('you', 32)}</div>`;
    }

    async redditHtml() {
      const world = this.engine.world;
      await this.loadFanIndex();
      const posts = (await this.db.getAllByWorld(STORES.redditPosts, world.id)).map((post) => this.fanPost(post));
      this.rdRevealed ||= new Set();
      this.rdCollapsed ||= new Set();
      const route = this.route || {};
      if (route.type === 'reddit-post') return this.rdDetailHtml(posts, route);
      if (world === this.engine.world) this.engine.clearUnread('reddit');
      const sort = route.sort || 'best';
      const tab = route.tab || 'feed';
      const q = String(route.q || '').trim().toLowerCase();
      const stats = this.rdStats(posts);
      const sortLabels = { best: ['베스트', 'rocket'], hot: ['인기', 'flame'], new: ['신규', 'sparkle'], top: ['톱', 'top'] };
      const sortMenu = route.sortMenu ? `<div class="rd-menu" style="right:16px;top:44px"><div class="rd-menu-title">정렬 기준</div>${Object.entries(sortLabels).map(([value, [label, iconName]]) => `<button class="${sort === value ? 'active' : ''}" data-act="rd-sort" data-sort="${value}">${icon(iconName, 20)}${label}</button>`).join('')}</div>` : '';
      const [c1, c2] = [RD_AVATARS[Fmt.seed(world.id, RD_AVATARS.length)], '#e5ebee'];
      const top = `${this.rdHeaderHtml(route.q || '')}<div class="rd-banner" style="--c1:${c1};--c2:${c2}"></div><div class="rd-comm"><span class="rd-comm-icon">${this.rdLogo(48)}</span><h1>${this.esc(this.communityName())}</h1></div><div class="rd-comm-meta"><b>${Fmt.compact(stats.members)}</b> 멤버 · <span style="color:#46d160">●</span> <b>${stats.online}</b> 온라인</div><div class="rd-comm-actions"><button class="rd-btn outline" data-act="rd-compose">${icon('plus', 18)}게시물 만들기</button><button class="rd-btn ${world.redditJoined ? 'outline' : 'black'}" data-act="rd-join">${world.redditJoined ? '가입됨' : '가입하기'}</button></div><div class="rd-tabs" style="position:relative"><button class="rd-tab ${tab === 'feed' ? 'active' : ''}" data-act="rd-tab" data-tab="feed">피드</button><button class="rd-tab ${tab === 'about' ? 'active' : ''}" data-act="rd-tab" data-tab="about">정보</button><span class="grow"></span>${tab === 'feed' ? `<button class="rd-sortbtn" data-act="rd-sort-menu" aria-haspopup="menu" aria-expanded="${Boolean(route.sortMenu)}">${sortLabels[sort][0]}${icon('chevronDown', 16)}</button><button class="rd-sortbtn" data-act="rd-noop" aria-label="보기 방식">${icon('cards', 18)}${icon('chevronDown', 16)}</button>` : ''}${sortMenu}</div>`;
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
      const rules = ['원작에서 확정된 내용과 팬 해석을 구분해서 쓰기', '최신 회차 내용은 스포일러 태그 필수', 'CP·캐릭터 비하 금지 — 해석은 자유, 공격은 금지', '밈은 밈 플레어로', '근거 없는 "공식 확정" 단정 금지'];
      return `<div class="rd-about"><div class="rd-about-card"><h2>${this.esc(this.communityName())}</h2><p>본편을 실시간으로 따라 읽는 가상 팬 커뮤니티입니다. 같은 원작을 보지만 해석은 저마다 다릅니다.</p><div style="font-size:12px;color:var(--rd-weak)">${icon('clock', 14).replace('class="ic ', 'style="display:inline;vertical-align:-2px" class="ic ')} 생성일 ${new Date(world.createdAt || Date.now()).toLocaleDateString('ko-KR')}</div><div class="rd-about-stats"><div><b>${Fmt.compact(stats.members)}</b>멤버</div><div><b>${stats.online}</b>온라인</div><div><b>${posts.length}</b>게시물</div></div></div><div class="rd-about-card"><h3>${this.esc(this.communityName())} 규칙</h3>${rules.map((rule, index) => `<div class="rd-rule"><span>${index + 1}</span>${this.esc(rule)}</div>`).join('')}</div>${flairs.size ? `<div class="rd-about-card"><h3>플레어</h3><div class="rd-flairs">${[...flairs].map(([name, count]) => `${this.rdFlair(name)}<span style="font-size:12px;color:var(--rd-weak);margin-right:6px">${count}</span>`).join('')}</div></div>` : ''}<div class="rd-about-card"><h3>활동 중인 멤버</h3>${world.personas.reddit.map((persona) => `<div class="rd-member">${this.rdAvatar(persona.name, 32)}<div>u/${this.esc(persona.name)}<small>${this.esc(persona.archetype)} · ${this.esc(persona.bias)}</small></div></div>`).join('')}</div></div>`;
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
      return `<div class="reddit-shell">${this.rdHeaderHtml()}<div class="rd-detail-head"><button class="rd-iconbtn filled" data-act="rd-back" aria-label="뒤로">${icon('back', 18)}</button>${this.rdLogo(32)}<div class="col"><span><b>${this.esc(this.communityName())}</b> <span class="dot">•</span> <time>${Fmt.ago(post.createdAt)}</time></span><span>${this.esc(name)}</span></div><span class="grow"></span><button class="rd-iconbtn" data-act="rd-noop" aria-label="더보기">${icon('more', 18)}</button></div><h1 class="rd-detail-title">${this.esc(post.title)}</h1><div class="rd-detail-body"><div class="rd-flairs">${this.rdFlair(post.category)}${post.spoiler ? `<span class="rd-spoiler-badge">${icon('warning', 12)}스포일러</span>` : ''}</div>${this.rdBody(post)}<p class="rd-canon-note">${this.episodeAt(post.turn) ? `본편 ${this.esc(this.episodeAt(post.turn))} 시점의 반응` : '본편 진행 중의 반응'}</p></div><div class="rd-detail-actions"><div class="rd-actions">${this.rdVote(post.id, post.userVote, post.score)}<button class="rd-pill" data-act="rd-noop">${icon('comment', 18)}${Fmt.compact(Math.max(comments.length, post.estimatedCommentCount || 0))}</button><button class="rd-pill" data-act="rd-share" data-id="${post.id}">${icon('share', 18)}공유</button></div></div><div class="rd-composer" data-act="rd-compose">대화 참여하기</div><div class="rd-csort"><span>정렬 기준:</span><button class="rd-sortbtn" data-act="rd-csort-menu" aria-haspopup="menu">${csortLabels[csort]}${icon('chevronDown', 16)}</button>${menu}</div>${route.focus ? `<div style="padding:0 16px"><button class="rd-morec" style="margin:0" data-act="rd-unfocus">${icon('back', 16)}전체 댓글 보기</button></div>` : ''}<div class="rd-comments">${tree || '<div class="empty" style="padding:24px 0">아직 댓글이 없습니다.</div>'}${!route.focus && post.hasMoreComments ? `<button class="rd-morec" data-act="rd-more" data-id="${post.id}">${icon('plusCircle', 20)}댓글 더 보기${remaining ? ` (약 ${remaining}개)` : ''}</button>` : ''}</div></div>`;
    }

    // ---------- books (RIDI mobile detail layout; EPUB export only, no in-app reader) ----------

    bookOptions() {
      return { userName: '', unifyDialogue: true, sceneMarkers: true, includeImages: true, ...(this.engine.world?.books || {}) };
    }

    // The open room's own thumbnail (world.chatCover, from Crack); a neutral title placeholder only
    // when there is none or it fails to load (see the error listener in bind()).
    bkCoverHtml(title) {
      const url = this.engine.world?.chatCover?.url;
      const label = this.esc(title || '');
      return `<div class="bk-cover">${url ? `<img src="${this.esc(url)}" alt="${label}" data-cover-fallback="${label}">` : `<div class="bk-ph">${label}</div>`}</div>`;
    }

    // Local summary of the synced active branch (the export itself re-reads the full log).
    async bookSummary() {
      const turns = await this.engine.allActiveTurns();
      await this.engine.fanReferenceIndex().catch(() => null);
      const scenes = this.engine.fanScenes?.scenes || turns.map(turnScene);
      const episodes = segmentEpisodes(scenes);
      const toc = [];
      episodes.forEach((number, index) => {
        let entry = toc[toc.length - 1];
        if (!entry || entry.number !== number) { entry = { number, from: index + 1, to: index + 1, place: null, time: null }; toc.push(entry); }
        entry.to = index + 1;
        if (!entry.place && scenes[index]?.place) entry.place = scenes[index].place;
        if (!entry.time && scenes[index]?.time) entry.time = scenes[index].time;
      });
      return { turns: turns.length, episodes: toc.length, toc };
    }

    async booksHtml() {
      // Thumbnail/story metadata are refreshed in the background; a change re-renders this screen.
      this.engine.refreshRoomMeta().then((changed) => { if (changed && this.open && this.view === 'books') this.render({ keepScroll: true }); }).catch(() => {});
      const world = this.engine.world;
      const title = this.storyTitle();
      const route = this.route || {};
      const summary = await this.bookSummary();
      if (route.type === 'book') return this.bookDetailHtml(world, title, route, summary);
      return `<div class="bk-page"><div class="bk-top"><h1>내 서재</h1></div><div class="bk-shelf"><button class="bk-book" data-act="bk-open">${this.bkCoverHtml(title)}<b>${this.esc(title || '제목 확인 중')}</b><small>${Fmt.int(summary.turns)}턴</small></button></div></div>`;
    }

    bookDetailHtml(world, title, route, summary) {
      const description = world.storyDescription || '';
      const tab = route.tab || (description ? 'intro' : 'toc');
      const updated = world.sync?.lastAt ? new Date(world.sync.lastAt).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '-';
      const original = world.storyName && world.storyName !== title ? `<div class="bk-line"><b>${this.esc(world.storyName)}</b> <i>원작</i></div>` : '';
      const tocItems = route.tocAll ? summary.toc : summary.toc.slice(0, 10);
      const toc = summary.toc.length
        ? `<ol class="bk-toc">${tocItems.map((entry) => `<li><b>${entry.number}화</b><span>${this.esc([entry.place, entry.time].filter(Boolean).join(' · '))}</span><i>${entry.from === entry.to ? `${entry.from}턴` : `${entry.from}–${entry.to}턴`}</i></li>`).join('')}</ol>${summary.toc.length > tocItems.length ? `<button class="bk-more" data-act="bk-toc-all">${summary.toc.length - tocItems.length}개 더보기</button>` : ''}`
        : '<p class="bk-empty">-</p>';
      const intro = `<p class="bk-intro ${route.introAll ? '' : 'clamp'}">${this.esc(description)}</p>${!route.introAll && description.length > 260 ? '<button class="bk-more" data-act="bk-intro-all">더보기</button>' : ''}`;
      const tabs = description ? `<div class="bk-tabs"><button class="${tab === 'intro' ? 'on' : ''}" data-act="bk-tab" data-tab="intro">작품 소개</button><button class="${tab === 'toc' ? 'on' : ''}" data-act="bk-tab" data-tab="toc">목차</button></div>` : '<div class="bk-tabs"><button class="on" disabled>목차</button></div>';
      return `<div class="bk-page"><div class="bk-top"><button class="bk-iconbtn" data-act="bk-back" aria-label="뒤로">${icon('back', 22)}</button></div>
<div class="bk-head">${this.bkCoverHtml(title)}<div class="bk-info"><div class="bk-crumb">캐릭터채팅<span>›</span>웹소설</div><h1 class="bk-title">${this.esc(title || '제목 확인 중')}</h1>${original}<div class="bk-line">총 ${Fmt.int(summary.episodes)}화 · ${Fmt.int(summary.turns)}턴</div></div></div>
<div class="bk-table"><div class="bk-table-k">EPUB</div><div class="bk-table-rows"><div><span>분량</span><b>${Fmt.int(summary.turns)}턴</b></div><div><span>회차</span><b>총 ${Fmt.int(summary.episodes)}화</b></div><div><span>업데이트</span><b>${this.esc(updated)}</b></div></div></div>
<div class="bk-sep"></div><section class="bk-sec"><h2>작품 정보</h2>${tabs}${tab === 'intro' && description ? intro : toc}</section><div class="bk-grow"></div>
<div class="bk-bar"><button class="bk-barbtn" data-act="bk-options" aria-label="EPUB 설정">${icon('gear', 22)}</button><button class="bk-buy" data-act="bk-export" ${title ? '' : 'disabled'}>EPUB 다운로드</button></div></div>`;
    }

    openBookOptions() {
      const options = this.bookOptions();
      const toggle = (key, label) => `<label class="bk-stoggle"><span>${label}</span><input type="checkbox" data-book-setting="${key}" ${options[key] ? 'checked' : ''}></label>`;
      this.openSheet(`<div class="sh-grab"></div><h2 class="sh-title">EPUB 설정</h2><label class="bk-sfield"><span>내 캐릭터 이름</span><input data-book-setting="userName" value="${this.esc(options.userName)}" placeholder="Crack 프로필 이름 사용" autocomplete="off"></label>${toggle('unifyDialogue', '내 대사를 「이름 | "대사"」로 통일')}${toggle('sceneMarkers', '시간·장소 구분 표시')}${toggle('includeImages', '이미지 포함')}<button class="sh-btn" data-sheet-close>완료</button>`, { dismissible: true });
    }

    async startEpubExport(button) {
      if (this.exporting) return;
      this.exporting = true;
      button?.classList.add('pressed');
      setTimeout(() => button?.classList.remove('pressed'), 180);
      const steps = [['fetch', '전체 로그 불러오는 중'], ['clean', '본문 정리 중'], ['images', '이미지 수집 중'], ['package', 'EPUB 만드는 중'], ['done', '완료']];
      const sheet = this.openSheet(`<div class="sh-grab"></div><h2 class="sh-title">EPUB 만들기</h2><div class="sh-sub">${this.esc(this.storyTitle() || '')}</div><ol class="sh-steps">${steps.map(([id, label]) => `<li data-step="${id}"><span class="sh-dot"></span><span>${label}</span><span class="sh-detail"></span></li>`).join('')}</ol><div class="sh-result" hidden></div><button class="sh-btn" data-sheet-close hidden>닫기</button>`);
      const order = steps.map(([id]) => id);
      let current = null;
      const setStep = (id, detail = '') => {
        const index = order.indexOf(id);
        sheet.querySelectorAll('.sh-steps li').forEach((item, i) => {
          item.classList.toggle('done', i < index || (id === 'done' && i === index));
          item.classList.toggle('active', i === index && id !== 'done');
        });
        if (detail != null) { const slot = sheet.querySelector(`[data-step="${id}"] .sh-detail`); if (slot) slot.textContent = detail; }
        current = id;
      };
      const result = sheet.querySelector('.sh-result');
      const close = sheet.querySelector('[data-sheet-close]');
      try {
        this.bookExporter ||= new BookExporter(this.engine);
        const done = await this.bookExporter.export(this.bookOptions(), (id, detail) => setStep(id, detail));
        setStep('done', '');
        const notes = [`${done.fileName}`, `${done.chapters}화 · 이미지 ${done.images.embedded}개${done.images.failed ? ` · ${done.images.failed}개 제외` : ''} · 표지 ${done.coverFromThumbnail ? '채팅방 썸네일' : '기본 표지'}`];
        if (done.warning) notes.push(done.warning);
        result.hidden = false; result.dataset.kind = 'ok'; result.textContent = notes.join('\n');
        close.hidden = false;
        if (!done.warning && !done.images.failed) setTimeout(() => { if (this.sheet === sheet) this.closeSheet(); }, 2400);
      } catch (error) {
        const item = current && sheet.querySelector(`[data-step="${current}"]`);
        if (item) { item.classList.remove('active'); item.classList.add('error'); }
        result.hidden = false; result.dataset.kind = 'error'; result.textContent = `EPUB을 만들지 못했습니다.\n${error.message}`;
        close.hidden = false;
      } finally {
        this.exporting = false;
      }
    }

    // ---------- settings (iOS Settings-style navigation) ----------
    // Root list → category pages (route { type: 'settings', page }). Setting keys are unchanged; this
    // is presentation only. Each page shows one concern; provider-specific fields appear only on the
    // connection page of the selected backend, and low-level details live under Advanced.

    stRow({ act = 'st-page', attrs = '', color = '#8e8e93', glyph = '', label, value = '', chevron = true, cls = '' }) {
      return `<button class="st-row ${cls}" data-act="${act}" ${attrs}>${glyph ? `<span class="st-ico" style="--t:${color}">${glyph}</span>` : ''}<span class="st-row-label">${label}</span>${value ? `<span class="st-row-value">${value}</span>` : ''}${chevron ? icon('chevronRight', 16, 'st-chev') : ''}</button>`;
    }

    stHeader(title, subtitle = '') {
      return `<div class="st-title">${this.esc(title)}</div>${subtitle ? `<div class="st-sub">${subtitle}</div>` : ''}`;
    }

    providerLabel(id) { return PROVIDERS.find((provider) => provider.id === id)?.label || id; }

    // [dotClass, text] for the selected (or given) provider.
    providerStatus(provider = this.getSettings().provider) {
      const s = this.getSettings();
      const time = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      if (provider === 'developer') return s.apiKey ? ['ok', 'API key 설정됨'] : ['bad', '설정 필요 — API key가 없습니다'];
      if (provider === 'vertex') {
        const vertex = this.engine.gemini.vertexStatus();
        if (!s.vertexProjectId) return ['bad', '설정 필요 — Project ID가 없습니다'];
        if (vertex.authenticated) return ['ok', `연결 가능 · access token 약 ${Math.ceil(vertex.expiresInSeconds / 60)}분 남음`];
        return ['bad', vertex.hasToken ? 'access token 만료 — Google 재인증 필요' : '로그인 필요 — Google 로그인을 하세요'];
      }
      const status = this.engine.gemini.firebaseStatus();
      if (status.empty) return ['', '설정 필요 — Firebase Web Config를 입력하세요'];
      if (!status.configured) return ['bad', `설정 필요 — ${status.missingRequired.join(', ')} 값이 없습니다`];
      if (status.phase === 'error') return ['bad', `초기화 실패\n${status.error}`];
      if (status.lastTest?.ok) return ['ok', `Firebase 연결됨\nProject: ${status.projectId} · Model: ${modelLabel(s)} (${time(status.lastTest.at)})`];
      if (status.lastTest) return ['bad', `연결 실패\n${status.lastTest.message}`];
      return ['warn', `설정됨 · 연결 테스트 전\nProject: ${status.projectId}`];
    }

    statusRow([dot, text]) {
      return `<div class="st-status"><span class="st-dot ${dot}"></span><span>${this.esc(text)}</span></div>`;
    }

    settingsHtml() {
      const page = this.route?.type === 'settings' ? this.route.page : null;
      const pages = {
        ai: () => this.stAiHtml(),
        'ai-backend': () => this.stBackendHtml(),
        'ai-model': () => this.stModelHtml(),
        'ai-connection': () => this.stConnectionHtml(),
        generation: () => this.stGenerationHtml(),
        fanwork: () => this.stFanworkHtml(),
        data: () => this.stDataHtml(),
        appearance: () => this.stAppearanceHtml(),
        advanced: () => this.stAdvancedHtml(),
      };
      return (pages[page] || (() => this.stRootHtml()))();
    }

    stRootHtml() {
      const s = this.getSettings();
      const [dot] = this.providerStatus();
      const row = (page, color, iconName, label, value = '') => this.stRow({ attrs: `data-page="${page}"`, color, glyph: icon(iconName, 17), label, value });
      return `${this.stHeader('Settings')}<div class="st-card st-list">${row('ai', '#5e5ce6', 'sparkle', 'AI', `<span class="st-dot ${dot}"></span>${this.esc(this.providerLabel(s.provider))}`)}${row('generation', '#ff9500', 'pen', 'Generation', this.esc(s.activity))}${row('fanwork', '#0096fa', 'bookmark', 'Fanwork', this.esc(s.fanworkLanguage))}</div><div class="st-card st-list" style="margin-top:22px">${row('data', '#34c759', 'list', 'Data')}${row('appearance', '#007aff', 'textSize', 'Appearance')}${row('advanced', '#8e8e93', 'gear', 'Advanced')}</div><div class="st-foot">RP Fanverse ${APP_VERSION}</div>`;
    }

    stAiHtml() {
      const s = this.getSettings();
      const proNeedsAppCheck = s.provider === 'firebase' && s.modelPreset === 'gemini-3.1-pro-preview' && s.appCheckMode === 'off';
      return `${this.stHeader('AI')}<div class="st-section">Backend</div><div class="st-card st-list">${this.stRow({ attrs: 'data-page="ai-backend"', label: 'Backend', value: this.esc(this.providerLabel(s.provider)) })}</div><div class="st-section">Model</div><div class="st-card st-list">${this.stRow({ attrs: 'data-page="ai-model"', label: 'Model', value: this.esc(modelLabel(s)) })}</div><div class="st-section">Connection</div><div class="st-card st-list">${this.statusRow(this.providerStatus())}${this.stRow({ attrs: 'data-page="ai-connection"', label: '연결 설정', value: this.esc(this.providerLabel(s.provider)) })}<button class="st-btn" data-action="test-provider">연결 테스트${icon('chevronRight', 16)}</button></div>${proNeedsAppCheck ? '<div class="st-note warn">Firebase AI에서 Gemini 3.1 Pro는 App Check enforcement가 켜진 프로젝트에서만 호출됩니다 (아니면 HTTP 403). 연결 설정의 App Check를 확인하세요.</div>' : ''}`;
    }

    stBackendHtml() {
      const s = this.getSettings();
      const notes = { developer: '직접 Gemini API key', vertex: 'Google Cloud 프로젝트 · OAuth 로그인', firebase: '내 Firebase Web Config · Firebase AI Logic' };
      return `${this.stHeader('Backend')}<div class="st-card st-list">${PROVIDERS.map((provider) => `<button class="st-row st-pick" data-act="set-provider" data-provider="${provider.id}"><span class="st-row-label">${provider.label}<small>${notes[provider.id]}</small></span>${s.provider === provider.id ? icon('check', 18, 'st-check') : ''}</button>`).join('')}</div><div class="st-note">Backend를 바꿔도 각 provider의 저장된 설정은 그대로 유지됩니다.</div>`;
    }

    stModelHtml() {
      const s = this.getSettings();
      const options = [...MODEL_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, sub: preset.id })), { id: 'custom', label: 'Custom model ID', sub: s.modelPreset === 'custom' ? resolveModelId(s) : '직접 입력' }];
      return `${this.stHeader('Model')}<div class="st-card st-list">${options.map((option) => `<button class="st-row st-pick" data-act="set-model" data-model="${option.id}"><span class="st-row-label">${this.esc(option.label)}<small>${this.esc(option.sub)}</small></span>${s.modelPreset === option.id ? icon('check', 18, 'st-check') : ''}</button>`).join('')}</div>${s.modelPreset === 'custom' ? `<div class="st-section">Custom model ID</div><div class="st-card"><label class="st-field"><input data-setting="customModelId" value="${this.esc(s.customModelId)}" placeholder="예: gemini-3.7-flash" autocomplete="off"></label></div>` : ''}<div class="st-note">모든 Backend에 같은 모델 설정이 적용됩니다. 기본값은 Gemini 3.8 Flash입니다.</div>`;
    }

    stConnectionHtml() {
      const s = this.getSettings();
      const body = s.provider === 'vertex' ? this.stVertexHtml(s) : s.provider === 'firebase' ? this.stFirebaseHtml(s) : this.stDeveloperHtml(s);
      return `${this.stHeader('연결 설정', this.esc(this.providerLabel(s.provider)))}${body}`;
    }

    stDeveloperHtml(s) {
      return `<div class="st-card">${this.statusRow(this.providerStatus('developer'))}<label class="st-field"><span>Gemini API key · GM storage에만 저장, export 제외</span><input type="password" data-setting="apiKey" value="${this.esc(s.apiKey)}" autocomplete="off" placeholder="AIza…"></label><button class="st-btn" data-action="test-developer">Gemini API 연결 테스트${icon('chevronRight', 16)}</button></div>`;
    }

    stVertexHtml(s) {
      const vertex = this.engine.gemini.vertexStatus();
      return `<div class="st-card">${this.statusRow(this.providerStatus('vertex'))}<label class="st-field"><span>Google Cloud Project ID</span><input data-setting="vertexProjectId" value="${this.esc(s.vertexProjectId)}" placeholder="my-gcp-project" autocomplete="off"></label><label class="st-field"><span>Location · global 권장</span><input data-setting="vertexLocation" value="${this.esc(s.vertexLocation)}" list="rpf-vertex-locations" placeholder="global"><datalist id="rpf-vertex-locations"><option value="global"><option value="us"><option value="eu"><option value="us-central1"><option value="asia-northeast3"></datalist></label><label class="st-field"><span>OAuth 2.0 Client ID (웹 애플리케이션)</span><input data-setting="vertexOAuthClientId" value="${this.esc(s.vertexOAuthClientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off"></label><button class="st-btn" data-action="vertex-auth">${vertex.hasToken ? 'Google 재인증' : 'Google 로그인'}${icon('chevronRight', 16)}</button><button class="st-btn" data-action="test-vertex">Vertex AI 연결 테스트${icon('chevronRight', 16)}</button><button class="st-btn danger" data-action="vertex-revoke" ${vertex.hasToken ? '' : 'disabled'}>토큰 폐기 (로그아웃)</button></div><details class="st-details" style="margin-top:12px"><summary>설정 방법 ${icon('chevronDown', 16)}</summary><ol class="st-steps"><li>Google Cloud 프로젝트에 결제 계정을 연결하고 Vertex AI API를 사용 설정합니다.</li><li>로그인할 계정에 Vertex AI User 역할을 부여합니다.</li><li>OAuth 동의 화면을 구성하고 “웹 애플리케이션” OAuth 클라이언트를 만든 뒤, 승인된 JavaScript 원본에 <code class="st-code">https://crack.wrtn.ai</code>를 추가합니다.</li><li>Client ID를 위에 입력 → Google 로그인 → 연결 테스트. 토큰은 약 1시간 뒤 만료됩니다.</li></ol></details><div class="st-note">API version · 수동 access token · endpoint는 Advanced에 있습니다.</div>`;
    }

    stFirebaseHtml(s) {
      const check = validateFirebaseConfig(s.firebaseConfig);
      const c = check.config;
      const mask = (value) => (value ? `${'•'.repeat(8)}${this.esc(value.slice(-4))}` : '없음');
      const summary = check.empty ? '<div class="st-kv"><span>Firebase Web Config</span><span>미설정</span></div>' : `<div class="st-kv"><span>Project</span><span>${this.esc(c.projectId || '없음')}</span></div><div class="st-kv"><span>App ID</span><span>${c.appId ? '설정됨' : '없음'}</span></div><div class="st-kv"><span>API Key</span><span>${mask(c.apiKey)}</span></div>`;
      const fieldLabels = { apiKey: 'API Key', authDomain: 'Auth Domain', projectId: 'Project ID', storageBucket: 'Storage Bucket', messagingSenderId: 'Messaging Sender ID', appId: 'App ID' };
      const [acDot, acText] = this.appCheckStatus(s);
      return `<div class="st-card">${this.statusRow(this.providerStatus('firebase'))}${summary}<button class="st-btn" data-action="test-firebase" ${check.ok ? '' : 'disabled'}>연결 테스트${icon('chevronRight', 16)}</button></div>${check.ok && check.missingRecommended.length ? `<div class="st-note">권장 항목 미입력: ${check.missingRecommended.map((key) => fieldLabels[key]).join(', ')} (AI 호출에는 필수 아님)</div>` : ''}
<div class="st-section">Firebase Web Config JSON</div><div class="st-card"><label class="st-field"><span>Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)의 config를 붙여넣으세요. JSON 또는 <code class="st-code">const firebaseConfig = {…}</code> 형식 모두 가능합니다.</span><textarea data-firebase-json spellcheck="false" placeholder='{\n  "apiKey": "…",\n  "authDomain": "…",\n  "projectId": "…",\n  "storageBucket": "…",\n  "messagingSenderId": "…",\n  "appId": "…"\n}'></textarea></label><div class="st-result" data-firebase-result hidden></div><button class="st-btn" data-action="firebase-apply-json">적용${icon('chevronRight', 16)}</button></div>
<details class="st-details" style="margin-top:12px"><summary>개별 필드 편집 ${icon('chevronDown', 16)}</summary>${FIREBASE_CONFIG_FIELDS.map((key) => `<label class="st-field"><span>${fieldLabels[key]}${FIREBASE_REQUIRED_FIELDS.includes(key) ? ' · 필수' : ''}</span><input ${key === 'apiKey' ? 'type="password"' : ''} data-firebase-field="${key}" value="${this.esc(c[key])}" autocomplete="off" spellcheck="false"></label>`).join('')}</details>
<details class="st-details" style="margin-top:12px"><summary>App Check (선택) ${icon('chevronDown', 16)}</summary><label class="st-field"><span>Provider</span><select data-setting="appCheckMode"><option value="off" ${s.appCheckMode === 'off' ? 'selected' : ''}>사용 안 함</option><option value="recaptcha-enterprise" ${s.appCheckMode === 'recaptcha-enterprise' ? 'selected' : ''}>reCAPTCHA Enterprise (권장)</option><option value="debug" ${s.appCheckMode === 'debug' ? 'selected' : ''}>디버그 토큰 (개인 기기 전용)</option></select></label>${s.appCheckMode === 'recaptcha-enterprise' ? `<label class="st-field"><span>reCAPTCHA Enterprise site key</span><input data-setting="appCheckSiteKey" value="${this.esc(s.appCheckSiteKey)}" placeholder="6L…" autocomplete="off"></label>` : ''}${s.appCheckMode === 'debug' ? `<label class="st-field"><span>디버그 토큰 · GM storage에만 저장 · 공유 금지</span><input type="password" data-setting="appCheckDebugToken" value="${this.esc(s.appCheckDebugToken)}" autocomplete="off"></label>` : ''}${this.statusRow([acDot, acText])}<div class="st-note" style="padding:8px 14px 12px">Firebase AI Logic은 2026-11-02부터 App Check enforcement가 필수이며, 일부 모델(Gemini 3.1 Pro 등)은 지금도 필요합니다. reCAPTCHA Enterprise 키의 허용 도메인에 <code class="st-code">crack.wrtn.ai</code>를 추가하고 Firebase 콘솔 App Check에 등록한 뒤 enforcement를 켜세요.</div></details>
<div class="st-card" style="margin-top:22px"><button class="st-btn danger" data-action="firebase-clear" ${check.empty ? 'disabled' : ''}>Firebase 설정 지우기</button></div>`;
    }

    appCheckStatus(s) {
      const status = this.engine.gemini.firebaseStatus();
      if (s.appCheckMode === 'off') return ['', 'App Check 사용 안 함'];
      if (status.appCheck === 'ok') return ['ok', `App Check 토큰 정상 · ${new Date(status.appCheckAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`];
      if (status.appCheck === 'error') return ['bad', `App Check 실패\n${status.appCheckError}`];
      return ['', '설정됨 · 첫 AI 요청 때 토큰을 발급합니다'];
    }

    stGenerationHtml() {
      const s = this.getSettings();
      const text = this.instructionDraft ? this.instructionDraft.text : s.globalGeminiInstruction;
      return `${this.stHeader('Generation')}<div class="st-section">Gemini 공통 지침</div><textarea class="gi-text" data-instruction-text spellcheck="false" placeholder="예: 일본 팬덤 말투를 자연스럽게 / 캐릭터 OOC 금지 / CP를 승패처럼 다루지 않기 / Reddit은 의견이 갈리게 …">${this.esc(text)}</textarea><div class="gi-meta"><span data-instruction-count>${Fmt.int(text.trim().length)}자</span><span data-instruction-state>${this.instructionDraft?.dirty ? '저장되지 않음' : '저장됨'}</span></div><div class="gi-actions"><button class="primary" data-action="save-instruction">저장</button><button data-action="reset-instruction">기본값 복원</button></div><details class="st-details" style="margin-top:12px"><summary>어떻게 적용되나요 ${icon('chevronDown', 16)}</summary><div class="st-note" style="padding:10px 14px 12px">내부 작업 지시(출력 형식, Canon 규칙)는 그대로 두고, 이 지침을 systemInstruction으로 함께 보냅니다. 적용: Canon 추출 · 팬덤 갱신 · Reddit 글/댓글 · Pixiv metadata · 팬픽 전문 · 장편 개요/섹션 · 연속성 수정. 제외: Continuity 검사(기계적 검증). 비워 두면 지침 없이 호출합니다.</div></details>
<div class="st-section">Fandom</div><div class="st-card"><label class="st-field"><span>Fandom activity</span><select data-setting="activity">${['Quiet', 'Normal', 'Active', 'Chaos'].map((value) => `<option ${s.activity === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="st-field"><span>Turns per update</span><input type="number" min="1" max="100" data-setting="turnsPerUpdate" value="${s.turnsPerUpdate}"></label><label class="st-inline"><span>Automatic update</span><input type="checkbox" data-setting="autoUpdate" ${s.autoUpdate ? 'checked' : ''}></label><button class="st-btn" data-action="update-now">처리 대기 turns 지금 갱신${icon('chevronRight', 16)}</button></div>`;
    }

    stFanworkHtml() {
      const s = this.getSettings();
      const reader = s.pixivReader;
      const select = (key, options) => `<select data-reader-setting="${key}">${options.map(([value, label]) => `<option value="${value}" ${reader[key] === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
      return `${this.stHeader('Fanwork')}<div class="st-section">생성</div><div class="st-card"><label class="st-field"><span>Language</span><input data-setting="fanworkLanguage" value="${this.esc(s.fanworkLanguage)}"></label><label class="st-field"><span>본문 길이</span><select data-setting="fanworkLengthMode"><option value="auto" ${s.fanworkLengthMode === 'auto' ? 'selected' : ''}>작품마다 자동 (단편 중심)</option><option value="custom" ${s.fanworkLengthMode === 'custom' ? 'selected' : ''}>직접 지정</option></select></label>${s.fanworkLengthMode === 'custom' ? `<label class="st-field"><span>Target length (characters) · 8,000 초과 시 개요 → 3섹션 → continuity check</span><input type="number" min="500" max="30000" data-setting="fanworkTargetLength" value="${s.fanworkTargetLength}"></label>` : ''}<label class="st-inline"><span>Streaming</span><input type="checkbox" data-setting="streaming" ${s.streaming ? 'checked' : ''}></label></div><div class="st-section">Reader</div><div class="st-card"><label class="st-field"><span>글자 크기</span>${select('size', [['s', '작게'], ['m', '보통'], ['l', '크게']])}</label><label class="st-field"><span>글꼴</span>${select('font', [['gothic', '고딕'], ['mincho', '명조']])}</label><label class="st-field"><span>배경</span>${select('theme', [['light', '화이트'], ['sepia', '세피아'], ['dark', '다크']])}</label></div>`;
    }

    stDataHtml() {
      return `${this.stHeader('Data')}<div class="st-section">현재 RP</div><div class="st-card st-list"><button class="st-btn" data-action="sync-now">지금 API 동기화${icon('chevronRight', 16)}</button><button class="st-btn" data-action="import-history">기존 로그를 원작으로 가져오기${icon('chevronRight', 16)}</button><button class="st-btn" data-action="export-world">현재 world 내보내기${icon('chevronRight', 16)}</button></div><div class="st-section danger">Danger Zone</div><div class="st-card st-list"><button class="st-btn" data-action="rebuild-canon">Canon rebuild (팬덤 보존)${icon('chevronRight', 16)}</button><button class="st-btn" data-action="export-all">모든 worlds 내보내기${icon('chevronRight', 16)}</button><button class="st-btn" data-action="import-data">데이터 가져오기 (JSON)${icon('chevronRight', 16)}</button><input type="file" accept="application/json" data-import-file hidden><button class="st-btn danger" data-action="reset-world">현재 Fanverse 전체 초기화</button></div><div class="st-note">Canon rebuild는 Canon을 다시 분석하므로 AI 사용량이 발생합니다. 전체 초기화는 현재 world의 Canon·팬덤·Pixiv·Reddit 데이터를 지우며 되돌릴 수 없습니다.</div>`;
    }

    stAppearanceHtml() {
      const s = this.getSettings();
      return `${this.stHeader('Appearance')}<div class="st-card"><label class="st-field"><span>UI scale (0.75–1.25)</span><input type="number" min="0.75" max="1.25" step="0.05" data-setting="uiScale" value="${s.uiScale}"></label></div>`;
    }

    stAdvancedHtml() {
      const s = this.getSettings();
      const world = this.engine.world;
      const vertex = this.engine.gemini.vertexStatus();
      const firebase = this.engine.gemini.firebaseStatus();
      const devEndpoint = `${GEMINI_BASE}/${resolveModelId(s)}:generateContent`;
      const vertexEndpoint = s.vertexProjectId ? buildVertexEndpoint(s, false) : '(Project ID 미설정)';
      const firebaseEndpoint = firebase.projectId ? `https://firebasevertexai.googleapis.com/v1beta/projects/${firebase.projectId}/locations/${s.firebaseLocation}/publishers/google/models/${resolveModelId(s)}:generateContent` : '(Firebase config 미설정)';
      const kv = (key, value) => `<div class="st-kv"><span>${key}</span><span>${value}</span></div>`;
      return `${this.stHeader('Advanced')}<div class="st-section">Vertex AI</div><div class="st-card"><label class="st-field"><span>API version</span><select data-setting="vertexApiVersion"><option value="v1" ${s.vertexApiVersion === 'v1' ? 'selected' : ''}>v1 (권장)</option><option value="v1beta1" ${s.vertexApiVersion === 'v1beta1' ? 'selected' : ''}>v1beta1</option></select></label><label class="st-field"><span>수동 access token · <code class="st-code">gcloud auth print-access-token</code> 결과, 약 1시간 유효</span><input type="password" data-vertex-manual-token autocomplete="off" placeholder="ya29.…"></label><button class="st-btn" data-action="vertex-manual-token">토큰 확인 후 적용${icon('chevronRight', 16)}</button>${kv('Token', vertex.hasToken ? `${vertex.source === 'manual' ? '수동' : 'OAuth'} · ${vertex.authenticated ? `${Math.ceil(vertex.expiresInSeconds / 60)}분 남음` : '만료'}` : '없음')}</div>
<div class="st-section">Firebase AI</div><div class="st-card"><label class="st-field"><span>Location (Agent Platform)</span><input data-setting="firebaseLocation" value="${this.esc(s.firebaseLocation)}" placeholder="global"></label>${kv('SDK 상태', this.esc({ idle: '미초기화 (사용 시 초기화)', ready: '초기화됨', error: '오류' }[firebase.phase] || firebase.phase))}</div>
<div class="st-section">Endpoint</div><div class="st-card"><div class="st-mono">Developer · ${this.esc(devEndpoint)}</div><div class="st-mono">Vertex · ${this.esc(vertexEndpoint)}</div><div class="st-mono">Firebase · ${this.esc(firebaseEndpoint)}</div></div>
<div class="st-section">진단</div><div class="st-card">${kv('App', APP_VERSION)}${kv('DB schema', DB_VERSION)}${kv('World', world ? this.esc(world.id) : '미연결')}${kv('채팅방 제목', world?.chatTitle ? `${this.esc(world.chatTitle)} · ${this.esc(world.chatTitleSource || '')}` : '미확인')}${world ? kv('Sync', `${this.esc(world.sync.adapter)} · ${this.esc(world.sync.status)}`) : ''}${world?.sync.error ? `<div class="st-status"><span class="st-dot bad"></span><span>${this.esc(world.sync.error)}</span></div>` : ''}${(this.startupIssues || []).map((issue) => `<div class="st-status"><span class="st-dot bad"></span><span>${this.esc(issue)}</span></div>`).join('')}${kv('이전 Prompt override', '보존됨 · 사용 안 함')}</div>`;
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
          // safari home
          case 'sf-open': return this.push(null, target.dataset.view);
          case 'cp-trends': return this.push({ type: 'cp-trends' }, 'home');
          case 'cp-point': return this.replace({ ...route, point: Number(target.dataset.i), tag: target.dataset.tag }, { keepScroll: true });
          case 'sf-clear': return this.replace({ ...route, q: '' });
          case 'sf-pixiv': return this.push({ type: 'pixiv-work', id }, 'pixiv');
          case 'sf-reddit': return this.push({ type: 'reddit-post', id }, 'reddit');
          case 'open-instruction': this.instructionDraft = null; return this.push({ type: 'settings', page: 'generation' }, 'settings');
          // settings navigation
          case 'st-page': return this.push({ type: 'settings', page: target.dataset.page }, 'settings');
          case 'set-provider': {
            const settings = this.getSettings();
            settings.provider = target.dataset.provider;
            await this.saveSettings(settings);
            this.engine.warnedProviderUnready = false;
            this.notify('success', `Backend: ${this.providerLabel(settings.provider)}`);
            return this.back();
          }
          case 'set-model': {
            const settings = this.getSettings();
            settings.modelPreset = target.dataset.model;
            await this.saveSettings(settings);
            if (settings.modelPreset === 'custom') return this.render({ keepScroll: true });
            this.notify('success', `Model: ${modelLabel(this.getSettings())}`);
            return this.back();
          }
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
            const record = await this.withButton(target, '본문 생성 중…', () => this.engine.generateFanwork(work, (text) => { if (stream?.isConnected) stream.innerHTML = this.pxReaderBody(text, { cursor: true }).html; }));
            if (!record) return; // the room changed while generating: nothing was saved
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
          case 'rd-join': { const joined = await this.engine.toggleRedditJoin(); this.notify('success', joined ? `${this.communityName()}에 가입했습니다.` : '가입을 취소했습니다.'); return this.render({ keepScroll: true }); }
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
          case 'rd-compose': this.notify('sync', `${this.communityName()}의 글과 댓글은 영구 페르소나들이 씁니다. 더 많은 반응은 "댓글 더 보기"로 불러오세요.`); return;
          case 'rd-more': {
            const post = await this.db.get(STORES.redditPosts, id);
            if (!post) return;
            const updated = await this.withButton(target, '댓글 생성 중…', () => this.engine.loadMoreRedditComments(post));
            if (!updated) return; // the room changed while generating: nothing was saved
            this.notify('success', '새 댓글을 저장했습니다.');
            return this.render({ keepScroll: true });
          }
          case 'rd-noop': return;
          // books
          case 'bk-open': return this.push({ type: 'book' }, 'books');
          case 'bk-back': return this.back();
          case 'bk-toc-all': return this.replace({ ...route, tocAll: true }, { keepScroll: true });
          case 'bk-intro-all': return this.replace({ ...route, introAll: true }, { keepScroll: true });
          case 'bk-tab': return this.replace({ ...route, tab: target.dataset.tab }, { keepScroll: true });
          case 'bk-options': return this.openBookOptions();
          case 'bk-export': return this.startEpubExport(target);
          default: return;
        }
      } catch (error) {
        this.notify('error', error.message);
      }
    }

    updateInstructionMeta() {
      const textarea = this.root.querySelector('[data-instruction-text]');
      if (!textarea) return;
      const count = this.root.querySelector('[data-instruction-count]');
      const state = this.root.querySelector('[data-instruction-state]');
      if (count) count.textContent = `${Fmt.int(textarea.value.trim().length)}자`;
      if (state) state.textContent = this.instructionDraft?.dirty ? '저장되지 않음' : '저장됨';
    }

    async testProvider(provider, button) {
      const label = this.providerLabel(provider);
      this.notify('sync', `${label} 연결 테스트 중… (${resolveModelId(this.getSettings())})`);
      try {
        const reply = await this.withButton(button, '테스트 중…', () => this.engine.gemini.testConnection(provider));
        this.engine.warnedProviderUnready = false;
        this.notify('success', `${label} 연결 성공 · 모델 응답: ${reply}`);
      } finally {
        if (this.view === 'settings') await this.render({ keepScroll: true });
      }
    }

    async handleAction(action, target) {
      if (!action) return;
      try {
        if (!this.engine.world && ['sync-now', 'update-now', 'import-history', 'rebuild-canon', 'export-world', 'reset-world'].includes(action)) throw new Error('RP world가 아직 연결되지 않았습니다. Crack 에피소드 페이지에서 잠시 후 다시 시도하세요.');
        if (action === 'save-instruction') {
          const text = this.root.querySelector('[data-instruction-text]').value;
          const settings = this.getSettings();
          settings.globalGeminiInstruction = text;
          await this.saveSettings(settings);
          this.instructionDraft = null;
          this.notify('success', text.trim() ? 'Gemini 공통 지침을 저장했습니다. 다음 요청부터 적용됩니다.' : '공통 지침을 비웠습니다. 지침 없이 호출합니다.');
          this.updateInstructionMeta();
          return;
        }
        if (action === 'reset-instruction') {
          const current = this.root.querySelector('[data-instruction-text]').value;
          if (current !== DEFAULT_GLOBAL_INSTRUCTION && !confirm('Gemini 공통 지침을 기본값으로 되돌릴까요?')) return;
          const settings = this.getSettings();
          settings.globalGeminiInstruction = DEFAULT_GLOBAL_INSTRUCTION;
          await this.saveSettings(settings);
          this.instructionDraft = null;
          this.notify('success', '기본 지침으로 복원했습니다.');
          await this.render({ keepScroll: true });
          return;
        }
        if (action === 'test-provider') { await this.testProvider(this.getSettings().provider, target); return; }
        if (action === 'test-firebase') { await this.testProvider('firebase', target); return; }
        if (action === 'test-developer') { await this.testProvider('developer', target); return; }
        if (action === 'test-vertex') { await this.testProvider('vertex', target); return; }
        if (action === 'vertex-auth') {
          this.notify('sync', 'Google 로그인 창을 여는 중…');
          await this.engine.gemini.authorizeVertex();
          this.engine.warnedProviderUnready = false;
          this.notify('success', 'Vertex AI access token을 받았습니다.'); await this.render({ keepScroll: true });
          this.engine.maybeUpdate().catch((error) => this.notify('error', error.message));
          return;
        }
        if (action === 'vertex-manual-token') {
          const input = this.root.querySelector('[data-vertex-manual-token]');
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
        if (action === 'firebase-apply-json') {
          const box = this.root.querySelector('[data-firebase-result]');
          const show = (kind, text) => { if (box) { box.hidden = false; box.dataset.kind = kind; box.textContent = text; } };
          let config;
          // The pasted text is never logged; messages only name fields.
          try { config = parseFirebaseConfigInput(this.root.querySelector('[data-firebase-json]').value); } catch (error) { show('error', error.message); this.notify('error', error.message); return; }
          const check = validateFirebaseConfig(config);
          if (!check.ok) {
            const message = `저장하지 않았습니다. 필수 값이 없습니다: ${check.missingRequired.join(', ')}`;
            show('error', message); this.notify('error', message); return;
          }
          const settings = this.getSettings();
          settings.firebaseConfig = check.config;
          await this.saveSettings(settings);
          this.engine.gemini.firebase.state.lastTest = null;
          this.notify('success', `Firebase config를 저장했습니다 · Project: ${check.config.projectId}${check.missingRecommended.length ? `\n권장 항목 미입력: ${check.missingRecommended.join(', ')}` : ''}`);
          await this.render({ keepScroll: true });
          return;
        }
        if (action === 'firebase-clear') {
          if (!confirm('저장된 Firebase Web Config를 지울까요? (Fanverse 데이터에는 영향 없음)')) return;
          const settings = this.getSettings();
          settings.firebaseConfig = { ...EMPTY_FIREBASE_CONFIG };
          await this.saveSettings(settings);
          this.engine.gemini.firebase.state.lastTest = null;
          this.notify('success', 'Firebase 설정을 지웠습니다.');
          await this.render({ keepScroll: true });
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
      if (input.matches('[data-instruction-text]')) {
        this.instructionDraft = { text: input.value, dirty: input.value !== this.getSettings().globalGeminiInstruction };
        this.updateInstructionMeta();
        return;
      }
      const searchKind = input.matches('[data-rd-search]') ? 'reddit' : input.matches('[data-sf-search]') ? 'home' : null;
      if (!searchKind) return;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(async () => {
        const value = input.value;
        const caret = input.selectionStart;
        if (searchKind === 'reddit' && this.route?.type === 'reddit-post') this.push({ q: value }, 'reddit');
        else { this.route = { ...(this.route || {}), q: value, ...(searchKind === 'reddit' ? { tab: 'feed' } : {}) }; await this.render({ keepScroll: searchKind === 'reddit' }); }
        const fresh = this.root.querySelector(searchKind === 'reddit' ? '[data-rd-search]' : '[data-sf-search]');
        if (fresh) { fresh.focus(); fresh.setSelectionRange(caret, caret); }
      }, 220);
    }

    handleKeydown(event) {
      if (event.key === 'Enter' && event.target.matches('[data-px-search]')) {
        const value = event.target.value.trim();
        if (value) this.push({ type: 'tag', tag: value }, 'pixiv');
      }
      if (event.key === 'Enter' && event.target.matches('[data-sf-search]')) {
        const value = event.target.value.trim();
        if (/^fandom:\/\/current\/?$/i.test(value)) { clearTimeout(this.searchTimer); this.replace({ q: '' }); }
        else event.target.blur();
      }
    }

    async handleChange(event) {
      const input = event.target;
      try {
        if (input.dataset.bookSetting && this.engine.world) {
          const key = input.dataset.bookSetting;
          this.engine.world.books = { ...this.bookOptions(), [key]: input.type === 'checkbox' ? input.checked : String(input.value || '').trim().slice(0, 40) };
          await this.engine.saveWorld();
          return;
        }
        if (input.dataset.readerSetting) {
          const settings = this.getSettings();
          settings.pixivReader = { ...settings.pixivReader, [input.dataset.readerSetting]: input.value };
          await this.saveSettings(settings);
          this.notify('success', '설정을 저장했습니다.');
          return;
        }
        if (input.dataset.firebaseField) {
          const settings = this.getSettings();
          settings.firebaseConfig = { ...settings.firebaseConfig, [input.dataset.firebaseField]: input.value };
          await this.saveSettings(settings);
          this.engine.gemini.firebase.state.lastTest = null;
          const check = validateFirebaseConfig(this.getSettings().firebaseConfig);
          if (check.ok || check.empty) this.notify('success', '저장했습니다.');
          else this.notify('error', `저장했습니다. 필수 값이 없습니다: ${check.missingRequired.join(', ')}`);
          await this.render({ keepScroll: true });
          return;
        }
        if (input.dataset.setting) {
          const settings = this.getSettings();
          let value = input.type === 'checkbox' ? input.checked : input.value;
          if (input.type === 'number') value = Number(value);
          settings[input.dataset.setting] = value;
          if (input.dataset.setting === 'vertexOAuthClientId') await this.engine.gemini.clearVertexToken();
          if (input.dataset.setting === 'fanworkTargetLength') settings.fanworkLengthMode = 'custom'; // typing a length is a deliberate choice
          await this.saveSettings(settings);
          if (input.dataset.setting === 'uiScale') this.host.style.setProperty('--ui-scale', String(this.getSettings().uiScale));
          this.notify('success', '설정을 저장했습니다.');
          if (['customModelId', 'apiKey', 'appCheckMode', 'appCheckSiteKey', 'appCheckDebugToken', 'firebaseLocation', 'vertexProjectId', 'vertexLocation', 'vertexApiVersion', 'vertexOAuthClientId', 'fanworkLengthMode', 'fanworkTargetLength'].includes(input.dataset.setting)) await this.render({ keepScroll: true });
          return;
        }
        if (input.matches('[data-import-file]') && input.files?.[0]) {
          const payload = JSON.parse(await input.files[0].text());
          await this.db.restore(payload); await this.engine.attach(this.engine.worldInfo);
          this.notify('success', 'Fanverse 데이터를 가져왔습니다.'); await this.render();
        }
      } catch (error) {
        this.notify('error', error.message);
      } finally {
        if (input.type === 'file') input.value = '';
      }
    }
  }

  // Node tests: the engine and its world guard are exposed too; nothing below (App, UI startup) runs.
  if (NODE_TEST_MODE) {
    Object.assign(globalThis.__RP_FANVERSE_TEST_HOOKS__, { FanverseEngine, StaleWorldError, isStaleWorldError, createWorld, STORES, scopedDatabase, PhoneUI });
    return;
  }

  class App {
    constructor() {
      this.db = new Database(); this.api = new CrackApiAdapter(); this.dom = new CrackDomFallbackAdapter();
      this.settings = normalizeSettings(); this.gemini = new GeminiClient(() => this.settings);
      this.engine = new FanverseEngine(this.db, this.api, this.dom, this.gemini, () => this.settings, (kind, message) => this.ui?.notify(kind, message));
      this.ui = new PhoneUI(this.engine, this.db, () => this.settings, (settings) => this.persistSettings(settings));
      // Called by the engine only for the attached room's own updates (stale rooms never reach the UI).
      this.engine.onFanContent = () => this.ui.fanContentArrived();
      this.lastUrl = '';
    }

    async persistSettings(settings) {
      this.settings = normalizeSettings(settings);
      await GMStore.set(SETTINGS_KEY, this.settings);
    }

    // Startup is ordered so the launcher appears before anything optional runs, and every step is
    // isolated: a failing step is logged and surfaced in the UI, never allowed to abort the rest.
    // Required: settings (falls back to defaults) → IndexedDB → launcher. Optional after the launcher:
    // Vertex token restore, world attach + sync.
    async step(name, task) {
      try {
        return await task();
      } catch (error) {
        console.warn(`[RP Fanverse] startup step "${name}" failed`, error);
        this.startupIssues.push(`${name}: ${error?.message || error}`);
        return undefined;
      }
    }

    async init() {
      this.startupIssues = [];
      this.ui.startupIssues = this.startupIssues;
      if (!GMStore.available()) this.startupIssues.push('GM storage: Tampermonkey GM_* 권한을 사용할 수 없어 설정이 이 페이지에서만 유지됩니다 (userscript header 확인)');
      await this.step('settings', async () => {
        // Legacy per-prompt overrides (LEGACY_PROMPTS_KEY) are left untouched and not read.
        await this.persistSettings(await GMStore.get(SETTINGS_KEY, {}));
      });
      await this.step('database', () => withTimeout(this.db.open(), 10000, 'IndexedDB를 열지 못했습니다 (10초 초과)'));
      try {
        this.ui.mount();
      } catch (error) {
        console.error('[RP Fanverse] launcher mount failed', error);
        return; // nothing below is reachable for the user without the launcher
      }
      if (this.startupIssues.length) this.ui.notify('error', `Fanverse 일부 초기화 실패 — Settings에서 확인하세요.\n${this.startupIssues.join('\n')}`);
      await this.step('vertex token', () => this.gemini.vertex.restore());
      // Firebase AI is not initialised here: FirebaseAIClient validates the saved config and loads the
      // bundled SDK only when the Firebase backend is actually used (a request or 연결 테스트).
      await this.step('world', () => this.routeChanged());
      setInterval(() => { this.routeChanged().catch((error) => console.warn('[RP Fanverse] route check failed', error)); }, 2000);
      setInterval(() => { if (this.engine.worldInfo && !document.hidden && !this.engine.syncing) this.engine.sync({ silent: true }).catch((error) => this.ui.notify('error', error.message)); }, Math.max(15, this.settings.pollSeconds) * 1000);
    }

    async routeChanged() {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      const info = parseWorldFromUrl(location.href);
      if (!info) { this.ui.hide(); this.ui.host.hidden = true; this.ui.host.style.display = 'none'; return; }
      this.ui.host.hidden = false; this.ui.host.style.display = '';
      try {
        await this.engine.attach(info);
      } catch (error) {
        this.lastUrl = ''; // retry on the next route check; the launcher stays usable meanwhile
        if (!this.attachWarned) { this.attachWarned = true; this.ui.notify('error', `RP world 연결 실패: ${error.message}`); }
        throw error;
      }
      this.attachWarned = false;
      this.ui.history = []; this.ui.route = null;
      this.ui.refreshBadges();
      if (this.ui.open) await this.ui.render();
      await this.engine.sync({ silent: true }).catch((error) => this.ui.notify('error', error.message));
      // Also when sync itself failed: the room title is independent of the message log.
      await this.engine.refreshChatTitle().catch((error) => console.warn('[RP Fanverse] chat title refresh failed', error));
      if (this.ui.open) await this.ui.render();
    }
  }

  // ---------- bundled Firebase Web SDK ----------
  // firebase/app + firebase/ai + firebase/app-check only, bundled by build/build.mjs with esbuild.
  // The bundle is wrapped in a function so it is evaluated lazily (after the launcher is mounted)
  // and stays private to this userscript. `fetch` inside the bundle is rebound to gmFetch.
  let firebaseSdk = null;
  function getFirebaseSdk() {
    if (!firebaseSdk) firebaseSdk = createFirebaseSdk(gmFetch);
    return firebaseSdk;
  }

  /* eslint-disable */
  function createFirebaseSdk(__rpfFetch) {
    // >>> FIREBASE SDK BUNDLE >>>
    // firebase@12.19.0 (app, ai, app-check) · esbuild iife · generated by build/build.mjs — do not edit by hand
var RpfFirebase=(()=>{var de=Object.defineProperty;var tn=Object.getOwnPropertyDescriptor;var nn=Object.getOwnPropertyNames;var sn=Object.prototype.hasOwnProperty;var rn=(t,e)=>{for(var n in e)de(t,n,{get:e[n],enumerable:!0})},on=(t,e,n,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of nn(e))!sn.call(t,r)&&r!==n&&de(t,r,{get:()=>e[r],enumerable:!(s=tn(e,r))||s.enumerable});return t};var an=t=>on(de({},"__esModule",{value:!0}),t);var kr={};rn(kr,{AgentPlatformBackend:()=>$,CustomProvider:()=>le,getAI:()=>xt,getGenerativeModel:()=>Ut,initializeApp:()=>ve,initializeAppCheck:()=>Zt});var Qe=()=>{};var tt=function(t){let e=[],n=0;for(let s=0;s<t.length;s++){let r=t.charCodeAt(s);r<128?e[n++]=r:r<2048?(e[n++]=r>>6|192,e[n++]=r&63|128):(r&64512)===55296&&s+1<t.length&&(t.charCodeAt(s+1)&64512)===56320?(r=65536+((r&1023)<<10)+(t.charCodeAt(++s)&1023),e[n++]=r>>18|240,e[n++]=r>>12&63|128,e[n++]=r>>6&63|128,e[n++]=r&63|128):(e[n++]=r>>12|224,e[n++]=r>>6&63|128,e[n++]=r&63|128)}return e},cn=function(t){let e=[],n=0,s=0;for(;n<t.length;){let r=t[n++];if(r<128)e[s++]=String.fromCharCode(r);else if(r>191&&r<224){let i=t[n++];e[s++]=String.fromCharCode((r&31)<<6|i&63)}else if(r>239&&r<365){let i=t[n++],o=t[n++],a=t[n++],c=((r&7)<<18|(i&63)<<12|(o&63)<<6|a&63)-65536;e[s++]=String.fromCharCode(55296+(c>>10)),e[s++]=String.fromCharCode(56320+(c&1023))}else{let i=t[n++],o=t[n++];e[s++]=String.fromCharCode((r&15)<<12|(i&63)<<6|o&63)}}return e.join("")},X={byteToCharMap_:null,charToByteMap_:null,byteToCharMapWebSafe_:null,charToByteMapWebSafe_:null,ENCODED_VALS_BASE:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",get ENCODED_VALS(){return this.ENCODED_VALS_BASE+"+/="},get ENCODED_VALS_WEBSAFE(){return this.ENCODED_VALS_BASE+"-_."},HAS_NATIVE_SUPPORT:typeof atob=="function",encodeByteArray(t,e){if(!Array.isArray(t))throw Error("encodeByteArray takes an array as a parameter");this.init_();let n=e?this.byteToCharMapWebSafe_:this.byteToCharMap_,s=[];for(let r=0;r<t.length;r+=3){let i=t[r],o=r+1<t.length,a=o?t[r+1]:0,c=r+2<t.length,l=c?t[r+2]:0,h=i>>2,f=(i&3)<<4|a>>4,g=(a&15)<<2|l>>6,q=l&63;c||(q=64,o||(g=64)),s.push(n[h],n[f],n[g],n[q])}return s.join("")},encodeString(t,e){return this.HAS_NATIVE_SUPPORT&&!e?btoa(t):this.encodeByteArray(tt(t),e)},decodeString(t,e){return this.HAS_NATIVE_SUPPORT&&!e?atob(t):cn(this.decodeStringToByteArray(t,e))},decodeStringToByteArray(t,e){this.init_();let n=e?this.charToByteMapWebSafe_:this.charToByteMap_,s=[];for(let r=0;r<t.length;){let i=n[t.charAt(r++)],a=r<t.length?n[t.charAt(r)]:0;++r;let l=r<t.length?n[t.charAt(r)]:64;++r;let f=r<t.length?n[t.charAt(r)]:64;if(++r,i==null||a==null||l==null||f==null)throw new he;let g=i<<2|a>>4;if(s.push(g),l!==64){let q=a<<4&240|l>>2;if(s.push(q),f!==64){let en=l<<6&192|f;s.push(en)}}}return s},init_(){if(!this.byteToCharMap_){this.byteToCharMap_={},this.charToByteMap_={},this.byteToCharMapWebSafe_={},this.charToByteMapWebSafe_={};for(let t=0;t<this.ENCODED_VALS.length;t++)this.byteToCharMap_[t]=this.ENCODED_VALS.charAt(t),this.charToByteMap_[this.byteToCharMap_[t]]=t,this.byteToCharMapWebSafe_[t]=this.ENCODED_VALS_WEBSAFE.charAt(t),this.charToByteMapWebSafe_[this.byteToCharMapWebSafe_[t]]=t,t>=this.ENCODED_VALS_BASE.length&&(this.charToByteMap_[this.ENCODED_VALS_WEBSAFE.charAt(t)]=t,this.charToByteMapWebSafe_[this.ENCODED_VALS.charAt(t)]=t)}}},he=class extends Error{constructor(){super(...arguments),this.name="DecodeBase64StringError"}},ln=function(t){let e=tt(t);return X.encodeByteArray(e,!0)},fe=function(t){return ln(t).replace(/\./g,"")},J=function(t){try{return X.decodeString(t,!0)}catch(e){console.error("base64Decode failed: ",e)}return null};function H(){if(typeof self<"u")return self;if(typeof window<"u")return window;if(typeof global<"u")return global;throw new Error("Unable to locate global object.")}var un=()=>H().__FIREBASE_DEFAULTS__,dn=()=>{if(typeof process>"u"||typeof process.env>"u")return;let t=process.env.__FIREBASE_DEFAULTS__;if(t)return JSON.parse(t)},hn=()=>{if(typeof document>"u")return;let t;try{t=document.cookie.match(/__FIREBASE_DEFAULTS__=([^;]+)/)}catch{return}let e=t&&J(t[1]);return e&&JSON.parse(e)},fn=()=>{try{return Qe()||un()||dn()||hn()}catch(t){console.info(`Unable to get __FIREBASE_DEFAULTS__ due to: ${t}`);return}};var pe=()=>fn()?.config;var O=class{constructor(){this.reject=()=>{},this.resolve=()=>{},this.promise=new Promise((e,n)=>{this.resolve=e,this.reject=n})}wrapCallback(e){return(n,s)=>{n?this.reject(n):this.resolve(s),typeof e=="function"&&(this.promise.catch(()=>{}),e.length===1?e(n):e(n,s))}}};function G(){try{return typeof indexedDB=="object"}catch{return!1}}function nt(){return new Promise((t,e)=>{try{let n=!0,s="validate-browser-context-for-indexeddb-analytics-module",r=self.indexedDB.open(s);r.onsuccess=()=>{r.result.close(),n||self.indexedDB.deleteDatabase(s),t(!0)},r.onupgradeneeded=()=>{n=!1},r.onerror=()=>{e(r.error?.message||"")}}catch(n){e(n)}})}var pn="FirebaseError",C=class t extends Error{constructor(e,n,s){super(n),this.code=e,this.customData=s,this.name=pn,Object.setPrototypeOf(this,t.prototype),Error.captureStackTrace&&Error.captureStackTrace(this,P.prototype.create)}},P=class{constructor(e,n,s){this.service=e,this.serviceName=n,this.errors=s}create(e,...n){let s=n[0]||{},r=`${this.service}/${e}`,i=this.errors[e],o=i?gn(i,s):"Error",a=`${this.serviceName}: ${o} (${r}).`;return new C(r,a,s)}};function gn(t,e){try{let n=0,s="";for(;n<t.length;){let r=t.indexOf("{$",n);if(r===-1){s+=t.substring(n);break}let i=t.indexOf("}",r+2);if(i===-1){s+=t.substring(n);break}let o=t.substring(r+2,i),a=e[o];s+=t.substring(n,r)+(a!=null?String(a):`<${o}?>`),n=i+1}return s}catch{return t}}function Ze(t){return JSON.parse(t)}var mn=function(t){let e={},n={},s={},r="";try{let i=t.split(".");e=Ze(J(i[0])||""),n=Ze(J(i[1])||""),r=i[2],s=n.d||{},delete n.d}catch{}return{header:e,claims:n,data:s,signature:r}};var st=function(t){let e=mn(t).claims;return typeof e=="object"&&e.hasOwnProperty("iat")?e.iat:null};function Q(t,e){if(t===e)return!0;let n=Object.keys(t),s=Object.keys(e);for(let r of n){if(!s.includes(r))return!1;let i=t[r],o=e[r];if(et(i)&&et(o)){if(!Q(i,o))return!1}else if(i!==o)return!1}for(let r of s)if(!n.includes(r))return!1;return!0}function et(t){return t!==null&&typeof t=="object"}var Mr=14400*1e3;function Z(t){return t&&t._delegate?t._delegate:t}var _=class{constructor(e,n,s){this.name=e,this.instanceFactory=n,this.type=s,this.multipleInstances=!1,this.serviceProps={},this.instantiationMode="LAZY",this.onInstanceCreated=null}setInstantiationMode(e){return this.instantiationMode=e,this}setMultipleInstances(e){return this.multipleInstances=e,this}setServiceProps(e){return this.serviceProps=e,this}setInstanceCreatedCallback(e){return this.onInstanceCreated=e,this}};var M="[DEFAULT]";var ge=class{constructor(e,n){this.name=e,this.container=n,this.component=null,this.instances=new Map,this.instancesDeferred=new Map,this.instancesOptions=new Map,this.onInitCallbacks=new Map}get(e){let n=this.normalizeInstanceIdentifier(e);if(!this.instancesDeferred.has(n)){let s=new O;if(this.instancesDeferred.set(n,s),this.isInitialized(n)||this.shouldAutoInitialize())try{let r=this.getOrInitializeService({instanceIdentifier:n});r&&s.resolve(r)}catch{}}return this.instancesDeferred.get(n).promise}getImmediate(e){let n=this.normalizeInstanceIdentifier(e?.identifier),s=e?.optional??!1;if(this.isInitialized(n)||this.shouldAutoInitialize())try{return this.getOrInitializeService({instanceIdentifier:n})}catch(r){if(s)return null;throw r}else{if(s)return null;throw Error(`Service ${this.name} is not available`)}}getComponent(){return this.component}setComponent(e){if(e.name!==this.name)throw Error(`Mismatching Component ${e.name} for Provider ${this.name}.`);if(this.component)throw Error(`Component for ${this.name} has already been provided`);if(this.component=e,!!this.shouldAutoInitialize()){if(_n(e))try{this.getOrInitializeService({instanceIdentifier:M})}catch{}for(let[n,s]of this.instancesDeferred.entries()){let r=this.normalizeInstanceIdentifier(n);try{let i=this.getOrInitializeService({instanceIdentifier:r});s.resolve(i)}catch{}}}}clearInstance(e=M){this.instancesDeferred.delete(e),this.instancesOptions.delete(e),this.instances.delete(e)}async delete(){let e=Array.from(this.instances.values());await Promise.all([...e.filter(n=>"INTERNAL"in n).map(n=>n.INTERNAL.delete()),...e.filter(n=>"_delete"in n).map(n=>n._delete())])}isComponentSet(){return this.component!=null}isInitialized(e=M){return this.instances.has(e)}getOptions(e=M){return this.instancesOptions.get(e)||{}}initialize(e={}){let{options:n={}}=e,s=this.normalizeInstanceIdentifier(e.instanceIdentifier);if(this.isInitialized(s))throw Error(`${this.name}(${s}) has already been initialized`);if(!this.isComponentSet())throw Error(`Component ${this.name} has not been registered yet`);let r=this.getOrInitializeService({instanceIdentifier:s,options:n});for(let[i,o]of this.instancesDeferred.entries()){let a=this.normalizeInstanceIdentifier(i);s===a&&o.resolve(r)}return r}onInit(e,n){let s=this.normalizeInstanceIdentifier(n),r=this.onInitCallbacks.get(s)??new Set;r.add(e),this.onInitCallbacks.set(s,r);let i=this.instances.get(s);return i&&e(i,s),()=>{r.delete(e)}}invokeOnInitCallbacks(e,n){let s=this.onInitCallbacks.get(n);if(s)for(let r of s)try{r(e,n)}catch{}}getOrInitializeService({instanceIdentifier:e,options:n={}}){let s=this.instances.get(e);if(!s&&this.component&&(s=this.component.instanceFactory(this.container,{instanceIdentifier:En(e),options:n}),this.instances.set(e,s),this.instancesOptions.set(e,n),this.invokeOnInitCallbacks(s,e),this.component.onInstanceCreated))try{this.component.onInstanceCreated(this.container,e,s)}catch{}return s||null}normalizeInstanceIdentifier(e=M){return this.component?this.component.multipleInstances?e:M:e}shouldAutoInitialize(){return!!this.component&&this.component.instantiationMode!=="EXPLICIT"}};function En(t){return t===M?void 0:t}function _n(t){return t.instantiationMode==="EAGER"}var ee=class{constructor(e){this.name=e,this.providers=new Map}addComponent(e){let n=this.getProvider(e.name);if(n.isComponentSet())throw new Error(`Component ${e.name} has already been registered with ${this.name}`);n.setComponent(e)}addOrOverwriteComponent(e){this.getProvider(e.name).isComponentSet()&&this.providers.delete(e.name),this.addComponent(e)}getProvider(e){if(this.providers.has(e))return this.providers.get(e);let n=new ge(e,this);return this.providers.set(e,n),n}getProviders(){return Array.from(this.providers.values())}};var bn=[],p;(function(t){t[t.DEBUG=0]="DEBUG",t[t.VERBOSE=1]="VERBOSE",t[t.INFO=2]="INFO",t[t.WARN=3]="WARN",t[t.ERROR=4]="ERROR",t[t.SILENT=5]="SILENT"})(p||(p={}));var wn={debug:p.DEBUG,verbose:p.VERBOSE,info:p.INFO,warn:p.WARN,error:p.ERROR,silent:p.SILENT},Sn=p.INFO,yn={[p.DEBUG]:"log",[p.VERBOSE]:"log",[p.INFO]:"info",[p.WARN]:"warn",[p.ERROR]:"error"},An=(t,e,...n)=>{if(e<t.logLevel)return;let s=new Date().toISOString(),r=yn[e];if(r)console[r](`[${s}]  ${t.name}:`,...n);else throw new Error(`Attempted to log a message with an invalid logType (value: ${e})`)},D=class{constructor(e){this.name=e,this._logLevel=Sn,this._logHandler=An,this._userLogHandler=null,bn.push(this)}get logLevel(){return this._logLevel}set logLevel(e){if(!(e in p))throw new TypeError(`Invalid value "${e}" assigned to \`logLevel\``);this._logLevel=e}setLogLevel(e){this._logLevel=typeof e=="string"?wn[e]:e}get logHandler(){return this._logHandler}set logHandler(e){if(typeof e!="function")throw new TypeError("Value assigned to `logHandler` must be a function");this._logHandler=e}get userLogHandler(){return this._userLogHandler}set userLogHandler(e){this._userLogHandler=e}debug(...e){this._userLogHandler&&this._userLogHandler(this,p.DEBUG,...e),this._logHandler(this,p.DEBUG,...e)}log(...e){this._userLogHandler&&this._userLogHandler(this,p.VERBOSE,...e),this._logHandler(this,p.VERBOSE,...e)}info(...e){this._userLogHandler&&this._userLogHandler(this,p.INFO,...e),this._logHandler(this,p.INFO,...e)}warn(...e){this._userLogHandler&&this._userLogHandler(this,p.WARN,...e),this._logHandler(this,p.WARN,...e)}error(...e){this._userLogHandler&&this._userLogHandler(this,p.ERROR,...e),this._logHandler(this,p.ERROR,...e)}};var Tn=(t,e)=>e.some(n=>t instanceof n),rt,it;function On(){return rt||(rt=[IDBDatabase,IDBObjectStore,IDBIndex,IDBCursor,IDBTransaction])}function Cn(){return it||(it=[IDBCursor.prototype.advance,IDBCursor.prototype.continue,IDBCursor.prototype.continuePrimaryKey])}var ot=new WeakMap,Ee=new WeakMap,at=new WeakMap,me=new WeakMap,be=new WeakMap;function Rn(t){let e=new Promise((n,s)=>{let r=()=>{t.removeEventListener("success",i),t.removeEventListener("error",o)},i=()=>{n(S(t.result)),r()},o=()=>{s(t.error),r()};t.addEventListener("success",i),t.addEventListener("error",o)});return e.then(n=>{n instanceof IDBCursor&&ot.set(n,t)}).catch(()=>{}),be.set(e,t),e}function In(t){if(Ee.has(t))return;let e=new Promise((n,s)=>{let r=()=>{t.removeEventListener("complete",i),t.removeEventListener("error",o),t.removeEventListener("abort",o)},i=()=>{n(),r()},o=()=>{s(t.error||new DOMException("AbortError","AbortError")),r()};t.addEventListener("complete",i),t.addEventListener("error",o),t.addEventListener("abort",o)});Ee.set(t,e)}var _e={get(t,e,n){if(t instanceof IDBTransaction){if(e==="done")return Ee.get(t);if(e==="objectStoreNames")return t.objectStoreNames||at.get(t);if(e==="store")return n.objectStoreNames[1]?void 0:n.objectStore(n.objectStoreNames[0])}return S(t[e])},set(t,e,n){return t[e]=n,!0},has(t,e){return t instanceof IDBTransaction&&(e==="done"||e==="store")?!0:e in t}};function ct(t){_e=t(_e)}function vn(t){return t===IDBDatabase.prototype.transaction&&!("objectStoreNames"in IDBTransaction.prototype)?function(e,...n){let s=t.call(te(this),e,...n);return at.set(s,e.sort?e.sort():[e]),S(s)}:Cn().includes(t)?function(...e){return t.apply(te(this),e),S(ot.get(this))}:function(...e){return S(t.apply(te(this),e))}}function Dn(t){return typeof t=="function"?vn(t):(t instanceof IDBTransaction&&In(t),Tn(t,On())?new Proxy(t,_e):t)}function S(t){if(t instanceof IDBRequest)return Rn(t);if(me.has(t))return me.get(t);let e=Dn(t);return e!==t&&(me.set(t,e),be.set(e,t)),e}var te=t=>be.get(t);function ut(t,e,{blocked:n,upgrade:s,blocking:r,terminated:i}={}){let o=indexedDB.open(t,e),a=S(o);return s&&o.addEventListener("upgradeneeded",c=>{s(S(o.result),c.oldVersion,c.newVersion,S(o.transaction),c)}),n&&o.addEventListener("blocked",c=>n(c.oldVersion,c.newVersion,c)),a.then(c=>{i&&c.addEventListener("close",()=>i()),r&&c.addEventListener("versionchange",l=>r(l.oldVersion,l.newVersion,l))}).catch(()=>{}),a}var kn=["get","getKey","getAll","getAllKeys","count"],Nn=["put","add","delete","clear"],we=new Map;function lt(t,e){if(!(t instanceof IDBDatabase&&!(e in t)&&typeof e=="string"))return;if(we.get(e))return we.get(e);let n=e.replace(/FromIndex$/,""),s=e!==n,r=Nn.includes(n);if(!(n in(s?IDBIndex:IDBObjectStore).prototype)||!(r||kn.includes(n)))return;let i=async function(o,...a){let c=this.transaction(o,r?"readwrite":"readonly"),l=c.store;return s&&(l=l.index(a.shift())),(await Promise.all([l[n](...a),r&&c.done]))[0]};return we.set(e,i),i}ct(t=>({...t,get:(e,n,s)=>lt(e,n)||t.get(e,n,s),has:(e,n)=>!!lt(e,n)||t.has(e,n)}));var ye=class{constructor(e){this.container=e}getPlatformInfoString(){return this.container.getProviders().map(n=>{if(Ln(n)){let s=n.getImmediate();return`${s.library}/${s.version}`}else return null}).filter(n=>n).join(" ")}};function Ln(t){return t.getComponent()?.type==="VERSION"}var Ae="@firebase/app",dt="0.16.2";var I=new D("@firebase/app"),Pn="@firebase/app-compat",Mn="@firebase/analytics-compat",xn="@firebase/analytics",Un="@firebase/app-check-compat",$n="@firebase/app-check",Bn="@firebase/auth",Fn="@firebase/auth-compat",Hn="@firebase/database",Gn="@firebase/data-connect",Vn="@firebase/database-compat",jn="@firebase/functions",Wn="@firebase/functions-compat",zn="@firebase/installations",Kn="@firebase/installations-compat",Yn="@firebase/messaging",qn="@firebase/messaging-compat",Jn="@firebase/performance",Xn="@firebase/performance-compat",Qn="@firebase/remote-config",Zn="@firebase/remote-config-compat",es="@firebase/storage",ts="@firebase/storage-compat",ns="@firebase/firestore",ss="@firebase/ai",rs="@firebase/firestore-compat",is="firebase";var Te="[DEFAULT]",os={[Ae]:"fire-core",[Pn]:"fire-core-compat",[xn]:"fire-analytics",[Mn]:"fire-analytics-compat",[$n]:"fire-app-check",[Un]:"fire-app-check-compat",[Bn]:"fire-auth",[Fn]:"fire-auth-compat",[Hn]:"fire-rtdb",[Gn]:"fire-data-connect",[Vn]:"fire-rtdb-compat",[jn]:"fire-fn",[Wn]:"fire-fn-compat",[zn]:"fire-iid",[Kn]:"fire-iid-compat",[Yn]:"fire-fcm",[qn]:"fire-fcm-compat",[Jn]:"fire-perf",[Xn]:"fire-perf-compat",[Qn]:"fire-rc",[Zn]:"fire-rc-compat",[es]:"fire-gcs",[ts]:"fire-gcs-compat",[ns]:"fire-fst",[rs]:"fire-fst-compat",[ss]:"fire-vertex","fire-js":"fire-js",[is]:"fire-js-all"};var ne=new Map,as=new Map,Oe=new Map;function ht(t,e){try{t.container.addComponent(e)}catch(n){I.debug(`Component ${e.name} failed to register with FirebaseApp ${t.name}`,n)}}function k(t){let e=t.name;if(Oe.has(e))return I.debug(`There were multiple attempts to register component ${e}.`),!1;Oe.set(e,t);for(let n of ne.values())ht(n,t);for(let n of as.values())ht(n,t);return!0}function se(t,e){let n=t.container.getProvider("heartbeat").getImmediate({optional:!0});return n&&n.triggerHeartbeat(),t.container.getProvider(e)}function mt(t){return t==null?!1:t.settings!==void 0}var cs={"no-app":"No Firebase App '{$appName}' has been created - call initializeApp() first","bad-app-name":"Illegal App name: '{$appName}'","duplicate-app":"Firebase App named '{$appName}' already exists with different {$mismatchedParam}. Existing: '{$oldValue}'. New: '{$newValue}'.","app-deleted":"Firebase App named '{$appName}' already deleted","server-app-deleted":"Firebase Server App has been deleted","no-options":"Need to provide options, when not being deployed to hosting via source.","invalid-app-argument":"firebase.{$appName}() takes either no argument or a Firebase App instance.","invalid-log-argument":"First argument to `onLog` must be null or a function.","idb-open":"Error thrown when opening IndexedDB. Original error: {$originalErrorMessage}.","idb-get":"Error thrown when reading from IndexedDB. Original error: {$originalErrorMessage}.","idb-set":"Error thrown when writing to IndexedDB. Original error: {$originalErrorMessage}.","idb-delete":"Error thrown when deleting from IndexedDB. Original error: {$originalErrorMessage}.","finalization-registry-not-supported":"FirebaseServerApp deleteOnDeref field defined but the JS runtime does not support FinalizationRegistry.","invalid-server-app-environment":"FirebaseServerApp is not for use in browser environments."},R=new P("app","Firebase",cs);var Ce=class{constructor(e,n,s){this._isDeleted=!1,this._options={...e},this._config={...n},this._name=n.name,this._automaticDataCollectionEnabled=n.automaticDataCollectionEnabled,this._container=s,this.container.addComponent(new _("app",()=>this,"PUBLIC"))}get automaticDataCollectionEnabled(){return this.checkDestroyed(),this._automaticDataCollectionEnabled}set automaticDataCollectionEnabled(e){this.checkDestroyed(),this._automaticDataCollectionEnabled=e}get name(){return this.checkDestroyed(),this._name}get options(){return this.checkDestroyed(),this._options}get config(){return this.checkDestroyed(),this._config}get container(){return this._container}get isDeleted(){return this._isDeleted}set isDeleted(e){this._isDeleted=e}checkDestroyed(){if(this.isDeleted)throw R.create("app-deleted",{appName:this._name})}};function ve(t,e={}){let n=t;typeof e!="object"&&(e={name:e});let s={name:Te,automaticDataCollectionEnabled:!0,...e},r=s.name;if(typeof r!="string"||!r)throw R.create("bad-app-name",{appName:String(r)});if(n||(n=pe()),!n)throw R.create("no-options");let i=ne.get(r);if(i)if(Q(n,i.options)){if(Q(s,i.config))return i;throw R.create("duplicate-app",{appName:r,mismatchedParam:"config",oldValue:JSON.stringify(i.config),newValue:JSON.stringify(s)})}else throw R.create("duplicate-app",{appName:r,mismatchedParam:"options",oldValue:JSON.stringify(i.options),newValue:JSON.stringify(n)});let o=new ee(r);for(let c of Oe.values())o.addComponent(c);let a=new Ce(n,s,o);return ne.set(r,a),a}function re(t=Te){let e=ne.get(t);if(!e&&t===Te&&pe())return ve();if(!e)throw R.create("no-app",{appName:t});return e}function y(t,e,n){let s=os[t]??t;n&&(s+=`-${n}`);let r=s.match(/\s|\//),i=e.match(/\s|\//);if(r||i){let o=[`Unable to register library "${s}" with version "${e}":`];r&&o.push(`library name "${s}" contains illegal characters (whitespace or "/")`),r&&i&&o.push("and"),i&&o.push(`version name "${e}" contains illegal characters (whitespace or "/")`),I.warn(o.join(" "));return}k(new _(`${s}-version`,()=>({library:s,version:e}),"VERSION"))}var ls="firebase-heartbeat-database",us=1,V="firebase-heartbeat-store",Se=null;function Et(){return Se||(Se=ut(ls,us,{upgrade:(t,e)=>{switch(e){case 0:try{t.createObjectStore(V)}catch(n){console.warn(n)}}}}).catch(t=>{throw R.create("idb-open",{originalErrorMessage:t.message})})),Se}async function ds(t){try{let n=(await Et()).transaction(V),s=await n.objectStore(V).get(_t(t));return await n.done,s}catch(e){if(e instanceof C)I.warn(e.message);else{let n=R.create("idb-get",{originalErrorMessage:e?.message});I.warn(n.message)}}}async function ft(t,e){try{let s=(await Et()).transaction(V,"readwrite");await s.objectStore(V).put(e,_t(t)),await s.done}catch(n){if(n instanceof C)I.warn(n.message);else{let s=R.create("idb-set",{originalErrorMessage:n?.message});I.warn(s.message)}}}function _t(t){return`${t.name}!${t.options.appId}`}var hs=1024,fs=30,Re=class{constructor(e){this.container=e,this._heartbeatsCache=null;let n=this.container.getProvider("app").getImmediate();this._storage=new Ie(n),this._heartbeatsCachePromise=this._storage.read().then(s=>(this._heartbeatsCache=s,s))}async triggerHeartbeat(){try{let n=this.container.getProvider("platform-logger").getImmediate().getPlatformInfoString(),s=pt();if(this._heartbeatsCache?.heartbeats==null&&(this._heartbeatsCache=await this._heartbeatsCachePromise,this._heartbeatsCache?.heartbeats==null)||this._heartbeatsCache.lastSentHeartbeatDate===s||this._heartbeatsCache.heartbeats.some(r=>r.date===s))return;if(this._heartbeatsCache.heartbeats.push({date:s,agent:n}),this._heartbeatsCache.heartbeats.length>fs){let r=gs(this._heartbeatsCache.heartbeats);this._heartbeatsCache.heartbeats.splice(r,1)}return this._storage.overwrite(this._heartbeatsCache)}catch(e){I.warn(e)}}async getHeartbeatsHeader(){try{if(this._heartbeatsCache===null&&await this._heartbeatsCachePromise,this._heartbeatsCache?.heartbeats==null||this._heartbeatsCache.heartbeats.length===0)return"";let e=pt(),{heartbeatsToSend:n,unsentEntries:s}=ps(this._heartbeatsCache.heartbeats),r=fe(JSON.stringify({version:2,heartbeats:n}));return this._heartbeatsCache.lastSentHeartbeatDate=e,s.length>0?(this._heartbeatsCache.heartbeats=s,await this._storage.overwrite(this._heartbeatsCache)):(this._heartbeatsCache.heartbeats=[],this._storage.overwrite(this._heartbeatsCache)),r}catch(e){return I.warn(e),""}}};function pt(){return new Date().toISOString().substring(0,10)}function ps(t,e=hs){let n=[],s=t.slice();for(let r of t){let i=n.find(o=>o.agent===r.agent);if(i){if(i.dates.push(r.date),gt(n)>e){i.dates.pop();break}}else if(n.push({agent:r.agent,dates:[r.date]}),gt(n)>e){n.pop();break}s=s.slice(1)}return{heartbeatsToSend:n,unsentEntries:s}}var Ie=class{constructor(e){this.app=e,this._canUseIndexedDBPromise=this.runIndexedDBEnvironmentCheck()}async runIndexedDBEnvironmentCheck(){return G()?nt().then(()=>!0).catch(()=>!1):!1}async read(){if(await this._canUseIndexedDBPromise){let n=await ds(this.app);return n?.heartbeats?n:{heartbeats:[]}}else return{heartbeats:[]}}async overwrite(e){if(await this._canUseIndexedDBPromise){let s=await this.read();return ft(this.app,{lastSentHeartbeatDate:e.lastSentHeartbeatDate??s.lastSentHeartbeatDate,heartbeats:e.heartbeats})}else return}async add(e){if(await this._canUseIndexedDBPromise){let s=await this.read();return ft(this.app,{lastSentHeartbeatDate:e.lastSentHeartbeatDate??s.lastSentHeartbeatDate,heartbeats:[...s.heartbeats,...e.heartbeats]})}else return}};function gt(t){return fe(JSON.stringify({version:2,heartbeats:t})).length}function gs(t){if(t.length===0)return-1;let e=0,n=t[0].date;for(let s=1;s<t.length;s++)t[s].date<n&&(n=t[s].date,e=s);return e}function ms(t){k(new _("platform-logger",e=>new ye(e),"PRIVATE")),k(new _("heartbeat",e=>new Re(e),"PRIVATE")),y(Ae,dt,t),y(Ae,dt,"esm2020"),y("fire-js","")}ms("");var Es="firebase",_s="12.19.0";y(Es,_s,"app");var bt="@firebase/ai",Pe="2.16.0";var U="AI",bs="us-central1",ws="global",Ss="firebasevertexai.googleapis.com",B="v1beta",wt=Pe,ys="gl-js",As="hybrid",Ts=180*1e3,Os="gemini-2.5-flash-lite";var d=class t extends C{constructor(e,n,s){let r=U,i=`${r}/${e}`,o=`${r}: ${n} (${i})`;super(e,o),this.code=e,this.customErrorData=s,Error.captureStackTrace&&Error.captureStackTrace(this,t),Object.setPrototypeOf(this,t.prototype),this.toString=()=>o}};var St=["user","model","function","system"];var It={HARM_SEVERITY_NEGLIGIBLE:"HARM_SEVERITY_NEGLIGIBLE",HARM_SEVERITY_LOW:"HARM_SEVERITY_LOW",HARM_SEVERITY_MEDIUM:"HARM_SEVERITY_MEDIUM",HARM_SEVERITY_HIGH:"HARM_SEVERITY_HIGH",HARM_SEVERITY_UNSUPPORTED:"HARM_SEVERITY_UNSUPPORTED"};var E={STOP:"STOP",MAX_TOKENS:"MAX_TOKENS",SAFETY:"SAFETY",RECITATION:"RECITATION",OTHER:"OTHER",BLOCKLIST:"BLOCKLIST",PROHIBITED_CONTENT:"PROHIBITED_CONTENT",SPII:"SPII",MALFORMED_FUNCTION_CALL:"MALFORMED_FUNCTION_CALL",IMAGE_SAFETY:"IMAGE_SAFETY",IMAGE_PROHIBITED_CONTENT:"IMAGE_PROHIBITED_CONTENT",IMAGE_OTHER:"IMAGE_OTHER",NO_IMAGE:"NO_IMAGE",IMAGE_RECITATION:"IMAGE_RECITATION",LANGUAGE:"LANGUAGE",UNEXPECTED_TOOL_CALL:"UNEXPECTED_TOOL_CALL",TOO_MANY_TOOL_CALLS:"TOO_MANY_TOOL_CALLS",MISSING_THOUGHT_SIGNATURE:"MISSING_THOUGHT_SIGNATURE",MALFORMED_RESPONSE:"MALFORMED_RESPONSE"};var w={PREFER_ON_DEVICE:"prefer_on_device",ONLY_ON_DEVICE:"only_on_device",ONLY_IN_CLOUD:"only_in_cloud",PREFER_IN_CLOUD:"prefer_in_cloud"},N={ON_DEVICE:"on_device",IN_CLOUD:"in_cloud"};var u={ERROR:"error",REQUEST_ERROR:"request-error",RESPONSE_ERROR:"response-error",FETCH_ERROR:"fetch-error",SESSION_CLOSED:"session-closed",INVALID_CONTENT:"invalid-content",API_NOT_ENABLED:"api-not-enabled",INVALID_SCHEMA:"invalid-schema",NO_API_KEY:"no-api-key",NO_APP_ID:"no-app-id",NO_MODEL:"no-model",NO_PROJECT_ID:"no-project-id",PARSE_FAILED:"parse-failed",UNSUPPORTED:"unsupported"};var A={AGENT_PLATFORM:"AGENT_PLATFORM",VERTEX_AI:"VERTEX_AI",GOOGLE_AI:"GOOGLE_AI"};var W=class{constructor(e){this.backendType=e}},z=class extends W{constructor(){super(A.GOOGLE_AI)}_getModelPath(e,n){return`/${B}/projects/${e}/${n}`}_getTemplatePath(e,n){return`/${B}/projects/${e}/templates/${n}`}},K=class extends W{constructor(e){super(A.VERTEX_AI),this.location=bs,e&&(this.location=e)}_getModelPath(e,n){return`/${B}/projects/${e}/locations/${this.location}/${n}`}_getTemplatePath(e,n){return`/${B}/projects/${e}/locations/${this.location}/templates/${n}`}},$=class extends W{constructor(e){super(A.AGENT_PLATFORM),this.location=ws,e&&(this.location=e)}_getModelPath(e,n){return`/${B}/projects/${e}/locations/${this.location}/${n}`}_getTemplatePath(e,n){return`/${B}/projects/${e}/locations/${this.location}/templates/${n}`}};function Cs(t){if(t instanceof z)return`${U}/googleai`;if(t instanceof K)return`${U}/vertexai/${t.location}`;if(t instanceof $)return`${U}/agentplatform/${t.location}`;throw new d(u.ERROR,`Invalid backend: ${JSON.stringify(t.backendType)}`)}function Rs(t){let e=t.split("/");if(e[0]!==U)throw new d(u.ERROR,`Invalid instance identifier, unknown prefix '${e[0]}'`);switch(e[1]){case"vertexai":let s=e[2];if(!s)throw new d(u.ERROR,`Invalid instance identifier, unknown location '${t}'`);return new K(s);case"agentplatform":let r=e[2];if(!r)throw new d(u.ERROR,`Invalid instance identifier, unknown location '${t}'`);return new $(r);case"googleai":return new z;default:throw new d(u.ERROR,`Invalid instance identifier string: '${t}'`)}}var m=new D("@firebase/vertexai"),v;(function(t){t.UNAVAILABLE="unavailable",t.DOWNLOADABLE="downloadable",t.DOWNLOADING="downloading",t.AVAILABLE="available"})(v||(v={}));var vt={type:"text",languages:["en"]},De=[vt,{type:"image"}],ke=[vt],oe=class t{constructor(e,n,s){this.languageModelProvider=e,this.mode=n,this.downloadPromise=null,this.onDeviceParams={createOptions:{expectedInputs:De,expectedOutputs:ke}},s&&(this.onDeviceParams=s,this.onDeviceParams.createOptions?(this.onDeviceParams.createOptions.expectedInputs||(this.onDeviceParams.createOptions.expectedInputs=De),this.onDeviceParams.createOptions.expectedOutputs||(this.onDeviceParams.createOptions.expectedOutputs=ke)):this.onDeviceParams.createOptions={expectedInputs:De,expectedOutputs:ke})}async isAvailable(e){if(!this.mode)return m.debug("On-device inference unavailable because mode is undefined."),!1;if(this.mode===w.ONLY_IN_CLOUD)return m.debug('On-device inference unavailable because mode is "only_in_cloud".'),!1;let n=await this.languageModelProvider?.availability(this.onDeviceParams.createOptions);if(this.mode===w.ONLY_ON_DEVICE){if(n===v.UNAVAILABLE)throw new d(u.API_NOT_ENABLED,"Local LanguageModel API not available in this environment.");if(n===v.DOWNLOADABLE||n===v.DOWNLOADING){m.debug("Waiting for download of LanguageModel to complete.");try{await this.downloadPromise}catch(s){throw new d(u.ERROR,s.message)}return!0}return!0}return n!==v.AVAILABLE?(m.debug(`On-device inference unavailable because availability is "${n}".`),!1):t.isOnDeviceRequest(e)?!0:(m.debug("On-device inference unavailable because request is incompatible."),!1)}async generateContent(e){let n=await this.createSession(),s=await Promise.all(e.contents.map(t.toLanguageModelMessage)),r=await n.prompt(s,this.onDeviceParams.promptOptions);return t.toResponse(r)}async generateContentStream(e){let n=await this.createSession(),s=await Promise.all(e.contents.map(t.toLanguageModelMessage)),r=n.promptStreaming(s,this.onDeviceParams.promptOptions);return t.toStreamResponse(r)}async countTokens(e){throw new d(u.REQUEST_ERROR,"Count Tokens is not yet available for on-device model.")}static isOnDeviceRequest(e){if(e.contents.length===0)return m.debug("Empty prompt rejected for on-device inference."),!1;for(let n of e.contents){if(n.parts.some(s=>"functionResponse"in s))return m.debug("Content with a function response part rejected for on-device inference."),!1;for(let s of n.parts)if(s.inlineData&&t.SUPPORTED_MIME_TYPES.indexOf(s.inlineData.mimeType)===-1)return m.debug(`Unsupported mime type "${s.inlineData.mimeType}" rejected for on-device inference.`),!1}return!0}async downloadIfAvailable(e){let n=await this.languageModelProvider?.availability(this.onDeviceParams.createOptions);return(n===v.DOWNLOADABLE||n===v.DOWNLOADING)&&this.download(e),n}download(e){if(this.downloadPromise)return;let n={...this.onDeviceParams.createOptions};n&&!n.monitor&&e&&(n.monitor=s=>{s.addEventListener("downloadprogress",r=>{e(r.loaded)})}),this.downloadPromise=this.languageModelProvider?.create(n).finally(()=>{this.downloadPromise=null})}static async toLanguageModelMessage(e){let n=await Promise.all(e.parts.map(t.toLanguageModelMessageContent));return{role:t.toLanguageModelMessageRole(e.role),content:n}}static async toLanguageModelMessageContent(e){if(e.text)return{type:"text",value:e.text};if(e.inlineData){let s=await(await __rpfFetch(`data:${e.inlineData.mimeType};base64,${e.inlineData.data}`)).blob();return{type:"image",value:await createImageBitmap(s)}}throw new d(u.REQUEST_ERROR,"Processing of this Part type is not currently supported.")}static toLanguageModelMessageRole(e){return e==="model"?"assistant":"user"}async createSession(){if(!this.languageModelProvider)throw new d(u.UNSUPPORTED,"Chrome AI requested for unsupported browser version.");let e=await this.languageModelProvider.create(this.onDeviceParams.createOptions);return this.oldSession&&this.oldSession.destroy(),this.oldSession=e,e}static toResponse(e){return{json:async()=>({candidates:[{content:{parts:[{text:e}]}}]})}}static toStreamResponse(e){let n=new TextEncoder;return{body:e.pipeThrough(new TransformStream({transform(s,r){let i=JSON.stringify({candidates:[{content:{role:"model",parts:[{text:s}]}}]});r.enqueue(n.encode(`data: ${i}

`))}}))}}};oe.SUPPORTED_MIME_TYPES=["image/jpeg","image/png"];function Is(t,e,n){let r=(e||H()).LanguageModel;if(r&&t)return new oe(r,t,n)}var Me=class{constructor(e,n,s,r,i){this.app=e,this.backend=n,this.chromeAdapterFactory=i;let o=r?.getImmediate({optional:!0}),a=s?.getImmediate({optional:!0});this.auth=a||null,this.appCheck=o||null,n instanceof K||n instanceof $?this.location=n.location:this.location=""}_delete(){return Promise.resolve()}set options(e){this._options=e}get options(){return this._options}};function vs(t,{instanceIdentifier:e}){if(!e)throw new d(u.ERROR,"AIService instance identifier is undefined.");let n=Rs(e),s=t.getProvider("app").getImmediate(),r=t.getProvider("auth-internal"),i=t.getProvider("app-check-internal");return new Me(s,n,r,i,Is)}function Ds(t){if(t.app?.options?.apiKey)if(t.app?.options?.projectId){if(!t.app?.options?.appId)throw new d(u.NO_APP_ID,'The "appId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid app ID.')}else throw new d(u.NO_PROJECT_ID,'The "projectId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid project ID.');else throw new d(u.NO_API_KEY,'The "apiKey" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid API key.');let e={apiKey:t.app.options.apiKey,project:t.app.options.projectId,appId:t.app.options.appId,automaticDataCollectionEnabled:t.app.automaticDataCollectionEnabled,location:t.location,backend:t.backend};if(mt(t.app)&&t.app.settings.appCheckToken){let n=t.app.settings.appCheckToken;e.getAppCheckToken=()=>Promise.resolve({token:n})}else t.appCheck&&(t.options?.useLimitedUseAppCheckTokens?e.getAppCheckToken=()=>t.appCheck.getLimitedUseToken():e.getAppCheckToken=()=>t.appCheck.getToken());return t.auth&&(e.getAuthToken=()=>t.auth.getToken()),e}var xe=class t{constructor(e,n){this._apiSettings=Ds(e),this.model=t.normalizeModelName(n,this._apiSettings.backend.backendType)}static normalizeModelName(e,n){return n===A.GOOGLE_AI?t.normalizeGoogleAIModelName(e):t.normalizeVertexAIModelName(e)}static normalizeGoogleAIModelName(e){return`models/${e}`}static normalizeVertexAIModelName(e){let n;return e.includes("/")?e.startsWith("models/")?n=`publishers/google/${e}`:n=e:n=`publishers/google/models/${e}`,n}};var ks="Timeout has expired.",Ne="AbortError",Ue=class{constructor(e){this.params=e}toString(){let e=new URL(this.baseUrl);return e.pathname=this.pathname,e.search=this.queryParams.toString(),e.toString()}get pathname(){return this.params.templateId?`${this.params.apiSettings.backend._getTemplatePath(this.params.apiSettings.project,this.params.templateId)}:${this.params.task}`:`${this.params.apiSettings.backend._getModelPath(this.params.apiSettings.project,this.params.model)}:${this.params.task}`}get baseUrl(){return this.params.singleRequestOptions?.baseUrl??`https://${Ss}`}get queryParams(){let e=new URLSearchParams;return this.params.stream&&e.set("alt","sse"),e}};function Ns(t){let e=[];return e.push(`${ys}/${wt}`),e.push(`fire/${wt}`),(t.params.apiSettings.inferenceMode===w.PREFER_ON_DEVICE||t.params.apiSettings.inferenceMode===w.PREFER_IN_CLOUD)&&e.push(As),e.join(" ")}async function Ls(t){let e=new Headers;if(e.append("Content-Type","application/json"),e.append("x-goog-api-client",Ns(t)),e.append("x-goog-api-key",t.params.apiSettings.apiKey),t.params.apiSettings.automaticDataCollectionEnabled&&e.append("X-Firebase-Appid",t.params.apiSettings.appId),t.params.apiSettings.getAppCheckToken){let n=await t.params.apiSettings.getAppCheckToken();n&&(e.append("X-Firebase-AppCheck",n.token),n.error&&m.warn(`Unable to obtain a valid App Check token: ${n.error.message}`))}if(t.params.apiSettings.getAuthToken){let n=await t.params.apiSettings.getAuthToken();n&&e.append("Authorization",`Firebase ${n.accessToken}`)}return e}async function He(t,e){let n=new Ue(t),s,r=t.singleRequestOptions?.signal,i=t.singleRequestOptions?.timeout!=null&&t.singleRequestOptions.timeout>=0?t.singleRequestOptions.timeout:Ts,o=new AbortController,a=setTimeout(()=>{o.abort(new DOMException(ks,Ne)),m.debug(`Aborting request to ${n} due to timeout (${i}ms)`)},i),c=AbortSignal.any(r?[r,o.signal]:[o.signal]);if(r&&r.aborted)throw clearTimeout(a),new DOMException(r.reason??"Aborted externally before fetch",Ne);try{let l={method:"POST",headers:await Ls(n),signal:c,body:e};if(s=await __rpfFetch(n.toString(),l),!s.ok){let h="",f;try{let g=await s.json();h=g.error.message,g.error.details&&(h+=` ${JSON.stringify(g.error.details)}`,f=g.error.details)}catch{}throw s.status===403&&f&&f.some(g=>g.reason==="SERVICE_DISABLED")&&f.some(g=>g.links?.[0]?.description.includes("Google developers console API activation"))?new d(u.API_NOT_ENABLED,`The Firebase AI SDK requires the Firebase AI API ('firebasevertexai.googleapis.com') to be enabled in your Firebase project. Enable this API by visiting the Firebase Console at https://console.firebase.google.com/project/${n.params.apiSettings.project}/ailogic/ and clicking "Get started". If you enabled this API recently, wait a few minutes for the action to propagate to our systems and then retry.`,{status:s.status,statusText:s.statusText,errorDetails:f}):new d(u.FETCH_ERROR,`Error fetching from ${n}: [${s.status} ${s.statusText}] ${h}`,{status:s.status,statusText:s.statusText,errorDetails:f})}}catch(l){let h=l;throw l.code!==u.FETCH_ERROR&&l.code!==u.API_NOT_ENABLED&&l instanceof Error&&l.name!==Ne&&(h=new d(u.ERROR,`Error fetching from ${n.toString()}: ${l.message}`),h.stack=l.stack),h}finally{clearTimeout(a)}return s}function ie(t){if(t.candidates&&t.candidates.length>0){if(t.candidates.length>1&&m.warn(`This response had ${t.candidates.length} candidates. Returning text from the first candidate only. Access response.candidates directly to use the other candidates.`),kt(t.candidates[0]))throw new d(u.RESPONSE_ERROR,`Response error: ${x(t)}. Response body stored in error.response`,{response:t});return!0}else return!1}function ae(t,e=N.IN_CLOUD){t.candidates&&!t.candidates[0].hasOwnProperty("index")&&(t.candidates[0].index=0);let n=Ps(t);return n.inferenceSource=e,n}function Ps(t){return t.text=()=>{if(ie(t))return yt(t,e=>!e.thought);if(t.promptFeedback)throw new d(u.RESPONSE_ERROR,`Text not available. ${x(t)}`,{response:t});return""},t.thoughtSummary=()=>{if(ie(t)){let e=yt(t,n=>!!n.thought);return e===""?void 0:e}else if(t.promptFeedback)throw new d(u.RESPONSE_ERROR,`Thought summary not available. ${x(t)}`,{response:t})},t.inlineDataParts=()=>{if(ie(t))return Ms(t);if(t.promptFeedback)throw new d(u.RESPONSE_ERROR,`Data not available. ${x(t)}`,{response:t})},t.functionCalls=()=>{if(ie(t))return Dt(t);if(t.promptFeedback)throw new d(u.RESPONSE_ERROR,`Function call not available. ${x(t)}`,{response:t})},t}function yt(t,e){let n=[];if(t.candidates?.[0].content?.parts)for(let s of t.candidates?.[0].content?.parts)s.text&&e(s)&&n.push(s.text);return n.length>0?n.join(""):""}function Dt(t){if(!t)return;let e=[];if(t.candidates?.[0].content?.parts)for(let n of t.candidates?.[0].content?.parts)n.functionCall&&e.push(n.functionCall);if(e.length>0)return e}function Ms(t){let e=[];if(t.candidates?.[0].content?.parts)for(let n of t.candidates?.[0].content?.parts)n.inlineData&&e.push(n);if(e.length>0)return e}var xs=[E.RECITATION,E.SAFETY,E.BLOCKLIST,E.PROHIBITED_CONTENT,E.SPII,E.MALFORMED_FUNCTION_CALL,E.IMAGE_SAFETY,E.IMAGE_PROHIBITED_CONTENT,E.IMAGE_OTHER,E.NO_IMAGE,E.IMAGE_RECITATION,E.LANGUAGE,E.UNEXPECTED_TOOL_CALL,E.TOO_MANY_TOOL_CALLS,E.MISSING_THOUGHT_SIGNATURE,E.MALFORMED_RESPONSE];function kt(t){return!!t.finishReason&&xs.some(e=>e===t.finishReason)}function x(t){let e="";if((!t.candidates||t.candidates.length===0)&&t.promptFeedback)e+="Response was blocked",t.promptFeedback?.blockReason&&(e+=` due to ${t.promptFeedback.blockReason}`),t.promptFeedback?.blockReasonMessage&&(e+=`: ${t.promptFeedback.blockReasonMessage}`);else if(t.candidates?.[0]){let n=t.candidates[0];kt(n)&&(e+=`Candidate was blocked due to ${n.finishReason}`,n.finishMessage&&(e+=`: ${n.finishMessage}`))}return e}function Nt(t){if(t.safetySettings?.forEach(e=>{if(e.method)throw new d(u.UNSUPPORTED,"SafetySetting.method is not supported in the the Gemini Developer API. Please remove this property.")}),t.generationConfig?.topK){let e=Math.round(t.generationConfig.topK);e!==t.generationConfig.topK&&(m.warn("topK in GenerationConfig has been rounded to the nearest integer to match the format for requests to the Gemini Developer API."),t.generationConfig.topK=e)}return t}function Ge(t){return{candidates:t.candidates?$s(t.candidates):void 0,prompt:t.promptFeedback?Bs(t.promptFeedback):void 0,usageMetadata:t.usageMetadata}}function Us(t,e){return{generateContentRequest:{model:e,...t}}}function $s(t){let e=[],n;return e&&t.forEach(s=>{let r;if(s.citationMetadata&&(r={citations:s.citationMetadata.citationSources}),s.safetyRatings&&(n=s.safetyRatings.map(o=>({...o,severity:o.severity??It.HARM_SEVERITY_UNSUPPORTED,probabilityScore:o.probabilityScore??0,severityScore:o.severityScore??0}))),s.content?.parts?.some(o=>o?.videoMetadata))throw new d(u.UNSUPPORTED,"Part.videoMetadata is not supported in the Gemini Developer API. Please remove this property.");let i={index:s.index,content:s.content,finishReason:s.finishReason,finishMessage:s.finishMessage,safetyRatings:n,citationMetadata:r,groundingMetadata:s.groundingMetadata,urlContextMetadata:s.urlContextMetadata};e.push(i)}),e}function Bs(t){let e=[];return t.safetyRatings.forEach(s=>{e.push({category:s.category,probability:s.probability,severity:s.severity??It.HARM_SEVERITY_UNSUPPORTED,probabilityScore:s.probabilityScore??0,severityScore:s.severityScore??0,blocked:s.blocked})}),{blockReason:t.blockReason,safetyRatings:e,blockReasonMessage:t.blockReasonMessage}}var At=/^data\: (.*)(?:\n\n|\r\r|\r\n\r\n)/;async function Fs(t,e,n){let s=t.body.pipeThrough(new TextDecoderStream("utf8",{fatal:!0})),r=js(s),[i,o]=r.tee(),{response:a,firstValue:c}=await Hs(o,e,n);return{stream:Vs(i,e,n),response:a,firstValue:c}}async function Hs(t,e,n){let[s,r]=t.tee(),i=s.getReader(),{value:o}=await i.read();return{firstValue:o,response:Gs(r,e,n)}}async function Gs(t,e,n){let s=[],r=t.getReader();for(;;){let{done:i,value:o}=await r.read();if(i){let a=Ws(s);return e.backend.backendType===A.GOOGLE_AI&&(a=Ge(a)),ae(a,n)}s.push(o)}}async function*Vs(t,e,n){let s=t.getReader();for(;;){let{value:r,done:i}=await s.read();if(i)break;let o;e.backend.backendType===A.GOOGLE_AI?o=ae(Ge(r),n):o=ae(r,n);let a=o.candidates?.[0];!a?.content?.parts&&!a?.finishReason&&!a?.citationMetadata&&!a?.urlContextMetadata||(yield o)}}function js(t){let e=t.getReader();return new ReadableStream({start(s){let r="";return i();function i(){return e.read().then(({value:o,done:a})=>{if(a){if(r.trim()){s.error(new d(u.PARSE_FAILED,"Failed to parse stream"));return}s.close();return}r+=o;let c=r.match(At),l;for(;c;){try{l=JSON.parse(c[1])}catch{s.error(new d(u.PARSE_FAILED,`Error parsing JSON response: "${c[1]}`));return}s.enqueue(l),r=r.substring(c[0].length),c=r.match(At)}return i()})}}})}function Ws(t){let n={promptFeedback:t[t.length-1]?.promptFeedback};for(let s of t)if(s.candidates)for(let r of s.candidates){let i=r.index||0;n.candidates||(n.candidates=[]),n.candidates[i]||(n.candidates[i]={index:r.index}),n.candidates[i].citationMetadata=r.citationMetadata,n.candidates[i].finishReason=r.finishReason,n.candidates[i].finishMessage=r.finishMessage,n.candidates[i].safetyRatings=r.safetyRatings,n.candidates[i].groundingMetadata=r.groundingMetadata;let o=r.urlContextMetadata;if(typeof o=="object"&&o!==null&&Object.keys(o).length>0&&(n.candidates[i].urlContextMetadata=o),r.content){if(!r.content.parts)continue;n.candidates[i].content||(n.candidates[i].content={role:r.content.role||"user",parts:[]});for(let a of r.content.parts){let c={...a};a.text!==""&&Object.keys(c).length>0&&n.candidates[i].content.parts.push(c)}}}return n}var zs=[u.FETCH_ERROR,u.ERROR,u.API_NOT_ENABLED];async function Lt(t,e,n,s){if(!e)return{response:await s(),inferenceSource:N.IN_CLOUD};switch(e.mode){case w.ONLY_ON_DEVICE:if(await e.isAvailable(t))return{response:await n(),inferenceSource:N.ON_DEVICE};throw new d(u.UNSUPPORTED,"Inference mode is ONLY_ON_DEVICE, but an on-device model is not available.");case w.ONLY_IN_CLOUD:return{response:await s(),inferenceSource:N.IN_CLOUD};case w.PREFER_IN_CLOUD:try{return{response:await s(),inferenceSource:N.IN_CLOUD}}catch(r){if(r instanceof d&&zs.includes(r.code)&&await e.isAvailable(t))return{response:await n(),inferenceSource:N.ON_DEVICE};throw r}case w.PREFER_ON_DEVICE:return await e.isAvailable(t)?{response:await n(),inferenceSource:N.ON_DEVICE}:{response:await s(),inferenceSource:N.IN_CLOUD};default:throw new d(u.ERROR,`Unexpected infererence mode: ${e.mode}`)}}async function Ks(t,e,n,s){return t.backend.backendType===A.GOOGLE_AI&&(n=Nt(n)),He({task:"streamGenerateContent",model:e,apiSettings:t,stream:!0,singleRequestOptions:s},JSON.stringify(n))}async function Pt(t,e,n,s,r){let i=await Lt(n,s,()=>s.generateContentStream(n),()=>Ks(t,e,n,r));return Fs(i.response,t,i.inferenceSource)}async function Ys(t,e,n,s){return t.backend.backendType===A.GOOGLE_AI&&(n=Nt(n)),He({model:e,task:"generateContent",apiSettings:t,stream:!1,singleRequestOptions:s},JSON.stringify(n))}async function Mt(t,e,n,s,r){let i=await Lt(n,s,()=>s.generateContent(n),()=>Ys(t,e,n,r)),o=await qs(i.response,t);return{response:ae(o,i.inferenceSource)}}async function qs(t,e){let n=await t.json();return e.backend.backendType===A.GOOGLE_AI?Ge(n):n}function Ve(t){if(t!=null){if(typeof t=="string")return{role:"system",parts:[{text:t}]};if(t.text)return{role:"system",parts:[t]};if(t.parts)return t.role?t:{role:"system",parts:t.parts}}}function j(t){let e=[];if(typeof t=="string")e=[{text:t}];else for(let n of t)typeof n=="string"?e.push({text:n}):e.push(n);return Js(e)}function Js(t){let e={role:"user",parts:[]},n=!1,s=!1;for(let r of t)"functionResponse"in r?s=!0:n=!0,e.parts.push(r);if(n&&s)throw new d(u.INVALID_CONTENT,"Within a single message, FunctionResponse cannot be mixed with other type of Part in the request for sending chat message.");if(!n&&!s)throw new d(u.INVALID_CONTENT,"No Content is provided for sending chat message.");return e}function Le(t){let e;return t.contents?e=t:e={contents:[j(t)]},t.systemInstruction&&(e.systemInstruction=Ve(t.systemInstruction)),e}var Tt="SILENT_ERROR",Ot=10,$e=class{constructor(e,n,s){this.params=n,this.requestOptions=s,this._history=[],this._sendPromise=Promise.resolve(),this._apiSettings=e}async getHistory(){return await this._sendPromise,this._history}async _sendMessage(e,n){let s={};await this._sendPromise;let r=[];return this._sendPromise=this._sendPromise.then(async()=>{let i,o=0,a=this.requestOptions?.maxSequentialFunctionCalls??Ot;do{let c;if(i){o++;let f=await this._callFunctionsAsNeeded(i);c=j(f)}else c=j(e);let l=this._formatRequest(c,[...r]);r.push(c);let h=await this._callGenerateContent(l,n);if(h)if(s=h,i=this._getCallableFunctionCalls(h.response),h.response.candidates&&h.response.candidates.length>0){let f={parts:h.response.candidates?.[0].content.parts||[],role:h.response.candidates?.[0].content.role||"model"};r.push(f)}else{let f=x(h.response);f&&m.warn(`sendMessage() was unsuccessful. ${f}. Inspect response object for details.`)}else i=void 0}while(i&&o<a);i&&o>=a&&m.warn(`Automatic function calling exceeded the limit of ${a} function calls. Returning last model response.`)}),await this._sendPromise,this._history=this._history.concat(r),s}async _sendMessageStream(e,n){await this._sendPromise;let s=[],i=(async()=>{let o,a=0,c=this.requestOptions?.maxSequentialFunctionCalls??Ot,l;do{let h;if(o){a++;let g=await this._callFunctionsAsNeeded(o);h=j(g)}else h=j(e);let f=this._formatRequest(h,[...s]);if(s.push(h),l=await this._callGenerateContentStream(f,n),o=this._getCallableFunctionCalls(l.firstValue),o&&l.firstValue&&l.firstValue.candidates&&l.firstValue.candidates.length>0){let g={...l.firstValue.candidates[0].content};g.role||(g.role="model"),s.push(g)}}while(o&&a<c);return o&&a>=c&&m.warn(`Automatic function calling exceeded the limit of ${c} function calls. Returning last model response.`),{stream:l.stream,response:l.response}})();return this._sendPromise=this._sendPromise.then(async()=>i).catch(o=>{throw new Error(Tt)}).then(o=>o.response).then(o=>{if(o.candidates&&o.candidates.length>0){this._history=this._history.concat(s);let a={...o.candidates[0].content};a.role||(a.role="model"),this._history.push(a)}else{let a=x(o);a&&m.warn(`sendMessageStream() was unsuccessful. ${a}. Inspect response object for details.`)}}).catch(o=>{o.message!==Tt&&o.name!=="AbortError"&&m.error(o)}),i}_getCallableFunctionCalls(e){let n=this.params?.tools?.find(r=>r.functionDeclarations);if(!n?.functionDeclarations)return;let s=Dt(e);if(s){for(let r of s)if(!n.functionDeclarations?.some(o=>o.name===r.name&&typeof o.functionReference=="function"))return;return s}}async _callFunctionsAsNeeded(e){let n=[],s=[],r=this.params?.tools?.find(i=>i.functionDeclarations);if(r&&r.functionDeclarations){for(let o of e){let a=r.functionDeclarations.find(c=>c.name===o.name);if(a?.functionReference){let c=Promise.resolve(a.functionReference(o.args)).catch(l=>{let h=new d(u.ERROR,`Error in user-defined function "${a.name}": ${l.message}`);throw h.stack=l.stack,h});n.push({name:o.name,id:o.id,results:c}),s.push(c)}}await Promise.all(s);let i=[];for(let{name:o,id:a,results:c}of n){let l={name:o,response:await c};a&&(l.id=a),i.push({functionResponse:l})}return i}else throw new d(u.REQUEST_ERROR,'No function declarations were provided in "tools".')}};var Ct=["text","inlineData","functionCall","functionResponse","thought","thoughtSignature"],Xs={user:["text","inlineData","functionResponse"],function:["functionResponse"],model:["text","functionCall","thought","thoughtSignature"],system:["text"]},Rt={user:["model"],function:["model"],model:["user","function"],system:[]};function Qs(t){let e=null;for(let n of t){let{role:s,parts:r}=n;if(!e&&s!=="user")throw new d(u.INVALID_CONTENT,`First Content should be with role 'user', got ${s}`);if(!St.includes(s))throw new d(u.INVALID_CONTENT,`Each item should include role field. Got ${s} but valid roles are: ${JSON.stringify(St)}`);if(!Array.isArray(r))throw new d(u.INVALID_CONTENT,"Content should have 'parts' property with an array of Parts");if(r.length===0)throw new d(u.INVALID_CONTENT,"Each Content should have at least one part");let i={text:0,inlineData:0,functionCall:0,functionResponse:0,thought:0,thoughtSignature:0,executableCode:0,codeExecutionResult:0};for(let a of r)for(let c of Ct)c in a&&(i[c]+=1);let o=Xs[s];for(let a of Ct)if(!o.includes(a)&&i[a]>0)throw new d(u.INVALID_CONTENT,`Content with role '${s}' can't contain '${a}' part`);if(e&&!Rt[s].includes(e.role))throw new d(u.INVALID_CONTENT,`Content with role '${s}' can't follow '${e.role}'. Valid previous roles: ${JSON.stringify(Rt)}`);e=n}}var Be=class extends $e{constructor(e,n,s,r,i){super(e,r,i),this.model=n,this.chromeAdapter=s,this.params=r,this.requestOptions=i,r?.history&&(Qs(r.history),this._history=r.history),this.params?.systemInstruction!=null&&(this.params={...this.params,systemInstruction:Ve(this.params.systemInstruction)})}_formatRequest(e,n){return{safetySettings:this.params?.safetySettings,generationConfig:this.params?.generationConfig,tools:this.params?.tools,toolConfig:this.params?.toolConfig,systemInstruction:this.params?.systemInstruction,contents:[...this._history,...n,e]}}_callGenerateContent(e,n){return Mt(this._apiSettings,this.model,e,this.chromeAdapter,{...this.requestOptions,...n})}_callGenerateContentStream(e,n){return Pt(this._apiSettings,this.model,e,this.chromeAdapter,{...this.requestOptions,...n})}async sendMessage(e,n){return this._sendMessage(e,n)}async sendMessageStream(e,n){return this._sendMessageStream(e,n)}};async function Zs(t,e,n,s){let r="";if(t.backend.backendType===A.GOOGLE_AI){let o=Us(n,e);r=JSON.stringify(o)}else r=JSON.stringify(n);return(await He({model:e,task:"countTokens",apiSettings:t,stream:!1,singleRequestOptions:s},r)).json()}async function er(t,e,n,s,r){if(s?.mode===w.ONLY_ON_DEVICE)throw new d(u.UNSUPPORTED,"countTokens() is not supported for on-device models.");return Zs(t,e,n,r)}var Fe=class extends xe{constructor(e,n,s,r){super(e,n.model),this.chromeAdapter=r,this.generationConfig=n.generationConfig||{},tr(this.generationConfig),this.safetySettings=n.safetySettings||[],this.tools=n.tools,this.toolConfig=n.toolConfig,this.systemInstruction=Ve(n.systemInstruction),this.requestOptions=s||{}}async initializeDeviceModel(e){if(!this.chromeAdapter||this.chromeAdapter.mode===w.ONLY_IN_CLOUD)return;if(await this.chromeAdapter.downloadIfAvailable(e)===v.UNAVAILABLE){let s=new d(u.API_NOT_ENABLED,"Local LanguageModel API not available in this environment.");if(this.chromeAdapter.mode===w.ONLY_ON_DEVICE)throw s;m.debug(s.message)}await this.chromeAdapter.downloadPromise}async generateContent(e,n){let s=Le(e);return Mt(this._apiSettings,this.model,{generationConfig:this.generationConfig,safetySettings:this.safetySettings,tools:this.tools,toolConfig:this.toolConfig,systemInstruction:this.systemInstruction,...s},this.chromeAdapter,{...this.requestOptions,...n})}async generateContentStream(e,n){let s=Le(e),{stream:r,response:i}=await Pt(this._apiSettings,this.model,{generationConfig:this.generationConfig,safetySettings:this.safetySettings,tools:this.tools,toolConfig:this.toolConfig,systemInstruction:this.systemInstruction,...s},this.chromeAdapter,{...this.requestOptions,...n});return{stream:r,response:i}}startChat(e){return new Be(this._apiSettings,this.model,this.chromeAdapter,{tools:this.tools,toolConfig:this.toolConfig,systemInstruction:this.systemInstruction,generationConfig:this.generationConfig,safetySettings:this.safetySettings,...e},this.requestOptions)}async countTokens(e,n){let s=Le(e);return er(this._apiSettings,this.model,s,this.chromeAdapter,{...this.requestOptions,...n})}};function tr(t){if(t.thinkingConfig?.thinkingBudget!=null&&t.thinkingConfig?.thinkingLevel)throw new d(u.UNSUPPORTED,"Cannot set both thinkingBudget and thinkingLevel in a config.");if(t.responseSchema!=null&&t.responseJsonSchema!=null)throw new d(u.UNSUPPORTED,"Cannot set both responseSchema and responseJsonSchema in a config.");if((t.responseSchema!=null||t.responseJsonSchema!=null)&&t.responseMimeType!=="application/json"&&t.responseMimeType!=="text/x.enum")throw new d(u.UNSUPPORTED,'responseMimeType must be set to "application/json" or "text/x.enum" if responseSchema or responseJsonSchema are set.')}var nr="audio-processor",ai=`
  class AudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.targetSampleRate = options.processorOptions.targetSampleRate;
      // 'sampleRate' is a global variable available inside the AudioWorkletGlobalScope,
      // representing the native sample rate of the AudioContext.
      this.inputSampleRate = sampleRate;
    }

    /**
     * This method is called by the browser's audio engine for each block of audio data.
     * Input is a single input, with a single channel (input[0][0]).
     */
    process(inputs) {
      const input = inputs[0];
      if (input && input.length > 0 && input[0].length > 0) {
        const pcmData = input[0]; // Float32Array of raw audio samples.
        
        // Simple linear interpolation for resampling.
        const resampled = new Float32Array(Math.round(pcmData.length * this.targetSampleRate / this.inputSampleRate));
        const ratio = pcmData.length / resampled.length;
        for (let i = 0; i < resampled.length; i++) {
          resampled[i] = pcmData[Math.floor(i * ratio)];
        }

        // Convert Float32 (-1, 1) samples to Int16 (-32768, 32767)
        const resampledInt16 = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const sample = Math.max(-1, Math.min(1, resampled[i]));
          if (sample < 0) {
            resampledInt16[i] = sample * 32768;
          } else {
            resampledInt16[i] = sample * 32767;
          }
        }
        
        this.port.postMessage(resampledInt16);
      }
      // Return true to keep the processor alive and processing the next audio block.
      return true;
    }
  }

  // Register the processor with a name that can be used to instantiate it from the main thread.
  registerProcessor('${nr}', AudioProcessor);
`;function xt(t=re(),e){t=Z(t);let n=se(t,U),s=e?.backend??new z,r={useLimitedUseAppCheckTokens:e?.useLimitedUseAppCheckTokens??!1},i=Cs(s),o=n.getImmediate({identifier:i});return o.options=r,o}var sr=["mode","onDeviceParams","inCloudParams"];function Ut(t,e,n){let s=e,r;if(s.mode){for(let a of Object.keys(e))sr.includes(a)||m.warn(`When a hybrid inference mode is specified (mode is currently set to ${s.mode}), "${a}" cannot be configured at the top level. Configuration for in-cloud and on-device must be done separately in inCloudParams and onDeviceParams. Configuration values set outside of inCloudParams and onDeviceParams will be ignored.`);r=s.inCloudParams||{model:Os}}else r=e;if(!r.model)throw new d(u.NO_MODEL,"Must provide a model name. Example: getGenerativeModel({ model: 'my-model-name' })");let i=t.chromeAdapterFactory?.(s.mode,typeof window>"u"?void 0:window,s.onDeviceParams),o=new Fe(t,r,n,i);return o._apiSettings.inferenceMode=s.mode,o}function rr(){k(new _(U,vs,"PUBLIC").setMultipleInstances(!0)),y(bt,Pe),y(bt,Pe,"esm2020")}rr();var ze=new Map,Ht={activated:!1,tokenObservers:[]},ir={initialized:!1,enabled:!1};function b(t){return ze.get(t)||{...Ht}}function or(t,e){return ze.set(t,e),ze.get(t)}function ue(){return ir}var ar="https://content-firebaseappcheck.googleapis.com/v1";var cr="exchangeDebugToken",$t={RETRIAL_MIN_WAIT:30*1e3,RETRIAL_MAX_WAIT:960*1e3},mi=1440*60*1e3;var Ke=class{constructor(e,n,s,r,i){if(this.operation=e,this.retryPolicy=n,this.getWaitDuration=s,this.lowerBound=r,this.upperBound=i,this.pending=null,this.nextErrorWaitInterval=r,r>i)throw new Error("Proactive refresh lower bound greater than upper bound!")}start(){this.nextErrorWaitInterval=this.lowerBound,this.process(!0).catch(()=>{})}stop(){this.pending&&(this.pending.reject("cancelled"),this.pending=null)}isRunning(){return!!this.pending}async process(e){this.stop();try{this.pending=new O,this.pending.promise.catch(n=>{}),await lr(this.getNextRun(e)),this.pending.resolve(),await this.pending.promise,this.pending=new O,this.pending.promise.catch(n=>{}),await this.operation(),this.pending.resolve(),await this.pending.promise,this.process(!0).catch(()=>{})}catch(n){this.retryPolicy(n)?this.process(!1).catch(()=>{}):this.stop()}}getNextRun(e){if(e)return this.nextErrorWaitInterval=this.lowerBound,this.getWaitDuration();{let n=this.nextErrorWaitInterval;return this.nextErrorWaitInterval*=2,this.nextErrorWaitInterval>this.upperBound&&(this.nextErrorWaitInterval=this.upperBound),n}}};function lr(t){return new Promise(e=>{setTimeout(e,t)})}var ur={"already-initialized":"You have already called initializeAppCheck() for FirebaseApp {$appName} with different options. To avoid this error, call initializeAppCheck() with the same options as when it was originally called. This will return the already initialized instance.","use-before-activation":"App Check is being used before initializeAppCheck() is called for FirebaseApp {$appName}. Call initializeAppCheck() before instantiating other Firebase services.","fetch-network-error":"Fetch failed to connect to a network. Check Internet connection. Original error: {$originalErrorMessage}.","fetch-parse-error":"Fetch client could not parse response. Original error: {$originalErrorMessage}.","fetch-status-error":"Fetch server returned an HTTP error status. HTTP status: {$httpStatus}.","storage-open":"Error thrown when opening storage. Original error: {$originalErrorMessage}.","storage-get":"Error thrown when reading from storage. Original error: {$originalErrorMessage}.","storage-set":"Error thrown when writing to storage. Original error: {$originalErrorMessage}.","recaptcha-error":"ReCAPTCHA error.","initial-throttle":"{$httpStatus} error. Attempts allowed again after {$time}",throttled:"Requests throttled due to previous {$httpStatus} error. Attempts allowed again after {$time}"},T=new P("appCheck","AppCheck",ur);function Gt(t){if(!b(t).activated)throw T.create("use-before-activation",{appName:t.name})}async function Vt({url:t,body:e},n){let s={"Content-Type":"application/json"},r=n.getImmediate({optional:!0});if(r){let f=await r.getHeartbeatsHeader();f&&(s["X-Firebase-Client"]=f)}let i={method:"POST",body:JSON.stringify(e),headers:s},o;try{o=await __rpfFetch(t,i)}catch(f){throw T.create("fetch-network-error",{originalErrorMessage:f?.message})}if(o.status!==200)throw T.create("fetch-status-error",{httpStatus:o.status});let a;try{a=await o.json()}catch(f){throw T.create("fetch-parse-error",{originalErrorMessage:f?.message})}let c=a.ttl.match(/^([\d.]+)(s)$/);if(!c||!c[2]||isNaN(Number(c[1])))throw T.create("fetch-parse-error",{originalErrorMessage:`ttl field (timeToLive) is not in standard Protobuf Duration format: ${a.ttl}`});let l=Number(c[1])*1e3,h=Date.now();return{token:a.token,expireTimeMillis:h+l,issuedAtTimeMillis:h}}function jt(t,e){let{projectId:n,appId:s,apiKey:r}=t.options;return{url:`${ar}/projects/${n}/apps/${s}:${cr}?key=${r}`,body:{debug_token:e}}}var dr="firebase-app-check-database",hr=1,Y="firebase-app-check-store",Wt="debug-token",ce=null;function zt(){return ce||(ce=new Promise((t,e)=>{try{let n=indexedDB.open(dr,hr);n.onsuccess=s=>{t(s.target.result)},n.onerror=s=>{e(T.create("storage-open",{originalErrorMessage:s.target.error?.message}))},n.onupgradeneeded=s=>{let r=s.target.result;s.oldVersion===0&&r.createObjectStore(Y,{keyPath:"compositeKey"})}}catch(n){e(T.create("storage-open",{originalErrorMessage:n?.message}))}}),ce)}function fr(t){return Yt(qt(t))}function pr(t,e){return Kt(qt(t),e)}function gr(t){return Kt(Wt,t)}function mr(){return Yt(Wt)}async function Kt(t,e){let s=(await zt()).transaction(Y,"readwrite"),i=s.objectStore(Y).put({compositeKey:t,value:e});return new Promise((o,a)=>{i.onsuccess=c=>{o()},s.onerror=c=>{a(T.create("storage-set",{originalErrorMessage:c.target.error?.message}))}})}async function Yt(t){let n=(await zt()).transaction(Y,"readonly"),r=n.objectStore(Y).get(t);return new Promise((i,o)=>{r.onsuccess=a=>{let c=a.target.result;i(c?c.value:void 0)},n.onerror=a=>{o(T.create("storage-get",{originalErrorMessage:a.target.error?.message}))}})}function qt(t){return`${t.options.appId}-${t.name}`}var L=new D("@firebase/app-check");async function Er(t){if(G()){let e;try{e=await fr(t)}catch(n){L.warn(`Failed to read token from IndexedDB. Error: ${n}`)}return e}}function je(t,e){return G()?pr(t,e).catch(n=>{L.warn(`Failed to write token to IndexedDB. Error: ${n}`)}):Promise.resolve()}async function _r(t){let e;try{e=await mr()}catch{}if(e)return e;{let n=crypto.randomUUID(),s=`To use this token for app debugging, register it with your project.

Firebase App Check debug token: ${n}

`,r=t?.options.appId,i=t?.options.projectId;return i&&r?s+=`You can do so in the Firebase Console:
https://console.firebase.google.com/project/${i}/appcheck/apps?selectedAppId=${r}

Or using the Firebase CLI:
firebase appcheck:debugtokens:create ${n} --project ${i} --app ${r}

`:s+=`You will need to add it to your app's App Check settings in the Firebase Console for it to work.

`,s+=`Note: To keep your project secure, please revoke and delete this token using the
Firebase Console or the CLI (\`firebase appcheck:debugtokens:delete\`) when you finish debugging.

Warning: This debug token is a secret and should not be shared or uploaded to source code.

Debug Token Guide: https://firebase.google.com/docs/app-check/web/debug-provider
Firebase CLI install instructions: https://firebase.google.com/docs/cli
`,console.log(s),gr(n).catch(o=>L.warn(`Failed to persist debug token to IndexedDB. Error: ${o}`)),n}}function Je(){return ue().enabled}async function Xe(){let t=ue();if(t.enabled&&t.token)return t.token.promise;throw Error(`
            Can't get debug token in production mode.
        `)}function br(t){let e=H(),n=ue();if(n.initialized=!0,typeof e.FIREBASE_APPCHECK_DEBUG_TOKEN!="string"&&e.FIREBASE_APPCHECK_DEBUG_TOKEN!==!0)return;n.enabled=!0;let s=new O;n.token=s,typeof e.FIREBASE_APPCHECK_DEBUG_TOKEN=="string"?s.resolve(e.FIREBASE_APPCHECK_DEBUG_TOKEN):s.resolve(_r(t))}var wr={error:"UNKNOWN_ERROR"};function Sr(t){return X.encodeString(JSON.stringify(t),!1)}async function Ye(t,e=!1,n=!1){let s=t.app;Gt(s);let r=b(s),i=r.token,o;if(i&&!F(i)&&(r.token=void 0,i=void 0),!i){let l=await r.cachedTokenPromise;l&&(F(l)?i=l:await je(s,void 0))}if(!e&&i&&F(i))return{token:i.token};let a=!1;if(Je())try{let l=await Xe();r.exchangeTokenPromise||(r.exchangeTokenPromise=Vt(jt(s,l),t.heartbeatServiceProvider).finally(()=>{r.exchangeTokenPromise=void 0}),a=!0);let h=await r.exchangeTokenPromise;return await je(s,h),r.token=h,{token:h.token}}catch(l){return l.code==="appCheck/throttled"||l.code==="appCheck/initial-throttle"?L.warn(l.message):n&&L.error(l),We(l)}try{r.exchangeTokenPromise||(r.exchangeTokenPromise=r.provider.getToken().finally(()=>{r.exchangeTokenPromise=void 0}),a=!0),i=await b(s).exchangeTokenPromise}catch(l){l.code==="appCheck/throttled"||l.code==="appCheck/initial-throttle"?L.warn(l.message):n&&L.error(l),o=l}let c;return i?o?F(i)?c={token:i.token,internalError:o}:c=We(o):(c={token:i.token},r.token=i,await je(s,i)):c=We(o),a&&Qt(s,c),c}async function yr(t){let e=t.app;Gt(e);let{provider:n}=b(e);if(Je()){let s=await Xe(),r=jt(e,s);r.body.limited_use=!0;let{token:i}=await Vt(r,t.heartbeatServiceProvider);return{token:i}}else{let{token:s}=await n.getToken(!0);return{token:s}}}function Jt(t,e,n,s){let{app:r}=t,i=b(r),o={next:n,error:s,type:e};if(i.tokenObservers=[...i.tokenObservers,o],i.token&&F(i.token)){let a=i.token;Promise.resolve().then(()=>{n({token:a.token}),Bt(t)}).catch(()=>{})}i.cachedTokenPromise.then(()=>Bt(t))}function Xt(t,e){let n=b(t),s=n.tokenObservers.filter(r=>r.next!==e);s.length===0&&n.tokenRefresher&&n.tokenRefresher.isRunning()&&n.tokenRefresher.stop(),n.tokenObservers=s}function Bt(t){let{app:e}=t,n=b(e),s=n.tokenRefresher;s||(s=Ar(t),n.tokenRefresher=s),!s.isRunning()&&n.isTokenAutoRefreshEnabled&&s.start()}function Ar(t){let{app:e}=t;return new Ke(async()=>{let n=b(e),s;if(n.token?s=await Ye(t,!0):s=await Ye(t),s.error)throw s.error;if(s.internalError)throw s.internalError},()=>!0,()=>{let n=b(e);if(n.token){let s=n.token.issuedAtTimeMillis+(n.token.expireTimeMillis-n.token.issuedAtTimeMillis)*.5+3e5,r=n.token.expireTimeMillis-300*1e3;return s=Math.min(s,r),Math.max(0,s-Date.now())}else return 0},$t.RETRIAL_MIN_WAIT,$t.RETRIAL_MAX_WAIT)}function Qt(t,e){let n=b(t).tokenObservers;for(let s of n)try{s.type==="EXTERNAL"&&e.error!=null?s.error(e.error):s.next(e)}catch{}}function F(t){return t.expireTimeMillis-Date.now()>0}function We(t){return{token:Sr(wr),error:t}}var qe=class{constructor(e,n){this.app=e,this.heartbeatServiceProvider=n}_delete(){let{tokenObservers:e}=b(this.app);for(let n of e)Xt(this.app,n.next);return Promise.resolve()}};function Tr(t,e){return new qe(t,e)}function Or(t){return{getToken:e=>Ye(t,e),getLimitedUseToken:()=>yr(t),addTokenListener:e=>Jt(t,"INTERNAL",e),removeTokenListener:e=>Xt(t.app,e)}}var Cr="@firebase/app-check",Rr="0.13.1";var le=class t{constructor(e){this._customProviderOptions=e}async getToken(){let e=await this._customProviderOptions.getToken(),n=st(e.token),s=n!==null&&n<Date.now()&&n>0?n*1e3:Date.now();return{...e,issuedAtTimeMillis:s}}initialize(e){this._app=e}isEqual(e){return e instanceof t?this._customProviderOptions.getToken.toString()===e._customProviderOptions.getToken.toString():!1}};function Zt(t=re(),e){t=Z(t);let n=se(t,"app-check");if(ue().initialized||br(t),Je()&&Xe().then(r=>{console.log(`Firebase App Check debug token: ${r}`)}),n.isInitialized()){let r=n.getImmediate(),i=n.getOptions();if(i&&!!i.isTokenAutoRefreshEnabled==!!e.isTokenAutoRefreshEnabled&&i.provider?.isEqual(e.provider))return r;throw T.create("already-initialized",{appName:t.name})}let s=n.initialize({options:e});return Ir(t,e.provider,e.isTokenAutoRefreshEnabled),b(t).isTokenAutoRefreshEnabled&&Jt(s,"INTERNAL",()=>{}),s}function Ir(t,e,n=!1){let s=or(t,{...Ht});s.activated=!0,s.provider=e,s.cachedTokenPromise=Er(t).then(r=>(r&&F(r)&&(s.token=r,Qt(t,{token:r.token})),r)),s.isTokenAutoRefreshEnabled=n&&t.automaticDataCollectionEnabled,!t.automaticDataCollectionEnabled&&n&&L.warn("`isTokenAutoRefreshEnabled` is true but `automaticDataCollectionEnabled` was set to false during `initializeApp()`. This blocks automatic token refresh."),s.provider.initialize(t)}var vr="app-check",Ft="app-check-internal";function Dr(){k(new _(vr,t=>{let e=t.getProvider("app").getImmediate(),n=t.getProvider("heartbeat");return Tr(e,n)},"PUBLIC").setInstantiationMode("EXPLICIT").setInstanceCreatedCallback((t,e,n)=>{t.getProvider(Ft).initialize()})),k(new _(Ft,t=>{let e=t.getProvider("app-check").getImmediate();return Or(e)},"PUBLIC").setInstantiationMode("EXPLICIT")),y(Cr,Rr)}Dr();return an(kr);})();
/*! Bundled license information:

@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
@firebase/logger/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/util/dist/index.esm.js:
@firebase/util/dist/index.esm.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/util/dist/index.esm.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/util/dist/index.esm.js:
@firebase/component/dist/esm/index.esm.js:
@firebase/app/dist/esm/index.esm.js:
@firebase/app/dist/esm/index.esm.js:
@firebase/app/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/util/dist/index.esm.js:
firebase/app/dist/esm/index.esm.js:
@firebase/app-check/dist/esm/index.esm.js:
@firebase/app-check/dist/esm/index.esm.js:
@firebase/app-check/dist/esm/index.esm.js:
@firebase/app-check/dist/esm/index.esm.js:
@firebase/app-check/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2020 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/util/dist/index.esm.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/util/dist/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/app/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/app/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2019 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/ai/dist/esm/index.esm.js:
@firebase/ai/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/ai/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2024 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2026 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
  (**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/ai/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2026 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@firebase/app-check/dist/esm/index.esm.js:
@firebase/app-check/dist/esm/index.esm.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *   http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
*/
return RpfFirebase;
    // <<< FIREBASE SDK BUNDLE <<<
  }
  /* eslint-enable */

  try {
    const app = new App();
    app.init().catch((error) => console.error('[RP Fanverse] startup failed', error));
  } catch (error) {
    console.error('[RP Fanverse] failed to construct app', error);
  }
})();
