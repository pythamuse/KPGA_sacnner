import { RecognitionDraft } from './detectCheckmarks';

/**
 * 성인 CPGI/만족도 양식은 아직 실제 촬영 샘플이 없어 좌표 기반 ROI 인식을
 * 보정할 수 없다. 크래시 대신 전 항목을 "확인 필요(low confidence)"로 비워
 * 검수 화면에서 전부 수동 입력하도록 한다. 청소년 트랙의 기존 저신뢰도
 * fallback과 동일한 패턴이다.
 */
export function createEmptyAdultDraft(): RecognitionDraft {
  const confidence: { [key: string]: 'low' } = {};
  const fields = [
    'basic.age', 'basic.gender',
    'cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07', 'cagi.q08', 'cagi.q09',
    'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05',
    'satisfaction.q06', 'satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10',
  ];
  fields.forEach((f) => { confidence[f] = 'low'; });

  return {
    basic: {},
    cagi: {},
    satisfaction: {},
    confidence,
    candidates: {},
  };
}
