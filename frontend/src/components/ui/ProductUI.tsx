import Link, { type LinkProps } from 'next/link';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from 'react';
import styles from './ProductUI.module.css';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export type ProductPageMode = 'flow' | 'workspace';

export function ProductPage({
  children,
  className,
  mode = 'flow',
  ...props
}: HTMLAttributes<HTMLDivElement> & { mode?: ProductPageMode }) {
  return (
    <div
      {...props}
      className={classes(styles.page, mode === 'workspace' && styles.pageWorkspace, className)}
      data-product-page-mode={mode}
    >
      {children}
    </div>
  );
}

export function ProductPageHeader({
  title,
  description,
  meta,
  actions,
  className,
  headingId,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  headingId?: string;
}) {
  return (
    <header className={classes(styles.pageHeader, className)}>
      <div className={styles.pageHeading}>
        <div className={styles.titleLine}>
          <h1 id={headingId}>{title}</h1>
          {meta ? <span className={styles.headerMeta}>{meta}</span> : null}
        </div>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

type ActionVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ActionSize = 'sm' | 'md' | 'lg';

function actionClass(variant: ActionVariant, size: ActionSize, className?: string) {
  return classes(
    styles.action,
    styles[`action${variant[0].toUpperCase()}${variant.slice(1)}`],
    styles[`action${size.toUpperCase()}`],
    className,
  );
}

export function ProductButton({
  variant = 'secondary',
  size = 'lg',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ActionVariant;
  size?: ActionSize;
}) {
  return (
    <button {...props} className={actionClass(variant, size, className)}>
      {children}
    </button>
  );
}

export function ProductLinkButton({
  variant = 'secondary',
  size = 'lg',
  className,
  children,
  ...props
}: LinkProps & {
  variant?: ActionVariant;
  size?: ActionSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link {...props} className={actionClass(variant, size, className)}>
      {children}
    </Link>
  );
}

export function ProductIconButton({
  label,
  variant = 'quiet',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: ActionVariant;
}) {
  return (
    <button
      {...props}
      className={classes(styles.iconButton, styles[`action${variant[0].toUpperCase()}${variant.slice(1)}`], className)}
      aria-label={label}
      title={props.title ?? label}
    >
      {children}
    </button>
  );
}

export function ProductState({
  title,
  description,
  icon,
  action,
  tone = 'neutral',
  compact = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'error' | 'warning';
  compact?: boolean;
}) {
  return (
    <div
      {...props}
      className={classes(
        styles.state,
        compact && styles.stateCompact,
        tone === 'error' && styles.stateError,
        tone === 'warning' && styles.stateWarning,
        className,
      )}
    >
      {icon ? <span className={styles.stateIcon} aria-hidden="true">{icon}</span> : null}
      <div className={styles.stateCopy}>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </div>
  );
}

export function ProductField({
  label,
  help,
  error,
  children,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes(styles.field, className)}>
      <div className={styles.fieldLabel}>{label}</div>
      {children}
      {error ? <p className={styles.fieldError}>{error}</p> : help ? <p className={styles.fieldHelp}>{help}</p> : null}
    </div>
  );
}
