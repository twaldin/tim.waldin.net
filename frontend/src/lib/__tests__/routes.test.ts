import { describe, it, expect } from 'vitest';
import { isValidPath, getPageMetadata, getOgImage } from '../routes';

describe('isValidPath', () => {
  it('/ → true', () => expect(isValidPath('/')).toBe(true));
  it('/about → true', () => expect(isValidPath('/about')).toBe(true));
  it('/boot → true (reload during intro animation)', () => expect(isValidPath('/boot')).toBe(true));
  it('/theme → true', () => expect(isValidPath('/theme')).toBe(true));
  it('/home → true', () => expect(isValidPath('/home')).toBe(true));
  it('/t/about → true', () => expect(isValidPath('/t/about')).toBe(true));
  it('/blog → true', () => expect(isValidPath('/blog')).toBe(true));
  it('/blog/some-post → true', () => expect(isValidPath('/blog/some-post')).toBe(true));
  it('/projects → true', () => expect(isValidPath('/projects')).toBe(true));
  it.each([
    'easl', 'hone', 'trade-up-bot', 'tim.waldin.net', 'harness', 'flt',
    'studyspot', 'stm32-games', 'tetrio-tui', 'gepa-ts', 'dotfiles', 'also',
  ].flatMap(alias => [`/${alias}`, `/t/${alias}`, `/projects/${alias}`]))('%s accepts the project command', path => {
    expect(isValidPath(path)).toBe(true);
  });
  it.each([
    'term-site', 'agentelo', 'deck', 'hone-a-drone',
  ].flatMap(alias => [`/${alias}`, `/t/${alias}`, `/projects/${alias}`]))('%s rejects the removed alias', path => {
    expect(isValidPath(path)).toBe(false);
  });
  it('/notacommand → false', () => expect(isValidPath('/notacommand')).toBe(false));
  it('/skyblock-qol → false (removed project)', () => expect(isValidPath('/skyblock-qol')).toBe(false));
  it('/projects/skyblock-qol → false (removed project)', () => expect(isValidPath('/projects/skyblock-qol')).toBe(false));
  it('/about/anything → false', () => expect(isValidPath('/about/anything')).toBe(false));
  it('/t/notacommand → false', () => expect(isValidPath('/t/notacommand')).toBe(false));
  it('/blog/has spaces → false', () => expect(isValidPath('/blog/has spaces')).toBe(false));
  it('/foo/bar/baz → false', () => expect(isValidPath('/foo/bar/baz')).toBe(false));
});

describe('metadata route equivalence', () => {
  it.each(['easl', 'tim.waldin.net', 'flt'])('%s retains its identity through every project URL', alias => {
    const metadata = getPageMetadata(`/${alias}`);
    expect(metadata.title).toContain(alias);
    expect(metadata.description).toContain(alias);
    expect(getPageMetadata(`/t/${alias}`)).toEqual(metadata);
    expect(getPageMetadata(`/projects/${alias}`)).toEqual(metadata);
  });

  it.each(['about', 'blog', 'blog/some-post', 'projects'])('%s retains its metadata through terminal handoff', path => {
    expect(getPageMetadata(`/t/${path}`)).toEqual(getPageMetadata(`/${path}`));
  });
});

describe('project share cards', () => {
  it.each(['easl', 'tim.waldin.net'])('%s uses its project card on every supported path', alias => {
    for (const path of [`/${alias}`, `/t/${alias}`, `/projects/${alias}`]) {
      expect(getOgImage(path)).toEqual({
        url: `/repo-card/${alias}`, width: 1280, height: 640,
      });
    }
  });

  it.each(['/about', '/projects/also', '/projects/term-site'])('%s uses the root card', path => {
    expect(getOgImage(path)).toEqual({
      url: '/opengraph-image', width: 1200, height: 630,
    });
  });
});
