const https = require('https');
const dns = require('dns');

class DnsResolver {
  constructor() {
    this.cache = new Map(); // hostname -> { ips, expiresAt }
    this.lastKnownIps = new Map(); // hostname -> ips (stale-fallback cache)
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
    if (process.env.NODE_ENV !== 'test') {
      this.initPrewarm();
    }
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
        return cached.ips;
      }
    }

    const providers = [
      'https://1.1.1.1/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
      'https://dns.google/resolve?name=' + encodeURIComponent(hostname) + '&type=A'
    ];

    for (const url of providers) {
      try {
        const ips = await new Promise((resolve) => {
          const req = https.get(url, {
            headers: { 'accept': 'application/dns-json' },
            timeout: 3000,
            agent: false
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const answers = (json.Answer || [])
                  .filter(a => a.type === 1)
                  .map(a => a.data);
                if (answers.length > 0) resolve(answers);
                else resolve(null);
              } catch (e) { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });

        if (ips && ips.length > 0) {
          this.cache.set(hostname, { ips, expiresAt: Date.now() + this.cacheTtlMs });
          this.lastKnownIps.set(hostname, ips);
          return ips;
        }
      } catch (e) {
        // Fallback to next provider
      }
    }

    // Stale-on-error fallback
    const stale = this.lastKnownIps.get(hostname);
    if (stale && stale.length > 0) {
      return stale;
    }

    return null;
  }

  lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // Auto-bypass DNS poisoning and IPv6 route failures for Binance, CloudFront, SumoPod, and Telegram
    const isTargetDomain = /binance|cloudfront|sumopod|telegram/i.test(hostname);

    if (isTargetDomain) {
      const cached = this.cache.get(hostname);
      if (cached && Date.now() < cached.expiresAt && cached.ips?.length > 0) {
        if (options && options.all) {
          return callback(null, cached.ips.map(ip => ({ address: ip, family: 4 })));
        }
        return callback(null, cached.ips[0], 4);
      }

      this.resolveDoH(hostname).then(ips => {
        if (ips && ips.length > 0) {
          if (options && options.all) {
            return callback(null, ips.map(ip => ({ address: ip, family: 4 })));
          }
          return callback(null, ips[0], 4);
        }
        const stale = this.lastKnownIps.get(hostname);
        if (stale && stale.length > 0) {
          if (options && options.all) {
            return callback(null, stale.map(ip => ({ address: ip, family: 4 })));
          }
          return callback(null, stale[0], 4);
        }
        dns.lookup(hostname, options, callback);
      }).catch(() => {
        const stale = this.lastKnownIps.get(hostname);
        if (stale && stale.length > 0) {
          if (options && options.all) {
            return callback(null, stale.map(ip => ({ address: ip, family: 4 })));
          }
          return callback(null, stale[0], 4);
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
