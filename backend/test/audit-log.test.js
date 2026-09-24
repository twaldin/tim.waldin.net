'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { _sanitizeEvent: sanitizeEvent } = require('../logger');

const sanitizeCommand = (cmd) => sanitizeEvent({ type: 'command', cmd }).cmd;

test('visitor-controlled audit fields are truncated to their bounds', () => {
  const event = sanitizeEvent({
    type: 'session_start',
    ip: 'i'.repeat(100),
    initCommand: 'c'.repeat(300),
    ua: 'u'.repeat(700),
    referrer: 'r'.repeat(1500),
  });

  assert.equal(event.ip.length, 64);
  assert.equal(event.initCommand.length, 200);
  assert.equal(event.ua.length, 512);
  assert.equal(event.referrer.length, 1024);
  assert.equal(sanitizeCommand('x'.repeat(2000)).length, 1024);
});

test('obvious credentials are redacted from logged commands', () => {
  const secrets = [
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'b'.repeat(30)}`,
    `sk-proj-${'c'.repeat(32)}`,
    `AKIA${'D'.repeat(16)}`,
    `xoxb-${'1'.repeat(12)}-${'e'.repeat(20)}`,
  ];
  const command = [
    ...secrets,
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature' /api",
    'password="hunter2" token=plain-token secret=top-secret api_key=key-value',
  ].join(' ');

  const sanitized = sanitizeCommand(command);

  for (const secret of secrets) assert.ok(!sanitized.includes(secret), secret);
  for (const secret of ['eyJhbGciOiJIUzI1NiJ9', 'hunter2', 'plain-token', 'top-secret', 'key-value']) {
    assert.ok(!sanitized.includes(secret), secret);
  }
  assert.match(sanitized, /Authorization: Bearer \[REDACTED\]/);
  assert.match(sanitized, /password=\[REDACTED\]/);
  assert.match(sanitized, /token=\[REDACTED\]/);
  assert.match(sanitized, /secret=\[REDACTED\]/);
  assert.match(sanitized, /api_key=\[REDACTED\]/);
});

test('secrets in prefixed shell variable assignments are redacted', () => {
  const sanitized = sanitizeCommand(
    'export GITHUB_TOKEN=abcd1234plainvalue; DB_PASSWORD=hunter2 ./run; export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG',
  );

  for (const secret of ['abcd1234plainvalue', 'hunter2', 'wJalrXUtnFEMIK7MDENG']) {
    assert.ok(!sanitized.includes(secret), secret);
  }
  assert.match(sanitized, /GITHUB_TOKEN=\[REDACTED\]/);
  assert.match(sanitized, /DB_PASSWORD=\[REDACTED\]/);
  assert.match(sanitized, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
});

test('secrets in session_start referrer and initCommand are redacted', () => {
  const event = sanitizeEvent({
    type: 'session_start',
    referrer: `https://example.com/cb?access_token=abcd1234plainvalue&next=/blog`,
    initCommand: `echo ghp_${'a'.repeat(36)}`,
  });

  assert.equal(event.referrer, 'https://example.com/cb?access_token=[REDACTED]&next=/blog');
  assert.equal(event.initCommand, 'echo [REDACTED]');
});

test('ordinary commands remain readable', () => {
  assert.equal(sanitizeCommand('git status --short'), 'git status --short');
});
