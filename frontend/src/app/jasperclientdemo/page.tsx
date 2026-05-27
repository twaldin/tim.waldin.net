import type { Metadata } from 'next';
import './jasper.css';
import JasperDemo from './JasperDemo';

const TITLE = 'Jasper Client — UI demo';
const DESC =
  'An interactive UI recreation of the Jasper Client SkyBlock landing page and its live in-game config GUI. Independent design study hosted on tim.waldin.net.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  // Brand recreation / demo — keep it out of search so it never poses as the real site.
  robots: { index: false, follow: false },
  openGraph: {
    title: TITLE,
    description: DESC,
    url: 'https://tim.waldin.net/jasperclientdemo',
    siteName: 'twaldin',
    type: 'website',
  },
  twitter: { card: 'summary', title: TITLE, description: DESC },
};

export default function Page() {
  return <JasperDemo />;
}
