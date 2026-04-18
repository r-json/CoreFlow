/**
 * UI Component: Alert
 * Professional Fintech Dark Mode Alerts
 */

import React from 'react';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive' | 'success' | 'warning';
}

const variantClasses = {
  default: 'bg-blue-500/10 border-blue-500/30 text-blue-200',
  destructive: 'bg-red-500/10 border-red-500/30 text-red-200',
  success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
  warning: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
};

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ variant = 'default', className, ...props }, ref) => (
    <div
      ref={ref}
      className={`
        rounded-lg border p-4
        ${variantClasses[variant]}
        ${className || ''}
      `}
      {...props}
    />
  )
);
Alert.displayName = 'Alert';
