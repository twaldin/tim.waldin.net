const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const SessionManager = require('./session');
const logger = require('./logger');
const adminRouter = require('./admin');

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

// Per-socket command buffer for audit logging (raw chars → full commands)
const cmdBufs = new Map();

// Per-IP rate limiting for connections (connect attempts per window).
const connectionTracker = new Map();
const MAX_CONNECTIONS_PER_IP = 30;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Single-session-per-IP: one IP can hold ONE live session at a time. A new
// connection from the same IP immediately closes the old session. This keeps
// one user from hoarding multiple slots (background tabs, bot retries) and
// means the 40-slot pool can serve 40 distinct users.
const ipSessions = new Map(); // ip → socketId (current session)

function checkRateLimit(ip) {
  const now = Date.now();
  if (!connectionTracker.has(ip)) {
    connectionTracker.set(ip, []);
  }
  const timestamps = connectionTracker.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  // Drop the key entirely when nothing is left in the window so the map can't
  // accumulate a permanent empty-array entry per unique visitor IP.
  if (timestamps.length === 0) {
    connectionTracker.delete(ip);
  } else {
    connectionTracker.set(ip, timestamps);
  }

  if (timestamps.length >= MAX_CONNECTIONS_PER_IP) {
    connectionTracker.set(ip, timestamps); // keep the full window for lockout
    return false;
  }
  timestamps.push(now);
  connectionTracker.set(ip, timestamps);
  return true;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-real-ip'] || socket.handshake.address;
  console.log(`Client connected: ${socket.id} from ${clientIP}`);

  // Extract optional init command and persistent session ID from client handshake.
  const initCommand = typeof socket.handshake.auth?.initCommand === 'string'
    ? socket.handshake.auth.initCommand
    : undefined;
  const sessionId = typeof socket.handshake.auth?.sessionId === 'string'
    ? socket.handshake.auth.sessionId
    : undefined;

  // Rate limit check
  if (!checkRateLimit(clientIP)) {
    console.log(`Rate limit exceeded for ${clientIP}`);
    socket.emit('error', 'Too many connections. Please wait a minute.');
    socket.disconnect();
    return;
  }

  // First priority: if the client brought a persistent session ID, restore
  // that exact session (active or zombie) instead of creating/killing a new one.
  let restoredByPersistentId = false;
  if (sessionId) {
    const restored = sessionManager.restoreByPersistentSessionId(sessionId, socket.id, socket, clientIP, initCommand);
    if (restored) {
      restoredByPersistentId = true;
      socket.emit('session_status', { mode: 'resume', restoredType: restored.type });
      if (restored.type === 'active' && restored.oldSocketId) {
        const existingSocket = io.sockets.sockets.get(restored.oldSocketId);
        if (existingSocket) {
          try {
            existingSocket.emit('output', '\r\n[session continued in a new tab]\r\n');
            existingSocket.disconnect();
          } catch { /* ignore */ }
        }
      }
      ipSessions.set(clientIP, socket.id);
      console.log(`Restored persistent session ${sessionId} for ${socket.id} (${restored.type})`);
    }
  }

  // Single-session-per-IP: if this IP already has a live session and we didn't
  // just restore by persistent ID, kick the old one so the new connection gets
  // the slot. Prevents idle tabs from hoarding.
  if (!restoredByPersistentId) {
    const existingSid = ipSessions.get(clientIP);
    if (existingSid && existingSid !== socket.id) {
      console.log(`IP ${clientIP} already has session ${existingSid} — kicking to make room for ${socket.id}`);
      const existingSocket = io.sockets.sockets.get(existingSid);
      if (existingSocket) {
        try {
          existingSocket.emit('output', '\r\n[replaced by a new session from this ip]\r\n');
          existingSocket.disconnect();
        } catch { /* ignore */ }
      }
      try { sessionManager.destroySession(existingSid); } catch { /* ignore */ }
      ipSessions.delete(clientIP);
    }
    ipSessions.set(clientIP, socket.id);
  }

  logger.append({
    type: 'session_start',
    id: socket.id,
    ip: clientIP,
    ua: socket.handshake.headers['user-agent'] || '',
    referrer: socket.handshake.headers['referer'] || socket.handshake.headers['referrer'] || '',
    initCommand: initCommand || '',
  });
  cmdBufs.set(socket.id, '');

  // Create new terminal session (if not already restored by persistent ID).
  if (!restoredByPersistentId) {
    socket.emit('session_status', { mode: 'cold' });
    sessionManager.createSession(socket.id, socket, initCommand, clientIP, sessionId)
      .then(() => {
        console.log(`Session created for ${socket.id}${initCommand ? ' (initCommand=' + initCommand + ')' : ''}`);
      })
      .catch((error) => {
        console.error(`Failed to create session for ${socket.id}:`, error);
        socket.emit('error', 'Failed to create terminal session');
        socket.disconnect();
      });
  }

  // Handle terminal input with validation
  socket.on('input', (data) => {
    if (typeof data !== 'string' || data.length > 1024) {
      return;
    }
    // Buffer printable chars; emit completed command on Enter
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
    sessionManager.sendInput(socket.id, data);
  });

  // Handle terminal resize with bounds checking
  socket.on('resize', ({ cols, rows }) => {
    const safeCols = Math.min(Math.max(Math.floor(cols) || 80, 10), 500);
    const safeRows = Math.min(Math.max(Math.floor(rows) || 24, 2), 200);
    sessionManager.resizeTerminal(socket.id, safeCols, safeRows);
  });

  // Handle client disconnect
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    logger.append({ type: 'session_end', id: socket.id, reason });
    cmdBufs.delete(socket.id);
    // Clear the per-IP lock only if this is still the active session for that
    // IP (don't clobber a newer session from the same IP that just came in).
    if (ipSessions.get(clientIP) === socket.id) {
      ipSessions.delete(clientIP);
    }
    sessionManager.zombifySession(socket.id);
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
    sessionManager.destroySession(socket.id);
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

// Admin panel
app.use('/admin', adminRouter);

// Keep the pre-warm pool topped up — self-heals if idle pool streams drain it.
sessionManager.startPoolMaintenance();

// Periodic orphan cleanup every 60 seconds
setInterval(() => {
  sessionManager.cleanupOrphanedContainers();
}, 60 * 1000);

// Drop stale per-IP rate-limit entries so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of connectionTracker) {
    if (!ts.length || now - ts[ts.length - 1] > RATE_LIMIT_WINDOW) {
      connectionTracker.delete(ip);
    }
  }
}, 5 * 60 * 1000);

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
