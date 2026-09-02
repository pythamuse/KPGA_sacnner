/**
 * Thresholds shared by the recognizer and the review-only evidence helpers.
 *
 * Keeping these values in a dependency-free module lets the client render the
 * same labels without importing the sharp-backed scorer. The values are the
 * existing mark-density constants; moving them does not change a gate.
 */
export const HIGH_RELATIVE_CONTRAST = 1.25;
export const HIGH_ABSOLUTE_SIGNAL = 0.021;
export const PHOTO_BINARY_FLOOR = 0.042;
export const STRUCTURED_MARK_MIN_COMPONENT = 7;
export const STRUCTURED_MARK_MIN_COMPONENT_RATIO = 0.2;
export const STRUCTURED_MARK_MIN_DIAGONAL_RATIO = 0.2;
export const BASELINE_ALIGNMENT_RADIUS = 1;
