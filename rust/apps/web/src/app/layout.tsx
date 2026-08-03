import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NOETIS COMPUTE',
  description: 'Decentralized AI compute network',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
