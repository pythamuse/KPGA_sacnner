import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '도박예방교육 선별검사지·만족도조사 자동작성기',
  description: '종이 설문지 사진을 엑셀 행 데이터로 자동 변환하는 지능형 관리 도구',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        <script
          type="module"
          dangerouslySetInnerHTML={{
            __html: `
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.min.mjs';
window.pdfjsLib = pdfjsLib;
            `,
          }}
        />
      </head>
      <body>
        <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
