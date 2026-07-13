import { notFound, permanentRedirect } from 'next/navigation';
import BlogUnifiedPage from '@/components/BlogUnifiedPage';
import { getPost, listPostSlugs, postExcerpt, resolveSlugAlias } from '@/lib/blog-posts';

export async function generateStaticParams() {
  return listPostSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: 'Post not found' };
  const title = post.meta.title || slug;
  const description = postExcerpt(post.body);
  // og:image / twitter:image come from the sibling opengraph-image.tsx file
  // convention — Next appends the per-post image URL to both automatically.
  return {
    title,
    description,
    openGraph: { title, description, url: `https://tim.waldin.net/blog/${slug}`, siteName: 'twaldin', type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function BlogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) {
    // Old links in the wild (tweets especially) sometimes carry a slug
    // variant; send them to the canonical post instead of a 404.
    const alias = resolveSlugAlias(slug);
    if (alias) permanentRedirect(`/blog/${alias}`);
    notFound();
  }

  return (
    <BlogUnifiedPage
      slug={slug}
      title={post.meta.title || slug}
      date={post.meta.date}
      body={post.body}
    />
  );
}
