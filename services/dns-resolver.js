const https = require('https');
const dns = require('dns');

// Verified global Anycast CloudFront IPs that bypass ISP DNS hijacking and regional edge rate limits
const GLOBAL_CLOUDFRONT_IPS = [
  '54.192.164.96',
  '54.192.164.104',
  '54.192.164.72',
  '54.192.164.32',
  '54.192.164.11',
  '54.192.164.117',
  '54.192.164.47',
  '54.192.164.36'
];

class DnsResolver {
  constructor() {
    this.cache = new Map(); // hostname -> { ips, expiresAt }
    this.lastKnownIps = new Map(); // hostname -> ips (stale-fallback cache)
    this.badIps = new Map(); // ip -> bannedUntilMs
    this.rrIndex = new Map(); // hostname -> round-robin pointer
    this.cacheTtlMs = 10 * 60 * 1000; // 10 minutes TTL
    this.agent = new https.Agent({
      lookup: this.lookup.bind(this),
      keepAlive: true,
      keepAliveMsecs: 10000,
      timeout: 10000
    });
    this.prewarmTargets = [
      'stream.binancefuture.com',
      'testnet.binancefuture.com',
      'fapi.binance.com',
      'fstream.binance.com',
      'ai.sumopod.com',
      'api.telegram.org'
    ];

    // Seed known degraded regional edge IPs on Binance Testnet
    this.badSubnets = ['13.33.88.'];

    if (process.env.NODE_ENV !== 'test') {
      this.initPrewarm();
    }
  }

  isPoisonedIp(ip) {
    if (!ip) return true;
    // Known Indonesian ISP Trust Positif / Internet Baik sinkholes & loopback
    if (ip === '127.0.0.1' || ip === '0.0.0.0') return true;
    if (ip.startsWith('202.169.44.')) return true; // Biznet sinkhole
    if (ip.startsWith('118.98.') || ip.startsWith('180.250.')) return true; // Telkom / IndiHome sinkhole
    if (ip.startsWith('36.86.') || ip.startsWith('103.247.')) return true; // FirstMedia / Telkom sinkholes
    return false;
  }

  markBadIp(ip, durationMs = 10 * 60 * 1000) {
    if (!ip) return;
    this.badIps.set(ip, Date.now() + durationMs);
  }

  isBadIp(ip) {
    if (this.isPoisonedIp(ip)) return true;
    if (this.badSubnets.some(prefix => ip.startsWith(prefix))) return true;
    const expiry = this.badIps.get(ip);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.badIps.delete(ip);
      return false;
    }
    return true;
  }

  getStaticFallback(hostname) {
    if (/binance|cloudfront/i.test(hostname)) {
      return [...GLOBAL_CLOUDFRONT_IPS];
    }
    return null;
  }

  hasHealthyIps(hostname) {
    if (/binance|cloudfront/i.test(hostname)) return true;
    const cached = this.cache.get(hostname);
    if (cached && cached.ips && cached.ips.length > 0) {
      const healthy = cached.ips.filter(ip => !this.isBadIp(ip));
      if (healthy.length > 0) return true;
    }
    const stale = this.lastKnownIps.get(hostname);
    if (stale && stale.length > 0) {
      const healthy = stale.filter(ip => !this.isBadIp(ip));
      if (healthy.length > 0) return true;
    }
    return false;
  }

  initPrewarm() {
    for (const host of this.prewarmTargets) {
      this.resolveDoH(host).catch(() => {});
    }
    const timer = setInterval(() => {
      for (const host of this.prewarmTargets) {
        this.resolveDoH(host, true).catch(() => {});
      }
    }, 3 * 60 * 1000);
    if (timer && timer.unref) timer.unref();
  }

  async resolveDoH(hostname, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = this.cache.get(hostname);
      if (cached && Date.now() < cached.expiresAt && cached.ips?.length > 0) {
        const validCached = cached.ips.filter(ip => !this.isBadIp(ip));
        if (validCached.length > 0) return validCached;
      }
    }

    // Direct IP DoH endpoints that avoid relying on local host DNS
    const providers = [
      { host: '162.159.36.1', path: '/dns-query?name=' + encodeURIComponent(hostname) + '&type=A', servername: 'cloudflare-dns.com' },
      { host: '1.0.0.1', path: '/dns-query?name=' + encodeURIComponent(hostname) + '&type=A', servername: 'cloudflare-dns.com' },
      { host: '8.8.8.8', path: '/resolve?name=' + encodeURIComponent(hostname) + '&type=A', servername: 'dns.google' },
      { host: '8.8.4.4', path: '/resolve?name=' + encodeURIComponent(hostname) + '&type=A', servername: 'dns.google' }
    ];

    for (const p of providers) {
      try {
        const ips = await new Promise((resolve) => {
          const req = https.request({
            host: p.host,
            path: p.path,
            method: 'GET',
            headers: {
              'host': p.servername,
              'accept': 'application/dns-json'
            },
            servername: p.servername,
            timeout: 2500,
            agent: false
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const answers = (json.Answer || [])
                  .filter(a => a.type === 1)
                  .map(a => a.data)
                  .filter(ip => !this.isBadIp(ip));
                if (answers.length > 0) resolve(answers);
                else resolve(null);
              } catch (e) { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        });

        if (ips && ips.length > 0) {
          this.cache.set(hostname, { ips, expiresAt: Date.now() + this.cacheTtlMs });
          this.lastKnownIps.set(hostname, ips);
          return ips;
        }
      } catch (e) {
        // Try next provider
      }
    }

    // Stale-on-error fallback
    const stale = this.lastKnownIps.get(hostname);
    if (stale && stale.length > 0) {
      const validStale = stale.filter(ip => !this.isBadIp(ip));
      if (validStale.length > 0) return validStale;
    }

    // Static Anycast fallback for Binance endpoints
    const fallback = this.getStaticFallback(hostname);
    if (fallback) {
      return fallback;
    }

    return null;
  }

  lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    const selectIps = (ips) => {
      if (!ips || ips.length === 0) return null;
      const validIps = ips.filter(ip => !this.isBadIp(ip));
      const pool = validIps.length > 0 ? validIps : this.getStaticFallback(hostname);
      if (!pool || pool.length === 0) return null;
      const idx = (this.rrIndex.get(hostname) || 0) % pool.length;
      this.rrIndex.set(hostname, idx + 1);
      return { selected: pool[idx], pool };
    };

    const isTargetDomain = /binance|cloudfront|sumopod|telegram/i.test(hostname);

    if (isTargetDomain) {
      const cached = this.cache.get(hostname);
      if (cached && Date.now() < cached.expiresAt && cached.ips?.length > 0) {
        const res = selectIps(cached.ips);
        if (res) {
          if (options && options.all) {
            return callback(null, res.pool.map(ip => ({ address: ip, family: 4 })));
          }
          return callback(null, res.selected, 4);
        }
      }

      this.resolveDoH(hostname).then(ips => {
        const poolToUse = (ips && ips.length > 0) ? ips : this.getStaticFallback(hostname);
        if (poolToUse) {
          const res = selectIps(poolToUse);
          if (res) {
            if (options && options.all) {
              return callback(null, res.pool.map(ip => ({ address: ip, family: 4 })));
            }
            return callback(null, res.selected, 4);
          }
        }
        
        dns.lookup(hostname, options, (err, address, family) => {
          if (err || this.isBadIp(address)) {
            const fb = this.getStaticFallback(hostname);
            if (fb) {
              const res = selectIps(fb);
              if (res) {
                if (options && options.all) {
                  return callback(null, res.pool.map(ip => ({ address: ip, family: 4 })));
                }
                return callback(null, res.selected, 4);
              }
            }
          }
          callback(err, address, family);
        });
      }).catch(() => {
        const fb = this.getStaticFallback(hostname);
        if (fb) {
          const res = selectIps(fb);
          if (res) {
            if (options && options.all) {
              return callback(null, res.pool.map(ip => ({ address: ip, family: 4 })));
            }
            return callback(null, res.selected, 4);
          }
        }
        dns.lookup(hostname, options, callback);
      });
    } else {
      dns.lookup(hostname, options, callback);
    }
  }

  getAgent() {
    return this.agent;
  }
}

module.exports = new DnsResolver();
