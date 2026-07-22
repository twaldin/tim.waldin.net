const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const SessionManager = require('./session');
const logger = require('./logger');
const adminRouter = require('./admin');
const pageviews = require('./pageviews');

const app = express();
const server = http.createServer(app);

// Production CORS origins
const PROD_ORIGINS = [
  'https://twald.in',
  'https://terminal.twald.in',
  'https://tim.waldin.net'
];

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3100'];

const allowedOrigins = process.env.NODE_ENV === 'production' ? PROD_ORIGINS : DEV_ORIGINS;

// Configure CORS for Express
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Configure Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Initialize session manager
const sessionManager = new SessionManager();

// Per-socket command buffer for audit logging (raw chars → full commands).
const cmdBufs = new Map();

// Socket.IO connection handling. All admission policy (rate limit, IP-singleton,
// persistent restore, capacity, zombies) lives behind the SessionManager →
// Admission seam; server.js is now just socket wiring + audit logging.
io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-real-ip'] || socket.handshake.address;
  console.log(`Client connected: ${socket.id} from ${clientIP}`);

  const initCommand = typeof socket.handshake.auth?.initCommand === 'string'
    ? socket.handshake.auth.initCommand : undefined;

  logger.append({
    type: 'session_start',
    id: socket.id,
    ip: clientIP,
    ua: socket.handshake.headers['user-agent'] || '',
    referrer: socket.handshake.headers['referer'] || socket.handshake.headers['referrer'] || '',
    initCommand: initCommand || '',
  });
  cmdBufs.set(socket.id, '');

  // Lease or restore a session (async; errors surface to the socket internally).
  sessionManager.handleConnect(socket);

  socket.on('input', (data) => {
    // Buffer printable chars; log completed commands on Enter.
    if (typeof data === 'string') {
      let buf = cmdBufs.get(socket.id) || '';
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = buf.trim();
          if (cmd) logger.append({ type: 'command', id: socket.id, cmd });
          buf = '';
        } else if (ch === '\x7f' || ch === '\x08') {
          buf = buf.slice(0, -1);
        } else if (ch >= ' ' && ch <= '~') {
          buf += ch;
        }
      }
      cmdBufs.set(socket.id, buf);
    }
    sessionManager.handleInput(socket.id, data);
  });

  socket.on('resize', ({ cols, rows }) => {
    sessionManager.handleResize(socket.id, cols, rows);
  });

  socket.on('visibility', (payload) => {
    if (typeof payload?.hidden !== 'boolean') return;
    sessionManager.handleVisibility(socket.id, payload.hidden);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    logger.append({ type: 'session_end', id: socket.id, reason });
    cmdBufs.delete(socket.id);
    sessionManager.handleDisconnect(socket.id);
  });

  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
    sessionManager.handleError(socket.id);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeSessions: sessionManager.getActiveSessionCount()
  });
});

// Get session statistics
app.get('/stats', (req, res) => {
  res.json({
    activeSessions: sessionManager.getActiveSessionCount(),
    totalContainers: sessionManager.getTotalContainerCount(),
    uptime: process.uptime()
  });
});

// First-party pageview beacon (nginx proxies /pv here). navigator.sendBeacon
// posts text/plain, so parse the body as text; JSON.parse happens in the handler.
app.post('/pv', express.text({ type: '*/*', limit: '1kb' }), pageviews.handlePageview);

// Admin panel
app.use('/admin', adminRouter);

// Keep the pre-warm pool topped up — self-heals if idle pool streams drain it.
sessionManager.startPoolMaintenance();


// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal backend server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Track shutdown state to prevent multiple shutdown attempts
let isShuttingDown = false;

// Graceful shutdown function
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  try {
    // Persist the current day's pageview counts so a restart doesn't drop them
    // (rollup events for the same date are additive).
    pageviews.flushRollup();

    await sessionManager.destroyAllSessions();

    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

    setTimeout(() => {
      console.log('Force exiting...');
      process.exit(1);
    }, 5000);

  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
