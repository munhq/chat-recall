/**
 * Embedding providers for chat-recall.
 *
 * Supports multiple backends:
 * - Ollama (default): Local embeddings with nomic-embed-text
 * - Gemini (optional): Google's text-embedding-004 model
 */
/**
 * Ollama embedding provider using nomic-embed-text.
 *
 * Requires Ollama running locally with the model pulled:
 *   ollama pull nomic-embed-text
 *
 * Environment variable:
 *   OLLAMA_HOST: Ollama server URL (default: http://localhost:11434)
 */
export class OllamaEmbedder {
    static MODEL = 'nomic-embed-text';
    static DIMENSION = 768;
    host;
    model;
    constructor(host, model) {
        this.host = host || process.env.OLLAMA_HOST || 'http://localhost:11434';
        this.model = model || OllamaEmbedder.MODEL;
    }
    async embed(texts) {
        const embeddings = [];
        for (const text of texts) {
            const embedding = await this.embedSingle(text);
            embeddings.push(embedding);
        }
        return embeddings;
    }
    async embedQuery(query) {
        return this.embedSingle(query);
    }
    async embedSingle(text) {
        const response = await fetch(`${this.host}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, prompt: text }),
        });
        if (!response.ok) {
            throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.embedding;
    }
    get dimension() {
        return OllamaEmbedder.DIMENSION;
    }
}
/**
 * Gemini embedding provider using text-embedding-004.
 *
 * Environment variable:
 *   GEMINI_API_KEY or GOOGLE_API_KEY: Your Google AI API key
 */
export class GeminiEmbedder {
    static MODEL = 'text-embedding-004';
    static DIMENSION = 768;
    static BATCH_SIZE = 100;
    apiKey;
    constructor(apiKey) {
        this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
        if (!this.apiKey) {
            throw new Error('Gemini API key not found. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable.');
        }
    }
    async embed(texts) {
        const allEmbeddings = [];
        for (let i = 0; i < texts.length; i += GeminiEmbedder.BATCH_SIZE) {
            const batch = texts.slice(i, i + GeminiEmbedder.BATCH_SIZE);
            const batchEmbeddings = await this.embedBatch(batch);
            allEmbeddings.push(...batchEmbeddings);
        }
        return allEmbeddings;
    }
    async embedQuery(query) {
        const url = `https://generativelanguage.googleapis.com/v1/models/${GeminiEmbedder.MODEL}:embedContent?key=${this.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: `models/${GeminiEmbedder.MODEL}`,
                content: { parts: [{ text: query }] },
                taskType: 'RETRIEVAL_QUERY',
            }),
        });
        if (!response.ok) {
            throw new Error(`Gemini request failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.embedding.values;
    }
    async embedBatch(texts) {
        const url = `https://generativelanguage.googleapis.com/v1/models/${GeminiEmbedder.MODEL}:batchEmbedContents?key=${this.apiKey}`;
        const requests = texts.map(text => ({
            model: `models/${GeminiEmbedder.MODEL}`,
            content: { parts: [{ text }] },
            taskType: 'RETRIEVAL_DOCUMENT',
        }));
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests }),
        });
        if (!response.ok) {
            throw new Error(`Gemini batch request failed: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.embeddings.map(e => e.values);
    }
    get dimension() {
        return GeminiEmbedder.DIMENSION;
    }
}
export function getEmbedder(provider = 'ollama') {
    switch (provider) {
        case 'ollama':
            return new OllamaEmbedder();
        case 'gemini':
            return new GeminiEmbedder();
        default:
            throw new Error(`Unknown provider: ${provider}. Available: ollama, gemini`);
    }
}
