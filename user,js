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
