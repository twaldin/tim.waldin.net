import type { Metadata } from 'next';
import XEmbed from './XEmbed';
import { alt as imageAlt, size as imageSize } from './twitter-image';

const PLAYER_URL = 'https://tim.waldin.net/x';
const PLAYER_SIZE = 480;
const title = 'twaldin — live terminal';
const description =
  "Timothy Waldin's terminal portfolio, live in the post. Tap for your own shell in a fresh Docker container, then try projects, about, or blog.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: PLAYER_URL,
    siteName: 'twaldin',
    type: 'website',
    images: [{ url: '/x/twitter-image', ...imageSize, alt: imageAlt }],
  },
  // Next's player descriptor requires a streamUrl, which an interactive
  // terminal does not have; the player tags go through `other` instead.
  // Setting the card here replaces the root layout's summary_large_image.
  twitter: { card: 'player', title, description, players: [] },
  other: {
    'twitter:player': PLAYER_URL,
    'twitter:player:width': PLAYER_SIZE,
    'twitter:player:height': PLAYER_SIZE,
  },
};

export default function XPage() {
  return <XEmbed />;
}
