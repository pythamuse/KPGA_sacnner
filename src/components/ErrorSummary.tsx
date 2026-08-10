import React from 'react';
import { ValidationError } from '../lib/validation/types';

interface ErrorSummaryProps {
  errors: ValidationError[];
}

const ErrorSummary = React.forwardRef<HTMLDivElement, ErrorSummaryProps>(function ErrorSummary(
  { errors },
  ref,
) {
  if (errors.length === 0) return null;

  return (
    <div ref={ref} className="error-box animate-fade-in" role="alert" aria-live="assertive">
      <h3 style={{ fontSize: 16, marginBottom: 10, fontWeight: 800 }}>
        저장 전 확인이 필요한 항목 ({errors.length}건)
      </h3>
      <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 18 }}>
        {errors.map((err, index) => (
          <li key={index} style={{ lineHeight: 1.55 }}>
            {err.field && (
              <span
                style={{
                  display: 'inline-flex',
                  marginRight: 8,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: '#ffffff',
                  border: '1px solid #f0b7b2',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {err.field}
              </span>
            )}
            {err.message}
          </li>
        ))}
      </ul>
    </div>
  );
});

ErrorSummary.displayName = 'ErrorSummary';

export default ErrorSummary;
