import { OllamaEmbedder } from '../src/core/embedder.js';

async function test() {
  const embedder = new OllamaEmbedder();
  const result = await embedder.embed(['test1', 'test2', 'test3', 'test4', 'test5', 'test6', 'test7']);
  console.log('Number of embeddings:', result.length);
  console.log('Embedding dimensions:', result[0].length);
  console.log('All same dimension?', result.every(e => e.length === 768));
  console.log('Total values if flattened:', result.flat().length);
}

test();
