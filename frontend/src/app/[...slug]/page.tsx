import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isValidPath, getPageMetadata, getOgImage } from '@/lib/routes';
import Home from '../page';

type Params = { slug?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const pathname = '/' + (slug ?? []).join('/');
  const m = getPageMetadata(pathname);
  const image = getOgImage(pathname);
  return {
    title: m.title,
    description: m.description,
    openGraph: { title: m.title, description: m.description, url: `https://tim.waldin.net${pathname}`, siteName: 'twaldin', type: 'website', images: [image] },
    twitter: { card: 'summary_large_image', title: m.title, description: m.description, images: [image.url] },
  };
}

export default async function CatchAll({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const pathname = '/' + (slug ?? []).join('/');
  if (!isValidPath(pathname)) notFound();
  return <Home />;
}
