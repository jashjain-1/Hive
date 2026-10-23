import { pipeline, env } from '@xenova/transformers';
import { HIVE_CONSTANTS } from '@hivemind/types';

// Run offline - no network calls
env.allowLocalModels = true;

export class LocalEmbeddingEngine {
  private extractor: any = null;
  private modelName = 'Xenova/bge-small-en-v1.5';
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.extractor = await pipeline('feature-extraction', this.modelName, {
      quantized: true, // 100% offline WASM ONNX execution
      progress_callback: () => {} // Suppress progress spam
    });
    this.initialized = true;
  }

  async embed(text: string): Promise<Float32Array> {
    await this.init();
    const output = await this.extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return Math.max(0, dot / denom);
  }

  /** Batch embed multiple texts in parallel */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.init();
    const results = await Promise.all(texts.map(t => this.extractor(t, { pooling: 'mean', normalize: true })));
    return results.map(r => new Float32Array(r.data));
  }
}
