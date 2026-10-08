export function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    fleet: (
      <>
        <rect x="4" y="3" width="16" height="13" rx="1" />
        <path d="M2 20h20M8 16v4m8-4v4" />
      </>
    ),
    logs: (
      <>
        <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7" />
      </>
    ),
    enrollment: (
      <>
        <path d="M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3M16 4a4 4 0 0 1 0 8m4 9v-3a4 4 0 0 0-3-4" />
        <circle cx="9" cy="7" r="4" />
      </>
    ),
    requests: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <circle cx="3" cy="6" r="1" />
        <circle cx="3" cy="12" r="1" />
        <circle cx="3" cy="18" r="1" />
      </>
    ),
    audit: (
      <>
        <path d="M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6" />
      </>
    ),
    admins: (
      <>
        <circle cx="12" cy="7" r="4" />
        <path d="M4 22v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3" />
      </>
    ),
    close: <path d="M5 5l14 14M19 5L5 19" />,
    search: (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="M15 15l6 6" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.logs}
    </svg>
  );
}
