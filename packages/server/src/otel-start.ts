/**
 * Side-effect entry point for tracing. server.ts imports this before anything
 * else; otel.ts holds the reasoning and the configuration.
 *
 * A separate file because an `import` is hoisted: calling startTracing() at the
 * top of server.ts would still run AFTER every import in that file had been
 * evaluated, which is exactly too late for the instrumentations.
 */
import { startTracing } from './otel.js';

startTracing();
