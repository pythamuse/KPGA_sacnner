import React from 'react';
import { StudentData } from '../lib/validation/types';

interface StudentTableProps {
  students: StudentData[];
}

export default function StudentTable({ students }: StudentTableProps) {
  return (
    <section className="panel panel-pad animate-fade-in">
      <h2 style={{ fontSize: 20, marginBottom: 14 }}>작성 완료된 학생 데이터 ({students.length}명)</h2>

      {students.length === 0 ? (
        <div className="muted-box">
          아직 등록된 학생 데이터가 없습니다.
          <br />
          선별검사지와 만족도조사를 업로드한 뒤 검수해주세요.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, border: '1px solid var(--border-medium)' }}>
            <thead>
              <tr style={{ background: 'var(--surface-label)' }}>
                <th style={headCell}>순번</th>
                <th style={headCell}>엑셀 행</th>
                <th style={headCell}>연령대</th>
                <th style={headCell}>성별</th>
                <th style={headCell}>학교유형</th>
                <th style={headCell}>학년</th>
                <th style={headCell}>상태</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student, index) => (
                <tr key={student.studentIndex || index}>
                  <td style={bodyCell}>{index + 1}</td>
                  <td style={{ ...bodyCell, color: 'var(--brand-primary)', fontWeight: 800 }}>{student.studentIndex}행</td>
                  <td style={bodyCell}>{student.basic.age}</td>
                  <td style={bodyCell}>{student.basic.gender}</td>
                  <td style={bodyCell}>{student.basic.schoolType}</td>
                  <td style={bodyCell}>{student.basic.grade}</td>
                  <td style={bodyCell}>
                    <span style={{ color: 'var(--success)', fontWeight: 800 }}>엑셀 반영 완료</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const headCell: React.CSSProperties = {
  border: '1px solid var(--border-medium)',
  padding: '13px 10px',
  textAlign: 'center',
  fontWeight: 800,
  whiteSpace: 'nowrap',
};

const bodyCell: React.CSSProperties = {
  border: '1px solid var(--border-medium)',
  padding: '14px 10px',
  textAlign: 'center',
  background: '#ffffff',
  whiteSpace: 'nowrap',
};
