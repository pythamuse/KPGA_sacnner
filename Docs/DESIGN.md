---
spec_version: 1
document: DESIGN.md
project_name: Korea Problem Gambling Agency Instructor Portal
project_slug: kogpa-instructor-portal
last_updated: 2026-07-10
source_reference:
  - assigned-lecture-overview-screenshot
  - satisfaction-upload-screenshot

design_tokens:
  color:
    brand:
      primary: "#6855A0"
      primary_hover: "#5F4B98"
      primary_active: "#55438A"
      primary_soft: "#E7E0F1"
      primary_soft_border: "#CFC3E3"
      secondary_teal: "#2FC0CC"
      secondary_teal_soft: "#D8F2F4"
      accent_orange: "#F58548"
      accent_orange_soft: "#FDE7D8"
    surface:
      canvas: "#FFFFFF"
      canvas_muted: "#F7F8FA"
      panel: "#FFFFFF"
      panel_tinted: "#FBFBFC"
      sidebar_shell: "#6855A0"
      table_label: "#F1F1F1"
      table_row_hover: "#F7F8FA"
      disabled: "#ECECEC"
      inverse: "#1F1F1F"
    text:
      primary: "#111111"
      secondary: "#333333"
      muted: "#666666"
      subtle: "#8A8A8A"
      inverse: "#FFFFFF"
      link: "#6855A0"
      danger: "#E34B3F"
    border:
      subtle: "#E5E5E5"
      medium: "#D9D9D9"
      strong: "#C8C8C8"
      focus: "#8C78C4"
    icon:
      default: "#1F1F1F"
      muted: "#707070"
      inverse: "#FFFFFF"
    fouc:
      html_bg: "#FFFFFF"
      body_bg: "#FFFFFF"
      app_shell_bg: "#FFFFFF"
      sidebar_bg: "#6855A0"
      topbar_bg: "#FFFFFF"
      initial_text: "#111111"
      initial_border: "#E5E5E5"

  typography:
    family:
      display:
        - "Pretendard"
        - "Noto Sans KR"
        - "Apple SD Gothic Neo"
        - "Malgun Gothic"
        - "sans-serif"
      body:
        - "Pretendard"
        - "Noto Sans KR"
        - "Apple SD Gothic Neo"
        - "Malgun Gothic"
        - "sans-serif"
      mono:
        - "JetBrains Mono"
        - "SFMono-Regular"
        - "Consolas"
        - "monospace"
    weight:
      regular: 400
      medium: 500
      semibold: 600
      bold: 700
      extrabold: 800
    tracking:
      display_em: -0.035
      heading_em: -0.02
      nav_em: -0.01
      body_em: -0.005
      label_em: 0.02
      button_em: -0.01
    line_height:
      display: 1.08
      heading: 1.15
      body: 1.55
      label: 1.35
      table: 1.4
    scale:
      hero_px: 56
      page_title_px: 28
      section_title_px: 20
      card_title_px: 18
      body_px: 16
      small_px: 14
      caption_px: 12

  layout:
    shell:
      max_content_width_px: 1120
      topbar_height_px: 88
      page_horizontal_padding_px: 40
      section_vertical_gap_px: 40
      content_top_offset_px: 48
    sidebar:
      width_px: 224
      inner_padding_px: 24
      outer_radius_px: 24
      inner_radius_px: 20
      gap_to_content_px: 56
    grid:
      desktop_columns: 12
      desktop_gutter_px: 24
      card_gap_px: 20
    table:
      row_min_height_px: 52
      header_row_min_height_px: 48
      label_cell_width_px: 176
      border_width_px: 1
    button:
      height_md_px: 42
      height_sm_px: 36
      radius_px: 8
      px_md: 16
      px_sm: 14
    input:
      height_px: 40
      radius_px: 8
      border_width_px: 1
      horizontal_padding_px: 14

  motion:
    transition_fast_ms: 120
    transition_base_ms: 180
    transition_slow_ms: 260
    easing_standard: "cubic-bezier(0.2, 0, 0, 1)"
    easing_emphasis: "cubic-bezier(0.22, 1, 0.36, 1)"

  effects:
    shadow:
      none: "none"
      soft: "0 1px 2px rgba(17,17,17,0.04)"
      floating: "0 6px 18px rgba(17,17,17,0.08)"
    ring:
      focus: "0 0 0 3px rgba(104,85,160,0.20)"
    stroke:
      thin_px: 1
      emphasis_px: 2
---

# Korea Problem Gambling Agency Instructor Portal Design System

## 2026-07-10 Frontend Application Notes

현재 웹앱 프론트엔드는 이 디자인 시스템의 "공공기관형 백색 업무 UI" 방향을 우선 반영한다. 구현상 핵심은 미적 장식보다 기존 한국도박문제예방치유원 홈페이지와의 시각적 일관성, 낮은 리소스 사용, 반복 업무 흐름의 명료성이다.

반영된 화면 구조:

1. 첨부된 기관 홈페이지 이미지는 색상, 버튼, 표, 여백, 타이포그래피의 참고 자료로만 사용한다.
2. 홈페이지의 상단 네비게이션, 햄버거 메뉴, 좌측 마이페이지 사이드바는 이 앱에 그대로 만들지 않는다.
3. 배정 교육 정보처럼 현재 기능에 필요하지 않은 섹션은 표시하지 않는다.
4. 첫 화면에는 앱 제목, 짧은 설명, 업로드 방식 선택만 배치한다.
5. 작업 시작 후에는 응답지 업로드, 인식 결과 검수, 저장 학생 목록, 엑셀 다운로드 섹션만 유지한다.
6. 업로드·검수·목록 영역은 흰색 패널, 얇은 회색 경계선, 회색 레이블 셀, 보라색 주요 버튼만 사용한다.

반영된 주요 파일:

| 파일 | 역할 |
|---|---|
| `src/app/globals.css` | 다크/글래스 스타일 제거, 백색 캔버스·보라색 브랜드 토큰·Ledger 표 스타일 정의 |
| `src/app/page.tsx` | 기능 중심 제목, 업로드 방식 선택, 업로드/검수/목록/다운로드 레이아웃 구성 |
| `src/components/ImageUploadPanel.tsx` | 개별/순차 촬영과 일괄 스캔 업로드 흐름 UI 정리 |
| `src/components/RecognitionReview.tsx` | 인식 결과 검수 화면을 행정 업무형 입력 UI로 정리 |
| `src/components/StudentTable.tsx` | 저장 완료 학생 목록을 회색 헤더 테이블로 정리 |
| `src/components/ErrorSummary.tsx` | 오류 요약을 조치 중심 경고 박스로 정리 |

주의: 현재 화면은 별도 기관 네비게이션이나 사이드바를 포함하지 않는다. 공식 홈페이지 구조를 복제하지 말고, 필요한 업무 기능만 남긴다.

## Brand Identity & Color Intent

이 UI는 공공기관 서비스답게 과장된 장식보다 신뢰감, 정돈감, 업무 효율을 우선한다. 시각적 중심축은 세 가지다. 첫째, 넓은 백색 여백을 기반으로 한 행정형 정보 구조. 둘째, 기관의 정체성을 한 번에 각인시키는 보랏빛 메인 컬러. 셋째, 로고에서만 제한적으로 드러나는 청록과 오렌지의 보조 인상이다.

브랜드 보라색 `#6855A0`는 감성적 럭셔리가 아니라 “공적이지만 차갑지 않은 안내자”의 역할을 한다. 이 색은 좌측 마이페이지 셸, 주요 버튼, 링크, 포커스 상태, 활성 메뉴에만 집중적으로 사용한다. 보라색이 화면 전역을 뒤덮어선 안 되며, 전체 화면의 10~15% 이내에서만 존재해야 한다. 대부분의 표면은 백색 또는 아주 옅은 회백색으로 남겨야 공공 서비스 특유의 명료함이 유지된다.

청록 `#2FC0CC`와 오렌지 `#F58548`는 로고에서 출발한 보조 컬러다. 이 둘은 브랜드 서사에는 중요하지만, UI 행동 컬러로는 과도하게 확장하지 않는다. 정보 상태를 설명할 때는 사용하지 말고, 브랜드 소개 블록, 일러스트, 안내 배너, 미세한 강조 포인트 정도로만 제한한다. 즉, 실제 인터랙션 컬러는 보라색 단일 축을 유지한다.

중립 계열은 반드시 평평하고 깨끗해야 한다. 배경은 `#FFFFFF`, 보조 배경은 `#F7F8FA`, 표 레이블 셀은 `#F1F1F1`, 경계선은 `#E5E5E5`를 기본으로 한다. 전체 무드는 “프린트된 행정 양식이 웹으로 정제된 느낌”이어야 하며, 종이 질감 효과, 대형 그림자, 강한 그라디언트, 유리 효과는 사용하지 않는다.

FOUC 방지를 위해 최초 페인트 시점에는 `html`, `body`, 앱 셸 모두 백색 배경으로 먼저 채우고, 좌측 사이드바가 등장하는 레이아웃에서는 해당 영역의 초기 배경을 바로 `#6855A0`로 칠한다. 이때 초기 텍스트는 `#111111`, 초기 경계선은 `#E5E5E5`를 먼저 렌더링해 깜빡임 없는 안정감을 보장한다.

## Visual Structure & Layout Ratios

페이지는 상단 글로벌 내비게이션과 좌측 고정형 마이페이지 사이드바, 우측 메인 콘텐츠의 3층 구조로 읽힌다. 상단 바는 높이 88px 내외의 백색 수평 스트립이며, 로고는 좌측 정렬, 메뉴는 중앙-좌측 군집, 햄버거는 우측 정렬을 따른다. 상단 바는 최소한의 1px 하단 경계선만 가진다.

본문에서는 좌측 사이드바가 약 224px 폭의 보라색 외곽 셸을 이루고, 그 안에 백색 내피 카드가 들어간 이중 구조를 취한다. 바깥 셸 반경은 24px, 안쪽 백색 패널 반경은 20px 전후를 유지한다. 이 구조는 반드시 유지한다. 단색 보라 카드 하나로 끝내면 안 되고, “보라 외피 + 백색 정보판”이라는 계층감이 있어야 현재 사이트의 정체성이 살아난다.

메인 콘텐츠는 사이드바와 56px 안팎의 간격을 두고 시작하며, 최대 폭은 1120px 정도의 넓은 작업 캔버스로 유지한다. 섹션 간 수직 간격은 40px를 표준으로 한다. 가장 큰 페이지 타이틀은 좌상단에서 시작하고, 그 아래 섹션 제목이 차례로 따라붙는다. 카드, 표, 액션 버튼은 모두 같은 정렬선에 묶여야 한다.

테이블과 정보 카드의 행정 문서적 성격이 매우 강하다. 레이블 셀과 값 셀을 분리하는 구조를 사용하고, 좌측 레이블 셀은 `#F1F1F1` 배경과 600 이상의 글자 굵기를 사용한다. 값 셀은 순백색을 사용한다. 행 높이는 52px 전후, 행 경계는 1px 실선 `#E5E5E5`를 유지한다. 시각적 정보 밀도는 높아도 읽기 피로는 낮아야 한다.

## Component Language

### Buttons

주요 버튼은 두 계열만 사용한다.

1. Filled Primary  
   보라색 배경 `#6855A0`, 흰색 텍스트, 8px 반경. 다운로드, 등록, 확정 액션에 사용한다. 호버 시 `#5F4B98`, 활성 시 `#55438A`.

2. Outline Secondary  
   백색 배경, 1px 보라색 테두리, 보라 텍스트. 서브 액션, 상세 보기, 등록 진입 등에 사용한다. 호버 시 배경을 `#E7E0F1`로 얕게 채운다.

검정에 가까운 액션 버튼은 맥락상 도구 성격이 강한 경우에 한정한다. 예시의 QR 버튼처럼 `#1F1F1F` 배경, 흰색 텍스트, 8px 반경을 사용하되 화면 전체에 남발하지 않는다. 이는 보라색보다 위계가 높은 CTA가 아니라, 도구 버튼 계열이다.

### Inputs

입력창은 높이 40px, 8px 반경, 1px `#D9D9D9` 경계선. 포커스 시 외곽선 대신 보라색 포커스 링을 사용한다. 내부 여백은 좌우 14px. placeholder는 `#8A8A8A`.

### Navigation

상단 내비게이션은 본문보다 약간 더 타이트한 자간과 높은 굵기를 쓴다. 메뉴 텍스트는 `#111111`, hover/active 시 보라색으로 바꾸기보다 작은 상태 변화와 아이콘 회전으로 피드백을 준다. 사이드바 메뉴는 정보 구조가 핵심이므로, 활성 항목만 보라색 텍스트와 약한 강조 배경을 받는다.

## Cinematic Typography

이 브랜드의 타이포그래피는 화려한 서체 실험보다 “압도적이지만 행정적으로 정돈된 크기감”에 있다. 페이지 타이틀은 굵고 넓으며, 주변의 백색 여백과 함께 화면을 장악한다. 따라서 히어로/페이지 타이틀은 28px 이상을 기본으로 하고, 캠페인형 랜딩이나 특집 페이지에서는 56px까지 확대 가능하다. 단, 행간은 1.08~1.15 사이를 고정해 무게 중심이 아래로 늘어지지 않게 한다.

한국어 헤드라인은 자간을 크게 벌리지 않는다. 이 사이트의 정체성은 널찍한 영문 자간이 아니라, 굵은 산세리프의 응축된 힘에 있다. 따라서 display는 `-0.035em`, section heading은 `-0.02em`, body는 `-0.005em` 내외로 조정한다. 대신 표의 라벨, 버튼, 마이크로카피는 `0.02em` 정도의 약한 양의 자간을 줘 질서를 높인다.

텍스트 텍스처는 인위적 필터 대신 미세한 렌더링 규칙으로 만든다. 헤드라인은 그림자 없이 또렷해야 하며, 웹폰트 로딩 전후 점프를 줄이기 위해 폰트 메트릭이 유사한 한국어 산세리프 스택을 사용한다. 긴 서브 카피나 설명 문장은 16px, line-height 1.55를 유지하고, 표 내부 텍스트는 14~16px 범위를 넘지 않는다. 이 브랜드에서 “거대한 활자”는 오직 페이지 제목과 주요 섹션 제목만의 특권이다.

강한 시각적 장악이 필요할 때에도 텍스트 위에 노이즈, 글로우, 입체 압출 같은 효과를 올리지 않는다. 텍스트의 질감은 폰트 굵기, 여백, 줄 길이, 대비로만 해결한다. 공공기관 UI의 권위는 장식이 아니라 명확성에서 나온다.

## Scroll-Linked Interactive Index

스크롤 연동 인덱스는 외부 라이브러리 없이 순수 SVG와 Tailwind CSS만으로 구현한다. 목적은 긴 문서나 보고서형 페이지에서 현재 읽는 섹션의 위치를 직관적으로 추적하게 만드는 것이다. 결과물은 “얇은 세로 레일 + 활성 점 + 마우스 트래킹 가이드 라인 + 현재 섹션 라벨”의 네 요소로 구성한다.

구현 원칙은 다음과 같다.

인덱스 컨테이너는 `position: sticky` 또는 고정형 우측 레일로 배치하되, 시각적 존재감은 낮게 유지한다. 레일 자체는 1px 선이며 색은 `#D9D9D9`. 현재 스크롤 구간을 나타내는 활성 세그먼트는 `#6855A0` 2px로 그린다. 각 섹션 노드는 원형 점으로 표시하며 비활성은 4px, 활성은 8px 정도로 확장한다. 활성 점의 채움색은 `#6855A0`, 비활성은 `#C8C8C8`.

SVG는 한 개의 고정 viewport 안에서만 작동해야 하며, 각 섹션의 DOM top offset을 측정하여 전체 문서 길이 대비 정규화된 progress 값으로 환산한다. 문서 스크롤 이벤트는 직접 DOM 조작하지 말고 `requestAnimationFrame` 큐에 태워 frame-safe 하게 동작시킨다. 한 프레임 내에서는 현재 스크롤 위치에 가장 가까운 섹션을 계산해 active section을 결정하고, 활성 세그먼트의 y1/y2 및 활성 점의 cy를 갱신한다.

마우스 트래킹 라인은 순수 SVG line 요소 하나로 만든다. 사용자가 인덱스 영역 위를 움직이면 포인터의 y 좌표를 SVG 좌표계로 변환하고, 해당 y와 가장 가까운 섹션 노드를 찾는다. 이때 인디케이터 라인은 레일의 중심축에서 사용자의 x 위치 방향으로 짧게 확장된다. 기본 길이는 16px, hover 시 32px까지 확장하며, 색은 `#6855A0`, 불투명도는 0.65에서 1.0 사이로 변화시킨다. 마우스가 떠나면 라인은 120ms 안에 16px 길이와 낮은 불투명도로 복귀한다.

인덱스 레이블은 현재 섹션명만 노출한다. 레일 근처에 작은 캡슐형 라벨을 띄우고 배경은 백색, 경계는 `#E5E5E5`, 텍스트는 `#333333`, 활성 시 텍스트만 `#6855A0`로 바꾼다. 레이블은 포인터 hover 상황에서도 현재 가장 가까운 섹션명을 유지하되, 사용자가 실제로 클릭 가능한 상호작용을 원하면 섹션별 점이 anchor 역할을 하도록 한다.

Tailwind 구현 시 커스텀 CSS는 최소화하고, 선 색, fill, stroke-width, opacity, transition-duration 정도만 utility 또는 CSS 변수로 제어한다. 핵심은 “브랜드 보라색 한 줄이 읽기 진행을 조용히 추적한다”는 느낌이다. 절대로 차트처럼 화려하게 만들지 않는다.

## Typography Ledger Grid

이 서비스의 표와 정보 영역은 전통적인 데이터 테이블이 아니라 “정량적 가치를 분할 증명하는 Ledger”처럼 다뤄야 한다. 즉, 각 행은 한 개의 문장형 정보 단위이며, 좌측은 항목명, 우측은 값, 필요시 2단/4단으로 확장 가능한 체계적 장부 레이아웃이다.

기본 Ledger 규칙은 다음과 같다.

행은 최소 52px 높이, 상하 패딩은 14px, 좌우 패딩은 18~20px을 사용한다. 좌측 키 셀은 고정 폭 176px, 배경 `#F1F1F1`, 폰트 600, 텍스트 `#111111`. 값 셀은 가변 폭, 백색 배경, 폰트 500 또는 400, 텍스트 `#111111`. 모든 셀은 1px `#E5E5E5` 경계선을 공유하며, 분할된 다열 레이아웃에서도 라인 두께와 간격은 동일해야 한다.

2열 Ledger에서는 `label | value | label | value` 구조를 기본으로 하고, 좁은 화면에서는 한 줄 2셀 구조로 자연스럽게 접는다. 4열 이상으로 늘어나는 경우에도 label 셀의 배경 톤은 동일해야 하며, 값 셀만 길이에 따라 늘어난다.

미세 배경 반전 호버는 오직 상호작용 가능한 행에만 적용한다. hover 시 전체 행의 백색 값 셀은 `#F7F8FA`로 옅게 변하고, 레이블 셀은 `#E7E0F1`로 아주 얕게 물든다. 텍스트는 검정으로 유지하며, 배경 변화만으로 상호작용을 암시한다. hover 전환은 120~180ms 사이의 짧은 표준 easing을 사용한다. 클릭 가능한 액션 칩이 포함된 행에서는 hover 시 칩의 외곽선만 살짝 진해질 수 있지만, 그림자 확대는 금지한다.

숫자와 날짜는 Ledger 안에서 시각적으로 정렬되어야 한다. 날짜, 인원, 전화번호 같은 준정형 데이터는 body보다 약간 단단한 500 weight를 쓰고, 가능한 한 동일한 baseline 위에 놓는다. 수치형 열이 여러 개라면 가운데 정렬보다 좌정렬 또는 탭형 정렬을 우선해 공공 문서 특유의 정리감을 유지한다.

## Accessibility & Interaction Notes

보라색 버튼과 링크는 백색 배경 위에서 충분한 대비를 유지해야 한다. 텍스트 버튼의 최소 크기는 14px, 클릭 타깃은 최소 36px 이상 확보한다. 포커스는 브라우저 기본 outline을 제거하지 말고, 보라색 포커스 링으로 대체한다. 상태 구분을 색상만으로 표현하지 말고, 버튼 텍스트와 구조 차이도 함께 제공한다.

아이콘은 대부분 20~24px 범위를 유지하고, 선형 또는 단순 채움 스타일로 통일한다. 라운드 코너는 대부분 8px를 기준으로 하되, 사이드바 셸처럼 구조적 덩어리에서만 20px 이상의 큰 반경을 허용한다.

## Non-Negotiables

이 디자인 시스템에서 절대로 변형하면 안 되는 요소는 다음과 같다.

1. 좌측 마이페이지 셸의 보라색 외피와 백색 내피 이중 구조
2. 대형 페이지 타이틀과 넓은 백색 여백의 조합
3. 정보 표에서 레이블 셀만 회색 배경을 가지는 Ledger 구조
4. 주 인터랙션 컬러를 보라색 단일 축으로 유지하는 원칙
5. 배경, 표면, 경계선, 타이포그래피의 낮은 장식성과 높은 명료성
6. 로고의 청록/오렌지는 브랜드 기호로만 절제해서 사용하는 원칙
7. 스크롤 인덱스는 순수 SVG + Tailwind CSS만으로 구현하고, 얇고 조용한 움직임만 허용하는 원칙

이 문서는 사이트 전반의 UI를 재현하거나 확장할 때 기준점으로 사용한다. 새 화면을 만들더라도 결과물은 반드시 “기관형 백색 캔버스 위에 보라색 정보 구조를 얹은, 정돈되고 신뢰 가능한 업무 UI”로 읽혀야 한다.
