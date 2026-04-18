/**
 * UI Component: Card
 * Professional Fintech Dark Mode Cards
 */

import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={`
      rounded-lg border border-emerald-500/20 
      bg-gradient-to-br from-slate-800/40 via-slate-800/30 to-emerald-900/20
      backdrop-blur-lg
      shadow-xl shadow-emerald-900/10
      hover:border-emerald-500/40 hover:shadow-emerald-900/20
      transition-all duration-300
      ${className || ''}
    `}
    {...props}
  />
));
Card.displayName = 'Card';

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={`px-6 pt-6 pb-4 border-b border-emerald-500/20 ${className || ''}`} {...props} />
  )
);
CardHeader.displayName = 'CardHeader';

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

export const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={`text-lg font-bold tracking-tight text-slate-100 ${className || ''}`} {...props} />
  )
);
CardTitle.displayName = 'CardTitle';

export interface CardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}

export const CardDescription = React.forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={`text-sm text-slate-400 mt-1 ${className || ''}`} {...props} />
  )
);
CardDescription.displayName = 'CardDescription';

export interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardContent = React.forwardRef<HTMLDivElement, CardContentProps>(
  ({ className, ...props }, ref) => <div ref={ref} className={`px-6 py-4 ${className || ''}`} {...props} />
);
CardContent.displayName = 'CardContent';

export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardFooter = React.forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={`px-6 py-4 flex gap-2 border-t border-emerald-500/20 ${className || ''}`} {...props} />
  )
);
CardFooter.displayName = 'CardFooter';
