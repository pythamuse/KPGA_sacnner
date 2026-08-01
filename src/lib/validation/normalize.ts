export function normalizeGender(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (['남', '남자', '남학생'].includes(trimmed)) {
    return '남';
  }
  if (['여', '여자', '여학생'].includes(trimmed)) {
    return '여';
  }
  return trimmed; // 정규화 실패 시 원본값 반환하여 검증에서 에러 나도록 함
}

export function normalizeSchoolType(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim().replace(/\s+/g, ''); // 공백 완전 제거
  if (['초등', '초등학교'].includes(trimmed)) {
    return '초등학교';
  }
  if (['중등', '중학교'].includes(trimmed)) {
    return '중학교';
  }
  if (['고등', '고등학교'].includes(trimmed)) {
    return '고등학교';
  }
  if (['학교외기관', '학교외의기관'].includes(trimmed)) {
    return '학교외기관';
  }
  return trimmed;
}

export function normalizeGrade(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim().replace(/\s+/g, '');
  if (['1', '1학년'].includes(trimmed)) return '1학년';
  if (['2', '2학년'].includes(trimmed)) return '2학년';
  if (['3', '3학년'].includes(trimmed)) return '3학년';
  if (['4', '4학년'].includes(trimmed)) return '4학년';
  if (['5', '5학년'].includes(trimmed)) return '5학년';
  if (['6', '6학년'].includes(trimmed)) return '6학년';
  if (['해당없음', '해당없음'].includes(trimmed)) return '해당없음';
  return trimmed;
}

export function normalizeAge(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;

  const match = value.toString().match(/\d+/);
  if (match) {
    return parseInt(match[0], 10);
  }
  return undefined;
}

const ADULT_AGE_BANDS = [20, 30, 40, 50, 60, 70];

/**
 * 성인 CPGI/만족도 템플릿의 연령대는 청소년처럼 만 나이가 아니라
 * 20/30/40/50/60/70(대) 코드값 중 하나다. "35" 같은 실제 나이가 들어오면
 * 가장 가까운 낮은 연령대로 보정한다(예: 35 -> 30).
 */
export function normalizeAdultAgeBand(value: string | number | undefined | null): number | undefined {
  const raw = normalizeAge(value);
  if (raw === undefined) return undefined;
  if (ADULT_AGE_BANDS.includes(raw)) return raw;

  const band = Math.floor(raw / 10) * 10;
  return ADULT_AGE_BANDS.includes(band) ? band : undefined;
}
