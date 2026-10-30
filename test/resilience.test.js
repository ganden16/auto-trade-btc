process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const logger = require('../services/logger');
const dnsResolver = require('../services/dns-resolver');

test('Resilience and Error Formatting Suite', async (t) => {
    await t.test('Logger properly formats Error instances without producing empty object {}', () => {
        let loggedEntry = null;
        const testHandler = (entry) => {
            loggedEntry = entry;
        };
        logger.once('log', testHandler);

        const testErr = new Error('Max retries reached for API call');
        console.error('Reconciliation failed', testErr);

        assert.ok(loggedEntry !== null, 'Log entry should be recorded');
        assert.ok(!loggedEntry.message.includes('{}'), 'Log message must NOT contain empty object {}');
        assert.ok(loggedEntry.message.includes('Max retries reached for API call'), 'Log message must contain the actual error message');
        assert.strictEqual(loggedEntry.level, 'ERROR');
    });

    await t.test('DnsResolver maintains stale-on-error cache for critical hostnames', async () => {
        const testHost = 'stream.binancefuture.com';
        dnsResolver.cache.set(testHost, { ips: ['1.2.3.4'], expiresAt: Date.now() + 60000 });
        dnsResolver.lastKnownIps.set(testHost, ['1.2.3.4']);

        const resolved = await dnsResolver.resolveDoH(testHost);
        assert.deepStrictEqual(resolved, ['1.2.3.4'], 'Should return cached IP');

        // Test stale fallback when expired
        dnsResolver.cache.set(testHost, { ips: ['1.2.3.4'], expiresAt: Date.now() - 1000 });
        const staleIps = dnsResolver.lastKnownIps.get(testHost);
        assert.deepStrictEqual(staleIps, ['1.2.3.4'], 'Stale cache fallback must persist');
    });
});
