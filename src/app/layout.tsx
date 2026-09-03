import './globals.css';
import type { Metadata } from 'next';
import { PDFJS_MAIN_SRC } from '../lib/pdf/pdfRenderConfig';

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
import * as pdfjsLib from '${PDFJS_MAIN_SRC}';
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
