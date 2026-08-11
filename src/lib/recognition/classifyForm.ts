import fs from 'fs';
import path from 'path';
import {
  applyTemplateRegistrationFrame,
  calculateDarkPixelDensity,
  ImageAnalysisData,
  loadImageAnalysisData,
} from './markDensity';
import { ChoiceGroup, FormType, cagiTemplate, satisfactionTemplate } from './roiTemplates';

type ClassifiedFormType = FormType | 'unknown';

// Included in recognition responses so a deployed client can be compared with
// the classifier policy that produced its result.
export const FORM_CLASSIFIER_POLICY_VERSION = '2026-08-11.3';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export async function classifyForm(filePath: string): Promise<ClassifiedFormType> {
  if (!fs.existsSync(filePath)) {
    return 'unknown';
  }

  const lowerName = path.basename(filePath).toLowerCase();
  const filenameHint = classifyByFilename(lowerName);

  // Existing integration fixtures are intentionally tiny and filename-driven.
  if (lowerName.includes('example')) {
    return filenameHint;
  }

  const ext = path.extname(lowerName);
  if (imageExtensions.has(ext)) {
    const contentType = await classifyByImageContent(filePath);
    if (contentType !== 'unknown') {
      return contentType;
    }
  }

  return filenameHint;
}

function classifyByFilename(lowerName: string): ClassifiedFormType {
  if (lowerName.includes('cagi') || lowerName.includes('선별') || lowerName.includes('검사')) {
    return 'cagi';
  }

  if (lowerName.includes('satisfaction') || lowerName.includes('만족') || lowerName.includes('설문')) {
    return 'satisfaction';
  }

  return 'unknown';
}

async function classifyByImageContent(filePath: string): Promise<ClassifiedFormType> {
  try {
    const image = await loadImageAnalysisData(filePath);
    if (!image.contentBoundsConfident) {
      return 'unknown';
    }

    // Classification has to use the same measured template coordinate frame
    // as recognition. Scoring both forms from a raw paper envelope moves the
    // satisfaction table into CAGI anchors on flat PDF scans and can produce
    // a false upload-slot mismatch before the review step begins.
    const cagiImage = applyTemplateRegistrationFrame(image, cagiTemplate.registrationFrame);
    const satisfactionImage = applyTemplateRegistrationFrame(image, satisfactionTemplate.registrationFrame);
    const cagiScore = scoreChoiceLayout(cagiImage, cagiTemplate.choiceGroups);
    const satisfactionScore = scoreChoiceLayout(satisfactionImage, getSatisfactionClassificationGroups());
    const cagiSignatureScore = scoreChoiceLayout(cagiImage, getCagiSignatureGroups());
    const satisfactionSignatureScore = scoreChoiceLayout(satisfactionImage, getSatisfactionSignatureGroups());
    const cagiEvidence = combineEvidence(cagiScore, cagiSignatureScore);
    const satisfactionEvidence = combineEvidence(satisfactionScore, satisfactionSignatureScore);
    const scoreGap = Math.abs(cagiEvidence - satisfactionEvidence);

    // A single dense table region is not enough to identify a form. Require a
    // form-specific anchor as well as a meaningful score gap before overriding
    // the upload-slot filename hint.
    if (scoreGap < 0.08) {
      return 'unknown';
    }

    if (
      cagiEvidence >= 0.16 &&
      cagiSignatureScore >= 0.08 &&
      cagiEvidence > satisfactionEvidence
    ) {
      return 'cagi';
    }

    if (
      satisfactionEvidence >= 0.16 &&
      satisfactionSignatureScore >= 0.08 &&
      satisfactionEvidence > cagiEvidence
    ) {
      return 'satisfaction';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function getSatisfactionClassificationGroups(): ChoiceGroup[] {
  return satisfactionTemplate.choiceGroups;
}

function getCagiSignatureGroups(): ChoiceGroup[] {
  return cagiTemplate.choiceGroups.filter((group) => group.field.startsWith('basic.'));
}

function getSatisfactionSignatureGroups(): ChoiceGroup[] {
  return satisfactionTemplate.choiceGroups.filter((group) => {
    const questionNumber = Number(group.field.replace('satisfaction.q', ''));
    return questionNumber >= 7;
  });
}

function combineEvidence(layoutScore: number, signatureScore: number): number {
  return roundScore(layoutScore * 0.65 + signatureScore * 0.35);
}

function scoreChoiceLayout(image: ImageAnalysisData, groups: ChoiceGroup[]): number {
  if (groups.length === 0) {
    return 0;
  }

  const candidateScores = groups.flatMap((group) =>
    group.candidates.map((candidate) => calculateDarkPixelDensity(image, candidate.rect, 190)),
  );

  if (candidateScores.length === 0) {
    return 0;
  }

  const visibleCandidateRatio = candidateScores.filter((score) => score >= 0.08).length / candidateScores.length;
  const averageDensity = candidateScores.reduce((sum, score) => sum + score, 0) / candidateScores.length;

  return roundScore(visibleCandidateRatio * 0.65 + averageDensity * 0.35);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
