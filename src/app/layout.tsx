import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import { Toaster } from '@/components/ui/toaster';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '跨境合规审核 | AI违规检测系统',
    template: '%s | 跨境合规审核',
  },
  description:
    '跨境电商独立站链接违规审核AI系统，支持批量导入链接、自动抓取网页内容、智能审核合规性，结果一键推送飞书多维表格。',
  keywords: [
    '跨境电商',
    '合规审核',
    '违规检测',
    'AI审核',
    '独立站审核',
    '飞书多维表格',
  ],
  authors: [{ name: 'Audit AI' }],
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.COZE_PROJECT_ENV === 'DEV';

  return (
    <html lang="en">
      <body className={`antialiased`}>
        {isDev && <Inspector />}
        {children}
        <Toaster />
      </body>
    </html>
  );
}
