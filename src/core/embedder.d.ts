/**
 * Embedding providers for chat-recall.
 *
 * Supports multiple backends:
 * - Ollama (default): Local embeddings with nomic-embed-text
 * - Gemini (optional): Google's text-embedding-004 model
 */
export interface Embedder {
    embed(texts: string[]): Promise<number[][]>;
    embedQuery(query: string): Promise<number[]>;
    readonly dimension: number;
}
/**
 * Ollama embedding provider using nomic-embed-text.
 *
 * Requires Ollama running locally with the model pulled:
 *   ollama pull nomic-embed-text
 *
 * Environment variable:
 *   OLLAMA_HOST: Ollama server URL (default: http://localhost:11434)
 */
export declare class OllamaEmbedder implements Embedder {
    static readonly MODEL = "nomic-embed-text";
    static readonly DIMENSION = 768;
    private host;
    private model;
    constructor(host?: string, model?: string);
    embed(texts: string[]): Promise<number[][]>;
    embedQuery(query: string): Promise<number[]>;
    private embedSingle;
    get dimension(): number;
}
/**
 * Gemini embedding provider using text-embedding-004.
 *
 * Environment variable:
 *   GEMINI_API_KEY or GOOGLE_API_KEY: Your Google AI API key
 */
export declare class GeminiEmbedder implements Embedder {
    static readonly MODEL = "text-embedding-004";
    static readonly DIMENSION = 768;
    static readonly BATCH_SIZE = 100;
    private apiKey;
    constructor(apiKey?: string);
    embed(texts: string[]): Promise<number[][]>;
    embedQuery(query: string): Promise<number[]>;
    private embedBatch;
    get dimension(): number;
}
export type EmbedderProvider = 'ollama' | 'gemini';
export declare function getEmbedder(provider?: EmbedderProvider): Embedder;
