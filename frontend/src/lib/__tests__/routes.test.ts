import { describe, it, expect } from 'vitest';
import { isValidPath, getPageMetadata } from '../routes';

describe('isValidPath', () => {
  it('/ → true', () => expect(isValidPath('/')).toBe(true));
  it('/about → true', () => expect(isValidPath('/about')).toBe(true));
  it('/t/about → true', () => expect(isValidPath('/t/about')).toBe(true));
  it('/blog → true', () => expect(isValidPath('/blog')).toBe(true));
  it('/blog/some-post → true', () => expect(isValidPath('/blog/some-post')).toBe(true));
  it('/projects → true', () => expect(isValidPath('/projects')).toBe(true));
  it('/projects/flt → true', () => expect(isValidPath('/projects/flt')).toBe(true));
  it('/flt → true (top-level project alias)', () => expect(isValidPath('/flt')).toBe(true));
  it('/notacommand → false', () => expect(isValidPath('/notacommand')).toBe(false));
  it('/skyblock-qol → false (removed project)', () => expect(isValidPath('/skyblock-qol')).toBe(false));
  it('/projects/skyblock-qol → false (removed project)', () => expect(isValidPath('/projects/skyblock-qol')).toBe(false));
  it('/about/anything → false', () => expect(isValidPath('/about/anything')).toBe(false));
  it('/t/notacommand → false', () => expect(isValidPath('/t/notacommand')).toBe(false));
  it('/blog/has spaces → false', () => expect(isValidPath('/blog/has spaces')).toBe(false));
  it('/foo/bar/baz → false', () => expect(isValidPath('/foo/bar/baz')).toBe(false));
});

describe('getPageMetadata', () => {
  it('/ returns homepage metadata', () => {
    const m = getPageMetadata('/');
    expect(m.title).toBe('twaldin — interactive terminal portfolio');
    expect(m.description).toContain('Timothy Waldin');
  });

  it('/about returns about metadata', () => {
    const m = getPageMetadata('/about');
    expect(m.title).toBe('about — twaldin');
    expect(m.description).toContain('About');
  });

  it('/t/about returns same as /about', () => {
    const m = getPageMetadata('/t/about');
    expect(m.title).toBe('about — twaldin');
  });

  it('/blog returns blog metadata', () => {
    const m = getPageMetadata('/blog');
    expect(m.title).toBe('blog — twaldin');
  });

  it('/blog/some-post returns post metadata', () => {
    const m = getPageMetadata('/blog/some-post');
    expect(m.title).toBe('some-post — twaldin blog');
    expect(m.description).toContain('some-post');
  });

  it('/projects returns projects metadata', () => {
    const m = getPageMetadata('/projects');
    expect(m.title).toBe('projects — twaldin');
  });

  it('/projects/flt returns project alias metadata', () => {
    const m = getPageMetadata('/projects/flt');
    expect(m.title).toBe('flt — twaldin');
  });

  it('/flt returns project metadata', () => {
    const m = getPageMetadata('/flt');
    expect(m.title).toBe('flt — twaldin');
  });
});
