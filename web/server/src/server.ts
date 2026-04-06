/**
 * Express server for chat-recall UI backend.
 */

import express from 'express';
import cors from 'cors';
import searchRouter from './routes/search.js';
import conversationsRouter from './routes/conversations.js';
import statusRouter from './routes/status.js';
import memoryRouter from './routes/memory.js';
import analyticsRouter from './routes/analytics.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || undefined, // undefined = allow all (for local dev); set in prod
}));
app.use(express.json({ limit: '100kb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/search', searchRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/status', statusRouter);
app.use('/api/memory', memoryRouter);
app.use('/api/analytics', analyticsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Start server - bind to localhost by default, 0.0.0.0 for Docker/network access
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\nChat-Recall Backend running on http://${HOST}:${PORT}`);
  console.log(`  Health: http://${HOST}:${PORT}/health`);
  console.log(`  Bind: ${HOST} (set HOST=0.0.0.0 for network access)\n`);
});
