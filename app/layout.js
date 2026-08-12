import './globals.css';

export const metadata = {
  title: 'Cold Email Sender — built by @a1wai',
  description:
    'Find leads, build templates, and run paced cold-outreach campaigns from your own inbox. 100% free and open-source stack.',
  authors: [{ name: '@a1wai' }],
  robots: {
    // A private outreach console has no business being indexed.
    index: false,
    follow: false,
  },
  openGraph: {
    title: 'Cold Email Sender — built by @a1wai',
    description: 'Lead scraping, template management, and rate-limited outreach on a fully free stack.',
    type: 'website',
  },
};

export const viewport = {
  themeColor: '#08090f',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-ink-950">{children}</body>
    </html>
  );
}
