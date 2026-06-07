const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

assert(
  source.includes("socket.emit('session_status', { mode: 'resume'") ||
    source.includes('socket.emit("session_status", { mode: "resume"'),
  'restored sessions should emit resume session_status',
);
assert(
  source.includes("socket.emit('session_status', { mode: 'cold' })") ||
    source.includes('socket.emit("session_status", { mode: "cold" })'),
  'new sessions should emit cold session_status',
);

console.log('session_status emission checks passed');
