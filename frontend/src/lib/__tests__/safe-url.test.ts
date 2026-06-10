import { describe, it, expect } from 'vitest';
import { isSafeExternalUrl } from '../safe-url';

describe('isSafeExternalUrl', () => {
  it('https://example.com → true', () => expect(isSafeExternalUrl('https://example.com')).toBe(true));
  it('http://example.com/path?q=1 → true', () => expect(isSafeExternalUrl('http://example.com/path?q=1')).toBe(true));
  it('mailto:a@b.com → true', () => expect(isSafeExternalUrl('mailto:a@b.com')).toBe(true));
  it('javascript:alert(1) → false', () => expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false));
  it('JavaScript:alert(1) (case-variant) → false', () => expect(isSafeExternalUrl('JavaScript:alert(1)')).toBe(false));
  it('data:text/html,<script> → false', () => expect(isSafeExternalUrl('data:text/html,<script>')).toBe(false));
  it('vbscript:msgbox → false', () => expect(isSafeExternalUrl('vbscript:msgbox')).toBe(false));
  it('//evil.com (protocol-relative) → false', () => expect(isSafeExternalUrl('//evil.com')).toBe(false));
  it('not a url → false', () => expect(isSafeExternalUrl('not a url')).toBe(false));
  it('empty string → false', () => expect(isSafeExternalUrl('')).toBe(false));
});
