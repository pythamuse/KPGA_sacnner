import path from 'path';

export interface MatchPair {
  cagiPath: string;
  satisfactionPath: string;
}

/**
 * 뒷면 묶음이 앞면과 같은 순서인지, 뒤집힌 순서인지.
 *
 * 연속 급지 스캐너로 앞면을 1~19로 스캔한 뒤 그 뭉치를 그대로 뒤집어 뒷면을
 * 스캔하면 19~1 순서로 나온다. 지금까지는 사용자가 손으로 되돌려 올렸고, 그
 * 수동 단계에서 두 장이 함께 넘어가면 아무 검사에도 걸리지 않는 뒤바뀜이
 * 생긴다. 순서를 여기서 다루면 그 단계 자체가 사라진다.
 */
export type StackOrder = 'same' | 'reversed';

export function isStackOrder(value: unknown): value is StackOrder {
  return value === 'same' || value === 'reversed';
}

/**
 * 앞면 이미지 경로 목록과 뒷면 이미지 목록을 자연수 순서로 정렬한 뒤 1대1 매칭합니다.
 * 두 이미지 목록의 개수가 일치하지 않으면 에러를 발생시킵니다.
 *
 * `satisfactionOrder`가 `'reversed'`면 정렬된 뒷면 목록을 뒤집어 짝짓습니다.
 * 기본값은 기존 동작이므로 인자를 주지 않는 호출부는 달라지지 않습니다.
 *
 * 뒤집기는 저장된 페이지 번호가 아니라 **짝을 지을 때만** 적용합니다. 업로드
 * 산출물은 원본 PDF와 1대1로 유지되어야 원본 이미지 표시와 무결성 검사가
 * 소스 기준으로 참이고, 설정을 잘못 골랐을 때 재업로드 없이 다시 인식하는
 * 것으로 되돌릴 수 있습니다.
 */
export function matchBatch(
  cagiPaths: string[],
  satisfactionPaths: string[],
  satisfactionOrder: StackOrder = 'same',
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
  if (satisfactionOrder === 'reversed') {
    sortedSat.reverse();
  }

  const pairs: MatchPair[] = [];
  for (let i = 0; i < sortedCagi.length; i++) {
    pairs.push({
      cagiPath: sortedCagi[i],
      satisfactionPath: sortedSat[i]
    });
  }

  return pairs;
}

/**
 * 몇 번째 학생이 어느 장과 어느 장으로 이루어지는지. 인식을 시작하기 전에
 * 사용자에게 보여주기 위한 것으로, 순서를 잘못 지정했을 때 그것이 눈에
 * 보이게 하는 유일한 장치입니다 -- 두 양식은 식별 필드를 공유하지 않으므로
 * 검수 화면에서는 뒤바뀜이 드러나지 않습니다.
 */
export function describePairing(
  pageCount: number,
  satisfactionOrder: StackOrder = 'same',
): Array<{ student: number; cagiPage: number; satisfactionPage: number }> {
  const rows = [];
  for (let i = 0; i < pageCount; i += 1) {
    rows.push({
      student: i + 1,
      cagiPage: i + 1,
      satisfactionPage: satisfactionOrder === 'reversed' ? pageCount - i : i + 1,
    });
  }
  return rows;
}
