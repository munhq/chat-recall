/**
 * Status routes with Server-Sent Events support.
 */

import express from 'express';
import { SearchService } from '../services/search.js';

const router = express.Router();
const searchService = new SearchService();

// GET /api/status
router.get('/', async (req, res) => {
  try {
    const stats = await searchService.getStatus();
    res.json(stats);
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get status',
    });
  }
});

// GET /api/status/stream (Server-Sent Events)
router.get('/stream', async (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial status
  try {
    const stats = await searchService.getStatus();
    res.write(`data: ${JSON.stringify(stats)}\n\n`);
  } catch (error) {
    console.error('SSE initial status error:', error);
  }

  // Send updates every 2 seconds
  const interval = setInterval(async () => {
    try {
      const stats = await searchService.getStatus();
      res.write(`data: ${JSON.stringify(stats)}\n\n`);
    } catch (error) {
      console.error('SSE update error:', error);
    }
  }, 2000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

export default router;
