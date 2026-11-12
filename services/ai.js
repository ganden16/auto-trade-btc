const axios = require('axios');
const dnsResolver = require('./dns-resolver');
const strategy = require('../config/strategy');

class AIService {
  constructor() {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.agent = dnsResolver.getAgent();
  }

  async getSentiment(headline) {
    if (!headline) throw new Error("Headline is required");

    if (this.consecutiveFailures >= strategy.ai.maxConsecutiveFailures) {
      const now = Date.now();
      if (this.lastFailureTime && (now - this.lastFailureTime) < 120000) {
        console.warn("AI in Degraded Mode cooldown (waiting for next cycle)");
        throw new Error("AI Degraded Mode");
      } else {
        console.log("[AI_RETRY] Attempting auto-recovery from Degraded Mode...");
        this.consecutiveFailures = 0;
      }
    }

    try {
      const response = await axios.post(
        'https://ai.sumopod.com/v1/chat/completions',
        {
          model: process.env.AI_MODEL_NAME || "glm-5.3-flash",
          messages: [
            {
              role: "system",
              content: "You are a financial sentiment analyzer specialized in Bitcoin (BTC) and macroeconomic markets. Reply ONLY in JSON format: {\"sentiment\": \"BULLISH\" | \"BEARISH\" | \"NEUTRAL\", \"confidence\": 1-10, \"reason\": \"<string>\"}"
            },
            {
              role: "user",
              content: `Analyze the directional impact of this crypto/macro headline specifically on BITCOIN (BTC): "${headline}"`
            }
          ],
          response_format: { type: "json_object" }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.SUMOPOD_API_KEY}`,
            'Content-Type': 'application/json'
          },
          httpsAgent: this.agent,
          timeout: strategy.ai.timeoutMs || 25000
        }
      );

      const content = JSON.parse(response.data.choices[0].message.content);
      this.consecutiveFailures = 0; // Reset on success
      this.lastFailureTime = 0;
      return content;
    } catch (error) {
      this.consecutiveFailures++;
      this.lastFailureTime = Date.now();
      console.error(`AI Analysis Error: ${error.message}`);
      throw error;
    }
  }

  isMacroHeadline(headline) {
    if (!headline) return false;
    return strategy.ai.macroKeywordsRegex.test(headline);
  }
}

module.exports = new AIService();
