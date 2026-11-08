const axios = require('axios');
const dnsResolver = require('./dns-resolver');
const strategy = require('../config/strategy');

class NotifierService {
  constructor() {
    this.telegramToken = strategy.notifications?.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = strategy.notifications?.telegram?.chatId || process.env.TELEGRAM_CHAT_ID;
    this.lastTrailingNotifyTime = 0;
    this.agent = dnsResolver.getAgent();
  }

  isConfigured() {
    return Boolean(this.telegramToken && this.telegramChatId);
  }

  async broadcast(text, maxRetries = 3) {
    if (!this.isConfigured()) return;

    if (this.telegramToken && this.telegramChatId) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await axios.post(
            `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
            {
              chat_id: this.telegramChatId,
              text: text,
              parse_mode: 'HTML',
              disable_web_page_preview: true
            },
            {
              timeout: 8000,
              httpsAgent: this.agent
            }
          );
          return; // Sent successfully
        } catch (err) {
          if (attempt === maxRetries) {
            console.warn(`[NOTIFIER_TELEGRAM_WARN] Failed to send Telegram after ${maxRetries} attempts: ${err.message}`);
          } else {
            // Exponential backoff delay (1s, 2s)
            await new Promise(res => setTimeout(res, attempt * 1000));
          }
        }
      }
    }
  }

  formatWIB(date = new Date()) {
    try {
      const d = new Date(date);
      const dateStr = d.toLocaleDateString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      const timeStr = d.toLocaleTimeString('id-ID', {
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).replace(/\./g, ':');
      return `${dateStr} ${timeStr} WIB`;
    } catch (e) {
      return new Date().toISOString();
    }
  }

  async sendTradeOpen(data) {
    const { symbol, side, qty, price, slPrice, tpPrice, leverage } = data;
    const sideEmoji = side === 'BUY' || side === 'LONG' ? '🟢 <b>LONG ENTRY</b>' : '🔴 <b>SHORT ENTRY</b>';
    const entryNum = Number(price);
    const slPct = entryNum && slPrice ? Math.abs((Number(slPrice) - entryNum) / entryNum * 100).toFixed(2) : '0.50';
    const tpPct = entryNum && tpPrice ? Math.abs((Number(tpPrice) - entryNum) / entryNum * 100).toFixed(2) : '0.25';
    const text = [
      `🚀 <b>[BOT TRADE EXECUTED]</b>`,
      `${sideEmoji} on <b>${symbol}</b> (${leverage || 25}x)`,
      `───────────────────`,
      `• <b>Qty:</b> ${qty} BTC`,
      `• <b>Entry Price:</b> $${Number(price).toLocaleString()}`,
      `• <b>Stop Loss:</b> $${Number(slPrice).toLocaleString()} (-${slPct}%)`,
      `• <b>Take Profit:</b> $${Number(tpPrice).toLocaleString()} (+${tpPct}%)`,
      `• <b>Waktu:</b> ${this.formatWIB()}`
    ].join('\n');

    return this.broadcast(text);
  }

  async sendTradeClose(data) {
    const { symbol, side, qty, exitPrice, pnl, commission, reason } = data;
    const pnlNum = parseFloat(pnl || 0);
    const isWin = pnlNum >= 0;
    const resultEmoji = isWin ? '💰 <b>WIN TRADE</b>' : '🛑 <b>LOSS TRADE</b>';
    const sign = isWin ? '+' : '';
    const feeLine = commission && parseFloat(commission) > 0 ? `\n• <b>Commission Fee:</b> -$${parseFloat(commission).toFixed(2)} USDT` : '';

    const text = [
      `🏁 <b>[POSITION CLOSED]</b>`,
      `${resultEmoji} on <b>${symbol}</b>`,
      `───────────────────`,
      `• <b>Side:</b> ${side}`,
      `• <b>Quantity:</b> ${qty} BTC`,
      `• <b>Exit Price:</b> $${Number(exitPrice).toLocaleString()}`,
      `• <b>Net Realized PnL:</b> <b>${sign}$${pnlNum.toFixed(2)}</b>${feeLine}`,
      `• <b>Trigger Reason:</b> <code>${reason}</code>`,
      `• <b>Waktu:</b> ${this.formatWIB()}`
    ].join('\n');

    return this.broadcast(text);
  }

  async sendTrailingStop(data, force = false) {
    const now = Date.now();
    if (!force && (now - this.lastTrailingNotifyTime < 30000)) {
      return; // Throttled: max 1 notification per 30 seconds to prevent Telegram spam
    }
    this.lastTrailingNotifyTime = now;

    const { symbol, side, newSlPrice, currentPrice } = data;
    const text = [
      `🎯 <b>[TRAILING STOP TIGHTENED]</b>`,
      `<b>${symbol}</b> (${side})`,
      `• <b>New Stop Loss:</b> $${Number(newSlPrice).toLocaleString()}`,
      `• <b>Current Price:</b> $${Number(currentPrice).toLocaleString()}`,
      `• <b>Waktu:</b> ${this.formatWIB()}`,
      `• <b>Protected Profit Active!</b>`
    ].join('\n');

    return this.broadcast(text);
  }

  async sendAlert(title, message, level = 'WARN') {
    const emoji = level === 'ERROR' ? '🚨' : '⚠️';
    const text = [
      `${emoji} <b>[SYSTEM ALERT: ${level}]</b>`,
      `<b>${title}</b>`,
      `───────────────────`,
      `${message}`,
      `• <b>Waktu:</b> ${this.formatWIB()}`
    ].join('\n');

    return this.broadcast(text);
  }
}

const notifierInstance = new NotifierService();
module.exports = notifierInstance;
