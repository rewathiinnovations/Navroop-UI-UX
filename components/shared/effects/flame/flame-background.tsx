'use client';

import React from 'react';
import { cn } from '@/utils/cn';
import { CoreFlame } from './core-flame';

interface FlameBackgroundProps {
  /**
   * Accepted and ignored. It used to feed three locals — opacity
   * (intensity/100 * 0.3), speed (80 - intensity/100 * 40) and a
   * heat-100/heat-40/black-alpha-20 colour — none of which was ever passed to
   * <CoreFlame />, so the whole 0-100 scale was computed and discarded. The dead
   * computations are gone; the prop stays so no caller breaks.
   */
  intensity?: number; // 0-100, like CPU usage
  animate?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function FlameBackground({ animate = false, className, children }: FlameBackgroundProps) {
  return (
    <div className={cn('relative', className)}>
      <CoreFlame className={cn('transition-opacity duration-1000', animate && 'animate-pulse')} />
      {children && <div className="relative z-10">{children}</div>}
    </div>
  );
}
