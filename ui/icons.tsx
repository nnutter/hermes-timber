const MERGE_PATHS = [
  "M15 13.25a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm-12.5 6a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm0-14.5a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM5.75 6.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 6.5Zm0 14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 21Zm12.5-6a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 18.25 15Z",
  "M6.5 7.25c0 2.9 2.35 5.25 5.25 5.25h4.5V14h-4.5A6.75 6.75 0 0 1 5 7.25Z",
  "M5.75 16.75A.75.75 0 0 1 5 16V8a.75.75 0 0 1 1.5 0v8a.75.75 0 0 1-.75.75Z",
];

const PUSH_PATHS = [
  "M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z",
  "M11.78 4.72a.749.749 0 1 1-1.06 1.06L8.75 3.811V9.5a.75.75 0 0 1-1.5 0V3.811L5.28 5.78a.749.749 0 1 1-1.06-1.06l3.25-3.25a.749.749 0 0 1 1.06 0l3.25 3.25Z",
];

const CREATE_PR_PATHS = [
  "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
];

const NEW_WORKTREE_PATHS = [
  "M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.25 1.25 0 0 1 0-2.162ZM8.125 1.69a.25.25 0 0 0-.25 0L3.244 4.375 7.875 7.06a.25.25 0 0 0 .25 0l4.63-2.685ZM1.602 7.789a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296L1.874 8.813a.75.75 0 0 1-.272-1.024m0 3.5a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296l-5.248-3.044a.75.75 0 0 1-.272-1.024M11.75 15.25v-2h-2a.75.75 0 0 1 0-1.5h2v-2a.75.75 0 0 1 1.5 0v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0",
];

const IMPORT_REPO_PATHS = [
  "M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75V6a.75.75 0 0 1-1.5 0V1.5h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 3.5 9h3a.75.75 0 0 1 0 1.5h-3a1 1 0 0 0 0 2h3a.75.75 0 0 1 0 1.5h-3A2.5 2.5 0 0 1 1 11.5v-9Z",
  "M12.21 13.479a.75.75 0 1 0 1.061 1.061l2.504-2.505a.75.75 0 0 0 0-1.061L13.271 8.47a.75.75 0 0 0-1.061 1.06l1.224 1.225H8.75a.75.75 0 1 0 0 1.5h4.685l-1.225 1.224Z",
];

function Glyph({ paths, size }: { paths: readonly string[]; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

export function MergeIcon({ size = 16 }: { size?: number }) {
  return <Glyph paths={MERGE_PATHS} size={size} />;
}

export function PushIcon({ size = 16 }: { size?: number }) {
  return <Glyph paths={PUSH_PATHS} size={size} />;
}

export function CreatePrIcon({ size = 16 }: { size?: number }) {
  return <Glyph paths={CREATE_PR_PATHS} size={size} />;
}

export function NewWorktreeIcon({ size = 16 }: { size?: number }) {
  return <Glyph paths={NEW_WORKTREE_PATHS} size={size} />;
}

export function ImportRepoIcon({ size = 16 }: { size?: number }) {
  return <Glyph paths={IMPORT_REPO_PATHS} size={size} />;
}
