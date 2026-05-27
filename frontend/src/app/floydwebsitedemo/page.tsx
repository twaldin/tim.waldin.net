import type { Metadata } from 'next';
import './floyd.css';
import FloydDemo from './FloydDemo';

const TITLE = 'FloydAddons - Fabric client and agent harness';
const DESC =
  'A standalone FloydAddons landing page for the Fabric 1.21.11 client mod, Odin ClickGUI modules, and the Floyd natural-language Minecraft agent harness.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  robots: { index: false, follow: false },
  openGraph: {
    title: TITLE,
    description: DESC,
    url: 'https://tim.waldin.net/floydwebsitedemo',
    siteName: 'twaldin',
    type: 'website',
  },
  twitter: { card: 'summary', title: TITLE, description: DESC },
};

export default function Page() {
  return <FloydDemo />;
}
