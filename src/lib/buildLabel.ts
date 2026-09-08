export function formatBuildLabel(sha: string | undefined, isoDate: string | undefined): string {
  if (!sha) {
    return 'local-dev';
  }

  return `v${isoDate}.${sha.slice(0, 7)}`;
}

export const BUILD_LABEL = formatBuildLabel(
  process.env.NEXT_PUBLIC_BUILD_SHA,
  process.env.NEXT_PUBLIC_BUILD_DATE,
);
