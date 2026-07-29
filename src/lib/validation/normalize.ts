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
