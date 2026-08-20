import React from 'react';

export type SpinnerSize = 'sm' | 'md' | 'lg';

/**
 * Tailwind here runs on a px scale, so `h-4` is 4 px and `h-20` is 20 px. The
 * old map read `sm: h-4, md: h-20, lg: h-8`, which made `lg` smaller than `md`
 * and `sm` invisible. `md` keeps its 20 px so the one existing caller (the hero
 * scraping loader, which takes the default) is unchanged.
 */
export const SPINNER_SIZES: Record<SpinnerSize, string> = {
  sm: 'h-16 w-16',
  md: 'h-20 w-20',
  lg: 'h-24 w-24',
};

interface SpinnerProps {
  className?: string;
  size?: SpinnerSize;
  finished?: boolean;
}

export default function Spinner({ className = '', size = 'md', finished = false }: SpinnerProps) {
  if (finished) {
    // Return a checkmark or completed state
    return <div className={`${className}`}>✓</div>;
  }

  return (
    <div className={`${SPINNER_SIZES[size]} ${className}`}>
      <svg
        className="animate-spin"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
    </div>
  );
}
