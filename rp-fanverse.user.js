// ==UserScript==
// @name         RP Fanverse
// @namespace    https://crack.wrtn.ai/
// @version      0.9.0
// @description  Treats a Crack RP episode as canon and grows a persistent virtual Pixiv/Reddit fandom around it.
// @author       Personal userscript
// @match        https://crack.wrtn.ai/stories/*/episodes/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      crack-api.wrtn.ai
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function () {
  'use strict';

  const APP_VERSION = '0.9.0';
  const DB_NAME = 'rp-fanverse';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'rp-fanverse:settings:v1';
  const WORLD_RE = /^\/stories\/([^/]+)\/episodes\/([^/?#]+)/;
  const API_BASE = 'https://crack-api.wrtn.ai/crack-gen/v3';
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const DEFAULT_SETTINGS = Object.freeze({
    apiKey: '',
    model: 'gemini-3.5-flash',
    turnsPerUpdate: 5,
    activity: 'Normal',
    fanworkLanguage: '日本語',
    fanworkTargetLength: 4000,
    streaming: true,
    autoUpdate: true,
    pollSeconds: 30,
    uiScale: 1,
  });

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

  if (typeof window === 'undefined' || !window.document) {
    globalThis.__RP_FANVERSE_TEST_HOOKS__ = {
      parseWorldFromUrl,
      resolveActiveBranch,
      buildTurns,
      normalizeDomMessageOrder,
      hash: Utils.hash,
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
    canonExtractor(input) {
      return `You are the Canon Extractor for RP Fanverse. The RP log is the only canon. Extract only explicit facts, events, knowledge states, spoken claims (without assuming they are true), and confirmed feelings. Never turn inference into canon. Preserve uncertainty. Return Korean descriptions while retaining proper names in their source language when useful.\n\nCURRENT CANON:\n${JSON.stringify(input.canon)}\n\nNEW RP TURNS:\n${JSON.stringify(input.turns)}\n\nEvery item must cite sourceMessageIds and sourceTurnIds from the input.`;
    },
    fandomUpdate(input) {
      return `You simulate a persistent fandom reacting to an ongoing official RP canon. Keep CANON separate from FAN INTERPRETATION. Decide what fans would ship, debate, meme, or create now. One-to-one ships, triangles, poly relationships, and character-centric devotion tags are equally valid. Momentum is not romance-game affection. Schedule reactions to mature over later RP turns: quick reactions soon, essays/theories later, short canon-axis works after that, IF/AU and long works later. Activity level is ${input.activity}.\n\nCANON UPDATE:\n${JSON.stringify(input.canonUpdate)}\n\nCURRENT FANDOM STATE:\n${JSON.stringify(input.fandom)}\n\nCURRENT TURN: ${input.currentTurn}\nReturn interpretation updates, ship/tag deltas, reaction points, and pending events with dueTurn and expiryTurn.`;
    },
    redditGenerator(input) {
      return `Create virtual Reddit-like fandom posts reacting to the supplied canon and fan interpretations. Use only the persistent persona IDs provided. Users share canon facts but disagree in interpretation. Include analysis, theories, episode discussion, CP discussion, unpopular opinions, and occasional text memes. Comments are a flat list with id and parentId for nested rendering. Do not claim fan theories are canon. Language: Korean, with natural fandom jargon.\n\nPERSONAS:\n${JSON.stringify(input.personas)}\n\nREACTION INPUT:\n${JSON.stringify(input.reactions)}\n\nACTIVITY: ${input.activity}`;
    },
    pixivMetadataGenerator(input) {
      return `Create metadata only for virtual Japanese Pixiv-like fanworks based on the supplied fandom reaction input. Do NOT write the full work. Use only persistent author persona IDs provided. Mix 原作軸, 幕間, IF, AU, future fabrication, multi-person relationships, and character-centric works as appropriate. Titles/captions/tags should feel natural in Japanese. Source canon IDs must be retained.\n\nAUTHORS:\n${JSON.stringify(input.personas)}\n\nREACTION INPUT:\n${JSON.stringify(input.reactions)}\n\nACTIVITY: ${input.activity}`;
    },
    fanwork(input) {
      return `You are writing a virtual fanwork based on an RP treated as official canon. This is FANWORK, not canon. Respect the metadata, author persona, relevant canon facts, and chosen divergence type. Write naturally in ${input.language}. Target approximately ${input.targetLength} characters. Do not add meta commentary before or after the work.\n\nWORK METADATA:\n${JSON.stringify(input.work)}\n\nAUTHOR:\n${JSON.stringify(input.author)}\n\nRELEVANT CANON:\n${JSON.stringify(input.canon)}\n\nFANDOM CONTEXT:\n${JSON.stringify(input.fandom)}`;
    },
    fanworkOutline(input) {
      return `Plan a coherent long fanwork in ${input.language}, around ${input.targetLength} characters, based on this metadata and canon. Return a title, premise, continuity constraints, and exactly three section plans.\n${JSON.stringify(input)}`;
    },
    continuity(input) {
      return `Check this virtual fanwork against its own outline and supplied canon. Fanwork divergence is allowed when labeled; identify only accidental contradictions, name drift, timeline breaks, and unresolved continuity problems. Return concise issues and continuityNotes.\n${JSON.stringify(input)}`;
    },
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
        personaId: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, category: { type: 'string' }, spoiler: { type: 'boolean' }, score: { type: 'integer' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } }, comments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, parentId: { type: ['string', 'null'] }, personaId: { type: 'string' }, body: { type: 'string' }, score: { type: 'integer' } }, required: ['id', 'parentId', 'personaId', 'body', 'score'] } },
      }, required: ['personaId', 'title', 'body', 'category', 'spoiler', 'score', 'sourceCanonEventIds', 'comments'] } } }, required: ['posts'],
    },
    pixiv: {
      type: 'object', properties: { works: { type: 'array', items: { type: 'object', properties: {
        authorId: { type: 'string' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ship: { type: 'string' }, caption: { type: 'string' }, summary: { type: 'string' }, fictionalCharacterCount: { type: 'integer' }, views: { type: 'integer' }, bookmarks: { type: 'integer' }, sourceCanonEventIds: { type: 'array', items: { type: 'string' } }, workType: { type: 'string' }, tone: { type: 'string' }, seriesTitle: { type: 'string' },
      }, required: ['authorId', 'title', 'tags', 'ship', 'caption', 'summary', 'fictionalCharacterCount', 'views', 'bookmarks', 'sourceCanonEventIds', 'workType', 'tone', 'seriesTitle'] } } }, required: ['works'],
    },
    outline: { type: 'object', properties: { title: { type: 'string' }, premise: { type: 'string' }, continuityConstraints: { type: 'array', items: { type: 'string' } }, sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, plan: { type: 'string' } }, required: ['title', 'plan'] } } }, required: ['title', 'premise', 'continuityConstraints', 'sections'] },
    continuity: { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, continuityNotes: { type: 'array', items: { type: 'string' } } }, required: ['issues', 'continuityNotes'] },
  };

  class GeminiClient {
    constructor(getSettings) {
      this.getSettings = getSettings;
    }

    endpoint(stream = false) {
      const settings = this.getSettings();
      const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      return `${GEMINI_BASE}/${encodeURIComponent(settings.model)}:${method}`;
    }

    request(payload, { stream = false, onChunk = null } = {}) {
      const settings = this.getSettings();
      if (!settings.apiKey) return Promise.reject(new Error('Gemini API key is not configured'));
      return new Promise((resolve, reject) => {
        let consumed = 0;
        let accumulated = '';
        GM_xmlhttpRequest({
          method: 'POST', url: this.endpoint(stream),
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
          data: JSON.stringify(payload), timeout: 120000,
          onprogress: stream ? (response) => {
            const fresh = String(response.responseText || '').slice(consumed);
            consumed += fresh.length;
            for (const line of fresh.split(/\r?\n/)) {
              if (!line.startsWith('data: ')) continue;
              try {
                const json = JSON.parse(line.slice(6));
                const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
                if (text) { accumulated += text; onChunk?.(accumulated); }
              } catch (_) { /* incomplete SSE line; final response is reparsed below */ }
            }
          } : undefined,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              let message = `Gemini HTTP ${response.status}`;
              try { message = JSON.parse(response.responseText)?.error?.message || message; } catch (_) { /* noop */ }
              reject(new Error(message)); return;
            }
            try {
              if (stream) {
                let full = '';
                for (const line of String(response.responseText || '').split(/\r?\n/)) {
                  if (!line.startsWith('data: ')) continue;
                  const json = JSON.parse(line.slice(6));
                  full += json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
                }
                resolve(full || accumulated);
              } else {
                const json = JSON.parse(response.responseText);
                const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
                if (!text) throw new Error('Gemini returned no text candidate');
                resolve(text);
              }
            } catch (error) { reject(error); }
          },
          onerror: () => reject(new Error('Gemini network error')),
          ontimeout: () => reject(new Error('Gemini request timed out')),
        });
      });
    }

    async generateJson(prompt, schema, { retries = 1, temperature = 0.5 } = {}) {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const text = await this.request({
            contents: [{ role: 'user', parts: [{ text: attempt ? `${prompt}\n\nPrevious output failed validation. Return complete valid JSON only.` : prompt }] }],
            generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
          });
          const parsed = Utils.parseJson(text);
          if (!parsed || typeof parsed !== 'object') throw new Error('Structured response is not an object');
          return parsed;
        } catch (error) { lastError = error; }
      }
      throw lastError;
    }

    async generateText(prompt, { stream = false, onChunk = null, temperature = 0.85 } = {}) {
      return this.request({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } }, { stream, onChunk });
    }

    async testConnection() {
      const text = await this.request({ contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK.' }] }], generationConfig: { temperature: 0, maxOutputTokens: 8 } });
      return text.trim();
    }
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
        if (this.world.processedTurnIds.some((id) => !activeTurnIds.has(id))) this.world.needsCanonRebuild = true;
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
      if (!settings.autoUpdate || !settings.apiKey || this.updating) return;
      const activeTurns = turns || await this.allActiveTurns();
      const processed = new Set(this.world.processedTurnIds);
      const unprocessed = activeTurns.filter((turn) => !processed.has(turn.id));
      if (unprocessed.length < settings.turnsPerUpdate) return;
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
      const pending = (fandomResult.pendingEvents || []).map((event) => ({ ...event, id: Utils.uid('pending'), worldId: this.world.id, createdTurn: currentTurn, generated: false }));
      await this.db.bulkPut(STORES.pendingEvents, pending);
      const allPending = await this.db.getAllByWorld(STORES.pendingEvents, this.world.id);
      const due = allPending.filter((event) => !event.generated && event.dueTurn <= currentTurn && event.expiryTurn >= currentTurn);
      const reactions = { immediate: fandomResult.reactionPoints || [], due, canonEvents, interpretations };
      await Promise.all([this.generateReddit(reactions, currentTurn), this.generatePixiv(reactions, currentTurn)]);
      for (const event of due) { event.generated = true; event.generatedTurn = currentTurn; await this.db.put(STORES.pendingEvents, event); }
      this.world.fandom.history.push({ turn: currentTurn, at: new Date().toISOString(), canonEventIds: canonEvents.map((event) => event.id), interpretationIds: interpretations.map((item) => item.id) });
      return { fandomResult, interpretations };
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

    async generateReddit(reactions, currentTurn) {
      const result = await this.gemini.generateJson(PromptLibrary.redditGenerator({ personas: this.world.personas.reddit, reactions, activity: this.getSettings().activity }), Schemas.reddit, { retries: 1, temperature: 0.85 });
      const personaIds = new Set(this.world.personas.reddit.map((persona) => persona.id));
      const posts = (result.posts || []).slice(0, this.activityLimit('reddit')).map((post) => ({
        ...post, id: Utils.uid('reddit'), worldId: this.world.id, turn: currentTurn, createdAt: new Date().toISOString(),
        personaId: personaIds.has(post.personaId) ? post.personaId : this.world.personas.reddit[0].id,
        comments: (post.comments || []).map((comment) => ({ ...comment, personaId: personaIds.has(comment.personaId) ? comment.personaId : this.world.personas.reddit[0].id })),
      }));
      await this.db.bulkPut(STORES.redditPosts, posts);
      const redditText = posts.map((post) => `${post.title} ${post.body} ${post.comments.map((comment) => comment.body).join(' ')}`).join(' ');
      for (const collection of [this.world.fandom.ships, this.world.fandom.tags]) {
        for (const item of collection) if (redditText.includes(item.tag)) item.redditMentions = (item.redditMentions || 0) + 1;
      }
      this.world.fandom.recentPlatformSignals = [...(this.world.fandom.recentPlatformSignals || []), ...posts.filter((post) => post.score >= 100).map((post) => ({ kind: 'reddit', turn: currentTurn, summary: `Reddit 화제: ${post.title}`, score: post.score, sourceCanonEventIds: post.sourceCanonEventIds }))].slice(-30);
      this.world.badges.reddit += posts.length; this.world.badges.phone += posts.length;
    }

    async generatePixiv(reactions, currentTurn) {
      const result = await this.gemini.generateJson(PromptLibrary.pixivMetadataGenerator({ personas: this.world.personas.pixiv, reactions, activity: this.getSettings().activity }), Schemas.pixiv, { retries: 1, temperature: 0.9 });
      const personaIds = new Set(this.world.personas.pixiv.map((persona) => persona.id));
      const works = (result.works || []).slice(0, this.activityLimit('pixiv')).map((work, index) => ({
        ...work, id: Utils.uid('pixiv'), worldId: this.world.id, turn: currentTurn, publishOrder: Date.now() + index,
        createdAt: new Date().toISOString(), hasFullText: false,
        authorId: personaIds.has(work.authorId) ? work.authorId : this.world.personas.pixiv[0].id,
      }));
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
    }

    async generateFanwork(work, onChunk) {
      const cached = await this.db.get(STORES.fanworks, work.id);
      if (cached) return cached;
      const settings = this.getSettings();
      const author = this.world.personas.pixiv.find((persona) => persona.id === work.authorId);
      const canonEvents = await this.db.getAllByWorld(STORES.canonEvents, this.world.id);
      const relevant = canonEvents.filter((event) => work.sourceCanonEventIds?.includes(event.id));
      let text; let outline = null; let continuity = null;
      const input = { work, author, canon: relevant, fandom: this.fandomSnapshot(), language: settings.fanworkLanguage, targetLength: settings.fanworkTargetLength };
      if (settings.fanworkTargetLength > 8000) {
        outline = await this.gemini.generateJson(PromptLibrary.fanworkOutline(input), Schemas.outline, { retries: 1, temperature: 0.65 });
        const sections = [];
        for (let i = 0; i < outline.sections.slice(0, 3).length; i += 1) {
          const sectionPrompt = `${PromptLibrary.fanwork(input)}\n\nOUTLINE:\n${JSON.stringify(outline)}\n\nWrite section ${i + 1} of 3 only. Maintain continuity with previous text:\n${sections.join('\n\n').slice(-12000)}`;
          const section = await this.gemini.generateText(sectionPrompt, { stream: settings.streaming, onChunk: (chunk) => onChunk?.([...sections, chunk].join('\n\n')) });
          sections.push(section);
        }
        text = sections.join('\n\n');
        continuity = await this.gemini.generateJson(PromptLibrary.continuity({ outline, text, canon: relevant }), Schemas.continuity, { retries: 1, temperature: 0.2 });
      } else {
        text = await this.gemini.generateText(PromptLibrary.fanwork(input), { stream: settings.streaming, onChunk });
      }
      const record = { id: work.id, worldId: this.world.id, text, outline, continuity, generatedAt: new Date().toISOString(), language: settings.fanworkLanguage };
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

  class PhoneUI {
    constructor(engine, db, getSettings, saveSettings) {
      this.engine = engine; this.db = db; this.getSettings = getSettings; this.saveSettings = saveSettings;
      this.host = null; this.root = null; this.open = false; this.view = 'home'; this.route = null; this.toastTimer = null;
    }

    mount() {
      if (this.host?.isConnected) return;
      this.host = document.createElement('div');
      this.host.id = 'rp-fanverse-host';
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${this.css()}</style><button class="launcher" aria-label="RP Fanverse 열기">▣<span class="launcher-badge"></span></button><div class="veil" hidden><section class="phone" role="dialog" aria-label="RP Fanverse"><header><button data-action="back" aria-label="뒤로">‹</button><div class="brand">FANVERSE <small></small></div><button data-action="close" aria-label="닫기">×</button></header><main></main><nav><button data-view="home">⌂<span>Home</span></button><button data-view="pixiv">P<span>Pixiv</span></button><button data-view="reddit">R<span>Reddit</span></button><button data-view="settings">⚙<span>Settings</span></button></nav><div class="toast" hidden></div></section></div>`;
      document.documentElement.appendChild(this.host);
      this.host.style.setProperty('--ui-scale', String(this.getSettings().uiScale || 1));
      this.bind(); this.refreshBadges();
    }

    css() {
      return `:host{all:initial;--ink:#252329;--muted:#77717c;--paper:#fbfaf8;--accent:#7567d8;--pink:#ee6c9f;--line:#e8e3ea;font-family:Inter,"Noto Sans KR",system-ui,sans-serif;color:var(--ink)}*{box-sizing:border-box}.launcher{position:fixed;right:18px;bottom:96px;z-index:2147483000;width:46px;height:58px;border:2px solid #29252e;border-radius:12px;background:#f9f7ff;color:#7567d8;font-size:24px;box-shadow:0 5px 22px #0003;cursor:pointer}.launcher:before{content:"";position:absolute;inset:5px;border:1px solid #bcb4da;border-radius:7px}.launcher-badge,.app-badge{position:absolute;right:-7px;top:-7px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e54863;color:white;font:700 11px/20px system-ui;text-align:center}.veil{position:fixed;inset:0;z-index:2147483001;background:#15121b88;display:grid;place-items:center;padding:16px}.phone{width:min(410px,calc(100vw - 20px));height:min(780px,calc(100vh - 24px));background:var(--paper);border:1px solid #3b3542;border-radius:28px;overflow:hidden;box-shadow:0 26px 70px #0007;display:grid;grid-template-rows:58px 1fr 62px;transform:scale(var(--ui-scale,1))}.phone>header{display:grid;grid-template-columns:48px 1fr 48px;align-items:center;padding:0 8px;border-bottom:1px solid var(--line);background:#fff}.phone header button{border:0;background:transparent;font-size:29px;color:var(--ink);cursor:pointer}.brand{text-align:center;font:800 14px/1.1 system-ui;letter-spacing:.15em}.brand small{display:block;margin-top:4px;color:var(--muted);font:500 9px/1 system-ui;letter-spacing:.02em}.phone main{overflow:auto;padding:16px;background:linear-gradient(160deg,#fdfcf9,#f7f4fb)}.phone nav{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);background:#fff}.phone nav button{position:relative;border:0;background:transparent;color:var(--muted);font-size:20px;cursor:pointer}.phone nav button span{display:block;font-size:9px}.phone nav button.active{color:var(--accent)}.toast{position:absolute;left:24px;right:24px;bottom:78px;background:#242129;color:white;padding:11px 14px;border-radius:12px;font:12px/1.4 system-ui;box-shadow:0 6px 20px #0004}.hero{padding:18px;border-radius:20px;background:linear-gradient(135deg,#302b42,#7a68d9);color:white;margin-bottom:14px}.hero h2{margin:0 0 6px;font-size:20px}.hero p{margin:0;opacity:.8;font-size:12px}.apps{display:grid;grid-template-columns:1fr 1fr;gap:12px}.app{position:relative;border:1px solid var(--line);border-radius:18px;background:white;padding:20px 12px;text-align:center;cursor:pointer;box-shadow:0 4px 14px #4030540b}.app strong{display:block;font-size:14px;margin-top:9px}.app .icon{margin:auto;width:54px;height:54px;border-radius:16px;display:grid;place-items:center;color:white;font:800 23px/1 system-ui}.app.pixiv .icon{background:linear-gradient(135deg,#4aa7ff,#2b63d9)}.app.reddit .icon{background:linear-gradient(135deg,#ff7e62,#dd4c40)}.app .app-badge{right:8px;top:8px}.status{margin-top:14px;padding:12px;border:1px solid var(--line);border-radius:14px;background:#fff;font-size:11px;color:var(--muted)}.toolbar{display:flex;gap:7px;align-items:center;margin-bottom:12px}.toolbar input,.toolbar select{min-width:0;flex:1;border:1px solid var(--line);border-radius:10px;padding:9px;background:white;color:var(--ink)}.tabs{display:flex;gap:6px;margin-bottom:12px}.tabs button,.chip,.small-btn{border:1px solid var(--line);background:white;border-radius:999px;padding:7px 10px;font-size:11px;cursor:pointer}.tabs button.active,.chip.active{background:var(--ink);color:white}.card{border:1px solid var(--line);background:white;border-radius:16px;padding:14px;margin-bottom:10px;box-shadow:0 3px 13px #4030540a;cursor:pointer}.card h3{font-size:14px;margin:0 0 6px}.meta{color:var(--muted);font-size:10px}.body{font-size:12px;line-height:1.6;margin-top:9px}.tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}.tag{color:#456bb0;background:#edf4ff;border-radius:7px;padding:3px 6px;font-size:10px}.score{color:#d85a46;font-weight:700}.spoiler{filter:blur(5px);cursor:pointer}.spoiler:hover{filter:none}.comments{margin-top:12px}.comment{border-left:2px solid var(--line);margin-top:8px;padding-left:10px}.work-title{font-family:Georgia,"Noto Serif JP",serif;font-size:16px}.work-body{font-family:Georgia,"Noto Serif JP",serif;font-size:13px;line-height:1.9;white-space:pre-wrap}.setting{display:block;margin-bottom:12px}.setting>span{display:block;font-size:11px;font-weight:700;margin-bottom:5px}.setting input,.setting select{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px;background:white}.setting.inline{display:flex;align-items:center;gap:9px}.setting.inline>span{margin:0;flex:1}.setting.inline input{width:auto}.actions{display:grid;gap:8px}.actions button{border:1px solid var(--line);background:white;border-radius:11px;padding:10px;text-align:left;cursor:pointer}.actions button.danger{color:#b8384b;border-color:#efc8cf}.section-title{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px}.empty{text-align:center;color:var(--muted);padding:34px 10px;font-size:12px}.progress{height:7px;background:#ece8ef;border-radius:9px;overflow:hidden;margin:8px 0}.progress span{display:block;height:100%;background:var(--accent)}@media(max-width:500px){.launcher{right:10px;bottom:78px}.veil{padding:0}.phone{width:100vw;height:100vh;border:0;border-radius:0;transform:none}}`;
    }

    bind() {
      this.root.querySelector('.launcher').addEventListener('click', () => this.show());
      this.root.querySelector('[data-action="close"]').addEventListener('click', () => this.hide());
      this.root.querySelector('[data-action="back"]').addEventListener('click', () => { this.route = null; this.render(); });
      this.root.querySelectorAll('nav [data-view]').forEach((button) => button.addEventListener('click', () => this.go(button.dataset.view)));
      this.root.querySelector('.veil').addEventListener('click', (event) => { if (event.target.classList.contains('veil')) this.hide(); });
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && this.open) this.hide(); });
      this.root.querySelector('main').addEventListener('click', (event) => this.handleClick(event));
      this.root.querySelector('main').addEventListener('change', (event) => this.handleChange(event));
    }

    show() { this.open = true; this.root.querySelector('.veil').hidden = false; this.render(); }
    hide() { this.open = false; this.root.querySelector('.veil').hidden = true; }
    go(view, route = null) { this.view = view; this.route = route; this.render(); }

    notify(kind, message) {
      const toast = this.root?.querySelector('.toast');
      if (!toast) return;
      toast.textContent = message; toast.hidden = false; toast.dataset.kind = kind;
      clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => { toast.hidden = true; }, kind === 'error' ? 7000 : 3500);
      if (this.open) this.renderHeader();
    }

    renderHeader() {
      const small = this.root.querySelector('.brand small');
      if (small) small.textContent = this.engine.world ? `${this.engine.world.turnCount} turns · ${this.engine.world.sync.adapter}` : 'connecting…';
    }

    refreshBadges() {
      if (!this.root || !this.engine.world) return;
      const count = this.engine.world.badges.phone || 0;
      const badge = this.root.querySelector('.launcher-badge');
      badge.textContent = count > 99 ? '99+' : count || '';
      badge.hidden = !count;
    }

    async render() {
      if (!this.open || !this.engine.world) { this.refreshBadges(); return; }
      this.renderHeader();
      this.root.querySelectorAll('nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === this.view));
      const main = this.root.querySelector('main');
      main.innerHTML = '<div class="empty">불러오는 중…</div>';
      try {
        if (this.view === 'home') main.innerHTML = this.homeHtml();
        if (this.view === 'reddit') main.innerHTML = await this.redditHtml();
        if (this.view === 'pixiv') main.innerHTML = await this.pixivHtml();
        if (this.view === 'settings') main.innerHTML = this.settingsHtml();
      } catch (error) { main.innerHTML = `<div class="empty">${Utils.escapeHtml(error.message)}</div>`; }
      this.refreshBadges();
    }

    homeHtml() {
      const world = this.engine.world;
      const sync = world.sync.status === 'fallback' ? `⚠ ${world.sync.error}` : `✓ ${world.sync.adapter === 'api' ? 'Crack API' : '동기화 대기'}`;
      return `<div class="hero"><h2>RP is CANON.</h2><p>공식이 움직일 때마다 팬덤의 역사도 자랍니다.</p></div><div class="apps"><button class="app pixiv" data-go="pixiv"><span class="icon">P</span><strong>創作庫</strong>${world.badges.pixiv ? `<span class="app-badge">${world.badges.pixiv}</span>` : ''}</button><button class="app reddit" data-go="reddit"><span class="icon">R</span><strong>Fan Forum</strong>${world.badges.reddit ? `<span class="app-badge">${world.badges.reddit}</span>` : ''}</button></div><div class="status"><b>${world.turnCount} RP turns</b><br>${Utils.escapeHtml(sync)}<br>${world.needsCanonRebuild ? '재생성/삭제로 활성 원작 분기가 바뀌었습니다. Settings에서 Canon rebuild가 필요합니다.' : world.needsImport ? '기존 장기 로그가 감지되었습니다. Settings에서 원작 가져오기를 실행하세요.' : `다음 자동 갱신: ${Math.max(0, this.getSettings().turnsPerUpdate - ((world.turnCount - world.lastProcessedTurn) % this.getSettings().turnsPerUpdate))} turns`}</div><div class="section-title">Trending</div><div class="tags">${world.fandom.ships.slice(0, 8).map((ship) => `<button class="chip" data-tag="${Utils.escapeHtml(ship.tag)}">#${Utils.escapeHtml(ship.tag)} · ${Math.round(ship.momentum)}</button>`).join('') || '<span class="meta">아직 팬덤 데이터가 없습니다.</span>'}</div>`;
    }

    async redditHtml() {
      const posts = (await this.db.getAllByWorld(STORES.redditPosts, this.engine.world.id)).sort((a, b) => b.turn - a.turn).slice(0, 50);
      if (this.route?.type === 'reddit-post') {
        const post = posts.find((item) => item.id === this.route.id);
        if (!post) return '<div class="empty">게시물을 찾을 수 없습니다.</div>';
        const persona = this.engine.world.personas.reddit.find((item) => item.id === post.personaId);
        return `<article class="card"><div class="meta">r/Fanverse · u/${Utils.escapeHtml(persona?.name || post.personaId)} · ${Utils.escapeHtml(post.category)}</div><h3>${Utils.escapeHtml(post.title)}</h3><div class="body ${post.spoiler ? 'spoiler' : ''}">${Utils.nl2br(post.body)}</div><div class="meta"><span class="score">▲ ${post.score}</span> · ${post.comments.length} comments</div></article><div class="comments">${this.commentTree(post.comments)}</div>`;
      }
      this.engine.world.badges.reddit = 0;
      this.engine.world.badges.phone = this.engine.world.badges.pixiv;
      this.engine.saveWorld();
      return `<div class="toolbar"><strong>Fan Forum</strong><span class="meta">최신 공식 전개 토론</span></div>${posts.map((post) => { const persona = this.engine.world.personas.reddit.find((item) => item.id === post.personaId); return `<article class="card" data-reddit-id="${post.id}"><div class="meta">u/${Utils.escapeHtml(persona?.name || post.personaId)} · ${Utils.escapeHtml(post.category)}</div><h3>${post.spoiler ? '⚠ SPOILER · ' : ''}${Utils.escapeHtml(post.title)}</h3><div class="body">${Utils.escapeHtml(post.body).slice(0, 280)}${post.body.length > 280 ? '…' : ''}</div><div class="meta"><span class="score">▲ ${post.score}</span> · ${post.comments.length} comments</div></article>`; }).join('') || '<div class="empty">다음 Fanverse update 뒤 토론이 생깁니다.</div>'}`;
    }

    commentTree(comments, parentId = null, depth = 0) {
      return (comments || []).filter((comment) => (comment.parentId || null) === parentId).map((comment) => {
        const persona = this.engine.world.personas.reddit.find((item) => item.id === comment.personaId);
        return `<div class="comment" style="margin-left:${Math.min(depth, 5) * 8}px"><div class="meta">u/${Utils.escapeHtml(persona?.name || comment.personaId)} · ▲ ${comment.score}</div><div class="body">${Utils.nl2br(comment.body)}</div>${this.commentTree(comments, comment.id, depth + 1)}</div>`;
      }).join('');
    }

    async pixivHtml() {
      let works = await this.db.getAllByWorld(STORES.pixivWorks, this.engine.world.id);
      works.sort((a, b) => b.publishOrder - a.publishOrder);
      if (this.route?.type === 'pixiv-work') {
        const work = works.find((item) => item.id === this.route.id);
        if (!work) return '<div class="empty">작품을 찾을 수 없습니다.</div>';
        const author = this.engine.world.personas.pixiv.find((item) => item.id === work.authorId);
        const cached = await this.db.get(STORES.fanworks, work.id);
        return `<article><div class="meta">${Utils.escapeHtml(work.workType)} · ${work.fictionalCharacterCount.toLocaleString()}字</div><h2 class="work-title">${Utils.escapeHtml(work.title)}</h2><button class="chip" data-author-id="${author?.id || ''}">${Utils.escapeHtml(author?.name || work.authorId)}</button>${work.seriesTitle ? `<button class="chip" data-series="${Utils.escapeHtml(work.seriesTitle)}">series: ${Utils.escapeHtml(work.seriesTitle)}</button>` : ''}<div class="tags">${work.tags.map((tag) => `<button class="tag" data-tag="${Utils.escapeHtml(tag)}">#${Utils.escapeHtml(tag)}</button>`).join('')}</div><p class="body">${Utils.nl2br(work.caption)}</p><p class="meta">♡ ${work.bookmarks.toLocaleString()} · 👁 ${work.views.toLocaleString()}</p>${cached ? `<div class="work-body">${Utils.escapeHtml(cached.text)}</div>${cached.continuity?.issues?.length ? `<div class="status">Continuity notes: ${cached.continuity.issues.map(Utils.escapeHtml).join(' / ')}</div>` : ''}` : `<button class="small-btn" data-generate-work="${work.id}">전문 생성해서 읽기</button><div id="fanwork-stream"></div>`}<div class="section-title">Related works</div>${works.filter((item) => item.id !== work.id && (item.ship === work.ship || item.tags.some((tag) => work.tags.includes(tag)))).slice(0, 4).map((item) => `<div class="card" data-pixiv-id="${item.id}"><h3>${Utils.escapeHtml(item.title)}</h3><div class="meta">${Utils.escapeHtml(item.workType)} · ♡${item.bookmarks}</div></div>`).join('')}</article>`;
      }
      if (this.route?.type === 'author') {
        const author = this.engine.world.personas.pixiv.find((item) => item.id === this.route.id);
        const authored = works.filter((work) => work.authorId === this.route.id);
        return `<div class="hero"><h2>${Utils.escapeHtml(author?.name || this.route.id)}</h2><p>${Utils.escapeHtml(author?.specialty || '')} · ${Utils.escapeHtml(author?.style || '')}</p></div>${authored.map((work) => this.workCard(work)).join('') || '<div class="empty">작품이 없습니다.</div>'}`;
      }
      if (this.route?.type === 'series') {
        const seriesWorks = works.filter((work) => work.seriesTitle === this.route.title).sort((a, b) => a.publishOrder - b.publishOrder);
        return `<div class="hero"><h2>${Utils.escapeHtml(this.route.title)}</h2><p>${seriesWorks.length} works series</p></div>${seriesWorks.map((work) => this.workCard(work)).join('') || '<div class="empty">시리즈 작품이 없습니다.</div>'}`;
      }
      const filter = this.route?.type === 'tag' ? this.route.tag : '';
      if (filter) works = works.filter((work) => work.tags.includes(filter) || work.ship === filter);
      if (this.route?.sort === 'popular') works.sort((a, b) => b.bookmarks - a.bookmarks);
      this.engine.world.badges.pixiv = 0;
      this.engine.world.badges.phone = this.engine.world.badges.reddit;
      this.engine.saveWorld();
      return `<div class="toolbar"><strong>創作庫</strong><input data-pixiv-search placeholder="tag search" value="${Utils.escapeHtml(filter)}"></div><div class="tabs"><button data-pixiv-sort="new" class="${this.route?.sort !== 'popular' ? 'active' : ''}">新着</button><button data-pixiv-sort="popular" class="${this.route?.sort === 'popular' ? 'active' : ''}">人気</button></div>${works.slice(0, 50).map((work) => this.workCard(work)).join('') || '<div class="empty">다음 Fanverse update 뒤 작품이 생깁니다.</div>'}`;
    }

    workCard(work) {
      const author = this.engine.world.personas.pixiv.find((item) => item.id === work.authorId);
      return `<article class="card" data-pixiv-id="${work.id}"><div class="meta">${Utils.escapeHtml(work.workType)} · ${Utils.escapeHtml(work.tone)}</div><h3 class="work-title">${Utils.escapeHtml(work.title)}</h3><div class="body">${Utils.escapeHtml(work.summary)}</div><div class="tags">${work.tags.slice(0, 6).map((tag) => `<span class="tag">#${Utils.escapeHtml(tag)}</span>`).join('')}</div><div class="meta">${Utils.escapeHtml(author?.name || work.authorId)} · ♡ ${work.bookmarks.toLocaleString()} · 👁 ${work.views.toLocaleString()}${work.hasFullText ? ' · 전문 캐시됨' : ''}</div></article>`;
    }

    settingsHtml() {
      const s = this.getSettings();
      return `<div class="section-title">Gemini</div><label class="setting"><span>API key (GM storage)</span><input type="password" data-setting="apiKey" value="${Utils.escapeHtml(s.apiKey)}" autocomplete="off"></label><label class="setting"><span>Model</span><input data-setting="model" value="${Utils.escapeHtml(s.model)}"></label><div class="actions"><button data-action="test-api">API 연결 테스트</button></div><div class="section-title">Update</div><label class="setting"><span>Turns per update</span><input type="number" min="1" max="100" data-setting="turnsPerUpdate" value="${s.turnsPerUpdate}"></label><label class="setting"><span>Fandom activity</span><select data-setting="activity">${['Quiet', 'Normal', 'Active', 'Chaos'].map((value) => `<option ${s.activity === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="setting inline"><span>Automatic fandom updates</span><input type="checkbox" data-setting="autoUpdate" ${s.autoUpdate ? 'checked' : ''}></label><div class="actions"><button data-action="update-now">처리 대기 turns 지금 갱신</button></div><div class="section-title">Fanwork</div><label class="setting"><span>Language</span><input data-setting="fanworkLanguage" value="${Utils.escapeHtml(s.fanworkLanguage)}"></label><label class="setting"><span>Target length (characters)</span><input type="number" min="500" max="30000" data-setting="fanworkTargetLength" value="${s.fanworkTargetLength}"></label><label class="setting inline"><span>Streaming</span><input type="checkbox" data-setting="streaming" ${s.streaming ? 'checked' : ''}></label><label class="setting"><span>UI scale</span><input type="number" min="0.75" max="1.25" step="0.05" data-setting="uiScale" value="${s.uiScale}"></label><div class="section-title">World data</div><div class="actions"><button data-action="sync-now">지금 API 동기화</button><button data-action="import-history">현재 RP를 원작으로 가져오기</button><button data-action="rebuild-canon">Canon rebuild (팬덤 보존)</button><button data-action="export-world">현재 world 내보내기</button><button data-action="export-all">모든 worlds 내보내기</button><button data-action="import-data">데이터 가져오기</button><input type="file" accept="application/json" data-import-file hidden><button class="danger" data-action="reset-world">현재 Fanverse 전체 초기화</button></div><div class="status">world: ${Utils.escapeHtml(this.engine.world.id)}<br>schema: ${DB_VERSION} · app: ${APP_VERSION}<br>${Utils.escapeHtml(this.engine.world.sync.status)}${this.engine.world.sync.error ? ` · ${Utils.escapeHtml(this.engine.world.sync.error)}` : ''}</div>`;
    }

    async handleClick(event) {
      const target = event.target.closest('button,[data-reddit-id],[data-pixiv-id]');
      if (!target) return;
      if (target.dataset.go) return this.go(target.dataset.go);
      if (target.dataset.redditId) { this.route = { type: 'reddit-post', id: target.dataset.redditId }; return this.render(); }
      if (target.dataset.pixivId) { this.route = { type: 'pixiv-work', id: target.dataset.pixivId }; return this.render(); }
      if (target.dataset.authorId) { this.route = { type: 'author', id: target.dataset.authorId }; return this.render(); }
      if (target.dataset.series) { this.route = { type: 'series', title: target.dataset.series }; return this.render(); }
      if (target.dataset.tag) { this.view = 'pixiv'; this.route = { type: 'tag', tag: target.dataset.tag }; return this.render(); }
      if (target.dataset.pixivSort) { this.route = { ...(this.route || {}), sort: target.dataset.pixivSort }; return this.render(); }
      if (target.dataset.generateWork) {
        const works = await this.db.getAllByWorld(STORES.pixivWorks, this.engine.world.id);
        const work = works.find((item) => item.id === target.dataset.generateWork);
        if (!work) return;
        target.disabled = true; target.textContent = '전문 생성 중…';
        const stream = this.root.querySelector('#fanwork-stream');
        try {
          await this.engine.generateFanwork(work, (text) => { if (stream) stream.innerHTML = `<div class="work-body">${Utils.escapeHtml(text)}</div>`; });
          this.notify('success', '전문을 생성하고 캐시했습니다.'); await this.render();
        } catch (error) { target.disabled = false; target.textContent = '다시 시도'; this.notify('error', error.message); }
        return;
      }
      const action = target.dataset.action;
      if (!action) return;
      if (action === 'test-api') {
        this.notify('sync', 'Gemini 연결 테스트 중…');
        try { this.notify('success', `Gemini: ${await this.engine.gemini.testConnection()}`); } catch (error) { this.notify('error', error.message); }
      }
      if (action === 'sync-now') { try { await this.engine.sync(); await this.render(); } catch (error) { this.notify('error', error.message); } }
      if (action === 'update-now') {
        try {
          if (this.engine.world.needsCanonRebuild) throw new Error('활성 원작 분기가 변경되었습니다. 먼저 Canon rebuild를 실행하세요.');
          const turns = await this.engine.allActiveTurns();
          const processed = new Set(this.engine.world.processedTurnIds);
          const pending = turns.filter((turn) => !processed.has(turn.id));
          if (!pending.length) this.notify('success', '처리 대기 중인 turn이 없습니다.');
          else await this.engine.runFandomUpdate(pending.slice(0, this.getSettings().turnsPerUpdate));
          await this.render();
        } catch (error) { this.notify('error', error.message); }
      }
      if (action === 'import-history') { try { await this.engine.importHistory((message) => this.notify('sync', message)); await this.render(); } catch (error) { this.notify('error', error.message); } }
      if (action === 'rebuild-canon') { try { await this.engine.rebuildCanon((message) => this.notify('sync', message)); await this.render(); } catch (error) { this.notify('error', error.message); } }
      if (action === 'export-world') { const dump = await this.db.dump(this.engine.world.id); Utils.download(`rp-fanverse-${this.engine.world.episodeId}.json`, JSON.stringify(dump, null, 2)); }
      if (action === 'export-all') { const dump = await this.db.dump(); Utils.download('rp-fanverse-all-worlds.json', JSON.stringify(dump, null, 2)); }
      if (action === 'import-data') this.root.querySelector('[data-import-file]').click();
      if (action === 'reset-world') {
        if (!confirm('현재 RP world의 Canon, Fandom, Pixiv, Reddit 데이터를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
        await this.db.deleteWorld(this.engine.world.id);
        await this.engine.attach(this.engine.worldInfo);
        this.notify('success', '현재 Fanverse world를 초기화했습니다.'); await this.render();
      }
    }

    async handleChange(event) {
      const input = event.target;
      if (input.dataset.setting) {
        const settings = this.getSettings();
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.type === 'number') value = Number(value);
        settings[input.dataset.setting] = value;
        await this.saveSettings(settings);
        if (input.dataset.setting === 'uiScale') this.host.style.setProperty('--ui-scale', String(value));
        this.notify('success', '설정을 저장했습니다.');
      }
      if (input.matches('[data-import-file]') && input.files?.[0]) {
        try { const payload = JSON.parse(await input.files[0].text()); await this.db.restore(payload); await this.engine.attach(this.engine.worldInfo); this.notify('success', 'Fanverse 데이터를 가져왔습니다.'); await this.render(); } catch (error) { this.notify('error', error.message); }
      }
      if (input.matches('[data-pixiv-search]')) { this.route = input.value ? { type: 'tag', tag: input.value.trim() } : null; await this.render(); }
    }
  }

  class App {
    constructor() {
      this.db = new Database(); this.api = new CrackApiAdapter(); this.dom = new CrackDomFallbackAdapter();
      this.settings = Utils.clone(DEFAULT_SETTINGS); this.gemini = new GeminiClient(() => this.settings);
      this.engine = new FanverseEngine(this.db, this.api, this.dom, this.gemini, () => this.settings, (kind, message) => this.ui?.notify(kind, message));
      this.ui = new PhoneUI(this.engine, this.db, () => this.settings, (settings) => this.persistSettings(settings));
      this.lastUrl = '';
    }

    async persistSettings(settings) {
      this.settings = { ...DEFAULT_SETTINGS, ...settings };
      await GMStore.set(SETTINGS_KEY, this.settings);
    }

    async init() {
      this.settings = { ...DEFAULT_SETTINGS, ...(await GMStore.get(SETTINGS_KEY, {})) };
      await this.db.open(); this.ui.mount();
      await this.routeChanged();
      setInterval(() => this.routeChanged(), 2000);
      setInterval(() => { if (this.engine.worldInfo && !document.hidden) this.engine.sync().catch((error) => this.ui.notify('error', error.message)); }, Math.max(15, this.settings.pollSeconds) * 1000);
    }

    async routeChanged() {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      const info = parseWorldFromUrl(location.href);
      if (!info) { this.ui.host.hidden = true; return; }
      this.ui.host.hidden = false;
      await this.engine.attach(info);
      this.ui.refreshBadges();
      await this.engine.sync().catch((error) => this.ui.notify('error', error.message));
      if (this.ui.open) await this.ui.render();
    }
  }

  const app = new App();
  app.init().catch((error) => console.error('[RP Fanverse]', error));
})();
