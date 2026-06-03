/**
 * Search routes.
 */

import express from 'express';
import { SearchService } from '../services/search.js';

const router = express.Router();
const searchService = new SearchService();

// POST /api/search
router.post('/', async (req, res) => {
  try {
    const { query, topK: rawTopK = 10, projectFilter, includeMemory = false, sourceTypes } = req.body;
    const topK = Math.min(Math.max(parseInt(rawTopK) || 10, 1), 100);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Standard session search
    const results = await searchService.search(query, topK, projectFilter);

    // Optionally include unified memory results
    let memoryResults: any[] | undefined = undefined;
    let memoryCount = 0;
    if (includeMemory) {
      try {
        memoryResults = await searchService.searchUnified(query, topK, sourceTypes, projectFilter);
        memoryCount = memoryResults.length;
      } catch {
        // Memory search is optional - don't fail the whole request
      }
    }

    res.json({
      query,
      results,
      count: results.length,
      memoryResults,
      memoryCount,
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
});

export default router;
