import path from 'path';

export interface MatchPair {
  cagiPath: string;
  satisfactionPath: string;
}

/**
 * 앞면 이미지 경로 목록과 뒷면 이미지 경로 목록을 자연수 순서로 정렬한 뒤 1대1 매칭합니다.
 * 두 이미지 목록의 개수가 일치하지 않으면 에러를 발생시킵니다.
 */
export function matchBatch(
  cagiPaths: string[],
  satisfactionPaths: string[]
): MatchPair[] {
  // 개수 불일치 체크
  if (cagiPaths.length !== satisfactionPaths.length) {
    throw new Error(
      `업로드된 파일의 장수가 일치하지 않습니다. (선별검사지: ${cagiPaths.length}장, 만족도조사: ${satisfactionPaths.length}장)`
    );
  }

  // 자연어(숫자 포함) 기준 정렬 헬퍼
  const naturalSort = (a: string, b: string) => {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  };

  const sortedCagi = [...cagiPaths].sort(naturalSort);
  const sortedSat = [...satisfactionPaths].sort(naturalSort);

  const pairs: MatchPair[] = [];
  for (let i = 0; i < sortedCagi.length; i++) {
    pairs.push({
      cagiPath: sortedCagi[i],
      satisfactionPath: sortedSat[i]
    });
  }

  return pairs;
}
