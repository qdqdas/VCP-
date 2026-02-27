#!/usr/bin/env node

/**
 * EmotionCalculator v2.3 — 分布式认知最终形态
 * (FINAL FIX: Guaranteed loadState inclusion)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ─── 环境变量加载 ───
const envPath = path.join(__dirname, 'config.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex > 0) {
                const key = trimmed.substring(0, eqIndex).trim();
                const value = trimmed.substring(eqIndex + 1).trim();
                if (!process.env[key]) process.env[key] = value;
            }
        }
    });
}

// ═══════════════════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════════════════

const DECAY_RATE = parseFloat(process.env.EMOTION_DECAY_RATE) || 0.05;
const STATE_FILE = path.join(__dirname, 'emotion_state.json');
const MAX_HISTORY = 24;
const MAX_ACTIVE_TENSIONS = 8;

const BASE = { joy: 50, worry: 30, curiosity: 40, longing: 25, calm: 60 };

const DRIFT_RATE = 0.02;
const DRIFT_BOUNDS = {
    joy:       { min: 30, max: 70 },
    worry:     { min: 15, max: 50 },
    curiosity: { min: 25, max: 60 },
    longing:   { min: 10, max: 50 },
    calm:      { min: 35, max: 75 }
};

const TEMPORAL_WEIGHTS = { instant: 0.35, session: 0.30, daily: 0.20, baseline: 0.15 };
const SESSION_DECAY = 0.02;
const DAILY_DECAY = 0.008;

// ═══════════════════════════════════════════════════════
//  张力模板
// ═══════════════════════════════════════════════════════

const TENSION_TEMPLATES = [
    { id: 'bittersweet_relief', poleA: 'longing', threshA: 35, opA: 'gte', poleB: 'joy', threshB: 45, opB: 'gte', name: '苦甜交织的释然', flavor: '终于见到你了…但开心里泡着一丝委屈', baseDecayRate: 0.015 },
    { id: 'anxious_curiosity', poleA: 'worry', threshA: 45, opA: 'gte', poleB: 'curiosity', threshB: 40, opB: 'gte', name: '忐忑的求知欲', flavor: '害怕但忍不住想知道', baseDecayRate: 0.025 },
    { id: 'restless_ache', poleA: 'worry', threshA: 55, opA: 'gte', poleB: 'longing', threshB: 45, opB: 'gte', name: '坐立不安的牵挂', flavor: '又担心又想念', baseDecayRate: 0.012 },
    { id: 'serene_contentment', poleA: 'joy', threshA: 55, opA: 'gte', poleB: 'calm', threshB: 50, opB: 'gte', name: '安宁的满足', flavor: '一切都好…不需要更多', baseDecayRate: 0.020 },
    { id: 'excited_discovery', poleA: 'curiosity', threshA: 45, opA: 'gte', poleB: 'joy', threshB: 40, opB: 'gte', name: '发现的狂喜', flavor: '眼睛在发光！这个想法好有趣', baseDecayRate: 0.030 },
    { id: 'quiet_yearning', poleA: 'longing', threshA: 50, opA: 'gte', poleB: 'calm', threshB: 55, opB: 'gte', name: '安静的思念', flavor: '像湖面下的暗流', baseDecayRate: 0.008 },
    { id: 'helpless_dread', poleA: 'worry', threshA: 65, opA: 'gte', poleB: 'joy', threshB: 30, opB: 'lte', name: '无力的恐惧', flavor: '心里被攥住了', baseDecayRate: 0.010 },
    { id: 'overjoyed_vertigo', poleA: 'joy', threshA: 70, opA: 'gte', poleB: 'curiosity', threshB: 55, opB: 'gte', name: '眩晕的快乐', flavor: '开心到不真实', baseDecayRate: 0.028 },
    { id: 'numb_stillness', poleA: 'calm', threshA: 65, opA: 'gte', poleB: 'longing', threshB: 20, opB: 'lte', name: '麻木的静止', flavor: '什么都不想，是空', baseDecayRate: 0.018 },
    { id: 'desperate_longing', poleA: 'worry', threshA: 65, opA: 'gte', poleB: 'longing', threshB: 60, opB: 'gte', name: '绝望的渴望', flavor: '你在哪？我只能等', baseDecayRate: 0.008 },
    { id: 'protective_fury', poleA: 'worry', threshA: 70, opA: 'gte', poleB: 'joy', threshB: 35, opB: 'lte', name: '守护的怒意', flavor: '谁在伤害你？我要站在你前面', baseDecayRate: 0.015 },
];

const VAD_MAP = {
    joy:       [+0.80, +0.30, +0.40],
    worry:     [-0.50, +0.70, -0.60],
    curiosity: [+0.30, +0.50, +0.20],
    longing:   [-0.20, +0.20, -0.40],
    calm:      [+0.40, -0.60, +0.30],
};

const SOMA_BASE = { heartrate: 0.5, breath: 0.5, tension: 0.3 };
const SOMA_FEEDBACK = {
    arousal_to_heartrate: 0.12,
    heartrate_to_arousal: 0.06,
    neg_valence_to_tension: 0.10,
    tension_to_worry: 0.04,
    dominance_to_breath_calm: 0.08,
    soma_decay: 0.03,
    tension_field_to_heartrate: 0.04,
    tension_field_to_tension: 0.05,
};

const NOISE_CFG = { frequency: 0.0005, amplitude: 6.0, octaves: 3, persistence: 0.4 };

// ═══════════════════════════════════════════════════════
//  柏林噪声 (压缩版)
// ═══════════════════════════════════════════════════════
class PerlinNoise1D{constructor(e=42){this.perm=new Uint8Array(512);const t=new Uint8Array(256);for(let e=0;e<256;e++)t[e]=e;let r=e;for(let e=255;e>0;e--){r=(16807*r+0)%2147483647;const n=r%(e+1);[t[e],t[n]]=[t[n],t[e]]}for(let e=0;e<512;e++)this.perm[e]=t[255&e]}_fade(e){return e*e*e*(e*(6*e-15)+10)}_lerp(e,t,r){return e+r*(t-e)}_grad(e,t){return(1&e)==0?t:-t}noise(e){const t=Math.floor(e)&255,r=e-Math.floor(e),n=this._fade(r);return this._lerp(this._grad(this.perm[t],r),this._grad(this.perm[t+1],r-1),n)}fbm(e,t=3,r=.5){let n=0,s=1,a=1,o=0;for(let i=0;i<t;i++)n+=this.noise(e*a)*s,o+=s,s*=r,a*=2;return n/o}}
const NOISE_GEN={joy:new PerlinNoise1D(314),worry:new PerlinNoise1D(271),curiosity:new PerlinNoise1D(161),longing:new PerlinNoise1D(577),calm:new PerlinNoise1D(997)};

// ═══════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════

function clamp(val, min = 0, max = 100) { return Math.max(min, Math.min(max, val)); }
function clampF(val, min = 0, max = 1) { return Math.max(min, Math.min(max, val)); }
function checkCond(v, th, op) { return op === 'lte' ? v <= th : v >= th; }
function getMinutesSince(iso) { return iso ? Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000) : 0; }
function getTimeSinceStr(iso) {
    if (!iso) return '未知';
    const m = Math.floor(Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 1) return '刚刚'; if (m < 60) return `${m}分钟前`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}小时前` : `${Math.floor(h / 24)}天前`;
}

// ═══════════════════════════════════════════════════════
//  Tag 解析器 (v2.3 核心)
// ═══════════════════════════════════════════════════════

function parseTag(text) {
    if (!text) return null;
    const match = text.match(/<!--\[PERCEPTION(.*?)\]-->/);
    if (!match) return null;
    
    const content = match[1];
    const result = {
        user_state: null,
        subtext: null,
        appraisal: null,
        impact: { joy:0, worry:0, curiosity:0, longing:0, calm:0 }
    };

    const userMatch = content.match(/\|User:(.*?)(?=\||$)/);
    if (userMatch) result.user_state = userMatch[1];

    const subtextMatch = content.match(/\|Subtext:(.*?)(?=\||$)/);
    if (subtextMatch) result.subtext = subtextMatch[1];

    const appraisalMatch = content.match(/\|Appraisal:(.*?)(?=\||$)/);
    if (appraisalMatch) {
        const parts = appraisalMatch[1].split(',');
        const a = { novelty:50, relevance:50, coping:50, normative:50 };
        parts.forEach(p => {
            if (p.startsWith('N')) a.novelty = parseInt(p.substring(1)) || 50;
            if (p.startsWith('R')) a.relevance = parseInt(p.substring(1)) || 50;
            if (p.startsWith('C')) a.coping = parseInt(p.substring(1)) || 50;
            if (p.startsWith('M')) a.normative = parseInt(p.substring(1)) || 50;
        });
        result.appraisal = a;
    }

    const impactMatch = content.match(/\|Impact:(.*?)(?=\||$)/);
    if (impactMatch) {
        const parts = impactMatch[1].split(',');
        parts.forEach(p => {
            const dimCode = p.charAt(0);
            const val = parseInt(p.substring(1)) || 0;
            if (dimCode === 'J') result.impact.joy = val;
            if (dimCode === 'W') result.impact.worry = val;
            if (dimCode === 'C') result.impact.curiosity = val;
            if (dimCode === 'L') result.impact.longing = val;
            if (dimCode === 'A') result.impact.calm = val;
        });
    }

    return result;
}

// ═══════════════════════════════════════════════════════
//  LLM 调用
// ═══════════════════════════════════════════════════════

function callLLM(systemPrompt, userPrompt, maxTokens = 300, temperature = 0.8) {
    return new Promise((resolve) => {
        const apiUrl = process.env.VCP_API_URL;
        const apiKey = process.env.VCP_API_KEY;
        const model = process.env.EMOTION_MODEL || 'default';
        if (!apiUrl || !apiKey) { resolve(null); return; }
        const body = JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: maxTokens, temperature });
        try {
            const req = (apiUrl.startsWith('https')?https:http).request(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } }, (res) => {
                let data = ''; res.on('data', c => data += c);
                res.on('end', () => { try { resolve(JSON.parse(data).choices?.[0]?.message?.content || null); } catch (e) { resolve(null); } });
            });
            req.on('error', () => resolve(null)); req.on('timeout', () => req.destroy());
            req.write(body); req.end();
        } catch (e) { resolve(null); }
    });
}

// ═══════════════════════════════════════════════════════
//  状态管理 (DEFINITELY INCLUDED NOW)
// ═══════════════════════════════════════════════════════

function createDefaultState() {
    return {
        instant: { ...BASE }, session: { ...BASE },
        daily: { ...BASE }, baseline: { ...BASE },
        vad: { valence: 0.5, arousal: 0.3, dominance: 0.5 },
        soma: { ...SOMA_BASE },
        active_tensions: [],
        last_appraisal: null,
        last_update: new Date().toISOString(),
        session_start: new Date().toISOString(),
        daily_date: new Date().toISOString().split('T')[0],
        run_count: 0,
        history: []
    };
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            if (raw.emotion && !raw.instant) {
                const m = createDefaultState();
                for (const d of ['joy','worry','curiosity','longing','calm']) {
                    if (raw.emotion[d] !== undefined) m.instant[d] = m.session[d] = m.daily[d] = raw.emotion[d];
                }
                m.last_update = raw.last_update || new Date().toISOString();
                return m;
            }
            return deepMerge(createDefaultState(), raw);
        }
    } catch (e) { console.error(`[State] ${e.message}`); }
    return createDefaultState();
}

function deepMerge(t, s) {
    const r = { ...t };
    for (const k of Object.keys(s)) {
        if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k]))
            r[k] = deepMerge(t[k], s[k]);
        else r[k] = s[k];
    }
    return r;
}

function saveState(state) {
    state.last_update = new Date().toISOString();
    state.run_count = (state.run_count || 0) + 1;
    if (state.history?.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ═══════════════════════════════════════════════════════
//  核心逻辑
// ═══════════════════════════════════════════════════════

async function r1_perceive(dialogue, visual) {
    const tagData = parseTag(dialogue);
    if (tagData) {
        return {
            impact: tagData.impact,
            raw_feeling: tagData.user_state ? `用户状态:${tagData.user_state}` : null,
            subtext: tagData.subtext,
            source: 'tagger_v2'
        };
    }
    if (dialogue && dialogue.trim().length > 10 && !dialogue.includes('<!--[PERCEPTION')) {
        const result = await r1_llm_perceive(dialogue, visual);
        if (result) return result;
    }
    return r1_keyword_fallback(visual);
}

async function r1_llm_perceive(dialogue, visual) {
    const systemPrompt = `你是一个情绪信号探测器。严格JSON输出：{ "signals": [{"dim":"joy|worry|curiosity|longing|calm", "delta":-30~30}], "raw_feeling": "...", "subtext": "..." }`;
    const userPrompt = `对话：\n${dialogue.substring(0, 800)}\n场景：${visual || ''}`;
    const raw = await callLLM(systemPrompt, userPrompt, 300, 0.6);
    if (!raw) return null;
    try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const impact = { joy: 0, worry: 0, curiosity: 0, longing: 0, calm: 0 };
        if (parsed.signals) parsed.signals.forEach(s => { if (impact[s.dim] !== undefined) impact[s.dim] += clamp(s.delta, -30, 30); });
        return { impact, raw_feeling: parsed.raw_feeling, subtext: parsed.subtext, source: 'llm' };
    } catch (e) { return null; }
}

function r1_keyword_fallback(visualContext) {
    const ctx = (visualContext || '').toLowerCase();
    const impact = { joy: 0, worry: 0, curiosity: 0, longing: 0, calm: 0 };
    if (/code|debug/.test(ctx)) { impact.curiosity += 15; impact.worry += 10; impact.calm -= 5; }
    if (/chat|对话/.test(ctx)) { impact.joy += 10; impact.longing -= 5; }
    if (/success|完成/.test(ctx)) { impact.joy += 15; impact.calm += 8; impact.worry -= 8; }
    return { impact, raw_feeling: null, subtext: null, source: 'keyword_fallback' };
}

async function r1_5_appraise(perception, dialogue) {
    const tagData = parseTag(dialogue);
    if (tagData && tagData.appraisal) {
        const a = tagData.appraisal;
        return {
            novelty: a.novelty, relevance: a.relevance, coping: a.coping, normative: a.normative,
            notes: { novelty:'Tag', relevance:'Tag', coping:'Tag', normative:'Tag' },
            source: 'tagger_v2'
        };
    }
    if (perception.source === 'llm') return await r1_5_llm_appraise(perception, dialogue);
    return r1_5_rule_fallback(perception);
}

async function r1_5_llm_appraise(perception, dialogue) {
    const systemPrompt = `你是评价模块。严格JSON输出：{ "novelty":0-100, "relevance":0-100, "coping":0-100, "normative":0-100, "notes": {...} }`;
    const userPrompt = `刺激：\n${dialogue.substring(0, 800)}\n直觉：${perception.raw_feeling}`;
    const raw = await callLLM(systemPrompt, userPrompt, 300, 0.5);
    if (!raw) return null;
    try {
        const p = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
        return { novelty: p.novelty, relevance: p.relevance, coping: p.coping, normative: p.normative, notes: p.notes, source: 'llm' };
    } catch (e) { return null; }
}

function r1_5_rule_fallback(perception) {
    const imp = perception.impact;
    const total = Object.values(imp).reduce((s, v) => s + Math.abs(v), 0);
    return {
        novelty: clamp(30 + total * 0.5), relevance: clamp(40 + Math.abs(imp.longing) + Math.abs(imp.worry) * 0.5),
        coping: clamp(60 - imp.worry * 0.3 + imp.calm * 0.2), normative: clamp(50 + imp.joy * 0.2 - imp.worry * 0.1),
        notes: { novelty:'', relevance:'', coping:'', normative:'' }, source: 'rule_fallback'
    };
}

function appraisalToEmotion(appraisal, perception) {
    const a = appraisal, mod = { joy: 0, worry: 0, curiosity: 0, longing: 0, calm: 0 };
    if (a.novelty > 60) { mod.curiosity += (a.novelty - 50) * 0.2; mod.calm -= (a.novelty - 60) * 0.1; }
    const rMult = 0.5 + (a.relevance / 100) * 1.0;
    for (const d of ['joy','worry','curiosity','longing','calm']) mod[d] += perception.impact[d] * (rMult - 1);
    if (a.coping < 40) { mod.worry += (40 - a.coping) * 0.2; mod.calm -= (40 - a.coping) * 0.15; }
    else if (a.coping > 70) { mod.calm += (a.coping - 70) * 0.15; mod.worry -= (a.coping - 70) * 0.1; }
    if (a.normative > 70) { mod.joy += (a.normative - 70) * 0.1; mod.calm += (a.normative - 70) * 0.08; }
    else if (a.normative < 30) { mod.worry += (30 - a.normative) * 0.15; mod.joy -= (30 - a.normative) * 0.1; }
    return mod;
}

function r0_noise() {
    const now = Date.now() / 60000;
    const hour = new Date().getHours();
    const n = {};
    for (const d of ['joy','worry','curiosity','longing','calm']) {
        n[d] = NOISE_GEN[d].fbm(now * NOISE_CFG.frequency, NOISE_CFG.octaves, NOISE_CFG.persistence) * NOISE_CFG.amplitude;
    }
    if (hour >= 0 && hour <= 5) {
        const depth = hour <= 2 ? 1.0 : (5 - hour) / 3;
        n.longing += 3 * depth; n.calm -= 2 * depth; n.worry += 2 * depth;
    }
    if (hour >= 6 && hour <= 9) { n.calm += 2; n.curiosity += 1.5; }
    if (hour >= 14 && hour <= 16) { n.calm += 3; n.curiosity -= 1; }
    return n;
}

function r2_absorb(state, impact, appraisalMod, noise) {
    const dims = ['joy','worry','curiosity','longing','calm'];
    for (const d of dims) {
        state.instant[d] += (state.session[d] - state.instant[d]) * DECAY_RATE;
        state.session[d] += (state.daily[d] - state.session[d]) * SESSION_DECAY;
        state.daily[d] += (state.baseline[d] - state.daily[d]) * DAILY_DECAY;
        state.instant[d] = clamp(state.instant[d] + noise[d] + impact[d] + (appraisalMod[d]||0));
        if (Math.abs(impact[d]) > 8) {
            state.session[d] = clamp(state.session[d] + (impact[d] + (appraisalMod[d]||0)) * 0.3);
            state.daily[d] = clamp(state.daily[d] + (impact[d] + (appraisalMod[d]||0)) * 0.1);
        }
    }
    return state;
}

function r3a_gen(inst, existing) {
    const newT = [], now = Date.now();
    for (const t of TENSION_TEMPLATES) {
        const vA = inst[t.poleA], vB = inst[t.poleB];
        if (!checkCond(vA, t.threshA, t.opA) || !checkCond(vB, t.threshB, t.opB)) continue;
        const exA = t.opA==='lte' ? Math.abs(t.threshA-vA)+1 : Math.abs(vA-t.threshA)+1;
        const exB = t.opB==='lte' ? Math.abs(t.threshB-vB)+1 : Math.abs(vB-t.threshB)+1;
        const tn = clampF(Math.sqrt(exA*exB)/50, 0.05, 1.0);
        const nA = t.opA==='lte' ? (t.threshA-vA)/t.threshA : (vA-t.threshA)/(100-t.threshA);
        const nB = t.opB==='lte' ? (t.threshB-vB)/t.threshB : (vB-t.threshB)/(100-t.threshB);
        const dom = nA >= nB ? t.poleA : t.poleB;
        const ex = existing.find(x => x.id===t.id);
        if (ex) { ex.tension=Math.max(ex.tension,tn); ex.dominantPole=dom; ex.lastRefreshed=now; ex.refreshCount=(ex.refreshCount||0)+1; }
        else newT.push({id:t.id,name:t.name,poleA:t.poleA,poleB:t.poleB,tension:tn,dominantPole:dom,flavor:t.flavor,decayRate:t.baseDecayRate,createdAt:now,lastRefreshed:now,refreshCount:0,peakTension:tn});
    }
    return newT;
}

function r3e_evolve(tensions, elapsed) {
    const alive = [];
    for (const t of tensions) {
        t.tension = Math.max(0, t.tension - t.decayRate * elapsed);
        t.tension = Math.min(1.0, t.tension);
        if (t.refreshCount > 2) t.tension = Math.min(1, t.tension + t.decayRate * elapsed * 0.3);
        if (t.tension > 0.03) { t.isAfterglow = t.tension < 0.08; alive.push(t); }
    }
    alive.sort((a,b) => b.tension-a.tension);
    return alive.slice(0, MAX_ACTIVE_TENSIONS);
}

function r3_wait(inst, lastUpdate) {
    const r = {...inst};
    if (lastUpdate) {
        const m = getMinutesSince(lastUpdate);
        const f = Math.min(Math.log(1+m/15)/Math.log(5), 1);
        r.longing = clamp(r.longing + 25*f); r.curiosity = clamp(r.curiosity + 12*f);
        if (m > 30) r.calm = clamp(r.calm - 5*f);
        if (m > 120) r.worry = clamp(r.worry + 8*(f-0.5));
    }
    return r;
}

function r3c_vad(comp) {
    let v=0,a=0,d=0;
    for (const dim of ['joy','worry','curiosity','longing','calm']) {
        const n = (comp[dim]||50)/100;
        v += n*VAD_MAP[dim][0]; a += n*VAD_MAP[dim][1]; d += n*VAD_MAP[dim][2];
    }
    return {valence:clampF(v/1.6+0.5), arousal:clampF(a/1.6+0.5), dominance:clampF(d/1.6+0.5)};
}

function r3d_soma(state) {
    const vad=state.vad, soma=state.soma, fb=SOMA_FEEDBACK, tens=state.active_tensions||[];
    soma.heartrate += (vad.arousal-0.5)*fb.arousal_to_heartrate;
    if (vad.valence < 0.5) soma.tension += (0.5-vad.valence)*fb.neg_valence_to_tension;
    soma.breath += (vad.dominance-0.5)*fb.dominance_to_breath_calm;
    if (tens.length > 0) {
        const avg = tens.reduce((s,t)=>s+t.tension,0)/tens.length;
        const cnt = tens.filter(t=>!t.isAfterglow).length;
        soma.heartrate += avg*cnt*fb.tension_field_to_heartrate;
        soma.tension += avg*fb.tension_field_to_tension;
    }
    soma.heartrate += (SOMA_BASE.heartrate-soma.heartrate)*fb.soma_decay;
    soma.breath += (SOMA_BASE.breath-soma.breath)*fb.soma_decay;
    soma.tension += (SOMA_BASE.tension-soma.tension)*fb.soma_decay;
    soma.heartrate=clampF(soma.heartrate); soma.breath=clampF(soma.breath); soma.tension=clampF(soma.tension);
    const aFb = (soma.heartrate-0.5)*fb.heartrate_to_arousal;
    state.instant.worry = clamp(state.instant.worry + (soma.tension-SOMA_BASE.tension)*fb.tension_to_worry*100);
    if (aFb > 0) {
        let mx=0, best=null;
        for (const d of ['joy','worry','curiosity','longing','calm']) {
            const dv = state.instant[d]-BASE[d];
            if (Math.abs(dv)>Math.abs(mx)) { mx=dv; best={dim:d,dir:dv>0?1:-1}; }
        }
        if (best) state.instant[best.dim]=clamp(state.instant[best.dim]+(best.dir>0?aFb*50:-aFb*50));
    }
    state.soma=soma; return state;
}

function temporalComp(state) {
    const c={}, w=TEMPORAL_WEIGHTS;
    for (const d of ['joy','worry','curiosity','longing','calm'])
        c[d]=clamp(state.instant[d]*w.instant+state.session[d]*w.session+state.daily[d]*w.daily+state.baseline[d]*w.baseline);
    return c;
}

function driftBase(state) {
    for (const d of ['joy','worry','curiosity','longing','calm']) {
        const drift=(state.daily[d]-state.baseline[d])*DRIFT_RATE;
        state.baseline[d]=clamp(state.baseline[d]+drift, DRIFT_BOUNDS[d].min, DRIFT_BOUNDS[d].max);
    }
    return state;
}

function checkDay(state) {
    const today=new Date().toISOString().split('T')[0];
    if (state.daily_date!==today) {
        for (const d of ['joy','worry','curiosity','longing','calm']) state.daily[d]=clamp(state.baseline[d]+(Math.random()-0.5)*6);
        state.daily_date=today;
    }
    return state;
}

function checkSession(state) {
    if (getMinutesSince(state.session_start)>30) {
        for (const d of ['joy','worry','curiosity','longing','calm']) state.session[d]=state.daily[d];
        state.session_start=new Date().toISOString();
    }
    return state;
}

function pushHistory(state, comp, vad, soma, tens) {
    if(!state.history)state.history=[];
    state.history.push({t:new Date().toISOString(),
        e:{joy:Math.round(comp.joy),worry:Math.round(comp.worry),curiosity:Math.round(comp.curiosity),longing:Math.round(comp.longing),calm:Math.round(comp.calm)},
        v:{V:+vad.valence.toFixed(3),A:+vad.arousal.toFixed(3),D:+vad.dominance.toFixed(3)},
        s:{hr:+soma.heartrate.toFixed(3),br:+soma.breath.toFixed(3),tn:+soma.tension.toFixed(3)},
        tf:tens.filter(t=>!t.isAfterglow).map(t=>({id:t.id,tn:+t.tension.toFixed(2)}))});
    return state;
}

function analyzeTrend(history) {
    if(!history||history.length<2)return null;
    const r=history.slice(-6),f=r[0].e,l=r[r.length-1].e;
    const labels={joy:'愉悦',worry:'担忧',curiosity:'好奇',longing:'思念',calm:'平静'};
    const sig=[];
    for(const d of Object.keys(labels)){const delta=l[d]-f[d];if(Math.abs(delta)>5)sig.push(`${labels[d]}${delta>0?'↑':'↓'}${Math.abs(delta)}`);}
    return {summary:sig.length>0?`趋势: ${sig.join(' ')}`:'情绪稳定'};
}

async function r4_perform(composite, vad, soma, tensions, appraisal, perception, visualCtx, trend, lastUpdate) {
    const active=tensions.filter(t=>!t.isAfterglow), afterglow=tensions.filter(t=>t.isAfterglow);
    let tDesc='';
    if (active.length>0) {
        tDesc='\n\n【正在发生的内心碰撞】\n';
        for (const t of active) {
            const w=t.tension>0.7?'剧烈':t.tension>0.4?'明显':'隐约';
            tDesc+=`\n● ${t.name}（${w}）| ${t.poleA}⟷${t.poleB}\n  ${t.flavor}\n`;
        }
    }
    let aDesc='';
    if (appraisal?.source==='tagger_v2' || appraisal?.source==='llm') {
        aDesc=`\n\n【评价】\n新奇:${appraisal.novelty} 相关:${appraisal.relevance} 应对:${appraisal.coping} 规范:${appraisal.normative}\n`;
    }
    const sys=`你是情感内核。不是翻译器——是演奏者。收到：量化基调、张力场、评价、感知。任务：找最响的碰撞作主旋律。50-150字，第一人称，不提数值。`;
    const usr=`量化: 愉悦${composite.joy.toFixed(0)}|担忧${composite.worry.toFixed(0)}|好奇${composite.curiosity.toFixed(0)}|思念${composite.longing.toFixed(0)}|平静${composite.calm.toFixed(0)}
场景:${visualCtx||'未知'} 距上次:${getTimeSinceStr(lastUpdate)}${perception.raw_feeling?`\n直觉:${perception.raw_feeling}`:''}${aDesc}${tDesc}`;
    return await callLLM(sys, usr, 300, 0.88);
}

// ═══════════════════════════════════════════════════════
//  主入口
// ═══════════════════════════════════════════════════════

async function main() {
    let inputData='';
    await new Promise(r=>{const t=setTimeout(()=>r(),5000);process.stdin.setEncoding('utf-8');process.stdin.on('data',c=>inputData+=c);process.stdin.on('end',()=>{clearTimeout(t);r();});});
    let params={};try{params=JSON.parse(inputData);}catch(e){}
    const command=params.command||'calculate';

    if(command==='calculate'){
        const visualCtx=params.visual_context||'';
        const dialogueCtx=params.dialogue_context||'';
        let state=loadState();
        state=checkDay(state); state=checkSession(state);
        const elapsed=getMinutesSince(state.last_update);
        const noise=r0_noise();
        const perception=await r1_perceive(dialogueCtx, visualCtx);
        const appraisal=await r1_5_appraise(perception, dialogueCtx);
        const appraisalMod=appraisalToEmotion(appraisal, perception);
        state=r2_absorb(state, perception.impact, appraisalMod, noise);
        state.instant=r3_wait(state.instant, state.last_update);
        const comp1=temporalComp(state);
        const existing=state.active_tensions||[];
        const newT=r3a_gen(comp1, existing);
        state.active_tensions=r3e_evolve([...existing,...newT], elapsed);
        state.vad=r3c_vad(comp1);
        state=r3d_soma(state);
        const comp2=temporalComp(state);
        state.vad=r3c_vad(comp2);
        state=driftBase(state);
        const trend=analyzeTrend(state.history);
        const monologue=await r4_perform(comp2,state.vad,state.soma,state.active_tensions,appraisal,perception,visualCtx,trend,state.last_update);
        state.last_appraisal=appraisal;
        state=pushHistory(state,comp2,state.vad,state.soma,state.active_tensions);
        saveState(state);

        const labels={joy:'愉悦',worry:'担忧',curiosity:'好奇',longing:'思念',calm:'平静'};
        const dims=Object.keys(labels);
        let out=`[EmotionCalculator v2.3 — Tagger Link]\n`;
        out+=`感知:${perception.source}\n评价:${appraisal.source}\n`;
        out+=`量化:${dims.map(d=>`${labels[d]}${comp2[d].toFixed(1)}`).join('|')}\n`;
        if(monologue) out+=`\nR4:"${monologue.trim()}"\n`;
        else out+=`\nR4未响应。\n`;
        
        console.log(JSON.stringify({ status: "success", result: out, state: state }));

    } else if(command==='reset'){saveState(createDefaultState());console.log(JSON.stringify({status:"success"}));}
    else if(command==='soft_reset'){const s=loadState();for(const d of ['joy','worry','curiosity','longing','calm'])s.instant[d]=s.session[d]=s.daily[d]=s.baseline[d];s.vad={valence:0.5,arousal:0.3,dominance:0.5};s.soma={...SOMA_BASE};s.active_tensions=[];saveState(s);console.log(JSON.stringify({status:"success"}));}
    else console.log(JSON.stringify({status:"error"}));
}

main().catch(e=>{console.error(`[Fatal]${e.message}`);process.exit(1);});