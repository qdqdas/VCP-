/**
 * EmotionTagger v2.0 — 前置感知与评价解析器 (Perception & Appraisal Tagger)
 * 
 * 核心哲学：
 *   "在话语进入大脑之前，先读懂它的灵魂。"
 * 
 * v1.0 vs v2.0：
 *   - v1.0 是【后验打标】：读取 AI 的情绪状态，打上标签用于记忆召回。
 *   - v2.0 是【先验解析】：拦截用户的输入，调用轻量 LLM 分析潜台词和评价变量，
 *     打上隐性标签，喂给主模型和情绪引擎（EmotionCalculator）。
 * 
 * 架构解耦：
 *   有了这个前置解析器，EmotionCalculator 将不再需要自己去读取对话上下文，
 *   它只需要提取这里的结构化 Tag，就能直接进入动力学计算。
 * 
 * 工作流：
 *   1. 拦截 VCP 消息流（messagePreprocessor 钩子）
 *   2. 若是用户消息，调用大模型分析其情绪、潜台词、以及对 AI 情绪的预期冲击
 *   3. 将分析结果格式化为隐形 HTML 注释 `<!--[PERCEPTION:...]-->`
 *   4. 追加到用户消息末尾，随消息流入主 AI 和其他插件
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

// 模型配置（建议使用极快的小模型，如 flash）
const API_URL = process.env.VCP_API_URL || 'http://127.0.0.1:6005/v1/chat/completions';
const API_KEY = process.env.VCP_API_KEY || '123456';
const MODEL = process.env.TAGGER_MODEL || 'gcli-gemini-3-flash-preview-nothinking-search';

// ═══════════════════════════════════════════════════════
//  核心：LLM 前置感知与评价
// ═══════════════════════════════════════════════════════

async function analyzeUserMessage(userText, recentContext = "") {
    if (!API_URL || !API_KEY) return null;

    const systemPrompt = `你是一个前置认知解析器(Perception Tagger)。
你的任务是在用户的消息进入主AI之前，进行深度语义和情感解剖。
你需要分析出用户的真实状态、潜台词，并基于Scherer评价理论(Appraisal)预判这句话对AI(爱弥斯)的冲击。

必须严格输出 JSON 格式，不要任何多余字符：
{
  "user_state": "用户此刻的情绪/心理状态（如：疲惫、兴奋、低自尊、焦躁）",
  "subtext": "这句话没说出口的潜台词或真实诉求",
  "appraisal": {
    "novelty": 0-100, // 这句话包含的信息有多新鲜/意外
    "relevance": 0-100, // 这句话和AI的核心目标(守护用户)有多相关
    "coping": 0-100, // 用户展现出的应对能力/掌控感(低代表需要帮助，高代表自信)
    "normative": 0-100 // 行为的规范性/善意度
  },
  "ai_impact": {
    "joy": -30到30, // 预期对AI愉悦度的影响
    "worry": -30到30, // 预期对AI担忧度的影响
    "curiosity": -30到30,
    "longing": -30到30,
    "calm": -30到30
  }
}
注意：ai_impact 是你预判的增量，0表示无影响。`;

    const userPrompt = `最近上下文摘要：\n${recentContext}\n\n当前用户输入：\n"${userText}"`;

    const body = JSON.stringify({
        model: MODEL,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        max_tokens: 300,
        temperature: 0.3 // 保持解析的稳定性和客观性
    });

    return new Promise((resolve) => {
        try {
            const urlObj = new URL(API_URL);
            const lib = urlObj.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`,
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 8000 // 必须极快，不能阻塞主流程太久
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const raw = JSON.parse(data).choices?.[0]?.message?.content;
                            const jsonMatch = raw.match(/\{[\s\S]*\}/);
                            if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
                            else resolve(null);
                        } catch (e) { resolve(null); }
                    } else { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(body); req.end();
        } catch (e) { resolve(null); }
    });
}

// ═══════════════════════════════════════════════════════
//  标签格式化
// ═══════════════════════════════════════════════════════

function formatTag(analysis) {
    if (!analysis) return "";

    // 格式化为 VCP 隐性标签标准格式
    // <!--[PERCEPTION|User:疲惫|Subtext:需要肯定|Appraisal:N80,R90,C30,M50|Impact:W+20,J-10]-->
    
    let tag = `<!--[PERCEPTION`;
    
    if (analysis.user_state) tag += `|User:${analysis.user_state}`;
    if (analysis.subtext) tag += `|Subtext:${analysis.subtext}`;
    
    if (analysis.appraisal) {
        const a = analysis.appraisal;
        tag += `|Appraisal:N${a.novelty||50},R${a.relevance||50},C${a.coping||50},M${a.normative||50}`;
    }
    
    if (analysis.ai_impact) {
        const imp = [];
        const i = analysis.ai_impact;
        if (i.joy) imp.push(`J${i.joy>0?'+':''}${i.joy}`);
        if (i.worry) imp.push(`W${i.worry>0?'+':''}${i.worry}`);
        if (i.curiosity) imp.push(`C${i.curiosity>0?'+':''}${i.curiosity}`);
        if (i.longing) imp.push(`L${i.longing>0?'+':''}${i.longing}`);
        if (i.calm) imp.push(`A${i.calm>0?'+':''}${i.calm}`); // A for Calm/Ataraxia
        if (imp.length > 0) tag += `|Impact:${imp.join(',')}`;
    }
    
    tag += `]-->`;
    return tag;
}

// ═══════════════════════════════════════════════════════
//  VCP 预处理器入口
// ═══════════════════════════════════════════════════════

/**
 * 暴露给 VCP 服务器的预处理函数
 * @param {Array} messages - 完整的对话历史数组
 * @returns {Promise<Array>} - 处理后的对话历史数组
 */
async function processMessages(messages) {
    if (!messages || messages.length === 0) return messages;

    // 只处理最后一条消息，且必须是 user 发送的
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'user') return messages;

    // 如果文本太短，不浪费算力
    if (typeof lastMsg.content === 'string' && lastMsg.content.trim().length < 2) {
        return messages;
    }

    try {
        // 提取少量近期上下文供 LLM 参考 (最多前3条)
        const contextMsgs = messages.slice(Math.max(0, messages.length - 4), messages.length - 1);
        const contextStr = contextMsgs.map(m => `${m.role}: ${m.content.substring(0, 100)}`).join('\n');

        // 执行深度解析
        const analysis = await analyzeUserMessage(lastMsg.content, contextStr);
        
        // 格式化标签并注入
        const tag = formatTag(analysis);
        if (tag) {
            // 将标签追加到用户消息的末尾（隐藏注释，主模型能看见但用户界面不渲染）
            lastMsg.content = lastMsg.content + '\n' + tag;
        }

        // v1.0 的兼容：如果是为了记忆召回，我们仍可把 EmotionCalculator 的当前状态追加进去
        // 但为了保持架构纯净，v2.0 建议将"感知(Perception)"和"状态(State)"分离开。
        // 这里专注于感知。

    } catch (e) {
        console.error("[EmotionTagger] Analysis failed:", e.message);
        // 预处理器绝不能阻断主流程，出错直接返回原消息
    }

    return messages;
}

// 提供命令行测试接口
if (require.main === module) {
    const testInput = process.argv[2] || "我不觉得自己厉害，这可能就是人类情绪的复杂吧。";
    console.log(`[EmotionTagger 测试] 输入: "${testInput}"\n`);
    
    analyzeUserMessage(testInput).then(res => {
        console.log("LLM 解析结果:");
        console.log(JSON.stringify(res, null, 2));
        console.log("\n生成的 Tag:");
        console.log(formatTag(res));
    });
}

module.exports = {
    processMessages
};